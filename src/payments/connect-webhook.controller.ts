import { BadRequestException, Controller, Headers, HttpCode, Logger, Post, RawBodyRequest, Req } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import type Stripe from 'stripe'
import { PaymentsService } from './payments.service'
import { ShopService } from '../shop/shop.service'
import { OrderingService } from '../ordering/ordering.service'

interface SquareEvent {
  type: string
  merchant_id?: string
  data?: { object?: { payment?: { id?: string; status?: string; order_id?: string } } }
}

/**
 * Provider webhooks for storefront payments.
 *
 * Stripe: endpoint for the Connect PLATFORM account (the one holding
 * STRIPE_CONNECT_SECRET_KEY). Storefront checkouts are platform-owned
 * sessions with a destination charge, so `checkout.session.completed` lands
 * here, not on the connected account. Confirming on the webhook as well as on
 * the success redirect means a customer who closes the tab after paying still
 * gets their order emailed and printed.
 *
 * Stripe dashboard → Developers → Webhooks → add endpoint
 *   POST {API}/v1/webhooks/stripe-connect
 *   events: checkout.session.completed, account.updated
 *   (tick "Listen to events on Connected accounts" so account.updated arrives)
 * then set STRIPE_CONNECT_WEBHOOK_SECRET to that endpoint's signing secret.
 */
@ApiTags('webhooks')
@Controller('v1/webhooks')
export class ConnectWebhookController {
  private readonly logger = new Logger(ConnectWebhookController.name)

  constructor(
    private readonly payments: PaymentsService,
    private readonly shop: ShopService,
    private readonly ordering: OrderingService,
  ) {}

  @Post('stripe-connect')
  @HttpCode(200)
  async stripeConnect(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') sig?: string) {
    if (!sig) throw new BadRequestException('Missing signature')
    const buf = req.rawBody
    if (!buf) throw new BadRequestException('Missing raw body')
    const event = this.payments.constructConnectEvent(buf, sig)

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const meta = session.metadata ?? {}
        if (meta.mealOrderId) {
          await this.ordering.confirmCheckout(meta.mealOrderId)
          this.logger.log(`Meal order ${meta.mealOrderId} confirmed via webhook`)
        } else if (meta.shopOrderId) {
          await this.shop.confirmCheckout(meta.shopOrderId)
          this.logger.log(`Shop order ${meta.shopOrderId} confirmed via webhook`)
        }
        break
      }
      case 'account.updated':
        await this.payments.syncAccountFromWebhook(event.data.object as Stripe.Account)
        break
      default:
        break
    }
    return { received: true }
  }

  /**
   * Square webhook. One subscription on the developer app covers every
   * merchant who connected, with the merchant id on each event.
   *
   * Square developer dashboard → Webhooks → add subscription
   *   POST {API}/v1/webhooks/square
   *   events: payment.updated, oauth.authorization.revoked
   * then set SQUARE_WEBHOOK_SIGNATURE_KEY to that subscription's signature key.
   */
  @Post('square')
  @HttpCode(200)
  async square(@Req() req: RawBodyRequest<Request>, @Headers('x-square-hmacsha256-signature') sig?: string) {
    const buf = req.rawBody
    if (!buf) throw new BadRequestException('Missing raw body')
    if (!this.payments.verifySquareWebhook(buf, sig)) throw new BadRequestException('Webhook signature failed')

    let event: SquareEvent
    try {
      event = JSON.parse(buf.toString('utf8')) as SquareEvent
    } catch {
      throw new BadRequestException('Malformed webhook body')
    }

    switch (event.type) {
      case 'payment.created':
      case 'payment.updated': {
        const payment = event.data?.object?.payment
        if (payment?.status !== 'COMPLETED' || !payment.order_id) break
        const found = await this.payments.findOrderBySquareOrderId(payment.order_id)
        if (found?.kind === 'meal') {
          await this.ordering.confirmCheckout(found.id)
          this.logger.log(`Meal order ${found.id} confirmed via Square webhook`)
        } else if (found?.kind === 'shop') {
          await this.shop.confirmCheckout(found.id)
          this.logger.log(`Shop order ${found.id} confirmed via Square webhook`)
        }
        break
      }
      case 'oauth.authorization.revoked':
        if (event.merchant_id) await this.payments.squareAccessRevoked(event.merchant_id)
        break
      default:
        break
    }
    return { received: true }
  }
}

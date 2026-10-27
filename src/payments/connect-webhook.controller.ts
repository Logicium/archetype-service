import { BadRequestException, Controller, Headers, HttpCode, Logger, Post, RawBodyRequest, Req } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import type Stripe from 'stripe'
import { PaymentsService } from './payments.service'
import { ShopService } from '../shop/shop.service'
import { OrderingService } from '../ordering/ordering.service'

/**
 * Webhook endpoint for the Stripe Connect PLATFORM account (the one holding
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
}

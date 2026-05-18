import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import Stripe from 'stripe'
import { findBundle, findPriceItem } from '@apotome/archetype-shared'
import { Order } from '../entities/order.entity'
import { Owner } from '../entities/owner.entity'
import { PROVISION_QUEUE, PROVISION_JOB } from '../provisioning/provisioning.constants'
import { AuthService } from '../auth/auth.service'

export interface CreateCheckoutInput {
  archetype: 'mesa' | 'hearth' | 'vault' | 'keystone'
  plan: string
  addOns: string[]
  wizardPayload: Record<string, unknown>
  owner: { email: string; name?: string }
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name)
  private readonly stripe: Stripe | null

  constructor(
    @InjectRepository(Order) private readonly orders: EntityRepository<Order>,
    @InjectRepository(Owner) private readonly owners: EntityRepository<Owner>,
    private readonly em: EntityManager,
    @InjectQueue(PROVISION_QUEUE) private readonly provisionQueue: Queue,
    private readonly auth: AuthService,
  ) {
    const key = process.env.STRIPE_SECRET_KEY
    this.stripe = key ? new Stripe(key, { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion }) : null
    if (!key) this.logger.warn('STRIPE_SECRET_KEY not set — orders will run in dry-run mode.')
  }

  async createCheckoutSession(input: CreateCheckoutInput) {
    // Find-or-create owner.
    const email = input.owner.email.toLowerCase().trim()
    let owner = await this.owners.findOne({ email })
    if (!owner) {
      owner = this.owners.create({ email, name: input.owner.name })
      await this.em.persistAndFlush(owner)
    }

    const order = this.orders.create({
      owner,
      archetype: input.archetype,
      plan: input.plan,
      addOns: input.addOns,
      wizardPayload: input.wizardPayload,
      status: 'pending',
    })
    await this.em.persistAndFlush(order)

    const lineItems = this.resolveLineItems(input.plan, input.addOns)

    if (!this.stripe) {
      // Dev/dry-run mode: skip Stripe, mark paid immediately so the rest of the pipeline can be tested.
      order.status = 'paid'
      await this.em.persistAndFlush(order)
      await this.enqueueProvisioning(order)
      await this.sendOwnerLoginEmail(owner).catch(e => this.logger.warn(`Login email failed: ${(e as Error).message}`))
      return { orderId: order.id, checkoutUrl: null, dryRun: true }
    }

    const successUrl = (process.env.STRIPE_SUCCESS_URL || 'http://localhost:5173/wizard?status=success&order={ORDER_ID}').replace('{ORDER_ID}', order.id)
    const cancelUrl = process.env.STRIPE_CANCEL_URL || 'http://localhost:5173/wizard?status=cancelled'

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { orderId: order.id },
    })
    order.stripeSessionId = session.id
    await this.em.persistAndFlush(order)

    return { orderId: order.id, checkoutUrl: session.url }
  }

  /** Resolves SKU ids → Stripe line items via env-mapped Price IDs. */
  private resolveLineItems(plan: string, addOns: string[]): Stripe.Checkout.SessionCreateParams.LineItem[] {
    const out: Stripe.Checkout.SessionCreateParams.LineItem[] = []
    const all = [plan, ...addOns]
    for (const id of all) {
      const item = findPriceItem(id) ?? findBundle(id)
      if (!item) throw new BadRequestException(`Unknown SKU: ${id}`)
      const envKey = (item as { stripePriceEnv?: string }).stripePriceEnv
      const priceId = envKey ? process.env[envKey] : undefined
      if (priceId) {
        out.push({ price: priceId, quantity: 1 })
      } else {
        // Fall back to inline price_data using the catalog price.
        out.push({
          price_data: {
            currency: 'usd',
            product_data: { name: item.name, description: item.blurb },
            unit_amount: Math.round(item.price * 100),
          },
          quantity: 1,
        })
      }
    }
    return out
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    if (!this.stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      this.logger.warn('Stripe webhook received but Stripe not configured — ignoring')
      return
    }
    let event: Stripe.Event
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (e) {
      throw new BadRequestException(`Webhook signature failed: ${(e as Error).message}`)
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const orderId = session.metadata?.orderId
      if (!orderId) return
      const order = await this.orders.findOne({ id: orderId }, { populate: ['owner'] as never })
      if (!order) return
      if (order.status === 'pending') {
        order.status = 'paid'
        order.stripeCustomerId = typeof session.customer === 'string' ? session.customer : undefined
        await this.em.persistAndFlush(order)
        await this.enqueueProvisioning(order)
        await this.sendOwnerLoginEmail(order.owner).catch(e => this.logger.warn(`Login email failed: ${(e as Error).message}`))
      }
    }
  }

  /** After a successful purchase, email the owner a magic sign-in link so
   *  they can immediately access /admin to watch their site provision and
   *  review their order. They can later set a password from the admin. */
  private async sendOwnerLoginEmail(owner: Owner) {
    await this.auth.requestMagicLink(owner.email, owner.name)
  }

  private async enqueueProvisioning(order: Order) {
    if (process.env.FEATURE_PROVISIONING === 'false') {
      this.logger.warn(`Provisioning disabled by flag — order ${order.id} marked paid only`)
      return
    }
    await this.provisionQueue.add(
      PROVISION_JOB,
      { orderId: order.id },
      { jobId: `provision-${order.id}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
    )
  }

  async getPublicStatus(id: string) {
    const order = await this.orders.findOne({ id })
    if (!order) throw new NotFoundException('Order not found')
    return { id: order.id, status: order.status, siteId: order.siteId, failureReason: order.failureReason }
  }

  async listForOwner(owner: Owner) {
    const rows = await this.orders.find({ owner: owner.id }, { orderBy: { createdAt: 'desc' }, limit: 50 })
    return rows.map(r => ({ id: r.id, archetype: r.archetype, plan: r.plan, status: r.status, siteId: r.siteId, createdAt: r.createdAt, failureReason: r.failureReason }))
  }

  async retryProvisioning(id: string, owner: Owner) {
    const order = await this.orders.findOne({ id }, { populate: ['owner'] as never })
    if (!order) throw new NotFoundException('Order not found')
    if (order.owner.id !== owner.id) throw new ForbiddenException('Not your order')
    if (!['failed', 'paid', 'provisioning'].includes(order.status)) throw new BadRequestException('Cannot retry from this state')
    order.status = 'paid'
    order.failureReason = undefined
    await this.em.persistAndFlush(order)
    await this.enqueueProvisioning(order)
    return { ok: true }
  }
}

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import Stripe from 'stripe'
import { findBundle, findPriceItem } from '../shared'
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
  /** Browser origin (e.g. https://app.example.com) — preferred over env defaults. */
  origin?: string
}

/** Returns the `scheme://host[:port]` of a trusted origin, or undefined if invalid/untrusted. */
function sanitizeOrigin(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return `${u.protocol}//${u.host}`
  } catch {
    return undefined
  }
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

    const dynamicBase = sanitizeOrigin(input.origin)
    const successTemplate = dynamicBase
      ? `${dynamicBase}/wizard?status=success&order={ORDER_ID}`
      : (process.env.STRIPE_SUCCESS_URL || 'http://localhost:5173/wizard?status=success&order={ORDER_ID}')
    const cancelTemplate = dynamicBase
      ? `${dynamicBase}/wizard?status=cancelled`
      : (process.env.STRIPE_CANCEL_URL || 'http://localhost:5173/wizard?status=cancelled')
    const successUrl = successTemplate.replace('{ORDER_ID}', order.id)
    const cancelUrl = cancelTemplate

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
    // BullMQ deduplicates by jobId — a prior completed/failed job with the same id
    // would silently drop a re-enqueue. Remove any existing job first so reprovision works.
    const existing = await this.provisionQueue.getJob(`provision-${order.id}`)
    if (existing) {
      try { await existing.remove() } catch (e) {
        this.logger.warn(`Could not remove existing provision job for order ${order.id}: ${(e as Error).message}`)
      }
    }
    await this.provisionQueue.add(
      PROVISION_JOB,
      { orderId: order.id },
      { jobId: `provision-${order.id}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
    )
    this.logger.log(`Enqueued provisioning job provision-${order.id}`)
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

  /** Find the order that produced a given site (owned by `owner`). */
  async findBySiteId(siteId: string, owner: Owner): Promise<Order> {
    const order = await this.orders.findOne({ siteId, owner: owner.id }, { populate: ['owner'] as never })
    if (!order) throw new NotFoundException('No order linked to this site')
    return order
  }

  /** Find an order by id (scoped to owner). */
  async findOwned(orderId: string, owner: Owner): Promise<Order> {
    const order = await this.orders.findOne({ id: orderId, owner: owner.id }, { populate: ['owner'] as never })
    if (!order) throw new NotFoundException('Order not found')
    return order
  }

  /** Order-level Stripe diagnostic — works even when the order never produced a site. */
  async getStripeStatusForOrder(orderId: string, owner: Owner) {
    const order = await this.findOwned(orderId, owner)
    return this.buildStripeStatus(order)
  }

  /** Order-level resolve — for pending orders whose webhook never landed. */
  async resolveBillingForOrder(orderId: string, owner: Owner) {
    const order = await this.findOwned(orderId, owner)
    return this.resolveAndEnqueue(order)
  }

  /**
   * Force-reprovision a stuck site: resets the order back to `paid` and re-enqueues
   * the provisioning job. Idempotent steps in the processor (createRepo, createProject,
   * putFile, etc.) will reuse existing GitHub/Vercel resources instead of duplicating them.
   */
  async reprovisionForSite(siteId: string, owner: Owner) {
    const order = await this.findBySiteId(siteId, owner)
    order.status = 'paid'
    order.failureReason = undefined
    await this.em.persistAndFlush(order)
    await this.enqueueProvisioning(order)
    return { ok: true, orderId: order.id }
  }

  /**
   * Diagnostic: look up the Stripe checkout session + payment intent + recent webhook
   * events for an order so an operator can determine whether payment actually went
   * through when the site is stuck in `pending`/`provisioning`.
   */
  async getStripeStatusForSite(siteId: string, owner: Owner) {
    const order = await this.findBySiteId(siteId, owner)
    return this.buildStripeStatus(order)
  }

  /** If Stripe confirms the session was paid but the order never flipped, mark paid + enqueue. */
  async resolveBillingForSite(siteId: string, owner: Owner) {
    const order = await this.findBySiteId(siteId, owner)
    return this.resolveAndEnqueue(order)
  }

  private async resolveAndEnqueue(order: Order) {
    if (!this.stripe) throw new BadRequestException('Stripe not configured')
    if (!order.stripeSessionId) throw new BadRequestException('Order has no Stripe session')
    const session = await this.stripe.checkout.sessions.retrieve(order.stripeSessionId)
    if (session.payment_status !== 'paid') {
      throw new BadRequestException(`Stripe session payment_status=${session.payment_status}; refusing to mark paid`)
    }
    if (order.status === 'pending') {
      order.status = 'paid'
      order.stripeCustomerId = typeof session.customer === 'string' ? session.customer : undefined
      await this.em.persistAndFlush(order)
    } else if (order.status === 'failed') {
      order.status = 'paid'
      order.failureReason = undefined
      await this.em.persistAndFlush(order)
    }
    await this.enqueueProvisioning(order)
    return { ok: true, orderId: order.id, orderStatus: order.status }
  }

  private async buildStripeStatus(order: Order) {
    const base = {
      orderId: order.id,
      orderStatus: order.status,
      stripeSessionId: order.stripeSessionId ?? null,
      stripeCustomerId: order.stripeCustomerId ?? null,
      failureReason: order.failureReason ?? null,
    }
    if (!this.stripe) return { ...base, stripeConfigured: false }
    if (!order.stripeSessionId) return { ...base, stripeConfigured: true, session: null }

    try {
      const session = await this.stripe.checkout.sessions.retrieve(order.stripeSessionId, {
        expand: ['payment_intent'],
      })
      const pi = (typeof session.payment_intent === 'object' && session.payment_intent) ? session.payment_intent as Stripe.PaymentIntent : null

      // Pull recent checkout.session.* events for this session so we can show whether
      // a webhook ever fired (and what it looked like). Stripe returns most-recent first.
      let events: Array<{ id: string; type: string; created: number }> = []
      try {
        const ev = await this.stripe.events.list({ limit: 25, type: 'checkout.session.completed' })
        events = ev.data
          .filter(e => (e.data?.object as { id?: string } | undefined)?.id === session.id)
          .map(e => ({ id: e.id, type: e.type, created: e.created }))
      } catch { /* event listing is optional */ }

      const paidButOrderStuck = session.payment_status === 'paid' && order.status === 'pending'

      return {
        ...base,
        stripeConfigured: true,
        session: {
          id: session.id,
          paymentStatus: session.payment_status,
          status: session.status,
          amountTotal: session.amount_total,
          currency: session.currency,
          customerEmail: session.customer_email,
          createdAt: new Date(session.created * 1000).toISOString(),
        },
        paymentIntent: pi ? {
          id: pi.id,
          status: pi.status,
          amount: pi.amount,
          amountReceived: pi.amount_received,
          lastPaymentError: pi.last_payment_error?.message ?? null,
        } : null,
        webhookEvents: events,
        canResolve: paidButOrderStuck,
        notes: paidButOrderStuck
          ? 'Stripe confirms payment but the order never flipped to paid \u2014 webhook likely missed. You can mark paid + provision.'
          : null,
      }
    } catch (e) {
      return { ...base, stripeConfigured: true, error: (e as Error).message }
    }
  }
}

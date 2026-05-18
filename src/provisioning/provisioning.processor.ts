import { Logger } from '@nestjs/common'
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { Order } from '../entities/order.entity'
import { Site } from '../entities/site.entity'
import { DeployLog } from '../entities/misc.entity'
import { SitesService } from '../sites/sites.service'
import { GitHubProvisioner } from './github.provisioner'
import { VercelProvisioner } from './vercel.provisioner'
import { EmailService } from '../common/email.service'
import { PROVISION_JOB, PROVISION_QUEUE } from './provisioning.constants'

@Processor(PROVISION_QUEUE)
export class ProvisioningProcessor extends WorkerHost {
  private readonly logger = new Logger(ProvisioningProcessor.name)

  constructor(
    @InjectRepository(Order) private readonly orders: EntityRepository<Order>,
    @InjectRepository(Site) private readonly sites: EntityRepository<Site>,
    @InjectRepository(DeployLog) private readonly logs: EntityRepository<DeployLog>,
    private readonly em: EntityManager,
    private readonly sitesSvc: SitesService,
    private readonly github: GitHubProvisioner,
    private readonly vercel: VercelProvisioner,
    private readonly email: EmailService,
  ) { super() }

  async process(job: Job<{ orderId: string }>) {
    if (job.name !== PROVISION_JOB) return
    const order = await this.orders.findOne({ id: job.data.orderId }, { populate: ['owner'] as never })
    if (!order) throw new Error(`Order ${job.data.orderId} not found`)

    order.status = 'provisioning'
    await this.em.persistAndFlush(order)

    let site: Site | null = order.siteId ? await this.sites.findOne({ id: order.siteId }) : null
    const wp = order.wizardPayload as { desiredSlug?: string; config?: Record<string, unknown> }

    // Step 1 — create or reuse the Site row.
    site = await this.step(order.id, site, 'create-site', async () => {
      if (site) return site
      const slug = await this.sitesSvc.generateSlug(wp.desiredSlug || `${order.archetype}-site`)
      const created = this.sites.create({
        owner: order.owner,
        slug,
        archetype: order.archetype,
        plan: order.plan,
        status: 'provisioning',
      })
      await this.em.persistAndFlush(created)
      order.siteId = created.id
      await this.em.persistAndFlush(order)
      return created
    })
    if (!site) throw new Error('Site row missing after create-site')

    // Step 2 — persist initial published content from wizard payload.
    await this.step(order.id, site, 'seed-content', async () => {
      const existing = await this.sitesSvc.getPublishedContent(site!.id)
      if (existing && Object.keys(existing).length) return existing
      await this.sitesSvc.publish(site!, (wp.config ?? {}) as Record<string, unknown>)
      return 'published v1'
    })

    // Step 3 — GitHub repo from template + .env.production.
    const repoInfo = await this.step(order.id, site, 'github-repo', async () => {
      const info = await this.github.createRepo(site!.archetype, site!.slug)
      site!.githubRepo = `${info.owner}/${info.repo}`
      await this.em.persistAndFlush(site!)
      const envContent = [
        `VITE_SITE_SLUG=${site!.slug}`,
        `VITE_CONTENT_API=${process.env.PUBLIC_BASE_URL || ''}/v1`,
        `VITE_PLATFORM_ENABLED=true`,
      ].join('\n') + '\n'
      await this.github.putFile(info.owner, info.repo, '.env.production', envContent, 'chore: configure runtime overlay')
      return info
    })

    // Step 4 — Vercel project linked to that repo.
    const project = await this.step(order.id, site, 'vercel-project', async () => {
      const proj = await this.vercel.createProject(site!.slug, repoInfo!.repo)
      site!.vercelProjectId = proj.id
      await this.em.persistAndFlush(site!)
      await this.vercel.setEnv(proj.id, 'VITE_SITE_SLUG', site!.slug)
      await this.vercel.setEnv(proj.id, 'VITE_CONTENT_API', `${process.env.PUBLIC_BASE_URL || ''}/v1`)
      await this.vercel.setEnv(proj.id, 'VITE_PLATFORM_ENABLED', 'true')
      return proj
    })

    // Step 5 — trigger first deployment.
    await this.step(order.id, site, 'vercel-deploy', async () => {
      const dep = await this.vercel.triggerDeployment(project!.id, repoInfo!.repo)
      site!.vercelProductionUrl = dep.url
      site!.status = 'live'
      await this.em.persistAndFlush(site!)
      return dep
    })

    // Step 6 — notify owner with magic-link to the admin area.
    await this.step(order.id, site, 'notify-owner', async () => {
      const productionUrl = site!.vercelProductionUrl ? `https://${site!.vercelProductionUrl}` : '(deploying)'
      await this.email.send({
        to: order.owner.email,
        subject: `Your ${site!.slug} site is live`,
        html: `<p>Hi${order.owner.name ? ' ' + order.owner.name : ''},</p>
          <p>Your new site is live at <a href="${productionUrl}">${productionUrl}</a>.</p>
          <p>Sign in to your dashboard at ${productionUrl}/admin to edit content, swap photos, change themes, and view form submissions.</p>`,
        ccAdmin: true,
      })
      return 'sent'
    })

    order.status = 'live'
    await this.em.persistAndFlush(order)
  }

  private async step<T>(orderId: string, site: Site | null, name: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      const result = await fn()
      if (site) {
        await this.em.persistAndFlush(this.logs.create({ site, step: name, status: 'success', message: String(result).slice(0, 4000), durationMs: Date.now() - started }))
      }
      this.logger.log(`order=${orderId} step=${name} ok ${Date.now() - started}ms`)
      return result
    } catch (e) {
      const message = (e as Error).message
      if (site) {
        await this.em.persistAndFlush(this.logs.create({ site, step: name, status: 'failure', message, durationMs: Date.now() - started }))
      }
      this.logger.error(`order=${orderId} step=${name} FAIL: ${message}`)
      throw e
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const order = await this.orders.findOne({ id: job.data.orderId })
      if (order) {
        order.status = 'failed'
        order.failureReason = err.message
        await this.em.persistAndFlush(order)
        await this.email.alertAdmin(`Provisioning failed for order ${order.id}`, `<pre>${err.stack || err.message}</pre>`)
      }
    }
  }
}

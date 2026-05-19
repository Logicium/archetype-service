import { Logger } from '@nestjs/common'
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { EntityManager } from '@mikro-orm/postgresql'
import { Order } from '../entities/order.entity'
import { Site } from '../entities/site.entity'
import { SiteContent } from '../entities/site-content.entity'
import { DeployLog } from '../entities/misc.entity'
import { GitHubProvisioner } from './github.provisioner'
import { VercelProvisioner } from './vercel.provisioner'
import { EmailService } from '../common/email.service'
import { PROVISION_JOB, PROVISION_QUEUE } from './provisioning.constants'

@Processor(PROVISION_QUEUE)
export class ProvisioningProcessor extends WorkerHost {
  private readonly logger = new Logger(ProvisioningProcessor.name)

  constructor(
    private readonly em: EntityManager,
    private readonly github: GitHubProvisioner,
    private readonly vercel: VercelProvisioner,
    private readonly email: EmailService,
  ) { super() }

  async process(job: Job<{ orderId: string }>) {
    if (job.name !== PROVISION_JOB) return

    // Fork the EntityManager so this worker context gets its own identity map.
    const em = this.em.fork()
    const orders = em.getRepository(Order)
    const sites = em.getRepository(Site)
    const logs = em.getRepository(DeployLog)

    const order = await orders.findOne({ id: job.data.orderId }, { populate: ['owner'] as never })
    if (!order) throw new Error(`Order ${job.data.orderId} not found`)

    order.status = 'provisioning'
    await em.persistAndFlush(order)

    let site: Site | null = order.siteId ? await sites.findOne({ id: order.siteId }) : null
    const wp = order.wizardPayload as { desiredSlug?: string; config?: Record<string, unknown> }

    /** Helper: run a step, log success/failure, rethrow on failure. */
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const started = Date.now()
      try {
        const result = await fn()
        if (site) {
          await em.persistAndFlush(logs.create({ site, step: name, status: 'success', message: String(result).slice(0, 4000), durationMs: Date.now() - started }))
        }
        this.logger.log(`order=${order.id} step=${name} ok ${Date.now() - started}ms`)
        return result
      } catch (e) {
        const message = (e as Error).message
        if (site) {
          await em.persistAndFlush(logs.create({ site, step: name, status: 'failure', message, durationMs: Date.now() - started }))
        }
        this.logger.error(`order=${order.id} step=${name} FAIL: ${message}`)
        throw e
      }
    }

    // Step 1 — create or reuse the Site row.
    site = await step('create-site', async () => {
      if (site) return site
      // Generate a unique slug without touching the global EM.
      const base = (wp.desiredSlug || `${order.archetype}-site`)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site'
      let candidate = base
      let n = 0
      while (await sites.findOne({ slug: candidate })) { candidate = `${base}-${++n}` }
      const created = sites.create({
        owner: order.owner,
        slug: candidate,
        archetype: order.archetype,
        plan: order.plan,
        status: 'provisioning',
      })
      await em.persistAndFlush(created)
      order.siteId = created.id
      await em.persistAndFlush(order)
      return created
    })
    if (!site) throw new Error('Site row missing after create-site')

    // Step 2 — persist initial published content from wizard payload.
    await step('seed-content', async () => {
      const contents = em.getRepository(SiteContent)
      const existing = await contents.findOne({ site: site!.id, published: true }, { orderBy: { version: 'desc' } })
      if (existing) return 'already seeded'
      const latest = await contents.findOne({ site: site!.id }, { orderBy: { version: 'desc' } })
      const row = contents.create({
        site: site!,
        version: (latest?.version ?? 0) + 1,
        payload: (wp.config ?? {}) as Record<string, unknown>,
        published: true,
        publishedAt: new Date(),
      })
      await em.persistAndFlush(row)
      return 'published v1'
    })

    // Step 3 — GitHub repo from template + .env.production + tenant.config.json.
    const repoInfo = await step('github-repo', async () => {
      const info = await this.github.createRepo(site!.archetype, site!.slug)
      site!.githubRepo = `${info.owner}/${info.repo}`
      await em.persistAndFlush(site!)

      // Runtime env so the deployed UI talks to this API server.
      const envContent = [
        `VITE_SITE_SLUG=${site!.slug}`,
        `VITE_CONTENT_API=${process.env.PUBLIC_BASE_URL || ''}/v1`,
        `VITE_PLATFORM_ENABLED=true`,
      ].join('\n') + '\n'
      await this.github.putFile(info.owner, info.repo, '.env.production', envContent, 'chore: configure runtime overlay')

      // Write the full wizard config as tenant.config.json so the template
      // can render meaningful default content before the CMS overlay loads.
      const tenantConfig = {
        _generated: new Date().toISOString(),
        archetype: site!.archetype,
        ...(wp.config ?? {}),
      }
      await this.github.putFile(
        info.owner, info.repo,
        'public/tenant.config.json',
        JSON.stringify(tenantConfig, null, 2) + '\n',
        'chore: inject tenant config from wizard',
      )

      // Record the template's current commit SHA so we can detect updates later.
      try {
        const templateRepo = this.github.templateFor(site!.archetype)
        const templateOwner = process.env.GITHUB_ORG || info.owner
        const templateInfo = await this.github.getRepoInfo(`${templateOwner}/${templateRepo}`)
        site!.templateCommitSha = await this.github.getLatestCommitSha(templateOwner, templateRepo, templateInfo.defaultBranch)
        await em.persistAndFlush(site!)
      } catch (e) {
        this.logger.warn(`template SHA capture failed: ${(e as Error).message}`)
      }

      return info
    })

    // Step 4 — Vercel project linked to that repo.
    const project = await step('vercel-project', async () => {
      const proj = await this.vercel.createProject(site!.slug, repoInfo!.repo)
      site!.vercelProjectId = proj.id
      // Store the canonical URL immediately from the actual project name Vercel assigned.
      // Vercel may rename the project if the slug collides (e.g. "mesa-site-1" → "mesa-ten").
      site!.vercelProductionUrl = `https://${proj.projectName}.vercel.app`
      await em.persistAndFlush(site!)
      await this.vercel.setEnv(proj.id, 'VITE_SITE_SLUG', site!.slug)
      await this.vercel.setEnv(proj.id, 'VITE_CONTENT_API', `${process.env.PUBLIC_BASE_URL || ''}/v1`)
      await this.vercel.setEnv(proj.id, 'VITE_PLATFORM_ENABLED', 'true')
      return proj
    })

    // Step 5 — trigger first deployment.
    await step('vercel-deploy', async () => {
      const dep = await this.vercel.triggerDeployment(project!.id, repoInfo!.repo, repoInfo!.repoId, repoInfo!.defaultBranch)
      site!.status = 'live'
      await em.persistAndFlush(site!)
      return dep
    })

    // Step 6 — notify owner with magic-link to the admin area.
    await step('notify-owner', async () => {
      const productionUrl = site!.vercelProductionUrl ?? '(deploying)'
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
    await em.persistAndFlush(order)
  }


  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const em = this.em.fork()
      const order = await em.findOne(Order, { id: job.data.orderId })
      if (order) {
        order.status = 'failed'
        order.failureReason = err.message
        await em.persistAndFlush(order)
        await this.email.alertAdmin(`Provisioning failed for order ${order.id}`, `<pre>${err.stack || err.message}</pre>`)
      }
    }
  }
}

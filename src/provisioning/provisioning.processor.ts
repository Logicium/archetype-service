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
import { brandedEmail, emailButton, emailHeading, emailLineItems } from '../common/email-template'
import { summarizeOrder } from './order-summary.util'
import { PROVISION_JOB, PROVISION_QUEUE } from './provisioning.constants'
import { resolveDeployedContentApiUrl } from './content-api.util'
import { normalizeWizardPayload } from './wizard-payload.util'
import { getArchetypeDefaults } from './defaults'
import { mergeContent } from './merge-content.util'
import { SiteCopyGenerator } from './site-copy.generator'

@Processor(PROVISION_QUEUE)
export class ProvisioningProcessor extends WorkerHost {
  private readonly logger = new Logger(ProvisioningProcessor.name)

  constructor(
    private readonly em: EntityManager,
    private readonly github: GitHubProvisioner,
    private readonly vercel: VercelProvisioner,
    private readonly email: EmailService,
    private readonly copyGen: SiteCopyGenerator,
  ) { super() }

  /**
   * Returns the public URL deployed child sites should use for VITE_CONTENT_API.
   * Delegates to the shared util so the redeploy endpoint and other call-sites
   * stay in sync with the same validation rules.
   */
  private resolveContentApiUrl(): string {
    return resolveDeployedContentApiUrl()
  }

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
    // The wizard UI posts a flat form as wizardPayload; normalize to { desiredSlug, config }
    // so the rest of the pipeline (slug derivation, seed-content, .env.production, tenant.config.json)
    // sees a stable SiteContent-shaped payload regardless of which client version submitted it.
    const archetype = order.archetype as 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone'
    const wp = normalizeWizardPayload(order.wizardPayload, archetype)

    // Layer: archetype defaults < AI-generated copy < wizard input.
    // Defaults give every new site placeholder photos + stock copy so it doesn't look empty;
    // the AI layer fills wordy fields (taglines, blurbs, item descriptions) using wizard inputs
    // as context; wizard input always wins for fields the buyer actually filled in.
    const defaults = getArchetypeDefaults(archetype)
    let aiCopy: Record<string, unknown> = {}
    try {
      aiCopy = await this.copyGen.generate(archetype, (wp.config ?? {}) as Record<string, unknown>)
    } catch (e) {
      this.logger.warn(`AI copy generation failed: ${(e as Error).message}`)
    }
    const seededConfig = mergeContent<Record<string, unknown>>(defaults, aiCopy, wp.config ?? {})

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
        payload: seededConfig,
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
      const contentApi = this.resolveContentApiUrl()
      const envContent = [
        `VITE_SITE_ID=${site!.id}`,
        `VITE_SITE_SLUG=${site!.slug}`,
        `VITE_CONTENT_API=${contentApi}`,
        `VITE_PLATFORM_ENABLED=true`,
      ].join('\n') + '\n'
      await this.github.putFile(info.owner, info.repo, '.env.production', envContent, 'chore: configure runtime overlay')

      // Write the full wizard config as tenant.config.json so the template
      // can render meaningful default content before the CMS overlay loads.
      const tenantConfig = {
        _generated: new Date().toISOString(),
        archetype: site!.archetype,
        ...seededConfig,
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
      await this.vercel.setEnv(proj.id, 'VITE_SITE_ID', site!.id)
      await this.vercel.setEnv(proj.id, 'VITE_SITE_SLUG', site!.slug)
      await this.vercel.setEnv(proj.id, 'VITE_CONTENT_API', this.resolveContentApiUrl())
      await this.vercel.setEnv(proj.id, 'VITE_PLATFORM_ENABLED', 'true')
      return proj
    })

    // Step 5 — trigger first deployment.
    await step('vercel-deploy', async () => {
      const dep = await this.vercel.triggerDeployment(project!.id, repoInfo!.repo, repoInfo!.repoId, repoInfo!.defaultBranch)
      // Re-resolve the production URL from Vercel now that a deployment exists.
      // The initial `<projectName>.vercel.app` guess can be wrong if Vercel routes
      // production traffic to a different alias; the alias list on the deployment
      // is the source of truth.
      const resolved = await this.vercel.getProductionUrl(project!.id).catch(() => null)
      if (resolved && resolved !== site!.vercelProductionUrl) {
        site!.vercelProductionUrl = resolved
      }
      site!.status = 'live'
      await em.persistAndFlush(site!)
      return dep
    })

    // Step 6 — the welcome sequence: a branded customer welcome, a new-client
    // heads-up to the owner, and a personal (reply-able) note from the owner.
    await step('notify-owner', async () => {
      const productionUrl = site!.vercelProductionUrl ?? '(deploying)'
      const dashboardUrl = `${productionUrl}/admin`
      const firstName = (order.owner.name || '').split(' ')[0] || 'there'
      const businessName = ((seededConfig as Record<string, unknown>).brand as string) || site!.slug
      const ownerEmail = process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || 'kisora@apotomelabs.com'
      const ownerName = process.env.OWNER_NAME || 'Kisora'
      const bookingUrl = process.env.OWNER_BOOKING_URL || 'https://apotomelabs.com/contact'
      const ARCHETYPE_NOUN: Record<string, string> = {
        mesa: 'restaurant', hearth: 'stay', vault: 'shop', keystone: 'trade', marquee: 'venue',
      }
      const noun = ARCHETYPE_NOUN[site!.archetype] || 'business'
      const linkStyle = 'color:#6366f1;text-decoration:none;font-weight:600;'
      const results: string[] = []

      // 1 · Customer welcome — platform voice.
      results.push(String(await this.email.send({
        to: order.owner.email,
        subject: `Welcome to Apotome: ${businessName} is live 🎉`,
        html: brandedEmail(
          emailHeading('Your website is live.') +
          `<p>Hi ${firstName}, welcome to Apotome. Your ${noun} site for <strong>${businessName}</strong> is built, live, and yours.</p>` +
          `<p style="margin:24px 0;">${emailButton('Visit your site', productionUrl)}&nbsp;&nbsp;&nbsp;<a href="${dashboardUrl}" style="${linkStyle}">Open your dashboard →</a></p>` +
          `<p>From your dashboard you can edit your words and photos, switch themes and colors, read messages from visitors, and see who's stopping by. No code, and every change goes live in seconds.</p>` +
          `<p>Google Maps, your Instagram feed, and live Google reviews are already built in. We're glad you're here.</p>`,
          { preheader: `${businessName} is live on Apotome.` },
        ),
      })))

      // 2 · Owner heads-up — new client + what they bought.
      const summary = summarizeOrder(order.plan, order.addOns)
      results.push(String(await this.email.send({
        to: ownerEmail,
        subject: `New client: ${businessName} (${summary.planLabel})`,
        html: brandedEmail(
          emailHeading('New client 🎉') +
          `<p><strong>${businessName}</strong> just signed up.</p>` +
          `<p style="margin:0 0 4px;">Client: ${order.owner.name || 'Not provided'} &lt;${order.owner.email}&gt;<br>Archetype: ${site!.archetype}</p>` +
          emailLineItems(summary.lines) +
          `<p style="margin-top:22px;">${emailButton('View their site', productionUrl)}&nbsp;&nbsp;&nbsp;<a href="${dashboardUrl}" style="${linkStyle}">Their dashboard →</a></p>`,
          { preheader: `${businessName}: ${summary.planLabel}, $${summary.total}` },
        ),
      })))

      // 3 · Personal welcome from the owner — replies land in the business inbox.
      results.push(String(await this.email.send({
        to: order.owner.email,
        from: `${ownerName} at Apotome Labs <${ownerEmail}>`,
        replyTo: ownerEmail,
        subject: `A personal welcome from ${ownerName} at Apotome Labs`,
        html: brandedEmail(
          `<p>Hi ${firstName},</p>` +
          `<p>It's ${ownerName}, founder of Apotome Labs here in Trinidad. I wanted to welcome you myself and to thank you for trusting us with ${businessName}.</p>` +
          `<p>If you'd like a hand getting set up, have any questions, or ever need support down the road, I'd love to help. Grab a time that works for you and we'll walk through it together, no rush and no pressure.</p>` +
          `<p style="margin:24px 0;">${emailButton('Book a time with me', bookingUrl)}</p>` +
          `<p>You can also just reply to this email. It comes straight to my inbox and I read every one.</p>` +
          `<p style="margin-bottom:0;">Talk soon,<br><strong>${ownerName}</strong><br><span style="color:#a1a1aa;">Founder, Apotome Labs · Trinidad</span></p>`,
          { preheader: `A quick hello from ${ownerName}, and a hand getting set up.`, footNote: `Sent by ${ownerName}, Founder of Apotome Labs · Trinidad, Colorado · reply anytime` },
        ),
      })))

      return `welcome+owner+personal: ${results.join(',')}`
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

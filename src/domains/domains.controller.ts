import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { EntityManager } from '@mikro-orm/postgresql'
import { SitesService } from '../sites/sites.service'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { VercelProvisioner } from '../provisioning/vercel.provisioner'

interface VercelDomainConfig {
  misconfigured?: boolean
  [key: string]: unknown
}

/** Strips protocol, path, and a leading `www.` so we always store the apex. */
function normalizeDomain(input: string): string {
  let d = input.toLowerCase().trim()
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  d = d.replace(/^www\./, '')
  return d
}

function dnsInstructions(_domain: string) {
  return {
    instructions: [
      { type: 'A', name: '@', value: '76.76.21.21', note: 'Apex record pointing to Vercel' },
      { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com', note: 'www subdomain' },
    ],
  }
}

@ApiTags('admin:domain')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class DomainsController {
  constructor(
    private readonly sites: SitesService,
    private readonly em: EntityManager,
    private readonly vercel: VercelProvisioner,
  ) {}

  @Post(':id/domain')
  async request(@Param('id') id: string, @Req() req: AuthRequest, @Body() body: { domain: string }) {
    const site = await this.sites.getOwned(id, req.owner)
    const domain = normalizeDomain(body.domain || '')
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new BadRequestException('Invalid domain')
    site.customDomain = domain
    await this.em.persistAndFlush(site)
    return { domain, dns: dnsInstructions(domain) }
  }

  @Post(':id/domain/verify')
  async verify(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    if (!site.customDomain) throw new BadRequestException('No domain configured')
    if (!site.vercelProjectId) throw new BadRequestException('Site not provisioned')

    // Attach apex + www to the Vercel project. "Already attached" is fine —
    // verify must be safely repeatable while the owner waits on DNS.
    const attachErrors: string[] = []
    for (const d of [site.customDomain, `www.${site.customDomain}`]) {
      try {
        await this.vercel.attachDomain(site.vercelProjectId, d)
      } catch (e) {
        const msg = (e as Error).message
        if (!/409|already/i.test(msg)) attachErrors.push(msg)
      }
    }
    if (attachErrors.length) {
      throw new BadRequestException(`Domain attach failed: ${attachErrors[0]}`)
    }

    // Attach success only means Vercel accepted the domain — DNS may still
    // point elsewhere. Report the real per-record state so the UI never
    // claims "verified" while the domain doesn't resolve.
    const apexConfig = (await this.vercel.getDomainConfig(site.customDomain).catch(() => null)) as VercelDomainConfig | null
    const wwwConfig = (await this.vercel.getDomainConfig(`www.${site.customDomain}`).catch(() => null)) as VercelDomainConfig | null
    const apexOk = apexConfig ? apexConfig.misconfigured !== true : false
    const wwwOk = wwwConfig ? wwwConfig.misconfigured !== true : false

    return {
      ok: apexOk && wwwOk,
      apex: { domain: site.customDomain, configured: apexOk },
      www: { domain: `www.${site.customDomain}`, configured: wwwOk },
    }
  }

  @Get(':id/domain')
  async status(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    if (!site.customDomain) return { domain: undefined }
    return { domain: site.customDomain, dns: dnsInstructions(site.customDomain) }
  }
}

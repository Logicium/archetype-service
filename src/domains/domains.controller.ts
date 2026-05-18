import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { randomBytes } from 'crypto'
import { EntityManager } from '@mikro-orm/postgresql'
import { SitesService } from '../sites/sites.service'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { VercelProvisioner } from '../provisioning/vercel.provisioner'

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
    const domain = body.domain.toLowerCase().trim()
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new BadRequestException('Invalid domain')
    site.customDomain = domain
    if (!site.domainVerificationToken) site.domainVerificationToken = randomBytes(16).toString('hex')
    await this.em.persistAndFlush(site)
    return {
      domain,
      dns: {
        instructions: [
          { type: 'A', name: '@', value: '76.76.21.21', note: 'Apex record pointing to Vercel' },
          { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com', note: 'Subdomain' },
          { type: 'TXT', name: `_apotome-verify.${domain}`, value: site.domainVerificationToken, note: 'Ownership verification' },
        ],
      },
    }
  }

  @Post(':id/domain/verify')
  async verify(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    if (!site.customDomain) throw new BadRequestException('No domain configured')
    if (!site.vercelProjectId) throw new BadRequestException('Site not provisioned')
    try {
      await this.vercel.attachDomain(site.vercelProjectId, site.customDomain)
      await this.vercel.attachDomain(site.vercelProjectId, `www.${site.customDomain}`)
      const config = await this.vercel.getDomainConfig(site.customDomain)
      return { ok: true, config }
    } catch (e) {
      throw new BadRequestException(`Domain attach failed: ${(e as Error).message}`)
    }
  }

  @Get(':id/domain')
  async status(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    return { domain: site.customDomain, token: site.domainVerificationToken }
  }
}

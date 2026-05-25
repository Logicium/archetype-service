import { BadRequestException, Body, Controller, Get, Headers, Ip, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator'
import { Throttle } from '@nestjs/throttler'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql'
import { FormSubmission } from '../entities/misc.entity'
import { SitesService } from '../sites/sites.service'
import { EmailService } from '../common/email.service'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

class SubmitDto {
  @IsIn(['contact', 'newsletter']) type!: 'contact' | 'newsletter'
  @IsObject() fields!: Record<string, string>
  @IsOptional() @IsString() hp?: string
  @IsOptional() @IsString() captcha?: string
}

@ApiTags('forms')
@Controller('v1/sites')
export class FormsController {
  constructor(
    @InjectRepository(FormSubmission) private readonly subs: EntityRepository<FormSubmission>,
    private readonly em: EntityManager,
    private readonly sites: SitesService,
    private readonly email: EmailService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':key/submissions')
  async submit(@Param('key') key: string, @Body() dto: SubmitDto, @Ip() ip: string, @Headers('user-agent') ua?: string) {
    if (dto.hp && dto.hp.length > 0) {
      // Honeypot — pretend success.
      return { ok: true }
    }
    if (process.env.HCAPTCHA_SECRET && !dto.captcha) {
      throw new BadRequestException('Captcha required')
    }
    // TODO: verify hCaptcha server-side when HCAPTCHA_SECRET is set.

    const site = await this.sites.findBySlug(slug)
    const row = this.subs.create({
      site,
      type: dto.type,
      payload: dto.fields,
      ipAddress: ip,
    })
    await this.em.persistAndFlush(row)

    const fieldList = Object.entries(dto.fields).map(([k, v]) => `<li><strong>${escape(k)}</strong>: ${escape(v)}</li>`).join('')
    // Notify owner.
    await this.email.send({
      to: site.owner.email,
      subject: `New ${dto.type} submission on ${site.slug}`,
      html: `<p>You received a new ${dto.type} submission.</p><ul>${fieldList}</ul><p style="color:#666;font-size:12px">From IP ${ip || 'unknown'}${ua ? ` · ${escape(ua)}` : ''}</p>`,
      ccAdmin: true,
    })

    return { ok: true }
  }
}

@ApiTags('admin:inbox')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class FormsAdminController {
  constructor(
    @InjectRepository(FormSubmission) private readonly subs: EntityRepository<FormSubmission>,
    private readonly em: EntityManager,
    private readonly sites: SitesService,
  ) {}

  @Get(':id/submissions')
  async list(@Param('id') id: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const rows = await this.subs.find({ site: site.id }, { orderBy: { createdAt: 'desc' }, limit: 200 })
    return rows.map(r => ({ id: r.id, type: r.type, payload: r.payload, readAt: r.readAt, createdAt: r.createdAt }))
  }

  @Post(':id/submissions/:subId/read')
  async markRead(@Param('id') id: string, @Param('subId') subId: string, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const row = await this.subs.findOne({ id: subId, site: site.id })
    if (row && !row.readAt) {
      row.readAt = new Date()
      await this.em.persistAndFlush(row)
    }
    return { ok: true }
  }
}

function escape(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

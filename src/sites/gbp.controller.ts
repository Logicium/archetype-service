import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { IsBoolean, IsIn, IsObject, Equals } from 'class-validator'
import { Throttle } from '@nestjs/throttler'
import { SitesService } from './sites.service'
import { EmailService } from '../common/email.service'
import { brandedEmail, emailHeading } from '../common/email-template'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

/**
 * Google Business Profile onboarding requests from the admin Reviews page.
 *
 * Two modes:
 *  - 'setup'  — the owner has no business location yet; they answer a few
 *               questions and give us permission to create the profile,
 *               transfer ownership to them, and stay on as editors.
 *  - 'manage' — they already have a profile and want us to help manage it;
 *               they consent to adding us as an editor.
 *
 * Either way the request is emailed to the operator with the owner on
 * reply-to. No database rows: the mailbox is the queue.
 */
class GbpRequestDto {
  @IsIn(['setup', 'manage']) mode!: 'setup' | 'manage'
  @IsObject() fields!: Record<string, string>
  @IsBoolean() @Equals(true, { message: 'Consent is required' }) consent!: boolean
}

@ApiTags('admin:gbp')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class GbpController {
  constructor(
    private readonly sites: SitesService,
    private readonly email: EmailService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':id/gbp-request')
  async request(@Param('id') id: string, @Body() dto: GbpRequestDto, @Req() req: AuthRequest) {
    const site = await this.sites.getOwned(id, req.owner)
    const operator = process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || 'kisora@apotomelabs.com'

    const title = dto.mode === 'setup'
      ? `Google Business setup request — ${site.slug}`
      : `Google Business management request — ${site.slug}`
    const rows = Object.entries(dto.fields)
      .filter(([, v]) => v && String(v).trim())
      .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0">${esc(String(v))}</td></tr>`)
      .join('')

    await this.email.send({
      to: operator,
      replyTo: req.owner.email,
      subject: title,
      html: brandedEmail(
        `${emailHeading(title)}
         <p><strong>${esc(req.owner.email)}</strong> (site <strong>${esc(site.slug)}</strong>) submitted a
         ${dto.mode === 'setup' ? 'profile <strong>setup</strong>' : 'profile <strong>management</strong>'} request
         and consented to the terms of the help.</p>
         <table style="border-collapse:collapse;font-size:14px">${rows}</table>
         <p style="color:#666;font-size:12px">Mode: ${dto.mode} · Consent recorded ${new Date().toISOString()}</p>`,
      ),
    })

    return { ok: true }
  }
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

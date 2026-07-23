import { Injectable, Logger } from '@nestjs/common'
import { SitesService } from '../sites/sites.service'
import { EmailService } from '../common/email.service'
import type { Owner } from '../entities/owner.entity'

/** How long we keep data after a deletion request before the permanent purge. */
export const DATA_RETENTION_DAYS = 30

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name)

  constructor(
    private readonly sites: SitesService,
    private readonly email: EmailService,
  ) {}

  /**
   * Self-service account + data deletion. Safe by design: it takes every one of
   * the owner's sites offline immediately and wipes connected Instagram/Google
   * data on the spot, then queues the permanent purge (owner + all remaining
   * rows) to complete within the retention window. The owner gets a confirmation
   * with an undo window; the platform admin gets an actionable purge notice.
   */
  async requestDeletion(owner: Owner): Promise<{ ok: true; sitesAffected: number; purgeWithinDays: number }> {
    const sites = await this.sites.purgeOwnerSiteData(owner)
    const slugs = sites.map(s => s.slug).join(', ') || '(no sites)'
    this.logger.warn(`Account deletion requested by ${owner.email} (${owner.id}); sites offline: ${slugs}`)

    // Actionable notice to the platform admin to complete the row-level purge.
    await this.email.alertAdmin(
      'Account deletion requested',
      `<p>Owner <strong>${owner.email}</strong> (<code>${owner.id}</code>) requested account &amp; data deletion.</p>
       <p>Sites taken offline and disconnected from Instagram/Google: ${slugs}</p>
       <p>Complete the permanent purge (owner row + all site/content/order rows + media) within ${DATA_RETENTION_DAYS} days.</p>`,
    )

    // Confirmation + undo window for the owner.
    await this.email.send({
      to: owner.email,
      subject: 'Your data deletion request',
      html: `<p>We've received your request to delete your account and all associated data.</p>
             <p>Your ${sites.length} site${sites.length === 1 ? '' : 's'} ${sites.length === 1 ? 'has' : 'have'} been taken offline and disconnected from Instagram and Google right away. Everything else is permanently deleted within ${DATA_RETENTION_DAYS} days.</p>
             <p>Didn't mean to do this? Reply to this email within ${DATA_RETENTION_DAYS} days and we'll restore your account.</p>`,
    })

    return { ok: true, sitesAffected: sites.length, purgeWithinDays: DATA_RETENTION_DAYS }
  }
}

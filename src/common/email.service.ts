import { Injectable, Logger } from '@nestjs/common'
import * as nodemailer from 'nodemailer'

export interface MailMessage {
  to: string | string[]
  subject: string
  html: string
  /** When true, BCC the platform admin. */
  ccAdmin?: boolean
  /** Override the From header (e.g. send "personally" as the owner). */
  from?: string
  /** Where replies should land (e.g. the owner's business inbox). */
  replyTo?: string
}

/**
 * Centralised SMTP. Mirrors the pattern in `apotome-labs-service/src/services/email.service.ts`:
 * one `nodemailer.createTransport` reading EMAIL_HOST/PORT/USER/PASSWORD/FROM, with the platform
 * admin (ADMIN_EMAIL) CC'd on outbound owner mail when `ccAdmin` is set.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name)
  private transporter: nodemailer.Transporter

  constructor() {
    const port = parseInt(process.env.EMAIL_PORT || '587', 10)
    this.transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'localhost',
      port,
      secure: port === 465,
      auth: process.env.EMAIL_USER
        ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD || '' }
        : undefined,
    })
    this.transporter.verify(err => {
      if (err) this.logger.warn(`SMTP not ready: ${err.message}`)
      else this.logger.log('SMTP ready')
    })
  }

  async send(msg: MailMessage): Promise<boolean> {
    const admin = process.env.ADMIN_EMAIL || 'kisora@apotomelabs.com'
    try {
      await this.transporter.sendMail({
        from: msg.from || process.env.EMAIL_FROM || 'noreply@apotomelabs.com',
        to: msg.to,
        cc: msg.ccAdmin ? admin : undefined,
        replyTo: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
      })
      return true
    } catch (e) {
      this.logger.error(`Email send failed: ${(e as Error).message}`)
      return false
    }
  }

  /** Sends ONLY to admin (out-of-band alerts: failed provisioning, uptime down, etc.). */
  async alertAdmin(subject: string, html: string) {
    return this.send({ to: process.env.ADMIN_EMAIL || 'kisora@apotomelabs.com', subject: `[archetype] ${subject}`, html })
  }
}

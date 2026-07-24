/**
 * Lightweight branded HTML email shell. Inline styles only — email clients
 * strip <style>/<head>, so every rule lives on the element. Keep it simple and
 * table-free; the layout is a centered card that renders well from Gmail to
 * Apple Mail. Used by every transactional email the platform sends so they stop
 * looking like plaintext from a script.
 */

const INK = '#18181b'
const BODY = '#3f3f46'
const MUTED = '#a1a1aa'
const LINE = '#e4e4e7'
const ACCENT = '#6366f1'
const BG = '#f4f4f5'

export interface BrandedEmailOptions {
  /** Small preheader shown in the inbox preview line. */
  preheader?: string
  /** Footer note; defaults to the reply hint. */
  footNote?: string
}

/** Wrap inner body HTML in the branded card. */
export function brandedEmail(inner: string, opts: BrandedEmailOptions = {}): string {
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</div>`
    : ''
  const foot = opts.footNote ?? 'Apotome · Websites for every Trinidad business · Trinidad, Colorado'
  return `${preheader}<div style="background:${BG};padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
    <div style="padding:22px 32px;border-bottom:1px solid ${LINE};">
      <span style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:${INK};">Apotome</span>
      <span style="color:${MUTED};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;margin-left:10px;">Trinidad</span>
    </div>
    <div style="padding:30px 32px;color:${BODY};font-size:15px;line-height:1.65;">
      ${inner}
    </div>
    <div style="padding:20px 32px;border-top:1px solid ${LINE};color:${MUTED};font-size:12px;line-height:1.5;">
      ${foot}
    </div>
  </div>
</div>`
}

/** A prominent call-to-action button. */
export function emailButton(label: string, href: string): string {
  return `<a href="${href}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:9px;font-weight:600;font-size:14px;">${label}</a>`
}

/** A section heading inside the email body. */
export function emailHeading(text: string): string {
  return `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;font-weight:700;color:${INK};letter-spacing:-0.01em;">${text}</h1>`
}

/** A simple bulleted line-item table (label · value), e.g. an order summary. */
export function emailLineItems(rows: Array<{ label: string; value: string; strong?: boolean }>): string {
  const body = rows.map(r => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid ${LINE};color:${r.strong ? INK : BODY};font-weight:${r.strong ? 700 : 400};font-size:14px;">${r.label}</td>
      <td style="padding:8px 0;border-bottom:1px solid ${LINE};color:${r.strong ? INK : BODY};font-weight:${r.strong ? 700 : 500};font-size:14px;text-align:right;white-space:nowrap;">${r.value}</td>
    </tr>`).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;border-collapse:collapse;">${body}</table>`
}

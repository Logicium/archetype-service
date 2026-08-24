import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { lookup } from 'dns/promises'
import { isIP } from 'net'

/**
 * The browser. One place that knows how to start Chromium and what to do with
 * it, so the screenshot path and the PDF path cannot drift apart.
 *
 * This instance owns rendering for the studio's other services too: apotome
 * runs on a smaller container where Chromium is the one thing that reliably
 * gets it OOM-killed, so it calls here instead and keeps its local path only
 * as a fallback.
 */

export interface CaptureOptions {
  url: string
  width?: number
  height?: number
  deviceScaleFactor?: number
  isMobile?: boolean
  /** extra wait after network idle, for fonts and entry animations to settle */
  settleMs?: number
  fullPage?: boolean
  timeoutMs?: number
}

export interface PdfOptions {
  html: string
  format?: 'letter' | 'a4' | 'legal'
  printBackground?: boolean
  preferCSSPageSize?: boolean
  timeoutMs?: number
}

const MAX_TIMEOUT_MS = 45_000
const MAX_HTML_BYTES = 4 * 1024 * 1024

/**
 * Flags that matter most for memory on a small container.
 *  --single-process        renderer runs inside the browser process
 *  --no-zygote             no zygote launcher (required with single-process)
 *  --disable-dev-shm-usage use /tmp rather than a small /dev/shm
 *  --js-flags              cap V8 old-space so GC runs before Linux OOM-kills us
 */
const MEMORY_FLAGS = [
  '--single-process',
  '--no-zygote',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-accelerated-2d-canvas',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--hide-scrollbars',
  '--disable-web-security',
  '--js-flags=--max-old-space-size=192',
]

@Injectable()
export class RenderService {
  private readonly logger = new Logger(RenderService.name)
  private readonly useServerlessChromium = process.env.SCREENSHOT_USE_SERVERLESS_CHROMIUM === 'true'

  async launchBrowser() {
    if (this.useServerlessChromium) {
      const [chromiumMod, puppeteer] = await Promise.all([
        import('@sparticuz/chromium'),
        import('puppeteer-core'),
      ])
      const chromium = (chromiumMod.default ?? chromiumMod) as typeof chromiumMod.default
      chromium.setGraphicsMode = false
      const executablePath = await chromium.executablePath()
      const args = [...new Set([...chromium.args, ...MEMORY_FLAGS])]
      return puppeteer.launch({ args, executablePath, headless: true })
    }
    const puppeteer = await import('puppeteer')
    return puppeteer.launch({ headless: true, args: MEMORY_FLAGS })
  }

  async capturePng(opts: CaptureOptions): Promise<Buffer> {
    const width = opts.width ?? 1200
    const height = opts.height ?? 750
    const timeout = Math.min(opts.timeoutMs ?? 30_000, MAX_TIMEOUT_MS)

    this.logger.log(`Capturing ${opts.url} at ${width}x${height}`)
    let browser: Awaited<ReturnType<typeof this.launchBrowser>>
    try {
      browser = await this.launchBrowser()
    } catch (e) {
      throw new Error(
        `Failed to launch browser (${this.useServerlessChromium ? 'serverless' : 'bundled'}): ${(e as Error).message}`,
      )
    }
    try {
      const page = await browser.newPage()
      await page.setViewport({
        width,
        height,
        deviceScaleFactor: opts.deviceScaleFactor ?? 1,
        isMobile: opts.isMobile ?? false,
        hasTouch: opts.isMobile ?? false,
      })
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        const type = req.resourceType()
        // fonts are allowed through: a screenshot in fallback type is worse
        // than one that took a little longer
        if (['media', 'websocket', 'eventsource', 'manifest'].includes(type)) req.abort()
        else req.continue()
      })
      await page.goto(opts.url, { waitUntil: 'networkidle2', timeout })
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 800))
      return (await page.screenshot({
        type: 'png',
        fullPage: opts.fullPage ?? false,
        ...(opts.fullPage ? {} : { clip: { x: 0, y: 0, width, height } }),
      })) as Buffer
    } finally {
      await browser.close()
    }
  }

  async renderPdf(opts: PdfOptions): Promise<Buffer> {
    if (Buffer.byteLength(opts.html, 'utf8') > MAX_HTML_BYTES) {
      throw new BadRequestException('That document is too large to render.')
    }
    const timeout = Math.min(opts.timeoutMs ?? 30_000, MAX_TIMEOUT_MS)

    const browser = await this.launchBrowser()
    try {
      const page = await browser.newPage()
      /*
       * The document must be self-contained. `domcontentloaded` rather than
       * `networkidle0` because a page with no external requests never fires an
       * idle event and would sit here until the timeout.
       */
      await page.setContent(opts.html, { waitUntil: 'domcontentloaded', timeout })
      return (await page.pdf({
        format: opts.format ?? 'letter',
        printBackground: opts.printBackground ?? true,
        preferCSSPageSize: opts.preferCSSPageSize ?? true,
      })) as Buffer
    } finally {
      await browser.close()
    }
  }

  /**
   * Refuses a URL that would make this service fetch something on its own
   * network.
   *
   * The caller supplies an arbitrary URL and a browser here will happily load
   * it, so a leaked service key would otherwise be a read of the cloud
   * metadata endpoint at 169.254.169.254, which on most providers hands out
   * credentials. The guard limits who can call; this limits what they can
   * reach.
   */
  async assertPublicUrl(raw: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new BadRequestException('That is not a URL.')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Only http and https can be rendered.')
    }

    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
      throw new BadRequestException('That host cannot be rendered.')
    }

    const addresses = isIP(host) ? [host] : await this.resolve(host)
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new BadRequestException('That host cannot be rendered.')
      }
    }
  }

  private async resolve(host: string): Promise<string[]> {
    try {
      const records = await lookup(host, { all: true })
      return records.map((r) => r.address)
    } catch {
      throw new BadRequestException('That host could not be resolved.')
    }
  }
}

/** Loopback, link-local, and the RFC1918 / RFC4193 private ranges. */
function isPrivateAddress(address: string): boolean {
  const v = isIP(address)
  if (v === 4) {
    const [a, b] = address.split('.').map(Number)
    if (a === 127 || a === 0 || a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    // 169.254.0.0/16 is the cloud metadata range; this is the one that matters
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (v === 6) {
    const s = address.toLowerCase()
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fc') || s.startsWith('fd')) return true
    if (s.startsWith('fe80')) return true
    // ::ffff:a.b.c.d maps an IPv4 address into v6 and would otherwise slip past
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7))
    return false
  }
  return true
}

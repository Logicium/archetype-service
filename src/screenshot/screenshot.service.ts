import { Injectable, Logger } from '@nestjs/common'
import { put, del } from '@vercel/blob'
import { Site } from '../entities/site.entity'

/**
 * Captures a screenshot of a site's production URL using Puppeteer, uploads it
 * to Vercel Blob at a stable per-site path, and writes the resulting public URL
 * + capture timestamp back onto the Site entity.
 *
 * Captures are explicit triggers only — there is no read-through cache, no TTL,
 * no on-display capture. Callers decide when a new screenshot is warranted
 * (manual refresh, deploy READY, reprovision, customDomain change, staleness
 * threshold). The Site entity is the source of truth; the admin UI displays the
 * persisted public Blob URL directly via <img src>, so the backend never
 * streams screenshot bytes through Node.
 *
 * Browser layer:
 *  - @sparticuz/chromium + puppeteer-core when SCREENSHOT_USE_SERVERLESS_CHROMIUM=true.
 *    Set this on Render — its base image ships without system Chrome and the
 *    bundled puppeteer Chromium isn't reliably present.
 *  - Full puppeteer (bundled Chromium) for local dev.
 */
@Injectable()
export class ScreenshotService {
  private readonly logger = new Logger(ScreenshotService.name)
  private readonly useServerlessChromium: boolean
  /** Concurrent capture deduplication keyed by siteId. */
  private readonly inflight = new Map<string, Promise<void>>()

  constructor() {
    this.useServerlessChromium = process.env.SCREENSHOT_USE_SERVERLESS_CHROMIUM === 'true'
    this.logger.log(`Screenshot capture: chromium=${this.useServerlessChromium ? 'serverless (@sparticuz/chromium)' : 'bundled (puppeteer)'}`)
  }

  /** Stable, site-scoped path so URL drift / project renames don't orphan blobs. */
  private blobPath(siteId: string): string {
    return `screenshots/site-${siteId}.png`
  }

  /**
   * Returns true if `site.screenshotCapturedAt` is older than `staleAfterMs`
   * or missing entirely.
   */
  isStale(site: Site, staleAfterMs: number): boolean {
    if (!site.screenshotCapturedAt) return true
    return Date.now() - site.screenshotCapturedAt.getTime() > staleAfterMs
  }

  /**
   * Captures a fresh screenshot of `url` and persists the resulting public Blob
   * URL + timestamp on the Site entity. Caller is responsible for flushing the
   * entity to the database.
   *
   * Concurrent calls for the same site await the same capture so we never
   * fire two Puppeteer processes for the same site at once.
   */
  async captureForSite(site: Site, url: string, width = 1200, height = 750): Promise<void> {
    const existing = this.inflight.get(site.id)
    if (existing) return existing
    const promise = this.doCaptureForSite(site, url, width, height)
    this.inflight.set(site.id, promise)
    try {
      await promise
    } finally {
      this.inflight.delete(site.id)
    }
  }

  /** Deletes the persisted screenshot blob and clears the entity fields. */
  async deleteForSite(site: Site): Promise<void> {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        await del(this.blobPath(site.id), { token: process.env.BLOB_READ_WRITE_TOKEN })
      } catch (e) {
        this.logger.warn(`Blob delete failed for site ${site.id}: ${(e as Error).message}`)
      }
    }
    site.screenshotUrl = undefined
    site.screenshotCapturedAt = undefined
    site.screenshotSourceUrl = undefined
  }

  private async doCaptureForSite(site: Site, url: string, width: number, height: number): Promise<void> {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN is required to persist screenshots')
    }
    const png = await this.capturePng(url, width, height)
    const result = await put(this.blobPath(site.id), png, {
      access: 'public',
      contentType: 'image/png',
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
      allowOverwrite: true,
    })
    site.screenshotUrl = result.url
    site.screenshotCapturedAt = new Date()
    site.screenshotSourceUrl = url
  }

  private async launchBrowser() {
    // Flags that matter most for memory on a 512 MB container:
    //  --single-process   : renderer runs inside the browser process (no child spawns)
    //  --no-zygote        : disables the zygote launcher process (required with single-process)
    //  --disable-dev-shm-usage : use /tmp instead of /dev/shm (avoids OOM on small /dev/shm)
    //  --js-flags         : cap V8 old-space so GC runs before Linux OOM-kills the process
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

  private async capturePng(url: string, width: number, height: number): Promise<Buffer> {
    this.logger.log(`Capturing screenshot: ${url}`)
    let browser: Awaited<ReturnType<typeof this.launchBrowser>>
    try {
      browser = await this.launchBrowser()
    } catch (e) {
      throw new Error(`Failed to launch browser (${this.useServerlessChromium ? 'serverless' : 'bundled'}): ${(e as Error).message}`)
    }
    try {
      const page = await browser.newPage()
      await page.setViewport({ width, height })
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        const type = req.resourceType()
        if (['media', 'font', 'websocket', 'eventsource', 'manifest'].includes(type)) req.abort()
        else req.continue()
      })
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
      await new Promise(r => setTimeout(r, 800))
      return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } }) as Buffer
    } finally {
      await browser.close()
    }
  }
}

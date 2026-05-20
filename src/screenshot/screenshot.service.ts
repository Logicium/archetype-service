import { Injectable, Logger } from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

/**
 * Captures a screenshot of a URL using Puppeteer and caches the PNG to disk.
 * Cache TTL defaults to 1 hour; call `invalidate(url)` to force a fresh capture.
 */
@Injectable()
export class ScreenshotService {
  private readonly logger = new Logger(ScreenshotService.name)
  /** On-disk directory for cached screenshots */
  private readonly cacheDir: string
  /** How long (ms) a cached screenshot stays valid before a new capture */
  private readonly ttlMs: number
  /** In-flight capture promises, keyed by cacheKey, to de-duplicate concurrent requests */
  private readonly inflight = new Map<string, Promise<Buffer>>()

  constructor() {
    this.cacheDir = process.env.SCREENSHOT_CACHE_DIR ?? path.join(os.tmpdir(), 'ap-screenshots')
    this.ttlMs = Number(process.env.SCREENSHOT_TTL_HOURS ?? 1) * 60 * 60 * 1_000
    fs.mkdirSync(this.cacheDir, { recursive: true })
  }

  /** Returns a PNG Buffer for the given URL, serving from cache when fresh. */
  async capture(url: string, width = 1200, height = 750): Promise<Buffer> {
    const key = this.cacheKey(url, width, height)
    const file = path.join(this.cacheDir, `${key}.png`)
    const metaFile = path.join(this.cacheDir, `${key}.json`)

    // Serve from cache if still valid
    if (fs.existsSync(file) && fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { ts: number }
        if (Date.now() - meta.ts < this.ttlMs) {
          return fs.readFileSync(file)
        }
      } catch { /* ignore corrupt meta — just recapture */ }
    }

    // Deduplicate in-flight requests for the same key
    if (this.inflight.has(key)) {
      return this.inflight.get(key)!
    }

    const promise = this.doCapture(url, width, height, file, metaFile)
    this.inflight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(key)
    }
  }

  /** Deletes the cached file for a URL so the next request gets a fresh capture. */
  invalidate(url: string, width = 1200, height = 750) {
    const key = this.cacheKey(url, width, height)
    try { fs.unlinkSync(path.join(this.cacheDir, `${key}.png`)) } catch { /* ok */ }
    try { fs.unlinkSync(path.join(this.cacheDir, `${key}.json`)) } catch { /* ok */ }
  }

  private cacheKey(url: string, width: number, height: number): string {
    return crypto.createHash('sha256').update(`${url}|${width}|${height}`).digest('hex').slice(0, 24)
  }

  private async doCapture(url: string, width: number, height: number, file: string, metaFile: string): Promise<Buffer> {
    // Dynamic import so we don't blow up the module if puppeteer isn't installed
    let puppeteer: typeof import('puppeteer')
    try {
      puppeteer = await import('puppeteer')
    } catch {
      throw new Error('puppeteer is not installed. Run: npm install puppeteer')
    }

    this.logger.log(`Capturing screenshot: ${url}`)
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--hide-scrollbars',
        '--disable-web-security',
      ],
    })
    try {
      const page = await browser.newPage()
      await page.setViewport({ width, height })
      // Block analytics, ads, and tracking to speed up the capture
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        const type = req.resourceType()
        if (type === 'media' || type === 'font') {
          req.abort()
        } else {
          req.continue()
        }
      })
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
      // Small pause to let any CSS animations settle
      await new Promise(r => setTimeout(r, 800))
      const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } }) as Buffer
      fs.writeFileSync(file, png)
      fs.writeFileSync(metaFile, JSON.stringify({ ts: Date.now(), url, width, height }))
      return png
    } finally {
      await browser.close()
    }
  }
}

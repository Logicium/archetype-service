import { Injectable, Logger } from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { put, head, del } from '@vercel/blob'

/**
 * Captures a screenshot of a URL using Puppeteer and caches the PNG.
 *
 * Cache layer:
 *  - Vercel Blob when BLOB_READ_WRITE_TOKEN is set (survives Render restarts
 *    and works across multiple service instances).
 *  - On-disk tmp cache otherwise (local dev).
 *
 * Browser layer:
 *  - @sparticuz/chromium + puppeteer-core when SCREENSHOT_USE_SERVERLESS_CHROMIUM=true.
 *    Set this on Render — its base image ships without system Chrome and
 *    bundled puppeteer Chromium isn't reliably present.
 *  - Full puppeteer (bundled Chromium) for local dev.
 */
@Injectable()
export class ScreenshotService {
  private readonly logger = new Logger(ScreenshotService.name)
  private readonly cacheDir: string
  private readonly ttlMs: number
  private readonly useBlob: boolean
  private readonly useServerlessChromium: boolean
  private readonly inflight = new Map<string, Promise<Buffer>>()

  constructor() {
    this.cacheDir = process.env.SCREENSHOT_CACHE_DIR ?? path.join(os.tmpdir(), 'ap-screenshots')
    this.ttlMs = Number(process.env.SCREENSHOT_TTL_HOURS ?? 1) * 60 * 60 * 1_000
    this.useBlob = !!process.env.BLOB_READ_WRITE_TOKEN
    this.useServerlessChromium = process.env.SCREENSHOT_USE_SERVERLESS_CHROMIUM === 'true'
    if (!this.useBlob) fs.mkdirSync(this.cacheDir, { recursive: true })
    this.logger.log(`Screenshot cache: ${this.useBlob ? 'Vercel Blob' : `disk (${this.cacheDir})`}; chromium: ${this.useServerlessChromium ? 'serverless (@sparticuz/chromium)' : 'bundled (puppeteer)'}`)
  }

  /** Returns a PNG Buffer for the given URL, serving from cache when fresh. */
  async capture(url: string, width = 1200, height = 750): Promise<Buffer> {
    const key = this.cacheKey(url, width, height)
    const cached = await this.readCache(key)
    if (cached) return cached
    if (this.inflight.has(key)) return this.inflight.get(key)!
    const promise = this.doCapture(url, width, height, key)
    this.inflight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(key)
    }
  }

  /** Deletes the cached file for a URL so the next request gets a fresh capture. */
  async invalidate(url: string, width = 1200, height = 750): Promise<void> {
    const key = this.cacheKey(url, width, height)
    if (this.useBlob) {
      try { await del(this.blobPath(key), { token: process.env.BLOB_READ_WRITE_TOKEN }) } catch { /* ok */ }
      return
    }
    try { fs.unlinkSync(path.join(this.cacheDir, `${key}.png`)) } catch { /* ok */ }
    try { fs.unlinkSync(path.join(this.cacheDir, `${key}.json`)) } catch { /* ok */ }
  }

  private cacheKey(url: string, width: number, height: number): string {
    return crypto.createHash('sha256').update(`${url}|${width}|${height}`).digest('hex').slice(0, 24)
  }

  private blobPath(key: string): string {
    return `screenshots/${key}.png`
  }

  private async readCache(key: string): Promise<Buffer | null> {
    if (this.useBlob) {
      try {
        const meta = await head(this.blobPath(key), { token: process.env.BLOB_READ_WRITE_TOKEN })
        const uploadedAt = meta.uploadedAt ? new Date(meta.uploadedAt).getTime() : 0
        if (Date.now() - uploadedAt < this.ttlMs) {
          const r = await fetch(meta.url)
          if (r.ok) return Buffer.from(await r.arrayBuffer())
        }
      } catch { /* not found / fetch failed — recapture */ }
      return null
    }
    const file = path.join(this.cacheDir, `${key}.png`)
    const metaFile = path.join(this.cacheDir, `${key}.json`)
    if (!fs.existsSync(file) || !fs.existsSync(metaFile)) return null
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { ts: number }
      if (Date.now() - meta.ts < this.ttlMs) return fs.readFileSync(file)
    } catch { /* corrupt — recapture */ }
    return null
  }

  private async writeCache(key: string, png: Buffer, url: string, width: number, height: number): Promise<void> {
    if (this.useBlob) {
      try {
        await put(this.blobPath(key), png, {
          access: 'public',
          contentType: 'image/png',
          token: process.env.BLOB_READ_WRITE_TOKEN,
          addRandomSuffix: false,
          allowOverwrite: true,
        })
      } catch (e) {
        this.logger.warn(`Blob write failed for ${key}: ${(e as Error).message}`)
      }
      return
    }
    fs.writeFileSync(path.join(this.cacheDir, `${key}.png`), png)
    fs.writeFileSync(path.join(this.cacheDir, `${key}.json`), JSON.stringify({ ts: Date.now(), url, width, height }))
  }

  private async launchBrowser() {
    if (this.useServerlessChromium) {
      const [chromium, puppeteer] = await Promise.all([
        import('@sparticuz/chromium').then(m => m.default),
        import('puppeteer-core'),
      ])
      const executablePath = await chromium.executablePath()
      return puppeteer.launch({
        args: [...chromium.args, '--hide-scrollbars', '--disable-web-security'],
        executablePath,
        headless: true,
      })
    }
    const puppeteer = await import('puppeteer')
    return puppeteer.launch({
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
  }

  private async doCapture(url: string, width: number, height: number, key: string): Promise<Buffer> {
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
        if (type === 'media' || type === 'font') req.abort()
        else req.continue()
      })
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
      await new Promise(r => setTimeout(r, 800))
      const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } }) as Buffer
      await this.writeCache(key, png, url, width, height)
      return png
    } finally {
      await browser.close()
    }
  }
}

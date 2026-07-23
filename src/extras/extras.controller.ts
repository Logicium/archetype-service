import { BadRequestException, Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { put } from '@vercel/blob'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { SitesService } from '../sites/sites.service'

interface CopyDto { field: string; prompt: string; context?: Record<string, unknown> }
interface ScanMenuDto { contentType: string; base64: string }

interface ScannedMenu {
  categories: Array<{ name: string; description?: string; items: Array<{ name: string; description?: string; price?: string }> }>
}

@ApiTags('admin:ai')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class AiController {
  private readonly gemini: GoogleGenerativeAI | null
  constructor(private readonly sites: SitesService) {
    this.gemini = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/ai/copy')
  async generate(@Param('id') id: string, @Req() req: AuthRequest, @Body() dto: CopyDto) {
    await this.sites.getOwned(id, req.owner)
    if (!this.gemini) throw new BadRequestException('AI not configured (GEMINI_API_KEY missing)')
    const sys = `You write tight, warm marketing copy for small Trinidad, Colorado businesses. Respond with 3 distinct options separated by "---". Stay under 60 words per option for blurbs, under 12 for taglines. Output only the options, nothing else.`
    const user = `Field: ${dto.field}\nBrief: ${dto.prompt}\nKnown site context: ${JSON.stringify(dto.context ?? {}, null, 2).slice(0, 2000)}`
    const model = this.gemini.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: sys,
      generationConfig: { temperature: 0.8 },
    })
    const res = await model.generateContent(user)
    const text = res.response.text() ?? ''
    return { options: text.split(/\n?---\n?/).map(s => s.trim()).filter(Boolean) }
  }

  /**
   * Vision: read a photo of a printed menu into structured categories + items.
   * Text only — the model transcribes what's on the page, it does not invent
   * dishes. Returns strict JSON that the admin merges into the menu editor.
   */
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post(':id/ai/scan-menu')
  async scanMenu(@Param('id') id: string, @Req() req: AuthRequest, @Body() dto: ScanMenuDto): Promise<ScannedMenu> {
    await this.sites.getOwned(id, req.owner)
    if (!this.gemini) throw new BadRequestException('AI not configured (GEMINI_API_KEY missing)')
    if (!dto?.base64) throw new BadRequestException('Missing image')
    if (!/^image\//.test(dto.contentType || '')) throw new BadRequestException('Expected an image')
    // ~10MB base64 ceiling to keep the request within model limits.
    if (dto.base64.length > 14_000_000) throw new BadRequestException('Image too large (max ~10MB)')

    const sys = [
      'You transcribe photographs of restaurant menus into structured JSON.',
      'Read ONLY what is printed on the menu — never invent dishes, prices, or descriptions.',
      'Group items under their printed section headings (e.g. "Small plates", "Tacos", "Drinks").',
      'If a section heading is unclear, use a sensible short name.',
      'Prices: keep the currency symbol as printed (e.g. "$12", "12.00"). Omit price if none is shown.',
      'Descriptions: copy the printed description verbatim if present; otherwise omit it.',
      'Respond with ONLY minified JSON matching exactly:',
      '{"categories":[{"name":string,"description"?:string,"items":[{"name":string,"description"?:string,"price"?:string}]}]}',
      'No markdown, no code fences, no commentary.',
    ].join('\n')

    const model = this.gemini.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: sys,
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    })

    let raw = ''
    try {
      const res = await model.generateContent([
        { inlineData: { data: dto.base64, mimeType: dto.contentType } },
        { text: 'Transcribe this menu into the required JSON.' },
      ])
      raw = res.response.text() ?? ''
    } catch {
      throw new BadRequestException('Could not read that image. Try a clearer, well-lit photo.')
    }

    return sanitizeScannedMenu(raw)
  }
}

/** Parse + defensively clamp the model's JSON so a malformed reply can never
    break the editor. Returns empty categories rather than throwing. */
function sanitizeScannedMenu(raw: string): ScannedMenu {
  let parsed: unknown
  try {
    // Strip stray code fences the model may add despite instructions.
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    return { categories: [] }
  }
  const src = (parsed as { categories?: unknown })?.categories
  if (!Array.isArray(src)) return { categories: [] }
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const categories = src.slice(0, 40).map((cat) => {
    const c = cat as Record<string, unknown>
    const items = Array.isArray(c.items) ? c.items : []
    return {
      name: str(c.name, 80),
      description: str(c.description, 300) || undefined,
      items: items.slice(0, 120).map((it) => {
        const i = it as Record<string, unknown>
        return {
          name: str(i.name, 120),
          description: str(i.description, 400) || undefined,
          price: str(i.price, 24) || undefined,
        }
      }).filter(i => i.name),
    }
  }).filter(c => c.name && c.items.length)
  return { categories }
}

@ApiTags('admin:media')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites')
export class MediaController {
  constructor(private readonly sites: SitesService) {}

  /** Upload base64-encoded image to Vercel Blob and return the public URL. */
  @Post(':id/media')
  async upload(@Param('id') id: string, @Req() req: AuthRequest, @Body() body: { filename: string; contentType: string; base64: string }) {
    const site = await this.sites.getOwned(id, req.owner)
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new BadRequestException('Media uploads not configured')
    if (!body.base64) throw new BadRequestException('Missing base64')
    const buf = Buffer.from(body.base64, 'base64')
    if (buf.length > 25 * 1024 * 1024) throw new BadRequestException('Max 25MB')
    const key = `sites/${site.slug}/${Date.now()}-${body.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const blob = await put(key, buf, { access: 'public', contentType: body.contentType, token: process.env.BLOB_READ_WRITE_TOKEN })
    return { url: blob.url }
  }
}

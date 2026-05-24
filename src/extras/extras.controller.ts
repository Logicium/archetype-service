import { BadRequestException, Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { put } from '@vercel/blob'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { SitesService } from '../sites/sites.service'

interface CopyDto { field: string; prompt: string; context?: Record<string, unknown> }

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
    if (buf.length > 8 * 1024 * 1024) throw new BadRequestException('Max 8MB')
    const key = `sites/${site.slug}/${Date.now()}-${body.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const blob = await put(key, buf, { access: 'public', contentType: body.contentType, token: process.env.BLOB_READ_WRITE_TOKEN })
    return { url: blob.url }
  }
}

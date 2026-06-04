import { Injectable, Logger } from '@nestjs/common'
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { SuggestDto } from './ai.controller'

const MODEL = 'gemini-2.5-flash'

/** Human-readable field descriptions used to shape the prompt */
const FIELD_PROMPTS: Record<string, string> = {
  tagline:              'a punchy one-liner tagline (≤10 words) for the business',
  blurb:                'a 1–2 sentence elevator pitch describing what the business does and why it matters',
  storyParagraph:       'one natural, conversational paragraph for the About/Story section',
  'service.description':'a one-sentence description of the named service that emphasises the benefit to the customer',
  'room.blurb':         'a one-sentence selling description of the named hotel room',
  'product.blurb':      'a punchy one-line selling description of the named product',
  'menuItem.description':'a short, appetising description of the named menu item (1–2 sentences)',
  'event.blurb':        'a one-sentence selling description of the named live event that conveys mood and what audiences will experience',
  'series.blurb':       'a one-sentence description of the named recurring program / event series',
  'performer.bio':      'a 1–2 sentence neutral bio for the named performer or company suitable for a venue listing',
  'capability.value':   'a concrete, credibility-building value for the business stat (e.g. "15+" or "Licensed & Insured")',
}

const ARCHETYPE_CONTEXT: Record<string, string> = {
  mesa:      'restaurant or food & beverage business',
  hearth:    'bed & breakfast or boutique lodging',
  vault:     'retail or e-commerce shop',
  marquee:   'events-focused business or organization — music venue, local band, art gallery, festival, community event space, comedy club, etc.',
  keystone:  'trades or professional-services business (plumber, electrician, contractor, etc.)',
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name)
  private readonly genAI: GoogleGenerativeAI | null

  constructor() {
    const key = process.env.GEMINI_API_KEY
    this.genAI = key ? new GoogleGenerativeAI(key) : null
    if (!key) this.logger.warn('GEMINI_API_KEY not set — AI suggestions disabled')
  }

  async suggest(dto: SuggestDto): Promise<{ text: string }> {
    if (!this.genAI) return { text: '' }

    const businessType = ARCHETYPE_CONTEXT[dto.archetype] || 'small business'
    const fieldDesc    = FIELD_PROMPTS[dto.field] || `copy for the "${dto.field}" field`

    const contextLines = Object.entries(dto.context ?? {})
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n')

    const prompt = [
      `You are a concise copywriter helping a ${businessType} owner build their website.`,
      `Business name: "${dto.brand || 'the business'}"`,
      contextLines ? `Additional context:\n${contextLines}` : '',
      `Write ${fieldDesc}.`,
      `Reply with ONLY the requested copy — no quotes, no labels, no commentary.`,
    ].filter(Boolean).join('\n')

    try {
      const model  = this.genAI.getGenerativeModel({ model: MODEL })
      const result = await model.generateContent(prompt)
      const text   = result.response.text().trim()
      return { text }
    } catch (err) {
      this.logger.error('Gemini suggest failed', err)
      return { text: '' }
    }
  }
}

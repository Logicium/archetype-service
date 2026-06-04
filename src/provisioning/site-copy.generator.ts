/**
 * SiteCopyGenerator — at provisioning time, asks Gemini to fill the
 * "wordy" fields of the SiteContent payload (tagline, blurb, story
 * paragraphs, descriptions for menu items / rooms / products / services)
 * using whatever the buyer supplied in the wizard as context.
 *
 * It NEVER overwrites wizard input — the provisioner merges layers in
 * the order: archetype defaults < AI copy < wizard input.
 *
 * If GEMINI_API_KEY is unset, the generator returns `{}` and the
 * provisioner falls back to defaults + wizard input only.
 */
import { Injectable, Logger } from '@nestjs/common'
import { AiService } from '../ai/ai.service'

type AnyRec = Record<string, unknown>
type Archetype = 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone'

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v : fallback
}

function asArr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function asRec(v: unknown): AnyRec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : {}
}

@Injectable()
export class SiteCopyGenerator {
  private readonly logger = new Logger(SiteCopyGenerator.name)

  constructor(private readonly ai: AiService) {}

  /**
   * Returns a partial SiteContent overlay generated from wizard inputs.
   * Safe to call even if Gemini is disabled — returns `{}` in that case.
   */
  async generate(archetype: Archetype, wizardConfig: AnyRec): Promise<AnyRec> {
    const brand = asStr(wizardConfig.brand)
    // Wizard didn't even name the business — nothing meaningful for AI to do.
    if (!brand) return {}

    const baseCtx: Record<string, string> = {
      brand,
      archetype,
      existingTagline: asStr(wizardConfig.tagline),
      existingBlurb: asStr(wizardConfig.blurb),
    }

    const overlay: AnyRec = {}

    // Tagline + blurb run in parallel — they're cheap and independent.
    const [tagline, blurb] = await Promise.all([
      asStr(wizardConfig.tagline) ? Promise.resolve('') : this.suggest(archetype, brand, 'tagline', baseCtx),
      asStr(wizardConfig.blurb) ? Promise.resolve('') : this.suggest(archetype, brand, 'blurb', baseCtx),
    ])
    if (tagline) overlay.tagline = tagline
    if (blurb) overlay.blurb = blurb

    // Story paragraphs — generate one if missing.
    const story = asRec(wizardConfig.story)
    const existingParas = asArr<string>(story.paragraphs).filter(p => asStr(p))
    if (existingParas.length === 0) {
      const para = await this.suggest(archetype, brand, 'storyParagraph', baseCtx)
      if (para) overlay.story = { paragraphs: [para] }
    }

    // Per-archetype list descriptions — only fill items the buyer named but didn't describe.
    if (archetype === 'mesa') {
      const filled = await this.fillItemList(
        asArr<AnyRec>(asRec(wizardConfig.menu).categories),
        'items', 'menuItem.description', archetype, brand, baseCtx,
      )
      if (filled) overlay.menu = { categories: filled }
    } else if (archetype === 'hearth') {
      const filled = await this.fillFlatList(
        asArr<AnyRec>(wizardConfig.rooms),
        'blurb', 'room.blurb', archetype, brand, baseCtx,
      )
      if (filled) overlay.rooms = filled
    } else if (archetype === 'vault') {
      const filled = await this.fillFlatList(
        asArr<AnyRec>(wizardConfig.featured),
        'blurb', 'product.blurb', archetype, brand, baseCtx,
      )
      if (filled) overlay.featured = filled
    } else if (archetype === 'keystone') {
      const filled = await this.fillFlatList(
        asArr<AnyRec>(wizardConfig.services),
        'description', 'service.description', archetype, brand, baseCtx,
      )
      if (filled) overlay.services = filled
    } else if (archetype === 'marquee') {
      const events = await this.fillFlatList(
        asArr<AnyRec>(wizardConfig.events),
        'blurb', 'event.blurb', archetype, brand, baseCtx,
      )
      if (events) overlay.events = events
      const series = await this.fillFlatList(
        asArr<AnyRec>(wizardConfig.series),
        'blurb', 'series.blurb', archetype, brand, baseCtx,
      )
      if (series) overlay.series = series
      const performers = await this.fillFlatList(
        asArr<AnyRec>(wizardConfig.performers),
        'bio', 'performer.bio', archetype, brand, baseCtx,
      )
      if (performers) overlay.performers = performers
    }

    return overlay
  }

  /** Fill a missing `descField` on each item that has a name but no description. */
  private async fillFlatList(
    items: AnyRec[],
    descField: string,
    promptField: string,
    archetype: Archetype,
    brand: string,
    baseCtx: Record<string, string>,
  ): Promise<AnyRec[] | null> {
    const named = items.filter(i => asStr(i.name) && !asStr(i[descField]))
    if (named.length === 0) return null
    // Cap parallelism to keep provisioning latency bounded.
    const out = items.map(i => ({ ...i }))
    await Promise.all(
      out.map(async (item, idx) => {
        if (!asStr(item.name) || asStr(item[descField])) return
        const text = await this.suggest(archetype, brand, promptField, { ...baseCtx, name: asStr(item.name) })
        if (text) out[idx][descField] = text
      }),
    )
    return out
  }

  /** Fill descriptions on nested {categories: [{items: []}]} structures (menus). */
  private async fillItemList(
    categories: AnyRec[],
    nestedKey: string,
    promptField: string,
    archetype: Archetype,
    brand: string,
    baseCtx: Record<string, string>,
  ): Promise<AnyRec[] | null> {
    if (categories.length === 0) return null
    const out = categories.map(c => ({
      ...c,
      [nestedKey]: asArr<AnyRec>(c[nestedKey]).map(i => ({ ...i })),
    }))
    let didAnything = false
    await Promise.all(
      out.flatMap(cat =>
        (cat[nestedKey] as AnyRec[]).map(async (item) => {
          if (!asStr(item.name) || asStr(item.description)) return
          const text = await this.suggest(archetype, brand, promptField, {
            ...baseCtx,
            name: asStr(item.name),
            category: asStr(cat.name),
          })
          if (text) { item.description = text; didAnything = true }
        }),
      ),
    )
    return didAnything ? out : null
  }

  private async suggest(
    archetype: string, brand: string, field: string, context: Record<string, string>,
  ): Promise<string> {
    try {
      const { text } = await this.ai.suggest({ archetype, brand, field, context })
      return asStr(text)
    } catch (e) {
      this.logger.warn(`AI suggest failed for field=${field}: ${(e as Error).message}`)
      return ''
    }
  }
}

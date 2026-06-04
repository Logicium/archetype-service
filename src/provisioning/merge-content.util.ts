/**
 * Deep-merge utility used by the provisioner to layer:
 *
 *   archetype defaults  <  AI-generated copy  <  wizard input
 *
 * The right-most argument wins. Objects merge recursively; arrays and
 * primitives are replaced wholesale by the later layer (except when the
 * later layer is an empty string / empty array — see `isMeaningful`).
 *
 * "Empty" wizard fields don't clobber defaults, so a buyer who skipped
 * the photos section still gets the placeholder pictures.
 */
type AnyRec = Record<string, unknown>

function isPlainObject(v: unknown): v is AnyRec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

function isMeaningful(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (isPlainObject(v)) return Object.values(v).some(isMeaningful)
  return true
}

export function mergeContent<T extends AnyRec>(...layers: Array<AnyRec | undefined | null>): T {
  const out: AnyRec = {}
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue
    for (const [k, v] of Object.entries(layer)) {
      if (!isMeaningful(v)) continue
      const prev = out[k]
      if (isPlainObject(prev) && isPlainObject(v)) {
        out[k] = mergeContent(prev, v)
      } else {
        out[k] = v
      }
    }
  }
  return out as T
}

/**
 * Compute a flat summary of the differences between two content payloads.
 * Returns a deduped list of dotted leaf paths whose values changed, plus a
 * grand total. Arrays are diffed by index; objects are walked recursively.
 *
 * Intended only for change-log display in the admin "version history" panel —
 * never for storage. Keep cheap and order-stable.
 */
export interface ContentDiff {
  paths: string[]
  count: number
}

const MAX_PATHS = 12

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function walk(prev: unknown, next: unknown, prefix: string, out: string[]): void {
  if (out.length > MAX_PATHS * 4) return // hard cap on traversal
  if (prev === next) return

  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
    for (const k of keys) walk(prev[k], next[k], prefix ? `${prefix}.${k}` : k, out)
    return
  }

  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) { out.push(prefix || '(root)'); return }
    for (let i = 0; i < prev.length; i++) walk(prev[i], next[i], `${prefix}[${i}]`, out)
    return
  }

  // Leaf value differs (or types diverge).
  out.push(prefix || '(root)')
}

export function diffContent(prev: unknown, next: unknown): ContentDiff {
  const raw: string[] = []
  walk(prev, next, '', raw)
  // Collapse `foo[0].bar`, `foo[1].bar` style entries to `foo[*].bar` once,
  // and dedupe identical paths.
  const dedup = new Set<string>()
  for (const p of raw) dedup.add(p.replace(/\[\d+\]/g, '[*]'))
  const paths = Array.from(dedup).slice(0, MAX_PATHS)
  return { paths, count: dedup.size }
}

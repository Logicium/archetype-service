/**
 * Resolves the public, internet-reachable platform API URL that gets baked into
 * every provisioned child site's VITE_CONTENT_API (.env.production + Vercel env).
 * Prefers DEPLOYED_CONTENT_API_URL so local dev can keep PUBLIC_BASE_URL pointed
 * at localhost without breaking deployed sites. Throws on missing/localhost URLs
 * so we fail loudly instead of silently shipping a broken site.
 */
export function resolveDeployedContentApiUrl(): string {
  const override = process.env.DEPLOYED_CONTENT_API_URL?.trim()
  const base = (override || process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!base) {
    throw new Error('Cannot resolve platform API URL: set DEPLOYED_CONTENT_API_URL (preferred) or PUBLIC_BASE_URL.')
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(base)) {
    throw new Error(`Refusing to use localhost API URL (${base}) for deployed sites. Set DEPLOYED_CONTENT_API_URL to your public platform API (e.g. Render URL).`)
  }
  return base.endsWith('/v1') ? base : `${base}/v1`
}

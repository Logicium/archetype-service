import type { MealOrder } from '../entities/meal-order.entity'
import type { PosConfig, PosProvider as PosProviderId, Site } from '../entities/site.entity'

/** Tokens as returned by a vendor's OAuth token endpoint, normalised. */
export interface PosTokens {
  accessToken: string
  refreshToken?: string
  /** Absolute expiry; undefined means the vendor issues non-expiring tokens. */
  accessTokenExpiresAt?: Date
  refreshTokenExpiresAt?: Date
  merchantId?: string
}

/** What a POS adapter must implement. Adding Square/Toast means adding one of
 *  these and registering it — nothing else in the app changes. */
export interface PosAdapter {
  readonly id: PosProviderId
  readonly label: string

  /** True when the server has the credentials this vendor needs. */
  isConfigured(): boolean

  /** Where to send the owner's browser to authorise us. */
  authorizeUrl(state: string, redirectUri: string): string

  /** Trade the callback's `code` for tokens. */
  exchangeCode(code: string, redirectUri: string, query: Record<string, string>): Promise<PosTokens>

  /** Swap a refresh token for a fresh access token. Omit when unsupported. */
  refresh?(refreshToken: string): Promise<PosTokens>

  /** Fetch the merchant's display name, best-effort (undefined on failure). */
  fetchMerchantName?(tokens: { accessToken: string; merchantId: string }): Promise<string | undefined>

  /**
   * Create the order in the POS and, when `print` is set, fire the vendor's
   * print event so a kitchen ticket comes out. Returns the POS order id.
   */
  pushOrder(args: {
    accessToken: string
    merchantId: string
    order: MealOrder
    site: Site
    config: Required<PosConfig>
    print: boolean
  }): Promise<{
    posOrderId: string
    /** False when the order reached the POS but the ticket did not print. */
    printed: boolean
    /** Why printing failed, when it did. */
    printError?: string
  }>
}

/** Thrown when a vendor rejects our credentials, so the caller can mark the
 *  connection as needing re-authorisation rather than retrying forever. */
export class PosAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PosAuthError'
  }
}

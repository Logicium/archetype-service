import type { ShopConfig } from '../entities/site.entity'

export const DEFAULT_SHOP_CONFIG: Required<ShopConfig> = {
  currency: 'USD',
  fulfillment: ['pickup'],
  pickupInstructions: '',
  shippingFlatCents: 0,
  notifyEmail: '',
}

export function resolveShopConfig(override?: ShopConfig | null): Required<ShopConfig> {
  return {
    currency: override?.currency ?? DEFAULT_SHOP_CONFIG.currency,
    fulfillment: override?.fulfillment?.length ? override.fulfillment : DEFAULT_SHOP_CONFIG.fulfillment,
    pickupInstructions: override?.pickupInstructions ?? DEFAULT_SHOP_CONFIG.pickupInstructions,
    shippingFlatCents: override?.shippingFlatCents ?? DEFAULT_SHOP_CONFIG.shippingFlatCents,
    notifyEmail: override?.notifyEmail ?? DEFAULT_SHOP_CONFIG.notifyEmail,
  }
}

import type { PosConfig } from '../entities/site.entity'

export const DEFAULT_POS_CONFIG: Required<PosConfig> = {
  autoSend: true,
  autoPrint: true,
  titlePrefix: 'ONLINE',
}

export function resolvePosConfig(override?: PosConfig | null): Required<PosConfig> {
  if (!override) return DEFAULT_POS_CONFIG
  return {
    autoSend: override.autoSend ?? DEFAULT_POS_CONFIG.autoSend,
    autoPrint: override.autoPrint ?? DEFAULT_POS_CONFIG.autoPrint,
    titlePrefix: override.titlePrefix ?? DEFAULT_POS_CONFIG.titlePrefix,
  }
}

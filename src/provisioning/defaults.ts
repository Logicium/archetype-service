/**
 * Loader for the per-archetype default SiteContent payloads bundled with
 * the service. These are merged UNDER any wizard-supplied or AI-generated
 * fields so newly provisioned sites look filled in (placeholder photos,
 * stock copy, sample menu/rooms/products) instead of completely empty.
 */
import mesa from './defaults/mesa.json'
import hearth from './defaults/hearth.json'
import vault from './defaults/vault.json'
import marquee from './defaults/marquee.json'
import keystone from './defaults/keystone.json'

type AnyRec = Record<string, unknown>
type Archetype = 'mesa' | 'hearth' | 'vault' | 'marquee' | 'keystone'

const DEFAULTS: Record<Archetype, AnyRec> = {
  mesa: mesa as AnyRec,
  hearth: hearth as AnyRec,
  vault: vault as AnyRec,
  marquee: marquee as AnyRec,
  keystone: keystone as AnyRec,
}

export function getArchetypeDefaults(archetype: Archetype): AnyRec {
  // Clone so callers can mutate freely.
  return JSON.parse(JSON.stringify(DEFAULTS[archetype] ?? {}))
}

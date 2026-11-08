import type { Stone, StoneSpec } from './model'

// LAYERS. Every stone and cut line belongs to a layer, and the layer owns the
// stone size, fill stone size and colours its objects are generated with.
// Before layers those four values were one global setting shared by the
// Stones/Fill panels, the Add tool and the "re-stone the last text" machinery,
// so changing the size to add a second graphic re-stoned the first one, and
// a project could not say "SS10 lettering, SS16 border" without the operator
// juggling the dropdown between every step.
//
// Stones keep their own `size`/`color` (the cut pipeline, BOM and old projects
// all read them); the layer is the setting new stones are made with, and
// changing it re-stones/recolours what is already on the layer.
export interface Layer {
  id: number
  name: string
  size: string // outline stone size key into the size table
  fillSize: string // fill stone size key
  color: string // outline stone display colour
  fillColor: string
  visible: boolean // hidden layers are not drawn, picked or cut
  locked: boolean // locked layers are drawn and cut but cannot be selected
}

// Stones and vectors saved before layers carry no `lay`; they live here.
export const BASE_LAYER = 1

export const layerOf = (s: { lay?: number }): number => s.lay ?? BASE_LAYER

const DEFAULT_OUTLINE = '#85d653'
const DEFAULT_FILL = '#7ec8e3'

export function makeLayer(id: number, name: string, from?: Partial<Layer>): Layer {
  return {
    id,
    name,
    size: from?.size ?? 'SS6',
    fillSize: from?.fillSize ?? 'SS6',
    color: from?.color ?? DEFAULT_OUTLINE,
    fillColor: from?.fillColor ?? DEFAULT_FILL,
    visible: true,
    locked: false,
  }
}

export const nextLayerId = (layers: Layer[]) => layers.reduce((m, l) => Math.max(m, l.id), 0) + 1

export function nextLayerName(layers: Layer[]): string {
  const taken = new Set(layers.map((l) => l.name))
  for (let n = layers.length + 1; ; n++) if (!taken.has(`Layer ${n}`)) return `Layer ${n}`
}

const mostCommon = (xs: string[]): string | undefined => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  let best: string | undefined
  for (const [k, n] of m) if (best === undefined || n > (m.get(best) ?? 0)) best = k
  return best
}

// Resolve a project's layer list: saved layers win; any layer id a stone or
// vector still points at but the list lacks is recreated so nothing on the
// board is orphaned; a project saved before layers gets one layer carrying
// its old global stone/fill sizes (read off the stones) and colours.
export function resolveLayers(
  saved: Layer[] | undefined,
  stones: Stone[],
  vectors: { lay?: number }[],
  sizes: Record<string, StoneSpec>,
  ctx: { outlineColor?: string; fillColor?: string },
): Layer[] {
  const out: Layer[] = (saved ?? []).map((l) => ({ ...l }))
  const have = new Set(out.map((l) => l.id))
  const fallbackSize = sizes.SS6 ? 'SS6' : Object.keys(sizes)[0]
  const sizeOr = (k: string | undefined) => (k && sizes[k] ? k : fallbackSize)
  for (const l of out) { l.size = sizeOr(l.size); l.fillSize = sizeOr(l.fillSize) }
  const referenced = new Set<number>()
  for (const s of stones) referenced.add(layerOf(s))
  for (const v of vectors) referenced.add(layerOf(v))
  if (!out.length) referenced.add(BASE_LAYER)
  for (const id of [...referenced].sort((a, b) => a - b)) {
    if (have.has(id)) continue
    const mine = stones.filter((s) => layerOf(s) === id)
    out.push(makeLayer(id, id === BASE_LAYER && !out.length ? 'Layer 1' : nextLayerName(out), {
      size: sizeOr(mostCommon(mine.filter((s) => (s.layer ?? 'outline') === 'outline').map((s) => s.size))),
      fillSize: sizeOr(mostCommon(mine.filter((s) => s.layer === 'fill').map((s) => s.size))),
      color: ctx.outlineColor,
      fillColor: ctx.fillColor,
    }))
    have.add(id)
  }
  return out.sort((a, b) => a.id - b.id)
}

const isColor = (x: unknown) => typeof x === 'string' && /^#[\da-f]{6}$/i.test(x)

// Shape check for a saved layer list (project files are untrusted input).
export function validLayers(x: unknown): x is Layer[] {
  if (!Array.isArray(x) || x.length > 64) return false
  const ids = new Set<number>()
  for (const l of x) {
    if (!l || typeof l !== 'object') return false
    const o = l as Record<string, unknown>
    if (!Number.isSafeInteger(o.id) || (o.id as number) < 1 || ids.has(o.id as number)) return false
    ids.add(o.id as number)
    if (typeof o.name !== 'string' || o.name.length > 64) return false
    if (typeof o.size !== 'string' || typeof o.fillSize !== 'string') return false
    if (!isColor(o.color) || !isColor(o.fillColor)) return false
    if (typeof o.visible !== 'boolean' || typeof o.locked !== 'boolean') return false
  }
  return true
}

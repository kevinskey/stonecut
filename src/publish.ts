// Publish a finished design to TShirt Brothers.
//
// StoneCut has no backend of its own. A design that's done here still has to
// reach the shop: into the TSB art library so it can be dropped onto a
// garment in the Design Studio and sent to a customer as a mockup, and into
// the rhinestone tables so the real stone BOM — not a square-inch guess —
// drives the quote.
//
// Auth is a shared key (STONECUT_PUBLISH_KEY on the TSB server) kept in
// localStorage, because StoneCut runs on rhinestones.tshirtbrothers.com with
// no TSB session to borrow.

import type { Stone, StoneSpec } from './model'
import { drawGem, drawGlint } from './sim'

const KEY_STORAGE = 'stonecut_tsb_key'
const API_STORAGE = 'stonecut_tsb_api'
const DEFAULT_API = 'https://tshirtbrothers.com'

export const getPublishKey = () => localStorage.getItem(KEY_STORAGE) || ''
export const setPublishKey = (k: string) => localStorage.setItem(KEY_STORAGE, k.trim())
// Overridable so the app can be pointed at a dev server without a rebuild.
export const getApiBase = () => (localStorage.getItem(API_STORAGE) || DEFAULT_API).replace(/\/+$/, '')
export const setApiBase = (u: string) => localStorage.setItem(API_STORAGE, u.trim())

export interface BomRow { size: string; color: string; n: number; stoneMm: number }

// The stone's own diameter, falling back to a hole-derived estimate the same
// way the canvas and the garment mockup do — so the preview shows what the
// customer will see rather than the oversized template hole.
const stoneRadiusMm = (sizes: Record<string, StoneSpec>, s: Stone) =>
  (sizes[s.size]?.stoneMm || (sizes[s.size]?.holeMm ?? 3) * 0.85) / 2

/* Render the stones to a transparent PNG, cropped to the design's own bounds
 * with a small margin. Deliberately independent of the editor's zoom/pan:
 * the published preview must look the same no matter how the board happened
 * to be framed when Doc hit publish. */
export function renderPreviewPng(
  stones: Stone[],
  sizes: Record<string, StoneSpec>,
  colorOf: (s: Stone) => string,
  opts: { pxPerMm?: number; marginMm?: number; maxPx?: number } = {},
): { dataUrl: string; widthMm: number; heightMm: number } {
  if (stones.length === 0) throw new Error('nothing to publish — the design has no stones')

  const marginMm = opts.marginMm ?? 4
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of stones) {
    const r = stoneRadiusMm(sizes, s)
    minX = Math.min(minX, s.x - r)
    minY = Math.min(minY, s.y - r)
    maxX = Math.max(maxX, s.x + r)
    maxY = Math.max(maxY, s.y + r)
  }
  const widthMm = maxX - minX + marginMm * 2
  const heightMm = maxY - minY + marginMm * 2

  // Cap the long edge so a 14in design doesn't produce a 20MB base64 body.
  const maxPx = opts.maxPx ?? 1600
  const pxPerMm = Math.min(opts.pxPerMm ?? 8, maxPx / Math.max(widthMm, heightMm))

  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(widthMm * pxPerMm))
  cv.height = Math.max(1, Math.round(heightMm * pxPerMm))
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('could not get a 2D canvas context')

  // Faceted gems + a glint pass — this PNG is what every TSB surface shows
  // (Design Studio art panel, customer mockups, /bling), so it has to read
  // as rhinestones, not flat dots.
  for (const s of stones) {
    const r = stoneRadiusMm(sizes, s) * pxPerMm
    const x = (s.x - minX + marginMm) * pxPerMm
    const y = (s.y - minY + marginMm) * pxPerMm
    drawGem(ctx, x, y, r, colorOf(s))
  }
  for (let i = 0; i < stones.length; i++) {
    const h = (i * 2654435761) >>> 0
    if (h % 100 >= 6) continue
    const s = stones[i]
    const r = stoneRadiusMm(sizes, s) * pxPerMm
    const x = (s.x - minX + marginMm) * pxPerMm
    const y = (s.y - minY + marginMm) * pxPerMm
    drawGlint(ctx, x, y, r * (1.5 + ((h >>> 8) % 100) / 90))
  }

  return { dataUrl: cv.toDataURL('image/png'), widthMm, heightMm }
}

/* Fraction of the design's bounding box actually occupied by stone area.
 * Feeds the high-coverage upcharge: dense fills take longer to brush and
 * need a firmer press. Clamped to 1 because overlapping stones (which
 * StoneCut allows across elements) can otherwise sum past 100%. */
export function coverageOf(
  stones: Stone[],
  sizes: Record<string, StoneSpec>,
  widthMm: number,
  heightMm: number,
): number {
  const area = widthMm * heightMm
  if (!(area > 0) || stones.length === 0) return 0
  let stoneArea = 0
  for (const s of stones) {
    const r = stoneRadiusMm(sizes, s)
    stoneArea += Math.PI * r * r
  }
  return Math.min(1, stoneArea / area)
}

export interface PublishResult {
  design: { id: number; slug: string; stone_count: number }
  artLibraryId: number
}

export async function publishToTsb(payload: {
  name: string
  previewBase64: string
  svg?: string
  widthMm: number
  heightMm: number
  coverage: number
  stoneBom: BomRow[]
  tags?: string[]
  featured?: boolean
}): Promise<PublishResult> {
  const key = getPublishKey()
  if (!key) throw new Error('no publish key set — add it under File ▸ TSB publish key')

  const res = await fetch(`${getApiBase()}/api/rhinestone/designs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-stonecut-key': key },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    // 401/403 almost always means a stale key, which is worth saying plainly
    // instead of surfacing a bare status code.
    if (res.status === 401 || res.status === 403) {
      throw new Error('TSB rejected the publish key — re-enter it under File ▸ TSB publish key')
    }
    const text = await res.text().catch(() => '')
    throw new Error(`TSB returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  return res.json()
}

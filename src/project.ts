import type { Stone, StoneSpec, Pt, MaterialPreset } from './model'
import { mergeSavedSizes } from './model'
import { validateConditions } from './preflight'
export interface TextMeta { text: string; fontName: string; fontId: string; weight: 'bold' | 'regular'; height: number; spacing: number; bend: number }
export interface Recipe { contours: Pt[][]; mode: 'outline' | 'fill' | 'both'; wholeWord: boolean; sx: number; sy: number; textMeta?: TextMeta }
export type Elements = Record<number, Recipe>
export interface VecItem { id: number; name: string; base: Pt[][]; baseW: number; baseH: number; x: number; y: number; s: number }
export interface CutterProfile { format: 'gpgl' | 'hpgl'; gpStep: number; originCorner: 'bl' | 'br'; sendConditions: boolean; swapAxes: boolean; wCircles: boolean; overcut: number; preset: MaterialPreset; linePreset: MaterialPreset }
export interface ProjectContext { boardWIn: number; boardHIn: number; placement: 'design' | 'artboard'; margin: number; gap: number; outlineColor: string; fillColor: string; boardColor: string | null; garmentColor: string; frameOn?: boolean; frameMm?: number; cutter: CutterProfile }
export interface Project { v: 1 | 2; stones: Stone[]; sizes: Record<string, StoneSpec>; elements: Elements; vectors: VecItem[]; context?: ProjectContext; lastText?: { el: number; fontName: string; text: string; height: number; spacing: number; bend: number } }
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e7
const positive = (x: unknown): x is number => finite(x) && x > 0
const color = (x: unknown) => typeof x === 'string' && /^#[\da-f]{6}$/i.test(x)
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Invalid project: ${message}`) }
export function parseProject(data: unknown): Project {
  requireValue(obj(data), 'expected a design object')
  requireValue(data.v === undefined || data.v === 1 || data.v === 2, 'unsupported file version')
  requireValue(Array.isArray(data.stones) || Array.isArray(data.vectors), 'no design geometry')
  const stones = data.stones ?? [], vectors = data.vectors ?? []
  requireValue(Array.isArray(stones) && stones.length <= 250000 && Array.isArray(vectors) && vectors.length <= 10000, 'too many objects')
  requireValue(data.sizes === undefined || obj(data.sizes), 'invalid size table')
  for (const key of Object.keys(data.sizes ?? {})) requireValue(/^[a-zA-Z0-9_ -]{1,64}$/.test(key) && !['__proto__','constructor','prototype'].includes(key), 'invalid size name')
  for (const spec of Object.values(data.sizes ?? {})) requireValue(obj(spec) && positive(spec.holeMm) && (spec.stoneMm === undefined || positive(spec.stoneMm)), 'invalid stone/hole diameter')
  const sizes = mergeSavedSizes(data.sizes)
  for (const spec of Object.values(sizes)) requireValue(positive(spec.holeMm) && positive(spec.stoneMm), 'invalid resolved stone size')
  for (const s of stones) requireValue(obj(s) && finite(s.x) && finite(s.y) && typeof s.size === 'string' && sizes[s.size] && (s.color === undefined || color(s.color)) && (s.el === undefined || Number.isSafeInteger(s.el)) && (s.layer === undefined || s.layer === 'fill' || s.layer === 'outline'), 'invalid stone coordinates, size, or color')
  let points = 0
  const paths = (value: unknown) => {
    requireValue(Array.isArray(value), 'invalid contours')
    for (const p of value) {
      requireValue(Array.isArray(p), 'invalid path')
      points += p.length
      requireValue(points <= 2000000 && p.every((q) => obj(q) && finite(q.x) && finite(q.y)), 'invalid or excessive path points')
    }
  }
  const ids = new Set()
  for (const v of vectors) {
    requireValue(obj(v) && Number.isSafeInteger(v.id) && !ids.has(v.id) && typeof v.name === 'string' && finite(v.x) && finite(v.y) && positive(v.s) && finite(v.baseW) && v.baseW >= 0 && finite(v.baseH) && v.baseH >= 0, 'invalid vector object')
    ids.add(v.id); paths(v.base)
  }
  requireValue(data.elements === undefined || obj(data.elements), 'invalid elements')
  for (const [key, r] of Object.entries(data.elements ?? {})) {
    requireValue(Number.isSafeInteger(+key) && obj(r) && positive(r.sx) && positive(r.sy) && (r.mode === undefined || ['outline', 'fill', 'both'].includes(String(r.mode))), 'invalid editable element')
    paths(r.contours)
    if (r.textMeta !== undefined) {
      const m = r.textMeta
      requireValue(obj(m) && typeof m.text === 'string' && typeof m.fontName === 'string' && typeof m.fontId === 'string' && ['bold', 'regular'].includes(String(m.weight)) && positive(m.height) && finite(m.spacing) && finite(m.bend), 'invalid editable text')
    }
  }
  if (data.context !== undefined) {
    const c = data.context
    requireValue(obj(c) && positive(c.boardWIn) && c.boardWIn <= 60 && positive(c.boardHIn) && c.boardHIn <= 60 && ['design', 'artboard'].includes(String(c.placement)) && finite(c.margin) && c.margin >= 0 && finite(c.gap) && c.gap >= 0 && color(c.outlineColor) && color(c.fillColor) && (c.boardColor === null || color(c.boardColor)) && color(c.garmentColor), 'invalid project settings')
    requireValue((c.frameOn === undefined || typeof c.frameOn === 'boolean') && (c.frameMm === undefined || (positive(c.frameMm) && c.frameMm <= 100)), 'invalid weeding frame settings')
    const p = c.cutter
    requireValue(obj(p) && ['gpgl', 'hpgl'].includes(String(p.format)) && [10,20,40,100].includes(Number(p.gpStep)) && ['bl','br'].includes(String(p.originCorner)) && ['sendConditions','swapAxes','wCircles'].every((k) => typeof p[k] === 'boolean') && finite(p.overcut) && p.overcut >= 0 && p.overcut <= 3, 'invalid saved cutter profile')
    requireValue(obj(p.preset) && obj(p.linePreset) && typeof p.preset.name === 'string' && typeof p.linePreset.name === 'string', 'invalid saved material')
    validateConditions(p.preset as unknown as MaterialPreset); validateConditions(p.linePreset as unknown as MaterialPreset)
  }
  if (data.lastText !== undefined) {
    const t = data.lastText
    requireValue(obj(t) && Number.isSafeInteger(t.el) && typeof t.text === 'string' && typeof t.fontName === 'string' && positive(t.height) && finite(t.spacing) && finite(t.bend), 'invalid last-text recipe')
  }
  const elements = Object.fromEntries(Object.entries(data.elements ?? {}).map(([k,r]) => [k, { ...(r as Record<string, unknown>), mode: (r as Record<string, unknown>).mode ?? 'outline', wholeWord: !!(r as Record<string, unknown>).wholeWord }]))
  return { ...data, v: data.v ?? 1, stones, sizes, elements, vectors } as Project
}

export async function readProjectFileText(file: Pick<File, 'size' | 'text'>): Promise<string> {
  if (file.size > 50 * 1024 * 1024) throw new Error('Project files must be smaller than 50 MB')
  return file.text()
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type opentype from 'opentype.js'
import { DEFAULT_PRESETS, DEFAULT_SIZES, isLegacyPreset, mergeSavedSizes } from './model'
import type { MaterialPreset, Pt, Stone, StoneSpec } from './model'
import { SpacingIndex, bareFrac, capGaps, debugSpans, debugStones, spinedWidths, fillByGlyph, fillStones, offsetRows, outlineOrSpine, pointInPoly, rasterizeContours } from './fill'
import { arcContours, loadFontFile, parseFontBuffer, textToContours } from './text'
import { findOverlaps } from './geometry'
import { splitContoursIntoLetters } from './contours'
import { offsetPaths } from './offset'
import { grantedCutter } from './usb'
import { distToPaths, parseSvgToPaths, pathsToD } from './vector'
import { booleanPaths } from './boolean'
import type { BoolOp } from './boolean'
import { deleteFont, getFont, listFonts, saveFont } from './fontstore'
import { DESIGN_EXT, ensureWritable, fsSupported, pickOpenHandle, pickSaveHandle, recallHandle, rememberHandle, writeHandle } from './filesys'
import type { FSFileHandle } from './filesys'
import { analyzeImage, imageToColorLayers, imageToCutContours, imageToRaster } from './image'
import type { ColorLayer, ImageAnalysis } from './image'
import { download, gpglTestShape, placementGuideHtml, stoneBom, toDXF, toGPGL, toHPGL, toSVG, workOrderHtml } from './export'
import { coverageOf, getPublishKey, publishToTsb, renderPreviewPng, setPublishKey } from './publish'
import type { OriginCorner } from './export'
import { SHAPE_NAMES, shapeToContours } from './shapes'
import { MOCKUP_W, drawGem, drawMockup, drawMockupEmpty, drawMockupPhoto } from './sim'
import { detectText } from './ocr'
import type { DetectedText } from './ocr'
import { MenuBar } from './MenuBar'
import type { Menu } from './MenuBar'
import type { ShapeKind } from './shapes'
import { sendToCutter } from './usb'
import './App.css'

type Tool = 'select' | 'add' | 'node' | 'pen'
type StoneMode = 'outline' | 'fill' | 'both'
// What a committed design was generated FROM, kept so it can be re-stoned
// at another size. Contours are normalised to a (0,0) top-left corner at
// the scale they were generated; sx/sy is the scale the element is at now.
// Resizing never scales holes: the contours are scaled and the stones are
// laid out again at the panel's current stone size and spacing.
interface TextMeta { text: string; fontName: string; fontId: string; weight: 'bold' | 'regular'; height: number; spacing: number; bend: number }
interface Recipe { contours: Pt[][]; mode: StoneMode; wholeWord: boolean; sx: number; sy: number; textMeta?: TextMeta }
type Elements = Record<number, Recipe>
// A vector cut: an imported SVG flattened to mm polylines. `base` is the
// file's geometry normalised to (0,0); x/y/s place and scale it on the board.
// These are cut as LINES (pen down along the path), not as stone holes.
interface VecItem { id: number; name: string; base: Pt[][]; baseW: number; baseH: number; x: number; y: number; s: number }
const vecPaths = (v: VecItem): Pt[][] => v.base.map((p) => p.map((q) => ({ x: q.x * v.s + v.x, y: q.y * v.s + v.y })))
const vecBox = (v: VecItem) => ({ minX: v.x, minY: v.y, maxX: v.x + v.baseW * v.s, maxY: v.y + v.baseH * v.s })
const normaliseContours = (contours: Pt[][]): Pt[][] => {
  let minX = Infinity, minY = Infinity
  for (const c of contours) for (const q of c) { if (q.x < minX) minX = q.x; if (q.y < minY) minY = q.y }
  if (!isFinite(minX)) return contours
  return contours.map((c) => c.map((q) => ({ x: q.x - minX, y: q.y - minY })))
}

// splitContoursIntoLetters moved to contours.ts — shared with arc text.

// Rotate points by `rad` around `center` — used when baking rotation into
// cut-line objects (holes are circles, so stone rotation is exact too).
const rotatePt = (q: Pt, center: Pt, rad: number): Pt => {
  const cos = Math.cos(rad), sin = Math.sin(rad)
  const dx = q.x - center.x, dy = q.y - center.y
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos }
}

const DEFAULT_MARGIN = 5 // mm standoff around design in exports; set per-job in the Cut panel

// template-integrity floor (sticky flock ~0.5-1.2mm edge gap) regardless of
// how wide the design spacing is set
const hardGapOf = (spacing: number) => Math.max(0.5, Math.min(spacing, 1.2))

// Font-picker rows show each family IN its own face. A row loads its font
// only when scrolled into view, and the Google CSS request carries
// `text=<family name>` so the served woff2 contains just those glyphs —
// a few KB — which is what makes previewing a 1,900-font catalog viable.
const previewLoaded = new Set<string>()
function ensureGooglePreview(family: string) {
  if (previewLoaded.has(family)) return
  previewLoaded.add(family)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}&text=${encodeURIComponent(family)}&display=swap`
  document.head.appendChild(link)
}
async function ensureCustomPreview(family: string) {
  const key = `custom:${family}`
  if (previewLoaded.has(key)) return
  previewLoaded.add(key)
  try {
    const buf = await getFont(family)
    if (!buf) return
    const face = new FontFace(family, buf)
    await face.load()
    document.fonts.add(face)
  } catch {
    // preview only — the row just stays in the UI font
  }
}
function FontPreviewName({ family, custom }: { family: string; custom: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [ready, setReady] = useState(() => previewLoaded.has(custom ? `custom:${family}` : family))
  useEffect(() => {
    const el = ref.current
    if (!el || ready) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        if (custom) void ensureCustomPreview(family).then(() => setReady(true))
        else { ensureGooglePreview(family); setReady(true) }
      },
      { root: el.closest('.fontlist'), rootMargin: '150px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [family, custom, ready])
  return (
    <span ref={ref} className="fname" style={ready ? { fontFamily: `'${family}'` } : undefined}>
      {family}
    </span>
  )
}

// Illustrator-style glyphs for the Align / Pathfinder buttons.
function AlignIcon({ kind }: { kind: string }) {
  const c = 'currentColor'
  const box = (x: number, y: number, w: number, h: number, fill = c, op = 1) => <rect x={x} y={y} width={w} height={h} fill={fill} fillOpacity={op} rx={1} />
  const line = (x1: number, y1: number, x2: number, y2: number) => <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={1.5} />
  let body: React.ReactNode
  switch (kind) {
    case 'left': body = <>{line(3, 2, 3, 18)}{box(5, 4, 10, 4)}{box(5, 11, 6, 4)}</>; break
    case 'hcenter': body = <>{line(10, 2, 10, 18)}{box(4, 4, 12, 4)}{box(6, 11, 8, 4)}</>; break
    case 'right': body = <>{line(17, 2, 17, 18)}{box(5, 4, 10, 4)}{box(9, 11, 6, 4)}</>; break
    case 'top': body = <>{line(2, 3, 18, 3)}{box(4, 5, 4, 10)}{box(11, 5, 4, 6)}</>; break
    case 'vcenter': body = <>{line(2, 10, 18, 10)}{box(4, 4, 4, 12)}{box(11, 6, 4, 8)}</>; break
    case 'bottom': body = <>{line(2, 17, 18, 17)}{box(4, 5, 4, 10)}{box(11, 9, 4, 6)}</>; break
    case 'dist-h': body = <>{box(2, 6, 3, 8)}{box(8.5, 6, 3, 8)}{box(15, 6, 3, 8)}</>; break
    case 'dist-v': body = <>{box(6, 2, 8, 3)}{box(6, 8.5, 8, 3)}{box(6, 15, 8, 3)}</>; break
    case 'space-h': body = <>{line(2, 2, 2, 18)}{line(18, 2, 18, 18)}{box(5, 6, 3, 8)}{box(12, 6, 3, 8)}</>; break
    case 'space-v': body = <>{line(2, 2, 18, 2)}{line(2, 18, 18, 18)}{box(6, 5, 8, 3)}{box(6, 12, 8, 3)}</>; break
    case 'unite': body = <>{box(3, 3, 9, 9)}{box(8, 8, 9, 9)}</>; break
    case 'minus': body = <>{box(3, 3, 9, 9)}{box(8, 8, 9, 9, '#12151c')}<rect x={8} y={8} width={9} height={9} fill="none" stroke={c} strokeWidth={1.2} /></>; break
    case 'intersect': body = <><rect x={3} y={3} width={9} height={9} fill="none" stroke={c} strokeWidth={1.2} /><rect x={8} y={8} width={9} height={9} fill="none" stroke={c} strokeWidth={1.2} />{box(8, 8, 4, 4)}</>; break
    case 'exclude': body = <>{box(3, 3, 9, 9)}{box(8, 8, 9, 9)}{box(8, 8, 4, 4, '#12151c')}</>; break
    default: body = null
  }
  return <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">{body}</svg>
}

function Section({ title, defaultOpen = false, children }: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  return (
    <details className="sec" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="sec-body">{children}</div>
    </details>
  )
}

// Saved presets win (the operator's tuned numbers), but any built-in preset
// missing from the saved list is added, so new manufacturer entries show up
// in a browser that already has a saved list. Built-in metadata (group,
// blade, note) is refreshed on saved entries of the same name.
function loadPresets(): MaterialPreset[] {
  try {
    const raw = localStorage.getItem('stonecut.presets')
    if (raw) {
      const saved = JSON.parse(raw) as MaterialPreset[]
      if (Array.isArray(saved) && saved.length) {
        const byName = new Map(DEFAULT_PRESETS.map((d) => [d.name, d]))
        const merged: MaterialPreset[] = saved.map((p): MaterialPreset => {
          const d = byName.get(p.name)
          if (d && isLegacyPreset(p)) return d
          return d ? { ...d, ...p, group: d.group, blade: d.blade, note: d.note } : { ...p, group: p.group ?? 'My presets' }
        })
        const have = new Set(merged.map((p) => p.name))
        for (const d of DEFAULT_PRESETS) if (!have.has(d.name)) merged.push(d)
        return merged
      }
    }
  } catch { /* fall through */ }
  return DEFAULT_PRESETS
}

// Maximum cutting width per CE6000 model (Graphtec datasheet: 375 / 603 /
// 1213 mm). The board is the LOADED media, so these only seed the width.
const PLOTTERS: { id: string; name: string; cutIn: number }[] = [
  { id: 'ce6000-40', name: 'CE6000-40', cutIn: 14.75 },
  { id: 'ce6000-60', name: 'CE6000-60', cutIn: 23.75 },
  { id: 'ce6000-120', name: 'CE6000-120', cutIn: 47.75 },
]

// Zoom is px per mm. 100% = the design at true size on a 96-dpi screen.
const PX_PER_MM_100 = 96 / 25.4
const ZOOM_MIN = 0.4
const ZOOM_MAX = 40

// The design itself (stones + the size table they index) is saved to the
// browser so a refresh, a crash, or a closed tab does not wipe the work.
// Settings were always saved; the stones were the one thing that was not.
const DESIGN_KEY = 'stonecut.design'
type SavedLastText = { el: number; fontName: string; text: string; height: number; spacing: number; bend: number }
function loadDesign(): { stones: Stone[]; sizes: Record<string, StoneSpec>; elements: Elements; vectors: VecItem[]; lastText?: SavedLastText } | null {
  try {
    const raw = localStorage.getItem(DESIGN_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (!Array.isArray(d?.stones) && !Array.isArray(d?.vectors)) return null
    const stones = ((d.stones ?? []) as Stone[]).filter((s) => typeof s?.x === 'number' && typeof s?.y === 'number' && typeof s?.size === 'string')
    const sizes = mergeSavedSizes(d.sizes)
    const elements: Elements = {}
    if (d.elements && typeof d.elements === 'object')
      for (const [k, r] of Object.entries(d.elements as Record<string, Recipe>))
        if (Array.isArray(r?.contours) && typeof r.sx === 'number' && typeof r.sy === 'number')
          elements[+k] = {
            contours: r.contours, mode: r.mode ?? 'outline', wholeWord: !!r.wholeWord, sx: r.sx, sy: r.sy,
            textMeta: r.textMeta && typeof r.textMeta.text === 'string' ? r.textMeta : undefined,
          }
    const vectors: VecItem[] = Array.isArray(d.vectors)
      ? (d.vectors as VecItem[]).filter((v) => Array.isArray(v?.base) && typeof v.x === 'number' && typeof v.s === 'number')
      : []
    const lastText: SavedLastText | undefined =
      d.lastText && typeof d.lastText.el === 'number' && typeof d.lastText.text === 'string'
        ? { el: d.lastText.el, fontName: String(d.lastText.fontName ?? ''), text: d.lastText.text, height: +d.lastText.height, spacing: +d.lastText.spacing, bend: +d.lastText.bend || 0 }
        : undefined
    return { stones, sizes, elements, vectors, lastText }
  } catch {
    return null
  }
}

// Lrisy wholesale rhinestone range (lrisy.com/collections/wholesale-rhinestones-bulk,
// pulled 2026-10-25) — their catalog color names with hexes approximated
// from the product photos. The picker stays free-form; these are presets.
const LRISY_COLORS: { n: string; c: string }[] = [
  { n: 'Crystal (Silver White)', c: '#e9eef5' },
  { n: 'AB Crystal Iridescent', c: '#d8e6f5' },
  { n: 'Snow Opal', c: '#f4f6ef' },
  { n: 'Black Pearl', c: '#23262e' },
  { n: 'Jet Black', c: '#0d0d10' },
  { n: 'Grey', c: '#9aa0a8' },
  { n: 'Deep Blue', c: '#1d3f8f' },
  { n: 'Dream Blue AB', c: '#9cc4f0' },
  { n: 'Light Blue (Aquamarine)', c: '#7ec8e3' },
  { n: 'Blue Purple', c: '#5a4fcf' },
  { n: 'Purple', c: '#7a3fa8' },
  { n: 'Emerald Green', c: '#0e7a4f' },
  { n: 'Grass Green', c: '#4caf50' },
  { n: 'Olive Green', c: '#708238' },
  { n: 'Pacific Opal', c: '#a7d8c9' },
  { n: 'Lemon Yellow', c: '#f7e04b' },
  { n: 'Yellow Gold', c: '#e8b923' },
  { n: 'Gold', c: '#d4af37' },
  { n: 'Khaki', c: '#b9a37e' },
  { n: 'Champagne Pink', c: '#efc9b8' },
  { n: 'Pink Opal', c: '#f4b8c8' },
  { n: 'Gold Pink', c: '#e89bb0' },
  { n: 'Fuchsia (Rose Pink)', c: '#d81b7f' },
  { n: 'Rose Red', c: '#c21e56' },
  { n: 'American Red', c: '#c8102e' },
  { n: 'Orange Red', c: '#e2502b' },
  { n: 'Brown', c: '#6b4a2f' },
]
// Catalog name for a hex: exact palette match, else the nearest palette
// color within a tolerant RGB distance (marked ≈), else the raw hex.
function colorName(hex: string): string {
  const h = hex.toLowerCase()
  const exact = LRISY_COLORS.find((s) => s.c === h)
  if (exact) return exact.n
  const rgb = (x: string) => [parseInt(x.slice(1, 3), 16), parseInt(x.slice(3, 5), 16), parseInt(x.slice(5, 7), 16)]
  if (!/^#[0-9a-f]{6}$/.test(h)) return hex
  const [r, g, b] = rgb(h)
  let best: { n: string; d: number } | null = null
  for (const s of LRISY_COLORS) {
    const [r2, g2, b2] = rgb(s.c)
    const d = Math.hypot(r - r2, g - g2, b - b2)
    if (!best || d < best.d) best = { n: s.n, d }
  }
  return best && best.d < 60 ? `≈ ${best.n}` : hex
}
function Swatches({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }} title="Lrisy stone colors">
      {LRISY_COLORS.map((s) => (
        <button
          key={s.c}
          title={s.n}
          onClick={() => onPick(s.c)}
          style={{
            width: 18, height: 18, padding: 0, flex: 'none', borderRadius: '50%', background: s.c,
            border: value.toLowerCase() === s.c ? '2px solid #fff' : '1px solid #444c5e', cursor: 'pointer',
          }}
        />
      ))}
    </div>
  )
}

export default function App() {
  const savedDesign = useRef(loadDesign())
  const [stones, setStones] = useState<Stone[]>(() => savedDesign.current?.stones ?? [])
  const stonesRef = useRef<Stone[]>([])
  // last image commit — while untouched, generation-setting changes REGENERATE
  // it in place instead of only affecting the next add
  const lastImageRef = useRef<{ file: File; offsetY: number; before: Stone[]; after: Stone[]; el?: number } | null>(null)
  // The last text commit, so stone-setting changes can regenerate it in
  // place while its text is untouched (same idea as the image regen).
  // Persisted with the design and rehydrated when the font comes back:
  // losing it across a reload meant the first setting change popped a
  // duplicate preview below the restored design instead of re-stoning it.
  const lastTextRef = useRef<{ el: number; font: unknown; fontName: string; text: string; height: number; spacing: number; bend: number } | null>(null)
  // element ids continue past whatever the saved design used
  const elSeq = useRef((savedDesign.current?.stones ?? []).reduce((m, s) => Math.max(m, s.el ?? 0), 0) + 1)
  // Undo/redo can resurrect stones whose ids are above elSeq (File -> Open
  // rewinds it to the opened file's max), so a bare elSeq.current++ could
  // hand out an id that is already on the board — the new commit would then
  // move as one unit with that element. Always step past the live board.
  const nextEl = useCallback(() => {
    let m = elSeq.current
    for (const st of stonesRef.current) if (st.el != null && st.el >= m) m = st.el + 1
    elSeq.current = m + 1
    return m
  }, [])
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [sizes, setSizes] = useState<Record<string, StoneSpec>>(() => savedDesign.current?.sizes ?? { ...DEFAULT_SIZES })
  const [elements, setElements] = useState<Elements>(() => savedDesign.current?.elements ?? {})
  const elementsRef = useRef<Elements>(elements)
  elementsRef.current = elements
  const [vectors, setVectors] = useState<VecItem[]>(() => savedDesign.current?.vectors ?? [])
  const vectorsRef = useRef<VecItem[]>(vectors)
  vectorsRef.current = vectors
  const vecSeq = useRef((savedDesign.current?.vectors ?? []).reduce((m, v) => Math.max(m, v.id), 0) + 1)
  // Selected cut-line objects (several at once: shift-click, marquee).
  const [selVecs, setSelVecs] = useState<Set<number>>(() => new Set())
  // Save the design shortly after it stops changing (drags fire many updates).
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (stones.length || vectors.length) {
          // only keep recipes for elements that still have stones
          const live = new Set(stones.map((st) => st.el))
          const kept: Elements = {}
          for (const [k, r] of Object.entries(elements)) if (live.has(+k)) kept[+k] = r
          const lt = lastTextRef.current
          const lastText =
            lt && live.has(lt.el)
              ? { el: lt.el, fontName: lt.fontName, text: lt.text, height: lt.height, spacing: lt.spacing, bend: lt.bend }
              : undefined
          localStorage.setItem(DESIGN_KEY, JSON.stringify({ v: 1, stones, sizes, elements: kept, vectors, lastText }))
        } else localStorage.removeItem(DESIGN_KEY)
      } catch (e) {
        console.error('[stonecut] could not save design', e)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [stones, sizes, elements, vectors])
  const [curSize, setCurSize] = useState('SS6')
  const [gap, setGap] = useState(0.8) // min edge-to-edge gap between holes, mm
  const [tool, setTool] = useState<Tool>('select')
  const [addSize, setAddSize] = useState<'auto' | string>('auto') // stone size for manual adds
  const [outlineDesign, setOutlineDesign] = useState<'single' | 'double' | 'ghost' | 'centerline'>('single')
  const [strokePolicy, setStrokePolicy] = useState<'auto' | 'walls'>('auto')
  const [uniformRhythm, setUniformRhythm] = useState(true)
  const [canEcho, setCanEcho] = useState(true)
  const [fillStyle, setFillStyle] = useState<'grid' | 'brick' | 'concentric' | 'radial'>('brick')
  const [fillSize, setFillSize] = useState('SS6')
  const [fillColor, setFillColor] = useState('#7ec8e3')
  const [outlineColor, setOutlineColor] = useState('#85d653')
  const [echoUpsize, setEchoUpsize] = useState<number | null>(null)
  const outlineStyle: 'auto' | 'walls' | 'centerline' =
    outlineDesign === 'centerline' ? 'centerline' : strokePolicy
  const [zoom, setZoom] = useState(6) // px per mm
  // artboard: the physical sheet, sized in true inches (1in = 25.4mm)
  const [boardWIn, setBoardWIn] = useState(() => +(localStorage.getItem('stonecut.boardW') ?? 12))
  const [boardHIn, setBoardHIn] = useState(() => +(localStorage.getItem('stonecut.boardH') ?? 12))
  useEffect(() => { localStorage.setItem('stonecut.boardW', String(boardWIn)) }, [boardWIn])
  useEffect(() => { localStorage.setItem('stonecut.boardH', String(boardHIn)) }, [boardHIn])
  // artboard colour = the loaded material's colour, so stone colours are
  // judged against the flock/vinyl they'll sit on. null = the default
  // subtle translucent board.
  const [boardColor, setBoardColor] = useState<string | null>(() => localStorage.getItem('stonecut.boardColor') || null)
  useEffect(() => {
    if (boardColor) localStorage.setItem('stonecut.boardColor', boardColor)
    else localStorage.removeItem('stonecut.boardColor')
  }, [boardColor])
  // sparkle simulation: stones render as faceted gems instead of flat dots
  const [simView, setSimView] = useState(() => localStorage.getItem('stonecut.sim') === '1')
  useEffect(() => { localStorage.setItem('stonecut.sim', simView ? '1' : '0') }, [simView])
  // garment mockup modal
  const [mockupOpen, setMockupOpen] = useState(false)
  const [garmentColor, setGarmentColor] = useState(() => localStorage.getItem('stonecut.garment') || '#1a1a2e')
  useEffect(() => { localStorage.setItem('stonecut.garment', garmentColor) }, [garmentColor])
  const [chestIn, setChestIn] = useState(20)
  const [dropIn, setDropIn] = useState(3)
  const mockupCanvasRef = useRef<HTMLCanvasElement>(null)
  // real S&S product photos via the TSB API (same droplet; /tsb-api proxied
  // in dev and on the rhinestones vhost; image-proxy adds the CORS header
  // that keeps the canvas untainted for the PNG download)
  interface SsColor { name: string; hex: string | null; swatch: string | null; image: string | null; backImage: string | null }
  const [mkMode, setMkMode] = useState<'photo' | 'tee'>('photo')
  const [mkSearch, setMkSearch] = useState('')
  const [mkResults, setMkResults] = useState<{ ss_id: string; name: string; brand: string }[]>([])
  const [mkStyle, setMkStyle] = useState<{ ssId: string; name: string; brand: string } | null>(() => {
    try { return JSON.parse(localStorage.getItem('stonecut.mkstyle') ?? 'null') } catch { return null }
  })
  const [mkColors, setMkColors] = useState<SsColor[]>([])
  const [mkColorIdx, setMkColorIdx] = useState(0)
  const [mkView, setMkView] = useState<'front' | 'back'>('front')
  // how much of the photo's width the garment chest spans — S&S flat shots
  // vary by brand, so it's a visible calibration, not a hidden constant
  const [mkSpan, setMkSpan] = useState(() => +(localStorage.getItem('stonecut.mkspan') ?? 62))
  useEffect(() => { localStorage.setItem('stonecut.mkspan', String(mkSpan)) }, [mkSpan])
  const [mkOff, setMkOff] = useState({ x: 0, y: 0 })
  const mkDrag = useRef<{ x: number; y: number } | null>(null)
  const mkImgRef = useRef<HTMLImageElement | null>(null)
  const [mkImgTick, setMkImgTick] = useState(0)
  const searchStyles = useCallback(async () => {
    const q = mkSearch.trim()
    if (!q) return
    try {
      const j = await fetch(`/tsb-api/products?search=${encodeURIComponent(q)}&limit=10`).then((r) => r.json())
      const rows = (j.products ?? []).filter((p: { ss_id?: string }) => p.ss_id)
      setMkResults(rows.map((p: { ss_id: string; name: string; brand: string }) => ({ ss_id: p.ss_id, name: p.name, brand: p.brand })))
      if (!rows.length) setStatus(`No S&S styles match “${q}”`)
    } catch {
      setStatus('Could not reach the T-Shirt Brothers product API')
    }
  }, [mkSearch])
  const selectStyle = useCallback(async (s: { ss_id: string; name: string; brand: string }) => {
    const style = { ssId: s.ss_id, name: s.name, brand: s.brand }
    setMkStyle(style)
    localStorage.setItem('stonecut.mkstyle', JSON.stringify(style))
    setMkResults([])
    setMkColors([])
    setMkColorIdx(0)
    try {
      const j = await fetch(`/tsb-api/products/colors/${s.ss_id}`).then((r) => r.json())
      const colors = (j.colors ?? []).filter((c: SsColor) => c.image || c.backImage)
      setMkColors(colors)
      if (!colors.length) setStatus(`${s.name}: S&S has no product photos for this style`)
    } catch {
      setStatus('Could not load colors for that style')
    }
  }, [])
  // opening the modal with a remembered style: fetch its colors once
  useEffect(() => {
    if (mockupOpen && mkMode === 'photo' && mkStyle && !mkColors.length)
      void selectStyle({ ss_id: mkStyle.ssId, name: mkStyle.name, brand: mkStyle.brand })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockupOpen])
  // load the chosen colour's photo through the CORS proxy
  useEffect(() => {
    if (!mockupOpen || mkMode !== 'photo') return
    const c = mkColors[mkColorIdx]
    const url = c ? (mkView === 'back' ? c.backImage ?? c.image : c.image ?? c.backImage) : null
    if (!url) { mkImgRef.current = null; setMkImgTick((t) => t + 1); return }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { mkImgRef.current = img; setMkImgTick((t) => t + 1) }
    img.onerror = () => { mkImgRef.current = null; setMkImgTick((t) => t + 1); setStatus('Could not load the garment photo') }
    img.src = `/tsb-api/products/image-proxy?url=${encodeURIComponent(url)}`
  }, [mockupOpen, mkMode, mkColors, mkColorIdx, mkView])
  // light material needs dark rules/labels on it, and vice versa
  const boardIsLight = useMemo(() => {
    if (!boardColor) return false
    const n = parseInt(boardColor.slice(1), 16)
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
    return lum > 140
  }, [boardColor])
  // standoff between the cutter origin and the nearest hole. The CE6000's pinch
  // rollers sit on the material edges and can't be cut under, so 0 only works
  // when ORIGIN is set inboard of them.
  const [margin, setMargin] = useState(() => +(localStorage.getItem('stonecut.margin') ?? DEFAULT_MARGIN))
  useEffect(() => { localStorage.setItem('stonecut.margin', String(margin)) }, [margin])
  // 'design' re-zeroes the job to its own bounding box (cut always starts at
  // the machine origin); 'artboard' keeps the stones where they sit on the
  // sheet, so what you positioned on the page is what gets cut.
  const [placement, setPlacement] = useState<'design' | 'artboard'>(
    () => (localStorage.getItem('stonecut.placement') === 'design' ? 'design' : 'artboard'),
  )
  useEffect(() => { localStorage.setItem('stonecut.placement', placement) }, [placement])
  // Graphtec carriages home to the right, so 'br' is the common CE6000 setup.
  const [originCorner, setOriginCorner] = useState<OriginCorner>(
    () => (localStorage.getItem('stonecut.origin') === 'bl' ? 'bl' : 'br'),
  )
  useEffect(() => { localStorage.setItem('stonecut.origin', originCorner) }, [originCorner])
  // Must match MENU -> I/F -> STEP SIZE on the machine, or the job is scaled.
  // Default is 0.100 mm (254 steps/in, 10 units/mm) — what Kevin's CE6000 is
  // set to. The old 20 u/mm default cut every hole at double size on it. New
  // storage key so browsers that silently saved the old default start fresh.
  const [gpStep, setGpStep] = useState(() => +(localStorage.getItem('stonecut.gpstep2') ?? 10) || 10)
  useEffect(() => { localStorage.setItem('stonecut.gpstep2', String(gpStep)) }, [gpStep])
  // On by default: the app sends the preset's speed and force ahead of the
  // geometry. The machine only honours them when TOOLS SETTING ->
  // CONDITION PRIORITY is PROGRAM; otherwise the panel conditions still win.
  // New storage key so browsers that saved the old off-default flip to on.
  const [sendConditions, setSendConditions] = useState(
    () => localStorage.getItem('stonecut.sendcond2') !== '0',
  )
  // Graphtec's first coordinate is the media-feed axis. The board is drawn
  // with feed running up the screen (model Y), so swapped is the correct
  // default; the toggle stays for a machine whose axes have been rotated.
  const [swapAxes, setSwapAxes] = useState(() => localStorage.getItem('stonecut.swap') !== '0')
  useEffect(() => { localStorage.setItem('stonecut.swap', swapAxes ? '1' : '0') }, [swapAxes])
  // Firmware circles: holes as GP-GL W arc commands (one per hole, machine-
  // interpolated) instead of 12-24 segment polygons. OFF until live-tested
  // on the CE6000 — flip it in Cutter setup after a good test cut.
  const [wCircles, setWCircles] = useState(() => localStorage.getItem('stonecut.wcircles') === '1')
  useEffect(() => { localStorage.setItem('stonecut.wcircles', wCircles ? '1' : '0') }, [wCircles])
  // Overcut: recut this far past each hole's closing point so the blade's
  // swivel tag doesn't hold the chad in. 0 = old behaviour.
  const [overcut, setOvercut] = useState(() => {
    const v = +(localStorage.getItem('stonecut.overcut') ?? 0.5)
    return isFinite(v) && v >= 0 ? v : 0.5
  })
  useEffect(() => { localStorage.setItem('stonecut.overcut', String(overcut)) }, [overcut])
  useEffect(() => { localStorage.setItem('stonecut.sendcond2', sendConditions ? '1' : '0') }, [sendConditions])
  const boardWmm = boardWIn * 25.4
  const boardHmm = boardHIn * 25.4
  const [status, setStatus] = useState('Ready')
  // resizable sidebar: drag the strip between the panel and the canvas
  const [panelW, setPanelW] = useState(() => {
    const v = +(localStorage.getItem('stonecut.panelw') ?? 300)
    return isFinite(v) ? Math.min(560, Math.max(240, v)) : 300
  })
  useEffect(() => { localStorage.setItem('stonecut.panelw', String(panelW)) }, [panelW])
  const panelDrag = useRef(false)

  // text panel
  const [font, setFont] = useState<opentype.Font | null>(null)
  const [fontName, setFontName] = useState('')
  interface GFont {
    id: string
    f: string // family
    c: string // category
    p: number // popularity rank
    r: string | null // regular ttf url
    b: string | null // bold ttf url
  }
  const [gfonts, setGfonts] = useState<GFont[]>([])
  const [fontSearch, setFontSearch] = useState('')
  const [fontCat, setFontCat] = useState('all')
  const [fontOpen, setFontOpen] = useState(false)
  const [hiIdx, setHiIdx] = useState(-1)
  const loadTimer = useRef<number | undefined>(undefined)
  const pickerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setFontOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])
  const [selFont, setSelFont] = useState('')
  const [weight, setWeight] = useState<'bold' | 'regular'>('bold')
  const fontCache = useRef(new Map<string, opentype.Font>())
  // installed custom fonts (IndexedDB) — presented as GFont rows with a
  // "custom:" id so search, chips and arrow-key browsing treat them like
  // any catalog font
  const [customFonts, setCustomFonts] = useState<string[]>([])
  useEffect(() => {
    listFonts().then(setCustomFonts).catch(() => {})
  }, [])
  useEffect(() => {
    fetch('/gfonts.json')
      .then((r) => r.json())
      .then(setGfonts)
      .catch(() => setStatus('Could not load Google Fonts catalog'))
  }, [])

  const loadGFont = useCallback(
    async (gf: GFont, w: 'bold' | 'regular') => {
      if (gf.id.startsWith('custom:')) {
        const name = gf.f
        setSelFont(gf.id)
        const cached = fontCache.current.get(gf.id)
        if (cached) {
          setFont(cached)
          setFontName(name)
          setStatus(`Font: ${name}`)
          return
        }
        try {
          const buf = await getFont(name)
          if (!buf) throw new Error('missing')
          const parsed = parseFontBuffer(buf)
          fontCache.current.set(gf.id, parsed)
          setFont(parsed)
          setFontName(name)
          setStatus(`Font: ${name}`)
        } catch {
          setStatus(`Could not load ${name}`)
        }
        return
      }
      const url = (w === 'bold' ? gf.b ?? gf.r : gf.r ?? gf.b) ?? ''
      if (!url) {
        setStatus(`${gf.f}: no usable weight`)
        return
      }
      setSelFont(gf.id)
      const cached = fontCache.current.get(url)
      if (cached) {
        setFont(cached)
        setFontName(gf.f)
        setStatus(`Font: ${gf.f}`)
        return
      }
      setStatus(`Loading ${gf.f}…`)
      try {
        const buf = await fetch(url).then((r) => r.arrayBuffer())
        const parsed = parseFontBuffer(buf)
        fontCache.current.set(url, parsed)
        setFont(parsed)
        setFontName(gf.f)
        setStatus(`Font: ${gf.f}`)
      } catch {
        setStatus(`Could not load ${gf.f}`)
      }
    },
    [],
  )
  const fontMatches = useMemo(() => {
    const q = fontSearch.toLowerCase()
    const customs: GFont[] =
      fontCat === 'all' || fontCat === 'custom'
        ? customFonts
            .filter((n) => n.toLowerCase().includes(q))
            .map((n) => ({ id: `custom:${n}`, f: n, c: 'custom', p: 0, r: null, b: null }))
        : []
    if (fontCat === 'custom') return customs
    return [
      ...customs,
      ...gfonts.filter((f) => (fontCat === 'all' || f.c === fontCat) && f.f.toLowerCase().includes(q)),
    ]
  }, [gfonts, customFonts, fontCat, fontSearch])
  useEffect(() => { setHiIdx(-1) }, [fontSearch, fontCat])
  useEffect(() => {
    document.querySelector('.fontlist .hi')?.scrollIntoView({ block: 'nearest' })
  }, [hiIdx])
  // arrow-key browsing: highlight moves instantly, the font loads after a
  // short debounce so holding the key doesn't fire a request per row
  const moveHighlight = useCallback(
    (delta: number) => {
      setHiIdx((prev) => {
        if (!fontMatches.length) return prev
        const base = prev < 0 ? (delta > 0 ? -1 : 0) : prev
        const next = Math.max(0, Math.min(fontMatches.length - 1, base + delta))
        window.clearTimeout(loadTimer.current)
        loadTimer.current = window.setTimeout(() => {
          const f = fontMatches[next]
          if (f) void loadGFont(f, weight)
        }, 160)
        return next
      })
    },
    [fontMatches, loadGFont, weight],
  )

  const [text, setText] = useState('Joy')
  const [textHeight, setTextHeight] = useState(50)
  // Arc bend in degrees of total sweep: 0 = straight, + arches up (rainbow),
  // − bends down. Letters stay rigid — rotated into place, never warped.
  const [textBend, setTextBend] = useState(0)
  const [textMode, setTextMode] = useState<StoneMode>('outline')
  const [letterSpacing, setLetterSpacing] = useState(2)
  // What the text BECOMES: stone holes, vector cut lines, or both. Until the
  // user says "rhinestones", no holes preview — cut-lines-only (and
  // not-yet-chosen) shows just the letter outlines (Kevin, 2026-10-14).
  // Remembered across sessions once chosen.
  const [textOutput, setTextOutputRaw] = useState<'stones' | 'lines' | 'both' | null>(() => {
    const v = localStorage.getItem('stonecut.textout')
    return v === 'stones' || v === 'lines' || v === 'both' ? v : null
  })
  const setTextOutput = (v: 'stones' | 'lines' | 'both') => {
    setTextOutputRaw(v)
    localStorage.setItem('stonecut.textout', v)
  }
  const wantStones = textOutput === 'stones' || textOutput === 'both'
  const wantLines = textOutput === 'lines' || textOutput === 'both'

  // image panel
  const [imageFile, setImageFile] = useState<File | null>(null)
  // ---- T-Shirt Brothers shape library (art-library API via dev proxy) ----
  interface TemplateItem { name: string; file: string; license: string; source: string }
  interface TemplateCat { slug: string; label: string; items: TemplateItem[] }
  const [tplCats, setTplCats] = useState<TemplateCat[]>([])
  const [tplCat, setTplCat] = useState('')
  useEffect(() => {
    fetch('/templates/index.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((m: { categories: TemplateCat[] }) => {
        const cats = m.categories.filter((c) => c.items.length > 0)
        setTplCats(cats)
        if (cats.length) setTplCat(cats[0].slug)
      })
      .catch(() => {}) // templates are optional — the section just stays empty
  }, [])
  const loadTemplate = async (t: TemplateItem) => {
    try {
      setStatus(`Loading ${t.name}…`)
      const blob = await fetch(`/templates/${t.file}`).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.blob()
      })
      const f = new File([blob], `${t.name}.svg`, { type: 'image/svg+xml' })
      setImageFile(f)
      const a = await analyzeImage(f, imgWidth, (sizes[curSize]?.holeMm ?? 3.4) + gap)
      setImgThreshold(a.threshold)
      setImgInvert(a.invert)
      setImgAlphaKey(a.alphaKey)
      setImgLinework(a.linework)
      applyStrokeStyle(a)
      setStatus(`${t.name} — ${a.note}`)
    } catch {
      setStatus(`Could not load ${t.name}`)
    }
  }

  interface TsbShape { id: number; name: string; image_url: string; category: string }
  const [tsbOpen, setTsbOpen] = useState(false)
  const [tsbCats, setTsbCats] = useState<{ name: string; count: number }[]>([])
  const [tsbCat, setTsbCat] = useState('')
  const [tsbShapes, setTsbShapes] = useState<TsbShape[]>([])
  const tsbThumb = (url: string) =>
    url.replace('https://tshirtbrothers.atl1.cdn.digitaloceanspaces.com', '/tsb-cdn')
  useEffect(() => {
    if (!tsbOpen || tsbCats.length) return
    fetch('/tsb-api/design/art-categories')
      .then((r) => r.json())
      .then((cats: { name: string; count: number }[]) => {
        setTsbCats(cats.filter((c) => c.count > 0))
        if (cats.length) setTsbCat(cats[0].name)
      })
      .catch(() => setStatus('Could not reach the T-Shirt Brothers shape library'))
  }, [tsbOpen, tsbCats.length])
  useEffect(() => {
    if (!tsbOpen || !tsbCat) return
    fetch(`/tsb-api/design/art-library?category=${encodeURIComponent(tsbCat)}&limit=30`)
      .then((r) => r.json())
      .then(setTsbShapes)
      .catch(() => setStatus('Could not load shapes'))
  }, [tsbOpen, tsbCat])
  const [imgWidth, setImgWidth] = useState(100)
  const [imgThreshold, setImgThreshold] = useState(128)
  const [imgInvert, setImgInvert] = useState(false)
  const [imgAlphaKey, setImgAlphaKey] = useState(false)
  const [imgLinework, setImgLinework] = useState(false)
  const [imagePreview, setImagePreview] = useState<{ x: number; y: number; size?: string; color?: string }[] | null>(null)
  const [imgMode, setImgMode] = useState<StoneMode>('both')
  // Detail smoothing: welds art detail finer than the stone rhythm into its
  // parent shape (fur hatching -> solid mane). Radius is pitch-relative.
  const [imgDetail, setImgDetail] = useState<'fine' | 'smooth' | 'bold'>('fine')
  // detected lettering in the image: offer to replace with typed stone text
  const [imgOcr, setImgOcr] = useState<DetectedText | null>(null)
  const [imgOcrText, setImgOcrText] = useState('')
  const [imgTextMasked, setImgTextMasked] = useState(false)
  useEffect(() => { setImgOcr(null); setImgOcrText(''); setImgTextMasked(false) }, [imageFile])
  // multi-color trace: k-means colour layers of the working image
  const [mcColors, setMcColors] = useState(3)
  const [mcLayers, setMcLayers] = useState<ColorLayer[] | null>(null)
  useEffect(() => { setMcLayers(null) }, [imageFile])

  // material
  const [presets, setPresets] = useState<MaterialPreset[]>(loadPresets)
  const [presetIdx, setPresetIdx] = useState(0)
  // Vector cut lines are usually a different material from the holes (vinyl
  // or HTV, not flock), so they get their own preset. -1 = same as holes.
  const [linePresetName, setLinePresetName] = useState<string | null>(() => localStorage.getItem('stonecut.linepreset'))
  useEffect(() => {
    if (linePresetName) localStorage.setItem('stonecut.linepreset', linePresetName)
    else localStorage.removeItem('stonecut.linepreset')
  }, [linePresetName])
  const [format, setFormat] = useState<'gpgl' | 'hpgl'>('gpgl')

  type Snapshot = { stones: Stone[]; elements: Elements; vectors: VecItem[] }
  const undoStack = useRef<Snapshot[]>([])
  const redoStack = useRef<Snapshot[]>([])
  const pushUndo = useCallback((prev: Stone[]) => {
    undoStack.current.push({ stones: prev, elements: elementsRef.current, vectors: vectorsRef.current })
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = [] // a new edit forks history; the redo branch dies
  }, [])
  const applySnapshot = useCallback((s: Snapshot) => {
    stonesRef.current = s.stones
    setStones(s.stones)
    setElements(s.elements)
    setVectors(s.vectors)
    setSelection(new Set())
    setSelVecs(new Set())
  }, [])
  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push({ stones: stonesRef.current, elements: elementsRef.current, vectors: vectorsRef.current })
    applySnapshot(prev)
  }, [applySnapshot])
  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push({ stones: stonesRef.current, elements: elementsRef.current, vectors: vectorsRef.current })
    applySnapshot(next)
  }, [applySnapshot])
  const mutateVectors = useCallback(
    (fn: (prev: VecItem[]) => VecItem[]) => {
      pushUndo(stonesRef.current)
      setVectors((prev) => fn(prev))
    },
    [pushUndo],
  )
  const mutate = useCallback(
    (fn: (prev: Stone[]) => Stone[]) => {
      setStones((prev) => {
        pushUndo(prev)
        return fn(prev)
      })
    },
    [pushUndo],
  )

  const holeOf = useCallback((s: Stone) => sizes[s.size]?.holeMm ?? 3, [sizes])

  const bbox = useMemo(() => {
    if (!stones.length && !vectors.length) return { minX: 0, minY: 0, maxX: 100, maxY: 60 }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of stones) {
      const r = holeOf(s) / 2
      minX = Math.min(minX, s.x - r); minY = Math.min(minY, s.y - r)
      maxX = Math.max(maxX, s.x + r); maxY = Math.max(maxY, s.y + r)
    }
    for (const v of vectors) {
      const b = vecBox(v)
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
    }
    return { minX, minY, maxX, maxY }
  }, [stones, vectors, holeOf])

  const job = useMemo(() => {
    if (placement === 'artboard') {
      // Coordinates pass through untouched: the sheet's own corner is the
      // machine origin, so on-screen placement is the cut placement.
      // NOT rounded: heightMm is the datum the exporters flip Y against, so
      // ceiling a 304.8mm sheet to 305 would shift the whole design 0.2mm.
      return { stones, sizes, widthMm: boardWmm, heightMm: boardHmm, paths: vectors.flatMap(vecPaths), pathOwner: vectors.flatMap((v) => vecPaths(v).map(() => v.id)) }
    }
    const w = bbox.maxX - bbox.minX + margin * 2
    const h = bbox.maxY - bbox.minY + margin * 2
    return {
      stones: stones.map((s) => ({ ...s, x: s.x - bbox.minX + margin, y: s.y - bbox.minY + margin })),
      sizes,
      widthMm: Math.ceil(w),
      heightMm: Math.ceil(h),
      paths: vectors.flatMap(vecPaths).map((p) => p.map((q) => ({ x: q.x - bbox.minX + margin, y: q.y - bbox.minY + margin }))),
      // id of the vector each path came from, so a selection can cut its own lines
      pathOwner: vectors.flatMap((v) => vecPaths(v).map(() => v.id)),
    }
  }, [stones, vectors, bbox, sizes, margin, placement, boardWmm, boardHmm])

  // In artboard mode anything past the sheet edge cuts at negative or
  // over-range coordinates, which the CE6000 silently clips.
  const offBoard =
    placement === 'artboard' &&
    (stones.length > 0 || vectors.length > 0) &&
    (bbox.minX < 0 || bbox.minY < 0 || bbox.maxX > boardWmm || bbox.maxY > boardHmm)

  // Where the design sits relative to the machine's ORIGIN corner, in inches:
  // `across` along the carriage, `feed` up the media. This is what the
  // operator can measure on the cutter, so it is what the inputs speak.
  const fromOrigin = useMemo(() => {
    if (!stones.length && !vectors.length) return null
    const acrossMm = originCorner === 'br' ? boardWmm - bbox.maxX : bbox.minX
    const feedMm = boardHmm - bbox.maxY
    return { across: acrossMm / 25.4, feed: feedMm / 25.4 }
  }, [stones.length, vectors.length, bbox, originCorner, boardWmm, boardHmm])
  const placeFromOrigin = useCallback((acrossIn: number, feedIn: number) => {
    if (!fromOrigin) return
    const dAcross = (acrossIn - fromOrigin.across) * 25.4
    const dx = originCorner === 'br' ? -dAcross : dAcross
    const dy = -(feedIn - fromOrigin.feed) * 25.4
    if (!dx && !dy) return
    mutate((prev) => prev.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy })))
  }, [fromOrigin, originCorner, mutate])

  // live text preview: sample the selected font before committing stones
  const textPreview = useMemo(() => {
    if (!font || !text.trim()) return null
    try {
      const base = textToContours(font, text, textHeight, letterSpacing)
      if (!textBend) return base
      const contours = arcContours(base.contours, textBend)
      let maxX = 0
      for (const c of contours) for (const q of c) maxX = Math.max(maxX, q.x)
      return { contours, widthMm: maxX }
    } catch (e) {
      // Can't setStatus from a memo; the console is the only channel here.
      console.error('[stonecut] font contours failed', e)
      return null
    }
  }, [font, text, textHeight, letterSpacing, textBend])
  // The preview's Y offset is PINNED when a preview session starts, not
  // derived live from the bbox. Deriving it live meant every manually added
  // hole grew the bbox and shoved the whole previewed design away from the
  // cursor — placing a hole on top of the artwork was impossible.
  const [previewBaseY, setPreviewBaseY] = useState<number | null>(null)
  const layoutRef = useRef({ len: 0, maxY: 0, boardH: 0 })
  useEffect(() => {
    layoutRef.current = { len: stones.length, maxY: bbox.maxY, boardH: boardHmm }
    stonesRef.current = stones
  })
  // An empty board releases the pin. Clear all / delete / undo used to leave
  // the old pin behind, so the next preview sat wherever the LAST design
  // ended — often below the bottom edge of the media.
  useEffect(() => { if (!stones.length) { setPreviewBaseY(null); setPreviewOffX(10); setElements({}) } }, [stones.length])
  // designHmm: height of the thing being previewed. A new preview stacks
  // below the existing stones, but never past the bottom of the media —
  // if it won't fit underneath it is pulled up onto the sheet (it may
  // overlap, and can be dragged), rather than parked off the cut area.
  const pinPreviewBase = useCallback((designHmm = 0) => {
    setPreviewBaseY((prev) => {
      if (prev != null) return prev
      const { len, maxY, boardH } = layoutRef.current
      const below = len ? maxY + 10 : 10
      const lowest = boardH - designHmm - 10
      return Math.max(10, Math.min(below, lowest))
    })
  }, [])
  const previewOffsetY = previewBaseY ?? (stones.length ? bbox.maxY + 10 : 10)
  // horizontal twin of previewBaseY — the preview is draggable before Add
  const [previewOffX, setPreviewOffX] = useState(10)
  const previewDragRef = useRef<{ x: number; y: number } | null>(null)
  // Previews aren't selectable objects, so Delete had nothing to grab —
  // this is what "delete" means when only previews are on the board.
  const discardPreviews = useCallback(() => {
    setText('')
    setImageFile(null)
    setImagePreview(null)
    setMcLayers(null)
    setPreviewStones(null)
    setPreviewLive(false)
    setPreviewBaseY(null)
    setPreviewOffX(10)
    setStatus('Previews discarded')
  }, [])


  // Line art wants ONE row of stones down each stroke, not a wall row on both
  // edges. When the analyzed artwork's typical stroke is too narrow to hold
  // two readable rows at the current stone pitch, switch Outline design to
  // centerline; solid artwork returns to single outline (double/ghost choices
  // are left alone).
  const applyStrokeStyle = useCallback(
    (a: { strokePx: number; strokeDeciles?: number[]; strokeMax?: number; sampleW: number }) => {
      if (!a.strokePx || !a.sampleW) return
      const toMm = (px: number) => px * (imgWidth / a.sampleW)
      const pitch = (sizes[curSize]?.holeMm ?? 3.4) + gap
      // Style auto-matches the artwork. "Wide share" is the fraction of the
      // design thick enough to hold fill rows: a music note's solid head
      // reads wide even though its thin stem drags the p90 down, so it fills;
      // a basketball's uniform strokes read narrow everywhere, so it gets a
      // centerline outline with no fill.
      // The analyzer decides blob presence geometrically (compactness +
      // width ratio + area — see hasBlob); percentile-only rules seesawed
      // between the basketball and the beamed notes for days.
      const deciles = a.strokeDeciles ?? []
      const p50 = toMm(deciles[4] ?? a.strokePx)
      const thinDominant = p50 < pitch * 1.6
      const blobby = (a as { blobby?: boolean }).blobby ?? false
      if (thinDominant && !blobby) {
        // uniform line drawing: one row of stones per line, nothing to fill
        setOutlineDesign('centerline')
        setImgMode('outline')
      } else {
        // solid or mixed art: walls + fill; thin limbs still get single rows
        // from the per-part machinery in outlineOrSpine
        setOutlineDesign((prev) => (prev === 'centerline' ? 'single' : prev))
        setImgMode('both')
      }
    },
    [imgWidth, sizes, curSize, gap],
  )

  // live stone preview: settings changes (size, gap, style) re-stone the
  // preview automatically, debounced so typing stays smooth. Committing hides
  // the preview until something changes again — no duplicate on canvas.
  const [shapeKind, setShapeKind] = useState<ShapeKind>('circle')
  const [shapeW, setShapeW] = useState(50)
  const [shapeH, setShapeH] = useState(50)
  const [shapeMode, setShapeMode] = useState<StoneMode>('outline')
  const [previewStones, setPreviewStones] = useState<{ x: number; y: number; size?: string; color?: string }[] | null>(null)
  const [previewLive, setPreviewLive] = useState(true)
  // A preview looks exactly like a finished design but isn't in `stones` yet,
  // so the layer counts read 0 and Cut stays dead with a full canvas on screen.
  // These counts drive the "not added yet" notice and the pulsing Add button.
  const pendingText = previewLive ? previewStones?.length ?? 0 : 0
  const pendingImage = imagePreview?.length ?? 0
  const pending = pendingText + pendingImage
  // A change to the TEXT itself (words, font, height, spacing) is a new
  // design: show the preview again. Stone/fill setting changes are handled
  // further down — they re-stone the design already on the board instead.
  // EXCEPT while a committed text element is selected: then the Text panel
  // is EDITING that element (see the editable-text effects below), and the
  // preview must stay out of the way.
  const editingTextElRef = useRef<number | null>(null)
  useEffect(() => {
    if (editingTextElRef.current != null) return
    setPreviewLive(true)
  }, [textPreview, fontOpen, pinPreviewBase])
  // lastTextRef is declared up with the design state (it persists with it).
  // Rehydrate it once the restored font arrives: the regen-in-place guard
  // compares the live font object, so we re-point it at the loaded font
  // when the names match and the element is still on the board.
  useEffect(() => {
    const saved = savedDesign.current?.lastText
    if (!saved || lastTextRef.current || !font || fontName !== saved.fontName) return
    if (!stonesRef.current.some((st) => st.el === saved.el)) return
    lastTextRef.current = { el: saved.el, font, fontName, text: saved.text, height: saved.height, spacing: saved.spacing, bend: saved.bend }
  }, [font, fontName])
  useEffect(() => {
    // No holes until the user says "rhinestones" — cut-lines-only (and
    // not-yet-chosen) previews show the letter outlines only, which also
    // makes font browsing instant: no stone layout is computed.
    if (!textPreview || !wantStones) {
      setPreviewStones(null)
      return
    }
    const t = window.setTimeout(() => {
      try {
        const hole = sizes[curSize]?.holeMm ?? 3
        const hardGap = hardGapOf(gap)
        const rhythm = hole + gap
        const idx = new SpacingIndex(hole + hardGap)
        const pts: { x: number; y: number; size?: string; color?: string }[] = []
        let noFill = false
        // ghost and double both put a row OUTSIDE the letter — pad the grid
        // so the outer row isn't clipped at the raster edge
        const previewPx = textPreview.widthMm <= 150 ? 6 : textPreview.widthMm <= 300 ? 4 : 3
        const grid = rasterizeContours(textPreview.contours, previewPx, outlineDesign === 'ghost' || outlineDesign === 'double' ? rhythm + hole : 0.5)
        setCanEcho(true)
        setEchoUpsize(null)
        let outline: { x: number; y: number }[] = []
        if (textMode !== 'fill') {
          if (outlineDesign === 'ghost') {
            outline = offsetRows(grid, hole, hardGap, idx, rhythm, rhythm * 0.55, true, uniformRhythm)
          } else {
            outline = outlineOrSpine(textPreview.contours, grid, hole, hardGap, idx, outlineStyle, true, rhythm, uniformRhythm)
            // the echo row floats OUTSIDE the edge row — outside always has
            // room, unlike the old inside echo that needed wide strokes
            if (outlineDesign === 'double')
              outline = outline.concat(offsetRows(grid, hole, hardGap, idx, rhythm, rhythm, true, uniformRhythm))
          }
        }
        pts.push(...outline.map((p) => ({ ...p, layer: 'outline' as const })))
        // While the font picker is open you're comparing letterforms, and the
        // fill is by far the most expensive stage — computing it on every
        // arrow-key step blocked the main thread for over a second and made
        // the app feel frozen. Show the outline while browsing; the full
        // design lands the moment the picker closes.
        if (textMode !== 'outline' && !fontOpen) {
          const fHole = sizes[fillSize]?.holeMm ?? 2.5
          const fGap = hardGapOf(gap)
          // EVEN SPACING FIRST: the fill continues the outline's rhythm, so a
          // letter reads as one uniform field of stones rather than an outline
          // with a differently-paced infill. The customer picks the fill STONE
          // SIZE; the beat is shared.
          // The lattice steps on the FILL stone's own pitch, not the outline's.
          // Inheriting the outline rhythm spaces small fill stones as if they
          // were the big outline ones, which reads as padding on both axes.
          const fRhythm = fHole + fGap
          // A fill stone only has to sit inside the shape; its clearance from
          // the outline is already enforced per-pair by fIdx below. Insetting a
          // whole rhythm as well padded the fill twice and left a dead band
          // between the outline and the first lattice line.
          const fInset = fHole / 2 + 0.1
          const fIdx = new SpacingIndex(Math.max(fHole + fGap, (hole + fHole) / 2 + fGap), fGap, fHole / 2)
            const f = fillByGlyph(textPreview.contours, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle, hole)
          pts.push(...f.map((p) => ({ ...p, size: fillSize, color: fillColor, layer: 'fill' as const })))
          if (!f.length && textMode === 'both') noFill = true
        }
        // Recompute the advisory EVERY run, including clearing it. Setting it
        // only when a condition holds leaves the previous design's warning on
        // screen — GLEE was reporting abcdefg's centre lines.
        //
        // Say when a letter is too light to outline: below about
        // hole + spacing + hole across a stroke, two wall rows cannot both fit
        // and it is drawn as a single centre line instead. Geometry allows
        // nothing else, but switching silently reads as a bug — lowercase at
        // 50mm with SS10 comes out half centre lines.
        const spines = debugStones.filter((s) => s.cat === 'partspine').length
        const spinePct = debugStones.length ? spines / debugStones.length : 0
        // Say exactly how much bigger it has to be. Two wall rows need the
        // stroke to reach hole + 0.2 + (hole + spacing); the narrowest stroke
        // we had to draw as a centre line says how far short we are, and the
        // height scales linearly with it.
        let advice = 'Raise Height or pick a smaller stone.'
        if (spinedWidths.length) {
          const narrowest = Math.min(...spinedWidths)
          // wall stones sit ON the contour, so two rows need the stroke to
          // clear the pitch (with the same slack fill.ts uses)
          const needW = (hole + hardGap) * 1.1
          const needH = Math.ceil((textHeight * needW) / narrowest)
          // largest catalogue stone whose two rows would fit the narrowest stroke
          const fits = Object.entries(sizes)
            .filter(([, s]) => narrowest >= (s.holeMm + hardGapOf(gap)) * 1.1)
            .sort((a, b) => b[1].holeMm - a[1].holeMm)[0]
          advice =
            `Outlining needs about ${needH} mm at this stone` +
            (fits ? `, or ${fits[0]} at this height.` : '.')
        }
        // Stroke ends whose cap stone can't legally sit on the line stay
        // open — say exactly what closes them. A centered cap needs the end
        // edge to reach two pitches; height scales linearly, and a smaller
        // stone shrinks the pitch instead.
        let capMsg = ''
        if (capGaps.length && textMode !== 'fill') {
          const worst = Math.min(...capGaps)
          const needC = 2 * (hole + hardGap) * 1.005
          const needH = Math.ceil((textHeight * needC) / worst)
          const fits = Object.entries(sizes)
            .filter(([, s]) => worst >= 2 * (s.holeMm + hardGapOf(gap)) * 1.005)
            .sort((a, b) => b[1].holeMm - a[1].holeMm)[0]
          capMsg =
            `${capGaps.length} stroke end${capGaps.length === 1 ? '' : 's'} ha${capGaps.length === 1 ? 's' : 've'} no room ` +
            `for an end stone — needs about ${needH} mm Height` +
            (fits ? `, or ${fits[0]} at this height.` : '.')
        }
        // The physics wall: letters whose strokes sit closer together than
        // the spacing floor can't be beaded at ANY placement quality — a
        // tiny script's lowercase at SS10 simply doesn't fit. Say it.
        const bareMsg =
          bareFrac > 0.2 && textMode !== 'fill'
            ? `${Math.round(bareFrac * 100)}% of these letters can't hold stones at this size — ` +
              `details sit closer together than the stones are allowed to be. ` +
              `Raise Height (try ${Math.ceil(textHeight * 1.8)} mm) or pick a smaller stone.`
            : ''
        setStatus(
          noFill
            ? 'Strokes too light to fill at this size — raise Height, pick a bolder font, or lower Fill "From edge" / fill stone size'
            : bareMsg ||
              (spinePct > 0.25 && textMode !== 'fill'
                ? `${Math.round(spinePct * 100)}% of this design is too light to outline at this size — ` +
                  `those strokes are drawn as a single centre line. ${advice}`
                : capMsg),
        )
        pinPreviewBase(textHeight)
        setPreviewStones(pts)
        ;(window as unknown as { __scDebug?: unknown }).__scDebug = [...debugStones]
        ;(window as unknown as { __scSpans?: unknown }).__scSpans = debugSpans.map((s) => ({ ...s, chords: [...s.chords] }))
        ;(window as unknown as { __scContours?: unknown }).__scContours = textPreview.contours
        ;(window as unknown as { __scPts?: unknown }).__scPts = pts
      } catch (e) {
        // A throw here used to vanish silently: the outline path still drew
        // from textPreview, so the design looked intact while every stone
        // disappeared and the layer counts read 0. Say what broke.
        console.error('[stonecut] text stone preview failed', e)
        setPreviewStones(null)
        setStatus(`Preview failed: ${e instanceof Error ? e.message : e}`)
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [textPreview, wantStones, curSize, gap, sizes, textMode, outlineStyle, outlineDesign, uniformRhythm, fillStyle, fillSize, fillColor, fontOpen, pinPreviewBase])

  // live IMAGE preview: same treatment text gets — settings changes re-stone
  // the artwork automatically, nothing committed until you press Add
  useEffect(() => {
    if (!imageFile || mcLayers) return // multi-color preview owns the canvas
    // while the committed design is still regenerable in place, settings
    // changes morph IT (effect below) — a second preview stacked underneath
    // only confused things
    if (
      lastImageRef.current &&
      lastImageRef.current.file === imageFile &&
      stonesRef.current === lastImageRef.current.after
    )
      return
    const t = window.setTimeout(async () => {
      try {
        // PREVIEW resolution adapts to design size: small designs keep the
        // full 6 px/mm (they're fast anyway, and small features like note
        // heads fall apart on a coarse grid); only large designs trade
        // resolution for fluid slider drags. Commits always re-run at 6.
        const previewPx = imgWidth <= 150 ? 6 : imgWidth <= 300 ? 4 : 3
        // despeckle floor: features too small to hold a stone run are noise
        const pitch = (sizes[curSize]?.holeMm ?? 3) + hardGapOf(gap)
        const minFeat = pitch ** 2 * 0.6
        const closeMm = imgDetail === 'fine' ? 0 : pitch * (imgDetail === 'smooth' ? 0.2 : 0.45)
        const raster = await imageToRaster(imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, previewPx, minFeat, closeMm, imgTextMasked && imgOcr ? imgOcr.rects : undefined)
        // PHOTO GUARD: a photograph thresholds into thousands of speckle
        // regions and the outline engine walks every one — the tab froze
        // for minutes. Refuse pathological masks with advice instead.
        if (raster.contours.length > 250) {
          setImagePreview(null)
          setStatus(`This traces to ${raster.contours.length} separate regions — it reads as a photo, not line art. Use Multi-color trace, or move Threshold until the subject is one solid shape.`)
          return
        }
        const hole = sizes[curSize]?.holeMm ?? 3
        const hardGap = hardGapOf(gap)
        const rhythm = hole + gap
        const idx = new SpacingIndex(hole + hardGap)
        const pts: { x: number; y: number; size?: string; color?: string }[] = []
        let outline: { x: number; y: number }[] = []
        if (imgMode !== 'fill') {
          if (outlineDesign === 'ghost') {
            outline = offsetRows(raster.grid, hole, hardGap, idx, rhythm, rhythm * 0.55, true, uniformRhythm)
          } else {
            outline = outlineOrSpine(raster.contours, raster.grid, hole, hardGap, idx, outlineStyle, false, rhythm, uniformRhythm)
            if (outlineDesign === 'double')
              outline = outline.concat(offsetRows(raster.grid, hole, hardGap, idx, rhythm, rhythm, true, uniformRhythm))
          }
        }
        pts.push(...outline.map((p) => ({ ...p, layer: 'outline' as const })))
        if (imgMode !== 'outline') {
          const fHole = sizes[fillSize]?.holeMm ?? 2.5
          const fGap = hardGapOf(gap)
          // The lattice steps on the FILL stone's own pitch, not the outline's.
          // Inheriting the outline rhythm spaces small fill stones as if they
          // were the big outline ones, which reads as padding on both axes.
          const fRhythm = fHole + fGap
          const fInset = fHole / 2 + 0.1
          const fIdx = new SpacingIndex(Math.max(fHole + fGap, (hole + fHole) / 2 + fGap), fGap, fHole / 2)
            const f = fillStones(raster.grid, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle, hole)
          pts.push(...f.map((p) => ({ ...p, size: fillSize, color: fillColor, layer: 'fill' as const })))
        }
        // same physics advisory text gets: artwork lines thinner than the
        // stone floor can't be traced, and silence read as a broken trace
        if (imgMode !== 'fill' && bareFrac > 0.2)
          setStatus(
            `${Math.round(bareFrac * 100)}% of this artwork can't hold stones at this size — ` +
            `its lines sit closer together than the stones are allowed to be. ` +
            `Raise Width (try ${Math.ceil(imgWidth * 1.8)} mm) or pick a smaller stone.`,
          )
        pinPreviewBase(pts.reduce((m, p) => Math.max(m, p.y), 0))
        setImagePreview(pts)
        ;(window as unknown as { __scPts?: unknown }).__scPts = pts
        ;(window as unknown as { __scDebug?: unknown }).__scDebug = [...debugStones]
      } catch (e) {
        console.error('[stonecut] image stone preview failed', e)
        setImagePreview(null)
        setStatus(`Preview failed: ${e instanceof Error ? e.message : e}`)
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [imageFile, mcLayers, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, imgDetail, imgTextMasked, imgOcr, imgMode, sizes, curSize, gap,
      outlineStyle, outlineDesign, uniformRhythm, fillStyle, fillSize, fillColor, pinPreviewBase])

  // ---------- generation ----------
  const addGenerated = useCallback(
    (pts: { x: number; y: number; size?: string; color?: string; layer?: 'outline' | 'fill' }[], offsetY: number, recipe?: Omit<Recipe, 'sx' | 'sy'>) => {
      // each commit is its own ELEMENT: a free-moving layer that may overlap
      // other elements — nothing culls across elements anymore
      const el = nextEl()
      const fresh: Stone[] = pts.map((p) => ({ x: p.x + previewOffX, y: p.y + offsetY, size: p.size ?? curSize, color: p.color, layer: p.layer ?? 'outline', el }))
      mutate((prev) => [...prev, ...fresh])
      if (recipe) setElements((prev) => ({ ...prev, [el]: { ...recipe, contours: normaliseContours(recipe.contours), sx: 1, sy: 1 } }))
      return el
    },
    [curSize, gap, mutate, sizes, previewOffX],
  )

  // The contours -> stones stage, shared by text and shapes. Both feed the
  // same outline/fill machinery; only where the contours come from differs.
  const contoursToStones = useCallback(
    (contours: Pt[][], mode: StoneMode, wholeWord = true) => {
    const hole = sizes[curSize]?.holeMm ?? 3
    const hardGap = hardGapOf(gap)
    const rhythm = hole + gap
    const idx = new SpacingIndex(hole + hardGap)
    const pts: { x: number; y: number; size?: string; color?: string; layer?: 'outline' | 'fill' }[] = []
    const grid = rasterizeContours(contours, 6, outlineDesign === 'ghost' || outlineDesign === 'double' ? rhythm + hole : 0.5)
    let outline: { x: number; y: number }[] = []
    if (mode !== 'fill') {
      if (outlineDesign === 'ghost') {
        outline = offsetRows(grid, hole, hardGap, idx, rhythm, rhythm * 0.55, true, uniformRhythm)
      } else {
        outline = outlineOrSpine(contours, grid, hole, hardGap, idx, outlineStyle, wholeWord, rhythm, uniformRhythm)
        if (outlineDesign === 'double')
          outline = outline.concat(offsetRows(grid, hole, hardGap, idx, rhythm, rhythm, true, uniformRhythm))
      }
    }
    pts.push(...outline.map((p) => ({ ...p, layer: 'outline' as const })))
    if (mode !== 'outline') {
      const fHole = sizes[fillSize]?.holeMm ?? 2.5
      const fGap = hardGapOf(gap)
    // The lattice steps on the FILL stone's own pitch, not the outline's.
          // Inheriting the outline rhythm spaces small fill stones as if they
          // were the big outline ones, which reads as padding on both axes.
          const fRhythm = fHole + fGap
        // A fill stone only has to sit inside the shape; its clearance from
          // the outline is already enforced per-pair by fIdx below. Insetting a
          // whole rhythm as well padded the fill twice and left a dead band
          // between the outline and the first lattice line.
          const fInset = fHole / 2 + 0.1
      const fIdx = new SpacingIndex(Math.max(fHole + fGap, (hole + fHole) / 2 + fGap), fGap, fHole / 2)
      for (const p of outline) fIdx.add(p, hole / 2)
      const f = wholeWord
        ? fillByGlyph(contours, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle, hole)
        : fillStones(grid, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle, hole)
      pts.push(...f.map((p) => ({ ...p, size: fillSize, color: fillColor, layer: 'fill' as const })))
    }
      return pts
    },
    [curSize, gap, sizes, uniformRhythm, outlineDesign, outlineStyle, fillStyle, fillSize, fillColor],
  )

  const generateText = useCallback(() => {
    if (!font) { setStatus('Upload a font file first (.ttf/.otf)'); return }
    if (!textPreview) { setStatus('Type some text first'); return }
    // the preview's contours already carry the arc bend
    const { contours } = textPreview
    const pts = contoursToStones(contours, textMode)
    // commit exactly where the preview showed; release the pin so the next
    // preview session stacks below the committed stones
    const offsetY = previewBaseY ?? (stones.length ? bbox.maxY + 10 : 10)
    const el = addGenerated(pts, offsetY, {
      contours, mode: textMode, wholeWord: true,
      // the committed design remembers WHAT TEXT it is — selecting it later
      // reloads these into the Text panel and edits re-stone it in place
      textMeta: { text, fontName, fontId: selFont, weight, height: textHeight, spacing: letterSpacing, bend: textBend },
    })
    lastTextRef.current = { el, font, fontName, text, height: textHeight, spacing: letterSpacing, bend: textBend }
    setPreviewBaseY(null); setPreviewOffX(10)
    setPreviewLive(false)
    setStatus(`Added ${pts.length} stones from text`)
  }, [font, fontName, selFont, weight, text, textHeight, letterSpacing, textBend, textPreview, textMode, contoursToStones, stones.length, bbox.maxY, previewBaseY, addGenerated])

  const generateShape = useCallback(() => {
    const { contours } = shapeToContours(shapeKind, shapeW, shapeH)
    const pts = contoursToStones(contours, shapeMode)
    if (!pts.length) {
      setStatus('Shape is too small to hold stones at this size — raise the size or pick a smaller stone')
      return
    }
    const offsetY = stones.length ? bbox.maxY + 10 : 10
    addGenerated(pts, offsetY, { contours, mode: shapeMode, wholeWord: true })
    setStatus(`Added ${pts.length} stones from ${shapeKind}`)
  }, [shapeKind, shapeW, shapeH, shapeMode, contoursToStones, stones.length, bbox.maxY, addGenerated])

  const generateImage = useCallback(async () => {
    if (!imageFile) { setStatus('Choose an image first'); return }
    setStatus('Tracing image…')
    try {
      const pitch = (sizes[curSize]?.holeMm ?? 3) + hardGapOf(gap)
      const minFeat = pitch ** 2 * 0.6
      const closeMm = imgDetail === 'fine' ? 0 : pitch * (imgDetail === 'smooth' ? 0.2 : 0.45)
      const raster = await imageToRaster(imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, 6, minFeat, closeMm, imgTextMasked && imgOcr ? imgOcr.rects : undefined)
      if (raster.contours.length > 250) {
        setStatus(`This traces to ${raster.contours.length} separate regions — it reads as a photo, not line art. Use Multi-color trace, or move Threshold until the subject is one solid shape.`)
        return
      }
      const hole = sizes[curSize]?.holeMm ?? 3
      const hardGap = hardGapOf(gap)
      const rhythm = hole + gap
      const idx = new SpacingIndex(hole + hardGap)
      const pts: { x: number; y: number; size?: string; color?: string; layer?: 'outline' | 'fill' }[] = []
      let outline: { x: number; y: number }[] = []
      if (imgMode !== 'fill') {
        if (outlineDesign === 'ghost') {
          outline = offsetRows(raster.grid, hole, hardGap, idx, rhythm, rhythm * 0.55, true, uniformRhythm)
        } else {
          outline = outlineOrSpine(raster.contours, raster.grid, hole, hardGap, idx, outlineStyle, false, rhythm, uniformRhythm)
          if (outlineDesign === 'double')
            outline = outline.concat(offsetRows(raster.grid, hole, hardGap, idx, rhythm, rhythm, true, uniformRhythm))
        }
      }
      pts.push(...outline.map((p) => ({ ...p, layer: 'outline' as const })))
      if (imgMode !== 'outline') {
        const fHole = sizes[fillSize]?.holeMm ?? 2.5
        const fGap = hardGapOf(gap)
      // The lattice steps on the FILL stone's own pitch, not the outline's.
          // Inheriting the outline rhythm spaces small fill stones as if they
          // were the big outline ones, which reads as padding on both axes.
          const fRhythm = fHole + fGap
        const fInset = fHole / 2 + 0.1
        const fIdx = new SpacingIndex(Math.max(fHole + fGap, (hole + fHole) / 2 + fGap), fGap, fHole / 2)
        const f = fillStones(raster.grid, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle, hole)
        pts.push(...f.map((p) => ({ ...p, size: fillSize, color: fillColor, layer: 'fill' as const })))
      }
      const last = lastImageRef.current
      const replacing = !!(last && last.file === imageFile && stones === last.after)
      const base = replacing ? last.before : stones
      const offsetY = replacing
        ? last.offsetY
        : previewBaseY ?? (stones.length ? bbox.maxY + 10 : 10)
      const el = replacing && last.el != null ? last.el : nextEl()
      const fresh: Stone[] = pts.map((p) => ({
        x: p.x + previewOffX,
        y: p.y + offsetY,
        size: p.size ?? curSize,
        color: p.color,
        layer: p.layer ?? 'outline',
        el,
      }))
      // elements are free layers: no culling across elements on commit
      const kept = [...base, ...fresh]
      if (!replacing) pushUndo(stones) // regens share the original undo point
      setStones(kept)
      setElements((prev) => ({ ...prev, [el]: { contours: normaliseContours(raster.contours), mode: imgMode, wholeWord: false, sx: 1, sy: 1 } }))
      lastImageRef.current = { file: imageFile, offsetY, before: base, after: kept, el }
      setPreviewBaseY(null); setPreviewOffX(10)
      setImagePreview(null)
      setStatus(
        pts.length
          ? `${replacing ? 'Regenerated' : 'Added'} ${pts.length} stones from image`
          : 'No stones — the artwork read as background. Try the Invert box or move the Threshold slider.',
      )
    } catch (e) {
      setStatus(`Image failed: ${e instanceof Error ? e.message : e}`)
    }
  }, [imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, imgDetail, imgTextMasked, imgOcr, imgMode, sizes, curSize, gap, stones, bbox.maxY, previewBaseY, pushUndo, uniformRhythm, outlineDesign, outlineStyle, fillStyle, fillSize, fillColor])

  // Live regeneration: while the last image commit is untouched, any
  // generation-setting change re-runs it in place (debounced like a preview).
  const generateImageRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    generateImageRef.current = generateImage
  })
  useEffect(() => {
    const last = lastImageRef.current
    if (!last || last.file !== imageFile || stonesRef.current !== last.after) return
    const t = window.setTimeout(() => {
      void generateImageRef.current()
    }, 650)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, imgDetail, imgTextMasked, imgOcr, imgMode, fillStyle, fillSize, curSize, gap, sizes, outlineDesign, strokePolicy, uniformRhythm, imageFile])

  // ---------- multi-color trace ----------
  const traceColors = useCallback(async () => {
    if (!imageFile) { setStatus('Choose an image first'); return }
    lastImageRef.current = null // new task — stop morphing the last stone commit
    setStatus(`Separating into ${mcColors} colors…`)
    try {
      const px = imgWidth <= 150 ? 6 : imgWidth <= 300 ? 4 : 3
      const r = await imageToColorLayers(imageFile, imgWidth, mcColors, px)
      setMcLayers(r.layers)
      setStatus(`Found ${r.layers.length} color region${r.layers.length === 1 ? '' : 's'} — tune the swatches, then add stones`)
    } catch (e) {
      setStatus(`Color trace failed: ${e instanceof Error ? e.message : e}`)
    }
  }, [imageFile, mcColors, imgWidth])
  // Stones for every colour layer, sharing ONE spacing index pair so stones
  // from touching colour regions keep legal clearance across the boundary.
  // Outline + fill sizes come from the panels; only the colour varies.
  const multiColorPts = useCallback(
    (layers: ColorLayer[]) => {
      const hole = sizes[curSize]?.holeMm ?? 3
      const hardGap = hardGapOf(gap)
      const rhythm = hole + gap
      const idx = new SpacingIndex(hole + hardGap)
      const fHole = sizes[fillSize]?.holeMm ?? 2.5
      const fGap = hardGapOf(gap)
      const fIdx = new SpacingIndex(Math.max(fHole + fGap, (hole + fHole) / 2 + fGap), fGap, fHole / 2)
      const pts: { x: number; y: number; size?: string; color?: string; layer?: 'outline' | 'fill' }[] = []
      const allOutline: { x: number; y: number }[] = []
      for (const L of layers) {
        let outline: { x: number; y: number }[] = []
        if (imgMode !== 'fill') {
          if (outlineDesign === 'ghost') {
            outline = offsetRows(L.grid, hole, hardGap, idx, rhythm, rhythm * 0.55, true, uniformRhythm)
          } else {
            outline = outlineOrSpine(L.contours, L.grid, hole, hardGap, idx, outlineStyle, false, rhythm, uniformRhythm)
            if (outlineDesign === 'double')
              outline = outline.concat(offsetRows(L.grid, hole, hardGap, idx, rhythm, rhythm, true, uniformRhythm))
          }
        }
        allOutline.push(...outline)
        pts.push(...outline.map((p) => ({ ...p, size: curSize, color: L.color, layer: 'outline' as const })))
        if (imgMode !== 'outline') {
          const f = fillStones(L.grid, fHole, fGap, fHole / 2 + 0.1, fIdx, allOutline, fHole + fGap, fillStyle, hole)
          pts.push(...f.map((p) => ({ ...p, size: fillSize, color: L.color, layer: 'fill' as const })))
        }
      }
      return pts
    },
    [sizes, curSize, gap, fillSize, imgMode, outlineDesign, outlineStyle, uniformRhythm, fillStyle],
  )
  // live preview whenever the layers or stone settings change
  useEffect(() => {
    if (!mcLayers) return
    const t = window.setTimeout(() => {
      try {
        const pts = multiColorPts(mcLayers)
        pinPreviewBase(pts.reduce((m, p) => Math.max(m, p.y), 0))
        setImagePreview(pts)
      } catch (e) {
        console.error('[stonecut] multi-color preview failed', e)
        setImagePreview(null)
        setStatus(`Preview failed: ${e instanceof Error ? e.message : e}`)
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [mcLayers, multiColorPts, pinPreviewBase])
  const commitMultiColor = useCallback(() => {
    if (!mcLayers) return
    const pts = multiColorPts(mcLayers)
    if (!pts.length) { setStatus('No stones — regions may be too small at this stone size'); return }
    const offsetY = previewBaseY ?? (stones.length ? bbox.maxY + 10 : 10)
    addGenerated(pts, offsetY) // no recipe: multi-color designs rescale via Scale %, not the handles
    const byColor = new Map<string, number>()
    for (const p of pts) byColor.set(p.color ?? '', (byColor.get(p.color ?? '') ?? 0) + 1)
    setPreviewBaseY(null); setPreviewOffX(10)
    setImagePreview(null)
    setMcLayers(null)
    // release the image slot, or the single-colour preview of the same
    // artwork pops back up underneath the committed multi-colour design
    setImageFile(null)
    setStatus(
      `Added ${pts.length} stones in ${byColor.size} colors — ` +
      [...byColor.entries()].map(([c, n]) => `${n} ${c}`).join(', ') +
      ' · counts are in Production',
    )
  }, [mcLayers, multiColorPts, previewBaseY, stones.length, bbox.maxY, addGenerated])

  // ---------- canvas interactions ----------
  const svgRef = useRef<SVGSVGElement>(null)
  const stoneCanvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLElement>(null)
  const [avail, setAvail] = useState({ w: 1200, h: 800 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { measured.current = true; setAvail({ w: el.clientWidth, h: el.clientHeight }) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const measured = useRef(false)

  // ---------- view: fit + zoom about a point ----------
  // Every zoom change goes through setView so the point the user cares about
  // (cursor, viewport centre, or the design) stays put on screen. The scroll
  // target is applied in a layout effect: the canvas only takes its new size
  // after React commits, and scrolling before that gets clamped to the old
  // (smaller) canvas.
  const barRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const pendingScroll = useRef<{ left: number; top: number } | null>(null)
  const [viewTick, setViewTick] = useState(0)
  useLayoutEffect(() => {
    const el = wrapRef.current
    const p = pendingScroll.current
    if (!el || !p) return
    pendingScroll.current = null
    el.scrollLeft = p.left
    el.scrollTop = p.top
  }, [zoom, viewTick])
  // Put mm point `at` under viewport pixel `screen` (measured from the
  // top-left of the visible canvas, just below the zoom bar) at zoom z.
  const setView = useCallback((z: number, at: Pt, screen: Pt) => {
    const zc = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
    pendingScroll.current = { left: at.x * zc - screen.x, top: at.y * zc - screen.y }
    setZoom(zc)
    setViewTick((t) => t + 1)
  }, [])
  const viewport = useCallback(() => {
    const el = wrapRef.current
    const bar = barRef.current?.offsetHeight ?? 36
    return { el, bar, w: el?.clientWidth ?? 0, h: (el?.clientHeight ?? 0) - bar }
  }, [])
  // Zoom buttons / ⌘± / the slider anchor on the selection when there is one
  // (Doc, 2026-10-25): the selected design holds its spot while the board
  // scales around it — on-screen it stays put, off-screen it gets centred.
  // No selection: zoom keeps the middle of the viewport in the middle.
  // Pinch / ⌘-wheel still zoom about the cursor (separate native handler).
  const selAnchorRef = useRef<Pt | null>(null)
  const zoomAbout = useCallback((z: number) => {
    const { el, bar, w, h } = viewport()
    if (!el) return
    const z0 = zoomRef.current
    const a = selAnchorRef.current
    if (a) {
      // Same screen convention as setView: centre of the visible canvas is
      // {w/2, h/2}, i.e. p.y*z0 - scrollTop + bar.
      const sx = a.x * z0 - el.scrollLeft
      const sy = a.y * z0 - el.scrollTop + bar
      const vis = sx >= 0 && sx <= w && sy >= 0 && sy <= h
      setView(z, a, vis ? { x: sx, y: sy } : { x: w / 2, y: h / 2 })
      return
    }
    const centre = { x: (el.scrollLeft + w / 2) / z0, y: (el.scrollTop - bar + h / 2) / z0 }
    setView(z, centre, { x: w / 2, y: h / 2 })
  }, [setView, viewport])
  // Zoom so a mm rectangle fills the viewport, centred.
  const fitRect = useCallback((x: number, y: number, w: number, h: number, pad = 32) => {
    const v = viewport()
    if (!v.el || w <= 0 || h <= 0) return
    const z = Math.min((v.w - pad * 2) / w, (v.h - pad * 2) / h)
    setView(z, { x: x + w / 2, y: y + h / 2 }, { x: v.w / 2, y: v.h / 2 })
  }, [setView, viewport])
  const fitSheet = useCallback(() => fitRect(0, 0, boardWmm, boardHmm), [fitRect, boardWmm, boardHmm])
  const fitDesign = useCallback(() => {
    if (!stones.length && !vectors.length) { fitSheet(); return }
    fitRect(bbox.minX, bbox.minY, bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 48)
  }, [stones.length, vectors.length, bbox, fitRect, fitSheet])
  // Pinch / ⌘-wheel zooms about the cursor. Native listener: React's wheel
  // handler can't reliably preventDefault, and the page would zoom instead.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return // plain wheel pans
      e.preventDefault()
      const svg = svgRef.current
      if (!svg) return
      const r = svg.getBoundingClientRect()
      const wr = el.getBoundingClientRect()
      const bar = barRef.current?.offsetHeight ?? 36
      const z0 = zoomRef.current
      // trackpad pinch sends many small deltas, a wheel sends few big ones —
      // an exponential step with a clamp feels the same from both
      const step = Math.max(-30, Math.min(30, e.deltaY))
      setView(
        z0 * Math.exp(-step * 0.012),
        { x: (e.clientX - r.left) / z0, y: (e.clientY - r.top) / z0 },
        { x: e.clientX - wr.left, y: e.clientY - wr.top - bar },
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setView])
  // Opening the app fits the saved design, or the whole sheet if empty.
  // There is deliberately NO auto-fit when the board goes from empty to
  // non-empty: it used to zoom to the first thing placed, and a single hand-
  // placed stone is a 3 mm dot, so every first click slammed the view to
  // maximum zoom. The preview already shows where a design will land, so the
  // operator is looking at it when it commits; F / Fit design is there when
  // they want it.
  const stoneCountRef = useRef(0)
  useEffect(() => { stoneCountRef.current = stones.length }, [stones.length])
  // The app always opens with the whole artboard in view (Doc, 2026-10-25).
  // It used to restore the last session's zoom/scroll from localStorage, but
  // coming back into a view zoomed on one corner of an old design read as
  // broken; the saved-view machinery is gone.
  const didInitialFit = useRef(false)
  useEffect(() => {
    if (didInitialFit.current || !measured.current) return
    didInitialFit.current = true
    try { localStorage.removeItem('stonecut.view') } catch { /* ignore */ }
    fitSheet()
  }, [avail, fitSheet])
  const drag = useRef<{ startX: number; startY: number; moved: boolean; orig: Stone[] } | null>(null)
  // marquee: drag over empty canvas in Select mode to box-select stones
  // x1/y1 live in the ref too: mouseup must not depend on React having
  // rendered the last mousemove, or a quick drag selects with a stale box.
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  // ---------- snapping ----------
  // Inkscape-style object snapping while dragging: the dragged selection's
  // edges and centre pull to other objects' edges/centres and to the board's
  // edges and centre. Pink guide lines show what snapped; Alt drags free.
  const [snapOn, setSnapOn] = useState(() => localStorage.getItem('stonecut.snapobj') !== '0')
  useEffect(() => { localStorage.setItem('stonecut.snapobj', snapOn ? '1' : '0') }, [snapOn])
  const [snapLines, setSnapLines] = useState<{ x?: number; y?: number }>({})
  const snapRef = useRef<{ xs: number[]; ys: number[]; box0: { minX: number; minY: number; maxX: number; maxY: number } } | null>(null)
  // Collect snap targets ONCE at drag start: board + every object not being
  // dragged (vectors by id, stones grouped into their elements).
  const buildSnapTargets = useCallback(
    (excludeVecs: Set<number>, excludeStones: Set<number>, box0: { minX: number; minY: number; maxX: number; maxY: number }) => {
      const xs: number[] = [0, boardWmm / 2, boardWmm]
      const ys: number[] = [0, boardHmm / 2, boardHmm]
      const addBox = (b: { minX: number; minY: number; maxX: number; maxY: number }) => {
        xs.push(b.minX, (b.minX + b.maxX) / 2, b.maxX)
        ys.push(b.minY, (b.minY + b.maxY) / 2, b.maxY)
      }
      for (const v of vectors) if (!excludeVecs.has(v.id)) addBox(vecBox(v))
      const byEl = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>()
      stones.forEach((st, i) => {
        if (excludeStones.has(i)) return
        const r = holeOf(st) / 2
        const b = { minX: st.x - r, minY: st.y - r, maxX: st.x + r, maxY: st.y + r }
        const key = st.el ?? -1 - i // loose stones are their own tiny objects
        const e = byEl.get(key)
        byEl.set(key, e ? { minX: Math.min(e.minX, b.minX), minY: Math.min(e.minY, b.minY), maxX: Math.max(e.maxX, b.maxX), maxY: Math.max(e.maxY, b.maxY) } : b)
      })
      for (const b of byEl.values()) addBox(b)
      snapRef.current = { xs, ys, box0 }
    },
    [vectors, stones, holeOf, boardWmm, boardHmm],
  )
  // Adjust a drag delta so the nearest edge/centre within tolerance locks on.
  const applySnap = useCallback(
    (dx: number, dy: number, disable: boolean): { dx: number; dy: number } => {
      const s = snapRef.current
      if (!s || !snapOn || disable) { setSnapLines((prev) => (prev.x != null || prev.y != null ? {} : prev)); return { dx, dy } }
      const tol = 8 / zoom
      const b = s.box0
      const cand = (vals: number[], targets: number[], d: number) => {
        let best: { adj: number; line: number } | null = null
        for (const v0 of vals) {
          const v = v0 + d
          for (const t of targets) {
            const diff = t - v
            if (Math.abs(diff) <= tol && (!best || Math.abs(diff) < Math.abs(best.adj))) best = { adj: diff, line: t }
          }
        }
        return best
      }
      const bx = cand([b.minX, (b.minX + b.maxX) / 2, b.maxX], s.xs, dx)
      const by = cand([b.minY, (b.minY + b.maxY) / 2, b.maxY], s.ys, dy)
      setSnapLines((prev) => (prev.x === bx?.line && prev.y === by?.line ? prev : { x: bx?.line, y: by?.line }))
      return { dx: dx + (bx?.adj ?? 0), dy: dy + (by?.adj ?? 0) }
    },
    [snapOn, zoom],
  )

  const toMm = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const rect = svgRef.current!.getBoundingClientRect()
      return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom }
    },
    [zoom],
  )

  // Hit slop in SCREEN pixels, converted to mm at the current zoom. A fixed
  // 0.5 mm slop was under a pixel when zoomed out to see the whole sheet,
  // where an SS10 hole is a 5 px target — selecting anything was luck.
  // Picks the NEAREST stone inside the slop, not the first one found.
  const HIT_SLOP_PX = 7
  const pickStone = useCallback(
    (p: Pt, slopMm: number) => {
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < stones.length; i++) {
        const d = Math.hypot(stones[i].x - p.x, stones[i].y - p.y)
        if (d <= holeOf(stones[i]) / 2 + slopMm && d < bestD) { bestD = d; best = i }
      }
      return best
    },
    [stones, holeOf],
  )
  // ---------- resize a whole design ----------
  // Handles appear when the selection is exactly one complete element that
  // has a recipe (double-click a design to get that). Dragging a handle
  // re-stones the design at the new size from its recipe: the holes keep
  // the panel's stone size, only how many there are and where they sit
  // changes. Corner handles keep the proportions, edge handles stretch one
  // axis.
  type Box = { minX: number; minY: number; maxX: number; maxY: number }
  type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
  const HANDLE_PX = 9
  const handlePos = (b: Box, h: Handle): Pt => ({
    x: h.includes('w') ? b.minX : h.includes('e') ? b.maxX : (b.minX + b.maxX) / 2,
    y: h.includes('n') ? b.minY : h.includes('s') ? b.maxY : (b.minY + b.maxY) / 2,
  })
  const handleCursor = (h: Handle) =>
    h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize'
  const selectedEl = useMemo(() => {
    if (!selection.size) return null
    let el: number | undefined
    for (const i of selection) {
      const e = stones[i]?.el
      if (e == null || (el != null && e !== el)) return null
      el = e
    }
    if (el == null || !elements[el]) return null
    for (let i = 0; i < stones.length; i++) if (stones[i].el === el && !selection.has(i)) return null
    return el
  }, [selection, stones, elements])
  const selBox = useMemo<Box | null>(() => {
    if (selectedEl == null) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const st of stones) {
      if (st.el !== selectedEl) continue
      const r = holeOf(st) / 2
      minX = Math.min(minX, st.x - r); minY = Math.min(minY, st.y - r)
      maxX = Math.max(maxX, st.x + r); maxY = Math.max(maxY, st.y + r)
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null
  }, [selectedEl, stones, holeOf])
  const hitHandle = useCallback(
    (p: Pt): Handle | null => {
      if (!selBox || tool !== 'select') return null
      const r = (HANDLE_PX / 2 + 4) / zoom
      for (const h of HANDLES) {
        const q = handlePos(selBox, h)
        if (Math.abs(p.x - q.x) <= r && Math.abs(p.y - q.y) <= r) return h
      }
      return null
    },
    [selBox, tool, zoom],
  )
  const resizeRef = useRef<{ el: number; handle: Handle; box: Box; sx0: number; sy0: number; fx: number; fy: number; timer: number | null } | null>(null)
  const [resizeBox, setResizeBox] = useState<Box | null>(null)

  // ---------- resize selected cut-line objects on canvas ----------
  // Same handles as stone designs. Cut shapes always scale uniformly —
  // stretching one axis distorts letterforms.
  const vecSelBox = useMemo<Box | null>(() => {
    if (!selVecs.size || tool !== 'select') return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const v of vectors) {
      if (!selVecs.has(v.id)) continue
      const b = vecBox(v)
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null
  }, [selVecs, vectors, tool])
  // Centre of everything selected (stones + cut-line objects), for the
  // selection-anchored zoom above. Computed from the raw selections, not
  // selBox/vecSelBox: those are null for partial-element picks or other tools.
  useEffect(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const i of selection) {
      const st = stones[i]
      if (!st) continue
      minX = Math.min(minX, st.x); minY = Math.min(minY, st.y)
      maxX = Math.max(maxX, st.x); maxY = Math.max(maxY, st.y)
    }
    for (const v of vectors) {
      if (!selVecs.has(v.id)) continue
      const b = vecBox(v)
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
    }
    selAnchorRef.current = isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null
  }, [selection, stones, selVecs, vectors])
  const hitVecHandle = useCallback(
    (p: Pt): Handle | null => {
      if (!vecSelBox || tool !== 'select') return null
      const r = (HANDLE_PX / 2 + 4) / zoom
      for (const h of HANDLES) {
        const q = handlePos(vecSelBox, h)
        if (Math.abs(p.x - q.x) <= r && Math.abs(p.y - q.y) <= r) return h
      }
      return null
    },
    [vecSelBox, tool, zoom],
  )
  const vecResize = useRef<{ handle: Handle; box: Box; orig: VecItem[]; moved: boolean } | null>(null)

  // ---------- rotation ----------
  // Bake rotation into a cut-line object so the model stays rotation-free.
  const bakeRotateVec = (v: VecItem, center: Pt, rad: number): VecItem => {
    const rot = vecPaths(v).map((c) => c.map((q) => rotatePt(q, center, rad)))
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const c of rot) for (const q of c) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
    return { ...v, base: rot.map((c) => c.map((q) => ({ x: q.x - minX, y: q.y - minY }))), baseW: maxX - minX, baseH: maxY - minY, x: minX, y: minY, s: 1 }
  }
  const rotateSelection = useCallback((deg: number) => {
    const rad = (deg * Math.PI) / 180
    if (selVecs.size && vecSelBox) {
      const c = { x: (vecSelBox.minX + vecSelBox.maxX) / 2, y: (vecSelBox.minY + vecSelBox.maxY) / 2 }
      pushUndo(stonesRef.current)
      setVectors((prev) => prev.map((v) => (selVecs.has(v.id) ? bakeRotateVec(v, c, rad) : v)))
      setStatus(`Rotated ${deg}°`)
      return
    }
    if (selection.size) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const i of selection) { const st = stones[i]; minX = Math.min(minX, st.x); minY = Math.min(minY, st.y); maxX = Math.max(maxX, st.x); maxY = Math.max(maxY, st.y) }
      const c = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
      mutate((prev) => prev.map((st, i) => (selection.has(i) ? { ...st, ...rotatePt(st, c, rad) } : st)))
      setStatus(`Rotated ${deg}° — holes are round, the cut is exact`)
      return
    }
    setStatus('Select something to rotate first')
  }, [selVecs, vecSelBox, selection, stones, pushUndo, mutate])

  // Mirror the selection about its own bounding-box centre. Stones are
  // circles so position mirroring is exact; cut-line objects bake the flip
  // into their base, same as rotation does.
  const flipSelection = useCallback((axis: 'h' | 'v') => {
    if (selVecs.size && vecSelBox) {
      const cx = (vecSelBox.minX + vecSelBox.maxX) / 2
      const cy = (vecSelBox.minY + vecSelBox.maxY) / 2
      pushUndo(stonesRef.current)
      setVectors((prev) => prev.map((v) => {
        if (!selVecs.has(v.id)) return v
        const flipped = vecPaths(v).map((pl) => pl.map((q) => (axis === 'h' ? { x: cx * 2 - q.x, y: q.y } : { x: q.x, y: cy * 2 - q.y })))
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const pl of flipped) for (const q of pl) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
        return { ...v, base: flipped.map((pl) => pl.map((q) => ({ x: q.x - minX, y: q.y - minY }))), baseW: maxX - minX, baseH: maxY - minY, x: minX, y: minY, s: 1 }
      }))
      setStatus(`Flipped ${axis === 'h' ? 'horizontally' : 'vertically'}`)
      return
    }
    if (selection.size) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const i of selection) { const st = stones[i]; if (!st) continue; minX = Math.min(minX, st.x); minY = Math.min(minY, st.y); maxX = Math.max(maxX, st.x); maxY = Math.max(maxY, st.y) }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
      mutate((prev) => prev.map((st, i) => (selection.has(i) ? (axis === 'h' ? { ...st, x: cx * 2 - st.x } : { ...st, y: cy * 2 - st.y }) : st)))
      setStatus(`Flipped ${axis === 'h' ? 'horizontally' : 'vertically'} — holes are round, the cut is exact`)
      return
    }
    setStatus('Select something to flip first')
  }, [selVecs, vecSelBox, selection, stones, pushUndo, mutate])

  // ---------- scatter spray ----------
  // Random stones fading outward from the selected design's edges — the
  // Silhouette-style "bling spray". Density falls off with distance across
  // the band; every candidate passes the radius-aware spacing index seeded
  // with the WHOLE board, so the spray never collides with anything.
  const [scatterBand, setScatterBand] = useState(15)
  const [scatterDensity, setScatterDensity] = useState(50)
  const [scatterMix, setScatterMix] = useState(true)
  const scatterSpray = useCallback(() => {
    const srcStones = [...selection].map((i) => stones[i]).filter(Boolean)
    const srcPaths = vectors.filter((v) => selVecs.has(v.id)).flatMap(vecPaths)
    if (!srcStones.length && !srcPaths.length) { setStatus('Select a design or cut-line object to scatter around first'); return }
    const band = Math.max(2, scatterBand)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const st of srcStones) {
      const r = holeOf(st) / 2
      minX = Math.min(minX, st.x - r); minY = Math.min(minY, st.y - r)
      maxX = Math.max(maxX, st.x + r); maxY = Math.max(maxY, st.y + r)
    }
    for (const pl of srcPaths) for (const q of pl) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
    minX -= band; minY -= band; maxX += band; maxY += band
    const w = maxX - minX, h = maxY - minY
    const closedPolys = srcPaths.filter((pl) => pl.length > 3 && Math.hypot(pl[0].x - pl[pl.length - 1].x, pl[0].y - pl[pl.length - 1].y) < 0.01)
    // distance from the design's edge; null = inside a closed shape
    const dEdge = (p: Pt): number | null => {
      let d = Infinity
      for (const st of srcStones) d = Math.min(d, Math.hypot(p.x - st.x, p.y - st.y) - holeOf(st) / 2)
      if (srcPaths.length) {
        let inside = 0
        for (const poly of closedPolys) if (pointInPoly(poly, p)) inside++
        if (inside % 2 === 1) return null
        d = Math.min(d, distToPaths(srcPaths, p))
      }
      return d
    }
    const hardGap = hardGapOf(gap)
    const maxHole = Math.max(sizes[curSize]?.holeMm ?? 3, sizes[fillSize]?.holeMm ?? 2.5)
    const idx = new SpacingIndex(maxHole + hardGap, hardGap, maxHole / 2)
    for (const st of stones) idx.add(st, holeOf(st) / 2)
    const attempts = Math.min(20000, Math.round(w * h * (scatterDensity / 100) * 0.25))
    const el = nextEl()
    const fresh: Stone[] = []
    for (let i = 0; i < attempts; i++) {
      const p = { x: minX + Math.random() * w, y: minY + Math.random() * h }
      const d = dEdge(p)
      if (d == null || d < 1 || d > band) continue
      const fall = 1 - d / band
      if (Math.random() > fall * fall) continue
      const size = scatterMix && Math.random() < 0.5 ? fillSize : curSize
      const r = (sizes[size]?.holeMm ?? 3) / 2
      if (!idx.canPlace(p, r)) continue
      idx.add(p, r)
      fresh.push({ x: p.x, y: p.y, size, layer: 'outline', el })
    }
    if (!fresh.length) { setStatus('No room to scatter — raise Density or Band, or lower the stone size'); return }
    mutate((prev) => [...prev, ...fresh])
    setStatus(`Scattered ${fresh.length} stones fading ${band} mm off the edge — ⌘Z undoes, double-click grabs the spray`)
  }, [selection, selVecs, stones, vectors, holeOf, scatterBand, scatterDensity, scatterMix, gap, sizes, curSize, fillSize, mutate])

  // drag-to-rotate handle floating above the selection box
  const ROT_OFF_PX = 24
  const rotRef = useRef<{ kind: 'vec' | 'stones'; center: Pt; start: number; origV: VecItem[]; origS: Stone[] } | null>(null)
  const rotHandlePos = useCallback((b: Box): Pt => ({ x: (b.minX + b.maxX) / 2, y: b.minY - ROT_OFF_PX / zoom }), [zoom])
  const hitRotateHandle = useCallback((p: Pt): { kind: 'vec' | 'stones'; box: Box } | null => {
    ;(window as unknown as Record<string, unknown>).__rotDbg = { p, tool, vecSelBox, zoom, hp: vecSelBox ? rotHandlePos(vecSelBox) : null }
    if (tool !== 'select') return null
    const r = (HANDLE_PX / 2 + 5) / zoom
    if (vecSelBox) { const q = rotHandlePos(vecSelBox); if (Math.hypot(p.x - q.x, p.y - q.y) <= r) return { kind: 'vec', box: vecSelBox } }
    if (selBox) { const q = rotHandlePos(selBox); if (Math.hypot(p.x - q.x, p.y - q.y) <= r) return { kind: 'stones', box: selBox } }
    return null
  }, [tool, zoom, vecSelBox, selBox, rotHandlePos])
  // Re-stone element `el` at recipe scale (sx, sy) and place the result so the
  // side(s) opposite `handle` stay where `box` had them.
  const regenElement = useCallback(
    (el: number, sx: number, sy: number, box: Box, handle: Handle, select = true) => {
      const r = elementsRef.current[el]
      if (!r) return
      const scaled = r.contours.map((c) => c.map((q) => ({ x: q.x * sx, y: q.y * sy })))
      const pts = contoursToStones(scaled, r.mode, r.wholeWord)
      if (!pts.length) { setStatus('Too small to hold stones at this size'); return }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const q of pts) {
        const rad = (sizes[q.size ?? curSize]?.holeMm ?? 3) / 2
        minX = Math.min(minX, q.x - rad); minY = Math.min(minY, q.y - rad)
        maxX = Math.max(maxX, q.x + rad); maxY = Math.max(maxY, q.y + rad)
      }
      const w = maxX - minX, h = maxY - minY
      const left = handle.includes('w') ? box.maxX - w : handle.includes('e') ? box.minX : (box.minX + box.maxX) / 2 - w / 2
      const top = handle.includes('n') ? box.maxY - h : handle.includes('s') ? box.minY : (box.minY + box.maxY) / 2 - h / 2
      const base = stonesRef.current.filter((st) => st.el !== el)
      const fresh: Stone[] = pts.map((q) => ({ x: q.x - minX + left, y: q.y - minY + top, size: q.size ?? curSize, color: q.color, layer: q.layer ?? 'outline', el }))
      const next = [...base, ...fresh]
      stonesRef.current = next
      setStones(next)
      if (select) setSelection(new Set(fresh.map((_, i) => base.length + i)))
      setElements((prev) => ({ ...prev, [el]: { ...prev[el], sx, sy } }))
      setStatus(`${fresh.length} stones at ${w.toFixed(0)} × ${h.toFixed(0)} mm`)
    },
    [contoursToStones, sizes, curSize],
  )
  // ---------------------------------------------------------------------
  // EDITABLE TEXT. A committed text design remembers its recipe (textMeta);
  // selecting it loads the words/font/size back into the Text panel, and
  // any further edit re-stones THAT element in place — same board position,
  // no new copy. The preview stays dormant the whole time.
  // ---------------------------------------------------------------------
  const pendingFontRef = useRef<string | null>(null)
  useEffect(() => {
    const meta = selectedEl != null ? elementsRef.current[selectedEl]?.textMeta : undefined
    editingTextElRef.current = meta && selectedEl != null ? selectedEl : null
    if (!meta) return
    setText(meta.text)
    setTextHeight(meta.height)
    setLetterSpacing(meta.spacing)
    setTextBend(meta.bend)
    setPreviewLive(false)
    if (fontName !== meta.fontName) {
      // the element was set in another font: swap the panel to it before
      // any edit regenerates — and remember we're waiting, so the regen
      // below doesn't re-stone the design in the WRONG font meanwhile
      const gf = gfonts.find((g) => g.id === meta.fontId) ?? gfonts.find((g) => g.f === meta.fontName)
      if (gf) {
        pendingFontRef.current = meta.fontName
        setWeight(meta.weight)
        void loadGFont(gf, meta.weight)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEl])
  useEffect(() => {
    const el = editingTextElRef.current
    if (el == null || selectedEl !== el) return
    const rec = elementsRef.current[el]
    const meta = rec?.textMeta
    if (!meta || !textPreview || !font || !text.trim()) return
    if (pendingFontRef.current) {
      if (fontName !== pendingFontRef.current) return // element's font still loading
      pendingFontRef.current = null
    }
    const changed =
      meta.text !== text || meta.height !== textHeight || meta.spacing !== letterSpacing ||
      meta.bend !== textBend || meta.fontName !== fontName || meta.weight !== weight
    if (!changed) {
      // settled: arm the stone-setting regen machinery on this element
      lastTextRef.current = { el, font, fontName, text, height: textHeight, spacing: letterSpacing, bend: textBend }
      return
    }
    const t = window.setTimeout(() => {
      if (!stonesRef.current.some((st) => st.el === el)) return
      const { contours } = textPreview
      const pts = contoursToStones(contours, rec.mode, true)
      if (!pts.length) { setStatus('Too small to hold stones at this size'); return }
      // hold the element's top-left anchor on the board
      let oMinX = Infinity, oMinY = Infinity
      for (const st of stonesRef.current) if (st.el === el) { oMinX = Math.min(oMinX, st.x); oMinY = Math.min(oMinY, st.y) }
      let nMinX = Infinity, nMinY = Infinity
      for (const q of pts) { nMinX = Math.min(nMinX, q.x); nMinY = Math.min(nMinY, q.y) }
      pushUndo(stonesRef.current)
      const base = stonesRef.current.filter((st) => st.el !== el)
      const fresh: Stone[] = pts.map((q) => ({ x: q.x - nMinX + oMinX, y: q.y - nMinY + oMinY, size: q.size ?? curSize, color: q.color, layer: q.layer ?? 'outline', el }))
      const next = [...base, ...fresh]
      stonesRef.current = next
      setStones(next)
      setSelection(new Set(fresh.map((_, i) => base.length + i)))
      const newMeta: TextMeta = { text, fontName, fontId: selFont, weight, height: textHeight, spacing: letterSpacing, bend: textBend }
      setElements((prev) => ({ ...prev, [el]: { ...prev[el], contours: normaliseContours(contours), sx: 1, sy: 1, textMeta: newMeta } }))
      lastTextRef.current = { el, font, fontName, text, height: textHeight, spacing: letterSpacing, bend: textBend }
      setPreviewLive(false)
      setStatus(`Re-stoned “${text}” — ${fresh.length} stones`)
    }, 350)
    return () => window.clearTimeout(t)
  }, [selectedEl, textPreview, text, textHeight, letterSpacing, textBend, font, fontName, weight, selFont, contoursToStones, curSize, pushUndo])
  // Stone / fill setting changes: if the last text commit is still on the
  // board with its text unchanged, re-stone THAT design in place (same
  // size, new stones). Otherwise the change applies to the live preview.
  // Before this, every size change popped a second copy of the text below
  // the one already added, which read as "it creates a new graphic".
  const settingsTick = useRef(0)
  useEffect(() => {
    if (settingsTick.current++ === 0) return // mount
    const last = lastTextRef.current
    const r = last && elementsRef.current[last.el]
    const alive = !!r && stonesRef.current.some((st) => st.el === last!.el)
    const sameText = !!last && last.font === font && last.text === text && last.height === textHeight && last.spacing === letterSpacing && last.bend === textBend
    if (!alive || !sameText || !r) { setPreviewLive(true); return }
    const t = window.setTimeout(() => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const st of stonesRef.current) {
        if (st.el !== last!.el) continue
        const rad = holeOf(st) / 2
        minX = Math.min(minX, st.x - rad); minY = Math.min(minY, st.y - rad)
        maxX = Math.max(maxX, st.x + rad); maxY = Math.max(maxY, st.y + rad)
      }
      if (!isFinite(minX)) return
      // the recipe keeps the text's mode in sync with the panel
      elementsRef.current[last!.el] = { ...r, mode: textMode }
      setElements((prev) => ({ ...prev, [last!.el]: { ...prev[last!.el], mode: textMode } }))
      regenElement(last!.el, r.sx, r.sy, { minX, minY, maxX, maxY }, 'nw', false)
    }, 250)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSize, gap, sizes, textMode, outlineStyle, outlineDesign, uniformRhythm, fillStyle, fillSize, fillColor, strokePolicy])

  // Typed size from the sidebar: uniform, anchored top-left.
  const resizeSelectedTo = useCallback(
    (widthMm: number | null, heightMm: number | null) => {
      if (selectedEl == null || !selBox) return
      const r = elementsRef.current[selectedEl]
      if (!r) return
      const w0 = selBox.maxX - selBox.minX, h0 = selBox.maxY - selBox.minY
      const f = widthMm != null ? widthMm / w0 : heightMm != null ? heightMm / h0 : 1
      if (!isFinite(f) || f <= 0) return
      pushUndo(stonesRef.current)
      regenElement(selectedEl, r.sx * f, r.sy * f, selBox, 'se')
    },
    [selectedEl, selBox, pushUndo, regenElement],
  )
  // ---------- node tool (moved above onCanvasDown) ----------
  // Inkscape's N tool on the flattened polyline model: vertices of the one
  // selected cut-line object become draggable squares; double-click a
  // segment inserts a vertex, Delete removes the selected ones.
  const [nodeSel, setNodeSel] = useState<Set<string>>(new Set()) // `${pathIdx}:${ptIdx}`
  const nodeSelRef = useRef(nodeSel)
  nodeSelRef.current = nodeSel
  const nodeDrag = useRef<{ vecId: number; p0: Pt; orig: VecItem; keys: Set<string>; moved: boolean } | null>(null)
  useEffect(() => { setNodeSel(new Set()) }, [tool, selVecs])
  // A closed ring stores its first point twice (start + closing point) —
  // whatever happens to one end must happen to the other, or the loop opens.
  const expandClosedPairs = (v: VecItem, keys: Set<string>): Set<string> => {
    const out = new Set(keys)
    v.base.forEach((pl, pi) => {
      const n = pl.length
      if (n > 2 && Math.hypot(pl[0].x - pl[n - 1].x, pl[0].y - pl[n - 1].y) < 1e-6) {
        if (out.has(`${pi}:0`)) out.add(`${pi}:${n - 1}`)
        if (out.has(`${pi}:${n - 1}`)) out.add(`${pi}:0`)
      }
    })
    return out
  }
  // After node edits the base no longer starts at (0,0) — shift it back and
  // fold the shift into x/y so boxes, exports and resize stay honest.
  const renormalizeVec = (v: VecItem): VecItem => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const pl of v.base) for (const q of pl) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
    if (!isFinite(minX)) return v
    return {
      ...v,
      base: v.base.map((pl) => pl.map((q) => ({ x: q.x - minX, y: q.y - minY }))),
      baseW: maxX - minX,
      baseH: maxY - minY,
      x: v.x + minX * v.s,
      y: v.y + minY * v.s,
    }
  }
  const nodeVec = useMemo(
    () => (tool === 'node' && selVecs.size === 1 ? vectors.find((v) => selVecs.has(v.id)) ?? null : null),
    [tool, selVecs, vectors],
  )

  // ---------- pen tool: draw a path, stones bead along it ----------
  // Click to place anchors; Enter or double-click finishes an open path,
  // clicking back on the first anchor closes it. Backspace removes the last
  // anchor, Esc cancels. Output: stones at pitch along the path, a cut
  // line, or both.
  const [penPts, setPenPts] = useState<Pt[]>([])
  const penPtsRef = useRef(penPts)
  penPtsRef.current = penPts
  const [penOut, setPenOut] = useState<'stones' | 'line' | 'both'>('stones')
  useEffect(() => { if (tool !== 'pen') setPenPts([]) }, [tool])
  // Equal arc-length stepping at the panel's stone pitch; both ends get a
  // stone on an open path, a closed loop spaces n evenly with no doubled
  // start stone.
  const stonesAlongPath = useCallback((pts: Pt[], closed: boolean): Pt[] => {
    if (pts.length < 2) return pts.map((q) => ({ ...q }))
    const hole = sizes[curSize]?.holeMm ?? 3
    const rhythm = hole + Math.max(gap, hardGapOf(gap))
    const path = closed ? [...pts, pts[0]] : pts
    const segs: { a: Pt; b: Pt; len: number }[] = []
    let total = 0
    for (let i = 1; i < path.length; i++) {
      const len = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
      if (len < 1e-6) continue
      segs.push({ a: path[i - 1], b: path[i], len })
      total += len
    }
    if (!segs.length || total < rhythm * 0.5) return [{ ...pts[0] }]
    const n = Math.max(1, Math.round(total / rhythm))
    const step = total / n
    const count = closed ? n : n + 1
    const out: Pt[] = []
    let si = 0, acc = 0
    for (let k = 0; k < count; k++) {
      const target = Math.min(k * step, total - 1e-9)
      while (si < segs.length - 1 && acc + segs[si].len < target) { acc += segs[si].len; si++ }
      const t = Math.max(0, Math.min(1, (target - acc) / segs[si].len))
      out.push({ x: segs[si].a.x + (segs[si].b.x - segs[si].a.x) * t, y: segs[si].a.y + (segs[si].b.y - segs[si].a.y) * t })
    }
    return out
  }, [sizes, curSize, gap])
  const penPreview = useMemo(
    () => (tool === 'pen' && penPts.length > 1 ? stonesAlongPath(penPts, false) : []),
    [tool, penPts, stonesAlongPath],
  )
  const finishPen = useCallback((close: boolean) => {
    const raw = penPtsRef.current
    const pts: Pt[] = []
    for (const q of raw) {
      const l = pts[pts.length - 1]
      if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 0.3) pts.push(q) // dbl-click dup
    }
    setPenPts([])
    if (!raw.length) return // double-click with nothing drawn: not an error
    if (pts.length < 2) { setStatus('Pen needs at least two points — click along the line you want, then Enter'); return }
    pushUndo(stonesRef.current)
    const parts: string[] = []
    if (penOut !== 'line') {
      const placed = stonesAlongPath(pts, close)
      const el = nextEl()
      const next = [...stonesRef.current, ...placed.map((p): Stone => ({ x: p.x, y: p.y, size: curSize, layer: 'outline', el }))]
      stonesRef.current = next
      setStones(next)
      parts.push(`${placed.length} stones`)
    }
    if (penOut !== 'stones') {
      const path = close ? [...pts, { ...pts[0] }] : pts
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const q of path) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
      setVectors((prev) => [...prev, {
        id: vecSeq.current++,
        name: 'pen path',
        base: [path.map((q) => ({ x: q.x - minX, y: q.y - minY }))],
        baseW: maxX - minX,
        baseH: maxY - minY,
        x: minX,
        y: minY,
        s: 1,
      }])
      parts.push('1 cut line')
    }
    setStatus(`Pen: ${parts.join(' + ')} along the ${close ? 'closed' : 'open'} path — keep clicking for another, V to select`)
  }, [penOut, stonesAlongPath, curSize, pushUndo])

  const onCanvasDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault() // no text selection / native drag while moving stones
      // preventDefault also suppresses the browser's native focus transfer,
      // so a sidebar field could KEEP keyboard focus after a canvas click —
      // the user selects a design, presses Delete, and the keystroke edits
      // the Team Names box instead. Selecting on canvas reclaims the keys.
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) ae.blur()
      const p = toMm(e)
      if (tool === 'pen') {
        const first = penPtsRef.current[0]
        if (first && penPtsRef.current.length > 2 && Math.hypot(p.x - first.x, p.y - first.y) < Math.max(2, 8 / zoom)) {
          finishPen(true) // clicking back on the start closes the loop
          return
        }
        setPenPts((prev) => [...prev, p])
        return
      }
      if (tool === 'node') {
        const slopN = Math.max(0.5, 8 / zoom)
        if (nodeVec) {
          const v = nodeVec
          let hit: { pi: number; qi: number } | null = null
          let hd = slopN
          v.base.forEach((pl, pi) => pl.forEach((q, qi) => {
            const d = Math.hypot(q.x * v.s + v.x - p.x, q.y * v.s + v.y - p.y)
            if (d < hd) { hd = d; hit = { pi, qi } }
          }))
          if (hit) {
            const { pi, qi } = hit
            const key = `${pi}:${qi}`
            if (e.shiftKey) {
              setNodeSel((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n })
              return
            }
            const keys = nodeSelRef.current.has(key) ? nodeSelRef.current : new Set([key])
            setNodeSel(keys)
            nodeDrag.current = {
              vecId: v.id,
              p0: p,
              orig: { ...v, base: v.base.map((pl) => pl.map((q) => ({ ...q }))) },
              keys: expandClosedPairs(v, keys),
              moved: false,
            }
            if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
            return
          }
        }
        // no vertex under the cursor: pick which object to node-edit
        let bestV: number | null = null
        let bestD = slopN + 0.3
        for (const vv of vectors) {
          const d = distToPaths(vecPaths(vv), p)
          if (d < bestD) { bestD = d; bestV = vv.id }
        }
        setSelection(new Set())
        setSelVecs(bestV != null ? new Set([bestV]) : new Set())
        return
      }
      // Add mode gets NO hit slop: dense fills sit closer together than any
      // slop, so with slop every click in a gap "hit" a neighbour and erased
      // it — adding a hole between stones was impossible.
      const rot = hitRotateHandle(p)
      if (rot) {
        pushUndo(stonesRef.current)
        const center = { x: (rot.box.minX + rot.box.maxX) / 2, y: (rot.box.minY + rot.box.maxY) / 2 }
        rotRef.current = { kind: rot.kind, center, start: Math.atan2(p.y - center.y, p.x - center.x), origV: vectors.map((v) => ({ ...v })), origS: stonesRef.current }
        if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
        return
      }
      const handle = hitHandle(p)
      if (handle && selectedEl != null && selBox) {
        const r = elementsRef.current[selectedEl]
        pushUndo(stonesRef.current)
        resizeRef.current = { el: selectedEl, handle, box: selBox, sx0: r.sx, sy0: r.sy, fx: 1, fy: 1, timer: null }
        setResizeBox(selBox)
        if (svgRef.current) svgRef.current.style.cursor = handleCursor(handle)
        return
      }
      const vHandle = hitVecHandle(p)
      if (vHandle && selVecs.size && vecSelBox) {
        pushUndo(stonesRef.current)
        vecResize.current = { handle: vHandle, box: vecSelBox, orig: vectors.map((v) => ({ ...v })), moved: false }
        if (svgRef.current) svgRef.current.style.cursor = handleCursor(vHandle)
        return
      }
      const slop = tool === 'add' ? 0 : Math.max(0.5, HIT_SLOP_PX / zoom)
      const hit = pickStone(p, slop)
      if (tool === 'add') {
        if (hit === -1) {
          // "auto" matches whatever field the click lands in: a click inside
          // the fill picks up the fill stone's size and colour, a click along
          // the outline picks up the outline stone's — manual repairs blend in
          // instead of dropping an outline-sized stone into an SS6 fill
          let size = addSize === 'auto' ? curSize : addSize
          let color: string | undefined
          let layer: 'outline' | 'fill' = 'outline'
          if (stones.length) {
            // Nearest stone PER LAYER, outline favoured: a click in a gap ON
            // the outline ring is closer to the fill stone just inside it
            // than to its outline neighbours along the ring, so a plain
            // nearest-stone match painted outline repairs in fill colour.
            let bo = -1
            let boD = 15
            let bf = -1
            let bfD = 15
            for (let i = 0; i < stones.length; i++) {
              const d = Math.hypot(stones[i].x - p.x, stones[i].y - p.y)
              if ((stones[i].layer ?? 'outline') === 'fill') {
                if (d < bfD) { bfD = d; bf = i }
              } else if (d < boD) { boD = d; bo = i }
            }
            const best = bo >= 0 && (bf < 0 || boD <= bfD + 3) ? bo : bf
            let el: number | undefined
            if (best >= 0) {
              // blend in with the field being clicked into: layer, colour and
              // element always follow the neighbour; size only in Auto
              layer = stones[best].layer ?? 'outline'
              color = stones[best].color
              el = stones[best].el
              if (addSize === 'auto') size = stones[best].size
            }
            mutate((prev) => [...prev, { x: p.x, y: p.y, size, color, layer, el }])
            return
          }
          mutate((prev) => [...prev, { x: p.x, y: p.y, size, color, layer }])
        }
        else mutate((prev) => prev.filter((_, i) => i !== hit)) // click existing stone in add mode = remove
        return
      }
      if (hit === -1) {
        // a vector cut line under the cursor? nearest one within the slop
        let bestV: number | null = null
        let bestD = slop + 0.3
        for (const v of vectors) {
          const d = distToPaths(vecPaths(v), p)
          if (d < bestD) { bestD = d; bestV = v.id }
        }
        if (bestV != null) {
          setSelection(new Set())
          let ids: number[]
          if (e.shiftKey) {
            const n = new Set(selVecs)
            if (n.has(bestV)) n.delete(bestV); else n.add(bestV)
            setSelVecs(n)
            ids = [...n]
          } else if (selVecs.has(bestV)) {
            ids = [...selVecs] // drag moves the whole selection
          } else {
            setSelVecs(new Set([bestV]))
            ids = [bestV]
          }
          vecDrag.current = { ids, startX: p.x, startY: p.y, moved: false, orig: vectors.map((v) => ({ ...v })) }
          if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
          return
        }
        // a live preview under the cursor drags to reposition before Add —
        // it isn't a selectable object yet (it regenerates on every settings
        // change), but WHERE it lands is the user's call
        const pvPts: { x: number; y: number }[] | null =
          (previewLive && previewStones?.length ? previewStones : null)
          ?? imagePreview
          ?? (previewLive && textPreview ? textPreview.contours.flat() : null)
        if (pvPts?.length) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
          for (const q of pvPts) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
          const px = p.x - previewOffX, py = p.y - previewOffsetY
          if (px >= minX - 3 && px <= maxX + 3 && py >= minY - 3 && py <= maxY + 3) {
            if (previewBaseY == null) setPreviewBaseY(previewOffsetY) // pin: drag is absolute
            previewDragRef.current = { x: p.x, y: p.y }
            if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
            return
          }
        }
        if (!e.shiftKey) { setSelVecs(new Set()); setSelection(new Set()) }
        marqueeRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey }
        return
      }
      setSelVecs(new Set())
      setSelection((prev) => {
        const next = e.shiftKey ? new Set(prev) : prev.has(hit) ? new Set(prev) : new Set<number>()
        next.add(hit)
        return next
      })
      drag.current = { startX: p.x, startY: p.y, moved: false, orig: stones }
      if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
    },
    [toMm, stones, vectors, selVecs, tool, curSize, addSize, mutate, pickStone, zoom, hitHandle, hitVecHandle, hitRotateHandle, vecSelBox, selectedEl, selBox, pushUndo, nodeVec, finishPen, previewLive, previewStones, imagePreview, textPreview, previewOffX, previewOffsetY, previewBaseY],
  )
  const vecDrag = useRef<{ ids: number[]; startX: number; startY: number; moved: boolean; orig: VecItem[] } | null>(null)


  // The actual move logic. Called at most once per animation frame — raw
  // mousemove arrives faster than a heavy frame can render (a 5k-point
  // traced mascot paints ~200ms), and processing every event queued the
  // backlog into a freeze. onCanvasMove below coalesces to the latest.
  const processCanvasMove = useCallback(
    (e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }) => {
      ;(window as unknown as Record<string, unknown>).__mvDbg = ((window as unknown as Record<string, number>).__mvDbg ?? 0) + 1
      const pd = previewDragRef.current
      if (pd) {
        const p = toMm(e)
        setPreviewOffX((v) => v + (p.x - pd.x))
        setPreviewBaseY((v) => (v ?? 10) + (p.y - pd.y))
        previewDragRef.current = { x: p.x, y: p.y }
        return
      }
      const nd = nodeDrag.current
      if (nd) {
        const p = toMm(e)
        const dx = p.x - nd.p0.x, dy = p.y - nd.p0.y
        if (!nd.moved && Math.hypot(dx, dy) * zoom < 3) return
        if (!nd.moved) { nd.moved = true; pushUndo(stonesRef.current) }
        const o = nd.orig
        setVectors((prev) => prev.map((v) =>
          v.id === nd.vecId
            ? { ...v, base: o.base.map((pl, pi) => pl.map((q, qi) => (nd.keys.has(`${pi}:${qi}`) ? { x: q.x + dx / o.s, y: q.y + dy / o.s } : q))) }
            : v))
        return
      }
      if (marqueeRef.current && tool === 'select') {
        const p = toMm(e)
        marqueeRef.current.x1 = p.x
        marqueeRef.current.y1 = p.y
        setMarquee({ x0: marqueeRef.current.x0, y0: marqueeRef.current.y0, x1: p.x, y1: p.y })
        return
      }
      const rz = resizeRef.current
      if (rz) {
        const p = toMm(e)
        const b = rz.box
        const w0 = b.maxX - b.minX, h0 = b.maxY - b.minY
        const ax = rz.handle.includes('w') ? b.maxX : b.minX
        const ay = rz.handle.includes('n') ? b.maxY : b.minY
        const horiz = rz.handle.includes('e') || rz.handle.includes('w')
        const vert = rz.handle.includes('n') || rz.handle.includes('s')
        let fx = horiz ? Math.abs(p.x - ax) / w0 : 1
        let fy = vert ? Math.abs(p.y - ay) / h0 : 1
        // corners keep proportions; Shift sets the aspect free (the engine
        // regenerates from the scaled vectors, so stretching stays legal)
        if (horiz && vert && !e.shiftKey) fx = fy = (fx + fy) / 2
        fx = Math.max(fx, 5 / w0)
        fy = Math.max(fy, 5 / h0)
        rz.fx = fx; rz.fy = fy
        const w = w0 * fx, h = h0 * fy
        setResizeBox({
          minX: rz.handle.includes('w') ? b.maxX - w : b.minX,
          maxX: rz.handle.includes('w') ? b.maxX : b.minX + w,
          minY: rz.handle.includes('n') ? b.maxY - h : b.minY,
          maxY: rz.handle.includes('n') ? b.maxY : b.minY + h,
        })
        // re-stone live, but not on every pixel of movement
        if (rz.timer != null) window.clearTimeout(rz.timer)
        rz.timer = window.setTimeout(() => {
          rz.timer = null
          regenElement(rz.el, rz.sx0 * rz.fx, rz.sy0 * rz.fy, rz.box, rz.handle)
        }, 90)
        return
      }
      const rt = rotRef.current
      if (rt) {
        const p = toMm(e)
        let delta = Math.atan2(p.y - rt.center.y, p.x - rt.center.x) - rt.start
        if (e.shiftKey) delta = Math.round(delta / (Math.PI / 12)) * (Math.PI / 12)
        if (rt.kind === 'vec') setVectors(rt.origV.map((v) => (selVecs.has(v.id) ? bakeRotateVec(v, rt.center, delta) : v)))
        else setStones(rt.origS.map((st, i) => (selection.has(i) ? { ...st, ...rotatePt(st, rt.center, delta) } : st)))
        setStatus(`Rotate ${((delta * 180) / Math.PI).toFixed(0)}°${e.shiftKey ? '' : ' — hold Shift to snap to 15°'}`)
        return
      }
      const vr = vecResize.current
      if (vr) {
        const p = toMm(e)
        const b = vr.box
        const w0 = b.maxX - b.minX, h0 = b.maxY - b.minY
        const ax = vr.handle.includes('w') ? b.maxX : b.minX
        const ay = vr.handle.includes('n') ? b.maxY : b.minY
        const horiz = vr.handle.includes('e') || vr.handle.includes('w')
        const vert = vr.handle.includes('n') || vr.handle.includes('s')
        // side handles stretch ONE axis; corners stay proportional unless
        // Shift frees the aspect. VecItem has a single scale, so the x/y
        // ratio is baked into the base points — recomputed from vr.orig
        // every move, so nothing compounds.
        let fx = horiz ? Math.abs(p.x - ax) / w0 : 1
        let fy = vert ? Math.abs(p.y - ay) / h0 : 1
        if (horiz && vert && !e.shiftKey) fx = fy = (fx + fy) / 2
        fx = Math.max(fx, 5 / w0)
        fy = Math.max(fy, 5 / h0)
        const rx = fx / fy
        vr.moved = true
        setVectors(vr.orig.map((v) =>
          selVecs.has(v.id)
            ? {
                ...v,
                s: v.s * fy,
                x: ax + (v.x - ax) * fx,
                y: ay + (v.y - ay) * fy,
                base: rx === 1 ? v.base : v.base.map((pl) => pl.map((q) => ({ x: q.x * rx, y: q.y }))),
                baseW: v.baseW * rx,
              }
            : v))
        return
      }
      const vd = vecDrag.current
      if (vd) {
        const p = toMm(e)
        const dx = p.x - vd.startX, dy = p.y - vd.startY
        if (!vd.moved && Math.hypot(dx, dy) * zoom < 3) return
        if (!vd.moved) {
          vd.moved = true
          pushUndo(stonesRef.current)
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
          for (const v of vd.orig) {
            if (!vd.ids.includes(v.id)) continue
            const b = vecBox(v)
            minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
            maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
          }
          buildSnapTargets(new Set(vd.ids), new Set(), { minX, minY, maxX, maxY })
        }
        const { dx: sdx, dy: sdy } = applySnap(dx, dy, e.altKey)
        setVectors(vd.orig.map((v) => (vd.ids.includes(v.id) ? { ...v, x: v.x + sdx, y: v.y + sdy } : v)))
        return
      }
      if (!drag.current || tool !== 'select' || selection.size === 0) {
        // hover feedback: a hand over a stone says "this will move", a
        // resize arrow over a handle says "this will resize"
        if (tool === 'select' && svgRef.current && !drag.current) {
          const p = toMm(e)
          const rotH = hitRotateHandle(p)
          const h = rotH ? null : hitHandle(p) ?? hitVecHandle(p)
          const over = !rotH && !h && pickStone(p, Math.max(0.5, HIT_SLOP_PX / zoom)) >= 0
          svgRef.current.style.cursor = rotH ? 'grab' : h ? handleCursor(h) : over ? 'grab' : ''
        }
        return
      }
      const p = toMm(e)
      const dx = p.x - drag.current.startX
      const dy = p.y - drag.current.startY
      // 3 screen px before a click turns into a drag, at any zoom
      if (!drag.current.moved && Math.hypot(dx, dy) * zoom < 3) return
      if (!drag.current.moved) {
        drag.current.moved = true
        pushUndo(drag.current.orig)
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const i of selection) {
          const st = drag.current.orig[i]
          if (!st) continue
          const r = holeOf(st) / 2
          minX = Math.min(minX, st.x - r); minY = Math.min(minY, st.y - r)
          maxX = Math.max(maxX, st.x + r); maxY = Math.max(maxY, st.y + r)
        }
        buildSnapTargets(new Set(), new Set(selection), { minX, minY, maxX, maxY })
      }
      const orig = drag.current.orig
      const { dx: sdx, dy: sdy } = applySnap(dx, dy, e.altKey)
      setStones(orig.map((s, i) => (selection.has(i) ? { ...s, x: s.x + sdx, y: s.y + sdy } : s)))
    },
    [toMm, tool, selection, selVecs, pushUndo, pickStone, zoom, hitHandle, hitVecHandle, hitRotateHandle, regenElement, holeOf, buildSnapTargets, applySnap],
  )
  const moveEvtRef = useRef<{ clientX: number; clientY: number; altKey: boolean; shiftKey: boolean } | null>(null)
  const moveRafRef = useRef<number | null>(null)
  const onCanvasMove = useCallback((e: React.MouseEvent) => {
    moveEvtRef.current = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey, shiftKey: e.shiftKey }
    if (moveRafRef.current != null) return
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null
      if (moveEvtRef.current) processCanvasMove(moveEvtRef.current)
    })
  }, [processCanvasMove])

  const onCanvasUp = useCallback(() => {
    previewDragRef.current = null
    const nd = nodeDrag.current
    nodeDrag.current = null
    if (nd?.moved) setVectors((prev) => prev.map((v) => (v.id === nd.vecId ? renormalizeVec(v) : v)))
    snapRef.current = null
    setSnapLines((prev) => (prev.x != null || prev.y != null ? {} : prev))
    drag.current = null
    vecDrag.current = null
    vecResize.current = null
    rotRef.current = null
    if (svgRef.current) svgRef.current.style.cursor = ''
    const rz = resizeRef.current
    if (rz) {
      resizeRef.current = null
      if (rz.timer != null) window.clearTimeout(rz.timer)
      if (rz.fx !== 1 || rz.fy !== 1) regenElement(rz.el, rz.sx0 * rz.fx, rz.sy0 * rz.fy, rz.box, rz.handle)
      setResizeBox(null)
    }
    const mq = marqueeRef.current
    marqueeRef.current = null
    if (mq) {
      const x0 = Math.min(mq.x0, mq.x1)
      const x1 = Math.max(mq.x0, mq.x1)
      const y0 = Math.min(mq.y0, mq.y1)
      const y1 = Math.max(mq.y0, mq.y1)
      if (x1 - x0 > 0.5 || y1 - y0 > 0.5) {
        setSelection((prev) => {
          const next = mq.additive ? new Set(prev) : new Set<number>()
          stones.forEach((st, i) => {
            if (st.x >= x0 && st.x <= x1 && st.y >= y0 && st.y <= y1) next.add(i)
          })
          return next
        })
        setSelVecs((prev) => {
          const next = mq.additive ? new Set(prev) : new Set<number>()
          for (const v of vectors) {
            const b = vecBox(v)
            if (b.minX >= x0 && b.maxX <= x1 && b.minY >= y0 && b.maxY <= y1) next.add(v.id)
          }
          return next
        })
      }
    }
    setMarquee(null)
  }, [marquee, stones, vectors, regenElement])

  // A drag released over the sidebar or outside the window still ends.
  // Leaving the SVG used to cancel it mid-move; now the move continues until
  // the button comes up, wherever that is.
  useEffect(() => {
    const up = () => { if (drag.current || marqueeRef.current || resizeRef.current || vecDrag.current || nodeDrag.current) onCanvasUp() }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [onCanvasUp])

  // double-click a stone: select every stone chained to it — outline and fill
  // link at ~3.75mm, neighbouring stones at the rhythm, while a separate
  // design sits 10mm+ away and stays unselected
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const p = toMm(e)
      if (tool === 'pen') { finishPen(false); return }
      if (tool === 'node') {
        // double-click a segment of the edited object: insert a vertex there
        const v = nodeVec
        if (!v) return
        const slopN = Math.max(0.5, 8 / zoom)
        let best: { pi: number; i: number; q: Pt } | null = null
        let bestD = slopN
        v.base.forEach((pl, pi) => {
          for (let i = 1; i < pl.length; i++) {
            const A = { x: pl[i - 1].x * v.s + v.x, y: pl[i - 1].y * v.s + v.y }
            const B = { x: pl[i].x * v.s + v.x, y: pl[i].y * v.s + v.y }
            const dx = B.x - A.x, dy = B.y - A.y
            const len2 = dx * dx + dy * dy
            const t = len2 ? Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / len2)) : 0
            const d = Math.hypot(p.x - (A.x + t * dx), p.y - (A.y + t * dy))
            if (d < bestD) {
              bestD = d
              best = { pi, i, q: { x: pl[i - 1].x + t * (pl[i].x - pl[i - 1].x), y: pl[i - 1].y + t * (pl[i].y - pl[i - 1].y) } }
            }
          }
        })
        if (!best) return
        const { pi, i, q } = best
        pushUndo(stonesRef.current)
        setVectors((prev) => prev.map((vv) =>
          vv.id === v.id
            ? { ...vv, base: vv.base.map((pl, k) => (k === pi ? [...pl.slice(0, i), q, ...pl.slice(i)] : pl)) }
            : vv))
        setNodeSel(new Set([`${pi}:${i}`]))
        setStatus('Node added — drag it, Delete removes it')
        return
      }
      const start = pickStone(p, Math.max(0.5, HIT_SLOP_PX / zoom))
      if (start < 0) return
      // element-tagged designs select as a unit — free-moving layers
      if (stones[start].el != null) {
        const el = stones[start].el
        const inSet = new Set<number>()
        stones.forEach((st, i) => {
          if (st.el === el) inSet.add(i)
        })
        setSelection(inSet)
        setStatus(`Selected element: ${inSet.size} stones — drag to move, Del removes it`)
        return
      }
      const link = (a: Stone, b: Stone) =>
        Math.hypot(a.x - b.x, a.y - b.y) <= (holeOf(a) + holeOf(b)) / 2 + gap + 2.5
      const inSet = new Set<number>([start])
      const queue = [start]
      while (queue.length) {
        const i = queue.pop() as number
        for (let j = 0; j < stones.length; j++) {
          if (inSet.has(j)) continue
          if (link(stones[i], stones[j])) {
            inSet.add(j)
            queue.push(j)
          }
        }
      }
      setSelection(inSet)
      setStatus(`Selected design: ${inSet.size} stones — Del removes it`)
    },
    [toMm, stones, holeOf, gap, pickStone, zoom, tool, nodeVec, pushUndo, finishPen],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (tool === 'pen') {
        if (e.key === 'Enter') { finishPen(false); return }
        if (e.key === 'Escape') { setPenPts([]); setStatus('Pen cancelled'); return }
        if ((e.key === 'Backspace' || e.key === 'Delete') && penPtsRef.current.length) {
          setPenPts((prev) => prev.slice(0, -1))
          return
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'node' && nodeSel.size && nodeVec) {
        // remove the selected nodes, not the whole object — the node tool's
        // Delete must win over the object-level delete below
        const v = nodeVec
        const keys = expandClosedPairs(v, nodeSel)
        mutateVectors((prev) => prev.flatMap((vv) => {
          if (vv.id !== v.id) return [vv]
          const base: Pt[][] = []
          vv.base.forEach((pl, pi) => {
            const n = pl.length
            const closed = n > 3 && Math.hypot(pl[0].x - pl[n - 1].x, pl[0].y - pl[n - 1].y) < 1e-6
            let pts = pl.filter((_, qi) => !keys.has(`${pi}:${qi}`))
            if (closed && keys.has(`${pi}:0`) && pts.length >= 3) pts = [...pts, { ...pts[0] }]
            if (pts.length >= (closed ? 4 : 2)) base.push(pts)
          })
          return base.length ? [renormalizeVec({ ...vv, base })] : []
        }))
        setNodeSel(new Set())
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
        mutate((prev) => prev.filter((_, i) => !selection.has(i)))
        setSelection(new Set())
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selVecs.size) {
        mutateVectors((prev) => prev.filter((v) => !selVecs.has(v.id)))
        setSelVecs(new Set())
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && pending > 0) {
        // nothing selected but previews pending: Delete means "get rid of
        // what I'm looking at"
        discardPreviews()
      }
      // arrow keys nudge the selection: 0.5 mm, Shift = 5 mm
      const nudge = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key]
      if (nudge && selection.size) {
        e.preventDefault()
        const step = e.shiftKey ? 5 : 0.5
        const [nx, ny] = nudge
        mutate((prev) => prev.map((s, i) => (selection.has(i) ? { ...s, x: s.x + nx * step, y: s.y + ny * step } : s)))
      } else if (nudge && selVecs.size) {
        e.preventDefault()
        const step = e.shiftKey ? 5 : 0.5
        const [nx, ny] = nudge
        mutateVectors((prev) => prev.map((v) => (selVecs.has(v.id) ? { ...v, x: v.x + nx * step, y: v.y + ny * step } : v)))
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        setSelection(new Set(stones.map((_, i) => i)))
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAbout(zoomRef.current * 1.25) }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); zoomAbout(zoomRef.current / 1.25) }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); fitSheet() }
      if (!e.metaKey && !e.ctrlKey && (e.key === 'f' || e.key === 'F')) fitDesign()
      if (!e.metaKey && !e.ctrlKey && (e.key === 'v' || e.key === 'V')) setTool('select')
      if (!e.metaKey && !e.ctrlKey && (e.key === 'n' || e.key === 'N')) setTool('node')
      if (!e.metaKey && !e.ctrlKey && (e.key === 'a' || e.key === 'A')) setTool('add')
      if (!e.metaKey && !e.ctrlKey && (e.key === 'p' || e.key === 'P')) setTool('pen')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, stones, mutate, zoomAbout, fitSheet, fitDesign, selVecs, mutateVectors, tool, nodeSel, nodeVec, undo, redo, finishPen, pending, discardPreviews])

  // ---------- material presets ----------
  const preset = presets[presetIdx] ?? presets[0]
  const linePresetIdx = linePresetName ? presets.findIndex((p) => p.name === linePresetName) : -1
  // the lines' preset object is the holes' very object when they share one,
  // which is how the exporters know not to re-send conditions
  const linePreset = linePresetIdx >= 0 ? presets[linePresetIdx] : preset
  const updatePresetAt = useCallback((idx: number, patch: Partial<MaterialPreset>) => {
    setPresets((prev) => {
      const next = prev.map((p, i) => (i === idx ? { ...p, ...patch } : p))
      localStorage.setItem('stonecut.presets', JSON.stringify(next))
      return next
    })
  }, [])
  const updatePreset = useCallback((patch: Partial<MaterialPreset>) => updatePresetAt(presetIdx, patch), [updatePresetAt, presetIdx])
  const presetLabel = (p: MaterialPreset) => `${p.name} · force ${p.force} · speed ${p.speed}${p.passes > 1 ? ` · ${p.passes} passes` : ''}`
  const addPreset = useCallback(() => {
    const name = prompt('Preset name?')
    if (!name) return
    setPresets((prev) => {
      const next = [...prev, { ...preset, name }]
      localStorage.setItem('stonecut.presets', JSON.stringify(next))
      setPresetIdx(next.length - 1)
      return next
    })
  }, [preset])

  // ---------- spacing audit ----------
  // Generation can't place an illegal stone, but manual drags can. Audit on
  // demand (and in the cut confirmation) so a crowded pair never reaches
  // the flock.
  const spacingAudit = useMemo(() => {
    if (!stones.length) return { involved: [], removal: [] }
    return findOverlaps(stones, (s) => holeOf(s), hardGapOf(gap))
  }, [stones, holeOf, gap])
  const showOverlaps = useCallback(() => {
    if (!spacingAudit.involved.length) { setStatus('Spacing is clean — every gap is at or above the floor'); return }
    setSelVecs(new Set())
    setSelection(new Set(spacingAudit.involved))
    setStatus(`${spacingAudit.involved.length} stones sit closer than the ${hardGapOf(gap).toFixed(1)} mm floor — selected. Fix removes ${spacingAudit.removal.length}.`)
  }, [spacingAudit, gap])
  const fixOverlaps = useCallback(() => {
    if (!spacingAudit.removal.length) return
    const kill = new Set(spacingAudit.removal)
    mutate((prev) => prev.filter((_, i) => !kill.has(i)))
    setSelection(new Set())
    setStatus(`Removed ${kill.size} crowding stones — spacing is legal again (⌘Z restores)`) 
  }, [spacingAudit, mutate])

  // display colour of a stone, exactly as the canvas paints it
  const colorOfStone = useCallback(
    (st: Stone) => st.color ?? ((st.layer ?? 'outline') === 'fill' ? fillColor : outlineColor),
    [fillColor, outlineColor],
  )

  // ---------- cut / export ----------
  // Cut layers: outline and fill are separate physical cuts, but BOTH use the
  // full design's frame so the two templates register when stacked.
  // Beyond outline/fill/lines, a multi-color or multi-size design can be
  // cut as one template PER COLOR or PER SIZE ('color:<hex>' / 'size:<key>')
  // — the operator brushes each color into its own template, and every
  // template shares the full design's frame so they register when stacked.
  const [cutLayer, setCutLayer] = useState<string>('all')
  // Weeding frame: one rectangle cut around the arrangement so the template
  // peels cleanly off the roll. Export-time only — it wraps whichever layer
  // is being cut, and cuts LAST so the sheet stays anchored.
  const [frameOn, setFrameOn] = useState(() => localStorage.getItem('stonecut.frame') === '1')
  useEffect(() => { localStorage.setItem('stonecut.frame', frameOn ? '1' : '0') }, [frameOn])
  const [frameMm, setFrameMm] = useState(() => {
    const v = +(localStorage.getItem('stonecut.framemm') ?? 5)
    return isFinite(v) && v >= 1 ? v : 5
  })
  useEffect(() => { localStorage.setItem('stonecut.framemm', String(frameMm)) }, [frameMm])
  const cutColors = useMemo(() => {
    const m = new Map<string, number>()
    for (const st of stones) { const c = colorOfStone(st); m.set(c, (m.get(c) ?? 0) + 1) }
    return [...m.entries()]
  }, [stones, colorOfStone])
  const cutSizes = useMemo(() => {
    const m = new Map<string, number>()
    for (const st of stones) m.set(st.size, (m.get(st.size) ?? 0) + 1)
    return [...m.entries()]
  }, [stones])
  // a vanished option (colour edited away, size regenerated out) falls back
  useEffect(() => {
    if (cutLayer.startsWith('color:') && !cutColors.some(([c]) => `color:${c}` === cutLayer)) setCutLayer('all')
    if (cutLayer.startsWith('size:') && !cutSizes.some(([s]) => `size:${s}` === cutLayer)) setCutLayer('all')
  }, [cutLayer, cutColors, cutSizes])
  // Anything highlighted on the board is what cuts; with nothing selected the
  // Layer picker decides. The selection's own vector lines come along, so a
  // highlighted vector cuts on its own and a highlighted design cuts without
  // the vinyl shapes sitting next to it.
  const selectionCut = selection.size > 0 || selVecs.size > 0
  const cutJob = useMemo(
    () =>
      selectionCut
        ? {
            ...job,
            stones: job.stones.filter((_, i) => selection.has(i)),
            paths: (job.paths ?? []).filter((_, i) => selVecs.has(job.pathOwner[i])),
          }
        : cutLayer === 'all'
        ? job
        : cutLayer === 'lines'
          ? { ...job, stones: [] }
          : cutLayer.startsWith('color:')
            ? { ...job, stones: job.stones.filter((st) => colorOfStone(st) === cutLayer.slice(6)), paths: [] }
            : cutLayer.startsWith('size:')
              ? { ...job, stones: job.stones.filter((st) => st.size === cutLayer.slice(5)), paths: [] }
              : { ...job, stones: job.stones.filter((st) => (st.layer ?? 'outline') === cutLayer), paths: [] },
    [job, cutLayer, colorOfStone, selectionCut, selection, selVecs],
  )
  // filenames: 'color:#dc2034' -> 'color-dc2034'
  const cutLayerSlug = selectionCut ? 'selection' : cutLayer.replace(/[:#]/g, '-').replace(/--+/g, '-')
  const framedCutJob = useMemo(() => {
    if (!frameOn) return cutJob
    // frame bbox comes from the FULL job, never the filtered layer — a
    // per-colour bbox would give every template a different frame and the
    // stack couldn't register by its edges
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of job.stones) {
      const r = (job.sizes[s.size]?.holeMm ?? 3) / 2
      minX = Math.min(minX, s.x - r); minY = Math.min(minY, s.y - r)
      maxX = Math.max(maxX, s.x + r); maxY = Math.max(maxY, s.y + r)
    }
    for (const p of job.paths ?? []) for (const q of p) {
      minX = Math.min(minX, q.x); minY = Math.min(minY, q.y)
      maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y)
    }
    if (!isFinite(minX)) return cutJob
    const m = Math.max(1, frameMm)
    const x0 = minX - m, y0 = minY - m, x1 = maxX + m, y1 = maxY + m
    const frame = [
      { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 },
    ]
    return {
      ...cutJob,
      // the frame may poke past the sheet datum in from-origin mode — grow
      // the job frame so the exporters' Y-flip datum still covers it
      widthMm: Math.max(cutJob.widthMm, x1 + m),
      heightMm: Math.max(cutJob.heightMm, y1 + m),
      paths: [...(cutJob.paths ?? []), frame],
    }
  }, [cutJob, job, frameOn, frameMm])
  const cutCount = framedCutJob.stones.length + (framedCutJob.paths?.length ?? 0)
  const layerCounts = useMemo(() => {
    let o = 0
    let f = 0
    for (const st of stones) ((st.layer ?? 'outline') === 'fill' ? f++ : o++)
    return { o, f }
  }, [stones])
  const cutData = useCallback(
    () =>
      format === 'gpgl'
        ? toGPGL(framedCutJob, preset, originCorner, gpStep, sendConditions, swapAxes, { firmwareCircles: wCircles, overcutMm: overcut, linePreset })
        : toHPGL(framedCutJob, preset, originCorner, { overcutMm: overcut, linePreset }),
    [format, framedCutJob, preset, linePreset, originCorner, gpStep, sendConditions, swapAxes, wCircles, overcut],
  )

  // Cut goes through an in-app confirmation (styled like the rest of the
  // panel, not a browser card). Chrome's own device chooser only appears the
  // first time; after that the granted cutter is reopened silently.
  const [cutConfirm, setCutConfirm] = useState<{ device: string | null } | null>(null)
  const doSend = useCallback(async () => {
    if (!cutCount) { setStatus('Nothing to cut'); return }
    const d = await grantedCutter()
    setCutConfirm({ device: d?.name ?? null })
  }, [cutCount])
  const doSendNow = useCallback(async () => {
    setCutConfirm(null)
    try {
      setStatus('Connecting to cutter…')
      await sendToCutter(cutData(), (sent, total) =>
        setStatus(`Cutting… ${Math.round((sent / total) * 100)}%`),
      )
      setStatus('Job sent ✓')
    } catch (e) {
      setStatus(`Send failed: ${e instanceof Error ? e.message : e}`)
    }
  }, [cutData])

  // The fill colour picker recolours the EXISTING fill layer live — colour
  // was baked into each stone at generation, so the picker otherwise only
  // affected future stones ("fill color changes doesnt work"). No undo entry:
  // dragging the picker fires a change per frame.
  useEffect(() => {
    setStones((prev) => {
      if (!prev.some((st) => (st.layer ?? 'outline') === 'fill' && st.color !== fillColor)) return prev
      const next = prev.map((st) =>
        (st.layer ?? 'outline') === 'fill' ? { ...st, color: fillColor } : st,
      )
      // recolouring must not break the regenerate-in-place link
      if (lastImageRef.current && lastImageRef.current.after === prev)
        lastImageRef.current = { ...lastImageRef.current, after: next }
      return next
    })
  }, [fillColor])
  useEffect(() => {
    setStones((prev) => {
      if (!prev.some((st) => (st.layer ?? 'outline') === 'outline' && st.color !== outlineColor)) return prev
      const next = prev.map((st) =>
        (st.layer ?? 'outline') === 'outline' ? { ...st, color: outlineColor } : st,
      )
      // recolouring must not break the regenerate-in-place link
      if (lastImageRef.current && lastImageRef.current.after === prev)
        lastImageRef.current = { ...lastImageRef.current, after: next }
      return next
    })
  }, [outlineColor])

  // Scale stones about their centroid — the selection if there is one, the
  // whole design otherwise. Positions scale; stone sizes don't (they're
  // physical). Works whether or not the design is still regenerable.
  const [scalePct, setScalePct] = useState(100)
  const applyScale = useCallback(() => {
    const f = scalePct / 100
    if (!Number.isFinite(f) || f <= 0.05 || f === 1) return
    mutate((prev) => {
      const idxs = selection.size ? [...selection] : prev.map((_, i) => i)
      if (!idxs.length) return prev
      let cx = 0
      let cy = 0
      for (const i of idxs) {
        cx += prev[i].x
        cy += prev[i].y
      }
      cx /= idxs.length
      cy /= idxs.length
      const inSel = new Set(idxs)
      return prev.map((st, i) =>
        inSel.has(i) ? { ...st, x: cx + (st.x - cx) * f, y: cy + (st.y - cy) * f } : st,
      )
    })
    setStatus(
      `Scaled ${selection.size || 'all'} stones to ${scalePct}%` +
        (scalePct < 100 ? ' — check spacing (⌘Z to undo)' : ''),
    )
  }, [scalePct, selection, mutate])

  // Even out fill spacing after manual edits: fill stones closer than their
  // legal pitch (to anything) push apart in small damped steps; outline
  // stones never move, so the design's edge stays exactly where it was cut.
  const respaceFill = useCallback(() => {
    mutate((prev) => {
      const pts = prev.map((st) => ({ ...st }))
      const orig = prev
      const holeMm = (st: Stone) => sizes[st.size]?.holeMm ?? 3
      const hardGap = hardGapOf(gap)
      const maxDrift = (sizes[fillSize]?.holeMm ?? 2.5) + gap // stay near home
      for (let it = 0; it < 80; it++) {
        let moved = false
        for (let i = 0; i < pts.length; i++) {
          if ((pts[i].layer ?? 'outline') !== 'fill') continue
          let dx = 0
          let dy = 0
          for (let j = 0; j < pts.length; j++) {
            if (j === i) continue
            const ddx = pts[i].x - pts[j].x
            const ddy = pts[i].y - pts[j].y
            const d = Math.hypot(ddx, ddy)
            const need = (holeMm(pts[i]) + holeMm(pts[j])) / 2 + hardGap
            if (d > need) continue
            if (d < 1e-9) {
              dx += 0.05 * ((i % 3) - 1)
              dy += 0.05 * (((i + 1) % 3) - 1)
              moved = true
              continue
            }
            const push = ((need - d) / 2) * 0.85
            dx += (ddx / d) * push
            dy += (ddy / d) * push
            moved = true
          }
          if (dx || dy) {
            const nx = pts[i].x + dx
            const ny = pts[i].y + dy
            // a stone that would have to travel far has no legal home — leave
            // it; the user can delete it rather than have it wander
            if (Math.hypot(nx - orig[i].x, ny - orig[i].y) <= maxDrift) {
              pts[i].x = nx
              pts[i].y = ny
            }
          }
        }
        if (!moved) break
      }
      return pts
    })
    setStatus('Fill respaced — crowded fill stones eased apart')
  }, [mutate, sizes, gap, fillSize])

  // ---------- production: stone counts + work order ----------
  const bom = useMemo(() => stoneBom(stones, sizes, colorOfStone), [stones, sizes, colorOfStone])
  const printWorkOrder = useCallback(() => {
    const html = workOrderHtml(job, bom, colorOfStone, {
      title: `${stones.length} stones · ${new Date().toLocaleDateString()}`,
      boardLabel: `${boardWIn}″ × ${boardHIn}″, origin lower-${originCorner === 'br' ? 'right' : 'left'}`,
      material: presetLabel(preset) + (job.paths?.length && linePreset !== preset ? ` · lines: ${presetLabel(linePreset)}` : ''),
      nameOf: colorName,
    })
    const win = window.open('', '_blank')
    if (!win) { setStatus('Pop-up blocked — allow pop-ups for this site to print'); return }
    win.document.write(html)
    win.document.close()
  }, [job, bom, colorOfStone, stones.length, boardWIn, boardHIn, originCorner, preset])

  const printPlacementGuide = useCallback(() => {
    const html = placementGuideHtml(job, colorOfStone, `${stones.length} stones · ${new Date().toLocaleDateString()}`)
    const win = window.open('', '_blank')
    if (!win) { setStatus('Pop-up blocked — allow pop-ups for this site to print'); return }
    win.document.write(html)
    win.document.close()
  }, [job, colorOfStone, stones.length])


  // garment mockup: redraw whenever it's open and anything it shows changes
  useEffect(() => {
    if (!mockupOpen) return
    const cv = mockupCanvasRef.current
    if (!cv) return
    const mkStones = stones.map((s) => ({
      x: s.x,
      y: s.y,
      // show the STONE, not the template hole — the hole is oversized
      rMm: ((sizes[s.size]?.stoneMm || (sizes[s.size]?.holeMm ?? 3) * 0.85) / 2),
      color: colorOfStone(s),
    }))
    const mkPaths = vectors.flatMap(vecPaths)
    if (mkMode === 'photo') {
      if (mkImgRef.current) drawMockupPhoto(cv, mkImgRef.current, mkSpan, chestIn, mkOff, mkStones, mkPaths)
      else if (mkStyle) drawMockupEmpty(cv, ['Loading the product photo…', `${mkStyle.brand} ${mkStyle.name}`])
      else drawMockupEmpty(cv, ['Search an S&S style above to mock up', 'on a real product photo —', 'or switch to Illustration.'])
    } else {
      drawMockup(cv, garmentColor, chestIn, dropIn, mkStones, mkPaths, mkOff)
    }
  }, [mockupOpen, garmentColor, chestIn, dropIn, stones, sizes, colorOfStone, vectors, mkMode, mkStyle, mkSpan, mkOff, mkImgTick])
  const downloadMockup = useCallback(() => {
    mockupCanvasRef.current?.toBlob((b) => {
      if (!b) return
      const url = URL.createObjectURL(b)
      const a = document.createElement('a')
      a.href = url
      a.download = 'stonecut-mockup.png'
      a.click()
      URL.revokeObjectURL(url)
    })
  }, [])

  // ---------- production: duplicate / copy-paste / step & repeat ----------
  // Materialise copies of the current selection (or the whole design when
  // nothing is selected) at each offset. Stone elements get fresh element
  // ids + recipe copies so every copy moves/resizes independently; vectors
  // share their base arrays (all edits replace base immutably).
  const materializeCopies = useCallback(
    (offsets: Pt[], selectCopies: boolean) => {
      const stoneIdx = selection.size
        ? [...selection]
        : selVecs.size ? [] : stones.map((_, i) => i)
      const vecIds = selVecs.size ? [...selVecs] : selection.size ? [] : vectors.map((v) => v.id)
      const srcStones = stoneIdx.map((i) => stones[i]).filter(Boolean)
      const srcVecs = vectors.filter((v) => vecIds.includes(v.id))
      if (!srcStones.length && !srcVecs.length) { setStatus('Nothing to copy — add or select a design first'); return }
      pushUndo(stonesRef.current)
      const els = [...new Set(srcStones.map((s) => s.el).filter((e): e is number => e != null))]
      const newStones: Stone[] = []
      const addElements: Elements = {}
      for (const off of offsets) {
        const elMap = new Map<number, number>()
        for (const e of els) {
          const ne = nextEl()
          elMap.set(e, ne)
          const r = elementsRef.current[e]
          if (r) addElements[ne] = { ...r, contours: r.contours.map((c) => c.map((q) => ({ ...q }))) }
        }
        for (const s of srcStones)
          newStones.push({ ...s, x: s.x + off.x, y: s.y + off.y, el: s.el != null ? elMap.get(s.el) : undefined })
      }
      const newVecs: VecItem[] = []
      for (const off of offsets)
        for (const v of srcVecs)
          newVecs.push({ ...v, id: vecSeq.current++, x: v.x + off.x, y: v.y + off.y })
      const baseLen = stones.length
      if (newStones.length) {
        const next = [...stones, ...newStones]
        stonesRef.current = next
        setStones(next)
      }
      if (Object.keys(addElements).length) setElements((prev) => ({ ...prev, ...addElements }))
      if (newVecs.length) setVectors((prev) => [...prev, ...newVecs])
      if (selectCopies) {
        setSelection(new Set(newStones.map((_, i) => baseLen + i)))
        setSelVecs(new Set(newVecs.map((v) => v.id)))
      }
      return { stones: newStones.length, vecs: newVecs.length, copies: offsets.length }
    },
    [selection, selVecs, stones, vectors, pushUndo],
  )
  const duplicateSelection = useCallback(() => {
    const r = materializeCopies([{ x: 5, y: 5 }], true)
    if (r) setStatus(`Duplicated — ${r.stones ? `${r.stones} stones` : ''}${r.stones && r.vecs ? ' + ' : ''}${r.vecs ? `${r.vecs} cut-line object${r.vecs === 1 ? '' : 's'}` : ''} (5 mm offset)`)
  }, [materializeCopies])
  // internal clipboard: absolute-position snapshot; each paste lands 8 mm
  // further so repeated pastes don't stack invisibly
  const clipRef = useRef<{ stones: Stone[]; vecs: VecItem[]; elements: Elements; pastes: number } | null>(null)
  const copySelection = useCallback(() => {
    const stoneIdx = [...selection]
    const srcStones = stoneIdx.map((i) => stones[i]).filter(Boolean)
    const srcVecs = vectors.filter((v) => selVecs.has(v.id))
    if (!srcStones.length && !srcVecs.length) { setStatus('Select something to copy first'); return }
    const els = [...new Set(srcStones.map((s) => s.el).filter((e): e is number => e != null))]
    const elements: Elements = {}
    for (const e of els) if (elementsRef.current[e]) elements[e] = elementsRef.current[e]
    clipRef.current = { stones: srcStones.map((s) => ({ ...s })), vecs: srcVecs.map((v) => ({ ...v })), elements, pastes: 0 }
    setStatus(`Copied ${srcStones.length ? `${srcStones.length} stones` : ''}${srcStones.length && srcVecs.length ? ' + ' : ''}${srcVecs.length ? `${srcVecs.length} cut-line object${srcVecs.length === 1 ? '' : 's'}` : ''}`)
  }, [selection, selVecs, stones, vectors])
  const pasteClipboard = useCallback(() => {
    const clip = clipRef.current
    if (!clip) return // silent: a system-image paste is handled by the paste listener
    clip.pastes++
    const off = 8 * clip.pastes
    pushUndo(stonesRef.current)
    const els = [...new Set(clip.stones.map((s) => s.el).filter((e): e is number => e != null))]
    const elMap = new Map<number, number>()
    const addElements: Elements = {}
    for (const e of els) {
      const ne = nextEl()
      elMap.set(e, ne)
      const r = clip.elements[e]
      if (r) addElements[ne] = { ...r, contours: r.contours.map((c) => c.map((q) => ({ ...q }))) }
    }
    const fresh = clip.stones.map((s) => ({ ...s, x: s.x + off, y: s.y + off, el: s.el != null ? elMap.get(s.el) : undefined }))
    const freshVecs = clip.vecs.map((v) => ({ ...v, id: vecSeq.current++, x: v.x + off, y: v.y + off }))
    const baseLen = stonesRef.current.length
    if (fresh.length) {
      const next = [...stonesRef.current, ...fresh]
      stonesRef.current = next
      setStones(next)
    }
    if (Object.keys(addElements).length) setElements((prev) => ({ ...prev, ...addElements }))
    if (freshVecs.length) setVectors((prev) => [...prev, ...freshVecs])
    setSelection(new Set(fresh.map((_, i) => baseLen + i)))
    setSelVecs(new Set(freshVecs.map((v) => v.id)))
    setStatus('Pasted')
  }, [pushUndo])
  // step & repeat: grid of copies pitched at selection size + gap
  const [repCols, setRepCols] = useState(2)
  const [repRows, setRepRows] = useState(2)
  const [repGap, setRepGap] = useState(10)
  const stepAndRepeat = useCallback(() => {
    // bbox of what will be copied (same selection rules as materializeCopies)
    const stoneIdx = selection.size ? [...selection] : selVecs.size ? [] : stones.map((_, i) => i)
    const vecIds = selVecs.size ? [...selVecs] : selection.size ? [] : vectors.map((v) => v.id)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const i of stoneIdx) {
      const st = stones[i]
      if (!st) continue
      const r = holeOf(st) / 2
      minX = Math.min(minX, st.x - r); minY = Math.min(minY, st.y - r)
      maxX = Math.max(maxX, st.x + r); maxY = Math.max(maxY, st.y + r)
    }
    for (const v of vectors) {
      if (!vecIds.includes(v.id)) continue
      const b = vecBox(v)
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
    }
    if (!isFinite(minX)) { setStatus('Nothing to repeat — add or select a design first'); return }
    const pitchX = maxX - minX + repGap
    const pitchY = maxY - minY + repGap
    const offsets: Pt[] = []
    for (let r = 0; r < Math.max(1, repRows); r++)
      for (let c = 0; c < Math.max(1, repCols); c++)
        if (r || c) offsets.push({ x: c * pitchX, y: r * pitchY })
    if (!offsets.length) { setStatus('Set columns or rows above 1 to repeat'); return }
    const res = materializeCopies(offsets, false)
    if (!res) return
    const fullW = maxX - minX + pitchX * (repCols - 1)
    const fullH = maxY - minY + pitchY * (repRows - 1)
    setStatus(
      `Repeated ${repCols} × ${repRows} — ${res.copies} cop${res.copies === 1 ? 'y' : 'ies'} added, layout ${(fullW / 25.4).toFixed(1)}″ × ${(fullH / 25.4).toFixed(1)}″` +
      (minX + fullW > boardWmm || minY + fullH > boardHmm ? ' — runs past the board!' : ''),
    )
  }, [selection, selVecs, stones, vectors, holeOf, repCols, repRows, repGap, materializeCopies, boardWmm, boardHmm])

  // ⌘D / ⌘C / ⌘V — separate listener so it can sit after the callbacks
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'd') { e.preventDefault(); duplicateSelection() }
      else if (e.key === 'c') copySelection()
      else if (e.key === 'v') pasteClipboard()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [duplicateSelection, copySelection, pasteClipboard])

  const sizeKeys = Object.keys(sizes)
  // memoised: a fresh object every render made the stone-canvas effect
  // repaint ALL stones on every unrelated state change
  const stoneColor = useMemo(() => {
    const m: Record<string, string> = {}
    sizeKeys.forEach((k, i) => { m[k] = `hsl(${(i * 47) % 360} 70% 60%)` })
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeKeys.join(',')])

  // Cached path data per cut-line object. Rebuilding the d string from a
  // 30 000-point traced mascot on EVERY render (every drag mousemove) froze
  // the app; the base array is immutable, so the string is cached by
  // reference and the browser skips re-parsing an unchanged attribute.
  const vecDCache = useRef(new WeakMap<Pt[][], string>())
  const vecD = useCallback((base: Pt[][]): string => {
    let d = vecDCache.current.get(base)
    if (!d) { d = pathsToD(base); vecDCache.current.set(base, d) }
    return d
  }, [])

  // workspace always fills the viewport; grows past it when the design does
  const previewW = previewLive && textPreview ? textPreview.widthMm + 30 : 0
  const previewH = previewLive && textPreview ? previewOffsetY + textHeight + 20 : 0
  const canvasW = Math.max(job.widthMm + 20, previewW, avail.w / zoom, boardWmm + 20)
  const canvasH = Math.max(job.heightMm + 20, previewH, (avail.h - 36) / zoom, boardHmm + 20)

  // BITMAP STONE LAYER. Thousands of SVG <circle> nodes made the browser
  // repaint the whole vector tree on every scroll and re-reconcile it on
  // every state change — large designs crawled. One canvas paint replaces
  // all of them; the SVG keeps only the grid, preview path, and events.
  useEffect(() => {
    const cv = stoneCanvasRef.current
    if (!cv) return
    const cssW = canvasW * zoom
    const cssH = canvasH * zoom
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.style.width = `${cssW}px`
    cv.style.height = `${cssH}px`
    cv.width = Math.round(cssW * dpr)
    cv.height = Math.round(cssH * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    const dot = (x: number, y: number, r: number, fill: string, alpha: number, ring?: string) => {
      ctx.globalAlpha = alpha
      ctx.fillStyle = fill
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      if (ring) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = ring
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }
    for (const p of imagePreview ?? [])
      dot((p.x + previewOffX) * zoom, (p.y + previewOffsetY) * zoom, ((sizes[p.size ?? curSize]?.holeMm ?? 3) / 2) * zoom, p.color ?? '#8fb0ff', 0.55)
    if (previewLive)
      for (const p of previewStones ?? [])
        dot((p.x + previewOffX) * zoom, (p.y + previewOffsetY) * zoom, ((sizes[p.size ?? curSize]?.holeMm ?? 3) / 2) * zoom, p.color ?? '#8fb0ff', 0.55)
    stones.forEach((s, i) => {
      const color = s.color ?? ((s.layer ?? 'outline') === 'fill' ? fillColor : outlineColor)
      const x = s.x * zoom, y = s.y * zoom, r = (holeOf(s) / 2) * zoom
      if (simView) {
        drawGem(ctx, x, y, r, color)
        if (selection.has(i)) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(x, y, r, 0, Math.PI * 2)
          ctx.stroke()
        }
      } else {
        dot(x, y, r, color, 0.85, selection.has(i) ? '#fff' : undefined)
      }
    })
    ctx.globalAlpha = 1
  }, [stones, selection, imagePreview, previewStones, previewLive, zoom, canvasW, canvasH, previewOffsetY, previewOffX, sizes, curSize, holeOf, stoneColor, fillColor, outlineColor, simView])

  const previewPath = useMemo(() => {
    if (!textPreview) return ''
    return textPreview.contours
      .map(
        (c) =>
          'M' +
          c.map((p) => `${((p.x + previewOffX) * zoom).toFixed(1)},${((p.y + previewOffsetY) * zoom).toFixed(1)}`).join('L') +
          'Z',
      )
      .join('')
  }, [textPreview, zoom, previewOffsetY, previewOffX])

  // ---------- vector cuts ----------
  // Put a set of mm polylines on the board as a cut-line item. Closed shapes
  // get their last point joined back to the first so the blade finishes the
  // loop. `at` is the top-left in board mm; default is below the design.
  const addVector = useCallback((paths: Pt[][], name: string, at?: Pt) => {
    const closed = paths.map((pl) => {
      if (pl.length < 3) return pl
      const a = pl[0], b = pl[pl.length - 1]
      return Math.hypot(a.x - b.x, a.y - b.y) > 0.01 ? [...pl, { x: a.x, y: a.y }] : pl
    })
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const pl of closed) for (const q of pl) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
    if (!isFinite(minX)) { setStatus('Nothing to cut in that'); return null }
    const base = closed.map((pl) => pl.map((q) => ({ x: q.x - minX, y: q.y - minY })))
    const w = maxX - minX, h = maxY - minY
    const sc = Math.min(1, (boardWmm - 20) / w, (boardHmm - 20) / h)
    const id = vecSeq.current++
    const below = stones.length || vectors.length ? bbox.maxY + 10 : 10
    const y = at ? at.y : Math.max(10, Math.min(below, boardHmm - h * sc - 10))
    const x = at ? at.x : 10
    mutateVectors((prev) => [...prev, { id, name, base, baseW: w, baseH: h, x, y, s: sc }])
    setSelVecs(new Set([id]))
    setSelection(new Set())
    return { id, w, h, scale: sc, lines: base.length }
  }, [boardWmm, boardHmm, stones.length, vectors.length, bbox.maxY, mutateVectors])
  // Text as cut lines: the same font outlines the stone preview is drawn
  // from, placed exactly where the preview shows, cut as a vinyl-style
  // outline instead of holes.
  const textAsCutLines = useCallback(() => {
    if (!textPreview || !textPreview.contours.length) { setStatus('Type some text and pick a font first'); return }
    lastTextRef.current = null // new task — stop morphing the last text commit
    // script fonts overlap letter to letter; unite them so the blade does
    // not cut across the joins (holes in letters are kept)
    const united = booleanPaths('union', [textPreview.contours])
    const r = addVector(united.length ? united : textPreview.contours, text.trim() || 'text', { x: previewOffX, y: previewOffsetY })
    if (!r) return
    setPreviewBaseY(null); setPreviewOffX(10)
    setPreviewLive(false)
    setStatus(`Added "${text.trim()}" as ${r.lines} cut line${r.lines === 1 ? '' : 's'} · ${r.w.toFixed(0)} × ${r.h.toFixed(0)} mm`)
  }, [textPreview, text, previewOffsetY, previewOffX, addVector])
  // One Add button, driven by the Output choice up top.
  // ---------- team names ----------
  // One roster in, one template per player out: each name generates with the
  // Text panel's font / height / spacing / bend / output settings, stacked
  // down the board as its own independent design. ONE undo removes the batch.
  const [teamNames, setTeamNames] = useState('')
  const generateTeamNames = useCallback(() => {
    if (!font) { setStatus('Pick a font first'); return }
    if (!textOutput) { setStatus('Pick an output first — Rhinestones, Cut lines, or Both'); return }
    const names = teamNames.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!names.length) { setStatus('Type one name per line first'); return }
    pushUndo(stonesRef.current)
    let cursor = stones.length || vectors.length ? bbox.maxY + 10 : 10
    const freshStones: Stone[] = []
    const addElems: Elements = {}
    const freshVecs: VecItem[] = []
    const failed: string[] = []
    let widest = 0
    // measure every row first so each name can CENTRE on the batch's widest
    // (a roster reads as a column, not a left-aligned list)
    const rowWidth = new Map<string, number>()
    let maxRowW = 0
    for (const name of names) {
      try {
        const base = textToContours(font, name, textHeight, letterSpacing)
        const cs = textBend ? arcContours(base.contours, textBend) : base.contours
        let w = 0
        for (const c of cs) for (const q of c) w = Math.max(w, q.x)
        rowWidth.set(name, w)
        maxRowW = Math.max(maxRowW, w)
      } catch { /* the main loop reports it */ }
    }
    for (const name of names) {
      const xOff = 10 + Math.max(0, (maxRowW - (rowWidth.get(name) ?? 0)) / 2)
      try {
        const base = textToContours(font, name, textHeight, letterSpacing)
        const contours = textBend ? arcContours(base.contours, textBend) : base.contours
        let rowH = 0
        if (wantStones) {
          const pts = contoursToStones(contours, textMode)
          if (!pts.length) { failed.push(name); continue }
          const el = nextEl()
          for (const p of pts) rowH = Math.max(rowH, p.y + (sizes[p.size ?? curSize]?.holeMm ?? 3) / 2)
          freshStones.push(...pts.map((p) => ({ x: p.x + xOff, y: p.y + cursor, size: p.size ?? curSize, color: p.color, layer: p.layer ?? 'outline', el })))
          addElems[el] = { contours: normaliseContours(contours), mode: textMode, wholeWord: true, sx: 1, sy: 1 }
        }
        if (wantLines) {
          const united = booleanPaths('union', [contours])
          const raw = united.length ? united : contours
          const closed = raw.map((pl) => {
            if (pl.length < 3) return pl
            const a = pl[0], b = pl[pl.length - 1]
            return Math.hypot(a.x - b.x, a.y - b.y) > 0.01 ? [...pl, { x: a.x, y: a.y }] : pl
          })
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
          for (const pl of closed) for (const q of pl) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
          if (isFinite(minX)) {
            freshVecs.push({
              id: vecSeq.current++,
              name,
              base: closed.map((pl) => pl.map((q) => ({ x: q.x - minX, y: q.y - minY }))),
              baseW: maxX - minX,
              baseH: maxY - minY,
              x: xOff,
              y: cursor,
              s: 1,
            })
            rowH = Math.max(rowH, maxY - minY)
          }
        }
        if (!rowH) { failed.push(name); continue }
        let rowW = 0
        for (const c of contours) for (const q of c) rowW = Math.max(rowW, q.x)
        widest = Math.max(widest, rowW + 10)
        cursor += rowH + 12
      } catch {
        failed.push(name)
      }
    }
    const made = names.length - failed.length
    if (!made) { setStatus('No templates made — check the font and height (every name failed)'); return }
    if (freshStones.length) {
      const next = [...stonesRef.current, ...freshStones]
      stonesRef.current = next
      setStones(next)
    }
    if (Object.keys(addElems).length) setElements((prev) => ({ ...prev, ...addElems }))
    if (freshVecs.length) setVectors((prev) => [...prev, ...freshVecs])
    setSelection(new Set())
    setSelVecs(new Set())
    setStatus(
      `Made ${made} name template${made === 1 ? '' : 's'} — layout runs to ${(cursor / 25.4).toFixed(1)}″ down the board` +
      (cursor > boardHmm ? ` (past the ${boardHIn}″ media — load longer material or cut in batches)` : '') +
      (widest > boardWmm ? ` · widest name is ${(widest / 25.4).toFixed(1)}″ — WIDER than the ${boardWIn}″ media, lower the Height` : '') +
      (failed.length ? ` · failed: ${failed.join(', ')}` : '') +
      ' · counts are in Production',
    )
    // The new rows stack BELOW everything on the board — often outside the
    // current view, which read as "nothing happened". Show the whole design.
    window.setTimeout(fitDesign, 60)
  }, [font, textOutput, teamNames, textHeight, letterSpacing, textBend, textMode, wantStones, wantLines,
      contoursToStones, sizes, curSize, stones.length, vectors.length, bbox.maxY, boardHmm, boardHIn, boardWmm, boardWIn, pushUndo, fitDesign])

  const addTextOutput = useCallback(() => {
    if (!textOutput) { setStatus('Pick an output first — Rhinestones, Cut lines, or Both'); return }
    if (wantStones) generateText()
    if (wantLines) textAsCutLines()
  }, [textOutput, wantStones, wantLines, generateText, textAsCutLines])
  const addTextLabel = textOutput === 'lines'
    ? 'Add cut lines'
    : textOutput === 'both'
      ? (pendingText ? `Add ${pendingText} stones + cut lines` : 'Add stones + cut lines')
      : (pendingText ? `Add ${pendingText} text stones to design` : 'Add text stones')

  // Starting width so the artwork's MEDIAN stroke holds two wall rows at
  // the current stone size — the analyzer already measured stroke deciles.
  // The thin tail (whisker hairlines) is ignored: despeckle drops what
  // can't hold stones anyway. Bold logos clamp to the 100mm floor.
  const suggestWidth = useCallback((a: ImageAnalysis): number | null => {
    if (!a.sampleW || !a.strokeDeciles?.length) return null
    const p50 = a.strokeDeciles[4] ?? a.strokePx
    if (!p50) return null
    const hole = sizes[curSize]?.holeMm ?? 3.4
    // 0.55 x pitch: the median stroke carries a clean CENTERLINE row —
    // detailed art reads right with spines, demanding two wall rows
    // oversized everything. Calibrated on the WASHED DADS wildcat, where
    // 220mm at SS10 was the empirically good size.
    const w = (((hole + hardGapOf(gap)) * 0.55) / p50) * a.sampleW
    if (!isFinite(w) || w <= 0) return null
    return Math.min(400, Math.max(100, Math.round(w / 10) * 10))
  }, [sizes, curSize, gap])
  // Load a raster file into the image pipeline: auto-pick settings that
  // make the artwork the design, so a light logo or transparent background
  // doesn't silently yield nothing. Shared by the file input and canvas drop.
  const loadImageFile = useCallback(async (f: File) => {
    setImageFile(f)
    try {
      const a = await analyzeImage(f, imgWidth, (sizes[curSize]?.holeMm ?? 3.4) + gap)
      setImgThreshold(a.threshold)
      setImgInvert(a.invert)
      setImgAlphaKey(a.alphaKey)
      setImgLinework(a.linework)
      applyStrokeStyle(a)
      // Auto Detail. Bold (weld fine detail) when BOTH hold:
      //  - closing would actually add material (there is sub-pitch detail
      //    to weld — closeGain probes the real operation on the sample);
      //  - stroke widths are MIXED (p90/p50 >= 2): wide bodies plus a thin
      //    tail is the mascot-fur fingerprint. Uniformly thin art (serif,
      //    script) centerlines fine as drawn, and welding only bridges
      //    letters. Calibrated: wildcat gain .44 ratio 2.5 -> Bold;
      //    serif gain .62 ratio 1.5 -> Fine; bold logo gain .03 -> Fine.
      const p50 = a.strokeDeciles?.[4] ?? 0
      const ratio = p50 > 0 ? (a.strokeDeciles?.[8] ?? p50) / p50 : 1
      const autoDetail: typeof imgDetail =
        a.closeGain > 0.3 && ratio >= 2 ? 'bold'
        : a.closeGain > 0.15 && ratio >= 2 ? 'smooth'
        : 'fine'
      setImgDetail(autoDetail)
      const sw = suggestWidth(a)
      const detailNote = autoDetail !== 'fine' ? ` · Detail: ${autoDetail} (fine texture welded — the chips override)` : ''
      if (sw && Math.abs(sw - imgWidth) > 10) {
        setImgWidth(sw)
        setStatus(`${f.name} — ${a.note} · sized to ${sw} mm (${(sw / 25.4).toFixed(1)}″) so the detail holds ${curSize} stones${detailNote}`)
      } else {
        setStatus(`${f.name} — ${a.note}${detailNote}`)
      }
      // quiet text detection — an offer when it finds lettering, never a gate
      void detectText(f, a.threshold).then((r) => {
        if (r) { setImgOcr(r); setImgOcrText(r.text) }
      }).catch(() => {})
    } catch (e) {
      setStatus(`Could not read ${f.name}${e instanceof Error && e.message ? ` — ${e.message}` : ''}`)
    }
  }, [imgWidth, sizes, curSize, gap, applyStrokeStyle, suggestWidth])

  const openSection = useCallback((title: string, focusSel?: string) => {
    const secs = Array.from(document.querySelectorAll<HTMLDetailsElement>('details.sec'))
    const d = secs.find((el) => el.querySelector('summary')?.textContent?.trim() === title)
    if (!d) return
    d.open = true
    // sub-sections (Team names, Multi-color, Scatter…) live inside a parent
    // section — opening the child of a closed parent showed nothing
    for (let p = d.parentElement; p; p = p.parentElement)
      if (p instanceof HTMLDetailsElement) p.open = true
    d.scrollIntoView({ block: 'start', behavior: 'smooth' })
    if (focusSel) window.setTimeout(() => d.querySelector<HTMLElement>(focusSel)?.focus(), 200)
  }, [])

  // ⌘V with an image on the system clipboard (screenshot, copied web image)
  // loads it straight into the image pipeline.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const item = [...(e.clipboardData?.items ?? [])].find((it) => it.type.startsWith('image/'))
      if (!item) return
      const f = item.getAsFile()
      if (!f) return
      e.preventDefault()
      openSection('Image')
      void loadImageFile(new File([f], f.name || 'pasted-image.png', { type: f.type }))
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [loadImageFile, openSection])

  // Trace Bitmap: the working image becomes a cut-line object — same
  // threshold/invert/transparency settings the stone trace uses, but the
  // contours themselves are the cut (vinyl, a stencil, a template border).
  // The result is a normal cut-line object: node tool, offset, pathfinder
  // and resize all work on it.
  const imageAsCutLines = useCallback(async () => {
    if (!imageFile) { setStatus('Choose an image first'); return }
    // the operator has moved on to the CUT-LINE task: break the stone
    // commit's regenerate-in-place link, or every Threshold tweak made for
    // the trace silently morphs the finished (unselected) stone design
    lastImageRef.current = null
    setStatus('Tracing image to cut lines…')
    try {
      const traced = await imageToCutContours(imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework)
      if (!traced.length) { setStatus('Nothing traced — move the Threshold slider or try Invert'); return }
      const r = addVector(traced, imageFile.name.replace(/\.\w+$/, ''))
      if (!r) return
      setStatus(`Traced ${r.lines} cut line${r.lines === 1 ? '' : 's'} · ${r.w.toFixed(0)} × ${r.h.toFixed(0)} mm — the Nodes tool cleans up any rough spots`)
    } catch (e) {
      setStatus(`Trace failed: ${e instanceof Error ? e.message : e}`)
    }
  }, [imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, addVector])

  const shapeAsCutLines = useCallback(() => {
    const { contours } = shapeToContours(shapeKind, shapeW, shapeH)
    const r = addVector(contours, shapeKind)
    if (r) setStatus(`Added ${shapeKind} as a cut line · ${r.w.toFixed(0)} × ${r.h.toFixed(0)} mm`)
  }, [shapeKind, shapeW, shapeH, addVector])
  const importSvg = useCallback(() => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = '.svg,image/svg+xml'
    inp.onchange = async () => {
      const f = inp.files?.[0]
      if (!f) return
      try {
        const r = parseSvgToPaths(await f.text(), f.name.replace(/\.svg$/i, ''))
        // fit onto the board if the file is larger than the media
        const s = Math.min(1, (boardWmm - 20) / r.widthMm, (boardHmm - 20) / r.heightMm)
        const id = vecSeq.current++
        const below = stones.length || vectors.length ? bbox.maxY + 10 : 10
        const y = Math.max(10, Math.min(below, boardHmm - r.heightMm * s - 10))
        mutateVectors((prev) => [...prev, { id, name: r.name, base: r.paths, baseW: r.widthMm, baseH: r.heightMm, x: 10, y, s }])
        setSelVecs(new Set([id]))
        const pts = r.paths.reduce((n, p) => n + p.length, 0)
        setStatus(
          `Imported ${r.name}: ${r.paths.length} cut line${r.paths.length === 1 ? '' : 's'}, ${pts} points, ${r.widthMm.toFixed(0)} × ${r.heightMm.toFixed(0)} mm` +
          (s < 1 ? ` (scaled to ${Math.round(s * 100)}% to fit the board)` : '') +
          (r.skipped ? ` · ${r.skipped} text/image element${r.skipped === 1 ? '' : 's'} skipped` : ''),
        )
      } catch (e) {
        setStatus(`SVG import failed: ${e instanceof Error ? e.message : e}`)
      }
    }
    inp.click()
  }, [boardWmm, boardHmm, stones.length, vectors.length, bbox.maxY, mutateVectors])
  const resizeVector = useCallback((id: number, widthMm: number | null, heightMm: number | null) => {
    mutateVectors((prev) => prev.map((v) => {
      if (v.id !== id) return v
      const s = widthMm != null ? widthMm / v.baseW : heightMm != null ? heightMm / v.baseH : v.s
      return isFinite(s) && s > 0 ? { ...v, s } : v
    }))
  }, [mutateVectors])
  ;(window as unknown as { __scParseSvg?: unknown }).__scParseSvg = parseSvgToPaths
  ;(window as unknown as { __scColorLayers?: unknown }).__scColorLayers = imageToColorLayers

  // ---------- align / distribute / pathfinder ----------
  // Objects = selected cut-line items + each selected stone element (stones
  // that share an el move as one object; loose stones are objects of their
  // own), each with its bounding box on the board.
  type AlignObj = { key: string; box: Box; vec?: number; el?: number; stone?: number }
  const [alignTo, setAlignTo] = useState<'selection' | 'board'>('selection')
  const alignObjs = useMemo<AlignObj[]>(() => {
    const out: AlignObj[] = []
    for (const v of vectors) if (selVecs.has(v.id)) out.push({ key: `v${v.id}`, box: vecBox(v), vec: v.id })
    const byEl = new Map<number, Box>()
    for (const i of selection) {
      const st = stones[i]
      if (!st) continue
      const r = holeOf(st) / 2
      const b = { minX: st.x - r, minY: st.y - r, maxX: st.x + r, maxY: st.y + r }
      if (st.el == null) { out.push({ key: `s${i}`, box: b, stone: i }); continue }
      const e = byEl.get(st.el)
      byEl.set(st.el, e ? { minX: Math.min(e.minX, b.minX), minY: Math.min(e.minY, b.minY), maxX: Math.max(e.maxX, b.maxX), maxY: Math.max(e.maxY, b.maxY) } : b)
    }
    for (const [el, box] of byEl) out.push({ key: `e${el}`, box, el })
    return out
  }, [vectors, selVecs, selection, stones, holeOf])
  // apply per-object translations as ONE undo step
  const moveObjs = useCallback((moves: Map<string, Pt>) => {
    if (![...moves.values()].some((d) => d.x || d.y)) return
    pushUndo(stonesRef.current)
    const byObj = new Map(alignObjs.map((o) => [o.key, o]))
    const stoneDelta = new Map<number, Pt>()
    const elDelta = new Map<number, Pt>()
    const vecDelta = new Map<number, Pt>()
    for (const [key, d] of moves) {
      const o = byObj.get(key)
      if (!o) continue
      if (o.vec != null) vecDelta.set(o.vec, d)
      else if (o.el != null) elDelta.set(o.el, d)
      else if (o.stone != null) stoneDelta.set(o.stone, d)
    }
    if (stoneDelta.size || elDelta.size)
      setStones((prev) => prev.map((st, i) => {
        const d = stoneDelta.get(i) ?? (st.el != null && selection.has(i) ? elDelta.get(st.el) : undefined)
        return d ? { ...st, x: st.x + d.x, y: st.y + d.y } : st
      }))
    if (vecDelta.size)
      setVectors((prev) => prev.map((v) => { const d = vecDelta.get(v.id); return d ? { ...v, x: v.x + d.x, y: v.y + d.y } : v }))
  }, [alignObjs, selection, pushUndo])
  type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
  const alignSelected = useCallback((edge: AlignEdge) => {
    if (!alignObjs.length) return
    let t: Box
    if (alignTo === 'board' || alignObjs.length < 2) t = { minX: 0, minY: 0, maxX: boardWmm, maxY: boardHmm }
    else t = alignObjs.reduce((a, o) => ({ minX: Math.min(a.minX, o.box.minX), minY: Math.min(a.minY, o.box.minY), maxX: Math.max(a.maxX, o.box.maxX), maxY: Math.max(a.maxY, o.box.maxY) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
    const moves = new Map<string, Pt>()
    for (const o of alignObjs) {
      const b = o.box
      const d: Pt = { x: 0, y: 0 }
      if (edge === 'left') d.x = t.minX - b.minX
      if (edge === 'hcenter') d.x = (t.minX + t.maxX) / 2 - (b.minX + b.maxX) / 2
      if (edge === 'right') d.x = t.maxX - b.maxX
      if (edge === 'top') d.y = t.minY - b.minY
      if (edge === 'vcenter') d.y = (t.minY + t.maxY) / 2 - (b.minY + b.maxY) / 2
      if (edge === 'bottom') d.y = t.maxY - b.maxY
      moves.set(o.key, d)
    }
    moveObjs(moves)
  }, [alignObjs, alignTo, boardWmm, boardHmm, moveObjs])
  // centers: even spacing between object centres, outer two stay put.
  // spacing: equal gaps between neighbouring edges, outer two stay put.
  const distributeSelected = useCallback((axis: 'x' | 'y', mode: 'centers' | 'spacing') => {
    if (alignObjs.length < 3) { setStatus('Select three or more objects to distribute'); return }
    const lo = (b: Box) => (axis === 'x' ? b.minX : b.minY)
    const hi = (b: Box) => (axis === 'x' ? b.maxX : b.maxY)
    const objs = [...alignObjs].sort((a, b) => (lo(a.box) + hi(a.box)) - (lo(b.box) + hi(b.box)))
    const moves = new Map<string, Pt>()
    const n = objs.length
    if (mode === 'centers') {
      const c0 = (lo(objs[0].box) + hi(objs[0].box)) / 2
      const c1 = (lo(objs[n - 1].box) + hi(objs[n - 1].box)) / 2
      objs.forEach((o, i) => {
        const c = (lo(o.box) + hi(o.box)) / 2
        const want = c0 + ((c1 - c0) * i) / (n - 1)
        moves.set(o.key, axis === 'x' ? { x: want - c, y: 0 } : { x: 0, y: want - c })
      })
    } else {
      const span = hi(objs[n - 1].box) - lo(objs[0].box)
      const sizes = objs.reduce((t, o) => t + (hi(o.box) - lo(o.box)), 0)
      const gap = (span - sizes) / (n - 1)
      let cursor = lo(objs[0].box)
      objs.forEach((o) => {
        const d = cursor - lo(o.box)
        moves.set(o.key, axis === 'x' ? { x: d, y: 0 } : { x: 0, y: d })
        cursor += hi(o.box) - lo(o.box) + gap
      })
    }
    moveObjs(moves)
  }, [alignObjs, moveObjs])
  // Pathfinder on the selected cut-line objects (back-most = keeper for
  // Minus Front). Result replaces the operands as one new object.
  const pathfinder = useCallback((op: BoolOp) => {
    const ops = vectors.filter((v) => selVecs.has(v.id))
    if (!ops.length || (op !== 'union' && ops.length < 2)) { setStatus(op === 'union' ? 'Select a cut-line object first' : 'Select two or more cut-line objects (shift-click)'); return }
    const result = booleanPaths(op, ops.map(vecPaths))
    if (!result.length) { setStatus('Nothing left after that operation — the shapes do not overlap'); return }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const pl of result) for (const q of pl) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
    const base = result.map((pl) => pl.map((q) => ({ x: q.x - minX, y: q.y - minY })))
    const id = vecSeq.current++
    const names: Record<BoolOp, string> = { union: 'Unite', difference: 'Minus front', intersection: 'Intersect', xor: 'Exclude' }
    const item: VecItem = { id, name: `${names[op]} (${ops.map((o) => o.name).join(', ')})`, base, baseW: maxX - minX, baseH: maxY - minY, x: minX, y: minY, s: 1 }
    const at = vectors.findIndex((v) => selVecs.has(v.id))
    mutateVectors((prev) => { const rest = prev.filter((v) => !selVecs.has(v.id)); const idx = Math.min(at, rest.length); return [...rest.slice(0, idx), item, ...rest.slice(idx)] })
    setSelVecs(new Set([id]))
    setStatus(`${names[op]}: ${result.length} cut line${result.length === 1 ? '' : 's'}`)
  }, [vectors, selVecs, mutateVectors])
  // Offset / inset selected cut-line objects (Inkscape ⌘( / ⌘)): grow or
  // shrink each object's boundary by `offsetMm`. Each object offsets
  // independently and is replaced in place; Undo restores the original.
  const [offsetMm, setOffsetMm] = useState(2)
  const applyOffset = useCallback((dir: 1 | -1) => {
    const ops = vectors.filter((v) => selVecs.has(v.id))
    if (!ops.length) { setStatus('Select a cut-line object first'); return }
    const d = Math.abs(offsetMm) * dir
    if (!d) return
    const replaced = new Map<number, VecItem>()
    let gone = 0
    for (const v of ops) {
      const result = offsetPaths(vecPaths(v), d)
      if (!result.length) { gone++; continue }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const pl of result) for (const q of pl) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
      replaced.set(v.id, {
        ...v,
        base: result.map((pl) => pl.map((q) => ({ x: q.x - minX, y: q.y - minY }))),
        baseW: maxX - minX,
        baseH: maxY - minY,
        x: minX,
        y: minY,
        s: 1,
      })
    }
    if (!replaced.size) { setStatus(`Inset by ${Math.abs(d)} mm swallows the whole shape — use a smaller amount`); return }
    mutateVectors((prev) => prev.map((v) => replaced.get(v.id) ?? v))
    setStatus(
      `${dir > 0 ? 'Grew' : 'Shrank'} ${replaced.size} object${replaced.size === 1 ? '' : 's'} by ${Math.abs(d)} mm` +
      (gone ? ` · ${gone} skipped (inset swallowed the shape)` : ''),
    )
  }, [vectors, selVecs, offsetMm, mutateVectors])

  // Ungroup: split selected cut-line object(s) into separate objects — one
  // per letter/shape. A contour nested inside another is a hole and stays
  // with its parent; disjoint outer contours whose x-ranges overlap (the dot
  // of an i above its stem) stay together. Very tight kerning can land two
  // letters in one piece — run Ungroup again after nudging them apart.
  const ungroup = useCallback(() => {
    const ops = vectors.filter((v) => selVecs.has(v.id))
    if (!ops.length) { setStatus('Select a cut-line object first'); return }
    // compute every split FIRST (pure), then commit once — state updaters
    // must stay side-effect free
    const splits = new Map<number, VecItem[]>()
    const newIds: number[] = []
    for (const v of ops) {
      {
        const paths = vecPaths(v)
        if (paths.length < 2) continue
        const groups = splitContoursIntoLetters(paths)
        if (groups.length < 2) continue
        const pieces: VecItem[] = groups.map((g, k) => {
          const cs = g.map((i) => paths[i])
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
          for (const c of cs) for (const q of c) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
          const id = vecSeq.current++
          newIds.push(id)
          return {
            id,
            name: `${v.name} ${k + 1}`,
            base: cs.map((c) => c.map((q) => ({ x: q.x - minX, y: q.y - minY }))),
            baseW: maxX - minX,
            baseH: maxY - minY,
            x: minX,
            y: minY,
            s: 1,
          }
        })
        splits.set(v.id, pieces)
      }
    }
    if (!newIds.length) { setStatus('Nothing to ungroup — that object is a single shape'); return }
    mutateVectors((prev) =>
      prev.flatMap((n) => (splits.has(n.id) ? splits.get(n.id)! : [n])))
    setSelVecs(new Set(newIds))
    setStatus(`Ungrouped into ${newIds.length} objects`)
  }, [vectors, selVecs, mutateVectors])

  // Ungroup a stone text design into per-letter ELEMENTS: each letter gets
  // its own element id and its own recipe slice, so it moves and resizes
  // independently (double-click a letter to grab it).
  const ungroupElement = useCallback(() => {
    const el = selectedEl
    if (el == null) { setStatus('Double-click a stone design first, then ungroup it'); return }
    const r = elementsRef.current[el]
    if (!r) { setStatus('This design has no stored outline to split'); return }
    const groups = splitContoursIntoLetters(r.contours)
    if (groups.length < 2) { setStatus('Nothing to ungroup — that design is a single letter'); return }
    const scaled = r.contours.map((c) => c.map((q) => ({ x: q.x * r.sx, y: q.y * r.sy })))
    let sMinX = Infinity, sMinY = Infinity
    for (const c of scaled) for (const q of c) { sMinX = Math.min(sMinX, q.x); sMinY = Math.min(sMinY, q.y) }
    let bMinX = Infinity, bMinY = Infinity
    for (const st of stones) if (st.el === el) { bMinX = Math.min(bMinX, st.x); bMinY = Math.min(bMinY, st.y) }
    const tx = bMinX - sMinX, ty = bMinY - sMinY // recipe space → board space
    const boxes = groups.map((g) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const i of g) for (const q of scaled[i]) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
      return { minX: minX + tx, maxX: maxX + tx, minY: minY + ty, maxY: maxY + ty }
    })
    const newEls = groups.map(() => nextEl())
    pushUndo(stonesRef.current)
    const next = stones.map((st) => {
      if (st.el !== el) return st
      let best = 0, bestD = Infinity
      boxes.forEach((b, k) => {
        const inX = st.x >= b.minX - 2 && st.x <= b.maxX + 2
        const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
        const d = (inX ? 0 : 1e6) + Math.hypot(st.x - cx, st.y - cy)
        if (d < bestD) { bestD = d; best = k }
      })
      return { ...st, el: newEls[best] }
    })
    stonesRef.current = next
    setStones(next)
    setElements((prev) => {
      const out = { ...prev }
      delete out[el]
      groups.forEach((g, k) => {
        out[newEls[k]] = { contours: normaliseContours(g.map((i) => r.contours[i])), mode: r.mode, wholeWord: false, sx: r.sx, sy: r.sy }
      })
      return out
    })
    setSelection(new Set())
    setStatus(`Ungrouped into ${groups.length} letter elements — double-click a letter to select it`)
  }, [selectedEl, stones, pushUndo])

  const alignCount = alignObjs.length

  // ---------- right-click context menu on the canvas ----------
  // Right-click selects what's under the cursor (like any design app) and
  // offers the edit actions that make sense for it.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; kind: 'vec' | 'stones' | 'empty' } | null>(null)
  const onCanvasContext = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const p = toMm(e)
    const slop = Math.max(0.5, HIT_SLOP_PX / zoom)
    const hit = pickStone(p, slop)
    if (hit !== -1) {
      if (!selection.has(hit)) { setSelVecs(new Set()); setSelection(new Set([hit])) }
      setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'stones' })
      return
    }
    let bestV: number | null = null
    let bestD = slop + 0.3
    for (const v of vectors) {
      const d = distToPaths(vecPaths(v), p)
      if (d < bestD) { bestD = d; bestV = v.id }
    }
    if (bestV != null) {
      if (!selVecs.has(bestV)) { setSelection(new Set()); setSelVecs(new Set([bestV])) }
      setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'vec' })
      return
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'empty' })
  }, [toMm, zoom, pickStone, selection, vectors, selVecs])
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', close) }
  }, [ctxMenu])

  // ---------- menu bar ----------
  const [showShortcuts, setShowShortcuts] = useState(false)
  // Sidebar sections are plain <details>; the Window menu opens one by title
  // and scrolls it into view (Kevin works at a big browser zoom, so finding
  // a folded section by scrolling is the slow part).
  // ---------- design files on the real file system ----------
  // "Save" writes back to the SAME file like a desktop app (File System
  // Access API; Chrome/Edge, which WebUSB already requires). The handle
  // survives reloads via IndexedDB. Browsers without the API fall back to a
  // download, but files keep the .stonecut name either way.
  const fileHandleRef = useRef<FSFileHandle | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  useEffect(() => {
    void recallHandle().then((h) => {
      if (h) {
        fileHandleRef.current = h
        setFileName(h.name)
      }
    })
  }, [])
  const adoptHandle = useCallback((h: FSFileHandle | null, name: string | null) => {
    fileHandleRef.current = h
    setFileName(h ? h.name : name)
    void rememberHandle(h)
  }, [])
  const designJson = useCallback(
    () => JSON.stringify({ v: 1, stones, sizes, elements, vectors }),
    [stones, sizes, elements, vectors],
  )
  const saveDesignAs = useCallback(async () => {
    const suggested = fileName ?? `design${DESIGN_EXT}`
    if (!fsSupported) {
      download(suggested, designJson(), 'application/json')
      return
    }
    const h = await pickSaveHandle(suggested)
    if (!h) return // cancelled
    try {
      await writeHandle(h, designJson())
      adoptHandle(h, h.name)
      setStatus(`Saved ${h.name}`)
    } catch (e) {
      setStatus(`Could not save: ${e instanceof Error ? e.message : e}`)
    }
  }, [fileName, designJson, adoptHandle])

  // ---------- production: publish to TShirt Brothers ----------
  // Sends the design to the shop: preview PNG into the TSB art library (so
  // it can be dropped on a garment in the Design Studio and mocked up for a
  // customer), cut SVG + the real stone BOM into the rhinestone tables (so
  // the quote prices off actual stone counts). See src/publish.ts.
  const [publishing, setPublishing] = useState(false)
  const editPublishKey = useCallback(() => {
    const next = window.prompt(
      'TSB publish key (STONECUT_PUBLISH_KEY on the TShirt Brothers server):',
      getPublishKey(),
    )
    if (next == null) return
    setPublishKey(next)
    setStatus(next.trim() ? 'TSB publish key saved' : 'TSB publish key cleared')
  }, [])
  const publishToShop = useCallback(async () => {
    if (publishing) return
    if (!stones.length) { setStatus('Nothing to publish — add stones first'); return }
    if (!getPublishKey()) {
      setStatus('Set the TSB publish key first — File ▸ TSB publish key…')
      editPublishKey()
      return
    }
    const suggested = (fileName || '').replace(/\.[a-zA-Z0-9]+$/, '') || 'Rhinestone design'
    const name = window.prompt('Publish to TShirt Brothers as:', suggested)
    if (name == null || !name.trim()) return

    setPublishing(true)
    setStatus('Publishing to TShirt Brothers…')
    try {
      const preview = renderPreviewPng(stones, sizes, colorOfStone)
      const coverage = coverageOf(stones, sizes, preview.widthMm, preview.heightMm)
      const result = await publishToTsb({
        name: name.trim(),
        previewBase64: preview.dataUrl,
        // Cut file for the template, same geometry the Cricut/plotter export
        // uses — so production never has to re-derive it from the preview.
        svg: cutCount ? toSVG(framedCutJob) : undefined,
        widthMm: preview.widthMm,
        heightMm: preview.heightMm,
        coverage,
        stoneBom: bom,
        tags: ['bling', 'spiritwear'],
      })
      setStatus(
        `Published to TShirt Brothers — ${result.design.stone_count} stones, art library #${result.artLibraryId}. ` +
          'Feature it on /bling from the TSB admin.',
      )
    } catch (e) {
      setStatus(`Publish failed — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPublishing(false)
    }
  }, [publishing, stones, sizes, colorOfStone, bom, framedCutJob, cutCount, fileName, editPublishKey])
  const saveDesign = useCallback(async () => {
    const h = fileHandleRef.current
    if (!h || !fsSupported) {
      await saveDesignAs()
      return
    }
    try {
      if (!(await ensureWritable(h))) {
        setStatus(`No permission to write ${h.name} — pick where to save it`)
        await saveDesignAs()
        return
      }
      await writeHandle(h, designJson())
      setStatus(`Saved ${h.name}`)
    } catch {
      // the file moved or was deleted out from under the handle
      await saveDesignAs()
    }
  }, [designJson, saveDesignAs])
  // Replace the whole board with a saved design file — shared by
  // File -> Open and dropping a design file on the board.
  const applyDesignData = useCallback((d: unknown, name: string) => {
    const dd = d as { stones?: Stone[]; vectors?: VecItem[]; sizes?: Record<string, StoneSpec>; elements?: Elements }
    if (!Array.isArray(dd?.stones) && !Array.isArray(dd?.vectors)) throw new Error('not a StoneCut design file')
    pushUndo(stonesRef.current)
    const loaded = (dd.stones ?? []) as Stone[]
    setStones(loaded)
    if (dd.sizes && typeof dd.sizes === 'object') setSizes(mergeSavedSizes(dd.sizes))
    setElements(dd.elements && typeof dd.elements === 'object' ? dd.elements : {})
    const vecs: VecItem[] = Array.isArray(dd.vectors) ? dd.vectors : []
    setVectors(vecs)
    vecSeq.current = vecs.reduce((m, v) => Math.max(m, v.id), 0) + 1
    // never rewind: undo can bring back stones with ids above this file's max
    elSeq.current = Math.max(elSeq.current, loaded.reduce((m, st) => Math.max(m, st.el ?? 0), 0) + 1)
    setSelection(new Set())
    setStatus(`Opened ${name}: ${loaded.length} stones`)
  }, [pushUndo])
  const openDesignFile = useCallback(async () => {
    if (fsSupported) {
      const h = await pickOpenHandle()
      if (!h) return // cancelled
      try {
        const f = await h.getFile()
        applyDesignData(JSON.parse(await f.text()), f.name)
        adoptHandle(h, h.name) // ⌘S now writes back to this file
      } catch (e) {
        setStatus(`Could not open: ${e instanceof Error ? e.message : e}`)
      }
      return
    }
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = `${DESIGN_EXT},.json,application/json`
    inp.onchange = async () => {
      const f = inp.files?.[0]
      if (!f) return
      try {
        applyDesignData(JSON.parse(await f.text()), f.name)
        adoptHandle(null, f.name)
      } catch (e) {
        setStatus(`Could not open: ${e instanceof Error ? e.message : e}`)
      }
    }
    inp.click()
  }, [applyDesignData, adoptHandle])
  // ⌘S / ⌘⇧S — separate effect so it can live after the save callbacks;
  // preventDefault keeps the browser's own save-page dialog out of the way
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        if (e.shiftKey) void saveDesignAs()
        else void saveDesign()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveDesign, saveDesignAs])
  // ---------- drag & drop onto the board ----------
  // Raster image -> image pipeline, previewed near the drop point.
  // SVG -> cut-line object centered at the drop point.
  // .json -> open as a StoneCut design.
  const [dragOver, setDragOver] = useState(false)
  const onBoardDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (!f) return
    const p = toMm(e)
    if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') {
      try {
        const r = parseSvgToPaths(await f.text(), f.name.replace(/\.svg$/i, ''))
        const s = Math.min(1, (boardWmm - 20) / r.widthMm, (boardHmm - 20) / r.heightMm)
        const at = {
          x: Math.max(0, Math.min(p.x - (r.widthMm * s) / 2, boardWmm - r.widthMm * s)),
          y: Math.max(0, Math.min(p.y - (r.heightMm * s) / 2, boardHmm - r.heightMm * s)),
        }
        const res = addVector(r.paths, r.name, at)
        if (res) setStatus(`Imported ${r.name}: ${res.lines} cut line${res.lines === 1 ? '' : 's'} · ${res.w.toFixed(0)} × ${res.h.toFixed(0)} mm — dropped in place`)
      } catch (err) {
        setStatus(`SVG import failed: ${err instanceof Error ? err.message : err}`)
      }
      return
    }
    if (f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) {
      // pin the preview near where it was dropped
      setPreviewBaseY(Math.max(10, Math.min(p.y, boardHmm - 30)))
      openSection('Image')
      await loadImageFile(f)
      return
    }
    if (/\.(stonecut|json)$/i.test(f.name)) {
      try {
        applyDesignData(JSON.parse(await f.text()), f.name)
        // a dropped file carries no writable handle — detach so ⌘S asks
        // where to save instead of overwriting the previously open file
        adoptHandle(null, f.name)
      } catch (err) {
        setStatus(`Could not open: ${err instanceof Error ? err.message : err}`)
      }
      return
    }
    setStatus(`Can't use ${f.name} — drop an image, an SVG, or a StoneCut design file`)
  }, [toMm, addVector, loadImageFile, applyDesignData, adoptHandle, openSection, boardWmm, boardHmm])

  const clearAll = useCallback(() => {
    if (stones.length) mutate(() => [])
    if (vectors.length) setVectors([])
    setSelVecs(new Set())
    setSelection(new Set())
    setText('')
    setImageFile(null)
    setImagePreview(null)
    setPreviewStones(null)
    setPreviewLive(false)
  }, [stones.length, vectors.length, mutate])
  const selectWhere = useCallback((pred: (s: Stone, i: number) => boolean) => {
    setSelection(new Set(stones.map((st, i) => (pred(st, i) ? i : -1)).filter((i) => i >= 0)))
  }, [stones])
  const expandToDesigns = useCallback(() => {
    const els = new Set<number>()
    for (const i of selection) { const e = stones[i]?.el; if (e != null) els.add(e) }
    selectWhere((st, i) => selection.has(i) || (st.el != null && els.has(st.el)))
  }, [selection, stones, selectWhere])
  const centerOnBoard = useCallback(() => {
    if (!stones.length) return
    const dx = boardWmm / 2 - (bbox.minX + bbox.maxX) / 2
    const dy = boardHmm / 2 - (bbox.minY + bbox.maxY) / 2
    mutate((prev) => prev.map((st) => ({ ...st, x: st.x + dx, y: st.y + dy })))
  }, [stones.length, bbox, boardWmm, boardHmm, mutate])
  // undo/redo live up next to pushUndo now
  const hasSel = selection.size > 0
  const hasStones = stones.length > 0
  const sectionItems = ['Text', 'Stones', 'Fill', 'Shapes', 'Templates', 'Image', 'Vector cut', 'Align & Pathfinder', 'Edit', 'Production', 'Material', 'Cut']
  const menus: Menu[] = [
    { label: 'File', items: [
      { label: 'New design', onClick: () => { clearAll(); adoptHandle(null, null) }, disabled: !hasStones && !pending && !vectors.length },
      { label: 'Open design…', onClick: () => { void openDesignFile() } },
      { label: 'Import vector cut (SVG)…', onClick: importSvg },
      { label: fileName ? `Save — ${fileName}` : 'Save…', shortcut: '⌘S', onClick: () => { void saveDesign() }, disabled: !hasStones && !vectors.length },
      { label: 'Save As…', shortcut: '⌘⇧S', onClick: () => { void saveDesignAs() }, disabled: !hasStones && !vectors.length },
      'sep',
      { label: 'Export SVG (Cricut)…', onClick: () => download(`stonecut-${cutLayerSlug}.svg`, toSVG(framedCutJob), 'image/svg+xml'), disabled: !cutCount },
      { label: 'Export DXF (laser / other cutters)…', onClick: () => download(`stonecut-${cutLayerSlug}.dxf`, toDXF(framedCutJob), 'application/dxf'), disabled: !cutCount },
      { label: 'Export plotter file (.plt)…', onClick: () => download(`stonecut-${cutLayerSlug}.plt`, cutData()), disabled: !cutCount },
      'sep',
      { label: 'Print work order…', onClick: printWorkOrder, disabled: !hasStones && !vectors.length },
      { label: 'Print 1:1 placement guide…', onClick: printPlacementGuide, disabled: !hasStones && !vectors.length },
      'sep',
      { label: publishing ? 'Publishing to TShirt Brothers…' : '💎 Publish to TShirt Brothers…', onClick: () => { void publishToShop() }, disabled: !hasStones || publishing },
      { label: 'TSB publish key…', onClick: editPublishKey },
      'sep',
      { label: '⚡ Cut on Graphtec', onClick: () => { void doSend() }, disabled: !cutCount },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', shortcut: '⌘Z', onClick: undo },
      { label: 'Redo', shortcut: '⌘⇧Z', onClick: redo },
      'sep',
      { label: 'Copy', shortcut: '⌘C', disabled: !hasSel && !selVecs.size, onClick: copySelection },
      { label: 'Paste', shortcut: '⌘V', onClick: pasteClipboard },
      { label: 'Duplicate', shortcut: '⌘D', disabled: !hasSel && !selVecs.size && !hasStones && !vectors.length, onClick: duplicateSelection },
      'sep',
      { label: 'Select all', shortcut: '⌘A', onClick: () => selectWhere(() => true), disabled: !hasStones },
      { label: 'Deselect', onClick: () => setSelection(new Set()), disabled: !hasSel },
      { label: 'Delete selected', shortcut: '⌫', disabled: !hasSel, onClick: () => { mutate((prev) => prev.filter((_, i) => !selection.has(i))); setSelection(new Set()) } },
      'sep',
      { label: `Set selected to ${curSize}`, disabled: !hasSel, onClick: () => mutate((prev) => prev.map((st, i) => (selection.has(i) ? { ...st, size: curSize } : st))) },
      'sep',
      { label: 'Clear all', onClick: clearAll, disabled: !hasStones && !pending },
    ] },
    { label: 'Object', items: [
      { label: 'Select whole design', disabled: !hasSel, onClick: expandToDesigns },
      { label: 'Resize design…', disabled: selectedEl == null, onClick: () => openSection('Edit', 'input[type=number]') },
      { label: 'Ungroup element — split into letters', disabled: selectedEl == null, onClick: ungroupElement },
      'sep',
      { label: 'Rotate 90° CW', disabled: !selection.size && !selVecs.size, onClick: () => rotateSelection(90) },
      { label: 'Rotate 90° CCW', disabled: !selection.size && !selVecs.size, onClick: () => rotateSelection(-90) },
      { label: 'Flip horizontal', disabled: !selection.size && !selVecs.size, onClick: () => flipSelection('h') },
      { label: 'Flip vertical', disabled: !selection.size && !selVecs.size, onClick: () => flipSelection('v') },
      'sep',
      { label: 'Move to origin corner', disabled: !hasStones, onClick: () => placeFromOrigin(0.5, 0.5) },
      { label: 'Center on board', disabled: !hasStones, onClick: centerOnBoard },
      'sep',
      { label: 'Align left', disabled: !alignCount, onClick: () => alignSelected('left') },
      { label: 'Align horizontal centers', disabled: !alignCount, onClick: () => alignSelected('hcenter') },
      { label: 'Align right', disabled: !alignCount, onClick: () => alignSelected('right') },
      { label: 'Align top', disabled: !alignCount, onClick: () => alignSelected('top') },
      { label: 'Align vertical centers', disabled: !alignCount, onClick: () => alignSelected('vcenter') },
      { label: 'Align bottom', disabled: !alignCount, onClick: () => alignSelected('bottom') },
      { label: 'Distribute horizontally', disabled: alignCount < 3, onClick: () => distributeSelected('x', 'centers') },
      { label: 'Distribute vertically', disabled: alignCount < 3, onClick: () => distributeSelected('y', 'centers') },
      'sep',
      { label: 'Ungroup — split into letters', disabled: !selVecs.size, onClick: ungroup },
      'sep',
      { label: 'Step & repeat…', disabled: !hasStones && !vectors.length, onClick: () => openSection('Production') },
      { label: 'Scatter spray around selection…', disabled: !selection.size && !selVecs.size, onClick: () => openSection('Scatter spray') },
      'sep',
      { label: 'Unite', disabled: !selVecs.size, onClick: () => pathfinder('union') },
      { label: 'Minus front', disabled: selVecs.size < 2, onClick: () => pathfinder('difference') },
      { label: 'Intersect', disabled: selVecs.size < 2, onClick: () => pathfinder('intersection') },
      { label: 'Exclude', disabled: selVecs.size < 2, onClick: () => pathfinder('xor') },
      'sep',
      { label: `Offset path — grow ${offsetMm} mm`, disabled: !selVecs.size, onClick: () => applyOffset(1) },
      { label: `Inset path — shrink ${offsetMm} mm`, disabled: !selVecs.size, onClick: () => applyOffset(-1) },
    ] },
    { label: 'Type', items: [
      { label: 'Add text…', onClick: () => openSection('Text', 'input') },
      { label: 'Add text as cut lines', onClick: textAsCutLines, disabled: !textPreview },
      { label: 'Team names — roster batch…', onClick: () => openSection('Team names', 'textarea') },
      { label: 'Fonts…', onClick: () => { openSection('Text'); setFontOpen(true) } },
      'sep',
      { label: 'Add a shape…', onClick: () => openSection('Shapes') },
      { label: 'Trace an image…', onClick: () => openSection('Image') },
      { label: 'Multi-color trace…', onClick: () => openSection('Multi-color') },
      { label: 'Trace image to cut lines', disabled: !imageFile, onClick: () => { void imageAsCutLines() } },
    ] },
    { label: 'Select', items: [
      { label: 'All', shortcut: '⌘A', disabled: !hasStones, onClick: () => selectWhere(() => true) },
      { label: 'Deselect', disabled: !hasSel, onClick: () => setSelection(new Set()) },
      { label: 'Inverse', disabled: !hasStones, onClick: () => selectWhere((_, i) => !selection.has(i)) },
      'sep',
      { label: 'Outline stones', disabled: !hasStones, onClick: () => selectWhere((st) => (st.layer ?? 'outline') === 'outline') },
      { label: 'Fill stones', disabled: !hasStones, onClick: () => selectWhere((st) => st.layer === 'fill') },
      { label: `Same size as current (${curSize})`, disabled: !hasStones, onClick: () => selectWhere((st) => st.size === curSize) },
      'sep',
      { label: 'Whole design of selection', disabled: !hasSel, onClick: expandToDesigns },
    ] },
    { label: 'View', items: [
      { label: 'Zoom in', shortcut: '⌘+', onClick: () => zoomAbout(zoomRef.current * 1.25) },
      { label: 'Zoom out', shortcut: '⌘−', onClick: () => zoomAbout(zoomRef.current / 1.25) },
      'sep',
      { label: 'Fit design', shortcut: 'F', disabled: !hasStones, onClick: fitDesign },
      { label: 'Fit sheet', shortcut: '⌘0', onClick: fitSheet },
      { label: 'Actual size', shortcut: '1:1', onClick: () => zoomAbout(PX_PER_MM_100) },
      'sep',
      { label: 'Snap to objects & board (Alt drags free)', checked: snapOn, onClick: () => setSnapOn((o) => !o) },
      { label: 'Sparkle simulation — stones as gems', checked: simView, onClick: () => setSimView((o) => !o) },
      { label: 'Garment mockup…', disabled: !hasStones && !vectors.length, onClick: () => setMockupOpen(true) },
      'sep',
      { label: 'Select / move tool', shortcut: 'V', checked: tool === 'select', onClick: () => setTool('select') },
      { label: 'Add / erase tool', shortcut: 'A', checked: tool === 'add', onClick: () => setTool('add') },
      { label: 'Node tool — edit path points', shortcut: 'N', checked: tool === 'node', onClick: () => setTool('node') },
      { label: 'Pen tool — stones along a drawn path', shortcut: 'P', checked: tool === 'pen', onClick: () => setTool('pen') },
    ] },
    { label: 'Window', items: sectionItems.map((t) => ({ label: t, onClick: () => openSection(t) })) },
    { label: 'Help', items: [
      { label: 'Keyboard shortcuts', onClick: () => setShowShortcuts(true) },
      { label: 'Cutter setup notes', onClick: () => openSection('Cut') },
      'sep',
      { label: 'StoneCut on GitHub', onClick: () => window.open('https://github.com/kevinskey/stonecut#readme', '_blank', 'noopener') },
    ] },
  ]

  return (
    <div className="app">
      <MenuBar brand="StoneCut" menus={menus} />
      {cutConfirm && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setCutConfirm(null) }}>
          <div className="modal" role="dialog" aria-modal="true">
            <h3>⚡ Cut on Graphtec</h3>
            <table className="modal-facts"><tbody>
              <tr><td>Cutter</td><td>{cutConfirm.device ?? 'Not connected yet — Chrome will ask which cutter to use, this once'}</td></tr>
              <tr><td>Stones</td><td>{framedCutJob.stones.length}{selectionCut ? ' (selected)' : cutLayer !== 'all' && cutLayer !== 'lines' ? ` (${cutLayer} layer)` : ''}</td></tr>
              {(framedCutJob.paths?.length ?? 0) > 0 && <tr><td>Cut lines</td><td>{framedCutJob.paths!.length} path{framedCutJob.paths!.length === 1 ? '' : 's'}{selectionCut && selVecs.size ? ' (selected)' : ''}{frameOn ? ' (incl. weeding frame)' : ''}</td></tr>}
              <tr><td>Size</td><td>{((bbox.maxX - bbox.minX) / 25.4).toFixed(2)}″ × {((bbox.maxY - bbox.minY) / 25.4).toFixed(2)}″</td></tr>
              {fromOrigin && placement === 'artboard' && (
                <tr><td>From origin</td><td>{fromOrigin.across.toFixed(2)}″ across, {fromOrigin.feed.toFixed(2)}″ up</td></tr>
              )}
              {framedCutJob.stones.length > 0 && <tr><td>{framedCutJob.paths?.length ? 'Holes material' : 'Material'}</td><td>{presetLabel(preset)}{sendConditions ? '' : ' (panel settings)'}</td></tr>}
              {(framedCutJob.paths?.length ?? 0) > 0 && <tr><td>{framedCutJob.stones.length ? 'Lines material' : 'Material'}</td><td>{presetLabel(linePreset)}{sendConditions ? '' : ' (panel settings)'}</td></tr>}
            </tbody></table>
            {framedCutJob.stones.length > 0 && (framedCutJob.paths?.length ?? 0) > 0 && linePreset !== preset && (
              <p className="modal-warn">
                Holes and cut lines use different materials, but this one job cuts both on the sheet that is loaded now.
                If they belong on different sheets, cancel and cut the holes and the lines as two jobs
                (highlight one, or pick a layer).
              </p>
            )}
            {offBoard && <p className="modal-warn">Part of the design is off the board and will be clipped.</p>}
            {spacingAudit.involved.length > 0 && (
              <p className="modal-warn">
                {spacingAudit.involved.length} stones sit closer than the spacing floor — the template may tear between holes.
                Fix in Production → Check spacing, or cut anyway.
              </p>
            )}
            <p className="hint">Blade at the front-right corner of the material, ORIGIN pressed on the cutter.</p>
            <div className="modal-actions">
              <button onClick={() => setCutConfirm(null)}>Cancel</button>
              <button className="primary" autoFocus onClick={() => { void doSendNow() }}>⚡ Cut now</button>
            </div>
          </div>
        </div>
      )}
      {mockupOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setMockupOpen(false) }}>
          <div className="modal" role="dialog" aria-modal="true" style={{ maxWidth: 580, maxHeight: '94vh', overflowY: 'auto' }}>
            <h3>Garment mockup</h3>
            <div className="chiprow">
              <button className={`chip ${mkMode === 'photo' ? 'active' : ''}`} onClick={() => setMkMode('photo')}>Product photo (S&amp;S)</button>
              <button className={`chip ${mkMode === 'tee' ? 'active' : ''}`} onClick={() => setMkMode('tee')}>Illustration</button>
            </div>
            {mkMode === 'photo' && (
              <>
                <div className="toolrow">
                  <input
                    placeholder="Search S&S styles — gildan 64000, hoodie, comfort colors…"
                    value={mkSearch}
                    onChange={(e) => setMkSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void searchStyles() }}
                  />
                  <button style={{ width: 'auto' }} onClick={() => { void searchStyles() }}>Search</button>
                </div>
                {mkResults.length > 0 && (
                  <div className="fontlist" style={{ maxHeight: 150 }}>
                    {mkResults.map((r) => (
                      <button key={r.ss_id} onClick={() => { void selectStyle(r) }}>{r.brand} — {r.name}<span>{r.ss_id}</span></button>
                    ))}
                  </div>
                )}
                {mkStyle && (
                  <p className="hint" style={{ margin: '4px 0' }}>
                    <b>{mkStyle.brand} {mkStyle.name}</b>
                    {mkColors.length > 0 && mkColors[mkColorIdx] ? ` · ${mkColors[mkColorIdx].name}` : ''}
                  </p>
                )}
                {mkColors.length > 0 && (
                  <div className="chiprow" style={{ maxHeight: 56, overflow: 'auto' }}>
                    {mkColors.map((c, i) => (
                      <button
                        key={c.name}
                        title={c.name}
                        onClick={() => setMkColorIdx(i)}
                        style={{
                          width: 20, height: 20, padding: 0, margin: 0, borderRadius: '50%', flex: 'none',
                          background: c.hex ?? '#888',
                          border: i === mkColorIdx ? '2px solid #f0b95e' : '1px solid #555',
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
            <canvas
              ref={mockupCanvasRef}
              // cap by viewport HEIGHT too: at full 520px width the 620px-tall
              // canvas pushed the view/size controls and the customer-PNG
              // button below the fold on a laptop screen
              style={{ borderRadius: 8, width: 'auto', maxWidth: '100%', maxHeight: 'min(48vh, 620px)', display: 'block', margin: '0 auto', cursor: 'grab', touchAction: 'none' }}
              onPointerDown={(e) => { mkDrag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId) }}
              onPointerMove={(e) => {
                const d = mkDrag.current
                if (!d) return
                const k = MOCKUP_W / e.currentTarget.getBoundingClientRect().width
                setMkOff((o) => ({ x: o.x + (e.clientX - d.x) * k, y: o.y + (e.clientY - d.y) * k }))
                mkDrag.current = { x: e.clientX, y: e.clientY }
              }}
              onPointerUp={() => { mkDrag.current = null }}
            />
            <div className="grid3" style={{ marginTop: 8 }}>
              {mkMode === 'tee' ? (
                <label>Garment
                  <input type="color" value={garmentColor} onChange={(e) => setGarmentColor(e.target.value)} style={{ width: '100%', height: 30, padding: 0 }} />
                </label>
              ) : (
                <label>View
                  <select value={mkView} onChange={(e) => setMkView(e.target.value as typeof mkView)}>
                    <option value="front">Front</option>
                    <option value="back">Back</option>
                  </select>
                </label>
              )}
              <label>Chest width
                <select value={chestIn} onChange={(e) => setChestIn(+e.target.value)}>
                  <option value={18}>S — 18″</option>
                  <option value={20}>M — 20″</option>
                  <option value={22}>L — 22″</option>
                  <option value={24}>XL — 24″</option>
                  <option value={26}>2XL — 26″</option>
                </select>
              </label>
              {mkMode === 'tee' ? (
                <label>Below collar
                  <select value={dropIn} onChange={(e) => setDropIn(+e.target.value)}>
                    {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}″</option>)}
                  </select>
                </label>
              ) : (
                <label>Photo chest span {mkSpan}%
                  <input type="range" min={40} max={90} value={mkSpan} onChange={(e) => setMkSpan(+e.target.value)} />
                </label>
              )}
            </div>
            <p className="hint">
              Drag the design to position it. Size is true to the chosen chest width
              {mkMode === 'photo' ? ' — nudge “Photo chest span” until the garment edges match the slider’s claim.' : ' — what the customer approves is what the template cuts.'}
            </p>
            <div className="modal-actions">
              <button onClick={() => setMockupOpen(false)}>Close</button>
              <button className="primary" onClick={downloadMockup}>Download PNG for the customer</button>
            </div>
          </div>
        </div>
      )}
      {showShortcuts && (
        <div className="shortcuts">
          <h3>Keyboard shortcuts</h3>
          <table><tbody>
            <tr><td>Click</td><td>select a hole · drag to move</td></tr>
            <tr><td>Shift-click</td><td>add to the selection</td></tr>
            <tr><td>Drag on board</td><td>box-select a group</td></tr>
            <tr><td>Double-click</td><td>select the whole design (shows resize handles)</td></tr>
            <tr><td>Arrows</td><td>nudge 0.5 mm · Shift: 5 mm</td></tr>
            <tr><td>Delete</td><td>remove selected holes</td></tr>
            <tr><td>⌘Z / ⌘⇧Z</td><td>undo / redo</td></tr>
            <tr><td>⌘A</td><td>select all</td></tr>
            <tr><td>⌘+ / ⌘−</td><td>zoom in / out</td></tr>
            <tr><td>⌘-wheel / pinch</td><td>zoom at the cursor · plain wheel pans</td></tr>
            <tr><td>F</td><td>fit design</td></tr>
            <tr><td>⌘0</td><td>fit sheet</td></tr>
            <tr><td>V / A / N</td><td>Select · Add/erase · Node tool</td></tr>
            <tr><td>Alt-drag</td><td>move without snapping</td></tr>
            <tr><td>⌘D</td><td>duplicate selection (5 mm offset)</td></tr>
            <tr><td>⌘C / ⌘V</td><td>copy / paste selection</td></tr>
          </tbody></table>
          <button onClick={() => setShowShortcuts(false)}>Close</button>
        </div>
      )}
      <div className="app-body">
      <aside className="panel" style={{ width: panelW, minWidth: panelW }}>
        <div className="statusbar">
          {pending > 0 && (
            <div><b className="pending">{pending} stone{pending === 1 ? '' : 's'} previewed — not added yet</b></div>
          )}
          <div>
            {status} · {stones.length} stones{stones.length > 0 && ` · ${((bbox.maxX - bbox.minX) / 25.4).toFixed(2)}×${((bbox.maxY - bbox.minY) / 25.4).toFixed(2)} in`}
            {fromOrigin && placement === 'artboard' && ` · ${fromOrigin.across.toFixed(2)}″ across, ${fromOrigin.feed.toFixed(2)}″ up from origin`}
          </div>
        </div>


        <Section title="Text">
          {/* Output comes FIRST: no stone holes appear until the user says
              rhinestones; cut-lines-only shows just the letter outlines. */}
          <label>Output</label>
          <div className="chiprow" style={{ marginBottom: 8 }}>
            {([['stones', '💎 Rhinestones'], ['lines', '✂️ Cut lines'], ['both', 'Both']] as const).map(([v, lbl]) => (
              <button key={v} className={`chip ${textOutput === v ? 'active' : ''}`} onClick={() => setTextOutput(v)}>{lbl}</button>
            ))}
          </div>
          {textOutput === null && (
            <div className="sizeinfo">Pick what this text becomes. Rhinestones previews the stone holes; Cut lines cuts the letter outlines themselves (vinyl lettering, a stencil); Both does both, aligned.</div>
          )}
          <label>Text<input value={text} onChange={(e) => setText(e.target.value)} /></label>
          <div className="fontpicker" ref={pickerRef}>
            <label>Font</label>
            <button className="fontbtn" onClick={() => setFontOpen((o) => {
              // Reopening with the last search still in the box shows only the
              // handful of fonts that matched it, which reads as "there are
              // only 3 fonts". Every open starts from the whole library.
              if (!o) { setFontSearch(''); setFontCat('all') }
              return !o
            })}>
              {fontName || 'Choose a font…'}
              <span className="caret">▾</span>
            </button>
            {fontOpen && (
              <div
                className="fontpanel"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1) }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1) }
                  else if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); setFontOpen(false) }
                }}>
                <div className="searchrow">
                  <input autoFocus value={fontSearch} onChange={(e) => setFontSearch(e.target.value)}
                    placeholder={`Search ${gfonts.length.toLocaleString()} Google fonts…`} />
                  {fontSearch && (
                    <button className="clearbtn" title="Clear search" onClick={() => setFontSearch('')}>×</button>
                  )}
                </div>
                <div className="chiprow">
                  {['all', ...(customFonts.length ? ['custom'] : []), 'display', 'sans-serif', 'serif', 'handwriting', 'monospace'].map((c) => (
                    <button key={c} className={`chip ${fontCat === c ? 'active' : ''}`} onClick={() => setFontCat(c)}>{c}</button>
                  ))}
                </div>
                <div className="fontlist">
                  {!fontMatches.length ? (
                    <div className="empty">No fonts match “{fontSearch}”</div>
                  ) : (
                    fontMatches.map((f, i) => (
                      <button
                        key={f.id}
                        className={`${selFont === f.id ? 'active' : ''} ${hiIdx === i ? 'hi' : ''}`}
                        onClick={() => {
                          // one click picks the font AND puts the panel away —
                          // it buried the rest of the column until Esc
                          // (Kevin, 2026-10-14). Arrow keys still browse live.
                          setHiIdx(i)
                          void loadGFont(f, weight)
                          setFontOpen(false)
                        }}
                      >
                        <FontPreviewName family={f.f} custom={f.id.startsWith('custom:')} />
                        <span>{f.c}</span>
                        {f.id.startsWith('custom:') && (
                          <span
                            className="delx"
                            title={`Remove ${f.f}`}
                            onClick={async (e) => {
                              e.stopPropagation()
                              await deleteFont(f.f).catch(() => {})
                              fontCache.current.delete(f.id)
                              setCustomFonts(await listFonts().catch(() => []))
                              if (selFont === f.id) { setSelFont(''); setFont(null); setFontName('') }
                              setStatus(`Removed ${f.f}`)
                            }}
                          >✕</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
                <p className="hint">↑ ↓ browse fonts live on canvas · Enter / Esc to close</p>
                <label className="filebtn">Install fonts (.ttf / .otf — multiple ok)
                  <input type="file" accept=".ttf,.otf,.woff" multiple onChange={async (e) => {
                    const files = [...(e.target.files ?? [])]
                    e.target.value = '' // same files can be re-picked later
                    if (!files.length) return
                    // parse first — a file that opentype can't read is
                    // rejected up front, never installed
                    let ok = 0
                    const bad: string[] = []
                    let last: { name: string; font: opentype.Font } | null = null
                    for (const f of files) {
                      const name = f.name.replace(/\.(ttf|otf|woff)$/i, '')
                      try {
                        const parsed = await loadFontFile(f)
                        await saveFont(name, await f.arrayBuffer())
                        fontCache.current.set(`custom:${name}`, parsed)
                        last = { name, font: parsed }
                        ok++
                      } catch {
                        bad.push(f.name)
                      }
                    }
                    setCustomFonts(await listFonts().catch(() => []))
                    if (last) {
                      setFont(last.font)
                      setFontName(last.name)
                      setSelFont(`custom:${last.name}`)
                    }
                    setStatus(
                      `Installed ${ok} font${ok === 1 ? '' : 's'}` +
                      (bad.length ? ` · could not parse: ${bad.join(', ')}` : ''),
                    )
                    if (ok && !bad.length) setFontOpen(false)
                  }} />
                </label>
              </div>
            )}
          </div>
          <div className="grid2">
            <label>Weight
              <select value={weight} onChange={(e) => {
                const w = e.target.value as 'bold' | 'regular'
                setWeight(w)
                const gf = gfonts.find((f) => f.id === selFont)
                if (gf) void loadGFont(gf, w)
              }}>
                <option value="bold">Bold</option>
                <option value="regular">Regular</option>
              </select>
            </label>
            {wantStones ? (
              <label>Stone placement
                <select value={textMode} onChange={(e) => setTextMode(e.target.value as StoneMode)}>
                  <option value="outline">Outline only</option>
                  <option value="fill">Solid fill only</option>
                  <option value="both">Outline + fill</option>
                </select>
              </label>
            ) : (
              <div />
            )}
          </div>
          <div className="grid2">
            <label>Height (mm)
              <input type="number" min={10} max={500} value={textHeight} onChange={(e) => setTextHeight(+e.target.value)} />
            </label>
            <label>Width (mm)
              {/* width drives height through the font's fixed aspect; commit
                  on blur/Enter so live typing doesn't re-scale mid-keystroke */}
              <input type="number" min={10} max={2000}
                key={`tw-${textPreview ? Math.round(textPreview.widthMm) : 0}`}
                defaultValue={textPreview ? Math.round(textPreview.widthMm) : undefined}
                disabled={!textPreview}
                onBlur={(e) => {
                  if (!textPreview) return
                  const v = +e.target.value
                  if (!v || Math.abs(v - textPreview.widthMm) < 0.5) return
                  setTextHeight(Math.max(10, Math.min(500, Math.round(textHeight * (v / textPreview.widthMm)))))
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </label>
          </div>
          <div className="grid2">
            <label>Letter spacing
              <input type="number" min={0} max={20} value={letterSpacing} onChange={(e) => setLetterSpacing(+e.target.value)} />
            </label>
            <div />
          </div>
          <label>Arc bend {textBend ? `${textBend}°` : '— straight'}
            <input type="range" min={-180} max={180} step={5} value={textBend} onChange={(e) => setTextBend(+e.target.value)} />
          </label>
          {textBend !== 0 && (
            <div className="toolrow">
              <button onClick={() => setTextBend(0)}>Straighten</button>
              <span className="hint" style={{ alignSelf: 'center' }}>letters stay rigid — rotated along the arc, never warped</span>
            </div>
          )}
          {textPreview && (
            <div className="sizeinfo">
              Size: <b>{(textPreview.widthMm / 25.4).toFixed(2)}″ × {(textHeight / 25.4).toFixed(2)}″</b>
              <span> · {Math.round(textPreview.widthMm)} × {textHeight} mm in {fontName}{previewStones ? ` · ${previewStones.length} stones` : ''}</span>
            </div>
          )}
          {/* The commit button lives HERE too — the Stones section's copy was
              below the fold of a collapsed panel and nobody found it. */}
          <button className={`primary${pendingText ? ' urgent' : ''}`} disabled={!textOutput || !textPreview} onClick={addTextOutput}>
            {addTextLabel}
          </button>
          <details className="sec sub">
            <summary>Team names</summary>
            <div className="sec-body">
              <p className="hint">
                One name per line — each becomes its own template with the font, height, arc and
                output chosen above, stacked down the board. Spirit-wear rosters in one click.
              </p>
              <textarea
                rows={5}
                value={teamNames}
                onChange={(e) => setTeamNames(e.target.value)}
                placeholder={'ASHLEY\nBRIANNA\nCAMILLE'}
              />
              <button
                className="primary"
                disabled={!font || !textOutput || !teamNames.trim()}
                onClick={generateTeamNames}
              >
                Make {teamNames.split('\n').filter((s) => s.trim()).length || ''} name template{teamNames.split('\n').filter((s) => s.trim()).length === 1 ? '' : 's'}
              </button>
            </div>
          </details>
        </Section>
        <Section title="Stones">
          <div className="grid2">
            <label>Size
              <select value={curSize} onChange={(e) => setCurSize(e.target.value)}>
                {sizeKeys.map((k) => (
                  <option key={k} value={k}>{k} · hole {sizes[k].holeMm} mm</option>
                ))}
              </select>
            </label>
            <label>Color
              <input type="color" value={outlineColor} onChange={(e) => setOutlineColor(e.target.value)} />
            </label>
          </div>
          <Swatches value={outlineColor} onPick={setOutlineColor} />
          <div className="grid2">
            <label>Hole ⌀ (mm)
              <input type="number" step={0.1} min={1} max={12} value={sizes[curSize].holeMm}
                onChange={(e) => setSizes((prev) => ({ ...prev, [curSize]: { ...prev[curSize], holeMm: +e.target.value } }))} />
            </label>
            <label>Spacing (mm)
              <input type="number" step={0.1} min={0.4} max={15} value={gap} onChange={(e) => setGap(+e.target.value)} />
            </label>
          </div>
          <div className="chiprow">
            {[['Dense', 0.5], ['Standard', 0.8], ['Open', 3], ['Scatter', 8]].map(([name, v]) => (
              <button key={name as string} className={`chip ${gap === v ? 'active' : ''}`} onClick={() => setGap(v as number)}>{name}</button>
            ))}
          </div>
          <label className="row">
            <input type="checkbox" checked={uniformRhythm} onChange={(e) => setUniformRhythm(e.target.checked)} />
            Uniform rhythm — verticals match horizontals per letter
          </label>
          {outlineDesign === 'double' && !canEcho && echoUpsize && (
            <div className="sizeinfo warn">
              Double outline doesn't fit at this size.
              <div className="toolrow">
                <button onClick={() => setTextHeight(echoUpsize)}>Upsize to {echoUpsize} mm</button>
                <button onClick={() => setOutlineDesign('single')}>Use single outline</button>
              </div>
            </div>
          )}
          <div className="grid2">
            <label>Outline design
              <select value={outlineDesign} onChange={(e) => setOutlineDesign(e.target.value as typeof outlineDesign)}>
                <option value="single">Single outline</option>
                <option value="double">
                  {canEcho ? 'Double — echo row outside' : 'Double — needs upsize'}
                </option>
                <option value="ghost">Ghost — floats outside</option>
                <option value="centerline">Single-line lettering</option>
              </select>
            </label>
            <label>Narrow strokes
              <select value={strokePolicy} disabled={outlineDesign === 'centerline'}
                onChange={(e) => setStrokePolicy(e.target.value as typeof strokePolicy)}>
                <option value="auto">Auto fallback</option>
                <option value="walls">Force walls</option>
              </select>
            </label>
          </div>
          <button className={`primary${pendingText ? ' urgent' : ''}`} disabled={!textOutput || !textPreview} onClick={addTextOutput}>
            {addTextLabel}
          </button>
          {wantLines && (
            <p className="hint">Cut lines follow the letter outlines — vinyl lettering, a stencil, or a border around the stones.</p>
          )}
        </Section>
        <Section title="Fill">
          <div className="grid2">
            <label>Fill stone
              <select value={fillSize} onChange={(e) => setFillSize(e.target.value)}>
                {Object.keys(sizes).map((k) => (
                  <option key={k} value={k}>{k} · {sizes[k].holeMm} mm</option>
                ))}
              </select>
            </label>
            <label>Color
              <input type="color" value={fillColor} onChange={(e) => setFillColor(e.target.value)} />
            </label>
          </div>
          <Swatches value={fillColor} onPick={setFillColor} />
          <div className="sizeinfo">
            Even spacing: stepped on the fill stone ·{' '}
            <b>{((sizes[fillSize]?.holeMm ?? 2.5) + hardGapOf(gap)).toFixed(1)} mm</b>
            <span> — set it in Stones · Spacing</span>
          </div>
          <label>Fill style
            <select value={fillStyle} onChange={(e) => setFillStyle(e.target.value as typeof fillStyle)}>
              <option value="brick">Brick — offset rows</option>
              <option value="grid">Grid — aligned rows</option>
              <option value="concentric">Concentric — rings following the edge</option>
              <option value="radial">Radial — rays from the center</option>
            </select>
          </label>
        </Section>

        <Section title="Shapes" defaultOpen={false}>
          <div className="chiprow">
            {SHAPE_NAMES.map((sh) => (
              <button
                key={sh.kind}
                className={`chip ${shapeKind === sh.kind ? 'active' : ''}`}
                onClick={() => setShapeKind(sh.kind)}
              >
                {sh.label}
              </button>
            ))}
          </div>
          <div className="grid2">
            <label>Width (mm)
              <input type="number" min={5} max={600} value={shapeW}
                onChange={(e) => {
                  const w = Math.max(1, +e.target.value || 1)
                  setShapeW(w)
                  // circle and square are defined by their smaller side, so
                  // let width drive height for them rather than silently
                  // ignoring one of the two boxes
                  if (shapeKind === 'circle' || shapeKind === 'square') setShapeH(w)
                }} />
            </label>
            <label>Height (mm)
              <input type="number" min={5} max={600}
                disabled={shapeKind === 'circle' || shapeKind === 'square'}
                value={shapeH}
                onChange={(e) => setShapeH(Math.max(1, +e.target.value || 1))} />
            </label>
          </div>
          <label>Style
            <select value={shapeMode} onChange={(e) => setShapeMode(e.target.value as StoneMode)}>
              <option value="outline">Outline</option>
              <option value="fill">Fill</option>
              <option value="both">Outline + fill</option>
            </select>
          </label>
          <p className="hint">
            Uses the same stone size, spacing, outline and fill settings as text — set those in
            the Stones and Fill panels. Shapes are added below the existing design.
          </p>
          <button className="primary" onClick={generateShape}>Add {shapeKind} stones</button>
          <button onClick={shapeAsCutLines}>Add {shapeKind} as a cut line</button>
          <details className="sec sub">
            <summary>Scatter spray</summary>
            <div className="sec-body">
              <p className="hint">
                Random stones fading off the edge of the selected design — the bling-spray look.
                Select a design (double-click it) or a cut-line object first.
              </p>
              <div className="grid2">
                <label>Band (mm)
                  <input type="number" min={2} max={100} value={scatterBand} onChange={(e) => setScatterBand(Math.max(2, +e.target.value || 2))} />
                </label>
                <label>Density {scatterDensity}%
                  <input type="range" min={10} max={100} step={5} value={scatterDensity} onChange={(e) => setScatterDensity(+e.target.value)} />
                </label>
              </div>
              <label className="row">
                <input type="checkbox" checked={scatterMix} onChange={(e) => setScatterMix(e.target.checked)} />
                Mix sizes — blend the outline and fill stones
              </label>
              <button className="primary" disabled={!selection.size && !selVecs.size} onClick={scatterSpray}>
                Scatter around selection
              </button>
            </div>
          </details>
        </Section>

        <Section title="Templates" defaultOpen={false}>
          <p className="hint">
            {tplCats.reduce((n, c) => n + c.items.length, 0)} public-domain designs — click one to
            load it as the working image, then tune style and width in the Image section.
          </p>
          <div className="chiprow" style={{ maxHeight: 74, overflow: 'auto' }}>
            {tplCats.map((c) => (
              <button
                key={c.slug}
                className={`chip ${tplCat === c.slug ? 'active' : ''}`}
                onClick={() => setTplCat(c.slug)}
              >
                {c.label} ({c.items.length})
              </button>
            ))}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 6,
              maxHeight: 300,
              overflow: 'auto',
              marginTop: 6,
            }}
          >
            {(tplCats.find((c) => c.slug === tplCat)?.items ?? []).map((t) => (
              <img
                key={t.file}
                src={`/templates/${t.file}`}
                title={t.name}
                loading="lazy"
                style={{
                  width: '100%',
                  aspectRatio: '1',
                  objectFit: 'contain',
                  background: '#fff',
                  borderRadius: 6,
                  cursor: 'pointer',
                  padding: 4,
                  boxSizing: 'border-box',
                }}
                onClick={() => loadTemplate(t)}
              />
            ))}
          </div>
        </Section>

        <Section title="Image">
          <div className="grid2">
            <label>Width (mm)
              <input type="number" min={20} max={600} value={imgWidth} onChange={(e) => setImgWidth(+e.target.value)} />
            </label>
            <label>Style
              <select value={imgMode} onChange={(e) => setImgMode(e.target.value as StoneMode)}>
                <option value="outline">Outline</option>
                <option value="fill">Fill</option>
                <option value="both">Outline + fill</option>
              </select>
            </label>
          </div>
          <label>Detail</label>
          <div className="chiprow">
            {([['fine', 'Fine — trace as drawn'], ['smooth', 'Smooth'], ['bold', 'Bold — weld fur/hatching']] as const).map(([v, lbl]) => (
              <button key={v} className={`chip ${imgDetail === v ? 'active' : ''}`} title={lbl} onClick={() => setImgDetail(v)}>
                {lbl.split(' — ')[0]}
              </button>
            ))}
          </div>
          {imgOcr && !imgTextMasked && (
            <div className="sizeinfo warn">
              Lettering detected in this image — traced letters come out smeary. Type the real
              words and they'll render from font geometry instead{imgOcr.bendDeg ? `, arc matched (${imgOcr.bendDeg}°)` : ''}:
              <input
                value={imgOcrText}
                onChange={(e) => setImgOcrText(e.target.value)}
                placeholder="correct the detected text…"
                style={{ marginTop: 6 }}
              />
              <div className="toolrow">
                <button
                  className="primary"
                  disabled={!imgOcrText.trim()}
                  onClick={() => {
                    setImgTextMasked(true) // re-traces without the lettering region
                    setText(imgOcrText.trim())
                    setTextBend(imgOcr.bendDeg)
                    setTextOutput('stones')
                    openSection('Text', 'input')
                    setStatus('Lettering masked from the trace — pick a font, then Add; drag the text preview onto the artwork')
                  }}
                >Use typed text</button>
                <button onClick={() => setImgOcr(null)}>Keep traced</button>
              </div>
            </div>
          )}
          {imgTextMasked && (
            <p className="hint">
              Lettering is masked out of this trace — the Text panel is handling it.{' '}
              <button style={{ width: 'auto', padding: '2px 8px', fontSize: 11 }} onClick={() => setImgTextMasked(false)}>Unmask</button>
            </p>
          )}
          <label>Threshold {imgThreshold}
            <input type="range" min={10} max={245} value={imgThreshold} onChange={(e) => setImgThreshold(+e.target.value)} />
          </label>
          <label className="row"><input type="checkbox" checked={imgInvert} onChange={(e) => setImgInvert(e.target.checked)} /> Invert (light areas get stones)</label>
          <label className="row"><input type="checkbox" checked={imgAlphaKey} onChange={(e) => setImgAlphaKey(e.target.checked)} /> Use transparency (opaque art = design)</label>
          <label className="row"><input type="checkbox" checked={imgLinework} onChange={(e) => setImgLinework(e.target.checked)} /> Keep dark linework open (cartoon lines stay stone-free)</label>
          <button
            onClick={() => setTsbOpen((o) => !o)}
            style={{ width: '100%', marginBottom: 6 }}
          >
            {tsbOpen ? 'Hide TSB shape library' : 'Browse my TSB shape library…'}
          </button>
          {tsbOpen && (
            <div style={{ marginBottom: 8 }}>
              <div className="chiprow" style={{ maxHeight: 74, overflow: 'auto' }}>
                {tsbCats.map((c) => (
                  <button
                    key={c.name}
                    className={`chip ${tsbCat === c.name ? 'active' : ''}`}
                    onClick={() => setTsbCat(c.name)}
                  >
                    {c.name} ({c.count})
                  </button>
                ))}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 6,
                  maxHeight: 240,
                  overflow: 'auto',
                  marginTop: 6,
                }}
              >
                {tsbShapes.map((s) => (
                  <img
                    key={s.id}
                    src={tsbThumb(s.image_url)}
                    title={s.name}
                    loading="lazy"
                    style={{ width: '100%', background: '#fff', borderRadius: 6, cursor: 'pointer' }}
                    onClick={async () => {
                      try {
                        setStatus(`Loading ${s.name}…`)
                        const blob = await fetch(tsbThumb(s.image_url)).then((r) => {
                          if (!r.ok) throw new Error(String(r.status))
                          return r.blob()
                        })
                        const f = new File([blob], `${s.name}.png`, { type: blob.type || 'image/png' })
                        setImageFile(f)
                        const a = await analyzeImage(f, imgWidth, (sizes[curSize]?.holeMm ?? 3.4) + gap)
                        setImgThreshold(a.threshold)
                        setImgInvert(a.invert)
                        setImgAlphaKey(a.alphaKey)
                        setImgLinework(a.linework)
                        applyStrokeStyle(a)
                        setStatus(`${s.name} — ${a.note}`)
                      } catch {
                        setStatus(`Could not load ${s.name}`)
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          <label className="filebtn">{imageFile?.name || 'Choose image (PNG/JPG/SVG) — or drop one on the board'}
            <input type="file" accept="image/*" onChange={async (e) => {
              const f = e.target.files?.[0] ?? null
              if (f) await loadImageFile(f)
              else setImageFile(null)
            }} />
          </label>
          <button className={pendingImage ? 'primary urgent' : ''} onClick={generateImage}>
            {pendingImage ? `Add ${pendingImage} image stones to design` : 'Add image stones'}
          </button>
          <details className="sec sub">
            <summary>Multi-color</summary>
            <div className="sec-body">
              <p className="hint">
                Split the image into color regions — each becomes stones in its own color, one
                design, one template. Stone sizes come from the Stones and Fill panels.
              </p>
              <div className="grid2">
                <label>Colors
                  <select value={mcColors} onChange={(e) => setMcColors(+e.target.value)}>
                    {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <button style={{ alignSelf: 'end' }} disabled={!imageFile} onClick={() => { void traceColors() }}>
                  Trace colors
                </button>
              </div>
              {mcLayers && mcLayers.map((L, i) => (
                <div key={i} className="toolrow" style={{ alignItems: 'center', gap: 8 }}>
                  <input
                    type="color"
                    value={L.color}
                    style={{ width: 34, padding: 0, height: 24, flex: 'none' }}
                    onChange={(e) => setMcLayers((ls) => ls!.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}
                  />
                  <span style={{ flex: 1, fontSize: 12, color: '#8b97b5' }}>{Math.round(L.share * 100)}% of the artwork</span>
                  <button
                    style={{ width: 'auto', flex: 'none' }}
                    title="Drop this region — it gets no stones"
                    onClick={() => setMcLayers((ls) => (ls!.length > 1 ? ls!.filter((_, j) => j !== i) : ls))}
                  >×</button>
                </div>
              ))}
              {mcLayers && (
                <button className="primary" onClick={commitMultiColor}>
                  Add multi-color stones
                </button>
              )}
            </div>
          </details>
          <button disabled={!imageFile} onClick={() => { void imageAsCutLines() }}>
            Trace to cut lines (vinyl / stencil)
          </button>
          <p className="hint">
            Trace turns the image's outlines into cut paths instead of stone holes — uses the same
            Threshold / Invert / transparency settings above. Edit the result with the Nodes tool,
            offset it, or combine it with Pathfinder.
          </p>
        </Section>

        <Section title="Vector cut">
          <p className="hint">
            Cut an SVG's outlines as lines on the Graphtec — vinyl, stencils, the template's own border.
            Every shape in the file becomes a cut path; text must be converted to outlines first.
          </p>
          <button onClick={importSvg}>Import SVG…</button>
          {vectors.map((v) => {
            const b = vecBox(v)
            return (
              <div key={v.id} className={`veclist${selVecs.has(v.id) ? ' sel' : ''}`} onClick={(e) => { setSelVecs((prev) => e.shiftKey ? (prev.has(v.id) ? new Set([...prev].filter((x) => x !== v.id)) : new Set([...prev, v.id])) : new Set([v.id])); setSelection(new Set()) }}>
                <div className="vecname">{v.name} <span className="dim">· {v.base.length} line{v.base.length === 1 ? '' : 's'}</span></div>
                <div className="grid2" key={`vs-${v.id}-${v.s.toFixed(4)}`}>
                  <label>Width (mm)
                    <input type="number" min={1} step={1} defaultValue={Math.round(b.maxX - b.minX)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { resizeVector(v.id, +(e.target as HTMLInputElement).value || null, null); (e.target as HTMLInputElement).blur() } }}
                      onBlur={(e) => { const n = +e.target.value; if (n && Math.abs(n - (b.maxX - b.minX)) >= 0.5) resizeVector(v.id, n, null) }} />
                  </label>
                  <label>Height (mm)
                    <input type="number" min={1} step={1} defaultValue={Math.round(b.maxY - b.minY)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { resizeVector(v.id, null, +(e.target as HTMLInputElement).value || null); (e.target as HTMLInputElement).blur() } }}
                      onBlur={(e) => { const n = +e.target.value; if (n && Math.abs(n - (b.maxY - b.minY)) >= 0.5) resizeVector(v.id, null, n) }} />
                  </label>
                </div>
                <div className="toolrow">
                  <button onClick={(e) => { e.stopPropagation(); mutateVectors((prev) => prev.filter((x) => x.id !== v.id)); setSelVecs((prev) => { const n = new Set(prev); n.delete(v.id); return n }) }}>Remove</button>
                </div>
              </div>
            )
          })}
          {vectors.length > 0 && (
            <p className="hint">Click a line on the board to select it, drag to move, arrows nudge. Lines cut after the holes, in the same pass.</p>
          )}
        </Section>

        <Section title="Align & Pathfinder">
          <p className="hint">
            Works on what is selected: cut-line objects (shift-click or box-select for several) and stone designs.
            {alignCount ? ` ${alignCount} object${alignCount === 1 ? '' : 's'} selected.` : ' Nothing selected.'}
          </p>
          <label>Align to
            <select value={alignTo} onChange={(e) => setAlignTo(e.target.value as typeof alignTo)}>
              <option value="selection">Selection</option>
              <option value="board">Board</option>
            </select>
          </label>
          <div className="iconrow">
            {([
              ['left', 'Align left', <AlignIcon kind="left" />],
              ['hcenter', 'Align horizontal centers', <AlignIcon kind="hcenter" />],
              ['right', 'Align right', <AlignIcon kind="right" />],
              ['top', 'Align top', <AlignIcon kind="top" />],
              ['vcenter', 'Align vertical centers', <AlignIcon kind="vcenter" />],
              ['bottom', 'Align bottom', <AlignIcon kind="bottom" />],
            ] as [AlignEdge, string, React.ReactNode][]).map(([k, title, icon]) => (
              <button key={k} className="iconbtn" title={title} disabled={!alignCount} onClick={() => alignSelected(k)}>{icon}</button>
            ))}
          </div>
          <div className="iconrow">
            <button className="iconbtn" title="Distribute horizontal centers" disabled={alignCount < 3} onClick={() => distributeSelected('x', 'centers')}><AlignIcon kind="dist-h" /></button>
            <button className="iconbtn" title="Distribute vertical centers" disabled={alignCount < 3} onClick={() => distributeSelected('y', 'centers')}><AlignIcon kind="dist-v" /></button>
            <button className="iconbtn" title="Equal horizontal spacing" disabled={alignCount < 3} onClick={() => distributeSelected('x', 'spacing')}><AlignIcon kind="space-h" /></button>
            <button className="iconbtn" title="Equal vertical spacing" disabled={alignCount < 3} onClick={() => distributeSelected('y', 'spacing')}><AlignIcon kind="space-v" /></button>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>Pathfinder — shape modes on the selected cut-line objects. The result replaces them; Undo brings them back.</p>
          <div className="iconrow">
            <button className="iconbtn" title="Unite" disabled={!selVecs.size} onClick={() => pathfinder('union')}><AlignIcon kind="unite" /></button>
            <button className="iconbtn" title="Minus front (back object keeps, front objects cut away)" disabled={selVecs.size < 2} onClick={() => pathfinder('difference')}><AlignIcon kind="minus" /></button>
            <button className="iconbtn" title="Intersect" disabled={selVecs.size < 2} onClick={() => pathfinder('intersection')}><AlignIcon kind="intersect" /></button>
            <button className="iconbtn" title="Exclude (overlap removed)" disabled={selVecs.size < 2} onClick={() => pathfinder('xor')}><AlignIcon kind="exclude" /></button>
          </div>
          <div className="iconlabels"><span>Unite</span><span>Minus front</span><span>Intersect</span><span>Exclude</span></div>
          <p className="hint" style={{ marginTop: 10 }}>Offset — grow or shrink the selected cut-line objects' boundaries (an echo outline, a template clearance ring).</p>
          <div className="grid2">
            <label>Offset (mm)
              <input type="number" min={0.1} max={50} step={0.5} value={offsetMm} onChange={(e) => setOffsetMm(Math.max(0.1, +e.target.value || 0.1))} />
            </label>
            <div className="toolrow" style={{ alignSelf: 'end' }}>
              <button disabled={!selVecs.size} onClick={() => applyOffset(1)}>Grow</button>
              <button disabled={!selVecs.size} onClick={() => applyOffset(-1)}>Shrink</button>
            </div>
          </div>
          <button style={{ marginTop: 8 }} disabled={!selVecs.size} onClick={ungroup}>Ungroup — split into letters</button>
          <p className="hint">Splits a text cut-line object into one object per letter (holes stay with their letter), so you can move or restyle letters independently.</p>
        </Section>

        <Section title="Edit">
          <div className="toolrow">
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>Select / move</button>
            <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')}>Add / erase</button>
            <button className={tool === 'node' ? 'active' : ''} onClick={() => setTool('node')}>Nodes</button>
            <button className={tool === 'pen' ? 'active' : ''} onClick={() => setTool('pen')}>Pen</button>
          </div>
          <p className="hint">
            {tool === 'select'
              ? 'Click a hole to select it, drag to move. Shift-click adds to the selection, drag on empty board boxes a group. Double-click a design to grab all of it: drag its handles to resize (holes stay the same size, the count changes). Arrow keys nudge 0.5 mm (Shift: 5 mm), Delete removes.'
              : tool === 'add'
                ? 'Click empty board to add a hole; clicking an existing hole ERASES it. Switch to Select / move to drag holes.'
                : tool === 'node'
                  ? 'Click a cut-line object to edit its points: drag a node to move it, shift-click selects several, double-click a segment inserts a node, Delete removes the selected nodes. Works on cut-line objects (imported SVGs, shapes, text cut lines), not on stones.'
                  : 'Click along the line you want — stones bead along it at the panel’s stone size and spacing. Enter or double-click finishes, clicking the first point closes the loop, Backspace removes the last point, Esc cancels.'}
          </p>
          {tool === 'pen' && (
            <label>Pen output
              <select value={penOut} onChange={(e) => setPenOut(e.target.value as typeof penOut)}>
                <option value="stones">Stones along the path</option>
                <option value="line">Cut line</option>
                <option value="both">Both</option>
              </select>
            </label>
          )}
          {selectedEl != null && selBox && (
            <div className="grid2" key={`sz-${selectedEl}-${selBox.minX.toFixed(1)}-${(selBox.maxX - selBox.minX).toFixed(1)}`}>
              <label>Design width (mm)
                <input type="number" min={5} step={1} defaultValue={Math.round(selBox.maxX - selBox.minX)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { resizeSelectedTo(+(e.target as HTMLInputElement).value || null, null); (e.target as HTMLInputElement).blur() } }}
                  onBlur={(e) => { const v = +e.target.value; if (v && Math.abs(v - (selBox.maxX - selBox.minX)) >= 0.5) resizeSelectedTo(v, null) }} />
              </label>
              <label>Design height (mm)
                <input type="number" min={5} step={1} defaultValue={Math.round(selBox.maxY - selBox.minY)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { resizeSelectedTo(null, +(e.target as HTMLInputElement).value || null); (e.target as HTMLInputElement).blur() } }}
                  onBlur={(e) => { const v = +e.target.value; if (v && Math.abs(v - (selBox.maxY - selBox.minY)) >= 0.5) resizeSelectedTo(null, v) }} />
              </label>
            </div>
          )}
          <label>New stone size
            <select value={addSize} onChange={(e) => setAddSize(e.target.value)}>
              <option value="auto">Auto — match nearest stone</option>
              {Object.keys(sizes).map((k) => (
                <option key={k} value={k}>{k} · {sizes[k].holeMm} mm</option>
              ))}
            </select>
          </label>
          <div className="toolrow">
            <button disabled={!selection.size} onClick={() => {
              mutate((prev) => prev.map((s, i) => (selection.has(i) ? { ...s, size: curSize } : s)))
            }}>Set selected → {curSize}</button>
          </div>
          <div className="toolrow">
            <button
              disabled={!stones.some((st) => (st.layer ?? 'outline') === 'fill')}
              onClick={respaceFill}
            >
              Respace fill — even out after edits
            </button>
          </div>
          <div className="grid2">
            <label>Scale %
              <input
                type="number"
                min={10}
                max={400}
                step={5}
                value={scalePct}
                onChange={(e) => setScalePct(+e.target.value)}
              />
            </label>
            <button
              disabled={!stones.length || scalePct === 100}
              style={{ alignSelf: 'end' }}
              onClick={applyScale}
            >
              Scale {selection.size ? `${selection.size} selected` : 'all'}
            </button>
          </div>
          <p className="hint">
            Scales stone positions about the center (sizes stay physical). Double-click a design
            to select it first, or scale everything.
          </p>
          <div className="toolrow">
            <button
              disabled={!stones.length && !pending}
              onClick={() => {
                if (stones.length) mutate(() => [])
                setSelection(new Set())
                // Clear the preview's SOURCE, not just its rendered output.
                // Nulling previewStones alone left the preview unrecoverable:
                // both preview effects only re-run when their inputs change,
                // so nothing regenerated until a setting happened to move.
                setText('')
                setImageFile(null)
                setImagePreview(null)
                setPreviewStones(null)
                setPreviewLive(false)
              }}
            >Clear all</button>
          </div>
          <p className="hint">Click = select · shift-click = multi · drag empty space = box select · double-click = select whole design · drag = move · Del = delete · ⌘Z undo · ⌘A select all. In Add mode, clicking a stone erases it.</p>
          <p className="hint">Pinch or ⌘-scroll = zoom at the cursor · F = fit design · ⌘0 = fit sheet · ⌘+ / ⌘− = zoom.</p>
        </Section>

        <Section title="Production">
          <p className="hint">Stone counts for this design — what to pull from stock or order.</p>
          {bom.length === 0 ? (
            <p className="hint">No stones on the board yet.</p>
          ) : (
            <table className="bom">
              <thead>
                <tr><th>Color</th><th>Size</th><th style={{ textAlign: 'right' }}>Holes</th><th style={{ textAlign: 'right' }}>Order</th></tr>
              </thead>
              <tbody>
                {bom.map((r) => (
                  <tr key={`${r.size}|${r.color}`}>
                    <td title={r.color}><span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', background: r.color, border: '1px solid #666', marginRight: 6, verticalAlign: -1 }} />{colorName(r.color)}</td>
                    <td>{r.size}</td>
                    <td style={{ textAlign: 'right' }}>{r.n}</td>
                    <td style={{ textAlign: 'right' }}>{Math.ceil(r.n * 1.1)}</td>
                  </tr>
                ))}
                <tr>
                  <th colSpan={2}>Total</th>
                  <th style={{ textAlign: 'right' }}>{stones.length}</th>
                  <th style={{ textAlign: 'right' }}>{Math.ceil(stones.length * 1.1)}</th>
                </tr>
              </tbody>
            </table>
          )}
          <p className="hint">Order adds 10% for spills and culls.</p>
          <div className="toolrow">
            <button disabled={!stones.length} onClick={showOverlaps}>
              Check spacing{spacingAudit.involved.length ? ` — ${spacingAudit.involved.length} tight` : ''}
            </button>
            {spacingAudit.removal.length > 0 && (
              <button onClick={fixOverlaps}>Fix ({spacingAudit.removal.length})</button>
            )}
          </div>
          <p className="hint">Manual edits can push stones below the spacing floor; Check selects the crowded ones, Fix removes the minimum set.</p>
          <button disabled={!stones.length && !vectors.length} onClick={printWorkOrder}>Print work order…</button>
          <button disabled={!stones.length && !vectors.length} onClick={printPlacementGuide}>Print 1:1 placement guide…</button>
          <p className="hint">
            True-size print, tiled across pages with tape marks — lay it under a cut template to
            verify, or hand-place stones on it. Print at 100%, never "fit to page"; page A1 has a
            100 mm calibration bar to check.
          </p>
          <p className="hint" style={{ marginTop: 14 }}>
            Step &amp; repeat — tile copies of the selection (or the whole design) across the sheet
            for batch cutting. Copies are independent designs.
          </p>
          <div className="grid3">
            <label>Columns
              <input type="number" min={1} max={20} value={repCols} onChange={(e) => setRepCols(Math.max(1, Math.round(+e.target.value || 1)))} />
            </label>
            <label>Rows
              <input type="number" min={1} max={20} value={repRows} onChange={(e) => setRepRows(Math.max(1, Math.round(+e.target.value || 1)))} />
            </label>
            <label>Gap (mm)
              <input type="number" min={0} max={100} step={1} value={repGap} onChange={(e) => setRepGap(Math.max(0, +e.target.value || 0))} />
            </label>
          </div>
          <button disabled={(!stones.length && !vectors.length) || repCols * repRows < 2} onClick={stepAndRepeat}>
            Repeat {repCols} × {repRows}
          </button>
          <p className="hint">Duplicate one copy: ⌘D (5 mm offset) · copy/paste: ⌘C / ⌘V.</p>
        </Section>

        <Section title="Material">
          <label>Preset
            <select value={presetIdx} onChange={(e) => setPresetIdx(+e.target.value)}>
              {Array.from(new Set(presets.map((p) => p.group ?? 'My presets'))).map((g) => (
                <optgroup key={g} label={g}>
                  {presets.map((p, i) => (p.group ?? 'My presets') === g ? <option key={i} value={i}>{p.name}</option> : null)}
                </optgroup>
              ))}
            </select>
          </label>
          {(preset.blade || preset.note) && (
            <p className="hint">
              {preset.blade && <><b>Blade:</b> {preset.blade}. </>}
              {preset.note}
              {' '}Starting point — always test cut; lower force if the liner is scored, raise it if the blade does not go through.
            </p>
          )}
          <div className="grid3">
            <label>Force<input type="number" min={1} max={38} value={preset.force} onChange={(e) => updatePreset({ force: +e.target.value })} /></label>
            <label>Speed<input type="number" min={1} max={64} value={preset.speed} onChange={(e) => updatePreset({ speed: +e.target.value })} /></label>
            <label>Passes<input type="number" min={1} max={5} value={preset.passes} onChange={(e) => updatePreset({ passes: +e.target.value })} /></label>
          </div>
          <button onClick={addPreset}>Save as new preset</button>
          {vectors.length > 0 && (
            <>
              <label>Vector cut lines
                <select value={linePresetIdx} onChange={(e) => setLinePresetName(+e.target.value < 0 ? null : presets[+e.target.value].name)}>
                  <option value={-1}>Same as holes ({preset.name})</option>
                  {Array.from(new Set(presets.map((p) => p.group ?? 'My presets'))).map((g) => (
                    <optgroup key={g} label={g}>
                      {presets.map((p, i) => (p.group ?? 'My presets') === g ? <option key={i} value={i}>{p.name}</option> : null)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {linePresetIdx >= 0 && (
                <div className="grid3">
                  <label>Force<input type="number" min={1} max={38} value={linePreset.force} onChange={(e) => updatePresetAt(linePresetIdx, { force: +e.target.value })} /></label>
                  <label>Speed<input type="number" min={1} max={64} value={linePreset.speed} onChange={(e) => updatePresetAt(linePresetIdx, { speed: +e.target.value })} /></label>
                  <label>Passes<input type="number" min={1} max={5} value={linePreset.passes} onChange={(e) => updatePresetAt(linePresetIdx, { passes: +e.target.value })} /></label>
                </div>
              )}
              <p className="hint">Vector lines (vinyl, HTV) cut with this preset; holes cut with the one above. Highlight the lines or the stones on the board to cut just those.</p>
            </>
          )}
        </Section>

        <Section title="Cut">
          {selectionCut && (
            <p className="hint">
              <b>Cutting the selection:</b> {cutJob.stones.length} stone{cutJob.stones.length === 1 ? '' : 's'}
              {cutJob.paths?.length ? ` + ${cutJob.paths.length} cut line${cutJob.paths.length === 1 ? '' : 's'}` : ''}.
              Click empty board to clear it and cut by layer.
            </p>
          )}
          <label>Layer
            <select value={cutLayer} disabled={selectionCut} onChange={(e) => setCutLayer(e.target.value)}>
              <option value="all">Everything ({stones.length} stones{vectors.length ? ` + ${job.paths?.length ?? 0} cut lines` : ''})</option>
              <option value="outline">Outline stones only ({layerCounts.o})</option>
              <option value="fill">Fill stones only ({layerCounts.f})</option>
              {cutColors.length > 1 && cutColors.map(([c, nn]) => (
                <option key={`c${c}`} value={`color:${c}`}>Color {c} only ({nn})</option>
              ))}
              {cutSizes.length > 1 && cutSizes.map(([s, nn]) => (
                <option key={`s${s}`} value={`size:${s}`}>{s} stones only ({nn})</option>
              ))}
              {vectors.length > 0 && <option value="lines">Vector cut lines only ({job.paths?.length ?? 0})</option>}
            </select>
          </label>
          {cutLayer !== 'all' && (
            <p className="hint">
              Layers share one frame — cut each on its own sheet and they line up when stacked.
            </p>
          )}
          <div className="grid2">
            <label className="row" style={{ alignSelf: 'end' }}>
              <input type="checkbox" checked={frameOn} onChange={(e) => setFrameOn(e.target.checked)} />
              Weeding frame
            </label>
            <label>Frame margin (mm)
              <input type="number" min={1} max={50} step={1} value={frameMm} disabled={!frameOn}
                onChange={(e) => setFrameMm(Math.min(50, Math.max(1, +e.target.value || 1)))} />
            </label>
          </div>
          <p className="hint">Cuts one rectangle around the arrangement (last, so the sheet stays anchored) — the template peels off the roll cleanly. Applies to every separated layer at the same frame.</p>
          <label>Position on material
            <select value={placement} onChange={(e) => setPlacement(e.target.value as typeof placement)}>
              <option value="artboard">On the board — cut exactly where it sits on the media</option>
              <option value="design">From the origin — ignore the board, cut at the origin corner</option>
            </select>
          </label>
          {placement === 'design' ? (
            <>
              <label>Edge margin (mm)
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={0.5}
                  value={margin}
                  onChange={(e) => setMargin(Math.min(50, Math.max(0, +e.target.value || 0)))}
                />
              </label>
              <p className="hint">
                Wherever the design sits on the page, it cuts from the corner. Jog the carriage
                to the material corner, press ORIGIN, and the first hole lands {margin}mm in from
                there{margin === 0 ? ' — right on the origin point' : ''}.
              </p>
            </>
          ) : (
            <>
              {fromOrigin && (
                <div className="toolrow">
                  <label>Across from origin (in)
                    <input
                      key={`a${fromOrigin.across.toFixed(3)}`}
                      type="number"
                      step={0.125}
                      defaultValue={fromOrigin.across.toFixed(2)}
                      onBlur={(e) => placeFromOrigin(+e.target.value || 0, fromOrigin.feed)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    />
                  </label>
                  <label>Up from origin (in)
                    <input
                      key={`f${fromOrigin.feed.toFixed(3)}`}
                      type="number"
                      step={0.125}
                      defaultValue={fromOrigin.feed.toFixed(2)}
                      onBlur={(e) => placeFromOrigin(fromOrigin.across, +e.target.value || 0)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    />
                  </label>
                </div>
              )}
              <p className="hint">
                The board is your loaded media, {boardWIn}″ across × {boardHIn}″ of length, ruled
                from the machine's <b>lower-{originCorner === 'br' ? 'RIGHT' : 'LEFT'}</b> corner.
                Jog the blade to that corner of the vinyl, press ORIGIN, and the design cuts exactly
                where it sits on the board — the numbers above are what you'd measure with a ruler.
                The further up the board it sits, the more media feeds before the first cut.
              </p>
            </>
          )}
          {offBoard && (
            <p className="hint" style={{ color: '#f0b95e' }}>
              Part of the design sits outside the {boardWIn}″ × {boardHIn}″ artboard — the cutter
              will clip whatever falls off the sheet. Move it back inside, or enlarge the artboard.
            </p>
          )}
          <div className="toolrow">
            <button disabled={!cutCount} onClick={() => download(`stonecut-${cutLayerSlug}.plt`, cutData())}>Download .plt</button>
            <button disabled={!cutCount} onClick={() => download(`stonecut-${cutLayerSlug}.svg`, toSVG(framedCutJob), 'image/svg+xml')}>SVG (Cricut)</button>
            <button disabled={!cutCount} onClick={() => download(`stonecut-${cutLayerSlug}.dxf`, toDXF(framedCutJob), 'application/dxf')}>DXF (laser)</button>
          </div>
          {/* Machine-level settings change once per cutter, not per job, so they
              stay folded: the Cut button must never be a screen away. */}
          <details className="sec sub">
            <summary>Cutter setup</summary>
            <div className="sec-body">
          <label>Command mode
            <select value={format} onChange={(e) => setFormat(e.target.value as 'gpgl' | 'hpgl')}>
              <option value="gpgl">GP-GL (CE6000 factory default)</option>
              <option value="hpgl">HP-GL (if COMMAND menu set to HP-GL)</option>
            </select>
          </label>
          <label>Overcut (mm)
            <input type="number" min={0} max={3} step={0.1} value={overcut}
              onChange={(e) => setOvercut(Math.min(3, Math.max(0, +e.target.value || 0)))} />
          </label>
          <p className="hint">
            Each hole is recut {overcut > 0 ? `${overcut} mm` : 'nothing'} past its closing point, so the
            blade's swivel doesn't leave a tag holding the chad in. 0.5 mm suits sticky flock; 0 = off.
          </p>
          {format === 'gpgl' && (
            <>
              <label className="row">
                <input type="checkbox" checked={wCircles}
                  onChange={(e) => setWCircles(e.target.checked)} />
                {' '}Firmware circles (GP-GL W command)
              </label>
              <p className="hint">
                Holes cut as one arc command each — the machine interpolates a truly round circle and the
                job streams ~20× less data than the segment polygons. <b>Test-cut a few holes first</b>:
                if circles land in the wrong place or come with a stray line, turn this back off (the
                plotter's own W-command pen setting varies by firmware).
              </p>
              <label className="row">
                <input type="checkbox" checked={swapAxes}
                  onChange={(e) => setSwapAxes(e.target.checked)} />
                {' '}Swap axes (feed axis is the model's Y)
              </label>
              <label className="row">
                <input type="checkbox" checked={sendConditions}
                  onChange={(e) => setSendConditions(e.target.checked)} />
                {' '}Send speed/force from the app
              </label>
              <p className="hint">
                On (default): sends the material preset's <code>!speed</code> and
                <code>*accel,force</code> ahead of the geometry. The cutter only honours them
                when TOOLS SETTING → CONDITION PRIORITY is PROGRAM. Off: pure geometry, the
                panel conditions are used.
              </p>
              <label>GP-GL step size (must match the machine)
                <select value={gpStep} onChange={(e) => setGpStep(+e.target.value)}>
                  <option value={10}>0.100 mm — 254 steps/inch</option>
                  <option value={20}>0.050 mm — 508 steps/inch</option>
                  <option value={40}>0.025 mm — 1016 steps/inch</option>
                  <option value={100}>0.010 mm — 2540 steps/inch</option>
                </select>
              </label>
              <p className="hint">
                MENU → I/F → STEP SIZE on the CE6000. A mismatch scales the whole job with no
                error — 0.100 mm sent as 0.050 mm cuts everything at double size.
              </p>
            </>
          )}
          <label>Cutter origin corner
            <select value={originCorner} onChange={(e) => setOriginCorner(e.target.value as OriginCorner)}>
              <option value="bl">Lower-LEFT of the material</option>
              <option value="br">Lower-RIGHT of the material (Graphtec default)</option>
            </select>
          </label>
          <p className="hint">
            Where you press ORIGIN on the machine. Graphtec carriages home to the right — if the
            job feeds a long way before cutting, this is set to the wrong side.
          </p>
          <p className="hint" style={{ marginTop: 10 }}>
            Diagnostic: a bare <b>L</b> (20 mm tall, 10 mm foot) 2 mm from the origin — nothing
            but M and D. Asymmetric on purpose: how the L comes out tells you the axis mapping
            and whether the job is mirrored, at a cost of about an inch of material.
          </p>
          <div className="toolrow">
            <button onClick={async () => {
              try {
                setStatus('Sending 10 mm test square…')
                await sendToCutter(gpglTestShape(gpStep, 2, swapAxes))
                setStatus('Test square sent ✓')
              } catch (e) {
                setStatus(`Test square failed: ${e instanceof Error ? e.message : e}`)
              }
            }}>Send test square</button>
            <button onClick={() => download('stonecut-testshape.plt', gpglTestShape(gpStep, 2, swapAxes))}>Download it</button>
          </div>
            </div>
          </details>
        </Section>
        <div className="cutbar">
          <button className="primary" disabled={!cutCount} onClick={doSend}>⚡ Cut on Graphtec</button>
          <div className="cutbar-meta">
            {cutCount ? [framedCutJob.stones.length ? `${framedCutJob.stones.length} stones` : '', framedCutJob.paths?.length ? `${framedCutJob.paths.length} cut line${framedCutJob.paths.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ') : 'add a design to cut'}
            {fromOrigin && placement === 'artboard' && ` · ${fromOrigin.across.toFixed(2)}″ across, ${fromOrigin.feed.toFixed(2)}″ up from origin`}
          </div>
        </div>
      </aside>
      <div
        className="panel-resizer"
        title="Drag to resize the sidebar"
        onPointerDown={(e) => { panelDrag.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={(e) => { if (panelDrag.current) setPanelW(Math.min(560, Math.max(240, e.clientX))) }}
        onPointerUp={() => { panelDrag.current = false }}
      />

      <main
        className={`canvas-wrap${dragOver ? ' dragover' : ''}`}
        ref={wrapRef}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { void onBoardDrop(e) }}
      >
        <div className="zoombar" ref={barRef}>
          <button className="zbtn" title="Zoom out (⌘−)" onClick={() => zoomAbout(zoom / 1.25)}>−</button>
          <input
            type="range"
            min={Math.log(ZOOM_MIN)}
            max={Math.log(ZOOM_MAX)}
            step={0.01}
            value={Math.log(zoom)}
            onChange={(e) => zoomAbout(Math.exp(+e.target.value))}
          />
          <button className="zbtn" title="Zoom in (⌘+)" onClick={() => zoomAbout(zoom * 1.25)}>+</button>
          <span className="zpct">{Math.round((zoom / PX_PER_MM_100) * 100)}%</span>
          <button className="zbtn" disabled={!stones.length} title="Zoom to the design (F)" onClick={fitDesign}>Fit design</button>
          <button className="zbtn" title="Show the whole sheet (⌘0)" onClick={fitSheet}>Fit sheet</button>
          <button className="zbtn" title="Actual size" onClick={() => zoomAbout(PX_PER_MM_100)}>1:1</button>
          <button className={`zbtn${simView ? ' active' : ''}`} title="Sparkle simulation — stones render as gems" onClick={() => setSimView((o) => !o)}>✨</button>
          <button className="zbtn" disabled={!stones.length && !vectors.length} title="Garment mockup" onClick={() => setMockupOpen(true)}>👕</button>
          <span style={{ marginLeft: 12 }}>Plotter</span>
          <select
            value={PLOTTERS.find((p) => p.cutIn === boardWIn)?.id ?? 'custom'}
            onChange={(e) => { const p = PLOTTERS.find((q) => q.id === e.target.value); if (p) setBoardWIn(p.cutIn) }}
            style={{ width: 'auto' }}
          >
            {PLOTTERS.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.cutIn}″ wide</option>)}
            <option value="custom">Custom width</option>
          </select>
          <span title="Width of the loaded media between the pinch rollers, and how much length is loaded">Media</span>
          <input
            type="number"
            min={1}
            max={60}
            step={0.25}
            key={`bw-${boardWIn}`}
            defaultValue={boardWIn}
            // commit on blur/Enter, NOT per keystroke: backspacing "22"
            // passed through "2" and "" and the artboard collapsed to 1"
            // mid-edit — which read as "Delete deleted my artboard" when
            // this field happened to hold focus
            onBlur={(e) => setBoardWIn(Math.min(60, Math.max(1, +e.target.value || boardWIn)))}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            style={{ width: 54 }}
          />
          <span>×</span>
          <input
            type="number"
            min={1}
            max={60}
            step={0.5}
            key={`bh-${boardHIn}`}
            defaultValue={boardHIn}
            onBlur={(e) => setBoardHIn(Math.min(60, Math.max(1, +e.target.value || boardHIn)))}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            style={{ width: 54 }}
          />
          <input
            type="color"
            value={boardColor ?? '#1a1f2b'}
            onChange={(e) => setBoardColor(e.target.value)}
            style={{ width: 30, padding: 0, height: 22 }}
          />
          {boardColor && (
            <button className="zbtn" title="Back to the default board" onClick={() => setBoardColor(null)}>×</button>
          )}
          <button
            disabled={!stones.length}
            style={{ marginLeft: 'auto', width: 'auto', marginTop: 0 }}
            onClick={() => { mutate(() => []); setSelection(new Set()) }}
          >
            Clear all
          </button>
        </div>
        {/* stones render on a bitmap: one paint instead of thousands of SVG
            DOM circles, which made scrolling large designs crawl. The SVG
            on top keeps the grid, the preview path, and mouse events. */}
        <div style={{ position: 'relative', width: canvasW * zoom, height: canvasH * zoom }}>
        <svg
          ref={svgRef}
          width={canvasW * zoom}
          height={canvasH * zoom}
          onMouseDown={onCanvasDown}
          onContextMenu={onCanvasContext}
          onMouseMove={onCanvasMove}
          onMouseUp={onCanvasUp}
          onDoubleClick={onCanvasDoubleClick}
        >
          <defs>
            <pattern id="grid" width={10 * zoom} height={10 * zoom} patternUnits="userSpaceOnUse">
              <path d={`M ${10 * zoom} 0 L 0 0 0 ${10 * zoom}`} fill="none" stroke="#2a2f3a" strokeWidth="1" />
            </pattern>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#f0b95e" />
            </marker>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
          {/* The board is the plotter's cutting area at true scale: the
              loaded media, ruled in inches FROM THE MACHINE'S ORIGIN CORNER,
              feed running up the screen. What you see is where it cuts. */}
          <g pointerEvents="none">
            {(() => {
              const W = boardWmm * zoom, H = boardHmm * zoom, inch = 25.4 * zoom
              const right = originCorner === 'br'
              const ox = right ? W : 0 // origin x on screen; carriage runs away from it
              const dir = right ? -1 : 1
              const cols = Math.max(0, Math.ceil(boardWIn) - 1)
              const rows = Math.max(0, Math.ceil(boardHIn) - 1)
              const ruleCol = boardIsLight ? '#b2b9c9' : '#3d4863'
              const labelCol = boardIsLight ? '#4a5469' : '#8b97b5'
              return (
                <>
                  <rect x={0} y={0} width={W} height={H} fill={boardColor ?? '#ffffff'} fillOpacity={boardColor ? 1 : 0.035} stroke="#7789ad" strokeWidth={1.5} />
                  {Array.from({ length: cols }, (_, k) => k + 1).map((i) => (
                    <g key={`v${i}`}>
                      <line x1={ox + dir * i * inch} y1={0} x2={ox + dir * i * inch} y2={H} stroke={ruleCol} strokeWidth={1} />
                      <text x={ox + dir * i * inch + (right ? 3 : -3)} y={H - 4} fill={labelCol} fontSize={10} textAnchor={right ? 'start' : 'end'}>{i}"</text>
                    </g>
                  ))}
                  {Array.from({ length: rows }, (_, k) => k + 1).map((i) => (
                    <g key={`h${i}`}>
                      <line x1={0} y1={H - i * inch} x2={W} y2={H - i * inch} stroke={ruleCol} strokeWidth={1} />
                      <text x={right ? W - 3 : 3} y={H - i * inch + 11} fill={labelCol} fontSize={10} textAnchor={right ? 'end' : 'start'}>{i}"</text>
                    </g>
                  ))}
                  {/* origin corner + axes, drawn the way the operator sees the machine */}
                  <circle cx={ox} cy={H} r={5} fill="#f0b95e" stroke="#12151c" strokeWidth={1.5} />
                  <text x={ox + dir * 28} y={H - 40} fill="#f0b95e" fontSize={10} fontWeight={700} textAnchor={right ? 'end' : 'start'}>ORIGIN</text>
                  {/* axes sit inboard of the ruler labels so neither hides the other */}
                  <line x1={ox + dir * 28} y1={H - 52} x2={ox + dir * 28} y2={H - 112} stroke="#f0b95e" strokeWidth={1.5} markerEnd="url(#arrow)" />
                  <text x={ox + dir * 34} y={H - 60} fill="#f0b95e" fontSize={10} textAnchor={right ? 'end' : 'start'}>feed ↑ into machine</text>
                  <line x1={ox + dir * 40} y1={H - 28} x2={ox + dir * 100} y2={H - 28} stroke="#f0b95e" strokeWidth={1.5} markerEnd="url(#arrow)" />
                  <text x={ox + dir * 106} y={H - 24} fill="#f0b95e" fontSize={10} textAnchor={right ? 'end' : 'start'}>carriage</text>
                  <text x={right ? 4 : W - 4} y={12} fill={boardIsLight ? '#4a5469' : '#7789ad'} fontSize={11} textAnchor={right ? 'start' : 'end'}>
                    media {boardWIn}" × {boardHIn}" · origin lower-{right ? 'right' : 'left'}
                  </text>
                </>
              )
            })()}
          </g>
          {marquee && (
            <rect
              x={Math.min(marquee.x0, marquee.x1) * zoom}
              y={Math.min(marquee.y0, marquee.y1) * zoom}
              width={Math.abs(marquee.x1 - marquee.x0) * zoom}
              height={Math.abs(marquee.y1 - marquee.y0) * zoom}
              fill="#5b7bd9"
              fillOpacity={0.12}
              stroke="#5b7bd9"
              strokeDasharray="4 3"
              pointerEvents="none"
            />
          )}
          {(snapLines.x != null || snapLines.y != null) && (
            <g pointerEvents="none">
              {snapLines.x != null && <line x1={snapLines.x * zoom} y1={0} x2={snapLines.x * zoom} y2={canvasH * zoom} stroke="#ff5f9e" strokeWidth={1} strokeDasharray="5 4" />}
              {snapLines.y != null && <line x1={0} y1={snapLines.y * zoom} x2={canvasW * zoom} y2={snapLines.y * zoom} stroke="#ff5f9e" strokeWidth={1} strokeDasharray="5 4" />}
            </g>
          )}
          {vectors.map((v) => (
            <path
              key={v.id}
              d={vecD(v.base)}
              transform={`translate(${v.x * zoom} ${v.y * zoom}) scale(${v.s * zoom})`}
              fill="none"
              stroke={selVecs.has(v.id) ? '#f0b95e' : '#8fd3ff'}
              strokeWidth={(selVecs.has(v.id) ? 2 : 1.5) / (v.s * zoom)}
              pointerEvents="none"
            />
          ))}
          {tool === 'pen' && penPts.length > 0 && (() => {
            const d = 'M' + penPts.map((q) => `${(q.x * zoom).toFixed(1)},${(q.y * zoom).toFixed(1)}`).join('L')
            const r = ((sizes[curSize]?.holeMm ?? 3) / 2) * zoom
            return (
              <g pointerEvents="none">
                <path d={d} fill="none" stroke="#f0b95e" strokeWidth={1.5} strokeDasharray="5 3" />
                {penOut !== 'line' && penPreview.map((q, i) => (
                  <circle key={`g${i}`} cx={q.x * zoom} cy={q.y * zoom} r={r} fill="#f0b95e" fillOpacity={0.35} />
                ))}
                {penPts.map((q, i) => (
                  <rect key={i} x={q.x * zoom - 3} y={q.y * zoom - 3} width={6} height={6} fill={i === 0 ? '#f0b95e' : '#12151c'} stroke="#f0b95e" strokeWidth={1.2} />
                ))}
              </g>
            )
          })()}
          {nodeVec && (() => {
            const v = nodeVec
            const total = v.base.reduce((n, pl) => n + pl.length, 0)
            // a traced mascot can carry 30k+ vertices — that many DOM rects
            // kills the tab; node-edit stays for hand-sized paths
            if (total > 4000) {
              return (
                <text x={(v.x + (v.baseW * v.s) / 2) * zoom} y={(v.y - 3) * zoom} fill="#f0b95e" fontSize={12} textAnchor="middle" pointerEvents="none">
                  {total.toLocaleString()} points — too many to node-edit; use Offset / Pathfinder, or simplify the trace
                </text>
              )
            }
            const r = 3.5
            return (
              <g pointerEvents="none">
                {v.base.map((pl, pi) => pl.map((q, qi) => {
                  const key = `${pi}:${qi}`
                  const sel = nodeSel.has(key)
                  return (
                    <rect
                      key={key}
                      x={(q.x * v.s + v.x) * zoom - r}
                      y={(q.y * v.s + v.y) * zoom - r}
                      width={r * 2}
                      height={r * 2}
                      fill={sel ? '#f0b95e' : '#12151c'}
                      stroke={sel ? '#12151c' : '#8fd3ff'}
                      strokeWidth={1.2}
                    />
                  )
                }))}
              </g>
            )
          })()}
          {tool === 'select' && vecSelBox && (() => {
            const b = vecSelBox
            const w = b.maxX - b.minX, h = b.maxY - b.minY
            const rq = rotHandlePos(b)
            return (
              <g pointerEvents="none">
                <rect x={b.minX * zoom} y={b.minY * zoom} width={w * zoom} height={h * zoom} fill="none" stroke="#f0b95e" strokeWidth={1.5} strokeDasharray="6 3" />
                {HANDLES.map((hd) => {
                  const q = handlePos(b, hd)
                  return <rect key={hd} x={q.x * zoom - HANDLE_PX / 2} y={q.y * zoom - HANDLE_PX / 2} width={HANDLE_PX} height={HANDLE_PX} fill="#f0b95e" stroke="#12151c" strokeWidth={1.5} />
                })}
                <line x1={((b.minX + b.maxX) / 2) * zoom} y1={b.minY * zoom} x2={rq.x * zoom} y2={rq.y * zoom} stroke="#f0b95e" strokeWidth={1.5} />
                <circle cx={rq.x * zoom} cy={rq.y * zoom} r={HANDLE_PX / 2 + 1} fill="#f0b95e" stroke="#12151c" strokeWidth={1.5} />
                <text x={b.minX * zoom} y={rq.y * zoom - 8} fill="#f0b95e" fontSize={12} fontWeight={700}>
                  {w.toFixed(0)} × {h.toFixed(0)} mm · {(w / 25.4).toFixed(2)}″ × {(h / 25.4).toFixed(2)}″
                </text>
              </g>
            )
          })()}
          {tool === 'select' && selBox && (() => {
            const b = resizeBox ?? selBox
            const w = b.maxX - b.minX, h = b.maxY - b.minY
            const rq = rotHandlePos(b)
            return (
              <g pointerEvents="none">
                <rect x={b.minX * zoom} y={b.minY * zoom} width={w * zoom} height={h * zoom} fill="none" stroke="#f0b95e" strokeWidth={1.5} strokeDasharray="6 3" />
                {HANDLES.map((hd) => {
                  const q = handlePos(b, hd)
                  return <rect key={hd} x={q.x * zoom - HANDLE_PX / 2} y={q.y * zoom - HANDLE_PX / 2} width={HANDLE_PX} height={HANDLE_PX} fill="#f0b95e" stroke="#12151c" strokeWidth={1.5} />
                })}
                <line x1={((b.minX + b.maxX) / 2) * zoom} y1={b.minY * zoom} x2={rq.x * zoom} y2={rq.y * zoom} stroke="#f0b95e" strokeWidth={1.5} />
                <circle cx={rq.x * zoom} cy={rq.y * zoom} r={HANDLE_PX / 2 + 1} fill="#f0b95e" stroke="#12151c" strokeWidth={1.5} />
                <text x={b.minX * zoom} y={rq.y * zoom - 8} fill="#f0b95e" fontSize={12} fontWeight={700}>
                  {w.toFixed(0)} × {h.toFixed(0)} mm · {(w / 25.4).toFixed(2)}″ × {(h / 25.4).toFixed(2)}″
                </text>
              </g>
            )
          })()}
          {previewLive && previewPath && (
            <path
              d={previewPath}
              fill="#5b7bd9"
              fillOpacity={0.1}
              stroke="#5b7bd9"
              strokeOpacity={0.3}
              strokeWidth={1}
              fillRule="evenodd"
              pointerEvents="none"
            />
          )}
        </svg>
        <canvas
          ref={stoneCanvasRef}
          style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
        />
        </div>
        {ctxMenu && (() => {
          const run = (fn: () => void) => { setCtxMenu(null); fn() }
          type Item = { label: string; disabled?: boolean; onClick: () => void } | 'sep'
          const items: Item[] =
            ctxMenu.kind === 'vec'
              ? [
                  { label: 'Ungroup — split into letters', disabled: !selVecs.size, onClick: () => run(ungroup) },
                  { label: 'Rotate 90° CW', onClick: () => run(() => rotateSelection(90)) },
                  { label: 'Rotate 90° CCW', onClick: () => run(() => rotateSelection(-90)) },
                  { label: 'Flip horizontal', onClick: () => run(() => flipSelection('h')) },
                  { label: 'Flip vertical', onClick: () => run(() => flipSelection('v')) },
                  'sep',
                  { label: 'Unite', disabled: !selVecs.size, onClick: () => run(() => pathfinder('union')) },
                  { label: 'Minus front', disabled: selVecs.size < 2, onClick: () => run(() => pathfinder('difference')) },
                  { label: 'Intersect', disabled: selVecs.size < 2, onClick: () => run(() => pathfinder('intersection')) },
                  { label: 'Exclude', disabled: selVecs.size < 2, onClick: () => run(() => pathfinder('xor')) },
                  'sep',
                  { label: 'Delete', onClick: () => run(() => { mutateVectors((prev) => prev.filter((v) => !selVecs.has(v.id))); setSelVecs(new Set()) }) },
                ]
              : ctxMenu.kind === 'stones'
                ? [
                    { label: 'Select whole design', onClick: () => run(expandToDesigns) },
                    { label: 'Resize design…', disabled: selectedEl == null, onClick: () => run(() => openSection('Edit', 'input[type=number]')) },
                    { label: 'Ungroup element — split into letters', disabled: selectedEl == null, onClick: () => run(ungroupElement) },
                    { label: 'Rotate 90° CW', onClick: () => run(() => rotateSelection(90)) },
                    { label: 'Rotate 90° CCW', onClick: () => run(() => rotateSelection(-90)) },
                    { label: 'Flip horizontal', onClick: () => run(() => flipSelection('h')) },
                    { label: 'Flip vertical', onClick: () => run(() => flipSelection('v')) },
                    'sep',
                    { label: `Set selected to ${curSize}`, onClick: () => run(() => mutate((prev) => prev.map((st, i) => (selection.has(i) ? { ...st, size: curSize } : st)))) },
                    { label: 'Delete selected stones', onClick: () => run(() => { mutate((prev) => prev.filter((_, i) => !selection.has(i))); setSelection(new Set()) }) },
                  ]
                : [
                    // a board full of PREVIEWS has zero committed objects —
                    // every item below is rightly disabled, which read as
                    // "the menu doesn't work". Offer the commit instead.
                    ...(pending > 0
                      ? [
                          {
                            label: `Add ${pending} previewed stones to the design`,
                            onClick: () => run(() => { if (pendingText) addTextOutput(); if (pendingImage) void generateImage() }),
                          },
                          { label: 'Discard previews', onClick: () => run(discardPreviews) },
                          'sep' as const,
                        ]
                      : []),
                    { label: 'Select all', disabled: !stones.length && !vectors.length, onClick: () => run(() => { setSelection(new Set(stones.map((_, i) => i))); setSelVecs(new Set(vectors.map((v) => v.id))) }) },
                    { label: 'Center on board', disabled: !stones.length && !vectors.length, onClick: () => run(centerOnBoard) },
                    { label: 'Move to origin corner', disabled: !stones.length && !vectors.length, onClick: () => run(() => placeFromOrigin(0.5, 0.5)) },
                    'sep',
                    { label: 'Clear all', disabled: !stones.length && !vectors.length && !pending, onClick: () => run(clearAll) },
                  ]
          return (
            <div
              className="menu-list"
              style={{ position: 'fixed', left: Math.min(ctxMenu.x, window.innerWidth - 260), top: Math.min(ctxMenu.y, window.innerHeight - items.length * 30 - 20), zIndex: 80 }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {items.map((it, i) =>
                it === 'sep' ? (
                  <div key={i} className="menu-sep" />
                ) : (
                  <button key={i} className="menu-item" disabled={it.disabled} onClick={it.onClick}>
                    <span className="menu-label">{it.label}</span>
                  </button>
                ),
              )}
            </div>
          )
        })()}
      </main>
      </div>
    </div>
  )
}

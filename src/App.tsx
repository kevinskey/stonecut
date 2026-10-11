import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type opentype from 'opentype.js'
import { DEFAULT_PRESETS, DEFAULT_SIZES } from './model'
import type { MaterialPreset, Pt, Stone, StoneSpec } from './model'
import { SpacingIndex, bareFrac, capGaps, debugSpans, debugStones, spinedWidths, fillByGlyph, fillStones, offsetRows, outlineOrSpine, rasterizeContours } from './fill'
import { loadFontFile, parseFontBuffer, textToContours } from './text'
import { grantedCutter } from './usb'
import { distToPaths, parseSvgToPaths, pathsToD } from './vector'
import { booleanPaths } from './boolean'
import type { BoolOp } from './boolean'
import { deleteFont, getFont, listFonts, saveFont } from './fontstore'
import { analyzeImage, imageToRaster } from './image'
import { download, gpglTestShape, toGPGL, toHPGL, toSVG } from './export'
import type { OriginCorner } from './export'
import { SHAPE_NAMES, shapeToContours } from './shapes'
import { MenuBar } from './MenuBar'
import type { Menu } from './MenuBar'
import type { ShapeKind } from './shapes'
import { sendToCutter } from './usb'
import './App.css'

type Tool = 'select' | 'add'
type StoneMode = 'outline' | 'fill' | 'both'
// What a committed design was generated FROM, kept so it can be re-stoned
// at another size. Contours are normalised to a (0,0) top-left corner at
// the scale they were generated; sx/sy is the scale the element is at now.
// Resizing never scales holes: the contours are scaled and the stones are
// laid out again at the panel's current stone size and spacing.
interface Recipe { contours: Pt[][]; mode: StoneMode; wholeWord: boolean; sx: number; sy: number }
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

const DEFAULT_MARGIN = 5 // mm standoff around design in exports; set per-job in the Cut panel

// template-integrity floor (sticky flock ~0.5-1.2mm edge gap) regardless of
// how wide the design spacing is set
const hardGapOf = (spacing: number) => Math.max(0.5, Math.min(spacing, 1.2))

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
function loadDesign(): { stones: Stone[]; sizes: Record<string, StoneSpec>; elements: Elements; vectors: VecItem[] } | null {
  try {
    const raw = localStorage.getItem(DESIGN_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (!Array.isArray(d?.stones) && !Array.isArray(d?.vectors)) return null
    const stones = ((d.stones ?? []) as Stone[]).filter((s) => typeof s?.x === 'number' && typeof s?.y === 'number' && typeof s?.size === 'string')
    const sizes = d.sizes && typeof d.sizes === 'object' ? { ...DEFAULT_SIZES, ...d.sizes } : { ...DEFAULT_SIZES }
    const elements: Elements = {}
    if (d.elements && typeof d.elements === 'object')
      for (const [k, r] of Object.entries(d.elements as Record<string, Recipe>))
        if (Array.isArray(r?.contours) && typeof r.sx === 'number' && typeof r.sy === 'number')
          elements[+k] = { contours: r.contours, mode: r.mode ?? 'outline', wholeWord: !!r.wholeWord, sx: r.sx, sy: r.sy }
    const vectors: VecItem[] = Array.isArray(d.vectors)
      ? (d.vectors as VecItem[]).filter((v) => Array.isArray(v?.base) && typeof v.x === 'number' && typeof v.s === 'number')
      : []
    return { stones, sizes, elements, vectors }
  } catch {
    return null
  }
}

export default function App() {
  const savedDesign = useRef(loadDesign())
  const [stones, setStones] = useState<Stone[]>(() => savedDesign.current?.stones ?? [])
  const stonesRef = useRef<Stone[]>([])
  // last image commit — while untouched, generation-setting changes REGENERATE
  // it in place instead of only affecting the next add
  const lastImageRef = useRef<{ file: File; offsetY: number; before: Stone[]; after: Stone[]; el?: number } | null>(null)
  // element ids continue past whatever the saved design used
  const elSeq = useRef((savedDesign.current?.stones ?? []).reduce((m, s) => Math.max(m, s.el ?? 0), 0) + 1)
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
          localStorage.setItem(DESIGN_KEY, JSON.stringify({ v: 1, stones, sizes, elements: kept, vectors }))
        } else localStorage.removeItem(DESIGN_KEY)
      } catch (e) {
        console.error('[stonecut] could not save design', e)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [stones, sizes, elements, vectors])
  const [curSize, setCurSize] = useState('SS10')
  const [gap, setGap] = useState(0.8) // min edge-to-edge gap between holes, mm
  const [tool, setTool] = useState<Tool>('select')
  const [addSize, setAddSize] = useState<'auto' | string>('auto') // stone size for manual adds
  const [outlineDesign, setOutlineDesign] = useState<'single' | 'double' | 'ghost' | 'centerline'>('single')
  const [strokePolicy, setStrokePolicy] = useState<'auto' | 'walls'>('auto')
  const [uniformRhythm, setUniformRhythm] = useState(true)
  const [canEcho, setCanEcho] = useState(true)
  const [fillStyle, setFillStyle] = useState<'grid' | 'brick'>('brick')
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
  const [gpStep, setGpStep] = useState(() => +(localStorage.getItem('stonecut.gpstep') ?? 20) || 20)
  useEffect(() => { localStorage.setItem('stonecut.gpstep', String(gpStep)) }, [gpStep])
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
  useEffect(() => { localStorage.setItem('stonecut.sendcond2', sendConditions ? '1' : '0') }, [sendConditions])
  const boardWmm = boardWIn * 25.4
  const boardHmm = boardHIn * 25.4
  const [status, setStatus] = useState('Ready')

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
  const [textMode, setTextMode] = useState<StoneMode>('outline')
  const [letterSpacing, setLetterSpacing] = useState(2)

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

  // material
  const [presets, setPresets] = useState<MaterialPreset[]>(loadPresets)
  const [presetIdx, setPresetIdx] = useState(0)
  const [format, setFormat] = useState<'gpgl' | 'hpgl'>('gpgl')

  const undoStack = useRef<{ stones: Stone[]; elements: Elements; vectors: VecItem[] }[]>([])
  const pushUndo = useCallback((prev: Stone[]) => {
    undoStack.current.push({ stones: prev, elements: elementsRef.current, vectors: vectorsRef.current })
    if (undoStack.current.length > 50) undoStack.current.shift()
  }, [])
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
      return { stones, sizes, widthMm: boardWmm, heightMm: boardHmm, paths: vectors.flatMap(vecPaths) }
    }
    const w = bbox.maxX - bbox.minX + margin * 2
    const h = bbox.maxY - bbox.minY + margin * 2
    return {
      stones: stones.map((s) => ({ ...s, x: s.x - bbox.minX + margin, y: s.y - bbox.minY + margin })),
      sizes,
      widthMm: Math.ceil(w),
      heightMm: Math.ceil(h),
      paths: vectors.flatMap(vecPaths).map((p) => p.map((q) => ({ x: q.x - bbox.minX + margin, y: q.y - bbox.minY + margin }))),
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
      return textToContours(font, text, textHeight, letterSpacing)
    } catch (e) {
      // Can't setStatus from a memo; the console is the only channel here.
      console.error('[stonecut] font contours failed', e)
      return null
    }
  }, [font, text, textHeight, letterSpacing])
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
  useEffect(() => { if (!stones.length) { setPreviewBaseY(null); setElements({}) } }, [stones.length])
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
  useEffect(() => {
    setPreviewLive(true)
  }, [textPreview, fontOpen, pinPreviewBase])
  // The last text commit, so stone-setting changes can regenerate it in
  // place while its text is untouched (same idea as the image regen).
  const lastTextRef = useRef<{ el: number; font: unknown; text: string; height: number; spacing: number } | null>(null)
  useEffect(() => {
    if (!textPreview) {
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
            const f = fillByGlyph(textPreview.contours, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick', hole)
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
  }, [textPreview, curSize, gap, sizes, textMode, outlineStyle, outlineDesign, uniformRhythm, fillStyle, fillSize, fillColor, fontOpen, pinPreviewBase])

  // live IMAGE preview: same treatment text gets — settings changes re-stone
  // the artwork automatically, nothing committed until you press Add
  useEffect(() => {
    if (!imageFile) return
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
        const raster = await imageToRaster(imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, previewPx)
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
            const f = fillStones(raster.grid, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick', hole)
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
  }, [imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, imgMode, sizes, curSize, gap,
      outlineStyle, outlineDesign, uniformRhythm, fillStyle, fillSize, fillColor, pinPreviewBase])

  // ---------- generation ----------
  const addGenerated = useCallback(
    (pts: { x: number; y: number; size?: string; color?: string; layer?: 'outline' | 'fill' }[], offsetY: number, recipe?: Omit<Recipe, 'sx' | 'sy'>) => {
      // each commit is its own ELEMENT: a free-moving layer that may overlap
      // other elements — nothing culls across elements anymore
      const el = elSeq.current++
      const fresh: Stone[] = pts.map((p) => ({ x: p.x + 10, y: p.y + offsetY, size: p.size ?? curSize, color: p.color, layer: p.layer ?? 'outline', el }))
      mutate((prev) => [...prev, ...fresh])
      if (recipe) setElements((prev) => ({ ...prev, [el]: { ...recipe, contours: normaliseContours(recipe.contours), sx: 1, sy: 1 } }))
      return el
    },
    [curSize, gap, mutate, sizes],
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
        ? fillByGlyph(contours, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick', hole)
        : fillStones(grid, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick', hole)
      pts.push(...f.map((p) => ({ ...p, size: fillSize, color: fillColor, layer: 'fill' as const })))
    }
      return pts
    },
    [curSize, gap, sizes, uniformRhythm, outlineDesign, outlineStyle, fillStyle, fillSize, fillColor],
  )

  const generateText = useCallback(() => {
    if (!font) { setStatus('Upload a font file first (.ttf/.otf)'); return }
    const { contours } = textToContours(font, text, textHeight, letterSpacing)
    const pts = contoursToStones(contours, textMode)
    // commit exactly where the preview showed; release the pin so the next
    // preview session stacks below the committed stones
    const offsetY = previewBaseY ?? (stones.length ? bbox.maxY + 10 : 10)
    const el = addGenerated(pts, offsetY, { contours, mode: textMode, wholeWord: true })
    lastTextRef.current = { el, font, text, height: textHeight, spacing: letterSpacing }
    setPreviewBaseY(null)
    setPreviewLive(false)
    setStatus(`Added ${pts.length} stones from text`)
  }, [font, text, textHeight, letterSpacing, textMode, contoursToStones, stones.length, bbox.maxY, previewBaseY, addGenerated])

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
      const raster = await imageToRaster(imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework)
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
        const f = fillStones(raster.grid, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick', hole)
        pts.push(...f.map((p) => ({ ...p, size: fillSize, color: fillColor, layer: 'fill' as const })))
      }
      const last = lastImageRef.current
      const replacing = !!(last && last.file === imageFile && stones === last.after)
      const base = replacing ? last.before : stones
      const offsetY = replacing
        ? last.offsetY
        : previewBaseY ?? (stones.length ? bbox.maxY + 10 : 10)
      const el = replacing && last.el != null ? last.el : elSeq.current++
      const fresh: Stone[] = pts.map((p) => ({
        x: p.x + 10,
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
      setPreviewBaseY(null)
      setImagePreview(null)
      setStatus(
        pts.length
          ? `${replacing ? 'Regenerated' : 'Added'} ${pts.length} stones from image`
          : 'No stones — the artwork read as background. Try the Invert box or move the Threshold slider.',
      )
    } catch (e) {
      setStatus(`Image failed: ${e instanceof Error ? e.message : e}`)
    }
  }, [imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, imgMode, sizes, curSize, gap, stones, bbox.maxY, previewBaseY, pushUndo, uniformRhythm, outlineDesign, outlineStyle, fillStyle, fillSize, fillColor])

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
  }, [imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, imgMode, fillStyle, fillSize, curSize, gap, sizes, outlineDesign, strokePolicy, uniformRhythm, imageFile])

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
  // Zoom keeping whatever is in the middle of the viewport in the middle.
  const zoomAbout = useCallback((z: number) => {
    const { el, bar, w, h } = viewport()
    if (!el) return
    const z0 = zoomRef.current
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
  // The view (zoom + scroll) is remembered, so a refresh comes back exactly
  // where it was. Fitting the restored design on load zoomed in on it, which
  // read as "refresh changes my zoom". Without a saved view: fit the sheet.
  const VIEW_KEY = 'stonecut.view'
  const didInitialFit = useRef(false)
  useEffect(() => {
    if (didInitialFit.current || !measured.current) return
    didInitialFit.current = true
    try {
      const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null')
      if (v && typeof v.zoom === 'number' && v.zoom >= ZOOM_MIN && v.zoom <= ZOOM_MAX) {
        pendingScroll.current = { left: +v.left || 0, top: +v.top || 0 }
        setZoom(v.zoom)
        setViewTick((t) => t + 1)
        return
      }
    } catch { /* fall through to the fit */ }
    fitSheet()
  }, [avail, fitSheet])
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let t: number | null = null
    const save = () => {
      if (t != null) window.clearTimeout(t)
      t = window.setTimeout(() => {
        try { localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: zoomRef.current, left: el.scrollLeft, top: el.scrollTop })) } catch { /* ignore */ }
      }, 300)
    }
    el.addEventListener('scroll', save, { passive: true })
    return () => { el.removeEventListener('scroll', save); if (t != null) window.clearTimeout(t) }
  }, [])
  useEffect(() => {
    if (!didInitialFit.current) return
    const el = wrapRef.current
    if (!el) return
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom, left: el.scrollLeft, top: el.scrollTop })) } catch { /* ignore */ }
  }, [zoom, viewTick])
  const drag = useRef<{ startX: number; startY: number; moved: boolean; orig: Stone[] } | null>(null)
  // marquee: drag over empty canvas in Select mode to box-select stones
  // x1/y1 live in the ref too: mouseup must not depend on React having
  // rendered the last mousemove, or a quick drag selects with a stale box.
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

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
    const sameText = !!last && last.font === font && last.text === text && last.height === textHeight && last.spacing === letterSpacing
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
  const onCanvasDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault() // no text selection / native drag while moving stones
      const p = toMm(e)
      // Add mode gets NO hit slop: dense fills sit closer together than any
      // slop, so with slop every click in a gap "hit" a neighbour and erased
      // it — adding a hole between stones was impossible.
      const handle = hitHandle(p)
      if (handle && selectedEl != null && selBox) {
        const r = elementsRef.current[selectedEl]
        pushUndo(stonesRef.current)
        resizeRef.current = { el: selectedEl, handle, box: selBox, sx0: r.sx, sy0: r.sy, fx: 1, fy: 1, timer: null }
        setResizeBox(selBox)
        if (svgRef.current) svgRef.current.style.cursor = handleCursor(handle)
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
          vecDrag.current = { ids, startX: p.x, startY: p.y, moved: false }
          if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
          return
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
    [toMm, stones, vectors, selVecs, tool, curSize, addSize, mutate, pickStone, zoom, hitHandle, selectedEl, selBox, pushUndo],
  )
  const vecDrag = useRef<{ ids: number[]; startX: number; startY: number; moved: boolean } | null>(null)

  const onCanvasMove = useCallback(
    (e: React.MouseEvent) => {
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
        if (horiz && vert) fx = fy = (fx + fy) / 2 // corners keep proportions
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
      const vd = vecDrag.current
      if (vd) {
        const p = toMm(e)
        const dx = p.x - vd.startX, dy = p.y - vd.startY
        if (!vd.moved && Math.hypot(dx, dy) * zoom < 3) return
        if (!vd.moved) { vd.moved = true; pushUndo(stonesRef.current) }
        vd.startX = p.x; vd.startY = p.y
        setVectors((prev) => prev.map((v) => (vd.ids.includes(v.id) ? { ...v, x: v.x + dx, y: v.y + dy } : v)))
        return
      }
      if (!drag.current || tool !== 'select' || selection.size === 0) {
        // hover feedback: a hand over a stone says "this will move", a
        // resize arrow over a handle says "this will resize"
        if (tool === 'select' && svgRef.current && !drag.current) {
          const p = toMm(e)
          const h = hitHandle(p)
          const over = !h && pickStone(p, Math.max(0.5, HIT_SLOP_PX / zoom)) >= 0
          svgRef.current.style.cursor = h ? handleCursor(h) : over ? 'grab' : ''
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
      }
      const orig = drag.current.orig
      setStones(orig.map((s, i) => (selection.has(i) ? { ...s, x: s.x + dx, y: s.y + dy } : s)))
    },
    [toMm, tool, selection, pushUndo, pickStone, zoom, hitHandle, regenElement],
  )

  const onCanvasUp = useCallback(() => {
    drag.current = null
    vecDrag.current = null
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
    const up = () => { if (drag.current || marqueeRef.current || resizeRef.current || vecDrag.current) onCanvasUp() }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [onCanvasUp])

  // double-click a stone: select every stone chained to it — outline and fill
  // link at ~3.75mm, neighbouring stones at the rhythm, while a separate
  // design sits 10mm+ away and stays unselected
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const p = toMm(e)
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
    [toMm, stones, holeOf, gap, pickStone, zoom],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
        mutate((prev) => prev.filter((_, i) => !selection.has(i)))
        setSelection(new Set())
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selVecs.size) {
        mutateVectors((prev) => prev.filter((v) => !selVecs.has(v.id)))
        setSelVecs(new Set())
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
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        const prev = undoStack.current.pop()
        if (prev) { setStones(prev.stones); setElements(prev.elements); setVectors(prev.vectors) }
        setSelection(new Set())
        setSelVecs(new Set())
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        setSelection(new Set(stones.map((_, i) => i)))
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAbout(zoomRef.current * 1.25) }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); zoomAbout(zoomRef.current / 1.25) }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); fitSheet() }
      if (!e.metaKey && !e.ctrlKey && (e.key === 'f' || e.key === 'F')) fitDesign()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, stones, mutate, zoomAbout, fitSheet, fitDesign, selVecs, mutateVectors])

  // ---------- material presets ----------
  const preset = presets[presetIdx] ?? presets[0]
  const updatePreset = useCallback(
    (patch: Partial<MaterialPreset>) => {
      setPresets((prev) => {
        const next = prev.map((p, i) => (i === presetIdx ? { ...p, ...patch } : p))
        localStorage.setItem('stonecut.presets', JSON.stringify(next))
        return next
      })
    },
    [presetIdx],
  )
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

  // ---------- cut / export ----------
  // Cut layers: outline and fill are separate physical cuts, but BOTH use the
  // full design's frame so the two templates register when stacked.
  const [cutLayer, setCutLayer] = useState<'all' | 'outline' | 'fill' | 'lines'>('all')
  const cutJob = useMemo(
    () =>
      cutLayer === 'all'
        ? job
        : cutLayer === 'lines'
          ? { ...job, stones: [] }
          : { ...job, stones: job.stones.filter((st) => (st.layer ?? 'outline') === cutLayer), paths: [] },
    [job, cutLayer],
  )
  const cutCount = cutJob.stones.length + (cutJob.paths?.length ?? 0)
  const layerCounts = useMemo(() => {
    let o = 0
    let f = 0
    for (const st of stones) ((st.layer ?? 'outline') === 'fill' ? f++ : o++)
    return { o, f }
  }, [stones])
  const cutData = useCallback(
    () =>
      format === 'gpgl'
        ? toGPGL(cutJob, preset, originCorner, gpStep, sendConditions, swapAxes)
        : toHPGL(cutJob, preset, originCorner),
    [format, cutJob, preset, originCorner, gpStep, sendConditions, swapAxes],
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

  const sizeKeys = Object.keys(sizes)
  const stoneColor: Record<string, string> = {}
  sizeKeys.forEach((k, i) => { stoneColor[k] = `hsl(${(i * 47) % 360} 70% 60%)` })

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
      dot((p.x + 10) * zoom, (p.y + previewOffsetY) * zoom, ((sizes[p.size ?? curSize]?.holeMm ?? 3) / 2) * zoom, p.color ?? '#8fb0ff', 0.55)
    if (previewLive)
      for (const p of previewStones ?? [])
        dot((p.x + 10) * zoom, (p.y + previewOffsetY) * zoom, ((sizes[p.size ?? curSize]?.holeMm ?? 3) / 2) * zoom, p.color ?? '#8fb0ff', 0.55)
    stones.forEach((s, i) =>
      dot(s.x * zoom, s.y * zoom, (holeOf(s) / 2) * zoom, s.color ?? ((s.layer ?? 'outline') === 'fill' ? fillColor : outlineColor), 0.85, selection.has(i) ? '#fff' : undefined),
    )
    ctx.globalAlpha = 1
  }, [stones, selection, imagePreview, previewStones, previewLive, zoom, canvasW, canvasH, previewOffsetY, sizes, curSize, holeOf, stoneColor, fillColor, outlineColor])

  const previewPath = useMemo(() => {
    if (!textPreview) return ''
    return textPreview.contours
      .map(
        (c) =>
          'M' +
          c.map((p) => `${((p.x + 10) * zoom).toFixed(1)},${((p.y + previewOffsetY) * zoom).toFixed(1)}`).join('L') +
          'Z',
      )
      .join('')
  }, [textPreview, zoom, previewOffsetY])

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
    // script fonts overlap letter to letter; unite them so the blade does
    // not cut across the joins (holes in letters are kept)
    const united = booleanPaths('union', [textPreview.contours])
    const r = addVector(united.length ? united : textPreview.contours, text.trim() || 'text', { x: 10, y: previewOffsetY })
    if (!r) return
    setPreviewBaseY(null)
    setPreviewLive(false)
    setStatus(`Added "${text.trim()}" as ${r.lines} cut line${r.lines === 1 ? '' : 's'} · ${r.w.toFixed(0)} × ${r.h.toFixed(0)} mm`)
  }, [textPreview, text, previewOffsetY, addVector])
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
  const alignCount = alignObjs.length

  // ---------- menu bar ----------
  const [showShortcuts, setShowShortcuts] = useState(false)
  // Sidebar sections are plain <details>; the Window menu opens one by title
  // and scrolls it into view (Kevin works at a big browser zoom, so finding
  // a folded section by scrolling is the slow part).
  const openSection = useCallback((title: string, focusSel?: string) => {
    const secs = Array.from(document.querySelectorAll<HTMLDetailsElement>('details.sec'))
    const d = secs.find((el) => el.querySelector('summary')?.textContent?.trim() === title)
    if (!d) return
    d.open = true
    d.scrollIntoView({ block: 'start', behavior: 'smooth' })
    if (focusSel) window.setTimeout(() => d.querySelector<HTMLElement>(focusSel)?.focus(), 200)
  }, [])
  const saveDesignFile = useCallback(() => {
    download('stonecut-design.json', JSON.stringify({ v: 1, stones, sizes, elements, vectors }), 'application/json')
  }, [stones, sizes, elements, vectors])
  const openDesignFile = useCallback(() => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = '.json,application/json'
    inp.onchange = async () => {
      const f = inp.files?.[0]
      if (!f) return
      try {
        const d = JSON.parse(await f.text())
        if (!Array.isArray(d?.stones) && !Array.isArray(d?.vectors)) throw new Error('not a StoneCut design file')
        pushUndo(stonesRef.current)
        const loaded = (d.stones ?? []) as Stone[]
        setStones(loaded)
        if (d.sizes && typeof d.sizes === 'object') setSizes({ ...DEFAULT_SIZES, ...d.sizes })
        setElements(d.elements && typeof d.elements === 'object' ? d.elements : {})
        const vecs: VecItem[] = Array.isArray(d.vectors) ? d.vectors : []
        setVectors(vecs)
        vecSeq.current = vecs.reduce((m, v) => Math.max(m, v.id), 0) + 1
        elSeq.current = loaded.reduce((m, st) => Math.max(m, st.el ?? 0), 0) + 1
        setSelection(new Set())
        setStatus(`Opened ${f.name}: ${loaded.length} stones`)
      } catch (e) {
        setStatus(`Could not open: ${e instanceof Error ? e.message : e}`)
      }
    }
    inp.click()
  }, [pushUndo])
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
  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (prev) { setStones(prev.stones); setElements(prev.elements); setVectors(prev.vectors) }
    setSelection(new Set())
    setSelVecs(new Set())
  }, [])
  const hasSel = selection.size > 0
  const hasStones = stones.length > 0
  const sectionItems = ['Text', 'Stones', 'Fill', 'Shapes', 'Templates', 'Image', 'Vector cut', 'Align & Pathfinder', 'Edit', 'Material', 'Cut']
  const menus: Menu[] = [
    { label: 'File', items: [
      { label: 'New design', onClick: clearAll, disabled: !hasStones && !pending && !vectors.length },
      { label: 'Open design…', onClick: openDesignFile },
      { label: 'Import vector cut (SVG)…', onClick: importSvg },
      { label: 'Save design…', shortcut: '.json', onClick: saveDesignFile, disabled: !hasStones },
      'sep',
      { label: 'Export SVG (Cricut)…', onClick: () => download(`stonecut-${cutLayer}.svg`, toSVG(cutJob), 'image/svg+xml'), disabled: !cutCount },
      { label: 'Export plotter file (.plt)…', onClick: () => download(`stonecut-${cutLayer}.plt`, cutData()), disabled: !cutCount },
      'sep',
      { label: '⚡ Cut on Graphtec', onClick: () => { void doSend() }, disabled: !cutCount },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', shortcut: '⌘Z', onClick: undo },
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
      { label: 'Unite', disabled: !selVecs.size, onClick: () => pathfinder('union') },
      { label: 'Minus front', disabled: selVecs.size < 2, onClick: () => pathfinder('difference') },
      { label: 'Intersect', disabled: selVecs.size < 2, onClick: () => pathfinder('intersection') },
      { label: 'Exclude', disabled: selVecs.size < 2, onClick: () => pathfinder('xor') },
    ] },
    { label: 'Type', items: [
      { label: 'Add text…', onClick: () => openSection('Text', 'input') },
      { label: 'Add text as cut lines', onClick: textAsCutLines, disabled: !textPreview },
      { label: 'Fonts…', onClick: () => { openSection('Text'); setFontOpen(true) } },
      'sep',
      { label: 'Add a shape…', onClick: () => openSection('Shapes') },
      { label: 'Trace an image…', onClick: () => openSection('Image') },
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
      { label: 'Select / move tool', checked: tool === 'select', onClick: () => setTool('select') },
      { label: 'Add / erase tool', checked: tool === 'add', onClick: () => setTool('add') },
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
              <tr><td>Stones</td><td>{cutJob.stones.length}{cutLayer !== 'all' && cutLayer !== 'lines' ? ` (${cutLayer} layer)` : ''}</td></tr>
              {(cutJob.paths?.length ?? 0) > 0 && <tr><td>Cut lines</td><td>{cutJob.paths!.length} path{cutJob.paths!.length === 1 ? '' : 's'}</td></tr>}
              <tr><td>Size</td><td>{((bbox.maxX - bbox.minX) / 25.4).toFixed(2)}″ × {((bbox.maxY - bbox.minY) / 25.4).toFixed(2)}″</td></tr>
              {fromOrigin && placement === 'artboard' && (
                <tr><td>From origin</td><td>{fromOrigin.across.toFixed(2)}″ across, {fromOrigin.feed.toFixed(2)}″ up</td></tr>
              )}
              <tr><td>Material</td><td>{preset.name} · force {preset.force} · speed {preset.speed}{preset.passes > 1 ? ` · ${preset.passes} passes` : ''}{sendConditions ? '' : ' (panel settings)'}</td></tr>
            </tbody></table>
            {offBoard && <p className="modal-warn">Part of the design is off the board and will be clipped.</p>}
            <p className="hint">Blade at the front-right corner of the material, ORIGIN pressed on the cutter.</p>
            <div className="modal-actions">
              <button onClick={() => setCutConfirm(null)}>Cancel</button>
              <button className="primary" autoFocus onClick={() => { void doSendNow() }}>⚡ Cut now</button>
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
            <tr><td>⌘Z</td><td>undo</td></tr>
            <tr><td>⌘A</td><td>select all</td></tr>
            <tr><td>⌘+ / ⌘−</td><td>zoom in / out</td></tr>
            <tr><td>⌘-wheel / pinch</td><td>zoom at the cursor · plain wheel pans</td></tr>
            <tr><td>F</td><td>fit design</td></tr>
            <tr><td>⌘0</td><td>fit sheet</td></tr>
          </tbody></table>
          <button onClick={() => setShowShortcuts(false)}>Close</button>
        </div>
      )}
      <div className="app-body">
      <aside className="panel">
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
                          if (selFont === f.id) { setFontOpen(false); return } // second click confirms
                          setHiIdx(i)
                          void loadGFont(f, weight)
                        }}
                      >
                        {f.f}
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
            <label>Style
              <select value={textMode} onChange={(e) => setTextMode(e.target.value as StoneMode)}>
                <option value="outline">Outline</option>
                <option value="fill">Fill</option>
                <option value="both">Outline + fill</option>
              </select>
            </label>
          </div>
          <div className="grid2">
            <label>Height (mm)
              <input type="number" min={10} max={500} value={textHeight} onChange={(e) => setTextHeight(+e.target.value)} />
            </label>
            <label>Letter spacing
              <input type="number" min={0} max={20} value={letterSpacing} onChange={(e) => setLetterSpacing(+e.target.value)} />
            </label>
          </div>
          {textPreview && (
            <div className="sizeinfo">
              Size: <b>{(textPreview.widthMm / 25.4).toFixed(2)}″ × {(textHeight / 25.4).toFixed(2)}″</b>
              <span> · {Math.round(textPreview.widthMm)} × {textHeight} mm in {fontName}{previewStones ? ` · ${previewStones.length} stones` : ''}</span>
            </div>
          )}
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
          <button className={`primary${pendingText ? ' urgent' : ''}`} onClick={generateText}>
            {pendingText ? `Add ${pendingText} text stones to design` : 'Add text stones'}
          </button>
          <button onClick={textAsCutLines} disabled={!textPreview}>Add text as cut lines (no stones)</button>
          <p className="hint">Cut lines follow the letter outlines — vinyl lettering, a stencil, or a border around the stones.</p>
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
          <div className="sizeinfo">
            Even spacing: one lattice, stepped on the fill stone ·{' '}
            <b>{((sizes[fillSize]?.holeMm ?? 2.5) + hardGapOf(gap)).toFixed(1)} mm</b>
            <span> — set it in Stones · Spacing</span>
          </div>
          <label>Fill style
            <select value={fillStyle} onChange={(e) => setFillStyle(e.target.value as typeof fillStyle)}>
              <option value="brick">Brick — offset rows</option>
              <option value="grid">Grid — aligned rows</option>
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
          <label className="filebtn">{imageFile?.name || 'Choose image (PNG/JPG/SVG)'}
            <input type="file" accept="image/*" onChange={async (e) => {
              const f = e.target.files?.[0] ?? null
              setImageFile(f)
              if (!f) return
              try {
                // pick settings that make the artwork the design, so a light
                // logo or transparent background doesn't silently yield nothing
                const a = await analyzeImage(f, imgWidth, (sizes[curSize]?.holeMm ?? 3.4) + gap)
                setImgThreshold(a.threshold)
                setImgInvert(a.invert)
                setImgAlphaKey(a.alphaKey)
                setImgLinework(a.linework)
                applyStrokeStyle(a)
                setStatus(`${f.name} — ${a.note}`)
              } catch {
                setStatus(`Could not read ${f.name}`)
              }
            }} />
          </label>
          <button className={pendingImage ? 'primary urgent' : ''} onClick={generateImage}>
            {pendingImage ? `Add ${pendingImage} image stones to design` : 'Add image stones'}
          </button>
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
        </Section>

        <Section title="Edit">
          <div className="toolrow">
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>Select / move</button>
            <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')}>Add / erase</button>
          </div>
          <p className="hint">
            {tool === 'select'
              ? 'Click a hole to select it, drag to move. Shift-click adds to the selection, drag on empty board boxes a group. Double-click a design to grab all of it: drag its handles to resize (holes stay the same size, the count changes). Arrow keys nudge 0.5 mm (Shift: 5 mm), Delete removes.'
              : 'Click empty board to add a hole; clicking an existing hole ERASES it. Switch to Select / move to drag holes.'}
          </p>
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
        </Section>

        <Section title="Cut">
          <label>Layer
            <select value={cutLayer} onChange={(e) => setCutLayer(e.target.value as typeof cutLayer)}>
              <option value="all">Everything ({stones.length} stones{vectors.length ? ` + ${job.paths?.length ?? 0} cut lines` : ''})</option>
              <option value="outline">Outline stones only ({layerCounts.o})</option>
              <option value="fill">Fill stones only ({layerCounts.f})</option>
              {vectors.length > 0 && <option value="lines">Vector cut lines only ({job.paths?.length ?? 0})</option>}
            </select>
          </label>
          {cutLayer !== 'all' && (
            <p className="hint">
              Layers share one frame — cut each on its own sheet and they line up when stacked.
            </p>
          )}
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
            <button disabled={!cutCount} onClick={() => download(`stonecut-${cutLayer}.plt`, cutData())}>Download .plt</button>
            <button disabled={!cutCount} onClick={() => download(`stonecut-${cutLayer}.svg`, toSVG(cutJob), 'image/svg+xml')}>SVG (Cricut)</button>
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
          {format === 'gpgl' && (
            <>
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
            {cutCount ? [cutJob.stones.length ? `${cutJob.stones.length} stones` : '', cutJob.paths?.length ? `${cutJob.paths.length} cut line${cutJob.paths.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ') : 'add a design to cut'}
            {fromOrigin && placement === 'artboard' && ` · ${fromOrigin.across.toFixed(2)}″ across, ${fromOrigin.feed.toFixed(2)}″ up from origin`}
          </div>
        </div>
      </aside>

      <main className="canvas-wrap" ref={wrapRef}>
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
            value={boardWIn}
            onChange={(e) => setBoardWIn(Math.max(1, +e.target.value || 1))}
            style={{ width: 54 }}
          />
          <span>×</span>
          <input
            type="number"
            min={1}
            max={60}
            step={0.5}
            value={boardHIn}
            onChange={(e) => setBoardHIn(Math.max(1, +e.target.value || 1))}
            style={{ width: 54 }}
          />
          <span>in</span>
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
              return (
                <>
                  <rect x={0} y={0} width={W} height={H} fill="#ffffff" fillOpacity={0.035} stroke="#7789ad" strokeWidth={1.5} />
                  {Array.from({ length: cols }, (_, k) => k + 1).map((i) => (
                    <g key={`v${i}`}>
                      <line x1={ox + dir * i * inch} y1={0} x2={ox + dir * i * inch} y2={H} stroke="#3d4863" strokeWidth={1} />
                      <text x={ox + dir * i * inch + (right ? 3 : -3)} y={H - 4} fill="#8b97b5" fontSize={10} textAnchor={right ? 'start' : 'end'}>{i}"</text>
                    </g>
                  ))}
                  {Array.from({ length: rows }, (_, k) => k + 1).map((i) => (
                    <g key={`h${i}`}>
                      <line x1={0} y1={H - i * inch} x2={W} y2={H - i * inch} stroke="#3d4863" strokeWidth={1} />
                      <text x={right ? W - 3 : 3} y={H - i * inch + 11} fill="#8b97b5" fontSize={10} textAnchor={right ? 'end' : 'start'}>{i}"</text>
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
                  <text x={right ? 4 : W - 4} y={12} fill="#7789ad" fontSize={11} textAnchor={right ? 'start' : 'end'}>
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
          {vectors.map((v) => (
            <path
              key={v.id}
              d={pathsToD(v.base)}
              transform={`translate(${v.x * zoom} ${v.y * zoom}) scale(${v.s * zoom})`}
              fill="none"
              stroke={selVecs.has(v.id) ? '#f0b95e' : '#8fd3ff'}
              strokeWidth={selVecs.has(v.id) ? 2 : 1.5}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ))}
          {tool === 'select' && selBox && (() => {
            const b = resizeBox ?? selBox
            const w = b.maxX - b.minX, h = b.maxY - b.minY
            return (
              <g pointerEvents="none">
                <rect x={b.minX * zoom} y={b.minY * zoom} width={w * zoom} height={h * zoom} fill="none" stroke="#f0b95e" strokeWidth={1.5} strokeDasharray="6 3" />
                {HANDLES.map((hd) => {
                  const q = handlePos(b, hd)
                  return <rect key={hd} x={q.x * zoom - HANDLE_PX / 2} y={q.y * zoom - HANDLE_PX / 2} width={HANDLE_PX} height={HANDLE_PX} fill="#f0b95e" stroke="#12151c" strokeWidth={1.5} />
                })}
                <text x={b.minX * zoom} y={b.minY * zoom - 8} fill="#f0b95e" fontSize={12} fontWeight={700}>
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
      </main>
      </div>
    </div>
  )
}

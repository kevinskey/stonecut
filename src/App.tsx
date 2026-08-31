import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type opentype from 'opentype.js'
import { DEFAULT_PRESETS, DEFAULT_SIZES } from './model'
import type { MaterialPreset, Stone, StoneSpec } from './model'
import { removeCollisions } from './geometry'
import { SpacingIndex, bareFrac, capGaps, debugSpans, debugStones, spinedWidths, fillByGlyph, fillStones, offsetRows, outlineOrSpine, rasterizeContours } from './fill'
import { loadFontFile, parseFontBuffer, textToContours } from './text'
import { deleteFont, getFont, listFonts, saveFont } from './fontstore'
import { analyzeImage, imageToRaster } from './image'
import { download, toGPGL, toHPGL, toSVG } from './export'
import { sendToCutter } from './usb'
import './App.css'

type Tool = 'select' | 'add'
type StoneMode = 'outline' | 'fill' | 'both'

const MARGIN = 5 // mm margin around design in exports

// template-integrity floor (sticky flock ~0.5-1.2mm edge gap) regardless of
// how wide the design spacing is set
const hardGapOf = (spacing: number) => Math.max(0.5, Math.min(spacing, 1.2))

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

function loadPresets(): MaterialPreset[] {
  try {
    const raw = localStorage.getItem('stonecut.presets')
    if (raw) return JSON.parse(raw)
  } catch { /* fall through */ }
  return DEFAULT_PRESETS
}

export default function App() {
  const [stones, setStones] = useState<Stone[]>([])
  const stonesRef = useRef<Stone[]>([])
  // last image commit — while untouched, generation-setting changes REGENERATE
  // it in place instead of only affecting the next add
  const lastImageRef = useRef<{ file: File; offsetY: number; before: Stone[]; after: Stone[] } | null>(null)
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [sizes, setSizes] = useState<Record<string, StoneSpec>>(() => ({ ...DEFAULT_SIZES }))
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

  const [text, setText] = useState('GLEE')
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
      const a = await analyzeImage(f)
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

  const undoStack = useRef<Stone[][]>([])
  const pushUndo = useCallback((prev: Stone[]) => {
    undoStack.current.push(prev)
    if (undoStack.current.length > 50) undoStack.current.shift()
  }, [])
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
    if (!stones.length) return { minX: 0, minY: 0, maxX: 100, maxY: 60 }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of stones) {
      const r = holeOf(s) / 2
      minX = Math.min(minX, s.x - r); minY = Math.min(minY, s.y - r)
      maxX = Math.max(maxX, s.x + r); maxY = Math.max(maxY, s.y + r)
    }
    return { minX, minY, maxX, maxY }
  }, [stones, holeOf])

  const job = useMemo(() => {
    const w = bbox.maxX - bbox.minX + MARGIN * 2
    const h = bbox.maxY - bbox.minY + MARGIN * 2
    return {
      stones: stones.map((s) => ({ ...s, x: s.x - bbox.minX + MARGIN, y: s.y - bbox.minY + MARGIN })),
      sizes,
      widthMm: Math.ceil(w),
      heightMm: Math.ceil(h),
    }
  }, [stones, bbox, sizes])

  // live text preview: sample the selected font before committing stones
  const textPreview = useMemo(() => {
    if (!font || !text.trim()) return null
    try {
      return textToContours(font, text, textHeight, letterSpacing)
    } catch {
      return null
    }
  }, [font, text, textHeight, letterSpacing])
  // The preview's Y offset is PINNED when a preview session starts, not
  // derived live from the bbox. Deriving it live meant every manually added
  // hole grew the bbox and shoved the whole previewed design away from the
  // cursor — placing a hole on top of the artwork was impossible.
  const [previewBaseY, setPreviewBaseY] = useState<number | null>(null)
  const layoutRef = useRef({ len: 0, maxY: 0 })
  useEffect(() => {
    layoutRef.current = { len: stones.length, maxY: bbox.maxY }
    stonesRef.current = stones
  })
  const pinPreviewBase = useCallback(() => {
    setPreviewBaseY((prev) => prev ?? (layoutRef.current.len ? layoutRef.current.maxY + 10 : 10))
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
      // Absolute widths cannot separate art types — a chunky icon's strokes
      // overlap a music note's head in millimetres. SHAPE statistics can:
      // pure line art is thin-dominant AND uniform (its p96 width is just a
      // junction bulge, ~2x its median), while blob-bearing art (note heads,
      // mascot bodies on thin limbs) is thin-dominant but NOT uniform. Solid
      // art isn't thin-dominant at all.
      const deciles = a.strokeDeciles ?? []
      const p50 = toMm(deciles[4] ?? a.strokePx)
      const thinDominant = p50 < pitch * 1.6
      const blobby = p50 > 0 && toMm(a.strokeMax ?? 0) / p50 >= 2.5
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
  const [previewStones, setPreviewStones] = useState<{ x: number; y: number; size?: string; color?: string }[] | null>(null)
  const [previewLive, setPreviewLive] = useState(true)
  useEffect(() => {
    setPreviewLive(true)
  }, [textPreview, curSize, gap, sizes, textMode, outlineStyle, outlineDesign, uniformRhythm, fillStyle, fillSize, fillColor, fontOpen, pinPreviewBase])
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
        const grid = rasterizeContours(textPreview.contours, 6, outlineDesign === 'ghost' || outlineDesign === 'double' ? rhythm + hole : 0.5)
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
          for (const p of outline) fIdx.add(p, hole / 2)
          const f = fillByGlyph(textPreview.contours, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick')
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
        pinPreviewBase()
        setPreviewStones(pts)
        ;(window as unknown as { __scDebug?: unknown }).__scDebug = [...debugStones]
        ;(window as unknown as { __scSpans?: unknown }).__scSpans = debugSpans.map((s) => ({ ...s, chords: [...s.chords] }))
        ;(window as unknown as { __scContours?: unknown }).__scContours = textPreview.contours
        ;(window as unknown as { __scPts?: unknown }).__scPts = pts
      } catch {
        setPreviewStones(null)
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
        const raster = await imageToRaster(imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework)
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
          for (const p of outline) fIdx.add(p, hole / 2)
          const f = fillStones(raster.grid, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick')
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
        pinPreviewBase()
        setImagePreview(pts)
        ;(window as unknown as { __scPts?: unknown }).__scPts = pts
        ;(window as unknown as { __scDebug?: unknown }).__scDebug = [...debugStones]
      } catch {
        setImagePreview(null)
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [imageFile, imgWidth, imgThreshold, imgInvert, imgAlphaKey, imgLinework, imgMode, sizes, curSize, gap,
      outlineStyle, outlineDesign, uniformRhythm, fillStyle, fillSize, fillColor, pinPreviewBase])

  // ---------- generation ----------
  const addGenerated = useCallback(
    (pts: { x: number; y: number; size?: string; color?: string; layer?: 'outline' | 'fill' }[], offsetY: number) => {
      const fresh: Stone[] = pts.map((p) => ({ x: p.x + 10, y: p.y + offsetY, size: p.size ?? curSize, color: p.color, layer: p.layer ?? 'outline' }))
      mutate((prev) => {
        // half-gap threshold: safety net for merges only — relaxed fills sit
        // slightly under full pitch by design and must not get culled here
        const all = [...prev, ...fresh]
        const kept = removeCollisions(all, (s) => sizes[s.size]?.holeMm ?? 3, hardGapOf(gap) * 0.5)
        return kept
      })
    },
    [curSize, gap, mutate, sizes],
  )

  const generateText = useCallback(() => {
    if (!font) { setStatus('Upload a font file first (.ttf/.otf)'); return }
    const { contours } = textToContours(font, text, textHeight, letterSpacing)
    const hole = sizes[curSize]?.holeMm ?? 3
    const hardGap = hardGapOf(gap)
    const rhythm = hole + gap
    const idx = new SpacingIndex(hole + hardGap)
    const pts: { x: number; y: number; size?: string; color?: string }[] = []
    const grid = rasterizeContours(contours, 6, outlineDesign === 'ghost' || outlineDesign === 'double' ? rhythm + hole : 0.5)
    let outline: { x: number; y: number }[] = []
    if (textMode !== 'fill') {
      if (outlineDesign === 'ghost') {
        outline = offsetRows(grid, hole, hardGap, idx, rhythm, rhythm * 0.55, true, uniformRhythm)
      } else {
        outline = outlineOrSpine(contours, grid, hole, hardGap, idx, outlineStyle, true, rhythm, uniformRhythm)
        if (outlineDesign === 'double')
          outline = outline.concat(offsetRows(grid, hole, hardGap, idx, rhythm, rhythm, true, uniformRhythm))
      }
    }
    pts.push(...outline.map((p) => ({ ...p, layer: 'outline' as const })))
    if (textMode !== 'outline') {
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
      const f = fillByGlyph(contours, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick')
      pts.push(...f.map((p) => ({ ...p, size: fillSize, color: fillColor, layer: 'fill' as const })))
    }
    // commit exactly where the preview showed; release the pin so the next
    // preview session stacks below the committed stones
    const offsetY = previewBaseY ?? (stones.length ? bbox.maxY + 10 : 10)
    addGenerated(pts, offsetY)
    setPreviewBaseY(null)
    setPreviewLive(false)
    setStatus(`Added ${pts.length} stones from text`)
  }, [font, text, textHeight, letterSpacing, textMode, curSize, gap, sizes, stones.length, bbox.maxY, previewBaseY, addGenerated, uniformRhythm, outlineDesign, outlineStyle, fillStyle, fillSize, fillColor])

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
        for (const p of outline) fIdx.add(p, hole / 2)
        const f = fillStones(raster.grid, fHole, fGap, fInset, fIdx, outline, fRhythm, fillStyle === 'brick')
        pts.push(...f.map((p) => ({ ...p, size: fillSize, color: fillColor, layer: 'fill' as const })))
      }
      const last = lastImageRef.current
      const replacing = !!(last && last.file === imageFile && stones === last.after)
      const base = replacing ? last.before : stones
      const offsetY = replacing
        ? last.offsetY
        : previewBaseY ?? (stones.length ? bbox.maxY + 10 : 10)
      const fresh: Stone[] = pts.map((p) => ({
        x: p.x + 10,
        y: p.y + offsetY,
        size: p.size ?? curSize,
        color: p.color,
        layer: p.layer ?? 'outline',
      }))
      const kept = removeCollisions(
        [...base, ...fresh],
        (st) => sizes[st.size]?.holeMm ?? 3,
        hardGapOf(gap) * 0.5,
      )
      if (!replacing) pushUndo(stones) // regens share the original undo point
      setStones(kept)
      lastImageRef.current = { file: imageFile, offsetY, before: base, after: kept }
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
    }, 400)
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
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const drag = useRef<{ startX: number; startY: number; moved: boolean; orig: Stone[] } | null>(null)
  // marquee: drag over empty canvas in Select mode to box-select stones
  const marqueeRef = useRef<{ x0: number; y0: number; additive: boolean } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  const toMm = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const rect = svgRef.current!.getBoundingClientRect()
      return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom }
    },
    [zoom],
  )

  const onCanvasDown = useCallback(
    (e: React.MouseEvent) => {
      const p = toMm(e)
      // Add mode gets NO hit slop: dense fills sit closer together than the
      // 0.5mm select-mode slop, so with slop every click in a gap "hit" a
      // neighbour and erased it — adding a hole between stones was impossible.
      const slop = tool === 'add' ? 0 : 0.5
      const hit = stones.findIndex((s) => Math.hypot(s.x - p.x, s.y - p.y) <= holeOf(s) / 2 + slop)
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
            if (best >= 0) {
              // blend in with the field being clicked into: layer and colour
              // always follow the neighbour; size follows it only in Auto
              layer = stones[best].layer ?? 'outline'
              color = stones[best].color
              if (addSize === 'auto') size = stones[best].size
            }
          }
          mutate((prev) => [...prev, { x: p.x, y: p.y, size, color, layer }])
        }
        else mutate((prev) => prev.filter((_, i) => i !== hit)) // click existing stone in add mode = remove
        return
      }
      if (hit === -1) {
        if (!e.shiftKey) setSelection(new Set())
        marqueeRef.current = { x0: p.x, y0: p.y, additive: e.shiftKey }
        return
      }
      setSelection((prev) => {
        const next = e.shiftKey ? new Set(prev) : prev.has(hit) ? new Set(prev) : new Set<number>()
        next.add(hit)
        return next
      })
      drag.current = { startX: p.x, startY: p.y, moved: false, orig: stones }
    },
    [toMm, stones, tool, curSize, addSize, holeOf, mutate],
  )

  const onCanvasMove = useCallback(
    (e: React.MouseEvent) => {
      if (marqueeRef.current && tool === 'select') {
        const p = toMm(e)
        setMarquee({ x0: marqueeRef.current.x0, y0: marqueeRef.current.y0, x1: p.x, y1: p.y })
        return
      }
      if (!drag.current || tool !== 'select' || selection.size === 0) return
      const p = toMm(e)
      const dx = p.x - drag.current.startX
      const dy = p.y - drag.current.startY
      if (!drag.current.moved && Math.hypot(dx, dy) < 0.3) return
      if (!drag.current.moved) {
        drag.current.moved = true
        pushUndo(drag.current.orig)
      }
      const orig = drag.current.orig
      setStones(orig.map((s, i) => (selection.has(i) ? { ...s, x: s.x + dx, y: s.y + dy } : s)))
    },
    [toMm, tool, selection, pushUndo],
  )

  const onCanvasUp = useCallback(() => {
    drag.current = null
    const mq = marqueeRef.current
    marqueeRef.current = null
    if (mq && marquee) {
      const x0 = Math.min(mq.x0, marquee.x1)
      const x1 = Math.max(mq.x0, marquee.x1)
      const y0 = Math.min(mq.y0, marquee.y1)
      const y1 = Math.max(mq.y0, marquee.y1)
      if (x1 - x0 > 0.5 || y1 - y0 > 0.5) {
        setSelection((prev) => {
          const next = mq.additive ? new Set(prev) : new Set<number>()
          stones.forEach((st, i) => {
            if (st.x >= x0 && st.x <= x1 && st.y >= y0 && st.y <= y1) next.add(i)
          })
          return next
        })
      }
    }
    setMarquee(null)
  }, [marquee, stones])

  // double-click a stone: select every stone chained to it — outline and fill
  // link at ~3.75mm, neighbouring stones at the rhythm, while a separate
  // design sits 10mm+ away and stays unselected
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const p = toMm(e)
      const start = stones.findIndex((st) => Math.hypot(st.x - p.x, st.y - p.y) <= holeOf(st) / 2 + 0.5)
      if (start < 0) return
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
    [toMm, stones, holeOf, gap],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
        mutate((prev) => prev.filter((_, i) => !selection.has(i)))
        setSelection(new Set())
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        const prev = undoStack.current.pop()
        if (prev) setStones(prev)
        setSelection(new Set())
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        setSelection(new Set(stones.map((_, i) => i)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, stones, mutate])

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
  const [cutLayer, setCutLayer] = useState<'all' | 'outline' | 'fill'>('all')
  const cutJob = useMemo(
    () =>
      cutLayer === 'all'
        ? job
        : { ...job, stones: job.stones.filter((st) => (st.layer ?? 'outline') === cutLayer) },
    [job, cutLayer],
  )
  const layerCounts = useMemo(() => {
    let o = 0
    let f = 0
    for (const st of stones) ((st.layer ?? 'outline') === 'fill' ? f++ : o++)
    return { o, f }
  }, [stones])
  const cutData = useCallback(
    () => (format === 'gpgl' ? toGPGL(cutJob, preset) : toHPGL(cutJob, preset)),
    [format, cutJob, preset],
  )

  const doSend = useCallback(async () => {
    if (!stones.length) { setStatus('Nothing to cut'); return }
    try {
      setStatus('Connecting to cutter…')
      await sendToCutter(cutData(), (sent, total) =>
        setStatus(`Cutting… ${Math.round((sent / total) * 100)}%`),
      )
      setStatus('Job sent ✓')
    } catch (e) {
      setStatus(`Send failed: ${e instanceof Error ? e.message : e}`)
    }
  }, [stones.length, cutData])

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

  return (
    <div className="app">
      <aside className="panel">
        <h1>StoneCut</h1>
        <div className="statusbar">{status} · {stones.length} stones · {job.widthMm}×{job.heightMm} mm ({(job.widthMm / 25.4).toFixed(1)}×{(job.heightMm / 25.4).toFixed(1)} in)</div>


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
          <button className="primary" onClick={generateText}>Add text stones</button>
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
                        const a = await analyzeImage(f)
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
                const a = await analyzeImage(f)
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
          <button onClick={generateImage}>Add image stones</button>
        </Section>

        <Section title="Edit">
          <div className="toolrow">
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>Select / move</button>
            <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')}>Add / erase</button>
          </div>
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
          <div className="toolrow">
            <button disabled={!stones.length} onClick={() => { mutate(() => []); setSelection(new Set()) }}>Clear all</button>
          </div>
          <p className="hint">Click = select · shift-click = multi · drag empty space = box select · double-click = select whole design · drag = move · Del = delete · ⌘Z undo · ⌘A select all. In Add mode, clicking a stone erases it.</p>
        </Section>

        <Section title="Material">
          <label>Preset
            <select value={presetIdx} onChange={(e) => setPresetIdx(+e.target.value)}>
              {presets.map((p, i) => <option key={i} value={i}>{p.name}</option>)}
            </select>
          </label>
          <div className="grid3">
            <label>Force<input type="number" min={1} max={38} value={preset.force} onChange={(e) => updatePreset({ force: +e.target.value })} /></label>
            <label>Speed<input type="number" min={1} max={64} value={preset.speed} onChange={(e) => updatePreset({ speed: +e.target.value })} /></label>
            <label>Passes<input type="number" min={1} max={5} value={preset.passes} onChange={(e) => updatePreset({ passes: +e.target.value })} /></label>
          </div>
          <button onClick={addPreset}>Save as new preset</button>
        </Section>

        <Section title="Cut">
          <label>Command mode
            <select value={format} onChange={(e) => setFormat(e.target.value as 'gpgl' | 'hpgl')}>
              <option value="gpgl">GP-GL (CE6000 factory default)</option>
              <option value="hpgl">HP-GL (if COMMAND menu set to HP-GL)</option>
            </select>
          </label>
          <label>Layer
            <select value={cutLayer} onChange={(e) => setCutLayer(e.target.value as typeof cutLayer)}>
              <option value="all">All stones ({stones.length})</option>
              <option value="outline">Outline only ({layerCounts.o})</option>
              <option value="fill">Fill only ({layerCounts.f})</option>
            </select>
          </label>
          {cutLayer !== 'all' && (
            <p className="hint">
              Layers share one frame — cut each on its own sheet and they line up when stacked.
            </p>
          )}
          <button className="primary" disabled={!cutJob.stones.length} onClick={doSend}>⚡ Cut on Graphtec</button>
          <div className="toolrow">
            <button disabled={!cutJob.stones.length} onClick={() => download(`stonecut-${cutLayer}.plt`, cutData())}>Download .plt</button>
            <button disabled={!cutJob.stones.length} onClick={() => download(`stonecut-${cutLayer}.svg`, toSVG(cutJob), 'image/svg+xml')}>SVG (Cricut)</button>
          </div>
        </Section>
      </aside>

      <main className="canvas-wrap" ref={wrapRef}
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom((z) => Math.min(30, Math.max(1.5, z * (e.deltaY < 0 ? 1.1 : 0.9)))) } }}>
        <div className="zoombar">
          <input type="range" min={1.5} max={30} step={0.5} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
          <span>{zoom.toFixed(1)} px/mm</span>
          <span style={{ marginLeft: 12 }}>Artboard</span>
          <input
            type="number"
            min={1}
            max={60}
            step={0.5}
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
          onMouseLeave={onCanvasUp}
          onDoubleClick={onCanvasDoubleClick}
        >
          <defs>
            <pattern id="grid" width={10 * zoom} height={10 * zoom} patternUnits="userSpaceOnUse">
              <path d={`M ${10 * zoom} 0 L 0 0 0 ${10 * zoom}`} fill="none" stroke="#2a2f3a" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
          {/* artboard: the physical sheet at true scale, ruled in inches */}
          <g pointerEvents="none">
            <rect
              x={0}
              y={0}
              width={boardWmm * zoom}
              height={boardHmm * zoom}
              fill="#ffffff"
              fillOpacity={0.035}
              stroke="#7789ad"
              strokeWidth={1.5}
            />
            {Array.from({ length: Math.max(0, Math.floor(boardWIn) - (Number.isInteger(boardWIn) ? 1 : 0)) }, (_, k) => k + 1).map((i) => (
              <g key={`v${i}`}>
                <line
                  x1={i * 25.4 * zoom}
                  y1={0}
                  x2={i * 25.4 * zoom}
                  y2={boardHmm * zoom}
                  stroke="#3d4863"
                  strokeWidth={1}
                />
                <text x={i * 25.4 * zoom + 3} y={12} fill="#8b97b5" fontSize={10}>{i}"</text>
              </g>
            ))}
            {Array.from({ length: Math.max(0, Math.floor(boardHIn) - (Number.isInteger(boardHIn) ? 1 : 0)) }, (_, k) => k + 1).map((i) => (
              <g key={`h${i}`}>
                <line
                  x1={0}
                  y1={i * 25.4 * zoom}
                  x2={boardWmm * zoom}
                  y2={i * 25.4 * zoom}
                  stroke="#3d4863"
                  strokeWidth={1}
                />
                <text x={3} y={i * 25.4 * zoom - 3} fill="#8b97b5" fontSize={10}>{i}"</text>
              </g>
            ))}
            <text x={boardWmm * zoom - 4} y={boardHmm * zoom - 6} fill="#7789ad" fontSize={11} textAnchor="end">
              {boardWIn}" × {boardHIn}"
            </text>
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
  )
}

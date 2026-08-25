import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type opentype from 'opentype.js'
import { DEFAULT_PRESETS, DEFAULT_SIZES } from './model'
import type { MaterialPreset, Stone, StoneSpec } from './model'
import { removeCollisions } from './geometry'
import { SpacingIndex, debugSpans, debugStones, fillStones, outlineOrSpine, rasterizeContours } from './fill'
import { loadFontFile, parseFontBuffer, textToContours } from './text'
import { imageToRaster } from './image'
import { download, toGPGL, toHPGL, toSVG } from './export'
import { sendToCutter } from './usb'
import './App.css'

type Tool = 'select' | 'add'
type StoneMode = 'outline' | 'fill' | 'both'

const MARGIN = 5 // mm margin around design in exports

// template-integrity floor (sticky flock ~0.5-1.2mm edge gap) regardless of
// how wide the design spacing is set
const hardGapOf = (spacing: number) => Math.max(0.5, Math.min(spacing, 1.2))

function Section({ title, defaultOpen = true, children }: {
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
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [sizes, setSizes] = useState<Record<string, StoneSpec>>(() => ({ ...DEFAULT_SIZES }))
  const [curSize, setCurSize] = useState('SS10')
  const [gap, setGap] = useState(0.8) // min edge-to-edge gap between holes, mm
  const [tool, setTool] = useState<Tool>('select')
  const [outlineStyle, setOutlineStyle] = useState<'auto' | 'walls' | 'centerline'>('auto')
  const [uniformRhythm, setUniformRhythm] = useState(true)
  const [zoom, setZoom] = useState(6) // px per mm
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
  useEffect(() => {
    fetch('/gfonts.json')
      .then((r) => r.json())
      .then(setGfonts)
      .catch(() => setStatus('Could not load Google Fonts catalog'))
  }, [])

  const loadGFont = useCallback(
    async (gf: GFont, w: 'bold' | 'regular') => {
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
  const fontMatches = useMemo(
    () =>
      gfonts.filter(
        (f) => (fontCat === 'all' || f.c === fontCat) && f.f.toLowerCase().includes(fontSearch.toLowerCase()),
      ),
    [gfonts, fontCat, fontSearch],
  )
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
  const [imgWidth, setImgWidth] = useState(100)
  const [imgThreshold, setImgThreshold] = useState(128)
  const [imgInvert, setImgInvert] = useState(false)
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
  const previewOffsetY = stones.length ? bbox.maxY + 10 : 10

  // live stone preview: settings changes (size, gap, style) re-stone the
  // preview automatically, debounced so typing stays smooth. Committing hides
  // the preview until something changes again — no duplicate on canvas.
  const [previewStones, setPreviewStones] = useState<{ x: number; y: number }[] | null>(null)
  const [previewLive, setPreviewLive] = useState(true)
  useEffect(() => {
    setPreviewLive(true)
  }, [textPreview, curSize, gap, sizes, textMode, outlineStyle, uniformRhythm])
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
        const pts: { x: number; y: number }[] = []
        const grid = rasterizeContours(textPreview.contours)
        const outline =
          textMode !== 'fill'
            ? outlineOrSpine(textPreview.contours, grid, hole, hardGap, idx, outlineStyle, true, rhythm, uniformRhythm)
            : []
        pts.push(...outline)
        if (textMode !== 'outline') {
          const inset = textMode === 'both' ? rhythm * 0.87 : hole / 2 + 0.1
          pts.push(...fillStones(grid, hole, hardGap, inset, idx, outline, rhythm))
        }
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
  }, [textPreview, curSize, gap, sizes, textMode, outlineStyle, uniformRhythm])

  // ---------- generation ----------
  const addGenerated = useCallback(
    (pts: { x: number; y: number }[], offsetY: number) => {
      const fresh: Stone[] = pts.map((p) => ({ x: p.x + 10, y: p.y + offsetY, size: curSize }))
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
    const pts: { x: number; y: number }[] = []
    const grid = rasterizeContours(contours)
    const outline = textMode !== 'fill' ? outlineOrSpine(contours, grid, hole, hardGap, idx, outlineStyle, true, rhythm, uniformRhythm) : []
    pts.push(...outline)
    if (textMode !== 'outline') {
      const inset = textMode === 'both' ? rhythm * 0.87 : hole / 2 + 0.1
      pts.push(...fillStones(grid, hole, hardGap, inset, idx, outline, rhythm))
    }
    const offsetY = stones.length ? bbox.maxY + 10 : 10
    addGenerated(pts, offsetY)
    setPreviewLive(false)
    setStatus(`Added ${pts.length} stones from text`)
  }, [font, text, textHeight, letterSpacing, textMode, curSize, gap, sizes, stones.length, bbox.maxY, addGenerated, uniformRhythm])

  const generateImage = useCallback(async () => {
    if (!imageFile) { setStatus('Choose an image first'); return }
    setStatus('Tracing image…')
    try {
      const raster = await imageToRaster(imageFile, imgWidth, imgThreshold, imgInvert)
      const hole = sizes[curSize]?.holeMm ?? 3
      const hardGap = hardGapOf(gap)
      const rhythm = hole + gap
      const idx = new SpacingIndex(hole + hardGap)
      const pts: { x: number; y: number }[] = []
      const outline = imgMode !== 'fill' ? outlineOrSpine(raster.contours, raster.grid, hole, hardGap, idx, outlineStyle, false, rhythm, uniformRhythm) : []
      pts.push(...outline)
      if (imgMode !== 'outline') {
        const inset = imgMode === 'both' ? rhythm * 0.87 : hole / 2 + 0.1
        pts.push(...fillStones(raster.grid, hole, hardGap, inset, idx, outline, rhythm))
      }
      const offsetY = stones.length ? bbox.maxY + 10 : 10
      addGenerated(pts, offsetY)
      setStatus(`Added ${pts.length} stones from image`)
    } catch (e) {
      setStatus(`Image failed: ${e instanceof Error ? e.message : e}`)
    }
  }, [imageFile, imgWidth, imgThreshold, imgInvert, imgMode, sizes, curSize, gap, stones.length, bbox.maxY, addGenerated, uniformRhythm])

  // ---------- canvas interactions ----------
  const svgRef = useRef<SVGSVGElement>(null)
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
      const hit = stones.findIndex((s) => Math.hypot(s.x - p.x, s.y - p.y) <= holeOf(s) / 2 + 0.5)
      if (tool === 'add') {
        if (hit === -1) mutate((prev) => [...prev, { x: p.x, y: p.y, size: curSize }])
        else mutate((prev) => prev.filter((_, i) => i !== hit)) // click existing stone in add mode = remove
        return
      }
      if (hit === -1) {
        if (!e.shiftKey) setSelection(new Set())
        return
      }
      setSelection((prev) => {
        const next = e.shiftKey ? new Set(prev) : prev.has(hit) ? new Set(prev) : new Set<number>()
        next.add(hit)
        return next
      })
      drag.current = { startX: p.x, startY: p.y, moved: false, orig: stones }
    },
    [toMm, stones, tool, curSize, holeOf, mutate],
  )

  const onCanvasMove = useCallback(
    (e: React.MouseEvent) => {
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

  const onCanvasUp = useCallback(() => { drag.current = null }, [])

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
  const cutData = useCallback(
    () => (format === 'gpgl' ? toGPGL(job, preset) : toHPGL(job, preset)),
    [format, job, preset],
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

  const sizeKeys = Object.keys(sizes)
  const stoneColor: Record<string, string> = {}
  sizeKeys.forEach((k, i) => { stoneColor[k] = `hsl(${(i * 47) % 360} 70% 60%)` })

  // workspace always fills the viewport; grows past it when the design does
  const previewW = previewLive && textPreview ? textPreview.widthMm + 30 : 0
  const previewH = previewLive && textPreview ? previewOffsetY + textHeight + 20 : 0
  const canvasW = Math.max(job.widthMm + 20, previewW, avail.w / zoom)
  const canvasH = Math.max(job.heightMm + 20, previewH, (avail.h - 36) / zoom)

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
        <div className="statusbar">{status} · {stones.length} stones · {job.widthMm}×{job.heightMm} mm</div>


        <Section title="Text">
          <label>Text<input value={text} onChange={(e) => setText(e.target.value)} /></label>
          <div className="fontpicker" ref={pickerRef}>
            <label>Font</label>
            <button className="fontbtn" onClick={() => setFontOpen((o) => !o)}>
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
                  {['all', 'display', 'sans-serif', 'serif', 'handwriting', 'monospace'].map((c) => (
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
                      </button>
                    ))
                  )}
                </div>
                <p className="hint">↑ ↓ browse fonts live on canvas · Enter / Esc to close</p>
                <label className="filebtn">Upload custom font (.ttf / .otf)
                  <input type="file" accept=".ttf,.otf,.woff" onChange={async (e) => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    try {
                      setFont(await loadFontFile(f)); setFontName(f.name); setSelFont(''); setFontOpen(false)
                      setStatus(`Font loaded: ${f.name}`)
                    } catch { setStatus('Could not parse that font') }
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
          <label>Size
            <select value={curSize} onChange={(e) => setCurSize(e.target.value)}>
              {sizeKeys.map((k) => (
                <option key={k} value={k}>{k} · hole {sizes[k].holeMm} mm</option>
              ))}
            </select>
          </label>
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
          <label>Outline style
            <select value={outlineStyle} onChange={(e) => setOutlineStyle(e.target.value as typeof outlineStyle)}>
              <option value="auto">Auto — follow font lines when they fit</option>
              <option value="walls">Always double (both walls)</option>
              <option value="centerline">Always single line</option>
            </select>
          </label>
          <button className="primary" onClick={generateText}>Add text stones</button>
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
          <label className="filebtn">{imageFile?.name || 'Choose image (PNG/JPG)'}
            <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
          </label>
          <button onClick={generateImage}>Add image stones</button>
        </Section>

        <Section title="Edit">
          <div className="toolrow">
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>Select / move</button>
            <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')}>Add / erase</button>
          </div>
          <div className="toolrow">
            <button disabled={!selection.size} onClick={() => {
              mutate((prev) => prev.map((s, i) => (selection.has(i) ? { ...s, size: curSize } : s)))
            }}>Set selected → {curSize}</button>
          </div>
          <div className="toolrow">
            <button disabled={!stones.length} onClick={() => { mutate(() => []); setSelection(new Set()) }}>Clear all</button>
          </div>
          <p className="hint">Click = select · shift-click = multi · drag = move · Del = delete · ⌘Z undo · ⌘A select all. In Add mode, clicking a stone erases it.</p>
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
          <button className="primary" disabled={!stones.length} onClick={doSend}>⚡ Cut on Graphtec</button>
          <div className="toolrow">
            <button disabled={!stones.length} onClick={() => download('stonecut.plt', cutData())}>Download .plt</button>
            <button disabled={!stones.length} onClick={() => download('stonecut.svg', toSVG(job), 'image/svg+xml')}>SVG (Cricut)</button>
          </div>
        </Section>
      </aside>

      <main className="canvas-wrap" ref={wrapRef}
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom((z) => Math.min(30, Math.max(1.5, z * (e.deltaY < 0 ? 1.1 : 0.9)))) } }}>
        <div className="zoombar">
          <input type="range" min={1.5} max={30} step={0.5} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
          <span>{zoom.toFixed(1)} px/mm</span>
        </div>
        <svg
          ref={svgRef}
          width={canvasW * zoom}
          height={canvasH * zoom}
          onMouseDown={onCanvasDown}
          onMouseMove={onCanvasMove}
          onMouseUp={onCanvasUp}
          onMouseLeave={onCanvasUp}
        >
          <defs>
            <pattern id="grid" width={10 * zoom} height={10 * zoom} patternUnits="userSpaceOnUse">
              <path d={`M ${10 * zoom} 0 L 0 0 0 ${10 * zoom}`} fill="none" stroke="#2a2f3a" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
          {previewLive && previewStones?.map((p, i) => (
            <circle
              key={`pv${i}`}
              cx={(p.x + 10) * zoom}
              cy={(p.y + previewOffsetY) * zoom}
              r={((sizes[curSize]?.holeMm ?? 3) / 2) * zoom}
              fill="#8fb0ff"
              fillOpacity={0.55}
              pointerEvents="none"
            />
          ))}
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
          {stones.map((s, i) => (
            <circle
              key={i}
              cx={s.x * zoom}
              cy={s.y * zoom}
              r={(holeOf(s) / 2) * zoom}
              fill={stoneColor[s.size] ?? '#8cf'}
              fillOpacity={0.85}
              stroke={selection.has(i) ? '#fff' : 'none'}
              strokeWidth={2}
            />
          ))}
        </svg>
      </main>
    </div>
  )
}

import type { Pt } from './model'
import { marchingSquares } from './fill'
import type { Grid } from './fill'
import { simplify } from './vector'

export interface RasterResult {
  contours: Pt[][] // outline contours in mm
  grid: Grid // binary shape grid for the fill engine
  widthMm: number
  heightMm: number
}

// Rasterize an image at working resolution, threshold to binary,
// trace outlines with marching squares. All output in mm.
// Erase connected components smaller than minPx: islands below the floor
// vanish, pinhole gaps inside strokes fill (except true background touching
// the border). Shared by the tracer and the analyzer's stroke statistics.
export function despeckleBin(bin: Uint8Array, w: number, h: number, minPx: number) {
  if (minPx <= 1) return
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const comp: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start]) continue
    const v = bin[start]
    seen[start] = 1
    stack.length = 0
    comp.length = 0
    stack.push(start)
    comp.push(start)
    let touchesBorder = false
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w, y = (i - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true
      if (x > 0 && !seen[i - 1] && bin[i - 1] === v) { seen[i - 1] = 1; stack.push(i - 1); comp.push(i - 1) }
      if (x < w - 1 && !seen[i + 1] && bin[i + 1] === v) { seen[i + 1] = 1; stack.push(i + 1); comp.push(i + 1) }
      if (y > 0 && !seen[i - w] && bin[i - w] === v) { seen[i - w] = 1; stack.push(i - w); comp.push(i - w) }
      if (y < h - 1 && !seen[i + w] && bin[i + w] === v) { seen[i + w] = 1; stack.push(i + w); comp.push(i + w) }
    }
    if (comp.length < minPx && !(v === 0 && touchesBorder))
      for (const i of comp) bin[i] = v ? 0 : 1
  }
}

export async function imageToRaster(
  file: File,
  widthMm: number,
  threshold: number, // 0-255, luminance below = "dark" (stone area)
  invert: boolean,
  alphaKey = false, // key on transparency instead of brightness
  lineworkOpen = false, // cartoon mode: near-black linework stays stone-free
  pxPerMm = 6, // previews pass a coarser grid — analysis passes scale with area
  minFeatureMm2 = 0, // despeckle floor: features smaller than this (mm²) are erased/filled
  closeMm = 0, // detail smoothing: closing radius in mm welds finer detail into its parent shape
  excludeRects?: { x0: number; y0: number; x1: number; y1: number }[], // fractions; zeroed before tracing (detected text handled by the Text tool)
): Promise<RasterResult> {
  const img = await loadImage(file)
  const w = Math.max(8, Math.round(widthMm * pxPerMm))
  const h = Math.max(8, Math.round((img.height / img.width) * w))
  if (w > 8192 || h > 8192 || w * h > 16_000_000) throw new Error('This image needs too much working memory. Reduce the design width or crop the image first.')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  // alpha keying needs the real alpha channel, so skip the white backdrop
  if (!alphaKey) {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3]
    let isDesign: boolean
    if (alphaKey) {
      // transparent-background art: the opaque pixels ARE the design,
      // whatever colour they are (white logos on transparent included)
      isDesign = a >= 64
    } else {
      const lum = a < 64 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b
      isDesign = lum < threshold
    }
    let final = invert ? !isDesign : isDesign
    // cartoon linework: the drawing's own dark lines stay OPEN, the way a
    // hand-set design uses gaps to draw knuckles, creases and folds —
    // filling over them turned an emoji into a blob
    if (lineworkOpen && final && a >= 64) {
      const lum2 = 0.299 * r + 0.587 * g + 0.114 * b
      if (lum2 < 70) final = false
    }
    bin[i] = final ? 1 : 0
  }
  if (excludeRects?.length)
    for (const r of excludeRects) {
      const x0 = Math.max(0, Math.floor(r.x0 * w)), x1 = Math.min(w, Math.ceil(r.x1 * w))
      const y0 = Math.max(0, Math.floor(r.y0 * h)), y1 = Math.min(h, Math.ceil(r.y1 * h))
      for (let y = y0; y < y1; y++) bin.fill(0, y * w + x0, y * w + x1)
    }
  // Excluding the linework exposes its ANTI-ALIASED halo: the 1-2px blend
  // between a black contour and the background reads as midtone "design"
  // and outline stones scatter along the ghost ring. A one-pixel opening
  // (erode then dilate) removes anything under a couple of pixels thick;
  // real strokes shrink an edge pixel and grow it right back.
  if (lineworkOpen) {
    const er = new Uint8Array(w * h)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        er[i] = bin[i] && bin[i - 1] && bin[i + 1] && bin[i - w] && bin[i + w] ? 1 : 0
      }
    bin.fill(0)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        if (er[i] || er[i - 1] || er[i + 1] || er[i - w] || er[i + w]) bin[i] = 1
      }
  }
  // DETAIL SMOOTHING (morphological closing): fur hatching and whisker
  // wedges are dozens of sub-rhythm islands — dropping them loses the mane,
  // stoning them scatters fragments. Closing (dilate then erode) WELDS
  // detail finer than the radius into its parent shape, so the mane
  // becomes one solid region whose wavy edge the rows can follow. The
  // radius is pitch-relative and small enough to leave letter counters
  // open.
  if (closeMm > 0) {
    const k = Math.max(1, Math.round(closeMm * pxPerMm))
    const pass = (src: Uint8Array, horiz: boolean, dilate: boolean) => {
      const out = new Uint8Array(n2)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x
          let v = dilate ? 0 : 1
          for (let d = -k; d <= k; d++) {
            const xx = horiz ? x + d : x
            const yy = horiz ? y : y + d
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) { if (!dilate) { v = 0; break } continue }
            const s = src[yy * w + xx]
            if (dilate ? s : !s) { v = dilate ? 1 : 0; break }
          }
          out[i] = v
        }
      return out
    }
    const n2 = w * h
    let b = pass(bin, true, true)
    b = pass(b, false, true)
    b = pass(b, true, false)
    b = pass(b, false, false)
    bin.set(b)
  }

  // DESPECKLE: detailed mascot art (fur spikes, whisker hatching) is full
  // of features far smaller than a stone — tracing them scatters orphan
  // stones across the design (the coherence law: refuse rather than fake).
  if (minFeatureMm2 > 0)
    despeckleBin(bin, w, h, Math.max(2, Math.round(minFeatureMm2 * pxPerMm * pxPerMm)))

  // PHOTO GUARD, before any contour tracing: a thresholded photograph is
  // speckle — binary transition density ~0.3/px vs ~0.01/px for line art —
  // and marching squares + the outline engine on speckle froze the tab for
  // minutes. Refuse with advice instead of tracing.
  let flips = 0
  for (let y = 0; y < h; y++)
    for (let x = 1; x < w; x++) {
      const i = y * w + x
      if (bin[i] !== bin[i - 1]) flips++
    }
  if (flips > w * h * 0.08)
    throw new Error('this reads as a photograph (speckle after thresholding) — use Multi-color trace, or adjust Threshold / Invert until the subject is one solid shape')
  const s = 1 / pxPerMm
  return {
    contours: marchingSquares(bin, w, h).map((c) => c.map((p) => ({ x: p.x * s, y: p.y * s }))),
    grid: { bin, w, h, pxPerMm, padPx: 0 },
    widthMm: w * s,
    heightMm: h * s,
  }
}

// ---------------------------------------------------------------------------
// Image -> COLOR LAYERS (multi-color trace). K-means over the artwork's
// non-background pixels reduces it to k colour regions; each region comes
// back as its own contours + grid so the stone engine can run per colour.
// ---------------------------------------------------------------------------

export interface ColorLayer {
  color: string // '#rrggbb' centroid of the region
  contours: Pt[][] // mm
  grid: Grid
  share: number // fraction of design pixels in this layer
}

const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

export async function imageToColorLayers(
  file: File,
  widthMm: number,
  k: number,
  pxPerMm = 6,
): Promise<{ layers: ColorLayer[]; widthMm: number; heightMm: number }> {
  const img = await loadImage(file)
  const w = Math.max(8, Math.round(widthMm * pxPerMm))
  const h = Math.max(8, Math.round((img.height / img.width) * w))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const n = w * h

  // Background: transparency when the file has it, else whatever colour the
  // border ring is — the design is everything meaningfully different.
  let transparent = 0
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 64) transparent++
  const alphaBg = transparent / n > 0.05
  let bgR = 255, bgG = 255, bgB = 255
  if (!alphaBg) {
    let sr = 0, sg = 0, sb = 0, c = 0
    const take = (i: number) => { sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2]; c++ }
    for (let x = 0; x < w; x++) { take(x); take((h - 1) * w + x) }
    for (let y = 0; y < h; y++) { take(y * w); take(y * w + w - 1) }
    bgR = sr / c; bgG = sg / c; bgB = sb / c
  }
  const isBg = (i: number): boolean => {
    if (data[i * 4 + 3] < 64) return true
    if (alphaBg) return false
    const dr = data[i * 4] - bgR, dg = data[i * 4 + 1] - bgG, db = data[i * 4 + 2] - bgB
    return dr * dr + dg * dg + db * db < 40 * 40
  }
  const design: number[] = []
  for (let i = 0; i < n; i++) if (!isBg(i)) design.push(i)
  if (!design.length) throw new Error('No artwork found — the whole image reads as background')

  // k-means in RGB, seeded from a coarse colour HISTOGRAM. Plain farthest-
  // point seeding handed a seed to the rare anti-aliased halo pixels between
  // the artwork and the background (outliers always win max-min-distance),
  // which stole a cluster from a real colour. Weighting candidate bins by
  // population x distance^2 makes a big genuine colour beat a rare halo.
  const px = (i: number): [number, number, number] => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]
  const d2 = (a: [number, number, number], b: [number, number, number]) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (const i of design) {
    const key = ((data[i * 4] >> 4) << 8) | ((data[i * 4 + 1] >> 4) << 4) | (data[i * 4 + 2] >> 4)
    const bn = bins.get(key)
    if (bn) { bn.n++; bn.r += data[i * 4]; bn.g += data[i * 4 + 1]; bn.b += data[i * 4 + 2] }
    else bins.set(key, { n: 1, r: data[i * 4], g: data[i * 4 + 1], b: data[i * 4 + 2] })
  }
  const binC = [...bins.values()].map((b) => ({ n: b.n, c: [b.r / b.n, b.g / b.n, b.b / b.n] as [number, number, number] }))
  const seeds: [number, number, number][] = []
  {
    const bg: [number, number, number] = [bgR, bgG, bgB]
    while (seeds.length < k) {
      let best: [number, number, number] | null = null
      let bestScore = 0
      for (const b of binC) {
        let md = seeds.length ? Infinity : d2(b.c, bg)
        for (const s of seeds) md = Math.min(md, d2(b.c, s))
        if (md < 24 * 24) continue // too close to an existing seed / the bg
        const score = b.n * md
        if (score > bestScore) { bestScore = score; best = b.c }
      }
      if (!best) break // image has fewer distinct colours than k
      seeds.push(best)
    }
    if (!seeds.length) seeds.push(px(design[0]))
  }
  const kk = seeds.length
  const cent = seeds.map((s) => [...s] as [number, number, number])
  const label = new Int16Array(n).fill(-1)
  for (let iter = 0; iter < 12; iter++) {
    const sum = cent.map(() => [0, 0, 0, 0])
    for (const i of design) {
      const p = px(i)
      let bi = 0, bd = Infinity
      for (let c = 0; c < kk; c++) { const dd = d2(p, cent[c]); if (dd < bd) { bd = dd; bi = c } }
      label[i] = bi
      const s = sum[bi]
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++
    }
    let moved = false
    for (let c = 0; c < kk; c++) {
      if (!sum[c][3]) continue
      const nx: [number, number, number] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]]
      if (d2(nx, cent[c]) > 1) moved = true
      cent[c] = nx
    }
    if (!moved) break
  }
  // merge centroids that converged to near-identical colours
  const remap = new Int16Array(kk)
  const kept: number[] = []
  for (let c = 0; c < kk; c++) {
    let hit = -1
    for (const o of kept) if (d2(cent[c], cent[o]) < 30 * 30) { hit = o; break }
    remap[c] = hit >= 0 ? remap[hit] : kept.length
    if (hit < 0) kept.push(c)
  }
  for (const i of design) label[i] = remap[label[i]]
  const m = kept.length

  // one 3x3 majority pass: anti-aliased boundary pixels stop speckling
  // between neighbouring colour regions
  const smoothed = new Int16Array(label)
  const votes = new Int16Array(m + 1)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (label[i] < 0) continue
      votes.fill(0)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const l = label[i + dy * w + dx]
          if (l >= 0) votes[l]++
        }
      let bi = label[i], bv = -1
      for (let c = 0; c < m; c++) if (votes[c] > bv) { bv = votes[c]; bi = c }
      smoothed[i] = bi
    }

  const s = 1 / pxPerMm
  const layers: ColorLayer[] = []
  for (let c = 0; c < m; c++) {
    const bin = new Uint8Array(n)
    let count = 0
    for (let i = 0; i < n; i++) if (smoothed[i] === c) { bin[i] = 1; count++ }
    if (count < design.length * 0.005) continue // specks, not a colour region
    // same speckle guard as imageToRaster: an incoherent cluster (pure
    // noise) would hang marching squares — skip it rather than trace it
    let flips = 0
    for (let y = 0; y < h; y++)
      for (let x = 1; x < w; x++) {
        const i = y * w + x
        if (bin[i] !== bin[i - 1]) flips++
      }
    if (flips > n * 0.08) continue
    const src = cent[kept[c]]
    // drop halo-speck rings: boundary anti-aliasing shows up as dozens of
    // sub-mm contours that would scatter stray stones along every edge
    const contours = marchingSquares(bin, w, h)
      .map((pl) => pl.map((p) => ({ x: p.x * s, y: p.y * s })))
      .filter((pl) => ringArea(pl) >= 1)
    if (!contours.length) continue
    layers.push({
      color: toHex(src[0], src[1], src[2]),
      contours,
      grid: { bin, w, h, pxPerMm, padPx: 0 },
      share: count / design.length,
    })
  }
  layers.sort((a, b) => b.share - a.share)
  return { layers, widthMm: w * s, heightMm: h * s }
}

// ---------------------------------------------------------------------------
// Image -> CUT LINES (Inkscape's Trace Bitmap). The marching-squares contours
// follow pixel edges, so raw they cut as a staircase. Chaikin corner-cutting
// rounds the steps into the curve the artwork meant, then RDP thins the
// result to segments the blade can't tell from the original.
// ---------------------------------------------------------------------------

const ringArea = (c: Pt[]): number => {
  let a = 0
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a / 2)
}

// Chaikin corner cutting on a closed ring: each pass replaces every vertex
// with two points at 1/4 and 3/4 of its edges — staircase corners melt into
// the circle/curve they were sampling.
function chaikinClosed(pts: Pt[], iters: number): Pt[] {
  let p = pts
  // work on the ring without a duplicated endpoint
  if (p.length > 2 && Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) < 1e-6) p = p.slice(0, -1)
  for (let k = 0; k < iters; k++) {
    const out: Pt[] = []
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length]
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
    }
    p = out
  }
  return p
}

// Trace an image into cuttable vector contours (mm, closed rings).
// Specks under minAreaMm2 are dropped — threshold noise, not artwork.
export async function imageToCutContours(
  file: File,
  widthMm: number,
  threshold: number,
  invert: boolean,
  alphaKey = false,
  lineworkOpen = false,
  minAreaMm2 = 0.8,
): Promise<Pt[][]> {
  // trace finer than the stone pipeline needs: cut lines show every step
  // cut lines can hold finer detail than stones — only kill AA specks
  const raster = await imageToRaster(file, widthMm, threshold, invert, alphaKey, lineworkOpen, 8, 1)
  if (raster.contours.length > 600)
    throw new Error(`traces to ${raster.contours.length} regions — this reads as a photo; adjust Threshold until the subject is solid`)
  return raster.contours
    .filter((c) => c.length >= 3 && ringArea(c) >= minAreaMm2)
    .map((c) => simplify(chaikinClosed(c, 2), 0.08))
    .filter((c) => c.length >= 3)
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    // rejecting with the raw event printed as "[object Event]" — name the
    // actual problem. HEIC (iPhone photos) is the common case: it passes
    // the image/* picker filter but Chrome cannot decode it.
    img.onerror = () => {
      URL.revokeObjectURL(url)
      const heic = /\.hei[cf]$/i.test(file.name) || /hei[cf]/i.test(file.type)
      reject(
        new Error(
          heic
            ? `${file.name} is an iPhone HEIC photo — Chrome can't decode it. Export it as PNG or JPG first.`
            : `couldn't decode ${file.name}${file.type ? ` (${file.type})` : ''} — use PNG, JPG, or SVG.`,
        ),
      )
    }
    img.src = url
  })
}

export interface ImageAnalysis {
  threshold: number
  invert: boolean
  alphaKey: boolean
  linework: boolean // recommend keeping dark linework open (cartoon art)
  note: string
  strokePx: number // typical (p90) stroke width of the design, in sample px
  strokeDeciles: number[] // width deciles (p10..p90), sample px — art-type classification
  strokeMax: number // p96 stroke width, sample px
  blobby: boolean // a real solid blob exists (fill is wanted) — see hasBlob
  sampleW: number // sample bitmap width the strokePx was measured at
  closeGain: number // fraction of design pixels ADDED by a pitch-scaled closing — fur/hatching fingerprint
  closeMerge: number // fraction of components LOST to that closing — letter-bridging fingerprint
}

// How much would Bold's closing change this art? Run the same closing at
// 0.45x pitch on the analysis sample and measure pixels gained relative
// to the design. Fur hatching welds shut (big gain); text and solid
// logos are untouched (near zero). Measuring the operation itself beats
// guessing from stroke statistics — fur wedges are ATTACHED to the
// outline, so island-counting and decile spread both failed to separate
// mascot art from serif text.
function countComponents(bin: Uint8Array, w: number, h: number, minPx = 4): number {
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  let n = 0
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!bin[s0] || seen[s0]) continue
    let area = 0
    stack.length = 0
    stack.push(s0)
    seen[s0] = 1
    while (stack.length) {
      const i = stack.pop()!
      area++
      const x = i % w, y = (i - x) / w
      if (x > 0 && bin[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1) }
      if (x < w - 1 && bin[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1) }
      if (y > 0 && bin[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w) }
      if (y < h - 1 && bin[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w) }
    }
    if (area >= minPx) n++
  }
  return n
}

function closingGain(bin: Uint8Array, w: number, h: number, k: number): { gain: number; merge: number } {
  if (k < 1) return { gain: 0, merge: 0 }
  const pass = (src: Uint8Array, horiz: boolean, dilate: boolean) => {
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        let v = dilate ? 0 : 1
        for (let d = -k; d <= k; d++) {
          const xx = horiz ? x + d : x
          const yy = horiz ? y : y + d
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) { if (!dilate) { v = 0; break } continue }
          const s = src[yy * w + xx]
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break }
        }
        out[i] = v
      }
    return out
  }
  let b = pass(bin, true, true)
  b = pass(b, false, true)
  b = pass(b, true, false)
  b = pass(b, false, false)
  let before = 0, gained = 0
  for (let i = 0; i < w * h; i++) { if (bin[i]) before++; else if (b[i]) gained++ }
  const c0 = countComponents(bin, w, h)
  const c1 = countComponents(b, w, h)
  return {
    gain: before ? gained / before : 0,
    merge: c0 > 1 ? Math.max(0, (c0 - c1) / c0) : 0,
  }
}

// Typical stroke width of the design under the chosen settings: p90 of the
// distance-to-edge over design pixels, doubled. Line art measures a few px;
// solid shapes measure large. The caller scales by its output width to decide
// whether strokes can hold two wall rows or need a single centreline.
function strokeStats(
  w: number,
  h: number,
  isDesign: (i: number) => boolean,
): { strokePx: number; strokeDeciles: number[]; strokeMax: number; bin: Uint8Array; dt: Float32Array } {
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bin[i] = isDesign(i) ? 1 : 0
  // kill checkerboard/anti-aliasing speckle before measuring: fake-
  // transparency art shredded the mask and the speckle's 1-2px "strokes"
  // dominated every decile (median stroke read as noise width)
  despeckleBin(bin, w, h, 9)
  // two-pass 3-4 chamfer distance transform (Euclidean to ~5%) — city block
  // over-read diagonal strokes by up to 1.4x and misclassified round art
  const INF = 1e9
  const dt = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!bin[i]) { dt[i] = 0; continue }
      dt[i] = INF
      if (x > 0) dt[i] = Math.min(dt[i], dt[i - 1] + 3)
      if (y > 0) dt[i] = Math.min(dt[i], dt[i - w] + 3)
      if (x > 0 && y > 0) dt[i] = Math.min(dt[i], dt[i - w - 1] + 4)
      if (x < w - 1 && y > 0) dt[i] = Math.min(dt[i], dt[i - w + 1] + 4)
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!bin[i]) continue
      if (x < w - 1) dt[i] = Math.min(dt[i], dt[i + 1] + 3)
      if (y < h - 1) dt[i] = Math.min(dt[i], dt[i + w] + 3)
      if (x < w - 1 && y < h - 1) dt[i] = Math.min(dt[i], dt[i + w + 1] + 4)
      if (x > 0 && y < h - 1) dt[i] = Math.min(dt[i], dt[i + w - 1] + 4)
    }
  for (let i = 0; i < w * h; i++) dt[i] /= 3
  const ds: number[] = []
  for (let i = 0; i < w * h; i++) if (bin[i]) ds.push(dt[i])
  if (!ds.length) return { strokePx: 0, strokeDeciles: [], strokeMax: 0, bin, dt }
  ds.sort((a, b) => a - b)
  const deciles: number[] = []
  for (let q = 1; q <= 9; q++) deciles.push(ds[Math.floor(ds.length * (q / 10))] * 2)
  return {
    strokePx: ds[Math.floor(ds.length * 0.9)] * 2,
    strokeDeciles: deciles,
    strokeMax: ds[Math.floor(ds.length * 0.96)] * 2,
    bin,
    dt,
  }
}

// Does the artwork contain a real solid BLOB (a note head, a mascot body) as
// opposed to junction bulges of a stroke network? Three tests together — no
// single one separates a basketball from beamed notes:
//   compact  — the wide-core fills its inscribed circle (a head ≈ 1+, a
//              junction sprawl ≈ 0.25)
//   ratio    — core width dwarfs the typical stroke (heads on hairline stems)
//   area     — big enough to mean anything
function hasBlob(
  bin: Uint8Array,
  dt: Float32Array,
  w: number,
  h: number,
  mmPerPx: number,
  pitchMm: number,
  p50WidthMm: number,
): boolean {
  const thr = pitchMm / mmPerPx // half-width ≥ pitch/2·2 = width ≥ 2·pitch? no: dt ≥ pitch → width ≥ 2·pitch
  const core = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) core[i] = bin[i] && dt[i] >= thr / 2 ? 1 : 0
  const lbl = new Int32Array(w * h)
  let c = 0
  const stack: number[] = []
  for (let seed = 0; seed < w * h; seed++) {
    if (!core[seed] || lbl[seed]) continue
    c++
    let area = 0
    let maxD = 0
    stack.push(seed)
    lbl[seed] = c
    while (stack.length) {
      const j = stack.pop() as number
      area++
      if (dt[j] > maxD) maxD = dt[j]
      const x = j % w
      const y = (j - x) / w
      if (x > 0 && core[j - 1] && !lbl[j - 1]) { lbl[j - 1] = c; stack.push(j - 1) }
      if (x < w - 1 && core[j + 1] && !lbl[j + 1]) { lbl[j + 1] = c; stack.push(j + 1) }
      if (y > 0 && core[j - w] && !lbl[j - w]) { lbl[j - w] = c; stack.push(j - w) }
      if (y < h - 1 && core[j + w] && !lbl[j + w]) { lbl[j + w] = c; stack.push(j + w) }
    }
    const areaMm2 = area * mmPerPx * mmPerPx
    const maxHalfMm = maxD * mmPerPx
    const compact = area / (Math.PI * maxD * maxD)
    const ratio = (2 * maxHalfMm) / Math.max(p50WidthMm, 0.5)
    if (areaMm2 >= 55 && compact >= 0.55 && ratio >= 2.5 && maxHalfMm >= pitchMm * 0.9)
      return true
  }
  return false
}

// Cartoon-art test: a SMALL share of near-black pixels inside a mostly
// midtone design means the dark pixels are LINEWORK (knuckle lines, folds)
// that should stay open. A large share means dark IS the art (a black
// logo) and must keep its stones.
function lineworkShare(
  data: Uint8ClampedArray,
  n: number,
  isDesign: (i: number) => boolean,
): number {
  let design = 0
  let dark = 0
  for (let i = 0; i < n; i++) {
    if (!isDesign(i)) continue
    design++
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    if (lum < 70) dark++
  }
  return design ? dark / design : 0
}

/**
 * Inspect an image and choose settings that make its subject the design.
 * Handles the three cases that otherwise silently produce zero stones:
 * transparent-background art (key on alpha), light-on-dark art (invert),
 * and low-contrast art (Otsu threshold instead of a fixed 128).
 */
export async function analyzeImage(
  file: File,
  imgWidthMm = 100,
  pitchMm = 4.2,
): Promise<ImageAnalysis> {
  const img = await loadImage(file)
  const w = Math.min(256, Math.max(16, img.width))
  const h = Math.max(16, Math.round((img.height / img.width) * w))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data

  let transparent = 0
  const hist = new Array(256).fill(0)
  const lumOf = (i: number) =>
    0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  const withBlobby = (st: ReturnType<typeof strokeStats>) => {
    const mmPerPx = imgWidthMm / w
    const p50 = ((st.strokeDeciles[4] ?? st.strokePx) * mmPerPx) || 0
    const cg = closingGain(st.bin, w, h, Math.round((0.45 * pitchMm) / mmPerPx))
    return {
      ...st,
      blobby: hasBlob(st.bin, st.dt, w, h, mmPerPx, pitchMm, p50),
      closeGain: cg.gain,
      closeMerge: cg.merge,
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 64) transparent++
    else hist[Math.round(lumOf(i))]++
  }
  const total = w * h
  if (transparent / total > 0.05) {
    // Alpha keying treats EVERY opaque pixel as design, whatever its colour —
    // which swallows white interior details (a white inner circle inside a
    // black badge simply disappears, so it can never be outlined). Dark art
    // renders fine on the white backdrop, where those light details read as
    // background and their contours get stones. Reserve alpha keying for
    // predominantly LIGHT art, which a white backdrop would erase.
    let lightOpaque = 0
    let opaqueN = 0
    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] < 64) continue
      opaqueN++
      if (lumOf(i) > 170) lightOpaque++
    }
    const mostlyDark = opaqueN > 0 && lightOpaque / opaqueN < 0.5
    const share = lineworkShare(data, total, (i) => data[i * 4 + 3] >= 64)
    const linework = share >= 0.02 && share <= 0.35
    if (mostlyDark) {
      return {
        threshold: 170,
        invert: false,
        alphaKey: false,
        linework,
        ...withBlobby(strokeStats(w, h, (i) => data[i * 4 + 3] >= 64 && lumOf(i) < 170)),
        sampleW: w,
        note:
          'transparent background, dark artwork — light details kept as open background' +
          (linework ? ' · dark linework kept open' : ''),
      }
    }
    return {
      threshold: 128,
      invert: false,
      alphaKey: true,
      linework,
      ...withBlobby(strokeStats(w, h, (i) => data[i * 4 + 3] >= 64)),
      sampleW: w,
      note:
        'transparent background — using the opaque artwork as the design' +
        (linework ? ' · dark linework kept open' : ''),
    }
  }

  // Otsu: pick the luminance split with maximum between-class variance
  const opaque = total - transparent
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = opaque - wB
    if (!wF) break
    sumB += t * hist[t]
    const between = (wB * wF) * ((sumB / wB - (sum - sumB) / wF) ** 2)
    if (between > best) {
      best = between
      threshold = t
    }
  }

  // Which side is the background? Sample the border ring — the design is
  // whatever the border ISN'T.
  const borderVals: number[] = []
  for (let x = 0; x < w; x++) { borderVals.push(lumOf(x), lumOf((h - 1) * w + x)) }
  for (let y = 0; y < h; y++) { borderVals.push(lumOf(y * w), lumOf(y * w + w - 1)) }
  borderVals.sort((a, b) => a - b)
  const borderLum = borderVals.reduce((t, v) => t + v, 0) / borderVals.length
  // The threshold must clear the background's EXTREME, not its mean: a
  // fake-transparency checkerboard's darkest tiles sit ~30 below its mean,
  // and a mean-based threshold landed mid-checker — marginal tiles flipped
  // to design speckle that Detail welding then smeared into sheets.
  const borderLo = borderVals[Math.floor(borderVals.length * 0.03)]
  const borderHi = borderVals[Math.floor(borderVals.length * 0.97)]
  const borderIsDark = borderLum < threshold
  // The design is everything meaningfully different from the BACKGROUND,
  // not one side of an Otsu split among the artwork's own tones. On a
  // white-background emoji, Otsu split the dark outline strokes from
  // everything else (threshold 47) and traced a hairline ring instead of
  // the solid numerals. Pull the threshold toward the background so all
  // midtones join the design.
  if (borderIsDark) {
    threshold = Math.min(threshold, Math.max(10, Math.round(borderLum) + 25))
    // ...but never below the background's brightest tile
    threshold = Math.max(threshold, Math.min(245, Math.round(borderHi) + 25))
  } else {
    threshold = Math.max(threshold, Math.min(245, Math.round(borderLum) - 25))
    // ...but never above the background's darkest tile
    threshold = Math.min(threshold, Math.max(10, Math.round(borderLo) - 25))
  }
  const share = borderIsDark
    ? 0 // inverted art: dark is the background, linework logic doesn't apply
    : lineworkShare(data, total, (i) => {
        if (data[i * 4 + 3] < 64) return false
        return 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2] < threshold
      })
  const linework = share >= 0.02 && share <= 0.35
  return {
    threshold,
    invert: borderIsDark,
    alphaKey: false,
    linework,
    ...withBlobby(strokeStats(w, h, (i) => {
      if (data[i * 4 + 3] < 64) return false
      return borderIsDark ? lumOf(i) >= threshold : lumOf(i) < threshold
    })),
    sampleW: w,
    note:
      (borderIsDark
        ? `light artwork on a dark background — inverted, threshold ${threshold}`
        : `threshold ${threshold}`) + (linework ? ' · dark linework kept open' : ''),
  }
}

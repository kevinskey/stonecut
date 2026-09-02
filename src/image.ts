import type { Pt } from './model'
import { marchingSquares } from './fill'
import type { Grid } from './fill'

export interface RasterResult {
  contours: Pt[][] // outline contours in mm
  grid: Grid // binary shape grid for the fill engine
  widthMm: number
  heightMm: number
}

// Rasterize an image at working resolution, threshold to binary,
// trace outlines with marching squares. All output in mm.
export async function imageToRaster(
  file: File,
  widthMm: number,
  threshold: number, // 0-255, luminance below = "dark" (stone area)
  invert: boolean,
  alphaKey = false, // key on transparency instead of brightness
  lineworkOpen = false, // cartoon mode: near-black linework stays stone-free
  pxPerMm = 6, // previews pass a coarser grid — analysis passes scale with area
): Promise<RasterResult> {
  const img = await loadImage(file)
  const w = Math.max(8, Math.round(widthMm * pxPerMm))
  const h = Math.max(8, Math.round((img.height / img.width) * w))
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
  const s = 1 / pxPerMm
  return {
    contours: marchingSquares(bin, w, h).map((c) => c.map((p) => ({ x: p.x * s, y: p.y * s }))),
    grid: { bin, w, h, pxPerMm, padPx: 0 },
    widthMm: w * s,
    heightMm: h * s,
  }
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
    return { ...st, blobby: hasBlob(st.bin, st.dt, w, h, mmPerPx, pitchMm, p50) }
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
  let borderSum = 0
  let borderN = 0
  for (let x = 0; x < w; x++)
    for (const y of [0, h - 1]) {
      borderSum += lumOf(y * w + x)
      borderN++
    }
  for (let y = 0; y < h; y++)
    for (const x of [0, w - 1]) {
      borderSum += lumOf(y * w + x)
      borderN++
    }
  const borderLum = borderSum / borderN
  const borderIsDark = borderLum < threshold
  // The design is everything meaningfully different from the BACKGROUND,
  // not one side of an Otsu split among the artwork's own tones. On a
  // white-background emoji, Otsu split the dark outline strokes from
  // everything else (threshold 47) and traced a hairline ring instead of
  // the solid numerals. Pull the threshold toward the background so all
  // midtones join the design.
  if (borderIsDark) threshold = Math.min(threshold, Math.max(10, Math.round(borderLum) + 25))
  else threshold = Math.max(threshold, Math.min(245, Math.round(borderLum) - 25))
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

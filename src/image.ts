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
): Promise<RasterResult> {
  const img = await loadImage(file)
  const pxPerMm = 6
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
    bin[i] = (invert ? !isDesign : isDesign) ? 1 : 0
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
    img.onerror = reject
    img.src = url
  })
}

export interface ImageAnalysis {
  threshold: number
  invert: boolean
  alphaKey: boolean
  note: string
}

/**
 * Inspect an image and choose settings that make its subject the design.
 * Handles the three cases that otherwise silently produce zero stones:
 * transparent-background art (key on alpha), light-on-dark art (invert),
 * and low-contrast art (Otsu threshold instead of a fixed 128).
 */
export async function analyzeImage(file: File): Promise<ImageAnalysis> {
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
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 64) transparent++
    else hist[Math.round(lumOf(i))]++
  }
  const total = w * h
  if (transparent / total > 0.05) {
    return {
      threshold: 128,
      invert: false,
      alphaKey: true,
      note: 'transparent background — using the opaque artwork as the design',
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
  const borderIsDark = borderSum / borderN < threshold
  return {
    threshold,
    invert: borderIsDark,
    alphaKey: false,
    note: borderIsDark
      ? `light artwork on a dark background — inverted, threshold ${threshold}`
      : `threshold ${threshold}`,
  }
}

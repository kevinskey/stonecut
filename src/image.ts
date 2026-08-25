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
): Promise<RasterResult> {
  const img = await loadImage(file)
  const pxPerMm = 6
  const w = Math.max(8, Math.round(widthMm * pxPerMm))
  const h = Math.max(8, Math.round((img.height / img.width) * w))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3]
    const lum = a < 64 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b
    const dark = lum < threshold
    bin[i] = (invert ? !dark : dark) ? 1 : 0
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

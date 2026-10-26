// Sparkle rendering: stones drawn as faceted rhinestones instead of flat
// dots. Each (colour, radius) pair renders ONCE into an offscreen sprite
// and is stamped with drawImage — a 5000-stone design costs 5000 blits,
// not 5000 gradient builds.

const cache = new Map<string, HTMLCanvasElement>()

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function shade(hex: string, f: number): string {
  // f > 0 lightens toward white, f < 0 darkens toward black
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const t = f > 0 ? 255 : 0
  const k = Math.abs(f)
  return `rgb(${clamp255(r + (t - r) * k)},${clamp255(g + (t - g) * k)},${clamp255(b + (t - b) * k)})`
}

export function gemSprite(color: string, rPx: number): HTMLCanvasElement {
  const r = Math.max(1.5, rPx)
  const key = `${color}|${r.toFixed(1)}`
  const hit = cache.get(key)
  if (hit) return hit
  if (cache.size > 400) cache.clear() // zoom churn: don't hoard old radii
  const pad = 2
  const S = Math.ceil(r * 2 + pad * 2)
  const cv = document.createElement('canvas')
  cv.width = S
  cv.height = S
  const ctx = cv.getContext('2d')!
  const c = S / 2
  // body: light core -> saturated colour -> dark rim
  const g = ctx.createRadialGradient(c - r * 0.25, c - r * 0.3, r * 0.1, c, c, r)
  g.addColorStop(0, shade(color, 0.75))
  g.addColorStop(0.35, shade(color, 0.25))
  g.addColorStop(0.8, color)
  g.addColorStop(1, shade(color, -0.45))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(c, c, r, 0, Math.PI * 2)
  ctx.fill()
  // table facets: alternating translucent wedges read as cut glass
  if (r >= 3) {
    for (let i = 0; i < 12; i++) {
      if (i % 2) continue
      const a0 = (i / 12) * Math.PI * 2 + 0.26
      const a1 = ((i + 1) / 12) * Math.PI * 2 + 0.26
      ctx.beginPath()
      ctx.moveTo(c, c)
      ctx.arc(c, c, r * 0.96, a0, a1)
      ctx.closePath()
      ctx.fillStyle = i % 4 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'
      ctx.fill()
    }
    // inner table edge
    ctx.beginPath()
    ctx.arc(c, c, r * 0.55, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = Math.max(0.5, r * 0.06)
    ctx.stroke()
  }
  // specular highlight
  const hx = c - r * 0.38, hy = c - r * 0.42
  const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 0.5)
  hg.addColorStop(0, 'rgba(255,255,255,0.95)')
  hg.addColorStop(0.35, 'rgba(255,255,255,0.35)')
  hg.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = hg
  ctx.beginPath()
  ctx.arc(hx, hy, r * 0.5, 0, Math.PI * 2)
  ctx.fill()
  // star glint on stones big enough to carry it
  if (r >= 5) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = Math.max(0.6, r * 0.07)
    ctx.beginPath()
    ctx.moveTo(hx - r * 0.42, hy)
    ctx.lineTo(hx + r * 0.42, hy)
    ctx.moveTo(hx, hy - r * 0.42)
    ctx.lineTo(hx, hy + r * 0.42)
    ctx.stroke()
  }
  cache.set(key, cv)
  return cv
}

export function drawGem(ctx: CanvasRenderingContext2D, x: number, y: number, rPx: number, color: string, alpha = 1) {
  const sp = gemSprite(color, rPx)
  ctx.globalAlpha = alpha
  ctx.drawImage(sp, x - sp.width / 2, y - sp.height / 2)
  ctx.globalAlpha = 1
}

// A stone catching the light: soft bloom + 4-point star flash. At garment
// scale each stone is a couple of pixels — THIS is what reads as "shiny",
// not the facets.
export function drawGlint(ctx: CanvasRenderingContext2D, x: number, y: number, len: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, len)
  g.addColorStop(0, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.30)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, len, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = Math.max(0.6, len * 0.09)
  ctx.beginPath()
  ctx.moveTo(x - len, y)
  ctx.lineTo(x + len, y)
  ctx.moveTo(x, y - len)
  ctx.lineTo(x, y + len)
  ctx.stroke()
  const d = len * 0.45
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.lineWidth = Math.max(0.5, len * 0.06)
  ctx.beginPath()
  ctx.moveTo(x - d, y - d)
  ctx.lineTo(x + d, y + d)
  ctx.moveTo(x - d, y + d)
  ctx.lineTo(x + d, y - d)
  ctx.stroke()
}

// ---------------------------------------------------------------------------
// Garment mockup: a stylised tee drawn on canvas, the design stamped on the
// chest at true relative scale (chest width in inches sets the mm -> px map).
// ---------------------------------------------------------------------------

export interface MockupStone { x: number; y: number; rMm: number; color: string }

// Stamp the design (stones + cut lines) centred at (cx, cy) in canvas px.
function drawDesign(
  ctx: CanvasRenderingContext2D,
  stones: MockupStone[],
  paths: { x: number; y: number }[][],
  pxPerMm: number,
  cx: number,
  cy: number,
  lineColor: string,
) {
  if (!stones.length && !paths.length) return
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of stones) {
    minX = Math.min(minX, s.x - s.rMm); minY = Math.min(minY, s.y - s.rMm)
    maxX = Math.max(maxX, s.x + s.rMm); maxY = Math.max(maxY, s.y + s.rMm)
  }
  for (const p of paths) for (const q of p) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
  const ox = cx - ((maxX - minX) * pxPerMm) / 2
  const oy = cy - ((maxY - minY) * pxPerMm) / 2
  ctx.strokeStyle = lineColor
  ctx.lineWidth = 0.8
  for (const p of paths) {
    ctx.beginPath()
    p.forEach((q, i) => {
      const x = ox + (q.x - minX) * pxPerMm, y = oy + (q.y - minY) * pxPerMm
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  for (const s of stones)
    drawGem(ctx, ox + (s.x - minX) * pxPerMm, oy + (s.y - minY) * pxPerMm, Math.max(1.2, s.rMm * pxPerMm), s.color)
  // GLINT PASS — a scatter of stones flashing. Deterministic (index hash),
  // so the same design sparkles identically on every render and in the
  // customer-approval PNG; sizes vary so it reads as light, not a pattern.
  for (let i = 0; i < stones.length; i++) {
    const h = (i * 2654435761) >>> 0
    if (h % 100 >= 14) continue
    const s = stones[i]
    const x = ox + (s.x - minX) * pxPerMm
    const y = oy + (s.y - minY) * pxPerMm
    const r = Math.max(1.2, s.rMm * pxPerMm)
    drawGlint(ctx, x, y, r * (2.1 + ((h >>> 8) % 100) / 60))
  }
}

export const MOCKUP_W = 520
export const MOCKUP_H = 620

// Real product-photo mockup: the S&S garment shot fitted to the canvas, the
// design stamped at true relative scale. spanPct calibrates how much of the
// photo's width the garment chest actually spans (S&S flat shots vary by
// brand), and off is the user's drag offset from the default chest spot.
export function drawMockupPhoto(
  cv: HTMLCanvasElement,
  photo: HTMLImageElement,
  spanPct: number,
  chestIn: number,
  off: { x: number; y: number },
  stones: MockupStone[],
  paths: { x: number; y: number }[][],
) {
  const W = MOCKUP_W, H = MOCKUP_H
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = W * dpr
  cv.height = H * dpr
  cv.style.width = `${W}px`
  cv.style.height = `${H}px`
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#f2f3f5'
  ctx.fillRect(0, 0, W, H)
  const s = Math.min(W / photo.naturalWidth, H / photo.naturalHeight)
  const dw = photo.naturalWidth * s, dh = photo.naturalHeight * s
  const dx = (W - dw) / 2, dy = (H - dh) / 2
  ctx.drawImage(photo, dx, dy, dw, dh)
  const pxPerMm = (dw * spanPct) / 100 / (chestIn * 25.4)
  drawDesign(ctx, stones, paths, pxPerMm, W / 2 + off.x, dy + dh * 0.42 + off.y, 'rgba(255,255,255,0.55)')
}

// Photo mode with no photo loaded yet: say so, instead of quietly showing
// the drawn illustration while the toggle claims "Product photo".
export function drawMockupEmpty(cv: HTMLCanvasElement, lines: string[]) {
  const W = MOCKUP_W, H = MOCKUP_H
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = W * dpr
  cv.height = H * dpr
  cv.style.width = `${W}px`
  cv.style.height = `${H}px`
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#f2f3f5'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#c3c9d4'
  ctx.setLineDash([8, 7])
  ctx.lineWidth = 2
  ctx.strokeRect(36, 36, W - 72, H - 72)
  ctx.setLineDash([])
  ctx.fillStyle = '#5a6475'
  ctx.font = '15px -apple-system, system-ui, sans-serif'
  ctx.textAlign = 'center'
  lines.forEach((t, i) => ctx.fillText(t, W / 2, H / 2 - ((lines.length - 1) / 2 - i) * 24))
}

export function drawMockup(
  cv: HTMLCanvasElement,
  garmentColor: string,
  chestIn: number,
  dropIn: number, // inches below the collar to the design top
  stones: MockupStone[],
  paths: { x: number; y: number }[][],
  off: { x: number; y: number } = { x: 0, y: 0 },
) {
  const W = MOCKUP_W, H = MOCKUP_H
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = W * dpr
  cv.height = H * dpr
  cv.style.width = `${W}px`
  cv.style.height = `${H}px`
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  // backdrop
  ctx.fillStyle = '#e9ebef'
  ctx.fillRect(0, 0, W, H)
  // tee silhouette: one continuous outline — sleeve undersides land ON the
  // armpit points, so there are no open notches for the backdrop to show
  // through (the old path left white triangles beside each side seam)
  const bodyL = 142, bodyR = 378, shoulderY = 88, hemY = 568
  const cx = (bodyL + bodyR) / 2
  ctx.fillStyle = garmentColor
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(cx - 92, shoulderY)                        // collar left
  ctx.quadraticCurveTo(cx, shoulderY + 46, cx + 92, shoulderY) // collar scoop
  ctx.lineTo(cx + 122, shoulderY + 12)                  // right shoulder tip
  ctx.quadraticCurveTo(cx + 196, shoulderY + 52, cx + 210, shoulderY + 86) // sleeve top
  ctx.lineTo(cx + 180, shoulderY + 150)                 // sleeve hem outer
  ctx.quadraticCurveTo(cx + 150, shoulderY + 140, cx + 122, shoulderY + 126) // sleeve hem inner
  ctx.lineTo(cx + 118, shoulderY + 122)                 // armpit right
  ctx.quadraticCurveTo(cx + 112, hemY - 110, cx + 110, hemY) // right side seam
  ctx.lineTo(cx - 110, hemY)                            // hem
  ctx.quadraticCurveTo(cx - 112, hemY - 110, cx - 118, shoulderY + 122) // left side seam
  ctx.lineTo(cx - 122, shoulderY + 126)                 // armpit left
  ctx.quadraticCurveTo(cx - 150, shoulderY + 140, cx - 180, shoulderY + 150) // sleeve hem inner
  ctx.lineTo(cx - 210, shoulderY + 86)                  // sleeve hem outer
  ctx.quadraticCurveTo(cx - 196, shoulderY + 52, cx - 122, shoulderY + 12) // sleeve top
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  // sleeve seams: the line where sleeve meets body
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'
  ctx.lineWidth = 1.5
  for (const side of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(cx + side * 122, shoulderY + 12)
    ctx.quadraticCurveTo(cx + side * 130, shoulderY + 70, cx + side * 118, shoulderY + 122)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.lineWidth = 2
  // collar ribbing
  ctx.beginPath()
  ctx.moveTo(cx - 92, shoulderY)
  ctx.quadraticCurveTo(cx, shoulderY + 46, cx + 92, shoulderY)
  ctx.quadraticCurveTo(cx, shoulderY + 24, cx - 92, shoulderY)
  ctx.closePath()
  const lum = (() => { const n = parseInt(garmentColor.slice(1), 16); return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) })()
  ctx.fillStyle = lum > 128 ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.14)'
  ctx.fill()
  // soft side shading so the shirt reads as fabric
  const sh = ctx.createLinearGradient(bodyL, 0, bodyR, 0)
  sh.addColorStop(0, 'rgba(0,0,0,0.16)')
  sh.addColorStop(0.18, 'rgba(0,0,0,0)')
  sh.addColorStop(0.82, 'rgba(0,0,0,0)')
  sh.addColorStop(1, 'rgba(0,0,0,0.16)')
  ctx.fillStyle = sh
  ctx.fillRect(bodyL, shoulderY, bodyR - bodyL, hemY - shoulderY)

  // design, centred on the chest at true relative scale
  if (!stones.length && !paths.length) return
  let minY = Infinity, maxY = -Infinity
  for (const s of stones) { minY = Math.min(minY, s.y - s.rMm); maxY = Math.max(maxY, s.y + s.rMm) }
  for (const p of paths) for (const q of p) { minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y) }
  const pxPerMm = ((bodyR - bodyL) - 16) / (chestIn * 25.4)
  const cy = shoulderY + 52 + dropIn * 25.4 * pxPerMm + ((maxY - minY) * pxPerMm) / 2
  drawDesign(ctx, stones, paths, pxPerMm, (bodyL + bodyR) / 2 + off.x, cy + off.y,
    lum > 128 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)')
}

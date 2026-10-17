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

// ---------------------------------------------------------------------------
// Garment mockup: a stylised tee drawn on canvas, the design stamped on the
// chest at true relative scale (chest width in inches sets the mm -> px map).
// ---------------------------------------------------------------------------

export interface MockupStone { x: number; y: number; rMm: number; color: string }

export function drawMockup(
  cv: HTMLCanvasElement,
  garmentColor: string,
  chestIn: number,
  dropIn: number, // inches below the collar to the design top
  stones: MockupStone[],
  paths: { x: number; y: number }[][],
) {
  const W = 520, H = 620
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
  // tee silhouette: body 90..430 (chest), shoulders, sleeves, collar
  const bodyL = 90, bodyR = 430, shoulderY = 78, hemY = 585
  ctx.fillStyle = garmentColor
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(bodyL, 150)                     // left armpit
  ctx.lineTo(28, 215)                        // left sleeve tip (upper)
  ctx.lineTo(62, 268)                        // left sleeve hem
  ctx.lineTo(bodyL + 12, 208)                // back to body
  ctx.lineTo(bodyL + 6, hemY)                // left side seam
  ctx.lineTo(bodyR - 6, hemY)                // hem
  ctx.lineTo(bodyR - 12, 208)                // right side seam
  ctx.lineTo(458, 268)                       // right sleeve hem
  ctx.lineTo(492, 215)                       // right sleeve tip
  ctx.lineTo(bodyR, 150)                     // right armpit
  ctx.lineTo(352, shoulderY)                 // right shoulder
  ctx.quadraticCurveTo(260, 128, 168, shoulderY) // collar scoop
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  // collar ribbing
  ctx.beginPath()
  ctx.moveTo(168, shoulderY)
  ctx.quadraticCurveTo(260, 128, 352, shoulderY)
  ctx.quadraticCurveTo(260, 108, 168, shoulderY)
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
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of stones) {
    minX = Math.min(minX, s.x - s.rMm); minY = Math.min(minY, s.y - s.rMm)
    maxX = Math.max(maxX, s.x + s.rMm); maxY = Math.max(maxY, s.y + s.rMm)
  }
  for (const p of paths) for (const q of p) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y) }
  const pxPerMm = (bodyR - bodyL) / (chestIn * 25.4)
  const dw = (maxX - minX) * pxPerMm
  const ox = (bodyL + bodyR) / 2 - dw / 2
  const oy = 132 + dropIn * 25.4 * pxPerMm
  ctx.strokeStyle = lum > 128 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)'
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
}

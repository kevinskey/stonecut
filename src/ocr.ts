// Text detection for imported graphics. A trace renders lettering as
// smeared keyline loops; real font geometry through the stone-text engine
// is categorically better. This finds the lettering GEOMETRICALLY (hollow
// glyph bodies chained into arcs/rows), then OCRs a de-arced strip for a
// best-guess reading. The geometry is reliable — the mask and arc angle
// come from it; the reading is only a pre-fill the user can correct.
//
// Tesseract.js (WASM) loads lazily from CDN on first use (~12MB, cached).
// Everything degrades silently — detection is an offer, never a gate.

export interface DetectedText {
  text: string // best-guess reading (user-editable; may be imperfect)
  rects: { x0: number; y0: number; x1: number; y1: number }[] // mask, fractions of the image
  bendDeg: number // arc sweep estimate for the Text panel's Arc bend
  glyphs: number
}

let workerP: Promise<unknown> | null = null
async function getWorker(): Promise<{ recognize: (f: Blob, o: object, out: object) => Promise<{ data: { blocks?: unknown[] } }> }> {
  if (!workerP)
    workerP = (async () => {
      // runtime CDN URL via indirection — tsc must not try to resolve it
      const url = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js'
      const mod = await import(/* @vite-ignore */ `${url}`)
      const T = ((mod as { default?: unknown }).default ?? mod) as { createWorker: (lang: string) => Promise<unknown> }
      return T.createWorker('eng')
    })()
  return workerP as never
}

interface Comp { id: number; area: number; minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number }

export async function detectText(file: File, threshold: number): Promise<DetectedText | null> {
  const img = await createImageBitmap(file)
  try {
    const W = Math.min(1400, img.width)
    const H = Math.round((img.height / img.width) * W)
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    const ctx = cv.getContext('2d')!
    ctx.drawImage(img, 0, 0, W, H)
    const data = ctx.getImageData(0, 0, W, H).data
    const n = W * H
    const bin = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const lum = data[i * 4 + 3] < 64 ? 255 : 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
      bin[i] = lum < threshold ? 1 : 0
    }
    // enclosed background components = hollow glyph bodies (and eye whites,
    // teeth… — the band chaining below is what separates letters from face)
    const label = new Int32Array(n).fill(-1)
    const comps: (Comp & { border: boolean })[] = []
    const stack: number[] = []
    for (let s0 = 0; s0 < n; s0++) {
      if (bin[s0] || label[s0] >= 0) continue
      const id = comps.length
      let area = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, border = false
      stack.push(s0)
      label[s0] = id
      while (stack.length) {
        const i = stack.pop()!
        area++
        const xx = i % W, yy = (i - xx) / W
        if (xx === 0 || yy === 0 || xx === W - 1 || yy === H - 1) border = true
        if (xx < minX) minX = xx
        if (xx > maxX) maxX = xx
        if (yy < minY) minY = yy
        if (yy > maxY) maxY = yy
        if (xx > 0 && !bin[i - 1] && label[i - 1] < 0) { label[i - 1] = id; stack.push(i - 1) }
        if (xx < W - 1 && !bin[i + 1] && label[i + 1] < 0) { label[i + 1] = id; stack.push(i + 1) }
        if (yy > 0 && !bin[i - W] && label[i - W] < 0) { label[i - W] = id; stack.push(i - W) }
        if (yy < H - 1 && !bin[i + W] && label[i + W] < 0) { label[i + W] = id; stack.push(i + W) }
      }
      comps.push({ id, area, minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, border })
    }
    const sized = comps.filter(
      (c) => !c.border && c.area > n * 0.0002 && c.area < n * 0.02 &&
        c.maxY - c.minY > H * 0.03 && c.maxY - c.minY < H * 0.35 &&
        (c.maxX - c.minX) / (c.maxY - c.minY) < 3,
    )
    // drop counters (nested inside another glyph body)
    const glyphs = sized
      .filter((g) => !sized.some((o) => o !== g && o.minX <= g.minX && o.maxX >= g.maxX && o.minY <= g.minY && o.maxY >= g.maxY))
      .sort((a, b) => a.cx - b.cx)
    if (glyphs.length < 4) return null
    // chain into bands: walk left→right, a glyph joins a band when its
    // centre is one glyph-height-ish from the band's LAST member (arcs stay
    // chained because neighbours are close; face blobs don't chain)
    const bands: Comp[][] = []
    for (const g of glyphs) {
      const h = g.maxY - g.minY
      let best: Comp[] | null = null
      let bestD = Infinity
      for (const band of bands) {
        const last = band[band.length - 1]
        const lh = last.maxY - last.minY
        const dx = g.cx - last.cx
        const dy = Math.abs(g.cy - last.cy)
        // letters advance SIDEWAYS: adjacent glyph centres are ~1 height
        // apart in x with limited drop even on an arc. The loose version
        // chained down into eye-whites and teeth and masked half the face.
        if (dx < Math.max(h, lh) * 0.3 || dx > Math.max(h, lh) * 2.6) continue
        if (dy > Math.max(h, lh) * 0.45 || dy > dx * 0.8) continue
        if (Math.abs(1 - h / lh) > 0.6) continue
        if (dx + dy < bestD) { bestD = dx + dy; best = band }
      }
      if (best) best.push(g)
      else bands.push([g])
    }
    // refine each band: letters follow a smooth arc — fit a quadratic
    // through the members and drop outliers (face parts that happened to
    // chain through). Two passes: fit, drop, refit.
    const fitQuad = (pts: { cx: number; cy: number }[]) => {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0
      for (const p of pts) { const X = p.cx / W; s0++; s1 += X; s2 += X * X; s3 += X ** 3; s4 += X ** 4; t0 += p.cy; t1 += X * p.cy; t2 += X * X * p.cy }
      const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
      const D = det([s4, s3, s2, s3, s2, s1, s2, s1, s0])
      if (Math.abs(D) < 1e-12) return null
      const qa = det([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / D
      const qb = det([s4, t2, s2, s3, t1, s1, s2, t0, s0]) / D
      const qc = det([s4, s3, t2, s3, s2, t1, s2, s1, t0]) / D
      return (x: number) => { const X = x / W; return qa * X * X + qb * X + qc }
    }
    const textBands = bands
      .filter((b) => b.length >= 4)
      .map((band) => {
        let members = band
        for (let pass = 0; pass < 2; pass++) {
          const f = fitQuad(members)
          if (!f) break
          const kept = members.filter((g) => Math.abs(g.cy - f(g.cx)) < (g.maxY - g.minY) * 0.6)
          if (kept.length === members.length || kept.length < 4) break
          members = kept
        }
        return members
      })
      .filter((b) => b.length >= 4)
    if (!textBands.length) return null
    // OCR each band as a locally-de-arced strip of solid glyphs
    const worker = await getWorker()
    const readings: string[] = []
    let sweepDeg = 0
    const rects: DetectedText['rects'] = []
    for (const band of textBands) {
      const maxH = Math.max(...band.map((g) => g.maxY - g.minY))
      const strip = document.createElement('canvas')
      strip.height = Math.round(maxH * 1.9)
      strip.width = band.reduce((t, g) => t + (g.maxX - g.minX) + 12, 40)
      const sx = strip.getContext('2d')!
      sx.fillStyle = '#fff'
      sx.fillRect(0, 0, strip.width, strip.height)
      let cursor = 20
      const angleAt = (i: number) => {
        const a = band[Math.max(0, i - 1)], b = band[Math.min(band.length - 1, i + 1)]
        return a === b ? 0 : Math.atan2(b.cy - a.cy, b.cx - a.cx)
      }
      band.forEach((g, i) => {
        const gw = g.maxX - g.minX + 1, gh = g.maxY - g.minY + 1
        const gc = document.createElement('canvas')
        gc.width = gw
        gc.height = gh
        const gx = gc.getContext('2d')!
        const gi = gx.createImageData(gw, gh)
        for (let yy = g.minY; yy <= g.maxY; yy++)
          for (let xx = g.minX; xx <= g.maxX; xx++) {
            if (label[yy * W + xx] !== g.id) continue
            const o = ((yy - g.minY) * gw + (xx - g.minX)) * 4
            gi.data[o + 3] = 255 // black glyph
          }
        gx.putImageData(gi, 0, 0)
        sx.save()
        sx.translate(cursor + gw / 2, strip.height * 0.55)
        sx.rotate(-angleAt(i))
        sx.drawImage(gc, -gw / 2, -gh / 2)
        sx.restore()
        cursor += gw + 12
      })
      const blob: Blob = await new Promise((r) => strip.toBlob((b) => r(b!), 'image/png'))
      try {
        const { data: res } = await worker.recognize(blob, {}, { blocks: true })
        const words: string[] = []
        for (const b of (res.blocks ?? []) as { paragraphs?: { lines?: { words?: { text: string }[] }[] }[] }[])
          for (const p of b.paragraphs ?? [])
            for (const l of p.lines ?? [])
              for (const wd of l.words ?? []) words.push(wd.text)
        const guess = words.join(' ').toUpperCase().replace(/[^A-Z0-9'!&.\- ]/g, '').replace(/\s+/g, ' ').trim()
        // a band that can't read as ≥4 characters is probably teeth or hat
        // stripes — real rows of shapes, but not text. Don't mask those.
        if (guess.replace(/[^A-Z0-9]/g, '').length < 4) continue
        readings.push(guess)
      } catch { continue /* no reading -> can't distinguish text from teeth */ }
      // arc sweep: end-tangent difference; positive = arches up (matches
      // the Text panel's Arc bend sign)
      const sweep = (angleAt(band.length - 1) - angleAt(0)) * (180 / Math.PI)
      if (Math.abs(sweep) > Math.abs(sweepDeg)) sweepDeg = sweep
      // mask: PER-GLYPH boxes padded ~0.6 heights (covers each keyline).
      // One bbox around an ARCHED band would also swallow whatever art sits
      // under the arc's chord — on the wildcat, the entire hat.
      for (const g of band) {
        const pad = (g.maxY - g.minY) * 0.6
        rects.push({
          x0: Math.max(0, (g.minX - pad) / W),
          y0: Math.max(0, (g.minY - pad) / H),
          x1: Math.min(1, (g.maxX + pad) / W),
          y1: Math.min(1, (g.maxY + pad) / H),
        })
      }
    }
    if (!rects.length) return null
    return {
      text: readings.join(' '),
      rects,
      bendDeg: Math.max(-180, Math.min(180, Math.round(sweepDeg / 5) * 5)),
      glyphs: textBands.reduce((t, b) => t + b.length, 0),
    }
  } catch (e) {
    console.warn('[stonecut] text detection unavailable', e)
    return null
  } finally {
    img.close()
  }
}

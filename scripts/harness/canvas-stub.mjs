// Minimal DOM canvas stub so src/fill.ts runs under Node for the offline
// placement harness. Implements exactly the subset rasterizeContours uses:
// Path2D (moveTo/lineTo/closePath), ctx.fill(path, 'evenodd') with
// source-over / destination-out compositing, and getImageData (alpha only).

class StubPath2D {
  constructor() {
    this.polys = []
    this.cur = null
  }
  moveTo(x, y) {
    this.cur = [{ x, y }]
    this.polys.push(this.cur)
  }
  lineTo(x, y) {
    if (!this.cur) this.moveTo(x, y)
    else this.cur.push({ x, y })
  }
  closePath() {
    this.cur = null
  }
}

class StubCtx {
  constructor(canvas) {
    this.canvas = canvas
    this.fillStyle = '#000'
    this.globalCompositeOperation = 'source-over'
  }
  _alpha() {
    const c = this.canvas
    if (!c._a || c._a.length !== c.width * c.height) c._a = new Uint8Array(c.width * c.height)
    return c._a
  }
  fill(path, rule) {
    void rule // even-odd is the only rule the caller uses
    const { width: w, height: h } = this.canvas
    const a = this._alpha()
    const erase = this.globalCompositeOperation === 'destination-out'
    for (let y = 0; y < h; y++) {
      const yc = y + 0.5
      // gather crossings across ALL subpaths (even-odd over the whole path)
      const xs = []
      for (const poly of path.polys) {
        const n = poly.length
        if (n < 3) continue
        for (let i = 0, k = n - 1; i < n; k = i++) {
          const p = poly[i]
          const q = poly[k]
          if (p.y > yc !== q.y > yc) xs.push(p.x + ((q.x - p.x) * (yc - p.y)) / (q.y - p.y))
        }
      }
      if (!xs.length) continue
      xs.sort((m, n2) => m - n2)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.max(0, Math.ceil(xs[i] - 0.5))
        const x1 = Math.min(w - 1, Math.floor(xs[i + 1] - 0.5))
        for (let x = x0; x <= x1; x++) a[y * w + x] = erase ? 0 : 255
      }
    }
  }
  getImageData(x0, y0, w, h) {
    const a = this._alpha()
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) data[i * 4 + 3] = a[i]
    return { data, width: w, height: h }
  }
}

class StubCanvas {
  constructor() {
    this.width = 0
    this.height = 0
  }
  getContext() {
    return new StubCtx(this)
  }
}

globalThis.Path2D = StubPath2D
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`stub: unexpected createElement(${tag})`)
    return new StubCanvas()
  },
}
// opentype.js lazily parses SVG-table glyphs with DOMParser (absent in Node)
process.on('unhandledRejection', () => {})

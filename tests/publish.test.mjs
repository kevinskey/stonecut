import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPublishPayload, snapshotPublishDesign } from '../src/publish.ts'

// Record canvas geometry without a browser or any network/cutter access.
// This checks output alignment, not the visual appearance of gem sprites.
const canvases = []
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas')
    const draws = []
    const ctx = new Proxy({}, {
      get(target, key) {
        if (key === 'drawImage') return (...args) => draws.push(args)
        if (key === 'createRadialGradient') return () => ({ addColorStop() {} })
        return target[key] ?? (() => {})
      },
    })
    const canvas = { width: 0, height: 0, draws, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,test' }
    canvases.push(canvas)
    return canvas
  },
}

const sizes = { SS6: { stoneMm: 2, holeMm: 3 }, SS10: { stoneMm: 2.9, holeMm: 3.4 } }
const stones = [
  { x: -20, y: 300, size: 'SS6', layer: 'outline' },
  { x: 40, y: 330, size: 'SS10', color: '#ff0000', layer: 'fill' },
  { x: 70, y: 310, size: 'SS6', layer: 'outline' },
]
const colorOf = (s) => s.color ?? '#ffffff'

test('whole-design SVG, BOM, PNG and dimensions share one normalized frame', () => {
  const snapshot = snapshotPublishDesign(stones, sizes, colorOf)
  const start = canvases.length
  const payload = buildPublishPayload('Full design', snapshot)
  const png = canvases[start]
  assert.equal(payload.stoneBom.reduce((n, row) => n + row.n, 0), 3)
  const circles = [...payload.svg.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g)]
  assert.equal(circles.length, 3)
  assert.equal(png.draws.length, 3)
  assert.match(payload.svg, new RegExp(`width="${payload.widthMm}mm" height="${payload.heightMm}mm"`))
  const scale = Math.min(8, 1600 / Math.max(payload.widthMm, payload.heightMm))
  circles.forEach((circle, i) => {
    const [sprite, x, y] = png.draws[i]
    assert.ok(Math.abs((x + sprite.width / 2) / scale - Number(circle[1])) < 0.001)
    assert.ok(Math.abs((y + sprite.height / 2) / scale - Number(circle[2])) < 0.001)
    assert.equal(Number(circle[3]), sizes[stones[i].size].holeMm / 2)
  })
  assert.equal(payload.stoneBom.find((r) => r.color === '#ffffff').n, 2)
  assert.equal(payload.previewBase64, 'data:image/png;base64,test')
  assert.ok(payload.coverage > 0 && payload.coverage < 1)
  assert.equal(snapshot.paths, undefined) // no accidental cut-only vector/frame geometry
})

test('moving artwork on the loaded media does not change the published design', () => {
  const shifted = stones.map((s) => ({ ...s, x: s.x + 500, y: s.y - 800 }))
  assert.deepEqual(snapshotPublishDesign(shifted, sizes, colorOf), snapshotPublishDesign(stones, sizes, colorOf))
})

test('snapshot preserves resolved colors and sizes after editor state changes', () => {
  const source = stones.map((s) => ({ ...s }))
  const specs = structuredClone(sizes)
  let fallback = '#ffffff'
  const snapshot = snapshotPublishDesign(source, specs, (s) => s.color ?? fallback)
  source[0].x = 999
  source[1].color = '#000000'
  specs.SS6.holeMm = 10
  fallback = '#000000'
  assert.equal(snapshot.stones[0].color, '#ffffff')
  assert.equal(snapshot.stones[1].color, '#ff0000')
  assert.equal(snapshot.sizes.SS6.holeMm, 3)
  assert.notEqual(snapshot.stones[0].x, 999)
})

test('oversized template holes remain inside the shared frame', () => {
  const snapshot = snapshotPublishDesign([{ x: 0, y: 0, size: 'custom' }], { custom: { stoneMm: 2, holeMm: 20 } }, colorOf)
  assert.equal(snapshot.widthMm, 28)
  assert.equal(snapshot.heightMm, 28)
  assert.equal(snapshot.stones[0].x, 14)
  assert.equal(snapshot.stones[0].y, 14)
})

test('empty designs cannot produce a publish snapshot', () => {
  assert.throws(() => snapshotPublishDesign([], sizes, colorOf), /no stones/)
})

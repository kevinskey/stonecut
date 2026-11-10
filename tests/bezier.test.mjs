import { test } from 'node:test'
import assert from 'node:assert/strict'
import { svgPathToBez, flattenPath, polylineToBez, splitAt, nearestOnPath, smoothThroughPts, validBez, transformBez } from '../src/bezier.ts'

test('svg path data keeps cubic handles and closes rings', () => {
  const b = svgPathToBez('M0 0 C 10 0, 10 10, 0 10 L 0 5 Z')
  assert.equal(b.length, 1)
  assert.equal(b[0].closed, true)
  assert.equal(b[0].a.length, 3)
  assert.deepEqual(b[0].a[0].ho, { x: 10, y: 0 })
  assert.deepEqual(b[0].a[1].hi, { x: 10, y: 10 })
  const flat = flattenPath(b[0])
  assert.ok(flat.length > 6)
  assert.deepEqual(flat[flat.length - 1], flat[0])
})

test('relative, shorthand and quadratic commands', () => {
  const b = svgPathToBez('m10 10 l5 0 c 0 5, 5 5, 5 0 s 5 -5, 5 0 q 5 5 10 0 t 10 0')
  assert.equal(b.length, 1)
  assert.equal(b[0].a.length, 6)
  const last = b[0].a[5]
  assert.equal(Math.round(last.x), 45)
  assert.equal(svgPathToBez('M0 0 A 5 5 0 0 1 10 0'), null)
})

test('a straight polyline round-trips exactly through anchors', () => {
  const pl = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }]
  const b = polylineToBez(pl)
  assert.equal(b.closed, true)
  assert.equal(b.a.length, 3)
  assert.deepEqual(flattenPath(b), pl)
})

test('splitting a segment keeps the curve where it was', () => {
  const b = svgPathToBez('M0 0 C 10 0, 10 10, 0 10')[0]
  const before = flattenPath(b)
  const hit = nearestOnPath(b, { x: 7.5, y: 5 }, 5)
  assert.ok(hit && hit.d < 0.1)
  const after = flattenPath(splitAt(b, hit.seg, hit.t))
  for (const q of before) {
    const d = Math.min(...after.map((r) => Math.hypot(r.x - q.x, r.y - q.y)))
    assert.ok(d < 0.2, `point drifted ${d}`)
  }
})

test('smooth-through and validation', () => {
  const s = smoothThroughPts([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }], false)
  assert.equal(s.a[1].smooth, true)
  assert.ok(validBez([s]))
  assert.ok(!validBez([{ a: [{ x: 0, y: 0 }], closed: false }]))
  const t = transformBez([s], (q) => ({ x: q.x + 1, y: q.y }))
  assert.equal(t[0].a[0].x, 1)
})

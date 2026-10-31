import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withWeedingFrame, weedingFrameFits } from '../src/weeding-frame.ts'
import { toGPGL, toHPGL, toSVG, toDXF } from '../src/export.ts'

const sizes = { SS6: { stoneMm: 2, holeMm: 3 }, SS10: { stoneMm: 2.9, holeMm: 3.4 } }
const preset = { name: 'software only', speed: 1, force: 1, passes: 1 }
const makeJob = (stones) => ({ stones, sizes, widthMm: 304.8, heightMm: 304.8 })
const job = makeJob([
  { x: 20, y: 20, size: 'SS6', color: '#ffffff' },
  { x: 280, y: 280, size: 'SS10', color: '#ff0000' },
])
const gpBody = (data) => data.slice(0, -'M0,0\x03'.length)
const hpBody = (data) => data.slice(0, -'PU0,0;\nSP0;\nIN;\n'.length)

for (const origin of ['bl', 'br']) for (const step of [10, 20, 40, 100]) {
  test(`frame preserves all hole commands: ${origin}, ${step} units/mm, both axis mappings`, () => {
    const framed = withWeedingFrame(job, job, 30) // previously enlarged both datums
    assert.equal(framed.widthMm, job.widthMm)
    assert.equal(framed.heightMm, job.heightMm)
    for (const swap of [false, true]) for (const firmwareCircles of [false, true]) {
      const base = toGPGL(job, preset, origin, step, false, swap, { firmwareCircles })
      const actual = toGPGL(framed, preset, origin, step, false, swap, { firmwareCircles })
      assert.ok(actual.startsWith(gpBody(base)))
    }
    assert.ok(toHPGL(framed, preset, origin).startsWith(hpBody(toHPGL(job, preset, origin))))
  })
}

test('frames outside each sheet edge are identified without moving or resizing the job', () => {
  for (const [x, y] of [[2, 150], [302, 150], [150, 2], [150, 302]]) {
    const edgeJob = makeJob([{ x, y, size: 'SS6' }])
    const before = structuredClone(edgeJob)
    const framed = withWeedingFrame(edgeJob, edgeJob, 5)
    assert.equal(weedingFrameFits(framed), false)
    assert.equal(framed.widthMm, 304.8)
    assert.equal(framed.heightMm, 304.8)
    assert.deepEqual(edgeJob, before)
  }
})

test('frame fits a cropped from-origin job when its existing margin is sufficient', () => {
  const cropped = { ...makeJob([{ x: 6.5, y: 6.5, size: 'SS6' }]), widthMm: 13, heightMm: 13 }
  const framed = withWeedingFrame(cropped, cropped, 5)
  assert.equal(weedingFrameFits(framed), true)
  assert.deepEqual(framed.paths[0], [{ x: 0, y: 0 }, { x: 13, y: 0 }, { x: 13, y: 13 }, { x: 0, y: 13 }, { x: 0, y: 0 }])
  assert.equal(weedingFrameFits(withWeedingFrame(cropped, cropped, 6)), false)
})

test('separate color/size selections share the full-design frame for registration', () => {
  const first = withWeedingFrame({ ...job, stones: [job.stones[0]] }, job, 5)
  const second = withWeedingFrame({ ...job, stones: [job.stones[1]] }, job, 5)
  assert.deepEqual(first.paths, second.paths)
  assert.equal(first.stones.length, 1)
  assert.equal(second.stones.length, 1)
  assert.equal(weedingFrameFits(first), true)
})

test('existing vector paths are preserved and frame cuts last', () => {
  const vectorJob = { ...job, paths: [[{ x: 10, y: 10 }, { x: 290, y: 290 }]] }
  const before = structuredClone(vectorJob)
  const framed = withWeedingFrame(vectorJob, vectorJob, 5)
  assert.equal(framed.paths.length, 2)
  assert.deepEqual(framed.paths[0], vectorJob.paths[0])
  assert.deepEqual(framed.paths[1][0], { x: 5, y: 5 })
  assert.deepEqual(vectorJob, before)
  assert.ok(toGPGL(framed, preset).startsWith(gpBody(toGPGL(vectorJob, preset))))
})

test('SVG/DXF stone geometry and page dimensions stay unchanged when adding the frame', () => {
  const framed = withWeedingFrame(job, job, 30)
  const circles = (svg) => svg.match(/<circle[^>]+\/>/g)
  assert.deepEqual(circles(toSVG(framed)), circles(toSVG(job)))
  assert.match(toSVG(framed), /width="304.8mm" height="304.8mm"/)
  const dxfHoles = (data) => data.split('0\r\nPOLYLINE')[0]
  assert.ok(toDXF(framed).startsWith(dxfHoles(toDXF(job)).split('0\r\nENDSEC')[0]))
})

test('empty cut selections do not create a frame-only cutting job', () => {
  const empty = { ...job, stones: [], paths: [] }
  assert.equal(withWeedingFrame(empty, job, 5), empty)
  assert.equal(withWeedingFrame(empty, empty, 5), empty)
})

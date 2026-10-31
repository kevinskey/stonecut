import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SIZES, mergeSavedSizes } from '../src/model.ts'
import { toSVG, toGPGL } from '../src/export.ts'

for (const holeMm of [2.5, 2.8, 3, 3.15]) {
  test(`saved SS6 ${holeMm} mm survives repeated JSON save/open cycles`, () => {
    let sizes = { SS6: { stoneMm: 2, holeMm } }
    for (let i = 0; i < 3; i++) sizes = mergeSavedSizes(JSON.parse(JSON.stringify(sizes)))
    assert.equal(sizes.SS6.holeMm, holeMm)
    assert.equal(sizes.SS6.stoneMm, 2)
    const makeJob = (specs) => ({ stones: [{ x: 10, y: 10, size: 'SS6' }], sizes: specs, widthMm: 30, heightMm: 30 })
    const original = makeJob({ SS6: { stoneMm: 2, holeMm } })
    const reopened = makeJob(sizes)
    assert.equal(toSVG(reopened), toSVG(original))
    const preset = { name: 'software only', force: 1, speed: 1, passes: 1 }
    assert.equal(toGPGL(reopened, preset), toGPGL(original, preset))
  })
}

test('new projects and missing sizes still receive current defaults', () => {
  assert.deepEqual(mergeSavedSizes(undefined), DEFAULT_SIZES)
  const loaded = mergeSavedSizes({ SS6: { stoneMm: 2, holeMm: 2.8 } })
  assert.deepEqual(loaded.SS10, DEFAULT_SIZES.SS10)
  assert.equal(loaded.SS6.holeMm, 2.8)
  assert.equal(DEFAULT_SIZES.SS6.holeMm, 3)
})

test('custom sizes and explicit stone diameters are preserved without mutating the input', () => {
  const saved = { custom: { stoneMm: 4.1, holeMm: 4.9 }, SS6: { stoneMm: 1.9, holeMm: 2.8 } }
  const before = structuredClone(saved)
  const loaded = mergeSavedSizes(saved)
  assert.deepEqual(loaded.custom, saved.custom)
  assert.deepEqual(loaded.SS6, saved.SS6)
  assert.deepEqual(saved, before)
  loaded.SS6.holeMm = 9
  assert.equal(saved.SS6.holeMm, 2.8)
})

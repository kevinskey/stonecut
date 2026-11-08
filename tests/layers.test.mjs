import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLayers, validLayers, layerOf, nextLayerName, makeLayer } from '../src/layers.ts'
import { DEFAULT_SIZES } from '../src/model.ts'
import { parseProject } from '../src/project.ts'

test('a project saved before layers gets one layer carrying its sizes and colours', () => {
  const stones = [
    { x: 1, y: 1, size: 'SS10', layer: 'outline' }, { x: 2, y: 1, size: 'SS10', layer: 'outline' },
    { x: 3, y: 1, size: 'SS16', layer: 'outline' }, { x: 1, y: 2, size: 'SS6', layer: 'fill' },
  ]
  const L = resolveLayers(undefined, stones, [], DEFAULT_SIZES, { outlineColor: '#ff0000', fillColor: '#00ff00' })
  assert.equal(L.length, 1)
  assert.equal(L[0].id, 1)
  assert.equal(L[0].size, 'SS10')
  assert.equal(L[0].fillSize, 'SS6')
  assert.equal(L[0].color, '#ff0000')
  assert.equal(L[0].fillColor, '#00ff00')
  assert.equal(layerOf(stones[0]), 1)
})

test('an empty project still gets a base layer', () => {
  const L = resolveLayers(undefined, [], [], DEFAULT_SIZES, {})
  assert.equal(L.length, 1)
  assert.equal(L[0].size, 'SS6')
})

test('saved layers win; layers referenced by stones but missing from the list are recreated', () => {
  const saved = [makeLayer(1, 'Letters', { size: 'SS10' }), makeLayer(3, 'Border', { size: 'SS16' })]
  const stones = [{ x: 0, y: 0, size: 'SS20', lay: 7 }]
  const vectors = [{ id: 1, lay: 3 }]
  const L = resolveLayers(saved, stones, vectors, DEFAULT_SIZES, {})
  assert.deepEqual(L.map((l) => l.id), [1, 3, 7])
  assert.equal(L[2].size, 'SS20')
  assert.equal(L[0].name, 'Letters')
})

test('a saved layer pointing at a size the table no longer has falls back', () => {
  const L = resolveLayers([makeLayer(1, 'A', { size: 'SS99', fillSize: 'SS8' })], [], [], DEFAULT_SIZES, {})
  assert.equal(L[0].size, 'SS6')
  assert.equal(L[0].fillSize, 'SS8')
})

test('new layer names skip ones already in use', () => {
  assert.equal(nextLayerName([makeLayer(1, 'Layer 1'), makeLayer(2, 'Layer 2')]), 'Layer 3')
  assert.equal(nextLayerName([makeLayer(1, 'Layer 1'), makeLayer(5, 'Layer 2')]), 'Layer 3')
  assert.equal(nextLayerName([makeLayer(1, 'Letters'), makeLayer(2, 'Layer 2')]), 'Layer 3')
})

test('validLayers rejects malformed input', () => {
  assert.equal(validLayers([makeLayer(1, 'A')]), true)
  assert.equal(validLayers([makeLayer(1, 'A'), makeLayer(1, 'B')]), false)
  assert.equal(validLayers([{ ...makeLayer(1, 'A'), color: 'red' }]), false)
  assert.equal(validLayers([{ ...makeLayer(1, 'A'), visible: 'yes' }]), false)
  assert.equal(validLayers('nope'), false)
})

test('parseProject round-trips layers and per-object layer ids', () => {
  const layers = [makeLayer(1, 'Letters', { size: 'SS10' }), makeLayer(2, 'Border', { size: 'SS16', color: '#123456' })]
  const data = {
    v: 2,
    stones: [{ x: 1, y: 1, size: 'SS10', lay: 1 }, { x: 5, y: 5, size: 'SS16', lay: 2 }],
    vectors: [{ id: 1, name: 'v', base: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]], baseW: 1, baseH: 1, x: 0, y: 0, s: 1, lay: 2 }],
    layers,
  }
  const p = parseProject(JSON.parse(JSON.stringify(data)))
  assert.deepEqual(p.layers, layers)
  assert.equal(p.stones[1].lay, 2)
  assert.equal(p.vectors[0].lay, 2)
  assert.throws(() => parseProject({ ...data, layers: [{ id: 'x' }] }), /invalid layers/)
  assert.throws(() => parseProject({ ...data, stones: [{ x: 1, y: 1, size: 'SS10', lay: 1.5 }] }), /invalid stone/)
})

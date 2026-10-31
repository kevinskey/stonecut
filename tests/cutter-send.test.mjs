import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendToCutter } from '../src/usb.ts'
import { makeCutConfirmation } from '../src/cut-confirmation.ts'
import { toGPGL } from '../src/export.ts'

function fakeUsb(overrides = {}) {
  const calls = []
  const device = {
    vendorId: 0x0b4d,
    configuration: { interfaces: [{ interfaceNumber: 3, alternate: { endpoints: [{ direction: 'out', type: 'bulk', endpointNumber: 2 }] } }] },
    async open() { calls.push('open') },
    async close() { calls.push('close') },
    async claimInterface(i) { calls.push(['claim', i]) },
    async releaseInterface(i) { calls.push(['release', i]) },
    async transferOut(ep, bytes) { calls.push(['write', ep, bytes.length]); return { status: 'ok', bytesWritten: bytes.length } },
    ...overrides,
  }
  const usb = { async getDevices() { return [device] }, async requestDevice() { throw new Error('unexpected chooser') } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { usb } })
  return { device, usb, calls }
}

test('only confirmed complete chunks advance progress; cleanup releases interface and device', async () => {
  const { calls } = fakeUsb()
  const progress = []
  await sendToCutter('x'.repeat(9000), (sent, total) => progress.push([sent, total]))
  assert.deepEqual(calls.filter((c) => c[0] === 'write'), [['write', 2, 4096], ['write', 2, 4096], ['write', 2, 808]])
  assert.deepEqual(progress, [[4096, 9000], [8192, 9000], [9000, 9000]])
  assert.deepEqual(calls.slice(-2), [['release', 3], 'close'])
})

for (const result of [{ status: 'stall', bytesWritten: 4096 }, { status: 'babble', bytesWritten: 4096 }, { status: 'ok', bytesWritten: 10 }]) {
  test(`reject ${result.status}/${result.bytesWritten} incomplete transfer without retrying`, async () => {
    const { calls, device } = fakeUsb({ async transferOut() { calls.push('failed-write'); return result } })
    const progress = []
    await assert.rejects(sendToCutter('x'.repeat(9000), (sent) => progress.push(sent)), /partially sent/)
    assert.equal(calls.filter((c) => c === 'failed-write').length, 1)
    assert.deepEqual(progress, [])
    assert.deepEqual(calls.slice(-2), [['release', 3], 'close'])
    device.transferOut = async (_ep, bytes) => ({ status: 'ok', bytesWritten: bytes.length })
    await sendToCutter('next job') // failed job does not leave the lock stuck
  })
}

test('second job or diagnostic is rejected while the first waits on the chooser', async () => {
  const { device, usb, calls } = fakeUsb()
  usb.getDevices = async () => []
  let choose
  usb.requestDevice = () => new Promise((resolve) => { choose = resolve })
  const first = sendToCutter('first job')
  // Allow discovery to reach the chooser without resolving it.
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(sendToCutter('diagnostic L'), /already being sent/)
  assert.equal(calls.length, 0)
  choose(device)
  await first
  assert.equal(calls.filter((c) => Array.isArray(c) && c[0] === 'write').length, 1)
})

test('disconnect after a chunk stops transmission and preserves the original error', async () => {
  let writes = 0
  const { calls, device } = fakeUsb({
    async transferOut(_ep, bytes) {
      if (++writes === 2) throw new Error('disconnected')
      return { status: 'ok', bytesWritten: bytes.length }
    },
    async releaseInterface() { calls.push('release-failed'); throw new Error('cleanup failed') },
  })
  const progress = []
  await assert.rejects(sendToCutter('x'.repeat(9000), (sent) => progress.push(sent)), /disconnected/)
  assert.deepEqual(progress, [4096])
  assert.deepEqual(calls.slice(-2), ['release-failed', 'close'])
  device.transferOut = async (_ep, bytes) => ({ status: 'ok', bytesWritten: bytes.length })
  await sendToCutter('retry only after operator inspection')
})

test('failed open and canceled chooser both release the lock', async () => {
  const { device, usb, calls } = fakeUsb({ async open() { throw new Error('open failed') } })
  await assert.rejects(sendToCutter('job'), /open failed/)
  assert.equal(calls.includes('close'), false)
  usb.getDevices = async () => []
  usb.requestDevice = async () => { throw new Error('chooser canceled') }
  await assert.rejects(sendToCutter('job'), /chooser canceled/)
  usb.getDevices = async () => [device]
  device.open = async () => {}
  await sendToCutter('job')
})

test('claim failure closes the opened device', async () => {
  const { calls } = fakeUsb({ async claimInterface() { throw new Error('claim failed') } })
  await assert.rejects(sendToCutter('job'), /claim failed/)
  assert.deepEqual(calls, ['open', 'close'])
})

const makeJob = () => ({ stones: [{ x: 20, y: 30, size: 'SS6' }], sizes: { SS6: { stoneMm: 2, holeMm: 3 } }, widthMm: 100, heightMm: 150 })
const makeSettings = () => ({ format: 'gpgl', preset: { name: 'test material', speed: 8, force: 32, passes: 2 }, origin: 'br', unitsPerMm: 20, sendConditions: true, swapAxes: true, cutOpts: { overcutMm: 0.5 }, scope: 'Selected objects', warnings: ['original warning'] })

test('confirmation freezes exact bytes, dimensions and settings for the selected job', () => {
  const job = makeJob(), settings = makeSettings()
  const confirmation = makeCutConfirmation(job, settings)
  const before = structuredClone(confirmation)
  assert.equal(confirmation.data, toGPGL(job, settings.preset, 'br', 20, true, true, { overcutMm: 0.5 }))
  assert.equal(Object.fromEntries(confirmation.rows)['Cut size'], '0.12″ × 0.12″ (3.00 × 3.00 mm)')
  assert.equal(Object.fromEntries(confirmation.rows)['Step size'], '0.050 mm — must match the cutter')
  job.stones[0].x = 90
  job.widthMm = 999
  settings.preset.force = 1
  settings.warnings.push('new warning')
  assert.deepEqual(confirmation, before)
})

test('HP-GL confirmation describes its transmitted conditions, excluding inactive GP-GL settings', () => {
  const settings = { ...makeSettings(), format: 'hpgl', sendConditions: false }
  const confirmation = makeCutConfirmation(makeJob(), settings)
  const rows = Object.fromEntries(confirmation.rows)
  assert.equal(rows['Command mode'], 'HP-GL')
  assert.equal(rows['Step size'], undefined)
  assert.match(rows['Holes material'], /force 32, speed 8/)
  assert.match(confirmation.data, /FS32;/)
})

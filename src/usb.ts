// Direct-to-cutter over WebUSB (Chrome/Edge). Graphtec vendor ID 0x0b4d.
// The CE6000 exposes a vendor-specific bulk interface; we claim it and
// stream the command bytes in chunks.

const GRAPHTEC = 0x0b4d

function usbApi(): USBLike {
  const usb = (navigator as unknown as { usb?: USBLike }).usb
  if (!usb) throw new Error('WebUSB not available — use Chrome or Edge, over http://localhost or https.')
  return usb
}

// A cutter the browser has ALREADY been allowed to use. Chrome remembers the
// grant per site, so after the first pick the device can be reopened with no
// chooser at all. Null when nothing is granted or the cutter is unplugged.
export async function grantedCutter(): Promise<{ name: string } | null> {
  try {
    const list = await usbApi().getDevices()
    const d = list.find((x) => x.vendorId === GRAPHTEC)
    return d ? { name: d.productName || 'Graphtec cutter' } : null
  } catch {
    return null
  }
}

// Synchronous lock covers normal jobs AND diagnostics, including the chooser.
let sending = false

export async function sendToCutter(
  data: string,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  if (sending) throw new Error('A job is already being sent to the cutter.')
  sending = true
  let device: USBDeviceLike | undefined
  let opened = false
  let claimed: number | undefined
  try {
    const usb = usbApi()
    const granted = (await usb.getDevices().catch(() => [] as USBDeviceLike[])).find((x) => x.vendorId === GRAPHTEC)
    device = granted ?? (await usb.requestDevice({ filters: [{ vendorId: GRAPHTEC }] }))
    await device.open()
    opened = true
    if (device.configuration == null) await device.selectConfiguration(1)
    const iface = device.configuration!.interfaces.find((i) =>
      i.alternate.endpoints.some((e) => e.direction === 'out' && e.type === 'bulk'),
    )
    if (!iface) throw new Error('No bulk-out endpoint found on cutter.')
    await device.claimInterface(iface.interfaceNumber)
    claimed = iface.interfaceNumber
    const ep = iface.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk')!
    const bytes = new TextEncoder().encode(data)
    const chunk = 4096
    for (let off = 0; off < bytes.length; off += chunk) {
      const part = bytes.slice(off, off + chunk)
      const result = await device.transferOut(ep.endpointNumber, part)
      if (result.status !== 'ok' || result.bytesWritten !== part.length) {
        throw new Error('Incomplete USB transfer. The job may be partially sent; check the cutter before resending.')
      }
      onProgress?.(off + part.length, bytes.length)
    }
  } finally {
    // A failed transfer must still release the interface and the send lock.
    // Cleanup failures must not hide the original transfer error.
    if (device && claimed !== undefined) await device.releaseInterface(claimed).catch(() => {})
    if (device && opened) await device.close().catch(() => {})
    sending = false
  }
}

// Minimal WebUSB typings (lib.dom doesn't ship them everywhere)
interface USBLike {
  requestDevice(opts: { filters: { vendorId: number }[] }): Promise<USBDeviceLike>
  getDevices(): Promise<USBDeviceLike[]>
}
interface USBEndpointLike {
  direction: 'in' | 'out'
  type: string
  endpointNumber: number
}
interface USBInterfaceLike {
  interfaceNumber: number
  alternate: { endpoints: USBEndpointLike[] }
}
interface USBDeviceLike {
  vendorId: number
  productName?: string
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(n: number): Promise<void>
  claimInterface(n: number): Promise<void>
  releaseInterface(n: number): Promise<void>
  transferOut(ep: number, data: Uint8Array): Promise<{ status: string; bytesWritten: number }>
  configuration: { interfaces: USBInterfaceLike[] } | null
}

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

export async function sendToCutter(
  data: string,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  const usb = usbApi()
  // Reuse the granted cutter; only show Chrome's chooser when there is none.
  const granted = (await usb.getDevices().catch(() => [] as USBDeviceLike[])).find((x) => x.vendorId === GRAPHTEC)
  const device = granted ?? (await usb.requestDevice({ filters: [{ vendorId: GRAPHTEC }] }))
  await device.open()
  try {
    if (device.configuration == null) await device.selectConfiguration(1)
    const iface = device.configuration!.interfaces.find((i) =>
      i.alternate.endpoints.some((e) => e.direction === 'out' && e.type === 'bulk'),
    )
    if (!iface) throw new Error('No bulk-out endpoint found on cutter.')
    await device.claimInterface(iface.interfaceNumber)
    const ep = iface.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk')!
    const bytes = new TextEncoder().encode(data)
    const chunk = 4096
    for (let off = 0; off < bytes.length; off += chunk) {
      await device.transferOut(ep.endpointNumber, bytes.slice(off, off + chunk))
      onProgress?.(Math.min(off + chunk, bytes.length), bytes.length)
    }
    await device.releaseInterface(iface.interfaceNumber)
  } finally {
    await device.close()
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
  transferOut(ep: number, data: Uint8Array): Promise<unknown>
  configuration: { interfaces: USBInterfaceLike[] } | null
}

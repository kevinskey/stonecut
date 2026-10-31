import type { Job, OriginCorner } from './export'
// Validate the quantized machine coordinates as well as the design geometry.
export function checkToolpath(data: string, job: Job, format: 'gpgl' | 'hpgl', unitsPerMm: number, swapAxes: boolean, _origin: OriginCorner): void {
  const units = format === 'hpgl' ? 40 : unitsPerMm
  const max1 = (format === 'gpgl' && swapAxes ? job.heightMm : job.widthMm) * units
  const max2 = (format === 'gpgl' && swapAxes ? job.widthMm : job.heightMm) * units
  const point = (x: number, y: number) => {
    if (![x,y].every(Number.isFinite) || x < 0 || y < 0 || x > max1+1e-6 || y > max2+1e-6) throw new Error('The generated toolpath exceeds the job area after cutter-step rounding. Add margin or move the design inward.')
  }
  for (const command of data.split(format === 'gpgl' ? '\x03' : ';').map((c)=>c.trim()).filter(Boolean)) {
    const match = command.match(format === 'gpgl' ? /^(?:M|D)(.*)$/ : /^(?:PU|PD)(.*)$/)
    if (match && match[1]) {
      const values=match[1].split(',').map(Number)
      if (values.length%2) throw new Error('Malformed toolpath coordinates')
      for(let i=0;i<values.length;i+=2)point(values[i],values[i+1])
    } else if (format === 'gpgl' && command.startsWith('W')) {
      const [x,y,rx,ry]=command.slice(1).split(',').map(Number)
      point(x-rx,y-ry);point(x+rx,y+ry)
    } else if (format === 'gpgl' && !/^(?:!\d+|\*2,\d+)$/.test(command)) throw new Error('Unexpected GP-GL command in generated job')
    else if (format === 'hpgl' && !/^(?:IN|FS\d+|VS\d+|SP[01]|PU|PD)$/.test(command)) throw new Error('Unexpected HP-GL command in generated job')
  }
}

import opentype from 'opentype.js'
import type { Pt } from './model'

// Convert a text string to flattened closed contours in mm.
// heightMm is the cap height target (measured from the rendered bbox).
export function textToContours(
  font: opentype.Font,
  text: string,
  heightMm: number,
  letterSpacing: number,
): { contours: Pt[][]; widthMm: number } {
  const fontSize = 100
  const path = font.getPath(text, 0, 0, fontSize, {
    kerning: true,
    letterSpacing: letterSpacing / 10,
  } as opentype.RenderOptions)
  const contours = flattenPath(path.commands, 2)
  // scale so overall bbox height == heightMm
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of contours)
    for (const p of c) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
    }
  if (!isFinite(minX)) return { contours: [], widthMm: 0 }
  const scale = heightMm / (maxY - minY)
  const out = contours.map((c) =>
    c.map((p) => ({ x: (p.x - minX) * scale, y: (p.y - minY) * scale })),
  )
  return { contours: out, widthMm: (maxX - minX) * scale }
}

// Flatten opentype path commands (M/L/Q/C/Z) into polylines.
function flattenPath(commands: opentype.PathCommand[], segsPerUnit: number): Pt[][] {
  const contours: Pt[][] = []
  let cur: Pt[] = []
  let pos: Pt = { x: 0, y: 0 }
  let start: Pt = { x: 0, y: 0 }
  const push = (p: Pt) => cur.push(p)
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        if (cur.length > 1) contours.push(cur)
        cur = []
        pos = { x: cmd.x, y: cmd.y }
        start = pos
        push(pos)
        break
      case 'L':
        pos = { x: cmd.x, y: cmd.y }
        push(pos)
        break
      case 'Q': {
        const n = segCount(pos, { x: cmd.x, y: cmd.y }, segsPerUnit)
        for (let i = 1; i <= n; i++) {
          const t = i / n
          const mt = 1 - t
          push({
            x: mt * mt * pos.x + 2 * mt * t * cmd.x1 + t * t * cmd.x,
            y: mt * mt * pos.y + 2 * mt * t * cmd.y1 + t * t * cmd.y,
          })
        }
        pos = { x: cmd.x, y: cmd.y }
        break
      }
      case 'C': {
        const n = segCount(pos, { x: cmd.x, y: cmd.y }, segsPerUnit)
        for (let i = 1; i <= n; i++) {
          const t = i / n
          const mt = 1 - t
          push({
            x: mt ** 3 * pos.x + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t ** 3 * cmd.x,
            y: mt ** 3 * pos.y + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t ** 3 * cmd.y,
          })
        }
        pos = { x: cmd.x, y: cmd.y }
        break
      }
      case 'Z':
        push(start)
        if (cur.length > 1) contours.push(cur)
        cur = []
        break
    }
  }
  if (cur.length > 1) contours.push(cur)
  return contours
}

function segCount(a: Pt, b: Pt, segsPerUnit: number): number {
  return Math.max(4, Math.min(60, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * segsPerUnit)))
}

export async function loadFontFile(file: File): Promise<opentype.Font> {
  const buf = await file.arrayBuffer()
  return opentype.parse(buf)
}

export function parseFontBuffer(buf: ArrayBuffer): opentype.Font {
  return opentype.parse(buf)
}

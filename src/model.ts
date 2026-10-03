export interface Stone {
  x: number // mm, center
  y: number // mm, center
  size: string // key into stone size table
  color?: string // display/design color (multi-color templates)
  layer?: 'outline' | 'fill' // cut separation — templates are cut per layer
  el?: number // element id — each committed design is a free-moving unit
}

export interface StoneSpec {
  stoneMm: number // actual rhinestone diameter
  holeMm: number // template hole diameter (stone + clearance)
}

// Hole = stone diameter + clearance so stones brush in easily but don't flip.
export const DEFAULT_SIZES: Record<string, StoneSpec> = {
  SS6: { stoneMm: 2.0, holeMm: 2.5 },
  SS8: { stoneMm: 2.4, holeMm: 2.9 },
  SS10: { stoneMm: 2.9, holeMm: 3.4 },
  SS12: { stoneMm: 3.1, holeMm: 3.7 },
  SS16: { stoneMm: 4.0, holeMm: 4.6 },
  SS20: { stoneMm: 4.8, holeMm: 5.4 },
  SS30: { stoneMm: 6.4, holeMm: 7.0 },
}

export interface MaterialPreset {
  name: string
  force: number // 1-38 on CE6000
  speed: number // 1-64 cm/s
  passes: number
}

export const DEFAULT_PRESETS: MaterialPreset[] = [
  { name: 'Sticky Flock', force: 30, speed: 10, passes: 1 },
  { name: 'Rhinestone Rubber', force: 33, speed: 8, passes: 2 },
  { name: 'Hartco Sandmask', force: 28, speed: 12, passes: 1 },
  { name: 'Vinyl (test)', force: 14, speed: 30, passes: 1 },
]

export interface Pt {
  x: number
  y: number
}

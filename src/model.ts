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
  group?: string // optgroup in the Material picker
  blade?: string // what the maker says to cut it with (not sent to the machine)
  note?: string // where the numbers came from / caveats
}

// Built-in presets. Force/speed are CE6000 condition units, exactly as the
// manufacturers publish them for Graphtec (Siser prints "Gram-Force" on its
// chart but the Graphtec column is machine units — 8-9 gf would not mark the
// liner). Where a maker gives a range the TOP of the range is used, so a
// fresh blade cuts through first time; lower it if the liner is scored.
// Sources (read 2026-10-10):
//   Siser  "Cutter settings for HTV materials" 6-2020 and the 2024 dealer
//          table (atlantavinylstore.com/pages/siser-cut-settings…),
//          "EasyPSV cutter settings" 5-2023 (siserna.com)
//   Stahls CAD-CUT cutter guidelines as republished by Atlanta Vinyl
//   Oracal has no official Graphtec table; Sign Warehouse's Graphtec guidance
//          for 2-4 mil calendered vinyl (force 14-16, speed 20, CB09U) and
//          CE6000 owner reports (12-20 depending on colour and blade wear)
const S45 = '45° blade, CB09U+0'
export const DEFAULT_PRESETS: MaterialPreset[] = [
  // --- rhinestone template materials (this shop's own settings) ---
  { name: 'Sticky Flock', force: 30, speed: 10, passes: 1, group: 'Rhinestone templates', note: 'Confirmed on this CE6000 (2026-10-04).' },
  { name: 'Rhinestone Rubber', force: 33, speed: 8, passes: 2, group: 'Rhinestone templates' },
  { name: 'Hartco Sandmask', force: 28, speed: 12, passes: 1, group: 'Rhinestone templates' },

  // --- adhesive sign vinyl ---
  { name: 'Oracal 651 (permanent gloss)', force: 15, speed: 20, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Dealer guidance for 2–4 mil calendered vinyl: force 14–16 at 20 cm/s. Owners report 12–20 by colour and blade age. Oracal publishes no Graphtec table.' },
  { name: 'Oracal 631 (removable matte)', force: 14, speed: 20, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Same class as 651; start a point lower.' },
  { name: 'Oracal 751 / 951 (cast)', force: 16, speed: 20, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'No published Graphtec figure. Cast film cuts like 651 with a point or two more — test first.' },
  { name: 'Oramask 813 (stencil film)', force: 12, speed: 20, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Thin paint mask: start low so the liner is not scored.' },
  { name: 'Siser EasyPSV Permanent / Starling', force: 9, speed: 30, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Siser 5-2023: force 8–9.' },
  { name: 'Siser EasyPSV Brushed / Etch / Glitter', force: 9, speed: 30, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Siser 5-2023: force 7–9.' },
  { name: 'Siser EasyPSV Holographic', force: 7, speed: 30, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Siser 5-2023: force 6–7.' },
  { name: 'Siser EasyPSV Patterns', force: 10, speed: 30, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Siser 5-2023: force 9–10.' },
  { name: 'Siser EasyPSV Blackboard', force: 11, speed: 30, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Siser 5-2023: force 9–11.' },
  { name: 'Siser EasyPSV Glow', force: 18, speed: 30, passes: 1, group: 'Adhesive vinyl', blade: S45, note: 'Siser 5-2023: force 17–18.' },

  // --- Siser heat transfer vinyl ---
  { name: 'Siser EasyWeed', force: 9, speed: 30, passes: 1, group: 'Siser HTV', blade: S45, note: 'Siser: force 8–9. Also Electric, Extra, Adhesive, EcoStretch, EasyReflective, Easy Puff, Aurora, PureHT, EasySubli, EasyPatterns Plus.' },
  { name: 'Siser EasyWeed Stretch / Sub Block / Glow', force: 10, speed: 30, passes: 1, group: 'Siser HTV', blade: S45, note: 'Siser 6-2020: force 9–10.' },
  { name: 'Siser Glitter / DiamondDust', force: 18, speed: 30, passes: 1, group: 'Siser HTV', blade: S45, note: 'Siser: force 17–18.' },
  { name: 'Siser Holographic', force: 18, speed: 30, passes: 1, group: 'Siser HTV', blade: S45, note: 'Siser: force 17–18.' },
  { name: 'Siser Metal / Sparkle / Vernice', force: 10, speed: 30, passes: 1, group: 'Siser HTV', blade: S45, note: 'Siser: force 9–10.' },
  { name: 'Siser Twinkle', force: 13, speed: 30, passes: 1, group: 'Siser HTV', blade: S45, note: 'Siser: force 13.' },
  { name: 'Siser Easy Puff Glitter', force: 20, speed: 30, passes: 1, group: 'Siser HTV', blade: S45, note: 'Siser: force 15–20.' },
  { name: 'Siser StripFlock Pro', force: 9, speed: 30, passes: 1, group: 'Siser HTV', blade: S45, note: 'Siser: force 8–9. Extend the blade further for flock.' },
  { name: 'Siser Brick 600', force: 9, speed: 25, passes: 1, group: 'Siser HTV', blade: '60° blade only (45° not recommended), extend blade', note: 'Siser: force 8–9 at 25 cm/s.' },

  // --- Stahls CAD-CUT heat transfer vinyl (45° blade, offset 0) ---
  { name: 'Stahls Premium Plus', force: 11, speed: 20, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 9–11 at 20.' },
  { name: 'Stahls UltraWeed', force: 9, speed: 20, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 7–9 at 20.' },
  { name: 'Stahls T-Shirt Pro', force: 11, speed: 20, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 9–11 at 20.' },
  { name: 'Stahls SportFilm Lite', force: 11, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 9–11 at 30.' },
  { name: 'Stahls Thermo-FILM / Thermo-GRIP', force: 20, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 18–20 at 30.' },
  { name: 'Stahls Glitter Flake / Glimmer', force: 22, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 18–22 at 30.' },
  { name: 'Stahls Hologram', force: 17, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 15–17 at 30.' },
  { name: 'Stahls Glow', force: 10, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 8–10 at 30.' },
  { name: 'Stahls Soft Flock', force: 13, speed: 25, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 11–13 at 25.' },
  { name: 'Stahls Soft Foam', force: 26, speed: 20, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 24–26 at 20.' },
  { name: 'Stahls Reflective II', force: 13, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 11–13 at 30.' },
  { name: 'Stahls ReflectPRO', force: 14, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 12–14 at 30.' },
  { name: 'Stahls Soft Metallic', force: 10, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 8–10 at 30.' },
  { name: 'Stahls Metallic Puff', force: 9, speed: 20, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 9 at 20.' },
  { name: 'Stahls Puff', force: 9, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 8–9 at 30.' },
  { name: 'Stahls Chroma-TWILL', force: 12, speed: 20, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 12 at 20.' },
  { name: 'Stahls Silicone Dye-Block', force: 13, speed: 20, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 11–13 at 20.' },
  { name: 'Stahls UV Shift', force: 9, speed: 30, passes: 1, group: 'Stahls CAD-CUT HTV', blade: S45, note: 'Stahls: force 7–9 at 30.' },
]

export interface Pt {
  x: number
  y: number
}

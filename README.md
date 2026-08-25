# StoneCut

Browser-based rhinestone template designer + direct cutter control for the
Graphtec CE6000. Replaces the Illustrator → Cutting Master chain for
rhinestone work; also exports SVG for Cricut Design Space.

## Run

```
npm install
npm run dev     # http://localhost:5173 — use Chrome or Edge (WebUSB)
```

## Workflow

1. **Stones** — pick a size (SS6–SS30). Hole diameter is editable per size
   (hole = stone + clearance so stones brush in). Min gap is the smallest
   edge-to-edge distance between holes; overlapping stones are auto-removed.
2. **Text** — upload any .ttf/.otf, type text, set height in mm, choose
   outline / fill / both.
3. **Image** — upload a PNG/JPG, set target width, tune the threshold slider.
   Dark areas get stones (check Invert for the opposite).
4. **Edit** — Add/erase mode places or removes single stones; Select mode
   drags them. ⌘Z undo, ⌘A select all, Delete removes.
5. **Material** — presets store force/speed/passes (saved in the browser).
   CE6000 range: force 1–38, speed 1–64.
6. **Cut** — "Cut on Graphtec" streams the job over WebUSB (Chrome will ask
   you to pick the cutter the first time). Or download a `.plt` / SVG.

## CE6000 notes

- **Command mode**: the app defaults to GP-GL, which is the CE6000 factory
  default (MENU → I/F → COMMAND). If your machine is set to HP-GL, switch the
  dropdown to HP-GL instead — sending the wrong dialect does nothing visible.
- Stones cut in nearest-neighbor order so the head doesn't zigzag across the
  mat on dense fills.
- If WebUSB can't claim the cutter (another driver has it), download the
  `.plt` and send it any other way — the file is the same bytes.

## For the Cricut

Export SVG and import into Design Space. The SVG is sized in real mm; make
sure Design Space doesn't rescale it on import (check the width matches).

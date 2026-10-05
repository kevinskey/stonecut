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
6. **Place** — the board is the loaded vinyl, ruled in inches from the
   machine's ORIGIN corner (lower-right on a Graphtec). Drag the design where
   you want it, or type "Across from origin" / "Up from origin" in the Cut
   section. What the board shows is where it cuts.
7. **Cut** — on the CE6000, jog the blade to the front-right corner of the
   vinyl and press ORIGIN. Then "Cut on Graphtec" (pinned to the bottom of
   the sidebar) streams the job over WebUSB; Chrome asks you to pick the
   cutter the first time. Or download a `.plt` / SVG.

Zoom: pinch or ⌘-scroll zooms at the cursor, F fits the design, ⌘0 fits
the sheet. Settings live in the browser (localStorage), so each computer
keeps its own.

## CE6000 notes

Confirmed working setup (2026-10-04, CE6000, Sticky Flock at force 30 /
speed 10). All of these are under Cut → Cutter setup and are the defaults
for a fresh browser:

| Setting | Value |
| --- | --- |
| Command mode | GP-GL (CE6000 factory default, MENU → I/F → COMMAND) |
| GP-GL step size | 0.050 mm (20 units/mm) — must match MENU → I/F → STEP SIZE |
| Cutter origin corner | Lower-RIGHT |
| Swap axes | ON (GP-GL's first coordinate is the feed axis = the board's vertical) |
| Send speed/force | OFF (the panel conditions are the source of truth) |
| Position on material | On the board |

- If a job **feeds media before cutting**, it is the data stream, not the
  machine: a leading `H` (home) or any command starting with `F` (chart
  feed) at the head of the job. `src/export.ts` sends neither. Pre Feed on
  the cutter's own menu is the only other cause.
- If a cut comes out rotated 90°, flip Swap axes. "Send test square" cuts a
  small asymmetric L that shows which way the axes run.
- **Command mode**: if your machine is set to HP-GL, switch the dropdown to
  HP-GL instead — sending the wrong dialect does nothing visible.
- Stones cut in nearest-neighbor order so the head doesn't zigzag across the
  mat on dense fills.
- If WebUSB can't claim the cutter (another driver has it), download the
  `.plt` and send it any other way — the file is the same bytes.

## Deploy (rhinestones.tshirtbrothers.com)

The site is a static build served by nginx on the TSB DigitalOcean droplet
(hostname `KPJ-SITES`) from `/var/www/stonecut/html`. There is no CI deploy;
`deploy.sh` does it on the droplet:

1. Push to `main`.
2. Open the droplet in DigitalOcean → Access → Launch Droplet Console (log in
   as root). SSH from a machine without the droplet's key is refused.
3. Run, with `<commit>` the hash you just pushed (the `main` raw URL is
   cached for a few minutes and can hand you the previous script):

   ```
   curl -fsSL https://raw.githubusercontent.com/kevinskey/stonecut/<commit>/deploy.sh | bash
   ```

   It clones/updates the repo on the droplet, builds, finds the nginx root
   for the host, and swaps the build in. The previous build stays at
   `/var/www/stonecut/html.prev`; roll back by swapping the two directories.
4. Check: `curl -s https://rhinestones.tshirtbrothers.com/ | grep -o 'index-[A-Za-z0-9_-]*\.js'`
   should match the bundle name the script printed.

Run `deploy.sh` only on the droplet. Run with sudo on a Mac it will clone
into `/var/www` there and leave root-owned files in `~/.npm`
(`sudo chown -R $(id -u):$(id -g) ~/.npm` fixes that).

## For the Cricut

Export SVG and import into Design Space. The SVG is sized in real mm; make
sure Design Space doesn't rescale it on import (check the width matches).

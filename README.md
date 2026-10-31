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
speed 10). This is a recorded working setup, not a substitute for checking the current
machine. The application currently starts a fresh browser at **0.100 mm
(10 units/mm)**; the recorded setup below used **0.050 mm (20 units/mm)**.
Set Cut → Cutter setup to match MENU → I/F → STEP SIZE on your cutter before
sending. The cut confirmation displays the selected step size, origin,
command mode, and axis mapping.

| Setting | Value |
| --- | --- |
| Command mode | GP-GL (CE6000 factory default, MENU → I/F → COMMAND) |
| GP-GL step size | 0.050 mm (20 units/mm) — must match MENU → I/F → STEP SIZE |
| Cutter origin corner | Lower-RIGHT |
| Swap axes | ON (GP-GL's first coordinate is the feed axis = the board's vertical) |
| Send speed/force | ON (the material preset's force/speed go ahead of the geometry; set TOOLS SETTING → CONDITION PRIORITY → PROGRAM on the cutter or the panel values still win) |
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

## Production releases

The verified web deployment is **https://rhinestones.tshirtbrothers.com/**.
`stonecut.com` is not assumed to be the same deployment. See
`docs/RELIABILITY.md` for scope and validation limits.

GitHub Actions in this repository runs locked dependency installation,
`npm test`, lint, production build, and shell/desktop syntax checks on pushes
and pull requests, then retains the built artifact.

The production deployment runner uses the existing TSB droplet credentials in
the `kevinskey/tshirtbrothers` deployment branch. Each release pins an exact
StoneCut commit; it runs StoneCut's checked-in `deploy.sh`, which builds with
`npm ci`, runs tests, verifies the nginx vhost/document root, installs a new
release, and checks live HTML/assets and `build-info.json`. Subsequent releases
switch an atomic symlink. A failing health check restores the previous release.
It does not change nginx configuration or communicate with a cutter.

To run the same deployment on the droplet (never on your workstation):

```
sudo STONECUT_REF=<full-commit-sha> bash deploy.sh
```

The live pointer is `/var/www/stonecut/html`, releases live under
`/var/www/stonecut/releases`, and the preceding target is recorded in
`/var/www/stonecut/previous-release`. Old builds are retained for rollback.
After reviewing that path, rollback can switch `html` to that target with a
new symlink and `mv -Tf`; do not delete release directories while in use.

## Project recovery and production packages

Design files now include artwork, sizes, editable recipes, vectors, media,
colors, spacing, and a saved cutter/material profile. Legacy v1 files remain
readable. Saved cutter settings are shown for review under Cut; opening a
file does not silently apply them. The recovery strip reports storage errors
and offers a downloadable backup. File → Save named project version stores
searchable versions with previews **on the current computer/site**, not in
an online account. Export files before moving domains or computers.

File → Download production package creates a ZIP with the whole design,
per-color SVG templates sharing one coordinate frame, a preview, bill of
materials, work order, placement guide, and editable project. Final geometry
must fit the job area and satisfy the spacing floor before cutting/export.
Publishing uses the complete rhinestone design, independently of cut selection.
Publish keys are retained for the browser session rather than indefinitely.

## For the Cricut

Export SVG and import into Design Space. The SVG is sized in real mm; make
sure Design Space doesn't rescale it on import (check the width matches).

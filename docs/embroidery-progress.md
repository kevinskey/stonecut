# Embroidery digitizing — progress

Companion to `embroidery-spec.md` (the standing specification). Updated
2026-11-13 (after Milestone 4).

**Status statuses mean exactly this:**

| Status | Evidence required |
| --- | --- |
| Missing | — |
| In progress | Code exists but does not yet do the job end to end |
| Implemented | Works when exercised by hand |
| Software verified | An automated test asserts the behaviour and fails without it |
| Sewout verified | Sewn on the BAI and physically inspected |

**Nothing in this project is Sewout verified. Zero physical sewouts have been
performed.**

---

## Where the work lives

| | |
| --- | --- |
| Engine + app | `~/src/gleembroidery` — github.com/kevinskey/gleembroidery (public) |
| **Live at** | **https://threads.tshirtbrothers.com** |
| Sibling tool | `~/src/stonecut` → rhinestones.tshirtbrothers.com |
| Droplet | 198.211.113.144, nginx vhost, `/var/www/gleembroidery/html` |
| Deploy | `curl -fsSL https://raw.githubusercontent.com/kevinskey/gleembroidery/main/deploy.sh \| bash` on the droplet |
| Machine | BAI commercial, Tajima DST, bracket spacing configurable |

**Spec §2 was AMENDED on 2026-11-12**: the tool ships at its own subdomain
rather than as a mode inside StoneCut. See the amendment block at the top of
§2 in `embroidery-spec.md` for the reasoning and what it does not change.
Integration is still owed and still blocked on StoneCut's version gate.

The deploy script runs the full engine suite **and** the pyembroidery
machine-safety gate on the droplet before swapping in a build; a failure
aborts the deploy. The previous build is kept as `html.prev`, so a rollback
is one `mv`.

---

## Feature matrix

Updated 2026-11-13, after Milestone 4. **725 engine assertions**, all passing.
**6 fixtures × 3 machine formats** verified against pyembroidery. Still **zero
physical sewouts**, so nothing below is Sewout verified.

### §2 Integration

| Feature | Status | Evidence |
| --- | --- | --- |
| Embroidery workspace inside StoneCut | **Missing** | Ships at its own subdomain per the §2 amendment; integration still owed |
| Rhinestone / embroidery data separation | **Missing** | No shared document exists yet |
| Versioned backward-compatible storage | **Missing** | StoneCut writes `v: 1` and reads it nowhere; both loaders duck-type |
| Shared artwork with explicit derivatives | **Missing** | — |
| Background generation keyed to project+revision | **Software verified** | `useStitchPlan` keys on a content signature taken FROM THE SAVE FORMAT; a 53-setting test asserts every saveable field changes it |
| Existing rhinestone workflow unaffected | **Implemented** | Nothing in StoneCut has been modified |

### §3 Object model

| Feature | Status | Evidence |
| --- | --- | --- |
| Source artwork / objects / stitch plan kept separate | **Software verified** | `model.ts` → `digitize.ts` → `stitches.ts` |
| Stable object identity, layer membership | **Software verified** | `newObject()` ids; `Group` membership with hide/lock/fold, asserted not to alter sewing order |
| Editable outlines, Bézier nodes, holes | **Software verified** | `nodes.ts` shapes with handles; `paths` is a flattened cache; holes via `toRegions` |
| Satin rails and stitch-angle guides | **Software verified** | Two-rail columns with rung pairing; `AngleGuide` lines interpolating along a spine column |
| Stitch type + parameters, density, lengths, underlay, pull comp | **Software verified** | each asserted |
| Entry / exit points | **Software verified** | draggable markers; `orientToEntryExit` chooses which way round an object runs |
| Tie-in / tie-off settings | **Software verified** | `Doc.tie` — on/off, style, length, count; all five change the stitches |
| Thread assignment | **Implemented** | per object; blocks merge on THREAD, not screen colour |
| Sewing order | **Implemented** | document order, reorderable; groups deliberately do not change it |
| Branching / connected objects | **Software verified** | `travel.ts` chains paths whose ends meet; 4 loose sides → one ring, 120 mm of travel and 3 trims → 0 |
| Millimetres throughout, inches displayed | **Software verified** | independent check confirms dimensions survive export |
| Save / reopen preserving editability | **Software verified** | every field round-trips; a reopened project re-digitises byte-identically |
| Imported stitch files stay identified as stitch data | **Implemented** | DST import loads as a read-only grey reference, never as objects |

### §4 Digitizing features

| Feature | Status | Evidence |
| --- | --- | --- |
| SVG import at correct physical scale | **Implemented** | verified in-browser against a mm-dimensioned SVG |
| Raster import + assisted tracing | **Software verified** | `trace.ts` flood + marching squares, DOM-free; Wand tool |
| Point / freehand / Bézier drawing, node editing | **Software verified** | Pen, Arc, Polygon, Rect, Ellipse, Draw, Nodes; `draw.ts` + `nodes.ts` |
| Shapes with holes | **Software verified** | see §3 |
| Align / distribute / rotate / mirror / duplicate | **Software verified** | `arrange.ts`; distribute evens GAPS not centres; mirror is its own undo |
| Selection, grouping, layers, undo/redo | **Software verified** | marquee + range/toggle in the sequence list; `Group`; `history.ts` snapshot undo |
| Union / intersection / subtraction / flatten | **Software verified** | `shapeops.ts` with UI; "No overlap" took a two-fill test case from 198 over-dense areas to 1 |
| Path splitting and joining | **Software verified** | split at a node (a ring cut once OPENS); join welds ends and closes rings |
| Offset / inflate / deflate | **Software verified** | Grow/Shrink buttons; refuses open paths with a reason |
| Simplification and node cleanup | **Software verified** | polyline simplify for raw paths, NODE cleanup for Bézier outlines so curves survive |
| Running stitch | **Software verified** | — |
| Bean / triple | **Software verified** | — |
| Satin border / column | **Software verified** | spine and TWO-RAIL columns, mitred corners, refusal with location |
| Tatami fill | **Software verified** | rows, coverage, stagger, holes, length bounds |
| Manual stitches | **Software verified** | `stitchedit.ts` — pick, band-select, move, delete, on the freeze model |
| Appliqué | **Software verified** | placement → STOP → tack-down → STOP → border, each its own block |
| Motif runs and fills | **Software verified** | 8 motifs, unit-cell mapping through the local frame, whole motifs only |
| Stippling | **Software verified** | deterministic wander; ~1/7 the stitches of a tatami; runs unbroken |
| Cross-stitch | **Software verified** | whole crosses only — all four corners inside |
| Contour / echo | **Software verified** | rings entered at the nearest point: 39 trims → 0 |
| Manual satin-angle guides | **Software verified** | relative to the local normal, interpolated, held at the ends |
| Satin splitting | **Software verified** | columns to 30 mm, split points staggered from a deterministic phase |
| Minimum stitch length | **Software verified** | design-aware floor |
| Travel / jump / trim / colour-change behaviour | **Software verified** | asserted at record level against the written file |

### §5 Pipeline

| Feature | Status | Evidence |
| --- | --- | --- |
| objects → geometry → underlay+top → sequencing → encoding | **Implemented** | `digitize.ts` is exactly this shape |
| Holes, stitch-length limits, underlay, entry/exit routing | **Software verified** | — |
| Narrow regions / sharp corners | **Software verified** | corners mitred; same-rail spacing held ≥ 0.3 mm |
| Deterministic generation | **Software verified** | asserted for the engine, for guided satin, for splitting and for stippling |
| One plan drives counts, simulation, inspection, density, export | **Software verified** | single `StitchPlan` |
| Responsive / cancellable | **Implemented** | Worker keyed to the content signature; superseded work terminated |

### §6 Production features

| Feature | Status | Evidence |
| --- | --- | --- |
| Editable lettering | **Software verified** | `TextSpec` regenerates outlines from the words |
| Outlines from supported fonts | **Implemented** | rasterise + trace: every font on the machine, ~0.05 mm error |
| Spacing, sizing, placement | **Implemented** | cap height in mm, tracking, word spacing, slant |
| Text along a path or curve | **Software verified** | `textOnPath`; letter height kept by default, "fit to path" offered and labelled |
| Shaped lettering envelopes | **Software verified** | top/bottom bow independently: arc, fan, pinch |
| Explicit conversion to digitizing objects | **Implemented** | "Convert to outlines", confirmed, one-way |
| Reusable native alphabets | **Software verified** | `alphabets.ts` — outlines not stitches; missing characters reported and left as gaps |
| 3D puff foam | **Software verified** | width band, density scaling, end caps that tear the foam along the stitch line |
| Appliqué and patches | **Software verified** | incl. faux overlock edge and a true-size cut file from the SAME outline |
| Knockdown | **Software verified** | coarse net, expanded past the outline; warns if sewn out of order |
| Curved / gradient / feathered fills, embossing, fringe, freestanding | **Missing** | Recorded, not dropped |
| Custom motifs (user-drawn) | **Missing** | 8 built-in motifs only |
| Branching and connected sewing paths | **Software verified** | `travel.ts` |
| Reusable stitch styles and presets | **Software verified** | `presets.ts`, 9 built-ins, localStorage |
| Custom embroidery-font authoring | **Software verified** | alphabet capture (see above) |
| Batch export | **Implemented** | "All formats" — every format and sidecar from ONE plan |

### §7 Inspection and repair

| Feature | Status | Evidence |
| --- | --- | --- |
| Stitch-point and connecting-line views | **Implemented** | toggleable |
| Sewing playback with movable position | **Implemented** | stitch-out slider |
| Object and colour boundaries | **Implemented** | sequence panel + per-block labels |
| Visible jumps and trims | **Implemented** | jumps drawn dashed; trims still not distinguished from jumps visually |
| Actual generated stitch counts | **Software verified** | from the same plan that is exported |
| Design dimensions and hoop boundaries | **Implemented** | incl. rotated-fit advice and bracket-spacing check |
| Stitch/range selection, move, delete, repair | **Software verified** | `stitchedit.ts` on the freeze model |
| Density visualisation and diagnostics | **Software verified** | penetrations/mm² on a 3×3 window excluding empty cells |
| Density repair | **Implemented** | "fix the overlaps" offered beside the warning; the commonest cause is two objects on one spot |
| Knockdown for textured fabrics | **Software verified** | see §6 |

### §8 Machine export

| Feature | Status | Evidence |
| --- | --- | --- |
| DST record codec | **Software verified** | bit table confirmed against **7 third-party files**; penetration-exact re-encode |
| Independent reader verification | **Software verified** | `independent-check.py` vs pyembroidery, 6 fixtures, orientation ASSERTED not discovered |
| Melco EXP | **Software verified** | same 6 fixtures; agrees with the DST needle for needle |
| Janome JEF | **Software verified** | same; colours snapped to Janome's 78-thread table, and the export says so |
| PES / VP3 / others | **Missing** | Recorded, not dropped |
| Dimensions and orientation preserved | **Software verified** | incl. an off-centre asymmetric fixture |
| Sewing sequence preserved | **Software verified** | penetration order compared element-wise |
| Trims / colour changes encoded | **Software verified** | asserted in the written byte stream, in all three formats |
| Thread information sidecar | **Software verified** | `.col` and `.edr` read back with pyembroidery; plus run sheet and 1:1 template |

### §9 Interface

Workspace, canvas with inch rulers, sewing-sequence view, property panel,
thread colour and code, playback, export, drawing tools, transforms, shape
operations, arrange, presets, alphabets: **Implemented**. A thread chart
browsable by brand code: **Missing** (codes are typed, not picked).

### §10 Milestones

| Milestone | State |
| --- | --- |
| 1 — a complete working path | **Software complete; the gate is unmet.** It closes on a PHYSICAL calibration sewout, not on a passing suite. See the last section. |
| 2 — core professional digitizing | **Complete.** The last gap, manual satin-angle guides, closed 2026-11-13. |
| 3 — production readiness | **Complete.** Puff, patches, stitch-level inspection and repair, density diagnostics, hoop checks, persistence and export reliability. |
| 4 — advanced capability | **Complete except where recorded Missing above**: user-drawn motifs, gradient/feathered/embossed fills, fringe, freestanding lace, and formats beyond DST/EXP/JEF. |

## Fixed this session (committee findings)

Six domain experts reviewed the spec and implementation. Their blockers, and
what was done:

| ID | Finding | State |
| --- | --- | --- |
| B1 | Approach legs were **sewn**, not jumped — a 9.5 mm stitch from hoop centre on every file, and a measured 13.74 mm sewn connector after every colour change | **Fixed + test** |
| B2 | **No trim existed anywhere**; jumps had no tie-off, so a Dahao auto-trim would cut unanchored thread. Travel threshold was conflated with the stitch-length cap | **Fixed + test** (trim = ≥3 jumps; tie-off → trim → jump → tie-in; 6 mm threshold separate from the 10 mm cap; perpendicular locks) |
| B3 | Holes classified by testing `ring[0]`; a counter touching the outline got **filled solid**, and the result depended on SVG vertex order | **Fixed + test** (interior probe point; asserted across all 4 vertex rotations) |
| B5 | **No minimum stitch length** — 10.4% of a donut's stitches under 0.5 mm, shortest 0.001 mm | **Fixed + test** (design-aware floor: a row-turn is legitimately one row spacing) |
| B6 | Satin inner rail collapsed to 0.13 mm on a 2 mm-radius arc; at 5 mm width the column folded through itself; wide columns warned and exported anyway | **Partly fixed + test** (inner-rail clamp, windowed curvature, **refusal** with location for fold-through / over-width / under-width). Rail-pair primitive and corner fans still missing |
| B9 | `verify:dst` printed "all checks passed" with **zero files**; `independent-check.py` accepted a vertically mirrored file | **Fixed** (exits 2; orientation asserted; asymmetric off-centre fixture added) |
| B4 | Overlapping subpaths never unioned — double density or a bald patch | **Fixed + test** |
| B7 | Offset failures silently dropped underlay and pull compensation | **Fixed + test** (reported; plus a bisector fast path with the clipper as fallback) |
| B8 | `digitize()` was synchronous, ~7 s | **Fixed** (worker + fast offsets: 28,944 stitches in 97 ms) |
| B10 | No colour sidecar, run sheet or 1:1 template | **Fixed + test** |

## Second committee round — what it caught, and what was done

A second six-expert panel re-examined the work. **Every defect it found passed
the then-green suite**, which is the point of running it.

| Finding | State |
| --- | --- |
| **The tie-in after every trim collapsed to zero length and was then deleted.** `lock(s, stitches[i+1])` aimed at the point the jump was synthesised from, so `at === toward`, all four lock points landed on one spot, and the short-stitch suppressor absorbed them. The machine cut, travelled, and sewed into bare fabric with nothing anchoring the thread — 9 occurrences across 6 fixtures | **Fixed + byte-level test** |
| **Offset direction inverted on any frame.** A 40x30 frame with a 34x24 window grew when asked to inset. The outline's interior probe point lies inside the WINDOW, so it classified as a hole. Edge underlay would have sewn 1.1 mm outside the finished border | **Fixed + test** (`ringInsideRing`, shared by `geometry`, `boolean` and `offset`) |
| **The fill border bypassed `satinCheck`.** The engine refused a column when the user drew one and silently emitted identical fold-through geometry when a fill generated it | **Fixed + test**, and corners are now mitred so a box border genuinely works |
| **The trim encoding was invented.** Three zero-displacement jumps; 0 of 7 field files do that, and pyembroidery's reader DELETES zero-delta jump runs — an optimiser would have annihilated every trim | **Fixed**: the travel itself is split into >= 3 nonzero jumps |
| Design never returned to origin; `AX`/`AY` carried a live offset, so a repeat/array run would walk | **Fixed** |
| Missing trailing `0x1A`; duplicate trim before every colour change | **Fixed** |
| Colour blocks merged on SCREEN colour, so two different thread codes combined and the run sheet printed only the first | **Fixed + test** |
| Autosave was DELETED whenever it could not be read — including the version-refusal case the gate exists for | **Fixed**: moved aside, never destroyed |
| `useStitchPlan` silently required a referentially stable `doc`; in StoneCut it would spin forever and never generate | **Fixed**: keyed on a content signature, doc read via ref |
| Worker `onerror` leaked the worker and left stale stitches on screen | **Fixed** |
| Placement template silently cropped a design larger than the hoop | **Fixed**: page fits the design, stamped with a warning |
| Run-time estimate charged nothing for jump records | **Fixed** |
| CSS-injection path via colour in the run sheet | **Fixed** (`cssColor` guard) |

**Two regressions I introduced and then caught in live testing**, both from the
SVG flattener's own output rather than synthetic shapes:

- The flattener closes rings with a 0.001 mm gap (its sampling epsilon),
  leaving a degenerate final edge whose bisector is meaningless — enough to
  fail a whole offset. Rings are now deduped at a one-micron tolerance.
- A right angle that survives flattening often arrives split across two
  vertices (74 degrees then 16). The large half is mitred; `satinCheck` now
  ignores the residual turn within a half-width of a corner, instead of
  condemning the column for curvature the mitre already handles.

### Verification as it now stands

- **90 engine assertions**, all passing.
- **6 fixtures** verified against **pyembroidery**, including the `.col`/`.edr`
  sidecars.
- **A byte-level machine-safety gate** (`independent-check.py`) asserting, on
  the decoded records: the approach is needle-up; every colour change is
  followed by a jump; no zero-displacement jump records; jump runs are 1 or
  >= 3, never an ambiguous 2; no sewn stitch over 10 mm or under 0.1 mm;
  **every mid-design trim is tied off AND tied in**; the file is
  512 + 3n + 1 with an EOF marker; `ST` counts every record; `AX`/`AY` are
  zero. This gate is what two review rounds were missing.
- **7 third-party DST files** still verify exactly.

Test suite: **44 assertions, all passing**. Fixtures: 6, all passing against
pyembroidery. Third-party corpus: 7 files, all passing.

### Disagreement with the committee, recorded

The committee recommended excluding the `0xF3` terminator from the header
`ST` count. **Not done:** all 7 third-party files (Embrilliance, Quick
Digitizing, vendor) count it, and matching them is the stronger evidence.
Revisit only with a hexdump that contradicts this.

---

## Integration: why standalone, and what it costs

Building the engine standalone was an engineering call that the StoneCut
audit supports, and a process deviation from §2 that is still owed:

- StoneCut's `App.tsx` is **5,987 lines** in one component with ~150
  `useState` calls, **no test script and no test framework**. The engine's
  44-assertion suite, fixtures and independent Python checker could not have
  been written inside it.
- StoneCut writes a schema version it never reads. Adding an `embroidery` key
  today means an older build — and the MAS build ships a frozen `dist/` —
  opens the file, loads the stones, and **saves it back without the embroidery
  data**. Silent destruction of customer work across two shipping builds.
- Undo is a hardcoded 3-field snapshot declared inside the component.

**Integration is blocked on two prerequisites**, in this order:

1. A real version gate and migration in StoneCut's two loaders, with a
   rejection path for unknown future versions.
2. The engine running in a Worker, so a 7-second synchronous `digitize()`
   never enters a component that re-renders on every zoom frame.

A side effect of the fork is already visible: `gleembroidery/vector.ts` carries
a real SVG-import fix (sub-path sampling starting at the pre-moveto point)
that StoneCut production **does not have**. That fix should be back-ported to
StoneCut regardless of integration timing.

---

## What is still open

Recorded, not dropped:

1. **All of spec §2 — StoneCut integration.** Still blocked on the same two
   prerequisites: a real version gate in StoneCut's two loaders, and the
   engine behind a Worker before it enters a 5,987-line component. The
   subdomain amendment covers shipping, not integration.
2. **A committed golden corpus.** `fixtures/` is gitignored, so nothing
   detects a silent change in generated output between runs. Commit the six
   designs plus hashes and fail the build on an unexplained diff.
3. **Trims are not drawn differently from jumps** on the canvas. The
   inspection view shows both as the same dashed line, which is the one place
   a reader cannot tell a thread cut from a travel.
4. **A browsable thread chart.** Brand codes are typed, not picked from a
   list, so a typo reaches the run sheet.
5. **Two fills side by side still cut** rather than routing a travel through
   one of them. The tool for it today is the entry/exit markers; a
   boundary-following router is real work and is not done.
6. **Missing by design, for now:** user-drawn motifs, gradient / feathered /
   embossed fills, fringe, freestanding lace, PES and other formats.

### Verification as it stands

- **725 engine assertions**, all passing, run by `npm test` and again by the
  deploy script on the droplet before any build is swapped in.
- **6 fixtures × 3 machine formats** (DST, EXP, JEF) read back with
  **pyembroidery** — a separate implementation by other authors — and checked
  for needle count, every needle position, orientation (asserted, never
  discovered), colour changes, and that each format AGREES WITH THE DST
  written from the same plan.
- **A byte-level machine-safety gate** asserting on the decoded records: the
  approach is needle-up; every colour change is followed by a jump; no
  zero-displacement jump records; jump runs are 1 or ≥ 3, never an ambiguous
  2; no sewn stitch over 10 mm or under 0.1 mm; every mid-design trim is tied
  off AND tied in; the file is 512 + 3n + 1 with an EOF marker; `ST` counts
  every record; `AX`/`AY` are zero.
- **7 third-party DST files** still verify exactly.

### Faults found by the suite or the preview since the last update

Worth recording because each passed everything that existed before it:

- **`docSignature` was a hand-written list of fields**, so every setting added
  after it was written changed the document without changing its signature:
  the bar lean, angle guides, appliqué, puff, knockdown, entry and exit all
  moved their controls and regenerated nothing. The canvas kept showing the
  old stitches, which reads exactly like a setting that does nothing. It is
  now taken from the save format, with a test over all 53 saveable settings.
- **Transforms did not carry entry/exit points**, so moving an object left
  its start and end markers behind.
- **Echo fill cut the thread between every ring** — 39 trims for 13 rings on a
  40 mm square — because an offset ring starts wherever the offsetter put its
  first vertex. Found by looking at the preview, not by a test.
- **EXP and JEF were both written upside down**: `planToMoves` already flips
  the document's +Y-down to the machine's +Y-up and both writers flipped
  again. It round-tripped through our own reader perfectly.
- **JEF's colour-change record carries no movement** — readers discard it — so
  every stitch after the first colour change was offset by however far the
  next block began. 39 mm on one fixture, in a file that opens and looks
  plausible.
- **Cross-stitch tested only the cell CENTRE** for insideness, so a cross near
  the edge put half its thread outside the outline.
- **A performance assertion was machine-dependent** ("under 5 ms") and blocked
  a deploy on the droplet. Rewritten to measure a machine-independent
  property — and it then failed honestly, exposing that the signature was
  still materialising the geometry it was about to discard.

## The gate nobody can skip

**Milestone 1 closes on a physical calibration sewout** (committee gate 1.9),
not on a passing test suite: a 100.0 mm square outline (caliper it), an
L-shaped asymmetric marker (orientation, not mirrored), 3/5/7/9 mm stitch
segments, two colour blocks, and a deliberate 40 mm travel with and without
the 3-jump trim signature. Record the BAI controller's trim and jump-count
parameters with the result — they are part of the output contract.

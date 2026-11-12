# Embroidery digitizing — progress

Companion to `embroidery-spec.md` (the standing specification). Updated
2026-11-12 (second committee round).

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
| Engine + app | `~/src/gleembroidery` (standalone Vite app, 17 modules) |
| Target host | `~/src/stonecut` → rhinestones.tshirtbrothers.com |
| Machine | BAI commercial, Tajima DST, bracket spacing configurable |

**The spec (§2) requires an embroidery workspace inside StoneCut. What exists
is a separate app.** This is a known, deliberate deviation, not an oversight —
see "Integration" below. It is the single largest open item.

---

## Feature matrix

### §2 Integration

| Feature | Status | Evidence |
| --- | --- | --- |
| Embroidery workspace inside StoneCut | **Missing** | Zero hits for `embroider\|satin\|\.dst` in `stonecut/src` |
| Rhinestone / embroidery data separation | **Missing** | No shared document exists yet |
| Versioned backward-compatible storage | **Missing** | StoneCut writes `v: 1` (`App.tsx:360`, `:4008`) and **reads it nowhere**; both loaders duck-type |
| Shared artwork with explicit derivatives | **Missing** | — |
| Background generation keyed to project+revision | **Software verified** | `useStitchPlan` keys on a document CONTENT signature; stale revisions discarded on arrival and superseded workers terminated |
| Existing rhinestone workflow unaffected | **Implemented** | Nothing in StoneCut has been modified |

### §3 Object model

| Feature | Status | Evidence |
| --- | --- | --- |
| Source artwork / objects / stitch plan kept separate | **Software verified** | `model.ts` objects → `digitize.ts` → `stitches.ts`; plan regenerated on every change |
| Stable object identity, layer membership | **Implemented** | `newObject()` ids; flat list, no layers yet |
| Editable outlines | **In progress** | Paths are flattened polylines — **no Bézier nodes, no handle editing** |
| Holes | **Software verified** | `toRegions` + selftest "hole touching the outline", 4 vertex rotations |
| Satin rails and stitch-angle guides | **Missing** | Satin is a centreline + scalar width, not a rail pair |
| Stitch type + parameters, density, lengths, underlay, pull comp | **Software verified** | `model.ts`; each asserted in selftest |
| Entry / exit points | **Missing** | Implicit from path order |
| Tie-in / tie-off settings | **In progress** | Locks are generated (`digitize.ts` `lock()`), not yet user-settable |
| Thread assignment | **Implemented** | `ThreadRef{brand,code,name}` per object; run sheet prints it, or UNASSIGNED. Colour blocks merge on THREAD, not screen colour |
| Sewing order | **Implemented** | Document order with up/down reorder in the Sewing sequence panel |
| Branching / connected objects | **Missing** | — |
| Millimetres throughout, inches displayed | **Software verified** | mm everywhere above `dst.ts`; independent check confirms dimensions survive export |
| Save / reopen preserving editability | **Software verified** | `project.ts` `.gleemb`; test asserts every field round-trips AND that a reopened project re-digitises byte-identically |
| Imported stitch files stay identified as stitch data | **Implemented** | DST import loads as a read-only grey reference, never as objects |

### §4 Digitizing features

| Feature | Status | Evidence |
| --- | --- | --- |
| SVG import at correct physical scale | **Implemented** | `vector.ts`; verified in-browser against a mm-dimensioned SVG |
| Raster import | **Missing** | StoneCut's `imageToColorLayers` is the port path |
| Point / freehand / Bézier drawing, node editing | **Missing** | No drawing tools |
| Shapes with holes | **Software verified** | see §3 |
| Align / distribute / rotate / mirror / duplicate | **Missing** | — |
| Selection, grouping, layers, undo/redo | **Missing** | Single selection only; **no undo** |
| Union / intersection / subtraction / flatten | **In progress** | Self-union runs on every fill (`unionSelfChecked`), software verified; no UI for explicit booleans |
| Offset / inflate / deflate | **In progress** | Bisector fast path with the Minkowski clipper as fallback; direction verified on donuts and frames; no UI |
| Running stitch | **Software verified** | selftest resample + length bounds |
| Bean / triple | **Implemented** | `beanStitch`; no dedicated test |
| Satin border / column | **In progress** | Generates, **mitres corners**, refuses unsewable geometry; **not a true rail-pair column** |
| Tatami fill | **Software verified** | row count, coverage, stagger (with control), holes, max/min length |
| Manual stitches, appliqué, motif, stipple, cross-stitch, contour | **Missing** | — |
| Minimum stitch length | **Software verified** | `MIN_STITCH_MM`, design-aware floor, asserted on donut + tapering leaf |
| Travel / jump / trim / colour-change behaviour | **Software verified** | asserted at record level against the written file |

### §5 Pipeline

| Feature | Status | Evidence |
| --- | --- | --- |
| objects → geometry → underlay+top → sequencing → encoding | **Implemented** | `digitize.ts` is exactly this shape |
| Holes, stitch-length limits, underlay, entry/exit routing | **Software verified** | selftest |
| Narrow regions / sharp corners | **Software verified** | Corners detected and mitred with an outer fan on a pivoting inner rail; same-rail spacing held >= 0.3 mm on box, L and 40-degree chevron |
| Deterministic generation | **Software verified** | Asserted: three runs of the same document produce byte-identical output |
| One plan drives counts, simulation, inspection, export | **Software verified** | single `StitchPlan` consumed by renderer, status bar and writer |
| Responsive / cancellable | **Implemented** | Web Worker keyed to a content signature, superseded work terminated; 28,944 stitches in ~97 ms (was ~7 s) |

### §6 Production features

Lettering, 3D puff foam, appliqué/patches, and every item under "Advanced
tools": **Missing**. Recorded, not dropped.

### §7 Inspection and repair

| Feature | Status | Evidence |
| --- | --- | --- |
| Stitch-point and connecting-line views | **Implemented** | `render.ts`, toggleable |
| Sewing playback with movable position | **Implemented** | stitch-out slider |
| Visible jumps and trims | **Implemented** | jumps drawn dashed; trims not yet distinguished visually |
| Actual generated stitch counts | **Software verified** | from the same plan that is exported |
| Hoop boundaries + overflow warning | **Implemented** | incl. rotated-fit advice and bracket-spacing check |
| Stitch/range selection, move, delete, repair | **Missing** | — |
| Density visualisation and diagnostics | **Missing** | — |

### §8 Machine export

| Feature | Status | Evidence |
| --- | --- | --- |
| DST record codec | **Software verified** | Bit table, extents, ST and CO confirmed against **7 third-party files** (3.4k–22.9k stitches); penetration-exact re-encode |
| Independent reader verification | **Software verified** | `independent-check.py` vs **pyembroidery**, 6 fixtures, orientation asserted (not discovered) |
| Dimensions and orientation preserved | **Software verified** | incl. an off-centre asymmetric fixture so `+X != -X` and `+Y != -Y` |
| Sewing sequence preserved | **Software verified** | penetration order compared element-wise |
| Trims / colour changes encoded | **Software verified** | trim = ≥3 jump records; asserted in the written byte stream |
| Appropriate termination | **Software verified** | pyembroidery reports `END` on every fixture |
| Thread information sidecar | **Software verified** | `.col` and `.edr` byte-identical to pyembroidery's writers and read back with it; plus an HTML run sheet and a 1:1 placement template |
| Other formats (PES/EXP/JEF) | **Missing** | Deliberate: DST covers the BAI |

### §9 Interface

Workspace, canvas with inch rulers, object list, property panel, thread
colour, playback, export: **Implemented**. Sewing-sequence view (distinct
from the object list), thread chart with codes, drawing tools, transforms:
**Missing**.

---

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

## Next three implementation tasks

1. **Commit a golden corpus and wire it into `npm test`.** `fixtures/` is
   gitignored, so nothing detects a silent change in generated output between
   runs. Commit the six `.dst` files plus hashes; fail the build on any
   unexplained diff. Add at least two third-party DSTs to the repo so
   `verify:dst` runs without depending on `~/Downloads`.
2. **Rail-pair satin.** Replace the centreline-plus-width primitive with
   `railA` / `railB` plus ordered angle guides, keeping centreline+width as a
   convenience constructor. This is what real satin lettering needs and it is
   the largest remaining engine gap. Test: a variable-width column holds its
   rails; the existing corner and curvature tests keep passing.
3. **Travel routing that follows the boundary.** Today travel is
   straight-line-inside or jump. Walking around an obstacle along an inset of
   the region would cut the trim count substantially — the biggest cycle-time
   driver after stitch count. Test: a donut fill produces no trim where a
   boundary-following route exists.

Still open and recorded, not dropped: no undo/redo anywhere; no drawing or
node-editing tools (objects come only from SVG import); no lettering; no
appliqué and no representable STOP distinct from a colour change; trims are
not drawn differently from jumps on canvas; and all of spec §2 StoneCut
integration beyond the worker's revision guard.

## The gate nobody can skip

**Milestone 1 closes on a physical calibration sewout** (committee gate 1.9),
not on a passing test suite: a 100.0 mm square outline (caliper it), an
L-shaped asymmetric marker (orientation, not mirrored), 3/5/7/9 mm stitch
segments, two colour blocks, and a deliberate 40 mm travel with and without
the 3-jump trim signature. Record the BAI controller's trim and jump-count
parameters with the result — they are part of the output contract.

# Embroidery digitizing — standing specification

> This is the project's standing specification, recorded verbatim as issued.
> It stays active across context resets. Status tracking lives in
> `embroidery-progress.md`.

Target application: **rhinestones.tshirtbrothers.com** (this repo, StoneCut).
Functional benchmark: Embrilliance StitchArtist's publicly documented
capabilities. Build within the existing architecture, branding and workflow.

The goal is a working embroidery production tool: users must be able to
create editable embroidery objects, generate actual stitches, inspect the
sewing sequence, save their work, and export valid embroidery machine files.

---

## 1. Inspect the existing project before changing it

Read the repository instructions, existing documentation, and relevant
implementation.

Identify:

- The application framework and rendering system.
- Existing artwork import, vector editing, selection, layers, and
  transformation tools.
- How rhinestone designs are represented, saved, and exported.
- Existing authentication, account ownership, and project storage.
- Embroidery functionality already implemented.
- Features that are complete, partially implemented, visual placeholders, or
  missing.

Continue from working code. Preserve existing user work and unrelated changes.

Create or update these documents in the project's appropriate documentation
directory:

- **embroidery-spec.md:** The agreed scope, architecture, and feature
  requirements.
- **embroidery-progress.md:** Completed work, verification evidence, known
  limitations, and the next implementation task.

Maintain a feature matrix with these statuses:

**Missing → In progress → Implemented → Software verified → Sewout verified,
when applicable.**

Only assign a status when evidence supports it.

## 2. Integrate embroidery into the existing application

> **AMENDMENT, 2026-11-12 — agreed with Kevin.** The embroidery tool ships at
> its own subdomain, **threads.tshirtbrothers.com**, rather than as a mode
> inside rhinestones.tshirtbrothers.com. This is a deliberate change to this
> section, recorded here rather than left as a silent divergence.
>
> *Why:* integration is blocked on two prerequisites that should not gate
> shipping — StoneCut writes a `v: 1` schema version and reads it nowhere, so
> adding an embroidery key today would make an older build (including the
> frozen MAS `dist/`) silently strip that data on the next save; and
> generation must move behind a Worker before it enters a 5,987-line
> component that re-renders on every zoom frame. Separately, the engine's
> verification suite could not have been written inside a repo with no test
> framework.
>
> *What this does NOT change:* integration is still owed, and the rest of this
> section still applies to it. Two sites means artwork is imported twice and
> projects are not shared — that is the accepted cost for now. A subdomain can
> become a workspace later; the object model and the stitch engine are
> unchanged either way.
>
> The two tools are siblings on one droplet and are deployed the same way on
> purpose: `rhinestones` → `/var/www/stonecut/html`,
> `threads` → `/var/www/gleembroidery/html`, each with a `deploy.sh` that
> clones, builds, verifies and swaps in the build with a `.prev` rollback.

Add a clearly identifiable **Embroidery workspace or mode** — at
threads.tshirtbrothers.com per the amendment above — using the application's
established navigation and design system.

Reuse suitable foundations, including:

- Artwork import and asset management.
- Vector geometry utilities.
- Canvas navigation, zoom, and pan.
- Selection and transformation infrastructure.
- Layer management and undo/redo infrastructure.
- Authentication and project storage.

Keep production data distinct:

- **Rhinestone data:** Stone positions, sizes, spacing, materials, and
  cutting instructions.
- **Embroidery data:** Digitizing objects, stitch settings, thread colors,
  sewing order, underlay, and machine commands.

Shared artwork may seed either process. Any conversion must create an
explicit derivative and preserve its source.

Switching workspaces must preserve unsaved work and restore the correct
tools, selections, and settings. Keyboard shortcuts and undo operations must
behave predictably within the active workspace.

Existing rhinestone projects must continue to open, edit, save, and export
correctly. Extend storage through versioned, backward-compatible changes.

Background stitch generation must be associated with the correct project and
revision. Discard outdated results so an earlier calculation cannot overwrite
a newer edit.

## 3. Build an editable embroidery object model

Maintain separate representations for:

1. **Source artwork:** Imported images, vector paths, and text references.
2. **Digitizing objects:** Editable shapes with embroidery-specific
   properties.
3. **Generated stitch plans:** Ordered needle movements and machine
   operations.

A digitizing object should retain, as applicable:

- Stable object identity and layer membership.
- Editable outlines, Bézier nodes, and holes.
- Satin rails and stitch-angle guides.
- Stitch type and its parameters.
- Density or spacing.
- Stitch-length settings.
- Underlay settings.
- Pull compensation.
- Entry and exit points.
- Tie-in and tie-off settings.
- Thread assignment.
- Sewing order.
- Relationships to connected or branched objects.

Store physical dimensions in a documented unit, preferably millimeters.
Display inches where useful. Zoom and screen resolution must not change
production dimensions.

Saving and reopening a native project must preserve editability. A rendered
preview is insufficient.

Imported machine stitch files must remain clearly identified as stitch data
unless an explicit reconstruction process creates new editable objects. Do
not imply that original digitizing geometry has been recovered automatically.

## 4. Implement the core digitizing features

### Drawing and artwork

Provide:

- Raster artwork import with explicit sizing.
- SVG import with correct physical scale.
- Point, freehand, and true Bézier drawing.
- Node and curve-handle editing.
- Open and closed paths.
- Shapes containing holes.
- Basic geometric shapes.
- Alignment, distribution, rotation, mirroring, and duplication.
- Reliable selection, grouping, layers, and undo/redo.

Add advanced shape operations as the core becomes stable:

- Union, intersection, subtraction, and flattening.
- Path splitting and joining.
- Offset/inflate/deflate.
- Shape simplification and node cleanup.
- Assisted tracing for suitable artwork.

Tracing assistance must produce geometry the user can inspect and edit.

### Core stitch types

Implement actual stitch generation for:

- Manual stitches.
- Single and double running stitches.
- Bean/reinforced running stitches.
- Satin borders.
- Satin columns.
- Fill stitching.
- Appliqué sequences.

Then expand to:

- Motif runs and fills.
- Stippling.
- Cross-stitch.
- Contour/echo stitching.
- Other decorative run styles.

### Stitch controls

Make these settings affect the actual generated stitches:

- Stitch length.
- Density or row spacing, with explicit units.
- Stitch direction.
- Manual satin-angle guides.
- Satin splitting.
- Pull compensation.
- Underlay type, spacing, and inset.
- Entry and exit placement.
- Tie-in and tie-off behavior.
- Object sewing order.
- Travel, jump, trim, and color-change behavior, as supported by the output
  format.

Every visible setting must either work or be clearly marked unavailable.

## 5. Build a genuine stitch-generation pipeline

Use this processing model:

**Editable objects → geometry preparation → underlay and top-stitch
generation → sequencing and travel planning → machine-format encoding.**

The engine must account for:

- Object boundaries and holes.
- Narrow regions and sharp corners.
- Curved satin geometry.
- Configurable stitch-length limits.
- Underlay placement.
- Changes in stitch direction.
- Entry and exit routing.
- Connections between objects.
- Thread changes and machine operations.

Keep generation deterministic: identical source data and settings should
produce the same stitch plan.

Use the same generated stitch plan for:

- Stitch counts.
- Sewing simulation.
- Stitch inspection.
- Density analysis.
- Machine-file export.

A decorative thread texture or canvas effect does not establish that
digitizing works. Random stitch patterns, invented stitch counts, and
simulated export success are unacceptable substitutes for the production
pipeline.

For computationally expensive operations, keep the interface responsive and
provide cancellation or progress reporting tied to actual work.

## 6. Add the production features needed for T-Shirt Brothers

### Lettering

Support:

- Editable lettering.
- Importing or deriving outlines from supported fonts.
- Spacing, sizing, and placement controls.
- Text along a path or curve.
- Shaped lettering envelopes.
- Explicit conversion of lettering into editable digitizing objects.

Font outlines require suitable embroidery treatment. Make the resulting
stitch construction inspectable and adjustable.

Build reusable native embroidery alphabets and font libraries as the system
matures. Track external font-format compatibility separately and only claim
support after it is verified.

### 3D puff foam

Provide a dedicated workflow for suitable satin objects, including:

- Foam-specific stitch settings.
- Capping and end treatment.
- Connections and overlaps.
- Coverage and sewing-order controls.
- Clear feedback for unsuitable geometry.

Treat puff as a specialized digitizing process. A finished stitch file must
not receive an unsupported universal "convert to puff" promise.

### Appliqué and patches

Support:

- Placement stitching.
- Tack-down/material stitching.
- Finishing borders.
- Configurable stops and sewing order.
- Cutting outlines with correct dimensions.
- Satin patch borders.

Add a faux overlock patch-edge treatment as an advanced milestone.

### Advanced tools

Maintain these on the roadmap:

- Curved, gradient, and feathered fills.
- Fill embossing.
- Custom motifs.
- Fringe and decorative effects.
- Freestanding embroidery structures.
- Branching and connected sewing paths.
- Reusable stitch styles and presets.
- Custom embroidery-font authoring.
- Batch export.

These remain visible requirements until implemented or explicitly deferred.

## 7. Include stitch inspection and repair

Provide a production inspection workspace with:

- Stitch-point and connecting-line views.
- Sewing playback with a movable position.
- Object and color boundaries.
- Visible jumps and trims.
- Actual generated stitch counts.
- Design dimensions and hoop boundaries.
- Selection of individual stitches or stitch ranges.
- Appropriate move, delete, and repair operations.
- Density visualization and useful diagnostics.

Keep source-object editing and direct stitch editing explicit. Define what
happens when the source regenerates after manual stitch edits, and prevent
silent loss of those edits.

Add knockdown stitching for textured fabrics and density-repair tools in a
defined production milestone.

Diagnostics should identify concrete conditions the user can act on. Preview
approval and physical sewout approval must remain separate.

## 8. Deliver valid machine exports

First deliver a real, independently checked **DST export**, then add
additional machine formats through genuine encoders.

For every supported format:

- Preserve intended physical dimensions and orientation.
- Preserve the generated sewing sequence.
- Encode supported operations correctly.
- Handle the format's precision and metadata limits.
- Include appropriate termination.
- Provide accompanying thread information when required.

Changing a filename extension does not create format support.

Reopen exported files with an independent reader or viewer and compare the
result with the intended stitch plan. Check bounds, orientation, stitch
structure, and supported machine operations.

Make the active export context obvious: rhinestone production and embroidery
production must use their respective data and exporters.

Keep the editable native project separate from the machine export.

## 9. Keep the interface focused on digitizing

Build a professional workspace consistent with the existing T-Shirt Brothers
application.

Use clear areas for:

- Artwork and drawing tools.
- Canvas and physical rulers.
- Object/layer list.
- Sewing sequence.
- Selected-object stitch properties.
- Thread colors.
- Playback and inspection.
- Save and export.

Use plain labels such as **Stitch spacing**, **Underlay**, **Pull
compensation**, and **Start point**.

Prioritize accurate geometry, usable controls, responsive editing, and
legible previews.

Do not expand this work into unrelated commerce, marketing, or administration
features. Preserve existing integrations where they already belong.

## 10. Implement in milestones with completion gates

### Milestone 1: A complete working path

Deliver this entire sequence:

**Create/import artwork → create an embroidery object → generate stitches →
change settings → inspect playback → save/reopen the editable project →
export DST → independently reopen the export.**

Include a running-stitch object and a filled shape with a hole.

Verify that the existing rhinestone workflow still functions.

### Milestone 2: Core professional digitizing

Complete: Bézier editing and SVG handling; satin columns with manual angle
control; fill settings and clipping; underlay; compensation; entry/exit
control; sequencing; editable lettering; appliqué.

### Milestone 3: Production readiness

Complete: puff-foam workflows; patch workflows; stitch-level inspection and
repair; density diagnostics; hoop checks; persistence and export reliability.

### Milestone 4: Advanced capability

Complete the remaining shape operations, decorative stitches, branching,
presets, reusable fonts, and batch tools.

Finish the active milestone before spending time on unrelated polish. Keep
deferred work recorded rather than silently dropping it.

## 11. Verify representative designs

Use meaningful fixtures that expose real failure modes:

- A filled shape with an internal hole.
- A curved satin letter.
- A narrow satin region and a sharp corner.
- Overlapping objects with different thread colors.
- An appliqué design with ordered production steps.
- A suitable puff-foam example.
- A design resized and rotated before export.
- A native project saved, closed, and reopened.
- Existing rhinestone projects opened and exported after integration.

Verify dimensional accuracy, deterministic generation, persistence, and
export behavior.

Report software verification honestly. Use **physically sew-tested** only
when an actual machine sewout has been performed and documented.

## 12. Working rules and session handoff

At the beginning of each session, read the specification and progress
documents and resume the next incomplete task.

Make routine implementation decisions using the existing architecture. Ask
questions only when a missing decision materially blocks the work.

Do not finish with a plan when the authorized implementation can proceed.

At each handoff, report:

1. What now works.
2. What was verified and how.
3. What remains incomplete.
4. Any concrete blocker.
5. The exact next implementation task.

Update the feature matrix and progress document before ending the session.

---

### Reference

- https://embrilliance.com/stitchartist
- https://embrilliance.com/product/stitchartist-level-2
- https://embrilliance.com/product/stitchartist-level-3
- https://embrilliance.com/start/selectionguide

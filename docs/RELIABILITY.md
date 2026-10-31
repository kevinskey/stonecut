# StoneCut reliability release

Implemented and tested in software:

- Consistent whole-design publishing; preserved saved hole diameters.
- Fixed weeding-frame origin/datum; final geometry and spacing preflight.
- Frozen job confirmations, verified USB byte/status handling, single-send lock,
  explicit multi-device chooser, and confirmed diagnostic L cuts.
- Validated versioned projects with media/color/production context; visible
  recovery status, downloadable backup, and named local project versions.
- Guided starting actions, workspaces, readable text, keyboard menus,
  collapsible small-screen tools, and original/mask/stone image comparison.
- Exact spatial nearest-neighbor ordering with deterministic tie behavior;
  split/cached font and vendor bundles; optional ZIP module loads on demand.
- Whole-design production ZIP; explicit DXF millimeter units; escaped print
  titles; consistent per-color order-quantity totals.
- Session-scoped publishing-key storage with constrained API destinations.
- Restricted desktop navigation and USB permissions; relative bundled asset
  paths for offline fallback. Desktop binaries require rebuilding to receive
  these shell changes; external font/OCR services still need connectivity.
- Source CI tests/lint/build and pinned, rollback-capable droplet releases.

Validation boundaries:

No physical cutter commands or production cutter-setting changes are part of
this release process. USB protocol behavior, firmware circles, blade/force
presets, material tolerances, browser/OS USB support, print scaling, Cricut
import scaling, and desktop distribution/signing require separate operational
validation. Successful transmission is not reported as completed cutting.

The TSB publishing API still uses a shared server-side key. Session storage
reduces persistence; user-scoped authentication needs coordinated backend work.
No customer designs are published merely to test deployment.

The public domain relationship is established only by observed DNS/HTTP/nginx
results. Do not redirect domains without planning migration of origin-bound
browser projects, file handles, fonts, and USB grants.

Further product opportunities are not represented as completed bug fixes:
customer/order-linked cloud project history, cross-device sync, proof approval,
measured brushing/cutting cost calibration, automatic nesting, and inventory
integration require backend/workflow design and business validation. Existing
team-name and step/repeat tools remain available.

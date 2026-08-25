/**
 * LatticeFill — a constraint-based lattice fill / pattern fill engine.
 *
 * ARCHITECTURE
 * ------------
 *   Container          arbitrary closed geometry (circle, polygon, SVG path,
 *                      text outlines, compound shapes with holes)
 *   Body               the repeated object (circles/rhinestones built in;
 *                      extensible to any shape that can report a bounding
 *                      radius and a containment/overlap test)
 *   CandidateGenerator interchangeable placement strategies:
 *                      square | hex | radial | contour | adaptive
 *   PlacementRules     containment + edge clearance + spacing + collision
 *   Optimizer          optional offset/rotation search, mixed sizes,
 *                      pluggable layout scoring
 *
 * The packing loop (`fill`) never inspects what kind of geometry it is
 * filling — it only talks to the Container interface:
 *     getBounds() / containsPoint(x,y) / distanceToEdge(x,y) / containsBody(b)
 *
 * EXTENDING
 * ---------
 *  - New container: subclass Container, implement the four methods.
 *  - New body: subclass Body (boundingRadius, overlaps, createAt).
 *  - New generator: object with getCandidates(container, body, pattern).
 *  - New score: pass { score: (layout, container) => number } in optimize.
 */

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

function pointSegDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return dist2(px, py, ax + t * dx, ay + t * dy);
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export class Container {
  getBounds() { throw new Error('implement getBounds'); }
  containsPoint(_x, _y) { throw new Error('implement containsPoint'); }
  distanceToEdge(_x, _y) { throw new Error('implement distanceToEdge'); }
  // Full-body containment: default for circular bodies uses distanceToEdge.
  containsBody(body) {
    return (
      this.containsPoint(body.x, body.y) &&
      this.distanceToEdge(body.x, body.y) >= body.boundingRadius()
    );
  }
  centroid() {
    const b = this.getBounds();
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
}

export class CircleContainer extends Container {
  constructor(cx, cy, r) { super(); this.cx = cx; this.cy = cy; this.r = r; }
  getBounds() {
    return { minX: this.cx - this.r, minY: this.cy - this.r, maxX: this.cx + this.r, maxY: this.cy + this.r };
  }
  containsPoint(x, y) { return dist2(x, y, this.cx, this.cy) <= this.r * this.r; }
  distanceToEdge(x, y) { return this.r - Math.hypot(x - this.cx, y - this.cy); }
  centroid() { return { x: this.cx, y: this.cy }; }
}

/**
 * PolygonContainer: one or more closed contours (arrays of {x,y}).
 * Even-odd rule — inner contours are holes, so text counters (O, B, A…)
 * and compound/disconnected shapes work automatically.
 */
export class PolygonContainer extends Container {
  constructor(contours) {
    super();
    // accept a single ring or a list of rings
    this.contours = Array.isArray(contours[0]) ? contours : [contours];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of this.contours)
      for (const p of c) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    this.bounds = { minX, minY, maxX, maxY };
  }
  getBounds() { return this.bounds; }
  containsPoint(x, y) {
    let inside = false;
    for (const c of this.contours) {
      for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
        const a = c[i], b = c[j];
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
          inside = !inside;
      }
    }
    return inside;
  }
  distanceToEdge(x, y) {
    let best = Infinity;
    for (const c of this.contours) {
      for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
        const d = pointSegDist2(x, y, c[j].x, c[j].y, c[i].x, c[i].y);
        if (d < best) best = d;
      }
    }
    const d = Math.sqrt(best);
    return this.containsPoint(x, y) ? d : -d; // signed: negative outside
  }
  /** All contours concatenated as closed paths, for contour/outline modes. */
  getContours() { return this.contours; }
}

// ---------------------------------------------------------------------------
// SVG path support
// ---------------------------------------------------------------------------

/**
 * Flatten a closed SVG path (M/L/H/V/C/S/Q/T/A subset — A approximated by
 * line-to for brevity; extend flattenArc for exact arcs) into polygon
 * contours, then wrap in a PolygonContainer. Handles compound paths (several
 * M…Z sub-paths) — holes fall out of the even-odd rule.
 */
export function svgPathToContainer(d, curveSegments = 16) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const contours = [];
  let cur = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  let prevCtrl = null;
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  const bez = (x1, y1, x2, y2, ex, ey) => {
    for (let k = 1; k <= curveSegments; k++) {
      const t = k / curveSegments, mt = 1 - t;
      cur.push({
        x: mt ** 3 * x + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t ** 3 * ex,
        y: mt ** 3 * y + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t ** 3 * ey,
      });
    }
    x = ex; y = ey;
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        if (cur.length > 2) contours.push(cur);
        cur = [];
        const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
        x = startX = nx; y = startY = ny;
        cur.push({ x, y });
        break;
      }
      case 'L': { x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); cur.push({ x, y }); break; }
      case 'H': { x = num() + (rel ? x : 0); cur.push({ x, y }); break; }
      case 'V': { y = num() + (rel ? y : 0); cur.push({ x, y }); break; }
      case 'C': {
        const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0);
        const x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0);
        const ex = num() + (rel ? x : 0), ey = num() + (rel ? y : 0);
        bez(x1, y1, x2, y2, ex, ey);
        prevCtrl = { x: x2, y: y2 };
        break;
      }
      case 'S': {
        const x1 = prevCtrl ? 2 * x - prevCtrl.x : x, y1 = prevCtrl ? 2 * y - prevCtrl.y : y;
        const x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0);
        const ex = num() + (rel ? x : 0), ey = num() + (rel ? y : 0);
        bez(x1, y1, x2, y2, ex, ey);
        prevCtrl = { x: x2, y: y2 };
        break;
      }
      case 'Q': {
        const qx = num() + (rel ? x : 0), qy = num() + (rel ? y : 0);
        const ex = num() + (rel ? x : 0), ey = num() + (rel ? y : 0);
        // convert quadratic to cubic
        bez(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
            ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        prevCtrl = { x: qx, y: qy };
        break;
      }
      case 'Z': {
        if (cur.length > 2) { cur.push({ x: startX, y: startY }); contours.push(cur); }
        cur = [];
        x = startX; y = startY;
        break;
      }
      default: /* unsupported (A/T) — approximate with line */ {
        x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); cur.push({ x, y });
      }
    }
  }
  if (cur.length > 2) contours.push(cur);
  return new PolygonContainer(contours);
}

/**
 * Text support: convert glyph outlines to contours FIRST (e.g. with
 * opentype.js: font.getPath(text, x, y, size).commands) and feed the result
 * here. The engine treats text as geometry — counters become holes via the
 * even-odd rule, exactly per spec.
 */
export function textCommandsToContainer(commands, curveSegments = 12) {
  const contours = [];
  let cur = [], x = 0, y = 0, sx = 0, sy = 0;
  const push = (p) => cur.push(p);
  for (const c of commands) {
    if (c.type === 'M') {
      if (cur.length > 2) contours.push(cur);
      cur = []; x = sx = c.x; y = sy = c.y; push({ x, y });
    } else if (c.type === 'L') { x = c.x; y = c.y; push({ x, y }); }
    else if (c.type === 'Q' || c.type === 'C') {
      for (let k = 1; k <= curveSegments; k++) {
        const t = k / curveSegments, mt = 1 - t;
        if (c.type === 'Q')
          push({ x: mt * mt * x + 2 * mt * t * c.x1 + t * t * c.x,
                 y: mt * mt * y + 2 * mt * t * c.y1 + t * t * c.y });
        else
          push({ x: mt ** 3 * x + 3 * mt * mt * t * c.x1 + 3 * mt * t * t * c.x2 + t ** 3 * c.x,
                 y: mt ** 3 * y + 3 * mt * mt * t * c.y1 + 3 * mt * t * t * c.y2 + t ** 3 * c.y });
      }
      x = c.x; y = c.y;
    } else if (c.type === 'Z') {
      if (cur.length > 2) { cur.push({ x: sx, y: sy }); contours.push(cur); }
      cur = [];
    }
  }
  if (cur.length > 2) contours.push(cur);
  return new PolygonContainer(contours);
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export class Body {
  boundingRadius() { throw new Error('implement'); }
  overlaps(_other, _gap) { throw new Error('implement'); }
}

export class CircleBody extends Body {
  constructor(x, y, diameter, sizeId = null) {
    super();
    this.x = x; this.y = y; this.diameter = diameter; this.sizeId = sizeId;
    this.rotation = 0;
  }
  boundingRadius() { return this.diameter / 2; }
  /** squared-distance comparison — no sqrt in the hot loop */
  overlaps(other, gap = 0) {
    const min = (this.diameter + other.diameter) / 2 + gap;
    return dist2(this.x, this.y, other.x, other.y) < min * min;
  }
}

export function circleBodyDefinition(diameter, sizeId = null) {
  return {
    type: 'circle',
    diameter,
    sizeId,
    createAt: (p) => new CircleBody(p.x, p.y, diameter, sizeId),
    boundingRadius: () => diameter / 2,
  };
}

// ---------------------------------------------------------------------------
// Spatial hash — O(1)-ish neighborhood queries for thousands of bodies
// ---------------------------------------------------------------------------

export class SpatialHash {
  constructor(cellSize) { this.cell = Math.max(cellSize, 1e-6); this.map = new Map(); }
  key(cx, cy) { return cx + ':' + cy; }
  insert(body) {
    const cx = Math.floor(body.x / this.cell), cy = Math.floor(body.y / this.cell);
    const k = this.key(cx, cy);
    const arr = this.map.get(k);
    if (arr) arr.push(body); else this.map.set(k, [body]);
  }
  /** neighbors within one cell ring — cell size must be >= max interaction distance */
  neighbors(x, y) {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    const out = [];
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const arr = this.map.get(this.key(gx, gy));
        if (arr) out.push(...arr);
      }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------

export class PlacementRules {
  constructor({ gap = 0, edgeMargin = 0, preventOverlap = true } = {}) {
    this.gap = gap; this.edgeMargin = edgeMargin; this.preventOverlap = preventOverlap;
  }
  meetsEdgeClearance(body, container) {
    // full body inside: distance from center to edge >= radius + margin
    return container.distanceToEdge(body.x, body.y) >= body.boundingRadius() + this.edgeMargin;
  }
  overlapsAny(body, hash) {
    if (!this.preventOverlap) return false;
    for (const other of hash.neighbors(body.x, body.y))
      if (body.overlaps(other, this.gap)) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Candidate generators — interchangeable strategies
// ---------------------------------------------------------------------------

/** shared: apply rotation about centroid + offset to a raw lattice point */
function transformPoint(px, py, cx, cy, cos, sin, offsetX, offsetY) {
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * cos - dy * sin + offsetX, y: cy + dx * sin + dy * cos + offsetY };
}

export const SquareGridGenerator = {
  getCandidates(container, bodyDef, pattern = {}) {
    const { gap = 0, rotation = 0, offsetX = 0, offsetY = 0 } = pattern;
    const pitch = bodyDef.diameter + gap;
    return latticeCandidates(container, pitch, pitch, 0, rotation, offsetX, offsetY);
  },
};

export const HexGridGenerator = {
  getCandidates(container, bodyDef, pattern = {}) {
    const { gap = 0, rotation = 0, offsetX = 0, offsetY = 0 } = pattern;
    const pitch = bodyDef.diameter + gap;         // center-to-center
    const spacingX = pitch;
    const spacingY = (pitch * Math.sqrt(3)) / 2;  // row height
    return latticeCandidates(container, spacingX, spacingY, spacingX / 2, rotation, offsetX, offsetY);
  },
};

function latticeCandidates(container, spacingX, spacingY, altRowOffset, rotationDeg, offsetX, offsetY) {
  const b = container.getBounds();
  const c = container.centroid();
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // over-scan so a rotated lattice still covers the bounds
  const half = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + spacingX;
  const out = [];
  let row = 0;
  for (let y = c.y - half; y <= c.y + half; y += spacingY, row++) {
    const off = row % 2 === 1 ? altRowOffset : 0;
    for (let x = c.x - half + off; x <= c.x + half; x += spacingX)
      out.push(transformPoint(x, y, c.x, c.y, cos, sin, offsetX, offsetY));
  }
  return out;
}

/** Radial: concentric rings around the centroid — medallions, badges, halos. */
export const RadialGenerator = {
  getCandidates(container, bodyDef, pattern = {}) {
    const { gap = 0, offsetX = 0, offsetY = 0 } = pattern;
    const pitch = bodyDef.diameter + gap;
    const c = container.centroid();
    const b = container.getBounds();
    const maxR = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2;
    const out = [{ x: c.x + offsetX, y: c.y + offsetY }];
    for (let r = pitch; r <= maxR; r += pitch * Math.sqrt(3) / 2) {
      const n = Math.max(1, Math.floor((TAU * r) / pitch));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU;
        out.push({ x: c.x + r * Math.cos(a) + offsetX, y: c.y + r * Math.sin(a) + offsetY });
      }
    }
    return out;
  },
};

/** Contour: equal arc-length points along each boundary contour (outline mode). */
export const ContourGenerator = {
  getCandidates(container, bodyDef, pattern = {}) {
    const { gap = 0, inset = 0 } = pattern;
    const pitch = bodyDef.diameter + gap;
    if (!container.getContours) throw new Error('contour generator needs a polygonal container');
    const out = [];
    for (const contour of container.getContours()) {
      // total length
      let total = 0;
      for (let i = 1; i < contour.length; i++)
        total += Math.hypot(contour[i].x - contour[i - 1].x, contour[i].y - contour[i - 1].y);
      const n = Math.max(1, Math.floor(total / pitch));
      const step = total / n;
      let acc = 0, target = 0;
      for (let i = 1; i < contour.length && out.length < 1e6; i++) {
        const a = contour[i - 1], b2 = contour[i];
        const seg = Math.hypot(b2.x - a.x, b2.y - a.y);
        while (acc + seg >= target && target < total) {
          const t = seg === 0 ? 0 : (target - acc) / seg;
          let px = a.x + (b2.x - a.x) * t, py = a.y + (b2.y - a.y) * t;
          if (inset !== 0) {
            // nudge inward along the local normal
            const nx = -(b2.y - a.y) / (seg || 1), ny = (b2.x - a.x) / (seg || 1);
            const cand = { x: px + nx * inset, y: py + ny * inset };
            if (container.containsPoint(cand.x, cand.y)) { px = cand.x; py = cand.y; }
            else { px -= nx * inset; py -= ny * inset; }
          }
          out.push({ x: px, y: py });
          target += step;
        }
        acc += seg;
      }
    }
    return out;
  },
};

/**
 * Adaptive: interface hook for smarter strategies. The default implementation
 * runs a hex lattice, then walks the boundary band and proposes extra
 * candidates midway between the lattice edge and the wall — a simple
 * demonstration of "adjust to local boundary geometry". Replace freely.
 */
export const AdaptiveGenerator = {
  getCandidates(container, bodyDef, pattern = {}) {
    const base = HexGridGenerator.getCandidates(container, bodyDef, pattern);
    const extra = ContourGenerator.getCandidates?.call
      ? (container.getContours ? ContourGenerator.getCandidates(container, bodyDef, {
          ...pattern, inset: bodyDef.diameter / 2 + (pattern.gap ?? 0) / 2,
        }) : [])
      : [];
    return [...base, ...extra];
  },
};

export const generators = {
  square: SquareGridGenerator,
  hex: HexGridGenerator,
  radial: RadialGenerator,
  contour: ContourGenerator,
  adaptive: AdaptiveGenerator,
};

// ---------------------------------------------------------------------------
// Core fill — candidate generation is fully independent from validation
// ---------------------------------------------------------------------------

export function fill(container, bodyDef, generator, rules, pattern = {}, preplaced = []) {
  const placed = [];
  const maxDia = Math.max(bodyDef.diameter, ...preplaced.map((p) => p.diameter || 0));
  const hash = new SpatialHash(maxDia + rules.gap);
  for (const p of preplaced) hash.insert(p);

  const candidates = generator.getCandidates(container, bodyDef, pattern);
  for (const point of candidates) {
    const candidate = bodyDef.createAt(point);
    if (!container.containsBody(candidate)) continue;
    if (!rules.meetsEdgeClearance(candidate, container)) continue;
    if (rules.overlapsAny(candidate, hash)) continue;
    placed.push(candidate);
    hash.insert(candidate);
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Scoring — extensible, weighted
// ---------------------------------------------------------------------------

export function scoreLayout(layout, container, weights = {}) {
  const {
    countWeight = 1, symmetryWeight = 0, edgeWeight = 0, spacingWeight = 0,
  } = weights;
  const bodies = layout;
  if (!bodies.length) return 0;
  const b = container.getBounds();
  const area = (b.maxX - b.minX) * (b.maxY - b.minY) || 1;
  const normalizedCount = bodies.length / (area / (bodies[0].diameter ** 2));

  // symmetry: distance between centroid of bodies and container centroid
  const c = container.centroid();
  let mx = 0, my = 0;
  for (const s of bodies) { mx += s.x; my += s.y; }
  mx /= bodies.length; my /= bodies.length;
  const symmetryScore = 1 / (1 + Math.hypot(mx - c.x, my - c.y));

  // edge consistency: variance of edge distances of boundary-adjacent bodies
  const edgeDists = bodies.map((s) => container.distanceToEdge(s.x, s.y)).sort((a2, b2) => a2 - b2);
  const edgeBand = edgeDists.slice(0, Math.max(1, Math.floor(edgeDists.length * 0.25)));
  const eMean = edgeBand.reduce((a2, b2) => a2 + b2, 0) / edgeBand.length;
  const eVar = edgeBand.reduce((a2, d) => a2 + (d - eMean) ** 2, 0) / edgeBand.length;
  const edgeConsistency = 1 / (1 + eVar);

  // spacing consistency: nearest-neighbor distance variance (sampled)
  let sVar = 0;
  if (spacingWeight > 0) {
    const nn = [];
    for (let i = 0; i < Math.min(bodies.length, 200); i++) {
      let best = Infinity;
      for (let j = 0; j < bodies.length; j++) {
        if (i === j) continue;
        const d = dist2(bodies[i].x, bodies[i].y, bodies[j].x, bodies[j].y);
        if (d < best) best = d;
      }
      nn.push(Math.sqrt(best));
    }
    const m = nn.reduce((a2, b2) => a2 + b2, 0) / nn.length;
    sVar = nn.reduce((a2, d) => a2 + (d - m) ** 2, 0) / nn.length;
  }
  const spacingConsistency = 1 / (1 + sVar);

  return (
    countWeight * normalizedCount +
    symmetryWeight * symmetryScore +
    edgeWeight * edgeConsistency +
    spacingWeight * spacingConsistency
  );
}

// ---------------------------------------------------------------------------
// Top-level API
// ---------------------------------------------------------------------------

/**
 * fillShape — see module doc for the full option set. Returns
 * { bodies, statistics, toSVG() }.
 */
export function fillShape({
  shape,
  body = { type: 'circle', diameter: 10, sizeId: null },
  bodySizes = null,               // optional mixed sizes, largest first
  pattern = { type: 'hex', gap: 2, rotation: 0, offsetX: 0, offsetY: 0 },
  rules: ruleOpts = { edgeMargin: 0, preventOverlap: true },
  mode = 'fill',                  // 'fill' | 'outline' | 'both'
  optimize = null,                // { offsets, rotationSearch, weights }
}) {
  const container = shape;
  const rules = new PlacementRules({
    gap: pattern.gap ?? 0,
    edgeMargin: ruleOpts.edgeMargin ?? 0,
    preventOverlap: ruleOpts.preventOverlap !== false,
  });
  const gen = generators[pattern.type] ?? HexGridGenerator;
  const weights = optimize?.weights ?? { countWeight: 1 };

  const runOnce = (pat) => {
    let placed = [];
    // outline first (both mode) so the fill respects it
    if (mode === 'outline' || mode === 'both') {
      const def = circleBodyDefinition(body.diameter, body.sizeId);
      placed = fill(container, def, ContourGenerator, rules, pat, []);
      if (mode === 'outline') return placed;
    }
    const sizes = bodySizes
      ? [...bodySizes].sort((a, b2) => b2.diameter - a.diameter)
      : [body];
    // mixed sizes: place large first, lock, then progressively smaller
    for (const s of sizes) {
      const def = circleBodyDefinition(s.diameter, s.sizeId ?? null);
      placed = placed.concat(fill(container, def, gen, rules, pat, placed));
    }
    return placed;
  };

  // ---- offset / rotation optimization -------------------------------------
  let bestPat = { ...pattern };
  let bestLayout = runOnce(bestPat);
  let bestScore = scoreLayout(bestLayout, container, weights);

  if (optimize?.offsets) {
    const pitch = body.diameter + (pattern.gap ?? 0);
    const n = optimize.offsets === true ? 4 : optimize.offsets;
    for (let ix = 0; ix < n; ix++)
      for (let iy = 0; iy < n; iy++) {
        const pat = {
          ...pattern,
          offsetX: (pattern.offsetX ?? 0) + (ix / n) * pitch,
          offsetY: (pattern.offsetY ?? 0) + (iy / n) * pitch * Math.sqrt(3) / 2,
        };
        const layout = runOnce(pat);
        const sc = scoreLayout(layout, container, weights);
        if (sc > bestScore) { bestScore = sc; bestLayout = layout; bestPat = pat; }
      }
  }
  if (optimize?.rotationSearch?.enabled) {
    const { min = 0, max = 60, step = 5 } = optimize.rotationSearch;
    // hex symmetry: searching beyond 60° is redundant
    for (let rot = min; rot <= max; rot += step) {
      const pat = { ...bestPat, rotation: rot };
      const layout = runOnce(pat);
      const sc = scoreLayout(layout, container, weights);
      if (sc > bestScore) { bestScore = sc; bestLayout = layout; bestPat = pat; }
    }
  }

  // ---- statistics + output -------------------------------------------------
  const b = container.getBounds();
  const shapeArea = (b.maxX - b.minX) * (b.maxY - b.minY) || 1;
  const bodyArea = bestLayout.reduce((a2, s) => a2 + Math.PI * (s.diameter / 2) ** 2, 0);
  const result = {
    bodies: bestLayout.map((s) => ({
      x: s.x, y: s.y, radius: s.diameter / 2, rotation: s.rotation ?? 0, sizeId: s.sizeId ?? null,
    })),
    statistics: {
      bodyCount: bestLayout.length,
      density: +(bodyArea / shapeArea).toFixed(3),
      pattern: pattern.type,
      spacing: pattern.gap ?? 0,
      rotation: bestPat.rotation ?? 0,
      offsetX: +(bestPat.offsetX ?? 0).toFixed(2),
      offsetY: +(bestPat.offsetY ?? 0).toFixed(2),
      score: +bestScore.toFixed(4),
    },
    toSVG({ fillColor = '#5b8def', background = null } = {}) {
      const w = b.maxX - b.minX + 20, h = b.maxY - b.minY + 20;
      const circles = result.bodies
        .map((s) => `  <circle cx="${(s.x - b.minX + 10).toFixed(2)}" cy="${(s.y - b.minY + 10).toFixed(2)}" r="${s.radius.toFixed(2)}" fill="${fillColor}"/>`)
        .join('\n');
      const bg = background ? `  <rect width="100%" height="100%" fill="${background}"/>\n` : '';
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}">\n${bg}${circles}\n</svg>\n`;
    },
  };
  return result;
}

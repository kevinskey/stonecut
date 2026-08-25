"""
LatticeFill (Python) — constraint-based lattice fill / pattern fill engine.

Mirrors the JavaScript architecture:

    Container           arbitrary closed geometry
    Body                repeated object (circles built in, extensible)
    CandidateGenerator  square | hex | radial | contour | adaptive
    PlacementRules      containment + edge clearance + spacing + collision
    Optimizer           offset/rotation search, mixed sizes, weighted scoring

The fill loop only speaks to the Container interface:
    get_bounds() / contains_point(x, y) / distance_to_edge(x, y) / contains_body(b)

Extend by subclassing Container/Body, or by writing a generator function
`get_candidates(container, body_def, pattern) -> list[(x, y)]`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Optional

TAU = math.tau


# ---------------------------------------------------------------------------
# Containers
# ---------------------------------------------------------------------------

class Container:
    def get_bounds(self):  # (min_x, min_y, max_x, max_y)
        raise NotImplementedError

    def contains_point(self, x: float, y: float) -> bool:
        raise NotImplementedError

    def distance_to_edge(self, x: float, y: float) -> float:
        raise NotImplementedError

    def contains_body(self, body: "CircleBody") -> bool:
        return (
            self.contains_point(body.x, body.y)
            and self.distance_to_edge(body.x, body.y) >= body.bounding_radius()
        )

    def centroid(self):
        min_x, min_y, max_x, max_y = self.get_bounds()
        return ((min_x + max_x) / 2, (min_y + max_y) / 2)


class CircleContainer(Container):
    def __init__(self, cx: float, cy: float, r: float):
        self.cx, self.cy, self.r = cx, cy, r

    def get_bounds(self):
        return (self.cx - self.r, self.cy - self.r, self.cx + self.r, self.cy + self.r)

    def contains_point(self, x, y):
        return (x - self.cx) ** 2 + (y - self.cy) ** 2 <= self.r**2

    def distance_to_edge(self, x, y):
        return self.r - math.hypot(x - self.cx, y - self.cy)

    def centroid(self):
        return (self.cx, self.cy)


class PolygonContainer(Container):
    """One or more closed contours [(x, y), ...]; even-odd rule so inner
    contours are holes — text counters and compound shapes work directly."""

    def __init__(self, contours):
        if contours and isinstance(contours[0], tuple):
            contours = [contours]
        self.contours = [list(c) for c in contours]
        xs = [p[0] for c in self.contours for p in c]
        ys = [p[1] for c in self.contours for p in c]
        self.bounds = (min(xs), min(ys), max(xs), max(ys))

    def get_bounds(self):
        return self.bounds

    def contains_point(self, x, y):
        inside = False
        for c in self.contours:
            j = len(c) - 1
            for i in range(len(c)):
                ax, ay = c[i]
                bx, by = c[j]
                if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                    inside = not inside
                j = i
        return inside

    def distance_to_edge(self, x, y):
        best = math.inf
        for c in self.contours:
            j = len(c) - 1
            for i in range(len(c)):
                best = min(best, _point_seg_dist2(x, y, *c[j], *c[i]))
                j = i
        d = math.sqrt(best)
        return d if self.contains_point(x, y) else -d

    def get_contours(self):
        return self.contours


def _point_seg_dist2(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    qx, qy = ax + t * dx, ay + t * dy
    return (px - qx) ** 2 + (py - qy) ** 2


def svg_path_to_container(d: str, curve_segments: int = 16) -> PolygonContainer:
    """Flatten a closed SVG path (M/L/H/V/C/S/Q/Z subset) into contours."""
    import re

    tokens = re.findall(r"[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?", d)
    contours, cur = [], []
    x = y = sx = sy = 0.0
    prev_ctrl = None
    i = 0

    def num():
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    def bez(x1, y1, x2, y2, ex, ey):
        nonlocal x, y
        for k in range(1, curve_segments + 1):
            t = k / curve_segments
            mt = 1 - t
            cur.append((
                mt**3 * x + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t**3 * ex,
                mt**3 * y + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t**3 * ey,
            ))
        x, y = ex, ey

    while i < len(tokens):
        cmd = tokens[i]
        i += 1
        rel = cmd.islower()
        C = cmd.upper()
        if C == "M":
            if len(cur) > 2:
                contours.append(cur)
            cur = []
            x = num() + (x if rel else 0)
            y = num() + (y if rel else 0)
            sx, sy = x, y
            cur.append((x, y))
        elif C == "L":
            x = num() + (x if rel else 0)
            y = num() + (y if rel else 0)
            cur.append((x, y))
        elif C == "H":
            x = num() + (x if rel else 0)
            cur.append((x, y))
        elif C == "V":
            y = num() + (y if rel else 0)
            cur.append((x, y))
        elif C == "C":
            x1 = num() + (x if rel else 0); y1 = num() + (y if rel else 0)
            x2 = num() + (x if rel else 0); y2 = num() + (y if rel else 0)
            ex = num() + (x if rel else 0); ey = num() + (y if rel else 0)
            bez(x1, y1, x2, y2, ex, ey)
            prev_ctrl = (x2, y2)
        elif C == "S":
            x1, y1 = ((2 * x - prev_ctrl[0], 2 * y - prev_ctrl[1]) if prev_ctrl else (x, y))
            x2 = num() + (x if rel else 0); y2 = num() + (y if rel else 0)
            ex = num() + (x if rel else 0); ey = num() + (y if rel else 0)
            bez(x1, y1, x2, y2, ex, ey)
            prev_ctrl = (x2, y2)
        elif C == "Q":
            qx = num() + (x if rel else 0); qy = num() + (y if rel else 0)
            ex = num() + (x if rel else 0); ey = num() + (y if rel else 0)
            bez(x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y),
                ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey), ex, ey)
            prev_ctrl = (qx, qy)
        elif C == "Z":
            if len(cur) > 2:
                cur.append((sx, sy))
                contours.append(cur)
            cur = []
            x, y = sx, sy
        else:  # unsupported (A/T): approximate with a line
            x = num() + (x if rel else 0)
            y = num() + (y if rel else 0)
            cur.append((x, y))
    if len(cur) > 2:
        contours.append(cur)
    return PolygonContainer(contours)


# ---------------------------------------------------------------------------
# Bodies
# ---------------------------------------------------------------------------

@dataclass
class CircleBody:
    x: float
    y: float
    diameter: float
    size_id: Optional[str] = None
    rotation: float = 0.0

    def bounding_radius(self) -> float:
        return self.diameter / 2

    def overlaps(self, other: "CircleBody", gap: float = 0.0) -> bool:
        min_d = (self.diameter + other.diameter) / 2 + gap
        return (self.x - other.x) ** 2 + (self.y - other.y) ** 2 < min_d * min_d


@dataclass
class BodyDefinition:
    diameter: float
    size_id: Optional[str] = None

    def create_at(self, x: float, y: float) -> CircleBody:
        return CircleBody(x, y, self.diameter, self.size_id)


# ---------------------------------------------------------------------------
# Spatial hash
# ---------------------------------------------------------------------------

class SpatialHash:
    def __init__(self, cell: float):
        self.cell = max(cell, 1e-6)
        self.map: dict[tuple[int, int], list[CircleBody]] = {}

    def insert(self, body: CircleBody):
        k = (int(body.x // self.cell), int(body.y // self.cell))
        self.map.setdefault(k, []).append(body)

    def neighbors(self, x: float, y: float):
        cx, cy = int(x // self.cell), int(y // self.cell)
        for gx in range(cx - 1, cx + 2):
            for gy in range(cy - 1, cy + 2):
                yield from self.map.get((gx, gy), ())


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

@dataclass
class PlacementRules:
    gap: float = 0.0
    edge_margin: float = 0.0
    prevent_overlap: bool = True

    def meets_edge_clearance(self, body: CircleBody, container: Container) -> bool:
        return container.distance_to_edge(body.x, body.y) >= body.bounding_radius() + self.edge_margin

    def overlaps_any(self, body: CircleBody, hash_: SpatialHash) -> bool:
        if not self.prevent_overlap:
            return False
        return any(body.overlaps(o, self.gap) for o in hash_.neighbors(body.x, body.y))


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------

def _lattice(container, spacing_x, spacing_y, alt_offset, rotation_deg, off_x, off_y):
    min_x, min_y, max_x, max_y = container.get_bounds()
    cx, cy = container.centroid()
    rad = math.radians(rotation_deg)
    cos, sin = math.cos(rad), math.sin(rad)
    half = math.hypot(max_x - min_x, max_y - min_y) / 2 + spacing_x
    out = []
    row = 0
    yy = cy - half
    while yy <= cy + half:
        off = alt_offset if row % 2 else 0.0
        xx = cx - half + off
        while xx <= cx + half:
            dx, dy = xx - cx, yy - cy
            out.append((cx + dx * cos - dy * sin + off_x, cy + dx * sin + dy * cos + off_y))
            xx += spacing_x
        yy += spacing_y
        row += 1
    return out


def square_grid(container, body_def, pattern):
    pitch = body_def.diameter + pattern.get("gap", 0)
    return _lattice(container, pitch, pitch, 0.0,
                    pattern.get("rotation", 0), pattern.get("offsetX", 0), pattern.get("offsetY", 0))


def hex_grid(container, body_def, pattern):
    pitch = body_def.diameter + pattern.get("gap", 0)
    return _lattice(container, pitch, pitch * math.sqrt(3) / 2, pitch / 2,
                    pattern.get("rotation", 0), pattern.get("offsetX", 0), pattern.get("offsetY", 0))


def radial(container, body_def, pattern):
    pitch = body_def.diameter + pattern.get("gap", 0)
    cx, cy = container.centroid()
    min_x, min_y, max_x, max_y = container.get_bounds()
    max_r = math.hypot(max_x - min_x, max_y - min_y) / 2
    out = [(cx, cy)]
    r = pitch
    while r <= max_r:
        n = max(1, int(TAU * r / pitch))
        for k in range(n):
            a = k / n * TAU
            out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        r += pitch * math.sqrt(3) / 2
    return out


def contour(container, body_def, pattern):
    pitch = body_def.diameter + pattern.get("gap", 0)
    out = []
    for c in container.get_contours():
        total = sum(math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]) for i in range(1, len(c)))
        if total <= 0:
            continue
        n = max(1, int(total // pitch))
        step = total / n
        acc, target = 0.0, 0.0
        for i in range(1, len(c)):
            ax, ay = c[i - 1]
            bx, by = c[i]
            seg = math.hypot(bx - ax, by - ay)
            while acc + seg >= target and target < total:
                t = 0 if seg == 0 else (target - acc) / seg
                out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
                target += step
            acc += seg
    return out


def adaptive(container, body_def, pattern):
    """Hook for smarter strategies; default = hex + boundary band."""
    pts = hex_grid(container, body_def, pattern)
    if hasattr(container, "get_contours"):
        pts += contour(container, body_def, pattern)
    return pts


GENERATORS: dict[str, Callable] = {
    "square": square_grid,
    "hex": hex_grid,
    "radial": radial,
    "contour": contour,
    "adaptive": adaptive,
}


# ---------------------------------------------------------------------------
# Core fill
# ---------------------------------------------------------------------------

def fill(container, body_def, generator, rules, pattern=None, preplaced=None):
    pattern = pattern or {}
    preplaced = preplaced or []
    placed: list[CircleBody] = []
    max_dia = max([body_def.diameter] + [b.diameter for b in preplaced])
    hash_ = SpatialHash(max_dia + rules.gap)
    for b in preplaced:
        hash_.insert(b)
    for (x, y) in generator(container, body_def, pattern):
        cand = body_def.create_at(x, y)
        if not container.contains_body(cand):
            continue
        if not rules.meets_edge_clearance(cand, container):
            continue
        if rules.overlaps_any(cand, hash_):
            continue
        placed.append(cand)
        hash_.insert(cand)
    return placed


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_layout(bodies, container, count_weight=1.0, symmetry_weight=0.0,
                 edge_weight=0.0, spacing_weight=0.0):
    if not bodies:
        return 0.0
    min_x, min_y, max_x, max_y = container.get_bounds()
    area = (max_x - min_x) * (max_y - min_y) or 1.0
    normalized_count = len(bodies) / (area / bodies[0].diameter**2)

    cx, cy = container.centroid()
    mx = sum(b.x for b in bodies) / len(bodies)
    my = sum(b.y for b in bodies) / len(bodies)
    symmetry = 1 / (1 + math.hypot(mx - cx, my - cy))

    edge = sorted(container.distance_to_edge(b.x, b.y) for b in bodies)
    band = edge[: max(1, len(edge) // 4)]
    mean = sum(band) / len(band)
    edge_consistency = 1 / (1 + sum((d - mean) ** 2 for d in band) / len(band))

    spacing_consistency = 1.0
    if spacing_weight:
        nn = []
        for i, b in enumerate(bodies[:200]):
            nn.append(min(math.hypot(b.x - o.x, b.y - o.y) for j, o in enumerate(bodies) if j != i))
        m = sum(nn) / len(nn)
        spacing_consistency = 1 / (1 + sum((d - m) ** 2 for d in nn) / len(nn))

    return (count_weight * normalized_count + symmetry_weight * symmetry
            + edge_weight * edge_consistency + spacing_weight * spacing_consistency)


# ---------------------------------------------------------------------------
# Top-level API
# ---------------------------------------------------------------------------

def fill_shape(shape, body=None, body_sizes=None, pattern=None, rules=None,
               mode="fill", optimize=None):
    body = body or {"diameter": 10, "sizeId": None}
    pattern = pattern or {"type": "hex", "gap": 2, "rotation": 0, "offsetX": 0, "offsetY": 0}
    rules = rules or {}
    r = PlacementRules(gap=pattern.get("gap", 0), edge_margin=rules.get("edgeMargin", 0),
                       prevent_overlap=rules.get("preventOverlap", True))
    gen = GENERATORS.get(pattern.get("type", "hex"), hex_grid)
    weights = (optimize or {}).get("weights", {})

    def run_once(pat):
        placed: list[CircleBody] = []
        if mode in ("outline", "both"):
            placed = fill(shape, BodyDefinition(body["diameter"], body.get("sizeId")),
                          contour, r, pat, [])
            if mode == "outline":
                return placed
        sizes = sorted(body_sizes, key=lambda s: -s["diameter"]) if body_sizes else [body]
        for s in sizes:
            placed += fill(shape, BodyDefinition(s["diameter"], s.get("sizeId")),
                           gen, r, pat, placed)
        return placed

    best_pat = dict(pattern)
    best = run_once(best_pat)
    best_score = score_layout(best, shape, **weights)

    if (optimize or {}).get("offsets"):
        n = 4 if optimize["offsets"] is True else optimize["offsets"]
        pitch = body["diameter"] + pattern.get("gap", 0)
        for ix in range(n):
            for iy in range(n):
                pat = dict(pattern, offsetX=pattern.get("offsetX", 0) + ix / n * pitch,
                           offsetY=pattern.get("offsetY", 0) + iy / n * pitch * math.sqrt(3) / 2)
                layout = run_once(pat)
                sc = score_layout(layout, shape, **weights)
                if sc > best_score:
                    best, best_score, best_pat = layout, sc, pat
    rs = (optimize or {}).get("rotationSearch")
    if rs and rs.get("enabled"):
        rot = rs.get("min", 0)
        while rot <= rs.get("max", 60):  # hex symmetry: >60° redundant
            pat = dict(best_pat, rotation=rot)
            layout = run_once(pat)
            sc = score_layout(layout, shape, **weights)
            if sc > best_score:
                best, best_score, best_pat = layout, sc, pat
            rot += rs.get("step", 5)

    min_x, min_y, max_x, max_y = shape.get_bounds()
    shape_area = (max_x - min_x) * (max_y - min_y) or 1
    body_area = sum(math.pi * (b.diameter / 2) ** 2 for b in best)
    return {
        "bodies": [{"x": b.x, "y": b.y, "radius": b.diameter / 2,
                    "rotation": b.rotation, "sizeId": b.size_id} for b in best],
        "statistics": {
            "bodyCount": len(best),
            "density": round(body_area / shape_area, 3),
            "pattern": pattern.get("type", "hex"),
            "spacing": pattern.get("gap", 0),
            "rotation": best_pat.get("rotation", 0),
            "offsetX": round(best_pat.get("offsetX", 0), 2),
            "offsetY": round(best_pat.get("offsetY", 0), 2),
            "score": round(best_score, 4),
        },
    }


def to_svg(result, bounds, fill_color="#5b8def"):
    min_x, min_y, max_x, max_y = bounds
    w, h = max_x - min_x + 20, max_y - min_y + 20
    circles = "\n".join(
        f'  <circle cx="{b["x"] - min_x + 10:.2f}" cy="{b["y"] - min_y + 10:.2f}" '
        f'r="{b["radius"]:.2f}" fill="{fill_color}"/>'
        for b in result["bodies"]
    )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" '
            f'viewBox="0 0 {w:.0f} {h:.0f}">\n{circles}\n</svg>\n')


if __name__ == "__main__":
    # Example: circle filled with circles
    circle = CircleContainer(0, 0, 60)
    res = fill_shape(circle, body={"diameter": 10}, pattern={"type": "hex", "gap": 2},
                     rules={"edgeMargin": 1}, mode="both",
                     optimize={"offsets": 3, "weights": {"count_weight": 1}})
    print("circle:", res["statistics"])

    # Example: star (polygon) with mixed sizes
    pts = []
    for k in range(10):
        rr = 30 if k % 2 else 70
        a = k / 10 * TAU - math.pi / 2
        pts.append((rr * math.cos(a), rr * math.sin(a)))
    star = PolygonContainer(pts)
    res2 = fill_shape(star, body={"diameter": 8},
                      body_sizes=[{"diameter": 8, "sizeId": "SS20"},
                                  {"diameter": 5, "sizeId": "SS10"},
                                  {"diameter": 3, "sizeId": "SS6"}],
                      pattern={"type": "hex", "gap": 1.5}, mode="both")
    print("star mixed:", res2["statistics"])

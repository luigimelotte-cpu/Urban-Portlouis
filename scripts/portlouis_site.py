#!/usr/bin/env python3
"""
Port Louis urban site base — full-frame CAD build.

Builds a black-and-white urban site plan for central Port Louis (Aapravasi Ghat /
Le Grenier / harbour edge) from OpenStreetMap, in the established local metric
system.

Scope note
----------
The 600 x 600 m study square ("cadrage") was drawn previously. This script
rebuilds it AND extends the same drawing language outward to the full satellite
frame, 1478.65 x 1038.21 m. Geometry outside the square is written to parallel
`*_CTX` layers so the context can be dimmed, frozen or re-weighted in one action
without touching the study area.

Coordinate system (fixed — do not change)
-----------------------------------------
    units          metres
    origin (0,0)   SW corner of the study square
    +Y             true north
    study square   (0,0) -> (600,600)
    frame          (-312.92,-176.97) -> (1165.73, 861.24)
    raster scale   1.1236 m/px
    street grid    44 deg / 136 deg from east (measured)

Usage
-----
    python3 portlouis_site.py --workdir .
    python3 portlouis_site.py --workdir . --stage register   # QA the fit first
    python3 portlouis_site.py --workdir . --dim-context      # grey the exterior
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

# ---------------------------------------------------------------------------
# Hard constants of the established local system
# ---------------------------------------------------------------------------

STUDY_MIN = (0.0, 0.0)
STUDY_MAX = (600.0, 600.0)

FRAME_MIN = (-312.92, -176.97)
FRAME_MAX = (1165.73, 861.24)

RASTER_SCALE = 1.1236                      # m per pixel
FRAME_PX = (1316, 924)                     # satellite_FULLFRAME
STUDY_PX = (534, 534)                      # satellite_STUDYAREA

GEOCODE_QUERY = "Aapravasi Ghat, Port Louis, Mauritius"
ANCHOR_LOCAL = (253.0, 466.0)              # where the geocoded anchor must land
ANCHOR_TOL = 50.0                          # m

GRID_BEARINGS_DEG = (44.0, 136.0)          # measured street grid, from east
GRID_BEARING_TOL = 4.0                     # deg

UTM_EPSG = "EPSG:32740"                    # UTM 40S — correct for Mauritius
WGS84 = "EPSG:4326"

REG_RMS_ABORT = 8.0                        # m — abort above this
REG_GATE = 50.0                            # m — max ICP correspondence distance
OSM_MARGIN = 1400.0                        # m of OSM beyond the frame

# Road half-widths (m) by highway class
HALF_WIDTH = {
    "motorway": 9.0, "motorway_link": 9.0,
    "trunk": 9.0, "trunk_link": 9.0,
    "primary": 7.0, "primary_link": 7.0,
    "secondary": 5.5, "secondary_link": 5.5,
    "tertiary": 4.5, "tertiary_link": 4.5,
    "residential": 3.5, "unclassified": 3.5, "living_street": 3.5,
    "service": 2.5,
    "pedestrian": 1.8, "footway": 1.8, "path": 1.8, "steps": 1.8, "track": 1.8,
}
FOOTWAY_CLASSES = {"pedestrian", "footway", "path", "steps", "track"}
LANE_WIDTH = 3.25

MIN_BUILDING_AREA = 15.0
MAJOR_BUILDING_AREA = 1000.0
SIMPLIFY_TOL = 0.3
DEFAULT_TREE_RADIUS = 3.0
RAIL_BAND_HALF = 1.5                       # 3.0 m band

# Layer table: name -> (aci colour, lineweight in 1/100 mm)
LAYERS: dict[str, tuple[int, int]] = {
    "20_BUILDINGS_OSM":     (7,   18),
    "21_BUILDINGS_MAJOR":   (7,   25),
    "30_ROAD_EDGE":         (8,   13),
    "31_ROAD_CENTRELINE":   (251,  9),
    "32_FOOTWAY":           (253,  9),
    "33_RAILWAY":           (8,    9),
    "34_PARKING":           (253,  9),
    "35_WATERWAY":          (5,    9),
    "40_TREES":             (3,    9),
    "41_GREEN_AREA":        (3,    9),
    "80_GRID_100M":         (8,    9),
}
# Layers created but deliberately not printed with the drawing.
FROZEN_LAYERS = {"31_ROAD_CENTRELINE", "80_GRID_100M"}
# Context layers mirror the study-area layers 1:1.
CTX_SUFFIX = "_CTX"
DIM_COLOUR = 253
DIM_WEIGHT = 9

CARRY_LAYERS = [
    "01_STUDY_AREA", "02_WATER", "03_WATERFRONT_EDGE", "04_VEGETATION",
    "00_IMAGE_FRAME",
    "10_AGWHP_BZ1_PARTIAL", "11_AGWHP_BZ2_PARTIAL", "12_AGWHP_CORE_VICINITY",
]

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "portlouis-site-base/1.0 (architecture study; contact via repo)"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def log(msg: str = "") -> None:
    print(msg, flush=True)


def rule(title: str) -> None:
    log()
    log("=" * 72)
    log(title)
    log("=" * 72)


class PipelineError(RuntimeError):
    """Raised for any condition the operator must see and decide on."""


def frame_size() -> tuple[float, float]:
    return (FRAME_MAX[0] - FRAME_MIN[0], FRAME_MAX[1] - FRAME_MIN[1])


# ---------------------------------------------------------------------------
# 1. Geocode + Overpass, both cached
# ---------------------------------------------------------------------------

def geocode_anchor(workdir: Path, offline_ok: bool = False) -> tuple[float, float]:
    """Return (lon, lat) of the Aapravasi Ghat anchor. Cached to disk."""
    import requests

    cache = workdir / "nominatim_anchor.json"
    if cache.exists():
        d = json.loads(cache.read_text())
        log(f"  anchor from cache: lon={d['lon']:.7f} lat={d['lat']:.7f}")
        return d["lon"], d["lat"]

    log(f"  geocoding {GEOCODE_QUERY!r} ...")
    r = requests.get(
        NOMINATIM_URL,
        params={"q": GEOCODE_QUERY, "format": "json", "limit": 1},
        headers={"User-Agent": USER_AGENT},
        timeout=60,
    )
    if r.status_code != 200:
        raise PipelineError(
            f"Nominatim returned HTTP {r.status_code}. Not substituting a "
            f"fallback coordinate — rerun when the service is reachable."
        )
    js = r.json()
    if not js:
        raise PipelineError(f"Nominatim found no match for {GEOCODE_QUERY!r}.")
    lon, lat = float(js[0]["lon"]), float(js[0]["lat"])
    cache.write_text(json.dumps({"lon": lon, "lat": lat,
                                 "display_name": js[0].get("display_name", "")},
                                indent=2))
    log(f"  anchor: lon={lon:.7f} lat={lat:.7f}  ({js[0].get('display_name','')})")
    return lon, lat


def overpass_query(bbox: tuple[float, float, float, float]) -> str:
    """bbox = (south, west, north, east)."""
    s, w, n, e = bbox
    b = f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"
    return f"""[out:json][timeout:300];
(
  way["building"]{b};
  relation["building"]{b};
  way["highway"]{b};
  way["railway"]{b};
  way["natural"="water"]{b};
  relation["natural"="water"]{b};
  way["natural"="coastline"]{b};
  way["waterway"]{b};
  way["landuse"="harbour"]{b};
  relation["landuse"="harbour"]{b};
  node["natural"="tree"]{b};
  way["natural"="tree_row"]{b};
  way["leisure"="park"]{b};
  relation["leisure"="park"]{b};
  way["landuse"~"^(grass|forest|industrial|commercial|retail)$"]{b};
  way["natural"="scrub"]{b};
  way["amenity"="parking"]{b};
  relation["amenity"="parking"]{b};
);
out body geom qt;
"""


def fetch_osm(workdir: Path, bbox: tuple[float, float, float, float]) -> dict:
    """Query Overpass once and cache the raw response to osm_raw.json."""
    import requests

    cache = workdir / "osm_raw.json"
    if cache.exists():
        log(f"  using cached {cache.name} "
            f"({cache.stat().st_size / 1e6:.1f} MB)")
        return json.loads(cache.read_text())

    q = overpass_query(bbox)
    last: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(4):
            try:
                log(f"  POST {endpoint} (attempt {attempt + 1})")
                r = requests.post(endpoint, data={"data": q},
                                  headers={"User-Agent": USER_AGENT},
                                  timeout=400)
                if r.status_code == 200:
                    data = r.json()
                    cache.write_text(json.dumps(data))
                    log(f"  cached {len(data.get('elements', []))} elements "
                        f"-> {cache.name}")
                    return data
                if r.status_code in (429, 502, 503, 504):
                    wait = 2 ** (attempt + 1)
                    log(f"  HTTP {r.status_code}, backing off {wait}s")
                    time.sleep(wait)
                    continue
                last = PipelineError(f"HTTP {r.status_code} from {endpoint}")
                break
            except Exception as exc:                    # noqa: BLE001
                last = exc
                wait = 2 ** (attempt + 1)
                log(f"  {type(exc).__name__}: {exc} — backing off {wait}s")
                time.sleep(wait)
    raise PipelineError(
        "Overpass failed on every endpoint and retry. No fallback geometry is "
        f"substituted, by design. Last error: {last}"
    )


# ---------------------------------------------------------------------------
# 2. Local frame: 4-parameter Helmert from UTM 40S into the study system
# ---------------------------------------------------------------------------

@dataclass
class LocalFrame:
    """local = scale * R(theta) @ (utm - origin_utm) + offset."""
    scale: float
    theta: float                      # radians, CCW positive
    origin_utm: np.ndarray            # (2,) anchor in UTM 40S
    offset: np.ndarray                # (2,) local coords of origin_utm
    method: str = "unset"

    @property
    def rot(self) -> np.ndarray:
        c, s = math.cos(self.theta), math.sin(self.theta)
        return np.array([[c, -s], [s, c]])

    def to_local(self, utm: np.ndarray) -> np.ndarray:
        utm = np.asarray(utm, dtype=float).reshape(-1, 2)
        return self.scale * (utm - self.origin_utm) @ self.rot.T + self.offset

    def describe(self) -> str:
        return (f"method={self.method}  scale={self.scale:.8f}  "
                f"rotation={math.degrees(self.theta):+.5f} deg  "
                f"offset=({self.offset[0]:.3f}, {self.offset[1]:.3f})")


def geodetic_frame(lon: float, lat: float) -> LocalFrame:
    """
    Derive the frame analytically: put the geocoded anchor at ANCHOR_LOCAL and
    align +Y with *true* north.

    Rotation and scale are measured rather than looked up — project the anchor
    and a point 1000 m due true north of it, and read the grid convergence and
    point scale factor straight off the resulting vector. No sign conventions
    to get wrong.
    """
    from pyproj import Geod, Transformer

    tf = Transformer.from_crs(WGS84, UTM_EPSG, always_xy=True)
    geod = Geod(ellps="WGS84")

    p0 = np.array(tf.transform(lon, lat), dtype=float)
    lon_n, lat_n, _ = geod.fwd(lon, lat, 0.0, 1000.0)      # due true north
    pn = np.array(tf.transform(lon_n, lat_n), dtype=float)

    v = pn - p0
    theta = math.atan2(v[0], v[1])          # R(theta) @ v == (0, |v|)
    scale = 1000.0 / float(np.hypot(*v))    # undo the UTM point scale factor

    fr = LocalFrame(scale=scale, theta=theta, origin_utm=p0,
                    offset=np.array(ANCHOR_LOCAL, dtype=float),
                    method="geodetic-anchor")

    check = fr.to_local(pn)[0] - np.array(ANCHOR_LOCAL)
    if abs(check[0]) > 1e-6 or abs(check[1] - 1000.0) > 1e-6:
        raise PipelineError(
            f"Internal error: true north did not map to +Y "
            f"(got {check[0]:.6f}, {check[1]:.6f})."
        )
    log(f"  grid convergence   {math.degrees(theta):+.5f} deg")
    log(f"  point scale factor {1.0 / scale:.8f}")
    return fr


def read_dxf_layer_lines(dxf_path: Path, layer: str) -> list[np.ndarray]:
    """Vertices of every LWPOLYLINE / POLYLINE / LINE on a layer."""
    import ezdxf

    doc = ezdxf.readfile(str(dxf_path))
    msp = doc.modelspace()
    out: list[np.ndarray] = []
    for e in msp:
        if e.dxf.layer != layer:
            continue
        t = e.dxftype()
        if t == "LWPOLYLINE":
            pts = np.array([(p[0], p[1]) for p in e.get_points("xy")], float)
            if e.closed and len(pts) > 2:
                pts = np.vstack([pts, pts[:1]])
        elif t == "POLYLINE":
            pts = np.array([(v.dxf.location.x, v.dxf.location.y)
                            for v in e.vertices], float)
            if e.is_closed and len(pts) > 2:
                pts = np.vstack([pts, pts[:1]])
        elif t == "LINE":
            pts = np.array([(e.dxf.start.x, e.dxf.start.y),
                            (e.dxf.end.x, e.dxf.end.y)], float)
        else:
            continue
        if len(pts) >= 2:
            out.append(pts)
    return out


def densify(polylines: Sequence[np.ndarray], step: float = 1.0) -> np.ndarray:
    """Resample polylines to ~`step` metre spacing, for the KD-tree target."""
    pts: list[np.ndarray] = []
    for pl in polylines:
        seg = np.diff(pl, axis=0)
        length = np.hypot(seg[:, 0], seg[:, 1])
        for (a, b), L in zip(zip(pl[:-1], pl[1:]), length):
            n = max(int(L / step), 1)
            t = np.linspace(0.0, 1.0, n, endpoint=False)[:, None]
            pts.append(a + t * (b - a))
        pts.append(pl[-1:])
    return np.vstack(pts) if pts else np.zeros((0, 2))


def register_to_water(osm_coast_utm: np.ndarray,
                      dxf_water: Sequence[np.ndarray],
                      initial: LocalFrame,
                      trim: float = 0.10,
                      rounds: int = 4,
                      fit_scale: bool = False,
                      gate: float = REG_GATE) -> tuple[LocalFrame, dict]:
    """
    Trimmed least-squares fit of (theta, tx, ty) minimising the distance from
    transformed OSM coastline vertices to the traced DXF water polyline.

    Scale is LOCKED to the geodetic value by default. It is not an unknown —
    it is the UTM point scale factor, known exactly from the projection
    (0.9996338 here). Leaving it free lets noise in a hand-traced coastline,
    which is one open curve on one side of the drawing, stretch the whole city:
    on a 740 m span a 0.2 % scale error is 1.4 m of displacement at the far
    edge, bought for a few centimetres of apparent residual. `fit_scale=True`
    frees it anyway, for diagnosing a suspected scale problem in the base.

    Correspondences are GATED before fitting: only OSM vertices already within
    `gate` metres of the traced polyline under the initial geodetic transform
    are used. Without that gate the fit is dragged by water that has no
    counterpart in the target — the traced 02_WATER covers the study area's
    harbour edge only, while OSM within the frame also carries open coastline
    running past it, inland basins and other water. Those points can never be
    matched by any transform, and trimming the worst 10 % does not remove them
    when they are a third of the input. On the test fixture, ungated fitting
    swung the rotation 14.5 degrees; gated, it recovers the true transform.

    Trimming happens between rounds rather than inside the residual function, so
    each individual solve stays smooth and converges cleanly.
    """
    from scipy.optimize import least_squares
    from scipy.spatial import cKDTree

    target = densify(dxf_water, step=1.0)
    if len(target) < 50:
        raise PipelineError(
            f"02_WATER yielded only {len(target)} densified points — too little "
            f"to register against."
        )
    tree = cKDTree(target)

    # Gate correspondences against the initial (geodetic) transform, which is
    # independently accurate to well under a metre.
    d0, _ = tree.query(initial.to_local(osm_coast_utm))
    gated = d0 <= gate
    n_gate_drop = int((~gated).sum())
    if gated.sum() < 50:
        raise PipelineError(
            f"Only {int(gated.sum())} of {len(d0)} OSM water vertices fall "
            f"within {gate:.0f} m of the traced 02_WATER polyline. Either the "
            f"traced water covers a different area than the OSM water in this "
            f"frame, or the anchor is wrong. Refusing to fit on that."
        )
    if n_gate_drop:
        log(f"  gated out {n_gate_drop}/{len(d0)} OSM vertices with no "
            f"counterpart in 02_WATER (> {gate:.0f} m)")
    osm_coast_utm = osm_coast_utm[gated]
    rel = osm_coast_utm - initial.origin_utm

    locked_scale = initial.scale

    def unpack(p: np.ndarray) -> tuple[float, float, float, float]:
        if fit_scale:
            return float(p[0]), float(p[1]), float(p[2]), float(p[3])
        return locked_scale, float(p[0]), float(p[1]), float(p[2])

    def make(p: np.ndarray) -> LocalFrame:
        sc, th, tx, ty = unpack(p)
        return LocalFrame(scale=sc, theta=th, origin_utm=initial.origin_utm,
                          offset=np.array([tx, ty]),
                          method="water-fit" + ("-with-scale" if fit_scale
                                                else " (scale locked)"))

    def transform(p: np.ndarray) -> np.ndarray:
        sc, th, tx, ty = unpack(p)
        c, s = math.cos(th), math.sin(th)
        R = np.array([[c, -s], [s, c]])
        return sc * rel @ R.T + np.array([tx, ty])

    p0 = [initial.theta, initial.offset[0], initial.offset[1]]
    p = np.array(([initial.scale] + p0) if fit_scale else p0, dtype=float)
    keep = np.ones(len(rel), dtype=bool)

    for rnd in range(rounds):
        idx = np.where(keep)[0]

        def resid(pv: np.ndarray, idx=idx) -> np.ndarray:
            d, _ = tree.query(transform(pv)[idx])
            return d

        sol = least_squares(resid, p, method="trf", loss="soft_l1",
                            f_scale=3.0, xtol=1e-12, ftol=1e-12)
        p = sol.x
        d_all, _ = tree.query(transform(p))
        cut = float(np.quantile(d_all, 1.0 - trim))
        keep = d_all <= cut
        log(f"  round {rnd + 1}: rms={np.sqrt(np.mean(d_all[keep] ** 2)):7.3f} m  "
            f"median={np.median(d_all[keep]):6.3f} m  "
            f"kept={keep.sum()}/{len(keep)}")

    d_all, _ = tree.query(transform(p))
    d = d_all[keep]
    sc, th, _tx, _ty = unpack(p)
    drift = abs(math.degrees(th - initial.theta))
    if drift > 0.5:
        log(f"  !! fitted rotation moved {drift:.3f} deg away from the grid "
            f"convergence. That is far more than the projection allows — the "
            f"solver has probably locked onto the wrong stretch of coastline.")
    stats = {
        "rms": float(np.sqrt(np.mean(d ** 2))),
        "median": float(np.median(d)),
        "p90": float(np.quantile(d, 0.90)),
        "n_points": int(len(d_all)),
        "n_kept": int(keep.sum()),
        "n_gated_out": n_gate_drop,
        "scale": sc,
        "scale_fitted": bool(fit_scale),
        "rotation_deg": float(math.degrees(th)),
        "rotation_drift_deg": drift,
    }
    return make(p), stats


def grid_bearing_check(road_lines_local: Iterable[np.ndarray]) -> dict:
    """
    Independent rotation check: measure the two dominant street bearings and
    compare against the surveyed 44 / 136 deg grid. Validates rotation without
    reference to translation.

    Done with circular statistics, not a binned argmax. Street bearings are
    axial (mod 180) and a smoothed histogram turns each spike into a plateau
    whose argmax lands wherever the sort happens to break ties — several degrees
    of pure noise, which is the same order as the error being tested for.

    Instead: the quadrupled-angle mean locates the grid axis (4*theta folds a
    near-rectilinear grid's two families onto each other), segments are split
    into the two families, and each family's bearing is the length-weighted
    doubled-angle circular mean. Sub-degree, bin-free, and it keeps the real
    grid's 92 deg internal angle rather than forcing orthogonality.
    """
    ang: list[float] = []
    wts: list[float] = []
    for pl in road_lines_local:
        seg = np.diff(pl, axis=0)
        L = np.hypot(seg[:, 0], seg[:, 1])
        ok = L > 5.0
        if not ok.any():
            continue
        ang.extend((np.degrees(np.arctan2(seg[ok, 1], seg[ok, 0])) % 180.0).tolist())
        wts.extend(L[ok].tolist())

    if len(ang) < 4:
        return {"ok": False, "reason": f"only {len(ang)} road segments over 5 m"}

    a = np.asarray(ang)
    w = np.asarray(wts)

    def circ_mean(angles: np.ndarray, weights: np.ndarray, fold: int) -> float:
        """Length-weighted circular mean of `fold`-multiplied angles, in deg."""
        z = np.sum(weights * np.exp(1j * fold * np.radians(angles)))
        return float((np.degrees(np.angle(z)) / fold) % (360.0 / fold))

    axis = circ_mean(a, w, 4)                       # grid axis, mod 90
    fam_a = np.abs((a - axis) % 180.0) < 45.0
    fam_a |= np.abs((a - axis) % 180.0) > 135.0
    fam_b = ~fam_a

    peaks: list[float] = []
    for mask in (fam_a, fam_b):
        if mask.sum() == 0 or w[mask].sum() <= 0:
            continue
        peaks.append(circ_mean(a[mask], w[mask], 2))
    peaks.sort()

    if len(peaks) < 2:
        return {"ok": False, "reason": "only one street family found",
                "peaks_deg": peaks, "expected_deg": list(GRID_BEARINGS_DEG),
                "total_length_m": float(w.sum())}

    def sep(x: float, y: float) -> float:
        return min(abs(x - y), 180.0 - abs(x - y))

    # Match measured peaks to expected bearings without assuming an order.
    errs = [max(sep(peaks[0], GRID_BEARINGS_DEG[0]),
                sep(peaks[1], GRID_BEARINGS_DEG[1])),
            max(sep(peaks[0], GRID_BEARINGS_DEG[1]),
                sep(peaks[1], GRID_BEARINGS_DEG[0]))]
    max_err = float(min(errs))

    return {
        "ok": max_err <= GRID_BEARING_TOL,
        "peaks_deg": [round(p, 2) for p in peaks],
        "expected_deg": list(GRID_BEARINGS_DEG),
        "max_error_deg": max_err,
        "internal_angle_deg": round(sep(peaks[0], peaks[1]), 2),
        "total_length_m": float(w.sum()),
    }


# ---------------------------------------------------------------------------
# 3. OSM -> shapely, in local metres
# ---------------------------------------------------------------------------

@dataclass
class OsmModel:
    buildings: list = field(default_factory=list)      # Polygon
    roads: list = field(default_factory=list)          # (LineString, cls, halfw)
    road_areas: list = field(default_factory=list)     # (Polygon, cls)
    railways: list = field(default_factory=list)       # LineString
    trees: list = field(default_factory=list)          # (Point, radius)
    parking: list = field(default_factory=list)        # Polygon
    green: list = field(default_factory=list)          # Polygon
    water: list = field(default_factory=list)          # Polygon
    coastline: list = field(default_factory=list)      # LineString
    waterways: list = field(default_factory=list)      # LineString
    tree_rows: list = field(default_factory=list)      # LineString
    road_classes: set = field(default_factory=set)


def _ll_array(geom_list) -> np.ndarray:
    return np.array([[g["lon"], g["lat"]] for g in geom_list], dtype=float)


def _tag_halfwidth(tags: dict, cls: str) -> float:
    """Explicit width/lanes tags beat the class default."""
    w = tags.get("width") or tags.get("est_width")
    if w:
        try:
            return max(float(str(w).split()[0]) / 2.0, 0.75)
        except ValueError:
            pass
    lanes = tags.get("lanes")
    if lanes:
        try:
            return max(int(float(lanes)) * LANE_WIDTH / 2.0, 0.75)
        except ValueError:
            pass
    return HALF_WIDTH.get(cls, 3.0)


def _rings_from_relation(el: dict, project) -> list:
    """Stitch an OSM multipolygon relation into shapely polygons."""
    from shapely.geometry import LineString, Polygon
    from shapely.ops import polygonize, unary_union

    def build(role: str):
        lines = []
        for m in el.get("members", []):
            if m.get("type") != "way" or not m.get("geometry"):
                continue
            if m.get("role", "outer") != role:
                continue
            xy = project(_ll_array(m["geometry"]))
            if len(xy) >= 2:
                lines.append(LineString(xy))
        if not lines:
            return []
        # unary_union nodes the members where they meet; polygonize then closes
        # the rings. linemerge is deliberately not used here — it raises on a
        # single already-closed ring, which is what most OSM building
        # multipolygons actually are.
        noded = unary_union(lines)
        parts = list(noded.geoms) if hasattr(noded, "geoms") else [noded]
        return [p for p in polygonize(parts) if p.is_valid and p.area > 0]

    outers = build("outer")
    inners = build("inner")
    if not outers:
        return []
    if not inners:
        return outers
    holes = unary_union(inners)
    out = []
    for o in outers:
        try:
            d = o.difference(holes)
        except Exception:                                  # noqa: BLE001
            d = o
        if d.is_empty:
            continue
        out.extend(list(d.geoms) if d.geom_type == "MultiPolygon" else [d])
    return [p for p in out if isinstance(p, Polygon)]


def parse_osm(raw: dict, frame: LocalFrame, clip_bounds) -> OsmModel:
    """Convert the cached Overpass payload into local-metre shapely geometry."""
    from pyproj import Transformer
    from shapely.geometry import LineString, Point, Polygon, box
    from shapely.validation import make_valid

    tf = Transformer.from_crs(WGS84, UTM_EPSG, always_xy=True)
    clip = box(*clip_bounds)

    def project(lonlat: np.ndarray) -> np.ndarray:
        x, y = tf.transform(lonlat[:, 0], lonlat[:, 1])
        return frame.to_local(np.column_stack([x, y]))

    m = OsmModel()
    n_skipped = 0

    for el in raw.get("elements", []):
        tags = el.get("tags", {}) or {}
        etype = el.get("type")

        if etype == "node":
            if tags.get("natural") == "tree":
                xy = project(np.array([[el["lon"], el["lat"]]]))[0]
                p = Point(xy)
                if not clip.contains(p):
                    continue
                r = DEFAULT_TREE_RADIUS
                for key in ("diameter_crown", "crown_diameter", "canopy"):
                    if tags.get(key):
                        try:
                            r = max(float(str(tags[key]).split()[0]) / 2.0, 0.8)
                            break
                        except ValueError:
                            pass
                m.trees.append((p, r))
            continue

        if etype == "relation":
            polys = _rings_from_relation(el, project)
            polys = [p for p in polys if p.intersects(clip)]
            if not polys:
                continue
            if "building" in tags:
                m.buildings.extend(polys)
            elif tags.get("amenity") == "parking":
                m.parking.extend(polys)
            elif tags.get("natural") == "water" or tags.get("landuse") == "harbour":
                m.water.extend(polys)
            elif tags.get("leisure") == "park":
                m.green.extend(polys)
            continue

        if etype != "way" or not el.get("geometry"):
            continue

        xy = project(_ll_array(el["geometry"]))
        if len(xy) < 2:
            continue
        closed = (len(xy) >= 4 and
                  abs(xy[0, 0] - xy[-1, 0]) < 1e-6 and
                  abs(xy[0, 1] - xy[-1, 1]) < 1e-6)

        def as_poly():
            if not closed:
                return None
            p = Polygon(xy)
            if not p.is_valid:
                p = make_valid(p)
            if p.geom_type == "GeometryCollection":
                parts = [g for g in p.geoms if g.geom_type == "Polygon"]
                p = max(parts, key=lambda g: g.area) if parts else None
            elif p.geom_type == "MultiPolygon":
                p = max(p.geoms, key=lambda g: g.area)
            return p if (p is not None and p.geom_type == "Polygon"
                         and p.area > 0) else None

        line = LineString(xy)
        if not line.intersects(clip):
            continue

        if "building" in tags:
            # building:part is deliberately excluded. It is Simple-3D-Buildings
            # detail subdividing a footprint that is already mapped as
            # `building`, so every part lies inside an outline the drawing
            # already has. Including them stacks duplicate outlines on the same
            # roof — clutter in a 2D line drawing, not information.
            p = as_poly()
            if p is not None:
                m.buildings.append(p)
            else:
                n_skipped += 1
        elif "highway" in tags:
            cls = tags["highway"]
            if cls in ("proposed", "construction", "raceway", "bus_stop"):
                continue
            m.road_classes.add(cls)
            if closed and tags.get("area") == "yes":
                # A pedestrian square is a SURFACE, already the shape we want.
                # Buffering its outline as if it were a centreline turns a
                # 40 m square into a 1.8 m-wide ring around a void — the square
                # reads as a donut. area=yes is the tag that distinguishes it
                # from a road that merely happens to close into a loop.
                ap = as_poly()
                if ap is not None:
                    m.road_areas.append((ap, cls))
                    continue
            m.roads.append((line, cls, _tag_halfwidth(tags, cls)))
        elif "railway" in tags:
            if tags["railway"] in ("abandoned", "razed", "proposed", "level_crossing"):
                continue
            m.railways.append(line)
        elif tags.get("natural") == "coastline":
            m.coastline.append(line)
        elif tags.get("natural") == "water" or tags.get("landuse") == "harbour":
            p = as_poly()
            if p is not None:
                m.water.append(p)
                m.coastline.append(LineString(p.exterior.coords))
        elif "waterway" in tags:
            if tags["waterway"] in ("dam", "weir", "lock_gate", "fuel"):
                continue
            p = as_poly()
            if p is not None:
                m.water.append(p)
            else:
                m.waterways.append(line)
        elif tags.get("amenity") == "parking":
            p = as_poly()
            if p is not None:
                m.parking.append(p)
        elif tags.get("natural") == "tree_row":
            m.tree_rows.append(line)
        elif (tags.get("leisure") == "park"
              or tags.get("landuse") in ("grass", "forest")
              or tags.get("natural") == "scrub"):
            p = as_poly()
            if p is not None:
                m.green.append(p)

    log(f"  buildings {len(m.buildings)}   roads {len(m.roads)} "
        f"(+{len(m.road_areas)} areas)   "
        f"rail {len(m.railways)}   trees {len(m.trees)}")
    log(f"  parking {len(m.parking)}   green {len(m.green)}   "
        f"water {len(m.water)}   coastline {len(m.coastline)}   "
        f"waterways {len(m.waterways)}")
    if n_skipped:
        log(f"  {n_skipped} building ways skipped (unclosed or degenerate)")
    return m


# ---------------------------------------------------------------------------
# 4. Drawing geometry — the interior/exterior split lives here
# ---------------------------------------------------------------------------

@dataclass
class Drawing:
    """Every entity carries an `inside` flag = inside the 600 x 600 cadrage."""
    polylines: list = field(default_factory=list)   # (layer, pts, closed, inside)
    circles: list = field(default_factory=list)     # (layer, cx, cy, r, inside)
    hatches: list = field(default_factory=list)     # (layer, poly, scale, inside)
    texts: list = field(default_factory=list)       # (layer, x, y, height, str)

    def add_poly(self, layer, pts, closed, inside):
        if len(pts) >= 2:
            self.polylines.append((layer, np.asarray(pts, float), closed, inside))

    def add_circle(self, layer, c, r, inside):
        self.circles.append((layer, float(c[0]), float(c[1]), float(r), inside))

    def add_hatch(self, layer, poly, scale, inside):
        self.hatches.append((layer, poly, scale, inside))

    def add_text(self, layer, x, y, height, text):
        self.texts.append((layer, float(x), float(y), float(height), str(text)))


def _study_box():
    from shapely.geometry import box
    return box(STUDY_MIN[0], STUDY_MIN[1], STUDY_MAX[0], STUDY_MAX[1])


def _frame_box(pad: float = 0.0):
    from shapely.geometry import box
    return box(FRAME_MIN[0] - pad, FRAME_MIN[1] - pad,
               FRAME_MAX[0] + pad, FRAME_MAX[1] + pad)


def _emit_lines(dwg: Drawing, geom, layer: str, inside: bool,
                closed: bool = False) -> int:
    """Write any shapely line/polygon geometry out as polylines."""
    if geom is None or geom.is_empty:
        return 0
    n = 0
    t = geom.geom_type
    if t in ("MultiLineString", "MultiPolygon", "GeometryCollection"):
        for g in geom.geoms:
            n += _emit_lines(dwg, g, layer, inside, closed)
    elif t == "LineString":
        dwg.add_poly(layer, np.array(geom.coords), closed, inside)
        n = 1
    elif t == "LinearRing":
        dwg.add_poly(layer, np.array(geom.coords)[:-1], True, inside)
        n = 1
    elif t == "Polygon":
        dwg.add_poly(layer, np.array(geom.exterior.coords)[:-1], True, inside)
        n = 1
        for ring in geom.interiors:
            dwg.add_poly(layer, np.array(ring.coords)[:-1], True, inside)
            n += 1
    return n


def _split_inside_outside(geom, study, frame):
    """Clip to the frame, then split at the cadrage boundary."""
    geom = geom.intersection(frame)
    if geom.is_empty:
        return None, None
    return geom.intersection(study), geom.difference(study)


def build_buildings(dwg: Drawing, model: OsmModel, stats: dict) -> None:
    """
    Footprints, simplified and area-filtered. Assigned to the study area or the
    context by *centroid*, never split — a building cut in half at the cadrage
    edge would read as two buildings.
    """
    study, frame = _study_box(), _frame_box()
    kept = dropped = 0
    area_in = 0.0
    for p in model.buildings:
        if not p.intersects(frame):
            continue
        p = p.simplify(SIMPLIFY_TOL, preserve_topology=True)
        if p.is_empty or p.area < MIN_BUILDING_AREA:
            dropped += 1
            continue
        inside = study.contains(p.centroid)
        base = ("21_BUILDINGS_MAJOR" if p.area >= MAJOR_BUILDING_AREA
                else "20_BUILDINGS_OSM")
        layer = base if inside else base + CTX_SUFFIX
        _emit_lines(dwg, p, layer, inside, closed=True)
        kept += 1
        if inside:
            area_in += p.area
    stats["buildings_total"] = kept
    stats["buildings_dropped_small"] = dropped
    stats["building_area_inside_m2"] = area_in
    log(f"  buildings kept {kept} (dropped {dropped} under "
        f"{MIN_BUILDING_AREA:.0f} m2), {area_in:,.0f} m2 inside the cadrage")


def build_roads(dwg: Drawing, model: OsmModel, stats: dict,
                per_class: bool = False) -> None:
    """
    OSM gives centrelines; the drawing needs edges. Buffer each centreline by
    its half-width, dissolve, take the boundary.

    Vehicular classes dissolve into ONE union by default. Dissolving per class
    closes each class's outline independently of the junctions it shares, so a
    line gets ruled straight across every crossing between two classes. Measured
    on the fixture: single union puts 0.0 % of its edge length inside the road
    surface, per-class 6.2 % (10.9 km of line drawn over open pavement).
    `--per-class-dissolve` restores the literal per-class behaviour.
    """
    from shapely.ops import unary_union

    study, frame = _study_box(), _frame_box()
    veh_bufs, foot_bufs, centrelines = [], [], []

    for line, cls, halfw in model.roads:
        buf = line.buffer(halfw, cap_style=3, join_style=2, mitre_limit=2.0)
        if buf.is_empty:
            continue
        (foot_bufs if cls in FOOTWAY_CLASSES else veh_bufs).append((cls, buf))
        centrelines.append(line)

    # Highway areas join the same dissolve — they are already road surface, so
    # they merge with the buffered centrelines that run into them.
    for poly, cls in model.road_areas:
        if not poly.is_empty:
            (foot_bufs if cls in FOOTWAY_CLASSES
             else veh_bufs).append((cls, poly))

    def dissolve_emit(items, layer_base: str) -> int:
        if not items:
            return 0
        groups: dict[str, list] = {}
        for cls, buf in items:
            groups.setdefault(cls if per_class else "_all", []).append(buf)
        count = 0
        for polys in groups.values():
            merged = unary_union(polys)
            edge = merged.boundary.simplify(0.25, preserve_topology=True)
            gin, gout = _split_inside_outside(edge, study, frame)
            count += _emit_lines(dwg, gin, layer_base, True)
            count += _emit_lines(dwg, gout, layer_base + CTX_SUFFIX, False)
        return count

    n_edge = dissolve_emit(veh_bufs, "30_ROAD_EDGE")
    n_foot = dissolve_emit(foot_bufs, "32_FOOTWAY")

    for line in centrelines:
        gin, gout = _split_inside_outside(line, study, frame)
        _emit_lines(dwg, gin, "31_ROAD_CENTRELINE", True)
        _emit_lines(dwg, gout, "31_ROAD_CENTRELINE" + CTX_SUFFIX, False)

    stats["road_edge_polylines"] = n_edge
    stats["footway_polylines"] = n_foot
    stats["road_classes_present"] = sorted(model.road_classes)
    stats["road_areas"] = len(model.road_areas)
    log(f"  road edges {n_edge}, footway edges {n_foot}, "
        f"centrelines {len(centrelines)}, "
        f"highway areas {len(model.road_areas)}")


def build_railway(dwg: Drawing, model: OsmModel, stats: dict) -> None:
    """Centreline plus a 3.0 m hatched band."""
    from shapely.ops import unary_union

    study, frame = _study_box(), _frame_box()
    n = 0
    for line in model.railways:
        gin, gout = _split_inside_outside(line, study, frame)
        n += _emit_lines(dwg, gin, "33_RAILWAY", True)
        n += _emit_lines(dwg, gout, "33_RAILWAY" + CTX_SUFFIX, False)

    if model.railways:
        band = unary_union([l.buffer(RAIL_BAND_HALF, cap_style=2)
                            for l in model.railways])
        bin_, bout = _split_inside_outside(band, study, frame)
        for geom, layer, ins in ((bin_, "33_RAILWAY", True),
                                 (bout, "33_RAILWAY" + CTX_SUFFIX, False)):
            if geom is None or geom.is_empty:
                continue
            _emit_lines(dwg, geom, layer, ins)
            parts = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
            for pp in parts:
                if pp.geom_type == "Polygon":
                    dwg.add_hatch(layer, pp, 1.0, ins)
    stats["railway_polylines"] = n
    log(f"  railway lines {n} (+ {RAIL_BAND_HALF * 2:.1f} m hatched band)")


def build_parking(dwg: Drawing, model: OsmModel, stats: dict) -> None:
    """Outline plus a light 45 deg hatch."""
    study, frame = _study_box(), _frame_box()
    n = 0
    for p in model.parking:
        if not p.intersects(frame) or p.area < 20.0:
            continue
        p = p.simplify(SIMPLIFY_TOL, preserve_topology=True)
        gin, gout = _split_inside_outside(p, study, frame)
        for geom, layer, ins in ((gin, "34_PARKING", True),
                                 (gout, "34_PARKING" + CTX_SUFFIX, False)):
            if geom is None or geom.is_empty:
                continue
            n += _emit_lines(dwg, geom, layer, ins, closed=True)
            parts = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
            for pp in parts:
                if pp.geom_type == "Polygon" and pp.area > 20.0:
                    dwg.add_hatch(layer, pp, 3.0, ins)
    stats["parking_polylines"] = n
    log(f"  parking outlines {n}")


def build_green_and_trees(dwg: Drawing, model: OsmModel, stats: dict) -> None:
    """
    Individually mapped trees become circles. Parks and tree rows are outlined
    only — no invented trees scattered inside them.
    """
    study, frame = _study_box(), _frame_box()

    n_in = n_out = 0
    for pt, r in model.trees:
        if not frame.contains(pt):
            continue
        inside = study.contains(pt)
        dwg.add_circle("40_TREES" if inside else "40_TREES" + CTX_SUFFIX,
                       (pt.x, pt.y), r, inside)
        n_in += inside
        n_out += (not inside)

    n_green = 0
    for p in model.green:
        if not p.intersects(frame):
            continue
        gin, gout = _split_inside_outside(
            p.simplify(SIMPLIFY_TOL, preserve_topology=True), study, frame)
        n_green += _emit_lines(dwg, gin, "41_GREEN_AREA", True, closed=True)
        n_green += _emit_lines(dwg, gout, "41_GREEN_AREA" + CTX_SUFFIX,
                               False, closed=True)
    for line in model.tree_rows:
        gin, gout = _split_inside_outside(line, study, frame)
        n_green += _emit_lines(dwg, gin, "41_GREEN_AREA", True)
        n_green += _emit_lines(dwg, gout, "41_GREEN_AREA" + CTX_SUFFIX, False)

    stats["trees_inside"] = n_in
    stats["trees_outside"] = n_out
    stats["green_polylines"] = n_green
    stats["tree_rows"] = len(model.tree_rows)
    log(f"  trees {n_in} inside / {n_out} in context, "
        f"green outlines {n_green}, tree rows {len(model.tree_rows)}")


def build_grid(dwg: Drawing, cell: float = 100.0) -> None:
    """
    The 100 m analysis grid over the study square, with each cell labelled.

    The coverage report names sparse cells as A1..F6; without the grid in the
    drawing there is no way to find A1 in CAD, so the report is unactionable.
    The layer is frozen — it is a reading aid, not part of the site plan.
    """
    n = int(round((STUDY_MAX[0] - STUDY_MIN[0]) / cell))
    for i in range(n + 1):
        x = STUDY_MIN[0] + i * cell
        y = STUDY_MIN[1] + i * cell
        dwg.add_poly("80_GRID_100M", [(x, STUDY_MIN[1]), (x, STUDY_MAX[1])],
                     False, True)
        dwg.add_poly("80_GRID_100M", [(STUDY_MIN[0], y), (STUDY_MAX[0], y)],
                     False, True)
    for iy in range(n):
        for ix in range(n):
            dwg.add_text("80_GRID_100M",
                         STUDY_MIN[0] + ix * cell + 4.0,
                         STUDY_MIN[1] + iy * cell + 4.0,
                         7.0, f"{chr(ord('A') + ix)}{iy + 1}")
    log(f"  grid {n}x{n} cells of {cell:.0f} m, labelled A1-"
        f"{chr(ord('A') + n - 1)}{n} (layer frozen)")


def build_context_water(dwg: Drawing, model: OsmModel, stats: dict) -> None:
    """
    The traced 02_WATER polyline is authoritative but only covers the study
    area. Outside it there is no traced harbour edge, so OSM water is used —
    on 02_WATER_CTX, so the two provenances stay distinguishable.

    Both sources of harbour edge are drawn: water POLYGONS (natural=water,
    landuse=harbour) and open COASTLINE ways. OSM maps an open sea edge as
    `natural=coastline`, not as a closed polygon, so a polygon-only reading
    leaves the seaward side of a harbour blank — which here is most of the
    north-west of the frame, the Caudan basin and the quays.
    """
    from shapely.geometry import MultiLineString
    from shapely.ops import unary_union

    study, frame = _study_box(), _frame_box()
    n = 0

    if model.water:
        merged = unary_union(model.water).difference(study).intersection(frame)
        n += _emit_lines(dwg, merged, "02_WATER" + CTX_SUFFIX, False,
                         closed=True)
    if model.coastline:
        coast = MultiLineString(
            [l for l in model.coastline if l.geom_type == "LineString"])
        coast = coast.difference(study).intersection(frame)
        n += _emit_lines(dwg, coast, "02_WATER" + CTX_SUFFIX, False)

    stats["context_water_polylines"] = n
    log(f"  context water + coastline outlines {n} "
        f"(OSM — outside the cadrage only)")


def build_waterways(dwg: Drawing, model: OsmModel, stats: dict) -> None:
    """
    Linear watercourses — canals, drains, rivers. Distinct content from the
    traced harbour edge, so they get their own layer and are drawn on both
    sides of the cadrage rather than being suppressed inside it.
    """
    study, frame = _study_box(), _frame_box()
    n = 0
    for line in model.waterways:
        gin, gout = _split_inside_outside(line, study, frame)
        n += _emit_lines(dwg, gin, "35_WATERWAY", True)
        n += _emit_lines(dwg, gout, "35_WATERWAY" + CTX_SUFFIX, False)
    stats["waterway_polylines"] = n
    log(f"  waterways {n}")


# ---------------------------------------------------------------------------
# 5. DXF output
# ---------------------------------------------------------------------------

def _ensure_layer(doc, name: str, colour: int, weight: int, frozen=False):
    if name in doc.layers:
        lay = doc.layers.get(name)
    else:
        lay = doc.layers.add(name)
    lay.color = colour
    lay.dxf.lineweight = weight
    if frozen:
        lay.freeze()
    return lay


def _assert_layers_defined(doc, dwg: Drawing) -> None:
    """
    Every layer an entity is written to must have a LAYER table entry.

    DXF lets you reference a layer that was never defined — the entity lands on
    an implicit layer with default colour and lineweight and no frozen flag, and
    nothing errors. Both 35_WATERWAY and 80_GRID_100M shipped that way once,
    because the edit adding them to LAYERS silently failed to apply and only the
    entity count was checked. This turns that silence into a hard failure.
    """
    used = ({layer for layer, *_ in dwg.polylines}
            | {c[0] for c in dwg.circles}
            | {h[0] for h in dwg.hatches}
            | {t[0] for t in dwg.texts})
    missing = sorted(l for l in used if l not in doc.layers)
    if missing:
        raise PipelineError(
            "These layers have entities but no LAYER table entry, so they "
            "would inherit default colour and lineweight in CAD: "
            + ", ".join(missing)
            + ". Add them to LAYERS (context layers are derived automatically)."
        )


def write_dxf(out_path: Path, dwg: Drawing, base_dxf: Path | None,
              scale: float, insunits: int, dim_context: bool) -> dict:
    """
    Carry the verified base through untouched, then add the new layers.
    `scale` is 1.0 for the metre file and 1000.0 for the millimetre file.
    """
    import ezdxf

    info = {"carried_layers": [], "carried_entities": 0}

    if base_dxf and base_dxf.exists():
        doc = ezdxf.readfile(str(base_dxf))
        if doc.dxfversion < "AC1032":
            doc.dxfversion = "AC1032"                      # R2018
        info["carried_layers"] = [l for l in CARRY_LAYERS if l in doc.layers]
        info["carried_entities"] = sum(
            1 for e in doc.modelspace() if e.dxf.layer in CARRY_LAYERS)
    else:
        doc = ezdxf.new("R2018", setup=True)

    doc.header["$INSUNITS"] = insunits
    doc.header["$LWDISPLAY"] = 1
    msp = doc.modelspace()

    _ensure_layer(doc, "01_STUDY_AREA", 1, 50)
    _ensure_layer(doc, "00_IMAGE_FRAME", 8, 9)
    _ensure_layer(doc, "02_WATER" + CTX_SUFFIX,
                  DIM_COLOUR if dim_context else 5,
                  DIM_WEIGHT if dim_context else 13)

    for name, (colour, weight) in LAYERS.items():
        _ensure_layer(doc, name, colour, weight,
                      frozen=name in FROZEN_LAYERS)
        ctx = name + CTX_SUFFIX
        _ensure_layer(doc, ctx,
                      DIM_COLOUR if dim_context else colour,
                      DIM_WEIGHT if dim_context else weight,
                      frozen=name in FROZEN_LAYERS)

    _assert_layers_defined(doc, dwg)

    s = float(scale)

    def sc(pts: np.ndarray) -> list[tuple[float, float]]:
        return [(float(x) * s, float(y) * s) for x, y in pts]

    for layer, pts, closed, _inside in dwg.polylines:
        msp.add_lwpolyline(sc(pts), close=bool(closed),
                           dxfattribs={"layer": layer})
    for layer, cx, cy, r, _inside in dwg.circles:
        msp.add_circle((cx * s, cy * s), r * s, dxfattribs={"layer": layer})

    for layer, tx, ty, th, txt in dwg.texts:
        msp.add_text(txt, height=th * s,
                     dxfattribs={"layer": layer}).set_placement((tx * s, ty * s))

    n_hatch = 0
    for layer, poly, hscale, _inside in dwg.hatches:
        try:
            h = msp.add_hatch(color=256, dxfattribs={"layer": layer})
            h.set_pattern_fill("ANSI31", scale=hscale * s, angle=0.0)
            h.paths.add_polyline_path(sc(np.array(poly.exterior.coords)[:-1]),
                                      is_closed=True, flags=1)
            for ring in poly.interiors:
                h.paths.add_polyline_path(sc(np.array(ring.coords)[:-1]),
                                          is_closed=True, flags=0)
            n_hatch += 1
        except Exception as exc:                            # noqa: BLE001
            log(f"  hatch skipped on {layer}: {exc}")

    # Study square (heavy) and the outer frame — only if the base did not
    # already carry them, otherwise the file ends up with two coincident
    # polylines on the same layer and every snap in CAD becomes ambiguous.
    n_added = 0
    existing = {e.dxf.layer for e in msp}
    if "01_STUDY_AREA" not in existing:
        sq = [(STUDY_MIN[0], STUDY_MIN[1]), (STUDY_MAX[0], STUDY_MIN[1]),
              (STUDY_MAX[0], STUDY_MAX[1]), (STUDY_MIN[0], STUDY_MAX[1])]
        msp.add_lwpolyline(sc(np.array(sq)), close=True,
                           dxfattribs={"layer": "01_STUDY_AREA"})
        n_added += 1
    if "00_IMAGE_FRAME" not in existing:
        fr = [(FRAME_MIN[0], FRAME_MIN[1]), (FRAME_MAX[0], FRAME_MIN[1]),
              (FRAME_MAX[0], FRAME_MAX[1]), (FRAME_MIN[0], FRAME_MAX[1])]
        msp.add_lwpolyline(sc(np.array(fr)), close=True,
                           dxfattribs={"layer": "00_IMAGE_FRAME"})
        n_added += 1

    doc.saveas(str(out_path))
    info["entities"] = (len(dwg.polylines) + len(dwg.circles)
                        + len(dwg.texts) + n_hatch + n_added)
    info["hatches"] = n_hatch
    log(f"  wrote {out_path.name}  ({info['entities']} new entities, "
        f"{info['carried_entities']} carried)")
    return info


def write_scaled_copy(src: Path, dst: Path, factor: float,
                      insunits: int) -> None:
    """
    Produce the millimetre file by scaling the finished metre file uniformly.

    Rebuilding it from the source geometry instead would scale only the new
    entities and leave everything carried over from the base DXF in metres —
    a single file holding two unit systems, roads at 1:1000 against a harbour
    edge at 1:1. Transforming the completed drawing keeps every layer, carried
    or new, on one scale by construction.
    """
    import ezdxf
    from ezdxf.math import Matrix44

    doc = ezdxf.readfile(str(src))
    msp = doc.modelspace()
    m = Matrix44.scale(factor, factor, factor)
    n_ok = n_fail = 0
    for e in msp:
        try:
            e.transform(m)
            n_ok += 1
        except Exception as exc:                            # noqa: BLE001
            n_fail += 1
            log(f"  !! could not scale {e.dxftype()} on {e.dxf.layer}: {exc}")
    doc.header["$INSUNITS"] = insunits
    doc.header["$LWDISPLAY"] = 1
    doc.saveas(str(dst))
    log(f"  wrote {dst.name}  (x{factor:g} applied to {n_ok} entities"
        + (f", {n_fail} FAILED" if n_fail else "") + ")")


# ---------------------------------------------------------------------------
# 6. Previews
# ---------------------------------------------------------------------------

_PREVIEW_LW = {
    "01_STUDY_AREA": 1.10, "00_IMAGE_FRAME": 0.35,
    "02_WATER": 0.45, "03_WATERFRONT_EDGE": 0.35, "04_VEGETATION": 0.25,
    "10_AGWHP_BZ1_PARTIAL": 0.40, "11_AGWHP_BZ2_PARTIAL": 0.40,
    "12_AGWHP_CORE_VICINITY": 0.40,
    "21_BUILDINGS_MAJOR": 0.55, "20_BUILDINGS_OSM": 0.40,
    "30_ROAD_EDGE": 0.32, "32_FOOTWAY": 0.22, "33_RAILWAY": 0.22,
    "34_PARKING": 0.22, "35_WATERWAY": 0.28, "40_TREES": 0.22,
    "41_GREEN_AREA": 0.22,
}
SKIP_IN_PREVIEW = set(FROZEN_LAYERS)


def _base_layer(layer: str) -> str:
    return layer[:-len(CTX_SUFFIX)] if layer.endswith(CTX_SUFFIX) else layer


def collect_from_dxf(dxf_path: Path) -> dict:
    """
    Read back the written DXF for rendering.

    Previews are drawn from the file rather than from the in-memory Drawing so
    that what you look at is what actually shipped — the carried layers
    (02_WATER, the AGWHP zones, 04_VEGETATION) appear alongside the new
    geometry, and a fault in the DXF write path shows up in the image instead of
    hiding behind a preview built from different data.
    """
    import ezdxf

    doc = ezdxf.readfile(str(dxf_path))
    lines: dict[str, list] = {}
    circles: list = []
    hatches: list = []

    for e in doc.modelspace():
        layer = e.dxf.layer
        if _base_layer(layer) in SKIP_IN_PREVIEW:
            continue
        t = e.dxftype()
        try:
            if t == "LWPOLYLINE":
                pts = np.array([(x, y) for x, y in e.get_points("xy")], float)
                if e.closed and len(pts) > 2:
                    pts = np.vstack([pts, pts[:1]])
                lines.setdefault(layer, []).append(pts)
            elif t == "POLYLINE":
                pts = np.array([(v.dxf.location.x, v.dxf.location.y)
                                for v in e.vertices], float)
                if e.is_closed and len(pts) > 2:
                    pts = np.vstack([pts, pts[:1]])
                lines.setdefault(layer, []).append(pts)
            elif t == "LINE":
                lines.setdefault(layer, []).append(
                    np.array([(e.dxf.start.x, e.dxf.start.y),
                              (e.dxf.end.x, e.dxf.end.y)], float))
            elif t == "CIRCLE":
                circles.append((layer, e.dxf.center.x, e.dxf.center.y,
                                e.dxf.radius))
            elif t == "HATCH":
                for path in e.paths:
                    v = getattr(path, "vertices", None)
                    if v is not None and len(v) >= 3:
                        hatches.append(
                            (layer, np.array([(q[0], q[1]) for q in v], float)))
        except Exception:                                   # noqa: BLE001
            continue
    return {"lines": lines, "circles": circles, "hatches": hatches}


def _draw(ax, coll: dict, lw_scale: float = 1.0) -> None:
    from matplotlib.collections import LineCollection
    from matplotlib.patches import Circle, Polygon as MplPolygon

    for layer, pts in coll["hatches"]:
        base = _base_layer(layer)
        hatch = "////" if base == "33_RAILWAY" else "///"
        ax.add_patch(MplPolygon(pts, closed=True, fill=False, ec="black",
                                lw=0.12 * lw_scale, hatch=hatch, zorder=1))
    buckets: dict[float, list] = {}
    for layer, segs in coll["lines"].items():
        base = _base_layer(layer)
        if base == "01_STUDY_AREA":
            continue                       # drawn in red, separately
        lw = _PREVIEW_LW.get(base, 0.25) * lw_scale
        buckets.setdefault(lw, []).extend(segs)
    for lw, segs in sorted(buckets.items()):
        ax.add_collection(LineCollection(segs, colors="black", linewidths=lw,
                                         zorder=2))
    for layer, cx, cy, r in coll["circles"]:
        ax.add_patch(Circle((cx, cy), r, fill=False, ec="black",
                            lw=0.22 * lw_scale, zorder=3))


def render_preview(out_path: Path, coll: dict, extent: str = "frame",
                   title: str = "") -> None:
    """White ground, black linework, study square in red."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    if extent == "study":
        x0, y0, x1, y1 = STUDY_MIN[0], STUDY_MIN[1], STUDY_MAX[0], STUDY_MAX[1]
        pad, lw_scale = 12.0, 1.6
    else:
        x0, y0, x1, y1 = FRAME_MIN[0], FRAME_MIN[1], FRAME_MAX[0], FRAME_MAX[1]
        pad, lw_scale = 20.0, 1.0

    w, h = (x1 - x0 + 2 * pad), (y1 - y0 + 2 * pad)
    fig, ax = plt.subplots(figsize=(16.0, 16.0 * h / w), dpi=200)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    _draw(ax, coll, lw_scale)
    ax.add_patch(plt.Rectangle((STUDY_MIN[0], STUDY_MIN[1]),
                               STUDY_MAX[0] - STUDY_MIN[0],
                               STUDY_MAX[1] - STUDY_MIN[1],
                               fill=False, ec="red", lw=1.1, zorder=10))
    ax.set_xlim(x0 - pad, x1 + pad)
    ax.set_ylim(y0 - pad, y1 + pad)
    ax.set_aspect("equal")
    ax.axis("off")
    if title:
        ax.set_title(title, fontsize=8, color="0.35", pad=6)
    fig.savefig(out_path, bbox_inches="tight", pad_inches=0.15,
                facecolor="white")
    plt.close(fig)
    log(f"  wrote {out_path.name}")


def render_qa_overlay(out_path: Path, coll: dict, sat_path: Path,
                      extent: str = "frame") -> bool:
    """
    Draw the DXF over the satellite at true scale — misalignment is obvious.

    The study-area variant matters more than the full frame for signing off a
    registration: 600 m across a page resolves a 3 m error, 1479 m does not.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    if not sat_path.exists():
        log(f"  {sat_path.name} not present — {extent} QA overlay skipped")
        return False

    if extent == "study":
        x0, y0, x1, y1 = (STUDY_MIN[0], STUDY_MIN[1], STUDY_MAX[0], STUDY_MAX[1])
        lw, cw = 0.75, 0.6
    else:
        x0, y0, x1, y1 = (FRAME_MIN[0], FRAME_MIN[1], FRAME_MAX[0], FRAME_MAX[1])
        lw, cw = 0.45, 0.35

    img = plt.imread(str(sat_path))
    fig, ax = plt.subplots(figsize=(18, 18 * (y1 - y0) / (x1 - x0)), dpi=170)
    ax.imshow(img, extent=[x0, x1, y0, y1], origin="upper")

    segs, water = [], []
    for layer, s in coll["lines"].items():
        base = _base_layer(layer)
        if base == "01_STUDY_AREA":
            continue
        (water if base in ("02_WATER", "03_WATERFRONT_EDGE")
         else segs).extend(s)
    ax.add_collection(LineCollection(segs, colors="#00ff88", linewidths=lw))
    if water:
        ax.add_collection(LineCollection(water, colors="#ffd400",
                                         linewidths=lw * 2))
    for _layer, cx, cy, r in coll["circles"]:
        ax.add_patch(plt.Circle((cx, cy), r, fill=False, ec="#00ff88", lw=cw))
    ax.add_patch(plt.Rectangle((STUDY_MIN[0], STUDY_MIN[1]), 600, 600,
                               fill=False, ec="red", lw=1.4))
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(out_path, bbox_inches="tight", pad_inches=0.05)
    plt.close(fig)
    log(f"  wrote {out_path.name}  (green = OSM linework, "
        f"yellow = traced water, red = cadrage)")
    return True


# ---------------------------------------------------------------------------
# 7. Coverage report
# ---------------------------------------------------------------------------

def coverage_grid(dwg: Drawing, cell: float = 100.0) -> dict:
    """
    Built-coverage ratio per 100 m cell, on a grid aligned to the local origin
    so the study cells match 80_GRID_100M.
    """
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union

    from shapely.geometry import LineString
    from shapely.strtree import STRtree

    polys, roads = [], []
    for layer, pts, closed, _ in dwg.polylines:
        base = layer[:-len(CTX_SUFFIX)] if layer.endswith(CTX_SUFFIX) else layer
        if base in ("20_BUILDINGS_OSM", "21_BUILDINGS_MAJOR"):
            if not closed or len(pts) < 3:
                continue
            p = Polygon(pts)
            if p.is_valid and p.area > 0:
                polys.append(p)
        elif base in ("30_ROAD_EDGE", "32_FOOTWAY") and len(pts) >= 2:
            seq = np.vstack([pts, pts[:1]]) if closed and len(pts) > 2 else pts
            roads.append(LineString(seq))
    built = unary_union(polys) if polys else None
    road_tree = STRtree(roads) if roads else None

    def road_len(b) -> float:
        """Road-edge length inside a cell."""
        if road_tree is None:
            return 0.0
        total = 0.0
        for i in road_tree.query(b):
            total += roads[int(i)].intersection(b).length
        return total

    def ratio(b) -> float:
        if built is None:
            return 0.0
        try:
            return float(built.intersection(b).area / b.area)
        except Exception:                                   # noqa: BLE001
            return 0.0

    study_cells, roadless = {}, []
    for iy in range(6):
        for ix in range(6):
            b = box(ix * cell, iy * cell, (ix + 1) * cell, (iy + 1) * cell)
            name = f"{chr(ord('A') + ix)}{iy + 1}"
            r = ratio(b)
            study_cells[name] = r
            # Buildings but no road edge: the block is mapped, the street
            # serving it is not. That is the signature of a road missing from
            # OSM rather than of an empty block.
            if r > 0.03 and road_len(b) < 20.0:
                roadless.append(name)

    ix0 = int(math.floor(FRAME_MIN[0] / cell))
    ix1 = int(math.ceil(FRAME_MAX[0] / cell))
    iy0 = int(math.floor(FRAME_MIN[1] / cell))
    iy1 = int(math.ceil(FRAME_MAX[1] / cell))
    study = _study_box()
    ext_empty, ext_ratios, ext_roadless = [], [], []
    for iy in range(iy0, iy1):
        for ix in range(ix0, ix1):
            b = box(ix * cell, iy * cell, (ix + 1) * cell, (iy + 1) * cell)
            if b.intersection(_frame_box()).area < 0.25 * b.area:
                continue
            if study.contains(b.centroid):
                continue
            r = ratio(b)
            ext_ratios.append(r)
            if r < 0.005:
                ext_empty.append((f"({ix * 100},{iy * 100})", r))
            elif r > 0.03 and road_len(b) < 20.0:
                ext_roadless.append(f"({ix * 100},{iy * 100})")

    total_built = ratio(_study_box())
    return {
        "study_cells": study_cells,
        "study_ratio": total_built,
        "ext_cells_total": len(ext_ratios),
        "ext_cells_empty": ext_empty,
        "ext_mean_ratio": float(np.mean(ext_ratios)) if ext_ratios else 0.0,
        "roadless_study_cells": roadless,
        "roadless_ext_cells": ext_roadless,
    }


def write_report(path: Path, stats: dict, reg: dict, cov: dict,
                 frame: LocalFrame, notes: list[str]) -> None:
    L: list[str] = []
    A = L.append
    A("# Port Louis site base — coverage report")
    A("")
    A(f"Generated {time.strftime('%Y-%m-%d %H:%M:%S')}  ")
    A(f"Extent: full satellite frame "
      f"{frame_size()[0]:.2f} x {frame_size()[1]:.2f} m, "
      f"study square 600.000 x 600.000 m")
    A("")

    A("## 1. Registration")
    A("")
    A(f"- Transform: `{frame.describe()}`")
    if reg.get("stats"):
        s = reg["stats"]
        A(f"- Fitted to traced `02_WATER`: **rms {s['rms']:.2f} m**, "
          f"median {s['median']:.2f} m, p90 {s['p90']:.2f} m "
          f"({s['n_kept']}/{s['n_points']} points kept after 10 % trim; "
          f"{s.get('n_gated_out', 0)} gated out beforehand as having no "
          f"counterpart in the traced water)")
        A(f"- Scale {'solved by the fit' if s.get('scale_fitted') else 'locked to the geodetic point scale factor'}"
          f" ({s['scale']:.8f}); rotation moved "
          f"{s.get('rotation_drift_deg', 0.0):.3f} deg from grid convergence")
    else:
        A("- **No water fit performed** — "
          f"{reg.get('reason', 'base DXF unavailable')}. "
          "Registration is the geodetic anchor solution, which is exact to "
          "well under a metre in itself; what it cannot confirm is that the "
          "hand-traced harbour edge agrees with it.")
    d = reg.get("anchor_distance_m")
    if d is not None:
        verdict = "PASS" if d <= ANCHOR_TOL else "**FAIL**"
        A(f"- Aapravasi Ghat check: anchor lands {d:.2f} m from the expected "
          f"{ANCHOR_LOCAL} (tolerance {ANCHOR_TOL:.0f} m) — {verdict}")
    g = reg.get("grid_check") or {}
    if g.get("peaks_deg"):
        verdict = "PASS" if g.get("ok") else "**FAIL**"
        A(f"- Street-grid bearing check: dominant peaks "
          f"{g['peaks_deg'][0]:.1f} deg / {g['peaks_deg'][1]:.1f} deg vs "
          f"measured {GRID_BEARINGS_DEG[0]:.0f} / {GRID_BEARINGS_DEG[1]:.0f} "
          f"(max error {g['max_error_deg']:.2f} deg) — {verdict}")
    A("")

    A("## 2. Content inside the 600 x 600 m study square")
    A("")
    A("| Metric | Value |")
    A("|---|---|")
    A(f"| Buildings drawn (frame total) | {stats.get('buildings_total', 0)} |")
    A(f"| Building footprint area inside square | "
      f"{stats.get('building_area_inside_m2', 0.0):,.0f} m2 |")
    A(f"| Built-coverage ratio inside square | "
      f"**{cov['study_ratio'] * 100:.1f} %** |")
    A(f"| Footprints dropped (< {MIN_BUILDING_AREA:.0f} m2) | "
      f"{stats.get('buildings_dropped_small', 0)} |")
    A(f"| Tree nodes inside square | {stats.get('trees_inside', 0)} |")
    A(f"| Tree nodes in context ring | {stats.get('trees_outside', 0)} |")
    A(f"| Tree rows (outlined, not populated) | {stats.get('tree_rows', 0)} |")
    A(f"| Road-edge polylines | {stats.get('road_edge_polylines', 0)} |")
    A(f"| Footway-edge polylines | {stats.get('footway_polylines', 0)} |")
    A(f"| Parking outlines | {stats.get('parking_polylines', 0)} |")
    A(f"| Railway polylines | {stats.get('railway_polylines', 0)} |")
    A(f"| Waterway polylines | {stats.get('waterway_polylines', 0)} |")
    A("")
    A("A built-coverage ratio well under ~35 % in a dense central-Port-Louis "
      "block usually means OSM is incomplete there, not that the block is "
      "open. Check the sparse cells below against the satellite before "
      "presenting the drawing.")
    A("")

    A("### 100 m grid inside the square (built coverage, %)")
    A("")
    A("| | A | B | C | D | E | F |")
    A("|---|---|---|---|---|---|---|")
    for iy in range(6, 0, -1):
        row = [f"{cov['study_cells'][f'{chr(ord(chr(65)) + ix)}{iy}'] * 100:.0f}"
               for ix in range(6)]
        A(f"| **{iy}** | " + " | ".join(row) + " |")
    A("")
    sparse = sorted((k for k, v in cov["study_cells"].items() if v < 0.08),
                    key=lambda k: cov["study_cells"][k])
    if sparse:
        A(f"**Sparse or empty cells ({len(sparse)}):** " +
          ", ".join(f"{k} ({cov['study_cells'][k] * 100:.0f} %)"
                    for k in sparse))
    else:
        A("No cell falls below 8 % coverage.")
    A("")

    A("## 3. Context ring (inside the frame, outside the square)")
    A("")
    A(f"- 100 m cells evaluated: {cov['ext_cells_total']}")
    A(f"- Mean built coverage: {cov['ext_mean_ratio'] * 100:.1f} %")
    A(f"- Cells with effectively no buildings: {len(cov['ext_cells_empty'])}")
    if cov["ext_cells_empty"]:
        show = cov["ext_cells_empty"][:40]
        A("")
        A("Empty cells, by SW corner in local metres"
          + (f" (first 40 of {len(cov['ext_cells_empty'])})"
             if len(cov["ext_cells_empty"]) > 40 else "") + ":")
        A("")
        A("`" + "`, `".join(c for c, _ in show) + "`")
        A("")
        A("Many of these are legitimately empty — harbour water, quays, the "
          "Caudan basin and the motorway corridor. Cross-check against the "
          "satellite rather than assuming missing data.")
    A("")

    A("## 4. Road classes present in OSM")
    A("")
    classes = stats.get("road_classes_present", [])
    A(", ".join(f"`{c}`" for c in classes) if classes else "_none_")
    A("")
    A("Classes visible in the imagery but absent from this list are missing "
      "from OSM and must be traced by hand.")
    A("")
    A("### Blocks with buildings but no road edge")
    A("")
    A("A cell holding mapped footprints but no street serving them is the "
      "signature of a road missing from OSM, not of an open block. These are "
      "the cells to check against the imagery first.")
    A("")
    rl = cov.get("roadless_study_cells") or []
    if rl:
        A(f"- Inside the square ({len(rl)}): " +
          ", ".join(f"**{c}**" for c in rl))
    else:
        A("- Inside the square: none — every built cell has road edge in it.")
    rle = cov.get("roadless_ext_cells") or []
    if rle:
        A(f"- Context ring ({len(rle)}), by SW corner in local metres: "
          + "`" + "`, `".join(rle[:30]) + "`"
          + (f" … and {len(rle) - 30} more" if len(rle) > 30 else ""))
    else:
        A("- Context ring: none.")
    A("")

    if notes:
        A("## 5. Notes and deviations")
        A("")
        for n in notes:
            A(f"- {n}")
        A("")

    path.write_text("\n".join(L))
    log(f"  wrote {path.name}")


# ---------------------------------------------------------------------------
# 8. Pipeline
# ---------------------------------------------------------------------------

def _to_utm(fr: LocalFrame, local: np.ndarray) -> np.ndarray:
    """Inverse of LocalFrame.to_local."""
    local = np.asarray(local, float).reshape(-1, 2)
    return (local - fr.offset) @ fr.rot / fr.scale + fr.origin_utm


def osm_bbox_for_frame(fr: LocalFrame, margin: float) -> tuple[float, ...]:
    """(south, west, north, east) covering the frame plus a margin."""
    from pyproj import Transformer

    corners = np.array([
        [FRAME_MIN[0] - margin, FRAME_MIN[1] - margin],
        [FRAME_MAX[0] + margin, FRAME_MIN[1] - margin],
        [FRAME_MAX[0] + margin, FRAME_MAX[1] + margin],
        [FRAME_MIN[0] - margin, FRAME_MAX[1] + margin],
    ])
    utm = _to_utm(fr, corners)
    inv = Transformer.from_crs(UTM_EPSG, WGS84, always_xy=True)
    lon, lat = inv.transform(utm[:, 0], utm[:, 1])
    return (float(min(lat)), float(min(lon)), float(max(lat)), float(max(lon)))


def extract_coastline_utm(raw: dict, fr: LocalFrame, pad: float = 250.0
                          ) -> np.ndarray:
    """
    OSM coastline / water-boundary vertices in UTM, limited to the frame plus a
    pad. Fitting to distant coast would drag the solution.
    """
    from pyproj import Transformer

    tf = Transformer.from_crs(WGS84, UTM_EPSG, always_xy=True)
    lonlat: list[np.ndarray] = []
    for el in raw.get("elements", []):
        tags = el.get("tags", {}) or {}
        is_water = (tags.get("natural") in ("coastline", "water")
                    or tags.get("landuse") == "harbour")
        if not is_water:
            continue
        if el.get("type") == "way" and el.get("geometry"):
            lonlat.append(_ll_array(el["geometry"]))
        elif el.get("type") == "relation":
            for mem in el.get("members", []):
                if mem.get("geometry"):
                    lonlat.append(_ll_array(mem["geometry"]))
    if not lonlat:
        return np.zeros((0, 2))

    ll = np.vstack(lonlat)
    x, y = tf.transform(ll[:, 0], ll[:, 1])
    utm = np.column_stack([x, y])
    loc = fr.to_local(utm)
    keep = ((loc[:, 0] > FRAME_MIN[0] - pad) & (loc[:, 0] < FRAME_MAX[0] + pad) &
            (loc[:, 1] > FRAME_MIN[1] - pad) & (loc[:, 1] < FRAME_MAX[1] + pad))
    return utm[keep]


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", default=".", type=Path)
    ap.add_argument("--base-dxf", default="PortLouis_StudyArea_BASE_metres.dxf")
    ap.add_argument("--satellite", default="satellite_FULLFRAME_1479x1038m.jpg")
    ap.add_argument("--satellite-study",
                    default="satellite_STUDYAREA_600x600m.jpg",
                    help="600 x 600 m raster, for the study-area QA overlay — "
                         "the one that actually resolves a few metres of "
                         "registration error.")
    ap.add_argument("--stage", choices=("register", "all"), default="all",
                    help="`register` stops after the fit and writes the QA "
                         "overlay, so the registration can be signed off "
                         "before any downstream layer inherits it.")
    ap.add_argument("--dim-context", action="store_true",
                    help="Draw the area outside the cadrage in grey hairline "
                         "instead of matching the study-area weights.")
    ap.add_argument("--per-class-dissolve", action="store_true",
                    help="Dissolve road buffers per highway class (literal "
                         "spec) instead of one vehicular union.")
    ap.add_argument("--fit-scale", action="store_true",
                    help="Let the water fit solve for scale too. Off by "
                         "default: scale is known exactly from the projection, "
                         "and freeing it lets coastline noise stretch the city.")
    ap.add_argument("--allow-no-base", action="store_true",
                    help="Proceed on the geodetic anchor alone when the base "
                         "DXF is absent. The water fit is then not performed.")
    args = ap.parse_args(argv)

    wd: Path = args.workdir.resolve()
    wd.mkdir(parents=True, exist_ok=True)
    base_dxf = wd / args.base_dxf
    sat = wd / args.satellite
    sat_study = wd / args.satellite_study
    notes: list[str] = []

    rule("1  Anchor and preliminary local frame")
    lon, lat = geocode_anchor(wd)
    fr = geodetic_frame(lon, lat)
    log(f"  {fr.describe()}")

    rule("2  OpenStreetMap")
    bbox = osm_bbox_for_frame(fr, OSM_MARGIN)
    log(f"  bbox S,W,N,E = {bbox[0]:.5f}, {bbox[1]:.5f}, "
        f"{bbox[2]:.5f}, {bbox[3]:.5f}  (frame + {OSM_MARGIN:.0f} m)")
    raw = fetch_osm(wd, bbox)

    rule("3  Registration")
    reg: dict = {}
    if base_dxf.exists():
        water = read_dxf_layer_lines(base_dxf, "02_WATER")
        coast = extract_coastline_utm(raw, fr)
        log(f"  traced 02_WATER polylines: {len(water)};  "
            f"OSM coastline vertices in frame: {len(coast)}")
        if len(water) and len(coast) >= 50:
            fr, stats_reg = register_to_water(coast, water, fr,
                                              fit_scale=args.fit_scale)
            reg["stats"] = stats_reg
            log(f"  {fr.describe()}")
            if stats_reg["rms"] > REG_RMS_ABORT:
                raise PipelineError(
                    f"Registration rms {stats_reg['rms']:.2f} m exceeds the "
                    f"{REG_RMS_ABORT:.0f} m limit. The fit failed; every "
                    f"downstream layer would inherit the error. Stopping."
                )
        else:
            reg["reason"] = (f"only {len(water)} 02_WATER polylines and "
                             f"{len(coast)} OSM coastline vertices available")
            notes.append("Water fit skipped — " + reg["reason"] +
                         ". Geodetic anchor registration used instead.")
            log(f"  SKIPPED — {reg['reason']}")
    else:
        reg["reason"] = f"{base_dxf.name} not found in {wd}"
        if not args.allow_no_base:
            raise PipelineError(
                f"{base_dxf.name} not found in {wd}.\n"
                f"It carries the verified layers ({', '.join(CARRY_LAYERS)}) "
                f"and the traced harbour edge the registration fits to.\n"
                f"Put it in the working directory, or pass --allow-no-base to "
                f"build on the geodetic anchor alone (the verified layers will "
                f"then be absent from the output)."
            )
        notes.append(f"`{base_dxf.name}` was absent: the verified layers were "
                     f"NOT carried through, and registration rests on the "
                     f"geodetic anchor with no water fit to confirm it.")
        log(f"  {reg['reason']} — continuing on the geodetic anchor "
            f"(--allow-no-base)")

    # Independent check 1: where does the geocoded anchor land?
    from pyproj import Transformer
    tf = Transformer.from_crs(WGS84, UTM_EPSG, always_xy=True)
    anchor_local = fr.to_local(np.array([tf.transform(lon, lat)]))[0]
    dist = float(np.hypot(*(anchor_local - np.array(ANCHOR_LOCAL))))
    reg["anchor_distance_m"] = dist
    log(f"  Aapravasi Ghat lands at ({anchor_local[0]:.1f}, "
        f"{anchor_local[1]:.1f}) — {dist:.2f} m from the expected "
        f"{ANCHOR_LOCAL}")
    if dist > ANCHOR_TOL:
        log(f"  !! beyond the {ANCHOR_TOL:.0f} m tolerance — the fit has "
            f"probably found a wrong local minimum. Inspect qa_overlay.png "
            f"before trusting anything downstream.")

    rule("4  Parse OSM into local metres")
    model = parse_osm(raw, fr, _frame_box(50.0).bounds)

    # Independent check 2: does the road grid sit at the measured bearings?
    reg["grid_check"] = grid_bearing_check(
        [np.array(l.coords) for l, _, _ in model.roads])
    g = reg["grid_check"]
    if g.get("peaks_deg"):
        log(f"  street-grid peaks {g['peaks_deg'][0]:.1f} / "
            f"{g['peaks_deg'][1]:.1f} deg vs measured "
            f"{GRID_BEARINGS_DEG[0]:.0f} / {GRID_BEARINGS_DEG[1]:.0f} "
            f"(max error {g['max_error_deg']:.2f} deg) "
            f"— {'PASS' if g['ok'] else 'FAIL'}")

    rule("5  Build drawing geometry")
    dwg = Drawing()
    stats: dict = {}
    build_buildings(dwg, model, stats)
    build_roads(dwg, model, stats, per_class=args.per_class_dissolve)
    build_railway(dwg, model, stats)
    build_parking(dwg, model, stats)
    build_green_and_trees(dwg, model, stats)
    build_context_water(dwg, model, stats)
    build_waterways(dwg, model, stats)
    build_grid(dwg)

    if args.stage == "register":
        rule("QA — registration only")
        tmp = wd / "qa_register.dxf"
        write_dxf(tmp, dwg, base_dxf if base_dxf.exists() else None,
                  scale=1.0, insunits=6, dim_context=args.dim_context)
        coll = collect_from_dxf(tmp)
        render_qa_overlay(wd / "qa_overlay.png", coll, sat)
        render_qa_overlay(wd / "qa_overlay_studyarea.png", coll, sat_study,
                          "study")
        render_preview(wd / "preview_register.png", coll, "frame",
                       "registration check — not the final drawing")
        log("")
        log("Registration stage complete. Check qa_overlay_studyarea.png "
            "first — at 600 m across it resolves a few metres of error, which "
            "the full frame does not. The green "
            "linework should sit on the roofs and kerbs, and the yellow traced "
            "water on the harbour edge. Then rerun without --stage register.")
        return 0

    rule("6  Write DXF")
    metres = wd / "PortLouis_SITE_metres.dxf"
    write_dxf(metres, dwg, base_dxf if base_dxf.exists() else None,
              scale=1.0, insunits=6, dim_context=args.dim_context)
    write_scaled_copy(metres, wd / "PortLouis_SITE_millimetres.dxf",
                      factor=1000.0, insunits=4)

    rule("7  Previews and report")
    coll = collect_from_dxf(metres)      # render what actually shipped
    render_preview(wd / "preview.png", coll, "frame")
    render_preview(wd / "preview_studyarea.png", coll, "study")
    render_qa_overlay(wd / "qa_overlay.png", coll, sat)
    render_qa_overlay(wd / "qa_overlay_studyarea.png", coll, sat_study, "study")

    cov = coverage_grid(dwg)
    if not args.per_class_dissolve:
        notes.append("Vehicular road buffers are dissolved into a single union "
                     "rather than per class. Measured on this data: the single "
                     "union draws 0.0 % of its edge length across open "
                     "pavement, per-class draws 6.2 % — every crossing between "
                     "two road classes gets a line ruled through it, because "
                     "each class's outline closes independently of the "
                     "junction it shares. `--per-class-dissolve` restores the "
                     "literal per-class behaviour.")
    notes.append("Geometry outside the cadrage sits on `*_CTX` layers, same "
                 "weights as the study area by default. `--dim-context` greys "
                 "them in one pass without touching the study-area layers.")
    notes.append("`02_WATER` is carried through untouched inside the square. "
                 "Outside it there is no traced harbour edge, so OSM water is "
                 "drawn on `02_WATER_CTX` — a different provenance, kept on a "
                 "separate layer rather than blended in.")
    notes.append("No footprint is vectorised from the raster and no tree is "
                 "invented inside a park polygon. Empty blocks in the output "
                 "are empty in OSM.")
    write_report(wd / "coverage_report.md", stats, reg, cov, fr, notes)

    rule("Done")
    log(f"  built coverage inside the square: {cov['study_ratio'] * 100:.1f} %")
    log(f"  outputs in {wd}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PipelineError as exc:
        log("")
        log("!" * 72)
        log(f"STOPPED: {exc}")
        log("!" * 72)
        sys.exit(2)

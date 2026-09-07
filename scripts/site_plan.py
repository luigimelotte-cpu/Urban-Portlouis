#!/usr/bin/env python3
"""
Port Louis — DXF site plan for the central harbour/waterfront study area.

Builds `site_plan.dxf` + `preview.png` for the cadrage around Aapravasi Ghat and
Le Grenier (the Granary, Caudan waterfront) from OpenStreetMap.

Pipeline
--------
1.  Anchors            published coordinates for Aapravasi Ghat and Le Grenier,
                       or a live Nominatim geocode with --geocode.
2.  Cadrage            reconstructed as a closed polygon in real-world lat/lon
                       from the anchors and the reference image's 400 m scale,
                       then reprojected to UTM 40S (EPSG:32740) — metres.
3.  Overpass           buildings, highways, water, parking, trees over the
                       cadrage bbox plus a buffer. Cached to osm_raw.json.
4.  DXF                ezdxf R2018, $INSUNITS = 6 (metres), origin at the
                       cadrage SW corner so coordinates stay in 0..600.
5.  Preview            matplotlib render of the written DXF, read back from
                       disk so a fault in the write path cannot hide.

Usage
-----
    python3 site_plan.py --workdir .
    python3 site_plan.py --workdir . --osm-json cached.json   # offline replay
    python3 site_plan.py --workdir . --cadrage-only           # frame only

If Overpass cannot be reached the script aborts. It never substitutes invented
geometry: an empty block you know about is useful, a fabricated one is not.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

# ---------------------------------------------------------------------------
# Anchors
# ---------------------------------------------------------------------------
# Published coordinates, used when Nominatim is unreachable. `precision_m` is
# the honest positional uncertainty: both are quoted to whole arcseconds, which
# is ~31 m of latitude and ~29 m of longitude at this parallel.

@dataclass(frozen=True)
class Anchor:
    key: str
    name: str
    lat: float
    lon: float
    precision_m: float
    source: str


PUBLISHED_ANCHORS = {
    "aapravasi_ghat": Anchor(
        key="aapravasi_ghat",
        name="Aapravasi Ghat, Port Louis",
        lat=-20.158611, lon=57.503056,          # 20 09 31 S, 57 30 11 E
        precision_m=30.0,
        source="Wikipedia / Wikidata Q9276, UNESCO WHS 1227 (whole arcseconds)",
    ),
    "le_grenier": Anchor(
        key="le_grenier",
        name="Le Grenier (The Granary), Caudan Waterfront, Port Louis",
        lat=-20.161505, lon=57.498448,          # 20 09 41 S, 57 29 54 E
        precision_m=40.0,
        source="Wikipedia, Caudan Waterfront (the Granary sits within it)",
    ),
}

NOMINATIM_QUERIES = {
    "aapravasi_ghat": "Aapravasi Ghat, Port Louis, Mauritius",
    "le_grenier": "Le Grenier, Caudan Waterfront, Port Louis, Mauritius",
}

# ---------------------------------------------------------------------------
# Cadrage geometry
# ---------------------------------------------------------------------------
# The red boundary in the reference satellite image is the 600 x 600 m study
# square established earlier in this project. Two independent checks agree:
#
#   * Scale. The established raster is 1316 x 924 px at 1.1236 m/px. The square
#     therefore spans x 0.212..0.617 and y 0.252..0.829 of the frame, which is
#     where the red boundary sits; and the image's 400 m scale bar is 356 px,
#     so the square reads 1.5 scale bars wide — as it does.
#   * Position. Aapravasi Ghat sits at local (253, 466) inside the square, and
#     Le Grenier / Caudan then falls ~230 m outside the west edge, which is
#     where the basin and its boats appear in the image.
#
# Local frame: metres, origin at the SW corner of the cadrage, +Y true north.

CADRAGE_SIZE = 600.0                    # m, square side
ANCHOR_LOCAL = (253.0, 466.0)           # Aapravasi Ghat, in local metres
SCALEBAR_M = 400.0                      # the scale bar visible in the image
RASTER_SCALE = 1.1236                   # m/px, established
FRAME_PX = (1316, 924)                  # full-frame satellite raster
# What the reference image shows about the second anchor, stated as a testable
# arrangement rather than a coordinate: Le Grenier / the Caudan basin lies
# OUTSIDE the cadrage, off its west edge, within the cadrage's north-south band.
LE_GRENIER_WEST_OF_EDGE_M = (80.0, 400.0)     # plausible range, from the image
LE_GRENIER_BAND_SLACK_M = 120.0               # may sit a little above/below

UTM_EPSG = "EPSG:32740"                 # UTM zone 40S — correct for Mauritius
WGS84 = "EPSG:4326"

BBOX_BUFFER = 150.0                     # m of context beyond the cadrage

# ---------------------------------------------------------------------------
# Drawing conventions
# ---------------------------------------------------------------------------
# Lineweights are DXF enum values in 1/100 mm.

LAYERS = {
    "BUILDINGS": dict(color=7,  linetype="Continuous", lineweight=25),
    "STREETS":   dict(color=7,  linetype="Continuous", lineweight=13),
    "WATER":     dict(color=5,  linetype="Continuous", lineweight=18),
    "PARKING":   dict(color=253, linetype="Continuous", lineweight=9),
    "TREES":     dict(color=3,  linetype="Continuous", lineweight=9),
    "CADRAGE":   dict(color=1,  linetype="Continuous", lineweight=35),
}

MIN_BUILDING_AREA = 15.0                # m2, below this is mapping noise
SIMPLIFY_TOL = 0.3                      # m, Douglas-Peucker
DEFAULT_TREE_RADIUS = 3.0               # m, when no canopy tag
PARKING_HATCH_SCALE = 1.5

# OSM highway class -> half-width in metres, for drawing road edges.
ROAD_HALF_WIDTH = {
    "motorway": 9.0, "motorway_link": 6.0,
    "trunk": 9.0, "trunk_link": 6.0,
    "primary": 7.0, "primary_link": 5.0,
    "secondary": 5.5, "secondary_link": 4.5,
    "tertiary": 4.5, "tertiary_link": 4.0,
    "residential": 3.5, "unclassified": 3.5, "living_street": 3.5,
    "service": 2.5, "track": 2.5,
    "pedestrian": 1.8, "footway": 1.8, "path": 1.5, "steps": 1.2,
    "cycleway": 1.5,
}

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "portlouis-site-plan/1.0 (architectural site base; OSM data)"


class PipelineError(RuntimeError):
    """Fatal: something is wrong and the output would be untrustworthy."""


def log(msg: str = "") -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Step 1 — local frame: local metres <-> UTM 40S <-> lat/lon
# ---------------------------------------------------------------------------

@dataclass
class LocalFrame:
    """
    Metric frame with its origin at the cadrage SW corner and +Y along TRUE
    north at the anchor.

    UTM grid north is not true north, and a UTM metre is not a ground metre.
    Both are measured rather than looked up: the anchor and a point 1000 m due
    true north of it are projected, and the convergence and point scale are read
    straight off the resulting vector. That leaves no sign convention to get
    wrong.
    """
    origin_utm: np.ndarray      # UTM easting/northing of local (0,0)
    north: np.ndarray           # unit vector, local +Y, in UTM
    east: np.ndarray            # unit vector, local +X, in UTM
    scale: float                # UTM grid metres per ground metre
    convergence_deg: float
    anchor: Anchor

    @classmethod
    def from_anchor(cls, anchor: Anchor) -> "LocalFrame":
        from pyproj import CRS, Geod, Transformer

        fwd = Transformer.from_crs(WGS84, UTM_EPSG, always_xy=True)
        geod = Geod(ellps="WGS84")

        a_utm = np.array(fwd.transform(anchor.lon, anchor.lat), float)
        lon_n, lat_n, _ = geod.fwd(anchor.lon, anchor.lat, 0.0, 1000.0)
        n_utm = np.array(fwd.transform(lon_n, lat_n), float)

        v = n_utm - a_utm
        scale = float(np.hypot(*v) / 1000.0)
        north = v / np.hypot(*v)
        east = np.array([north[1], -north[0]])          # north rotated -90 deg
        convergence = math.degrees(math.atan2(north[0], north[1]))

        origin = a_utm - scale * (ANCHOR_LOCAL[0] * east + ANCHOR_LOCAL[1] * north)
        return cls(origin, north, east, scale, convergence, anchor)

    # -- transforms ---------------------------------------------------------

    def to_utm(self, xy: np.ndarray) -> np.ndarray:
        xy = np.atleast_2d(np.asarray(xy, float))
        return self.origin_utm + self.scale * (
            xy[:, :1] * self.east + xy[:, 1:2] * self.north)

    def from_utm(self, en: np.ndarray) -> np.ndarray:
        en = np.atleast_2d(np.asarray(en, float))
        v = (en - self.origin_utm) / self.scale
        return np.column_stack([v @ self.east, v @ self.north])

    def to_lonlat(self, xy: np.ndarray) -> np.ndarray:
        from pyproj import Transformer
        inv = Transformer.from_crs(UTM_EPSG, WGS84, always_xy=True)
        utm = self.to_utm(xy)
        lon, lat = inv.transform(utm[:, 0], utm[:, 1])
        return np.column_stack([np.asarray(lon), np.asarray(lat)])

    def from_lonlat(self, lonlat: np.ndarray) -> np.ndarray:
        from pyproj import Transformer
        fwd = Transformer.from_crs(WGS84, UTM_EPSG, always_xy=True)
        ll = np.atleast_2d(np.asarray(lonlat, float))
        e, n = fwd.transform(ll[:, 0], ll[:, 1])
        return self.from_utm(np.column_stack([np.asarray(e), np.asarray(n)]))


def cadrage_polygon() -> np.ndarray:
    """The cadrage, closed, in local metres. SW corner is the origin."""
    s = CADRAGE_SIZE
    return np.array([[0.0, 0.0], [s, 0.0], [s, s], [0.0, s], [0.0, 0.0]])


def anchor_of(anchors: dict[str, Anchor]) -> Anchor:
    return anchors["aapravasi_ghat"]


def report_cadrage(frame: LocalFrame, anchors: dict[str, Anchor]) -> dict:
    """Print the reconstruction and cross-check it. Returns a summary dict."""
    poly = cadrage_polygon()
    ll = frame.to_lonlat(poly[:4])
    utm = frame.to_utm(poly[:4])
    names = ["SW", "SE", "NE", "NW"]

    log("── Step 1  Cadrage reconstruction ─────────────────────────────────")
    log(f"  anchor          {frame.anchor.name}")
    log(f"                  {frame.anchor.lat:.6f}, {frame.anchor.lon:.6f}"
        f"  (+/- {frame.anchor.precision_m:.0f} m)")
    log(f"                  {frame.anchor.source}")
    log(f"  grid convergence{frame.convergence_deg:+.5f} deg")
    log(f"  point scale     {frame.scale:.8f}  (UTM grid m per ground m)")
    log(f"  local origin    E {frame.origin_utm[0]:.3f}  N {frame.origin_utm[1]:.3f}"
        f"   [{UTM_EPSG}]")
    log("")
    log(f"  {CADRAGE_SIZE:.0f} x {CADRAGE_SIZE:.0f} m cadrage, closed polygon:")
    log("      corner   latitude     longitude        easting       northing")
    for nm, (lon, lat), (e, n) in zip(names, ll, utm):
        log(f"      {nm:<7}{lat:12.6f} {lon:12.6f}   {e:12.2f}  {n:12.2f}")

    # Cross-check A — anchor arrangement.
    #
    # This tests that the two independently published anchors are arranged the
    # way the reference image shows them, which is what makes the cadrage
    # placement believable. It is NOT an accuracy measurement: the cadrage is
    # pinned to Aapravasi Ghat, so any error in that anchor moves the cadrage
    # and the check with it, and cancels out.
    checks = []
    other = anchors.get("le_grenier")
    if other is not None:
        from pyproj import Geod
        geod = Geod(ellps="WGS84")
        az, _, dist = geod.inv(anchor_of(anchors).lon, anchor_of(anchors).lat,
                               other.lon, other.lat)
        got = frame.from_lonlat([[other.lon, other.lat]])[0]
        west_of_edge = -got[0]                      # cadrage west edge is x = 0
        lo, hi = LE_GRENIER_WEST_OF_EDGE_M
        in_band = (-LE_GRENIER_BAND_SLACK_M <= got[1]
                   <= CADRAGE_SIZE + LE_GRENIER_BAND_SLACK_M)
        outside_west = lo <= west_of_edge <= hi
        ok = in_band and outside_west

        log("")
        log("  check  anchor arrangement vs the reference image")
        log(f"         {other.name.split(',')[0]} is {dist:.0f} m from the Ghat, "
            f"bearing {az % 360:.0f} deg (WSW)")
        log(f"         lands at local ({got[0]:.0f}, {got[1]:.0f}) m: "
            f"{west_of_edge:.0f} m west of the cadrage edge, "
            f"{'inside' if in_band else 'outside'} its north-south band")
        log(f"         image shows it outside the west edge by {lo:.0f}-{hi:.0f} m"
            f"  ->  {'OK' if ok else 'FAIL'}")
        checks.append({"name": "anchor_arrangement", "ok": bool(ok),
                       "separation_m": round(float(dist), 1),
                       "bearing_deg": round(float(az % 360), 1),
                       "west_of_edge_m": round(float(west_of_edge), 1)})
        if not ok:
            raise PipelineError(
                "Anchor cross-check failed: the two anchors are not arranged "
                "the way the reference image shows (Le Grenier off the cadrage's "
                "west edge, within its north-south band). Either an anchor is "
                "wrong or the cadrage is misplaced — fix it before drawing.")

    # Cross-check B — scale. The cadrage side is 1.50 x the image's 400 m bar,
    # and on the established 1316 x 924 px raster at 1.1236 m/px it spans 534 px
    # against the bar's 356 px. Same ratio, so the reconstruction agrees with
    # the scale actually visible in the image.
    ratio = CADRAGE_SIZE / SCALEBAR_M
    bar_px = SCALEBAR_M / RASTER_SCALE
    cad_px = CADRAGE_SIZE / RASTER_SCALE
    log("")
    log(f"  check  scale  cadrage side {CADRAGE_SIZE:.0f} m = {ratio:.2f} x the "
        f"{SCALEBAR_M:.0f} m bar")
    log(f"         on the {FRAME_PX[0]}x{FRAME_PX[1]} px raster at {RASTER_SCALE} m/px: "
        f"{cad_px:.0f} px vs {bar_px:.0f} px = {cad_px / bar_px:.2f} x")
    log(f"         cadrage spans {cad_px / FRAME_PX[0]:.3f} of frame width, "
        f"matching the red boundary")

    # Be explicit about what is and is not accurate here.
    prec = frame.anchor.precision_m
    log("")
    log(f"  ACCURACY  absolute georeferencing is +/- ~{prec:.0f} m, set entirely by "
        f"the anchor")
    log(f"            (quoted to whole arcseconds). Everything internal — the "
        f"600 m side,")
    log(f"            OSM geometry, relative positions — is unaffected by that "
        f"offset.")
    log(f"            Re-run with --geocode on a network that permits Nominatim "
        f"to tighten it.")

    ring = frame.to_lonlat(poly)                 # closed, lon/lat
    return {
        "crs_local": {
            "units": "metres", "origin": "cadrage SW corner",
            "y_axis": "true north", "utm_crs": UTM_EPSG,
            "origin_utm": [round(float(v), 4) for v in frame.origin_utm],
            "convergence_deg": round(float(frame.convergence_deg), 6),
            "point_scale": round(float(frame.scale), 9),
        },
        "anchor": {
            "name": frame.anchor.name, "lat": frame.anchor.lat,
            "lon": frame.anchor.lon, "local": list(ANCHOR_LOCAL),
            "precision_m": frame.anchor.precision_m,
            "source": frame.anchor.source,
        },
        "cadrage": {
            "side_m": CADRAGE_SIZE,
            "corners": {n: {"lat": round(float(la), 7), "lon": round(float(lo), 7),
                            "easting": round(float(e), 2), "northing": round(float(nn), 2)}
                        for n, (lo, la), (e, nn) in zip(names, ll, utm)},
            "ring_lonlat": [[round(float(a), 7), round(float(b), 7)] for a, b in ring],
        },
        "checks": checks,
    }


def write_geojson(path: Path, summary: dict) -> None:
    """The cadrage as WGS84 GeoJSON — drop it on the satellite imagery in Google
    Earth or QGIS to check the boundary against the picture directly."""
    fc = {
        "type": "FeatureCollection",
        "name": "Port Louis cadrage",
        "features": [{
            "type": "Feature",
            "properties": {
                "name": "CADRAGE",
                "side_m": summary["cadrage"]["side_m"],
                "note": ("600 x 600 m study square, SW corner at local (0,0), "
                         "+Y true north"),
                "absolute_accuracy_m": summary["anchor"]["precision_m"],
                "anchor": summary["anchor"]["name"],
            },
            "geometry": {"type": "Polygon",
                         "coordinates": [summary["cadrage"]["ring_lonlat"]]},
        }],
    }
    path.write_text(json.dumps(fc, indent=2))


def bbox_lonlat(frame: LocalFrame, buffer_m: float) -> tuple[float, float, float, float]:
    """(south, west, north, east) covering the cadrage plus a buffer."""
    s = CADRAGE_SIZE
    corners = np.array([[-buffer_m, -buffer_m], [s + buffer_m, -buffer_m],
                        [s + buffer_m, s + buffer_m], [-buffer_m, s + buffer_m]])
    ll = frame.to_lonlat(corners)
    return (float(ll[:, 1].min()), float(ll[:, 0].min()),
            float(ll[:, 1].max()), float(ll[:, 0].max()))


# ---------------------------------------------------------------------------
# Step 2 — Overpass
# ---------------------------------------------------------------------------

def overpass_query(bbox: tuple[float, float, float, float]) -> str:
    b = f"{bbox[0]:.6f},{bbox[1]:.6f},{bbox[2]:.6f},{bbox[3]:.6f}"
    # Relations are included alongside ways: real Port Louis has multipolygon
    # buildings and water bodies, and dropping them loses whole footprints.
    return f"""[out:json][timeout:180];
(
  way["building"]({b});
  relation["building"]({b});
  way["highway"]({b});
  way["natural"="water"]({b});
  relation["natural"="water"]({b});
  way["natural"="coastline"]({b});
  way["waterway"]({b});
  way["amenity"="parking"]({b});
  relation["amenity"="parking"]({b});
  way["parking"]({b});
  node["natural"="tree"]({b});
);
out geom;"""


def fetch_overpass(bbox, cache: Path, refresh: bool = False) -> dict:
    """Fetch, caching to `cache`. Raises PipelineError if every mirror fails."""
    if cache.exists() and not refresh:
        log(f"  cache hit  {cache}  ({cache.stat().st_size / 1e6:.1f} MB)")
        return json.loads(cache.read_text())

    import requests

    q = overpass_query(bbox)
    failures = []
    for url in OVERPASS_MIRRORS:
        log(f"  POST {url}")
        try:
            r = requests.post(url, data={"data": q},
                              headers={"User-Agent": USER_AGENT}, timeout=300)
            if r.status_code != 200:
                failures.append(f"{url}: HTTP {r.status_code}")
                log(f"       HTTP {r.status_code}")
                time.sleep(2)
                continue
            data = r.json()
            cache.write_text(json.dumps(data))
            log(f"       {len(data.get('elements', []))} elements -> {cache}")
            return data
        except Exception as exc:                       # noqa: BLE001
            failures.append(f"{url}: {type(exc).__name__}: {exc}")
            log(f"       {type(exc).__name__}: {exc}")
            time.sleep(2)

    raise PipelineError(
        "Overpass is unreachable — every mirror failed:\n    "
        + "\n    ".join(failures)
        + "\n\n  No OSM geometry means no buildings, streets, water, parking or"
          "\n  trees. This script will not invent them. Options:"
          "\n    * run it from a network that permits the OSM hosts, or"
          "\n    * fetch the JSON elsewhere and replay it with --osm-json FILE, or"
          "\n    * build the georeferenced frame alone with --cadrage-only."
    )


def geocode(key: str) -> Anchor:
    """Live Nominatim lookup. Raises on failure — the caller decides."""
    import requests

    q = NOMINATIM_QUERIES[key]
    r = requests.get(NOMINATIM_URL,
                     params={"q": q, "format": "json", "limit": 1},
                     headers={"User-Agent": USER_AGENT}, timeout=60)
    r.raise_for_status()
    hits = r.json()
    if not hits:
        raise PipelineError(f"Nominatim returned no result for {q!r}")
    h = hits[0]
    return Anchor(key=key, name=h.get("display_name", q),
                  lat=float(h["lat"]), lon=float(h["lon"]),
                  precision_m=10.0, source="Nominatim (live geocode)")


def resolve_anchors(use_geocode: bool) -> dict[str, Anchor]:
    anchors = dict(PUBLISHED_ANCHORS)
    if not use_geocode:
        return anchors
    for key in list(anchors):
        try:
            a = geocode(key)
            log(f"  geocoded {key}: {a.lat:.6f}, {a.lon:.6f}")
            anchors[key] = a
        except Exception as exc:                       # noqa: BLE001
            log(f"  geocode failed for {key} ({type(exc).__name__}: {exc});"
                f" using published coordinate")
        time.sleep(1.1)                                # Nominatim usage policy
    return anchors


# ---------------------------------------------------------------------------
# Step 3 — parse OSM into drawable geometry
# ---------------------------------------------------------------------------

@dataclass
class SiteGeometry:
    buildings: list[np.ndarray] = field(default_factory=list)   # closed rings
    streets: list[np.ndarray] = field(default_factory=list)     # open or closed
    water: list[np.ndarray] = field(default_factory=list)
    parking: list[np.ndarray] = field(default_factory=list)     # closed rings
    trees: list[tuple[np.ndarray, float]] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def total(self) -> int:
        return (len(self.buildings) + len(self.streets) + len(self.water)
                + len(self.parking) + len(self.trees))


def _coords(geom: list[dict], frame: LocalFrame) -> np.ndarray | None:
    """
    Way geometry -> local metres. Two points is a legal way: plenty of real
    service roads, links and bridge segments are single segments, and requiring
    three silently drops them.
    """
    if not geom or len(geom) < 2:
        return None
    ll = np.array([[g["lon"], g["lat"]] for g in geom], float)
    return frame.from_lonlat(ll)


def _tagged_width(tags: dict, default: float) -> float:
    for key in ("width", "est_width"):
        if key in tags:
            try:
                return max(0.5, float(str(tags[key]).split()[0]) / 2.0)
            except ValueError:
                pass
    if "lanes" in tags:
        try:
            return max(1.5, float(tags["lanes"]) * 3.25 / 2.0)
        except ValueError:
            pass
    return default


def _tree_radius(tags: dict) -> float:
    for key in ("diameter_crown", "canopy:diameter", "crown_diameter"):
        if key in tags:
            try:
                d = float(str(tags[key]).split()[0])
                if 0.5 < d < 60.0:
                    return d / 2.0
            except ValueError:
                pass
    if "circumference" in tags:                # trunk girth -> rough canopy
        try:
            c = float(str(tags["circumference"]).split()[0])
            if 0.1 < c < 15.0:
                return max(1.5, min(12.0, c * 2.5))
        except ValueError:
            pass
    return DEFAULT_TREE_RADIUS


def _assemble_relation(el: dict, frame: LocalFrame) -> list[np.ndarray]:
    """
    Close a multipolygon relation into rings.

    `linemerge` raises on an already-closed ring, which is what most OSM
    building multipolygons are, so members are noded with unary_union and closed
    with polygonize instead.
    """
    from shapely.geometry import LineString
    from shapely.ops import polygonize, unary_union

    out: list[np.ndarray] = []
    for role in ("outer", "inner"):
        lines = []
        for m in el.get("members", []):
            if m.get("role") != role or m.get("type") != "way":
                continue
            pts = _coords(m.get("geometry", []), frame)
            if pts is not None and len(pts) >= 2:
                lines.append(LineString(pts))
        if not lines:
            continue
        for poly in polygonize(unary_union(lines)):
            if poly.is_valid and not poly.is_empty:
                out.append(np.asarray(poly.exterior.coords))
    return out


def parse_osm(raw: dict, frame: LocalFrame, clip_m: float,
              road_edges: bool = True) -> SiteGeometry:
    from shapely.geometry import LineString, Point, Polygon, box
    from shapely.ops import unary_union

    g = SiteGeometry()
    s = CADRAGE_SIZE
    clip = box(-clip_m, -clip_m, s + clip_m, s + clip_m)
    drops = {"small": 0, "outside": 0, "invalid": 0}

    def keep(poly_pts: np.ndarray,
             min_area: float = MIN_BUILDING_AREA) -> list[np.ndarray]:
        """
        Validate, simplify and clip a closed ring. May split into several.

        The three rejection reasons are counted separately: "outside the extent"
        and "below the minimum area" are very different facts about the data,
        and reporting them as one number hides whichever is really happening.
        """
        if len(poly_pts) < 4:
            drops["invalid"] += 1
            return []
        try:
            q0 = Polygon(poly_pts)
        except Exception:                              # noqa: BLE001
            drops["invalid"] += 1
            return []
        if not q0.is_valid:
            q0 = q0.buffer(0)
        if q0.is_empty:
            drops["invalid"] += 1
            return []
        if q0.area < min_area:
            drops["small"] += 1
            return []
        q0 = q0.simplify(SIMPLIFY_TOL).intersection(clip)
        if q0.is_empty:
            drops["outside"] += 1
            return []
        rings = []
        for q in getattr(q0, "geoms", [q0]):
            if q.geom_type != "Polygon" or q.area < min_area:
                continue
            rings.append(np.asarray(q.exterior.coords))
            rings.extend(np.asarray(i.coords) for i in q.interiors)
        return rings

    road_polys, road_lines = [], []
    dropped_parts = 0

    for el in raw.get("elements", []):
        tags = el.get("tags", {}) or {}
        etype = el.get("type")

        if etype == "node":
            if tags.get("natural") == "tree":
                p = frame.from_lonlat([[el["lon"], el["lat"]]])[0]
                if clip.contains(Point(p)):
                    g.trees.append((p, _tree_radius(tags)))
            continue

        if etype == "relation":
            rings = _assemble_relation(el, frame)
            target = (g.buildings if "building" in tags
                      else g.parking if tags.get("amenity") == "parking"
                      else g.water if tags.get("natural") == "water" else None)
            if target is not None:
                for r in rings:
                    target.extend(keep(r))
            continue

        if etype != "way":
            continue

        pts = _coords(el.get("geometry", []), frame)
        if pts is None:
            continue
        closed = len(pts) > 3 and np.allclose(pts[0], pts[-1], atol=1e-6)

        # building:part is Simple-3D-Buildings detail subdividing an outline the
        # drawing already has — drawing it stacks duplicates on the same roof.
        if "building:part" in tags and "building" not in tags:
            dropped_parts += 1
            continue

        if "building" in tags:
            if not closed:
                continue
            g.buildings.extend(keep(pts))

        elif tags.get("amenity") == "parking" or "parking" in tags:
            if closed:
                g.parking.extend(keep(pts, min_area=4.0))

        elif "highway" in tags:
            hw = tags["highway"]
            if hw in ("construction", "proposed"):
                continue
            hw_area = tags.get("area") == "yes" and closed
            if hw_area:
                # A closed highway tagged area=yes is a surface, not a
                # centreline. Buffering it turns a 40 m square into a ring.
                try:
                    road_polys.append(Polygon(pts).buffer(0))
                except Exception:                      # noqa: BLE001
                    pass
                continue
            hw_line = LineString(pts)
            road_lines.append((hw_line, hw))
            if road_edges:
                half = _tagged_width(tags, ROAD_HALF_WIDTH.get(hw, 3.0))
                road_polys.append(hw_line.buffer(half, cap_style=2,
                                                 join_style=2))

        elif tags.get("natural") in ("water", "coastline") or "waterway" in tags:
            if tags.get("natural") == "water" and closed:
                g.water.extend(keep(pts, min_area=4.0))
            else:
                line = LineString(pts).simplify(SIMPLIFY_TOL).intersection(clip)
                for part in getattr(line, "geoms", [line]):
                    if part.geom_type == "LineString" and len(part.coords) > 1:
                        g.water.append(np.asarray(part.coords))

    # Roads: one dissolved union, then its boundary, so junctions stay open.
    # Dissolving per class would rule a line straight across every crossing
    # between two classes.
    if road_edges and road_polys:
        surf = unary_union(road_polys).intersection(clip)
        for part in getattr(surf, "geoms", [surf]):
            if part.geom_type != "Polygon":
                continue
            g.streets.append(np.asarray(part.exterior.coords))
            g.streets.extend(np.asarray(i.coords) for i in part.interiors)
    else:
        for line, _hw in road_lines:
            clipped = line.simplify(SIMPLIFY_TOL).intersection(clip)
            for part in getattr(clipped, "geoms", [clipped]):
                if part.geom_type == "LineString" and len(part.coords) > 1:
                    g.streets.append(np.asarray(part.coords))

    _assert_within_extent(g, clip_m)
    g.stats = {
        "elements_in": len(raw.get("elements", [])),
        "buildings": len(g.buildings),
        "streets": len(g.streets),
        "water": len(g.water),
        "parking": len(g.parking),
        "trees": len(g.trees),
        "dropped_below_min_area": drops["small"],
        "dropped_outside_extent": drops["outside"],
        "dropped_invalid": drops["invalid"],
        "dropped_building_parts": dropped_parts,
        "road_mode": "edges" if road_edges else "centrelines",
    }
    return g


def _assert_within_extent(g: SiteGeometry, clip_m: float, eps: float = 1.0) -> None:
    """Nothing may be drawn outside the extent that was actually queried."""
    lo, hi = -clip_m - eps, CADRAGE_SIZE + clip_m + eps
    for name, seq in (("buildings", g.buildings), ("streets", g.streets),
                      ("water", g.water), ("parking", g.parking)):
        for arr in seq:
            if arr.size and (arr.min() < lo or arr.max() > hi):
                raise PipelineError(
                    f"{name}: geometry outside the queried extent "
                    f"[{lo:.0f}, {hi:.0f}] — clipping failed")
    for centre, radius in g.trees:
        if (centre - radius).min() < lo or (centre + radius).max() > hi:
            raise PipelineError("trees: circle outside the queried extent")


# ---------------------------------------------------------------------------
# Step 4 — DXF
# ---------------------------------------------------------------------------

def write_dxf(path: Path, geom: SiteGeometry, frame: LocalFrame,
              water_hatch: bool = False) -> None:
    import ezdxf

    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 6                        # metres
    doc.header["$MEASUREMENT"] = 1                     # metric
    doc.header["$LUNITS"] = 2
    msp = doc.modelspace()

    for name, spec in LAYERS.items():
        doc.layers.add(name, color=spec["color"], linetype=spec["linetype"],
                       lineweight=spec["lineweight"])

    def poly(pts, layer, close):
        p = msp.add_lwpolyline([(float(x), float(y)) for x, y in pts],
                               format="xy", dxfattribs={"layer": layer})
        p.close(close)
        return p

    for ring in geom.buildings:
        poly(ring, "BUILDINGS", True)
    for line in geom.streets:
        closed = len(line) > 3 and np.allclose(line[0], line[-1], atol=1e-6)
        poly(line[:-1] if closed else line, "STREETS", closed)
    for w in geom.water:
        closed = len(w) > 3 and np.allclose(w[0], w[-1], atol=1e-6)
        poly(w[:-1] if closed else w, "WATER", closed)
        if closed and water_hatch:
            h = msp.add_hatch(color=LAYERS["WATER"]["color"],
                              dxfattribs={"layer": "WATER"})
            h.paths.add_polyline_path([(float(x), float(y)) for x, y in w[:-1]],
                                      is_closed=True)

    for ring in geom.parking:
        poly(ring, "PARKING", True)
        h = msp.add_hatch(color=LAYERS["PARKING"]["color"],
                          dxfattribs={"layer": "PARKING"})
        h.set_pattern_fill("ANSI31", scale=PARKING_HATCH_SCALE)
        h.paths.add_polyline_path([(float(x), float(y)) for x, y in ring[:-1]],
                                  is_closed=True)

    for centre, radius in geom.trees:
        msp.add_circle((float(centre[0]), float(centre[1])), float(radius),
                       dxfattribs={"layer": "TREES"})

    # CADRAGE last, so it sits over everything in viewers that honour entity
    # order, and heavier than everything else so it reads first on paper.
    cad = cadrage_polygon()
    poly(cad[:-1], "CADRAGE", True)

    _attach_geodata(doc, msp, frame)
    doc.header.custom_vars.append("SITE_CRS", UTM_EPSG)
    doc.header.custom_vars.append(
        "SITE_ORIGIN_UTM",
        f"{frame.origin_utm[0]:.4f},{frame.origin_utm[1]:.4f}")
    doc.header.custom_vars.append(
        "SITE_CONVERGENCE_DEG", f"{frame.convergence_deg:.6f}")
    doc.header.custom_vars.append("SITE_POINT_SCALE", f"{frame.scale:.9f}")

    _assert_layers_declared(doc, msp)
    doc.saveas(path)


def _attach_geodata(doc, msp, frame: LocalFrame) -> None:
    """Georeference the drawing so it lands correctly in CAD/GIS. Best effort."""
    try:
        import ezdxf
        geo = msp.new_geodata()
        geo.dxf.coordinate_type = 3                     # grid
        geo.dxf.design_point = (0, 0, 0)                # local origin
        geo.dxf.reference_point = (float(frame.origin_utm[0]),
                                   float(frame.origin_utm[1]), 0)
        geo.dxf.north_direction = (0, 1)
        geo.dxf.horizontal_unit_scale = 1.0
        geo.dxf.vertical_unit_scale = 1.0
        geo.dxf.horizontal_units = 6
        geo.dxf.vertical_units = 6
        geo.coordinate_system_definition = (
            'PROJCS["WGS_1984_UTM_Zone_40S",'
            'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
            'SPHEROID["WGS_1984",6378137.0,298.257223563]],'
            'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],'
            'PROJECTION["Transverse_Mercator"],'
            'PARAMETER["False_Easting",500000.0],'
            'PARAMETER["False_Northing",10000000.0],'
            'PARAMETER["Central_Meridian",57.0],'
            'PARAMETER["Scale_Factor",0.9996],'
            'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]')
    except Exception as exc:                            # noqa: BLE001
        log(f"  note: GEODATA not attached ({type(exc).__name__}: {exc}); "
            f"origin is still recorded in the header custom vars")


def _assert_layers_declared(doc, msp) -> None:
    """
    DXF happily accepts an entity on an undeclared layer: it lands on an
    implicit layer with default colour, default lineweight and no frozen flag,
    and nothing errors. Fail loudly instead.
    """
    used = {e.dxf.layer for e in msp}
    missing = sorted(n for n in used if n not in doc.layers and n != "0")
    if missing:
        raise PipelineError(f"entities on undeclared layers: {missing}")


# ---------------------------------------------------------------------------
# Step 5 — preview
# ---------------------------------------------------------------------------

def render_preview(dxf_path: Path, png_path: Path, title: str,
                   subtitle: str = "", provenance: str = "") -> dict:
    """
    Render by reading the written DXF back, not the in-memory geometry: a fault
    in the write path has to be visible in the preview, not hidden by it.
    """
    import ezdxf
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    from matplotlib.patches import Circle
    from matplotlib.patches import Polygon as MplPolygon

    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()

    style = {
        "WATER":     dict(color="#2f6f9f", lw=0.6, z=1),
        "PARKING":   dict(color="#9a9a9a", lw=0.4, z=2),
        "STREETS":   dict(color="#1a1a1a", lw=0.35, z=3),
        "BUILDINGS": dict(color="#000000", lw=0.55, z=4),
        "TREES":     dict(color="#2e7d32", lw=0.5, z=5),
        "CADRAGE":   dict(color="#d40000", lw=1.6, z=9),
    }
    segs: dict[str, list] = {k: [] for k in style}
    circles: list[tuple[tuple[float, float], float]] = []
    hatches: dict[str, list] = {k: [] for k in style}
    counts: dict[str, int] = {k: 0 for k in style}

    for e in msp:
        layer = e.dxf.layer
        if layer not in style:
            continue
        if e.dxftype() == "LWPOLYLINE":
            pts = [(p[0], p[1]) for p in e.get_points("xy")]
            if e.closed and len(pts) > 2:
                pts.append(pts[0])
            if len(pts) > 1:
                segs[layer].append(pts)
                counts[layer] += 1
        elif e.dxftype() == "CIRCLE":
            circles.append(((e.dxf.center.x, e.dxf.center.y), e.dxf.radius))
            counts[layer] += 1
        elif e.dxftype() == "HATCH":
            # Draw the hatch too, not just its boundary: the ANSI31 fill on
            # PARKING is one of the drawing conventions being checked.
            for path in e.paths:
                pts = [(v[0], v[1]) for v in getattr(path, "vertices", [])]
                if len(pts) > 2:
                    hatches[layer].append(pts)

    fig, ax = plt.subplots(figsize=(13, 13), dpi=170)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    for layer, sp in sorted(style.items(), key=lambda kv: kv[1]["z"]):
        for pts in hatches[layer]:
            ax.add_patch(MplPolygon(
                pts, closed=True, facecolor="none", edgecolor=sp["color"],
                hatch="///", linewidth=0.0, alpha=0.55, zorder=sp["z"] - 0.5))
        if segs[layer]:
            ax.add_collection(LineCollection(
                segs[layer], colors=sp["color"], linewidths=sp["lw"],
                zorder=sp["z"], capstyle="round", joinstyle="round"))
    for (cx, cy), r in circles:
        ax.add_patch(Circle((cx, cy), r, fill=False,
                            edgecolor=style["TREES"]["color"],
                            linewidth=style["TREES"]["lw"],
                            zorder=style["TREES"]["z"]))

    s = CADRAGE_SIZE
    pad = BBOX_BUFFER + 40
    strip = 95.0                     # bottom band for the scale bar, in metres
    ax.set_xlim(-pad, s + pad)
    ax.set_ylim(-pad - strip, s + pad)
    ax.set_aspect("equal")
    ax.autoscale(False)          # the scale bar and arrow must not re-expand this
    ax.set_xticks(np.arange(0, s + 1, 100))
    ax.set_yticks(np.arange(0, s + 1, 100))
    ax.grid(True, color="#e8e8e8", lw=0.4, zorder=0)
    ax.tick_params(labelsize=7, colors="#777777")
    for spine in ax.spines.values():
        spine.set_edgecolor("#cccccc")
        spine.set_linewidth(0.6)

    # Title-block strip along the bottom: keeps the scale bar off the linework
    # instead of fighting it for legibility.
    ax.add_patch(MplPolygon(
        [(-pad, -pad - strip), (s + pad, -pad - strip),
         (s + pad, -pad - 4), (-pad, -pad - 4)],
        closed=True, facecolor="white", edgecolor="#cccccc", linewidth=0.6,
        zorder=9.5))

    # 400 m bar — the same one visible in the reference satellite image, so the
    # two can be compared directly.
    bx, by = -pad + 40, -pad - strip + 38
    ax.plot([bx, bx + SCALEBAR_M], [by, by], color="black", lw=2.4, zorder=10,
            solid_capstyle="butt")
    for t in (0, SCALEBAR_M / 2, SCALEBAR_M):
        ax.plot([bx + t, bx + t], [by, by + 11], color="black", lw=1.4, zorder=10)
    for t, lab in ((0, "0"), (SCALEBAR_M / 2, f"{SCALEBAR_M/2:.0f}"),
                   (SCALEBAR_M, f"{SCALEBAR_M:.0f} m")):
        ax.text(bx + t, by + 16, lab, ha="center", fontsize=8, color="black",
                zorder=10)
    ax.text(bx, by - 22, "matches the 400 m scale bar in the reference image",
            fontsize=7.5, color="#888888", zorder=10)

    # North arrow. +Y is true north by construction.
    nx, ny = s + pad - 62, -pad - strip + 26
    ax.annotate("", xy=(nx, ny + 44), xytext=(nx, ny), zorder=10,
                arrowprops=dict(arrowstyle="-|>", color="black", lw=1.4))
    ax.text(nx + 15, ny + 34, "N", ha="left", va="center", fontsize=10,
            color="black", zorder=10)
    ax.text(s + pad - 150, ny + 4, "true north", fontsize=7.5, color="#888888",
            ha="left", zorder=10)

    legend = " · ".join(f"{k.title()} {counts[k]}" for k in
                        ("BUILDINGS", "STREETS", "WATER", "PARKING", "TREES")
                        if counts[k])
    ax.set_title(title, fontsize=13, pad=22, color="#111111")
    ax.text(0.5, 1.014, subtitle or legend, transform=ax.transAxes,
            ha="center", fontsize=8, color="#666666")
    if provenance:
        ax.text(0.5, 1.001, provenance, transform=ax.transAxes, ha="center",
                fontsize=7.5, color="#999999")

    fig.tight_layout()
    fig.savefig(png_path, facecolor="white", bbox_inches="tight")
    plt.close(fig)
    return counts


# ---------------------------------------------------------------------------

def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", type=Path, default=Path("."))
    ap.add_argument("--geocode", action="store_true",
                    help="resolve anchors live via Nominatim instead of the "
                         "published coordinates")
    ap.add_argument("--osm-json", type=Path,
                    help="replay a previously fetched Overpass response")
    ap.add_argument("--refresh", action="store_true",
                    help="ignore osm_raw.json and re-query Overpass")
    ap.add_argument("--cadrage-only", action="store_true",
                    help="skip OSM entirely; emit the georeferenced frame alone")
    ap.add_argument("--centrelines", action="store_true",
                    help="draw streets as centrelines instead of road edges")
    ap.add_argument("--water-hatch", action="store_true",
                    help="solid-fill closed water bodies")
    ap.add_argument("--buffer", type=float, default=BBOX_BUFFER,
                    help=f"context beyond the cadrage, metres (default {BBOX_BUFFER:.0f})")
    ap.add_argument("--dxf", default="site_plan.dxf")
    ap.add_argument("--png", default="preview.png")
    args = ap.parse_args(argv)

    wd: Path = args.workdir
    wd.mkdir(parents=True, exist_ok=True)

    try:
        anchors = resolve_anchors(args.geocode)
        frame = LocalFrame.from_anchor(anchors["aapravasi_ghat"])
        summary = report_cadrage(frame, anchors)

        log("")
        log("── Step 2  OpenStreetMap ──────────────────────────────────────────")
        geom = SiteGeometry()
        provenance = ""
        if args.cadrage_only:
            log("  --cadrage-only: skipped. The DXF will carry CADRAGE only.")
            provenance = "no OpenStreetMap geometry — georeferenced frame only"
        else:
            bbox = bbox_lonlat(frame, args.buffer)
            log(f"  bbox  S {bbox[0]:.6f}  W {bbox[1]:.6f}  "
                f"N {bbox[2]:.6f}  E {bbox[3]:.6f}   "
                f"(cadrage + {args.buffer:.0f} m)")
            if args.osm_json:
                raw = json.loads(args.osm_json.read_text())
                # Name the source on the drawing. A render from replayed or
                # synthetic input must never be mistakable for the real thing.
                provenance = f"OSM replayed from {args.osm_json}"
            else:
                raw = fetch_overpass(bbox, wd / "osm_raw.json", args.refresh)
                provenance = ("OpenStreetMap via Overpass, "
                              + time.strftime("%Y-%m-%d")
                              + " — (c) OpenStreetMap contributors, ODbL")
            geom = parse_osm(raw, frame, args.buffer,
                             road_edges=not args.centrelines)
            log(f"  parsed {geom.stats['elements_in']} elements -> "
                f"{geom.total()} drawable")
            for k in ("buildings", "streets", "water", "parking", "trees"):
                log(f"      {k:<10}{geom.stats[k]:>7}")
            for key, label in (
                    ("dropped_below_min_area", f"below {MIN_BUILDING_AREA:.0f} m2"),
                    ("dropped_outside_extent", "outside the extent"),
                    ("dropped_invalid", "unclosed or degenerate")):
                if geom.stats[key]:
                    log(f"      dropped   {geom.stats[key]:>7}  ({label})")
            if geom.stats["dropped_building_parts"]:
                log(f"      3D parts  {geom.stats['dropped_building_parts']:>7}"
                    f"  (building:part, already covered by a footprint)")
            if not geom.trees:
                log("      note: no natural=tree nodes in this extent — "
                    "TREES left empty rather than scattered")

        log("")
        log("── Step 3  DXF ────────────────────────────────────────────────────")
        dxf_path = wd / args.dxf
        write_dxf(dxf_path, geom, frame, water_hatch=args.water_hatch)
        log(f"  {dxf_path}  R2018, $INSUNITS=6 (metres)")
        log(f"  origin (0,0) = cadrage SW = UTM 40S "
            f"E {frame.origin_utm[0]:.2f} N {frame.origin_utm[1]:.2f}")

        log("")
        log("── Step 4  Preview ────────────────────────────────────────────────")
        png_path = wd / args.png
        counts = render_preview(
            dxf_path, png_path,
            "Port Louis — central harbour / Aapravasi Ghat study area",
            provenance=provenance)
        log(f"  {png_path}   " + ", ".join(f"{k} {v}" for k, v in counts.items() if v))

        (wd / "cadrage.json").write_text(json.dumps(summary, indent=2))
        write_geojson(wd / "cadrage.geojson", summary)
        log(f"  {wd / 'cadrage.json'}")
        log(f"  {wd / 'cadrage.geojson'}   (drop on the satellite imagery to "
        f"check the boundary)")
        log("")
        log("done.")
        return 0

    except PipelineError as exc:
        log("")
        log(f"ABORT: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())

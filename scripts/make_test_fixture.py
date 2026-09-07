#!/usr/bin/env python3
"""
Synthetic fixture generator — TEST HARNESS ONLY.

Builds a fake `osm_raw.json` + base DXF so `portlouis_site.py` can be exercised
end to end without network access. The geometry is invented: a clean 44/136 deg
grid, block-filling boxes, a harbour polygon. It is NOT Port Louis and must
never be mistaken for output.

Because the fixture is authored in local metres and then inverted to lon/lat
through the same LocalFrame the pipeline derives, it doubles as a round-trip
check: geometry must come back out within a few centimetres of where it went in.

    python3 make_test_fixture.py --outdir /tmp/fixture
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

import portlouis_site as P

# Aapravasi Ghat, near enough for a fixture. The real pipeline geocodes.
FIXTURE_LON, FIXTURE_LAT = 57.50028, -20.16167
RNG = np.random.default_rng(20260906)


def rot(deg: float) -> np.ndarray:
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])


def street_grid() -> list[np.ndarray]:
    """Two families at the surveyed 44 / 136 deg, spanning the frame."""
    lines: list[np.ndarray] = []
    centre = np.array([(P.FRAME_MIN[0] + P.FRAME_MAX[0]) / 2,
                       (P.FRAME_MIN[1] + P.FRAME_MAX[1]) / 2])
    reach = 1100.0
    for bearing, spacing, n in ((44.0, 95.0, 15), (136.0, 105.0, 13)):
        R = rot(bearing)
        for i in range(-n, n + 1):
            off = R @ np.array([0.0, i * spacing])
            a = centre + off + R @ np.array([-reach, 0.0])
            b = centre + off + R @ np.array([reach, 0.0])
            lines.append(np.array([a, b]))
    return lines


def blocks_and_buildings() -> list[np.ndarray]:
    """Small rectangles inside each grid cell, aligned to the grid."""
    out: list[np.ndarray] = []
    centre = np.array([(P.FRAME_MIN[0] + P.FRAME_MAX[0]) / 2,
                       (P.FRAME_MIN[1] + P.FRAME_MAX[1]) / 2])
    R = rot(44.0)
    for i in range(-13, 14):
        for j in range(-11, 12):
            cell = centre + R @ np.array([i * 95.0 + 47.0, j * 105.0 + 52.0])
            for k in range(RNG.integers(2, 6)):
                w, h = RNG.uniform(9, 30), RNG.uniform(9, 34)
                jitter = R @ np.array([RNG.uniform(-28, 28), RNG.uniform(-32, 32)])
                c = cell + jitter
                corners = np.array([[-w / 2, -h / 2], [w / 2, -h / 2],
                                    [w / 2, h / 2], [-w / 2, h / 2]])
                poly = (R @ corners.T).T + c
                out.append(np.vstack([poly, poly[:1]]))
    # A few deliberate sub-15 m2 slivers, to prove the filter fires.
    for _ in range(12):
        c = centre + RNG.uniform(-500, 500, size=2)
        d = np.array([[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], float) + c
        out.append(d)
    return out


def harbour_polygon() -> np.ndarray:
    """A basin filling the NW of the frame, like the real Caudan waterfront."""
    t = np.linspace(0, 1, 90)
    spine = np.column_stack([
        -300 + 950 * t - 260 * np.sin(math.pi * t),
        900 - 700 * t + 140 * np.sin(2 * math.pi * t),
    ])
    quay = spine + np.column_stack([-260 * np.ones_like(t), 210 * np.ones_like(t)])
    ring = np.vstack([spine, quay[::-1]])
    return np.vstack([ring, ring[:1]])


def make_osm(frame: P.LocalFrame) -> dict:
    from pyproj import Transformer
    inv = Transformer.from_crs(P.UTM_EPSG, P.WGS84, always_xy=True)

    def to_ll(local: np.ndarray) -> list[dict]:
        utm = P._to_utm(frame, local)
        lon, lat = inv.transform(utm[:, 0], utm[:, 1])
        return [{"lat": float(a), "lon": float(b)} for a, b in zip(lat, lon)]

    els: list[dict] = []
    nid = [1]

    def add_way(local, tags):
        nid[0] += 1
        els.append({"type": "way", "id": nid[0], "tags": tags,
                    "geometry": to_ll(np.asarray(local, float))})

    classes = ["primary", "secondary", "tertiary", "residential",
               "residential", "service"]
    grid = street_grid()
    for i, ln in enumerate(grid):
        tags = {"highway": classes[i % len(classes)], "name": f"Street {i}"}
        if i % 11 == 0:                       # exercise the width/lanes branch
            tags["lanes"] = "4"
        if i % 13 == 0:
            tags["width"] = "12.5"
        add_way(ln, tags)

    # Footways / pedestrian ways, so 32_FOOTWAY is exercised too.
    for i, ln in enumerate(grid[::7]):
        off = np.array([0.0, 14.0])
        add_way(ln + off, {"highway": "footway" if i % 2 else "pedestrian"})

    for i, b in enumerate(blocks_and_buildings()):
        tags = {"building": "yes"}
        if i % 37 == 0:                       # a few big ones, > 1000 m2
            c = b.mean(axis=0)
            b = (b - c) * 7.0 + c
            tags["building"] = "commercial"
        add_way(b, tags)

    add_way(harbour_polygon(), {"natural": "water", "name": "Port Louis harbour"})

    rail = np.array([[-260.0, 780.0], [420.0, 690.0], [1100.0, 560.0]])
    add_way(rail, {"railway": "rail"})

    for k in range(4):
        x0, y0 = 700.0 + k * 90.0, 700.0
        pk = np.array([[x0, y0], [x0 + 70, y0], [x0 + 70, y0 + 90],
                       [x0, y0 + 90], [x0, y0]])
        add_way(pk, {"amenity": "parking"})

    park = np.array([[80.0, 40.0], [260.0, 40.0], [260.0, 190.0],
                     [80.0, 190.0], [80.0, 40.0]])
    add_way(park, {"leisure": "park", "name": "Fixture Gardens"})

    R = rot(44.0)
    for i in range(46):
        p = np.array([120.0, 300.0]) + R @ np.array([i * 12.0, 0.0])
        nid[0] += 1
        ll = to_ll(p.reshape(1, 2))[0]
        els.append({"type": "node", "id": nid[0], "lat": ll["lat"],
                    "lon": ll["lon"],
                    "tags": {"natural": "tree", "diameter_crown": "5"}})

    return {"version": 0.6, "generator": "FIXTURE — synthetic, not real OSM",
            "elements": els}


def make_base_dxf(path: Path) -> None:
    """
    Base DXF with the verified layers. 02_WATER is the harbour ring displaced by
    ~2 m of noise plus a 3 m shift, so the registration has something real to
    solve for and the residuals are non-trivial.
    """
    import ezdxf

    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 6
    msp = doc.modelspace()
    for name in P.CARRY_LAYERS:
        doc.layers.add(name)

    ring = harbour_polygon()
    noisy = ring + np.array([3.0, -2.0]) + RNG.normal(0, 1.6, ring.shape)
    msp.add_lwpolyline([tuple(p) for p in noisy], close=True,
                       dxfattribs={"layer": "02_WATER"})
    msp.add_lwpolyline([tuple(p) for p in noisy], close=True,
                       dxfattribs={"layer": "03_WATERFRONT_EDGE"})
    msp.add_lwpolyline([(0, 0), (600, 0), (600, 600), (0, 600)], close=True,
                       dxfattribs={"layer": "01_STUDY_AREA"})
    msp.add_lwpolyline([P.FRAME_MIN, (P.FRAME_MAX[0], P.FRAME_MIN[1]),
                        P.FRAME_MAX, (P.FRAME_MIN[0], P.FRAME_MAX[1])],
                       close=True, dxfattribs={"layer": "00_IMAGE_FRAME"})
    msp.add_lwpolyline([(150, 380), (360, 380), (360, 560), (150, 560)],
                       close=True, dxfattribs={"layer": "10_AGWHP_BZ1_PARTIAL"})
    msp.add_lwpolyline([(90, 320), (430, 320), (430, 620), (90, 620)],
                       close=True, dxfattribs={"layer": "11_AGWHP_BZ2_PARTIAL"})
    msp.add_lwpolyline([(200, 420), (310, 420), (310, 520), (200, 520)],
                       close=True, dxfattribs={"layer": "12_AGWHP_CORE_VICINITY"})
    msp.add_lwpolyline([(60, 60), (140, 60), (140, 130), (60, 130)],
                       close=True, dxfattribs={"layer": "04_VEGETATION"})
    doc.saveas(str(path))


def make_dummy_satellite(path: Path) -> None:
    """
    Flat grey raster at the true frame pixel size. Only there to prove the QA
    overlay places the drawing at the right extent and aspect — it carries no
    imagery.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    w, h = P.FRAME_PX
    img = np.full((h, w, 3), 110, dtype=np.uint8)
    img[::100, :, :] = 150            # 100 px rules, to spot a scale error
    img[:, ::100, :] = 150
    plt.imsave(str(path), img)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", required=True, type=Path)
    a = ap.parse_args()
    out = a.outdir.resolve()
    out.mkdir(parents=True, exist_ok=True)

    (out / "nominatim_anchor.json").write_text(json.dumps(
        {"lon": FIXTURE_LON, "lat": FIXTURE_LAT,
         "display_name": "FIXTURE ANCHOR — synthetic"}, indent=2))

    frame = P.geodetic_frame(FIXTURE_LON, FIXTURE_LAT)
    (out / "osm_raw.json").write_text(json.dumps(make_osm(frame)))
    make_base_dxf(out / "PortLouis_StudyArea_BASE_metres.dxf")
    make_dummy_satellite(out / "satellite_FULLFRAME_1479x1038m.jpg")

    print(f"fixture written to {out}")
    print("  nominatim_anchor.json, osm_raw.json, "
          "PortLouis_StudyArea_BASE_metres.dxf, "
          "satellite_FULLFRAME_1479x1038m.jpg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

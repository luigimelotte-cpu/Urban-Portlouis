# Task

Build a CAD-quality DXF site base for a 600 × 600 m urban study area in central
Port Louis, Mauritius (the Aapravasi Ghat / Le Grenier / harbour-edge district),
using OpenStreetMap as the geometry source. Deliver a single reproducible Python
script plus the outputs it generates.

The target drawing style is a black-and-white urban site plan: building
footprints as closed outlines, roads drawn as **edges** (double lines, not
centrelines), street trees as circles, railway and parking bands hatched, water
as an open polygon. Fine hairlines for context, heavier lines for the study
boundary.

---

## 1. Coordinate system — fixed, do not change

A previous step established a verified local metric system. Everything must be
produced in it.

| Property | Value |
|---|---|
| Units | metres |
| Origin (0,0) | SW corner of the study square |
| +Y | true north |
| Study square | (0,0) → (600,600), exactly 600.000 m |
| Satellite frame SW | (−312.92, −176.97) |
| Satellite frame NE | (1165.73, 861.24) |
| Raster scale | 1.1236 m/px |
| Street grid orientation | 44° / 136° from east (measured) |

## 2. Input files (in the working directory)

- `PortLouis_StudyArea_BASE_metres.dxf` — existing base. Contains verified
  layers `01_STUDY_AREA`, `02_WATER`, `03_WATERFRONT_EDGE`, `04_VEGETATION`,
  `00_IMAGE_FRAME`, and heritage layers `10_AGWHP_BZ1_PARTIAL`,
  `11_AGWHP_BZ2_PARTIAL`, `12_AGWHP_CORE_VICINITY`. **Carry all of these
  through to the output unchanged.**
- `satellite_FULLFRAME_1479x1038m.jpg` — 1316 × 924 px, covers the frame above.
- `satellite_STUDYAREA_600x600m.jpg` — 534 × 534 px, covers exactly (0,0)→(600,600).

## 3. Pipeline

### 3.1 Fetch OSM
Geocode `"Aapravasi Ghat, Port Louis, Mauritius"` via Nominatim to get an
anchor. Build a bounding box of ±1200 m around it and query the Overpass API for:

- `building=*` (footprints)
- `highway=*` (roads, footways, pedestrian, service)
- `railway=*`
- `natural=water`, `natural=coastline`, `waterway=*`, `landuse=harbour`
- `natural=tree`, `leisure=park`, `landuse=grass|forest`, `natural=scrub`
- `amenity=parking`, `landuse=industrial|commercial|retail`

Cache the raw response to `osm_raw.json` so reruns don't re-hit the API.

### 3.2 Project
EPSG:4326 → **EPSG:32740** (UTM zone 40S — correct for Mauritius). Work in
metres from here on.

### 3.3 Register OSM to the local system — this is the critical step
Both systems are metric and north-up, so the transform is a translation plus a
small rotation (UTM grid convergence, well under 1°).

1. Read the `02_WATER` polyline from the input DXF — this is the harbour edge,
   traced from the satellite and accurate to ±2–3 m.
2. Extract the OSM coastline / water boundary over the same extent.
3. Fit `(tx, ty, θ)` by least squares, minimising nearest-neighbour distance
   from OSM coastline vertices to the DXF water polyline. Use a KD-tree and
   trim the worst 10% as outliers (reclamation and mapping-date differences).
4. **Report rms, median and p90 residuals. Abort with a clear error if rms > 8 m** —
   that means the registration failed and everything downstream would be wrong.
5. **Independent cross-check:** the geocoded Aapravasi Ghat anchor should land
   near local coordinates **(253, 466) ± 50 m**. Print the actual distance. If
   it is way off, the fit found a wrong local minimum — say so, don't proceed
   silently.

### 3.4 Build geometry

**Buildings** — closed `LWPOLYLINE`. Simplify with Douglas–Peucker at 0.3 m.
Drop anything under 15 m². Keep courtyards as separate inner polylines.

**Roads** — OSM gives centrelines; the drawing needs edges. Buffer each
centreline by half-width, dissolve the union per class, then take the boundary
and emit that as the road edge. Half-widths:

| Class | Half-width |
|---|---|
| motorway, trunk | 9.0 m |
| primary | 7.0 m |
| secondary | 5.5 m |
| tertiary | 4.5 m |
| residential, unclassified | 3.5 m |
| service | 2.5 m |
| pedestrian, footway | 1.8 m |

Where a `width` or `lanes` tag exists, use it instead of the default.

**Trees** — circle at each `natural=tree`. Radius from `diameter_crown`/2 if
tagged, else 3.0 m. For `leisure=park` and tree rows without individual nodes,
do not scatter invented trees — leave the area outlined and note it.

**Railway** — centreline plus a 45° hatched band 3.0 m wide.

**Parking** — outline plus a light 45° hatch, matching the reference style.

**Water** — carry through the existing `02_WATER` geometry. Do not replace it
with OSM water; the traced version is more accurate here. Use OSM water only
for registration.

### 3.5 Layers

Keep every existing layer, then add:

| Layer | Colour | Content |
|---|---|---|
| `20_BUILDINGS_OSM` | 7 | Building footprints |
| `21_BUILDINGS_MAJOR` | 7 | Footprints > 1000 m², heavier lineweight |
| `30_ROAD_EDGE` | 8 | Road edges (from buffered centrelines) |
| `31_ROAD_CENTRELINE` | 251 | Centrelines, frozen by default |
| `32_FOOTWAY` | 253 | Pedestrian edges |
| `33_RAILWAY` | 8 | Railway + hatch band |
| `34_PARKING` | 253 | Parking outline + hatch |
| `40_TREES` | 3 | Tree circles |
| `41_GREEN_AREA` | 3 | Park / vegetation outlines |

Lineweights: study boundary 0.50 mm, major buildings 0.25 mm, buildings
0.18 mm, road edges 0.13 mm, everything else 0.09 mm.

### 3.6 Outputs

1. `PortLouis_SITE_metres.dxf` — R2018, `$INSUNITS = 6`
2. `PortLouis_SITE_millimetres.dxf` — same, scaled ×1000, `$INSUNITS = 4`
3. `preview.png` — matplotlib render, white background, black linework,
   landscape, study square in red
4. `qa_overlay.png` — the DXF drawn over `satellite_FULLFRAME_1479x1038m.jpg`
   at correct scale, so misalignment is visible at a glance
5. `coverage_report.md` — see below

---

## 4. Coverage report — required

OSM building coverage in Port Louis is uneven and this determines whether the
output is usable. The report must state:

- Registration residuals (rms / median / p90) and the Aapravasi Ghat check distance
- Building count and total footprint area inside the 600 × 600 m square
- **Estimated built-coverage ratio** inside the square, and a list of the 100 m
  grid cells (from `80_GRID_100M`) where coverage looks sparse or absent
- Tree node count
- Any road class present in the imagery but missing from OSM

## 5. Hard constraints

- **Do not invent geometry.** If OSM has no buildings in a block, leave it
  empty and list it in the coverage report. An empty block I know about is
  useful; a fabricated one is not.
- **Do not auto-vectorise the satellite raster for footprints.** This was
  already tested at 1.1236 m/px: colour and edge-based extraction returns
  roofs, parking lots and shadow as one class and misses shaded streets
  entirely. It produces convincing-looking noise. Rejected.
- Do not modify the existing verified layers or the coordinate system.
- Do not silently substitute a fallback if Overpass fails — raise and report.
- One script, top-to-bottom reproducible, with the API response cached.

## 6. Suggested libraries

`requests` or `osmnx` (Overpass), `geopandas`, `shapely`, `pyproj`, `scipy`
(KD-tree + least squares), `ezdxf`, `matplotlib`.

## 7. Working method

Build it in stages and show me the QA overlay after the registration step
before generating the full drawing. If registration residuals are poor, stop
and tell me rather than continuing — every downstream layer inherits that error.

# Port Louis — urban site base

CAD-quality DXF site base for central Port Louis (Aapravasi Ghat / Le Grenier /
harbour edge), built from OpenStreetMap in the established local metric system.

The 600 × 600 m study square — the *cadrage* — was drawn previously. This
pipeline rebuilds it **and extends the same drawing language outward to the full
satellite frame, 1478.65 × 1038.21 m**, so the block structure reads continuously
past the boundary instead of stopping at it.

```
scripts/site_plan.py           standalone site plan — anchors to DXF, no inputs needed
scripts/portlouis_site.py      the full-frame pipeline — needs the base DXF + rasters
scripts/make_test_fixture.py   synthetic fixture, for running either offline
```

Two pipelines, different jobs. `site_plan.py` reconstructs the cadrage from
geocoded anchors and needs nothing but network; `portlouis_site.py` extends the
established drawing to the full satellite frame and needs the base DXF and the
two rasters. See [site_plan.py](#site_planpy--standalone-site-plan) below.

---

## `site_plan.py` — standalone site plan

Builds `site_plan.dxf` + `preview.png` for the 600 x 600 m cadrage from nothing
but two geocoded anchors and OpenStreetMap. No base DXF, no rasters — so it runs
anywhere the OSM hosts are reachable.

```bash
pip install ezdxf shapely pyproj matplotlib numpy requests
python3 scripts/site_plan.py --workdir build
```

### Reconstructing the cadrage

The red boundary in the reference satellite image is the 600 x 600 m study
square already established for this project. Two independent facts fix it:

- **Position.** Aapravasi Ghat sits at local (253, 466) inside the square. Le
  Grenier / the Caudan basin then falls ~229 m outside the west edge, bearing
  236 deg and 579 m from the Ghat — which is where the basin and its boats
  appear in the image.
- **Scale.** The square's side is 1.50 x the image's 400 m scale bar. On the
  established 1316 x 924 px raster at 1.1236 m/px that is 534 px against the
  bar's 356 px — the same 1.50, and 0.406 of the frame width, which is where
  the red boundary sits.

The script prints both checks and aborts if the arrangement one fails.

**Accuracy.** Absolute georeferencing is +/- ~30 m, set entirely by the anchor:
both published coordinates are quoted to whole arcseconds. Everything internal —
the 600.000 m side, OSM geometry, relative positions — is unaffected by that
offset. `--geocode` resolves the anchors live through Nominatim instead, which
tightens it, and needs network.

### Coordinate system

| | |
|---|---|
| Units | metres (`$INSUNITS` = 6) |
| Origin (0,0) | cadrage SW corner — coordinates stay in 0..600 |
| +Y | true north |
| Projection | UTM zone 40S, EPSG:32740 |
| Origin in UTM | E 552315.58, N 7770422.05 |

Grid convergence (+0.17333 deg) and point scale (0.99963416) are **measured, not
looked up**: the script projects the anchor and a point 1000 m due true north of
it and reads both off the resulting vector, so there is no sign convention to
get wrong. The origin is written into the DXF as a `GEODATA` object and as
header custom vars, so the drawing lands correctly in CAD and GIS.

### Layers

| Layer | Colour | Weight | Content |
|---|---|---|---|
| `BUILDINGS` | 7 | 0.25 mm | closed footprint per building |
| `STREETS` | 7 | 0.13 mm | road edges from dissolved centreline buffers |
| `WATER` | 5 | 0.18 mm | coastline, harbour, watercourses |
| `PARKING` | 253 | 0.09 mm | boundary + ANSI31 hatch |
| `TREES` | 3 | 0.09 mm | circle per tree, canopy-sized |
| `CADRAGE` | 1 | 0.35 mm | the boundary, drawn last so it sits on top |

### Flags

| Flag | Effect |
|---|---|
| `--geocode` | resolve anchors live via Nominatim instead of the published table |
| `--osm-json FILE` | replay a previously fetched Overpass response |
| `--refresh` | ignore `osm_raw.json` and re-query |
| `--cadrage-only` | skip OSM; emit the georeferenced frame alone |
| `--centrelines` | draw streets as centrelines instead of road edges |
| `--water-hatch` | solid-fill closed water bodies |
| `--buffer M` | context beyond the cadrage, default 150 m |

### Outputs

`site_plan.dxf` (R2018, metres) · `preview.png` · `cadrage.json` ·
`cadrage.geojson` — the last is WGS84, so dropping it on the satellite imagery
in Google Earth or QGIS checks the boundary against the picture directly.

### Notes on the drawing

**Streets are drawn as edges, not centrelines.** OSM gives centrelines; the
established drawing language is double lines. Buffers dissolve into one union
before the boundary is taken — dissolving per class would rule a line straight
across every junction between two classes. `--centrelines` switches it.

**Relations are queried alongside ways.** The brief lists only `way[...]`, but
real Port Louis has multipolygon buildings and water bodies, and dropping them
loses whole footprints.

**Nothing is invented.** If Overpass fails the script aborts rather than
substituting a fallback; if there are no `natural=tree` nodes the TREES layer
stays empty rather than being scattered with plausible-looking circles.

### Verified

Against the synthetic fixture, end to end: R2018 / `$INSUNITS` 6; all six layers
declared with the correct colour, lineweight and linetype; no entity on an
undeclared layer; the cadrage exactly 600.000000 x 600.000000 m with its SW
corner on the origin and drawn last; every building closed; one ANSI31 hatch per
parking boundary; tree radii in range; `GEODATA` attached. Three bugs were found
and fixed that way:

- **Two-node ways were dropped.** Way geometry was required to have three
  points, which silently discarded every single-segment road — real service
  roads, links and bridge segments. On the fixture that was all 59 highways;
  the only surviving "street" was a pedestrian square.
- **The drop counter conflated two different facts.** Footprints falling outside
  the queried extent were counted as "below the minimum area", reporting 1913
  discarded slivers where there were 12. Rejection reasons are now counted
  separately, and the fixture's 12 deliberate sub-15 m2 slivers come back as
  exactly 12.
- **The preview quietly re-scaled itself.** The scale bar and north arrow were
  drawn after the axis limits were set, and both re-triggered autoscaling, so
  the rendered extent was not the one the code asked for.

The preview is rendered by reading the written DXF back, not from the in-memory
geometry, so a fault in the write path cannot hide behind it. Every render
carries its data provenance under the title — a fixture or replayed run says so
on its face and cannot be mistaken for the real thing.

---

## Status — read this first

Neither pipeline has been run against **real OpenStreetMap data**, because this
environment cannot reach it. Every OSM host — `overpass-api.de`,
`overpass.kumi.systems`, `overpass.private.coffee`, `overpass.osm.ch`,
`nominatim.openstreetmap.org`, `api.openstreetmap.org` — is refused at the
CONNECT by the egress policy (HTTP 403), on the container's own network and
through the sandboxed fetch tool alike. `wikidata.org` and `whc.unesco.org` are
refused the same way, which is why the anchors come from a published table
rather than a live lookup.

| Script | Needs | State |
|---|---|---|
| `site_plan.py` | network only | **Runs.** Produces a real, correctly georeferenced `site_plan.dxf` + `preview.png` — but with `CADRAGE` alone, since the OSM layers have no data to draw. Every layer path is verified against the fixture. |
| `portlouis_site.py` | network + the base DXF + two rasters | Not runnable here: the input files are also absent. Verified against the fixture only. |

`PortLouis_StudyArea_BASE_metres.dxf`, `satellite_FULLFRAME_1479x1038m.jpg` and
`satellite_STUDYAREA_600x600m.jpg` are not in the repository.

To fill the drawing, run either script from a network that permits the OSM
hosts, or fetch the Overpass JSON elsewhere and replay it:

```bash
python3 scripts/site_plan.py --workdir build                      # fetches
python3 scripts/site_plan.py --workdir build --osm-json osm.json  # replays
```

What *has* been verified is in [Verified](#verified) and [Testing](#testing):
both pipelines run end to end against synthetic geometry, and the bugs that
surfaced that way are listed there.


---

## Running it

```bash
pip install ezdxf shapely pyproj scipy matplotlib numpy requests

# put the three input files in the working directory, then:
python3 scripts/portlouis_site.py --workdir .

# check the registration before committing to the full drawing:
python3 scripts/portlouis_site.py --workdir . --stage register
```

`--stage register` fits the transform, writes both QA overlays and
`qa_register.dxf`, and stops. Look at **`qa_overlay_studyarea.png` first** — 600 m
across a page resolves a few metres of error; the full frame at 1479 m does not.
Green linework should sit on roofs and kerbs, yellow traced water on the harbour
edge. Then rerun without it.

### Flags

| Flag | Effect |
|---|---|
| `--dim-context` | Draw everything outside the cadrage in grey hairline instead of matching the study-area weights. |
| `--per-class-dissolve` | Dissolve road buffers per highway class (the literal spec) instead of one vehicular union. See [Deviations](#deviations-from-the-brief). |
| `--fit-scale` | Let the water fit solve for scale as well. Off by default — see below. |
| `--allow-no-base` | Build on the geodetic anchor alone when the base DXF is missing. The verified layers are then absent from the output. |

### Outputs

`PortLouis_SITE_metres.dxf` · `PortLouis_SITE_millimetres.dxf` ·
`preview.png` (full frame) · `preview_studyarea.png` (cadrage only, for
comparing against the existing drawing) · `qa_overlay.png` ·
`qa_overlay_studyarea.png` · `coverage_report.md`

The DXF also carries `80_GRID_100M` — the 100 m analysis grid over the study
square with every cell labelled A1–F6, frozen so it does not print. The coverage
report names sparse cells by that label, so the grid is what makes the report
findable in CAD.

---

## How the exterior is handled

Everything outside the cadrage goes onto parallel `*_CTX` layers —
`20_BUILDINGS_OSM_CTX`, `30_ROAD_EDGE_CTX`, `40_TREES_CTX` and so on, one for
each content layer.

They carry the **same colours and lineweights as the study area by default**, so
the drawing reads as one continuous urban fabric with the cadrage marked only by
its heavier boundary — which is what the reference drawing does. Because they
are separate layers, dimming, freezing or re-weighting the entire context is one
selection in Rhino or AutoCAD, and `--dim-context` does it at build time.

Two rules govern the split:

- **Buildings are assigned whole, by centroid, never cut.** A footprint
  straddling the boundary would otherwise read as two separate buildings.
- **Roads, water and area polygons are split at the boundary.** They are
  continuous bands, and the heavy cadrage line sits over the joint anyway.

`02_WATER` is a special case. The traced harbour edge is authoritative and is
carried through untouched, but it only covers the study area — outside it there
is no traced geometry, so OSM water is drawn on `02_WATER_CTX`. Two provenances,
two layers, rather than one blended line of unclear accuracy.

---

## Registration

Three independent checks, because a bad transform silently corrupts every
downstream layer:

1. **Water fit** — trimmed least squares of the OSM coastline against the traced
   `02_WATER` polyline, KD-tree nearest-neighbour, worst 10 % dropped over four
   rounds. Aborts if rms > 8 m.
2. **Anchor** — the geocoded Aapravasi Ghat must land within 50 m of (253, 466).
3. **Street grid** — the two dominant road bearings must match the surveyed
   44° / 136° within 4°.

They fail in different ways, which is the point: the rms guard catches shape
mismatch, the anchor guard catches position error. A systematically shifted
water trace produces *low* rms — the fit simply absorbs the shift — and is
caught by the anchor check instead.

**Scale is locked, not fitted.** It is not an unknown: it is the UTM point scale
factor, 0.99963378 at this latitude, known exactly from the projection.
Rotation and scale are both measured rather than looked up — the script projects
the anchor and a point 1000 m due true north of it and reads the grid
convergence (+0.17240°) and scale factor straight off the resulting vector, so
there is no sign convention to get wrong. Leaving scale free lets noise in a
hand-traced coastline stretch the whole city: on the fixture it drifted to
1.00218, a 0.18 % error worth 1.3 m of displacement at the far edge of the
frame, bought for a few centimetres of apparent residual. `--fit-scale` frees it
anyway, for diagnosing a suspected scale problem in the base.

---

## Deviations from the brief

**Vehicular road buffers dissolve into one union, not per class.** Per-class
dissolve closes each class's outline independently of the junctions it shares,
so a line is ruled straight across every crossing between two road classes.
Measured on the fixture: single union puts **0.0 %** of its edge length inside
the road surface, per-class **6.2 %** — 10.9 km of line drawn over open
pavement. `--per-class-dissolve` restores the literal behaviour.

**`35_WATERWAY` is an added layer.** The brief's layer table has no home for
linear watercourses, and folding them into `02_WATER` would contaminate a
verified layer with OSM geometry. They get their own layer instead of being
dropped.

**`80_GRID_100M` is generated, not read.** The brief refers to it but it is not
among the layers the base DXF is stated to contain, so the pipeline draws it: a
6 × 6 grid of 100 m cells on the local origin, labelled A1–F6, aligned to the
same cells the coverage report scores.

Everything else follows the brief. In particular: no footprint is vectorised
from the raster, no tree is invented inside a park polygon, no fallback geometry
is substituted if Overpass fails, and the verified layers are carried through
unmodified.

---

## Testing

`make_test_fixture.py` builds a synthetic `osm_raw.json`, base DXF and satellite
raster — a clean 44° / 136° grid, block-filling footprints, a harbour polygon, open
coastline, canals, multipolygon relations with courtyards, a self-intersecting
footprint, a pedestrian area, a closed loop road, a `building:part`, rail and
parking. It is **not** Port Louis; it exists so the pipeline
can be exercised without network access. Because the fixture is authored in
local metres and inverted to lon/lat through the same transform the pipeline
derives, it doubles as a round-trip check.

```bash
python3 scripts/make_test_fixture.py --outdir /tmp/fixture
python3 scripts/portlouis_site.py --workdir /tmp/fixture
```

**Runtime.** Profiled against a densified fixture at realistic central-city
volume — 9829 buildings parsed, 8352 drawn, 12694 polylines — the whole pipeline
runs in **16 s** end to end, of which geometry is 3 s and the rest is DXF write
and rendering. Overpass fetch time is on top of that and depends on the server.
There is no scaling problem to design around.

Verified: DXF is R2018 with `$INSUNITS` 6 / 4; the millimetre file is exactly
×1000 on all 4106 vertices plus circle radii, text heights and hatch pattern
scale; every layer carrying entities has a table entry; the study
square measures 600.000000 m; carried layers survive into both files; layer
colours, lineweights and the frozen centreline layer are correct; `--stage
register` writes no site DXF; a missing base DXF aborts with exit 2; a shape
mismatch in `02_WATER` trips the rotation warning at 28°, reaches rms 147 m, and
aborts before writing anything.

Ten bugs were found this way and fixed:

- The millimetre file scaled only new geometry, leaving everything carried from
  the base DXF in metres — one file holding two unit systems. It is now produced
  by transforming the finished metre file, so every layer scales by construction.
- The study square and image frame were drawn a second time on top of the ones
  carried from the base, putting two coincident polylines on one layer and making
  every CAD snap ambiguous.
- The street-grid check used the argmax of a smoothed histogram. Box smoothing
  turns each spike into a 7-bin plateau whose argmax lands wherever the sort
  breaks ties — several degrees of noise, the same order as the error being
  tested for. It now uses length-weighted circular statistics (quadrupled-angle
  mean to find the grid axis, doubled-angle mean per family), which reads the
  fixture's grid as 44.00° / 136.00°, error 0.01°.
- Previews were rendered from the in-memory geometry, so the carried layers never
  appeared and a fault in the DXF write path would have been invisible. They are
  now rendered by reading the written DXF back.
- **Coastline and watercourses were collected and then dropped.** `m.coastline`
  was populated at three points and consumed by nothing — registration reads the
  raw payload separately. Since OSM tags an open sea edge as `natural=coastline`
  rather than as a closed polygon, the harbour edge across the north-west of the
  frame — the Caudan basin and the quays, precisely the exterior this work is
  about — would have come out blank. Coastline now draws to `02_WATER_CTX`;
  linear watercourses get their own `35_WATERWAY`.
- **The registration fit was dragged by water it could never match.** The traced
  `02_WATER` covers the study area's harbour edge only, while OSM inside the
  frame also carries coastline running past it, inland basins and other water.
  Those vertices have no counterpart under any transform, and trimming the worst
  10 % does not remove them when they are a third of the input — the fit swung
  the rotation 14.5°. Correspondences are now gated at 50 m against the initial
  geodetic transform before fitting, with a robust soft-L1 loss; the same case
  now recovers the true transform at 1.28 m rms, and the report states how many
  vertices were gated out.
- **Multipolygon relations crashed the run.** `linemerge` raises on a single
  already-closed ring, which is what most OSM building multipolygons are, so the
  first such relation in real Port Louis data would have aborted the pipeline
  with a `ValueError`. Ring assembly now nodes with `unary_union` and closes with
  `polygonize`, verified against all four shapes: one closed outer ring, an outer
  split into open halves, outer-plus-inner courtyards, and disjoint outer rings.

- **Two new layers were never declared.** `35_WATERWAY` and `80_GRID_100M` had
  entities written to them but no LAYER table entry, because two edits adding
  them to `LAYERS` silently matched nothing and only the entity count was
  checked afterwards. DXF permits this — the entities land on an implicit layer
  with default colour and lineweight and no frozen flag, and nothing errors, so
  the grid would have printed with the drawing. `write_dxf` now asserts that
  every layer an entity uses has a table entry, and fails loudly if not.

- **`building:part` was drawn as a footprint.** It is Simple-3D-Buildings detail
  subdividing an outline that is already mapped as `building`, so every part lies
  inside a footprint the drawing already has — stacking duplicate outlines on the
  same roof. It is now excluded from both the query and the parse.
- **Pedestrian squares came out as donuts.** A closed `highway` way tagged
  `area=yes` is a surface, not a centreline, but it was being buffered as one: a
  40 m square became a 1.8 m ring around a void, 576 m² instead of 1600 m².
  Highway areas now join the road dissolve directly as surfaces. A closed loop
  road *without* `area=yes` is still buffered as a centreline — there is a
  fixture case for that, so the fix cannot over-reach.

The last six were invisible until the fixture was extended to include the
things real OSM actually contains — relations, courtyards, open coastline ways
and watercourses — and until the DXF was checked for layer *properties* rather
than just entity counts.

The registration fit, the Overpass client and the coverage report have **not**
been exercised against real OSM data — only against the fixture.

# Port Louis — urban site base

CAD-quality DXF site base for central Port Louis (Aapravasi Ghat / Le Grenier /
harbour edge), built from OpenStreetMap in the established local metric system.

The 600 × 600 m study square — the *cadrage* — was drawn previously. This
pipeline rebuilds it **and extends the same drawing language outward to the full
satellite frame, 1478.65 × 1038.21 m**, so the block structure reads continuously
past the boundary instead of stopping at it.

```
scripts/portlouis_site.py      the pipeline — one file, top to bottom
scripts/make_test_fixture.py   synthetic fixture, for running it offline
```

---

## Status — read this first

The script is complete and tested, but **it has not been run against real
OpenStreetMap data**, because this environment could not do so:

| | |
|---|---|
| Network | Every OSM host — `overpass-api.de`, `overpass.kumi.systems`, `api.openstreetmap.org`, `nominatim.openstreetmap.org`, `photon.komoot.io` — is refused at the CONNECT by the egress policy (HTTP 403). |
| Input files | `PortLouis_StudyArea_BASE_metres.dxf`, `satellite_FULLFRAME_1479x1038m.jpg` and `satellite_STUDYAREA_600x600m.jpg` are not in the repository. |

So there are no real outputs here — no DXF, no `preview.png`, no
`coverage_report.md`. Run it on a machine with the three input files and normal
internet and it will produce all of them.

What *has* been verified is in [Testing](#testing): the whole pipeline runs end
to end against synthetic geometry, and four real bugs were found and fixed that
way.

---

## Running it

```bash
pip install ezdxf shapely pyproj scipy matplotlib numpy requests

# put the three input files in the working directory, then:
python3 scripts/portlouis_site.py --workdir .

# check the registration before committing to the full drawing:
python3 scripts/portlouis_site.py --workdir . --stage register
```

`--stage register` fits the transform, writes `qa_overlay.png` and
`qa_register.dxf`, and stops. Look at the overlay: green linework should sit on
roofs and kerbs, yellow traced water on the harbour edge. Then rerun without it.

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
`coverage_report.md`

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

**`80_GRID_100M` is computed, not read.** The brief refers to it but it is not
among the layers the base DXF is stated to contain. The coverage report builds a
6 × 6 grid of 100 m cells on the local origin, labelled A1–F6, which will line
up with the layer if it exists.

Everything else follows the brief. In particular: no footprint is vectorised
from the raster, no tree is invented inside a park polygon, no fallback geometry
is substituted if Overpass fails, and the verified layers are carried through
unmodified.

---

## Testing

`make_test_fixture.py` builds a synthetic `osm_raw.json`, base DXF and satellite
raster — a clean 44° / 136° grid, block-filling footprints, a harbour polygon, open
coastline, canals, multipolygon relations with courtyards, a self-intersecting
footprint, rail and parking. It is **not** Port Louis; it exists so the pipeline
can be exercised without network access. Because the fixture is authored in
local metres and inverted to lon/lat through the same transform the pipeline
derives, it doubles as a round-trip check.

```bash
python3 scripts/make_test_fixture.py --outdir /tmp/fixture
python3 scripts/portlouis_site.py --workdir /tmp/fixture
```

Verified: DXF is R2018 with `$INSUNITS` 6 / 4; the millimetre file is exactly
×1000 on all 3988 vertices plus circle radii and hatch pattern scale; the study
square measures 600.000000 m; carried layers survive into both files; layer
colours, lineweights and the frozen centreline layer are correct; `--stage
register` writes no site DXF; a missing base DXF aborts with exit 2; a shape
mismatch in `02_WATER` trips the rotation warning at 28°, reaches rms 147 m, and
aborts before writing anything.

Seven bugs were found this way and fixed:

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

The last three were invisible until the fixture was extended to include the
things real OSM actually contains — relations, courtyards, open coastline ways
and watercourses. The first fixture had none of them.

The registration fit, the Overpass client and the coverage report have **not**
been exercised against real OSM data — only against the fixture.

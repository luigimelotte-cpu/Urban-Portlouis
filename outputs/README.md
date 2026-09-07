# Outputs

Produced by `scripts/site_plan.py`. Regenerate with:

```bash
python3 scripts/site_plan.py --workdir outputs --cadrage-only
```

**These carry `CADRAGE` only.** OpenStreetMap is unreachable from the
environment that built them (every Overpass and Nominatim host is refused at the
CONNECT by the egress policy), so `BUILDINGS`, `STREETS`, `WATER`, `PARKING` and
`TREES` are declared in the layer table but empty. No geometry was invented to
fill them.

Drop `cadrage.geojson` on the satellite imagery in Google Earth or QGIS to check
the boundary against the picture.

Re-run without `--cadrage-only` from a network that permits the OSM hosts, or
replay a response fetched elsewhere with `--osm-json FILE`, to fill the drawing.

| File | |
|---|---|
| `site_plan.dxf` | R2018, metres, origin at the cadrage SW corner |
| `preview.png` | matplotlib render, read back from the DXF |
| `cadrage.json` | the reconstruction, its cross-checks and the local/UTM transform |
| `cadrage.geojson` | the cadrage as a WGS84 polygon |

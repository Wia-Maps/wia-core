# WIA Mapping Guide

This guide walks from raw OpenStreetMap data to a WIA-ready campus dataset. For a shorter overview, see [WIA Academy](./WIA_ACADEMY.md).

## 1. Prepare the viewport

1. Open [Overpass Turbo](https://overpass-turbo.eu/).
2. Pan and zoom until your entire campus fits in the map view (the query uses `{{bbox}}` — only the visible area is exported).
3. Paste the script from [kit/overpass_queries.txt](../kit/overpass_queries.txt) and run it.
4. Export results as **GeoJSON**.

## 2. OSM quality pass

Before relying on exports:

* Trace missing **footpaths** and **building** outlines in [OpenStreetMap](https://www.openstreetmap.org/) (iD Editor or JOSM).
* Prefer `highway=footway` / `path` for walkable segments the routing engine should use.
* Close building polygons on OSM before export.

## 3. Normalize for WIA

* **Coordinate order:** `[longitude, latitude]` everywhere (GeoJSON standard).
* **Polygon closure:** First ring vertex equals the last.
* **Locations dataset** (`sample.geojson`): each feature needs `properties.name` and `properties.type`.
* **Routing dataset** (`campus-routing.geojson`): nodes as Points with `properties.node_id`; edges as LineStrings with `from` / `to` or `highway` / `kind=edge` for inferred segments.

Compile exports into:

* `server/public/data/sample.geojson`
* `server/public/data/campus-routing.geojson`

See [server/public/data/README.md](../server/public/data/README.md) for the Achievers University reference bundle workflow.

## 4. Load into WIA

**First boot:** Replace seed files, then start the server so MongoDB seeds from disk.

**Existing database:** Use **Admin → Datasets** to import or bulk-upsert; seed files are only read when no revision exists yet.

## 5. Nesting and utilities (admin panel)

1. Define parent structures (complexes, blocks).
2. Add child nodes (shops, labs, halls) linked to parents.
3. Attach utility metadata (power, accessibility, hours).

Garbage geometry produces bad routes — validate on the ground after import.

## Checklist

- [ ] Campus bbox verified on Overpass
- [ ] GeoJSON coordinate order checked
- [ ] Locations and routing files validate locally
- [ ] `web/src/config/client.ts` center/zoom matches campus
- [ ] Spot-check routing between two known landmarks

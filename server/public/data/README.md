# Campus GeoJSON seed data

The API seeds MongoDB map datasets from files under this directory on **first boot** when no revision exists yet.

## Primary campus file — `sample.geojson`

Maintainers ship the **full campus export** as a single FeatureCollection:

```
server/public/data/sample.geojson
```

This is typically the raw Overpass Turbo GeoJSON export (buildings as polygons, footpaths as lines, nodes as points — all in one file).

### Admin import auto-split

When you import through **Admin → Datasets**, the upload engine splits one mixed file automatically:

| Detected geometry | Dataset | Notes |
| --- | --- | --- |
| Polygon / MultiPolygon | `locations` | Buildings, zones, footprints |
| LineString (+ `highway`, `kind=edge`, or `from`/`to`) | `routing` | Walkable edges |
| Point (+ `node_id`, `entrance`, `kind=node`, etc.) | `routing` | Graph / entrance nodes |
| Other points | `locations` | POIs |

You do **not** need to manually separate routing into a second file for normal workflow.

## Bootstrap stub — `campus-routing.geojson`

A **minimal routing graph** used only so a fresh clone can boot the API before the first real import. Adopters replace campus data via `sample.geojson` + admin import, not by editing this stub.

`campus-routing-mock.geojson` is an optional fallback path if the primary routing seed file is missing.

## Achievers University (reference campus)

1. Export campus geometry from Overpass ([kit/overpass_queries.txt](../../kit/overpass_queries.txt)).
2. Save as **`sample.geojson`** (single mixed FeatureCollection).
3. Import via **Admin → Datasets**, or overwrite this file before first DB seed and restart the server.
4. Optionally trace the same features on OSM for community consistency.

## Validation rules

- **Locations:** each feature needs `properties.name` and `properties.type` (admin import can derive these from OSM tags).
- **Routing:** Point nodes need routing tags; edges need `from`/`to` or highway-style LineStrings.
- **Polygons:** first and last ring coordinates must match (closed rings).
- **Coordinates:** `[longitude, latitude]` (RFC 7946).

See [docs/TECHNICAL_SPEC.md](../../docs/TECHNICAL_SPEC.md) and [tutorials/MAPPING_GUIDE.md](../../tutorials/MAPPING_GUIDE.md).

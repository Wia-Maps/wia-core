# Campus GeoJSON seed data

The API seeds MongoDB map datasets from these files on first boot when no revision exists yet.

## Files

| File | Dataset | Purpose |
| --- | --- | --- |
| `sample.geojson` | `locations` | Building footprints, POIs, and nested location features |
| `campus-routing.geojson` | `routing` | Pedestrian routing graph (nodes, edges, entrances) |
| `campus-routing-mock.geojson` | `routing` (fallback) | Optional alternate routing fixture if the primary file is absent or invalid |

## Achievers University (reference campus)

Replace the bundled starter fixtures with your full **Achievers University** export:

1. Export or compile your campus geometry into RFC 7946 GeoJSON (`[longitude, latitude]` order).
2. Overwrite `sample.geojson` with your locations / structures collection.
3. Overwrite `campus-routing.geojson` with your routing graph.
4. Restart the server (or import via **Admin → Datasets** if the database was already seeded).

The repository ships minimal valid placeholders so a fresh clone boots without MongoDB errors. The real campus bundle should be dropped in by maintainers who have the production dataset.

## Validation rules

- **Locations:** each feature needs `properties.name` and `properties.type`.
- **Routing:** Point nodes need `properties.node_id`; edges need `from` / `to` referencing existing nodes, or `highway` / `kind=edge` LineStrings for inferred segments.
- **Polygons:** first and last ring coordinates must match (closed rings).

See [docs/TECHNICAL_SPEC.md](../../docs/TECHNICAL_SPEC.md) and [kit/overpass_queries.txt](../../kit/overpass_queries.txt).

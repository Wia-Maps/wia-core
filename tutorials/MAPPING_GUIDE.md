# WIA Mapping Guide

> **Documentation notice**
>
> **Last reviewed:** May 2026  
> WIA changes in this repository faster than external copies of these guides.  
> If a tutorial conflicts with the code or [TECHNICAL_SPEC](../docs/TECHNICAL_SPEC.md), **trust the repo**.

This guide covers OpenStreetMap extraction through GeoJSON preparation, including buildings OSM does not show and utility metadata on features. For admin import and nesting, continue to [Admin Guide](./ADMIN_GUIDE.md).

---

## 1. Why OpenStreetMap

Generic maps are built for vehicles. WIA routes students on **footpaths**. Tracing your campus on OpenStreetMap gives you **data sovereignty** — the university owns updates and does not wait on third-party satellite cycles.

Bad OSM geometry produces bad routing. Verify footprints and paths on satellite imagery and on the ground before export.

---

## 2. Trace on OpenStreetMap

1. Open [openstreetmap.org](https://www.openstreetmap.org/), log in, and click **Edit** (iD Editor).
2. Zoom to your campus.
3. **Buildings:** Draw a closed polygon over the footprint. Tag `building=yes` or a specific type (e.g. `building=university`).
4. **Footpaths:** Draw lines along real walkable routes. Tag `highway=footway` or `highway=path` — not across grass unless people actually walk there.
5. **Close every polygon:** The first and last vertex must be identical.
6. **Save** with a clear changeset comment (e.g. *Achievers University — footpaths for WIA*).
7. Wait for Overpass to sync (usually minutes; up to ~1 hour).

---

## 3. Export with Overpass Turbo

1. Open [overpass-turbo.eu](https://overpass-turbo.eu/).
2. Pan/zoom so the **entire campus** fits in the viewport (`{{bbox}}` = visible area only).
3. Paste the script from [kit/overpass_queries.txt](../kit/overpass_queries.txt).
4. Click **Run** — buildings, highways, barriers, amenities, and related layers highlight.
5. **Export → GeoJSON** and download.

### Coordinate order

GeoJSON always uses **`[longitude, latitude]`** (X, Y). Swapped coordinates place the campus in the wrong location. See [RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946).

---

## 4. Split into WIA datasets

WIA stores two dataset types:

| File | Dataset | Contents |
| --- | --- | --- |
| `server/public/data/sample.geojson` | `locations` | Building footprints, POIs, nested locations |
| `server/public/data/campus-routing.geojson` | `routing` | Pedestrian graph (nodes + edges) |

From your Overpass export:

* **Locations:** Polygons and POI features with `properties.name` and `properties.type`.
* **Routing:** Point nodes with `properties.node_id`; LineString edges with `from` / `to` referencing those nodes, or `highway` / `kind=edge` for inferred segments.

Details: [server/public/data/README.md](../server/public/data/README.md).

---

## 5. Map Coordinate app (buildings OSM misses)

Some structures are missing, misaligned, or not yet approved on OSM. Use the **Map Coordinate** mobile app to capture ground-truth coordinates, then add them to WIA manually.

**App name:** Map Coordinate (iOS / Android — third-party app, not part of this repo)

![Map Coordinate app — copy lat/lng from your position](./assets/map-coordinate-app.png)

*Replace `tutorials/assets/map-coordinate-app.png` with a team screenshot showing the coordinate readout.*

### Workflow

1. Install **Map Coordinate** on your phone.
2. Stand at a building corner or path point you need to map.
3. Copy the coordinates shown in the app (typically **latitude** and **longitude** as separate values).
4. Convert to GeoJSON order: **`[longitude, latitude]`** — longitude first.
5. Add the feature using either path below (§6).
6. Optionally trace the same feature on OSM later so the global map stays consistent.

**Example:** App shows `Lat 7.1646, Lng 5.5839` → GeoJSON point: `[5.5839, 7.1646]`.

---

## 6. Manual GeoJSON editing

Use this for **new buildings**, **utility fields**, or corrections Overpass/OSM cannot express yet.

### Required location fields

Each location feature must include:

| Field | Required | Example |
| --- | --- | --- |
| `properties.name` | Yes | `"Block C"` |
| `properties.type` | Yes | `"Building"` |
| `id` or `properties.id` | Recommended | `"block-c-main"` |

### Utilities object

Add operational metadata under `properties.utilities` (see [TECHNICAL_SPEC](../docs/TECHNICAL_SPEC.md)):

```json
{
  "type": "Feature",
  "id": "block-c-main",
  "properties": {
    "name": "Block C",
    "type": "Building",
    "category": "Academic",
    "utilities": {
      "hasPower": true,
      "chargingNodesAvailable": 2,
      "accessibilityRamps": true
    }
  },
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [5.58390, 7.16460],
        [5.58410, 7.16460],
        [5.58410, 7.16480],
        [5.58390, 7.16480],
        [5.58390, 7.16460]
      ]
    ]
  }
}
```

*Note: Polygon rings must close (first point = last point). Coordinates are `[lng, lat]`.*

### Option A — Edit files locally

1. Open `sample.geojson` or `campus-routing.geojson` in a text editor or QGIS.
2. Append or edit features; validate JSON.
3. **First boot:** Replace seed files, restart server.
4. **Existing database:** Import via **Admin → Datasets** (see [Admin Guide](./ADMIN_GUIDE.md)).

### Option B — Edit in admin UI

1. Sign in at http://localhost:5173/admin.
2. Open **Datasets** (`/admin/datasets`).
3. Select the `locations` or `routing` dataset.
4. **Create or edit a feature** using the map geometry editor (click the map to place polygon vertices or points).
5. Open **Utilities → Raw JSON** for full feature JSON (advanced edits to `utilities` and other properties).
6. **Publish** the revision and verify on http://localhost:5173/map.

---

## 7. Load into WIA

| Scenario | Action |
| --- | --- |
| Fresh MongoDB (no prior seed) | Replace files under `server/public/data/`, start server |
| Database already seeded | **Admin → Datasets** import or bulk upsert |

Seed files are only read automatically when no dataset revision exists yet.

---

## 8. Nesting (admin panel)

Geometry alone is a shell. After import:

1. Open **Admin → Locations** (`/admin/locations`).
2. Define parent structures (complexes, blocks).
3. Add child nodes (shops, labs, halls).
4. Set utility and operational metadata.

Full steps: [Admin Guide](./ADMIN_GUIDE.md).

---

## Checklist

- [ ] Campus bbox verified on Overpass
- [ ] Building polygons closed on OSM
- [ ] GeoJSON uses `[longitude, latitude]`
- [ ] `sample.geojson` and `campus-routing.geojson` validate
- [ ] OSM gaps filled via Map Coordinate where needed
- [ ] `utilities` set on key buildings
- [ ] `web/src/config/client.ts` center/zoom matches campus
- [ ] Spot-check routing between two landmarks on `/map`

## Reviewers

| Area | Reviewer |
| --- | --- |
| Mapping / OSM / GeoJSON | Japheth O. Egbedele |
| Admin / operations | Adelola Faith Adeyekun |

# WIA Academy: Mapping Your Campus

Welcome to the WIA mapping workflow. Building a digital twin requires precision and hierarchy. This academy teaches how to extract global data and structure it for the WIA engine.

## Masterclass video

| Item | Status |
| --- | --- |
| **3-minute deployment walkthrough** | **Not published yet** — no YouTube (or other) link is available in this repository. |

Until the video is live, use the written path:

* [Setup & Deployment Guide](../docs/SETUP_GUIDE.md) — install server + web, bootstrap admin
* [Mapping Guide](./MAPPING_GUIDE.md) — OSM, Overpass, GeoJSON, admin nesting

When the masterclass is recorded, maintainers should paste the URL below and update [tutorials/README.md](./README.md).

```
Video URL: (pending — add https://youtube.com/... or similar)
```

## Phase 1: OpenStreetMap (OSM) extraction

* **Tools:** Overpass Turbo / iD Editor ([kit/overpass_queries.txt](../kit/overpass_queries.txt))
* **Action:** Trace building footprints and footpaths from satellite imagery.
* **Rule:** Close polygons — first and last coordinates must match.

## Phase 2: Generating GeoJSON

* Export OSM data as GeoJSON with `[longitude, latitude]` order (RFC 7946).
* **Never** use `[latitude, longitude]` in GeoJSON files.

Place campus files in [server/public/data/](../server/public/data/README.md):

* `sample.geojson` — locations
* `campus-routing.geojson` — routing graph

## Phase 3: Nesting via the WIA admin panel

A building is a shell; **nesting** adds intelligence inside it.

1. Define the parent node (complex / block).
2. Add internal nodes (shops, labs, halls).
3. Assign utility metadata (power, accessibility, hours).

*Garbage data in, garbage routing out. Map with integrity.*

## Help

* [Maintainers](../docs/MAINTAINERS.md) — contact and governance
* [Contributing](../docs/CONTRIBUTING.md) — code contributions

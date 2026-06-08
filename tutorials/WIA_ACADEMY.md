# WIA Academy

> **Documentation notice**
>
> **Last reviewed:** May 2026  
> WIA changes in this repository faster than external copies of these guides.  
> If a tutorial conflicts with the code, [SETUP_GUIDE](../docs/SETUP_GUIDE.md), or package READMEs, **trust the repo**.

Building a campus digital twin requires precision and hierarchy. This academy is **text-first** and updated in the repo when the product changes — no stale video to maintain.

## Learning path

### Step 1 — Install WIA locally

Follow [Setup & Deployment Guide](../docs/SETUP_GUIDE.md):

* Fork and clone `wia-core`
* `server/` on port **5000**, `web/` on port **5173**
* Register admin via `POST /api/v1/admin/register`
* Sign in at http://localhost:5173/admin

### Step 2 — Map your campus (geometry)

Follow [Mapping Guide](./MAPPING_GUIDE.md):

* Trace buildings and footpaths on [OpenStreetMap](https://www.openstreetmap.org/)
* Export with [Overpass Turbo](https://overpass-turbo.eu/) and `kit/overpass_queries.txt`
* Save the export as a **single** `sample.geojson` FeatureCollection (buildings, paths, and nodes together)
* Add OSM gaps with **Map Coordinate** and manual GeoJSON edits
* Import via **Admin → Datasets** — the upload engine auto-splits geometry (see Mapping Guide)

### Step 3 — Operate via admin dashboard

Follow [Admin Guide](./ADMIN_GUIDE.md):

* Import datasets at **Admin → Datasets**
* Nest POIs at **Admin → Locations**
* Manage power at **Admin → Power**; routes at **Admin → Routes**
* Fork branding in `web/src/config/client.ts`

## Principles

* **Coordinate order:** GeoJSON uses `[longitude, latitude]` (RFC 7946).
* **Closed polygons:** First ring vertex equals the last.
* **Nesting:** OSM gives the shell; the admin panel adds intelligence inside buildings.
* **Integrity:** Garbage data in, garbage routing out.

## Help

* [Maintainers](../docs/MAINTAINERS.md)
* [Contributing](../docs/CONTRIBUTING.md)
* [Technical Specification](../docs/TECHNICAL_SPEC.md)

## Reviewers

| Area | Reviewer |
| --- | --- |
| Mapping / OSM / GeoJSON | Japheth O. Egbedele |
| Admin / operations | Adelola Faith Adeyekun |

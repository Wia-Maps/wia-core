# WIA Admin Guide

> **Documentation notice**
>
> **Last reviewed:** May 2026  
> WIA changes in this repository faster than external copies of these guides.  
> If a tutorial conflicts with the code or [SETUP_GUIDE](../docs/SETUP_GUIDE.md), **trust the repo**.

This guide covers local bootstrapping and the admin dashboard: importing GeoJSON from [Mapping Guide](./MAPPING_GUIDE.md), nesting locations, and operating power and routes.

---

## 1. Local boot (two terminals)

**Terminal 1 — API**

```bash
cd server
cp .env.example .env
# Set MONGODB_URI, JWT_SECRET, CLIENT_ORIGIN=http://localhost:5173
npm install
npm run dev
```

Verify: `curl http://localhost:5000/api/v1/health`

**Terminal 2 — Web**

```bash
cd web
cp .env.example .env.local
# VITE_API_BASE_URL=/api/v1 (Vite proxies to localhost:5000)
npm install
npm run dev
```

| URL | Purpose |
| --- | --- |
| http://localhost:5173/map | Public campus map |
| http://localhost:5173/admin | Admin workspace |

---

## 2. First admin account

Register once while the API is running:

```bash
curl -X POST http://localhost:5000/api/v1/admin/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourcampus.edu.ng","password":"secure-temporary-password"}'
```

* Returns `409` if that email already exists.
* No `X-Initialization-Key` header is required.

Sign in at http://localhost:5173/admin with the same email and password.

---

## 3. Admin → Datasets (`/admin/datasets`)

Import campus geometry produced in the [Mapping Guide](./MAPPING_GUIDE.md).

1. Open **Datasets** from the admin sidebar.
2. Select **locations** — import or bulk-upsert `sample.geojson`.
3. Select **routing** — import `campus-routing.geojson`.
4. The server validates geometry (closed polygons, `[lng, lat]`, connected routing nodes).
5. **Publish** the revision.
6. Reload **/map** — buildings and paths should appear.

**Utilities panel** (same page):

* **Raw JSON** — edit full feature objects (e.g. `properties.utilities`).
* **History** — restore a previous dataset revision if an import fails.

**Manual edits without re-exporting OSM:** create a new feature in the dataset wizard, use the map geometry editor, or paste JSON in Raw JSON mode.

---

## 4. Admin → Locations (`/admin/locations`)

Turn polygons into intelligent campus assets.

1. Search or browse imported locations.
2. Edit **name**, **type**, and category metadata.
3. **Nest** child locations inside parent buildings (shops, labs, halls inside a complex).
4. Link utility and operational fields students see on the map.

OSM provides the outer shell; nesting and metadata happen here.

---

## 5. Admin → Power (`/admin/power`)

Campus **utility layer** — live power status students see on the map.

* Bulk status reports for multiple locations
* Scheduled power updates
* Location-level locks for controlled changes

Requires locations to exist before power can be attached meaningfully.

---

## 6. Admin → Routes (`/admin/routes`)

Pedestrian **routing operations** as the campus scales.

* Review route **candidates** from user telemetry
* Approve or reject suggested path corrections
* Manage route recording workflows

Optional at day one; more important after students begin navigation.

---

## 7. Admin → Activity (`/admin/activity`)

Audit log of admin changes with revert support. Use for accountability when multiple operators edit datasets or power state.

---

## 8. Admin → Settings (`/admin/settings`)

Workspace preferences and admin configuration. Review alongside your deployment policy.

---

## 9. Fork branding (`web/src/config/client.ts`)

Adopters changing university:

* `campus_id` — must align with server/analytics campus ID
* `map.center`, zoom, bounds
* `theme` colors and feature flags

The file `kit/config.template.json` is a planning mirror only; the app reads `client.ts` at runtime.

---

## 10. Production (pointer)

When moving off localhost:

* Set `VITE_API_BASE_URL` to your HTTPS API (see [web/README.md](../web/README.md))
* Set server `CLIENT_ORIGIN` to your front-end origin
* Deploy over **HTTPS** (required for PWA and push)
* Use a campus subdomain (e.g. `map.university.edu.ng`)
* QR codes at building entrances for student onboarding

Full lifecycle: [SETUP_GUIDE](../docs/SETUP_GUIDE.md) Phase 3.

---

## Checklist

- [ ] Health check passes on port 5000
- [ ] Admin registered and signed in
- [ ] Locations and routing datasets imported and published
- [ ] `/map` shows campus geometry
- [ ] Key buildings nested with utility metadata
- [ ] Power and routes reviewed if going live to students

## Reviewers

| Area | Reviewer |
| --- | --- |
| Mapping / OSM / GeoJSON | Japheth O. Egbedele |
| Admin / operations | Adelola Faith Adeyekun |

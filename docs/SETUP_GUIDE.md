# WIA Setup & Deployment Guide

Follow this guide to deploy an isolated instance of the Smart Campus Operating System for your institution in under 48 hours.

## Prerequisites

* Node.js (v18 or higher)
* MongoDB (local or Atlas with geospatial indexing enabled)
* OpenStreetMap account (for iD Editor or JOSM tracing)

## Repository layout

| Path | Role |
| --- | --- |
| `server/` | Express API (port **5000**) |
| `web/` | React + Vite PWA (port **5173**) |
| `python_worker/` | Optional route analytics worker |
| `kit/` | Overpass queries, pitch outline, planning config template |
| `server/public/data/` | Campus GeoJSON seed fixtures (replace with your full bundle) |

## Step-by-step deployment

### 1. Repository setup

1. **Fork** `wia-core` on GitHub.
2. **Clone** your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/wia-core.git
   cd wia-core
   ```

3. **Campus GeoJSON (maintainers):** Save the full Overpass export as a single mixed file:

   - `server/public/data/sample.geojson`

   Import via **Admin → Datasets** — the engine auto-splits **polygons** into locations and **LineString / routing Point** features into the routing graph. You do not need a separate routing export file for normal workflow.

   See [server/public/data/README.md](../server/public/data/README.md). A minimal `campus-routing.geojson` stub remains for API bootstrap only.

4. **Configure the web client** in `web/src/config/client.ts` (`campus_id`, map center, theme). The file `kit/config.template.json` is a planning mirror only; the app reads `client.ts` at runtime.

### 2. Local initialization (two terminals)

**Terminal 1 — API**

```bash
cd server
cp .env.example .env
# Edit .env: MONGODB_URI, JWT_SECRET, CLIENT_ORIGIN, optional Cloudinary for fellowship logos
npm install
npm run dev
```

Verify: `curl http://localhost:5000/api/v1/health`

**Terminal 2 — Web**

```bash
cd web
cp .env.example .env.local
# VITE_API_BASE_URL=/api/v1 uses the Vite proxy to localhost:5000
npm install
npm run dev
```

Open **http://localhost:5173** (map) and **http://localhost:5173/admin** (admin workspace).

### 3. Administrative initialization

1. **Bootstrap the admin account** (API must be running):

   ```bash
   curl -X POST http://localhost:5000/api/v1/admin/register \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@yourcampus.edu.ng","password":"secure-temporary-password"}'
   ```

   Returns `409` if that email already exists. There is no `X-Initialization-Key` header in the current API.

2. **Sign in** at http://localhost:5173/admin with the same credentials.

3. **Base geometry:** Use Overpass Turbo with `kit/overpass_queries.txt`, export GeoJSON, and either replace the seed files under `server/public/data/` (before first DB seed) or upload via **Admin → Datasets**.

4. **Enrichment:** Link spatial nesting nodes and utility metadata in the admin panel.

---

## University adoption lifecycle

### Phase 1: Institutional alignment and data mining

* **Fork and branding:** Fork `wia-core`; set `web/src/config/client.ts` and optional server `CAMPUS_ID` / env values.
* **OSM verification:** Trace missing footpaths and buildings in OpenStreetMap over your campus bbox.
* **Base geometry extraction:** Run the Overpass query and export clean GeoJSON primitives.

### Phase 2: Local hardening and administrative setup

* **Deploy and bootstrap:** MongoDB, two-terminal dev flow, `POST /api/v1/admin/register`.
* **Spatial enrichment:** Upload master datasets; tag utilities and nested POIs on the ground.

### Phase 3: Administrative approval and launch

* **Executive pitch:** Use `kit/PITCH_DECK_OUTLINE.md` for management buy-in.
* **Production:** Deploy `web` and `server` with `VITE_API_BASE_URL` pointing at your API; use a campus subdomain (e.g. `map.university.edu.ng`).
* **Physical nodes:** QR plates at key facilities for student onboarding.

## Further reading

* [server/README.md](../server/README.md) — API, env vars, endpoints
* [web/README.md](../web/README.md) — frontend, PWA, admin routes
* [python_worker/README.md](../python_worker/README.md) — optional analytics worker
* [docs/TECHNICAL_SPEC.md](./TECHNICAL_SPEC.md) — GeoJSON and architecture

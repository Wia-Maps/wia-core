# Wia Core

Wia Core is a campus operations and mapping platform. The workspace is split into a React PWA, an Express API, and a Python route analytics worker.

## Codebases

| Path | Purpose |
| --- | --- |
| `web/` | React + Vite progressive web app for the public campus map, navigation, live status, notifications, and admin workspace. |
| `server/` | Express + MongoDB API for map datasets, locations, power reports, notifications, admin operations, route telemetry, and WebSocket updates. |
| `python_worker/` | Standard-library Python worker that processes route telemetry into route candidates and routing-weight overlays. |

## Quick Start

Run each codebase from its own directory.

```bash
cd server
npm install
copy .env.example .env
npm run dev
```

```bash
cd web
npm install
copy .env.example .env.local
npm run dev
```

```bash
cd python_worker
copy .env.example .env
python route_analytics_worker.py --once
```

Default local URLs:

- Web app: `http://localhost:5173`
- API health check: `http://localhost:5000/api/v1/health`
- API base path: `http://localhost:5000/api/v1`
- WebSocket paths: `/ws/power` and `/ws/live-location`

## Local Configuration

The server needs MongoDB and a JWT secret. The worker needs the server URL and the same analytics worker token configured on the server. The web app can use the local API proxy path (`/api/v1`) or a full API URL through `VITE_API_BASE_URL`.

Never commit real secrets in `.env` files.

## Main Capabilities

- Campus map rendering from managed GeoJSON datasets
- Public location search and location detail views
- Routing graph loading, runtime navigation, and route previews
- Live power status, reports, schedules, and admin controls
- Favorite-location notifications and web push configuration
- Admin workspace for locations, map datasets, route workflows, activity logs, and settings
- Route telemetry ingestion and analytics-assisted candidate route discovery
- WebSocket channels for live power and shared location updates

## Documentation

- [Web README](web/README.md)
- [Server README](server/README.md)
- [Python Worker README](python_worker/README.md)
- [Route Analytics Worker API](docs/ROUTE_ANALYTICS_WORKER.md)

## Repository Notes

Static assets and sample datasets live in the repository root, `web/public`, and `server/public/data`.

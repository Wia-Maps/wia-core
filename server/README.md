# Wia Server

Express API for Wia Core. It provides public campus data, admin operations, power-status workflows, notifications, route telemetry ingestion, analytics-worker endpoints, and WebSocket updates.

## Tech Stack

- Node.js with native ES modules
- Express
- MongoDB via Mongoose
- JSON Web Tokens for admin authentication
- Firebase Admin SDK
- WebSocket server via `ws`
- Cloudinary integration for fellowship brand uploads

## Getting Started

```bash
npm install
copy .env.example .env
npm run dev
```

The default API port is `5000`.

```bash
curl http://localhost:5000/api/v1/health
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the API with nodemon. |
| `npm start` | Start the API with Node. |

## Environment Variables

Create `.env` from `.env.example`.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP server port. Defaults to `5000`. |
| `MONGODB_URI` | MongoDB connection string. |
| `JWT_SECRET` | Secret used to sign admin tokens. |
| `JWT_EXPIRES_IN` | Admin token lifetime. |
| `ANALYTICS_WORKER_TOKEN` | Shared token required by the Python analytics worker. |
| `CLIENT_ORIGIN` | Comma-separated allowed browser origins for CORS. Empty allows all origins. |
| `CLOUDINARY_*` | Cloudinary upload configuration for fellowship brand assets. |
| `RATE_LIMIT_*` | Tunable limits for login, registration, public data, telemetry, worker, and admin operations. |

Use strong local secrets and keep real production credentials out of version control.

## API Surface

All HTTP routes are mounted under `/api/v1`.

### Public

- `GET /health`
- `GET /map/geojson`
- `GET /map/routing`
- `GET /map/routing-weights`
- `POST /map/live-share/session`
- `POST /map/live-share/resolve`
- `GET /locations`
- `GET /locations/fellowship-brands`
- `GET /power/recent`
- `GET /power/:locationId`
- `POST /power/report`
- `GET /notifications/config`
- `GET /notifications/events`
- `PUT /notifications/subscription`
- `DELETE /notifications/subscription`
- `POST /telemetry/routes`

### Admin

- `POST /admin/login`
- `POST /admin/register`
- `GET /admin/me`
- `POST /admin/logout`
- `GET /admin/locations`
- `GET /admin/locations/:locationId`
- `PUT /admin/locations/:locationId`
- `GET /admin/locations/fellowship-brands`
- `GET /admin/locations/fellowship-brands/:code`
- `POST /admin/locations/fellowship-brands/:code/logo`
- `DELETE /admin/locations/fellowship-brands/:code/logo`
- `POST /admin/power/bulk-report`
- `POST /admin/power/location-lock`
- `GET /admin/power/schedules`
- `POST /admin/power/schedules`
- `POST /admin/power/schedules/:scheduleId/cancel`
- `GET /admin/activity`
- `POST /admin/activity/:activityId/revert`
- `GET /admin/routes/candidates`
- `GET /admin/routes/candidates/:candidateId`
- `PUT /admin/routes/candidates/:candidateId`
- `POST /admin/routes/candidates/:candidateId/approve`
- `POST /admin/routes/candidates/:candidateId/reject`
- `POST /admin/routes/recordings/drafts`
- `DELETE /admin/routes/recordings/drafts/:draftId`
- `POST /admin/routes/recordings/submit`
- `POST /admin/map/bundle-import`
- `GET /admin/map/:datasetType`
- `GET /admin/map/:datasetType/revisions`
- `POST /admin/map/:datasetType/features`
- `PUT /admin/map/:datasetType/features/:featureId`
- `DELETE /admin/map/:datasetType/features/:featureId`
- `POST /admin/map/:datasetType/bulk-upsert`
- `POST /admin/map/:datasetType/bulk-delete`
- `POST /admin/map/:datasetType/restore`

### Analytics Worker

Protected by `ANALYTICS_WORKER_TOKEN`.

- `POST /analytics/worker/telemetry/claim`
- `POST /analytics/worker/telemetry/:batchId/complete`
- `POST /analytics/worker/candidates/upsert`
- `POST /analytics/worker/routing-weights`
- `POST /analytics/worker/runs/summary`

See [../docs/ROUTE_ANALYTICS_WORKER.md](../docs/ROUTE_ANALYTICS_WORKER.md) and [../python_worker/README.md](../python_worker/README.md).

## WebSockets

The HTTP server handles upgrade requests for:

- `/ws/power`
- `/ws/live-location`

## Project Structure

```text
server.js                         App bootstrap, middleware, routes, workers, sockets
src/config/                       Database, auth, Firebase, and location catalog config
src/controllers/                  Request handlers
src/middleware/                   Auth, analytics worker auth, rate limiting
src/models/                       Mongoose models
src/realtime/                     WebSocket channels
src/routes/                       Express routers
src/services/                     Business logic, datasets, routing, notifications, power
public/data/                      Seed/sample GeoJSON datasets
```

## Startup Behavior

On boot the server connects to MongoDB, seeds required map datasets, initializes WebSocket handlers, starts the notification queue worker, starts the power schedule worker, and then listens on the configured port.

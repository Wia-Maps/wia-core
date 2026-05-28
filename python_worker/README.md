# Wia Route Analytics Worker

Standard-library Python worker that claims route telemetry from the Wia API, processes it, and syncs analytics-derived route candidates and routing-weight overlays back to the server.

## Requirements

- Python 3.9 or newer
- No third-party Python packages
- A running Wia server with `ANALYTICS_WORKER_TOKEN` configured

## Getting Started

```bash
copy .env.example .env
python route_analytics_worker.py --once
```

Run continuously:

```bash
python route_analytics_worker.py --loop
```

Command-line flags can override environment values:

```bash
python route_analytics_worker.py --once --server-url http://localhost:5000 --worker-token your-token --campus-id achievers-uni-owo
```

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `ANALYTICS_SERVER_URL` | Base server URL, for example `http://localhost:5000`. |
| `ANALYTICS_WORKER_TOKEN` | Shared token that must match the server. |
| `ANALYTICS_WORKER_ID` | Optional worker identity header. |
| `ANALYTICS_CAMPUS_ID` | Campus ID to process. |
| `ANALYTICS_CLAIM_LIMIT` | Number of telemetry batches to claim per cycle. |
| `ANALYTICS_LEASE_SECONDS` | Claim lease duration. |
| `ANALYTICS_IDLE_SECONDS` | Sleep interval between loop cycles with no work. |
| `ANALYTICS_LOOP` | Enables loop mode when set to a truthy value. |
| `ANALYTICS_REQUEST_TIMEOUT_SECONDS` | HTTP request timeout. |
| `ANALYTICS_*` tuning values | Filtering, map matching, candidate support, popularity, and congestion thresholds. |

## What It Does

- Loads `.env` and `.env.local` from the worker directory
- Claims telemetry batches from `/api/v1/analytics/worker/telemetry/claim`
- Filters noisy GPS points by accuracy, speed, acceleration, jumps, pauses, and stationary jitter
- Simplifies retained paths
- Map-matches telemetry against the routing dataset with distance and heading scoring
- Discovers repeated off-graph gaps as route candidates
- Checks candidates against building footprints and records metadata for admin review
- Updates routing-weight overlays using matched edge traversals, popularity decay, and congestion windows
- Marks batches as `processed` or `discarded`
- Sends run summaries back to the API

## API Endpoints Used

The worker authenticates with `Authorization: Bearer <token>` and `x-analytics-worker-id`.

- `POST /api/v1/analytics/worker/telemetry/claim`
- `POST /api/v1/analytics/worker/telemetry/:batchId/complete`
- `POST /api/v1/analytics/worker/candidates/upsert`
- `POST /api/v1/analytics/worker/routing-weights`
- `POST /api/v1/analytics/worker/runs/summary`
- Public map/location endpoints used for routing graph and building-footprint context

See `../docs/ROUTE_ANALYTICS_WORKER.md` for request examples and worker tuning notes.

## Files

```text
route_analytics_worker.py          Worker implementation
.env.example                       Configuration template
```

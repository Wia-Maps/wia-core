# Route analytics worker

The Python worker processes route telemetry batches and writes derived route candidates and routing-weight overlays back to the API.

Full configuration, CLI flags, and tuning variables: [python_worker/README.md](../python_worker/README.md).

## Requirements

* Running Wia server with `ANALYTICS_WORKER_TOKEN` set in `server/.env`
* Matching token in `python_worker/.env`
* Python 3.9+ (stdlib only)

## Quick run

```bash
cd python_worker
cp .env.example .env
python route_analytics_worker.py --once
```

## HTTP endpoints (worker-authenticated)

All paths are under `/api/v1/analytics/worker/`:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `telemetry/claim` | Claim pending telemetry batches |
| POST | `telemetry/:batchId/complete` | Mark batch processed |
| POST | `candidates/upsert` | Publish route candidate edges |
| POST | `routing-weights` | Update congestion/popularity overlays |
| POST | `runs/summary` | Report worker run metadata |

Public clients submit telemetry via `POST /api/v1/telemetry/routes` (see [server/README.md](../server/README.md)).

## Campus ID

Set `ANALYTICS_CAMPUS_ID` to match `campus_id` in `web/src/config/client.ts` (default reference: `achievers-uni-owo`).

# Contributing to WIA Core

Thank you for helping standardize digital infrastructure across campuses. We maintain a high bar for GeoJSON correctness, modularity, and deployability.

## Architectural guarantees

1. **GeoJSON (RFC 7946):** Coordinates are `[longitude, latitude]`. Closed polygons must repeat the first vertex as the last.
2. **Data sovereignty:** Avoid proprietary map-tracking SDKs for core navigation.
3. **Modular changes:** Prefer focused PRs; match existing patterns in `server/` and `web/`.

## Local development

Run the API and web app in separate terminals (see [SETUP_GUIDE.md](./SETUP_GUIDE.md)):

```bash
cd server && npm install && npm run dev
cd web && npm install && npm run dev
```

Optional: `python_worker/route_analytics_worker.py` with `ANALYTICS_WORKER_TOKEN` matching `server/.env`.

Before opening a PR from `web/`:

```bash
npm run type-check
npm run lint
```

## Branching

* `main` — production-ready releases; no direct commits.
* `dev` — integration branch.
* `feature/<name>` — your work branch, cut from `dev`.

## Contribution lifecycle

1. Fork `wia-core` and clone your fork.
2. Branch from `dev`:

   ```bash
   git checkout dev
   git pull upstream dev
   git checkout -b feature/your-feature-name
   ```

3. Implement and test locally (health check, map load, admin flows if touched).
4. Commit with a clear message (what/why, not a file list).
5. Push and open a PR into `dev` with:
   - Summary of the change
   - Test plan (commands run, screenshots for UI)
   - Note any GeoJSON or migration impact

## GeoJSON and map data PRs

* Validate coordinate order and polygon closure ([TECHNICAL_SPEC.md](./TECHNICAL_SPEC.md)).
* Large campus bundles belong under `server/public/data/` or admin import paths — do not embed megabyte GeoJSON inside TypeScript.
* Routing graphs must satisfy server validation (`node_id`, `from`/`to` edges).

## Code review expectations

* No secrets in diffs (rotate anything accidentally committed).
* API changes: update [server/README.md](../server/README.md) endpoint lists when routes change.
* UI changes: keep campus-specific values in `web/src/config/client.ts`, not hardcoded in components.

## Questions

* [Maintainers](./MAINTAINERS.md) — contacts (update placeholders before public release)
* GitHub Issues for bugs or design questions before large refactors

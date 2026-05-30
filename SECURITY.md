# Security Policy

## Supported versions

Security fixes are applied on the `main` branch. Release tags will be noted in GitHub releases when available.

## Reporting a vulnerability

**Do not** open public GitHub issues for undisclosed security problems.

Email or DM the repository maintainers with:

* Description and impact
* Steps to reproduce
* Affected paths (e.g. `server/`, `web/`)
* Suggested fix (optional)

We aim to acknowledge reports within a few business days.

## Secrets and credentials

* Never commit `.env`, `.env.local`, Firebase service account JSON, or API keys.
* Use `server/.env.example` and `web/.env.example` as templates only.
* If credentials were ever committed, **rotate them immediately** in the provider console (MongoDB Atlas, Cloudinary, Firebase, etc.) and purge them from git history if the repo was public.

## Deployment hygiene

* Use strong `JWT_SECRET` and `ANALYTICS_WORKER_TOKEN` values in production.
* Restrict `CLIENT_ORIGIN` to known front-end origins.
* Serve admin and map over HTTPS in production.
* Rate limits are enabled on auth, map, telemetry, and worker routes (tunable via `RATE_LIMIT_*` in `server/.env`).

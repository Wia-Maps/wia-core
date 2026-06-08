# Open-source readiness checklist

Use this before tagging a public release.

## Repository

- [ ] Replace placeholders in [MAINTAINERS.md](./MAINTAINERS.md) (names, GitHub, email)
- [ ] Set real GitHub org/repo URLs in MAINTAINERS and README
- [ ] Rotate Cloudinary keys if old values were ever committed
- [ ] Drop full Achievers GeoJSON into `server/public/data/sample.geojson` and `campus-routing.geojson`
- [ ] Add Map Coordinate screenshot to `tutorials/assets/map-coordinate-app.png`
- [ ] Bump **Last reviewed** in tutorials when UI or API changes

## Legal and community

- [x] LICENSE (MIT)
- [x] CODE_OF_CONDUCT.md
- [x] SECURITY.md
- [x] CONTRIBUTING.md
- [x] PR / issue templates

## Documentation

- [x] Root README with monorepo layout and quick start
- [x] SETUP_GUIDE (two terminals, correct ports)
- [x] TECHNICAL_SPEC, server/README, web/README, python_worker/README
- [x] Text tutorials (Mapping + Admin guides, no video dependency)

## Code hygiene

- [x] `server/.env.example` uses placeholders only
- [x] `.gitignore` covers `__pycache__`, `.env`
- [x] Minimal seed GeoJSON for first boot
- [ ] Optional: GitHub Actions (lint, type-check)

## Deploy

- [ ] Production `VITE_API_BASE_URL` configured
- [ ] `CLIENT_ORIGIN` matches front-end URL
- [ ] HTTPS for PWA / push / service worker

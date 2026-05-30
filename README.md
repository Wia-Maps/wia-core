# WIA: The Smart Campus Operating System

**Technology is not a luxury; it is the infrastructure of modern education.**

WIA is an open-source, high-precision Digital Twin and navigation engine built specifically for African university campuses. It transitions institutions from being passive consumers of global mapping tools (like Google Maps) to active producers of their own indigenous digital infrastructure.

## The vision: more than a map

Generic maps are built for cars and highways. WIA is built for students, administrators, and campus security.

* **Data sovereignty:** The university owns its spatial data.
* **Utility layer:** Real-time campus infrastructure (power, labs, accessibility).
* **Sub-meter precision:** Path-snapping along verified pedestrian footpaths.
* **Emergency response:** Pinpoint routing for security and medical dispatch.

## The pilot: Achievers University

WIA was conceptualized and deployed at Achievers University, Owo. Reference GeoJSON for that campus belongs in `server/public/data/` (see [server/public/data/README.md](server/public/data/README.md)).

## Monorepo layout

| Directory | Description |
| --- | --- |
| [web/](web/) | React + Vite PWA (map, admin, PWA) |
| [server/](server/) | Express + MongoDB API and WebSockets |
| [python_worker/](python_worker/) | Optional telemetry analytics worker |
| [kit/](kit/) | Overpass queries, pitch outline, config template |
| [docs/](docs/) | Manifesto, setup, technical spec, contributing |
| [tutorials/](tutorials/) | Mapping academy and guides |

Root-level `wia.html` / `wia.css` are an optional static beta landing page, separate from the React app.

## Quick start

```bash
# Terminal 1
cd server && cp .env.example .env && npm install && npm run dev

# Terminal 2
cd web && cp .env.example .env.local && npm install && npm run dev
```

Then register an admin via the API and open http://localhost:5173/admin. Full steps: [Setup & Deployment Guide](docs/SETUP_GUIDE.md).

## University starter kit

Templates and extraction scripts live in `/kit` for NACOS-scale campus rollouts.

## Maintainers

Contact and governance: [docs/MAINTAINERS.md](docs/MAINTAINERS.md) (update placeholder emails before publishing). Security: [SECURITY.md](SECURITY.md).

## Documentation

- [The WIA Manifesto](docs/MANIFESTO.md)
- [Setup & Deployment Guide](docs/SETUP_GUIDE.md)
- [Technical Specification](docs/TECHNICAL_SPEC.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Tutorials index](tutorials/README.md) — includes **video status** (masterclass not published yet)
- [WIA Academy](tutorials/WIA_ACADEMY.md)
- [Mapping Guide](tutorials/MAPPING_GUIDE.md)
- [Server README](server/README.md) · [Web README](web/README.md)

## Security

Report vulnerabilities per [SECURITY.md](SECURITY.md). Never commit `.env` files or real API secrets.

Pre-release audit: [docs/OPEN_SOURCE_CHECKLIST.md](docs/OPEN_SOURCE_CHECKLIST.md).

## License

Distributed under the MIT License. See [LICENSE](LICENSE).

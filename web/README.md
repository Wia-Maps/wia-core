# Wia Web

React + Vite progressive web app for the Wia campus map, navigation experience, notifications, live power status, and admin workspace.

## Tech Stack

- React 18 and TypeScript
- Vite
- Zustand for app state
- Leaflet and MapLibre-oriented map utilities
- Firebase web SDK for optional messaging/config integrations
- Tailwind CSS plus app-specific CSS

## Features

- Landing page at `/`
- Public campus map at `/map`
- Admin workspace at `/admin`, `/admin/locations`, `/admin/power`, `/admin/routes`, `/admin/datasets`, `/admin/activity`, and `/admin/settings`
- Managed map dataset loading with local cache fallback
- Campus location search and detail bottom sheet
- Runtime routing, route previews, navigation feedback, and route telemetry
- Power supply overlays, live power status, and recent reports
- Favorite-location notification sync and message/event layers
- Fellowship brand data and logo rendering
- PWA manifest and service worker files in `public/`

## Getting Started

```bash
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:5173`.

## Registering an Admin Account

The web app includes an admin sign-in screen at `/admin`, but admin registration is done through the API.

Start the server first, make sure `server/.env` has `MONGODB_URI` and `JWT_SECRET`, then create an admin account:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:5000/api/v1/admin/register `
  -ContentType 'application/json' `
  -Body '{"email":"admin@example.com","password":"change-this-password"}'
```

Equivalent curl command:

```bash
curl -X POST http://localhost:5000/api/v1/admin/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"change-this-password"}'
```

After registration, open `http://localhost:5173/admin` and sign in with the same email and password. Registration returns `409 Admin already exists` if that email has already been created.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server. |
| `npm run build` | Type-check and build the production bundle. |
| `npm run preview` | Preview the production build locally. |
| `npm run type-check` | Run TypeScript without emitting files. |
| `npm run lint` | Lint TypeScript and React source files. |
| `npm run lint:fix` | Apply ESLint fixes where possible. |

## Environment Variables

Create `.env.local` from `.env.example`.

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | API base URL. Use `/api/v1` for the local or Cloudflare proxy path, or a full URL such as `http://localhost:5000/api/v1`. |
| `VITE_SOCKET_BASE_URL` | Optional socket base URL. Falls back to the API base URL when omitted. |
| `VITE_FIREBASE_API_KEY` | Firebase web API key. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain. |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID. |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase storage bucket. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging sender ID. |
| `VITE_FIREBASE_APP_ID` | Firebase app ID. |
| `VITE_FIREBASE_VAPID_KEY` | Web push VAPID key for notifications. |

## Project Structure

```text
src/
  App.tsx                         Route-level app shell
  MapShell.tsx                    Toast/auth providers around map/admin app
  MapApp.tsx                      Main map/admin data orchestration
  components/                     Public UI, landing page, map controls
  components/admin/               Admin workspace pages and shared admin UI
  context/                        Toasts and admin auth context
  core/                           Map layers, routing, navigation, geometry helpers
  services/                       API clients, cache helpers, events, Firebase
  store/                          Zustand app store
  config/                         Client and API configuration
  modules/                        Search and reporting modules
```

## API Integration

The app reads its API base from `src/config/api.ts`. Development defaults to `/api/v1` (Vite proxies to `localhost:5000`). **Production requires `VITE_API_BASE_URL`** in your host environment. `vercel.json` in this repo is an example proxy only.

Important public API areas used by the web app:

- `GET /api/v1/health`
- `GET /api/v1/map/geojson`
- `GET /api/v1/map/routing`
- `GET /api/v1/map/routing-weights`
- `GET /api/v1/locations`
- `GET /api/v1/power/recent`
- `POST /api/v1/power/report`
- `GET /api/v1/notifications/config`
- `GET /api/v1/notifications/events`

Admin pages use authenticated `/api/v1/admin/*` endpoints.

## Configuration

Campus identity, map defaults, theme colors, feature flags, and offline behavior are configured in `src/config/client.ts`. The current campus ID is `achievers-uni-owo`.

## Deployment

```bash
npm run build
```

Deploy the generated `dist/` directory. Service workers and web push require HTTPS in production.

# Daily Drive by IBM Bob — Container + Web UI Plan

## Top-Level Overview

**Goal:** Transform Daily Drive from a CLI tool into a fully containerized web application that runs on a Synology NAS. The web UI (branded "Daily Drive by IBM Bob") guides users through first-time Spotify setup, hosts configuration, and runs the playlist refresh on a configurable schedule — all inside a Red Hat UBI-based container.

**Scope:**
- Dockerfile using Red Hat UBI 9 minimal base image
- `/data` volume mount for all persistent state (token, config, state, logs)
- All Spotify credentials and settings via environment variables (no config.yaml baked in)
- Express-based Web UI served from the container (port configurable via env var)
- In-container cron/scheduler that refreshes the playlist on a configurable interval (default: 1× per day)
- Automatic Spotify token refresh before expiry (already partially implemented in index.js — extend to run as background daemon)
- Setup wizard for first-time OAuth (replaces CLI setup.js flow — OAuth redirect URI configurable via env var)
- Config editor page for all parameters
- Branding: IBM Bob logo from `img/bob/`, footer crediting original author

**Design Decisions confirmed:**
- UI language: **German + English, switchable** (language toggle in header, stored in localStorage)
- Setup wizard auto-detects server URL and pre-fills `SPOTIFY_REDIRECT_URI` suggestion
- Bob (`bob-standing-BECrMjXJ.webp`) used **prominently** in setup wizard as guide character; `ibm-bob.webp` logo in **shared header on all pages**
- Page backgrounds: **black** (`#000000` / `#161616`)

**Non-Goals:**
- Multi-user support
- Remote Spotify Premium account management
- Kubernetes/Helm packaging (NAS Docker Compose only)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Container (ubi9-minimal + Node.js)                  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Web Server  (server.js — Express, port WEB_PORT)     │  │
│  │                                                       │  │
│  │  GET  /              → Dashboard / status             │  │
│  │  GET  /setup         → OAuth wizard (step 1-3)        │  │
│  │  GET  /callback      → OAuth redirect handler         │  │
│  │  GET  /config        → Config editor form             │  │
│  │  POST /config        → Save config to /data           │  │
│  │  POST /refresh       → Manual playlist refresh        │  │
│  │  GET  /logs          → Recent log output              │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Scheduler (node-cron)                                │  │
│  │  Interval: REFRESH_INTERVAL_HOURS (default: 24)       │  │
│  │  → Calls main() from index.js                        │  │
│  │  → Token auto-refresh before each run                │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                             │
│  /data  (volume mount)                                      │
│    ├── config.yaml          (written by web UI)             │
│    ├── .spotify-token.json  (written by OAuth callback)     │
│    ├── state.json           (written by index.js)           │
│    └── logs/                (daily log files)               │
└─────────────────────────────────────────────────────────────┘
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WEB_PORT` | `8080` | Port the web UI listens on |
| `SPOTIFY_CLIENT_ID` | — | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | — | Spotify app client secret |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8080/callback` | OAuth redirect URI (must match Spotify Dashboard) |
| `REFRESH_INTERVAL_HOURS` | `24` | How often to refresh the playlist (hours) |
| `DATA_DIR` | `/data` | Path to persistent volume inside container |

---

## Sub-Tasks

---

### Sub-Task 1 — Refactor config & path resolution for container

**Status:** [x] done

**Intent:**
Update `index.js`, `setup.js`, and related modules so all file paths (`config.yaml`, `.spotify-token.json`, `state.json`) read from `DATA_DIR` env var (default `/data`). Credentials (client_id, client_secret, redirect_uri) are read from environment variables and merged with any values found in `config.yaml`. This makes the app work identically whether run locally (CLI) or inside the container.

**Expected Outcomes:**
- `index.js` reads token and state from `DATA_DIR`
- `index.js` merges env var credentials with config file (env vars take precedence)
- `setup.js` writes token to `DATA_DIR/.spotify-token.json`
- All file paths are resolved relative to `DATA_DIR`, not `__dirname`

**Todo List:**
1. Add a `paths.js` helper that exports resolved paths for `CONFIG_FILE`, `TOKEN_FILE`, `STATE_FILE`, `LOG_DIR` — all based on `process.env.DATA_DIR ?? '/data'`, falling back to local directory for non-container use
2. Update `index.js` to import from `paths.js` and merge env vars into config at load time
3. Update `setup.js` to use `paths.js` for token write path
4. Ensure `config.yaml` is optional when all required env vars are present

**Relevant Context:**
- `index.js`: `loadConfig()` line 38, `loadToken()` line 50, `loadState()` line 69 — hardcoded filenames
- `setup.js`: `TOKEN_FILE` constant line ~20, `CONFIG_FILE` constant line ~18
- Env vars to support: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `DATA_DIR`

---

### Sub-Task 2 — Build the Express Web Server (server.js)

**Status:** [x] done

**Intent:**
Create a new `server.js` that is the container entrypoint. It serves the Web UI, handles the OAuth callback (replacing `setup.js`'s one-shot server), and exposes a `/refresh` endpoint for manual playlist updates. The existing `index.js` main logic is imported as a module and called on demand.

**Expected Outcomes:**
- `server.js` starts Express on `WEB_PORT` (default 8080)
- Routes: `/`, `/setup`, `/callback`, `/config` (GET + POST), `/refresh` (POST), `/logs`
- OAuth flow works end-to-end via the browser (no CLI interaction needed)
- Config form saves to `/data/config.yaml`
- Existing `index.js` logic callable as `await runRefresh()` from server routes

**Todo List:**
1. Create `server.js` as the new main entrypoint
2. Add route `GET /` — Dashboard: shows setup status (token present? config complete?), last run time, next scheduled run, recent log tail; redirects to `/setup` if not configured
3. Add route `GET /setup` — Multi-step wizard page: Step 1 (Spotify app instructions + credential form), Step 2 (enter playlist ID + podcasts), Step 3 (OAuth button → Spotify authorize URL); show Bob logo prominently
4. Add route `GET /callback` — Handle Spotify OAuth redirect: exchange code for tokens, save to `/data/.spotify-token.json`, redirect to `/` with success message
5. Add route `GET /config` — Config editor: pre-filled form with all current config values
6. Add route `POST /config` — Validate and write updated `config.yaml` to `/data/`
7. Add route `POST /refresh` — Trigger `runRefresh()` immediately, return JSON status
8. Add route `GET /logs` — Stream or return last N lines from `/data/logs/`
9. Export `main()` from `index.js` as `runRefresh()` so it can be called programmatically
10. Wire up `node-cron` scheduler in `server.js` using `REFRESH_INTERVAL_HOURS`

**Relevant Context:**
- `setup.js`: OAuth exchange logic (lines 80-110) — reuse in `/callback` handler
- `index.js` `main()` function (line 447) — export and call from server
- Express already a dependency in `package.json`
- Add `node-cron` dependency for scheduling

---

### Sub-Task 3 — Build the Web UI (HTML/CSS/JS templates)

**Status:** [x] done

**Intent:**
Create a clean, IBM-branded web interface using server-side rendered HTML (EJS or plain HTML templates served by Express). The UI features the IBM Bob logo, the "Daily Drive by IBM Bob" name, a first-time setup wizard, a config editor, a dashboard with status, and a footer crediting IBM Bob and the original author.

**Expected Outcomes:**
- All pages share a common layout with IBM Bob logo in the header and branded footer
- Setup wizard clearly guides through Spotify app creation, config entry, and OAuth authorization
- Config page shows all parameters in a readable form with helpful descriptions
- Dashboard shows current status at a glance (configured, last refresh, next refresh, playlist link)
- Pages are clean and mobile-friendly (basic responsive CSS, no heavy frameworks)
- Bob's images (`img/bob/ibm-bob.webp`, `img/bob/bob-standing-BECrMjXJ.webp`) are used in the UI
- Footer: "Created with IBM Bob · Original project by [author link]"

**Todo List:**
1. Add EJS (`ejs`) as a dependency for server-side templating
2. Create `views/layout.ejs` — shared header on **all pages**: IBM Bob logo (`ibm-bob.webp`) left, "Daily Drive by IBM Bob" title center, language toggle (DE/EN) right; black background (`#161616`) throughout
3. Create `public/i18n/de.json` and `public/i18n/en.json` — all UI strings in both languages; client-side JS switches language via localStorage
4. Create `views/index.ejs` — Dashboard: setup checklist, last run time, next run, manual refresh button, playlist deep-link; black background
5. Create `views/setup.ejs` — Three-step wizard with Bob (`bob-standing-BECrMjXJ.webp`) displayed **prominently** as a guide character alongside each step:
   - Step 1: Instructions for creating Spotify app + credential input; auto-detect server URL and pre-fill `SPOTIFY_REDIRECT_URI` suggestion (e.g. `http://<detected-host>:PORT/callback`)
   - Step 2: Playlist ID, podcasts configuration
   - Step 3: "Authorize with Spotify" button (large, prominent CTA)
6. Create `views/config.ejs` — Full config editor: all parameters in a form (Spotify credentials, playlist, podcasts, music sources, mix pattern, refresh interval)
7. Create `views/logs.ejs` — Log viewer: last 100 lines with auto-refresh
8. Create `public/style.css` — Black background (`#000000`/`#161616`), IBM Blue accent (`#0f62fe`), white text, Bob branding, responsive grid
9. Create `public/lang.js` — Client-side language switcher: reads `localStorage.lang`, applies `data-i18n` attributes, renders DE/EN toggle button in header
10. Copy `img/bob/` assets to `public/img/bob/` so they are served as static files
11. Add "Credits" section to footer and `/setup` page: "Created with IBM Bob · Original project by [author link]"

**Relevant Context:**
- Bob images: `img/bob/ibm-bob.webp` (main logo), `img/bob/bob-standing-BECrMjXJ.webp` (wizard illustration)
- Original repo author: visible in README.md / package.json
- IBM Design color tokens: `#0f62fe` (IBM Blue 60), `#161616` (background), `#f4f4f4` (light)

---

### Sub-Task 4 — Dockerfile and Docker Compose

**Status:** [x] done

**Intent:**
Package the application as a production-ready container image using Red Hat UBI 9 minimal as the base. The container runs as a non-root user, exposes the web port, and expects a `/data` volume mount for persistence.

**Expected Outcomes:**
- `Dockerfile` builds successfully using `registry.redhat.io/ubi9/nodejs-20-minimal` (or `ubi9/ubi-minimal` + Node.js install)
- Container runs as non-root user (`uid 1001`)
- `/data` directory created with correct permissions in image
- `docker-compose.yml` for Synology NAS deployment: maps volume, exposes port, sets all env vars
- `.dockerignore` excludes `node_modules`, `config.yaml`, `.spotify-token.json`, `state.json`, `.env`, `img/` (assets are copied into public/ during build)
- Image starts `server.js` (not `index.js`) as the entrypoint

**Todo List:**
1. Create `Dockerfile`:
   - `FROM registry.redhat.io/ubi9/nodejs-20-minimal:latest`
   - `WORKDIR /app`
   - Copy `package*.json` and run `npm ci --omit=dev`
   - Copy application source
   - Copy `img/bob/` → `public/img/bob/`
   - Create `/data` directory, set ownership to uid 1001
   - `USER 1001`
   - `EXPOSE $WEB_PORT` (default 8080)
   - `CMD ["node", "server.js"]`
2. Create `.dockerignore`: exclude `node_modules`, secrets, runtime data files
3. Create `docker-compose.yml`:
   - Service: `dailydrive`
   - Image: `dailydrive:latest` (build from local Dockerfile)
   - Ports: `8080:8080` (or configurable)
   - Volumes: `./data:/data`
   - Environment: all env vars with sensible defaults / comments
   - Restart policy: `unless-stopped`
4. Create `nas-deployment.example.yaml` — ready-to-use Synology NAS deployment template:
   - Full Docker Compose v3 syntax compatible with Synology Container Manager
   - All environment variables listed with inline comments explaining each one
   - Volume path examples for Synology (`/volume1/docker/dailydrive/data:/data`)
   - Port mapping with comment to adjust if 8080 is taken
   - Instructions as YAML comments at the top: how to copy, fill in credentials, deploy via Container Manager
   - Note about `SPOTIFY_REDIRECT_URI` needing to match Spotify Dashboard exactly
5. Update `package.json` scripts: add `"start:server": "node server.js"` as the container start command
6. Add `node-cron` and `ejs` to `package.json` dependencies

**Relevant Context:**
- Security rules: must use `registry.redhat.io` image, non-root user, no `0.0.0.0` binding without explicit intent (web UI does bind to all interfaces intentionally inside Docker)
- `DATA_DIR` env var = `/data` inside container
- All secrets via env vars — nothing baked into image

---

### Sub-Task 5 — Token auto-refresh daemon + scheduler integration

**Status:** [x] done

**Intent:**
Ensure the Spotify access token is always valid by running a background refresh check on a short interval (e.g., every 30 minutes). The scheduler in `server.js` also handles the daily/configurable playlist refresh. This replaces the current "check at run time" approach with a proactive daemon.

**Expected Outcomes:**
- A background interval in `server.js` checks token expiry every 30 minutes and refreshes proactively if expiring within 10 minutes
- The `REFRESH_INTERVAL_HOURS` env var controls how often the full playlist refresh runs
- The dashboard shows "Token valid until: ..." and "Next refresh: ..."
- No manual intervention needed once token is obtained via setup wizard

**Todo List:**
1. Extract `refreshTokenIfNeeded()` from `index.js` into `paths.js` or a new `token-manager.js` module so it can be shared by both `index.js` and `server.js`
2. In `server.js`, start a `setInterval` that calls `refreshTokenIfNeeded()` every 30 minutes
3. Add a `getTokenStatus()` helper that returns `{ valid: bool, expiresAt: Date, refreshToken: bool }` for dashboard display
4. Wire `node-cron` schedule in `server.js`: `REFRESH_INTERVAL_HOURS` → cron expression (e.g., `24` → `0 4 * * *`; use simple interval with `node-cron` or `setInterval`)
5. Log each scheduled refresh and token refresh to `/data/logs/`

**Relevant Context:**
- `index.js` `refreshTokenIfNeeded()` lines 103-122 — extract this function
- Token file: `/data/.spotify-token.json` (via `paths.js`)
- `server.js` will be the long-running process; `index.js` main() called as a library

---

### Sub-Task 6 — Update README and add NAS deployment guide

**Status:** [x] done

**Intent:**
Update the README to document the new container-based deployment path, environment variables, Docker Compose usage on Synology, and how the web UI replaces the CLI setup flow.

**Expected Outcomes:**
- README has a new "Container Deployment (NAS / Docker)" section
- Documents all env vars, volume mount, port mapping
- Step-by-step Synology NAS setup (Container Manager / Docker Compose)
- Web UI setup wizard flow documented with screenshots placeholder
- Original CLI workflow preserved in a "CLI / Advanced" section

**Todo List:**
1. Add "Container Deployment (NAS / Docker)" section to `README.md`:
   - Docker Compose quickstart (3 commands: clone → fill env vars → `docker compose up -d`)
   - Reference to `nas-deployment.example.yaml` with instructions
   - Screenshot placeholders for web UI setup wizard steps
2. Document all environment variables in a clear table with descriptions, defaults, and required/optional flags
3. Add Synology NAS step-by-step section:
   - How to open Container Manager
   - How to import the compose file
   - How to set the volume path (`/volume1/docker/dailydrive/data`)
   - How to find the NAS IP for `SPOTIFY_REDIRECT_URI`
   - How to open the web UI and run the setup wizard
4. Note that `SPOTIFY_REDIRECT_URI` must match exactly what is registered in Spotify Developer Dashboard
5. Update `AGENTS.md` and `CLAUDE.md` / `GEMINI.md` to reflect the new container architecture, `server.js` entrypoint, `paths.js` module, and `nas-deployment.example.yaml`
6. Add prominent credits section at the bottom of `README.md`: IBM Bob logo reference, link to IBM Bob, credit to original project author
7. Preserve all existing CLI / advanced usage documentation in a collapsible section or clearly marked "Advanced / CLI" subsection

**Relevant Context:**
- `README.md` — existing CLI documentation to preserve
- `docker-compose.yml` — created in Sub-Task 4

---

## Implementation Order

```
Sub-Task 1  →  Sub-Task 2  →  Sub-Task 3
     ↓               ↓               ↓
 (paths/config)  (server.js)    (HTML/CSS)
                     ↓
              Sub-Task 4 (Dockerfile)
                     ↓
              Sub-Task 5 (token daemon)
                     ↓
              Sub-Task 6 (README)
```

Sub-Tasks 2 and 3 can be developed in parallel; Sub-Task 4 depends on both being complete.

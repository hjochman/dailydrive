# Changelog

All notable changes to Daily Drive by IBM Bob are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.2] — Stability fixes: timer leak, playlist fetch, healthcheck, log rotation

### Fixed
- **Timer accumulation / event loop degradation (Cookie mode)** — every per-request `CookieSpotifyClient` called `initialize()` which called `startDaemon()`, registering a new `setInterval` every 30 minutes. After ~1 hour of use these accumulated timers saturated the event loop, causing the server to become unresponsive. The Healthcheck then failed three times and Docker restarted the container (visible only as "container unexpectedly stopped"). Fix: `initialize()` now accepts `{ daemon: false }` — all short-lived route clients pass this flag. All route handlers also call `client.stopDaemon()` in a `finally` block for explicit cleanup.
- **`OAuthSpotifyClient.getPlaylistItems()` returned 0 tracks** — Spotify changed the response shape of `/v1/playlists/{id}/items`: the item now lives in `entry.item` (not `entry.track`). The old code read `entry.track` which is now `null` for all entries, so every playlist appeared empty. Fixed to `entry.item || entry.track || entry.episode` for full backward compatibility.
- **Docker Healthcheck pointed at `/api/status`** — that route does `fs.readFileSync` and `getAppStatus()` I/O; under load it could itself time out and trigger spurious restarts. Healthcheck now targets the new `/api/health` route.
- **Log files grew indefinitely** — `logLine()` appended to a new file each day but never cleaned up old ones. Added `pruneOldLogs(retainDays=7)` which deletes log files older than 7 days; runs once at server start and daily at midnight via `node-cron`.

### Added
- **`GET /api/health`** — new minimal liveness endpoint, returns `{ ok: true }` with no I/O. Used exclusively by the Docker `HEALTHCHECK` in `Dockerfile`, `docker-compose.yml`, and `nas-deployment.example.yaml`.
- **`SpotifyClientBase.stopDaemon()`** — no-op base implementation so `client.stopDaemon()` is safe to call on any client type (OAuth or Cookie) without a type check.
- **Debug/warn logging in `getPlaylistItems()`** — logs raw item count from API vs. filtered count; emits a `[WARN]` when items arrive but none pass the filter (helps diagnose future Spotify API shape changes).

### Changed
- **Genre search log level** — `genre:X → N results` promoted from `debug` to `info` so it appears in default log output.
- `Dockerfile`, `docker-compose.yml`, `nas-deployment.example.yaml` — Healthcheck URL changed from `/api/status` to `/api/health`.
- `package.json` version bumped to `2.1.2`.

---

## [2.1.1] — Cookie Mode: Fix played-state detection

### Fixed
- **`newest_unplayed` / `oldest_unplayed` modes never skipped played episodes in Cookie mode** — `CookieSpotifyClient.getShowEpisodes()` extracted play state from `ep.resumePoint` and `ep.playbackState`, but Spotify's Pathfinder `queryPodcastEpisodes` response uses a different field: `ep.playedState`. As a result `fully_played` was always `null`, and since `!null === true` every episode appeared unplayed, making skip filtering a no-op.
- Corrected field name: `ep.playedState.state` is now read and mapped — `"COMPLETED"` → `fully_played: true`; `"IN_PROGRESS"` or `"NOT_STARTED"` → `fully_played: false`.
- Corrected resume position field: `ep.playedState.playPositionMilliseconds` (flat, not nested) is now used for `resume_position_ms`.
- Debug log now also dumps `playedState` alongside `resumePoint`/`playbackState`/`duration` for easier future diagnosis.

### Notes
- Confirmed Pathfinder `playedState` values via live API inspection: `"NOT_STARTED"`, `"IN_PROGRESS"`, `"COMPLETED"`.
- `IN_PROGRESS` episodes (partially listened) are treated as **unplayed** — correct behaviour, they have not been finished.
- `resumePoint` / `playbackState` extraction paths are retained as fallbacks for schema resilience.

---

## [2.1.0] — Dual-Backend Spotify Client

### Added
- **Dual-backend Spotify API layer** — all Spotify calls are now routed through an abstract `SpotifyClientBase` interface with two interchangeable implementations
- **`OAuthSpotifyClient`** (`spotify-client-oauth.js`) — encapsulates the existing OAuth 2.0 flow with `spotify-web-api-node`; `TokenManager` is now a private concern of the client, not imported externally
- **`CookieSpotifyClient`** (`spotify-client-cookie.js`) — new backend that requires only a Spotify username and password (no Developer App / `client_id` / `client_secret` needed); uses TOTP-based internal token retrieval from `open.spotify.com/api/token` and Spotify's internal Pathfinder GraphQL API (`api-partner.spotify.com/pathfinder/v2/query`)
- **`spotify-client-factory.js`** — `createSpotifyClient(mode, creds)` factory instantiates the correct client based on `api_mode` in config
- **`spotify-client-base.js`** — abstract base class with all 17 interface methods, `NotSupportedError`, and `SpotifyQuotaError` (moved from `index.js`)
- **`api_mode` config field** — `"oauth"` (default, all features) or `"cookie"` (no Developer App required, playlist cover image not supported)
- **Cookie-mode credentials** in `config.yaml` — `spotify.username` / `spotify.password` (git-ignored, env-var overrides `SPOTIFY_USERNAME` / `SPOTIFY_PASSWORD`)
- **`.cookie-session.json`** in `DATA_DIR` — persists TOTP session tokens (access token, client token, query hashes); auto-refreshed every 30 minutes; added to `.gitignore`
- **`userTopContent` Pathfinder operation** implemented in `CookieSpotifyClient` — provides `getMyTopTracks()` and `getMyTopArtists()` without OAuth (operation was already registered in the SpotAPI-async-v2 reference library but not yet implemented there)
- **Setup Wizard — API mode selection** in Step 1: radio-card choice between "OAuth (recommended)" and "Spotify Account (Cookie)"; Step 2 (OAuth authorization) is skipped in Cookie mode
- **Config page — API Mode section**: dropdown to switch backends, inline Cookie credentials fields, warning banner when Cover Image is unavailable in Cookie mode
- New CSS classes in `public/style.css`: `.mode-selector`, `.mode-option`, `.mode-card`, `.step-pill.skipped`

### Changed
- `index.js` no longer imports `spotify-web-api-node` or `token-manager` directly; all API calls go through `createSpotifyClient()` + `client.initialize()`
- `server.js` no longer instantiates `SpotifyWebApi` per-route; all routes use `createClient(config, creds)` helper; Token Daemon start moved into `OAuthSpotifyClient.startDaemon()`
- `paths.js` — `resolveSpotifyCredentials()` now also returns `username`, `password`, and `api_mode`
- `SpotifyQuotaError` moved from `index.js` to `spotify-client-base.js` (re-exported for backward compatibility)
- OAuth-specific routes (`/setup/authorize`, `/callback`, `/reauth`) now return `400` when `api_mode` is `"cookie"`
- `POST /api/create-playlist` gracefully skips `setPlaylistCoverImage` in Cookie mode (`NotSupportedError` is caught and logged, playlist is still created)
- `config.example.yaml` updated with `api_mode` field and documented `spotify.username` / `spotify.password` (commented out)
- `package.json` version bumped to `2.1.0`

---

## [2.0.0] — Web UI Release

### Added
- Full Docker-based **Web UI** (Express + EJS) — no more CLI-only workflow
- **Setup Wizard** (3-step OAuth flow) at `/setup` — guided Spotify app creation and token authorisation
- **Config editor** at `/config` — edit all settings via browser form
- **Dashboard** at `/` — live status, token validity, next refresh countdown, current playlist view
- **Log viewer** at `/logs` — live server-side log tail
- **About page** at `/about` — version, credits and tech stack info
- IBM Bob **standing illustration** as centered banner below the topbar
- Slide-in **navigation drawer** (hamburger button) — works identically on desktop and mobile
- **Sticky topbar** with hamburger, site title and language switcher
- Footer link to [IBM Bob](https://www.ibm.com/products/ibm-bob)
- **i18n** — full German / English UI toggle (`public/lang.js` + `public/i18n/`)
- IBM Design Language **dark theme** (`public/style.css`)
- **Spotify search & library picker** modals for podcast and playlist selection
- `server.js` — container entrypoint with `node-cron` scheduler and token refresh daemon
- `token-manager.js` — shared background Spotify token refresh daemon
- `paths.js` — centralised path and credential resolution
- Red Hat UBI9 minimal container image (`Dockerfile`, `docker-compose.yml`)
- `nas-deployment.example.yaml` — fully commented Synology NAS deployment template
- **Spotify 429 rate-limit handling** — `SpotifyQuotaError` class propagates `Retry-After` from the API response
- **Quota warning banner** in all pages when Spotify rate-limit is active, showing cooldown end time (DE/EN)
- **Quota retry timer** — one-shot scheduler fires 10 min after cooldown ends if no regular cron slot falls earlier
- Dashboard **"Rate limited" badge** on the token status indicator while quota is active
- Dashboard **last-refresh error indicator** — red timestamp with hover tooltip showing the error message
- Dashboard setup checklist is now **hidden once setup is complete** (all four conditions met)
- Dashboard **"Refresh now" button disabled** while rate-limit is active
- **Genre Auto-Detect** button in the Config page Music section — fetches the user's Spotify top tracks and artists server-side, builds a ready-to-copy LLM prompt, and presents it in a modal; the user pastes it into any AI assistant (ChatGPT, Claude, Gemini, Copilot, …) and pastes the result back to apply genres directly to the config form (replace or merge, with sanitization of stray special characters)
- `GET /api/taste-prompt` endpoint — returns a fully-formed LLM prompt built from the user's Spotify taste data (top tracks + artists across all three time ranges)

### Changed
- Playlist item writes now use `PUT /v1/playlists/{id}/items` (replaces deprecated `/tracks` endpoint)
- Source-playlist reads use direct `fetch()` against `/items` (avoids 403 from `getPlaylistTracks()`)
- `package.json` version bumped to `2.0.0`
- Scheduled and manual refresh both **skip** execution while Spotify rate-limit cooldown is active
- Dashboard live Spotify fetch **skipped** while rate-limited (prevents cascading 429 errors)
- Setup-checklist i18n keys `dash_check_credentials` / `dash_check_token` shortened to `Login` / `Token`
- `getAppStatus()` now includes `quotaActive` and `quotaRetryAfter` fields
- `render()` helper injects `quotaActive` / `quotaRetryAfter` into every layout render
- `SpotifyQuotaError` exported from `index.js` and imported in `server.js`
- `_lastRefreshError` tracked in `server.js` and passed to dashboard template

---

## [1.0.0] — Initial CLI Release

> Original project by [patdeg](https://github.com/patdeg/dailydrive). This fork is maintained at [hjochman/dailydrive](https://github.com/hjochman/dailydrive).

### Added
- Core playlist builder logic (`index.js`) — interleaves podcast episodes with music tracks
- Configurable **mix pattern** (e.g. `PMMM`) with pinned first-position episodes
- Music sources: **top tracks**, **genre search**, **source playlists**
- Automatic **50/50 split** between familiar and discovery tracks when genres are configured
- State cache (`state.json`) — skips update when podcast episodes have not changed
- Spotify **OAuth 2.0** setup flow (`setup.js`) — token persisted to `.spotify-token.json`
- Auto-refresh of Spotify access token before expiry
- **Taste profile** LLM helper (`taste-profile.js`) — detects genre tags via Demeterics API
- Google Gemini taste profile alternative (`taste-profile-google.js`)
- YAML-based config (`config.yaml`) with full documented example (`config.example.yaml`)
- `.gitignore` protecting secrets for public repository use
- `README.md` with setup instructions, config schema and common tasks

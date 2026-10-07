# Daily Drive by IBM Bob — AI Assistant Guide

This file helps AI coding assistants (Claude Code, Gemini, Copilot, etc.) understand and work with this project. If a user asks you to help them set up Daily Drive, follow the setup workflow below.

## What This Project Does

Recreates Spotify's discontinued "Daily Drive" feature — a playlist that mixes podcast episodes and music tracks, updated automatically on a schedule. Runs as a **Docker container on a Synology NAS** (or any Linux machine), with a full **IBM Bob-branded Web UI** for setup and configuration.

## Tech Stack

- **Runtime:** Node.js (v24+)
- **Container:** Red Hat UBI9 (`registry.access.redhat.com/ubi9/nodejs-24-minimal`)
- **Web Framework:** Express + EJS templates
- **Spotify Library:** `spotify-web-api-node` — wraps the official Spotify Web API (OAuth mode only)
- **Config:** YAML via `js-yaml`, written by web UI to `/data/config.yaml`
- **Auth:** Two backends — OAuth 2.0 (token in `/data/.spotify-token.json`) or Cookie/TOTP mode (session in `/data/.cookie-session.json`)
- **Scheduling:** `node-cron` inside `server.js` (configurable via `REFRESH_INTERVAL_HOURS`)
- **i18n:** DE/EN switchable via `public/lang.js` + `public/i18n/{de,en}.json`

## Project Structure

```
server.js                    — Container entrypoint: Express web server + scheduler + token daemon
index.js                     — Playlist builder logic (exported as module, also runnable as CLI)
paths.js                     — Centralised path & credential resolution (DATA_DIR, env vars)
token-manager.js             — Spotify token refresh daemon (internal to OAuthSpotifyClient)
spotify-client-base.js       — Abstract SpotifyClientBase interface, NotSupportedError, SpotifyQuotaError
spotify-client-oauth.js      — OAuthSpotifyClient: OAuth 2.0 backend via spotify-web-api-node
spotify-client-cookie.js     — CookieSpotifyClient: TOTP/Pathfinder backend, no Developer App needed
spotify-client-factory.js    — createSpotifyClient(mode, creds) — selects backend from config.api_mode
setup.js                     — Legacy CLI OAuth setup (still works for headless/advanced use)
taste-profile.js             — LLM-powered genre detection via Demeterics API
taste-profile-google.js      — LLM-powered genre detection via Google Gemini
test-cover-upload.js         — Diagnostic script: tests cookie-mode cover image upload end-to-end
views/                       — EJS templates for the Web UI
  layout.ejs                 — Shared header (IBM Bob logo, nav, DE/EN toggle), footer
  index.ejs                  — Dashboard
  setup.ejs                  — Setup wizard (OAuth or Cookie mode, Bob as guide character)
  config.ejs                 — Config editor (incl. API mode selector)
  logs.ejs                   — Log viewer
  about.ejs                  — About page
  reauth.ejs                 — Re-authentication page (token expired flow)
public/                      — Static assets
  style.css                  — IBM dark theme (black bg, IBM Blue #0f62fe)
  lang.js                    — Client-side DE/EN language switcher
  site.webmanifest           — PWA manifest
  i18n/de.json               — German UI strings
  i18n/en.json               — English UI strings
  img/bob/                   — IBM Bob logo and standing illustration
  img/playlist-cover.jpg     — Default playlist cover image (used when creating a new playlist)
  img/dailydrive.jpg         — Daily Drive hero image
  img/favicon-*.png          — Favicons (16×16, 32×32, 192, 512, apple-touch-icon)
config.example.yaml          — Config template (for CLI usage)
Dockerfile                   — Red Hat UBI9 (nodejs-24-minimal) container image, non-root uid 1001
docker-compose.yml           — Local development compose file
nas-deployment.example.yaml  — Synology NAS deployment template (fully commented)
package.json                 — Dependencies and npm scripts
.dockerignore                — Excludes secrets/data from Docker build context
.gitignore                   — Comprehensive protection for secrets (PUBLIC REPO)
```

## Key Commands

```bash
npm install             # Install dependencies
npm run start:server    # Start the web server (container mode)
npm run setup           # Legacy CLI OAuth setup (headless/advanced)
npm start               # CLI playlist builder (direct, no web server)
npm test                # Dry run (shows what would happen without changing the playlist)
npm run taste           # Auto-detect genre tags via LLM (requires DEMETERICS_API_KEY in .env)

# Docker
docker compose up -d --build   # Build and start container
docker compose logs -f         # Follow container logs
docker compose down            # Stop container
```

## Setup Workflow (for AI assistants helping users)

When a user asks you to help set up Daily Drive, **prefer the container/web UI path** for NAS users, or the CLI path for advanced users.

### Container / Web UI path — OAuth mode (recommended, all features)
1. User creates Spotify app at https://developer.spotify.com/dashboard
   - **Redirect URI:** `http://<NAS-IP>:8080/callback` (use the NAS's actual LAN IP)
   - **APIs:** Check both **Web API** and **Web Playback SDK**
   - **User Management:** Add Spotify email (even as app owner) — otherwise 403 Forbidden
2. Copy `nas-deployment.example.yaml` to `docker-compose.yml`, fill in `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`
3. Run `docker compose up -d --build`
4. Open `http://<NAS-IP>:8080` → Setup Wizard → choose **OAuth** → 3 steps (Credentials → Authorize → Playlist)

### Container / Web UI path — Cookie mode (no Developer App needed)
1. Copy `nas-deployment.example.yaml` to `docker-compose.yml` (no credential env vars needed)
2. Run `docker compose up -d --build`
3. Open `http://<NAS-IP>:8080` → Setup Wizard → choose **Spotify Account (Cookie)**
4. Enter Spotify username + password → Step 2 (OAuth) is skipped → Step 3: select playlist

### CLI / headless path (advanced, OAuth only)
1. Create Spotify app with **Redirect URI:** `http://127.0.0.1:8080/callback` (or 8888 if using old setup.js)
2. Set env vars OR create `config.yaml` from `config.example.yaml`
3. If on SSH/headless: `ssh -L 8080:127.0.0.1:8080 user@server`
4. Run `npm run setup` — legacy CLI flow
5. Token saved to `DATA_DIR/.spotify-token.json`

### Authentication
- **OAuth mode:** handled by web UI Setup Wizard at `/setup`, or `npm run setup` for CLI
- **Cookie mode:** handled by web UI Setup Wizard at `/setup` (choose Cookie option); session saved to `DATA_DIR/.cookie-session.json`

### Test and Run
- `npm test` — dry run to verify everything works
- `npm start` — actually update the playlist
- If 403 Forbidden (OAuth): check User Management in Dashboard, re-run `npm run setup`

## IMPORTANT: Security (Public Repo)

This is a PUBLIC repository. The `.gitignore` is comprehensive but verify:
- **NEVER** commit `config.yaml` (contains client_id, client_secret, and in Cookie mode: username/password)
- **NEVER** commit `.spotify-token.json` (contains OAuth access/refresh tokens)
- **NEVER** commit `.cookie-session.json` (contains TOTP session tokens)
- **NEVER** commit `.env` or any `*credentials*` / `*secret*` files
- **NEVER** commit `state.json` (runtime data)
- Before any commit, run `git status` and verify no sensitive files are staged
- If a user pastes credentials in chat, remind them this goes in config.yaml (git-ignored), not in any tracked file

## How the Code Works

### Spotify Client Architecture (v2.1)

All Spotify API calls are routed through the abstract `SpotifyClientBase` interface in `spotify-client-base.js`. Two implementations exist:

- **`OAuthSpotifyClient`** (`spotify-client-oauth.js`) — uses `spotify-web-api-node` + `token-manager.js`. Instantiated when `api_mode: oauth`.
- **`CookieSpotifyClient`** (`spotify-client-cookie.js`) — uses TOTP-based token from `open.spotify.com/api/token` and Spotifys internal Pathfinder GraphQL (`api-partner.spotify.com/pathfinder/v2/query`). No Developer App required. Instantiated when `api_mode: cookie`.

The factory `createSpotifyClient(mode, creds)` in `spotify-client-factory.js` selects the right implementation. Both `index.js` and `server.js` call `createSpotifyClient()` — they never import `SpotifyWebApi` or `token-manager` directly.

### Authentication Flows

**OAuth mode (setup.js / Setup Wizard):**
1. Deletes any existing `.spotify-token.json` for clean auth
2. Reads Spotify credentials from `config.yaml`
3. Starts Express server on `127.0.0.1:8888`
4. Generates Spotify auth URL with required scopes
5. User approves in browser → Spotify redirects with auth code
6. Exchanges code for access + refresh tokens
7. Saves tokens to `.spotify-token.json`

**Cookie mode (Setup Wizard only):**
1. User enters Spotify username + password in the Setup Wizard
2. `CookieSpotifyClient.initialize()` fetches `open.spotify.com` HTML, extracts JS bundle URLs
3. JS bundles are parsed to extract Pathfinder operation SHA-256 hashes
4. TOTP code is computed (ported from SpotAPI-async-v2 `totp.py`) and sent to `open.spotify.com/api/token`
5. Access token + client token are obtained; session cached in `.cookie-session.json`
6. Auto-refresh runs every 30 minutes via `setInterval`

### Required Scopes (OAuth mode)
```
playlist-modify-public
playlist-modify-private
playlist-read-private
playlist-read-collaborative
user-library-read
user-read-private
user-read-recently-played
user-top-read
ugc-image-upload
```

### Playlist Building Flow (index.js)
1. Reads `api_mode` from config, calls `createSpotifyClient()`, calls `client.initialize()`
2. Fetches latest episodes for each podcast via `client.getShowEpisodes()` — returns `uri`, `name`, `fully_played`, `resume_position_ms`, `duration_ms`
   - Mode `newest` (default): fetches the N most recent episodes, no play-state check
   - Mode `newest_unplayed`: scans up to `scan_limit` (default 50) episodes, picks the N most recent ones not yet fully played; stops early once enough are found
   - Mode `oldest_unplayed`: same scan, but picks the N oldest unplayed episodes (useful for catching up in order)
   - Falls back to newest episodes if no unplayed episodes are found
   - **Cookie mode play-state source:** `ep.playedState.state` — values are `"NOT_STARTED"`, `"IN_PROGRESS"` (both → `fully_played: false`), `"COMPLETED"` (→ `fully_played: true`). Resume position comes from `ep.playedState.playPositionMilliseconds` (flat field).
   - **OAuth Dev Mode:** does not return resume/play-state data → `newest_unplayed`/`oldest_unplayed` downgrade to `newest` with a log warning
3. Checks state cache — skips update if episodes haven't changed
4. Fetches music from top tracks (`client.getMyTopTracks()`), source playlists (`client.getPlaylistItems()`), and/or genre search (`client.searchTracks()`)
5. Separates pinned episodes (`position: first`) from mixable episodes
6. Places pinned episodes first, then interleaves rest using `mix_pattern`
7. Replaces playlist content via `client.replacePlaylistItems()` / `client.addPlaylistItems()`
8. Saves state to `state.json`

### Mix Pattern Logic
Pattern string like `"PMMMM"` where P = podcast, M = music. The pattern repeats cyclically. Pinned episodes (`position: first`) are placed before the pattern starts. When one content type runs out, remaining items of the other type are appended.

### Music Sources and 50/50 Split
Three sources can be combined:
- **Top tracks:** `getMyTopTracks()` with configurable `time_range` (short/medium/long term)
- **Genre search:** `searchTracks()` with `genre:` queries
- **Source playlists:** fetched via `/v1/playlists/{id}/items` endpoint (direct fetch, not the library's `getPlaylistTracks()` which hits the deprecated `/tracks` endpoint)

When genres are configured alongside top tracks/playlists, the script automatically splits `total_songs` **50/50**: half familiar (top tracks + playlists), half discovery (genre search). This ensures each refresh has a mix of comfort and novelty. Discovery tracks are deduplicated against familiar tracks.

### Taste Profile (taste-profile.js)
Fetches user's top tracks/artists across all time ranges, sends them to an LLM via the Demeterics API (`https://api.demeterics.com/chat/v1/chat/completions`), and writes the returned genre tags into `config.yaml`. Uses the `DEMETERICS_API_KEY` from `.env`.

Demeterics key modes:
- **BYOK (default):** Store vendor keys in Settings > Provider Keys on demeterics.ai, or use dual-key format: `dmt_YOUR_KEY;sk-YOUR_VENDOR_KEY`
- **Managed Key:** Demeterics provides vendor keys. Requires whitelisted access — email sales@demeterics.com

## Spotify API Endpoints Used

### OAuth mode (via `spotify-web-api-node` + direct `fetch()`)
- `GET /v1/shows/{id}/episodes` — latest podcast episodes
- `GET /v1/me/top/tracks` — user's most-played tracks
- `GET /v1/search` — genre-based track discovery
- `GET /v1/playlists/{id}/items` — tracks/episodes from playlists (replaces `/tracks` which returns 403 since Feb 2026)
- `PUT /v1/playlists/{id}/items` — replace playlist contents
- `POST /v1/playlists/{id}/items` — add tracks (for batches > 100)
- `PUT /v1/playlists/{id}/images` — upload playlist cover image (requires `ugc-image-upload` scope); body is base64-encoded JPEG string
- `POST /api/token` — refresh OAuth token

### Cookie mode (via Pathfinder GraphQL + spclient)
- `GET https://open.spotify.com/api/token` — TOTP-based access token
- `POST https://clienttoken.spotify.com/v1/clienttoken` — client token
- `POST https://api-partner.spotify.com/pathfinder/v2/query` — all data queries (podcasts, tracks, playlists, search, user profile, top content)
- `POST https://spclient.wg.spotify.com/playlist/v2/playlist` — create playlist
- `POST https://spclient.wg.spotify.com/playlist/v2/playlist/{id}/changes` — update existing playlist attributes (name, description, picture)
- `POST https://spclient.wg.spotify.com/playlist/v2/user/{username}/rootlist/changes` — add playlist to user's library
- `POST https://image-upload.spotify.com/v4/playlist?playlist_id={id}` — **Step 1** of cover image upload: send raw JPEG binary → returns `{ uploadToken: "<hex32>.<ts>.<sha256>" }`
- `POST https://spclient.wg.spotify.com/playlist/v2/playlist/{id}/register-image` — **Step 2**: send `{ uploadToken }` with `Accept: application/json` → returns `{ "picture": "<base64 bytes>" }` — triggers Spotify's CDN pipeline
- `POST https://spclient.wg.spotify.com/playlist/v2/playlist/{id}/changes` — **Step 3**: `UPDATE_LIST_ATTRIBUTES` with `{ values: { picture: "<base64 from step 2>" }, noValue: [] }` — registers picture on playlist metadata

> **Cover image upload in cookie mode uses a three-step flow** (reverse-engineered from Spotify Web Player `hW`/`hY`/`hz` functions):
> 1. `POST image-upload.spotify.com/v4/playlist?playlist_id={id}` with raw JPEG body → `{ uploadToken }`
> 2. `POST spclient/playlist/v2/playlist/{id}/register-image` with `{ uploadToken }` + `Accept: application/json` → `{ "picture": "<base64>" }` — triggers CDN pipeline. The base64 value is the raw image-hash bytes (decodes to `ab67706c0000da84…`).
> 3. `POST spclient/playlist/v2/playlist/{id}/changes` with `UPDATE_LIST_ATTRIBUTES { values: { picture: "<base64 from step 2>" }, noValue: [] }` — the `picture` field **must be the raw base64 string from step 2**, NOT decoded to hex. Without this step the image never appears in clients.
>
> **Why not `POST /v1/playlists/{id}/images`?** Returns HTTP 429 immediately for cookie-mode tokens.
>
> **Why not just `/changes` alone with the hex-32 upload prefix?** That silently accepts but CDN never serves it (stays 404). Only `/register-image` triggers Spotify's image processing pipeline.
>
> This is implemented in `CookieSpotifyClient.setPlaylistCoverImage()`.

## Config Schema (config.yaml)

```yaml
api_mode: string        # "oauth" (default) | "cookie"

spotify:
  # OAuth mode fields (required when api_mode: oauth):
  client_id: string       # From Spotify Developer Dashboard
  client_secret: string   # From Spotify Developer Dashboard
  redirect_uri: string    # Must be http://127.0.0.1:8888/callback
  # Cookie mode fields (required when api_mode: cookie):
  sp_dc: string        # Spotify cookie value

playlist_id: string       # Target playlist to populate

podcasts:                 # Array of podcast sources
  - name: string          # Display name
    id: string            # Spotify show ID
    episodes: number      # How many recent episodes (default: 1)
    position: string      # Optional: "first" to pin at start of playlist
    mode: string          # Optional: "newest" (default) | "newest_unplayed" | "oldest_unplayed"
                          # newest_unplayed/oldest_unplayed: Cookie mode only — OAuth silently falls back to "newest"
    scan_limit: number    # Optional: max episodes to scan for unplayed modes (default: 50)

music:
  top_tracks:             # Pull from user's most-played songs
    enabled: boolean
    time_range: string    # "short_term" | "medium_term" | "long_term"
    count: number         # Fetch pool size (default: 30)
  genres:                 # Genre-based discovery via search
    - string              # e.g., "pop", "edm", "indie pop"
  playlists:              # Pull from existing playlists
    - name: string
      id: string
  total_songs: number     # Total songs to include (default: 15)
  shuffle: boolean        # Shuffle songs (default: true)

mix_pattern: string       # e.g., "PMMMM" (default: "PMMM")

schedule:
  times:                  # Array of HH:MM strings (used by systemd timer)
    - string
  timezone: string        # IANA timezone
```

## Common Tasks for AI Assistants

### "Add multiple playlist targets"
- Change `playlist_id` to an array of `playlists` in config
- Loop over them in `main()`, each can have its own podcasts/music/pattern

### "Add a new Spotify API method"
- Add the method signature + JSDoc to `SpotifyClientBase` in `spotify-client-base.js`
- Implement it in `OAuthSpotifyClient` (via `spotify-web-api-node` or direct `fetch()`)
- Implement it in `CookieSpotifyClient` (via `pathfinderQuery()` or spclient)
- If only available in one mode, throw `NotSupportedError` in the other implementation

### "Switch from OAuth to Cookie mode"
- In the Web UI: Config → API Mode → select "Spotify Account (Cookie)" → re-run Setup Wizard
- In `config.yaml`: set `api_mode: cookie`, add `spotify.username` and `spotify.password`
- Delete `.spotify-token.json` if switching away from OAuth (optional, harmless if left)

## Spotify API Restrictions (as of March 2026)

- **Dev Mode requires Premium** and limits to **5 authorized users** per Client ID
- **User Management** — must add yourself in Dashboard even as app owner
- `/v1/playlists/{id}/tracks` — **returns 403 Forbidden** for both reads and writes; use `/v1/playlists/{id}/items` instead. The `spotify-web-api-node` library's `getPlaylistTracks()` still hits the old endpoint — use direct `fetch()` with `/items` instead
- `/v1/recommendations` endpoint — **REMOVED** (Nov 2024 deprecated, Feb 2026 removed)
- `/artists/{id}/top-tracks` — **REMOVED** (Feb 2026)
- Audio features (valence, energy, danceability) — **DEPRECATED** (Nov 2024)
- Artist genre tags — **empty in Dev Mode** (not usable for genre detection)
- `http://localhost` redirect URIs — **NO LONGER ALLOWED** (Nov 2025), must use `http://127.0.0.1`
- Implicit grant flow — **REMOVED** (Nov 2025)
- `getArtists()` bulk endpoint — **FORBIDDEN** in Dev Mode
- Search results capped at 10 per query in Dev Mode

## Gotchas

- Spotify tokens expire after 1 hour, but the script auto-refreshes them using the refresh token (OAuth) or TOTP re-fetch (Cookie)
- Refresh tokens can eventually expire after months of inactivity — user must re-run `npm run setup` (OAuth) or re-authenticate via Setup Wizard (Cookie)
- `setup.js` deletes any existing token before starting OAuth to ensure fresh scopes
- The `/items` endpoint accepts both `spotify:track:` and `spotify:episode:` URIs
- Spotify API rate limit is generous for personal use but can hit 429 with rapid calls
- Podcast episode IDs change with each new episode — always fetch fresh
- State caching prevents unnecessary updates when episodes haven't changed — delete `state.json` to force
- NPR News Now and similar hourly news podcasts publish episodes that **expire on Spotify within hours**. If the playlist isn't refreshed frequently enough, these episodes show as unavailable. Consider running more often than twice daily if using such podcasts
- Cookie mode: Pathfinder `queryPodcastEpisodes` returns play state in `ep.playedState` — **not** `ep.resumePoint` or `ep.playbackState` (those are absent). Shape: `{ state: "NOT_STARTED"|"IN_PROGRESS"|"COMPLETED", playPositionMilliseconds: number }`. Only `"COMPLETED"` sets `fully_played: true`; `"IN_PROGRESS"` is treated as unplayed (not finished).
- Cookie mode: Pathfinder query hashes are extracted from Spotify's JS bundles and cached in `.cookie-session.json`. If Spotify deploys a new bundle, the hashes are re-extracted automatically on the next initialize
- Cookie mode: `setPlaylistCoverImage()` uses a **three-step flow** — (1) upload raw JPEG → `image-upload.spotify.com/v4/playlist` → `uploadToken`; (2) `POST spclient/playlist/v2/playlist/{id}/register-image` with `{ uploadToken }` + `Accept: application/json` → `{ "picture": "<base64>" }` (triggers CDN pipeline); (3) `POST spclient/playlist/v2/playlist/{id}/changes` with `UPDATE_LIST_ATTRIBUTES { values: { picture: "<base64 from step 2>" }, noValue: [] }` — `picture` must be the **raw base64 string**, NOT decoded hex. All three steps are required; skipping step 3 means the image is processed but never shown in clients.
- `test-cover-upload.js` — standalone diagnostic script for debugging cookie-mode cover image upload; run with `node test-cover-upload.js <playlistId>`

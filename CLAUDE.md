# Daily Drive by IBM Bob — AI Assistant Guide

This file helps AI coding assistants (Claude Code, Gemini, Copilot, etc.) understand and work with this project. If a user asks you to help them set up Daily Drive, follow the setup workflow below.

## What This Project Does

Recreates Spotify's discontinued "Daily Drive" feature — a playlist that mixes podcast episodes and music tracks, updated automatically on a schedule. Runs as a **Docker container on a Synology NAS** (or any Linux machine), with a full **IBM Bob-branded Web UI** for setup and configuration.

## Tech Stack

- **Runtime:** Node.js (v20+)
- **Container:** Red Hat UBI9 (`registry.redhat.io/ubi9/nodejs-20-minimal`)
- **Web Framework:** Express + EJS templates
- **Spotify Library:** `spotify-web-api-node` — wraps the Spotify Web API
- **Config:** YAML via `js-yaml`, written by web UI to `/data/config.yaml`
- **Auth:** OAuth 2.0 via web browser (Setup Wizard in web UI), token persisted in `/data/.spotify-token.json`
- **Scheduling:** `node-cron` inside `server.js` (configurable via `REFRESH_INTERVAL_HOURS`)
- **i18n:** DE/EN switchable via `public/lang.js` + `public/i18n/{de,en}.json`

## Project Structure

```
server.js             — Container entrypoint: Express web server + scheduler + token daemon
index.js              — Playlist builder logic (exported as module, also runnable as CLI)
paths.js              — Centralised path & credential resolution (DATA_DIR, env vars)
token-manager.js      — Spotify token refresh daemon (shared by server.js and index.js)
setup.js              — Legacy CLI OAuth setup (still works for headless/advanced use)
taste-profile.js      — LLM-powered genre detection via Demeterics API
taste-profile-google.js — LLM-powered genre detection via Google Gemini
views/                — EJS templates for the Web UI
  layout.ejs          — Shared header (IBM Bob logo, nav, DE/EN toggle), footer
  index.ejs           — Dashboard
  setup.ejs           — 3-step OAuth wizard (Bob as guide character)
  config.ejs          — Config editor
  logs.ejs            — Log viewer
public/               — Static assets
  style.css           — IBM dark theme (black bg, IBM Blue #0f62fe)
  lang.js             — Client-side DE/EN language switcher
  i18n/de.json        — German UI strings
  i18n/en.json        — English UI strings
  img/bob/            — IBM Bob logo and standing illustration
config.example.yaml   — Config template (for CLI usage)
Dockerfile            — Red Hat UBI9 container image, non-root uid 1001
docker-compose.yml    — Local development compose file
nas-deployment.example.yaml — Synology NAS deployment template (fully commented)
package.json          — Dependencies and npm scripts
.dockerignore         — Excludes secrets/data from Docker build context
.gitignore            — Comprehensive protection for secrets (PUBLIC REPO)
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

### Container / Web UI path (recommended)
1. User creates Spotify app at https://developer.spotify.com/dashboard
   - **Redirect URI:** `http://<NAS-IP>:8080/callback` (use the NAS's actual LAN IP)
   - **APIs:** Check both **Web API** and **Web Playback SDK**
   - **User Management:** Add Spotify email (even as app owner) — otherwise 403 Forbidden
2. Copy `nas-deployment.example.yaml` to `docker-compose.yml`, fill in `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`
3. Run `docker compose up -d --build`
4. Open `http://<NAS-IP>:8080` → Setup Wizard guides through the rest (3 steps, Spotify OAuth in browser)

### CLI / headless path (advanced)
1. Create Spotify app with **Redirect URI:** `http://127.0.0.1:8080/callback` (or 8888 if using old setup.js)
2. Set env vars OR create `config.yaml` from `config.example.yaml`
3. If on SSH/headless: `ssh -L 8080:127.0.0.1:8080 user@server`
4. Run `npm run setup` — legacy CLI flow
5. Token saved to `DATA_DIR/.spotify-token.json`

### 3. OAuth Authentication
- Container: handled by web UI Setup Wizard at `/setup`
- CLI legacy: `npm run setup` prints URL, user approves in browser

### 4. Test and Run
- `npm test` — dry run to verify everything works
- `npm start` — actually update the playlist
- If 403 Forbidden: check User Management in Dashboard, re-run `npm run setup`

## IMPORTANT: Security (Public Repo)

This is a PUBLIC repository. The `.gitignore` is comprehensive but verify:
- **NEVER** commit `config.yaml` (contains client_id, client_secret)
- **NEVER** commit `.spotify-token.json` (contains access/refresh tokens)
- **NEVER** commit `.env` or any `*credentials*` / `*secret*` files
- **NEVER** commit `state.json` (runtime data)
- Before any commit, run `git status` and verify no sensitive files are staged
- If a user pastes credentials in chat, remind them this goes in config.yaml (git-ignored), not in any tracked file

## How the Code Works

### Authentication Flow (setup.js)
1. Deletes any existing `.spotify-token.json` for clean auth
2. Reads Spotify credentials from `config.yaml`
3. Starts Express server on `127.0.0.1:8888`
4. Generates Spotify auth URL with required scopes
5. User approves in browser → Spotify redirects with auth code
6. Exchanges code for access + refresh tokens
7. Saves tokens to `.spotify-token.json`

### Required Scopes
```
playlist-modify-public
playlist-modify-private
playlist-read-private
playlist-read-collaborative
user-library-read
user-read-private
user-read-recently-played
user-top-read
```

### Playlist Building Flow (index.js)
1. Loads config and tokens
2. Auto-refreshes access token if expiring within 5 minutes
3. Fetches latest episodes for each podcast via `getShowEpisodes()`
4. Checks state cache — skips update if episodes haven't changed
5. Fetches music from top tracks, source playlists, and/or genre search
6. Separates pinned episodes (`position: first`) from mixable episodes
7. Places pinned episodes first, then interleaves rest using `mix_pattern`
8. Replaces playlist content via `PUT /v1/playlists/{id}/items`
9. Saves state to `state.json`

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

- `GET /v1/shows/{id}/episodes` — latest podcast episodes
- `GET /v1/me/top/tracks` — user's most-played tracks
- `GET /v1/search` — genre-based track discovery
- `GET /v1/playlists/{id}/items` — tracks/episodes from playlists (replaces `/tracks` which returns 403 since Feb 2026)
- `PUT /v1/playlists/{id}/items` — replace playlist contents
- `POST /v1/playlists/{id}/items` — add tracks (for batches > 100)
- `POST /api/token` — refresh OAuth token

## Config Schema (config.yaml)

```yaml
spotify:
  client_id: string       # From Spotify Developer Dashboard
  client_secret: string   # From Spotify Developer Dashboard
  redirect_uri: string    # Must be http://127.0.0.1:8888/callback

playlist_id: string       # Target playlist to populate

podcasts:                 # Array of podcast sources
  - name: string          # Display name
    id: string            # Spotify show ID
    episodes: number      # How many recent episodes (default: 1)
    position: string      # Optional: "first" to pin at start of playlist

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

### "Add a web UI"
- Express is already a dependency
- Add routes for config editing and manual trigger
- Serve a simple HTML page with forms

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

- Spotify tokens expire after 1 hour, but the script auto-refreshes them using the refresh token
- Refresh tokens can eventually expire after months of inactivity — user must re-run `npm run setup`
- `setup.js` deletes any existing token before starting OAuth to ensure fresh scopes
- The `/items` endpoint accepts both `spotify:track:` and `spotify:episode:` URIs
- Spotify API rate limit is generous for personal use but can hit 429 with rapid calls
- Podcast episode IDs change with each new episode — always fetch fresh
- State caching prevents unnecessary updates when episodes haven't changed — delete `state.json` to force
- NPR News Now and similar hourly news podcasts publish episodes that **expire on Spotify within hours**. If the playlist isn't refreshed frequently enough, these episodes show as unavailable. Consider running more often than twice daily if using such podcasts

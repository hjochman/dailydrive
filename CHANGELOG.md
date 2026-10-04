# Changelog

All notable changes to Daily Drive by IBM Bob are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Changed
- Playlist item writes now use `PUT /v1/playlists/{id}/items` (replaces deprecated `/tracks` endpoint)
- Source-playlist reads use direct `fetch()` against `/items` (avoids 403 from `getPlaylistTracks()`)
- `package.json` version bumped to `2.0.0`

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

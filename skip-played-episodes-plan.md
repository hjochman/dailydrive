# Plan: Skip Already-Played Podcast Episodes

## Overview

Add an opt-in feature that filters out already-listened podcast episodes when building the Daily Drive playlist. Controlled per podcast via `skip_played: true` in `config.yaml`. When all fetched episodes are already played, the system automatically fetches more (up to 3× the configured limit) and filters again, so the user always gets fresh content.

A toggle checkbox is added to the per-podcast entry in the Web UI Config editor, next to the existing episode count field.

**Scope:**
- `spotify-client-oauth.js` — extract `resume_point` fields from `/v1/shows/{id}/episodes`
- `spotify-client-cookie.js` — extract `resumePoint` fields from Pathfinder `queryPodcastEpisodes`
- `spotify-client-base.js` — update JSDoc interface contract
- `index.js` — filtering logic in `fetchPodcastEpisodes()`
- `views/config.ejs` — per-podcast toggle checkbox in UI
- `server.js` — parse new `podcast_skip_played[]` field from POST body
- `public/i18n/en.json` + `public/i18n/de.json` — i18n strings
- `config.example.yaml` + `AGENTS.md` — documentation

**Not in scope:** State caching of played status (always live from API), UI changes outside the config page.

---

## Sub-Tasks

---

### Sub-Task 1 — Extend both Spotify clients to return `fully_played`, `resume_position_ms`, and `duration_ms`

**Intent:**  
Both `getShowEpisodes()` implementations currently strip all fields except `uri` and `name`. The Spotify REST endpoint (`/v1/shows/{id}/episodes`) returns a `resume_point` object per episode with `fully_played` and `resume_position_ms`. The Pathfinder response likely contains `resumePoint` in camelCase. `duration_ms` is also available and needed for the >90% heuristic. All three fields must be passed through in both clients.

**Expected Outcomes:**
- `getShowEpisodes()` in `spotify-client-oauth.js` also returns `fully_played`, `resume_position_ms`, and `duration_ms` (all nullable)
- `getShowEpisodes()` in `spotify-client-cookie.js` also returns these fields from `ep.resumePoint?.fullyPlayed`, `ep.resumePoint?.resumePositionAsMilliseconds` (or similar camelCase field), and `ep.duration?.totalMilliseconds` or `ep.durationMs` — defaulting to `null` if absent
- `spotify-client-base.js` JSDoc documents these as optional fields: `fully_played?: boolean | null`, `resume_position_ms?: number | null`, `duration_ms?: number | null`
- No changes to callers — the new fields are additive and ignored unless `skip_played` is set

**Todo List:**
1. In `spotify-client-oauth.js` → `getShowEpisodes()`: extend `.map()` to also extract:
   - `fully_played: ep.resume_point?.fully_played ?? null`
   - `resume_position_ms: ep.resume_point?.resume_position_ms ?? null`
   - `duration_ms: ep.duration_ms ?? null`
2. In `spotify-client-cookie.js` → `getShowEpisodes()`: extend `.map()` to also extract from the `ep` object:
   - `fully_played: ep.resumePoint?.fullyPlayed ?? null`
   - `resume_position_ms: ep.resumePoint?.resumePositionAsMilliseconds ?? null` (inspect actual field name — may also be `ep.resumePoint?.position?.milliseconds` or similar)
   - `duration_ms: ep.duration?.totalMilliseconds ?? ep.durationMs ?? null`
   - If the raw `ep` object doesn't contain these fields at all: **do not silently return `null`** — instead, stop and ask the user how to proceed (e.g. use a separate Pathfinder operation, fall back to a recently-played query, or accept that cookie mode cannot support this feature)
3. In `spotify-client-base.js`: update the `@returns` JSDoc comment for `getShowEpisodes()` to include the three new optional fields

**Relevant Context:**
- `spotify-client-oauth.js` → `OAuthSpotifyClient.getShowEpisodes()` (around line 120)
- `spotify-client-cookie.js` → `CookieSpotifyClient.getShowEpisodes()` (around line 768); raw ep is at `item.entity?.data || item.data || item`
- `spotify-client-base.js` → JSDoc for `getShowEpisodes()` (around line 65)
- Spotify REST API: `/v1/shows/{id}/episodes` → each item has `resume_point: { fully_played: bool, resume_position_ms: number }` and `duration_ms: number`
- Pathfinder GraphQL uses camelCase naming throughout the codebase

**Status:** [ ] pending

---

### Sub-Task 2 — Add skip-played filtering logic in `fetchPodcastEpisodes()`

**Intent:**  
When a podcast config entry has `skip_played: true`, filter out episodes that have been fully or mostly listened to. If the initial fetch doesn't yield enough unplayed episodes, retry with a larger limit (3×) to get more candidates.

**Expected Outcomes:**
- Episodes with `fully_played === true` are excluded when `podcast.skip_played === true`
- Episodes where >`90%` has been played are also excluded (using `resume_position_ms / duration_ms`)
- If `duration_ms` is `null`, fall back to `fully_played` only (no crash)
- When the filtered count is below the required `count`, a second fetch with `limit = count * 3` is attempted, then re-filtered, then the first `count` unplayed episodes are taken
- Log output clearly shows how many episodes were skipped: `🎙️  Skipped N already-played episode(s) from: <name>`
- If still not enough episodes after the extended fetch, use what's available (no error — just a log warning)
- Feature is fully inactive when `skip_played` is not set or `false`

**Todo List:**
1. In `index.js` → `fetchPodcastEpisodes()` (around line 113), after the `getShowEpisodes()` call and before pushing to `episodes`, add:
   - A helper `isPlayed(ep)` function (or inline logic): returns `true` if `ep.fully_played === true` OR (`ep.resume_position_ms != null && ep.duration_ms != null && ep.resume_position_ms / ep.duration_ms > 0.9`)
   - Gate the logic on `podcast.skip_played === true`
   - If `skip_played` is set: filter `items` using `isPlayed()`, log skipped count
   - If filtered result length < `count`: re-fetch with `limit = count * 3`, re-filter, then slice to `count`
   - Log a warning if still below `count` after extended fetch
2. Ensure the `count * 3` re-fetch is only triggered once (no recursion)

**Relevant Context:**
- `index.js` → `fetchPodcastEpisodes()` (around line 113–146)
- `podcast.skip_played` will be a new config field (added in Sub-Task 3)
- Sub-Task 1 must be completed first

**Status:** [ ] pending

---

### Sub-Task 3 — Add `skip_played` toggle to the Web UI Config editor

**Intent:**  
Users should be able to enable `skip_played` per podcast directly in the config UI, next to the existing episode count input — consistent with how other per-podcast options (like episode count) are presented.

**Expected Outcomes:**
- Each podcast entry in the config editor has a "Skip played" checkbox next to the episode count field
- The checkbox is pre-checked if `p.skip_played === true` in the current config
- On save, the server parses `podcast_skip_played[]` from the POST body and sets `pod.skip_played = true/false` accordingly
- i18n strings added for DE and EN
- Config editor looks and behaves consistently with existing UI patterns (`.checkbox-row`, `accent-color: var(--accent)`, same grid layout as the episode count)

**Todo List:**
1. In `views/config.ejs`: inside the podcast `.item-entry.draggable` block, add a new `<div class="form-group">` containing:
   - A `<div class="checkbox-row">` with:
     - `<input type="checkbox" name="podcast_skip_played[]" value="1" <%= p.skip_played ? 'checked' : '' %>>`
     - `<label data-i18n="config_podcast_skip_played">Skip played</label>`
   - Place it after the episode count field, before the remove button
2. In `server.js` → podcast POST parsing (around line 962): add:
   - `const podSkipPlayed = [].concat(b.podcast_skip_played || b["podcast_skip_played[]"] || []);`
   - In the `podIds.forEach()` loop: `pod.skip_played = podSkipPlayed[i] === "1";`
   - **Note:** Unchecked checkboxes are NOT submitted in HTML forms. This means `podSkipPlayed[i]` will be `undefined` for unchecked entries. Handle by defaulting to `false`.
     - The correct approach: checkboxes in arrays are tricky — use a parallel hidden `<input type="hidden" name="podcast_skip_played_present[]" value="0">` trick, OR simply treat any missing index as `false`. Verify how existing checkbox arrays (if any) handle this — may need a different approach.
     - Alternatively: use the index from the `podIds` array (already length-known) and check if `podSkipPlayed` contains a "1" at that position; since unchecked boxes don't POST, this won't work directly. **Recommended:** add a hidden `<input type="hidden" name="podcast_skip_played[]" value="0">` before each checkbox so all positions are always submitted, and the checkbox value overrides it.
3. In `public/i18n/en.json`: add `"config_podcast_skip_played": "Skip played"` and `"config_podcast_skip_played_hint": "Skip episodes you have already listened to"`
4. In `public/i18n/de.json`: add `"config_podcast_skip_played": "Gehörte überspringen"` and `"config_podcast_skip_played_hint": "Bereits gehörte Folgen überspringen"`

**Relevant Context:**
- `views/config.ejs` → podcast `.item-entry.draggable` block (around line 148–163)
- `server.js` → podcast POST parsing block (around line 962–980)
- `public/i18n/en.json` and `public/i18n/de.json` — follow existing `config_podcast_*` naming convention
- The hidden-input trick for checkbox arrays is the standard HTML approach and is already needed here because unchecked checkboxes don't appear in POST data

**Status:** [ ] pending

---

### Sub-Task 4 — Update `config.example.yaml` and `AGENTS.md` documentation

**Intent:**  
Document the new `skip_played` field so users and AI assistants understand how to use it.

**Expected Outcomes:**
- `config.example.yaml` includes `skip_played: true` under a podcast entry with a comment
- `AGENTS.md` → Config Schema section documents `skip_played: boolean`
- `AGENTS.md` → Playlist Building Flow section mentions the skip-played filtering step

**Todo List:**
1. In `config.example.yaml`: add `skip_played: true  # Skip episodes already fully listened to (>90% played)` to the podcast entry example
2. In `AGENTS.md` → Config Schema `podcasts` section: add `skip_played: boolean  # Optional. Skip fully/mostly-played episodes (>90%). Default: false`
3. In `AGENTS.md` → Playlist Building Flow section: add a note after the episode-fetching step that `skip_played: true` triggers filtering and automatic limit expansion (3×)

**Relevant Context:**
- `config.example.yaml` — podcast array entry format
- `AGENTS.md` — Config Schema section

**Status:** [ ] pending

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Threshold for "played" | `fully_played === true` OR >90% played | Handles Spotify's inconsistent `fully_played` flag for long episodes |
| Fallback when all played | Fetch 3× limit, re-filter, take first N | Simple, no state caching needed, one extra API call at most |
| Cookie client data unavailable | Ask user how to proceed | Pathfinder may not expose resume data — explicit decision needed, not silent fallback |
| Config scope | Per-podcast, opt-in (`skip_played: true`) | Allows mixing skip-enabled and skip-disabled podcasts in same config |
| UI pattern | Checkbox in `.checkbox-row` next to episode count | Consistent with existing `podcast_alternate` checkbox pattern |
| Checkbox POST handling | Hidden input trick (value="0" before each checkbox) | Standard HTML approach; unchecked checkboxes don't POST |

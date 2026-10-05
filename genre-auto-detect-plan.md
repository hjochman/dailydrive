# Plan: Genre Auto-Detect Button (LLM Prompt Helper)

## Overview

Add a "🎵 Auto-Detect Genres" button to the Music section of the Config page.
When clicked, the app fetches the user's Spotify top tracks and artists (server-side),
builds a ready-to-use LLM prompt from that data, and presents it in a modal with
copy-to-clipboard functionality. The user pastes the prompt into any LLM of their choice
(ChatGPT, Claude, Gemini, Copilot, …), copies back the result, pastes it into the modal's
result field, and clicks "Apply" — which writes the genres directly into the genre input
field on the config form. No API key required. No LLM integration needed.

**Scope:** New API endpoint, a new modal in config.ejs, a button next to the genres field,
i18n strings (EN + DE), minimal CSS additions.

---

## Sub-Task 1 — New API Endpoint: `/api/taste-prompt`

**Status:** [ ] pending

### Intent
Expose a new GET endpoint that fetches the user's top tracks and top artists from Spotify
across all three time ranges (short/medium/long term), builds the LLM prompt string, and
returns it as JSON. This keeps all Spotify API calls server-side, consistent with the
existing `/api/user-playlists` and `/api/user-podcasts` pattern.

### Expected Outcomes
- `GET /api/taste-prompt` returns `{ prompt: "..." }` with the full LLM prompt text.
- Returns `401` if the user is not authenticated (no token).
- Returns `500` with `{ error: "..." }` on Spotify API failure.
- The prompt text contains the top 40 artists (ranked by frequency) and up to 50 unique tracks.
- The prompt instructs the LLM to return a comma-separated list of genres (easier for the
  user to paste directly into the genres field than YAML).

### Todo List
1. In `server.js`, add `app.get("/api/taste-prompt", async (req, res) => { ... })` after the
   existing `/api/search` route (around line 1037).
2. Follow the exact same auth pattern as `/api/user-playlists` (lines 924–958):
   `loadConfig()` → `resolveSpotifyCredentials()` → `tokenManager.refreshTokenIfNeeded()` →
   check token → create `SpotifyWebApi` instance → set access token.
3. Port the data-fetching logic from `taste-profile-google.js` lines 101–146:
   - Fetch top tracks across `["short_term", "medium_term", "long_term"]` (limit 50 each).
   - Fetch top artists across the same three ranges (limit 50 each).
   - Build `artistCounts` map, extract top 40 artists sorted by frequency.
   - Deduplicate tracks by `name|artist[0]` key, keep up to 50 unique.
4. Build the prompt string. The output format instruction asks the LLM to return
   **one genre per line** (clean, easy to read and paste). The `applyTasteGenres()`
   function in the frontend handles converting lines → comma-separated before writing
   to the genres input field.
5. Return `res.json({ prompt, artistCount: topArtists.length, trackCount: uniqueTracks.length })`.

### Relevant Context
- Auth pattern reference: `server.js` lines 924–958 (`/api/user-playlists`)
- Spotify data fetching reference: `taste-profile-google.js` lines 97–178
- Existing Spotify API methods available: `spotifyApi.getMyTopTracks()`, `spotifyApi.getMyTopArtists()`

---

## Sub-Task 2 — "Auto-Detect" Button and Modal in `config.ejs`

**Status:** [ ] pending

### Intent
Add a small "🎵 Auto-Detect" button next to the genre input field. Clicking it opens a
modal that: (1) shows a loading spinner while fetching the prompt from the new API endpoint,
(2) displays the ready-to-copy LLM prompt, (3) provides a result paste area with an "Apply"
button that copies the pasted genres into the genres input field.

### Expected Outcomes
- A "🎵 Auto-Detect" button appears below the genres input field in the Music card.
- Clicking it calls `/api/taste-prompt`, shows a spinner, then reveals the prompt.
- A "📋 Copy prompt" button copies the full prompt text to clipboard.
- A textarea allows the user to paste the LLM's genre output.
- An "Apply" button parses the pasted text and sets the `genres` input field value,
  then closes the modal.
- Pressing Escape or clicking the backdrop closes the modal.
- Error states (not authenticated, Spotify API error) are shown inline in the modal.

### Todo List
1. Add a "🎵 Auto-Detect" button in `views/config.ejs` directly below the genres `<input>`
   (after line 181), before the closing `</div>` of the `form-group`.
2. Add a new modal `<div id="taste-modal" class="modal">` after the existing
   `#spotify-picker` modal (after line 252). Structure:
   - Modal header with title and close button.
   - Step 1 area: Loading spinner (initially visible), then prompt display area (hidden
     until data loads) containing:
     - Instruction text (i18n).
     - `<textarea id="taste-prompt-text" readonly>` for the prompt.
     - "📋 Copy" button that calls `navigator.clipboard.writeText()`.
   - Step 2 area: Label + `<textarea id="taste-result-input">` for the user to paste
     the LLM output.
   - Two action buttons: **"Replace genres"** (overwrites existing genres field value)
     and **"Add to genres"** (appends to existing value, deduplicating).
   - "Cancel" button.
3. Add JavaScript functions in the `<script>` block:
   - `openTasteModal()` — fetches `/api/taste-prompt`, shows spinner, populates textarea.
   - `closeTasteModal()` — removes `show` class from `#taste-modal`.
   - `copyTastePrompt()` — copies `#taste-prompt-text` value to clipboard, briefly changes
     button label to "✓ Copied!".
   - `applyTasteGenres(mode)` — reads `#taste-result-input`, splits by newline (primary)
     then comma/semicolon (fallback), trims each item, filters empties, joins with `, `.
     - Sanitize each parsed item before use: strip any characters that are not
       letters, digits, spaces, or hyphens (removes stray `*`, `"`, `-` bullets,
       markdown formatting, etc.), then trim whitespace again.
     - Skip items that are empty after sanitization or longer than 40 characters
       (likely a full sentence, not a genre tag).
     - `mode === 'replace'`: sets the `genres` input field value directly.
     - `mode === 'add'`: reads existing genres field value, merges both lists,
       deduplicates (case-insensitive), joins with `, `, sets the field value.
     - Calls `closeTasteModal()` in both cases.
4. Add backdrop click handler: clicking outside `.modal-content` inside `#taste-modal`
   closes it (same pattern as existing picker if applicable, or add a simple onclick check).

### Relevant Context
- Genres input field: `views/config.ejs` line 180 — `<input type="text" name="genres" ...>`
- Existing modal pattern: `views/config.ejs` lines 222–252 (`#spotify-picker`)
- Existing modal CSS classes: `.modal`, `.modal-content`, `.modal-header`, `.modal-close`,
  `.picker-loading`, `.spinner`, `modal.show`
- `closePicker()` pattern for modal close: removes class `show` from modal div

---

## Sub-Task 3 — i18n Strings (EN + DE)

**Status:** [ ] pending

### Intent
Add all UI strings for the new modal and button to both `en.json` and `de.json` so the
existing language-switch system handles them automatically.

### Expected Outcomes
- All new UI text is covered by i18n keys.
- Both EN and DE translations are complete.
- Keys follow the existing naming convention (`config_` prefix for config-related strings).

### Todo List
1. Add the following keys to `public/i18n/en.json` (after the `config_genres_hint` key,
   around line 138):
   ```
   "config_genres_auto_detect": "🎵 Auto-Detect Genres"
   "taste_modal_title": "Auto-Detect Genres"
   "taste_modal_instruction": "Copy this prompt into any AI assistant (ChatGPT, Claude, Gemini, Copilot, …) and paste the result below."
   "taste_modal_copy": "📋 Copy prompt"
   "taste_modal_copied": "✓ Copied!"
   "taste_modal_result_label": "Paste the AI's genre list here"
   "taste_modal_result_placeholder": "synth pop, indie rock, electronic, ..."
   "taste_modal_apply_replace": "Replace genres"
   "taste_modal_apply_add": "Add to genres"
   "taste_modal_loading": "Loading your Spotify taste data…"
   "taste_modal_error_auth": "Not authenticated. Complete the Setup Wizard first."
   "taste_modal_error_generic": "Could not load taste data. Please try again."
   ```
2. Add the corresponding German translations to `public/i18n/de.json` (same position):
   ```
   "config_genres_auto_detect": "🎵 Genres automatisch erkennen"
   "taste_modal_title": "Genres automatisch erkennen"
   "taste_modal_instruction": "Kopiere diesen Prompt in einen KI-Assistenten deiner Wahl (ChatGPT, Claude, Gemini, Copilot, …) und füge das Ergebnis unten ein."
   "taste_modal_copy": "📋 Prompt kopieren"
   "taste_modal_copied": "✓ Kopiert!"
   "taste_modal_result_label": "KI-Ergebnis hier einfügen"
   "taste_modal_result_placeholder": "synth pop, indie rock, electronic, ..."
   "taste_modal_apply_replace": "Genres ersetzen"
   "taste_modal_apply_add": "Zu Genres hinzufügen"
   "taste_modal_loading": "Spotify-Geschmacksdaten werden geladen…"
   "taste_modal_error_auth": "Nicht authentifiziert. Bitte zuerst den Setup-Assistenten abschließen."
   "taste_modal_error_generic": "Daten konnten nicht geladen werden. Bitte erneut versuchen."
   ```

### Relevant Context
- `public/i18n/en.json` — `config_genres` at line 137, `config_genres_hint` at line 138
- `public/i18n/de.json` — same lines, same structure
- Language switch mechanism: `public/lang.js` reads `data-i18n` attributes at page load and on toggle

---

## Sub-Task 4 — CSS (if needed)

**Status:** [ ] pending

### Intent
Add minimal CSS for any new modal elements that are not already covered by the existing
`.modal` / `.picker-*` CSS classes. The existing modal infrastructure should cover most
styling — only gaps need to be filled.

### Expected Outcomes
- The taste modal renders consistently with the existing picker modal.
- The prompt textarea is readable, scrollable, and clearly distinct from the result textarea.
- The "Copy" and "Apply" buttons match the existing button style.

### Todo List
1. Check `public/style.css` for existing `.modal` and related styles.
2. If the readonly prompt textarea needs distinct visual treatment (e.g. slightly different
   background to signal "read-only / copy this"), add a small rule like
   `.taste-prompt-readonly { background: var(--bg2, #262626); color: var(--text-muted); font-family: monospace; font-size: 0.85rem; resize: vertical; }`.
3. No new modal infrastructure CSS needed — reuse `.modal`, `.modal-content`,
   `.modal-header`, `.modal-close`, `.btn`, `.btn-primary`, `.spinner`.

### Relevant Context
- `public/style.css` — existing modal and button styles

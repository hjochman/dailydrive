#!/usr/bin/env node
// =============================================================================
// Daily Drive — Main Script
// =============================================================================
// Builds your custom Daily Drive playlist by mixing podcasts and music.
// This recreates Spotify's discontinued "Daily Drive" feature.
//
// Usage:  npm start                  (full refresh — new music + podcasts)
//         npm test                   (dry run — shows what would happen)
//         node index.js --dry-run
//         node index.js --podcast-only  (hourly mode — fresh podcasts, reuses today's music)
// =============================================================================

// --- Node.js built-in modules ---
const fs = require("fs");

// --- Third-party libraries (installed via npm install) ---
const yaml = require("js-yaml");               // Parses YAML config files
const SpotifyWebApi = require("spotify-web-api-node"); // Wraps the Spotify Web API

// --- Centralised path & credential resolution ---
const { PATHS, resolveSpotifyCredentials } = require("./paths");
const TOKEN_FILE = PATHS.TOKEN_FILE;
const CONFIG_FILE = PATHS.CONFIG_FILE;
const STATE_FILE  = PATHS.STATE_FILE;

// Check command-line flags
const DRY_RUN = process.argv.includes("--dry-run");       // Shows what would happen without changing the playlist
const PODCAST_ONLY = process.argv.includes("--podcast-only"); // Hourly mode: only refresh podcasts, reuse saved music

// ---------------------------------------------------------------------------
// Logger — defaults to console, can be overridden by server.js via setLogger()
// ---------------------------------------------------------------------------
let log    = (...a) => console.log(...a);
let logErr = (...a) => console.error(...a);

// ---------------------------------------------------------------------------
// SpotifyQuotaError — thrown when Spotify returns 429 Too Many Requests.
// Carries the retryAfter value (seconds) from the Retry-After response header
// so callers can schedule the next attempt correctly.
// ---------------------------------------------------------------------------
class SpotifyQuotaError extends Error {
  constructor(retryAfterSeconds) {
    super(`Spotify rate limit hit — retry after ${retryAfterSeconds}s`);
    this.name = "SpotifyQuotaError";
    this.retryAfter = retryAfterSeconds; // seconds to wait
  }
}

function setLogger(fn) { log = fn; logErr = fn; }

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Loads and parses config.yaml (from DATA_DIR).
 * When SPOTIFY_CLIENT_ID is set via environment variable the config file is
 * optional — env vars take precedence over any values in the file.
 */
function loadConfig() {
  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    config = yaml.load(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } else if (!process.env.SPOTIFY_CLIENT_ID) {
    const msg = "config.yaml not found and SPOTIFY_CLIENT_ID env var is not set.";
    logErr("❌ " + msg);
    if (require.main === module) process.exit(1);
    throw new Error(msg);
  }

  // Merge env-var credentials (env vars take precedence over config file)
  const creds = resolveSpotifyCredentials(config.spotify || {});
  config.spotify = creds;
  return config;
}

// Token I/O and refresh delegated to token-manager.js
const tokenManager = require("./token-manager");

function loadToken() {
  const token = tokenManager.loadToken();
  if (!token) {
    const msg = "Not authenticated — please re-authorize via the web UI.";
    logErr("❌ " + msg);
    if (require.main === module) process.exit(1);
    throw new Error(msg);
  }
  return token;
}

function saveToken(tokenData) {
  tokenManager.saveToken(tokenData);
}

/**
 * Loads the state file that tracks which episodes were in the last playlist update.
 * Returns an empty object if the file doesn't exist or is corrupted.
 */
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Saves state to disk so the next run can compare episodes and skip if nothing changed.
 */
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Fisher-Yates shuffle — randomizes an array in-place.
 * Used to shuffle music tracks so the playlist feels fresh each time.
 */
function shuffle(array) {
  const arr = [...array]; // Create a copy so we don't modify the original
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]; // Swap elements
  }
  return arr;
}

/**
 * Refreshes the Spotify access token if expiring within 5 minutes.
 * Delegates to token-manager; then syncs the refreshed token into spotifyApi.
 */
async function refreshTokenIfNeeded(spotifyApi, token) {
  const updated = await tokenManager.refreshTokenIfNeeded(5 * 60 * 1000);
  if (updated && updated.access_token !== token.access_token) {
    token.access_token = updated.access_token;
    token.expires_at   = updated.expires_at;
    if (updated.refresh_token) token.refresh_token = updated.refresh_token;
    spotifyApi.setAccessToken(token.access_token);
  }
}

// =============================================================================
// Core Logic
// =============================================================================

/**
 * Fetches the latest episodes for each podcast listed in your config.
 * Returns an array of episode objects with uri, name, show name, and position.
 *
 * Note: Some podcasts (like NPR News Now) publish hourly episodes that expire
 * quickly on Spotify. If you see "[unavailable]" in your playlist, run the
 * script again to fetch the latest episode.
 */
async function fetchPodcastEpisodes(spotifyApi, podcasts) {
  const episodes = [];

  for (const podcast of podcasts) {
    // How many recent episodes to grab (default: 1, configurable per podcast)
    const count = podcast.episodes || 1;
    log(`🎙️  Fetching ${count} episode(s) from: ${podcast.name}`);

    try {
      // Ask Spotify for the most recent episodes of this show
      const data = await spotifyApi.getShowEpisodes(podcast.id, {
        limit: count,
        market: "US", // Required for episode availability
      });

      for (const episode of data.body.items) {
        episodes.push({
          uri: episode.uri,      // Spotify URI like "spotify:episode:abc123"
          name: episode.name,
          show: podcast.name,
          type: "episode",
          position: podcast.position || null, // "first" = pinned to top of playlist
        });
        log(`    📌 ${episode.name}`);
      }
    } catch (err) {
      // Don't crash if one podcast fails — just warn and continue with the rest
      logErr(`    ⚠️  Failed to fetch ${podcast.name}: ${err.message}`);
    }
  }

  return episodes;
}

/**
 * Fetches music tracks from two "familiar" sources:
 *   1. Source playlists — songs from playlists you specify in config.yaml
 *   2. Top tracks — your most-played songs on Spotify
 *
 * Tracks are shuffled and trimmed to the requested count.
 */
async function fetchMusicTracks(spotifyApi, musicConfig) {
  let allTracks = [];

  // --- Source 1: Pull tracks from user-specified playlists ---
  if (musicConfig.playlists) {
    for (const playlist of musicConfig.playlists) {
      // Skip placeholder entries from the example config
      if (!playlist.id || playlist.id === "your-playlist-id") continue;

      log(`🎵 Fetching songs from playlist: ${playlist.name}`);

      try {
        // Spotify returns max 100 items per request, so we paginate through
        // larger playlists by incrementing the offset
        const accessToken = spotifyApi.getAccessToken();
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          // IMPORTANT: We use the /items endpoint directly via fetch() because
          // the spotify-web-api-node library's getPlaylistTracks() still hits
          // the old /tracks endpoint, which Spotify deprecated in Feb 2026 and
          // now returns 403 Forbidden.
          const res = await fetch(
            `https://api.spotify.com/v1/playlists/${playlist.id}/items?limit=100&offset=${offset}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          }

          const data = await res.json();

          for (const entry of data.items) {
            // The /items endpoint returns the content in entry.item
            // Track detection: entry.item.track === true (not entry.item.type)
            const track = entry.item;
            if (track && track.uri && track.track === true) {
              allTracks.push({
                uri: track.uri,
                name: track.name,
                artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
                type: "track",
              });
            }
          }

          offset += 100;
          hasMore = offset < data.total;
        }

        log(
          `    Found ${allTracks.length} tracks so far`
        );
      } catch (err) {
        logErr(
          `    ⚠️  Failed to fetch playlist ${playlist.name}: ${err.message}`
        );
      }
    }
  }

  // --- Source 2: Pull from user's liked/saved songs ---
  if (musicConfig.saved_tracks && musicConfig.saved_tracks.enabled) {
    const count = musicConfig.saved_tracks.count || 50;
    log(`🎵 Fetching saved/liked tracks (up to ${count})...`);

    try {
      let offset = 0;
      let remaining = count;

      // Spotify returns max 50 saved tracks per request, so paginate if needed
      while (remaining > 0) {
        const limit = Math.min(remaining, 50);
        const data = await spotifyApi.getMySavedTracks({ limit, offset });

        for (const entry of data.body.items) {
          const track = entry.track;
          if (track && track.uri) {
            allTracks.push({
              uri: track.uri,
              name: track.name,
              artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
              type: "track",
            });
          }
        }

        // If fewer tracks returned than requested, no more pages
        if (data.body.items.length < limit) break;
        offset += limit;
        remaining -= limit;
      }

      log(`    Found ${allTracks.length} tracks from saved songs`);
    } catch (err) {
      logErr(`    ⚠️  Failed to fetch saved tracks: ${err.message}`);
    }
  }

  // --- Source 3: Pull from user's top tracks (most-played songs) ---
  if (musicConfig.top_tracks && musicConfig.top_tracks.enabled) {
    // time_range controls the window:
    //   "short_term"  = last ~4 weeks
    //   "medium_term" = last ~6 months
    //   "long_term"   = all time
    const timeRange = musicConfig.top_tracks.time_range || "short_term";
    const count = musicConfig.top_tracks.count || 30;
    log(`🎵 Fetching top tracks (${timeRange})...`);

    try {
      let offset = 0;
      let remaining = count;

      // Spotify returns max 50 top tracks per request, so paginate if needed
      while (remaining > 0) {
        const limit = Math.min(remaining, 50);
        const data = await spotifyApi.getMyTopTracks({ limit, offset, time_range: timeRange });

        for (const track of data.body.items) {
          allTracks.push({
            uri: track.uri,
            name: track.name,
            artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
            type: "track",
          });
        }

        // If we got fewer tracks than requested, there are no more
        if (data.body.items.length < limit) break;
        offset += limit;
        remaining -= limit;
      }

      log(`    Found ${allTracks.length} tracks from top tracks`);
    } catch (err) {
      logErr(`    ⚠️  Failed to fetch top tracks: ${err.message}`);
    }
  }

  // Shuffle and trim to the desired total number of songs
  const totalSongs = musicConfig.total_songs || 15;
  if (musicConfig.shuffle !== false) {
    allTracks = shuffle(allTracks);
  }
  allTracks = allTracks.slice(0, totalSongs);

  log(`🎵 Selected ${allTracks.length} songs`);
  return allTracks;
}

/**
 * Fetches "discovery" tracks by searching Spotify for songs matching your
 * configured genres (e.g., "dance pop", "indie rock"). This helps you discover
 * new music outside your usual listening habits.
 *
 * Tracks are split evenly across genres, then shuffled and trimmed.
 */
async function fetchGenreTracks(spotifyApi, genres, count) {
  const tracks = [];
  // Divide the target count evenly among configured genres
  const perGenre = Math.ceil(count / genres.length);

  for (const genre of genres) {
    log(`🎵 Searching for ${genre} tracks...`);
    try {
      // Use Spotify's search with a "genre:" filter
      const data = await spotifyApi.searchTracks(`genre:${genre}`, {
        limit: Math.min(perGenre, 10), // Spotify Dev Mode caps search at 10 results per query
        market: "US",
      });

      for (const track of data.body.tracks.items) {
        tracks.push({
          uri: track.uri,
          name: track.name,
          artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
          type: "track",
        });
      }
      log(`    Found ${data.body.tracks.items.length} tracks`);
    } catch (err) {
      logErr(`    ⚠️  Failed to search genre ${genre}: ${err.message}`);
    }
  }

  // Shuffle so we don't always get the same top results, then trim to count
  return shuffle(tracks).slice(0, count);
}

/**
 * Interleaves podcast episodes and music tracks according to a pattern string.
 *
 * Pattern example: "PMMM" means: 1 podcast, 3 music, 1 podcast, 3 music, ...
 *   P = podcast episode slot
 *   M = music track slot
 *
 * The pattern repeats cyclically. When one content type runs out, the remaining
 * items of the other type are appended at the end.
 */
/**
 * Interleaves podcast episodes round-robin across all shows.
 * Input: flat array of episodes (grouped by show as returned by fetchPodcastEpisodes).
 * Output: episodes alternating between shows, e.g. [A1, B1, C1, A2, B2, C2, ...].
 */
function alternateEpisodes(episodes) {
  // Group episodes by show name, preserving original per-show order
  const byShow = [];
  const showIndex = new Map();
  for (const ep of episodes) {
    const key = ep.show || ep.uri;
    if (!showIndex.has(key)) {
      showIndex.set(key, byShow.length);
      byShow.push([]);
    }
    byShow[showIndex.get(key)].push(ep);
  }
  // Round-robin interleave
  if (byShow.length === 0) return [];
  const result = [];
  const maxLen = Math.max(...byShow.map(g => g.length));
  for (let round = 0; round < maxLen; round++) {
    for (const group of byShow) {
      if (round < group.length) result.push(group[round]);
    }
  }
  return result;
}

function mixContent(episodes, tracks, pattern) {
  const mixed = [];
  let episodeIndex = 0;
  let trackIndex = 0;
  let patternIndex = 0;

  const mixPattern = pattern || "PMMM";

  // Walk through the pattern, placing content in the appropriate slots
  while (episodeIndex < episodes.length || trackIndex < tracks.length) {
    // Which slot are we on? The pattern repeats using modulo (%)
    const slot = mixPattern[patternIndex % mixPattern.length];

    if (slot === "P" || slot === "p") {
      // Podcast slot — place next episode if available
      if (episodeIndex < episodes.length) {
        mixed.push(episodes[episodeIndex++]);
      }
    } else {
      // Music slot (M) — place next track if available
      if (trackIndex < tracks.length) {
        mixed.push(tracks[trackIndex++]);
      }
    }

    patternIndex++;

    // Safety valve: if one type is exhausted, dump all remaining items of the other
    // This prevents an infinite loop when the pattern asks for content we don't have
    if (episodeIndex >= episodes.length && trackIndex < tracks.length) {
      while (trackIndex < tracks.length) {
        mixed.push(tracks[trackIndex++]);
      }
      break;
    }
    if (trackIndex >= tracks.length && episodeIndex < episodes.length) {
      while (episodeIndex < episodes.length) {
        mixed.push(episodes[episodeIndex++]);
      }
      break;
    }
  }

  return mixed;
}

/**
 * Replaces the entire playlist with the given items.
 *
 * Uses the Spotify /items endpoint (NOT /tracks, which was deprecated in Feb 2026).
 * PUT replaces the first 100 items; POST appends additional batches if needed.
 * This endpoint accepts both track and episode URIs.
 */
async function updatePlaylist(spotifyApi, playlistId, items) {
  const uris = items.map((item) => item.uri);

  // In dry-run mode, just print what would happen and return
  if (DRY_RUN) {
    log("\n🧪 DRY RUN — would update playlist with:\n");
    items.forEach((item, i) => {
      const icon = item.type === "episode" ? "🎙️ " : "🎵";
      const detail =
        item.type === "episode"
          ? `[${item.show}] ${item.name}`
          : `${item.name} — ${item.artist}`;
      log(`  ${String(i + 1).padStart(2)}. ${icon} ${detail}`);
    });
    log(`\n✅ Dry run complete. ${items.length} items would be added.\n`);
    return;
  }

  // Get the current access token for direct API calls
  const accessToken = spotifyApi.getAccessToken();

  // PUT replaces the entire playlist with up to 100 items at once
  const clearRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: uris.slice(0, 100) }),
  });
  if (!clearRes.ok) {
    if (clearRes.status === 429) {
      const retryAfter = parseInt(clearRes.headers.get("Retry-After") || "60", 10);
      logErr(`⏳ Spotify rate limit (429) — Retry-After: ${retryAfter}s`);
      throw new SpotifyQuotaError(retryAfter);
    }
    const err = await clearRes.text();
    throw new Error(`Failed to update playlist: ${clearRes.status} ${err}`);
  }

  // If we have more than 100 items, POST the remaining in batches of 100
  for (let i = 100; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    const addRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: batch }),
    });
    if (!addRes.ok) {
      if (addRes.status === 429) {
        const retryAfter = parseInt(addRes.headers.get("Retry-After") || "60", 10);
        logErr(`⏳ Spotify rate limit (429) — Retry-After: ${retryAfter}s`);
        throw new SpotifyQuotaError(retryAfter);
      }
      const err = await addRes.text();
      throw new Error(`Failed to add batch: ${addRes.status} ${err}`);
    }
  }

  log(`\n✅ Playlist updated with ${items.length} items!`);
  log(`   🎙️  ${items.filter((i) => i.type === "episode").length} podcast episodes`);
  log(`   🎵 ${items.filter((i) => i.type === "track").length} songs\n`);
}

// =============================================================================
// Main — Entry point that orchestrates everything
// =============================================================================

async function main() {
  const mode = PODCAST_ONLY ? "podcast-only" : "full";
  log(`\n🚗 Daily Drive — ${PODCAST_ONLY ? "Hourly podcast refresh" : "Full playlist rebuild"}...\n`);

  // Step 1: Load configuration and authentication token
  const config = loadConfig();
  const token = loadToken();

  // Step 2: Create Spotify API client with your app credentials
  const spotifyApi = new SpotifyWebApi({
    clientId: config.spotify.client_id,
    clientSecret: config.spotify.client_secret,
    redirectUri: config.spotify.redirect_uri,
  });

  // Set the tokens so the API client can make authenticated requests
  spotifyApi.setAccessToken(token.access_token);
  spotifyApi.setRefreshToken(token.refresh_token);

  // Step 3: Refresh the access token if it's about to expire
  await refreshTokenIfNeeded(spotifyApi, token);

  // Step 4: Make sure the user has set a real playlist ID
  if (!config.playlist_id || config.playlist_id === "your-playlist-id-here") {
    const msg = "Please set your playlist_id in config.yaml";
    logErr("❌ " + msg);
    if (require.main === module) process.exit(1);
    throw new Error(msg);
  }

  // Step 5: Fetch the latest podcast episodes
  const episodes = await fetchPodcastEpisodes(spotifyApi, config.podcasts || []);

  // Step 6: Check if episodes have changed since last run
  // This prevents unnecessary playlist updates that would reset your listening position
  const state = loadState();
  const currentEpisodeUris = episodes.map((e) => e.uri).sort().join(",");
  const previousEpisodeUris = state.episode_uris || "";

  // In podcast-only mode, skip if episodes haven't changed (no point reshuffling)
  // In full refresh mode, ALWAYS proceed — we want fresh music even if podcasts are the same
  if (!DRY_RUN && PODCAST_ONLY && currentEpisodeUris === previousEpisodeUris && episodes.length > 0) {
    log("\n⏭️  No new podcast episodes detected. Playlist unchanged.");
    log("   (Same episodes as last update — skipping to avoid disruption)\n");
    return;
  }

  // Step 7: Get music tracks
  let tracks;

  if (PODCAST_ONLY) {
    // --- Podcast-only mode (hourly) ---
    // Reuse the music tracks saved from the last full refresh.
    // This keeps your music stable all day while swapping in fresh podcast episodes.
    if (state.music_tracks && state.music_tracks.length > 0) {
      tracks = state.music_tracks;
      log(`🎵 Reusing ${tracks.length} saved music tracks from last full refresh`);
    } else {
      // No saved music — fall back to a full music fetch
      // This happens on the very first run, or if state.json was deleted
      log("⚠️  No saved music tracks found — falling back to full music fetch");
      tracks = await fetchAllMusicTracks(spotifyApi, config);
    }
  } else {
    // --- Full refresh mode (daily) ---
    // Fetch fresh music from all sources (top tracks, playlists, genre discovery)
    tracks = await fetchAllMusicTracks(spotifyApi, config);
  }

  if (episodes.length === 0 && tracks.length === 0) {
    const msg = "No content found — check your config and Spotify authorisation.";
    logErr("❌ " + msg);
    if (require.main === module) process.exit(1);
    throw new Error(msg);
  }

  // Step 8: Separate pinned episodes (position: "first") from mixable ones
  // Pinned episodes go at the very top of the playlist, before the mix pattern starts
  const pinnedFirst = [];
  let mixableEpisodes = [];
  for (const ep of episodes) {
    if (ep.position === "first") {
      pinnedFirst.push(ep);
    } else {
      mixableEpisodes.push(ep);
    }
  }

  // Step 9: Optionally alternate episodes across podcasts (round-robin instead of sequential)
  if (config.podcast_alternate && mixableEpisodes.length > 0) {
    log("🔄 Alternating podcast episodes across shows (round-robin)");
    mixableEpisodes = alternateEpisodes(mixableEpisodes);
  }

  // Step 10: Mix podcasts and music according to the configured pattern
  log(`\n🔀 Mixing with pattern: ${config.mix_pattern || "PMMM"}`);
  const mixed = [...pinnedFirst, ...mixContent(mixableEpisodes, tracks, config.mix_pattern)];

  // Step 10: Push the final mixed playlist to Spotify
  await updatePlaylist(spotifyApi, config.playlist_id, mixed);

  // Step 11: Save state so the next run can detect if episodes have changed
  if (!DRY_RUN) {
    const newState = {
      episode_uris: currentEpisodeUris,
      last_updated: new Date().toISOString(),
      playlist_items: mixed.map(item => ({
        uri: item.uri,
        name: item.name,
        type: item.type,
        artist: item.type === "track" ? item.artist : null,
        show: item.type === "episode" ? item.show : null,
        duration_ms: item.duration_ms || null,
      })),
    };

    if (PODCAST_ONLY) {
      // In podcast-only mode, preserve the saved music tracks from the full refresh
      newState.music_tracks = state.music_tracks || tracks;
      newState.last_full_refresh = state.last_full_refresh || null;
    } else {
      // In full refresh mode, save the music tracks for hourly podcast-only runs to reuse
      newState.music_tracks = tracks;
      newState.last_full_refresh = new Date().toISOString();
    }

    saveState(newState);
    log("💾 State saved to state.json");
  }
}

/**
 * Fetches all music tracks (familiar + discovery) based on config.
 * Used by full refresh mode, and as a fallback for podcast-only mode
 * when no saved tracks exist yet.
 */
async function fetchAllMusicTracks(spotifyApi, config) {
  const musicConfig = config.music || {};
  const totalSongs = musicConfig.total_songs || 15;
  const hasGenres = musicConfig.genres && musicConfig.genres.length > 0;

  // When genres are configured, split total_songs 50/50:
  //   - Half "familiar" (your top tracks + source playlists)
  //   - Half "discovery" (genre search results — new music for you)
  const familiarCount = hasGenres ? Math.ceil(totalSongs / 2) : totalSongs;
  const discoveryCount = hasGenres ? totalSongs - familiarCount : 0;

  // Fetch familiar tracks (your top tracks + any source playlists)
  const familiarConfig = { ...musicConfig, total_songs: familiarCount };
  let tracks = await fetchMusicTracks(spotifyApi, familiarConfig);

  // Fetch discovery tracks (genre-based search for new music)
  if (hasGenres && discoveryCount > 0) {
    const genreTracks = await fetchGenreTracks(spotifyApi, musicConfig.genres, discoveryCount);

    // Remove any genre tracks that duplicate songs already in the familiar set
    const familiarUris = new Set(tracks.map((t) => t.uri));
    const newGenreTracks = genreTracks.filter((t) => !familiarUris.has(t.uri));
    tracks = [...tracks, ...newGenreTracks.slice(0, discoveryCount)];
    log(`🎵 Music mix: ${familiarCount} familiar + ${newGenreTracks.slice(0, discoveryCount).length} discovery = ${tracks.length} total`);
  }

  return tracks;
}

// Export main() so server.js can call it programmatically.
// When this file is run directly (CLI), also execute main() immediately.
module.exports = { main, setLogger, SpotifyQuotaError };

if (require.main === module) {
  main().catch((err) => {
    logErr("\n❌ Error:", err.message);
    if (err.statusCode === 401) {
      logErr("   Your token may have expired. Run: npm run setup\n");
    }
    process.exit(1);
  });
}

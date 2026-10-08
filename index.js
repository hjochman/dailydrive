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

// --- Centralised path & credential resolution ---
const { PATHS, resolveSpotifyCredentials } = require("./paths");
const TOKEN_FILE = PATHS.TOKEN_FILE;
const CONFIG_FILE = PATHS.CONFIG_FILE;
const STATE_FILE  = PATHS.STATE_FILE;

// Check command-line flags
const DRY_RUN = process.argv.includes("--dry-run");       // Shows what would happen without changing the playlist
const PODCAST_ONLY = process.argv.includes("--podcast-only"); // Hourly mode: only refresh podcasts, reuse saved music

// ---------------------------------------------------------------------------
// Logger — defaults to console; overridden by server.js via setLogger()
// Accepts either a logger object { error, warn, info, debug } or a plain function (legacy).
// ---------------------------------------------------------------------------
let _log = {
  error: (...a) => console.error(...a),
  warn:  (...a) => console.warn(...a),
  info:  (...a) => console.log(...a),
  debug: (...a) => {},
};

// --- Spotify client abstraction ---
const { SpotifyQuotaError } = require("./spotify-client-base");
const { createSpotifyClient } = require("./spotify-client-factory");

function setLogger(loggerOrFn) {
  if (typeof loggerOrFn === "function") {
    _log = { error: loggerOrFn, warn: loggerOrFn, info: loggerOrFn, debug: () => {} };
  } else if (loggerOrFn && typeof loggerOrFn === "object") {
    _log = loggerOrFn;
  }
}

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
    _log.error("❌ " + msg);
    if (require.main === module) process.exit(1);
    throw new Error(msg);
  }

  // Merge env-var credentials (env vars take precedence over config file)
  const creds = resolveSpotifyCredentials(config.spotify || {});
  config.spotify = creds;
  return config;
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

// =============================================================================
// Core Logic
// =============================================================================

/**
 * Fetches podcast episodes based on the configured mode per podcast:
 *   - "newest" (default): grabs the most recent episode(s)
 *   - "newest_unplayed": scans recent episodes and picks the most recent
 *     unplayed episode(s) — stops scanning as soon as enough are found
 *   - "oldest_unplayed": scans recent episodes and picks the oldest
 *     unplayed episode(s) — useful for catching up in order
 *
 * The unplayed modes rely on Spotify's resume_point.fully_played field,
 * which is returned when a market parameter is set. They scan up to
 * scan_limit episodes (default: 50) in batches of 50, then select from the
 * newest or oldest end. Falls back to newest if no unplayed episodes found.
 *
 * Note: Some podcasts (like NPR News Now) publish hourly episodes that expire
 * quickly on Spotify. If you see "[unavailable]" in your playlist, run the
 * script again to fetch the latest episode.
 */
async function fetchPodcastEpisodes(client, podcasts, market = "US") {
  const episodes = [];

  for (const podcast of podcasts) {
    const count = podcast.episodes || 1;
    const mode  = podcast.mode || "newest";
    _log.info(`🎙️  Fetching ${count} episode(s) from: ${podcast.name} (mode: ${mode})`);

    try {
      // Unplayed modes require resume_point data which is not available in OAuth Dev Mode.
      const effectiveMode =
        (mode === "newest_unplayed" || mode === "oldest_unplayed") && !client.resumePointSupported
          ? "newest"
          : mode;

      if (effectiveMode !== mode) {
        _log.warn(`Mode "${mode}" requires Cookie client (OAuth Dev Mode does not return resume_point) — using "newest" instead`);
      }

      if (effectiveMode === "newest_unplayed" || effectiveMode === "oldest_unplayed") {
        const scanLimit = podcast.scan_limit || 50;
        const batchSize = 50;
        let offset = 0;
        let scanned = 0;
        const unplayed = [];
        let newestItems = [];

        while (scanned < scanLimit) {
          const limit = Math.min(batchSize, scanLimit - scanned);
          const items = await client.getShowEpisodes(podcast.id, {
            limit,
            offset,
            market,
          });

          if (items.length === 0) break;
          if (scanned === 0) newestItems = items;

          for (const ep of items) {
            const status = ep.fully_played ? "✅" : "⬜";
            _log.debug(`    ${status} ${ep.name}`);
            if (!ep.fully_played) unplayed.push(ep);
          }

          scanned += items.length;
          offset  += items.length;

          // Spotify returns newest-first — once newest_unplayed has enough, stop.
          if (mode === "newest_unplayed" && unplayed.length >= count) break;
          if (items.length < limit) break; // reached end of feed

          _log.debug(`    📊 Scanned ${scanned}/${scanLimit}, ${unplayed.length} unplayed so far…`);
        }

        _log.info(`    📊 Scan complete: ${scanned} scanned, ${unplayed.length} unplayed found`);

        // Spotify returns newest-first; reverse for oldest_unplayed so slice(0,count) gets oldest.
        if (effectiveMode === "oldest_unplayed") unplayed.reverse();

        const selected = unplayed.length > 0 ? unplayed.slice(0, count) : newestItems.slice(0, count);
        if (unplayed.length === 0) {
          _log.warn(`No unplayed episodes found for "${podcast.name}" — falling back to newest`);
        }

        for (const episode of selected) {
          episodes.push({
            uri:      episode.uri,
            name:     episode.name,
            show:     podcast.name,
            type:     "episode",
            position: podcast.position || null,
          });
          _log.info(`    📌 Selected: ${episode.name}`);
        }
      } else {
        // Default "newest" mode — original behaviour, no scanning overhead.
        const items = await client.getShowEpisodes(podcast.id, {
          limit:  count,
          market,
        });
        for (const episode of items) {
          episodes.push({
            uri:      episode.uri,
            name:     episode.name,
            show:     podcast.name,
            type:     "episode",
            position: podcast.position || null,
          });
          _log.info(`    📌 ${episode.name}`);
        }
      }
    } catch (err) {
      _log.error(`Failed to fetch ${podcast.name}: ${err.message}`);
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
async function fetchMusicTracks(client, musicConfig) {
  let allTracks = [];

  // --- Source 1: Pull tracks from user-specified playlists ---
  if (musicConfig.playlists) {
    for (const playlist of musicConfig.playlists) {
      // Skip placeholder entries from the example config
      if (!playlist.id || playlist.id === "your-playlist-id") continue;

      _log.info(`🎵 Fetching songs from playlist: ${playlist.name}`);

      try {
        // Paginate through the playlist using the client's getPlaylistItems().
        // The client handles the /items endpoint internally (the old /tracks
        // endpoint was deprecated in Feb 2026 and now returns 403 Forbidden).
        let offset = 0;
        let hasMore = true;

        let playlistCount = 0;
        while (hasMore) {
          const items = await client.getPlaylistItems(playlist.id, { limit: 100, offset });
          allTracks.push(...items);
          playlistCount += items.length;
          _log.debug(`    Fetched page at offset ${offset}: ${items.length} tracks`);
          offset += 100;
          // If fewer than 100 tracks were returned, there are no more pages.
          // (getPlaylistItems already filters to tracks only.)
          hasMore = items.length === 100;
        }

        _log.info(`    Found ${playlistCount} tracks`);
      } catch (err) {
        _log.error(`Failed to fetch playlist ${playlist.name}: ${err.message}`);
      }
    }
  }

  // --- Source 2: Pull from user's liked/saved songs ---
  if (musicConfig.saved_tracks && musicConfig.saved_tracks.enabled) {
    const count = musicConfig.saved_tracks.count || 50;
    _log.info(`🎵 Fetching saved/liked tracks (up to ${count})...`);

    try {
      let offset = 0;
      let remaining = count;
      let savedCount = 0;

      // Spotify returns max 50 saved tracks per request, so paginate if needed
      while (remaining > 0) {
        const limit = Math.min(remaining, 50);
        // Client returns normalised objects: { uri, name, artist, type }
        const items = await client.getMySavedTracks({ limit, offset });
        allTracks.push(...items);
        savedCount += items.length;
        _log.debug(`    Fetched saved tracks at offset ${offset}: ${items.length} items`);

        // If fewer tracks returned than requested, no more pages
        if (items.length < limit) break;
        offset += limit;
        remaining -= limit;
      }

      if (savedCount === 0) {
        _log.warn("    Saved tracks returned 0 items — library may be empty or API query failed");
      } else {
        _log.info(`    Found ${savedCount} saved tracks`);
      }
    } catch (err) {
      _log.error(`Failed to fetch saved tracks: ${err.message}`);
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
    _log.info(`🎵 Fetching top tracks (${timeRange})...`);

    try {
      let offset = 0;
      let remaining = count;

      // Spotify returns max 50 top tracks per request, so paginate if needed
      let topCount = 0;
      while (remaining > 0) {
        const limit = Math.min(remaining, 50);
        // Client returns normalised objects: { uri, name, artist, type }
        const items = await client.getMyTopTracks({ limit, offset, time_range: timeRange });
        allTracks.push(...items);
        topCount += items.length;
        _log.debug(`    Fetched top tracks at offset ${offset}: ${items.length} items`);

        // If we got fewer tracks than requested, there are no more
        if (items.length < limit) break;
        offset += limit;
        remaining -= limit;
      }

      _log.info(`    Found ${topCount} top tracks`);
    } catch (err) {
      _log.error(`Failed to fetch top tracks: ${err.message}`);
    }
  }

  if (allTracks.length === 0) {
    _log.warn("No music tracks found — check your music sources (top_tracks, playlists, saved_tracks) in config.yaml");
  }

  // Shuffle and trim to the desired total number of songs
  const totalSongs = musicConfig.total_songs || 15;
  if (musicConfig.shuffle !== false) {
    allTracks = shuffle(allTracks);
  }
  allTracks = allTracks.slice(0, totalSongs);

  _log.info(`🎵 Selected ${allTracks.length} songs`);
  return allTracks;
}

/**
 * Fetches "discovery" tracks by searching Spotify for songs matching your
 * configured genres (e.g., "dance pop", "indie rock"). This helps you discover
 * new music outside your usual listening habits.
 *
 * Tracks are split evenly across genres, then shuffled and trimmed.
 */
async function fetchGenreTracks(client, genres, count, maxPerGenre = 10) {
  const tracks = [];
  // Divide the target count evenly among configured genres
  const perGenre = Math.ceil(count / genres.length);

  for (const genre of genres) {
    _log.info(`🎵 Searching for ${genre} tracks...`);
    try {
      // Use Spotify's search with a "genre:" filter.
      // Client returns normalised objects: { uri, name, artist, type }
      const items = await client.searchTracks(`genre:${genre}`, {
        limit: Math.min(perGenre, maxPerGenre), // OAuth/Dev Mode: capped at 10; cookie mode: configurable
        market: "US",
      });
      tracks.push(...items);
      _log.debug(`    genre:${genre} → ${items.length} results`);
      if (items.length === 0) {
        _log.warn(`No tracks found for genre "${genre}" — check spelling or try a broader term`);
      }
    } catch (err) {
      _log.error(`Failed to search genre ${genre}: ${err.message}`);
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
 * Delegates to the client's replacePlaylistItems / addPlaylistItems methods,
 * which handle the /items endpoint internally (NOT /tracks, deprecated Feb 2026).
 * PUT replaces the first 100 items; POST appends additional batches if needed.
 * This endpoint accepts both track and episode URIs.
 */
async function updatePlaylist(client, playlistId, items) {
  const uris = items.map((item) => item.uri);

  // In dry-run mode, just print what would happen and return
  if (DRY_RUN) {
    _log.info("\n🧪 DRY RUN — would update playlist with:\n");
    items.forEach((item, i) => {
      const icon = item.type === "episode" ? "🎙️ " : "🎵";
      const detail =
        item.type === "episode"
          ? `[${item.show}] ${item.name}`
          : `${item.name} — ${item.artist}`;
      _log.info(`  ${String(i + 1).padStart(2)}. ${icon} ${detail}`);
    });
    _log.info(`\n✅ Dry run complete. ${items.length} items would be added.\n`);
    return;
  }

  // PUT replaces the entire playlist with up to 100 items at once.
  // The client handles the /items endpoint and raises SpotifyQuotaError on 429.
  await client.replacePlaylistItems(playlistId, uris.slice(0, 100));

  // If we have more than 100 items, POST the remaining in batches of 100
  for (let i = 100; i < uris.length; i += 100) {
    await client.addPlaylistItems(playlistId, uris.slice(i, i + 100));
    _log.debug(`    Added batch ${Math.floor(i / 100) + 1} (items ${i + 1}–${Math.min(i + 100, uris.length)})`);
  }

  _log.info(`\n✅ Playlist updated with ${items.length} items!`);
  _log.info(`   🎙️  ${items.filter((i) => i.type === "episode").length} podcast episodes`);
  _log.info(`   🎵 ${items.filter((i) => i.type === "track").length} songs\n`);
}

// =============================================================================
// Main — Entry point that orchestrates everything
// =============================================================================

async function main() {
  const mode = PODCAST_ONLY ? "podcast-only" : "full";
  _log.info(`\n🚗 Daily Drive — ${PODCAST_ONLY ? "Hourly podcast refresh" : "Full playlist rebuild"}...\n`);

  // Step 1: Load configuration
  const config = loadConfig();

  // Step 2: Create and initialise the Spotify client (OAuth or Cookie based on api_mode)
  const creds = config.spotify;
  const client = createSpotifyClient(config.api_mode || "oauth", creds);
  await client.initialize();

  // Step 3: Make sure the user has set a real playlist ID
  if (!config.playlist_id || config.playlist_id === "your-playlist-id-here") {
    const msg = "Please set your playlist_id in config.yaml";
    _log.error("❌ " + msg);
    if (require.main === module) process.exit(1);
    throw new Error(msg);
  }

  // Step 4: Resolve user's market (country code) — required for resume_point in episode responses.
  // Falls back to "US" if unavailable.
  let market = "US";
  try {
    const me = await client.getMe();
    if (me?.country) market = me.country;
  } catch (_) { /* non-fatal */ }

  // Step 5: Fetch the latest podcast episodes
  const episodes = await fetchPodcastEpisodes(client, config.podcasts || [], market);

  // Step 6: Check if episodes have changed since last run
  // This prevents unnecessary playlist updates that would reset your listening position
  const state = loadState();
  const currentEpisodeUris = episodes.map((e) => e.uri).sort().join(",");
  const previousEpisodeUris = state.episode_uris || "";

  // In podcast-only mode, skip if episodes haven't changed (no point reshuffling)
  // In full refresh mode, ALWAYS proceed — we want fresh music even if podcasts are the same
  if (!DRY_RUN && PODCAST_ONLY && currentEpisodeUris === previousEpisodeUris && episodes.length > 0) {
    _log.info("\n⏭️  No new podcast episodes detected. Playlist unchanged.");
    _log.info("   (Same episodes as last update — skipping to avoid disruption)\n");
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
      _log.info(`🎵 Reusing ${tracks.length} saved music tracks from last full refresh`);
    } else {
      // No saved music — fall back to a full music fetch
      // This happens on the very first run, or if state.json was deleted
      _log.warn("No saved music tracks found — falling back to full music fetch");
      tracks = await fetchAllMusicTracks(client, config);
    }
  } else {
    // --- Full refresh mode (daily) ---
    // Fetch fresh music from all sources (top tracks, playlists, genre discovery)
    tracks = await fetchAllMusicTracks(client, config);
  }

  if (episodes.length === 0 && tracks.length === 0) {
    const msg = "No content found — check your config and Spotify authorisation.";
    _log.error("❌ " + msg);
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
    _log.info("🔄 Alternating podcast episodes across shows (round-robin)");
    mixableEpisodes = alternateEpisodes(mixableEpisodes);
  }

  // Step 10: Mix podcasts and music according to the configured pattern
  _log.info(`\n🔀 Mixing with pattern: ${config.mix_pattern || "PMMM"}`);
  const mixed = [...pinnedFirst, ...mixContent(mixableEpisodes, tracks, config.mix_pattern)];

  // Step 10: Push the final mixed playlist to Spotify
  await updatePlaylist(client, config.playlist_id, mixed);

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
    _log.debug("💾 State saved to state.json");
  }
}

/**
 * Fetches all music tracks (familiar + discovery) based on config.
 * Used by full refresh mode, and as a fallback for podcast-only mode
 * when no saved tracks exist yet.
 */
async function fetchAllMusicTracks(client, config) {
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
  let tracks = await fetchMusicTracks(client, familiarConfig);

  // Fetch discovery tracks (genre-based search for new music)
  if (hasGenres && discoveryCount > 0) {
    // Spotify Dev Mode (OAuth) caps search at 10 results per query.
    // Cookie mode has no such limit: fetchGenreTracks requests exactly
    // ceil(discoveryCount / genres) results per genre.
    const maxPerGenre = config.api_mode === "cookie" ? Infinity : 10;
    const genreTracks = await fetchGenreTracks(client, musicConfig.genres, discoveryCount, maxPerGenre);

    // Remove any genre tracks that duplicate songs already in the familiar set
    const familiarUris = new Set(tracks.map((t) => t.uri));
    const newGenreTracks = genreTracks.filter((t) => !familiarUris.has(t.uri));
    const dedupedCount = newGenreTracks.length - newGenreTracks.slice(0, discoveryCount).length;
    if (dedupedCount > 0) {
      _log.debug(`    Removed ${dedupedCount} duplicate discovery tracks already in familiar set`);
    }
    tracks = [...tracks, ...newGenreTracks.slice(0, discoveryCount)];
    _log.info(`🎵 Music mix: ${familiarCount} familiar + ${newGenreTracks.slice(0, discoveryCount).length} discovery = ${tracks.length} total`);
  }

  return tracks;
}

// Export main() so server.js can call it programmatically.
// When this file is run directly (CLI), also execute main() immediately.
module.exports = { main, setLogger, SpotifyQuotaError };

if (require.main === module) {
  main().catch((err) => {
    _log.error("\n❌ Error:", err.message);
    if (err.statusCode === 401) {
      _log.error("   Your token may have expired. Run: npm run setup\n");
    }
    process.exit(1);
  });
}

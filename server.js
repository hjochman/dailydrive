// =============================================================================
// Daily Drive by IBM Bob — Web Server & Scheduler
// =============================================================================
// This is the container entrypoint.  It:
//   • Serves the Web UI (EJS views, static assets)
//   • Handles the Spotify OAuth flow (replaces the one-shot setup.js)
//   • Runs the playlist refresh on a configurable schedule (node-cron)
//   • Keeps the Spotify token alive via a background daemon
// =============================================================================

"use strict";

const fs        = require("fs");
const path      = require("path");
const express   = require("express");
const yaml      = require("js-yaml");
const cron      = require("node-cron");
const SpotifyWebApi = require("spotify-web-api-node");

const { PATHS, resolveSpotifyCredentials } = require("./paths");
const tokenManager = require("./token-manager");
const { main: runRefresh, setLogger: setIndexLogger } = require("./index");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WEB_PORT         = parseInt(process.env.WEB_PORT  || "8080", 10);
const REFRESH_INTERVAL_HOURS_DEFAULT = parseInt(process.env.REFRESH_INTERVAL_HOURS || "24", 10);
// Priority: config.yaml > REFRESH_INTERVAL_HOURS env var > 24
const getRefreshH = () => {
  const fromConfig = loadConfig().refresh_interval;
  if (fromConfig) return parseInt(fromConfig, 10);
  return parseInt(process.env.REFRESH_INTERVAL_HOURS || String(REFRESH_INTERVAL_HOURS_DEFAULT), 10);
};
const SHOW_LAN_WARNING = process.env.SHOW_LAN_WARNING !== "false";

// Ensure log directory exists (best-effort — may fail if the mounted /data
// volume is owned by root on a NAS; file logging is silently skipped in that case)
try {
  if (!fs.existsSync(PATHS.LOG_DIR)) {
    fs.mkdirSync(PATHS.LOG_DIR, { recursive: true });
  }
} catch (_) { /* continue without file logging */ }

// ---------------------------------------------------------------------------
// Logging helpers — write to stdout AND /data/logs/YYYY-MM-DD.log
// ---------------------------------------------------------------------------

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(PATHS.LOG_DIR, `${day}.log`), line + "\n");
  } catch (_) { /* best-effort */ }
}

// Route index.js and token-manager.js log output through logLine so it appears in the web UI log
setIndexLogger(logLine);
tokenManager.setLogger(logLine, logLine);

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

function loadConfig() {
  if (!fs.existsSync(PATHS.CONFIG_FILE)) return {};
  try { return yaml.load(fs.readFileSync(PATHS.CONFIG_FILE, "utf8")) || {}; }
  catch { return {}; }
}

function saveConfig(cfg) {
  // Ensure data dir exists (first-time container start)
  if (!fs.existsSync(PATHS.DATA_DIR)) fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
  fs.writeFileSync(PATHS.CONFIG_FILE, yaml.dump(cfg, { lineWidth: 120 }));
}

// ---------------------------------------------------------------------------
// Status helper — used by dashboard
// ---------------------------------------------------------------------------

function getAppStatus() {
  const config       = loadConfig();
  const creds        = resolveSpotifyCredentials(config.spotify || {});
  const tokenStatus  = tokenManager.getTokenStatus();
  return {
    hasCredentials: !!(creds.client_id && creds.client_secret),
    tokenValid:     tokenStatus.valid,
    expiresAt:      tokenStatus.expiresAt,
    hasRefreshToken:tokenStatus.hasRefreshToken,
    hasPlaylist:    !!(config.playlist_id && config.playlist_id !== "your-playlist-id-here"),
    hasPodcasts:    !!(config.podcasts && config.podcasts.length > 0),
  };
}

function loadState() {
  if (!fs.existsSync(PATHS.STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PATHS.STATE_FILE, "utf8")); }
  catch { return {}; }
}

// ---------------------------------------------------------------------------
// Redirect URI auto-detect
// ---------------------------------------------------------------------------

function getRedirectUri(req) {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  // Auto-detect from incoming request (useful in web UI first-time setup)
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  let host  = req.headers["x-forwarded-host"]  || req.headers.host || `127.0.0.1:${WEB_PORT}`;

  // If loopback is forced (useful for local NAS setups without HTTPS)
  const forceLoopback = req.query.use_loopback === "true" || (req.headers.referer && req.headers.referer.includes("use_loopback=true"));
  if (forceLoopback) {
    const portMatch = host.match(/:(\d+)$/);
    const port = portMatch ? portMatch[1] : WEB_PORT;
    host = `127.0.0.1:${port}`;
  }

  // Spotify does NOT accept "localhost" as redirect URI (blocked since Nov 2025).
  // Replace it with the explicit IPv4 loopback address.
  const safHost = host.replace(/^localhost(:\d+)?$/, `127.0.0.1$1`);
  return `${proto}://${safHost}/callback`;
}

// ---------------------------------------------------------------------------
// Next scheduled refresh time (approx.)
// ---------------------------------------------------------------------------

let _lastRefreshTime = null;

/**
 * Calculate the next scheduled fire time directly from REFRESH_H,
 * matching the cron expressions set in startScheduler().
 * Works correctly immediately after server start (no prior run needed).
 */
function nextRefreshDate() {
  const now   = new Date();
  const hours = Math.max(1, Math.min(168, getRefreshH()));
  let next;

  if (hours === 24) {
    // daily at 04:00
    next = new Date(now);
    next.setHours(4, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (hours < 24) {
    // every N hours at :00 — find the next :00 boundary that is >= (now + N h)
    // cron `0 */N * * *` fires at 0:00, N:00, 2N:00, …
    const currentHour = now.getHours();
    const nextHour = Math.ceil((currentHour + 1) / hours) * hours;
    next = new Date(now);
    next.setMinutes(0, 0, 0);
    if (nextHour >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(nextHour % 24);
    } else {
      next.setHours(nextHour);
    }
  } else {
    // every ceil(N/24) days at 04:00
    const days = Math.round(hours / 24);
    next = new Date(now);
    next.setHours(4, 0, 0, 0);
    next.setDate(next.getDate() + days);
  }

  return next;
}

function nextRefreshString() {
  return nextRefreshDate().toLocaleString();
}

// ---------------------------------------------------------------------------
// EJS render helper — wraps body in layout.ejs
// ---------------------------------------------------------------------------

function render(res, view, locals) {
  // Render inner view to string, then wrap in layout
  res.render(view, locals, (err, body) => {
    if (err) {
      console.error("Render error:", err);
      return res.status(500).send("Template error: " + err.message);
    }
    res.render("layout", { ...locals, body, title: locals.title || "Daily Drive", showLanWarning: SHOW_LAN_WARNING });
  });
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Minimal flash via query param (no session needed)
function flash(req) {
  if (req.query.ok)    return { type: "success", message: req.query.ok };
  if (req.query.error) return { type: "error",   message: req.query.error };
  return null;
}

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

// ── GET /  Dashboard ────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  // Ensure token is refreshed proactively if expired/expiring
  await tokenManager.refreshTokenIfNeeded().catch(() => {});
  const config = loadConfig();
  const status = getAppStatus();
  const state  = loadState();

  let playlistTracks = [];
  let playlistError = null;
  let isLive = false;

  if (status.hasCredentials && status.hasPlaylist) {
    try {
      // Proactively refresh token if needed before API call
      const token = await tokenManager.refreshTokenIfNeeded();
      if (token && token.access_token) {
        const playlistId = config.playlist_id;
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const apiRes = await fetch(
            `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&offset=${offset}`,
            { headers: { Authorization: `Bearer ${token.access_token}` } }
          );

          if (!apiRes.ok) {
            throw new Error(`HTTP ${apiRes.status}: ${await apiRes.text()}`);
          }

          const data = await apiRes.json();
          for (const entry of data.items) {
            // Spotify /items returns episodes under entry.track (for playlist items)
            // or entry.episode (some API versions). Tracks are always entry.track.
            const item = entry.track || entry.episode;
            if (!item || !item.uri) continue;
            const isEpisode = item.type === "episode";
            playlistTracks.push({
              uri: item.uri,
              name: item.name,
              type: item.type,
              artist: !isEpisode
                ? (item.artists?.map(a => a.name).join(", ") || "Unknown Artist")
                : null,
              show: isEpisode
                ? (typeof item.show === "object" ? item.show?.name : item.show) || "Unknown Show"
                : null,
              duration_ms: item.duration_ms,
            });
          }
          offset += 100;
          hasMore = offset < data.total;
        }
        isLive = true;
      }
    } catch (err) {
      console.error("Failed to fetch live playlist tracks for dashboard:", err);
      playlistError = err.message;
    }
  }

  // Fallback to state if live fetch didn't return any tracks and state contains playlist_items
  if (playlistTracks.length === 0 && state.playlist_items && state.playlist_items.length > 0) {
    playlistTracks = state.playlist_items;
    playlistError = null;
  }

  const reauthFlash = req.query.reauth
    ? { type: "success", message: "✅ Spotify successfully re-authorized." }
    : null;

  render(res, "index", {
    page:        "dashboard",
    title:       "Dashboard",
    status,
    state,
    playlistId:  config.playlist_id || "",
    nextRefresh: nextRefreshString(),
    nextRefreshDate: nextRefreshDate(),
    flash:       reauthFlash || flash(req),
    playlistTracks,
    playlistError,
    isLive,
  });
});

// ── GET /setup  Setup wizard ─────────────────────────────────────────────────
app.get("/setup", (req, res) => {
  const step       = parseInt(req.query.step || "1", 10);
  const config     = loadConfig();
  const creds      = resolveSpotifyCredentials(config.spotify || {});
  render(res, "setup", {
    page:        "setup",
    title:       "Setup",
    step,
    config,
    credentials: creds,
    redirectUri: getRedirectUri(req),
    flash:       flash(req),
  });
});

// ── POST /setup/credentials  Save credentials, go to step 2 (OAuth) ──────────
app.post("/setup/credentials", (req, res) => {
  try {
    const config = loadConfig();
    if (!config.spotify) config.spotify = {};

    const { client_id, client_secret, redirect_uri } = req.body;
    if (client_id)     config.spotify.client_id    = client_id.trim();
    if (client_secret && client_secret !== "••••••••")
                       config.spotify.client_secret = client_secret.trim();
    if (redirect_uri)  config.spotify.redirect_uri  = redirect_uri.trim();

    saveConfig(config);
    res.redirect("/setup?step=2");
  } catch (err) {
    logLine("❌ /setup/credentials error: " + err.message);
    res.redirect("/setup?step=1&error=" + encodeURIComponent(err.message));
  }
});

// ── POST /setup/playlist  Save playlist ID, redirect to config ────────────────
function extractPlaylistId(value) {
  value = (value || "").trim();
  const m = value.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  const u = value.match(/spotify:playlist:([A-Za-z0-9]+)/);
  if (u) return u[1];
  return value; // assume raw ID
}

app.post("/setup/playlist", (req, res) => {
  try {
    const config = loadConfig();
    config.playlist_id = extractPlaylistId(req.body.playlist_url || req.body.playlist_id || "");

    // Seed default music config if not already present
    if (!config.music) {
      config.music = {
        top_tracks: { enabled: true, time_range: "short_term", count: 30 },
        genres: [],
        playlists: [],
        total_songs: 15,
        shuffle: true,
      };
    }
    if (!config.mix_pattern) config.mix_pattern = "PMMMM";

    saveConfig(config);
    // Go straight to config editor so user can add podcasts, music etc.
    res.redirect("/config?setup=1");
  } catch (err) {
    logLine("❌ /setup/playlist error: " + err.message);
    res.redirect("/setup?step=3&error=" + encodeURIComponent(err.message));
  }
});

// ── POST /api/create-playlist  Create a new empty Daily Drive playlist ────────
app.post("/api/create-playlist", async (req, res) => {
  try {
    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});
    const token  = tokenManager.loadToken();

    if (!token || !token.access_token) {
      return res.status(401).json({ error: "Not authenticated — complete Step 3 first" });
    }

    const spotifyApi = new SpotifyWebApi({
      clientId:     creds.client_id,
      clientSecret: creds.client_secret,
    });
    spotifyApi.setAccessToken(token.access_token);

    // Get current user's ID
    const meData = await spotifyApi.getMe();
    const userId = meData.body.id;

    // Create playlist
    const result = await spotifyApi.createPlaylist("Daily Drive by IBM Bob", {
      description: "Auto-generated by Daily Drive · IBM Bob",
      public: false,
    });

    const id   = result.body.id;
    const name = result.body.name;

    // Upload playlist cover image (JPEG, base64-encoded, max 256 KB)
    try {
      const coverPath = path.join(__dirname, "public", "img", "dailydrive.jpg");
      const coverB64  = fs.readFileSync(coverPath).toString("base64");
      const imgRes = await fetch(`https://api.spotify.com/v1/playlists/${id}/images`, {
        method:  "PUT",
        headers: {
          Authorization:  `Bearer ${token.access_token}`,
          "Content-Type": "image/jpeg",
        },
        body: coverB64,
      });
      if (!imgRes.ok) {
        const errBody = await imgRes.text().catch(() => "");
        throw new Error(`HTTP ${imgRes.status}: ${errBody}`);
      }
      logLine(`🖼️  Cover image set for playlist ${id}`);
    } catch (imgErr) {
      logLine(`⚠️  Could not set playlist cover: ${imgErr.message}`);
      // Non-fatal — playlist was created successfully
    }

    logLine(`✅ Created playlist "${name}" (${id}) for user ${userId}`);
    res.json({ id, name });
  } catch (err) {
    logLine("❌ create-playlist failed: " + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /setup/authorize  Start Spotify OAuth flow ───────────────────────────
app.get("/setup/authorize", (req, res) => {
  try {
    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});

    if (!creds.client_id || !creds.client_secret) {
      return res.redirect("/setup?step=1&error=Missing+Spotify+credentials");
    }

    const redirectUri = getRedirectUri(req);
    const spotifyApi  = new SpotifyWebApi({
      clientId:    creds.client_id,
      clientSecret:creds.client_secret,
      redirectUri,
    });

    const SCOPES = [
      "playlist-modify-public", "playlist-modify-private",
      "playlist-read-private",  "playlist-read-collaborative",
      "user-library-read",      "user-read-private",
      "user-read-recently-played", "user-top-read",
      "ugc-image-upload",
    ];

    // Use a different state value when the user is re-authorising (playlist
    // already configured) so /callback can redirect straight to the dashboard.
    const isReauth = !!(config.playlist_id && config.playlist_id !== "your-playlist-id-here");
    const authUrl = spotifyApi.createAuthorizeURL(SCOPES, isReauth ? "dailydrive_reauth" : "dailydrive");
    res.redirect(authUrl);
  } catch (err) {
    logLine("❌ /setup/authorize error: " + err.message);
    res.redirect("/setup?step=2&error=" + encodeURIComponent(err.message));
  }
});

// ── GET /callback  Spotify OAuth redirect ────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`/setup?step=2&error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect("/setup?step=2&error=No+authorization+code+received");
  }

  try {
    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});
    const redirectUri = getRedirectUri(req);

    const spotifyApi = new SpotifyWebApi({
      clientId:     creds.client_id,
      clientSecret: creds.client_secret,
      redirectUri,
    });

    const data = await spotifyApi.authorizationCodeGrant(code);
    tokenManager.saveToken({
      access_token:  data.body.access_token,
      refresh_token: data.body.refresh_token,
      expires_at:    Date.now() + data.body.expires_in * 1000,
    });

    logLine("✅ Spotify OAuth successful — token saved");
    const { state } = req.query;
    res.redirect(state === "dailydrive_reauth" ? "/?reauth=1" : "/setup?step=3");
  } catch (err) {
    logLine("❌ OAuth token exchange failed: " + err.message);
    res.redirect(`/setup?step=2&error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /setup/callback-paste  Spotify OAuth redirect paste (LAN/NAS fallback) ──────
app.post("/setup/callback-paste", async (req, res) => {
  const { callback_url } = req.body;
  if (!callback_url) {
    return res.redirect("/setup?step=2&error=No+URL+provided");
  }

  try {
    const trimmedUrl = callback_url.trim();
    const urlObj = new URL(trimmedUrl);
    const code = urlObj.searchParams.get("code");
    const error = urlObj.searchParams.get("error");
    const state = urlObj.searchParams.get("state");

    if (error) {
      return res.redirect(`/setup?step=2&error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return res.redirect("/setup?step=2&error=No+authorization+code+found+in+the+URL");
    }

    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});

    // Reconstruct the exact redirectUri used in the authorize link
    const redirectUri = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

    const spotifyApi = new SpotifyWebApi({
      clientId:     creds.client_id,
      clientSecret: creds.client_secret,
      redirectUri,
    });

    const data = await spotifyApi.authorizationCodeGrant(code);
    tokenManager.saveToken({
      access_token:  data.body.access_token,
      refresh_token: data.body.refresh_token,
      expires_at:    Date.now() + data.body.expires_in * 1000,
    });

    logLine("✅ Spotify OAuth successful via URL copy-paste — token saved");
    res.redirect(state === "dailydrive_reauth" ? "/?reauth=1" : "/setup?step=3");
  } catch (err) {
    logLine("❌ OAuth token exchange via URL copy-paste failed: " + err.message);
    res.redirect(`/setup?step=2&error=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /reauth  Re-authorization page (NAS-aware) ───────────────────────────
app.get("/reauth", (req, res) => {
  const config      = loadConfig();
  const creds       = resolveSpotifyCredentials(config.spotify || {});
  const redirectUri = getRedirectUri(req);

  let isLanHttp = false;
  let loopbackRedirectUri = redirectUri;
  try {
    const u = new URL(redirectUri);
    isLanHttp = u.protocol === "http:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost";
    loopbackRedirectUri = `${u.protocol}//127.0.0.1${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch (_) {}

  if (!isLanHttp) {
    // Direct flow: just kick off OAuth immediately
    return res.redirect("/setup/authorize");
  }

  // NAS / LAN mode: show copy-paste instructions
  render(res, "reauth", {
    page:                "reauth",
    title:               "Re-authorize Spotify",
    redirectUri,
    loopbackRedirectUri,
    flash:               req.query.error ? { type: "error", message: req.query.error } : null,
  });
});

// ── GET /setup/done  Show success page after playlist step ───────────────────
app.get("/setup/done", (req, res) => {
  const config = loadConfig();
  const creds  = resolveSpotifyCredentials(config.spotify || {});
  render(res, "setup", {
    page:        "setup_success",
    title:       "Setup complete",
    step:        3,
    config,
    credentials: creds,
    redirectUri: getRedirectUri(req),
    flash:       null,
  });
});

// ── GET /config  Config editor ───────────────────────────────────────────────
app.get("/config", (req, res) => {
  const config = loadConfig();
  const configErrorFlash = req.query.error
    ? { type: "error", message: req.query.error }
    : null;
  render(res, "config", {
    page:            "config",
    title:           "Configuration",
    config,
    redirectUri:     process.env.SPOTIFY_REDIRECT_URI ||
                     `http://${req.headers.host}/callback`,
    refreshInterval: config.refresh_interval || getRefreshH(),
    saved:           req.query.saved === "1",
    fromSetup:       req.query.setup === "1",
    flash:           configErrorFlash,
  });
});

// ── POST /config  Save config ────────────────────────────────────────────────
app.post("/config", (req, res) => {
  try {
  const existing = loadConfig();
  const b = req.body;

  const cfg = {
    spotify: {
      client_id:    (b.client_id    || existing.spotify?.client_id    || "").trim(),
      client_secret:(b.client_secret && b.client_secret.trim() !== "(unchanged)" && b.client_secret.trim() !== "")
                      ? b.client_secret.trim()
                      : (existing.spotify?.client_secret || ""),
      redirect_uri: (b.redirect_uri || existing.spotify?.redirect_uri ||
                     `http://${req.headers.host}/callback`).trim(),
    },
    playlist_id: (b.playlist_id || "").trim(),
    podcasts: [],
    music: {
      top_tracks: {
        enabled:    b.top_tracks_enabled === "1",
        time_range: b.time_range || "short_term",
        count:      30,
      },
      saved_tracks: {
        enabled: b.saved_tracks_enabled === "1",
        count:   parseInt(b.saved_tracks_count || "50", 10),
      },
      genres:      (b.genres || "").split(/[,;\n\r]+/).map(s => s.trim()).filter(Boolean),
      playlists:   [],
      total_songs: parseInt(b.total_songs || "15", 10),
      shuffle:     b.shuffle === "1",
    },
    mix_pattern:      (b.mix_pattern || "PMMMM").trim().toUpperCase(),
    refresh_interval: parseInt(b.refresh_interval, 10) || existing.refresh_interval || 24,
    schedule:         existing.schedule || {},
  };

  // Podcasts
  const podNames     = [].concat(b.podcast_name     || b["podcast_name[]"]     || []);
  const podIds       = [].concat(b.podcast_id       || b["podcast_id[]"]       || []);
  const podEpisodes  = [].concat(b.podcast_episodes || b["podcast_episodes[]"] || []);
  const pinnedId     = (b.podcast_pin_id || "").trim();

  podIds.forEach((id, i) => {
    if (!id.trim()) return;
    const trimmedId = id.trim();
    const pod = {
      id:       trimmedId,
      name:     (podNames[i] || "").trim() || trimmedId,
      episodes: parseInt(podEpisodes[i] || "1", 10),
    };
    if (pinnedId && pinnedId !== "-1" && trimmedId === pinnedId) {
      pod.position = "first";
    }
    cfg.podcasts.push(pod);
  });

  cfg.podcast_alternate = b.podcast_alternate === "1";

  // Source playlists
  const plNames = [].concat(b.pl_name || b["pl_name[]"] || []);
  const plIds   = [].concat(b.pl_id   || b["pl_id[]"]   || []);
  plIds.forEach((id, i) => {
    if (!id.trim()) return;
    cfg.music.playlists.push({ id: id.trim(), name: (plNames[i] || "").trim() || id.trim() });
  });

  const prevH = getRefreshH();
  saveConfig(cfg);

  // Restart scheduler if refresh interval changed
  const newH = cfg.refresh_interval;
  if (newH !== prevH) {
    process.env.REFRESH_INTERVAL_HOURS = String(newH);
    startScheduler();
  }

  logLine("💾 Configuration saved via web UI");
  res.redirect("/?ok=Configuration+saved");
  } catch (err) {
    logLine("❌ /config save error: " + err.message);
    res.redirect("/config?error=" + encodeURIComponent(err.message));
  }
});

// ── POST /refresh  Manual trigger ────────────────────────────────────────────
let _refreshRunning = false;

app.post("/refresh", async (req, res) => {
  if (_refreshRunning) {
    return res.status(400).json({ ok: false, error: "Refresh already running" });
  }
  _refreshRunning = true;

  try {
    logLine("▶️  Manual playlist refresh triggered via web UI");
    await runRefresh();
    _lastRefreshTime = new Date();
    logLine("✅ Manual refresh complete");
    res.json({ ok: true });
  } catch (err) {
    logLine("❌ Manual refresh failed: " + err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    _refreshRunning = false;
  }
});

// ── GET /logs  Log viewer ─────────────────────────────────────────────────────
app.get("/logs", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(PATHS.LOG_DIR, `${today}.log`);

  let logContent = "";
  if (fs.existsSync(logFile)) {
    const raw = fs.readFileSync(logFile, "utf8");
    // Return last 200 lines
    logContent = raw.split("\n").slice(-200).join("\n");
  }

  if (req.query.raw === "1") {
    res.type("text/plain").send(logContent);
    return;
  }

  const errorFlash = req.query.error
    ? { type: "error", message: req.query.error }
    : null;

  render(res, "logs", {
    page:       "logs",
    title:      "Logs",
    logContent,
    flash:      errorFlash,
  });
});

// ── GET /about ────────────────────────────────────────────────────────────────
app.get("/about", (req, res) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  render(res, "about", {
    page:    "about",
    title:   "About",
    version: pkg.version,
  });
});

// ── GET /api/user-playlists  Get current user's playlists ─────────────────────
app.get("/api/user-playlists", async (req, res) => {
  try {
    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});
    const token  = await tokenManager.refreshTokenIfNeeded();

    if (!token || !token.access_token) {
      return res.status(401).json({ error: "Not authenticated — complete Step 3 first" });
    }

    const spotifyApi = new SpotifyWebApi({
      clientId:     creds.client_id,
      clientSecret: creds.client_secret,
    });
    spotifyApi.setAccessToken(token.access_token);

    const [playlistData, meData] = await Promise.all([
      spotifyApi.getUserPlaylists({ limit: 50 }),
      spotifyApi.getMe(),
    ]);
    const myUserId = meData.body.id;
    const playlists = playlistData.body.items.map(item => ({
      id: item.id,
      name: item.name,
      images: item.images,
      owner: item.owner?.display_name,
      owner_id: item.owner?.id,
      is_own: item.owner?.id === myUserId,
    }));

    res.json(playlists);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/user-podcasts  Get current user's followed shows ──────────────────
app.get("/api/user-podcasts", async (req, res) => {
  try {
    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});
    const token  = await tokenManager.refreshTokenIfNeeded();

    if (!token || !token.access_token) {
      return res.status(401).json({ error: "Not authenticated — complete Step 3 first" });
    }

    const spotifyApi = new SpotifyWebApi({
      clientId:     creds.client_id,
      clientSecret: creds.client_secret,
    });
    spotifyApi.setAccessToken(token.access_token);

    const data = await spotifyApi.getMySavedShows({ limit: 50 });
    const shows = data.body.items.map(entry => ({
      id: entry.show?.id,
      name: entry.show?.name,
      publisher: entry.show?.publisher,
      images: entry.show?.images,
    }));

    res.json(shows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/search  Search Spotify for playlists or shows ─────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const { q, type } = req.query; // type can be "playlist" or "show"
    if (!q) {
      return res.json([]);
    }

    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});
    const token  = await tokenManager.refreshTokenIfNeeded();

    if (!token || !token.access_token) {
      return res.status(401).json({ error: "Not authenticated — complete Step 3 first" });
    }

    const spotifyApi = new SpotifyWebApi({
      clientId:     creds.client_id,
      clientSecret: creds.client_secret,
    });
    spotifyApi.setAccessToken(token.access_token);

    let results = [];
    if (type === "show") {
      const data = await spotifyApi.searchShows(q, { limit: 10 });
      results = data.body.shows.items.map(item => ({
        id: item.id,
        name: item.name,
        publisher: item.publisher,
        images: item.images,
      }));
    } else {
      const data = await spotifyApi.searchPlaylists(q, { limit: 10 });
      results = data.body.playlists.items.map(item => ({
        id: item.id,
        name: item.name,
        images: item.images,
        owner: item.owner?.display_name,
      }));
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/playlist-info/:id  Name + image for a single playlist ────────────
app.get("/api/playlist-info/:id", async (req, res) => {
  try {
    const token = await tokenManager.refreshTokenIfNeeded();
    if (!token || !token.access_token) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const apiRes = await fetch(
      `https://api.spotify.com/v1/playlists/${req.params.id}?fields=id,name,images,owner`,
      { headers: { Authorization: `Bearer ${token.access_token}` } }
    );
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: "Spotify API error" });
    const data = await apiRes.json();
    res.json({
      id:    data.id,
      name:  data.name,
      image: data.images?.[0]?.url || null,
      owner: data.owner?.display_name || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/status  JSON status (for polling) ───────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    ...getAppStatus(),
    lastRefresh: _lastRefreshTime,
    nextRefresh: nextRefreshString(),
    refreshRunning: _refreshRunning,
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let _schedulerTask = null;

function startScheduler() {
  if (_schedulerTask) {
    _schedulerTask.stop();
    _schedulerTask = null;
  }
  // Convert REFRESH_INTERVAL_HOURS to a cron expression
  // Simple approach: run every N hours at :00
  const hours = Math.max(1, Math.min(168, getRefreshH()));

  let cronExpr;
  if (hours === 24) {
    cronExpr = "0 4 * * *"; // daily at 04:00
  } else if (hours >= 1 && hours < 24) {
    // Every N hours
    cronExpr = `0 */${hours} * * *`;
  } else {
    // > 24h: approximate (every N/24 days at 04:00)
    const days = Math.round(hours / 24);
    cronExpr = `0 4 */${days} * *`;
  }

  logLine(`⏰ Scheduler starting — cron: "${cronExpr}" (every ${hours}h)`);

  _schedulerTask = cron.schedule(cronExpr, async () => {
    if (_refreshRunning) {
      logLine("⏭️  Skipping scheduled refresh — already running");
      return;
    }
    _refreshRunning = true;
    try {
      logLine("▶️  Scheduled playlist refresh starting…");
      await runRefresh();
      _lastRefreshTime = new Date();
      logLine("✅ Scheduled refresh complete");
    } catch (err) {
      logLine("❌ Scheduled refresh failed: " + err.message);
    } finally {
      _refreshRunning = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(WEB_PORT, "0.0.0.0", () => {
  logLine(`🚀 Daily Drive by IBM Bob — Web UI started on port ${WEB_PORT}`);
  logLine(`   Data directory : ${PATHS.DATA_DIR}`);
  logLine(`   Refresh every  : ${getRefreshH()} hour(s)`);

  // Start background token refresh daemon (check every 30 min)
  tokenManager.startTokenRefreshDaemon(30 * 60 * 1000);

  // Start the playlist refresh scheduler
  startScheduler();
});

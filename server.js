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
const { PATHS, resolveSpotifyCredentials } = require("./paths");
const tokenManager = require("./token-manager");
const { OAuthSpotifyClient } = require("./spotify-client-oauth");
const { createSpotifyClient } = require("./spotify-client-factory");
const { NotSupportedError } = require("./spotify-client-base");
const { setLogger: setCookieLogger } = require("./spotify-client-cookie");
const { setLogger: setOAuthLogger } = require("./spotify-client-oauth");
const { main: runRefresh, setLogger: setIndexLogger, SpotifyQuotaError } = require("./index");
const { createLogger, resolveLogLevel } = require("./logger");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WEB_PORT         = parseInt(process.env.WEB_PORT  || "8080", 10);
const REFRESH_INTERVAL_DEFAULT = "24h";

// Helper to parse interval strings like "30m", "1h", "2h", or plain numbers (treated as hours or minutes if formatted)
function parseIntervalToMinutes(val) {
  if (val == null) return 24 * 60;
  const str = String(val).trim().toLowerCase();
  if (!str) return 24 * 60;

  const match = str.match(/^(\d+(?:\.\d+)?)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days)?$/);
  if (!match) {
    const num = parseFloat(str);
    return isNaN(num) || num <= 0 ? 24 * 60 : Math.round(num * 60);
  }

  const num = parseFloat(match[1]);
  const unit = match[2] || "h"; // default unit is hours if not specified

  if (unit.startsWith("m")) {
    return Math.max(1, Math.round(num));
  } else if (unit.startsWith("d")) {
    return Math.max(1, Math.round(num * 24 * 60));
  } else {
    // hours
    return Math.max(1, Math.round(num * 60));
  }
}

// Priority: config.yaml > REFRESH_INTERVAL_HOURS / REFRESH_INTERVAL env var > default
const getRefreshIntervalStr = () => {
  const fromConfig = loadConfig().refresh_interval;
  if (fromConfig != null && String(fromConfig).trim() !== "") return String(fromConfig).trim();
  return process.env.REFRESH_INTERVAL || process.env.REFRESH_INTERVAL_HOURS || REFRESH_INTERVAL_DEFAULT;
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
  // Colourise console output only (log file stays plain text)
  if (msg.startsWith("[ERROR]")) {
    console.log(`\x1b[1;97;41m${line}\x1b[0m`);   // bold white on red background
  } else if (msg.startsWith("[WARN]")) {
    console.log(`\x1b[1;33m${line}\x1b[0m`);      // bold yellow
  } else {
    console.log(line);
  }
  try {
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(PATHS.LOG_DIR, `${day}.log`), line + "\n");
  } catch (_) { /* best-effort */ }
}

/**
 * Build a level-aware logger and wire it into all modules.
 * Call once on startup and again whenever the config changes.
 */
function applyLogLevel() {
  const cfg = loadConfig();
  const level = resolveLogLevel(cfg);
  const logger = createLogger(logLine, level);
  setIndexLogger(logger);
  tokenManager.setLogger(logger);
  setCookieLogger(logger);
  setOAuthLogger(logger);
  return logger;
}

// Bootstrap logger — modules can receive calls before the first request
let _logger = applyLogLevel();
// Convenience shorthands used throughout server.js itself
const logInfo  = (...a) => _logger.info(...a);
const logWarn  = (...a) => _logger.warn(...a);
const logDebug = (...a) => _logger.debug(...a);
const logError = (...a) => _logger.error(...a);

// ---------------------------------------------------------------------------
// Log rotation — delete log files older than retainDays (default: 7)
// ---------------------------------------------------------------------------

function pruneOldLogs(retainDays = 7) {
  try {
    if (!fs.existsSync(PATHS.LOG_DIR)) return;
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    const deleted = [];
    for (const file of fs.readdirSync(PATHS.LOG_DIR)) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      if (new Date(m[1]).getTime() < cutoff) {
        try {
          fs.unlinkSync(path.join(PATHS.LOG_DIR, file));
          deleted.push(file);
        } catch (err) {
          logWarn(`pruneOldLogs: could not delete ${file}: ${err.message}`);
        }
      }
    }
    if (deleted.length > 0) {
      logInfo(`🗑️  pruneOldLogs: deleted ${deleted.length} old log file(s): ${deleted.join(", ")}`);
    }
  } catch (err) {
    logWarn(`pruneOldLogs: unexpected error: ${err.message}`);
  }
}

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
// Client factory helper — creates the right SpotifyClient for the current config
// ---------------------------------------------------------------------------

/**
 * Creates a SpotifyClient for the given config and credentials.
 *
 * @param {object} config  - Loaded config object (from loadConfig())
 * @param {object} creds   - Resolved credentials (from resolveSpotifyCredentials())
 * @returns {import('./spotify-client-base').SpotifyClientBase}
 */
function createClient(config, creds) {
  return createSpotifyClient(config.api_mode || "oauth", creds);
}

// ---------------------------------------------------------------------------
// Status helper — used by dashboard
// ---------------------------------------------------------------------------

function getAppStatus() {
  const config       = loadConfig();
  const creds        = resolveSpotifyCredentials(config.spotify || {});
  const tokenStatus  = tokenManager.getTokenStatus();
  const now = new Date();
  const quotaActive = !!(_quotaRetryAfter && _quotaRetryAfter > now);
  const apiMode = config.api_mode || "oauth";

  // In cookie mode credentials are an sp_dc cookie (no client_id/secret needed)
  const cookieSessionPath = path.join(PATHS.DATA_DIR, ".cookie-session.json");
  const hasCredentials = apiMode === "cookie"
    ? !!(creds.sp_dc || fs.existsSync(cookieSessionPath))
    : !!(creds.client_id && creds.client_secret);

  // In cookie mode the OAuth token manager is not used — check cookie session file instead
  let tokenValid = tokenStatus.valid;
  let expiresAt  = tokenStatus.expiresAt;
  if (apiMode === "cookie") {
    try {
      if (fs.existsSync(cookieSessionPath)) {
        const session = JSON.parse(fs.readFileSync(cookieSessionPath, "utf-8"));
        tokenValid = !!(session.access_token && (!session.expires_at || session.expires_at > Date.now()));
        expiresAt  = session.expires_at ? new Date(session.expires_at) : null;
      }
    } catch (_) {}
  }

  return {
    hasCredentials,
    tokenValid,
    expiresAt,
    hasRefreshToken: tokenStatus.hasRefreshToken,
    hasPlaylist:     !!(config.playlist_id && config.playlist_id !== "your-playlist-id-here"),
    hasPodcasts:     !!(config.podcasts && config.podcasts.length > 0),
    quotaActive,
    quotaRetryAfter: quotaActive ? _quotaRetryAfter : null,
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
let _lastRefreshError = null; // string | null — error message of the most recent failed refresh

// When Spotify returns 429, we store the earliest time we may retry here.
// The scheduler and manual refresh both check this before running.
let _quotaRetryAfter = null; // Date | null

// One-shot setTimeout that fires 10 min after the quota cooldown ends,
// in case the next regular cron slot would be after the cooldown.
let _quotaRetryTimer = null;

/**
 * Schedules a one-shot refresh 10 minutes after the quota cooldown ends,
 * but only if that time is AFTER the next regular cron slot (otherwise
 * the normal scheduler will pick it up anyway).
 */
function scheduleQuotaRetry(retryAfterDate) {
  // Cancel any previously scheduled quota retry
  if (_quotaRetryTimer) {
    clearTimeout(_quotaRetryTimer);
    _quotaRetryTimer = null;
  }

  const fireAt = new Date(retryAfterDate.getTime() + 10 * 60 * 1000); // cooldown end + 10 min
  const nextCron = nextRefreshDate();

  // No extra timer needed only if the next cron slot fires AFTER the cooldown ends —
  // meaning the cron itself will run cleanly without hitting the limit.
  // In all other cases (nextCron <= retryAfterDate) the cron would be skipped,
  // so we must schedule the one-shot timer.
  if (nextCron > retryAfterDate) {
    logDebug(`Next cron slot (${nextCron.toISOString()}) is after quota cooldown (${retryAfterDate.toISOString()}) — no extra timer needed`);
    return;
  }

  const delayMs = fireAt.getTime() - Date.now();
  logInfo(`Quota retry scheduled for ${fireAt.toISOString()} (${Math.round(delayMs / 60000)} min from now)`);

  _quotaRetryTimer = setTimeout(async () => {
    _quotaRetryTimer = null;
    if (_refreshRunning) {
      logDebug("Quota retry skipped — refresh already running");
      return;
    }
    // Double-check: quota may have been re-hit since we scheduled this
    if (_quotaRetryAfter && _quotaRetryAfter > new Date()) {
      logDebug("Quota retry skipped — rate limit still active");
      return;
    }
    _refreshRunning = true;
    logInfo("▶️  Quota retry refresh starting…");
    try {
      await runRefresh();
      _lastRefreshTime = new Date();
      _lastRefreshError = null;
      _quotaRetryAfter = null;
      logInfo("✅ Quota retry refresh complete");
    } catch (err) {
      if (err && err.name === "SpotifyQuotaError") {
        _quotaRetryAfter = new Date(Date.now() + (err.retryAfter || 60) * 1000);
        _lastRefreshError = err.message;
        logWarn(`Quota retry hit rate limit again — next retry at ${_quotaRetryAfter.toISOString()}`);
        scheduleQuotaRetry(_quotaRetryAfter); // reschedule
      } else {
        _lastRefreshError = err.message;
        logError("Quota retry refresh failed: " + err.message);
      }
    } finally {
      _refreshRunning = false;
    }
  }, delayMs);
}

/**
 * Calculate the next scheduled fire time directly from REFRESH_H,
 * matching the cron expressions set in startScheduler().
 * Works correctly immediately after server start (no prior run needed).
 */
function nextRefreshDate() {
  const now = new Date();
  const totalMinutes = parseIntervalToMinutes(getRefreshIntervalStr());
  let next;

  if (totalMinutes === 24 * 60) {
    // daily at 04:00
    next = new Date(now);
    next.setHours(4, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (totalMinutes < 60) {
    // Under 1 hour: cron `*/M * * * *` (e.g. */30)
    const currentMin = now.getMinutes();
    const nextMin = (Math.floor(currentMin / totalMinutes) + 1) * totalMinutes;
    next = new Date(now);
    next.setSeconds(0, 0);
    if (nextMin >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMin % 60);
    } else {
      next.setMinutes(nextMin);
    }
  } else if (totalMinutes < 24 * 60) {
    // Every N hours
    const hours = Math.round(totalMinutes / 60);
    const currentHour = now.getHours();
    const nextHour = (Math.floor(currentHour / hours) + 1) * hours;
    next = new Date(now);
    next.setMinutes(0, 0, 0);
    if (nextHour >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(nextHour % 24);
    } else {
      next.setHours(nextHour);
    }
  } else {
    // >= 24h: every N days at 04:00
    const days = Math.round(totalMinutes / (24 * 60));
    next = new Date(now);
    next.setHours(4, 0, 0, 0);
    next.setDate(next.getDate() + days);
  }

  // If a quota retry timer is scheduled, always show its fire time —
  // the timer was created precisely because the next cron slot is too early.
  if (_quotaRetryTimer !== null && _quotaRetryAfter) {
    return new Date(_quotaRetryAfter.getTime() + 10 * 60 * 1000);
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
  // Inject current quota state so layout.ejs can show the warning banner
  const now = new Date();
  const quotaActive = !!(_quotaRetryAfter && _quotaRetryAfter > now);
  const quotaRetryAfter = quotaActive ? _quotaRetryAfter : null;

  // Render inner view to string, then wrap in layout
  res.render(view, locals, (err, body) => {
    if (err) {
      console.error("Render error:", err);
      return res.status(500).send("Template error: " + err.message);
    }
    res.render("layout", {
      ...locals,
      body,
      title: locals.title || "Daily Drive",
      showLanWarning: SHOW_LAN_WARNING,
      quotaActive,
      quotaRetryAfter,
    });
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
  const config = loadConfig();
  // Ensure OAuth token is refreshed proactively if expired/expiring — not needed in cookie mode
  if ((config.api_mode || "oauth") === "oauth") {
    await tokenManager.refreshTokenIfNeeded().catch(() => {});
  }
  const status = getAppStatus();
  const state  = loadState();

  let playlistTracks = [];
  let playlistError = null;
  let isLive = false;

  // Skip live Spotify fetch while rate-limited — every request would just produce more 429s
  if (status.hasCredentials && status.hasPlaylist && !status.quotaActive) {
    let dashClient;
    try {
      const creds = resolveSpotifyCredentials(config.spotify);
      const apiMode = config.api_mode || "oauth";
      dashClient = createSpotifyClient(apiMode, creds);
      await dashClient.initialize({ daemon: false });

      const items = await dashClient.getPlaylistItems(config.playlist_id, { limit: 100, tracksOnly: false });
      for (const item of items) {
        playlistTracks.push(item);
      }
      // Paginate if needed
      if (items._total && items._total > 100) {
        let offset = 100;
        while (offset < items._total) {
          const more = await dashClient.getPlaylistItems(config.playlist_id, { limit: 100, offset, tracksOnly: false });
          for (const item of more) playlistTracks.push(item);
          offset += 100;
        }
      }
      isLive = true;
    } catch (err) {
      if (err && err.name === "SpotifyQuotaError") {
        // Rate-limited — set global quota state so subsequent page loads skip the live fetch
        _quotaRetryAfter = new Date(Date.now() + (err.retryAfter || 60) * 1000);
        scheduleQuotaRetry(_quotaRetryAfter);
        logWarn(`[dashboard] Rate-limited fetching playlist — suppressing live fetch until ${_quotaRetryAfter.toISOString()}`);
      } else {
        logError(`[dashboard] Failed to fetch live playlist tracks: ${err.message}`);
      }
      playlistError = err.message;
    } finally {
      if (dashClient) dashClient.stopDaemon();
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
    lastRefreshError: _lastRefreshError,
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

// ── POST /setup/credentials  Save credentials, go to step 2 (OAuth) or step 3 (Cookie) ──
app.post("/setup/credentials", async (req, res) => {
  try {
    const config = loadConfig();
    if (!config.spotify) config.spotify = {};

    const { client_id, client_secret, redirect_uri, api_mode, sp_dc } = req.body;

    // Save api_mode (default to oauth)
    config.api_mode = (api_mode === "cookie") ? "cookie" : "oauth";

    if (config.api_mode === "cookie") {
      // Cookie mode: save sp_dc cookie, attempt login
      if (sp_dc && sp_dc.trim()) config.spotify.sp_dc = sp_dc.trim();
      saveConfig(config);
      try {
        const { CookieSpotifyClient } = require("./spotify-client-cookie");
        const cookieClient = new CookieSpotifyClient({ sp_dc: config.spotify.sp_dc });
        await cookieClient.initialize();
        logInfo("✅ Cookie-mode Spotify login successful");
      } catch (loginErr) {
        logError("Cookie-mode login failed: " + loginErr.message);
        return res.redirect("/setup?step=1&error=" + encodeURIComponent("Login fehlgeschlagen: " + loginErr.message));
      }
      return res.redirect("/setup?step=3");
    }

    // OAuth mode: save client_id/secret as before
    if (client_id)     config.spotify.client_id    = client_id.trim();
    if (client_secret && client_secret !== "••••••••")
                       config.spotify.client_secret = client_secret.trim();
    if (redirect_uri)  config.spotify.redirect_uri  = redirect_uri.trim();

    saveConfig(config);
    res.redirect("/setup?step=2");
  } catch (err) {
    logError("/setup/credentials error: " + err.message);
    res.redirect("/setup?step=1&error=" + encodeURIComponent(err.message));
  }
});

// ── POST /api/test-cookie-login  Diagnose cookie-mode login step by step ───────
app.post("/api/test-cookie-login", async (req, res) => {
  const steps = [];
  const log = (msg) => { steps.push(msg); logLine("[cookie-test] " + msg); };

  try {
    log("🔍 Starte Cookie-Mode Diagnose…");

    // 1. open.spotify.com laden
    log("1/5 Lade open.spotify.com …");
    const homeRes = await fetch("https://open.spotify.com/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
    });
    log(`    HTTP ${homeRes.status} ${homeRes.ok ? "✅" : "❌"}`);
    if (!homeRes.ok) return res.json({ ok: false, steps });

    const html = await homeRes.text();
    log(`    HTML empfangen (${(html.length / 1024).toFixed(0)} KB)`);

    // 2. JS-Links extrahieren
    const jsLinkRe = /["'](https?:\/\/[^"']+\.js(?:\?[^"']*)?)["']/gi;
    const jsLinks = new Set();
    let m;
    while ((m = jsLinkRe.exec(html)) !== null) {
      if (m[1].includes("spotify")) jsLinks.add(m[1]);
    }
    log(`2/5 JS-Links gefunden: ${jsLinks.size}`);
    for (const l of jsLinks) log(`    • ${l.split("/").pop().split("?")[0]}`);

    // 3. Bundles laden, web-player identifizieren
    log("3/5 Lade JS-Bundles …");
    let webPlayerCode = "";
    let webPlayerUrl = "";
    for (const url of jsLinks) {
      const filename = url.split("/").pop().split("?")[0];
      try {
        const bRes = await fetch(url);
        const code = bRes.ok ? await bRes.text() : "";
        const hasSecret = /secret\s*:\s*["']/i.test(code);
        log(`    ${filename} (${(code.length/1024).toFixed(0)} KB) — secret: ${hasSecret ? "✅" : "❌"}`);
        if (filename.startsWith("web-player.") && bRes.ok) {
          webPlayerCode = code;
          webPlayerUrl = filename;
        }
      } catch (e) {
        log(`    ${filename} — Fehler: ${e.message}`);
      }
    }

    if (!webPlayerCode) {
      log("❌ Kein web-player.* Bundle gefunden — kein TOTP-Secret extrahierbar");
      return res.json({ ok: false, steps });
    }
    log(`    Verwende: ${webPlayerUrl}`);

    // 4. TOTP-Secret extrahieren
    log("4/5 Extrahiere TOTP-Secret …");
    const secretRe = /secret\s*:\s*(["'])(.*?)\1\s*,?\s*version\s*:\s*(\d+)/gis;
    const secrets = [];
    let sm;
    while ((sm = secretRe.exec(webPlayerCode)) !== null) {
      secrets.push({ secret: sm[2], version: parseInt(sm[3], 10) });
    }
    log(`    Gefunden: ${secrets.length} Secret(s) — Versionen: ${secrets.map(s => "v" + s.version).join(", ")}`);
    if (secrets.length === 0) {
      log("❌ Kein TOTP-Secret gefunden — Regex-Treffer prüfen");
      return res.json({ ok: false, steps });
    }
    secrets.sort((a, b) => b.version - a.version);
    const { secret, version } = secrets[0];
    log(`    Verwende v${version}, Secret-Länge: ${secret.length} Zeichen`);

    // 5. TOTP berechnen + Token abrufen (mit sp_dc Cookie falls vorhanden)
    log("5/5 Berechne TOTP und rufe Token ab …");
    const xored = [];
    for (let i = 0; i < secret.length; i++) {
      xored.push(secret.charCodeAt(i) ^ ((i % 33) + 9));
    }
    const joined = xored.map(n => String(n)).join("");
    const hexStr = Array.from(joined).map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const secretBytes = Buffer.from(hexStr, "hex");

    const crypto = require("crypto");
    const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(counter, 0);
    const hmac = crypto.createHmac("sha1", secretBytes);
    hmac.update(msg);
    const digest = hmac.digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const totp = String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
    log(`    TOTP: ${totp} (v${version})`);

    // sp_dc: prefer value sent from form field, fall back to saved config
    const spDc = (req.body && req.body.sp_dc && req.body.sp_dc.trim())
      ? req.body.sp_dc.trim()
      : (() => { const cfg = loadConfig(); return cfg.spotify && cfg.spotify.sp_dc ? cfg.spotify.sp_dc : ""; })();
    const tokenHeaders = {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (spDc) {
      tokenHeaders["Cookie"] = `sp_dc=${spDc}`;
      log(`    sp_dc Cookie vorhanden (${spDc.length} Zeichen) ✅`);
    } else {
      log(`    ⚠ Kein sp_dc Cookie konfiguriert — Token wird anonym sein`);
    }

    const tokenUrl = `https://open.spotify.com/api/token?reason=init&productType=web-player&totp=${totp}&totpServer=${totp}&totpVer=${version}`;
    const tokenRes = await fetch(tokenUrl, { headers: tokenHeaders });
    const tokenData = await tokenRes.json().catch(() => ({}));

    const isAnon = tokenData.isAnonymous !== false;
    log(`    Token-Endpoint HTTP ${tokenRes.status} — accessToken: ${!!tokenData.accessToken ? "✅" : "❌"} — isAnonymous: ${isAnon}`);

    if (!tokenData.accessToken) {
      log("❌ Kein Access-Token erhalten");
      return res.json({ ok: false, steps });
    }

    if (isAnon) {
      log("❌ Token ist anonym — sp_dc Cookie fehlt oder ist abgelaufen.");
      log("");
      log("📋 So erhältst du den sp_dc Cookie:");
      log("   1. Öffne https://open.spotify.com im Browser und melde dich an.");
      log("   2. Öffne die Browser-DevTools (F12) → Reiter 'Application' (Chrome) oder 'Storage' (Firefox).");
      log("   3. Navigiere zu Cookies → https://open.spotify.com");
      log("   4. Kopiere den Wert des Cookies 'sp_dc'.");
      log("   5. Füge ihn im Feld 'sp_dc Cookie' im Setup-Wizard / Config ein.");
      return res.json({ ok: false, steps });
    }

    log("✅ Cookie-Mode Login-Diagnose erfolgreich! Nutzer ist eingeloggt.");
    return res.json({ ok: true, steps });
  } catch (err) {
    steps.push("❌ Unerwarteter Fehler: " + err.message);
    return res.json({ ok: false, steps });
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
    logError("/setup/playlist error: " + err.message);
    res.redirect("/setup?step=3&error=" + encodeURIComponent(err.message));
  }
});

// ── POST /api/create-playlist  Create a new empty Daily Drive playlist ────────
app.post("/api/create-playlist", async (req, res) => {
  let client;
  try {
    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});
    client = createClient(config, creds);
    await client.initialize({ daemon: false });

    // Get current user's ID
    const me     = await client.getMe();
    const userId = me.id;

    // Create playlist
    const { id, name } = await client.createPlaylist("Daily Drive by IBM Bob", {
      description: "Auto-generated by Daily Drive · IBM Bob",
      public: false,
    });

    // Upload playlist cover image
    try {
      const coverPath = path.join(__dirname, "public", "img", "playlist-cover.jpg");
      const coverBuf  = fs.readFileSync(coverPath);
      await client.setPlaylistCoverImage(id, coverBuf);
      logInfo(`Cover image set for playlist ${id}`);
    } catch (imgErr) {
      if (imgErr.name === "NotSupportedError") {
        logDebug("Cover image not supported in current API mode — skipping");
      } else {
        logWarn(`Could not set playlist cover: ${imgErr.message}`);
        // Non-fatal — playlist was created successfully
      }
    }

    logInfo(`✅ Created playlist "${name}" (${id}) for user ${userId}`);
    res.json({ id, name });
  } catch (err) {
    logError("create-playlist failed: " + err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.stopDaemon();
  }
});

// ── GET /setup/authorize  Start Spotify OAuth flow ───────────────────────────
app.get("/setup/authorize", (req, res) => {
  try {
    const config = loadConfig();
    if ((config.api_mode || "oauth") !== "oauth") {
      return res.status(400).json({ error: "This endpoint is only available in OAuth mode" });
    }

    const creds = resolveSpotifyCredentials(config.spotify || {});
    if (!creds.client_id || !creds.client_secret) {
      return res.redirect("/setup?step=1&error=Missing+Spotify+credentials");
    }

    const redirectUri = getRedirectUri(req);
    const oauthClient = new OAuthSpotifyClient({ ...creds, redirect_uri: redirectUri });

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
    const authUrl = oauthClient.getOAuthUrl(SCOPES, isReauth ? "dailydrive_reauth" : "dailydrive");
    res.redirect(authUrl);
  } catch (err) {
    logError("/setup/authorize error: " + err.message);
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
    if ((config.api_mode || "oauth") !== "oauth") {
      return res.status(400).json({ error: "This endpoint is only available in OAuth mode" });
    }

    const creds       = resolveSpotifyCredentials(config.spotify || {});
    const redirectUri = getRedirectUri(req);
    const oauthClient = new OAuthSpotifyClient({ ...creds, redirect_uri: redirectUri });

    await oauthClient.exchangeCode(code);

    logInfo("✅ Spotify OAuth successful — token saved");
    const { state } = req.query;
    res.redirect(state === "dailydrive_reauth" ? "/?reauth=1" : "/setup?step=3");
  } catch (err) {
    logError("OAuth token exchange failed: " + err.message);
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
    const config = loadConfig();
    if ((config.api_mode || "oauth") !== "oauth") {
      return res.status(400).json({ error: "This endpoint is only available in OAuth mode" });
    }

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

    const creds = resolveSpotifyCredentials(config.spotify || {});

    // Reconstruct the exact redirectUri used in the authorize link
    const redirectUri = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
    const oauthClient = new OAuthSpotifyClient({ ...creds, redirect_uri: redirectUri });

    await oauthClient.exchangeCode(code);

    logInfo("✅ Spotify OAuth successful via URL copy-paste — token saved");
    res.redirect(state === "dailydrive_reauth" ? "/?reauth=1" : "/setup?step=3");
  } catch (err) {
    logError("OAuth token exchange via URL copy-paste failed: " + err.message);
    res.redirect(`/setup?step=2&error=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /reauth  Re-authorization page (NAS-aware) ───────────────────────────
app.get("/reauth", (req, res) => {
  const config = loadConfig();
  if ((config.api_mode || "oauth") !== "oauth") {
    return res.status(400).json({ error: "This endpoint is only available in OAuth mode" });
  }
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
    refreshInterval: config.refresh_interval != null ? config.refresh_interval : getRefreshIntervalStr(),
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

  // api_mode
  const apiMode = (b.api_mode === "cookie") ? "cookie" : "oauth";

  // Cookie-mode: sp_dc cookie value
  // Guard against the placeholder '••••••••' rendered by config.ejs for existing values
  const rawSpDc = (b.spotify && b.spotify.sp_dc) ? b.spotify.sp_dc.trim() : '';
  const newSpDc = (rawSpDc && !rawSpDc.startsWith('•')) ? rawSpDc : null;

  const cfg = {
    api_mode: apiMode,
    spotify: {
      client_id:    (b.client_id    || existing.spotify?.client_id    || "").trim(),
      client_secret:(b.client_secret && b.client_secret.trim() !== "(unchanged)" && b.client_secret.trim() !== "")
                      ? b.client_secret.trim()
                      : (existing.spotify?.client_secret || ""),
      redirect_uri: (b.redirect_uri || existing.spotify?.redirect_uri ||
                     `http://${req.headers.host}/callback`).trim(),
      // sp_dc cookie for cookie mode (preserved from existing if not provided)
      ...(newSpDc ? { sp_dc: newSpDc } : (existing.spotify?.sp_dc ? { sp_dc: existing.spotify.sp_dc } : {})),
    },
    playlist_id: (b.playlist_id || "").trim(),
    podcasts: [],
    music: {
      top_tracks: {
        enabled:    b.top_tracks_enabled === "1",
        time_range: b.time_range || "short_term",
        count:      Math.min(Math.max(parseInt(b.top_tracks_count || "30", 10) || 0, 0), 50),
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
    refresh_interval: (b.refresh_interval != null && String(b.refresh_interval).trim() !== "")
      ? String(b.refresh_interval).trim()
      : (existing.refresh_interval || "24h"),
    schedule:         existing.schedule || {},
    // log_level: only persist if not overridden by ENV (ENV always takes precedence at runtime)
    ...(b.log_level ? { log_level: b.log_level.toLowerCase().trim() } : (existing.log_level ? { log_level: existing.log_level } : {})),
  };

  // Podcasts
  const podNames    = [].concat(b.podcast_name     || b["podcast_name[]"]     || []);
  const podIds      = [].concat(b.podcast_id       || b["podcast_id[]"]       || []);
  const podEpisodes = [].concat(b.podcast_episodes || b["podcast_episodes[]"] || []);
  const podModes    = [].concat(b.podcast_mode     || b["podcast_mode[]"]     || []);
  const pinnedId    = (b.podcast_pin_id || "").trim();
  const validModes  = new Set(["newest", "newest_unplayed", "oldest_unplayed"]);

  podIds.forEach((id, i) => {
    if (!id.trim()) return;
    const trimmedId = id.trim();
    const mode = podModes[i] && validModes.has(podModes[i]) ? podModes[i] : "newest";
    const pod = {
      id:       trimmedId,
      name:     (podNames[i] || "").trim() || trimmedId,
      episodes: parseInt(podEpisodes[i] || "1", 10),
      mode,
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

  const prevInterval = getRefreshIntervalStr();
  saveConfig(cfg);

  // Restart scheduler if refresh interval changed
  const newInterval = String(cfg.refresh_interval);
  if (newInterval !== prevInterval) {
    process.env.REFRESH_INTERVAL = newInterval;
    process.env.REFRESH_INTERVAL_HOURS = newInterval;
    startScheduler();
  }

  // Re-apply log level (ENV always wins, but config.log_level may have changed)
  _logger = applyLogLevel();

  logInfo("💾 Configuration saved via web UI");
  res.redirect("/?ok=Configuration+saved");
  } catch (err) {
    logError("/config save error: " + err.message);
    res.redirect("/config?error=" + encodeURIComponent(err.message));
  }
});

// ── POST /refresh  Manual trigger ────────────────────────────────────────────
let _refreshRunning = false;

app.post("/refresh", async (req, res) => {
  if (_refreshRunning) {
    return res.status(400).json({ ok: false, error: "Refresh already running" });
  }
  // Block manual refresh while Spotify rate-limit is still active
  if (_quotaRetryAfter && _quotaRetryAfter > new Date()) {
    return res.status(429).json({
      ok: false,
      error: "Spotify rate limit active",
      retryAfter: _quotaRetryAfter,
    });
  }
  _refreshRunning = true;

  try {
    logInfo("▶️  Manual playlist refresh triggered via web UI");
    await runRefresh();
    _lastRefreshTime = new Date();
    _lastRefreshError = null;
    _quotaRetryAfter = null;
    if (_quotaRetryTimer) { clearTimeout(_quotaRetryTimer); _quotaRetryTimer = null; }
    logInfo("✅ Manual refresh complete");
    res.json({ ok: true });
  } catch (err) {
    if (err && err.name === "SpotifyQuotaError") {
      _quotaRetryAfter = new Date(Date.now() + (err.retryAfter || 60) * 1000);
      _lastRefreshError = err.message;
      logWarn(`Spotify quota exceeded — next retry allowed at ${_quotaRetryAfter.toISOString()}`);
      scheduleQuotaRetry(_quotaRetryAfter);
      res.status(429).json({ ok: false, error: err.message, retryAfter: _quotaRetryAfter });
    } else {
      _lastRefreshError = err.message;
      logError("Manual refresh failed: " + err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
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
  let client;
  try {
    const config  = loadConfig();
    const apiMode = req.query.mode || config.api_mode || "oauth";
    const creds   = resolveSpotifyCredentials(config.spotify || {});
    client  = createSpotifyClient(apiMode, creds);
    await client.initialize({ daemon: false });

    const playlists = await client.getUserPlaylists({ limit: 50 });
    res.json(playlists);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.stopDaemon();
  }
});

// ── GET /api/user-podcasts  Get current user's followed shows ──────────────────
app.get("/api/user-podcasts", async (req, res) => {
  let client;
  try {
    const config  = loadConfig();
    const apiMode = req.query.mode || config.api_mode || "oauth";
    const creds   = resolveSpotifyCredentials(config.spotify || {});
    client  = createSpotifyClient(apiMode, creds);
    await client.initialize({ daemon: false });

    const shows = await client.getMySavedShows({ limit: 50 });
    res.json(shows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.stopDaemon();
  }
});

// ── GET /api/search  Search Spotify for playlists or shows ─────────────────────
app.get("/api/search", async (req, res) => {
  let client;
  try {
    const { q, type } = req.query; // type can be "playlist" or "show"
    if (!q) {
      return res.json([]);
    }

    const config  = loadConfig();
    const apiMode = req.query.mode || config.api_mode || "oauth";
    const creds   = resolveSpotifyCredentials(config.spotify || {});
    client  = createSpotifyClient(apiMode, creds);
    await client.initialize({ daemon: false });

    let results = [];
    if (type === "show") {
      results = await client.searchShows(q, { limit: 10 });
    } else {
      results = await client.searchPlaylists(q, { limit: 10 });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.stopDaemon();
  }
});

// ── GET /api/taste-prompt  Build LLM prompt from user's Spotify taste data ────
app.get("/api/taste-prompt", async (req, res) => {
  let client;
  try {
    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});
    client = createClient(config, creds);
    await client.initialize({ daemon: false });

    const artistCounts = {};
    const trackSamples = [];

    for (const range of ["short_term", "medium_term", "long_term"]) {
      const tracks = await client.getMyTopTracks({ limit: 50, time_range: range });
      for (const track of tracks) {
        const artists = track.artist ? track.artist.split(", ") : [];
        trackSamples.push({ name: track.name, artists });
        for (const artistName of artists) {
          artistCounts[artistName] = (artistCounts[artistName] || 0) + 1;
        }
      }
    }

    for (const range of ["short_term", "medium_term", "long_term"]) {
      const artists = await client.getMyTopArtists({ limit: 50, time_range: range });
      for (const artist of artists) {
        artistCounts[artist.name] = (artistCounts[artist.name] || 0) + 2;
      }
    }

    const topArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([name]) => name);

    const seen = new Set();
    const uniqueTracks = [];
    for (const t of trackSamples) {
      const key = `${t.name}|${t.artists[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueTracks.push(t);
      }
    }

    const artistList = topArtists.join(", ");
    const trackList = uniqueTracks
      .slice(0, 50)
      .map((t) => `${t.name} — ${t.artists.join(", ")}`)
      .join("\n");

    const prompt = `Based on this Spotify listening data, generate a list of 5-8 genre/style tags that best describe this user's music taste. These tags will be used as Spotify search queries (e.g., "genre:pop") to discover new music matching their taste.

Top artists (ranked by listening frequency):
${artistList}

Sample tracks:
${trackList}

Requirements:
- Return ONLY a list of genres, one per line, nothing else
- Use genres that work well as Spotify search queries
- Be specific enough to be useful (e.g., "synth pop" not just "pop")
- Cover the breadth of their taste, not just the most common genre
- Use lowercase

Example output format:
synth pop
indie rock
electronic
alt pop
dance pop`;

    res.json({ prompt, artistCount: topArtists.length, trackCount: uniqueTracks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.stopDaemon();
  }
});

// ── GET /api/playlist-info/:id  Name + image for a single playlist ────────────
app.get("/api/playlist-info/:id", async (req, res) => {
  let client;
  try {
    const config = loadConfig();
    const creds  = resolveSpotifyCredentials(config.spotify || {});
    client = createClient(config, creds);
    await client.initialize({ daemon: false });

    const info = await client.getPlaylistInfo(req.params.id);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.stopDaemon();
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
  const intervalStr = getRefreshIntervalStr();
  const totalMinutes = parseIntervalToMinutes(intervalStr);

  let cronExpr;
  let desc;

  if (totalMinutes < 60) {
    // Under 1 hour (e.g. 30m)
    const mins = totalMinutes;
    cronExpr = `*/${mins} * * * *`;
    desc = `every ${mins}m`;
  } else if (totalMinutes === 24 * 60) {
    cronExpr = "0 4 * * *"; // daily at 04:00
    desc = "daily at 04:00";
  } else if (totalMinutes < 24 * 60) {
    const hours = Math.round(totalMinutes / 60);
    cronExpr = `0 */${hours} * * *`;
    desc = `every ${hours}h`;
  } else {
    const days = Math.round(totalMinutes / (24 * 60));
    cronExpr = `0 4 */${days} * *`;
    desc = `every ${days}d at 04:00`;
  }

  logInfo(`⏰ Scheduler starting — cron: "${cronExpr}" (${desc}, configured: "${intervalStr}")`);

  _schedulerTask = cron.schedule(cronExpr, async () => {
    if (_refreshRunning) {
      logDebug("Skipping scheduled refresh — already running");
      return;
    }
    // Honour Spotify Retry-After: skip this scheduled slot if we're still in cooldown
    if (_quotaRetryAfter && _quotaRetryAfter > new Date()) {
      logDebug(`Skipping scheduled refresh — Spotify rate limit active until ${_quotaRetryAfter.toISOString()}`);
      return;
    }
    _refreshRunning = true;
    try {
      logInfo("▶️  Scheduled playlist refresh starting…");
      await runRefresh();
      _lastRefreshTime = new Date();
      _lastRefreshError = null;
      _quotaRetryAfter = null;
      if (_quotaRetryTimer) { clearTimeout(_quotaRetryTimer); _quotaRetryTimer = null; }
      logInfo("✅ Scheduled refresh complete");
    } catch (err) {
      if (err && err.name === "SpotifyQuotaError") {
        _quotaRetryAfter = new Date(Date.now() + (err.retryAfter || 60) * 1000);
        _lastRefreshError = err.message;
        logWarn(`Spotify quota exceeded — next retry allowed at ${_quotaRetryAfter.toISOString()}`);
        scheduleQuotaRetry(_quotaRetryAfter);
      } else {
        _lastRefreshError = err.message;
        logError("Scheduled refresh failed: " + err.message);
      }
    } finally {
      _refreshRunning = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(WEB_PORT, "0.0.0.0", () => {
  logInfo(`🚀 Daily Drive by IBM Bob — Web UI started on port ${WEB_PORT}`);
  logInfo(`   Data directory : ${PATHS.DATA_DIR}`);
  logInfo(`   Refresh interval: ${getRefreshIntervalStr()}`);
  logInfo(`   Log level       : ${resolveLogLevel(loadConfig())}`);

  // Start background token refresh daemon in OAuth mode only (check every 30 min)
  const _startCfg = loadConfig();
  if ((_startCfg.api_mode || "oauth") === "oauth") {
    const _daemonCreds = resolveSpotifyCredentials(_startCfg.spotify || {});
    const _daemonClient = new OAuthSpotifyClient(_daemonCreds);
    _daemonClient.startDaemon(30 * 60 * 1000);
  }

  // Prune old log files on startup, then daily at midnight
  pruneOldLogs();
  cron.schedule("0 0 * * *", pruneOldLogs);

  // Start the playlist refresh scheduler
  startScheduler();
});

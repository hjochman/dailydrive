// =============================================================================
// Daily Drive — Token Manager
// =============================================================================
// Centralised Spotify token refresh logic shared by index.js and server.js.
// Runs a background interval in server.js to proactively refresh the token
// before it expires (within 10 minutes of expiry).
// =============================================================================

const fs   = require("fs");
const yaml = require("js-yaml");
const SpotifyWebApi = require("spotify-web-api-node");
const { PATHS, resolveSpotifyCredentials } = require("./paths");

// Logger — defaults to console; overridden via setLogger() from server.js
// Accepts either a logger object { error, warn, info, debug } or a plain function (legacy).
let _log = {
  error: (...a) => console.error(...a),
  warn:  (...a) => console.warn(...a),
  info:  (...a) => console.log(...a),
  debug: (...a) => {},
};

function setLogger(loggerOrFn, _ignored) {
  if (typeof loggerOrFn === "function") {
    _log = { error: loggerOrFn, warn: loggerOrFn, info: loggerOrFn, debug: () => {} };
  } else if (loggerOrFn && typeof loggerOrFn === "object") {
    _log = loggerOrFn;
  }
}

function loadConfigFile() {
  if (!fs.existsSync(PATHS.CONFIG_FILE)) return {};
  try {
    return yaml.load(fs.readFileSync(PATHS.CONFIG_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

// --------------------------------------------------------------------------
// Token I/O helpers
// --------------------------------------------------------------------------

function loadToken() {
  if (!fs.existsSync(PATHS.TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PATHS.TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveToken(tokenData) {
  fs.writeFileSync(PATHS.TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

// --------------------------------------------------------------------------
// Status helper — used by dashboard
// --------------------------------------------------------------------------

function getTokenStatus() {
  const token = loadToken();
  if (!token) return { valid: false, expiresAt: null, hasRefreshToken: false };
  // A token is considered usable/valid if it hasn't expired yet OR if we have a refresh_token to renew it
  const notExpired = Date.now() < token.expires_at;
  const hasRefresh = !!token.refresh_token;
  return {
    valid:           notExpired || hasRefresh,
    isExpired:       !notExpired,
    expiresAt:       token.expires_at ? new Date(token.expires_at) : null,
    hasRefreshToken: hasRefresh,
  };
}

// --------------------------------------------------------------------------
// Core refresh logic
// --------------------------------------------------------------------------

/**
 * Refreshes the Spotify access token if it expires within `thresholdMs`
 * milliseconds (default 10 minutes).  Returns the (potentially updated) token
 * object, or null if no token exists.
 *
 * @param {number} [thresholdMs=600_000]  Refresh if expiry is within this window
 * @returns {Promise<object|null>}
 */
async function refreshTokenIfNeeded(thresholdMs = 10 * 60 * 1000) {
  const token = loadToken();
  if (!token) return null;

  const expiresInMs = token.expires_at - Date.now();
  if (expiresInMs > thresholdMs) {
    _log.debug(`[token-manager] Token valid for ${Math.round(expiresInMs / 60000)} more minutes — no refresh needed`);
    return token;
  }

  _log.info("[token-manager] 🔄 Refreshing Spotify access token...");

  const fileConfig = loadConfigFile();
  const creds = resolveSpotifyCredentials(fileConfig.spotify || {});
  if (!creds.client_id || !creds.client_secret) {
    _log.warn("[token-manager] Token refresh skipped: Spotify credentials not found in environment or config.yaml");
    return token;
  }

  const spotifyApi = new SpotifyWebApi({
    clientId:     creds.client_id,
    clientSecret: creds.client_secret,
    redirectUri:  creds.redirect_uri,
  });
  spotifyApi.setRefreshToken(token.refresh_token);

  try {
    const data = await spotifyApi.refreshAccessToken();
    token.access_token = data.body.access_token;
    token.expires_at   = Date.now() + data.body.expires_in * 1000;
    if (data.body.refresh_token) {
      _log.debug("[token-manager] Spotify issued a new refresh token — persisting");
      token.refresh_token = data.body.refresh_token;
    }
    saveToken(token);
    _log.info("[token-manager] ✅ Token refreshed — valid until " + new Date(token.expires_at).toISOString());
  } catch (err) {
    _log.error("[token-manager] Token refresh failed: " + err.message);
    // If Spotify rejects the refresh token specifically (invalid_grant: revoked or expired after months)
    // the token is permanently broken — delete it so the UI prompts to re-authorise.
    const body = err.body || {};
    const errorCode = body.error || (err.message || "");
    const isPermanent = typeof errorCode === "string" && errorCode.includes("invalid_grant");
    if (isPermanent) {
      _log.warn("[token-manager] Removing invalid refresh token — please re-run the Setup Wizard to re-authorise.");
      try { fs.unlinkSync(PATHS.TOKEN_FILE); } catch { /* already gone */ }
    }
  }

  return loadToken();
}

// --------------------------------------------------------------------------
// Background daemon — call startTokenRefreshDaemon() from server.js once
// --------------------------------------------------------------------------

let _daemonTimer = null;

function startTokenRefreshDaemon(intervalMs = 30 * 60 * 1000) {
  if (_daemonTimer) return; // already running
  _log.info(`[token-manager] 🕐 Token refresh daemon started (interval: ${intervalMs / 60000} min)`);
  _daemonTimer = setInterval(() => {
    refreshTokenIfNeeded().catch((err) =>
      _log.error("[token-manager] daemon error: " + err.message)
    );
  }, intervalMs);
  // Don't block process exit
  if (_daemonTimer.unref) _daemonTimer.unref();
}

module.exports = { loadToken, saveToken, getTokenStatus, refreshTokenIfNeeded, startTokenRefreshDaemon, setLogger };

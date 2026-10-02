// =============================================================================
// Daily Drive — Token Manager
// =============================================================================
// Centralised Spotify token refresh logic shared by index.js and server.js.
// Runs a background interval in server.js to proactively refresh the token
// before it expires (within 10 minutes of expiry).
// =============================================================================

const fs   = require("fs");
const SpotifyWebApi = require("spotify-web-api-node");
const { PATHS, resolveSpotifyCredentials } = require("./paths");

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
  return {
    valid:           Date.now() < token.expires_at,
    expiresAt:       new Date(token.expires_at),
    hasRefreshToken: !!token.refresh_token,
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

  if (Date.now() > token.expires_at - thresholdMs) {
    console.log("[token-manager] 🔄 Refreshing Spotify access token...");

    const creds = resolveSpotifyCredentials();
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
      if (data.body.refresh_token) token.refresh_token = data.body.refresh_token;
      saveToken(token);
      console.log("[token-manager] ✅ Token refreshed — valid until", new Date(token.expires_at).toISOString());
    } catch (err) {
      console.error("[token-manager] ❌ Token refresh failed:", err.message);
      // If Spotify rejects our credentials or refresh token (invalid_client,
      // invalid_grant, …) the token is permanently broken — delete it so the
      // dashboard shows "re-authorise required" instead of looping forever.
      const body = err.body || {};
      const errorCode = body.error || (err.message || "");
      const isPermanent = ["invalid_client", "invalid_grant"].some(
        (code) => typeof errorCode === "string" && errorCode.includes(code)
      );
      if (isPermanent) {
        console.error("[token-manager] 🗑️  Removing stale token — please re-run the Setup Wizard to re-authorise.");
        try { fs.unlinkSync(PATHS.TOKEN_FILE); } catch { /* already gone */ }
      }
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
  console.log("[token-manager] 🕐 Token refresh daemon started (interval:", intervalMs / 60000, "min)");
  _daemonTimer = setInterval(() => {
    refreshTokenIfNeeded().catch((err) =>
      console.error("[token-manager] daemon error:", err.message)
    );
  }, intervalMs);
  // Don't block process exit
  if (_daemonTimer.unref) _daemonTimer.unref();
}

module.exports = { loadToken, saveToken, getTokenStatus, refreshTokenIfNeeded, startTokenRefreshDaemon };

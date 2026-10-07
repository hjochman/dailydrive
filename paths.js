// =============================================================================
// Daily Drive — Centralised path & credential resolution
// =============================================================================
// All persistent files live under DATA_DIR (default: /data inside the container,
// falls back to the project directory for local CLI usage).
//
// Credentials are read from environment variables first; values found in
// config.yaml act as fallback so the CLI workflow is fully backward-compatible.
// =============================================================================

const path = require("path");

// Root directory for all persistent/runtime data.
// Set DATA_DIR=/data in the container; leave unset for local development.
const DATA_DIR = process.env.DATA_DIR || require("path").join(__dirname, "data");

const PATHS = {
  DATA_DIR,
  CONFIG_FILE:  path.join(DATA_DIR, "config.yaml"),
  TOKEN_FILE:   path.join(DATA_DIR, ".spotify-token.json"),
  STATE_FILE:   path.join(DATA_DIR, "state.json"),
  LOG_DIR:      path.join(DATA_DIR, "logs"),
};

/**
 * Returns the Spotify credentials to use, merging environment variables
 * (highest priority) with values from a loaded config object (fallback).
 *
 * OAuth mode fields (client_id, client_secret, redirect_uri) are always resolved.
 * Cookie mode field (sp_dc) is resolved when api_mode is 'cookie'.
 *
 * @param {object} [configSpotify={}]  config.spotify from config.yaml (may be empty)
 * @returns {{ client_id, client_secret, redirect_uri, sp_dc }}
 */
function resolveSpotifyCredentials(configSpotify = {}) {
  return {
    client_id:     process.env.SPOTIFY_CLIENT_ID     || configSpotify.client_id     || "",
    client_secret: process.env.SPOTIFY_CLIENT_SECRET || configSpotify.client_secret || "",
    redirect_uri:  process.env.SPOTIFY_REDIRECT_URI  || configSpotify.redirect_uri  ||
                   `http://127.0.0.1:${process.env.WEB_PORT || 8080}/callback`,
    sp_dc:         process.env.SPOTIFY_SP_DC           || configSpotify.sp_dc         || "",
  };
}

module.exports = { PATHS, resolveSpotifyCredentials };

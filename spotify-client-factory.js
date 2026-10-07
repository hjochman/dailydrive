// =============================================================================
// Daily Drive — Spotify Client Factory
// =============================================================================
// Creates the appropriate SpotifyClient implementation based on the api_mode
// value from the config. Currently supports:
//   - 'oauth'   (default) — OAuthSpotifyClient via spotify-web-api-node
//   - 'cookie'            — CookieSpotifyClient via internal Spotify Web Player API
// =============================================================================

const { OAuthSpotifyClient } = require('./spotify-client-oauth');
const { CookieSpotifyClient } = require('./spotify-client-cookie');

/**
 * Creates the appropriate SpotifyClient based on api_mode from the config.
 *
 * @param {string} mode - 'oauth' | 'cookie'
 * @param {object} creds - Credentials object from resolveSpotifyCredentials()
 * @param {string} [creds.client_id]     - Spotify app client ID (OAuth mode)
 * @param {string} [creds.client_secret] - Spotify app client secret (OAuth mode)
 * @param {string} [creds.redirect_uri]  - OAuth redirect URI (OAuth mode)
 * @param {string} [creds.sp_dc]         - sp_dc browser cookie value (Cookie mode)
 * @returns {import('./spotify-client-base').SpotifyClientBase}
 */
function createSpotifyClient(mode, creds) {
  if (mode === 'cookie') {
    return new CookieSpotifyClient({ sp_dc: creds.sp_dc });
  }
  return new OAuthSpotifyClient({
    client_id:     creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri:  creds.redirect_uri,
  });
}

module.exports = { createSpotifyClient };

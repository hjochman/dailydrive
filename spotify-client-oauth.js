// =============================================================================
// Daily Drive — OAuthSpotifyClient
// =============================================================================
// Concrete Spotify client implementation using OAuth 2.0 and the
// spotify-web-api-node library. Encapsulates all token-lifecycle logic via
// token-manager.js so callers only need to call initialize() once and then
// use the public interface methods.
//
// Implements: SpotifyClientBase (spotify-client-base.js)
// =============================================================================

"use strict";

const SpotifyWebApi = require("spotify-web-api-node");
const { SpotifyClientBase, SpotifyQuotaError } = require("./spotify-client-base");
const tokenManager = require("./token-manager");

// Logger — defaults to silent (no output); overridden via setLogger() from server.js
// Accepts either a logger object { error, warn, info, debug } or a plain function (legacy).
let _log = {
  error: (...a) => console.error(...a),
  warn:  (...a) => console.warn(...a),
  info:  (...a) => console.log(...a),
  debug: (...a) => {},
};
function setLogger(loggerOrFn) {
  if (typeof loggerOrFn === "function") {
    _log = { error: loggerOrFn, warn: loggerOrFn, info: loggerOrFn, debug: () => {} };
  } else if (loggerOrFn && typeof loggerOrFn === "object") {
    _log = loggerOrFn;
  }
}

class OAuthSpotifyClient extends SpotifyClientBase {
  /**
   * @param {{ client_id: string, client_secret: string, redirect_uri: string }} credentials
   */
  constructor({ client_id, client_secret, redirect_uri }) {
    super();
    this._spotifyApi = new SpotifyWebApi({
      clientId:     client_id,
      clientSecret: client_secret,
      redirectUri:  redirect_uri,
    });
    /** Spotify Dev Mode does not return resume_point via the REST API. */
    this.resumePointSupported = false;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Loads the stored OAuth token and sets the access token on the internal
   * SpotifyWebApi instance.  Must be called before any API method.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    const token = await tokenManager.refreshTokenIfNeeded(5 * 60 * 1000);
    if (token && token.access_token) {
      this._spotifyApi.setAccessToken(token.access_token);
    }
  }

  /**
   * Starts the background token-refresh daemon (server mode only).
   *
   * @param {number} [intervalMs=1800000] Milliseconds between refresh checks (default: 30 min)
   * @returns {void}
   */
  startDaemon(intervalMs = 30 * 60 * 1000) {
    tokenManager.startTokenRefreshDaemon(intervalMs);
  }

  // ---------------------------------------------------------------------------
  // OAuth-specific extras (not in SpotifyClientBase)
  // ---------------------------------------------------------------------------

  /**
   * Generates the Spotify OAuth authorisation URL.
   *
   * @param {string[]} scopes - Spotify permission scopes
   * @param {string}   state  - Opaque state string passed back by Spotify
   * @returns {string} Authorisation URL to redirect the user to
   */
  getOAuthUrl(scopes, state) {
    return this._spotifyApi.createAuthorizeURL(scopes, state);
  }

  /**
   * Exchanges an authorisation code for access + refresh tokens, persists
   * them via token-manager, and updates the internal SpotifyWebApi instance.
   *
   * @param {string} code - Authorisation code received from Spotify callback
   * @returns {Promise<{ access_token: string, refresh_token: string, expires_at: number }>}
   */
  async exchangeCode(code) {
    const data = await this._spotifyApi.authorizationCodeGrant(code);
    const tokenData = {
      access_token:  data.body.access_token,
      refresh_token: data.body.refresh_token,
      expires_at:    Date.now() + data.body.expires_in * 1000,
    };
    tokenManager.saveToken(tokenData);
    this._spotifyApi.setAccessToken(tokenData.access_token);
    return tokenData;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensures the stored token is still valid (refreshing if expiring within
   * 5 minutes) and updates the access token on the SpotifyWebApi instance.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _ensureFreshToken() {
    const updated = await tokenManager.refreshTokenIfNeeded(5 * 60 * 1000);
    if (updated && updated.access_token) {
      this._spotifyApi.setAccessToken(updated.access_token);
    }
  }

  // ---------------------------------------------------------------------------
  // Podcast / show methods
  // ---------------------------------------------------------------------------

  /**
   * @inheritdoc
   * @param {string} showId
   * @param {{ limit?: number, market?: string }} [options]
   * @returns {Promise<Array<{uri: string, name: string, type: "episode"}>>}
   */
  async getShowEpisodes(showId, options = {}) {
    await this._ensureFreshToken();
    const data = await this._spotifyApi.getShowEpisodes(showId, {
      limit:  options.limit  || 50,
      offset: options.offset || 0,
      market: options.market || "US",
    });
    const items = data.body.items;
    if (!items || items.length === 0) return [];

    // resume_point (fully_played, resume_position_ms) is returned directly by
    // /v1/shows/{id}/episodes when a market parameter is provided — no extra call needed.
    return items.map((ep) => ({
      uri:                ep.uri,
      name:               ep.name,
      type:               "episode",
      fully_played:       ep.resume_point?.fully_played       ?? null,
      resume_position_ms: ep.resume_point?.resume_position_ms ?? null,
      duration_ms:        ep.duration_ms                       ?? null,
    }));
  }

  /** @inheritdoc */
  async getMySavedShows(options = {}) {
    await this._ensureFreshToken();
    const accessToken = this._spotifyApi.getAccessToken();
    const limit  = options.limit  || 50;
    const offset = options.offset || 0;
    _log.debug(`[oauth] GET /me/shows limit=${limit} offset=${offset}`);
    const res = await fetch(
      `https://api.spotify.com/v1/me/shows?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
        _log.warn(`[oauth] Rate-limited on GET /me/shows — retry after ${retryAfter}s`);
        throw new SpotifyQuotaError(retryAfter);
      }
      _log.warn(`[oauth] GET /me/shows HTTP ${res.status}`);
      throw new Error(`getMySavedShows HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return (data.items || []).map((entry) => ({
      id:        entry.show?.id,
      name:      entry.show?.name,
      publisher: entry.show?.publisher,
      images:    entry.show?.images || [],
    }));
  }

  /** @inheritdoc */
  async searchShows(query, options = {}) {
    await this._ensureFreshToken();
    const data = await this._spotifyApi.searchShows(query, {
      limit: options.limit || 10,
    });
    return data.body.shows.items.map((item) => ({
      id:        item.id,
      name:      item.name,
      publisher: item.publisher,
      images:    item.images || [],
    }));
  }

  // ---------------------------------------------------------------------------
  // Track methods
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getMyTopTracks(options = {}) {
    await this._ensureFreshToken();
    const data = await this._spotifyApi.getMyTopTracks({
      limit:      options.limit      || 30,
      offset:     options.offset     || 0,
      time_range: options.time_range || "short_term",
    });
    return data.body.items.map((track) => ({
      uri:    track.uri,
      name:   track.name,
      artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
      type:   "track",
    }));
  }

  /** @inheritdoc */
  async getMySavedTracks(options = {}) {
    await this._ensureFreshToken();
    const data = await this._spotifyApi.getMySavedTracks({
      limit:  options.limit  || 50,
      offset: options.offset || 0,
    });
    return data.body.items.map((entry) => ({
      uri:    entry.track.uri,
      name:   entry.track.name,
      artist: entry.track.artists?.map((a) => a.name).join(", ") || "Unknown",
      type:   "track",
    }));
  }

  /** @inheritdoc */
  async searchTracks(query, options = {}) {
    await this._ensureFreshToken();
    const data = await this._spotifyApi.searchTracks(query, {
      limit:  options.limit  || 10,
      market: options.market || "US",
    });
    return data.body.tracks.items.map((track) => ({
      uri:    track.uri,
      name:   track.name,
      artist: track.artists?.map((a) => a.name).join(", ") || "Unknown",
      type:   "track",
    }));
  }

  // ---------------------------------------------------------------------------
  // Playlist item methods (direct fetch — /tracks deprecated Feb 2026)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getPlaylistItems(playlistId, options = {}) {
    await this._ensureFreshToken();
    const accessToken = this._spotifyApi.getAccessToken();
    const limit       = options.limit      || 100;
    const offset      = options.offset     || 0;
    const tracksOnly  = options.tracksOnly !== false; // default true — set false for dashboard
    const res = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
        _log.warn(`[oauth] Rate-limited on getPlaylistItems — retry after ${retryAfter}s`);
        throw new SpotifyQuotaError(retryAfter);
      }
      _log.warn(`[oauth] getPlaylistItems HTTP ${res.status} for playlist ${playlistId}`);
      throw new Error(`getPlaylistItems HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const rawItems = data.items || [];
    _log.debug(`[oauth] getPlaylistItems: API returned ${rawItems.length} raw items (total: ${data.total ?? "?"})`);
    const results = [];
    for (const entry of rawItems) {
      // The /items endpoint returns the item in entry.item (tracks and episodes alike).
      // Older API versions used entry.track — fall back to that for compatibility.
      const item = entry.item || entry.track || entry.episode;
      if (!item || !item.uri) continue;
      if (item.type === "episode") {
        if (!tracksOnly) {
          results.push({
            uri:  item.uri,
            name: item.name,
            show: item.show?.name || "Unknown Show",
            type: "episode",
          });
        }
      } else if (item.type === "track") {
        results.push({
          uri:    item.uri,
          name:   item.name,
          artist: item.artists?.map((a) => a.name).join(", ") || "Unknown",
          type:   "track",
        });
      }
    }
    if (rawItems.length > 0 && results.length === 0) {
      _log.warn(`[oauth] getPlaylistItems: ${rawItems.length} raw items fetched but 0 passed the filter — playlist may contain local files, unavailable tracks, or episodes (tracksOnly=${tracksOnly})`);
    }
    return results;
  }

  /** @inheritdoc */
  async replacePlaylistItems(playlistId, uris) {
    await this._ensureFreshToken();
    const accessToken = this._spotifyApi.getAccessToken();
    _log.debug(`[oauth] PUT /playlists/${playlistId}/items (${uris.length} URIs)`);
    const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method:  "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ uris: uris.slice(0, 100) }),
    });
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
        _log.warn(`[oauth] Rate-limited on replacePlaylistItems — retry after ${retryAfter}s`);
        throw new SpotifyQuotaError(retryAfter);
      }
      _log.warn(`[oauth] replacePlaylistItems HTTP ${res.status}`);
      throw new Error(`replacePlaylistItems HTTP ${res.status}: ${await res.text()}`);
    }
  }

  /** @inheritdoc */
  async addPlaylistItems(playlistId, uris) {
    await this._ensureFreshToken();
    const accessToken = this._spotifyApi.getAccessToken();
    _log.debug(`[oauth] POST /playlists/${playlistId}/items (${uris.length} URIs)`);
    const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ uris }),
    });
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
        _log.warn(`[oauth] Rate-limited on addPlaylistItems — retry after ${retryAfter}s`);
        throw new SpotifyQuotaError(retryAfter);
      }
      _log.warn(`[oauth] addPlaylistItems HTTP ${res.status}`);
      throw new Error(`addPlaylistItems HTTP ${res.status}: ${await res.text()}`);
    }
  }

  // ---------------------------------------------------------------------------
  // User / profile methods
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getMe() {
    await this._ensureFreshToken();
    const data = await this._spotifyApi.getMe();
    return data.body;
  }

  /** @inheritdoc */
  async createPlaylist(name, options = {}) {
    await this._ensureFreshToken();
    const me     = await this._spotifyApi.getMe();
    const result = await this._spotifyApi.createPlaylist(name, {
      description: options.description || "",
      public:      options.public      || false,
    });
    return { id: result.body.id, name: result.body.name };
  }

  /** @inheritdoc */
  async getUserPlaylists(options = {}) {
    await this._ensureFreshToken();
    const [playlistData, meData] = await Promise.all([
      this._spotifyApi.getUserPlaylists({ limit: options.limit || 50, offset: options.offset || 0 }),
      this._spotifyApi.getMe(),
    ]);
    const myUserId = meData.body.id;
    return playlistData.body.items.map((item) => ({
      id:           item.id,
      name:         item.name,
      images:       item.images || [],
      owner:        item.owner?.display_name,
      owner_id:     item.owner?.id,
      is_own:       item.owner?.id === myUserId,
      tracks_total: item.tracks?.total != null ? item.tracks.total : (item.items?.total ?? 0),
    }));
  }

  // ---------------------------------------------------------------------------
  // Search methods
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async searchPlaylists(query, options = {}) {
    await this._ensureFreshToken();
    const data = await this._spotifyApi.searchPlaylists(query, {
      limit: options.limit || 10,
    });
    return data.body.playlists.items.map((item) => ({
      id:     item.id,
      name:   item.name,
      images: item.images || [],
      owner:  item.owner?.display_name,
    }));
  }

  // ---------------------------------------------------------------------------
  // Artist / taste methods
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getMyTopArtists(options = {}) {
    await this._ensureFreshToken();
    const data = await this._spotifyApi.getMyTopArtists({
      limit:      options.limit      || 50,
      offset:     options.offset     || 0,
      time_range: options.time_range || "short_term",
    });
    return data.body.items.map((artist) => ({
      name:   artist.name,
      genres: artist.genres || [],
      images: artist.images || [],
    }));
  }

  // ---------------------------------------------------------------------------
  // Playlist metadata / cover image
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getPlaylistInfo(playlistId) {
    await this._ensureFreshToken();
    const accessToken = this._spotifyApi.getAccessToken();
    const res = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}?fields=id,name,images,owner,tracks.total`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
        throw new SpotifyQuotaError(retryAfter);
      }
      throw new Error(`getPlaylistInfo HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return {
      id:           data.id,
      name:         data.name,
      image:        data.images?.[0]?.url || null,
      owner:        data.owner?.display_name || null,
      tracks_total: data.tracks?.total ?? 0,
    };
  }

  /** @inheritdoc */
  async setPlaylistCoverImage(playlistId, imageData) {
    await this._ensureFreshToken();
    const accessToken = this._spotifyApi.getAccessToken();
    // Accept both raw Buffer and base64 string (PUT /images expects base64)
    const base64Jpeg = Buffer.isBuffer(imageData)
      ? imageData.toString("base64")
      : imageData;
    const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/images`, {
      method:  "PUT",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "image/jpeg",
      },
      body: base64Jpeg,
    });
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
        throw new SpotifyQuotaError(retryAfter);
      }
      throw new Error(`setPlaylistCoverImage HTTP ${res.status}: ${await res.text()}`);
    }
  }
}

module.exports = { OAuthSpotifyClient, setLogger };

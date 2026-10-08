// =============================================================================
// Daily Drive — Spotify Client Base Interface
// =============================================================================
// Abstract base class defining the common interface for all Spotify client
// implementations (OAuth and Cookie-based). Both implementations must fulfil
// this contract so that the playlist builder logic in index.js and the web
// server in server.js can use either backend without code changes.
// =============================================================================

/**
 * Error thrown when a Spotify API operation is not supported by the current
 * backend implementation (e.g., setPlaylistCoverImage is only available in
 * OAuth mode, not in Cookie mode).
 */
class NotSupportedError extends Error {
  /**
   * @param {string} message - Human-readable error message
   */
  constructor(message) {
    super(message);
    this.name = "NotSupportedError";
  }
}

/**
 * Error thrown when Spotify returns HTTP 429 (Too Many Requests).
 * Carries the `retryAfter` value (in seconds) from the Retry-After header
 * so callers can schedule the next attempt correctly.
 */
class SpotifyQuotaError extends Error {
  /**
   * @param {number} retryAfterSeconds - Seconds to wait before retrying
   */
  constructor(retryAfterSeconds) {
    super(`Spotify rate limit hit — retry after ${retryAfterSeconds}s`);
    this.name = "SpotifyQuotaError";
    /** @type {number} Seconds to wait before the next request */
    this.retryAfter = retryAfterSeconds;
  }
}

/**
 * Abstract base class for Spotify API clients.
 *
 * All methods are `async` and throw `Error('Not implemented')` by default.
 * Concrete implementations (`OAuthSpotifyClient`, `CookieSpotifyClient`)
 * must override every method.
 *
 * @interface
 */
class SpotifyClientBase {
  constructor() {
    /**
     * Whether this client implementation returns resume_point data
     * (fully_played, resume_position_ms) on episode objects.
     * false for OAuthSpotifyClient (Dev Mode restriction), true for CookieSpotifyClient.
     * @type {boolean}
     */
    this.resumePointSupported = false;
  }

  /**
   * Initialises the client: loads stored tokens, establishes a session,
   * or performs any setup required before making API calls.
   *
   * @abstract
   * @returns {Promise<void>}
   * @throws {Error} If initialisation fails (e.g., missing credentials, invalid token)
   */
  async initialize() {
    throw new Error("Not implemented");
  }

  /**
   * Stops any background refresh daemon. No-op by default; override in subclasses that start
   * a daemon (e.g. CookieSpotifyClient). Safe to call on all client types.
   */
  stopDaemon() {}

  /**
   * Fetches the latest episodes for a podcast show.
   *
   * @abstract
   * @param {string} showId - Spotify Show ID (e.g., "4rOoJ6Egrf8K2IrywzwOMk")
   * @param {object} [options] - Query options
   * @param {number} [options.limit=50] - Maximum number of episodes to return (max 50)
   * @param {number} [options.offset=0] - Offset for pagination
   * @param {string} [options.market="US"] - ISO 3166-1 alpha-2 country code for availability; required for resume_point to be returned
   * @returns {Promise<Array<{uri: string, name: string, show?: string, type: "episode", position?: string}>>}
   *   Array of normalised episode objects:
   *   - `uri`: Spotify URI (e.g., "spotify:episode:abc123")
   *   - `name`: Episode title
   *   - `show`: Display name of the podcast (optional, added by caller)
   *   - `type`: Always "episode"
   *   - `position`: Optional "first" to pin at playlist start
   *   - `fully_played`: Whether the episode has been fully played (`true`/`false`), or `null` if unavailable
   *   - `resume_position_ms`: Playback position in milliseconds at last listen, or `null` if unavailable
   *   - `duration_ms`: Total episode duration in milliseconds, or `null` if unavailable
   * @throws {Error} If the API request fails
   */
  async getShowEpisodes(showId, options) {
    throw new Error("Not implemented");
  }

  /**
   * Fetches the current user's most-played tracks.
   *
   * @abstract
   * @param {object} [options] - Query options
   * @param {string} [options.time_range="short_term"] - "short_term" (~4 weeks), "medium_term" (~6 months), or "long_term" (all time)
   * @param {number} [options.limit=30] - Maximum tracks to return (max 50 per request)
   * @param {number} [options.offset=0] - Offset for pagination
   * @returns {Promise<Array<{uri: string, name: string, artist: string, type: "track"}>>}
   *   Array of normalised track objects:
   *   - `uri`: Spotify URI (e.g., "spotify:track:abc123")
   *   - `name`: Track title
   *   - `artist`: Comma-separated artist names
   *   - `type`: Always "track"
   * @throws {Error} If the API request fails
   */
  async getMyTopTracks(options) {
    throw new Error("Not implemented");
  }

  /**
   * Fetches the current user's saved/liked tracks.
   *
   * @abstract
   * @param {object} [options] - Query options
   * @param {number} [options.limit=50] - Maximum tracks to return (max 50 per request)
   * @param {number} [options.offset=0] - Offset for pagination
   * @returns {Promise<Array<{uri: string, name: string, artist: string, type: "track"}>>}
   *   Array of normalised track objects (same format as `getMyTopTracks`).
   * @throws {Error} If the API request fails
   */
  async getMySavedTracks(options) {
    throw new Error("Not implemented");
  }

  /**
   * Fetches all items (tracks and episodes) from a playlist.
   *
   * @abstract
   * @param {string} playlistId - Spotify Playlist ID
   * @param {object} [options] - Query options
   * @param {number} [options.limit=100] - Maximum items per page (max 100)
   * @param {number} [options.offset=0] - Offset for pagination
   * @returns {Promise<Array<{uri: string, name: string, artist: string, type: "track"}>>}
   *   Array of normalised track objects from the playlist.
   *   Only tracks are returned (episodes are filtered out by the caller if needed).
   * @throws {Error} If the API request fails
   */
  async getPlaylistItems(playlistId, options) {
    throw new Error("Not implemented");
  }

  /**
   * Searches Spotify for tracks matching a query.
   *
   * @abstract
   * @param {string} query - Search query (e.g., "genre:pop", "artist:Taylor Swift")
   * @param {object} [options] - Query options
   * @param {number} [options.limit=10] - Maximum results (Dev Mode caps at 10)
   * @param {string} [options.market="US"] - ISO 3166-1 alpha-2 country code
   * @returns {Promise<Array<{uri: string, name: string, artist: string, type: "track"}>>}
   *   Array of normalised track objects (same format as `getMyTopTracks`).
   * @throws {Error} If the API request fails
   */
  async searchTracks(query, options) {
    throw new Error("Not implemented");
  }

  /**
   * Replaces all items in a playlist with the given URIs (PUT /playlists/{id}/items).
   * Accepts up to 100 URIs per call. For more than 100 items, the caller should
   * use `addPlaylistItems` for subsequent batches.
   *
   * @abstract
   * @param {string} playlistId - Spotify Playlist ID
   * @param {string[]} uris - Array of Spotify URIs (tracks and/or episodes)
   * @returns {Promise<void>}
   * @throws {Error} If the API request fails
   * @throws {SpotifyQuotaError} If rate limited (HTTP 429)
   */
  async replacePlaylistItems(playlistId, uris) {
    throw new Error("Not implemented");
  }

  /**
   * Adds items to a playlist (POST /playlists/{id}/items).
   * Used for batches beyond the first 100 items.
   *
   * @abstract
   * @param {string} playlistId - Spotify Playlist ID
   * @param {string[]} uris - Array of Spotify URIs (tracks and/or episodes), max 100
   * @returns {Promise<void>}
   * @throws {Error} If the API request fails
   * @throws {SpotifyQuotaError} If rate limited (HTTP 429)
   */
  async addPlaylistItems(playlistId, uris) {
    throw new Error("Not implemented");
  }

  /**
   * Fetches the current user's profile.
   *
   * @abstract
   * @returns {Promise<{id: string, display_name?: string, email?: string, images?: Array<{url: string}>, product?: string}>}
   *   Normalised user profile object.
   * @throws {Error} If the API request fails
   */
  async getMe() {
    throw new Error("Not implemented");
  }

  /**
   * Creates a new playlist for the current user.
   *
   * @abstract
   * @param {string} name - Playlist name
   * @param {object} [options] - Playlist options
   * @param {string} [options.description=""] - Playlist description
   * @param {boolean} [options.public=false] - Whether the playlist is public
   * @returns {Promise<{id: string, name: string}>}
   *   Created playlist with its Spotify ID and name.
   * @throws {Error} If the API request fails
   */
  async createPlaylist(name, options) {
    throw new Error("Not implemented");
  }

  /**
   * Fetches the current user's playlists.
   *
   * @abstract
   * @param {object} [options] - Query options
   * @param {number} [options.limit=50] - Maximum playlists per page
   * @param {number} [options.offset=0] - Offset for pagination
   * @returns {Promise<Array<{id: string, name: string, images: Array<{url: string}>, owner: string, owner_id: string, is_own: boolean, tracks_total: number}>>}
   *   Array of normalised playlist objects:
   *   - `id`: Spotify Playlist ID
   *   - `name`: Playlist name
   *   - `images`: Array of image objects with `url`
   *   - `owner`: Owner display name
   *   - `owner_id`: Owner Spotify ID
   *   - `is_own`: True if the current user owns this playlist
   *   - `tracks_total`: Total number of tracks in the playlist
   * @throws {Error} If the API request fails
   */
  async getUserPlaylists(options) {
    throw new Error("Not implemented");
  }

  /**
   * Fetches the current user's followed/saved podcast shows.
   *
   * @abstract
   * @param {object} [options] - Query options
   * @param {number} [options.limit=50] - Maximum shows per page
   * @param {number} [options.offset=0] - Offset for pagination
   * @returns {Promise<Array<{id: string, name: string, publisher?: string, images: Array<{url: string}>}>>}
   *   Array of normalised show objects:
   *   - `id`: Spotify Show ID
   *   - `name`: Show name
   *   - `publisher`: Publisher name (optional)
   *   - `images`: Array of image objects with `url`
   * @throws {Error} If the API request fails
   */
  async getMySavedShows(options) {
    throw new Error("Not implemented");
  }

  /**
   * Searches Spotify for podcast shows.
   *
   * @abstract
   * @param {string} query - Search query
   * @param {object} [options] - Query options
   * @param {number} [options.limit=10] - Maximum results
   * @returns {Promise<Array<{id: string, name: string, publisher?: string, images: Array<{url: string}>}>>}
   *   Array of normalised show objects (same format as `getMySavedShows`).
   * @throws {Error} If the API request fails
   */
  async searchShows(query, options) {
    throw new Error("Not implemented");
  }

  /**
   * Searches Spotify for playlists.
   *
   * @abstract
   * @param {string} query - Search query
   * @param {object} [options] - Query options
   * @param {number} [options.limit=10] - Maximum results
   * @returns {Promise<Array<{id: string, name: string, images: Array<{url: string}>, owner: string}>>}
   *   Array of normalised playlist objects:
   *   - `id`: Spotify Playlist ID
   *   - `name`: Playlist name
   *   - `images`: Array of image objects with `url`
   *   - `owner`: Owner display name
   * @throws {Error} If the API request fails
   */
  async searchPlaylists(query, options) {
    throw new Error("Not implemented");
  }

  /**
   * Fetches the current user's top artists.
   *
   * @abstract
   * @param {object} [options] - Query options
   * @param {string} [options.time_range="short_term"] - "short_term", "medium_term", or "long_term"
   * @param {number} [options.limit=50] - Maximum artists per request
   * @param {number} [options.offset=0] - Offset for pagination
   * @returns {Promise<Array<{name: string, genres?: string[], images?: Array<{url: string}>}>>}
   *   Array of artist objects with at least a `name` field.
   * @throws {Error} If the API request fails
   */
  async getMyTopArtists(options) {
    throw new Error("Not implemented");
  }

  /**
   * Fetches basic metadata for a playlist.
   *
   * @abstract
   * @param {string} playlistId - Spotify Playlist ID
   * @returns {Promise<{id: string, name: string, image: string|null, owner: string|null, tracks_total: number}>}
   *   Playlist metadata:
   *   - `id`: Spotify Playlist ID
   *   - `name`: Playlist name
   *   - `image`: URL of the first playlist image, or null if none
   *   - `owner`: Owner display name, or null
   *   - `tracks_total`: Total number of tracks in the playlist
   * @throws {Error} If the API request fails
   */
  async getPlaylistInfo(playlistId) {
    throw new Error("Not implemented");
  }

  /**
   * Sets the playlist cover image.
   * OAuth backend: PUT /v1/playlists/{id}/images (requires `ugc-image-upload` scope).
   * Cookie backend: two-step — POST image-upload.spotify.com/v4/playlist (raw JPEG)
   *   → uploadToken → POST /v1/playlists/{id}/images with { uploadToken }.
   *
   * @abstract
   * @param {string} playlistId - Spotify Playlist ID
   * @param {string|Buffer} imageData - Raw JPEG Buffer or base64-encoded JPEG string
   * @returns {Promise<void>}
   * @throws {Error} If the API request fails
   */
  async setPlaylistCoverImage(playlistId, imageData) {
    throw new Error("Not implemented");
  }
}

module.exports = {
  SpotifyClientBase,
  NotSupportedError,
  SpotifyQuotaError,
};
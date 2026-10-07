// =============================================================================
// Daily Drive — CookieSpotifyClient
// =============================================================================
// Spotify client implementation without OAuth2 / Developer Account, based on
// TOTP token acquisition (via open.spotify.com/api/token) and Spotify's internal
// Pathfinder GraphQL endpoints (api-partner.spotify.com/pathfinder/v2/query).
//
// Ports the approach of the Python SpotAPI-async-v2 library to Node.js.
//
// Implements: SpotifyClientBase (spotify-client-base.js)
// =============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { SpotifyClientBase, NotSupportedError, SpotifyQuotaError } = require("./spotify-client-base");
const { PATHS } = require("./paths");

// Native fetch (Node 18+) or fallback
const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");

// Session file path
const COOKIE_SESSION_FILE = path.join(PATHS.DATA_DIR, ".cookie-session.json");

// Logger — defaults to console, can be overridden via setLogger()
let log = (...a) => console.log(...a);
function setLogger(fn) {
  log = fn;
}

// Constants
const BASE_URL = "https://open.spotify.com/";
const TOKEN_URL = "https://open.spotify.com/api/token";
const CLIENT_TOKEN_URL = "https://clienttoken.spotify.com/v1/clienttoken";
const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v2/query";
const SPCLIENT_PLAYLIST_URL = "https://spclient.wg.spotify.com/playlist/v2/playlist";
const SPCLIENT_ROOTLIST_CHANGES_URL = "https://spclient.wg.spotify.com/playlist/v2/user/{username}/rootlist/changes";
const APP_CONFIG_TAG = '<script id="appServerConfig" type="text/plain">';
// These are factories — always create a fresh instance to avoid lastIndex state bugs
const makeSecretRe = () => /secret\s*:\s*(["'])(.*?)\1\s*,?\s*version\s*:\s*(\d+)/gis;
const makeQueryHashRe = () => /"([^"]+)",\s*"(?:query|mutation)",\s*"([^"]+)"/g;
const makeJsLinkRe = () => /["'](https?:\/\/[^"']+\.js(?:\?[^"']*)?)["']/gi;
const CDN_PREFIX = "https://open.spotifycdn.com/cdn/build/web-player/";

/**
 * Decodes the obfuscated TOTP secret extracted from web-player bundle.
 * Mirrors the Python implementation exactly:
 *   xored = [ord(c) ^ (i % 33 + 9) for i, c in enumerate(secret)]
 *   hex_str = "".join(str(n) for n in xored).encode().hex()
 *   return bytes.fromhex(hex_str)
 * The critical step: join the decimal numbers as a string, then treat those
 * ASCII characters' hex values as the raw byte sequence.
 * @param {string} secret
 * @returns {Buffer}
 */
function decodeSecret(secret) {
  const xored = [];
  for (let i = 0; i < secret.length; i++) {
    xored.push(secret.charCodeAt(i) ^ ((i % 33) + 9));
  }
  // Join decimal numbers into one string ("48123..." etc.), then get the
  // ASCII/Latin-1 hex of each character in that string — matching Python's
  // "...".encode().hex() on the joined string.
  const joined = xored.map((n) => String(n)).join("");
  const hexStr = Array.from(joined)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return Buffer.from(hexStr, "hex");
}

/**
 * Generates RFC 6238 TOTP token with 6 digits and 30s step.
 * @param {Buffer} secretBytes
 * @param {number} [timestamp] - Seconds since epoch
 * @param {number} [step=30]
 * @param {number} [digits=6]
 * @returns {string}
 */
function generateTotp(secretBytes, timestamp, step = 30, digits = 6) {
  const ts = timestamp !== undefined ? timestamp : Date.now() / 1000;
  const counter = BigInt(Math.floor(ts / step));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter, 0);

  const hmac = crypto.createHmac("sha1", secretBytes);
  hmac.update(msg);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % Math.pow(10, digits);
  return String(code).padStart(digits, "0");
}

/**
 * Extracts the latest TOTP secret and version from JS bundle code.
 * @param {string} bundleCode
 * @returns {{ secret: string, version: number }}
 */
function extractTotpSecret(bundleCode) {
  const results = [];
  const re = makeSecretRe();
  let match;
  while ((match = re.exec(bundleCode)) !== null) {
    results.push({ secret: match[2], version: parseInt(match[3], 10) });
  }

  if (results.length === 0) {
    throw new Error("No TOTP secrets found in Spotify JS bundles");
  }

  results.sort((a, b) => b.version - a.version);
  return results[0];
}

/**
 * Extracts query hashes from JS bundle text.
 * @param {string} content
 * @returns {Record<string, string>}
 */
function extractQueryHashes(content) {
  const hashes = {};
  const re = makeQueryHashRe();
  let match;
  while ((match = re.exec(content)) !== null) {
    hashes[match[1]] = match[2];
  }
  return hashes;
}

/**
 * Extracts numeric chunk mappings from web-player bundle.
 * Searches specifically in the webpack u.u= function section which contains
 * two maps: a hash map (8-char hex content hashes) and a name map (filenames).
 * URL format: CDN_PREFIX + name + "." + hash + ".js"
 *
 * @param {string} jsCode
 * @returns {{ nameMap: Record<string, string>, hashMap: Record<string, string> } | null}
 */
function extractMappings(jsCode) {
  // Focus on the u.u= section — this is where webpack defines chunk URL maps
  const uuIdx = jsCode.indexOf("u.u=");
  const section = uuIdx >= 0 ? jsCode.slice(uuIdx, uuIdx + 12000) : jsCode;

  // Match all {numericId:"value",...} object literals in the section
  const objRe = /\{(\d+:"[^"]+"(?:,\d+:"[^"]+")*)\}/g;
  const parsed = [];
  let m;
  while ((m = objRe.exec(section)) !== null) {
    try {
      const obj = JSON.parse("{" + m[1].replace(/(\d+):/g, '"$1":') + "}");
      parsed.push(obj);
    } catch (_) {}
  }
  if (parsed.length < 2) return null;

  // Sort by entry count descending
  parsed.sort((a, b) => Object.keys(b).length - Object.keys(a).length);

  // Distinguish maps by value pattern:
  //   hashMap: values are 8-char lowercase hex strings  e.g. "f66ef4fe"
  //   nameMap: values are human-readable filenames       e.g. "dwp-watch-feed-view-container"
  const isHexHash = (v) => /^[0-9a-f]{6,12}$/.test(v);
  let hashMap = null;
  let nameMap = null;

  for (const obj of parsed) {
    const vals = Object.values(obj);
    if (vals.length < 5) continue; // skip tiny incidental maps
    const hexRatio = vals.filter(isHexHash).length / vals.length;
    if (hexRatio > 0.8 && !hashMap) {
      hashMap = obj;
    } else if (hexRatio < 0.3 && !nameMap) {
      nameMap = obj;
    }
    if (hashMap && nameMap) break;
  }

  // Fallback: if we can't distinguish by value pattern, just take the two largest
  if (!hashMap || !nameMap) {
    hashMap = parsed[0];
    nameMap = parsed[1];
  }

  return { nameMap, hashMap };
}

/**
 * Maps the config-style time_range string (short_term / medium_term / long_term)
 * to the Pathfinder AffinityInput TimeRange enum value (SHORT_TERM / MID_TERM / LONG_TERM).
 * @param {string} timeRange
 * @returns {string}
 */
function _toPathfinderTimeRange(timeRange) {
  switch (timeRange) {
    case "medium_term": return "MID_TERM";
    case "long_term":   return "LONG_TERM";
    default:            return "SHORT_TERM";
  }
}



class CookieSpotifyClient extends SpotifyClientBase {
  /**
   * @param {object} [credentials={}]
   * @param {string} [credentials.sp_dc] - The sp_dc cookie value from browser (required for authenticated access)
   * @param {string} [credentials.cookies] - Full raw cookie string (alternative to sp_dc)
   */
  constructor({ sp_dc, cookies } = {}) {
    super();
    // Build cookie header: prefer explicit sp_dc, then full cookie string
    if (sp_dc) {
      this._cookies = `sp_dc=${sp_dc}`;
    } else {
      this._cookies = cookies || "";
    }

    /** @type {string|null} */
    this._accessToken = null;
    /** @type {string|null} */
    this._clientToken = null;
    /** @type {number|null} */
    this._expiresAtMs = null;
    /** @type {string|null} */
    this._clientId = null;
    /** @type {string|null} */
    this._clientVersion = null;
    /** @type {string|null} */
    this._deviceId = null;
    /** @type {Record<string, string>} */
    this._queryHashes = {};

    /** @type {NodeJS.Timeout|null} */
    this._refreshTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle & Session Management
  // ---------------------------------------------------------------------------

  /**
   * Initialises the client by loading a valid cached session or performing
   * the full TOTP-based handshake against Spotify Web Player.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    // 1. Try loading valid cached session from disk
    if (this._loadSession()) {
      // Essential query hashes — if any are missing, rebuild session to fetch sub-chunks
      const essential = ["userTopContent", "searchTracks", "fetchPlaylistContents", "queryPodcastEpisodes", "libraryV3", "fetchPlaylistMetadata"];
      const hasAllHashes = essential.every((op) => !!this._queryHashes[op]);
      if (this._expiresAtMs && this._expiresAtMs > Date.now() + 5 * 60 * 1000 && hasAllHashes) {
        this.startDaemon();
        return;
      }
    }

    // 2. Refresh or build fresh session
    await this._buildFreshSession();
    this.startDaemon();
  }

  /**
   * Starts periodic token refresh (every 30 minutes).
   * @param {number} [intervalMs=1800000]
   */
  startDaemon(intervalMs = 30 * 60 * 1000) {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
    }
    this._refreshTimer = setInterval(async () => {
      try {
        await this._refreshToken();
      } catch (err) {
        // Silently retry next cycle
      }
    }, intervalMs);
    if (this._refreshTimer.unref) {
      this._refreshTimer.unref();
    }
  }

  /**
   * Stops the refresh daemon.
   */
  stopDaemon() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Returns whether a valid authenticated session exists.
   * @returns {{ authenticated: boolean, expiresAt: Date|null }}
   */
  getAuthStatus() {
    const valid = !!(
      this._accessToken &&
      this._expiresAtMs &&
      this._expiresAtMs > Date.now()
    );
    return {
      authenticated: valid,
      expiresAt: this._expiresAtMs ? new Date(this._expiresAtMs) : null,
    };
  }

  /**
   * Loads session data from .cookie-session.json if available.
   * @private
   * @returns {boolean}
   */
  _loadSession() {
    try {
      if (!fs.existsSync(COOKIE_SESSION_FILE)) return false;
      const raw = fs.readFileSync(COOKIE_SESSION_FILE, "utf-8");
      const data = JSON.parse(raw);
      if (!data || !data.access_token) return false;

      this._accessToken = data.access_token;
      this._clientToken = data.client_token || null;
      this._expiresAtMs = data.expires_at || null;
      this._clientId = data.client_id || null;
      this._clientVersion = data.client_version || "1.2.58.498.g467bc068";
      this._deviceId = data.device_id || crypto.randomUUID();
      this._queryHashes = data.query_hashes || {};
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Persists session data to .cookie-session.json.
   * @private
   */
  _saveSession() {
    try {
      const data = {
        access_token: this._accessToken,
        client_token: this._clientToken,
        expires_at: this._expiresAtMs,
        client_id: this._clientId,
        client_version: this._clientVersion,
        device_id: this._deviceId,
        query_hashes: this._queryHashes,
      };
      fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
      fs.writeFileSync(COOKIE_SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (_) {}
  }

  /**
   * Performs full web-player scraping, TOTP generation and token fetching.
   * @private
   */
  async _buildFreshSession() {
    // 1. GET open.spotify.com
    const homeRes = await fetchFn(BASE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!homeRes.ok) {
      throw new Error(`Failed to load Spotify Web Player: HTTP ${homeRes.status}`);
    }

    const html = await homeRes.text();

    // Extract appServerConfig
    if (html.includes(APP_CONFIG_TAG)) {
      try {
        const rawConfig = html.split(APP_CONFIG_TAG)[1].split("</script>")[0];
        const configJson = JSON.parse(Buffer.from(rawConfig, "base64").toString("utf-8"));
        if (configJson && configJson.clientVersion) {
          this._clientVersion = String(configJson.clientVersion);
        }
      } catch (_) {}
    }
    if (!this._clientVersion) {
      this._clientVersion = "1.2.58.498.g467bc068";
    }

    // Extract JS links
    const jsLinks = new Set();
    {
      const jsLinkRe = makeJsLinkRe();
      let match;
      while ((match = jsLinkRe.exec(html)) !== null) {
        if (match[1].includes("spotify")) {
          jsLinks.add(match[1]);
        }
      }
    }

    // Fetch JS bundles to extract hashes & TOTP secret.
    // Priority: exact "web-player." bundle (not vendor~ or encore~).
    const bundles = {};
    let webPlayerCode = "";

    for (const url of jsLinks) {
      try {
        const res = await fetchFn(url);
        if (res.ok) {
          const code = await res.text();
          bundles[url] = code;
          // Only the primary bundle (not vendor~ / encore~ prefixed) holds the secret
          const filename = url.split("/").pop().split("?")[0];
          if (filename.startsWith("web-player.")) {
            webPlayerCode = code;
          }
          Object.assign(this._queryHashes, extractQueryHashes(code));
        }
      } catch (_) {}
    }

    // Fallback: scan all bundles with the real regex (handles URL-naming changes)
    if (!webPlayerCode) {
      for (const [, code] of Object.entries(bundles)) {
        if (makeSecretRe().test(code)) {
          webPlayerCode = code;
          break;
        }
      }
    }

    // Try embedded chunk mappings to fetch more bundles for query hashes + TOTP.
    // userTopContent and searchTracks hashes live in webpack sub-chunks, not the
    // main bundle — we must fetch all chunks to find them.
    if (webPlayerCode) {
      const mappings = extractMappings(webPlayerCode);
      if (mappings) {
        const { nameMap, hashMap } = mappings;
        const extraLinks = [];
        for (const [key, name] of Object.entries(nameMap)) {
          if (hashMap[key]) {
            extraLinks.push(`${CDN_PREFIX}${name}.${hashMap[key]}.js`);
          }
        }
        log(`[cookie] Fetching ${extraLinks.length} sub-chunks for query hashes…`);
        // Fetch all chunks in parallel — userTopContent / searchTracks hashes can
        // be in any sub-chunk, so we cannot safely skip any of them.
        await Promise.allSettled(
          extraLinks.map(async (url) => {
            try {
              const res = await fetchFn(url);
              if (res.ok) {
                const code = await res.text();
                Object.assign(this._queryHashes, extractQueryHashes(code));
              }
            } catch (_) {}
          })
        );
      } else {
        log("[cookie] extractMappings returned null — no sub-chunks loaded");
      }
    }

    // Log which query hashes were found — helpful for diagnosing 412 errors
    const foundHashes = Object.keys(this._queryHashes);
    log(`[cookie] Loaded ${foundHashes.length} query hashes.`);

    // Extract TOTP secret — let the error propagate with full detail
    if (!webPlayerCode) {
      throw new Error(
        `Could not find Spotify web-player bundle. Fetched ${Object.keys(bundles).length} JS files from ${jsLinks.size} links discovered in HTML.`
      );
    }
    const { secret, version: totpVersion } = extractTotpSecret(webPlayerCode);
    const totpCode = generateTotp(decodeSecret(secret));

    // GET open.spotify.com/api/token
    const tokenUrl = `${TOKEN_URL}?reason=init&productType=web-player&totp=${totpCode}&totpServer=${totpCode}&totpVer=${totpVersion}`;
    const tokenHeaders = {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
    if (this._cookies) {
      tokenHeaders["Cookie"] = this._cookies;
    }

    const tokenRes = await fetchFn(tokenUrl, { headers: tokenHeaders });
    if (!tokenRes.ok) {
      throw new Error(`Failed to fetch access token: HTTP ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json();

    // isAnonymous=true means no sp_dc cookie was recognised — user is not logged in
    if (tokenData.isAnonymous === true) {
      throw new Error(
        "Spotify returned an anonymous token. The sp_dc cookie is missing or invalid. " +
        "Please extract a fresh sp_dc cookie from your browser (see Setup Wizard for instructions)."
      );
    }

    this._accessToken = tokenData.accessToken;
    this._expiresAtMs = tokenData.accessTokenExpirationTimestampMs;
    this._clientId = tokenData.clientId;
    if (!this._deviceId) {
      this._deviceId = crypto.randomUUID();
    }

    // POST clienttoken.spotify.com/v1/clienttoken
    await this._fetchClientToken();

    // Persist
    this._saveSession();
  }

  /**
   * Fetches the client_token from clienttoken.spotify.com.
   * @private
   */
  async _fetchClientToken() {
    const payload = {
      client_data: {
        client_version: this._clientVersion || "1.2.58.498.g467bc068",
        client_id: this._clientId || "d8a5ed958d274c2e8ee717e6a4b0971d",
        js_sdk_data: {
          device_brand: "unknown",
          device_model: "unknown",
          os: "windows",
          os_version: "NT 10.0",
          device_id: this._deviceId || crypto.randomUUID(),
          device_type: "computer",
        },
      },
    };

    const res = await fetchFn(CLIENT_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.granted_token && data.granted_token.token) {
        this._clientToken = data.granted_token.token;
      }
    }
  }

  /**
   * Refreshes access token if expiring or invalid.
   * @private
   */
  async _refreshToken() {
    await this._buildFreshSession();
  }

  /**
   * Ensures a valid token is available before calling an endpoint.
   * @private
   */
  async _ensureAuthenticated() {
    if (!this._accessToken || (this._expiresAtMs && this._expiresAtMs <= Date.now() + 60 * 1000)) {
      await this._refreshToken();
    }
  }

  // ---------------------------------------------------------------------------
  // Pathfinder & Internal HTTP Helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves query SHA-256 hash by operation name.
   * @private
   * @param {string} operationName
   * @returns {string}
   */
  _getQueryHash(operationName) {
    return this._queryHashes[operationName] || "";
  }

  /**
   * Executes a Pathfinder GraphQL query against api-partner.spotify.com.
   * @private
   * @param {string} operationName
   * @param {object} variables
   * @param {boolean} [isRetry=false]
   * @returns {Promise<any>} Response `data` object
   */
  async pathfinderQuery(operationName, variables = {}, isRetry = false) {
    await this._ensureAuthenticated();

    let hash = this._getQueryHash(operationName);
    if (!hash) {
      // Re-scan bundles if hash missing
      await this._buildFreshSession();
      hash = this._getQueryHash(operationName);
    }

    const payload = {
      variables,
      operationName,
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: hash,
        },
      },
    };

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${this._accessToken}`,
      "spotify-app-version": this._clientVersion || "1.2.58.498.g467bc068",
      "app-platform": "WebPlayer",
    };

    if (this._clientToken) {
      headers["client-token"] = this._clientToken;
    }

    const res = await fetchFn(PATHFINDER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
      throw new SpotifyQuotaError(retryAfter);
    }

    if (res.status === 401 && !isRetry) {
      await this._refreshToken();
      return this.pathfinderQuery(operationName, variables, true);
    }

    if (res.status === 412 && !isRetry) {
      // Stale query hash (Spotify deployed a new bundle) — refresh all hashes and retry once
      log(`[cookie] 412 Invalid query hash for ${operationName} — rebuilding session hashes…`);
      this._queryHashes = {};
      await this._buildFreshSession();
      return this.pathfinderQuery(operationName, variables, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Pathfinder query ${operationName} failed: HTTP ${res.status} ${text}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0 && !json.data) {
      throw new Error(`Pathfinder GraphQL error: ${json.errors[0].message}`);
    }

    return json.data || {};
  }

  /**
   * Sends an operation to spclient.wg.spotify.com/playlist/v2/playlist
   * @private
   * @param {object} op
   * @returns {Promise<any>}
   */
  async _spclientPlaylistOp(op) {
    await this._ensureAuthenticated();

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${this._accessToken}`,
      "spotify-app-version": this._clientVersion || "1.2.58.498.g467bc068",
      "app-platform": "WebPlayer",
    };
    if (this._clientToken) {
      headers["client-token"] = this._clientToken;
    }

    const res = await fetchFn(SPCLIENT_PLAYLIST_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ ops: [op] }),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
      throw new SpotifyQuotaError(retryAfter);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`spclient playlist op failed: HTTP ${res.status} ${text}`);
    }

    return res.json().catch(() => ({}));
  }

  /**
   * Pushes rootlist changes to spclient.
   * @private
   * @param {string} username
   * @param {object} op
   * @returns {Promise<any>}
   */
  async _spclientPushChanges(username, op) {
    await this._ensureAuthenticated();

    const url = SPCLIENT_ROOTLIST_CHANGES_URL.replace("{username}", encodeURIComponent(username));
    const payload = {
      deltas: [
        {
          ops: [op],
          info: { source: { client: "WEBPLAYER" } },
        },
      ],
    };

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${this._accessToken}`,
      "spotify-app-version": this._clientVersion || "1.2.58.498.g467bc068",
      "app-platform": "WebPlayer",
    };
    if (this._clientToken) {
      headers["client-token"] = this._clientToken;
    }

    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10);
      throw new SpotifyQuotaError(retryAfter);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`spclient push changes failed: HTTP ${res.status} ${text}`);
    }

    return res.json().catch(() => ({}));
  }

  // ---------------------------------------------------------------------------
  // Interface Implementation (17 methods)
  // ---------------------------------------------------------------------------

  /**
   * Fetches the latest episodes for a podcast show.
   * @param {string} showId
   * @param {object} [options]
   * @param {number} [options.limit=1]
   * @param {string} [options.market="US"]
   * @returns {Promise<Array<{uri: string, name: string, show?: string, type: "episode", position?: string}>>}
   */
  async getShowEpisodes(showId, options = {}) {
    const limit = Math.min(Math.max(1, options.limit || 1), 50);
    const uri = showId.startsWith("spotify:show:") ? showId : `spotify:show:${showId}`;

    const data = await this.pathfinderQuery("queryPodcastEpisodes", {
      uri,
      offset: 0,
      limit,
    });

    const items =
      data?.podcastUnionV2?.episodesV2?.items ||
      data?.podcastUnion?.episodes?.items ||
      [];

    return items
      .map((item) => {
        const ep = item.entity?.data || item.data || item;
        const epUri = ep.uri || "";
        const name = ep.name || "";
        if (!epUri) return null;
        return {
          uri: epUri,
          name,
          type: "episode",
        };
      })
      .filter(Boolean);
  }

  /**
   * Fetches the current user's most-played tracks.
   * @param {object} [options]
   * @param {string} [options.time_range="short_term"]
   * @param {number} [options.limit=30]
   * @param {number} [options.offset=0]
   * @returns {Promise<Array<{uri: string, name: string, artist: string, type: "track"}>>}
   */
  async getMyTopTracks(options = {}) {
    const limit = options.limit || 30;
    const offset = options.offset || 0;
    const timeRange = _toPathfinderTimeRange(options.time_range || "short_term");

    const data = await this.pathfinderQuery("userTopContent", {
      includeTopTracks: true,
      topTracksInput: { timeRange, limit, offset, sortBy: "AFFINITY" },
      includeTopArtists: false,
      topArtistsInput: { timeRange, limit: 0, offset: 0, sortBy: "AFFINITY" },
    });

    const items =
      data?.me?.profile?.topTracks?.items ||
      data?.me?.topTracks?.items ||
      data?.me?.topContent?.items ||
      data?.userTopContent?.items ||
      [];

    return items
      .map((item) => {
        const track = item.data || item;
        const uri = track.uri || (track.id ? `spotify:track:${track.id}` : "");
        const name = track.name || "";
        const artist =
          track.artists?.items?.map((a) => a.profile?.name || a.name).filter(Boolean).join(", ") ||
          track.artists?.map((a) => a.name).filter(Boolean).join(", ") ||
          "Unknown";
        if (!uri) return null;
        return { uri, name, artist, type: "track" };
      })
      .filter(Boolean);
  }

  /**
   * Fetches the current user's saved/liked tracks.
   * @param {object} [options]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @returns {Promise<Array<{uri: string, name: string, artist: string, type: "track"}>>}
   */
  async getMySavedTracks(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const data = await this.pathfinderQuery("fetchLibraryTracks", {
      offset,
      limit,
    });

    const items =
      data?.me?.library?.tracks?.items ||
      data?.library?.tracks?.items ||
      [];

    return items
      .map((item) => {
        const track = item.track?.data || item.data || item;
        const uri = track.uri || (track.id ? `spotify:track:${track.id}` : "");
        const name = track.name || "";
        const artist =
          track.artists?.items?.map((a) => a.profile?.name || a.name).filter(Boolean).join(", ") ||
          track.artists?.map((a) => a.name).filter(Boolean).join(", ") ||
          "Unknown";
        if (!uri) return null;
        return { uri, name, artist, type: "track" };
      })
      .filter(Boolean);
  }

  /**
   * Fetches all items (tracks) from a playlist.
   * @param {string} playlistId
   * @param {object} [options]
   * @param {number} [options.limit=100]
   * @param {number} [options.offset=0]
   * @returns {Promise<Array<{uri: string, name: string, artist: string, type: "track"}>>}
   */
  async getPlaylistItems(playlistId, options = {}) {
    const limit      = options.limit      || 100;
    const offset     = options.offset     || 0;
    const tracksOnly = options.tracksOnly !== false; // default true — set false for dashboard
    const rawId = playlistId.replace(/^spotify:playlist:/, "").split("?")[0];
    const uri = `spotify:playlist:${rawId}`;

    const data = await this.pathfinderQuery("fetchPlaylistContents", {
      uri,
      offset,
      limit,
      includeEpisodeContentRatingsV2: true,
    });

    const items = data?.playlistV2?.content?.items || [];

    return items
      .map((entry) => {
        const item = entry.itemV2?.data || entry.data || entry;
        const itemUri = item.uri || "";
        if (itemUri.startsWith("spotify:episode:")) {
          if (tracksOnly) return null;
          return {
            uri:  itemUri,
            name: item.name || "",
            show: item.podcastV2?.data?.name || item.show?.name || "Unknown Show",
            type: "episode",
          };
        }
        if (!itemUri.startsWith("spotify:track:")) return null;
        const name = item.name || "";
        const artist =
          item.artists?.items?.map((a) => a.profile?.name || a.name).filter(Boolean).join(", ") ||
          item.artists?.map((a) => a.name).filter(Boolean).join(", ") ||
          "Unknown";
        return { uri: itemUri, name, artist, type: "track" };
      })
      .filter(Boolean);
  }

  /**
   * Searches Spotify for tracks matching a query.
   * @param {string} query
   * @param {object} [options]
   * @param {number} [options.limit=10]
   * @param {string} [options.market="US"]
   * @returns {Promise<Array<{uri: string, name: string, artist: string, type: "track"}>>}
   */
  async searchTracks(query, options = {}) {
    const limit = options.limit || 10;

    const data = await this.pathfinderQuery("searchTracks", {
      searchTerm: query,
      offset: 0,
      limit,
      numberOfTopResults: 5,
      includeAudiobooks: false,
      includePreReleases: false,
      includeAuthors: false,
    });

    const items =
      data?.searchV2?.tracksV2?.items ||
      data?.tracks?.items ||
      [];

    return items
      .map((item) => {
        const track = item.item?.data || item.data || item;
        const uri = track.uri || (track.id ? `spotify:track:${track.id}` : "");
        const name = track.name || "";
        const artist =
          track.artists?.items?.map((a) => a.profile?.name || a.name).filter(Boolean).join(", ") ||
          track.artists?.map((a) => a.name).filter(Boolean).join(", ") ||
          "Unknown";
        if (!uri) return null;
        return { uri, name, artist, type: "track" };
      })
      .filter(Boolean);
  }

  /**
   * Replaces all items in a playlist with the given URIs.
   * Uses spclient playlist API or addToPlaylist.
   * @param {string} playlistId
   * @param {string[]} uris
   * @returns {Promise<void>}
   */
  async replacePlaylistItems(playlistId, uris) {
    const rawId = playlistId.replace(/^spotify:playlist:/, "").split("?")[0];
    const playlistUri = `spotify:playlist:${rawId}`;

    // 1. Fetch ALL current items (paginate) to collect every UID for removal
    const uidsToRemove = [];
    let offset = 0;
    const pageSize = 100;
    while (true) {
      const page = await this.pathfinderQuery("fetchPlaylistContents", {
        uri: playlistUri,
        offset,
        limit: pageSize,
        includeEpisodeContentRatingsV2: true,
      });
      const items = page?.playlistV2?.content?.items || [];
      for (const item of items) {
        if (item.uid) uidsToRemove.push(item.uid);
      }
      const total = page?.playlistV2?.content?.totalCount ?? items.length;
      offset += items.length;
      if (items.length < pageSize || offset >= total) break;
    }

    // 2. Remove old items if any exist
    if (uidsToRemove.length > 0) {
      try {
        await this.pathfinderQuery("removeFromPlaylist", {
          playlistUri,
          uids: uidsToRemove,
        });
      } catch (_) {
        // Fallback: continue even if remove fails
      }
    }

    // 3. Add new items
    if (uris.length > 0) {
      await this.addPlaylistItems(playlistId, uris);
    }
  }

  /**
   * Adds items to a playlist (POST / addToPlaylist).
   * @param {string} playlistId
   * @param {string[]} uris
   * @returns {Promise<void>}
   */
  async addPlaylistItems(playlistId, uris) {
    if (!uris || uris.length === 0) return;

    const rawId = playlistId.replace(/^spotify:playlist:/, "").split("?")[0];
    const playlistUri = `spotify:playlist:${rawId}`;

    const batch = uris.slice(0, 100);
    await this.pathfinderQuery("addToPlaylist", {
      playlistUri,
      playlistItemUris: batch,
      newPosition: { moveType: "BOTTOM_OF_PLAYLIST", fromUid: null },
    });
  }

  /**
   * Fetches the current user's profile.
   * @returns {Promise<{id: string, display_name?: string, email?: string, images?: Array<{url: string}>, product?: string}>}
   */
  async getMe() {
    const data = await this.pathfinderQuery("profileAttributes", {});
    const profile = data?.me?.profile || data?.profile || {};

    const images = [];
    if (profile.avatar?.sources && Array.isArray(profile.avatar.sources)) {
      for (const s of profile.avatar.sources) {
        if (s.url) images.push({ url: s.url });
      }
    }

    return {
      id: profile.username || profile.id || "me",
      display_name: profile.name || profile.displayName || profile.username || "Spotify User",
      email: profile.email || undefined,
      images,
      product: "premium",
    };
  }

  /**
   * Creates a new playlist for the current user via spclient.
   * @param {string} name
   * @param {object} [options]
   * @param {string} [options.description=""]
   * @param {boolean} [options.public=false]
   * @returns {Promise<{id: string, name: string}>}
   */
  async createPlaylist(name, options = {}) {
    const me = await this.getMe();
    const createOp = {
      kind: "UPDATE_LIST_ATTRIBUTES",
      updateListAttributes: {
        newAttributes: {
          values: {
            name,
            description: options.description || "",
          },
        },
      },
    };

    const res = await this._spclientPlaylistOp(createOp);
    const createdUri = res?.uri || "";
    const rawId = createdUri.replace(/^spotify:playlist:/, "");

    if (createdUri) {
      const addOp = {
        kind: "ADD",
        add: {
          items: [
            {
              uri: createdUri,
              attributes: { timestamp: String(Date.now()) },
            },
          ],
          addFirst: true,
        },
      };
      await this._spclientPushChanges(me.id, addOp).catch(() => {});
    }

    return {
      id: rawId,
      name,
    };
  }

  /**
   * Fetches the current user's playlists.
   * @param {object} [options]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @returns {Promise<Array<{id: string, name: string, images: Array<{url: string}>, owner: string, owner_id: string, is_own: boolean, tracks_total: number}>>}
   */
  async getUserPlaylists(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const data = await this.pathfinderQuery("libraryV3", {
      filters: ["Playlists"],        // correct case-sensitive filter id
      order: null,
      textFilter: "",
      features: ["LIKED_SONGS", "YOUR_EPISODES"],
      limit,
      offset,
      flatten: false,
      expandedFolders: [],
      folderUri: null,
      includeFoldersWhenFlattening: true,
    });

    const items = data?.me?.libraryV3?.items || data?.libraryV3?.items || [];
    return items
      .map((entry) => {
        const item = entry.item?.data || entry.data || entry;
        // Only real playlists (not PseudoPlaylist = Liked Songs, Your Episodes)
        if (item.__typename !== "Playlist") return null;
        const uri = item.uri || "";
        const id = uri.replace(/^spotify:playlist:/, "");
        if (!id || id === uri) return null; // guard: uri didn't start with spotify:playlist:

        const images = [];
        // New schema: images.items[].sources[].url
        if (item.images?.items) {
          for (const img of item.images.items) {
            const src = img.sources?.[0]?.url;
            if (src) images.push({ url: src });
          }
        }

        const ownerName = item.ownerV2?.data?.name || item.owner?.name || "";
        const ownerId   = item.ownerV2?.data?.username || item.ownerV2?.data?.id || item.owner?.id || "";

        return {
          id,
          name:         item.name || "Untitled Playlist",
          images,
          owner:        ownerName,
          owner_id:     ownerId,
          is_own:       true,
          tracks_total: 0,         // not available in libraryV3 schema
        };
      })
      .filter(Boolean);
  }

  /**
   * Fetches the current user's followed podcast shows.
   * @param {object} [options]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @returns {Promise<Array<{id: string, name: string, publisher?: string, images: Array<{url: string}>}>>}
   */
  async getMySavedShows(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const data = await this.pathfinderQuery("libraryV3", {
      filters: ["Podcasts & Shows"],  // correct case-sensitive filter id
      order: null,
      textFilter: "",
      features: ["YOUR_EPISODES"],
      limit,
      offset,
      flatten: false,
      expandedFolders: [],
      folderUri: null,
      includeFoldersWhenFlattening: true,
    });

    const items = data?.me?.libraryV3?.items || data?.libraryV3?.items || [];
    return items
      .map((entry) => {
        const item = entry.item?.data || entry.data || entry;
        // Only real podcasts/shows (not PseudoPlaylist = Your Episodes)
        if (item.__typename !== "Podcast") return null;
        const uri = item.uri || "";
        const id = uri.replace(/^spotify:show:/, "");
        if (!id || id === uri) return null; // guard: uri didn't start with spotify:show:

        const images = [];
        // Podcast schema: coverArt.sources[].url
        if (item.coverArt?.sources) {
          for (const s of item.coverArt.sources) {
            if (s.url) images.push({ url: s.url });
          }
        }

        return {
          id,
          name:      item.name || "",
          publisher: item.publisher?.name || undefined,
          images,
        };
      })
      .filter(Boolean);
  }

  /**
   * Searches Spotify for podcast shows.
   * @param {string} query
   * @param {object} [options]
   * @param {number} [options.limit=10]
   * @returns {Promise<Array<{id: string, name: string, publisher?: string, images: Array<{url: string}>}>>}
   */
  async searchShows(query, options = {}) {
    const limit = options.limit || 10;

    const data = await this.pathfinderQuery("searchPodcasts", {
      searchTerm: query,
      offset: 0,
      limit,
      numberOfTopResults: 5,
      includeAudiobooks: false,
    });

    const items =
      data?.searchV2?.podcasts?.items ||
      data?.podcasts?.items ||
      [];

    return items
      .map((item) => {
        const show = item.data || item;
        const uri = show.uri || "";
        const id = uri.replace(/^spotify:show:/, "");
        if (!id) return null;

        const images = [];
        if (show.coverArt?.sources) {
          for (const s of show.coverArt.sources) {
            if (s.url) images.push({ url: s.url });
          }
        }

        return {
          id,
          name: show.name || "",
          publisher: show.publisher?.name || undefined,
          images,
        };
      })
      .filter(Boolean);
  }

  /**
   * Searches Spotify for playlists.
   * @param {string} query
   * @param {object} [options]
   * @param {number} [options.limit=10]
   * @returns {Promise<Array<{id: string, name: string, images: Array<{url: string}>, owner: string}>>}
   */
  async searchPlaylists(query, options = {}) {
    const limit = options.limit || 10;

    const data = await this.pathfinderQuery("searchPlaylists", {
      searchTerm: query,
      offset: 0,
      limit,
      numberOfTopResults: 5,
    });

    const items =
      data?.searchV2?.playlists?.items ||
      data?.playlists?.items ||
      [];

    return items
      .map((item) => {
        const pl = item.data || item;
        const uri = pl.uri || "";
        const id = uri.replace(/^spotify:playlist:/, "");
        if (!id) return null;

        const images = [];
        if (pl.images?.items) {
          for (const img of pl.images.items) {
            const src = img.sources?.[0]?.url;
            if (src) images.push({ url: src });
          }
        }

        const owner = pl.ownerV2?.data?.name || pl.owner?.name || "";

        return {
          id,
          name: pl.name || "Untitled Playlist",
          images,
          owner,
        };
      })
      .filter(Boolean);
  }

  /**
   * Fetches the current user's top artists.
   * @param {object} [options]
   * @param {string} [options.time_range="short_term"]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @returns {Promise<Array<{name: string, genres?: string[], images?: Array<{url: string}>}>>}
   */
  async getMyTopArtists(options = {}) {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const timeRange = _toPathfinderTimeRange(options.time_range || "short_term");

    const data = await this.pathfinderQuery("userTopContent", {
      includeTopArtists: true,
      topArtistsInput: { timeRange, limit, offset, sortBy: "AFFINITY" },
      includeTopTracks: false,
      topTracksInput: { timeRange, limit: 0, offset: 0, sortBy: "AFFINITY" },
    });

    const items =
      data?.me?.profile?.topArtists?.items ||
      data?.me?.topArtists?.items ||
      data?.me?.topContent?.items ||
      data?.userTopContent?.items ||
      [];

    return items
      .map((item) => {
        const artist = item.data || item;
        const name = artist.profile?.name || artist.name || "";
        if (!name) return null;

        const images = [];
        if (artist.visuals?.avatarImage?.sources) {
          for (const s of artist.visuals.avatarImage.sources) {
            if (s.url) images.push({ url: s.url });
          }
        }

        return {
          name,
          images,
        };
      })
      .filter(Boolean);
  }

  /**
   * Fetches basic metadata for a playlist.
   * @param {string} playlistId
   * @returns {Promise<{id: string, name: string, image: string|null, owner: string|null, tracks_total: number}>}
   */
  async getPlaylistInfo(playlistId) {
    const rawId = playlistId.replace(/^spotify:playlist:/, "").split("?")[0];
    const uri = `spotify:playlist:${rawId}`;

    const data = await this.pathfinderQuery("fetchPlaylistMetadata", {
      uri,
      enableWatchFeedEntrypoint: false,
    });

    const pl = data?.playlistV2 || data?.playlist || {};
    const name = pl.name || "Untitled Playlist";

    let image = null;
    if (pl.images?.items && pl.images.items.length > 0) {
      image = pl.images.items[0]?.sources?.[0]?.url || null;
    }

    const owner = pl.ownerV2?.data?.name || pl.owner?.name || null;
    const tracksTotal = pl.content?.totalCount || 0;

    return {
      id:           rawId,
      name,
      image,
      owner,
      tracks_total: tracksTotal,
    };
  }

  /**
   * Uploads a JPEG cover image for the given playlist.
   *
   * Three-step flow (reverse-engineered from Spotify Web Player hW/hY/hz functions):
   *
   * 1. POST https://image-upload.spotify.com/v4/playlist?playlist_id=<id>
   *    Body: raw JPEG  →  Response: { uploadToken: "<hex32>.<ts>.<sha256>" }
   *
   * 2. POST https://spclient.wg.spotify.com/playlist/v2/playlist/<id>/register-image
   *    Body: { "uploadToken": "<full uploadToken>" },  Accept: application/json
   *    Response: { "picture": "<base64 bytes>" }
   *    — triggers Spotify's CDN image processing pipeline
   *    — the base64 value is the raw image-hash bytes (decodes to ab67706c0000da84…)
   *
   * 3. POST https://spclient.wg.spotify.com/playlist/v2/playlist/<id>/changes
   *    UPDATE_LIST_ATTRIBUTES with { values: { picture: "<base64 from step 2>" },
   *                                  noValue: [] }
   *    — registers the picture on the playlist metadata so clients display it
   *    — picture MUST be the raw base64 string from step 2, NOT the decoded hex
   *
   *    NOTE: POST /v1/playlists/{id}/images is rate-limited (HTTP 429) for
   *    cookie-mode tokens and cannot be used here.
   *
   * @param {string} playlistId
   * @param {string|Buffer} imageData - Base64-encoded JPEG string OR raw JPEG Buffer
   * @returns {Promise<void>}
   */
  async setPlaylistCoverImage(playlistId, imageData) {
    const rawId = playlistId.replace(/^spotify:playlist:/, "").split("?")[0];

    await this._ensureAuthenticated();

    // Accept both base64 string and raw Buffer
    const jpegBuffer = Buffer.isBuffer(imageData)
      ? imageData
      : Buffer.from(imageData, "base64");

    const appVersion = this._clientVersion || "1.2.58.498.g467bc068";
    const commonHeaders = {
      Authorization: `Bearer ${this._accessToken}`,
      "spotify-app-version": appVersion,
      "app-platform": "WebPlayer",
    };
    if (this._clientToken) {
      commonHeaders["client-token"] = this._clientToken;
    }

    // ── Step 1: upload raw JPEG → uploadToken ──────────────────────────────
    const uploadRes = await fetchFn(
      `https://image-upload.spotify.com/v4/playlist?playlist_id=${rawId}`,
      {
        method: "POST",
        headers: { ...commonHeaders, "Content-Type": "image/jpeg" },
        body: jpegBuffer,
      }
    );

    if (uploadRes.status === 429) {
      const retryAfter = parseInt(uploadRes.headers.get("retry-after") || "5", 10);
      throw new SpotifyQuotaError(retryAfter);
    }
    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      throw new Error(`setPlaylistCoverImage upload failed: HTTP ${uploadRes.status} ${text}`);
    }

    const uploadJson = await uploadRes.json();
    const uploadToken = uploadJson.uploadToken || uploadJson.upload_token;
    if (!uploadToken) {
      throw new Error(`setPlaylistCoverImage: no uploadToken in response — ${JSON.stringify(uploadJson)}`);
    }

    // ── Step 2: register-image → picture (base64 bytes) ───────────────────
    // This triggers Spotify's CDN pipeline. The returned base64 `picture` value
    // is the raw image-hash bytes — pass it directly to step 3, do NOT decode to hex.
    const regRes = await fetchFn(
      `https://spclient.wg.spotify.com/playlist/v2/playlist/${rawId}/register-image`,
      {
        method: "POST",
        headers: {
          ...commonHeaders,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ uploadToken }),
      }
    );

    if (regRes.status === 429) {
      const retryAfter = parseInt(regRes.headers.get("retry-after") || "5", 10);
      throw new SpotifyQuotaError(retryAfter);
    }
    if (!regRes.ok) {
      const text = await regRes.text().catch(() => "");
      throw new Error(`setPlaylistCoverImage register-image failed: HTTP ${regRes.status} ${text}`);
    }

    const regJson = await regRes.json().catch(() => ({}));
    const pictureB64 = regJson.picture;
    if (!pictureB64) {
      throw new Error(`setPlaylistCoverImage: no picture in register-image response — ${JSON.stringify(regJson)}`);
    }

    const cdnHex = Buffer.from(pictureB64, "base64").toString("hex");
    log(`[cookie] setPlaylistCoverImage CDN: https://i.scdn.co/image/${cdnHex}`);

    // ── Step 3: UPDATE_LIST_ATTRIBUTES /changes — registers picture on playlist ──
    // picture value must be the raw base64 string from step 2 (Spotify's toJSON
    // serialises bytes fields as base64 when sending JSON to /changes).
    const chgRes = await fetchFn(
      `https://spclient.wg.spotify.com/playlist/v2/playlist/${rawId}/changes`,
      {
        method: "POST",
        headers: { ...commonHeaders, "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify({
          deltas: [{
            ops: [{
              kind: "UPDATE_LIST_ATTRIBUTES",
              updateListAttributes: {
                newAttributes: {
                  values: { picture: pictureB64 },
                  noValue: [],
                },
              },
            }],
            info: { source: { client: "WEBPLAYER" } },
          }],
          wantResultingRevisions: false,
          wantSyncResult: false,
          nonces: [],
        }),
      }
    );

    if (chgRes.status === 429) {
      const retryAfter = parseInt(chgRes.headers.get("retry-after") || "5", 10);
      throw new SpotifyQuotaError(retryAfter);
    }
    if (!chgRes.ok) {
      const text = await chgRes.text().catch(() => "");
      throw new Error(`setPlaylistCoverImage changes failed: HTTP ${chgRes.status} ${text}`);
    }
  }
}

module.exports = {
  CookieSpotifyClient,
  decodeSecret,
  generateTotp,
  extractTotpSecret,
  extractQueryHashes,
  extractMappings,
  setLogger,
};

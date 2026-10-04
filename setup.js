#!/usr/bin/env node
// =============================================================================
// Daily Drive — First-Time Setup
// =============================================================================
// This script authenticates your Spotify account and saves a token file.
// You only need to run this ONCE (or again if your token expires after months).
//
// Usage:  npm run setup
// =============================================================================

const fs = require("fs");
const yaml = require("js-yaml");
const SpotifyWebApi = require("spotify-web-api-node");
const express = require("express");
const { PATHS, resolveSpotifyCredentials } = require("./paths");

const TOKEN_FILE = PATHS.TOKEN_FILE;
const CONFIG_FILE = PATHS.CONFIG_FILE;

// --- Clear any existing token to force fresh auth ---
if (fs.existsSync(TOKEN_FILE)) {
  fs.unlinkSync(TOKEN_FILE);
  console.log("🗑️  Deleted old token — starting fresh auth");
}

// --- Load config (optional when env vars are set) ---
let fileConfig = {};
if (fs.existsSync(CONFIG_FILE)) {
  fileConfig = yaml.load(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
} else if (!process.env.SPOTIFY_CLIENT_ID) {
  console.error("\n❌ config.yaml not found and SPOTIFY_CLIENT_ID env var is not set!");
  console.error("   Run: cp config.example.yaml config.yaml");
  console.error("   Or set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI env vars.\n");
  process.exit(1);
}

const { client_id, client_secret, redirect_uri } = resolveSpotifyCredentials(fileConfig.spotify || {});

if (
  !client_id ||
  !client_secret ||
  client_id === "your-client-id-here"
) {
  console.error("\n❌ Please fill in your Spotify credentials in config.yaml");
  console.error("   See README.md for how to get them.\n");
  process.exit(1);
}

// --- Set up Spotify client ---
const spotifyApi = new SpotifyWebApi({
  clientId: client_id,
  clientSecret: client_secret,
  redirectUri: redirect_uri,
});

const SCOPES = [
  "playlist-modify-public",
  "playlist-modify-private",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-read-private",
  "user-read-recently-played",
  "user-top-read",
  "ugc-image-upload",
];

// --- Start a tiny web server to catch the callback ---
const app = express();
const port = new URL(redirect_uri).port || 8888;

app.get("/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    res.send(`<h1>Error: ${error}</h1><p>Please try again.</p>`);
    console.error(`\n❌ Authorization failed: ${error}\n`);
    process.exit(1);
  }

  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    const tokenData = {
      access_token: data.body.access_token,
      refresh_token: data.body.refresh_token,
      expires_at: Date.now() + data.body.expires_in * 1000,
    };

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));

    res.send(
      "<h1>✅ Success!</h1><p>You can close this window. Daily Drive is ready to go!</p>"
    );
    console.log("\n✅ Authentication successful!");
    console.log(`   Token saved to ${TOKEN_FILE}`);
    console.log("\n   You can now run: npm start\n");

    // Give the browser a moment to show the success page
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    res.send(`<h1>Error</h1><p>${err.message}</p>`);
    console.error("\n❌ Token exchange failed:", err.message, "\n");
    process.exit(1);
  }
});

// Bind to 127.0.0.1 explicitly (Spotify requires this, not "localhost")
app.listen(port, "127.0.0.1", () => {
  const authUrl = spotifyApi.createAuthorizeURL(SCOPES, "dailydrive");

  console.log("\n🎵 Daily Drive — Setup\n");
  console.log("Open this URL in your browser to authorize:\n");
  console.log(`  ${authUrl}\n`);

  // Try to open the browser automatically (works on desktop, not headless)
  import("open")
    .then((open) => open.default(authUrl))
    .catch(() => {
      // If running headless, user will need to copy/paste the URL
      console.log(
        "(If you're on a headless server, copy the URL above to a browser on another machine.)"
      );
      console.log(
        `Make sure your Spotify app's redirect URI is set to: ${redirect_uri}\n`
      );
    });
});

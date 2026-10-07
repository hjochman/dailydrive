#!/usr/bin/env node
// ---------------------------------------------------------------------------
// test-cover-upload.js  —  Diagnose cookie-mode playlist cover image upload
// Usage:  node test-cover-upload.js <playlistId>
// ---------------------------------------------------------------------------
"use strict";

const fs   = require("fs");
const path = require("path");

const playlistId = process.argv[2];
if (!playlistId) {
  console.error("Usage: node test-cover-upload.js <playlistId>");
  process.exit(1);
}

const DATA_DIR         = process.env.DATA_DIR || path.join(__dirname, "data");
const COOKIE_SESSION   = path.join(DATA_DIR, ".cookie-session.json");
const COVER_IMAGE_PATH = path.join(__dirname, "public", "img", "playlist-cover.jpg");

async function main() {
  if (!fs.existsSync(COOKIE_SESSION)) {
    console.error(`❌  Session file not found: ${COOKIE_SESSION}`);
    process.exit(1);
  }
  if (!fs.existsSync(COVER_IMAGE_PATH)) {
    console.error(`❌  Cover image not found: ${COVER_IMAGE_PATH}`);
    process.exit(1);
  }

  const session       = JSON.parse(fs.readFileSync(COOKIE_SESSION, "utf-8"));
  const accessToken   = session.access_token;
  const clientToken   = session.client_token  || null;
  const clientVersion = session.client_version || "1.2.58.498.g467bc068";

  const rawId   = playlistId.replace(/^spotify:playlist:/, "").split("?")[0];
  const jpegBuf = fs.readFileSync(COVER_IMAGE_PATH);

  console.log(`\n─── Session loaded ──────────────────────────────────────────`);
  console.log(`  access_token  : ${accessToken ? accessToken.slice(0, 40) + "…" : "MISSING"}`);
  console.log(`  client_token  : ${clientToken ? clientToken.slice(0, 40) + "…" : "MISSING"}`);
  console.log(`  client_version: ${clientVersion}`);
  console.log(`  playlist_id   : ${rawId}`);
  console.log(`  jpeg size     : ${jpegBuf.length} bytes`);

  const commonHeaders = {
    Authorization:         `Bearer ${accessToken}`,
    "spotify-app-version": clientVersion,
    "app-platform":        "WebPlayer",
  };
  if (clientToken) commonHeaders["client-token"] = clientToken;

  // ── Step 1: upload raw JPEG ───────────────────────────────────────────────
  const uploadUrl = `https://image-upload.spotify.com/v4/playlist?playlist_id=${rawId}`;
  console.log(`\n─── Step 1: POST ${uploadUrl}`);

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": "image/jpeg" },
    body: jpegBuf,
  });
  const uploadBody = await uploadRes.text().catch(() => "");
  console.log(`  Status : ${uploadRes.status}`);
  console.log(`  Body   : ${uploadBody.slice(0, 200)}`);

  if (!uploadRes.ok) {
    console.log(`\n❌  Step 1 failed — stopping`);
    process.exit(1);
  }

  const uploadJson  = JSON.parse(uploadBody);
  const uploadToken = uploadJson.uploadToken || uploadJson.upload_token;
  if (!uploadToken) {
    console.log(`\n❌  No uploadToken in response`);
    process.exit(1);
  }

  // ── Step 2: register-image → picture (base64 bytes) ──────────────────────
  const regUrl = `https://spclient.wg.spotify.com/playlist/v2/playlist/${rawId}/register-image`;
  console.log(`\n─── Step 2: POST ${regUrl}`);

  const regRes = await fetch(regUrl, {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ uploadToken }),
  });
  const regText = await regRes.text().catch(() => "");
  console.log(`  Status: ${regRes.status}`);
  console.log(`  Body  : ${regText.slice(0, 200)}`);

  if (!regRes.ok) {
    console.log(`\n❌  Step 2 failed`);
    process.exit(1);
  }

  const regJson    = JSON.parse(regText);
  const pictureB64 = regJson.picture;
  if (!pictureB64) {
    console.log(`\n❌  No picture in register-image response`);
    process.exit(1);
  }
  const cdnHex = Buffer.from(pictureB64, "base64").toString("hex");
  const cdnUrl = `https://i.scdn.co/image/${cdnHex}`;
  console.log(`  picture (base64): ${pictureB64}`);
  console.log(`  picture (hex)   : ${cdnHex}`);
  const cdnStatus = (await fetch(cdnUrl, { method: "HEAD" })).status;
  console.log(`  CDN status      : ${cdnStatus} ${cdnUrl}`);

  // ── Step 3: UPDATE_LIST_ATTRIBUTES /changes ───────────────────────────────
  const chgUrl = `https://spclient.wg.spotify.com/playlist/v2/playlist/${rawId}/changes`;
  console.log(`\n─── Step 3: POST ${chgUrl}`);
  console.log(`  picture value (base64): ${pictureB64}`);

  const chgRes = await fetch(chgUrl, {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      deltas: [{
        ops: [{
          kind: "UPDATE_LIST_ATTRIBUTES",
          updateListAttributes: {
            newAttributes: { values: { picture: pictureB64 }, noValue: [] },
          },
        }],
        info: { source: { client: "WEBPLAYER" } },
      }],
      wantResultingRevisions: false,
      wantSyncResult: false,
      nonces: [],
    }),
  });
  console.log(`  Status: ${chgRes.status}`);

  if (!chgRes.ok) {
    const t = await chgRes.text().catch(() => "");
    console.log(`  Body: ${t.slice(0, 200)}`);
    console.log(`\n❌  Step 3 failed`);
    process.exit(1);
  }

  console.log(`\n✅  Cover image set successfully!`);
  console.log(`  CDN URL: ${cdnUrl}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

/**
 * auth-helper.js
 *
 * Run this ONCE to get your Twitch OAuth tokens.
 * Usage:  node auth-helper.js
 *
 * It will open a browser, you log in with Twitch, then paste the
 * redirect URL back into the terminal. Tokens are saved to .env
 */

require("dotenv").config();
const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:9876/callback";

// Scopes needed for this project
const SCOPES = [
  "channel:read:subscriptions",  // read sub count + new sub events
  "moderator:read:followers",    // read follower count + new follower events
].join(" ");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("ERROR: Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in your .env file first.");
  process.exit(1);
}

const authUrl =
  `https://id.twitch.tv/oauth2/authorize` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}`;

console.log("\n========================================");
console.log("  Twitch OAuth Token Helper");
console.log("========================================");
console.log("\nOpen this URL in your browser and authorize the app:\n");
console.log(authUrl);
console.log("\nWaiting for Twitch to redirect back...\n");

// Temporary local server to catch the OAuth redirect
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith("/callback")) {
    res.end("Waiting...");
    return;
  }

  const code = parsed.query.code;
  if (!code) {
    res.end("No code found. Try again.");
    server.close();
    return;
  }

  console.log("Got authorization code, exchanging for tokens...");

  // Exchange code for tokens
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });

  const tokens = await tokenRes.json();

  if (!tokens.access_token) {
    console.error("Failed to get tokens:", tokens);
    res.end("Failed. Check the terminal.");
    server.close();
    return;
  }

  // Write tokens back into .env file
  let envContent = fs.readFileSync(".env", "utf8");
  envContent = envContent
    .replace(/TWITCH_ACCESS_TOKEN=.*/,  `TWITCH_ACCESS_TOKEN=${tokens.access_token}`)
    .replace(/TWITCH_REFRESH_TOKEN=.*/, `TWITCH_REFRESH_TOKEN=${tokens.refresh_token}`);
  fs.writeFileSync(".env", envContent);

  console.log("✅ Tokens saved to .env!");
  console.log("   Access token:  " + tokens.access_token.substring(0, 10) + "...");
  console.log("   Refresh token: " + tokens.refresh_token.substring(0, 10) + "...");
  console.log("\nYou can now run:  node server.js\n");

  res.end("<h2>Success! Tokens saved. You can close this tab.</h2>");
  server.close();
});

server.listen(9876, () => {
  console.log("(Listening on http://localhost:9876 for the OAuth callback)");
});

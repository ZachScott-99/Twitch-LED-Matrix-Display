/**
 * server.js  –  Twitch LED Matrix Backend
 *
 * What this does:
 *   1. Connects to Twitch API and fetches your channel stats
 *   2. Listens for real-time events (new followers, new subs) via EventSub
 *   3. Runs a WebSocket server that the ESP32 connects to
 *   4. Pushes display messages to the ESP32 as JSON packets
 *
 * Message types sent to ESP32:
 *   { type: "stats",   text: "Followers: 1234 | Subs: 56" }
 *   { type: "alert",   text: "New follower: CoolUser123" }
 *   { type: "alert",   text: "New sub: AwesomeFan99" }
 *   { type: "command", text: "!yt youtube.com/yourchannel" }
 *   { type: "ping" }   (keepalive, ESP32 ignores display-wise)
 */

require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const axios = require("axios");
const crypto = require("crypto");

// ─── Config ────────────────────────────────────────────────────────────────────
const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_BROADCASTER_LOGIN,
  TWITCH_ACCESS_TOKEN,
  TWITCH_REFRESH_TOKEN,
  WEBHOOK_PUBLIC_URL,
  WEBHOOK_SECRET,
  HTTP_PORT = 3000,
  WS_PORT = 3001,
  POLL_INTERVAL_MS = 60000,
  MESSAGE_DISPLAY_MS = 8000,
  YOUTUBE_URL = "youtube.com/channel",
  TIKTOK_URL = "tiktok.com/@channel",
} = process.env;

// ─── State ─────────────────────────────────────────────────────────────────────
let accessToken = TWITCH_ACCESS_TOKEN;
let refreshToken = TWITCH_REFRESH_TOKEN;
let broadcasterId = null;

let stats = {
  followers: 0,
  subscribers: 0,
  latestFollower: "",
  latestSubscriber: "",
};

// Connected ESP32 WebSocket clients
const esp32Clients = new Set();

// ─── Twitch API helpers ────────────────────────────────────────────────────────

/**
 * Refresh the OAuth access token using the refresh token.
 * Called automatically when API returns 401.
 */
async function refreshAccessToken() {
  console.log("[Auth] Refreshing access token...");
  const res = await axios.post("https://id.twitch.tv/oauth2/token", null, {
    params: {
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
  });
  accessToken = res.data.access_token;
  refreshToken = res.data.refresh_token;

  // Update .env file so tokens persist across restarts
  const fs = require("fs");
  let env = fs.readFileSync(".env", "utf8");
  env = env
    .replace(/TWITCH_ACCESS_TOKEN=.*/, `TWITCH_ACCESS_TOKEN=${accessToken}`)
    .replace(/TWITCH_REFRESH_TOKEN=.*/, `TWITCH_REFRESH_TOKEN=${refreshToken}`);
  fs.writeFileSync(".env", env);
  console.log("[Auth] Token refreshed and saved.");
}

/**
 * Wrapper around axios for Twitch Helix API calls.
 * Automatically retries once after refreshing the token on 401.
 */
async function twitchAPI(path, params = {}) {
  try {
    const res = await axios.get(`https://api.twitch.tv/helix${path}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID,
      },
      params,
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken();
      // Retry once with new token
      const res = await axios.get(`https://api.twitch.tv/helix${path}`, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": TWITCH_CLIENT_ID,
        },
        params,
      });
      return res.data;
    }
    throw err;
  }
}

// ─── Get broadcaster ID (needed for most API calls) ────────────────────────────
async function getBroadcasterId() {
  const data = await twitchAPI("/users", { login: TWITCH_BROADCASTER_LOGIN });
  if (!data.data || data.data.length === 0) {
    throw new Error(`Could not find Twitch user: ${TWITCH_BROADCASTER_LOGIN}`);
  }
  broadcasterId = data.data[0].id;
  console.log(`[Twitch] Broadcaster ID for ${TWITCH_BROADCASTER_LOGIN}: ${broadcasterId}`);
  return broadcasterId;
}

// ─── Fetch channel stats from REST API ────────────────────────────────────────
async function fetchStats() {
  try {
    // Follower count
    const followers = await twitchAPI("/channels/followers", {
      broadcaster_id: broadcasterId,
    });
    stats.followers = followers.total ?? stats.followers;

    // Latest follower (first result is most recent)
    if (followers.data && followers.data.length > 0) {
      stats.latestFollower = followers.data[0].user_name;
    }

    // Subscriber count (requires affiliate/partner status)
    try {
      const subs = await twitchAPI("/subscriptions", {
        broadcaster_id: broadcasterId,
      });
      stats.subscribers = subs.total ?? stats.subscribers;

      if (subs.data && subs.data.length > 0) {
        stats.latestSubscriber = subs.data[0].user_name;
      }
    } catch (subErr) {
      // Non-affiliates won't have sub access — that's fine
      if (subErr.response?.status !== 403) throw subErr;
    }

    console.log(`[Stats] Followers: ${stats.followers} | Subs: ${stats.subscribers} | Latest follower: ${stats.latestFollower}`);
    broadcastStats();
  } catch (err) {
    console.error("[Stats] Failed to fetch stats:", err.message);
  }
}

// ─── WebSocket: send message to all connected ESP32s ──────────────────────────
function sendToAll(payload) {
  const msg = JSON.stringify(payload);
  for (const client of esp32Clients) {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  }
}

/** Push current stats as a scrolling display message */
function broadcastStats() {
  const parts = [];
  parts.push(`Followers: ${stats.followers}`);
  parts.push(`Subs: ${stats.subscribers}`);
  if (stats.latestFollower)   parts.push(`Latest follow: ${stats.latestFollower}`);
  if (stats.latestSubscriber) parts.push(`Latest sub: ${stats.latestSubscriber}`);

  sendToAll({
    type: "stats",
    text: parts.join("  |  "),
    displayMs: parseInt(MESSAGE_DISPLAY_MS),
  });
}

/** Push a priority alert (new follower or sub) — interrupts current display */
function broadcastAlert(text) {
  console.log(`[Alert] ${text}`);
  sendToAll({
    type: "alert",
    text,
    displayMs: 5000, // Show alert for 5 seconds then resume rotation
  });
}

/** Push a command/social link message */
function broadcastCommand(command, url) {
  sendToAll({
    type: "command",
    text: `${command}  ${url}`,
    displayMs: parseInt(MESSAGE_DISPLAY_MS),
  });
}

// ─── Rotation: cycle through messages on a timer ──────────────────────────────
const rotationMessages = [];
let rotationIndex = 0;

function buildRotation() {
  rotationMessages.length = 0;
  rotationMessages.push(() => broadcastStats());
  rotationMessages.push(() => broadcastCommand("!yt", YOUTUBE_URL));
  rotationMessages.push(() => broadcastCommand("!tiktok", TIKTOK_URL));
  // Add more commands here as needed
}

function startRotation() {
  buildRotation();
  // Send first message immediately
  rotationMessages[rotationIndex]();

  setInterval(() => {
    rotationIndex = (rotationIndex + 1) % rotationMessages.length;
    rotationMessages[rotationIndex]();
  }, parseInt(MESSAGE_DISPLAY_MS));
}

// ─── Express app (for EventSub webhooks) ──────────────────────────────────────
const app = express();

// Raw body needed for HMAC signature verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Health check
app.get("/", (req, res) => res.json({ status: "ok", stats }));

/**
 * Twitch EventSub webhook endpoint
 * Twitch sends POST requests here for new followers and subscribers
 */
app.post("/webhook/twitch", (req, res) => {
  const messageId        = req.headers["twitch-eventsub-message-id"];
  const timestamp        = req.headers["twitch-eventsub-message-timestamp"];
  const signature        = req.headers["twitch-eventsub-message-signature"];
  const messageType      = req.headers["twitch-eventsub-message-type"];
  const subscriptionType = req.body?.subscription?.type;

  // ── Verify HMAC signature ──
  const hmacMessage = messageId + timestamp + req.rawBody.toString();
  const expectedSig = "sha256=" + crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(hmacMessage)
    .digest("hex");

  if (signature !== expectedSig) {
    console.warn("[Webhook] Invalid signature — ignoring request");
    return res.status(403).send("Forbidden");
  }

  // ── Challenge verification (Twitch sends this when you first subscribe) ──
  if (messageType === "webhook_callback_verification") {
    console.log(`[Webhook] Verified subscription: ${subscriptionType}`);
    return res.status(200).send(req.body.challenge);
  }

  // ── Notification ──
  if (messageType === "notification") {
    const event = req.body.event;

    if (subscriptionType === "channel.follow") {
      const name = event.user_name;
      stats.latestFollower = name;
      stats.followers++;
      broadcastAlert(`New follower: ${name}`);
    }

    if (subscriptionType === "channel.subscribe") {
      const name = event.user_name;
      stats.latestSubscriber = name;
      stats.subscribers++;
      broadcastAlert(`New sub: ${name}`);
    }

    if (subscriptionType === "channel.subscription.gift") {
      const gifter = event.user_name;
      const count  = event.total;
      broadcastAlert(`${gifter} gifted ${count} sub${count > 1 ? "s" : ""}!`);
    }

    return res.status(204).send();
  }

  res.status(200).send();
});

// ─── Register EventSub subscriptions with Twitch ──────────────────────────────
async function registerEventSub() {
  if (!WEBHOOK_PUBLIC_URL || WEBHOOK_PUBLIC_URL.includes("your-ngrok")) {
    console.warn("[EventSub] WEBHOOK_PUBLIC_URL not set — skipping EventSub registration.");
    console.warn("           Real-time alerts (new follower/sub) will not work.");
    console.warn("           Set WEBHOOK_PUBLIC_URL in .env and restart.");
    return;
  }

  const webhookUrl = `${WEBHOOK_PUBLIC_URL}/webhook/twitch`;

  // Event types to subscribe to
  const subscriptions = [
    {
      type: "channel.follow",
      version: "2",
      condition: {
        broadcaster_user_id: broadcasterId,
        moderator_user_id: broadcasterId,
      },
    },
    {
      type: "channel.subscribe",
      version: "1",
      condition: { broadcaster_user_id: broadcasterId },
    },
    {
      type: "channel.subscription.gift",
      version: "1",
      condition: { broadcaster_user_id: broadcasterId },
    },
  ];

  for (const sub of subscriptions) {
    try {
      await axios.post(
        "https://api.twitch.tv/helix/eventsub/subscriptions",
        {
          type: sub.type,
          version: sub.version,
          condition: sub.condition,
          transport: {
            method: "webhook",
            callback: webhookUrl,
            secret: WEBHOOK_SECRET,
          },
        },
        {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Client-Id": TWITCH_CLIENT_ID,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`[EventSub] Subscribed to: ${sub.type}`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      // "already exists" is fine — just means it's already registered
      if (msg.includes("already exists")) {
        console.log(`[EventSub] Already subscribed to: ${sub.type}`);
      } else {
        console.error(`[EventSub] Failed to subscribe to ${sub.type}: ${msg}`);
      }
    }
  }
}

// ─── WebSocket server (ESP32 connects here) ───────────────────────────────────
function startWebSocketServer() {
  const wss = new WebSocketServer({ port: parseInt(WS_PORT) });

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[WS] ESP32 connected from ${ip}`);
    esp32Clients.add(ws);

    // Send current stats immediately on connect
    broadcastStats();

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log(`[WS] Received from ESP32:`, msg);
      } catch {
        console.log(`[WS] Raw message from ESP32: ${data}`);
      }
    });

    ws.on("close", () => {
      console.log(`[WS] ESP32 disconnected from ${ip}`);
      esp32Clients.delete(ws);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error:`, err.message);
      esp32Clients.delete(ws);
    });
  });

  console.log(`[WS] WebSocket server listening on ws://localhost:${WS_PORT}`);
}

// ─── Keepalive ping to ESP32 ──────────────────────────────────────────────────
function startPing() {
  setInterval(() => {
    sendToAll({ type: "ping" });
  }, 30000); // every 30 seconds
}

// ─── Main startup ─────────────────────────────────────────────────────────────
async function main() {
  console.log("\n========================================");
  console.log("  Twitch LED Matrix Backend");
  console.log("========================================\n");

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.error("ERROR: Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in .env");
    process.exit(1);
  }
  if (!accessToken) {
    console.error("ERROR: No TWITCH_ACCESS_TOKEN in .env — run node auth-helper.js first");
    process.exit(1);
  }

  // Get broadcaster ID
  await getBroadcasterId();

  // Start HTTP server for webhooks
  app.listen(parseInt(HTTP_PORT), () => {
    console.log(`[HTTP] Express server listening on port ${HTTP_PORT}`);
  });

  // Start WebSocket server for ESP32
  startWebSocketServer();

  // Fetch stats immediately, then on interval
  await fetchStats();
  setInterval(fetchStats, parseInt(POLL_INTERVAL_MS));

  // Register EventSub webhooks with Twitch
  await registerEventSub();

  // Start rotation loop
  startRotation();

  // Start keepalive pings
  startPing();

  console.log("\n✅ Server running. Waiting for ESP32 to connect...\n");
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

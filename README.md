# Twitch LED Matrix Display

A real-time Twitch stats display built with an **ESP32** and **9x MAX7219 8x8 LED matrix modules**.
Scrolls your follower count, sub count, latest follower/sub, and custom commands — with instant pop-up alerts when someone new follows or subscribes.

---

## Features

- **Live stats** — follower count, subscriber count, latest follower, latest subscriber
- **Real-time alerts** — new follower or subscriber name pops up instantly, interrupting the scroll
- **Auto-rotation** — messages cycle on a timer you control
- **Custom commands** — display `!yt`, `!tiktok`, or any links you want
- **Wi-Fi connected** — ESP32 talks to a lightweight Node.js backend over WebSocket
- **Gift sub support** — announces gifted subs too

---

## Hardware

| Part | Qty |
|------|-----|
| ESP32-WROOM-32 dev board | 1 |
| HiLetgo MAX7219 8x8 LED matrix module | 9 |
| 5V 3A USB power supply (for the matrices) | 1 |
| Jumper wires | — |

> **Power note:** 9 modules at full brightness draw ~2A at 5V. Use a dedicated power supply — do not run them off the ESP32's 5V pin.

---

## Wiring

```
ESP32 Pin   →   All 9 MAX7219 modules (parallel on CLK/CS, chained on DIN)
──────────────────────────────────────────────────────────
GPIO 23     →   DIN   (connect to module 1 only — chain DOUT→DIN between modules)
GPIO 18     →   CLK   (all modules in parallel)
GPIO 5      →   CS    (all modules in parallel)
External 5V →   VCC   (all modules — use dedicated PSU)
Common GND  →   GND   (shared between ESP32 and PSU)
```

**Chaining the modules:**
```
[ESP32 GPIO23] → DIN[M1]DOUT → DIN[M2]DOUT → DIN[M3]DOUT → ... → DIN[M9]
```

---

## Project structure

```
twitch-led/
├── .gitignore
├── README.md
├── backend/
│   ├── server.js          ← Main backend server (run this on your PC)
│   ├── auth-helper.js     ← Run once to get your Twitch OAuth tokens
│   ├── package.json
│   └── .env.example       ← Copy to .env and fill in your credentials
└── esp32/
    └── TwitchLED/
        └── TwitchLED.ino  ← Upload to your ESP32 via Arduino IDE
```

---

## Setup

### 1. Twitch developer app

1. Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
2. Click **Register Your Application**
3. Set OAuth Redirect URL to `http://localhost:9876/callback`
4. Category: **Other** | Client Type: **Confidential**
5. Save your **Client ID** and **Client Secret**

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Fill in `.env` with your Twitch credentials, channel name, and social links.

### 3. Get OAuth tokens (one time only)

```bash
node auth-helper.js
```

Opens a browser, you log in with Twitch, tokens are saved to `.env` automatically.

### 4. Set up ngrok (for real-time alerts)

[ngrok](https://ngrok.com/) creates a public tunnel so Twitch can send you live events.

```bash
ngrok http 3000
```

Copy the `https://` URL into `.env` as `WEBHOOK_PUBLIC_URL`.

### 5. Arduino IDE

**Add ESP32 board support** — File → Preferences → Additional boards URL:
```
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

**Install libraries** via Tools → Manage Libraries:
- `MD_Parola` by MajicDesigns
- `MD_MAX72XX` by MajicDesigns
- `ArduinoJson` by Benoit Blanchon
- `ArduinoWebsockets` by Gil Maimon

**Edit `TwitchLED.ino`** — update these 4 lines at the top:
```cpp
#define WIFI_SSID     "YourWiFiName"
#define WIFI_PASSWORD "YourWiFiPassword"
#define WS_HOST       "192.168.1.100"   // Your PC's local IP (ipconfig / ifconfig)
#define WS_PORT       3001
```

Upload to your ESP32.

### 6. Run

```bash
cd backend
node server.js
```

The ESP32 will connect and the display will start scrolling.

---

## Configuration

All settings live in `backend/.env`:

| Setting | Default | Description |
|---------|---------|-------------|
| `POLL_INTERVAL_MS` | `60000` | How often to refresh stats from Twitch (ms) |
| `MESSAGE_DISPLAY_MS` | `8000` | How long each message shows before rotating (ms) |
| `YOUTUBE_URL` | — | Shown when `!yt` rotates in |
| `TIKTOK_URL` | — | Shown when `!tiktok` rotates in |

**Scroll speed and brightness** are set in `TwitchLED.ino`:
```cpp
#define SCROLL_SPEED        40   // Lower = faster. Try 25–80
#define DISPLAY_BRIGHTNESS   7   // 0 = dim, 15 = max
```

**Adding more commands** — in `server.js` find `buildRotation()`:
```javascript
rotationMessages.push(() => broadcastCommand("!discord", "discord.gg/yourserver"));
rotationMessages.push(() => broadcastCommand("!merch",   "yourstore.com"));
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Display shows garbage characters | Wrong hardware type — change `FC16_HW` to `GENERIC_HW` in the `.ino` |
| Only first module lights up | Check DOUT→DIN chaining between modules |
| ESP32 won't connect to Wi-Fi | Confirm 2.4GHz network (ESP32 doesn't support 5GHz) |
| WebSocket won't connect | Use your PC's LAN IP in `WS_HOST`, not `localhost` |
| Follower count stays 0 | OAuth token missing `moderator:read:followers` scope — re-run `auth-helper.js` |
| Sub count stays 0 | Requires Twitch Affiliate or Partner status |
| No live alerts | ngrok not running, or `WEBHOOK_PUBLIC_URL` not set in `.env` |

---

## Security note

Your `.env` file contains your Twitch client secret and OAuth tokens.
It is listed in `.gitignore` and will **never** be committed to this repository.
Never share it or paste it anywhere publicly. The `.env.example` file (which has no real credentials) is safe and is included as a setup template.

---

## License

MIT — do whatever you want with it.

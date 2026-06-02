# Twitch LED Matrix Display
## ESP32 + 9× MAX7219 + Twitch API

Displays live Twitch stats and real-time follower/subscriber alerts
on a scrolling 8×8 LED matrix display.

---

## What you need

**Hardware**
- ESP32-WROOM-32 dev board
- 9× HiLetgo MAX7219 8×8 LED matrix modules
- 5V 3A power supply (USB wall charger works great)
- Jumper wires
- Optional: breadboard for prototyping

**Software**
- [Arduino IDE 2.x](https://www.arduino.cc/en/software)
- [Node.js 18+](https://nodejs.org/)
- [ngrok](https://ngrok.com/) (free account — for receiving Twitch webhooks)

---

## Wiring

```
ESP32 Pin   →   MAX7219 Pin   (all 9 modules share these 3 lines)
─────────────────────────────────────────────────────────────────
GPIO 23     →   DIN           (data in, MOSI)
GPIO 18     →   CLK           (clock)
GPIO 5      →   CS            (chip select / LOAD)

External 5V →   VCC           (DO NOT use ESP32's 5V pin for 9 modules)
Common GND  →   GND           (connect ESP32 GND and PSU GND together)
```

**Chaining modules:**
```
[ Module 1 ] DOUT → DIN [ Module 2 ] DOUT → DIN [ Module 3 ] ... → [ Module 9 ]
     ↑
Connect DIN of Module 1 to ESP32 GPIO 23
CLK and CS run parallel to ALL modules
```

**Power note:** 9 modules at full brightness draw up to 2A at 5V.
Use a dedicated power supply. Connect both the PSU GND and ESP32 GND
to the modules' GND pins (common ground).

---

## Step 1 — Twitch Developer App

1. Go to https://dev.twitch.tv/console/apps
2. Click **Register Your Application**
3. Name: anything (e.g. "LED Matrix")
4. OAuth Redirect URL: `http://localhost:9876/callback`
5. Category: **Other**
6. Click **Create**
7. Copy your **Client ID** and generate a **Client Secret** — save both

---

## Step 2 — Backend setup

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `TWITCH_CLIENT_ID` — from Step 1
- `TWITCH_CLIENT_SECRET` — from Step 1
- `TWITCH_BROADCASTER_LOGIN` — your Twitch username (lowercase)
- `WEBHOOK_SECRET` — make up any random string, e.g. `abc123xyz789`
- `YOUTUBE_URL` and `TIKTOK_URL` — your social links

---

## Step 3 — Get OAuth tokens

```bash
cd backend
node auth-helper.js
```

This will print a URL. Open it in your browser, log in with your
Twitch account, and authorize. The tokens are automatically saved
to your `.env` file.

---

## Step 4 — Set up ngrok (for real-time alerts)

ngrok creates a public HTTPS tunnel to your local server so Twitch
can send webhook events to you.

1. Sign up free at https://ngrok.com/
2. Download ngrok and follow their setup (add your authtoken)
3. In a terminal run:
   ```bash
   ngrok http 3000
   ```
4. Copy the `https://` URL it gives you (e.g. `https://abc123.ngrok.io`)
5. Paste it into `.env` as `WEBHOOK_PUBLIC_URL`

**Leave ngrok running whenever you run the server.**

> Without ngrok, the server still works — it will poll for stats
> every 60 seconds. You just won't get instant new-follower/sub alerts.

---

## Step 5 — Arduino IDE setup

### Add ESP32 board support
1. Open Arduino IDE → **File → Preferences**
2. Under "Additional boards manager URLs" add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Go to **Tools → Board → Boards Manager**
4. Search "esp32" → install **esp32 by Espressif Systems**

### Install libraries (Tools → Manage Libraries)
Search and install each:
- **MD_Parola** by MajicDesigns
- **MD_MAX72XX** by MajicDesigns
- **ArduinoJson** by Benoit Blanchon
- **ArduinoWebsockets** by Gil Maimon

### Board settings (Tools menu)
```
Board:            ESP32 Dev Module
Upload Speed:     921600
Flash Size:       4MB (32Mb)
Partition Scheme: Default 4MB with spiffs
Port:             (whichever COM/tty port your ESP32 appears on)
```

---

## Step 6 — Configure and upload the sketch

Open `esp32/TwitchLED/TwitchLED.ino` in Arduino IDE.

Edit the top of the file:
```cpp
#define WIFI_SSID       "YourWiFiNetworkName"
#define WIFI_PASSWORD   "YourWiFiPassword"
#define WS_HOST         "192.168.1.100"   // ← your PC's local IP address
#define WS_PORT         3001
```

**Finding your PC's local IP:**
- Windows: open Command Prompt → type `ipconfig` → look for IPv4 Address
- Mac: System Settings → Wi-Fi → Details → IP Address
- Linux: `ip addr` or `ifconfig`

Click **Upload** (→ button). Open **Serial Monitor** at 115200 baud
to watch the connection log.

---

## Step 7 — Start the backend server

```bash
cd backend
node server.js
```

You should see:
```
✅ Server running. Waiting for ESP32 to connect...
[WS] ESP32 connected from 192.168.1.xxx
[Stats] Followers: 1234 | Subs: 56
```

And on the display, text will start scrolling!

---

## Customizing messages

### Add more commands to the rotation
In `server.js`, find `buildRotation()` and add lines:

```javascript
rotationMessages.push(() => broadcastCommand("!discord", "discord.gg/yourserver"));
rotationMessages.push(() => broadcastCommand("!merch",   "yourstore.com"));
```

### Change scroll speed
In `TwitchLED.ino`:
```cpp
#define SCROLL_SPEED 40   // lower = faster; try 25–80
```

### Change display brightness
```cpp
#define DISPLAY_BRIGHTNESS 7  // 0 = dimmest, 15 = brightest
```

### Change how long each message shows
In `.env`:
```
MESSAGE_DISPLAY_MS=8000   # 8 seconds per message
```

### Change stats poll frequency
```
POLL_INTERVAL_MS=60000    # 60 seconds between Twitch API polls
```

---

## Troubleshooting

| Problem | Fix |
|--------|-----|
| Display shows garbage / wrong brightness | Wrong `HARDWARE_TYPE` — try `MD_MAX72XX::GENERIC_HW` instead of `FC16_HW` |
| Display only shows first module | Check DOUT→DIN chaining between modules |
| ESP32 won't connect to Wi-Fi | Double-check SSID/password, make sure it's 2.4GHz not 5GHz |
| ESP32 connects to Wi-Fi but not WebSocket | Check `WS_HOST` IP — must be your PC's IP, not `localhost` |
| Followers show as 0 | Make sure your OAuth token has `moderator:read:followers` scope |
| Subs show as 0 | Requires Twitch Affiliate or Partner status |
| No real-time alerts | ngrok URL not set or ngrok not running |
| "Invalid signature" in server logs | `WEBHOOK_SECRET` in `.env` doesn't match what was sent to Twitch — delete and re-register EventSub subscriptions |

---

## File structure

```
twitch-led/
├── backend/
│   ├── server.js          ← Main backend (run this)
│   ├── auth-helper.js     ← Run once to get OAuth tokens
│   ├── package.json
│   ├── .env.example       ← Copy to .env and fill in
│   └── .env               ← Your secrets (never share this)
└── esp32/
    └── TwitchLED/
        └── TwitchLED.ino  ← Upload to ESP32 via Arduino IDE
```

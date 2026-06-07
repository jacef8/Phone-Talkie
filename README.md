# BREAKER — Push-to-Talk Walkie Talkie

A real-time group PTT app. Works in the browser, installs to the home screen like a native app.

---

## How it works

- Users open a link or install from home screen
- Create a room (get a 6-character code) or join with someone's code
- Hold the PTT button to talk — everyone in the room hears you live
- Audio is peer-to-peer via WebRTC (the server only handles the handshake)

---

## Deploy in 10 minutes (Railway)

### Step 1 — Push to GitHub

1. Create a new repository on github.com (call it `breaker`)
2. Upload all files in this folder to that repo

### Step 2 — Deploy on Railway

1. Go to railway.app and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `breaker` repository
4. Railway auto-detects Node.js and runs `npm start`
5. Click **Settings → Networking → Generate Domain**
6. Copy your domain (e.g. `breaker-production.up.railway.app`)

### Step 3 — Point the app at your server

Open `app.js` and update line 8:

```js
// Replace this:
: `wss://${window.location.hostname}`;

// With your Railway domain:
: 'wss://breaker-production.up.railway.app';
```

Commit and push — Railway redeploys automatically.

### Step 4 — Share the link

Send users: `https://breaker-production.up.railway.app`

On iPhone: Safari → Share → Add to Home Screen
On Android: Chrome → Menu → Add to Home Screen

---

## File structure

```
breaker/
├── server.js      — WebSocket signaling server (Node.js)
├── package.json   — dependencies (just "ws")
├── index.html     — the app UI
├── app.js         — WebRTC + signaling client logic
├── manifest.json  — PWA manifest (home screen install)
├── sw.js          — service worker (offline support)
└── README.md      — this file
```

---

## Cost

- **Railway free tier** — enough for small groups (under 20 users)
- **Google STUN** — free, already configured
- **TURN server** — not needed for most connections; add Metered.ca free tier if someone can't connect

---

## Adding icons (optional)

Generate icons at pwabuilder.com/imageGenerator and drop them in the root folder:
- `icon-192.png`
- `icon-512.png`

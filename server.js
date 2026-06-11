const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

// ── R2 CONFIG ──
const R2_ACCOUNT_ID = 'a4e243405b2594de2724c549fb0f8ebc';
const R2_ACCESS_KEY = 'a9aad766f322c9a4f41a6e9b551a6444';
const R2_SECRET_KEY = '9e06dd1bdc3c2e72907b2a7f267075202';
const R2_BUCKET     = 'beakermessages';
const R2_ENDPOINT   = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// Recent messages (in memory, survives restarts via R2 URLs)
const recentMessages = []; // { id, url, name, duration, ts }
const MAX_MESSAGES = 10;

// ── AWS SigV4 for R2 ──
function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str).digest();
}
function hmacHex(key, str) {
  return crypto.createHmac('sha256', key).update(str).digest('hex');
}

async function uploadToR2(buffer, filename, contentType) {
  const { default: https } = await import('https');
  
  const date = new Date();
  const dateStr = date.toISOString().replace(/[:-]|\.\d{3}/g, '').substring(0, 8);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const region = 'auto';
  const service = 's3';
  
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const urlPath = `/${R2_BUCKET}/${filename}`;
  
  const payloadHash = crypto.createHash('sha256').update(buffer).digest('hex');
  
  const headers = {
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'content-type': contentType,
    'content-length': buffer.length.toString(),
  };
  
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  
  const canonicalRequest = [
    'PUT', urlPath, '',
    canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');
  
  const credentialScope = `${dateStr}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + R2_SECRET_KEY, dateStr), region), service), 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);
  
  const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: urlPath,
      method: 'PUT',
      headers: { ...headers, 'authorization': authorization },
    }, res => {
      if (res.statusCode === 200) {
        resolve(`${R2_ENDPOINT}/${R2_BUCKET}/${filename}`);
      } else {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => reject(new Error(`R2 upload failed: ${res.statusCode} ${body}`)));
      }
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

const PORT = process.env.PORT || 3000;
const ROOMS_FILE = path.join(process.cwd(), 'rooms.json');

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.css':  'text/css',
};

// Find where index.html actually lives
function findBase() {
  const candidates = [
    '/app',
    path.join(__dirname),
    path.join(process.cwd()),
    path.join(__dirname, '..'),
    path.join(process.cwd(), '..'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      console.log(`Found index.html in: ${dir}`);
      return dir;
    }
  }
  // Log all files in /app and cwd for debugging
  try { console.log('Files in /app:', fs.readdirSync('/app').join(', ')); } catch(e) {}
  try { console.log('Files in cwd:', fs.readdirSync(process.cwd()).join(', ')); } catch(e) {}
  try { console.log('Files in __dirname:', fs.readdirSync(__dirname).join(', ')); } catch(e) {}
  return process.cwd(); // fallback
}

const BASE = findBase();
console.log(`Serving static files from: ${BASE}`);

// ── UPLOAD ENDPOINT ──
async function handleUpload(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://localhost');
      const name = url.searchParams.get('name') || 'Unknown';
      const duration = parseInt(url.searchParams.get('duration') || '0');
      const room = url.searchParams.get('room') || 'BREAKER';
      
      const filename = `${Date.now()}-${Math.random().toString(36).substring(2,8)}.webm`;
      
      // Upload to R2
      const audioUrl = await uploadToR2(body, filename, 'audio/webm');
      
      // Store in recent messages
      const msg = { id: filename, url: audioUrl, name, duration, ts: Date.now() };
      recentMessages.unshift(msg);
      if (recentMessages.length > MAX_MESSAGES) recentMessages.pop();
      
      console.log(`Audio uploaded: ${name} - ${filename}`);
      
      // Broadcast to room
      const roomObj = rooms.get(room.toUpperCase());
      if (roomObj) {
        broadcast(roomObj, { type: 'new-message', message: msg });
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, url: audioUrl }));
    } catch(e) {
      console.error('Upload error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

// ── MESSAGES ENDPOINT ──
function handleMessages(res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(recentMessages));
}

// HTTP server — serves static files
const server = http.createServer((req, res) => {
  // Handle upload endpoint
  if (req.method === 'POST' && req.url.startsWith('/upload')) {
    return handleUpload(req, res);
  }
  if (req.method === 'GET' && req.url.startsWith('/messages')) {
    return handleMessages(res);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  const urlPath = req.url.split('?')[0];
  const fileName = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const filePath = path.join(BASE, fileName);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fall back to index.html for any unknown route
      fs.readFile(path.join(BASE, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`Not found. BASE=${BASE}, file=${filePath}`);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// rooms: { roomCode: { id, name, peers: Map<peerId, ws> } }
const rooms = new Map();
const disconnectTimers = new Map(); // peerId → timer, for grace period reconnects

// ── PERSISTENCE ──────────────────────────
function saveRooms() {
  try {
    const data = {};
    rooms.forEach((room, code) => {
      data[code] = { code: room.code, name: room.name };
    });
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.error('Failed to save rooms:', e.message);
  }
}

function loadRooms() {
  try {
    if (!fs.existsSync(ROOMS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    Object.values(data).forEach(r => {
      rooms.set(r.code, {
        code: r.code,
        name: r.name,
        peers: new Map(), // peers reconnect fresh
      });
    });
    console.log(`Loaded ${rooms.size} rooms from disk`);
  } catch(e) {
    console.error('Failed to load rooms:', e.message);
  }
}

// Load rooms on startup
loadRooms();

// Always ensure the permanent room exists
const PERMANENT_ROOM = { code: 'BREAKER', name: 'BREAKER' };
if (!rooms.has(PERMANENT_ROOM.code)) {
  rooms.set(PERMANENT_ROOM.code, {
    code: PERMANENT_ROOM.code,
    name: PERMANENT_ROOM.name,
    peers: new Map(),
  });
  console.log('Permanent room created: BREAKER');
  saveRooms();
}

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomList() {
  return [...rooms.values()].map(r => ({
    code: r.code,
    name: r.name,
    memberCount: r.peers.size,
  }));
}

function broadcastRoomList() {
  const list = JSON.stringify({ type: 'room-list', rooms: getRoomList() });
  wss.clients.forEach(client => {
    if (client.readyState === 1 && !client.roomCode) {
      client.send(list);
    }
  });
}

function broadcast(room, message, excludeId = null) {
  room.peers.forEach((ws, peerId) => {
    if (peerId !== excludeId && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  });
}

function roomInfo(room, excludeId = null) {
  return {
    code: room.code,
    name: room.name,
    members: [...room.peers.values()]
      .filter(ws => ws.peerId !== excludeId)
      .map(ws => ({
        id: ws.peerId,
        name: ws.peerName,
      })),
  };
}

wss.on('connection', (ws) => {
  ws.peerId   = Math.random().toString(36).substring(2, 10);
  ws.peerName = 'Unknown';
  ws.roomCode = null;

  // Send current room list on connect
  ws.send(JSON.stringify({ type: 'room-list', rooms: getRoomList() }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── CREATE ROOM ──────────────────────────────────
      case 'create-room': {
        const code = genCode();
        const room = { code, name: msg.name || 'Room', peers: new Map() };
        rooms.set(code, room);

        ws.peerName = msg.peerName || 'User';
        ws.roomCode = code;
        room.peers.set(ws.peerId, ws);

        ws.send(JSON.stringify({ type: 'room-created', room: roomInfo(room, ws.peerId), myId: ws.peerId }));
        console.log(`Room created: ${code} "${room.name}"`);
        saveRooms();
        broadcastRoomList();
        break;
      }

      // ── JOIN ROOM ─────────────────────────────────────
      case 'join-room': {
        const code = (msg.code || '').toUpperCase();
        let room = rooms.get(code);

        // Auto-create BREAKER if it doesn't exist
        if (!room && code === 'BREAKER') {
          room = { code: 'BREAKER', name: 'BREAKER', peers: new Map() };
          rooms.set('BREAKER', room);
          console.log('BREAKER room auto-created on join');
          saveRooms();
        }

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }

        // Remove any existing ghost peer with same name
        room.peers.forEach((existingWs, existingId) => {
          if (existingWs.peerName === msg.peerName && existingId !== ws.peerId) {
            console.log(`Removing ghost peer: ${msg.peerName} (${existingId})`);
            room.peers.delete(existingId);
          }
        });

        ws.peerName = msg.peerName || 'User';
        ws.roomCode = code;
        room.peers.set(ws.peerId, ws);

        // Tell the joiner about the room and existing peers
        ws.send(JSON.stringify({
          type: 'room-joined',
          room: roomInfo(room, ws.peerId),
          myId: ws.peerId,
          existingPeers: [...room.peers.keys()].filter(id => id !== ws.peerId),
        }));

        // Tell everyone else someone joined
        broadcast(room, {
          type: 'peer-joined',
          peerId: ws.peerId,
          peerName: ws.peerName,
          room: roomInfo(room),
        }, ws.peerId); // roomInfo here is fine — excludeId not needed for broadcast

        console.log(`${ws.peerName} joined: ${code}`);
        break;
      }

      // ── WEBRTC SIGNALING ─────────────────────────────
      // offer, answer, ice-candidate are forwarded to the target peer
      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        console.log(`SIGNAL RECEIVED: ${msg.type} from ${ws.peerId?.substring(0,4)} roomCode=${ws.roomCode}`);
        const room = rooms.get(ws.roomCode);
        if (!room) {
          console.log(`RELAY FAIL: ${msg.type} from ${ws.peerId} - no room (roomCode=${ws.roomCode})`);
          return;
        }
        const target = room.peers.get(msg.targetId);
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({
            ...msg,
            fromId: ws.peerId,
            fromName: ws.peerName,
          }));
          console.log(`RELAY OK: ${msg.type} from ${ws.peerId.substring(0,4)} to ${msg.targetId.substring(0,4)}`);
        } else {
          console.log(`RELAY FAIL: ${msg.type} target ${msg.targetId} not found or not open`);
        }
        break;
      }

      // ── PTT STATE ────────────────────────────────────
      case 'ptt-start':
      case 'ptt-stop': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        broadcast(room, {
          type: msg.type,
          peerId: ws.peerId,
          peerName: ws.peerName,
        }, ws.peerId);
        break;
      }

      // ── LEAVE ROOM ───────────────────────────────────
      case 'leave-room': {
        leaveRoom(ws);
        break;
      }
    }
  });

  ws.on('close', () => leaveRoom(ws, false)); // grace period
  ws.on('error', () => leaveRoom(ws));
});

function leaveRoom(ws, immediate = false) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;

  if (!immediate) {
    // Grace period — wait 8 seconds before removing, in case they reconnect
    const peerId = ws.peerId;
    const roomCode = ws.roomCode;
    const peerName = ws.peerName;
    console.log(`${peerName} disconnected — waiting 8s for reconnect...`);

    const timer = setTimeout(() => {
      // Check if they reconnected with same name
      const currentRoom = rooms.get(roomCode);
      if (!currentRoom) return;
      let reconnected = false;
      currentRoom.peers.forEach((peerWs) => {
        if (peerWs.peerName === peerName && peerWs.peerId !== peerId && peerWs.readyState === 1) {
          reconnected = true;
        }
      });
      if (reconnected) {
        console.log(`${peerName} reconnected — keeping in room`);
        return;
      }
      // Remove them for real
      currentRoom.peers.delete(peerId);
      console.log(`${peerName} removed after grace period`);
      if (currentRoom.peers.size === 0 && currentRoom.code !== 'BREAKER') {
        rooms.delete(roomCode);
        saveRooms();
        broadcastRoomList();
      } else {
        broadcast(currentRoom, {
          type: 'peer-left',
          peerId,
          peerName,
          room: roomInfo(currentRoom),
        });
      }
      disconnectTimers.delete(peerId);
    }, 8000);

    disconnectTimers.set(peerId, timer);
    ws.roomCode = null;
    return;
  }

  // Immediate leave (explicit leave-room message)
  if (disconnectTimers.has(ws.peerId)) {
    clearTimeout(disconnectTimers.get(ws.peerId));
    disconnectTimers.delete(ws.peerId);
  }
  room.peers.delete(ws.peerId);
  ws.roomCode = null;

  if (room.peers.size === 0 && room.code !== 'BREAKER') {
    rooms.delete(room.code);
    saveRooms();
    broadcastRoomList();
  } else {
    broadcast(room, {
      type: 'peer-left',
      peerId: ws.peerId,
      peerName: ws.peerName,
      room: roomInfo(room),
    });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BREAKER signaling server on port ${PORT}`);
  console.log(`Serving files from: ${__dirname}`);
  console.log(`cwd: ${process.cwd()}`);
});

wss.on('error', (err) => console.error('WSS error:', err));
process.on('uncaughtException', (err) => console.error('Uncaught:', err));

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

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

// Static file base — always use /app on Railway, fallback to __dirname
const BASE = fs.existsSync('/app/index.html') ? '/app'
           : fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname
           : process.cwd();

console.log(`Serving static files from: ${BASE}`);

// HTTP server — serves static files
const server = http.createServer((req, res) => {
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
        const room = rooms.get(code);

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }

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
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const target = room.peers.get(msg.targetId);
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({
            ...msg,
            fromId: ws.peerId,
            fromName: ws.peerName,
          }));
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

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

function leaveRoom(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;

  room.peers.delete(ws.peerId);
  ws.roomCode = null;

  if (room.peers.size === 0) {
    rooms.delete(room.code);
    console.log(`Room deleted: ${room.code}`);
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

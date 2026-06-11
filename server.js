const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

// ── R2 CONFIG ──
const R2_ACCOUNT_ID = 'a4e243405b2594de2724c549fb0f8ebc';
const R2_ACCESS_KEY = 'a9aad766f322c9a4f41a6e9b551a6444';
const R2_SECRET_KEY = '9e06dd1bdc3c2e72907b2a7f267075202';
const R2_BUCKET     = 'beakermessages';
const R2_ENDPOINT   = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const s3Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
});

const recentMessages = []; 
const MAX_MESSAGES = 10;

const PORT = process.env.PORT || 3000;
const ROOMS_FILE = path.join(process.cwd(), 'rooms.json');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.css': 'text/css' };

function findBase() {
  const candidates = ['/app', path.join(__dirname), path.join(process.cwd()), path.join(__dirname, '..'), path.join(process.cwd(), '..')];
  for (const dir of candidates) if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  return process.cwd(); 
}
const BASE = findBase();

async function handleAudioProxy(req, res) {
  const filename = req.url.replace('/audio/', '').split('?')[0];
  try {
    const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: filename });
    const response = await s3Client.send(command);
    res.writeHead(200, {
      'Content-Type': response.ContentType || 'audio/webm',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    });
    response.Body.pipe(res);
  } catch (e) {
    console.error('[CRASH] R2 Proxy Download Error:', e.message);
    res.writeHead(500); res.end('Error fetching audio');
  }
}

async function handleUpload(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const name = url.searchParams.get('name') || 'Unknown';
      const duration = parseInt(url.searchParams.get('duration') || '0');
      const room = url.searchParams.get('room') || 'BREAKER';
      const filename = `${Date.now()}-${Math.random().toString(36).substring(2,8)}.webm`;
      
      const command = new PutObjectCommand({
        Bucket: R2_BUCKET, Key: filename, Body: body, ContentType: 'audio/webm'
      });
      await s3Client.send(command);
      
      const audioUrl = `/audio/${filename}`;
      const msg = { id: filename, url: audioUrl, name, duration, ts: Date.now() };
      recentMessages.unshift(msg);
      if (recentMessages.length > MAX_MESSAGES) recentMessages.pop();
      
      const roomObj = rooms.get(room.toUpperCase());
      if (roomObj) broadcast(roomObj, { type: 'new-message', message: msg });
      
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, url: audioUrl }));
    } catch(e) {
      console.error('[CRASH] Official SDK R2 Upload Error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

function handleMessages(res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(recentMessages));
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/upload')) return handleUpload(req, res);
  if (req.method === 'GET' && req.url.startsWith('/messages')) return handleMessages(res);
  if (req.method === 'GET' && req.url.startsWith('/audio/')) return handleAudioProxy(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  const urlPath = req.url.split('?')[0];
  const fileName = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const filePath = path.join(BASE, fileName);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(BASE, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const disconnectTimers = new Map();

function saveRooms() {
  try {
    const data = {};
    rooms.forEach((room, code) => { data[code] = { code: room.code, name: room.name }; });
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(data, null, 2));
  } catch(e) {}
}

function loadRooms() {
  try {
    if (!fs.existsSync(ROOMS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    Object.values(data).forEach(r => { rooms.set(r.code, { code: r.code, name: r.name, peers: new Map() }); });
  } catch(e) {}
}

loadRooms();
if (!rooms.has('BREAKER')) {
  rooms.set('BREAKER', { code: 'BREAKER', name: 'BREAKER', peers: new Map() });
  saveRooms();
}

function getRoomList() { return [...rooms.values()].map(r => ({ code: r.code, name: r.name, memberCount: r.peers.size })); }

function broadcastRoomList() {
  const list = JSON.stringify({ type: 'room-list', rooms: getRoomList() });
  wss.clients.forEach(c => { if (c.readyState === 1 && !c.roomCode) c.send(list); });
}

function broadcast(room, message, excludeId = null) {
  room.peers.forEach((ws, peerId) => { if (peerId !== excludeId && ws.readyState === 1) ws.send(JSON.stringify(message)); });
}

function roomInfo(room, excludeId = null) {
  return { code: room.code, name: room.name, members: [...room.peers.values()].filter(ws => ws.peerId !== excludeId).map(ws => ({ id: ws.peerId, name: ws.peerName })) };
}

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.peerId = Math.random().toString(36).substring(2, 10);
  ws.peerName = 'Unknown';
  ws.roomCode = null;
  ws.send(JSON.stringify({ type: 'room-list', rooms: getRoomList() }));

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'create-room': {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = { code, name: msg.name || 'Room', peers: new Map() };
        rooms.set(code, room);
        ws.peerName = msg.peerName || 'User'; ws.roomCode = code; room.peers.set(ws.peerId, ws);
        ws.send(JSON.stringify({ type: 'room-created', room: roomInfo(room, ws.peerId), myId: ws.peerId }));
        saveRooms(); broadcastRoomList();
        break;
      }
      case 'join-room': {
        const code = (msg.code || '').toUpperCase();
        let room = rooms.get(code);
        if (!room && code === 'BREAKER') { room = { code: 'BREAKER', name: 'BREAKER', peers: new Map() }; rooms.set('BREAKER', room); saveRooms(); }
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
        let replacedId = null;
        room.peers.forEach((existingWs, existingId) => {
          if (existingWs.peerName === msg.peerName && existingId !== ws.peerId) { replacedId = existingId; room.peers.delete(existingId); }
        });
        ws.peerName = msg.peerName || 'User'; ws.roomCode = code; room.peers.set(ws.peerId, ws);
        ws.send(JSON.stringify({ type: 'room-joined', room: roomInfo(room, ws.peerId), myId: ws.peerId, existingPeers: [...room.peers.keys()].filter(id => id !== ws.peerId) }));
        broadcast(room, { type: 'peer-joined', peerId: ws.peerId, peerName: ws.peerName, replacedId, room: roomInfo(room) }, ws.peerId);
        console.log(`${ws.peerName} joined: ${code}`);
        break;
      }
      case 'offer': case 'answer': case 'ice-candidate': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const target = room.peers.get(msg.targetId);
        if (target && target.readyState === 1) target.send(JSON.stringify({ ...msg, fromId: ws.peerId, fromName: ws.peerName }));
        break;
      }
      case 'ptt-start': case 'ptt-stop': {
        const room = rooms.get(ws.roomCode);
        if (room) broadcast(room, { type: msg.type, peerId: ws.peerId, peerName: ws.peerName }, ws.peerId);
        break;
      }
      case 'leave-room': leaveRoom(ws); break;
    }
  });

  ws.on('close', () => leaveRoom(ws, false));
  ws.on('error', () => leaveRoom(ws));
});

function leaveRoom(ws, immediate = false) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  if (!immediate) {
    const peerId = ws.peerId; const roomCode = ws.roomCode; const peerName = ws.peerName;
    const timer = setTimeout(() => {
      const currentRoom = rooms.get(roomCode);
      if (!currentRoom) return;
      let reconnected = false;
      currentRoom.peers.forEach((peerWs) => { if (peerWs.peerName === peerName && peerWs.peerId !== peerId && peerWs.readyState === 1) reconnected = true; });
      if (reconnected) return;
      currentRoom.peers.delete(peerId);
      if (currentRoom.peers.size === 0 && currentRoom.code !== 'BREAKER') { rooms.delete(roomCode); saveRooms(); broadcastRoomList(); }
      else broadcast(currentRoom, { type: 'peer-left', peerId, peerName, room: roomInfo(currentRoom) });
      disconnectTimers.delete(peerId);
    }, 8000);
    disconnectTimers.set(peerId, timer);
    ws.roomCode = null;
    return;
  }
  if (disconnectTimers.has(ws.peerId)) { clearTimeout(disconnectTimers.get(ws.peerId)); disconnectTimers.delete(ws.peerId); }
  room.peers.delete(ws.peerId); ws.roomCode = null;
  if (room.peers.size === 0 && room.code !== 'BREAKER') { rooms.delete(room.code); saveRooms(); broadcastRoomList(); }
  else broadcast(room, { type: 'peer-left', peerId: ws.peerId, peerName: ws.peerName, room: roomInfo(room) });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] BREAKER server is live on port ${PORT}`);
  console.log(`Serving files from: ${BASE}`);
});
process.on('uncaughtException', (err) => console.error('[CRASH] Uncaught Exception:', err));
wss.on('error', (err) => console.error('[CRASH] WebSocket Error:', err));

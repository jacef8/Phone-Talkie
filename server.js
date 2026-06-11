const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const https  = require('https');

// ── R2 CONFIG ──
const R2_ACCOUNT_ID = 'a4e243405b2594de2724c549fb0f8ebc';
const R2_ACCESS_KEY = 'a9aad766f322c9a4f41a6e9b551a6444';
const R2_SECRET_KEY = '9e06dd1bdc3c2e72907b2a7f267075202';
const R2_BUCKET     = 'beakermessages';
const R2_ENDPOINT   = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const recentMessages = []; 
const MAX_MESSAGES = 10;

function hmac(key, str) { return crypto.createHmac('sha256', key).update(str).digest(); }
function hmacHex(key, str) { return crypto.createHmac('sha256', key).update(str).digest('hex'); }

async function uploadToR2(buffer, filename, contentType) {
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
  const canonicalRequest = ['PUT', urlPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStr}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + R2_SECRET_KEY, dateStr), region), service), 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: urlPath, method: 'PUT', headers: { ...headers, 'authorization': authorization } }, res => {
      if (res.statusCode === 200) resolve(`${R2_ENDPOINT}/${R2_BUCKET}/${filename}`);
      else { let body = ''; res.on('data', d => body += d); res.on('end', () => reject(new Error(`R2 upload failed: ${res.statusCode} ${body}`))); }
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

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
  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStr = amzDate.substring(0, 8);
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const urlPath = `/${R2_BUCKET}/${filename}`;
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  
  const headers = { 'host': host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}`).join('\n') + '\n';
  const canonicalRequest = ['GET', urlPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStr}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + R2_SECRET_KEY, dateStr), 'auto'), 's3'), 'aws4_request');
  const signature = hmacHex(signingKey, stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const proxyReq = https.request({ hostname: host, path: urlPath, method: 'GET', headers: { ...headers, 'authorization': authorization } }, (r2res) => {
    res.writeHead(r2res.statusCode, { 'Content-Type': 'audio/webm', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' });
    r2res.pipe(res);
  });
  proxyReq.on('error', (e) => { res.writeHead(500); res.end('Error: ' + e.message); });
  proxyReq.end();
}

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
      
      await uploadToR2(body, filename, 'audio/webm');
      const audioUrl = `/audio/${filename}`;
      
      const msg = { id: filename, url: audioUrl, name, duration, ts: Date.now() };
      recentMessages.unshift(msg);
      if (recentMessages.length > MAX_MESSAGES) recentMessages.pop();
      
      const roomObj = rooms.get(room.toUpperCase());
      if (roomObj) broadcast(roomObj, { type: 'new-message', message: msg });
      
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, url: audioUrl }));
    } catch(e) {
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
  if (req.method === 'OPTIONS') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }

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

// Ping/Pong to kill dead connections and stop ghosts
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
        const code = Math.random().toString(36).substring(2, 8).toUpperCase

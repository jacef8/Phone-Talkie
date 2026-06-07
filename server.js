const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// HTTP server — serves a health check for Railway
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BREAKER signaling server running');
});

const wss = new WebSocketServer({ server });

// rooms: { roomCode: { id, name, peers: Map<peerId, ws> } }
const rooms = new Map();

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcast(room, message, excludeId = null) {
  room.peers.forEach((ws, peerId) => {
    if (peerId !== excludeId && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  });
}

function roomInfo(room) {
  return {
    code: room.code,
    name: room.name,
    members: [...room.peers.values()].map(ws => ({
      id: ws.peerId,
      name: ws.peerName,
    })),
  };
}

wss.on('connection', (ws) => {
  ws.peerId   = Math.random().toString(36).substring(2, 10);
  ws.peerName = 'Unknown';
  ws.roomCode = null;

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

        ws.send(JSON.stringify({ type: 'room-created', room: roomInfo(room) }));
        console.log(`Room created: ${code} "${room.name}"`);
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
          room: roomInfo(room),
          myId: ws.peerId,
          existingPeers: [...room.peers.keys()].filter(id => id !== ws.peerId),
        }));

        // Tell everyone else someone joined
        broadcast(room, {
          type: 'peer-joined',
          peerId: ws.peerId,
          peerName: ws.peerName,
          room: roomInfo(room),
        }, ws.peerId);

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
  } else {
    broadcast(room, {
      type: 'peer-left',
      peerId: ws.peerId,
      peerName: ws.peerName,
      room: roomInfo(room),
    });
  }
}

server.listen(PORT, () => {
  console.log(`BREAKER signaling server on port ${PORT}`);
});

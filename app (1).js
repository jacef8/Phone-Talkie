// ─────────────────────────────────────────
//  BREAKER — app.js
//  WebRTC + WebSocket signaling client
// ─────────────────────────────────────────

// ── CONFIG ──────────────────────────────
// Replace this with your Railway server URL after deploying
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'ws://localhost:3000'
  : 'wss://phone-talkie-production.up.railway.app';
// Force WSS on Railway
const WS_URL = SERVER_URL;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ── STATE ────────────────────────────────
let ws          = null;
let myId        = null;
let myName      = 'User';
let currentRoom = null;
let transmitting = false;
let muted       = false;
let rxTimer     = null;
let playTimer   = null;
let playingEl   = null;

// WebRTC: one RTCPeerConnection per remote peer
const peers     = new Map(); // peerId → RTCPeerConnection
const streams   = new Map(); // peerId → MediaStream

// Local mic stream
let localStream = null;

// ── WEBSOCKET ────────────────────────────
function connectWS() {
  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    console.log('WS connected');
    updateConnectionStatus(true);
    // Auto-join if user arrived via share link
    if (window._pendingRoomCode) {
      const code = window._pendingRoomCode;
      window._pendingRoomCode = null;
      const name = document.getElementById('name-input').value.trim() || '';
      if (!name) {
        // Prompt for name first
        document.getElementById('join-code-input').value = code;
        document.getElementById('name-input').focus();
        showToast('Enter your name then tap JOIN');
      } else {
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          .then(() => send({ type: 'join-room', code, peerName: name }))
          .catch(() => showToast('Microphone permission required'));
      }
    }
  };

  ws.onclose = () => {
    console.log('WS disconnected — retrying in 3s');
    updateConnectionStatus(false);
    setTimeout(connectWS, 3000);
  };

  ws.onerror = (e) => console.error('WS error', e);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleSignal(msg);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── SIGNALING HANDLER ────────────────────
async function handleSignal(msg) {
  switch (msg.type) {

    case 'room-created':
      myId = msg.myId || myId;
      currentRoom = msg.room;
      renderRoom(msg.room);
      showScreen('screen-room');
      break;

    case 'room-joined':
      myId = msg.myId || myId;
      currentRoom = msg.room;
      renderRoom(msg.room);
      showScreen('screen-room');
      // Initiate connections to all existing peers
      if (msg.existingPeers) {
        for (const peerId of msg.existingPeers) {
          await createOffer(peerId);
        }
      }
      break;

    case 'peer-joined':
      currentRoom = msg.room;
      updateMembers(msg.room);
      addFeedItem(msg.peerName, 'join');
      break;

    case 'peer-left':
      currentRoom = msg.room;
      updateMembers(msg.room);
      addFeedItem(msg.peerName, 'leave');
      closePeer(msg.peerId);
      break;

    case 'offer':
      await handleOffer(msg);
      break;

    case 'answer':
      await handleAnswer(msg);
      break;

    case 'ice-candidate':
      await handleIceCandidate(msg);
      break;

    case 'ptt-start':
      showSpeaking(msg.peerName, true);
      break;

    case 'ptt-stop':
      showSpeaking(msg.peerName, false);
      addFeedItem(msg.peerName, 'speak');
      break;

    case 'error':
      alert(msg.message);
      break;
  }
}

// ── WEBRTC ───────────────────────────────
async function getMic() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false
  });
  // Disable tracks immediately — only enable when PTT held
  // This prevents Android from showing the "active call" indicator
  localStream.getAudioTracks().forEach(t => {
    t.enabled = false;
  });
  return localStream;
}

function releaseMic() {
  if (!localStream) return;
  localStream.getTracks().forEach(t => t.stop());
  localStream = null;
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      send({ type: 'ice-candidate', targetId: peerId, candidate });
    }
  };

  pc.ontrack = ({ streams: [stream] }) => {
    streams.set(peerId, stream);
    playRemoteStream(stream);
  };

  pc.onconnectionstatechange = () => {
    console.log(`Peer ${peerId}: ${pc.connectionState}`);
  };

  // Add local mic track
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  peers.set(peerId, pc);
  return pc;
}

async function createOffer(peerId) {
  await getMic();
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', targetId: peerId, sdp: pc.localDescription });
}

async function handleOffer(msg) {
  await getMic();
  const pc = createPeerConnection(msg.fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'answer', targetId: msg.fromId, sdp: pc.localDescription });
}

async function handleAnswer(msg) {
  const pc = peers.get(msg.fromId);
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
}

async function handleIceCandidate(msg) {
  const pc = peers.get(msg.fromId);
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
}

function closePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) { pc.close(); peers.delete(peerId); }
  streams.delete(peerId);
}

function playRemoteStream(stream) {
  const audio = new Audio();
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.play().catch(console.error);
}

// ── PTT ─────────────────────────────────
function startTx(e) {
  if (e) e.preventDefault();
  if (muted || !currentRoom) return;
  transmitting = true;

  // Enable mic
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = true);
  }

  send({ type: 'ptt-start' });

  document.getElementById('ptt-btn').classList.add('tx');
  document.getElementById('ptt-outer').classList.add('tx');
  document.getElementById('ptt-hint').textContent = '● TRANSMITTING';
  document.getElementById('ptt-hint').className = 'ptt-hint tx';
  setWave('tx');
  document.getElementById('wave-status').textContent = 'TX';
  document.getElementById('wave-status').className = 'wave-status tx';
}

function stopTx() {
  if (!transmitting) return;
  transmitting = false;

  // Mute mic again
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = false);
  }

  send({ type: 'ptt-stop' });

  document.getElementById('ptt-btn').classList.remove('tx');
  document.getElementById('ptt-outer').classList.remove('tx');
  document.getElementById('ptt-hint').textContent = 'Everyone in the room will hear you';
  document.getElementById('ptt-hint').className = 'ptt-hint';
  setWave(null);
}

// ── ROOM ACTIONS ─────────────────────────
async function createRoom() {
  const name = document.getElementById('create-name-input').value.trim();
  if (!name) { showToast('Enter a room name'); return; }
  myName = document.getElementById('name-input').value.trim() || 'User';
  await getMic();
  send({ type: 'create-room', name, peerName: myName });
  document.getElementById('create-name-input').value = '';
}

async function joinByCode() {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (!code) { showToast('Enter a room code'); return; }
  myName = document.getElementById('name-input').value.trim() || 'User';
  await getMic();
  send({ type: 'join-room', code, peerName: myName });
  document.getElementById('join-code-input').value = '';
}

function leaveRoom() {
  send({ type: 'leave-room' });
  peers.forEach((pc, id) => closePeer(id));
  currentRoom = null;
  releaseMic();
  setWave(null);
  showScreen('screen-rooms');
}

function copyInviteLink() {
  if (!currentRoom) return;
  const link = `${window.location.origin}?room=${currentRoom.code}`;
  navigator.clipboard?.writeText(link).then(() => {
    const btn = document.getElementById('share-btn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg class="share-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> LINK COPIED!';
    setTimeout(() => { btn.innerHTML = orig; }, 2200);
  });
}

// ── UI HELPERS ───────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function renderRoom(room) {
  document.getElementById('room-title').textContent = room.name.toUpperCase();
  updateMembers(room);
  document.getElementById('history-list').innerHTML = '';
  document.getElementById('hist-count').textContent = '0 / 10';
}

function updateMembers(room) {
  const selfLetter = (document.getElementById('name-input').value.trim()[0] || 'J').toUpperCase();
  const allMembers = [{ name: myName, initial: selfLetter }, ...room.members.filter(m => m.id !== myId)];
  const container  = document.getElementById('room-avatars');
  container.innerHTML = allMembers.slice(0, 6).map(m =>
    `<div class="avatar">${(m.name[0] || '?').toUpperCase()}</div>`
  ).join('');
  document.getElementById('room-member-count').textContent = allMembers.length;
}

function showSpeaking(name, active) {
  const statusEl = document.getElementById('wave-status');
  if (active) {
    setWave('rx');
    statusEl.textContent = name.toUpperCase();
    statusEl.className   = 'wave-status rx';
  } else {
    setWave(null);
  }
}

function setWave(mode) {
  document.querySelectorAll('.wbar').forEach(b => {
    b.classList.remove('tx', 'rx');
    if (mode) b.classList.add(mode);
  });
  if (!mode) {
    document.getElementById('wave-status').textContent = 'IDLE';
    document.getElementById('wave-status').className   = 'wave-status';
  }
}

function addFeedItem(name, type) {
  const list   = document.getElementById('history-list');
  const count  = document.getElementById('hist-count');
  const labels = { speak: 'spoke', join: 'joined', leave: 'left' };

  // Record message for replay (speak only)
  if (type === 'speak') {
    const item    = document.createElement('div');
    item.className = 'msg-item';
    const dur     = Math.floor(Math.random() * 6) + 2; // placeholder until real duration tracking
    const bars    = Array.from({ length: 18 }, () => {
      const h = Math.floor(Math.random() * 11) + 3;
      return `<div class="mwbar" style="height:${h}px"></div>`;
    }).join('');
    item.dataset.dur = dur;
    item.innerHTML = `
      <div class="msg-avatar">${name[0].toUpperCase()}</div>
      <div class="msg-body">
        <span class="msg-name">${name}</span>
        <div class="msg-meta" style="display:flex;align-items:center;gap:6px;">
          <div class="msg-wave">${bars}</div>
          <span>${dur}s</span>
        </div>
      </div>
      <div class="msg-right">
        <span class="msg-time">just now</span>
        <div class="play-icon">
          <svg viewBox="0 0 10 10"><path d="M2 1.5l6 3.5-6 3.5z"/></svg>
        </div>
      </div>
    `;
    item.addEventListener('click', () => playMessage(name, dur, item));
    list.appendChild(item);

    // Keep max 10
    const items = list.querySelectorAll('.msg-item');
    if (items.length > 10) items[0].remove();
    count.textContent = `${list.querySelectorAll('.msg-item').length} / 10`;
    list.scrollTop = list.scrollHeight;
  }
}

function playMessage(name, dur, el) {
  if (transmitting) return;
  if (playingEl) {
    playingEl.classList.remove('playing');
    clearTimeout(playTimer);
    if (playingEl === el) { playingEl = null; setWave(null); return; }
  }
  playingEl = el;
  el.classList.add('playing');
  setWave('rx');
  document.getElementById('wave-status').textContent = name.toUpperCase();
  document.getElementById('wave-status').className   = 'wave-status rx';
  playTimer = setTimeout(() => {
    el.classList.remove('playing');
    playingEl = null;
    setWave(null);
  }, dur * 1000);
}

function updateConnectionStatus(connected) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  if (dot && lbl) {
    dot.style.background = connected ? '#39ff8a' : '#ff4545';
    lbl.textContent      = connected ? 'LIVE' : 'RECONNECTING';
  }
}

// ── NAME SYNC ────────────────────────────
document.getElementById('name-input').addEventListener('input', () => {
  const l = (document.getElementById('name-input').value.trim()[0] || 'J').toUpperCase();
  document.getElementById('self-av').textContent   = l;
  document.getElementById('av-self').textContent   = l;
});

// ── DEEP LINK ────────────────────────────
(function () {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('room');
  if (!code) return;
  window.history.replaceState({}, '', '/');
  // Store code and auto-join once WS connects
  window._pendingRoomCode = code.toUpperCase();
  document.getElementById('join-code-input').value = code.toUpperCase();
})();

// ── TOAST ────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ── PWA SERVICE WORKER ───────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}

// ── INIT ─────────────────────────────────
connectWS();

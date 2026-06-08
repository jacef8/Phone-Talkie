// ─────────────────────────────────────────
//  BREAKER — app.js
//  WebRTC + WebSocket signaling client
// ─────────────────────────────────────────

// ── CONFIG ──────────────────────────────
// Replace this with your Railway server URL after deploying
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'ws://localhost:3000'
  : 'wss://phone-talkie-production.up.railway.app';

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
const peers       = new Map(); // peerId → RTCPeerConnection
const streams     = new Map(); // peerId → MediaStream
const audioElements = new Map(); // peerId → HTMLAudioElement

// Local mic stream
let localStream = null;

// ── WEBSOCKET ────────────────────────────
let reconnectDelay = 2000;

function connectWS() {
  updateConnectionLabel('CONNECTING...');
  try {
    ws = new WebSocket(SERVER_URL);
  } catch(e) {
    console.error('WS creation failed', e);
    setTimeout(connectWS, reconnectDelay);
    return;
  }

  // Timeout if no connection after 10s
  const timeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.close();
      updateConnectionLabel('RETRYING...');
    }
  }, 10000);

  ws.onopen = () => {
    clearTimeout(timeout);
    const isReconnect = window._wasConnected || false;
    window._wasConnected = true;
    reconnectDelay = 2000;
    console.log('WS connected, reconnect:', isReconnect);
    updateConnectionStatus(true);

    // Only auto-rejoin on reconnect (not first load) and only if we were in a room
    if (isReconnect && window._wasInRoom && !currentRoom) {
      const savedName = localStorage.getItem('breaker-name');
      if (savedName) {
        myName = savedName;
        getMic().then(() => {
          send({ type: 'join-room', code: 'BREAKER', peerName: savedName });
        }).catch(console.error);
      }
    }
  };

  ws.onclose = () => {
    console.log(`WS disconnected — retrying in ${reconnectDelay}ms`);
    updateConnectionStatus(false);
    setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000); // exponential backoff, max 15s
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
      saveRoomToStorage(msg.room);
      renderRoom(msg.room);
      showScreen('screen-room');
      break;

    case 'room-joined':
      myId = msg.myId || myId;
      saveRoomToStorage(msg.room);
      currentRoom = msg.room;
      window._wasInRoom = true;
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
      // Start recording incoming stream for replay
      if (streams.has(msg.fromId)) {
        const recStream = streams.get(msg.fromId);
        const rec = recordStream(recStream, (blob) => {
          if (blob) window._lastRecordingBlob = blob;
        });
        window._activeRecording = {
          peerId: msg.fromId,
          startTime: Date.now(),
          recorder: rec,
        };
      }
      break;

    case 'ptt-stop':
      showSpeaking(msg.peerName, false);
      // Stop recorder if active
      if (window._activeRecording?.recorder) {
        try { window._activeRecording.recorder.stop(); } catch(e) {}
      }
      // Small delay to let onstop fire before addFeedItem
      setTimeout(() => {
        addFeedItem(msg.peerName, 'speak', msg.fromId, window._lastRecordingBlob);
        window._lastRecordingBlob = null;
        window._activeRecording = null;
      }, 300);
      break;

    case 'room-list':
      renderServerRooms(msg.rooms);
      break;

    case 'error':
      if (msg.message === 'Room not found') {
        // BREAKER room should always exist — server may be restarting, retry
        console.log('Room not found, retrying in 2s...');
        setTimeout(() => {
          const name = document.getElementById('name-input').value.trim() || myName;
          if (name && ws?.readyState === WebSocket.OPEN) {
            send({ type: 'join-room', code: 'BREAKER', peerName: name });
          }
        }, 2000);
      } else {
        showToast(msg.message);
      }
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
  console.log('Releasing mic...');
  localStream.getTracks().forEach(t => {
    t.enabled = false;
    t.stop(); // This is what actually releases the OS-level mic indicator
  });
  localStream = null;
  // Also close all peer connections to fully release audio pipeline
  peers.forEach((pc, id) => {
    try { pc.close(); } catch(e) {}
  });
  peers.clear();
  streams.clear();
  audioElements.forEach(audio => {
    audio.srcObject = null;
    audio.remove();
  });
  audioElements.clear();
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
    playRemoteStream(stream, peerId);
  };

  pc.onconnectionstatechange = () => {
    console.log(`Peer ${peerId}: ${pc.connectionState}`);
  };

  // Add local mic track if available (may not be yet — added on first PTT)
  if (localStream) {
    localStream.getTracks().forEach(track => {
      try { pc.addTrack(track, localStream); } catch(e) {}
    });
  }

  peers.set(peerId, pc);
  return pc;
}

async function createOffer(peerId) {
  // Don't require mic for signaling — add track only if mic available
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', targetId: peerId, sdp: pc.localDescription });
}

async function handleOffer(msg) {
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
  // Remove and clean up audio element
  if (audioElements.has(peerId)) {
    const audio = audioElements.get(peerId);
    audio.srcObject = null;
    audio.remove();
    audioElements.delete(peerId);
  }
}

function playRemoteStream(stream, peerId) {
  // Remove any existing audio element for this peer
  if (audioElements.has(peerId)) {
    const old = audioElements.get(peerId);
    old.srcObject = null;
    old.remove();
    audioElements.delete(peerId);
  }

  const audio = document.createElement('audio');
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  audio.setAttribute('webkit-playsinline', '');
  audio.volume = 1.0;
  audio.muted = false;
  // Must be in DOM to survive garbage collection
  audio.style.display = 'none';
  document.body.appendChild(audio);

  if (peerId) audioElements.set(peerId, audio);

  // Some browsers need an explicit play() call
  const playPromise = audio.play();
  if (playPromise) {
    playPromise.catch(e => {
      console.error('Audio play failed:', e);
      // Retry on next user interaction
      document.addEventListener('click', () => audio.play().catch(console.error), { once: true });
      document.addEventListener('touchstart', () => audio.play().catch(console.error), { once: true });
    });
  }
}

// Record a stream and store blob against a message element
// Record a MediaStream for a given duration
function recordStream(stream, onStop) {
  if (!stream || !window.MediaRecorder) return null;
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch(e) { console.error("MediaRecorder failed:", e); return null; }
  rec.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  rec.onstop = () => {
    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      onStop(blob);
    } else {
      onStop(null);
    }
  };
  try { rec.start(100); } catch(e) { return null; } // collect every 100ms
  return rec;
}

// ── PTT ─────────────────────────────────
function startTx(e) {
  if (e) e.preventDefault();
  if (!currentRoom) return;

  // Get mic on first press if not already acquired
  if (!localStream) {
    getMic().then(() => {
      // Re-add tracks to all peer connections
      peers.forEach((pc) => {
        if (localStream) {
          localStream.getTracks().forEach(track => {
            try { pc.addTrack(track, localStream); } catch(err) {}
          });
        }
      });
      doStartTx();
    }).catch(e => {
      console.error('Mic error:', e);
      showToast('Tap Allow when browser asks for microphone');
    });
    return;
  }
  doStartTx();
}

function doStartTx() {
  if (!currentRoom) return;
  transmitting = true;

  // Enable mic tracks
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

// ── JOIN MAIN ROOM ──────────────────────────
function joinMain() {
  const name = document.getElementById('name-input').value.trim();
  dbg('JOIN tapped. name=' + name + ' ws=' + (ws ? ws.readyState : 'null'));
  if (!name) {
    document.getElementById('name-input').focus();
    showToast('Enter your name first');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    dbg('WS not open: ' + (ws ? ws.readyState : 'no ws'));
    showToast('Not connected — state: ' + (ws ? ws.readyState : 'none'));
    return;
  }
  myName = name;
  localStorage.setItem('breaker-name', name);
  dbg('Sending join-room BREAKER');
  send({ type: 'join-room', code: 'BREAKER', peerName: name });
  dbg('Sent.');
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
  currentRoom = null;
  window._wasInRoom = false; // don't auto-rejoin after manual leave
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
  document.getElementById('room-title').textContent = 'BREAKER';
  updateMembers(room);
  document.getElementById('history-list').innerHTML = '';
  document.getElementById('hist-count').textContent = '0 / 10';
}

function updateMembers(room) {
  const selfLetter = (document.getElementById('name-input').value.trim()[0] || '?').toUpperCase();
  const allMembers = [
    { name: myName || 'You', initial: selfLetter },
    ...room.members.filter(m => m.id !== myId)
  ];
  const container = document.getElementById('room-avatars');
  container.innerHTML = '';
  allMembers.slice(0, 6).forEach(m => {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = (m.name[0] || '?').toUpperCase();
    av.title = m.name;
    av.style.cursor = 'pointer';
    // Tap to show full name
    av.addEventListener('click', () => showMemberName(m.name));
    container.appendChild(av);
  });
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

function addFeedItem(name, type, peerId, blob) {
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

    // Attach recorded blob if available
    if (blob) {
      messageAudio.set(item, blob);
    }

    // Keep max 10
    const items = list.querySelectorAll('.msg-item');
    if (items.length > 10) items[0].remove();
    count.textContent = `${list.querySelectorAll('.msg-item').length} / 10`;
    list.scrollTop = list.scrollHeight;
  }
}

// Audio recording: capture each incoming transmission
const messageAudio = new Map(); // el → Blob

function playMessage(name, dur, el) {
  if (transmitting) return;

  // Stop current playback
  if (playingEl) {
    playingEl.classList.remove("playing");
    clearTimeout(playTimer);
    if (window._currentAudio) {
      window._currentAudio.pause();
      window._currentAudio = null;
    }
    const wasEl = playingEl;
    playingEl = null;
    setWave(null);
    if (wasEl === el) return;
  }

  const blob = messageAudio.get(el);
  if (blob) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.setAttribute("playsinline", "");
    window._currentAudio = audio;
    playingEl = el;
    el.classList.add("playing");
    setWave("rx");
    document.getElementById("wave-status").textContent = name.toUpperCase();
    document.getElementById("wave-status").className = "wave-status rx";
    audio.play().catch(console.error);
    audio.onended = () => {
      el.classList.remove("playing");
      playingEl = null;
      window._currentAudio = null;
      setWave(null);
      URL.revokeObjectURL(url);
    };
  } else {
    showToast("Replay not available");
  }
}

function updateConnectionStatus(connected) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  if (dot && lbl) {
    dot.style.background = connected ? '#39ff8a' : '#ff4545';
    dot.style.boxShadow  = connected ? '0 0 6px #39ff8a' : '0 0 6px #ff4545';
    lbl.textContent      = connected ? 'LIVE' : 'RECONNECTING';
  }
}

function updateConnectionLabel(text) {
  const lbl = document.getElementById('conn-label');
  const dot = document.getElementById('conn-dot');
  if (lbl) lbl.textContent = text;
  if (dot) { dot.style.background = '#ffb830'; dot.style.boxShadow = '0 0 6px #ffb830'; }
}

// ── NAME SYNC ────────────────────────────
document.getElementById('name-input').addEventListener('input', () => {
  const val = document.getElementById('name-input').value.trim();
  const l = (val[0] || '?').toUpperCase();
  document.getElementById('self-av').textContent = l;
  document.getElementById('av-self').textContent = l;
  if (val) localStorage.setItem('breaker-name', val);
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
function showMemberName(name) {
  // Remove existing
  document.getElementById('member-popup')?.remove();
  const el = document.createElement('div');
  el.id = 'member-popup';
  el.textContent = name;
  el.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:#141816; border:2px solid #39ff8a; color:#39ff8a;
    font-family:'Bebas Neue',sans-serif; font-size:1.8rem; letter-spacing:4px;
    padding:18px 32px; border-radius:16px; z-index:999;
    box-shadow:0 0 30px rgba(57,255,138,0.2);
    pointer-events:none;
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ── DEBUG ─────────────────────────────────
function dbg(msg) {
  console.log('[DBG]', msg);
  const el = document.getElementById('debug-log');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

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

// ── SERVER ROOM LIST ────────────────────────
function renderServerRooms(rooms) {
  const container = document.getElementById('rooms-container');
  const countEl   = document.getElementById('room-count');

  // Merge server rooms with locally saved rooms
  const savedRooms = getSavedRooms();
  const allRooms = [...rooms];
  savedRooms.forEach(r => {
    if (!allRooms.find(x => x.code === r.code)) {
      allRooms.push({ ...r, memberCount: 0, offline: true });
    }
  });

  countEl.textContent = allRooms.length === 1 ? '1 room' : `${allRooms.length} rooms`;

  if (allRooms.length === 0) {
    container.innerHTML = '<div class="empty-rooms">NO ACTIVE ROOMS<br>CREATE ONE ABOVE</div>';
    return;
  }

  container.innerHTML = '';
  allRooms.forEach(room => {
    const el = document.createElement('div');
    el.className = 'room-item';
    const isOffline = room.offline || (room.memberCount === 0 && !rooms.find(r => r.code === room.code));
    el.innerHTML = `
      <div class="room-icon" style="opacity:${isOffline ? 0.5 : 1}">${room.name[0].toUpperCase()}</div>
      <div class="room-body">
        <span class="room-name">${room.name}</span>
        <span class="room-meta" style="color:${isOffline ? '#4a5a52' : ''}">
          ${isOffline ? 'SAVED — TAP TO REJOIN' : '<span class="dot">●</span>' + (room.memberCount || 0) + ' members'}
        </span>
      </div>
      <div class="code-badge">${room.code}</div>
    `;
    el.addEventListener('click', () => {
      const name = document.getElementById('name-input').value.trim();
      if (!name) { showToast('Enter your name first'); document.getElementById('name-input').focus(); return; }
      myName = name;
      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(() => send({ type: 'join-room', code: room.code, peerName: name }))
        .catch(() => showToast('Microphone permission required'));
    });
    container.appendChild(el);
  });
}

// ── JOIN MODAL (for share link flow) ────────
function showJoinModal(code) {
  // Create a simple overlay asking for name
  const overlay = document.createElement('div');
  overlay.id = 'join-modal';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:500;
    background:rgba(0,0,0,0.85);
    display:flex;align-items:center;justify-content:center;
    padding:24px;font-family:'Share Tech Mono',monospace;
  `;
  overlay.innerHTML = `
    <div style="background:#141816;border:1px solid #1a5c3a;border-radius:20px;padding:28px;width:100%;max-width:320px;display:flex;flex-direction:column;gap:16px;">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:4px;color:#39ff8a;">JOIN ROOM</div>
      <div style="font-size:0.85rem;color:#a0c0ae;line-height:1.5;">You've been invited to join a room. Enter your name to jump in.</div>
      <input id="modal-name" type="text" placeholder="Your name…" maxlength="18"
        style="background:#1a1e1c;border:1px solid #232e28;border-radius:10px;padding:13px 16px;font-size:1rem;color:#eef5f0;outline:none;font-family:'DM Sans',sans-serif;width:100%;"
      />
      <button onclick="doModalJoin('${code}')"
        style="background:#39ff8a;color:#0a0f0d;border:none;border-radius:10px;padding:14px;font-family:'Share Tech Mono',monospace;font-size:0.8rem;letter-spacing:2px;cursor:pointer;font-weight:700;">
        JOIN NOW
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('modal-name')?.focus(), 100);
}

function doModalJoin(code) {
  const nameEl = document.getElementById('modal-name');
  const name = nameEl?.value.trim() || '';
  if (!name) { nameEl?.focus(); return; }
  // Set name in main input too
  document.getElementById('name-input').value = name;
  document.getElementById('self-av').textContent = name[0].toUpperCase();
  document.getElementById('av-self').textContent = name[0].toUpperCase();
  myName = name;
  // Remove modal
  document.getElementById('join-modal')?.remove();
  // Join
  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(() => send({ type: 'join-room', code, peerName: name }))
    .catch(() => showToast('Microphone permission required'));
}

// ── ROOM STORAGE ─────────────────────────
function saveRoomToStorage(room) {
  // Save last room for auto-rejoin
  localStorage.setItem('breaker-last-room', JSON.stringify({
    code: room.code,
    name: room.name,
  }));
  // Save to room list
  const rooms = getSavedRooms();
  if (!rooms.find(r => r.code === room.code)) {
    rooms.unshift({ code: room.code, name: room.name });
    if (rooms.length > 10) rooms.pop();
    localStorage.setItem('breaker-rooms', JSON.stringify(rooms));
  }
}

function getSavedRooms() {
  try { return JSON.parse(localStorage.getItem('breaker-rooms') || '[]'); } catch { return []; }
}

function loadLastRoom() {
  try { return JSON.parse(localStorage.getItem('breaker-last-room')); } catch { return null; }
}

// ── MIC LIFECYCLE ────────────────────────
// Release mic whenever page is hidden (user switches apps)
// Re-acquire when they come back to the room
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Only release mic if not actively in a room
    if (!currentRoom && localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      console.log('Mic released — page hidden, not in room');
    }
  }
  // Don't re-acquire here — user will tap PTT which triggers getMic()
});

window.addEventListener('pagehide', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

// ── RESTORE STATE ON LOAD ─────────────────
(function restoreState() {
  // Clear any stale room data — we only use BREAKER now
  localStorage.removeItem('breaker-last-room');
  localStorage.removeItem('breaker-rooms');

  const savedName = localStorage.getItem('breaker-name');
  if (savedName) {
    document.getElementById('name-input').value = savedName;
    document.getElementById('self-av').textContent = savedName[0].toUpperCase();
    document.getElementById('av-self').textContent = savedName[0].toUpperCase();
    myName = savedName;
  }
})();

// ── INIT ─────────────────────────────────
connectWS();

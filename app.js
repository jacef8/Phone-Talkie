// ─────────────────────────────────────────
//  BREAKER — app.js (simplified)
// ─────────────────────────────────────────

const SERVER_URL = window.location.hostname === 'localhost'
  ? 'ws://localhost:3000'
  : 'wss://phone-talkie-production.up.railway.app';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:standard.relay.metered.ca:80', username: '3b799207f546e5350db66ad7', credential: 'EYXVPgix8rflMTdv' },
  { urls: 'turn:standard.relay.metered.ca:80?transport=tcp', username: '3b799207f546e5350db66ad7', credential: 'EYXVPgix8rflMTdv' },
  { urls: 'turn:standard.relay.metered.ca:443', username: '3b799207f546e5350db66ad7', credential: 'EYXVPgix8rflMTdv' },
  { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username: '3b799207f546e5350db66ad7', credential: 'EYXVPgix8rflMTdv' },
];

let ws = null;
let myId = null;
let myName = '';
let currentRoom = null;
let transmitting = false;
let localStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let pttStartTime = 0;
const peers = new Map();
const audioEls = new Map();
const iceCandidateQueue = new Map(); // peerId → [candidates]

// ── WEBSOCKET ──
let reconnectDelay = 2000;
let wasConnected = false;

function connectWS() {
  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    wasConnected = true;
    reconnectDelay = 2000;
    updateStatus(true);
    const savedName = localStorage.getItem('breaker-name');
    if (savedName) {
      myName = savedName;
      document.getElementById('name-input').value = savedName;
      document.getElementById('self-av').textContent = savedName[0].toUpperCase();
      // Clean up stale peers and auto-rejoin
      peers.forEach((_, id) => closePeer(id));
      currentRoom = null;
      send({ type: 'join-room', code: 'BREAKER', peerName: savedName });
    }
  };

  ws.onclose = () => {
    updateStatus(false);
    // Clean up all peer connections on disconnect
    peers.forEach((_, id) => closePeer(id));
    setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  };

  ws.onerror = () => {};

  ws.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    console.log('MSG:', msg.type);

    switch (msg.type) {
      case 'room-created':
      case 'room-joined':
        myId = msg.myId || myId;
        currentRoom = msg.room;
        window._wasInRoom = true;
        renderRoom(msg.room);
        showScreen('screen-room');
        loadMessages();
        showStatus('Joined room, waiting for peers to connect...');
        // Do NOT call createOffer here — existing peers will offer to us via peer-joined
        break;

      case 'peer-joined':
        currentRoom = msg.room;
        updateMembers(msg.room);
        showToast(msg.peerName + ' joined');
        showStatus('New peer joined, creating offer...');
        await createOffer(msg.peerId);
        break;

      case 'peer-left':
        currentRoom = msg.room;
        updateMembers(msg.room);
        showToast(msg.peerName + ' left');
        closePeer(msg.peerId);
        break;

      case 'offer':
        await handleOffer(msg);
        break;

      case 'answer':
        await handleAnswer(msg);
        break;

      case 'ice-candidate':
        await handleIce(msg);
        break;

      case 'ptt-start':
        showSpeaking(msg.peerName, true);
        sendNotification('📻 BREAKER', msg.peerName + ' is talking...');
        break;

      case 'new-message':
        addMessage(msg.message);
        break;

      case 'ptt-stop':
        showSpeaking(msg.peerName, false);
        break;

      case 'room-list':
        // single room app, ignore
        break;

      case 'error':
        if (msg.message === 'Room not found') {
          setTimeout(() => {
            const n = localStorage.getItem('breaker-name');
            if (n && ws?.readyState === WebSocket.OPEN)
              send({ type: 'join-room', code: 'BREAKER', peerName: n });
          }, 1000);
        }
        break;
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── WEBRTC ──
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
  return localStream;
}

function makePeer(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      showStatus('ICE cand: ' + (candidate.type || 'host'));
      send({ type: 'ice-candidate', targetId: peerId, candidate });
    } else {
      showStatus('ICE gathering done');
    }
  };

  pc.ontrack = ({ streams: [stream] }) => {
    console.log('GOT TRACK from', peerId);
    showStatus('Got audio from ' + peerId.substring(0,4));
    let audio = audioEls.get(peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      // Prevent browser from treating this as a phone call
      audio.setAttribute('playsinline', '');
      audio.setAttribute('webkit-playsinline', '');
      audio.volume = 1.0;
      document.body.appendChild(audio);
      audioEls.set(peerId, audio);
    }
    audio.srcObject = stream;
    audio.play().catch(console.error);
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log('peer', peerId, state);
    showStatus('Peer: ' + state + ' | ICE: ' + pc.iceConnectionState);
  };
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('ICE', peerId, s);
    showStatus('ICE: ' + s);
    if (s === 'failed' || s === 'disconnected') {
      showStatus('ICE ' + s + ' - restarting...');
      // Try ICE restart first
      pc.restartIce();
      // If still failing after 5s, close and let reconnect handle it
      setTimeout(() => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          closePeer(peerId);
        }
      }, 5000);
    }
  };
  pc.onicegatheringstatechange = () => {
    showStatus('Gathering: ' + pc.iceGatheringState);
  };

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  peers.set(peerId, pc);
  return pc;
}

async function createOffer(peerId) {
  // Don't request mic here — only on PTT press
  // Create offer without audio tracks; they'll be added on first PTT
  const pc = makePeer(peerId);
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  showStatus('Offer sent to ' + peerId.substring(0,4));
  send({ type: 'offer', targetId: peerId, sdp: pc.localDescription });
}

async function handleOffer(msg) {
  // Don't require mic to answer — just complete the handshake
  // Mic will be added when PTT is pressed
  const pc = makePeer(msg.fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  await flushIceCandidates(msg.fromId);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  showStatus('Sending answer to ' + msg.fromId.substring(0,4));
  send({ type: 'answer', targetId: msg.fromId, sdp: pc.localDescription });
  showStatus('Answer sent');
  // Mic will be requested only when PTT is pressed
}

async function handleAnswer(msg) {
  showStatus('Got answer from ' + msg.fromId.substring(0,4));
  const pc = peers.get(msg.fromId);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    showStatus('Answer set, state: ' + pc.signalingState);
  } else {
    showStatus('No peer for answer from ' + msg.fromId.substring(0,4));
  }
}

async function flushIceCandidates(peerId) {
  const pc = peers.get(peerId);
  const queue = iceCandidateQueue.get(peerId);
  if (pc && queue && queue.length > 0) {
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        showStatus('Flushed ICE for ' + peerId.substring(0,4));
      } catch(e) {
        showStatus('ICE flush error: ' + e.message);
      }
    }
    iceCandidateQueue.delete(peerId);
  }
}

async function handleIce(msg) {
  const pc = peers.get(msg.fromId);
  if (pc) {
    if (!pc.remoteDescription) {
      if (!iceCandidateQueue.has(msg.fromId)) iceCandidateQueue.set(msg.fromId, []);
      iceCandidateQueue.get(msg.fromId).push(msg.candidate);
      showStatus('Queued ICE from ' + msg.fromId.substring(0,4));
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      showStatus('Added ICE from ' + msg.fromId.substring(0,4) + ' sig:' + pc.signalingState);
    } catch(e) {
      showStatus('ICE add error: ' + e.message);
    }
  } else {
    showStatus('No peer for ICE from ' + msg.fromId.substring(0,4));
  }
}
function closePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) { pc.close(); peers.delete(peerId); }
  const audio = audioEls.get(peerId);
  if (audio) { audio.srcObject = null; audio.remove(); audioEls.delete(peerId); }
}


// ── PTT ──
async function startTx(e) {
  if (e) e.preventDefault();
  if (!currentRoom || transmitting) return;

  try {
    await getMic();
  } catch(err) {
    showToast('Microphone access denied');
    return;
  }

  const audioTrack = localStream.getAudioTracks()[0];
  const renegotiatePromises = [];

  peers.forEach((pc, peerId) => {
    const senders = pc.getSenders();
    const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
    if (audioSender) {
      // Replace existing track
      audioSender.replaceTrack(audioTrack).catch(console.error);
    } else {
      // Add track and renegotiate
      pc.addTrack(audioTrack, localStream);
      renegotiatePromises.push(
        pc.createOffer().then(offer => {
          return pc.setLocalDescription(offer).then(() => {
            send({ type: 'offer', targetId: peerId, sdp: pc.localDescription });
          });
        }).catch(console.error)
      );
    }
  });

  await Promise.all(renegotiatePromises);
  localStream.getTracks().forEach(t => t.enabled = true);
  transmitting = true;
  pttStartTime = Date.now();

  // Start recording for async playback
  try {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(localStream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start();
  } catch(e) { console.error('MediaRecorder error:', e); }

  send({ type: 'ptt-start' });
  document.getElementById('ptt-btn').classList.add('tx');
  document.getElementById('ptt-outer').classList.add('tx');
  document.getElementById('ptt-hint').textContent = '● TRANSMITTING';
  document.getElementById('ptt-hint').className = 'ptt-hint tx';
  setWave('tx');
}

function stopTx() {
  if (!transmitting) return;
  transmitting = false;
  // Fully stop mic tracks to exit call mode immediately
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  send({ type: 'ptt-stop' });

  // Upload recording to R2
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.onstop = async () => {
      try {
        const duration = Math.round((Date.now() - pttStartTime) / 1000);
        if (duration < 1 || recordedChunks.length === 0) return;
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        const serverUrl = window.location.origin;
        const params = new URLSearchParams({ name: myName, duration, room: 'BREAKER' });
        await fetch(`${serverUrl}/upload?${params}`, {
          method: 'POST',
          body: blob,
          headers: { 'Content-Type': 'audio/webm' }
        });
      } catch(e) { console.error('Upload failed:', e); }
      recordedChunks = [];
      mediaRecorder = null;
    };
  }
  document.getElementById('ptt-btn').classList.remove('tx');
  document.getElementById('ptt-outer').classList.remove('tx');
  document.getElementById('ptt-hint').textContent = 'Everyone in the room will hear you';
  document.getElementById('ptt-hint').className = 'ptt-hint';
  setWave(null);
}

// ── JOIN ──
async function joinMain() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) { showToast('Enter your name'); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected yet'); return; }
  myName = name;
  localStorage.setItem('breaker-name', name);
  // Do NOT get mic here - only on PTT press
  send({ type: 'join-room', code: 'BREAKER', peerName: name });
}

function leaveRoom() {
  send({ type: 'leave-room' });
  peers.forEach((_, id) => closePeer(id));
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  currentRoom = null;
  window._wasInRoom = false;
  setWave(null);
  showScreen('screen-rooms');
}

// ── UI ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function renderRoom(room) {
  const el = document.getElementById('room-title');
  if (el) el.textContent = 'BREAKER';
  updateMembers(room);
}

function updateMembers(room) {
  if (!room) return;
  const selfLetter = (myName[0] || '?').toUpperCase();
  const all = [{ name: myName, initial: selfLetter },
    ...(room.members || []).filter(m => m.id !== myId)];
  const container = document.getElementById('room-avatars');
  if (!container) return;
  container.innerHTML = '';
  all.slice(0, 6).forEach(m => {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = (m.name[0] || '?').toUpperCase();
    av.onclick = () => showMemberName(m.name);
    container.appendChild(av);
  });
  const cnt = document.getElementById('room-member-count');
  if (cnt) cnt.textContent = all.length;
}

function showSpeaking(name, active) {
  setWave(active ? 'rx' : null);
  const ws2 = document.getElementById('wave-status');
  if (ws2) {
    ws2.textContent = active ? name.toUpperCase() : 'IDLE';
    ws2.className = active ? 'wave-status rx' : 'wave-status';
  }
}

function setWave(mode) {
  document.querySelectorAll('.wbar').forEach(b => {
    b.classList.remove('tx', 'rx');
    if (mode) b.classList.add(mode);
  });
  const ws2 = document.getElementById('wave-status');
  if (!mode && ws2) { ws2.textContent = 'IDLE'; ws2.className = 'wave-status'; }
}

function updateStatus(connected) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  if (dot) { dot.style.background = connected ? '#39ff8a' : '#ff4545'; dot.style.boxShadow = connected ? '0 0 6px #39ff8a' : '0 0 6px #ff4545'; }
  if (lbl) lbl.textContent = connected ? 'LIVE' : 'RECONNECTING';
}

// ── RECENT MESSAGES ──
async function loadMessages() {
  try {
    const res = await fetch('/messages');
    const msgs = await res.json();
    const list = document.getElementById('msg-list');
    if (!list) return;
    list.innerHTML = '';
    msgs.forEach(addMessage);
  } catch(e) {}
}

function addMessage(msg) {
  const list = document.getElementById('msg-list');
  if (!list) return;
  // Remove existing entry with same id
  document.getElementById('msg-' + msg.id)?.remove();
  const el = document.createElement('div');
  el.id = 'msg-' + msg.id;
  el.className = 'msg-item';
  const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="msg-av">${(msg.name[0] || '?').toUpperCase()}</div>
    <div class="msg-body">
      <div class="msg-name">${msg.name}</div>
      <div class="msg-meta">${msg.duration}s · ${time}</div>
    </div>
    <button class="msg-play" onclick="playMsg('${msg.url}', this)">▶</button>
  `;
  list.insertBefore(el, list.firstChild);
  // Keep max 10
  while (list.children.length > 10) list.removeChild(list.lastChild);
}

let currentAudio = null;
function playMsg(url, btn) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  const audio = new Audio(url);
  currentAudio = audio;
  btn.textContent = '■';
  audio.play();
  audio.onended = () => { btn.textContent = '▶'; currentAudio = null; };
  audio.onerror = () => { btn.textContent = '▶'; showToast('Playback failed'); };
}

// ── MEMBER NAME ──
function showMemberName(name) {
  document.getElementById('member-popup')?.remove();
  const el = document.createElement('div');
  el.id = 'member-popup';
  el.textContent = name;
  el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#141816;border:2px solid #39ff8a;color:#39ff8a;font-family:"Bebas Neue",sans-serif;font-size:1.8rem;letter-spacing:4px;padding:18px 32px;border-radius:16px;z-index:999;pointer-events:none;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ── STATUS (console only) ──
function showStatus(msg) {
  console.log('[BREAKER]', msg);
}

// ── TOAST ──
let toastT;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2400);
}

// ── SHARE ──
function copyInviteLink() {
  const link = window.location.origin;
  navigator.clipboard?.writeText(link).then(() => showToast('Link copied!'));
}

// ── PWA ──
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  document.getElementById('install-banner')?.classList.add('show');
});
function installPWA() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => {
    deferredPrompt = null;
    document.getElementById('install-banner')?.classList.remove('show');
  });
}

// ── MIC RELEASE ──
document.addEventListener('visibilitychange', () => {
  if (document.hidden && localStream) {
    localStream.getTracks().forEach(t => t.enabled = false);
    if (transmitting) stopTx();
  }
});
window.addEventListener('pagehide', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

// ── SERVICE WORKER + PUSH NOTIFICATIONS ──
let swRegistration = null;

async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    console.log('SW registered');
    await requestNotificationPermission();
  } catch(e) {
    console.log('SW failed:', e);
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // only when in background
  new Notification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'breaker-ptt', // replaces previous notification
    renotify: true,
    silent: false,
  });
}

initServiceWorker();

// ── RESTORE NAME ──
const savedName = localStorage.getItem('breaker-name');
if (savedName) {
  document.getElementById('name-input').value = savedName;
  document.getElementById('self-av').textContent = savedName[0].toUpperCase();
  myName = savedName;
}

document.getElementById('name-input').addEventListener('input', () => {
  const v = document.getElementById('name-input').value.trim();
  if (v) {
    document.getElementById('self-av').textContent = v[0].toUpperCase();
    localStorage.setItem('breaker-name', v);
    myName = v;
  }
});

// ── START ──
connectWS();

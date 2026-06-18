// GROUNDWAVE — app.js
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const SERVER_URL = `${wsProtocol}//${window.location.host}`;

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
let hasInteracted = false;
let silentAudioContext = null;
let globalDummyTrack = null;
const peers = new Map();
const audioEls = new Map();
const iceCandidateQueue = new Map();

let reconnectDelay = 2000;

function connectWS() {
  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    reconnectDelay = 2000;
    updateStatus(true);
    const savedName = localStorage.getItem('groundwave-name');
    if (savedName) {
      myName = savedName;
      document.getElementById('name-input').value = savedName;
      if (hasInteracted) {
        peers.forEach((_, id) => closePeer(id));
        currentRoom = null;
        const savedRoom = localStorage.getItem('groundwave-room') || 'GROUNDWAVE';
        setTimeout(() => {
          send({ type: 'join-room', code: savedRoom, peerName: savedName });
        }, 500);
      }
    }
  };

  ws.onclose = () => {
    updateStatus(false);
    window._disconnectedAt = Date.now();
    peers.forEach((_, id) => closePeer(id));
    setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  };

  ws.onerror = (err) => console.error('[CRASH] WebSocket Error:', err);

  ws.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case 'room-created':
      case 'room-joined':
        myId = msg.myId || myId;
        currentRoom = msg.room;
        renderRoom(msg.room);
        showScreen('screen-room');
        loadMessages();
        break;

      case 'peer-joined':
        if (msg.replacedId) closePeer(msg.replacedId);
        currentRoom = msg.room;
        updateOnlineList(msg.room);
        updateMembers(msg.room);
        showToast(msg.peerName + ' joined');
        await createOffer(msg.peerId);
        break;

      case 'peer-left':
        currentRoom = msg.room;
        updateOnlineList(msg.room);
        updateMembers(msg.room);
        showToast(msg.peerName + ' left');
        closePeer(msg.peerId);
        break;

      case 'offer':
        if (peers.has(msg.fromId)) { await handleRenegotiation(msg); }
        else { await handleOffer(msg); }
        break;

      case 'answer': await handleAnswer(msg); break;
      case 'ice-candidate': await handleIce(msg); break;

      case 'room-list':
        renderRoomList(msg.rooms);
        break;

      case 'ptt-start':
        showSpeaking(msg.peerName, true);
        sendNotification('📻 GROUNDWAVE', msg.peerName + ' is talking...');
        break;

      case 'ptt-stop':
        showSpeaking(msg.peerName, false);
        break;

      case 'new-message':
        addMessage(msg.message);
        break;

      case 'error':
        if (msg.message === 'Room not found') {
          showToast('Channel not found');
          showScreen('screen-rooms');
        }
        break;
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function getMic() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });
  return localStream;
}

function makePeer(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: 'ice-candidate', targetId: peerId, candidate });
  };

  pc.ontrack = ({ streams: [stream] }) => {
    log('Got audio from ' + peerId.substring(0,4));
    let audio = audioEls.get(peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
      audioEls.set(peerId, audio);
    }
    audio.srcObject = stream;
    audio.play().catch(console.error);
  };

  pc.onconnectionstatechange = () => log('Peer: ' + pc.connectionState);
  pc.oniceconnectionstatechange = () => {
    log('ICE: ' + pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') pc.restartIce();
  };

  peers.set(peerId, pc);
  return pc;
}

async function createOffer(peerId) {
  const pc = makePeer(peerId);
  try {
    if (globalDummyTrack) {
      const track = globalDummyTrack.clone();
      pc.addTrack(track, new MediaStream([track]));
    }
  } catch(e) { log('Dummy track error'); }
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  send({ type: 'offer', targetId: peerId, sdp: pc.localDescription });
}

async function handleOffer(msg) {
  const pc = makePeer(msg.fromId);
  try {
    if (globalDummyTrack) {
      const track = globalDummyTrack.clone();
      pc.addTrack(track, new MediaStream([track]));
    }
  } catch(e) { log('Dummy track error'); }
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  await flushIceCandidates(msg.fromId);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'answer', targetId: msg.fromId, sdp: pc.localDescription });
}

async function handleRenegotiation(msg) {
  const pc = peers.get(msg.fromId);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  await flushIceCandidates(msg.fromId);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'answer', targetId: msg.fromId, sdp: pc.localDescription });
  log('Renegotiation answer sent');
}

async function handleAnswer(msg) {
  const pc = peers.get(msg.fromId);
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
}

async function flushIceCandidates(peerId) {
  const pc = peers.get(peerId);
  const queue = iceCandidateQueue.get(peerId);
  if (pc && queue && queue.length > 0) {
    for (const c of queue) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {} }
    iceCandidateQueue.delete(peerId);
  }
}

async function handleIce(msg) {
  const pc = peers.get(msg.fromId);
  if (!pc) return;
  if (!pc.remoteDescription) {
    if (!iceCandidateQueue.has(msg.fromId)) iceCandidateQueue.set(msg.fromId, []);
    iceCandidateQueue.get(msg.fromId).push(msg.candidate);
    return;
  }
  try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch(e) {}
}

function closePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) { pc.close(); peers.delete(peerId); }
  const audio = audioEls.get(peerId);
  if (audio) { audio.srcObject = null; audio.remove(); audioEls.delete(peerId); }
}

async function startTx(e) {
  if (e) e.preventDefault();
  if (!currentRoom || transmitting) return;
  try { await getMic(); } catch(err) { showToast('Mic denied'); return; }

  const audioTrack = localStream.getAudioTracks()[0];
  peers.forEach((pc) => {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) { sender.replaceTrack(audioTrack).catch(console.error); }
    else { try { pc.addTrack(audioTrack, localStream); } catch(e) {} }
  });

  localStream.getTracks().forEach(t => t.enabled = true);
  transmitting = true;
  pttStartTime = Date.now();

  try {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(localStream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      try {
        const durationMs = Date.now() - pttStartTime;
        if (durationMs < 400 || recordedChunks.length === 0) return;
        const durationSec = Math.max(1, Math.round(durationMs / 1000));
        const finalMime = mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(recordedChunks, { type: finalMime });
        const params = new URLSearchParams({ name: myName, duration: durationSec, room: 'GROUNDWAVE' });
        const response = await fetch(`/upload?${params}`, { method: 'POST', body: blob });
        if (!response.ok) log('Upload failed: ' + response.status);
      } catch(e) { log('Upload error: ' + e.message); }
      recordedChunks = [];
      mediaRecorder = null;
    };
    mediaRecorder.start();
  } catch(e) { log('Recorder failed: ' + e.message); }

  send({ type: 'ptt-start' });
  document.getElementById('ptt-btn').classList.add('tx');
  document.getElementById('ptt-outer').classList.add('tx');
  document.getElementById('ptt-hint').textContent = '● TRANSMITTING';
  document.getElementById('ptt-hint').className = 'ptt-hint tx';
  setWave('tx');

  // Safety net — if touch is lost (call interrupt, notification, etc) stop TX
  const safetyStop = () => { if (transmitting) stopTx(); };
  document.addEventListener('touchcancel', safetyStop, { once: true });
  document.addEventListener('pointercancel', safetyStop, { once: true });
  // Max transmission time 60 seconds
  window._pttSafety = setTimeout(safetyStop, 60000);
}

function stopTx() {
  if (!transmitting) return;
  transmitting = false;

  // Send stop signal FIRST before anything can fail
  send({ type: 'ptt-stop' });
  clearTimeout(window._pttSafety);

  // Swap back to dummy track
  if (globalDummyTrack) {
    peers.forEach((pc) => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(globalDummyTrack.clone()).catch(console.error);
    });
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch(e) {}
  }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  document.getElementById('ptt-btn').classList.remove('tx');
  document.getElementById('ptt-outer').classList.remove('tx');
  document.getElementById('ptt-hint').textContent = 'Everyone in the room will hear you';
  document.getElementById('ptt-hint').className = 'ptt-hint';
  setWave(null);
}

async function joinMain(roomCode) {
  const name = document.getElementById('name-input').value.trim();
  if (!name) { showToast('Enter your name'); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected yet'); return; }

  // Get room name — either passed in (from list) or from input
  const roomInput = document.getElementById('room-name-input');
  const code = (roomCode || (roomInput ? roomInput.value.trim() : '') || 'GROUNDWAVE').toUpperCase();
  if (!code) { showToast('Enter a channel name'); return; }

  // Create AudioContext dummy track on user gesture
  if (!silentAudioContext) {
    try {
      silentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      await silentAudioContext.resume();
      const oscillator = silentAudioContext.createOscillator();
      const dst = silentAudioContext.createMediaStreamDestination();
      oscillator.connect(dst);
      oscillator.start();
      globalDummyTrack = dst.stream.getAudioTracks()[0];
      globalDummyTrack.enabled = false;
    } catch(e) { log('AudioContext failed: ' + e.message); }
  }

  myName = name;
  hasInteracted = true;
  localStorage.setItem('groundwave-name', name);
  localStorage.setItem('groundwave-room', code);
  send({ type: 'join-room', code, peerName: name });
}

function leaveRoom() {
  send({ type: 'leave-room' });
  peers.forEach((_, id) => closePeer(id));
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  currentRoom = null;
  hasInteracted = false;
  setWave(null);
  showScreen('screen-rooms');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function renderRoom(room) { updateMembers(room); }

function renderRoomList(rooms) {
  const list = document.getElementById('room-list');
  if (!list) return;
  const active = (rooms || []).filter(r => r.memberCount > 0);
  if (active.length === 0) {
    list.innerHTML = '<div style="font-size:0.75rem;color:#8b949e;text-align:center;padding:12px;">No active channels</div>';
    return;
  }
  list.innerHTML = active.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:13px 14px;">
      <div>
        <div style="font-family:'Inter',sans-serif;font-size:0.95rem;color:#ffffff;font-weight:600;">${r.name}</div>
        <div style="font-family:'Inter',sans-serif;font-size:0.68rem;color:#39c057;margin-top:2px;">● ${r.memberCount} online</div>
      </div>
      <button type="button" onclick="joinMain('${r.code}')"
        style="background:#f0a500;color:#000;font-family:'Inter',sans-serif;font-size:0.78rem;font-weight:700;padding:8px 18px;border:none;border-radius:8px;cursor:pointer;">
        Join
      </button>
    </div>
  `).join('');
}

function updateOnlineList(room) {
  const list = document.getElementById('online-list');
  if (!list) return;
  const members = room ? room.members || [] : [];
  if (members.length === 0) {
    list.innerHTML = '<div style="font-family:\'Inter\',sans-serif;font-size:0.75rem;color:#8b949e;text-align:center;padding:12px;">No one else online yet</div>';
    return;
  }
  list.innerHTML = members.map(m => `
    <div style="display:flex;align-items:center;justify-content:space-between;background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:13px 14px;">
      <div>
        <div style="font-family:'Inter',sans-serif;font-size:0.95rem;color:#ffffff;font-weight:600;">${m.name}</div>
        <div style="font-family:'Inter',sans-serif;font-size:0.68rem;color:#39c057;margin-top:2px;">● online</div>
      </div>
    </div>
  `).join('');
}

function updateMembers(room) {
  if (!room) return;
  const all = [{ name: myName, id: myId }, ...(room.members || []).filter(m => m.id !== myId)];
  const container = document.getElementById('room-avatars');
  if (!container) return;
  container.innerHTML = '';
  all.slice(0, 6).forEach(m => {
    const initial = (m.name[0] || '?').toUpperCase();
    const shortName = m.name.length > 7 ? m.name.substring(0, 7) : m.name;
    const av = document.createElement('div');
    av.className = 'avatar';
    av.innerHTML = `<div class="avatar-circle">${initial}</div><div class="avatar-name">${shortName}</div>`;
    av.onclick = () => showMemberName(m.name);
    container.appendChild(av);
  });
  const cnt = document.getElementById('room-member-count');
  if (cnt) cnt.textContent = all.length;
}

function showSpeaking(name, active) {
  setWave(active ? 'rx' : null);
  const el = document.getElementById('wave-status');
  if (el) { el.textContent = active ? name.toUpperCase() : 'IDLE'; el.className = active ? 'wave-status rx' : 'wave-status'; }
}

function setWave(mode) {
  document.querySelectorAll('.wbar').forEach(b => { b.classList.remove('tx','rx'); if (mode) b.classList.add(mode); });
  const el = document.getElementById('wave-status');
  if (!mode && el) { el.textContent = 'IDLE'; el.className = 'wave-status'; }
}

function updateStatus(connected) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  const txt = document.getElementById('conn-dot-txt');
  if (dot) { dot.style.background = connected ? '#f0a500' : '#ff4545'; dot.style.boxShadow = connected ? '0 0 6px #f0a500' : '0 0 6px #ff4545'; }
  if (lbl) lbl.textContent = connected ? 'Live' : 'Reconnecting';
  if (txt) { txt.textContent = '●'; txt.style.color = connected ? '#f0a500' : '#ff4545'; }
}

async function loadMessages() {
  try {
    const res = await fetch('/messages');
    const msgs = await res.json();
    const list = document.getElementById('msg-list');
    if (!list) return;
    list.innerHTML = '';
    msgs.reverse().forEach(addMessage);
  } catch(e) {}
}

function addMessage(msg) {
  const list = document.getElementById('msg-list');
  if (!list) return;
  document.getElementById('msg-' + msg.id)?.remove();
  const el = document.createElement('div');
  el.id = 'msg-' + msg.id;
  el.className = 'msg-item';
  const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="msg-av">${(msg.name[0]||'?').toUpperCase()}</div>
    <div class="msg-body">
      <div class="msg-name">${msg.name}</div>
      <div class="msg-meta">${msg.duration}s · ${time}</div>
    </div>
    <button class="msg-play" onclick="playMsg('${msg.url}',this)">▶</button>`;
  list.insertBefore(el, list.firstChild);
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

function showMemberName(name) {
  document.getElementById('member-popup')?.remove();
  const el = document.createElement('div');
  el.id = 'member-popup';
  el.textContent = name;
  el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#141816;border:2px solid #39ff8a;color:#39ff8a;font-family:"Bebas Neue",sans-serif;font-size:1.8rem;letter-spacing:4px;padding:18px 32px;border-radius:16px;z-index:999;pointer-events:none;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ── SHARE ──
async function shareApp() {
  const url = window.location.origin;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'GROUNDWAVE', text: 'Join me on GROUNDWAVE — push to talk radio', url });
      return;
    } catch(e) {}
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied!');
  } catch(e) { showToast(url); }
}

// ── INSTALL TIP ──
function checkInstallTip() {
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const tip = document.getElementById('install-tip');
  if (!tip) return;
  tip.style.display = 'block';
  if (isInstalled) {
    document.getElementById('install-tip-installed').style.display = 'block';
  } else if (isIOS) {
    document.getElementById('install-tip-ios').style.display = 'block';
  } else {
    document.getElementById('install-tip-android').style.display = 'block';
    if (!deferredPrompt) {
      document.getElementById('install-btn-android').style.display = 'none';
      document.getElementById('install-tip-android-manual').style.display = 'block';
    }
  }
}

// ── MEMBER POPUP ──
function showMemberName(name) {
  document.getElementById('member-popup')?.remove();
  const el = document.createElement('div');
  el.id = 'member-popup';
  el.textContent = name;
  el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1c2128;border:2px solid #f0a500;color:#f0a500;font-family:"Bebas Neue",cursive;font-size:1.8rem;letter-spacing:4px;padding:18px 32px;border-radius:16px;z-index:999;pointer-events:none;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

const logLines = [];
function log(msg) {
  const time = new Date().toISOString().substring(11,19);
  logLines.unshift(time + ' ' + msg);
  if (logLines.length > 20) logLines.pop();
  console.log('[GROUNDWAVE]', msg);
  const el = document.getElementById('log-panel');
  if (el) el.textContent = logLines.join('\n');
}
function copyLog() {
  navigator.clipboard?.writeText(logLines.join('\n')).then(() => showToast('Log copied!'));
}

let toastT;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2400);
}

async function initNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
}

function sendNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  new Notification(title, { body, tag: 'groundwave-ptt', renotify: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && transmitting) stopTx();
});
window.addEventListener('pagehide', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  document.getElementById('install-banner')?.classList.add('show');
});
function installPWA() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
}

const savedName = localStorage.getItem('groundwave-name');
if (savedName) {
  document.getElementById('name-input').value = savedName;
  myName = savedName;
}
document.getElementById('name-input').addEventListener('input', () => {
  const v = document.getElementById('name-input').value.trim();
  if (v) { localStorage.setItem('groundwave-name', v); myName = v; }
});

initNotifications();
connectWS();
checkInstallTip();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}

// BREAKER — app.js
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
let hasInteracted = false; 
let mimeTypeUsed = '';
let silentAudioContext = null;
let globalDummyTrack = null;
const peers = new Map();
const audioEls = new Map();
const iceCandidateQueue = new Map();

// ── WEBSOCKET ──
let reconnectDelay = 2000;

function connectWS() {
  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    reconnectDelay = 2000;
    updateStatus(true);
    const savedName = localStorage.getItem('breaker-name');
    if (savedName) {
      myName = savedName;
      document.getElementById('name-input').value = savedName;
      const av = document.getElementById('self-av');
      if (av) av.querySelector('.avatar-circle').textContent = savedName[0].toUpperCase();
      
      if (hasInteracted) {
        peers.forEach((_, id) => closePeer(id));
        currentRoom = null;
        send({ type: 'join-room', code: 'BREAKER', peerName: savedName });
      }
    }
  };

  ws.onclose = () => {
    updateStatus(false);
    peers.forEach((_, id) => closePeer(id));
    setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  };

  ws.onerror = () => {};

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
        updateMembers(msg.room);
        showToast(msg.peerName + ' joined');
        await createOffer(msg.peerId);
        break;

      case 'peer-left':
        currentRoom = msg.room;
        updateMembers(msg.room);
        showToast(msg.peerName + ' left');
        closePeer(msg.peerId);
        break;

      case 'offer':
        if (peers.has(msg.fromId)) {
          await handleRenegotiation(msg);
        } else {
          await handleOffer(msg);
        }
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

      case 'ptt-stop':
        showSpeaking(msg.peerName, false);
        break;

      case 'new-message':
        addMessage(msg.message);
        break;

      case 'error':
        if (msg.message === 'Room not found') {
          setTimeout(() => {
            if (myName && ws?.readyState === WebSocket.OPEN)
              send({ type: 'join-room', code: 'BREAKER', peerName: myName });
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
  } catch(e) { log('Dummy track blocked'); }
  
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
  } catch(e) { log('Dummy track blocked'); }
  
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
    for (const c of queue) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
    }
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

// ── PTT ──
async function startTx(e) {
  if (e) e.preventDefault();
  if (!currentRoom || transmitting) return;
  try { await getMic(); } catch(err) { showToast('Mic denied'); return; }

  const audioTrack = localStream.getAudioTracks()[0];
  peers.forEach((pc) => {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) {
      sender.replaceTrack(audioTrack).catch(console.error);
    } else {
      try { pc.addTrack(audioTrack, localStream); } catch(e) {}
    }
  });

  localStream.getTracks().forEach(t => t.enabled = true);
  transmitting = true;
  pttStartTime = Date.now();

  mimeTypeUsed = 'audio/webm';
  if (!MediaRecorder.isTypeSupported(mimeTypeUsed)) {
    mimeTypeUsed = 'audio/mp4';
    if (!MediaRecorder.isTypeSupported(mimeTypeUsed)) mimeTypeUsed = '';
  }
  const options = mimeTypeUsed ? { mimeType: mimeTypeUsed } : {};

  try {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(localStream, options);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      try {
        const durationMs = Date.now() - pttStartTime;
        if (durationMs < 400 || recordedChunks.length === 0) return; 
        const durationSec = Math.max(1, Math.round(durationMs / 1000));
        const blob = new Blob(recordedChunks, { type: mimeTypeUsed || 'audio/webm' });
        const params = new URLSearchParams({ name: myName, duration: durationSec, room: 'BREAKER' });
        await fetch(`/upload?${params}`, { method: 'POST', body: blob });
      } catch(e) { log('Upload failed'); }
      recordedChunks = [];
      mediaRecorder = null;
    };
    mediaRecorder.start();
  } catch(e) { log('Recorder init failed'); }

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

  if (globalDummyTrack) {
    peers.forEach((pc) => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(globalDummyTrack.clone()).catch(console.error);
    });
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  send({ type: 'ptt-stop' });

  document.getElementById('ptt-btn').classList.remove('tx');
  document.getElementById('ptt-outer').classList.remove('tx');
  document.getElementById('ptt-hint').textContent = 'Everyone in the room will hear you';
  document.getElementById('ptt-hint').className = 'ptt-hint';
  setWave(null);
}

// ── JOIN / LEAVE ──
async function joinMain() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) { showToast('Enter your name'); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected yet'); return; }
  
  if (!silentAudioContext) {
    silentAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    await silentAudioContext.resume(); 
    const oscillator = silentAudioContext.createOscillator();
    const dst = silentAudioContext.createMediaStreamDestination();
    oscillator.connect(dst);
    oscillator.start();
    globalDummyTrack = dst.stream.getAudioTracks()[0];
    globalDummyTrack.enabled = false; 
  }

  myName = name;
  hasInteracted = true; 
  localStorage.setItem('breaker-name', name);
  send({ type: 'join-room', code: 'BREAKER', peerName: name });
}

function leaveRoom() {
  send({ type: 'leave-room' });
  peers.forEach((_, id) => closePeer(id));
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  currentRoom = null;
  setWave(null);
  showScreen('screen-rooms');
}

// ── UI ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function renderRoom(room) {
  updateMembers(room);
}

function updateMembers(room) {
  if (!room) return;
  const all = [{ name: myName, id: myId },
    ...(room.members || []).filter(m => m.id !== myId)];
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
    <div class="msg-av">${(msg.name[0]||'?').

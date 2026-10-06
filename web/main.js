import { displaySize, paletteRGBA32, loadSounds } from './protocol.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false });
const overlay = $('overlay');
const params = new URLSearchParams(location.search);

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onerror = (e) => fail(`worker failed to start: ${e.message || 'see console'}`);

let w = 0, h = 0, pal32 = null, src = null, srcCtx = null, img = null, img32 = null;
let latest = null, drawPending = false, loading = true, paused = false;
const loadStart = performance.now();
const frameTimes = [];
let lastMs = 0, lastTic = 0;

const sound = { lumps: null, ctx: null, gain: null, buffers: new Map(), voices: [], missing: new Set(),
  muted: localStorage.getItem('beldoom-muted') === '1', error: null };
fetch(new URL('../wad/sounds.wad', import.meta.url))
  .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`wad/sounds.wad: HTTP ${r.status}`))))
  .then((b) => { sound.lumps = loadSounds(new Uint8Array(b)); })
  .catch((e) => { sound.error = e.message; console.warn('[bel-doom] no sound:', e.message); })
  .finally(soundLabel);

function soundLabel() {
  const state = sound.error ? 'unavailable' : !sound.lumps ? 'loading' : sound.muted ? 'muted' :
    sound.ctx && sound.ctx.state === 'running' ? 'on' : 'press a key';
  $('snd').innerHTML = `sound <b>${state}</b> (M)`;
}

function unlockAudio() {
  if (!sound.ctx) {
    try { sound.ctx = new AudioContext(); } catch { return; }
    sound.gain = sound.ctx.createGain();
    sound.gain.gain.value = 0.6;
    sound.gain.connect(sound.ctx.destination);
    sound.ctx.onstatechange = soundLabel;
  }
  if (sound.ctx.state === 'suspended') sound.ctx.resume().then(soundLabel, () => {});
}

function soundBuffer(name) {
  let buf = sound.buffers.get(name);
  if (buf) return buf;
  const s = sound.lumps.get(name);
  if (!s) {
    if (!sound.missing.has(name)) { sound.missing.add(name); console.warn(`[bel-doom] no sound lump ${name}`); }
    return null;
  }
  buf = sound.ctx.createBuffer(1, s.samples.length, s.rate);
  buf.copyToChannel(s.samples, 0);
  sound.buffers.set(name, buf);
  return buf;
}

function stopVoice(v) { v.onended = null; try { v.stop(); } catch {} }

function playSounds(names) {
  if (!names || !names.length || sound.muted || !sound.lumps || !sound.ctx || sound.ctx.state !== 'running') return;
  for (const name of new Set(names)) {
    const buf = soundBuffer(name);
    if (!buf) continue;
    while (sound.voices.length >= 8) stopVoice(sound.voices.shift());
    const v = sound.ctx.createBufferSource();
    v.buffer = buf;
    v.connect(sound.gain);
    v.onended = () => { const i = sound.voices.indexOf(v); if (i >= 0) sound.voices.splice(i, 1); };
    v.start();
    sound.voices.push(v);
  }
}

function toggleMute() {
  sound.muted = !sound.muted;
  localStorage.setItem('beldoom-muted', sound.muted ? '1' : '0');
  if (sound.muted) sound.voices.splice(0).forEach(stopVoice);
  soundLabel();
}

function setOverlay(big, text, isError) {
  overlay.classList.remove('hidden');
  overlay.innerHTML = '';
  const b = document.createElement('div'); b.className = 'big'; b.textContent = big; overlay.append(b);
  const t = document.createElement('div'); t.className = isError ? 'err' : ''; t.id = 'status'; t.textContent = text; overlay.append(t);
  const el = document.createElement('div'); el.id = 'elapsed'; overlay.append(el);
}

function fail(text) {
  loading = false;
  setOverlay('ERROR', text, true);
  console.error(text);
}

setInterval(() => {
  if (loading) {
    const el = $('elapsed');
    if (el) el.textContent = `${((performance.now() - loadStart) / 1000).toFixed(1)} s`;
    return;
  }
  const now = performance.now();
  while (frameTimes.length && now - frameTimes[0] > 2000) frameTimes.shift();
  const fps = frameTimes.length > 1 ? (frameTimes.length - 1) * 1000 / (frameTimes[frameTimes.length - 1] - frameTimes[0]) : 0;
  $('fps').innerHTML = `fps <b>${fps.toFixed(1)}</b>`;
  $('tic').innerHTML = `tic <b>${lastTic}</b> &middot; <b>${lastMs.toFixed(0)}</b> ms/frame in Bel`;
}, 250);

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'status') { setOverlay('LOADING', m.text); }
  else if (m.type === 'log') { console.log('[bel]', m.text.replace(/\n$/, '')); }
  else if (m.type === 'error') { fail(m.text); }
  else if (m.type === 'init') {
    ({ w, h } = m);
    pal32 = paletteRGBA32(m.palette);
    src = document.createElement('canvas'); src.width = w; src.height = h;
    srcCtx = src.getContext('2d');
    img = srcCtx.createImageData(w, h);
    img32 = new Uint32Array(img.data.buffer);
    const [dw, dh] = displaySize(w, h, Math.max(1, Math.round(800 / w)));
    canvas.width = dw; canvas.height = dh;
    if (startPaused) { loading = false; paused = true; setOverlay('READY', 'press Esc to start'); }
    else setOverlay('LOADING', 'running the first tic (doom-frame)');
    console.log(`[bel-doom] ready in ${(m.ms / 1000).toFixed(1)} s, screen ${w}x${h} -> ${dw}x${dh}`);
  } else if (m.type === 'frame') {
    if (loading) { loading = false; overlay.classList.add('hidden'); }
    latest = m.frame; lastMs = m.ms; lastTic = m.tic;
    playSounds(m.sounds);
    frameTimes.push(performance.now());
    if (!drawPending) { drawPending = true; requestAnimationFrame(draw); }
  }
};

function draw() {
  drawPending = false;
  const f = latest;
  for (let x = 0; x < w; x++) {
    const col = x * h;
    for (let y = 0; y < h; y++) img32[y * w + x] = pal32[f[col + y]];
  }
  srcCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
}

const held = new Set();
let sentKeys = '';
const ORDER = 'wsadqerfu';

function keyString() {
  const alt = held.has('AltLeft') || held.has('AltRight');
  const s = new Set();
  for (const code of held) {
    switch (code) {
      case 'ArrowUp': case 'KeyW': s.add('w'); break;
      case 'ArrowDown': case 'KeyS': s.add('s'); break;
      case 'ArrowLeft': s.add(alt ? 'q' : 'a'); break;
      case 'ArrowRight': s.add(alt ? 'e' : 'd'); break;
      case 'KeyA': s.add('a'); break;
      case 'KeyD': s.add('d'); break;
      case 'KeyQ': s.add('q'); break;
      case 'KeyE': s.add('e'); break;
      case 'ShiftLeft': case 'ShiftRight': s.add('r'); break;
      case 'ControlLeft': case 'ControlRight': case 'KeyF': s.add('f'); break;
      case 'Space': case 'KeyU': s.add('u'); break;
    }
  }
  return [...ORDER].filter((c) => s.has(c)).join('');
}

const MAPPED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyF', 'Space', 'KeyU', 'AltLeft', 'AltRight']);

function syncKeys() {
  const k = keyString();
  if (k === sentKeys) return;
  sentKeys = k;
  worker.postMessage({ type: 'keys', keys: paused ? '' : k });
  $('held').innerHTML = `keys <b>${k || '-'}</b>`;
}

addEventListener('pointerdown', unlockAudio);
addEventListener('keydown', (e) => {
  unlockAudio();
  if (e.code === 'KeyM' && !e.repeat) { toggleMute(); return; }
  if (e.code === 'Escape' && !loading && src) {
    paused = !paused;
    worker.postMessage({ type: 'pause', paused });
    if (paused) setOverlay('PAUSED', 'press Esc to resume'); else overlay.classList.add('hidden');
    sentKeys = null; syncKeys();
    return;
  }
  if (!MAPPED.has(e.code)) return;
  e.preventDefault();
  held.add(e.code);
  syncKeys();
});
addEventListener('keyup', (e) => {
  if (!MAPPED.has(e.code)) return;
  e.preventDefault();
  held.delete(e.code);
  syncKeys();
});
const releaseAll = () => { held.clear(); syncKeys(); };
addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

addEventListener('beforeunload', (e) => { if (lastTic > 0) e.preventDefault(); });
$('frame').addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : $('frame').requestFullscreen()).catch(() => {}));

const hires = params.get('hires') === '1';
const startPaused = params.get('paused') === '1';
const other = new URLSearchParams(params);
if (hires) other.delete('hires'); else other.set('hires', '1');
$('detail').href = `?${other}`.replace(/\?$/, location.pathname);
$('detail').textContent = hires ? 'low detail (160x100)' : 'high detail (320x200)';
worker.postMessage({ type: 'start', wad: params.get('wad') || 'wad/e1m1.wad', hires, paused: startPaused });

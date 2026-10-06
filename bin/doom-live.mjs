#!/usr/bin/env node
// Real-time proof: plays the web page in headless Chromium and screen-records it to MP4. The page starts
// paused; the whole per-tic key script (doom-record format, one step per engine tic) goes to the worker,
// which takes one step per tic in its own 35 Hz scheduler, independent of how many frames get drawn.
//   node bin/doom-live.mjs --script-file bin/demo-route.txt --out live.mp4 [--root DIR] [--res WxH | --hires]
//        [--tier closure] [--port 8099] [--width 1100] [--height 800] [--tail 35] [--chrome chromium] [--no-video]
// Prints presented fps (frames drawn per second), game speed (tics per second, 35 is real time) and the
// p50/p95 time between presented frames.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = { root: path.resolve(here, '..'), script: null, out: 'live.mp4', hires: false, res: null, tier: null, video: true, port: 8099, width: 1100, height: 800, tail: 35, chrome: 'chromium' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => argv[++i];
  if (a === '--root') opt.root = path.resolve(v());
  else if (a === '--script') opt.script = v();
  else if (a === '--script-file') opt.script = fs.readFileSync(v(), 'utf8').replace(/#.*$/gm, '');
  else if (a === '--out') opt.out = v();
  else if (a === '--hires') opt.hires = true;
  else if (a === '--res') opt.res = v();
  else if (a === '--tier') opt.tier = v();
  else if (a === '--no-video') opt.video = false;
  else if (a === '--port') opt.port = Number(v());
  else if (a === '--width') opt.width = Number(v());
  else if (a === '--height') opt.height = Number(v());
  else if (a === '--tail') opt.tail = Number(v());
  else if (a === '--chrome') opt.chrome = v();
  else { console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(2); }
}
if (!opt.script) { console.error('need --script or --script-file'); process.exit(2); }
const steps = [];
for (const tok of opt.script.split(/[\s,]+/).filter(Boolean)) {
  const m = tok.match(/^([wsadqerfu-]*):(\d+)$/);
  if (!m) { console.error(`bad script step "${tok}"`); process.exit(2); }
  for (let i = 0; i < Number(m[2]); i++) steps.push(m[1].replace(/-/g, ''));
}
for (let i = 0; i < opt.tail; i++) steps.push('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-live-'));
const server = spawn(process.execPath, [path.join(here, 'serve.mjs'), String(opt.port), '--root', opt.root, '--host', '127.0.0.1'], { stdio: 'ignore' });
const cdpPort = opt.port + 1;
const chrome = spawn(opt.chrome, ['--headless=new', `--remote-debugging-port=${cdpPort}`, '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
  `--window-size=${opt.width},${opt.height}`, `--user-data-dir=${path.join(tmp, 'profile')}`, 'about:blank'], { stdio: 'ignore', detached: true });
const cleanup = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);

let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(100);
}
if (!ws) throw new Error('could not reach Chromium DevTools');
await new Promise((r) => ws.addEventListener('open', r));
let nextId = 0;
const pending = new Map(), handlers = {};
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method && handlers[m.method]) handlers[m.method](m.params);
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++nextId;
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});

const frames = [];
let lastFrameAt = 0;
handlers['Page.screencastFrame'] = (p) => {
  const file = path.join(tmp, `f${String(frames.length).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(p.data, 'base64'));
  frames.push({ file, t: p.metadata.timestamp });
  lastFrameAt = Date.now();
  send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
};
handlers['Runtime.exceptionThrown'] = (p) => console.error('page exception:', p.exceptionDetails.text, p.exceptionDetails.exception && p.exceptionDetails.exception.description);

const ticLog = [];
let onTic = null;
handlers['Runtime.bindingCalled'] = (p) => {
  if (p.name !== '__belFrame') return;
  const m = JSON.parse(p.payload);
  ticLog.push({ tic: m.tic, keys: m.keys, at: performance.now() });
  if (onTic) onTic(m.tic);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: opt.width, height: opt.height, deviceScaleFactor: 1, mobile: false });
await send('Runtime.addBinding', { name: '__belFrame' });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `{
  window.__belFrames = [];
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) {
      super(...a);
      window.__belWorker = this;
      this.addEventListener('message', (e) => {
        const m = e.data;
        if (!m) return;
        if (m.type === 'init') window.__belFrame(JSON.stringify({ tic: 0 }));
        if (m.type === 'frame') {
          window.__belFrames.push([performance.now(), m.tic, m.tics || 1, m.step || 0, m.render || 0, m.write || 0, m.dropped || 0]);
          window.__belFrame(JSON.stringify({ tic: m.tic }));
        }
      });
    }
  };
}` });
const url = `http://127.0.0.1:${opt.port}/web/?paused=1${opt.res ? `&res=${opt.res}` : opt.hires ? '&hires=1' : ''}${opt.tier ? `&tier=${opt.tier}` : ''}`;
console.error(`doom-live: loading ${url}`);
await send('Page.navigate', { url });

await new Promise((res) => { onTic = () => { onTic = null; res(); }; });
console.error(`doom-live: engine loaded (page started paused), recording ${steps.length} tics`);
if (opt.video) await send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: opt.width, maxHeight: opt.height, everyNthFrame: 1 });
await sleep(opt.video ? 1500 : 200);

// The worker takes script step k on tic k + 1; Esc unpauses the page and starts the clock.
await send('Runtime.evaluate', { expression: `window.__belWorker.postMessage({ type: 'script', steps: ${JSON.stringify(steps)} })` });
const wallStart = performance.now();
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
const endTic = steps.length;
if (ticLog[ticLog.length - 1].tic < endTic) await new Promise((res) => { onTic = (t) => { if (t >= endTic) { onTic = null; res(); } }; });
const wall = (performance.now() - wallStart) / 1000;
const pageFps = (await send('Runtime.evaluate', { expression: `document.getElementById('fps').innerText + ' | ' + document.getElementById('tic').innerText`, returnByValue: true })).result.value;
await sleep(300);
if (opt.video) {
  await send('Page.stopScreencast');
  while (Date.now() - lastFrameAt < 300) await sleep(100);
}

const log = (await send('Runtime.evaluate', { expression: 'window.__belFrames', returnByValue: true })).result.value
  .filter(([, tic]) => tic <= endTic);
const span = (log[log.length - 1][0] - log[0][0]) / 1000;
const fps = (log.length - 1) / span;
const speed = (log[log.length - 1][1] - log[0][1]) / span;
const gaps = log.slice(1).map((f, i) => f[0] - log[i][0]).sort((a, b) => a - b);
const pct = (q) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))];
const mean = (i) => log.reduce((a, f) => a + f[i], 0) / log.length;
console.error(`doom-live: ${steps.length} tics, ${log.length} frames in ${wall.toFixed(1)} s: ${fps.toFixed(1)} fps presented, ` +
  `game speed ${speed.toFixed(1)} tics/s, frame time p50 ${pct(0.5).toFixed(0)} ms p95 ${pct(0.95).toFixed(0)} ms, ` +
  `${mean(2).toFixed(2)} tics/frame, step ${mean(3).toFixed(1)} ms + render ${mean(4).toFixed(1)} ms + write ${mean(5).toFixed(1)} ms per frame, ` +
  `${log[log.length - 1][6]} tics dropped (page: ${pageFps})`);
if (opt.video) {
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1] || f).t - f.t) || 1 / 30).toFixed(4)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
  fs.writeFileSync(path.join(tmp, 'list.txt'), list);
  const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'),
    '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', opt.out], { stdio: 'inherit' });
  if (enc.status !== 0) throw new Error('ffmpeg failed');
  console.error(`doom-live: wrote ${opt.out} (${frames.length} screencast frames over ${(frames[frames.length - 1].t - frames[0].t).toFixed(1)} s)`);
}
cleanup();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);

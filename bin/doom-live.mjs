#!/usr/bin/env node
// Real-time proof: plays the web page in headless Chromium, presses the keys of a doom-record script
// (one step per engine tic, synchronized to the frames the page receives), and screen-records it to MP4.
// Keys are dispatched as keyboard events inside the page the moment frame N arrives, so they reach the
// worker before it starts tic N+1 (driving them over DevTools adds a round trip that loses that race).
//   node bin/doom-live.mjs --script-file bin/demo-route.txt --out live.mp4 [--root DIR] [--hires]
//        [--port 8099] [--width 1100] [--height 800] [--tail 35] [--chrome chromium]
// Prints the measured live fps (engine tics per wall-clock second) and how many tics got different
// keys than scripted (key events race the worker's frame loop, so a few may land a tic late).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = { root: path.resolve(here, '..'), script: null, out: 'live.mp4', hires: false, port: 8099, width: 1100, height: 800, tail: 35, chrome: 'chromium' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => argv[++i];
  if (a === '--root') opt.root = path.resolve(v());
  else if (a === '--script') opt.script = v();
  else if (a === '--script-file') opt.script = fs.readFileSync(v(), 'utf8').replace(/#.*$/gm, '');
  else if (a === '--out') opt.out = v();
  else if (a === '--hires') opt.hires = true;
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
  const CODES = { w: 'KeyW', s: 'KeyS', a: 'KeyA', d: 'KeyD', q: 'KeyQ', e: 'KeyE', r: 'ShiftLeft', f: 'KeyF', u: 'KeyU' };
  let held = '';
  window.__belPress = (keys) => {
    for (const c of held) if (!keys.includes(c)) window.dispatchEvent(new KeyboardEvent('keyup', { code: CODES[c], key: c, bubbles: true }));
    for (const c of keys) if (!held.includes(c)) window.dispatchEvent(new KeyboardEvent('keydown', { code: CODES[c], key: c, bubbles: true }));
    held = keys;
  };
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'frame') {
          if (window.__belSchedule) window.__belPress(window.__belSchedule[e.data.tic] ?? '');
          window.__belFrame(JSON.stringify({ tic: e.data.tic, keys: e.data.keys || '' }));
        }
        if (e.data && e.data.type === 'init') window.__belFrame(JSON.stringify({ tic: 0, keys: '' }));
      });
    }
  };
}` });
const url = `http://127.0.0.1:${opt.port}/web/?paused=1${opt.hires ? '&hires=1' : ''}`;
console.error(`doom-live: loading ${url}`);
await send('Page.navigate', { url });

await new Promise((res) => { onTic = () => { onTic = null; res(); }; });
console.error(`doom-live: engine loaded (page started paused), recording ${steps.length} tics`);
await send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: opt.width, maxHeight: opt.height, everyNthFrame: 1 });
await sleep(1500);

// Frame k of the script runs as engine tic k + 1: hold its keys, press Esc to unpause; the page then
// presses each later step's keys when the previous tic's frame arrives.
const base = 0;
await send('Runtime.evaluate', { expression: `window.__belSchedule = ${JSON.stringify(steps)}; window.__belPress(window.__belSchedule[0]);` });
const wallStart = performance.now();
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
const endTic = base + steps.length;
if (ticLog[ticLog.length - 1].tic < endTic) await new Promise((res) => { onTic = (t) => { if (t >= endTic) { onTic = null; res(); } }; });
const wall = (performance.now() - wallStart) / 1000;
const pageFps = (await send('Runtime.evaluate', { expression: `document.getElementById('fps').innerText + ' | ' + document.getElementById('tic').innerText`, returnByValue: true })).result.value;
await sleep(300);
await send('Page.stopScreencast');
while (Date.now() - lastFrameAt < 300) await sleep(100);

const byTic = new Map(ticLog.map((x) => [x.tic, x.keys]));
const slipped = [];
for (let k = 0; k < steps.length; k++) if ((byTic.get(base + k + 1) ?? '') !== steps[k]) slipped.push(`tic ${k + 1}: ${byTic.get(base + k + 1) || '-'} not ${steps[k] || '-'}`);
const slips = slipped.length;
if (slips) console.error(`doom-live: key mismatches: ${slipped.slice(0, 8).join(', ')}${slips > 8 ? ', ...' : ''}`);
const live = ticLog.filter((x) => x.tic > base && x.tic <= endTic);
const fps = (live.length - 1) * 1000 / (live[live.length - 1].at - live[0].at);

const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1] || f).t - f.t) || 1 / 30).toFixed(4)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
fs.writeFileSync(path.join(tmp, 'list.txt'), list);
const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'),
  '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', opt.out], { stdio: 'inherit' });
if (enc.status !== 0) throw new Error('ffmpeg failed');
const duration = frames[frames.length - 1].t - frames[0].t;
console.error(`doom-live: ${steps.length} tics in ${wall.toFixed(1)} s wall = ${fps.toFixed(1)} fps live (page shows: ${pageFps}); ` +
  `${slips}/${steps.length} tics got different keys than scripted`);
console.error(`doom-live: wrote ${opt.out} (${frames.length} screencast frames over ${duration.toFixed(1)} s)`);
cleanup();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);

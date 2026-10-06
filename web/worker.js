// Runs the Bel interpreter and the Bel Doom engine off the main thread, and owns the game clock.
// main -> worker: {type:'start', wad, hires, res, tier, paused}, {type:'keys', keys}, {type:'pause', paused},
//                 {type:'script', steps}  (per-tic keys from now on, e.g. from bin/doom-live.mjs)
// worker -> main: {type:'status', text}, {type:'log', text}, {type:'init', w, h, palette, ms, split},
//                 {type:'frame', frame, tic, tics, sounds, keys, step, render, write, dropped, sentAt},
//                 {type:'script-done', tic}, {type:'error', text}
// With an engine that has doom-tick and doom-draw, the game runs at 35 tics per second of wall time:
// each loop runs the tics that are due (at most MAX_CATCHUP; older debt is dropped and counted), then
// draws one frame. Older engines get one doom-frame (one tic and one frame) per loop, at most 35 a second.
import { bootEngine, TIC_RATE } from './protocol.js';

const ROOT = new URL('../', import.meta.url);
const MAX_CATCHUP = 5;
const ORDER = 'wsadqerfu';
let keys = '';
let tapped = '';
let paused = false;
let script = null;
let scriptBase = 0;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const fail = (err) => post({ type: 'error', text: String((err && err.stack) || err) });

function readFile(path) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', new URL(path, ROOT).href, false);
  let binary = true;
  try { xhr.responseType = 'arraybuffer'; } catch { binary = false; xhr.overrideMimeType('text/plain; charset=x-user-defined'); }
  xhr.send();
  if (xhr.status === 404) return null;
  if (xhr.status !== 200) throw new Error(`readFile ${path}: HTTP ${xhr.status}`);
  if (binary) return new Uint8Array(xhr.response);
  const s = xhr.responseText, out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

let tic = 0;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'keys') { for (const c of m.keys) if (!keys.includes(c)) tapped += c; keys = m.keys; }
  else if (m.type === 'pause') paused = m.paused;
  else if (m.type === 'script') { script = m.steps; scriptBase = tic; }
  else if (m.type === 'start') { paused = !!m.paused; start(m).catch(fail); }
};

// Keys for the next tic: the script's step, or the held keys plus any tapped since the last tic.
function nextKeys() {
  if (script) {
    const k = script[tic - scriptBase];
    if (k !== undefined) return k;
    post({ type: 'script-done', tic });
    script = null;
  }
  const k = [...ORDER].filter((c) => keys.includes(c) || tapped.includes(c)).join('');
  tapped = '';
  return k;
}

async function start({ wad, hires, res, tier }) {
  post({ type: 'status', text: 'loading interpreter (interp/bel.js)' });
  const { Bel } = await import(new URL('interp/bel.js', ROOT).href);
  const eng = bootEngine({
    Bel, readFile, wad, hires, res, compile: tier === 'closure' ? false : undefined,
    status: (text) => post({ type: 'status', text }),
    log: (text) => { if (text) post({ type: 'log', text }); },
  });
  post({ type: 'init', w: eng.w, h: eng.h, palette: eng.palette, ms: eng.initMs, split: eng.split });
  const ticMs = 1000 / TIC_RATE;
  let base = null, dropped = 0;
  const loop = () => {
    try {
      if (paused) { base = null; return setTimeout(loop, 50); }
      const now = performance.now();
      if (base === null) base = now - tic * ticMs;
      const due = Math.floor((now - base) / ticMs) - tic;
      if (due <= 0) return setTimeout(loop, Math.max(1, base + (tic + 1) * ticMs - now));
      const limit = eng.split ? MAX_CATCHUP : 1;
      const n = Math.min(due, limit);
      if (due > n) { dropped += due - n; base += (due - n) * ticMs; }
      let step = 0, render = 0, write = 0, used = '', frame;
      const sounds = [];
      if (eng.split) {
        for (let i = 0; i < n; i++) {
          used = nextKeys();
          const t = eng.tick(used);
          step += t.ms;
          sounds.push(...t.sounds);
          tic = t.tic;
        }
        const d = eng.draw();
        frame = d.frame; render = d.renderMs; write = d.writeMs;
        sounds.push(...d.sounds);
      } else {
        used = nextKeys();
        const f = eng.frame(used);
        frame = f.frame; step = f.ms; tic = f.tic;
        sounds.push(...f.sounds);
      }
      post({ type: 'frame', frame, tic, tics: n, sounds, keys: used, step, render, write, dropped,
        sentAt: performance.timeOrigin + performance.now() }, [frame.buffer]);
      setTimeout(loop, 0);
    } catch (err) { fail(err); }
  };
  loop();
}

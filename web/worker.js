// Runs the Bel interpreter and the Bel Doom engine off the main thread.
// main -> worker: {type:'start', wad}, {type:'keys', keys}, {type:'pause', paused}
// worker -> main: {type:'status', text}, {type:'log', text}, {type:'init', w, h, palette, ms},
//                 {type:'frame', frame, ms, tic}, {type:'error', text}
import { bootEngine, TIC_RATE } from './protocol.js';

const ROOT = new URL('../', import.meta.url);
let keys = '';
let tapped = '';
let paused = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const fail = (err) => post({ type: 'error', text: String((err && err.stack) || err) });

function readFile(path) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', new URL(path, ROOT).href, false);
  let binary = true;
  try { xhr.responseType = 'arraybuffer'; } catch { binary = false; xhr.overrideMimeType('text/plain; charset=x-user-defined'); }
  xhr.send();
  if (xhr.status === 404) return null;
  if (xhr.status === 404) return null;
  if (xhr.status !== 200) throw new Error(`readFile ${path}: HTTP ${xhr.status}`);
  if (binary) return new Uint8Array(xhr.response);
  const s = xhr.responseText, out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'keys') { keys = m.keys; tapped += m.keys; }
  else if (m.type === 'pause') paused = m.paused;
  else if (m.type === 'start') start(m.wad).catch(fail);
};

async function start(wad) {
  post({ type: 'status', text: 'loading interpreter (interp/bel.js)' });
  const { Bel } = await import(new URL('interp/bel.js', ROOT).href);
  const eng = bootEngine({
    Bel, readFile, wad,
    status: (text) => post({ type: 'status', text }),
    log: (text) => { if (text) post({ type: 'log', text }); },
  });
  post({ type: 'init', w: eng.w, h: eng.h, palette: eng.palette, ms: eng.initMs });
  const step = () => {
    try {
      if (paused) return setTimeout(step, 50);
      const t = performance.now();
      const f = eng.frame([...'wsadqerfu'].filter((c) => keys.includes(c) || tapped.includes(c)).join(''));
      tapped = '';
      post({ type: 'frame', ...f }, [f.frame.buffer]);
      setTimeout(step, Math.max(0, 1000 / TIC_RATE - (performance.now() - t)));
    } catch (err) { fail(err); }
  };
  step();
}

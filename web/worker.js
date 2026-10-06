// One Bel interpreter running the Bel Doom engine. Several of these form the render pool (web/pool.js):
// each holds a full, replicated simulation and draws one vertical slice of every presented frame.
// The clock lives in the pool on the main thread; this worker only does what each message asks.
// pool -> worker: {type:'start', wad, hires, res, tier, cutSlices}
//                 {type:'run', gen, frame, from, keys: [per tic], x0, x1, sounds: bool}
//                   run one doom-tick per entry of keys (the engine must be at tic `from`), then draw columns
//                   x0..x1; on an engine without doom-tick, keys has one entry and a full doom-frame is drawn
// worker -> pool: {type:'status', text}, {type:'log', text}, {type:'error', text}
//                 {type:'init', w, h, palette, ms, split, sliceApi}
//                 {type:'slice', gen, frame, tic, x0, x1, data, sounds: [[names] per tic], step, render, write, digest}
//                   digest (every 35 tics) is the gameplay state, compared across workers for lockstep
import { bootEngine } from './protocol.js';

const ROOT = new URL('../', import.meta.url);
const DIGEST_EVERY = 35;
let eng = null;

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

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') start(m).catch(fail);
  else if (m.type === 'run') {
    try { run(m); } catch (err) { fail(err); }
  }
};

async function start({ wad, hires, res, tier, cutSlices }) {
  post({ type: 'status', text: 'loading interpreter (interp/bel.js)' });
  const { Bel } = await import(new URL('interp/bel.js', ROOT).href);
  eng = bootEngine({
    Bel, readFile, wad, hires, res, tier: tier || undefined, cutSlices,
    status: (text) => post({ type: 'status', text }),
    log: (text) => { if (text) post({ type: 'log', text }); },
  });
  post({ type: 'init', w: eng.w, h: eng.h, palette: eng.palette, ms: eng.initMs, split: eng.split, sliceApi: eng.sliceApi });
}

function run({ gen, frame, from, keys, x0, x1, sounds }) {
  if (eng.tic !== from) throw new Error(`desync: asked to run from tic ${from}, engine is at tic ${eng.tic}`);
  const heard = [];
  let step = 0, d;
  if (eng.split) {
    for (const k of keys) {
      const t = eng.tick(k);
      step += t.ms;
      heard.push(t.sounds);
    }
    d = eng.drawSlice(x0, x1);
  } else {
    const f = eng.frame(keys[0]);
    d = { frame: f.frame.slice(x0 * eng.h, (x1 + 1) * eng.h), sounds: f.sounds, renderMs: 0, writeMs: 0 };
    step = f.ms;
    heard.push([]);
  }
  heard[heard.length - 1].push(...d.sounds);
  const digest = Math.floor(eng.tic / DIGEST_EVERY) > Math.floor(from / DIGEST_EVERY) ? eng.digest() : null;
  post({ type: 'slice', gen, frame, tic: eng.tic, x0, x1, data: d.frame, sounds: sounds ? heard : null,
    step, render: d.renderMs, write: d.writeMs, digest }, [d.frame.buffer]);
}

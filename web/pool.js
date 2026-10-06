// The render pool and the game clock (main thread). N workers (web/worker.js) each hold the full engine
// and run the same tics with the same keys (replicated simulation); every presented frame is split into
// N column slices, one per worker, and stitched here. One clock: 35 tics per second of wall time, at most
// MAX_CATCHUP tics per presented frame (older debt is dropped and counted), at most `inflight` frames
// outstanding. Every 35 tics each worker sends a digest of the gameplay state; a mismatch, an error or a
// missed deadline drops the pool to one worker, which carries on with the full width.
import { TIC_RATE } from './protocol.js';

const ORDER = 'wsadqerfu';
const MAX_CATCHUP = 5;
const TIC_MS = 1000 / TIC_RATE;
const MIN_SLICE = 8;

// Workers for a screen size: one per 40,000 pixels (1 at 160x100, 2 at 320x200, 8 at 640x480), capped by
// cores and memory, since each worker holds a whole engine.
export function autoWorkers([w, h] = [160, 100]) {
  const cores = navigator.hardwareConcurrency || 2;
  const byMemory = navigator.deviceMemory ? Math.floor((navigator.deviceMemory * 1024 * 0.6) / 600) : 2;
  return Math.max(1, Math.min(cores - 2, 8, byMemory, Math.ceil((w * h) / 40000)));
}

// count: number of workers; auto: drop to one worker when the engine has no doom-draw-slice.
// on: { status(text), log(text), error(text), init(info), frame(f), note(text) }
export function createPool({ count, auto = false, start, paused: startPaused = false, on }) {
  const gen = 1;
  let workers = [];
  let info = null, W = 0, H = 0, density = null;
  let tic = 0, base = null, dropped = 0, frameId = 0, timer = null, stopped = false;
  let paused = startPaused, keys = '', tapped = '', script = null, scriptBase = 0;
  const pending = new Map();
  let avgFrameMs = 100, desyncs = 0, skew = -1;

  for (let i = 0; i < count; i++) {
    const w = { index: i, worker: new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), init: null, stats: null };
    w.worker.onmessage = (e) => message(w, e.data);
    w.worker.onerror = (e) => workerFailed(w, `worker ${i} failed: ${e.message || 'see console'}`);
    w.worker.postMessage({ type: 'start', ...start });
    workers.push(w);
  }

  function message(w, m) {
    if (!workers.includes(w)) return;
    if (m.type === 'status') { if (w === workers[0]) on.status(m.text); }
    else if (m.type === 'log') { if (w === workers[0]) on.log(m.text); }
    else if (m.type === 'error') workerFailed(w, m.text);
    else if (m.type === 'init') ready(w, m);
    else if (m.type === 'slice') slice(w, m);
  }

  function ready(w, m) {
    w.init = m;
    begin();
  }

  // Starts the game once every remaining worker has booted (also after a worker fails during boot).
  function begin() {
    if (info || !workers.every((x) => x.init)) return;
    info = workers[0].init;
    if (workers.length > 1 && (!info.split || (auto && !info.sliceApi))) {
      on.note(!info.split ? 'engine has no doom-tick: one worker' : 'engine has no doom-draw-slice: one worker');
      shrinkTo(workers[0]);
    }
    W = info.w; H = info.h;
    density = new Float64Array(W).fill(1);
    on.init({ ...info, workers: workers.length });
    if (!paused) schedule(0);
  }

  function shrinkTo(survivor) {
    for (const w of workers) if (w !== survivor) w.worker.terminate();
    workers = [survivor];
    pending.clear();
  }

  function fallback(reason, survivor) {
    on.note(`${reason}; continuing with one worker`);
    shrinkTo(survivor);
    if (!info) return begin();
    schedule(0);
  }

  function workerFailed(w, text) {
    if (stopped || !workers.includes(w)) return;
    const others = workers.filter((x) => x !== w);
    if (workers.length > 1) return fallback(`worker ${w.index}: ${text.split('\n')[0]}`, others.find((x) => x.init) || others[0]);
    stopped = true;
    on.error(text);
  }

  function nextKeys(t) {
    if (script) {
      const k = script[t - scriptBase];
      if (k !== undefined) return k;
      script = null;
      on.note(`script done at tic ${t}`);
    }
    const k = [...ORDER].filter((c) => keys.includes(c) || tapped.includes(c)).join('');
    tapped = '';
    return k;
  }

  // Column ranges for the workers: equal widths until the engine draws real slices, then split so each
  // slice has about the same measured render cost.
  function layout() {
    const n = workers.length;
    const bounds = [0];
    let total = 0, acc = 0, x = 0;
    for (let c = 0; c < W; c++) total += density[c];
    for (let i = 1; i < n; i++) {
      if (info.sliceApi) while (x < W && acc + density[x] <= (total * i) / n) acc += density[x++];
      else x = Math.round((W * i) / n);
      bounds.push(Math.min(W - (n - i) * MIN_SLICE, Math.max(bounds[i - 1] + MIN_SLICE, x)));
    }
    bounds.push(W);
    return bounds.slice(0, n).map((x0, i) => [x0, bounds[i + 1] - 1]);
  }

  function schedule(ms) {
    if (timer !== null || stopped) return;
    timer = setTimeout(() => { timer = null; loop(); }, Math.max(0, ms));
  }

  function loop() {
    if (paused || !info) { base = null; return; }
    if (pending.size >= (workers.length > 1 ? 2 : 1)) return;
    const now = performance.now();
    if (base === null) base = now - tic * TIC_MS;
    const due = Math.floor((now - base) / TIC_MS) - tic;
    if (due <= 0) return schedule(base + (tic + 1) * TIC_MS - now);
    const n = Math.min(due, info.split ? MAX_CATCHUP : 1);
    if (due > n) { dropped += due - n; base += (due - n) * TIC_MS; }
    const ks = [];
    for (let i = 0; i < n; i++) ks.push(nextKeys(tic + i));
    const id = ++frameId, from = tic, ranges = layout();
    tic += n;
    pending.set(id, { from, tic, tics: n, keys: ks[n - 1], slices: new Map(), sentAt: now, ranges });
    workers.forEach((w, i) => {
      const k = w.index === skew ? ks.map(() => 'a') : ks;
      w.worker.postMessage({ type: 'run', gen, frame: id, from, keys: k, x0: ranges[i][0], x1: ranges[i][1], sounds: i === 0 });
    });
    skew = -1;
    schedule(0);
  }

  function slice(w, m) {
    const f = pending.get(m.frame);
    if (m.gen !== gen || !f) return;
    f.slices.set(w, m);
    w.stats = { step: m.step, render: m.render, write: m.write, x0: m.x0, x1: m.x1 };
    if (f.slices.size < workers.length) return;
    complete(m.frame, f);
  }

  function complete(id, f) {
    const all = workers.map((w) => f.slices.get(w));
    const digests = all.map((s) => s.digest).filter(Boolean);
    if (digests.length && digests.some((d) => d !== digests[0])) {
      desyncs++;
      on.log(`lockstep mismatch at tic ${f.tic}:\n${digests.join('\n')}`);
      fallback(`workers disagree at tic ${f.tic}`, workers[0]);
      return;
    }
    pending.delete(id);
    for (const k of pending.keys()) if (k < id) pending.delete(k);
    const frame = new Uint8Array(W * H);
    for (const s of all) frame.set(s.data, s.x0 * H);
    if (info.sliceApi) for (const s of all) {
      const per = s.render / (s.x1 - s.x0 + 1);
      for (let x = s.x0; x <= s.x1; x++) density[x] = 0.75 * density[x] + 0.25 * per;
    }
    const took = performance.now() - f.sentAt;
    avgFrameMs = 0.9 * avgFrameMs + 0.1 * took;
    const max = (k) => Math.max(...all.map((s) => s[k]));
    on.frame({
      frame, tic: f.tic, tics: f.tics, keys: f.keys, sounds: all[0].sounds || [], dropped, desyncs,
      step: max('step'), render: max('render'), write: max('write'), took,
      workers: workers.map((w) => ({ index: w.index, ...w.stats })),
    });
    schedule(0);
  }

  setInterval(() => {
    if (stopped || workers.length < 2) return;
    const now = performance.now(), limit = Math.max(2000, 8 * avgFrameMs);
    for (const f of pending.values()) {
      if (now - f.sentAt < limit) continue;
      const late = workers.filter((w) => !f.slices.has(w));
      const survivor = workers.find((w) => f.slices.has(w));
      if (survivor) fallback(`worker ${late.map((w) => w.index).join(', ')} missed the ${Math.round(limit)} ms deadline`, survivor);
      return;
    }
  }, 200);

  return {
    setKeys(k) { for (const c of k) if (!keys.includes(c)) tapped += c; keys = k; },
    pause(p) { paused = p; if (!p) schedule(0); },
    script(steps) { script = steps; scriptBase = tic; },
    get workers() { return workers.length; },
    // Fault injection for tests: give worker i different keys for one frame (lockstep mismatch),
    // stop worker i without telling the pool (missed deadline), or make it run an extra tic (desync error).
    debug: {
      skewKeys(i) { skew = i; },
      silence(i) { workers.find((w) => w.index === i)?.worker.terminate(); },
      extraTic(i) { workers.find((w) => w.index === i)?.worker.postMessage({ type: 'run', gen, frame: -1, from: tic, keys: [''], x0: 0, x1: 0, sounds: false }); },
    },
  };
}

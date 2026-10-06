// Frame protocol decoding shared by the browser worker, bin/doom-term.mjs and bin/doom-record.mjs.
// Engine output (see CONTRACT.md): 'P' + 768 palette bytes once at init, 'F' + w*h column-major
// palette indices once per doom-frame. Anything else the engine prints is passed through as text.

export const TIC_RATE = 35;

export function findPacket(out, tag, size) {
  const code = tag.charCodeAt(0);
  const last = out.length - size - 1;
  if (last < 0) return -1;
  if (out[last] === code) return last;
  for (let i = 0; i <= last; i++) if (out[i] === code) return i;
  return -1;
}

export function splitPacket(out, tag, size) {
  const at = findPacket(out, tag, size);
  if (at < 0) return { data: null, text: latin1(out) };
  return {
    data: out.slice(at + 1, at + 1 + size),
    text: latin1(out.subarray(0, at)) + latin1(out.subarray(at + 1 + size)),
  };
}

// Sound packets: 'S' + lump name + '\n', written before the F packet. Returns the names and the leftover text.
export function splitSounds(text) {
  const sounds = [];
  const rest = text.replace(/(?<![A-Z0-9_])S([A-Z0-9_\[\]-]{1,8})\n/g, (_, name) => { sounds.push(name); return ''; });
  return { sounds, text: rest };
}

export function parseWad(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getInt32(4, true), dir = dv.getInt32(8, true);
  const lumps = new Map();
  for (let i = 0; i < n; i++) {
    const e = dir + i * 16, pos = dv.getInt32(e, true), size = dv.getInt32(e + 4, true);
    const name = latin1(bytes.subarray(e + 8, e + 16)).replace(/\0.*$/s, '');
    lumps.set(name, bytes.subarray(pos, pos + size));
  }
  return lumps;
}

// DMX format-3 sound lump -> { rate, samples: Float32Array in [-1, 1) }. Strips the 16-byte
// pads at each end when present (id's lumps repeat the edge sample there; Freedoom's often have none).
export function decodeDmx(lump) {
  if (lump.length < 8) return null;
  const dv = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  if (dv.getUint16(0, true) !== 3) return null;
  const rate = dv.getUint16(2, true);
  let pcm = lump.subarray(8, 8 + Math.min(dv.getUint32(4, true), lump.length - 8));
  const flat = (a, b) => pcm.subarray(a, b).every((v) => v === pcm[a]);
  if (pcm.length > 48 && flat(0, 16) && flat(pcm.length - 16, pcm.length)) pcm = pcm.subarray(16, pcm.length - 16);
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] - 128) / 128;
  return { rate, samples };
}

export function loadSounds(wadBytes) {
  const sounds = new Map();
  for (const [name, lump] of parseWad(wadBytes)) {
    const s = decodeDmx(lump);
    if (s) sounds.set(name, s);
  }
  return sounds;
}

// Required parameters of a Bel closure (lit clo env parms body); (o x) optionals and a rest tail don't count.
// The functional engine's (doom-frame world keys) takes the world doom-init returned and returns the next one.
function requiredParams(bel, f) {
  const pair = (x) => x !== null && typeof x === 'object' && 'a' in x && 'd' in x;
  if (!pair(f)) return 0;
  let p = f;
  for (let i = 0; i < 3 && pair(p); i++) p = p.d;
  if (!pair(p)) return 0;
  let n = 0;
  for (let q = p.a; pair(q); q = q.d) if (!(pair(q.a) && q.a.a === bel.sym('o'))) n++;
  return n;
}

// Boots the interpreter and engine; returns the screen size, palette and a frame(keys) stepper.
export function bootEngine({ Bel, readFile, wad = 'wad/e1m1.wad', hires = false, status = () => {}, log = () => {} }) {
  const t0 = performance.now();
  status('booting Bel (evaluating bel.bel)');
  const bel = new Bel({ readFile });
  status('loading doom/main.bel');
  bel.loadFile('doom/main.bel');
  if (hires) bel.evalString('(set-resolution 320 200)');
  log(latin1(bel.takeOutput()));
  status(`doom-init: loading and parsing ${wad}`);
  const functional = requiredParams(bel, bel.global('doom-frame')) >= 2;
  let world = bel.call('doom-init', wad);
  const init = splitPacket(bel.takeOutput(), 'P', 768);
  log(init.text);
  if (!init.data) throw new Error('doom-init wrote no P (palette) packet');
  const w = bel.evalString('screen-w'), h = bel.evalString('screen-h');
  if (!(w > 0 && h > 0)) throw new Error(`bad screen size ${w}x${h}`);
  const n = w * h;
  let tic = 0;
  return {
    bel, w, h, palette: init.data, initMs: performance.now() - t0, functional,
    frame(keys) {
      const t = performance.now();
      if (functional) world = bel.call('doom-frame', world, keys);
      else bel.call('doom-frame', keys);
      const out = bel.takeOutput();
      const ms = performance.now() - t;
      const f = splitPacket(out, 'F', n);
      if (!f.data) { log(f.text); throw new Error(`doom-frame wrote no F packet of ${n} bytes (got ${out.length} bytes)`); }
      const s = splitSounds(f.text);
      log(s.text);
      return { frame: f.data, ms, tic: ++tic, sounds: s.sounds };
    },
  };
}

export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

export function displaySize(w, h, scale) {
  const dw = w * scale;
  return [dw, Math.round(dw * 3 / 4)];
}

export function paletteRGBA32(pal) {
  const p32 = new Uint32Array(256);
  const bytes = new Uint8Array(p32.buffer);
  for (let i = 0; i < 256; i++) {
    bytes[i * 4] = pal[i * 3];
    bytes[i * 4 + 1] = pal[i * 3 + 1];
    bytes[i * 4 + 2] = pal[i * 3 + 2];
    bytes[i * 4 + 3] = 255;
  }
  return p32;
}

export function columnsToRows(frame, w, h, out = new Uint8Array(w * h)) {
  for (let x = 0; x < w; x++) {
    const col = x * h;
    for (let y = 0; y < h; y++) out[y * w + x] = frame[col + y];
  }
  return out;
}

export function scaleIndexed(rows, w, h, dw, dh, out = new Uint8Array(dw * dh)) {
  const xs = new Int32Array(dw);
  for (let x = 0; x < dw; x++) xs[x] = Math.min(w - 1, Math.floor((x + 0.5) * w / dw));
  for (let y = 0; y < dh; y++) {
    const src = Math.min(h - 1, Math.floor((y + 0.5) * h / dh)) * w;
    const dst = y * dw;
    for (let x = 0; x < dw; x++) out[dst + x] = rows[src + xs[x]];
  }
  return out;
}

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

// Boots the interpreter and engine; returns the screen size, palette and a frame(keys) stepper.
export function bootEngine({ Bel, readFile, wad = 'wad/e1m1.wad', status = () => {}, log = () => {} }) {
  const t0 = performance.now();
  status('booting Bel (evaluating bel.bel)');
  const bel = new Bel({ readFile });
  status('loading doom/main.bel');
  bel.loadFile('doom/main.bel');
  log(latin1(bel.takeOutput()));
  status(`doom-init: loading and parsing ${wad}`);
  bel.call('doom-init', wad);
  const init = splitPacket(bel.takeOutput(), 'P', 768);
  log(init.text);
  if (!init.data) throw new Error('doom-init wrote no P (palette) packet');
  const w = bel.evalString('screen-w'), h = bel.evalString('screen-h');
  if (!(w > 0 && h > 0)) throw new Error(`bad screen size ${w}x${h}`);
  const n = w * h;
  let tic = 0;
  return {
    bel, w, h, palette: init.data, initMs: performance.now() - t0,
    frame(keys) {
      const t = performance.now();
      bel.call('doom-frame', keys);
      const out = bel.takeOutput();
      const ms = performance.now() - t;
      const f = splitPacket(out, 'F', n);
      log(f.text);
      if (!f.data) throw new Error(`doom-frame wrote no F packet of ${n} bytes (got ${out.length} bytes)`);
      return { frame: f.data, ms, tic: ++tic };
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

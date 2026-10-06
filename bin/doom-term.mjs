#!/usr/bin/env node
// Terminal Doom player: runs the Bel engine in Node and draws truecolor half-block frames.
// Usage: node bin/doom-term.mjs [--wad wad/e1m1.wad] [--root DIR] [--frames N] [--keys KEYS] [--hold MS] [--first-hold MS]
// Keys: WASD/arrows move, Q/E or Alt+left/right strafe, F fire, Space/U use, R toggles run
// (Shift+letter/arrow also runs), Esc or Ctrl-C quits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = { root: path.resolve(here, '..'), wad: 'wad/e1m1.wad', frames: Infinity, keys: null, hold: 150, firstHold: 400 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => argv[++i];
  if (a === '--root') opt.root = path.resolve(v());
  else if (a === '--wad') opt.wad = v();
  else if (a === '--frames') opt.frames = Number(v());
  else if (a === '--keys') opt.keys = v();
  else if (a === '--hold') opt.hold = Number(v());
  else if (a === '--first-hold') opt.firstHold = Number(v());
  else { console.error('usage: node bin/doom-term.mjs [--wad PATH] [--root DIR] [--frames N] [--keys KEYS] [--hold MS] [--first-hold MS]'); process.exit(2); }
}

const { bootEngine, paletteRGBA32, columnsToRows, scaleIndexed, TIC_RATE } = await import(pathToFileURL(path.join(here, '../web/protocol.js')).href);
const { Bel } = await import(pathToFileURL(path.join(opt.root, 'interp/bel.js')).href);

const out = process.stdout, inp = process.stdin;
const tty = out.isTTY && inp.isTTY;
const logs = [];
const eng = bootEngine({
  Bel,
  readFile: (p) => { const f = path.join(opt.root, p); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; },
  wad: opt.wad,
  status: (s) => process.stderr.write(`bel-doom: ${s}\n`),
  log: (s) => { if (s) { for (const l of s.split('\n')) if (l.trim()) logs.push(l); while (logs.length > 50) logs.shift(); } },
});
const { w, h } = eng;
process.stderr.write(`bel-doom: ready in ${(eng.initMs / 1000).toFixed(1)} s, screen ${w}x${h}\n`);
const pal = eng.palette;

let dw, dh, left, prevRows = [];
function layout() {
  const cols = out.columns || w, rows = (out.rows || 61) - 1;
  dw = Math.max(8, Math.min(cols, Math.floor(rows * 2 * 4 / 3), 2 * w));
  dh = Math.round(dw * 3 / 4 / 2) * 2;
  left = Math.max(0, Math.floor((cols - dw) / 2));
  prevRows = [];
  if (tty) out.write('\x1b[2J');
}
layout();

const RESET = '\x1b[0m\x1b[?25h\x1b[?1049l';
let restored = !tty;
function restore() {
  if (restored) return;
  restored = true;
  out.write(RESET);
  try { inp.setRawMode(false); } catch {}
}
process.on('exit', restore);
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });
if (tty) {
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  out.on('resize', layout);
}

const pressed = new Map();
let alwaysRun = false, quit = false;
function press(letter, run) {
  const now = performance.now(), cur = pressed.get(letter);
  const held = cur && now < cur.until;
  pressed.set(letter, { until: now + (held ? opt.hold : opt.firstHold), seen: false });
  if (run) pressed.set('r', { until: now + (held ? opt.hold : opt.firstHold), seen: false });
}
const ARROW = { A: 'w', B: 's', C: 'd', D: 'a' };
const STRAFE = { C: 'e', D: 'q' };
function onData(buf) {
  const s = buf.toString('latin1');
  if (s === '\x1b') { quit = true; return; }
  const re = /\x1b\[1;(\d)([A-D])|\x1b\x1b\[([A-D])|\x1b[[O]([A-D])|\x1b(.)|([\s\S])/g;
  for (let m; (m = re.exec(s));) {
    if (m[2]) {
      const mod = Number(m[1]) - 1, alt = mod & 2, shift = mod & 1;
      press(alt && STRAFE[m[2]] ? STRAFE[m[2]] : ARROW[m[2]], shift);
    } else if (m[3]) press(STRAFE[m[3]] || ARROW[m[3]], false);
    else if (m[4]) press(ARROW[m[4]], false);
    else {
      const c = m[5] || m[6];
      if (c === '\x03' || c === '\x04') { quit = true; return; }
      const lc = c.toLowerCase(), shift = c !== lc;
      if (lc === 'r') alwaysRun = !alwaysRun;
      else if ('wasdqefu'.includes(lc)) press(lc, shift);
      else if (c === ' ') press('u', false);
      else if (c === ',') press('q', false);
      else if (c === '.') press('e', false);
    }
  }
}
if (tty) { inp.setRawMode(true); inp.resume(); inp.on('data', onData); }

function heldKeys() {
  if (opt.keys !== null) return opt.keys;
  const now = performance.now();
  let k = '';
  for (const c of 'wsadqerfu') {
    const p = pressed.get(c);
    if (c === 'r' && alwaysRun) { k += c; continue; }
    if (p && (now < p.until || !p.seen)) { k += c; p.seen = true; }
  }
  return k;
}

const rgb = [];
for (let i = 0; i < 256; i++) rgb.push(`${pal[i * 3]};${pal[i * 3 + 1]};${pal[i * 3 + 2]}`);
let rows = new Uint8Array(w * h), scaled = new Uint8Array(0);
function render(frame) {
  columnsToRows(frame, w, h, rows);
  if (scaled.length !== dw * dh) scaled = new Uint8Array(dw * dh);
  scaleIndexed(rows, w, h, dw, dh, scaled);
  let s = '';
  for (let r = 0; r < dh / 2; r++) {
    let line = '', fg = -1, bg = -1;
    const top = r * 2 * dw, bot = top + dw;
    for (let x = 0; x < dw; x++) {
      const t = scaled[top + x], b = scaled[bot + x];
      if (t !== fg) { line += `\x1b[38;2;${rgb[t]}m`; fg = t; }
      if (b !== bg) { line += `\x1b[48;2;${rgb[b]}m`; bg = b; }
      line += '\u2580';
    }
    if (line !== prevRows[r]) { s += `\x1b[${r + 1};${left + 1}H${line}\x1b[0m`; prevRows[r] = line; }
  }
  return s;
}

let frames = 0, totalMs = 0;
const stamps = [];
function loop() {
  if (quit || frames >= opt.frames) return finish();
  const t = performance.now();
  const keys = heldKeys();
  const f = eng.frame(keys);
  frames++; totalMs += f.ms;
  stamps.push(t); while (stamps.length > 1 && t - stamps[0] > 2000) stamps.shift();
  const fps = stamps.length > 1 ? (stamps.length - 1) * 1000 / (t - stamps[0]) : 0;
  const status = ` BEL DOOM  fps ${fps.toFixed(1)}  ${f.ms.toFixed(0)} ms/frame  tic ${f.tic}  keys [${keys.padEnd(4)}]${alwaysRun ? '  RUN' : ''}  ` +
    `WASD/arrows Q/E F fire Space use R run Esc quit  ${logs.length ? '| ' + logs[logs.length - 1].slice(0, 40) : ''}`;
  out.write(render(f.frame) + `\x1b[${dh / 2 + 1};1H\x1b[0;1;37;41m${status.slice(0, out.columns || 200)}\x1b[0m\x1b[K`);
  setTimeout(loop, Math.max(0, 1000 / TIC_RATE - (performance.now() - t)));
}
function finish() {
  restore();
  console.error(`bel-doom: ${frames} frames, avg ${(totalMs / Math.max(1, frames)).toFixed(1)} ms/frame in Bel`);
  process.exit(0);
}
loop();

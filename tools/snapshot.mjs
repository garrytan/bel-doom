#!/usr/bin/env node
// Run the Bel Doom engine headless and write the last frame as a PNG.
//
//   node tools/snapshot.mjs [--hires] [--keys "w"]... [--tics N] [--out out.png] [--scale S]
//
// --keys sets the held keys for the following --tics tics, and can repeat:
//   node tools/snapshot.mjs --keys "" --tics 1 --keys w --tics 10 --keys a --tics 5
// --eval EXPR evaluates a Bel expression at that point (e.g. to teleport the player).
// It also prints init time and per-frame timings, so it doubles as a benchmark.
import { Bel } from '../interp/bel.js';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let out = 'snapshot.png', scale = 4, keys = '', plan = [], every = 0, hires = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') out = args[++i];
  else if (a === '--scale') scale = +args[++i];
  else if (a === '--keys') keys = args[++i];
  else if (a === '--tics') plan.push([keys, +args[++i]]);
  else if (a === '--every') every = +args[++i];
  else if (a === '--hires') hires = true;
  else if (a === '--eval') plan.push([null, args[++i]]);
  else throw new Error('unknown argument ' + a);
}
if (!plan.some(([k]) => k !== null)) plan.push([keys, 1]);

const bel = new Bel({
  readFile: (p) => new Uint8Array(fs.readFileSync(path.isAbsolute(p) ? p : path.join(root, p))),
});
let t0 = performance.now();
bel.loadFile('doom/main.bel');
if (hires) bel.evalString('(set-resolution 320 200)');
bel.call('doom-init', 'wad/e1m1.wad');
const init = bel.takeOutput();
console.log(`init ${(performance.now() - t0).toFixed(0)} ms`);
if (init[0] !== 80 || init.length !== 769) throw new Error('bad palette packet');
const pal = init.subarray(1);
const w = bel.global('screen-w'), h = bel.global('screen-h');

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(file, frame) {
  const W = w * scale, H = h * scale;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const i = frame[Math.floor(x / scale) * h + Math.floor(y / scale)];
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = pal[i * 3]; raw[o + 1] = pal[i * 3 + 1]; raw[o + 2] = pal[i * 3 + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

let frame = null, n = 0, total = 0;
const sounds = {};
const times = [];
for (const [k, tics] of plan) {
  if (k === null) { console.log(tics, '=>', bel.print(bel.evalString(tics))); continue; }
  for (let i = 0; i < tics; i++) {
    const t = performance.now();
    bel.call('doom-frame', k);
    const dt = performance.now() - t;
    times.push(dt); total += dt; n++;
    const pkt = bel.takeOutput();
    let p = 0;
    while (pkt[p] === 83) {                      // S name \n: sound packets
      const e = pkt.indexOf(10, p);
      sounds[String.fromCharCode(...pkt.subarray(p + 1, e))] = (sounds[String.fromCharCode(...pkt.subarray(p + 1, e))] || 0) + 1;
      p = e + 1;
    }
    if (pkt[p] !== 70 || pkt.length !== p + w * h + 1) throw new Error('bad frame packet ' + pkt.length);
    frame = pkt.subarray(p + 1);
    if (every && n % every === 0) writePng(out.replace(/\.png$/, `-${String(n).padStart(4, '0')}.png`), frame);
  }
}
writePng(out, frame);
const sorted = [...times].sort((a, b) => a - b);
console.log(`${n} frames, avg ${(total / n).toFixed(1)} ms (${(1000 * n / total).toFixed(1)} fps), ` +
  `median ${sorted[n >> 1].toFixed(1)} ms, max ${sorted[n - 1].toFixed(1)} ms -> ${out}`);
if (Object.keys(sounds).length) console.log('sounds', JSON.stringify(sounds));
console.log('player', bel.print(bel.evalString('(list px py pangle health armor ammo)')));

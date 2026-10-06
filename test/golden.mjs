#!/usr/bin/env node
// Golden test: replays scripted scenes on the engine and hashes every output byte (P, S and F packets) per scene.
//   node test/golden.mjs                 check lo (160x100), hi (320x200) and lo under BEL_NOCOMPILE=1 against
//                                        test/golden-hashes.json
//   node test/golden.mjs --update        rewrite the expected hashes (BEL_NOCOMPILE must still agree with lo)
//   node test/golden.mjs --modes lo,640x480 [--png DIR] [--update] [--root DIR (engine + interpreter to test)]
// Modes: lo, hi, WxH (needs doom-init to take a width and height), each with an optional "-nocompile" suffix.
// Each mode runs in its own process (one Bel per JS realm) with a 7.8 MB stack; scenes start from the same
// immutable world returned by doom-init. --png writes each scene's last frame as DIR/<mode>-<scene>.png.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let root = path.resolve(here, '..');
const HASHES = path.join(here, 'golden-hashes.json');
const PI = 3.141592653589793;

// Each scene: optional world edits (key/value pairs for the engine's puts), then KEYS:TICS steps.
const SCENES = [
  ['walk', [], 'w:12 a:4 f:6 d:4'],
  ['fence-west', [['pangle', PI]], '-:2'],
  ['fence-east', [['px', 960], ['py', 200], ['pangle', 0]], 'w:2'],
  ['combat', [['px', 580], ['py', 256], ['pangle', 0.435]], 'f:72 -:10'],
  ['door', [['px', 832], ['py', 470], ['pangle', PI / 2]], 'u:1 -:24 f:8 -:6'],
  ['barrels', [['px', 832], ['py', 616], ['pangle', 0]], 'f:48 -:12'],
  ['pickup', [['px', 700], ['py', 672], ['pangle', PI]], 'w:14 -:2'],
  ['pain-tint', [['pain-tics', 6]], '-:3'],
  ['bonus-tint', [['bonus-tics', 6]], '-:3'],
  ['death-respawn', [['health', 0]], '-:34 u:1 -:3'],
];

const argv = process.argv.slice(2);
const opt = { child: null, modes: ['lo', 'hi', 'lo-nocompile'], update: false, png: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--child') opt.child = argv[++i];
  else if (a === '--modes') opt.modes = argv[++i].split(',');
  else if (a === '--update') opt.update = true;
  else if (a === '--png') opt.png = path.resolve(argv[++i]);
  else if (a === '--root') root = path.resolve(argv[++i]);
  else { console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(2); }
}

if (opt.child) await runChild(opt.child);
else await runParent();

async function runChild(mode) {
  const base = mode.replace(/-nocompile$/, '');
  const { Bel } = await import(pathToFileURL(path.join(root, 'interp/bel.js')).href);
  const { columnsToRows, splitPacket, splitSounds } = await import(pathToFileURL(path.join(root, 'web/protocol.js')).href);
  const bel = new Bel({ readFile: (p) => { const f = path.join(root, p); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; } });
  bel.loadFile('doom/main.bel');
  const dims = base === 'lo' ? null : base === 'hi' ? [320, 200] : base.split('x').map(Number);
  const t0 = performance.now();
  let w0;
  if (dims && paramCount(bel, bel.global('doom-init')) >= 3) w0 = bel.call('doom-init', 'wad/e1m1.wad', dims[0], dims[1]);
  else if (base === 'hi') { bel.loadFile('doom/hires.bel'); w0 = bel.call('doom-init', 'wad/e1m1.wad'); }
  else if (dims) throw new Error(`mode ${mode}: doom-init does not take a width and height yet`);
  else w0 = bel.call('doom-init', 'wad/e1m1.wad');
  const initOut = bel.takeOutput();
  let [W, H] = dims || [160, 100];
  const result = { mode, tier: bel.tier, size: `${W}x${H}`, initMs: Math.round(performance.now() - t0), scenes: { init: sha(initOut) } };
  const pal = initOut.subarray(initOut.indexOf(80) + 1, initOut.indexOf(80) + 769);
  let frames = 0, ms = 0;
  for (const [name, edits, script] of SCENES) {
    let w = edits.length ? bel.call('puts', w0, ...edits.flatMap(([k, v]) => [bel.sym(k), v])) : w0;
    const h = crypto.createHash('sha256');
    const sounds = {};
    let last = null;
    for (const keys of expand(script)) {
      const t = performance.now();
      w = bel.call('doom-frame', w, keys);
      ms += performance.now() - t;
      frames++;
      last = bel.takeOutput();
      h.update(last);
      let at = 0;
      while (last[at] === 83) at = last.indexOf(10, at) + 1;
      if (last[at] !== 70 || last.length - at - 1 !== W * H) throw new Error(`${mode} ${name}: expected one ${W}x${H} F packet after the S packets`);
      for (const snd of splitSounds(splitPacket(last, 'F', W * H).text).sounds) sounds[snd] = (sounds[snd] || 0) + 1;
    }
    result.scenes[name] = h.digest('hex').slice(0, 32);
    (result.sounds ||= {})[name] = sounds;
    if (opt.png) {
      const n = W * H, f = last.subarray(last.length - n);
      fs.mkdirSync(opt.png, { recursive: true });
      fs.writeFileSync(path.join(opt.png, `${base}-${name}.png`), png(columnsToRows(f, W, H), W, H, pal));
    }
  }
  result.frames = frames;
  result.msPerFrame = +(ms / frames).toFixed(1);
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function runParent() {
  const t0 = performance.now();
  const results = await Promise.all(opt.modes.map((mode) => new Promise((res, rej) => {
    const args = ['--stack-size=7800', fileURLToPath(import.meta.url), '--child', mode, '--root', root, ...(opt.png ? ['--png', opt.png] : [])];
    const env = { ...process.env };
    if (mode.endsWith('-nocompile')) env.BEL_NOCOMPILE = '1'; else delete env.BEL_NOCOMPILE;
    const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`mode ${mode} exited ${code}`))));
  })));
  const expected = fs.existsSync(HASHES) ? JSON.parse(fs.readFileSync(HASHES, 'utf8')) : {};
  if (opt.update) for (const r of results) if (!r.mode.endsWith('-nocompile')) expected[r.mode] = r.scenes;
  let failures = 0;
  for (const r of results) {
    const want = expected[r.mode.replace(/-nocompile$/, '')];
    const bad = want ? Object.keys(r.scenes).filter((s) => r.scenes[s] !== want[s]) : [];
    const status = !want ? 'NO EXPECTED HASHES' : bad.length ? `FAIL (${bad.join(', ')})` : opt.update && !r.mode.endsWith('-nocompile') ? 'recorded' : 'ok';
    failures += want ? bad.length : 1;
    console.log(`${r.mode.padEnd(16)} ${r.size.padEnd(8)} init ${String(r.initMs).padStart(5)} ms, ${r.frames} frames at ${r.msPerFrame} ms  ${status} (tier ${r.tier})`);
  }
  if (opt.update) {
    if (!failures) fs.writeFileSync(HASHES, JSON.stringify(expected, null, 2) + '\n');
    console.log(failures ? 'not updating test/golden-hashes.json' : 'wrote test/golden-hashes.json');
  }
  console.log(`${failures ? 'FAIL' : 'PASS'}: ${SCENES.length + 1} scenes x ${results.length} modes in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(failures ? 1 : 0);
}

function expand(script) {
  return script.split(/\s+/).filter(Boolean).flatMap((s) => { const [k, n] = s.split(':'); return Array(+n).fill(k === '-' ? '' : k); });
}

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32); }

// Parameters of a Bel closure (lit clo env parms body), optionals included.
function paramCount(bel, f) {
  const pair = (x) => x !== null && typeof x === 'object' && 'a' in x && 'd' in x;
  let p = f;
  for (let i = 0; i < 3 && pair(p); i++) p = p.d;
  let n = 0;
  if (pair(p)) for (let q = p.a; pair(q); q = q.d) n++;
  return n;
}

function png(idx, w, h, pal) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(idx.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(pal)),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

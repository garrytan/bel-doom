#!/usr/bin/env node
// Slice equality test: (doom-draw-slice w x0 x1) must write exactly the bytes of columns x0..x1 of
// (doom-draw w).  Replays the golden scenes; at every --every'th tic it draws the full frame, then
// draws it again as stitched slices for several partitions (1, 2, 3 and 7 slices, uneven fixed
// boundaries, and a fresh random partition each time) and compares byte for byte.
//   node test/slices.mjs [--modes lo,hi,640x480] [--every N] [--seed S] [--root DIR]
// Each mode runs in its own process (one Bel per JS realm) with a 7.8 MB stack.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let root = path.resolve(here, '..');
const PI = 3.141592653589793;

// The golden scenes (test/golden.mjs): world edits, then KEYS:TICS steps.  Fences overlap sprites in
// combat and door; fence-west and fence-east look straight at fences; the tints and the weapon
// cross every slice boundary.
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
const opt = { child: null, modes: ['lo', 'hi'], every: 3, seed: 1 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--child') opt.child = argv[++i];
  else if (a === '--modes') opt.modes = argv[++i].split(',');
  else if (a === '--every') opt.every = +argv[++i];
  else if (a === '--seed') opt.seed = +argv[++i];
  else if (a === '--root') root = path.resolve(argv[++i]);
  else { console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 6).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(2); }
}

if (opt.child) await runChild(opt.child);
else await runParent();

function expand(script) {
  return script.split(/\s+/).filter(Boolean).flatMap((s) => { const [k, n] = s.split(':'); return Array(+n).fill(k === '-' ? '' : k); });
}

// Slice boundaries [[x0, x1], ...] covering 0..W-1.
function partition(W, cuts) {
  const xs = [...new Set(cuts.filter((c) => c > 0 && c < W))].sort((a, b) => a - b);
  const parts = [];
  let x0 = 0;
  for (const c of [...xs, W]) { parts.push([x0, c - 1]); x0 = c; }
  return parts;
}

async function runChild(mode) {
  const { Bel } = await import(pathToFileURL(path.join(root, 'interp/bel.js')).href);
  const bel = new Bel({ readFile: (p) => { const f = path.join(root, p); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; } });
  bel.loadFile('doom/main.bel');
  const [W, H] = mode === 'lo' ? [160, 100] : mode === 'hi' ? [320, 200] : mode.split('x').map(Number);
  const w0 = bel.call('doom-init', 'wad/e1m1.wad', W, H);
  bel.takeOutput();
  let seed = opt.seed;
  const rnd = (n) => { seed = (seed * 16807) % 2147483647; return seed % n; };
  const fixed = [
    ['1 slice', partition(W, [])],
    ['2 slices', partition(W, [W >> 1])],
    ['3 uneven', partition(W, [1, Math.floor(W * 0.71)])],
    ['7 uneven', partition(W, [3, 17, 40, Math.floor(W / 2), Math.floor(W / 2) + 1, W - 9])],
  ];
  const frameOf = (out) => { if (out[0] !== 70) throw new Error('expected an F packet'); return out.subarray(1); };
  let checks = 0, frames = 0, slices = 0;
  const failures = [];
  for (const [name, edits, script] of SCENES) {
    let w = edits.length ? bel.call('puts', w0, ...edits.flatMap(([k, v]) => [bel.sym(k), v])) : w0;
    let tic = 0;
    for (const keys of expand(script)) {
      w = bel.call('doom-tick', w, keys);
      bel.takeOutput();
      if (tic++ % opt.every) continue;
      bel.call('doom-draw', w);
      const full = frameOf(bel.takeOutput());
      if (full.length !== W * H) throw new Error(`${mode} ${name}: frame of ${full.length} bytes`);
      frames++;
      const random = partition(W, Array.from({ length: 1 + rnd(9) }, () => rnd(W)));
      for (const [label, parts] of [...fixed, ['random ' + random.length, random]]) {
        const stitched = Buffer.concat(parts.map(([x0, x1]) => {
          bel.call('doom-draw-slice', w, x0, x1);
          const s = frameOf(bel.takeOutput());
          if (s.length !== (x1 - x0 + 1) * H) throw new Error(`${mode} ${name}: slice ${x0}..${x1} has ${s.length} bytes`);
          slices++;
          return Buffer.from(s);
        }));
        checks++;
        if (!stitched.equals(Buffer.from(full))) {
          let i = 0;
          while (stitched[i] === full[i]) i++;
          failures.push(`${name} tic ${tic - 1} ${label} [${parts.map((p) => p.join('-')).join(' ')}]: first difference at column ${Math.floor(i / H)} row ${i % H}`);
        }
      }
    }
  }
  process.stdout.write(JSON.stringify({ mode, size: `${W}x${H}`, frames, checks, slices, failures }) + '\n');
}

async function runParent() {
  const t0 = performance.now();
  const results = await Promise.all(opt.modes.map((mode) => new Promise((res, rej) => {
    const args = ['--stack-size=7800', fileURLToPath(import.meta.url), '--child', mode, '--root', root,
      '--every', String(opt.every), '--seed', String(opt.seed)];
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`mode ${mode} exited ${code}`))));
  })));
  let bad = 0;
  for (const r of results) {
    bad += r.failures.length;
    console.log(`${r.mode.padEnd(8)} ${r.size.padEnd(8)} ${r.frames} frames, ${r.checks} partitions, ${r.slices} slices: ${r.failures.length ? 'FAIL' : 'ok'}`);
    for (const f of r.failures.slice(0, 10)) console.log('  ' + f);
  }
  console.log(`${bad ? 'FAIL' : 'PASS'}: slices stitch to the full frame in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(bad ? 1 : 0);
}

// Renders the same world twice, once with the interpreter's jets and once with
// bel.bel's own definitions, and checks the frames are identical. Only the
// number jets stay native, because this interpreter's numbers are IEEE doubles
// rather than bel.bel's list representation, which its arithmetic expects.
import '../bin/bigstack.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Bel } from '../interp/bel.js';

const NUMBER_JETS = ['+', '-', '*', '/', 'inc', 'dec', '<', '>', '<=', '>=', 'number', 'real', 'int', 'whole',
  'pint', 'abs', 'floor', 'ceil', 'round', 'mod', 'even', 'odd', 'max', 'min', 'rand', 'charn', 'nchar',
  'inv', 'recip', 'rpart', 'ipart'];

const bel = new Bel({ readFile: (p) => (fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null) });
bel.loadFile('doom/main.bel');
let w = bel.call('doom-init', 'wad/e1m1.wad');
bel.takeOutput();
for (const k of ['w', 'w', 'w', 'wd', 'wd', 'f']) w = bel.call('step', w, k);

function frameHash(frame) {
  const h = crypto.createHash('sha256');
  for (const col of bel.toArray(frame)) h.update(Buffer.from(bel.toArray(col).map((c) => c.c)));
  return h.digest('hex').slice(0, 16);
}

let t = performance.now();
const on = frameHash(bel.call('render', w));
const msOn = performance.now() - t;
const switched = bel.setJets(false, NUMBER_JETS);
t = performance.now();
const off = frameHash(bel.call('render', w));
const msOff = performance.now() - t;
bel.setJets(true);
console.log(`jets on:  ${on}  (${msOn.toFixed(0)} ms)`);
console.log(`jets off: ${off}  (${(msOff / 1000).toFixed(1)} s, ${switched.length} jets replaced by bel.bel's definitions)`);
if (on !== off) { console.log('FAIL: frames differ'); process.exit(1); }
console.log(`identical (tier ${bel.tier})`);

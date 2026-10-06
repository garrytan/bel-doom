#!/usr/bin/env node
// Checks doom/*.bel for the functional style the engine is written in:
// no assignment or mutation, no looping macros, no randomness, and square
// brackets only for one-argument functions that use _.
// Allowed: top-level definitions (a set at column 0), and I/O at the edges
// (prc/rdc/ops/cls are reported as information, not as violations).
import fs from 'node:fs';
import path from 'node:path';

const MUTATION = ['set', 'xar', 'xdr', 'push', 'pop', '++', '--', 'zap', 'pull', 'pushnew', 'wipe', 'swap', 'clean', 'atomic'];
const LOOPS = ['while', 'for', 'repeat', 'loop', 'til', 'each', 'whilet', 'accum', 'nof', 'drain', 'poll'];
const RANDOM = ['coin', 'rand'];
const IO = ['prc', 'rdc', 'peek', 'ops', 'cls', 'wrb', 'rdb', 'pr', 'prn', 'print'];

function strip(line) {
  // drop comments and string/char contents so tokens inside them don't count
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') { i++; out += '  '; continue; }
      if (c === '"') { inStr = false; out += '"'; continue; }
      out += ' ';
      continue;
    }
    if (c === '\\') { out += '  '; i++; continue; }
    if (c === '"') { inStr = true; out += '"'; continue; }
    if (c === ';') break;
    out += c;
  }
  return out;
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync('doom').filter((f) => f.endsWith('.bel')).map((f) => path.join('doom', f));

let violations = 0;
const io = {};
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map(strip);
  lines.forEach((line, i) => {
    const re = /\(([^\s()[\]'`,"]+)/g;
    let m;
    while ((m = re.exec(line))) {
      const op = m[1];
      const where = `${file}:${i + 1}`;
      if (op === 'set' && m.index === 0) continue;
      if (MUTATION.includes(op)) { violations++; console.log(`${where}  mutation  (${op} ...)`); }
      else if (LOOPS.includes(op)) { violations++; console.log(`${where}  loop      (${op} ...)`); }
      else if (RANDOM.includes(op)) { violations++; console.log(`${where}  random    (${op} ...)`); }
      else if (IO.includes(op)) io[op] = (io[op] || []).concat(where);
    }
  });
  // brackets: every [ ... ] must mention _
  const text = lines.join('\n');
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') stack.push(i);
    else if (text[i] === ']' && stack.length) {
      const start = stack.pop();
      const body = text.slice(start + 1, i);
      if (!/(^|[\s()[\]'`,])_($|[\s()[\]'`,])/.test(body)) {
        violations++;
        const line = text.slice(0, start).split('\n').length;
        console.log(`${file}:${line}  bracket   [${body.replace(/\s+/g, ' ').slice(0, 40)}] has no _`);
      }
    }
  }
}
for (const [op, wheres] of Object.entries(io)) console.log(`io: ${op} at ${wheres.join(', ')}`);
console.log(violations ? `${violations} violations` : 'clean: no mutation, loops, randomness or bracket misuse');
process.exit(violations ? 1 : 0);

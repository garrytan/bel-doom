#!/usr/bin/env node
// Bel command line: node bin/bel.mjs [-e EXPR]... [file.bel]...   (no args: REPL)
import './bigstack.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Bel, BelError } from '../interp/bel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const belSource = fs.readFileSync(path.join(here, '../interp/bel.bel'), 'utf8');
const bel = new Bel({
  belSource,
  readFile: (p) => (fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null),
  writeFile: (p, bytes) => fs.writeFileSync(p, bytes),
  stdout: (bytes) => process.stdout.write(bytes),
  stdin: () => {
    const b = Buffer.alloc(1);
    try {
      return fs.readSync(0, b, 0, 1, null) === 1 ? b[0] : -1;
    } catch {
      return -1;
    }
  },
});

function run(thunk) {
  try {
    return thunk();
  } catch (e) {
    bel.flush();
    if (e instanceof BelError) console.error(e.message);
    else if (e instanceof RangeError) console.error('Bel error: stack overflow');
    else throw e;
    process.exitCode = 1;
    return undefined;
  }
}

const args = process.argv.slice(2);
let did = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-e') {
    const v = run(() => bel.evalString(args[++i]));
    if (v !== undefined) console.log(bel.print(v));
  } else {
    run(() => bel.loadFile(args[i]));
  }
  did = true;
}

if (!did) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let buf = '';
  rl.prompt();
  rl.on('line', (line) => {
    buf += line + '\n';
    let depth = 0, inStr = false, esc = false;
    for (const c of buf) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      else if (!inStr && (c === '(' || c === '[')) depth++;
      else if (!inStr && (c === ')' || c === ']')) depth--;
    }
    if (depth > 0 || inStr) return;
    const src = buf;
    buf = '';
    if (src.trim()) {
      const v = run(() => bel.evalString(src));
      if (v !== undefined) console.log(bel.print(v));
    }
    rl.prompt();
  });
}

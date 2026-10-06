import fs from 'node:fs';
import { Bel } from '../interp/bel.js';
const bel = new Bel({ readFile: (p) => (fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null) });
bel.loadFile('test/bench.bel');
for (const [label, src] of [['fib 22', '(fib 22)'], ['for loop 1e6', '(loop1 1000000)'], ['nth 1e5 on 4096 list', '(nthsum 100000)']]) {
  const t = performance.now();
  const v = bel.evalString(src);
  console.log(label, bel.print(v), (performance.now() - t).toFixed(0) + 'ms');
}

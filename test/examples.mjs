// The REPL session from Paul Graham's belexamples.txt, run against this interpreter.
// Numeric results differ only where Bel's exact rationals meet IEEE doubles (noted).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bel } from '../interp/bel.js';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bel-'));
const bel = new Bel({
  readFile: (p) => { const f = p.startsWith('/') || p.startsWith('interp') ? p : path.join(tmp, p); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; },
  writeFile: (p, b) => fs.writeFileSync(path.join(tmp, p), b),
});
const session = [
  ["(cons 'a 'b '(c d e))", '(a b c d e)'],
  ['(cons \\h "ello")', '"hello"'],
  ["(2 '(a b c))", 'b'],
  ["(set w '(a (b c) d (e f)))", '(a (b c) d (e f))'],
  ['(find pair w)', '(b c)'],
  ['(pop (find pair w))', 'b'],
  ['w', '(a (c) d (e f))'],
  ['(dedup:sort < "abracadabra")', '"abcdr"'],
  ['(+ .05 19/20)', '1'],
  ['(map (upon 2 3) (list + - * /))', '(5 -1 6 0.6666666666666666)'],
  ["(let x 'a (cons x 'b))", '(a . b)'],
  ['(with (x 1 y 2) (+ x y))', '3'],
  ["(let ((x y) . z) '((a b) c) (list x y z))", '(a b (c))'],
  ["((fn (x) (cons x 'b)) 'a)", '(a . b)'],
  ["((fn (x|symbol) (cons x 'b)) 'a)", '(a . b)'],
  ["((fn (x|int) (cons x 'b)) 'a)", 'Error: mistype'],
  ["((fn (f x|f) (cons x 'b)) sym 'a)", '(a . b)'],
  ['((macro (v) `(set ,v 7)) x)', '7'],
  ['x', '7'],
  ['(let m (macro (x) (sym (append (nom x) "ness"))) (set (m good) 10))', '10'],
  ['goodness', '10'],
  ["(apply or '(t nil))", 't'],
  ["(best (of > len) '((a b) (a b c d) (a) (a b c)))", '(a b c d)'],
  ['(!3 (part + 2))', '5'],
  ['(to "testfile" (print \'hello))', 'nil'],
  ['(from "testfile" (read))', 'hello'],
  ['(set y (table))', '(lit tab)'],
  ['(set y!a 1 y!b 2)', '2'],
  ["(map y '(a b))", '(1 2)'],
  ["(map ++:y '(a b))", '(2 3)'],
  ['y!b', '3'],
  ["(set z (array '(2 2) 0))", '(lit arr (lit arr 0 0) (lit arr 0 0))'],
  ['(z 1 1)', '0'],
  ['(for x 1 2 (for y 1 2 (set (z x y) (+ (* x 10) y))))', 'nil'],
  ['(z 1 1)', '11'],
  ['(swap (z 1) (z 2))', '(lit arr 11 12)'],
  ['(z 1 1)', '21'],
];
let pass = 0;
for (const [src, want] of session) {
  let got;
  try { got = bel.print(bel.evalString(src)); } catch (e) { got = 'Error: ' + (e.value ? bel.print(e.value) : e.message); }
  if (got === want) pass++;
  else console.log('FAIL', src, '\n  got ', got, '\n  want', want);
}
console.log(`${pass}/${session.length} belexamples.txt results match (tier ${bel.tier})`);
if (pass !== session.length) process.exit(1);

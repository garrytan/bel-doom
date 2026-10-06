// The reflection matrix: Bel programs that look at or change closures,
// environments, code and global definitions while compiled code is running.
// Every case runs in its own process under each tier; the tree-walking
// evaluator (ev) is the oracle, and the other tiers must print the same value,
// error message and output for every step. A few cases also pin ev's answer.
// Functions are called $HOT times (default 100) before the reflective step so
// tiers that compile only hot code have compiled them.
//
//   node test/reflect.mjs                      all cases on ev, closure, js
//   node test/reflect.mjs --tiers ev,closure --only dyn --hot 300 --verbose
//
// Also measures the deepest non-tail recursion each tier survives on Node's
// default stack; js must reach at least --depth-ratio (default 0.8) of closure (V8's tiering makes these numbers move by ~15% between runs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const HOT = Number(opt('--hot', 100));

const NUMBER_JETS = ['+', '-', '*', '/', 'inc', 'dec', '<', '>', '<=', '>=', 'number', 'real', 'int', 'whole',
  'pint', 'abs', 'floor', 'ceil', 'round', 'mod', 'even', 'odd', 'max', 'min', 'rand', 'charn', 'nchar',
  'inv', 'recip', 'rpart', 'ipart'];

// Each case: steps are top-level forms evaluated in order; `want` pins ev's
// printed result of the last step (a string) or of several steps (an array,
// null = unchecked); `xfail` maps a tier to the reason a mismatch is known.
const CASES = [
  // ---------------------------------------------------------------- environments
  { name: 'env: spine xar through a closure list (cold)',
    steps: ["((fn (x) (let (f g) (list (fn () x) (fn () x)) (xar (car (cddr f)) (cons 'x 9)) (list x (f) (g)))) 7)"],
    want: '(9 9 9)' },
  { name: 'env: spine xar through a closure list (hot)',
    steps: ["(def r-spine (x) (let (f g) (list (fn () x) (fn () x)) (xar (car (cddr f)) (cons 'x 9)) (list x (f) (g))))",
      '(hot-run $HOT (fn () (r-spine 7)))'],
    want: '(9 9 9)' },
  { name: 'env: xdr on a captured cell',
    steps: ['(def r-cell (x) (let f (fn () x) (xdr (car (car (cddr f))) (+ x 2)) (list x (f))))',
      '(hot-run $HOT (fn () (r-cell 7)))'],
    want: '(9 9)' },
  { name: 'env: xdr cuts the spine under the enclosing function',
    steps: ["(set rgx 'global)",
      '(def r-cut (rgx b) (let f (fn () (list rgx b)) (xdr (car (cddr f)) nil) (list (f) rgx b)))',
      '(hot-run $HOT (fn () (r-cut 1 2)))'],
    want: [null, null, '((global 2) global 2)'] },
  { name: 'env: sibling closures share cells and one alist by id',
    steps: ['(def r-sibset (x) (let (f g) (list (fn () x) (fn (v) (set x v))) (g (+ x 1)) (list x (f))))',
      '(def r-sibid (x) (let fs (list (fn () x) (fn () x)) (list (id (car (cddr (car fs))) (car (cddr (cadr fs)))) (id (car (cddr (car fs))) (cdr scope)))))',
      '(def r-envtail (x) (let y 2 (let f (fn () y) (id (car (cddr f)) (cdr scope)))))',
      "(def r-mapenv (l) (let fs (map (fn (y) (fn () y)) l) (list (map [_] fs) (id (car (cddr (car fs))) (car (cddr (cadr fs)))))))",
      '(hot-run $HOT (fn () (list (r-sibset 1) (r-sibid 1) (r-envtail 1) (r-mapenv (list 1 2)))))'],
    want: [null, null, null, null, '((2 2) (t t) t ((1 2) nil))'] },
  { name: 'env: xar and xdr through scope',
    steps: ['(def r-scope (x) (xdr (car scope) 42) x)',
      "(def r-scope2 (x y) (xar scope (cons 'y 'new)) (list x y))",
      '(def r-scopelen (x (o y x)) (len scope))',
      '(def r-scopevar (scope) scope)',
      '(hot-run $HOT (fn () (list (r-scope 1) (r-scope2 1 2) (r-scopelen 1) (r-scopevar 5))))'],
    want: [null, null, null, null, '(42 (1 new) 2 5)'] },
  { name: 'env: scope exposed through a macro',
    steps: ["(mac expose () 'scope)",
      '(def r-expose (x y) (expose))',
      '(def r-expose2 (x) (let y 2 (map car (expose))))',
      '(def r-expose3 (x) (xdr (car (expose)) 5) x)',
      '(hot-run $HOT (fn () (list (r-expose 1 2) (r-expose2 1) (r-expose3 1))))'],
    want: [null, null, null, null, '(((y . 2) (x . 1)) (y x) 5)'] },
  { name: 'env: globe cells',
    steps: ['(set r-gv 1)',
      "(def r-globe (v) (let c (find [id (car _) 'r-gv] globe) (xdr c v) r-gv))",
      "(hot-run 10 (fn () (r-globe 'via-globe)))", 'r-gv'],
    want: [null, null, 'via-globe', 'via-globe'] },
  { name: 'env: for binds a fresh cell per iteration (hot)',
    steps: ['(def r-for () (let r nil (for i 1 3 (push (fn () i) r)) (map [_] r)))',
      '(def r-for2 () (let r nil (for i 1 10 (push i r) (set i (+ i 1))) r))',
      '(hot-run $HOT (fn () (list (r-for) (r-for2))))'],
    want: [null, null, '((3 2 1) (9 7 5 3 1))'] },

  // ---------------------------------------------------------------- closures as data
  { name: 'closure: printing',
    steps: ['(def r-mk (x) (fn (y) (+ x y)))',
      '(def r-mk2 (x) (fn (y) (prn y) (+ x y)))',
      '(def r-mk3 (x) (let z 2 (fn () z)))',
      '(hot-run $HOT (fn () (r-mk 1)))', '(r-mk2 1)', '(r-mk3 1)', '((r-mk2 1) 5)'],
    want: [null, null, null, '(lit clo ((x . 1)) (y) (+ x y))', '(lit clo ((x . 1)) (y) (do (prn y) (+ x y)))',
      '(lit clo ((z . 2) (x . 1)) nil z)', '6'] },
  { name: 'closure: = and id',
    steps: ['(def r-mk (x) (fn (y) (+ x y)))',
      '(hot-run $HOT (fn () (list (= (r-mk 1) (r-mk 1)) (id (r-mk 1) (r-mk 1)) (= (r-mk 1) (r-mk 2)) (let f (r-mk 1) (id f f)))))'],
    want: [null, '(t nil nil t)'] },
  { name: 'closure: rfn closure is cyclic data',
    steps: ['(def r-rf (k) (rfn self (n) (if (= n 0) k (self (- n 1)))))',
      "(hot-run $HOT (fn () (let f (r-rf 'done) (list (f 3) (car (car (car (cddr f)))) (id f (cdr (car (car (cddr f)))))))))",
      "(r-rf 'x)"],
    want: [null, '(done self t)', null] },
  { name: 'closure: called out of data structures',
    steps: ['(def r-data (n) (list ((car (list (fn (x) (* x 3)))) n) ((cadr (list 1 [+ _ n])) 1) (map (fn (f) (f n)) (list inc dec [* _ _]))))',
      '(hot-run $HOT (fn () (r-data 4)))'],
    want: [null, '(12 5 (5 3 16))'] },

  // ---------------------------------------------------------------- shared code
  { name: 'code: one quasiquoted body pair under two binders',
    steps: ["(mac r-mk2 () (let b '(list a b) `(list (fn (a b) ,b) (fn (b a) ,b))))",
      '(def r-two () (let (f g) (r-mk2) (list (f 1 2) (g 1 2) (id (car (cddr (cddr f))) (car (cddr (cddr g)))))))',
      '(hot-run $HOT (fn () (r-two)))'],
    want: [null, null, '((1 2) (2 1) t)'] },
  { name: 'code: shared body pair at different nesting depths',
    steps: ["(mac r-mk3 () (let b '(+ a 1) `(list (fn (a) ,b) (fn (z) (let a (* z 10) ,b)) (fn (q a) ,b))))",
      '(def r-three () (let (f g h) (r-mk3) (list (f 1) (g 2) (h 100 5))))',
      '(hot-run $HOT (fn () (r-three)))'],
    want: [null, null, '(2 21 6)'] },
  { name: 'code: hand-built closures sharing one body',
    steps: ["(set r-body '(list a b))",
      "(set r-c1 (list 'lit 'clo nil '(a b) r-body))",
      "(set r-c2 (list 'lit 'clo (list (cons 'b 'env-b)) '(a) r-body))",
      '(hot-run $HOT (fn () (list (r-c1 1 2) (r-c2 3))))'],
    want: [null, null, null, '((1 2) (3 env-b))'] },
  { name: 'code: mutating a quoted constant is seen by later calls',
    steps: ["(def r-qc () '(a b))", '(hot-run $HOT (fn () (r-qc)))', "(xar (r-qc) 'z)", '(r-qc)'],
    want: [null, '(a b)', null, '(z b)'] },

  // ---------------------------------------------------------------- parameters
  { name: 'parms: (o x default) using earlier parameters',
    steps: ['(def r-opt (x (o y (+ x 1)) (o z (list x y))) (list x y z))',
      '(def r-optc (x (o f (fn () x))) (set x 9) (f))',
      '(def r-opts (x (o s scope)) (map car s))',
      "(def r-optd ((a (o b 'dflt)) (o c a)) (list a b c))",
      "(hot-run $HOT (fn () (list (r-opt 1) (r-opt 1 5) (r-opt 1 5 6) (r-optc 1) (r-opts 1) (r-optd '(1)) (r-optd '(1 2) 3))))"],
    want: [null, null, null, null, '((1 2 (1 2)) (1 5 (1 5)) (1 5 6) 9 (x) (1 dflt 1) (1 2 3))'] },
  { name: 'parms: (t x f) typed parameters',
    steps: ["(def r-typed (x|int (o y|symbol 'q)) (list x y))",
      "(def r-typedp (f x|f) (cons x 'b))",
      '(def r-typed3 ((t (a b) pair)) (list b a))',
      "(def r-typedl (lim) (let small (fn (n) (< n lim)) ((fn (x|small) (list 'ok x)) 3)))",
      "(hot-run $HOT (fn () (list (r-typed 1) (r-typed 2 'z) (r-typedp symbol 'a) (r-typed3 '(1 2)) (r-typedl 5))))",
      "(r-typed 'a)", '(r-typed 1 2)', "(r-typedp int 'a)", "(r-typed3 'x)", '(r-typedl 2)'],
    want: [null, null, null, null, '((1 q) (2 z) (a . b) (2 1) (ok 3))', null, null, null, null, null] },
  { name: 'parms: rest and destructuring',
    steps: ['(def r-rest (a . rest) (list a rest))', '(def r-rest2 args args)',
      '(def r-dest ((a (b c)) . d) (list a b c d))',
      "(hot-run $HOT (fn () (list (r-rest 1) (r-rest 1 2 3) (r-rest2) (r-rest2 1 2) (r-dest '(1 (2 3)) 4 5))))"],
    want: [null, null, null, '((1 nil) (1 (2 3)) nil (1 2) (1 2 3 (4 5)))'] },
  { name: 'parms: uvar parameters from letu-based macros',
    steps: ['(def r-do1 (x) (do1 (car x) (xar x (quote changed))))',
      "(def r-catch (n) (catch (if (> n 2) (throw (list 'big n)) 'small)))",
      '(def r-push (x) (let l nil (push x l) (push (+ x 1) l) (pull x l) l))',
      '(def r-zap (l) (zap + (car l) 10) l)',
      "(def r-check (x) (check x int 'not-int))",
      "(hot-run $HOT (fn () (list (r-do1 (list 'orig 2)) (r-catch 1) (r-catch 5) (r-push 1) (r-zap (list 1 2)) (r-check 3) (r-check 'a))))"],
    want: [null, null, null, null, null, '(orig small (big 5) (2) (11 2) 3 not-int)'] },
  { name: 'parms: hand-built uvar closures and macros',
    steps: ['(set r-v (uvar))',
      "(set r-uc (list 'lit 'clo nil (list r-v) (list 'list r-v r-v)))",
      '(mac r-mku (e) (letu v `((fn (,v) (list ,v ,e)) 1)))',
      '(def r-umu (x) (r-mku (+ x 1)))',
      '(mac r-cap (e) (letu v `(let ,v ,e (list (fn () ,v) (fn (n) (set ,v n))))))',
      '(def r-ucap (x) (let (get put) (r-cap (* x 2)) (let before (get) (put 7) (list before (get)))))',
      '(hot-run $HOT (fn () (list (r-uc 5) (r-umu 5) (r-ucap 4))))'],
    want: [null, null, null, null, null, null, '((5 5) (1 6) (8 7))'] },

  // ---------------------------------------------------------------- errors and handlers
  { name: 'err: resumable handler, value becomes the result',
    steps: ['(def r-err (x) (dyn err (fn (e) 42) (+ 1 (car x))))',
      "(def r-err2 (x) (dyn err (fn (e) (list 'h e)) (list (+ 1 x) (car x) (cdr x) (< x 1) (nth x '(a b)))))",
      '(def r-err3 () (dyn err (fn (e) 7) (+ 1 r-undefined-q)))',
      "(def r-err4 () (dyn err (fn (e) e) (list (car 'a) r-undefined-z (err 'mine))))",
      "(hot-run $HOT (fn () (list (r-err '(1)) (r-err 'a) (r-err2 1) (r-err2 'a) (r-err3) (r-err4))))"],
    want: [null, null, null, null, null] },
  { name: 'err: resumable handler on an arity error',
    steps: ['(def r-e2 (a b) (list a b))',
      "(def r-err5 () (dyn err (fn (e) 'resumed) (r-e2 1)))",
      '(hot-run $HOT (fn () (r-err5)))'] },
  { name: 'err: eif, onerr, safe in compiled code',
    steps: ["(def r-eif (x) (eif e (car x) (list 'caught e) (list 'ok e)))",
      "(def r-onerr (x) (list (onerr 'bad (+ x 1)) (safe (car x))))",
      "(hot-run $HOT (fn () (list (r-eif '(1)) (r-eif 'a) (r-onerr 1) (r-onerr 'a))))"],
    want: [null, null, '((ok 1) (caught car-on-atom) (2 nil) (bad nil))'] },
  { name: 'err: same value and message for arity errors',
    steps: ['(def r-e2 (a b) (list a b))', '(hot-run $HOT (fn () (r-e2 1 2)))',
      '(r-e2 1)', '(r-e2 1 2 3)', '(r-e2)', '(apply r-e2 (list 1))',
      '(map r-e2 (list 1))'],
    want: [null, '(1 2)', 'ERR Bel error: underargs (binding parameters (a b))', 'ERR Bel error: overargs (binding parameters (a b))', null, null, null] },
  { name: 'err: same value and message for destructuring errors',
    steps: ['(def r-ed ((a b) c) (list a b c))', "(hot-run $HOT (fn () (r-ed '(1 2) 3)))",
      "(r-ed '(1) 2)", "(r-ed 'x 2)", "(r-ed '(1 2 3) 4)", "(r-ed '(1 2))"] },
  { name: 'err: same value and message for typed parameters',
    steps: ['(def r-et (x|int) x)', '(def r-et2 (f x|f) x)', '(hot-run $HOT (fn () (list (r-et 1) (r-et2 even 2))))',
      "(r-et 'a)", '(r-et2 even 3)', '(r-et 1.5)'],
    want: [null, null, '(1 2)', 'ERR Bel error: mistype (binding parameters ((t x int)))', null, null] },
  { name: 'err: same value and message for unbound variables',
    steps: ['(def r-eu () (+ 1 r-no-such-var))', '(def r-eu2 (x) (r-no-such-fn x))',
      '(def r-eu3 (x) (if x 1 r-no-such-var2))',
      '(hot-run $HOT (fn () (r-eu3 t)))', '(r-eu)', '(r-eu2 1)', '(r-eu3 nil)'],
    want: [null, null, null, '1', 'ERR Bel error: (unboundb r-no-such-var)', null, null] },
  { name: 'err: same value and message for primitive, jet and apply errors',
    steps: ['(def r-ec (x) (car x))', '(def r-ex (x) (xar x 1))', '(def r-eplus (x) (+ x 1))',
      '(def r-ediv (x) (/ 1 x))', '(def r-eap (f) (f 1))', '(def r-ejet (l) (map (fn (x) (car x)) l))',
      "(def r-eerr (x) (err x))",
      "(hot-run $HOT (fn () (list (r-ec '(1)) (r-ex (list 0)) (r-eplus 1) (r-ediv 2) (r-eap inc) (r-ejet '((1))))))",
      "(r-ec 'a)", "(r-ex 'a)", "(r-eplus 'a)", '(r-ediv 0)', "(r-eap 'a)", "(r-eap '(1 2))", "(r-eap '(lit foo))",
      '(r-eap (fn () 1))', "(r-ejet '(1))", "(r-eerr 'custom)", "(r-eerr '(a b))", '(ccc (fn (k) (k 1 2)))',
      "(r-eap 5)", "((fn (nil) 1) 2)"] },
  { name: 'err: destructuring let/with/withs error messages in compiled code',
    steps: ['(def r-eld (l) (let (a b) l (list a b)))', '(def r-ewd (l) (with ((a b) l) (list a b)))',
      '(def r-ewsd (l) (withs ((a b) l c a) (list a b c)))',
      "(hot-run $HOT (fn () (list (r-eld '(1 2)) (r-ewd '(1 2)) (r-ewsd '(1 2)))))",
      "(r-eld '(1))", "(r-eld '(1 2 3))", "(r-eld 'x)", "(r-ewd '(1))", "(r-ewsd '(1 2 3))"],
    xfail: { closure: 'closure tier binds let/with/withs patterns with bindPat, which adds "(binding parameters ...)" to the message; ev calls pass without it' } },
  { name: 'err: binding context left over from a caught arity error',
    steps: ['(def r-e2 (a b) (list a b))', "(def r-catcharity () (onerr 'x (r-e2 1 2 3)))",
      '(hot-run $HOT (fn () (r-catcharity)))', "(+ 1 'a)", "(r-catcharity)", "(car 'a)", "(r-catcharity)", "((fn (x) (+ x 1)) 'a)"],
    want: [null, null, 'x', 'ERR Bel error: mistype', 'x', 'ERR Bel error: car-on-atom', 'x', 'ERR Bel error: mistype'] },

  // ---------------------------------------------------------------- dyn
  { name: 'dyn: of a variable captured by an existing closure',
    steps: ['(def r-dyn (x) (let f (fn () x) (list (f) (dyn x 99 (f)) (f))))',
      '(hot-run $HOT (fn () (r-dyn 1)))'],
    want: [null, '(1 99 1)'] },
  { name: 'dyn: first dynamic binding of a global after compiled code read it',
    steps: ['(set rlate 1)', '(def r-late () (list rlate (+ rlate 1)))',
      '(hot-run $HOT (fn () (r-late)))', '(dyn rlate 5 (r-late))', '(r-late)',
      '(hot-run $HOT (fn () (dyn rlate 7 (r-late))))'],
    want: [null, null, '(1 2)', '(5 6)', '(1 2)', '(7 8)'] },
  { name: 'dyn: first dynamic binding of a lexical variable name',
    steps: ['(def r-ldyn (rlv) (let f (fn () rlv) (list rlv (f))))',
      '(hot-run $HOT (fn () (r-ldyn 1)))', "(dyn rlv 'dyn (r-ldyn 1))", '(r-ldyn 2)'],
    want: [null, '(1 1)', '(dyn dyn)', '(2 2)'] },
  { name: 'dyn: set inside dyn, closures made inside dyn',
    steps: ["(set rds 'g rdc 'glob)",
      '(def r-dset () (list (dyn rds 1 (do (set rds 2) rds)) rds))',
      '(def r-dclo () (let f (dyn rdc 3 (fn () rdc)) (list (f) (dyn rdc 4 (f)))))',
      '(hot-run $HOT (fn () (list (r-dset) (r-dclo))))'],
    want: [null, null, null, '((2 g) (glob 4))'] },

  // ---------------------------------------------------------------- macros
  { name: 'mac: redefinition after the call site has run',
    steps: ['(mac rm1 (x) `(+ ,x 1))', '(def r-mac (y) (rm1 y))',
      '(hot-run $HOT (fn () (r-mac 1)))', '(mac rm1 (x) `(* ,x 10))', '(r-mac 1)',
      '(hot-run $HOT (fn () (r-mac 2)))'],
    want: [null, null, '2', null, '10', '20'] },
  { name: 'mac: function becomes a macro and back',
    steps: ["(def rfm (x) (list 'fn x))", '(def r-use (y) (rfm y))',
      '(hot-run $HOT (fn () (r-use 3)))', "(mac rfm (x) `(list 'mac ',x))", '(r-use 3)',
      "(def rfm (x) (list 'fn2 x))", '(r-use 3)'],
    want: [null, null, '(fn 3)', null, '(mac y)', null, '(fn2 3)'] },
  { name: 'mac: native core macro redefined at run time',
    steps: ["(def r-unless (x) (unless x 'no))", '(hot-run $HOT (fn () (r-unless nil)))',
      "(mac unless (c . body) `(list 'mine ,c))", '(r-unless nil)', '(hot-run $HOT (fn () (r-unless 1)))'],
    want: [null, 'no', null, '(mine nil)', '(mine 1)'] },
  { name: 'mac: core macro names and special forms bound as variables',
    steps: ['(def r-shadow (when) (when 1 2))', '(def r-fnshadow (fn) (fn 3))',
      '(def r-shq (quote) (quote 5))', '(def r-shif (if) (if nil 1 2))',
      '(hot-run $HOT (fn () (list (r-shadow +) (r-shadow list) (r-fnshadow (fn (x) (* x 2))) (r-shq 1) (r-shif 1))))'],
    want: [null, null, null, null, '(3 (1 2) 6 5 2)'] },
  { name: 'mac: macros used as values',
    steps: ['(def r-mv (a b) (map or a b))', "(hot-run $HOT (fn () (list (r-mv '(nil 1) '(2 nil)) (apply or '(nil 3)))))"],
    want: [null, '((2 1) 3)'] },

  // ---------------------------------------------------------------- places
  { name: 'place: set through a compiled closure',
    steps: ['(def r-first (x) (car x))', '(def r-where (l v) (set (r-first l) v) l)',
      '(hot-run $HOT (fn () (r-where (list 1 2) 9)))'],
    want: [null, null, '(9 2)'] },
  { name: 'place: through nested functions, if and let',
    steps: ['(def r-first (x) (car x))', '(def r-second (x) (r-first (cdr x)))',
      '(def r-pick (c x) (if c (car x) (cdr x)))', '(def r-letp (x) (let y (cdr x) (car y)))',
      "(def r-w2 () (let l (list 1 2 3) (set (r-second l) 'b) (set (r-pick nil (cdr l)) '(z)) (set (r-letp l) 'bb) l))",
      '(def r-loc (x) (where (r-first x)))',
      '(hot-run $HOT (fn () (list (r-w2) (r-loc (list 1 2)))))'],
    want: [null, null, null, null, null, null, '((1 bb z) ((1 2) a))'] },
  { name: 'place: place macros and captured variables',
    steps: ['(def r-places (l) (push 0 (cdr l)) (++ (car l)) (swap (car l) (cadr l)) (pop (cddr l)) l)',
      "(def r-setcap (x) (let f (fn () x) (set x 5) (let g (fn () (set x 7)) (list (f) (do (g) x) (f)))))",
      "(def r-tab () (let tb (table) (set (tb 'x) 1) (++ (tb 'x)) (tb 'x)))",
      "(def r-findpop () (let w (list 'a (list 'b 'c) 'd) (pop (find pair w)) w))",
      '(def r-newg (v) (set r-brand-new v))',
      '(hot-run $HOT (fn () (list (r-places (list 1 2 3)) (r-setcap 1) (r-tab) (r-findpop) (r-newg 5))))', 'r-brand-new'],
    want: [null, null, null, null, null, null, '5'] },

  // ---------------------------------------------------------------- closure structure mutation
  { name: 'mutate: closure body replaced through (cddr (cddr f))',
    steps: ['(def r-mbody (x) (+ x 1))', '(hot-run $HOT (fn () (r-mbody 1)))',
      "(xar (cddr (cddr r-mbody)) '(* x 100))", '(r-mbody 2)', '(hot-run $HOT (fn () (r-mbody 3)))'],
    want: [null, '2', null, '200', '300'] },
  { name: 'mutate: parameter list and environment replaced',
    steps: ['(def r-mparm (x y) (list x y))', '(hot-run $HOT (fn () (r-mparm 1 2)))',
      "(xar (cdr (cddr r-mparm)) '(y x))", '(r-mparm 1 2)', "(xar (cdr (cddr r-mparm)) '(x . y))", '(r-mparm 1 2 3)',
      '(def r-menv () (let k 1 (fn () k)))', '(set r-ef (r-menv))', '(hot-run $HOT (fn () (r-ef)))',
      "(xar (cddr r-ef) (list (cons 'k 'swapped)))", '(r-ef)', '(hot-run $HOT (fn () (r-ef)))'],
    want: [null, '(1 2)', null, '(2 1)', null, '(1 (2 3))', null, null, '1', null, 'swapped', 'swapped'] },
  { name: 'mutate: code pairs changed in place inside a body that has run',
    steps: ['(def r-inpl (x) (+ x 1))', '(hot-run $HOT (fn () (r-inpl 1)))',
      "(xar (car (cddr (cddr r-inpl))) '-)", '(r-inpl 1)',
      "(def r-inpl2 (x) (if (> x 0) (list 'pos x) 'neg))", '(hot-run $HOT (fn () (r-inpl2 5)))',
      "(xar (cdr (car (cddr (cddr r-inpl2)))) '(< x 0))", '(r-inpl2 5)',
      "(xdr (cdr (cdr (car (cddr (cddr r-inpl2))))) '('other))", '(r-inpl2 5)'],
    want: [null, '2', null, '0', null, '(pos 5)', null, 'neg', null, 'other'] },
  { name: 'mutate: macro call-site arguments changed in place after expansion',
    steps: ["(mac rmx (x) `(list 'm ,x))", '(def r-mx (y) (rmx (+ y 1)))', '(hot-run $HOT (fn () (r-mx 1)))',
      "(xar (cdr (car (cddr (cddr r-mx)))) '(* y 10))", '(r-mx 1)', '(hot-run $HOT (fn () (r-mx 2)))'],
    want: [null, null, '(m 2)', null, '(m 10)', '(m 20)'] },
  { name: 'mutate: direct lambda body and argument changed in place',
    steps: ['(def r-dl (y) ((fn (z) (list z y)) (+ y 1)))', '(hot-run $HOT (fn () (r-dl 1)))',
      "(xar (cddr (car (cddr (car (car (cddr (cddr r-dl))))))) 'z)", '(r-dl 1)',
      "(xar (cdr (car (cddr (cddr r-dl)))) '(* y 10))", '(hot-run $HOT (fn () (r-dl 1)))'],
    want: [null, '(2 1)', null, '(2 2)', null, '(10 10)'] },
  { name: 'mutate: direct lambda parameter list changed in place',
    steps: ['(def r-d2 (y) ((fn (a b) (list a b)) y (+ y 1)))', '(hot-run $HOT (fn () (r-d2 1)))',
      "(xar (cdr (car (car (cddr (cddr r-d2))))) '(b a))", '(r-d2 1)', '(hot-run $HOT (fn () (r-d2 1)))'],
    want: [null, '(1 2)', null, '(2 1)', '(2 1)'] },

  // ---------------------------------------------------------------- redefinition
  { name: 'redef: + redefined at run time and restored',
    steps: ['(def r-plus (x) (+ x 1))', '(hot-run $HOT (fn () (r-plus 1)))', '(set r-old+ +)',
      '(def + args (apply r-old+ 1000 args))', '(r-plus 1)', '(hot-run $HOT (fn () (r-plus 1)))',
      '(set + r-old+)', '(r-plus 1)'],
    want: [null, '2', null, null, '1002', '1002', null, '2'] },
  { name: 'redef: map redefined at run time and restored',
    steps: ['(def r-map (l) (map [* _ 2] l))', "(hot-run $HOT (fn () (r-map '(1 2))))", '(set r-oldmap map)',
      "(def map (f . ls) (list 'mapped (len ls)))", "(r-map '(1 2))", '(set map r-oldmap)', "(r-map '(1 2))"],
    want: [null, '(2 4)', null, null, '(mapped 1)', null, '(2 4)'] },
  { name: 'redef: nth redefined; number application stays native',
    steps: ['(def r-nth (l) (list (nth 2 l) (2 l)))', "(hot-run $HOT (fn () (r-nth '(a b c))))", '(set r-oldnth nth)',
      "(def nth (n l) (list 'nth n))", "(r-nth '(a b c))", '(set nth r-oldnth)', "(r-nth '(a b c))"],
    want: [null, '(b b)', null, null, '((nth 2) b)', null, '(b b)'] },
  { name: 'redef: primitive car redefined and restored',
    steps: ['(def r-car (l) (car l))', "(hot-run $HOT (fn () (r-car '(a))))", '(set r-oldcar car)',
      "(def car (x) 'mycar)", "(r-car '(a))", '(set car r-oldcar)', "(r-car '(a))"],
    want: [null, 'a', null, null, 'mycar', null, 'a'] },
  { name: 'redef: jets and globals shadowed by parameters, callees redefined',
    steps: ['(def r-lplus (+) (+ 1 2))', '(def r-lmap (map) (map 1))',
      '(def r-sq (x) (* x x))', '(def r-mapsq (l) (map r-sq l))',
      "(hot-run $HOT (fn () (list (r-lplus -) (r-lplus list) (r-lmap idfn) (r-mapsq '(2 3)))))",
      '(def r-sq (x) (+ x x))', "(r-mapsq '(2 3))"],
    want: [null, null, null, null, '(-1 (1 2) 1 (4 9))', null, '(4 6)'] },

  // ---------------------------------------------------------------- continuations and after
  { name: 'ccc: escape from a map lambda through after cleanups',
    steps: ["(def r-ccc (l) (let log nil (list (ccc (fn (k) (map (fn (x) (after (if (= x 3) (k (list 'escaped x)) x) (push x log))) l))) log)))",
      "(hot-run $HOT (fn () (r-ccc '(1 2 3 4))))"],
    want: [null, '((escaped 3) (3 2 1))'] },
  { name: 'ccc: nested afters run inner first; dyn restored on escape',
    steps: ["(def r-after () (let log nil (list (ccc (fn (k) (after (after (k 1) (push 'inner log)) (push 'outer log)))) log)))",
      "(set rcd 'g)", "(def r-ccd () (list (ccc (fn (k) (dyn rcd 'd (k rcd)))) rcd))",
      "(def r-aft (x) (let log nil (list (after (+ x 1) (push 'clean log)) log)))",
      "(def r-afterr () (let log nil (list (onerr 'e (after (car 'a) (push 'cleaned log))) log)))",
      '(hot-run $HOT (fn () (list (r-after) (r-ccd) (r-aft 1) (r-afterr))))'],
    want: [null, null, null, null, null, '((1 (outer inner)) (d g) (2 (clean)) (e (cleaned)))'] },
  { name: 'ccc: continuation called from a nested closure and from deep recursion',
    steps: ['(def r-ccc2 (n) (ccc (fn (k) (let f (fn (v) (k (* v 2))) (+ 1000 (f n))))))',
      "(def r-thr (n) (if (= n 0) (throw 'bottom) (cons n (r-thr (- n 1)))))", '(def r-catch2 (n) (catch (r-thr n)))',
      "(def r-fold (l) (ccc (fn (k) (foldl (fn (x acc) (if (> acc 5) (k (list 'stop acc)) (+ x acc))) 0 l))))",
      "(hot-run $HOT (fn () (list (r-ccc2 5) (r-catch2 50) (r-fold '(1 2 3 4 5)))))"],
    want: [null, null, null, null, '(10 bottom (stop 6))'] },

  // ---------------------------------------------------------------- js-tier regressions
  { name: 'regress: free cells after a symbol is lexically bound for the first time',
    steps: ["(set r-g1 'glob r-g2 'glob2)",
      '(set r-fc (let (fa fb) (list 1 2) (fn (k) (set fb (+ fb 1)) (list r-g2 k fa fb r-g1))))',
      '(set r-fc2 (let fa 10 (list (fn () fa) (fn (v) (set fa v)))))',
      '(hot-run $HOT (fn () (list (r-fc 0) ((car r-fc2)))))',
      "((fn (r-g1) r-g1) 'lexical)", '(r-fc 1)', "((cadr r-fc2) 'set-after-recompile)", '((car r-fc2))',
      "(let r-g2 'lexical-too r-g2)", '(hot-run $HOT (fn () (list (r-fc 2) ((car r-fc2)))))',
      '(map cdr (car (cddr r-fc)))'] },
  { name: 'regress: free cells after xar/xdr anywhere between calls',
    steps: ['(def r-h0 () (let z 0 (++ z)))', '(def r-h2 (k) (r-unbound-x))', '(def r-fm (p) (do (r-h0) (r-h2 p)))',
      "(hot-run $HOT (fn () (onerr 'caught (r-fm 1))))",
      "((fn (r-unbound-x) r-unbound-x) 0)", "(hot-run $HOT (fn () (onerr 'caught (r-fm 1))))",
      '(set r-fx (let fv 1 (fn (k) (+ k fv))))',
      '(hot-run $HOT (fn () (do (xar (list 1) 2) (xdr (list 1) nil) (r-fx 1))))'],
    want: [null, null, null, 'caught', null, 'caught', null, '2'] },
  { name: 'regress: tail call into a rejected closure whose parameter binding runs Bel code',
    steps: ['(dyn r-dv 0 nil)', '(set r-dv 7)',
      '(def r-helper2 (x) (+ x 100))', '(def r-helper (x) (r-helper2 x))',
      '(def r-pred2 (v) (number v))', '(def r-pred (v) (r-pred2 v))',
      '(def r-B (x (o y (r-helper x))) (list x y r-dv))', '(def r-B2 (x|r-pred) (list x r-dv))',
      '(def r-A (x) (r-B x))', '(def r-A2 (x) (r-B2 x))',
      '(hot-run $HOT (fn () (list (r-A 1) (r-A2 2))))', "(r-A2 'no)"],
    want: [null, null, null, null, null, null, null, null, null, null, '((1 101 7) (2 7))', 'ERR Bel error: mistype (binding parameters ((t x r-pred)))'] },
  { name: 'regress: dyn on a hand-built uvar read by hot compiled code',
    steps: ['(set r-u (uvar))',
      "(set r-uf (list 'lit 'clo (list (cons r-u 10)) nil r-u))",
      "(set r-ul (list 'lit 'clo nil (list r-u) (list 'list r-u (list r-uf))))",
      "(mac r-with-u (val expr) (list 'dyn r-u val expr))",
      '(hot-run $HOT (fn () (list (r-uf) (r-ul 5))))',
      '(r-with-u 20 (list (r-uf) (r-ul 5)))', '(list (r-uf) (r-ul 5))',
      '(hot-run $HOT (fn () (r-with-u 30 (list (r-uf) (r-ul 5)))))'],
    want: [null, null, null, null, '(10 (5 10))', '(20 (20 20))', '(10 (5 10))', '(30 (30 30))'] },

  // ---------------------------------------------------------------- recursion
  { name: 'tail: self tail recursion 1e6',
    steps: ['(def r-loop (n acc) (if (= n 0) acc (r-loop (- n 1) (+ acc 1))))', '(r-loop 1000000 0)'],
    want: [null, '1000000'] },
  { name: 'tail: mutual tail recursion 1e6',
    steps: ['(def r-ev (n) (if (= n 0) t (r-od (- n 1))))', '(def r-od (n) (if (= n 0) nil (r-ev (- n 1))))', '(r-ev 1000000)'],
    want: [null, null, 't'] },
  { name: 'tail: through let, when, do, case, and, or, if, rfn, apply, macros',
    steps: ["(def r-tl (n) (let m (- n 1) (when t (do (case 1 1 (and t (or nil (if (< m 0) 'done (r-tl m)))))))))",
      '(def r-rfnloop (n) ((rfn lp (i acc) (if (= i 0) acc (lp (- i 1) (+ acc 2)))) n 0))',
      "(def r-ap (n) (if (= n 0) 'ok (apply r-ap (list (- n 1)))))",
      '(mac r-tm (x) x)', "(def r-tml (n) (if (= n 0) 'ok (r-tm (r-tml (- n 1)))))",
      "(def r-wl (n) (with (a 1 b 2) (withs (c a) (unless nil (if (= n 0) 'ok (r-wl (- n c)))))))",
      '(list (r-tl 1000000) (r-rfnloop 1000000) (r-ap 300000) (r-tml 1000000) (r-wl 1000000))'],
    want: [null, null, null, null, null, null, '(done 2000000 ok ok ok)'] },
  { name: 'nontail: recursion 1000 deep',
    steps: ['(def r-nt (n) (if (= n 0) 0 (+ 1 (r-nt (- n 1)))))', '(hot-run $HOT (fn () (r-nt 10)))', '(r-nt 1000)'],
    want: [null, '10', '1000'] },

  // ---------------------------------------------------------------- bel.bel's own definitions
  { name: "pg: bel.bel's list functions with jets off", jetsOff: true,
    steps: ["(map (fn (x) (* x x)) '(1 2 3))", "(map + '(1 2 3) '(10 20 30 40))", "(append '(a) nil '(b c) '(d))",
      "(rev '(1 2 3))", "(keep odd '(1 2 3 4 5))", "(rem 'a '(a b a c))", "(foldl + 0 '(1 2 3))", "(foldr cons nil '(1 2 3))",
      "(reduce + '(1 2 3))", "(sort < '(3 1 2 1))", "(dedup '(a b a c b))", "(= '(a (b \"c\")) '(a (b \"c\")))",
      '(len "hello")', "(nth 3 '(a b c d))", "(cadr '(1 2))", "(find even '(1 3 4 5))", "(mem 'b '(a b c))",
      "(some odd '(2 4 5))", "(all odd '(1 3))", "(snoc '(a) 'b 'c)", "(first 2 '(a b c))", "(drop 1 '(a b))",
      "(pos 'c '(a b c))", "(hug '(1 2 3 4 5))", "(lastcdr '(1 2))", "(last '(1 2 3))", "(get 'a '((a . 1)))",
      "(begins '(a b c) '(a b))", "(caris '(a b) 'a)", "(cut '(a b c d e) 2 3)", "(udrop '(a b) '(1 2 3))",
      "(proper '(a . b))", "(in 'c 'a 'b 'c)", "((compose car cdr) '(1 2 3))", "(apply append '((1) (2)))",
      "(map car (list (list 1) (list 2)))", "(let l (list 3 1 2) (sort > l))",
      "(def r-pg (l) (map [+ _ 1] (keep odd (rev (append l (list 7 8 9))))))",
      "(hot-run $HOT (fn () (r-pg '(1 2 3 4 5))))",
      "(def r-pg2 (l) (foldl (fn (x acc) (cons (len x) acc)) nil (map [nof _ 'z] l)))",
      "(hot-run $HOT (fn () (r-pg2 '(1 2 3))))"],
    want: Object.assign(new Array(41).fill(null), { 38: '(10 8 6 4 2)' }) },
];

// ---------------------------------------------------------------- child side

async function bootBel() {
  const { Bel } = await import(new URL('../interp/bel.js', import.meta.url));
  return new Bel({ readFile: (p) => (fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null) });
}

function outcome(bel, f) {
  let r;
  try {
    const v = f();
    r = { v: typeof v === 'string' ? v : clip(bel.print(v)) };
  } catch (e) {
    if (e && e.value !== undefined && e.constructor.name === 'BelError') r = { v: 'ERR ' + e.message };
    else r = { v: `JSERR ${e && e.constructor ? e.constructor.name : typeof e}: ${e && e.message}` };
  }
  const out = Buffer.from(bel.takeOutput() || []).toString('latin1');
  if (out) r.out = out;
  return r;
}

const clip = (s) => (s.length > 2000 ? s.slice(0, 2000) + '...' : s);

async function childCase(index) {
  const bel = await bootBel();
  const c = CASES[index];
  bel.evalString('(def hot-run (n f) (if (< n 2) (f) (do (f) (hot-run (- n 1) f))))');
  if (c.jetsOff) bel.setJets(false, NUMBER_JETS);
  const results = c.steps.map((s) => outcome(bel, () => bel.evalString(s.replaceAll('$HOT', String(HOT)))));
  const jit = typeof bel.jitStats === 'function' ? bel.jitStats() : null;
  process.stdout.write(JSON.stringify({ tier: bel.tier, results, jit }) + '\n');
}

async function childDepth() {
  const bel = await bootBel();
  bel.evalString(`(def r-nt (n) (if (= n 0) 0 (+ 1 (r-nt (- n 1)))))
    (def r-ntm (n) (if (= n 0) 0 (+ 1 (car (map r-ntm (list (- n 1)))))))
    (def hot-run (n f) (if (< n 2) (f) (do (f) (hot-run (- n 1) f))))
    (hot-run ${Math.max(HOT, 300)} (fn () (list (r-nt 300) (r-ntm 300))))`);
  const ok = (src, want) => {
    try { return bel.print(bel.evalString(src)) === want; } catch { return false; }
  };
  const deepest = (probe) => Math.max(search(probe), search(probe), search(probe));
  function search(probe) {
    let lo = 0, hi = 250;
    while (hi <= 1 << 20 && probe(hi)) { lo = hi; hi *= 2; }
    if (hi > 1 << 20) return lo;
    while (hi - lo > Math.max(4, lo * 0.01)) {
      const mid = Math.floor((lo + hi) / 2);
      if (probe(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }
  const plain = deepest((n) => ok(`(r-nt ${n})`, String(n)));
  const viaMap = deepest((n) => ok(`(r-ntm ${n})`, String(n)));
  const pgMap = deepest((n) => {
    bel.evalString(`(set r-l (nof ${n} 1) r-m nil)`);
    bel.setJets(false, NUMBER_JETS);
    try { bel.evalString('(set r-m (map idfn r-l))'); } catch { return false; } finally { bel.setJets(true); }
    return ok('(len r-m)', String(n));
  });
  process.stdout.write(JSON.stringify({ tier: bel.tier, plain, viaMap, pgMap }) + '\n');
}

// ---------------------------------------------------------------- parent side

function runChild(args, tier) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args, '--hot', String(HOT)],
      { env: { ...process.env, BEL_TIER: tier } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      try { resolve(JSON.parse(line)); } catch {
        resolve({ crash: `exit ${code}${signal ? ' ' + signal : ''}: ${(err || out).trim().split('\n').slice(-5).join(' | ')}` });
      }
    });
  });
}

async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => { while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

async function parent() {
  const tiers = opt('--tiers', 'ev,closure,js').split(',');
  if (tiers[0] !== 'ev') tiers.unshift('ev');
  const others = [...new Set(tiers.slice(1))];
  const only = opt('--only', null);
  const verbose = argv.includes('--verbose');
  const depthRatio = Number(opt('--depth-ratio', 0.8));
  const jobs = Number(opt('--jobs', os.cpus().length));
  const picked = CASES.map((c, i) => [c, i]).filter(([c]) => !only || c.name.includes(only));
  const t0 = performance.now();

  const tasks = [];
  for (const [, i] of picked) for (const tier of ['ev', ...others]) tasks.push({ i, tier, run: () => runChild(['--child-case', String(i)], tier) });
  if (!only) for (const tier of ['ev', ...others]) tasks.push({ depth: true, tier, run: () => runChild(['--child-depth'], tier) });
  const done = await pool(tasks.map((t) => t.run), jobs);
  const res = (i, tier) => done[tasks.findIndex((t) => t.i === i && t.tier === tier)];

  const tally = Object.fromEntries(others.map((t) => [t, { ok: 0, fail: 0, xfail: 0, xpass: 0 }]));
  let failures = 0;
  for (const [c, i] of picked) {
    const ev = res(i, 'ev');
    const lines = [];
    let evBad = false;
    if (ev.crash) { lines.push(`  ev crashed: ${ev.crash}`); evBad = true; }
    else if (ev.tier !== 'ev') { lines.push(`  oracle ran on ${ev.tier}`); evBad = true; }
    else if (c.want !== undefined) {
      const wants = Array.isArray(c.want) ? c.want : [...new Array(c.steps.length - 1).fill(null), c.want];
      c.steps.forEach((s, k) => {
        const w = wants[k];
        if (w !== null && w !== undefined && ev.results[k].v !== w) {
          lines.push(`  ev step ${k + 1} ${c.steps[k]}\n    got  ${ev.results[k].v}\n    want ${w}`);
          evBad = true;
        }
      });
    }
    if (!ev.crash) {
      c.steps.forEach((s, k) => {
        if (/^\((def|mac|set) /.test(s) && ev.results[k].v.startsWith('ERR')) {
          lines.push(`  ev step ${k + 1} is a definition that failed: ${s}\n    ${ev.results[k].v}`);
          evBad = true;
        }
      });
    }
    if (evBad) failures++;
    const status = [];
    for (const tier of others) {
      const r = res(i, tier);
      const diffs = [];
      if (r.crash) diffs.push(`  ${tier} crashed: ${r.crash}`);
      else if (r.tier !== tier) diffs.push(`  ${tier} child ran on ${r.tier}`);
      else if (!ev.crash) {
        c.steps.forEach((s, k) => {
          const a = ev.results[k], b = r.results[k];
          if (a.v !== b.v || (a.out || '') !== (b.out || '')) {
            diffs.push(`  ${tier} step ${k + 1} ${s.replaceAll('$HOT', String(HOT))}\n    ev     ${a.v}${a.out ? '  out ' + JSON.stringify(a.out) : ''}\n    ${tier.padEnd(6)} ${b.v}${b.out ? '  out ' + JSON.stringify(b.out) : ''}`);
          }
        });
      }
      const known = c.xfail && c.xfail[tier];
      if (diffs.length === 0) { tally[tier][known ? 'xpass' : 'ok']++; status.push(known ? `${tier}:XPASS` : `${tier}:ok`); }
      else if (known) { tally[tier].xfail++; status.push(`${tier}:XFAIL`); if (verbose) lines.push(...diffs); }
      else { tally[tier].fail++; failures++; status.push(`${tier}:FAIL`); lines.push(...diffs); }
    }
    const bad = evBad || status.some((s) => s.endsWith('FAIL') && !s.endsWith('XFAIL'));
    console.log(`${bad ? 'FAIL' : 'ok  '}  ${c.name}  [${status.join(' ')}]`);
    if (c.xfail) for (const [tier, why] of Object.entries(c.xfail)) if (others.includes(tier)) console.log(`        known on ${tier}: ${why}`);
    for (const l of lines) console.log(l);
    if (verbose && !ev.crash) c.steps.forEach((s, k) => console.log(`    ${s.replaceAll('$HOT', String(HOT))}\n      => ${ev.results[k].v}`));
  }

  if (others.includes('js')) {
    const cold = picked.filter(([, i]) => { const r = res(i, 'js'); return r.jit && r.jit.compiled === 0; }).map(([c]) => c.name);
    const jits = picked.map(([, i]) => res(i, 'js').jit).filter(Boolean);
    if (jits.length) {
      const total = jits.reduce((s, j) => s + j.compiled, 0);
      console.log(`\njs tier compiled ${total} functions across ${jits.length} cases; ${cold.length} cases compiled none (they ran on the fallback tiers):`);
      for (const n of cold) console.log(`  ${n}`);
    }
  }

  if (!only) {
    const depth = Object.fromEntries(tasks.map((t, k) => [t, done[k]]).filter(([t]) => t.depth).map(([t, r]) => [t.tier, r]));
    console.log('\ndeepest recursion on the default Node stack (non-tail; map on bel.bel\'s definition with jets off):');
    console.log('  tier      plain    via map jet   pg map list length');
    for (const tier of ['ev', ...others]) {
      const d = depth[tier];
      console.log(d.crash ? `  ${tier.padEnd(8)}crashed: ${d.crash}` : `  ${tier.padEnd(8)}${String(d.plain).padStart(7)}  ${String(d.viaMap).padStart(12)}  ${String(d.pgMap).padStart(19)}`);
    }
    if (others.includes('js') && others.includes('closure') && !depth.js.crash && !depth.closure.crash) {
      for (const k of ['plain', 'viaMap']) {
        if (depth.js[k] < depthRatio * depth.closure[k]) {
          failures++;
          console.log(`FAIL  js tier recursion depth (${k}) ${depth.js[k]} < ${depthRatio} x closure ${depth.closure[k]}`);
        }
      }
    }
  }

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const summary = others.map((t) => `${t} ${tally[t].ok}/${picked.length} match ev` +
    (tally[t].xfail ? `, ${tally[t].xfail} known` : '') + (tally[t].xpass ? `, ${tally[t].xpass} XPASS` : '') +
    (tally[t].fail ? `, ${tally[t].fail} FAIL` : '')).join('; ');
  console.log(`\nreflect: ${picked.length} cases, hot=${HOT}, ${secs}s: ${summary}${failures ? ` -- ${failures} failure(s)` : ''}`);
  process.exit(failures ? 1 : 0);
}

if (argv.includes('--child-case')) await childCase(Number(opt('--child-case')));
else if (argv.includes('--child-depth')) await childDepth();
else await parent();

// Differential fuzzer for the execution tiers. A seeded generator writes small
// Bel programs (let/with/withs, fn/rfn closures that capture and set
// variables, map/foldl/keep with lambdas, fresh lists changed with xar/xdr,
// arithmetic, recursion with depth caps, globals, dyn, ccc, catch, resumable
// err handlers). Each program defines fz-main and calls it --reps times (so
// tiers that compile only hot code get to compile it) under every tier, one
// process per tier; the tree-walking evaluator (ev) is the oracle. Printed
// results and error values must agree. A mismatch is shrunk by delta debugging
// over subexpressions and printed as a minimal repro.
//
//   node test/fuzz-tiers.mjs                         2,000 programs, seed 1, ev vs closure vs js
//   node test/fuzz-tiers.mjs --seed 7 --count 10000 --tiers ev,closure
//   node test/fuzz-tiers.mjs --seed 7 --only 1234    one program, results per tier
//   node test/fuzz-tiers.mjs --show 3                print the first programs and exit
//   --reps N (default 20)  --messages (compare full error messages, not just values)
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(name);

// ---------------------------------------------------------------- generator

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['a', 'b', 'c', 'x', 'y', 'z', 'n', 'm', 'acc', 'l', 'f', 'g'];
const Q = (x) => ({ q: x });

// Variables that get dynamic bindings are named per program (gd<i>, dl<i>), so
// one program's dyn does not mark names that every later program uses.
class Gen {
  constructor(seed, index) {
    this.rand = mulberry(seed);
    this.budget = 0;
    this.gd = `gd${index}`;
    this.dl = `dl${index}`;
  }
  int(n) { return Math.floor(this.rand() * n); }
  chance(p) { return this.rand() < p; }
  pick(xs) { return xs[this.int(xs.length)]; }
  weighted(options) {
    const live = options.filter((o) => o[0] > 0);
    let r = this.rand() * live.reduce((s, o) => s + o[0], 0);
    for (const [w, f] of live) { if ((r -= w) < 0) return f(); }
    return live[live.length - 1][1]();
  }
  visible(ctx, kind) {
    const latest = new Map();
    for (const v of ctx.vars) latest.set(v.name, v);
    return [...latest.values()].filter((v) => v.kind === kind);
  }
  settable(ctx, kind) { return this.visible(ctx, kind).filter((v) => v.set); }
  bind(ctx, name, kind, set = true, kind2) {
    if (typeof set === 'string') return this.bind(this.bind(ctx, name, kind), set, kind2);
    return { ...ctx, vars: [...ctx.vars, { name, kind, set }] };
  }
  has(ctx, h) { return ctx.helpers.includes(h) ? 1 : 0; }
  fresh(kind) {
    if (kind === 'fn' && this.chance(0.04)) return this.pick(['inc', 'dec', 'abs']);
    return this.pick(NAMES);
  }
  spend() { return --this.budget > 0; }
  loop(ctx) { return ctx.loopy ? ctx : { ...ctx, loopy: true }; }

  program() {
    this.bigLeft = 0;
    const root = { vars: [], rec: null, cont: null, thrown: false, loopy: false, helpers: [] };
    this.budget = 25;
    const h0 = this.num(this.bind(root, 'a', 'num', 'b', 'num'), 3);
    this.budget = 25;
    const h1 = this.list(this.bind({ ...root, helpers: ['fz-h0'] }, 'l', 'list'), 3);
    this.budget = 15;
    const h2 = ['fn', ['x'], this.num(this.bind({ ...root, helpers: ['fz-h0', 'fz-h1'] }, 'k', 'num', 'x', 'num'), 2)];
    this.bigLeft = 1;
    this.budget = 60 + this.int(100);
    const main = this.any(this.bind({ ...root, helpers: ['fz-h0', 'fz-h1', 'fz-h2'] }, 'p', 'num'), 6);
    return [
      ['set', 'gv0', this.int(10), 'gv1', ['list', ...Array.from({ length: this.int(4) }, () => this.int(10))], 'gv2', this.int(10), this.gd, this.int(10)],
      ['def', 'fz-h0', ['a', 'b'], h0],
      ['def', 'fz-h1', ['l'], h1],
      ['def', 'fz-h2', ['k'], h2],
      ['def', 'fz-main', ['p'], main],
    ];
  }

  numLeaf(ctx) {
    const vs = this.visible(ctx, 'num');
    return this.weighted([
      [5, () => this.int(13) - 2],
      [vs.length ? 6 : 0, () => this.pick(vs).name],
      [1, () => this.pick(['gv0', 'gv2', this.gd])],
    ]);
  }

  num(ctx, d) {
    if (d <= 0 || !this.spend()) return this.numLeaf(ctx);
    const nv = this.visible(ctx, 'num'), sv = this.settable(ctx, 'num'), fv = this.visible(ctx, 'fn');
    const d1 = d - 1;
    return this.weighted([
      [4, () => this.numLeaf(ctx)],
      [6, () => [this.pick(['+', '-', '*', '+']), this.num(ctx, d1), this.num(ctx, d1)]],
      [1, () => ['+', this.num(ctx, d1), this.num(ctx, d1), this.num(ctx, d1)]],
      [3, () => ['if', this.bool(ctx, d1), this.num(ctx, d1), this.num(ctx, d1)]],
      [3, () => this.letForm(ctx, d, (c) => this.num(c, d1))],
      [1, () => ['do', this.effect(ctx, d1), this.num(ctx, d1)]],
      [2, () => ['len', this.list(ctx, d1)]],
      [2 * this.has(ctx, 'fz-h0'), () => ['fz-h0', this.num(ctx, d1), this.num(ctx, d1)]],
      [this.has(ctx, 'fz-h2'), () => [['fz-h2', this.num(ctx, d1)], this.num(ctx, d1)]],
      [fv.length ? 3 : 0, () => [this.pick(fv).name, this.num(ctx, d1)]],
      [1, () => [this.fn(ctx, d1), this.num(ctx, d1)]],
      [2, () => { const [x, y] = this.twoNames(); return [['fn', [x, y], this.num(this.bind(this.bind(ctx, x, 'num'), y, 'num'), d1)], this.num(ctx, d1), this.num(ctx, d1)]; }],
      [2, () => { const x = this.fresh('num'), y = this.pick(['acc', 'm', 'z']); return ['foldl', ['fn', [x, y], this.num(this.bind(this.bind(this.loop(ctx), x, 'num'), y, 'num'), d1)], this.num(ctx, d1), this.list(ctx, d1)]; }],
      [1, () => ['apply', '+', this.list(ctx, d1)]],
      [0.4, () => ['car', this.list(ctx, d1)]],
      [0.4, () => ['nth', 1 + this.int(3), this.list(ctx, d1)]],
      [sv.length ? 2 : 0, () => ['set', this.pick(sv).name, this.num(ctx, d1)]],
      [1, () => ['set', 'gv0', this.num(ctx, d1)]],
      [ctx.rec ? 0 : 2, () => this.recNum(ctx, d1)],
      [1, () => ['dyn', this.gd, this.num(ctx, d1), this.has(ctx, 'fz-h0') && this.chance(0.5) ? ['fz-h0', this.num(ctx, d1), this.gd] : this.num(ctx, d1)]],
      [1, () => {
        const c = this.bind(ctx, this.dl, 'num');
        return ['let', this.dl, this.num(ctx, d1), ['let', 'peek', ['fn', [], this.dl],
          ['+', ['peek'], ['dyn', this.dl, this.num(c, d1), ['+', ['peek'], this.num(c, d1)]], this.dl]]];
      }],
      [1, () => { const k = this.pick(['k', 'esc']); return ['ccc', ['fn', [k], ['+', this.num(ctx, 0), this.num({ ...this.bind(ctx, k, 'cont', false), cont: k }, d1)]]]; }],
      [ctx.cont ? 2 : 0, () => [ctx.cont, this.num(ctx, d1)]],
      [1, () => ['catch', this.num({ ...ctx, thrown: true }, d1)]],
      [ctx.thrown ? 2 : 0, () => ['throw', this.num(ctx, d1)]],
      [1, () => ['onerr', this.int(5) - 9, this.num(ctx, d1)]],
      [1, () => ['dyn', 'err', ['fn', ['e'], this.int(5) + 90], this.num(ctx, d1)]],
      [1, () => ['after', this.num(ctx, d1), ['set', 'gv0', ['+', 'gv0', 1]]]],
      [1, () => this.counter(ctx, d1)],
      [0.08, () => ['car', this.pick([Q('sym'), this.num(ctx, d1)])]],
      [0.06, () => ['err', Q(this.pick(['boom', 'bad']))]],
    ]);
  }

  twoNames() {
    const x = this.fresh('num');
    let y = this.fresh('num');
    if (y === x) y = x + '2';
    return [x, y];
  }

  // A closure that counts in a captured variable, called twice.
  counter(ctx, d) {
    const c = this.pick(['c', 'n', 'acc']), g = this.pick(['g', 'f', 'bump']), x = this.pick(['x', 'step']);
    const c1 = this.bind(ctx, c, 'num');
    const c2 = this.bind(c1, x, 'num');
    return ['let', c, this.num(ctx, d),
      ['let', g, ['fn', [x], ['do', ['set', c, ['+', c, this.num(c2, d - 1)]], c]],
        ['+', [g, this.num(c1, 0)], [g, this.num(c1, 0)], c]]];
  }

  recNum(ctx, d) {
    const self = this.pick(['self', 'rec', 'loop']), k = this.pick(['k', 'i', 'depth']);
    const inner = { ...this.bind(ctx, self, 'self', false), rec: self, loopy: true };
    if (this.chance(0.5)) {
      const acc = this.pick(['acc', 'sum']);
      const c = this.bind(this.bind(inner, k, 'num', false), acc, 'num');
      const big = !ctx.loopy && this.bigLeft-- > 0 && this.chance(0.3);
      const step = big ? [this.pick(['+', '-']), acc, this.numLeaf(c)] : this.num(c, d);
      return [['rfn', self, [k, acc], ['if', ['<=', k, 0], acc, [self, ['-', k, 1], step]]],
        big ? 3000 + this.int(5000) : this.int(30), this.num(ctx, d)];
    }
    const c = this.bind(inner, k, 'num', false);
    return [['rfn', self, [k], ['if', ['<=', k, 0], this.num(c, d), ['+', this.num(c, d), [self, ['-', k, 1]]]]], this.int(13)];
  }

  recList(ctx, d) {
    const self = this.pick(['self', 'build']), k = this.pick(['k', 'i']);
    const c = this.bind({ ...this.bind(ctx, self, 'self', false), rec: self, loopy: true }, k, 'num', false);
    return [['rfn', self, [k], ['if', ['<=', k, 0], 'nil', ['cons', this.num(c, d), [self, ['-', k, 1]]]]], this.int(11)];
  }

  letForm(ctx, d, body) {
    const d1 = d - 1;
    const kind = this.chance(0.6) ? 'num' : this.chance(0.7) ? 'list' : 'fn';
    const val = (c) => (kind === 'num' ? this.num(c, d1) : kind === 'list' ? this.list(c, d1) : this.fn(c, d1));
    return this.weighted([
      [5, () => { const v = this.fresh(kind); return ['let', v, val(ctx), body(this.bind(ctx, v, kind))]; }],
      [2, () => { const [x, y] = this.twoNames(); return ['with', [x, this.num(ctx, d1), y, val(ctx)], body(this.bind(this.bind(ctx, x, 'num'), y, kind))]; }],
      [2, () => {
        const [x, y] = this.twoNames();
        const c1 = this.bind(ctx, x, 'num');
        return ['withs', [x, this.num(ctx, d1), y, val(c1)], body(this.bind(c1, y, kind))];
      }],
      [1, () => {
        const [x, y] = this.twoNames();
        const val = this.chance(0.8) ? ['list', this.num(ctx, d1), this.num(ctx, d1)] : this.list(ctx, d1);
        return ['let', [x, y], val, body(this.bind(this.bind(ctx, x, 'num'), y, 'num'))];
      }],
    ]);
  }

  list(ctx, d) {
    const lv = this.visible(ctx, 'list'), sl = this.settable(ctx, 'list'), fv = this.visible(ctx, 'fn');
    const leaf = () => this.weighted([
      [2, () => 'nil'],
      [lv.length ? 6 : 0, () => this.pick(lv).name],
      [1, () => 'gv1'],
      [4, () => ['list', ...Array.from({ length: this.int(5) }, () => this.numLeaf(ctx))]],
      [1, () => Q(Array.from({ length: 1 + this.int(4) }, () => this.int(10)))],
    ]);
    if (d <= 0 || !this.spend()) return leaf();
    const d1 = d - 1;
    return this.weighted([
      [4, leaf],
      [3, () => ['cons', this.num(ctx, d1), this.list(ctx, d1)]],
      [2, () => ['cdr', this.list(ctx, d1)]],
      [2, () => ['append', this.list(ctx, d1), this.list(ctx, d1)]],
      [1, () => ['rev', this.list(ctx, d1)]],
      [1, () => ['snoc', this.list(ctx, d1), this.num(ctx, d1)]],
      [4, () => { const x = this.fresh('num'); return ['map', ['fn', [x], this.num(this.bind(this.loop(ctx), x, 'num'), d1)], this.list(ctx, d1)]; }],
      [1, () => ['map', this.pick(['+', '-', '*']), this.list(ctx, d1), this.list(ctx, d1)]],
      [fv.length ? 2 : 0, () => ['map', this.pick(fv).name, this.list(ctx, d1)]],
      [1, () => ['map', ['fn', ['h'], ['h', this.num(this.loop(ctx), d1)]], ['map', ['fn', ['x'], this.fn(this.bind(this.loop(ctx), 'x', 'num'), d1)], this.list(ctx, d1)]]],
      [3, () => { const x = this.fresh('num'); return ['keep', ['fn', [x], this.bool(this.bind(this.loop(ctx), x, 'num'), d1)], this.list(ctx, d1)]; }],
      [1, () => ['sort', this.pick(['<', '>']), this.list(ctx, d1)]],
      [2, () => ['if', this.bool(ctx, d1), this.list(ctx, d1), this.list(ctx, d1)]],
      [3, () => this.letForm(ctx, d, (c) => this.list(c, d1))],
      [2 * this.has(ctx, 'fz-h1'), () => ['fz-h1', this.list(ctx, d1)]],
      [3, () => this.freshMutation(ctx, d1)],
      [sl.length ? 2 : 0, () => ['set', this.pick(sl).name, this.list(ctx, d1)]],
      [1, () => ['set', 'gv1', this.list(ctx, d1)]],
      [ctx.rec ? 0 : 1, () => this.recList(ctx, d1)],
      [1, () => ['list', this.num(ctx, d1), this.num(ctx, d1)]],
      [0.5, () => ['do', this.effect(ctx, d1), this.list(ctx, d1)]],
    ]);
  }

  freshMutation(ctx, d) {
    const v = this.pick(['v', 'cell', 'l']);
    const c = this.bind(ctx, v, 'list');
    const fresh = ['list', ...Array.from({ length: 2 + this.int(3) }, () => this.num(ctx, d))];
    return this.weighted([
      [2, () => ['let', v, fresh, ['do', ['xar', v, this.num(c, d)], v]]],
      [2, () => ['let', v, fresh, ['do', ['xdr', ['cdr', v], ['list', this.num(c, d)]], ['xar', v, this.num(c, d)], v]]],
      [1, () => ['let', v, fresh, ['do', ['xdr', v, 'nil'], v]]],
      [1, () => ['let', v, fresh, ['do', ['set', ['car', ['cdr', v]], this.num(c, d)], ['push', this.num(c, d), v], v]]],
    ]);
  }

  bool(ctx, d) {
    if (d <= 0 || !this.spend()) return ['<', this.numLeaf(ctx), this.numLeaf(ctx)];
    const d1 = d - 1;
    return this.weighted([
      [4, () => [this.pick(['<', '>', '=', '<=']), this.num(ctx, d1), this.num(ctx, d1)]],
      [2, () => [this.pick(['no', 'pair']), this.list(ctx, d1)]],
      [1, () => ['and', this.bool(ctx, d1), this.bool(ctx, d1)]],
      [1, () => ['or', this.bool(ctx, d1), this.bool(ctx, d1)]],
      [1, () => ['some', ['fn', ['_'], ['<', '_', this.num(ctx, d1)]], this.list(ctx, d1)]],
      [1, () => ['mem', this.num(ctx, d1), this.list(ctx, d1)]],
      [1, () => ['even', this.num(ctx, d1)]],
      [0.5, () => ['=', this.list(ctx, d1), this.list(ctx, d1)]],
    ]);
  }

  fn(ctx, d) {
    const fv = this.visible(ctx, 'fn'), sv = this.settable(ctx, 'num');
    ctx = this.loop(ctx);
    return this.weighted([
      [fv.length ? 2 : 0, () => this.pick(fv).name],
      [1, () => this.pick(['inc', 'dec', 'abs'])],
      [4, () => { const x = this.fresh('num'); return ['fn', [x], this.num(this.bind(ctx, x, 'num'), d - 1)]; }],
      [1, () => ['fn', ['_'], ['+', '_', this.num(ctx, d - 1)]]],
      [sv.length ? 2 : 0, () => {
        const x = this.fresh('num'), v = this.pick(sv).name, c = this.bind(ctx, x, 'num');
        return ['fn', [x], ['do', ['set', v, this.num(c, d - 1)], this.num(c, d - 1)]];
      }],
      [this.has(ctx, 'fz-h2'), () => ['fz-h2', this.num(ctx, d - 1)]],
    ]);
  }

  effect(ctx, d) {
    const sv = this.settable(ctx, 'num'), sl = this.settable(ctx, 'list'), fv = this.visible(ctx, 'fn');
    return this.weighted([
      [sv.length ? 3 : 0, () => ['set', this.pick(sv).name, this.num(ctx, d)]],
      [sv.length ? 1 : 0, () => ['++', this.pick(sv).name]],
      [sv.length ? 1 : 0, () => ['zap', '+', this.pick(sv).name, this.num(ctx, d)]],
      [sl.length ? 1 : 0, () => ['push', this.num(ctx, d), this.pick(sl).name]],
      [sl.length ? 0.3 : 0, () => ['xar', this.pick(sl).name, this.num(ctx, d)]],
      [1, () => ['set', 'gv0', this.num(ctx, d)]],
      [fv.length ? 2 : 0, () => [this.pick(fv).name, this.num(ctx, d)]],
      [1, () => ['for', 'i', 1, this.int(4), this.effect(this.bind(ctx, 'i', 'num', false), d - 1)]],
      [1, () => ['repeat', this.int(3), this.effect(ctx, d - 1)]],
      [1, () => this.num(ctx, d)],
    ]);
  }

  any(ctx, d) {
    return this.weighted([
      [8, () => this.num(ctx, d)],
      [7, () => this.list(ctx, d)],
      [2, () => this.bool(ctx, d)],
      [1, () => this.fn(ctx, d - 1)],
      [1, () => ['list', Q(this.pick(['a', 'tag'])), this.num(ctx, d - 1), this.list(ctx, d - 1)]],
    ]);
  }
}

function show(x) {
  if (Array.isArray(x)) return '(' + x.map(show).join(' ') + ')';
  if (x && typeof x === 'object') return "'" + show(x.q);
  return String(x);
}

const programAt = (seed, i) => new Gen(Math.imul(seed, 2654435761) ^ Math.imul(i + 1, 40503), i).program();

// ---------------------------------------------------------------- child side

async function child(file, start) {
  const { programs, reps, messages } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { Bel } = await import(new URL('../interp/bel.js', import.meta.url));
  const bel = new Bel({ readFile: (p) => (fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null) });
  const run = (src) => {
    try { return bel.print(bel.evalString(src)); } catch (e) {
      if (e && e.constructor && e.constructor.name === 'BelError') return 'ERR ' + (messages ? e.message : bel.print(e.value));
      return `JSERR ${e && e.constructor ? e.constructor.name : typeof e}: ${e && e.message}`;
    }
  };
  process.stdout.write(JSON.stringify({ tier: bel.tier }) + '\n');
  for (let i = start; i < programs.length; i++) {
    const out = [];
    run('(set fz-main nil fz-h0 nil fz-h1 nil fz-h2 nil gv0 nil gv1 nil gv2 nil)');
    for (const form of programs[i]) {
      const r = run(form);
      if (r.startsWith('ERR') || r.startsWith('JSERR')) out.push('setup ' + r);
    }
    for (let k = 1; k <= reps; k++) out.push(run(`(fz-main ${k})`));
    bel.takeOutput();
    const h = crypto.createHash('sha1').update(out.join('\u0000')).digest('hex').slice(0, 16);
    const brief = [...new Set(out)].slice(0, 3).map((s) => (s.length > 400 ? s.slice(0, 400) + '...' : s));
    process.stdout.write(JSON.stringify({ i, h, brief }) + '\n');
  }
  process.stdout.write(JSON.stringify({ done: true, jit: typeof bel.jitStats === 'function' ? bel.jitStats() : null }) + '\n');
}

// ---------------------------------------------------------------- parent side

const self = fileURLToPath(import.meta.url);
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bel-fuzz-'));
let tmpn = 0;

// Runs programs (arrays of form strings) on one tier; returns one result per
// program. A program that makes no progress for timeoutMs is recorded as
// TIMEOUT and the run resumes after it in a fresh process.
function runTier(tier, programs, { reps, timeoutMs, messages }) {
  const file = path.join(tmpdir, `p${tmpn++}.json`);
  fs.writeFileSync(file, JSON.stringify({ programs, reps, messages }));
  const results = new Array(programs.length);
  const jit = [];
  let ranOn = null;
  return new Promise((resolve) => {
    const launch = (start) => {
      if (start >= programs.length) { fs.rmSync(file, { force: true }); resolve({ results, ranOn, jit }); return; }
      const child = spawn(process.execPath, [self, '--child', file, '--start', String(start)], { env: { ...process.env, BEL_TIER: tier } });
      let next = start, buf = '', finished = false, err = '';
      let timer = setTimeout(onTimeout, timeoutMs + 2000);
      function onTimeout() { results[next] = { h: 'TIMEOUT', brief: [`TIMEOUT after ${timeoutMs} ms`] }; finished = true; child.kill('SIGKILL'); }
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (msg.tier) { ranOn = msg.tier; continue; }
          if (msg.done) { finished = true; if (msg.jit) jit.push(msg.jit); continue; }
          results[msg.i] = msg;
          next = msg.i + 1;
          clearTimeout(timer);
          timer = setTimeout(onTimeout, timeoutMs);
        }
      });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', () => {
        clearTimeout(timer);
        if (!finished && next < programs.length) {
          results[next] = { h: 'CRASH', brief: [`CRASH ${err.trim().split('\n').slice(-3).join(' | ')}`] };
          launch(next + 1);
        } else if (results[next] && results[next].h === 'TIMEOUT') launch(next + 1);
        else launch(programs.length);
      });
    };
    launch(0);
  });
}

const uninteresting = (r) => !r || r.h === 'TIMEOUT' || r.h === 'CRASH' || r.brief.some((s) => s.includes('RangeError'));

async function differs(forms, tier, opts) {
  const progs = [forms.map(show)];
  const [a, b] = await Promise.all([runTier('ev', progs, opts), runTier(tier, progs, opts)]);
  const ra = a.results[0], rb = b.results[0];
  return !uninteresting(ra) && !uninteresting(rb) && ra.h !== rb.h;
}

function size(x) { return Array.isArray(x) ? 1 + x.reduce((s, y) => s + size(y), 0) : 1; }

// Every program one edit smaller: a form dropped, a subexpression replaced by
// one of its own parts, by 0 or nil, or a list element removed.
function candidates(forms) {
  const out = [];
  forms.forEach((_, k) => out.push(forms.filter((__, j) => j !== k)));
  const walk = (node, replace) => {
    if (!Array.isArray(node)) {
      if (node !== 0 && node !== 'nil') { replace(0); replace('nil'); }
      return;
    }
    for (const child of node) {
      if (Array.isArray(child)) {
        replace(child);
        for (const grand of child) if (Array.isArray(grand)) replace(grand);
      } else if (child && typeof child === 'object') replace(child.q);
    }
    replace(0);
    replace('nil');
    for (let i = 1; i < node.length; i++) if (node.length > 2) replace([...node.slice(0, i), ...node.slice(i + 1)]);
    node.forEach((child, i) => walk(child, (r) => replace(Object.assign([...node], { [i]: r }))));
  };
  forms.forEach((f, k) => walk(f, (r) => out.push(Object.assign([...forms], { [k]: r }))));
  const seen = new Set();
  return out.map((p) => [size(p), p]).sort((x, y) => x[0] - y[0]).filter(([, p]) => {
    const key = JSON.stringify(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(([, p]) => p);
}

async function shrink(forms, tier, opts) {
  if (!(await differs(forms, tier, opts))) return { forms, isolated: false };
  let best = forms;
  for (let round = 0; round < 300; round++) {
    const cands = candidates(best).filter((c) => size(c) < size(best)).slice(0, 400);
    if (cands.length === 0) break;
    const progs = cands.map((c) => c.map(show));
    const [a, b] = await Promise.all([runTier('ev', progs, opts), runTier(tier, progs, opts)]);
    const hits = cands.filter((_, j) => !uninteresting(a.results[j]) && !uninteresting(b.results[j]) && a.results[j].h !== b.results[j].h);
    let next = null;
    for (const c of hits.slice(0, 20)) if (await differs(c, tier, opts)) { next = c; break; }
    if (next === null) break;
    best = next;
  }
  return { forms: best, isolated: true };
}

async function parent() {
  const seed = Number(opt('--seed', 1));
  const count = Number(opt('--count', 2000));
  const reps = Number(opt('--reps', 20));
  const tiers = opt('--tiers', 'ev,closure,js').split(',').filter((t) => t !== 'ev');
  const timeoutMs = Number(opt('--timeout', 10000));
  const messages = flag('--messages');
  const opts = { reps, timeoutMs, messages };
  const only = opt('--only', null);

  if (flag('--show')) {
    const n = Number(opt('--show', 3));
    for (let i = 0; i < n; i++) console.log(`; program ${i}\n${programAt(seed, i).map(show).join('\n')}\n`);
    return 0;
  }

  const t0 = performance.now();
  const indices = only !== null ? [Number(only)] : Array.from({ length: count }, (_, i) => i);
  const programs = indices.map((i) => programAt(seed, i));
  const texts = programs.map((p) => p.map(show));
  const runs = await Promise.all(['ev', ...tiers].map((t) => runTier(t, texts, opts)));
  const [ev, ...rest] = runs;

  let failures = 0;
  for (const [k, tier] of tiers.entries()) {
    if (rest[k].ranOn !== tier) { console.log(`FAIL ${tier}: child ran on ${rest[k].ranOn}`); failures++; }
  }
  if (ev.ranOn !== 'ev') { console.log(`FAIL oracle ran on ${ev.ranOn}`); failures++; }

  const mismatches = [];
  indices.forEach((idx, j) => {
    for (const [k, tier] of tiers.entries()) {
      if (ev.results[j].h !== rest[k].results[j].h) mismatches.push({ idx, j, tier });
    }
  });
  for (const m of mismatches.filter((m) => [ev, rest[tiers.indexOf(m.tier)]].some((t) => t.results[m.j].h === 'TIMEOUT'))) {
    const slow = { ...opts, timeoutMs: timeoutMs * 6 };
    const [a, b] = await Promise.all([runTier('ev', [texts[m.j]], slow), runTier(m.tier, [texts[m.j]], slow)]);
    if (a.results[0].h === b.results[0].h) {
      ev.results[m.j] = a.results[0];
      rest[tiers.indexOf(m.tier)].results[m.j] = b.results[0];
      mismatches.splice(mismatches.indexOf(m), 1);
    }
  }
  const stats = { error: 0, timeout: 0 }, kinds = {};
  for (const r of ev.results) {
    if (r.h === 'TIMEOUT') stats.timeout++;
    else if (r.brief.some((s) => s.startsWith('ERR'))) stats.error++;
    for (const s of r.brief) if (s.startsWith('ERR')) kinds[s] = (kinds[s] || 0) + 1;
  }
  if (flag('--stats')) console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${n}  ${k}`).join('\n'));
  if (only !== null) {
    console.log(texts[0].join('\n'));
    for (const [n, t] of [['ev', ev], ...tiers.map((tier, k) => [tier, rest[k]])]) console.log(`${n.padEnd(8)} ${t.results[0].h}  ${t.results[0].brief.join(' | ')}`);
  }

  const shown = new Set();
  for (const [n, m] of mismatches.entries()) {
    failures++;
    if (n === 10) console.log(`\n... and ${mismatches.length - 10} more mismatches`);
    if (n >= 10) continue;
    console.log(`\nMISMATCH seed ${seed} program ${m.idx} on ${m.tier}  (rerun: node test/fuzz-tiers.mjs --seed ${seed} --only ${m.idx})`);
    console.log(`  ev       ${ev.results[m.j].brief.join(' | ')}`);
    console.log(`  ${m.tier.padEnd(8)} ${rest[tiers.indexOf(m.tier)].results[m.j].brief.join(' | ')}`);
    if (shown.size >= 3 || flag('--no-shrink')) continue;
    shown.add(m.idx);
    const { forms, isolated } = await shrink(programs[m.j], m.tier, opts);
    if (!isolated) { console.log('  (does not reproduce alone: depends on earlier programs in the run)'); continue; }
    const [a, b] = await Promise.all([runTier('ev', [forms.map(show)], opts), runTier(m.tier, [forms.map(show)], opts)]);
    console.log(`  minimal repro (${size(forms)} nodes, from ${size(programs[m.j])}), then (fz-main 1) .. (fz-main ${reps}):`);
    for (const f of forms) console.log('    ' + show(f));
    console.log(`  ev       ${a.results[0].brief.join(' | ')}`);
    console.log(`  ${m.tier.padEnd(8)} ${b.results[0].brief.join(' | ')}`);
    console.log(`  try: BEL_TIER=${m.tier} node bin/bel.mjs ${forms.map((f) => `-e "${show(f)}"`).join(' ')} -e "(fz-main 1)"`);
  }
  for (const [k, tier] of tiers.entries()) {
    const js = rest[k].jit;
    if (!js.length) continue;
    const reasons = {};
    for (const j of js) for (const [r, n] of Object.entries(j.reasons || {})) reasons[r] = (reasons[r] || 0) + n;
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${n} ${r}`).join('; ');
    console.log(`${tier} tier: ${js.reduce((s, j) => s + j.compiled, 0)} functions compiled, ${js.reduce((s, j) => s + j.rejected, 0)} rejected${top ? ` (${top})` : ''}, ${js.reduce((s, j) => s + j.invalidated, 0)} invalidated`);
  }
  fs.rmSync(tmpdir, { recursive: true, force: true });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\nfuzz: seed ${seed}, ${indices.length} programs x ${reps} calls, ev vs ${tiers.join(', ')}, ${secs}s: ` +
    `${mismatches.length} mismatches (${stats.error} programs raise errors on ev, ${stats.timeout} time out)`);
  return failures ? 1 : 0;
}

if (flag('--child')) await child(opt('--child'), Number(opt('--start', 0)));
else process.exitCode = await parent();

// Runs the interpreter's suites under every execution tier, one process per
// (suite, tier), and prints a table. Each suite reads BEL_TIER through the Bel
// constructor and reports the tier it actually ran on, which must match.
//
//   node test/tiers.mjs                         golden-hi (320x200; skipped on ev, the slow tier), jets-off,
//                                               golden-lo (160x100), basics, examples on ev, closure, js
//   node test/tiers.mjs --suites basics,examples --tiers ev,closure
//   node test/tiers.mjs --root ~/.capy/work/jitroot
//                                               engine from a stable snapshot: golden.mjs gets --root DIR
//                                               (engine and interpreter from DIR); jets-off runs with cwd DIR
//                                               (engine, WAD and bel.bel from DIR, interpreter from this checkout)
//   node test/tiers.mjs --gate                  also the cross-tier suites: reflect.mjs, fuzz-tiers.mjs
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const tiers = opt('--tiers', 'ev,closure,js').split(',');
const suites = opt('--suites', 'golden-hi,jets-off,golden-lo,basics,examples').split(',');
const repo = path.resolve(here, '..');
const root = path.resolve(opt('--root', repo));
const SUITES = {
  'jets-off': { cwd: root },
  'golden-lo': { script: 'golden.mjs', args: ['--modes', 'lo', '--root', root] },
  'golden-hi': { script: 'golden.mjs', args: ['--modes', 'hi', '--root', root], ev: { skip: true } },
  golden: { args: ['--modes', 'lo,hi', '--root', root], cost: 2 },
  basics: {},
  examples: {},
};
const jobs = Number(opt('--jobs', Math.min(4, os.cpus().length)));
const gate = argv.includes('--gate');

function runNode(script, args, env, timeoutMs, cwd = repo) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [path.join(here, script), ...args], { cwd, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += `\nTIMEOUT after ${timeoutMs / 1000} s`; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, ms: performance.now() - t0 });
    });
  });
}

// Starts tasks in order whenever the cores they need (their cost: golden runs
// two modes, fuzz one process per tier) are free; a task that does not fit
// lets later, smaller ones go first.
function schedule(tasks, cap) {
  return new Promise((resolve) => {
    const results = new Array(tasks.length);
    const pending = tasks.map((t, i) => i);
    let used = 0, running = 0;
    const pump = () => {
      for (let k = 0; k < pending.length; k++) {
        const i = pending[k], c = Math.min(tasks[i].cost, cap);
        if (running > 0 && used + c > cap) continue;
        pending.splice(k--, 1);
        used += c;
        running++;
        tasks[i].run().then((r) => {
          results[i] = r;
          used -= c;
          running--;
          if (pending.length === 0 && running === 0) resolve(results);
          else pump();
        });
      }
    };
    pump();
  });
}

// Longest jobs first, so the slowest (golden-hi on closure) sets the wall clock.
const WEIGHT = { 'golden-hi': { closure: 9, js: 6 }, 'golden-lo': { ev: 7, closure: 4, js: 3 }, 'jets-off': { ev: 6, closure: 5, js: 4 } };
const cells = [];
for (const suite of suites) for (const tier of tiers) cells.push({ suite, tier, w: (WEIGHT[suite] || {})[tier] || 0 });
if (gate) {
  cells.push({ suite: 'reflect', tier: tiers.join(','), cross: ['--jobs', '2'], cost: 2, w: 3 });
  cells.push({ suite: 'fuzz-tiers', tier: tiers.join(','), cross: [], cost: tiers.length, w: 3 });
}
const order = cells.map((c, i) => i).sort((a, b) => cells[b].w - cells[a].w);
const specOf = (suite, tier) => {
  const sp = SUITES[suite] || {};
  return { script: `${suite}.mjs`, cwd: repo, args: [], cost: 1, ...sp, ...(sp[tier] || {}) };
};
const done = await schedule(order.map((i) => ({ cost: cells[i].cost || specOf(cells[i].suite, cells[i].tier).cost, run: async () => {
  const { suite, tier, cross } = cells[i];
  if (cross) {
    const r = await runNode(`${suite}.mjs`, ['--tiers', tier, ...cross], {}, 900_000);
    return { suite, tier, cross, ok: r.code === 0, why: `exit ${r.code}`, ms: r.ms, out: r.out };
  }
  const spec = specOf(suite, tier);
  if (spec.skip) return { suite, tier, ok: true, skip: true, ms: 0, out: '' };
  const r = await runNode(spec.script, spec.args, { BEL_TIER: tier }, 600_000, spec.cwd);
  const ran = [...new Set([...r.out.matchAll(/\(tier (\w+)\)/g)].map((m) => m[1]))].join('+') || '?';
  const ok = r.code === 0 && ran === tier;
  const why = r.code !== 0 ? `exit ${r.code}` : ran !== tier ? `ran on ${ran}` : '';
  return { suite, tier, ok, why, ms: r.ms, out: r.out };
} })), jobs);
const results = [];
order.forEach((i, k) => { results[i] = done[k]; });

const pad = (s, n) => String(s).padEnd(n);
const cellText = (r) => (r.skip ? 'skip' : `${r.ok ? 'pass' : 'FAIL ' + r.why} ${(r.ms / 1000).toFixed(1)}s`);
console.log(pad('suite', 12) + tiers.map((t) => pad(t, 20)).join(''));
for (const suite of suites) {
  const row = tiers.map((tier) => cellText(results.find((r) => !r.cross && r.suite === suite && r.tier === tier)));
  console.log(pad(suite, 12) + row.map((c) => pad(c, 20)).join(''));
}
for (const r of results.filter((r) => r.cross)) {
  console.log(`${pad(r.suite, 12)}${pad(cellText(r), 20)}${r.out.trim().split('\n').slice(-1)[0]}`);
}
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`\n--- ${r.suite} on ${r.tier} (${r.why}) ---\n${r.out.trim().split('\n').slice(r.cross ? -60 : -30).join('\n')}`);
process.exit(failed.length ? 1 : 0);

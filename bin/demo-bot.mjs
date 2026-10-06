#!/usr/bin/env node
// Usage: node bin/demo-bot.mjs [OUT=bin/demo-route.txt] [maxTics=2000]   (PLAN='[...]' env overrides the waypoint plan)
// Closed-loop route bot: plays the functional Bel engine headless along waypoints (lift, door, barrels, north room),
// turns to and shoots monsters it can see, and writes the keys it pressed per tic as a doom-record/doom-live script.
// It reads the world through `at` and the engine's own clear-line/point-sector, so retune it when those change.
import './bigstack.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { splitPacket, splitSounds } = await import(pathToFileURL(path.join(root, 'web/protocol.js')).href);
const { Bel } = await import(pathToFileURL(path.join(root, 'interp/bel.js')).href);
const DEFAULT_PLAN = '[{"x":-150,"y":256},{"x":40,"y":256},{"x":128,"y":256,"r":16},{"idle":45},{"x":260,"y":256},{"x":580,"y":256},{"x":700,"y":300},{"x":800,"y":400},{"x":832,"y":468,"r":16},{"x":832,"y":475,"face":1.5708,"r":30},{"use":true,"wait":10},{"x":832,"y":470,"face":1.5708,"r":40},{"door":[832,528]},{"x":832,"y":616,"r":10,"range":1000},{"x":832,"y":616,"r":40,"face":0,"range":1000},{"shoot":[960,616],"tics":60},{"x":608,"y":672,"range":1000},{"x":608,"y":800,"r":24,"range":1000},{"x":680,"y":880,"range":1000},{"x":680,"y":960,"range":1000},{"x":616,"y":1024,"r":24,"range":1000},{"x":680,"y":1100,"range":1000},{"x":680,"y":1300,"range":1000},{"x":616,"y":1376,"r":24,"range":1000},{"x":760,"y":1300,"range":1000},{"x":832,"y":1000,"range":1000},{"x":832,"y":760,"range":1000},{"idle":30}]';
const bel = new Bel({ readFile: (p) => { const f = path.join(root, p); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; } });
bel.loadFile('doom/main.bel');
bel.evalString(`(def bot-state (w) (list (at 'px w) (at 'py w) (at 'pangle w) (at 'health w) (at 'ammo w)))`);
bel.evalString(`(def bot-monsters (w)
  (map [list (at 'x _) (at 'y _) (at 'hp _) 1 (at 'class _) (at 'state _)
             (if (clear-line (at 'grid (at 'lv w)) (at 'heights w) (at 'px w) (at 'py w) (eye-z w) (at 'x _) (at 'y _) (+ (car (nth (+ (at 'sec _) 1) (at 'heights w))) 28)) 1 0)]
       (keep [and (at 'info _) (at 'shootable _) (< (dist (at 'x _) (at 'y _) (at 'px w) (at 'py w)) 1100)] (at 'mobjs w))))`);
bel.evalString(`(def bot-gap (w x y) (let (f c) (nth (+ (point-sector (at 'root (at 'lv w)) x y) 1) (at 'heights w)) (- c f)))`);
let world = bel.call('doom-init', 'wad/e1m1.wad');
bel.takeOutput();
const W = bel.evalString('(* screen-w screen-h)');
let st = null;
const readState = () => { st = bel.print(bel.call('bot-state', world)).replace(/[()]/g, '').trim().split(/\s+/).map(Number); };
readState();
const num = (k) => ({ px: st[0], py: st[1], pangle: st[2], health: st[3], ammo: st[4] })[k];
const eng = { frame(keys) {
  world = bel.call('doom-frame', world, keys);
  const f = splitPacket(bel.takeOutput(), 'F', W);
  readState();
  return { sounds: splitSounds(f.text).sounds };
} };
const MONSTERS = new Set(['zombie', 'sergeant', 'imp', 'demon']);
function monsters() {
  const s = bel.print(bel.call('bot-monsters', world));
  const out = [];
  for (const m of s.matchAll(/\(([-\d.e]+) ([-\d.e]+) ([-\d.e]+) (\d) (\S+) (\S+) (\d)\)/g))
    out.push({ x: +m[1], y: +m[2], hp: +m[3], shoot: true, cls: m[5], state: m[6], los: m[7] === '1' });
  return out.filter((m) => MONSTERS.has(m.cls) && m.hp > 0);
}
const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

const plan = JSON.parse(process.env.PLAN || DEFAULT_PLAN);
const maxTics = Number(process.argv[3] || 2000);
const keysLog = [];
let fightSince = -1, wp = 0, wpStart = 0, waitUntil = 0, lastPos = null, stuck = 0, kills = 0, fights = 0;
for (let t = 0; t < maxTics; t++) {
  const px = num('px'), py = num('py'), pa = num('pangle'), hp = num('health');
  let keys = '';
  const step = plan[wp];
  const ms = monsters().filter((m) => m.los && Math.hypot(m.x - px, m.y - py) < (step && step.range || 650));
  if (hp <= 0) keys = '';
  else if (t < waitUntil) keys = '';
  else if (ms.length && !(step && step.ignore)) {
    ms.sort((a, b) => Math.hypot(a.x - px, a.y - py) - Math.hypot(b.x - px, b.y - py));
    const m = ms[0], want = Math.atan2(m.y - py, m.x - px), diff = norm(want - pa);
    const z = Math.hypot(m.x - px, m.y - py), lat = Math.abs(Math.sin(diff)) * z;
    if (Math.abs(diff) > 0.05) keys += diff > 0 ? 'a' : 'd';
    if (lat < 14 + 0.06 * z && Math.cos(diff) > 0) keys += 'f';
    if (fightSince < 0) fightSince = t;
    wpStart = t;
    if (t - fightSince > 50 && t % 15 === 0) keys = keys.replace('f', '') + 'u';
    fights++;
  } else if (step) {
    fightSince = -1;
    if (step.door) {
      const gap = Number(bel.print(bel.call('bot-gap', world, step.door[0], step.door[1])));
      if (gap >= 72) { wp++; wpStart = t; console.error(`tic ${t}: door open (gap ${gap})`); }
      else if (t % 2 === 0) keys = 'u';
    } else if (step.shoot) {
      const want = Math.atan2(step.shoot[1] - py, step.shoot[0] - px), diff = norm(want - pa);
      if (Math.abs(diff) > 0.03) keys += diff > 0 ? 'a' : 'd';
      else keys += 'f';
      if (!step.until) step.until = t + step.tics;
      if (t >= step.until) { wp++; wpStart = t; }
    } else if (step.use) { keys = 'u'; wp++; wpStart = t; waitUntil = t + 1 + (step.wait || 0); }
    else if (step.idle) { wp++; wpStart = t; waitUntil = t + step.idle; }
    else {
      const d = Math.hypot(step.x - px, step.y - py);
      const want = Math.atan2(step.y - py, step.x - px), diff = norm((step.face ?? want) - pa);
      if (d < (step.r || 20)) {
        if (step.face !== undefined && Math.abs(norm(step.face - pa)) > 0.04) keys += norm(step.face - pa) > 0 ? 'a' : 'd';
        else { wp++; wpStart = t; console.error(`tic ${t}: reached waypoint ${wp} (${step.x},${step.y}) hp ${hp}`); }
      } else {
        const tdiff = norm(want - pa);
        if (Math.abs(tdiff) > 0.04) keys += tdiff > 0 ? 'a' : 'd';
        if (Math.abs(tdiff) < 0.5) keys += 'w';
        if (step.run) keys += 'r';
        if (lastPos && Math.hypot(px - lastPos[0], py - lastPos[1]) < 0.5 && keys.includes('w')) stuck++; else stuck = 0;
        if (stuck > 8 && stuck % 12 === 9) keys += 'u';
        else if (stuck > 15) { keys += (t >> 4) & 1 ? 'q' : 'e'; }
        if (t - wpStart > (step.timeout || 250)) { console.error(`tic ${t}: gave up on waypoint ${wp + 1} at ${px.toFixed(0)},${py.toFixed(0)}`); wp++; wpStart = t; }
      }
    }
  } else if (plan.end) { break; }
  else keys = '';
  if (process.env.DEBUG && t % 20 === 0 && t >= +process.env.DEBUG) console.error(`t${t} pos ${px.toFixed(0)},${py.toFixed(0)} a ${pa.toFixed(2)} hp ${hp} wp ${wp} stuck ${stuck} keys ${keys} near ${JSON.stringify(monsters().filter((m) => Math.hypot(m.x - px, m.y - py) < 900).map((m) => [m.cls, Math.round(m.x), Math.round(m.y), m.state, m.los]))}`);
  lastPos = [px, py];
  keys = [...'wsadqerfu'].filter((c) => keys.includes(c)).join('');
  keysLog.push(keys);
  const f = eng.frame(keys);
  if (f.sounds.some((x) => /DTH/.test(x))) fightSince = -1;
  if (f.sounds.includes('DSBAREXP')) console.error(`tic ${t}: barrel explosion x${f.sounds.filter((x) => x === 'DSBAREXP').length}`);
  if (f.sounds.includes('DSPODTH1') || f.sounds.includes('DSPODTH2') || f.sounds.includes('DSBGDTH1') || f.sounds.includes('DSSGTDTH')) { kills++; console.error(`tic ${t}: kill (${f.sounds.join(' ')}) at ${px.toFixed(0)},${py.toFixed(0)}`); }
  if (wp >= plan.length && t >= waitUntil) { console.error(`tic ${t}: route done`); break; }
}
const rl = [];
for (const k of keysLog) { const last = rl[rl.length - 1]; if (last && last[0] === k) last[1]++; else rl.push([k, 1]); }
const outFile = process.argv[2] || path.join(root, 'bin/demo-route.txt');
fs.writeFileSync(outFile, rl.map(([k, n]) => `${k || '-'}:${n}`).join(' ') + '\n');
console.error(`tics ${keysLog.length}, kills ${kills}, fight tics ${fights}, health ${num('health')}, ammo ${num('ammo')}, pos ${num('px').toFixed(0)},${num('py').toFixed(0)}, wp ${wp}/${plan.length}`);

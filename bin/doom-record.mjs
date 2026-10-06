#!/usr/bin/env node
// Headless recorder: runs the Bel Doom engine on a scripted key sequence and writes PNGs, MP4 and/or GIF.
//   node bin/doom-record.mjs [--script "w:35 wd:20 f:5 -:10"] [--script-file F] [--frames N]
//        [--out DIR] [--mp4 FILE] [--gif FILE] [--wav FILE] [--raw FILE|-] [--scale S] [--gif-scale S] [--gif-fps F] [--fps 35] [--hires | --res WxH] [--tier ev|closure|js]
//        [--sounds wad/sounds.wad] [--audio-rate 22050] [--no-audio] [--wad wad/e1m1.wad] [--root DIR] [--quiet]
// A script is whitespace/comma separated KEYS:TICS steps (KEYS from "wsadqerfu", "-" or empty = none).
// One tic = one doom-frame call = one output frame. --frames N truncates the script or pads it with idle tics.
// --hires runs at 320x200 and --res WxH at any size the engine's doom-init accepts. Default scales give 640x480 PNG/MP4 and a 320x240 GIF at either detail.
// The engine's S<lump> sound events are mixed from sounds.wad into the MP4's AAC track (and --wav), at tic times.
import './bigstack.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = '-:10 w:40 wd:12 w:30 wa:18 wr:25 f:8 -:8 f:8 u:2 s:12 e:16 q:16 d:30 wr:30 a:20 w:20';
const opt = { root: path.resolve(here, '..'), wad: 'wad/e1m1.wad', script: null, frames: null, out: null, mp4: null, gif: null, raw: null, wav: null, sounds: 'wad/sounds.wad', audio: true, audioRate: 22050, scale: null, gifScale: null, gifFps: null, fps: 35, quiet: false, hires: false, res: null, tier: null };
const argv = process.argv.slice(2);
const usage = () => { console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(2); };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => { if (i + 1 >= argv.length) usage(); return argv[++i]; };
  if (a === '--root') opt.root = path.resolve(v());
  else if (a === '--wad') opt.wad = v();
  else if (a === '--hires') opt.hires = true;
  else if (a === '--res') opt.res = v();
  else if (a === '--tier') opt.tier = v();
  else if (a === '--script') opt.script = v();
  else if (a === '--script-file') opt.script = fs.readFileSync(v(), 'utf8').replace(/#.*$/gm, '');
  else if (a === '--frames') opt.frames = Number(v());
  else if (a === '--out') opt.out = v();
  else if (a === '--mp4') opt.mp4 = v();
  else if (a === '--gif') opt.gif = v();
  else if (a === '--raw') opt.raw = v();
  else if (a === '--wav') opt.wav = v();
  else if (a === '--sounds') opt.sounds = v();
  else if (a === '--audio-rate') opt.audioRate = Number(v());
  else if (a === '--no-audio') opt.audio = false;
  else if (a === '--scale') opt.scale = Number(v());
  else if (a === '--gif-scale') opt.gifScale = Number(v());
  else if (a === '--gif-fps') opt.gifFps = Number(v());
  else if (a === '--fps') opt.fps = Number(v());
  else if (a === '--quiet' || a === '-q') opt.quiet = true;
  else usage();
}

const steps = [];
for (const tok of (opt.script ?? (opt.frames ? '' : DEMO)).split(/[\s,]+/).filter(Boolean)) {
  const m = tok.match(/^([wsadqerfu-]*):(\d+)$/);
  if (!m) { console.error(`bad script step "${tok}" (want KEYS:TICS)`); process.exit(2); }
  for (let i = 0; i < Number(m[2]); i++) steps.push(m[1].replace(/-/g, ''));
}
let total = opt.frames ?? steps.length;
if (!total) { console.error('nothing to record: empty script'); process.exit(2); }

const { bootEngine, parseRes, columnsToRows, scaleIndexed, displaySize, loadSounds } = await import(pathToFileURL(path.join(here, '../web/protocol.js')).href);
const { Bel } = await import(pathToFileURL(path.join(opt.root, 'interp/bel.js')).href);
const say = (s) => { if (!opt.quiet) process.stderr.write(s + '\n'); };

const readFile = (p) => { const f = path.resolve(opt.root, p); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; };
const eng = bootEngine({
  Bel,
  readFile,
  wad: opt.wad,
  hires: opt.hires,
  res: parseRes(opt.res),
  tier: opt.tier || undefined,
  status: (s) => say(`bel-doom: ${s}`),
  log: (s) => { if (s && !opt.quiet) process.stderr.write(s.replace(/^/gm, '  | ').replace(/  \| $/, '')); },
});
const { w, h, palette } = eng;
say(`bel-doom: ready in ${(eng.initMs / 1000).toFixed(1)} s, screen ${w}x${h}, recording ${total} frames`);

let lumps = null;
if (opt.audio && (opt.mp4 || opt.wav)) {
  const bytes = readFile(opt.sounds);
  if (bytes) lumps = loadSounds(bytes);
  else say(`bel-doom: ${opt.sounds} not found (run tools/mksounds.py); recording without audio`);
}
const soundEvents = [];

opt.scale ??= Math.max(1, Math.round(640 / w));
opt.gifScale ??= Math.max(1, Math.round(320 / w));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const [pw, ph] = displaySize(w, h, opt.scale);
const [vw, vh] = [even(pw), even(ph)];
const [gw, gh] = displaySize(w, h, opt.gifScale);

function ffmpeg(args, file) {
  const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(opt.fps), '-i', '-', ...args, file],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  p.done = new Promise((res, rej) => p.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c} for ${file}`)))));
  return p;
}
const sinks = [];
const videoFile = opt.mp4 && lumps ? `${opt.mp4}.video.mp4` : opt.mp4;
if (opt.mp4) sinks.push(ffmpeg(['-vf', `scale=${vw}:${vh}:flags=neighbor`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], videoFile));
if (opt.gif) sinks.push(ffmpeg(['-vf', `${opt.gifFps ? `fps=${opt.gifFps},` : ''}scale=${gw}:${gh}:flags=neighbor,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, '-loop', '0'], opt.gif));
const rawOut = opt.raw === '-' ? process.stdout : opt.raw ? fs.createWriteStream(opt.raw) : null;
if (opt.out) fs.mkdirSync(opt.out, { recursive: true });

function pngIndexed(idx, iw, ih, pal) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(iw, 0); ihdr.writeUInt32BE(ih, 4); ihdr[8] = 8; ihdr[9] = 3;
  const raw = Buffer.alloc((iw + 1) * ih);
  for (let y = 0; y < ih; y++) raw.set(idx.subarray(y * iw, (y + 1) * iw), y * (iw + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(pal)),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const write = (stream, buf) => new Promise((res) => { if (stream.write(buf)) res(); else stream.once('drain', res); });
for (const s of [...sinks.map((p) => p.stdin), rawOut].filter(Boolean)) s.on('error', (e) => { console.error(`bel-doom: output failed: ${e.message}`); process.exit(1); });

const rows = new Uint8Array(w * h), scaled = new Uint8Array(pw * ph), rgb = Buffer.alloc(w * h * 3);
let sum = 0, min = Infinity, max = 0;
const t0 = performance.now();
for (let i = 0; i < total; i++) {
  const keys = steps[i] ?? '';
  let f;
  try { f = eng.frame(keys); } catch (e) {
    console.error(`bel-doom: engine failed at frame ${i + 1}: ${e.message}; finishing outputs with ${i} frames`);
    process.exitCode = 1;
    total = i;
    break;
  }
  sum += f.ms; min = Math.min(min, f.ms); max = Math.max(max, f.ms);
  for (const name of new Set(f.sounds)) soundEvents.push({ tic: i, name });
  columnsToRows(f.frame, w, h, rows);
  if (opt.out) {
    scaleIndexed(rows, w, h, pw, ph, scaled);
    fs.writeFileSync(path.join(opt.out, `frame-${String(i + 1).padStart(5, '0')}.png`), pngIndexed(scaled, pw, ph, palette));
  }
  if (sinks.length || rawOut) {
    for (let p = 0; p < w * h; p++) { const c = rows[p] * 3; rgb[p * 3] = palette[c]; rgb[p * 3 + 1] = palette[c + 1]; rgb[p * 3 + 2] = palette[c + 2]; }
    const copy = Buffer.from(rgb);
    await Promise.all([...sinks.map((s) => write(s.stdin, copy)), rawOut && write(rawOut, copy)]);
  }
  if (!opt.quiet && ((i + 1) % 10 === 0 || i + 1 === total)) process.stderr.write(`frame ${i + 1}/${total} keys=${keys || '-'} ${f.ms.toFixed(0)} ms\n`);
}
for (const s of sinks) s.stdin.end();
if (rawOut && rawOut !== process.stdout) rawOut.end();
await Promise.all(sinks.map((s) => s.done));

// Mono mix at tic times, Doom-style 8 voices: a new sound beyond 8 cuts off the oldest one still playing.
function mixAudio() {
  const R = opt.audioRate, len = Math.round(total * R / opt.fps), mix = new Float32Array(len), voices = [];
  for (const ev of soundEvents) {
    const s = lumps.get(ev.name);
    if (!s) { say(`bel-doom: no sound lump ${ev.name}`); continue; }
    const start = Math.round(ev.tic * R / opt.fps);
    const v = { s, start, end: start + Math.ceil(s.samples.length * R / s.rate) };
    const playing = voices.filter((o) => o.end > start);
    if (playing.length >= 8) playing[0].end = start;
    voices.push(v);
  }
  for (const { s, start, end } of voices) {
    const step = s.rate / R, src = s.samples;
    for (let j = start, t = 0; j < Math.min(end, len); j++, t += step) {
      const i0 = Math.floor(t), fr = t - i0;
      if (i0 >= src.length) break;
      mix[j] += 0.6 * (src[i0] * (1 - fr) + (i0 + 1 < src.length ? src[i0 + 1] : 0) * fr);
    }
  }
  const pcm = Buffer.alloc(len * 2);
  let sq = 0;
  for (let j = 0; j < len; j++) { const x = Math.max(-1, Math.min(1, mix[j])); sq += x * x; pcm.writeInt16LE(Math.round(x * 32767), j * 2); }
  return { pcm, rms: Math.sqrt(sq / Math.max(1, len)) };
}
let audioRms = null;
if (lumps) {
  const { pcm, rms } = mixAudio();
  audioRms = rms;
  if (opt.wav) {
    const hd = Buffer.alloc(44);
    hd.write('RIFF', 0); hd.writeUInt32LE(36 + pcm.length, 4); hd.write('WAVEfmt ', 8); hd.writeUInt32LE(16, 16);
    hd.writeUInt16LE(1, 20); hd.writeUInt16LE(1, 22); hd.writeUInt32LE(opt.audioRate, 24); hd.writeUInt32LE(opt.audioRate * 2, 28);
    hd.writeUInt16LE(2, 32); hd.writeUInt16LE(16, 34); hd.write('data', 36); hd.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(opt.wav, Buffer.concat([hd, pcm]));
  }
  if (opt.mp4) {
    const mux = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoFile, '-f', 's16le', '-ar', String(opt.audioRate), '-ac', '1', '-i', '-',
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', opt.mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
    mux.stdin.end(pcm);
    await new Promise((res, rej) => mux.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg mux exited ${c}`)))));
    fs.unlinkSync(videoFile);
  }
}
const wall = (performance.now() - t0) / 1000;
console.error(`bel-doom: ${total} frames in ${wall.toFixed(1)} s, init ${(eng.initMs / 1000).toFixed(1)} s, ` +
  `avg ${(sum / Math.max(1, total)).toFixed(1)} ms/frame in Bel (min ${min.toFixed(1)}, max ${max.toFixed(1)}), ${(1000 * total / sum).toFixed(2)} fps engine-only`);
const counts = {};
for (const ev of soundEvents) counts[ev.name] = (counts[ev.name] || 0) + 1;
if (soundEvents.length) console.error(`  sounds: ${soundEvents.length} events ${Object.entries(counts).map(([n, c]) => `${n}x${c}`).join(' ')}`);
const audioNote = lumps ? ` + AAC ${opt.audioRate} Hz mono, rms ${audioRms.toFixed(4)}` : '';
for (const [k, v] of [['png', opt.out && `${opt.out}/ (${pw}x${ph})`], ['mp4', opt.mp4 && `${opt.mp4} (${vw}x${vh}${audioNote})`], ['wav', lumps && opt.wav], ['gif', opt.gif && `${opt.gif} (${gw}x${gh})`]]) if (v) console.error(`  ${k}: ${v}`);

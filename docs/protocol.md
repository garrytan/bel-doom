# Engine and host protocol

The Doom engine in `doom/*.bel` talks to its host only through Bel's default output stream (`outs`) and the arguments of its entry points. The host is the hardware: it keeps time, shows pixels, plays samples and reports held keys. It never runs game logic.

The browser host runs the engine in a pool of Web Workers. Each worker holds a full copy of the game, every worker runs the same tics with the same keys, and each draws one vertical slice of every frame. The main thread owns the 35 Hz clock and stitches the slices.

## Entry points

The engine is functional: the whole game is one value, the world, that the host holds and passes back.

- `(doom-init path width height)` reads the WAD, writes the palette packet and returns the world. `width` and `height` default to 160x100 (Doom's low-detail mode); 320x200 is Doom's full resolution and 640x480 is the high-resolution target.
- `(doom-tick world keys)` runs one tic (Doom runs 35 a second), writes that tic's sound packets and returns the next world.
- `(doom-draw world)` writes the frame packet for the world and returns it unchanged.
- `(doom-draw-slice world x0 x1)` writes a frame packet with only screen columns `x0` to `x1` (inclusive). Its bytes are exactly those columns of `doom-draw`'s packet.
- `(doom-frame world keys)` is `(doom-draw (doom-tick world keys))`, for hosts that draw every tic (the recorder, the terminal player, the golden test).

`keys` is a string of the keys held during the tic:

| Char | Action |
|---|---|
| `w` / `s` | forward / back |
| `a` / `d` | turn left / right |
| `q` / `e` | strafe left / right |
| `r` | run |
| `f` | fire |
| `u` | use (doors, switches) |

Hosts that call `doom-init` without a size can load `doom/hires.bel` after `doom/main.bel` to make 320x200 the default.

## Packets written to `outs`

All bytes are Bel characters with codes 0-255, written with `prc` (the engine makes them with `(nchar n)`).

| Packet | Layout | When |
|---|---|---|
| Palette | `P` + 768 bytes (RGB for 256 colors, PLAYPAL palette 0) | once, during `doom-init` |
| Sound | `S` + sound lump name in ASCII (e.g. `DSPISTOL`) + `\n` | any number per tic, during `doom-tick` |
| Frame | `F` + `width * height` bytes, column-major (each column top to bottom, columns left to right), each a palette index with lighting already applied | once per `doom-draw` |
| Frame slice | `F` + `(x1 - x0 + 1) * height` bytes, the same layout for columns `x0` to `x1` | once per `doom-draw-slice` |

Because frames are column-major, a slice is one contiguous run of the full frame: it belongs at byte offset `x0 * height`.

The palette lookup is the host's job, like the VGA DAC on a PC. Lighting is not: the engine applies COLORMAP itself. Sound samples come from `wad/sounds.wad`, which only the host reads, like Doom's DMX sound library mixing lumps the game names.

`web/protocol.js` decodes these packets and boots the engine for the browser workers, the terminal player and the recorder.

## The browser host: clock and render pool

### Clock

`web/pool.js` on the main thread is the only clock. The game runs at 35 tics per second of wall time:

- Each loop works out the tics that are due (`floor(elapsed * 35) - tic`), runs at most 5 of them, then asks for one frame. Older debt is dropped and counted, so a slow machine plays slower instead of lurching.
- At most 2 frames are outstanding with several workers, and 1 with a single worker.
- Keys are sampled per tic. A key pressed and released between two tics still counts for the next tic.
- The clock stops while the tab is hidden or the game is paused (Esc), and resumes without catching up the time it was stopped.
- A script (one key string per tic, e.g. from `bin/doom-live.mjs`) replaces the keyboard for as many tics as it has steps.

fps counts frames actually drawn. The game-speed readout counts tics per second and reads 35 when the game keeps real time.

### Workers

Each worker (`web/worker.js`) runs one Bel interpreter with the whole engine. Workers run every tic, in the same order, with the same keys, so their worlds stay identical. For each frame, each worker draws its own range of columns.

Messages from the pool to a worker:

| Message | Fields |
|---|---|
| `start` | `wad`, `hires`, `res` (`[width, height]`), `tier`, `cutSlices` |
| `run` | `gen` (resolution generation), `frame` (frame id), `from` (the tic the worker must be at), `keys` (one key string per tic to run), `x0`, `x1` (columns to draw), `sounds` (whether to return sound events) |

For `run`, the worker checks that it is at tic `from`, runs one `doom-tick` per entry of `keys`, then draws columns `x0` to `x1` with `doom-draw-slice`. An engine without `doom-draw-slice` draws a full frame and the worker cuts the columns out: the same bytes, without the speedup. An engine without `doom-tick` gets one key string per `run` and one `doom-frame`.

Messages from a worker to the pool:

| Message | Fields |
|---|---|
| `status`, `log`, `error` | `text` |
| `init` | `w`, `h`, `palette`, `ms` (boot time), `split` (has `doom-tick` and `doom-draw`), `sliceApi` (has `doom-draw-slice`) |
| `slice` | `gen`, `frame`, `tic` (the tic after this run), `x0`, `x1`, `data` (the column bytes, transferred), `sounds` (one list of lump names per tic, or null), `step`, `render`, `write` (ms), `digest` (or null) |

### Stitching and sound

The pool keeps each requested frame until every worker has returned its slice for that `gen` and `frame`, copies each slice to offset `x0 * height`, and presents the frame. Slices for a frame the pool no longer waits for, or from another resolution generation, are dropped.

Only the first worker returns sounds. Each tic's sounds start 1/35 s after the previous tic's, so a frame that carries several tics keeps their spacing.

### Slice layout

Slices start at equal widths. Once the engine has `doom-draw-slice`, the pool keeps a cost estimate per column (each slice's render time divided by its width, averaged over frames) and moves the boundaries so every slice costs about the same. Each slice is at least 8 columns wide.

### Lockstep check and fallback

When a `run` crosses a multiple of 35 tics, every worker returns a digest of the gameplay state: the tic, the player's `px`, `py`, `pangle`, `health` and `ammo`, the number of things, and the sums of the things' `x`, `y` and `hp`.

The pool drops to one worker, which takes the full width and carries on, when:

- the digests of the same tic differ (logged with each worker's digest);
- a worker reports an error, including a `run` whose `from` does not match its tic;
- a frame is still missing slices after `max(2 s, 8 x the average frame time)`.

If the last worker fails, the page shows the error.

## Page parameters

| Parameter | Effect |
|---|---|
| `?res=WxH` | screen size, passed to `doom-init` (e.g. `640x480`) |
| `?hires=1` | 320x200 |
| `?workers=N` | number of workers. The default is one per 40,000 pixels (1 at 160x100, 2 at 320x200, 8 at 640x480), capped at `cores - 2`, 8 and `deviceMemory GB x 1024 x 0.6 / 600` (2 when the browser does not report `deviceMemory`); it drops to one worker when the engine has no `doom-draw-slice` |
| `?slices=cut` | ignore `doom-draw-slice` and cut slices out of full frames (for comparing) |
| `?tier=ev\|closure\|js` | the highest execution tier the interpreter uses |
| `?paused=1` | start paused (Esc starts the game) |
| `?wad=PATH` | another level WAD |
| `?touch=1\|0` | force the on-screen touch controls on or off (by default they appear on touch-first devices, or at the first touch) |

Touch controls (`web/touch.js`) produce the same key letters as the keyboard: a floating stick on the left half of the screen gives `w`/`s` and `a`/`d`, plus `r` when dragged past its ring while moving; the buttons give `f`, `u`, `q` and `e`. Each finger is tracked by its pointer id. The pause button and a tap on the pause overlay replace Esc.

The backtick key (or tapping the fps readout) shows an overlay with fps, game speed, tics per frame, step, render, write, transfer and draw times, dropped tics, and each worker's times and columns.

For tools driving the page, `window.belDoom.script(steps)` hands the clock a per-tic key script, `window.belDoom.workers` is the current worker count, and the page fires `beldoom-init` and `beldoom-frame` events (with the frame, its tic, tics per frame, timings and worker count). `window.belDoom.debug` injects faults for testing the fallback: `skewKeys(i)` gives worker `i` different keys for one frame, `silence(i)` stops it without telling the pool, and `extraTic(i)` makes it run an extra tic.

## Tools

- `node bin/doom-live.mjs --script-file bin/demo-route.txt [--res WxH] [--workers N] [--slices cut] [--tier T] [--no-video] [--checksums FILE] [--out live.mp4]` plays the page in headless Chromium, feeds the script to the clock, and reports presented fps, game speed, p50/p95 frame time, tics per frame, step/render/write times, dropped tics, worker count and lockstep mismatches. `--no-video` skips screen capture, which otherwise costs frames. `--checksums` writes a hash of every presented frame by tic, so runs with different worker counts can be compared byte for byte.
- `node bin/doom-record.mjs` and `node bin/doom-term.mjs` take `--res WxH` and `--tier T` and run `doom-frame` on one engine.
- `node test/golden.mjs` hashes every output byte of scripted scenes at 160x100 and 320x200 (and `--modes 640x480`) against `test/golden-hashes.json`.

## Changelog

- 2026-10-06: Touch controls for phones and tablets; `?touch`; the default worker count follows the screen size.
- 2026-10-06: Render pool. The main thread owns the clock; workers replicate the simulation and draw column slices with `(doom-draw-slice w x0 x1)`; digests every 35 tics and fallback to one worker; `?workers` and `?slices`; `doom-live --workers/--slices/--checksums`.
- 2026-10-06: The tic and the frame split into `doom-tick` and `doom-draw`, with a fixed 35 Hz clock and per-tic input and sound; `doom-init` takes a width and height.
- 2026-10-06: Sound packets.

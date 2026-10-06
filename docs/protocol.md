# Engine and host protocol

The Doom engine in `doom/*.bel` talks to its host only through Bel's default output stream (`outs`) and the arguments of two entry points. The host is the hardware: it shows pixels, plays samples and reports held keys. It never runs game logic.

## Entry points

The engine is functional: the whole game is one value, the world, that the host holds and passes back.

- `(doom-init "wad/e1m1.wad")` reads the WAD, writes the palette packet and returns the world.
- `(doom-frame world keys)` writes the sound and frame packets for the next tic (Doom runs 35 tics a second) and returns the next world. `keys` is a string of the keys held during the tic:

| Char | Action |
|---|---|
| `w` / `s` | forward / back |
| `a` / `d` | turn left / right |
| `q` / `e` | strafe left / right |
| `r` | run |
| `f` | fire |
| `u` | use (doors, switches) |

- Loading `doom/hires.bel` after `doom/main.bel` and before `doom-init` switches from the default 160x100 (Doom's low-detail width) to 320x200.

## Packets written to `outs`

All bytes are Bel characters with codes 0-255, written with `prc` (the engine makes them with `(nchar n)`).

| Packet | Layout | When |
|---|---|---|
| Palette | `P` + 768 bytes (RGB for 256 colors, PLAYPAL palette 0) | once, during `doom-init` |
| Sound | `S` + sound lump name in ASCII (e.g. `DSPISTOL`) + `\n` | any number per tic, before the frame packet |
| Frame | `F` + `screen-w * screen-h` bytes, column-major (each column top to bottom, columns left to right), each a palette index with lighting already applied | once per `doom-frame` |

The host reads `screen-w` and `screen-h` from the Bel globals of the same names.

The palette lookup is the host's job, like the VGA DAC on a PC. Lighting is not: the engine applies COLORMAP itself. Sound samples come from `wad/sounds.wad`, which only the host reads, like Doom's DMX sound library mixing lumps the game names.

`web/protocol.js` decodes this protocol for the browser, the terminal player and the recorder.

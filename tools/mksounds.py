#!/usr/bin/env python3
"""Build wad/sounds.wad: a small PWAD with the DMX sound lumps the host "sound card" plays.

Source: Freedoom 0.13.0 freedoom1.wad (BSD licensed, see wad/COPYING-freedoom.txt).
The Bel engine never reads this file; it writes S<lumpname>\\n packets and the host
(web/main.js, bin/doom-record.mjs) loads and mixes the samples (see docs/protocol.md).

Monster sounds cover the monster types placed in E1M1's THINGS, which the script
checks against the map: zombieman 3004, shotgun guy 9, imp 3001, demon 3002, spectre 58.
"""
import os, struct, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get('FREEDOOM_WAD', 'freedoom1.wad')
OUT = os.path.join(ROOT, 'wad', 'sounds.wad')

PLAYER = ['DSPLPAIN', 'DSPLDETH', 'DSPDIEHI', 'DSOOF', 'DSNOWAY', 'DSSLOP']
WEAPONS = ['DSPISTOL', 'DSSHOTGN', 'DSSGCOCK', 'DSPUNCH']
WORLD = ['DSDOROPN', 'DSDORCLS', 'DSBDOPN', 'DSBDCLS', 'DSSWTCHN', 'DSSWTCHX',
         'DSPSTART', 'DSPSTOP', 'DSSTNMOV', 'DSITEMUP', 'DSWPNUP', 'DSGETPOW',
         'DSBAREXP', 'DSTELEPT']
MONSTERS = {  # thing type: (name, sight, active, pain, death, attack)
    3004: ('zombieman', ['DSPOSIT1', 'DSPOSIT2', 'DSPOSIT3'], ['DSPOSACT'], ['DSPOPAIN'],
           ['DSPODTH1', 'DSPODTH2', 'DSPODTH3'], ['DSPISTOL']),
    9: ('shotgun guy', ['DSPOSIT1', 'DSPOSIT2', 'DSPOSIT3'], ['DSPOSACT'], ['DSPOPAIN'],
        ['DSPODTH1', 'DSPODTH2', 'DSPODTH3'], ['DSSHOTGN']),
    3001: ('imp', ['DSBGSIT1', 'DSBGSIT2'], ['DSBGACT'], ['DSPOPAIN'],
           ['DSBGDTH1', 'DSBGDTH2'], ['DSCLAW', 'DSFIRSHT', 'DSFIRXPL']),
    3002: ('demon', ['DSSGTSIT'], ['DSDMACT'], ['DSDMPAIN'], ['DSSGTDTH'], ['DSSGTATK']),
    58: ('spectre', ['DSSGTSIT'], ['DSDMACT'], ['DSDMPAIN'], ['DSSGTDTH'], ['DSSGTATK']),
    3006: ('lost soul', [], ['DSDMACT'], ['DSDMPAIN'], ['DSFIRXPL'], ['DSSKLATK']),
    3005: ('cacodemon', ['DSCACSIT'], ['DSDMACT'], ['DSDMPAIN'], ['DSCACDTH'], ['DSFIRSHT', 'DSFIRXPL']),
    3003: ('baron', ['DSBRSSIT'], ['DSDMACT'], ['DSDMPAIN'], ['DSBRSDTH'], ['DSFIRSHT', 'DSFIRXPL']),
}


def read_wad(path):
    data = open(path, 'rb').read()
    n, off = struct.unpack_from('<ii', data, 4)
    lumps = []
    for i in range(n):
        pos, size, name = struct.unpack_from('<ii8s', data, off + 16 * i)
        lumps.append((name.rstrip(b'\0').decode('ascii'), data[pos:pos + size]))
    return lumps


def main():
    lumps = read_wad(SRC)
    names = [n for n, _ in lumps]
    m = names.index('E1M1')
    things = next(d for n, d in lumps[m + 1:m + 11] if n == 'THINGS')
    present = {struct.unpack_from('<h', things, i + 6)[0] for i in range(0, len(things), 10)}
    wanted = PLAYER + WEAPONS + WORLD
    for t, (label, *groups) in MONSTERS.items():
        if t in present:
            print(f'E1M1 has {label} ({t})')
            for g in groups:
                wanted += g
    wanted = list(dict.fromkeys(wanted))
    by_name = dict(lumps)
    out = []
    for name in wanted:
        d = by_name.get(name)
        if d is None:
            sys.exit(f'missing sound lump {name} in {SRC}')
        fmt, rate, count = struct.unpack_from('<HHI', d, 0)
        if fmt != 3 or count > len(d) - 8:
            sys.exit(f'{name}: not a DMX format-3 sound')
        out.append((name, d))
    body = b''.join(d for _, d in out)
    directory = bytearray()
    pos = 12
    for name, d in out:
        directory += struct.pack('<ii8s', pos, len(d), name.encode('ascii'))
        pos += len(d)
    with open(OUT, 'wb') as f:
        f.write(b'PWAD' + struct.pack('<ii', len(out), 12 + len(body)) + body + directory)
    print(f'wrote {os.path.relpath(OUT, ROOT)}: {len(out)} lumps, {os.path.getsize(OUT)} bytes')
    print(' '.join(name for name, _ in out))


if __name__ == '__main__':
    main()

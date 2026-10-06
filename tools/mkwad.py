#!/usr/bin/env python3
"""Build wad/e1m1.wad: a small PWAD with only what the Bel Doom engine needs.

Source: Freedoom 0.13.0 freedoom1.wad (BSD licensed, see wad/COPYING-freedoom.txt).

Layout (chosen so the Bel loader can parse it cheaply):
  header | directory (at offset 12) | PLAYPAL COLORMAP | E1M1 + 8 map lumps |
  TEXTURE1 (TEXTURE1+TEXTURE2 merged, pruned) | PNAMES (pruned, reindexed) | patches | flats | graphics |
  S_START sprites S_END
"""
import os, shutil, struct, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get('FREEDOOM_WAD',
                     '/home/user/.capy/work/ref/freedoom-0.13.0/freedoom1.wad')
OUT = os.path.join(ROOT, 'wad', 'e1m1.wad')
MAP = 'E1M1'
MAP_LUMPS = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS',
             'SSECTORS', 'NODES', 'SECTORS']
EXTRA_TEXTURES = ['SKY1']
GRAPHICS = (['STBAR', 'STARMS', 'STYSNUM2', 'STTPRCNT', 'STFDEAD0'] +
            ['STGNUM%d' % i for i in range(3, 8)] +
            ['STTNUM%d' % i for i in range(10)] +
            ['STFST%d%d' % (i, j) for i in range(5) for j in range(3)])
# Sprites for the things on E1M1, the pistol, puffs and blood.  Monsters get
# every rotation of their walk frames, front views of attack and pain frames,
# and their death frames; everything else gets the listed frames.
MONSTER_SPRITES = {          # walk, attack + pain, death
    'POSS': ('ABCD', 'EFG', 'HIJKL'),
    'SPOS': ('ABCD', 'EFG', 'HIJKL'),
    'TROO': ('ABCD', 'EFGH', 'IJKLM'),
    'SARG': ('ABCD', 'EFGH', 'IJKLMN'),
}
SPRITES = {
    'BAR1': 'AB', 'BEXP': 'ABCDE', 'BON1': 'ABCD', 'BON2': 'ABCD', 'SMIT': 'A',
    'SHEL': 'A', 'TRE2': 'A', 'TRE1': 'A', 'ROCK': 'A', 'COLU': 'A', 'STIM': 'A',
    'MEDI': 'A', 'SBOX': 'A', 'AMMO': 'A', 'SHOT': 'A', 'PLAY': 'NW', 'ELEC': 'A',
    'CLIP': 'A', 'ARM1': 'AB', 'GOR4': 'A', 'MGUN': 'A', 'BROK': 'A', 'POL5': 'A',
    'LAUN': 'A', 'CELP': 'A', 'CSAW': 'A', 'BKEY': 'AB', 'PLAS': 'A', 'POL6': 'AB',
    'SOUL': 'ABCD', 'ARM2': 'AB', 'CELL': 'A', 'BPAK': 'A', 'PSTR': 'A',
    'PUFF': 'ABCD', 'BLUD': 'ABC', 'PISG': 'ABCDE', 'PISF': 'A',
}


def want_sprite(name):
    prefix, frame, rot = name[:4], name[4], name[5]
    if prefix in MONSTER_SPRITES:
        walk, front, death = MONSTER_SPRITES[prefix]
        return frame in walk or frame in death or (frame in front and rot == '1')
    return frame in SPRITES.get(prefix, '')


def name8(b):
    return b.split(b'\0', 1)[0].decode('ascii').upper()


def pad8(s):
    return s.encode('ascii')[:8].ljust(8, b'\0')


def main():
    data = open(SRC, 'rb').read()
    _, count, diroff = struct.unpack_from('<4sii', data, 0)
    lumps = []
    for i in range(count):
        off, size, nm = struct.unpack_from('<ii8s', data, diroff + 16 * i)
        lumps.append((name8(nm), data[off:off + size]))
    names = [n for n, _ in lumps]

    def find(nm, start=0, end=None):
        end = len(lumps) if end is None else end
        for i in range(start, end):
            if names[i] == nm:
                return i
        raise KeyError(nm)

    def lump(nm, start=0, end=None):
        return lumps[find(nm, start, end)][1]

    m = find(MAP)
    maplumps = {n: lump(n, m + 1, m + 12) for n in MAP_LUMPS}
    # Normalize texture and flat names to upper case so Bel can compare symbols.
    sd = bytearray(maplumps['SIDEDEFS'])
    for k in range(len(sd) // 30):
        for f in range(3):
            o = k * 30 + 4 + 8 * f
            sd[o:o + 8] = pad8(name8(sd[o:o + 8]))
    maplumps['SIDEDEFS'] = bytes(sd)
    sec = bytearray(maplumps['SECTORS'])
    for k in range(len(sec) // 26):
        for f in range(2):
            o = k * 26 + 4 + 8 * f
            sec[o:o + 8] = pad8(name8(sec[o:o + 8]))
    maplumps['SECTORS'] = bytes(sec)

    used_tex = set(EXTRA_TEXTURES)
    sd = maplumps['SIDEDEFS']
    for k in range(len(sd) // 30):
        for t in struct.unpack_from('<8s8s8s', sd, k * 30 + 4):
            t = name8(t)
            if t != '-':
                used_tex.add(t)
    used_flats = []
    sec = maplumps['SECTORS']
    for k in range(len(sec) // 26):
        for fl in struct.unpack_from('<8s8s', sec, k * 26 + 4):
            fl = name8(fl)
            if fl not in used_flats:
                used_flats.append(fl)

    pn = lump('PNAMES')
    pnames = [name8(pn[4 + 8 * i:12 + 8 * i]) for i in range(struct.unpack_from('<i', pn)[0])]

    textures = []
    for tl in ('TEXTURE1', 'TEXTURE2'):
        if tl not in names:
            continue
        tex1 = lump(tl)
        for i in range(struct.unpack_from('<i', tex1)[0]):
            o = struct.unpack_from('<i', tex1, 4 + 4 * i)[0]
            tname = name8(tex1[o:o + 8])
            _, w, h, _, npatch = struct.unpack_from('<ihhih', tex1, o + 8)
            patches = [struct.unpack_from('<hhhhh', tex1, o + 22 + 10 * p) for p in range(npatch)]
            if tname in used_tex and tname not in {t[0] for t in textures}:
                textures.append((tname, w, h, patches))
    missing = used_tex - {t[0] for t in textures}
    if missing:
        print('warning: textures not found:', sorted(missing), file=sys.stderr)

    new_pnames = []
    for _, _, _, patches in textures:
        for _, _, pi, _, _ in patches:
            if pnames[pi] not in new_pnames:
                new_pnames.append(pnames[pi])

    t1 = bytearray(struct.pack('<i', len(textures)))
    body = bytearray()
    base = 4 + 4 * len(textures)
    for tname, w, h, patches in textures:
        t1 += struct.pack('<i', base + len(body))
        body += pad8(tname) + struct.pack('<ihhih', 0, w, h, 0, len(patches))
        for ox, oy, pi, sd_, cm in patches:
            body += struct.pack('<hhhhh', ox, oy, new_pnames.index(pnames[pi]), sd_, cm)
    t1 += body

    pn_out = struct.pack('<i', len(new_pnames)) + b''.join(pad8(p) for p in new_pnames)

    fstart, fend = find('F_START'), find('F_END')
    out = [('PLAYPAL', lump('PLAYPAL')[:768]), ('COLORMAP', lump('COLORMAP')),
           (MAP, b'')]
    out += [(n, maplumps[n]) for n in MAP_LUMPS]
    out += [('TEXTURE1', bytes(t1)), ('PNAMES', pn_out)]
    pstart = find('P_START') if 'P_START' in names else 0
    for p in new_pnames:
        out.append((p, lump(p, pstart)))
    for fl in used_flats:
        out.append((fl, lump(fl, fstart, fend)))
    for g in GRAPHICS:
        out.append((g, lump(g)))
    out.append(('S_START', b''))
    for i in range(find('S_START') + 1, find('S_END')):
        if want_sprite(names[i]):
            out.append(lumps[i])
    out.append(('S_END', b''))

    dirsize = 16 * len(out)
    offset = 12 + dirsize
    directory = bytearray()
    payload = bytearray()
    for nm, d in out:
        directory += struct.pack('<ii', offset + len(payload), len(d)) + pad8(nm)
        payload += d
    wad = b'PWAD' + struct.pack('<ii', len(out), 12) + directory + payload
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, 'wb').write(wad)
    shutil.copy(os.path.join(os.path.dirname(SRC), 'COPYING.txt'),
                os.path.join(ROOT, 'wad', 'COPYING-freedoom.txt'))
    print(f'{OUT}: {len(wad)} bytes, {len(out)} lumps, {len(textures)} textures, '
          f'{len(new_pnames)} patches, {len(used_flats)} flats')


if __name__ == '__main__':
    main()

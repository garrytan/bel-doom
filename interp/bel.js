// A fast interpreter for Paul Graham's Bel (bel.bel, 9 October 2019).
//
// The evaluator implements Bel's axioms directly: the primitives, the special
// forms (quote, lit, if, apply, where, dyn, after, ccc), closures that are
// plain lists of the form (lit clo env parms body), macros of the form
// (lit mac clo), and dynamic/lexical/global lookup in that order.  It then
// loads the unmodified bel.bel, so every definition in the spec exists exactly
// as written.  For speed, a set of hot definitions are replaced afterwards by
// native "jets" with the same behavior, macro expansions are cached per call
// site, and the core macros fn, do, set, def, mac, let and rfn are evaluated
// natively while their global values are still the ones bel.bel defined.
// Numbers are IEEE doubles (a deliberate deviation from Bel's exact rationals).

class Sym {
  constructor(name) {
    this.name = name;
    this.gcell = null;   // global binding cell (sym . value)
    this.lexb = false;   // has ever been bound lexically
    this.dynb = false;   // has ever been bound dynamically
    this.lit = false;    // t nil o apply
    this.sf = 0;         // special form code
    this.nat = false;    // core macro evaluated natively while true
    this.cnode = null;   // compiled reference node
  }
}

class Pair {
  constructor(a, d) { this.a = a; this.d = d; this.x = null; this.c = null; }
}

class Char {
  constructor(c) { this.c = c; }
}

class Stream {
  constructor(dir, path) {
    this.dir = dir;          // 'in' | 'out'
    this.path = path;
    this.data = null;        // Uint8Array for input
    this.pos = 0;            // byte position
    this.bit = 0;            // bit offset within current byte (MSB first)
    this.reader = null;      // function () -> byte | -1 (lazy input)
    this.buf = new Uint8Array(1024);
    this.len = 0;            // bytes written
    this.wbyte = 0;
    this.wbits = 0;
    this.peeked = null;
    this.closed = false;
    this.sink = null;        // function (Uint8Array) for output
  }
  putByte(b) {
    if (this.len === this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.len++] = b;
    if (this.sink && this.len >= 65536) this.flush();
  }
  flush() {
    if (this.sink && this.len) {
      this.sink(this.buf.slice(0, this.len));
      this.len = 0;
    }
  }
  take() {
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    return out;
  }
  ensure() {
    if (this.data && this.pos < this.data.length) return true;
    if (!this.reader) return false;
    const b = this.reader();
    if (b < 0 || b === undefined || b === null) return false;
    this.data = Uint8Array.of(b);
    this.pos = 0;
    return true;
  }
  readByte() {
    if (this.bit !== 0) {
      let v = 0;
      for (let i = 0; i < 8; i++) {
        const b = this.readBit();
        if (b < 0) return -1;
        v = (v << 1) | b;
      }
      return v;
    }
    if (!this.ensure()) return -1;
    return this.data[this.pos++];
  }
  readBit() {
    if (!this.ensure()) return -1;
    const byte = this.data[this.pos];
    const b = (byte >> (7 - this.bit)) & 1;
    if (++this.bit === 8) { this.bit = 0; this.pos++; }
    return b;
  }
  writeBit(b) {
    this.wbyte = (this.wbyte << 1) | b;
    if (++this.wbits === 8) {
      this.putByte(this.wbyte);
      this.wbyte = 0;
      this.wbits = 0;
    }
  }
}

class BelError extends Error {
  constructor(value, text) {
    super(text);
    this.value = value;
  }
}

class ContThrow {
  constructor(k, v) { this.k = k; this.v = v; }
}

class MacroCache {
  constructor(m, exp) { this.m = m; this.exp = exp; }
}

const symtab = new Map();
function sym(name) {
  let s = symtab.get(name);
  if (!s) { s = new Sym(name); symtab.set(name, s); }
  return s;
}

const chartab = new Map();
function chr(code) {
  if (code < 256) return CHARS[code];
  let c = chartab.get(code);
  if (!c) { c = new Char(code); chartab.set(code, c); }
  return c;
}
const CHARS = [];
for (let i = 0; i < 256; i++) CHARS.push(new Char(i));

const NIL = sym('nil'), T = sym('t'), O = sym('o'), APPLY = sym('apply');
for (const s of [NIL, T, O, APPLY]) s.lit = true;
const QUOTE = sym('quote'), LIT = sym('lit'), CLO = sym('clo'), MAC = sym('mac'),
  PRIM = sym('prim'), CONT = sym('cont'), IF = sym('if'), WHERE = sym('where'),
  DYN = sym('dyn'), AFTER = sym('after'), CCC = sym('ccc'), THREAD = sym('thread'),
  FN = sym('fn'), DO = sym('do'), SET = sym('set'), DEF = sym('def'), LET = sym('let'),
  RFN = sym('rfn'), BQUOTE = sym('bquote'), COMMA = sym('comma'),
  COMMA_AT = sym('comma-at'), SCOPE = sym('scope'), GLOBE = sym('globe'),
  ERR = sym('err'), A = sym('a'), D = sym('d'), VMARK_SYM = sym('vmark'),
  VIRFNS = sym('virfns'), INS = sym('ins'), OUTS = sym('outs'), CHARS_SYM = sym('chars'),
  EOF = sym('eof'), IN = sym('in'), OUT = sym('out'), CLOSED = sym('closed'),
  SYMBOL = sym('symbol'), PAIR = sym('pair'), CHAR = sym('char'),
  STREAM = sym('stream'), NUMBER = sym('number'), COMPOSE = sym('compose'),
  NO = sym('no'), TAB = sym('tab'), UPON = sym('upon'), UNDERSCORE = sym('_'), UNBOUNDB = sym('unboundb');

const SF_QUOTE = 1, SF_LIT = 2, SF_IF = 3, SF_WHERE = 4, SF_DYN = 5, SF_AFTER = 6,
  SF_CCC = 7, SF_THREAD = 8, SF_BQUOTE = 9, SF_FN = 10, SF_DO = 11, SF_SET = 12,
  SF_DEF = 13, SF_MAC = 14, SF_LET = 15, SF_RFN = 16, SF_WHEN = 17, SF_UNLESS = 18,
  SF_AND = 19, SF_OR = 20, SF_CASE = 21, SF_WITH = 22, SF_WITHS = 23, SF_FOR = 24,
  SF_WHILE = 25, SF_REPEAT = 26, SF_TIL = 27, SF_LOOP = 28;
const WHEN = sym('when'), UNLESS = sym('unless'), AND = sym('and'), OR = sym('or'),
  CASE = sym('case'), WITH = sym('with'), WITHS = sym('withs'), FOR = sym('for'),
  WHILE = sym('while'), REPEAT = sym('repeat'), TIL = sym('til'), LOOP = sym('loop');
WHEN.sf = SF_WHEN; UNLESS.sf = SF_UNLESS; AND.sf = SF_AND; OR.sf = SF_OR; CASE.sf = SF_CASE;
WITH.sf = SF_WITH; WITHS.sf = SF_WITHS; FOR.sf = SF_FOR; WHILE.sf = SF_WHILE;
REPEAT.sf = SF_REPEAT; TIL.sf = SF_TIL; LOOP.sf = SF_LOOP;
for (const s of [WHEN, UNLESS, AND, OR, CASE, WITH, WITHS, FOR, WHILE, REPEAT, TIL, LOOP]) s.nat = true;
QUOTE.sf = SF_QUOTE; LIT.sf = SF_LIT; IF.sf = SF_IF; WHERE.sf = SF_WHERE;
DYN.sf = SF_DYN; AFTER.sf = SF_AFTER; CCC.sf = SF_CCC; THREAD.sf = SF_THREAD;
BQUOTE.sf = SF_BQUOTE;
FN.sf = SF_FN; DO.sf = SF_DO; SET.sf = SF_SET; DEF.sf = SF_DEF; MAC.sf = SF_MAC;
LET.sf = SF_LET; RFN.sf = SF_RFN;
for (const s of [FN, DO, SET, DEF, MAC, LET, RFN]) s.nat = true;

let VMARK = undefined;   // the value of the global vmark, once bel.bel sets it
let loading = true;      // true while bel.bel itself is being loaded
const dyn = [];          // dynamic binding cells, innermost last

function cons(a, d) { return new Pair(a, d); }
function list(...xs) {
  let r = NIL;
  for (let i = xs.length - 1; i >= 0; i--) r = new Pair(xs[i], r);
  return r;
}
function arrToList(xs, start = 0, tail = NIL) {
  let r = tail;
  for (let i = xs.length - 1; i >= start; i--) r = new Pair(xs[i], r);
  return r;
}
function listToArr(l) {
  const out = [];
  for (; l instanceof Pair; l = l.d) out.push(l.a);
  return out;
}
function str(s) {
  let r = NIL;
  const cps = Array.from(s);
  for (let i = cps.length - 1; i >= 0; i--) r = new Pair(chr(cps[i].codePointAt(0)), r);
  return r;
}
function jsstr(l) {
  let s = '';
  for (; l instanceof Pair; l = l.d) {
    if (!(l.a instanceof Char)) sigerr(sym('not-string'));
    s += String.fromCodePoint(l.a.c);
  }
  return s;
}
const truth = (b) => (b ? T : NIL);

function isVariable(e) {
  if (e instanceof Sym) return !e.lit;
  return e instanceof Pair && e.a === VMARK && VMARK !== undefined;
}

function isString(x) {
  if (x === NIL) return false;
  for (; x instanceof Pair; x = x.d) if (!(x.a instanceof Char)) return false;
  return x === NIL;
}

function isLiteral(e) {
  if (e instanceof Sym) return e.lit;
  if (e instanceof Char || e instanceof Stream || typeof e === 'number') return true;
  if (e instanceof Pair) return e.a === LIT || isString(e);
  return true;
}

// ---------------------------------------------------------------- errors

let errContext = null;   // parameter list being bound, for error messages only

function sigerr(msg) {
  for (let i = dyn.length - 1; i >= 0; i--) {
    if (dyn[i].a === ERR) return applyF(dyn[i].d, [msg]);
  }
  let text = 'Bel error: ' + printString(msg);
  if (errContext !== null && (msg === sym('underargs') || msg === sym('overargs') || msg === sym('atom-arg') || msg === sym('mistype'))) {
    text += ' (binding parameters ' + printString(errContext) + ')';
  }
  errContext = null;
  throw new BelError(msg, text);
}

// ---------------------------------------------------------------- lookup

function lookup(s, a) {
  if (s.dynb) {
    for (let i = dyn.length - 1; i >= 0; i--) if (dyn[i].a === s) return dyn[i];
  }
  if (s.lexb) {
    for (let p = a; p instanceof Pair; p = p.d) if (p.a.a === s) return p.a;
  }
  return s.gcell;
}

function lookupPair(v, a) {
  for (let i = dyn.length - 1; i >= 0; i--) if (dyn[i].a === v) return dyn[i];
  for (let p = a; p instanceof Pair; p = p.d) if (p.a.a === v) return p.a;
  return null;
}

function globalCell(s) {
  if (!s.gcell) s.gcell = new Pair(s, NIL);
  return s.gcell;
}

function setGlobal(s, v) {
  const c = globalCell(s);
  c.d = v;
  if (!loading) s.nat = false;
  if (s === VMARK_SYM) VMARK = v;
}

function assignCell(c, v) {
  c.d = v;
  if (c.a instanceof Sym) {
    if (c.a.gcell === c) {
      if (!loading) c.a.nat = false;
      if (c.a === VMARK_SYM) VMARK = v;
    }
  }
}

function bindVar(v, val, env) {
  if (v instanceof Sym) v.lexb = true;
  return new Pair(new Pair(v, val), env);
}

// ---------------------------------------------------------------- binding

function bind(parms, args, env) {
  let p = parms, i = 0;
  const n = args.length;
  const env0 = env;
  while (p instanceof Pair) {
    const v = p.a;
    if (i >= n || !(v instanceof Sym) || v.lit) {
      errContext = parms;
      const r = pass(parms, arrToList(args), env0);
      errContext = null;
      return r;
    }
    v.lexb = true;
    env = new Pair(new Pair(v, args[i++]), env);
    p = p.d;
  }
  if (p === NIL) {
    if (i < n) { errContext = parms; return sigerr(sym('overargs')); }
    return env;
  }
  if (p instanceof Sym && !p.lit) {
    p.lexb = true;
    return new Pair(new Pair(p, arrToList(args, i)), env);
  }
  errContext = parms;
  const r = pass(parms, arrToList(args), env0);
  errContext = null;
  return r;
}

function pass(pat, arg, env) {
  // fast path: a proper list of plain variables destructuring a list of the same length
  if (pat instanceof Pair && arg instanceof Pair) {
    let p = pat, q = arg, e2 = env;
    while (p instanceof Pair && q instanceof Pair) {
      const v = p.a;
      if (!(v instanceof Sym) || v.lit) break;
      v.lexb = true;
      e2 = new Pair(new Pair(v, q.a), e2);
      p = p.d;
      q = q.d;
    }
    if (p === NIL && q === NIL) return e2;
  }
  if (pat === NIL) {
    if (arg !== NIL) return sigerr(sym('overargs'));
    return env;
  }
  if (isVariable(pat)) return bindVar(pat, arg, env);
  if (!(pat instanceof Pair) || isLiteral(pat)) return sigerr(sym('literal-parm'));
  if (pat.a === T) {
    const v = pat.d.a, f = pat.d.d.a;
    const ok = ev(list(f, list(QUOTE, arg)), env, false);
    if (ok === NIL) return sigerr(sym('mistype'));
    return pass(v, arg, env);
  }
  if (pat.a === O) return pass(pat.d.a, arg, env);
  const p = pat.a, ps = pat.d;
  if (arg === NIL) {
    if (p instanceof Pair && p.a === O) {
      const dexp = p.d instanceof Pair && p.d.d instanceof Pair ? p.d.d.a : NIL;
      const dv = ev(dexp, env, false);
      env = pass(p.d.a, dv, env);
      return pass(ps, NIL, env);
    }
    return sigerr(sym('underargs'));
  }
  if (!(arg instanceof Pair)) return sigerr(sym('atom-arg'));
  env = pass(p, arg.a, env);
  return pass(ps, arg.d, env);
}

// ---------------------------------------------------------------- evaluator

function shadowed(s, a) {
  // a native core macro is only used when the symbol is not lexically or dynamically rebound
  if (!s.lexb && !s.dynb) return false;
  return lookup(s, a) !== s.gcell;
}

function unfindable() { return sigerr(sym('unfindable')); }

function fnBody(fe) {
  // fe = (fn parms . body); returns the closure body, cached on fe
  const c = fe.x;
  if (c !== null && c.fnbody !== undefined) return c.fnbody;
  const body = fe.d.d;
  const b = body instanceof Pair && body.d === NIL ? body.a : new Pair(DO, body);
  fe.x = { fnbody: b };
  return b;
}

function makeClo(env, parms, body) {
  return new Pair(LIT, new Pair(CLO, new Pair(env, new Pair(parms, new Pair(body, NIL)))));
}

function evalArgs(es, a) {
  const out = [];
  for (; es instanceof Pair; es = es.d) {
    const x = es.a;
    if (typeof x === 'number') { out.push(x); continue; }
    if (x instanceof Sym && !x.lit && !x.dynb) {
      let c = null;
      if (x.lexb) {
        for (let p = a; p instanceof Pair; p = p.d) if (p.a.a === x) { c = p.a; break; }
      }
      if (c === null) c = x.gcell;
      if (c !== null) { out.push(c.d); continue; }
    }
    out.push(ev(x, a, false));
  }
  return out;
}

function ev(e, a, w) {
  for (;;) {
    if (e instanceof Sym) {
      if (e.lit) return w ? unfindable() : e;
      let c;
      if (e.dynb) {
        for (let i = dyn.length - 1; i >= 0; i--) if (dyn[i].a === e) { c = dyn[i]; break; }
      }
      if (c === undefined && e.lexb) {
        for (let p = a; p instanceof Pair; p = p.d) if (p.a.a === e) { c = p.a; break; }
      }
      if (c === undefined) c = e.gcell;
      if (c === null) {
        if (e === SCOPE) return w ? unfindable() : a;
        if (e === GLOBE) return w ? unfindable() : globeList();
        if (w === 2) return list(globalCell(e), D);
        return w ? sigerr(sym('unbound')) : sigerr(list(UNBOUNDB, e));
      }
      return w ? list(c, D) : c.d;
    }
    if (!(e instanceof Pair)) return w ? unfindable() : e;
    const op = e.a;
    if (op instanceof Sym) {
      const sf = op.sf;
      if (sf !== 0 && (sf < SF_FN || (op.nat && !shadowed(op, a)))) {
        switch (sf) {
          case SF_QUOTE:
            return w ? unfindable() : e.d.a;
          case SF_LIT:
            return w ? unfindable() : e;
          case SF_IF: {
            let es = e.d;
            for (;;) {
              if (es === NIL) { e = NIL; break; }
              if (es.d === NIL) { e = es.a; break; }
              if (ev(es.a, a, false) !== NIL) { e = es.d.a; break; }
              es = es.d.d;
            }
            continue;
          }
          case SF_WHERE: {
            const place = e.d.a;
            const isNew = e.d.d instanceof Pair ? ev(e.d.d.a, a, false) !== NIL : false;
            return wherePlace(place, a, isNew);
          }
          case SF_DYN: {
            const v = e.d.a;
            if (!isVariable(v)) return sigerr(sym('cannot-bind'));
            const val = ev(e.d.d.a, a, false);
            if (v instanceof Sym) v.dynb = true;
            dyn.push(new Pair(v, val));
            const depth = dyn.length;
            try {
              return ev(e.d.d.d.a, a, w);
            } finally {
              dyn.length = depth - 1;
            }
          }
          case SF_AFTER: {
            try {
              return ev(e.d.a, a, w);
            } finally {
              ev(e.d.d.a, a, false);
            }
          }
          case SF_CCC: {
            const f = ev(e.d.a, a, false);
            return callcc(f);
          }
          case SF_THREAD:
            return sigerr(sym('threads-unsupported'));
          case SF_BQUOTE:
            return w ? unfindable() : qq(e.d.a, a, 0);
          case SF_FN:
            return w ? unfindable() : makeClo(a, e.d.a, fnBody(e));
          case SF_DO: {
            let es = e.d;
            if (es === NIL) { e = NIL; continue; }
            while (es.d instanceof Pair) { ev(es.a, a, false); es = es.d; }
            e = es.a;
            continue;
          }
          case SF_SET:
            return evSet(e.d, a);
          case SF_DEF: {
            const clo = makeClo(a, e.d.d.a, fnBody(e.d));
            assign(e.d.a, clo, a);
            return clo;
          }
          case SF_MAC: {
            const m = list(LIT, MAC, makeClo(a, e.d.d.a, fnBody(e.d)));
            assign(e.d.a, m, a);
            return m;
          }
          case SF_LET: {
            const val = ev(e.d.d.a, a, false);
            const parms = e.d.a;
            if (parms instanceof Sym && !parms.lit) {
              parms.lexb = true;
              a = new Pair(new Pair(parms, val), a);
            } else {
              a = pass(parms, val, a);
            }
            let body = e.d.d.d;
            if (body === NIL) { e = NIL; continue; }
            while (body.d instanceof Pair) { ev(body.a, a, false); body = body.d; }
            e = body.a;
            continue;
          }
          case SF_WHEN:
          case SF_UNLESS: {
            const c = ev(e.d.a, a, false);
            if ((c === NIL) === (sf === SF_WHEN)) { e = NIL; continue; }
            let body = e.d.d;
            if (body === NIL) { e = NIL; continue; }
            while (body.d instanceof Pair) { ev(body.a, a, false); body = body.d; }
            e = body.a;
            continue;
          }
          case SF_AND: {
            let es = e.d;
            if (es === NIL) { e = T; continue; }
            while (es.d instanceof Pair) {
              if (ev(es.a, a, false) === NIL) return w ? unfindable() : NIL;
              es = es.d;
            }
            e = es.a;
            continue;
          }
          case SF_OR: {
            let es = e.d;
            if (es === NIL) { e = NIL; continue; }
            while (es.d instanceof Pair) {
              const v = ev(es.a, a, false);
              if (v !== NIL) return w ? unfindable() : v;
              es = es.d;
            }
            e = es.a;
            continue;
          }
          case SF_CASE: {
            const v = ev(e.d.a, a, false);
            let es = e.d.d;
            for (;;) {
              if (es === NIL) { e = NIL; break; }
              if (es.d === NIL) { e = es.a; break; }
              if (equal(v, es.a)) { e = es.d.a; break; }
              es = es.d.d;
            }
            continue;
          }
          case SF_WITH: {
            const vals = [];
            for (let p = e.d.a; p instanceof Pair; p = p.d.d) vals.push(ev(p.d instanceof Pair ? p.d.a : NIL, a, false));
            let i = 0;
            for (let p = e.d.a; p instanceof Pair; p = p.d.d) {
              const v = p.a;
              if (v instanceof Sym && !v.lit) { v.lexb = true; a = new Pair(new Pair(v, vals[i++]), a); }
              else a = pass(v, vals[i++], a);
            }
            let body = e.d.d;
            if (body === NIL) { e = NIL; continue; }
            while (body.d instanceof Pair) { ev(body.a, a, false); body = body.d; }
            e = body.a;
            continue;
          }
          case SF_WITHS: {
            for (let p = e.d.a; p instanceof Pair; p = p.d.d) {
              const v = p.a;
              const val = ev(p.d instanceof Pair ? p.d.a : NIL, a, false);
              if (v instanceof Sym && !v.lit) { v.lexb = true; a = new Pair(new Pair(v, val), a); }
              else a = pass(v, val, a);
            }
            let body = e.d.d;
            if (body === NIL) { e = NIL; continue; }
            while (body.d instanceof Pair) { ev(body.a, a, false); body = body.d; }
            e = body.a;
            continue;
          }
          case SF_FOR: {
            const v = e.d.a;
            let i = ev(e.d.d.a, a, false);
            const mx = ev(e.d.d.d.a, a, false);
            const body = e.d.d.d.d;
            if (v instanceof Sym) v.lexb = true;
            while (!less(mx, i)) {
              const cell = new Pair(v, i);
              const a2 = new Pair(cell, a);
              for (let b = body; b instanceof Pair; b = b.d) ev(b.a, a2, false);
              i = num(cell.d) + 1;
            }
            return w ? unfindable() : NIL;
          }
          case SF_REPEAT: {
            const n = ev(e.d.a, a, false);
            const body = e.d.d;
            for (let i = 1; !less(n, i); i++) {
              for (let b = body; b instanceof Pair; b = b.d) ev(b.a, a, false);
            }
            return w ? unfindable() : NIL;
          }
          case SF_WHILE: {
            const test = e.d.a;
            const body = e.d.d;
            while (ev(test, a, false) !== NIL) {
              for (let b = body; b instanceof Pair; b = b.d) ev(b.a, a, false);
            }
            return w ? unfindable() : NIL;
          }
          case SF_TIL:
          case SF_LOOP: {
            // (til var expr test . body) = (loop var expr expr (no test) . body)
            const v = e.d.a;
            const init = e.d.d.a;
            const update = sf === SF_TIL ? init : e.d.d.d.a;
            const test = sf === SF_TIL ? e.d.d.d.a : e.d.d.d.d.a;
            const body = sf === SF_TIL ? e.d.d.d.d : e.d.d.d.d.d;
            if (v instanceof Sym) v.lexb = true;
            let val = ev(init, a, false);
            for (;;) {
              const a2 = isVariable(v) && v instanceof Sym ? new Pair(new Pair(v, val), a) : pass(v, val, a);
              const t = ev(test, a2, false);
              if ((sf === SF_TIL) === (t !== NIL)) break;
              for (let b = body; b instanceof Pair; b = b.d) ev(b.a, a2, false);
              val = ev(update, a2, false);
            }
            return w ? unfindable() : NIL;
          }
          case SF_RFN: {
            const name = e.d.a;
            const cell = new Pair(name, NIL);
            if (name instanceof Sym) name.lexb = true;
            const env = new Pair(cell, a);
            const clo = makeClo(env, e.d.d.a, fnBody(e.d));
            cell.d = clo;
            return w ? unfindable() : clo;
          }
        }
      }
    } else if (op === VMARK && VMARK !== undefined) {
      const c = lookupPair(e, a);
      if (c === null) return sigerr(sym('unbound'));
      return w ? list(c, D) : c.d;
    } else if (op instanceof Char) {
      return w ? unfindable() : e;
    }

    // direct application of a lambda: ((fn parms . body) args...)
    if (op instanceof Pair && op.a === FN && FN.nat && !shadowed(FN, a)) {
      const args = evalArgs(e.d, a);
      a = bind(op.d.a, args, a);
      e = fnBody(op);
      continue;
    }

    let f;
    if (op instanceof Sym && !op.lexb && !op.dynb && op.gcell !== null) f = op.gcell.d;
    else f = ev(op, a, false);
    if (f instanceof Pair && f.a === LIT && f.d instanceof Pair && f.d.a === MAC) {
      const mc = e.x;
      let exp;
      if (mc instanceof MacroCache && mc.m === f) {
        exp = mc.exp;
      } else {
        exp = applyF(f.d.d.a, listToArr(e.d));
        e.x = new MacroCache(f, exp);
      }
      e = exp;
      continue;
    }
    let args = evalArgs(e.d, a);
    // apply f to args, in tail position
    if (!w && f instanceof Pair && typeof f.x === 'function') return f.x(args);
    for (;;) {
      if (f instanceof Pair && f.a === LIT && f.d instanceof Pair) {
        const tag = f.d.a;
        if (tag === PRIM) {
          const nf = f.x;
          if (nf === null) return sigerr(sym('unknown-prim'));
          if (w) {
            if (nf.loc) return nf.loc(args);
            nf(args);
            return unfindable();
          }
          return nf(args);
        }
        if (tag === CLO) {
          const r = f.d.d;
          a = bind(r.d.a, args, r.a);
          e = r.d.d.a;
          if (COMPILE && !w) return run(comp(e), a);
          break;
        }
        if (tag === MAC) {
          e = applyF(f.d.d.a, args.map((x) => list(QUOTE, x)));
          break;
        }
        if (tag === CONT) {
          if (args.length !== 1) return sigerr(sym('wrong-no-args'));
          throw new ContThrow(f.x, args[0]);
        }
        if (w && tag === TAB) {
          for (let p = f.d.d; p instanceof Pair; p = p.d) if (equal(p.a.a, args[0])) return list(p.a, D);
          const kv = new Pair(args[0], NIL);
          epoch++;
          f.d.d = new Pair(kv, f.d.d);
          return list(kv, D);
        }
        const vf = virfn(tag);
        if (vf !== null) {
          e = applyF(vf, [f, arrToList(args.map((x) => list(QUOTE, x)))]);
          break;
        }
        return sigerr(sym('unapplyable'));
      }
      if (f === APPLY) {
        if (args.length === 0) return sigerr(sym('cannot-apply'));
        f = args[0];
        const rest = args.slice(1);
        if (rest.length === 0) { args = []; continue; }
        const last = rest.pop();
        args = rest.concat(listToArr(last));
        continue;
      }
      if (typeof f === 'number') {
        if (w) return locNth([f, args[0]]);
        return nth(f, args[0]);
      }
      return sigerr(sym('cannot-apply'));
    }
  }
}

function virfn(tag) {
  const c = VIRFNS.gcell;
  if (!c) return null;
  for (let p = c.d; p instanceof Pair; p = p.d) if (p.a.a === tag) return p.a.d;
  return null;
}

function applyF(f, args) {
  for (;;) {
    if (f instanceof Pair && f.a === LIT && f.d instanceof Pair) {
      const tag = f.d.a;
      if (tag === PRIM) {
        if (f.x === null) return sigerr(sym('unknown-prim'));
        return f.x(args);
      }
      if (tag === CLO) {
        const r = f.d.d;
        const env = bind(r.d.a, args, r.a);
        return COMPILE ? run(comp(r.d.d.a), env) : ev(r.d.d.a, env, false);
      }
      if (tag === MAC) {
        return ev(applyF(f.d.d.a, args.map((x) => list(QUOTE, x))), NIL, false);
      }
      if (tag === CONT) {
        if (args.length !== 1) return sigerr(sym('wrong-no-args'));
        throw new ContThrow(f.x, args[0]);
      }
      const vf = virfn(tag);
      if (vf !== null) return ev(applyF(vf, [f, arrToList(args.map((x) => list(QUOTE, x)))]), NIL, false);
      return sigerr(sym('unapplyable'));
    }
    if (f === APPLY) {
      if (args.length === 0) return sigerr(sym('cannot-apply'));
      const rest = args.slice(1);
      f = args[0];
      if (rest.length === 0) { args = []; continue; }
      const last = rest.pop();
      args = rest.concat(listToArr(last));
      continue;
    }
    if (typeof f === 'number') return nth(f, args[0]);
    return sigerr(sym('cannot-apply'));
  }
}

function callcc(f) {
  const token = { live: true };
  const k = list(LIT, CONT);
  k.x = token;
  try {
    return applyF(f, [k]);
  } catch (ex) {
    if (ex instanceof ContThrow && ex.k === token) return ex.v;
    throw ex;
  } finally {
    token.live = false;
  }
}

function wherePlace(place, a, isNew) {
  if (place instanceof Sym && !place.lit) {
    let c = lookup(place, a);
    if (c === null) {
      if (place === SCOPE || place === GLOBE) return unfindable();
      if (!isNew) return sigerr(sym('unbound'));
      c = globalCell(place);
    }
    return list(c, D);
  }
  return ev(place, a, isNew ? 2 : 1);
}

function assign(p, v, a) {
  if (p instanceof Sym && !p.lit) {
    let c = lookup(p, a);
    if (c === null) {
      setGlobal(p, v);
      return v;
    }
    assignCell(c, v);
    return v;
  }
  const loc = ev(p, a, 2);
  const cell = loc.a, which = loc.d.a;
  if (!(cell instanceof Pair)) return sigerr(sym('bad-place'));
  if (which === A) cell.a = v;
  else if (which === D) { epoch++; assignCell(cell, v); }
  else return sigerr(sym('bad-place'));
  return v;
}

function evSet(es, a) {
  let v = T;
  while (es instanceof Pair) {
    const p = es.a;
    if (es.d === NIL) { v = T; es = NIL; }
    else { v = ev(es.d.a, a, false); es = es.d.d; }
    assign(p, v, a);
  }
  return v;
}

function qq(x, a, depth) {
  if (!(x instanceof Pair)) return x;
  if (x.a === COMMA) {
    if (depth === 0) return ev(x.d.a, a, false);
    const sub = qq(x.d.a, a, depth - 1);
    return sub === x.d.a ? x : list(COMMA, sub);
  }
  if (x.a === COMMA_AT && depth > 0) {
    const sub = qq(x.d.a, a, depth - 1);
    return sub === x.d.a ? x : list(COMMA_AT, sub);
  }
  if (x.a === BQUOTE) {
    const sub = qq(x.d.a, a, depth + 1);
    return sub === x.d.a ? x : list(BQUOTE, sub);
  }
  if (x.a === COMMA_AT) return sigerr(sym('comma-at-outside-list'));
  const items = [];
  let changed = false;
  let p = x;
  let tail = NIL;
  while (p instanceof Pair) {
    if (p !== x && (p.a === COMMA || p.a === COMMA_AT || p.a === BQUOTE) && p.d instanceof Pair && p.d.d === NIL) {
      // dotted unquote: (a . ,b)
      if (p.a === COMMA_AT && depth === 0) return sigerr(sym('splice-multiple-cdrs'));
      tail = qq(p, a, depth);
      if (tail !== p) changed = true;
      p = NIL;
      break;
    }
    const el = p.a;
    if (el instanceof Pair && el.a === COMMA_AT && depth === 0) {
      const v = ev(el.d.a, a, false);
      items.push({ splice: v });
      changed = true;
    } else {
      const v = qq(el, a, depth);
      if (v !== el) changed = true;
      items.push({ v });
    }
    p = p.d;
  }
  if (p !== NIL && tail === NIL) tail = p;
  if (!changed) return x;
  let r = tail;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.splice !== undefined) {
      const arr = listToArr(it.splice);
      if (i === items.length - 1 && r === NIL) {
        r = it.splice;  // last splice shares structure, as in Bel's (apply append ...)
        if (!(r instanceof Pair) && r !== NIL) return sigerr(sym('splice-atom'));
      } else {
        for (let j = arr.length - 1; j >= 0; j--) r = new Pair(arr[j], r);
      }
    } else {
      r = new Pair(it.v, r);
    }
  }
  return r;
}

function globeList() {
  let r = NIL;
  for (const s of symtab.values()) if (s.gcell) r = new Pair(s.gcell, r);
  return r;
}


// ---------------------------------------------------------------- compiler
//
// Closure compilation of the same semantics as ev, for value context.  Each
// code pair is compiled once into a JS function node(a, t) where a is the
// Bel environment (an alist) and t says the node is in tail position; a call
// to a closure in tail position returns the TC marker instead of growing the
// JS stack, and run() trampolines it.  Anything unusual (where-mode, dyn,
// after, ccc, def, mac) is delegated to ev, so the two agree by construction.

const COMPILE = !(typeof process !== 'undefined' && process.env && process.env.BEL_NOCOMPILE);
const TC = { env: null, node: null };

function run(node, env) {
  let r = node(env, true);
  while (r === TC) {
    const n = TC.node, e = TC.env;
    r = n(e, true);
  }
  return r;
}

function comp(e) {
  if (e instanceof Sym) return e.cnode || (e.cnode = compSym(e));
  if (!(e instanceof Pair)) return () => e;
  if (e.c !== null) return e.c;
  e.c = (a, t) => e.c === null ? ev(e, a, 0) : ev(e, a, 0);  // placeholder while compiling
  const n = compPair(e);
  e.c = n;
  return n;
}

function compSym(s) {
  if (s.lit) return () => s;
  return (a) => {
    if (s.dynb) {
      for (let i = dyn.length - 1; i >= 0; i--) if (dyn[i].a === s) return dyn[i].d;
    }
    if (s.lexb) {
      for (let p = a; p instanceof Pair; p = p.d) if (p.a.a === s) return p.a.d;
    }
    const c = s.gcell;
    if (c !== null) return c.d;
    return ev(s, a, 0);
  };
}

function compSeq(body) {
  const ns = listToArr(body).map(comp);
  if (ns.length === 0) return () => NIL;
  if (ns.length === 1) return ns[0];
  if (ns.length === 2) {
    const [n0, n1] = ns;
    return (a, t) => { n0(a, false); return n1(a, t); };
  }
  const last = ns.pop();
  return (a, t) => {
    for (let i = 0; i < ns.length; i++) ns[i](a, false);
    return last(a, t);
  };
}

function compArgs(es) {
  return listToArr(es).map(comp);
}

function evArgs(argn, a) {
  const n = argn.length;
  const args = new Array(n);
  for (let i = 0; i < n; i++) args[i] = argn[i](a, false);
  return args;
}

function applyT(f, args, t) {
  for (;;) {
    if (f instanceof Pair) {
      const x = f.x;
      if (typeof x === 'function') return x(args);
      if (f.a === LIT && f.d instanceof Pair && f.d.a === CLO) {
        const r = f.d.d;
        const env = bind(r.d.a, args, r.a);
        const body = comp(r.d.d.a);
        if (t) { TC.env = env; TC.node = body; return TC; }
        return run(body, env);
      }
      return applyF(f, args);
    }
    if (f === APPLY) {
      if (args.length === 0) return sigerr(sym('cannot-apply'));
      const rest = args.slice(1);
      f = args[0];
      if (rest.length === 0) { args = []; continue; }
      const last = rest.pop();
      args = rest.concat(listToArr(last));
      continue;
    }
    return applyF(f, args);
  }
}

function expandCached(e, f) {
  const mc = e.x;
  if (mc instanceof MacroCache && mc.m === f) return mc.exp;
  const exp = applyF(f.d.d.a, listToArr(e.d));
  e.x = new MacroCache(f, exp);
  return exp;
}

function compCall(e) {
  const op = e.a;
  const opn = comp(op);
  const argn = compArgs(e.d);
  const gsym = op instanceof Sym && !op.lit ? op : null;
  return (a, t) => {
    let f;
    if (gsym !== null && !gsym.lexb && !gsym.dynb && gsym.gcell !== null) f = gsym.gcell.d;
    else f = opn(a, false);
    if (f instanceof Pair) {
      const x = f.x;
      if (typeof x === 'function') return x(evArgs(argn, a));
      if (f.a === LIT && f.d instanceof Pair) {
        const tag = f.d.a;
        if (tag === MAC) return comp(expandCached(e, f))(a, t);
        if (tag === CLO) {
          const args = evArgs(argn, a);
          const r = f.d.d;
          const env = bind(r.d.a, args, r.a);
          const body = comp(r.d.d.a);
          if (t) { TC.env = env; TC.node = body; return TC; }
          return run(body, env);
        }
      }
    }
    return applyT(f, evArgs(argn, a), t);
  };
}

function guarded(op, fast, e) {
  let gen = null;
  return (a, t) => {
    if (op.nat && !shadowed(op, a)) return fast(a, t);
    if (gen === null) gen = compCall(e);
    return gen(a, t);
  };
}

function compPair(e) {
  const op = e.a;
  if (op instanceof Sym) {
    const sf = op.sf;
    if (sf === 0) return compCall(e);
    switch (sf) {
      case SF_QUOTE: { const v = e.d.a; return () => v; }
      case SF_LIT: return () => e;
      case SF_IF: return compIf(e);
      case SF_BQUOTE: { const x = e.d.a; return (a) => qq(x, a, 0); }
      case SF_WHERE: case SF_DYN: case SF_AFTER: case SF_CCC: case SF_THREAD:
        return (a) => ev(e, a, 0);
    }
    const fast = compCore(e, sf);
    return guarded(op, fast, e);
  }
  if (op === VMARK && VMARK !== undefined) {
    return (a) => {
      const c = lookupPair(e, a);
      if (c === null) return sigerr(sym('unbound'));
      return c.d;
    };
  }
  if (op instanceof Char) return () => e;
  if (op instanceof Pair && op.a === FN) {
    const parms = op.d.a;
    const body = comp(fnBody(op));
    const argn = compArgs(e.d);
    let gen = null;
    return (a, t) => {
      if (FN.nat && !shadowed(FN, a)) return body(bind(parms, evArgs(argn, a), a), t);
      if (gen === null) gen = compCall(e);
      return gen(a, t);
    };
  }
  return compCall(e);
}

function compIf(e) {
  const parts = listToArr(e.d).map(comp);
  if (parts.length === 0) return () => NIL;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) {
    const [c, th] = parts;
    return (a, t) => (c(a, false) !== NIL ? th(a, t) : NIL);
  }
  if (parts.length === 3) {
    const [c, th, el] = parts;
    return (a, t) => (c(a, false) !== NIL ? th(a, t) : el(a, t));
  }
  return (a, t) => {
    let i = 0;
    for (; i + 1 < parts.length; i += 2) if (parts[i](a, false) !== NIL) return parts[i + 1](a, t);
    return i < parts.length ? parts[i](a, t) : NIL;
  };
}

function bindPat(v, val, a) {
  if (v instanceof Sym && !v.lit) {
    v.lexb = true;
    return new Pair(new Pair(v, val), a);
  }
  return pass(v, val, a);
}

function compCore(e, sf) {
  switch (sf) {
    case SF_FN: {
      const parms = e.d.a;
      const body = fnBody(e);
      return (a) => makeClo(a, parms, body);
    }
    case SF_DO: return compSeq(e.d);
    case SF_SET: {
      const items = [];
      let es = e.d;
      while (es instanceof Pair) {
        const p = es.a;
        let vn;
        if (es.d === NIL) { vn = () => T; es = NIL; }
        else { vn = comp(es.d.a); es = es.d.d; }
        items.push([p, vn]);
      }
      return (a) => {
        let v = T;
        for (let i = 0; i < items.length; i++) {
          v = items[i][1](a, false);
          assign(items[i][0], v, a);
        }
        return v;
      };
    }
    case SF_LET: {
      const parms = e.d.a;
      const valn = comp(e.d.d.a);
      const body = compSeq(e.d.d.d);
      return (a, t) => body(bindPat(parms, valn(a, false), a), t);
    }
    case SF_RFN: {
      const name = e.d.a;
      const parms = e.d.d.a;
      const body = fnBody(e.d);
      return (a) => {
        const cell = new Pair(name, NIL);
        if (name instanceof Sym) name.lexb = true;
        const clo = makeClo(new Pair(cell, a), parms, body);
        cell.d = clo;
        return clo;
      };
    }
    case SF_WHEN:
    case SF_UNLESS: {
      const c = comp(e.d.a);
      const body = compSeq(e.d.d);
      const want = sf === SF_WHEN;
      return (a, t) => ((c(a, false) !== NIL) === want ? body(a, t) : NIL);
    }
    case SF_AND: {
      const ns = listToArr(e.d).map(comp);
      if (ns.length === 0) return () => T;
      const last = ns.pop();
      return (a, t) => {
        for (let i = 0; i < ns.length; i++) if (ns[i](a, false) === NIL) return NIL;
        return last(a, t);
      };
    }
    case SF_OR: {
      const ns = listToArr(e.d).map(comp);
      if (ns.length === 0) return () => NIL;
      const last = ns.pop();
      return (a, t) => {
        for (let i = 0; i < ns.length; i++) {
          const v = ns[i](a, false);
          if (v !== NIL) return v;
        }
        return last(a, t);
      };
    }
    case SF_CASE: {
      const vn = comp(e.d.a);
      const rest = listToArr(e.d.d);
      const keys = [], ns = [];
      let dflt = null;
      for (let i = 0; i < rest.length; i += 2) {
        if (i + 1 >= rest.length) dflt = comp(rest[i]);
        else { keys.push(rest[i]); ns.push(comp(rest[i + 1])); }
      }
      return (a, t) => {
        const v = vn(a, false);
        for (let i = 0; i < keys.length; i++) if (equal(v, keys[i])) return ns[i](a, t);
        return dflt === null ? NIL : dflt(a, t);
      };
    }
    case SF_WITH:
    case SF_WITHS: {
      const vars = [], vals = [];
      for (let p = e.d.a; p instanceof Pair; p = p.d.d) {
        vars.push(p.a);
        vals.push(comp(p.d instanceof Pair ? p.d.a : NIL));
      }
      const body = compSeq(e.d.d);
      if (sf === SF_WITHS) {
        return (a, t) => {
          for (let i = 0; i < vars.length; i++) a = bindPat(vars[i], vals[i](a, false), a);
          return body(a, t);
        };
      }
      return (a, t) => {
        const vs = new Array(vars.length);
        for (let i = 0; i < vars.length; i++) vs[i] = vals[i](a, false);
        for (let i = 0; i < vars.length; i++) a = bindPat(vars[i], vs[i], a);
        return body(a, t);
      };
    }
    case SF_FOR: {
      const v = e.d.a;
      const initn = comp(e.d.d.a);
      const maxn = comp(e.d.d.d.a);
      const body = listToArr(e.d.d.d.d).map(comp);
      return (a) => {
        let i = initn(a, false);
        const mx = maxn(a, false);
        if (v instanceof Sym) v.lexb = true;
        while (!less(mx, i)) {
          const cell = new Pair(v, i);
          const a2 = new Pair(cell, a);
          for (let k = 0; k < body.length; k++) body[k](a2, false);
          i = num(cell.d) + 1;
        }
        return NIL;
      };
    }
    case SF_REPEAT: {
      const nn = comp(e.d.a);
      const body = listToArr(e.d.d).map(comp);
      return (a) => {
        const n = nn(a, false);
        for (let i = 1; !less(n, i); i++) {
          for (let k = 0; k < body.length; k++) body[k](a, false);
        }
        return NIL;
      };
    }
    case SF_WHILE: {
      const test = comp(e.d.a);
      const body = listToArr(e.d.d).map(comp);
      return (a) => {
        while (test(a, false) !== NIL) {
          for (let k = 0; k < body.length; k++) body[k](a, false);
        }
        return NIL;
      };
    }
    default:
      return (a) => ev(e, a, 0);
  }
}

// ---------------------------------------------------------------- reader

const WHITE = new Set([' ', '\n', '\t', '\r', '\f']);
const SYNTAX = new Set(['(', ')', '[', ']', '\\', "'", '`', ',', '"', '¦', '#']);
const isBreak = (c) => c === null || WHITE.has(c) || c === ';' || SYNTAX.has(c);
const NAMEDCHARS = { bel: 7, tab: 9, lf: 10, cr: 13, sp: 32 };
const NUMRE = /^[+-]?(\d+\.?\d*|\.\d+)(\/(\d+\.?\d*|\.\d+))?$/;

class StringSrc {
  constructor(s) { this.s = s; this.i = 0; }
  peek() {
    if (this.i >= this.s.length) return null;
    const cp = this.s.codePointAt(this.i);
    return String.fromCodePoint(cp);
  }
  next() {
    const c = this.peek();
    if (c !== null) this.i += c.length;
    return c;
  }
}

class StreamSrc {
  constructor(s) { this.s = s; }
  peek() {
    const c = peekChar(this.s);
    return c === null ? null : String.fromCodePoint(c.c);
  }
  next() {
    const c = readChar(this.s);
    return c === null ? null : String.fromCodePoint(c.c);
  }
}

class Reader {
  constructor(src) { this.src = src; }
  eatwhite() {
    for (;;) {
      const c = this.src.peek();
      if (c === null) return;
      if (WHITE.has(c) || c === '\uFEFF') { this.src.next(); continue; }
      if (c === ';') {
        while (this.src.peek() !== null && this.src.peek() !== '\n') this.src.next();
        continue;
      }
      return;
    }
  }
  read(eof) {
    this.eatwhite();
    const c = this.src.next();
    if (c === null) return eof;
    switch (c) {
      case '(': return this.readList(')');
      case '[': return list(FN, list(UNDERSCORE), this.readList(']'));
      case ')': case ']': return sigerr(sym('unexpected-terminator'));
      case "'": return list(QUOTE, this.hard());
      case '`': return list(BQUOTE, this.hard());
      case ',':
        if (this.src.peek() === '@') { this.src.next(); return list(COMMA_AT, this.hard()); }
        return list(COMMA, this.hard());
      case '"': return this.readDelim('"', false);
      case '¦': return sym(jsstr(this.readDelim('¦', false)));
      case '\\': return this.readChar();
      case '#': return sigerr(sym('labels-unsupported'));
      default: return parseWord(c + this.charsTilBreak());
    }
  }
  hard() {
    const eof = {};
    const v = this.read(eof);
    if (v === eof) return sigerr(sym('missing-expression'));
    return v;
  }
  charsTilBreak() {
    let s = '';
    while (!isBreak(this.src.peek())) s += this.src.next();
    return s;
  }
  readChar() {
    const c = this.src.peek();
    if (c === null) return sigerr(sym('escape-without-char'));
    if (isBreak(c)) { this.src.next(); return chr(c.codePointAt(0)); }
    const cs = this.charsTilBreak();
    if (Array.from(cs).length > 1) {
      if (NAMEDCHARS[cs] === undefined) return sigerr(sym('unknown-named-char'));
      return chr(NAMEDCHARS[cs]);
    }
    return chr(cs.codePointAt(0));
  }
  readDelim(d) {
    const out = [];
    for (;;) {
      let c = this.src.next();
      if (c === null) return sigerr(sym('missing-delimiter'));
      if (c === '\\') {
        c = this.src.next();
        if (c === null) return sigerr(sym('missing-delimiter'));
      } else if (c === d) break;
      out.push(chr(c.codePointAt(0)));
    }
    return arrToList(out);
  }
  readList(term) {
    const items = [];
    for (;;) {
      this.eatwhite();
      const c = this.src.peek();
      if (c === null) return sigerr(sym('unterminated-list'));
      if (c === term) { this.src.next(); return arrToList(items); }
      if (c === '.') {
        this.src.next();
        if (isBreak(this.src.peek())) {
          if (items.length === 0) return sigerr(sym('missing-car'));
          const tail = this.hard();
          this.eatwhite();
          if (this.src.next() !== term) return sigerr(sym('duplicate-cdr'));
          return arrToList(items, 0, tail);
        }
        items.push(parseWord('.' + this.charsTilBreak()));
        continue;
      }
      if (c === ')' || c === ']') return sigerr(sym('unexpected-terminator'));
      const eof = {};
      const v = this.read(eof);
      if (v === eof) return sigerr(sym('unterminated-list'));
      items.push(v);
    }
  }
}

function parseNum(s) {
  if (!NUMRE.test(s)) return null;
  const [n, d] = s.split('/');
  const v = d === undefined ? Number(n) : Number(n) / Number(d);
  if (d !== undefined && Number(d) === 0) return sigerr(sym('zero-denominator'));
  return v;
}

function parseWord(s) {
  const n = parseNum(s);
  if (n !== null) return n;
  if (s === '.') return sigerr(sym('unexpected-dot'));
  if (s.includes('|')) {
    const parts = s.split('|').filter((x) => x !== '');
    if (s.split('|').length > 2) return sigerr(sym('multiple-bars'));
    if (parts.length !== 2) return sigerr(sym('bad-tspec'));
    return list(T, parseWord(parts[0]), parseWord(parts[1]));
  }
  if (/[.!]/.test(s)) return parseSlist(s);
  return parseCom(s);
}

function parseSlist(s) {
  const runs = s.match(/[.!]+|[^.!]+/g);
  if (/[.!]/.test(runs[runs.length - 1])) return sigerr(sym('final-intrasymbol'));
  const rs = /[.!]/.test(runs[0]) ? ['.', 'upon', ...runs] : ['.', ...runs];
  const out = [];
  for (let i = 0; i < rs.length; i += 2) {
    const cs = rs[i], ds = rs[i + 1];
    if (cs.length > 1) return sigerr(sym('double-intrasymbol'));
    out.push(cs === '!' ? list(QUOTE, parseCom(ds)) : parseCom(ds));
  }
  return arrToList(out);
}

function parseCom(s) {
  if (s.includes(':')) {
    return new Pair(COMPOSE, arrToList(s.split(':').filter((x) => x !== '').map(parseNo)));
  }
  return parseNo(s);
}

function parseNo(s) {
  if (s[0] === '~') {
    if (s.length > 1) return list(COMPOSE, NO, parseNo(s.slice(1)));
    return NO;
  }
  const n = parseNum(s);
  return n !== null ? n : sym(s);
}

function readAll(text) {
  const r = new Reader(new StringSrc(text));
  const out = [];
  const eof = {};
  for (;;) {
    const v = r.read(eof);
    if (v === eof) return out;
    out.push(v);
  }
}

// ---------------------------------------------------------------- printer

const CHARNAMES = { 7: 'bel', 9: 'tab', 10: 'lf', 13: 'cr', 32: 'sp' };

function fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  if (n === Infinity) return '+inf';
  if (n === -Infinity) return '-inf';
  if (Number.isNaN(n)) return 'nan';
  return String(n);
}

function printString(x) {
  const out = [];
  const seen = new Set();
  const pr = (x) => {
    if (x instanceof Sym) { out.push(x.name); return; }
    if (typeof x === 'number') { out.push(fmtNum(x)); return; }
    if (x instanceof Char) {
      out.push('\\' + (CHARNAMES[x.c] || String.fromCodePoint(x.c)));
      return;
    }
    if (x instanceof Stream) { out.push('<stream>'); return; }
    if (x instanceof Pair) {
      if (seen.has(x)) { out.push('<cycle>'); return; }
      if (isString(x)) {
        let s = '"';
        for (let p = x; p instanceof Pair; p = p.d) {
          const ch = String.fromCodePoint(p.a.c);
          s += ch === '"' || ch === '\\' ? '\\' + ch : ch;
        }
        out.push(s + '"');
        return;
      }
      seen.add(x);
      out.push('(');
      let p = x;
      let first = true;
      const added = [x];
      while (p instanceof Pair) {
        if (!first) {
          out.push(' ');
          if (seen.has(p)) { out.push('. <cycle>'); break; }
          seen.add(p);
          added.push(p);
        }
        pr(p.a);
        first = false;
        p = p.d;
        if (p !== NIL && !(p instanceof Pair)) { out.push(' . '); pr(p); }
        else if (p instanceof Pair && isString(p)) { out.push(' . '); pr(p); break; }
      }
      out.push(')');
      for (const q of added) seen.delete(q);
      return;
    }
    out.push(String(x));
  };
  pr(x);
  return out.join('');
}

// ---------------------------------------------------------------- streams

let stdoutStream = null;
let stdinStream = null;
let host = null;

function streamOf(s, input) {
  if (s === NIL) return input ? stdinStream : stdoutStream;
  if (s instanceof Stream) return s;
  return null;
}

function writeChar(c, s) {
  const code = c.c;
  if (code < 256) { s.putByte(code); return; }
  const bytes = new TextEncoder().encode(String.fromCodePoint(code));
  for (const b of bytes) s.putByte(b);
}

function readChar(s) {
  if (s.peeked !== null) { const c = s.peeked; s.peeked = null; return c; }
  const b = s.readByte();
  return b < 0 ? null : CHARS[b];
}

function peekChar(s) {
  if (s.peeked === null) {
    const b = s.readByte();
    if (b < 0) return null;
    s.peeked = CHARS[b];
  }
  return s.peeked;
}

function enq(c, q) {
  // q = (list-of-items); append c at the end
  if (q.a === NIL) { q.a = new Pair(c, NIL); q.x = q.a; return; }
  let p = q.a;
  if (!(q.x instanceof Pair) || q.x.d !== NIL) {
    while (p.d instanceof Pair) p = p.d;
  } else {
    p = q.x;
  }
  const cell = new Pair(c, NIL);
  epoch++;
  p.d = cell;
  q.x = cell;
}

function prc(c, s) {
  if (s instanceof Pair) { enq(c, s); return c; }
  const st = streamOf(s, false);
  if (!st) return sigerr(sym('bad-stream'));
  writeChar(c, st);
  return c;
}

function outStream(args, i) {
  if (args.length > i) return args[i];
  return OUTS.gcell ? lookup(OUTS, NIL).d : NIL;
}
function inStream(args, i) {
  if (args.length > i) return args[i];
  return INS.gcell ? lookup(INS, NIL).d : NIL;
}

function printTo(x, s) {
  const text = printString(x);
  writeText(text, s);
}

function writeText(text, s) {
  for (const ch of text) prc(chr(ch.codePointAt(0)), s);
}

// ---------------------------------------------------------------- natives

// CDR-coding cache, in the spirit of the Lisp Machine: a list that is indexed
// repeatedly gets a hidden vector of its cells, so nth and drop become O(1).
// Any structural mutation (xdr) bumps a global epoch and invalidates every
// cache; car mutation (xar) is safe because the vector holds cells.
let epoch = 0;
class CellVec {
  constructor() { this.hits = 0; this.ep = -1; this.cells = null; this.ring = false; this.done = false; }
}
function cellsUpTo(xs, n) {
  // returns a CellVec whose cells cover indices < n where the list allows, or null
  let c = xs.x;
  if (c === null) { c = new CellVec(); xs.x = c; }
  else if (!(c instanceof CellVec)) return null;
  if (c.ep !== epoch) {
    if (++c.hits < 3) return null;
    c.cells = [xs];
    c.ring = false;
    c.done = false;
    c.ep = epoch;
  }
  const cells = c.cells;
  while (cells.length < n && !c.done) {
    const p = cells[cells.length - 1].d;
    if (!(p instanceof Pair)) { c.done = true; break; }
    if (p === xs) { c.ring = true; c.done = true; break; }
    cells.push(p);
  }
  return c;
}

function nth(n, xs) {
  if (!Number.isInteger(n) || n < 1) return sigerr(sym('mistype'));
  if (n > 8 && xs instanceof Pair) {
    const c = cellsUpTo(xs, n);
    if (c !== null) {
      const cells = c.cells;
      if (n <= cells.length) return cells[n - 1].a;
      if (c.ring) return cells[(n - 1) % cells.length].a;
      return sigerr(sym('mistype'));
    }
  }
  let p = xs;
  for (let i = 1; i < n; i++) {
    if (!(p instanceof Pair)) return sigerr(sym('mistype'));
    p = p.d;
  }
  if (!(p instanceof Pair)) return sigerr(sym('mistype'));
  return p.a;
}

function locNth(args) {
  const n = args[0];
  if (!Number.isInteger(n) || n < 1) return sigerr(sym('mistype'));
  let p = args[1];
  for (let i = 1; i < n; i++) {
    if (!(p instanceof Pair)) return sigerr(sym('mistype'));
    p = p.d;
  }
  if (!(p instanceof Pair)) return sigerr(sym('mistype'));
  return list(p, A);
}

function equal(x, y) {
  for (;;) {
    if (x === y) return true;
    if (!(x instanceof Pair) || !(y instanceof Pair)) return false;
    if (!equal(x.a, y.a)) return false;
    x = x.d;
    y = y.d;
  }
}

function num(x) {
  if (typeof x !== 'number') sigerr(sym('mistype'));
  return x;
}

function less(x, y) {
  if (typeof x === 'number' && typeof y === 'number') return x < y;
  if (x instanceof Char && y instanceof Char) return x.c < y.c;
  if (x instanceof Sym && y instanceof Sym) return x.name < y.name;
  if (x === NIL && y === NIL) return false;
  if ((x instanceof Pair || x === NIL) && (y instanceof Pair || y === NIL)) {
    // list< for strings
    for (;;) {
      if (x === NIL) return y !== NIL;
      if (y === NIL) return false;
      if (less(x.a, y.a)) return true;
      if (!equal(x.a, y.a)) return false;
      x = x.d;
      y = y.d;
    }
  }
  return sigerr(sym('incomparable'));
}

function round(n) {
  if (n < 0) return -round(-n);
  const f = Math.floor(n);
  const d = n - f;
  if (d > 0.5 || (d === 0.5 && f % 2 === 1)) return f + 1;
  return f;
}

function truthy(x) { return x !== NIL; }

const jets = {};
function jet(name, fn, loc) {
  jets[name] = { fn, loc };
}
function mkprim(name, fn, loc) {
  const p = list(LIT, PRIM, sym(name));
  p.x = fn;
  if (loc) fn.loc = loc;
  return p;
}

// The 16 primitives.
const prims = {
  id: (a) => truth(a[0] === a[1] || (typeof a[0] === 'number' && a[0] === a[1])),
  join: (a) => new Pair(a.length > 0 ? a[0] : NIL, a.length > 1 ? a[1] : NIL),
  car: (a) => {
    const x = a.length ? a[0] : NIL;
    if (x instanceof Pair) return x.a;
    if (x === NIL) return NIL;
    return sigerr(sym('car-on-atom'));
  },
  cdr: (a) => {
    const x = a.length ? a[0] : NIL;
    if (x instanceof Pair) return x.d;
    if (x === NIL) return NIL;
    return sigerr(sym('cdr-on-atom'));
  },
  type: (a) => {
    const x = a[0];
    if (x instanceof Sym) return SYMBOL;
    if (x instanceof Pair) return PAIR;
    if (x instanceof Char) return CHAR;
    if (x instanceof Stream) return STREAM;
    if (typeof x === 'number') return NUMBER;
    return sigerr(sym('unknown-type'));
  },
  xar: (a) => {
    if (!(a[0] instanceof Pair)) return sigerr(sym('xar-on-atom'));
    a[0].a = a[1];
    return a[1];
  },
  xdr: (a) => {
    if (!(a[0] instanceof Pair)) return sigerr(sym('xdr-on-atom'));
    epoch++;
    a[0].d = a[1];
    return a[1];
  },
  sym: (a) => sym(jsstr(a[0])),
  nom: (a) => {
    if (!(a[0] instanceof Sym)) return sigerr(sym('mistype'));
    return str(a[0].name);
  },
  wrb: (a) => {
    const st = streamOf(a.length > 1 ? a[1] : NIL, false);
    if (!st || st.dir !== 'out' || st.closed) return sigerr(sym('bad-stream'));
    st.writeBit(a[0] === CHARS[49] ? 1 : 0);
    return a[0];
  },
  rdb: (a) => {
    const st = streamOf(a.length ? a[0] : NIL, true);
    if (!st || st.dir !== 'in' || st.closed) return sigerr(sym('bad-stream'));
    const b = st.readBit();
    if (b < 0) return EOF;
    return b ? CHARS[49] : CHARS[48];
  },
  ops: (a) => {
    const path = jsstr(a[0]);
    const dir = a[1];
    if (dir === IN) {
      const data = host.readFile(path);
      if (!data) return sigerr(sym('cannot-open'));
      const s = new Stream('in', path);
      s.data = data;
      return s;
    }
    if (dir === OUT) return new Stream('out', path);
    return sigerr(sym('bad-direction'));
  },
  cls: (a) => {
    const s = a[0];
    if (!(s instanceof Stream)) return sigerr(sym('bad-stream'));
    if (s.dir === 'out' && s.path && host.writeFile) host.writeFile(s.path, s.take());
    s.closed = true;
    return T;
  },
  stat: (a) => {
    const s = a[0];
    if (!(s instanceof Stream)) return sigerr(sym('bad-stream'));
    return s.closed ? CLOSED : s.dir === 'in' ? IN : OUT;
  },
  coin: () => truth(Math.random() < 0.5),
  sys: (a) => {
    if (!host.sys) return sigerr(sym('sys-unsupported'));
    return host.sys(jsstr(a[0])) ? T : NIL;
  },
};
prims.car.loc = (a) => list(a[0], A);
prims.cdr.loc = (a) => list(a[0], D);

// Jets: native versions of bel.bel definitions, same semantics.
jet('no', (a) => truth(a[0] === NIL));
jet('atom', (a) => truth(!(a[0] instanceof Pair)));
jet('all', (a) => {
  const f = a[0];
  for (let p = a[1]; p instanceof Pair; p = p.d) if (applyF(f, [p.a]) === NIL) return NIL;
  return T;
});
jet('some', (a) => {
  const f = a[0];
  for (let p = a[1]; p instanceof Pair; p = p.d) if (applyF(f, [p.a]) !== NIL) return p;
  return NIL;
});
jet('reduce', (a) => {
  const xs = listToArr(a[1]);
  if (xs.length === 0) return NIL;
  let acc = xs[xs.length - 1];
  for (let i = xs.length - 2; i >= 0; i--) acc = applyF(a[0], [xs[i], acc]);
  return acc;
});
jet('cons', (a) => {
  if (a.length === 0) return NIL;
  let r = a[a.length - 1];
  for (let i = a.length - 2; i >= 0; i--) r = new Pair(a[i], r);
  return r;
});
function append(lists) {
  if (lists.length === 0) return NIL;
  let r = lists[lists.length - 1];
  for (let i = lists.length - 2; i >= 0; i--) {
    const xs = listToArr(lists[i]);
    for (let j = xs.length - 1; j >= 0; j--) r = new Pair(xs[j], r);
  }
  return r;
}
jet('append', (a) => append(a));
jet('snoc', (a) => append([a[0], arrToList(a, 1)]));
jet('list', (a) => arrToList(a));
jet('map', (a) => {
  const f = a[0];
  if (a.length === 2) {
    const out = [];
    for (let p = a[1]; p instanceof Pair; p = p.d) out.push(applyF(f, [p.a]));
    return arrToList(out);
  }
  if (a.length < 2) return NIL;
  const ls = a.slice(1);
  const out = [];
  for (;;) {
    if (ls.some((l) => !(l instanceof Pair))) break;
    out.push(applyF(f, ls.map((l) => l.a)));
    for (let i = 0; i < ls.length; i++) ls[i] = ls[i].d;
  }
  return arrToList(out);
});
jet('=', (a) => {
  for (let i = 1; i < a.length; i++) if (!equal(a[i], a[0])) return NIL;
  return T;
});
jet('symbol', (a) => truth(a[0] instanceof Sym));
jet('pair', (a) => truth(a[0] instanceof Pair));
jet('char', (a) => truth(a[0] instanceof Char));
jet('stream', (a) => truth(a[0] instanceof Stream));
jet('proper', (a) => {
  let x = a[0];
  while (x instanceof Pair) x = x.d;
  return truth(x === NIL);
});
jet('string', (a) => truth(a[0] === NIL || isString(a[0])));
jet('mem', (a) => {
  const x = a[0];
  if (a.length > 2) {
    for (let p = a[1]; p instanceof Pair; p = p.d) if (applyF(a[2], [p.a, x]) !== NIL) return p;
    return NIL;
  }
  for (let p = a[1]; p instanceof Pair; p = p.d) if (equal(p.a, x)) return p;
  return NIL;
});
jet('in', (a) => {
  for (let i = 1; i < a.length; i++) if (equal(a[i], a[0])) return arrToList(a, i);
  return NIL;
});
const cadr = (x) => (x instanceof Pair && x.d instanceof Pair ? x.d.a : NIL);
jet('cadr', (a) => cadr(a[0]), (a) => list(a[0].d, A));
jet('cddr', (a) => (a[0] instanceof Pair && a[0].d instanceof Pair ? a[0].d.d : NIL), (a) => list(a[0].d, D));
jet('caddr', (a) => {
  const x = a[0];
  return x instanceof Pair && x.d instanceof Pair && x.d.d instanceof Pair ? x.d.d.a : NIL;
}, (a) => list(a[0].d.d, A));
jet('find', (a) => {
  for (let p = a[1]; p instanceof Pair; p = p.d) if (applyF(a[0], [p.a]) !== NIL) return p.a;
  return NIL;
}, (a) => {
  for (let p = a[1]; p instanceof Pair; p = p.d) if (applyF(a[0], [p.a]) !== NIL) return list(p, A);
  return unfindable();
});
jet('begins', (a) => {
  let xs = a[0], pat = a[1];
  const f = a.length > 2 ? a[2] : null;
  for (;;) {
    if (pat === NIL) return T;
    if (!(xs instanceof Pair)) return NIL;
    if (f ? applyF(f, [xs.a, pat.a]) === NIL : !equal(xs.a, pat.a)) return NIL;
    xs = xs.d;
    pat = pat.d;
  }
});
jet('caris', (a) => {
  const x = a[0];
  if (!(x instanceof Pair)) return NIL;
  if (a.length > 2) return truth(applyF(a[2], [x.a, a[1]]) !== NIL);
  return truth(equal(x.a, a[1]));
});
jet('keep', (a) => {
  const out = [];
  for (let p = a[1]; p instanceof Pair; p = p.d) if (applyF(a[0], [p.a]) !== NIL) out.push(p.a);
  return arrToList(out);
});
jet('rem', (a) => {
  const out = [];
  const f = a.length > 2 ? a[2] : null;
  for (let p = a[1]; p instanceof Pair; p = p.d) {
    const same = f ? applyF(f, [p.a, a[0]]) !== NIL : equal(p.a, a[0]);
    if (!same) out.push(p.a);
  }
  return arrToList(out);
});
jet('get', (a) => {
  const k = a[0];
  const f = a.length > 2 ? a[2] : null;
  for (let p = a[1]; p instanceof Pair; p = p.d) {
    const kv = p.a;
    const key = kv instanceof Pair ? kv.a : NIL;
    if (f ? applyF(f, [key, k]) !== NIL : equal(key, k)) return kv;
  }
  return NIL;
});
jet('put', (a) => {
  const [k, v, kvs] = a;
  const f = a.length > 3 ? a[3] : null;
  const out = [new Pair(k, v)];
  for (let p = kvs; p instanceof Pair; p = p.d) {
    const key = p.a instanceof Pair ? p.a.a : NIL;
    if (!(f ? applyF(f, [key, k]) !== NIL : equal(key, k))) out.push(p.a);
  }
  return arrToList(out);
});
jet('rev', (a) => {
  let r = NIL;
  for (let p = a[0]; p instanceof Pair; p = p.d) r = new Pair(p.a, r);
  return r;
});
jet('idfn', (a) => a[0]);
jet('len', (a) => {
  let n = 0;
  for (let p = a[0]; p instanceof Pair; p = p.d) n++;
  return n;
});
jet('pos', (a) => {
  const f = a.length > 2 ? a[2] : null;
  let i = 1;
  for (let p = a[1]; p instanceof Pair; p = p.d, i++) {
    if (f ? applyF(f, [p.a, a[0]]) !== NIL : equal(p.a, a[0])) return i;
  }
  return NIL;
});
jet('nth', (a) => nth(a[0], a[1]), locNth);
jet('drop', (a) => {
  let p = a[1];
  const n = a[0];
  if (n > 8 && p instanceof Pair && Number.isInteger(n)) {
    const c = cellsUpTo(p, n + 1);
    if (c !== null) {
      const cells = c.cells;
      if (n < cells.length) return cells[n];
      if (c.ring) return cells[n % cells.length];
      if (n === cells.length) return cells[n - 1].d;
      return NIL;
    }
  }
  for (let i = 0; i < n; i++) p = p instanceof Pair ? p.d : NIL;
  return p;
});
jet('first', (a) => {
  const out = [];
  let p = a[1];
  for (let i = 0; i < a[0] && p instanceof Pair; i++, p = p.d) out.push(p.a);
  return arrToList(out);
});
jet('cut', (a) => {
  const xs = listToArr(a[0]);
  const start = a.length > 1 ? a[1] : 1;
  let end = a.length > 2 ? a[2] : xs.length;
  if (end < 0) end += xs.length;
  return arrToList(xs.slice(start - 1, Math.max(start - 1, end)));
});
jet('lastcdr', (a) => {
  let p = a[0];
  while (p instanceof Pair && p.d instanceof Pair) p = p.d;
  return p;
});
jet('last', (a) => {
  let p = a[0];
  if (!(p instanceof Pair)) return NIL;
  while (p.d instanceof Pair) p = p.d;
  return p.a;
}, (a) => {
  let p = a[0];
  if (!(p instanceof Pair)) return unfindable();
  while (p.d instanceof Pair) p = p.d;
  return list(p, A);
});
jet('udrop', (a) => {
  let xs = a[0], ys = a[1];
  while (xs instanceof Pair) { xs = xs.d; ys = ys instanceof Pair ? ys.d : NIL; }
  return ys;
});
jet('hug', (a) => {
  const xs = listToArr(a[0]);
  const f = a.length > 1 ? a[1] : null;
  const out = [];
  for (let i = 0; i < xs.length; i += 2) {
    const args = i + 1 < xs.length ? [xs[i], xs[i + 1]] : [xs[i]];
    out.push(f ? applyF(f, args) : arrToList(args));
  }
  return arrToList(out);
});
const orig = {};
const isMacro = (f) => f instanceof Pair && f.a === LIT && f.d instanceof Pair && f.d.a === MAC;
jet('compose', (a) => {
  const fs = a.slice();
  if (fs.some(isMacro)) return applyF(orig.compose, fs);
  if (fs.length === 0) return mkprim('idfn', (b) => b[0]);
  return mkprim('composed', (args) => {
    let v = applyF(fs[fs.length - 1], args);
    for (let i = fs.length - 2; i >= 0; i--) v = applyF(fs[i], [v]);
    return v;
  });
});
jet('foldl', (a) => {
  const f = a[0];
  let base = a[1];
  const ls = a.slice(2);
  if (ls.length === 0) return base;
  for (;;) {
    if (ls.some((l) => !(l instanceof Pair))) return base;
    base = applyF(f, [...ls.map((l) => l.a), base]);
    for (let i = 0; i < ls.length; i++) ls[i] = ls[i].d;
  }
});
jet('foldr', (a) => {
  const f = a[0];
  const base = a[1];
  const ls = a.slice(2).map(listToArr);
  if (ls.length === 0) return base;
  const n = Math.min(...ls.map((l) => l.length));
  let acc = base;
  for (let i = n - 1; i >= 0; i--) acc = applyF(f, [...ls.map((l) => l[i]), acc]);
  return acc;
});
jet('sort', (a) => {
  const f = a[0];
  const xs = listToArr(a[1]);
  // stable insertion semantics as in bel.bel: an element goes before the first y with (f x y)
  const out = [];
  for (let i = xs.length - 1; i >= 0; i--) {
    const x = xs[i];
    let j = 0;
    while (j < out.length && applyF(f, [x, out[j]]) === NIL) j++;
    out.splice(j, 0, x);
  }
  return arrToList(out);
});
jet('dedup', (a) => {
  const out = [];
  const f = a.length > 1 ? a[1] : null;
  for (let p = a[0]; p instanceof Pair; p = p.d) {
    if (!out.some((y) => (f ? applyF(f, [p.a, y]) !== NIL : equal(p.a, y)))) out.push(p.a);
  }
  return arrToList(out);
});

// numbers
jet('+', (a) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += num(a[i]);
  return s;
});
jet('-', (a) => {
  if (a.length === 0) return 0;
  if (a.length === 1) return -num(a[0]);
  let s = num(a[0]);
  for (let i = 1; i < a.length; i++) s -= num(a[i]);
  return s;
});
jet('*', (a) => {
  let s = 1;
  for (let i = 0; i < a.length; i++) s *= num(a[i]);
  return s;
});
jet('/', (a) => {
  if (a.length === 0) return 1;
  let s = num(a[0]);
  for (let i = 1; i < a.length; i++) {
    const d = num(a[i]);
    if (d === 0) return sigerr(sym('mistype'));
    s /= d;
  }
  return s;
});
jet('inc', (a) => num(a[0]) + 1);
jet('dec', (a) => num(a[0]) - 1);
jet('<', (a) => {
  for (let i = 0; i + 1 < a.length; i++) if (!less(a[i], a[i + 1])) return NIL;
  return T;
});
jet('>', (a) => {
  for (let i = 0; i + 1 < a.length; i++) if (!less(a[i + 1], a[i])) return NIL;
  return T;
});
jet('<=', (a) => {
  for (let i = 0; i + 1 < a.length; i++) if (less(a[i + 1], a[i])) return NIL;
  return T;
});
jet('>=', (a) => {
  for (let i = 0; i + 1 < a.length; i++) if (less(a[i], a[i + 1])) return NIL;
  return T;
});
jet('number', (a) => truth(typeof a[0] === 'number'));
jet('real', (a) => truth(typeof a[0] === 'number'));
jet('int', (a) => truth(Number.isInteger(a[0])));
jet('whole', (a) => truth(Number.isInteger(a[0]) && a[0] >= 0));
jet('pint', (a) => truth(Number.isInteger(a[0]) && a[0] > 0));
jet('abs', (a) => Math.abs(num(a[0])));
jet('floor', (a) => Math.floor(num(a[0])));
jet('ceil', (a) => Math.ceil(num(a[0])));
jet('round', (a) => round(num(a[0])));
jet('mod', (a) => {
  const x = num(a[0]), y = num(a[1]);
  if (y === 0) return sigerr(sym('mistype'));
  if (Number.isInteger(x) && Number.isInteger(y)) return ((x % y) + y) % y;
  return x - y * Math.floor(x / y);
});
jet('even', (a) => truth(Number.isInteger(num(a[0]) / 2)));
jet('odd', (a) => truth(Number.isInteger(a[0]) && !Number.isInteger(a[0] / 2)));
jet('max', (a) => {
  let m = a[0];
  for (let i = 1; i < a.length; i++) if (less(m, a[i])) m = a[i];
  return m;
});
jet('min', (a) => {
  let m = a[0];
  for (let i = 1; i < a.length; i++) if (less(a[i], m)) m = a[i];
  return m;
});
jet('rand', (a) => Math.floor(Math.random() * num(a[0])));
jet('charn', (a) => {
  if (!(a[0] instanceof Char)) return sigerr(sym('mistype'));
  return a[0].c;
});
jet('nchar', (a) => {
  const n = num(a[0]);
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return sigerr(sym('mistype'));
  return chr(n);
});
jet('inv', (a) => -num(a[0]));
jet('recip', (a) => {
  if (num(a[0]) === 0) return sigerr(sym('mistype'));
  return 1 / a[0];
});
jet('rpart', (a) => num(a[0]));
jet('ipart', (a) => (num(a[0]), 0));

// I/O
jet('prc', (a) => prc(a[0], outStream(a, 1)));
jet('rdc', (a) => {
  const s = inStream(a, 0);
  if (s instanceof Pair) {
    const c = s.a instanceof Pair ? s.a.a : NIL;
    if (s.a instanceof Pair) s.a = s.a.d;
    return c;
  }
  const st = streamOf(s, true);
  if (!st) return sigerr(sym('bad-stream'));
  const c = readChar(st);
  return c === null ? NIL : c;
});
jet('peek', (a) => {
  const s = inStream(a, 0);
  if (s instanceof Pair) return s.a instanceof Pair ? s.a.a : NIL;
  const st = streamOf(s, true);
  if (!st) return sigerr(sym('bad-stream'));
  const c = peekChar(st);
  return c === null ? NIL : c;
});
jet('print', (a) => {
  printTo(a[0], outStream(a, 1));
  return NIL;
});
function prnice(x, s) {
  if (x instanceof Char) prc(x, s);
  else if (x !== NIL && isString(x)) for (let p = x; p instanceof Pair; p = p.d) prc(p.a, s);
  else printTo(x, s);
}
jet('pr', (a) => {
  const s = outStream([], 0);
  for (const x of a) prnice(x, s);
  return arrToList(a);
});
jet('prn', (a) => {
  const s = outStream([], 0);
  for (const x of a) { printTo(x, s); prc(chr(32), s); }
  prc(chr(10), s);
  return a.length ? a[a.length - 1] : NIL;
});
jet('prs', (a) => {
  const q = new Pair(NIL, NIL);
  for (const x of a) prnice(x, q);
  return q.a;
});
jet('read', (a) => {
  const s = a.length > 0 ? a[0] : inStream([], 0);
  const eof = a.length > 2 ? a[2] : NIL;
  let src;
  if (s instanceof Pair && isString(s.a)) {
    src = new StringSrc(jsstr(s.a));
    const marker = {};
    const v = new Reader(src).read(marker);
    s.a = str(src.s.slice(src.i));
    return v === marker ? eof : v;
  }
  const st = streamOf(s, true);
  if (!st) return sigerr(sym('bad-stream'));
  const marker = {};
  const v = new Reader(new StreamSrc(st)).read(marker);
  return v === marker ? eof : v;
});
jet('load', (a) => {
  const path = jsstr(a[0]);
  const data = host.readFile(path);
  if (!data) return sigerr(sym('cannot-open'));
  return loadText(new TextDecoder().decode(data));
});
jet('err', (a) => sigerr(a.length ? a[0] : NIL));

function loadText(text) {
  let v = NIL;
  for (const form of readAll(text)) v = ev(form, NIL, false);
  return v;
}

// ---------------------------------------------------------------- host API

function toBel(x) {
  if (typeof x === 'string') return str(x);
  if (Array.isArray(x)) return arrToList(x.map(toBel));
  if (x === null || x === undefined || x === false) return NIL;
  if (x === true) return T;
  return x;
}

let booted = false;

export class Bel {
  constructor(opts = {}) {
    if (booted) throw new Error('only one Bel instance per JS realm');
    booted = true;
    host = {
      readFile: opts.readFile || (() => null),
      writeFile: opts.writeFile || null,
      sys: opts.sys || null,
    };
    stdoutStream = new Stream('out', null);
    if (opts.stdout) stdoutStream.sink = opts.stdout;
    stdinStream = new Stream('in', null);
    if (opts.stdin) stdinStream.reader = opts.stdin;
    this.nil = NIL;
    this.t = T;
    for (const [name, fn] of Object.entries(prims)) setGlobal(sym(name), mkprim(name, fn));
    setGlobal(INS, NIL);
    setGlobal(OUTS, NIL);
    let chars = NIL;
    for (let i = 255; i >= 0; i--) {
      const bits = i.toString(2).padStart(8, '0');
      chars = new Pair(new Pair(CHARS[i], str(bits)), chars);
    }
    setGlobal(CHARS_SYM, chars);
    const src = opts.belSource !== undefined
      ? opts.belSource
      : new TextDecoder().decode(host.readFile('interp/bel.bel'));
    loading = true;
    try {
      this.bootForms = readAll(src).length;
      loadText(src);
    } finally {
      loading = false;
    }
    for (const name of Object.keys(jets)) if (sym(name).gcell) orig[name] = sym(name).gcell.d;
    for (const [name, { fn, loc }] of Object.entries(jets)) {
      const s = sym(name);
      globalCell(s).d = mkprim(name, fn, loc);
    }
  }
  evalString(src) {
    try {
      return loadText(src);
    } finally {
      stdoutStream.flush();
    }
  }
  loadFile(path) {
    const data = host.readFile(path);
    if (!data) throw new Error('cannot open ' + path);
    try {
      return loadText(new TextDecoder().decode(data));
    } finally {
      stdoutStream.flush();
    }
  }
  call(name, ...args) {
    const f = sym(name).gcell;
    if (!f) throw new Error('undefined: ' + name);
    try {
      return applyF(f.d, args.map(toBel));
    } finally {
      stdoutStream.flush();
    }
  }
  takeOutput() { return stdoutStream.take(); }
  flush() { stdoutStream.flush(); }
  print(x) { return printString(x); }
  str(s) { return str(s); }
  jsstr(x) { return jsstr(x); }
  list(...xs) { return list(...xs); }
  toArray(l) { return listToArr(l); }
  sym(name) { return sym(name); }
  global(name) {
    const c = sym(name).gcell;
    return c ? c.d : undefined;
  }
}

export { BelError, Pair, Sym, Char, Stream, printString, readAll };

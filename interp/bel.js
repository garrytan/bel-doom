// A fast interpreter for Paul Graham's Bel (bel.bel, 9 October 2019).
//
// The evaluator implements Bel's axioms directly: the primitives, the special
// forms (quote, lit, if, apply, where, dyn, after, ccc), closures that are
// plain lists of the form (lit clo env parms body), macros of the form
// (lit mac clo), and dynamic/lexical/global lookup in that order.  It then
// loads the unmodified bel.bel, so every definition in the spec exists exactly
// as written.  For speed, 87 hot definitions are replaced afterwards by native
// "jets" with the same behavior, macro expansions are cached per call site,
// the core macros (fn do set def mac let rfn when unless and or case with
// withs for while repeat til loop) are evaluated natively while their global
// values are still the ones bel.bel defined, code is compiled to JavaScript
// closures with trampolined tail calls, and repeatedly indexed lists get a
// CDR-coding cache.  Numbers are IEEE doubles (a deliberate deviation from
// Bel's exact rationals).
//
// Full documentation: docs/interpreter.md

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
  constructor(a, d) { this.a = a; this.d = d; this.x = null; this.c = null; this.k = false; }
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
  writeString(x) {
    // One pass over a list of characters with codes below 256. On anything else
    // it undoes its partial write and returns false.
    const start = this.len;
    let buf = this.buf;
    let i = start;
    let p = x;
    for (; p instanceof Pair; p = p.d) {
      const c = p.a;
      if (!(c instanceof Char) || c.c > 255) { this.len = start; return false; }
      if (i === buf.length) {
        const nb = new Uint8Array(buf.length * 2);
        nb.set(buf);
        this.buf = buf = nb;
      }
      buf[i++] = c.c;
    }
    if (p !== NIL) { this.len = start; return false; }
    this.len = i;
    if (this.sink && this.len >= 65536) this.flush();
    return true;
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
  constructor(m, exp) { this.m = m; this.exp = exp; this.ep = CODE_EPOCH; }
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
const DYN_UVARS = new WeakSet();  // uvars that have ever been bound dynamically
let JIT_GEN = 0;         // bumps when a compiled function's assumptions may have changed
let ENV_EPOCH = 0;       // bumps on any xar/xdr, invalidating cached environment cells
let CODE_EPOCH = 0;      // bumps when a pair inside compiled code is mutated
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
    if (dyn[i].a === ERR) { errContext = null; return applyF(dyn[i].d, [msg]); }
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

const isMacroVal = (x) => x instanceof Pair && x.a === LIT && x.d instanceof Pair && x.d.a === MAC;

function setGlobal(s, v) {
  const c = globalCell(s);
  if (s.sf || isMacroVal(c.d) || isMacroVal(v)) JIT_GEN++;
  c.d = v;
  if (!loading) s.nat = false;
  if (s === VMARK_SYM) VMARK = v;
}

function assignCell(c, v) {
  if (c.a instanceof Sym && c.a.gcell === c && (c.a.sf || isMacroVal(c.d) || isMacroVal(v))) JIT_GEN++;
  c.d = v;
  if (c.a instanceof Sym) {
    if (c.a.gcell === c) {
      if (!loading) c.a.nat = false;
      if (c.a === VMARK_SYM) VMARK = v;
    }
  }
}

function bindVar(v, val, env) {
  if (v instanceof Sym) if (!v.lexb) { v.lexb = true; JIT_GEN++; }
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
    if (!v.lexb) { v.lexb = true; JIT_GEN++; }
    env = new Pair(new Pair(v, args[i++]), env);
    p = p.d;
  }
  if (p === NIL) {
    if (i < n) { errContext = parms; return sigerr(sym('overargs')); }
    return env;
  }
  if (p instanceof Sym && !p.lit) {
    if (!p.lexb) { p.lexb = true; JIT_GEN++; }
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
      if (!v.lexb) { v.lexb = true; JIT_GEN++; }
      e2 = new Pair(new Pair(v, q.a), e2);
      p = p.d;
      q = q.d;
    }
    if (p === NIL && q === NIL) return e2;
    if (p instanceof Sym && !p.lit && (q === NIL || q instanceof Pair)) {
      if (!p.lexb) { p.lexb = true; JIT_GEN++; }
      return new Pair(new Pair(p, q), e2);
    }
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
            if (v instanceof Sym) { if (!v.dynb) { v.dynb = true; JIT_GEN++; } }
            else if (!DYN_UVARS.has(v)) { DYN_UVARS.add(v); JIT_GEN++; }
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
              if (!parms.lexb) { parms.lexb = true; JIT_GEN++; }
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
              if (v instanceof Sym && !v.lit) { if (!v.lexb) { v.lexb = true; JIT_GEN++; } a = new Pair(new Pair(v, vals[i++]), a); }
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
              if (v instanceof Sym && !v.lit) { if (!v.lexb) { v.lexb = true; JIT_GEN++; } a = new Pair(new Pair(v, val), a); }
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
            if (v instanceof Sym) if (!v.lexb) { v.lexb = true; JIT_GEN++; }
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
            if (v instanceof Sym) if (!v.lexb) { v.lexb = true; JIT_GEN++; }
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
            if (name instanceof Sym) if (!name.lexb) { name.lexb = true; JIT_GEN++; }
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
      if (mc instanceof MacroCache && mc.m === f && mc.ep === CODE_EPOCH) {
        exp = mc.exp;
      } else {
        exp = applyF(f.d.d.a, listToArr(e.d));
        markCodeTree(e);
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
          if (JSTIER && !w) {
            const code = jitOf(f);
            if (code !== null) return finishTC(code(f, args));
          }
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
          if (f.d.k) epoch++;
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
        if (JSTIER) {
          const code = jitOf(f);
          if (code !== null) return finishTC(code(f, args));
        }
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
  noteMutation(cell);
  if (which === A) cell.a = v;
  else if (which === D) { if (cell.k) epoch++; assignCell(cell, v); }
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

const ENV = typeof process !== 'undefined' && process.env ? process.env : {};
let COMPILE = !ENV.BEL_NOCOMPILE && ENV.BEL_TIER !== 'ev';
let JSTIER = COMPILE && ENV.BEL_TIER !== 'closure';
// Pending tail call: kind 1 is a closure-tier body (env, node), kind 2 a
// compiled function (code, clo, args).
const TC = { k: 1, env: null, node: null, code: null, clo: null, args: null };

function finishTC(r) {
  while (r === TC) {
    if (TC.k === 2) {
      const code = TC.code, clo = TC.clo, args = TC.args;
      TC.code = null; TC.clo = null; TC.args = null;
      r = code(clo, args);
    } else {
      const n = TC.node, e = TC.env;
      r = n(e, true);
    }
  }
  return r;
}

function run(node, env) {
  return finishTC(node(env, true));
}

function comp(e) {
  if (e instanceof Sym) return e.cnode || (e.cnode = compSym(e));
  if (!(e instanceof Pair)) return () => e;
  if (e.c !== null && e.c.ep === CODE_EPOCH) return e.c;
  const ph = (a) => ev(e, a, 0);  // placeholder while compiling
  ph.ep = CODE_EPOCH;
  e.c = ph;
  markCodeTree(e);
  const n = compPair(e);
  n.ep = CODE_EPOCH;
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
        const code = JSTIER ? jitOf(f) : null;
        if (code !== null) {
          if (t) { TC.k = 2; TC.code = code; TC.clo = f; TC.args = args; return TC; }
          return finishTC(code(f, args));
        }
        const r = f.d.d;
        const env = bind(r.d.a, args, r.a);
        const body = comp(r.d.d.a);
        if (t) { TC.k = 1; TC.env = env; TC.node = body; return TC; }
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
  if (mc instanceof MacroCache && mc.m === f && mc.ep === CODE_EPOCH) return mc.exp;
  const exp = applyF(f.d.d.a, listToArr(e.d));
  markCodeTree(e);
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
    const n = argn.length;
    if (f instanceof Pair) {
      const x = f.x;
      if (typeof x === 'function') {
        const args = new Array(n);
        for (let i = 0; i < n; i++) args[i] = argn[i](a, false);
        return x(args);
      }
      if (f.a === LIT && f.d instanceof Pair) {
        const tag = f.d.a;
        if (tag === MAC) return comp(expandCached(e, f))(a, t);
        if (tag === CLO) {
          const args = new Array(n);
          for (let i = 0; i < n; i++) args[i] = argn[i](a, false);
          const code = JSTIER ? jitOf(f) : null;
          if (code !== null) {
            if (t) { TC.k = 2; TC.code = code; TC.clo = f; TC.args = args; return TC; }
            return finishTC(code(f, args));
          }
          const r = f.d.d;
          const env = bind(r.d.a, args, r.a);
          const body = comp(r.d.d.a);
          if (t) { TC.k = 1; TC.env = env; TC.node = body; return TC; }
          return finishTC(body(env, true));
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
    if (!v.lexb) { v.lexb = true; JIT_GEN++; }
    return new Pair(new Pair(v, val), a);
  }
  errContext = v;
  const r = pass(v, val, a);
  errContext = null;
  return r;
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
        if (name instanceof Sym) if (!name.lexb) { name.lexb = true; JIT_GEN++; }
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
        if (v instanceof Sym) if (!v.lexb) { v.lexb = true; JIT_GEN++; }
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


// ---------------------------------------------------------------- tier 2: Bel to JavaScript
//
// A closure that runs often is compiled to JavaScript source when its body
// can be compiled without changing what Bel programs can observe:
//
// - Only bodies that create no closures and never mention `scope` are
//   compiled, because a closure's environment is the whole alist in scope
//   when it is created, so any variable could be reached through it. In those
//   bodies parameters and `let` variables are JS locals: no alist cells.
// - Free variables are read through the closure's real environment cells
//   (cached per closure, re-resolved after any xar/xdr), globals through
//   their global cells.
// - Macros are expanded at compile time (the same memoized expansion the
//   other tiers use) behind guards; forms that need a real environment
//   (where, place set, dyn, after, ccc, bquote, til, loop) run in `ev` on an
//   alist built from the current locals, whose values are copied back.
// - Hot jets are inlined behind a per-use identity check on the global's
//   value, falling back to the jet itself for anything unusual.
// - Tail calls use the shared trampoline, self tail calls become loops, and
//   (cons x (self ...)) in tail position becomes a loop that builds the list
//   in place (tail recursion modulo cons), so recursive list functions like
//   bel.bel's map run in constant stack.
// - Any change to an assumption (a symbol bound dynamically or lexically for
//   the first time, a macro or core macro redefined, compiled code mutated)
//   bumps a generation; a compiled function re-checks its assumptions on its
//   next call and falls back to the closure tier if they no longer hold.

const JIT_THRESHOLD = 16;
const codePairs = new WeakSet();
// Marks every pair of a piece of code (not inside quote) so that changing it
// in place invalidates compiled nodes, macro expansions and compiled bodies.
// A marked pair always has its whole subtree marked, so marking stops early.
function markCodeTree(e) {
  let p = e;
  while (p instanceof Pair && !codePairs.has(p)) {
    codePairs.add(p);
    if (p.a instanceof Pair && p.a.a !== QUOTE) markCodeTree(p.a);
    p = p.d;
  }
}

function noteMutation(p) {
  ENV_EPOCH++;
  R.ee = ENV_EPOCH;
  if (codePairs.has(p)) CODE_EPOCH++;
}

class JitEntry {
  constructor(parms, body) {
    this.parms = parms; this.body = body; this.calls = 0; this.code = null; this.dead = false;
    this.gen = -1; this.epoch = -1; this.check = null; this.recompiles = 0;
  }
}
const jitTable = new WeakMap();

class CloCache {
  constructor(je) { this.je = je; this.ep = -1; this.cells = null; this.free = null; }
}

const jitStats = { compiled: 0, rejected: 0, invalidated: 0, reasons: new Map() };

function jitOf(f) {
  let cc = f.x;
  if (!(cc instanceof CloCache)) {
    if (cc !== null) return null;
    const r = f.d.d;
    if (!(r instanceof Pair) || !(r.d instanceof Pair) || !(r.d.d instanceof Pair)) return null;
    const parms = r.d.a, body = r.d.d.a;
    if (!(body instanceof Pair)) return null;
    let je = jitTable.get(body);
    if (je === undefined) { je = new JitEntry(parms, body); jitTable.set(body, je); }
    else if (je.parms !== parms) return null;
    cc = new CloCache(je);
    cc.ep = ENV_EPOCH;
    f.x = cc;
  }
  const je = cc.je;
  if (je.dead) return null;
  if (cc.ep !== ENV_EPOCH) {
    const r = f.d.d;
    if (!(r instanceof Pair) || !(r.d instanceof Pair) || !(r.d.d instanceof Pair) || r.d.a !== je.parms || r.d.d.a !== je.body) {
      f.x = null;
      return null;
    }
    cc.ep = ENV_EPOCH;
    cc.cells = null;
    cc.free = null;
  }
  if (je.code === null) {
    if (++je.calls < JIT_THRESHOLD) return null;
    let res = null;
    try {
      try {
        res = jitCompile(je.parms, je.body, false);
      } catch (ex) {
        if (!(ex instanceof JitReject) || ex.message !== 'creates a closure') throw ex;
        res = jitCompile(je.parms, je.body, true);
      }
    } catch (ex) {
      if (!(ex instanceof JitReject)) throw ex;
      jitStats.rejected++;
      jitStats.reasons.set(ex.message, (jitStats.reasons.get(ex.message) || 0) + 1);
    }
    if (res === null) { je.dead = true; return null; }
    jitStats.compiled++;
    je.code = res.code; je.check = res.check; je.gen = JIT_GEN; je.epoch = CODE_EPOCH;
  }
  if (je.epoch !== CODE_EPOCH || (je.gen !== JIT_GEN && !je.check())) {
    jitStats.invalidated++;
    je.code = null; je.calls = 0;
    if (++je.recompiles > 8) je.dead = true;
    return null;
  }
  je.gen = JIT_GEN;
  return je.code;
}

class JitReject extends Error {}
const reject = (why) => { throw new JitReject(why); };

// Runtime support for generated code.
const R = {
  NIL: null, T: null, Pair,
  slow(clo, args) {
    const r = clo.d.d;
    return run(comp(r.d.d.a), bind(r.d.a, args, r.a));
  },
  rest(args, n) { return arrToList(args, n); },
  cells(clo, syms) {
    const cc = clo.x;
    if (cc instanceof CloCache && cc.free === syms && cc.ep === ENV_EPOCH) return cc.cells;
    const env = clo.d.d.a;
    const cells = new Array(syms.length);
    for (let i = 0; i < syms.length; i++) {
      const s = syms[i];
      let c = null;
      for (let p = env; p instanceof Pair; p = p.d) if (p.a instanceof Pair && p.a.a === s) { c = p.a; break; }
      cells[i] = c !== null ? c : s.gcell;
    }
    if (cc instanceof CloCache) { cc.cells = cells; cc.free = syms; cc.ep = ENV_EPOCH; }
    return cells;
  },
  unb(s) {
    if (s.gcell !== null) return s.gcell.d;
    if (s === SCOPE || s === GLOBE) return ev(s, NIL, 0);
    return sigerr(list(UNBOUNDB, s));
  },
  assign(c, v) { assignCell(c, v); return v; },
  setg(s, v) {
    if (s.gcell !== null) assignCell(s.gcell, v);
    else setGlobal(s, v);
    return v;
  },
  call(f, args) {
    if (f instanceof Pair) {
      const x = f.x;
      if (typeof x === 'function') return x(args);
      if (f.a === LIT && f.d instanceof Pair && f.d.a === CLO) {
        if (JSTIER) {
          const code = jitOf(f);
          if (code !== null) return finishTC(code(f, args));
        }
        const r = f.d.d;
        return run(comp(r.d.d.a), bind(r.d.a, args, r.a));
      }
    }
    return applyF(f, args);
  },
  tail(f, args) {
    if (f instanceof Pair) {
      const x = f.x;
      if (typeof x === 'function') return x(args);
      if (f.a === LIT && f.d instanceof Pair && f.d.a === CLO) {
        const code = JSTIER ? jitOf(f) : null;
        if (code !== null) { TC.k = 2; TC.code = code; TC.clo = f; TC.args = args; return TC; }
        const r = f.d.d;
        const env = bind(r.d.a, args, r.a);
        const body = comp(r.d.d.a);
        TC.k = 1; TC.env = env; TC.node = body;
        return TC;
      }
    }
    return applyT(f, args, true);
  },
  isMac: isMacroVal,
  // Build a real alist from the closure's environment plus the given locals
  // (outermost first), for forms that must run in ev.
  mat(clo, pairs) {
    let env = clo.d.d.a;
    const cells = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const c = new Pair(pairs[i], pairs[i + 1]);
      cells.push(c);
      env = new Pair(c, env);
    }
    return { env, c: cells };
  },
  evm(form, m) { return ev(form, m.env, 0); },
  destr(pat, val) { return pass(pat, val, NIL); },
  eg(env, s) {
    for (let p = env; p instanceof Pair; p = p.d) if (p.a instanceof Pair && p.a.a === s) return p.a.d;
    return NIL;
  },
  ee: 0,
  lk(env, s) {
    for (let p = env; p instanceof Pair; p = p.d) if (p.a instanceof Pair && p.a.a === s) return p.a.d;
    return R.unb(s);
  },
  setIn(env, s, v) {
    for (let p = env; p instanceof Pair; p = p.d) if (p.a instanceof Pair && p.a.a === s) { assignCell(p.a, v); return v; }
    return R.setg(s, v);
  },
  cellIn(env, s) {
    for (let p = env; p instanceof Pair; p = p.d) if (p.a instanceof Pair && p.a.a === s) return p.a;
    return new Pair(s, NIL);
  },
  destr2(pat, val, env) { return pass(pat, val, env); },
  evEnv(form, env) { return ev(form, env, 0); },
  mkclo(env, parms, body) { return makeClo(env, parms, body); },
  mkrfn(env, name, parms, body) {
    const cell = new Pair(name, NIL);
    const clo = makeClo(new Pair(cell, env), parms, body);
    cell.d = clo;
    return clo;
  },
  globe() { return globeList(); },
  uv(env, u) {
    for (let i = dyn.length - 1; i >= 0; i--) if (dyn[i].a === u) return dyn[i].d;
    for (let p = env; p instanceof Pair; p = p.d) if (p.a instanceof Pair && p.a.a === u) return p.a.d;
    return sigerr(sym('unbound'));
  },
  less(a, b) { return less(a, b); },
  mistype() { return sigerr(sym('mistype')); },
  num(x) { return num(x); },
  nth,
  mod(x, y) {
    if (y !== 0 && Number.isInteger(x) && Number.isInteger(y)) return ((x % y) + y) % y;
    return null;
  },
};

const CORE_FORMS = new Set([FN, DO, SET, DEF, MAC, LET, RFN, WHEN, UNLESS, AND, OR, CASE, WITH, WITHS, FOR, WHILE, REPEAT, TIL, LOOP]);
const FALLBACK_FORMS = new Set([WHERE, DYN, AFTER, CCC, BQUOTE, TIL, LOOP]);
const DANGEROUS = new Set(['fn', 'rfn', 'afn', 'def', 'mac', 'macro', 'scope', 'globe', 'thread', 'loc', 'vir', 'form', 'syn', 'com']);

function jitCompile(parms, body, CELLS) {
  const K = [];
  const kmap = new Map();
  const k = (v) => {
    let i = kmap.get(v);
    if (i === undefined) { i = K.length; K.push(v); kmap.set(v, i); }
    return `K[${i}]`;
  };
  const varSyms = new Set();      // every symbol read or written as a variable
  const globalSyms = new Set();   // free symbols assumed global (never lexically bound)
  const macroGuards = new Map();  // symbol -> macro value expanded at compile time
  const coreSyms = new Set();     // core macros compiled natively
  const funSyms = new Set();      // global operators assumed not to be macros
  const freeSyms = [];            // free lexical symbols, resolved through the closure env
  const freeIndex = new Map();
  const hoisted = [];
  let tmpN = 0, varN = 0;
  const tmp = () => { const n = `$t${tmpN++}`; hoisted.push(n); return n; };
  const fresh = (s) => { const n = `v${varN++}_${((s instanceof Sym ? s.name : "uvar").replace(/[^A-Za-z0-9_]/g, '_')).slice(0, 12)}`; hoisted.push(n); return n; };

  const isUvar = (x) => x instanceof Pair && VMARK !== undefined && x.a === VMARK;
  const isVarSym = (x) => (x instanceof Sym && !x.lit) || isUvar(x);

  // scope: array of [sym, jsname], innermost last
  const lookupLocal = (scope, s) => {
    for (let i = scope.length - 1; i >= 0; i--) if (scope[i][0] === s) return scope[i][1];
    return null;
  };

  const markCode = markCodeTree;
  markCode(parms);
  markCode(body);

  // Parameters. Simple ones (plain symbols, optional rest) bind straight from
  // the argument array and allow self-call loops; optional (o x d), typed
  // (t x f) and destructured parameters bind in the entry prologue.
  const params = [];
  let restSym = null;
  let simpleParams = true;
  {
    let p = parms;
    while (p instanceof Pair) {
      if (!isVarSym(p.a)) simpleParams = false;
      params.push(p.a);
      p = p.d;
    }
    if (p !== NIL) {
      if (!isVarSym(p)) reject('complex parameters');
      restSym = p;
    }
  }
  const scope0 = [];
  let paramNames = [];
  let restName = null;
  let prologue = '';
  let minArgs = 0, maxArgs = params.length;
  if (simpleParams) {
    paramNames = params.map((s) => { varSyms.add(s); const n = fresh(s); scope0.push([s, n]); return n; });
    minArgs = params.length;
    if (restSym) { varSyms.add(restSym); restName = fresh(restSym); scope0.push([restSym, restName]); }
  }
  const lit = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? '-0' : String(v)) : k(v);
    return k(v);
  };

  const scanDanger = (e) => {
    if (e instanceof Sym) { if (DANGEROUS.has(e.name)) reject('closure or scope inside fallback form'); return; }
    if (!(e instanceof Pair)) return;
    if (e.a === QUOTE) return;
    let p = e;
    while (p instanceof Pair) {
      const x = p.a;
      if (x instanceof Sym) {
        if (DANGEROUS.has(x.name)) reject('closure or scope inside fallback form');
        if (p === e && x.gcell && isMacroVal(x.gcell.d) && !CORE_FORMS.has(x) && x !== BQUOTE && x !== COMMA && x !== COMMA_AT) reject('macro inside fallback form');
      } else scanDanger(x);
      p = p.d;
    }
  };

  const varRef = (s, scope) => {
    varSyms.add(s);
    const local = lookupLocal(scope, s);
    if (local !== null) return CELLS ? `(R.ee === $ee ? ${local}.d : R.lk($env, ${k(s)}))` : local;
    if (isUvar(s)) return `R.uv(${CELLS ? '$env' : 'clo.d.d.a'}, ${k(s)})`;
    if (s === SCOPE) { if (!CELLS) reject('creates a closure'); return '$env'; }
    if (s === GLOBE) { if (!CELLS) reject('creates a closure'); return 'R.globe()'; }
    if (s.lexb) {
      let i = freeIndex.get(s);
      if (i === undefined) { i = freeSyms.length; freeSyms.push(s); freeIndex.set(s, i); }
      const c = tmp();
      return `((${c} = ($fc || ($fc = R.cells(clo, FREE)))[${i}]) !== null ? ${c}.d : R.unb(${k(s)}))`;
    }
    globalSyms.add(s);
    const c = tmp();
    return `((${c} = ${k(s)}.gcell) !== null ? ${c}.d : R.unb(${k(s)}))`;
  };

  const varSet = (s, valExpr, scope) => {
    varSyms.add(s);
    const local = lookupLocal(scope, s);
    if (local !== null) {
      if (!CELLS) return `(${local} = ${valExpr})`;
      const v = tmp();
      return `(${v} = ${valExpr}, R.ee === $ee ? R.assign(${local}, ${v}) : R.setIn($env, ${k(s)}, ${v}))`;
    }
    if (isUvar(s)) reject('set on a free uvar');
    if (s.lexb) {
      let i = freeIndex.get(s);
      if (i === undefined) { i = freeSyms.length; freeSyms.push(s); freeIndex.set(s, i); }
      const c = tmp(), v = tmp();
      return `(${v} = ${valExpr}, (${c} = ($fc || ($fc = R.cells(clo, FREE)))[${i}]) !== null && ${c}.a === ${k(s)} ? R.assign(${c}, ${v}) : R.setg(${k(s)}, ${v}))`;
    }
    globalSyms.add(s);
    return `R.setg(${k(s)}, ${valExpr})`;
  };

  // A fallback form runs in ev on an alist built from the current locals.
  const fallback = (e, scope) => {
    if (CELLS) { for (const [s] of scope) varSyms.add(s); return `R.evEnv(${k(e)}, $env)`; }
    scanDanger(e);
    for (const [s] of scope) varSyms.add(s);
    const m = tmp(), r = tmp();
    const pairs = scope.map(([s, n]) => `${k(s)}, ${n}`).join(', ');
    const back = scope.map(([, n], i) => `${n} = ${m}.c[${i}].d`).join(', ');
    return `(${m} = R.mat(clo, [${pairs}]), ${r} = R.evm(${k(e)}, ${m})${back ? ', ' + back : ''}, ${r})`;
  };

  // Destructuring pattern: plain symbols and nested lists of them, with rest.
  const patVars = (pat, out) => {
    if (isVarSym(pat)) { out.push(pat); return; }
    if (pat === NIL) return;
    if (!(pat instanceof Pair)) reject('pattern');
    if (pat.a === T || pat.a === O) reject('typed or optional pattern');
    patVars(pat.a, out);
    patVars(pat.d, out);
  };
  const patCheck = (pat, path, checks, assigns, names) => {
    if (isVarSym(pat)) {
      assigns.push(CELLS ? `${names.get(pat)} = new R.Pair(${k(pat)}, ${path}), $env = new R.Pair(${names.get(pat)}, $env)` : `${names.get(pat)} = ${path}`);
      return;
    }
    if (pat === NIL) { checks.push(`${path} === R.NIL`); return; }
    checks.push(`${path} instanceof R.Pair`);
    patCheck(pat.a, `${path}.a`, checks, assigns, names);
    patCheck(pat.d, `${path}.d`, checks, assigns, names);
  };
  const bindOne = (s, n, valExpr) => CELLS
    ? `(${n} = new R.Pair(${k(s)}, ${valExpr}), $env = new R.Pair(${n}, $env))`
    : `(${n} = ${valExpr})`;
  // returns [expr that binds, newScope]
  const bindPattern = (pat, valExpr, scope) => {
    if (isVarSym(pat)) {
      varSyms.add(pat);
      const n = fresh(pat);
      return [bindOne(pat, n, valExpr), scope.concat([[pat, n]])];
    }
    const vars = [];
    patVars(pat, vars);
    const names = new Map();
    const newScope = scope.slice();
    for (const s of vars) { varSyms.add(s); const n = fresh(s); names.set(s, n); newScope.push([s, n]); }
    const p = tmp();
    const checks = [], assigns = [];
    patCheck(pat, p, checks, assigns, names);
    if (CELLS) {
      const slow = vars.map((s) => `${names.get(s)} = R.cellIn($env, ${k(s)})`).join(', ');
      return [`(${p} = ${valExpr}, (${checks.join(' && ') || 'true'}) ? (${assigns.join(', ') || '0'}) : ($env = R.destr2(${k(pat)}, ${p}, $env)${slow ? ', ' + slow : ''}), 0)`, newScope];
    }
    const e2 = tmp();
    const slow = vars.map((s) => `${names.get(s)} = R.eg(${e2}, ${k(s)})`).join(', ');
    return [`(${p} = ${valExpr}, (${checks.join(' && ') || 'true'}) ? (${assigns.join(', ') || '0'}) : (${e2} = R.destr(${k(pat)}, ${p})${slow ? ', ' + slow : ''}), 0)`, newScope];
  };

  const bindParam = (pp, valExpr, scope) => {
    if (pp instanceof Pair && pp.a === T) {
      const v = pp.d.a, f = pp.d.d.a;
      const t = tmp();
      const [b, s2] = bindParam(v, t, scope);
      return [`${t} = ${valExpr}, (R.call(${E(f, scope)}, [${t}]) === R.NIL ? R.mistype() : 0), ${b}`, s2];
    }
    if (pp instanceof Pair && pp.a === O) reject('optional inside pattern');
    return bindPattern(pp, valExpr, scope);
  };

  // In cells mode an expression that binds variables restores the environment
  // afterwards, so later closures don't capture bindings that are out of scope.
  const scoped = (inner) => {
    if (!CELLS) return `(${inner})`;
    const sv = tmp(), r = tmp();
    return `(${sv} = $env, ${r} = (${inner}), $env = ${sv}, ${r})`;
  };

  const seqExpr = (forms, scope) => {
    const xs = listToArr(forms);
    if (xs.length === 0) return 'R.NIL';
    return '(' + xs.map((x) => E(x, scope)).join(', ') + ')';
  };

  const coreOk = (s) => {
    if (!s.nat || s.lexb || s.dynb) return false;
    coreSyms.add(s);
    return true;
  };

  // inline jets: name -> [arity, (f, args) => expr]
  const NUM2 = (op) => (f, a) => `(typeof ${a[0]} === 'number' && typeof ${a[1]} === 'number' ? ${a[0]} ${op} ${a[1]} : ${f}.x([${a[0]}, ${a[1]}]))`;
  const CMP2 = (op) => (f, a) => `(typeof ${a[0]} === 'number' && typeof ${a[1]} === 'number' ? (${a[0]} ${op} ${a[1]} ? R.T : R.NIL) : ${f}.x([${a[0]}, ${a[1]}]))`;
  const NUMN = (op) => (f, a) => `(${a.map((x) => `typeof ${x} === 'number'`).join(' && ')} ? ${op === '+' ? '0 + ' : ''}${a.join(` ${op} `)} : ${f}.x([${a.join(', ')}]))`;
  const INLINE = {
    '+': [[2, 3, 4], NUMN('+')], '*': [[2, 3, 4], NUMN('*')],
    '-': [[1, 2, 3, 4], (f, a) => a.length === 1
      ? `(typeof ${a[0]} === 'number' ? -${a[0]} : ${f}.x([${a[0]}]))`
      : NUMN('-')(f, a)],
    'nth': [2, (f, a) => `(typeof ${a[0]} === 'number' ? R.nth(${a[0]}, ${a[1]}) : ${f}.x([${a[0]}, ${a[1]}]))`],
    '/': [2, (f, a) => `(typeof ${a[0]} === 'number' && typeof ${a[1]} === 'number' && ${a[1]} !== 0 ? ${a[0]} / ${a[1]} : ${f}.x([${a[0]}, ${a[1]}]))`],
    '<': [2, CMP2('<')], '>': [2, CMP2('>')], '<=': [2, CMP2('<=')], '>=': [2, CMP2('>=')],
    '=': [2, (f, a) => `(${a[0]} === ${a[1]} ? R.T : ${f}.x([${a[0]}, ${a[1]}]))`],
    'id': [2, (f, a) => `(${a[0]} === ${a[1]} ? R.T : ${f}.x([${a[0]}, ${a[1]}]))`],
    'no': [1, (f, a) => `(${a[0]} === R.NIL ? R.T : R.NIL)`],
    'atom': [1, (f, a) => `(${a[0]} instanceof R.Pair ? R.NIL : R.T)`],
    'pair': [1, (f, a) => `(${a[0]} instanceof R.Pair ? R.T : R.NIL)`],
    'car': [1, (f, a) => `(${a[0]} instanceof R.Pair ? ${a[0]}.a : ${f}.x([${a[0]}]))`],
    'cdr': [1, (f, a) => `(${a[0]} instanceof R.Pair ? ${a[0]}.d : ${f}.x([${a[0]}]))`],
    'cadr': [1, (f, a) => `(${a[0]} instanceof R.Pair && ${a[0]}.d instanceof R.Pair ? ${a[0]}.d.a : ${f}.x([${a[0]}]))`],
    'cddr': [1, (f, a) => `(${a[0]} instanceof R.Pair && ${a[0]}.d instanceof R.Pair ? ${a[0]}.d.d : ${f}.x([${a[0]}]))`],
    'caddr': [1, (f, a) => `(${a[0]} instanceof R.Pair && ${a[0]}.d instanceof R.Pair && ${a[0]}.d.d instanceof R.Pair ? ${a[0]}.d.d.a : ${f}.x([${a[0]}]))`],
    'cons': [2, (f, a) => `new R.Pair(${a[0]}, ${a[1]})`],
    'join': [2, (f, a) => `new R.Pair(${a[0]}, ${a[1]})`],
    'inc': [1, (f, a) => `(typeof ${a[0]} === 'number' ? ${a[0]} + 1 : ${f}.x([${a[0]}]))`],
    'dec': [1, (f, a) => `(typeof ${a[0]} === 'number' ? ${a[0]} - 1 : ${f}.x([${a[0]}]))`],
    'floor': [1, (f, a) => `(typeof ${a[0]} === 'number' ? Math.floor(${a[0]}) : ${f}.x([${a[0]}]))`],
    'abs': [1, (f, a) => `(typeof ${a[0]} === 'number' ? Math.abs(${a[0]}) : ${f}.x([${a[0]}]))`],
    'mod': [2, (f, a) => { const t = tmp(); return `(typeof ${a[0]} === 'number' && typeof ${a[1]} === 'number' && (${t} = R.mod(${a[0]}, ${a[1]})) !== null ? ${t} : ${f}.x([${a[0]}, ${a[1]}]))`; }],
    'max': [2, (f, a) => `(typeof ${a[0]} === 'number' && typeof ${a[1]} === 'number' ? (${a[0]} < ${a[1]} ? ${a[1]} : ${a[0]}) : ${f}.x([${a[0]}, ${a[1]}]))`],
    'min': [2, (f, a) => `(typeof ${a[0]} === 'number' && typeof ${a[1]} === 'number' ? (${a[1]} < ${a[0]} ? ${a[1]} : ${a[0]}) : ${f}.x([${a[0]}, ${a[1]}]))`],
  };

  // The value of an operator expression and whether it is a known global.
  const opInfo = (op, scope) => {
    if (op instanceof Sym && !op.lit && lookupLocal(scope, op) === null && !op.lexb) {
      return { global: op };
    }
    return { global: null };
  };

  // expression context
  const E = (e, scope) => {
    if (e instanceof Sym) return e.lit ? k(e) : varRef(e, scope);
    if (!(e instanceof Pair)) return lit(e);
    const op = e.a;
    if (op === VMARK && VMARK !== undefined) return varRef(e, scope);
    if (op instanceof Char) return k(e);
    if (op instanceof Sym && op.sf !== 0) {
      const sf = op.sf;
      if (sf === SF_QUOTE) return k(e.d.a);
      if (sf === SF_LIT) return k(e);
      if (sf === SF_IF) {
        const parts = listToArr(e.d);
        const go = (i) => {
          if (i >= parts.length) return 'R.NIL';
          if (i === parts.length - 1) return E(parts[i], scope);
          return `(${E(parts[i], scope)} !== R.NIL ? ${E(parts[i + 1], scope)} : ${go(i + 2)})`;
        };
        return go(0);
      }
      if (sf === SF_THREAD) reject('thread');
      if (FALLBACK_FORMS.has(op) && (sf < SF_FN || coreOk(op))) return fallback(e, scope);
      if (sf >= SF_FN) {
        if (!coreOk(op)) reject('core macro redefined or shadowed');
        switch (sf) {
          case SF_FN:
            if (!CELLS) reject('creates a closure');
            for (const [s2] of scope) varSyms.add(s2);
            return `R.mkclo($env, ${k(e.d.a)}, ${k(fnBody(e))})`;
          case SF_RFN:
            if (!CELLS) reject('creates a closure');
            for (const [s2] of scope) varSyms.add(s2);
            return `R.mkrfn($env, ${k(e.d.a)}, ${k(e.d.d.a)}, ${k(fnBody(e.d))})`;
          case SF_DEF: case SF_MAC:
            if (!CELLS) reject('creates a closure');
            return fallback(e, scope);
          case SF_DO: return seqExpr(e.d, scope);
          case SF_SET: {
            const xs = listToArr(e.d);
            const parts = [];
            for (let i = 0; i < xs.length; i += 2) {
              const p = xs[i];
              const v = i + 1 < xs.length ? E(xs[i + 1], scope) : 'R.T';
              if (isVarSym(p)) parts.push(varSet(p, v, scope));
              else return fallback(e, scope);
            }
            return parts.length ? `(${parts.join(', ')})` : 'R.T';
          }
          case SF_LET: {
            const [b, sc] = bindPattern(e.d.a, E(e.d.d.a, scope), scope);
            return scoped(`${b}, ${seqExpr(e.d.d.d, sc)}`);
          }
          case SF_WITH: case SF_WITHS: {
            const xs = listToArr(e.d.a);
            let sc = scope;
            const parts = [];
            if (sf === SF_WITH) {
              const ts = [];
              for (let i = 0; i < xs.length; i += 2) { const t = tmp(); ts.push(t); parts.push(`${t} = ${E(xs[i + 1] === undefined ? NIL : xs[i + 1], scope)}`); }
              for (let i = 0; i < xs.length; i += 2) { const [b, s2] = bindPattern(xs[i], ts[i / 2], sc); parts.push(b); sc = s2; }
            } else {
              for (let i = 0; i < xs.length; i += 2) { const [b, s2] = bindPattern(xs[i], E(xs[i + 1] === undefined ? NIL : xs[i + 1], sc), sc); parts.push(b); sc = s2; }
            }
            parts.push(seqExpr(e.d.d, sc));
            return scoped(parts.join(', '));
          }
          case SF_WHEN: case SF_UNLESS:
            return `(${E(e.d.a, scope)} ${sf === SF_WHEN ? '!==' : '==='} R.NIL ? ${seqExpr(e.d.d, scope)} : R.NIL)`;
          case SF_AND: {
            const xs = listToArr(e.d);
            if (xs.length === 0) return 'R.T';
            let out = E(xs[xs.length - 1], scope);
            for (let i = xs.length - 2; i >= 0; i--) out = `(${E(xs[i], scope)} === R.NIL ? R.NIL : ${out})`;
            return out;
          }
          case SF_OR: {
            const xs = listToArr(e.d);
            if (xs.length === 0) return 'R.NIL';
            let out = E(xs[xs.length - 1], scope);
            for (let i = xs.length - 2; i >= 0; i--) { const t = tmp(); out = `((${t} = ${E(xs[i], scope)}) !== R.NIL ? ${t} : ${out})`; }
            return out;
          }
          case SF_CASE: {
            const t = tmp();
            const rest = listToArr(e.d.d);
            const go = (i) => {
              if (i >= rest.length) return 'R.NIL';
              if (i === rest.length - 1) return E(rest[i], scope);
              const key = rest[i];
              const test = (key instanceof Sym || typeof key === 'number' || key instanceof Char) ? `${t} === ${lit(key)}` : `R.equal(${t}, ${k(key)})`;
              return `(${test} ? ${E(rest[i + 1], scope)} : ${go(i + 2)})`;
            };
            return `(${t} = ${E(e.d.a, scope)}, ${go(0)})`;
          }
          case SF_FOR: case SF_WHILE: case SF_REPEAT:
            return `(() => { ${loopStmt(e, scope)} return R.NIL; })()`;
        }
        reject('unsupported core form');
      }
    }
    // direct lambda ((fn parms . body) args...)
    if (op instanceof Pair && op.a === FN && FN.nat && !FN.lexb && !FN.dynb) {
      coreSyms.add(FN);
      const ps = op.d.a;
      const args = listToArr(e.d);
      const vals = args.map((x) => { const t = tmp(); return [t, E(x, scope)]; });
      let sc = scope;
      const parts = vals.map(([t, v]) => `${t} = ${v}`);
      let p = ps, i = 0;
      while (p instanceof Pair) {
        if (!isVarSym(p.a) || i >= vals.length) reject('direct lambda parameters');
        const [b, s2] = bindPattern(p.a, vals[i++][0], sc); parts.push(b); sc = s2;
        p = p.d;
      }
      if (p === NIL) { if (i !== vals.length) reject('direct lambda arity'); }
      else if (isVarSym(p)) { const [b, s2] = bindPattern(p, `R.rest([${vals.slice(i).map((v) => v[0]).join(', ')}], 0)`, sc); parts.push(b); sc = s2; }
      else reject('direct lambda parameters');
      parts.push(seqExpr(fnBodyList(op), sc));
      return scoped(parts.join(', '));
    }
    return callExpr(e, scope, false);
  };

  const fnBodyList = (fe) => fe.d.d;

  // macro call at compile time?
  const macroOf = (op, scope) => {
    if (!(op instanceof Sym) || op.lit || lookupLocal(scope, op) !== null || op.lexb || op.dynb) return null;
    const c = op.gcell;
    if (c === null || !isMacroVal(c.d)) return null;
    return c.d;
  };

  // generic call; returns an expression (value) or, with tail=true, statements
  const callExpr = (e, scope, tail) => {
    const op = e.a;
    const m = macroOf(op, scope);
    if (m !== null) {
      macroGuards.set(op, m);
      const exp = expandCached(e, m);
      markCode(exp);
      return tail ? T(exp, scope) : E(exp, scope);
    }
    const args = listToArr(e.d);
    const info = opInfo(op, scope);
    const f = tmp();
    const opExpr = E(op, scope);
    if (info.global) funSyms.add(info.global);
    const ats = args.map(() => tmp());
    const evalArgs = args.map((x, i) => `${ats[i]} = ${E(x, scope)}`);
    // inline jet (the identity guard decides at run time, so a free name that is
    // also bound lexically elsewhere can inline too)
    const inl = info.global || (op instanceof Sym && !op.lit && lookupLocal(scope, op) === null && !isUvar(op) ? op : null);
    if (inl) {
      const g = inl;
      const jetName = g.name;
      const spec = INLINE[jetName];
      const cur = g.gcell ? g.gcell.d : null;
      if (spec && cur instanceof Pair && typeof cur.x === 'function') {
        const arities = Array.isArray(spec[0]) ? spec[0] : [spec[0]];
        if (arities.includes(args.length)) {
          const fast = spec[1](f, ats);
          const generic = `R.call(${f}, [${ats.join(', ')}])`;
          const expr = `(${f} = ${opExpr}${evalArgs.length ? ', ' + evalArgs.join(', ') : ''}, ${f} === ${k(cur)} ? ${fast} : ${generic})`;
          return tail ? `return $fin(${expr});` : expr;
        }
      }
    }
    const macCheck = info.global ? '' : `R.isMac(${f}) ? ${fallback(e, scope)} : `;
    if (!tail) {
      return `(${f} = ${opExpr}, ${macCheck}(${evalArgs.length ? evalArgs.join(', ') + ', ' : ''}R.call(${f}, [${ats.join(', ')}])))`;
    }
    // tail call: self call becomes a loop
    const selfLoop = selfAssign(ats);
    const lines = [];
    lines.push(`${f} = ${opExpr};`);
    if (!info.global) lines.push(`if (R.isMac(${f})) return $fin(${fallback(e, scope)});`);
    for (const x of evalArgs) lines.push(`${x};`);
    if (selfLoop !== null) lines.push(`if (${f} === clo) { ${selfLoop} continue; }`);
    lines.push(`if ($last === null) return R.tail(${f}, [${ats.join(', ')}]);`);
    lines.push(`return $fin(R.call(${f}, [${ats.join(', ')}]));`);
    return lines.join(' ');
  };

  // assignment of new argument values to the parameters, or null if the arity can't match
  const selfAssign = (ats) => {
    if (!simpleParams) return null;
    if (restName === null && ats.length !== paramNames.length) return null;
    if (restName !== null && ats.length < paramNames.length) return null;
    if (CELLS) {
      const parts = ['$env = clo.d.d.a; $ee = R.ee;'];
      paramNames.forEach((n, i) => parts.push(`${n} = new R.Pair(${k(params[i])}, ${ats[i]}); $env = new R.Pair(${n}, $env);`));
      if (restName !== null) parts.push(`${restName} = new R.Pair(${k(restSym)}, R.rest([${ats.slice(paramNames.length).join(', ')}], 0)); $env = new R.Pair(${restName}, $env);`);
      return parts.join(' ');
    }
    const parts = paramNames.map((n, i) => `${n} = ${ats[i]};`);
    if (restName !== null) parts.push(`${restName} = R.rest([${ats.slice(paramNames.length).join(', ')}], 0);`);
    return parts.join(' ');
  };

  const loopStmt = (e, scope) => {
    const sf = e.a.sf;
    if (sf === SF_WHILE) {
      return `while (${E(e.d.a, scope)} !== R.NIL) { ${listToArr(e.d.d).map((x) => E(x, scope) + ';').join(' ')} }`;
    }
    if (sf === SF_REPEAT) {
      const n = tmp(), i = tmp();
      return `${n} = ${E(e.d.a, scope)}; for (${i} = 1; !R.less(${n}, ${i}); ${i}++) { ${listToArr(e.d.d).map((x) => E(x, scope) + ';').join(' ')} }`;
    }
    const v = e.d.a;
    if (!isVarSym(v)) reject('for variable');
    const i = tmp(), mx = tmp();
    varSyms.add(v);
    const n = fresh(v);
    const sc = scope.concat([[v, n]]);
    if (CELLS) {
      const outer = tmp();
      return `${i} = ${E(e.d.d.a, scope)}; ${mx} = ${E(e.d.d.d.a, scope)}; ${outer} = $env; while (typeof ${mx} === 'number' && typeof ${i} === 'number' ? ${i} <= ${mx} : !R.less(${mx}, ${i})) { ${n} = new R.Pair(${k(v)}, ${i}); $env = new R.Pair(${n}, ${outer}); ${listToArr(e.d.d.d.d).map((x) => E(x, sc) + ';').join(' ')} ${i} = R.num(R.ee === $ee ? ${n}.d : R.lk($env, ${k(v)})) + 1; } $env = ${outer};`;
    }
    return `${i} = ${E(e.d.d.a, scope)}; ${mx} = ${E(e.d.d.d.a, scope)}; while (typeof ${mx} === 'number' && typeof ${i} === 'number' ? ${i} <= ${mx} : !R.less(${mx}, ${i})) { ${n} = ${i}; ${listToArr(e.d.d.d.d).map((x) => E(x, sc) + ';').join(' ')} ${i} = R.num(${n}) + 1; }`;
  };

  // tail context: statements that return (or continue the self loop)
  const T = (e, scope) => {
    if (!(e instanceof Pair) || e.a instanceof Char) return `return $fin(${E(e, scope)});`;
    const op = e.a;
    if (op instanceof Sym && op.sf !== 0) {
      const sf = op.sf;
      if (sf === SF_IF) {
        const parts = listToArr(e.d);
        const go = (i) => {
          if (i >= parts.length) return 'return $fin(R.NIL);';
          if (i === parts.length - 1) return T(parts[i], scope);
          return `if (${E(parts[i], scope)} !== R.NIL) { ${T(parts[i + 1], scope)} } else { ${go(i + 2)} }`;
        };
        return go(0);
      }
      if (sf >= SF_FN && !FALLBACK_FORMS.has(op) && coreOk(op)) {
        const seqT = (forms, sc) => {
          const xs = listToArr(forms);
          if (xs.length === 0) return 'return $fin(R.NIL);';
          return xs.slice(0, -1).map((x) => E(x, sc) + ';').join(' ') + ' ' + T(xs[xs.length - 1], sc);
        };
        switch (sf) {
          case SF_DO: return seqT(e.d, scope);
          case SF_LET: {
            const [b, sc] = bindPattern(e.d.a, E(e.d.d.a, scope), scope);
            return `${b}; ${seqT(e.d.d.d, sc)}`;
          }
          case SF_WITH: case SF_WITHS: {
            const xs = listToArr(e.d.a);
            let sc = scope;
            const parts = [];
            if (sf === SF_WITH) {
              const ts = [];
              for (let i = 0; i < xs.length; i += 2) { const t = tmp(); ts.push(t); parts.push(`${t} = ${E(xs[i + 1] === undefined ? NIL : xs[i + 1], scope)};`); }
              for (let i = 0; i < xs.length; i += 2) { const [b, s2] = bindPattern(xs[i], ts[i / 2], sc); parts.push(b + ';'); sc = s2; }
            } else {
              for (let i = 0; i < xs.length; i += 2) { const [b, s2] = bindPattern(xs[i], E(xs[i + 1] === undefined ? NIL : xs[i + 1], sc), sc); parts.push(b + ';'); sc = s2; }
            }
            return parts.join(' ') + ' ' + seqT(e.d.d, sc);
          }
          case SF_WHEN: case SF_UNLESS:
            return `if (${E(e.d.a, scope)} ${sf === SF_WHEN ? '!==' : '==='} R.NIL) { ${seqT(e.d.d, scope)} } else { return $fin(R.NIL); }`;
          case SF_AND: {
            const xs = listToArr(e.d);
            if (xs.length === 0) return 'return $fin(R.T);';
            return xs.slice(0, -1).map((x) => `if (${E(x, scope)} === R.NIL) return $fin(R.NIL);`).join(' ') + ' ' + T(xs[xs.length - 1], scope);
          }
          case SF_OR: {
            const xs = listToArr(e.d);
            if (xs.length === 0) return 'return $fin(R.NIL);';
            return xs.slice(0, -1).map((x) => { const t = tmp(); return `if ((${t} = ${E(x, scope)}) !== R.NIL) return $fin(${t});`; }).join(' ') + ' ' + T(xs[xs.length - 1], scope);
          }
          case SF_FOR: case SF_WHILE: case SF_REPEAT:
            return `${loopStmt(e, scope)} return $fin(R.NIL);`;
          case SF_CASE: {
            const t = tmp();
            const rest = listToArr(e.d.d);
            const go = (i) => {
              if (i >= rest.length) return 'return $fin(R.NIL);';
              if (i === rest.length - 1) return T(rest[i], scope);
              const key = rest[i];
              const test = (key instanceof Sym || typeof key === 'number' || key instanceof Char) ? `${t} === ${lit(key)}` : `R.equal(${t}, ${k(key)})`;
              return `if (${test}) { ${T(rest[i + 1], scope)} } else { ${go(i + 2)} }`;
            };
            return `${t} = ${E(e.d.a, scope)}; ${go(0)}`;
          }
        }
      }
      return `return $fin(${E(e, scope)});`;
    }
    if (op === VMARK && VMARK !== undefined) return `return $fin(${E(e, scope)});`;
    if (op instanceof Pair && op.a === FN && FN.nat && !FN.lexb && !FN.dynb) {
      // direct lambda in tail position: bind, then the body is in tail position
      coreSyms.add(FN);
      const args = listToArr(e.d);
      const vals = args.map((x) => { const t = tmp(); return [t, E(x, scope)]; });
      let sc = scope;
      const parts = vals.map(([t, v]) => `${t} = ${v};`);
      let pp = op.d.a, i = 0;
      while (pp instanceof Pair) {
        if (!isVarSym(pp.a) || i >= vals.length) reject('direct lambda parameters');
        const [b, s2] = bindPattern(pp.a, vals[i++][0], sc); parts.push(b + ';'); sc = s2;
        pp = pp.d;
      }
      if (pp === NIL) { if (i !== vals.length) reject('direct lambda arity'); }
      else if (isVarSym(pp)) { const [b, s2] = bindPattern(pp, `R.rest([${vals.slice(i).map((v) => v[0]).join(', ')}], 0)`, sc); parts.push(b + ';'); sc = s2; }
      else reject('direct lambda parameters');
      const xs = listToArr(fnBodyList(op));
      if (xs.length === 0) return parts.join(' ') + ' return $fin(R.NIL);';
      return parts.join(' ') + ' ' + xs.slice(0, -1).map((x) => E(x, sc) + ';').join(' ') + ' ' + T(xs[xs.length - 1], sc);
    }
    if (op instanceof Pair) return `return $fin(${E(e, scope)});`;
    // (cons a (self ...)) in tail position: build the list in place
    if (op instanceof Sym && op === sym('cons') && !op.lexb && !op.dynb && lookupLocal(scope, op) === null && macroOf(op, scope) === null) {
      const args = listToArr(e.d);
      const inner = args[1];
      if (args.length === 2 && inner instanceof Pair && inner.a instanceof Sym && !inner.a.lit && inner.a.sf === 0 && macroOf(inner.a, scope) === null) {
        const cur = op.gcell ? op.gcell.d : null;
        if (cur instanceof Pair && typeof cur.x === 'function') {
          funSyms.add(op);
          const f = tmp(), a0 = tmp(), g = tmp();
          const innerArgs = listToArr(inner.d);
          const ats = innerArgs.map(() => tmp());
          const selfLoop = selfAssign(ats);
          if (selfLoop !== null) {
            const innerInfo = opInfo(inner.a, scope);
            if (innerInfo.global) funSyms.add(innerInfo.global);
            const lines = [];
            lines.push(`${f} = ${E(op, scope)};`);
            lines.push(`${a0} = ${E(args[0], scope)};`);
            lines.push(`${g} = ${E(inner.a, scope)};`);
            if (!innerInfo.global) lines.push(`if (R.isMac(${g})) return $fin(R.call(${f}, [${a0}, ${fallback(inner, scope)}]));`);
            innerArgs.forEach((x, i) => lines.push(`${ats[i]} = ${E(x, scope)};`));
            lines.push(`if (${f} === ${k(cur)} && ${g} === clo) { const $c = new R.Pair(${a0}, R.NIL); if ($last === null) $head = $c; else $last.d = $c; $last = $c; ${selfLoop} continue; }`);
            lines.push(`return $fin(R.call(${f}, [${a0}, R.call(${g}, [${ats.join(', ')}])]));`);
            return lines.join(' ');
          }
        }
      }
    }
    return callExpr(e, scope, true);
  };

  if (!simpleParams) {
    // bind each parameter in order; defaults and type checks see earlier ones
    let sc = scope0.slice();
    const lines = [];
    params.forEach((pp, i) => {
      if (pp instanceof Pair && pp.a === O) {
        const v = pp.d instanceof Pair ? pp.d.a : NIL;
        const dexp = pp.d instanceof Pair && pp.d.d instanceof Pair ? pp.d.d.a : NIL;
        const t = tmp();
        lines.push(`${t} = args.length > ${i} ? args[${i}] : ${E(dexp, sc)};`);
        const [b, s2] = bindParam(v, t, sc);
        lines.push(b + ';');
        sc = s2;
      } else {
        minArgs = i + 1;
        if (pp instanceof Pair && pp.a !== T && !isUvar(pp)) {
          // destructured parameter: check the shape first; on mismatch let the closure tier raise the error
          const vars = [];
          patVars(pp, vars);
          const names = new Map();
          for (const v of vars) { varSyms.add(v); const n = fresh(v); names.set(v, n); sc = sc.concat([[v, n]]); }
          const checks = [], assigns = [];
          patCheck(pp, `args[${i}]`, checks, assigns, names);
          lines.push(`if (!(${checks.join(' && ') || 'true'})) return R.slow(clo, args); ${assigns.map((a) => a + ';').join(' ')}`);
        } else {
          const [b, s2] = bindParam(pp, `args[${i}]`, sc);
          lines.push(b + ';');
          sc = s2;
        }
      }
    });
    if (restSym) {
      varSyms.add(restSym);
      restName = fresh(restSym);
      lines.push(bindOne(restSym, restName, `R.rest(args, ${params.length})`) + ';');
      sc = sc.concat([[restSym, restName]]);
    }
    prologue = lines.join(' ');
    scope0.length = 0;
    scope0.push(...sc);
  }
  const tailCode = T(body, scope0);
  const freeK = k(freeSyms);
  const src = `"use strict";
const FREE = ${freeK};
return function belCompiled(clo, args) {
  ${simpleParams
    ? `if (args.length ${restName !== null ? '<' : '!=='} ${paramNames.length}) return R.slow(clo, args);`
    : `if (args.length < ${minArgs}${restSym ? '' : ` || args.length > ${maxArgs}`}) return R.slow(clo, args);`}
  let ${(simpleParams && !CELLS ? paramNames.map((n, i) => `${n} = args[${i}]`).concat(restName !== null ? [`${restName} = R.rest(args, ${paramNames.length})`] : []) : []).concat(['$fc = null', '$head = null', '$last = null', '$env = clo.d.d.a', '$ee = R.ee']).join(', ')};
  ${hoisted.filter((n) => !(simpleParams && !CELLS && (paramNames.includes(n) || n === restName))).length ? 'let ' + hoisted.filter((n) => !(simpleParams && !CELLS && (paramNames.includes(n) || n === restName))).join(', ') + ';' : ''}
  const $fin = (x) => ($last === null ? x : ($last.d = x, $head));
  ${simpleParams && CELLS ? paramNames.map((n, i) => `${n} = new R.Pair(${k(params[i])}, args[${i}]); $env = new R.Pair(${n}, $env);`).join(' ') + (restName !== null ? ` ${restName} = new R.Pair(${k(restSym)}, R.rest(args, ${paramNames.length})); $env = new R.Pair(${restName}, $env);` : '') : ''}
  ${prologue}
  for (;;) {
    ${tailCode}
  }
};`;
  // assumptions checked whenever JIT_GEN moves
  const dynb = (s) => s instanceof Sym ? s.dynb : DYN_UVARS.has(s);
  for (const s of varSyms) if (dynb(s)) reject('dynamically bound variable');
  for (const s of globalSyms) if (s.lexb) reject('lexically bound global');
  const vs = [...varSyms], gs = [...globalSyms], ms = [...macroGuards], cs = [...coreSyms], fs = [...funSyms];
  const check = () => {
    for (const s of vs) if (dynb(s)) return false;
    for (const s of gs) if (s.lexb) return false;
    for (const [s, m] of ms) if (s.lexb || s.dynb || s.gcell === null || s.gcell.d !== m) return false;
    for (const s of cs) if (!s.nat || s.lexb || s.dynb) return false;
    for (const s of fs) if (s.lexb || s.dynb || (s.gcell !== null && isMacroVal(s.gcell.d))) return false;
    return true;
  };
  let factory;
  try {
    factory = new Function('K', 'R', src);
  } catch (ex) {
    if (ex instanceof SyntaxError) throw new Error('jit produced invalid JavaScript: ' + ex.message + '\n' + src);
    reject('new Function refused');
  }
  const code = factory(K, R);
  return { code, check, src };
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
  if (p.k) epoch++;
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
// A structural mutation (xdr) of a cell that sits in some vector bumps a
// global epoch and invalidates every cache; car mutation (xar) is safe
// because the vector holds cells.
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
    xs.k = true;
    c.ring = false;
    c.done = false;
    c.ep = epoch;
  }
  const cells = c.cells;
  while (cells.length < n && !c.done) {
    const p = cells[cells.length - 1].d;
    if (!(p instanceof Pair)) { c.done = true; break; }
    if (p === xs) { c.ring = true; c.done = true; break; }
    p.k = true;
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
  if (typeof x === 'number') return x;
  const v = sigerr(sym('mistype'));
  if (typeof v === 'number') return v;
  throw new BelError(sym('mistype'), 'Bel error: mistype (an err handler returned a non-number to arithmetic)');
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
    noteMutation(a[0]);
    a[0].a = a[1];
    return a[1];
  },
  xdr: (a) => {
    if (!(a[0] instanceof Pair)) return sigerr(sym('xdr-on-atom'));
    noteMutation(a[0]);
    if (a[0].k) epoch++;
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
  else if (x instanceof Pair) {
    const st = s instanceof Stream ? s : s === NIL ? stdoutStream : null;
    if (st !== null && st.dir === 'out' && !st.closed && st.wbits === 0 && st.writeString(x)) return;
    if (isString(x)) for (let p = x; p instanceof Pair; p = p.d) prc(p.a, s);
    else printTo(x, s);
  } else printTo(x, s);
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

/**
 * One Bel world: the 16 primitives, the unmodified bel.bel, and the jets.
 * There can be one instance per JavaScript realm (symbols are interned
 * module-wide).
 *
 * @param {object} opts
 * @param {(path: string) => Uint8Array|null} [opts.readFile]  backs (ops path 'in), (load path), and finding bel.bel
 * @param {(path: string, bytes: Uint8Array) => void} [opts.writeFile]  receives an output stream's bytes on (cls s)
 * @param {(bytes: Uint8Array) => void} [opts.stdout]  sink for the default output stream (outs = nil)
 * @param {() => number} [opts.stdin]  next byte of the default input stream (ins = nil), or -1 at end
 * @param {string} [opts.belSource]  text of bel.bel; defaults to readFile('interp/bel.bel')
 * @param {(command: string) => boolean} [opts.sys]  implementation of the sys primitive
 * @param {boolean} [opts.compile]  false runs everything on the tree-walking evaluator (same as BEL_NOCOMPILE=1)
 * @param {'ev'|'closure'|'js'} [opts.tier]  highest execution tier to use (also BEL_TIER); default 'js'
 */
export class Bel {
  constructor(opts = {}) {
    if (booted) throw new Error('only one Bel instance per JS realm');
    booted = true;
    if (opts.compile === false || opts.tier === 'ev') COMPILE = false;
    if (opts.tier === 'closure') JSTIER = false;
    if (!COMPILE) JSTIER = false;
    this.tier = !COMPILE ? 'ev' : JSTIER ? 'js' : 'closure';
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
    R.NIL = NIL;
    R.T = T;
    R.equal = (a, b) => equal(a, b);
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
  /** Reads and evaluates every expression in src; returns the last value. */
  evalString(src) {
    try {
      return loadText(src);
    } finally {
      stdoutStream.flush();
    }
  }
  /** Reads a file through readFile and evaluates every expression in it; returns the last value. */
  loadFile(path) {
    const data = host.readFile(path);
    if (!data) throw new Error('cannot open ' + path);
    try {
      return loadText(new TextDecoder().decode(data));
    } finally {
      stdoutStream.flush();
    }
  }
  /**
   * Applies the global function `name`. JS strings become Bel strings, arrays
   * lists, true/false/null t/nil; numbers and Bel values pass through.
   */
  call(name, ...args) {
    const f = sym(name).gcell;
    if (!f) throw new Error('undefined: ' + name);
    try {
      return applyF(f.d, args.map(toBel));
    } finally {
      stdoutStream.flush();
    }
  }
  /**
   * Switches jets off (back to bel.bel's own definitions) or on again. Names in
   * `keep` stay native. Returns the names that were switched.
   */
  setJets(enabled, keep = []) {
    const switched = [];
    for (const [name, { fn, loc }] of Object.entries(jets)) {
      if (keep.includes(name) || !(name in orig)) continue;
      const cell = globalCell(sym(name));
      cell.d = enabled ? mkprim(name, fn, loc) : orig[name];
      switched.push(name);
    }
    return switched;
  }
  /** Bytes written to the default output since the last call (when there is no stdout sink). */
  takeOutput() { return stdoutStream.take(); }
  /** Sends buffered default output to the stdout sink. */
  flush() { stdoutStream.flush(); }
  /** Bel's printed representation of x. */
  print(x) { return printString(x); }
  /** A JS string as a Bel string (a list of characters). */
  str(s) { return str(s); }
  /** A Bel string as a JS string. */
  jsstr(x) { return jsstr(x); }
  /** A Bel list of the arguments. */
  list(...xs) { return list(...xs); }
  /** The elements of a proper Bel list, as an array. */
  toArray(l) { return listToArr(l); }
  /** The interned symbol called name. */
  sym(name) { return sym(name); }
  /** Counters for the JavaScript tier: functions compiled, rejected (with reasons), invalidated. */
  jitStats() { return { compiled: jitStats.compiled, rejected: jitStats.rejected, invalidated: jitStats.invalidated, reasons: Object.fromEntries(jitStats.reasons) }; }
  /** The global value of name, or undefined if it is unbound. */
  global(name) {
    const c = sym(name).gcell;
    return c ? c.d : undefined;
  }
}

export { BelError, Pair, Sym, Char, Stream, printString, readAll };

# The Bel interpreter

`interp/bel.js` is an interpreter for [Bel](https://paulgraham.com/bel.html), the Lisp Paul Graham defined in itself in 2019. It is one ES module of about 3,400 lines with no dependencies, and it runs in Node and in browsers (including Web Workers).

Its job is to run PG's spec, `interp/bel.bel`, exactly as written, and then run real programs on it fast enough to draw Doom. It does this in three layers:

1. **A direct implementation of Bel's axioms**: the primitives, the special forms, closures and macros as real Bel lists, and the environment as a real alist.
2. **The unmodified `bel.bel`**, loaded at startup (about 45 ms), so every definition in the spec exists as PG wrote it.
3. **Speed** that keeps the same behavior: native replacements ("jets") for hot `bel.bel` functions, core macros evaluated natively, memoized macro expansion, two compilers (Bel to JavaScript closures, and Bel to JavaScript source for hot functions) with proper tail calls, and a CDR-coding cache for list indexing.

This document describes all three, the host API, and every place where the implementation deliberately differs from the spec.

- [Quick start](#quick-start)
- [Host API](#host-api)
- [How Bel values look in JavaScript](#how-bel-values-look-in-javascript)
- [Booting](#booting)
- [Evaluation](#evaluation)
- [Locations: `where` and `set`](#locations-where-and-set)
- [Errors, `dyn`, `after` and `ccc`](#errors-dyn-after-and-ccc)
- [The compilers](#the-compilers)
- [Jets](#jets)
- [The CDR-coding cache](#the-cdr-coding-cache)
- [Reader and printer](#reader-and-printer)
- [Streams and I/O](#streams-and-io)
- [Stack depth](#stack-depth)
- [Differences from bel.bel](#differences-from-belbel)
- [Performance](#performance)
- [Tests](#tests)
- [Source map](#source-map)

## Quick start

```sh
node bin/bel.mjs                                  # REPL
node bin/bel.mjs -e '(map [* _ _] (list 1 2 3))'  # evaluate and print
node bin/bel.mjs file.bel other.bel               # load files in order
```

```
> (cons \h "ello")
"hello"
> (let ((x y) . z) '((a b) c) (list x y z))
(a b (c))
> ((fn (x|int) (cons x 'b)) 'a)
Bel error: mistype (binding parameters ((t x int)))
> (set y (table))
(lit tab)
> (set y!a 1 y!b 2)
2
> (map ++:y '(a b))
(2 3)
```

The CLI re-executes Node with a 7.8 MB stack (see [Stack depth](#stack-depth)), loads `bel.bel`, then evaluates each `-e` expression (printing its value) and loads each file. With no arguments it starts a REPL that reads until parentheses balance.

## Host API

```js
import { Bel, BelError } from './interp/bel.js';

const bel = new Bel({
  readFile: (path) => Uint8Array | null,   // used by (ops path 'in), (load path), and to find bel.bel
  writeFile: (path, bytes) => {},          // optional: called when an output stream opened with ops is closed
  stdout: (bytes) => {},                   // optional: sink for the default output stream
  stdin: () => byte,                       // optional: next input byte, or -1 at end of input
  belSource: '...',                        // optional: text of bel.bel; otherwise readFile('interp/bel.bel')
  sys: (command) => boolean,               // optional: implementation of the sys primitive
  tier: 'js',                              // optional: highest execution tier, 'ev', 'closure' or 'js' (the default)
});
```

| Method | What it does |
|---|---|
| `bel.evalString(src)` | Reads and evaluates every expression in `src`; returns the last value |
| `bel.loadFile(path)` | Same, for a file read through `readFile` |
| `bel.call(name, ...args)` | Applies the global function `name`. JS strings become Bel strings, arrays become lists, `true`/`false`/`null` become `t`/`nil`; any other value (a number or a Bel value you got back earlier) is passed through unchanged |
| `bel.takeOutput()` | Returns the bytes written to the default output since the last call, when no `stdout` sink was given |
| `bel.flush()` | Sends buffered default output to the `stdout` sink |
| `bel.global(name)` | The global value of `name`, or `undefined` if unbound |
| `bel.print(x)` | Bel's printed representation of `x`, as a JS string |
| `bel.str(s)`, `bel.jsstr(x)` | Converts a JS string to a Bel string (a list of characters) and back |
| `bel.list(...xs)`, `bel.toArray(l)` | Builds a Bel list; converts a proper list to an array |
| `bel.sym(name)` | The interned symbol `name` |
| `bel.setJets(enabled, keep)` | Switches jets off (back to `bel.bel`'s own definitions) or on again, except the names in `keep`; returns the names switched. `test/jets-off.mjs` uses it to show a frame rendered with PG's definitions is identical |
| `bel.tier` | The highest execution tier in use: `'ev'`, `'closure'` or `'js'` |
| `bel.jitStats()` | Counts of functions compiled to JavaScript, rejected and invalidated, with the rejection reasons |
| `bel.nil`, `bel.t` | The symbols `nil` and `t` |

Errors that no Bel handler catches surface as a thrown `BelError`. Its `.value` is the Bel error value (usually a symbol such as `mistype` or a list such as `(unboundb foo)`), and its message is the printed form, with the parameter list added for arity and destructuring errors. Output written before an error stays in the buffer, so call `flush()` or `takeOutput()` in your error handler.

Symbols and characters are interned per JavaScript realm, so there can be one `Bel` per realm (one per Node process, worker or page). Constructing a second throws.

The `tier` option, or the environment variable `BEL_TIER` in Node, caps the [execution tier](#the-compilers): `ev` runs everything through the tree-walking evaluator, `closure` adds the closure compiler, and `js` (the default) also compiles hot functions to JavaScript source. All three give the same answers, and the test suites check that they do. `compile: false` and `BEL_NOCOMPILE=1` are older spellings of `tier: 'ev'`.

## How Bel values look in JavaScript

| Bel | JavaScript |
|---|---|
| symbol | an interned `Sym` with fields for its global binding cell, special-form code and lookup flags |
| `nil` | the symbol `nil`, which is also the empty list |
| pair | a `Pair` with `a` (car) and `d` (cdr), plus hidden slots for caches |
| character | an interned `Char` with a Unicode code point `c` |
| string | a proper list of characters, as in the spec |
| number | a JavaScript number (see [Differences](#differences-from-belbel)) |
| stream | a `Stream` object |
| closure | the list `(lit clo env parms body)`, as in the spec |
| macro | the list `(lit mac closure)` |
| primitive or jet | the list `(lit prim name)`, carrying a native function in a hidden slot |
| continuation | the list `(lit cont)`, carrying an escape token in a hidden slot |

Closures, macros and environments are ordinary Bel data. You can take a closure apart with `car` and `cdr`, build one by hand with `list`, and call it.

## Booting

`new Bel(...)` does the following, in order:

1. Defines the 16 primitives (`id join car cdr type xar xdr sym nom wrb rdb ops cls stat coin sys`) as `(lit prim name)` values.
2. Binds `ins` and `outs` to `nil` (meaning the host's input and output) and `chars` to a list of the 256 one-byte characters paired with their 8-bit representations, MSB first.
3. Reads `bel.bel` with the native reader and evaluates its 353 top-level expressions in order. `bel.bel` uses `def` and `mac` before it defines them, and it uses backquote long before `bquote` is defined, so these are evaluated natively from the start (see [native core macros](#native-core-macros)). Everything else is defined by `bel.bel` itself.
4. Saves the `bel.bel` definitions that are about to be replaced and installs the [jets](#jets).

## Evaluation

### Variables

A symbol is looked up in this order, as in `bel.bel`'s `lookup`: dynamic bindings (innermost first), then the lexical environment (an alist of `(var . value)` cells), then the global binding. `scope` evaluates to the current lexical environment and `globe` to an alist of all global binding cells. `t`, `nil`, `o` and `apply` evaluate to themselves. A uvar (a list whose car is the global `vmark`) is a variable too, which macros such as `letu` rely on.

Two flags per symbol make this cheap: a symbol that has never been bound dynamically skips the dynamic stack, and a symbol that has never been bound lexically goes straight to its global cell. So `car`, `+` or a global engine constant cost one pointer read, while a local variable costs a short alist walk.

### Special forms

The special forms are recognized by symbol identity, as in the spec, so lexical bindings cannot shadow them:

| Form | Notes |
|---|---|
| `(quote x)` | |
| `(lit ...)` | evaluates to itself, as do strings |
| `(if a b c d e)` | any number of test/consequent pairs; the chosen branch is in tail position |
| `(where place (o new))` | returns the location `(cell a)` or `(cell d)`; see [Locations](#locations-where-and-set) |
| `(dyn var value expr)` | dynamic binding for the extent of `expr` |
| `(after expr cleanup)` | `cleanup` runs however `expr` exits |
| `(ccc f)` | calls `f` with an escape continuation |
| `(thread expr)` | not supported; signals `threads-unsupported` |
| `(bquote x)` | backquote, evaluated natively with nesting, `comma`, `comma-at`, dotted unquotes, and sharing of unchanged structure as in `bel.bel` |

`apply` is not a special form in Bel but a self-evaluating symbol that is applicable: `(apply f a b '(c d))` calls `f` with `a b c d`.

### Native core macros

These macros from `bel.bel` are evaluated natively while their global value is still the one `bel.bel` defined and the symbol is not rebound lexically or dynamically at the call site:

`fn do set def mac let rfn when unless and or case with withs for while repeat til loop`

The native versions have the same behavior as the expansions. Examples of what that means:

- `fn` builds the same `(lit clo env parms body)` list, with multiple body expressions wrapped in `(do ...)`.
- `for` binds a fresh variable cell on each iteration (so closures capture each value), reads the variable back after the body (so the body can change it), and returns `nil`.
- `rfn` builds a closure whose environment contains a cell bound to the closure itself, which is what `bel.bel`'s `yc` (Y combinator) definition computes, without allocating new closures on every call.
- A form whose operator is a literal `(fn ...)`, which is what `let` and `with` expand into, binds its arguments directly instead of building a closure first.

If a program redefines one of these (`(mac when ...)`) or binds the name locally (`(let fn (fn args 42) (fn 3))` returns 42), the program's definition is used.

### Calling functions

An operator is evaluated first, then the arguments left to right, then the function is applied:

- **Primitives and jets** run their native function.
- **Closures** bind parameters by the rules of `bel.bel`'s `pass`, then evaluate the body in tail position. The rules cover a rest parameter (`(f . args)` or a bare symbol), optional parameters `(o var default)` whose default is evaluated in the environment built so far, type-checked parameters `(t var type)` (written `var|type`) where `type` is an expression evaluated and applied to the argument, and destructuring of nested lists. Errors are `overargs`, `underargs`, `atom-arg`, `literal-parm` and `mistype`.
- **Macros** are called on the unevaluated arguments and the expansion is evaluated in the caller's environment, also in tail position. A macro used as a function value (for example passed to `map`) is applied to quoted arguments, as in `bel.bel`'s `applylit`.
- **Continuations** escape to their `ccc`.
- **Numbers** index lists: `(2 '(a b c))` is `b`, as `bel.bel`'s `vir num` defines.
- **Other `(lit tag ...)` values** are looked up in the global `virfns`, so tables `(lit tab ...)` and arrays `(lit arr ...)` are callable exactly as in the spec.

### Macro expansion is memoized

Bel macros are first-class and, in the spec, expanded every time a call is evaluated. This interpreter caches each expansion on the call-site pair, keyed by the macro value, and reuses it while the operator still evaluates to the same macro and the code has not been changed in place: every pair of a call site whose expansion is cached is marked as code, and an `xar` or `xdr` on a marked pair throws away every cached expansion and compiled node, so a program that edits its own code sees the edit, as in the spec. This assumes a macro's expansion depends only on its arguments, which is true of every macro in `bel.bel` (macros that call `uvar` get the same fresh variables each time, which is harmless because the binding forms that use them are separate). A macro whose expansion has side effects or depends on changing global state would see its expansion computed once per call site.

## Locations: `where` and `set`

Bel's `set` works on any place, not only variables, because `where` evaluates an expression for its location: a variable's binding cell, or the pair and side (`a` or `d`) that `car` or `cdr` would read. In the spec this works through function bodies, so `(set (cadr x) 1)` and `(pop (find pair w))` both work.

The interpreter evaluates places in a location mode that is passed through every tail position, so a location comes out of `if` branches, `do` sequences, closure bodies and macro expansions. Places that produce locations:

- variables (with `set`'s `new` flag, an unbound variable gets a new global cell);
- `car` and `cdr`;
- the jets `cadr`, `cddr`, `caddr`, `nth`, `find` and `last`, matching what their `bel.bel` definitions would produce;
- table lookups `(tab key)`, which add the key if it is missing, as `bel.bel`'s `tabloc` does;
- anything that reaches one of these through a function or macro.

Any other value in location mode signals `unfindable`. `set` with a variable place assigns directly; `set` with any other place evaluates the location and calls `xar` or `xdr` on it. `zap`, `++`, `--`, `push`, `pull`, `pop` and `swap` are `bel.bel`'s own macros running on top of this.

## Errors, `dyn`, `after` and `ccc`

When a primitive, a jet or the evaluator detects an error, it calls `sigerr` with an error value. As in `bel.bel`, if `err` is dynamically bound, the handler is called with the value; otherwise the error escapes to the host as a `BelError`. `bel.bel` never defines a global `err`, so the interpreter provides one that does the same thing, which makes `(err 'oops)` work at top level.

`eif`, `onerr` and `safe` from `bel.bel` work unchanged on top of this: they bind `err` dynamically to a function that calls a continuation.

- `dyn` pushes a binding cell on the dynamic stack and pops it however its body exits.
- `after` is a JavaScript `try`/`finally`.
- `ccc` creates a continuation backed by a unique token. Calling the continuation throws; the `ccc` that created it catches its own token and returns the value. A continuation works while its `ccc` is still active, which covers `catch`/`throw`, `eif`, early exits and error handling. Calling it after its `ccc` has returned is not supported.

## The compilers

There are three execution tiers, and code moves up through them on its own:

1. **`ev`**, the tree-walking evaluator, implements every rule directly. Everything unusual ends up here.
2. **The closure tier** compiles code into JavaScript closures the first time it runs.
3. **The JS tier** compiles a closure that has been called 16 times into JavaScript source, which the JavaScript engine's own optimizing compiler then turns into machine code.

### The closure tier

Code is compiled the first time it is evaluated. Each code pair becomes a JavaScript function `node(a, t)`, where `a` is the Bel environment (still a real alist) and `t` says the node is in tail position. The compiled node is cached on the pair.

- Special forms and native core macros compile to specialized nodes. The core-macro nodes check at run time that the macro is still `bel.bel`'s and not shadowed, and fall back to a generic call otherwise.
- A generic call node reads a global operator directly when it can, evaluates the arguments, and dispatches on the function: native functions are called directly, macros expand once and compile their expansion, closures bind and run their compiled body.
- A closure call in tail position does not grow the JavaScript stack. The node stores the next environment and body in a shared marker and returns it, and the caller's loop (a trampoline) runs it. So Bel loops written as tail recursion run in constant stack, as the spec's interpreter does.
- Location mode, `where`, `dyn`, `after`, `ccc`, `def`, `mac`, `til` and `loop` are delegated to the tree-walking evaluator, `ev`, which implements the same semantics directly. Closures applied from `ev` switch back to compiled code.

### The JS tier

A closure body that has run 16 times is translated into the source of one JavaScript function, `belCompiled(clo, args)`, and built with `new Function`. The generated code is cached per body, so every closure made from the same `fn` shares it.

- **Variables.** In a body that creates no closures and never mentions `scope`, parameters and `let` variables are plain JavaScript locals. A body that does create closures, or reads `scope`, is compiled in *cells mode*: each variable is a real `(name . value)` pair consed onto a real alist, exactly as `ev` would build it, so a closure created inside captures the same environment structure, and `(cadr (car (cddr f)))`-style reflection sees what it would see in the spec. Free variables are read through the closure's own environment cells (looked up once per closure and cached until any `xar` or `xdr`), and globals through their global cells.
- **Parameters.** Plain, rest, optional `(o x default)`, typed `(t x type)` and destructured parameters are bound in a prologue. If an argument list doesn't fit a destructuring pattern, the call is handed to the closure tier, so the error and its message are the ones `ev` gives.
- **Macros** are expanded at compile time, using the same memoized expansion as the other tiers, behind a guard that the macro is still the same value. Forms that need a real environment (`where`, `set` on a place, `dyn`, `after`, `ccc`, backquote, `til`, `loop`) run in `ev` on an alist built from the current locals, and the values are copied back afterwards.
- **Primitives.** Calls to the arithmetic, comparison, `car`/`cdr` family, `cons`, `nth` and similar jets are inlined as JavaScript operations behind a check that the operator is still that very jet and the arguments are numbers or pairs. Any other case calls the jet normally, so redefining `+` or `car` works mid-run.
- **Calls.** Self tail calls become loops. Other tail calls go through the same trampoline as the closure tier, so mutual recursion runs in constant stack. `(cons x (self ...))` in tail position becomes a loop that builds the list front to back (tail recursion modulo cons), so `bel.bel`'s own `map` runs in constant stack.
- **Assumptions.** Compiled code assumes things such as "`floor` has never been bound dynamically" or "`let` is still `bel.bel`'s macro". Any event that could break one (a symbol bound dynamically or lexically for the first time, a macro or core macro redefined, a code pair changed in place) bumps a generation counter. A compiled function re-checks its assumptions on its next call, and recompiles or drops back to the closure tier if they no longer hold.
- **Rejection.** A body using threads, or anything else the JS tier doesn't handle, stays on the closure tier. `bel.jitStats()` lists the reasons. The Doom engine compiles all 223 of its hot functions, with none rejected.

The tiers are checked against each other, not just assumed to agree. The Doom engine produces byte-identical frames on all three over 11 golden scenes at three resolutions. A reflection matrix (`test/reflect.mjs`, 67 cases) inspects closures, environments, macros, errors, continuations and code edited in place, and requires the closure and JS tiers to give exactly `ev`'s answers. A fuzzer (`test/fuzz-tiers.mjs`) generates thousands of random programs and compares all three tiers call by call.

## Jets

After `bel.bel` is loaded, 87 of its definitions are replaced by native functions with the same behavior (the originals are kept internally; `compose`, for example, falls back to `bel.bel`'s version when one of its arguments is a macro, because only the original can pass the unevaluated expression on).

| Area | Jets |
|---|---|
| Lists | `no atom all some reduce cons append snoc list map = proper mem in cadr cddr caddr find begins caris keep rem get put rev idfn len pos nth drop first cut lastcdr last udrop hug compose foldl foldr sort dedup` |
| Types | `symbol pair char stream string number real int whole pint` |
| Arithmetic | `+ - * / inc dec < > <= >= abs floor ceil round mod even odd max min rand inv recip rpart ipart` |
| Characters | `charn nchar` |
| I/O | `prc rdc peek print pr prn prs read load err` |

Behavior worth knowing:

- `=` compares structure, as in the spec; `id` compares identity.
- `<` and friends compare numbers, characters (by code), strings (lexicographically) and symbols (by name), as `bel.bel`'s `comfns` define, and signal `incomparable` otherwise.
- `/` and `mod` by zero signal `mistype`, as `bel.bel`'s `srrecip` type check does. `(/ x)` is `x`, as in the spec.
- `round` rounds halves to even and `mod` is a floor modulus, both following their `bel.bel` definitions.
- `sort` inserts each element before the first one it is `f`-before, which gives the same order as `bel.bel`'s insertion sort.
- `map` with several lists stops at the shortest; `reduce` and `foldr` fold from the right; `foldl` from the left.
- `read` and `print` are the native reader and printer; `load` reads a file through the host and evaluates each expression.
- `nth` signals `mistype` on an index that is not a positive integer or that runs off the list, as its `n|pint xs|pair` type checks do in `bel.bel`, both as a value and as a `set` place. `drop` past the end returns `nil`, and `cadr` of a short list is `nil`, also as in the spec.

## The CDR-coding cache

Bel has no arrays, so programs index lists, and `nth` is a walk. Lisp Machines solved the same problem with CDR-coding, laying lists out as vectors. This interpreter keeps a hidden vector of a list's cells instead:

- The third time `nth` or `drop` reaches past the eighth element of the same list (identified by its first pair), the interpreter starts recording that list's cells in a vector stored on the first pair.
- The vector grows lazily, only as far as the largest index requested, so taking a short prefix of a long list never copies the whole list.
- A circular list (a texture column whose last cdr points to its head, for example) is detected and indexed modulo its length, which is what walking it would give.
- `xar` (changing a car) is always safe, because the vector holds cells and reads their cars at access time.
- `xdr` (changing a cdr), or setting a cdr place, on a cell that sits in some vector bumps a global epoch, and every vector rebuilds on its next use. Mutating cells that are not in any vector costs nothing.

So a program that builds a list once and indexes it many times gets constant-time access, and a program that mutates list structure gets exactly the same results as without the cache.

## Reader and printer

The reader is native and follows the syntax in `bel.bel`'s reader:

| Syntax | Reads as |
|---|---|
| `(a b . c)` | lists and dotted pairs |
| `'x` `` `x `` `,x` `,@x` | `(quote x)`, `(bquote x)`, `(comma x)`, `(comma-at x)` |
| `[f _ x]` | `(fn (_) (f _ x))` |
| `"abc"` | a list of characters; `\` escapes the next character |
| `\a` `\sp` `\lf` `\tab` `\cr` `\bel` `\(` | characters, named characters, and any single delimiter character |
| `¦hello world¦` | a symbol with any characters in its name |
| `12` `-3` `1.5` `.05` `19/20` | numbers |
| `a.b` `a!b` | `(a b)`, `(a 'b)` |
| `.a` `!a` | `(upon a)`, `(upon 'a)` |
| `f:g` `~f` | `(compose f g)`, `(compose no f)` |
| `x|int` | `(t x int)`, a typed parameter |
| `; comment` | ignored to end of line |

Not supported: `#n=` and `#n` labels for shared structure, and complex number literals.

The printer prints what `bel.bel`'s `print` prints for the same values: symbols, `\c` for characters (with names for space, newline, tab, return and bell), strings in double quotes with `"` and `\` escaped, dotted pairs, and `<stream>`. Integers print without a decimal point and other numbers as JavaScript prints them. Instead of `#n=` labels for shared structure, a cycle prints as `<cycle>`.

## Streams and I/O

Bel streams are streams of bits. `rdb` returns the characters `\0` and `\1` (or `eof`), and `wrb` writes them, most significant bit first within each byte. `ops` opens a file through the host's `readFile` (direction `'in`) or for output (`'out`, handed to `writeFile` on `cls`). `stat` returns `in`, `out` or `closed`.

Characters on streams are one byte each: `rdc` reads a byte and returns the character with that code, and `prc` writes characters with codes below 256 as one byte (others as UTF-8). Together with `charn` and `nchar` this makes binary I/O straightforward, which is how the Doom engine reads WAD files and writes frames. `peek` looks ahead one character without consuming it.

`ins` and `outs` start as `nil`, which means the host's input (`stdin` option) and output (`stdout` option, or the buffer behind `takeOutput`). Binding them with `bind`, `from` or `to` redirects `rdc`, `prc`, `print` and friends. A queue, as made by `newq` and used by `record` and `prs`, can also be an output: characters are appended to it.

## Stack depth

The compilers give tail calls constant stack, but non-tail recursion uses the JavaScript stack. How much each nested Bel call costs depends on the tier:

| Where | Nested non-tail Bel calls |
|---|---|
| Node, default stack (~1 MB), JS tier | ~6,900 |
| Node, default stack, `ev` / closure tier | ~5,700 / ~2,300 |
| Node with `--stack-size=7800` (what `bin/` tools use, via `bin/bigstack.mjs`) | ~18,000 |
| Chromium Web Worker | ~1,000 |

Deep non-tail recursion over long lists should be written with an accumulator (tail recursion) or with the native `map`, `keep`, `reduce` and `foldl`, which iterate in JavaScript. A stack overflow is reported as `Bel error: stack overflow` by the CLI.

## Differences from bel.bel

These are deliberate:

- **Numbers are IEEE doubles.** In the spec, numbers are lists such as `(lit num (+ (t t) (t t t)) (+ () (t)))`, exact rationals with unary numerators and denominators, and they can be complex. Here `(/ 2 3)` is `0.6666666666666666` and `(type 1)` is `number`. `bel.bel`'s internal number functions that take its representation apart (`numr`, `srnum`, `litnum`, `buildnum` and so on) don't apply to these numbers; the user-level ones (`inv`, `recip`, `rpart`, `ipart` and all the arithmetic) are jets.
- **Continuations are escape-only** and **threads are not supported.** Since there is only one thread, `atomic` and `lock` have no effect beyond their dynamic binding.
- **Macro expansions are memoized** per call site, as described [above](#macro-expansion-is-memoized).
- **`err` has a global definition**, which `bel.bel` leaves to the implementation.
- **The reader** does not support `#n=` labels or complex number literals, and the printer prints cycles as `<cycle>` instead of labeling shared structure.
- **`chars`** lists the 256 one-byte characters. Characters above 255 exist and print, but they are not in `chars`.
- **`sys`** works only if the host provides a `sys` option.

Everything else is `bel.bel`. On the REPL session in PG's `belexamples.txt`, all 37 results match (the only visible difference is that `2/3` prints as a decimal).

## Performance

One Doom frame (a tic plus drawing, averaged over the 271 frames of the golden scenes), in Node 24 on a 4-core cloud VM:

| Resolution | JS tier | Closure tier |
|---|---|---|
| 160x100 | 23 ms | 66 ms |
| 320x200 | 47 ms | 160 ms |
| 640x480 | 161 ms | 554 ms |

In Chrome on an M4 Max MacBook Pro, the JS tier draws a 640x480 frame in about 45 ms on one core, and the browser front end splits each frame's columns across several Web Workers, so 640x480 plays at the full 35 frames a second.

Smaller benchmarks (top-level code, so these run on the closure tier or `ev`):

| Benchmark | Compiled | Tree-walking only (`BEL_TIER=ev`) |
|---|---|---|
| Boot: read and evaluate `bel.bel` | 43 ms | |
| `(fib 22)`, 57,313 calls | 11 ms | 22 ms |
| A `for` loop summing 1 to 1,000,000 | 91 ms | 131 ms |
| 100,000 `nth` lookups into a 4,096-element list | 28 ms | 37 ms |

The list-indexing benchmark took about 360 ms before the CDR-coding cache. For comparison, the spec's own definitions do arithmetic in unary, so `(+ 2 2)` appends two lists of `t`.

## Tests

| Test | What it checks |
|---|---|
| `node test/basics.mjs` | 108 semantic cases: parameters, destructuring, optional and typed parameters, macros, `where`/`set` on places, `ccc`, `eif`/`onerr`, every native loop and control macro, shadowing, tables and arrays, the reader's intrasymbol syntax, error cases, and the CDR-coding cache under mutation and on circular lists |
| `node test/examples.mjs` | the 37 results of the REPL session in PG's `belexamples.txt` |
| `node test/bench.mjs` | the benchmarks above |
| `node test/tiers.mjs [--gate] [--root DIR]` | runs the suites below under every tier, one process each, and prints a table; `--gate` adds the reflection matrix and the fuzzer |
| `node test/reflect.mjs` | 67 cases where the closure and JS tiers must give `ev`'s exact answers: closures and environments taken apart, parameters, errors and their messages, `dyn`, `ccc`, places, code changed in place, redefined primitives, tail calls |
| `node test/fuzz-tiers.mjs [--seed N]` | random programs, each called 20 times so the JS tier compiles them, compared across all three tiers; a mismatch is shrunk to a minimal program |
| `node test/golden.mjs [--modes lo,hi,640x480]` | Doom's output over 11 scenes, hashed and compared with committed hashes |
| `node test/jets-off.mjs` | a frame rendered with jets and again with `bel.bel`'s own definitions is identical |
| `node test/slices.mjs` | `(doom-draw-slice w x0 x1)` stitched for random column partitions equals the full frame |

## Source map

| Section of `interp/bel.js` | What's there |
|---|---|
| top | `Sym`, `Pair`, `Char`, `Stream`, interning, constants and special-form codes |
| errors, lookup, binding | `sigerr`, variable lookup, global cells, `bind` and `pass` (parameter binding) |
| evaluator | `ev` (the tree-walking evaluator with location mode), `applyF`, `callcc`, `where`/`set`, backquote |
| compiler | `comp`, call nodes, the trampoline, specialized nodes for special forms and core macros |
| tier 2: Bel to JavaScript | `jitOf`, `jitCompile` (the code generator), the `R` runtime object that generated code calls, assumption checks |
| reader, printer | the native reader and printer |
| streams | bit and byte streams, `prc`, queues |
| natives | the CDR-coding cache, the 16 primitives, the 87 jets |
| host API | the `Bel` class |

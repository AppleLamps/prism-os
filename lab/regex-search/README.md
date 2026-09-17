# Regex search as matrix products

## What it is

Search as you type over a text of fixed capacity, 256 or 1,024 code points. JavaScript parses a pattern and compiles it into an automaton with at most S states and 16 character classes. The program runs the automaton one step per code point, as products of a class's transition matrix with a 0/1 state vector, and returns one highlighted bit and one match start bit per code point. It finds every non-overlapping, non-empty match, leftmost, then longest. There are two forms of the program:

- (a) The pattern as data, in data-program.ts. The transition matrix of every class, the accepting states and the class of every code point sit in cells, so a new pattern writes cells and changes no program.
- (b) The pattern built into the program, in builtin-program.ts. The builder knows the automaton, so each step is a fixed sparse sum over the steps the pattern has, and a new pattern rebuilds and recompiles the program.

The pattern language is a subset of JavaScript's RegExp syntax with the `u` flag: literal code points, `.`, `\d`, `\w`, character classes with ranges and negation, e.g. `[a-z_]` or `[^0-9]`, `?`, `*`, `+`, `|` and groups. Everything else, e.g. `*?`, `{2}`, `^` or `(?:`, throws a `PatternSyntaxError` with its position.

## How to run it

From the repo root:

```sh
bun test lab/regex-search                                   # 7 tests, about 2 seconds
bunx tsgo -p lab/regex-search                               # type-check
bunx oxlint --type-aware lab/regex-search                   # lint
bun lab/regex-search/demo.html                              # the page, e.g. ?form=builtin&states=32&text=1024
bun lab/regex-search/report.ts                              # every Bun measurement below, each variant in its own process, about 7 minutes
bun lab/regex-search/browser-frame.ts --profile <folder>    # keystroke frames in headless Chrome, with a fresh Chrome profile folder, a few minutes
```

The page has a pattern field, a form selector, S = 8, 16 or 32, and a text capacity of 256 or 1,024 code points, and the text is editable under "Edit the text". It evaluates once in each frame where the pattern or the text changed, and draws the matches as alternating colors, so neighboring matches stay apart. The status line shows the automaton's size against the capacity, the program's size, and the frame's times. It counts every operation the builder appended, which overstates form (b), see [what got awkward](#what-got-awkward). A frame that doesn't evaluate, because the pattern has a syntax error or doesn't fit, shows "No matches", plus the automaton's size when the pattern compiled.

| File | What it holds |
| --- | --- |
| `pattern.ts` | The parser, the position automaton (Glushkov's construction), the class partition, and the capacity check with its messages |
| `data-program.ts` | Form (a): cells, builder code, writing a pattern into cells, and the machine the page runs |
| `builtin-program.ts` | Form (b): builder code for one pattern, and its machine |
| `bits.ts` | AND, AND NOT, NOT and "none of" on bits, folding bits that builder code already knows |
| `host.ts` | Writing code points into text cells, and turning the output bits into matches |
| `reference.ts` | The two plain JavaScript references |
| `regex-search.test.ts` | Differential tests |
| `report.ts`, `browser-frame.ts` | Measurements in Bun and in headless Chrome |
| `demo.html`, `demo.ts`, `sample-text.ts` | The page |

## What the search finds

From a scan position, the longest non-empty match that starts there is reported, and the scan continues at its end; when no match starts there, the scan moves one code point on. E.g. `a|ab` on `xabx` finds `ab`, where JavaScript's own `String.prototype.match` returns `a`, and `a*` on `baab` finds `aa` and never reports an empty match. `.` doesn't match `\n`, `\r`, U+2028 or U+2029, as in RegExp without the `s` flag.

Both references are written from this definition, not from the programs. `automatonMatches` runs the compiled automaton from each scan position until no state is left, and keeps the last position where an accepting state was reached. `regexpMatches` doesn't use the compiled automaton at all: it tests every substring with `new RegExp('^(?:' + pattern + ')$', 'u')`. The `u` flag makes RegExp read code points, as the programs do, e.g. `.` matches one emoji instead of half of one.

## How the program finds where matches start and end

A JavaScript scan finds where a longest match ends only by reading past the end. E.g. for `a+b|a` on `aaac`, the scan from position 0 reads `aaa`, reads `c`, and only then knows that `a+b` can't match, so the longest match is `a`, and it goes back to position 1. A fixed program can't go back. So the program runs two passes, one step per code point each:

- **The reverse pass**, from the end of the text: `reach[j][s]` is 1 when some path from state `s` at position `j` reads at least one code point and ends in an accepting state. JS: `reach[j][s] = states.some(t => transitions[classOf(text[j])][s][t] && (accepting[t] || reach[j + 1][t]))`. This is the same automaton run backwards over the text, with the transition matrices read by column instead of by row.
- **The forward pass**, from the start: `reached[j][s]` is 1 when the match in progress has reached state `s` by position `j`. Code point `j` continues the match when `reached[j][s] && reach[j][s]` for some state `s`, i.e. when a longer match exists. When no match continues, a match starts at `j` when `reach[j][0]`, where state 0 is the initial state. So the forward pass knows at every position whether the match can get longer, and never goes back.

For `a+b|a` on `aaac aab`, `reach` says that from the initial state at positions 0, 1 and 2 only the one-code-point match `a` exists, so the forward pass reports `a`, `a` and `a`, and at position 5, that `aab` exists.

Per-state earliest starts, the other way to find starts, carry the smallest start position among the paths in each state. That's a minimum over integers per state per step, not a product of 0/1 values, and it loses information exactly where leftmost-longest needs it: when a longest match ends at position e, paths that started before e have to be dropped, while a path in the same state that started at e or later has to survive, and one earliest start per state can't tell the two apart.

## The automaton and its cells

`compilePattern` builds a position automaton: state 0 is the initial state, and state p + 1 is the pattern's p-th atom, e.g. `(the|an?) [a-z]+` has 8 states: initial, `t`, `h`, `e`, `a`, `n`, the space and `[a-z]`. Every step into a state reads a code point of that atom's set, so the automaton has no empty steps, and one step per code point runs it. Code points that every step reads the same way share a class, e.g. that pattern has 7 classes: `t`, `h`, `e`, `a`, `n`, the space, and the other letters of a..z. The classes change at 13 code points, the class boundaries.

Form (a)'s cells, at S states, C = 16 classes, K = 32 class boundaries and N text cells:

| Cells | Count | Written when |
| --- | --- | --- |
| `text` | N, a code point in each, and -1 past the end of the text | the text changes |
| `boundaries` | K, ascending, and 0x110000 when unused | the pattern changes |
| `regionClasses` | K + 2: the class of the code points below the first boundary, between each pair, and above the last, plus a constant cell for -1 | the pattern changes |
| `transitions` | C × S × S bits, `transitions[c][s][t]` | the pattern changes |
| `accepting` | S bits | the pattern changes |

A pattern that needs more states, classes or boundaries gets a named message instead of a program, e.g. `the pattern needs 33 states, and the program holds 32`, and the page shows it, highlights nothing, and shows the automaton's size in the status line. The page checks the same capacity in form (b), so form (b) never builds a program for a pattern with more than S states, 16 classes or 32 class boundaries, e.g. a pasted pattern of 400 literal characters. A text longer than N is searched only up to N code points, and the page says so and draws the rest in gray.

Form (a)'s operations for one code point:

- **Its class.** K + 1 integer comparison bits, `[codePoint >= boundary]` and `[codePoint >= 0]`, 2 operations each, since code points and boundaries are declared on a grid of 1 ([expressions.md](../../docs/expressions.md), `a >= b`). Their sum is the region, and `circuit.indexRead(region, regionClasses)` is the class ([expressions.md](../../docs/expressions.md), `table[index]`). Regions that no step reads hold the class C, one past the last class.
- **One matrix product.** `transitions[class][s][t] && bit` is one index read at `class + C × (1 - bit)` over the C cells of `transitions[·][s][t]`, with `outOfRange: 'zero'` above, so a bit of 0 reads +0 past the table. That's S² reads per product, and one ReLU per state for "none of the S reads is 1".
- **Both passes** take one product each, plus an AND NOT per state and 2 more operations in the forward pass: 2S² + 4S + 3 operations, and 2K + 4 for the class. Every forward step reads the reverse pass at its position, so the forward pass starts after the whole reverse pass, and the program is about 8 layers per code point.

Form (b) builds comparisons against the pattern's own class edges, as constants, and one membership sum per state, e.g. `[codePoint >= 97] - [codePoint >= 123]` for `[a-z]`. A step into state t reads the same membership bit from every state, so a product is that membership bit AND "some predecessor of t is live", 1 or 2 operations per state, instead of S reads per state.

## Measured results

Measured on September 17, 2026, on an Apple M5 Max with 18 cores, macOS 27.0, Bun 1.4.0 and headless Chrome 153.0.8010.48. Other agents' demos ran tests and builds on the same machine during these measurements. The patterns have exactly S states:

| S | Pattern | Classes | Class boundaries |
| --- | --- | --- | --- |
| 8 | `(the\|an?) [a-z]+` | 7 | 13 |
| 16 | `(the\|an?\|some) [a-z]+(ing)?s?` | 12 | 18 |
| 32 | `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? ` | 13 | 19 |

The text is sample-text.ts's prose, cut to N code points. Form (a)'s program holds 16 classes and 32 class boundaries at every S, and is the same program for every pattern within capacity.

Form (b)'s size depends on the pattern, even within the capacity, so the Bun tables also have rows for the most expensive pattern I found at S = 32, `expensivePattern` in report.ts: a chain of 31 different classes, each made of 14 or 15 of the 16 separate letters `acegikmoqsuwyACE`, i.e. `[cegikmoqsuwyACE]*[aegikmoqsuwyACE]*…[acegikmoqsuwyE]*[acegikmoqsuwyA]`, with 32 states, 16 classes and 32 class boundaries. Every state reads a different class and has different targets, and every membership sum has about 30 terms. Patterns where many states read the same class and have the same targets turned out cheaper, e.g. `(X|X|…|X)*` with 31 copies of one class, since the builder's deduplication map gives identical expressions one wire. I didn't prove that no pattern within the capacity costs more. These rows were measured later the same day, on the same machine, with the same scripts.

### Sizes

Live operations, layers and stored weights are what `compileTensorProgram` keeps for the next-state values and the outputs. Build ms is the builder code, compile ms is `compileTensorProgram`, and RSS is the Bun process after both. Each row is one process, and RSS varies between processes, e.g. for form (a) at S = 32 and 1,024 code points, 5 processes gave 5,831 to 8,142 MB: the row below, 3 later reruns (5,831, 6,476 and 6,855 MB) and a rerun during review (8,142 MB). Cells, operations, layers, stored weights and index reads were the same in every rerun.

| Form | S | N | Cells | Live operations | Layers | Stored weights | Index reads | Build ms | Compile ms | RSS MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (a) data | 8 | 256 | 1,354 | 58,920 | 2,046 | 145,069 | 32,848 | 113 | 81 | 204 |
| (a) data | 8 | 1,024 | 2,122 | 236,328 | 8,190 | 582,061 | 131,920 | 350 | 360 | 659 |
| (a) data | 16 | 256 | 4,434 | 164,816 | 2,046 | 450,525 | 130,592 | 261 | 171 | 566 |
| (a) data | 16 | 1,024 | 5,202 | 661,712 | 8,190 | 1,809,117 | 524,576 | 990 | 956 | 2,280 |
| (a) data | 32 | 256 | 16,738 | 572,064 | 2,046 | 1,647,805 | 521,536 | 873 | 558 | 1,994 |
| (a) data | 32 | 1,024 | 17,506 | 2,297,760 | 8,190 | 6,619,069 | 2,095,168 | 3,661 | 4,098 | 6,485 |
| (b) built in | 8 | 256 | 256 | 13,413 | 1,026 | 26,053 | 0 | 36 | 18 | 120 |
| (b) built in | 8 | 1,024 | 1,024 | 54,117 | 4,098 | 105,157 | 0 | 110 | 85 | 288 |
| (b) built in | 16 | 256 | 256 | 20,973 | 1,027 | 45,158 | 0 | 51 | 27 | 154 |
| (b) built in | 16 | 1,024 | 1,024 | 84,717 | 4,099 | 182,630 | 0 | 187 | 140 | 469 |
| (b) built in | 32 | 256 | 256 | 32,921 | 1,529 | 82,024 | 0 | 81 | 46 | 177 |
| (b) built in | 32 | 1,024 | 1,024 | 133,529 | 6,137 | 333,160 | 0 | 299 | 235 | 552 |
| (b) built in, expensive pattern | 32 | 256 | 256 | 63,240 | 1,788 | 552,222 | 0 | 196 | 113 | 477 |
| (b) built in, expensive pattern | 32 | 1,024 | 1,024 | 253,704 | 7,164 | 2,218,014 | 0 | 683 | 603 | 1,600 |

Form (a) is 8N − 2 layers at every S, and about 2S² + 4S + 71 live operations per code point, e.g. 2,244 at S = 32, of which 2,046 are index reads. Form (b) is about 53, 83 and 130 live operations per code point at S = 8, 16 and 32, and 4 to 6 layers per code point. With the expensive pattern at S = 32, form (b) is about 248 live operations, 2,166 stored weights and 7 layers per code point, against about 130 live operations and 325 stored weights for the prose pattern, and it stays about 3 times smaller than form (a) in stored weights.

### µs per evaluation in Bun

Each variant ran in its own process, 3 times per column. A process builds and compiles the variant, runs it for 1 s to warm up, then takes 7 samples of at least 300 ms each and keeps their median. The table shows the median of the 3 processes' medians, and their range. Every iteration evaluates the same source table, which doesn't change the cost, since the program runs every operation on every evaluation, and every iteration checks the match count against the automaton simulator. "Program alone" is `circuit.createTensorEvaluator(roots)`, which checks source ranges, and "through createEvaluator" adds cells.ts's checks of every cell before and after the evaluation and builds the output object.

| Form | S | N | µs per evaluation, program alone | µs through createEvaluator | µs per 1,000 live operations |
| --- | --- | --- | --- | --- | --- |
| (a) data | 8 | 256 | 499 (499 to 502) | 496 (492 to 505) | 8.5 |
| (a) data | 8 | 1,024 | 2,427 (2,422 to 2,598) | 2,456 (2,428 to 2,529) | 10.3 |
| (a) data | 16 | 256 | 1,888 (1,758 to 2,024) | 1,744 (1,650 to 1,806) | 11.5 |
| (a) data | 16 | 1,024 | 8,811 (8,562 to 8,954) | 9,060 (8,195 to 9,227) | 13.3 |
| (a) data | 32 | 256 | 6,351 (6,326 to 6,445) | 6,319 (6,266 to 6,597) | 11.1 |
| (a) data | 32 | 1,024 | 28,669 (27,869 to 28,828) | 28,352 (27,593 to 28,686) | 12.5 |
| (b) built in | 8 | 256 | 125 (125 to 126) | 129 (129 to 130) | 9.3 |
| (b) built in | 8 | 1,024 | 442 (439 to 454) | 467 (461 to 470) | 8.2 |
| (b) built in | 16 | 256 | 183 (179 to 184) | 191 (185 to 199) | 8.7 |
| (b) built in | 16 | 1,024 | 738 (732 to 759) | 726 (723 to 731) | 8.7 |
| (b) built in | 32 | 256 | 280 (277 to 281) | 285 (282 to 288) | 8.5 |
| (b) built in | 32 | 1,024 | 1,145 (1,144 to 1,158) | 1,178 (1,167 to 1,185) | 8.6 |
| (b) built in, expensive pattern | 32 | 256 | 834 (831 to 842) | 879 (869 to 881) | 13.2 |
| (b) built in, expensive pattern | 32 | 1,024 | 3,618 (3,435 to 3,625) | 3,578 (3,521 to 3,969) | 14.3 |

The cost follows the live operations, 8 to 13 µs per 1,000, except for form (b)'s expensive pattern, 13 to 14 µs per 1,000, where an operation reads about 9 stored weights instead of 2 to 3. createEvaluator's checks of 17,506 cells don't show against a 28 ms evaluation, and in form (b) the two columns differ by −12 to 33 µs for the prose patterns, within the spread between processes, and by 45 µs, about 5%, for the expensive pattern at 256 code points, where the ranges don't overlap. A new pattern in form (a) costs compiling the pattern and writing its cells before the evaluation: 30 µs at S = 8 and 256 code points, 59 µs at S = 16 and 1,024, and 144 µs at S = 32 and 256, each timed over 100 repetitions in the sizes process.

### A new pattern in form (b)

One process per row. From the pattern string to its first evaluation: `compilePattern`, the builder code, `createEvaluator`'s compile, and one evaluation. Median of 5 runs after 1 warm-up run.

| S | N | Compile pattern ms | Build ms | Compile program ms | First evaluation ms | Total ms |
| --- | --- | --- | --- | --- | --- | --- |
| 8 | 256 | 0.08 | 21 | 14 | 0.3 | 36 |
| 8 | 1,024 | 0.09 | 78 | 63 | 0.8 | 143 |
| 16 | 256 | 0.10 | 38 | 22 | 0.5 | 60 |
| 16 | 1,024 | 0.12 | 144 | 118 | 1.3 | 270 |
| 32 | 256 | 0.13 | 61 | 35 | 0.6 | 93 |
| 32 | 1,024 | 0.15 | 248 | 203 | 1.5 | 459 |
| 32, expensive pattern | 256 | 0.31 | 144 | 84 | 1.1 | 238 |
| 32, expensive pattern | 1,024 | 0.31 | 579 | 434 | 3.8 | 1,024 |

### Keystroke frames in headless Chrome

`browser-frame.ts` serves the page with Bun, opens it in headless Chrome with a fresh profile, types with the DevTools Protocol's `Input.insertText`, one code point per keystroke, waits for each frame, and reads the page's own timings. Pattern scenarios start from an empty pattern field and type the S-state pattern above. Only keystrokes where the pattern compiles and fits evaluate, e.g. `(the|an?` is an unterminated group, so that frame shows the syntax message and no matches, and the table's times cover the evaluated frames. Ready is from opening the page to the first highlighted frame, including form (a)'s build and compile. The callback is the `requestAnimationFrame` callback: compiling the pattern, writing cells or building the program, the evaluation and the DOM writes, 0.2 to 0.9 ms of DOM writes at 1,024 code points. "Input to next frame" runs from the first input event since the previous frame to the next frame's callback after the DOM writes, so it includes waiting for 2 frames, e.g. 26 ms at S = 8 where the callback takes 1.2 ms. The page's `performance.now()` reads in steps of about 0.1 ms.

| Scenario | Ready ms | JS heap MB | Keystrokes, evaluated | Evaluation ms, median (max) | Callback ms, median (max) | Input to next frame ms, median (max) |
| --- | --- | --- | --- | --- | --- | --- |
| (a) S = 8, N = 256, typing the pattern | 230 | 113 | 16, 4 | 1.1 (1.6) | 1.2 (1.8) | 25.6 (26.4) |
| (a) S = 16, N = 1,024, typing the pattern | 2,630 | 485 | 29, 8 | 10.6 (10.8) | 10.9 (11.1) | 27.3 (32.7) |
| (a) S = 16, N = 1,024, typing 24 code points at the end of the text | 2,543 | 462 | 24, 24 | 9.8 (12.2) | 10.1 (12.4) | 27.4 (28.5) |
| (b) S = 32, N = 1,024, typing the pattern | 253 | 117 | 49, 7 | 2.2 (4.8) | 309.0 (365.2), of which building and compiling 306.2 (361.9) | 312.6 (366.2) |
| (a) S = 32, N = 1,024, typing the pattern | 9,722 | 1,468 | 49, 7 | 30.3 (32.4) | 30.7 (32.6) | 33.3 (39.0) |

This table was measured after the page fixes, later the same day, on the same machine with other agents' work running. Chrome evaluated the same programs more slowly than Bun, e.g. 30 ms against 28.7 ms for form (a) at S = 32 and 1,024 code points, and 2.2 ms against 1.1 ms for form (b), and built and compiled form (b) faster, about 306 ms against 451 ms. The S = 8 scenario has only 4 evaluated frames.

## What fit well

- Every value in both programs is an exact bit or a small integer, so the tests compare matches exactly, with no tolerance: 26 hand-written cases, and 400 random patterns with 6 texts each. 4 of the texts are random, over an alphabet with line terminators including U+2028 and U+2029, an emoji, U+10FFFF, escaped syntax characters, and the code points where `\d` and `\w` start or stop, e.g. `9`, `Z` and `_`. The other 2 are made of the code points just below, at and above the pattern's class boundaries. A last test puts a pattern at the largest capacity whose last match ends on the last cell. At every variant in the Bun tables, report.ts also checks the match count against the automaton simulator, including at 1,024 code points.
- The index read turns a table entry AND a bit into one operation: `circuit.indexReadAffine([[class, 1], [bit, -C]], C, table, 'clamp', 'zero')` reads `table[class]` when the bit is 1, and +0 past the table when it's 0. That removed a product per matrix entry, i.e. half of form (a)'s operations.
- Declaring code points and boundaries on a grid of 1 in cells.ts made every class comparison 2 operations, with no hand-written comparison code.
- A new pattern in form (a) is JavaScript work only: compiling the pattern and writing its cells took 144 µs at S = 32, and the program, its size and its cost per evaluation don't depend on the pattern. That's the fixed worst case from vibescript's engineering.md: any pattern within capacity costs what the largest one costs. Form (b) holds the same capacity on the page, so its cost has an upper bound too, but within that bound it depends on the pattern, e.g. 1,145 µs per evaluation for the S = 32 prose pattern and 3,618 µs for the expensive pattern, at 1,024 code points.
- The capacity check fits behavior-choices.md's "A fixed maximum with a named fallback": one message per exceeded capacity, and the page highlights nothing and says why, instead of highlighting the wrong code points.
- bits.ts folds bits that builder code already knows, e.g. the initial state has no predecessors, so form (b) builds operations only for the steps the pattern has, without special cases in the passes.

## What got awkward

- A matrix whose entries are runtime values costs S² operations per product, so form (a) is about 2S² operations per code point, and one evaluation at S = 32 and 1,024 code points takes about 28 ms in Bun and 30 ms in Chrome, about two frames at 60 fps. The same pattern built into the program is 133,529 operations, 17 times fewer, and 1.2 ms in Bun.
- The lookahead doubles the work and the depth: every forward step reads the reverse pass at its position, so the forward pass comes after the whole reverse pass, and the program has about 8 layers per code point, 8,190 at 1,024 code points. Grouping the steps into a tree of matrix products ([patterns.md](../../docs/patterns.md), "Why a tree gives the loop's answer") would give O(log N) layers, but combining two S × S matrices of bits is S³ products, 32,768 at S = 32, for each of about 2N combines. I didn't build it.
- Building at this size is slow and uses a lot of memory. Form (a) at S = 32 and 1,024 code points appends 2,367,454 operations in 3.4 to 3.7 s and compiles them in 3.6 to 4.3 s, and the Bun process reaches 5.8 to 8.1 GB, depending on the run. In Chrome, the page takes 9.7 s before its first frame, with 1,468 MB of JS heap. `compileTensorProgram` allocates an `Int32Array` of the circuit's whole width for every layer, so compile time grows with layers × width, and `createTensorEvaluator` looks up each output root with `wireOrder.indexOf`.
- Form (b) rebuilds on every keystroke that changes the pattern: 459 ms in Bun and about 306 ms in Chrome at S = 32 and 1,024 code points, almost all of it building and compiling, and 1,024 ms in Bun for the expensive pattern. Before the page checked the capacity in form (b), a pasted pattern with 133 states took more than 1.5 s per keystroke in Chrome. Now that pattern gets the named message and builds nothing.
- Form (a) stores the full C × S × S matrices. A position automaton only needs S × S bits for which steps exist and C × S bits for which classes each state reads, 1,536 cells instead of 16,384 at S = 32, but the operations would stay S² per product, since the step bits are runtime values either way. The full matrices keep the program an executor for any automaton within capacity, e.g. one with fewer states after minimization.
- Classes are JavaScript's work: `partitionClasses` finds the code points where the class changes. The program then pays K + 1 comparisons per code point for the class, 68 of about 2,244 operations per code point at S = 32, but 68 of about 231 at S = 8.
- Built operations and live operations differ in form (b): a sum of fewer than 4 terms is copied into the operations that read it and stays in `circuit.operations` without readers, e.g. 193,950 built against 133,529 live operations at S = 32 and 1,024 code points. The page shows built operations, so it overstates form (b).
- The search never reports an empty match, e.g. `a*` finds nothing in `bcd`, while RegExp's `matchAll` with the `g` flag reports an empty match at positions 0, 1, 2 and 3. Reporting empty matches would need the definition to say how the scan moves past them.

## Where the docs were missing, wrong or confusing

- patterns.md has no entry for a loop whose decision needs later input, like a longest match that is only known after reading past its end. The reverse pass that computes "can this state still reach an accepting state" for every position is what I needed, and it's a general construction, e.g. for a tokenizer that takes the longest token. "A state machine over queued events" covers one integer state read from a table, not a set of states held as a 0/1 vector.
- expressions.md's `table[index]` row doesn't mention the read at `index + count × (1 - bit)` with `outOfRange: 'zero'`, which is `bit ? table[index] : 0` in one operation. I found it from execution-model.md's "Index reads" rules.
- Nothing in the docs says what building and compiling a program of millions of operations costs, e.g. the 5.8 to 8.1 GB and the compile time that grows with layers × width above. A line in execution-model.md's "Compilation" with one measured size would tell an agent where the builder stops being practical.
- tutorial.md's host loop is built around `advanceFrame` and springs. A program with no state and nothing animating, like this search, only needs `createEvaluator` and one evaluation per frame where an input changed, and the tutorial doesn't say that `advanceFrame` can be left out. `table.finish()` with no state cells worked, and `createEvaluator` then checks every input cell twice per evaluation, before the evaluation and again as its own next value, 17,506 cells here, which didn't show in the timings.
- execution-model.md's "Compilation" says that compiling removes operations that can't reach an output, but not that small sums copied into their readers become such operations, so `circuit.operations.length` can overstate a program, e.g. 193,950 against 133,529 in form (b).

docs/ covers these notes since September 17, 2026: patterns.md's ["A loop whose decision needs later input"](../../docs/patterns.md#a-loop-whose-decision-needs-later-input) and the set of states in ["A state machine over queued events"](../../docs/patterns.md#a-state-machine-over-queued-events), expressions.md's `condition ? table[index] : 0` row, tutorial.md's ["A program without state or animation"](../../docs/tutorial.md#a-program-without-state-or-animation), and execution-model.md's [Compilation](../../docs/execution-model.md#compilation) section.

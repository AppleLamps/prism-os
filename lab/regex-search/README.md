# Regex search as matrix products

## What it is

Search as you type over a text of fixed capacity, e.g. 256 or 1,024 code points, and the page offers 256, 512, 768 and 1,024. JavaScript parses a pattern and compiles it into an automaton with at most S states and 16 character classes. The program runs the automaton one step per code point, as products of a class's transition matrix with a 0/1 state vector, and returns one highlighted bit and one match start bit per code point. It finds every non-overlapping, non-empty match, leftmost, then longest. The program has two forms, (a) and (c). A third, (b), was removed on October 14, 2026:

- (a) The pattern as data, in src/json-search/regex/data-program.ts. The transition matrix of every class, the accepting states and the class of every code point sit in cells, so a new pattern writes cells and changes no program.
- (b) The pattern built into the program, in builtin-program.ts, from September 17 to October 14, 2026. The builder knew the automaton, so each step was a fixed sparse sum over the steps the pattern has, and a new pattern rebuilt and recompiled the program. At 32 states and 1,024 code points, the program built for one pattern had 133,529 live operations where form (a)'s has 2,297,760, about 17 times fewer, and rebuilding and recompiling it at each keystroke that changed the pattern took 0.40 to 0.48 s in Bun and 0.24 to 0.31 s in headless Chrome. Form (b) was removed after the standalone page that offered it, and aff4603 is the last commit that has builtin-program.ts, its tests, its measurements in report.ts, and this README's sections and table rows about it.
- (c) The pattern as data in form (a)'s cells, with the steps over the text combined in a tree of matrix products instead of two loops, in tree-program.ts. It was added later the same day to test whether the program's matrix products can run as a few large batched products on the GPU, see [Matrix product tree on the GPU](#matrix-product-tree-on-the-gpu-september-17-2026). The page doesn't offer it.

On October 14, 2026 the files that JSON search's page loads moved into [src/json-search/regex/](../../src/json-search/regex/): pattern.ts, data-program.ts, bits.ts and host.ts. reference.ts moved into tests/json-search/regex/, and so did the tests of the moved files, which were in this folder's regex-search.test.ts. This folder keeps form (c) with its tests, the GPU measurement of form (c) and report.ts.

The pattern language is a subset of JavaScript's RegExp syntax with the `u` flag: literal code points, `.`, `\d`, `\w`, character classes with ranges and negation, e.g. `[a-z_]` or `[^0-9]`, `?`, `*`, `+`, `|` and groups. Everything else, e.g. `*?`, `{2}`, `^` or `(?:`, throws a `PatternSyntaxError` with its position.

## How to run it

From the repo root:

```sh
bun test lab/regex-search                                   # 9 tests in 2 files, of form (c), about 3 seconds
bun test tests/json-search/regex                            # 8 tests of form (a) and of the pattern compiler, about 2 seconds
bunx tsc -p lab/regex-search                                # type-check, including gpu/
bunx oxlint --type-aware lab/regex-search                   # lint
bun lab/regex-search/report.ts                              # the sizes and the µs per evaluation in Bun of forms (a) and (c) below, each variant in its own process
bun lab/regex-search/report.ts sizes tree 8 1024            # one size of form (c), e.g. with Brent-Kung's network
bun lab/regex-search/gpu/run.ts --mode check --profile <folder> --out <file.json>   # the GPU tree in headless Chrome over many patterns and texts, about 1 minute
```

The GPU measurements need reference bits from the CPU first, see the comments at the top of gpu/cpu-time.ts, gpu/run.ts and gpu/summarize.ts. The raw results are in gpu/results/, and summarize.ts prints every table in [Matrix product tree on the GPU](#matrix-product-tree-on-the-gpu-september-17-2026) from them, with `--gpu` gpu-main-1.json to gpu-main-4.json, `--frames gpu-frames-1.json`, `--checks gpu-check-1.json` and `--cpu cpu-programs.jsonl,cpu-programs-2.jsonl,cpu-js.jsonl`, in that order, so the second batch of form (a)'s timings replaces the first, which ran at load average 12 to 14.

The page, rewritten on October 13, 2026, has a pattern field and three selects: Program, with form (a) as "one for every pattern" and form (b) as "built for each pattern", States, with 8, 12, 16 and 32, and Text capacity, with 256, 512, 768 and 1,024 code points. It starts with form (a) at 12 states and 768 code points. A change of a select builds the program in place, after a frame that shows "Building the program…", and keeps the choice in the query string. The page refuses to build form (a) above 1 million operations, i.e. 32 states at 512 code points or more, and says why. The text is edited in place, in a transparent textarea over the text, and the matches are rectangles behind the text in two copper washes that alternate, so neighboring matches stay apart. The page evaluates once in each frame where the pattern, the text or the program changed. The result line shows the count of matches, or one sentence per problem when the pattern has a syntax error or doesn't fit, and then no match is drawn. A text longer than the capacity is searched up to the capacity: the result line then reads e.g. "7 matches in the first 256 characters", the count of characters turns red, and the text after a bar is gray. The statistics show the compiled program's operations and layers, e.g. 312,108 operations in 6,142 layers at the starting choice, the time to build the program, and the time of the last search, and "How the pattern fits the program" shows the automaton's size against the capacity. [Keystroke frames in headless Chrome](#keystroke-frames-in-headless-chrome) has the page's times since the rewrite.

| File | What it holds |
| --- | --- |
| `src/json-search/regex/pattern.ts` | The parser, the position automaton (Glushkov's construction), the class partition, and the capacity check with its messages |
| `src/json-search/regex/data-program.ts` | Form (a): cells, builder code, writing a pattern into cells, and the machine the tests run |
| `tree-program.ts` | Form (c): builder code, with Brent-Kung's or Sklansky's prefix network from src/runtime/prefix-networks.ts |
| `tree-inputs.ts` | Form (c) in plain JavaScript: a loop that computes what form (c) computes, the network's combines in levels, and the (S + 1) × (S + 1) matrices whose products give the reverse pass's bits |
| `gpu/automaton-inputs.ts`, `gpu/kernels.ts` | The GPU tree: class matrices, leaf matrices, the plan of slots per level, the WGSL kernels and the host loop, plus two plain JavaScript loops to compare with |
| `gpu/page.ts`, `gpu/run.ts`, `gpu/cpu-time.ts`, `gpu/summarize.ts`, `gpu/results/` | GPU measurements in headless Chrome, CPU measurements in Bun, the tables, and the raw results |
| `src/json-search/regex/bits.ts` | AND, AND NOT, NOT and "none of" on bits, folding bits that builder code already knows |
| `src/json-search/regex/host.ts` | Writing code points into text cells, and turning the output bits into matches |
| `tests/json-search/regex/reference.ts` | The two plain JavaScript references |
| `regex-search.test.ts` | Differential tests of form (c) |
| `tests/json-search/regex/regex-search.test.ts`, `tests/json-search/regex/test-patterns.ts` | Differential tests of form (a) and of the pattern compiler, and the hand-written cases and seeded random patterns and texts that both test files draw |
| `report.ts` | Measurements in Bun |
| `sample-text.ts` | The text of the measurements |

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

A pattern that needs more states, classes or boundaries gets a named message instead of a program, e.g. `the pattern needs 33 states, and the program holds 32`, and the page shows a sentence for it, e.g. "This pattern needs 33 states, and the program holds 32.", highlights nothing, and shows the automaton's size under "How the pattern fits the program". A text longer than N is searched only up to N code points, and the page says so and draws the rest in gray.

Form (a)'s operations for one code point:

- **Its class.** K + 1 integer comparison bits, `[codePoint >= boundary]` and `[codePoint >= 0]`, 2 operations each, since code points and boundaries are declared on a grid of 1 ([expressions.md](../../docs/expressions.md), `a >= b`). Their sum is the region, and `circuit.indexRead(region, regionClasses)` is the class ([expressions.md](../../docs/expressions.md), `table[index]`). Regions that no step reads hold the class C, one past the last class.
- **One matrix product.** `transitions[class][s][t] && bit` is one index read at `class + C × (1 - bit)` over the C cells of `transitions[·][s][t]`, with `outOfRange: 'zero'` above, so a bit of 0 reads +0 past the table. That's S² reads per product, and one ReLU per state for "none of the S reads is 1".
- **Both passes** take one product each, plus an AND NOT per state and 2 more operations in the forward pass: 2S² + 4S + 3 operations, and 2K + 4 for the class. Every forward step reads the reverse pass at its position, so the forward pass starts after the whole reverse pass, and the program is about 8 layers per code point.

## Measured results

Measured on September 17, 2026, on an Apple M5 Max with 18 cores, macOS 27.0, Bun 1.4.0 and headless Chrome 153.0.8010.48. Other agents' demos ran tests and builds on the same machine during these measurements. The patterns have exactly S states:

| S | Pattern | Classes | Class boundaries |
| --- | --- | --- | --- |
| 8 | `(the\|an?) [a-z]+` | 7 | 13 |
| 16 | `(the\|an?\|some) [a-z]+(ing)?s?` | 12 | 18 |
| 32 | `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? ` | 13 | 19 |

The text is sample-text.ts's prose, cut to N code points. Form (a)'s program holds 16 classes and 32 class boundaries at every S, and is the same program for every pattern within capacity.

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

Form (a) is 8N − 2 layers at every S, and about 2S² + 4S + 71 live operations per code point, e.g. 2,244 at S = 32, of which 2,046 are index reads.

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

The cost follows the live operations, 8 to 13 µs per 1,000. createEvaluator's checks of 17,506 cells don't show against a 28 ms evaluation. A new pattern in form (a) costs compiling the pattern and writing its cells before the evaluation: 30 µs at S = 8 and 256 code points, 59 µs at S = 16 and 1,024, and 144 µs at S = 32 and 256, each timed over 100 repetitions in the sizes process.

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

Update, October 13, 2026: the table above is for the page as it was until that day. The rewritten page was measured with the same script on the same machine, with Bun 1.4.3 and headless Chrome 155.0.8059.40, in one run at load average 4.0 to 5.0. The script's first scenario is now the page's starting choice, and its last one form (a) at S = 32 and 256 code points, since the page refuses S = 32 at 1,024. Ready now includes one frame that draws "Building the program…", and the DOM writes, 0.4 to 0.5 ms at the median here, include the layout that the matches' rectangles are read from. The heap is `performance.memory.usedJSHeapSize` without a collection.

| Scenario | Ready ms | JS heap MB | Keystrokes, evaluated | Evaluation ms, median (max) | Callback ms, median (max) | Input to next frame ms, median (max) |
| --- | --- | --- | --- | --- | --- | --- |
| (a) S = 12, N = 768, the page's starting choice, typing the 8-state pattern | 590 | 225 | 16, 4 | 4.3 (4.9) | 5.0 (5.8) | 30.8 (30.9) |
| (a) S = 8, N = 256, typing the pattern | 142 | 47 | 16, 4 | 0.9 (1.0) | 1.5 (1.5) | 28.3 (31.0) |
| (a) S = 16, N = 1,024, typing the pattern | 1,261 | 407 | 29, 8 | 9.5 (9.8) | 10.1 (10.6) | 26.2 (26.7) |
| (a) S = 16, N = 1,024, typing 24 code points at the end of the text | 1,352 | 401 | 24, 24 | 8.9 (12.6) | 9.6 (13.5) | 27.2 (30.0) |
| (b) S = 32, N = 1,024, typing the pattern | 199 | 65 | 49, 7 | 2.3 (4.9) | 245.7 (287.2), of which building and compiling 243.1 at the median | 249.1 (288.8) |
| (a) S = 32, N = 256, typing the pattern | 899 | 431 | 49, 7 | 7.7 (10.4) | 8.1 (11.3) | 27.5 (31.0) |

On Bun's development server, which `bun start` also runs, the starting choice was ready 0.58 to 0.68 s after the navigation started, over three sets of 5 loads at load averages from 4 to 11, and held 169 MB of JavaScript heap after a forced collection in each set. Ready is the page's `performance.now()` when `window.regexSearchReady` becomes true. Other choices, with 2 loads each on the same server, the same day:

| Form | States | Code points | Operations | Layers | Ready ms | Heap MB after a collection |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| (a) | 8 | 256 | 58,920 | 2,046 | 156 to 160 | 32 |
| (a) | 8 | 1,024 | 236,328 | 8,190 | 517 to 548 | 123 |
| (a) | 12 | 256 | 103,724 | 2,046 | 238 to 245 | 57 |
| (a) | 12 | 1,024 | 416,300 | 8,190 | 802 to 895 | 226 |
| (a) | 16 | 256 | 164,816 | 2,046 | 314 to 326 | 93 |
| (a) | 16 | 1,024 | 661,712 | 8,190 | 1,276 to 1,277 | 364 |
| (a) | 32 | 256 | 572,064 | 2,046 | 997 to 1,061 | 321 |
| (a) | 32 | 512, 768 or 1,024 | refused by the page | | 42 to 53 | 1 |
| (b), the starting pattern | 12 | 768 | 40,549 | 3,074 | 165 to 178 | 25 |
| (b), the starting pattern | 32 | 1,024 | 54,117 | 4,098 | 218 to 221 | 33 |

## What fit well

- Every value in both programs is an exact bit or a small integer, so the tests compare matches exactly, with no tolerance: 26 hand-written cases, and 400 random patterns with 6 texts each. 4 of the texts are random, over an alphabet with line terminators including U+2028 and U+2029, an emoji, U+10FFFF, escaped syntax characters, and the code points where `\d` and `\w` start or stop, e.g. `9`, `Z` and `_`. The other 2 are made of the code points just below, at and above the pattern's class boundaries. A last test puts a pattern at the largest capacity whose last match ends on the last cell. At every variant in the Bun tables, report.ts also checks the match count against the automaton simulator, including at 1,024 code points.
- The index read turns a table entry AND a bit into one operation: `circuit.indexReadAffine([[class, 1], [bit, -C]], C, table, 'clamp', 'zero')` reads `table[class]` when the bit is 1, and +0 past the table when it's 0. That removed a product per matrix entry, i.e. half of form (a)'s operations.
- Declaring code points and boundaries on a grid of 1 in cells.ts made every class comparison 2 operations, with no hand-written comparison code.
- A new pattern in form (a) is JavaScript work only: compiling the pattern and writing its cells took 144 µs at S = 32, and the program, its size and its cost per evaluation don't depend on the pattern. That's the fixed worst case from chenguini's engineering.md: any pattern within capacity costs what the largest one costs.
- The capacity check fits behavior-choices.md's "A fixed maximum with a named fallback": one message per exceeded capacity, and the page highlights nothing and says why, instead of highlighting the wrong code points.
- bits.ts folds bits that builder code already knows, e.g. the initial state has no predecessors, so form (b) built operations only for the steps the pattern had, without special cases in the passes.

## What got awkward

- A matrix whose entries are runtime values costs S² operations per product, so form (a) is about 2S² operations per code point, and one evaluation at S = 32 and 1,024 code points takes about 28 ms in Bun and 30 ms in Chrome, about two frames at 60 fps. The same pattern built into the program, form (b), was 133,529 operations, 17 times fewer, and 1.2 ms in Bun.
- The lookahead doubles the work and the depth: every forward step reads the reverse pass at its position, so the forward pass comes after the whole reverse pass, and the program has about 8 layers per code point, 8,190 at 1,024 code points. Grouping the steps into a tree of matrix products ([patterns.md](../../docs/patterns.md), "Why a tree gives the loop's answer") gives O(log N) layers, but combining two S × S matrices of bits is S³ products, 32,768 at S = 32, for each of about N combines. Form (c) built that tree later the same day, see [Matrix product tree on the GPU](#matrix-product-tree-on-the-gpu-september-17-2026).
- Building at this size is slow and uses a lot of memory. Form (a) at S = 32 and 1,024 code points appends 2,367,454 operations in 3.4 to 3.7 s and compiles them in 3.6 to 4.3 s, and the Bun process reaches 5.8 to 8.1 GB, depending on the run. In Chrome, the page takes 9.7 s before its first frame, with 1,468 MB of JS heap. `compileTensorProgram` allocates an `Int32Array` of the circuit's whole width for every layer, so compile time grows with layers × width, and `createTensorEvaluator` looks up each output root with `wireOrder.indexOf`. Update, later on September 17, 2026: since commit 351e5cd, `compileTensorProgram` allocates one such array per compile instead of one per layer, so compile time no longer grows with layers × width. `bun lab/regex-search/report.ts sizes data 32 1024` now takes 3.2 to 3.8 s to build and 1.3 to 1.5 s to compile, and the process peaks at 4.8 to 5.8 GB of RSS, over 6 processes at load average 1.8 to 3.0. A copy of the commit before, alternated with 3 of those processes, took 3.3 to 3.5 s to build and 3.0 to 3.7 s to compile, and peaked at 6.9 to 7.5 GB. Form (b)'s rebuild, `report.ts recompile 32 1024`, went from 461 to 482 ms to 400 to 402 ms in the same session, over 3 alternated processes each, all of the difference in the compile. Every other time and RSS in this README was measured before that change, including Chrome's 9.7 s. The `wireOrder.indexOf` lookup is unchanged. Update, October 13, 2026: a survey before the page's rewrite measured the page at this size again, in Chrome 155: ready after 4.3 s, with 1,295 MB of JavaScript heap after a collection. Since that day the page refuses to build form (a) above 1 million operations, so it no longer builds this program.
- Form (a) stores the full C × S × S matrices. A position automaton only needs S × S bits for which steps exist and C × S bits for which classes each state reads, 1,536 cells instead of 16,384 at S = 32, but the operations would stay S² per product, since the step bits are runtime values either way. The full matrices keep the program an executor for any automaton within capacity, e.g. one with fewer states after minimization.
- Classes are JavaScript's work: `partitionClasses` finds the code points where the class changes. The program then pays K + 1 comparisons per code point for the class, 68 of about 2,244 operations per code point at S = 32, but 68 of about 231 at S = 8.
- The search never reports an empty match, e.g. `a*` finds nothing in `bcd`, while RegExp's `matchAll` with the `g` flag reports an empty match at positions 0, 1, 2 and 3. Reporting empty matches would need the definition to say how the scan moves past them.

## Where the docs were missing, wrong or confusing

- patterns.md has no entry for a loop whose decision needs later input, like a longest match that is only known after reading past its end. The reverse pass that computes "can this state still reach an accepting state" for every position is what I needed, and it's a general construction, e.g. for a tokenizer that takes the longest token. "A state machine over queued events" covers one integer state read from a table, not a set of states held as a 0/1 vector.
- expressions.md's `table[index]` row doesn't mention the read at `index + count × (1 - bit)` with `outOfRange: 'zero'`, which is `bit ? table[index] : 0` in one operation. I found it from execution-model.md's "Index reads" rules.
- Nothing in the docs says what building and compiling a program of millions of operations costs, e.g. the 5.8 to 8.1 GB and the compile time that grows with layers × width above. A line in execution-model.md's "Compilation" with one measured size would tell an agent where the builder stops being practical.
- tutorial.md's host loop is built around `advanceFrame` and springs. A program with no state and nothing animating, like this search, only needs `createEvaluator` and one evaluation per frame where an input changed, and the tutorial doesn't say that `advanceFrame` can be left out. `table.finish()` with no state cells worked, and `createEvaluator` then checks every input cell twice per evaluation, before the evaluation and again as its own next value, 17,506 cells here, which didn't show in the timings.
- execution-model.md's "Compilation" says that compiling removes operations that can't reach an output, but not that small sums copied into their readers become such operations, so `circuit.operations.length` can overstate a program, e.g. 193,950 against 133,529 in form (b).

docs/ covers these notes since September 17, 2026: patterns.md's ["A loop whose decision needs later input"](../../docs/patterns.md#a-loop-whose-decision-needs-later-input) and the set of states in ["A state machine over queued events"](../../docs/patterns.md#a-state-machine-over-queued-events), expressions.md's `condition ? table[index] : 0` row, tutorial.md's ["A program without state or animation"](../../docs/tutorial.md#a-program-without-state-or-animation), and execution-model.md's [Compilation](../../docs/execution-model.md#compilation) section.

## Matrix product tree on the GPU, September 17, 2026

### Why

Cheng's idea: a program is layers of sparse matrix multiplication with elementwise gates between them, so fuse the multiplications into very few GEMMs, i.e. large batched products of dense matrices, which a GPU runs in one call. Fusing stops at every gate, so the number of large kernels can't go below the number of gate layers, e.g. 275 for HandwiredOS. It only works where logic is written as associative steps: an automaton's per-code-point transition matrices can be multiplied in a tree, and each level of the tree is one batched product over all its pairs, plus one clamp back to 0/1. Cheng said: "yes please, good idea". The prediction to test: on the CPU, the tree costs more operations, S³ per product against S² per code point for the loop, and on the GPU it wins once each level's batch is big enough, from some text length to find. Update, September 18, 2026: the 275 above counts every layer. 195 of them held gates, and the longest chain of gates was 149, which is the lower limit. [patterns.md](../../docs/patterns.md#when-a-tree-takes-less-time-than-the-loop) explains the limit with today's numbers.

The repo's WGSL executors, e.g. lab/ui-exploration/codegen/wgsl.ts, run one table's statements one after another, so they can't show this. The evening before, on September 16, 2026, a scratch WebGPU executor ran HandwiredOS's program at 2.2 ms per evaluation, against 81 µs on the CPU, because nothing inside one table ran in parallel. So this experiment has its own kernels, with one dispatch per level of the tree over every combine of that level.

### What was built

**Form (c), in tree-program.ts.** It reads form (a)'s cells, and each code point is a leaf: an S × S 0/1 matrix, S² index reads of `transitions[class][s][t]`, and a vector of ends. The forward pass of form (a) restarts at state 0 when no match continues, which is a NOT of an OR, and a product of 0/1 matrices can't compute a NOT. So form (c) doesn't carry bits. For every position and state, it carries the end of the longest path that ends in an accepting state, or 0 when there's none. JS: `longestEnd[j][s] = Math.max(0, ...states.filter(t => step[j][s][t]).map(t => Math.max(accepting[t] ? j + 1 : 0, longestEnd[j + 1][t])))`. A block of neighboring code points has a map of the same kind, a 0/1 matrix and a vector of ends, and two blocks combine with one clamped matrix product, S³ ANDs and S² "none of" clamps, plus `ends[s] = Math.max(earlier.ends[s], ...states.map(u => earlier.matrix[s][u] ? later.ends[u] : 0))`. Both parts are associative, so a prefix network, Brent-Kung's or Sklansky's from [src/runtime/prefix-networks.ts](../../src/runtime/prefix-networks.ts), gives the longest ends at every position in O(log N) levels. The network runs from the end of the text, so a combine whose later block reaches the end of the text only multiplies a matrix with a vector.

Picking the matches: `longestEnd[p][0]` is the end of the longest match that starts at p, so the scan position after p is known for every p at once, `next[p] = Math.max(longestEnd[p][0], p + 1)`. ceil(log2 N) tables of repeated jumps, where `jumps[k][p]` is `next` applied 2^k times to p, come from index reads, and a binary descent over them finds the last scan position at or before each position, with 4 operations per level. A match starts at p when that scan position is p and a match starts there, and p is highlighted when the match at the scan position ends after p. That's about 4 log2 N + 8 operations per position, in O(log N) layers. Every operation that holds an end declares the range 0..N, since the builder's inferred range of a maximum doubles at every level otherwise.

**The GPU tree, in gpu/.** The GPU runs form (c)'s network, one level per dispatch, but not form (c)'s integer ends. It multiplies (S + 1) × (S + 1) 0/1 matrices A[j] = [[T[j], T[j] × accepting], [0, 1]], where T[j] is code point j's transition matrix. The last column of the clamped product A[j] × A[j + 1] × … × A[N − 1] holds reach[j], the bits of form (a)'s reverse pass, which equal form (c)'s longestEnds > 0. So the GPU computes the reach bits at every position, and doesn't compute the integer ends, which need a max-plus product instead of a sum of products, or the match selection. Every product is `Math.min(1, sum over u of earlier[s][u] × later[u][t])`, i.e. a batched GEMM with a clamp. gpuPlan turns Brent-Kung's network into matrix slots and one list of [earlier, later, result] triples per level and per kind of product. Each level is one dispatch of the matrix product kernel and one of the matrix-vector kernel, and every matrix stays on the GPU between levels. A last kernel packs the reach bits into one 32-bit word per position, which the host reads back. At 1,024 code points that's 18 levels, and at 65,536 code points 30 levels: 15 with 65,519 matrix products and 15 with 65,535 matrix-vector products.

An evaluation gets its leaves in one of two ways:

- **Uploaded leaves**: JavaScript writes N × (S + 1)² floats, e.g. 285.5 MB at S = 32 and 65,536 code points, and uploads them.
- **Gathered leaves**: JavaScript uploads the class of every code point, N × 4 bytes, and a gather kernel copies each class's matrix into the leaves on the GPU. The class matrices are uploaded once per pattern.

The matrix product kernel runs one invocation per combine and row of the result, in workgroups of 16 × 16. A sweep of 6 kernel shapes at 16,384 code points chose that shape: at S = 32, its pass took 3.17 ms, against 3.85 to 10.81 ms for the other 5.

### Form (c) on the CPU

Each variant ran in its own process with report.ts's loop, and µs is the median of 3 processes' medians through `createTensorEvaluator`, and their range. Build ms, compile ms and peak RSS come from one sizes process each. Load average 3.1 to 6.5 during these timings. Form (a)'s rows were timed again in the same batch, and differ from the µs table above by 1% to 12%, e.g. 1,652 against 1,888 µs at S = 16 and 256 code points.

| Form | S | N | Live operations | Layers | Stored weights | Build ms | Compile ms | Peak RSS MB | µs per evaluation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (a) data | 8 | 256 | 58,920 | 2,046 | 145,069 | | | | 511 (507 to 515) |
| (c) tree, Brent-Kung | 8 | 256 | 255,794 | 138 | 638,232 | 443 | 251 | 670 | 2,104 (2,103 to 2,160) |
| (c) tree, Sklansky | 8 | 256 | 287,872 | 101 | 722,300 | 1,050 | 293 | 1,689 | 2,361 (2,299 to 2,372) |
| (a) data | 8 | 1,024 | 236,328 | 8,190 | 582,061 | 426 | 428 | 690 | 2,461 (2,382 to 2,641) |
| (c) tree, Brent-Kung | 8 | 1,024 | 1,064,103 | 174 | 2,647,858 | 1,893 | 1,135 | 2,888 | 9,486 (9,401 to 10,282) |
| (c) tree, Sklansky | 8 | 1,024 | 1,278,722 | 124 | 3,220,449 | 6,351 | 1,812 | 6,176 | 11,555 (10,840 to 11,819) |
| (a) data | 16 | 256 | 164,816 | 2,046 | 450,525 | | | | 1,652 (1,628 to 1,661) |
| (c) tree, Brent-Kung | 16 | 256 | 1,418,036 | 156 | 3,890,705 | 2,244 | 1,592 | 4,402 | 12,556 (12,304 to 12,794) |
| (a) data | 16 | 1,024 | 661,712 | 8,190 | 1,809,117 | 1,046 | 911 | 1,888 | 8,128 (8,037 to 8,245) |
| (c) tree, Brent-Kung | 16 | 1,024 | 5,896,363 | 198 | 16,178,525 | 10,495 | 8,555 | 8,712 | 54,994 (53,335 to 58,284) |
| (a) data | 32 | 256 | 572,064 | 2,046 | 1,647,805 | 906 | 528 | 1,947 | 6,265 (6,138 to 6,314) |
| (c) tree, Brent-Kung | 32 | 64 | 2,085,087 | 130 | 5,890,778 | 3,471 | 1,939 | 6,029 | 19,724 (17,932 to 19,741) |
| (c) tree, Brent-Kung | 32 | 256 | 9,496,009 | 176 | 26,890,122 | 22,435 | 14,630 | 8,540 | 93,982 (85,675 to 97,759) |
| (a) data | 32 | 1,024 | 2,297,760 | 8,190 | 6,619,069 | 3,650 | 3,761 | 7,414 | 28,315 (27,824 to 29,131) |

- The prediction holds on the CPU. Form (c) with Brent-Kung's network is 4.3 to 4.5 times form (a)'s live operations at S = 8, 8.6 to 8.9 times at S = 16, and 16.6 times at S = 32 and 256 code points, and 3.9 to 4.1, 6.8 to 7.6, and 15.0 times its µs. Most of it is matrix products, e.g. at S = 32 and 256 code points, 247 products × (32,768 ANDs + 1,024 clamps), about 8.3 million of the 9.5 million live operations.
- Depth doesn't matter to the CPU executor: 8.2 to 10.3 µs per 1,000 live operations for form (c) against 8.7 to 12.3 for form (a), whether the program has 138 layers or 8,190.
- Sklansky's network has fewer layers but more combines, and more operations built and then removed, e.g. 3,890,810 built against 1,278,722 live at S = 8 and 1,024 code points.
- S = 32 at 1,024 code points didn't fit on this machine. The build was still running when it was killed at 200 s, at 12.4 GB of RSS while the machine swapped heavily, and would have built about 43 million operations. Form (c) in a timing process at S = 32 and 256 code points reached 11.6 GB, and 13.4 GB in a later one.

### Correctness checks

- 13 tests in 2 files, up from 7. For form (c) with both networks:
  - the 26 hand-written cases, and 400 random patterns with 6 texts each
  - index reads, grids, NaN, and every wire's range, whether declared or inferred, with a new `validateRanges`
  - 80 random patterns over 13 code points, where form (c)'s longest ends equal tree-inputs.ts's loop and both plans run in JavaScript, and form (a)'s reverse pass and the clamped products of the (S + 1) × (S + 1) matrices give the reach bits
  - 30 random patterns with 9 to 16 states over full texts of 37 code points, where both networks have incomplete blocks, against forms (a) and (b) and both references
  - S = 32 over 16 code points with a match on the last cell
  - 1, 2, 3 and 17 code points, with 12 edge patterns, e.g. `[^]*` and `x|`, over 8 texts each including the empty text
- gpu/automaton-inputs.test.ts: the leaf writer, both plain JavaScript loops and the GPU plan run in JavaScript give tree-inputs.ts's reach bits at 1 to 1,024 code points, for a text shorter than N, and for a 32-state pattern whose bit 31 is 1. Every level of the plan reads only slots written by earlier levels, and writes every slot once, up to 16,384 code points.
- Form (a) builds the same program after data-program.ts's refactor: a hash of its operations is identical before and after at two capacities, and its sizes match the tables above.
- Every GPU readback was compared bit for bit, with 0 mismatched positions anywhere:
  - In the 4 main runs and the frames run: 502,692 readbacks compared with tree-inputs.ts's loop and with the dense JavaScript loop, at all 27 sizes, 185,138 with form (a)'s program at 256 and 1,024 code points, and at 512 in run 4, and 140,837 with form (c)'s program at 5 sizes.
  - The main runs use one pattern and one text per size, and at S = 32 that pattern never sets state 31. So the check mode runs 78 to 108 cases per S and text length, at 1, 2, 3, 37, 1,024 and 4,096 code points, with both inputs: the measured pattern, hand-written patterns, e.g. `[ab]*` repeated 31 times, where all 32 states reach an accepting state, nullable patterns like `a*` and `[^]*`, and 10 random patterns, each over 6 texts, 2 of them shorter than N. The references come from tree-inputs.ts's loop, run in the page. That's 1,620 cases and 1,394,010 positions, of which 271,080 are past the end of their text, and 56,947 have bit S − 1 set, e.g. 17,293 at S = 32 and 4,096 code points.

### Timings

Measured on September 17, 2026, on an Apple M5 Max with 18 cores and 36 GiB, macOS 27.0, Bun 1.4.0, and headless Chrome 153.0.8010.48 through Metal, with timestamp queries. The page is cross-origin isolated, so `performance.now()` reads in steps of 5 µs. Other agents' processes ran throughout, including another headless Chrome using about one core, and the GPU showed 28% utilization before any of these runs started. Load average over 1 minute:

- GPU main runs 1 and 2: 3.3 to 4.2. Run 3: from 4.2, rising to 15.8 at the end, which gives most of the high ends of the ranges at S = 32. Run 4: 7.2 to 7.5.
- Form (a)'s program: 6.3 to 8.0, with 3 processes per size before GPU run 4 and 3 after it.
- Form (c)'s program: 6.3 to 7.6 at S = 8 and at S = 16 and 256 code points, 3 processes each. 5.7 to 6.8 at S = 16 and 1,024 code points, and 2.9 to 3.7 at S = 32 and 256, 1 process each.
- The JavaScript loops in Bun: 2.6 to 5.1.

Method:

- GPU, per size: at least 1 s and 3 evaluations of warmup, then at least 15 samples and 3 s, keeping the median. The table shows the median of the runs' medians, and their range: 4 runs with uploaded leaves, and 3 with gathered leaves, since run 1 didn't have that input. The median of 4 values is the mean of the middle two.
- Every GPU figure includes the JavaScript work before the upload, i.e. writing the leaves or copying the classes, the upload, every level, the packing, `mapAsync` and copying the words out.
- CPU: gpu/cpu-time.ts runs each variant in its own process with report.ts's loop, 1 s of warmup, then 7 samples of at least 300 ms each, keeping their median. Every process checks its reach bits against tree-inputs.ts's loop before and after timing. Form (a)'s and form (c)'s programs return only the reverse pass's bits or the longest ends, through `createTensorEvaluator`.
- "JS loop" is `denseReach`, S × S reads per code point, like one step of form (a)'s reverse pass. The same loop also ran inside the GPU page in Chrome, once per run. "JS loop over words" is `bitmaskReach`, the same loop with each matrix row as a 32-bit word, S word operations per code point.

ms per evaluation, all computing the reach bits at every position:

| S | N | GPU, uploaded leaves | GPU, gathered leaves | Form (a) program | Form (c) program | JS loop in Bun | JS loop in the page | JS loop over words in Bun |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 256 | 0.35 (0.28 to 0.42) | 0.40 (0.25 to 0.40) | 0.36 (0.29 to 0.46) | 2.38 (2.38 to 2.63) | 0.007 | 0.013 | 0.001 |
| 8 | 512 | 0.35 (0.32 to 0.49) | 0.33 (0.27 to 0.45) | 0.80 (0.67 to 0.85) | | 0.015 | 0.026 | 0.002 |
| 8 | 1,024 | 0.48 (0.37 to 0.60) | 0.47 (0.27 to 0.47) | 1.63 (1.45 to 2.09) | 10.51 (9.94 to 10.59) | 0.030 | 0.051 | 0.004 |
| 8 | 2,048 | 0.58 (0.47 to 0.76) | 0.51 (0.29 to 0.52) | | | 0.059 | 0.100 | 0.009 |
| 8 | 4,096 | 0.83 (0.69 to 0.98) | 0.56 (0.30 to 0.64) | | | 0.118 | 0.201 | 0.018 |
| 8 | 8,192 | 1.29 (1.10 to 1.54) | 0.66 (0.33 to 0.69) | | | 0.236 | 0.401 | 0.035 |
| 8 | 16,384 | 1.19 (0.96 to 1.42) | 0.43 (0.37 to 0.47) | | | 0.483 | 0.795 | 0.071 |
| 8 | 32,768 | 2.12 (1.68 to 3.09) | 0.44 (0.44 to 1.18) | | | 0.965 | 1.61 | 0.143 |
| 8 | 65,536 | 3.83 (3.42 to 4.87) | 1.14 (0.65 to 1.37) | | | 1.93 | 3.34 | 0.286 |
| 16 | 256 | 0.54 (0.38 to 0.73) | 0.62 (0.30 to 0.62) | 1.04 (0.88 to 1.18) | 14.87 (13.51 to 15.06) | 0.025 | 0.040 | 0.002 |
| 16 | 512 | 0.64 (0.47 to 0.85) | 0.32 (0.32 to 0.41) | 1.99 (1.80 to 2.12) | | 0.050 | 0.080 | 0.004 |
| 16 | 1,024 | 0.88 (0.65 to 1.10) | 0.45 (0.34 to 0.48) | 4.87 (4.12 to 5.37) | 50.16 | 0.101 | 0.156 | 0.009 |
| 16 | 2,048 | 1.12 (1.02 to 1.53) | 0.37 (0.37 to 0.38) | | | 0.199 | 0.330 | 0.018 |
| 16 | 4,096 | 1.26 (0.88 to 1.76) | 0.43 (0.42 to 0.44) | | | 0.404 | 0.624 | 0.036 |
| 16 | 8,192 | 1.61 (1.46 to 2.70) | 0.51 (0.50 to 0.95) | | | 0.812 | 1.25 | 0.073 |
| 16 | 16,384 | 4.08 (2.90 to 4.85) | 0.70 (0.69 to 0.74) | | | 1.62 | 2.66 | 0.144 |
| 16 | 32,768 | 7.90 (5.50 to 10.61) | 1.27 (1.12 to 1.34) | | | 3.24 | 5.29 | 0.287 |
| 16 | 65,536 | 13.77 (10.37 to 17.33) | 2.23 (1.91 to 3.09) | | | 6.50 | 12.44 | 0.586 |
| 32 | 256 | 1.23 (0.81 to 1.48) | 0.61 (0.36 to 0.75) | 3.34 (3.09 to 3.97) | 83.45 | 0.093 | 0.148 | 0.003 |
| 32 | 512 | 1.65 (1.03 to 2.21) | 0.42 (0.40 to 0.52) | 7.69 (6.71 to 9.15) | | 0.185 | 0.312 | 0.007 |
| 32 | 1,024 | 1.84 (0.89 to 2.53) | 0.49 (0.46 to 0.54) | 14.88 (14.42 to 15.82) | | 0.374 | 0.699 | 0.014 |
| 32 | 2,048 | 2.49 (1.43 to 3.92) | 0.64 (0.63 to 1.17) | | | 0.754 | 1.48 | 0.028 |
| 32 | 4,096 | 4.61 (4.49 to 6.98) | 1.02 (0.88 to 1.26) | | | 1.50 | 3.12 | 0.054 |
| 32 | 8,192 | 8.27 (5.40 to 11.59) | 1.82 (1.34 to 1.85) | | | 3.01 | 5.62 | 0.109 |
| 32 | 16,384 | 14.20 (10.22 to 20.80) | 4.21 (2.31 to 4.54) | | | 6.00 | 11.94 | 0.213 |
| 32 | 32,768 | 25.06 (20.29 to 38.30) | 9.23 (4.31 to 9.73) | | | 11.97 | 22.72 | 0.435 |
| 32 | 65,536 | 44.24 (36.94 to 76.31) | 17.08 (11.95 to 18.68) | | | 23.93 | 42.39 | 0.867 |

- The leaves are 21.2, 75.8 and 285.5 MB at S = 8, 16 and 32 and 65,536 code points. At S = 32 and 65,536 code points, the uploaded total of 44.24 ms includes 5.61 ms of writing the leaves in JavaScript, and the compute pass took 6.78 ms (6.32 to 8.42) from timestamp queries. The uploaded total minus the gathered total in the same run, without the JavaScript work, is 25 ms (21.7 to 48.7), a lower estimate of the upload, since the gathered input copies the same 285.5 MB on the GPU instead. A separate upload-only figure, `writeBuffer` and then `onSubmittedWorkDone` on an empty command buffer, took 35.16 ms, which plus the pass is more than a whole evaluation, so that figure waits for more than the upload.
- One pass per level at S = 32 and 65,536 code points, in run 1: the 15 levels with matrix products took 5.46 ms, the 15 levels with only matrix-vector products 0.94 ms, and the packing 0.023 ms. That's 65,519 products of 33 × 33 matrices, about 2.35 billion multiply-adds, in about 5.5 ms.
- Timestamp pass times differ up to 2.7 times between runs at the same size, e.g. 1.62 to 4.45 ms at S = 16 and 65,536 code points. With gathered leaves at S = 32 and 65,536 code points, the pass took 9.8 to 14.1 ms, against 6.3 to 8.4 ms with uploaded leaves, while the gather only adds one copy. The GPU's performance state and the other process using the GPU are possible causes, and I didn't verify either. The totals in the table are the figures to rely on.
- The programs didn't build past 1,024 code points on this machine. `compileTensorProgram` allocates an `Int32Array` of the circuit's whole width for every layer, and form (a) has 8N − 2 layers. Form (a) at S = 32 and 1,024 code points took 3.7 to 4.8 s to build, 3.1 to 3.6 s to compile and 6.3 to 7.5 GB, over 6 processes. Form (c) needed 14.9 GB at S = 16 and 1,024 code points, and 13.4 GB at S = 32 and 256, whose first process was killed at a 16 GB limit before a retry with 22 GB fit. Update, later on September 17, 2026: the array per layer is gone since commit 351e5cd, and form (a) at S = 32 and 1,024 code points now compiles in 1.3 to 1.5 s and peaks at 4.8 to 5.8 GB, see [what got awkward](#what-got-awkward). Sizes past 1,024 code points and form (c)'s sizes haven't been tried again.
- Compile time per kernel, from `createShaderModule` to `createComputePipelineAsync`, with a new salt in the shader source every run, so no shader cache was hit: 40 to 78 ms for the first matrix product kernel in a new Chrome process at S = 8, which includes one-time setup, 7 to 20 ms for the matrix product kernel at S = 16 and 32, and 5 to 20 ms for the matrix-vector product, packing and gather kernels.

Results relative to `requestAnimationFrame` at 1,024 code points, from one run at load average 2.8 to 3.7: 120 evaluations per case, each submitted in a callback, with headless frames every 16.7 ms.

| S | Uploaded leaves: result arrives after the submitting callback, ms, median (p90, max) | Gathered leaves: result arrives, ms, median (p90, max) |
| --- | --- | --- |
| 8 | 1.05 (1.47, 6.09) | 0.95 (1.63, 2.02) |
| 16 | 2.07 (2.64, 3.12) | 1.33 (1.87, 2.27) |
| 32 | 3.53 (4.37, 5.58) | 1.73 (2.18, 2.78) |

All 720 results arrived before the next callback, so each can be drawn in the frame after its submit. Headless Chrome's frames may differ from a real display's.

### The crossover

`bun lab/regex-search/gpu/summarize.ts` prints the crossover of every GPU input against every CPU variant, the median of the runs and each run's own.

Against form (a)'s program, which computes the same bits:

- At S = 16 and 32, the GPU is faster at every measured length from 256 code points, in every run and with both inputs, e.g. with uploaded leaves, 0.54 against 1.04 ms at S = 16 and 256 code points, and 1.84 against 14.88 ms at S = 32 and 1,024. So the crossover is below 256, which wasn't measured.
- At S = 8, it's about even at 256 code points, 0.35 against 0.36 ms: 2 of the 4 runs with uploaded leaves and 1 of the 3 runs with gathered leaves are faster. From 512 code points, the GPU is faster in every run, e.g. 0.35 against 0.80 ms.
- Extrapolated linearly, form (a) at S = 32 and 65,536 code points would take about 950 ms, against 44 ms with uploaded leaves and 17 ms with gathered leaves.
- Form (c)'s program isn't part of the crossover, since it computes the integer ends, where the GPU computes only the bits. It's slower than form (a) at every size anyway.

Against the plain JavaScript loop, S × S reads per code point:

- With uploaded leaves, the GPU is slower at every length up to 65,536 code points at every S, against the loop in Bun, and against the loop in the page in most runs, e.g. 44.24 against 23.93 ms in Bun and 42.39 ms in the page at S = 32 and 65,536 code points. Against the loop in the page, run 1 was faster from 65,536 code points and run 2 from 8,192 at S = 32, and run 2 from 65,536 at S = 16.
- With gathered leaves, against the loop in Bun: faster from 2,048 code points at S = 32 in 2 of 3 runs and from 4,096 in the other, from 8,192 at S = 16 in 2 runs and 16,384 in the other, and from 16,384 at S = 8 in 2 runs and 65,536 in the other. E.g. 0.64 against 0.75 ms at S = 32 and 2,048 code points, and 17.08 against 23.93 ms at 65,536.
- With gathered leaves, against the same loop inside the page, where it runs 1.5 to 1.9 times slower than in Bun: faster from 1,024 code points at S = 32 and from 4,096 at S = 16 in every run, and from 16,384 at S = 8 in 2 runs and 8,192 in the other.

Against the loop over 32-bit words, the GPU is slower at every size and every S with either input, e.g. 17.08 against 0.87 ms at S = 32 and 65,536 code points.

### What this says about Cheng's idea

- Where the steps combine associatively, the idea works on the GPU as predicted. The tree turns form (a)'s 8N − 2 layers into 2 log2 N − 2 levels of Brent-Kung's network, 30 at 65,536 code points, and a level is two dispatches over all of its combines. At S = 32 and 65,536 code points, 65,519 products of 33 × 33 matrices took about 5.5 ms on the GPU. On the CPU executor, the same tree only costs more, since that executor's cost follows live operations whatever the depth.
- The kernels weren't the bottleneck. Moving data to the GPU was: uploading N × (S + 1)² floats of leaves takes longer than every level together, e.g. at least 25 ms against a pass of about 7 ms at S = 32 and 65,536 code points. What changes per evaluation has to be small, like the class of each code point, and everything derived from it has to be computed on the GPU, which is what the gathered leaves do.
- For small S, bit-parallel code on the CPU beats batched products of dense matrices: a row of a 0/1 matrix fits in one 32-bit word, and a JavaScript loop over words takes 867 µs at S = 32 and 65,536 code points, 20 times less than the GPU's 17 ms. The kernels store every 0/1 entry as a 4-byte float, and packing rows into words on the GPU wasn't tried.
- Only part of the search is a product of 0/1 matrices. The GPU computes the reverse pass's bits. Picking the matches needs a NOT of an OR, the forward pass's restart at state 0, which a clamped product can't compute. Form (c) replaces it with integer ends combined by maximums, a max-plus product with the same shape as a GEMM, which wasn't written as a kernel, and with tables of jumps and a binary descent, which are index reads and comparisons in O(log N) layers, not products.
- Where it doesn't apply: a tree needs a step whose effect over a block of steps has a fixed-size form, which two neighboring blocks combine into associatively. An automaton over S states has one, an S × S matrix. Logic without such a form can't be fused past its gates, e.g.:
  - Greedy line breaking, "start a new line when the next word doesn't fit", carries the current line's width. A block of words acts on the incoming width through as many thresholds as the block has words, so a block has no fixed-size map to multiply, unless the widths are quantized into a table of states, like an automaton's.
  - Sums of FP32 values round differently depending on the grouping ([patterns.md](../../docs/patterns.md), "Why a tree gives the loop's answer"), so a tree of sums gives the loop's bits only for exact values, e.g. integers below 2^24.
  - HandwiredOS's program had 275 layers with a median of 27 operations per layer on September 17, 2026, made of many different pieces of logic rather than repeated steps of one associative operation, so there is no tree to build, and a GPU would have run 275 kernels per evaluation as compiled then, and no fewer than 149, its longest chain of gates. The scratch executor mentioned above ran it in 2.2 ms, against 81 µs on the CPU.

### What the review found, and what changed

The review found no defect in form (c) or the kernels, and a stress test of form (c) at 1 to 33 code points, 14,535 texts per network, passed. It found these problems in the measurements and the write-up, which are fixed:

- The crossover against plain JavaScript compared GPU times in Chrome with the loop in Bun, which runs 1.5 to 1.9 times faster than the same loop in the page. summarize.ts now includes the loop in the page as its own variant, and this section names the runtime of each crossover.
- Form (a)'s program had been timed at load average 12 to 14, against 3.3 to 4.2 for 2 of the GPU runs, which made the GPU look faster at S = 8 and 256 code points. Form (a) was timed again at load 6.3 to 8.0, before and after a fourth GPU run at a similar load, and at 512 code points too. At S = 8 the GPU is about even at 256 and faster from 512.
- summarize.ts's median of an even count took the larger value, so the gathered leaves' figures, from 2 runs, were their maximum under the label "median". The median of an even count is now the mean of the middle two, the fourth run gives the gathered input 3 runs, and summarize.ts prints each run's crossover.
- The upload-only figure and the pass time add up to more than a whole evaluation, so the earlier summary overstated the upload's share. This section estimates the upload as the difference between the two inputs' totals in the same run.
- The main runs check one pattern and one text per size, which at S = 32 never sets bit 31. The check mode covers more patterns, texts shorter than N, and bit S − 1.
- The tests ran form (c) only at 13, 16 and 37 code points. A new test covers 1, 2, 3 and 17 code points with both networks.
- The earlier summary compared the GPU with form (c)'s program, which computes more than the GPU does. The crossover now compares only with form (a)'s program.

Separately, scripts/check.ts didn't find gpu/tsconfig.json, so the gpu folder's type check only ran by hand. lab/regex-search/tsconfig.json now includes gpu/*.ts, and gpu/tsconfig.json is gone.

### Not done

- The GPU doesn't compute the search's output: there's no max-plus kernel for the integer ends, and no match selection.
- Leaves are f32, 4 bytes per 0/1 entry, with no bit packing. The main runs used only the row-16x16 kernel and Brent-Kung's network, so Sklansky's network wasn't measured on the GPU.
- The programs' times past 1,024 code points are extrapolations, and form (c) at S = 32 has only 256 code points.
- Only one frames run.
- The demo page doesn't offer form (c).

### Update, October 13, 2026: many documents instead of one long text

Form (a)'s step also runs as a loop on the GPU, over many documents instead of one long text: [lab/json-search](../../src/json-search/README.md#regex-searchs-step) builds one code point's work with this folder's `emitClasses` and `createStepAnd`, and a shader loops it over a document's 512 positions. The shader compiles in 0.05 to 0.11 s at 8 states, and one search of 100,000 documents takes 7 to 8 ms for a pattern of up to 8 states, 64 ms up to 16 states and 871 ms up to 32, when searches follow each other. In the same page, RegExp counts every match of ordinary patterns in 8 to 43 ms on one thread, and in 2 to 7 ms in 8 workers. A search after a pause of 200 ms or more takes longer, e.g. 17 to 21 ms at 8 states. The September timings above in this section sampled evaluations one after another and measured no pause, and their JavaScript loops ran on one thread.

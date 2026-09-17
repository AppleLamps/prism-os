# Text walker circuit

This folder tests whether pretext's line-breaking algorithm itself, and not only its tabulated results, can run as one compiled circuit of affine, ReGLU and boolean atoms. If it can, text can react to several runtime values at once: a different width for every line around a moving rectangle, one spring per word, and segment widths edited while the page runs.

The short answer: for pretext's fast path (text, spaces and zero-width spaces, no letter spacing), yes. The circuit computes prefix sums, fit comparisons and line starts from segment widths and break-after bits held in the source table, and matched pretext exactly on every check I ran. Line breaking reduces to counting comparison bits, because widths are nonnegative. The other pretext features I tried (hard-break chunks, breaks inside long words, soft hyphens, letter spacing, tabs) are only partly in the circuit. JavaScript restates pretext's walker for every start position, and stores each start's width thresholds and the line each threshold leads to as source cells. The circuit compares those thresholds with each line's own width and chains the lines. So those features take a different width per line at runtime, but an edited segment width means recomputing the rows in JavaScript. The cost that grows fastest is not the comparisons but reading a table at a computed integer index, which is 70-89% of the circuit for 1023-segment paragraphs.

## What it is and how to run it

From the repository root:

```sh
bun test lab/ui-exploration/text-walker
bunx tsgo -p lab/ui-exploration/text-walker
bun lab/ui-exploration/text-walker/report.ts ladder flow springs
bun lab/ui-exploration/text-walker/report.ts fast
bun lab/ui-exploration/text-walker/demo.html
```

The tests (28 tests in 6 files, about 4 seconds, 10 of them in `batch/`, 2 of those in `batch/gpu/`) check every circuit against pretext. report.ts prints the tables below; its `fast` part builds 1023-segment circuits and takes about a minute. The demo page is a paragraph flowing around a draggable window with a spring per word.

`pretext-src/` is a copy of pretext's `src/` (analysis, bidi, entry-geometry, layout, line-break, line-text, measurement and the generated tables) from commit 477510e of the clone in the phase 2 scratchpad, so the tests don't depend on a temporary folder. It has the same files as text-tabulated's `pretext/`, but stays a separate copy: `bun test` shares modules between test files, and pretext keeps the engine profile and measuring canvas it creates first, so the Gecko profile that this folder's and streaming-words' tests install needs its own module. The runtime is the shared `numeric-ui-core.ts`, unchanged.

Headless checks run pretext with a deterministic fake canvas (`fake-canvas.ts`, adapted from phase 1). Its widths are multiples of 1/4 px, so float64 and FP32 prefix sums agree exactly. They also use the Gecko engine profile: `lineFitEpsilon` 0.005, no return from an unfit soft hyphen, and no skipping of narrow tab stops.

## What was built

| File | What it holds |
| --- | --- |
| `kit.ts` | Source table builder, the 4-operation comparison `fitBit`, the integer one-hot, masked reads, and compile-time counts, including how many live operations build integer one-hots |
| `fast-walker.ts` | pretext's fast path as circuit arithmetic over runtime widths and break-after bits, with five ways to recover lines |
| `fast-check.ts` | The comparison of a fast-path circuit with pretext's `walkLineRanges` and `measureLineStats`, shared by the tests and the report |
| `rows.ts` | pretext's two line walkers restated in JavaScript as candidate rows, for the feature ladder |
| `rows-circuit.ts` | The circuit that walks lines over those rows, with a width per line |
| `flow.ts` | A paragraph flowing around a rectangle, with per-word positions and springs, plus a JavaScript port of dynamic-layout's `layoutColumn` as the reference |
| `word-springs.ts` | Fixed 4ms springs as one shared 2x2 step matrix per frame |
| `demo.html`, `demo.ts`, `demo.css` | The demo page. `demo.ts` only measures text, writes inputs, and projects outputs |
| `report.ts`, `samples.ts` | The measurements below, and the ladder texts |
| `batch/` | One line breaking program per paragraph size, over many paragraphs on the CPU and on WebGPU, see [Many paragraphs on the GPU](#many-paragraphs-on-the-gpu-september-17-2026) |

### 1. The fast path over runtime widths

The fast path covers text, space and zero-width space segments, with no letter spacing, and lines at least as wide as the widest segment. Widths and break-after bits are source cells, so an edited width, or another paragraph with the same segment count, needs no recompile as long as three bounds chosen at build time still hold: the window (how many segments after a line start get compared), the number of line slots, and the run limit (the longest run of break-after segments, e.g. a space followed by two zero-width spaces is a run of 3). The run limit defaults to the longest run in the paragraph the circuit is built from, and the `runLimit` build option raises it. `fast-walker.test.ts` builds circuits from a paragraph whose runs are 1 long, then writes in the break-after bits of a paragraph with runs of 3. Those circuits report the longer runs, and the same builds with `runLimit: 3` match pretext on the new bits.

Tables computed in the circuit:
- Prefix sums, from a Brent-Kung network. These are exact for quarter-pixel widths while the paragraph stays below 2^17 px in total.
- A fit threshold per segment, `T[j] = S[j] - breakAfter[j] * width[j]`, where `S[j]` is the prefix sum through segment j. A space or zero-width break adds nothing to the fit because it hangs past the line edge, which matches `getWholeSegmentFitContribution`.
- The painted prefix of a line that ends before segment j. pretext excludes only the last break-after segment from the painted width. For example, a line ending in a space followed by a zero-width space still paints the space. So the painted prefix is `T[j-1]`.
- The number of break-after segments skipped by a line that starts at segment j, as a sum of products of neighboring break-after bits, up to the run limit. For example, with a run limit of 2, `skip(j) = b[j] + b[j] * b[j+1]`, where `b` is the break-after bit.

For a line that starts at segment s, the bits `[T[s+o] - prefix(s) <= width + epsilon]` read 1..1 0..0 as the offset o grows, because widths are nonnegative. The first segment that doesn't fit is therefore a count of bits, not a search. Every output is a sum that telescopes over neighbors, for example `width(s) = width[s] + sum over o of fits(o) * (paintEnd(s+o+1) - paintEnd(s+o))`. Each product has a fit bit as its gate, and a difference that doesn't depend on the start, so all starts share those differences.

A comparison is `boolean(clamp01(64 * (width + epsilon - span) + 0.5))`, with the clamp composed into the boolean atom's terms: 4 live operations, 3 layers. The score adds the span terms first, then the width, then the 0.5 offset through a unit cell, so large prefix terms cancel before small terms are added. It is exact whenever the difference is at least about 1/128 px. That always holds for quarter-pixel spans and widths, because every such difference is at least epsilon.

The integer one-hot uses the hat function `relu(x-p+1) - 2 relu(x-p) + relu(x-p-1)`. Neighboring positions share relus, so it costs about 2 atoms per position instead of phase 1's 3.

Five ways to recover lines:
- **Next-start table + sequential lines.** next(s) and width(s) for every start (segments × window comparisons), then one one-hot per line slot to read the table at that line's start.
- **Gathered lines.** No table. Each line slot builds one one-hot of its start, gathers the thresholds for the window after it, and compares them with that slot's own width. This is the only form that takes a different width per line.
- **Next-start table + segment scan.** `isLineStart[j]` is a sum of hat functions of earlier starts' pointers, where each pointer's relus are shared by all later targets. There are no computed-index reads, but depth grows with the segment count.
- **Next-start table + pointer jumping.** Jump tables next^(2^m) with windowed one-hots, then binary lifting for lineCount and maxLineWidth.
- **Segment walker.** `walkPreparedLinesSimple` unrolled one segment at a time. It carries the prefix at the current line start, and a bit for "skipping break-after segments after a break", so it has no window, line slots or run limit.

Outputs differ by formulation, and the tests and the report compare every output a formulation has (`fast-check.ts`):
- Every formulation outputs lineCount and maxLineWidth.
- Sequential and gathered lines output every line slot's start and painted width. With `segmentGeometry`, gathered lines also output each segment's line index and x within its line.
- The segment scan outputs each segment's `isLineStart` bit and the painted width of the line that starts there.
- The segment walker outputs each segment's line index and x.
- Pointer jumping outputs only lineCount and maxLineWidth, so it is checked only on those. Line starts would need a binary lifting walk per line slot.

Each circuit also outputs `windowOverflow`, `moreLinesThanSlots` and `runOverflow`, which are nonzero when the window, the line slots or the run limit were too small for the text. Pointer jumping has `ceil(log2(lineSlots))` levels, so it counts at most 2^levels lines, and reports more lines than that. The segment scan has no line slots. `fast-walker.test.ts` checks that too few line slots and too small a window are reported.

### 2. The feature ladder

The other features run in two parts. `rows.ts` restates pretext's two line walkers in JavaScript, and derives, for every start position, the widths at which the line would end differently and the line each of those widths leads to. `rows-circuit.ts` stores those rows as source cells, and walks lines over them with a width per line. Only the fast path computes its thresholds in the circuit from segment widths. So the ladder steps accept per-line widths at runtime, but not edited segment widths, letter spacing or tab stops.

For a fixed start cursor, a walker's state (line width, pending break, line end) changes the same way whatever the width is, until the first comparison against `width + epsilon` fails. `rows.ts` follows the walker's code path with every comparison passing. At each comparison, it records the value compared and the line the walker would produce if that comparison were the first to fail. Raw values can decrease along a line: with letter spacing, text charges its trailing gap and the following space doesn't. So thresholds are replaced by their running maximum, which keeps the same first failure and makes the bits monotone.

A row is then `outcome = base + sum over c of [threshold_c <= width] * delta_c`, with deltas for the next start, the end cursor, and the painted width. `rows-circuit.ts` reads the row at each line's start through one one-hot, and compares each candidate with that line's own width. Candidates above the widest tested width are dropped, and neighbors with equal thresholds are merged. For plain text, a space's candidate and the next word's candidate produce the same line, so a 320 px line needs 8 candidates where the fast walker compares 20 segments.

The circuit makes every decision that depends on a line's width, and chains the lines. Phase 1's per-start breakpoint rows used the same circuit shape, but found the thresholds by sweeping pretext's output over widths.

What each step needed. Every step runs through the same rows circuit, so the work in this table is done in JavaScript before the circuit runs. Only the cursor units for breakable long words change the circuit, by making its one-hots longer.

| Step | New work in the JavaScript derivation | What changed |
| --- | --- | --- |
| Hard-break chunks | None | The chunk end is a final outcome that never fails. An empty chunk is a row with no candidates. Skipping consumed-only chunks is static normalization of the next start |
| Breakable long words, grapheme units, preferred breaks | Cursor units inside segments | Graphemes of segments that can overflow become start positions: 18 segments became 118 units. Every grapheme that can overflow is a candidate, and the preferred break the line falls back to is fixed per failing grapheme. The whole-segment admission check merges into the same candidate list, because the grapheme advances add up to the segment width |
| Soft hyphens | None | The walker also checks whether the pending hyphen fits. Without Blink's return to an earlier break, both outcomes of that check give the same line (details below) |
| Letter spacing | Running maximum of thresholds | Leading, trailing and terminal gaps are static once the start and end are fixed |
| Tabs in pre-wrap | Two candidates per break-after segment | A tab's advance depends on the line position, which is static once the start is fixed. A break-after segment that overflows hangs only when the line before it fits, so it gets one candidate for "the line before it overflows" and one for "the segment itself overflows" |

Soft hyphens in more detail: when a comparison fails, pretext ends the line at the pending break only if the pending break's fit width fits, and for a soft hyphen that width includes the hyphen. When it doesn't fit, the Gecko profile ends the line at the current line end with `getCurrentLinePaintWidth`, which already paints the hyphen when the line ends right after one. So both outcomes give the same line. `rows.ts` computes the fit width the way pretext does, and asserts at every candidate that either an earlier candidate's threshold already proves that the fit width fits, or both outcomes give the same line. In a scratch run, leaving the hyphen out of `currentPaintWidth` made that assertion throw on the soft-hyphen and all-features samples. Over the rows test's width grid, pretext ends 1,400 lines of the soft-hyphen sample and 868 lines of the all-features sample right after a soft hyphen.

### 3. Per-word geometry and springs

Gathered lines reuse each line slot's one-hot relus. `[start_k <= j]` is an affine form over two of them. So a segment's line index is one sum over slots, and its x is `prefix(j) + sum over k of [start_k <= j] * ((left_k - startPrefix_k) - (left_(k-1) - startPrefix_(k-1)))`: one product per segment and slot.

`word-springs.ts` follows the doctrine's timing: fixed 4ms steps, a runtime step count, and a cap. One semi-implicit Euler step on displacement and velocity is a constant 2x2 matrix M, so n steps are M^n: the product of the M^(2^j) selected by the bits of n. That product is computed once per frame. Each spring then costs 4 signed products, plus a settle check that snaps it exactly onto its target.

### 4. Per-line widths around a rectangle

`flow.ts` derives each band's slot from integer obstacle state, as `layoutColumn` does. Per band, two integer comparisons decide whether the rectangle overlaps the band vertically. The slot choice is shared by all blocked bands: left and right slot widths, a minimum slot width, the widest slot wins, and ties go to the right slot. A band with no slot lays out nothing and keeps its start, which costs one product. The reference in `flow.ts` runs `layoutColumn`'s carving and slot choice for one rectangle, with pretext's `layoutNextLineRange` per band.

### 5. Demo

A paragraph set in Georgia flows around a draggable window, and every word follows its own spring. A slider changes the column width. Clicking a word makes it bold, which writes the word's bold width into its source cell. On each change, the page compares the circuit with pretext's `layoutNextLineRange`, using the browser's canvas and engine profile, and counts mismatches in the side panel. Line starts, usable bands, visibility and y must be equal. Painted widths and x may differ by up to 0.01 px, because real canvas widths aren't multiples of 1/4 px, so the circuit's FP32 sums and pretext's float64 sums can differ in their last bits. Every headless check requires exact equality.

The minimum slot width is the widest bold word, so the fast path never needs an emergency break. dynamic-layout instead keeps slots down to 24 px and lets pretext break long words.

Nobody was awake to grant browser permissions, so I didn't open the page. A later Chrome check opened the page, see [Browser check](#browser-check). It bundles (`bun build lab/ui-exploration/text-walker/demo.html --outdir <folder>`: 18 modules). A scratch script checked the demo's text, bands, spring setup and bold toggles headlessly, but with the fake canvas's widths, and with each word's width times 1.25 standing in for bold, since the fake canvas has no bold face. With those widths the circuit has 223 segments, 20 bands, 33,052 live operations and 239 layers, and had 0 mismatches over 150 random column widths, window positions and bold toggles, at about 230 µs per evaluation. In the browser, the window and minimum slot width come from real Georgia widths, so the demo's circuit size can differ from these counts.

## Measured results

Counts are exact. µs figures are rough, because about a dozen other agents shared the machine. "One-hot ops" counts the live operations that build integer one-hots. "Estimate with an index read" replaces every one-hot group with a single operation, as if the executor could read a table at an integer wire. It is an estimate, not a circuit that was built.

### Fast path, widths 160..320 px (`report.ts fast`)

"Mismatches / widths" compares every output a formulation has, as listed in section 1. For pointer jumping, that is only lineCount and maxLineWidth.

| Segments | Formulation | Live ops | Layers | Stored weights | Gather table entries | One-hot ops | Estimate with an index read | Circuit µs | Mismatches / widths |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 63 | next-start table + sequential lines | 8,020 | 58 | 18,983 | 1,134 | 1,134 (14%) | 6,895 | 60 | 0 / 41 |
| 63 | gathered lines | 3,417 | 90 | 6,355 | 34,587 | 1,134 (33%) | 2,292 | 21 | 0 / 41 |
| 63 | gathered lines + per-segment line index and x | 4,677 | 90 | 10,259 | 34,587 | 1,134 (24%) | - | 29 | 0 / 41 |
| 63 | next-start table + segment scan | 8,420 | 276 | 21,812 | 0 | 0 | 8,420 | 75 | 0 / 41 |
| 63 | next-start table + pointer jumping | 18,311 | 70 | 39,173 | 10,468 | 10,468 (57%) | 8,037 | 116 | 0 / 41 |
| 63 | segment walker | 1,424 | 564 | 2,845 | 0 | 0 | 1,424 | 29 | 0 / 41 |
| 255 | next-start table + sequential lines | 51,902 | 186 | 118,310 | 18,870 | 18,870 (36%) | 33,069 | 359 | 0 / 41 |
| 255 | gathered lines | 28,582 | 337 | 55,159 | 603,840 | 18,870 (66%) | 9,749 | 170 | 0 / 41 |
| 255 | gathered lines + per-segment line index and x | 47,962 | 337 | 120,947 | 603,840 | 18,870 (39%) | - | 311 | 0 / 41 |
| 255 | next-start table + segment scan | 40,199 | 1,050 | 104,971 | 0 | 0 | 40,199 | 348 | 0 / 41 |
| 255 | next-start table + pointer jumping | 235,633 | 100 | 483,274 | 196,354 | 196,354 (83%) | 40,561 | 1,470 | 0 / 41 |
| 255 | segment walker | 5,836 | 2,292 | 11,669 | 0 | 0 | 5,836 | 132 | 0 / 41 |
| 1,023 | next-start table + sequential lines | 457,882 | 725 | 975,990 | 321,222 | 321,222 (70%) | 136,817 | 2,980 | 0 / 41 |
| 1,023 | gathered lines | 361,890 | 1,374 | 715,367 | 10,279,104 | 321,222 (89%) | 40,825 | 2,440 | 0 / 41 |
| 1,023 | next-start table + segment scan | 166,147 | 4,128 | 434,435 | 0 | 0 | 166,147 | 2,220 | 0 / 41 |
| 1,023 | segment walker | 23,496 | 9,204 | 46,989 | 0 | 0 | 23,496 | 1,650 | 0 / 41 |

For scale, pretext's `walkLineRanges` at 240 px took 0.42, 1.5 and 6.4 µs for 63, 255 and 1023 segments. Windows were 20, 21 and 21 segments, line slots were 9, 37 and 157 (the line count at 160 px), and the run limit was 1. Pointer jumping wasn't built at 1023 segments: its top level reads a window of about 21 × 64 positions for each of 1023 starts. Compiling gathered lines at 1023 segments took about 22 seconds. Every formulation except the segment walker spends about one operation per segment on `runOverflow`.

Beyond the report's 41 widths, `fast-walker.test.ts` checks all five formulations at 63 segments on 214 widths, and four of them plus the segment walker on a 77-segment paragraph with runs of 3 break-after segments. A scratch script (`check-fast-all-widths.ts` in the phase 2 scratchpad) ran the same comparison on all 1,281 widths from 160 to 320 px in 1/8 px steps: all five formulations at 63 and 255 segments, and the four other than pointer jumping at 1023 segments, with 0 mismatches.

Phase 1's formulations read fixed prepared tables. These formulations read runtime widths and break-after bits, and are still smaller: sequential lines went from 12,483 to 8,020 operations at 63 segments and from 673,367 to 457,882 at 1023, segment scan from 292,375 to 166,147 at 1023, and pointer jumping from 364,793 to 235,633 at 255. The savings come from the hat one-hot, the 4-operation comparison, and the differences shared by all starts.

### Feature ladder, rows circuit with per-line widths (`report.ts ladder`)

| Step | Segments | Cursor units | Candidates per row | Line slots | Live ops | Layers | Stored weights | Gather table entries | One-hot ops | Circuit µs | Mismatches, one width | Mismatches, per-line widths |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fast path | 63 | 63 | 8 | 11 | 2,480 | 91 | 4,383 | 24,948 | 1,386 (56%) | 20 | 0 / 321 | 0 / 200 |
| Hard-break chunks | 45 | 45 | 9 | 15 | 3,005 | 123 | 5,150 | 27,000 | 1,350 (45%) | 27 | 0 / 301 | 0 / 200 |
| Breakable long words | 18 | 118 | 32 | 43 | 25,762 | 347 | 44,123 | 669,768 | 10,148 (39%) | 215 | 0 / 371 | 0 / 200 |
| Soft hyphens | 35 | 35 | 7 | 13 | 2,059 | 107 | 3,502 | 14,560 | 910 (44%) | 18 | 0 / 421 | 0 / 200 |
| Letter spacing | 25 | 25 | 6 | 10 | 1,275 | 83 | 2,125 | 7,000 | 500 (39%) | 12 | 0 / 381 | 0 / 200 |
| Tabs in pre-wrap | 28 | 28 | 7 | 16 | 2,309 | 131 | 3,861 | 14,336 | 896 (39%) | 20 | 0 / 321 | 0 / 200 |
| All features together | 28 | 93 | 23 | 35 | 15,755 | 283 | 27,060 | 312,480 | 6,510 (41%) | 131 | 0 / 347 | 0 / 200 |

"One width" feeds the same width to every line slot and compares with `layoutNextLineRange` called repeatedly at that width. The report also checks that those lines equal `walkLineRanges`. "Per-line widths" gives every slot a random width in the step's range, and compares with sequential `layoutNextLineRange` calls. `rows.test.ts` checks the JavaScript rows for every step against both references, and the rows circuit for two steps. The rows are derived once per text; none of these checks edits segment widths.

### Flow around a rectangle, with word springs (`report.ts flow springs`)

| Words | Segments | Bands | Springs | Live ops | Layers | Stored weights | Gather table entries | One-hot ops | Circuit µs | Mismatches / states | Frames to settle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 48 | 95 | 18 | 0 | 12,129 | 211 | 27,869 | 114,570 | 3,420 (28%) | 83 | 0 / 200 | - |
| 48 | 95 | 18 | 96 | 14,760 | 215 | 32,819 | 114,570 | 3,420 (23%) | 97 | 0 / 10 | 51 |
| 96 | 191 | 32 | 0 | 34,433 | 367 | 84,289 | 427,840 | 12,224 (36%) | 252 | 0 / 200 | - |
| 96 | 191 | 32 | 192 | 39,512 | 371 | 93,847 | 427,840 | 12,224 (31%) | 308 | 0 / 10 | 52 |

A state is a random rectangle. The comparison covers every band's slot, line start and painted width, and every word's visibility, x and y; with springs, it also checks that every spring settles exactly onto its word's reference position. `flow.test.ts` also checks that the springs settle exactly on positions derived from `layoutWithLines` when the rectangle is outside the column.

Springs: the shared step matrix for 8 step bits (0..255 steps) is 208 live operations and 48 layers with one spring, and each further spring adds 25 operations. Over 5,000 random states and step counts, positions drifted at most 0.00022 px from float64 iteration. The settle snap then makes the rest positions exact.

## What this shows about how far the approach goes

### What fit well

- **The walker's decisions are comparisons.** On the fast path, every break decision compares a prefix difference with the line's width plus epsilon. Nonnegative widths make the bits monotone, so the first failing segment is a count, and the end, painted width and next start are sums gated by fit bits. No searching or branching is needed.
- **Runtime widths cost little.** Prefix sums, fit thresholds, painted prefixes and skip counts are computed in the circuit from width and break-after cells, in about 6 operations per segment plus a Brent-Kung network. `fast-walker.test.ts` edits word widths in the table and gets pretext's new lines without recompiling.
- **A width per line is natural.** Gathered lines compare each slot against its own width, and the slot comes from obstacle arithmetic in the same circuit: exact integer comparisons, a slot choice shared by all bands, and a gate that keeps the start for a band with no slot.
- **Per-word positions come from the same relus.** The line index is an affine sum over relus the one-hots already built, and x needs one product per segment and slot. Springs add 25 operations per word, with one shared matrix per frame.
- **Every pretext feature I tried fit one rows circuit, once JavaScript derived the rows.** Chunks, emergency breaks with preferred breaks, soft hyphens, letter spacing and tabs all became per-start candidate rows with monotone thresholds, so one circuit that compares stored thresholds with each line's width covers all of them. This says that pretext's walker has a shape the circuit can follow for per-line widths. It doesn't put those features' derivations in the circuit: that work lives in `rows.ts`, and only emergency breaks changed the circuit's size, by adding cursor units.
- **Exactness.** Line membership, slot choice and visibility are exact bits in every check. Positions are exact on the quarter-pixel grid, and springs drift at most 0.00022 px before snapping exactly onto their targets.

### What got awkward

- **Reading at a computed index dominates.** An integer one-hot costs 2 atoms per position, once per line slot. For 1023 segments, one-hots are 70% of sequential lines and 89% of gathered lines, and pointer jumping is 83% one-hots already at 255 segments. Replacing each group with one index read would take gathered lines at 1023 segments from 361,890 operations to an estimated 40,825. Gather lowering removes the masked products but leaves the one-hot, and every gathered read stores one candidate position per segment: 10.3 million table entries at 1023 segments.
- **Depth follows lines or segments.** At 1023 segments, sequential lines add about 4.6 layers per line (725 layers for 157 line slots) and gathered lines about 8.75 (1,374 layers), the segment scan adds about 4 per segment (4,128 layers), and the unrolled walker about 9 per segment (9,204 layers). Pointer jumping reaches 100 layers at 255 segments, but at 235,633 operations.
- **Bounds are fixed at compile time.** The window must cover the longest line from any start at the widest width, the line slot count must cover the narrowest width, and the run limit must cover the longest run of break-after segments. All three are output as overflow counts rather than handled. These outputs matter: without `runOverflow`, a paragraph with longer runs than the circuit was built for starts lines at the wrong segment and reports nothing.
- **Emergency breaks grow the one-hot.** Grapheme cursors turned 18 segments into 118 units, and the rows circuit for that step is ten times larger than for plain text.
- **The ladder's thresholds aren't runtime values.** Chunks, emergency breaks, soft hyphens, letter spacing and tabs take per-line widths, but any edit to the text, its widths, letter spacing or tab stops means running the JavaScript derivation again and rewriting the rows.
- **The admission merge depends on additive measurement.** With the fake canvas, a word's grapheme advances add up to its width, so "the whole word fits" and "every grapheme fits" are one candidate list. With kerning they differ, and would need a second list and a select.
- **Speed on the CPU executor.** Circuits run 50 to about 1,000 times slower than pretext's own walker. Pointer jumping at 255 segments is the slowest, about 1,000 times; every other formulation stays under 500 times. The demo's circuit (223 segments, 20 bands, springs) takes about 230 µs per evaluation with fake widths.
- **FP32 margins.** The comparisons are exact when the difference is at least about 1/128 px. Real canvas widths aren't quarter-pixel values, so a width within that margin of a threshold can break differently from pretext. The demo counts such mismatches instead of assuming there are none, with a 0.01 px tolerance on painted widths and x, so it counts different line breaks rather than differences in the last bits of positions.

### What stayed outside the circuit

- `prepare`: segmentation, break kinds, canvas measurement, grapheme advances, preferred breaks.
- The whole derivation of the ladder features, as JavaScript that restates the walker for every start position. The circuit only sees the resulting thresholds and outcomes. Most thresholds are prefix differences plus static corrections, so they could become runtime sums the way the fast path's are. Tab advances need a modulo of the line position, which wasn't built.
- Features not restated: Blink's return from an unfit soft hyphen, WebKit's no-break-before-NEL rule, entry geometry for default-ignorable code points, and rich inline items.
- Line text materialization, pointer rounding, the step count from the frame time, and the DOM projection.

## Open questions and next steps

- **An executor instruction that reads a table at an integer wire.** The estimates above suggest about 9x fewer operations for gathered lines at 1023 segments, and it would turn pointer jumping from quadratic into about N log N work. It needs its own exactness contract, for example a declared integer range and a clamp. Update, September 16, 2026: the repo root has had this instruction as `circuit.indexRead` since September 14, 2026 ([execution-model.md](../../../docs/execution-model.md#index-reads)), and index-read measured line recovery with it ([Merged from index-read](#merged-from-index-read-september-16-2026)). This folder's circuits haven't been rebuilt with it. Update, September 17, 2026: batch/'s index-read program rebuilds gathered lines with index reads for line counts, see [Many paragraphs on the GPU](#many-paragraphs-on-the-gpu-september-17-2026). At 517 segments and 83 line slots it has 27,634 live operations, against 113,802 with integer one-hots.
- **Static break kinds.** When kinds come from prepare instead of runtime cells, comparisons at break-after segments can be dropped, like the rows circuit's merged candidates (8 instead of 20 per line), and the run limit goes away.
- **Runtime thresholds for the ladder.** Letter spacing, soft hyphens and emergency breaks could use in-circuit prefix sums over grapheme advances, so edited widths work beyond the fast path. Tabs need a bounded modulo.
- **Blink's unfit-hyphen return and kerned admission.** Both need a second first-failure list per candidate, and a select between the lists.
- **Real browser widths.** How often does the demo's mismatch counter move with real Georgia widths, and would quantizing widths to 1/64 px at the table boundary remove those mismatches without visible change?
- **Generated JavaScript.** Phase 1 ran IndirectOS about 12 times faster as generated JS. The demo circuit would likely drop from about 230 µs to tens of µs.
- **Many paragraphs as instances.** Masonry cards or chat bubbles share one compiled circuit, with different widths in the table. That is the case a batched or GPU executor would parallelize. Update, September 17, 2026: [Many paragraphs on the GPU](#many-paragraphs-on-the-gpu-september-17-2026) builds one program per paragraph size for line counts, in three formulations, checks it against pretext's `layout()`, and measures it on the CPU, with an export for a GPU executor. Later the same day, [The GPU step](#the-gpu-step) ran the segment walker program on WebGPU in headless Chrome: it takes less time than pretext's `layout()` from about 160 to 170 long or 800 short paragraphs when only the width changes, and from about 1,100 to 1,400 long or 8,200 to 8,700 short paragraphs when the texts change, see [The crossover](#the-crossover).
- **Joining IndirectOS.** A Notes window whose text flows around the other windows, with word springs, in the same circuit as window focus and dragging.

## Merged from index-read, September 16, 2026

[index-read](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/index-read) recovered line starts from a next-start table with an index read instruction, which copies `candidates[floor(index)]` in 1 operation, in a copy of the runtime. The repo root took the instruction on September 14, 2026 as `circuit.indexRead` ([execution-model.md](../../../docs/execution-model.md#index-reads)). index-read's next-start table was phase 1's, 23 rounding comparisons per start over pretext's fast path at widths from 160 to 320 px, not this folder's `fast-walker.ts`, and it read prepared segment widths from a fixture instead of importing pretext. These are its measurements from September 13, 2026. lineCount and maxLineWidth matched pretext at 321, 81 and 21 widths for 63, 255 and 1,023 segments, the walk's line starts and widths matched at 162, 82 and 22 widths, and every compiled program matched the reference evaluator on every live wire.

- **Walking one line slot at a time.** At 1,023 segments with 157 line slots, the table alone was 190,279 operations, 7 layers and 401,016 stored weights. Reading nextStart and lineWidth at each line's start cost 1,409 more operations, about 9 per line slot, in 490 layers with index reads, against 483,399 more in 850 layers with a ReLU one-hot and gather lowering, and 803,598 more in 957 layers dense. Building the walk took 131 ms with the instruction and 776 ms with the one-hot. pretext's own `walkLineRanges` took about 5.6 µs on that paragraph (phase 1's measurement).
- **Pointer jumping.** `jump[m + 1][s] = jump[m][jump[m][s]]` over windows, then binary lifting from the first segment, gave lineCount and maxLineWidth in 35,914 operations beyond the table and 66 layers at 1,023 segments, 18% more operations than the walk for the whole circuit. Phase 1 had estimated pointer jumping with one-hots at 7 to 10 million atoms. It first stored 1,854,682 table entries, because every window that reached the end of the text included the past-the-end entry as a constant. Dropping that entry and clamping the index to the last segment, whose next start already is the end, brought it to 0.
- **Depth after lowering.** A lowered read keeps the depth of the products it replaced, unless the compiler recomputes each operation's depth from what it reads after lowering. For the walk at 1,023 segments, recomputing took the circuit of index-read's recognition pass, which computes a ReLU one-hot's position from its index wire, from 744 to 490 layers, but the shared runtime's gather lowering only from 850 to 801, because that circuit still builds its one-hots before the reads. The repo root has this as `{recomputeDepths: true}`, off by default.
- **Still open.** An index read removes width from a walk, not depth: about 3 layers per line. Is there a formulation of line recovery with O(segments) work and O(log segments) depth?

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/text-walker/demo.html`.

- The page loads with no console errors or warnings. With real Georgia widths, the circuit has 223 segments, 112 words, 904 source cells, 34,132 live operations (8,920 of them in integer one-hots), 239 layers and 77,799 stored weights. The panel showed a compile time of 2,350 ms.
- Dragging the window's title bar reflows the lines around the window. Clicking a word makes it bold and the paragraph breaks again. The column width slider narrows and widens the paragraph. Words spring to their new places.
- Mismatch counter: 0 mismatches over 236 states checked against pretext. 6 states came from real drags, clicks and slider moves. The other 230 came from a script that set random column widths between 280 and 600 px and toggled bold on random words, with 36 words bold at the end.
- The panel's median evaluation time was 4,700 µs right after load, then between 600 and 1,600 µs. Headless runs in Bun with fake widths measured about 230 µs. Other agents were using the machine during both measurements. Chrome gives this page `performance.now()` in steps of 0.1 ms, so the panel's median is always a multiple of 100 µs.
- Small problem in the first check: dragging the title bar selected the "Drag me" text, because the title bar didn't set `user-select: none`.
- Fixed later in `demo.css`: `.window .title` now sets `user-select: none`. `bun test lab/ui-exploration/text-walker` (18 tests) and `bunx tsgo -p lab/ui-exploration/text-walker` pass.
- Recheck in Chrome: a real mouse drag from the "Drag me" label moved the window, e.g. from (206, 197) to (130, 306) in viewport px, the paragraph reflowed around it, and no text was selected afterwards (`getSelection().type` was "None"). No errors.

## Many paragraphs on the GPU, September 17, 2026

### Why

Cheng asked: "technically our pretext layout, if there's lots of them, is faster than the regular cpu's, then?" So far the answer is a prediction. For one paragraph the GPU should lose: pretext's `layout()` is a few float64 additions and comparisons per segment, and stops at the end of the text, while a program pays for every line slot and every window position, and a WebGPU round trip took about 0.3 to 0.7 ms through Dawn in earlier runs on this machine. Many paragraphs in one dispatch should win past some count, predicted somewhere in the hundreds to thousands. Cheng approved measuring it: "yes to both", together with a Knuth-Plass experiment that isn't part of this section.

The first half of this section is the CPU half: one per-paragraph program for pretext's greedy line breaking, checked against `layout()`, its CPU numbers, and an export for the GPU step. The second half, from [The GPU step](#the-gpu-step), runs that program over up to 100,000 paragraphs in one WebGPU compute pass in headless Chrome, and finds the paragraph count from which the GPU takes less time than pretext.

### What was built

| File | What it holds |
| --- | --- |
| `batch/paragraphs.ts` | Generated paragraphs, measured by npm `@chenglou/pretext` with this folder's fake canvas, the walker's cells for each paragraph, and the programs' capacities |
| `batch/programs.ts` | The per-paragraph program in three formulations, and the functions that write a paragraph's cells |
| `batch/instances.ts` | Runs a program over many paragraphs at once through codegen's instance path: generated JavaScript, or the batched executor |
| `batch/batch.test.ts` | 8 tests against pretext's `layout()` |
| `batch/report.ts` | Program sizes, the sweep against pretext over every paragraph and width, and the summary of the timing processes |
| `batch/cpu-time.ts` | CPU timings, one process per variant |
| `batch/export.ts` | Writes the compiled program, the cells of N paragraphs, and pretext's line counts, for the GPU step |
| `batch/results/` | `sizes.json`, `sweep.json`, one JSON line per timing process, and the GPU step's raw results |
| `batch/gpu/` | The GPU step, see [The GPU step](#the-gpu-step) |

**The paragraphs.** Word soup from the same word list as `makeParagraph`, with some hyphenated words, e.g. "state-of-the-art", which pretext splits into text segments that a line can break between, and some zero-width spaces, e.g. `" ​​"`, a space and two zero-width spaces, is a run of 3 break-after segments. Short paragraphs have 14 to 26 words, and long ones 170 to 230. Every paragraph is on pretext's fast path, and at 16 px the fake canvas measures every segment in multiples of 1/4 px, so prefix sums are exact in FP32. The reference is npm `@chenglou/pretext` 0.0.9, the package Notes uses, and not this folder's `pretext-src/` copy: `layout(prepared, maxWidth, lineHeight).lineCount`, with pretext's non-Safari line fit epsilon of 0.005 px.

**The program.** One compiled program serves every paragraph of a size. Its cells, after the unit cell, are `maxWidth`, `startCursor`, K segment widths and K break-after bits. A paragraph of n segments is written at the end of the K cells, after zero-width text, with `startCursor = K - n`. For example, a 39-segment paragraph in a 68-segment program starts at cell 29. The walkers with line slots start the first line at `startCursor`, so they never read the padding, and the segment walker starts at segment 0, where the padding adds 0 px to the first line. The width is a cell too, so each paragraph of a batch can have its own width.

Three formulations, all over the tables of `createFastCircuit` in fast-walker.ts (prefix sums, fit thresholds, how many break-after segments a line start skips):

- **One-hot**: `walkGatheredLines` without obstacles, the walker IndirectOS's Notes flow uses. Each line slot builds an integer one-hot of its start, about 2 operations per segment cell, reads the tables at that start through masked sums that the compiler lowers to gathers, and compares the window's thresholds with the width.
- **Index read**: the same walk, where each line slot reads its start's tables with `circuit.indexRead`, 1 operation per read, instead of a one-hot and masked sums. This rebuilds gathered lines with the instruction that "Open questions and next steps" above asked about. In JavaScript terms, `startPrefix = prefix[start]` and `fits[o] = threshold[start + o] - startPrefix <= maxWidth + epsilon`. Every position past the end of the text reads the paragraph's whole width plus 8,192 px as its threshold, so nothing fits there, and a start at the end of the text reads +0 as its prefix and stays at the end.
- **Segment walker**: `buildSegmentWalker`, pretext's walker unrolled one segment at a time. It has no line slots, no window and no run limit, so none of them can be too small, and its depth grows with the segment count.

The walkers with line slots output `lineCount`, `moreLinesThanSlots` (1 when text is left after the last line slot), `windowOverflow` and `runOverflow` (nonzero when the window or the run limit was too small for the text). The segment walker outputs only `lineCount`.

**Capacities.** For widths from 160 to 480 px, each capacity is the largest need over the first 65,536 paragraphs of each size, seeds 0 to 65,535 (`batchCapacities`):

| Size | Segments | Line slots (lines at 160 px) | Window (segments compared after a line start, at 480 px) | Run limit |
| --- | --- | --- | --- | --- |
| short | 68 | 12 | 38 | 3 |
| long | 517 | 83 | 39 | 3 |

The largest needs are rare: among the 65,536 long paragraphs, 1 needs a window of 39, 2 need 38 and 12 need 37, and 5 need 83 line slots. Among the short ones, 1 needs a window of 38, 2 need 35 and 12 need 34. The widest segment is 71.75 px, narrower than 160 px, so no line breaks inside a segment. `assertFits` checks every paragraph of a timing, a sweep or an export against its capacity, and the overflow outputs report a paragraph that doesn't fit, e.g. `batch.test.ts` builds programs with one line slot too few, a window of 6 and a run limit of 1.

### Correctness checks

`bun test lab/ui-exploration/text-walker/batch` runs 10 tests in about 2 s, 2 of them in `gpu/` (see [GPU correctness checks](#gpu-correctness-checks)), and these 8:

- All three formulations give pretext's line count, with every overflow output at 0, for 32 short paragraphs at 61 widths: 160 to 480 px in 16 px steps, each also 1/8 and 1/4 px wider, so some spans equal the width exactly. The index-read program and the segment walker do the same for 4 long paragraphs.
- The index-read program and the segment walker give pretext's line count for 4 short paragraphs at every 1/64 px from 256 to 290 px, and both give 3 lines at 272.99501 px, off that grid, where pretext gives 2, see "Which widths give exact line counts" below.
- codegen's generated JavaScript and batched executor run the one-hot program and the segment walker over 96 short paragraphs, each at its own width, and give pretext's line counts. `createBatchInstanceRunner` refuses the index-read program.
- The reference evaluator, for the one-hot and index-read programs at the short capacity and the index-read program at the long capacity: every declared one-hot group and every integer index holds (`validateOneHotGroups`, `validateIndexReads`), and the reference's and the executor's line counts equal pretext's.
- One line slot too few gives `moreLinesThanSlots` 1 and a line count of the slot count, a window of 6 segments gives a nonzero `windowOverflow` at 480 px, and a run limit of 1 gives a nonzero `runOverflow` for a paragraph with a run of 3 break-after segments.
- A one-segment paragraph, and a paragraph that fills every segment cell, so `startCursor` is 0.
- The exported program survives `JSON.stringify` with its shared tables.

`bun lab/ui-exploration/text-walker/batch/report.ts sweep` compared line counts with `layout()` for the first 1,024 paragraphs of each size at 385 widths: every whole pixel from 160 to 480 px, and 64 widths on the 1/8 px grid. For every paragraph at every width, generated JavaScript ran the one-hot program and the segment walker, and the executor ran the index-read program. The executor and the batched executor ran the one-hot program and the segment walker for the first 64 paragraphs.

| Size | Formulation | Backend | Paragraphs × widths | Checks | Line count mismatches | Nonzero overflow outputs |
| --- | --- | --- | --- | --- | --- | --- |
| short | one-hot | generated JavaScript | 1,024 × 385 | 394,240 | 0 | 0 |
| short | one-hot | executor, batched executor | 64 × 385 each | 49,280 | 0 | 0 |
| short | index read | executor | 1,024 × 385 | 394,240 | 0 | 0 |
| short | segment walker | generated JavaScript | 1,024 × 385 | 394,240 | 0 | 0 |
| short | segment walker | executor, batched executor | 64 × 385 each | 49,280 | 0 | 0 |
| long | one-hot | generated JavaScript | 1,024 × 385 | 394,240 | 0 | 0 |
| long | one-hot | executor, batched executor | 64 × 385 each | 49,280 | 0 | 0 |
| long | index read | executor | 1,024 × 385 | 394,240 | 0 | 0 |
| long | segment walker | generated JavaScript | 1,024 × 385 | 394,240 | 0 | 0 |
| long | segment walker | executor, batched executor | 64 × 385 each | 49,280 | 0 | 0 |

The sweep's texts exercise how a line start skips break-after segments. At these widths, pretext laid out 1,500,260 lines for the short paragraphs and 13,563,145 for the long ones. Of the lines after each paragraph's first, 69,594 short and 781,441 long lines start right after a text segment, e.g. after a hyphen, 1,005,402 and 12,017,584 after 1 break-after segment, 21,123 and 246,238 after a run of 2, and 9,901 and 123,642 after a run of 3. `sweep.json` holds every record, with the load average during the sweep, 4.7 to 12.2.

**Which widths give exact line counts.** The width is a float32 cell, while pretext compares in float64. Every width on the 1/64 px grid, like CSS layout widths, is exact in float32, and gives pretext's line counts: e.g. for 4 short paragraphs at every 1/64 px from 256 to 290 px, the index-read program and the segment walker made 17,416 checks with 0 mismatches. A width off that grid, within float32 rounding of pretext's fit limit, span ≤ width + 0.005 px, can give one more line than pretext. For example, at a width of 272.99501 px, pretext's limit is 273.00001 px in float64, so a 273 px span fits and pretext gives 2 lines, but the float32 cell holds 272.9949951 px, the span doesn't fit, and the program gives 3. A review probe over 16 short and 4 long paragraphs, at widths k/4 - d px from 160 to 480 px, found mismatches only for d = 0.00499 (25 short and 30 long) and d = 0.005 (59 and 74), the same on the executor and on codegen's WGSL interpreter with and without the guard, and none for d = -0.0001, 0.0001, 0.004 to 0.00495, or 0.00501 to 0.0051. The sweep, the tests and the GPU checks use widths on the 1/8 px grid. A page that passes zoomed or transformed widths could round them to the 1/64 px grid first. `batch.test.ts` checks both the 1/64 px widths and the 272.99501 px example.

### Sizes (`report.ts sizes`)

| Size | Formulation | Live ops | Layers | Stored weights | Gather reads | Gather table entries | One-hot ops | Index reads | Stored index positions | Build ms | Compile ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short | one-hot | 5,517 | 110 | 10,863 | 924 | 62,832 | 1,632 | 0 | 0 | 92 | 57 |
| short | index read | 3,846 | 86 | 8,023 | 0 | 0 | 0 | 924 | 274 | 7 | 7 |
| short | segment walker | 1,064 | 605 | 2,126 | 0 | 0 | 0 | 0 | 0 | 7 | 3 |
| long | one-hot | 113,802 | 684 | 226,755 | 6,557 | 3,389,969 | 85,822 | 0 | 0 | 5,631 | 2,841 |
| long | index read | 27,634 | 518 | 58,009 | 0 | 0 | 0 | 6,557 | 2,070 | 30 | 54 |
| long | segment walker | 8,244 | 4,646 | 16,486 | 0 | 0 | 0 | 0 | 0 | 68 | 54 |

- At 517 segments, 75% of the one-hot program's operations build integer one-hots, 83 line slots × about 1,034 operations, and its gathers store 3.39 million candidate positions. The index-read program has 4.1 times fewer operations and stores 2,070 positions, because every line slot reads the same 4 tables.
- Each line slot of the long index-read program adds 277 operations and 6 layers, from building it with 82 and 83 line slots. The slot's 79 index reads are the start's prefix, the start's next line head, 39 thresholds, each compared with the width in 4 operations, and 38 skip counts, each multiplied with its comparison. The last window position only reports a window too small, so it reads no skip count.
- The segment walker is about 16 operations per segment cell, and has 9 layers per segment.
- Build ms for the segment walker includes a first compile of every output `buildSegmentWalker` has, e.g. each segment's x. Compile ms is `compile()` from kit.ts, which compiles twice, once for the sizes and once inside `createTensorEvaluator`.
- Every operation of these programs reads a paragraph's cells, so codegen's instance plan shares almost nothing: 5,515 of the short one-hot program's 5,517 rows, and 8,243 of the long segment walker's 8,244, run once per paragraph.

### CPU timings (`cpu-time.ts`)

Measured on September 17, 2026, on an Apple M5 Max with 18 cores and 36 GiB, macOS 27.0, and Bun 1.4.0. Other agents' processes ran throughout, e.g. another project's `bun test` workers and a headless Chrome, and the 1-minute load average before and after each timing process was between 2.2 and 7.6. Swap in use on the machine was 8.8 of 10.2 GB.

Method:

- `cpu-time.ts all` runs each variant in its own process, 3 processes per variant. Each process generates its paragraphs, builds its program, writes every paragraph's cells, and checks every line count against `layout()`, and every overflow output at 0, before and after timing.
- A run lays out every paragraph at 320 px. Each process warms up for 1 s and at least 3 runs, or 120 s for generated JavaScript, then takes 7 samples of at least 300 ms of whole runs, and keeps their median. The table shows the median of the 3 processes' medians, and their range.
- The executor figures include `createTensorEvaluator`'s check of every source cell against its declared range, 2 × segments + 3 cells per call. Generated JavaScript and the batched executor run blocks of 1,024 paragraphs, or 128 for the long one-hot program, which has 114,836 values per paragraph.

µs per paragraph, at 320 px:

| Variant | Short, 1,024 paragraphs | Short, 16,384 | Long, 1,024 | Long, 16,384 |
| --- | --- | --- | --- | --- |
| pretext `layout()` | 0.262 (0.260 to 0.278) | 0.359 (0.354 to 0.441) | 2.52 (2.51 to 2.54) | 2.65 (2.65 to 2.67) |
| writing the cells | 0.0785 (0.0760 to 0.0814) | 0.111 (0.111 to 0.114) | 0.481 (0.472 to 0.534) | 0.834 (0.719 to 0.840) |
| executor, one-hot | 29.9 (29.8 to 29.9) | | 683 (668 to 731) | |
| executor, index read | 25.1 (24.9 to 29.4) | 24.2 (23.9 to 26.3) | 198 (196 to 199) | 194 (191 to 198) |
| executor, segment walker | 28.9 (25.9 to 30.2) | | 216 (212 to 217) | |
| generated JavaScript, one-hot | 3.67 (3.57 to 3.68) | | 186 (186 to 187) | |
| generated JavaScript, segment walker | 1.33 (1.29 to 1.77) | 1.31 (1.30 to 1.31) | 10.5 (10.5 to 10.6) | 10.8 (10.8 to 11.8) |
| batched executor, one-hot | 344 (342 to 345) | | 6,824 (6,786 to 6,881) | |
| batched executor, segment walker | 56.1 (55.8 to 65.7) | | 409 (406 to 412) | |

- pretext's `layout()` is the fastest variant at both sizes. A long paragraph has about 31 lines at 320 px, and `layout()` takes 2.52 µs for one.
- At 1,024 paragraphs, the executor takes 79 to 271 times as long as pretext for long paragraphs, and 96 to 114 times for short ones. Generated JavaScript for the segment walker takes 4.2 times as long for long paragraphs, and 5.1 times for short ones.
- The executor pays per layer as well as per operation: the long segment walker has 3.4 times fewer operations than the long index-read program, but 9 times as many layers, and takes 9% longer, 216 against 198 µs.
- The batched executor is slower than the executor for these programs, e.g. 409 against 216 µs for the long segment walker, and 6,824 against 683 µs for the long one-hot program. codegen's README found that the batched executor beats generated JavaScript only for programs with few rows.
- From 1,024 to 16,384 paragraphs, pretext takes 5% to 37% longer per paragraph, and writing the cells 41% to 73% longer, while the programs stay within 4%.
- Generated JavaScript needed the long warmup. JavaScriptCore optimizes a generated function after enough calls, and a run calls each function once per block. With 1 s of warmup, the long one-hot program took 2,762 µs per paragraph, against 186 µs after 120 s and 228 to 240 runs, the long segment walker 21.1 against 10.5 µs, and the short one-hot program 8.83 against 3.67 µs, while the short segment walker didn't change, 1.30 against 1.33 µs. `cpu-time-1.jsonl` and `cpu-time-2.jsonl` hold the runs with 1 s of warmup, and `cpu-time-3.jsonl` and `cpu-time-4.jsonl` the reruns with 120 s.
- The long one-hot program's generated JavaScript processes reached 11.4 to 12.9 GB of RSS, for 9.97 MB of generated source.

What these numbers say about the GPU step, as arithmetic rather than measurements, before [GPU timings](#gpu-timings) measured it:

- To win, one GPU evaluation of N paragraphs, from the upload to the readback, must take less than pretext's N × µs per paragraph: 2.6 ms for 1,024 long paragraphs and 43 ms for 16,384, or 0.27 ms for 1,024 short paragraphs and 5.9 ms for 16,384.
- A WebGPU round trip took about 0.3 to 0.7 ms through Dawn in earlier runs on this machine, and pretext lays out about 120 to 280 long paragraphs, or about 1,100 to 2,700 short ones, in that time. So on this machine the crossover should lie above those counts, since the program's own work on the GPU comes on top of the round trip.
- What JavaScript sends per evaluation matters, as regex-search's uploads showed. A long paragraph's cells are 1,036 float32 values, 4.1 KB, so 16,384 paragraphs are 68 MB. When only the width changes, e.g. on a resize, 1 cell per paragraph changes, and the segment cells can stay on the GPU.
- The segment walker is 8,244 operations and 16,486 stored weights per long paragraph, with no reads at a computed index, but 4,646 layers. So it fits a shader that runs every operation of one paragraph in one invocation, like codegen's WGSL executor, and not one dispatch per layer. The index-read program has 9 times fewer layers, 518, but 27,634 operations with 6,557 index reads, which codegen's WGSL emitter doesn't take.

### Export for the GPU step

`bun lab/ui-exploration/text-walker/batch/export.ts <folder> --size long --count 4096 --formulation index-read --widths 160,320,480` writes:

- `manifest.json`: the options, the capacity, the cell layout, the output names and roots, and the program's sizes
- `program.json`: the compiled `TensorProgram`, with every typed array stored once in a list of tables, see `serializeTensorProgram` and `deserializeTensorProgram`
- `instance-cells.f32`: count × (2 × segments + 2) float32 cells, one row per paragraph, with `maxWidth` set to the first width
- `expected-line-counts.i32`: pretext's line count of each paragraph at each width, one row per paragraph
- `texts.json`: the paragraph texts

Before writing, the export checks that the program gives pretext's line counts for the first 16 paragraphs at every width. In code, `exportBatch` returns the same things. For 256 long paragraphs with the index-read program, `program.json` is 2.4 MB and `instance-cells.f32` 1.06 MB.

### The GPU step

`batch/gpu/` runs the segment walker program over N paragraphs in one compute pass, with codegen's WGSL executor, `emitInstanceWgsl` in [codegen/wgsl.ts](../codegen/wgsl.ts): one invocation per paragraph runs every operation of that paragraph, one statement per operation, and writes the paragraph's line count into an output buffer, which the host reads back.

| File | What it holds |
| --- | --- |
| `batch/gpu/shaders.ts` | The shaders: codegen's instance plan and WGSL for the segment walker in two plans, and the files of Bun's line counts and cell hashes that the page compares with its own |
| `batch/gpu/cells.ts` | The cells of the shared-width plan, and the hash of cells |
| `batch/gpu/host.ts` | The host loop: buffers, one dispatch, readback, timestamp queries, and an evaluation's time split into parts |
| `batch/gpu/page.html`, `batch/gpu/page.ts` | The page: paragraphs prepared with pretext in Chrome, pretext's `layout()` in Chrome, the GPU timings and the checks |
| `batch/gpu/run.ts` | Serves the page, runs a fresh headless Chrome through the DevTools Protocol with a hard timeout, and writes what the page posts |
| `batch/gpu/summarize.ts` | The tables below, from the raw results |
| `batch/gpu/gpu.test.ts` | Both plans with both guards through codegen's strict WGSL interpreter, against pretext |

```sh
bun test lab/ui-exploration/text-walker/batch/gpu
bun lab/ui-exploration/text-walker/batch/gpu/shaders.ts expected <folder> --counts 1,10,100,300,1000,3000,10000,30000,100000
bun lab/ui-exploration/text-walker/batch/gpu/run.ts --mode main --profile <new folder> --expected <folder> --out <file.json> --counts 1,10,100,300,1000,3000,10000,30000,100000
bun lab/ui-exploration/text-walker/batch/gpu/run.ts --mode check --profile <new folder> --out <file.json>
bun lab/ui-exploration/text-walker/batch/gpu/run.ts --mode sweep --profile <new folder> --expected <folder> --out <file.json> --counts 1000,10000,100000
```

**Why the segment walker.** codegen's instance path doesn't take index reads, and its WGSL emitter writes each gather as a `switch` statement over its candidates, so the short one-hot program becomes 70,361 statements and 4.6 MB of WGSL, and the long one would have 6,557 switch statements of 517 cases. The segment walker has neither, so its shader is one `let` per operation: 1,202 statements and 67 KB for short paragraphs, 9,280 statements and 531 KB for long ones (`shaders.ts sizes`, results/gpu-shader-sizes.json). Its 4,646 layers don't cost a dispatch each, since one invocation runs the operations one after another.

**Two plans of the same program.** codegen's `planInstances` takes the cells that differ per paragraph:

- **Own width**: every cell of the export, i.e. maxWidth, startCursor, K widths and K break-after bits: 138 float32 values per short paragraph and 1,036, 4.1 KB, per long one. A new text or a new width means JavaScript writes every paragraph's cells and uploads them all.
- **Shared width**: maxWidth is one shared value, and a paragraph's cells are the other 137 or 1,035. The cells are uploaded once, and a new width for every paragraph, e.g. on a resize, writes one float32 value into the shared buffer. No shared value other than maxWidth depends on the width, which `buildBatchShader` checks.

**Guards.** codegen's `max` guard wraps every inexact product and every partial sum in `max(x, lowest)`, so Metal's compiler can't fuse or regroup across it: 1,264 guards in the short shader and 9,791 in the long one. The `none` guard writes the same statements without them. Both were checked and timed.

**The page's paragraphs.** The page prepares its paragraphs with pretext in Chrome, as a page would, and replaces Chrome's `OffscreenCanvas` with the fake canvas before the first prepare call. Before timing, it checks that its line counts at 320 and 400 px equal Bun's for all 100,000 paragraphs of each size, and that a hash of its cells equals Bun's at every count, from `shaders.ts expected`. Paragraph i has seed i mod 65,536 (`timingParagraphs`), the seeds the capacities cover, so 100,000 paragraphs repeat seeds 0 to 34,463. Among seeds 65,536 to 99,999, one long paragraph needs 85 line slots, more than the index-read program has.

### GPU correctness checks

`run.ts --mode check` compared the GPU's line counts with pretext's `layout()` in the page, for the first 65,536 paragraphs of each size and the sweep's 385 widths, with both shaders and both guards:

| Size | Guard | Own width, each paragraph at its own width | Own width, the first 1,024 paragraphs at every width | Shared width, every paragraph at every width | Mismatches |
| --- | --- | --- | --- | --- | --- |
| short | max | 65,536 | 394,240 | 25,231,360 | 0 |
| short | none | 65,536 | 394,240 | 25,231,360 | 0 |
| long | max | 65,536 | 394,240 | 25,231,360 | 0 |
| long | none | 65,536 | 394,240 | 25,231,360 | 0 |

That's 102,764,544 line counts with 0 mismatches, including the shaders without the guard, so on this machine Metal's fusing and regrouping didn't change a line count of these paragraphs. The GPU timings below compared every readback with pretext too, and `gpu.test.ts` runs both plans with both guards through codegen's WGSL interpreter, for 12 short and 2 long paragraphs at 5 widths.

### GPU timings

Measured on September 17, 2026, on the same machine as the CPU timings above, with Bun 1.4.0 and headless Chrome 153.0.8010.48 through Metal, with timestamp queries. The page is cross-origin isolated, so `performance.now()` reads in steps of 5 µs. Other processes ran throughout: another Chrome with a busy tab, whose renderer used 50% to 99% of a core and whose GPU process about 48%, a WebKit content process using a whole core during part of the CPU timings, and other agents. The 1-minute load average before and after each GPU run was 3.2 to 3.7, and before and after each CPU timing process 2.6 to 8.4.

Method:

- GPU: `run.ts --mode main`, 3 runs, each in a new Chrome process with a new shader salt, so every shader compiles cold. For each count, at least 1 s and 3 evaluations of warmup, then at least 15 samples and 3 s, at most 300 samples, keeping the median. The tables show the median of the 3 runs' medians, and `summarize.ts` also prints their ranges. Raw results: results/gpu-main-1.json to gpu-main-3.json.
- Consecutive evaluations alternate between 320 and 400 px, so every evaluation has new input, and every readback was compared with pretext's line counts at its width: 10,688,998,499 line counts in the 3 runs, 0 mismatches.
- **New cells**, with the own-width shader: JavaScript writes every paragraph's cells at the new width, then the upload, one dispatch, a copy into the readback buffer, `mapAsync`, and copying the line counts out. The "GPU part" leaves out writing the cells. **New width**, with the shared-width shader: the cells were uploaded before timing, and an evaluation writes one float32 value, dispatches and reads back. The compute pass comes from timestamp queries, in their own samples.
- CPU in Bun: `cpu-time.ts all --counts ...`, 3 processes per variant and count, with the method of the CPU timings above, and 60 s of warmup for short and 120 s for long generated JavaScript. Records: results/cpu-time-5.jsonl to cpu-time-7.jsonl. CPU in Chrome: the same loop in the page, once per run, with 1 s of warmup and 7 samples of at least 300 ms each.
- Paragraphs past 65,535 repeat earlier seeds, see [The GPU step](#the-gpu-step).

ms for one evaluation of every paragraph, with the max guard. The CPU columns are µs per paragraph × paragraphs. Generated JavaScript and the executor were timed only at 1, 100, 1,000, 10,000 and 100,000 paragraphs.

Short paragraphs, 1,202 shader statements:

| Paragraphs | pretext in Bun | pretext in Chrome | Generated JavaScript, segment walker, Bun | Executor, index read, Bun | GPU, new cells | GPU part of new cells | GPU, new width |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.0002 | 0.0002 | 0.0025 | 0.024 | 0.24 | 0.24 | 0.26 |
| 10 | 0.0022 | 0.0018 | | | 0.20 | 0.20 | 0.22 |
| 100 | 0.024 | 0.022 | 0.11 | 2.41 | 0.31 | 0.30 | 0.21 |
| 300 | 0.075 | 0.073 | | | 0.30 | 0.27 | 0.21 |
| 1,000 | 0.26 | 0.26 | 1.29 | 24.1 | 0.53 | 0.40 | 0.21 |
| 3,000 | 0.80 | 0.82 | | | 1.07 | 0.73 | 0.21 |
| 10,000 | 2.89 | 2.92 | 13.3 | 241 | 2.84 | 1.21 | 0.23 |
| 30,000 | 11.9 | 10.6 | | | 9.66 | 2.45 | 0.24 |
| 100,000 | 54.2 | 40.1 | 130 | 2,426 | 31.5 | 6.44 | 0.39 |

Long paragraphs, 9,280 shader statements:

| Paragraphs | pretext in Bun | pretext in Chrome | Generated JavaScript, segment walker, Bun | Executor, index read, Bun | GPU, new cells | GPU part of new cells | GPU, new width |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.0020 | 0.0020 | 0.021 | 0.19 | 0.40 | 0.40 | 0.39 |
| 10 | 0.022 | 0.022 | | | 0.42 | 0.41 | 0.45 |
| 100 | 0.23 | 0.26 | 0.93 | 19.4 | 0.57 | 0.50 | 0.41 |
| 300 | 0.72 | 0.80 | | | 1.05 | 0.79 | 0.42 |
| 1,000 | 2.44 | 2.78 | 11.7 | 197 | 3.02 | 2.21 | 0.42 |
| 3,000 | 7.51 | 8.54 | | | 5.07 | 2.28 | 0.44 |
| 10,000 | 26.1 | 29.8 | 109 | 1,953 | 17.0 | 6.05 | 0.70 |
| 30,000 | 81.8 | 92.3 | | | 48.8 | 16.1 | 1.44 |
| 100,000 | 287 | 327 | 1,086 | 20,218 | 158 | 47.8 | 3.88 |

- pretext takes longer per paragraph as the count grows, e.g. in Bun 0.20 µs per short paragraph at 1 paragraph and 0.54 µs at 100,000, and 1.96 against 2.87 µs per long paragraph. Chrome ran pretext at about the same speed as Bun for short paragraphs up to 10,000, and faster from 30,000, e.g. 40.1 against 54.2 ms at 100,000. For long paragraphs Chrome took 10% to 14% longer from 100 paragraphs.
- The executor takes 24 µs per short paragraph and 194 to 213 µs per long one at every count, for both formulations. Generated JavaScript takes 1.1 to 1.3 µs per short and 9.3 to 11.7 µs per long paragraph from 100 paragraphs, and about twice that at 1 paragraph, since a run over one paragraph still calls every generated function once. Its processes for 100,000 long paragraphs reached 10.1 to 11.3 GB of RSS.
- The page's 100,000 long prepared paragraphs took 16.0 s to prepare and 4,046 MB of JavaScript heap.

### The crossover

The first measured count from which the GPU takes less time than the CPU variant, at that count and every larger measured count, from the medians of the 3 runs, with the max guard. "About" interpolates linearly between that count and the measured count below it.

| Size | GPU evaluation | Against pretext in Bun | Against pretext in Chrome | Against generated JavaScript in Bun |
| --- | --- | --- | --- | --- |
| short | new width, cells on the GPU | from 1,000, about 800 | from 1,000, about 810 | from 1,000, about 170 |
| short | new cells, including writing them | from 10,000, about 8,700 | from 10,000, about 8,200 | from 1,000, about 280 |
| short | GPU part of new cells | from 3,000, about 2,300 | from 3,000, about 2,200 | from 1,000, about 250 |
| long | new width, cells on the GPU | from 300, about 170 | from 300, about 160 | from 100, about 42 |
| long | new cells, including writing them | from 3,000, about 1,400 | from 3,000, about 1,100 | from 100, about 51 |
| long | GPU part of new cells | from 1,000, about 460 | from 300, about 290 | from 100, about 47 |

- Each run on its own gives the same measured count, with these exceptions. Run 1: short new cells from 30,000, about 10,100 against Bun and 10,300 against Chrome, since at 10,000 paragraphs it took 2.91 ms against 2.89 and 2.88 ms. Run 2: short new width from 3,000, about 1,000; long new cells no crossover against pretext up to 100,000, see below, and against generated JavaScript from 1,000, about 102; the long GPU part from 3,000 against Bun and from 1,000 against Chrome.
- Without the guard, the new width crosses a little earlier: about 680 short and 140 long paragraphs against Bun. The other crossovers without the guard stay at the same measured counts, except the long GPU part against Chrome, from 1,000, about 480, where one run's 300-paragraph median was 1.09 ms.
- The executor was measured at 1, 100, 1,000, 10,000 and 100,000 paragraphs, and every GPU evaluation takes less time from 100 paragraphs, e.g. 0.41 against 19.4 ms for 100 long paragraphs with a new width.
- At 100,000 paragraphs, a new width takes 74 times less time than pretext in Bun for long paragraphs, 3.88 against 287 ms, and 139 times for short ones, 0.39 against 54.2 ms. New cells take 1.8 times less for long paragraphs, 158 against 287 ms, and 1.7 times for short ones, 31.5 against 54.2 ms.

### Where the GPU's time goes

ms, medians of the 3 runs, max guard:

| Size | Paragraphs | MB uploaded with new cells | Writing the cells in JavaScript | writeBuffer calls | From submit to `mapAsync` resolving | Compute pass | New width: whole evaluation | New width: compute pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short | 1 | 0.0006 | 0 | 0 | 0.24 | 0.058 | 0.26 | 0.020 |
| short | 1,000 | 0.55 | 0.12 | 0.13 | 0.26 | 0.019 | 0.21 | 0.055 |
| short | 10,000 | 5.52 | 1.62 | 0.075 | 1.12 | 0.037 | 0.23 | 0.023 |
| short | 100,000 | 55.2 | 25.1 | 0.80 | 5.60 | 0.42 | 0.39 | 0.16 |
| long | 1 | 0.0041 | 0 | 0 | 0.39 | 0.18 | 0.39 | 0.18 |
| long | 1,000 | 4.14 | 0.81 | 0.97 | 1.21 | 0.25 | 0.42 | 0.20 |
| long | 10,000 | 41.4 | 10.9 | 0.62 | 5.41 | 1.00 | 0.70 | 0.43 |
| long | 100,000 | 414 | 109 | 6.09 | 41.8 | 6.26 | 3.88 | 3.59 |

- Up to about 100 paragraphs, an evaluation is a fixed round trip: 0.20 to 0.30 ms with the short shader and 0.39 to 0.50 ms with the long one, as medians of the GPU part and of a new width, almost all of it from submit to `mapAsync` resolving. In 0.4 ms pretext lays out about 1,500 short or 170 long paragraphs in Bun. The long shader's compute pass takes 0.18 ms even for 1 paragraph, i.e. 64 invocations, 63 of which return at once, and 0.11 ms without the guard, while the short shader's takes 0.01 to 0.06 ms. I didn't find out why a larger shader's pass costs more for the same work.
- With new cells, JavaScript and the upload take most of the time. At 100,000 long paragraphs, writing the cells takes 109 ms, about 1.1 µs per paragraph, more than a third of pretext's whole layout, and moving 414 MB to the GPU about 42 to 45 ms: the GPU part minus the compute pass is 41.5 ms, and an upload alone, `writeBuffer` and then `onSubmittedWorkDone` on an empty command buffer, 45.0 ms. The compute pass takes 6.26 ms.
- With a new width and the cells on the GPU, the compute pass is most of the evaluation: 3.59 of 3.88 ms for 100,000 long paragraphs, i.e. 928 million shader statements, and 0.16 of 0.39 ms for 100,000 short paragraphs. That's about 36 µs per 1,000 long paragraphs, against 2,870 µs for pretext in Bun and 10,900 µs for the same program as generated JavaScript.
- Reading back one float32 line count per paragraph costs little: copying 400 KB out of the mapped buffer takes 0.02 ms at 100,000 paragraphs, and evaluations with and without readback differ by less than the spread between runs.
- The max guard slows the compute pass but barely changes the totals with new cells: at 100,000 long paragraphs the pass takes 6.26 ms with the guard and 5.25 ms without, and with a new width 3.59 against 2.34 ms, where the whole evaluation takes 3.88 against 2.65 ms. The guard also doubles the long shader's compile time, 837 against 385 ms (medians; the first compile in a Chrome process took up to 2.0 s). The short shaders compiled in 47 to 109 ms.
- In run 2, writing the long paragraphs' cells inside the GPU loop took 4.4 to 4.7 µs per paragraph, e.g. 465 ms at 100,000 paragraphs, against 0.8 to 1.1 µs in runs 1 and 3. The same function timed on its own earlier in that page took 0.47 to 0.64 µs, as in the other runs, and run 2's GPU part didn't change. So run 2 is the top of the new-cells ranges for long paragraphs, e.g. 512 ms at 100,000. I didn't find the cause, e.g. whether V8 had deoptimized that loop. Run 2 started 26 ms after the last CPU timing process, a generated JavaScript process with 10 to 11 GB of RSS, wrote its record, and a bun process with 1.9 GB of RSS used about 100% of a core just before run 2 started. Run 2's long paragraphs came minutes later, so that overlap doesn't obviously explain the slow writes, but a pause between the CPU batch and a GPU run would have ruled it out.

### Workgroup sizes

One sweep run (results/gpu-sweep-1.json), with the own-width shader, new cells and readback, before the main runs:

| Size | Paragraphs | GPU part, workgroup of 16 | 64 | 256 | Compute pass, workgroup of 16 | 64 | 256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| short | 1,000 | 0.42 | 0.44 | 0.44 | 0.056 | 0.059 | 0.063 |
| short | 10,000 | 1.23 | 1.24 | 1.29 | 0.061 | 0.061 | 0.059 |
| short | 100,000 | 6.98 | 6.88 | 6.78 | 0.46 | 0.32 | 0.34 |
| long | 1,000 | 2.52 | 2.53 | 2.62 | 0.61 | 0.62 | 0.71 |
| long | 10,000 | 7.45 | 5.96 | 5.43 | 1.70 | 0.87 | 0.94 |
| long | 100,000 | 53.8 | 76.1 | 51.1 | 9.66 | 6.21 | 6.31 |

A workgroup of 16 made the long compute pass about 1.5 times slower at 100,000 paragraphs, and 64 and 256 were about even. The GPU parts differ mostly in the upload, with one outlier: at 100,000 long paragraphs, the GPU part with a workgroup of 64 took 76.1 ms, against 53.8 ms with 16 and 51.1 ms with 256, while its compute pass wasn't slower, and the main runs measured 47.8 ms there with the same workgroup. I didn't find the cause. These numbers come from one run, during which a bun process that wasn't part of this experiment used about 100% of a core, with 8.2 GB of RSS before the run and 5.5 GB after it (`driver.busiestBefore` and `driver.busiestAfter` in results/gpu-sweep-1.json). So the workgroup comparison is weaker evidence than the main runs, and wasn't repeated. The main runs use codegen's default of 64.

### What this says about Cheng's question

- Yes, past a crossover, as predicted. On this machine the per-paragraph program on the GPU takes less time than pretext's `layout()` from about 160 to 170 long or 800 short paragraphs when only the width changes and the cells stay on the GPU, e.g. on a resize, and at 100,000 paragraphs it takes 74 to 139 times less time.
- When the texts change, the GPU wins later and by less: from about 1,100 to 1,400 long or 8,200 to 8,700 short paragraphs, and 1.7 to 1.8 times at 100,000 paragraphs. There the cost is JavaScript writing every paragraph's cells and the upload, not the program: the compute pass is 4% of the evaluation for 100,000 long paragraphs.
- One paragraph loses, as predicted: 0.39 ms against pretext's 2 µs for a long paragraph, about 200 times as long, since a round trip has a fixed cost.
- Against the same program on the CPU, the GPU wins from about 40 to 50 long or 170 to 280 short paragraphs against generated JavaScript, and from 100 paragraphs or fewer against the executor.
- The programs output only line counts. Per-line widths or word positions would multiply what the host reads back by the number of lines or segments, and the host would still have to turn them into DOM writes.

### Not done

- Widths off the 1/64 px grid: within float32 rounding of pretext's fit limit, they can give one more line than pretext, see [Correctness checks](#correctness-checks).
- codegen's instance path doesn't take index reads, since its `flattenProgram` reads only a layer's affine, ReGLU, boolean and gather rows. So the index-read program, the smallest with line slots, has executor numbers only, and `createBatchInstanceRunner` refuses it. codegen's WGSL emitter writes each gather as a `switch` statement over its candidates, which for the long one-hot program would be 6,557 statements of 517 cases. So the GPU step ran only the segment walker.
- Only line counts: no per-line widths, and no word positions.
- Fake canvas widths on a 1/4 px grid. Real canvas widths aren't, and the programs would need widths rounded to the 1/64 px grid, like Notes does, which can move a break whose span lies within 1/128 px of the width.
- Only pretext's fast path, and only widths at least as wide as the widest segment.
- Only Apple's GPU through Metal, in headless Chrome 153. No other GPU, browser or WebGPU backend, and no timing relative to `requestAnimationFrame`, unlike regex-search's frames run.
- A new width with the own-width plan uploads every cell again. Uploading only the width cells, e.g. from their own buffer, wasn't tried. The shared-width plan covers the case where every paragraph gets the same width.
- Every cell is a float32 value, including the break-after bits and startCursor. Packing them into fewer bytes, to shrink the upload, wasn't tried.

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

The tests (18 tests, about 1.7 seconds) check every circuit against pretext. report.ts prints the tables below; its `fast` part builds 1023-segment circuits and takes about a minute. The demo page is a paragraph flowing around a draggable window with a spring per word.

`pretext-src/` is a copy of pretext's `src/` (analysis, bidi, entry-geometry, layout, line-break, line-text, measurement and the generated tables) from commit 477510e of the clone in the phase 2 scratchpad, so the tests don't depend on a temporary folder. The runtime is the shared `numeric-ui-core.ts`, unchanged.

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

Nobody was awake to grant browser permissions, so I didn't open the page. It bundles (`bun build lab/ui-exploration/text-walker/demo.html --outdir <folder>`: 18 modules). A scratch script checked the demo's text, bands, spring setup and bold toggles headlessly, but with the fake canvas's widths, and with each word's width times 1.25 standing in for bold, since the fake canvas has no bold face. With those widths the circuit has 223 segments, 20 bands, 33,052 live operations and 239 layers, and had 0 mismatches over 150 random column widths, window positions and bold toggles, at about 230 µs per evaluation. In the browser, the window and minimum slot width come from real Georgia widths, so the demo's circuit size can differ from these counts.

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

- **An executor instruction that reads a table at an integer wire.** The estimates above suggest about 9x fewer operations for gathered lines at 1023 segments, and it would turn pointer jumping from quadratic into about N log N work. It needs its own exactness contract, for example a declared integer range and a clamp.
- **Static break kinds.** When kinds come from prepare instead of runtime cells, comparisons at break-after segments can be dropped, like the rows circuit's merged candidates (8 instead of 20 per line), and the run limit goes away.
- **Runtime thresholds for the ladder.** Letter spacing, soft hyphens and emergency breaks could use in-circuit prefix sums over grapheme advances, so edited widths work beyond the fast path. Tabs need a bounded modulo.
- **Blink's unfit-hyphen return and kerned admission.** Both need a second first-failure list per candidate, and a select between the lists.
- **Real browser widths.** How often does the demo's mismatch counter move with real Georgia widths, and would quantizing widths to 1/64 px at the table boundary remove those mismatches without visible change?
- **Generated JavaScript.** Phase 1 ran IndirectOS about 12 times faster as generated JS. The demo circuit would likely drop from about 230 µs to tens of µs.
- **Many paragraphs as instances.** Masonry cards or chat bubbles share one compiled circuit, with different widths in the table. That is the case a batched or GPU executor would parallelize.
- **Joining IndirectOS.** A Notes window whose text flows around the other windows, with word springs, in the same circuit as window focus and dragging.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/text-walker/demo.html`.

- The page loads with no console errors or warnings. With real Georgia widths, the circuit has 223 segments, 112 words, 904 source cells, 34,132 live operations (8,920 of them in integer one-hots), 239 layers and 77,799 stored weights. The panel showed a compile time of 2,350 ms.
- Dragging the window's title bar reflows the lines around the window. Clicking a word makes it bold and the paragraph breaks again. The column width slider narrows and widens the paragraph. Words spring to their new places.
- Mismatch counter: 0 mismatches over 236 states checked against pretext. 6 states came from real drags, clicks and slider moves. The other 230 came from a script that set random column widths between 280 and 600 px and toggled bold on random words, with 36 words bold at the end.
- The panel's median evaluation time was 4,700 µs right after load, then between 600 and 1,600 µs. Headless runs in Bun with fake widths measured about 230 µs. Other agents were using the machine during both measurements. Chrome gives this page `performance.now()` in steps of 0.1 ms, so the panel's median is always a multiple of 100 µs.
- Small problem in the first check: dragging the title bar selected the "Drag me" text, because the title bar didn't set `user-select: none`.
- Fixed later in `demo.css`: `.window .title` now sets `user-select: none`. `bun test lab/ui-exploration/text-walker` (18 tests) and `bunx tsgo -p lab/ui-exploration/text-walker` pass.
- Recheck in Chrome: a real mouse drag from the "Drag me" label moved the window, e.g. from (206, 197) to (130, 306) in viewport px, the paragraph reflowed around it, and no text was selected afterwards (`getSelection().type` was "None"). No errors.

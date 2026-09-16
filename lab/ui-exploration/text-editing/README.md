# A text field whose editing model lives in one circuit

This prototype puts a text field's editing model into one fixed Indirect circuit: insert, backspace and delete, caret movement by character, word, line and document, shift-selection, paste, word wrapping, caret and selection geometry, click and drag to place the caret, and vertical movement that keeps a preferred x. Strings never enter the circuit. JS turns graphemes into integer codes, measures each new grapheme once, and draws glyph spans at the positions the circuit outputs.

The short answer to "what does one keystroke cost": at 256 cells and 12 line slots, a key that may read line geometry (up, down, Home, End, click) adds 29,115 live operations. A key that only reads the buffer (typing, deleting, left and right, word jumps) adds 12,068 live operations. Depth doesn't add up per key the same way: a second key adds about 180 layers either way, and later keys add about 120 layers each with a layout, or about 59 each without. The whole one-key circuit is 54,431 live operations, about ten times IndirectOS. Every decision and every position is exact: all layout values are integers in quarter pixels, and the circuit matched a plain JS editor on every one of about 35,000 random frames checked.

## How to run it

From the repo root:

```sh
bun test lab/ui-exploration/text-editing                        # 17 tests, under a second
bunx tsgo -p lab/ui-exploration/text-editing                    # typecheck
bun lab/ui-exploration/text-editing/report.ts                   # all measurements, several minutes
bun lab/ui-exploration/text-editing/report.ts phases typing     # chosen sections: sizes keys lines variants phases frames typing
bun lab/ui-exploration/text-editing/pretext-agreement.ts        # wrapping rules against pretext's pre-wrap walker
bun lab/ui-exploration/text-editing/demo.html                   # browser demo
```

Four longer checks are session scratch scripts (scratch folder `phase2/text-editing/`, not in the repo) and ran with `bun <path>`: `stress.ts` (differential runs at capacities 31 to 64), `large-capacity.ts` (the FP32 budget, sizes at capacity 512 and 1024, and a differential run at capacity 512 that fills the buffer), `codegen-warmup.ts <rows per function> <capacity>` (generated JS over 30 seconds of warmup), and `line-depth.ts` (the chain of operations inside one line slot).

`pretext-agreement.ts` measured against the phase 1 copy of pretext's source (commit 477510e4 of https://github.com/chenglou/pretext), not a live checkout. That copy isn't in the repo: the script reads the folder from `PRETEXT_SRC`, and `lab/ui-exploration/text-tabulated/pretext/` holds the same files. I didn't open the demo in a browser, since no browser automation was allowed. A later Chrome check opened the demo, see [Browser check](#browser-check). I checked that `bun demo.html` serves the page and bundles the module, and every module the demo uses is exercised by the headless tests. The runtime (`numeric-ui-core.ts`) is imported unchanged.

## What was built

### Files

| File | What it holds |
| --- | --- |
| `editor-circuit.ts` | Source table layout, the circuit builder (decode, layout, step, display), and a machine that writes events, evaluates, and writes the next state back |
| `integer-circuits.ts` | Integer building blocks: one-atom comparisons, pick, min and max, one-hot groups from runs of ones, gathers, floor by a power of two, integer bits, prefix scans, tournaments, barrel shifters, size measurement |
| `reference.ts` | The plain JS editor model the circuit is checked against: a sequential greedy line walker, linear word scans, array splices |
| `width-table.ts` | The prepared width table: grapheme to code, class and advance in layout units |
| `keyboard.ts` | Browser keys, text and pointer input to editor events, and the rule for filling key slots |
| `projection.ts` | Circuit outputs to glyph spans, a caret rectangle and selection rectangles |
| `codegen.ts` | Plain JS generated from the compiled program, adapted from the phase 1 codegen study |
| `demo.html`, `demo.ts` | Browser demo |
| `report.ts`, `pretext-agreement.ts` | Measurements |
| `editor.test.ts`, `integer-circuits.test.ts`, `input.test.ts` | Differential tests against the JS model, building block tests, input, width table and projection tests |
| `fake-canvas.ts`, `test-support.ts` | Deterministic widths (copied from phase 1) and random inputs |

### Source table

- Constants: unit, maxWidth and lineHeight in layout units (quarter pixels in the demo).
- State: `length`, `caret`, `anchor` (the selection is the range between them), `preferredX` and `hasPreferredX`.
- `capacity` cells. A cell packs `code * 4096 + class * 1024 + advance` into one exact FP32 integer. Classes are other, word character, space (the ASCII space and the tab) and newline, and advances are integers below 1024. No-break spaces such as U+00A0 are in the other class. An edit moves one number per cell instead of three.
- The prepared width table: `codeLimit` cells, where entry `code` holds that grapheme's packed cell. JS assigns a code the first time a grapheme appears and writes one table cell. Nothing about the circuit changes.
- One event slot per queued key: a one-hot over 18 key kinds, a shift bit, a paste count, `pasteLimit` code cells, and pointer x and y.

The next state is cells, length, caret, anchor and preferred x. The display outputs are line starts, line count, an overflow count, caret line and x, a selection left and right per line slot, and optionally a line index and x per glyph.

### One key step

Each slot builds, in order:

1. **Decode cells.** One floor recovers the code, three comparisons on the remainder give the class bits, and an affine gives the advance: 8 atoms per cell.
2. **Layout** (only in layout slots, described below).
3. **Caret and word targets.** Selection start and end as min and max. `[caret >= p + 1]` for every p. The latest word start before the caret, as a tournament of maxima over `p * wordStart[p] * [p < caret]`, and the earliest word end after it, as a tournament of minima.
4. **Lines and hit test** (layout slots only). The caret's position key and line come from gathers over one-hot groups. The up, down and pointer kinds pick one target line and x through the kind one-hot, so each step runs one hit test.
5. **Edit range, caret and anchor.** Every edit is "replace `[editStart, editEnd)` with the pasted codes". Typing is a paste of one code, and backspace, delete and Option+Backspace choose their range from the selection. The new caret, anchor and preferred x are gathers over the kind one-hot.
6. **Pasted code lookups.** One integer one-hot per pasted code over the width table, read by a gather, masked by `[k < accepted count]`.
7. **Cell rewrite.** `head[i] = cell[i] * [i < editStart]`, `tail[i] = cell[i] * [i >= editEnd]`. The tail moves toward the start by `editEnd - editStart - insertCount` through a barrel shifter (log2(capacity) stages of selects). The pasted codes move to `editStart` through a second barrel shifter. The new cell is the sum of the three. A variant (`shift: 'gather'`) replaces both shifters with one gather read per cell over a shared one-hot of the shift.

Several keys per evaluation are this step unrolled once per slot, each copy reading the previous copy's next state. The first `layoutSlots` slots lay out the buffer first. Later slots skip the layout, so they only accept keys that don't read line geometry. `takeFrameEvents` ends a batch at the first such key that would land in a buffer-only slot, and `writeEvent` refuses it.

### Layout over character cells

For text whose only break opportunities are spaces and newlines, the semantics match CSS `white-space: pre-wrap` with `overflow-wrap: anywhere`. A break opportunity sits after every space, tab or newline, and a tab is a space with its measured width, not a tab stop. No-break spaces such as U+00A0 and U+202F are ordinary glyphs, so they count toward the line width and never open a break opportunity. Spaces at a line end hang past the edge. A word that doesn't fit moves to the next line, and a word wider than the line breaks at the last glyph that fits. A newline ends its line. The other break opportunities of Unicode line breaking (UAX #14), e.g. between CJK ideographs or after hyphens, aren't built. Every line slot costs one comparison per cell against a single threshold, plus a few gathers:

- **Position keys.** `keys[p]` is the advance sum before cell p, plus `maxWidthLimit` for every newline before p. The offset means no line can reach past a newline, so newlines need no search. The keys are a parallel prefix sum (Sklansky by default).
- **Fit edges.** `fitEdge[c]` is the right edge of the last non-space cell at or before c, a prefix maximum. A run of spaces never overflows even when its own advances pass the edge.
- **First failing cell.** For a line starting at s with key K, the fit bits `[fitEdge[c] <= K + maxWidth]` form a run of ones because fit edges never decrease. So the first cell that doesn't fit is the count of ones, and neighbor differences of the fit bits form an exact one-hot group without any more comparisons.
- **Next line start.** Gathers read, at the first failing cell, the latest break opportunity (a prefix maximum), the key there (another prefix maximum), whether the cell is a newline, and the keys at and after the cell. If the latest opportunity is at or before s, the line breaks inside the word, taking at least one cell. The text ends on this line when everything fits or when a soft break lands at the end. A trailing newline keeps an empty last line, so the caret has a place to sit.

The line walk is sequential over line slots. A text that needs more lines than `lineSlots` is out of contract, and the overflow output reports it.

### Caret geometry and click to caret

- The caret line is `sum over k of [caret >= start of line k]`, and its x is `keys[caret]` minus the line's start key.
- A pointer or a vertical key targets a line and an x. Glyph centers never decrease, so the caret position is the count of glyphs whose doubled center `2 * keys[c] + advance[c]` is left of `2 * (lineKey + x)`, clamped to the line's caret range.
- Up and down use `preferredX` when it is set, and set it from the caret x otherwise. Every other key clears it.
- Selection rectangles clamp the selection's start and end keys to each line's painted range. Clamping keys is the same as clamping cell indices, because keys never decrease.

### Exactness

Every wire holds an integer below 2^23. An integer comparison `[a >= b]` is one boolean atom on `0.5 + (a - b) * 2^-24`. The builder evaluates the bias and then the terms in wire order, and when every partial sum stays inside (-1, 1), each one is a multiple of 2^-24 with at most 24 significant bits. So the atom rounds `0.5` to 1 and `0.5 - 2^-24` to 0 exactly. `atLeastZero` checks those partial sums from the declared ranges at build time and refuses wider operands. That is 1 atom per comparison, where the relu ramp takes 3 and the sign cascade 26. There is no drift anywhere: glyph x positions equal the JS model's integer sums.

The budget that position keys must fit in is about `2 * capacity * (1023 + maxWidthLimit) < 2^23`, which holds for any buffer content. At four units per pixel, the largest maxWidthLimit that passes the check is 14,337 units at capacity 256 (fields up to 3,584px), 6,145 units at capacity 512 (1,536px), and 2,049 units at capacity 1024 (512px), and the builder accepts each of those limits. Capacity 2048 doesn't fit at all. Texts that fit in the line slots stay far below the bound. For example, the capacity 512 differential run reached position keys of at most 42,418, against a bound of about 2.6 million, so only the build-time range checks cover the edge of the budget.

### Editing rules the JS model and the circuit share

- Left and right without shift collapse a selection to its start or end. Every other movement starts from the caret. With shift the anchor stays, and without shift it follows the caret.
- A word is a run of letters, digits, marks, underscore and apostrophe. Option+Left goes to the latest word start before the caret, and Option+Right to the earliest word end after it.
- End on a soft-wrapped line lands one cell before the next line's start, i.e. before the trailing space. This avoids caret affinity state. On a line broken inside a word, that puts the caret before the last glyph.
- A click lands on the line under the pointer, clamped to the last line.
- A paste that doesn't fit inserts as many codes as the buffer has room for.

## Measured results

Counts are exact. µs are rough single-threaded CPU numbers on a machine shared with about a dozen other agents. IndirectOS for scale: 5,253 live ops, 192 layers, 11,598 stored weights, about 31-39µs.

### Correctness

| Check | Frames or layouts | Mismatches |
| --- | ---: | ---: |
| `editor.test.ts`: capacity 20, 2 keys per evaluation, random keys of all 18 kinds, state and every display output | 700 frames, minus resets past the line slots | 0 |
| `editor.test.ts`: capacity 17, Brent-Kung scans | 700 frames, minus resets | 0 |
| `editor.test.ts`: capacity 18, 3 keys with 1 layout slot, gather shift | 600 frames, minus resets | 0 |
| Scratch stress run: capacities 31, 40, 48 and 64, up to 4 keys, all variants, 3 seeds each | 29,995 frames | 0 |
| `report.ts typing`: capacity 256, 12 line slots, 4 keys with 1 layout slot, fake canvas widths, 320px field | 1,500 frames, 2,870 keys | 0 |
| Scratch run at capacity 512: 16 line slots, maxWidthLimit 4096, glyph outputs on, pastes that fill the buffer (longest text 512 cells, 16 frames with a full buffer), state and every display output | 2,000 frames | 0 |
| `pretext-agreement.ts`: line starts against pretext `layoutWithLines` in pre-wrap mode, 41 widths per text. 300 texts with long words, commas, double spaces and newlines | 12,300 layouts | 0 |
| Same, 240 texts: leading spaces after newlines, long space runs, lines holding only spaces, and text starting with spaces | 9,840 layouts | 0 |
| Same, 60 texts with no-break spaces (U+00A0, U+202F) between words, mixed with spaces | 2,460 layouts | 0 |
| Same, 60 texts with CJK ideographs, kana and Hangul next to Latin words (break opportunities between ideographs aren't built) | 2,460 layouts | 2,023 |

The pretext check dropped the editor's empty last line after a trailing newline in 1,517 layouts (656 in the first text family and 861 in the family with lines holding only spaces), since pretext doesn't report that line. The differential tests also run `validateOneHotGroups` on every declared group (the kind one-hot promise included) every 40 frames.

The differential test found one real bug. My first formulation used a space's own left edge as its fit edge, assuming a space can never be the first cell to overflow. In a run of spaces, the second space's left edge includes the first space's advance, so trailing spaces could push a line break. The fit edge became a prefix maximum over the right edges of non-space cells.

A verification pass found a second bug, in the JS width table: it put U+00A0 in the space class, so a no-break space opened a break opportunity and hung at a line end, and 1,011 of 2,460 layouts with no-break spaces differed from pretext. U+00A0 is now in the other class. `input.test.ts` checks the class and a layout, and `pretext-agreement.ts` gained the no-break space family and the four families of leading spaces, space runs and lines holding only spaces.

### Size by capacity (one key per evaluation, 12 line slots, paste limit 8, 96 codes, glyph outputs on)

| Capacity | Sources | Live ops | Affine / reglu / boolean | Layers | Stored weights | Gather reads / table entries | Build ms | Executor µs |
| ---: | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: |
| 32 | 166 | 8,217 | 4,238 / 1,554 / 2,425 | 215 | 16,115 | 173 / 5,298 | 28 | 65 |
| 64 | 198 | 14,427 | 7,391 / 3,105 / 3,931 | 223 | 29,252 | 205 / 9,522 | 33 | 113 |
| 128 | 262 | 27,389 | 14,000 / 6,448 / 6,941 | 231 | 56,661 | 269 / 17,970 | 57 | 219 |
| 256 | 390 | 54,431 | 27,841 / 13,631 / 12,959 | 239 | 113,830 | 397 / 34,866 | 81 | 430 |
| 512, no glyph outputs, built with maxWidthLimit 4096 units (fields narrower than 1024px) | 646 | 97,473 | 49,106 / 29,006 / 19,361 | 247 | 209,399 | 141 / 62,514 | 157 | |
| 1024, no glyph outputs, built with maxWidthLimit 2048 units (fields narrower than 512px) | 1,158 | 201,443 | 101,859 / 61,789 / 37,795 | 255 | 433,736 | 141 / 123,954 | 311 | |

Live operations grow linearly with capacity, about 210 per cell. Layers grow only with log2(capacity), 8 per doubling, since the prefix scans, tournaments and barrel shifters are the only parts whose depth depends on capacity. The plain JS model applies four keys in 4.3µs without display, about 1µs per key, so on this executor the circuit is roughly 170 to 400 times slower per key.

Generated plain JS (`codegen.ts`, checked equal to the executor on a typical frame) doesn't give the tenfold gain here that phase 1 measured for IndirectOS. At capacity 64 (1,038 functions of 16 rows), JavaScriptCore settles at about 32µs per evaluation after 6 seconds of continuous evaluation, about 3.5 times faster than the executor. At capacity 256, it stays around 20ms per evaluation for the first 9 to 12 seconds. It then settles at about 950µs with 3,940 functions of 16 rows, or 600-700µs with 1,011 functions of 64 rows, still slower than the executor's 430µs. With the 1.5-second warmup in `report.ts sizes`, generated JS measured 10µs at capacity 32, 72µs at 64, 10,499µs at 128 and 21,487µs at 256.

### Cost per queued keystroke (12 line slots)

| Circuit | Live ops | Layers | Stored weights | Gather table entries | Executor µs |
| --- | ---: | ---: | ---: | ---: | ---: |
| capacity 64, display only (0 keys) | 6,244 | 174 | 12,707 | 4,810 | 51 |
| capacity 64, 1 key | 14,427 | 223 | 29,252 | 9,522 | 122 |
| capacity 64, 2 keys, both with layout | 22,610 | 397 | 45,797 | 14,234 | 193 |
| capacity 64, 4 keys, all with layout | 38,976 | 620 | 78,887 | 23,658 | 325 |
| capacity 64, 2 keys, 1 with layout | 18,491 | 396 | 36,591 | 10,344 | 155 |
| capacity 64, 4 keys, 1 with layout | 26,619 | 494 | 51,269 | 11,988 | 220 |
| capacity 64, 8 keys, 1 with layout | 42,875 | 691 | 80,625 | 15,276 | 350 |
| capacity 256, display only (0 keys) | 25,316 | 180 | 51,811 | 19,018 | 211 |
| capacity 256, 1 key | 54,431 | 239 | 113,830 | 34,866 | 443 |
| capacity 256, 2 keys, both with layout | 83,546 | 419 | 175,849 | 50,714 | 737 |
| capacity 256, 4 keys, all with layout | 141,776 | 658 | 299,887 | 82,410 | 1,211 |
| capacity 256, 2 keys, 1 with layout | 66,499 | 418 | 137,523 | 35,688 | 583 |
| capacity 256, 4 keys, 1 with layout | 90,635 | 536 | 184,909 | 37,332 | 767 |
| capacity 256, 8 keys, 1 with layout | 138,907 | 773 | 279,681 | 40,620 | 1,148 |

| From the rows above | Capacity 64 | Capacity 256 |
| --- | --- | --- |
| Each further key with a layout | 8,183 live ops, 16,545 stored weights, 4,712 gather table entries | 29,115 live ops, 62,019 stored weights, 15,848 gather table entries |
| Each further buffer-only key | 4,064 live ops, 7,339 stored weights, 822 gather table entries | 12,068 live ops, 23,693 stored weights, 822 gather table entries |
| Layers for 1, 2 and 4 keys, all with layout | 223, 397, 620: +174 for the second key, then about +112 per key | 239, 419, 658: +180 for the second key, then about +120 per key |
| Layers for 1, 2, 4 and 8 keys, 1 with layout | 223, 396, 494, 691: +173 for the second key, then about +49 per key | 239, 418, 536, 773: +179 for the second key, then about +59 per key |

Live ops, stored weights and gather table entries add up exactly per key, but layers don't. The first key's cells don't wait for its layout, but its caret does, through the hit test: the one-key circuit's new caret and anchor come out around layer 187. A second key's edit range reads that caret, so its cells, and the final layout after them, start about 180 layers later whether or not the second key lays out. After that, each buffer-only key adds about 59 layers at capacity 256, mostly its cell rewrite, and each key with a layout adds about 120.

Four keys in one frame at capacity 256 with 180 cells of text, executor µs including write-back: four evaluations of the one-key circuit took 1,780µs. One evaluation of the four-key circuit took 1,152µs with every slot laying out and 739µs with one layout slot.

### Where the operations go (capacity 256, 12 line slots, one key)

| Part | Live ops | Stored weights | Gather table entries |
| --- | ---: | ---: | ---: |
| key: decode cells | 2,048 | 4,096 | 0 |
| key: prefix sums and scans (keys, fit edges, latest opportunity and its key) | 9,476 | 19,203 | 0 |
| key: line breaking, 12 line slots | 6,460 | 15,895 | 14,649 |
| key: caret and word targets | 2,564 | 4,613 | 0 |
| key: lines and hit test | 600 | 1,434 | 377 |
| key: edit range, caret and anchor | 30 | 76 | 54 |
| key: pasted code lookups, 8 codes over 96 entries | 1,552 | 2,304 | 768 |
| key: cell rewrite (barrel shifts) | 6,387 | 14,399 | 0 |
| final: decode cells | 1,792 | 3,584 | 0 |
| final: prefix sums and scans | 9,219 | 18,691 | 0 |
| final: line breaking | 6,432 | 15,836 | 15,420 |
| final: caret and selection | 1,213 | 1,921 | 526 |
| final: glyph positions | 6,657 | 11,778 | 3,072 |

A buffer-only key is decode (1,536, fewer because advances are unused), caret and word targets (2,564), pasted code lookups (1,552), edit range (29) and cell rewrite (6,387). The line walk spans layers 1 to 176, and it sets the depth of a layout key. The prefix scans take the first 32 of those layers, and each line slot then adds exactly 12 layers (`line-depth.ts` in the scratchpad measures 12 between consecutive line starts at capacities 128 and 256).

### Line slots (capacity 128, one key)

| Line slots | Live ops | Layers | Stored weights | Gather table entries |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 20,677 | 135 | 41,293 | 6,562 |
| 8 | 24,033 | 183 | 48,977 | 12,266 |
| 16 | 30,745 | 279 | 64,345 | 23,674 |
| 32 | 44,169 | 471 | 95,081 | 46,490 |

Each line slot costs about 840 live ops and 12 layers at capacity 128. That covers the key's layout and the final layout, plus one glyph-position comparison per cell.

### Variants (one key, 12 line slots)

| Variant | Capacity 64: live ops / layers / weights / table entries | Capacity 256: live ops / layers / weights / table entries |
| --- | --- | --- |
| Baseline: Sklansky scans, barrel shift, glyph outputs | 14,427 / 223 / 29,252 / 9,522 | 54,431 / 239 / 113,830 / 34,866 |
| Brent-Kung scans | 13,419 / 233 / 27,236 / 9,522 | 47,123 / 255 / 99,214 / 34,866 |
| Gather shift instead of barrel shift | 13,631 / 203 / 26,946 / 18,354 | 50,623 / 213 / 103,042 / 168,498 |
| No glyph outputs | 12,763 / 223 / 26,308 / 8,754 | 47,775 / 239 / 102,054 / 31,794 |
| Paste limit 1 | 12,934 / 219 / 26,895 / 8,850 | 52,882 / 235 / 111,333 / 34,194 |
| Paste limit 32 | 19,455 / 225 / 37,106 / 11,826 | 59,651 / 241 / 122,164 / 37,170 |
| 32 table entries | 13,403 / 223 / 27,716 / 9,010 | 53,407 / 239 / 112,294 / 34,354 |
| 512 table entries | 21,083 / 223 / 39,236 / 12,850 | 61,087 / 239 / 123,814 / 38,194 |

An earlier version found word targets with two more prefix scans and was 57,253 live ops at capacity 256. Tournaments at the caret saved 2,822.

## What this shows about how far the approach goes

### What fit well

- **Edits are per-cell selects, and they are exact.** Replacing a range with pasted codes is a head mask, a tail mask, and two barrel shifts. It costs about 25 atoms per cell (6,387 at capacity 256), and its layers span about 50 whatever the edit. Packing code, class and advance into one integer means one number moves per cell.
- **Searches became counts.** The first cell that overflows a line, the glyphs left of the pointer, the caret's line and the line under the pointer are each a count of comparison bits, because the compared quantity never decreases along the buffer. The same runs of ones, differenced with their neighbors, are exact one-hot groups, so reading a table at those positions needs no extra comparisons.
- **Integer layout units make every comparison one atom and remove drift.** With widths in quarter pixels, positions are integers, and a boolean atom on `0.5 + d * 2^-24` is exact over the checked window. Glyph positions, caret x and selection rectangles equal the JS model exactly.
- **For text whose only break opportunities are spaces and newlines, the wrapping rules survived an independent check.** Hanging spaces, long space runs, leading spaces, lines holding only spaces, no-break spaces, breaks inside long words, newlines, and empty lines matched pretext's pre-wrap walker on 24,600 layouts. The only difference is the extra empty line after a trailing newline, which an editor wants anyway. CJK text is outside that scope (see the next steps).
- **Strings stay outside, and the table is data.** Assigning a code writes one table cell, and the demo keeps growing its table as you type graphemes it hasn't seen.
- **Several keys per evaluation unroll exactly.** The four-key circuit equals four one-key evaluations on every frame tested. Separating keys that read line geometry from keys that don't cut an extra key from 29,115 to 12,068 live ops at capacity 256.

### What got awkward

- **Width.** One key at capacity 256 is 54,431 live ops, 113,830 stored weights and 34,866 gather table entries, about ten times IndirectOS's live ops. Most of it is O(capacity) work repeated per key: decode, four prefix scans, one comparison per cell per line slot, and the barrel shifts.
- **Every key that reads line geometry repeats the whole layout.** A key can't reuse the previous key's layout, because the buffer changed. The circuit computes all key kinds every time, so even "type one letter" pays for the layout in a layout slot. Buffer-only slots avoid that, but JS then has to split the queue by key kind.
- **Line breaking is sequential in line slots.** Each line reads its start key from the previous line, so every line slot adds 12 layers after the 32 layers of prefix scans, and 12 slots end at layer 176. Text past the last slot is simply not laid out. The circuit only reports that overflow; it can't scroll or grow.
- **Prefix scans dominate the layout.** The keys, fit edges, latest opportunity and its key are 9,476 of a layout key's 29,115 ops. Brent-Kung scans cut that at the cost of 16 more layers.
- **The FP32 budget for position keys limits capacity.** The newline offset turns keys into `advance sum + maxWidthLimit * newlines`, so keys grow with capacity times field width. Capacity 1024 only fits a 512px field at quarter-pixel units, and capacity 2048 doesn't fit at all. A separate newline count with a lexicographic comparison would lift that at more atoms per comparison.
- **The width table is read only for typed codes, not per cell.** A lookup over 96 entries costs 194 atoms (1,552 for 8 codes), so reading every cell's advance from the table on each layout would add about 49,700 live ops at capacity 256. Cells cache their advance instead. The catch is that a font change means JS rewrites every cell.
- **Caret affinity got simplified away.** A caret position at a soft wrap belongs to the next line. End lands before the trailing space instead of after it, and on a line broken inside a word, End lands before the line's last glyph.
- **Contracts the runtime doesn't check.** The kind cells must be one-hot, inputs must be integers, and keys that read line geometry must sit in layout slots. JS enforces the last one in `writeEvent`. The tests check the first with `validateOneHotGroups`, but a normal evaluation only checks ranges.
- **CPU cost.** The executor takes 430µs for one key at capacity 256, while the plain JS model takes about 1µs per key. The circuit only makes sense as part of one program next to the rest of the UI, or on hardware that runs it differently.

### What stayed outside the circuit

- The prepare step: grapheme segmentation with `Intl.Segmenter`, measuring with canvas `measureText`, rounding to layout units, classifying graphemes with a regex, and assigning codes. A full table drops new graphemes.
- Turning codes back into strings, clipboard copy, cut and paste, mapping key names and modifiers to key kinds, focus, and pointer capture.
- IME composition, key repeat, and platform text services such as spell check, dictation and autocorrect.
- Features not built: scrolling, undo and redo, bidi, tab stops (a tab is a space with a measured width), kerning and shaping across glyphs, break opportunities other than spaces and newlines (e.g. between CJK ideographs, at zero-width spaces, after hyphens, and at soft hyphens), double-click word selection, and laying out again after a font change.

## Open questions and next steps

- **Runs of ones as a runtime group kind.** Every one-hot group here is neighbor differences of a run of ones: fit bits, `[caret >= p]`, and line ramps. If the executor accepted a declared run of ones and used its count as the gather index, the difference atoms would go away. At capacity 256 that is about 3,300 per layout key (12 line groups and the caret group of 257 positions each) and 6,700 for the final layout (the glyph positions add 256 groups of 12).
- **Shallower line walks.** Each line slot takes 12 layers: a materialized fit limit (1), the fit comparisons (1), neighbor differences (1), a gather (2, a product and a sum, even though the compiler lowers it to a table read), the inside-word comparison (1), a pick (2), the end-of-text score and comparison (2), and a final pick (2). Comparing the fit edges against the start key plus maxWidth directly would remove the first layer. Computing the end-of-text bit for each case in parallel and reading the next start through one gather over a combined case one-hot might remove about 2 more, bringing a slot to about 9 layers. Getting close to 6 would need runtime changes, such as a gather read that takes one layer and runs of ones accepted as groups.
- **More break opportunities.** Only spaces and newlines open break opportunities, so CJK text wraps differently from pretext in 2,023 of 2,460 layouts in `pretext-agreement.ts`. For example, for `black 字本국日…` at 39.25px, pretext fits `k 字` on the second line, while the editor sees `字本국日…` as a run with no break opportunities, moves the whole run to the next line, and breaks it only where a glyph overflows. A break before and after every ideograph would need another class and more leaves in the latest-opportunity scans. Punctuation that can't start or end a line (kinsoku rules) would need rules that look at neighboring cells.
- **Scrolling.** Carry the start cell and key of the first visible line in state, lay out only the visible line slots from there, and update the carried start when the caret leaves the window.
- **Word cells.** Wrapping over words instead of characters would shrink the per-line comparisons from capacity to the number of words, but caret positions inside words still need per-character tables.
- **Undo.** A shift register of states costs O(capacity) cells per record. Recording only the edit range and removed codes per record would be cheaper.
- **Generated code at this size.** At capacity 256, generated JS needed 12 to 20 seconds of continuous evaluation to optimize and still lost to the executor. It's unclear whether the cause is the function count, the 257-bit gather index loops, or wide rows such as the 256-term fit counts. Loops over packed index arrays instead of one statement per term would shrink the code a lot.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/text-editing/demo.html`.

- The page loads with no console errors and focuses the field. The stats show 92,683 live ops, 536 layers, 187,981 stored weights and 430 gather reads, built in 609 ms, with 157 of 256 cells and 4 of 12 lines used.
- Checked by hand: clicking places the caret, and typing " really" inserts at the caret and rewraps the paragraph to 5 lines. 7 Backspaces bring back the original text. Option+Left twice jumps to the start of "its", and Shift+Right 5 times selects "its e". ArrowDown, ArrowDown, ArrowUp keeps the preferred x. Dragging across the second and third lines selects across both lines.
- A script then pressed Command+ArrowDown and 10 Enters: the warning "The text needs more than 12 lines…" appeared, and 10 Backspaces cleared it. Typing "é, 字, 👋" added 5 graphemes to the width table (30 to 35 entries).
- The stats showed 1.4 to 12.3 ms for the last frame, which can hold several evaluations.
- Small problems in the first check: while the text needs more than 12 lines, the caret sits at x = 4,096 px, far right of the field, since its line isn't laid out. After the emoji, the next glyph starts 4 px further right than the emoji's drawn width, because canvas measured the emoji at 21 px and the DOM draws it at 17 px.
- Fixed later in `demo.ts`: while the circuit's overflow output is set, the caret is hidden, and the warning now reads "The text needs more than 12 lines. Lines past the last slot aren't laid out, and the caret is hidden until the text fits; delete some text." The circuit is unchanged. `bun test lab/ui-exploration/text-editing` (17 tests) and `bunx tsgo -p lab/ui-exploration/text-editing` pass.
- Recheck in Chrome, with scripted keys: Command+ArrowDown, then Enters until the warning appeared. The circuit's caret x was 2,048 px this time, and the caret was hidden. After Command+ArrowUp, the caret's output was (0, 0), a position that could be drawn, but the caret stays hidden while the overflow output is set, because `projectFrame` gives the demo no signal for whether the caret's own line is laid out. Backspaces until the warning cleared brought the caret back at (0, 260) px, with 11 of 12 lines in use. No glyph was placed past x = 373 px, and there were no errors.
- Not fixed: the emoji width difference.

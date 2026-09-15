# Tabulated text

This prototype asks how far prepare-time tabulation carries text inside one circuit. For a prepared paragraph, pretext's results only change at a few widths. So a JS prepare step can find every width where a result changes, and a circuit can turn one runtime width into line counts, block heights, shrink-wrapped bubble widths, a balanced heading, and the start and end cursor of every painted line. The circuit only needs one comparison per threshold and one sparse weighted sum per output.

The demo is a Notes window whose width springs while you drag its right edge. A balanced heading, four paragraphs, and five chat bubbles reflow every frame. One compiled circuit handles the drag, the springs, and all text decisions. JS decodes the frame clock into step bits, records pointer events, and slices line text when a line's cursors change.

How to run it, from `~/github/indirect`:

- Demo: `bun lab/ui-exploration/text-tabulated/demo.html`. The panel shows a live check of every frame against pretext's own `layoutWithLines`, `measureLineStats`, and the bubbles demo's tight-width search, using the browser's real fonts. It counts frames with a wrong decision (line count, tight width, cursor, or line text) separately from the widest width drift, because delta rows add up width deltas in FP32 and real advances don't add up exactly. I haven't run the demo myself. A verification run in Chrome, made before the check was split, showed `maxLineWidth 589.6193237304688 != 589.6194152832031` on the first frame, a drift of 9.2e-5px. That old check required bit-equal widths, so it counted all 7 frames as divergent and couldn't show whether any decision was wrong. Every headless check below uses a fake canvas.
- Tests (about 0.4 seconds): `bun test lab/ui-exploration/text-tabulated`
- Types: `bunx tsgo -p lab/ui-exploration/text-tabulated`
- Measurements: `bun lab/ui-exploration/text-tabulated/report.ts [corpora] [hn] [oracle] [long] [rich] [prewrap] [notes] [edit] [scale] [nondyadic]`. With no arguments it runs everything, which takes a few minutes. `nondyadic` uses a different fake canvas, so it runs on its own or in a second process.
- Monotonicity search, one engine profile per process: `bun lab/ui-exploration/text-tabulated/monotone-search.ts blink|webkit|gecko [--kerning] [--only text|rich] [--texts 400] [--seed 11] [--out file.json] [--no-shrink]`

`pretext/` is an unmodified copy of pretext's `src/` (clone revision 477510e4, without `layout.test.ts` and `test-data.ts`), so the folder runs on its own. `report.ts` reads pretext's corpora and `src/test-data.ts` from the clone in the session scratchpad (`scratchpad/pretext-copy`), and the HN thread from `~/github/vibescript/demos/nicer-hacker-news/data.ts`. No runtime files were changed; the prototype imports `numeric-ui-core.ts` as is.

## What was built

- `tabulate.ts`: the JS prepare step. It treats pretext as a black box, e.g. `measure(width) = walkLineRanges(prepared, width)`. It samples FP32 widths every 1px, and wherever two neighboring samples differ, it bisects over FP32 bit patterns until the two widths are adjacent FP32 values. Each threshold is therefore the smallest FP32 width at which its piece holds. Blocks come in two modes. A plain block lays out at its max width. A shrink-wrapped block lays out at the smallest integer width that keeps the line count, which is what pretext's bubbles demo does with a binary search. The balanced heading uses the same rule and centers its lines. The table holds the line count, max line width, layout width, and each line slot's start cursor id, end cursor id, and width. A block's max width can be any nondecreasing JS formula of the shared width, e.g. `Math.floor(chatWidth * 0.8) - 24` for bubbles. The circuit never evaluates the formula, because thresholds are found in units of the shared width.
- `step-circuit.ts`: the circuit builders.
  - `[width >= threshold]` is two ReLU gates on `512 * width + 0.5 - 512 * threshold` and `512 * width - 0.5 - 512 * threshold`, their difference as a rounding point, and the boolean atom: 4 atoms, 3 layers. It's exact for every FP32 width in 0..8192 when the threshold is 0 or between 2^-10 and 8192px. Multiplying by a power of two is exact, the bias is representable, and near the threshold the FP32 sum cancels exactly, so the score is exactly 0.5 at equality (rounds to 1) and below 0.5 one ulp under the threshold. Smaller thresholds break this, e.g. for a threshold of 1e-4px the bias rounds and a width one ulp under it reads as 1, so `emitAtLeast` refuses them. Every table threshold here is at least 2px. `step-circuit.test.ts` checks 3 FP32 ulps on either side of over 600 thresholds, including every power of two from 2^-10 to 2^13. No 26-layer sign cascade was needed.
  - Delta rows: `output = base + sum over thresholds of bit * delta`, with the deltas as constant weights. There are no products, and only nonzero deltas are stored. Changing the text means rebuilding the circuit.
  - Gathered rows: neighbor differences of the bits form a one-hot over pieces, and each output is a masked read of table cells in the source table. The compiler lowers each output to one gather read. Changing the text within the table's capacity means rewriting cells, with no recompile.
  - A runtime uniform font scale: `[width + epsilon >= scale * (threshold + epsilon)]`, for advances that scale linearly with the font size.
- `springs.ts`: fixed 4ms springs, as in vibescript's Animation.md. JS turns the frame time into a step count (at most 300) and writes its 9 bits into source cells. The circuit multiplies the selected constant powers of the 2x2 step matrix once per frame, and every spring reads that one runtime matrix with 4 products, plus the same settle snap as `emitSpring`.
- `notes-machine.ts`: the Notes window. It has a press latch on the right-edge grip, a target width clamped to 280..1100px, a width spring, and the content width. It also has 10 blocks of text tables, a height spring per block, a width spring per bubble, and block tops as one wide sum per block. Each line slot outputs its cursor ids, x (centered for the heading, right-aligned for the user's own messages), y, and an opacity that fades a line in as the springing height uncovers it. `materializeSlot` turns cursor ids back into text with pretext's `materializeLineRange`.
- `reference.ts` and `geometry-reference.ts`: direct pretext calls to check against (`layoutWithLines`, `measureLineStats`, and `findTightWrapWidth`, copied from pretext's `bubbles-shared.ts`), and a float64 JS mirror of the drag logic, springs, and stacking. `compareBlock` reports wrong decisions (line counts, tight widths, cursors, line text) separately from width drift.
- `notes-trace-check.ts`: drives the whole Notes machine through scripted resize traces and compares every frame with pretext and with the float64 mirror. The test runs it with the dyadic fake canvas, and `report.ts nondyadic` runs it with non-dyadic advances.
- `resize-trace.ts`: scripted drags past both clamps with jitter and uneven frame timing (mostly 4 steps, some 2, some stalls of 30-90 steps), used by the tests and by the demo's autopilot button.
- `monotone-search.ts`: searches for widths where the line count goes up as the width grows, or a line's start cursor moves backward. With the fake canvas, every advance is a multiple of fontSize/64, so results can only change at widths `g - epsilon` or `g` for g on that grid. Sampling once inside each interval between such widths is exhaustive, and it gives each band's exact width. A band is a run of widths whose layouts are behind the layout just before the run, e.g. more lines, or a line starting earlier. Every generated case is swept over its whole width range and every band is counted. Shrinking (dropping items, item options, and characters while a band survives) is only used to print minimal examples. The search covers random texts with emergency breaks, dashes, URLs, soft hyphens, NBSP, ZWSP, word joiners, ZWJ, CJK, emoji, numbers, NEL, tabs and newlines (pre-wrap), keep-all, and letter spacing from -2.5 to 4. It also covers random rich inline flows with chips, extra widths, and mixed font sizes. `--kerning` makes some letter pairs, and letters before a space, narrower together than apart.
- `fake-canvas.ts`, `float32.ts`: the fake canvas from phase 1 with two options, and FP32 bit-pattern stepping. `kerning` is described above. `nonDyadic` scales every character's advance by its own factor between 1 and 1.05, so widths aren't multiples of a power-of-two fraction, partial sums round in float64 and FP32 the way real advances do, and thresholds of different paragraphs rarely coincide.
- `demo.html`, `demo.ts`, `demo.css`: the browser demo. A ruler above the window marks every width where some block's line count changes, and a marker follows the content's right edge.

## Measured results

Structural counts are exact. Timings are rough, because about a dozen agents share this machine. Unless noted, all checks use the fake canvas with the Blink profile (`lineFitEpsilon` 0.005).

### Exactness against pretext

- `bun test lab/ui-exploration/text-tabulated`, `notes-machine.test.ts`: two scripted resize traces (729 frames) drive the whole Notes machine. Every frame, every block is compared against pretext at the circuit's own FP32 content width: line count and max line width against `measureLineStats`, and each slot's cursors and materialized text against `layoutWithLines`. The heading and bubble layout widths are checked against the bubbles demo's search. All 7,290 block comparisons match, with bit-equal widths. The springs and stacking stay within 0.01px of the float64 mirror, and a 1,143-frame scratch run measured at most 0.00024px. The drag reaches both clamps, and the spring never leaves the tabulated range.
- `tabulate.test.ts`: plain text, soft hyphens with a URL and emergency breaks, pre-wrap tabs and newlines, letter spacing, and CJK. Both delta rows and gathered rows match pretext at every threshold, one FP32 ulp below and above it, and 400 random widths. A capacity test writes an edited paragraph's table into the same gathered cells without recompiling, and it still matches.
- `report.ts oracle`: pretext's own test data from `src/test-data.ts`, widths 2..700.

| group | cases | thresholds | widths checked | wrong line counts or cursors | delta rows: widths with a width output not bit-equal | delta rows: largest width drift (px) | gathered rows: widths not bit-equal on any output |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TEXTS | 28 | 2,521 | 10,363 | 0 | 0 | 0 | 0 |
| DISCRETIONARY_ORACLE_CASES | 11 | 37 | 1,211 | 0 | 0 | 0 | 0 |
| LETTER_SPACING_ORACLE_CASES | 14 | 239 | 2,117 | 0 | 179 | 3.8e-6 | 0 |
| PRE_WRAP_ORACLE_CASES | 14 | 94 | 1,682 | 0 | 0 | 0 | 0 |
| SYMBOL_ORACLE_CASES | 3 | 218 | 954 | 0 | 0 | 0 | 0 |
| KEEP_ALL_ORACLE_CASES | 11 | 131 | 1,493 | 0 | 0 | 0 | 0 |

Decisions are exact everywhere. Delta rows add up width deltas in FP32, so when a delta isn't exact in FP32, e.g. with letter spacing -0.8, a width output drifts: up to 3.8e-6px on these cases with the fake canvas. Gathered rows read the stored value directly and are bit-equal.

### Non-dyadic advances (`report.ts nondyadic`)

Every other check uses a fake canvas whose widths are multiples of fontSize/64, so partial sums are exact and different paragraphs often get the same thresholds. `report.ts nondyadic` runs three of the checks again with every character's advance scaled by its own factor between 1 and 1.05.

pretext's test data, as in the table above:

| group | cases | thresholds | widths checked | wrong line counts or cursors | delta rows: widths with a width output not bit-equal | delta rows: largest width drift (px) | gathered rows: widths not bit-equal on any output |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TEXTS | 28 | 3,658 | 13,774 | 0 | 13,581 | 1.2e-4 | 0 |
| DISCRETIONARY_ORACLE_CASES | 11 | 37 | 1,211 | 0 | 1,077 | 3.8e-6 | 0 |
| LETTER_SPACING_ORACLE_CASES | 14 | 274 | 2,222 | 0 | 2,098 | 2.3e-5 | 0 |
| PRE_WRAP_ORACLE_CASES | 14 | 97 | 1,691 | 0 | 1,255 | 7.6e-6 | 0 |
| SYMBOL_ORACLE_CASES | 3 | 299 | 1,197 | 0 | 1,167 | 1.8e-4 | 0 |
| KEEP_ALL_ORACLE_CASES | 11 | 149 | 1,547 | 0 | 1,469 | 1.5e-5 | 0 |

- The Notes window's two scripted resize traces (729 frames, 7,290 block comparisons) have 0 wrong line counts, tight widths, cursors, or line texts. Every frame has some maxLineWidth drift, at most 1.8e-4px. Centered heading lines are off by at most 1.5e-5px, and springs and stacking stay within 2.2e-4px of the float64 mirror.
- Thresholds of different paragraphs stop coinciding, so the heights circuits lose almost all of their shared comparisons (see the next sections for the dyadic numbers):

| corpus | paragraphs | line count thresholds | distinct values | heights circuit: live ops / layers / weights | one width cell per paragraph: live ops / weights |
| --- | --- | --- | --- | --- | --- |
| en-gatsby-opening | 1,643 | 5,210 | 5,185 | 22,033 / 4 / 31,109 | 22,159 / 31,260 |
| ar-al-bukhala | 2,717 | 5,983 | 5,983 | 26,227 / 4 / 35,894 | 26,231 / 35,898 |

So decisions stay exact without dyadic advances, delta row widths drift by a few FP32 ulps, and the verification run in Chrome (9.2e-5px on one frame) falls in the same range.

### The Notes window (`report.ts notes`)

| circuit | live ops | layers | stored weights |
| --- | --- | --- | --- |
| whole Notes machine | 2,030 | 48 | 3,628 |
| text tables alone, painting outputs | 1,041 | 4 | 1,972 |
| text tables alone, line counts only | 190 | 4 | 270 |
| 16 springs sharing one step matrix | 600 | 22 | 1,100 |

The 10 blocks hold 244 thresholds in total. The paragraphs have 40, 62, 88, and 40 thresholds with 6, 9, 11, and 5 line count changes, and the bubbles and heading have 0 to 4 each. Tabulating everything with the fake canvas takes 16ms, and building and compiling the machine takes 5ms. The same outputs as gathered rows would take 5,792 source cells. For comparison, IndirectOS with Photos is 5,253 live ops, 192 layers, and 11,598 weights.

| per frame, rough | µs |
| --- | --- |
| Notes circuit step: drag, springs, all text outputs | 12.7 |
| calling pretext for the same text outputs (`layoutWithLines`, `measureLineStats`, tight-width searches) | 14.0 |
| pretext `layout()` for heights only | 2.4 |

### Realistic content (`report.ts corpora hn`)

Every paragraph of pretext's corpora gets its own table over widths 300..900 (the corpora's sweep range). The heights and painting columns are one circuit per corpus. In the plain columns every paragraph reads one shared width, so a threshold that several paragraphs have becomes one comparison. In the "one width cell per paragraph" columns every paragraph reads its own width cell, so no comparison is shared.

| corpus | paragraphs | characters | line count thresholds: total / most in one paragraph | distinct line count threshold values | all thresholds: total / most | heights circuit: live ops / layers / weights | heights, one width cell per paragraph: live ops / weights | painting circuit: live ops / weights | painting, one width cell per paragraph: live ops | tabulate s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mixed-app-text | 5 | 1,069 | 23 / 5 | 23 | 199 / 50 | 97 / 4 / 138 | 97 / 138 | 819 / 1,365 | 839 | 0.0 |
| en-gatsby-opening | 1,643 | 269,747 | 5,060 / 27 | 1,875 | 45,050 / 263 | 8,748 / 4 / 14,374 | 21,549 / 30,360 | 17,628 / 133,547 | 188,328 | 1.3 |
| ja-rashomon | 35 | 5,702 | 249 / 16 | 33 | 1,060 / 89 | 162 / 4 / 377 | 1,030 / 1,494 | 778 / 6,965 | 4,666 | 0.0 |
| ja-kumo-no-ito | 17 | 2,874 | 118 / 21 | 28 | 419 / 30 | 126 / 4 / 252 | 487 / 708 | 331 / 3,224 | 1,888 | 0.0 |
| ko-unsu-joh-eun-nal | 83 | 10,272 | 328 / 11 | 218 | 5,862 / 205 | 943 / 4 / 1,418 | 1,383 / 1,968 | 5,128 / 24,032 | 24,028 | 0.2 |
| ko-sonagi | 218 | 8,021 | 235 / 3 | 174 | 3,054 / 47 | 835 / 4 / 1,094 | 1,088 / 1,410 | 2,974 / 7,018 | 12,668 | 0.1 |
| zh-zhufu | 111 | 9,428 | 395 / 18 | 50 | 2,207 / 61 | 270 / 4 / 601 | 1,671 / 2,370 | 1,110 / 10,037 | 9,540 | 0.1 |
| zh-guxiang | 96 | 5,717 | 238 / 10 | 59 | 1,998 / 73 | 299 / 4 / 498 | 1,029 / 1,428 | 1,352 / 6,166 | 8,440 | 0.1 |
| th-nithan-vetal-story-1 | 99 | 34,033 | 854 / 30 | 636 | 9,097 / 332 | 2,641 / 4 / 4,034 | 3,513 / 5,124 | 8,931 / 46,541 | 37,759 | 0.2 |
| th-nithan-vetal-story-7 | 123 | 30,209 | 764 / 34 | 603 | 7,771 / 353 | 2,535 / 4 / 3,779 | 3,179 / 4,584 | 8,699 / 36,323 | 32,347 | 0.2 |
| my-cunning-heron-teacher | 7 | 2,707 | 71 / 13 | 70 | 598 / 116 | 287 / 4 / 421 | 291 / 426 | 2,173 / 4,533 | 2,505 | 0.0 |
| my-bad-deeds-return-to-you-teacher | 5 | 1,666 | 42 / 12 | 41 | 368 / 111 | 169 / 4 / 247 | 173 / 252 | 1,438 / 2,905 | 1,542 | 0.0 |
| km-prachum-reuang-preng-khmer-volume-7-stories-1-10 | 46 | 24,240 | 490 / 83 | 430 | 5,396 / 819 | 1,758 / 4 / 2,640 | 1,998 / 2,940 | 7,841 / 47,252 | 22,357 | 0.4 |
| ar-risalat-al-ghufran-part-1 | 517 | 106,857 | 2,533 / 45 | 1,240 | 18,529 / 348 | 5,393 / 4 / 8,730 | 10,568 / 15,198 | 11,688 / 78,013 | 78,135 | 0.6 |
| ar-al-bukhala | 2,717 | 256,837 | 5,800 / 47 | 1,636 | 38,600 / 379 | 8,517 / 4 / 13,678 | 25,475 / 34,800 | 16,888 / 105,428 | 164,030 | 1.1 |
| hi-eidgah | 94 | 24,077 | 550 / 50 | 450 | 4,904 / 448 | 1,887 / 4 / 2,799 | 2,288 / 3,300 | 7,790 / 33,639 | 20,523 | 0.2 |
| he-masaot-binyamin-metudela | 86 | 20,748 | 493 / 54 | 417 | 3,818 / 406 | 1,743 / 4 / 2,578 | 2,047 / 2,958 | 7,285 / 25,211 | 16,082 | 0.1 |
| ur-chughd | 34 | 13,391 | 300 / 32 | 270 | 3,028 / 328 | 1,114 / 4 / 1,650 | 1,234 / 1,800 | 6,495 / 21,568 | 12,607 | 0.1 |

Across all corpora, 5,936 paragraphs have 18,543 line count thresholds and 151,958 thresholds in total. Sharing a comparison between paragraphs is mostly an effect of the fake canvas. Every advance is a multiple of fontSize/64, so line widths of different paragraphs land on the same grid values, e.g. Gatsby's 5,060 line count thresholds take only 1,875 distinct values, and its heights circuit is 8,748 live ops against 21,549 without sharing. With the non-dyadic canvas above, Gatsby's thresholds are almost all distinct, and the shared circuit is 22,033 live ops. So with real fonts, the "one width cell per paragraph" columns are the ones to expect: 79,100 live ops for all the corpora's heights circuits together, against 37,524 with sharing.

The nicer-hacker-news "Steve Jobs has passed away" thread has 251 comments and 528 paragraphs (91,301 characters). Each paragraph's width is `windowWidth - indent * 24 - 44` for window widths 375..1200. It has 1,806 line count thresholds (1,247 distinct values, at most 45 in one paragraph) and 17,320 thresholds in total. The heights circuit is 5,417 live ops, 4 layers, and 8,037 weights, or 7,655 live ops and 10,836 weights with one width cell per paragraph. The painting circuit is 18,993 live ops and 58,917 weights, or 71,874 live ops and 125,127 weights with one width cell per paragraph. Tabulation takes 0.5s. The other seven threads in `data.ts` repeat the same 4 short comments.

### One long paragraph (`report.ts long`)

The first N words of The Great Gatsby as a single paragraph, widths 300..900, 16px.

| words | characters | tabulate ms | pretext calls | line count thresholds | all thresholds | line slots | cursor changes (start + end) | heights: live ops / weights | line count + max width: live ops / weights | painting: live ops / weights | painting as gathered cells |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 64 | 364 | 1 | 1,513 | 6 | 63 | 10 | 320 | 25 / 36 | 254 / 384 | 264 / 481 | 1,407 |
| 256 | 1,475 | 14 | 4,362 | 29 | 262 | 43 | 3,218 | 117 / 174 | 1,050 / 1,601 | 1,093 / 2,948 | 23,143 |
| 1,024 | 5,777 | 182 | 13,888 | 112 | 965 | 166 | 29,942 | 449 / 672 | 3,862 / 5,902 | 4,028 / 19,908 | 322,643 |
| 4,096 | 22,954 | 1,398 | 27,402 | 412 | 2,020 | 657 | 286,074 | 1,649 / 2,472 | 8,082 / 12,532 | 8,739 / 153,549 | 2,659,635 |

Heights stay linear in the text length: about one line count threshold per 50 to 56 characters. Painting grows roughly with lines times thresholds, because a line slot's start changes whenever any earlier break moves. Delta rows store fewer weights than there are cursor changes, because the rows for "line k ends" and "line k + 1 starts" are identical and deduplicate.

### Rich inline, pre-wrap, font scale, and editing

`report.ts rich`, widths 40..700, with a 15-item rich note from phase 1 (chips, code spans, CJK) and a 24-item chat message:

| flow | tabulate ms | line count thresholds | all thresholds | layout changes on an exhaustive 1/64px sweep | line count increases on that sweep | widths where the table disagrees with pretext | painting circuit: live ops / layers / weights |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rich note, 15 items | 14 | 54 | 138 | 138 | 6 | 0 of 84,482 | 646 / 4 / 2,480 |
| chat message, 24 items | 30 | 96 | 311 | 311 | 7 | 0 of 84,482 | 1,436 / 4 / 7,759 |

`report.ts prewrap`, widths 40..800, 13px: a tab-separated table (126 characters) has 16 line count thresholds and 32 in total. A tab-indented code block (353 characters) has 62 and 199. A chat log with blank lines (127 characters) has 23 and 61. Line count and max width match pretext at 0 of 1,064, 1,398, and 1,122 checked widths.

`report.ts scale`: a paragraph tabulated at 15px, with a runtime font scale, is 49 live ops, 4 layers, and 96 weights. Against pretext re-prepared at 12, 15, 18, 22.5, and 30px, the line count disagrees at 0 of 2,923, 0 of 3,060, 7 of 2,972, 4 of 2,824, and 0 of 2,593 checked widths. Only widths inside both the base range 150..1100px and the scaled table's range are checked, so 2, 0, 1, 1, and 2 of the 12 scaled thresholds fall outside the check. Every disagreement is within 2.8e-5px of a scaled threshold, where FP32 rounding of the product decides. This relies on advances scaling linearly with font size, which the fake canvas does exactly and real fonts don't.

`report.ts edit`: typing into the second Notes paragraph one character per edit, 131 edits each for appending and for inserting in the middle. Every edit re-prepares and re-tabulates the whole paragraph:

| edit | prepare ms: median / max | tabulate ms: median / max | rebuild and compile the whole Notes circuit ms: median / max | thresholds added or removed per keystroke: median / max |
| --- | --- | --- | --- | --- |
| append | 0.07 / 0.18 | 0.8 / 2.5 | 2.5 / 4.8 | 3 / 7 |
| insert in the middle | 0.05 / 0.72 | 0.7 / 1.8 | 2.3 / 3.2 | 45 / 61 |

### Does the line count ever go up as the width grows?

For plain text (`layout`, `walkLineRanges`), I found no case. `monotone-search.ts --only text --texts 400 --seed 11` checked 400 random texts for each of Blink, WebKit, and Gecko, with and without kerning (2,400 texts), exhaustively on the fake canvas grid from 0.25px to 700px. It found 0 line count increases and 0 backward line starts. The phase 1 staircase checks over HN paragraphs and gallery prompts agree.

For rich inline, yes, in almost every random flow. `monotone-search.ts --only rich --texts 80 --seed 12` sweeps each random flow, as generated, over every interval from 1px to 500px and counts every band, i.e. every run of widths whose layouts are behind the layout just before the run:

| engine profile | flows with a backward step | flows with a line count increase | bands | bands one epsilon wide | wider, under 1px | 1px or more | flows with a band of 1px or more (with a line count increase) | widest band (px) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Blink | 71 of 80 | 69 | 1,696 | 1,691 | 0 | 5 | 3 (2) | 5.5 |
| Blink, kerning | 71 | 69 | 1,714 | 1,708 | 0 | 6 | 4 (2) | 5.5 |
| WebKit | 71 | 69 | 1,654 | 1,567 | 11 | 76 | 31 (21) | 8.9 |
| WebKit, kerning | 71 | 69 | 1,663 | 1,577 | 5 | 81 | 31 (20) | 9.5 |
| Gecko | 71 | 70 | 2,167 | 2,073 | 13 | 81 | 32 (24) | 8.9 |
| Gecko, kerning | 71 | 70 | 2,183 | 2,089 | 9 | 85 | 32 (23) | 10.4 |

Two different things happen.

Most bands are exactly one epsilon wide: 0.005px in Blink and Gecko, 1/64px in WebKit. A minimal flow in the Blink profile, found by shrinking a random flow, is `[{text: 'q', font: '12px Test Sans'}, {text: '-w', font: '20px Test Sans'}]`. At 23.18px the lines are "q-" and "w". From 23.1825px to 23.1874px they are "q" and "-w", and from 23.1875px everything fits on one line. The cause is in `stepRichInlineLine`. The item's walker fits "-w" within `availableWidth + lineFitEpsilon`, but the rich line then checks `lineWidthContribution > remainingWidth` without the epsilon, so it wraps before the whole item. The same mismatch also adds lines, e.g. `[{text: 'u', font: '16px Test Sans'}, {text: '了解で', font: '20px Test Sans'}]` has 3 lines from 46.995px to 47px, and 2 lines just below and just above.

Bands of 1px or more all involve soft hyphens: every flow with such a band has a soft hyphen, and sweeping those flows again with the soft hyphens removed leaves no band of 1px or more, in all six profiles. A minimal flow in the Gecko profile is `[{text: 'T', font: '12px Test Sans'}, {text: 'po­d', font: '16px Test Sans'}]`, with a soft hyphen inside "pod". At 24.1px the lines are "Tp" and "od". From 24.12px to 29.625px the layout is behind that: first "T", "po-", "d" (one more line), then "T", "pod" (the second line starts earlier). From 29.625px the lines are "Tpo-" and "d". I didn't trace which branch does that. A few bands in Gecko and WebKit are still behind at 500px, where the sweep ends, so their widths are lower bounds.

These counts replace an earlier version of the search. It shrank each flow to the smallest flow that still had any backward step before measuring, and stopped at the first backward step, so it mostly measured the epsilon case. It reported 23 to 29 line count increases per profile, and only 2 flows each in Gecko and WebKit that stayed behind for over 1px. The generator's NBSP and NEL pieces also held a plain space and no NEL. They now hold U+00A0 and U+0085, as the code comments say, so per-flow counts differ slightly from earlier runs with the same seed.

Tabulation can only miss a change that changes back between two widths it compares. Bands of 1px or more are always sampled, and the epsilon bands on the two realistic flows sit right next to a real change, so bisection found them: 0 of 84,482 exhaustive widths disagree with the table. Neither realistic flow has a soft hyphen. The bubbles demo's binary search for the tight width assumes the line count never goes up, so for rich inline its answer can differ from the true smallest width, by several px when a soft hyphen is involved.

## What this shows about how far the approach goes

### What fit well

- Heights are small and shallow. The painted Notes window's text tables are 4 layers deep whatever the text. Block heights for the 1,643 paragraphs of Gatsby's opening cost 21,549 live ops when no comparison is shared, which is what real fonts would give (8,748 with the fake canvas, where many thresholds coincide). The layout decisions become comparisons, and the results become weights: a sparse matrix of deltas times a vector of comparison bits. That is the matmul primitive at its most literal.
- Exactness at the ulp level was cheap. Snapping thresholds to FP32 widths at prepare time lets a 4-atom comparison reproduce pretext's float64 decision at every FP32 width. So line membership, cursors, and line counts are exact bits and integers, with no cascade.
- The black box absorbed everything pretext does on the single-paragraph APIs: soft hyphens, emergency breaks at dashes, tabs, letter spacing, CJK, keep-all, and pre-wrap chunks. There was no feature-specific code, and 0 wrong decisions on pretext's own oracle cases.
- Searches whose answer is a function of a step function, e.g. the bubbles demo's tight width or balanced text, move entirely into the prepare step. The circuit then only reads the answer for the current piece. JS formulas in a block's width, including `Math.floor`, also move into the prepare step.
- The shared-width circuit composes like any other UI state. The springing window width feeds the tables, and the tables feed height and bubble-width springs that share one step matrix. The whole Notes window (2,030 live ops) would add less than half of IndirectOS's size to IndirectOS.
- Edits are affordable at UI scale. Re-preparing, re-tabulating, and recompiling the whole Notes circuit took about 3ms per keystroke with the fake canvas.

### What got awkward

- Painting costs grow with lines times thresholds. A 4,096-word paragraph needs 2,472 weights for its height but 153,549 for every line's cursors, or 2.66 million gathered cells. Every line slot repeats every earlier break change. Across many paragraphs, comparisons add up too: Gatsby's painting circuit is 17,628 live ops with the fake canvas's shared comparisons and 188,328 without. Painting only the visible lines, or restricting the width range, would help. The algorithmic formulations from phase 1 don't have this growth, but they pay for computed-index reads instead.
- Text either lives in weights or in cells. Delta rows are small but need a rebuild on every edit. Gathered rows allow edits within a capacity, but they store pieces times outputs (5,792 cells for the Notes window, against 1,972 weights). Delta rows also drift on widths when partial sums of advances aren't exact in FP32: up to 3.8e-6px on pretext's letter spacing cases with the dyadic fake canvas, up to 1.8e-4px with non-dyadic advances, and 9.2e-5px on one frame in Chrome. Decisions stay exact, and gathered rows stay bit-equal.
- The table covers a width range, and outside that range the circuit returns the edge piece. The Notes machine tabulates 200..1100px for a 232..1052px drag range, so spring overshoot stays inside.
- A black-box sampler can't prove it saw every change. For plain text the exhaustive search found no reversals. Rich inline has real reversals: epsilon-wide bands in almost every random flow, and bands of up to about 10px, often with an extra line, whenever a soft hyphen is involved. The sampler caught everything on the two realistic flows, but that is a measurement, not a guarantee. A finer step costs pretext calls linearly: the exhaustive 1/64px sweep took 120-211ms per flow, against 14-30ms for 1px sampling.
- A runtime font scale works, but it's only exact away from FP32 rounding of `scale * threshold`, and it assumes advances are linear in font size.

### What stayed outside the circuit

- Preparing text (segmentation, measurement), finding thresholds (thousands of pretext calls), and turning cursor ids into strings.
- Decoding the frame clock into step bits, and recording pointer events.
- Anything where a block's width isn't a single monotone function of one runtime value, e.g. a different width per line around an obstacle. That needs per-start rows (phase 1's section 5.4) or the algorithm itself in the circuit.
- Real fonts. Every headless check uses a fake canvas, with dyadic widths, or non-dyadic widths in `report.ts nondyadic`. The demo runs the same frame-by-frame comparison with the browser's canvas and counts wrong decisions apart from width drift, but I haven't run it since that change.

## Open questions and next steps

- Run the demo in Chrome, Safari, and Firefox, and watch the decision count. Real canvas widths aren't dyadic and aren't additive, so thresholds come from bisection only. Delta row widths will drift by a few ulps, as the one Chrome run and the non-dyadic fake canvas show. Reading widths through gathered rows would remove the drift.
- The rich inline epsilon mismatch between `stepPreparedLineGeometry` and `stepRichInlineLine` looks like a pretext bug rather than browser behavior, but I didn't compare against browsers. The soft hyphen bands, e.g. "T" followed by "po­d" in the Gecko profile, which is behind for 5.5px with an extra line, need a trace through `stepRichInlineLine`.
- Incremental re-tabulation: an edit at a character only changes lines at or after the line containing the character, so most of a long paragraph's table could be kept.
- Painting budget: tabulate cursor rows only for line slots near the viewport, or switch long paragraphs to phase 1's next-start table with a compiler pass that lowers "integer index, then read" to one gather.
- Two runtime variables that aren't a scale, e.g. width and a line clamp, or width and a column count, would need a table per value of the second variable, or thresholds that are functions of both.
- Put the Notes window into IndirectOS as an app, so the window's resize springs drive its text through the existing window geometry.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/text-tabulated/demo.html`.

- The page loads with no console errors. With the browser's fonts, the Notes window has 10 blocks and 235 thresholds, tabulated in 97 ms. The circuit has 1,985 live ops, 48 layers and 3,499 weights, and the panel showed between 25 and 98 µs per circuit step.
- Dragging the right edge widens the window up to the 1,052 px content width clamp and narrows it again. The heading rebalances, the paragraphs reflow, and the bubbles shrink-wrap and spring.
- The autopilot button runs the scripted resize traces. After 2,473 checked frames, the panel showed 0 frames with a wrong line count, tight width, cursor or line text, a widest maxLineWidth drift of 1.8e-4 px, and a widest heading line x drift of 1.5e-5 px. These drifts are in the same range as the non-dyadic fake canvas results above.
- Problem in the first check: dragging the grip selected all the text in the window, because only the title bar set `user-select: none`, and the pointerdown handler doesn't prevent the default.
- During fast autopilot drags, the text of a right-aligned bubble sometimes reaches past its bubble and gets cut off at the window's right edge for a few frames, while the bubble's width is still springing.
- Fixed later in `demo.css`: the page sets `user-select: none`, and only `.notes-content` and `.notes-panel` set `user-select: text`. The circuit starts a resize for a press within 8 px of the window's right edge, and half of that band lies outside the window, on the page background, so `user-select: none` on the grip element alone wouldn't cover it. `bun test lab/ui-exploration/text-tabulated` (10 tests) and `bunx tsgo -p lab/ui-exploration/text-tabulated` pass.
- Recheck in Chrome, with real mouse drags in a 738 by 767 px iframe of the page, scaled to fit the tab. Dragging from the grip narrowed the window from 640 to 444 px, and pressing 4 px outside the right edge and dragging right widened it to 555 px. Neither drag selected any text. Dragging across the first paragraph still selected "Every block of text in this window was meas…". The agreement panel showed 0 wrong frames out of 687, and there were no errors.

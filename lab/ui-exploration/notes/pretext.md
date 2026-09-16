# pretext's layout-time algorithms as circuits

Status, September 15, 2026: written in phase 1, before the round 2 prototypes. Later measurements are in the [exploration README's capability map](../README.md#capability-map), and the current runtime's contracts and costs in the repo root's [execution-model.md](../../../execution-model.md). What this note says about IndirectOS describes window-manager.ts before September 15, 2026, when its springs, hit tests, Photos clicks and window content sizes changed ([lab/status.md](../../status.md#runtime-additions-since-september-14-2026)).

These notes describe what pretext computes at prepare time and at layout time, the exact control flow of its line walkers, and several ways to express that layout work in Indirect's affine, ReGLU and boolean atoms. Every formulation below was built with `numeric-ui-core.ts` and checked against pretext's own output under bun, with zero mismatches. All file:line references point into a clone of pretext (https://github.com/chenglou/pretext) at commit 477510e4 (session scratch folder `pretext-copy`, not in the repo). The scripts are session scratch files too (scratch folder `phase1/pretext/`, not in the repo).

The short version:

- The prepare/layout split already separates what a circuit cannot do (strings, Intl segmentation, Unicode tables, canvas measurement, DOM reads) from what it can (arithmetic over arrays). At layout time, the only exception is rich inline's emergency fill, which builds strings and runs `Intl.Segmenter` (`rich-inline.ts:341-364`).
- Every decision a line walker makes compares a width sum that does not depend on `maxWidth` against `maxWidth + lineFitEpsilon`, or against a remaining width derived from `maxWidth`. So every layout result is a piecewise-constant function of `maxWidth`, and there are few pieces. For a 1023-segment paragraph, `layout().lineCount` changes only 314 times between 72px and 4096px.
- The cheapest circuit for any fixed-width API tabulates those breakpoints at prepare time, then uses one comparison per breakpoint and one affine sum per output. That is 6 layers regardless of text size. This covers `layout()`, `measureLineStats()`, `measureRichInlineStats()`, and the bubbles demo's tight width, which is also what balanced text needs. For 1023 segments, lineCount is 1,885 live operations. IndirectOS is 5,253.
- Expressing the walker itself as arithmetic works cleanly for the fast path. "Where would a line starting at segment s end" is a count of comparisons against prefix sums, for all starts at once, in 4 layers. The expensive part in this substrate is recovering the actual line starts, because reading a table at a computed index costs about 3 atoms per table position. Sequential per-line recovery, pointer jumping and a segment scan were each measured. None comes close to the tabulated circuit's size.

## 1. Prepare time versus layout time

### Prepare time (strings, Unicode, fonts)

`prepare()` and `prepareWithSegments()` call `prepareInternal` (`layout.ts:743-756`). That function reads the page language once, picks an engine profile (`measurement.ts:279-311`, chosen from `navigator.userAgent`), then runs two phases.

Analysis (`analysis.ts:2286-2315`, `analyzeText`):
- It normalizes collapsible whitespace (`normalizeWhitespaceNormal` at `analysis.ts:141`), or preserves spaces, tabs and newlines in pre-wrap.
- It segments words with `Intl.Segmenter`, then merges pieces that must not break internally: punctuation into the preceding word, URLs (`mergeUrlRuns`, 996), numeric runs (`mergeNumericRuns`, 1356), glue-connected runs (`mergeGlueConnectedTextRuns`, 1520) and no-space word chains (1452).
- It splits CJK text into line-break units (`getCjkTextUnits`, 2233) and applies keep-all rules (1941).
- It classifies every segment into one of nine kinds (`SegmentBreakKind` at `analysis.ts:6-15`, classified by `classifySegmentBreakChar` at 770-786): `text`, `space`, `preserved-space`, `tab`, `glue` (NBSP, U+2007, U+202F, U+2060, U+FEFF), `zero-width-break` (ZWSP), `soft-hyphen`, `hard-break` (`\n` in pre-wrap), `control` (NEL, WebKit profile only).

Measurement (`layout.ts:247-741`, `measureAnalysis`):
- It measures each segment with canvas `measureText`, cached per font and segment string (`measurement.ts:249-259`).
- The emoji correction may read DOM geometry once per font (`measurement.ts:327-356`).
- In the WebKit profile, text before a U+0020 space is measured together with that space, minus an unshaped space, so the text keeps its kerning with the space (`layout.ts:308-337`). Deciding whether that applies scans bidi classes (`layout.ts:349-417`).
- Soft hyphen width is set to 0 (`layout.ts:609-625`). The Blink profile also checks whether the neighbors measure narrower joined than apart, and records that per segment in `discretionaryHyphenContexts` (`layout.ts:449-464`, compared against `lineFitEpsilon` at 463).
- A hard break pushes a chunk (`layout.ts:627-637`). A tab gets width 0, because its advance depends on the line position (`layout.ts:639-650`).
- Word-like text and independent symbol runs get per-grapheme fit advances (`layout.ts:552-591`, `measurement.ts:379-458`). There are three modes: summed isolated graphemes, pair context (numeric runs, or runs over 96 graphemes), and prefix differences (letter spacing, or the WebKit profile). They also get preferred break positions after dashes (`analysis.ts:2269-2284`).
- Blink and Gecko desktop segments containing default-ignorable code points get fresh-entry geometry (`entry-geometry.ts:66-125`): up to three measured head widths per possible resume grapheme, plus an admission width.
- With `letterSpacing`, internal gaps are added to each width (`layout.ts:198-200`) and `spacingGraphemeCounts` records which segments own gaps.
- In the rich path only, approximate bidi levels are computed (`bidi.ts:202-211`). The line breaker never reads them.

Rich inline preparation (`rich-inline.ts:446-653`) prepares each item separately. It then analyzes the text that items join between collapsible spaces to find where breaks really fall (`getJoinedBreakOffsets` at 205-224). From that it records joined break cursors, local-only breaks, the width of each item's leading run, and a carry width that a following item adds to an item's last unbreakable run (backward loop at 632-647).

### Layout time (arithmetic over arrays)

Layout time reads the arrays below, plus the engine profile's `lineFitEpsilon`, `unfitHyphenRetreat` and `skipNarrowTabStops`. The core walkers do no string work and no canvas calls. Rich inline's layout does call string code in one branch: `fillItemSegment` → `getLastPreferredBreak` (`rich-inline.ts:341-364`) concatenates segment strings, runs a dash regex and `Intl.Segmenter`, and does `Array.from` over grapheme segments. Materializing line text (`line-text.ts:33-61`) is string work too, but that is output projection, not a layout decision.

For a circuit, the split holds as it is. JavaScript runs `prepare` once per text and font, writes the numeric arrays into the source table, and the circuit handles every width change.

## 2. Layout-time data

### PreparedCore (`layout.ts:60-76`)

| Field | Meaning | Circuit use |
| --- | --- | --- |
| `widths: number[]` | Advance per segment. Soft hyphen, hard break and tab are 0 (`layout.ts:609-650`). | Prefix sums, fit thresholds |
| `kinds: SegmentBreakKind[]` | One of nine kinds. | Static tables: fit contribution, paint contribution, skip at line start, break-after flag |
| `simpleLineWalkFastPath: boolean` | True only when every kind is `text`, `space` or `zero-width-break`, letter spacing is 0, and no segment has entry geometry (`layout.ts:421, 506-508, 514-517, 700`). | Chooses the formulation |
| `segLevels: Int8Array \| null` | Bidi levels per segment, rich path only. | Not needed for breaking |
| `breakableFitAdvances: (number[] \| null)[]` | Per-grapheme advances for segments that may take emergency breaks. | Grapheme units for emergency breaks |
| `breakablePreferredBreaks: (number[] \| null)[]` | Grapheme end positions after dashes inside those segments. | "Latest preferred break before overflow" selection |
| `letterSpacing: number` | Gap between rendered graphemes. | Leading and trailing gap corrections |
| `spacingGraphemeCounts: number[]` | Rendered grapheme count per segment. Empty when letter spacing is 0. | Which segments own a gap |
| `discretionaryHyphenWidth: number` | The '-' width, plus letter spacing in engines that space it (`layout.ts:263-265`). | Added to a soft hyphen break's fit and paint width |
| `discretionaryHyphenContexts: boolean[] \| null` | Blink only: a soft hyphen whose neighbors shape narrower joined. Blocks the unfit-hyphen return. | Static prefix count |
| `tabStopAdvance: number` | 8 × space width (`layout.ts:266-267`). | Constant for the tab advance |
| `chunks: PreparedLineChunk[]` | `{startSegmentIndex, endSegmentIndex, consumedEndSegmentIndex}` per hard-break paragraph (`layout.ts:134-138`). An empty chunk (two consecutive `\n`) is an observable empty line. | Forced breaks |
| `entryGeometry` (not in the type, present at runtime) | `terminalPrefixes` and per-start `{head, admissionFit}` (`entry-geometry.ts:7-11`). | Per-start widths that are not prefix differences |
| `segments: string[]` | Rich handles only. | JavaScript projection only |

### What the recipe script prints

`print-prepared.ts` prepares five paragraphs with a deterministic fake canvas and prints these arrays. For "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs!" at 16px:

```txt
segments=33 simpleLineWalkFastPath=true discretionaryHyphenWidth=5.5 tabStopAdvance=40
source widths=[25,5,40.25,5,43,5,26.25,5,41.5,5,35,5,26.5,5,32.75,5,33.5,5,32.75,5,16.25,5,25.25,5,31.75,5,33.75,5,44.25,5,49.75,5,39.75]
source kinds=[0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0]
maxWidth 320: 3 lines
  "The quick brown fox jumps over the lazy " width=305.25 start=0:0 end=16:0
  "dog. Pack my box with five dozen liquor " width=302.25 start=16:0 end=32:0
  "jugs!" width=39.75 start=32:0 end=33:0
```

The other samples show a soft hyphen line (`"trans-" width=51.75`), emergency breaks inside a URL that end at its preferred breaks (`"ports/q3-"` ends at grapheme 31), pre-wrap chunks with an empty line, tab lines (`"width\t" width=80`), and letter spacing (`spacingGraphemes` 6, 1, 6, ...).

## 3. Control flow of the line walkers

### Dispatch

`walkPreparedLinesRaw` (`line-break.ts:494-503`) picks `walkPreparedLinesSimple` when `simpleLineWalkFastPath` is true (499). Otherwise it normalizes the first start and runs `walkPreparedComplexLines`. The one-line APIs use `stepPreparedLineGeometryFromChunk` (1075-1088), which picks `stepPreparedSimpleLineGeometry` on the fast path when no end limit is given.

### Kind properties

- `breaksAfter(kind)` (`line-break.ts:56-64`) is true for space, preserved-space, tab, zero-width-break and soft-hyphen.
- `consumesAtLineStart(kind, atChunkStart)` (52-54) is true for space and soft-hyphen, and for zero-width-break unless the line is at a chunk start.
- `getWholeSegmentFitContribution` (108-118) gives break-after kinds a fit contribution of 0 (they hang), except tabs. Zero-width text also contributes 0, except control. Everything else contributes leading spacing + width + trailing letter spacing.
- `getLineEndPaintContribution` (122-128) gives space and zero-width-break a paint contribution of 0 at a line end.

### Fast path: `walkPreparedLinesSimple` (`line-break.ts:305-492`)

State: `lineW`, `hasContent`, start and end cursors, `pendingBreakSegmentIndex`, `pendingBreakPaintWidth`.

- 311: an empty text returns 0.
- 313-315: `fitLimit = maxWidth + lineFitEpsilon`.
- 426: `while (i < widths.length)`, the single sequential scan.
  - 427-430: at a line start, skip consumable segments with the `normalizeLineStartSegmentIndex` loop (66-78). ZWSP is kept only when `i === 0`. Break out when past the end.
  - 436-448: the first segment of a line. If `w > fitLimit` and the segment has fit advances, run `appendBreakableSegmentFrom(i, 0)`. Otherwise start the line with the whole segment, even when it overflows. A break-after segment records a pending break with paint width `lineW - w`.
  - 450-451: `newW = lineW + w; if (newW > fitLimit)`, the one fit comparison.
    - 452-457: an overflowing break-after segment is appended, hangs, and ends the line after itself. The line width excludes it.
    - 459-469: a pending break exists. If content was appended after it (`lineEnd > pending`), the line ends at `lineEnd`, which is just before `i`. Otherwise it ends at the pending break with the pending paint width. Either way, `i` is processed again as the next line's first segment.
    - 471-476: no pending break, and the overflowing segment is breakable and wider than the limit. End the line, then fill graphemes.
    - 478-479: otherwise end the line before `i`.
  - 482-487: append, and record a pending break after break-after kinds.
- 490: emit the last line.

`appendBreakableSegmentFrom` (378-423) finds the next preferred break by binary search (`getNextPreferredBreakIndex`, 149-167). It then loops over graphemes (388-417). On `lineW + gw > fitLimit` (393), it either emits at the last preferred break and jumps `g` back to that break, re-scanning graphemes after it (394-401), or emits and starts a new line at grapheme `g` (402-403). At 419-422, a line that reaches the end of the segment moves its end cursor to the segment boundary.

**Observation for circuits.** On the fast path, every boundary between two text segments is a break opportunity, because analysis already merged everything that must not break. So when no emergency break happens, the break always lands just before the first text segment that does not fit. The pending break only decides whether the reported width excludes a trailing space. Break placement is a pure threshold search over prefix sums.

### One line on the fast path: `stepPreparedSimpleLineGeometry` (`line-break.ts:947-1070`)

This is the same logic for one line, returning early. The loop at 964. At a line start, the emergency branch at 972-1017 has an inner grapheme loop (992-1012) that compares against `fitLimit` at 994 and returns at the preferred break or the overflow. The overflow branch at 1031-1055 returns after a hanging break-after segment, at a pending break, or before `i`. RESEARCH.md warns that this path consumes following SPACE and ZWSP differently from the complex path after a forced overflow, so the two paths are not interchangeable for public cursors.

### Complex path: `walkPreparedComplexLines` (`line-break.ts:540-945`)

- 563: `fitLimit = maxWidth + lineFitEpsilon`. 567-568: the unfit-hyphen return is enabled only for the Blink profile with recorded contexts.
- 763: the outer loop over lines, up to `lineLimit`. 764-779 reset per-line state, including `fitBreakSegmentIndex`, `zeroWidthPrefix` and `afterUnspacedControl`.
- 781-790: the chunk for this line. An empty chunk yields a width-0 line.
- 792, `lineLoop`: for `i` in the chunk.
  - 799-803: leading letter spacing, only when the line has content, the prefix is not all ZWSP, and the previous segment was not an unspaced control.
  - 806-808: a tab's advance is `getTabAdvance(lineW + leadingSpacing, tabStopAdvance, min)` (80-87). The remainder `lineW % tabStopAdvance` is compared with `1e-6` at 84. In the WebKit profile, a stop less than a sixteenth of a stop away is skipped. This is the only width that depends on the line position.
  - 811-828: a soft hyphen extends the line end. Unless it is at the chunk end, it records a pending break with `fit = paint = lineW + discretionaryHyphenWidth`. When that fits, Blink records it as the return target (821-824). It never adds width.
  - 830: `fitAdvance`.
  - 831-853: the first segment of a line. There are three branches: resume inside a breakable segment (832-837), emergency fill when `fitAdvance > fitLimit` (838-843), or start whole (845). Then update the pending break, and the Blink return target (848-851).
  - 855: `if (lineW + fitAdvance > fitLimit)`, the fit comparison.
    - 860-864: the WebKit NEL rule. There is no break before NEL, so a text or glue segment appended just before it is taken back off the line.
    - 866-871: an overflowing break-after segment (in practice a tab) hangs when `lineW <= fitLimit`.
    - 873-883: a pending break is used only when `pendingBreakFitWidth <= fitLimit`. That matters for soft hyphens, whose fit includes the hyphen. The line ends at `lineEnd` if content follows the pending break, otherwise at the pending break.
    - 885: `finishLineBeforeUnfitHyphen() ?? finishLine()`. Blink's return to an earlier opportunity that leaves room for the hyphen (620-638) requires `pendingBreakFitWidth > fitLimit` (626) and `canReturnFromUnfitHyphen` (522-538). That check has two loops over the line: no joined-soft-hyphen context in the line, and no text-after-text or dash-inside-a-segment opportunity between the target and the hyphen.
  - 889-896: append, and update the pending break and return target.
- 901-928: for single-line callers with an end limit inside a breakable segment (used by rich inline), a grapheme sum loop (911-913) and three possible endings.
- 931-935: the chunk end, including the unfit-hyphen return when the pending soft hyphen is the last thing.
- 940-942: `onLine`, then `normalizeLineStartChunkIndexFromHint` (283-299, a linear advance over chunks).

`appendBreakableSegmentFrom` (681-759) has two branches. With entry geometry (694-724), the whole remainder fits when `admissionFit <= fitLimit` (701). Otherwise it walks ordered prefixes with fresh widths (707-720, `fresh > fitLimit` at 709), and the first grapheme is mandatory progress. Without entry geometry, the grapheme loop (726-752) uses letter-spaced advances (732-734) and returns at the first overflow, at the latest preferred break if one exists (735-737). Unlike the fast path, it returns after one line and the outer loop resumes at the grapheme cursor.

Other layout-time helpers:
- `getTerminalLetterSpacing` (169-200) scans backward over trailing space, ZWSP, hard-break and soft-hyphen segments to find which segment owns the last gap.
- `findChunkIndexForStart` (219-233) is a binary search over chunks.
- `normalizeLineStartInChunk` (235-269) loops through consecutive chunks that hold only consumable segments.

### Epsilon and threshold comparisons

- `fitLimit = maxWidth + lineFitEpsilon` at `line-break.ts:315`, 563 and 955. `lineFitEpsilon` is 1/64 for WebKit and 0.005 otherwise (`measurement.ts:290`). Bun's default `navigator.userAgent` ("Bun/1.4.0") selects the unknown-engine profile, which uses 0.005.
- The tab remainder is compared with `1e-6` (`line-break.ts:84`).
- Rich inline: `totalWidth > remainingWidth` for atomic items, without epsilon (`rich-inline.ts:713`). `reservedWidth > remainingWidth` (723). Whole-item admission is `totalWidth <= remainingWidth` (735), with the carry allowing `+ lineFitEpsilon` (738). There is a forced-unit check `lineWidthContribution > remainingWidth` (769), and a carry overflow `> remainingWidth + lineFitEpsilon` (812). The item walker adds its own `fitLimit` on top of `availableWidth = Math.max(1, remainingWidth - reservedWidth)` (750). `safeWidth = Math.max(1, maxWidth)` (677).
- Prepare time: `apart - together > lineFitEpsilon` for soft hyphen contexts (`layout.ts:463`).

## 4. Numeric shape of each public API

| API | Path | Loops and searches | Allocations |
| --- | --- | --- | --- |
| `layout(prepared, maxWidth, lineHeight)` (`layout.ts:795-801`) | `countPreparedLines` → `walkPreparedLinesRaw` | One sequential scan over segments. Nested grapheme loops only inside overflowing breakable segments, still linear in graphemes overall (with backtracking to a preferred break). A binary search over preferred breaks when a fill starts. | Closures inside `walkPreparedLinesSimple` per call, plus the result object. The complex path also allocates a cursor and `{lineCount, lastLineWidth}`. |
| `walkLineRanges` (875-895) | same scan with `onLine` | Same as `layout()`. | Per line: a `LayoutLineRange` and two cursor objects. |
| `layoutWithLines` (969-991) | same scan | Same, plus string building per line (`line-text.ts:42-58`) with grapheme offsets cached per segment in a WeakMap. | The lines array; per line an object, two cursors and a string. |
| `measureLineStats` (897-902 → `line-break.ts:1102-1142`) | Fast path: a loop of `stepPreparedLineGeometry` per line. Complex path: the complex walker with a callback. | Still one pass over segments. The fast path adds a binary search over chunks per line (`findChunkIndexForStart`). | A cursor and the result. |
| `measureNaturalWidth` (907-909) | `measureLineStats(prepared, Infinity)` | Same. | Same. |
| `layoutNextLineRange` / `layoutNextLine` (954-963, 933-952) | normalize the start, then step one line | A binary search over chunks, the consumable-segment loop, then a scan to the line end. The complex path runs `walkPreparedComplexLines` with `lineLimit` 1. | Two cursors and the result; `layoutNextLine` adds the string. |
| `materializeLineRange` (858-871) | string building | Loop over the line's segments. | String, line object, cursors. |
| `prepareRichInline` | prepare time | Per item: `prepareWithSegments`, a whole-item walk, joined analysis, leading run walks; a backward carry loop. | Many. |
| `layoutNextRichInlineLineRange` (`rich-inline.ts:862-892`) | `stepRichInlineLine` (669-860) | Loop over items. Per item: whole-item admission without a walk, or `stepPreparedLineGeometry` on the item (a chunk binary search plus a scan). Up to two more re-walks from the fragment start (`stepItemToBreak` at 322-336, for joined breaks at 774-786 and carry at 808-828). A linear scan of `joinedBreaks` (307-318) and `localOnlyBreaks.includes` (790). `fillItemSegment` (370-392) loops over graphemes and calls `stepPreparedLineGeometry` from the fragment start for each one, which is quadratic in the segment's graphemes, then calls `getLastPreferredBreak`, which does string work. | Fragments array, fragment objects, cursor clones, `lineEnd` objects per item. |
| `walkRichInlineLineRanges` (939-956) | loop of the above | Sequential lines. | Per line as above. |
| `measureRichInlineStats` (958-982) | loop of `stepRichInlineLine` without a collector | Sequential lines. | Cursor objects per item. |

Measured under bun with the fake canvas, `layout()` on a 1023-segment paragraph takes about 5.5µs, roughly 5ns per segment. `walkLineRanges` at 240px on the same paragraph takes 5.6µs.

## 5. Circuit formulations

### 5.0 Building blocks and their measured cost

- **Comparison `[d >= 0]`, rounding form:** `boolean(clamp01(64·d + 0.5))`. This is 5 atoms (roundAffine score, two ReLUs, roundAffine clamp, boolean) and 4 layers deep. It is exact when `|d| >= 1/128` or `d = 0`, ignoring FP32 rounding of `d`.
- **Comparison, sign cascade** (`exactPositiveBit` in `lab/trace-compiler/compile.ts:525-560`): about 25 atoms, 29 layers. Exact for any finite FP32 difference.
- **Integer one-hot of an index `x` over N positions:** `[x >= j] = relu(x - j + 1) - relu(x - j)`, exact for integers, then neighbor differences. This is about 3 atoms per position, depth 2. It needs no comparison cascade. Pitfall: building one from a constant wire folds the members into duplicate wires, and `assumeOneHot` rejects duplicates. Seed the one-hot from a source cell.
- **Read at a computed index:** `Σ bit_j × value_j` over a declared one-hot group. The compiler lowers this to a gather read (one runtime read, N candidate positions stored), and the products disappear from the live program. The one-hot itself stays: N positions × 3 atoms. That is the dominant cost of every pointer-following formulation below.
- **Prefix sums** are prepared data. When widths must be computed in the circuit, use `roundAffine` chains or a parallel prefix, because plain `affine` producers inline into consumers and reinflate.

### 5.1 Tabulate over maxWidth at prepare time

**The reformulation.** Every fit decision compares a quantity that does not depend on `maxWidth` against `maxWidth + epsilon` or a piecewise-linear function of `maxWidth`. So for a fixed prepared text, each output (lineCount, maxLineWidth, per-line starts and widths) is piecewise constant in `maxWidth`. Prepare time finds the breakpoints `b_k` and the value change `Δ_k` at each one. The circuit computes, for each output:

```txt
output(maxWidth) = base + Σ_k [maxWidth >= b_k] × Δ_k
```

Each breakpoint costs one comparison, plus one ReGLU product per output (the comparison bit is nonnegative). The depth is 6 layers with the rounding comparison and 29 with the cascade, whatever the text size.

**Finding breakpoints without touching pretext's internals.** Sample the API every `step` px. For each pair of neighboring samples whose results differ, bisect until the interval is under 1e-7px. This treats pretext as a black box: no special code was needed for soft hyphens, tabs, letter spacing, CJK, emergency grapheme breaks, or rich inline items. It can miss a result that changes and changes back within one sampling step. On the fast path that cannot happen, because line starts are nondecreasing in `maxWidth` when widths are nonnegative. By induction, `next(s, L)` is monotone in both `s` and `L`. With negative advances (WebKit kerning, negative letter spacing) or Blink's unfit-hyphen return, monotonicity is not guaranteed, so sample finely. A faster exact method for the fast path enumerates candidate thresholds directly: every span width `P[i+1] - P[s]` within the window, about N × window walker runs.

**Tight width and balanced text.** The bubbles demo binary searches the smallest integer width that keeps the same line count (`findTightWrapMetrics`, `bubbles-shared.ts:61-77`). Since lineCount is monotone in width, that width depends only on the current line count, so it is another piecewise-constant output of the same comparison bits. Balanced text can be defined the same way: lay out at the smallest width that keeps the line count. Uniform font scaling fits as well. When widths scale linearly with font size, compare `size × W_k` against `maxWidth`, which is still one affine comparison per breakpoint.

**Measured** (`circuits.ts tabulated`; rounding comparison unless noted; checked at sample midpoints and at every breakpoint ± 0.002px):

| Sample | Swept widths | Breakpoints | Live ops | Layers | Stored weights | Circuit µs | pretext µs | Mismatches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 63 segments, lineCount only | 60..1292 | 28 | 169 | 6 | 281 | 0.74 | 0.33 | 0 / 4985 |
| 63 segments, lineCount + maxLineWidth + tight width | 60..1292 | 92 | 832 | 6 | 1,752 | 5.8 | 0.20 | 0 / 5113 |
| 255 segments, lineCount only | 66..5357 | 97 | 583 | 6 | 971 | 3.4 | 1.4 | 0 / 3218 |
| 255 segments, all four outputs | 66..5357 | 511 | 4,603 | 6 | 9,713 | 31 | 0.81 | 0 / 4046 |
| 1023 segments, lineCount only | 72..4096 | 314 | 1,885 | 6 | 3,141 | 11.9 | 5.5 | 0 / 3848 |
| 1023 segments, all four outputs | 72..4096 | 1,796 | 16,168 | 6 | 34,128 | 111 | 3.4 | 0 / 6812 |
| 1023 segments, all four outputs, cascade | 72..4096 | 1,796 | 55,680 | 29 | 86,212 | 275 | 3.4 | 0 / 6812 |
| Soft hyphens, URL, emergency breaks (20 segments) | 1..878 | 147 | 1,327 | 6 | 2,797 | 9.4 | 0.68 | 0 / 3803 |
| Pre-wrap tabs and newlines (20 segments) | 1..256 | 43 | 391 | 6 | 821 | 2.8 | 0.45 | 0 / 1106 |
| Letter spacing 1.5 (13 segments) | 1..388 | 46 | 418 | 6 | 878 | 3.0 | 0.32 | 0 / 1641 |
| Mixed CJK (24 segments) | 1..373 | 46 | 418 | 6 | 878 | 2.9 | 0.09 | 0 / 1581 |
| Rich inline note, 15 items with chips and code spans | 1..1459 | 206 | 1,444 | 6 | 2,680 | 9.6 | 0.33 | 0 / 3746 |

Prepare-time tabulation took 1-477ms in bun for these samples.

For comparison, the IndirectOS circuit is 201 source cells, 5,253 live operations, 192 layers, 11,598 stored weights, 30µs (`window-manager-size.ts`).

A separate sweep (`breakpoints.ts`, at 1/4px) counts how often each kind of result changes:

| Segments | Swept widths | lineCount changes | maxLineWidth or configuration changes | Sum of per-line-slot start changes |
| --- | --- | --- | --- | --- |
| 63 | 60..1292 | 28 | 92 | 365 |
| 255 | 66..5357 | 97 | 511 | 3,807 |
| 1023 | 72..4096 | 314 | 1,796 | 43,647 |

Tabulating per-line outputs (start and width for each line slot) costs one delta per start change. At 1023 segments that is 43,647 products for the full width range. Cheaper options: restrict the width range, or use the per-start rows below.

**What it cannot do.** It handles one runtime variable (`maxWidth`, optionally with uniform font scaling). It cannot follow per-line widths that change independently. It needs a prepare run whenever the text changes. It proves nothing about expressing the algorithm, only that its output can live in a circuit.

### 5.2 "Where would a line starting here end", for all starts at once

This is the algorithm itself as arithmetic, for the fast path without emergency breaks (`maxWidth` at least the widest segment). The prepared tables are:

- `prefix[i]`: the sum of widths before segment `i`.
- `fitThreshold[i]`: `prefix[i+1]` for text, and `prefix[i]` for space and ZWSP, which contribute nothing to fit because they hang. This matches `getWholeSegmentFitContribution`. The array is nondecreasing, and positions past the end hold a huge value.
- `skip[i]`: how many consumable segments a line starting at `i` skips.
- `paintEnd[i]`: the painted prefix of a line that ends before `i`, which excludes trailing spaces.

For start `s` and offsets `o = 1..window`:

```txt
fits(s, o)        = [fitThreshold[s+o] - prefix[s] <= maxWidth + epsilon]   (monotone: 1..1 0..0)
firstFailure(s,o) = fits(s, o-1) - fits(s, o)                              (one-hot, fits(s,0) = 1)
nextStart(s)      = Σ_o firstFailure(s,o) × (s + o + skip[s+o])
lineWidth(s)      = Σ_o firstFailure(s,o) × paintEnd[s+o] - prefix[s]
windowOverflow(s) = fits(s, window)                                          (report and fall back)
```

This reproduces every fast-path branch. A space that overflows is appended and hangs, so the next start is the text after it. A text segment after text breaks before itself. The painted width excludes a trailing space. The cost is `N × window` comparisons plus `2 × window` products per start, at depth 4. The window must bound the worst start, not the worst actual line. My first run used the most segments on any line pretext produced at 320px, which was 18. A start in the middle of a run of short words fit more, and the prototype caught it with its own `windowOverflow` check. Taking the maximum over every start with `layoutNextLineRange` gave 21, 23 and 23 for 63, 255 and 1023 segments at 320px.

How the other features extend this table:

- **Hard breaks and chunks.** A hard break is a forced failure: its `fits` bit is 0 for every start before it. Monotonicity survives, because everything after it fails too. The next start is the chunk's `consumedEndSegmentIndex`, and an empty chunk produces a width-0 line. All of this is static structure.
- **Emergency grapheme breaks.** Expand breakable segments into grapheme units at prepare time. From a start `u` inside segment S, or at S's start when `w_S > maxWidth + epsilon` (one more comparison), the break candidates are the graphemes of S, and after S only segment starts, using whole-segment thresholds. The first failing candidate is still a neighbor difference of monotone bits along a static candidate list. Select between the normal and emergency next start with the admission bit.
- **Preferred breaks after dashes.** "Latest preferred break that still fits" is `prefFits(v) - prefFits(next preferred after v)` over static preferred positions, another neighbor difference.
- **Soft hyphens.** The break before the text after a soft hyphen is taken only when `prefix[h] - prefix[s] + discretionaryHyphenWidth <= maxWidth + epsilon`. In non-Blink profiles an unfit hyphen still ends the line at the same place and only changes the painted width. Blink's return to an earlier opportunity is "the latest break-after candidate whose fit plus the hyphen fits", which is monotone bits again. Its `canReturnFromUnfitHyphen` loops become range tests on static prefix counts: joined-soft-hyphen contexts in `[s, h]`, and blocking opportunities in `[target, h)`.
- **Letter spacing.** With a fixed start, each later segment's leading gap is static, so the fit threshold becomes `spacedPrefix[i] - spacedPrefix[s]` plus a correction at the start (no gap for the first segment or a ZWSP prefix) and the trailing gap of segment `i`. `getTerminalLetterSpacing`'s backward scan becomes a static "last gap-owning segment before j" table.
- **Tabs.** A tab's advance is `stop - (x mod stop)`. Modulo by a constant with `x` bounded by `maxWidth` is `x - stop × Σ_k [x >= k × stop]`, for example 32 comparisons for 1280px and 40px stops. `x` before a tab depends on the start and on earlier tabs in the line, so a line with several tabs needs a short sequential chain per start. Tabs only appear in pre-wrap.
- **Entry geometry and other non-additive widths.** Store the per-start widths `W(s, e)` as prepared cells instead of prefix differences. This costs `N × window` cells, and handles history-dependent fits (fresh shaping after a break, admission versus emergency widths) with no new circuit structure.
- **Variable per-line widths.** Replace `maxWidth` with that line's width. That only works when lines are walked one at a time (5.3 and 5.4).
- **Rich inline.** Items become units. A collapsed gap behaves like a space: paid before the item when the line has content, dropped at a line start. `extraWidth` is charged once per fragment per line, which is a prefix sum over items touched plus a start correction. Atomic items allow breaks on both sides. The carry rule means an item boundary without a joined break is not a candidate. Deriving all these thresholds faithfully means re-deriving rich inline's intricate branches, so tabulation (5.1) is much safer for rich inline.

### 5.3 Recovering line starts from the next-start table

All three were measured at fixed `maxWidth` 160..320, rounding comparisons, with line slots equal to the line count at 160px:

| Formulation | Segments | Window | Line slots | Live ops | Layers | Stored weights | Gather reads / table entries | Circuit µs | Mismatches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sequential lines | 63 | 21 | 9 | 12,483 | 59 | 26,521 | 17 / 1,071 | 78 | 0 / 1282 widths |
| Sequential lines | 255 | 23 | 37 | 76,031 | 227 | 166,007 | 73 / 18,615 | 460 | 0 / 322 |
| Sequential lines | 1023 | 23 | 157 | 673,367 | 947 | 1,525,367 | 313 / 320,199 | 4,276 | 0 / 82 |
| Pointer jumping | 63 | 21 | 9 (4 levels) | 28,426 | 60 | 51,047 | 387 / 10,948 | 154 | 0 / 1282 |
| Pointer jumping | 255 | 23 | 37 (6 levels) | 364,793 | 86 | 622,234 | 2,563 / 206,158 | 1,932 | 0 / 322 |
| Segment scan | 63 | 21 | - | 15,533 | 150 | 30,838 | 0 | 98 | 0 / 1282 |
| Segment scan | 255 | 23 | - | 71,959 | 540 | 142,389 | 0 | 467 | 0 / 322 |
| Segment scan | 1023 | 23 | - | 292,375 | 2,082 | 577,845 | 0 | 2,003 | 0 / 82 |

The sequential lines variant was checked on lineCount, maxLineWidth, and every line's start and width. The other two were checked on lineCount and maxLineWidth.

- **Sequential lines.** Per line: a one-hot of the start (3 atoms per segment), two gathered reads (next start, width), and a max. Work is `O(lines × segments)`, depth about 6 per line.
- **Pointer jumping.** `jump[m+1][s] = jump[m][jump[m][s]]`, with windowed one-hots of size `min(N - s, window × 2^m)`, then binary lifting from segment 0 for lineCount and the widest line. Depth is logarithmic (60 and 86 layers), but each level reads a computed index for every start, so work grows roughly with `N² log(lines)`. Going from 63 to 255 segments multiplied it by 13. My estimate for 1023 segments, 8 levels, is about 1.9M one-hot positions, or 7 to 10 million atoms.
- **Segment scan.** `isLineStart[j] = Σ_{s in window before j} isLineStart[s] × [nextStart[s] == j]`. Integer equality is 3 ReLUs, and only the previous line start can point at `j`, so the sum is an exact bit. There are no computed-index reads, so work is `O(segments × window)`, but depth grows with segments (2,082 layers at 1023). lineCount is a sum of the bits, and maxLineWidth a max tournament over `bit × lineWidth`. Per-line outputs would still need a scatter into line slots, `O(segments × lines)`.

**Where the cost really is.** Comparisons are cheap and parallel. The substrate's expensive operation is reading at a computed index: the gather lowering removes the products but keeps the 3-atoms-per-position one-hot. A compiler pass that recognizes `integerOneHot(x)` followed by masked reads, and lowers the pair to "read at index x" (the executor already resolves an index from one-hot bits once per group), would cut sequential walking to `O(window)` per line and pointer jumping to `O(N log N)`. That is a concrete prototype.

### 5.4 Per-start breakpoint rows for per-line widths

Flows like `dynamic-layout.ts` (`layoutColumn`, lines 275-341) and `editorial-engine.ts` (`layoutColumn` from line 402) call `layoutNextLine` with a different width for every band: the widest slot left after subtracting obstacle intervals (`wrap-geometry.ts:136-155`). Tabulation over one width does not apply, but the same idea works per start. For every start segment, prepare time tabulates how `end(s, width)` and `width(s, width)` change with that line's width. From 60px to 480px, no row had more than 12 pieces. The circuit walks lines: a one-hot of the start, gathered rows (threshold, end delta, width delta per piece), one comparison per piece against that line's width source cell, and affine sums. An exhausted start reads all zeros, and `end` is stored minus N so the next start stays at N.

| Segments | Line slots | Pieces per row | Live ops | Layers | Stored weights | Gather table entries | Circuit µs | Mismatches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 63 | 9 | 12 | 2,835 | 99 | 4,824 | 21,546 | 16 | 0 / 2700 lines |
| 63, cascade | 9 | 12 | 5,211 | 306 | 7,956 | 21,546 | 29 | 0 / 2700 |
| 255 | 37 | 12 | 32,967 | 407 | 62,456 | 358,530 | 161 | 0 / 11100 |
| 255, cascade | 37 | 12 | 42,735 | 1,258 | 75,332 | 358,530 | 215 | 0 / 11100 |

Checks used random sequences of per-line widths between 160px and 480px. Each line's exhausted flag, end cursor and width were compared against sequential `layoutNextLineRange` calls. The start cursor is a source cell, so a second column can continue from the first column's end, as in editorial-engine. Per-start rows also absorb every walker rule, including non-additive widths, because the rows come from pretext's own walker.

### 5.5 Shrink-wrap, balanced text and optimal breaking as unrolled searches

- **Shrink-wrap to the widest line** needs no search. For greedy breaking with nonnegative widths, laying out again at `maxLineWidth(L)` keeps every break: each line still fits, and each overflowing segment still overflows. The widest line is already the tightest container with the same breaks.
- **Smallest width with the same line count** (bubbles, balanced text). With tabulation, this is an affine sum over the same bits (5.1). In a circuit whose widths are runtime data, it is a binary search: about 11 iterations for widths up to 2048px, each a full line count. Alternatively, it is the bottleneck partition problem ("minimize the widest line using at most c lines"), a min-max dynamic program over the next-start windows with `c × N × window` compare-selects and depth `c × log(window)`.
- **Knuth-Plass optimal breaking** (`justification-comparison.model.ts:293-351`) is a DP over break candidates, `dp[to] = min over from of dp[from] + badness(from, to)`. It prunes with a break once even compressed spaces cannot fit (322). The badness is cubic in the space ratio plus river, tight and hyphen penalties (368-403). Unrolled, it is sequential over candidates (depth N), with a min tournament over the window of predecessors: about `N × window × (compare + select)` work. At 256 candidates with a 32-wide window, that is roughly 80k atoms and several thousand layers. The DP's choice is still piecewise constant in `maxWidth`, but its breakpoints are where two candidate totals cross, not simple width thresholds. So tabulation needs bisection, not threshold enumeration.

### 5.6 Cost summary for 64, 256 and 1024 segments

Measured at 63, 255 and 1023 segments where noted, estimated otherwise.

| Formulation | 64 | 256 | 1024 | Depth | Notes |
| --- | --- | --- | --- | --- | --- |
| Tabulated lineCount | 169 ops | 583 ops | 1,885 ops | 6 | Measured. One variable, prepare-time sweep. |
| Tabulated lineCount + maxLineWidth + tight width | 832 | 4,603 | 16,168 | 6 | Measured. Breakpoints grow with the width range. |
| Same, sign cascade | 2,856 | 15,845 | 55,680 | 29 | Measured. Exact for any FP32 input. |
| Per-start rows, per-line widths | 2,835 (9 lines) | 32,967 (37 lines) | about 560k ops and 6M gather table entries (157 lines) | about 11 per line | Measured at 63 and 255 |
| Next-start table alone | about 10k | about 48k | about 190k | 4 | Estimated by subtracting line recovery from the units runs. |
| Sequential lines | 12,483 | 76,031 | 673,367 | about 6 per line | Measured |
| Pointer jumping | 28,426 | 364,793 | about 7-10M | log(lines) × about 14 | Measured at 63 and 255 |
| Segment scan | 15,533 | 71,959 | 292,375 | about 2 × segments | Measured |
| IndirectOS for reference | 5,253 ops, 192 layers | | | | |

On the CPU JavaScript evaluator, every circuit is slower than pretext's own walker, from about 2× (tabulated lineCount at 63 segments) to about 760× (sequential lines at 1023 segments). A circuit isn't faster. Its value is that text layout becomes part of the one numeric program, next to springs, focus and window geometry.

### 5.7 How the demos use layout results, and the matching formulation

- **masonry** (`pages/demos/masonry/index.ts:55-99`): `layout(prepared, textWidth, lineHeight).height` per card on every resize, then shortest-column placement. Tabulated lineCount per card, with the column width as the variable. The placement loop is sequential over cards with a continuous column-height state, which is ordinary UI circuit work.
- **accordion** (`accordion.ts`): heights at the current width drive the open and close animation. Tabulated lineCount.
- **bubbles** (`bubbles-shared.ts:49-77`): `walkLineRanges` for the widest line, and a binary search for the tight width. Tabulated tight width. Verified above against the demo's exact search.
- **markdown-chat** (`layoutBlockFrame`, `markdown-chat.model.ts:944-1000`): `measureRichInlineStats` and `measureLineStats` per block for height and used width. Tabulated, per block.
- **rich-note** (`rich-note.model.ts`): `walkRichInlineLineRanges` + `materializeRichInlineLineRange`. Tabulated per-line outputs, with JavaScript materializing fragment text from cursors.
- **dynamic-layout and editorial-engine**: `layoutNextLine` per band with obstacle-derived widths. Per-start rows (5.4), with the slot carving computed in the circuit from obstacle state. editorial-engine's headline fit binary searches font size and calls `prepareWithSegments` inside the search loop (`fitHeadline`, `editorial-engine.ts:355-400`). A circuit version needs text prepared at a few sizes, or thresholds in units of font size.
- **justification-comparison**: greedy `layoutNextLine` loop and the Knuth-Plass DP (5.5).

Per-word positions for animating reflow word by word: `x(i) = prefix[i] - prefix[start of i's line]` and `y(i) = lineIndex(i) × lineHeight`. `lineIndex(i)` is a prefix count of the segment scan's `isLineStart` bits, and the line-start prefix is a "last set value" scan. That is `O(segments × lines)` with one-hot reads, or `O(segments log segments)` with a parallel prefix scan. Each word can then drive its own spring.

## 6. Best first differential target, and the extraction recipe

### Recommendation

1. **Tabulated `layout()` and `measureLineStats()` for fast-path paragraphs** inside an IndirectOS window whose width springs. It is tiny (hundreds of atoms, 6 layers), exact by construction, black-box, and immediately useful: window text heights and shrink-wrapped chips in one circuit. The same code covers rich inline stats and the tight width.
2. **The next-start table (5.2) with sequential line recovery**, as the differential target for "the algorithm itself in circuit". Start with the fast path at `maxWidth` above the widest segment, and check line starts, widths, lineCount and maxLineWidth against `walkLineRanges` and `measureLineStats`. Then add features in this order: hard-break chunks, emergency grapheme breaks with preferred breaks, soft hyphens (non-Blink first), letter spacing, and last tabs.

### Recipe: prepared widths and kinds under bun

Scripts: the session scratch folder `phase1/pretext/`, not in the repo. `pretext-src/` there is a copy of the clone's `src/`, so experiments never touch the clone. They ran from that folder:

```sh
bun print-prepared.ts
bun breakpoints.ts
bun circuits.ts tabulated rows units jumping scan
bun window-manager-size.ts
```

The steps, as done in `fake-canvas.ts` and `print-prepared.ts`:

1. Install a fake `OffscreenCanvas` whose context has a `font` field and `measureText(text) → {width}`. pretext creates its measuring context from `OffscreenCanvas` when it exists (`measurement.ts:155-169`). `document` is undefined under bun, so the page language is null and emoji correction is 0.
2. Set `navigator.userAgent` to a Chrome, Safari or Firefox desktop string with `Object.defineProperty(globalThis, 'navigator', {value: {userAgent}, configurable: true, writable: true})`. The engine profile is cached on first use, so this must happen before pretext loads. Without it, bun's "Bun/1.4.0" selects the unknown-engine profile: epsilon 0.005, breaks at every rich inline item boundary, no unfit-hyphen return.
3. Import pretext dynamically after both globals exist (`await import('./pretext-src/layout.ts')`). A static import is hoisted above the setup.
4. Read internal fields by casting the prepared handle: `(prepared as unknown as {widths: number[], kinds: string[], chunks: ..., breakableFitAdvances: ..., ...})`. Kinds map to numeric codes for the source table in `fake-canvas.ts` (`kindCodes`).
5. Make widths dyadic. The fake canvas gives every character a whole number of 64ths of the font size (1/4px at 16px). Then every width and prefix sum is exact in both float64 and FP32, and pretext's float64 walker and the FP32 circuit cannot disagree through rounding alone. pretext's own test canvas (`measureWidth` at `src/layout.test.ts:97`, installed at 257-275) uses factors like 0.6 and 0.33 of the font size, which are not exact in FP32. Real canvas widths are usually small-denominator dyadic values, but FP32 thresholds still limit agreement to widths more than about one FP32 step away from a breakpoint.
6. With dyadic widths, results can only change between `k/4 - epsilon` and `k/4`, so a 1/4px sweep finds every change. Bisection makes it exact for arbitrary widths.

## 7. Surprises and open questions

- On the fast path, pretext always breaks just before the first overflowing text segment. The pending break only changes the reported width. The break decision is a threshold search over prefix sums.
- A paragraph's whole `layout()` result has very few breakpoints over the full width range: 28, 97 and 314 for 63, 255 and 1023 segments. So `layout()` for a 1023-segment paragraph is a 1,885-operation, 6-layer circuit.
- Tabulation needed no feature-specific code, yet was exact for soft hyphens, tabs, letter spacing, CJK, emergency breaks and rich inline items.
- Rich inline's layout-time walker does string work and runs `Intl.Segmenter` in `fillItemSegment` → `getLastPreferredBreak` (`rich-inline.ts:341-392`). It also re-walks from the fragment start once per grapheme there, which is quadratic in the segment's graphemes.
- The cost bottleneck is not comparisons but reading at a computed index. Pointer jumping grew 13× for 4× the segments.
- The window for an all-starts table must bound every start, not just the lines pretext produces. The first run failed its own window check because of that.
- Open: how close real canvas widths are to linear in font size, which decides whether "thresholds in units of font size" holds up in pretext's accuracy harness. Also open: whether an index-read lowering pass makes the algorithmic formulation competitive with tabulation.

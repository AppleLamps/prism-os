# Text and pretext: what actually translated

## The short answer

pretext has two halves. `prepare(text, font)` turns a string into arrays of numbers: it normalizes whitespace, splits the text into segments with `Intl.Segmenter`, merges segments that must stay together (e.g. a URL, a number, or a word with its trailing period like `dog.`), classifies every segment (text, space, soft hyphen, tab, hard break and a few more kinds), and measures each segment with canvas `measureText`. `layout(prepared, maxWidth, lineHeight)` and its siblings, e.g. `walkLineRanges`, then take those arrays and a width and compute where lines end. pretext's comment on `layout()` in src/layout.ts calls `layout()` "Pure arithmetic on cached widths — no canvas calls, no DOM reads, no string operations".

None of `prepare` was translated. In every prototype, `prepare` still runs in JavaScript, once per text and font and again whenever the text changes, and only its numbers reach the circuit. What translated is the second half, layout, in two different ways:

1. **Tabulation** (text-tabulated). JavaScript calls pretext's layout functions at many widths and records every width where the result changes. The circuit reads no segment widths: it compares the runtime width with those recorded widths and adds up constants.
2. **The line walker as arithmetic** (text-walker, streaming-words, and HandwiredOS's Notes window until October 13, 2026). The circuit runs greedy line breaking itself, over segment widths held in source cells, i.e. entries of the `Float32Array` that JavaScript writes before each evaluation. So every line can have its own width, e.g. text flowing around a dragged window, and a word can change width while the page runs, e.g. when it turns bold.

Two more results belong in this section. code-points moved one job of `prepare` into the circuit: the circuit reads each character's line break class, and whether a line may break between two neighboring characters, from tables. Measuring stayed in JavaScript, and grapheme clusters, bidi and shaping weren't built. And checking tabulation against pretext turned up a likely pretext bug in rich inline layout, where two checks treat `lineFitEpsilon` differently. The last section walks through the minimal example.

| Step | Where it runs |
| --- | --- |
| Normalize whitespace, segment with `Intl.Segmenter`, merge URLs, numbers and punctuation, classify segments | JavaScript (pretext's `prepare`), in every prototype |
| Measure segments, and the graphemes of long words, with canvas `measureText` | JavaScript (pretext's `prepare`), in every prototype |
| Find the widths where a paragraph's layout changes | JavaScript, calling pretext thousands of times (text-tabulated) |
| Compare the runtime width with those widths, and add up constants | circuit (text-tabulated) |
| Sums of segment widths, "does the line fit" bits, line ends, painted widths, each word's x and line | circuit (text-walker's fast path, streaming-words, HandwiredOS's Notes window until October 13, 2026) |
| Thresholds for hard breaks, long words, soft hyphens, letter spacing and tabs | JavaScript, restating pretext's walker for every line start; the circuit compares them with each line's own width (text-walker's rows.ts, described under [Hard breaks, long words, soft hyphens, letter spacing and tabs](#hard-breaks-long-words-soft-hyphens-letter-spacing-and-tabs)) |
| Each code point's line break class and advance, and the break bit between neighbors | circuit table reads (code-points); JavaScript builds the class tables once and measures each new code point |
| Turn line positions back into strings, and draw them | JavaScript |

## What crosses from JavaScript into the circuit

The examples in [examples/text](../examples/text/) use one sentence, "The quick brown fox jumps over the lazy dog." The prototypes' headless checks measure text with a fake canvas, a deterministic stand-in for canvas `measureText` whose advances are multiples of fontSize/64 px. With text-tabulated's fake canvas at 16px, pretext's `prepareWithSegments` returns these arrays, which [pretext-agreement.test.ts](../examples/text/pretext-agreement.test.ts) checks:

```ts
segments: ['The', ' ', 'quick', ' ', 'brown', ' ', 'fox', ' ', 'jumps', ' ', 'over', ' ', 'the', ' ', 'lazy', ' ', 'dog.']
widths:   [25, 5, 40.25, 5, 43, 5, 26.25, 5, 41.5, 5, 35, 5, 26.5, 5, 32.75, 5, 33.5]
kinds:    ['text', 'space', 'text', 'space', 'text', /* ... */ 'space', 'text']
```

Every width is a multiple of 1/4 px, so sums of widths are exact both in float64 and in FP32, the 32-bit floats that the circuit computes with.

What each circuit reads from these arrays:

- The tabulated circuit reads one source cell, the width. The 17 segment widths never reach the circuit: JavaScript turns them into thresholds and constants while building it.
- The walker circuit reads the width and the 17 segment widths as source cells, and in text-walker also a break-after bit per segment, which is 1 for a space.
- code-points' text field reads one code point per cell, e.g. 0x5B57 for 字, plus tables that JavaScript writes: line break classes, a table of break rules over pairs of classes, and advances.

In the other direction, the circuits output numbers, e.g. line counts, heights, and the segment index where each line starts. JavaScript turns those indices back into strings, e.g. with pretext's `materializeLineRange`, and writes them into the DOM.

## The familiar JavaScript walker

The plain JavaScript reference for the circuits is a greedy line walker, `layoutLineFrom` in [paragraph.ts](../examples/text/paragraph.ts). It follows pretext's fast path, `walkPreparedLinesSimple` in pretext's src/line-break.ts, which pretext uses for text made only of words, spaces and zero-width spaces, without letter spacing:

```ts
function layoutLineFrom(paragraph: Paragraph, lineStart: number, maxWidth: number): Line {
  const {segmentWidths, breaksAfter} = paragraph
  const fitLimit = maxWidth + lineFitEpsilon
  // The first word always stays on its line, even when it's wider than the line.
  let lineWidth = segmentWidths[lineStart]!
  let segment = lineStart + 1
  for (; segment < segmentWidths.length; segment++) {
    const width = segmentWidths[segment]!
    // A space hangs, so it's never the segment that overflows.
    if (breaksAfter[segment] === 0 && lineWidth + width > fitLimit) break
    lineWidth += width
  }
  const lastSegment = segment - 1
  const paintedWidth = breaksAfter[lastSegment] === 1 ? lineWidth - segmentWidths[lastSegment]! : lineWidth
  return {start: lineStart, end: segment, paintedWidth}
}
```

Three pretext rules show up in that loop:

- A line fits when its width is at most `maxWidth + lineFitEpsilon`. `lineFitEpsilon` is a small tolerance for rounding in browser measurements, set by pretext's engine profile, i.e. the browser engine pretext imitates: 0.005 px for Blink (Chrome) and Gecko (Firefox), and 1/64 px for WebKit (Safari).
- A space hangs: a space at the end of a line may reach past the line's edge, and it never makes the line overflow. That's why the loop never compares a space.
- A line's painted width leaves out its trailing space.

The walker keeps a line's first word even when that word is wider than the line. pretext instead breaks such a word between graphemes, which pretext calls an emergency break. So the examples use widths from 43 px, the width of "brown", the widest word, up to 360 px. Over that range, pretext-agreement.test.ts checks that the walker gives the same lines and painted widths as pretext's `walkLineRanges` at every 1/16 px, and at 1 to 3 FP32 steps on either side of every threshold.

## Idea 1: tabulation

The pattern doc [breakpoints found ahead of time](../patterns/breakpoints-found-ahead-of-time.md) has tabulation on one page, for a list of chat messages, with a runnable example and a test.

### The problem

A Notes window's width springs while you drag its right edge. On every frame, the layout needs three things from the text: each paragraph's line count, for the paragraph's height; each chat bubble's shrink-wrapped width; and the start and end of every painted line. The familiar way calls pretext for every block on every frame:

```ts
function layoutNotes(contentWidth: number) {
  let blockTop = 0
  for (const block of blocks) {
    const {lineCount} = layout(block.prepared, contentWidth, lineHeight)
    block.top = blockTop
    blockTop += lineCount * lineHeight + blockGap
  }
}
```

### Every layout result is a step function of the width

While the walker lays out a paragraph, every decision is a comparison of a sum of segment widths with `maxWidth + lineFitEpsilon`. Which sums get compared depends on earlier decisions, but no compared sum depends on `maxWidth` itself. So as `maxWidth` grows, no decision changes until `maxWidth + lineFitEpsilon` reaches one of the compared sums, and at that width one decision flips.

For one prepared paragraph, the line count, the widest line and every line's start and end therefore stay constant over intervals of widths, and change only at a few widths in between. A function like that is called a step function. This section calls the widths where some result changes thresholds.

For example, between 43 and 360 px the example paragraph has 19 thresholds where some line's end or the widest line changes. Only 8 of them change the line count: 64.245, 70.245, 71.245, 72.745, 102.745, 118.245, 189.245 and 343.745 px, rounded to 3 decimals. Each is a compared sum minus 0.005. E.g. "the lazy" is 26.5 + 5 + 32.75 = 64.25 px wide, so from 64.245 px "the" and "lazy" share a line, and the paragraph goes from 9 lines to 8.

Realistic text has few thresholds too. For single paragraphs of The Great Gatsby over widths 300 to 900 px at 16px, text-tabulated found about one line count threshold per 50 to 56 characters, e.g. 412 line count thresholds for 4,096 words (22,954 characters), with the fake canvas.

### Finding the thresholds in JavaScript

text-tabulated's tabulate.ts treats pretext as a black box, e.g. `measure(width) = walkLineRanges(prepared, width)`, and only compares results. It samples every 1 px, and wherever two neighboring samples differ, it bisects between them until it finds the exact width where the result changes.

The bisection runs over FP32 bit patterns instead of numbers. For positive FP32 values a larger bit pattern is a larger value, so halving the range of bit patterns until two patterns differ by 1 ends at two neighboring FP32 values, e.g. about 7.6e-6 px apart near 100 px. The threshold is the upper value, the smallest FP32 width at which the new result holds. The circuit only ever receives FP32 widths, so a threshold found this way reproduces pretext's decision at every width the circuit can receive.

`tabulateWidths` in [tabulated.ts](../examples/text/tabulated.ts) does the same for the example: 318 samples and 311 bisection steps, 629 calls of the walker in all, find the 19 thresholds. That's about 16 steps per threshold, because 1 px holds between 2^15 and 2^17 FP32 values in this range of widths.

This JavaScript step is where tabulation's work goes. For one 4,096-word paragraph, text-tabulated made 27,402 pretext calls in 1,398 ms, against 1,513 calls in 1 ms for 64 words. The Notes window's 10 blocks took 16 ms to tabulate with the fake canvas, and 97 ms in Chrome with real fonts.

Treating pretext as a black box needed no code for any particular feature. Soft hyphens (U+00AD, an invisible hyphen that marks where a word may break), emergency breaks, tabs, letter spacing, CJK text (Chinese, Japanese and Korean), `word-break: keep-all` and `white-space: pre-wrap` all went through the same sampler, with 0 wrong line counts or line positions on pretext's own test cases (`src/test-data.ts`, widths 2 to 700 px, fake canvas).

Anything that depends only on which interval the width is in moves into this JavaScript step too. E.g. pretext's bubbles demo binary searches for the narrowest width that keeps a bubble's line count, and a block's width can be any nondecreasing JavaScript formula of the window's width, e.g. `Math.floor(chatWidth * 0.8) - 24`. JavaScript runs the search and the formula while tabulating, and the circuit only reads the result for the current interval.

Sampling can only miss a change that is undone before the next sample, and that only happens if, as the width grows, a paragraph can get more lines or a line can start earlier. No plain text case was found, but rich inline text has such widths, see [the last section](#does-a-paragraph-ever-get-more-lines-when-it-gets-wider).

### The circuit

The circuit has one source cell, the width. For every threshold it computes the bit `[width >= threshold]`, where `[condition]` means 1 when the condition holds and 0 otherwise, and every output is a constant plus a weighted sum of those bits:

```ts
// [width >= threshold], exact for every FP32 width in 0..8192. 4 operations, 3 layers.
function emitWidthAtLeast(circuit: Circuit, width: Wire, threshold: number): Wire {
  const rounded = Math.fround(threshold)
  invariant(rounded === 0 || (rounded >= 2 ** -10 && rounded <= 8192), 'threshold is outside the range where the comparison is exact')
  const upper = circuit.reglu([], 1, [[width, 512]], 0.5 - 512 * rounded)
  const lower = circuit.reglu([], 1, [[width, 512]], -0.5 - 512 * rounded)
  const clamped = circuit.roundAffine([[upper, 1], [lower, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

// output = value on interval 0 + sum over k of [width >= thresholds[k]] * (value on interval k + 1 - value on interval k)
function emitDeltaSum(circuit: Circuit, bits: readonly Wire[], valueByInterval: readonly number[]): Wire {
  const terms: [Wire, number][] = []
  bits.forEach((bit, threshold) => {
    const delta = valueByInterval[threshold + 1]! - valueByInterval[threshold]!
    if (delta !== 0) terms.push([bit, delta])
  })
  return circuit.roundAffine(terms, valueByInterval[0]!)
}
```

`circuit.reglu([], 1, gateTerms, gateBias)` computes `1 × max(0, gate)`, i.e. a ReLU, the function `max(0, x)`. The difference of the two ReLUs is `512 × (width − threshold) + 0.5` clamped into 0..1, and `circuit.boolean` rounds a value within 0..1 to exactly 0 or 1, with 0.5 rounding up.

The weighted sum adds, for every threshold the width has reached, how much the output changes at that threshold. E.g. the example's line count is `9 − [width >= 64.245] − [width >= 70.245] − … − [width >= 343.745]`. The changes are constant weights, so the sum has no products, and a change of 0 stores nothing. text-tabulated's code calls these sums "delta rows".

### Why the comparison is exact

At `width = threshold` the score `512 × width + (0.5 − 512 × threshold)` must be exactly 0.5, so it rounds to 1, and one FP32 step below the threshold the score must be below 0.5. Both hold because the threshold is itself an FP32 value, multiplying by 512 is exact, the bias `0.5 − 512 × threshold` is exactly representable, and near the threshold the FP32 sum cancels exactly. text-tabulated's step-circuit.ts states the range: every FP32 width in 0..8,192 px, when the threshold is 0 or between 2^-10 and 8,192 px, and step-circuit.test.ts checks 3 FP32 steps on either side of over 600 thresholds. The [comparisons section](comparisons.md#form-2-the-boolean-atom) explains how the boolean atom rounds.

The example's test, [text.test.ts](../examples/text/text.test.ts), checks the tabulated circuit against the walker at every 1/16 px from 43 to 360 px, and at 1 to 3 FP32 steps on either side of every threshold, with 0 mismatches.

### Values as weights, or values in source cells

text-tabulated built two forms of the same table.

As weights, the form above, the thresholds and changes are constants inside the circuit. The circuit is small, but changing the text means tabulating again and rebuilding the circuit.

In source cells, the thresholds and each output's value on every interval are cells that JavaScript writes, and text-tabulated's code calls this form "gathered rows". With `bit[k] = [width >= threshold cell k]` for T thresholds, the width is in interval 0 when `1 − bit[0]` is 1, in interval k when `bit[k − 1] − bit[k]` is 1, and in the last interval when `bit[T − 1]` is 1. Those differences form a one-hot, i.e. a list of bits in which exactly one bit is 1. Each output is then `Σ interval[k] × value[k]`, which the compiler turns into one gather read, i.e. a read of the one value at the marked position, like `values[k]`.

Editing the text within the capacity chosen while building then only rewrites cells, with no rebuild. The cost is source cells: intervals × outputs, e.g. 5,792 cells for the Notes window, against 1,972 stored weights for the same outputs as constants. Values in cells are also more precise, because a width output is read directly instead of added up, see the pitfalls below. [Tables that JavaScript writes](../patterns/tables-javascript-writes.md) covers the same trade for other tables.

### Cost

For T thresholds, the circuit is 4 operations per threshold plus one sum per output, and it stores a few weights per comparison plus one weight per nonzero change per output. Depth is 4 layers whatever the text: 3 for the comparisons and 1 for the sums. So a tabulated block is O(T) operations at constant depth.

Heights only need the line count thresholds, and those grow linearly with the text's length. Painting every line's start and end grows faster, about line slots × thresholds stored weights, where a line slot is the group of outputs reserved for one line: its start, its end and its width. A line's start changes whenever any earlier line's break moves, so every slot repeats the changes of the slots before it. For a paragraph of N characters, both the slot count and the threshold count grow with N, so painting can reach O(N²) stored weights. For one Gatsby paragraph over widths 300 to 900 px, text-tabulated measured the line start and end changes growing about 9 to 10 times for every 4 times more words (320 changes for 64 words, 286,074 for 4,096 words).

Measured:

- The example ([report.ts](../examples/text/report.ts)): the line count alone is 33 live operations, i.e. operations that still feed an output after compilation, in 4 layers, with 48 stored weights, i.e. nonzero weights in the compiled sparse matrices. The line count, widest line and all 9 line ends are 87 operations in 4 layers with 153 stored weights.
- text-tabulated's Notes window, fake canvas: 10 blocks (a balanced heading, 4 paragraphs and 5 chat bubbles) with 244 thresholds. The text tables alone are 1,041 live operations in 4 layers with every painting output, or 190 operations for line counts only. The whole window, with the drag, springs and stacking, is 2,030 operations in 48 layers, against 5,253 operations in 192 layers for HandwiredOS.
- In Chrome with real fonts, text-tabulated's demo compared every frame with pretext: 0 frames with a wrong line count, tight width, line position or line text over 2,473 frames.
- Block heights for the 1,643 paragraphs of Gatsby's opening, widths 300 to 900 px: 21,549 live operations in 4 layers when every paragraph reads its own width cell, which is the case to expect with real fonts. With the fake canvas and one shared width it was 8,748 operations, because many paragraphs' thresholds landed on the same values and shared a comparison.
- One 4,096-word paragraph: its height needs 1,649 operations and 2,472 stored weights, while painting every line needs 8,739 operations and 153,549 stored weights, or 2,659,635 source cells as values in cells.

### When not to use tabulation

- **A second runtime variable.** The table is indexed by one width. Two independent runtime values, e.g. a width and a line clamp, or a width and a column count, would need a table for every value of the second variable, or thresholds that are functions of both. text-tabulated built one exception, a uniform font scale, which compares `width + ε` with `scale × (threshold + ε)`: 49 operations for a paragraph. Against pretext prepared again at other font sizes, its line count differed from pretext's at a few widths, all within 2.8e-5 px of a scaled threshold, where FP32 rounding of the product determines the comparison's result. The scaled comparison also assumes that advances scale linearly with font size, which real fonts don't do exactly.
- **A different width per line.** Text flowing around an obstacle gives each line its own width, and those widths aren't one nondecreasing function of one runtime value. That needs the walker.
- **Text that changes every frame, as weights.** Then the text is built into the circuit, so an edit means preparing, tabulating and rebuilding again. For the Notes window that took about 3 ms per keystroke with the fake canvas: medians of 0.07 ms preparing, 0.8 ms tabulating and 2.5 ms rebuilding and compiling the whole window, when appending. The example's test shows the limit: after "quick" turns bold, e.g. 44.25 px wide, the old circuit's results differ from the walker's at some widths, and only a new table matches the walker at every width.
- **Long paragraphs whose every line is painted**, because painting grows about quadratically. text-tabulated suggests painting only the lines near the viewport.

### Pitfalls

- **Widths outside the table.** Outside the tabulated range the circuit returns the results of the first or last interval. The Notes window tabulates 200 to 1,100 px for a drag range of 232 to 1,052 px, so a spring's overshoot stays inside.
- **Sampling can't prove that no change was missed.** A change that is undone before the next sample is never bisected, and rich inline text has such changes, see the last section.
- **Width outputs drift when the changes are weights.** A width output adds up width changes in FP32, and when the changes aren't exact in FP32 the output drifts from pretext's float64 value: up to 3.8e-6 px on pretext's letter spacing cases with the fake canvas, up to 1.8e-4 px with advances that aren't multiples of a power-of-two fraction of a pixel, and 1.8e-4 px in Chrome. Decisions, i.e. line counts and line positions, stayed exact, and values in source cells stayed bit-equal.
- **Tiny thresholds.** Below 2^-10 px the comparison stops being exact, e.g. for a threshold of 1e-4 px the bias rounds, and a width one FP32 step below the threshold gives 1. text-tabulated's `emitAtLeast` throws for such thresholds, and the example's `emitWidthAtLeast` checks the same range.

## Idea 2: the walker as arithmetic

### The problem

A paragraph flows around a window you drag, and every word moves to its new place, as in text-walker's demo, where each word springs there, and in HandwiredOS's Notes window until October 13, 2026. Every line gets its own width from the obstacle, every word needs its own x and line, and clicking a word makes it bold, which changes its width while the page runs.

The familiar way is the greedy walker above, called once per line with that line's width, e.g. pretext's dynamic-layout demo calls `layoutNextLine(prepared, cursor, width)` for every band of the column, i.e. every horizontal strip one line tall, with the width left over by the obstacles in that band.

### A line's end is a count

The walker's loop stops at the first segment that doesn't fit. A circuit has no loop that stops early, but it can compute every "does it fit" bit at once and add the bits up.

For a line that starts at segment s, let `fits[j]` be the bit "the line from s through segment j fits": `[width of segments s..j <= maxWidth + lineFitEpsilon]`, where a space leaves out its own width because it hangs. As j grows the width never shrinks, because widths are never negative. So the bits read 1, 1, …, 1, 0, 0, …: once a segment doesn't fit, no later segment fits either. Bits like that are called monotone.

The first segment that doesn't fit is then `s + 1 + (the number of ones)`, a count with no search. The [loops section](loops.md#1-count-instead-of-search) explains the same idea for the first visible row of a list. Simplified from `emitLineEnd` in [counting.ts](../examples/text/counting.ts), which also computes the painted width:

```ts
function emitLineEnd(circuit: Circuit, source: WalkerSource, paragraph: Paragraph, lineStart: number): Wire {
  const widths = source.segmentWidths // source cells
  const endTerms: [Wire, number][] = []
  for (let segment = lineStart + 1; segment < widths.length; segment++) {
    // The width of the line from lineStart through `segment`, leaving out a space's own width.
    const spanTerms: [Wire, number][] = []
    for (let index = lineStart; index < segment; index++) spanTerms.push([widths[index]!, 1])
    if (paragraph.breaksAfter[segment] === 0) spanTerms.push([widths[segment]!, 1])
    endTerms.push([emitFits(circuit, source.unit, source.maxWidth, spanTerms), 1])
  }
  return circuit.roundAffine(endTerms, lineStart + 1)
}
```

E.g. at maxWidth 100 px, for the line that starts at "The" (segment 0): the space after "The" gives a width of 25 px, so its bit is 1; "quick" gives 70.25 px, 1; the space after "quick" gives 70.25 px, 1; "brown" gives 118.25 px, 0, and every later bit is 0. Three ones, so the line ends at segment 0 + 1 + 3 = 4, before "brown", the same as the walker.

### Why the fit comparison is exact

`emitFits` is text-walker's comparison, `boolean(clamp01(64 × (maxWidth + ε − span) + 0.5))`, 4 operations in 3 layers. It adds the span's widths first, then maxWidth, then the constant 64 × 0.005 + 0.5 = 0.82, so large terms cancel before the small constant is added.

When every width and maxWidth are multiples of 1/64 px, and 64 × span stays below 2^24, the sum before the constant is an exact integer k = 64 × (maxWidth − span). The score is then about k + 0.82: at least 0.75 when the line fits (k ≥ 0), and below 0 when it doesn't (k ≤ −1). The example's widths are multiples of 1/4 px and its test widths are multiples of 1/16 px, so every bit is exact. For real canvas widths, which aren't on such a grid, text-walker's README says the comparison is exact when the difference is at least about 1/128 px.

### The painted width from the same bits

The painted width uses the same bits in a telescoping sum, i.e. a sum of differences between neighbors, whose first k terms add up to the value at k. Here `paintedWidth = width of the first word + Σ fits[j] × (what segment j adds to the painted width)`, where a word adds its own width plus the space before it, and a space adds nothing while it's the last segment on the line. Each term is one ReLU-gated product, i.e. one value times the ReLU of another, here a width times a bit.

For the example, the line end and painted width for all 9 word starts at once are 238 live operations in 5 layers with 753 stored weights. The builder shares identical expressions, so the bit for a space and the bit for the word before it, which compare the same sum, become one comparison.

### Prefix sums instead of repeated sums

The example writes out every span as its own sum, which stores about lookahead²/2 weights per line start, where the lookahead is how many segments after a line's start the circuit compares. text-walker's fast-walker.ts computes prefix sums instead: `S[j]`, the running total of the widths through segment j, built with a Brent-Kung network, a parallel prefix sum of about 2n additions in about 2 log2(n) layers (see the [loops section](loops.md#3-prefix-sums-three-ways)). A span is then a difference of two prefix sums. From width cells and break-after bits, the circuit computes:

- the prefix sums, exact for quarter-pixel widths while the paragraph stays below 2^17 px in total,
- each segment's fit threshold, `T[j] = S[j] − breakAfter[j] × width[j]`, so a space or a zero-width space adds nothing to the fit,
- the painted prefix of a line that ends before segment j, which is `T[j − 1]`,
- how many break-after segments a new line skips at its start, as sums of products of neighboring break-after bits, e.g. `skip(j) = b[j] + b[j] × b[j + 1]` when runs of break-after segments are at most 2 long.

On pretext's fast path, `prepare` has already merged everything that must not break, and pretext's comment on `layout()` states the rule: "Break before any non-space segment that would overflow the line". So as long as every line is at least as wide as the widest segment, a line always ends just before the first text segment that doesn't fit, and counting fit bits reproduces pretext.

Measured: over all 1,281 widths from 160 to 320 px in 1/8 px steps, the five formulations below matched pretext at 63 and 255 segments, and four of them at 1,023 segments, with the fake canvas. In Chrome with real Georgia widths, text-walker's demo counted 0 mismatches against pretext's `layoutNextLineRange` over 236 states, including drags, bold toggles and column width changes.

### Chaining lines, and why reading at a computed index dominates

Line 2 starts where line 1 ends, and that position is a runtime integer. So reading "where does the line that starts at p end" at a runtime p is reading a table at a computed index. The example here and text-walker were written before numeric-ui-core.ts had an index read instruction, so each read builds an integer one-hot at position p, e.g. `[0, 0, 1, 0]` for p = 2. The sum `bit[0] × table[0] + bit[1] × table[1] + …` then reads the entry, and the compiler turns that sum into one gather read: it keeps the operations that build the one-hot, and replaces the products with a lookup at the marked position. The [indexing section](indexing.md#way-1-a-one-hot-masked-sum) explains these reads.

From `buildWalkerCircuit` in counting.ts:

```ts
let start: Wire = source.firstLineStart
for (let slot = 0; slot < lineSlots; slot++) {
  const members = emitIntegerOneHot(circuit, source.unit, start, segmentCount, oneHotWires)
  slotStarts.push(start)
  slotWidths.push(emitMaskedRead(circuit, members, widthBySegment))
  start = circuit.roundAffine([[emitMaskedRead(circuit, members, nextMinusCount), 1]], segmentCount)
  circuit.assumeRange(start, 0, segmentCount)
}
```

The number of line slots is chosen while building, as many as the narrowest width needs. `emitIntegerOneHot` builds each bit with text-walker's tent function, `relu(x − p + 1) − 2 relu(x − p) + relu(x − p − 1)`, which is 1 at x = p and 0 at every other integer. Neighboring positions share their ReLUs, so a one-hot costs about 2 operations per position.

Two details in those lines prevent real bugs:

- The table holds `lineEnd − segmentCount`. Once the text has ended, a slot's start is `segmentCount`, its one-hot is all zeros, the read returns 0, and adding `segmentCount` back keeps the start at the end.
- The first line's start is a source cell even though it's always 0. The builder evaluates sums of constants while building, so a one-hot built from a constant start turns into duplicate wires, which `assumeOneHot` rejects.

This is where the cost goes. A one-hot over N positions costs about 2N operations and is built once per line slot, while the comparisons per slot cost about 4 × lookahead. In the example, 9 line slots take the circuit from 238 to 582 live operations and from 5 to 40 layers, and 306 of those 582 operations, exactly 9 slots × 2 × 17 positions, build one-hots. text-walker's counts follow the same formula: at 1,023 segments with 157 line slots, the one-hots are 157 × 2 × 1,023 = 321,222 operations, while comparing a lookahead of 21 segments per slot is about 157 × 21 × 4 ≈ 13,000 operations.

So recovering L lines of an N-segment paragraph this way is O(L × N) operations and O(L) layers, and at realistic sizes the one-hots dominate. text-walker, fast path, fake canvas, widths 160 to 320 px:

| Segments | Formulation | Live operations | Layers | Share of live operations building one-hots | Estimate with an index read instruction |
| --- | --- | --- | --- | --- | --- |
| 63 | gathered lines | 3,417 | 90 | 33% | 2,292 |
| 255 | next-start table + pointer jumping | 235,633 | 100 | 83% | 40,561 |
| 1,023 | next-start table + sequential lines | 457,882 | 725 | 70% | 136,817 |
| 1,023 | gathered lines | 361,890 | 1,374 | 89% | 40,825 |
| 1,023 | next-start table + segment scan | 166,147 | 4,128 | 0% | 166,147 |
| 1,023 | segment walker | 23,496 | 9,204 | 0% | 23,496 |

The estimate replaces every one-hot group with one operation, as if the executor could read a table at an integer wire. It's an estimate, not a built circuit. The index-read prototype added such an instruction, `indexRead`, to its own copy of the runtime, and code-points and streaming-words used that copy. Since September 14, 2026, numeric-ui-core.ts has the same instruction ([decision 1](../review-and-decisions.md#1-should-the-shared-runtime-get-an-index-read-instruction)), but nobody has rebuilt text-walker's circuits with it yet.

Gather lowering also keeps a list of candidate positions for every read, one per segment. For gathered lines at 1,023 segments those lists add up to 10.3 million table entries.

A read through a one-hot at a computed position is the same read as hard attention whose keys are positions, which the [indexing section](indexing.md#hard-attention-as-the-limit) explains.

### Five ways to recover lines

- **Next-start table + sequential lines.** The line end for every start, from comparisons with the segments within the lookahead, then one one-hot per line slot to read the table. O(N × lookahead) operations for the table plus O(L × N) for the slots, and O(L) layers, about 4.6 layers per slot at 1,023 segments.
- **Gathered lines.** There's no next-start table. For each line slot, the circuit builds the one-hot of the slot's start, reads through that one-hot the fit thresholds of the segments after that start, e.g. the next 21 segments, and compares those thresholds with that line's own width. This is the only formulation that takes a different width per line. O(L × (N + lookahead)) operations and O(L) layers, about 8.75 layers per slot at 1,023 segments.
- **Next-start table + segment scan.** Whether segment j starts a line is computed from the earlier segments' next starts, one segment after another. There are no reads at a computed index, but it adds about 4 layers per segment.
- **Next-start table + pointer jumping.** Tables of "the start 2 lines later", "4 lines later" and so on, each built from the previous table, so L lines are reached in about log2(L) rounds (see the [chains section](chains.md#way-3-pointer-jumping-for-linked-structures)). It wasn't built at 1,023 segments, where its top level reads about 21 × 64 positions for each of the 1,023 starts.
- **Segment walker.** pretext's loop unrolled one segment at a time: the fewest operations, O(N), and the most layers, about 9 per segment.

With an index read instruction, each slot's one-hot becomes one operation, e.g. gathered lines would be O(N + L × lookahead) operations, and text-walker estimates that pointer jumping would go from about quadratic work to about N log N.

### Hard breaks, long words, soft hyphens, letter spacing and tabs

The fast path's thresholds are sums that the circuit computes from width cells. For pretext's other features, text-walker computed the thresholds in JavaScript instead, and the circuit only compares them with each line's own width.

The idea behind text-walker's rows.ts: for a fixed line start, the walker's state (the line's width so far, the pending break, where the line would end) changes the same way whatever maxWidth is, until the first comparison against `maxWidth + lineFitEpsilon` fails. So JavaScript can follow the walker's code as if every comparison passes, and record each comparison as a candidate: the width compared, and the line the walker would produce if that comparison were the first to fail.

`deriveCandidates` in [candidates.ts](../examples/text/candidates.ts) derives these lists for the example walker. For the line that starts at "The":

| Compared when adding | Width compared (px) | If this comparison fails first, the line ends before | Painted width (px) |
| --- | --- | --- | --- |
| "quick" | 70.25 | "quick" | 25 |
| "brown" | 118.25 | "brown" | 70.25 |
| "fox" | 149.5 | "fox" | 118.25 |
| "jumps" | 196 | "jumps" | 149.5 |
| "over" | 236 | "over" | 196 |
| "the" | 267.5 | "the" | 236 |
| "lazy" | 305.25 | "lazy" | 267.5 |
| "dog." | 343.75 | "dog." | 305.25 |
| every comparison passes | | the end of the text | 343.75 |

Spaces add no candidates, because the walker never compares a space. text-walker measured what that saves: a 320 px line needs 8 candidates where the fast walker compares 20 segments.

The circuit reads one line's candidates from source cells, and compares every candidate with that line's own width. From `buildCandidateCircuit` in candidates.ts:

```ts
const endTerms: [Wire, number][] = [[source.firstEnd, 1]]
const paintedTerms: [Wire, number][] = [[source.firstPaintedWidth, 1]]
for (let index = 0; index < capacity; index++) {
  const fits = emitFits(circuit, source.unit, source.maxWidth, [[source.fitWidths[index]!, 1]])
  endTerms.push([circuit.multiply(source.endChanges[index]!, fits), 1])
  paintedTerms.push([circuit.multiply(source.paintedWidthChanges[index]!, fits), 1])
}
const lineEnd = circuit.roundAffine(endTerms)
const paintedWidth = circuit.roundAffine(paintedTerms)
```

The sums start from the line if the first candidate fails, and for every candidate that fits, the sums add how much the line grows until the next candidate: the same telescoping sum as before. For the example, 8 candidates are 50 live operations in 5 layers. text-walker's rows-circuit.ts does this for every line slot, reading the list at the slot's start through a one-hot. The example's test checks the lists, in plain JavaScript and in the circuit, against the walker for every line start at every width in the sweep. It checks again after "quick" turns bold, with the lists derived again in JavaScript and the same circuit.

What each pretext feature needed in text-walker's JavaScript derivation:

- **Hard-break chunks**, i.e. the text between two newlines in pre-wrap: nothing new. A chunk's end is a line end that holds at every width, and an empty chunk is a list with no candidates.
- **Breakable long words**: every grapheme of a segment that can overflow becomes its own line start position, so 18 segments became 118 positions. Every such grapheme is a candidate, and the earlier break inside the word that pretext falls back to is fixed per failing grapheme. For that sample text the circuit was about ten times the size of the plain text sample's circuit (25,762 against 2,480 live operations).
- **Soft hyphens**: nothing new in the Gecko profile, where both outcomes of pretext's check for the hyphen's width give the same line. rows.ts asserts that at every candidate.
- **Letter spacing**: the raw compared widths can decrease along a line, e.g. the width compared for a text segment includes its trailing letter spacing gap, and the width compared for a following space doesn't. rows.ts replaces them by their running maximum, which keeps the same first failure and makes the bits monotone again.
- **Tabs in pre-wrap**: a tab's advance depends on its position in the line, which is fixed once the line start is fixed. A break-after segment that overflows hangs only when the line before it fits, so it gets two candidates: "the line before it overflows" and "the segment itself overflows".

Every step matched pretext with the fake canvas in the Gecko profile, both at one width for every line and at random widths per line. The limit is that these thresholds are prepared data, not runtime sums: per-line widths change at runtime, but editing a segment's width, the letter spacing or the tab stops means running rows.ts again and rewriting cells. Not restated: Blink's return from a soft hyphen that doesn't fit, WebKit's rule against breaking before NEL (U+0085, next line), pretext's entry geometry for default-ignorable code points, i.e. characters like the zero-width joiner that draw nothing, and rich inline items.

### Streaming text

streaming-words used the fast-path walker for a streamed chat reply. The circuit is built for a capacity, e.g. 95 segments for a 48-word reply, and a word that hasn't arrived yet is a segment of width 0. A segment of width 0 always fits, so absent segments stay at the end of the last line, and arrived words get pretext's line and x with no change to the walker: 0 mismatches over 7,419 streamed states. The line count is the number of line slots whose start comes before the arrived count, which needs no read at a computed index. A 48-word reply with its bubble and a spring per word is 18,522 live operations in 169 layers, and each line slot adds about 8 to 9 layers.

### In HandwiredOS: the Notes window

[indirect-os-2](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/indirect-os-2) put a Notes window into HandwiredOS whose paragraph flows around the three other windows, with a spring per word: 45 words and 89 segments in 16 bands, i.e. horizontal strips one line tall, of 22 px each, in a column of at most 440 px, and the walker compares at most 26 segments from each line start. Adding the Notes flow cost 11,795 live operations, 174 layers and 28,289 stored weights, more than the whole original desktop's 5,253 operations, and its line walker alone is 8,221 operations. On September 15, 2026, the word springs were removed, and the Notes flow cost 9,968 operations, 168 layers and 22,715 stored weights. On September 16, 2026, root HandwiredOS took this flow, in notes.ts and notes-walker.ts, and kept it until October 13, 2026, when Notes became the browser's own text field. [status.md](../../../status.md#runtime-additions-since-september-14-2026) has the flow's last cost.

Obstacles should be the windows' destinations, not their drawn positions. With window destinations as obstacles, every animated value differed by at most 2.4e-4 px between 60 and 120 fps, on a scripted session whose events all sit on 60 fps frame times. With the windows' geometry as drawn on the current frame, words differed by 25.4 px, because the words' destinations then follow windows that are still animating, and each frame rate retargets the words toward a different series of destinations. Since the word springs were removed, words at shared timestamps are identical with either obstacle source, and the windows' current geometry instead makes the text reflow in 8 frames with no event while Photos maximizes and restores.

### Cost summary

- One line's end from a known start: O(lookahead) comparisons at constant depth, plus the prefix sums, which are O(N) additions in O(log N) layers with Brent-Kung, or one wide sum per prefix in 1 layer with about N²/2 stored weights.
- Every start's line end: O(N × lookahead) comparisons at constant depth.
- L lines chained through one-hots: O(L × N) operations and O(L) layers. numeric-ui-core.ts has had the index read instruction since September 14, 2026, which would bring this to about O(N + L × lookahead) operations, but no text circuit has been rebuilt on it, so that size and the table's last column are still estimates.
- Each word's x and line index from the slots' one-hots: one product per segment per slot, O(N × L).

### When not to use the walker

- When one width drives a block of fixed text, tabulation is much smaller and 4 layers deep, e.g. the Notes window's 10 tabulated blocks are 1,041 operations with every painting output.
- For long paragraphs chained through one-hots, as text-walker built them: at 1,023 segments, gathered lines are 361,890 operations, 89% of them one-hots. The index read instruction in numeric-ui-core.ts would replace those one-hots, but nobody has rebuilt text-walker on it yet.
- For speed. On the CPU executor the walker circuits ran 50 to about 1,000 times slower than pretext's own walker. The reason to use the walker is that text becomes part of one program with window geometry and springs.

### Pitfalls

- **Bounds are fixed while building**: the lookahead, the number of line slots, and the run limit, i.e. the longest run of break-after segments, e.g. a space followed by two zero-width spaces is a run of 3. text-walker outputs an overflow count for each bound. Those outputs matter: without `runOverflow`, a paragraph with longer runs than the circuit was built for starts lines at the wrong segment, and no output shows the problem.
- **Lines narrower than the widest word.** The counting formulation assumes every line is at least as wide as the widest word. The example's test found a concrete case: with "quick" bold at 44.25 px and a width of 43 px, the bit for the space after "quick" is 0, so the circuit ends the line before that space, while the walker ends it after the space. pretext itself would break "quick" between graphemes there. The candidate lists don't have this problem, because JavaScript derives them from the walker's own rule that a line keeps its first word.
- **Real fonts.** Real canvas widths aren't multiples of 1/64 px, so a width within about 1/128 px of a threshold can break differently from pretext. text-walker's demo counts such mismatches instead of assuming there are none, and HandwiredOS's notes-paragraph.ts, deleted on October 13, 2026, rounded widths to 1/64 px in JavaScript so that prefix sums stayed exact in FP32.

## Idea 3: code points and break rules inside the circuit

### The problem

[text-editing](../../code-points/README.md#merged-from-text-editing-september-16-2026) put a text field's editing model into one circuit, but what counts as a character was computed in JavaScript: JavaScript segmented graphemes, classified each new grapheme with a regex, and gave each one a code from a 96-entry table. Lines could only break at spaces and newlines, so CJK text next to Latin words wrapped differently from pretext in 2,023 of 2,460 layouts.

### What moved into the circuit

In code-points, each text cell holds one Unicode code point, the number Unicode assigns to a character, e.g. U+5B57 for 字. Code points are below 2^21, so they're exact in FP32. For every cell, the circuit reads from tables held in source cells:

- the line break class, one of 41 classes that start from UAX #14, the Unicode line breaking algorithm, and add distinctions pretext makes, e.g. CJK punctuation, and opening and closing quotes,
- the advance, from a table JavaScript fills when a code point first appears,
- three properties of the class: space or newline, newline, and word,
- the break bit between this cell and the next, from a 41 × 41 table over pairs of classes.

The familiar JavaScript is a lookup per pair of neighbors:

```ts
function mayBreakAfter(codePoints: readonly number[], index: number): boolean {
  return pairTable[classOf(codePoints[index]!) * classCount + classOf(codePoints[index + 1]!)] === 1
}
```

In the circuit it's one read at a computed index, from code-points' editor-circuit.ts:

```ts
circuit.indexReadAffine([[lineBreakClass, classCount], [classes[cell + 1]!, 1]], 0, tables.pairs, 'clamp', 'clamp')
```

The index is `class × 41 + nextClass`. `indexReadAffine` is the index read instruction in code-points' copy of index-read's runtime, which numeric-ui-core.ts now has too: it reads `candidates[floor(index)]` as one operation, with no one-hot.

The class table has two levels to stay small. Code points are grouped in blocks of 128, blocks with identical classes share one page, and a first read gives the block's offset, so a code point's class sits at `blockOffsets[floor(codePoint / 128)] + codePoint`. E.g. 字 (U+5B57) is in block 182, and if that block's classes are on page 12, its class is at `(12 − 182) × 128 + 0x5B57`. Storing offsets instead of page numbers makes the second index a plain sum of two exact integers. All 1,114,112 code points fit in 194 distinct pages.

Cost: 8 index reads per cell in 3 layers, so decoding is O(capacity) operations at constant depth. text-editing's decode was also 8 operations per cell, in 5 layers, and had no break opportunities except spaces and newlines. The tables cost source cells instead of operations: 53,917 cells, almost all written once.

### Measured

- Against pretext's pre-wrap walker, over 41,820 layouts in 13 families of text (fake canvas, 41 widths from 30 to 400 px), line start mismatches went from 8,806 with text-editing's rules to 418 with the pair table, and to 215 when CJK runs that don't fit on a line are kept whole. The CJK family went from 2,023 to 0, and the Korean family from 1,620 to 0.
- Of the 215 left, 176 are a hyphen before digits: pretext breaks after the hyphen in `0-93` but keeps ` -5` together, and a table over pairs of neighbors gives the same result for a range and a sign, because the rule depends on the character before the hyphen, which a pair of neighbors doesn't include. 26 come from pretext moving the space after a CJK unit that doesn't fit to the next line, 12 from pretext not breaking after `!` before an ASCII letter, which finer classes could express as pairs, and 1 layout has both of the last two causes.
- One key per evaluation at 256 cells is 42,326 live operations with index reads, 22% below text-editing.
- Every one of the 1,114,112 code points read back its class, advance and break bit with no mismatches, and a font change rewrote 92 advance entries and no text cells.

### What stayed in JavaScript, and what wasn't built

- **Measuring.** JavaScript measures a code point with canvas the first time it appears, and writes its advance into a page. Building the class table once (1,114,112 calls of `classOfCodePoint`, 35 to 63 ms) and normalizing newlines (CR LF to LF) also stay in JavaScript.
- **Grapheme clusters.** What a person sees as one character can be several code points, e.g. 👩‍💻 (a woman, a zero-width joiner and a laptop) or a letter followed by combining accents. One code point per cell splits these, so the caret can stop inside them, and a line may break after a zero-width joiner, where UAX #14 says it mustn't.
- **Bidi.** Laying out mixed right-to-left and left-to-right text, e.g. an Arabic sentence containing an English name.
- **Shaping and kerning.** A glyph's shape can depend on its neighbors, e.g. Arabic letters or ligatures, and a font can store adjustments for specific pairs, e.g. "AV" narrower than "A" plus "V". Advances per code point ignore both, so the circuit's positions only match a real text renderer for fonts whose advances add up.
- Also not built: tab stops, drawing a hyphen at a soft hyphen break, `word-break: keep-all`, `line-break: strict` and `loose`, and dictionary breaks for Thai and similar scripts.

### When not to use it, and pitfalls

- **Without an index read instruction.** Every cell reads pages of 128 classes and a 1,681-entry pair table, so reading through one-hots would cost operations proportional to the table size for every read. code-points relies on index-read's copy of the runtime, and numeric-ui-core.ts now has the same instruction.
- **Rules that need more than two neighbors.** Number ranges versus signs (176 layouts) need the class before the pair, and a table over three classes would be 41^3 = 68,921 cells.
- **A full pool of advance pages.** Advances live in pages of 128 per block of code points, and the number of pages is fixed while building. E.g. the 92 code points of code-points' typing paragraph needed 34 pages plus an all-zero page, because ideographs spread across many blocks. A full pool drops new code points and reports how many.
- **Validating static tables on every evaluation.** The executor checks every source cell's range on every evaluation, which for the 53,917 table cells took about 49 µs of an evaluation of about 447 µs, although the tables only change when a new code point or font arrives.

## Does a paragraph ever get more lines when it gets wider?

### Why it matters

Tabulation's sampler assumes that as the width grows, the layout only moves forward: it never gets more lines, and no line starts earlier. Otherwise a change and its reversal can both fall between two samples. pretext's bubbles demo makes the same assumption when it binary searches for the narrowest width that keeps a bubble's line count.

For the example walker the proof is short. From the same start, a wider line ends at the same segment or later, and a line that starts later ends at the same segment or later, so as the width grows every line's start stays or moves forward.

### Plain text: no case found

text-tabulated's monotone-search.ts checked 2,400 random texts, 400 for each of the Blink, WebKit and Gecko profiles, each with and without kerning. The texts mixed emergency breaks, dashes, URLs, soft hyphens, no-break spaces, CJK, emoji, tabs and newlines in pre-wrap, keep-all and letter spacing. With the fake canvas, results can only change at widths on a known grid, so one sample inside each interval of that grid is exhaustive, and the search covered widths from 0.25 to 700 px. It found 0 line count increases and 0 line starts moving backward.

### Rich inline: a wider paragraph can have more lines or an earlier line start

Rich inline is pretext's API for a paragraph made of items with their own fonts, e.g. a chip or a code span inside a sentence (`prepareRichInline`). Over 80 random flows per engine profile, 71 have at least one range of widths where, compared with a slightly narrower width, the layout has more lines, or some line starts earlier. Most of those ranges are exactly one `lineFitEpsilon` wide, e.g. 1,691 of 1,696 ranges in the Blink profile.

### The minimal example

Two items in the Blink profile: "q" at 12px, then "-w" at 20px. The fake canvas measures "q" as 6.9375 px, "-" as 6.875 px and "w" as 9.375 px, so "-w" is 16.25 px, and both items together are 23.1875 px. Rerun in a scratch copy of pretext at revision 477510e, with text-tabulated's fake canvas:

| maxWidth (px) | Lines |
| --- | --- |
| 23.18 to 23.1824 | "q-" / "w" |
| 23.1825 to 23.1874 | "q" / "-w" |
| 23.1875 and wider | "q-w" |

At 23.1825 px the second line starts earlier than at 23.18 px: the layout moved backward as the width grew.

The cause is two checks in `stepRichInlineLine` (src/rich-inline.ts) that treat the epsilon differently. After "q", the line has `remainingWidth = maxWidth − 6.9375` left, which at 23.1825 px is 16.245 px. The "-w" item has no gap before it and no extra width, so its available width is also 16.245 px.

1. Line 735 puts the whole item on the line only when `totalWidth <= remainingWidth`, without the epsilon. 16.25 > 16.245, so the whole item isn't put on the line.
2. The item then goes to pretext's line walker (line 755, `stepPreparedLineGeometry(item.prepared, lineEnd, availableWidth)`), whose fit limit is `availableWidth + lineFitEpsilon` = 16.25 px. So "-w" fits whole.
3. Line 769 checks the walker's result, again without the epsilon, and ends the line before the item:

```ts
if (hasContent && atItemStart && lineWidthContribution > remainingWidth) break lineLoop
```

At 23.18 px, `remainingWidth` is 16.2425 px and the walker's fit limit is 16.2475 px, so "w" doesn't fit, the walker ends the item's first line after the dash, and its 6.875 px passes line 769: "q-" / "w". From 23.1875 px, step 1 puts the whole item on the line.

The same mismatch can add a line. "u" at 16px followed by "了解で" at 20px has 2 lines up to 46.9949 px ("u了" / "解で"), 3 lines from 46.995 to 46.9999 px ("u" / "了解" / "で"), and 2 lines from 47 px ("u了解" / "で").

### A candidate fix, checked only in scratch copies

Giving line 769 the same epsilon, `lineWidthContribution > remainingWidth + lineFitEpsilon`, removes both ranges in a scratch copy. "q" and "-w" give "q-" / "w" up to 23.1824 px and "q-w" from 23.1825 px, and "u" and "了解で" give "u了" / "解で" up to 46.9949 px and "u了解" / "で" from 46.995 px. pretext's own src/layout.test.ts passes before and after the change (173 tests).

text-tabulated's search (80 random rich inline flows with seed 12, swept exhaustively on the fake canvas grid from 1 to 500 px) was rerun against scratch copies with and without the change. The unchanged copy reproduced text-tabulated's counts. The change removed every range exactly one epsilon wide, and left the wider ranges as they were:

| Engine profile | Flows with a backward step, before / after | Ranges one epsilon wide, before / after | Wider ranges, before / after |
| --- | --- | --- | --- |
| Blink | 71 / 3 | 1,691 / 0 | 5 / 5 |
| Blink, kerning | 71 / 4 | 1,708 / 0 | 6 / 6 |
| Gecko | 71 / 33 | 2,073 / 0 | 94 / 94 |
| Gecko, kerning | 71 / 33 | 2,089 / 0 | 94 / 94 |
| WebKit | 71 / 32 | 1,567 / 0 | 87 / 87 |
| WebKit, kerning | 71 / 32 | 1,577 / 0 | 86 / 86 |

Nobody compared these flows with browsers, so whether browsers lay them out like the patched or the unpatched pretext is still open. The guide's [decision 7](../review-and-decisions.md#7-should-pretext-take-the-epsilon-change-at-srcrich-inlinets769) recommends laying out the two minimal flows in Chrome, Safari and Firefox before changing pretext.

### Wider ranges involve soft hyphens

The wider ranges are a different problem. Every flow with a range of 1 px or more contains a soft hyphen, removing the soft hyphens removes those ranges, and the widest is 10.4 px, in the Gecko profile with kerning. A minimal flow in the Gecko profile is "T" at 12px followed by "po­d" at 16px, with a soft hyphen after "po". At 24.1 px the lines are "Tp" / "od". From 24.12 to 29.625 px, compared with 24.1 px, the layout first has an extra line ("T" / "po-" / "d"), then a second line that starts earlier ("T" / "pod"). From 29.625 px the lines are "Tpo-" / "d". Nobody traced which branch of `stepRichInlineLine` causes these ranges, and the ranges between one epsilon and 1 px wide in Gecko and WebKit weren't examined.

### What this means for tabulation

Tabulation still found every change on text-tabulated's two realistic rich inline flows, a 15-item note and a 24-item chat message: on each flow, 0 of 84,482 exhaustively checked widths gave a result different from the table's. The ranges one epsilon wide sit right next to a real change, where bisection evaluates widths anyway. That's a measurement on two flows without soft hyphens, not a guarantee. The bubbles demo's binary search for a bubble's tight width assumes the line count never goes up, so for rich inline the search's result can differ from the true narrowest width, by several px when a soft hyphen is involved.

## Choosing a technique

| What the UI needs | Technique | Why |
| --- | --- | --- |
| Heights of fixed text at one runtime width, e.g. cards in a resizing column | tabulation, with only the line count thresholds | 4 layers, and about one threshold per 50 to 56 characters |
| Shrink-wrapped chat bubbles, balanced headings | tabulation | JavaScript runs the search while tabulating, and the circuit reads the result for the current interval |
| The painted lines of short blocks | tabulation | painting grows with line slots × thresholds, so keep it to short blocks or visible lines |
| A different width per line, e.g. text around a moving window | walker, gathered lines | the only formulation that compares each line with its own width |
| Each word's x and line, e.g. a spring per word | walker | x and the line index come from the slots' one-hots |
| Word widths that change at runtime, e.g. bold on click, or streamed words | walker, fast path | widths are source cells, so there's no rebuild |
| Soft hyphens, long words, tabs or letter spacing, with per-line widths | walker over candidates derived in JavaScript (text-walker's rows.ts) | per-line widths at runtime; any edit to the text derives the candidates again |
| An editable field with CJK line breaking | code points with the pair table | break rules are table data, but it needs the index read instruction |

## Runnable examples

From the repo root:

```sh
bun test lab/ui-exploration/guide/examples/text      # 11 tests in 2 files, about 0.2 s
bunx tsgo -p lab/ui-exploration/guide/examples/text
bun lab/ui-exploration/guide/examples/text/report.ts # thresholds, candidates and circuit sizes
```

- [paragraph.ts](../examples/text/paragraph.ts): the example paragraph and the plain JavaScript greedy walker.
- [pretext-agreement.test.ts](../examples/text/pretext-agreement.test.ts): checks that pretext's `prepareWithSegments`, with text-tabulated's fake canvas, gives the example's segments, widths and kinds, and that the walker matches pretext's `walkLineRanges` and `layout` at every 1/16 px from 43 to 360 px and next to every threshold.
- [tabulated.ts](../examples/text/tabulated.ts): the threshold search over FP32 bit patterns, the exact width comparison, sums of changes, and a circuit with only the line count thresholds.
- [counting.ts](../examples/text/counting.ts): a line's end and painted width as counts of fit bits over width cells, the table for every word start, and line slots chained through integer one-hots.
- [candidates.ts](../examples/text/candidates.ts): candidate lists derived in JavaScript, the first failing candidate in plain JavaScript, and a circuit that compares a line's candidates with that line's own width.
- [size.ts](../examples/text/size.ts): live operations, layers, stored weights and one-hot operations after compilation.
- [report.ts](../examples/text/report.ts): prints the numbers this section quotes for the example.
- [text.test.ts](../examples/text/text.test.ts): checks every circuit against the walker at every 1/16 px from 43 to 360 px, next to every threshold, and on the paragraph with a bold "quick", with the walker and candidate circuits reused without rebuilding.

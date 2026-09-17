# Knuth-Plass line breaking as min-plus matrix products

## Why

Cheng asked: "technically our pretext layout, if there's lots of them, is faster than the regular cpu's, then?" The answer so far is a prediction: one paragraph on the GPU loses, since pretext's `layout()` is cheap float64 arithmetic that stops at the end of the text while a program pays for every line slot, and a GPU round trip has a fixed cost, while many paragraphs in one dispatch should win past some count. [text-walker's many paragraphs on the GPU](../ui-exploration/text-walker/README.md#many-paragraphs-on-the-gpu-september-17-2026) measures that for greedy line breaking. Cheng also pointed at pretext's Knuth-Plass demo, node_modules/@chenglou/pretext/pages/demos/justification-comparison.*: optimal line breaking is a shortest path over break points, so it fits min-plus matrix products combined in a tree, with one batched kernel per level of the tree, like [regex-search's matrix product tree on the GPU](../regex-search/README.md#matrix-product-tree-on-the-gpu-september-17-2026). Cheng approved both experiments: "yes to both".

This folder is the CPU half of the Knuth-Plass experiment: a plain JavaScript reference, two program forms that give the reference's costs and breaks, their CPU numbers, a page, and an export of leaf matrices for the GPU step. Nothing here runs on the GPU yet.

## How to run it

From the repo root:

```sh
bun test lab/knuth-plass                                  # 10 tests in 1 file, about 1 second
bunx tsgo -p lab/knuth-plass                              # type-check
bunx oxlint --type-aware lab/knuth-plass                  # lint
bun lab/knuth-plass/demo.html                             # the page, e.g. ?form=tree&window=16, and ?check=1 compares every evaluation with the reference
bun lab/knuth-plass/report.ts one sizes tree 256 16       # one variant's sizes, see the comment at the top of report.ts
bun lab/knuth-plass/report.ts all --out <file.jsonl>      # every variant in its own process
bun lab/knuth-plass/report.ts tables lab/knuth-plass/results/cpu-1.jsonl lab/knuth-plass/results/cpu-2.jsonl   # the tables below
bun lab/knuth-plass/export.ts <folder> --breaks 1024 --window 16 --count 16   # leaf matrices and expected results for the GPU step
```

| File | What it holds |
| --- | --- |
| `paragraph.ts` | Paragraphs as break points, the constants of the line cost, random paragraphs, and break points from pretext's segments |
| `reference.ts` | The dynamic programming reference, and the same costs as min-plus matrix products in plain JavaScript |
| `program.ts` | The cells, both program forms, writing a paragraph into cells, and reading the output |
| `hyphenation.ts` | Soft hyphens inserted like pretext's demo, from the demo's tables |
| `knuth-plass.test.ts` | Differential tests |
| `report.ts`, `results/` | Sizes and µs, one process per variant, and the raw results |
| `export.ts` | Leaf matrices, cells and expected results for the GPU step |
| `demo.html`, `demo.ts` | The page |

## The paragraph and the line cost

A paragraph is n + 1 break points: break point 0 is the start and break point n the end, and a line from break point `from` to break point `to` holds the boxes from + 1 to `to`, e.g. words, or the parts of a word between soft hyphens. Positions are whole pixels. `lineStarts[from]` is where a line that starts after break point `from` begins, i.e. after the space of a space break, and `lineEnds[to - 1]` is where a line that ends at break point `to` ends, i.e. before the space of a space break, or after the hyphen that a soft hyphen break draws. So a line's natural width is `lineEnds[to - 1] - lineStarts[from]`, and the program never adds up widths.

pretext's demo puts break points after every space and every soft hyphen, and `breakPointsOfPrepared` does the same from pretext's prepared segments, counting a space at the width of `' '` and a soft hyphen break at the width of `'-'`, like the demo. The demo's positions are float64 pixels, and `breakPointsOfPrepared` rounds each position to a whole pixel, so a line's natural width differs from the demo's by less than 1 px.

The demo scores a line with spaces by the width its spaces get when justified, `(maxWidth - wordWidth) / spaceCount`, cubed, plus penalties for rivers and tight spacing. That's a division by a runtime count and float64 cubes, which a program can't give exactly. So the reference and the programs use a variant:

```js
function lineCost(paragraph, from, to, maxWidth) {
  const slack = maxWidth - naturalWidth(paragraph, from, to)
  if (slack < 0) return to - from === 1 ? lineCostCap : infeasible // a single box wider than the column still gets a line
  if (to === breakCount) return 0 // the last line
  return Math.min(slack, 63) ** 2
}
```

with `lineCostCap = 63² = 3,969` and `infeasible = 2^22`. That's the demo's cost of a ragged line, `slack² × 10`, divided by 10, with the slack capped at 63 px. A one-box line that doesn't fit costs `lineCostCap`, so every paragraph has a solution, where the demo throws. The ranges keep every value exact in FP32:

- A path's total is at most n × 3,969, which stays below `infeasible` for n up to 1,056, `largestBreakCapacity`, so a path with a line that doesn't fit never ties with one that fits.
- A matrix entry is at most 2^22, so a sum of two entries, or of a total and a line cost, is at most 2^23 plus 3,969 from the squared slack, and comparing two such sums, `relu(left - right)`, adds and subtracts values of the same size, far below 2^24.
- The test `validateExactIntegerSums` checks every live operation: integer coefficients and biases, and every partial sum, in any order, within ±2^24 under the declared ranges. The largest bound is 8,396,546, just above 2^23, in the tree form. With integer cells, every value is then an exact integer.

The reference is dynamic programming over break points, for lines of at most W boxes:

```js
costs[0] = 0
for (let to = 1; to <= breakCount; to++) {
  let best = Infinity
  for (let boxes = 1; boxes <= Math.min(W, to); boxes++) {
    const total = costs[to - boxes] + lineCost(paragraph, to - boxes, to, maxWidth)
    if (total < best) { best = total; predecessors[to] = to - boxes }
  }
  costs[to] = best
}
```

**Tie rule.** Of equal totals, the shortest last line wins, i.e. the latest start, since the loop tries the shortest line first and replaces only on `<`. pretext's demo tries `from = to - 1` down to 0 and replaces only on `<` too. Over the whole paragraph, this picks the path whose breaks are largest when compared from the end.

**The window.** The programs consider lines of at most W boxes, and so does the reference. Both report `windowOverflowCount`, how many break points have a line of W + 1 boxes ending there that fits. E.g. the program's lines of the demo's paragraphs hold up to 17 boxes at 364 px and 28 at 600 px, soft hyphen parts included, so a window of 16 is too small for them from 327 px. When it's nonzero, the breaks are the cheapest among lines of at most W boxes, and the page says so.

## The programs

Both forms read the same cells: `maxWidth`, `lineStarts` and `lineEnds` for n break points, and `endsParagraph`, a one-hot of the last break point. A paragraph with fewer break points is written into the first cells, and past it, `lineStarts` hold 0 and `lineEnds` hold 2^20, so every line that reaches past the paragraph doesn't fit.

**Line costs, 3 operations each.** `squared` is one index read over the 64 constants 0, 1, 4, …, 3,969 at `maxWidth + lineStart - lineEnd - endsParagraph × 1,052,673`, which returns +0 below the table, i.e. for a line that doesn't fit and for the last line, and clamps to 3,969 above it. `overflows` is the integer bit `relu(1 - relu(1 - D))` on `D = lineEnd - lineStart - maxWidth`, like `emitCompare`'s integer bits in execution-model.md. The line cost is `squared + penalty × overflows` with penalty 3,969 for one box and 2^22 otherwise. Builder code keeps this sum as a list of terms, so each operation that reads a line cost adds its terms itself, and no operation holds the line cost alone.

**A minimum and its pointer, 4 operations.** `excess = relu(left - right)`, `value = left - excess`, which keeps the left candidate on a tie, `leftWins = relu(1 - excess)`, and `pointer = circuit.indexRead(leftWins, [right.pointer, left.pointer])`. A balanced tournament over the starts `to - 1, to - 2, …, to - W` in that order returns the first of the smallest totals, which is the reference's tie rule.

**(a) The chain.** One step per break point: the tournament over `costs[to - boxes] + lineCost(to - boxes, to)`, where `costs[to - boxes]` is an earlier step's value. So the program has about 2 log2 W layers per break point, and about 7W operations per break point, 3W for the line costs and 4(W − 1) for the tournament, plus 4 ceil(log2 n) + 3 to follow the pointers below.

**(b) The tree.** The state after break point `to` is the vector of the last W costs, `s[to] = [cost[to], cost[to - 1], …, cost[to - W + 1]]`, and one step is a W × W min-plus matrix, `s[to] = M[to] ⊗ s[to - 1]`, where `(A ⊗ B)[r][c] = min(infeasible, min over m of A[r][m] + B[m][c])`:

```txt
M[to], W = 4:
  row 0:  lineCost(to - 1, to)   lineCost(to - 2, to)   lineCost(to - 3, to)   lineCost(to - 4, to)
  row 1:  0                      infeasible             infeasible             infeasible
  row 2:  infeasible             0                      infeasible             infeasible
  row 3:  infeasible             infeasible             0                      infeasible
```

Clamping at `infeasible` keeps the product associative on 0..infeasible, so Brent-Kung's network from [src/runtime/prefix-networks.ts](../../src/runtime/prefix-networks.ts) gives every state in 2 log2 n − 2 combines along the longest chain. Three things keep it smaller than W³ minimums per combine:

- Item 0 is `M[1] ⊗ s[0]`, a vector, so every prefix is a vector, and a combine that completes a prefix is a matrix times a vector, W minimums of W sums. Only the upward pass's combines of two later blocks are matrix products.
- Entries that are infeasible for every input, e.g. a line that would start before break point 0, or the `infeasible` entries of rows 1 to W − 1, are absent in builder code, and products skip them. A block of B < W break points has B dense rows, and W − B rows that each copy one cost to the next place, so two leaves combine with W minimums of 2 sums, and only blocks of 2W or more break points have W³ sums.
- Builder code tracks an upper bound of every entry, e.g. `cost[to]` is at most to × 3,969, and clamps at `infeasible` only where the bound can pass it.

After the network, one more tournament per break point, over `s[to - 1]` and the same line costs, gives the pointers, in the same layers for every break point.

**Following the pointers by doubling.** `jumps[level][at]` is the pointer applied 2^level times, for ceil(log2 n) levels, like docs/patterns.md's "Following links one at a time". For every break point `to`, a binary descent from `breakCount = Σ (j + 1) × endsParagraph[j]` finds the smallest break point at or above `to` on the path back to 0, 4 operations per level, and `to` is chosen exactly when that break point is `to`, 3 more operations:

```js
let scan = breakCount
for (let level = levels - 1; level >= 0; level--) if (jumps[level][scan] >= to) scan = jumps[level][scan]
chosen[to] = scan === to
```

The outputs are `totalCost`, `windowOverflowCount`, `chosen` for every break point, and every cost and pointer.

## Correctness checks

`bun test lab/knuth-plass` runs 10 tests in about 1.1 s:

- Hand-written: boxes of 3, 2, 2 and 5 px with 1 px spaces at 6 px, where greedy filling costs 0 + 16 and the reference and both programs find 9 + 1 with breaks 1, 3 and 4, plus single line costs, e.g. a one-box line wider than the column costs 3,969.
- The reference against every set of breaks: 400 random paragraphs of 1 to 11 break points, windows of 2 to 6 boxes, half of them with boxes of 1 to 4 px at widths of 0 to 15 px so that totals tie, e.g. 51 paragraphs have a step with two starts of the smallest total. The total and the breaks equal the brute force's, with the tie rule written as "largest breaks compared from the end".
- pretext's demo: on the demo's 4 paragraphs, with a fake canvas under Bun, `breakPointsOfPrepared` gives the demo's candidates, 127 to 135 each, at the same segments with the same kinds and positions, and hyphenation.ts gives the same soft hyphens.
- pretext's demo where the costs agree. The demo's own `buildDemoFrame`, loaded from node_modules, lays out 60 texts of 4 to 43 letters joined by soft hyphens, at 64 px, where the fake canvas gives whole-pixel widths, at widths of 62 to 113 px. Without spaces, the demo scores every line as ragged, and at these widths every line that fits has at most 63 px of slack, so each demo cost is 10 times this variant's. Its optimal breaks equal the reference's for all 60 texts, 1,139 lines over 1,470 boxes.
- The product tree in plain JavaScript, `leafMatrices` and `statesByProductTree`, gives the reference's costs in every state, over 100 random paragraphs of 1 to 40 break points.
- Both programs at 24 break points and a window of 6 against the reference: 500 random paragraphs of 1 to 24 break points, where 100 have ties, 92 have a box wider than the column, and 50 have lines of more than 6 boxes that fit. Costs, pointers, breaks, the total and `windowOverflowCount` are all equal.
- Edges: programs of 2 break points with a window of 2, 5 with a window of 8, larger than the program, 17 with a window of 2, and 16 with a window of 16, over paragraphs of 1 break point, a full program, and random lengths.
- `timingParagraph(64)` at 300 px, the paragraph the timings use, with windows of 8, 16 and 32.
- Declarations: every index read reads an integer, grids hold, nothing is NaN, and every wire holds a value within its range, declared or inferred, over 60 evaluations of both forms at 20 break points, plus the partial sum check above at 20 and 1,024 break points.
- The demo's 4 paragraphs through the page's program, the chain at 144 break points and a window of 32, at 58 widths from 200 to 600 px, with the fake canvas.

The page, in its own headless Chrome with `?check=1`, rendered every width from 200 to 600 px with the demo's real font measurements, and compared each evaluation with the reference: 0 mismatches over 403 frames of 4 paragraphs, with both forms.

## CPU numbers

Measured on September 17, 2026, on an Apple M5 Max with 18 cores and 36 GiB, macOS 27.0 and Bun 1.4.0. Other agents' and other projects' processes ran throughout, e.g. a `git pack-objects` at 100% of a core during the whole run, a WebKit content process at up to 100%, a headless Chrome helper at about 45%, and another project's `bun` scoring script, and 8.6 of 10.2 GB of swap was in use. The 1-minute load average before and after each timing process was 4.4 to 7.7, and each row below gives its range. None of my other work ran during the timings.

Method:

- `report.ts all` runs one process at a time: for each program variant, one sizes process and then 3 timing processes, and for each reference variant 3 timing processes, with a 16 GB RSS limit and a 900 s time limit, which no process reached. The raw results are `results/cpu-1.jsonl`, and `results/cpu-2.jsonl` has 5 more reference processes at n = 1,024 and W = 32, after one of the first 3 took 50.5 µs where the other two took 75 µs.
- Every variant lays out `timingParagraph(n)` at 300 px: boxes of 34 to 96 px, 5 px spaces, and a soft hyphen at 10% of the breaks, so no line holds more than 8 boxes and `windowOverflowCount` is 0 at every W. That's 17 lines at n = 64, 69 at 256 and 269 at 1,024.
- A timing process builds the program, compiles it with `createTensorEvaluator` for every output, checks every chosen bit and every cost against the reference before and after timing, warms up for 1 s and at least 5 evaluations, then takes 7 samples of at least 300 ms each and keeps their median, and every evaluation checks the total cost. Each call also checks every source cell against its declared range, 3n + 1 cells. µs figures are the median of the processes' medians, and their range.
- The reference is `knuthPlass` in reference.ts, timed the same way, checking the total cost after each call. It computes the same costs, pointers, breaks and `windowOverflowCount`.
- Build ms, compile ms (`compileTensorProgram` for every output) and peak RSS come from the sizes process.

| Form | n | W | Live operations | Layers | Stored weights | Index reads | Build ms | Compile ms | Peak RSS MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chain | 64 | 8 | 5,348 | 404 | 10,234 | 1,925 | 18 | 10 | 67 |
| tree | 64 | 8 | 11,716 | 96 | 30,392 | 1,925 | 32 | 15 | 76 |
| chain | 64 | 16 | 8,272 | 516 | 17,334 | 2,765 | 24 | 14 | 79 |
| tree | 64 | 16 | 20,996 | 110 | 57,472 | 2,765 | 65 | 27 | 134 |
| chain | 64 | 32 | 12,776 | 612 | 28,270 | 4,061 | 31 | 21 | 84 |
| tree | 64 | 32 | 33,914 | 124 | 95,303 | 4,061 | 115 | 44 | 167 |
| chain | 256 | 8 | 24,410 | 1,566 | 45,048 | 9,411 | 51 | 36 | 142 |
| tree | 256 | 8 | 66,070 | 134 | 171,520 | 9,411 | 148 | 85 | 199 |
| chain | 256 | 16 | 38,086 | 2,062 | 78,260 | 13,323 | 69 | 61 | 172 |
| tree | 256 | 16 | 173,750 | 156 | 478,584 | 13,323 | 290 | 197 | 509 |
| chain | 256 | 32 | 64,094 | 2,542 | 141,420 | 20,763 | 108 | 103 | 207 |
| tree | 256 | 32 | 434,796 | 176 | 1,220,398 | 20,763 | 880 | 444 | 1,301 |
| chain | 1,024 | 8 | 108,360 | 6,184 | 191,990 | 43,969 | 166 | 168 | 395 |
| tree | 1,024 | 8 | 302,528 | 172 | 774,408 | 43,969 | 456 | 329 | 628 |
| chain | 1,024 | 16 | 165,044 | 8,216 | 329,650 | 60,169 | 255 | 316 | 556 |
| tree | 1,024 | 16 | 887,328 | 202 | 2,429,072 | 60,169 | 1,252 | 973 | 2,064 |
| chain | 1,024 | 32 | 277,068 | 10,232 | 601,706 | 92,185 | 421 | 607 | 697 |
| tree | 1,024 | 32 | 2,823,382 | 230 | 7,865,190 | 92,185 | 4,218 | 2,996 | 7,410 |

µs per evaluation, or per call for the reference:

| n | W | Chain | Tree | Reference | Chain µs per 1,000 live operations | Tree µs per 1,000 live operations | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 64 | 8 | 54.0 (50.9 to 54.3) | 91.7 (90.8 to 92.4) | 0.98 (0.98 to 1.13) | 10.1 | 7.8 | 5.3 to 6.8 |
| 64 | 16 | 84.0 (80.6 to 84.1) | 165 (164 to 180) | 1.65 (1.43 to 1.93) | 10.2 | 7.9 | 6.1 to 6.9 |
| 64 | 32 | 122 (121 to 127) | 287 (269 to 291) | 2.59 (2.51 to 2.60) | 9.6 | 8.5 | 6.0 to 6.9 |
| 256 | 8 | 251 (242 to 265) | 520 (480 to 537) | 4.43 (3.75 to 4.91) | 10.3 | 7.9 | 6.9 to 7.2 |
| 256 | 16 | 373 (361 to 374) | 1,327 (1,323 to 1,355) | 6.44 (6.35 to 9.80) | 9.8 | 7.6 | 7.1 to 7.5 |
| 256 | 32 | 564 (553 to 715) | 3,322 (3,125 to 3,356) | 15.1 (15.0 to 15.3) | 8.8 | 7.6 | 6.7 to 7.7 |
| 1,024 | 8 | 1,152 (1,135 to 1,218) | 2,408 (2,364 to 2,486) | 19.8 (19.7 to 19.9) | 10.6 | 8.0 | 6.1 to 6.7 |
| 1,024 | 16 | 1,799 (1,797 to 1,818) | 7,100 (7,016 to 7,129) | 39.6 (39.6 to 39.6) | 10.9 | 8.0 | 5.9 to 6.3 |
| 1,024 | 32 | 2,925 (2,838 to 2,944) | 22,445 (22,150 to 22,533) | 74.8 (50.5 to 75.6), 8 processes | 10.6 | 7.9 | 4.4 to 6.3 |

- Every size built. The largest, the tree at n = 1,024 and W = 32, took 4.2 to 4.5 s to build, 3.0 to 4.0 s to compile, and 6.5 to 8.2 GB of RSS over its 4 processes, and would be the first to stop fitting past these sizes.
- On this executor the chain is the cheaper form at every size. The tree has 2.2 times the chain's live operations at n = 64 and W = 8, and 10.2 times at n = 1,024 and W = 32, and takes 1.7 to 7.7 times the chain's µs, while it has 4 to 44 times fewer layers, e.g. 230 against 10,232.
- The tree grows fastest with W, 2.9 to 3.2 times the operations per doubling of W at n = 1,024. Of the network's 2,036 combines at n = 1,024, 1,023 complete a prefix, a matrix times a vector, and only 26 at W = 32 multiply two blocks of at least W break points each, W² entries of W sums. With 2 operations per minimum, those 26 products build about 26 × 32² × 2 × 31 = 1.65 million operations, next to the tree's 2.8 million live operations. The number of such products grows like n / W, e.g. 120 at W = 8 and 57 at W = 16.
- The executor's time follows live operations, 7.6 to 10.9 µs per 1,000. The chain pays more per operation than the tree, 8.8 to 10.9 against 7.6 to 8.5 µs, which fits patterns.md's measurement of about 35 µs per 1,000 layers: at n = 1,024 and W = 32, 10,232 layers would be about 360 µs of the chain's 2,925 µs.
- The plain JavaScript reference takes 37 to 58 times less time than the chain, e.g. 75 µs against 2,925 µs at n = 1,024 and W = 32. It loops over the same W starts per break point, with no cells to check and no layers, and doesn't follow pointers by doubling.

## The page

`bun lab/knuth-plass/demo.html` shows the paragraphs of pretext's justification demo, with the demo's soft hyphens and its font, 15 px Georgia, and a width slider from 200 to 600 px. Left: pretext's `layoutNextLineRange` on the hyphenated text, which fills each line as far as it goes. Right: the program's breaks. Both columns justify every line but the last with CSS. Each column shows its line count, its total cost in this variant, and the widest space a justified line gets. In each frame where the width changed, JavaScript writes each paragraph's cells and evaluates the program once per paragraph. The program holds 144 break points, for paragraphs of 126 to 134, and a window of 32 boxes, which no line of these paragraphs reaches within 200 to 600 px. `?window=16` shows the window message from 327 px.

At 364 px, the demo's starting width, both columns have 41 lines, and the total cost is 12,639 for greedy against 10,058 for the program.

In headless Chrome 153.0.8010.48, at load average 4.5 to 4.8, with `?check=1`, rendering every width from 200 to 600 px and then the starting width again, 403 frames:

| Form | Live operations | Layers | Build ms | Compile ms | From navigation to the first frame, ms | 4 evaluations, ms, median (max) |
| --- | --- | --- | --- | --- | --- | --- |
| chain | 34,530 | 1,422 | 49 | 46 | 176 | 1.6 (4.6) |
| tree | 218,108 | 154 | 272 | 173 | 600 | 9.0 (15.8) |

The evaluation times include writing each paragraph's cells and `createEvaluator`'s checks. Compile ms is `createEvaluator`'s compile, and the time to the first frame also includes a second compile for the page's status line, and up to 100 ms of the check script's polling. pretext's greedy breaks for the 4 paragraphs took 0.1 ms or less, which is below the page's `performance.now()` steps of 0.1 ms. The check script isn't in the repo; it served demo.html with Bun, drove its own headless Chrome with a fresh profile over the DevTools Protocol, called `window.knuthPlassRender(width)` for every width, and read `window.knuthPlassFrames` and `window.knuthPlassMismatches`.

## Export for the GPU step

`export.ts` writes paragraphs from `timingParagraph`, with seeds from `--first-seed`: the leaf matrices `M[1..n]` as float32, `s[0]`, the cells they come from, and the expected costs, pointers and chosen break points, with the conventions in `manifest.json`. The leaves are n × W² float32 values per paragraph, e.g. 4.2 MB at n = 1,024 and W = 32. Before writing, it checks that the leaves through `statesByProductTree` give the reference's costs. A GPU kernel per level would compute `min(infeasible, min over m of A[r][m] + B[m][c])` for every combine of the level, with every entry and every sum of two entries an integer within 0..2^23, which float32 holds exactly.

## What fit well

- Every value is an integer within 2^24, so the tests compare costs, pointers and breaks exactly, and the tree gives the chain's costs bit for bit. One test proves that no sum rounds, from the declared ranges, and another checks on evaluations that every wire stays within its range.
- The table read with +0 below turns "0 for the last line, 0 when it doesn't fit, min(slack, 63)² otherwise" into one operation, and any other integer function of the slack would cost the same.
- Keeping sums as terms in builder code, instead of operations, puts a line cost and a total inside the comparison that reads them, e.g. 6 terms in one ReLU, while `roundAffine` keeps each minimum's result as its own operation, so partial sums stay within about ±2^23.
- Absent entries and static bounds made the tree far smaller than W³ minimums per combine, e.g. at n = 256 and W = 32, 434,796 live operations, where about 2n combines × W³ would be 16.8 million.

## What got awkward

- The demo's justified cost can't be computed exactly, so the program's breaks are optimal for a different cost, and the agreement with pretext's demo only holds on text without spaces at narrow widths. The demo's justified space width is `(slack + spaceCount × spaceWidth) / spaceCount`, a function of the slack and the space count, so a table of whole-number costs indexed by both could replace the squared slack at about 1 read per line, plus a comparison for the demo's rule that a line narrower than 60% of the column stays ragged. That wasn't built or tested.
- The window. A line of W + 1 boxes that fits is never considered, e.g. at 600 px the program's lines of the demo's paragraphs hold up to 28 boxes, so W = 16 gives costlier breaks there, and the page says so. pretext's demo has no window, and prunes once a line doesn't fit, while the tree's matrices grow with W², and its products with W³.
- Break points in cells are whole pixels, rounded from pretext's float64 widths, so the program's and the demo's widths differ by up to 1 px per line.
- The largest capacity is 1,056 break points, from the total cost staying below 2^22. Longer paragraphs need a smaller cap, e.g. min(slack, 44)² for up to 2,166 break points.

## Not done

- The GPU step: a min-plus kernel per level in headless Chrome, timed against the reference and the programs.
- Sklansky's network, and the argmin pointers carried inside the matrix products instead of one more tournament per break point.
- The demo's justified cost, river penalties and hyphen penalty.

# Knuth-Plass line breaking as min-plus matrix products

## Why

Cheng asked: "technically our pretext layout, if there's lots of them, is faster than the regular cpu's, then?" The answer so far is a prediction: one paragraph on the GPU loses, since pretext's `layout()` is cheap float64 arithmetic that stops at the end of the text while a program pays for every line slot, and a GPU round trip has a fixed cost, while many paragraphs in one dispatch should win past some count. [text-walker's many paragraphs on the GPU](../ui-exploration/text-walker/README.md#many-paragraphs-on-the-gpu-september-17-2026) measures that for greedy line breaking. Cheng also pointed at pretext's Knuth-Plass demo, node_modules/@chenglou/pretext/pages/demos/justification-comparison.*: optimal line breaking is a shortest path over break points, so it fits min-plus matrix products combined in a tree, with one batched kernel per level of the tree, like [regex-search's matrix product tree on the GPU](../regex-search/README.md#matrix-product-tree-on-the-gpu-september-17-2026). Cheng approved both experiments: "yes to both".

This folder holds the Knuth-Plass experiment: a plain JavaScript reference, two program forms that give the reference's costs and breaks, their CPU numbers, a page, an export of leaf matrices, and in `gpu/`, the tree on WebGPU, see [The min-plus tree on the GPU](#the-min-plus-tree-on-the-gpu-september-17-2026).

## How to run it

From the repo root:

```sh
bun test lab/knuth-plass                                  # 16 tests in 2 files, about 1 second
bunx tsgo -p lab/knuth-plass                              # type-check
bunx oxlint --type-aware lab/knuth-plass                  # lint
bun lab/knuth-plass/demo.html                             # the page, e.g. ?form=tree&window=16, and ?check=1 compares every evaluation with the reference
bun lab/knuth-plass/report.ts one sizes tree 256 16       # one variant's sizes, see the comment at the top of report.ts
bun lab/knuth-plass/report.ts all --out <file.jsonl>      # every variant in its own process
bun lab/knuth-plass/report.ts tables lab/knuth-plass/results/cpu-1.jsonl lab/knuth-plass/results/cpu-2.jsonl   # the tables below
bun lab/knuth-plass/export.ts <folder> --breaks 1024 --window 16 --count 16   # leaf matrices and expected results
bun lab/knuth-plass/gpu/run.ts --mode check --profile <new folder> --out <file.json>   # the GPU check in its own headless Chrome, see the comment at the top of run.ts
bun lab/knuth-plass/gpu/run.ts --mode main --profile <new folder> --out <file.json>    # GPU timings
bun lab/knuth-plass/gpu/cpu-time.ts all --out <file.jsonl>                             # the CPU timings of the GPU comparison, one process per variant
bun lab/knuth-plass/gpu/summarize.ts --gpu <files> --checks <file> --cpu <files>       # the GPU section's tables
```

| File | What it holds |
| --- | --- |
| `paragraph.ts` | Paragraphs as break points, the constants of the line cost, random paragraphs, and break points from pretext's segments |
| `reference.ts` | The dynamic programming reference, and the same costs as min-plus matrix products in plain JavaScript |
| `program.ts` | The cells, both program forms, writing a paragraph into cells, and reading the output |
| `hyphenation.ts` | Soft hyphens inserted like pretext's demo, from the demo's tables |
| `knuth-plass.test.ts` | Differential tests |
| `report.ts`, `results/` | Sizes and µs, one process per variant, and the raw results |
| `export.ts` | Leaf matrices, cells and expected results |
| `demo.html`, `demo.ts` | The page |
| `gpu/` | The tree on WebGPU, see [What was built](#what-was-built) |

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

- Sklansky's network, and the argmin pointers carried inside the matrix products instead of one more tournament per break point.
- The demo's justified cost, river penalties and hyphen penalty.

## The min-plus tree on the GPU, September 17, 2026

### Why

On the CPU executor, the tree only costs more than the chain, since that executor's time follows live operations whatever the depth. The tree is meant for a GPU: Brent-Kung's network turns n steps into 2 log2 n − 2 levels, and the combines of one level don't read each other's results, so one dispatch can run all of them, for every paragraph of a batch at once. This section runs that network with WebGPU kernels in headless Chrome, compares every readback with `knuthPlass`, and times it against `knuthPlass`, a faster JavaScript loop and the chain program, for one paragraph of up to 4,096 break points and for up to 10,000 paragraphs of 256 break points, to find where the GPU starts taking less time.

### What was built

| File | What it holds |
| --- | --- |
| `gpu/plan.ts` | The network as slots and one list of combines per level, what JavaScript uploads, the kernels' arithmetic in JavaScript, and `knuthPlassTyped`, a JavaScript loop over typed arrays |
| `gpu/kernels.ts` | The WGSL kernels and the host loop |
| `gpu/page.html`, `gpu/page.ts` | The measurement page, with a timing mode and a check mode |
| `gpu/run.ts` | Serves the page, drives its own headless Chrome over the DevTools Protocol, and writes what the page posts |
| `gpu/cpu-time.ts` | CPU timings in Bun, one process per variant |
| `gpu/summarize.ts` | The tables below, from the raw results |
| `gpu/gpu.test.ts` | The plan, and the kernels' arithmetic in JavaScript, against the reference |
| `gpu/results/` | The raw results |

**The numbers on the GPU.** Every entry is a u32, and every product clamps at `noPath` = 2^30, the entry that stands for no path, e.g. a line that would start before break point 0. reference.ts's product tree clamps at `infeasible` = 2^22 in float64 instead. Every sum of two entries is at most 2^31, so u32 arithmetic is exact in any grouping, and there's no question of how the compiler groups float sums. Between any two break points there's a path of one-box lines, at most 3,969 per line, so every entry that has a path stays below 2^30 in paragraphs of up to 270,532 break points, and the GPU gives `knuthPlass`'s costs and pointers exactly, including totals past 2^22, where the programs stop at 1,056 break points. For example, 4,096 boxes that are each wider than the column total 16,257,024, and the GPU gives that total and every pointer. A state's entries for positions before break point 0 hold `noPath`, where `statesByProductTree` holds `infeasible`.

**Slots and levels.** For a paragraph of n break points, matrix slot i holds the leaf M[i + 1], and each matrix product writes a new slot, 247 at n = 256 and 4,083 at n = 4,096. Vector slot i holds the state s[i + 1]. `gpuPlan` runs src/runtime's `brentKungPrefix` with a combine that records which slots it reads and writes, and puts each combine at the level after its inputs' levels. That gives 14 levels at n = 256 and 22 at n = 4,096, of which 7 and 11 have matrix products and the others only products of a matrix with a vector. A combine reads only slots that earlier levels wrote, which a test checks up to 4,096 break points. The paragraphs of a batch share one plan: the matrix buffer holds every paragraph's leaves, then every paragraph's products, and a kernel computes a slot's offset from the paragraph's index.

**One evaluation** is one command buffer with one compute pass:

1. The leaves: row 0 of every M[to], from uploaded line costs or computed from the positions, see the inputs below. Then s[1] = [lineCost(0, 1), 0, noPath, …] for every paragraph.
2. Each level: one dispatch of its matrix products and one of its matrix-vector products, across every paragraph, with one invocation per paragraph × combine × row of the result, in workgroups of 256 invocations, e.g. 8 × 32 at W = 32.
3. The pointers, one invocation per paragraph × break point: for break point `to`, `to - boxes` for the smallest boxes of the smallest `s[to - 1][boxes - 1] + M[to][0][boxes - 1]`, which is `knuthPlass`'s tie rule, and s[n][0], the total cost.

Then JavaScript copies the pointers and totals, (n + 1) u32 values per paragraph, into a readback buffer, maps it, copies them out, and follows the pointers from break point n to get every paragraph's breaks. The matrices and states stay on the GPU.

**Two kernels.**

- `full` computes `min(noPath, min over m of later[r][m] + earlier[m][c])` for every entry, W³ sums per product, like `minPlusProduct` in reference.ts.
- `dense-rows` uses the leaves' structure, like the tree program's absent entries. A block of B break points, with B < W, has B rows that hold costs, and each row r ≥ B holds 0 at column r − B and `noPath` elsewhere, which moves every cost B places down. So the kernel stores and reads only the first min(B, W) rows of a block. In a product, a row r below B_later is `min(later[r][c + B_earlier], min over m < min(B_earlier, W) of later[r][m] + earlier[m][c])`, where the first term only exists while c + B_earlier < W, a row from B_later to B_later + B_earlier − 1 copies the earlier block's row r − B_later, and the other rows aren't written. In a matrix-vector product, a row r ≥ B_later copies the vector's entry r − B_later. A leaf stores only its row 0.

Sums per paragraph, counted from the plan, for the leaves' products, the matrix-vector products and the pointers. `knuthPlass` computes n × W candidates:

| n | W | Full kernel | Dense-rows kernel | Full ÷ dense-rows | `knuthPlass`'s candidates |
| --- | --- | --- | --- | --- | --- |
| 256 | 8 | 144,832 | 32,096 | 4.5 | 2,048 |
| 256 | 16 | 1,081,088 | 101,312 | 10.7 | 4,096 |
| 256 | 32 | 8,363,008 | 306,560 | 27.3 | 8,192 |
| 4,096 | 8 | 2,385,344 | 567,392 | 4.2 | 32,768 |
| 4,096 | 16 | 17,837,824 | 1,957,824 | 9.1 | 65,536 |
| 4,096 | 32 | 138,116,096 | 6,991,232 | 19.8 | 131,072 |

**Inputs.** An evaluation gets its input in one of three ways:

- **Line costs**: JavaScript computes every line cost, P × n × W u32 values, and uploads them. That's `knuthPlass`'s own work without the minimums.
- **Positions**: JavaScript copies every paragraph's `lineStarts` and `lineEnds` into one Int32Array, P × 2n values, and uploads them with P widths, and a kernel computes the line costs on the GPU.
- **Widths**: the positions stay on the GPU from an earlier evaluation, and JavaScript uploads only P widths, e.g. for a width slider.

**CPU variants.**

- `knuthPlass` from reference.ts, the reference in the CPU numbers above, once per paragraph.
- `knuthPlassTyped` in plan.ts: the same W candidates per break point and the same tie rule, over one Int32Array of positions, with the line cost inlined, preallocated arrays, and no `windowOverflowCount`.
- The chain program through `createTensorEvaluator`, writing each paragraph's cells and evaluating once per paragraph.

Every variant gives each paragraph's breaks and total cost, and every timing alternates between 300 and 340 px from one evaluation to the next, so each evaluation has a new input.

### GPU correctness checks

- `bun test lab/knuth-plass` now runs 16 tests in 2 files, about 1.2 s. The 6 in `gpu/gpu.test.ts`:
  - `gpuPlan` for 1 to 70, 255, 256, 1,000, 1,024 and 4,096 break points: every combine reads only leaves and slots that earlier levels wrote, every slot is written once, every state s[1..n] is written, and a power of two n ≥ 4 has 2 log2 n − 2 levels.
  - `runPlanInJavaScript`, the kernels' arithmetic with the GPU's buffer layout, for both kernels against `knuthPlass`: 400 random paragraphs of 1 to 263 break points and windows of 2 to 32, more than 60 of them with ties, and 40 batches of 1 to 9 paragraphs, each at its own width. The total, every pointer, the breaks and every state are equal. Entries that no dispatch writes hold 7, which would change a minimum if the dense-rows kernel read one.
  - 4,096 boxes, each wider than the column, total 16,257,024, past 2^22, and both kernels give that total and every pointer. The timing paragraph at 4,096 break points and W = 32 too, with the dense-rows kernel.
  - The line costs equal row 0 of `export.ts`'s leaves, apart from entries before break point 0, which are `infeasible` there and `noPath` here, and the kernels in JavaScript give `export.ts`'s expected costs and predecessors.
  - `knuthPlassTyped` gives `knuthPlass`'s costs, predecessors and total on 300 random paragraphs, including ties.
- The page's check mode, `run.ts --mode check`, in its own headless Chrome, at W = 2, 5, 8, 16 and 32, both kernels, and 1, 2, 3, 5, 17, 37, 64, 256, 1,024 and 4,096 break points. Each size has 5 batches of 5 paragraphs, 2 from 1,024 break points: small boxes at narrow widths, which give equal totals, random boxes at random widths, the timing boxes at 260 to 359 px, boxes wider than every width, and one batch that mixes all four. Each batch is evaluated with every input, the line costs and the positions at each paragraph's first width, then the widths input at its second width, and the host reads back the pointers and every state. Over 2,200 paragraphs and 1,500 evaluations, 24,823,200 values were compared with `knuthPlass`, with 0 mismatched values and 0 mismatched breaks. 1,178 of the 4,400 pairs of a paragraph and a width have a step with two starts of the smallest total, and 82 have totals past 2^22. Raw results: `gpu/results/gpu-check-1.json`.
- The timing runs compared every readback's total and pointers with `knuthPlass` at its width: 502,812 readbacks over the 3 runs, 21,663,053,481 values, 0 mismatched. They also compared the breaks of the first and last paragraph of each size in its first 4 evaluations, 864 times, with 0 mismatched.

### GPU timings

Measured on September 17, 2026, on an Apple M5 Max with 18 cores, a 32-core GPU and 36 GiB, macOS 27.0, Bun 1.4.0, and headless Chrome through Metal, with timestamp queries. The page is cross-origin isolated, so `performance.now()` reads in steps of 5 µs. The 3 GPU runs ran from 14:00 to 14:27 local time, and the CPU processes between runs 1 and 2. Other processes ran throughout: a `git` process at about 100% of a core during every run, another Chrome's renderer at 30% to 102%, and before run 2, a Google updater at 99% and a `bun` process at 97%, which may have been run 2's own driver starting. Chrome was updated from 153.0.8010.48 to 153.0.8010.50 between runs 2 and 3, so run 3 ran the new version. The 1-minute load average was 3.7 to 5.9 before and after each GPU run, and 4.4 to 6.2 before and after each CPU process. Of my own work, only scripts that took less than a second ran during run 1 and during the CPU processes, and nothing during runs 2 and 3.

Method:

- GPU: `run.ts --mode main`, 3 runs, each in a new Chrome process with a new shader salt, so every shader compiles cold. For each size, kernel and input: at least 500 ms and 3 evaluations of warmup, then at least 15 samples and 2 s, at most 300 samples, keeping the median. The compute pass from timestamp queries comes from separate samples, at least 7 and 600 ms. The tables show the median of the 3 runs' medians, and their range. Raw results: `gpu/results/gpu-main-1.json` to `gpu-main-3.json`.
- Every GPU figure includes JavaScript's work before the upload (writing the line costs, or copying the positions), the upload, the compute pass, `mapAsync`, copying the readback out, and following every paragraph's pointers.
- CPU in Bun: `cpu-time.ts all`, 3 processes per variant and size, each with 1 s and at least 5 runs of warmup, then 7 samples of at least 300 ms each, keeping their median. Every process checks its breaks and totals against `knuthPlass` before timing, and every run checks each paragraph's total, and the chain's processes check every chosen bit and cost again after timing. Raw results: `gpu/results/cpu-1.jsonl`.
- CPU in the page: `knuthPlass` and `knuthPlassTyped` over the same paragraphs, once per size in each run, 300 ms of warmup and 7 samples of at least 100 ms each.
- The chain was timed up to 1,024 break points and 1,000 paragraphs. At 4,096 break points it doesn't build: `breakCapacity must be within 2..1056`, the capacity that keeps the program's FP32 sums exact. The crossover tables extrapolate the chain linearly past 1,024 break points and 1,000 paragraphs.
- Batches stop where the matrices would need more than 2.2 GB: at 10,000 paragraphs they need 1,288 MB at W = 8, 5,151 MB at W = 16 and 20,603 MB at W = 32, and at 3,000 paragraphs and W = 32, 6,181 MB.

`bun lab/knuth-plass/gpu/summarize.ts --gpu lab/knuth-plass/gpu/results/gpu-main-1.json,lab/knuth-plass/gpu/results/gpu-main-2.json,lab/knuth-plass/gpu/results/gpu-main-3.json --checks lab/knuth-plass/gpu/results/gpu-check-1.json --cpu lab/knuth-plass/gpu/results/cpu-1.jsonl` prints these tables and more, e.g. every input of both kernels.

One paragraph, the GPU in ms and the CPU in µs:

| n | W | GPU, full kernel, positions, ms | GPU, dense-rows, line costs, ms | GPU, dense-rows, positions, ms | GPU, dense-rows, widths, ms | `knuthPlass` in Bun, µs | `knuthPlassTyped` in Bun, µs | Chain in Bun, µs | `knuthPlass` in the page, µs | `knuthPlassTyped` in the page, µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 64 | 8 | 0.38 (0.28 to 0.41) | 0.37 (0.36 to 0.39) | 0.36 (0.27 to 0.40) | 0.31 (0.25 to 0.36) | 1.02 (0.99 to 1.12) | 0.49 (0.49 to 0.55) | 60.4 (58.5 to 62.5) | 0.85 (0.83 to 1.03) | 0.67 (0.62 to 0.70) |
| 256 | 8 | 0.46 (0.33 to 0.47) | 0.43 (0.31 to 0.44) | 0.43 (0.43 to 0.45) | 0.43 (0.30 to 0.43) | 4.11 (3.83 to 4.47) | 2.10 (2.02 to 2.25) | 261 (260 to 266) | 3.58 (3.56 to 5.28) | 2.90 (2.73 to 4.00) |
| 1,024 | 8 | 0.37 (0.36 to 0.38) | 0.54 (0.38 to 0.55) | 0.36 (0.35 to 0.53) | 0.36 (0.28 to 0.52) | 20.4 (20.0 to 22.2) | 8.59 (8.46 to 8.88) | 1,357 (1,350 to 1,406) | 15.1 (15.0 to 16.8) | 12.1 (11.4 to 14.3) |
| 4,096 | 8 | 0.55 (0.44 to 0.66) | 0.51 (0.48 to 0.69) | 0.62 (0.41 to 0.62) | 0.55 (0.50 to 0.61) | 82.3 (82.1 to 83.6) | 38.4 (37.5 to 39.2) | doesn't build | 66.4 (63.0 to 75.1) | 53.9 (53.7 to 61.0) |
| 64 | 16 | 0.46 (0.32 to 0.49) | 0.40 (0.39 to 0.41) | 0.40 (0.30 to 0.40) | 0.39 (0.30 to 0.40) | 1.54 (1.47 to 1.56) | 0.84 (0.84 to 0.90) | 88.9 (86.6 to 89.4) | 1.43 (1.37 to 1.45) | 1.21 (1.15 to 1.24) |
| 256 | 16 | 0.62 (0.60 to 0.63) | 0.50 (0.50 to 0.51) | 0.41 (0.29 to 0.49) | 0.49 (0.34 to 0.49) | 6.83 (6.36 to 9.61) | 4.59 (4.34 to 4.63) | 383 (377 to 386) | 6.60 (6.39 to 6.78) | 5.45 (5.26 to 5.77) |
| 1,024 | 16 | 0.45 (0.45 to 0.64) | 0.50 (0.42 to 0.65) | 0.52 (0.39 to 0.63) | 0.50 (0.39 to 0.60) | 40.6 (39.0 to 42.4) | 19.2 (19.1 to 19.4) | 2,138 (2,102 to 2,148) | 27.5 (27.3 to 30.6) | 22.9 (22.8 to 25.3) |
| 4,096 | 16 | 0.76 (0.56 to 0.80) | 0.92 (0.61 to 0.93) | 0.63 (0.46 to 0.74) | 0.53 (0.45 to 0.58) | 162 (161 to 169) | 81.1 (75.8 to 81.2) | doesn't build | 115 (115 to 134) | 95.5 (95.1 to 108.8) |
| 64 | 32 | 0.63 (0.42 to 0.65) | 0.44 (0.43 to 0.44) | 0.44 (0.30 to 0.45) | 0.44 (0.30 to 0.44) | 2.50 (2.46 to 2.51) | 1.56 (1.55 to 1.72) | 130 (129 to 132) | 2.13 (2.11 to 2.16) | 1.89 (1.89 to 1.95) |
| 256 | 32 | 0.57 (0.54 to 0.71) | 0.42 (0.42 to 0.64) | 0.39 (0.38 to 0.50) | 0.39 (0.38 to 0.64) | 15.6 (12.6 to 15.9) | 8.24 (8.22 to 8.27) | 610 (602 to 624) | 11.1 (11.0 to 16.2) | 10.2 (10.0 to 12.4) |
| 1,024 | 32 | 0.68 (0.66 to 0.77) | 0.87 (0.58 to 0.88) | 0.47 (0.46 to 0.81) | 0.62 (0.54 to 0.80) | 69.9 (67.1 to 70.4) | 37.7 (36.7 to 41.0) | 3,441 (3,389 to 3,620) | 49.1 (49.0 to 54.0) | 44.1 (43.1 to 45.7) |
| 4,096 | 32 | 0.69 (0.67 to 0.71) | 1.33 (1.08 to 1.58) | 0.51 (0.42 to 0.66) | 0.64 (0.62 to 0.78) | 303 (273 to 321) | 157 (148 to 174) | doesn't build | 196 (193 to 211) | 174 (171 to 186) |

Many paragraphs of 256 break points, ms per evaluation of every paragraph:

| W | P | GPU, full kernel, positions | GPU, dense-rows, line costs | GPU, dense-rows, positions | GPU, dense-rows, widths | `knuthPlass` in Bun | `knuthPlassTyped` in Bun | Chain in Bun | `knuthPlass` in the page | `knuthPlassTyped` in the page |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 1 | 0.46 (0.33 to 0.47) | 0.43 (0.31 to 0.44) | 0.43 (0.43 to 0.45) | 0.43 (0.30 to 0.43) | 0.004 (0.004 to 0.004) | 0.002 (0.002 to 0.002) | 0.26 (0.26 to 0.27) | 0.004 (0.004 to 0.005) | 0.003 (0.003 to 0.004) |
| 8 | 10 | 0.54 (0.38 to 0.56) | 0.54 (0.54 to 0.60) | 0.49 (0.37 to 0.53) | 0.48 (0.33 to 0.49) | 0.049 (0.049 to 0.051) | 0.025 (0.023 to 0.026) | 2.67 (2.64 to 2.73) | 0.038 (0.038 to 0.044) | 0.033 (0.031 to 0.035) |
| 8 | 100 | 0.93 (0.60 to 0.96) | 1.17 (1.08 to 1.23) | 0.50 (0.48 to 0.73) | 0.40 (0.36 to 0.63) | 0.60 (0.59 to 0.62) | 0.34 (0.33 to 0.37) | 26.9 (26.4 to 27.5) | 0.48 (0.46 to 0.52) | 0.40 (0.39 to 0.42) |
| 8 | 1,000 | 2.95 (2.77 to 3.43) | 9.81 (7.31 to 11.27) | 2.28 (2.15 to 2.55) | 1.36 (1.24 to 1.49) | 6.06 (5.75 to 6.10) | 3.73 (3.55 to 3.79) | 260 (257 to 267) | 5.46 (4.97 to 5.98) | 4.30 (4.08 to 4.70) |
| 8 | 3,000 | 8.97 (7.66 to 9.37) | 27.1 (19.8 to 28.0) | 6.68 (5.46 to 7.00) | 3.46 (3.32 to 3.49) | 16.8 (16.6 to 17.1) | 10.6 (10.4 to 11.1) | not timed | 25.4 (25.0 to 28.2) | 20.0 (15.8 to 20.0) |
| 8 | 10,000 | 26.7 (25.7 to 27.8) | 85.4 (60.0 to 88.4) | 15.4 (14.4 to 16.5) | 10.6 (10.1 to 10.6) | 51.4 (50.9 to 51.7) | 36.9 (36.5 to 37.3) | not timed | 86.2 (76.6 to 108.7) | 55.1 (45.8 to 59.7) |
| 16 | 1 | 0.62 (0.60 to 0.63) | 0.50 (0.50 to 0.51) | 0.41 (0.29 to 0.49) | 0.49 (0.34 to 0.49) | 0.007 (0.006 to 0.010) | 0.005 (0.004 to 0.005) | 0.38 (0.38 to 0.39) | 0.007 (0.006 to 0.007) | 0.005 (0.005 to 0.006) |
| 16 | 10 | 0.58 (0.47 to 0.61) | 0.66 (0.66 to 0.67) | 0.56 (0.37 to 0.56) | 0.55 (0.55 to 0.57) | 0.11 (0.08 to 0.12) | 0.054 (0.053 to 0.054) | 3.89 (3.87 to 3.89) | 0.073 (0.071 to 0.073) | 0.058 (0.058 to 0.064) |
| 16 | 100 | 1.20 (0.78 to 1.26) | 1.80 (1.53 to 1.87) | 0.87 (0.87 to 0.90) | 0.69 (0.48 to 0.77) | 0.83 (0.80 to 1.14) | 0.58 (0.56 to 0.61) | 38.9 (38.6 to 39.2) | 0.72 (0.71 to 0.77) | 0.61 (0.60 to 0.62) |
| 16 | 1,000 | 6.40 (6.33 to 9.50) | 15.5 (11.9 to 16.1) | 2.83 (2.39 to 3.02) | 1.76 (1.69 to 1.97) | 11.1 (8.5 to 11.3) | 5.57 (5.38 to 5.57) | 394 (353 to 412) | 8.71 (7.48 to 9.62) | 6.61 (6.45 to 7.13) |
| 16 | 3,000 | 33.4 (32.5 to 33.8) | 38.1 (33.2 to 43.4) | 6.25 (6.24 to 6.59) | 5.61 (5.31 to 5.92) | 32.8 (32.3 to 33.0) | 17.3 (17.3 to 18.9) | not timed | 32.8 (32.5 to 35.5) | 20.3 (18.8 to 22.1) |
| 32 | 1 | 0.57 (0.54 to 0.71) | 0.42 (0.42 to 0.64) | 0.39 (0.38 to 0.50) | 0.39 (0.38 to 0.64) | 0.016 (0.013 to 0.016) | 0.008 (0.008 to 0.008) | 0.61 (0.60 to 0.62) | 0.011 (0.011 to 0.016) | 0.010 (0.010 to 0.012) |
| 32 | 10 | 0.75 (0.64 to 0.77) | 0.88 (0.62 to 0.88) | 0.68 (0.43 to 0.76) | 0.65 (0.32 to 0.69) | 0.18 (0.18 to 0.22) | 0.10 (0.10 to 0.10) | 6.24 (6.20 to 6.79) | 0.13 (0.12 to 0.13) | 0.11 (0.10 to 0.11) |
| 32 | 100 | 3.43 (2.70 to 3.80) | 4.61 (3.70 to 4.62) | 0.90 (0.59 to 0.92) | 0.61 (0.59 to 0.82) | 1.90 (1.89 to 1.98) | 1.01 (1.00 to 1.01) | 61.9 (61.4 to 62.4) | 1.18 (1.17 to 1.38) | 1.08 (1.06 to 1.11) |
| 32 | 1,000 | 42.3 (40.5 to 42.9) | 23.4 (18.5 to 30.3) | 4.50 (3.97 to 4.72) | 4.81 (4.37 to 5.75) | 18.2 (18.0 to 18.6) | 10.4 (10.2 to 10.7) | 594 (577 to 820) | 22.5 (17.6 to 25.4) | 15.5 (11.4 to 17.8) |

Where the time goes, ms. The total leaves out JavaScript's work before the upload, and the compute pass comes from separate samples with timestamp queries:

| n | W | P | Kernel | Input | JavaScript before the upload | `writeBuffer` | From submit to `mapAsync` resolving | Copying the readback out | Following the pointers | Total | Compute pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4,096 | 32 | 1 | dense-rows | positions | 0.005 | 0.010 | 0.48 (0.40 to 0.64) | 0.005 | 0.005 (0.000 to 0.005) | 0.51 (0.41 to 0.66) | 0.20 (0.17 to 0.75) |
| 256 | 8 | 1,000 | dense-rows | positions | 0.39 (0.39 to 0.41) | 0.50 (0.49 to 0.51) | 1.12 (1.00 to 1.35) | 0.095 | 0.16 | 1.89 (1.76 to 2.14) | 1.38 (0.93 to 1.39) |
| 256 | 8 | 1,000 | dense-rows | widths | 0.000 | 0.005 | 1.08 (0.96 to 1.22) | 0.090 | 0.17 | 1.36 (1.24 to 1.49) | 0.95 (0.67 to 1.38) |
| 256 | 8 | 10,000 | dense-rows | line costs | 59.6 (39.2 to 62.4) | 1.70 (1.25 to 1.80) | 20.1 (16.1 to 20.7) | 1.07 (0.76 to 1.11) | 1.84 (1.28 to 1.86) | 24.8 (19.5 to 25.1) | 8.29 (7.52 to 8.38) |
| 256 | 8 | 10,000 | dense-rows | positions | 4.02 (2.60 to 4.66) | 0.35 (0.32 to 0.36) | 9.10 (9.09 to 9.15) | 0.86 (0.74 to 0.88) | 1.40 (1.21 to 1.44) | 11.8 (11.4 to 11.9) | 6.46 (6.30 to 6.59) |
| 256 | 8 | 10,000 | dense-rows | widths | 0.000 | 0.020 | 7.39 (7.39 to 7.52) | 1.09 (0.98 to 1.16) | 1.86 (1.52 to 1.99) | 10.6 (10.1 to 10.6) | 7.63 (6.87 to 8.18) |
| 256 | 16 | 3,000 | dense-rows | positions | 0.67 (0.66 to 0.68) | 0.095 | 4.86 (4.82 to 5.17) | 0.25 | 0.36 | 5.60 (5.56 to 5.86) | 4.39 (3.87 to 4.63) |
| 256 | 32 | 1,000 | dense-rows | positions | 0.28 (0.24 to 0.31) | 0.67 (0.56 to 0.69) | 3.22 (2.89 to 3.40) | 0.13 (0.11 to 0.13) | 0.16 (0.13 to 0.17) | 4.22 (3.73 to 4.41) | 2.66 (2.43 to 3.56) |
| 256 | 32 | 1,000 | full | positions | 0.38 | 0.84 | 40.7 (38.6 to 41.3) | 0.16 | 0.21 | 42.0 (40.1 to 42.5) | 34.3 (34.2 to 40.2) |

One compute pass per stage at 1,000 paragraphs of 256 break points, with the positions input, ms, 5 samples per run. The 7 levels with matrix products are the upward pass, and the other 7 have only matrix-vector products:

| W | Kernel | Leaves and s[1] | 7 levels with matrix products | 7 levels with only matrix-vector products | Pointers | Sum of the passes | One pass for everything |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | full | 0.21 (0.20 to 0.23) | 1.15 (1.14 to 1.32) | 0.25 (0.25 to 0.26) | 0.070 (0.068 to 0.073) | 1.70 (1.66 to 1.97) | 1.53 (1.23 to 2.76) |
| 8 | dense-rows | 0.075 (0.048 to 0.099) | 0.65 (0.44 to 0.89) | 0.22 (0.15 to 0.31) | 0.079 (0.069 to 0.138) | 1.03 (0.71 to 1.45) | 1.38 (0.93 to 1.39) |
| 16 | full | 1.25 (1.03 to 1.31) | 12.1 (5.5 to 20.9) | 1.27 (0.65 to 1.35) | 0.14 (0.09 to 0.18) | 16.4 (7.7 to 29.4) | 5.00 (4.96 to 9.78) |
| 16 | dense-rows | 0.082 (0.071 to 0.086) | 1.08 (1.04 to 1.21) | 0.26 (0.25 to 0.32) | 0.10 (0.10 to 0.11) | 1.59 (1.47 to 1.69) | 1.14 (1.01 to 1.26) |
| 32 | full | 4.21 (4.16 to 4.69) | 29.9 (28.6 to 43.3) | 2.73 (2.72 to 3.54) | 0.21 (0.21 to 0.25) | 36.8 (36.8 to 51.4) | 34.3 (34.2 to 40.2) |
| 32 | dense-rows | 0.24 (0.18 to 0.34) | 2.59 (2.19 to 3.48) | 0.55 (0.47 to 0.59) | 0.21 (0.21 to 0.22) | 3.63 (3.07 to 4.60) | 2.66 (2.43 to 3.56) |

- One paragraph costs a fixed round trip: from 64 to 4,096 break points, the dense-rows kernel with positions takes 0.36 to 0.63 ms, almost all of it from submit to `mapAsync` resolving, while its compute pass takes 0.2 ms at 4,096 break points and W = 32.
- The full kernel's products are most of its time from W = 16, and the dense-rows kernel makes them 11.5 times shorter at W = 32 and 1,000 paragraphs, 2.59 against 29.9 ms, where the plan counts 27.3 times fewer sums.
- With line costs uploaded, JavaScript's work is the largest part: 59.6 ms of 85.4 ms at 10,000 paragraphs and W = 8, where `knuthPlass` itself takes 51.4 ms in Bun.
- Copying the readback out and following the pointers take 0.3 ms at 1,000 paragraphs, and 2.3 to 3.0 ms at 10,000 paragraphs, whose readback is 10 MB and whose compute pass takes 6.5 to 8.3 ms.
- Compile ms, from `createShaderModule` to `createComputePipelineAsync` resolving, medians of the 3 runs: the matrix product kernel 27 to 68 ms for the full kernel and 10 to 17 ms for dense-rows, where the first compile in a Chrome process, the full kernel at W = 8, includes one-time setup, and 5 to 10 ms for each other kernel.
- The first evaluation after preparing the buffers takes 0.4 to 3.7 ms for one paragraph, and 27 to 104 ms at 1,000 paragraphs and W = 16 and 32, whose matrices are 515 and 2,060 MB.

### The GPU crossover

The first measured count from which the GPU takes less time than a CPU variant, at that count and every larger measured count, from the medians of the 3 runs. "About" interpolates linearly between that count and the measured count below it. The paragraph counts measured are 1, 10, 100, 1,000, 3,000 and 10,000, so the "about" figures are rough.

Paragraphs of 256 break points:

| W | GPU | `knuthPlass` in Bun | `knuthPlassTyped` in Bun | Chain in Bun | `knuthPlass` in the page | `knuthPlassTyped` in the page |
| --- | --- | --- | --- | --- | --- | --- |
| 8 | full kernel, positions | from 1,000, about 187 | from 1,000, about 488 | from 10, about 1.8 | from 1,000, about 236 | from 1,000, about 353 |
| 8 | dense-rows, line costs | slower up to 10,000 | slower up to 10,000 | from 10, about 1.7 | from 10,000, about 7,897 | slower up to 10,000 |
| 8 | dense-rows, positions | from 100, about 83 | from 1,000, about 188 | from 10, about 1.6 | from 1,000, about 104 | from 1,000, about 140 |
| 8 | dense-rows, widths | from 100, about 72 | from 1,000, about 123 | from 10, about 1.6 | from 100, about 86 | from 1,000, about 100 |
| 16 | full kernel, positions | slower up to 3,000 | slower up to 3,000 | from 10, about 1.6 | slower up to 3,000 | slower up to 3,000 |
| 16 | dense-rows, line costs | slower up to 3,000 | slower up to 3,000 | from 10, about 1.3 | slower up to 3,000 | slower up to 3,000 |
| 16 | dense-rows, positions | from 1,000, about 105 | from 1,000, about 185 | from 10, about 1.1 | from 1,000, about 122 | from 1,000, about 157 |
| 16 | dense-rows, widths | from 100, about 79 | from 1,000, about 124 | from 10, about 1.3 | from 100, about 95 | from 1,000, about 114 |
| 32 | full kernel, positions | slower up to 1,000 | slower up to 1,000 | faster from 1 | slower up to 1,000 | slower up to 1,000 |
| 32 | dense-rows, line costs | slower up to 1,000 | slower up to 1,000 | faster from 1 | slower up to 1,000 | slower up to 1,000 |
| 32 | dense-rows, positions | from 100, about 40 | from 100, about 86 | faster from 1 | from 100, about 70 | from 100, about 78 |
| 32 | dense-rows, widths | from 100, about 34 | from 100, about 62 | faster from 1 | from 100, about 53 | from 100, about 58 |

- Each run on its own gives the same measured count for the dense-rows kernel with positions against `knuthPlassTyped` in Bun at every W. Against `knuthPlass` in Bun, one run crosses from 1,000 instead of 100 at W = 8. With the widths input, single runs move by one measured count, e.g. at W = 8 against `knuthPlass` in Bun, from 1,000 in run 1 and from 100 in runs 2 and 3. `summarize.ts` prints every run's crossover.
- At the largest batches, the dense-rows kernel with positions takes 2.4 times less time than `knuthPlassTyped` in Bun at 10,000 paragraphs and W = 8, 15.4 against 36.9 ms, 2.8 times at 3,000 paragraphs and W = 16, 6.25 against 17.3 ms, and 2.3 times at 1,000 paragraphs and W = 32, 4.50 against 10.4 ms. Against `knuthPlass` in Bun, 3.3, 5.2 and 4.0 times. With only the widths uploaded, 3.5 times less than `knuthPlassTyped` at 10,000 paragraphs and W = 8, 10.6 against 36.9 ms.
- The chain program takes 132 times as long as the dense-rows kernel with positions at 1,000 paragraphs and W = 32, 594 against 4.50 ms.

One paragraph: the GPU takes longer than `knuthPlass` and `knuthPlassTyped`, in Bun and in the page, at every measured size up to 4,096 break points, with both kernels and every input. The closest is 0.51 ms against 303 µs for `knuthPlass` in Bun, at 4,096 break points and W = 32. The GPU takes less time than the chain from 256 break points at W = 32, about 174 to 242 depending on the kernel and input, and from 1,024 at W = 8 and 16, about 266 to 387, e.g. 0.47 against 3,441 µs at 1,024 break points and W = 32. As arithmetic rather than a measurement: at W = 32, `knuthPlass` in Bun takes about 74 µs per 1,000 break points and `knuthPlassTyped` about 38 µs, so if one GPU evaluation stayed near 0.5 ms, they would take as long from about 7,000 and 13,000 break points.

### What this says about Cheng's question

- For many paragraphs, yes. With the dense-rows kernel and the paragraphs' positions on the GPU, the tree takes less time than plain JavaScript from about 40 to 190 paragraphs of 256 break points, depending on W and on which loop, and 2.3 to 5.2 times less at the largest measured batches. When only the widths change, it crosses a little earlier, from about 34 to 124 paragraphs.
- For one paragraph, no. With the dense-rows kernel and positions or widths, one evaluation takes 0.3 to 0.6 ms, most of it the round trip, while `knuthPlass` lays out a paragraph of 4,096 break points in 0.3 ms at W = 32. What one paragraph gains is depth, e.g. 18 levels at 1,024 break points, where the chain program has 6,184 to 10,232 layers, and there the GPU takes less time than the chain program.
- The tree does fit one batched kernel per level, but a kernel over every entry isn't enough. The full kernel pays W³ sums per product, and doesn't cross over at W = 16 and 32, e.g. 33.4 ms against 17.3 to 32.8 ms for the JavaScript loops at 3,000 paragraphs and W = 16, and 42.3 against 10.4 to 22.5 ms at 1,000 paragraphs and W = 32. Skipping the rows that only move costs, like the tree program's absent entries, makes the products 11.5 times shorter at W = 32, and from about 40 to 86 paragraphs there, the GPU takes less time than the JavaScript loops in Bun.
- What JavaScript sends matters, as in regex-search and text-walker. Computing the line costs in JavaScript and uploading them never beats `knuthPlassTyped`, since that's most of the loop's own work. The positions, 2n integers per paragraph, with the line costs computed on the GPU, do.
- The GPU's arithmetic is exact in u32, so the GPU gives the reference's totals and pointers for paragraphs of up to 270,532 break points, where the program's FP32 sums stop at 1,056.

### GPU not done

- The page: `demo.html` runs the programs on the CPU, and has no GPU mode.
- Batches of paragraphs with different break counts. A batch shares one plan, so every paragraph has the same n. Padding like the programs' cells, where every line past the paragraph doesn't fit, would allow shorter paragraphs, and wasn't tried.
- Memory. Every matrix product keeps its own slot of W² entries, so the matrices take P × (n + products) × W² × 4 bytes, e.g. 2,060 MB for 1,000 paragraphs of 256 break points at W = 32. Storing only min(B, W) rows per slot, or reusing slots once they're read, wasn't tried, and batches above 2.2 GB weren't measured.
- Only one workgroup shape per W, 256 invocations with y = W, and no sweep. Only Brent-Kung's network.
- The readback holds every pointer, n + 1 u32 values per paragraph. Following the pointers by doubling on the GPU, and reading back only the breaks, wasn't tried.
- `windowOverflowCount` isn't computed on the GPU.
- No timing relative to `requestAnimationFrame`, and only one paragraph count of 256 break points for batches.
- Single paragraphs past 4,096 break points, where the arithmetic above predicts a crossover against plain JavaScript.
- Only Apple's GPU through Metal in headless Chrome 153, with another Chrome and other processes running.

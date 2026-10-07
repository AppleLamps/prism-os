# A tested numeric library for UI circuits

This folder adds the missing operations from phase one to the macro library: exact comparisons with a cost chosen from declared ranges, exact minimum and maximum, round and floor, reciprocal, division, square root, sine and cosine, exp, smoothstep, remap, mix, and a float hash. Each operation has a written contract below, and dense tests check it against native JavaScript. The folder also holds a small shader-style workload: a magnifying dock and a spinning progress ring.

`numeric-ui-core.ts` is unchanged. Everything imports it with a relative path.

Update, September 14, 2026: the repo root `numeric-ui-core.ts` (moved into src/runtime/ on September 17, 2026) now has its own `emitCompare`, which builds integer bits when both operands are declared on a grid, and a sign cascade otherwise, e.g. `a >= b` within 0..16,384 in 15 operations and 14 layers ([execution-model.md](../../../docs/execution-model.md#comparisons)). This folder's library doesn't read grids, and its reciprocal, division, square root, trigonometry, rounding and hash aren't in the root runtime ([expressions.md](../../../docs/expressions.md#familiar-expressions)).

Update, September 15, 2026: window-manager.ts now declares pointer coordinates within ±32,768 px on a 1/64 px grid, and its window hit tests compare each edge distance with `emitCompare`. What this README says about HandwiredOS describes this folder's copies of the older window-manager.ts and photo-gallery.ts.

Update, September 16, 2026: those copies, with their minimum and maximum modes and float64 references, were removed, since the exact minimum, maximum and clamp are in the root runtime (`emitMinimumExact`, `emitMaximumExact`, `emitClampExact`). They stay at the [exploration-2026-09 tag](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/numeric-library), and [HandwiredOS with exact minimum and maximum](#handwiredos-with-exact-minimum-and-maximum) stays as a record of what they measured.

## How to run it

From the repo root:

- `bun test lab/ui-exploration/numeric-library` runs 20 tests in about 1 to 3 seconds. That covers library sweeps with asserted bounds and the workload against float64.
- `bunx tsgo -p lab/ui-exploration/numeric-library` typechecks.
- `bun lab/ui-exploration/numeric-library/report.ts [section...]` runs the heavy measurements and merges them into `report-output.json`. The sections are `macros` (about 27 s), `plans`, `minimum`, `rectangle-hit`, and `workload`. All numbers in this README come from that file, except the HandwiredOS modes, which come from the file's `indirect-os` section at the exploration-2026-09 tag. Timings are rough, because other agents share the machine.
- `bun lab/ui-exploration/numeric-library/demo.html` serves the workload as a page: the dock magnifies around the pointer, and the ring spins and fills.

## What was built

| File | What it holds |
| --- | --- |
| `comparison.ts` | `planCompare`, `emitCompare`, `emitSignBit`, `emitSelectBit`, `emitMinimumExact`, `emitMaximumExact`, `emitClampExact`, `emitMinimumOf` (the minimum of k values by counting) |
| `rounding.ts` | `emitRound`, `emitFloorOnGrid`, `emitFloor`, `emitCeil`, `emitFract`, `emitFloorDivide`, `emitIntegerOneHot` |
| `arithmetic.ts` | `emitReciprocal`, `emitDivide`, `emitSqrt`, and their step planners |
| `trigonometry.ts` | `emitSinCos`, `emitSin`, `emitCos` |
| `shaping.ts` | `emitMix`, `emitRemap`, `emitRemapRuntime`, `emitSmoothstep`, `emitSmoothstepRuntime`, `emitExp`, `emitHash`, `hashReference` |
| `library.ts` | re-exports all of the above |
| `library.test.ts` | dense and boundary sampling for every macro, asserting the bounds in the contract table |
| `window-manager-copy.ts`, `photo-gallery-copy.ts`, `min-max-mode.ts`, `indirect-os-agreement.ts`, `window-manager-copy.test.ts` | removed on September 16, 2026, and kept at the [exploration-2026-09 tag](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/numeric-library): copies of HandwiredOS whose `emitMinimum` and `emitMaximum` calls went through five modes, float64 references for the settled layout and for presses near edges, and `window-manager.test.ts` pointed at the copy |
| `workload.ts`, `workload.test.ts`, `demo.html`, `demo.ts` | the dock and progress ring circuit, `emitPercentOfUnit`, the float64 reference, and the page |
| `report.ts`, `report-output.json`, `measure.ts` | measurement script, its output, shared helpers (seeded random values, FP32 stepping, `ceilFloat32`, chi-square p-values) |

### How an exact comparison works

A comparison first keeps `d = fround(a - b)` as its own rounding point. For finite FP32 operands, `d` is zero exactly when `a === b`, and otherwise it has the sign of `a - b`, because FP32 subtraction of distinct values never rounds to zero. Every comparison is therefore a sign test on `d`, and the sign test runs in stages:

- The final stage feeds `clamp01(0.5 + s * d)` to the boolean atom. For any FP32 score in 0..1, the boolean atom returns exactly `[score >= 0.5]` (a score of exactly 0.5 goes to 1). The scale `s` is a power of two, so `s * d` is exact. The stage resolves every `|d| >= 2^-23 / s`, and its clamp plateau stays exact while `s * |d| <= 2^22`. One final stage therefore covers a ratio of 2^45 between the largest difference and the smallest difference it must resolve. For example, pixel operands in [0, 16384] resolve every pair that differs by at least 2^-30 px, in 4 operations and 3 layers. A strict `>` lowers the 0.5 bias by one FP32 step, so `d = 0` lands below 0.5.
- A clamp stage `u = clamp01(s * d)` runs first when the ratio is wider. `u` is positive exactly when `d` is positive, and each clamp stage widens the covered ratio by 2^23 for 3 more operations and 2 more layers. Resolving every pair of distinct FP32 values within [-2^15, 2^15], subnormals included, takes 6 clamp stages: 22 operations and 15 layers. Phase one's sign cascade took 26 and 26.

`planCompare(bound, resolution)` picks the stage count. `emitCompare` reads the bound from the declared ranges of `a` and `b`. The `resolution` option states the smallest difference that must resolve, e.g. 1 for integers or 1/64 for 26.6 fixed point. The default resolves every pair.

Exact minimum and maximum select an operand with the bit: `on * relu(bit) + off * relu(1 - bit)`, as two ReGLU rows. At an exact bit, the unselected product is `fround(off * 0) = ±0`, so the result is exactly one of the operands. The sum is an ordinary affine, so an affine consumer composes it without changing any value.

## Contracts

`f(x)` means `Math.fround(x)`. Operation, layer, and weight counts are for the macro built alone with the stated ranges (`report.ts macros`). "Measured" is the worst case over that section's samples. That is 1M samples per row, except the maximum (500k), the counting minimum (200k), the hash (every key in [0, 2^20]), and two sine and cosine rows that try every FP32 angle in [3.5, 4] and in [128, 190] (6.2M angles). Most rows mix random values with values a few FP32 steps from where the result switches: equal or adjacent operands, half-integers, octave thresholds, odd multiples of pi/4 plus the domain endpoints, and smoothstep edges. The floor-on-a-grid, mix, and runtime remap rows are random, and the exp rows are random plus both endpoints. `library.test.ts` asserts the bounds with smaller samples for comparisons, exact minimum and maximum, clamp, counting minimum, rounding, floor division, one-hot, reciprocal, division, square root, sine and cosine, exp, smoothstep, runtime remap, mix endpoints, and the hash. The mix interior error is measured, not asserted.

| Macro | Forward calculation | Domain | Exactness or error bound | Cost: operations / layers / weights |
| --- | --- | --- | --- | --- |
| `emitCompare(a, b, relation, {resolution})` | `d = f(a - b)`, clamp stages, final boolean stage | finite declared ranges on `a` and `b`, or `operandMagnitude` as a promise | exact bit whenever `a === b` or `|a - b| >= resolution`. Measured: 0 wrong over 1M pairs in each of three tiers (integers to 2^20; pixels to 2^14 at 2^-30; every FP32 pair) | 4 / 3 / 6 while bound / resolution <= 2^45, then +3 / +2 per 2^23 of ratio; every FP32 pair within 2^15: 22 / 15 / 30 |
| `emitMinimumExact`, `emitMaximumExact` | compare, then `emitSelectBit` | as compare | returns exactly `a` or `b`, ties return `a`. The pick is right whenever `|a - b| >= resolution`; otherwise the returned operand is within the resolution of the true result. The declared result range is `[min(a.min, b.min), min(a.max, b.max)]` for the minimum, plus the resolution when it is not the default | one stage: 7 / 5 / 12; every FP32 pair within 2^15: 25 / 17 / 36. The drifting `emitMinimum` is 3 / 3 / 5 |
| `emitClampExact(x, low, high)` | `min(max(x, low), high)` | as compare | equals `Math.min(Math.max(x, low), high)`, including `low > high` (returns `high`) | two exact selections |
| `emitMinimumOf(values)` | one comparison per pair, `winner_i = relu(count_i - (k - 2))`, declared one-hot, gather read | as compare | exact minimum; the first index wins ties; winners form an exact one-hot | 8 values: 121 / 5 / 224 with 1 gather read |
| `emitRound(x)` | `f(f(x + 2^23 + 2^22) - (2^23 + 2^22))` | `|x| < 2^22` | exact, ties to even (`Math.round` sends ties up) | 2 / 2 / 2 |
| `emitFloorOnGrid(x, gridBits)` | round of `x - 0.5 + 2^-(gridBits + 1)` | `x` a multiple of 2^-gridBits, `|x| < 2^(22 - gridBits)` | exact | 3 / 3 / 3 |
| `emitFloor(x)` | `r = round(x)`, `d = r - x` (exact), `r - [d > 0]` | `|x| < 2^22` | exact for any FP32 value. When the range starts at 0 or above, any positive `d` is at least 2^-24, so one stage suffices. A signed range defaults to resolving every value; with `resolution`, only x in (-resolution, 0) can return 0 instead of -1 | x >= 0: 7 / 6 / 10; signed: 22 / 16 / 30 |
| `emitCeil`, `emitFract` | `-floor(-x)`; `f(x - floor(x))` | as floor | ceil exact; fract in 0..1, exact for x >= 0; a tiny negative x returns `f(1 - |x|)`, which can be 1 | floor plus 1 |
| `emitFloorDivide(n, divisor)` | `q = round(f(f(1 / divisor) * n))`, then `q - [n - divisor * q < 0]`, where the remainder is an exact integer | integer `n` with a declared range within [0, 2^21]; a positive integer divisor fixed while building, at most 2^21 | exact. Unlike `emitDivide`, whose divisor is a wire that gets a Newton reciprocal, the divisor is a constant. Measured: 0 wrong over 1M integers for divisor 41, where the plain `Math.floor(f(f(1 / 41) * n))` is 0 at n = 41 ([Merged from index-read](#merged-from-index-read-september-16-2026)) | 8 / 7 / 11 |
| `emitIntegerOneHot(n, low, high)` | `R_t = relu(n - t)`, members are neighbor differences, declared group | integer `n` in [low, high], below 2^23 | exact one-hot | 2K - 1 / 2 for K members |
| `emitReciprocal(x)` | threshold bits `boolean(clamp01(x / t - 0.5))` with the score composed into both relus, a constant seed per bucket as first differences, Newton steps `e * relu(2 - x * e)` with the gate computed inside the ReGLU row | declared `[low, high]` with `low > 0` (or `high < 0`), `high / low <= 2^22` | `|x * r - 1| <= 2.5e-7`. Measured 1.2e-7 on [1, 16384]; 58-66% of results equal `f(1 / x)` | on [1, 16384]: 1 bucket per octave (default, 5 steps) 50 / 13 / 85; 2 per octave 90 / 11 / 151; 4 per octave 172 / 9 / 287 |
| `emitDivide(a, b)` | `a * reciprocal(b)` | as reciprocal for `b` | `|q * b / a - 1| <= 3e-7`, measured 1.5e-7 | 51 / 14 / 87 |
| `emitSqrt(x, {minimumPositive})` | inverse square root seeds, Newton `r * relu(1.5 - 0.5 * x * r^2)`, then `x * r` | declared `[0, high]` or `[low, high]`, `high / minimumPositive <= 2^22` | exactly 0 at 0; `|root / sqrt(x) - 1| <= 2.5e-7` on [minimumPositive, high], measured 1.5e-7; values between 0 and minimumPositive are outside the contract | on [1, 2^22]: 1 per octave 80 / 19 / 137; 2 per octave 143 / 16 / 241 |
| `emitSinCos(angle)` | quadrant `k = round(angle * 2 / pi)`; `r = (angle - k * c1) - k * c2`, where c1 is pi/2 cut to 17 bits (so `k * c1` and the subtraction are exact); Horner polynomials in `r^2`, one ReGLU row per coefficient; `k mod 4` by a floor on the 1/4 grid, its one-hot, two gather reads | `|angle| <= 190` | absolute error `<= 1.5e-7`. Measured 8.6e-8 over every FP32 angle in [3.5, 4], which holds the quadrant switch at 5pi/4; 8.5e-8 over every FP32 angle in [128, 190]; 8.1e-8 over 1M samples across the domain | 34 / 14 / 52 with 2 gather reads. Phase one: 100 / 18 / 154 with 6.7e-7 on [-4pi, 4pi] |
| `emitExp(x)` | `y = x / 2^k` in [-0.5, 0.5], degree-8 Taylor in Horner rows, k squarings | `|x| <= 16` | relative error about 2^k times FP32's floor. Measured: 1.1e-7 for `|x| <= 0.5`, 5.2e-7 for 2, 2.1e-6 for 8, 4.3e-6 for 16 | 8 / 8 / 15 up to 12 / 12 / 24 |
| `emitSmoothstep(edge0, edge1, x)` | constant edges: `t = clamp01` of one affine, `t^2 * relu(3 - 2t)` | `|x / (edge1 - edge0)| < 2^23` | exactly 0 for `x <= edge0` and exactly 1 for `x >= edge1`; interior error `<= 2e-7`, measured 1.3e-7 | 5 / 4 / 8 |
| `emitSmoothstepRuntime` | edges from wires, through a reciprocal of the span | span with a declared positive range | plateaus exact; interior error `<= 3e-7` | span [1, 300]: 43 / 19 / 74 |
| `emitMix(a, b, t)` | `select(t, a, b)` | `t` in 0..1 | exactly `a` at `t = 0` and `b` at `t = 1`; otherwise within 1.1 FP32 steps of `max(|a|, |b|)` | 4 / 3 / 7 |
| `emitRemap` | constant endpoints: one affine | any | one FP32 rounding of `scale * x + offset` | 0 when composed into an affine consumer |
| `emitRemapRuntime` | endpoints from wires, reciprocal of the input span | span with a declared positive range | error `<= 5e-7 * max(1, |result|, |(x - inMinimum) * outSpan / inSpan|)`, measured 3.3e-7. The scaled span term grows when x is far outside a small input span, and the absolute error grows with it | span [1, 1000]: 46 / 18 / 81 |
| `emitHash(key)` | Hoskins's hash without sine: `p = fract(key * .1031); p *= p + 33.33; p *= p + p; fract(p)`, with exact fract | keys in [0, 2^20] | bit-equal to `hashReference(key)` for every key in [0, 2^20]. Chi-square over 64 buckets (63 degrees of freedom): 68 for keys 0..1023 (p = 0.31, consistent with an even spread); 89 for 0..16383 (p = 0.018, already rejected at the 5% level); 703 for 0..65535 and 162,964 for 0..2^20-1 | 19 / 17 / 29 |

## Measured results

### Drifting minimum against exact minimum

`emitMinimum(a, b) = a - relu(a - b)` rebuilds `b` through a rounded difference. It errs when the smaller operand has finer FP32 steps than the difference, e.g. `min(1000.37, 0.3)`. 200,000 random fractional pairs per row (`report.ts minimum`):

| a | b | drifting results not equal to `Math.min` | largest drifting error | exact results not equal |
| --- | --- | ---: | ---: | ---: |
| [0, 8] | [0, 8] | 29,993 | 2.4e-7 | 0 |
| [512, 16384] | [0, 8] | 199,818 | 4.9e-4 | 0 |
| [0, 8] | [512, 16384] | 0 | 0 | 0 |
| [900, 1000] | [900, 1000] | 0 | 0 | 0 |

When the first operand is the minimum, the drifting form subtracts an exact zero, so the error only appears in one operand order.

### HandwiredOS's rectangle hit test

This is `boolean(clamp01(min(x - left, left + width - x, y - top, top + height - y)))`. Rectangles are on a 1/64 grid, placed up to 8,000 px from the origin with sizes up to 8,000 px, and presses sit within 4e-4 px of the 0.5 px threshold inside an edge. At that threshold, a float64 hit test and exact FP32 distances must agree. Counts over 1M presses (`report.ts rectangle-hit`):

| minimum | operations / layers / weights | decisions that differ from float64 |
| --- | --- | ---: |
| drifting, nested pairs | 16 / 9 / 29 | 2,351 |
| exact, nested pairs | 27 / 12 / 58 | 0 |
| exact, counting over all four distances | 36 / 8 / 62 | 0 |

The counting form is one layer shallower than the drifting form it replaces.

### HandwiredOS with exact minimum and maximum

Measured on September 13, 2026, with this folder's copies of the window-manager.ts and photo-gallery.ts from before September 15, which stay at the [exploration-2026-09 tag](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/numeric-library). HandwiredOS has 273 unique minimum and maximum call sites, Photos included. Exact forms need finite declared ranges on both operands, and today most operands have open ranges. The modes (`report.ts indirect-os` at the tag):

- `drifting`: today's macros.
- `exact-one-stage`: exact where both declared ranges are finite, with the one-stage resolution of 2^-45 times the difference bound (2^-30 px for operands in [0, 16384]).
- `exact-one-stage-pointer-ranges`: the same, after the copies declare pointer and click coordinates in [-2^16, 2^16]. Evaluation checks those ranges like any other source range.
- `exact-one-stage-promised`: also converts the remaining sites under an unchecked promise that both operands stay within 2^16. The harnesses counted violations on every evaluated frame.
- `exact-every-float32`: today's ranges, resolving every pair of distinct FP32 values.

| mode | sites exact / promised / drifting | live operations | layers | stored weights | booleans | executor µs (rough) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| drifting | 0 / 0 / 273 | 5,253 | 192 | 11,598 | 64 | 55 |
| exact-one-stage | 42 / 0 / 231 | 5,406 | 203 | 11,864 | 106 | 58 |
| exact-one-stage-pointer-ranges | 183 / 0 / 90 | 5,898 | 211 | 13,142 | 247 | 62 |
| exact-one-stage-promised | 183 / 90 / 0 | 6,180 | 217 | 13,661 | 337 | 61 |
| exact-every-float32 | 42 / 0 / 231 | 6,075 | 283 | 12,756 | 106 | 57 |

The executor timings come from one run on a machine shared with other agents. They moved by up to 2x between report runs, so they don't rank the modes.

Where the 231 open-range sites come from:

- 141 trace back to pointer and click coordinates, which HandwiredOS never gives a range. These are the window hit tests (`emitRectangleHit` and `emitIntervalDistance`), the drag and resize clamps that add pointer deltas, and the Photos interval hits against the click latch. Declaring the coordinate ranges converts all 141.
- 90 clamp spring outputs and the frame duration: window width, height, center, and scale projections, and thumbnail center and scale. Their ranges are open because the spring stiffness, damping, and velocity cells, and the frame timestamps, have open ranges.

Converting every site costs 927 more operations (+18%) and 25 more layers (+13%) with one-stage comparisons. Resolving every FP32 pair at just the 42 sites with finite ranges costs 91 more layers, because each of those comparisons has 5 or 6 clamp stages.

#### Settled layout against float64

This sweep covers 200 viewports: a quarter of them small, e.g. 31 x 393, and half with fractional sizes. Each viewport gets random fractional window rectangles. All springs settled, in 30.6 frames on average. The table gives the largest difference from float64, which was the same in every mode, and the number of outputs that don't equal `fround(float64)`, per mode:

| outputs | count | largest difference, every mode | drifting | exact-one-stage | pointer ranges | promised | every FP32 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| window projections | 4,800 | 6.1e-5 px | 476 | 476 | 471 | 471 | 476 |
| dock items | 3,200 | 6.1e-5 px | 5 | 31 | 31 | 31 | 31 |
| Photos grid | 9,600 | 3.1e-5 px | 1,484 | 1,484 | 1,484 | 1,484 | 1,484 |
| Photos controls | 1,600 | 1.8e-5 px | 100 | 84 | 84 | 84 | 84 |
| stored rectangles | 3,200 | 3.1e-5 px | 6 | 6 | 0 | 0 | 6 |

The largest differences are one FP32 step at the operand magnitudes. They come from affine coefficients like `f(1 / 3)` and `f(0.24)`, not from minimum and maximum, so no mode changed them. The exact modes did change which outputs round the same way as `fround(float64)`:

- Declaring pointer ranges removed all 6 stored rectangle disagreements (left, top, and width) and 5 window projection disagreements (3 in `translateX`, 1 in `width`, 1 in `contentWidth`).
- The Photos control disagreements, all in `top`, went from 100 to 84 in every exact mode.
- Every exact mode raised the dock disagreements from 5 to 31, all in `left`. The reason is that an exact selection reaches its consumers as a sum of two ReGLU products, not as one rounded wire. For example, at a 1913.38 x 1259.04 viewport, where both dock minimums pick their first operand, the drifting circuit computes the third item's left as `0.5 * viewportWidth + 0.5 * gap`: gap and item size are single wires, so their coefficients combine and the size term cancels. The exact circuit computes the same output as `0.5 * viewportWidth + 2 * gap + 2 * size - 0.5 * totalWidth`. Its running FP32 sum passes through about 1,080.69, rounds at the coarser step there, and ends one FP32 step (6.1e-5 px) away from the drifting result.

The Photos grid disagreements (1,056 in `height`, 428 in `top`) were the same in every mode.

#### Decisions

- Press decisions near window edges: 3,000 presses within 2e-4 px of 0.5 px inside a right or bottom edge. 57 landed in a title bar and were skipped, since a close button changes visibility. 2,190 of the scores fell within 1e-3 of the threshold. Every mode matched the float64 frontmost-hit reference, including `drifting`, because HandwiredOS coordinates stay small enough that the drifting reconstruction is exact.
- Random actions (the mix from `window-manager.test.ts`: viewport changes, random clicks, window controls, dock clicks, drags, resizes). 3,000 actions ran in all five modes side by side with 0 decision divergences and 0 decision cells that weren't exact bits. The largest source table difference from `drifting` was 7.6e-6 px.
- The promise held on every evaluated frame of all three sweeps: 0 of 112 promised operand wires exceeded 2^16.
- All 14 behavior tests of `window-manager.test.ts` pass in `exact-one-stage` and `exact-one-stage-promised`.

### The workload

`workload.ts` runs a 9-icon dock with a radial magnification falloff from each icon's resting center. Icons push their neighbors apart through one wide sum per prefix, and the nearest icon comes out as an exact one-hot. The same circuit runs a progress ring: a head dot from sin and cos of the progress angle, and 24 ticks rotated by one shared (cos, sin) pair of a runtime spin angle. Each tick has a per-cycle jitter from a runtime hash of `cycle * 24 + tick`, an exact lit bit, and a smoothstep opacity. A percent label comes from a floor.

| part | live operations | layers | stored weights |
| --- | ---: | ---: | ---: |
| whole workload | 2,230 | 41 | 3,932 |
| dock alone | 1,018 | 41 | 2,091 |
| ring alone | 1,212 | 28 | 1,841 |

`report.ts workload` runs 100,000 random sources against a float64 reference that uses `Math.sqrt`, `Math.sin`, and `Math.cos`. A third of the sources put progress within 3 FP32 steps of a tick boundary k/24, and a third within 3 steps of a percent boundary k/100:

- Icon, head dot, and tick positions are within 3.2e-4 px of float64.
- The tick lit bits equal float64's `progress >= tick / 24` and the percent label equals `Math.floor(progress * 100)` on every source. They also match on every progress value within 3 FP32 steps of a threshold: 707 values near k/100 and 168 near k/24.
- The nearest icon equals the float64 nearest icon on all 79,670 sources whose two nearest distances differ by more than 1e-3. The remaining sources are near ties, mostly pointers far from the dock, where every distance clamps to 256 px.

Two decisions needed care to match float64 exactly. The report also counts what the obvious forms get wrong on those 875 boundary values:

- A threshold constant. `f(progress - f(5 / 24))` is 0 at `progress = f(5 / 24) = 0.20833333`, which is below 5/24, so tick 5 lights one FP32 step early. For an FP32 value x, `x >= t` holds exactly when `x >= ceilFloat32(t)`, the smallest FP32 value at or above t, so the circuit subtracts that constant instead, at no extra cost. The rounded constants got 7 of the 168 tick boundary values wrong.
- A product before a floor. `floor(f(progress * 100))` returns 1 at `progress = f(0.01) = 0.0099999998`, because the product rounds up to 1. float64 holds `progress * 100` exactly, since the product needs only 29 significant bits. `emitPercentOfUnit` splits progress at 2^-19, so both partial products by 100 are exact FP32 values, then adds a carry bit. It costs 25 operations and 20 layers, against 8 and 7. The rounded product got 58 of the 707 percent boundary values wrong.

The dock spends most of its operations on 9 clamped square roots: 81 operations each, of which the root alone on [1, 2^16] is 62. The largest part of the ring is its 24 hashes, 19 operations each. Rotating constant tick offsets by one runtime (cos, sin) pair costs 2 sine evaluations instead of 24.

The spin clock hit a real FP32 limit. Near 16,384 seconds, `f(f(1 / 2.4) * seconds)` is about 6,827 cycles, where one FP32 step is 2^-11 cycles. Stepping seconds through consecutive FP32 values just below 16,384 moves tick 0 by up to 0.195 px at a 64 px radius. The float64 reference starts from the same rounded cycle count, and the demo measures time from page load, as phase one recommended. The workload's hash keys reach 163,847 at 16,384 seconds, far past the range where the hash spreads evenly (chi-square 3,182 over keys 0..163,871). So the jitter is only well mixed for about the first 43 cycles, which is about 100 seconds.

## What this shows about how far the approach goes

### What fit well

- Rounding is the missing connective, and it's cheap. Round is 2 operations, floor on a known grid is 3, and floor of any nonnegative FP32 value is 7. Once floor exists, hashing, quadrant reduction, and cyclic phases like `fract(seconds / period)` are all short.
- Exact comparison no longer needs a 26-layer cascade. The boolean atom reads `[score >= 0.5]` exactly, so one stage resolves a 2^45 ratio in 4 operations and 3 layers. A declared range plus a stated resolution picks the stage count mechanically. For UI coordinates, one stage resolves any two values that differ by at least 2^-30 px, and phase one's full FP32 cascade shrank from 26 operations to 22.
- A decision against a constant float64 threshold is free to make exact: store the smallest FP32 value at or above the threshold, e.g. the ring's tick 5 stays unlit at `progress = f(5 / 24)`, just as in float64.
- Iterations are shallow when their gate is computed inside the ReGLU row. A Newton step for the reciprocal is 2 operations (`e * relu(2 - x * e)`), and a Horner step is 1 (`(c + p) * relu(r^2)`). That cut sine and cosine from 100 operations to 34, and the error from 6.7e-7 to 8.6e-8.
- Exact decisions can be shallower than drifting ones. Counting over all pairs gives the exact minimum of four hit distances in 8 layers, against 9 for nested drifting minimums.
- Shader habits carry over: rotate many constant offsets by one runtime (cos, sin) pair, shape with smoothstep, get per-item variation from a float hash. The FP32 reference for the hash is just the same steps with `Math.fround`, so the circuit is bit-equal to it.
- Exact minimum and maximum give tight ranges (`clamp(x, 0, 32)` is declared [0, 32]). The drifting forms can only declare arithmetic bounds, and those turn open as soon as one operand is open.

### What got awkward

- Exactness is gated by declared ranges, and HandwiredOS leaves most of them open. 231 of 273 sites couldn't convert. Declaring pointer coordinates fixes 141 honestly. The other 90 sit downstream of springs, whose intermediate ranges grow without bound under range propagation, so they need either a promise or a spring whose state is bounded by construction. A relu-based clamp can't saturate an unbounded value: its plateau breaks once the scaled difference passes 2^24.
- Promises are easy to check wrongly. My first violation count read unrelated wires, because Photos is built as its own circuit and inlined, so its wire numbers change. The fix was remapping the promised operands through the map `inlineCircuit` returns. A tool that tracks contracts across inlining has to do the same.
- Exactness costs depth. A single exact minimum is 7 operations and 5 layers against 3 and 3. On HandwiredOS's sweeps, no mode changed the largest layout differences from float64. One FP32 step of affine rounding sets those (6e-5 px near 1,000 px), and HandwiredOS's coordinates rarely mix magnitudes enough for the drifting minimum to err. The exact modes did change which outputs round like `fround(float64)`. Pointer ranges removed the 6 stored rectangle disagreements, but every exact mode added 26 in dock item positions, because an exact selection reaches its consumers as more affine terms. The decision differences showed up only at 8,000-px coordinates (0.24% of near-edge presses decided wrong) and on mixed magnitudes (4.9e-4 px errors).
- "Resolves every FP32 pair" is expensive: 22 operations per comparison within 2^15. It pays to state a resolution, and the right resolution is a property of the data, e.g. geometry on a 1/64 px grid, or operands that are either 0 or at least 2^-7 px. Nothing in the builder knew a value's grid then, so the caller had to say it. numeric-ui-core.ts has since added `circuit.assumeGrid(wire, step)`, and its own `emitCompare` builds integer bits when both operands are declared on a grid.
- A product that needs more than 24 significant bits before a floor has to be split by hand. The percent label needed 25 operations instead of 8 to match `Math.floor(progress * 100)`.
- Several contracts have range ratios built in. Reciprocal and square root need `high / low <= 2^22` and a `minimumPositive`, because their composed threshold scores break the clamp plateau above that ratio. Exp's error doubles with each squaring. The hash spreads keys evenly only for small key sets. At 1,024 keys the chi-square p is 0.31, at 16,384 keys it is 0.018, and past 65,536 keys the spread is far from even, likely because `key * .1031` keeps only about 11 fractional bits there.
- Near 16,384 seconds, one FP32 step of the spin clock moves a tick about 0.2 px, so clocks have to be latched relative to an event.

### What stayed outside the circuit

- Division by a value whose range crosses zero, and any operand without a finite bound, e.g. raw `requestAnimationFrame` timestamps.
- Agreement with float64 beyond one FP32 step. Layout arithmetic still rounds once per affine term, whichever minimum is used.
- Well-mixed pseudo-random values beyond about a thousand keys. The float hash stays bit-exact, but its spread is already borderline at 16,384 keys. The alternatives are a prepare-time table in JavaScript or phase one's 11-bit limb multiply-shift.
- Choosing a comparison plan per call site. The library does it per macro call, from the caller's resolution.
- The DOM projection and event decoding in `demo.ts`.

## Open questions and next steps

- Bounded springs. If a spring clamps its displacement and velocity inside the frame step, range propagation would stay finite, and the last 90 HandwiredOS sites would convert without a promise. How much would the clamps cost next to the 2x2 frame-matrix spring from phase one?
- A resolution per value. A builder-level grid declaration (e.g. "this wire is a multiple of 1/64") would let `emitCompare`, `emitFloor`, and gather planning pick the cheapest exact form automatically, and warn when a composed score crosses the 2^22 plateau limit. numeric-ui-core.ts took part of this on September 14, 2026: `circuit.assumeGrid(wire, step)` declares a grid, the builder infers grids for sums and products, and the root runtime's `emitCompare` builds integer bits on grids and a sign cascade otherwise, with no warning when grid operands are too wide for integer bits. This library's `emitCompare` and `emitFloor`, and gather planning, don't read grids.
- Counting minimums inside HandwiredOS. Replacing the nested hit-test minimums with `emitMinimumOf` would test whether exact decisions can reduce layers in a whole program, not just in one hit test.
- Cheaper seeds. A linear seed per bucket would cut two Newton steps from the reciprocal and square root. Comparing squared distances instead of distances would remove the dock's 9 square roots, e.g. a falloff that is smoothstep in `d^2`.
- Not built: `log`, `pow`, and `atan2`. `atan2` would follow the sine construction (octant reduction by exact comparisons, then a short series), and `log` could use octave bits plus a series.
- Generated JavaScript from phase one could make the extra booleans nearly free on the CPU. The executor timings above are too noisy to show what the booleans cost today.

## Merged from index-read, September 16, 2026

`emitFloorDivide` and its test came from [index-read](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/index-read), where it computed a virtualized list's first row, `floor(scrollTop / rowHeight)`, before reading rows at that index ([lists](../lists/README.md#merged-from-index-read-september-16-2026)). The plain `Math.floor(f(f(1 / rowHeight) * scrollTop))` misses at least one row for 74 of the 512 integer row heights from 1 to 512, checked at every multiple of the height up to 2^21 and one below each, e.g. height 41 at scrollTop 41 gives row 0. The first failing heights are 41, 47, 55, 61, 82, 83, 94, 97, 107 and 109. index-read measured this on September 13, 2026, and a scratch script got the same counts on September 16. index-read's version declared no ranges. This one reuses `emitRound`, which needs a declared range, so the approximate quotient declares one, and the cost stays 8 operations in 7 layers.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/numeric-library/demo.html`.

- The page loads with no console errors. The stats line shows 2,230 live operations, 41 layers and 3,932 stored weights, as in the workload table above.
- The ring spins and fills. The lit tick count matched the label in the two frames I read: 20 of 24 ticks at 82%, and 3 at 11%.
- Moving the pointer near the dock magnifies it: the icon under the pointer grew from 48 px to 95 px and got the nearest outline, its neighbors to 80 px and 78.1 px, and the next ones to 53.6 px and 52.3 px. Exactly one icon was marked nearest.
- No fixes were needed.

# Learned decision rules at the level of bits

This folder asks which UI decision rules can be learned at the level of bits and then hardened into an exact circuit, and whether a learning unit that has the same form as the runtime's own exact decision, a count of bits followed by a threshold, does better than the 2-input logic gates of Petersen et al., "Deep Differentiable Logic Gate Networks" (2022). It applies the talk's "what if logic gates have learned backprops?" to UI behavior. Every task is enumerated over every input case, so "exact" always means every case, not a sample.

`numeric-ui-core.ts` is unchanged; `compile.ts` imports it with a relative path. The oracles are copied from `lab/ui-exploration/input` into `oracles.ts`. A scratch script (`scratchpad/phase3/learned-bits/oracle-copies-check.ts`, outside the repo, backup: `~/github/indirect-scratch-backup/2026-09-15/scratchpad/phase3/learned-bits/oracle-copies-check.ts`) ran the copies next to input's originals: 0 differences over 112,160 Tab calls, 3,476 menu events, and 4,096 rectangle points.

## How to run it

From the repo root:

- `bun test lab/ui-exploration/learned-bits` runs 11 tests in about half a second to a second: task oracles on named cases; finite-difference checks of the gradients for both unit types, all three counting relaxations, and every shared channel, with the networks wired so that gradients flow through hidden layers and at least a quarter of the checked logits in every layer have a nonzero gradient; a hand-set network and random networks with varying outputs compiled into circuits and checked on every case; wiring coverage on first-active-8; input's authored Tab reproduced at 127 operations and 7 layers; and two small training runs that must learn exactly.
- `bunx tsgo -p lab/ui-exploration/learned-bits` typechecks.
- `bun lab/ui-exploration/learned-bits/report.ts [section...]` runs the measurements and merges them into `report-output.json`. The sections are `authored` (about 1 s), `ladder` (48 runs, about 7 minutes with 10 processes), `variants` (153 runs, about 5 minutes), `sharing` (33 runs, about 12 minutes, most of it the three tab-12 runs), `coverage` (the wiring coverage of every ladder, variant, and sharing configuration, without training), `clamp-initialization` (36 runs), and `covering-gates` (90 runs); the last three take about a minute together. Experiments run as child processes (`report.ts run '<json>'`); `LEARNED_BITS_CONCURRENCY` sets how many run at once (default 10) and `LEARNED_BITS_LOG` names a progress log. Every number below comes from `report-output.json`. Training seconds are rough, because many agents shared the machine.

## What was built

| File | What it holds |
| --- | --- |
| `tasks.ts` | the task ladder, each task a table of input bits and target bits over every case, plus named intermediate predicates for inspection |
| `oracles.ts` | copies of `cyclicNextEnabled`, `strictlyInside`, and the menu bar oracle from `input/` |
| `network.ts` | both unit types, three relaxations for counting units, sharing across positions, random, prefix, and doubling wiring, the Adam trainer, hardening, and exact integer evaluation |
| `compile.ts` | hardened networks and authored constructions compiled into circuits, measured, and checked on every case with the tensor evaluator |
| `inspect.ts` | the inputs each output bit depends on and whether a network's wiring can reach them, live units, a named construction per unit, matching of units against named predicates over every case, and readable rules for shared units |
| `experiment.ts` | one experiment: optionally redraw the wiring until every output bit can read every input it needs, train on a seeded 60/40 split, harden, count exact cases, compile, check every case, inspect |
| `report.ts`, `report-output.json` | the measurement sections and their output |
| `learned-bits.test.ts` | the tests |

### Tasks

| Task | Input bits | Output bits | Cases | Oracle |
| --- | --- | --- | ---: | --- |
| `first-active-8` | 8 bits | the first set bit as a one-hot | 256 | |
| `tab-4`, `tab-6`, `tab-8`, `tab-12` | focus one-hot (all zero when nothing is focused), enabled bits, Shift | the next focus one-hot | 160, 896, 4,608, 106,496 | `cyclicNextEnabled` from `input/keyboard.ts` |
| `rectangle-hit` | pointer x and y as 6-bit integers, most significant bit first | inside a fixed rectangle (left 9, top 22, width 37, height 29) | 4,096 | `strictlyInside` from `input/windows.ts` |
| `click-or-drag` | dx and dy as 5-bit two's complement integers | drag, i.e. the Chebyshev distance is above a slop of 4 | 1,024 | the slop rule in `input/windows.ts` |
| `menu-slot` | open, highlight, and title focus one-hots, 4 event kind bits, 8 key bits, Shift, and 21 pointer region bits | next open, highlight, and title focus, plus which item was activated | 3,520 | `menuOracleEvent` from `input/menu.ts` |

The menu slot fixes the layout at build time (the bar from `input/menu.test.ts`: 3 menus with 5 item slots, some disabled) and replaces coordinates with region bits: which title is under the pointer, whether the pointer is inside each menu's panel, and which item row of each panel it is on. Those bits are what the arithmetic part of a circuit computes from coordinates. The oracle runs on real coordinates at a representative point per region (21 points), over the 44 reachable states and 80 events: an empty slot, 16 combinations of key and Shift, and down, move, and up at every point.

### Unit types

- **2-input gate**: reads 2 wires and learns a softmax over the 16 functions `c0 + c1 a + c2 b + c3 ab`. 16 logits. Hardened into the function with the largest logit. Compiled as one ReLU row `relu(a + b - 1)` when the function needs `ab`, plus an affine that composes into its readers.
- **Counting unit**: reads C candidate wires (8 by default), learns a weight in {-1, 0, +1} per candidate through a 3-way softmax, and a threshold t in 1..8 through an 8-way softmax. 3C + 8 = 32 logits, as many as two gates. Hardened into the bit `[Σ w x >= t]`, compiled as `relu(s - t + 1) - relu(s - t)`, leaving out a ReLU when the declared ranges show it never clips. For example, an AND over k bits (t = k), an OR (t = 1), and "one wire and none of these" (`x - Σ others >= 1`) are each one ReLU row.

A layer reads the input bits (plus their complements by default) and either the previous layer or every earlier layer. An output bit is the majority vote of a group of units. For equal logit counts, gate networks use twice the width and twice the group size of counting networks.

Counting units have three relaxations:

- **expectation**: the expected output when every weight and the threshold are drawn from their softmaxes and every wire value is read as the probability of an independent 1. The gate relaxation is the same kind of expectation. It's computed with a dynamic program over the distribution of the sum, about C² multiplications per unit per case.
- **normal**: the same expectation with the sum's distribution replaced by a normal distribution with the same mean and variance, plus a variance floor of 0.3², so a hardened unit reading exact bits still has a slope. About C + 8 operations per unit per case.
- **clamp**: `clamp01(s - t + 1)` with `s = Σ E[w] x` and `t = E[t]`, the form proposed in the brief.

### Sharing across positions

Tab and first-active apply the same rule at every position. With `sharing: true`, every hidden layer is channels × positions units, all units of a channel share one set of logits, and each unit reads wires relative to its own position p, e.g. "enabled[p - 2]" or "channel 5 of layer 1 at p - 1". One learned unit is then a small program run at every position, like a fragment shader run at every pixel, and every training case trains every position at once. Relative reads wrap around for Tab, or read a constant 0 past either end (`padding: 'zero'`). A marker source is 1 at position 0 only, so a shared program can tell where the controls start. With sharing, a counting unit can afford to read every relative reference (`candidates: 0`), because the number of references doesn't grow with the number of units: e.g. tab-4's first layer has 22 references (5 source groups at 4 offsets, plus Shift and its complement).

When the outputs aren't one per position (rectangle-hit, click-or-drag, menu-slot), sharing doesn't apply, and those tasks only appear in the ladder and variants.

With `wiring: 'doubling'`, a shared layer l reads references at p on its even wires and at p - 2^l on its odd wires, so three layers can compose spans of 2, 4, and 8 positions, like a parallel prefix circuit. Gates can compute first-active-8 in that shape: "x[p] and not x[p-1]" and "x[p] or x[p-1]", then the same over spans of 4, then "first of 4 at p, and nothing in the 4 before".

### Wiring coverage

Whatever its logits are, a network can only be exact if each output bit's wiring reaches every input the bit depends on. `neededInputs` finds those inputs from the task table: input i is needed by output bit b when two cases differ only in input i and differ in bit b. `wiringCoverage` follows every wire each unit reads and reports the output bits whose wiring misses a needed input. For example, first[7] needs x[0] through x[7]. An output unit of a 2-input gate network with d layers reaches at most 2^d source wires, so at the same depth, gate wiring reaches fewer inputs than counting units that read 8 candidates each. An experiment can redraw its wiring (new network seeds, same training seed) until every output bit is covered.

## Measured results

### Authored constructions

`input kit` is input's `cyclicNextAvailable` in both directions plus a select on Shift, built exactly as input's scratch baseline builds it. `counting` is the same construction through `countingBit`, which leaves out ReLUs that never clip, with the Shift select written as two counting bits.

| Task | Form | Live operations | Layers | Stored weights | Exact cases |
| --- | --- | ---: | ---: | ---: | ---: |
| tab-4 | input kit | 85 | 7 | 279 | 160 of 160 |
| tab-4 | counting | 40 | 5 | 128 | 160 of 160 |
| tab-6 | input kit | 127 | 7 | 515 | 896 of 896 |
| tab-6 | counting | 68 | 6 | 244 | 896 of 896 |
| tab-8 | input kit | 169 | 7 | 815 | 4,608 of 4,608 |
| tab-8 | counting | 94 | 6 | 410 | 4,608 of 4,608 |
| tab-12 | input kit | 253 | 7 | 1,607 | 106,496 of 106,496 |
| tab-12 | counting | 146 | 6 | 862 | 106,496 of 106,496 |
| first-active-8 | counting | 7 | 1 | 35 | 256 of 256 |
| rectangle-hit | `x = Σ 2^k bit_k`, 4 comparisons, an AND | 9 | 2 | 56 | 4,096 of 4,096 |
| click-or-drag | signed sums, 4 comparisons, an OR | 11 | 3 | 58 | 1,024 of 1,024 |

### The ladder at equal logit counts

Base settings: random wiring, reading the previous layer, complements, residual initialization (a unit starts close to "pass the first wire through"), squared loss, no annealing, and 2,000 Adam steps on 60% of the cases. tab-8, tab-12, rectangle-hit and menu-slot use minibatches of 512. The learning rate is 0.1 for counting units and 0.05 for gates, and counting units use the expectation relaxation. Each cell lists three seeds. "Exact cases" counts cases where every output bit is right after hardening, over every case. For scale: always answering "outside" is right on 3,088 rectangle-hit cases, always answering "drag" on 943 click-or-drag cases, and "nothing changes" on 1,278 menu-slot cases.

| Task (cases) | Logits | Counting units: exact cases | Counting: held out | Gates: exact cases | Gates: held out |
| --- | ---: | --- | --- | --- | --- |
| first-active-8 (256) | 2,560 | 252, 251, 252 | 99, 97, 98 of 102 | 225, 175, 195 | 90, 63, 77 of 102 |
| tab-4 (160) | 4,864 | 119, 115, 121 | 29, 29, 28 of 64 | 102, 95, 100 | 31, 28, 28 of 64 |
| tab-6 (896) | 6,912 | 722, 724, 654 | 249, 253, 220 of 358 | 402, 294, 359 | 145, 100, 118 of 358 |
| tab-8 (4,608) | 10,240 | 3,375, 3,645, 3,449 | 1,288, 1,404, 1,346 of 1,843 | 905, 822, 817 | 321, 338, 324 of 1,843 |
| tab-12 (106,496) | 17,920 | 81,292, 80,059, 78,982 | 32,453, 32,030, 31,521 of 42,598 | 9,754, 4,122, 3,103 | 3,847, 1,649, 1,273 of 42,598 |
| rectangle-hit (4,096) | 4,864 | 3,844, 4,034, 3,928 | 1,531, 1,613, 1,572 of 1,638 | 3,684, 3,528, 3,624 | 1,467, 1,417, 1,433 of 1,638 |
| click-or-drag (1,024) | 4,864 | 943, 962, 943 | 371, 380, 374 of 410 | 951, 947, 943 | 373, 378, 374 of 410 |
| menu-slot (3,520) | 10,240 | 2,041, 1,636, 1,840 | 790, 626, 707 of 1,408 | 721, 460, 685 | 275, 183, 278 of 1,408 |

- No base run learned any rung exactly, for either unit type.
- Counting units got more cases right than gates on every rung except click-or-drag, where both mostly answered "drag". The gap grows with the rung: on tab-12, counting networks got about 75% of the cases right, gates 3% to 9%. On menu-slot, only counting networks beat "nothing changes".
- Some gate networks couldn't have been exact whatever their logits were, because their wiring misses inputs that an output bit needs (the `coverage` section). Gate wiring reached every needed input for 6, 5, 6 of 8 output bits on first-active-8, 4 of 6 on tab-6 seed 2, 6 of 8 on tab-8 seeds 1 and 3, 10 of 12 on tab-12 seeds 1 and 2, and 2 of 16 on menu-slot in every seed. Every counting network's wiring reached every needed input. With the gate wiring redrawn until every output bit was covered, gates at the ladder settings got 230, 205, 188 on first-active-8, 402, 317, 359 on tab-6, 929, 822, 1,152 on tab-8, and 11,549, 9,386, 3,103 on tab-12: still below counting networks on every rung, and far below from tab-6 up (see "Gates with wiring that can reach every needed input"). menu-slot gate wiring still missed needed inputs after 200 redraws.
- Every hardened network compiled into a circuit whose outputs equal the JS netlist on every case: 48 of 48 ladder runs, 153 of 153 variant runs, 33 of 33 sharing runs, 36 of 36 clamp initialization runs, and 90 of 90 runs with covering gate wiring.
- Every ladder network compiled to more live operations than the authored construction for its task (menu-slot has none), e.g. tab-6 counting networks compiled to 292 to 306 live operations and 6 or 7 layers, against 68 and 6 for the authored counting form.
- Counting networks trained about 30 to 65 times slower than gate networks with the same logit count (tab-4: about 7 s against 0.2 s; tab-6: about 69 s against 1.1 s; tab-12: about 183 s against 3 s).

### Variants on tab-4, click-or-drag, and first-active-8

Exact cases over every case, three seeds per cell.

| Variant | tab-4, counting | tab-4, gates | click-or-drag, counting | click-or-drag, gates | first-active-8, counting | first-active-8, gates |
| --- | --- | --- | --- | --- | --- | --- |
| base | 119, 115, 121 | 102, 95, 100 | 943, 962, 943 | 951, 947, 943 | 252, 251, 252 | 225, 175, 195 |
| trained on every case | 152, 154, 156 | 105, 97, 106 | 943, 959, 943 | 953, 945, 943 | **256, 256, 256** | 232, 174, 201 |
| prefix wiring | 124, 128, 126 | 103, 99, 84 | 976, 943, 983 | 943, 946, 943 | 255, 253, 253 | 225, 249, 229 |
| prefix wiring, zero bias 3 | 133, 137, 123 | - | 961, 987, 943 | - | 254, 254, 254 | - |
| read every earlier layer | 140, 126, 118 | 87, 87, 81 | 959, 974, 1,004 | 943, 943, 943 | 251, 253, 252 | 160, 220, 190 |
| temperature 1 to 0.1 | 108, 112, 105 | 100, 103, 97 | 943, 943, 943 | 943, 943, 943 | 228, 246, 238 | 231, 196, 181 |
| no complements | 125, 131, 119 | 103, 100, 104 | 967, 1,017, 1,016 | 943, 943, 943 | 252, 254, 252 | 178, 237, 241 |
| cross-entropy loss | 123, 99, 107 | 97, 92, 84 | 943, 943, 943 | 943, 943, 943 | 250, 239, 232 | 193, 176, 185 |
| clamp relaxation | 1, 8, 9 | - | 657, 625, 615 | - | 0, 0, 0 | - |
| normal relaxation, 24 candidates, every earlier layer, zero bias 3 | 136, 131, 125 | - | 960, 951, 967 | - | 236, 251, 247 | - |

"Prefix wiring" draws each wire with probability 0.75 from bits at the unit's own position p or at p - 1, p - 2, p - 4 (and bits with no position, e.g. Shift). "Zero bias 3" starts every candidate but the first close to weight 0. The last row has 12,160 logits on tab-4, so its logit count isn't equal to the gates'.

- The clamp relaxation from the brief doesn't train from the base initialization. With residual bias 2, E[t] starts at about 2.95 while `s` is at most about 0.8, so `s - t + 1` is negative on every case, and every logit's gradient is exactly 0. A stronger initial bias toward t = 1 trains, but still trails the expectation relaxation; see "The clamp relaxation and its initialization" below.
- Temperature annealing and cross-entropy didn't help. On click-or-drag, 16 of the 21 gate runs and 12 of the 30 counting runs got exactly 943 cases right, the count of always answering "drag".
- Trained on every case, counting units learned first-active-8 exactly for all three seeds and got within 4 to 8 cases of tab-4. Gates stayed more than 50 cases short of tab-4 with every setting.
- Held-out generalization was the weaker half: the best tab-4 counting run in this table ("read every earlier layer", seed 1) got all 96 training cases and 44 of 64 held-out cases.
- 19 of the 21 gate runs for first-active-8 have wiring that can't express the task: their wiring reached every needed input for only 4 to 7 of 8 output bits. The other two, "no complements" seeds 2 and 3, reached all 8 and got 237 and 241 of 256. Every tab-4 gate network reached every needed input except "prefix wiring" seeds 2 and 3 and "read every earlier layer" seeds 1 and 2. Gates whose wiring was redrawn until covered didn't learn first-active-8 either (see "Gates with wiring that can reach every needed input").

### The clamp relaxation and its initialization

The residual bias is added to the logit of weight +1 on candidate 0 and to the logit of threshold 1. With bias 2, E[t] starts at about 2.95; with bias 4, about 1.46; with bias 6, about 1.07. "Nonzero gradients at initialization" is the share of logits whose gradient, summed over every case, isn't 0 before training; the range covers the 9 networks in the row (3 tasks, 3 seeds). Exact cases over every case, three seeds per cell, trained on 60% of the cases.

| Relaxation and residual bias | tab-4 | click-or-drag | first-active-8 | Nonzero gradients at initialization |
| --- | --- | --- | --- | --- |
| clamp, 2 (base) | 1, 8, 9 | 657, 625, 615 | 0, 0, 0 | 0% in all 9 networks |
| clamp, 4 | 49, 43, 111 | 943, 943, 943 | 0, 20, 44 | 47% to 81% |
| clamp, 6 | 111, 107, 80 | 943, 943, 943 | 189, 176, 161 | 77% to 96% |
| expectation, 2 (base) | 119, 115, 121 | 943, 962, 943 | 252, 251, 252 | - |
| expectation, 6 | 129, 118, 118 | 975, 983, 988 | 254, 254, 250 | - |

- With bias 6, the clamp's soft loss went down to 0.04 to 0.43 (about 0.92 to 1 with bias 2), and it got 80 to 111 of 160 tab-4 cases and 161 to 189 of 256 first-active-8 cases, against 118 to 129 and 250 to 254 for the expectation relaxation with the same initialization. On click-or-drag, the clamp with bias 4 or 6 always answered "drag".
- So the clamp's zero gradient in the variants table comes from the initialization, and the gap that remains once it trains comes from the relaxation.

### Sharing across positions

Shared counting units read every relative reference through the normal relaxation (one row uses the expectation relaxation), with zero bias 3. Shared gates draw random 2-reference templates. Logit counts differ between rows, because shared logits count once. Three seeds per row, exact cases over every case.

| Task (cases) | Configuration | Logits | Exact cases | Held out | Live operations / layers |
| --- | --- | ---: | --- | --- | --- |
| first-active-8 (256) | one shared counting unit, no hidden layer | 143 | **256**, 254, 254 | 102, 100, 100 of 102 | 12, 14, 10 / 2 |
| first-active-8 | the same, expectation relaxation | 143 | **256**, 254, 254 | 102, 100, 100 of 102 | 12, 10, 8 / 2, 2, 1 |
| first-active-8 | shared gates, 2 hidden layers | 160 | 17, 128, 128 | 4, 49, 54 of 102 | 1, 2, 2 / 1 |
| tab-4 (160) | shared counting units, 3 hidden layers | 1,516 | 146, 123, 117 | 55, 39, 38 of 64 | 80, 76, 68 / 5 |
| tab-4 | 5 hidden layers, zero padding, every earlier layer | 6,818 | 143, 141, 126 | 48, 46, 31 of 64 | 111, 141, 109 / 8, 8, 7 |
| tab-4 | the same, trained on every case | 6,818 | 159, 155, **160** | - | 94, 78, 133 / 6, 7, 7 |
| tab-4 | shared gates, 3 hidden layers | 448 | 85, 58, 66 | 34, 19, 24 of 64 | 20, 44, 26 / 4, 6, 5 |
| tab-6 (896) | shared counting units, 3 hidden layers, every earlier layer | 2,752 | 807, 836, 849 | 316, 324, 330 of 358 | 156, 185, 173 / 6 |
| tab-6 | shared gates, 3 hidden layers | 448 | 284, 102, 418 | 106, 42, 171 of 358 | 48, 49, 72 / 5, 6, 6 |
| tab-8 (4,608) | shared counting units, 3 hidden layers, every earlier layer, batches of 1,024 | 3,604 | 2,216, 2,408, 2,216 | 873, 952, 898 of 1,843 | 56 / 3 |
| tab-12 (106,496) | the same | 5,308 | 46,284, 50,892, 55,500 | 18,434, 20,368, 22,054 of 42,598 | 84 / 3 |

- first-active-8 was learned exactly from 60% of the cases in seed 1 with either relaxation. Seeds 2 and 3 got every training case and missed 2 held-out cases.
- The only exact tab-4 network was trained on every case (seed 3). It compiles to 133 live operations, 7 layers, and 2,257 stored weights, against 40, 5, and 128 for the authored counting form. Its 64 live units are 16 shared channels at 4 positions, all wide counts such as "15 positive, 15 negative, t = 2"; the only named predicates any unit matches are the output bits themselves, and its printed rules don't read as Tab.
- On tab-6, shared counting units got the best held-out results of any configuration (316 to 330 of 358), with 2,752 logits against the ladder's 6,912.
- tab-8 and tab-12 got worse with sharing: 2,216 to 2,408 cases against 3,375 to 3,645 without sharing, and 46,284 to 55,500 against 78,982 to 81,292. These runs have fewer logits (3,604 and 5,308 against 10,240 and 17,920) and larger minibatches than the ladder, and their hardened networks compiled to only 56 and 84 live operations in 3 layers.
- Shared gates got fewer cases right than unshared ladder gates on first-active-8 (17 to 128 against 175 to 225) and tab-4 (58 to 85 against 95 to 102), and spread wider on tab-6 (102 to 418 against 294 to 402). These rows say little about the unit type. Each shared gate channel reads 2 random relative references, and on first-active-8 that wiring reached every needed input for 0 of 8 output bits in all three seeds, e.g. first[0] never reads x[0], so no logits could make those networks exact; their circuits are 1 or 2 live operations. On tab-4 and tab-6, the shared gate wiring covered every output bit in 1 of 3 seeds (tab-4 seed 3 and tab-6 seed 2, which got 66 and 102 cases). The shared counting unit reads every relative reference, so its wiring always covers. The next section gives gates wiring that can reach every needed input.
- The `sharedRules` strings for the zero-padded tab-4 runs in `report-output.json` were printed before a display fix in `describeLeaders`: offsets of reads that don't wrap were folded mod 4, e.g. p - 3 shown as p + 1. Rerunning a configuration with `report.ts run` prints the fixed rules.

### Gates with wiring that can reach every needed input

Every run here redrew its wiring, up to 200 times, until every output bit could read every input it needs. Exact cases over every case, three seeds per cell. "Ladder settings" are the ladder's gate networks (twice the counting widths, learning rate 0.05, 2,000 steps).

| Task (cases) | Gate configuration | Logits | Exact cases, 60% of the cases | Held out | Exact cases, trained on every case |
| --- | --- | ---: | --- | --- | --- |
| first-active-8 (256) | ladder settings, 2 hidden layers of 64 | 2,560 | 230, 205, 188 | 83, 73, 69 of 102 | - |
| first-active-8 | 4 hidden layers of 32 | 2,560 | 210, 230, 201 | 75, 88, 78 of 102 | 208, 241, 209 |
| first-active-8 | shared, doubling wiring, 3 hidden layers of 64 | 448 | 225, 209, 129 | 94, 79, 54 of 102 | 193, 209, 129 |
| tab-4 (160) | shared, 3 hidden layers of 32 | 448 | 78, 91, 66 | 36, 34, 24 of 64 | - |
| tab-6 (896) | shared, 3 hidden layers of 48 | 448 | 314, 102, 172 | 124, 42, 63 of 358 | - |
| tab-6 | ladder settings | 6,912 | 402, 317, 359 | 145, 107, 118 of 358 | - |
| tab-8 (4,608) | ladder settings | 10,240 | 929, 822, 1,152 | 339, 338, 446 of 1,843 | - |
| tab-12 (106,496) | ladder settings | 17,920 | 11,549, 9,386, 3,103 | 4,542, 3,709, 1,273 of 42,598 | - |

- No gate network with covering wiring learned its task exactly. On first-active-8, trained on every case with learning rates 0.02, 0.05, 0.1, and 0.2 and 2,000 or 10,000 steps, 4 hidden layers of 32 gates got 193 to 241 of 256 and shared gates with doubling wiring got 95 to 225. Counting units at the same 2,560 logits learned first-active-8 exactly in all three seeds when trained on every case, and one shared counting unit (143 logits) did from 60% of the cases in 1 of 3 seeds.
- Where the redraws changed the ladder's gate wiring, results moved a little in either direction (e.g. tab-12 seed 1 from 9,754 to 11,549, tab-8 seed 3 from 817 to 1,152, first-active-8 seed 3 from 195 to 188) and stayed below counting networks on every rung, e.g. tab-12: 3,103 to 11,549 against 78,982 to 81,292.
- Shared gates with covering wiring got 66 to 91 of 160 on tab-4 and 102 to 314 of 896 on tab-6, against 117 to 146 and 807 to 849 for shared counting units.
- The ladder's menu-slot gate wiring still missed needed inputs after 200 redraws (3, 2, 2 of 16 output bits covered), so at that depth no gate network can be exact on the menu slot.

### What the learned networks are made of

- Counting networks mostly learned "one wire and none of k others" and small count differences such as "2 positive, 2 negative, t = 1". The first shape is the shape of "enabled, and no enabled control in between". In tab-8 seed 1, the most common live units were "one wire and none of 3" (21 units), "2 positive, 2 negative, t = 1" (20), and "one wire and none of 1" (18).
- Gate networks spend many live gates passing one wire through: in tab-8 seed 1, 71 of 313 live gates are "a" and 40 are "b", so 111 pass one wire through; "a and not b" is next (33).
- Units that compute a named intermediate over every case are rare (`inspect.ts` compares every live unit's values over every case with the predicates in `tasks.ts` and their complements; raw input bits and constant predicates are left out below). In the base counting networks for first-active-8, units compute first[1] through first[5] exactly in all three seeds. On Tab, no ladder network of either unit type has a unit computing "the first enabled control after the focus" or a Tab output (variant runs weren't inspected). Gate networks on tab-4 and tab-6 have small ANDs, e.g. "first enabled overall = [1]" (enabled[1] and not enabled[0]) and "enabled[1] and focus before it" (enabled[1] and focus[0]); counting networks matched one such predicate in one run ("enabled[2] and focus before it", tab-4 seed 3). The matches listed as "enabled[0] and focus before it" in `report-output.json` are constant 0 units, because nothing comes before control 0. On rectangle-hit, the matches "top 1 bits of x > top 1 bits of 9" (gates in all three seeds, counting units in seeds 1 and 2) and "top 1 bits of y > top 1 bits of 22" (gates) are only the raw top bits x.bit5 and y.bit5 under another name. The one real intermediate is in the counting network of seed 3: "the top 2 bits of x equal the top 2 bits of 46", a carry-lookahead intermediate. No network has a full comparison such as x > 9. In click-or-drag seed 1, 112 of the counting network's 128 live units are "or over 8", i.e. copies of a drag detector that never learned where clicks are.
- The shared first-active-8 unit of seed 1 is `-x[p-7] -x[p-6] -x[p-5] -x[p-4] -x[p-3] -x[p-2] -x[p-1] +x[p] +x[p+6] +not x[p-1] -not x[p] +not x[p+6] >= 2`. That isn't the textbook `x[p] - Σ x[p-d] >= 1`. `+x[p+6] +not x[p+6]` is 1 at positions 0 and 1 and 0 elsewhere, because reads past the end are the constant 0, and `+not x[p-1]` is 0 at position 0 for the same reason. So the learned rule uses the padding as its boundary signal instead of the marker. It compiles to 12 live operations and 2 layers, against 7 and 1 for the authored rule, because `countingBit`'s range check treats `x[p+6]` and `not x[p+6]` as independent bits and keeps both ReLUs.

## How far this goes

### What fit well

- **Hardening and certification.** A hardened network is plain integer arithmetic, so every run was checked on every case of its task, up to 106,496 cases for tab-12, and compiled into a circuit that agreed with the JS netlist on every case. Nothing about compiling learned bits needed new runtime pieces.
- **The counting unit as a unit of behavior.** Counting units beat gates at equal logit counts on 7 of 8 rungs, by a wide margin on Tab and the menu slot, and they're the only unit type that learned any rung exactly. Part of the ladder's gap is wiring: at the same depth, gate wiring missed needed inputs on 5 of 8 rungs in some seeds. With the gate wiring redrawn until every output bit could read every input it needs, gates still didn't learn first-active-8 with any learning rate or step count tried (at most 241 of 256 when trained on every case), and stayed below counting units on every Tab rung, far below from 6 controls up. The shapes they learn ("one wire and none of k", small count differences) are the shapes of authored decisions in this runtime, and each compiles to one or two ReLU rows.
- **Authored counting bits.** Writing input's Tab through `countingBit` with range peepholes gave 68 live operations and 6 layers at 6 controls instead of 127 and 7, and 146 instead of 253 at 12 controls, with the same exact results.
- **Sharing.** Running one learned unit at every position is the only setting that learned a rung exactly from part of its cases: first-active-8 from 60% of the cases with 143 logits, in 1 of 3 seeds for each relaxation (the other seeds got 254 of 256). It also gave the best held-out results on tab-4 (55 of 64, seed 1) and tab-6 (316 to 330 of 358, against 220 to 253 without sharing), and the only exact tab-4 network (trained on every case, 1 of 3 seeds). It didn't help on tab-8 and tab-12, where the shared runs used minibatches and fewer logits and got fewer cases right than the unshared ladder.

### What got awkward

- **Learning a rule, not a table.** At the base settings nothing was learned exactly, and held-out cases stayed well below training cases, e.g. the tab-6 counting network of seed 1 got 473 of 538 training cases (88%) and 249 of 358 held-out cases (70%). The networks memorize cases instead of finding "the first enabled control after the focus".
- **Wiring is the search problem.** A counting unit with 8 random candidates rarely sees the right wires: Tab needs a unit to read about N wires at once, e.g. "enabled[k] and focus[j] and none of the enabled controls between". Prefix wiring and reading every earlier layer helped a little (tab-4: 118 to 140 cases against 115 to 121), and giving a shared unit every relative reference helped most. Gates have a sharper version of the same problem: with 2 wires per unit, the ladder's gate wiring missed needed inputs on first-active-8, tab-6, tab-8, tab-12, and menu-slot in some seeds, and shared gates with 2 random references per channel reached every needed input for 0 of 8 first-active-8 output bits.
- **Arithmetic over bits.** rectangle-hit and click-or-drag are 9 and 11 operations as integer arithmetic, but at the level of bits a comparison against a constant is a carry chain, and no learned network found a full one. Weights in {-1, 0, +1} can't express `Σ 2^k bit_k` directly.
- **Training cost.** The expectation relaxation costs about C² multiplications per unit per case, so counting networks trained about 30 to 65 times slower than gate networks with the same logits. The normal relaxation costs about C + 8, which is what made reading 24 candidates, or every relative reference, affordable.
- **The relaxation and its initialization decide whether anything trains.** From the base initialization, the clamp relaxation had exactly zero gradient. With a stronger initial bias toward t = 1, it trained but still trailed the expectation relaxation at the same initialization (tab-4: 80 to 111 cases against 118 to 129). Annealing the temperature from 1 to 0.1 lowered the counting units' counts on tab-4 and first-active-8 and left gates about where they were. The normal relaxation's variance floor is a second temperature that wasn't tuned.
- **Exact learned circuits are bigger.** Every exact learned network compiled to more operations than the authored construction: 71 to 89 live operations for the unshared first-active-8 networks trained on every case and 12 for the shared unit, against 7; 133 against 40 for tab-4. Inexact networks that collapsed to a few units can compile smaller, e.g. the clamp networks on tab-4 (6 to 8 operations), shared gates on first-active-8 (1 or 2), and the shared counting networks on tab-8 and tab-12 (56 and 84, against 94 and 146).

### What stayed outside the circuit

- Choosing the input encoding: one-hot focus, two's complement deltas, and for the menu slot the region bits that geometry would compute.
- Enumerating the oracle over every case, and the training loop itself (JS, float64, Adam).
- The layout of the menu bar, fixed at build time; with state-dependent enabled items, the case count would multiply by the enabled masks.

## How it connects to the talk

The talk suggests wiring individual 1s and 0s to each other and making the wiring learned. This folder did that for UI rules, with two candidate "smallest units": the classic 2-input gate, and a count of up to 8 bits against a threshold, which is the form most exact decisions written in this runtime tonight already take, e.g. input's Tab and menus.

In plain terms: the smaller unit (2-input gates) was harder to direct than the slightly larger one (counting units). Neither unit learned a rule from part of its cases until the network was made homogeneous, i.e. one small program applied at every position, the way a shader is one function applied at every pixel. Then one counting unit learned "the first set bit" from 60% of the cases in one of three seeds, and Tab got closer but wasn't learned from part of its cases. That matches the talk's pairing of homogeneity with a uniform way of directing: one set of logits directs every position at once, and one training case teaches every position. Shared gates with 2 random references per channel did worse (at most 128 of 256 cases on first-active-8), but their wiring couldn't reach the inputs first-active-8 needs, so those runs don't say anything about the unit type. Shared gates with doubling wiring, and deeper unshared gates at the ladder's logits, both with wiring that reaches every needed input, got at most 241 of 256 across learning rates and step counts, even trained on every case. So in these runs the unit type mattered as well as homogeneity, with the caveat that gates got random or doubling wiring, not the exact templates of a hand-built prefix circuit.

The granularity gap showed up too. The learned first-active rule isn't the rule a person writes: it detects the edges of the row of bits through reads past the end, instead of through the marker it was given. It's correct on every case, and it's not recognizable at first sight.

## Open questions and next steps

- Can Tab be learned exactly from part of the cases? Not here: the best 60/40 tab-4 run got 146 of 160 cases (55 of 64 held out), and the only exact tab-4 network was trained on every case (5 shared layers, zero padding, 1 of 3 seeds). More seeds, longer training, or a search over the few shared templates might get there.
- Tab has a parallel prefix structure: "some enabled control in the last 2^k positions" composes in log N layers. A shared network whose references are the prefix offsets p - 1, p - 2, p - 4, ... at every layer might learn it at any N and transfer from tab-4 to tab-12 with the same logits.
- Would gates learn first-active-8 from the exact templates of a prefix circuit, i.e. is the remaining gap in the wiring draw or in the gate relaxation's training? Doubling wiring fixes the offsets but still draws which channels a gate reads.
- The menu slot's outputs each depend on many inputs, so a gate network needs more depth before its wiring can reach them; a coverage check could choose the depth before training.
- Discrete search instead of gradients: for a shared program with one or two units, the number of templates is small enough to search exhaustively, or to hand to an ILP or SAT solver with every case as a constraint.
- Weights that can be powers of two, or a per-position constant source (the bits of a rectangle's edges, like uniforms per instance), would let a shared program compare coordinates at the bit level.
- A straight-through phase (hard units forward, relaxed gradients backward) might close the last few cases, e.g. tab-4 trained on every case stopped 4 to 8 cases short.
- A learned shared program could be emitted through codegen's instance axis as one per-position row set, instead of being unrolled once per position as here.
- Bit-sliced certification (32 cases per `Uint32` operation) wasn't built; plain integer evaluation was fast enough up to 106,496 cases.

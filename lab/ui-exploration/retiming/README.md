# Retiming: one-frame delays chosen by search

## What it is and how to run it

Every prototype tonight required each output of a frame to be consistent with that frame's inputs. That requirement ties "one frame" to "circuit depth": a value computed at layer 150 has to wait for everything under it. Hardware separates the two with registers: a register holds a value from the previous clock tick, so the logic after it doesn't wait for the logic before it, and retiming moves registers along a circuit to shorten its longest path. This folder asks the UI version of that question: if some values in a compiled UI circuit read last frame's value instead of this frame's, how much depth disappears, how much of that is visible, and does a search find the cuts people picked by hand tonight (Photos reading its window size from the previous frame, layout-tree's app shell reading its sidebar spring from the previous frame)?

It works on flattened compiled programs, so no builder changes are needed. A cut on a value makes every row that reads the value read a register cell instead, holding the value from the previous evaluation. Depth is recomputed as the longest chain of rows from sources, with registers counting as sources. Each candidate cut set is replayed closed loop over interaction traces and compared with the same program without cuts: geometry in px, opacity, and decisions that must stay exact bits.

Run from the repo root:

- `bun test lab/ui-exploration/retiming` runs 11 tests in about 2 seconds.
- `bunx tsgo -p lab/ui-exploration/retiming` typechecks the folder.
- `bun lab/ui-exploration/retiming/report.ts` runs every measurement below and writes `results.json`. One section at a time: `report.ts indirect-os` (about 1.5 minutes), `app-shell` (about 20 s), `hn-thread` (about 3.5 minutes), `gallery` (about 1 minute). Each section replaces its own entry in `results.json` and prints markdown tables.

The folder imports `numeric-ui-core.ts` unchanged (and the production `window-manager.ts` in one test). The workloads are copies in `copies/`: spring-bank's IndirectOS copy (`window-manager.ts`, `photo-gallery.ts`, `spring-bank.ts`, `spring-math.ts`, `trace.ts`), layout-tree's app shell and builder, the gallery circuit, app and native reference (which reads the frozen fixture in `lab/trace-compiler/fixtures`), and hn-thread's circuit, prepare step, pretext snapshot and differential script. The copies differ from the originals in four ways: the `numeric-ui-core.ts` imports and the gallery's fixture path are two directories deeper, `writeBankFrame` is exported, and the gallery app takes an injected machine plus a guard against a focused index out of range (a retimed circuit produced one, and the original JS threw).

Update, September 15, 2026: spring-bank's `window-manager.ts` now exports `writeBankFrame`, `validateWindowManagerSource` and `validateWindowManagerOutput`, and its `photo-gallery.ts` now exports `photoNames`, so that event-time can import these names. The copies here weren't changed and export only `writeBankFrame`. Exporting `writeBankFrame` is therefore no longer a difference, and the copies now differ by not exporting `validateWindowManagerSource`, `validateWindowManagerOutput` and `photoNames`.

## What was built

- `flat.ts`: the compiled program as one list of rows in execution order (codegen's `flattenProgram`, packed into typed arrays), an FP32 evaluator with registers, the dependency graph, depth and height analysis, critical levels, and a minimum vertex cut by max flow.
  - A cut delays what the circuit computes from a value, not what the host sees: outputs and next-source write-backs still read the value itself, and the value is still computed every evaluation because the register needs it. The first evaluation fills the registers from an evaluation without cuts on the same source table, i.e. it assumes the previous frame showed the same inputs.
  - The evaluator matches the shared executor bit for bit on every live wire of IndirectOS, the app shell, hn-thread and the gallery (tested at a few frames of each).
  - Longest chain against compiled layers: IndirectOS 191 against 192, bank IndirectOS 136 against 137, app shell 115 against 115, hn-thread 67 against 69, gallery 60 against 61. The compiler's layer count keeps the depth of masked products that gather lowering removed; the chain counts a gather read as one row. All layer counts below are chains, except rows marked as compiled variants.
- `retime.ts`: the measurement and the search.
  - A model lists what's visible: px geometry with visibility conditions (e.g. a photo counts only while it and the Photos window have opacity above 0, in the reference or the retimed frame), scale converted to px as |Δscale| × size / 2, opacity, and decisions (bits and integers, any difference is a mismatch).
  - Some outputs are integers at rest but fractional during animations, e.g. the original IndirectOS's `animationActive` (a clamp) and a window's `stack` (its rank plus 40 × its animation weight). In a frame where the reference or the retimed value of such an output is an integer and the two differ, that's a decision mismatch, e.g. a retimed `stack` of 44 where the reference has 4 draws Photos above the other windows, and a retimed `animationActive` of 1 where the reference has 0 renders a frame the reference doesn't need. When both values are fractional, the largest difference is reported (`max unitless` in `results.json`) but not budgeted. With the bank springs, these outputs are exact bits and integers, so they're plain decisions. A first version of this prototype never budgeted these outputs, and its original-springs searches accepted cut sets that changed the window draw order; every number below uses the rule above.
  - `replay` runs a trace closed loop, so a cut's effect compounds over frames, and stops at the first frame over budget. The budget is 1 px, 0.02 opacity, and 0 decision mismatches.
  - `greedySearch`: at each step, generate candidate cut sets that shorten the longest chain, replay each on every searched trace, and keep the one that removes the most layers per px of error among those within budget. An error below 0.01 px counts as 0.01 px. It stops when no candidate is within budget, and replays the rejected candidates that removed the most layers to show what would come next.
  - Strategy 1, critical values at one depth: every longest chain passes through exactly one critical value at each depth, so the critical values at one depth form a cut set. A depth with one critical value is a single value on every longest chain; a depth with a few is that value plus its neighbors on parallel chains. Up to 8 values.
  - Strategy 2, minimum cuts: for target depths from D - 1 down to D / 2, the smallest set of values whose cuts bring every chain to the target, found by max flow. Capacities are either 1 per value (fewest registers) or 1 plus the number of frames in which the value changed (fewest changing registers). These cut sets can separate a whole subcircuit, e.g. the inputs of an inlined child app. Up to 64 registers (256 for hn-thread and the gallery).
  - `describeValue` names a value by the source cells nearest in its upstream cone and the outputs its downstream cone reaches.
- `indirect-os.ts`: IndirectOS with the original springs and with the bank springs (split-table, deferred retargeting). Traces: codegen's 240-frame session, spring-bank's live resize trace at 60 and 10 fps, a browser resize trace, and random interactions adapted from notation's `randomFrame` (clicks on title bar buttons and dock items, drags and resizes that may continue over frames, photo clicks, next, previous and close, frame durations of 1 to 41 ms, viewport steps of up to 60 px). The hand-chosen cut as registers: Photos' content width, content height and window opacity. A model option, `keepRenderingMayLag`, leaves the outputs that only decide whether to render another frame out of the metric, so a cut may make them a frame late.
- `app-shell.ts`: layout-tree's app shell. Traces: layout-tree report's 2,061 frames (every 80 px from 320 to 2,400 px, scroll requests, two sidebar toggles), a smooth resize with toggles, and random sessions with seeds 1 to 10 (width drags at up to 24 px per frame, scroll requests, menu presses, frame durations of 1/120 to 1/30 s).
- `hn-thread.ts`: hn-thread's 251 comments with 48 rank slots. Traces: the differential's scripted session at 900, 600 and 1,800 frames, and random sessions with seeds 1 to 3 (width drags at up to 12 px per frame, scroll and pointer random walks, held presses, a banner click on a random visible comment about every 30 frames).
- `gallery.ts`: the 221-photo gallery. Traces: the differential's six random traces with dyadic frame durations (seeds 5000 to 5005), generated again against the native `index.ts` and replayed through the gallery app's JS, plus seeds 6000 to 6005 on the same six viewports.
- Events that aim at on-screen targets (random IndirectOS interactions, hn-thread sessions) are computed once from the program without cuts, so every retimed run gets the same events.
- `report.ts`, `retiming.test.ts`, `results.json`.

## Measured results

Counts are exact. Search times are rough (other agents share the machine); a replay of IndirectOS's 240-frame session takes about 5 to 10 ms in the interpreter, a replay of hn-thread's 900-frame session about 250 ms.

### Programs

| Program | Live ops | Compiled layers | Longest chain | Stored weights |
| --- | ---: | ---: | ---: | ---: |
| IndirectOS, original springs | 5,253 | 192 | 191 | 11,598 |
| IndirectOS, bank springs | 3,580 | 137 | 136 | 8,447 |
| app shell | 2,806 | 115 | 115 | 7,451 |
| hn thread, 48 rank slots | 53,703 | 69 | 67 | 218,170 |
| gallery | 48,411 | 61 | 60 | 174,708 |

A cut set adds registers, not operations: k registers are k more source cells and k copies per frame.

### The hand-chosen cuts

Each hand-chosen cut was replayed as registers on the flattened program and as the compiled variant built by hand, and every recorded output of the two runs was compared (`registersAgainstCompiled` in `results.json`). The app shell's spring register gives exactly the outputs of layout-tree's compiled variant on 10 of its 12 traces. The report frames and random seed 8 differ in frame 0 only, e.g. by up to 60 px in seed 8, which presses the menu in frame 0: in its first evaluation the register holds this frame's spring position, i.e. the evaluator assumes the previous frame showed the same inputs, while the compiled variant reads the initial spring cell. For IndirectOS, registers on Photos' content width, content height and opacity give exactly the outputs of the compiled "Photos reads previous frame" variant on 17 of the 20 traces (both spring models, 10 traces each), every recorded output compared. The other 3 differ in a few frames: random seed 3 with the original springs in 17 frames by up to 34.9 px (`nextControl.left`), and with the bank springs seed 2 in 8 frames by up to 34.0 px and seed 4 in 2 frames by up to 2.8 px. The two read different values. The compiled variant reads last frame's spring state cell, while the registers read last frame's content width, which is clamped to the viewport. In random seed 3, frame 244 shrinks the viewport from 1,069 to 1,018 px while Photos is 1,060 px wide: the window's rendered width clamps to 1,018 at once, and its spring state follows over 16 frames, so the registers hold 1,016 while the compiled variant reads 1,051, 1,045, and so on. The largest px error against the reference and the mismatch counts are still the same on all 20 traces, because the largest errors happen elsewhere.

| Cut | Layers | Trace | Largest px error | Decision mismatches |
| --- | ---: | --- | ---: | ---: |
| IndirectOS original springs: Photos reads last frame's content size and opacity (compiled variant: 118 compiled layers) | 116 | codegen session | 88.9 (photos[3].left, during maximize or restore) | 0 |
| | | live resize at 60 fps, browser resize | 88.9 | 1: `animationActive` a frame late |
| | | live resize at 10 fps | 161.2 | 2 |
| | | random interactions, seeds 1 to 6 | 0 to 1,128, opacity differences of 1 | 0 on 5 seeds, 42 on seed 4 |
| IndirectOS bank springs: the same registers (compiled variant: 91 compiled layers) | 89 | codegen session, browser resize | 85.7 | 0 |
| | | live resize at 60 fps | 85.7 | 2, in 1 frame: `animationActive` and the clock's running bit a frame late |
| | | live resize at 10 fps | 413.0 | 2, in 1 frame |
| | | random interactions | 0 to 996 | 0 on 5 seeds, 36 on seed 4 |
| IndirectOS bank springs: compiled, Photos reads this frame's stepped springs | 91 compiled | codegen session, browser resize | 0 | 0 |
| | | live resize at 60 fps | 6.67 | 2, in 1 frame |
| | | live resize at 10 fps | 33.3 | 2, in 1 frame |
| app shell: layout reads last frame's sidebar spring position (compiled variant: 83 layers) | 83 | report frames | 1,380 (card13.y) | 116 in 41 frames, e.g. caption line counts |
| | | smooth resize and toggles | 1,380 | 65 in 17 frames |
| | | random sessions, seeds 1 to 10 | 72.6 to 1,434 | 16 to 144 |

These numbers reproduce spring-bank's (85.7 px reading the previous frame, 6.6 px reading stepped springs), and add two things. The error scales with how far a value moves in one frame: 88.9 px at 60 fps becomes 161 px at 10 fps with the original springs, and 85.7 px becomes 413 px with the bank springs. And the app shell's spring cut, whose visible cost layout-tree's README left unmeasured, is 1,380 px with line count mismatches whenever the sidebar animates.

Every hand-chosen cut is far over a 1 px budget, so the brief's stop rule never accepts one.

### IndirectOS, original springs (191 layers)

"Searched" is the worst among the traces the search replayed; "held out" is the worst among the others. "Never changed" counts registers whose value didn't change in any frame of the searched traces, where their error is 0 by construction.

| Searched on | Strategy | Layers | Registers | Searched: px | Held out: px, mismatches | Never changed |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| codegen session | critical values | 135 | 51 | 0.0065 | live resize 100 px, 47 mismatches; browser resize 6.0 px, 13 mismatches, e.g. Photos drawn below the other windows (a retimed `stack` of 4 where the reference has 44); random 423 to 1,011 px, 1,485 to 8,306 mismatches | 34 |
| codegen session | minimum cuts | 146 | 13 | 0 | live resize 100 px, 47 mismatches; random 423 to 1,128 px, 471 to 8,399 mismatches | 13 |
| the 4 scripted traces | critical values | 142 | 62 | 0 | random 469 to 1,128 px, 37 to 945 mismatches | 32 |
| the 4 scripted traces | minimum cuts | 144 | 25 | 0 | random 423 to 1,128 px, 7 to 772 mismatches | 25 |
| scripted and random seeds 1 to 3 | critical values | 178 | 8 | 0 | seed 4: 469 px, 6 mismatches in 1 frame; seeds 5 and 6: 0 px, 0 mismatches | 5 |
| scripted and random seeds 1 to 3 | minimum cuts | 178 | 8 | 0 | seed 4: 1,128 px, 42 mismatches; seeds 5 and 6: 0 px, 0 mismatches | 8 |

Then the search continues with no px budget, from the critical-values cut set of the scripted search (142 layers, 62 registers) or of the scripted-and-random search (178 layers, 8 registers); both strategies start from that same set. Decisions either stay exact, or `animationActive`, which the host reads only to decide whether to request another frame, may be a frame late (the model leaves it out, `keepRenderingMayLag` in `indirect-os.ts`). "Hand-chosen" lists which of the three hand-chosen registers (content width, content height, opacity) the final set holds.

| Searched on | Decisions | Strategy | Layers | Registers | Hand-chosen | Searched: px | Held out: px, mismatches |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| the 4 scripted traces | exact | critical values | 132 | 65 | none | 88.9 at 60 fps, 161 at 10 fps | random 469 to 1,128 px, 37 to 945 mismatches |
| the 4 scripted traces | exact | minimum cuts | 142 | 62 | none, no step within budget | | |
| the 4 scripted traces | `animationActive` may lag | critical values | 83 | 107 | content width and height | 105 at 60 fps, 166 at 10 fps | random 716 to 1,164 px, 3,670 to 6,887 mismatches |
| the 4 scripted traces | `animationActive` may lag | minimum cuts | 142 | 62 | none, no step within budget | | |
| scripted and random seeds 1 to 3 | exact | critical values | 171 | 12 | opacity | 1.4 at 60 fps, 3.5 at 10 fps, 34.9 on random | seed 4: 469 px, 6 mismatches; seeds 5 and 6: 0 px, 0 mismatches |
| scripted and random seeds 1 to 3 | exact | minimum cuts | 178 | 8 | none, no step within budget | | |
| scripted and random seeds 1 to 3 | `animationActive` may lag | critical values | 102 | 17 | all 3 | 88.9 at 60 fps, 161 at 10 fps, 325 on random | seed 4: 1,128 px, 48 mismatches; seeds 5 and 6: 0 and 280 px, 0 mismatches |
| scripted and random seeds 1 to 3 | `animationActive` may lag | minimum cuts | 102 | 12 | opacity | 118 at 60 fps, 215 at 10 fps, 434 on random | seed 4: 1,128 px, 48 mismatches; seeds 5 and 6: 0 and 373 px, 0 mismatches |

The curve of the scripted-and-random critical-values search with `animationActive` allowed to lag, layers against the largest px error:

| Layers | 178 | 175 | 173 | 172 | 171 | 167 | 165 | 103 | 102 | next: 98 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Largest px error | 0 | 9.5 | 19.6 | 34.9 | 34.9 | 35.7 | 35.7 | 325.2 | 325.2 | 423, with 15 mismatches |
| Registers added | | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | |
| What the registers belong to | the maximized window rectangle, Photos' focus decoding | Photos' thumbnail strip geometry | Photos' thumbnail layout | the Photos window's width | Photos presence: hand-chosen | Photos' layout from the window's width | the Photos window's height | Photos' viewport width and height: hand-chosen | frontmost window bits, which never changed in any trace | |

With exact decisions, no search picks Photos' content width and height. After two of the searches, the candidate that would come next is exactly that pair: after the codegen-session search it's rejected for 88.9 px, and after the scripted search for `animationActive` a frame late (4 mismatches over the scripted traces, 161 px). Once `animationActive` may lag, both critical-values continuations take the pair: on the scripted traces alone (142 to 107 layers in one step, at 161 px), and with random interactions (165 to 103 layers, at 325 px). So random interactions aren't needed to find the pair. What they change is the rest of the set: 17 registers including presence, against 107 registers that break on every random trace with thousands of mismatches. The minimum-cut continuations with random interactions reach the same 102 layers through registers on the window's size instead of the content size, at more px. Whether the search picks the hand-chosen cut therefore depends on how `animationActive` is classified: the first version of this prototype didn't count it with the original springs, and its exact-decisions search picked the pair too.

### IndirectOS, bank springs (136 layers)

| Searched on | Strategy | Layers | Registers | Searched: px | Held out: px, mismatches | Never changed |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| live resize at 60 fps | critical values | 84 | 49 | 0 | codegen session 474 px, 320 mismatches in 50 frames; random 7,020 to 7,883 mismatches | 23 |
| live resize at 60 fps | minimum cuts | 82 | 26 | 0 | codegen session 474 px, 320 mismatches; random 6,996 to 7,885 mismatches | 24 |
| the 4 scripted traces | critical values | 92 | 49 | 0 | random 41 to 3,081 mismatches | 22 |
| the 4 scripted traces | minimum cuts | 89 | 25 | 0 | random 6 to 465 mismatches | 25 |
| scripted and random seeds 1 to 3 | critical values | 123 | 8 | 0 | seeds 4 to 6: 0 px, 0 mismatches | 5 |
| scripted and random seeds 1 to 3 | minimum cuts | 123 | 8 | 0 | seed 4: 996 px, 33 mismatches; seeds 5 and 6: 0 px, 0 mismatches | 8 |

The continuations with no px budget, as for the original springs. With the bank springs, the keep-rendering outputs are `animationActive` and the clock's running bit.

| Searched on | Decisions | Strategy | Layers | Registers | Hand-chosen | Searched: px | Held out: px, mismatches |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| the 4 scripted traces | exact | critical values | 74 | 70 | none | 85.7 at 60 fps, 413 at 10 fps | random 469 to 1,021 px, 860 to 6,408 mismatches |
| the 4 scripted traces | exact | minimum cuts | 83 | 63 | none | 0 | random 469 to 1,013 px, 47 to 3,114 mismatches |
| the 4 scripted traces | keep-rendering outputs may lag | critical values | 49 | 112 | content width and height | 165 at 60 fps, 551 at 10 fps | random 952 to 1,416 px, 3,463 to 6,060 mismatches |
| the 4 scripted traces | keep-rendering outputs may lag | minimum cuts | 83 | 63 | none | 0 | random 469 to 1,013 px, 47 to 3,114 mismatches |
| scripted and random seeds 1 to 3 | exact | critical values | 114 | 13 | none | 1.4 at 60 fps, 7.0 at 10 fps, 112 on random | seeds 4 to 6: at most 19.8 px, 0 mismatches |
| scripted and random seeds 1 to 3 | exact | minimum cuts | 123 | 8 | none, no step within budget | | |
| scripted and random seeds 1 to 3 | keep-rendering outputs may lag | critical values | 75 | 18 | all 3 | 85.7 at 60 fps, 413 at 10 fps, 294 on random | seed 4: 996 px, 36 mismatches; seeds 5 and 6: 0 and 287 px, 0 mismatches |
| scripted and random seeds 1 to 3 | keep-rendering outputs may lag | minimum cuts | 75 | 12 | opacity | 114 at 60 fps, 551 at 10 fps, 320 on random | seed 4: 996 px, 36 mismatches; seeds 5 and 6: 0 and 383 px, 0 mismatches |

The exact-decisions curve from 123 layers: 120 at 7.0 px (Photos' thumbnail strip geometry), 118 at 11.8 px (thumbnail layout), 116 at 34.0 px (the Photos window's stepped width), 114 at 112 px (the live resize rectangle of the Photos window), then 102 layers at 469 px with 36 mismatches. After the scripted-and-random search, the candidate that would come next is the hand-chosen pair (108 layers at 413 px), rejected for `animationActive` and the clock's running bit a frame late.

The curve with the keep-rendering outputs allowed to lag:

| Layers | 123 | 120 | 112 | 110 | 108 | 106 | 76 | 75 | next: 70 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Largest px error | 0 | 7.0 | 35.7 | 35.7 | 161.9 | 413.0 | 413.0 | 413.0 | 423, with 24 mismatches |
| Registers added | | 1 | 1 | 2 | 2 | 2 | 1 | 1 | |
| What the registers belong to | the maximized window rectangle, Photos' focus decoding | Photos' thumbnail strip geometry | Photos' thumbnail layout | the Photos window's stepped width and height | the live resize rectangle of the Photos window | Photos' viewport width and height: hand-chosen | Photos presence: hand-chosen | frontmost window bits, which never changed in any trace | |

Here presence carries most of the depth: content width and height remove 2 layers (108 to 106) and presence 30 more (106 to 76). The hand-chosen cut behaves the same way on its own: content width and height alone take the bank IndirectOS from 136 to 121 layers, opacity alone removes nothing, and all three take it to 89 (with the original springs: 185, 191 and 116). On the scripted traces alone, exact decisions still reach 74 layers at 413 px without any hand-chosen register, through values inside Photos that read the window's spring state, and that set breaks on every random trace.

### app shell (115 layers)

The traces are the report frames, the smooth resize, and random sessions with seeds 1 to 10. Every trace not searched is held out.

| Searched on | Strategy | Layers | Registers | Held-out traces with errors | Never changed in any trace | Next, over budget |
| --- | --- | ---: | ---: | --- | ---: | --- |
| report frames | critical values | 78 | 16 | seeds 1 to 3: 2 to 3 mismatches, the sidebar spring's `active` flag (at most 0.055 px); seeds 7 and 8: 303.5 px, tag 4 on the wrong line (3 and 2 mismatches) | 8 | 72 layers: 20 px, 16 mismatches |
| report frames | minimum cuts | 80 | 9 | seeds 7 and 8: 303.5 px, tag 4 on the wrong line | 8 | 74 layers: 220 px, 3 mismatches |
| report frames and random seed 1 | critical values | 80 | 15 | seeds 7 and 8: the same | 8 | 74 layers: 1,380 px, 73 mismatches |
| report frames and random seed 1 | minimum cuts | 80 | 9 | seeds 7 and 8: the same | 8 | 74 layers: 220 px, 3 mismatches |
| report frames and random seeds 1 to 4 | critical values | 80 | 15 | seeds 7 and 8: the same | 8 | 74 layers: 1,380 px, 158 mismatches |
| report frames and random seeds 1 to 4 | minimum cuts | 80 | 9 | seeds 7 and 8: the same | 8 | 74 layers: 220 px, 3 mismatches |

Every other held-out trace (the smooth resize, seeds 5, 6, 9 and 10, and seeds 2 to 4 when not searched) gives 0 px and 0 mismatches. The two searches with random seeds found the same cut sets as each other.

The registers sit on the tag row: its wrap scan (pass 2, level 3), the tags' line heights (pass 4, level 3), the body row's height (passes 4 and 5, level 1), and, in the first search, one value inside the sidebar spring. Half of them compute from text tables only, e.g. running sums of tag widths, which never change while the text doesn't. Replaying each register alone on all 12 traces shows what the others do:

- In the 15-register set, 6 registers change (in 66 to 2,930 frames over the 12 traces) and move nothing on any trace, e.g. the body row's height (pass 4, level 1), which doesn't matter while the scroll container's content overflows, as layout-tree's README already noticed.
- The 7th, a running sum over the widths of tags 3 and 4 in the wrap scan, puts tag 4 on the next line a frame late on seeds 7 and 8, e.g. frame 267 of seed 7 has `tags.line[4]` 0 where the reference has 1. On those two seeds the window narrows through about 395 px at 24 px per frame, which is where tag 4 wraps. The minimum-cut set has a register at the same place, which changed in only 4 frames of the 12 traces, all on seeds 7 and 8.
- In the first search, the register inside the sidebar spring turns the spring's `active` flag off a frame early on seeds 1 to 3 (0 where the reference is 1 or 0.15), with at most 0.055 px. Searching with random seed 1 leaves that register out.

So no app shell cut set holds on every held-out trace. With random sessions in the search, the only failures left are seeds 7 and 8, where one register delays a real layout decision that only a narrowing through one particular width band exercises.

### hn thread (67 layers)

| Searched on | Strategy | Layers | Registers | Scripted sessions at 900, 600 and 1,800 frames | Random session seed 1 | Random session seed 2 | Random session seed 3 |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| 900-frame session | critical values | 50 | 19 | 0 px, 0 mismatches | held out: 607 px, 266 mismatches in 29 frames | held out: 6,384 px, 57,598 mismatches in 651 frames | held out: 680 px, 113 mismatches in 21 frames |
| 900-frame session | minimum cuts | 52 | 12 | 0 px, 0 mismatches | held out: 0 px, 4 mismatches in 2 frames | held out: 667 px, 51 mismatches in 8 frames | held out: 12.4 px, 36 mismatches in 12 frames |
| 900-frame session and random seed 1 | critical values | 52 | 13 | 0 px, 0 mismatches | searched: 0 px, 0 mismatches | held out: 667 px, 43 mismatches in 5 frames | held out: 12.4 px, 39 mismatches in 9 frames |
| 900-frame session and random seed 1 | minimum cuts | 58 | 2 | 0 px, 0 mismatches | searched: 0 px, 0 mismatches | held out: 0 px, 0 mismatches | held out: 0 px, 0 mismatches |
| the three scripted sessions and random seeds 1 and 2 | critical values | 57 | 5 | searched: 0 px, 0 mismatches | searched: 0 px, 0 mismatches | searched: 0 px, 0 mismatches | held out: 0 px, 0 mismatches |
| the three scripted sessions and random seeds 1 and 2 | minimum cuts | 58 | 2 | searched: 0 px, 0 mismatches | searched: 0 px, 0 mismatches | searched: 0 px, 0 mismatches | held out: 0 px, 0 mismatches |

In the first four rows, only the 900-frame session is searched among the scripted sessions. The candidates rejected after each search would remove 1 or 2 more layers, with 10 to 153 mismatches and up to 680 px, e.g. slots' comment heights while rows appear. The exception is the five-trace critical-values search, whose next candidate removes 1 layer at 36.1 px (`slots[0].commentTop`) with no mismatches.

Most registers sit in the Brent-Kung scan of natural heights; the rest are in the gutter peek and the vertical sizing. Natural heights change during the scripted session's resize and collapse phases (the 19 registers of the first search changed in 566 to 1,323 frames over the six sessions), yet the session shows no error, because natural row tops only feed the hit test, the peek and the "all comments fit" check, and the script never points at rows while their natural heights change. The random sessions do, e.g. the pointed row is 47 instead of 50 for a frame while a collapse changes natural heights under the pointer.

Searched on five of the six sessions, critical values keep 10 layers with 5 registers, all in the natural height scan and each changing in 1,004 to 1,065 frames, with 0 px and 0 mismatches on the held-out random seed 3. The minimum cuts searched with random seed 1, or with all five sessions, keep 9 layers with 2 registers and also show no error on seed 3: one in the natural height scan, and one in the vertical sizing whose value never changed in any session (251 comments never fit on screen). One held-out session is thin evidence, given how often held-out sessions broke the other rows.

### gallery (60 layers)

The held-out traces are the differential's other seeds among 5000 to 5005, plus seeds 6000 to 6005 on the same six viewports, which no search reads.

| Searched on | Strategy | Layers | Registers | Searched traces | Held-out traces |
| --- | --- | ---: | ---: | --- | --- |
| seed 5000 | critical values | 59 | 3 | 0 px, 0 mismatches | 8 of 11 seeds fail: 2,356 to 110,878 px, 185 to 1,897 mismatches |
| seed 5000 | minimum cuts | 57 | 22 | 0 px, 0 mismatches | all 11 seeds fail: 32,480 to 183,197 px, 1,316 to 3,550 mismatches |
| seeds 5000 to 5002 | critical values | 59 | 3 | 0 px, 0 mismatches | seed 5004: 143 px, 29 mismatches in 11 frames; seed 6005: 983 px, 265 mismatches in 52 frames; the other 7 seeds: 0 px, 0 mismatches |
| seeds 5000 to 5002 | minimum cuts | 59 | 3 | 0 px, 0 mismatches | 7 of 9 seeds fail: 450 to 50,328 px, 12 to 1,475 mismatches |
| seeds 5000 to 5005 | critical values | 59 | 3 | 0 px, 0 mismatches, and none of the 3 registers changes in these traces | seed 6000: 8,109 px, 457 mismatches; seed 6005: 39,457 px, 798 mismatches; the other 4 seeds: 0 px, 0 mismatches |
| seeds 5000 to 5005 | minimum cuts | 59 | 3 | 0 px, 0 mismatches, and none of the 3 registers changes in these traces | seed 6004: 28,395 px, 521 mismatches; seed 6005: 6,229 px, 1,470 mismatches; the other 4 seeds: 0 px, 0 mismatches |

The candidates rejected after each search reach 52 to 57 layers and cost 9,853 to 67,661 px with 20 to 4,286 mismatches, e.g. a delay in the scroll anchor.

Every register the search chose is inside the click tournament over photo rectangles ("focus from keys and clicks"): a subtree of the first-set-bit tournament. Its values change only when a click lands on a photo in that subtree, so a trace without such a click can't see the delay, and a trace with one loses the click or sends it to another photo. Searched on all six of the differential's traces, both strategies remove 1 layer with 3 registers at 0 px, but only because none of those registers changes in the six traces; both sets fail on 2 of the 6 new seeds. The gallery's longest chain (click, focus, strip positions, destinations, anchor, scroll, springs, occlusion) has a decision at every stage that has to be right in the same frame, so the only delays on it that passed every searched trace were delays those traces never exercised.

## What this shows about how far the approach goes

### What fit well

- Retiming needs nothing from the builders. A cut rewrites the positions that rows read, depth is one pass over the rows, and a replay is a plain evaluation loop. On IndirectOS a candidate replay over 240 frames takes about 5 to 10 ms, and a search step replays about a hundred candidates in well under a second, helped by stopping each replay at the first frame over budget.
- Registers on the flattened program reproduce the hand-built variants closely: Photos reading last frame's window size (116 and 89 layers against compiled 118 and 91) and the app shell reading last frame's spring (83 layers). Most traces give exactly the same outputs; the others differ where the two versions read slightly different values (a clamped content width against the spring state, or the register's first frame). So "read last frame's value" is a program transformation, not a builder feature.
- The two strategies complement each other. Critical values at one depth remove single values on every longest chain, e.g. 14 layers of IndirectOS with 4 registers inside Photos' click hit test. Minimum cuts find the smallest separators, e.g. 32 layers of the bank IndirectOS with 15 registers in the first step.
- When the searched traces exercise what a cut delays, the result mostly holds up on held-out traces: the bank IndirectOS goes from 136 to 123 layers with 8 registers, with 0 px and 0 mismatches on three held-out random traces, and to 114 layers with at most 19.8 px on them when px may be spent. hn-thread searched on five sessions keeps 10 layers with no error on the sixth. The app shell searched with random seed 1 keeps 35 layers with no error on 8 of its 10 held-out traces.
- The search rediscovered the hand-chosen Photos cut, as 3 of 17 registers with the original springs and 3 of 18 with the bank springs, once px could be spent and the keep-rendering outputs could be a frame late.
- The search exposes structure the authors didn't see: much of the app shell's longest chain computes from text tables that don't change during a session, and IndirectOS's longest chain runs through the maximized window rectangle, which depends only on the viewport.

### What got awkward

- A trace only tests values that change in it, and every workload showed this. Searched on one trace, the bank IndirectOS reaches 84 layers at 0 px, while on codegen's session the same cut set is 474 px off with 320 decision mismatches, and on random interactions over 7,000; 23 of its 49 registers never changed in the searched trace. hn-thread's scripted session accepted 17 layers at 0 px that a random session breaks with 57,598 mismatches. The gallery's cuts passed one, three or all six of its searched traces and failed on others, and the app shell's passed four random sessions and failed on 2 of 6 more. Adding traces helps, but only the traces that exercise a delayed value can reject it.
- The frontier is steep. For the original IndirectOS, exact decisions over random interactions allow 13 layers at 0 px and 20 layers at 34.9 px, and letting the keep-rendering outputs lag allows 89 layers at 325 px. For the bank IndirectOS, 13 layers at 0 px and 22 layers at 112 px with exact decisions, and 61 layers at 413 px (at 10 fps) with the keep-rendering outputs allowed to lag. hn-thread keeps 10 layers when five of its six sessions are searched, and the gallery 1 layer through registers its searched traces never change. Tonight's hand-chosen cuts sit at 86 to 89 px (1,380 px for the app shell), so none would pass the brief's 1 px budget.
- The error of a delay is how far the delayed value moves in one frame. The same Photos cut is 88.9 px at 60 fps and 161 px at 10 fps; with random drags that jump half the viewport in one frame, any delay on window geometry is hundreds of px. A px budget only means something together with a statement of how fast inputs move.
- Depth that follows a real dependency chain doesn't come off. The gallery's chain from a click to occlusion, and hn-thread's chain from natural heights to slot reads, carry a decision at nearly every stage, and a one-frame delay there is a lost click, a wrong row, or a scroll jump of thousands of px.
- Many decisions can be delayed without harm and some can't, and the metric can't tell which. `animationActive` a frame late keeps both spring models from accepting the hand-chosen cut, while a photo focused a frame late (random seed 4) is a real one-frame glitch. Marking the keep-rendering outputs as tolerant, by hand, is what let the search find the hand-chosen cut. Outputs that are fractional during animations need a second judgment call: counting a mismatch only in frames where one side is an integer catches a window drawn above the others (a retimed `stack` of 44 where the reference has 4), and ignores frames where both values are mid-animation. The first version of this prototype didn't count these outputs at all, and its original-springs search accepted cut sets that changed the window draw order.
- A register and a hand-built "read last frame's value" variant can read slightly different values. Photos' registers hold last frame's content width, which is clamped to the viewport, while the compiled variant reads last frame's spring state, which isn't, so they differ for 16 frames after the viewport shrinks below the window (up to 34.9 px).
- Most chosen registers aren't concepts anyone would name. The descriptions read like "reads photos.clickX, photos.clickY, photos.focus[0] and photos.focus[2]; feeds every photos output", and deciding what a register delays in UI terms took reading its cone.

### What stayed outside the circuit

- The search: recordings, replays, candidate generation, max flow.
- Committing registers: JS copies each cut value into its register after the evaluation, next to the next-source write-back.
- Event generation for traces that aim at on-screen targets, from the program without cuts.
- Choosing what counts as visible and what counts as a decision, per UI.

## How it connects to the talk, in plain terms

The talk's pattern is to take a unit apart and accept what comes out. Tonight's unit of time was the frame: each frame's outputs were one consistent snapshot, and depth was the price. Taking the frame apart means each value gets its own timing, and a search picks which values may lag.

The granularity gap showed up as expected. The search's registers don't read as UI concepts: a value in the middle of Photos' click hit test, one half of the maximized rectangle, a running sum of tag widths. Some of them are free for reasons nobody wrote down, e.g. the app shell's content height doesn't matter within a frame because the content always overflows.

The uniform direction is where it got interesting. The same search, directed by different traces and budgets, gave completely different cut sets: 84 layers that break on the next trace, 123 layers that hold, or, once the keep-rendering outputs could lag, the hand-chosen Photos cut plus 14 or 15 more registers. The handles are the traces, the px budget, and which outputs must stay exact, and the result follows them closely. Directing it well means supplying traces that exercise the values being delayed, which is a testing problem more than a circuit problem.

On premature compression: "every output is consistent with this frame's inputs" does bundle two things, but the measurements say the bundle is mostly right where decisions live. Where values only feed geometry that springs smooth, or values that are constant for a session, depth comes off for free or for a few px. Where a value decides something, one frame of delay shows.

## Open questions and next steps

- Coverage-guided traces: for each candidate register, generate events that change its value (e.g. a click on each photo, a pointer over each row during a collapse), instead of hoping random interactions reach it.
- A list of decisions that tolerate a frame of delay, separate from ones that don't, e.g. focus and stacking. The keep-rendering outputs above are one hand-written entry; cursor codes could be another. The same list could decide how outputs that are fractional during animations count.
- Registers that read exactly what a hand-built variant reads, e.g. last frame's spring state instead of last frame's clamped content width, which needs cuts that delay only some readers of a value.
- Session constants: values that only depend on cells written once, e.g. text tables, could be folded at prepare time instead of registered. Detecting them is a walk over the upstream cone, checking which cells the host writes every frame.
- Moves other than registers. spring-bank's stepped springs read an earlier value of this frame, which has 6.67 px of error where a register has 85.7 px. A search could also try replacing a reader's input with another value of the same frame that approximates it.
- Pipelining with consistent timing: delay every path at a stage boundary by the same one frame, so outputs are one frame late but consistent with each other. That's hardware retiming proper, and it measures input latency instead of inconsistency.
- Whether depth is worth it. Layers only cost time for a layer-parallel executor (a GPU, batched kernels); codegen's generated JS doesn't care about layers. The search should score registers against a real executor's time per frame.

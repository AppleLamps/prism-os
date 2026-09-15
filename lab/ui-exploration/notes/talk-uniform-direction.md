# Uniform direction: what homogeneity lets us do to a compiled UI

Status, September 15, 2026: two of this note's six ideas were built as prototypes after it was written: [user-population](../user-population/README.md) (idea 1) and [drag-knobs](../drag-knobs/README.md) (2). The design atlas (3), decision margins (4), behavior edits as numbers (5) and candidate futures (6) weren't built. [guide/sections/talk.md](../guide/sections/talk.md) explains each prototype.

This note reads Cheng's talk "Repeatable breakthrough" through one lens. Once every UI is the same three atoms in sparse layers over one source table, which uniform ways of directing a UI become possible that a normal UI codebase can't offer, and how far do tonight's numbers say they go? It proposes six prototypes. Two short scratch runs check the costs. Their scripts are `population.ts` and `drag-gradient.ts` in `scratchpad/phase3-ideas/uniform-direction/` (backup: `~/github/indirect-scratch-backup/2026-09-15/scratchpad/phase3-ideas/uniform-direction/`). No repo file besides this note changed.

## Reading the talk against tonight's results

The talk's middle claim is that homogeneity and a high-level way of directing come together. A shader is one function behind every pixel, so "draw the scene" is one command over millions of pixels. Tokens let one training objective direct billions of numbers. A city of 100,000 agents is useful because one policy can be applied to all of them and its consequences measured.

Tonight measured the homogeneity half. Thirteen prototypes compiled into affine, ReGLU and boolean atoms, from a text field's editing model to a 221-photo gallery. Codegen showed that a compiled program is a flat statement list that runs over an instance axis with no new builder concepts. It mapped which window receives a press at every one of IndirectOS's 1,024,000 pixels in about 184 ms on the CPU and about 2 ms on the GPU through Dawn. The guarded WGSL matched the CPU on every bit of 2,048,000 ownership outputs and 3,866,624 candidate-gallery outputs. Notation showed that one declaration per cell derives the table, the validator and the writeback, and its IndirectOS rewrite compiled into the identical circuit.

The direction half is mostly unbuilt. Every prototype spent its effort on one interactive instance, checked against a JS reference on random traces. Yet four operations apply to any compiled UI with no per-feature code:

- Evaluate it over many instances: pixels, viewports, design variants, simulated users, or candidate futures.
- Differentiate any output with respect to any source cell, e.g. how many pixels a hero image's width moves per pixel of gap.
- Instrument every decision, because every decision is a comparison atom over a difference the circuit keeps as its own wire.
- Edit numeric behavior at runtime, because behavior numbers can live in cells. For example, notation's IndirectOS already keeps title height, button size, dock gap, spring stiffness and damping among its 19 constant cells.

The granularity gap shows in tonight's "what got awkward" sections: per-photo operations written out 221 times, n² weights, and depth that follows a UI's chain of dependencies. The emergent behaviors worth directing appear at the population level: tradeoff curves over many users, maps over many viewports, and margins over all decisions.

The scratch runs give a sense of how far each operation goes:

- **Population.** 65,536 simulated users ran 300 frames each through lab/event-window's exact circuit at about 236 to 263 ns per user-frame. The 16 users checked against the oracle had 0 mismatches. The resulting slop tradeoff curve describes the shipped behavior, not a model of it.
- **Gradients.** A gradient from a dragged hero width moved two knobs to the target in one step. One backward pass predicted a knob change that flips which layout is selected, and the prediction held for all 4 knobs with a nonzero gradient.
- **Limits.** The same scan showed where uniform direction stops. 405 of 1,377 viewports have tied top scores, because quality scores are clamped at 1. At those viewports the gradient is 0 and the argmax falls back to picking the leftmost layout.

The talk's warning about compressing concepts too early applies here in two places:

- **"A UI is one instance."** The instance axis was built as a visualization tool (press maps, reflow maps), but the same axis can run users and design variants.
- **"A design number is part of the code."** A number folded into weights can't be dragged, searched or patched, even though folding is what makes a fixed-size box free in layout-tree.

## Scratch measurements

### A population of simulated users through event-window

`population.ts` builds lab/event-window's exact circuit: 501 live values, 883 stored weights and 52 layers. It marks 38 source cells as per-user: the event cells, pointer, press record, rectangle state, and the slop boundary cell. The viewport, rectangle sizes, relation cells and title boundary are shared. Codegen's generated instance loop runs users in blocks of 1,024. After every frame the host copies each user's next-source outputs back into that user's columns, so each user carries its own state across frames.

Each user alternates two tasks on a random rectangle. One is a click on the body, held for 2 to 6 frames. The other is a drag from the title bar by 6, 8, 12 or 20 px along one of 8 directions, over 6 to 10 frames. Every move adds Gaussian hand tremor with a standard deviation of 0.5, 1, 2 or 4 px, then rounds to integers, as the oracle requires. Users are split evenly over 8 slop settings × 4 tremor levels. The first 16 users also run through `oracleTick` with their own slop. Every frame compares the pressed bit, the slop latch, and every rectangle's position, maximized bit and focus.

| Run | User-frames | Circuit ns per user-frame, last 100 frames | Host policy and state copy, ns | Oracle comparisons | Mismatches |
| --- | ---: | ---: | ---: | ---: | ---: |
| 512 users × 200 frames | 102,400 | 345 | 77 | 57,600 | 0 |
| 65,536 users × 300 frames, first run | 19,660,800 | 232 | 44 | 86,400 | 0 |
| 65,536 users × 300 frames, second run | 19,660,800 | 260 | 49 | 86,400 | 0 |

One core ran the circuit at about 4 million user-frames per second, or about 3.3 million including the host policy and state copy. The whole 19.66-million user-frame run took about 5 seconds of circuit time.

Mistake rates from the second large run, with about 27,800 clicks and 27,500 drags per cell. A cancelled click is an intended click where the slop latch was set at release. A lost drag is an intended short drag where the latch never got set, so the rectangle never moved. With slop s, a drag begins at Chebyshev distance s + 1.

| Slop px | Tremor 0.5 px: cancelled / lost % | Tremor 1 px | Tremor 2 px | Tremor 4 px |
| ---: | --- | --- | --- | --- |
| 2 | 0 / 0 | 9.25 / 0 | 81.40 / 0 | 98.60 / 0 |
| 3 | 0 / 0 | 0.36 / 0 | 47.39 / 0 | 95.32 / 0.01 |
| 4 | 0 / 0 | 0 / 0.07 | 17.22 / 0.17 | 87.71 / 0.03 |
| 5 | 0 / 1.50 | 0 / 2.25 | 4.39 / 1.45 | 74.43 / 0.21 |
| 6 | 0 / 18.88 | 0 / 12.82 | 0.92 / 5.52 | 56.47 / 0.87 |
| 8 | 0 / 44.34 | 0 / 38.05 | 0 / 25.60 | 23.83 / 6.79 |
| 10 | 0 / 50.24 | 0 / 49.96 | 0 / 44.98 | 6.55 / 21.00 |
| 12 | 0 / 69.23 | 0 / 63.78 | 0 / 58.08 | 1.41 / 38.59 |

Event-window's authored slop of 4 px cancels no clicks at 1 px tremor and 17% of clicks at 2 px tremor. The smallest sum of the two rates is at slop 4 for 1 px tremor (0.07%), at slop 5 for 2 px (5.8%), and at slop 10 for 4 px (27.6%). At slop 10, users with 1 px tremor already lose half of their short drags, so no single setting serves every group. The motor model is authored, like lab/user-effort's simulator. These rates say what this compiled behavior does to these synthetic hands, not what people experience.

### Gradients from a dragged output, and decision flips, on candidate-gallery

`drag-gradient.ts` uses the root `candidate-gallery.ts` (463 built operations, 27 source cells), the reference evaluator, and `backpropagateReference` with straight-through booleans. At 1280×800 one forward pass takes 17 to 19 µs and one backward pass 3 to 4 µs.

- The hero width's gradient is -3 with respect to the gap, -1 with respect to the rail maximum, and 1 with respect to the viewport width. Central differences agree within 1e-4 relative. The hero's left edge depends only on the gap, with gradient 1. A thumbnail's width has gradient -0.5 for the gap and 0.5 for the rail maximum.
- Dragging the hero width 60 px wider took one minimal-norm step in normalized knob units, where one unit is the knob's current magnitude. The step reached the target exactly: the gap went from 14 to 13.56 and the rail maximum from 280 to 221.3. The selected layout stayed Cinema. The hero width is affine in these knobs, so one step is exact.
- At 1280×800 all three layout scores are exactly 1, so the argmax's leftmost rule selects Cinema. The scan covered 1,377 viewports, with widths 320 to 1920 in 20 px steps and heights 400 to 1200 in 50 px steps. 405 of them have a tie at the top score. Each score is a minimum of quality terms clamped to 0..1, so at a tie the gradient of the score margin is 0.
- At 1000×750, Contact is selected over Story by a margin of 0.00139. One backward pass on the margin gave a nonzero gradient for 4 cells. Moving each cell by 1.05 × margin / gradient flipped the selection to Story in all 4 cases: the gap by -0.071 px, contactCellScale by -0.14%, storyThumbnailScale by +0.14%, and the viewport height by +3.85 px.

## Ideas

### 1. A simulated population of users running the shipped UI, to choose behavior numbers

**Talk connection.** The city of 100,000 agents and "policy engineering", i.e. simulating a decision's consequences over a population before shipping it. Here each agent is a simulated user, and the city is the instance axis of the real compiled UI.

**What it tests.** Can the compiled UI itself be the simulator for design decisions at population scale, so the conclusions are about the exact shipped behavior? How does the cost grow from event-window's 446 live operations to input's folded window circuit (1,494 live operations at capacity 16)? And can the search produce a per-segment table of settings that hardens into exact cells?

**Build plan.**

- Start from `population.ts`. Swap event-window for `input/windows.ts`'s folded circuit at capacity 16 with at most 2 downs per evaluation. That circuit has double clicks with a 500 ms interval and a 4 px distance, and a 4 px drag slop. Lift those three numbers into source cells with declared ranges. At the authored values, check that the lifted build stays bit-identical to the original over input's 20,000-frame trace.
- User model: tremor 0.5 to 4 px, click hold durations and double-click gaps from log-normal distributions, and drag distances. The task mix covers focus clicks, double clicks on titles, short nudges and long drags. Each press aims at what the user's own instance currently displays, the way `input/traces.ts` aims presses through a shadow oracle.
- Instances: 64 settings of (slop × double-click interval × double-click distance) × 1,024 users = 65,536 instances, 600 frames each.
- Metrics per setting and tremor segment: cancelled clicks, lost short drags, missed double clicks, accidental double clicks, and frames from a task's start to its effect. Report the Pareto front and the best setting per segment.
- Population checks: take the maximum over all instances and frames of one-hot mass errors and of windows outside the workspace. Also check input's promise that at most one of title focus and key focus is set.
- Plant 10 single-operation corruptions, the way `hn-thread/mutation.ts` does. Count the user-frames the population needs to detect each one, and compare with input's random traces.
- Compare 32 sampled users against `windowsOracleEvent` every frame.
- Harden the per-segment table: add a runtime cell that selects the slop by a tremor bucket measured during holds. Check the table closed loop, with 0 oracle mismatches as the bar.

**Builds on.** lab/event-window, lab/ui-exploration/input (windows.ts, traces.ts, kit.ts), lab/ui-exploration/codegen/instance.ts, lab/user-effort, lab/ui-exploration/hn-thread/mutation.ts, the scratch population.ts.

**Expected evidence.** ns per user-frame for a circuit about 3 times larger than event-window. Tradeoff tables for three behavior numbers, like the slop table above. A hardened per-segment table with 0 oracle mismatches. Mutation detection counts against random traces.

**Size.** One to two hours.

### 2. Drag any output, move the knobs, and ask what flips a decision

**Talk connection.** A uniform way of commanding homogeneous units. The command is "this edge should be here", and one backward pass turns it into cell changes in any UI, the way one loss directs every weight.

**What it tests.** Is direct manipulation of a layout's design numbers a uniform operation on a compiled UI, with no inverse code per widget? How often does a drag need a change that crosses a decision, e.g. a column count, a wrap, or the selected layout? At such a change the gradient is 0 or misleading, and search along the instance axis has to take over.

**Build plan.**

- Use layout-tree's app shell. Lift its tree constants for padding, gap, minimum card width, sidebar open width and title font scale into source cells, and report the cost. layout-tree measured a row of 64 grow boxes at 897 live operations with constant fit widths, and 5,750 with runtime fit widths.
- The user drags a rectangle edge. The host sets the output gradient on that edge's wire, runs `backpropagateReference` with straight-through booleans, and takes a minimal-norm step over the knobs the designer unlocked. As in drag-gradient.ts, each knob is normalized by its magnitude. Repeat for up to 3 steps.
- When the error stays above 0.5 px, or a step changes a decision bit, evaluate 256 candidate values along the gradient direction as instances. Use codegen's instance plan with the knobs as per-instance cells, and pick the closest valid result.
- Flip queries: for a discrete result such as a column count, the selected layout or a line count, compute the margin's gradient and report the change that flips it, e.g. "the grid drops to 3 columns if the gap reaches 21 px". Candidate-gallery's 405 tied viewports show that such margins need an unclamped score output next to the clamped one.
- Run 500 scripted drags on random card edges. Measure the fraction solved in 1 step and in 3 steps, the fraction that needed search, the decision flips, and the time per drag frame. On knobs that feed decisions, compare the step against finite differences. generative-fields measured a straight-through gradient of 173 against a true local slope of 120.

**Builds on.** lab/ui-exploration/layout-tree, candidate-gallery.ts, lab/generative-fields/ste-backprop.ts, lab/ui-exploration/codegen/instance.ts, the scratch drag-gradient.ts.

**Expected evidence.** Solve rates by category, the operation cost of lifting constants into cells, how often decisions block gradients, and predicted against actual knob changes for flip queries.

**Size.** One to two hours.

### 3. A design atlas: design variants × viewports as instances, with ties and reflow jumps

**Talk connection.** "One supercomputer behind every pixel", where a pixel is a pair of one design variant and one viewport.

**What it tests.** How large a design space can be mapped exhaustively after every edit, and does exhaustive mapping find behaviors that sampled studies miss, e.g. tied scores, reflow jumps and overflow bands?

**Build plan.**

- Workloads: candidate-gallery, then layout-tree's app shell.
- Per-instance cells: viewport width and height, gap, the hero scales, and the minimum card width.
- Outputs: a decision signature (selected layout one-hot, column count, text line counts), the unclamped margin between the top two scores, validity bits for overlap, containment and minimum size (following generative-fields' self-scored checks), and 12 rectangle positions.
- Instances: 256 design variants × 65,536 viewports, about 16.8 million, run one block of variants at a time. First on the CPU with generated JS; codegen measured 116 ns per candidate-gallery instance with 135 per-instance rows. Then through the guarded WGSL shader on the GPU.
- Reductions in JS: ties at the top score, the valid fraction per variant, and reflow jumps. A jump is a pair of neighboring viewports whose decision signatures differ and whose mean rectangle movement is above 10 px. That is reusable-layout's movement metric, which found 35 of 1,640 transitions above 10 px for its shared rule.
- Interpolation paths: 60 straight lines between variants with 101 points each, evaluated in one batch. Report validity and jumps along each path; generative-fields found 31.5% of points valid before projection.
- A canvas page draws the atlas, with a picker for the design variant.

**Builds on.** lab/ui-exploration/codegen (instance.ts, workloads.ts, wgsl.ts, gpu-runner.ts), candidate-gallery.ts, lab/ui-exploration/layout-tree, lab/generative-fields, lab/reusable-layout.

**Expected evidence.** Instances per second on the CPU and GPU for about 16.8 million instances, and the fraction of design variants with ties or jumps. Also the variants with the fewest jumps across all viewports, and bit agreement between GPU and CPU on sampled outputs.

**Size.** One to two hours.

### 4. Decision margins for every comparison: find thin bands without random traces

**Talk connection.** Homogeneity lets one instrument attach to every unit at once. Every decision in these circuits compares a difference against a threshold, so "how far is this input from flipping any decision" can be one uniform output.

**What it tests.** Can one pass over a circuit locate the inputs where the circuit is fragile? And does checking the reference only at those inputs find the flips random traces missed? The gallery README is the benchmark. There, 957,258 random decision checks found 0 mismatches, while a hand-written edge probe found 10 flips. Each flip was at a pointer between index.ts's box edge and the circuit's box edge, which were 0.18 px apart at 98,197 px.

**Build plan.**

- In a copy of `gallery/kit.ts`, make the comparison helpers record each difference wire `d` that feeds a decision, and the input unit `d` is measured in. Add `|d| = relu(d) + relu(-d)` per decision, and a minimum tournament per group of decisions (hover, click, anchor, occlusion). Report the added operations.
- Run the gallery circuit over quarter-pixel pointer grids at the 6 viewports and scroll positions of `edge-probe.ts`, with the pointer as a per-instance cell.
- Rank pointers by margin, and run index.ts only where the margin is below the drift bound (0.18 px at the bottom of the page). Report recall of the 10 known flips, and the fraction of pointers that needed a reference check.
- Second workload: hn-thread. Its hand-written 0.02 px tie rule took three tries. Replace it with the margin outputs, and compare the tie counts (6 and 22 in the README).
- Third workload: numeric-library's rectangle hit test, where drifting minimums disagreed with float64 on 2,351 of 1 million near-edge presses.

**Builds on.** lab/ui-exploration/gallery (kit.ts, edge-probe.ts, reference.ts), lab/ui-exploration/hn-thread (differential.ts, mutation.ts), lab/ui-exploration/numeric-library (comparison.ts), lab/ui-exploration/codegen/instance.ts.

**Expected evidence.** Recall of the known flips, the reference checks saved, the operation cost of the margin outputs, and a margin map image of the gallery.

**Size.** One to two hours.

### 5. How much of a UI's behavior can an agent edit as numbers, and what that costs

**Talk connection.** A high-level way of directing. An agent or a person states a goal, and the change is a patch of cells applied without recompiling, the way a prompt directs a fixed network.

**What it tests.** Which requested changes to IndirectOS are reachable as cell edits today, and which need a recompile? And what does lifting the remaining literals into cells cost in operations and exactness? The starting point is favorable: notation's rewrite has 19 constant cells in indirect-os.ts, including title height, button size, gaps, dock sizes, spring stiffness and damping, and settle thresholds. photos.ts has 5 more.

**Build plan.**

- Write 30 requests, e.g. "bigger close buttons", "windows settle faster", "the dock sits higher", "two columns of photos", "a slower double click". Map each request to a cell patch by hand, or have an LLM do it given the allocator's cell names and ranges.
- For each patch:
  - validate it with notation's derived validator (0.3 µs)
  - run 1,000 frames of notation's random traces, and a short population run from idea 1
  - count validator rejections and output contract failures, e.g. the false "thumbnail left ≥ 0" rule notation found
- Classify the requests that need a recompile: structure (window count, photo columns), inline coefficients (centering by 0.5, thirds), and patches blocked by declared ranges. numeric-library found 231 of 273 minimum and maximum sites whose open ranges block the exact forms.
- Lift the inline coefficients into cells. Measure live operations, layers and stored weights against the 5,253 / 192 / 11,598 baseline, and bit-for-bit agreement over notation's traces at the authored values. notation's timestep case shows how much ranges matter: declaring one range where the timestep is computed saved 320 live operations.
- Interpolate between two patches, e.g. two spring personalities, and check settle bits on every frame.

**Builds on.** lab/ui-exploration/notation (table.ts, indirect-os.ts, photos.ts, traces.ts, compare.ts), lab/ui-exploration/spring-bank (the source-table variant keeps stiffness editable for 4 more operations), lab/ui-exploration/numeric-library, idea 1's population harness.

**Expected evidence.** The share of requests reachable by cell edits, patch latency, failures caught by validation, the cost of lifting the remaining literals, and whether exactness survives.

**Size.** One to two hours.

### 6. Candidate futures: evaluate several next source tables, commit one (longer)

**Talk connection.** Simulating a decision before making it, on every frame. ideas.md lists this: "Evaluate several next source tables together... Score them and commit one. This becomes useful once batching has a real backend." Codegen built that backend tonight.

**What it tests.** Can a UI look ahead as a normal part of every frame, previewing what each possible action would do and resolving ambiguous input by comparing interpretations? And since the preview runs the same circuit, is the preview exactly the future?

**Build plan.**

- **Preview.** In IndirectOS with spring-bank's deferred retargeting, hovering a dock item evaluates K = 5 futures (a click on each dock item) × H = 75 frames of 4 ms steps as instances, and draws ghost outlines of the windows' future positions. For scale: spring-bank's batched prediction ran 301 samples in one 7-layer evaluation at 2.0 µs per sample, and generated JS ran an IndirectOS frame in about 3 µs.
- **Exactness.** When the user clicks, compare the real animation with the preview frame by frame. With event-time evaluations, spring-bank agreed within 0.0051 px across frame rates. Evaluated at the same step counts, the preview should match bit for bit.
- **Ambiguity.** When a press lands within 2 px of the boundary between two targets (read from codegen's ownership map), evaluate both interpretations for one frame. Score each consequence with an effort output from lab/user-effort's predictor, and with a bit for whether the action can be undone (a focus change can, closing a window can't). Commit the higher score. Measure how often the committed interpretation matches the simulated user's intent in idea 1's population.
- **GPU sizing.** Estimate the cost of GPU execution without readback, keeping per-instance state in GPU buffers and reading back only the committed index.

**Builds on.** ideas.md, lab/ui-exploration/spring-bank (predictive.ts, bank-machine.ts), lab/ui-exploration/codegen (indirect-os-machine.ts, instance.ts, wgsl.ts, window-ownership.ts), lab/user-effort, idea 1's population harness.

**Expected evidence.** Latency per hover frame for K × H futures, bit agreement between preview and real animation, and how often ambiguous presses resolve to the simulated user's intent.

**Size.** Longer.

## Assumptions in tonight's work that look like premature compression

- **A compiled UI is one instance.** The instance axis ran pixels and viewports, never users, design variants or futures, and never with per-instance state across frames. Dropping this assumption makes population simulation and candidate futures possible; the scratch run did 19.66 million exact user-frames in about 5 seconds on one core.
- **A design number belongs in the code.** Where authored numbers fold into weights, no gradient, search or patch can reach them, e.g. layout-tree's fixed sizes, and input's slop and double-click interval as JS constants. IndirectOS already keeps 19 of them as cells. Lifting the rest, at a measured cost, would enable dragging outputs to move knobs, and agent patches without recompiling.
- **A quality or validity result is a clamped bit.** Candidate-gallery's quality clamps at 1, so 405 of 1,377 scanned viewports tie and give a gradient of 0. An unclamped margin next to each exact bit would enable flip queries and ranking; generative-fields already keeps such a value as `violationDepth`.
- **Correctness means frame-by-frame agreement with a JS transcription on random traces.** Random traces passed about 2 million gallery decision checks while near-edge flips existed. The circuit's own decision margins could say where to check.
- **One behavior setting for every user.** The slop table shows no single slop serves users with 0.5 px and 4 px tremor. A runtime cell, e.g. jitter measured during a hold, could select a hardened per-segment value inside the same exact circuit.
- **Only the committed state matters.** Every frame computes one next source table. ideas.md's candidate futures would compute several and pick one.

## Where uniform direction stops, from these runs and the READMEs

- **Decisions give no useful gradient.** Clamped scores tie exactly, and straight-through gradients carry phantom slope, e.g. 173 against a true local slope of 120 on generative-fields' hero importance probe.
- **Knobs as cells cost width.** Constant folding is what makes static structure cheap. layout-tree's row of 64 grow boxes costs 897 live operations with constant fit widths and 5,750 with runtime fit widths.
- **Per-instance state across frames lives only in the scratch host loop.** A GPU version needs state buffers and no readback; codegen measured about 0.3 to 0.7 ms of fixed readback cost through Dawn.
- **Simulated users are authored.** lab/user-effort's predictor recovered its own simulator's formula. Population results can guide the choice of behavior numbers, but they don't replace observations of people.

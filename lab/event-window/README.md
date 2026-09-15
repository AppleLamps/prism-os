# Event window: multi-frame interaction behavior as a feedforward function

## September 2026 corrections

The demo now keeps every queued pointer move, including browser-coalesced samples. A press followed by an outward-and-back movement must cancel a click even if both moves arrive before the next render. Previously only the last move survived, and the reference received the same incomplete input, so its agreement counter could not detect the mistake. `pointer-input.test.ts` covers the full path from queued samples through both evaluators.

This experiment learns six shared behavior parameters from examples that supply correct internal state and directly supervise decisions. That supervision permits one-step training. Positions, focus, maximization, and press state still recur between frames; event-triggered updates do not remove the problem of learning from delayed consequences. The extra event archive is not consulted by behavior. The demo uses its displayed parameter settings, not automatically loaded training results.

## Historical July study

This experiment tests the claim in the shared context (conclusion 6): discrete multi-frame interaction behavior — dragging with pointer ownership, focus, click-versus-drag disambiguation, a maximize toggle — can be expressed and trained as a pure feedforward function of (current input, a small bank of latched events), with no backpropagation through time, and hardened to bit-exact agreement with a plain TypeScript reference over long randomized traces.

Everything below is verified by `bun test lab/event-window` (34 tests, ~11s) or by one of the two measurement scripts (`training-sweep.ts`, `measure-cost.ts`) whose printed tables are reproduced here; where a number comes from a specific test or script, the text names it.

## The behavior

Four interactive rectangles in a 1280×800 viewport (`oracle.ts`, one tick function, centralized numeric state, ground truth, no circuit imports):

- A frame carries at most one pointer event (down, move, up) or none.
- Pointer-down hit-tests against the rectangles the user saw on the previous frame, strictly inside the edges. Overlaps resolve by fixed priority: maximized rectangles first, lowest index within each group.
- Focus follows pointer-down; down on empty space clears focus.
- Each rectangle has a title bar (top 30 pixels of its displayed geometry) and a body. A relation table says what each region does: whether a drag from that region moves the rectangle, and whether a click on that region toggles maximized. The authored table is title = drag, body = click-toggle.
- A drag begins when the pointer, while pressed, moves beyond the 4-pixel slop threshold (Chebyshev distance from the press point, checked on move events). Crossing slop cancels the click regardless of region. The press then owns the pointer until release: the grabbed rectangle follows the pointer even over other rectangles, clamped to the viewport. A maximized rectangle never moves.
- A click (down-and-up within slop) toggles maximized only if the rectangle was already focused before the press — the first click on an unfocused rectangle only focuses it.
- The dragged position commits into stored state once, at release. A maximized rectangle displays as the full viewport; its stored geometry is untouched.

Randomized traces (`trace.ts`, LCG-seeded, integer pixel coordinates) aim presses at title/body/empty regions of what is currently displayed, and mix near-slop jitters, long drags, and teleports. Per 10,000-frame trace, mean over the 12 exactness seeds: 1,219 downs (1,035 on rectangles, 184 on empty space), 3,841 moves, 1,219 ups, 286 drags, 331 clicks, 830 cancelled clicks, 66 maximize toggles. The exact totals behind these means are pinned in `oracle.test.ts` ("trace statistics over the 12 exactness seeds").

## The latch bank design

The circuit (`circuit.ts`, 502 ops, depth 38, 6 boolean atoms) computes each frame from the source table alone. State cells fall into three groups, and none of them is a per-frame integrator:

- **The live press record** — the event window. Written by the pointer-down write gate: press position, the hit rectangle as a one-hot, the grabbed rectangle's stored position, and three snapshot bits taken at press time (was the press on the title region, was the rectangle already focused, was it maximized). Latched values persist after release; the active bit gates their meaning.
- **The drag-begin latch** — written by the move event that crosses slop, cleared by down and up. Together with the press record it makes drag ownership, the dragged position (grab point + live pointer delta), the click-versus-drag decision, and the commit-at-release all single-frame functions.
- **Stored behavior state** — rectangle positions, maximized bits, focus one-hot. Written only on events: focus at down, maximize toggle and drag commit at up. Never touched on move or empty frames.

Two design points that made exactness easy:

- **The previous frame's geometry is reconstructible from state.** The oracle literally hit-tests against what was displayed last frame, but a down event can only arrive while released, and while released the display equals stored geometry plus the maximized override. The circuit therefore needs no stored copy of the displayed frame. The closed-loop tests confirm the equivalence over every generated press.
- **Integer coordinates make even the continuous outputs bit-exact.** All positions and deltas stay integers well inside FP32's exact-integer range (see `macro-ranges.md`), so `select`/`min`/`max` reconstruct exactly and the geometry comparison in every test is `===`, not a tolerance.

Thresholds use one shared form: `bit(clamp01((boundary − measure) × sharpness + 0.5))`, where `bit` is the boolean atom in exact mode and the identity in soft mode. The decision is `measure` versus `boundary` regardless of sharpness, so training can anneal the ramp width while the hardened semantics stay fixed. The oracle's integer rules map to boundary cells at band centers: slop 4 (distance 5 cancels the click) puts the boundary anywhere in (4, 5], authored 4.5; title height 30 (relative y 29 is still title) puts it in [29, 30), authored 29.5.

## Closed-loop exactness (hand-authored parameters)

The machine runs as the state machine: its own outputs latch its next event window; the oracle runs in parallel purely as a judge. Every frame compares focus, drag ownership, maximized bits, all 16 displayed geometry numbers, and every behavior state cell, all for exact equality.

| check | frames | divergences | test |
| --- | --- | --- | --- |
| closed loop, tensor evaluator, 12 seeds × 10,000 frames | 120,000 | 0 | `exactness.test.ts` |
| closed loop with per-frame differential check (reference vs tensor, every live wire, 2 seeds) | 20,000 | 0 | `exactness.test.ts` |
| all 16 relation-table combinations, 2,000 frames each | 32,000 | 0 | `exactness.test.ts` |
| closed loop, reference evaluator | 5,000 | 0 | `exactness.test.ts` |
| well-formedness (exact bits, one-hot groups) | 5,000 | 0 | `exactness.test.ts` |
| K = 4 window, closed loop plus archive mirror | 5,000 | 0 | `window-depth.test.ts` |
| 200 sequential drags, position reflects every one | 800 | 0 | `boundary-probe.test.ts` |

The relation-combination check matters for the keystone claim: the same four cells that training recovers below are hand-edited here through all 16 settings, and the circuit tracks the oracle for each — behavior is data, editable and trainable through the same cells.

## Training: feedforward, no unrolling, harden-exact

Six behavior parameter cells are trainable: the slop boundary, the title boundary, and the four relation cells. Supervision pairs are harvested from oracle traces one frame at a time: each pair is one source table (state + input) and that frame's 21 expected decision bits (press record bits, slop latch, focus and maximized one-hots, drag ownership). Geometry needs no supervision — once the decision bits are right, positions are authored arithmetic over latched values. Frame-locality holds by construction: `harvestTrainingPairs` allocates one standalone single-frame source table per kept frame, and the training loop indexes one pair at a time with no sequence dimension anywhere (`train.ts`); `training.test.ts` asserts the standalone single-frame shape of every pair.

Training runs on the soft build of the same circuit: boolean atoms replaced by their clamped scores, so the repo's reference backward pass applies directly. That the soft circuit contains zero boolean atoms is asserted outright in `training.test.ts` — the backward pass alone would not catch one sitting off the supervised gradient path, since it only throws when a nonzero gradient reaches a boolean atom. Adam runs on the six cells with MSE on the 21 bits. Hardening rounds the relation cells and keeps the thresholds; acceptance is closed-loop bit-exactness on held-out traces.

**A real failure worth recording, retained as runnable code:** training with a fixed threshold ramp fails two ways, both pinned by the fixed-ramp test in `training.test.ts` through the `constantSharpness` training option.

- **Far from the boundary it stalls.** At constant sharpness 0.25 the gradient band spans 4 pixels; a slop boundary initialized 8 pixels or more away sees almost no in-band examples. The pinned run from a scrambled start leaves the slop boundary bit-for-bit unchanged after 76,800 pair evaluations.
- **Near the boundary it settles in the wrong place.** With a fixed ramp, the MSE optimum sits at a density-weighted balance point of the examples straddling the boundary, and title presses are denser per pixel row than body presses (29 title rows versus ~170 body rows on typical rectangles). A uniform-density estimate of that balance point gives ≈30.33; the measured optimum over the committed 15,844 pairs is ≈30.0 (grid scan via `measureMeanLoss`: loss 0.002590 at boundary 30.00 versus 0.002598 at 30.25 and 0.002629 at the true 29.50) — so the analysis predicts the direction and the exit from the correct band [29, 30), but overestimates the displacement. The consequence does not depend on the magnitude: training at fixed sharpness 0.25 starting FROM THE AUTHORED TRUTH drifts the title boundary to ≈30.01 and the slop boundary to ≈3.97, both outside their bands, and the hardened result diverges from the oracle 9,120 times over a 10,000-frame held-out trace.

The fix is annealing: start wide (sharpness 1/32, a 32-pixel band, plenty of gradient), end narrow (sharpness 4, a quarter-pixel band whose zero-loss plateau lies strictly inside the correct integer band, immune to example imbalance), with the learning rate shrinking alongside and optimizer moments reset at phase changes so one late rare example cannot knock the boundary back out.

Sweep results (`bun lab/event-window/training-sweep.ts`, 15,844 pairs from two 10,000-frame traces, 2,400 steps × batch 32 = 76,800 single-frame evaluations, ~632ms per seed; recovery = zero divergence over three held-out 10,000-frame traces):

| seed | initial slop | initial title | learned slop | learned title | relations | divergences | recovered |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 12.86 | 85.95 | 4.500 | 29.702 | 1001 ✓ | 0/30000 | yes |
| 2 | 14.29 | 84.06 | 4.500 | 29.821 | 1001 ✓ | 0/30000 | yes |
| 3 | 15.72 | 82.16 | 4.500 | 29.684 | 1001 ✓ | 0/30000 | yes |
| 4 | 17.15 | 80.26 | 4.500 | 29.501 | 1001 ✓ | 0/30000 | yes |
| 5 | 18.59 | 78.36 | 4.500 | 29.563 | 1001 ✓ | 0/30000 | yes |
| 6 | 20.02 | 76.47 | 4.500 | 29.502 | 1001 ✓ | 0/30000 | yes |
| 7 | 21.45 | 74.57 | 4.305 | 29.498 | 1001 ✓ | 0/30000 | yes |
| 8 | 22.88 | 72.67 | 4.500 | 29.712 | 1001 ✓ | 0/30000 | yes |
| 9 | 24.32 | 70.78 | 4.500 | 29.555 | 1001 ✓ | 0/30000 | yes |
| 10 | 25.75 | 68.88 | 4.498 | 29.470 | 1001 ✓ | 0/30000 | yes |
| 11 | 27.18 | 66.98 | 4.512 | 29.490 | 1001 ✓ | 0/30000 | yes |
| 12 | 28.61 | 65.08 | 4.496 | 29.414 | 1001 ✓ | 0/30000 | yes |
| 13 | 30.05 | 63.19 | 4.842 | 29.435 | 1001 ✓ | 0/30000 | yes |
| 14 | 31.48 | 61.29 | 4.794 | 29.563 | 1001 ✓ | 0/30000 | yes |
| 15 | 32.91 | 59.39 | 4.773 | 29.536 | 1001 ✓ | 0/30000 | yes |
| 16 | 34.34 | 57.49 | 4.483 | 29.390 | 1001 ✓ | 0/30000 | yes |
| 17 | 35.77 | 55.60 | 4.503 | 29.524 | 1001 ✓ | 0/30000 | yes |
| 18 | 37.21 | 53.70 | 4.466 | 29.680 | 1001 ✓ | 0/30000 | yes |
| 19 | 38.64 | 51.80 | 4.174 | 29.479 | 1001 ✓ | 0/30000 | yes |
| 20 | 40.07 | 49.91 | 4.500 | 29.607 | 1001 ✓ | 0/30000 | yes |

**20/20 seeds recovered.** Every learned slop boundary landed in (4, 5] and every title boundary in [29, 30) — the sharp-phase plateau centers them near 4.5 / 29.5 without ever being told the bands exist. The committed test (`training.test.ts`) reruns 6 of these seeds end to end and also checks that the closed-loop verifier catches a deliberately wrong relation cell and a deliberately out-of-band threshold.

## The boundary probe

**No bounded window of raw inputs can express this behavior set.** The committed rectangle position is a sum over every drag that ever happened. `boundary-probe.test.ts` proves it by construction, for K ∈ {1, 4, 16, 64, 256} and in both framings (last K frames, and last K non-empty events): two traces that end with the exact same K inputs — one contains an early drag, one does not — have different correct outputs, so no function of (current input, last K inputs) can produce both.

What makes the event-window design work anyway is that its latches hold event-triggered aggregates (the committed position, written once per release), not raw events. That single write is the irreducible recurrence, and it is event-clocked, not frame-clocked: it fires three times per drag session instead of every frame, and training never needs a gradient to cross it. The second genuine recurrence in real UI is continuous per-frame integration — the repo's springs, where the trajectory depends on every intermediate frame duration — and that is excluded from this behavior set by design, consistent with conclusion 6 (recurrence remains for continuous animation, where it is smooth and benign).

The positive side of the probe: one live press record suffices for this entire behavior set (all exactness results above run at K = 1), and 200 sequential drags accumulate exactly through the one-record window.

## Cost versus window size K

The latch bank generalizes to a window of the last K press records: record 0 is the live press latch, and on each pointer-down the outgoing record shifts into a K−1 deep archive (a shift register — no ring pointer, no dynamic indexing). The behavior reads only record 0; the archive is what a deeper consumer (double-click detection, flick velocity) would read. `window-depth.test.ts` verifies that deeper windows change nothing about behavior, that archive records hold exactly the previous press sessions (JS mirror comparison over 5,000 frames), and that growth is exactly linear: +36 ops and +60 stored weights per record, depth constant.

From `bun lab/event-window/measure-cost.ts`:

| K | source cells | ops | affine | reglu | boolean | depth | layers | stored weights | max layer width |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 55 | 502 | 285 | 211 | 6 | 38 | 38 | 979 | 51 |
| 2 | 67 | 538 | 309 | 223 | 6 | 38 | 38 | 1039 | 75 |
| 4 | 91 | 610 | 357 | 247 | 6 | 38 | 38 | 1159 | 123 |
| 8 | 139 | 754 | 453 | 295 | 6 | 38 | 38 | 1399 | 219 |
| 16 | 235 | 1042 | 645 | 391 | 6 | 38 | 38 | 1879 | 411 |

The soft training circuit at K = 1 is 496 ops with zero boolean atoms (both numbers asserted in `training.test.ts`). Closed-loop stepping through the tensor evaluator runs at 6.3µs per frame (10,000 frames in 63ms, oracle comparison included).

## Failures and limits

- **The fixed-ramp training failure described above** is the one outright failure encountered; the `constantSharpness` option in `train.ts` retains it as runnable code and the fixed-ramp test in `training.test.ts` pins both halves (the stall from far away, the out-of-band settling up close). The density-imbalance analysis predicted the direction and the band exit but overestimated the displacement: uniform-density estimate ≈30.33, measured optimum ≈30.0.
- **Integer coordinates are load-bearing.** Fractional pointer coordinates would shrink the threshold recovery bands from fixed integer gaps to data-dependent gaps, and geometry equality would need an FP32 rounding analysis per operation instead of the exact-integer argument. Untested here.
- **One event per frame.** A real browser can coalesce down+move+up into one animation frame; the production window manager handles that with a select chain. This experiment processes each event as its own frame to keep every event a clean query against one seen snapshot. Batched frames would need the same latch bank but more careful within-frame ordering.
- **Threshold exactness is a band condition, not a point.** A learned boundary is correct because every measure in the traces is an integer and the boundary sits strictly inside the band. The closed-loop verifier is the arbiter; the bands are also asserted directly in `training.test.ts`.
- **Training recovers parameter cells, not structure.** Which latches exist and which gates write them is authored. That matches the repo's keystone (state and behavior as editable, trainable numbers in a fixed circuit), but discovering latch structure by gradient is untouched.
- **The archive is measured, not consumed.** No behavior in this set needs K > 1, so the linear-cost table is exercised by invariance tests rather than by a real deeper consumer.

## Next steps

- Add a behavior that genuinely reads archive record 1 — double-click is the natural one. The archive covers the spatial half already (the previous press position gives the distance budget); the temporal half needs one added field, a press timestamp supplied with the event and latched by the same pointer-down write gate. That stays event-clocked — a timestamp is latched once per press, where a frame counter would reintroduce per-frame integration.
- A move-event archive of the last two positions would give flick velocity at release, still feedforward.
- Train from rollouts of the hardened circuit itself instead of oracle-encoded states, closing the data loop.
- Fractional coordinates, batched multi-event frames, and more rectangles through the instancing trick.

## Files and how to run

- `oracle.ts` — the plain TypeScript reference (ground truth, circuit-independent)
- `trace.ts` — seeded randomized trace generator and trace statistics
- `circuit.ts` — the event-window circuit builder (exact and soft modes), source layout, machine wrapper
- `harness.ts` — oracle-versus-circuit comparison and the closed-loop runner
- `train.ts` — pair harvesting, annealed feedforward training (plus the constant-sharpness option that retains the fixed-ramp failure), hardening, held-out verification, full-dataset loss measurement
- `stats.ts` — circuit cost measurement
- `*.test.ts` — oracle properties and pinned trace statistics, closed-loop exactness and differential checks, window depth and cost linearity, boundary probe, training recovery and the fixed-ramp failure
- `training-sweep.ts`, `measure-cost.ts` — the table-producing scripts
- `demo.html`, `demo.ts`, `demo.css` — the visual demo: the four windows driven by the circuit stepping closed-loop, the behavior cells as live toggles and sliders, the latch bank shown as lamps, the oracle running in parallel as an on-screen agreement counter, and an autopilot that replays scripted press sessions

```sh
bun test lab/event-window
bunx tsgo -p lab/event-window
bunx oxlint --type-aware lab/event-window
bun lab/event-window/training-sweep.ts
bun lab/event-window/measure-cost.ts
bun lab/event-window/demo.html
```

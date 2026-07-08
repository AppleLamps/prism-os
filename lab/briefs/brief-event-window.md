# Brief: multi-frame behavior as a feedforward function of an event window

Folder: `lab/event-window/`. Read `lab/briefs/context-shared.md` first; conclusions 6, 7, 8 are your foundation.

## The question

Can real multi-frame interaction behavior — dragging with pointer ownership, focus, click-versus-drag disambiguation, a mode toggle — be expressed and TRAINED as a pure feedforward function of (current input, a small window of latched events), with no backpropagation through time, and then hardened to bit-exact agreement with a reference implementation over long randomized interaction traces?

## Build

1. A JS oracle: a small, plain TypeScript reference implementing the behavior of 4 interactive rectangles in a viewport — pointer-down/move/up; focus follows pointer-down on a rectangle; a drag begins when movement exceeds a slop threshold (e.g. 4px) and then owns the pointer until release; a pointer-down-and-up within slop on a focused rectangle toggles its maximized state; clicks land on the layout the user saw (hit-test against the previous frame's rectangles, not ones recomputed after this frame's state changes). Write it in the vibescript style (one tick function, centralized state). This oracle is ground truth; keep it independent of the circuit code.
2. The event-window circuit: source table holds current pointer facts plus a small bank of latched events — for each latch: an active bit, event position, and the interaction snapshot at latch time (which rectangle was hit, its geometry then). Write gates fire on pointer-down/up transitions; each frame's outputs (focus one-hot, drag ownership, drag offset, maximized bits, rectangle geometry) are computed from the latch bank and current input only — never from the previous frame's conclusions, except through the latches themselves and any explicitly justified state cell. Use integer-exact decision bits for counting-style decisions; the boolean atom for continuous thresholds (slop distance, hit tests).
3. Hand-authored first: get the circuit exactly matching the oracle with authored cells, verified over randomized traces. This establishes the representation works before any training.
4. Then training: choose a meaningful subset of behavior parameters as trainable cells — at minimum the slop threshold, and a relation-style table deciding which control does what (e.g. which rectangle regions map to which action), so training has real discrete structure to recover, not just one scalar. Harvest (event window -> expected outputs) supervision pairs from the oracle over randomized traces. Train feedforward (the repo's Adam pattern; train-soft/harden-exact for discrete cells; no unrolling anywhere). Harden.

## The experiments to run and report

1. Closed-loop exactness: run the hardened circuit AS the state machine (its outputs latch its own next event window) over held-out randomized traces of at least 10,000 frames each, many seeds. Require exact equality with the oracle on every discrete quantity (focus, ownership, maximized) at every frame, and exact or precisely-characterized agreement on continuous outputs. Report frames-until-first-divergence if any divergence exists.
2. Training recovery: from scrambled initial parameters, does feedforward training over event-window pairs recover behavior that hardens to closed-loop exactness? Report seeds attempted, seeds recovered, supervision pairs needed.
3. The boundary probe: find and document at least one behavior that genuinely cannot be expressed as a function of a bounded event window (or argue precisely why none exists in this behavior set). This characterizes where recurrence is truly required — a key finding either way.
4. Measure the cost: circuit size (ops, stored weights, depth) of the event-window formulation, and how it scales with window size K.

## Success criteria

- Hand-authored circuit: zero divergence from the oracle over 10k-frame traces across 10+ seeds, verified through both evaluators.
- Trained-then-hardened circuit: closed-loop exact on held-out traces for most seeds; honest numbers for the rest.
- The no-BPTT claim demonstrated by construction: show the training loop contains no unrolling.
- README with trace statistics, training tables, the boundary-probe finding, and limits.

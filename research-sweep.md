# Research sweep

## September 2026 update

The July results below are historical. Several interpretations changed after independent review: see [the reassessment](lab/reassessment-2026-09-03.md) and [current status](lab/status.md). In particular, exact forward execution is distinct from a useful training gradient; layout validity did not require retaining all content; and event training used correct internal state rather than eliminating recurrence. The September 12-14, 2026 exploration is in [lab/ui-exploration/README.md](lab/ui-exploration/README.md). On September 15, 2026, "Parked" and "Deferred" moved to [lab/status.md](lab/status.md#parked-and-deferred) and were updated there; this file keeps the history.

## Historical July notes


Land changes that strengthen the numeric model without adding another format, mode, or runtime.

## Landed

- Seeded random circuits compare every live wire between literal and compiled FP32 execution.
- `execution-model.md` fixes instruction, rounding, and layer semantics.
- Photos is inlined into IndirectOS before one fused compile.
- Photo nodes attach only while numeric size and opacity are positive.
- Compiler indexes use the smallest safe 8, 16, or 32-bit storage.
- Static winner priority uses a balanced reduction instead of a serial scan. Note, September 15, 2026: IndirectOS's `emitFrontmost` in window-manager.ts checks stacking ranks one at a time, and stays that way, since at 4 windows its chain is smaller than an `emitFirstActive` tree.
- Photos keeps thumbnail center and scale springs in the shared source table.
- The compiler already performs affine composition, aliases, constant folding, common-expression merging, dead-value removal, compact layer inputs, sparse weights, and basic range reasoning.

## Lab round one (July 2026)

Four experiments in `lab/`, each built from a brief, adversarially verified (29 confirmed findings fixed, 17 refuted), and re-verified. Full details and measurement tables live in each folder's README.

- **Generative fields** (`lab/generative-fields`): one 16-slot layout circuit driven entirely by input fields expresses five layout families with zero recompilation; naive interpolation between valid layouts is 31.5% valid, and projecting invalid points against the circuit's own violation depth repairs every path to 100% across 6,060 points. Demo: `bun lab/generative-fields/demo.html`.
- **Event window** (`lab/event-window`): dragging, focus, click-versus-drag, and a relation table computed as a pure single-frame function of latched events plus the live pointer; zero divergence from an independent reference over 120,000 closed-loop frames; six behavior cells recovered by feedforward training in 20/20 seeds with no unrolling — the irreducible recurrence of discrete behavior is event-clocked, not frame-clocked. Demo: `bun lab/event-window/demo.html`.
- **Trace compiler** (`lab/trace-compiler`): a restricted vibescript-subset compiler; both layout modes of chenglou.github.io compile from the file's own source bytes with zero mismatches across 1.1M comparisons; ships a twelve-category taxonomy of what does not compile and why. Falsified the margin policy for continuous comparisons and produced the relu sign cascade (now in `expressions.md` "Decision bits"), so its compiled circuits contain zero boolean atoms.
- **Gather lowering** (`lab/gather-lowering`): declared one-hot groups plus compiler recognition execute one-hot-masked sums as gathers (stored weights per read: 3N to zero). Landed in `numeric-ui-core.ts`; see `execution-model.md` "One-hot groups and gathers" and the hardAttend entry in `todo.md`.

## Superseded

- **exp-ste-backprop / exp-ste-reveal** (removed July 2026): surrogate slopes through the boolean atom, and learning a reveal relation with them. Made unnecessary by three independent routes: integer-count scores (`expressions.md` "Decision bits", `exp/exp-integer-boolean.ts`, which absorbed the reveal-law scaffolding), annealed soft ramps (`lab/event-window` training), and the relu sign cascade (`lab/trace-compiler`). Surrogates remain relevant only for training through circuits that keep rounding atoms on the gradient path, e.g. `emitArgmax` comparison trees. Note, September 2026: `lab/cascade-argmax` trains through soft comparisons, then hardens.
- **The manifold probe and keystone demo halves of exp-behavior-cells-relations**: the lattice-hole finding is refined by `lab/generative-fields` (fields avoid categorical holes; projection repairs the rest; wrap decisions still step between samples), and zero-recompilation behavior editing is now demonstrated live, trained, and reference-checked in `lab/event-window`. The file stays for its growth-cost table (marginal circuit cost per behavior knob), which nothing else reproduces.

## Parked and deferred

Moved to [lab/status.md](lab/status.md#parked-and-deferred) on September 15, 2026, and updated there.

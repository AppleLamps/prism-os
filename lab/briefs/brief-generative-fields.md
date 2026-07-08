# Brief: generative layout from fields over one shared slot function

Folder: `lab/generative-fields/`. Read `lab/briefs/context-shared.md` first; conclusions 2, 3, 4, 5, 8, and 11 are your foundation.

## The question

Can a single equivariant layout circuit — one shared per-slot function, no per-slot special cases — express several qualitatively distinct layout families purely through input fields, score its own results, and support interpolation between two UIs that were never explicitly authored, staying valid the whole way?

## Required properties

- At least 16 slots. Per-slot fields as source cells: at minimum an importance value in 0..1, an order key, and whatever else your design earns (group coordinate, aspect preference). Global knobs as source cells: gap, padding, flow parameters. Every quantity that makes one slot different from another must be a field, never a code branch.
- The layout function is built once with the instancing trick: the same sub-circuit per slot, differing only in slot index features and field values. A hero is an importance peak, not a code path.
- Validity outputs computed by the circuit about its own layout: pairwise non-overlap among visible slots, containment in the viewport, minimum sizes respected, plus an aggregate. Use integer-exact decision bits (`tricks.md` "Decision bits") wherever scores are counts; the boolean atom only where genuinely continuous thresholds demand it.
- A fitness function in the spirit of Flipboard's Duplo: coverage/fill ratio, balance, alignment, size floors — a handful of weighted heuristic terms. Implement the scorer as circuit wires where reasonable (the candidate gallery scores inside the circuit; follow that precedent), or in JS where the circuit would be gratuitous — but say which and why.
- Differential exactness tests (reference vs tensor evaluator) for every circuit.

## The experiments to run and report

1. Expressivity: demonstrate at least 3 qualitatively distinct layout families (e.g. uniform grid, hero-plus-rail, importance-weighted mosaic) reached purely by setting fields on the SAME compiled circuit. Show the field vectors. Zero recompilation between them.
2. Generation by search: sample many field vectors (hundreds to thousands, seeded), score with the fitness function, keep the argmax or top-k. Report the fitness distribution and whether search discovers layouts you did not anticipate (include their field vectors).
3. Generation by gradient: make fitness differentiable where possible and gradient-ascend field vectors from random starts (the repo's Adam pattern in `trainable-geometry.ts` is the precedent). Compare against search: quality, cost, failure modes.
4. The headline — interpolation: take pairs of valid UIs (authored and searched). Walk the straight line between their field vectors. Measure the fraction of intermediate points that are valid. Where naive interpolation breaks validity, project back (gradient steps against the circuit's own validity outputs, or your better idea) and measure again. Report: percent-valid along paths, before and after projection, over many seeded pairs. Demonstrate hero migration — importance mass moving from one slot to another — producing a coherent layout at every intermediate step.
5. Optional but valuable: one text-aware fitness term using pretext (`~/github/pretext`, `prepare`/`layout`) to score whether label text fits its slot — even for a fixed label set. This grounds the claim that text metrics can live inside the scoring loop.

## Success criteria

- One compiled circuit; 3+ layout families by fields alone; validity and fitness computed with tests proving exactness.
- Interpolation study with real numbers over 50+ seeded pairs; projected paths should be valid at (target) 95%+ of sampled points — and if the target is missed, the characterization of where and why is the finding.
- README with field-vector tables, fitness distributions, interpolation metrics, and honest limits (e.g. which layout families this parameterization cannot express).

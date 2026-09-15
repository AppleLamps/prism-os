# Exact argmax and soft training

The exact sign cascade resolves distinct FP32 scores in `[0, 1]` and keeps the leftmost winner on ties. Production argmax still has a small comparison band that can keep the left candidate even when the right is slightly larger. Both now use selection that preserves the chosen finite value exactly.

The forward construction uses ReLU, power-of-two scaling, and clamping. `Circuit.roundAffine` preserves each required rounding point; it replaces the older unit-gated ReGLU workaround. Exactness tests include ties, subnormals, adjacent FP32 values, random vectors, and reference/tensor agreement.

## What trains

The hard cascade does not provide useful score gradients. The regression test checks separated scores, ties, and a subnormal difference. Some internal gradients can also become nonfinite. Removing the boolean atom did not remove the distinction between exact execution and a training relaxation.

Training uses soft comparisons, then transfers the same learned values into the hard circuit. The task has sixteen cases and eight candidates, with one learned score per case and candidate. This is fitting a 128-cell table. There is no learned shared query/key function and no claim about unseen contexts.

| Training comparison | Seeds | Correct hard winners |
| --- | --- | ---: |
| Seven-stage soft cascade | 1-10 | 160/160 |
| Single clipped ramp | 101-110 | 160/160 |

The single-ramp control uses the same training schedule and hard verification. It needs less than half as many operations in the eight-candidate soft tree. This supports using the simpler relaxation for this task. It does not prove identical FP32 gradients between the soft constructions or establish a universal training method.

## Current cost

The September core preserves macro semantics and rounding, so the July operation and timing table is superseded. Current structural counts from `report.ts` are:

| Candidates | Production operations | Cascade operations | Production layers | Cascade layers |
| --- | ---: | ---: | ---: | ---: |
| 3 | 16 | 56 | 8 | 49 |
| 8 | 56 | 196 | 15 | 75 |
| 20 | 152 | 532 | 26 | 124 |
| 64 | 504 | 1764 | 33 | 150 |

The long exact cascade is an available construction, not a proof of minimality. A native comparison backend, a proven minimum separation, or another construction can change the cost. Current timing is serial JavaScript CPU execution. Run the report on the target machine rather than extrapolating it to GPU execution.

The cascade columns use this folder's own cascade. Since September 14, 2026, numeric-ui-core.ts's `emitCompare` builds exact comparisons from declared ranges, and an exact tree over 8 candidates built with it is 150 operations in 57 layers without a grid, or 52 in 18 on a 1/64 grid ([highest-score-tree.md](../ui-exploration/guide/patterns/highest-score-tree.md)).

## Reproduce

Run `bun test lab/cascade-argmax`, `bunx tsgo -p lab/cascade-argmax`, `bunx oxlint --type-aware lab/cascade-argmax`, and `bun lab/cascade-argmax/report.ts`.

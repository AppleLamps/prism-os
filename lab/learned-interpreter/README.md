# Learned interpreter: recovering two instructions

## Question and current result

Can learning recover a reusable program, rather than a separate answer for each input? This experiment fixes a tiny interpreter and learns its program choices. Four runtime inputs change on every example; the same program must work across examples.

The September reassessment changes the earlier conclusion. Separate instruction distributions do learn composition in this experiment. An Adam epsilon that dominated small gradients caused most of the reported hard-loss failure. Correcting epsilon recovers all 60 tested coordinate programs and 59 of 60 two-add programs on the integer training domain. The stricter fractional checks also matter: only 15 of those 60 two-add runs preserve the specified FP32 addition grouping.

Those are two different results: an optimizer improvement and a training-domain limitation. Neither establishes scalable program synthesis. The hard-loss method still evaluates every complete program before training.

## Interpreter and numeric contract

The vocabulary contains `add`, `subtract`, and `multiply`. Instruction 0 chooses an operation and an ordered pair from four runtime inputs: `pointerX`, `panelLeft`, `scale`, and `distractor`. That gives `3 * 4 * 4 = 48` candidates. Instruction 1 also sees instruction 0's result, giving `3 * 5 * 5 = 75` candidates. Each instruction has one distribution over complete candidates, rather than separate operation and operand distributions.

The source table contains four runtime cells and 123 shared program cells. There is no example ID, learned constant, or per-example parameter. The fixed circuit evaluates candidate instructions and sums their masked outputs. After training, leftmost argmax turns each distribution into one exact instruction.

Preserving the instruction boundaries also leaves complete candidate lists available to the gather recognizer. The current hard circuit lowers two selector reads to gathers; the soft circuit still uses weighted sums. That changes execution, not how the program is learned.

All source values are rounded to FP32 when written, including in the independent oracle. Every instruction's result is rounded to FP32. Addition and subtraction use explicit `roundAffine` calls so simplification cannot erase instruction boundaries. Multiplication retains its meaning for differentiation while using the core's ReGLU expansion for forward execution. The circuit report measures operation counts rather than asserting that the old 227-operation graph must remain unchanged.

The coordinate target is:

```ts
const translatedX = Math.fround(Math.fround(pointerX) - Math.fround(panelLeft))
const output = Math.fround(translatedX * Math.fround(scale))
```

The two-add target is:

```ts
const firstSum = Math.fround(Math.fround(pointerX) + Math.fround(panelLeft))
const output = Math.fround(firstSum + Math.fround(distractor))
```

The declared runtime range is `-128..128`. The tested cases are finite and stay within that range; the experiment does not claim to cover every FP32 value. Equality follows `===`, so the sign of zero is ignored.

## Training and certification domains

Training remains the original integer domain: coordinates from `-16` through `16` in steps of two, scales `2`, `4`, and `6`, and an independent distractor. There are 14,739 combinations. The September optimizer comparison does not add fractional examples or silently change the target.

Certification now contains 39,605 cases:

- The original 37,188 integer cases: 12,288 unseen combinations, 324 extrapolation cases, and 24,576 translated inputs. Translation leaves the coordinate target unchanged, not the two-add target.
- 2,401 fractional combinations, including cancellation, small addends, and the smallest positive FP32 subnormal.
- 16 incoming-number cases that require rounding from a JS number to FP32 before arithmetic.

Every case checks the independent instruction-level oracle against the reference and tensor evaluators, and validates the declared one-hot groups. A separate regression checks all 3,600 instruction pairs on four fractional probes, rather than testing only the intended programs. These are bounded tests, not a proof over all FP32 inputs.

Enumeration finds two coordinate programs, differing only in the operand order of multiplication. It finds twelve two-add programs on the integer domain, but only four survive fractional certification. The four preserve the original pairing of `pointerX` and `panelLeft`; each individual addition may exchange its two operands.

For example, `pointerX = 1`, `panelLeft = 2^-24`, and `distractor = -1` give zero for `(pointerX + panelLeft) + distractor` after FP32 rounding. Computing `(panelLeft + distractor) + pointerX` gives `2^-24`. Integer examples alone cannot identify which grouping is required.

## The optimizer correction

The hard-loss matrix stores the mean of `0.5 * ((prediction - target) / lossScale)^2` for every complete program. Separate instruction probabilities optimize `p0^T L p1`; the joint control uses one distribution over all 3,600 programs. Their gradients are derivatives of the probability-weighted loss, not gradients through a hard program decision.

Both trainers expose `lossScale`, `lossMultiplier`, and `adamEpsilon`. Defaults for hard-loss training are `256`, `1`, and `1e-14`. The old hard-loss epsilon was `1e-8`. The soft-output trainer also exposes epsilon, but retains its original `1e-8` default because the hard-loss result does not establish the right setting for a different objective.

The phase schedule is unchanged: 500 Adam steps at temperatures `2, 1, 0.5, 0.25, 0.125`, with learning rates `0.02, 0.02, 0.01, 0.005, 0.002`. Adam's moments reset between phases.

Multiplying all gradients by a positive factor `c` is mathematically equivalent to dividing Adam epsilon by `c`, apart from numerical rounding. The direct control compares epsilon `1e-14` with epsilon `1e-8` and a loss multiplier of one million. The loss table is not modified. All 120 paired runs choose identical hardened programs. Final probabilities differ slightly: the largest measured absolute difference is about `7.2e-7` for two-add and `1.2e-13` for coordinate.

## Hard-loss results

Each cell reports integer-domain success, followed by full fractional certification in parentheses. Every row has 20 seeds. Training success and integer certification success agree in these runs.

| Task and seeds | Original epsilon | Corrected epsilon | Equivalent scaling | Joint distribution | Exact coordinate updates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Two adds, original 501-520 | 0 (0) | 19 (5) | 19 (5) | 20 (6) | 20 (6) |
| Two adds, reassessment 1001-1020 | 0 (0) | 20 (3) | 20 (3) | 20 (8) | 20 (3) |
| Two adds, fresh 4001-4020 | 0 (0) | 20 (7) | 20 (7) | 20 (8) | 20 (8) |
| Coordinate, original 541-560 | 0 (0) | 20 (20) | 20 (20) | 20 (20) | 20 (20) |
| Coordinate, reassessment 1001-1020 | 0 (0) | 20 (20) | 20 (20) | 20 (20) | 20 (20) |
| Coordinate, fresh 4001-4020 | 0 (0) | 20 (20) | 20 (20) | 20 (20) | 20 (20) |

The original seed ranges refer to the earlier factorized study. The joint control here uses those same seed ranges for comparison, rather than the earlier joint study's separate 521-540 and 561-580 ranges. Seed 519 remains a two-add failure with the corrected settings. The settings were not retuned to eliminate that failure.

Exact coordinate updates start from each old trainer's hardened result. Each update checks all 75 second instructions while holding the first fixed, then checks all 48 first instructions while holding the second fixed. Only strictly lower losses replace the current choice. Every original failure reaches zero integer-domain loss in one sweep: 124 table reads including the starting score. Those are additional reads after the old training run, not the total cost of finding a program from scratch. This is a useful repair baseline, not evidence that coordinate descent always finds the global optimum.

Direct enumeration uses 3,600 table reads and chooses the first minimum. On these tasks, that chosen program also passes full certification. Building either task's table already requires 707,472 first-instruction evaluations and 53,060,400 second-instruction evaluations, and stores 28,800 bytes. Every trainer and search baseline reuses that cost. No method here avoids exhaustive evaluation by learning from executions alone.

The detailed settings, per-seed results, unique programs, and mismatch counts are in [study-results.json](./study-results.json). Verification is reused for identical task/program pairs, because their outputs do not depend on the training seed.

## The earlier soft-output experiment

The earlier method averages candidate outputs inside the interpreter, then differentiates the output error using the circuit's backward pass. It uses 64 sampled examples per step. The exact hard-loss experiment instead scores each hard program before averaging losses, so wrong outputs cannot cancel each other into a correct target.

Before the September fixes, the soft-output study reported 11/20 coordinate recovery on evaluation seeds, 0/20 two-add recovery with the full vocabulary, and 20/20 integer-domain recovery with add fixed. Those are historical results, not assertions that tests should preserve. The primitive and removed-intermediate controls show that individual instructions can be learned and the target needs an intermediate. They do not establish the cause of optimization failure. The proposed explanation that multiplication strengthens useful gradients also needs a separate comparison.

The current rerun includes the core multiplication-gradient fix and explicit instruction rounding. It retains the old soft trainer's epsilon and phase schedule. Training and integer-certification success again agree.

| Soft-output task and seeds | Integer recovery | Full fractional certification |
| --- | ---: | ---: |
| Coordinate, original 101-120 | 11/20 | 11/20 |
| Coordinate, fresh 6101-6120 | 11/20 | 11/20 |
| Two adds, full vocabulary, original 421-440 | 0/20 | 0/20 |
| Two adds, full vocabulary, fresh 6201-6220 | 0/20 | 0/20 |
| Two adds, add fixed, original 441-460 | 20/20 | 9/20 |
| Two adds, add fixed, fresh 6301-6320 | 18/20 | 5/20 |

The arithmetic fixes do not resolve this trainer's multi-operation failures. They also do not make integer-only examples identify an FP32 grouping. The two fresh add-only failures show why the old 20/20 result should not be described as a universal guarantee. Settings, decoded programs, and mismatch counts are in [study-results-with-soft.json](./study-results-with-soft.json).

## Limits and next question

The meaningful improvement is that instruction-level composition was not blocked by the representation in this two-step task. Numerical settings mattered. The next unresolved distinction is whether training can choose the required FP32 grouping from examples that actually distinguish the alternatives. The present integer training grid cannot answer that question.

The experiment still learns only one shared straight-line program of two instructions. It does not test data-dependent choices, loops, varying collection lengths, or UI generation. A later comparison can add tasks or instructions, but should retain direct search baselines and account for the full loss-table cost. A beam search also needs a defensible way to score unfinished programs; their current output error need not predict whether a correct completion exists.

## Reproduce

- `bun test lab/learned-interpreter` runs focused semantic, gradient, optimizer-control, and regression checks. It no longer spends minutes asserting that a particular seed study must fail.
- `bunx tsgo -p lab/learned-interpreter` and `bunx oxlint --type-aware lab/learned-interpreter` run the scoped static checks.
- `bun lab/learned-interpreter/report.ts --write` reruns the frozen and fresh hard-loss seed studies and writes `study-results.json`.
- `bun lab/learned-interpreter/report.ts --soft --write` additionally runs the six old and fresh soft-output groups and writes `study-results-with-soft.json`.

Reports use real-arithmetic derivatives evaluated on rounded forward values, as ordinary numerical autodiff does. They do not claim literal FP32 rounding is differentiable.

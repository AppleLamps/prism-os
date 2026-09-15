# Current results, September 2026

This is the current summary after implementing the [reassessment](reassessment-2026-09-03.md). The July briefs and old measurements remain historical; they are not requirements for new experiments. The protected author notes in `ideas.md` and the README TODO were left intact, so consult this page and the current numeric-contract documents for implementation status. `tricks.md` was renamed to `expressions.md` and rewritten on September 15, 2026, with Cheng's approval, and is no longer protected.

## What learns

| Experiment | What changes during training or search | Held-out result | Main limitation |
| --- | --- | --- | --- |
| [Two-instruction interpreter](learned-interpreter/README.md) | Shared instruction probabilities, then two hard instructions | Corrected hard-loss optimizer: coordinate 60/60; two adds 59/60 on integers, 15/60 with fractional FP32 checks | Integer training cannot determine addition grouping. The hard-loss method evaluates all 3,600 complete programs before training. |
| [Reusable layout](reusable-layout/README.md) | 121 shared parameters predicting each item's preferred width | Trained on 4/8 items; tested 6/12, new widths, longer captions, and different crops. Every required item retained in the study. | Learns an authored preference objective, not human taste. Ordinary JS performs text measurement and flow layout. |
| [User effort](user-effort/README.md) | Five shared coefficients predicting task duration | 192 held-out observations: 1.68 ms error against the simulator mean. Chooses the simulator's best candidate in 120/120 situations, including 20/20 unrestricted cases. | Predictor features deliberately match the simulator. No human observations, error prediction, or usability claim. |
| [Data adapters](data-adapter/README.md) | Exact search over 868 programs | Eight tasks recovered from 12 training scenes; all pass 438 held-out scenes with new counts, storage orders, and fractional values. | No neural training. Lookup predicates and the rule for extracting a reusable function are authored. Capacity is 12. |
| [Event window](event-window/README.md) | Six shared behavior parameters | Regression study trains from six starts and requires at least five to pass two unseen 10,000-frame traces. | Training supplies correct internal state and decision labels. Persistent state and temporal dependencies remain. |
| [Generative fields](generative-fields/README.md) | Fields for one layout instance | Search and gradient tests pass; new audits separately report required content and strict containment. | Historical repair could hide content, and valid samples do not establish a smooth valid interpolation. |
| [Cascade selection](cascade-argmax/README.md) | Per-case score cells through softened comparisons | A single clipped ramp recovers 160/160 table selections over ten fresh seeds before exact hardening. | This fits a table, not a shared query/key rule. Hard score gradients still provide no useful learning signal. |

Learned parameters can occupy source cells beside changing application inputs. That storage choice does not turn parameter fitting into a different learning algorithm. The reusable layout and effort models train shared parameters once, then replace only features at inference.

## Reusable layout

Run `bun run start:reusable`. The demo compares ordinary wrapping, search for each layout, and the shared learned rule. Controls change viewport width, collection, item count, and captions. All methods keep reading order and required content; scrolling is allowed.

Lower preference loss is better under the explicitly authored objective:

| Test set | Wrapping | Per-layout search | Shared rule, three seeds |
| --- | ---: | ---: | ---: |
| New counts and widths, short captions | 0.3727 | 0.0229 | 0.0259-0.0266 |
| Longer captions and unfamiliar crops | 1.0530 | 0.1987 | 0.2854-0.3079 |

The shared rule transfers well on the easier set and leaves a visible gap on the harder set. This is learned responsive sizing within a fixed flow layout, not generation of arbitrary page structures. The wrapping baseline uses a fixed preferred width; we have not shown that the model beats a carefully tuned responsive formula or measured how much it improves on a width-only model. Every method has zero measured missing items, text overflow, horizontal overflow, and overlap in those sets. Resize sweeps still find abrupt reflow. The photo corpus is shared between training and evaluation; different crops are not new photographs.

## Correctness changes

- Whole multiplication and selection retain their meaning for differentiation while expanding to the existing forward atoms. Multiplication at zero now has the intended derivative in either operand order. Boolean surrogate gradients require an explicit option.
- Selection uses two masked products, avoiding overflow from subtracting large finite candidates.
- `roundAffine` preserves evaluation boundaries, constant and duplicate terms, and term order through inlining. Ordinary `affine` remains a simplifiable builder expression.
- Numeric bounds follow rounded FP32 operations and account for overflow. Min/max no longer claim ideal mathematical bounds where their arithmetic can drift. Their preserved rounding and weaker bounds cost some additional layers and live operations.
- The trace compiler propagates returns, rejects mutations in runtime conditional expressions it cannot safely handle, and compares nullable values correctly. Its source interpreter is independently checked against native JavaScript; intentional FP32 drift is reported separately.
- Real-source compiler tests use a verified historical source fixture. Compatibility with the latest external file is an optional `--live` check, not an assumption that another repository remains unchanged.
- Layout fitness includes direct parameter derivatives. The event demo retains queued and browser-coalesced pointer moves, including outward-and-back movement that cancels a click.

See [execution semantics](../execution-model.md), [macro contracts](../macro-ranges.md), and the regression tests for exact domains. This is not a proof of all possible circuits or all JavaScript programs.

## Retrieval and execution

Gather lowering recognizes 26 candidate-gallery reads and 12 window-manager reads. Sparse weights drop from 940 to 848 and from 11,742 to 11,598 respectively when comparing lowered and unlowered versions of the same current circuits. Candidate-index tables and candidate computation remain. The pass optimizes retrieval after selection; it does not discover query/key scoring.

`createTensorEvaluator(roots)` reuses execution buffers and returns only requested outputs. The returned array is overwritten on the next call. Existing evaluators still return fresh full arrays. [Runtime measurements](runtime-cost/README.md) compare those paths with a direct scalar-JS baseline for the small coordinate calculation. All measurements are CPU execution, not GPU results, and do not isolate the cost of each September semantic change.

## Verification and reproduction

- `bun run check` checks root code, standalone lab scripts, and each scoped lab, without reading `exp/`.
- `bun run test` runs root and lab regression tests. Latest integrated run, at commit a915dcb on September 3, 2026: 274 passing tests, no failures.
- `bun lab/learned-interpreter/report.ts --soft --write` reruns the expensive hard and soft seed studies separately from regression tests.
- `bun lab/reusable-layout/study.ts --write` regenerates the three-seed layout study and the preselected seed-17 model.
- `bun lab/user-effort/report.ts`, `bun lab/data-adapter/report.ts`, and `bun lab/runtime-cost/report.ts` reproduce the smaller studies.
- `bun lab/trace-compiler/report.ts` runs the independent native checks and circuit comparisons on the frozen fixture.

The reusable-layout demo was checked in the browser at desktop and 390/320-pixel phone widths. All twelve photo assets rendered; controls changed the displayed layout; inspected views had no overlapping photos, clipped caption lines, page-level horizontal overflow, or browser errors. This complements the numerical tests; it is not a human usability study.

## Still open

The next interpreter question is whether fractional training examples identify the required addition grouping. Scaling to longer programs without a complete loss table, learning a search guide across task families, and discovering shared query/key functions remain untested. The data-adapter baseline supplies a small exact task and independent oracle for that next comparison.

For UI, the next evidence should come from broader content and an explicit human task, not from interpreting synthetic preference scores as usability. GPU execution, a general JavaScript compiler, learned arbitrary abstractions, and a full learned UI runtime are not delivered by these experiments.

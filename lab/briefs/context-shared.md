# Shared context for experiments

Updated September 2026 after the reassessment. Read `lab/reassessment-2026-09-03.md` for the findings that prompted the changes, and `lab/status.md` for current results. The original July brief promoted several hypotheses to established conclusions. Do not inherit those conclusions from older conversations without checking their evidence.

## Goals

Indirect explores whether making state and behavior into smaller numeric pieces enables useful new computation, learning, and generative UI. It is an art/science project, not an exercise in replacing every conventional UI technique for production.

Read Cheng's talk in `lab/briefs/talk-repeatable-breakthrough.md`, the repository's `agents.md`, and the current `~/github/chenguini/docs/engineering.md`. Cheap prototypes, clear measurements, and useful pivots matter. Do not constrain a new experiment to reproduce a prior agent's preferred architecture.

The concrete goals are to explore neural methods on the numeric representation, generate useful layouts not individually specified, and understand small exact interpretable forms of computation. Recovering familiar mechanisms can be interesting, but naming something attention or recurrence is not itself a result.

## Do not read exp/

Cheng explicitly excluded the older `exp/` experiments because they would bias new work. Do not read that directory. Durable constructions can be found in the current core and documentation. Historical outcomes are evidence within their measured domains, not design instructions.

## Current representation

Browser inputs and persistent state enter a flat `Float32Array`. A fixed circuit computes next state and render outputs. The execution atoms are affine, ReGLU, and boolean. The executor currently runs serial JavaScript over sparse arrays; GPU performance has not been established.

Behavior parameters may live in the same source table as runtime inputs. Their role depends on how they are shared and updated: a global learned parameter is still a parameter, not a new kind of learning because it occupies an input cell. Per-layout optimization, learning one reusable program, and learning a predictor from context to layout are distinct experiments.

`Circuit.roundAffine` preserves a required FP32 evaluation. Multiplication and selection retain semantic metadata for differentiation while expanding to the existing forward atoms. The reference backward pass rejects boolean decisions by default; callers can explicitly request a straight-through derivative. Keep exact forward claims separate from the chosen training gradient.

Declared one-hot groups let selected sums lower to indexed reads when finite FP32 candidate bounds justify the transformation. Retrieval after a known selection is not discovery of query/key scoring. The executor may still scan a selection group and compute all candidate values.

## Hypotheses to test, not assume

- Smaller numeric units may enable useful learned behavior. They do not automatically make optimization easy or objectives meaningful.
- Shared item functions can respect permutation of storage positions if identity, reading order, and every relevant field travel with each item. This is not automatically convolution and does not force attention.
- Continuous fields are easy to interpolate numerically. Validity, required content, text fit, and continuity of the resulting layout must be measured separately. A wrap or sort can still change abruptly.
- Fitting a layout to a score does not establish a predictor that generalizes to new content. A low score can also hide content if visibility is adjustable.
- Supplying correct internal state can make one-step event training sufficient for a supervised task. Persistent state remains recurrence; event-triggered updates alone do not solve learning from delayed consequences.
- An exact sign cascade can replace a boolean decision in forward execution under its numeric assumptions. Training still uses a soft relaxation; removing the boolean atom does not create useful gradients through a hard choice.
- Ordinary source can compile when its supported subset, precision, side effects, and resource limits are defined. A subset compiler is viable; arbitrary JavaScript support is not an assumption.
- Symmetry, candidate search, learned abstractions, and ordinary shader autodiff are useful comparison points. None is an inevitable architecture derived from this project's representation.

## Verification

Use independent checks where possible. Two interpreters sharing a control-flow mistake can agree while disagreeing with native JavaScript. Check the source interpreter against native execution, then measure intended FP32 differences separately.

State the domain of exactness. Small-integer tests do not establish FP32 associativity. Round inputs consistently. Check gradients of complete macros at ordinary values and relevant boundaries, not just gradients of primitive pieces. Include numerical controls such as loss scale and optimizer epsilon before diagnosing an architectural failure.

Use held-out inputs and seeds, but also test the kind of generalization claimed: new counts, widths, aspect ratios, content lengths, identities, or task families. A per-case table cannot establish a shared rule for unseen cases.

A useful UI needs more than one validity bit. Report required content retained, text fit, overflow, preference fit, and transitions separately. Human usability requires human evidence. Synthetic user models can test machinery, not establish what real users prefer.

## Work conventions

Keep a new experiment in its own `lab/` folder with a scoped `tsconfig.json`, focused tests, a runnable report, and a README explaining what learns, the training data or objective, held-out evaluation, limits, and reproduction commands. Keep expensive seed studies in report commands instead of tests that insist a particular optimizer must keep failing.

Do not edit unrelated files or commit unless asked. Preserve ongoing user changes. Coordinate shared core changes before editing. New findings should update current documentation without rewriting historical measurements as though the new implementation produced them.

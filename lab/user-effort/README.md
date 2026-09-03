# Predicting Effort, Then Choosing a Layout

A small synthetic demonstration of two separate jobs: learn how long a task might take, then choose a permitted layout for explicitly supplied tasks. It does not learn what the user should want.

## Run

From the repository root:

```sh
bun lab/user-effort/report.ts
bun test lab/user-effort
bunx --no-install tsgo -p lab/user-effort/tsconfig.json
bunx --no-install oxlint --type-aware lab/user-effort/*.ts
```

The report prints prediction errors, learned parameters, candidate comparisons, three additional training seeds, and sample observations with full geometry and selection probabilities. `createObservations` returns the complete in-memory log; no human data is read or written.

## What Is Authored and What Learns

The simulator supplies noisy durations in milliseconds:

```text
difficulty = log2(1 + distance / targetWidth)
meanDuration = 200 + 110 * difficulty + 180 * clutter
             + 80 * motorContext + 65 * motorContext * difficulty
observation = meanDuration + uniform noise between -35 and +35 ms
```

`distance` is measured from the starting pointer to the target center. `clutter` and `motorContext` are authored numbers between zero and one. Clutter is a layout descriptor, not measured from rendered pixels; motor context is supplied, not inferred from a person's history. Height is checked for validity but does not affect the duration formula.

The predictor learns five coefficients from observed durations, starting from zero. Its feature formula deliberately matches the simulator: this is linear regression with an authored interaction, not discovery of a new behavioral law. Geometry and the logarithm are fixed JS preprocessing. Multiplication, the interaction, and summation run through `Circuit.multiply`, `roundAffine`, and the reusable tensor evaluator. Training uses the core's reverse-mode derivatives.

The source table contains five learned parameters and three varying features. The circuit has six operations and three layers. A full-batch Adam optimizer fits the parameters once, in seconds, using 800 updates, learning rate `0.04`, and epsilon `1e-8`. Inference replaces only the features. It neither changes the parameters nor optimizes a new input for each observation.

## Train and Test Separation

There are 720 training observations and 192 held-out observations. The generators use independent seeds, 731 and 947. The held-out distances, widths, clutter values, and motor contexts do not appear in training, but remain within the same authored family and training ranges. The report lists horizontal offsets; actual movement distances also include the target's vertical offset. This is interpolation, not a test of unfamiliar human behavior.

For each combination, the presentation policy randomly selects one of three control arrangements with probability `1/3`. A separate random choice assigns the task with probability `1/3`. Each observation records both probabilities, the task, pointer position, context, complete shown layout, and noisy duration. Required controls remain present. A layout stays fixed for its single simulated attempt.

Training only consumes observed durations. The simulator's noise-free mean is used afterward for evaluation. The four layouts used for selection are not in the training log; their widest target is 104 pixels, slightly beyond the 96-pixel training maximum. Selection uses five explicit task distributions, four new context values, and six designer-constraint combinations, for 120 situations. These evaluation cases and the simulator mean never update model parameters. The study does not tune hyperparameters against these test cases.

## Results

Observed September 3, 2026. Errors are root-mean-square errors in milliseconds.

| Prediction measurement | Error |
| --- | ---: |
| Training, noisy observations | 20.31 |
| Held-out, noisy observations | 20.22 |
| Held-out, simulator mean | 1.68 |
| Constant training-mean baseline, held-out simulator mean | 133.94 |

Three fresh training seeds give held-out mean errors of `0.76`, `0.67`, and `0.86` ms. The injected uniform noise has a standard deviation of about `20.21` ms, so the noise-level observation error is expected in this deliberately favorable setting.

Layout selection minimizes probability-weighted predicted duration. Every method receives the same task probabilities and constraints. Each candidate must contain confirm, details, and cancel exactly once, have no overlapping or out-of-bounds controls, and meet minimum target width and maximum clutter rules. Invalid candidates are excluded; no method can improve its score by hiding controls. If none qualifies, selection returns `null`.

| Selector | Mean simulated duration | Best candidate matches |
| --- | ---: | ---: |
| Learned effort | 606.37 ms | 120/120 |
| Shortest expected distance | 624.08 ms | 88/120 |
| Simulator-optimal among these candidates | 606.37 ms | 120/120 |

Some constraints allow only one candidate, making those cases trivial. Among the 20 situations where all four candidates are allowed, learned effort matches the simulator's choice 20/20; shortest distance matches 0/20 and costs an extra `102.58` ms on average. The three fresh training seeds also match 120/120. These are synthetic comparisons against a deliberately incomplete distance-only baseline, not evidence of an advantage over established layout methods.

For example, with an 80% confirm task probability, the model chooses the layout with a wider confirm control. Switching the 80% probability to details chooses the wider details control without retraining. Requiring every control to be at least 72 pixels wide forces the balanced candidate. Probabilities are explicit task requirements, not observed click frequencies interpreted as preferences.

## Limits

- This is a test of the separation between prediction and goals. Both the simulator and the predictor's functional form were supplied by us. There are no human usability results.
- The model predicts duration only. It does not predict mistakes, discover user intentions, infer accessibility needs, or generate new layouts. The optimizer chooses among four authored candidates and assumes the next task starts from the supplied pointer position.
- The simulator has no fatigue, learning, switching cost, failed attempts, or hidden context. All attempts succeed. Those omissions make duration much easier to model than real interaction.
- Recording selection probabilities does not itself establish causal identification. The prototype does not perform an off-policy estimator, claim randomized human evidence, or show that its synthetic predictions transfer to human logs.
- Candidate selection uses point predictions, without uncertainty estimates. Before using human data, define success and errors explicitly, collect permitted observations with a known presentation policy, hold out people or sessions, and compare predicted improvements with observed outcomes.

The tests check numeric gradients including zero-valued parameters, reference/tensor agreement, deterministic data, held-out separation, frozen parameters, explicit goals, storage-order independence, and content-preserving constraints. They do not test human behavior or GPU performance.

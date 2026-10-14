# Differentiability, and static bounds

This section answers three questions. Which parts of today's programs give useful gradients? Which of the known tricks for training through steps and decisions would change the program that runs in the browser, and which only change training? And can springs be trained later, given that unrolled loops look expensive to backpropagate through? The section ends with the pattern from Cheng's note: every quantity that looks dynamic gets a static upper bound and a named fallback, and those bounds also fix the size of the backward pass.

Differentiability is a later concern for this project. Nothing below needs to change in the prototypes now. Two habits keep a later backward pass correct: build products and selects with the `circuit.multiply` and `emitSelect` macros, and keep any number you might want to learn in a cell instead of writing it into a weight while building. The second habit costs operations, e.g. a spring whose stiffness and damping are cells spends 546 operations on its frame matrix, i.e. the step matrix raised to this frame's step count, against 119 when spring-bank writes the powers into weights (see below).

The runnable examples are in [examples/differentiability](../examples/differentiability/). From the repo root, `bun test lab/ui-exploration/guide/examples/differentiability` runs 8 tests in about 0.2 s. Seven of the tests check gradients from the backward pass against central finite differences of a float64 twin, while the eighth checks water-fill.ts's implicit gradients, written in plain JavaScript, against central differences of its bisection solver. `bunx tsc -p lab/ui-exploration/guide/examples/differentiability` typechecks the folder, and `bun lab/ui-exploration/guide/examples/differentiability/report.ts` prints every number this section attributes to the examples.

## Short answers

**Which operations give useful gradients?** Affine sums, products and selects do. ReLUs do, except at their corner. Exact decisions don't: a decision is a step, whose slope is 0 on both sides, so the backward pass either throws (the boolean atom), reports 0 (the sign cascade, and integer bits on whole numbers), or reports the slope of a ramp that the program never uses. A read at a computed index gives useful gradients to the table's values. Toward the index, the backward pass reports the slope of a linear interpolation between neighboring entries, which the read never uses because the index is always a whole number, e.g. 32 at rowIndex 3 in the table below. numeric-ui-core.ts's index read instruction makes that choice explicit: its backward pass throws when a gradient reaches the index, unless the caller passes `{indexGradient: 'zero'}` or `{indexGradient: 'backward-difference'}`.

**Is a spring differentiable?** Yes, when stiffness, damping and the step duration are cells that the circuit turns into the step matrix. An example that raises the step matrix to a runtime step count by repeated squaring gave gradients of the position after 1 to 300 steps within 1.3e-4 relative error of float64 central differences, for stiffness, damping, step duration, destination, initial position and initial velocity, over 1,080 checks. spring-bank's fast variants compute the matrix powers while building or in JavaScript, so their gradients stop at the frame matrix, and JavaScript would have to finish the chain rule for stiffness and damping. Their settle snaps, and the clocks of three of the four variants, use boolean atoms, which make the default backward pass throw. The default spring that Cheng decided on September 14, 2026 works like spring-bank's source-matrix variant: `emitApplySpringMatrix` in numeric-ui-core.ts reads a matrix that JavaScript writes, so the backward pass reaches the 4 matrix cells, and `emitAnimatedObject`'s settle bit is a boolean atom.

**Is unrolling expensive for backpropagation?** For 300 steps unrolled, the backward pass walks 2,102 operations and stores 2,108 values. Unrolled with a mask per step, so that the count can come from the frame's timestamp, it walks 4,202 operations and stores 4,508 values for any count up to 300. The matrix-power form walks 562 operations and stores 577 values for any count up to 511, and took about 5 µs against 62 µs for 300 unrolled steps. The gradient of a loop that settles doesn't need the loop's history at all: implicit differentiation gets the settled state's gradient from the equation the settled state satisfies.

**Do the tricks change the exact computation?** None of them has to. The straight-through estimator changes only the backward pass. Soft relaxation, Gumbel-softmax and the score-function estimator change only what runs while training. Implicit differentiation changes only how a gradient is computed. Smoothing changes the forward pass only if the smoothed version ships. The recommendation matches Cheng's preference: keep the run-time program exact, take gradients where the math is continuous, and for discrete choices search over instances, or train a soft version and run the exact one.

**Can every quantity that looks dynamic get a static bound?** In the prototypes, yes: steps per frame, queued events, lines of text, characters, DOM nodes, pointer samples, release velocities and numeric ranges all have a maximum chosen while building, and each maximum has a fallback that's part of the behavior, e.g. JavaScript splitting a frame's events into several evaluations, or an overflow bit that the page shows as a warning. Past the 300-step cap, spring-bank and chenguini carry the remaining time into later frames, where Cheng's note has the spring snap to the destination, and host-timing.ts's `advanceFrame` now snaps every animated object onto its destination. A fixed bound also means a backward pass of fixed size.

## Terms

The [glossary](../README.md#glossary) defines gradient, backward pass, straight-through, finite difference, frozen decisions, relaxation, annealing, hardening, softmax and argmax. This section also uses:

- **Central difference**: a finite difference taken across both sides of an input, `(f(x + h) − f(x − h)) / 2h`. **One-sided differences** take one side, `(f(x) − f(x − h)) / h` on the left and `(f(x + h) − f(x)) / h` on the right.
- **Corner**: an input where the slope changes abruptly. E.g. `relu(x)` at `x = 0` has slope 0 on the left and 1 on the right, and a central difference there gives 0.5, which is neither side.
- **Step**: a function that jumps at a threshold and is flat everywhere else. E.g. `[pointerX > windowLeft]` has slope 0 away from the threshold and no slope at the threshold, where `[condition]` means 1 when the condition holds and 0 otherwise.
- **Estimator**, or gradient estimator: a way to compute a number to train with as a gradient, when the backward pass can't give a useful one. Some estimators approximate a true derivative, e.g. the score-function estimator averages over sampled choices to approximate the derivative of an expected loss. Others, e.g. straight-through, stand in for a derivative that is 0 or doesn't exist, and are also called surrogate gradients.
- **Fixed point**, or settled state: a state that one more step of a loop doesn't change. E.g. a spring sitting on its destination with zero velocity.
- **Backpropagation through time**: the backward pass of a computation that repeats over frames, run from the last frame to the first, where each frame passes the gradient of its incoming state to the previous frame's outputs.

## What is and isn't differentiable today

### How the reference backward pass works

`Circuit.backpropagateReference(values, outputGradients, options)` in numeric-ui-core.ts walks the operations from last to first and reads the forward value of every wire. It differentiates the intended real arithmetic, not the FP32 rounding steps:

- An affine sum passes to each input the output's gradient times that input's coefficient.
- A ReLU-gated product `left × max(0, gate)` passes `gradient × max(0, gate)` to the left side, and passes `gradient × left` to the gate only when the gate is strictly positive. So a ReLU's slope at its corner is taken to be 0.
- An operation built by `circuit.multiply(left, right)` records the product as a macro, and the backward pass differentiates the whole product: `left` gets `gradient × right` and `right` gets `gradient × left`, whichever of the two ReLU-gated products, `left × max(0, right)` or `left × max(0, −right)`, is nonzero in the forward pass.
- An operation built by `emitSelect(gate, off, on)` records a select macro: `off` gets `gradient × (1 − gate)`, `on` gets `gradient × gate`, and the gate gets `gradient × (on − off)`.
- A boolean atom that receives a nonzero gradient throws "cannot backpropagate through a boolean atom", unless the caller passes `{booleanGradient: 'straight-through'}`, with which the atom's gradient goes to its score unchanged. An atom whose gradient is exactly 0, e.g. the gate of a select whose two inputs are equal, doesn't throw, because the pass skips every operation whose gradient is 0.
- An index read built with `circuit.indexRead` passes the output's gradient to the selected candidate, so two reads of the same candidate add their gradients. When a nonzero gradient reaches the read, the pass throws unless the caller passes `{indexGradient: 'zero'}`, which gives the index nothing, or `{indexGradient: 'backward-difference'}`, which gives it `read(i) − read(i − 1)` at `i = floor(index)`, what this backward pass gives a ReLU one-hot read.

Using the backward pass:

```ts
const values = circuit.evaluateReference(source)
const outputGradients = new Float32Array(values.length)
outputGradients[cardRightEdge] = 1
const gradients = circuit.backpropagateReference(values, outputGradients)
// gradients[cardPaddingCell] is d cardRightEdge / d cardPadding
```

### Measured, one operation at a time

[basics.ts](../examples/differentiability/basics.ts) builds one small circuit per row, runs the backward pass, and compares the result with one-sided and central differences of the same arithmetic in float64:

| Operation | Input | Gradient with respect to | Backward pass | Left / central / right difference |
| --- | --- | --- | ---: | --- |
| affine sum `0.25 × a + 3 × b + 1` | a = 10, b = −2 | a and b | 0.25 and 3 | 0.25 and 3 on every side |
| `circuit.multiply(a, x)` | a = 3, x = 0 | x | 3 | 3 / 3 / 3 |
| two ReLU-gated products with no macro, `a × max(0, x) − a × max(0, −x)` | a = 3, x = 0 | x | 0 | 3 / 3 / 3 |
| `emitRelu(x)` | x = 0 | x | 0 | 0 / 0.5 / 1 |
| `emitRelu(x)` | x = 2 | x | 1 | 1 / 1 / 1 |
| `emitSelect(gate, off, on)` | gate = 0.25, off = 10, on = 40 | gate, off and on | 30, 0.75 and 0.25 | the same on every side |
| `emitSelect(gate, off, on)` | gate = 1, off = 10, on = 40 | gate, off and on | 30, 0 and 1 | the same on every side |
| integer bit `[value >= 5]`, i.e. `relu(value − 4) − relu(value − 5)` | value = 4 | value | 0 | 0 / 0.5 / 1 |
| same | value = 4.5 | value | 1 | 1 / 1 / 1 |
| same | value = 5 | value | 1 | 1 / 0.5 / 0 |
| same | value = 6 | value | 0 | 0 / 0 / 0 |
| boolean atom `[a > b]` after a rounding stage with scale 256, default options | a − b = 2^-10 | a | throws | 0 / 0 / 0 |
| same, straight-through | a − b = 2^-10 | a | 256 | 0 / 0 / 0 |
| same, straight-through | a − b = 0.25 | a | 0 | 0 / 0 / 0 |
| sign cascade `[d > 0]`, 2 stages for a resolution of 2^-30 | d = 0.3 | d | 0 | 0 / 0 / 0 |
| same, where the output is 1 | d = 2^-30 | d | 2^30 | 2^30 / 2^29 / 0 |
| same | d = 2^-31 | d | 2^30 | 2^30 on every side |
| one-hot read `rowHeights[rowIndex]` over rowHeights [28, 44, 28, 60, 36, 52, 20, 40] | rowIndex = 3 | rowHeights[3] and rowHeights[2] | 1 and 0 | the same on every side |
| same | rowIndex = 3 | rowIndex | 32 | 32 / 4 / −24 |

**Affine sums, products and selects: yes.** Their gradients equal the central difference in every row. A select passes gradients to both of its inputs and to its gate, e.g. `on − off = 30` to the gate. The gate's gradient is useful when the gate is a continuous blend, e.g. an opacity between 0 and 1. When the gate is an exact decision, the gradient reaches the decision, and what the backward pass does there depends on how the bit was made, as described below.

**ReLUs: yes, except at the corner.** At `x = 0` the backward pass reports the left side's slope, 0. A random input almost never sits exactly on a corner, but whole-number inputs often do, e.g. an integer bit at its threshold, or a parameter clamped at the edge of its declared range.

**Use the macros for products that will be differentiated.** Written as two ReLU-gated products with `x` in the gate, `a × max(0, x) − a × max(0, −x)`, the product `a × x` at `x = 0` gets gradient 0 where the product's slope is 3, because both products' ReLUs sit at their corner. `circuit.multiply` records the whole product and gets 3. The September reassessment found this in `emitMultiply` ([reassessment](../../../reassessment-2026-09-03.md), "Some gradients are wrong for the intended calculation"), and numeric-ui-core.ts now keeps the multiply and select macros for the backward pass. Builders that write the two products by hand still differentiate each product on its own, e.g. spring-bank's `signedProductTerms` (spring-bank.ts:193-200), which only matters when the value in the gate is exactly 0.

**Exact decisions: the backward pass may run, but the gradient isn't useful.** A decision is a step, whose slope is 0 on both sides of every input except the threshold. The three ways to make exact bits, described in the [comparisons](comparisons.md) section, fail in different ways:

- The boolean atom throws by default. With straight-through, the gradient is the score's slope, 256 here, while the score isn't saturated, i.e. for `|a − b| < 2^-9`, and 0 once the score's clamp saturates. The true slope is 0 in both rows.
- The sign cascade doesn't round anywhere, so the backward pass runs through the cascade with no special case. Its real arithmetic is `min(1, 2^30 × relu(d))`, a ramp 2^-30 wide. The gradient is 0 at every difference that is at most 0 or above the resolution, and 2^30 inside the ramp, where the output isn't a bit. The gradient is also 2^30 at exactly the resolution, 2^-30, where the output is 1 but the last stage's upper ReLU sits at its corner and passes nothing. The comparisons section measured the same for a cascade planned for every pair of FP32 values: 0 everywhere except at the plan's resolution, where the gradient overflows to +Infinity.
- An integer bit's real arithmetic is a ramp between `threshold − 1` and `threshold`. On whole numbers, the inputs the bit is built for, the backward pass reports 0, except exactly at the threshold, where it reports the left side's slope, 1. That 1 describes the ramp, not the decision.

That's the difference between "the backward pass runs" and "the gradient is useful". The first is a property of the backward pass: no boolean atom on the gradient path, or straight-through turned on. The second is a property of the math: whether the reported slope gives the direction in which a training loop should move a parameter so that the output gets closer to what it should be. The sign cascade makes the first true and leaves the second false, and cascade-argmax reports the same: "The hard cascade does not provide useful score gradients" ([cascade-argmax](../../../cascade-argmax/README.md)).

**Reads at a computed index: useful gradients reach the table, not the index.** The entry that was read gets the output's gradient and every other entry gets 0, like `gather` in ML frameworks. The read in the table builds its one-hot from tent functions (see the [glossary](../README.md#glossary)), `relu(rowIndex − p + 1) − 2 × relu(rowIndex − p) + relu(rowIndex − p − 1)` for position p, whose real arithmetic interpolates linearly between neighboring entries. So toward the index the backward pass reports the slope of the segment from rowHeights[2] to rowHeights[3], `60 − 28 = 32`, while the segment from rowHeights[3] to rowHeights[4] has slope −24. Neither slope describes a hard read, whose output doesn't change between whole numbers. An index read built with `circuit.indexRead` reports no slope toward the index by default: its backward pass throws, and the backward difference has to be requested with an option. The [indexing](indexing.md#is-a-read-differentiable) section covers reads that are differentiable in the index.

**Frozen decisions.** The true derivative of a program with decisions is the slope inside the current decision region: hold every decision where it is, and differentiate the continuous arithmetic around the decisions. drag-knobs added that option to its copy of the backward pass as "frozen" booleans, which pass nothing to a boolean's score (drag-knobs/backward.ts). On layout-tree's app shell, every mismatch between frozen gradients and finite differences coincided with a visible decision flipping inside the difference's step ([drag-knobs](../../drag-knobs/README.md)). The settle snap example below does the same by copying a decision into a cell. The gradient is then correct and useful for continuous parameters, and 0 for anything that only acts through decisions, e.g. a grid's minimum card width, whose gradient on the dragged edge was 0 at 499 of 500 drag starts.

## Tricks for training through decisions

Each subsection says what the trick is, gives a UI example, says what the trick changes (the run-time forward pass, only the backward pass, or only what runs while training), how much machinery it needs, and whether this repo used it.

### Straight-through estimator

**What it is.** The forward pass keeps the exact step, and the backward pass treats the step as the identity: the step's output gradient goes to the step's input unchanged.

**UI example.** Learning a title bar height from examples of presses: the forward pass computes `[pointerY − windowTop < titleHeight]` exactly, and in the backward pass the loss's gradient on that bit goes to the score before rounding, as if the bit were the score.

**What it changes.** Only the backward pass: `backpropagateReference(values, outputGradients, {booleanGradient: 'straight-through'})`.

**Complexity.** One option, but the gradient is only as good as the shape of the score. A score that saturates, like the rounding stage in the table above, passes its slope (256) within 2^-9 of the threshold and 0 everywhere else, so a parameter far from its threshold gets nothing. A score that never saturates always passes a slope, so an input gets a gradient even when no small change of that input would flip the bit and move an output. In drag-knobs, on candidate-gallery (a demo in lab/candidate-gallery that scores three candidate layouts and shows the best one), straight-through through `emitArgmax`'s comparison differed from finite differences at 592 of 2,250 checks where no recorded decision flipped, e.g. 692,700 px per unit of a quality scale on a thumbnail edge that stayed put, and one gradient step solved 16.5% of candidate-gallery frames, against 37.6% with frozen decisions and nothing else changed (drag-knobs' strategies A and B). generative-fields measured a straight-through slope of 173 where the true local slope was 120.

**Used here?** Yes. generative-fields optimized its layout fields through a straight-through backward pass (generative-fields/ste-backprop.ts), and drag-knobs' strategy A used the option. The removed exp-ste-backprop and exp-ste-reveal experiments used surrogate slopes through the boolean atom ([research-sweep.md](../../../research-sweep.md#superseded)). learned-bits lists a straight-through phase as an idea it didn't try.

### Soft relaxation with annealing, then hardening

**What it is.** Build a soft version of the program in which every exact decision is a ramp, e.g. `clamp01((boundary − measure) × sharpness + 0.5)` without the rounding, and train its parameters with ordinary gradients. Make the ramp steeper while training (annealing), then copy the learned numbers into the exact program (hardening) and check the exact program against a reference.

**UI example.** event-window learned its drag slop distance, its title bar height and four relation cells, e.g. "a drag from the title bar moves the window" and "a click on the body toggles maximize", from single-frame examples. From slop boundaries starting between 12.9 and 40.1 px, all 20 seeds ended with the slop boundary inside (4, 5] and the title boundary inside [29, 30), and every hardened circuit had 0 divergences over 30,000 held-out frames ([event-window](../../../event-window/README.md)).

**What it changes.** Only what runs while training. The soft build is the same builder with the rounding step replaced by the identity, and the run-time program is the exact build.

**Complexity.** A second build mode, a schedule, and a verification pass. The schedule mattered. With a ramp fixed at 4 px wide, for a slop boundary that started 8 px or more away, almost no examples fell inside the ramp, and the boundary didn't move over 76,800 examples, and training that started from the correct values drifted out of the correct bands, so the hardened circuit diverged from the reference 9,120 times over 10,000 frames. Annealing from a 32 px ramp to a quarter-pixel ramp, with the learning rate shrinking and the optimizer's running averages reset between phases, fixed both failures.

**Used here?** Yes. Besides event-window, cascade-argmax trained an 8-candidate selection through a seven-stage soft cascade (160 of 160 correct hard winners over seeds 1 to 10) and through a single clipped ramp (160 of 160 over seeds 101 to 110, with less than half as many operations), then used the learned values in the hard circuit. learned-bits trained discrete unit choices through softmax relaxations and hardened each unit to its most likely choice, and there annealing the softmax temperature from 1 to 0.1 didn't help. expressions.md ("Decision bits") notes that integer-count scores need no second build: `relu(score) − relu(score − 1)` is the exact bit for whole-number scores and the identity ramp for fractional scores between 0 and 1, so training can feed fractional counts through the same expression.

### Gumbel-softmax, and its straight-through variant

**What it is.** A way to learn which of K discrete options to pick, by sampling while training (Jang, Gu and Poole, 2017). Each option has a learned score. Add random Gumbel noise, `−log(−log(u))` for a uniform random u, to each score, and take a softmax at a temperature τ. The result is a random list of weights that adds up to 1, close to a one-hot sample when τ is small, and its gradient reaches the scores. The straight-through variant uses the one-hot of the noisy scores' argmax in the forward pass, and the softmax's gradient in the backward pass.

**UI example.** Choosing which of 4 gallery layouts to show for each range of viewport widths, from a loss on the rendered result: each training step samples a layout for each range and renders a blend of the layouts, or, with the straight-through variant, renders the sampled layout.

**What it changes.** Only what runs while training, when the run-time program takes the exact argmax of the scores. The softmax and the noise need `exp` and `log`, which aren't among the program's operations, so this trick has to run in JavaScript training code or in a separate training program.

**Complexity.** High: random sampling, a temperature schedule, gradients that are biased at a high temperature and noisy at a low one, and, in the straight-through variant, a forward pass and a backward pass that describe different computations.

**Used here?** No. learned-bits learned discrete choices by optimizing the expected output under softmax probabilities, computed exactly with no sampling.

### Score-function estimator (REINFORCE)

**What it is.** Treat a discrete choice as a random draw from probabilities `p(choice; θ)` with learned parameters θ. Run the unchanged program on drawn choices, and estimate the gradient of the expected loss as the average, over draws, of `loss × d log p(choice; θ) / dθ`. The program itself is never differentiated, so its steps and decisions don't matter. Williams (1992) called it REINFORCE, and reinforcement learning uses it as the policy gradient.

**UI example.** Tuning how likely each column count is for a photo grid: render sampled column counts with the exact program, score each render, and raise the probability of the column counts that scored better than average.

**What it changes.** Only what runs while training. The run-time program uses the most likely choice.

**Complexity.** Little code, but noisy: each gradient step needs many draws, plus a baseline, e.g. subtracting the average loss, before the estimate is usable.

**Used here?** No. learned-interpreter optimized separate instruction probabilities against a table of losses for all 3,600 two-instruction programs, i.e. it computed the expected loss `p0ᵀ L p1` exactly ([learned-interpreter](../../../learned-interpreter/README.md)). When the table is too large to build, the score-function estimator estimates the gradient of that expected loss from sampled programs instead.

### Reparameterization trick

**What it is.** When a program samples a random value from a distribution with learned parameters, write the sample as ordinary arithmetic on those parameters and on independent noise from a fixed distribution, e.g. `offset = mean + spread × noise`, with `noise` drawn from a standard normal distribution. The gradient then reaches `mean` and `spread` through ordinary products and sums.

**UI example.** Learning how far confetti particles scatter: JavaScript writes one standard normal sample per particle into a cell, and the program computes each particle's offset as `spread × noise`.

**What it changes.** Nothing at run time. The randomness becomes an input.

**Complexity.** Low, and it only matters if a program samples random values. None of the prototypes samples inside a circuit: e.g. spring-bank's random fling destinations ([predictive.ts at the tag](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/spring-bank/predictive.ts)) are computed in JavaScript at event time and written into cells, so a gradient stops at the destination cell. To learn how far flings travel, the circuit would compute each destination from a learned spread cell and a noise cell that JavaScript writes, e.g. `flingDestination = releasePosition + flingSpread × noise`.

**Used here?** No.

### Implicit differentiation of fixed points

**What it is.** When a loop runs until its state stops changing, the settled state satisfies an equation, `state* = step(state*, parameters)`. Differentiating that equation, instead of the loop, gives the gradient with one linear solve the size of the state: `(I − ∂step/∂state) × d state* / d parameter = ∂step/∂parameter`, evaluated at the settled state. The solve needs the matrix `I − ∂step/∂state` to be invertible at the settled state, i.e. the equation must have exactly one settled state near the current one. E.g. a spring with stiffness 0 stays wherever it stops, so every position with zero velocity is a settled state, and implicit-spring.ts returns NaN. A flex row whose container is wider than its children's maximum widths added up has no growing child, so water-fill.ts's formula divides by 0. The loop's iterations and their count don't appear, so nothing about them has to be stored. Deep equilibrium models (Bai, Kolter and Koltun, 2019) train networks whose output is a settled state this way.

**UI examples.**

- A spring's settled position. [implicit-spring.ts](../examples/differentiability/implicit-spring.ts) solves the 2×2 system. The settled state is the destination with zero velocity, so the settled position's gradient is 1 for the destination, and 0 for stiffness, damping, the step duration, and the starting position and velocity. Over 20 random springs, those gradients were within 1.04e-10 of central differences of a 4,096-step float64 simulation. That check can only confirm 1s and 0s, because at the settled state every parameter's slope except the destination's multiplies a distance or a velocity that is 0. So the example also adds a constant acceleration g, e.g. gravity in screen coordinates, where y grows downward. The spring then settles g / stiffness below its destination, the stiffness slope in the solve multiplies that distance, and the settled position's gradient with respect to stiffness is −g / stiffness², e.g. −0.0238 for g = 2,000 px/s² and stiffness 290. Over 20 random springs with g between 0 and 4,000 px/s², the implicit gradients, including 1 / stiffness for g itself, were within 1.84e-10 of central differences of the same simulation with gravity. The settled velocity is 0 with or without gravity, so the second column of `I − ∂step/∂state` never affects the result, and no check of a settled spring can test that column.
- A layout solver's result. [water-fill.ts](../examples/differentiability/water-fill.ts) sizes a row the way CSS flex-grow does for children with `flex-basis: 0`, `min-width: 0` and a `max-width`: it finds a level λ where `Σ min(maximumWidth_i, λ × growWeight_i) = containerWidth`, by 200 rounds of bisection. Carrying derivatives through the bisection loop gives exactly 0, because each round only copies a bound after a comparison. Differentiating the equation gives `dλ / dcontainerWidth = 1 / (sum of the grow weights of the children below their maximum)`. E.g. a 600 px container with grow weights 1, 2 and 1 and maximum widths 120, 400 and 400 px settles at λ = 160, with widths 120, 320 and 160 px, and λ changes by 1/3 per px of container width, so the second and third children grow by 2/3 and 1/3 px. Over 50 random rows and 650 checks, the implicit gradients were within 2.1e-9 relative error of central differences.

**What it changes.** Only how the gradient is computed. The forward loop stays as it is.

**Complexity.** Moderate: you write down the equation the settled state satisfies and solve a linear system. The gradient is only right once the loop has settled. E.g. a spring with stiffness 290 and damping 30 moving from 0 to 100 px still changes its position by 0.083 px per unit of stiffness after 64 steps, by −2.3e-4 px after 150 steps, and by 1e-7 px after 300 steps, where implicit differentiation says 0. At a corner of the equation, e.g. a child exactly at its maximum width, no single slope exists.

**Used here?** Only in this section's examples.

### Smoothing

**What it is.** Replace a corner or a step with a smooth function of a similar shape: softplus, `log(1 + e^(β × x)) / β`, for `relu(x)`, a sigmoid for a step, log-sum-exp for max, and softmax for argmax. A larger β stays closer to the original function.

**UI example.** A layout's quality score `min(widthFit, heightFit)` passes gradient only to the smaller term, so a parameter that only affects the larger term gets 0 until its term becomes the minimum. drag-knobs measured this on candidate-gallery: at viewports without a tie, 554 of 1,284 flip queries whose design number had gradient 0 still found the chosen layout flipping once that number's term became the minimum. A soft minimum passes some gradient to both terms.

**What it changes.** The forward pass, if the smoothed version ships: results stop being exact, and `exp` and `log` would have to be approximated with ReLUs. Used only while training, with the learned numbers then copied into the exact program and verified, smoothing is soft relaxation that uses a smooth function in place of a clamped ramp.

**Complexity.** The math is simple, but the smoothed program is a second program whose results differ from the exact one.

**Used here?** No softplus, sigmoid or soft minimum. The soft builds of event-window and cascade-argmax used clamped linear ramps, which the program's operations express exactly.

### Finite differences and search: no trick at all

**What it is.** Evaluate the exact program at changed parameters: a central difference for each parameter, two evaluations each, or many candidate settings evaluated as instances of the same program, keeping the best one.

**UI example.** In drag-knobs, when a designer drags a card's edge, the host takes a gradient step on the unlocked design numbers. When the step doesn't reach the target or adds overflow, the host evaluates 256 candidate settings as instances of the same circuit, in about 0.5 ms, and keeps the closest valid one. Search is the only way forward in frames where every design number the designer unlocked has gradient 0, which was 24.6% of moving frames on the app shell, e.g. the right edge of a card in the last column.

**What it changes.** Nothing. The program being evaluated is the run-time program.

**Complexity.** The least machinery. The cost grows with the number of parameters for differences, and with the number of candidates for search. Search needs no special handling for decisions, because every evaluation is exact, and a search can cross regions where the gradient is 0. Finite differences do need care: a difference whose step crosses a decision measures the jump, not a slope, e.g. −206.75 across the settle snap below, so this section's settle snap and flex-grow checks skip pairs where a decision flips within the step, e.g. a child reaching its maximum width.

**Used here?** Yes: drag-knobs' search over instances, data-adapter's exact search over 868 programs ([status](../../../status.md)), and every example in this section checks its gradients with central differences.

### What research-sweep.md records about surrogate gradients

research-sweep.md's July notes say that surrogate slopes through the boolean atom, i.e. the removed exp-ste-backprop and exp-ste-reveal experiments, were "made unnecessary by three independent routes": integer-count scores (expressions.md, "Decision bits"), annealed soft ramps (event-window's training), and the relu sign cascade (the trace compiler). The same notes say surrogates "remain relevant only for training through circuits that keep rounding atoms on the gradient path, e.g. emitArgmax comparison trees".

The September update at the top of research-sweep.md narrows that reading: "exact forward execution is distinct from a useful training gradient". The [reassessment](../../../reassessment-2026-09-03.md)'s table of claims to retire replaces "Removing the boolean atom makes exact choices directly trainable" with "The hard cascade's useful score gradients remain absent. The successful experiment trains softened circuits and then hardens them." So of the three routes, only the relaxations supply a useful gradient: annealed ramps, and integer counts fed fractional values while training. The sign cascade removes the throw and leaves a gradient of 0, as the table above shows.

### Recommendation

This follows Cheng's preference for leaving exact calculations alone:

- Keep the run-time forward pass exact and free of tricks. None of the tricks requires changing that pass, and smoothing changes it only if the smoothed version ships.
- Take gradients only where the math is naturally continuous: geometry such as padding, gaps and sizes, spring parameters, layout constants, and values read from tables. Use frozen decisions in the backward pass, which give the true slope inside the current decision region.
- For loops that settle, e.g. a spring at rest or a layout solver, differentiate the settled state's equation instead of the loop.
- For discrete choices, e.g. a column count or which layout gets chosen, search over instances of the exact program, or train a relaxation, harden, and verify the exact program. Keep straight-through, Gumbel-softmax and the score-function estimator for problems with too many choices to search.

The tricks from simplest to fanciest:

1. Finite differences and search: evaluate the exact program, with nothing new to build.
2. Frozen decisions: one option in the backward pass, which only reports slopes that the arithmetic has.
3. Reparameterization: little to build, because JavaScript can write noise into cells, and the program combines the noise with learned cells using ordinary products and sums.
4. Straight-through: one option in the backward pass, but its slopes can be wrong in ways that are hard to notice.
5. Implicit differentiation: one equation per solver and a small linear solve, exact once the loop has settled.
6. Smoothing: a second, approximate forward function.
7. Soft relaxation with annealing and hardening: smoothing, plus a schedule, plus verification of the exact program.
8. Score-function estimator: a short formula, but sampling, a baseline and many evaluations per step.
9. Gumbel-softmax and its straight-through variant: sampling, a temperature schedule, and, in the straight-through variant, a forward pass and a backward pass that describe different computations.

## Springs

### A spring whose step matrix comes from cells

The [springs](springs.md) section explains why n steps of a linear spring are the step matrix M raised to the power n. In [spring-power.ts](../examples/differentiability/spring-power.ts), stiffness, damping and the step duration are cells, so the circuit computes M from wires, and every product goes through `circuit.multiply`, so the backward pass differentiates whole products. Shortened, with comments added:

```ts
export function emitStepMatrix(circuit: Circuit, cells: SpringCells): WireMatrix {
  const stiffnessTimesStep = circuit.multiply(cells.stiffness, cells.stepSeconds)
  const stiffnessTimesStepSquared = circuit.multiply(stiffnessTimesStep, cells.stepSeconds)
  const dampingTimesStep = circuit.multiply(cells.damping, cells.stepSeconds)
  const velocityKeep = circuit.roundAffine([[dampingTimesStep, -1]], 1)
  return [
    circuit.roundAffine([[stiffnessTimesStepSquared, -1]], 1), // 1 − k·dt²
    circuit.multiply(cells.stepSeconds, velocityKeep), // dt·(1 − b·dt)
    circuit.roundAffine([[stiffnessTimesStep, -1]]), // −k·dt
    velocityKeep, // 1 − b·dt
  ]
}

// M^steps. JS writes the step count's binary digits into stepBits, least significant first:
// source[cells.stepBits[digit]] = Math.floor(stepCount / 2 ** digit) % 2
export function emitMatrixPower(circuit: Circuit, step: WireMatrix, stepBits: readonly Wire[]): WireMatrix {
  const identity: WireMatrix = [circuit.affine([], 1), circuit.affine([], 0), circuit.affine([], 0), circuit.affine([], 1)]
  let square = step
  let level: WireMatrix[] = stepBits.map((bit, digit) => {
    if (digit > 0) square = emitMatrixProduct(circuit, square, square) // M, M², M⁴, ..., M^256
    const power = square
    const entry = (index: number) => emitSelect(circuit, bit, identity[index]!, power[index]!)
    return [entry(0), entry(1), entry(2), entry(3)]
  })
  while (level.length > 1) {
    // a balanced tree of 2×2 products combines the chosen factors
  }
  return level[0]!
}
```

`emitApplyFrameMatrix` then multiplies the spring's displacement from its destination and its velocity by the frame matrix, with 4 products. The digits are cells, so the selects pass `on − off` to each digit cell, and a training loop doesn't read those gradients. If the clock ran inside the circuit, the digits would come from boolean atoms, so the default backward pass would throw there, and with frozen decisions no gradient would pass through the digits to the frame delta, which is right: a step count is a decision.

One spring is 562 live operations, 42 layers and 1,108 stored weights, of which the frame matrix is 546 operations in 38 layers. For step counts 1, 2, 3, 7, 16, 64, 100, 255 and 300, with 20 random springs each (stiffness 100 to 700, damping 10 to 50, 4 ms steps, destinations and starting positions 0 to 800 px, starting velocities −2,000 to 2,000 px/s), the gradients of the position after those steps, with respect to all six inputs, matched float64 central differences within 1.3e-4 relative error over 1,080 checks. The error is divided by at least 1e-3, so tiny gradients are compared absolutely. The largest error was a stiffness gradient of 0.00053 that was off by 1.3e-7, about what FP32 rounding of the forward values gives. An absolute comparison doesn't check a tiny gradient's sign: a negated gradient would still pass on 68 of the 1,080 pairs, all at 255 and 300 steps, where the spring has nearly settled. So the check also compares signs wherever the central difference is at least 1e-5, and the signs matched on all 988 such pairs. The other 92 pairs, 2 at 100 steps, 39 at 255 and 51 at 300, are below that floor and aren't compared for sign.

For a spring with stiffness 290 and damping 30 moving from 0 toward 100 px, after 16 steps the position changes by 0.1055 px per unit of stiffness, −0.5047 px per unit of damping, 0.338 px per px of destination, and 0.662 px per px of starting position.

### spring-bank's fast variants stop the gradient at the frame matrix

None of spring-bank's four ways to compute the frame matrix, in [event-time/spring-bank.ts](../../event-time/spring-bank.ts) since September 16, 2026, makes stiffness or damping a wire:

- `split-table` and `binary-powers`: `createConstantPowerGroup(circuit, clock, constants, powers)` takes stiffness and damping as JavaScript numbers, computes `eulerStepMatrix(constants, config.stepMs)` and `matrixPower(step, 2 ** index)` in float64 while building (spring-bank.ts:283-285, and `powerTables` at spring-bank.ts:215-223), and puts the matrix entries into the circuit as coefficients of affine sums (`readConstantTable`, spring-bank.ts:247-254).
- `source-table`: JavaScript writes the power tables into 140 source cells whenever stiffness or damping change, and the circuit reads them through gathers (`createSourceTableGroup`, spring-bank.ts:314-334).
- `source-matrix`: JavaScript computes M^steps and writes 4 cells (`createSourceMatrixGroup`, spring-bank.ts:337-340).

So a backward pass through a spring-bank circuit reaches the 4 frame matrix cells or the 140 table cells at most. With default options it doesn't get that far: the box's settle bit, and in split-table, binary-powers and source-table the clock's threshold bits, are boolean atoms, so the pass throws unless the caller passes straight-through or freezes those decisions, e.g. by copying each bit into a cell, as the settle snap example below does. [source-matrix.ts](../examples/differentiability/source-matrix.ts) leaves out the settle snap, so its backward pass runs, and it shows the consequence with stiffness and damping in cells that no wire reads, like a host that keeps them in the table so a designer can edit them: the backward pass reports exactly 0 for both. JavaScript can finish the chain rule by summing `d position / d entry × d entry / d stiffness` over the 4 entries, with `d entry / d stiffness` from a central difference of the float64 matrix power. After 16 steps that gives 0.1055 for stiffness and −0.5047 for damping, the same as central differences of the whole spring.

What stopping the gradient at the frame matrix costs:

- With `split-table` or `binary-powers`, training stiffness and damping by gradient means rebuilding the circuit after every change, or finishing the chain rule through the build step in JavaScript.
- With `source-table` or `source-matrix`, JavaScript finishes the chain rule over 2 parameters of a 2×2 matrix power: a few lines, and a few float64 matrix products per frame.
- Making stiffness and damping wires instead, as spring-power.ts does, costs 546 live operations for the frame matrix. spring-bank's binary-powers frame matrix added 119 operations to its clock (227 against 108 for the clock alone), and source-matrix adds none.

When stopping the gradient there is fine: whenever stiffness and damping are authored rather than trained, trained offline, or trained by a loop that runs in JavaScript anyway. It stops being fine only if a whole training loop must run as one program with no JavaScript in between, e.g. training many spring instances at once on a GPU.

A smaller gap: spring-bank's springs write each product as two ReLU-gated products without the multiply macro (`signedProductTerms`), so a frame matrix entry that is exactly 0 gets gradient 0 instead of the value it multiplies, like the "two ReLU-gated products with no macro" row in the table above. Two entries are exactly 0 at 0 steps, where the frame matrix is the identity. The identity doesn't depend on stiffness or damping, so a chain rule over stiffness and damping comes out the same.

**The default spring in numeric-ui-core.ts.** `emitApplySpringMatrix` reads the 4 matrix cells that JavaScript writes, like source-matrix, so its gradients stop at those cells too, and JavaScript finishes the chain rule for stiffness and damping as described above. It builds each product with `circuit.multiply`, so the smaller gap doesn't apply: an entry of exactly 0 gets the value it multiplies as its gradient. `emitAnimatedObject`'s settle bit is a boolean atom, so `backpropagateReference` throws there unless the caller passes straight-through or freezes the decision, and a settled object passes its gradient only to its destinations. Each spring stores its displacement from its destination, so the backward pass also reaches the displacement and velocity cells. The rest bit adds the springs' ReLUs times 2^127 inside another ReLU, so at exact rest the backward pass stops at that ReLU's corner instead of scaling gradients by 2^149.

### Unrolled steps against the matrix power for backpropagation

The backward pass visits every operation once and reads the forward value of every wire, so the forward program's size sets the backward pass's work and memory. [backward-cost.ts](../examples/differentiability/backward-cost.ts) measures three forms, with stiffness and damping in cells, for a spring with stiffness 290 and damping 30:

- Unrolled for exactly n steps, with n chosen while building: 7 operations per step.
- Unrolled with a mask per step for up to 300 steps, 14 operations per step for any count: the forward pass computes all 300 copies of the step, and a thermometer of bits written by JavaScript selects which copies' results are kept, so the count can come from the frame's timestamp.
- The matrix power above, for any count up to 511: 8 squarings, 9 selects of 4 entries, and 8 products in the tree, i.e. about 2 log2 n matrix products.

| Form | Steps | Operations walked | Operations that receive a gradient | Stored values | Layers | Backward µs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| unrolled, exactly n steps | 1 | 9 | 9 | 15 | 8 | 0.3 |
| unrolled, exactly n steps | 4 | 30 | 30 | 36 | 26 | 1.0 |
| unrolled, exactly n steps | 16 | 114 | 114 | 120 | 98 | 3.3 |
| unrolled, exactly n steps | 64 | 450 | 450 | 456 | 386 | 13.5 |
| unrolled, exactly n steps | 300 | 2,102 | 2,102 | 2,108 | 1,802 | 62 |
| masked, up to 300 steps | 4 | 4,202 | 333 | 4,508 | 2,402 | 16 |
| masked, up to 300 steps | 300 | 4,202 | 2,701 | 4,508 | 2,402 | 65 |
| matrix power, up to 511 steps | 1 | 562 | 63 | 577 | 42 | 4.0 |
| matrix power, up to 511 steps | 4 | 562 | 79 | 577 | 42 | 3.3 |
| matrix power, up to 511 steps | 300 | 562 | 195 | 577 | 42 | 5.4 |

Timings are medians on a shared machine, so read them as rough. The backward pass skips an operation whose gradient is 0 with one comparison, which is why the masked form is cheaper at 4 steps than at 300: the copies whose results are discarded pass no gradient to their steps.

Unrolled for exactly 4 steps gives the cheapest backward pass for a 60 fps frame, but a circuit can't be built for a count that only arrives at runtime. The forms to compare are the masked unroll and the matrix power, which walk 4,202 and 562 operations on every frame. The masked unroll's memory has a known remedy in ML frameworks, gradient checkpointing: store the state every k steps and recompute the steps in between during the backward pass, which trades a second forward pass for less memory. The matrix power doesn't need it.

Steps that aren't linear, e.g. a spring whose stiffness depends on its position, or items that push each other apart, don't collapse into a matrix power. Those loops need the masked unroll with a small maximum count, or implicit differentiation when only the settled state matters.

### The settle snap

[settle-snap.ts](../examples/differentiability/settle-snap.ts) adds spring-bank's settle snap to the matrix-power spring: when the stepped spring is within 0.01 px of its destination and slower than 0.01 px/s, select the destination and zero velocity on an exact bit:

```ts
// Each ReLU is exactly 0 when its side is within the threshold, and a sum of nonnegative
// FP32 values is 0 only when every term is 0.
const exceedance = circuit.roundAffine([
  [circuit.reglu([], 1, [[stepped.displacement, 1]], -settleDistance), 1],
  [circuit.reglu([], 1, [[stepped.displacement, -1]], -settleDistance), 1],
  [circuit.reglu([], 1, [[stepped.velocity, 1]], -settleSpeed), 1],
  [circuit.reglu([], 1, [[stepped.velocity, -1]], -settleSpeed), 1],
])
const settledScore = circuit.reglu([], 1, [[exceedance, -(2 ** 20)]], 0.5)
circuit.assumeRange(settledScore, 0, 1)
const settled = circuit.boolean(settledScore)
const position = emitSelect(circuit, settled, stepped.position, springCells.destination)
const velocity = emitSelect(circuit, settled, stepped.velocity, zero)
```

What the backward pass says:

- **Through the snapped branch**, the position is the destination cell, so the gradient is 1 for the destination and 0 for everything else, including the incoming position and velocity.
- **Through the moving branch**, the gradients are the stepped spring's gradients.
- **Through the decision**, the boolean atom throws by default. Frozen decisions, here made by copying the settle bit into a cell and selecting on that cell, give the true derivative on both sides. Straight-through gave the same numbers on all 200 springs below. On a snapped spring, every ReLU in the exceedance sum sits at or below its corner, so no gradient gets past those ReLUs. On a moving spring, the settle score `relu(0.5 − 2^20 × exceedance)` is flat unless the spring is past its thresholds by less than 2^-21 in total.

Over 200 random springs at 4, 16, 64, 150 and 300 steps, 24 of which snapped: every snapped spring's gradient was exactly 1 for the destination and 0 for the other five inputs, every moving spring's gradient equaled the plain spring's gradient bit for bit, and straight-through gave the same gradients as frozen decisions on all 200. 1,200 checks against central differences of a float64 twin that snaps by the same rule were within 4.4e-4 relative error, and in none of them did the twin's decision flip within the difference's step.

The moment of snapping has no gradient. After 150 steps from 0 toward 100 px with damping 30, the neighboring FP32 stiffness values 264.88596 and 264.88599 give settle bits 0 and 1 and positions 100.0063 and 100 px, a difference quotient of −206.75 across that pair, while the backward pass reports 0.00128 on one side and 0 on the other. The gradient carries no information that a slightly stiffer spring snaps sooner, the same as for every other decision.

Implicit differentiation gives the same gradients as the snap. The settled state satisfies `step(state*) = state*`, whose solution for any positive stiffness and positive step duration is the destination with zero velocity, so the settled position's gradient is 1 for the destination and 0 for stiffness, damping, step duration and the starting state. The snapped branch gives exactly those numbers. Without the snap, the circuit's gradients approach them as the spring settles:

| Steps | Displacement (px) | d position / d stiffness | d position / d destination | d position / d starting position |
| ---: | ---: | ---: | ---: | ---: |
| 4 | −95.9 | 0.0140 | 0.0409 | 0.959 |
| 16 | −66.2 | 0.1055 | 0.338 | 0.662 |
| 64 | −2.84 | 0.0830 | 0.972 | 0.0284 |
| 150 | 0.0158 | −2.28e-4 | 1.0002 | −1.58e-4 |
| 300 | −2.0e-7 | 1.0e-7 | 1 | 2.0e-9 |
| settled, by implicit differentiation | 0 | 0 | 1 | 0 |

Every gradient in the table matched a central difference of the float64 twin, with a caveat at 300 steps: gradients below 1e-3 are compared absolutely, so that row only confirms that the stiffness and starting position gradients are within 1e-6 of their central differences, not their signs. E.g. a negated stiffness gradient, −1.0e-7, would also pass. The tests compare signs wherever the central difference is at least 1e-5.

A snap also ends backpropagation through time for that spring: frames before the snap get no gradient from losses after the snap, because the snapped position doesn't depend on the incoming state. That's the true derivative, not a loss of information.

### Across frames

Training a spring against a recorded trajectory over many frames is backpropagation through time with one evaluation per frame. [frames.ts](../examples/differentiability/frames.ts) runs the matrix-power spring once per frame, copies the frame's position and velocity back into the cells, and adds up the squared distances from a recorded trajectory. The backward pass then runs once per frame, from the last frame to the first:

```ts
for (let frame = schedule.length - 1; frame >= 0; frame--) {
  const values = valuesByFrame[frame]!
  const seeds = new Float32Array(values.length)
  seeds[stepped.position] = 2 * (values[stepped.position]! - recorded[frame]!) + positionGradient
  seeds[stepped.velocity] = velocityGradient
  const gradients = circuit.backpropagateReference(values, seeds)
  for (const name of ['stiffness', 'damping', 'stepSeconds', 'destination'] as const) totals[name] += gradients[cells[name]]!
  // This frame's incoming position and velocity were the previous frame's outputs.
  positionGradient = gradients[cells.position]!
  velocityGradient = gradients[cells.velocity]!
}
```

The schedule has 32 frames with 484 steps in total: stretches at 60 and 120 fps of 2 to 5 steps per frame, a 150 ms hitch (37 steps), a 30 fps stretch, and a stall that hits the 300-step cap. Starting from stiffness 200 and damping 20, against a trajectory recorded at 290 and 30, every gradient of the loss matched a float64 central difference, e.g. 3.0466 for stiffness, −116.34 for damping, and −277,020 for the step duration against −277,010. Adam on stiffness and damping, 200 iterations with every frame forward and back, lowered the loss from 327.87 to 3.7e-4 and ended at stiffness 289.86 and damping 29.985, in about 75 ms.

Each frame's backward pass walks 562 operations and stores 577 values whatever its step count, so the 300-step frame costs the same as a 2-step frame, and the 32 frames store 18,464 values. The masked unroll for up to 300 steps would store 4,508 values per frame, 144,256 in total. So the cost of training across a longer recording grows with the number of frames, not with the steps inside each frame.

## Static bounds with named fallbacks

Cheng's note ends: "It seems we can always find such static upper bound and avoid more dynamicity in our paradigm". The prototypes did exactly that. A circuit's size is fixed while building, so every count that JavaScript would keep in a growing array or a loop variable became a maximum, with a fallback for what happens past the maximum:

| Quantity that looks dynamic | Static bound, and where | What happens past the bound | When a user would see the fallback |
| --- | --- | --- | --- |
| Spring steps per frame | 300 steps, i.e. 1,200 ms of simulated time (spring-bank's clock; chenguini's ui.md:64, and Animation.md's "Spiral of Death Prevention"; `maxStepsPerFrame` in host-timing.ts) | In spring-bank and chenguini, the rest of the backlog carries into later frames (up to 65,536 ms in spring-bank), and each frame runs at most 300 steps until the springs catch up. spring-bank's JavaScript also clamps each frame's delta to 65,536 ms. host-timing.ts's `advanceFrame` snaps every animated object onto its destination instead, and drops the backlog, so no time carries into later frames. | Only when an animation is still moving after a stall of about 1.2 s or more. With carried time, the animation then shows up to 1.2 s of motion per frame, and with host-timing.ts's snap, it jumps onto its destination in the first frame after the stall. host-timing.ts counts the steps from where springs last stepped in stored state, so with `'events and settle checks'`, where a frame evaluates a copy, a frame gap from just above 1,140 ms can already snap. HandwiredOS's springs settle in about 0.6 s, so the first frame after a 2 s stall finished every animation, and the cap never visibly bound. |
| How long a spring animates | settle thresholds of 0.01 px and 0.01 px/s (spring-bank's settle snap, taken from chenguini's demos, e.g. demos/draggable-cards/index.ts:248; the defaults of `emitAnimatedObject`, which throws for thresholds below 2^-22) | The spring snaps exactly onto its destination with zero velocity. | Never: the jump is smaller than 0.01 px. |
| Frame delta and backlog in lists' cards | 2^14 ms per frame and 2^15 ms of backlog (lists) | JavaScript clamps the delta, and the circuit clamps the backlog. | After stalls longer than about 16 s, where the springs lose the extra time. |
| Events per evaluation | 16 queue entries for window behaviors, 8 for keyboard focus, menus and the combined app, and at most 1, 2 or 4 presses per evaluation in the window circuit that handles moves through prefix counts (input) | JavaScript splits the frame's events into several evaluations (`splitIntoEvaluations`), where the first evaluation carries the frame's duration and later ones carry 0. | Never. Each extra batch costs one more evaluation. |
| Event times | −4,096 to 0 ms before the frame, on a 1/16 ms grid, and latched times such as the last click's time clamped at −65,536 ms (input); −1,200 to 0 ms on a 1/64 ms grid, and never before the previous frame (host-timing.ts's `quantizeFrameTiming`, which clamps at the 300-step cap, since springs snap past it) | JavaScript clamps. | In input, only after a main-thread stall longer than 4 s, where an older event is treated as 4.1 s old. With `quantizeFrameTiming`, only after a stall longer than 1.2 s, where an older event reads −1,200 ms. |
| Lines of a paragraph | line slots, e.g. 157 for a 1,023-segment paragraph, plus a lookahead, i.e. how many segments after a line's start the walker compares, and a limit on runs of break opportunities (text-walker) | The outputs `moreLinesThanSlots`, `windowOverflow` and `runOverflow` become nonzero. | Only if the page shows those outputs. Before `runOverflow` existed, a paragraph with longer runs than the circuit was built for started lines at the wrong segment, and no output showed the problem. |
| Lines of a text field | 12 line slots (text-editing and code-points) | An overflow output becomes nonzero, and lines past the last slot aren't laid out. | Typing past 12 lines: code-points' demo says "The text needs more than 12 lines. Lines past the last slot aren't laid out; delete some text." and keeps the caret at the circuit's x, e.g. 890.5 px in a 160 px field. text-editing's demo also hid the caret ([demo.ts at the tag](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/text-editing/demo.ts)). |
| Characters and pasted text | 256 cells, 8 codes per paste, and 96 entries in the width table ([text-editing](../../code-points/README.md#merged-from-text-editing-september-16-2026)) | A paste inserts as many codes as fit, and a full width table drops new graphemes. | Pasting into a nearly full field, or typing a 97th distinct grapheme. |
| FP32 integer budgets | position keys must satisfy about `2 × capacity × (1023 + maxWidthLimit) < 2^23` (text-editing, code-points' grapheme-editor-circuit.ts:103); the clock's threshold scores must stay below 2^22 and carried time within 2^24 grid steps (spring-bank.ts:126-127) | The builder throws. | Never: a configuration that doesn't fit doesn't build, e.g. text-editing at a capacity of 2,048 cells. |
| DOM nodes for visible rows | 24 DOM slots, i.e. reusable DOM nodes, with the viewport's height declared within 23 rows (lists, list.ts:61-64); 48 DOM slots, which hn-thread calls rank slots (hn-thread) | lists: a taller viewport is outside the viewport cell's declared range, which the range check rejects. hn-thread: the `slotOverflow` output becomes 1, and rows past the last DOM slot get no DOM node. | hn-thread's demo shows "(overflow)" in its stats. Over hn-thread's measured states, the thread needed at most 27 of the 48 DOM slots, and 32 while a 25-comment subtree collapsed. |
| Visible items that get an expensive per-item path | 20 of 1,000 items (lists' capacity routing) | Visible items after the 20th get no DOM slot, like the JavaScript reference, which keeps the first 20 matches. | When more than 20 items pass the filter. |
| Photos | the length of the instance arrays (instanced-items' `program.array(name, count)`) | A new count means new columns. The per-photo program stays 233 operations, and building it plus generating JavaScript took 22 + 3 ms at 10,000 photos. | Never, apart from the rebuild. Coordinates are declared within ±2^24 px; gallery-circuit.ts's ±2^22 px ruled out 10,000 photos. |
| Pointer samples for the release velocity | the newest 24 samples (lists' cards) | Older samples are dropped. | When more than 24 samples fall within 100 ms of the newest sample. |
| Release velocity | ±2^16 px/s per axis (lists' cards and flick) | The circuit and the reference both clamp. | On very fast flicks: the clamp engaged on 2 of 1,855 releases at 5 cards, and on 13 of 390 at 100 cards. |
| Every source cell | its declared range, checked on every evaluation (`Circuit.validateSourceRanges` in numeric-ui-core.ts) | The evaluator throws "source wire N is outside its assumed range". | The page stops. lists' cards stopped on 3 seeds before the release velocity clamp existed, and layout-tree's machine threw on every frame of 32 ms or more, because its timestep cell stored 0.008 as 0.0080000004. |
| Design numbers that a solver may change | declared ranges, e.g. padding and gap within 0 to 48 px (drag-knobs) | A step that would push a design number past its bound leaves the number at the bound, and search takes over. | As a drag that stops short: in 80 unsolved frames, every design number that could move the dragged edge sat at its bound. |

**The general rule.** Give every quantity that looks dynamic a maximum, and decide what the program does past the maximum as part of the behavior: snap (a spring past its settle thresholds, or every animated object when a frame would need more than host-timing.ts's 300 steps), carry (spring-bank's clock backlog), split (JavaScript running more evaluations), report (an overflow output that the page shows or a test counts), drop (visible items past the last DOM slot, pointer samples past 24), clamp (the release velocity), or throw (the builder's FP32 budget checks, and the range check on every evaluation). A fallback turns a limit into defined behavior that a reference implementation can reproduce, e.g. lists' JavaScript reference clamps the release velocity the same way the circuit does.

Choose each maximum from the quantity's measured distribution, so normal use never reaches the maximum, e.g. hn-thread's 48 DOM slots against at most 32 needed in its measured states, or chenguini's 300 steps against about 4 steps per frame at 60 fps. The fallback then becomes visible only at the tail: after long stalls, with unusually long text, or with more visible items than DOM slots. Where a fallback can be visible, make it look deliberate, e.g. text-editing's demo hid the caret and said why ([demo.ts at the tag](https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/text-editing/demo.ts)).

Two kinds of bounds need extra care. A bound that fails silently gives wrong results with no signal, like text-walker's run limit before `runOverflow` existed, so every bound needs an output or a check. A bound that throws stops the page, so a value computed from input timing, e.g. a release velocity divided by a time difference as small as 1/64 ms, needs a clamp before it reaches a cell.

**What bounds do for differentiation.** A fixed maximum means a fixed number of operations, so the backward pass has a fixed size too, e.g. 4,202 operations for the masked unroll for up to 300 steps, and 562 for the matrix power, for any step count. When JavaScript splits a frame into several evaluations, the backward pass across that frame becomes a sequence of fixed-size passes, like backpropagation through time within the frame. The fallbacks themselves are decisions or clamps, so they pass no useful gradient: an overflow bit is exact, a release velocity past ±2^16 px/s sits on a clamp whose slope is 0, and a snapped spring passes its gradient only to its destination. A design number at the edge of its declared range is different, because a declared range is a check, not a clamp in the circuit: the number's gradient can be nonzero, but a step that follows the gradient would leave the range, so drag-knobs' solver leaves the number at the bound and searches. A training loop can read the overflow outputs to skip or weight the examples that hit a bound, instead of learning from them.

## Limits

- The reference backward pass is an interpreter over the operation stream on the CPU; drag-knobs measured about 10 µs for its app shell. There's no compiled backward program, and the backward pass never ran over many instances of one program at once, so each candidate or spring instance needs its own backward pass.
- The examples compare an FP32 backward pass with float64 central differences, so the gradients match within the FP32 rounding of the forward values, e.g. 1.3e-7 on a gradient of 0.00053, not bit for bit.
- The in-circuit matrix power covers linear springs with constant stiffness and damping. Springs that affect each other, or whose coefficients depend on state, need the masked unroll or JavaScript.
- The implicit differentiation examples are plain JavaScript, not circuits. A circuit version would compute the settled state's equation and the small linear solve with the program's operations, and that wasn't built.
- Gumbel-softmax, the score-function estimator, reparameterization and smoothing weren't built or measured here. Their descriptions come from the ML literature, and the "used here?" answers come from searching the lab's READMEs and code.
- The training across frames is a toy: one spring, one recorded trajectory produced by the same arithmetic, and two parameters.

## Files

- [basics.ts](../examples/differentiability/basics.ts): the table of what the backward pass reports for each operation.
- [spring-power.ts](../examples/differentiability/spring-power.ts): the spring whose step matrix comes from cells, its float64 twin, and the gradient check over 1 to 300 steps.
- [source-matrix.ts](../examples/differentiability/source-matrix.ts): spring-bank's source-matrix variant in miniature, with the chain rule finished in JavaScript.
- [backward-cost.ts](../examples/differentiability/backward-cost.ts): unrolled and masked unrolled springs, and what their backward passes walk and store.
- [settle-snap.ts](../examples/differentiability/settle-snap.ts): the settle snap, frozen decisions, the snap boundary, and the gradients as the spring settles.
- [implicit-spring.ts](../examples/differentiability/implicit-spring.ts): implicit differentiation of a spring's settled state, without and with gravity.
- [frames.ts](../examples/differentiability/frames.ts): backpropagation through time across frames, and the toy fit.
- [water-fill.ts](../examples/differentiability/water-fill.ts): implicit differentiation of a flex-grow row.
- [differentiability.test.ts](../examples/differentiability/differentiability.test.ts) and [report.ts](../examples/differentiability/report.ts).

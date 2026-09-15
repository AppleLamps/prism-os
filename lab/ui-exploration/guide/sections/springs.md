# Springs, time, and composing behavior

This section answers two questions about animation in Indirect.

The first question: IndirectOS's springs move differently at different frame rates. The springs in chenglou.github.io's index.ts run a fixed 4 ms step as many times as the elapsed time allows, as vibescript's Animation.md recommends. Is IndirectOS's frame-rate dependence a choice in how IndirectOS was written, or a limit of writing a UI as one fixed numeric program?

The second question: how well does behavior compose? index.ts writes one spring step as a loop body, wraps the loop in `stepSpringTo`, which runs as many steps as it takes to catch up with the clock, and calls `stepSpringTo` from `render()` for every animated value. Can a circuit be written in the same three levels, and which parts of that structure are forced in a circuit, where in index.ts they're only a choice?

The runnable examples are in [examples/springs](../examples/springs/). From the repo root, `bun test lab/ui-exploration/guide/examples/springs` runs the 11 tests in [springs.test.ts](../examples/springs/springs.test.ts) and the 5 tests in [shared-runtime-springs.test.ts](../examples/springs/shared-runtime-springs.test.ts) in about 0.3 s, `bunx tsgo -p lab/ui-exploration/guide/examples/springs` typechecks the folder, and `bun lab/ui-exploration/guide/examples/springs/report.ts` ([report.ts](../examples/springs/report.ts)) prints every number this section attributes to the examples.

## Short answers

IndirectOS's frame-rate dependence is a choice in how IndirectOS was written, not a limit of the approach. window-manager.ts runs exactly 4 substeps per frame and makes each substep a quarter of the frame's duration, with the duration capped at 32 ms. The spring-bank prototype kept vibescript's timing instead: fixed 4 ms steps, a runtime number of steps per frame, leftover time carried into the next frame, and a 300-step cap. Its copy of IndirectOS got smaller, 3,580 operations instead of 5,253.

What the approach does force is a maximum step count known while building, and costs that grow differently from a JavaScript loop. A compiled program runs each of its layers exactly once per evaluation, so `for (let i = 0; i < steps; i++)` has to become one of: a masked copy of the step for every possible iteration (902 layers for up to 300 steps), powers of the spring's step matrix chosen by the binary digits of `steps` (27 to 40 layers), or a matrix that JavaScript computes and writes into 4 cells (3 layers). A fifth option changes when JavaScript copies next-state values back instead: event-time commits state only at event timestamps.

index.ts is frame-rate independent between destination changes, but not when a destination changes between two frames, and vibescript's ui.md orders a frame the same way. In a float64 copy of index.ts's loop, when every press arrives while the spring is at rest and on a frame time that every compared rate renders, 30 and 60 fps give the same positions as 120 fps, and 10 fps is within 0.0013 px. When presses arrive between frames while the spring moves, 30 fps differs from 120 fps by up to 112 px. Stepping the spring to each press's timestamp before applying the press, and checking settling after every step instead of once per frame, makes 10, 30 and 60 fps give the same float64 positions as 120 fps at every timestamp they share.

Composing while building works the way index.ts's functions compose, because builder code is ordinary JavaScript. The examples have a step builder, a catch-up builder that calls the step builder, and a per-frame builder that calls the catch-up builder for two springs that share one clock. The per-frame circuit matched a float64 copy of index.ts's `render()` in every step count and settle decision over 15,000 random frames. What a circuit forces at runtime: a loop count that depends on data becomes a maximum plus bits, early exits disappear, and every value kept between frames needs a cell that the caller allocates before building.

On September 14, 2026 Cheng decided the default ([decision 3](../review-and-decisions.md#3-how-should-time-enter-the-program-and-which-spring-should-be-the-default)). JavaScript writes the frame's duration and event times relative to the frame on a 1/64 ms grid, and the matrix of each evaluation's fixed 4 ms steps, i.e. form 4 below, with one settle bit per animated object. Springs step to each event's timestamp before the event applies, settling is checked at fixed simulated times, and when a frame would need more than 300 steps, every animated object snaps onto its destination instead of carrying the backlog into later frames. numeric-ui-core.ts builds the spring with `emitApplySpringMatrix` and `emitAnimatedObject`, host-timing.ts computes the matrix and plans the evaluations with `advanceFrame`, and [shared-runtime-springs.ts](../examples/springs/shared-runtime-springs.ts) builds a small app with both. The example builders in this section stay as explanations of how each piece works.

## Terms

- A **cell** is one number at a fixed position in the source table. After each evaluation, JavaScript copies the program's next-state values back into the state cells, like ui.md's "commit state changes" step.
- An **affine sum** is weights times inputs plus a constant, `circuit.affine(terms, bias)`. When every weight is a number known while building, a chain of affine sums over the same inputs is again one affine sum over those inputs.
- A **ReLU** is `max(0, x)`. A **ReLU-gated product** is one affine value times the ReLU of another, `circuit.reglu(leftTerms, leftBias, gateTerms, gateBias)`. `circuit.multiply(a, b)` builds one ReLU-gated product when the range recorded for one side, e.g. a declared range, is nonnegative, and three operations otherwise.
- The **boolean atom**, `circuit.boolean(score)`, rounds a score declared within 0..1 to exactly 0 or 1 through FP32 rounding.
- An **exact bit** is a wire that is always exactly 0 or 1, e.g. `[stepCount >= 8]`, where `[condition]` means 1 when the condition holds and 0 otherwise. A **mask** is an exact bit that multiplies a value to keep it (bit 1) or zero it (bit 0), e.g. `bit × velocity`.
- **Select**, `emitSelect(circuit, bit, off, on)`, computes `bit × on + (1 − bit) × off`. Both `off` and `on` are computed on every evaluation, whatever the bit is.
- `circuit.roundAffine(terms, bias)` builds an affine sum that stays its own operation, so sums that read the value don't copy its terms, and FP32 rounds the value once.
- **Roots** are the wires passed to the compiler as a program's outputs, e.g. in `circuit.createTensorEvaluator(roots)`. **Live operations** are the operations that some root depends on, and the compiler drops every other operation. A **layer** is a group of operations that don't read each other, and **depth** is the number of layers. **Stored weights** are the nonzero coefficients the layers keep.
- A **semi-implicit Euler step** first updates the velocity from the forces, then moves the position by the new velocity. index.ts's `stepSpringTo` runs one such step per 4 ms of simulated time.
- **Catching up** means running as many fixed steps as the elapsed time allows, e.g. 4 steps for a 16.7 ms frame and 2 steps for an 8.3 ms frame, and carrying the leftover time into the next frame.
- A spring **settles** when its speed and its distance from its destination are both below a threshold, 0.01 in index.ts. The spring then jumps onto the destination with zero velocity, and once every spring has settled, the page stops requesting frames.
- **Retargeting** means changing a spring's destination while the spring is still moving.
- Behavior is **frame-rate independent** when what's on screen at a timestamp doesn't depend on which other frames were rendered, e.g. a 30 fps run shows the same positions as every fourth frame of a 120 fps run.

The [glossary](../README.md#glossary) collects these terms with the ones other sections use, and the [comparisons](comparisons.md) section explains how threshold tests produce exact bits. In the big-O columns below, N is the maximum step count (300 here), S is the number of springs, and G is the number of different stiffness and damping pairs.

## How index.ts steps a spring

The loop inside `stepSpringTo` (index.ts:54-66) runs one semi-implicit Euler step per iteration, and the settle check runs once after the loop (index.ts:67-70):

```ts
for (let i = 0; i < steps; i++) {
  const Fspring = -previous.k * (pos - dest)
  const Fdamper = -previous.b * v
  const a = Fspring + Fdamper
  v += a * t
  pos += v * t
}
if (Math.abs(v) < 0.01 && Math.abs(dest - pos) < 0.01) {
  pos = dest
  v = 0
}
```

`render()` counts this frame's steps from the clock (index.ts:512-514) and stores the clock back into the state (index.ts:527):

```ts
let newAnimatedUntilTime = previousState.animatedUntilTime ?? now
const steps = Math.floor((now - newAnimatedUntilTime) / msPerAnimationStep)
newAnimatedUntilTime += steps * msPerAnimationStep
// stepSpringTo(previous.x, targets.x, steps), and the same for every other spring
animatedUntilTime: stillAnimating ? newAnimatedUntilTime : null,
```

`animatedUntilTime` is how far simulated time has advanced. After the steps, `now − animatedUntilTime` is between 0 and 4 ms, and that leftover carries into the next frame. So over any run of frames, the simulated time equals the elapsed time rounded down to a multiple of 4 ms.

When nothing animates, `animatedUntilTime` becomes null, and the first frame afterwards runs 0 steps. Idle time is never simulated.

vibescript's ui.md caps the count with `Math.min(300, ...)` (ui.md:64), so after a 10 s stall a frame runs 300 steps and later frames catch up on the rest. index.ts:513 has no cap. host-timing.ts keeps ui.md's cap, but when a frame would need more than 300 steps, it snaps every animated object onto its destination, so no backlog carries into later frames.

A 30 fps run and a 120 fps run execute different numbers of steps per frame, but the same steps in total. So as long as no destination changes, a spring passes through the same positions at the timestamps both runs render. The exception is a frame in which one run has snapped the spring onto its destination and in the other run the spring is still moving, where positions differ by less than the 0.01 px threshold.

## How IndirectOS steps a spring

window-manager.ts computes one timestep per frame (window-manager.ts:403-416):

```ts
const frameDuration = emitMultiply(
  circuit,
  sourceField.timeInitialized,
  emitClampDynamic(
    circuit,
    circuit.affine([[sourceField.frameTime, 1], [sourceField.previousFrameTime, -1]]),
    zero,
    sourceField.springMaxFrameDuration,
  ),
)
const springTimestep = circuit.affine([[frameDuration, 0.001 / 4]])
```

`springMaxFrameDuration` is 32 ms (window-manager.ts:1206). The host writes each frame's requestAnimationFrame timestamp into the `frameTime` cell (window-manager.ts:1287), and the program copies `frameTime` into `previousFrameTime` for the next frame (window-manager.ts:1023). `emitSpring` in numeric-ui-core.ts loops 4 times while building, and each copy of the step uses `springTimestep` as its length. photo-gallery.ts on its own writes a constant timestep of 0.004 s (photo-gallery.ts:591), so every evaluation of the standalone gallery simulates 16 ms, however long the frame was.

Three things make IndirectOS's timing frame-rate dependent:

- The step length follows the frame rate, about 2.1 ms per substep at 120 fps and 8.3 ms at 30 fps, and semi-implicit Euler gives a slightly different trajectory for a different step length.
- Frames longer than 32 ms lose time. At 10 fps each 100 ms frame simulates 32 ms, so motion runs at about a third of its speed, and a 500 ms stall moves the springs forward by 32 ms.
- The page requests another frame only while the `animationActive` output is above 0 (window-manager.ts:1472-1473), or after an input event. So after a period with no frames, the first frame computes its duration from the last rendered frame, which can be seconds earlier, and the 32 ms clamp makes that frame simulate 32 ms toward the new destinations at any frame rate. At 120 fps, the first frame after a press moves the springs as far as about 4 frames' worth of time.

`emitSpring`'s settle rule also differs from index.ts's snap. `active` is `100 × relu(distance − 0.01) + 100 × relu(speed − 0.01)`, clamped to 0..1 (at the end of `emitSpring`, with the thresholds and scales from window-manager.ts:1207-1210), and the drawn position is `active × steppedPosition + (1 − active) × destination`. So a spring 0.015 px from its destination and nearly at rest is drawn halfway between its stepped position and its destination, and its velocity is halved.

spring-bank measured IndirectOS's timing on a scripted IndirectOS session, comparing each rate with 120 fps at the timestamps both runs rendered: 318 px apart at 10 fps, 183 px at 30 fps, 72 px at 60 fps, and 401 px at 60 fps with a 500 ms stall. At 10 fps, every animation ended about 1 s late ([spring-bank](../../spring-bank/README.md)).

The same substep timing in float64, over this section's random press traces ([frame-rate-check.ts](../examples/springs/frame-rate-check.ts), rule `'IndirectOS substeps'`), differs from 120 fps by 337 px at 10 fps, 109 px at 30 fps, 45.2 px at 60 fps, and 573 px at 60 fps with a 500 ms stall. That check renders every frame, so it leaves out the 32 ms jump after idle.

## Why a circuit can't loop a runtime number of times

A builder function runs once, at startup. Its loops run then, and each iteration appends operations, e.g. `for (let step = 0; step < 4; step++)` inside `emitSpring` appends 4 copies of the step's operations. The compiled program is that fixed list of operations, grouped into layers.

`executeTensorProgram` in numeric-ui-core.ts runs the program with `for (const layer of layers)`: one sparse matrix multiplication per layer, each layer exactly once, from the first layer to the last. The program has no instruction that jumps back to an earlier layer, and no instruction that repeats a layer a number of times read from a cell. So `for (let i = 0; i < steps; i++)`, where `steps` comes from this frame's timestamp, has no direct translation: the number of copies has to be chosen while building, before any timestamp exists. A neural network's forward pass has the same property: its number of layers is fixed when the network is built.

JavaScript can evaluate the whole program several times within one frame, e.g. once per 4 ms step, but each evaluation runs the entire UI, not only the springs. event-time's commits, described below, use that idea with one evaluation per event instead of one per step.

Two constraints follow. A loop needs a maximum count known while building, e.g. index.ts's uncapped loop becomes ui.md's 300-step cap, and the cap becomes a capacity of the program instead of a tuning value. And the runtime count has to reach the operations as values they can compute with: bits, masks, or a matrix in cells.

Neither constraint rules out fixed steps. IndirectOS uses a fixed count of variable-length substeps, which needs no clock state and no step count. spring-bank rebuilt vibescript's timing with operations: the pending time, the step count, the leftover carried into the next frame, the 300-step cap, and the restart after idle. With presses on 30 fps frame times, where the two presses that 10 fps applies late start no animation, the runs at 10 to 120 fps and through 500 ms and 2 s stalls stayed within 0.003 px of each other, and the IndirectOS copy went from 5,253 operations and 192 layers to 3,580 operations and 137 layers ([spring-bank](../../spring-bank/README.md)).

## Five ways to run a runtime number of steps

The pattern doc [repeated steps as one matrix power](../patterns/matrix-powers.md) puts forms 2 and 4, and a table of powers, on one page, with a runnable example and a test.

### The step as a matrix

With constant stiffness `k`, damping `b` and step length `dt`, one semi-implicit Euler step is linear in the spring's displacement from its destination, `e`, and its velocity, `v`:

```
v' = v + (−k·e − b·v)·dt  =     (−k·dt)·e +      (1 − b·dt)·v
e' = e + v'·dt            = (1 − k·dt²)·e + dt·(1 − b·dt)·v
```

So running `n` steps multiplies the pair `(e, v)` by `M^n`, where `M` is the 2×2 matrix of those four coefficients and `M^n` is `M` multiplied by itself `n` times. `springStepMatrix` and `matrixPower` in [spring-step.ts](../examples/springs/spring-step.ts) compute both in float64. This section calls `M^n` for this frame's step count the frame matrix, since it moves the spring through all of one frame's steps at once. The ways below differ in how a runtime step count turns into the effect of `M^n`.

The table shows sizes measured with [costs.ts](../examples/springs/costs.ts), for springs that share stiffness 290 and damping 30, with up to 300 steps and no settle check. For scale, IndirectOS's `emitSpring` is 46 live operations, 33 layers and 104 stored weights for one spring, including its settle check.

| Form | 1 spring: live operations / layers / stored weights | 20 springs: live operations / layers / stored weights | Operations | Depth |
| --- | --- | --- | --- | --- |
| 1. Unrolled, one mask per step | 3,301 / 902 / 6,001 | 48,901 / 902 / 97,201 | O(N·S) | O(N) |
| 2a. Binary digits, a chain of steps per spring | 116 / 29 / 205 | 1,484 / 29 / 2,941 | O(S·log N) | O(log N) |
| 2b. Binary digits, one matrix per stiffness and damping pair | 217 / 40 / 380 | 483 / 40 / 912 | O(G·log N + S) | O(log N) |
| 3. JavaScript writes the step count's digits | 81 / 27 / 153 | 1,449 / 27 / 2,889 | O(S·log N) | O(log N) |
| 4. JavaScript writes the frame matrix | 14 / 3 / 28 | 280 / 3 / 560 | O(S) | O(1) |

The fifth way, committing state at event timestamps, changes when JavaScript copies next-state values back rather than what the program contains, so it has no row in the table.

Every form in the table matched float64 stepping over 2,000 random springs and step counts from 0 to 300: within 4.0e-4 px for the unrolled form, and within 9.6e-5 px for the other four (`checkCatchUpForm` in [checks.ts](../examples/springs/checks.ts)). The unrolled form rounds the spring's state 300 times in a row, which is probably why its error is larger.

### 1. Unroll the maximum number of steps, with one mask per step

**The familiar JavaScript.** Run the loop the maximum number of times, and change the state only in the iterations before `steps`:

```ts
for (let i = 0; i < maxSteps; i++) {
  if (i < steps) state = springStep(state)
}
```

**The circuit way.** The builder writes out all 300 copies of the step, and a bit per copy selects whether the copy's result is kept (`buildCatchUp` in costs.ts):

```ts
// [steps >= i] for i = 1..300
const thermometer = Array.from({length: maxSteps}, (_, index) => emitAtLeastOnGrid(circuit, stepCountCell, index + 1, 1))
outputs = springs.map(spring => {
  let current = spring
  for (const runsThisStep of thermometer) {
    const advanced = emitSpringStep(circuit, current, constants)
    current = {
      displacement: emitSelect(circuit, runsThisStep, current.displacement, advanced.displacement),
      velocity: emitSelect(circuit, runsThisStep, current.velocity, advanced.velocity),
    }
  }
  return current
})
```

**Why it gives the same result.** The bits `[steps >= 1], [steps >= 2], ...` read 1...1 0...0, which is known as a thermometer code. Copy i keeps the advanced state when its bit is 1 and passes the state through unchanged when its bit is 0, so exactly the first `steps` copies change the state, as in the loop. `emitAtLeastOnGrid` computes each bit as `relu(k + 1) − relu(k)` with `k = steps − i`, which is exactly 1 for `k >= 0` and exactly 0 for `k <= −1` when `steps` is a whole number.

**Cost.** Every copy reads the output of the copy before it, so depth grows with the maximum count: O(N) layers and O(N·S) operations. One spring is 3,301 operations in 902 layers. 20 springs share the thermometer and still need 48,901 operations, about 2,400 per spring.

**When to use it, and when not.** This form is the only one here that doesn't need the step to be linear, e.g. a spring whose stiffness depends on its position, or items that push each other apart. Depth is then the maximum count times the step's own depth: with stiffness and damping read from cells, one spring is 3,901 operations in 1,201 layers. For such systems, keep the maximum count small, or run the steps in JavaScript. For linear springs with constant stiffness and damping, the other forms cost a small fraction of this.

**Pitfalls.** A masked copy still computes. If an unselected copy overflows to Infinity, `Infinity × 0` is NaN, and the NaN reaches the state; the lists prototype hit this with a masked path ([synthesis](../../README.md)).

### 2. Powers of the step matrix, chosen by the step count's binary digits

This is exponentiation by squaring. A step count below 512 is a sum of distinct powers of two, e.g. 300 = 256 + 32 + 8 + 4, so running `steps` steps is running 2^digit steps for every binary digit of `steps` that is 1. In the pattern doc [repeated steps as one matrix power](../patterns/matrix-powers.md), build 2 computes the digits with `emitCompare` and multiplies one factor per digit, `I + digit × (M^(2^digit) − I)`, in a balanced tree of 2×2 products: 208 operations in 40 layers for one spring. This section's examples compute the digits with 3-operation integer bits instead of `emitCompare`, and build the power two ways:

- **A chain of steps per spring** (2a in the table, `emitSpringSteps` in [spring-catch-up.ts](../examples/springs/spring-catch-up.ts)). For each digit, a chain of 2^digit steps, and a select keeps the state before or after the chain. Each step is an affine sum of fewer than 4 terms, which the builder copies into the sums that read it, so a chain of 256 steps compiles to 2 affine sums whose weights are the entries of `M^256`, and what remains is 2 selects per digit per spring, 72 operations for 9 digits.
- **One matrix per stiffness and damping pair** (2b), the pattern doc's form, with about 14 more operations per spring. spring-bank's `split-table` variant reads the frame matrix from two constant tables through one-hots instead, `M^(16c)` for c whole 64 ms chunks and `M^f` for the f remaining 4 ms steps ([spring-bank](../../spring-bank/README.md)).

Most of the depth is in computing the digits. [spring-clock.ts](../examples/springs/spring-clock.ts) gets them by long division from the top digit down, 9 tests in a row, so the clock is 43 operations in 34 layers. Applying the top digit first lets the per-spring chain run alongside the division: the clock followed by one spring's steps is 33 layers with the most significant digit first, and 57 layers with the least significant digit first, with the same 120 operations (`measureDigitOrderDepth` in checks.ts).

Don't use either binary form for steps that aren't linear with constant coefficients. With stiffness and damping read from cells, a chain of steps no longer collapses into 2 affine sums, and the per-spring form is 2,142 operations in 1,295 layers, deeper than unrolling, because the chains for all 9 digits add up to 511 steps. Keep each digit as its own `roundAffine` wire, as spring-clock.ts does, for the reason under [Pitfalls the prototypes hit](#pitfalls-the-prototypes-hit).

### 3. JavaScript writes the step count's digits

**The familiar JavaScript.** index.ts's clock, unchanged, plus a loop that writes the digits into cells:

```ts
const steps = Math.min(300, Math.floor((now - animatedUntilTime) / 4))
for (let digit = 0; digit < 9; digit++) source[digitCells[digit]] = (steps >> digit) & 1
```

**The circuit way.** Form 2's chain per spring, reading the digit cells directly: `emitSpringSteps(circuit, spring, digitCells, constants)`.

**Cost.** 81 operations in 27 layers for one spring, and 1,449 operations for 20: 72 operations per spring plus 9 operations for `1 − digit` that all springs share, i.e. O(S·log N) operations and O(log N) layers. The same 9 digit cells serve every spring, whatever its stiffness and damping. With this section's settle check added, one spring is 93 operations in 35 layers (`checkStepSpringTo` in checks.ts).

**When to use it, and when not.** The clock moves to JavaScript, while the program still describes how 2^digit steps move each spring. Form 4 is smaller and shallower whenever there are few stiffness and damping pairs. The digits only pay off when there are many pairs, e.g. a spring per word with its own stiffness, where form 4 needs 4 cells per pair.

### 4. JavaScript writes the frame matrix

This form has been the default spring since September 14, 2026, and [execution-model.md](../../../../execution-model.md#springs-and-time) has its contract. JavaScript keeps the clock, computes `M^steps` by squaring in float64 once per frame for each stiffness and damping pair, e.g. `matrixPower(springStepMatrix({stiffness: 290, damping: 30}), steps)`, and writes the 4 entries into cells. Every spring applies them with 4 products, so FP32 rounds the spring's state once per frame instead of once per step. Both the entries and the state can be negative, so each product is 3 operations, which gives the table's 14 operations in 3 layers per spring, while JavaScript does O(G·log N) float64 work per frame. The pattern doc's build 1 shows the host code with a test, and in spring-bank's IndirectOS copy this `source-matrix` variant was the smallest, 3,413 operations.

numeric-ui-core.ts builds it with `emitApplySpringMatrix(circuit, matrix, displacement, velocity)`, which is costs.ts's `emitApplyMatrix`, and `emitAnimatedObject(circuit, springs, {settleCheck, snap})`, which steps every spring of one object, stores displacements from destinations instead of positions, and settles the object with one exact bit: 29 operations in 11 layers for an object of one spring, against 46 operations and 33 layers for `emitSpring`. From [shared-runtime-springs.ts](../examples/springs/shared-runtime-springs.ts), shortened:

```ts
const bound = springMatrixBound({stiffness: 290, damping: 30})
for (const entry of matrix) circuit.assumeRange(entry, -bound, bound)
// JS: if (selectEvent) destination = selectEvent.row * rowHeight
const destination = emitSelect(circuit, highlightCell.selectActive, highlightCell.destination,
  circuit.affine([[highlightCell.selectedRow, rowHeight]]))
const highlight = emitAnimatedObject(circuit, [{
  matrix,
  // The stored displacement from the destination in effect, not a position.
  displacement: highlightCell.displacement,
  velocity: highlightCell.velocity,
  destination,
  // The steps simulate time before this evaluation's event, so they pull toward the stored destination.
  destinationDuringSteps: highlightCell.destination,
}], {settleCheck: highlightCell.settleCheck, snap: highlightCell.snap})
```

Stiffness and damping stay editable, since they only enter the float64 computation in JavaScript. What the program loses is a description of how time passes: to evaluate the program at many future times, JavaScript writes one matrix per time, as event-time does for 301 samples. The matrix also doesn't have to be a power of the Euler step: JavaScript could write the closed-form spring's `exp(A × elapsedSeconds)`, with `A = [[0, 1], [−k, −b]]`, into the same 4 cells without changing the program, which none of the prototypes built.

### 5. Commit state only at event timestamps

In every form above, each frame both computes what's on screen and writes the next state back, so which frames happened to run becomes part of the state. Form 5 writes state back only at events and at settle checks, and evaluates each frame on a copy of the table. The pattern doc [commit state at events](../patterns/commit-at-events.md) has a toast stack example that runs this way, with a test, behavior-choices.md's [entry](../../../../behavior-choices.md#apply-events-at-their-timestamps-and-write-state-back-only-at-events-and-settle-checks) says what the user sees differently, and execution-model.md's [Which evaluations write state back](../../../../execution-model.md#which-evaluations-write-state-back) has the contract of host-timing.ts's `advanceFrame` with `'events and settle checks'`.

event-time built this first, for IndirectOS: over 6 traces, 4 variants and 7 frame schedules, committed tables and displayed outputs at shared timestamps differed in 0 bits ([event-time](../../event-time/README.md)). JavaScript there runs a schedule: settle commits at computed times, run before any later display, and redone when an event arrives with a timestamp before settle commits that already ran. `advanceFrame` doesn't redo them: a late event applies at the time of the last evaluation that wrote state back.

### Which form to use

Form 4, with `emitAnimatedObject` and `advanceFrame`, is the default, and `advanceFrame`'s `writeBack` argument adds form 5 where stored state must be bit-identical across frame rates ([execution-model.md](../../../../execution-model.md#springs-and-time)). Form 2 keeps the clock inside the program, so the host only writes a frame delta, and form 1 is for steps that aren't linear, with a small maximum count.

## ui.md's render order is frame-rate dependent when a destination changes between frames

### Where index.ts's order matches across frame rates

[frame-rate-check.ts](../examples/springs/frame-rate-check.ts) copies index.ts's `stepSpringTo` and the clock part of `render()`, with index.ts's default spring (stiffness 290, damping 30). Frame times are computed as `(frame × 1000) / hz`, so every fourth 120 fps frame time is bit-identical to a 30 fps frame time, and each rate is compared with 120 fps at the timestamps both runs rendered. Each result is the worst over 8 random traces of 12 presses, each press moving the destination to a random whole pixel in 0..800.

When every press arrives while the spring is at rest, 2,500 to 3,500 ms after the previous press, and on a 10 fps frame time, which 10, 30, 60 and 120 fps all render, the copy of index.ts gives identical positions at 30 and 60 fps, and positions within 0.0013 px at 10 fps. The 0.0013 px comes from a frame in which one run had snapped the spring onto its destination while in the other run the spring was still moving.

This case is what Animation.md's catch-up loop covers: between two destination changes, a 30 fps run executes the same 4 ms steps as a 120 fps run, only split differently between frames.

### The problem

vibescript's ui.md orders a frame as: handle inputs, new layout, animation tick (ui.md:14-24). index.ts follows that order: `render()` handles key presses and clicks (index.ts:348-392) and computes the targets (index.ts:394-509) before running the steps (index.ts:511-523), and its pending events store no timestamps (index.ts:163-168). So a press that arrives between two frames changes the destination in the next frame, and two things then depend on the frame rate.

From rest, `animatedUntilTime` is null, the first frame after the press runs 0 steps, and the animation starts at that frame's timestamp, up to one frame after the press: up to 8.3 ms late at 120 fps and up to 33.3 ms late at 30 fps. With presses between frames, all while the spring is at rest, index.ts's order differs from 120 fps by 342 px at 10 fps, 110 px at 30 fps, and 43.0 px at 60 fps.

During an animation, the frame computes the new destination first, and then runs the catch-up steps from `animatedUntilTime` to `now` toward the new destination, so some of those steps simulate time from before the press. After a frame that didn't hit a cap, `animatedUntilTime` sits less than 4 ms before that frame's timestamp, so the spring starts moving toward the new destination from a simulated time up to one frame plus 4 ms before the press: up to about 12 ms early at 120 fps, and up to about 37 ms early at 30 fps.

### Reproduction in float64

frame-rate-check.ts then replays 8 other random traces, with presses 90 to 700 ms apart, so most presses retarget a moving spring. Presses fall between frames, on a 1/64 ms grid.

Max position difference from the 120 fps run, worst over the 8 traces:

| Timing rule | 10 fps | 30 fps | 60 fps | 60 fps with a 500 ms stall |
| --- | ---: | ---: | ---: | ---: |
| index.ts: apply presses, then catch up | 411 px | 112 px | 46.0 px | 218 px |
| Step to each press's timestamp first, settle check once per frame | 15.8 px | 0 | 0 | 0 |
| Step to each press's timestamp first, settle check after every step | 0 | 0 | 0 | 0 |
| IndirectOS: 4 substeps of min(frame duration, 32 ms) / 4 | 337 px | 109 px | 45.2 px | 573 px |

"0" means identical float64 positions at every shared timestamp.

Presses on frame times don't avoid the problem during animations. With every press moved to the next 30 fps frame time, which 30, 60 and 120 fps all render, index.ts's order still differs from 120 fps by 423 px at 10 fps, 128 px at 30 fps, 42.8 px at 60 fps, and 253 px with the stall. The catch-up steps of each frame still start from the previous frame, which is 8.3 ms earlier at 120 fps and 33.3 ms earlier at 30 fps.

### The fix: step to the event's timestamp first

The `'event time, settle per step'` rule in frame-rate-check.ts applies each press at its own timestamp:

```ts
while (nextPress < presses.length && presses[nextPress]!.time <= now) {
  const press = presses[nextPress]!
  advanceClockTo(press.time, settlePerStep)
  destination = press.destination
  current = {...current, dest: destination}
  animatedUntilTime ??= press.time
  nextPress++
}
// ...
advanceClockTo(now, settlePerStep)
```

`advanceClockTo(time, settlePerStep)` runs `Math.floor((time − animatedUntilTime) / 4)` steps toward the current destination, and sets `animatedUntilTime` to null once the spring has settled. So the steps before the press move toward the old destination, and the spring starts moving toward the new destination from a simulated time within 4 ms of the press, at any frame rate. When the spring was at rest, `animatedUntilTime ??= press.time` starts the clock at the press instead of at the next frame.

Runs at different frame rates then execute the same steps in the same order from the same starting times, only split differently between frames, so float64 produces the same bits at every timestamp they share.

In a page, every event has to keep its `timeStamp`, which browsers report on the same time origin as requestAnimationFrame's timestamp. Applying an event means computing new destinations, so index.ts would run its layout once per event instead of once per frame.

### The remaining difference: settle checks at frame times

With the fix but with index.ts's settle check once per frame, 10 fps still differed by 15.8 px. In that trace, the 120 fps run settled a spring at its frame at 933.3 ms. The 10 fps run checked settling at 900 ms and 1,000 ms, and the spring was still moving at both checks: at 1,000 ms it was 0.0015 px from its destination, but its speed was above 0.01 px/s. When the press at 1,005.2 ms arrived, the 120 fps run started a new clock at the press, while the 10 fps run continued on the old 4 ms grid, so the new animation ran up to 4 ms apart between the two runs.

A spring can be within both thresholds at one step count and above the speed threshold a few steps later, e.g. when the remaining displacement accelerates the spring again near the end of an animation ([spring-bank](../../spring-bank/README.md)). So whether a spring counts as settled in a frame depends on which step counts the frames happen to land on. Checking after every step, or at fixed multiples of simulated time, makes settling independent of frames, and every rate then matched 120 fps exactly.

In the binary-digit forms and the matrix form, the intermediate steps don't exist as values, so a check after every step isn't available inside one evaluation. event-time checks settling at multiples of 16 steps after a commit, by evaluating the program at those simulated times, and commits at the first settled one. host-timing.ts's `advanceFrame` does the same: it runs a `'settle check'` evaluation, with the settle check cell set to 1, at every simulated time `checkOriginMs + 64 k` ms that the steps reach, where `checkOriginMs` is when the clock started.

### The fix in a circuit

numeric-ui-core.ts and host-timing.ts have both pieces. `emitAnimatedObject` steps each spring toward its `destinationDuringSteps` wire, the destination the previous evaluation wrote back, and `advanceFrame` runs an `'events'` evaluation at each distinct event timestamp, which steps to that timestamp and then applies the events, plus a settle check every 64 ms of simulated time. execution-model.md's [The ordering rule](../../../../execution-model.md#the-ordering-rule), [Settling at fixed simulated times](../../../../execution-model.md#settling-at-fixed-simulated-times) and [Which evaluations write state back](../../../../execution-model.md#which-evaluations-write-state-back) have the contract and what spring-matrix.test.ts measured over 8 traces of 12 presses between frames, e.g. every stored table identical in every bit at 10, 30, 60 and 120 fps with `'events and settle checks'`, where ui.md's order differed from 120 fps by up to 359 px at 10 fps. [shared-runtime-springs.test.ts](../examples/springs/shared-runtime-springs.test.ts) checks a smaller app, a selection highlight, the same way, including a 3,050 ms stall that every rate resumes from at 3,200 ms, where the highlight snaps onto its destination in the first frame.

Before these pieces, spring-bank built the circuit form of stepping first, deferred retargeting: a frame's steps move toward last frame's destination, read from one extra cell per spring. With one more evaluation at each event's timestamp, runs at every rate stayed within 0.0051 px of each other over five traces with presses between frames ([spring-bank](../../spring-bank/README.md)).

## Composing a spring at three levels

The default spring is `emitAnimatedObject` in numeric-ui-core.ts, with host-timing.ts's `countSpringSteps` and `advanceFrame` moving the clock into JavaScript: `countSpringSteps` counts the steps, carries the time below one step, and returns `snap: true` when a frame would need more than 300 steps. This part builds the digit-based form instead, forms 2 and 3, to show how builders compose, at three levels that mirror index.ts's structure:

| index.ts | Circuit builder | Example file |
| --- | --- | --- |
| The loop body inside `stepSpringTo` | `emitSpringStep` | [spring-step.ts](../examples/springs/spring-step.ts) |
| `stepSpringTo(previous, dest, steps)` | `emitStepSpringTo`, which calls `emitSpringSteps` | [spring-catch-up.ts](../examples/springs/spring-catch-up.ts) |
| `steps` and `animatedUntilTime` in `render()` | `emitSpringClock` | [spring-clock.ts](../examples/springs/spring-clock.ts) |
| `render()` | `buildHighlightFrame`, and the JavaScript host `createHighlightMachine` | [app-frame.ts](../examples/springs/app-frame.ts) |

The app is a list of 12 rows with a highlight behind the selected row. ArrowDown and ArrowUp move the selection, and holding the pointer down shrinks the highlight to 97%. The highlight's top springs with stiffness 290 and damping 30, and its scale with stiffness 333 and damping 20.

The checks are in [checks.ts](../examples/springs/checks.ts), and [springs.test.ts](../examples/springs/springs.test.ts) runs them.

### Level 1: one step

```ts
export function emitSpringStep(circuit: Circuit, spring: RelativeSpring, constants: SpringConstants): RelativeSpring {
  const dt = stepMs / 1000
  const acceleration = circuit.affine([
    [spring.displacement, -constants.stiffness],
    [spring.velocity, -constants.damping],
  ])
  const velocity = circuit.affine([[spring.velocity, 1], [acceleration, dt]])
  const displacement = circuit.affine([[spring.displacement, 1], [velocity, dt]])
  return {displacement, velocity}
}
```

`RelativeSpring` holds the spring's displacement from its destination and its velocity. The destination doesn't change during one frame's steps, so stepping the displacement is the same as stepping the position, and FP32 rounding then scales with the distance to rest instead of with the position.

`dt`, `stiffness` and `damping` are numbers while building, so the step multiplies wires only by constants: three affine sums and no products. The builder copies an affine sum with fewer than 4 terms into every sum that reads it (`affineShareThreshold` in numeric-ui-core.ts), so the builder writes `acceleration`'s terms into `velocity`, and `velocity`'s terms into `displacement`. One step compiles to 2 live operations in 1 layer, within 7.3e-5 px of float64 over 2,000 random springs.

Calling the step builder on its own output produces another pair of affine sums over the same two inputs, with the weights multiplied out. A chain of 300 calls still compiles to 2 live operations in 1 layer, with 4 stored weights. The builder did create 900 operations, and compiling with the chain's outputs as the roots dropped the other 898.

### Level 2: a runtime number of steps, then settle

`emitStepSpringTo` measures the spring from its destination, runs `emitSpringSteps`, form 2's chain of steps per spring, and then settles the spring the way index.ts does:

```ts
const exceedance = circuit.roundAffine([
  [emitRelu(circuit, circuit.affine([[stepped.displacement, 1]], -settleDistance)), 1],
  [emitRelu(circuit, circuit.affine([[stepped.displacement, -1]], -settleDistance)), 1],
  [emitRelu(circuit, circuit.affine([[stepped.velocity, 1]], -settleSpeed)), 1],
  [emitRelu(circuit, circuit.affine([[stepped.velocity, -1]], -settleSpeed)), 1],
])
const settledScore = circuit.reglu([], 1, [[exceedance, -(2 ** 20)]], 0.5)
circuit.assumeRange(settledScore, 0, 1)
const settled = circuit.boolean(settledScore)
let stillAnimating = circuit.roundAffine([[settled, -1]], 1)
// ...
return {
  position: circuit.roundAffine([[destination, 1], [circuit.multiply(stepped.displacement, stillAnimating), 1]]),
  velocity: circuit.multiply(stepped.velocity, stillAnimating),
  stillAnimating,
}
```

Each of the four ReLUs is exactly 0 when its side of the spring is within the threshold, and a sum of nonnegative FP32 values is 0 only when every term is 0. So `exceedance` is exactly 0 when the spring should snap.

`settledScore` is `relu(0.5 − 2^20 × exceedance)`. Any positive exceedance is at least one FP32 step of values near 0.01, about 9.3e-10, so the score is below 0.5 and the boolean atom rounds it to 0. A zero exceedance gives exactly 0.5, which rounds up to 1.

For FP32 values, `|displacement| <= Math.fround(0.01)` is the same test as index.ts's `< 0.01`, because no FP32 value lies between `Math.fround(0.01)` (0.0099999998) and 0.01.

With the step count's 9 digits written into cells by JavaScript, one spring with its settle check is 93 live operations in 35 layers. Against index.ts's `stepSpringTo` over 20,000 random springs, destinations and step counts from 0 to 300, of which 7,197 snapped, every settle decision matched, positions were within 1.2e-4 px, and velocities within 8.4e-4 px/s (`checkStepSpringTo`).

The optional `goToEnd` parameter is index.ts's `goToEnd`, e.g. for reduced motion. The builder only creates the two operations for `goToEnd` when a caller passes a wire, and `checkGoToEnd` found 0 mismatches over 20,000 samples.

### The clock

```ts
export function emitSpringClock(circuit: Circuit, cells: ClockCells) {
  const carriedMs = circuit.roundAffine([[cells.leftoverMs, 1], [cells.frameDeltaMs, 1]])
  // index.ts: `animatedUntilTime ?? now`. A clock that stopped counts no time.
  const pendingMs = circuit.multiply(carriedMs, cells.running)
  // Math.min(300, Math.floor(pending / 4)) equals Math.floor(Math.min(pending, 1200) / 4).
  const capMs = stepMs * maxSteps
  const cappedMs = circuit.roundAffine([
    [pendingMs, 1],
    [emitRelu(circuit, circuit.affine([[pendingMs, 1]], -capMs)), -1],
  ])
  const stepBits = emitBinaryDigits(circuit, cappedMs, stepMs, stepDigitCount, timeGrid)
  const stepCount = circuit.roundAffine(stepBits.map((bit, digit) => [bit, 2 ** digit]))
  // nextLeftoverMs = min(pendingMs − 4 × stepCount, 65,536)
  // ...
}
```

`leftoverMs` is index.ts's `now − animatedUntilTime` after the steps, and `running` is 0 when index.ts's `animatedUntilTime` is null. The program keeps the same information as index.ts, measured from the frame instead of from the page's time origin.

JavaScript keeps absolute timestamps in float64, rounds them to 1/64 ms, and writes only the frame's delta. Every time value in the clock is then a multiple of 1/64 ms no larger than 2^17 ms, which FP32 holds exactly.

Every threshold test is then an integer test. With `k = 64 × (remaining − threshold)`, `relu(k + 1) − relu(k)` is exactly 1 for `k >= 0` and exactly 0 for `k <= −1` (`emitAtLeastOnGrid`).

The clock is 43 live operations in 34 layers. The clock matched `Math.min(300, Math.floor(pending / 4))` and the carried leftover in all 3,834 cases checked, including pending times at, one 1/64 ms below, and one 1/64 ms above every multiple of 4 ms up to 305 steps (`checkClock`).

### Level 3: one frame

```ts
export function buildHighlightFrame(circuit: Circuit) {
  // Declare every cell's range before any operation reads the cell.
  declareClockRanges(circuit, clockCells)
  circuit.assumeRange(cell.arrowDown, 0, 1)
  circuit.assumeRange(cell.arrowUp, 0, 1)
  circuit.assumeRange(cell.pointerHeld, 0, 1)
  circuit.assumeRange(cell.selectedIndex, 0, rowCount - 1)

  // Handle inputs
  const zero = circuit.affine([])
  const lastIndex = circuit.affine([], rowCount - 1)
  const movedIndex = circuit.roundAffine([[cell.selectedIndex, 1], [cell.arrowDown, 1], [cell.arrowUp, -1]])
  const selectedIndex = emitMinimum(circuit, emitMaximum(circuit, movedIndex, zero), lastIndex)

  // New layout
  const topDestination = circuit.roundAffine([[selectedIndex, rowHeight]])
  const scaleDestination = circuit.roundAffine([[cell.pointerHeld, pressedScale - 1]], 1)

  // Animation tick
  const clock = emitSpringClock(circuit, clockCells)
  const top = emitStepSpringTo(circuit, {position: cell.topPosition, velocity: cell.topVelocity}, topDestination, clock.stepBits, topConstants)
  const scale = emitStepSpringTo(circuit, {position: cell.scalePosition, velocity: cell.scaleVelocity}, scaleDestination, clock.stepBits, scaleConstants)
  const stillAnimating = emitMaximum(circuit, top.stillAnimating, scale.stillAnimating)

  // Commit state. Cells that JavaScript writes every frame pass through unchanged.
  const nextSource: Wire[] = Array.from({length: cell.size}, (_, index) => index)
  nextSource[cell.leftoverMs] = clock.nextLeftoverMs
  nextSource[cell.running] = stillAnimating
  nextSource[cell.selectedIndex] = selectedIndex
  nextSource[cell.topPosition] = top.position
  // ... and the other spring cells
}
```

The JavaScript host writes this frame's inputs, evaluates, and copies the next state back:

```ts
renderFrame(now: number, input: HighlightInput) {
  const quantizedNow = Math.round(now * timeGrid) / timeGrid
  source[cell.frameDeltaMs] = previousFrameTime === null
    ? 0
    : Math.min(maxCarriedMs, Math.max(0, quantizedNow - previousFrameTime))
  previousFrameTime = quantizedNow
  source[cell.arrowDown] = input.arrowDown ? 1 : 0
  source[cell.arrowUp] = input.arrowUp ? 1 : 0
  source[cell.pointerHeld] = input.pointerHeld ? 1 : 0
  const outputs = evaluate(source)
  // ... read the highlight's top and scale for the DOM, then:
  for (let index = 0; index < cell.size; index++) source[index] = outputs[index]!
}
```

Both springs step by the same clock digits, and `emitMaximum` of two exact bits is their OR, like the `||` over springs in index.ts's `updateBoxForFrame` (index.ts:330). The app is 234 live operations, 44 layers and 428 stored weights, and its builders created 3,275 operations.

The float64 reference, `referenceFrame` in app-frame.ts, is index.ts's `render()` steps 2 to 4 for this app, with ui.md's 300-step cap. The random traces mix frame deltas of 8.3, 16.7 and 33.3 ms, irregular frames of 4 to 44 ms, 100 ms frames, and stalls of 0.3 to 2.6 s; in each 5,000-frame trace, 79 to 89 frames ran the full 300 steps.

- Started from the circuit's state before every frame, over 3 traces of 5,000 frames, the step counts, leftover times, selected rows and settle decisions matched in every frame, positions were within 2.1e-5 px, and velocities within 7.6e-5 px/s (`checkAppRestartedEveryFrame`).
- With the circuit and the reference each carrying its own state through the same 3 traces, positions stayed within 7.3e-5 px, and 0 frames had different step counts or settle decisions (`checkAppFreeRunning`).

### Which parts of index.ts's spring code are a choice, and which are forced in a circuit

| What index.ts's spring code does | The circuit builder's counterpart | Choice or forced |
| --- | --- | --- |
| Functions at three levels: `stepSpringTo` catches one spring up, `updateBoxForFrame` updates one photo's six springs, and `render()` runs the app | A builder function per level, each calling the level below | A choice in both |
| Default parameters, e.g. `k = 290` in `spring()` and `goToEnd = false` | Builder parameters: a number known while building becomes a weight, and a wire becomes a runtime input | A choice in both |
| Code written inline in `render()` | Calling a builder function creates the same operations as writing its body inline, as long as the statements run in the same order | A choice in both |
| Every spring on the page reads one `animatedUntilTime` | Every spring reads one clock's digits | A choice in both |
| `steps`, a loop count known only at runtime | A maximum count plus digits, masks, or a matrix in cells | Forced |
| `break` when a value stops being finite, and `return previous` when nothing changed | No counterpart: every operation runs on every evaluation, and masked values still compute | Forced |
| `animatedUntilTime`, kept in the page's state object | Cells that the caller allocates before building, e.g. `leftoverMs` and `running` | Forced |

## What composes at build time

Builder functions are ordinary JavaScript functions, so everything JavaScript offers for composing functions works while building: parameters, return values, loops, conditions on values known while building, helpers and closures. For example, `emitStepSpringTo` takes stiffness and damping as numbers, and its optional `goToEnd` parameter controls whether two more operations exist at all.

Values pass between builders as wires, e.g. `emitStepSpringTo` returns `{position, velocity, stillAnimating}`, and `buildHighlightFrame` wires `top.position` into the next state. A builder reads a wire the same way whether the wire is a source cell or the output of another builder.

The builder also merges work across calls. When a call builds an operation identical to an existing one, the builder returns the existing wire, e.g. both `emitSelect` calls for the same digit share one `1 − digit` operation, and so do the two springs in the app. And it copies small affine sums into the sums that read them, which is why a chain of affine steps collapses.

Recursion over structure known while building works too, e.g. `emitArgmax` builds its selection by recursing over the tournament tree it built (`routeArgmax` in numeric-ui-core.ts), and layout-tree compiles Clay's layout passes over a tree whose structure is fixed while building ([layout-tree](../../layout-tree/README.md)).

Whole circuits compose. window-manager.ts copies the Photos circuit into its own circuit with `inlineCircuit` in numeric-ui-core.ts, which maps Photos' source cells to window-manager wires. notation replaced that with components, i.e. a list of cells plus a build function that reads the parent's wires, and the result compiled to the same circuit ([notation](../../notation/README.md)).

Savings add up across compositions. In indirect-os-2, replacing `emitSpring` with the spring bank saved 1,353 operations in IndirectOS with event latches, and 4,478 operations once the Notes paragraph was added ([indirect-os-2](../../indirect-os-2/README.md)).

## What doesn't compose at runtime

**Loop counts that depend on data.** A builder can only loop over counts that are known while building, so a runtime count turns into a maximum count plus bits or masks, e.g. `steps` becomes 9 digits with a 300-step cap.

**Recursion over data.** A recursive function whose depth depends on runtime values needs a maximum depth written out while building. Changes to a tree's structure at runtime stayed outside the circuit across the prototypes ([synthesis](../../README.md)).

**Early exits.** index.ts's `break` when a position stops being finite, and its `return previous` when nothing changed, have no counterpart. Every operation runs on every evaluation, and a masked path still computes its values.

**State kept between frames.** Every value kept until the next frame has to be a source cell with a next-state wire. A builder function can't keep a private variable that changes per frame, so its caller has to allocate the cell and wire it. For example, index.ts's `animatedUntilTime` becomes the `leftoverMs` and `running` cells in app-frame.ts, and spring-bank's deferred retargeting needed one previous-destination cell per spring, given to each spring by its caller.

**Cells can't be allocated halfway through building.** A `Circuit` needs its source size before the first operation exists, because operation wires are numbered after the source cells. So notation allocates every cell, including every component's cells, before building any behavior, and a component can't add another cell halfway through building ([notation](../../notation/README.md)).

## Pitfalls the prototypes hit

**A range declared after an operation reads a wire doesn't change that operation.** `circuit.multiply(value, timestep)` builds one ReLU-gated product when `timestep`'s range is already declared nonnegative, and three operations, `value × max(0, timestep)`, `value × max(0, −timestep)` and their difference, when it isn't. window-manager.ts never declares the spring timestep's range itself; the declaration only arrives when the Photos circuit is inlined, after the window springs exist. Declaring the range where the timestep is computed saves 320 live operations with bit-identical outputs ([notation](../../notation/README.md)). [build-order.ts](../examples/springs/build-order.ts) shows the same with one product: 1 live operation with the range declared first, 3 with the range declared after, and the same values over 100,000 random inputs. The builders here declare every cell's range before building behavior. The [model](model.md#why-declared-ranges-matter) section lists the other places declared ranges matter.

**The order in which wires are created changes FP32 results.** An ordinary affine sum adds its terms in wire-number order (`normalizeTerms` in numeric-ui-core.ts), and wire numbers follow creation order. With a bias and two fractional terms, moving one statement changes rounding: in build-order.ts, `0.3 + 0.1 × left + 0.7 × right` gave a different FP32 result for 30,293 of 100,000 random inputs, depending only on whether `left` or `right` was created first. notation had to create IndirectOS's window center before its dock center to reproduce the original circuit bit for bit.

**An exact bit stops being exact inside a large sum.** A bit written as `relu(k + 1) − relu(k)` is a small affine sum, so the builder copies both ReLU terms into every sum that reads the bit, and large ReLU values times large weights can push partial sums past 2^24, where FP32 stops holding every integer. The [comparisons](comparisons.md#form-1-integer-bits) section has the failures this caused in lists and input. spring-clock.ts keeps its digits as their own `roundAffine` wires, whose ReLU values reach 2^16 and whose weights reach 1,024.

**Where a spring sits in the per-frame builder determines depth.** A spring that feeds the same frame's layout puts its layers under the whole layout: layout-tree's sidebar spring adds 39 layers before the layout starts, and reading last frame's spring position instead takes the app shell from 115 to 83 layers ([layout-tree](../../layout-tree/README.md)). With deferred retargeting, spring-bank's stepped positions depend only on cells and the frame matrix, so Photos could read this frame's animated window size early: 91 layers instead of 137.

**A shared clock couples every spring that reads it.** In indirect-os-2, a click raised Notes, and Notes' words started moving in the next rendered frame, which was frame 61 at 60 fps and frame 60.5 at 120 fps. Nothing had been animating, so the one clock all springs share restarted in two different frames, the leftover time had a different phase from then on, and a later Photos maximize ran 28.8 px apart between the two rates ([indirect-os-2](../../indirect-os-2/README.md)). index.ts has the same structure, one `animatedUntilTime` for the whole page, so a feature there that starts moving one frame later would also shift the times at which every later animation's 4 ms steps land. indirect-os-2's README suggests one clock per animation group.

**Idle time must not reach the springs.** streaming-words' page first stepped the springs through the whole idle period on the first frame after an input, up to 1,020 ms, so words jumped to their places in one frame ([browser check](../../notes/browser-check.md)). IndirectOS clamps the same jump to 32 ms, as described above. In app-frame.ts, the program clears the `running` cell when everything settles, so the next frame counts no idle time however large a delta JavaScript writes. host-timing.ts's `quantizeFrameTiming` returns a duration of 0 for the first frame after idle, and `advanceFrame` stops the clock as soon as its `evaluate` callback returns that nothing animates.

**Time values in FP32 cells.** A Float32Array rounds what JavaScript writes into it. layout-tree's machine wrote a timestep of 0.008, which the cell stores as 0.0080000004, above the cell's declared maximum of 0.008, so every frame of 32 ms or more threw ([browser check](../../notes/browser-check.md)). window-manager.ts writes absolute requestAnimationFrame times into an FP32 cell (window-manager.ts:1287), and FP32 values near 2^22 ms, about 70 minutes into a session, are 0.5 ms apart, so frame durations computed inside the program get coarser as a session goes on. spring-bank, app-frame.ts and host-timing.ts keep absolute times in float64 JavaScript and write only the frame's delta.

**Builders create operations that the compiled program drops.** The chains of steps in app-frame.ts created 3,275 operations, of which 234 are live. `circuit.createTensorEvaluator(roots)` and `circuit.compileTensorProgram(roots)` drop the rest, while `circuit.evaluateReference(source)` and `circuit.evaluateTensor(source)` compute every created operation.

**Settle decisions on drifting FP32 state.** FP32 and float64 now and then cross the 0.01 thresholds in different frames. When the last moving spring settles one frame earlier in one run, that run's clock restarts in a different frame, and animations that start afterwards run up to a frame apart: in lists, card positions then differed by up to 21 px, while card order still matched on every frame ([synthesis](../../README.md)). One settle decision per animated object, and settling at fixed simulated times, reduce how often this happens, and `emitAnimatedObject` with `advanceFrame` does both.

**Large absolute positions.** The gallery prototype found that spring positions near 100,000 px never settled in FP32, and stores each spring as a displacement plus its destination ([synthesis](../../README.md)). The examples here step the displacement for the same reason, and so does `emitAnimatedObject`: in spring-matrix.test.ts's traces moved to 65,536 and 131,072 px, stored displacements stayed within 1.4e-4 px of float64, and every run settled like float64.

## Limits

- The binary-digit forms and the JavaScript-written matrix only cover linear springs with constant stiffness and damping, whose springs don't affect each other. Repulsion, collisions, and stiffness that depends on state need unrolled steps with a small maximum count, or JavaScript.
- Every stiffness and damping pair needs its own frame matrix, or its own chains of steps.
- These forms reproduce index.ts's Euler stepping, not the closed-form spring Animation.md describes. A JavaScript-written matrix could sample the closed form, but none of the prototypes built that.
- The float64 reproduction uses one spring and random presses, and renders every frame. It doesn't model IndirectOS's 32 ms jump after idle, or several springs whose settle decisions share one clock.
- Deferred retargeting with extra evaluations at event timestamps, and event-time's commits, were measured on replayed traces. spring-bank's browser page applies events in the next rendered frame without the extra evaluations, and event-time's browser check couldn't confirm whether composited animations keep playing during a stall. host-timing.ts's `advanceFrame` was also measured only on replayed traces, and no demo uses it yet.

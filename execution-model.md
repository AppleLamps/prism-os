# Execution model

An Indirect program has one fixed source width and an ordered instruction list. State, constants, and browser inputs enter through a `Float32Array`. Each instruction appends one number; a wire is its numeric position.

## FP32

`f(x)` means `Math.fround(x)`. Affine terms run in stored order:

```txt
value = f(bias)
for (wire, coefficient) in terms:
  value = f(value + f(f(coefficient) * values[wire]))
```

Ordinary builder expressions normalize terms by ascending wire. Explicitly rounded operations retain the caller's term order, including repeated terms. A backend that guarantees exactly the same values as the literal instruction evaluator must keep the stored order, including when inlining remaps wire numbers.

## Instructions and macros

```txt
affine(left)      = left
reglu(left, gate) = f(left * max(0, gate))
boolean(score)   = f(f(f(score) + 8_388_609) - 8_388_609)
index(form, candidates, below, above) = values[candidates[floor(form)]], with a rule outside the table
```

`left`, `gate` and `form` are affine forms. `boolean` accepts `0..1`; values below `0.5` become zero, and the rest become one. `index` is described under [index reads](#index-reads). Instructions read sources and earlier instructions, never later ones.

`Circuit.affine` is a builder expression: small affine producers can be combined before execution. `Circuit.roundAffine` retains a specific evaluation, term order, and operand wires, so the builder never copies that operation's terms into the operations that read it, which would remove a required FP32 rounding point. It does not combine duplicate terms or move constant terms into the bias.

Multiplication and selection retain semantic metadata on their expanded outputs. The forward program still contains only the three atoms and index reads. The metadata supplies the intended whole-operation derivatives, prevents accidental removal of rounding, and helps recognize masked products. Inlining a circuit preserves the metadata.

Backpropagation differentiates the intended real arithmetic, not literal floating-point rounding. A hard boolean gradient is rejected unless the caller explicitly requests `{booleanGradient: 'straight-through'}`. A soft comparison or a custom derivative is a training choice, not an exact derivative of a hard decision. Index reads have their own gradient options, described below.

## Compilation

Independent instructions at the same dependency depth share a layer. A layer gathers its earlier inputs, evaluates its sparse affine projection, applies gather reads, index reads, ReGLU gates and boolean rounding, and appends outputs.

By default, an instruction's layer is its build-time depth: one more than the depth of the deepest wire it reads. `compileTensorProgram(roots, lowerGathers, {recomputeDepths: true})`, or `createTensorEvaluator(roots, {recomputeDepths: true})`, instead places each live instruction one layer after the deepest value it reads in the compiled program. A masked sum lowered to a gather is then no longer placed after the products it replaced, and the operations after it can move to earlier layers. Compiled programs skip depths that have no live instruction, so the removed products only cost a layer when other live instructions share their depth. Without lowered gathers, both choices give the same program. The option is off by default because it changes existing programs: IndirectOS goes from 192 to 191 layers with the same live operations, stored weights and values, and the candidate gallery stays at 60 layers, with operations moved between them.

Compilation removes operations that cannot reach a requested output and may reorder independent values in packed storage. `wireOrder` maps packed values to source wire positions. Removed wires stay zero in a full result array and cannot be requested as outputs.

The literal instruction evaluator defines the compiled numeric semantics. The tensor backend must reproduce every live value. The usual validator compares with `===`, ignoring zero's sign; NaN results do not pass that validator. Nonfinite edge-case tests explicitly check matching NaN or infinity where relevant.

The tensor backend returning the literal instruction evaluator's values does not prove that a source compiler preserved JavaScript behavior. The trace compiler separately checks its float64 source interpreter against native JavaScript, then reports intended FP32 drift.

## One-hot groups and gathers

`assumeOneHot(members)` declares exact zero/one values with exactly one one; a variant permits all-zero. It is a caller contract like `assumeRange`, not a general theorem prover. Automatic declarations require the builder's limited provenance checks. `emitArgmax` always declares its selection. `emitFirstActive` declares its selection only when the gate and every candidate are proven bits: a wire whose declared range contains only 0 or only 1, a boolean atom, the bit `emitCompare` returns, a member of a declared one-hot group, or an index read whose reachable candidates are all proven bits, where an out-of-range side with the `'zero'` rule adds +0, which is also a bit. E.g. a read of a table of hit test bits at a computed row qualifies, while a read that can reach an opacity within 0..1 doesn't. An operation inside `emitCompare`, e.g. a sign cascade stage within 0..1, isn't a proven bit. `index-read.test.ts` compiles 80 random circuits whose selections read comparison bits and index reads of bits, with and without gather lowering, and every compiled program returns the reference evaluator's values.

A masked sum covering each group member exactly once can become a gather when every candidate has finite FP32 bounds. The executor resolves the group's index once, then reads one candidate per gather. When a candidate's bounds admit infinity, the masked sum must remain dense, since an unselected `Infinity * 0` can produce NaN. Bounds follow each rounded operation; finite float64 endpoints alone are insufficient.

Gather lowering optimizes retrieval after selection. It does not provide learned query/key scoring, remove all candidate computation, or make an arbitrary scored lookup constant-time.

## Index reads

`circuit.indexRead(index, candidates, {outOfRange})` appends one instruction that copies `candidates[floor(index)]`, e.g. the height of the row at a computed row index. `circuit.indexReadAffine(indexTerms, indexBias, candidates, below, above)` takes the index as an affine form and a rule per side, e.g. `[[firstRow, 1]]` with bias 3, `'clamp'` and `'zero'` reads the fourth visible row, and +0 past the end of the table. Small affine producers compose into the index form, as they compose into a ReGLU gate.

```txt
index = f(form)                                  the usual FP32 accumulation
position = floor(index)                          in float64, so nothing rounds
read = values[candidates[position]]              for 0 <= position <= count - 1
     = values[candidates[0]] or +0               for position < 0, per the below rule
     = values[candidates[count - 1]] or +0       for position > count - 1, per the above rule
     = NaN                                       for a NaN index
```

The selected value is copied without any rounding step, so `-0`, `Infinity` and `NaN` candidates come through unchanged, and integers and bits read through a table stay exact.

The contract:

- The index needs a declared range strictly inside ±2^24, where every integer is an FP32 value. Ranges follow FP32 rounding, so an endpoint that lands on ±2^24 can stand for a larger real value, and the builder refuses it: `indexReadAffine([[cell, 1]], 1, candidates, 'clamp', 'clamp')` with the cell declared within 0..2^24 has the range endpoint f(2^24 + 1) = 2^24, and at cell value 2^24 the read would land one position early. The builder also refuses an open range, e.g. an index built from a source cell without `assumeRange`. It infers the index form's range from the declared ranges of the form's operands, then narrows it with the range declared on the index wire of `indexRead`, or with `{indexRange: {minimum, maximum}}` for `indexReadAffine`.
- The range declared on the index wire is used even when the builder copies a small affine index into the read. E.g. `row = circuit.affine([[firstRow, 1], [offset, 1]])` followed by `circuit.assumeRange(row, 0, 999)` builds while `firstRow` and `offset` have no declared ranges, since the copied form adds the same terms in the same order and holds the exact value of `row`.
- The index must hold an integer. The builder can't check that, so `validateIndexReads(circuit, values)` checks in tests that every index form holds an integer within the range the builder accepted. E.g. an index built as `scrollTop / 28` fails at `scrollTop` 14.
- A NaN index only happens when a declared range on a computed wire is false, e.g. `assumeRange(difference, 0, 9)` on `a - b` while both cells hold `Infinity`. Both evaluators then read NaN.
- Candidates can be any earlier wires, can repeat, e.g. `[a, a, b]`, and need no declared range. With a constant index, the builder selects the candidate while building, and identical reads return one wire.
- The builder freezes the candidates array and records it in a map keyed by the array's identity, so a table read many times is checked once. Changing the array after a read throws. Arrays with the same content share one table.

For an integer index, the read equals a one-hot masked sum over the same table, e.g. bits `[index >= j] = relu(index - j + 1) - relu(index - j)`, subtracted pairwise and multiplied into the candidates. The two differ in three cases, which `index-read.test.ts` checks:

- A fractional index: the read floors, while the ReLU bits interpolate. At index 2.5 over `[28, 44, 28, 60]`, the read returns 28 and the masked sum returns 44.
- An infinite candidate: the read returns the selected value, while the masked sum returns NaN, because an unselected `Infinity * 0` is NaN.
- A selected `-0`: the read returns `-0`, while the masked sum returns `+0`, since its accumulation starts from `+0`. The usual `===` validator treats these as equal.

In a tensor layer, an index read is one output row with no weights and no bias, plus one projection row after the gate rows that holds the index form. After the sparse matrix multiplication, the executor floors that row in float64 and copies the chosen candidate's packed value into the output row. A table whose candidates are at evenly spaced packed positions, e.g. a run of source cells, a reversed run or one repeated wire, is stored as a base position and a stride, so reading a 10,000-cell column costs one operation, one stored weight and no stored positions. Other tables store one position per candidate, and every read of the same table shares that array.

Backpropagation gives the selected candidate the output gradient, like the backward pass of a gather, so two reads of the same candidate add their gradients. The read is a step function of the index: its derivative is 0 between integers and undefined at them. By default, `backpropagateReference` throws when a nonzero gradient reaches an index read, so a training loop can't silently receive zeros for the index. `{indexGradient: 'zero'}` gives the index form no gradient. `{indexGradient: 'backward-difference'}` gives it `read(i) - read(i - 1)` at `i = floor(index)`, with the same rule outside the table, which is what the same backward pass gives the ReLU one-hot masked sum at an integer index.

Gather lowering is kept for selections that already exist as declared one-hots, e.g. `emitArgmax`'s output. A read at a computed integer doesn't need it: over 10,000 entries, a ReLU one-hot masked sum compiles to 30,002 live operations and 49,998 stored weights with gather lowering, while the index read compiles to 1 operation and 1 stored weight.

## Comparisons

`emitCompare(circuit, a, relation, b)` returns an exact bit of `a > b`, `a >= b`, `a < b`, `a <= b` or `a === b`, e.g. `emitCompare(circuit, pointerX, '>=', windowLeft)`. For every pair of values within the declared ranges, the bit equals JavaScript's comparison of the two wires' FP32 values. A threshold is a constant wire, e.g. `circuit.affine([], 3)`, which folds into the bias. JavaScript compares an FP32 value with a threshold that isn't an FP32 value, e.g. 5/24, the way it compares with the smallest FP32 value at or above that threshold, while `f(5 / 24)` is below 5/24, so pick the FP32 threshold before building.

The construction depends on the declarations, not on the call site:

- Both operands need finite declared ranges. The builder refuses an open range, e.g. a raw `requestAnimationFrame` timestamp, and refuses ranges whose difference can overflow FP32, e.g. two operands declared within ±3.4e38.
- When both operands lie on [grids](#grids) and every partial sum stays within 2^24 grid steps, the bit is built from the integer `D = (a - b) / grid`: `a >= b` is `relu(1 - relu(-D))`, which equals `relu(D + 1) - relu(D)` at every integer, `a > b` is `relu(1 - relu(1 - D))`, and `a === b` is `relu(1 - relu(D) - relu(-D))`. Every product and partial sum is a whole number of grid steps, so nothing rounds.
- Otherwise the difference `d = f(a - b)` stays its own operation, and a sign cascade turns it into a bit. For finite FP32 operands, `d` is 0 exactly when `a === b`, and otherwise has the sign of `a - b`, since subnormal values fill the gap next to 0. Each stage computes `min(limit, scale × input)` as `x - relu(x - limit)` with a power-of-two scale, which is exact while `x` is at most `2^24 × limit`. The stages are planned from the declared ranges until every nonzero `d`, down to 2^-149, reaches at least 1. E.g. operands within 0..16,384 get the scales 2^10, 2^24, 2^24, 2^24, 2^24, 2^24 and 2^19, and any finite bound needs at most 12 stages.

`{endWithBoolean: true}` ends with a boolean atom instead. The cascade then stops once every nonzero difference reaches 2^-45 and rounds a score next to 0.5, and grid operands use one atom on the score `0.5 + D × 2^-24`, which needs every partial sum within 2^22 grid steps. The atom needs an executor that keeps FP32 rounding at the atom, and `backpropagateReference` rejects it unless `booleanGradient` is `'straight-through'`.

Costs, for operands within 0..16,384, or within ±8,192 on a 1/64 grid:

| Construction | `a > b` | `a >= b` | `a === b` |
| --- | --- | --- | --- |
| sign cascade | 16 operations, 15 layers | 15 operations, 14 layers | 28 operations, 14 layers |
| sign cascade ending with a boolean atom | 15 operations, 13 layers | 14 operations, 13 layers | 25 operations, 13 layers |
| integer bits on a 1/64 grid | 2 operations, 2 layers | 2 operations, 2 layers | 3 operations, 2 layers |
| one boolean atom on a 1/64 grid | 1 operation, 1 layer | 1 operation, 1 layer | 3 operations, 2 layers |

A small affine operand, which the builder normally copies into the operations that read it, becomes its own operation, since the bit is exact for the operand's own FP32 value. When grid operands span more than 2^24 grid steps, e.g. operands within 0..2^18 on a 1/64 grid, the helper builds the sign cascade instead.

What is guaranteed: on the CPU, the bit is correct for every nonzero FP32 difference, down to 2^-149. A backend that turns subnormal values into 0 may return the bit for equal operands when a difference is below 2^-126, as native comparisons on that hardware do too, e.g. Apple's GPU in lab/ui-exploration/codegen's probe. Two operands can only differ by that little when both are smaller than about 2^-103.

Backpropagation runs through integer bits and the sign cascade with no special case, since both are made of ReLU products. A cascade gives its operands gradient 0, the derivative of a step. Integer bits give an operand a nonzero gradient only when `D` is a fraction strictly between -1 and 1, e.g. between -1 and 0 for `a >= b`, and that gradient is ±1/grid, e.g. ±64 on a 1/64 grid. That only happens when a grid declaration is false.

`emitMinimumExact`, `emitMaximumExact` and `emitClampExact` select one operand with a comparison bit as `on × relu(bit) + off × relu(1 - bit)`, so the result is exactly one of the operands, e.g. `min(f(1000.37), f(0.3))` returns `f(0.3)`, while `emitMinimum` rebuilds it through a rounded difference and returns 0.29998779. Ties return the first operand, so the result differs from `Math.min` at most in the sign of zero.

Each of IndirectOS's 64 hit test atoms reads a score computed as `clamp01` of nested `emitMinimum` calls on edge distances, and those minimums can drift through rounding. Converting the 64 atoms to one `emitCompare(distance, '>=', 0.5)` bit per edge, combined as `relu(sum of bits - (count - 1))`, with pointer coordinates declared within ±2^16 on a 1/64 grid, takes IndirectOS from 5,253 to 6,973 live operations and from 192 to 209 layers. Window geometry isn't on a grid, so every comparison is a sign cascade. Over 1,612 presses, random ones and ones within 3/64 px of 0.5 px inside a window edge, every output of the converted copy equaled the original's. Ending each comparison with the atom gives 7,118 operations and 211 layers: at a bound of about 2^17, the cascade needs as many clamp stages before the atom as without it.

## Grids

`circuit.assumeGrid(wire, step)` declares that every value of a wire is a multiple of a power of two, e.g. `assumeGrid(pointerX, 1 / 64)` when the host writes pointer coordinates in 1/64 px. Like `assumeRange`, it's a caller promise. `validateGrids(circuit, values)` checks in tests that every wire with a grid holds a finite multiple of it.

The builder also infers grids it can prove. In a sum or a ReGLU product of wires with grids, each term contributes its wire's grid times the largest power of two dividing its coefficient, e.g. `0.5 × pointerX` lies on a 1/128 grid, and the result lies on the smallest of those grids, as long as every product and partial sum stays within 2^24 grid steps according to the declared ranges. E.g. `pointerX - dragStartX` on a 1/64 grid lies on the 1/64 grid, while `pointerX / 3` has no grid. Boolean atoms and comparison bits have grid 1. Index reads get no inferred grid.

## Rounding points

The builder records rounding points: operations where the exact FP32 evaluation, term order and operand wires matter. `circuit.roundingPoints()` returns them in wire order, each with a kind:

- `'boolean'`: every boolean atom, recorded automatically. `(score + 8,388,609) - 8,388,609` only rounds to a bit when evaluated in FP32 as written, and a shader compiler that simplifies it to `score` breaks it. A backend keeps the stored FP32 evaluation.
- `'integer bit'`: every operation of `emitCompare`'s integer bits on grids, e.g. the ramp `relu(-D)` and the bit `relu(1 - relu(-D))` on `D = (a - b) / grid`. Every product and partial sum is a whole number of grid steps within 2^24, so a backend may add an operation's terms in any order, fuse them, or evaluate them in float64, and gets the same bits, as long as each operation stays its own operation.
- `'sign cascade'`: every operation of `emitCompare`'s sign cascade, i.e. the kept difference `f(a - b)`, which only has to keep the sign of `a - b`, and each stage `min(limit, scale × input)`, which computes exact values in real arithmetic. A backend may evaluate an operation's own sum in any order or in float64, but must keep each operation separate and reading the same wires, e.g. copying a stage into the next stage regroups terms at large magnitudes, and the partial sums round. The smallest differences also need subnormal values: a backend that turns subnormal values into 0 returns the bit for equal operands when a difference is below 2^-126.
- `'marked'`: operations recorded with `circuit.markRoundingPoint(wire)`, e.g. each step of a round chain `(x + 2^23 + 2^22) - (2^23 + 2^22)` built with `roundAffine`. A backend keeps the stored FP32 evaluation, term order and operand wires, like at a boolean atom.

A backend that reorders or fuses sums, or a GPU backend that guards against its shader compiler simplifying `(x + K) - K`, can keep the stored evaluation at these operations and relax it elsewhere. lab/ui-exploration/exactness-budget found that stored order mattered only at boolean atoms, round chains and comparison differences in six of seven UIs. The builder records atoms and `emitCompare`'s operations itself, and round chains need `markRoundingPoint`. Inlining keeps the records. In existing circuits, only the boolean atoms are recorded, e.g. IndirectOS's 64.

## Springs and time

A spring runs as many fixed 4 ms steps as the elapsed time allows, and a program can't loop a runtime number of times, so JavaScript counts the steps and writes the effect of all of them into cells. `host-timing.ts` holds that host code: float64 functions that run between evaluations, never build operations and never touch the DOM. It's a separate module so that FP32 program semantics and float64 host arithmetic don't mix in one file.

### What JavaScript writes

- Times on a 1/64 ms grid. `quantizeTimeMs` rounds absolute timestamps before subtracting, so the durations of any split of a time span add up exactly. `quantizeFrameTiming(frameTimeStamp, previousFrameTimeMs, eventTimeStamps)` returns the frame's duration, 0 for the first frame after idle, and each event's time relative to the frame, e.g. -3.5 for a press 3.5 ms before the frame. Absolute timestamps stay in JavaScript, since an FP32 cell holding `performance.now()` stores it on a 0.5 ms grid from about 70 minutes into a session.
- A spring matrix per stiffness and damping pair. One semi-implicit Euler step of 4 ms, as in index.ts's `stepSpringTo`, is a 2×2 matrix on (displacement from the destination, velocity), so n steps are that matrix to the power n. Before each evaluation, JavaScript writes `springMatrixPower(springStepMatrix({stiffness, damping}), steps)` into the pair's 4 cells. Stiffness and damping stay editable, since they only enter the float64 computation.
- A settle check bit, a snap bit, and the evaluation's events.

### In the program

`emitApplySpringMatrix(circuit, matrix, displacement, velocity)` computes `(m0 × e + m1 × v, m2 × e + m3 × v)` with 4 `circuit.multiply` products: 14 operations in 3 layers for any step count. Over 1,500 random springs and step counts from 0 to 300, it equals the same FP32 steps written in JavaScript, and is within 1e-3 px and 1e-2 px/s of float64 Euler loops. The matrix cells need finite declared ranges, e.g. `±springMatrixBound(constants)`, so a host that writes an overflowing matrix fails the source range check.

`emitAnimatedObject(circuit, springs, {settleCheck, snap})` steps every spring of one animated object, e.g. a window's x, y, width, height and scale, and settles all of them with one exact bit. Each spring stores its displacement from its destination and its velocity, not a position:

```txt
(displacement', velocity') = matrix × (displacement, velocity)
displacement'' = f(f(destinationDuringSteps - destination) + displacement')
exceedance = Σ over springs of relu(|displacement''| - distance) + relu(|velocity'| - speed)
atRest = 1 when every displacement'' and velocity' is ±0, otherwise 0
settled = boolean(relu(0.5 × settleCheck + 0.5 × atRest - 2^20 × exceedance))
active = (1 - settled) × (1 - snap)
next displacement = f(displacement'' × active)
next velocity = f(velocity' × active)
position = f(destination + next displacement), drawn but not stored
```

The second line rebases the displacement onto this evaluation's destination. It adds the destination difference first, so when the destination is unchanged, the line adds exactly 0 and returns the stepped displacement unchanged, and rounding happens once per retarget instead of once per evaluation. FP32 then rounds the stored state at the size of the displacement and velocity rather than of the position, e.g. finely near rest at 100,000 px, where positions are 1/128 px apart. The drawn position rounds once at the destination's magnitude, and since it isn't stored, that rounding never builds up. lab/ui-exploration/gallery's kit stores displacements for the same reason, after springs near 100,000 px never settled there.

A sum of nonnegative FP32 values is 0 only when every term is 0, so `exceedance` is 0 exactly when every spring is within both thresholds, e.g. `|displacement''| <= f(0.01)`, which is index.ts's `< 0.01`, since no FP32 value lies between the two. `atRest` is built on the same fact: the ReLUs of every displacement and velocity are multiplied by 2^127 and added, so a nonzero value, down to 2^-149, adds at least 2^-22, and `relu(1 - 2^22 × sum)` is the bit. A settled or snapped object lands exactly on its destinations with zero velocity, up to the sign of zero.

- `settleCheck` is a bit the host writes. An object within both thresholds only settles while `settleCheck` is 1.
- An object whose springs are all exactly at rest, e.g. right after a snap, settles at any evaluation, so the object counts as not animating instead of staying active until the next settle check. Steps keep a spring at exact rest there until a destination changes, so settling at exact rest doesn't depend on which step counts the frames land on. In spring-matrix.test.ts, over 4 traces where about a third of the presses snap an object onto new destinations, the clock stopped at 5 of those presses without a settle check, and committed tables and displayed outputs stayed bit-identical at 10, 30, 60 and 120 fps and through 500 ms stalls.
- `snap` places the object on its destinations, e.g. while the user drags it, or when `advanceFrame` plans a snap.
- `destinationDuringSteps` is the destination the stored displacement is measured from: the one the previous evaluation wrote back, usually a state cell, since the steps simulate time before this evaluation's events. It defaults to `destination`, which is right when this evaluation's events can't change the destination.
- The settle score adds `settleCheck` and `atRest` first, so the partial sum is exactly 0, 0.5 or 1 before the exceedance is subtracted, and 0.5 - 2^20 × 2^-45 is the FP32 value just below 0.5. The score is recorded as a `'marked'` rounding point.

Cost: 29 operations in 11 layers for an object of one spring, 52 operations for 2 springs, and 128 operations in 13 layers for 5 springs with a snap bit and separate destinations during steps. Before displacements and the rest bit, the same objects were 26, 48 and 121 operations in the same layers: displacements remove one subtraction per spring, and the rest bit adds 2 ReLUs per spring and 2 operations per object. `emitSpring` is 46 operations in 33 layers for one spring.

### The ordering rule

Before an event with timestamp T is applied, springs step to T toward the destinations in effect before T, and a stopped clock starts at T. So a new destination starts pulling within 4 ms of T at any frame rate.

vibescript's ui.md orders a frame as handle inputs, new layout, animation tick, and that order is frame-rate dependent when a destination changes between two frames. A frame first applies every event that arrived since the previous frame, then runs catch-up steps from the previous frame's simulated time toward the new destination, so the new destination pulls from up to one frame plus 4 ms before the event. From rest, the first frame after the event runs 0 steps, so the animation starts at the frame's timestamp, up to one frame after the event. Both timings depend on how long frames are. In spring-matrix.test.ts's float64 copy of that order, over 8 traces of 12 presses between frames, where most presses retarget moving springs, 10, 30 and 60 fps differ from 120 fps by up to 359, 124 and 53 px at shared timestamps.

`advanceFrame(clock, frameTimeStamp, events, evaluate, writeBack)` plans a frame's evaluations in the rule's order. For each distinct event timestamp, an `'events'` evaluation runs the steps up to that timestamp and applies the events. Then a `'frame'` evaluation runs the steps up to the frame's timestamp. The host's `evaluate` callback writes each evaluation's matrices, settle check bit and events, runs the program, writes next state back when the evaluation's `writesBack` is true, and returns whether anything animates. The host keeps requesting frames while the returned clock runs.

### Settling at fixed simulated times

A spring can be within both thresholds at one step count and above the speed threshold a few steps later, as the remaining displacement accelerates it again. So a settle check once per frame depends on which step counts the frames happen to land on.

`advanceFrame` checks settling at simulated times `checkOriginMs + 64 k` ms, counted from when the clock started, with `'settle check'` evaluations that run steps up to that time with the settle check bit set, and at any evaluation while the clock is stopped. A check at simulated time c runs before events with timestamps at or after c, so at every frame rate, the check tests the same state against the same destinations. When the `evaluate` callback returns that nothing animates, the clock stops, and the next evaluation's duration is 0. The checks cost one more evaluation per 64 ms of animation, e.g. about one in four frames at 60 fps.

### Which evaluations write state back

With `'every evaluation'`, every evaluation writes next state back, so FP32 rounds the stored displacements and velocities once per evaluation, by different amounts at different frame rates. That rounding scales with the displacement, so it shrinks as springs come to rest. Over the same 8 traces at 10, 30, 60 and 120 fps and with 500 ms stalls, positions stayed within 1.4e-4 px of float64 springs whose steps don't depend on frame times, and within 1.5e-4 px of 120 fps, and all 48 runs settled at the same simulated times as float64. When springs stored absolute positions, which rounded to multiples of 2^-14 px at 800 px, positions on the same traces drifted up to 7.3e-4 px, and 2 of 48 runs settled at a different check.

With `'events and settle checks'`, only `'events'`, `'settle check'` and `'snap'` evaluations write state back, and a `'frame'` evaluation runs the program on a copy of the table, like lab/ui-exploration/event-time's commits. Stored state then depends only on the events, as long as no snap runs, see [Static bounds](#static-bounds). Over the same traces, every stored table and every displayed output at shared timestamps was identical in every bit at every rate, every run settled at the same simulated times as float64, and positions stayed within 7.4e-5 px of float64, against 8.1e-5 px when springs stored positions. Use `'events and settle checks'` where stored state must be bit-identical across frame rates.

In spring-matrix.test.ts, the same traces moved to 65,536, 131,072 and 1,048,576 px, under both policies: every run settled at the same simulated times as float64, nothing still animated 2 s after the last press, and stored displacements stayed within 1.4e-4 px of float64 up to 131,072 px. Drawn positions there were within 3.9e-3 and 7.9e-3 px of float64, half of FP32's spacing at those positions. At 1,048,576 px, FP32 values are 1/8 px apart, so the scale spring's destinations, on a 1/64 grid, rounded before they reached the program, and displacements differed from float64 by up to 0.10 px. When springs stored absolute positions, a one-time measurement on the same traces had 42 to 48 of 48 runs settle differently from float64 at each of these offsets, up to 40 runs still animating at the end, and positions up to 16.6 px off.

### Static bounds

- A frame's evaluations run at most `maxStepsPerFrame` steps together, 300 by default (1,200 ms), like ui.md's cap. Before each `'events'` or `'frame'` evaluation, when stepping to its time would run more steps than what's left of that budget, a `'snap'` evaluation runs first: the host writes 1 into the program's snap cells, e.g. the `snap` option of every `emitAnimatedObject`, every object lands on its destination with zero velocity, and the clock stops, which discards the backlog of steps. The evaluation then runs with the clock stopped. E.g. the first frame after a 2 s stall runs a snap and no steps, and shows every object at its destination.
- An event during such a stall still applies at its own timestamp. When stepping to the event would exceed what's left of the budget, springs first snap onto the destinations in effect before it, so its animation starts at its timestamp. When stepping from the event to the frame would exceed the budget too, springs snap again, onto the event's destinations. E.g. with a press 2.9 s before the first frame after a 3 s stall, the springs step to the press and snap before the frame.
- A snap's result doesn't depend on when it runs, but whether a snap runs depends on the frame times. The steps count from where springs last stepped in state that was written back. With `'every evaluation'`, that's less than 4 ms before the previous frame, so a frame gap of at most 1,200 ms never causes a snap. With `'events and settle checks'`, a frame evaluates a copy, so the steps count from the last event or settle check, which is less than 64 ms before the previous frame, and a frame gap from just above 1,140 ms can cause a snap, depending on where the last settle check landed. E.g. in spring-matrix.test.ts, after an event at 0 ms and a frame at 60 ms, a 1,144 ms gap causes a snap with `'events and settle checks'`, where the steps count from the event, while with `'every evaluation'`, a snap needs a 1,204 ms gap. After a frame at 64 ms, where a settle check wrote back, a snap with `'events and settle checks'` needs a 1,204 ms gap too. So a frame gap from about 1,140 ms with `'events and settle checks'`, or above 1,200 ms with `'every evaluation'`, can cause a snap at one frame rate and not at another, and make stored state differ across frame rates. The 3 s stall above gave bit-identical committed tables at 10, 30, 60 and 120 fps, since at all four rates, frames resume at the same frame time.
- This rule keeps the static bound: no frame runs more than 300 steps, and no time carries into later frames, so `maxCarriedMs` no longer has a use and is gone. `quantizeFrameTiming` clamps durations and event times to 1,200 ms instead. chenglou.github.io's index.ts carries leftover time instead of snapping: it runs `Math.floor((now - animatedUntilTime) / 4)` steps with no cap and keeps the rest for the next frame, while vibescript's ui.md caps a frame at 300 steps and carries the rest of the backlog into later frames.
- An event with a timestamp before the last evaluation that wrote state back applies at that evaluation's time, and an event after the frame's timestamp at the frame's.
- Inputs that change destinations, e.g. a viewport resize, should reach `advanceFrame` as timestamped events when stored state must be frame-rate independent. A destination computed from a cell that JavaScript overwrites every frame, e.g. a viewport width written without a resize event, changes at frame times, so springs pull toward it from frame times again.

### Gradients

The backward pass reaches the 4 matrix cells: `circuit.multiply` gives each cell `displacement × outputGradient` or `velocity × outputGradient`, including at an entry of exactly 0, like the identity matrix at 0 steps. Stiffness and damping never reach the program, so the backward pass gives them nothing. JavaScript can finish the chain rule by summing `d output / d entry × d entry / d stiffness` over the 4 entries, with `d entry / d stiffness` from the float64 matrix power; a measurement in lab/ui-exploration/guide/sections/differentiability.md shows that this sum equals central differences of the whole spring. The settle bit is a boolean atom, so `backpropagateReference` throws unless `booleanGradient` is `'straight-through'`, and the gradient of a settled object reaches only its destinations. For the rest bit, the ReLUs of every displacement and velocity are multiplied by 2^127 and summed inside a ReLU, so at exact rest the backward pass stops at that ReLU's corner instead of scaling gradients by 2^149.

A closed-form matrix, `exp(A × elapsed)` with `A = [[0, 1], [-stiffness, -damping]]`, could replace the Euler power later without changing the program.

## Buffer lifetime

`evaluateReference` and `evaluateTensor` return fresh full wire arrays. `createTensorEvaluator(roots)` captures a compiled program and reuses work buffers. Its result contains only the requested roots, in the requested order, and the next call overwrites the same result array. Copy it when retaining a frame. Recreate the evaluator after changing the circuit.

All current execution is JavaScript on the CPU. Sparse tensor-like storage is not evidence of a GPU implementation or GPU speedup. The runtime-cost study measures allocation and output-copying changes independently of scheduling.

Size: loop. Short entry: [patterns.md, "A linear step repeated a runtime number of times"](../../../../patterns.md#a-linear-step-repeated-a-runtime-number-of-times).

# Repeated steps as one matrix power

Moves a spring through all of an evaluation's fixed 4 ms steps at once, e.g. a window sliding toward its destination through the 4 steps of a 16.7 ms frame, without a loop that runs a runtime number of times.

```txt
one 4 ms step on (displacement, velocity) is a 2×2 matrix M, so n steps are M^n
steps = 13 = 1 + 4 + 8
digit             0      1      2      3
bit               1      0      1      1
factor           M^1     I     M^4    M^8        I + bit × (M^(2^digit) − I), powers computed while building
                   \____/        \____/
                    M^1           M^12
                       \__________/
                           M^13               (displacement', velocity') = M^13 × (displacement, velocity)

or JavaScript writes M^13 into 4 cells, or writes M^0 to M^300 once and an index read picks M^13
```

## The loop it replaces

index.ts's `stepSpringTo`, where `steps` comes from this frame's timestamp:

```ts
for (let i = 0; i < steps; i++) {
  const Fspring = -previous.k * (pos - dest)
  const Fdamper = -previous.b * v
  v += (Fspring + Fdamper) * t
  pos += v * t
}
```

A compiled program runs each of its layers exactly once, so it can't run this loop a runtime number of times. With constant stiffness k, damping b and step t, one step is linear in the displacement `e = pos − dest` and the velocity: `v' = −k·t·e + (1 − b·t)·v` and `e' = (1 − k·t²)·e + t·(1 − b·t)·v`. So a step is a matrix, combining steps is matrix multiplication, which is associative, and powers of one matrix commute, so every grouping and order of the product is the same real matrix.

## The circuit

Three builds that apply the same runtime number of steps ([matrix-powers.ts](../examples/patterns/combining-steps/matrix-powers.ts), trimmed):

1. JavaScript writes the matrix, the default Cheng chose on September 14, 2026. host-timing.ts's `springMatrixPower` squares in float64, and `emitApplySpringMatrix` applies the 4 cells with 4 products. It needs finite declared ranges on the cells, e.g. `±springMatrixBound(constants)`, about 6.88 for stiffness 290 and damping 30:

```ts
const bound = springMatrixBound(springConstants)
for (const entry of matrix) circuit.assumeRange(entry, -bound, bound)
const stepped = emitApplySpringMatrix(circuit, matrix, displacement, velocity)
// The host, before each evaluation:
source.set(springMatrixPower(springStepMatrix(springConstants), steps), matrixStart)
```

2. The circuit builds the power from the step count. Long division with `emitCompare` gives the 9 binary digits of a step count declared on a grid of 1, each digit picks a factor as an affine sum, and a balanced tree of 2×2 products multiplies the factors in pairs, then pairs of pairs:

```ts
const power = springMatrixPower(step, 2 ** digit) // float64, while building
const entry = (entryIndex: 0 | 1 | 2 | 3) => circuit.roundAffine(
  [[bit, power[entryIndex] - identitySpringMatrix[entryIndex]]], identitySpringMatrix[entryIndex])
```

3. A table of powers. JavaScript writes M^0 to M^300 into 4 columns of 301 cells once per stiffness and damping pair, and `circuit.indexRead(sampleSteps, entryColumn)` picks each entry of M^i at a computed step count, e.g. to sample where a spring will be i steps from now. event-time uses the same idea across evaluations: sample i of a prediction holds M^i in the 4 matrix cells, and 301 samples show where every spring will be over the next 1,200 ms.

## Cost

For S springs that share one stiffness and damping pair, with at most N steps:

| Build | Operations | Layers | 1 spring | 20 springs |
| --- | --- | --- | --- | --- |
| JavaScript writes the matrix | O(S) | O(1) | 14 operations, 3 layers | 280 operations, 3 layers |
| digits and a tree of products | O(log N + S) | O(log N) | 208 operations, 40 layers | 474 operations, 40 layers |
| table of powers | O(S), plus 4 reads | O(1) | 18 operations, 4 layers | |

In build 2 the digits alone are 26 operations in 26 layers, since long division tests one digit after another. For scale, unrolling the loop with one mask per possible step is 3,301 operations in 902 layers for one spring and up to 300 steps ([springs](../sections/springs.md#1-unroll-the-maximum-number-of-steps-with-one-mask-per-step)). Builds 1 and 3 move float64 work into JavaScript: O(log N) 2×2 products per stiffness and damping pair per evaluation, or 301 matrices whenever stiffness or damping change.

## When it's exact

Products and sums round in FP32, so the grouping is part of the result, and no build equals the float64 loop bit for bit:

- Build 1 rounds the spring's state once per evaluation instead of once per step. Its outputs equal `f(f(m0 × displacement) + f(m1 × velocity))` over the FP32 entries JavaScript wrote, bit for bit, and stayed within 3e-4 px of the float64 loop over 1,000 random springs within ±2,000 px and ±20,000 px/s. For adversarial springs up to ±65,536 px and 1,000,000 px/s, the error stayed below 1e-6 times the spring's size, i.e. the largest of 1 px, the starting displacement, and the starting velocity times 4 ms.
- Build 2 groups the product differently from JavaScript's squaring. Its outputs differed from build 1's in their last bits for more than half of the 1,336 springs tested, within the same bounds. Its digits are exact bits, since `emitCompare` builds integer bits on the declared grid.
- Build 3 is a selection. An index read copies the FP32 entries JavaScript wrote without rounding, so its outputs equal build 1's bit for bit at every step count. The step count must hold an integer, which `validateIndexReads` checks in tests.

## When not to use it

- Steps that aren't linear with constant coefficients, e.g. stiffness that depends on position, or items that push each other apart. Unroll a small maximum count instead.
- Stiffness and damping held in cells inside the program. A step then multiplies runtime values, and a chain of steps no longer collapses into constant weights, e.g. 2,142 operations in 1,295 layers for one spring in build 2's per-spring form ([springs](../sections/springs.md#2-powers-of-the-step-matrix-chosen-by-the-step-counts-binary-digits)). Builds 1 and 3 keep them in JavaScript.
- Build 2 on today's CPU executor, where JavaScript computing the power is far smaller and shallower. Build 2 only pays off when the clock has to stay inside the program, so the host only writes a frame's duration or step count.

## Where it's used

- numeric-ui-core.ts's `emitApplySpringMatrix` and `emitAnimatedObject`, with host-timing.ts's `springMatrixPower` and `advanceFrame`, are the default spring ([execution-model.md](../../../../execution-model.md#springs-and-time), [shared-runtime-springs.ts](../examples/springs/shared-runtime-springs.ts)).
- [springs](../sections/springs.md#4-javascript-writes-the-frame-matrix), forms 2 to 4, measure each way to run a runtime number of steps, and [chains](../sections/chains.md#which-steps-combine-into-a-step-of-the-same-kind) lists linear maps among the steps that combine into a step of the same kind.
- [spring-bank](../../spring-bank/README.md): IndirectOS went from 5,253 operations and 192 layers with its original springs to 3,580 and 137 with matrix powers read from constant tables through one-hots (`split-table`), and to 3,413 operations with JavaScript writing the matrix (`source-matrix`).
- [event-time](../../event-time/README.md): predictions of 301 samples, where sample i holds M^i, turned into Web Animations keyframes.
- Example and test: [matrix-powers.ts](../examples/patterns/combining-steps/matrix-powers.ts) and [matrix-powers.test.ts](../examples/patterns/combining-steps/matrix-powers.test.ts).

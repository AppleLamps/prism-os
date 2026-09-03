# Execution model

An Indirect program has one fixed source width and an ordered instruction list. State, constants, and browser inputs enter through a `Float32Array`. Each instruction appends one number; a wire is its numeric position.

## FP32

`f(x)` means `Math.fround(x)`. Affine terms run in stored order:

```txt
value = f(bias)
for (wire, coefficient) in terms:
  value = f(value + f(f(coefficient) * values[wire]))
```

Ordinary builder expressions normalize terms by ascending wire. Explicitly rounded operations retain the caller's term order, including repeated terms. A backend promising exact agreement must keep the stored order, including when inlining remaps wire numbers.

## Instructions and macros

```txt
affine(left)      = left
reglu(left, gate) = f(left * max(0, gate))
boolean(score)   = f(f(f(score) + 8_388_609) - 8_388_609)
```

`left` and `gate` are affine forms. `boolean` accepts `0..1`; values below `0.5` become zero, and the rest become one. Instructions read sources and earlier instructions, never future ones.

`Circuit.affine` is a builder expression: small affine producers can be combined before execution. `Circuit.roundAffine` retains a specific evaluation, term order, and operand wires, so consumers cannot remove a required FP32 rounding point. It does not combine duplicate terms or move constant terms into the bias.

Multiplication and selection retain semantic metadata on their expanded outputs. The forward program still contains only the three atoms. The metadata supplies the intended whole-operation derivatives, prevents accidental removal of rounding, and helps recognize masked products. Inlining a circuit preserves the metadata.

Backpropagation differentiates the intended real arithmetic, not literal floating-point rounding. A hard boolean gradient is rejected unless the caller explicitly requests `{booleanGradient: 'straight-through'}`. A soft comparison or a custom derivative is a training choice, not an exact derivative of a hard decision.

## Compilation

Independent instructions at the same dependency depth share a layer. A layer gathers its earlier inputs, evaluates its sparse affine projection, applies ReGLU gates and boolean rounding, and appends outputs.

Compilation removes operations that cannot reach a requested output and may reorder independent values in packed storage. `wireOrder` maps packed values to source wire positions. Removed wires stay zero in a full result array and cannot be requested as outputs.

The literal instruction evaluator defines the compiled numeric semantics. The tensor backend must reproduce every live value. The usual validator compares with `===`, ignoring zero's sign; NaN results do not pass that validator. Nonfinite edge-case tests explicitly check matching NaN or infinity where relevant.

This agreement does not prove that a source compiler preserved JavaScript behavior. The trace compiler separately checks its float64 source interpreter against native JavaScript, then reports intended FP32 drift.

## One-hot groups and gathers

`assumeOneHot(members)` declares exact zero/one values with exactly one one; a variant permits all-zero. It is a caller contract like `assumeRange`, not a general theorem prover. Automatic declarations require the builder's limited provenance checks.

A masked sum covering each group member exactly once can become a gather when every candidate has finite FP32 bounds. The executor resolves the group's index once, then reads one candidate per gather. A candidate admitting infinity must remain dense, since an unselected `Infinity * 0` can produce NaN. Bounds follow each rounded operation; finite float64 endpoints alone are insufficient.

This optimizes retrieval after selection. It does not learn query/key scoring, remove all candidate computation, or make an arbitrary scored lookup constant-time.

## Buffer lifetime

`evaluateReference` and `evaluateTensor` return fresh full wire arrays. `createTensorEvaluator(roots)` captures a compiled program and reuses work buffers. Its result contains only the requested roots, in the requested order, and the next call overwrites the same result array. Copy it when retaining a frame. Recreate the evaluator after changing the circuit.

All current execution is JavaScript on the CPU. Sparse tensor-like storage is not evidence of a GPU implementation or GPU speedup. The runtime-cost study measures allocation and output-copying changes independently of scheduling.

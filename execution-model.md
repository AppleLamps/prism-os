# Execution model

An Indirect program has one fixed source width and an ordered list of numeric
instructions. All changing state, constants, and external facts enter through
one `Float32Array`.

Every instruction appends one number. A wire is only the numeric position of a
source or appended value.

## FP32 arithmetic

`f(x)` means `Math.fround(x)`.

An affine form is evaluated in stored term order:

```txt
value = f(bias)
for (wire, coefficient) in terms:
  value = f(value + f(f(coefficient) * values[wire]))
```

The compiler currently stores terms in ascending wire order. Any other backend
must preserve that order if it promises exact agreement.

## Instructions

```txt
affine(left) =
  left

reglu(left, gate) =
  f(left * max(0, gate))

boolean(score) =
  f(f(f(score) + 8_388_609) - 8_388_609)
```

`left` and `gate` are affine forms. `boolean` accepts scores in `0..1`, maps
values below `0.5` to `0`, and maps `0.5` or above to `1`.

Instructions may read sources and earlier instructions. They cannot read
future instructions.

## Compiled layers

Independent instructions at the same dependency depth share a layer. A layer:

1. Gathers only the earlier values it reads.
2. Evaluates every affine projection in row order.
3. Multiplies ReGLU output rows by their rectified gate rows.
4. Applies Boolean rounding to marked output rows.
5. Appends the output rows to the live value table.

Compilation may remove instructions that cannot reach a requested root. It may
also reorder independent instructions inside the packed value table. The
`wireOrder` array maps those packed values back to their original wires.

The returned result has the original graph width. Sources and live wires hold
their computed values. Removed wires remain zero and must not be read as
outputs.

## Correctness

The literal instruction interpreter defines the result. A compiled backend is
correct when every live wire has exactly the same FP32 value as that
interpreter.

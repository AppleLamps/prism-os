# Execution model

An Indirect program has one fixed source width and an ordered instruction list.
State, constants, and browser facts enter through one `Float32Array`. Each
instruction appends one number; a wire is its numeric position.

## FP32

`f(x)` means `Math.fround(x)`. Affine terms run in stored order:

```txt
value = f(bias)
for (wire, coefficient) in terms:
  value = f(value + f(f(coefficient) * values[wire]))
```

Terms are stored by ascending wire. A backend promising exact agreement must
keep that order.

## Instructions

```txt
affine(left)       = left
reglu(left, gate)  = f(left * max(0, gate))
boolean(score)     = f(f(f(score) + 8_388_609) - 8_388_609)
```

`left` and `gate` are affine forms. `boolean` accepts `0..1`; values below
`0.5` become `0`, and the rest become `1`.

Instructions may read sources and earlier instructions, never future ones.

## Compilation

Independent instructions at the same dependency depth share a layer. A layer:

1. gathers only the earlier values it reads
2. evaluates its sparse affine projection
3. applies ReGLU gates and Boolean rounding
4. appends its outputs

Compilation removes values that cannot reach a requested output and may reorder
independent values in packed storage. `wireOrder` maps packed values back to
their source wires. Removed wires stay zero and cannot be requested as outputs.

The literal instruction interpreter defines correctness. A compiled backend
must produce the same FP32 value for every live wire.

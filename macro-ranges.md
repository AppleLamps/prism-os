# Macro magnitude preconditions

The macros in `numeric-ui-core.ts` lower to affine, ReGLU, and boolean operations. Exactness means equality to the stated FP32 calculation, ignoring the sign of zero, not equality to arbitrary JavaScript float64 arithmetic. `f(x)` means `Math.fround(x)`.

| Macro | Forward calculation | Exactness contract |
| --- | --- | --- |
| `emitMultiply(a, b)` | One ReGLU product, or the difference of positive and negative products | Equals `f(f(a) * f(b))` for finite operands, including a product overflowing to infinity |
| `emitMaximum(a, b)` | `b + relu(a - b)` | Integer operands with magnitudes below `2**23`; arbitrary fractional inputs can drift |
| `emitMinimum(a, b)` | `a - relu(a - b)` | Same restriction as maximum |
| `emitSelect(gate, off, on)` | `gate * on + (1 - gate) * off`, with preserved rounding | At gate zero or one, returns the corresponding finite operand exactly, including extreme magnitude differences |
| `clamp01(v)` | `relu(v) - relu(v - 1)` | The upper plateau requires `v <= 2**24`; negative finite values produce zero |
| Settled `emitSpring` | Select destination and multiply velocity by zero | Once its active bit reaches zero and the operands are finite, destination and zero velocity are exact |

## Multiplication and gradients

For signed finite operands, only one arm of `a * relu(b) - a * relu(-b)` is nonzero. The subtraction does not introduce additional error, and the result matches one FP32 multiplication.

The builder preserves multiplication as metadata on its expanded result. Backpropagation uses the derivative of multiplication, including at zero. Differentiating the two ReLUs independently with zero slope at their shared corner previously returned the wrong derivative in one operand order. This metadata adds no runtime atom. `inlineCircuit` preserves it.

## Selection

The older `off + gate * (on - off)` expansion could lose a small selected value, or overflow `on - off` even when both candidates were finite. Both failures are covered by regression tests. The current two-product expansion avoids subtracting the candidates during forward execution.

A fractional gate performs interpolation with FP32 rounding; it is not an exact real-number calculation. Infinite or NaN candidates are outside the finite-operand contract because an unselected product can still compute `0 * Infinity`.

## Minimum and maximum

These constructions still have narrower guarantees than native `Math.min` and `Math.max`. For example, `emitMaximum(2**24, -1)` produces `16777215`, and the corresponding minimum produces zero instead of minus one. Fractional values can drift even at small magnitudes. The trace compiler uses comparison and selection where it needs exact selection between fractional operands.

The subtraction and reconstruction now preserve their rounding order and operand values. Bounds describe that arithmetic, not an ideal mathematical min/max. For finite nonnegative inputs, minimum is bounded by `0..a.maximum`, which allows a rounded result below the smaller input. Maximum retains `0..1` only when both inputs are in that interval. Other cases use the conservative arithmetic bounds, including possible overflow.

## Clamping and springs

The subtraction in `clamp01` stops producing the intended plateau at large magnitudes: `2**24 + 2` can produce two, and `2**25` produces zero. Keeping each stage below that range is part of the sign cascade's forward construction.

A spring's exact settled state depends on reaching an exact inactive bit. It does not imply that every preceding integration step equals a float64 spring, or that gradients through arbitrary temporal dynamics are necessarily stable.

## Bounds and rounding

Inferred ranges follow the rounded coefficient, product, and accumulated sum at each FP32 step. Potentially nonfinite products are not treated as finite zero. Gather lowering requires finite FP32 candidate bounds, not merely finite float64 endpoints.

`Circuit.affine` remains a builder expression that may combine small affine producers. Use `Circuit.roundAffine` when an evaluation must remain a separate rounding point. It also preserves term order, including constant and duplicate terms. Multiplication and selection preserve their operand wires automatically.

`assumeRange` and `assumeOneHot` are caller contracts, not proofs. A false declaration can still authorize an invalid optimization. See `numeric-semantics.test.ts`, `macro-ranges.test.ts`, and the gather differential tests.

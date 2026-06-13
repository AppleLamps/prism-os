# Macro magnitude preconditions

The macro library in `numeric-ui-core.ts` lowers `multiply`, `min`, `max`,
`select`, `clamp01`, and springs into affine / reglu / boolean atoms. Each
expansion reconstructs its real-valued definition only inside an FP32 magnitude
window. Outside that window an intermediate sum or difference re-rounds and the
result silently drifts. These preconditions are unstated in the source; the
table below is what the compiled UI relies on. Characterized by
`macro-ranges.test.ts`.

`f(x)` is `Math.fround(x)`. "ulp" is the FP32 unit in the last place: 1 in the
binade `[2**23, 2**24)`, 2 in `[2**24, 2**25)`, 4 in `[2**25, 2**26)`.

## Safe-range table

| Macro | Expansion | Safe range (bit-exact) | One-line justification |
| --- | --- | --- | --- |
| `emitMultiply(a, b)` | `reglu` single product (or `+`/`-` of two for mixed signs) | every finite operand pair, including overflow to `±Infinity` | one FP32 multiply with no recombining add, so it equals `f(f(a)*f(b))` unconditionally |
| `emitMaximum(a, b)` | `b + relu(a - b)` | integer `a, b` with `|a|, |b| < 2**23` | keeps `|a - b| < 2**24`, so both `a - b` and `b + relu(a - b)` stay integral and lossless |
| `emitMinimum(a, b)` | `a - relu(a - b)` | integer `a, b` with `|a|, |b| < 2**23` | mirror of max: same `|a - b| < 2**24` bound keeps every step integral |
| `emitSelect(gate, off, on)`, gate = 0 | `off + gate*(on - off)` | any finite `on, off` | `off + 0 = off`; no recombination path, so the off rail is unconditional |
| `emitSelect(gate, off, on)`, gate = 1 | `off + gate*(on - off)` | `off = 0` for any `on`; otherwise integer `on, off` with `|on|, |off| < 2**23` | reconstructing `on = off + (on - off)` needs neither subtraction to re-round; `|on - off| < 2**24` guarantees that |
| `clamp01(v)` = `emitClampZeroOne` | `relu(v) - relu(v - 1)` | `v < 2**24` | needs `v - 1` representable; first fails at `v = 2**24 + 2` (ulp 2 ⇒ `v - 1` rounds to `v - 2`, returns 2), and collapses to 0 at `v = 2**25` |
| `emitSpring` settled branch | `select(active, dest, pos)`, `multiply(active, vel)` | once `active` rounds to 0 (distance and speed below their settle thresholds) | settling drives `active = 0`, so `position = select(0, dest, pos) = dest` and `velocity = multiply(0, vel) = 0`, both bit-exact |

## Notes per macro

### emitMultiply — exact for all finite inputs

The only macro with no magnitude precondition. For a non-negative operand it is
one `reglu` (`a * relu(b)` with `b ≥ 0`); for mixed signs it splits into two
reglu products that an affine subtracts. Each path produces exactly one FP32
multiply, matching `f(f(a) * f(b))` bit-for-bit across all signs and magnitudes,
and overflows to `±Infinity` identically when the product is too large. There is
no second rounding step to introduce drift.

### emitMaximum / emitMinimum — integers below 2**23

`max(a, b) = b + relu(a - b)` re-rounds in two places: forming `a - b`, and
recombining `b + relu(a - b)`. Both stay exact only when every intermediate is
representable. Integers keep `a - b` integral, and bounding `|a|, |b| < 2**23`
keeps `|a - b| < 2**24` (ulp 1), so the difference and the recombination are
lossless.

Known failures characterized in the tests:

- `max(2**24, -1) = 16777215`, one less than the true `16777216`. Here
  `a - b = 2**24 + 1` rounds down to `2**24`, then `b + relu(...)` subtracts the
  lost 1. `a = 2**24` is the first failing integer winner (every integer below it
  with `b = -1` is exact).
- `min(2**24, -1) = 0` instead of `-1`, the mirror failure: `a - relu(a - b) =
  2**24 - 2**24 = 0`.
- Fractional operands re-round even at small scale: `max(422.88…, -79.53…)`
  already misses, because adding two fractional FP32 values does not reconstruct
  exactly. The integer safe range does **not** extend to arbitrary reals.
- When the small operand is the winner, disparity is harmless: `max(-1, 2**e)`
  is exact for all `e` because `relu(a - b) = 0` leaves `b` untouched.

### emitSelect — gate=0 unconditional, gate=1 integer-bounded

`select(gate, off, on) = off + gate*(on - off)`.

- gate = 0: `off + 0 = off`, exact for any finite `on`/`off`, including enormous
  magnitude disparity. The off rail has no precondition.
- gate = 1: must reconstruct `on` through `off + (on - off)`. With `off = 0` this
  is `on` for any value. Otherwise it is exact only for integer `on, off` with
  `|on|, |off| < 2**23` (so `|on - off| < 2**24`).
- gate = 1 is **not** exact at large magnitude disparity, contrary to a naive
  assumption: `select(1, 1e10, 1) = 0` (the tiny `on` is swallowed when
  `on - off` rounds to `-off` and `off + (-off) = 0`), and
  `select(1, 1000, 3.14159)` rounds `on` away. The gate=1 rail shares the same
  re-rounding hazard as `emitMaximum`.

### clamp01 — v below 2**24

`emitClampZeroOne(v) = relu(v) - relu(v - 1)` (with `unit = 1`). For
`0 ≤ v ≤ 1` it returns `v`; for `v > 1` it should return 1. That plateau holds
only while `v - 1` is representable:

- exact for `v < 2**24` (every power of two from `2**0` through `2**24` returns
  1).
- first fails at `v = 2**24 + 2`: in the binade `[2**24, 2**25)` ulp is 2, so
  `v - 1` rounds to `v - 2`, and `relu(v) - relu(v - 1) = 2` instead of 1.
- collapses to **0** at `v = 2**25`: ulp is 4, `v - 1` rounds back up to `v`, so
  both relu arms cancel.

Because clamp01 gates spring settling (`emitSpring`'s `active`), keeping its
input below `2**24` matters whenever the clamp could see large operands.

### emitSpring — settled branch

The settled branch was previously untested. After the four fixed integration
steps, `active = clamp01(scaled distance-over-threshold + scaled
speed-over-threshold)`. When the spring settles, both relu terms are 0, so
`active` rounds to 0. Then:

- `position = emitSelect(active, destination, position)` takes the gate=0 (off)
  rail, returning `destination` bit-exactly.
- `velocity = emitMultiply(active, velocity) = 0 * velocity = 0` exactly.

So a settled spring lands on its destination with exactly zero velocity, for
every destination tested (positive, negative, and with nonzero initial
velocity), with no residual drift. This relies on `active` reaching an exact 0,
which the clamp01 boolean-free path produces once the thresholds are cleared.

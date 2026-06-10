# Boolean state

A score is not automatically a decision. A rectangle edge may produce `0.3`;
that is useful for smooth math but invalid for `open`, `focused`, or
`maximized`.

Use `boolean(score)` when a value in `0..1` must become an exact bit:

```txt
score < 0.5  -> 0
score >= 0.5 -> 1
```

Use it for click ownership, focus, visibility flags, and other Boolean state.
Do not use it for positions, sizes, opacity, scale, springs, or ordinary
epsilon-based animation settling.

Once a bit exists, ordinary Boolean arithmetic preserves it. The rounding step
is needed only where a continuous score becomes a decision.

Runtime rounding is exact FP32 and stays separate during compilation. If this
program is trained later, its backward pass may use a surrogate gradient; that
does not change the exact forward result.

Layout remains full-precision FP32. It is not quantized to a browser pixel grid.

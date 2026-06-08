# Boolean state

Continuous scores must not become Boolean state by accident.

A rectangle hit can return `0.3` near an edge. That is useful as a score, but
not as `maximized`, `open`, or `focused`. Passing it into Boolean arithmetic
would create a partly maximized or partly focused UI.

Use `boolean(score)` when a value in `0..1` must become a decision:

```txt
score < 0.5  -> 0
score >= 0.5 -> 1
```

Runtime evaluation uses an exact FP32 rounding step. The compiler keeps that
step separate, so it cannot be folded into nearby arithmetic.

Use this for:

```txt
which item receives a click
selected, open, minimized, and maximized state
focus and ordering where exactly one item must be active
```

Do not use it when fractions remain meaningful:

```txt
positions and sizes
opacity and scale
springs
ordinary epsilon-based animation settling
```

Boolean arithmetic preserves exact bits once they exist. The special step is
only needed when a continuous score first becomes a Boolean.

If this program is trained later, training may pretend that `boolean(score)`
equals `score`. That supplies a useful direction for updates, but it does not
describe the rounded runtime behavior exactly.

We are not quantizing layout to a `1/64px` grid for now.

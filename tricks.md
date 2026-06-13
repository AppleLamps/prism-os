do not change this before asking the user

# Tricks

## Instancing

Use one shared function for repeated items:

```txt
rectangle = layout(instance index, count, container, shared inputs)
```

This can produce many rectangles without separate layout logic for every item.
The circuit still needs a fixed maximum item count for now.

## One-hot indexing

Recover a selected index from exact one-hot bits:

```txt
selected index = selected[0] * 0 + selected[1] * 1 + ...
```

Compute this once, then let every item compare itself with the shared index.
This can replace an `items * possible selections` lookup with one reduction
followed by one calculation per item. It does not provide cyclic wraparound by
itself; use a bounded wrap correction or circular coordinates for that.

## Circular coordinates

Represent a position in a repeating sequence as a point on an imaginary circle.
The first and last items are then naturally close, so cyclic distance and
direction need no modulo jump. For a fixed item count, the circle points are
constants and the remaining math is differentiable.

## FP32 rounding

FP32 loses fractional precision near a sufficiently large number. Add
`8_388_609`, then subtract it, to turn a score in `0..1` into an exact bit.

Use this only when smooth values become Boolean decisions. Keep positions,
sizes, opacity, scale, and animation at full precision.

## Dynamic division

Explore whether FP32's changing precision can provide enough nonlinearity to
compute a useful reciprocal, then multiply by the numerator. This could support
division between two runtime values without adding division as a primitive.

This has not been validated.

## Bounded visibility compaction

If at most ten of one hundred items can be visible, first compute one cheap
visibility bit per item. Count earlier visible items to give each visible item
a number, then route visible numbers `0..9` into ten output slots.

The circuit keeps a fixed shape: one hundred visibility checks followed by ten
expensive item paths. It does not know which ten items ahead of time. This still
needs an exact-bit routing test in our compiler before we rely on it.

## Parallel argmax

Compare candidates in pairs, then compare the pair winners until one remains.
Route that result back down the same tree to produce a one-hot winner.

This selects among `N` candidates in `log N` dependent steps. Every comparison
on the same step runs independently, and the full construction remains
differentiable apart from the explicit Boolean decisions it contains.

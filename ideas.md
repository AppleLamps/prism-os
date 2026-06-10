do not change this before asking the user

# Ideas

## Dynamic behavior

Put layout mode, gap, enabled flags, and visibility in the source table. Change
those numbers without recompiling, then exhaustively test a small combination
space. This distinguishes changing behavior from ordinary changing state.

Let an agent edit only those behavior cells for tasks such as:

```txt
put the rectangles in a row
hide rectangle 3
make selecting rectangle 2 reveal rectangle 3
```

## Relations

Try a fixed `n*n` relation table where cell `(i, j)` says how much item `j`
affects item `i`: covers it, pushes it, reveals it, or follows it in keyboard
focus.

Then change only relation numbers to turn the same slots into a row, stack,
tabs, or a parent with revealed children.

## Candidate futures

Evaluate several next source tables together:

```txt
candidate 0 = focus item 1
candidate 1 = focus item 2
candidate 2 = expand group
```

Score them and commit one. This becomes useful once batching has a real backend.

## Validity outputs

When machines edit raw numbers, compute clear validity results: nonnegative
sizes, at most one focused item, visible click targets, allowed overlap, and
content bounds.

## Inverse layout

Specify output goals instead of a named layout algorithm: even spacing, fit in
the viewport, or give the selected item most of the area. Test whether numeric
optimization can find useful source or behavior values.

## Representation

Revisit fixed point, bounded ranges, mixed representations, and dynamic
division only when a concrete derivation needs them.

# Parallel winner reduction

Given exact `0/1` candidates, select the first active one.

```txt
[0 1 0 1 0 0 1 0]
 \_/ \_/ \_/ \_/
  1   1   0   1
   \_/     \_/
    1       1
      \___/
        1
```

Each pair takes its maximum. Ties keep the left side. The winning signal then
travels back down the same tree, producing one `1` and zeros everywhere else.

Every pair on one row is independent, so the compiler places them in the same
layer. Selection takes logarithmic depth instead of checking candidates one
after another. Total work remains linear.

For exact bits, this handles overlapping hit targets with fixed priority.

Continuous scores use the same tree. Each pair compares its two scores, keeps
the larger one, and routes the final winner back down. Exact ties keep the left
candidate. The comparison allows a one-FP32-step tie margin; score differences
smaller than that margin also keep the left side.

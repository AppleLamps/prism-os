Size: loop. Short entry: [patterns.md, "`findIndex` when passing items can be anywhere, and keeping the best score so far"](../../../../docs/patterns.md#findindex-when-passing-items-can-be-anywhere-and-keeping-the-best-score-so-far).

# The highest score, in a tree

Given a score for each candidate, e.g. how well each candidate layout fits the viewport, select the candidate with the highest score, with ties going to the earlier candidate.

```txt
[0.2 0.7 0.7 0.1 0.4 0.9 0.3 0.9]   scores
  \___/   \___/   \___/   \___/
   0.7     0.7     0.9     0.9      each pair keeps the larger score: right, left, right, right
    \_______/       \_______/
       0.7             0.9          on a tie, the left one: left, left
        \_______________/
               0.9                  right

[0   0   0   0   0   1   0   0]     a 1 routed down the recorded decisions: right, left, right
```

## The loop it replaces

Keeping the best so far, where a later candidate needs a strictly higher score:

```js
let bestLayout = 0
for (let layout = 1; layout < layoutScores.length; layout++) {
  if (layoutScores[layout] > layoutScores[bestLayout]) bestLayout = layout
}
```

vibescript's gesture-flick-snap-target runs the same loop over distances in `nearestCorner`, keeping the smallest.

## The circuit

`emitArgmax(circuit, scores, unit)` in numeric-ui-core.ts takes scores declared within 0..1 and a wire that holds 1. For each pair, a boolean atom compares the two scores, a select keeps the larger score, and the comparison's result is stored as a decision bit; then the 1 is routed down along those decision bits, so the result is a one-hot that `emitArgmax` declares. From [highest-score-tree.ts](../examples/patterns/selection/highest-score-tree.ts):

```ts
const {selected, score} = emitArgmax(circuit, scores, unit)
const bestLayout = circuit.roundAffine(selected.map((bit, layout) => [bit, layout] as const))
// A masked sum over the one-hot, which the compiler lowers to one gather.
const chosenThumbnailWidth = circuit.affine(
  selected.map((bit, layout) => [circuit.multiply(thumbnailWidths[layout]!, bit), 1] as const))
```

The example also builds the tree with exact comparisons, `emitHighestScoreExact`, whose combining step is:

```ts
const rightIsLarger = emitCompare(circuit, right.score, '>', left.score)
const score = emitSelect(circuit, rightIsLarger, left.score, right.score)
```

The loop and the tree select the same candidate because this combining step, "the larger score, and the left one on a tie", gives the same result however candidates are grouped: any grouping returns the first candidate with the highest score. The example builds both groupings from the same step, `'exact chain'` in the loop's order and `'exact tree'`, and the test checks both against the loop.

## Cost

A tree is O(n) operations in O(log n) layers, and a chain O(n) operations in O(n) layers. Selection alone, pinned by [highest-score-tree.test.ts](../examples/patterns/selection/highest-score-tree.test.ts):

| Candidates | `emitArgmax` | Exact tree, scores on a 1/64 grid | Exact tree, no grid |
| ---: | --- | --- | --- |
| 3 | 10 operations, 8 layers | 12 operations, 11 layers | 40 operations, 37 layers |
| 8 | 45 operations, 15 layers | 52 operations, 18 layers | 150 operations, 57 layers |
| 64 | 437 operations, 33 layers | 500 operations, 39 layers | 1,382 operations, 117 layers |

The exact chain has the same operations as the exact tree, and 438 layers on the grid or 1,257 without a grid at 64 candidates. The index of the chosen layout and a read of its thumbnail width add 2 operations and 1 gather: 12 operations in 10 layers at 3 candidates with `emitArgmax`.

## When it's exact

- `emitArgmax`'s comparison scales the difference of two scores into a value next to 0.5 and rounds it with a boolean atom, which needs an executor that keeps FP32 rounding there. On an exact tie the left candidate is kept, and it's also kept when the right score is only slightly larger: in the test's sweep of 1,025 left scores within 0..1, each with right scores 1 to 8 FP32 steps above, the left candidate was kept for every right score less than 1.04e-7 larger, and for some up to 2.09e-7 larger.
- That band isn't transitive, so grouping matters inside it. With scores [0, 0.5, one FP32 step above 0.5, two steps above 0.5], `emitArgmax` keeps 0.5 over the score one step above it, and keeps that score over the score two steps above, but picks the score two steps above over 0.5. The tree pairs candidate 0 with 1 and candidate 2 with 3. Inside the band it keeps candidate 2 over candidate 3, then keeps candidate 1 over candidate 2, so candidate 3 is never compared with candidate 1, and the tree picks candidate 1. The loop picks 3, and so does a chain of `emitArgmax` comparisons in the loop's order, which keeps candidate 1 over candidate 2 and then compares candidate 1 with candidate 3.
- With `emitCompare`, `[right > left]` is exact for every pair of FP32 values within the declared ranges, so both groupings match the loop on every input, e.g. 0 mismatches over 2,000 random sets of 4 scores, each within 3 FP32 steps of the next, where `emitArgmax` picked a different candidate in some. Scores need finite declared ranges, not necessarily 0..1. When the scores are declared on a grid, the builder infers the grid of every selected score, so every comparison in the tree is an integer bit; otherwise every comparison is a sign cascade.

## When not to use it

- Evenly spaced positions, e.g. snapping to the nearest page of a carousel: rounding the position and one index read cost a few operations, where a tree over 8 position scores is 55 operations in 17 layers ([indexing](../sections/indexing.md#hard-attention-as-the-limit)).
- Scores that can differ by a few FP32 steps, e.g. from spring arithmetic, when the choice must match JavaScript: `emitArgmax` can pick a different candidate. Quantize the scores onto a grid in the host, or use the exact tree, which without a grid is 4.6 times as deep as `emitArgmax` at 3 candidates and 3.5 times at 64.
- Training: `backpropagateReference` throws on `emitArgmax`'s atoms, and straight-through gradients give slopes that aren't there, so train through a soft read, e.g. a softmax, and use the tree in the circuit that runs ([lab/cascade-argmax](../../../cascade-argmax/README.md)).

## Where it's used

- [candidate-gallery.ts](../../../candidate-gallery/candidate-gallery.ts): scores its cinema, contact sheet and story layouts, each score the minimum of how well that layout's sizes fit, and reads the chosen layout's thumbnails and hero through `emitArgmax`'s one-hot.
- [lab/cascade-argmax](../../../cascade-argmax/README.md): the tree with hand-built sign cascades, trained through soft comparisons and then run as the exact circuit, which picked the right candidate in 160 of 160 cases.
- [indexing](../sections/indexing.md#hard-attention-as-the-limit): hard attention, with scores that are highest at the nearest position, and with runtime keys for snap targets ([hard-attention.ts](../examples/indexing/hard-attention.ts)).
- [instanced-items](../../instanced-items/README.md): the `argmax` reduction between per-item stages.
- [comparisons](../sections/comparisons.md#which-form-to-use-by-default): which comparison form `emitCompare` builds, and what each costs.
- Example and test: [highest-score-tree.ts](../examples/patterns/selection/highest-score-tree.ts) and [highest-score-tree.test.ts](../examples/patterns/selection/highest-score-tree.test.ts).

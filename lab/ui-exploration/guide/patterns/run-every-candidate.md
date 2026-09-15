# Run every candidate, then pick one

Compute several complete candidates on every frame, e.g. three whole gallery layouts, give each candidate a score, and show the candidate with the highest score.

```txt
viewport 1024 x 480 --+--> hero layout  --> score 0.70 --+
                      |                                  |
                      +--> grid layout  --> score 0.84 --+--> argmax --> [0 0 1] --> every rectangle of the strip layout
                      |                                  |
                      +--> strip layout --> score 0.94 --+
```

Each layout's rectangles and score are computed from the same inputs without reading the other layouts, so the three layouts sit side by side in the same layers. The argmax is a tournament over the scores ([parallel-winner.md](../../../../parallel-winner.md)), and its one-hot picks every output from the same layout, so the page never shows the hero's width from one layout next to a thumbnail's position from another.

## The loop it replaces

```ts
// Build every layout, and keep the first one with the highest score.
const layouts = [heroLayout, gridLayout, stripLayout].map(buildLayout => buildLayout(viewportWidth, viewportHeight))
let chosenLayout = 0
for (let index = 1; index < layouts.length; index++) {
  if (layouts[index].score > layouts[chosenLayout].score) chosenLayout = index
}
return layouts[chosenLayout]
```

Front-end code more often picks a layout with hand-written conditions, e.g. `viewportWidth / viewportHeight > 1.6 ? heroLayout(...) : stripLayout(...)`. A score instead measures how close each layout's sizes are to their target sizes, e.g. how close the hero's width is to 1,024 px, and the demo keeps such numbers in cells, where a designer or a solver can change them.

## The circuit

Each layout is ordinary builder code that returns its rectangles and a score within 0..1: `Math.min(1, size / targetSize)` for each size, then the smallest of those. Then ([run-every-candidate.ts](../examples/patterns/candidates-and-tables/run-every-candidate.ts)):

```ts
const candidates = [hero, grid, strip]
const scores = candidates.map(candidate => candidate.score)
const argmax = emitArgmax(circuit, scores, one)
// JS: layouts[chosenLayout].field, as a masked sum over the argmax's one-hot. Every value has a finite
// declared range, so the compiler turns each masked sum into one gather.
const pick = (field: (candidate: CandidateWires) => Wire) => circuit.affine(
  candidates.map((candidate, index) => [emitMultiply(circuit, argmax.selected[index]!, field(candidate)), 1] as [Wire, number]),
)
```

When each candidate either fits or doesn't, and earlier candidates are preferred, e.g. a toolbar that shows labels when they fit, otherwise icons, otherwise an overflow menu, `emitFirstActive` over the fit bits gives the one-hot instead of `emitArgmax`.

## Cost

For C candidates: the sum of every candidate's operations, plus O(C) operations and O(log C) layers for the tournament and for routing its one-hot back down, plus one gather per distinct picked number. Depth is the deepest score, plus the tournament, plus 1 layer of gathers.

Measured by the example's test: 3 layouts of 8 photos are 114 live operations in 25 layers. The three scores alone are 60 operations in 16 layers, the argmax takes the program to 71 operations and 24 layers, and reading the picked layout's 37 numbers and its index adds 43 operations, 18 of them gathers, and 1 layer. The Dynamic UI demo, [candidate-gallery.ts](../../../../candidate-gallery.ts), with 12 photos, clicks and focus, is 417 operations in 60 layers, of which its scores are 81 operations in 18 layers.

## When it's exact

- `emitArgmax` throws when a score isn't declared within 0..1. The tournament routes exactly one 1 down the tree, so the one-hot is exact, and every output is exactly one candidate's value.
- On an exact tie the leftmost candidate is kept, and so is the left candidate when the right score is only slightly larger: in the sweep of [the highest score, in a tree](highest-score-tree.md#when-its-exact), the left candidate was kept for every right score less than 1.04e-7 larger and for some up to 2.09e-7 larger, and some right scores in between were picked. So when several candidates can reach the same score, e.g. every layout scoring 1 on a large viewport, the pick depends on the order of the candidates; the example lists the hero layout first.
- A JavaScript version picks the same candidate only when its scores come out the same. In the example, sizes lie on eighth pixel grids and target sizes are powers of two, so every score is a multiple of 2^-10 in both FP32 and float64, and two different scores differ by far more than the band above. The test compares the circuit with the loop on a 32 px sweep of 16,641 viewports, 2,000 random viewports and named cases, e.g. the tie between the hero and grid layouts at 112 × 96. Every viewport runs through the compiled program, and 147 of them also through `evaluateReference`.
- A masked sum becomes a gather only when every candidate value has a finite declared range. Otherwise the dense sum runs, and an unpicked candidate holding Infinity turns `0 × Infinity` into NaN.

## When not to use it

- When the choice depends only on one runtime width, and JavaScript can find the widths where the choice changes while preparing: [breakpoints found ahead of time](breakpoints-found-ahead-of-time.md) cost 2 operations per threshold in 3 layers, instead of every candidate's work.
- When there are many candidates, or each one is expensive: every candidate runs on every frame whether or not it's picked, like both sides of a select.

## Where it's used

- [candidate-gallery.ts](../../../../candidate-gallery.ts), the Dynamic UI demo (`bun run start:candidates`): the Cinema, Contact and Story layouts of 12 photos, with 7 quality scales, i.e. reciprocals of target sizes, in cells.
- [drag-knobs](../../drag-knobs/README.md) runs its drag solver on a copy of the candidate gallery, with the gap, the rail's maximum width and the 7 quality scales as design numbers in cells, and adds each layout's unclamped score to find where the picked layout would change.
- [ideas.md](../../../../ideas.md), "Candidate futures", applies the same construction to next-state values, e.g. the candidates "focus item 1", "focus item 2" and "expand group", scored, with one committed. [Chains](../sections/chains.md#running-the-same-logic-several-times-one-per-guess) describes event-time's version, candidate futures as instances of one program. Neither was built.
- [Speculation](speculation.md) also runs several candidates, one per possible value of an input that isn't computed yet, and keeps the one that matches instead of the one with the best score.
- Example and test: [run-every-candidate.ts](../examples/patterns/candidates-and-tables/run-every-candidate.ts) and [run-every-candidate.test.ts](../examples/patterns/candidates-and-tables/run-every-candidate.test.ts).

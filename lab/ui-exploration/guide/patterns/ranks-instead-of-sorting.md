# Ranks instead of sorting

Each item's position after sorting is computed directly, i.e. how many items come before it, e.g. each card's slot in a stack sorted by date, which is what the DOM needs for a `translateY`.

```txt
                   other item:   0    1    2    3
keys:                           30   10   30   20
item 0 (key 30)                  ·    1    0    1   → rank 2
item 1 (key 10)                  0    ·    0    0   → rank 0
item 2 (key 30)                  1    1    ·    1   → rank 3
item 3 (key 20)                  0    1    0    ·   → rank 1
```

An entry is 1 when the other item comes before this item. Items 0 and 2 have equal keys, and the earlier item comes first, like a stable sort. One comparison per pair gives both of the pair's entries, and no comparison reads another, so all n(n − 1)/2 comparisons share the same layers.

When one item moves, e.g. a dragged card, each other card gets a bit that is 1 when the dragged card passes it:

```txt
rank              0     1     2     3     4
card              A     B     C     D     E     D is dragged, pointerY = 50 px
midpoint         20    60   100     ·   180
passed upward     0     1     1     ·     0     [rank < 3] AND [pointerY < midpoint]
next rank         0     2     3     1     4     D moves up by the count of passed cards, 2
```

## The loop it replaces

```ts
const order = items.map((_, item) => item).sort((left, right) => keys[left] - keys[right] || left - right)
let top = 0
for (const item of order) {
  itemTops[item] = top
  top += heights[item]
}
```

And vibescript's draggable-cards (demos/draggable-cards/index.ts), where `shouldSwapUp` is `pointerY < neighborDestY + neighborSizeY / 2`:

```ts
while (dragIdx > 0 && shouldSwapUp(pointerLast.y, st.data[dragIdx - 1].y.dest, st.data[dragIdx - 1].sizeY)) {
  [st.data[dragIdx], st.data[dragIdx - 1]] = [st.data[dragIdx - 1], st.data[dragIdx]] // swap
  dragIdx--
}
// then the same loop downward, with shouldSwapDown
```

## The circuit

From [ranks-instead-of-sorting.ts](../examples/patterns/every-item/ranks-instead-of-sorting.ts), trimmed. Keys are declared on a grid of 1 with `circuit.assumeGrid`, so `emitCompare` builds each bit as an integer bit of 2 operations:

```ts
earlierFirst[earlier][later] = emitCompare(circuit, keys[earlier], '<=', keys[later])
// rank = the earlier items whose bit is 1 plus the later items whose bit is 0, one sum
const rank = circuit.roundAffine(terms, bias)
```

An item's top is one sum of `comesBefore × height` products, one per other item, so 2 products per pair. The update when a card moves reads last frame's ranks and card tops:

```ts
const before = emitCompare(circuit, rank, '<', fromRank)
const midpoint = circuit.roundAffine([[cardTop, 1], [cardHeight, 0.5]])
const passedUpward = circuit.reglu([], 1, [[before, 1], [emitCompare(circuit, pointerY, '<', midpoint), 1]], -1) // AND
// passedDownward the same way, with [rank > fromRank] and [pointerY > midpoint]
const nextRank = circuit.roundAffine([[rank, 1], [passedUpward, 1], [passedDownward, -1], [circuit.multiply(rankShift, isDragged), 1]])
```

`rankShift` is the count of passedDownward bits minus the count of passedUpward bits, and `isDragged` is `1 − before − after`. Card midpoints never decrease along ranks, so the cards the pointer passes form one run next to the dragged card, which is the run each while loop walks, and each loop's number of swaps is a count.

## Cost

- Ranks: O(n²) operations at O(1) depth. 64 items are 4,096 operations in 3 layers, i.e. 2,016 integer bits of 2 operations each plus 64 sums, and 128 items are 16,384 operations. With the item tops, 64 items are 8,192 operations in 4 layers. The loops section's example builds each integer bit from 3 operations, so its 64 ranks are 6,112 operations.
- The update when one card moves: O(n) operations at O(1) depth, 14 operations per card. 100 cards are 1,404 operations in 8 layers, and 1,000 cards 14,004 operations in 8 layers. In lists' port of draggable-cards at 100 cards, the whole circuit was 69,653 operations with ranks recomputed every frame, and 36,207 with the update.

## When it's exact

- Keys compare exactly: integers, or values declared on a grid. Keys that come out of non-integer arithmetic, e.g. spring positions, get a sign cascade from `emitCompare`, which still gives the exact bit for every pair of FP32 values but costs 15 operations and 14 layers per `<=` within 0..16,384.
- Ranks are sums of exact bits. Tops are exact while heights lie on a grid and totals stay below 2^24 grid steps, e.g. below 2^22 px for heights in quarter pixels.
- The update needs sorted midpoints: every card the loops can pass sits where last frame's stack layout put it, in rank order. The example declares tops, heights and pointerY on a 1/64 px grid, so every midpoint comparison is an integer bit.

## When not to use it

- For well past a hundred items: pairwise ranks grow as n². A sorting network is O(n log² n) operations at O(log² n) depth, e.g. 10,624 operations and 105 layers against 16,512 operations and 5 layers for 64 items with a payload ([loops](../sections/loops.md#a-sorting-network-instead)).
- When the order is known while building, e.g. a fixed menu: sort in JavaScript while building, and the order becomes wiring.
- When many items move in one frame, e.g. switching the sort from date to name: the update doesn't apply, so recompute the ranks.

## Where it's used

- [lists](../../lists/README.md): the port of draggable-cards, with ranks recomputed (`rankCount`) and with the update (`incremental`). Both matched the demo's card order, z index and dragged card on all 284,000 compared frames at 5 to 100 cards.
- [Loops, section 5](../sections/loops.md#5-ranks-instead-of-sorting): sorted reads through the permutation matrix, sorting networks, and the same update over `fromRank` and `toRank`.
- Example and test: [ranks-instead-of-sorting.ts](../examples/patterns/every-item/ranks-instead-of-sorting.ts) and [ranks-instead-of-sorting.test.ts](../examples/patterns/every-item/ranks-instead-of-sorting.test.ts), which compare with a stable sort on tied, extreme and random keys, and with draggable-cards' while loops for pointers on every midpoint and one 1/64 px step to either side, in both evaluators.

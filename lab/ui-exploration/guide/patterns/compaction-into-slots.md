Size: loop. Short entry: [patterns.md, "`items.filter(isVisible).slice(0, K)` into K DOM nodes"](../../../../docs/patterns.md#itemsfilterisvisibleslice0-k-into-k-dom-nodes).

# Compaction into K DOM slots

A filtered list shows its first K visible items in K reusable DOM nodes: every item's visibility is computed in the same layers, a prefix sum numbers the visible items, and DOM slot k shows the visible item numbered k.

```txt
item                     0   1   2   3   4   5   6   7
visible                  0   1   1   0   1   0   1   1    1 when the item passes the filter
visibleThrough           0   1   2   2   3   3   4   5    a prefix sum of those bits

DOM slot 2 shows the item where visibleThrough first reaches 3:
[visibleThrough <= 2]    1   1   1   1   0   0   0   0
neighbor differences     0   0   0   0   1   0   0   0    → item 4

or by binary search: read visibleThrough at 7, 3, 5, 4 and get 5, 2, 3, 3;
add the step (8, 4, 2, 1) whenever the count is at most 2 → 4, so item 4
```

Which items will be visible isn't fixed while building, so each DOM slot tests every item's count, or runs a binary search over the counts.

## The loop it replaces

```ts
const shownItems = []
for (let item = 0; item < items.length && shownItems.length < slotCount; item++) {
  if (items[item].price >= minPrice && items[item].price < maxPrice) shownItems.push(item)
}
```

## The circuit

From [compaction-into-slots.ts](../examples/patterns/every-item/compaction-into-slots.ts), trimmed. Prices and the filter's bounds are integers declared on a grid of 1:

```ts
const visible = prices.map(price => circuit.reglu([], 1, [
  [emitCompare(circuit, price, '>=', minPrice), 1],
  [emitCompare(circuit, price, '<', maxPrice), 1],
], -1)) // AND of two bits
const visibleThrough = emitPrefixCounts(circuit, visible) // a Brent-Kung network of roundAffine additions
```

With one-hots, as in lists' routing.ts: `[visibleThrough[item] <= k]` is `relu(k + 1 − count) − relu(k − count)`, and consecutive k share a ReLU. The neighbor differences along items, declared with `circuit.assumeOneHot(isShown, true)`, mark slot k's item, and each field the slot shows is a masked sum that the compiler lowers to one gather read.

With index reads, each slot runs a binary search for how many items have a count of at most k:

```ts
for (let step = 2 ** (stepCount - 1); step >= 1; step /= 2) {
  const count = circuit.indexReadAffine([[position, 1]], step - 1, visibleThrough, 'clamp', 'clamp')
  circuit.assumeGrid(count, 1) // an index read gets no grid
  position = circuit.roundAffine([[position, 1], [emitCompare(circuit, count, '<=', slotIndex), step]])
}
const price = circuit.indexRead(position, prices, {outOfRange: 'zero'})
```

When fewer than k + 1 items are visible, the search ends past the last item, where the read returns +0, and the slot's presence bit, `present = [visibleThrough[n − 1] >= k + 1]`, is 0.

## Cost

- Visibility and counts: O(n) operations at O(log n) depth, 6,984 operations and 20 layers for 1,000 items.
- One-hot routing: O(n × K) operations at O(1) depth after the counts, 2 operations per item per slot. 1,000 items into 20 DOM slots are 47,044 operations, 24 layers and 129,948 stored weights in all.
- Binary search: O(K log n) operations at O(log n) depth after the counts, about 4 operations and 4 layers per step. 1,000 items into 20 DOM slots are 7,824 operations and 57 layers in all, and 10,000 items into 24 are 71,373 operations and 80 layers.
- lists measured 49,224 operations and 27 layers for 1,000 items into 20 with one-hots, and in hn-thread, 48 DOM slots over 251 comments were 25,616 operations, about as much as the rest of the UI.

## When it's exact

- The visibility test is exact, e.g. integers or values on a declared grid.
- The counts are sums of exact bits, exact in any grouping below 2^24, so a Brent-Kung network gives the loop's counts.
- One-hots: the gather reads rely on the `assumeOneHot` declaration without checking it, so tests run `validateOneHotGroups`, and every field needs a finite declared range.
- Binary search: every index holds an integer, which `validateIndexReads` checks in tests. Without the grid declared on each read, `emitCompare` builds a sign cascade, which gives the same bits in more operations and layers.

## When not to use it

- When the visible items form one run, e.g. rows scrolled into view: DOM slot k shows `firstVisibleRow + k`, O(n + K) operations. hn-thread's window slots were 1,269 operations against 25,616 for rank slots, but rows of height 0 use up slots: a collapsed subtree in view needed 32 window slots where rank slots needed 7.
- When the per-item work that each DOM slot runs, instead of every item running it, is small: one-hot routing costs about 2 operations per item per slot, so lists found it pays off only once the per-item work costs more than about 2 + 2K operations, e.g. 42 for 20 slots.
- When K is close to the item count: run the per-item work for every item, and let JavaScript skip the hidden ones.

## Where it's used

- [patterns.md](../../../../docs/patterns.md#itemsfilterisvisibleslice0-k-into-k-dom-nodes): the short entry, which absorbed tricks.md's "Bounded visibility compaction", where the idea was first written down.
- [lists](../../lists/README.md): capacity routing, 1,000 items into 20 DOM slots, 0 mismatches over 208 visibility patterns.
- [hn-thread](../../hn-thread/README.md): rank slots for the comments in view, and window slots.
- [lists](../../lists/README.md#merged-from-index-read-september-16-2026): prefix counts and a binary search per slot, 10,000 operations and 49 layers for 1,000 items into 20, measured in [index-read](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/index-read)'s copy of the runtime.
- [Executor, UI jobs under each choice](../sections/executor.md#ui-jobs-under-each-choice): the forms side by side, and the first visible row of a scrolled list.
- Example and test: [compaction-into-slots.ts](../examples/patterns/every-item/compaction-into-slots.ts) and [compaction-into-slots.test.ts](../examples/patterns/every-item/compaction-into-slots.test.ts), which compare both forms with the loop on none, all, exactly K − 1, K and K + 1 visible items at the end, only the first or last item, and random filters, in both evaluators.

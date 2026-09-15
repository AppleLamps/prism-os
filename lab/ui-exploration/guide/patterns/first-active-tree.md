# The first active candidate, in a tree

Given exact 0/1 candidates in priority order, e.g. the hit bits of overlapping click targets from front to back, select the first candidate that holds 1, as a one-hot, or all zeros when no candidate does.

```txt
[0 1 0 1 0 0 1 0]    up: each pair takes its maximum
 \_/ \_/ \_/ \_/
  1   1   0   1
   \_/     \_/
    1       1
      \___/
        1            any candidate active, times the gate

        1            down: the route goes left when the left side holds a 1
      /   \
    1       0
   / \     / \
  1   0   0   0
 / \ / \ / \ / \
[0 1 0 0 0 0 0 0]    the selection
```

## The loop it replaces

chenglou.github.io's index.ts tests a click against the rectangles it presented. Boxes scale and animate, so presented rectangles can overlap, and the loop tests the topmost box first and returns the first hit (`hitTestPresented2DMode`, trimmed):

```js
function hitTestPresented2DMode(boxes, pointerX, pointerY) {
  // Higher indexes have higher z-indexes, so the topmost box comes first.
  for (let i = boxes.length - 1; i >= 0; i--) {
    const {x, y, sizeX, sizeY, scale} = boxes[i]
    const presentedSizeX = sizeX.pos * scale.pos
    const presentedSizeY = sizeY.pos * scale.pos
    const presentedX = x.pos - (presentedSizeX - sizeX.pos) / 2 // CSS scales around the center
    const presentedY = y.pos - (presentedSizeY - sizeY.pos) / 2
    if (presentedX <= pointerX && pointerX < presentedX + presentedSizeX
      && presentedY <= pointerY && pointerY < presentedY + presentedSizeY) return i
  }
  return null
}
```

The candidates in priority order are the boxes from the topmost down, and the circuit below tests plain rectangles in that order.

## The circuit

Every target's hit bit is computed at once, in the same layers, and `emitFirstActive(circuit, gate, candidates)` in numeric-ui-core.ts picks the first hit, where the gate is a bit that is 1 when a selection should happen, e.g. `pressed`. Going up, each node holds the maximum of its two children, i.e. 1 when any candidate under it is active. Going down, the gate is routed to the left child when the left child holds a 1, and to the right child otherwise, so it arrives at the first active candidate. From [first-active-tree.ts](../examples/patterns/selection/first-active-tree.ts), trimmed:

```ts
const hits = targets.map(({left, top, width, height}) => {
  const right = circuit.affine([[left, 1], [width, 1]])
  const bottom = circuit.affine([[top, 1], [height, 1]])
  const insideBits = [
    emitCompare(circuit, left, '<=', pointerX), emitCompare(circuit, pointerX, '<', right),
    emitCompare(circuit, top, '<=', pointerY), emitCompare(circuit, pointerY, '<', bottom),
  ]
  return circuit.reglu([], 1, insideBits.map(bit => [bit, 1] as const), -3) // AND of 4 bits
})
const selected = emitFirstActive(circuit, pressed, hits)
circuit.assumeOneHot(selected, true) // all zeros allowed, when nothing is hit
const pressedTarget = circuit.roundAffine(selected.map((bit, target) => [bit, target] as const))
```

The loop and the tree give the same selection because the combining step, "the left group's first active candidate if the left group has one, otherwise the right group's", gives the same result however candidates are grouped: combining a with b and then with c, or a with the combination of b and c, both return the first active candidate among a, b and c. The loop combines one candidate at a time, which the example builds as `emitFirstActiveChain`: `selected = remaining × hit`, then `remaining = remaining − selected`.

## Cost

The tree is O(n) operations in O(log n) layers: 5n − 4 operations in 5 log2 n + 1 layers when n is a power of two, 3 layers for each maximum going up and 2 for each route going down. The chain is O(n) operations in O(n) layers: 2n − 1 of each. Selection alone, over hit bits in source cells, pinned by [first-active-tree.test.ts](../examples/patterns/selection/first-active-tree.test.ts):

| Candidates | Chain | Tree |
| ---: | --- | --- |
| 4 | 7 operations, 7 layers | 16 operations, 11 layers |
| 16 | 31 operations, 31 layers | 76 operations, 21 layers |
| 64 | 127 operations, 127 layers | 316 operations, 31 layers |
| 1,024 | 2,047 operations, 2,047 layers, 5,117 stored weights | 5,116 operations, 51 layers, 9,793 stored weights |

With 15 overlapping rectangles, the hit bits are 165 operations in 4 layers, and with the pressed index and the pressed target's left edge read through one gather, the whole program is 238 operations in 26 layers with the tree and 196 operations in 35 layers with the chain. `emitFirstActive` pays 3 layers for each maximum because it accepts fractional candidates; the gallery prototype's `emitFirstSetBit` in gallery/kit.ts, written for exact bits only, is 2 log2 n layers, and took the whole gallery to 61 layers where `emitFirstActive` gave 80 ([gallery](../../gallery/README.md)'s size table).

## When it's exact

- When the gate and every candidate are exact bits, every value inside the tree is 0 or 1, so nothing rounds, and the grouping of FP32 sums doesn't matter. Fractional candidates are accepted, but the route splits: candidates [0.5, 0] send 0.25 to each output.
- `emitFirstActive` declares its output a one-hot group only when it can prove the gate and every candidate are exact bits: boolean atoms, bits returned by `emitCompare`, members of declared one-hot groups, index reads over such bits, or wires whose range is exactly 0 or exactly 1. A 0..1 source cell or an AND built with a ReLU doesn't count, so the example declares the group itself and its test runs `validateOneHotGroups`. The declaration is what lets a masked sum over the selection, e.g. the pressed target's left edge, compile to one gather.

## When not to use it

- Candidates that can't overlap, e.g. photos in a grid or rows in a list: at most one hit bit is 1, so the hit bits already are the selection, and rows in order are a [count](count-instead-of-search.md). E.g. index.ts's hover test, `hitTest2DTargets`, has the same shape as the click loop above, but over layout targets, which don't overlap.
- A handful of candidates on today's CPU executor, which pays for operations, not layers: at 4 candidates the chain is 7 operations in 7 layers, against 16 in 11.
- When depth matters more than stored weights: selecting the candidate that is hit and has no earlier hit, `relu(hit − hitsBefore)` over wide prefix sums, is 2,046 operations in 2 layers with 525,822 stored weights at 1,024 candidates ([loops](../sections/loops.md#2-when-the-test-isnt-monotone-the-first-hit)), and took the gallery from 61 to 41 layers.

## Where it came from

On June 9, 2026, Photos selected one of about 15 overlapping click targets, the previous and next controls, the thumbnails and the main image, with a chain in priority order. Cheng asked whether anything was written "too much like cpu and not enough like shaders/gpu", pushed from a version where each target's selection read the hit bits of all earlier targets toward "block-wise winners, recursive", and `emitFirstActive` replaced the chain. The README in that commit (dfee7a6) records the whole circuit going from 75 to 70 layers, for 0.3% more stored weights (13,094 to 13,138). With today's runtime, where `circuit.multiply` keeps its operands as separate operations, the same chain at 15 candidates is 29 operations in 29 layers, against 71 operations in 20 layers for the tree. [parallel-winner.md](../../../../parallel-winner.md) describes the construction in the repo root.

## Where it's used

- [photo-gallery.ts](../../../../photo-gallery.ts): Photos' click priority, the previous and next controls, then the thumbnails, then the main image. [candidate-gallery.ts](../../../../candidate-gallery.ts): the clicked thumbnail of the chosen layout.
- [lab/event-window](../../../event-window/README.md): overlapping rectangles, maximized rectangles first, then the lowest index.
- [gallery](../../gallery/README.md) and [instanced-items](../../instanced-items/README.md): the photo under a click, as a tournament and as the `firstActive` reduction between per-photo stages. In this guide: [loops](../sections/loops.md#2-when-the-test-isnt-monotone-the-first-hit) with [first-hit.ts](../examples/loops/first-hit.ts), and the hovered card in [instancing](../sections/instancing.md#a-runnable-example-a-row-of-cards)'s [cards-duplicated.ts](../examples/instancing/cards-duplicated.ts).
- Not yet in IndirectOS: `emitFrontmost` in [window-manager.ts](../../../../window-manager.ts) still scans the stacking order one rank at a time.
- Example and test: [first-active-tree.ts](../examples/patterns/selection/first-active-tree.ts) and [first-active-tree.test.ts](../examples/patterns/selection/first-active-tree.test.ts).

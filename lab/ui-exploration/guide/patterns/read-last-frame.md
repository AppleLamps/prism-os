Size: behavior choice. Short entry: [behavior-choices.md, "Read last frame's value"](../../../../behavior-choices.md#read-last-frames-value).

# Read last frame's value

Let a stage read a stored copy of a value from the previous evaluation instead of this evaluation's value, so the stage's layers no longer come after the chain that computes the value, and the stage's output is a frame behind while the value moves.

```txt
reading this evaluation's width: one chain, 30 layers
  toggle -> springs -> drawn width -> column bits -> thumbnail layout

reading last evaluation's width: two chains, the longer one 17 layers
  toggle -> springs -> drawn width -> written back into previousWidth
  previousWidth -> column bits -> thumbnail layout
```

## What the user sees differently

In [drawer-grid.ts](../examples/patterns/fewer-dependencies/drawer-grid.ts), 12 thumbnails reflow from 2 to 5 columns while a drawer springs from 320 to 760 px wide. Laid out for last evaluation's width, the grid trails the drawer's edge by up to 60 px at 60 fps and 159 px at 10 fps, and switches to a new column count a frame after the edge crosses a threshold: over 8 traces, 158 of 3,007 frames at 60 fps drew a different column count, which moved a thumbnail by up to 533 px. At rest both layouts are the same.

## The loop it replaces

In ui.md's render loop, the layout comes after the animation tick and reads this frame's spring:

```ts
// Animation tick
stepSpring(st.drawerWidth, st.open ? 760 : 320)
// New layout, for this frame's width, or for last frame's with st.previousDrawerWidth
const width = st.drawerWidth.pos
const columnCount = Math.min(5, Math.max(1, Math.floor(width / 120)))
const cellSize = width / columnCount
for (let index = 0; index < 12; index++) {
  thumbnails[index].left = (index % columnCount) * cellSize
  thumbnails[index].top = Math.floor(index / columnCount) * cellSize
}
// Commit state
st.previousDrawerWidth = st.drawerWidth.pos
```

## The circuit

A delayed value is one more source cell, whose next value is the value itself, copied back with the other next-state values (drawer-grid.ts, trimmed):

```ts
circuit.assumeRange(drawerCell.previousWidth, 0, widthLimit)
const drawer = emitAnimatedObject(circuit, [{matrix, displacement, velocity, destination, destinationDuringSteps}], {settleCheck, snap})
const drawnWidth = drawer.positions[0]
// Lay out for last evaluation's width instead of drawnWidth.
const layoutWidth = drawerCell.previousWidth
// JS: columnCount = Math.min(5, Math.max(1, Math.floor(width / 120)))
const widthReaches = [2, 3, 4, 5].map(columns => emitCompare(circuit, layoutWidth, '>=', constant(columns * 120)))
// ... the cell size and each thumbnail's left and top, as sums over those bits and products with layoutWidth
nextSource[drawerCell.previousWidth] = drawnWidth
```

The width comes out of spring arithmetic and isn't on a grid, so each column bit is a sign cascade, which `emitCompare` builds from the cell's declared range, 0..1,024. The executors check that range on every evaluation.

## Cost

No more operations, one more source cell, and one more copy per evaluation that writes back. The longest chain through the value becomes the longer of the part that computes the value and the part that reads it, instead of the two added together. Pinned by [read-last-frame.test.ts](../examples/patterns/fewer-dependencies/read-last-frame.test.ts):

| Layout reads | Operations | Layers |
| --- | --- | --- |
| this evaluation's drawn width | 144 | 30 |
| last evaluation's width | 144 | 17 |
| the springs right after this evaluation's steps | 145 | 21 |

In IndirectOS, Photos reading last frame's content size and opacity took the longest chain from 191 to 116 layers ([retiming](../../retiming/README.md)).

## When it's exact

The stored copy equals this evaluation's value while the value doesn't move between two evaluations that write back, e.g. at rest. Otherwise the copy is off by how far the value moved since the last evaluation that wrote back, and with `advanceFrame` that evaluation can be a settle check or an event instead of the previous frame. Given the width it reads, the layout matches the JavaScript loop: column counts exactly, and positions within 5e-4 px, over random widths and widths next to every threshold, in both evaluators.

## When not to use it

- For decisions. A column count a frame late moved thumbnails by up to 533 px here, and retiming counted a photo focused a frame late as a real one-frame glitch.
- When an earlier value from the same evaluation exists. A spring's position right after this evaluation's steps, `destinationDuringSteps` plus the displacement of `emitApplySpringMatrix`, is 4 layers deep. The drawer's layout reading that sum is 21 layers deep and drew the same layout as this evaluation's width in every frame, since the two differ only at evaluations where the springs settle, snap or change destination. In IndirectOS the same idea took spring-bank's springs from 137 to 91 layers, with Photos 6.6 px off during a live resize, against 85.7 px for last frame's value.
- With [commits at events](commit-at-events.md), where the previous evaluation means the last commit. The drawer's width lag grows from 60 px to 174 px at 60 fps, and event-time's Photos reading the last commit was 507 px off during a maximize.

## Where it's used

- [Long dependency chains](../sections/chains.md#way-4-read-last-frames-value), way 4, and the glossary's [delay](../README.md#chains-of-steps).
- [retiming](../../retiming/README.md) turned delays into a program transformation and searched for them. Hand-chosen delays were 86 to 1,380 px off, e.g. layout-tree's app shell reading last frame's sidebar spring went from 115 to 83 layers and was 1,380 px off, and delays searched on one trace produced over 7,000 decision mismatches on random traces.
- [indirect-os-2](../../indirect-os-2/README.md), where text obstacles that read last frame's stacking made words start moving a rendered frame later, and the shared clock then put windows 28.8 px apart between 60 and 120 fps.
- [event-time](../../event-time/README.md), which measured what a delayed read costs when only commits write back.
- Example and test: [drawer-grid.ts](../examples/patterns/fewer-dependencies/drawer-grid.ts) and [read-last-frame.test.ts](../examples/patterns/fewer-dependencies/read-last-frame.test.ts).

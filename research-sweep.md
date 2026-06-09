# Research sweep

The decision rule was simple: land changes that strengthen the numeric model
without adding a new product concept. Park changes that mainly add machinery,
formats, modes, or generated state.

## Landed

- **Random compiler equivalence**: seeded random circuits compare every live
  FP32 wire between the literal and compiled executors.
- **Execution specification**: `execution-model.md` fixes instruction,
  rounding, accumulation, and layer semantics.
- **Scrolling and occlusion**: the Palette product window uses native vertical
  scrolling over 20 preallocated numeric rows of three responsive cells.
  Only visible cells have attached DOM nodes.

## Already sufficient

- The window manager already covers dynamic state, overlap, topmost hit
  selection, dragging, resizing, focus, controls, animation, and long mixed
  event sequences.
- Adjustable app constants and external facts already enter through the source
  table.
- Affine composition has removed every affine-to-affine dependency in both
  product circuits. There is no remaining consecutive affine layer to fuse.
- Left and gate projections already share one pass.
- Sparse weights, compact layer inputs, dead-value removal, common-expression
  merging, constant folding, aliases, and sign reasoning are already present.

## Parked

### `codex/compiler-mutation-tests`

Hostile tensor mutations are caught, but the experiment adds 49 lines that
mostly restate local validator checks. Random equivalence gives broader value.

### `codex/executor-split`

A dependency-free executor is possible in 97 lines, but the split adds a
module and 11 total lines without simplifying the current product.

### `codex/precompiled-demos`

Precompilation speeds machine construction, but adds a generator and a 124 KB
generated source file. Browser JavaScript grew from roughly 70/43 KB to
180/170 KB for the two demos.

### `codex/portable-format`

A validated JSON tensor format round-trips exactly. It costs 128 lines and
creates versioning plus a second representation without a current consumer.

### `codex/layer-scheduling`

Latest legal scheduling increased gathered inputs from 3,511 to 4,127 for the
window manager and from 350 to 402 for the gallery. Sparse weight count cannot
improve through scheduling because each instruction keeps the same terms.

### `codex/relation-layout`

The older visual relation demo works, but adds about 400 lines and replaces the
richer gallery.

### `codex/gpu-megakernel`

Both programs fit one 256-thread workgroup: their largest projections have 212
and 137 rows. A single-workgroup megakernel is feasible but underuses the GPU.
It becomes interesting when many candidate source tables run in parallel.

### `codex/slot-reuse`

Reusing packed temporaries alone saves about 4.5 KB for the window manager and
1 KB for the gallery. Larger savings require a root-only output contract, a
free-slot allocator, and a separate full-wire debug path.

## Not added

- The relation and inverse-layout tests encoded eight item ranks as 32 unary
  relation bits, then searched those ranks back from target positions. They
  did not prove general relation-driven behavior, so Git history is enough.
- Permanent per-pass metrics would require compiler modes or snapshots for
  transformations that currently happen directly during construction.
- More product UI such as menus or keyboard traversal would mostly add
  situation-specific code; Palette now carries the numeric scrolling and
  clipping proof in the product.
- A batch API would currently be a loop around the same executor. It should
  wait until candidate count makes the parked GPU design useful.
- Buffer caching would add retained mutable state to save only small,
  fixed-size per-frame allocations.

## Deferred representations

Strings, arbitrary division, variable-length allocation, fixed point, and
editable instructions still have no required derivation. The current
preallocated FP32 model should remain the only model until a concrete UI
behavior cannot be expressed cleanly inside it.

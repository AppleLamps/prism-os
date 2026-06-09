# Indirect

This experiment tests whether an interactive UI can lower into one fixed
numeric circuit with only three runtime atoms.

Run it:

```sh
bun start  # serve IndirectOS
bun test   # browser-free behavior and compiler checks
bun check  # strict TypeScript and type-aware lint
```

The main files are:

```txt
numeric-ui-core.ts            universal numeric vocabulary and tensor backend
numeric-ui-core.test.ts       core shape and evaluator contracts
numeric-ui-atoms.test.ts      broad browser-free expressivity proof
execution-model.md            exact FP32 instruction and layer semantics
boolean-state.md              rules for turning continuous scores into bits
window-manager.*              IndirectOS product, presentation, and tests
photo-gallery.*               fixed twelve-photo lightbox and tests
research-sweep.md             landed and parked research decisions
```

IndirectOS has four preallocated windows. Its single input table holds
viewport facts, layout constants, raw pointer latches, native Palette scroll
position, normal window geometry, open/minimized/maximized flags, drag and
resize targets, a 4 by 4 stacking matrix, visual-presence flags, frame time,
and five position/velocity spring pairs per window: center X/Y, width/height,
and scale. One fixed circuit computes:

```txt
topmost hit selection and focus
stable raise-to-front ordering
immediate dragging, resizing, and workspace bounds
responsive three-column Palette geometry, scroll bounds, and visibility
minimize and close into dock icons; restore and open out of them
stable target hit geometry independent of animated presentation
four fixed spring substeps for every geometry and transform lane
all window and dock projection geometry
```

JavaScript pointer callbacks only record raw facts and schedule one render.
Native Palette scroll events only schedule rendering. The render supplies
viewport dimensions, Palette `scrollTop`, and the RAF timestamp, evaluates the
numeric program, copies its next-state outputs into the same input table,
and projects the result. Palette uses one permanent spacer for native browser
scrolling; visible cell nodes are created on demand and removed when occluded.
A numeric animation-active output requests another frame until every spring
has snapped exactly to its destination. Window nodes stay at CSS
`left: 0; top: 0`; the circuit projects absolute X/Y translations, width,
height, and scale.

At startup, the circuit compiles into fixed numeric layers. Every refresh runs
the same layers without window-specific runtime branches:

```txt
input              = gather(values, inputIndices)
projection         = sparse_matmul(W[(new + reglu) x input], input) + b[new + reglu]
new                = projection[0:new]
new[gateRows]     *= ReLU(projection[new:])
new[booleanRows]   = boolean(new[booleanRows])
values             = concat(values, new)
```

The machines and browser demos execute entirely with FP32 arithmetic. Every
source value, weight, multiply, addition, and stored result is rounded to
FP32. This gives the product one stable CPU meaning that can later be matched
by a GPU backend. Compiled weights and biases are stored directly in
`Float32Array`s; index arrays remain 32-bit integers.

The compiled program is validated once at startup. Every refresh validates its
inputs and projected outputs, while rendering consumes only the tensor result.
Compiler tests also run the atoms literally in FP32 and require every live wire
to exactly match. Sparse storage omits zero coefficients while representing the
same fixed rectangular matrices.

The current compiled footprints are:

```txt
IndirectOS: 136 inputs, 502 outputs, 1,690 activations
            55 layers, maximum width 212
            150 affine, 1,491 ReGLU, 49 boolean
            266,572 dense weights, 7,982 stored sparse weights
            31.9 KB weights + 12.7 KB biases + 66.0 KB bookkeeping

lightbox:   24 inputs, 179 outputs, 341 activations
            10 layers, maximum width 137
            85 affine, 231 ReGLU, 25 boolean
            22,947 dense weights, 2,311 stored sparse weights
            9.2 KB weights + 2.3 KB biases + 14.0 KB bookkeeping
```

The System Monitor reports this compiled shape and storage, plus live frame
execution time and whether another RAF was requested. Palette reports how many
of its 60 fixed numeric cells currently have DOM nodes.

The audited runtime vocabulary has only three atoms:

```txt
affine  = fixed weighted sums and offsets
reglu   = one weighted sum multiplied by ReLU of another weighted sum
boolean = a zero-to-one score rounded to an exact zero or one
```

`boolean` uses ordered FP32 arithmetic with a fixed tie rule: values below
`0.5` become `0`, while `0.5` and above become `1`. The compiler records these
rows explicitly so affine composition cannot remove the rounding step.

Compile-time macros expand immediately into those atoms. They do not add other
runtime operations.

The tests cover:

```txt
universal numeric atoms and exact Boolean decisions
literal-versus-compiled FP32 equivalence, including seeded random circuits
window focus, stacking, dragging, resizing, controls, and mixed event sequences
spring convergence, dock transitions, and finite zero-sized layouts
native Palette scrolling, responsive geometry, and DOM-node culling
responsive twelve-slot gallery and lightbox behavior
```

## TODO

do not change this before asking the user

- Revisit arbitrary dynamic division only when a real derivation requires it.
  Constant division, bounded choices, and choosing better source coordinates
  already avoid it in this experiment.
- Separate changing state from changing behavior more clearly. First keep one
  fixed compiled circuit while source-table values change. Later explore
  whether behavior-defining projections and gates can themselves live in
  numeric regions and change without generating new JavaScript.
- Study the geometric interpretation of behavior weights: what directions,
  distances, and regions mean, and which constraints keep them valid.
- Retry layer scheduling after circuit shapes change. The earliest legal
  schedule currently wins, but that may not generalize.

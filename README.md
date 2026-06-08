# Indirect

This experiment tests whether a complete interactive UI can lower into one
fixed numeric circuit with only three runtime atoms.

Run the browser-free checks:

```sh
bun test
```

Serve the window manager:

```sh
bun start
```

Then open the URL printed by Bun.

Run strict TypeScript and type-aware lint checks:

```sh
bun check
```

The main files are:

```txt
numeric-ui-core.ts            universal numeric vocabulary and tensor backend
numeric-ui-core.test.ts       core shape and evaluator contracts
numeric-ui-atoms.test.ts      broad browser-free expressivity proof
execution-model.md            exact FP32 instruction and layer semantics
boolean-state.md              rules for turning continuous scores into bits
window-manager.ts             numeric window state machine and DOM adapter
window-manager.test.ts        browser-free window-manager behavior proofs
window-manager.css            fixed presentation
index.html                    fixed four-window desktop
photo-gallery.ts              tiny photo gallery and browser adapter
photo-gallery.test.ts         browser-free gallery behavior checks
photo-gallery.html            twelve fixed photo constants and CSS
photo-gallery.css             fixed presentation and photo bindings
photo-gallery-00..11.webp     twelve fixed image constants
```

The window manager has four preallocated windows. Its single source table holds
viewport facts, layout constants, raw pointer latches, normal window geometry,
open/minimized/maximized flags, drag and resize targets, a 4 by 4 stacking
matrix, visual-presence flags, frame time, and five position/velocity spring
pairs per window: center X/Y, width/height, and scale. One fixed circuit
computes:

```txt
topmost hit selection and focus
stable raise-to-front ordering
immediate dragging, resizing, and workspace bounds
minimize and close into dock icons; restore and open out of them
stable target hit geometry independent of animated presentation
four fixed spring substeps for every geometry and transform lane
all window and dock projection geometry
```

JavaScript event callbacks only record raw pointer facts and schedule one
render. The render supplies viewport dimensions and the RAF timestamp,
evaluates the numeric program, copies its next-state wire view into the same
source table, and writes projected values onto permanent DOM nodes. A numeric
animation-active output requests another frame until every spring has snapped
exactly to its destination. Window nodes stay at CSS `left: 0; top: 0`; the
circuit projects absolute X/Y translations, width, height, and scale.

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

The demo validates the source table, stack mass, compiled matrices, and
projected output after every refresh. Rendering consumes only the compiled
tensor result. Compiler tests also run the atoms literally in FP32 and require
every live wire to exactly match. Sparse storage omits zero coefficients while
representing the same fixed rectangular matrices.

The measured tensor footprints are:

```txt
window manager: source 131, graph width 3,092, live values 1,611, layers 50
                stored weights 7,396, layer tensor bytes 101,276
photo lightbox: source 24, graph width 612, live values 365, layers 10
                stored weights 2,311, layer tensor bytes 25,528
```

The product's persistent source table and evaluated wire table are fixed
`Float32Array`s. Immutable constants and changing underivable facts share the
source table. Derived values are temporary circuit wires.

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

The tests compile and check:

```txt
signed multiplication, min, max, and clamp
exact Boolean rectangle hit and overlap resolution
dynamic stack ordering and topmost selection
dragging, resizing, and workspace bounds
maximize, minimize, close, and dock restoration
same-frame pointer event batching
long deterministic mixed-event invariant sequences
exact agreement between literal and compiled FP32 execution
seeded random circuits with varied roots and dead outputs
finite layouts down to a zero-sized viewport
responsive twelve-slot gallery and lightbox behavior
direct next-state and render-output wire views
four expanded spring substeps per lane
window geometry destinations and recurrent spring convergence
faster dock transitions with a 600 ms settle budget
direct manipulation bypass and reversible dock transitions
fixed-layout translation and scale-to-zero dock motion
full-strength actions across visible window-control edges
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

# Indirect

This experiment tests whether a complete interactive UI can lower into one
fixed numeric circuit with only two runtime atoms.

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
open/minimized/maximized flags, drag and resize targets, and a 4 by 4 stacking
matrix. One fixed circuit computes:

```txt
topmost hit selection and focus
stable raise-to-front ordering
dragging, resizing, and workspace bounds
minimize, maximize, close, and dock restore
all window and dock projection geometry
```

JavaScript event callbacks only record raw pointer facts and schedule one
render. The render reads viewport dimensions, evaluates the numeric program,
copies its next-state wire view into the same source table, and writes projected
values onto permanent DOM nodes.

At startup, the circuit compiles into fixed gated layers. Every refresh runs
the same layers without window-specific runtime branches:

```txt
input = gather(values, inputIndices)
projection = sparse_matmul(W[(new + reglu) x input], input) + b[new + reglu]
new = projection[0:new]
new[gateRows] *= ReLU(projection[new:])
values = concat(values, new)
```

The demo validates the source table, stack mass, compiled matrices, and
projected output after every refresh. It also compares every live tensor wire
against a readable atom interpreter as a development assertion. Rendering
consumes only the tensor result. Sparse storage omits zero coefficients while
representing the same fixed rectangular matrices.

The measured tensor footprints are:

```txt
window manager: source 77, graph width 1,455, live values 751, layers 32
                stored weights 3,346, layer tensor bytes 63,116
photo lightbox: source 24, graph width 583, live values 338, layers 9
                stored weights 2,339, layer tensor bytes 36,908
```

The persistent source table is a fixed `Float64Array`. Immutable constants and
changing underivable facts share that table. Derived values are temporary
circuit wires.

The audited runtime vocabulary has only two atoms:

```txt
affine = fixed weighted sums and offsets
reglu  = one weighted sum multiplied by ReLU of another weighted sum
```

Compile-time macros expand immediately into those atoms. They do not add
runtime operations.

The tests compile and check:

```txt
signed multiplication, min, max, and clamp
continuous rectangle hit and overlap resolution
dynamic stack ordering and topmost selection
dragging, resizing, and workspace bounds
maximize, minimize, close, and dock restoration
same-frame pointer event batching
finite layouts down to a zero-sized viewport
responsive twelve-slot gallery and lightbox behavior
direct next-state and render-output wire views
four expanded spring substeps per lane
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

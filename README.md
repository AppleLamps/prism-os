# Numeric UI Atom Lab

This browser-free experiment tests whether apparently different UI derivations
can lower into a small homogeneous numeric circuit.

Run the browser-free checks:

```sh
bun test
```

Serve the smallest browser demo:

```sh
bun start
```

Then open the URL printed by Bun.

Run strict TypeScript and type-aware lint checks:

```sh
bun check
```

The folder is split by responsibility:

```txt
numeric-ui-core.ts            universal numeric vocabulary and tensor backend
numeric-ui-core.test.ts       core shape and evaluator contracts
numeric-ui-atoms.test.ts      broad browser-free expressivity proof
photo-gallery.ts              tiny photo gallery and browser adapter
photo-gallery.test.ts         browser-free gallery behavior checks
photo-gallery.html            twelve fixed photo constants and CSS
photo-gallery.css             fixed presentation and photo bindings
photo-gallery-00..11.webp     twelve fixed image constants
```

The photo gallery switches between a twelve-slot grid and a lightbox with a
main photo, a fixed strip containing all twelve thumbnails, previous/next controls, and close
behavior. The browser adapter records numeric click or keyboard signals and
projects numeric geometry, visibility, and focus outputs. Each photo and its
caption are fixed constants permanently attached to one DOM slot. At startup,
the fixed circuit compiles into dense gated
layers. Each refresh evaluates those same numeric layers without item-specific
runtime loops or runtime branching between atom kinds. Each layer reads all
values it actually depends on, produces only its new values, and appends them:

```txt
input = gather(values, inputIndices)
left = Wleft[new x input] x input + bleft[new]
gate = Wgate[reglu x input] x input + bgate[reglu]
new = left
new[gateRows] = left[gateRows] * ReLU(gate)
values = concat(values, new)
```

The demo validates the incoming source table, fixed compiled matrices, and
projected output after every refresh. It also compares every tensor
wire against a small readable atom interpreter as a development assertion;
rendering consumes only the tensor result. The dense matrices are intentionally
naive for now so the runtime shape stays obvious.

The measured dense tensor footprints are:

```txt
four-photo focus demo: source 10, width 326, layers 35
                       matrix cells 101,798, bias cells 632, bytes 819,440
photo lightbox:         source 24, graph width 583, live values 338, layers 9
                       matrix cells 23,686, bias cells 543
                       input indices 343, gate rows 229, tensor bytes 196,120
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
responsive twelve-slot gallery and lightbox behavior
direct next-state and render-output wire views
four expanded spring substeps per lane
```

An ordinary reference calculation runs beside the compiled circuit. The script
compares both results across deliberate edge cases and deterministic randomized
inputs, then prints the resulting circuit size.

## TODO

do not change this before asking the user

- Revisit arbitrary dynamic division only when a real derivation requires it.
  Constant division, bounded choices, and choosing better source coordinates
  already avoid it in this experiment.
- Separate changing state from changing behavior more clearly. First keep one
  fixed compiled circuit while source-table values change. Later explore
  whether behavior-defining projections and gates can themselves live in
  numeric regions and change without generating new JavaScript.

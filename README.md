# Numeric UI Atom Lab

This browser-free experiment tests whether apparently different UI derivations
can lower into a small homogeneous numeric circuit.

Run the browser-free checks:

```sh
npm test
```

Serve the smallest browser demo:

```sh
npm run serve
```

Then open `http://localhost:8765/numeric-ui-rectangles.html`.

The folder is split by responsibility:

```txt
numeric-ui-core.mjs            universal numeric vocabulary and tensor backend
numeric-ui-atoms.mjs           broad browser-free expressivity proof
numeric-ui-rectangles.mjs      tiny rectangle app and browser adapter
numeric-ui-rectangles.test.mjs browser-free rectangle behavior checks
numeric-ui-rectangles.html     four rectangle slots and CSS
```

The rectangle demo switches between a four-slot grid and a focused view. The
browser adapter records numeric click coordinates and projects numeric
rectangle outputs. At startup, the fixed circuit compiles into dense gated
layers. Each refresh evaluates those same numeric layers without item-specific
runtime loops or runtime branching between atom kinds. Each layer is a
residual tensor-shaped operation:

```txt
left = Wleft x + bleft
gate = Wgate x + bgate
x    = x + writeMask * left * ReLU(gate)
```

The demo validates the incoming source table, fixed compiled matrices and
masks, and projected output after every refresh. It also compares every tensor
wire against a small readable atom interpreter as a development assertion;
rendering consumes only the tensor result. The dense matrices are intentionally
naive for now so the runtime shape stays obvious.

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

The script compiles and checks:

```txt
boolean logic and conditional selection
min, max, and clamp
rectangle hit masks
rectangle occlusion masks
deterministic overlap resolution
bounded responsive grid layout
fixed lane repetition
four expanded spring substeps per lane
```

An ordinary reference calculation runs beside the compiled circuit. The script
compares both results across deliberate edge cases and deterministic randomized
inputs, then prints the resulting circuit size.

## TODO

do not change this before asking the user

- Consider fixed-point precision for exact control boundaries such as hit
  testing while allowing ordinary floating-point values for visual geometry.
- Revisit arbitrary dynamic division only when a real derivation requires it.
  Constant division, bounded choices, and choosing better source coordinates
  already avoid it in this experiment.
- Separate changing state from changing behavior more clearly. First keep one
  fixed compiled circuit while source-table values change. Later explore
  whether behavior-defining projections and gates can themselves live in
  numeric regions and change without generating new JavaScript.

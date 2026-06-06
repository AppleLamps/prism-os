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
numeric-ui-rectangles.ts      tiny rectangle app and browser adapter
numeric-ui-rectangles.test.ts browser-free rectangle behavior checks
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

The tests compile and check:

```txt
signed multiplication, min, max, and clamp
continuous rectangle hit and overlap resolution
responsive four-slot layout and focus behavior
contiguous next-state and render-output blocks
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

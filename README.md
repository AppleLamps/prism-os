# Indirect

Indirect tests whether an interactive UI can compile into one fixed numeric
program. JavaScript records browser inputs, runs the program, and projects its
outputs to the DOM.

```sh
bun start
bun test
bun check
```

IndirectOS has four fixed window slots. The source table holds viewport facts,
input latches, window state, stacking, spring state, Photos state, and app
constants. One compiled circuit handles:

- focus, stacking, dragging, resizing, and window controls
- dock transitions and fixed-step springs
- the Photos grid, lightbox, navigation, and thumbnail strip
- numeric visibility used to attach and remove photo nodes

Photos is authored separately, then inlined before the system compiles. The
browser still runs one source table, one circuit, and one render loop.

## Runtime

The runtime has three atoms:

```txt
affine  = weighted sum plus offset
reglu   = one affine value times ReLU of another
boolean = a score in 0..1 rounded to an exact bit
```

Macros such as multiply, min, max, springs, and winner selection expand into
those atoms before compilation. Every arithmetic step uses FP32.

Independent instructions share layers. Each layer gathers the values it reads,
runs one sparse affine projection, applies ReGLU gates and Boolean rounding,
then appends its outputs.

Current fused program:

```txt
153 inputs, 381 outputs, 2,064 activations
70 layers, maximum width 246
198 affine, 1,802 ReGLU, 64 boolean
317,961 dense weights, 13,138 stored sparse weights
52.6 KB weights + 15.5 KB biases + 33.8 KB bookkeeping
```

## Files

- `numeric-ui-core.ts`: circuit construction, compilation, and execution
- `window-manager.ts`: IndirectOS circuit and DOM projection
- `photo-gallery.ts`: Photos circuit and DOM projection
- `execution-model.md`: exact instruction and layer semantics
- `boolean-state.md`: where exact decisions belong
- `research-sweep.md`: landed and parked experiments
- `ideas.md`: unexplored directions

Tests compare the literal and compiled FP32 evaluators, including seeded random
circuits. Product tests cover window interactions, stacking, springs, tiny
viewports, Photos focus, overlapping controls, and DOM culling.

## TODO

do not change this before asking the user

- Revisit dynamic division only when a real UI needs it.
- Separate changing state from changing behavior while keeping one circuit.
- Study the geometric meaning and valid ranges of behavior weights.
- Retry layer scheduling after the circuit shape changes.

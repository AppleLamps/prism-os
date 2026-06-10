# Indirect

Indirect tests whether an interactive UI can compile into one fixed numeric
program. JavaScript records browser inputs, runs the program, and projects its
outputs to the DOM.

```sh
bun start
bun run start:candidates
bun run start:learning
bun test
bun check
```

IndirectOS has four fixed window slots. The source table holds viewport facts,
input latches, window state, stacking, spring state, Photos state, and app
constants. One compiled circuit handles:

- focus, stacking, dragging, resizing, and window controls
- dock transitions and fixed-step springs
- the Photos grid, lightbox, navigation, and spring-animated thumbnail strip
- numeric visibility used to attach and remove photo nodes

Photos is authored separately, then inlined before the system compiles. The
browser still runs one source table, one circuit, and one render loop.

The candidate gallery is a separate experiment. Cinema, Contact, and Story all
run against the same viewport. Each scores its smallest normalized hero, cell,
or thumbnail; a balanced argmax tournament chooses the projected geometry.

The learning gallery replaces that hard winner with a differentiable blend.
Its fixed 20-slot circuit learns an unlabeled set of rough rectangles through
layout blend, global transform, and per-slot presence. Training first finds the
cheapest one-to-one target/output pairing, so editor slot identities do not
affect the result. A capped geometry loss stops inaccurate rectangles from
pulling the result away from the clean gallery structures.

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
201 inputs, 429 outputs, 2,933 activations
90 layers, maximum width 224
247 affine, 2,622 ReGLU, 64 boolean
528,306 dense weights, 16,406 stored sparse weights
65.6 KB weights + 22.2 KB biases + 47.0 KB bookkeeping
```

## Files

- `numeric-ui-core.ts`: circuit construction, compilation, and execution
- `window-manager.ts`: IndirectOS circuit and DOM projection
- `photo-gallery.ts`: Photos circuit and DOM projection
- `candidate-gallery.ts`: three-layout runtime search experiment
- `candidate-gallery.html`: standalone candidate gallery
- `learned-gallery.ts`: rectangle fitting, backpropagation, and DOM projection
- `learned-gallery.html`: standalone learning gallery
- `execution-model.md`: exact instruction and layer semantics
- `boolean-state.md`: where exact decisions belong
- `parallel-winner.md`: balanced selection among overlapping candidates
- `research-sweep.md`: landed and parked experiments
- `ideas.md`: unexplored directions

Tests compare the literal and compiled FP32 evaluators, including seeded random
circuits. Product tests cover window interactions, stacking, springs, tiny
viewports, Photos focus, candidate layout search, overlapping controls, and DOM
culling.

## TODO

do not change this before asking the user

- Revisit dynamic division only when a real UI needs it.
- Separate changing state from changing behavior while keeping one circuit.
- Study the geometric meaning and valid ranges of behavior weights.
- Retry layer scheduling after the circuit shape changes.

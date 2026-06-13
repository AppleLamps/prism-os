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

The learning gallery trains a small geometry network rather than choosing among
authored layouts. Its 244 coefficients define two shared ReGLU layers that map
fixed slot positions to rectangle geometry. Training pairs the unlabeled target
and output sets, then backpropagates coordinate and soft shared-edge losses.
Small alignment mistakes snap toward repeated edges, while deliberate offsets
and layouts absent from the product source remain learnable.

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
201 inputs, 429 outputs, 3,204 activations
96 layers, maximum width 210
551 affine, 2,589 ReGLU, 64 boolean
431,961 dense weights, 12,020 stored sparse weights
48.1 KB weights + 23.2 KB biases + 40.7 KB bookkeeping
```

## Files

- `numeric-ui-core.ts`: circuit construction, compilation, and execution
- `window-manager.ts`: IndirectOS circuit and DOM projection
- `photo-gallery.ts`: Photos circuit and DOM projection
- `candidate-gallery.ts`: three-layout runtime search experiment
- `candidate-gallery.html`: standalone candidate gallery
- `trainable-geometry.ts`: learned affine/ReGLU geometry network and optimizer
- `learned-gallery.ts`: rectangle fitting, backpropagation, and DOM projection
- `learned-gallery.html`: standalone learning gallery
- `execution-model.md`: exact instruction and layer semantics
- `boolean-state.md`: where exact decisions belong
- `macro-ranges.md`: FP32 magnitude preconditions for the macro library
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

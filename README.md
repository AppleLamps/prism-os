# Indirect

Indirect writes an interactive UI as one fixed numeric program. JavaScript writes browser inputs, e.g. the viewport size and pointer events, into a `Float32Array` source table and runs the program on it. The program's next-state values are written back into the table, and its other outputs, e.g. each window's position and size, go to the DOM. Every step is FP32 arithmetic over four kinds of instructions, and the compiler groups independent instructions into layers, each run as one sparse matrix multiplication. Behavior lives as numbers in one compiled program, so the same numbers can be edited by hand or adjusted by gradients; [lab/status.md's "What learns"](lab/status.md#what-learns) records how far that got. This is research code: today's executor is serial JavaScript on the CPU, there's no GPU backend, and there's no package to install, since package.json is private.

## IndirectOS

IndirectOS is the focus of the repo: a desktop with 4 window slots (Files, Notes, System Monitor and Photos) and a dock, run by one compiled program. The program handles focus, stacking, dragging, resizing, the three window controls, closing a window to the dock and reopening it from there, and the springs that animate all of that. Windows and Photos' thumbnails are `emitAnimatedObject`s: each spring keeps its displacement from its destination and its velocity in the source table, and every evaluation applies a step matrix that the host writes, so the program never loops over spring steps. host-timing.ts's `advanceFrame` counts the fixed 4 ms steps, steps the springs to each event's timestamp before applying the event, and with `'events and settle checks'` writes state back only at events, settle checks and snaps, so stored state doesn't depend on the frame rate. A window's content box takes its destination size as soon as an event changes the destination, while only the frame animates and clips the content, so content lays out once per destination change instead of at every in-between size. Presses are hit-tested against destination rectangles rather than drawn ones, with `emitCompare`: the host writes pointer coordinates on a 1/64 px grid and the window geometry is declared on a 1/64 px grid, so each edge comparison is an exact integer bit ([execution-model.md](execution-model.md#comparisons)). The window controls, the dock items and Photos' content act on release, like native buttons: a press arms the control under it, and a release over the armed control acts, whatever path the pointer took between them. Arrow keys and Escape reach Photos only while Photos is the focused window. Every cell of the source table is declared with cells.ts, which gives each cell its position, range, grid and initial value, and derives the validator that checks the table and the outputs around each evaluation.

Photos has a grid, a lightbox and a spring-animated thumbnail strip, and its photo nodes are attached to the DOM only while the program's size and opacity outputs are positive. Photos is built by `buildPhotos` into the same circuit as the window manager, so the browser runs one source table, one program and one render loop. IndirectOS compiles to about 14,000 live operations, and one evaluation takes about 80 µs on the CPU executor; `bun lab/runtime-cost/report.ts` prints the current numbers, and [lab/status.md](lab/status.md) records them at each change. Files: index.html, window-manager.ts and window-manager.css, photo-gallery.ts, notes.ts, notes-walker.ts and notes-paragraph.ts, and photo-gallery-00.webp to photo-gallery-11.webp.

## Running

```sh
bun install
bun start                                 # IndirectOS, at the URL Bun prints
bun run start:template                    # the template app, a toggle switch
bun run test
bun run check
bun lab/ui-exploration/serve-demos.ts     # every demo, history included, at http://127.0.0.1:4321/
```

## The template app

[template/](template/) is a toggle switch written as one numeric program and checked against the same switch in plain JavaScript, to copy as the start of a new app. [tutorial.md](tutorial.md) walks through it: declaring cells, builder code, the host loop, DOM writes, the test, and how to add a second switch or a new app folder.

## How a program is written

A program is a list of instructions of four kinds, and every arithmetic step uses FP32:

```txt
affine  = weighted sum plus offset
reglu   = one affine value times ReLU of another
boolean = a score in 0..1 rounded to an exact bit
index   = the value at floor(index) in a table of earlier values, copied without rounding
```

Builder functions, also called macros, e.g. `emitMinimum` (3 operations) or `emitFirstActive` (a tree over n candidates), expand into instructions before compilation, so they aren't a level of their own. The docs group what you build from instructions by the size of the familiar code it replaces:

- [expressions.md](expressions.md): one expression, e.g. `a >= b`, `Math.min(a, b)` or `table[index]`, where the hard part is an exact FP32 result.
- [patterns.md](patterns.md): a loop, e.g. `findIndex` or `items.sort(compare)`. The program runs every operation on every frame and can't stop early, so a loop becomes a count, a tree, a table, or the same work on every item.
- [behavior-choices.md](behavior-choices.md): a choice that changes what the user sees, e.g. hit-testing where elements are going instead of where they're drawn, to shorten dependency chains, make stored state independent of the frame rate, or keep each frame's work under a fixed maximum.
- Contracts: [execution-model.md](execution-model.md) defines the instructions, the contracts of the builder functions that other docs depend on, e.g. index reads, comparisons, grids, rounding points, springs and time, and each macro's magnitude limits.

Independent instructions share a layer, and today's executor is serial JavaScript on the CPU ([execution-model.md](execution-model.md#compilation)). `bun lab/runtime-cost/report.ts` reports current program sizes and CPU costs; old size and timing tables don't apply to a changed program.

## Reading order

Read this README, then [tutorial.md](tutorial.md), [expressions.md](expressions.md), [patterns.md](patterns.md), [behavior-choices.md](behavior-choices.md), and then [execution-model.md](execution-model.md) for the contracts. [lab/status.md](lab/status.md) has current results, known issues in the production code and open decisions, for people following the research. [The guide](lab/ui-exploration/guide/README.md) has longer explanations that start from the familiar JavaScript, a glossary, and runnable examples checked against plain JavaScript.

## Files

- `numeric-ui-core.ts`: circuit construction, the builder functions, compilation, and the evaluators
- `host-timing.ts`: frame timing, spring step counts and matrices, and the evaluations between frames, computed in host JavaScript
- `cells.ts`: cell declarations, which give each cell its position in the source table, the circuit's declarations, the initial table, a validator, and next values for write-back
- `index.html`, `window-manager.ts`, `window-manager.css`, `photo-gallery.ts`, `photo-gallery-*.webp`: IndirectOS
- `template/`: the toggle switch to start an app from
- `tutorial.md`, `expressions.md`, `patterns.md`, `behavior-choices.md`, `execution-model.md`: the docs above
- Root tests: differential tests of the reference and compiled evaluators, including seeded random circuits (`builder-differential`, `numeric-ui-core`, `numeric-semantics`, `random-hardened`), and tests of index reads, comparisons, springs whose matrix the host writes, macro magnitude limits, cell declarations, IndirectOS and Photos over scripted traces (`window-manager`, `photo-gallery`, `oracle-trace`), and the candidate and learned galleries
- `scripts/check.ts`, `tsconfig.json`, `package.json`: `bun run check` type-checks and lints the root, the template and each folder directly under lab/ that has a tsconfig.json (the lab/ui-exploration prototypes have tsconfig.json files of their own and aren't covered), and package.json holds the scripts above. `knip.config.ts`: `bun run knip` reports unused exports in the root modules, scripts/ and template/

## History

Everything below is history: each item describes the code as it was when the item was written, and only [lab/status.md](lab/status.md) is kept current.

- Root experiments that still run: `candidate-gallery.*` (three photo layouts scored while running, and a balanced argmax picks one; `bun run start:candidates`), `learned-gallery.*` with `trainable-geometry.ts` (a small geometry network trained with backpropagation; `bun run start:learning`), and `hard-attend.*` (compares one-hot, direct and softmax gathers; `bun run start:hard-attend`).
- `research-sweep.md`: the changes landed in July 2026, and superseded experiments. `ideas.md`: unexplored directions.
- `exp/`: the earliest experiments, which aren't type-checked or tested.
- `lab/`: learning experiments (learned-interpreter, reusable-layout, user-effort, data-adapter, event-window, generative-fields, cascade-argmax) and runtime studies (gather-lowering, runtime-cost, trace-compiler), each with a README of dated measurements; `lab/reassessment-2026-09-03.md`, the September 3, 2026 review of the July results; and `lab/briefs/`, the July 2026 briefs. reusable-layout has a demo, `bun run start:reusable`.
- `lab/ui-exploration/`: the record of the September 12-14, 2026 exploration of how far circuit UI goes, i.e. 24 prototypes built on the runtime of that time or on copies of it, the notes, and the guide. Its measurements describe the code as it was then.

## License

MIT, see [LICENSE](LICENSE).

The TODO list below is retained from the earlier discussion. Its finite-range/gather item was completed and removed on September 15, 2026, and its layer scheduling item moved to `lab/status.md`'s parked list; current status is in `lab/status.md`.

## TODO

do not change this before asking the user

- Revisit dynamic division only when a real UI needs it.

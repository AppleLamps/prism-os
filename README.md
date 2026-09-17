# Indirect

Indirect writes an interactive UI as one fixed numeric program. JavaScript writes browser inputs, e.g. the viewport size and pointer events, into a `Float32Array` source table and runs the program on it. The program's next-state values are written back into the table, and its other outputs, e.g. each window's position and size, go to the DOM. Every step is FP32 arithmetic over four kinds of instructions, and the compiler groups independent instructions into layers, each run as one sparse matrix multiplication. Behavior lives as numbers in one compiled program, so the same numbers can be edited by hand or adjusted by gradients; [lab/status.md's "What learns"](lab/status.md#what-learns) records how far that got. This is research code: today's executor is serial JavaScript on the CPU, there's no GPU backend, and there's no package to install, since package.json is private.

## IndirectOS

IndirectOS is the focus of the repo: a desktop with 4 window slots (Files, Notes, System Monitor and Photos) and a dock, run by one compiled program. The program handles focus, stacking, dragging, resizing, the three window controls, closing a window to the dock and reopening it from there, and the springs that animate all of that. Windows and Photos' thumbnails are `emitAnimatedObject`s: each spring keeps its displacement from its destination and its velocity in the source table, and every evaluation applies a step matrix that the host writes, so the program never loops over spring steps. host-timing.ts's `advanceFrame` counts the fixed 4 ms steps, steps the springs to each event's timestamp before applying the event, and with `'events and settle checks'` writes state back only at events, settle checks and snaps, so stored state doesn't depend on the frame rate. A window's content box takes its destination size as soon as an event changes the destination, while only the frame animates and clips the content, so content lays out once per destination change instead of at every in-between size. Presses are hit-tested against destination rectangles rather than drawn ones, with `emitCompare`: the host writes pointer coordinates on a 1/64 px grid and the window geometry is declared on a 1/64 px grid, so each edge comparison is an exact integer bit ([execution-model.md](docs/execution-model.md#comparisons)). The window controls, the dock items and Photos' content act on release, like native buttons: a press arms the control under it, a release over the armed control acts, whatever path the pointer took between them, and a release anywhere else or a pointercancel acts on nothing. Every release reaches Photos as a click at the release point, read against Photos' layout at the window's destination, so during a maximize a release at a photo's destination opens that photo even where the drawn frame doesn't cover the point yet. Arrow keys and Escape reach Photos only while Photos is the focused window. Every cell of the source table is declared with cells.ts, which gives each cell its position, range, grid and initial value, and derives the validator that checks the table and the outputs around each evaluation.

Photos has a grid, a lightbox and a spring-animated thumbnail strip, and its photo nodes are attached to the DOM only while the program's size and opacity outputs are positive. Photos is built by `buildPhotos` into the same circuit as the window manager, so the browser runs one source table, one program and one render loop. Notes' paragraph is laid out by the same program: the words flow around the windows stacked above Notes, at their destination rectangles, with a line walker that breaks lines where pretext's `layoutNextLineRange` does (npm @chenglou/pretext), so words move straight to their new lines at events while the windows animate, and lines past Notes' 16 line slots aren't laid out ([behavior-choices.md](docs/behavior-choices.md#flow-text-around-destinations-in-a-fixed-number-of-lines)). With the paragraph widths baked into notes-paragraph.ts, IndirectOS compiles to about 14,000 live operations, and one evaluation takes about 80 µs on the CPU executor. The page measures the paragraph in the browser's font instead, so the page's program size varies with the font, e.g. about 670 more operations when the words measure 20% narrower. [lab/status.md](lab/status.md) records the exact numbers at each change, and `bun lab/runtime-cost/report.ts` prints the current ones. Files: window-manager.ts, photo-gallery.ts, notes.ts, notes-walker.ts and notes-paragraph.ts in src/indirectos/, and index.html, window-manager.css and photo-gallery-00.webp to photo-gallery-11.webp in assets/.

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

[template/](template/) is a toggle switch written as one numeric program and checked against the same switch in plain JavaScript, to copy as the start of a new app. [tutorial.md](docs/tutorial.md) walks through it: declaring cells, builder code, the host loop, DOM writes, the test, and how to add a second switch or a new app folder.

## How a program is written

A program is a list of instructions of four kinds, and every arithmetic step uses FP32:

```txt
affine  = weighted sum plus offset
reglu   = one affine value times ReLU of another
boolean = a score in 0..1 rounded to an exact bit
index   = the value at floor(index) in a table of earlier values, copied without rounding
```

Builder functions, also called macros, e.g. `emitMinimum` (3 operations) or `emitFirstActive` (a tree over n candidates), expand into instructions before compilation, so they aren't a level of their own. The docs group what you build from instructions by the size of the familiar code it replaces:

- [expressions.md](docs/expressions.md): one expression, e.g. `a >= b`, `Math.min(a, b)` or `table[index]`, where the hard part is an exact FP32 result.
- [patterns.md](docs/patterns.md): a loop, e.g. `findIndex` or `items.sort(compare)`. The program runs every operation on every frame and can't stop early, so a loop becomes a count, a tree, a table, or the same work on every item.
- [behavior-choices.md](docs/behavior-choices.md): a choice that changes what the user sees, e.g. hit-testing where elements are going instead of where they're drawn, to shorten dependency chains, make stored state independent of the frame rate, or keep each frame's work under a fixed maximum.
- Contracts: [execution-model.md](docs/execution-model.md) defines the instructions, the contracts of the builder functions that other docs depend on, e.g. index reads, comparisons, grids, rounding points, springs and time, and each macro's magnitude limits.

Independent instructions share a layer, and today's executor is serial JavaScript on the CPU ([execution-model.md](docs/execution-model.md#compilation)). `bun lab/runtime-cost/report.ts` reports current program sizes and CPU costs; old size and timing tables don't apply to a changed program.

## Reading order

Read this README, then [tutorial.md](docs/tutorial.md), [expressions.md](docs/expressions.md), [patterns.md](docs/patterns.md), [behavior-choices.md](docs/behavior-choices.md), and then [execution-model.md](docs/execution-model.md) for the contracts. [lab/status.md](lab/status.md) has current results, known issues in the production code and open decisions, for people following the research. [The guide](lab/ui-exploration/guide/README.md) has longer explanations that start from the familiar JavaScript, a glossary, and runnable examples checked against plain JavaScript.

## Files

- `src/runtime/numeric-ui-core.ts`: circuit construction, the builder functions, compilation, and the evaluators
- `src/runtime/host-timing.ts`: frame timing, spring step counts and matrices, and the evaluations between frames, computed in host JavaScript
- `src/runtime/cells.ts`: cell declarations, which give each cell its position in the source table, the circuit's declarations, the initial table, a validator, and next values for write-back
- `src/indirectos/`, with `window-manager.ts`, `photo-gallery.ts`, `notes.ts`, `notes-walker.ts` and `notes-paragraph.ts`, and `assets/`, with `index.html`, `window-manager.css` and `photo-gallery-*.webp`: IndirectOS
- `template/`: the toggle switch to start an app from
- `docs/`: the docs above, `tutorial.md`, `expressions.md`, `patterns.md`, `behavior-choices.md` and `execution-model.md`
- `tests/runtime/`: differential tests of the reference and compiled evaluators, including seeded random circuits (`builder-differential`, `numeric-ui-core`, `numeric-semantics`, `random-hardened`), and tests of index reads, gather lowering, comparisons, springs whose matrix the host writes, macro magnitude limits and cell declarations
- `tests/indirectos/`: tests of IndirectOS and Photos over scripted traces (`window-manager`, `photo-gallery`, `oracle-trace`), and of the Notes flow against pretext's line breaks (`notes`)
- `scripts/check.ts`, `tsconfig.json`, `package.json`: `bun run check` type-checks and lints src/, tests/, scripts/, the template and each folder directly under lab/ that has a tsconfig.json, and type-checks each lab/ui-exploration prototype through its own tsconfig.json. package.json holds the scripts above. `knip.config.ts`: `bun run knip` reports unused exports in src/, scripts/ and template/

## History

Everything below is history: each item describes the code as it was when the item was written, and only [lab/status.md](lab/status.md) is kept current. On September 16, 2026, experiments that duplicated root IndirectOS or each other were removed or merged into the folders that remain, and the [exploration-2026-09 tag](https://github.com/chenglou/indirect/tree/exploration-2026-09) keeps every removed path.

- `lab/`: learning experiments (learned-interpreter, reusable-layout, user-effort, data-adapter, event-window, generative-fields, cascade-argmax, learned-gallery) and runtime studies (runtime-cost, trace-compiler), each with a README; hard-attend, a page that compares one-hot, direct and softmax gathers; candidate-gallery, where three photo layouts are scored while running and a balanced argmax picks one; json-highlighter and regex-search, temporary demos of traditional JavaScript tasks from September 17, 2026, where one program highlights JSON on every keystroke, and one searches a text with a pattern as you type; `lab/research-sweep.md`, the changes landed in July 2026, and superseded experiments; `lab/reassessment-2026-09-03.md`, the September 3, 2026 review of the July results; and `lab/briefs/`, the July 2026 briefs. Six have pages: `bun run start:reusable`, `bun run start:learning` (learned-gallery, a small geometry network trained with backpropagation), `bun run start:hard-attend`, `bun run start:candidates`, `bun run start:json-highlighter` and `bun run start:regex-search`. learned-gallery, hard-attend and research-sweep.md moved from the repo root on September 16, 2026, candidate-gallery moved from the repo root on September 17, 2026, and the earliest experiments, in `exp/`, moved into lab/event-window and lab/ui-exploration/learned-bits or were removed.
- `lab/ui-exploration/`: the record of the September 12-14, 2026 exploration of how far circuit UI goes, i.e. prototypes built on the runtime of that time or on copies of it, and the guide. 16 of the 24 prototypes remain, and the other 8 and the notes were removed or merged into the remaining ones on September 16, 2026. Its measurements describe the code as it was then.

## License

MIT, see [LICENSE](LICENSE).

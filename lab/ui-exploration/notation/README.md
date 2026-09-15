# An authoring notation and source table allocator, proven on IndirectOS

This prototype asks how much of writing UI in this approach is essential UI logic, and what the code looks like once the bookkeeping disappears. It adds a small library (a source table allocator and shader-like helpers over wires), rewrites IndirectOS (window-manager.ts and photo-gallery.ts) with it, proves that the rewrite compiles into the identical circuit and produces the same bits over long interaction traces, and then uses the notation for a new UI, a settings panel.

`numeric-ui-core.ts` is imported unchanged. No repository file outside this folder was edited.

## How to run

From the repository root:

```sh
bun test lab/ui-exploration/notation          # 18 tests, under a second
bunx tsgo -p lab/ui-exploration/notation
bun lab/ui-exploration/notation/report.ts     # about 20 s; prints tables, writes report-output.json
bun lab/ui-exploration/notation/indirect-os.html   # the rewrite on the original markup and CSS
bun lab/ui-exploration/notation/demo.html          # the settings panel
```

Nobody was awake to grant browser permissions, so neither page was opened in a browser. Both pages bundle with `bun build`, and `dom.test.ts` runs their projection code against fake DOM elements.

## What was built

| File | What it holds |
| --- | --- |
| `table.ts` | The source table allocator: cell specs, groups, scopes, derived circuit declarations, the initial table, the validator, the writeback mapping, and output contracts |
| `wires.ts` | Helpers over wires: `sum`, `sub`, `scale`, `min`, `max`, `clamp`, `select` and `mix` over whole structs, `Vec2` and `Rect`, hit tests, an exact comparison bit, `dot`, `lookup`, `toggle`, springs, a Newton reciprocal, and `read` for named outputs |
| `photos.ts` | Photos as a component: its cell spec, a build function that reads the host's wires as inputs, and the runtime contract for those inputs |
| `indirect-os.ts` | The IndirectOS rewrite and a machine with the original's `step`, pointer, and Photos API |
| `indirect-os-dom.ts`, `indirect-os.html` | The browser host: event latches, render loop, monitor, and DOM projection by field name |
| `settings-panel.ts`, `settings-dom.ts`, `demo.*` | The new settings panel and its browser host |
| `settings-reference.ts` | An independent plain JS implementation of the settings panel in float64 |
| `compare.ts`, `traces.ts` | A structural comparison of two circuits, and the trace runner that drives the original and the rewrite side by side |
| `report.ts` | Measurements: structure, long traces, a range-declaration variant, line and character counts, rough timings, settings panel costs |

### The allocator

Every cell is declared once with a range, an initial value, and what happens to it after a frame: a `constant`, an `input` the host writes, an `event` that resets to zero after every frame, or `state` whose next value the circuit must supply. Groups are plain objects and arrays of specs, plus `oneHot`, `atMostOne`, and `permutation` (a stacking order stored as a permutation matrix whose rows and columns are declared one-hot groups). For example, the window state reads:

```ts
windows: list(windowCount, index => {
  const [left, top, width, height] = initialGeometry[index]!
  return {
    left: state(pixel, left), top: state(pixel, top), width: state(pixel, width), height: state(pixel, height),
    open: bit(1), minimized: bit(), maximized: bit(), present: state(unitInterval, 1),
  }
}),
drag: list(windowCount, () => bit()),
stack: permutation(list(windowCount, index => index)),
```

From these declarations the table derives offsets (in declaration order), the `assumeRange` and `assumeOneHot` calls, the initial `Float32Array`, a validator, and the next-source array. `table.next(stored, next)` pairs a whole struct of state cells with a struct of wires by field name and index, so the order of fields in an object literal doesn't matter: `{velocity, position}` pairs correctly with a struct declared as `{position, velocity}`. A missing, extra, or renamed field throws before any cell is assigned, and a state cell that never gets a next value, or gets two, throws while building, with the cell's name (`table.test.ts`). The validator checks ranges and finiteness, exact bits, and group masses in one pass over typed arrays, and names the failing cell or group.

A Circuit needs its source size before the first operation exists, so building has two phases: allocate every cell (including child scopes), call `createCircuit`, then build behavior. A component is therefore a cell spec plus a build function.

### Component scopes

Photos declares its cells in `photos.ts`. The parent allocates them in a scope (`table.scope('photos').allocate('', photoCells)`) and later calls `buildPhotos($, table, cells, inputs)` with its own wires: the Photos window's content size, opacity, focus, and the spring parameters. Photos states its input contracts with five `assume` lines. That replaces `inlineCircuit` and the 77 lines of Photos wiring in window-manager.ts, including the duplicated range declarations and the second list of Photos cells.

The runtime half of those input contracts is `photoInputContract`. After every evaluation the host checks that the content size is nonnegative, the opacity is within 0..1, the focus is exactly 0 or 1, and the spring timestep is nonnegative. These are the rules photo-gallery.ts applies to its own source table, which the original checks through the inlined circuit's next-source wires.

### The notation

The helpers close over one circuit and its unit wire, so a hit-test section reads like this:

```ts
const box = select(window.maximized, rect(window.left, window.top, window.width, window.height), maximizedRect)
const windowHit = mul(visible, hit(down, box))
const closeLeft = sum(box.left, box.width, [buttonGap, -1], [buttonSize, -1])
// A button's hit box grows by half the gap on every side, so neighbors split the gap.
const buttonHit = (left: Wire) => hit(down, $.outset(rect(left, buttonTop, buttonSize, buttonSize), half(buttonGap)))
```

The pointer latch chain is three struct selects: `select(down.active, pointer, down)`, then the move latch, then the up latch. Outputs are named structs such as `output.windows[2].translateX`, and `read(values, output.windows)` returns numbers in the same shape. Because `Wire` is a number type, the read result has the struct's own type.

## Measured results

### The rewrite compiles into the identical circuit

`compare.ts` gives every live wire a canonical id built from its atom kind, rounding flag, biases, terms in stored order (as canonical ids of the term wires), macro operands, and inferred range. A strict match means both circuits accumulate every sum in the same FP32 order.

| Circuit | Built operations | Live operations | Layers | Stored weights | Gather reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| window-manager.ts | 6,146 | 5,253 | 192 | 11,598 | 12 |
| rewrite | 6,146 | 5,253 | 192 | 11,598 | 12 |

All 429 roots (201 next-source values and 228 projected outputs) match strictly, no live operation exists in only one circuit, and the per-layer widths are equal. The source layout is identical too: the test pairs every allocated cell with the original's exported offset functions for all 201 cells, and the initial tables are equal.

An early version compiled one extra live operation because it requested Photos' own `animationActive` as a root. The original only folds that value into the combined animation bit. Dropping it from the named output made the counts equal.

### Bit-for-bit traces

The runner applies the same events to both machines, steps them, and compares the bits of every projected output and next-source value after every frame.

The scripted tour drags window 1 by its title bar past the left and top edges and then past the right and bottom edges, resizes window 2 down to the minimum size, maximizes and minimizes Photos, restores it from the dock at 900×600, closes and reopens it, opens a photo from the grid, steps next and previous, clicks a thumbnail, closes the lightbox, clicks window 0 to take focus from Photos, then with one click focuses Photos and opens a photo in the same evaluation, and ends with viewports 0×0, 40×40, and 1280×800. After each step the tour records whether the step took effect, read from the rewrite's state. For example, after the title bar press the drag bit is 1 and the window moved by exactly the pointer's movement, and after the focus-and-open click the Photos window's focused output went from 0 to 1 in the same frame that photo 3 opened. All 22 checks pass, and because the bits match the original's, the checks hold for both machines.

An earlier version of the tour pressed a point on window 1 that window 0 covered after the first click, so no drag started, and its "focus another window" click landed on Photos, which was already focused. The checks exist so that a step which silently does nothing fails the test.

Random traces mix frame durations from 1 to 41 ms, viewport changes, clicks on window controls and dock items, title bar and grip presses with a large move (released in the same frame half the time), pointer moves without a press (near and far), and Photos events with and without a matching pointer press. While a drag or resize is held, half of the frames are moves without a press. The last three columns count frames, read from the rewrite's state, where a drag or resize held since an earlier frame changed a window in a frame with pointer movement but no press and no viewport change, and frames where one press focused Photos and opened a photo.

| Trace | Frames | Compared values | Mismatched bits | Frames the original rejects | Frames the rewrite rejects | Frames only one rejects | Held drag moves | Held resize moves | Focus and open in one press |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| scripted | 401 | 172,029 | 0 | 1 | 1 | 0 | 2 | 2 | 1 |
| random, seed 1 | 3,001 | 1,287,429 | 0 | 0 | 0 | 0 | 55 | 30 | 2 |
| random, seed 2 | 3,001 | 1,287,429 | 0 | 0 | 0 | 0 | 29 | 17 | 2 |
| random, seed 3 | 3,001 | 1,287,429 | 0 | 0 | 0 | 0 | 53 | 24 | 3 |
| random, seed 4 | 3,001 | 1,287,429 | 0 | 0 | 0 | 0 | 15 | 15 | 1 |
| random, seed 5 | 3,001 | 1,287,429 | 0 | 0 | 0 | 0 | 46 | 7 | 1 |

In total, 6,609,174 values match bit for bit.

The one rejected frame is a finding about the original, not the rewrite. `validatePhotoGalleryOutput` requires every thumbnail's left edge to be nonnegative, but thumbnails legitimately spring in past the left edge. The rejection comes right after the viewport grows from 40×40 back to 1280×800 while the lightbox is open: one thumbnail's left edge is at -6.61 px. When a validator throws, the runner evaluates the same circuit on the same table and writes back, so the trace can continue.

### The two machines check different rules

The rewrite's step checks the source table and the next-source table with the validator derived from declarations, then the output contract, then Photos' inputs. That's a different rule set from the original's hand-written checks, mostly stricter. The rules that differ:

| Rule | window-manager.ts and photo-gallery.ts | Rewrite |
| --- | --- | --- |
| Stored flags: open, minimized, maximized, drag, resize, stack cells, photo focus, event latches, time initialized | within 0..1 with 1e-5 tolerance | exactly 0 or 1 |
| Stored 0..1 values: present, window spring scale, thumbnail scale | within 0..1 with 1e-5 tolerance | within 0..1 |
| Group masses | stack rows and columns within 1e-5 of 1; photo focus, drag, resize, and Photos events at most 1 + 1e-5 | stack rows and columns exactly 1; photo focus exactly 0 or 1; drag, resize, and Photos events at most 1 |
| Upper bounds in the table | none | 16,384 for the viewport, window geometry, and thumbnail centers; 1,024 for layout constants |
| Thumbnail center in the table | at least -1e-5 | at least 0 |
| Projected stack order | at least -1e-5 | at least 0 |
| Event latches in the next-source table | exactly 0 | not checked at runtime; the writeback wires them to a constant 0 wire |
| Finiteness | every value the tensor program computes | the source table, the next-source table, and every checked output and input |
| Photos' own animation bit | within 0..1 with 1e-5 tolerance, but the tensor program never computes that wire, so the check always reads 0 | not checked |

Window and dock outputs (sizes at least -1e-5, flags within 0..1 with 1e-5 tolerance), Photos geometry outputs (at least 0, no tolerance), and Photos' inputs (content size at least 0, focus exactly 0 or 1, opacity within 0..1 with 1e-5 tolerance, spring timestep at least 0) use the same rules in both. So "no frame is rejected by only one machine" is an observation over these traces, not a consequence of identical rules. An earlier version of the output contract gave Photos geometry a 1e-5 tolerance and didn't check Photos' inputs.

### A cost hidden by where a range is declared

window-manager.ts never declares the spring timestep's range, so while the window springs are built the builder can't tell the timestep is nonnegative, and each `velocity * timestep` and `acceleration * timestep` becomes a 3-operation signed multiply. Photos declares the timestep nonnegative when it is inlined, after the window springs exist, so only the Photos springs get single-ReGLU products. With the allocator, a range sits next to the value it describes, and the report measures declaring it right where the timestep is computed:

| Circuit | Built operations | Live operations | Layers | Stored weights |
| --- | ---: | ---: | ---: | ---: |
| as the original | 6,146 | 5,253 | 192 | 11,598 |
| timestep declared nonnegative where it is computed | 5,826 | 4,933 | 184 | 10,958 |

That saves 320 live operations (6.1%): 20 window spring lanes × 4 substeps × 2 products × 2 operations each. Over 2,000 random frames (858,429 values), the variant's outputs match the rewrite's bit for bit, because for a nonnegative `b` the signed form `fround(a * b) - fround(a * 0)` equals `fround(a * b)`.

### Lines and characters by category

Counts are non-blank lines that aren't only a comment, and characters without indentation. Before is window-manager.ts plus photo-gallery.ts, split into regions by line prefixes listed in `report.ts`. After is `indirect-os.ts`, `photos.ts`, and `indirect-os-dom.ts`, split by `// category:` markers, with any statement that talks to the table (`allocate`, `next`, `finish`) counted as wiring. Declarations are the lists of cells with their ranges and initial values, plus the constants those lists use. Wiring is offsets, accessor functions, the writeback mapping, the Photos wiring, and output flattening.

Generic helpers are the original files' private hit test, interval distance, clamp, and complement functions (`emitRectangleHit`, `emitIntervalHit`, `emitIntervalDistance`, `emitClampZeroOne`, `emitClampDynamic`, `emitComplement`). Their equivalents (`hit`, `intervalHit`, `separableHit`, `intervalDistance`, `clamp01`, `clamp`, `not`) live in `wires.ts`, which the library count below includes, so the after column has none.

| Category | Before lines | Before characters | After lines | After characters |
| --- | ---: | ---: | ---: | ---: |
| behavior | 1,085 | 29,944 | 306 | 17,476 |
| generic helpers | 74 | 2,207 | 0 | 0 |
| bookkeeping (declarations and wiring) | 641 | 20,744 | 110 | 4,731 |
| of which declarations | 275 | 7,682 | 82 | 3,270 |
| of which wiring | 366 | 13,062 | 28 | 1,461 |
| validation | 357 | 12,000 | 11 | 948 |
| host JS | 392 | 13,836 | 209 | 9,726 |
| imports | 49 | 891 | 40 | 911 |
| total | 2,598 | 79,622 | 676 | 33,792 |

The standalone Photos machine (68 lines, 2,133 characters) wasn't rewritten and is left out of the before totals. The shared library (`table.ts` and `wires.ts`) adds 402 lines and 18,009 characters, written once for any app.

The behavior line ratio (3.5×) overstates the gain, because the original puts one affine term per line. The character ratio (1.71×, with generic helpers left out on both sides) is fairer. Bookkeeping shrinks 4.4× by characters, and validation 12.7× because it becomes a range next to each declaration plus 11 lines of output and input contracts, though with different rules (see above). Host JS shrinks the least, 1.42×, because DOM work is real work. Bookkeeping plus validation falls from 38% of the lines to 18%.

### Rough per-frame cost

Medians from `report.ts`, over three runs on a shared machine.

| Call | Median µs |
| --- | ---: |
| original `machine.step` (validation, evaluation, writeback) | 107-134 |
| rewrite `machine.step` (derived checks, evaluation, writeback) | 34-43 |
| `circuit.evaluateTensor` alone | 33-41 |
| derived source validator alone | 0.3 |

The rewrite's step checks the source table, the next-source table, the output contract, and Photos' inputs. The original's hand-written validation costs about 70 to 90 µs per frame, and the rewrite's checks cost about 1 µs. The two machines don't check the same rules, so this compares costs, not what each check catches.

### The settings panel

`settings-panel.ts` has three toggles, a segmented control, a slider, and a reset button, with springs on every knob and the segment highlight, plus hover. Spring state is stored in normalized units (0 to 1 along a switch, the segment index, the slider value), and pixels are computed only when projecting outputs. A viewport resize moves the panel without starting an animation, and a test checks that.

| Circuit | Source cells | Built operations | Live operations | Layers | Stored weights |
| --- | ---: | ---: | ---: | ---: | ---: |
| settings panel | 54 | 800 | 670 | 75 | 1,374 |
| Newton reciprocal alone, for 1..16384 | 2 | 101 | 72 | 19 | 109 |

`settings-panel.ts` is 184 code lines: 72 behavior, 38 declarations, 10 wiring, 8 validation, 35 host (the machine), 21 imports. Its DOM host `settings-dom.ts` is separate. Over 500 random frames, the circuit agrees with the plain JS reference: toggle bits, the selected segment, and dragging match exactly, the slider value is within 1e-5, and every spring position is within 1e-3. Toggles settle exactly on their end values in under 40 frames. The reference test skips pointer positions within 0.02 px of a hit threshold, where FP32 rounding of the depth may flip the decision.

The slider divides by a track width known only at runtime. `reciprocal` finds the octave of the width with one exact threshold bit per octave, starts from a seed within a third of the answer, and runs 5 Newton steps `y = y * (2 - x * y)`. Over 36,384 samples, 20,000 of them random, the largest relative error is below 1e-7 (9.9e-8 and 9.7e-8 in two runs), and 69.6% to 69.7% of results equal `Math.fround(1 / x)` bit for bit.

## What this shows about how far the approach goes

### What fit well

- One declaration per cell carries everything the circuit, the host, and the validator need. The allocator reproduced the original's 201-cell layout and circuit exactly, so the 641 lines of hand-kept bookkeeping were redundant information, not UI logic, and most of the 357 lines of validation became ranges on declarations plus 11 lines of contracts.
- Components with explicit input contracts replace circuit inlining. Photos is ordinary code that reads parent wires, and the compiled result is identical to inlining. The same contract has a runtime half that the host checks after every evaluation.
- Helpers are free at runtime. Struct `select`, `rect`, `outset`, `hit`, and the three-select pointer latch chain compile into the same atoms as the long hand-written forms.
- Named output structs remove the offset tables and the "push fields in the same order as the table" convention. `read` gives typed values for DOM projection and tests.
- A derived validator is cheap, about 0.3 µs for 201 cells, so validating every frame no longer costs more than the circuit.
- The new UI took 72 lines of behavior. Toggles use `toggle`, segments use a struct select over a one-hot group plus `lookup` for the highlight target, and the slider uses the drag latch idiom from IndirectOS.
- Declaring a range in the same place as its value makes range facts visible. That exposed 320 live operations IndirectOS spends on signed products for a timestep that is never negative.

### What got awkward

- Creation order is part of the meaning. Ordinary affine terms are sorted by wire number, and wire numbers follow creation order, so identical FP32 results require building wires in the same relative order. I wrote a few spots in the original's order ahead of time: the window center before the dock center, and the interval end before the two differences in `intervalDistance`. The strict structural check confirms no difference remains. Nothing in the notation stops an author from reordering these statements, which would change rounding on fractional sums, though this prototype didn't measure how often.
- Structs are plain objects, so anything that walks them with `Object.values` depends on the order fields were written in. `table.next` first paired state by position, so writing `{velocity, position}` for a struct declared as `{position, velocity}` silently swapped the two cells; it now pairs by name. Output roots still flatten in field order, and a test pins that order to the original's flat output tables.
- Range facts depend on build order. A range declared later doesn't change operations that already exist, as the timestep case shows.
- Different spellings of the same arithmetic give different atoms. The originals write `1 - x` both with the unit source wire and with a bias, and clamp with `max(zero, x)` in Photos but `max(x, zero)` in the window manager. To keep the circuit identical, the notation offers `clamp01(v)` and `clamp01(v, 1)`, and Photos spells its clamp by hand.
- Building in two phases is a real constraint: all cells must be allocated before any behavior, so a component can't discover it needs a cell halfway through building.
- Some facts belong only to the validator. Photos' focus is at most one active, but declaring it to the compiler would change gather lowering, so the allocator needs an explicit `declareToCircuit` flag.
- Output contracts copied from hand-written validation inherit their mistakes. The copied "thumbnail left ≥ 0" rule rejects legitimate animation frames, and one copied check reads a wire the tensor program never computes.
- Division by a runtime value is a paragraph, not an operator: `(pointerX - trackLeft) / trackWidth` became a 72-operation, 19-layer Newton reciprocal.
- Hit tests need half a pixel of depth, so testing against a float64 reference means staying away from edges.

### What stayed outside the circuit

- Text: labels, photo names, the monitor rows, and formatting "volume 60%".
- Drawing: CSS turns numeric outputs into colors, shadows, and corner radii (`--fill`, `--focused`, `--hovered`).
- DOM node lifetime: Photos nodes are created and removed in JS while width, height, and opacity are positive.
- Browser input decoding: key names, Photos click coordinates from `offsetX` and `offsetY`, and the rule that Photos events in one frame are mutually exclusive (the host clears the other latches).
- Scheduling: `requestAnimationFrame` while `animationActive` is positive.
- The title bar buttons are still laid out twice, by circuit arithmetic for hit testing and by CSS flexbox for drawing. The rewrite didn't change that.

## Open questions and next steps

- Make range facts independent of build order, for example by requiring input contracts before any behavior, or by warning when `assume` narrows a wire that already has consumers. On IndirectOS that is worth 320 live operations.
- Give the notation an explicit accumulation order (a sum that keeps the caller's order through `roundAffine`), so moving a statement can't change rounding. Measure how many operations the extra rounding points cost.
- Derive output contracts from inferred ranges where the builder can prove them, and keep runtime checks only for the rest. That would have avoided copying the false thumbnail rule.
- Have `createOutputValidator` refuse, while building, any contract on a wire the tensor program doesn't compute, since such a check always reads 0.
- Put the shared spring transition matrix and one settle bit per struct behind `spring`, since springs are about 59% of IndirectOS and every lane already goes through one helper.
- Now that validation costs about 1 µs, generated JS (2.5 µs in phase 1) would make the whole step a few µs.
- For responsive widths, compare the in-circuit reciprocal with a host-computed inverse width cell: 72 operations and 19 layers versus one frame of latency.
- Drag and drop between Photos and the dock would test whether component outputs to the parent stay as clean as component inputs.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/notation/indirect-os.html lab/ui-exploration/notation/demo.html`, which serves the two pages at `/indirect-os` and `/demo`.

- Both pages load with no console errors.
- `indirect-os.html`: the System Monitor shows 201 inputs, 429 outputs, 5,253 activations, 192 layers and 11,598 sparse weights, the same as the original. Dragging Files by its title bar, resizing it from the grip, maximizing Photos, opening a photo and stepping to the next one all worked, and no validator threw.
- `demo.html`: the footer shows 54 source cells, 670 live operations, 75 layers and 1,374 weights, as in the settings panel table above. Toggling Bluetooth, choosing Dark, dragging the slider and Reset all worked.
- Fixed a bug in `demo.css`: while dragging, the slider knob was drawn far from the track, e.g. 124 px right of and 84 px below the position the circuit output. The knob node had `scale: calc(1 + var(--dragging, 0) * 0.12)`, and the individual `scale` property is applied on top of `transform`, so it also multiplied the node's translate3d position. The circle is now a `::before` pseudo-element that scales around the knob's center. `bun test lab/ui-exploration/notation` (18 tests) and `bunx tsgo -p lab/ui-exploration/notation` pass after the change.
- Not fixed in the first check: the slider's `dragging` output is still 1 in the frame that handles the pointerup, and `animationActive` is 0 while dragging, so the host scheduled no further frame. The knob kept its enlarged dragging look until the next pointer event, e.g. until the pointer moved after the release.
- Fixed later in `settings-dom.ts`: a pointerup or pointercancel sets a flag, and the frame that handles the release schedules one more frame. That frame's evaluation outputs `dragging` 0, since the release frame wrote `dragging × (1 - up.active)` into the next source cell. The circuit and its tests are unchanged. `bun test lab/ui-exploration/notation` (18 tests) and `bunx tsgo -p lab/ui-exploration/notation` pass.
- Recheck in Chrome, with `requestAnimationFrame` replaced by a scheduler that runs callbacks about every 16 ms: a scripted drag moved the volume from 60% to 21%. The frame that handled the pointerup still set `--dragging` to 1, the next frame set it to 0, and the knob circle's scale went back to 1 without any further pointer event. No errors.

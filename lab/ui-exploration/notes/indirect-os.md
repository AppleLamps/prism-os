# IndirectOS as a body of UI code

Status, September 15, 2026: written in phase 1, before the round 2 prototypes. Later measurements are in the [exploration README's capability map](../README.md#capability-map), and the current runtime's contracts and costs in the repo root's [execution-model.md](../../../execution-model.md). What this note says about IndirectOS describes window-manager.ts before September 15, 2026, when its springs, hit tests, Photos clicks and window content sizes changed ([lab/status.md](../../status.md#runtime-additions-since-september-14-2026)).

This note covers `window-manager.ts` (1,839 lines), `photo-gallery.ts` (967 lines), `index.html`, and `window-manager.css`. I skimmed both test files and also read `candidate-gallery.ts` and `hard-attend.ts` for more UI patterns. Every number was measured on commit `c3d8e54` with Bun. The scripts are listed at the end; they are session scratch files (scratch folder `phase1/indirect-os/`, not in the repo). The only repo file changed is this note.

## Numbers at a glance

| | IndirectOS, including Photos | Photos alone |
| --- | ---: | ---: |
| Source cells | 201 | 82 |
| Operations built | 6,146 | 2,771 |
| Live operations after removing unused ones | 5,253 | 2,358 |
| Layers | 192 | 91 |
| Stored sparse weights | 11,598 | 5,574 |
| Live boolean atoms | 64 | 36 |
| Requested outputs | 429 | |
| Circuit build plus tensor compile in Bun | 21-29 ms | |
| One `machine.step` (range check, evaluation, two validation passes, writeback) | 114.5 µs median | |
| One `circuit.evaluateTensor` alone | 37.4 µs median | |
| One `createTensorEvaluator(roots)` call | 32.7 µs median | |

`bun lab/runtime-cost/report.ts` gives the same program sizes and reports 45.4 µs for the full-array tensor path, 38.8 µs for the reusable evaluator, and 143.7 µs for the literal reference evaluator.

Two sections account for most of the cost. The 20 window spring lanes and their clamps take 1,653 live operations. The 24 thumbnail spring lanes and their clamps take 1,470. Together that is 59% of live operations and 59% of stored weights. Hit tests come next at roughly 900 live operations.

## How the code maps onto Cheng's render loop

vibescript's `ui.md` describes a render loop with these phases: DOM reads, handle inputs, new layout, animation tick, commit state, DOM writes, then schedule the next render if something is still animating. IndirectOS keeps that order and turns the middle phases (handling inputs, layout, animation, and committing state) into one circuit evaluation. `renderWindowManager` (window-manager.ts:1418) reads the viewport and calls `machine.step`. That call writes viewport and time into the source table, evaluates the circuit, and copies the `nextSource` outputs back into the same `Float32Array`. The function then projects outputs onto the DOM and schedules another `requestAnimationFrame` while the `animationActive` output is positive. Event handlers only write latch cells and call `scheduleRender` (window-manager.ts:1479-1516), which is what ui.md asks for. The circuit resets event latches itself by writing zero into their `nextSource` slots (window-manager.ts:1020). That is the circuit version of ui.md's "don't forget to reset ephemeral events". Hit tests use target rectangles rather than animated rectangles, which matches ui.md's advice to hit test against `dest`.

## 1. Catalogue of behaviors

Each entry says what the user sees, how the behavior is written as arithmetic, where the code lives, and what it costs. Costs come from `attribute-ops.ts`. That script patches `Circuit.prototype.append`, attributes each new operation to the builder line that caused it, and then counts live operations, stored weights, gathers, and the depth range per section.

### Recurring numeric idioms

These idioms show up across both files:

- Not: `unit - bit` (`emitComplement`, window-manager.ts:1606).
- And: `a * b`, which is one ReGLU when either side is known to be nonnegative.
- Or: `clamp01(a + b)`, e.g. `selectedWindow = clamp01(canvasPress + dockPress)` (window-manager.ts:664).
- Toggle: `maximized' = maximized + press * (1 - 2 * maximized)` (window-manager.ts:794-801).
- Latch: `select(eventActive, stored, fresh)`, e.g. drag ownership (window-manager.ts:710-715).
- A decision bit from a rectangle: `boolean(clamp01(min(x - left, right - x, y - top, bottom - y)))` (window-manager.ts:1566-1592).
- Keeping something drawn while it animates out: `present' = clamp01(visible + present * springActive)` (window-manager.ts:1003-1015).
- One-hot lookup with build-time constants: `sum over f of focus[f] * constant(item, f)` (photo-gallery.ts:279-319).
- One-hot cyclic shift for previous and next: `next[i] = keep * focus[i] + nextGate * focus[i - 1] + previousGate * focus[i + 1]` (photo-gallery.ts:418-429).
- A permutation matrix update for raising a window to the front (window-manager.ts:810-859).
- Priority selection: `emitFirstActive` (balanced tree, numeric-ui-core.ts:1316) and `emitFrontmost` (serial scan over ranks, window-manager.ts:1532).
- Selecting between two rectangles field by field: four selects, hand-written twice (window-manager.ts:481-486 and 871-876).
- Snap or animate: `select(snap, springPosition, target)` (photo-gallery.ts:475-506).

### 1.1 Frame clock

`frameDuration = timeInitialized * clamp(frameTime - previousFrameTime, 0, springMaxFrameDuration)` and `springTimestep = frameDuration * 0.001 / 4` (window-manager.ts:403-416). `nextSource` stores `previousFrameTime = frameTime` and `timeInitialized = 1` (window-manager.ts:1023-1024), so the first frame integrates zero time. Cost: 10 live operations. This differs from the spring section of vibescript's Animation.md, which steps a fixed 4 ms per step and carries the leftover time forward in `animatedUntilTime`. IndirectOS always runs four substeps, each a quarter of the frame. At 120 Hz each substep is about 2 ms; at 30 Hz each is 8 ms, capped by the 32 ms maximum frame duration.

### 1.2 Workspace, maximized rectangle, and dock layout

The workspace is the band between the system bar and the dock. The maximized rectangle is inset by the margin, and `min` keeps the result valid in tiny viewports (window-manager.ts:417-449). Cost: 20 live operations, 38 weights.

Dock layout (window-manager.ts:589-649): `gap = min(dockGap, viewportWidth / 3, dockHeight / 2)`, `itemSize = min(dockItemWidth, (viewportWidth - 3 * gap) / 4, dockHeight - 2 * gap)`, then a centered row of four squares with a hit test on each. Division by a fixed count becomes a coefficient (`1 / windowCount`). Cost: 71 live operations, 144 weights, 4 booleans.

### 1.3 Hit rectangles

For each window (window-manager.ts:463-582), the effective rectangle is `select(maximized, normalRect, maximizedRect)`, which takes four selects. Six rectangles are hit tested against the pointer-down position:

- The whole window, multiplied by `visible`.
- Close, maximize, and minimize. Each button rectangle is grown by half the button gap, so the gap between buttons splits evenly between neighbors.
- The title strip, from the window's left edge to the minimize button.
- The resize grip square in the bottom-right corner.

Cost for 24 rectangles: 408 live operations, 824 weights, 24 booleans. On its own, one rectangle hit costs 16 live operations, 9 layers, 30 weights, and 1 boolean (`spring-cost-split.ts`). In context it is cheaper, because right and bottom edges are shared.

### 1.4 Frontmost hit through the stack permutation

The stacking state is a 4 × 4 permutation matrix, `stack[rank][window]`, stored in the source table and declared one-hot along both rows and columns (window-manager.ts:388-399). `emitFrontmost` (window-manager.ts:1532-1564) scans ranks from the top down:

- `rankHit = clamp01(sum over w of stack[rank][w] * hit[w])`
- `selected[rank] = remaining * rankHit`
- `remaining = relu(remaining - rankHit)`

It then maps ranks back to windows with `sum over rank of stack[rank][w] * selected[rank]`. Cost: 39 live operations, 57 weights, and 8 gather reads. The gathers come from the one-hot declarations, which let the compiler replace masked sums with indexed reads. Because the scan is serial across ranks, depth grows linearly with the window count (11 layers for four windows). A balanced tree like `emitFirstActive` would give logarithmic depth.

### 1.5 Press routing

`canvasPress = downActive * frontmostHit` and `dockPress = downActive * dockHit`. Close, minimize, and maximize presses are `canvasPress * buttonHit`. Drag and resize presses are `canvasPress * regionHit * not(maximized)` (window-manager.ts:651-680). Button hits are not masked by occlusion themselves. They get that masking from `canvasPress`, which only fires for the frontmost window. Cost: 52 live operations, 108 weights.

### 1.6 Pointer latches and drag deltas

The source table has separate latches for pointer down, move, and up (an active bit plus x and y for each), and it remembers the last pointer position. The circuit computes:

- `baseline = select(downActive, pointerX, downX)`
- `moved = select(moveActive, baseline, moveX)`
- `pointer = select(upActive, moved, upX)`
- `delta = pointer - baseline`
- `pointerX' = pointer`

This lives at window-manager.ts:682-700 and 1021-1022, and costs 24 live operations and 45 weights. Because of this chain, one frame can carry a down, a move, and an up together (window-manager.test.ts:448, "a down and move received before one refresh still begin the correct drag"). Several moves in one frame collapse into the last one, which is fine for positions.

### 1.7 Drag and resize

Drag and resize ownership are latched per window: `dragForMotion = select(downActive, drag[w], dragPress[w])`, stored as `dragForMotion * not(upActive)` (window-manager.ts:709-723). The geometry update (window-manager.ts:730-777) is:

- `width = clamp(width + resize * deltaX, min(minWidth, viewportWidth), viewportWidth)`
- `left = clamp(left + drag * deltaX, 0, relu(viewportWidth - width))`
- `top` is clamped between the workspace top and `dockTop - height`.

Cost: 182 live operations, 338 weights, reaching depth 53. The position accumulates a per-frame delta and is clamped every frame. So if the user drags past a viewport edge and comes back, the window starts moving back right away, and the grab offset changes. `lab/event-window` stores the press point and the grabbed position instead, which keeps the grab offset. This is a design choice, not a bug.

### 1.8 Open, minimize, maximize, dock restore

- `open' = select(dockPress, select(closePress, open, 0), 1)`
- `minimized' = select(closePress, select(dockPress, select(minimizePress, minimized, 1), 0), 0)`
- `maximized` uses the toggle idiom, and close clears it.

This is window-manager.ts:779-807. Cost: 88 live operations, 164 weights. Each select costs 4 live operations.

### 1.9 Raise to front

The circuit first finds the selected window's rank: `selectedRank[r] = clamp01(sum over w of stack[r][w] * selected[w])`. For every rank except the top, the windows above the selected rank move down one rank: `moved[r][w] = sum over s of selectedRank[s] * stack[r < s ? r : r + 1][w]`. The top rank becomes the selected window. The final state is `next[r][w] = not(anySelected) * stack[r][w] + moved[r][w]` (window-manager.ts:810-859). The rank shift `r < s ? r : r + 1` is resolved while building the circuit, so every case becomes a fixed coefficient on 64 products. Cost: 112 live operations, 246 weights, 4 gather reads.

### 1.10 Focus

`focused = emitFrontmost(nextStack, nextVisible)` gives the topmost visible window (window-manager.ts:878). The dock focus indicator and the Photos `interactive` input both read this value. Together with the next visible flags and the effective rectangle selects, this section costs 203 live operations and 413 weights.

### 1.11 Window springs and minimizing to the dock

Each window has five springs: centerX, centerY, width, height, and scale (window-manager.ts:879-997).

- The center target is `select(visible, dockItemCenter, windowCenter)`.
- The width and height targets are always the window's own size, so a minimized window keeps its size and shrinks only through the scale spring.
- The scale target is `visible`, which is 0 or 1.
- `direct = clamp01(directManipulation + hiddenAndAbsent)` snaps the position to the target and zeroes the velocity. Dragging and resizing therefore don't animate, which is the circuit version of Input.md's "pin springs during drag". A hidden window that is no longer drawn tracks dock layout changes without animating (window-manager.test.ts:644).
- The scale spring is clamped to 0..1. The center is clamped so the scaled window stays inside the viewport. `translate = center - halfSize`, and CSS `transform-origin: 50% 50%` scales the window about its center.

`emitSpring` (numeric-ui-core.ts:1165-1220) unrolls four semi-implicit Euler substeps, then runs a settle check: `active = clamp01(relu(abs(x - dest) - settleDistance) * 100 + relu(abs(v) - settleSpeed) * 100)`, `position = select(active, dest, x)`, `velocity = v * active`. The section costs 1,653 live operations and 3,514 weights for 20 lanes, reaching depth 111. A single standalone `emitSpring` is 46 live operations, 33 layers, and 104 weights: 30 operations for the four substeps and about 16 for the settle check. Stiffness, damping, and timestep are source cells with nonnegative ranges, so most products are single ReGLUs.

`present' = clamp01(nextVisible + present * windowSpringActive)` keeps a closing window drawn while it animates into the dock. The window's opacity output is `present` (window-manager.ts:998-1015).

### 1.12 Output projection

Window outputs (window-manager.ts:1050-1078):

- translate x and y, width, height, scale, and `opacity = present`.
- `focused` and `maximized`.
- `stack = sum over rank of (rank + 1) * stack[rank][w] + 40 * springActive`. Animating windows jump above the others, like the depth bands during drag and release in Input.md.
- `contentWidth = relu(width - 2)` and `contentHeight = relu(height - titleHeight - 2)`, which subtract 1 px borders and the title bar. These become the Photos viewport.

Dock outputs are the item rectangle, `inactive = not(visible)`, `focused`, and `open`. JS writes `zIndex = 10 + stack` and the CSS variables `--focused`, `--maximized`, `--inactive`, and `--open`. CSS turns those numbers into border alpha, shadow size, corner radius, saturation, and dock indicator width with `calc()` (window-manager.css:98-104 and 515-537). The CSS plays the role a fragment shader plays over numeric outputs.

### 1.13 Photos

Photos is a separate circuit with its own 82-cell source table (photo-gallery.ts:141-580).

- Grid (photo-gallery.ts:192-221): `cellWidth = relu(viewportWidth / 4 - 5 / 4 * gap)`, `left[column] = gap * (1 + column) + cellWidth * column`. The grid hit test is separable: 4 column interval hits and 3 row interval hits (7 booleans), shared by 12 cells through `min(columnHit, rowHit)`. Cost: 100 live operations, 177 weights.
- Lightbox main rectangle (photo-gallery.ts:223-250): the inset is `min(92, 8% of width)`, and the height leaves room for the thumbnail strip. Hit tested once. 32 live operations.
- State: `focus[12]` is either one-hot (lightbox mode) or all zeros (grid mode).
- Thumbnail strip targets (photo-gallery.ts:279-319): each thumbnail's offset, distance, and spread are one-hot lookups with build-time constants. The constants encode the cyclic offset from the focused photo, clipped to `abs(offset) < 5`. Spread is a trapezoid integral of the falloff, computed in JS while building (photo-gallery.ts:653-674). Then `scale = relu(focusMass - 0.22 * distance)` and `centerX = viewportWidth / 2 + baseSize * spread + gap * offset`. This is tricks.md's one-hot indexing (now in [patterns.md](../../../patterns.md#comparing-each-items-index-with-the-selected-index)), without the shared-index reduction: 12 × 12 × 3 constants.
- Thumbnail hits (photo-gallery.ts:334-338): 12 rectangle hits against target rectangles, not spring positions. Together with the targets: 360 live operations, 948 weights.
- Previous and next controls (photo-gallery.ts:340-387): rectangles and interval hits, 33 live operations.
- Events (photo-gallery.ts:389-429): each effective event is `interactive * latch`, for click, previous, next, and close. In grid mode, a click on a cell focuses that photo. In lightbox mode, `emitFirstActive` picks one target in priority order: previous, next, the 12 thumbnails, then the main image. A click on nothing (the backdrop) clears focus. Previous and next are cyclic one-hot shifts. The next focus is a sum of five gated products. Cost: 135 live operations, 308 weights, reaching depth 44.
- Photo projection (photo-gallery.ts:522-542): `photoRect = gridMass * gridRect + focused * mainRect` and `opacity = present * (gridMass + focused)`. The switch between grid and lightbox is instant, with no animation. 120 live operations.
- Thumbnail springs (photo-gallery.ts:445-517): two springs per thumbnail (centerX and scale). They animate only when the lightbox was open both before and after the frame (`previousFocusMass * nextFocusMass`); otherwise they snap to the target. 1,470 live operations, 3,295 weights, reaching depth 91.
- DOM attach and detach (photo-gallery.ts:727-758): JS creates a node while width, height, and opacity are all positive, and removes the node otherwise. This is strategy 3 in ui.md's list of DOM update strategies (create just in time, detach when not visible). The window and dock nodes use strategy 1 (permanent nodes).

### 1.14 Inlining Photos into IndirectOS

window-manager.ts:1091-1168 maps every Photos source cell to a wire in the parent circuit:

- the Photos window's content size outputs, presence, and focus;
- the parent's spring constants and timestep;
- Photos state cells allocated in the parent table (10 event and constant cells, 12 focus cells, 48 spring cells).

It then calls `inlineCircuit`, maps the outputs back, and copies the Photos next state into the parent's `nextSource`. Photos reads this frame's animated content size, this frame's presence, and this frame's focus (as `interactive`). So one pointer down can focus Photos and select a photo in the same evaluation (window-manager.test.ts:734). Inlined Photos costs 2,356 live operations, almost the same as standalone (2,358).

### 1.15 Where the 192 layers come from

The deepest path, found by walking back from the deepest live operation, is:

- 13 layers of workspace geometry
- 12 layers of hit tests
- 11 layers of frontmost selection
- 3 layers of press routing
- 10 layers of drag geometry
- 3 layers of effective geometry
- 49 layers of window springs and clamps
- 1 layer of content size
- 91 layers of Photos, stacked on top

`depth-decoupling.ts` rebuilds IndirectOS with Photos reading some inputs from the previous frame's source table:

| Variant | Live operations | Layers | Widest layer |
| --- | ---: | ---: | ---: |
| Current | 5,253 | 192 | 173 |
| Content size from the previous frame's spring state | 5,255 | 186 | 177 |
| Content size and presence from the previous frame | 5,255 | 118 | 247 |

Presence matters because the thumbnail hit rectangles are multiplied by presence. For today's serial JS executor, depth barely matters. For a layer-parallel executor, deciding whether a child app reads a value from this frame or the previous one is a trade between latency and depth.

### 1.16 Patterns in candidate-gallery.ts and hard-attend.ts

The candidate gallery computes three complete layouts every frame: Cinema, Contact, and Story. Each layout's score is the minimum over clamped, normalized sizes (candidate-gallery.ts:145-161). `emitArgmax` picks one layout (candidate-gallery.ts:324). Every projected value is `sum over c of selected[c] * candidateValue[c]` (candidate-gallery.ts:332-345), which lowers to 26 gather reads. Clicks go through the chosen layout's rectangles with `emitFirstActive` (candidate-gallery.ts:367). JS turns the one-hot winner into a layout name, a `data-layout` attribute, a hero image class, and title text by finding the output equal to 1 (candidate-gallery.ts:626-656). JS also converts pointer coordinates to stage-local coordinates with `getBoundingClientRect` (candidate-gallery.ts:674-681). Totals: 463 operations, 417 live, 60 layers, 848 weights.

`hard-attend.ts` is not a circuit. It is a plain DOM walkthrough (sliders, `innerHTML` templates, `classList.toggle`) of looking up an item by index through a quadratic score. With `key(i) = (2i, -i^2)` and `query = (q, 1)`, the score `2qi - i^2` is largest at `i = q`. Argmax retrieves item q exactly, and softmax blends its neighbors. For UI, this gives a way to find "the row whose id equals `selectedId`" by scoring instead of by a stored one-hot. That becomes important once rows can reorder.

### 1.17 Unit costs of common macros

| Construction | Live operations | Layers | Stored weights |
| --- | ---: | ---: | ---: |
| One `emitSpring` lane, nonnegative physics constants | 46 | 33 | 104 |
| Only its four integration substeps | 30 | 26 | 68 |
| One rectangle hit (interval distances, min, clamp01, boolean) | 16 | 9 | 30 |
| One select | 4 | 3 | 7 |
| One clamp (max, then min) | 6 | 6 | 10 |

### 1.18 A spring reformulation, measured

All springs share stiffness, damping, and timestep. That means the four-substep transition from `(position - destination, velocity)` to the next pair is one shared 2 × 2 matrix. `spring-reformulation.ts` computes that matrix once per frame (about 35 operations) and applies it to each lane with four products, keeping the same settle check. For 44 lanes, live operations go from 2,024 to 1,459, stored weights from 4,576 to 2,827, and layers from 33 to 20. Over a 300-frame trajectory with random frame durations between 8 and 32 ms and a retarget, the largest position difference is 0.00015 px. Both versions settle on the same frame at exactly the destination. The settle check is now the larger part of each lane. Sharing one settle bit across a window's five lanes would remove most of what remains.

## 2. JS outside the circuit

### Event handlers and latch writes

- `receivePointer` (window-manager.ts:1256-1261) overwrites the down, move, or up latch. Only the last event of each kind in a frame survives. `pointercancel` is treated as `pointerup` (window-manager.ts:1491-1494). There is no pointer capture.
- `receivePhotoEvent` (window-manager.ts:1263-1272) zeroes the other Photos latches before setting its own. The rule that Photos events in the same frame are mutually exclusive, with the last one winning, is therefore decided in JS.
- The `keydown` handler (window-manager.ts:1499-1515) maps ArrowLeft, ArrowRight, and Escape to Photos previous, next, and close, and calls `preventDefault`. It does this even when Photos is not focused; the circuit later gates the event with `interactive`. Key decoding is JS logic.
- Photos clicks come from a `click` listener on `.photos-content` using `event.offsetX` and `event.offsetY` (window-manager.ts:1495-1498). The browser's hit testing decides whether a click reaches Photos, and the browser converts the pointer into the content box's local coordinates. The circuit's frontmost-window hit test does not route clicks into Photos. The two agree because every other element has `pointer-events: none` and the circuit gates Photos events with focus.

### Source table writes outside events

- `createWindowManagerMachine` (window-manager.ts:1190-1237) writes 23 constants and the initial geometry, stacking, and spring state. The Photos constants (gap 18, inset 92, thumbnail height 82, control size 52) are written again in `createPhotoGalleryMachine` (photo-gallery.ts:583-597).
- `step` writes the viewport (read by JS from `document.documentElement.clientWidth`) and the frame time from `requestAnimationFrame` (window-manager.ts:1285-1287).

### Runtime contract checks

`step` runs `validateWindowManagerSource` on the source, `circuit.validateSourceRanges` inside `evaluateTensor`, and `validateWindowManagerOutput`. That last call runs the source validator again on next state and also validates the Photos outputs (window-manager.ts:1288-1290). In Bun the whole step takes 114.5 µs, while evaluation alone takes 37.4 µs. Validation and writeback are about two thirds of the per-frame CPU cost shown as "frame execution" in the System Monitor window.

### DOM projection and scheduling

- 7 style writes per window, 7 per dock item, and 5 per visible photo or thumbnail, each built with a template string every frame and with no write-on-change caching (window-manager.ts:1425-1468, photo-gallery.ts:701-787). These nodes are not stateful, so ui.md allows this.
- Thresholds decided in JS: a node is attached while `width > 0 && height > 0 && opacity > 0` (photo-gallery.ts:739), another render is scheduled while `animationActive > 0` (window-manager.ts:1472), and z-index is offset by 10.
- System Monitor text is computed in JS from the tensor program at mount, plus the frame time and "next RAF" text every frame (window-manager.ts:1353-1400 and 1474-1476).
- Static text and images are chosen at node creation: photo names in `photoNames` and the CSS classes `image-0` through `image-11`.

### Layout decided by CSS

- Window contents for Files, Notes, and System Monitor are laid out entirely by CSS grid, flexbox, and text flow (index.html:24-80, window-manager.css:222-392). The circuit knows nothing about them. The Files sidebar hides itself with a media query (window-manager.css:545-557).
- The title bar buttons are laid out twice: once by circuit arithmetic for hit testing, and once by CSS flexbox (`justify-content: space-between`, a right padding equal to the button gap, and a gap between buttons) for drawing. They agree only because the constants match, and only to within 1 px: CSS draws the buttons inside the window's 1 px border, which the circuit's button arithmetic does not subtract. The same goes for the resize grip size, the content inset below the title bar, and the 1 px borders subtracted in `contentWidth`. ui.md warns against interleaving JS and CSS layout like this.
- Constants are defined three times: in the source table, as CSS custom property defaults (window-manager.css:24-29), and in a JS sync at mount (window-manager.ts:1402-1410).

## 3. Authoring friction

### Where the lines go

Counts are non-blank lines.

| window-manager.ts (1,775 lines) | Lines | Share |
| --- | ---: | ---: |
| Behavior body, circuit helpers, output flattening | 735 | 41% |
| Source bookkeeping: field layouts, accessors, range declarations, writeback mapping, Photos wiring, initial values | 520 | 29% |
| Runtime validation | 222 | 13% |
| JS host code: step, events, mount, monitor, DOM projection | 268 | 15% |
| Imports | 30 | 2% |

| photo-gallery.ts (921 lines) | Lines | Share |
| --- | ---: | ---: |
| Behavior body, hit helpers, build-time strip constants, flattening | 414 | 45% |
| Source bookkeeping and standalone machine | 261 | 28% |
| Runtime validation | 132 | 14% |
| DOM renderer | 95 | 10% |
| Imports | 19 | 2% |

### A notation experiment

`notation-rewrite.ts` copies three IndirectOS sections verbatim: workspace and maximized geometry, the per-window hit rectangles, and the dock layout (window-manager.ts:401-402, 417-582, 589-649). It then rewrites them with a small notation. The notation has a `Vec2` point, a `Rect`, and functions `sum` (terms may carry coefficients), `sub`, `half`, `scale`, `min`, `relu`, `mul`, `not`, `select`, `selectRect`, `right`, `bottom`, `outset`, and `hit`. The functions close over the circuit and the unit wire, so no call needs a `circuit` argument. A typical line is `closeLeft = $.sub($.right(box), s.buttonGap, s.buttonSize)`.

| | Lines | Characters | Operations | Live | Layers | Stored weights |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original | 230 | 7,058 | 679 | 554 | 27 | 1,115 |
| Rewrite | 40 | 2,651 | 677 | 554 | 27 | 1,115 |

Across 3,000 random source tables (156,000 outputs), every output matched exactly. The line ratio (5.75×) overstates the gain, because the original puts one affine term per line, so the character ratio (2.66×) is the fairer number. The point stands: much of the verbosity is notation, not the model. Affine composition in `Circuit.append` already folds chains of sums, so helper calls cost nothing at runtime.

### Specific friction points

- Manual source offsets. `windowStateStart = 35` (window-manager.ts:86) must equal the number of hand-numbered fields before it. photo-gallery.ts hard-codes `present: 24` and `thumbnailSpringStart: 34` (photo-gallery.ts:47 and 57). If `itemCount` changed from 12 to 16, the focus cells would overlap the presence cell, and nothing would catch it. Accessor functions like `windowSourceField` and `stackSourceField` (window-manager.ts:249-313, 59 lines) exist only to compute offsets.
- Output order by convention. `windows.push(...)` (window-manager.ts:1059-1078), `dockItems.push(...)`, and `flattenProjections` (photo-gallery.ts:676-689) must push fields in the same order as `windowOutputField`, `dockOutputField`, and `photoField`. Nothing checks that order. Every read is written like `values[machine.output.windows[outputStart + windowOutputField.translateX]!]!`, and the tests repeat the same pattern in `projectWindows`, `projectDock`, `projectPhotos`, and `projectThumbnails`.
- Photos wiring ceremony. The parent re-declares the Photos state layout (`photoSourceField`, window-manager.ts:93-107), assigns 22 named inputs one by one plus 60 focus and spring cells in loops (window-manager.ts:1091-1132), maps outputs back, and repeats the input mapping for writeback (`photoSourceBindings`, window-manager.ts:1146-1168). It also repeats the thumbnail spring range declarations with a comment that they "must agree with photo-gallery.ts" (window-manager.ts:342-357). That is 77 lines of wiring, plus the duplicated constants noted in section 2.
- Range declarations and validation mirror each other. There are 85 lines of `assumeRange` and `assumeOneHot` calls, and 354 lines of runtime validators that re-check roughly the same facts with a tolerance. Both could come from one declaration per cell: range, initial value, one-hot group, and whether JS writes the cell each frame or the circuit carries it.
- Repeated helpers with different signatures. `emitClampZeroOne` is defined privately in numeric-ui-core.ts:1229, in window-manager.ts:1594 (with a `unit` argument), in photo-gallery.ts:957 (without one), and inline in candidate-gallery.ts:481-484. `emitRectangleHit` has three versions with different arguments. Photos writes `emitMinimum(emitMaximum(zero, x), maximum)` by hand twice instead of calling `emitClampDynamic` (photo-gallery.ts:478-493). `photoNames` appears in two files, and the DOM `projectGeometry` helper appears twice.
- Hand-written sum loops. `terms.push([emitMultiply(circuit, a, b), 1])` loops show up in `emitFrontmost`, `selectedRank`, `nextStack`, `selectValue`, and the thumbnail target lookups. A `dot(bitsA, valuesB)` helper plus struct-level `select` would remove most of them.
- Fixed counts in several places. `windowCount = 4` must match the four `<section class="window">` nodes in index.html. `itemCount = 12` must match 12 CSS image classes and `photoNames`, and nothing checks that `columnCount * rowCount === itemCount`. Some behavior constants are literals instead of source cells, unlike the other constants: the thumbnail cutoff `abs(offset) < 5`, the falloff slope 0.22, a 12 px cap on `thumbnailGap` (photo-gallery.ts:267), four spring substeps, and the z-order bonus of 40.
- The `circuit` argument everywhere. 51 lines in window-manager.ts and 28 in photo-gallery.ts consist only of `circuit,`.

### Helpers that would shrink the code the most

In rough order of line savings:

- A source table allocator. It would take named cells or groups with a range, initial value, optional one-hot group, and default `nextSource` behavior. It would hand out offsets, derive range declarations, validators, and initial values, and nest child scopes such as a Photos scope inside the IndirectOS table. This would replace most of the 520 bookkeeping lines and most of the 354 validation lines in both files. Child apps would then build directly inside the parent circuit through a scope, and `inlineCircuit` wiring would disappear.
- The measured notation: `Vec2`, `Rect`, `sum`/`sub` with coefficients, `min`/`max`/`clamp`, `select` over structs, and `hit`. It gives 2.66× fewer characters on geometry code with the same circuit.
- Named output structs that flatten themselves and give typed reads, e.g. `output.windows[2].translateX` resolving to a wire, instead of offset tables.
- UI combinators for recurring structures: `latch(event, stored, fresh)`, `toggle(bit, press)`, `oneHotShift(bits, gate, direction)`, `oneHotLookup(bits, constantTable)`, `raiseToFront(stack, selected)`, `frontmost(stack, candidates)`, `springs(struct, targets, directBit)` with a shared settle bit, and `presentWhileAnimating(visible, present, active)`.

## 4. What IndirectOS does not cover, and a first idea for each

- Text. All text is static DOM text laid out by the browser: window titles, Notes content, Files labels, photo names, and System Monitor rows. The circuit only computes Photos' viewport size. First idea: when text changes, a JS prepare step runs pretext `prepare()` and writes segment widths into a fixed number of source cells, for example 64 per paragraph. The circuit then does line breaking. A sequential scan costs about one layer per segment; `lab/generative-fields` measured 147 layers for 16 slots of greedy flow. A parallel version would compute prefix sums, compare every pair of segments to find each segment's first overflow (n × n sign bits, then a first-active per row), and then use pointer doubling for log n rounds to mark line starts. That costs O(n² log n) operations but only O(log² n) layers. The width can change every frame during a window resize, so precomputing lines in JS would take the text back out of the circuit.
- Scrolling. IndirectOS once scrolled inside the circuit: commit `c33d635` ("Integrate scrolling grid into Palette") latched wheel deltas and clamped `paletteScrollY` against content height. Commit `a9e64cd` replaced that with native scrolling and DOM culling, and commit `ea079cc` later replaced the Palette window with Photos. First idea, consistent with Scrolling.md: keep a native `overflow: auto` container and have JS read `scrollTop` into a source cell once per frame. The circuit computes positions in content space, visibility bits for culling, and an optional scroll anchoring adjustment as an output that JS applies with `scrollTo`. Momentum and rubber-banding stay with the browser.
- Lists with unknown or large counts. First idea: a fixed capacity of slots with a `present` bit each, filled by a JS prepare step from data. Culling then uses tricks.md's "bounded visibility compaction" (now in [patterns.md](../../../patterns.md#itemsfilterisvisibleslice0-k-into-k-dom-nodes)): a visibility bit per row, a prefix count of visible rows, and routing into K DOM slots with K × N products. For 10,000 rows that is too wide. With fixed row heights, the first visible row is `floor(scrollTop / rowHeight)`, a bounded floor made from threshold bits. Rows would then be read from a data table by integer index. The compiler currently lowers only one-hot masked sums, so reading by a computed integer index, like a shader texture fetch, would be a new construction. Variable row heights would add a parallel prefix sum and a binary search made of log n comparisons and gathers.
- Hover and cursor. The pointer position is latched but never used for hover; `cursor: grab` and `nwse-resize` come from CSS. First idea: `hover = hit(pointer, rect)` with no new latch. The cursor becomes a small one-hot output that JS maps to a cursor string, and a tooltip delay becomes a latched hover start time compared with `frameTime`.
- Keyboard navigation. Only three keys exist, and JS decodes them into Photos-specific latches. First idea: a key latch vector with one cell per key the app understands (Tab, Shift, the arrows, Enter, Space, Escape), and a focus one-hot over focusable controls. Tab is a cyclic shift, as Photos does for previous and next, or a permutation matrix if tab order is data. Two-dimensional arrow navigation is `emitArgmax` over a score made from direction alignment and distance. Enter activates `focus * activationBit`. A focused-index output lets JS call `element.focus()` when the index changes, for accessibility.
- Text input. Editing, IME, selection, and undo belong to the browser. First idea: keep a native `<input>`, have JS copy its value through pretext, and write prefix widths into the table. The circuit then computes the caret x from `sum of caretOneHot * prefixWidth`, places the caret on click by counting how many segment midpoints are left of the pointer (an exact integer from a sum of bits), and draws selection rectangles. Editing a fixed-capacity code point array inside the circuit is possible (insertion is a shift driven by the caret one-hot, costing capacity² products), but the circuit cannot draw characters. The string itself stays in JS.
- Menus and popovers. First idea: an open bit and an anchor rectangle. Placement compares the space above and below the anchor and flips with `select`, then clamps to the viewport. Menu items are fixed slots with hover hits. An outside press dismisses the menu with `downActive * not(hit(menu)) * not(hit(trigger))`, the same shape as window press routing. Escape uses a key latch, arrow keys move a highlight one-hot, and a submenu is a nested open bit with a hover-intent timer.
- Drag and drop between containers. First idea: reuse the drag ownership latch. The drop target is `emitFirstActive` over container hit rectangles at the live pointer. The insertion index is a count of items in the target whose centers are left of or above the pointer. Membership is an items × containers one-hot matrix updated on release, the same way the stack update works. Displaced items move through springs retargeted to the new layout, and the dragged item is pinned with the `direct` select. Cost grows with items × containers products plus items² comparisons for ordering. Moving an item across apps, e.g. dragging a photo onto the dock, would also need the child app to expose outputs such as the dragged photo's rectangle and identity to the parent, which the wiring ceremony above makes painful today.
- Double-click, long press, and flick. First idea: latch press timestamps and a small archive of move positions, as `lab/event-window/README.md` already suggests. A double-click compares the time and distance between the current press and the previous one.
- A changing number of windows or app instances. First idea: a fixed capacity with `open` bits. A new window takes the first free slot through `emitFirstActive` over `not(open)`, and DOM nodes for a slot are created just in time. The stack permutation matrix grows quadratically with capacity.
- Window snapping, tiling, and occlusion culling. Snapping is an argmin over snap candidates by distance. A window is fully covered when some higher-ranked window's rectangle contains it, computed with the stack matrix.
- Responsive app content. Files uses CSS grid and a media query. The candidate gallery's argmax over complete layouts is the in-circuit answer, and it would also let hit testing see the content layout.
- Side effects such as `focus()`, `scrollTo`, `pushState`, storage, clipboard, and network. First idea: the circuit outputs request bits and parameters, JS performs them in the side-effect phase of the render loop, and the results come back as source cells on the next frame.

## 5. Prototype ideas

- Declarative source table and component scopes. Rewrite IndirectOS and Photos with an allocator that derives offsets, ranges, initial values, and validators, plus the measured notation, with Photos built through a scope instead of `inlineCircuit`. Success means an identical circuit and bit-identical outputs. This would show how much of today's 2,696 non-blank lines is essential UI logic.
- Cheaper springs. Combine the shared transition matrix, one settle bit per window, and a study of fewer substeps; measure total live operations and layers for IndirectOS. Springs are 59% of the circuit, so this answers how cheap animation can get when every lane shares one 2 × 2 map.
- A menu bar with keyboard focus inside IndirectOS: dropdown placement, hover highlight, outside-press dismiss, and arrow, Tab, Enter, and Escape handling through a key latch vector. This tests whether keyboard-driven discrete behavior is as cheap and clean in this model as pointer behavior.
- A virtualized list of 10,000 rows with native scroll, a fixed pool of DOM slots, and rows read from a data table by computed index. This shows whether lists with large or unknown counts fit a fixed table without an N-wide circuit, and exactly which new construction (reading by integer index) is needed.
- A Notes window whose text reflows during a window resize, using pretext widths in the table, comparing sequential line breaking against the parallel pointer-doubling version. This shows whether text layout that depends on a live width can stay in the circuit, and what it costs in operations and layers.
- Drag a photo from Photos onto the dock or into another container, with animated reordering. This tests the membership matrix and counting-based insertion, and it forces a clean way for inlined apps to expose outputs to their parent.
- A study of depth versus latency, reading child inputs from the previous frame. It would measure layers (192 to 118 is already measured for one case) and check that the visible one-frame lag during window animations is acceptable. This matters once a layer-parallel executor exists.

## Scripts

All scripts are session scratch files (scratch folder `phase1/indirect-os/`, not in the repo). They ran from the repo root with `bun <script>`.

- `attribute-ops.ts`: per-behavior operation counts, stored weights, gathers, depth ranges, the deepest path, and step timing.
- `timing.ts`: build time and per-frame breakdown without instrumentation.
- `spring-reformulation.ts`: current `emitSpring` against the shared transition matrix, with trajectory agreement.
- `spring-cost-split.ts`: unit costs of one spring, its substeps, one rectangle hit, one select, and one clamp.
- `notation-rewrite.ts`: verbatim sections against the notation rewrite, with line, character, and operation counts and output equality.
- `depth-decoupling.ts`: layer counts when Photos reads previous-frame inputs. It writes patched copies `window-manager-variant-*.ts` into the scratch folder.

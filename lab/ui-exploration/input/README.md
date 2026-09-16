# Several events per frame, keyboard focus, and menus

This prototype asks whether keyboard-driven and multi-event interactions are as clean as single-pointer interactions in Indirect's model, and what it costs to handle every queued event of a frame in one circuit evaluation. It has three parts and a demo that combines them:

1. Window behaviors (focus with raise to front, drag with slop, click versus drag, a maximize button, double click on the title bar) over a queue of 16 pointer events per evaluation, in two forms: the step unrolled once per queue slot, and a folded form where moves go through prefix counts and only press sessions run in sequence.
2. Keyboard focus over 12 controls: focus as a one-hot, Tab and Shift+Tab as "the next enabled control in cyclic order", arrow keys as a nearest-in-direction argmin, Enter and Space activation. For comparison, the same focus logic as a prefix scan over transition matrices.
3. A menu bar with dropdown menus: an open one-hot, placement that flips when it would overflow the viewport, hover highlight, keyboard navigation inside the menu, outside-press dismissal, activation outputs, and a focus target output that tells JS which element to call `element.focus()` on.

Every circuit is checked frame by frame against a plain TypeScript oracle that processes events one at a time and never imports circuit code.

## How to run

From the repo root:

```sh
bun test lab/ui-exploration/input               # 71 tests, about a second
bunx tsgo -p lab/ui-exploration/input
bunx oxlint --type-aware lab/ui-exploration/input
bun lab/ui-exploration/input/report.ts          # every table below, about 30 seconds (--quick for a short run)
bun lab/ui-exploration/input/demo.html          # the combined demo
```

No file outside this folder changed; numeric-ui-core.ts is imported as is. The demo was not opened in a browser during this work (no browser automation was allowed). A later Chrome check opened the demo, see [Browser check](#browser-check). It typechecks, bundles with `bun build`, and only calls modules the headless tests exercise.

Files:

- `events.ts`: the queue slot layout and how events are written into the source table.
- `kit.ts`: exact integer decisions, logic on bits, one-ReGLU picks, masked reads, argmin, a source cell allocator, measurement.
- `windows.ts`: part 1, the oracle, both circuit forms, and a machine wrapper.
- `keyboard.ts`: part 2.
- `menu.ts`: part 3.
- `app.ts`: the combined circuit and its oracle, used by the demo.
- `input.ts`: the JS boundary: key decoding, time quantization, a legal pointer stream, splitting a frame into evaluations.
- `traces.ts`: seeded random traces, aimed at what is on screen through shadow copies of the oracles.
- `report.ts`, `fixtures.ts`, `*.test.ts`, `demo.html`, `demo.ts`, `demo.css`.

## What was built

### The queue in the source table

Each slot holds one event in arrival order: four kind bits (down, move, up, key; all zero for an empty slot), whole-pixel x and y, a time relative to the frame, one bit per key the app understands (Tab, the four arrows, Enter, Space, Escape), and the Shift state at the time of the key event. Times are milliseconds on a 1/16 ms grid inside -4096..0, so `16 * time` is an exact integer in FP32. A latched time, e.g. the last click's time, is stored relative to the current frame and aged by each frame's duration (clamped at -65536 ms), so it stays a small exact number instead of a timestamp that loses resolution after hours.

On the JS side (`input.ts`), event handlers only push raw input and schedule a render. The render function quantizes times and coordinates, drops an up without a press, and splits the frame's events into evaluations of at most `capacity` events. The first evaluation carries the frame's duration, and later ones carry 0.

### Exact decisions without the boolean atom

Every decision in this folder is an integer bit. For an integer-valued affine v, `relu(v - t + 1) - relu(v - t)` is exactly `[v >= t]`, e.g. "x is strictly right of the window's left edge" is `[x - left >= 1]`. AND and OR over n bits are one more bit over their sum. Choosing between two integers is `off + relu-gated(on - off)`, one ReGLU. Reads through a one-hot, e.g. "the left edge of the pressed window", go through `multiply`, so gather lowering turns them into indexed reads. No circuit here uses the boolean atom.

One FP32 hazard cost a debugging round. A bit written as two relus is a small affine, so the builder copies both relu terms into every consumer. Arrow navigation first wrote the score of a disabled candidate as `score + 2^18 * (1 - valid)`. That multiplies the relus (values near 2^18) by 2^18, the consumer's partial sums pass 2^24, and integer scores drift, so the argmin picked the wrong control. Writing the replacement as `pick(valid, 2^18, score)` never scales a relu. `kit.atLeast` also keeps a bit as its own rounding point when its relus can pass 2^19, which makes scaling a bit by up to 16 safe. Both cases are pinned in `kit.test.ts`.

### Part 1: window behaviors over the queue

The oracle (`windowsOracleEvent`):

- A down hit-tests the frontmost window by rank, strictly inside its edges, then focuses and raises it. A down on empty space clears focus.
- The top 28 px of a window is its title band, and the rightmost 28 px of the band is a maximize button.
- A drag from the title band begins once the Chebyshev distance from the press point exceeds 4 px. The window shows the grab point plus the pointer delta, clamped to the workspace, and commits at release. A maximized window never moves.
- A press that never crossed the slop distance is a click. A click on the button toggles maximize.
- A title click whose down comes within 500 ms of the previous title click's up, within 4 px, on the same window, is a double click and toggles maximize. After a double click the next click starts over, so three quick clicks toggle once and four toggle twice.

**Unrolled form.** `windowsEventStep` builds the down, move, and up effects from the same incoming state and merges fields by which event kind owns them, e.g. only a down writes the press point and only an up writes committed positions. The frame's circuit calls that step once per slot.

**Folded form.** A move changes what later events see only through two summaries: the press point (a latch) and "crossed the slop distance since the latest press" (an OR that resets at each press). The folded circuit computes those for every slot at once:

- One wide sum per slot counts downs and ups up to that slot. With a legal stream, "pressed before event i" is `initial pressed + downs before i - ups before i`, an exact integer, and "event i belongs to press session s" is an equality bit on the down count.
- Each session's down and up are read through those bits (gathers).
- Every move measures its distance from its own session's press point in parallel, and a session's slop latch is an OR over its moves.
- Only the press sessions run in sequence, because a session's down hit-tests geometry that the previous session's up may have changed, e.g. a window dragged and released, then pressed at its new position within one frame. The circuit is built for a maximum number of downs per evaluation, and JS splits a frame with more downs into more evaluations.
- A second variant reads each event's press point through a Sklansky prefix scan of latches instead of session reads.

### Part 2: keyboard focus

- Tab from control i is "the first enabled control after i in cyclic order", written as counts: control k is chosen when it is enabled, comes after i, and no enabled control sits between them, or, when nothing comes after, when it is the first enabled overall. It costs a few ReLUs per control and no search. Shift+Tab reverses the arrays.
- An arrow key picks, among enabled controls strictly ahead in that direction, the smallest `distance along the direction + 2 * distance across it`, measured between doubled centers so everything stays whole. Ties go to the lower index, and focus stays put when nothing is ahead.
- The `per-event` form computes one argmin per key event from the focused control's center (a gather). The `tables` form computes, once per evaluation, the transition tables for every possible focus (next, previous, and four directions), and each key event reads its row through the focus one-hot (gathers).
- `report.ts` also builds the associative form: each key event becomes a 13 × 13 one-hot transition matrix (12 controls plus "none"), and a Sklansky scan composes them. For a comparison with the same behavior, it also applies the same matrices to the focus vector one event at a time. Both matrix forms handle only Tab, Shift+Tab, the arrows, and Escape: no pointer events, Enter, Space, or activations.

### Part 3: menu bar

`menu.ts` implements the rules in its header comment. Placement for each menu is two comparisons and two clamps, computed once per evaluation. The open panel's rectangle is read through the open one-hot, and items are hit-tested at their rows. Keyboard behavior splits into three exclusive regimes (a menu is open, a title has focus, nothing has focus), and each state bit's next value is merged by event kind. The focus target output is one integer: -1 for none, m for title m, and `menuCount + m * itemSlots + k` for item k of menu m.

### The combined demo

`app.ts` puts a menu bar (three menus at the top and a Layout menu in a bottom status bar), three windows, and a 12-key keypad inside the first window into one circuit, unrolled over 8 slots. Routing between the parts is written as bits over the state before each event: keys go to the menu bar while a menu is open or a title has focus, and to the keypad otherwise, a down on a menu title never reaches the windows, and a down focuses a key only when the keypad window is frontmost under the pointer. Menu actions then change other parts' state within the same event, e.g. "Cycle to next window" focuses and raises a window, and "Disable every other key" changes which keys Tab skips. The page runs the oracle next to the circuit and shows a divergence counter.

## Measured results

All counts are from `bun lab/ui-exploration/input/report.ts` on this checkout. "Layers" are compiled tensor layers, and "weights" are stored sparse weights. µs are single-threaded CPU executor times over prepared source tables, on a machine shared with other agents, so read them as rough.

### Window behaviors, sizes

| form | capacity | live operations | layers | stored weights |
| --- | ---: | ---: | ---: | ---: |
| unrolled | 1 | 379 | 15 | 1,521 |
| unrolled | 4 | 1,329 | 38 | 5,699 |
| unrolled | 8 | 2,596 | 73 | 11,336 |
| unrolled | 16 | 5,129 | 142 | 22,459 |
| unrolled | 32 | 10,196 | 281 | 44,856 |
| folded, at most 1 down | 16 | 1,014 | 38 | 4,121 |
| folded, at most 2 downs | 8 | 1,126 | 55 | 4,474 |
| folded, at most 2 downs | 16 | 1,494 | 55 | 6,110 |
| folded, at most 2 downs | 32 | 2,230 | 55 | 10,342 |
| folded, at most 4 downs | 16 | 2,347 | 89 | 9,470 |
| folded, at most 2 downs, prefix scan for the press point | 16 | 1,514 | 54 | 6,334 |

### Correctness against the oracles

Every frame compares the whole next state and every output for exact equality.

| circuit | frames | events | mismatched frames |
| --- | ---: | ---: | ---: |
| windows, unrolled, capacity 16, trace with at most 2 downs per frame | 20,000 | 101,771 (19,392 downs, 719 maximize toggles, 383 drag commits) | 0 |
| windows, folded (session reads and prefix scan), same trace | 20,000 each | 101,771 | 0 |
| windows, unrolled and folded with at most 4 downs, trace with at most 4 downs | 20,000 each | 103,283 (24,474 downs) | 0 |
| windows, one capacity-1 evaluation per event | 4,000 per trace | | 0 |
| keyboard, per-event and tables, capacity 8, three layouts | 18,000 each | 40,331 key events, 10,719 focus changes, 6,609 activations | 0 |
| keyboard as transition matrices, scan and sequential, Tab, arrows, and Escape only, capacities 2, 4, 8, 16, three layouts, each frame starting from the oracle's focus | 3,000 per form per capacity | 1,582 to 2,153 frames with these keys, 1,321 to 1,781 focus changes | 0 (every output is exactly the expected one-hot) |
| menu bar, 3 menus x 5 slots, capacity 8, six random bars that move between some frames | 24,000 | 72,005 (1,180 activations; 9,206 frames with a panel flipped upward, 8,772 with a panel flipped to right-aligned) | 0 |
| combined app, capacity 8 | 12,000 | 23,280 pointer and 12,223 key events | 0 |

The named cases from the brief are tests in `windows.test.ts`, run through all three window circuits: "moving outward past slop and back cancels the click, within one frame" (and across frames), "down, up, down within one frame: the second down sees the maximized window", "a drag commit is visible to a down later in the same frame", "raise to front changes which window a later down in the frame hits", "double click on the title toggles maximize, within one frame" (and across frames), "a slow second click starts a new double click instead of toggling", and "three quick clicks toggle once, four toggle twice". Routing rules of the combined app have named tests in `app.test.ts`, e.g. "Tab while a menu title has focus leaves the menu bar and focuses the first key, and the next Tab skips a disabled key".

### What one more queue slot costs

Differences between the capacity 8 and capacity 16 rows of the report (for sessions, between at most 2 and at most 4 downs at capacity 16):

| circuit | live operations | layers | stored weights |
| --- | ---: | ---: | ---: |
| windows, unrolled | 317 | 8.6 | 1,390 |
| windows, folded: one more slot | 46 | 0 | 205 |
| windows, folded: one more press session | 427 | 17 | 1,680 |
| keyboard, per-event argmin (12 controls) | 727 | 30 | 3,495 |
| keyboard, tables (about 6,200 operations once per evaluation) | 489 | 8 | 1,712 |
| keyboard, matrix scan (Tab, arrows, Escape) | 3,507 | 0.25 | 9,565 |
| keyboard, same matrices in sequence (Tab, arrows, Escape) | 1,346 | 2 | 3,544 |
| menu bar, 3 menus x 5 slots | 536 | 11 | 1,917 |
| combined app | 1,628 | 32 | 7,504 |

At capacity 16, the matrix scan is 59,730 operations, 31 layers, and 173,001 weights, and the same matrices applied one event at a time are 27,698 operations, 53 layers, and 83,769 weights. Those two circuits handle the same keys. The full keyboard circuits also hit-test pointer downs and ups, handle Enter and Space, and output activations: at capacity 16 the per-event form is 11,735 operations and 482 layers, and the tables form is 14,041 operations and 147 layers.

### Rough CPU time per frame

| circuit | µs per frame |
| --- | ---: |
| windows, unrolled, capacity 16 | 44.4 |
| windows, folded with at most 2 downs, capacity 16 | 12.6 |
| windows, one capacity-1 evaluation per event (about 5.1 events per frame on this trace) | 16.9 |
| windows, folded with at most 4 downs, capacity 16 | 21.8 |
| keyboard per-event, capacity 8 | 61.3 |
| keyboard tables, capacity 8 | 85.7 |
| menu bar, capacity 8 | 42.8 |
| combined app, capacity 8 | 129.4 |

For scale, phase 1's `event-unroll.ts` inlined the event-window step 8 times into 2,980 live operations (3,609 counting operations no output depends on, which is what phase 1 printed), 381 layers, and 6,070 weights. The unrolled window circuit here is 2,596 live operations, 73 layers, and 11,336 weights at the same capacity. The behavior sets differ (this one adds raise to front and double click, and drops the relation cells), so compare the shapes, not the totals. Depth per event went from about 47 layers to about 9 and weights roughly doubled. Those changes are consistent with integer bits and one-ReGLU picks (fewer layers per decision) and with bits written as two relus being copied into every consumer (more weights), but no circuit here isolates either change.

## What this shows about how far the approach goes

### What fit well

- **Exact event order within a frame is mechanical.** An event step is a function from (state, slot) to state, and handling the whole queue is that function called once per slot. The same builders (`windowsDownUpdate`, `windowsUpUpdate`, `menuEventStep`, `keyboardEventStep`) served the unrolled form, the folded form, and the combined app. Outward-and-back moves, down-up-down in one frame, and double clicks within one frame all come out right with no special cases.
- **Moves fold.** When the information a move carries forward is a latch, a count, or an OR, the whole queue's moves cost about 46 operations per slot and no depth. At capacity 32 the folded window circuit has 55 layers against 281 unrolled, and 2,230 operations against 10,196. On CPU it was the fastest option at capacity 16 (12.6 µs, against 44.4 unrolled and 16.9 for one evaluation per event).
- **Keyboard behavior is table lookup over one-hots.** Tab with disabled controls became a count, not a search. Arrow navigation became either one argmin per key event or a per-evaluation table read through gathers. Escape, Enter, Space, and "focus stays when nothing is ahead" are a few bits each. No keyboard rule needed a threshold on a continuous value, so exactness was never in question once the FP32 hazard was fixed.
- **Menus are all bits.** Hover switching between titles, outside-press dismissal, "press on a title, drag to an item, release" activation, and the three keyboard regimes are bit expressions over three one-hots. Placement with both flips is two comparisons and two clamps per menu, computed once per evaluation.
- **Side effects as outputs.** The focus target is one integer output, and JS calls `element.focus()` only when that output changes. "About this demo" is an activation count that JS turns into an overlay. That matches the side-effect phase of vibescript's render loop.

### What got awkward

- **Capacity is paid on every evaluation.** An unrolled circuit evaluates all its slots whether or not events arrived, so an empty frame costs as much as a full one: the capacity-16 unrolled window circuit averaged about 44 µs per frame over the trace, and the executor runs the same operations for every frame. One evaluation per event costs about 3 µs per event on average, so the right capacity depends on typical and worst-case event counts, and JS still has to split overflow.
- **Downs don't fold.** Each press session is about 17 layers and 427 operations, because a down reads geometry the previous up may have written: a drag commit, a maximize toggle, a raise. That dependency is real, not an artifact of the notation, so depth follows the number of presses per evaluation. JS bounds presses per evaluation and splits frames with more.
- **Associative scans over state machines are wide, and save little depth here.** Keyboard focus as 13 × 13 transition matrices composes in 2,197 products per combine. At 16 events the scan is 31 layers, 59,730 operations, and 173,001 weights. Applying the same matrices to the focus vector one event at a time is 53 layers, 27,698 operations, and 83,769 weights. So the scan saves 22 layers for about twice the operations and weights. The saving is small because multiplying a one-hot vector by a one-hot matrix only adds about 2 layers per event, and both forms first spend the same layers computing the tables and matrices. Composing functions only pays off with a backend that runs layers in parallel.
- **Arrow navigation is the expensive keyboard rule.** One argmin over 12 controls per key event is 727 operations and 30 layers per slot. Tables for every focus cost about 6,200 operations once, then 489 per slot. With a layout fixed at build time the tables would be constants, and with a small set of layouts they would be one table per layout, e.g. the keypad's 3 x 4 and 6 x 2 arrangements.
- **Routing between parts is where the bugs would be.** In `app.ts`, rules such as "a down on a menu title never reaches the windows" and "Tab while the menu bar has focus leaves it and focuses the first key" are cheap: a few routing bits per slot, plus one AND per key bit to hand each part only its keys. But every rule is written twice, once in the oracle and once in the circuit. Keeping invariants such as "at most one of title focus and key focus is set" is a promise the builder makes, checked only by tests.
- **Merging next state by event kind is verbose and costs products.** Each menu state bit is `idle * kept + down * onDown + move * onMove + up * onUp + key * onKey`, 5 masked products per bit per slot. The notation hides the ceremony, but not the cost.
- **Big coefficients on composed bits round.** The arrow-navigation bug above. Whether a bit may be scaled depends on how large its relu inputs can get, which a builder can't see locally. `kit.atLeast`'s guard covers scales up to 16, and larger scales need a pick.
- **The folded form assumes a legal pointer stream.** "Pressed before event i" is a count, so downs and ups must alternate. JS enforces the order (`legalizePointerStream`), which moves a small piece of interpretation into the boundary.

### What stayed outside the circuit

- `preventDefault()`. The browser needs that decision inside the keydown handler, before the circuit runs, so the demo prevents default for every key the app understands. A policy that depends on app state could only read the previous frame's outputs.
- Decoding `event.key` strings into key bits, pointer capture, collecting coalesced moves, keeping the stream legal, and splitting a frame into evaluations.
- The `element.focus()` call itself. Focus changes the browser makes on its own, e.g. a screen reader moving focus, have no way back in; a "focus moved to element i" event kind would be the natural addition.
- All text: menu item labels, key labels, the About overlay.

## Open questions and next steps

- **A log-depth form for press sessions.** Session s+1's hit test could run against each possible outcome of session s (which window committed a drag, toggled maximize, or rose to the front) and select the matching result, the way a carry-select adder computes both carries. Depth then grows with the logarithm of presses per evaluation, and width grows with the number of outcomes. This was not built.
- **State-dependent enabled items.** "Maximize focused window" should be disabled while nothing is focused. The menu computes item tables once per evaluation from source cells, so a state-dependent enabled bit needs those tables per event, like the keyboard's per-event form.
- **Folding as a compiler pass.** The folded window circuit was written by hand. A pass that recognizes latch, count, and OR updates inside an unrolled step and rewrites them as prefix computations would produce the folded form from the step.
- **Browser focus events in the queue**, so assistive technology and native inputs can move focus and the circuit follows.
- **IndirectOS.** Its one-slot-per-kind select chain (window-manager.ts:682-700) still collapses a frame's moves into one and fixes the order down, move, up. The queue plus the folded form would replace that chain, and its Photos keys would become key bits routed by focus. Update, September 15, 2026: window-manager.ts now runs one evaluation per distinct event timestamp, so only events that share a timestamp collapse in this chain. Update, September 16, 2026: indirect-os-2 built this queue into a copy of IndirectOS, see [Merged from indirect-os-2](#merged-from-indirect-os-2-september-16-2026).
- **Speed.** The combined app costs about 129 µs per frame in the executor at capacity 8. Phase 1's generated plain JS ran IndirectOS about 11 times faster than the executor, so code generation is the obvious next measurement before judging frame budgets.

## Merged from indirect-os-2, September 16, 2026

[indirect-os-2](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/indirect-os-2) applied this folder's folded queue to the whole IndirectOS, in `desktop-queue.ts`, next to the spring bank, Photos and a Notes paragraph flowing around the windows. Root IndirectOS took the Notes flow and presses that act on release on September 16, 2026, so the folder was removed. Root didn't take the queue: it runs one evaluation per distinct event timestamp, and a press arms the control under it, so a release over the armed control acts whatever path the pointer took, with no slop cancel ([lab/status.md](../../status.md#runtime-additions-since-september-14-2026)). [codegen's README](../codegen/README.md#merged-from-indirect-os-2-september-16-2026) keeps its tiered execution. These are indirect-os-2's measurements from September 13 and 15, 2026, on an IndirectOS from before September 15.

- **Rules.** As in this folder, a press that moves past the 4 px slop turns into a drag, and a drag follows the geometry recorded at the press plus the pointer's offset, clamped to the workspace. IndirectOS's window buttons and dock items then act on a click, where window-manager.ts acted on the down, so moving past slop and back cancels a close. After every evaluation, every window is clamped to the viewport.
- **Photos' keys in the queue.** ArrowLeft, ArrowRight and Escape reach Photos while Photos is the focused window at that key's position in the queue. Photos' focus runs its own sequence: each press session's up may click Photos, and the keys between two ups fold into "clear if any Escape, otherwise rotate by rights minus lefts". A key slot's phase is the number of downs and ups before it, and each run of keys reads Photos' focused bit only at its own phases. That kept the program at 169 layers, against 257 when every key slot read the focus through one gather over all six window states, since each run of keys then waited for the last state. The named case: after a click opens photo 5 and ArrowRight moves to photo 6, a frame with ArrowRight, a click on Files, then ArrowRight ends on photo 7, since Files takes the focus in the middle of the frame. In another frame, after a click on Files, an Escape is ignored, and after a click on Photos' title bar, ArrowLeft moves photo 5 to photo 4.
- **Size.** With 8 slots and 2 presses per evaluation, the queue took IndirectOS with bank springs from 3,583 operations, 91 layers and 8,455 stored weights, with one latch per event kind, to 8,059 operations, 169 layers and 21,611 stored weights, with 309 source cells and 91 gather reads. With 16 slots it was 9,002 operations and still 169 layers, so one more slot cost about 120 operations, moves and keys included, and no depth. Each press session cost about 2,200 operations and 40 layers per evaluation, whether or not a press arrived: with 1 press per evaluation the program was 5,816 operations and 129 layers, and the queue 2,233 operations. Photos' clicks, three per evaluation, were the most expensive section, 1,973 operations and 74 of the 170 operations on the deepest path, since each click lays Photos out at the window's size at that point.
- **Checks.** 0 mismatched frames against a one-event-at-a-time oracle over 4 traces of 3,000 frames, with 33,129 events, 5,046 of them keys, up to 8 events and 2 presses per frame, and viewports from 360×300 to 1440×900.
- **Open idea.** JavaScript could split a frame at every second up, so Photos needs one click per evaluation instead of three, which would remove about 1,300 operations.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/input/demo.html`.

- The page loads with no console errors. The Inspector shows 13,331 live operations, 262 layers and 60,432 stored weights.
- Checked by hand: dragging the Notes title bar moves the window and raises it. Clicking key 5 counts it and focuses it, and ArrowRight then ArrowDown move keyboard focus to key 9, with DOM focus following. Double-clicking the Notes title maximizes it, with all 4 events in one evaluation. Clicking Layout at the bottom right opens its panel upward and right-aligned. ArrowDown and Enter then activate "Cascade windows", which restores and cascades the windows. Help, then "About this demo", shows the toast.
- A script then sent 395 key events (Tab, Shift+Tab, arrows, Enter, Space and Escape), 1 to 3 per frame over 200 frames.
- Divergence counter: 0 divergences after 455 frames and 455 evaluations.
- The Inspector's step time was about 2,700 to 3,300 µs per evaluation over the first frames, then about 220 to 260 µs. It includes JS reads.
- On load, the Inspector window overlaps the Keypad window and covers part of the "#" key.
- No fixes were needed.

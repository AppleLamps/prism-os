# Streaming words: every word springs, and a bubble is a reduction

This prototype asks whether a streamed chat reply can run as one fixed circuit when the unit of composition is the arriving word, or a chunk of a word, instead of the message. Every word finds its line with pretext's line walker written as arithmetic, every word has its own springs for x, y and opacity, a chat bubble is computed from its speaker's words, and stopping a reply writes back how many segments had arrived.

The short answer is yes, exactly, and at a cost that follows the capacity rather than the arrived text. Over 7,419 streamed states (48- and 96-word replies and conversations, in 1-character, 3-character and whole-word chunks, at 160, 240 and 320 px), every arrived word's line index and x, the line count, the overflow outputs and every bubble matched pretext exactly. A Stop between words writes 1 cell, and a Stop inside a word writes 2, because the growing word's width goes back to its width at the press. I tried a Stop at every press time of every reply stream (3,555 Stops): no word before the growing word ever moved, a Stop between words moved no target at all, and every spring settled exactly on its target within 49 frames. A Stop inside a word can move that word and the segments after it. When the word had moved to the next line between the press and the click, the Stop sends it back to the previous line: 9 of 260 press times for the 48-word reply in 1-character chunks at 240 px, 5 of 86 in 3-character chunks, and never with whole words. For a 48-word reply with springs the circuit is 18,522 live operations and 169 layers; for a 96-word conversation of 8 turns with springs it is 63,791 operations and 348 layers. The largest costs are the ones text-walker already had (an integer one-hot per line slot, and each segment's x read from every slot), the springs, and bubbles as reductions over words, which cost about 8.5 to 10 operations per segment per turn.

## What it is and how to run it

From the repository root:

```sh
bun test lab/ui-exploration/streaming-words
bunx tsgo -p lab/ui-exploration/streaming-words
bun lab/ui-exploration/streaming-words/report.ts
bun lab/ui-exploration/streaming-words/demo.html
```

- The tests (10 tests in 3 files, about 3 seconds) check every chunk state of a 48-word reply and of a 4-turn conversation against pretext, the three ways of computing the line count against each other, a Stop between words, inside a word, and inside a word that moved to the next line between the press and the click, both ways an arriving word can start, the springs against float64 iteration, generated JS against the executor, and the demo's logic, including that the demo stops at the press rather than at the click.
- report.ts prints every table below and merges them into results.json. The whole report takes several minutes. Pass part names to run some of them, e.g. `bun lab/ui-exploration/streaming-words/report.ts streams spawn`. The parts are sizes, phases, streams, interrupt and spawn.
- The demo page is a conversation: the user's messages arrive whole on the right, and the replies stream on the left in chunks. It has a Stop button, a width slider, and selectors for the chunk size and for how arriving words start. All of its logic is in chat-demo.ts, which chat-demo.test.ts runs headlessly. The page bundles (`bun build lab/ui-exploration/streaming-words/demo.html --outdir <folder>`, 22 modules), but I didn't open it in a browser.

Every circuit imports the shared runtime, `numeric-ui-core.ts`, with a relative path, except the rows below marked "index read instruction" and "index-read runtime defaults". Those use index-read's runtime copy, `index-read/numeric-ui-core.ts`. Pretext is text-walker's snapshot of pretext's `src/` (commit 477510e), `text-walker/pretext-src/`. Until September 15, 2026 this folder held unchanged copies of both, `numeric-ui-core-index-read.ts` and `pretext-src/`. Headless checks run pretext with text-walker's fake canvas, whose widths are multiples of 1/4 px, with the Gecko profile (lineFitEpsilon 0.005).

## What was built

| File | What it holds |
| --- | --- |
| `stream-walker.ts` | text-walker's gathered-lines walker, with overflow outputs masked at the arrived count, forced breaks at turn starts, and each segment's line index and x |
| `stream-circuit.ts` | The whole circuit: the line count at the arrived count (three ways), presence bits, bubbles, word targets and springs; copying spring state back, first paint, and live operations per phase |
| `stream-model.ts` | Chunking, pretext's layout of every turn's prefix, the cell writes for a chunk and for a Stop, the float64 reference layout and its comparison, and line changes of visible words |
| `session.ts` | Chunks at timestamps, frames with fixed 4 ms spring steps, and Stop at the press's timestamp |
| `spring-reference.ts` | Float64 spring iteration with the circuit's settle rule and gates |
| `generated.ts`, `codegen.ts` | Generated JS through codegen's generator, copied with one change: gather computes are loops over position tables |
| `kit.ts`, `word-springs.ts` | Copied from text-walker. kit.ts lists its changes at the top; word-springs.ts is unchanged |
| text-walker's `fake-canvas.ts` and `pretext-src/`, index-read's `numeric-ui-core.ts` | Imported from those folders (until September 15, 2026 this folder held unchanged copies, with index-read's runtime as `numeric-ui-core-index-read.ts`) |
| `samples.ts` | The replies, the conversation shapes, and a build helper that sizes the bounds from the texts |
| `chat-demo.ts`, `demo.html`, `demo.ts`, `demo.css` | The demo |
| `stream-layout.test.ts`, `stream-springs.test.ts`, `chat-demo.test.ts` | The tests |
| `report.ts`, `results.json` | The measurements |

### 1. Words that haven't arrived

The capacity is fixed when the circuit is built, e.g. 95 segments for a 48-word reply (48 words and 47 spaces) and 191 segments for 96 words. A segment that hasn't arrived has width 0 and break-after 0. A zero-width segment always fits, so absent segments glue onto the end of the last arrived line, and every arrived segment gets the line index and x that pretext gives the prefix text. Per chunk, JS writes the width cells of the segments that changed, and the arrivedCount cell.

pretext trims a trailing space, so a chunk that ends with a space adds no segment until the next word's first character arrives. In a scratch probe, every character prefix of the 48-word reply was segmented the same way as the whole reply, on the segments it has.

Only the outputs that describe the whole text need the arrived count:

- `windowOverflow`. A line slot compares segments up to `window` positions after its start, and its last comparison says whether the line would need more. That comparison only matters when the segment it tests has arrived, so the circuit multiplies it by `[arrivedCount - start >= window + 1]`. Otherwise every line ending in absent segments would report an overflow.
- `moreLinesThanSlots` is `[arrivedCount - finalStart >= 1]`: some arrived segment comes after the last slot's line.
- `lineCount`, built three ways and compared bit for bit at every state:
  - one-hot: an integer one-hot of arrivedCount, and a masked read of lineIndex at arrivedCount - 1;
  - index read: index-read's instruction, `lineIndex[arrivedCount - 1]`, plus `[arrivedCount >= 1]`;
  - count of line starts: `sum over slots k of [arrivedCount - start_k >= 1]`. Slots after the last real line start at or after arrivedCount, either exhausted (their start is the capacity) or holding lines of zero-width segments that start past the window. So the number of slots whose start comes before arrivedCount is the line count, with no read at a computed index. Every other build uses this variant.

For comparison, phase 3's scratch without masks (`streaming.ts` in the phase3-ideas scratchpad) found lineCount wrong in 43 of 48 whole-word states and windowOverflow nonzero in 43.

### 2. A spring per segment

The springs are text-walker's word-springs.ts: one fixed 4 ms semi-implicit Euler step is a constant 2x2 matrix, a frame's n steps are the product of constant powers selected by the bits of n, and each spring then costs 4 products plus a settle check that snaps it exactly onto its target. Every segment has springs for x, y and opacity against that one frame matrix. Spaces get springs too, because break-after bits are runtime cells, so which segments are spaces isn't known when the circuit is built. Opacity springs share the stiffness and damping, with a settle threshold of 0.002. Every bubble springs its top, width, height and opacity.

A word whose opacity is below 1/64 can't be seen, so it starts at its target and at rest: the spring's source position is `select([opacity >= 1/64], target, position)`, and its velocity is multiplied by the same bit. The bit is always exactly 0 or 1. Opacities within about 1/4096 of 1/64 may land on either side, where both choices are invisible. The opacity target is the presence bit `[arrivedCount >= j + 1]`, so fading in and fading out are the same spring.

An arriving word could start at its own place and fade in ('in-place'), or start at the previous segment's current position and slide out of it while fading in ('from-previous', which also keeps previousArrivedCount as state to find the arriving segments). Both are built, and I chose fading in at its place:

- With 'from-previous', a word on the same line as the previous word starts 4.7 px away after its first frame, about the width of a space, which reads as a small tremble. A word that starts a new line travels from the end of the previous line: at 240 px that is 8 of 48 words (18 of 96), 211 px on average and up to 227 px. That long diagonal move happens where the reader is looking, at the end of the text.
- With 'in-place', a visible word only moves when the text really reflows, e.g. when a growing word no longer fits and hops to the next line, so motion still means something changed.
- 'in-place' is 941 live operations smaller at 95 segments, and settles 33 frames after the last chunk instead of 43.

### 3. A conversation

JS writes turnStart = 1 at the first segment of every new turn. The walker adds `turnOffset = 4096` into the prefix sums at every turn start, the way text-editing adds a newline offset into its position keys. For a line starting at segment s, the fit span of any later segment then includes 4096 for every turn start in between, so no line reaches past a turn start. The prefix read at a line start includes that start's own offset, so a line that begins at a turn start still fits its own words, and x within a turn doesn't change.

Each segment's turn index is a Brent-Kung prefix count of turn starts, turned into an integer one-hot over the turns. For turn r:

- Bubble width: a maximum tournament over segments of `[turn == r] * present * (x + widthHead)`, where widthHead is a text segment's width, and 0 for a space. With single spaces between words this is the widest painted line.
- Line count: `sum over segments of [turn == r] * present * isLineStart`, where `isLineStart_j = lineIndex_j - lineIndex_(j-1)`.
- Top: over earlier turns, the sum of lines times the line height, plus padding and a gap for every turn that has words. Height: lines times the line height, plus padding.
- Left: fixed for the left speaker, and `columnWidth - width - padding` for the right speaker. Words of a right-aligned turn therefore depend on a reduction over their own turn. A word's target x is its x plus its turn's offset, read through the turn one-hot, which the compiler lowers to one gather read.

### 4. Stop

session.ts plays chunks at timestamps (one every 40 ms in the report), evaluates frames at 60 fps with fixed 4 ms spring steps, and handles Stop like a button: pressed at one time and clicked 110 ms later. Chunks that arrive between the press and the click are written and shown. Chunks that arrive in the frame that handles the click are dropped: nobody saw them, and writing them would change the width of a segment that is fading out. When the click is handled, the table goes back to the state at the press:

- arrivedCount, always;
- the growing word's width, when the press fell inside a word that kept growing, e.g. "qu" at the press and "quick" at the click.

Segments that arrived after the press keep their widths while their opacity springs fade them out. The line count, the bubbles and the overflow outputs stop counting them at once, because they read presence bits.

Words before the growing word can't move, because greedy line breaking decides a line from the segments before it, and their widths don't change. The growing word and the segments after it can move when the Stop shortens that word. For example, in the 48-word reply in 1-character chunks at 240 px, the press after chunk 91 sees "ju" at the end of a line. Before the click, "jump" no longer fits and moves to the next line. The Stop writes the width of "ju" back, so the word goes back to the end of the previous line, 210 px away, and loses the letters that arrived after the press. Segments shown after the press shift with it while they fade. `report.ts interrupt` tries a Stop at every press time and counts how often this happens.

### 5. References

- Layout: pretext's `walkLineRanges` on every turn's prefix, with the fake canvas. Line index, x, word targets, line count and bubbles must be equal in FP32 at every state.
- Springs: float64 iteration of the same steps with the same settle rule and gates, in two ways. The synced reference starts every frame from the circuit's own state, which measures drift within one frame. The independent reference never reads the circuit's state, which measures drift accumulated over a whole stream.
- Generated JS: every output equal to the executor's, bit for bit.
- Variants: the three line count variants, and the circuits compiled by the index-read runtime, must give identical layout outputs at every state.

## Measured results

Counts are exact. µs are rough medians on a machine shared with other agents.

### Circuit sizes (`report.ts sizes`)

"Mismatched states" streams the reply or conversation in 3-character chunks at 240 px and compares with pretext. Every row below had 0 mismatched states and the same layout outputs as the first row of its kind. Line slots and windows: 15 slots and a window of 20 at 95 segments, 18 and 17 for the 92-segment conversation, 29 and 20 at 191 segments, 36 and 17 for the 184-segment conversation.

| Words | Segments | Turns | Variant | Live ops | Layers | Stored weights | Gather table entries | One-hot ops | Build ms | Executor µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 48 | 95 | 1 | layout, lineCount by counting line starts | 9,094 | 135 | 21,318 | 58,425 | 2,880 | 160 | 59 |
| 48 | 95 | 1 | layout, lineCount by a one-hot masked read | 9,244 | 135 | 21,601 | 58,521 | 3,074 | 133 | 58 |
| 48 | 95 | 1 | layout, lineCount by the index read instruction | 9,051 | 135 | 21,218 | 57,000 | 2,880 | 132 | 56 |
| 48 | 95 | 1 | layout, one-hot variant, index-read runtime defaults | 7,614 | 105 | 16,931 | 57,096 | 1,444 | 122 | 48 |
| 48 | 95 | 1 | layout + bubble | 9,861 | 154 | 22,844 | 58,425 | 2,880 | 119 | 60 |
| 48 | 95 | 1 | layout + bubble + springs, in place | 18,522 | 169 | 39,274 | 58,425 | 2,880 | 141 | 115 |
| 48 | 95 | 1 | the same, index-read runtime defaults | 17,082 | 136 | 34,984 | 57,000 | 1,440 | 166 | 111 |
| 48 | 95 | 1 | layout + bubble + springs, from previous | 19,463 | 169 | 40,967 | 58,425 | 2,880 | 136 | 124 |
| 48 | 92 | 4 | conversation, layout + bubbles | 14,029 | 183 | 31,406 | 58,696 | 4,268 | 137 | 89 |
| 48 | 92 | 4 | conversation, layout + bubbles + springs | 22,779 | 199 | 48,008 | 58,696 | 4,268 | 156 | 151 |
| 48 | 92 | 4 | the same, index-read runtime defaults | 21,105 | 159 | 43,022 | 57,040 | 2,594 | 181 | 146 |
| 96 | 191 | 1 | layout, lineCount by counting line starts | 28,814 | 249 | 71,982 | 227,099 | 11,136 | 495 | 179 |
| 96 | 191 | 1 | layout, lineCount by a one-hot masked read | 29,114 | 249 | 72,551 | 227,291 | 11,522 | 506 | 188 |
| 96 | 191 | 1 | layout, lineCount by the index read instruction | 28,729 | 249 | 71,784 | 221,560 | 11,136 | 486 | 191 |
| 96 | 191 | 1 | layout, one-hot variant, index-read runtime defaults | 23,164 | 191 | 55,141 | 221,752 | 5,572 | 469 | 153 |
| 96 | 191 | 1 | layout + bubble | 30,349 | 271 | 75,044 | 227,099 | 11,136 | 526 | 198 |
| 96 | 191 | 1 | layout + bubble + springs, in place | 47,458 | 286 | 107,506 | 227,099 | 11,136 | 520 | 307 |
| 96 | 191 | 1 | the same, index-read runtime defaults | 41,890 | 225 | 90,860 | 221,560 | 5,568 | 583 | 306 |
| 96 | 191 | 1 | layout + bubble + springs, from previous | 49,359 | 286 | 110,927 | 227,099 | 11,136 | 524 | 319 |
| 96 | 184 | 8 | conversation, layout + bubbles | 46,475 | 332 | 109,642 | 234,784 | 16,632 | 574 | 298 |
| 96 | 184 | 8 | conversation, layout + bubbles + springs | 63,791 | 348 | 142,504 | 234,784 | 16,632 | 585 | 441 |
| 96 | 184 | 8 | the same, index-read runtime defaults | 57,131 | 272 | 122,596 | 228,160 | 9,972 | 742 | 464 |

The line count by counting line starts is 150 operations smaller than the one-hot read at 95 segments and 300 smaller at 191, and 43 and 85 operations larger than the index read instruction. "index-read runtime defaults" compiles the same circuit with that runtime's recognition of relu one-hots: every line slot's one-hot is resolved from its start wire, and its members leave the program. That removes 12% of the operations and 21% of the layers of the 96-word reply with springs. The relus stay, because each segment's line index and x read them. "One-hot ops" counts the live operations that build integer one-hots.

The demo's circuit with the fake canvas's widths has 194 segments and 4 turns, a window of 28 and 21 line slots: 49,044 live operations, 229 layers and 105,251 stored weights, built in 591 ms.

### Live operations per phase (`report.ts phases`)

| Phase | 48-word reply, 95 segments | 48-word conversation, 92 segments, 4 turns | 96-word reply, 191 segments | 96-word conversation, 184 segments, 8 turns |
| --- | --- | --- | --- | --- |
| walker: prefix sums, fit thresholds, skip counts | 557 (3%) | 723 (3%) | 1,131 (2%) | 1,458 (2%) |
| walker: line slots (one-hots, gathered thresholds, fit bits, overflow masks) | 5,342 (29%) | 5,858 (26%) | 15,916 (34%) | 18,338 (29%) |
| walker: per-segment line index and x | 3,055 (16%) | 3,514 (15%) | 11,489 (24%) | 13,652 (21%) |
| walker: turn index per segment | - | 173 (1%) | - | 356 (1%) |
| lineCount at the arrived count | 46 | 55 | 88 | 109 |
| presence bits and turn one-hots | 190 (1%) | 1,105 (5%) | 382 (1%) | 3,681 (6%) |
| bubbles (reductions over words, placement) and word targets | 671 (4%) | 2,601 (11%) | 1,343 (3%) | 8,881 (14%) |
| springs (frame matrix, word springs, bubble springs) | 8,661 (47%) | 8,750 (38%) | 17,109 (36%) | 17,316 (27%) |

Every build here has springs, placed in place. Springs cost about 90 live operations per segment for x, y and opacity, including the visibility gate and its selects, plus the shared frame matrix. For one turn, presence, the bubble, placement and word targets are 861 and 1,725 operations, about 9 operations per segment. With 4 and 8 turns, presence, turn one-hots, bubbles and word targets are 3,706 operations at 92 segments and 12,562 at 184: about 10 operations per segment per turn at 4 turns (3,706 / (92 x 4)), and 8.5 at 8 turns (12,562 / (184 x 8)). So this part of the circuit grows with segments times turns.

### Exactness over streams, and line changes of visible words (`report.ts streams`)

Every stream was checked at 160, 240 and 320 px, with one circuit per stream shape built for widths 160 to 320 px. A line change is a segment that was visible in the previous state and is on another line now, counted from pretext's layouts.

| Stream | Segments | Chunks | States per width | Mismatched states, all widths | Line changes at 160 / 240 / 320 px | Per 1,000 chunks at 160 / 240 / 320 px |
| --- | --- | --- | --- | --- | --- | --- |
| 48-word reply | 95 | 1 character | 261 | 0 | 7 / 4 / 4 | 26.8 / 15.3 / 15.3 |
| 48-word reply | 95 | 3 characters | 87 | 0 | 4 / 4 / 1 | 46 / 46 / 11.5 |
| 48-word reply | 95 | whole words | 48 | 0 | 0 / 0 / 0 | 0 |
| 48-word conversation, 4 turns | 92 | 1 character | 279 | 0 | 8 / 8 / 4 | 28.7 / 28.7 / 14.3 |
| 48-word conversation, 4 turns | 92 | 3 characters | 95 | 0 | 4 / 7 / 3 | 42.1 / 73.7 / 31.6 |
| 48-word conversation, 4 turns | 92 | whole words | 48 | 0 | 0 / 0 / 0 | 0 |
| 96-word reply | 191 | 1 character | 524 | 0 | 15 / 12 / 9 | 28.6 / 22.9 / 17.2 |
| 96-word reply | 191 | 3 characters | 175 | 0 | 12 / 12 / 6 | 68.6 / 68.6 / 34.3 |
| 96-word reply | 191 | whole words | 96 | 0 | 0 / 0 / 0 | 0 |
| 96-word conversation, 8 turns | 184 | 1 character | 570 | 0 | 19 / 14 / 7 | 33.3 / 24.6 / 12.3 |
| 96-word conversation, 8 turns | 184 | 3 characters | 194 | 0 | 14 / 13 / 6 | 72.2 / 67 / 30.9 |
| 96-word conversation, 8 turns | 184 | whole words | 96 | 0 | 0 / 0 / 0 | 0 |

That is 7,419 states with 0 mismatches. Every line change was the growing segment: a word whose first chunks fit at the end of a line, until a later chunk made it too wide. No other visible segment ever changed line, since greedy line breaking decides a line from the segments before it. JS spent about 26 to 37 µs per chunk at 48 words, and 44 to 91 µs at 96 words, preparing the growing turn's prefix with pretext and walking its lines.

### Interruptions (`report.ts interrupt`)

A 48- or 96-word reply at 240 px, a chunk every 40 ms, frames at 60 fps, the Stop pressed 13 ms after the chunk at 25%, 50% or 75% of the stream, and handled 110 ms later. "Segments fading out" counts the segments shown after the press; a segment that arrived in the frame that handles the Stop is never shown. "Arrived targets moved by Stop" is the largest move of a target, in x and y together, of a segment that had arrived at the press. These 18 press times happen to be ones where nothing moves; the next table tries every press time.

| Words | Chunks | Stop at | Cells written by Stop | Segments fading out | Arrived targets moved by Stop | Frames to settle after Stop | Opacity of faded segments at settle | Drift within one frame | Accumulated drift | Mismatched states |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 48 | 1 character | no Stop | - | - | - | 21 after the last chunk | - | 1.7e-5 px | 5.2e-5 px | 0 |
| 48 | 1 character | 25% | 2 | 0 | 0 px | 30 | 0 | 0 | 0 | 0 |
| 48 | 1 character | 50% | 1 | 2 | 0 px | 26 | 0 | 1.0e-5 px | 1.4e-5 px | 0 |
| 48 | 1 character | 75% | 2 | 0 | 0 px | 3 | 0 | 1.7e-5 px | 5.2e-5 px | 0 |
| 48 | 3 characters | no Stop | - | - | - | 29 after the last chunk | - | 1.7e-5 px | 6.8e-5 px | 0 |
| 48 | 3 characters | 25% | 2 | 2 | 0 px | 35 | 0 | 4.8e-6 px | 4.9e-6 px | 0 |
| 48 | 3 characters | 50% | 2 | 0 | 0 px | 27 | 0 | 1.0e-5 px | 2.6e-5 px | 0 |
| 48 | 3 characters | 75% | 1 | 2 | 0 px | 26 | 0 | 1.7e-5 px | 2.6e-5 px | 0 |
| 48 | whole words | no Stop | - | - | - | 33 after the last chunk | - | 0 | 0 | 0 |
| 48 | whole words | 25% | 1 | 6 | 0 px | 41 | 0 | 0 | 0 | 0 |
| 48 | whole words | 50% | 1 | 4 | 0 px | 35 | 0 | 0 | 0 | 0 |
| 48 | whole words | 75% | 1 | 4 | 0 px | 41 | 0 | 0 | 0 | 0 |
| 96 | 1 character | no Stop | - | - | - | 18 after the last chunk | - | 1.7e-5 px | 5.2e-5 px | 0 |
| 96 | 1 character | 25% | 2 | 0 | 0 px | 18 | 0 | 1.0e-5 px | 1.4e-5 px | 0 |
| 96 | 1 character | 50% | 2 | 0 | 0 px | 34 | 0 | 1.7e-5 px | 5.2e-5 px | 0 |
| 96 | 1 character | 75% | 2 | 0 | 0 px | 13 | 0 | 1.7e-5 px | 5.2e-5 px | 0 |
| 96 | 3 characters | no Stop | - | - | - | 37 after the last chunk | - | 1.7e-5 px | 6.8e-5 px | 0 |
| 96 | 3 characters | 25% | 2 | 0 | 0 px | 27 | 0 | 1.0e-5 px | 2.6e-5 px | 0 |
| 96 | 3 characters | 50% | 2 | 4 | 0 px | 34 | 0 | 1.7e-5 px | 6.8e-5 px | 0 |
| 96 | 3 characters | 75% | 2 | 2 | 0 px | 29 | 0 | 1.7e-5 px | 6.8e-5 px | 0 |
| 96 | whole words | no Stop | - | - | - | 35 after the last chunk | - | 0 | 0 | 0 |
| 96 | whole words | 25% | 1 | 4 | 0 px | 35 | 0 | 0 | 0 | 0 |
| 96 | whole words | 50% | 1 | 4 | 0 px | 35 | 0 | 0 | 0 | 0 |
| 96 | whole words | 75% | 1 | 6 | 0 px | 27 | 0 | 0 | 0 | 0 |

Positions drift at most 6.8e-5 px from float64 iteration over a whole stream, and opacities at most 4.9e-7. Whole-word streams have no drift at all, because words only fade in and never move. The settle snap then puts every spring exactly on its target, and faded segments exactly at opacity 0.

The next table tries a Stop at every press time instead: 13 ms after every chunk but the last, handled 110 ms later, at 160, 240 and 320 px. One session plays the stream without a Stop, and at the frame that handles each Stop, a copy of that session applies the Stop and plays until every spring has settled. The growing word is the last segment that had arrived at the press. A target "moved" when the Stop's frame gives it another x or y than the frame before. "Fading segments" are the segments shown after the press.

| Words | Chunks | Press times per width | Stops writing 1 / 2 cells | 1-cell Stops that moved a target | Stops that sent the growing word back a line, at 160 / 240 / 320 px | Stops that moved fading segments (of which to another line), at 160 / 240 / 320 px | Words before the growing word moved | Frames to settle after Stop, max at 160 / 240 / 320 px | Springs off their targets at settle, mismatched states |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 48 | 1 character | 260 | 94 / 166 | 0 | 11 / 9 / 6 | 11 (1) / 11 (2) / 11 (0) | 0 px | 47 / 48 / 49 | 0, 0 |
| 48 | 3 characters | 86 | 35 / 51 | 0 | 5 / 5 / 1 | 47 (10) / 47 (5) / 47 (6) | 0 px | 47 / 48 / 49 | 0, 0 |
| 48 | whole words | 47 | 47 / 0 | 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 px | 45 / 46 / 46 | 0, 0 |
| 96 | 1 character | 523 | 190 / 333 | 0 | 23 / 26 / 14 | 19 (1) / 19 (2) / 19 (0) | 0 px | 47 / 48 / 49 | 0, 0 |
| 96 | 3 characters | 174 | 63 / 111 | 0 | 14 / 14 / 6 | 101 (22) / 101 (13) / 101 (13) | 0 px | 47 / 48 / 49 | 0, 0 |
| 96 | whole words | 95 | 95 / 0 | 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 px | 45 / 46 / 46 | 0, 0 |

That is 3,555 Stops. No Stop that wrote only arrivedCount moved a target, because line index and x don't read arrivedCount. Every move comes from writing the growing word's width back. The growing word goes back from the start of a line to the end of the previous one, up to 153, 229 and 310 px at 160, 240 and 320 px, e.g. "jump" back to "ju" after chunk 91 of the 48-word reply at 240 px, 210 px. A fading segment that changes line moves up to 293 px. In 1-character chunks at 320 px no fading segment changed line, and they shifted at most 10 px, the width of the letters taken off the growing word. Stops that moved no target settled within 41 frames in 1-character chunks, 44 in 3-character chunks and 46 with whole words, so the longest settles (47 to 49 frames) were Stops that moved a target. The first version of this sweep found a few Stops that wrote 1 cell and still moved a segment: a chunk that arrived in the frame that handles the Stop was written before the Stop, and widened a segment that was fading out. session.ts now drops those chunks.

### Where an arriving word starts (`report.ts spawn`)

Whole-word chunks at 240 px. The distance is from the word's spring position to its target after the first frame of its arrival.

| Words | Arriving words start | Arriving words | Words that start a line | Distance, words on the same line (mean / max) | Distance, words that start a line (mean / max) | Frames to settle after the last chunk |
| --- | --- | --- | --- | --- | --- | --- |
| 48 | at their place | 48 | 8 | 0 / 0 px | 0 / 0 px | 33 |
| 48 | from the previous word | 48 | 8 | 4.7 / 4.8 px | 211.3 / 226.7 px | 43 |
| 96 | at their place | 96 | 18 | 0 / 0 px | 0 / 0 px | 35 |
| 96 | from the previous word | 96 | 18 | 4.7 / 4.8 px | 205.8 / 226.7 px | 43 |

### Generated JS

`generated.ts` runs codegen's generator, copied with one change: each gather compute is a loop over a table of bit positions, instead of one expression with a term per bit, which folds in the same order. Every output of generated JS equals the executor's, bit for bit (`stream-springs.test.ts`). A generated function runs once per evaluation, so JavaScriptCore optimizes it only after thousands of evaluations. The µs below are medians after that many seconds of continuous evaluation, from `check-generated-warmup.ts` in this prototype's phase 3 scratchpad folder.

| Circuit | Live ops | Rows per function | Functions | Executor µs | Generated JS µs after 1 / 4 / 8 / 12 s |
| --- | --- | --- | --- | --- | --- |
| 48-word reply + bubble + springs | 18,522 | 128 | 145 | 105 | 85 / 25 / 23 / 22 |
| 96-word reply + bubble + springs | 47,458 | 64 | 742 | 268 | 775 / 194 / 196 / 98 |
| 96-word reply + bubble + springs | 47,458 | 32 | 1,484 | 262 | 569 / 256 / 203 / 110 |
| 96-word conversation, 8 turns + springs | 63,791 | 64 | 1,001 | 341 | 1,130 / 285 / 275 / 344 |
| 96-word conversation, 8 turns + springs | 63,791 | 32 | 2,001 | 351 | 1,100 / 313 / 337 / 274 |

`report.ts sizes` also generates JS, with 128 rows per function, warming until the median improves by less than 5%. I have three runs of it: the one the table above comes from, one by a verifying agent while other jobs ran, and one more. At 95 segments generated JS was faster than the executor in all three runs: 10 to 19 µs for the layout alone against 54 to 98 µs on the executor, and 21 to 119 µs for the reply with springs against 115 to 182 µs. At 184 and 191 segments with 128 rows the generated code was slower than the executor in every run, and its timings aren't stable: the reply with springs took 690, 11,400 and 11,800 µs in the three runs (executor 307 to 515 µs), and the 8-turn conversation with springs 11,600, 11,300 and 6,190 µs (executor 441 to 780 µs). For wide circuits the row budget matters as much as the warmup.

## What this shows about how far the approach goes

### What fit well

- **The capacity is an upper bound, not the content.** Absent words are zero-width segments, and the walker needed no change for arrived words to be exact at every state. Only outputs about the whole text read the arrived count, and those masks cost about 5 operations per line slot.
- **Counting beats reading at an index here.** The line count as a count of slots whose start comes before arrivedCount needs no runtime change, is 150 to 300 operations smaller than the one-hot read, and within 85 operations of index-read's instruction. Relus of arrivedCount shared between neighbors give every segment's presence bit, at about 2 operations per segment.
- **Greedy line breaking never looks ahead.** With a Stop tried at every press time of every reply stream, no word before the growing word ever moved, and whole-word streams never moved a visible word to another line in 864 states. Streaming only reflows the word that is still growing, and a Stop only moves that word and the segments after it.
- **Stopping is writing a count back.** Fading out is the fade-in spring with a presence bit of 0, and the bubbles, line count and overflow outputs follow the presence bits in the same evaluation.
- **A turn is a constant per word.** The forced break is one term in the prefix sums, and the rest of the walker doesn't know turns exist. Bubbles, line counts per turn and turn placement are reductions over words, and the words of a right-aligned turn read their turn's own reduction.
- **Springs per word stay exact.** Positions drift at most 6.8e-5 px over a stream, and the settle snap lands exactly on the targets and on opacity 0.
- **Recognition of relu one-hots removes what streaming can't.** Compiled by the index-read runtime with its defaults, the 96-word reply with springs loses 12% of its operations and 21% of its layers, with identical outputs.

### What got awkward

- **The line walk costs what it cost in text-walker.** Line slots are 26% to 34% of the circuit and per-segment x from every slot is 15% to 24%, and depth grows by about 8 to 9 layers per line slot: 135 layers for 15 slots and 249 for 29. Streaming doesn't make any of this cheaper, because the cost follows the capacity and the slot count, not the arrived words.
- **A bubble as a reduction over words costs segments times turns.** Every segment multiplies its right edge and its line-start bit by its membership in every turn, and every turn runs a tournament over all segments. With 8 turns at 184 segments, presence, turn one-hots, bubbles and word targets are 12,562 operations (20% of the circuit), where one turn at 191 segments needs 1,725.
- **Reductions add depth to word targets.** A right-aligned word's target reads its turn's width, so a tournament sits between the walker and the springs. Adding the bubble and the word targets to the 48-word reply's layout takes it from 135 to 154 layers.
- **A Stop inside a word writes two cells, and can move that word.** The growing word's width at the press is a measurement that JS has and the circuit doesn't. Writing it back shortens the word, so segments shown after the press shift while they fade, and a word that had moved to the next line between the press and the click goes back to the previous line, up to 310 px away at 320 px. For the 48-word reply at 240 px, the growing word went back a line at 9 of 260 press times in 1-character chunks and 5 of 86 in 3-character chunks. That is the word the reader is looking at, and it also loses the letters that arrived after the press.
- **Springs on every segment.** Because a segment's kind is a runtime bit, spaces have springs they don't need: about 90 operations per segment, 47% of the 48-word reply with springs.
- **The visibility gate reads continuous state.** The bit is exact, but which side it lands on for an opacity within 1/4096 of 1/64 depends on FP32 rounding. That only decides where an invisible word starts, so it can't be seen, but it is a decision on drifting state.
- **Bounds chosen at build time.** The window must cover the longest line at the widest width, the line slots the narrowest width, and the turn capacity the conversation. The overflow outputs report these for arrived segments only: a departing word past the last line slot after a Stop can be placed wrong while it fades, and nothing reports that.
- **Recognition needed a small change in the construction.** text-walker's one-hot wrote its ends as the index wire itself instead of as relus, and index-read's recognizer declined every group. Writing the ends as relus cost 2 operations per group and made every slot's group resolve.
- **Generated JS for wide circuits.** For the 48-word reply with springs, generated JS is about 4 times faster than the executor after 4 seconds of evaluation (25 µs against 105 µs). The 96-word reply needs 12 seconds and functions of 64 rows to be 2.7 times faster, and the 8-turn conversation was at most 1.3 times faster after 12 seconds. With 128 rows per function the wide circuits were 2 to 33 times slower than the executor in three runs of `report.ts sizes`, and the timing of the same circuit changed by up to 17 times between runs. codegen measured the same pattern for the gallery. Writing gather computes as loops shrank the generated source by about 8%, but didn't remove the need for warmup.

### What stayed outside the circuit

- Segmentation and measurement: pretext's prepare on the growing turn's prefix, about 26 to 91 µs per chunk headlessly, which here also walks the reference lines.
- The chunk log with timestamps, and the state at the press: which chunks had arrived by then, and the growing word's width at that moment.
- Each segment's text in the DOM, written only when it changes, and the Stop button's pointer timestamps.
- Choosing the capacity, window, line slots and turn capacity from the texts when the circuit is built.

## How it connects to the talk

The talk asks what the unit of a chat UI is, answers "a bubble", and then makes the unit smaller: half a bubble, chunks of words, so every word is interruptible. Here, in plain terms:

- **A smaller unit.** The unit is a segment, a word or a chunk of a word, with a width, a break-after bit and a turn-start bit. There is no message object and no bubble component.
- **The granularity gap.** An author doesn't append a message or create a bubble. They write per-word cells and a count, and read bubbles out: a bubble's width is a maximum over words, and its line count is a sum over words. That is less direct. For example, "put this bubble on the right" becomes "the words of turn r read an offset computed from turn r's own maximum".
- **Emergent behavior.** Reflow becomes motion: a word that grows past the end of a line springs to the next line. Interrupting at any chunk is writing back a count, plus the growing word's width when the press fell inside a word. Nothing before the growing word moves. Later words fade out, and when the Stop shortens the growing word, it and the words after it move back. A right-aligned bubble grows toward the left, and its words slide with it.
- **Directing it through homogeneity.** Every word runs the same program: a presence bit, a visibility gate, and three springs against one shared frame matrix. A handful of shared values direct all of the words at once: stiffness and damping, maxWidth, arrivedCount and the settle thresholds.

## Open questions and next steps

- **One program per segment.** Presence, the visibility gate, springs and targets are the same program for every segment. Run as instances (codegen's instance axis, or the instanced-items consolidation prototype), the capacity would become a buffer length, and only the walker and the bubble reductions would span segments.
- **Cheaper bubbles.** A prefix maximum that resets at turn starts costs a fixed number of operations per segment whatever the turn count, and each turn would then read its maximum at its last present segment. A reduction over line slots is cheaper still, but slot widths include departing words after a Stop, so it would need its own presence mask.
- **Line changes of the growing word.** Holding a chunk back until its word is complete, or measuring the word ahead when a tokenizer sends word pieces, would remove the remaining line changes at the cost of some latency. How much latency would a reader notice?
- **Which Stop.** Stopping at the press shortens the growing word, and that moves the word and the segments after it. A Stop that kept the growing word as it was shown at the click would write only arrivedCount, and in the sweep no Stop that wrote only arrivedCount moved a target. The cost is keeping the letters of that word that arrived after the press. Which one reads better, a word that jumps back or a reply that ends a few letters after the press?
- **Event-time evaluation.** Committing chunk arrivals and the Stop at their own timestamps, like spring-bank's event-time evaluations, would make the state at the press a replay, instead of JS restoring cells.
- **Longer conversations.** A sliding window over the capacity would evict early turns by shifting cells, which changes every segment's index and so every spring's cells.
- **Real fonts.** The demo compares with a 0.01 px tolerance on x and bubble widths, and exact line indices. How often do line breaks differ with real Georgia widths near a threshold?
- **Generated code for the index-read runtime.** Generated JS doesn't know index reads or gathers resolved from an index wire yet, so the smallest circuits here only ran on the executor.

## Browser check

2026-09-13, Chrome, in a hidden tab with a 1,160 by 853 CSS px viewport, served with `bun lab/ui-exploration/streaming-words/demo.html`. The hidden tab didn't render frames on its own, so a console script replaced `requestAnimationFrame` with a Worker timer every 16 ms, and frame pacing wasn't the browser's own.

- Loads, no console errors. The demo's circuit, with 194 segments over 4 turns and words that fade in at their place, is 46,599 live operations, 205 layers and 98,642 stored weights, compiled in 1,443 ms. The circuit for words that slide out of the previous word is 48,530 live operations, 207 layers and 102,117 stored weights, compiled in 4,463 ms.
- Checked: Restart, streaming in 3-character and 1-character chunks, a real Stop click inside "arriving" in the last reply, a real drag of the width slider to 240 px, a width of 480 px, and "slide out of the previous word" to the end. The chunk and spawn selectors and the 480 px width were set by script.
- Counters after all of that: 886 states checked against pretext, 0 mismatched states, 10 line changes of visible words. The median evaluation was 8,000 µs on the first frame, then 1,700 to 2,100 µs.
- The Stop wrote 2 cells and kept 186 of 194 segments, as described above for a Stop inside a word. "Words fading out after the last Stop" was 0, since a real click follows its press within milliseconds and no chunk arrived in between.
- Fixed in `demo.ts`: once the words settled, the page stopped requesting frames, while the session kept the time its springs had been stepped to. So the first frame after an input stepped the springs through the whole idle time, up to 255 steps (1,020 ms), and words jumped to their new places in one frame, e.g. after a width change the word "I" went from (203.2, 319) to (503.2, 199) in 1 frame. When an input starts a new render loop, `demo.ts` now moves `session.animatedUntil` forward to the input's time, since the springs were at rest. After the fix, a width change 2 s after the words settled moved "I" from (353.2, 247) to (228.2, 295) over 51 frames.
- Fixed in `demo.ts`: the panel only refreshed on every 10th frame, so after a change that settled within a few frames, the width label and the stats stayed stale, e.g. the label said 360px with the slider at 240. The panel now also refreshes on the frame that ends a render loop.
- 10 tests and tsgo pass. `session.ts`, `chat-demo.ts` and the tests didn't change.
- GIF: `~/Downloads/ui-exploration-streaming-words-demo.gif` (the recorder kept 5 frames).

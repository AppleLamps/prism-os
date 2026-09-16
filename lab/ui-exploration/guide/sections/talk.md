# The talk-inspired prototypes, explained plainly

Cheng's talk "Repeatable breakthrough" describes a pattern that repeats across physics, computer graphics and machine learning, in three steps. First, take the unit you compose things with and ask what smaller units it's made of, e.g. graphics tried sprites, voxels and solid shapes, and settled on many tiny triangles. Second, accept that the smaller unit doesn't look like anything you recognize, e.g. a sphere made of pointy triangles sounds wrong. Third, once there are enough of the small units, new behavior appears that you can direct, e.g. with enough triangles the sphere looks smooth.

The talk pairs the third step with homogeneity. When the small units are all alike, one uniform command can direct all of them, e.g. one fragment shader is a single function that runs for every pixel on screen, and one training objective directs every number of a neural network.

The talk also warns about premature compression: treating something as one indivisible unit because its smaller parts seem inefficient or incomprehensible, e.g. "there's no way this desk isn't a single continuous piece of matter".

After the first two rounds of prototypes, three agents read the talk and looked at those prototypes through one of its ideas each: a smaller unit of composition, homogeneity allowing one uniform way of directing a UI, and premature compression. Their notes are [talk-smaller-unit.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/talk-smaller-unit.md), [talk-uniform-direction.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/talk-uniform-direction.md) and [talk-premature-compression.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/talk-premature-compression.md). Nine prototypes came out of those notes. Two more ran at the same time as consolidation checks: indirect-os-2, which isn't from the talk, and instanced-items, which carries out one of the notes' ideas, writing the per-photo program once. This section explains all eleven.

Each prototype gets the same parts: the idea from the talk in one sentence, the UI problem in familiar front-end terms, what was built, what it showed with a few numbers and their conditions, how its cost grows where that matters, what to try in its demo or how to run it, and its main limitation. The prototypes are grouped by the talk idea each one tests most directly, which isn't always the note that proposed it.

## Terms used in this section

These terms come up in several prototypes. The [glossary](../README.md#glossary) has more, and other sections explain most of them at length, e.g. [the model](model.md), [springs](springs.md), [instancing](instancing.md) and [indexing](indexing.md).

- **`[condition]`**: 1 when the condition holds and 0 otherwise, like `condition ? 1 : 0` in JavaScript, e.g. `[arrivedCount >= segmentIndex + 1]` is 1 for every segment that has arrived.
- **Source table** and **cell**: the source table is the `Float32Array` that JavaScript writes inputs into and that holds the UI's state between frames, and a cell is one number at a fixed position in that table, e.g. the pointer's x, or a window's left edge.
- **Evaluation**: one run of the compiled program over the source table, usually once per frame. After an evaluation, JavaScript copies the next-state outputs back into the table.
- **Live operations**: the operations a compiled program keeps and runs on every evaluation, i.e. its total work, e.g. IndirectOS is 3,654 live operations, and was 5,253 before September 15, 2026.
- **Layers**: groups of operations that don't read each other, so the number of layers is the longest chain of operations that must run one after another, e.g. IndirectOS is 124 layers deep, and was 192 before September 15, 2026.
- **Stored weights**: the nonzero coefficients the compiled program keeps, which measure memory and the work inside sums.
- **Executor** and **generated JS**: the executor runs the compiled layers as sparse matrix multiplications, and generated JS is plain JavaScript that the codegen prototype emits from the same program, with the same bits, e.g. before September 15, 2026, IndirectOS took about 30 to 40 µs on the executor and about 3 µs as generated JS once the engine had optimized it.
- **FP32**: the 32-bit float format of `Float32Array`. The runtime rounds to FP32 after every addition and product, like `Math.fround`.
- **Boolean atom**: the operation that rounds a score between 0 and 1 to exactly 0 or 1, by adding and subtracting 8,388,609 in FP32.
- **One-hot**: a list of bits in which exactly one bit is 1, e.g. `[0, 0, 1, 0]` names index 2. Reading `table[index]` without an index read instruction means building the index's one-hot, which costs O(n) operations for an n-entry table.
- **Index read instruction**: an extra instruction, `circuit.indexRead(index, table)`, that reads `table[floor(index)]` as 1 operation without building a one-hot. index-read first built the instruction in its copy of the runtime, the prototypes below that use it ran on copies of the runtime, and numeric-ui-core.ts has had it since September 14, 2026.
- **Instances**: running one compiled program over many copies of some of its input cells, like a shader running once per pixel, e.g. the window circuit run once per simulated user, with each user's own state in its own cells.
- **Reference**: an independent plain JavaScript implementation that a circuit is compared with, and that never imports circuit code.
- **WGSL**, **wgpu**, **Dawn** and the **max guard**: WGSL is WebGPU's shading language, wgpu and Dawn are two WebGPU implementations (Firefox and Deno use wgpu, Chrome uses Dawn), and the max guard wraps a value in `max(x, lowest)`, with `lowest` read from a buffer, so a shader compiler can't simplify the boolean atom's `(x + 8388609) - 8388609` back to `x`.

## Overview

| Prototype | Idea from the talk | UI problem | Demo |
| --- | --- | --- | --- |
| [streaming-words](../../streaming-words/README.md) | the word instead of the chat bubble | a chatbot reply that streams in, with a Stop button | yes |
| [event-time](../../event-time/README.md) | the event and the 4 ms animation step instead of the frame | stored state that depends on the frame rate, and animations that freeze while JavaScript blocks | yes |
| [pixel-output](../../pixel-output/README.md) | one small program behind every pixel | a comment thread that recycles DOM elements and lays its text out twice | yes |
| [code-points](../../code-points/README.md) | tokenizers go away | line breaking for Chinese, Japanese and Korean in a text field | yes |
| [learned-bits](../../learned-bits/README.md) | logic gates whose wiring is learned | learning rules like Tab focus from examples | no |
| [user-population](../../user-population/README.md) | a simulated city of agents | choosing the drag threshold and the double-click numbers | no |
| [drag-knobs](../../drag-knobs/README.md) | one command directs every unit | dragging an edge to tune padding, gaps and widths | yes |
| [instanced-items](../../instanced-items/README.md) | one program per item, like a shader per pixel | a photo gallery at 221 to 10,000 photos | yes |
| [exactness-budget](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/exactness-budget) | premature compression of "every value is exact" | whether GPUs and parallel adders change a UI's decisions | no |
| [retiming](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/retiming) | premature compression of "one frame" | long dependency chains, and reading last frame's values | no |
| [indirect-os-2](../../indirect-os-2/README.md) | not from the talk: a consolidation check | do the earlier improvements add up in one IndirectOS? | yes |

## Running the demos

Run every command below from the repo root. `bun lab/ui-exploration/serve-demos.ts` serves every demo from one server, with an index page at http://127.0.0.1:4321/, and each page sits at its path in the repo, e.g. http://127.0.0.1:4321/lab/ui-exploration/streaming-words/demo.html. `bun lab/ui-exploration/streaming-words/demo.html` serves one page on its own.

The browser checks quoted below ran in a hidden Chrome tab with `requestAnimationFrame` replaced by a timer, so those checks give no information about real frame pacing, window resizes or how motion looks. [notes/browser-check.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/browser-check.md) records what each check found.

## A smaller unit of composition

### streaming-words: the word instead of the chat bubble

**The idea from the talk.** A smaller unit of composition for a chat UI: the word, or a chunk of a word, instead of the chat bubble, so that every word can be interrupted.

**The UI problem.** A chatbot reply arrives a few characters at a time. The familiar way appends each chunk to the last message and lets the browser lay the message out again, e.g. `messages[messages.length - 1].text += chunk`. The bubble grows, a word that no longer fits jumps to the next line, and Stop cancels the request. The talk asks what changes when the unit is smaller: "Half a bubble? Instead of a few sentences in the bubble, it's just chunks of words."

**What was built.** The circuit is built once for a fixed capacity, i.e. a maximum number of segments, where a segment is one word or one space, the way pretext splits text. For each chunk, JavaScript measures the reply so far with pretext and writes two kinds of cells: the width of every segment that changed, and `arrivedCount`, the number of segments that have arrived.

The layout is the line walker from the text-walker prototype, which is pretext's greedy line breaking written as arithmetic: a line ends at the last segment whose running total of widths still fits the line width. The walker has a fixed number of line slots, where a line slot is the group of outputs reserved for one line of text, e.g. the segment that starts the line. A segment that hasn't arrived has width 0, and a zero-width segment always fits at the end of the last line, so unused capacity never moves an arrived word. Only outputs that describe the whole text, e.g. the line count, read `arrivedCount`.

There is no bubble component. A bubble is computed from its words: its width is the maximum right edge over its turn's words, and its line count is a sum over its words of "this word starts a line" bits. A conversation is a list of turns, e.g. user, assistant, user, and JavaScript writes a turn-start bit on the first segment of each turn. The walker adds 4,096 px into the running totals at each turn start, so no line can reach past the start of a turn.

Every segment has three springs, for x, y and opacity, and every spring is stepped by one matrix they all share. A new word fades in at its place. Pressing Stop writes `arrivedCount` back to its value at the moment of the press, which is 1 cell. When the press fell in the middle of a word, e.g. "qu" at the press and "quick" by the time the click was handled, Stop also writes that word's width at the press, so 2 cells in all. Segments that arrived after the press fade out through the same opacity springs, because their presence bits, `[arrivedCount >= segmentIndex + 1]`, become 0.

**What it showed.**

- Every arrived word landed exactly where pretext puts it. Over 7,419 streamed states (48- and 96-word replies and 4- and 8-turn conversations, in 1-character, 3-character and whole-word chunks, at 160, 240 and 320 px), every arrived word's line and x, the line count and every bubble matched pretext, using a fake canvas whose widths are multiples of 1/4 px.
- Only the word that is still growing ever changes line, because in greedy line breaking, where a word is placed depends only on that word and the segments before it. Whole-word streams never moved a visible word to another line. In 1-character chunks, 12 to 33 of every 1,000 chunks moved the growing word to the next line.
- A Stop was tried at every press time of every reply, 3,555 Stops in all. No word before the growing word ever moved, and every spring settled exactly on its target within 49 frames.
- A 48-word reply with its bubble and springs is 18,522 live operations and 169 layers, about 115 µs per evaluation on the executor, and 25 µs with generated JS after 4 s of continuous evaluation.

**How cost grows.** The cost grows with the capacity and the number of line slots, not with the text that has arrived. For n segments and L line slots, each segment's x is read from every line slot, so the line walk is O(n × L) operations, and its depth grows by about 8 to 9 layers per line slot, e.g. 135 layers for 15 line slots and 249 for 29. Bubbles cost about 8.5 to 10 operations per segment per turn, so O(n × turns). Springs cost about 90 operations per segment, and spaces get springs too, although spaces don't need them.

**What to try in the demo.** Open `lab/ui-exploration/streaming-words/demo.html`. The page is a conversation: the user's messages arrive whole on the right, and the replies stream on the left.

- Press Stop while a word is still arriving. The letters that arrived after the press disappear, and the words after them fade out.
- Switch "Chunks" between "1 character", "3 characters" and "whole words", and watch the "Line changes of visible words" counter. Whole words never add to that counter.
- Switch "Arriving words" to "slide out of the previous word". A word that starts a new line then travels about 210 px from the end of the previous line, right where the reader is looking, which is why "fade in at their place" is the default.
- Drag "Bubble text width" during a stream. "States checked against pretext" and "Mismatched states" compare the circuit with pretext live. The browser check counted 886 states and 0 mismatches.

**Main limitation.** Everything is sized when the circuit is built: the capacity, the number of line slots, how many segments one line may hold, and the number of turns. Streaming doesn't make the line walk cheaper, and a reply longer than the capacity needs a new circuit. A Stop in the middle of a word also shortens that word back to what had arrived at the press. So when the growing word had moved to the next line between the pointer press on Stop and the moment JavaScript handled the click, the Stop sends the word back to the previous line, e.g. at 9 of 260 press times for the 48-word reply in 1-character chunks at 240 px.

### event-time: the event and the 4 ms step instead of the frame

**The idea from the talk.** A smaller unit of time: instead of one frame both changing state and showing the screen, the event is the only thing that changes state, and a fixed 4 ms animation step is the only thing the screen shows.

**The UI problem.** In vibescript's render loop (ui.md), one `render(now)` handles the frame's inputs, steps animations up to `now`, commits state and writes the DOM. So when state gets written back depends on when frames happen, and the same session replayed at 10 fps and at 120 fps can store slightly different bits, e.g. an animation that settles one frame earlier at one rate. And while JavaScript blocks the main thread for 500 ms, nothing on screen moves.

**What was built.** Two ways of running the same IndirectOS circuit, spring-bank's copy, whose springs take fixed 4 ms steps. A commit runs at each distinct event timestamp: it applies the events and writes the next state back into the source table. A display runs at a frame's timestamp on a copy of the last committed table, with the time since that commit, and throws its next state away. When an animation is still moving after the last event, JavaScript also runs a settle commit at the simulated time of the first checked step where nothing moves (every 16th step is checked, i.e. every 64 ms), so the settled state gets written without depending on when frames happen.

A familiar picture is an event log. The stored state only changes by applying events at their own timestamps, and the screen is `view(committedState, now)`, which never changes anything.

The prototype then evaluates many future moments at once, as instances of one program. From one commit, the screen i × 4 ms later differs only in the spring step matrix raised to the power i, which sits in 4 cells. So all 301 samples up to the 300-step cap (1.2 s) are one run of one program over 301 instances, where instance i holds the matrix to the power i. JavaScript turns the samples into Web Animations keyframes.

Chrome can keep playing an animation on its compositor thread while JavaScript is blocked, but only when every property in that animation can be composited, which is true for transform and opacity and false for width, height and z-index. So each element gets one animation for transform and opacity, and a separate one for the other properties.

**What it showed.**

- Frame-rate independence became bit identity. Over 6 traces of IndirectOS sessions and 4 variants, the committed tables at 10, 30, 60 and 120 fps, and through 500 ms and 2 s stalls, were identical in every bit to the 240 fps run (168 comparisons), and so was every displayed output at shared timestamps. For contrast, the earlier model, where every frame writes back and JavaScript adds an evaluation at each event timestamp, stayed within 0.0093 px, but its stored tables differed in some bit in 15% to 18% of shared frames.
- Idle costs nothing. There is one commit per distinct event timestamp, plus a settle commit when an animation outlives the last event, e.g. 76 commits in 11 s for a trace with 71 distinct event timestamps. A commit costs what a frame did, about 8 to 23 µs with generated JS.
- The 301 samples from one commit took 0.36 to 1.21 ms as one instanced run, bit-identical to 301 separate displays. The instanced run is only 1.2 to 2 times faster than 301 separate generated-JS displays, because 2,007 of the display program's 3,360 operations depend on the step matrix and run once per sample.
- In a model of how browsers play the emitted keyframes, not checked in a visible browser tab, transform and opacity kept playing exactly through a 500 ms stall when no event arrived during the stall, while size changes were delayed until the main thread was free, e.g. Photos' size was up to 688 px off while its restore motion kept playing.

**How cost grows.** Commits grow with the number of distinct event timestamps, displays with the number of frames while something moves, and one prediction costs its shared operations once plus 301 times the operations that depend on the step matrix.

**What to try in the demo.** Open `lab/ui-exploration/event-time/demo.html`. In the bar at the top of the desktop, choose the presenter: "predicted keyframes", the default, or "display frames", which draws display evaluations in requestAnimationFrame (the same as `?presenter=frames`). Press "stall 500 ms once the next animation starts", then maximize or restore Photos. With predicted keyframes, window motion and fades should keep playing through the blocked main thread while size changes are delayed. With display frames, everything freezes. The browser check confirmed that both stall buttons block the main thread for about 500 ms, but whether transforms kept playing couldn't be checked, because the check ran in a hidden tab.

**Main limitation.** JavaScript now runs a schedule: when to commit, timers for settle commits, running due settle commits before a display, and undoing settle commits when an event with an earlier timestamp arrives after them. Events that arrive during a stall are still handled only once the main thread is free. A value read "from last frame" now comes from the last commit, which can be hundreds of milliseconds old, e.g. Photos laying itself out from last state's window size was 507 px off during the maximize, against 35.7 px when every frame writes back at 240 fps. A live resize also created about 181,000 keyframe objects in 11 s.

**Since then.** Since September 14, 2026, host-timing.ts's `advanceFrame` applies the same rule in the repo root when `writeBack` is `'events and settle checks'`: only evaluations at events, settle checks and snaps write state back, and each frame evaluates a copy of the table ([execution-model.md](../../../../execution-model.md#which-evaluations-write-state-back)).

### pixel-output: the pixel instead of the DOM element

**The idea from the talk.** Ken Perlin's "one supercomputer behind every pixel": draw the UI with one small program that runs for every pixel, instead of routing content into DOM elements.

**The UI problem.** The hn-thread prototype rebuilt the thread from Cheng's nicer-hacker-news (hn.js) as a circuit: 251 nested comments, a sticky user banner per comment, a gutter line per indent level, collapsing a comment by clicking its banner, and a peek, where holding a press on a gutter line shrinks the comments between the ancestor that the gutter belongs to and the pressed comment.

To show only what's in view, hn-thread routes the visible comments into 48 DOM slots, i.e. 48 reusable comment elements, each showing whichever comment the circuit assigns to it, like a virtualized list that recycles elements. The router cost 25,616 of the circuit's 53,703 live operations. The DOM then lays each comment's text out a second time from `innerHTML`, and that second layout can be a line off from pretext's.

**What was built.** The thread circuit without the router, plus two source cells, `pixelX` and `pixelY`. A per-pixel program reads the thread's per-comment outputs, e.g. comment tops, banner rectangles, gutter extents, and emphasis and collapse bits, and outputs one pixel's color, its paint layer, which comment it belongs to, and whether it's emphasized. codegen's `planInstances` split the program automatically: every operation that doesn't read the two pixel cells runs once per frame, and the rest runs once per pixel, on the CPU as generated JS or on the GPU as a WGSL shader. The split is the one a shader makes between uniforms and per-pixel values.

Finding the comment under a pixel was built two ways. The count version compares the pixel's y with every comment's top and counts, like `commentTops.filter(top => top <= pixelY).length - 1`, which is O(n) operations per pixel for n comments. The binary search version halves the range 8 times over 252 comment tops with the index read instruction, like a JavaScript binary search, which is O(log n) operations and layers per pixel.

Text is pretext's real lines. Per pixel, one binary search finds the line within the comment, another finds the character within the line, and one index read gets the pixel's bit from a glyph atlas, i.e. a table of glyph bitmaps rendered once. Pretext's lines add up to the same heights the thread circuit computes, so there's no second text layout.

**What it showed.**

- The router's 25,616 operations and 134,366 stored weights disappeared. The thread logic that the pixels need is 23,315 operations, run once per frame.
- The binary search stayed at 314 operations per pixel from 120 to 251 comments, while the count version grew by about 5 operations per comment, to 1,615. Per-pixel glyph text is 455 operations and 148 layers, since each probe of a search reads the result of the probe before it.
- At 1280×800 through wgpu with the max guard, 0 of 6,144,000 outputs differed from the CPU, and no layer, comment or emphasis decision differed from an independent float64 rasterizer that paints rectangles in order, at 16 to 20 ms per frame for the binary-search programs. That time covers uploading the shared values, the dispatch, and reading back 6 outputs per pixel, about 24 MB per frame; pixel-output's README guesses that most of the time is the readback, but didn't measure the readback on its own. Without the guard, 1,245,968 of those outputs were wrong in a settled state with gray bars for text.
- In Chrome, the WebGPU fragment shader drew legible glyph text at 7.2 to 7.6 ms per frame on a scratch copy with the fix described below, of which 6.2 to 6.5 ms was the thread logic on the CPU.

**How cost grows.** Total work is pixels × per-pixel operations, plus the thread logic once per frame. Per pixel, the count version grows linearly with the comment count at constant depth, and the binary search grows with log2 of the comment count in both operations and depth.

**What to try in the demo.** Open `lab/ui-exploration/pixel-output/demo.html`. Choose "index reads, glyph text" under "Program" and "WebGPU fragment shader" under "Backend". Scroll with the wheel and watch the sticky banners, hover a gutter line to emphasize it, hold a press on a gutter line to peek, and click a banner to collapse a comment. "CPU, generated JS, every 2nd pixel" runs the same program on the CPU. "row counts and gathers, gray bars (large shader)" is the count version, whose guarded shader took 4.6 to 75 s to compile cold in headless runs, so expect a long wait.

The page first failed in Chrome with "Maximum call stack size exceeded": one generated statement nested `Math.fround` calls 1,003 deep, and V8 throws at about 665 levels, while Bun's JavaScriptCore runs the same code. The fix stores the running sum in a variable every 256 terms, which keeps every FP32 value the same. A later check of the demo directory loaded the folder's own page in Chrome: the page drew glyph text, its 507-statement fragment shader compiled in 115 ms, and a frame took 34.5 to 40.1 ms, which that check didn't compare with the scratch copy's 7.2 to 7.6 ms. Collapsing and peeking weren't tried in a browser.

**Main limitation.** Both lookups assume comment tops are sorted, and hn-thread's resize handling can make a comment's height negative, which happened in 20 of 60 random frames; then 1,728 decisions per program differed from the rasterizer's painting order. Everything text is for besides being seen, e.g. links, selection, copy and find, stays outside the program, and so do antialiasing and shadows. And the binary search needs the index read instruction. pixel-output ran it on a copy of the runtime, and numeric-ui-core.ts has had the instruction since September 14, 2026.

### code-points: Unicode's numbers instead of a vocabulary that JavaScript builds

**The idea from the talk.** "Obviously the llm tokenizer is gonna go away": text cells hold Unicode's own numbers, instead of codes that JavaScript assigns from a small vocabulary built as text arrives.

**The UI problem.** A text field that wraps lines for Chinese, Japanese and Korean text: a line may break between two ideographs, a line must not start with closing punctuation like 。 or 」, and a number like `$1,299.99` stays on one line. The earlier text-editing prototype worked like a tokenizer. JavaScript gave each new grapheme, i.e. what a person sees as one character, the next free code in a 96-entry width table, a regular expression classified the grapheme, and only spaces and newlines allowed a line break. So 2,023 of 2,460 layouts of CJK text next to Latin words broke lines differently from pretext.

**What was built.** Each text cell holds one code point, i.e. Unicode's number for one character, e.g. U+5B57 for 字. Every code point is below 2^21, so FP32 holds it exactly.

JavaScript writes tables into the source table once: a line break class for every code point (41 classes, starting from UAX #14, Unicode's line breaking algorithm, plus distinctions that pretext makes), three property bits per class (space or newline, newline, part of a word), and a 41 × 41 table of bits that says whether a line may break between one class and the class after it. JavaScript fills in a code point's advance, i.e. its width, the first time the code point appears, and a font change rewrites only those entries.

The circuit reads these tables with the index read instruction, from index-read's copy of the runtime; numeric-ui-core.ts has had the same `circuit.indexRead` since September 14, 2026. The class and advance tables have two levels: a first table maps each block of 128 code points to an offset into a second table, so blocks whose entries are all the same share one page of entries, e.g. every block of CJK ideographs. Per cell, the circuit does 8 index reads: block offset then class, block offset then advance, the three property bits, and the break bit. In JavaScript terms, the break bit is `breakAfter[i] = pairTable[classOf(codePoints[i]) * 41 + classOf(codePoints[i + 1])]`. The line walk then uses `breakAfter` where text-editing used "is a space".

**What it showed.**

- Reading class, advance, property bits and break bit costs 8 live operations per cell, all index reads, in 3 layers. text-editing's decoding was also 8 operations per cell, in 5 layers, and only had break opportunities at spaces and newlines.
- Against pretext's pre-wrap line breaking over 41,820 layouts (13 text families at 41 widths from 30 to 400 px, with fake canvas widths), mismatched line starts went from 8,806 with text-editing's rules to 418 with the pair table, and to 215 when a CJK run that doesn't fit on one line is kept whole. The CJK family went from 2,023 to 0. Of the 215 left, 176 are a hyphen before digits: pretext breaks after the hyphen in `0-93` but keeps ` -5` whole, and a table over pairs of neighboring characters gives the same result for a range and a sign.
- Every one of the 1,114,112 code points read back the right class, advance and break bit.
- A font change from 16 px to 20 px rewrote 92 advance entries and 0 text cells, where text-editing also rewrote 155 of the paragraph's 156 text cells.

**How cost grows.** The per-cell work is constant, so decoding grows linearly with the field's capacity at constant depth. The pair table grows with the square of the class count, and a rule that needs three neighbors, e.g. telling a range from a sign, would need a 41^3 = 68,921-entry table.

**What to try in the demo.** Open `lab/ui-exploration/code-points/demo.html` and type into the field. Press "Insert Chinese", "Insert Japanese", "Insert Korean" or "Insert mixed", then drag "Width" down to 160 px: no line starts with 、, 。 or 」, a line may start with 「, and `$1,299.99` stays together. Press the "Font size: 17px" button and read the panel: only advance entries are rewritten, and 0 text cells. In the browser check, a scripted input method composition committed "输入法。" as 4 code points in 1 event.

**Main limitation.** One code point per cell splits what a person sees as one character: an emoji sequence joined by zero-width joiners, a flag, or a letter with combining marks takes several cells, each with its own advance and a caret stop inside it. Kerning, shaping and bidirectional text are out of scope. The tables are 53,917 source cells, and the executor checks their ranges on every evaluation, about 49 µs of about 447 µs. The field still has 12 line slots, and past 12 lines the last line holds the rest of the text without wrapping.

### learned-bits: learned bits instead of written rules

**The idea from the talk.** "What if logic gates have learned backprops?": wire individual bits to each other, learn the wiring from examples, and apply that to UI decision rules.

**The UI problem.** Small decisions that JavaScript writes as loops and ifs. For example, Tab and Shift+Tab over controls where some are disabled move focus to "the first enabled control after the focused one, wrapping around":

```js
// focusedIndex is -1 when nothing is focused. Returns -1 when no control is enabled.
function nextFocus(enabled, focusedIndex, shift) {
  const count = enabled.length
  for (let step = 1; step <= count; step++) {
    const candidate = focusedIndex === -1
      ? (shift ? count - step : step - 1)
      : (shift ? (focusedIndex - step + count) % count : (focusedIndex + step) % count)
    if (enabled[candidate]) return candidate
  }
  return -1
}
```

The other tasks were whether a pointer given as 6-bit integer coordinates is inside a rectangle, click versus drag from 5-bit pointer deltas, and one event of a menu bar. Can a network of bits learn such a rule from examples, and then become an exact circuit?

**What was built.** Two kinds of learnable unit, compared with the same number of learned parameters. A 2-input gate reads 2 bits and learns a probability for each of the 16 functions of two bits, e.g. AND, OR and XOR, following Petersen et al., "Deep Differentiable Logic Gate Networks" (2022). A counting unit reads up to 8 bits, learns a weight in {−1, 0, +1} per bit and a threshold t from 1 to 8, and outputs `[sum of weight × bit >= t]`.

The counting form is how most exact decisions in these circuits are already written. For example, an AND over k bits is a count with t = k, and "this bit is 1 and none of those bits are" is `bit - (sum of those bits) >= 1`, which is the form of "this control is enabled, and no enabled control sits in between".

Training uses a smooth version of each unit, so that gradients exist. Hardening then keeps each unit's most likely function, or its most likely weights and threshold, which gives plain integer logic that compiles into a circuit. Every task is enumerated over every input case, e.g. all 106,496 cases of Tab over 12 controls, so "exact" means right on every case. Networks train on 60% of the cases, and the other 40% are held out, i.e. never used in training, to test whether a network found the rule or memorized the cases it was trained on. An option shares one unit's parameters across positions, so one learned unit runs at every control position, the way a shader runs at every pixel.

**What it showed.**

- No run at the base settings learned any task exactly (0 of 48 runs), and held-out cases trailed training cases, e.g. a counting network for Tab over 6 controls got 88% of its training cases right and 70% of its held-out cases.
- Counting units got more cases right than gates on 7 of 8 tasks, e.g. 78,982 to 81,292 of the 106,496 cases of Tab over 12 controls, against 3,103 to 9,754 for gates.
- One shared counting unit, with 143 parameters, learned "the first set bit among 8 bits" exactly from 60% of the cases, in 1 of 3 seeds. Tab was never learned exactly from part of its cases: the only exact network for Tab over 4 controls was trained on every case, and compiles to 133 operations, against 40 for the written counting form.
- A side result for authors: input's written Tab rule, rewritten with counting bits, went from 127 to 68 operations at 6 controls, and from 253 to 146 at 12.

**How to run it.** There's no demo. `bun test lab/ui-exploration/learned-bits` runs 11 tests in about a second, including two small training runs that must learn their task exactly.

**Main limitation.** The networks memorized cases instead of finding rules. Random wiring rarely reaches all the inputs that an output bit depends on, and comparing a number against a constant at the level of bits needs a carry chain, which no network found, where integer arithmetic tests a rectangle in 9 operations. Exact learned circuits came out bigger than written ones.

## Many copies of one program, directed one way

### user-population: a city of simulated users

**The idea from the talk.** The talk's city of 100,000 agents, where a policy is tried on a simulated population before it ships: here each agent is a simulated user, and the city is the real compiled window circuit, run once per user.

**The UI problem.** Behavior numbers are usually picked by feel: the drag slop, i.e. how far the pointer may move during a press before a click becomes a drag (4 px here), the double-click interval (500 ms) and the double-click distance (4 px). The best values differ between steady hands and shaky hands, and some interactions are easy to overlook, e.g. a cancelled first click also turns into a missed double click.

**What was built.** The input prototype's window circuit: focus and raise on press, drag with slop, a maximize button, and double click on the title bar, over a queue of up to 16 pointer events per evaluation (1,494 live operations). The three behavior numbers became source cells, so each user can have its own values without rebuilding the circuit.

The simulated users have authored hands: tremor, i.e. a random wobble with a standard deviation from 0.5 to 4 px, rounded to whole pixels; random hold durations and gaps between clicks; and a mix of clicks, double clicks, 3 to 12 px nudges and long drags. Each press aims at what that user's own copy of the UI shows.

codegen's generated instance loop runs the circuit over 1,024 users at a time. After each frame, the host copies each user's 44 next-state values back into that user's cells, so each user carries its own state across frames. In JavaScript terms: `for (const user of users) user.state = step(user.state, user.events, user.settings)`, where `step` is the shipped circuit.

After the search, a table of settings per tremor level went into the circuit itself. For each press, 3 bits record whether the pointer wandered 2, 3 or 5 px from the press point within 100 ms of the down, counters over recent presses estimate the user's tremor level, and index reads at that level give the user's slop and double-click distance from 8 table cells.

**What it showed.**

- 64 settings × 1,024 users × 600 frames is 39,321,600 user-frames, at about 1.2 µs of circuit time each on one core. 32 sampled users matched the one-event-at-a-time reference on all 1,228,800 comparisons.
- At the highest tremor level (2.38 to 4 px), the authored setting of 4 px, 500 ms and 4 px cancelled 76% of clicks and missed 97% of double clicks. The best slop per tremor level was 3, 4, 7 and 10 px.
- The tremor estimate added 522 operations and no layers. After 5 s of use, the sum of four mistake rates (cancelled clicks, lost nudges, missed double clicks, accidental double clicks) went from 56.05% for the best single setting to 36.46%, against 34.79% for a table indexed by each user's true tremor level.
- A realistic population is a poor test generator. 72.6% of user-frames carried no event, and only 4 of 39 million carried 2 presses, so a steady 60 fps population exposed 2 of 10 planted single-operation corruptions, where input's random traces exposed 8.

**How cost grows.** Work is users × frames × the circuit's operations, and the program's size doesn't depend on the population.

**How to run it.** There's no demo. `bun test lab/ui-exploration/user-population` runs 12 tests in about 2 seconds, and `bun lab/ui-exploration/user-population/report.ts --quick` runs a short version of every table.

**Main limitation.** The hands are authored. Every rate describes what this behavior does to these synthetic hands, and no observation of people backs any number. The objective, equal weights on four mistake rates, is a judgment call too.

### drag-knobs: dragging an edge moves the design numbers

**The idea from the talk.** Homogeneity allows one uniform way of directing: because every widget is made of the same three operations, "move this edge to here" can be one backward pass through the whole program, the way one loss steers every weight of a neural network.

**The UI problem.** A designer tunes padding, gaps and widths by editing constants and reloading. Could the designer drag a card's edge on screen instead, and have the design numbers change so the edge lands there, without anyone writing inverse code for each widget?

**What was built.** layout-tree's app shell: a header, a sidebar whose width comes from a spring, and a scrolling main column with a row of tags and two sections of card grids, where each card has a thumbnail, a title and a caption. Five design numbers moved from constants into source cells: card padding, the grid gap, the minimum card width, the sidebar's open width, and a scale for card title fonts.

When the designer drags an edge, the host computes how much the edge moves per unit of each unlocked design number by backpropagation, i.e. the chain rule run backward through the compiled operations. The host then takes the smallest change of those numbers that would move the edge by the requested distance if the layout were linear, for up to 3 steps.

Layout decisions, e.g. a grid's column count, are exact bits whose slope is 0, so no gradient passes through them. When the edge stays more than 0.5 px from the target, or a step makes content overflow, the host evaluates 256 candidate settings as instances of the same circuit and keeps the closest one that adds no overflow.

Flip queries use each decision's difference value to compute what change flips the decision. A grid shows at least c columns when `innerWidth + 1/64 - (c × minCardWidth + (c - 1) × gap)` is at least 0, so one backward pass on that difference gives sentences like "the grid drops to 3 columns if minCardWidth reaches 248 px".

The backward pass treated exact bits two ways: straight-through, which passes a bit's gradient to its score as if the rounding had slope 1 (the runtime's option), and frozen, which passes nothing through.

**What it showed.**

- Moving all five design numbers into cells cost 60 live operations (2.1% of the app shell) and 1 layer. Padding, gap and the widths cost 0 to 2 operations each, because the sums that used those numbers already existed and only gained a weight.
- Over 500 scripted drags (3,000 frames), one gradient step solved 63.6% of moving frames, and 82.5% when every design number was unlocked. 24.6% of moving frames had nothing to move, i.e. every unlocked number had gradient 0, e.g. the right edge of a card in the last column, which only the viewport width moves.
- Flip queries on linear decisions are exact: 303 of 303 in-range predictions of a grid's column count held.
- With straight-through bits, the backward pass reports slopes that aren't there. On candidate-gallery.ts, a repo-root demo that scores three candidate layouts and shows the best one, the comparison score keeps a slope of 0.5 instead of flattening away from its threshold. There, 592 of 2,250 straight-through gradients differed from finite differences, i.e. the slope measured by nudging a number and evaluating again, while no decision flipped. Frozen bits, with nothing else changed, took one-step solves on candidate-gallery from 16.5% to 37.6% of moving frames.

**How cost grows.** One backward pass costs about what a forward pass does, e.g. 10 µs against 16 µs for the generated forward pass, and a search costs candidates × circuit, e.g. 256 candidates in about 0.5 ms.

**What to try in the demo.** Open `lab/ui-exploration/drag-knobs/demo.html` and drag the left, right or bottom edge of any card. The checkbox next to each design number says whether that number may move, and the panel shows the values, how the last frame was solved, and flip sentences about the dragged card's grid and title. Uncheck gap and sidebarOpenWidth, then widen a card: no remaining number changes a card's width while the column count stays the same, so the panel reports 0 gradient steps until a search drops the grid to fewer columns. In the browser check, a real drag of a card's right edge 80 px to the left changed the grid from 3 to 4 columns through search.

**Main limitation.** Many drags request an edge position that no unlocked number can reach, and without paying for a search, the solver's output doesn't distinguish "blocked by a decision" from "unreachable". Decisions flip far from the dragged edge: only 48 of 1,073 line-count flips were in the dragged card, and the rest were captions rewrapping in cards nobody touched, because padding and gap apply to every card. And the backward pass is an interpreter over operations, not a compiled program, so it can't run over the 256 candidates at once.

### instanced-items: one program per item, like a shader per pixel

**The idea from the talk.** Homogeneity, as in shaders: write one small program per item and run it for every item, with a few computations across items between those runs, so the item count is an array length instead of part of the program.

**The UI problem.** chenglou.github.io's photo gallery (index.ts) is a grid of 221 photos whose column count, from 1 to 7, depends on the window width. Clicking a photo opens it in a horizontal strip, ArrowLeft and ArrowRight move through the strip, and Escape returns to the grid. The earlier gallery prototype wrote each photo's operations out once per photo into one circuit, 48,411 live operations at 221 photos, and that form doesn't scale to 10,000 photos.

**What was built.** A staged builder on top of `Circuit`, with three kinds of steps:

- A shared stage runs once per frame, e.g. the clock and the column count.
- A map stage is an ordinary circuit written once over one item's fields, and runs for every item, e.g. a photo's size, its hit test and its springs.
- A reduction is a computation across items between stages, e.g. `groupMax` for each row's tallest photo, `prefixSum` for row tops, and `firstActive` for the first photo under a click.

Each reduction's definition specifies one FP32 order of additions, and both its JavaScript loop and its expansion into a duplicated circuit, where each photo's copy is written out into one circuit, follow that order, so the two give the same bits.

The familiar shape is the gallery's own JavaScript: a loop that computes each photo's size, a loop that takes each row's maximum height, a running sum for row tops, and a loop for the photo under the pointer. The staged program keeps those loops, but every per-photo loop body is a compiled circuit, and nothing inside a map stage reads another photo. For example, the per-photo program compares the photo's own index with the focused index, `|focusedIndex - photoIndex| <= 1` for the focused photo and its two neighbors, instead of reading the neighboring photos' state.

Three executors run the same program: the duplicated circuit as the reference, generated JS with one loop per stage over arrays of fields, and WGSL compute shaders for the map stages.

**What it showed.**

- The gallery is 233 operations per photo in 6 map stages, plus 401 shared operations, at 221, 1,000 and 10,000 photos alike, and builds in 22 ms at 10,000 photos. At 10,000 photos the duplicated circuit has 2,571,887 operations, takes 4.7 s to build and needs about 2 GB of heap.
- Per frame, the staged executor took about 65, 310 and 4,106 µs at 221, 1,000 and 10,000 photos, against 546, 2,569 and 43,027 µs for the duplicated circuit, and 21, 100 and 3,055 µs for index.ts running natively.
- Decisions matched native index.ts: 0 mismatches in about 2 million checks at 221 photos, and in 2,408,107 checks at 10,000 synthetic photos with Brent-Kung prefix sums.
- The order of additions determined precision. At 10,000 photos the page is millions of pixels tall. A running sum adds a row height of a few hundred px to a total past a million px, where neighboring FP32 values are 1/8 px apart, thousands of times: row tops drifted by up to 40.7 px in one trace, and 74 decisions flipped in another. A Brent-Kung prefix sum, which adds neighboring pairs, then pairs of pairs, mostly adds values of similar size, and kept every decision equal to index.ts.

**How cost grows.** The program's size is the per-item program plus the reductions, whatever the item count. The work per frame still grows linearly with the items, as a shader's work does, and the reductions are linear too. A Brent-Kung prefix sum adds about 2 log2 n layers.

**What to try in the demo.** Open `lab/ui-exploration/instanced-items/demo.html` for 10,000 synthetic photos, or add `?count=221` for the real photos. Scroll far down, hover a photo for the zoom-in cursor, click it to open the strip, then use ArrowLeft, ArrowRight and Escape. The HUD shows 233 operations per photo in 6 map stages, and only visible photos get DOM nodes. In the browser check at 10,000 photos, most timed runs had median frames of 12.3 to 19.0 ms in Chrome, against about 4.1 ms per evaluation in Bun, for reasons not found.

**Main limitation.** A per-item constant turns a weight into an operation: where the duplicated circuit multiplies by a constant weight, a stage written once multiplies by a per-item cell, which costs about 33 more operations per photo than the hand-built gallery. IndirectOS's few repeated parts, 4 windows, 4 dock items and 12 photos, got bigger when staged, 6,282 operations and 215 layers against 5,253 and 192. A runtime index into another array, e.g. a photo's row for the current column count, doesn't expand well into a duplicated circuit, so the gallery keeps 7 row arrays, one per column count. And the GPU pays an upload and a readback per stage until the reductions run on the GPU too, e.g. 12.2 ms per frame through Dawn at 10,000 photos, against 9.1 ms for the CPU executor.

## Premature compression

### exactness-budget: which exactness a UI needs

**The idea from the talk.** Premature compression: "every value is exact FP32 arithmetic" bundles two different requirements into one, decisions that must come out as exact bits, and geometry that only needs to stay within a known distance.

**The UI problem.** The runtime adds each operation's terms in a stored order and rounds to FP32 after every addition, like `Math.fround` after every `+`. A GPU shader compiler, a framework's sparse kernel, or a parallel adder combines the same terms differently, e.g. it may add a product without rounding the product first. In JavaScript nobody minds if `left + width / 2 + offset` comes out 0.0001 px differently, but everybody minds if `Math.floor(dayIndex / 7)` or `pointerX >= left` gives a different result.

**What was built.** An interpreter over compiled programs, with eight ways of adding terms: stored order, reversed order, balanced pairwise sums, fused multiply-add (the product added without rounding it first), balanced sums with fusion, float64 everywhere, and two modes that keep stored FP32 order only at rounding points, with balanced fused sums or float64 everywhere else.

A rounding point is an operation where FP32 rounding turns a value into a decision, or a value that feeds such an operation, e.g. a boolean atom, a step of a round or floor construction like `(x + 2^23 + 2^22) - (2^23 + 2^22)`, or the difference `pointerX - windowLeft` inside a hit test. A blend like `0.3 × a + 0.7 × b` isn't a rounding point. The builder didn't record rounding points then, so the interpreter recovered them from the compiled operations by pattern. numeric-ui-core.ts now records boolean atoms, `emitCompare`'s operations and operations marked with `circuit.markRoundingPoint(wire)` itself. One of the interpreter's patterns, a ReLU that scales one runtime value by a power of two of at least 2^8, also matches the stages of a sign cascade, although a sign cascade gives the same bits without any rounding.

The interpreter replaced the executor inside seven UIs: IndirectOS, the photo gallery, hn-thread, draggable cards, the text field, a dock with a progress ring, and a life calendar. Each UI ran its own page logic and its own reference checks in every mode, open loop and closed loop. Open loop evaluates each frame on the state of the stored-order run, and closed loop lets each mode carry its own state from frame to frame, so small differences can grow.

**What it showed.**

- The order of ordinary sums didn't matter for decisions. Reversed, balanced and fused sums changed 0 of 141,120 decisions per mode in IndirectOS's 240-frame session. Across the seven UIs, the reference checks found one difference: a gallery settle bit one frame late, in 1 of 3,600 frames.
- FP32 rounding itself is required. float64 everywhere broke every UI that relies on FP32 rounding, e.g. 1,150,506 wrong rows, and as many wrong columns and days of the week, in the life calendar over 42 states, and 1,436 of 1,500 frames of typing in the text field. Keeping stored FP32 order only at rounding points, 1.6% to 61% of operations depending on the UI, with float64 everywhere else, repaired all four UIs that broke: the life calendar, the cards, the text field and the progress ring.
- One kind of value needs more than rounding points: a value compared with its own stored copy from last frame. The gallery's settle test compares a destination recomputed this frame with last frame's FP32 copy. At 50,607 px, the float64 recomputation differs from the copy by 0.0105 px, just above the 0.01 threshold, so springs kept animating, with 108 mismatches against index.ts.
- On the GPU, max guards only at rounding points gave 0 decision mismatches through wgpu and Dawn on codegen's five workloads and 12 random circuits, with 84 guards instead of 537 for IndirectOS's press map, a program that computes which window would receive a press at each pixel.

**How to run it.** There's no demo. The folder was removed on September 16, 2026. At the [exploration-2026-09 tag](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/exactness-budget), `bun test lab/ui-exploration/exactness-budget` runs 8 tests in 1 to 2 s, and codegen's README keeps [its findings](../../codegen/README.md#merged-from-exactness-budget-september-16-2026).

**Main limitation.** Rounding points are guessed from compiled operations. The life calendar's grid sizing clamps with a scale that the pattern doesn't recognize, and that UI kept its decisions because its thresholds have margin, not because the pattern found those clamps. A comparison that sits exactly on its threshold still reads drifted state: under fused order, one FP32 step of drift in a card's position flipped 4 hit-test bits at an exact card edge, without changing any output. And the seven UIs weren't run on the GPU.

### retiming: letting some values be one frame old

**The idea from the talk.** Premature compression: "every output of a frame is consistent with that frame's inputs" bundles "one frame" with "circuit depth". Hardware separates the two with registers, which hold a value from the previous clock tick, and retiming is the established hardware technique of moving registers along a circuit to shorten its longest path.

**The UI problem.** Depth comes from a UI's chain of dependencies, e.g. in the gallery the focus is computed from a click, the strip positions from the focus, then the destinations, the scroll anchor, the springs and occlusion, one after another. Earlier prototypes shortened such chains by hand, by reading a value from the previous frame, like layout code that reads `previousLayout.sidebarWidth` instead of this frame's sidebar width. For example, Photos reading its content size and opacity from last frame took IndirectOS from 191 to 116 layers. How visible are those delays, and could a search find good ones?

**What was built.** A cut makes every operation that reads a chosen value read a register cell instead, which holds that value from the previous evaluation. Depth is recomputed as the longest chain from the source cells, with registers counting as sources. Each candidate set of cuts is replayed closed loop over traces, i.e. recorded or generated sequences of inputs and frame times, and compared with the program without cuts, against a budget of 1 px, 0.02 opacity and 0 decision mismatches.

A greedy search keeps the candidate that removes the most layers per px of error. Candidates come from two places: values that every longest chain passes through at the same depth, and minimum cuts, i.e. the smallest set of values whose cuts bring every chain down to a target depth, found by max flow.

**What it showed.**

- None of the hand-chosen delays fits a 1 px budget. Photos reading last frame's content size and opacity is 88.9 px off at 60 fps and 161 px off at 10 fps with IndirectOS's original springs, and the app shell reading last frame's sidebar spring is 1,380 px off, with 116 decision mismatches.
- The error of a delay is how far the delayed value moves in one frame, so the same Photos delay goes from 85.7 px at 60 fps to 413 px at 10 fps with the spring bank.
- A search on one trace overfits. On the live resize trace, IndirectOS with the spring bank reached 84 layers at 0 px, and the same cuts made over 7,000 decision mismatches on random traces, because 23 of its 49 registers never changed in the searched trace.
- Searched on scripted and random traces together, the search over values that every longest chain passes through took IndirectOS with the spring bank from a longest chain of 136 operations to 123, with 8 registers, at 0 px and 0 mismatches on three held-out random traces. The search over minimum cuts reached the same 123 with 8 registers, and failed on one of those traces with 996 px and 33 mismatches. The search only rediscovered the hand-chosen Photos delay once px could be spent and `animationActive`, which is only used to choose whether to request another frame, was allowed to be one frame late.

**How to run it.** There's no demo. The folder was removed on September 16, 2026. At the [exploration-2026-09 tag](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/retiming), `bun test lab/ui-exploration/retiming` runs 11 tests in about 2 s.

**Main limitation.** A trace only tests values that change in it, so a search's result is only as good as its traces, and a px budget only means something together with a statement of how fast inputs move. Chains with a decision at every stage don't get shorter: the gallery lost 1 layer, and only through registers that its searched traces never changed. And depth only costs time for an executor that runs a whole layer at once, e.g. on a GPU. Neither today's executor nor generated JS runs layers in parallel.

## Consolidation

### indirect-os-2: do the improvements add up?

**The idea from the talk.** Not from the talk. This prototype is a consolidation check: do the separate improvements from the second round add up when they're combined in one IndirectOS program?

**The UI problem.** IndirectOS is a desktop with Files, Notes, System Monitor and Photos windows and a dock. The combined version adds several events handled exactly within one frame, arrow keys routed to the focused window, clicks that can be cancelled by moving away before the release, and a Notes window whose paragraph flows around the other windows with a spring per word.

**What was built.** One program where each earlier change is an option, added step by step and checked against an independent reference at each step:

- the spring timestep declared nonnegative, which lets the builder use cheaper products;
- the spring bank: fixed 4 ms spring steps applied as powers of one shared 2 × 2 step matrix, so each animated number costs 4 products;
- Photos laid out from its window's springs after this frame's steps;
- an event queue of 8 entries, each entry holding one event's kind bits and whole-pixel coordinates, with at most 2 presses per evaluation;
- the Notes flow, laid out in bands one line tall around the other windows' destination rectangles, not the rectangles where the windows are drawn mid-animation.

The combined circuit needed new click rules. Window buttons and dock items act on release, so pressing a close button, moving more than 4 px away and coming back cancels the close. A drag always equals the window geometry recorded at the press plus the pointer's offset from the press point, so a window dragged past the screen edge and back returns under the pointer.

**What it showed.**

- The circuit got richer and stayed exact everywhere it was checked: 0 mismatches against the one-event-at-a-time reference over 4 traces of 3,000 frames with 33,129 events, 5,046 of them keys, and settled Notes layouts matched pretext's `layoutNextLineRange` on 150 random window arrangements.
- The circuit didn't get cheaper. The original is 5,253 live operations, 192 layers and 11,598 stored weights, and the whole program is 19,854 operations, 343 layers and 49,900 stored weights. The spring bank saved about 1,350 operations with or without the queue, while the queue cost 4,476 operations and 78 layers, and the Notes flow 11,795 operations and 174 layers, most of it the line walker.
- Flowing text around destinations kept 60 fps and 120 fps within 2.4e-4 px on a scripted session, while flowing around the windows' animated geometry differed by 25.4 px.
- Generated JS ran the whole program in about 29 µs, against about 159 µs on the executor, but needed about 30,000 evaluations to get fast. In Chrome, switching to generated code during idle time stalled the animation, with one warmup step taking 446 to 506 ms.

Update, September 15, 2026: the word springs were removed, so words move straight to the new layout in the frame of the event. The numbers above were measured with word springs. The whole program is now 18,027 operations, 337 layers and 44,326 stored weights, the Notes flow adds 9,968 operations and 168 layers, exact multi-event input and the text flow together cost 14,444 operations, and the spring bank saves 1,350 operations with Notes. At 60 and 120 fps, words at shared timestamps came out identical with either obstacle source, and the windows' animated geometry instead makes the text reflow in 8 frames with no event. Generated JS runs the whole program in about 21 µs, against about 132 µs on the executor ([indirect-os-2](../../indirect-os-2/README.md#words-without-springs-2026-09-15)).

**How cost grows.** The queue's cost is paid on every evaluation, whether or not events arrived: each more press per evaluation costs about 2,200 operations and 40 layers in this program, e.g. 5,816 operations and 129 layers with 1 press against 8,059 and 169 with 2, and each more queue entry costs about 120 operations.

**What to try in the demo.** Open `lab/ui-exploration/indirect-os-2/indirect-os.html`. Drag Photos over Notes and watch the paragraph reflow around it, with every word moving straight to its new place. Press Files' close button, move more than 4 px away and back, and release: Files stays open, while a quick click closes it. Open a photo and press ArrowRight while Photos is focused, then click Notes' dock item and press ArrowRight again: the key has no effect on Photos.

**Main limitation.** Exact multi-event input and the text flow together cost 16,271 operations, about three times the whole original desktop's 5,253. The Notes paragraph can also run past the bottom of its window, because the bands never check the content height: with Files over the top of Notes, 13 of 22 visible words were clipped.

## What these prototypes suggest for writing apps

Some results translate directly into ways of writing an app:

- Write repeated items as one per-item program with reductions between stages (instanced-items), and use Brent-Kung prefix sums for positions that can pass about a million px.
- Where stored state must not depend on the frame rate, commit state per event and draw frames with evaluations that never write back (event-time), which host-timing.ts's `advanceFrame` does with `'events and settle checks'`.
- Keep behavior and design numbers in source cells instead of constants (user-population, drag-knobs). All five of drag-knobs' design numbers cost 60 operations, and a number in a cell can be searched, changed at runtime, or differ per user.
- Treat a capacity as an upper bound, and compute whole-text outputs like a line count from the count of what has arrived (streaming-words).
- Lay text out and hit-test against destinations, not drawn positions (indirect-os-2).
- Hold code points in text cells and read line break rules from tables (code-points), with the index read instruction that numeric-ui-core.ts has had since September 14, 2026.

Other results are research directions rather than building blocks: learned rules (learned-bits), delays chosen by search (retiming), per-pixel output with index reads and a GPU guard (pixel-output), and a relaxed order of additions away from rounding points (exactness-budget), which needs rounding points recorded. Since September 14, 2026 the builder records boolean atoms, `emitCompare`'s operations and operations marked with `circuit.markRoundingPoint`, while existing circuits, e.g. IndirectOS, still record only their boolean atoms.

The same limits came up in several prototypes: sizes fixed when the circuit is built, e.g. capacities, line slots, queue entries and turns; FP32 precision at large coordinates; comparisons that sit exactly on a threshold while reading drifting spring state; generated JS that needs thousands of evaluations to get fast; GPU runs that spend most of their time uploading and reading back; and browser checks in a hidden tab that give no information about motion or frame pacing.

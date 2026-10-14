# A million JSON documents: a check before building

## What it is

The demo page of [lab/json-search](../README.md) searches 100,000 generated JSON documents per keystroke with the repo's own programs on the GPU, and takes about as long as the browser's RegExp on one thread. Cheng asked: "I was thinking about 1 million documents, optimized kernels vs regular idiomatic js. Thought I don't know what the numbers would look like. Maybe we should check before we build it. Esp since 1M docs in browser might be a lot".

This folder is that check. Nothing here is for visitors: it is a measurement page, the kernels it runs, and the scripts that print the tables. The kernels are written by hand. They stand in for what a better emitter might write from the repo's program, and none of them is the repo's program, except in the rows that say `searcher.ts` or "the program's own step".

Measured on October 13 and 14, 2026 on one Apple M5 Max (18 cores, 36 GB) in headless Chrome 155, while other agents' jobs ran on the same machine. The documents are the demo page's: 1,000,000 valid JSON documents of at most 512 code points, 299 on average.

## The answer

- **A million documents fit in one tab, as bytes.** One byte per code point is 512 MB, 2 scope bits per position are 128 MB, and one count per document is 4 MB: 644 MB of GPU buffers, 0.9 to 1.2 GB in Chrome's GPU process, and 5 MB of JavaScript when the page doesn't keep the texts. With the limits that every WebGPU device has without being asked, the documents go into four buffers, and that ran too. The page has every document on the GPU and searched 1.0 s after the navigation, and an answer for the first 25,000 documents after 0.3 s. Today's layout of one f32 per code point also ran at a million documents on this machine, with 4.1 GB of buffers and 6.3 GB in the GPU process.
- **A keystroke with a hand-written kernel costs 14 ms.** That is the answer to "which documents have a match", inside string values or everywhere, for a pattern of up to 8 states, after a pause of 200 ms or more, which is what a keystroke gets. A pattern of up to 16 states costs 18 ms, and one of up to 32 states 25 ms. When searches follow each other, one takes 4.6 to 5.1 ms at 8 states. A match count per document instead of one bit costs 26 ms after a pause.
- **Regular JavaScript on one thread takes 68 to 331 ms** for `texts.filter(text => pattern.test(text)).length` on the five ordinary patterns, and 14.5 s on `([a-z]+)+x`. Inside string values or keys it takes 191 to 290 ms as a walk over objects that were parsed once, and 80 to 169 ms from arrays of strings that were collected once. So the kernel is 3 to 23 times faster than one thread, pattern by pattern: 14 ms against 189 ms for `error`, 18 ms against 68 ms for the date, 25 ms against 74 ms for `connection reset`. In 8 workers the whole-text filter takes 10 to 46 ms, which is about what the kernel takes.
- **Today's program, with no emitter work, takes 75 ms per keystroke** at a million documents for a pattern of up to 8 states, which is inside RegExp's 68 to 331 ms. It takes 0.6 s at up to 16 states and 9 s at up to 32.
- **A rewrite of the program's own operations reaches the hand-written kernel's speed.** I wrote by hand what such a rewrite would give: 2.7, 3.3 and 3.8 ms for 100,000 documents at 8, 16 and 32 states, where the program's step takes 6.8, 64 and 879 ms. Keeping every 0-or-1 value as a bit isn't enough, 6.1, 23 and 432 ms: the 8, 16 or 32 table reads that feed one sum have to become one AND of two words.

## The tables

These are the few rows that answer the question, printed by `summarize.ts --table report`. results/tables.md has every table: each layout and count, every kernel at three state capacities in three runs, the load, the program at each count, regular JavaScript per pattern, and the map.

**1. Memory at 1,000,000 documents, one run each.** A process's memory is its footprint, with the resident size from `ps` in parentheses.

| Layout | Bytes per document | GPU buffers: documents + kinds or scope bits + results | JavaScript, with the texts in the page | Chrome's GPU process | The page's renderer process | Documents per buffer under WebGPU's default limits |
| --- | --- | --- | --- | --- | --- | --- |
| today's, through searcher.ts | 2,052 + 2,048 | 2.05 GB + 2.05 GB + 20 MB | 358 MB | 6.26 GB (1.63 GB) | 2.48 GB (1.99 GB) | 65,408 |
| bytes, 512 per document | 512 + 128 | 512 MB + 128 MB + 4 MB | 341 MB | 861 MB (291 MB) | 613 MB (780 MB) | 262,144, so four buffers |
| bytes, packed | 301 on average + 4 + 128 | 305 MB + 128 MB + 4 MB | 341 MB | 818 MB (256 MB) | 581 MB (754 MB) | 445,000 on average |
| bytes, 512 per document, no texts in the page | 512 + 128 | 512 MB + 128 MB + 4 MB | 5 MB | 1.15 GB (295 MB) | 174 MB (355 MB) |  |

**2. The load, ms from the navigation, 512 bytes per document, 8 workers, one run each.**

| Documents | The kernel is compiled | The first piece of 25,000 arrives | Its answer is in JavaScript | The last piece arrives | Every document searched | The workers' time, summed: texts, bytes, scope bits | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 | 120 | 240 | 256 | 240 | 277 | 393, 39, 191 | 3.92 |
| 1,000,000 | 222 | 268 | 299 | 962 | 1007 | 4188, 420, 2369 | 3.63 |

**3. One search of 1,000,000 documents, ms.** A kernel's cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample. From `compact-1000000` (load average 2.5 to 6.9), `program-1000000` (2.3 to 4.0) and `js-1000000` (2.8 to 7.4).

| What runs on the GPU | Patterns of up to 8 states | up to 16 states | up to 32 states |
| --- | --- | --- | --- |
| hand-written kernel on bytes: which documents match, with a scope (string values) | 4.63 (4.58 to 4.76); 14.1 (14.0 to 14.3) | 10.2 (7.99 to 14.4); 18.3 (17.9 to 20.5) | 17.5 (14.3 to 20.9); 25.1 (24.8 to 26.4) |
| the same without a scope | 4.23 (4.12 to 4.67); 13.7 (13.5 to 15.1) | 10.1 (8.15 to 12.3); 17.7 (17.4 to 19.0) | 15.5 (13.8 to 18.3); 24.5 (24.3 to 25.7) |
| hand-written kernel on bytes: a match count per document, with a scope (string values) | 16.6 (16.4 to 18.3); 25.7 (25.5 to 26.4) | 28.8 (24.6 to 34.5); 36.3 (33.0 to 43.1) | 43.5 (34.5 to 56.9); 41.9 (31.9 to 47.8) |
| the same without a scope | 15.2 (15.1 to 16.3); 24.2 (24.1 to 24.3) | 30.3 (24.6 to 38.1); 32.8 (30.7 to 39.1) | 47.2 (35.9 to 59.8); 43.8 (41.3 to 54.2) |
| the same on packed bytes | 36.5 (35.9 to 40.4); 43.7 (42.9 to 46.6) | 42.9 (39.8 to 48.9); 58.5 (49.5 to 156) | 53.4 (47.3 to 87.2); 56.4 (52.0 to 82.9) |
| the lab's `bitRowKernel` as it is, one f32 per code point, a count per document | 28.7 (28.4 to 29.9); 37.1 (36.9 to 37.4) | 46.8 (34.4 to 65.0); 45.3 (40.8 to 60.0) | 63.6 (47.3 to 79.3); 58.5 (52.7 to 77.2) |
| searcher.ts, the program as the page runs it today, one f32 per code point, a count per document | 66.1 (64.6 to 67.1); 74.1 (73.9 to 76.0) | 608 (605 to 616); 615 (603 to 632) | 9071 (8594 to 9335);  |

The same searches in a third run, `compact-1000000-short`, where a series is 15 searches after a rest of 3 s (load average 5.1 to 9.7), again back to back; after a pause of 200 ms. Which documents match, with a scope: 5.09 (4.89 to 5.27); 14.1 (5.51 to 14.7) at 8 states, 8.54 (8.16 to 8.99); 17.9 (17.8 to 18.1) at 16, and 14.6 (14.4 to 15.4); 24.5 (24.3 to 24.9) at 32. A count per document, with a scope: 18.4 (17.7 to 19.4); 26.4 (18.3 to 36.9) at 8 states, 24.1 (22.6 to 27.2); 28.9 (21.9 to 32.4) at 16, and 41.1 (33.3 to 60.2); 45.5 (43.5 to 50.2) at 32.

| Regular JavaScript on one thread, 9 runs each | The five ordinary patterns, the smallest and the largest median | `([a-z]+)+x` |
| --- | --- | --- |
| `texts.filter(text => pattern.test(text)).length`, whole text | 68.1 to 331 | 14510 (14024 to 14742) |
| a walk over objects that were parsed once: string values, and keys | 191 to 290, and 202 to 277 | 4542 (4270 to 4562), and 16562 (16262 to 16802) |
| arrays of strings that were collected once: string values, and keys | 80.1 to 169, and 93.7 to 155 | 4186 (4096 to 4305), and 15397 (15018 to 15948) |
| the whole-text filter in 8 workers, which isn't what Cheng asked about | 9.53 to 46.3 | 1773 (1746 to 1797) |
| `JSON.parse` of every document, the validation at load | 701 (630 to 720) |  |

A pause of 200 ms before the search doesn't change JavaScript's time. In a second run, on a busier machine (`js-pause-1000000`, load average 8.7 to 11.9), the five ordinary patterns took 80.4 to 404 ms on one thread after a pause against 83.5 to 393 ms without one, and 10.7 to 68.7 ms in 8 workers against 13.9 to 71.6 ms.

**4. What was compared.** Every timed search of the 11 kernel and program runs, 62,017 searches, was compared with the lab's plain JavaScript loop over the same automaton for every document of its run: the match count per document where the kernel returns counts, and whether the document has a match where it returns bits, with `table-loop.ts`'s display kinds as the mask for a scope. 26,817,550,000 values, 0 mismatched. Over the 1,000,000 documents and the 6 patterns, `pattern.test(text)`, the walk over keys and the walk over string values say "this document has a match" for exactly the same documents as the loop. The scope bits from the highlighter's pass on the GPU: 32,000,000 words compared with the table loop's, 0 mismatched.

**5. The map of 1,000,000 documents, ms, 11 paints each.**

| What is painted | Canvas pixels | Writing the pixels and `putImageData` |
| --- | --- | --- |
| one pixel per document, from counts | 1000 by 1000 | 3.69 (2.66 to 5.28) |
| one pixel per document, from bits | 1000 by 1000 | 4.76 (2.69 to 5.55) |
| 2 by 2 pixels per document, from bits | 2000 by 2000 | 5.92 (2.90 to 7.58) |
| the demo page's paintCells, with its gaps | 1000 by 3999 | 10.2 (7.77 to 11.6) |

**6. The program's step and what a rewrite of its operations gives, 100,000 documents as one f32 per code point, ms.** Back to back; after a pause of 200 ms. From `compact-100000`, load average 2.7 to 5.3.

| What runs on the GPU | 8 states | 16 states | 32 states |
| --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | 6.83 (6.79 to 8.79); 16.9 (16.7 to 17.1) | 63.6 (62.6 to 65.1); 73.1 (61.3 to 76.5) | 879 (863 to 902); 906 (878 to 924) |
| rewrite 1: every 0-or-1 value as a bit, one table read per pair of states | 6.08 (6.00 to 6.36); 16.2 (16.0 to 16.3) | 22.6 (22.3 to 24.6); 32.6 (32.2 to 33.4) | 432 (416 to 509); 430 (420 to 539) |
| rewrite 2: also the reads of one sum as one word | 2.68 (2.65 to 2.79); 8.19 (8.09 to 8.23) | 3.33 (3.25 to 3.63); 10.2 (10.1 to 11.3) | 3.79 (3.74 to 4.17); 12.5 (12.4 to 12.6) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | 3.33 (3.23 to 3.98); 11.0 (10.7 to 11.5) | 3.55 (3.50 to 4.70); 11.6 (11.5 to 11.7) | 4.77 (4.70 to 6.01); 14.2 (14.0 to 14.3) |

Notes on the tables:

- **Back to back wasn't steady on this machine.** In the first run every series at 8 states was steady, e.g. 15.2, 15.5 and 15.4 ms for the first three searches of a series and 15.2, 15.1 and 15.1 ms for the last three. From two minutes into the run, the searches of a series got slower one after the other, e.g. 8.0 ms for the first three and 14.3 ms for the last three at 16 states, and a series that started after nine pauses of 1 s was steady again. A second run, with a rest of 2 s before each series, at a load average of 8 to 11, showed the same from its first series. So the back to back medians at 16 and 32 states in table 3 are too high, and the third run's numbers under the table are the better ones: series of 15 searches after a rest of 3 s, which were steady for the kernel that returns one bit. The times after a pause agree between the three runs: 14.1 to 14.2 ms, 17.8 to 18.3 ms and 24.5 to 25.8 ms at 8, 16 and 32 states. "How steady a back to back series was" in results/tables.md has the first and last searches of each series.
- **A pause costs a search about 10 ms, and small searches during the pause don't avoid that.** After 200 ms or 1 s without work, the search for one bit per document takes 13.7 to 14.3 ms instead of 4.2 to 5.1 ms. With a search of 64 documents every 16 ms or every 50 ms during the pause, it takes 13.2 to 14.0 ms, against 14.2 to 14.8 ms with nothing in between in the same run.
- **What favors which side.** Back to back favors the GPU, so the time after a pause is the one to compare, and a pause doesn't change JavaScript's time. JavaScript's numbers are 9 runs after one run of warmup, on one of 18 cores, and a GPU pass uses the whole GPU. A kernel's time is the same for every pattern of a state capacity, so `([a-z]+)+x` costs it 14 ms.
- **What a byte is.** A byte holds code point + 1, 0 past the text's end, and 255 for every code point from U+00FE up, so a position is still a code point, and the highlighter's answer for a position is the answer for a byte. 46,600 of the million documents hold such a code point. A pattern whose class boundaries all lie at U+00FE or below finds the same matches as on code points: the six patterns here, and e.g. `"[^"]+"` and `Müller`. `東京` doesn't, and neither does `.+`, whose `.` leaves out U+2028 and U+2029, which one more reserved byte value would fix. As UTF-8, 1,492 documents are longer than 512 bytes, the longest 528, and a pattern would have to be compiled to an automaton over bytes.
- **What each choice costs at 8 states, back to back.** The scope bits: 4.2 to 4.6 ms for one bit per document, and 15.2 to 16.6 ms for counts. Reading back 4 MB of counts instead of 125 KB of bits: nothing that could be measured, 15.2 against 15.4 ms with a second pass that packs the counts into bits. What makes the one-bit answer cheap is the forward pass that doesn't run, 15.2 to 4.2 ms. The class of a byte from 32 comparisons instead of one table read: 23.1 against 15.2 ms. Four buffers instead of one: 19.1 against 15.2 ms. Packed bytes are slower although their loops run 59% of the positions, 36.5 against 15.2 ms for counts and 5.6 against 4.8 ms for bits, and they save 207 MB.
- **Where the scope bits come from.** In the load of table 2 the workers run table-loop.ts's plain JavaScript highlighter, 2.4 s of the workers' 7.0 s. The repo's own highlighter gives the same bits on the GPU: its unchanged pass over pieces of 50,000 documents, between a kernel that unpacks bytes into f32 cells and one that packs display kinds into 2 bits, takes 51 ms for a million documents when the passes follow each other, 59 ms after a pause of 1 s and 69 ms the first time, plus 88 ms to compile the three shaders, with 205 MB of buffers for one piece. The table loop on one thread takes 1.4 s, and packing its kinds 0.6 s.
- **The map.** No frame was late in any paint: the second animation frame after a paint came 33.3 ms after the paint started, two frames at 60 Hz. Today's map leaves a gap between cells, so its layout for a million documents is 1,000 by 3,999 px.

## What a page could honestly claim

- **With the hand-written kernel's form**, once an emitter writes it from the repo's program: "Which of 1,000,000 JSON documents match is answered on the GPU at each keystroke, in 14 ms here. `texts.filter(text => pattern.test(text))` takes 189 ms on one thread for the same pattern." Both times measured on the visitor's machine and shown next to each other, as today's page does.
- **With today's program and no emitter work**, for patterns of up to 7 characters or classes only: "The repo's own program searches 1,000,000 documents in 75 ms per keystroke, about what RegExp takes on one thread."
- **What a page could not claim.** That the GPU beats JavaScript: 8 workers answer in 10 to 46 ms. That a hand-written kernel is the repo's program. That today's program holds up for longer patterns: 0.6 s and 9 s. That the numbers hold on another machine: one GPU was measured. That the page is light: 0.9 to 1.2 GB in the GPU process as bytes, and 6.3 GB in today's layout.

## What would have to be built

To get the kernel's numbers from the repo's own program, with how sure I am of each part:

1. **An emitter that keeps 0-or-1 values as bits and writes the table reads of one sum as one AND of two words.** `step-bits.ts` reads the compiled step: at 8 states, 234 of the 240 operations of one position hold 0 or 1 or are half of a comparison of two whole numbers, and 128 of them are a transition cell gated by one bit, in 16 groups of 8 reads that feed one ReLU gate each. The emitter has to know which cells are bits, which the cells' declarations say (`inputBit`) and a loop program's stage doesn't carry yet, to recognize four forms of operation, and to pack the pattern's 0-or-1 cells into words when they are uploaded, once by row and once by column. Sure of the gain, since the kernel in that form gave the program's answers for every document (table 6). Fairly sure that bits and comparisons are mechanical. Less sure about the packing: I wrote the rewrite's result by hand, not the rewriter, and the reads are this regular because one helper, `createStepAnd`, writes all of them.
2. **Documents as bytes, and scope bits from the highlighter.** The loop emitter and the host read an item from a buffer of bytes, and a small kernel packs the highlighter's display kinds into 2 bits. Sure: both exist here as kernels around the highlighter's own unchanged pass, which gave the scope bits of a million documents in 51 ms, with every bit equal to the plain JavaScript highlighter's.
3. **Two changes to the search program itself.** The class of a byte from one table read of 256 cells instead of 33 comparisons, 23 to 15 ms for a million documents. And a program for "which documents match" that is the reverse pass alone, since a document has a match exactly when some position can start one: 15 to 4.2 ms back to back, 24 to 14 ms after a pause. Sure of both: the first is one index read, and the second leaves out a stage. One bit per document then needs a second small pass or an atomic OR in the emitter's output, which cost nothing that could be measured.
4. **The page.** Workers that write the documents' bytes, four buffers for a device with default limits, bits read back, a map of 1,000 by 1,000 cells without gaps, the text of the one document on screen written when it is shown, and a message or a second layout for a pattern that reads code points past U+00FD. Sure, since each part ran in the measurement page except the message.

Without part 1 the page is today's program at a million documents: 75 ms, 0.6 s and 9 s per search, and 4.1 GB of buffers.

## Not measured, and what went wrong

- **Any other machine, browser or GPU, and a page with a real display.** Every run was headless Chrome 155 on one Apple M5 Max, whose adapter allows buffers of 4 GB. By WebGPU's default limits, which every device has, the four buffers of 128 MB, the scope bits in one binding of 128 MB and one dispatch of 15,625 workgroups all fit. Whether another device has 0.9 to 1.2 GB for the GPU process, or how fast its GPU runs these loops, isn't measured.
- **A quiet machine.** The 1-minute load average was 1.4 to 11.9 over the runs. Noisy: the back to back series at 16 and 32 states in all three runs of a million documents, where in the third run the kernels that return counts still got slower within a series; `program-500000`'s back to back searches at 8 states, 50 ms with samples from 33 to 59, where half of the million's 66 ms would be 33; and several series after a pause that hold one search at the back to back speed, e.g. 5.5 ms in a series whose median is 14.1 ms.
- **An emitter.** Nobody wrote the rewriter. Rewrite 2 is its result written by hand, for the search step without a scope, on one f32 per code point.
- **The marks of the document on screen.** The kernels return counts or bits. A page would run a second small pass over the documents that it shows, as today's page does.
- **UTF-8, or 2 bytes per code point** for a pattern that reads code points past U+00FD, and packed bytes in several buffers.
- **A load from the network.** The workers write the documents themselves, 4.2 s of worker time. A real page would download about 300 MB.
- **Keeping the GPU awake with larger work during a pause.** Only searches of 64 documents every 16 or 50 ms were tried.
- **What went wrong.** The first version of the kernel over four buffers read empty buffers, a bug in the measurement page that the comparison caught, with 3.1 million mismatched values, and that was fixed before any run in results/. Nothing failed to fit: the 2.05 GB `Float32Array` and its single `writeBuffer` in `createGpuSearcher` worked. No run was stopped by the memory watch: the least memory available during a run was 9.4 GB.

## How to run it

From the repo root. Each run starts its own headless Chrome with WebGPU on a new profile folder, and ends it before the next run starts, since a page with a million documents holds several GB. run.ts reads how much memory is free before a run of 500,000 documents or more, and stops a run whose Chrome leaves less than 3 GB available.

```sh
bun lab/json-search/million/all.ts --out <folder>                    # every run, about two hours
bun lab/json-search/million/all.ts --out <folder> --group load       # tables 1 and 2: the load and the memory per layout, the scope bits from the GPU
bun lab/json-search/million/all.ts --out <folder> --group compact    # tables 3, 5 and 6: the kernels at 100,000 to 1,000,000 documents, the map, the rewrites
bun lab/json-search/million/all.ts --out <folder> --group rested     # table 3 again: the kernels at 1,000,000 documents with a rest before each series
bun lab/json-search/million/all.ts --out <folder> --group program    # tables 1 and 3: searcher.ts, what the demo page runs today
bun lab/json-search/million/all.ts --out <folder> --group js         # table 3: regular JavaScript
bun lab/json-search/million/all.ts --out <folder> --group warm       # a search after a pause in which the GPU was kept busy
bun lab/json-search/million/stats.ts > <folder>/stats.txt            # the documents and the patterns on bytes, without a GPU
bun lab/json-search/million/summarize.ts --from <folder>             # every table, as markdown: results/tables.md
bun lab/json-search/million/summarize.ts --from <folder> --table report   # the tables above
bun lab/json-search/million/step-bits.ts                             # which operations of the program's search step hold 0 or 1
```

Table 4 comes from every kernel and program run. A single run is `bun lab/json-search/million/run.ts --mode compact --count 1000000 --profile <new folder> --out <file.json>`, and run.ts lists the other options. The ports are 4511 for the page and 9511 for Chrome's debugger unless `--port` and `--devtools-port` say otherwise. results/ holds the JSON files of the runs, and tables.md, which `summarize.ts --from lab/json-search/million/results` printed.

## The files

| File | What it holds |
| --- | --- |
| `layouts.ts` | The compact layouts: what a byte is, 512 bytes per document, packed bytes with a start per document, 2 scope bits per position, and a pattern's tables for kernels that read bytes |
| `kernels.ts` | The WGSL kernels: `byteKernel` with its options (layout, class lookup, scope bits, counts or one bit per document), the pass that packs counts into bits, the two kernels around the highlighter's own pass, and `rewriteKernel`, what a mechanical rewrite of the program's search step would give |
| `engine.ts` | Runs one kernel over documents that are on the GPU and times one search, with the documents in one buffer or in several |
| `expected.ts` | What every search is compared with: the lab's plain JavaScript loop over the same automaton, per document and scope. Also the regular JavaScript searches |
| `page.ts`, `page.html` | The measurement page, one mode per run: `compact`, `program`, `load`, `js`, `scopes` |
| `worker.ts` | The page's worker: writes pieces of the documents with their bytes and scope bits, or holds a share of the texts for the whole-text search in several workers |
| `run.ts`, `all.ts` | One run in its own Chrome, and every run in turn |
| `summarize.ts` | The tables from the runs' JSON files |
| `stats.ts`, `step-bits.ts` | The documents and patterns on bytes, and the program's search step read for values that are 0 or 1, both without a GPU |
| `results/` | The runs' JSON files, stats.ts's output, and every table |

Two small changes outside this folder: `runPage` in gpu/chrome.ts takes more routes for its server and more flags for Chrome, and the lab's tsconfig.json includes this folder.

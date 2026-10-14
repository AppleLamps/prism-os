# A million JSON documents: a check before building

## What it is

The demo page of [lab/json-search](../README.md) searches 100,000 generated JSON documents per keystroke with the repo's own programs on the GPU, and takes about as long as the browser's RegExp on one thread. Cheng asked: "I was thinking about 1 million documents, optimized kernels vs regular idiomatic js. Thought I don't know what the numbers would look like. Maybe we should check before we build it. Esp since 1M docs in browser might be a lot".

This folder is that check. Nothing here is for visitors: it is a measurement page, the kernels it runs, and the scripts that print the tables. The kernels are written by hand. They stand in for what a better emitter might write from the repo's program, and none of them is the repo's program, except in the rows that say `searcher.ts`, "the program's own step" or `bit-emit.ts`.

Measured on October 13 and 14, 2026 on one Apple M5 Max (18 cores, 36 GB) in headless Chrome 155, while other agents' jobs ran on the same machine. The documents are the demo page's: 1,000,000 valid JSON documents of at most 512 code points, 299 on average.

A review then ran the main runs again in new Chrome processes, compared what the kernels return with RegExp and JSON.parse in Bun, and corrected this README. Every number below is from the review's runs, in results/check/, unless a sentence names a run of results/, which holds the first runs. [What the review changed](#what-the-review-changed) lists where the two differ.

## The answer

- **A million documents fit in one tab, as bytes, on this machine.** One byte per code point is 512 MB, 2 scope bits per position are 128 MB, and one count per document is 4 MB: 644 MB of GPU buffers. Once the documents are loaded, Chrome's GPU process holds 0.85 GB in three runs and 1.1 GB in a fourth, and JavaScript holds 5 MB when the page doesn't keep the texts. During the load the GPU process reaches 1.6 to 1.7 GB, and the page's renderer process 1.5 GB, while its 8 workers write the documents.
- **The 5 MB only hold for generated documents.** The page can drop the texts because it can write any document again when it shows that document. Documents from a server would stay in the page, 341 MB as strings.
- **Default limits are enough.** With the limits that every WebGPU device has without being asked, the documents go into four buffers of 128 MB, and that ran too.
- **The load takes about 1 s.** Every document is on the GPU and searched 0.9 to 1.1 s after the navigation in four runs, and the first 25,000 have an answer after 0.3 s.
- **Today's layout also ran at a million here.** One f32 per code point takes 4.1 GB of buffers. The GPU process holds 6.3 GB afterwards and 8.1 GB at most, and the renderer 2.5 GB and 4.6 GB at most.
- **A keystroke with a hand-written kernel costs 14 ms.** That is the answer to "which documents have a match", inside string values or everywhere, for a pattern of up to 8 states, after a pause of 200 ms or more, which is what a keystroke gets. A pattern of up to 16 states costs 18 ms, and one of up to 32 states 25 ms. When searches follow each other, one takes 4.6, 7.8 and 14.4 ms. A match count per document instead of one bit costs 26, 31 and 41 ms after a pause.
- **Regular JavaScript on one thread takes 58 to 315 ms** for `texts.filter(text => pattern.test(text)).length` on the five ordinary patterns, and 14.9 s on `([a-z]+)+x`. Inside string values or keys it takes 195 to 276 ms as a walk over objects that were parsed once, and 74 to 156 ms from arrays of strings that were collected once. After a pause of 200 ms a search took at most 7 ms longer in two runs, and up to 20 ms longer in a third. The texts take 335 MB.
- **So the kernel is 3 to 22 times faster than one thread, pattern by pattern**: 14 ms against 185 ms for `error`, 18 ms against 58 ms for the date, 25 ms against 73 ms for `connection reset`.
- **8 workers take about what the kernel takes.** The whole-text filter in 8 workers takes 25 to 44 ms for the three ordinary patterns of up to 8 states, where the kernel takes 14 ms, and 8.5 and 10 ms for the date and `connection reset`, where the kernel takes 18 and 25 ms.
- **Today's program, with no emitter work, takes 74 ms per keystroke** at a million documents for a pattern of up to 8 states. RegExp takes 185 to 315 ms on one thread for the three ordinary patterns of that size, so at a million documents today's program is already 2.5 to 4 times faster than one thread, and slower than 8 workers. It takes 0.6 s at up to 16 states and 8.9 s at up to 32, where RegExp takes 58 and 73 ms.
- **A rewrite of the program's own operations reaches the hand-written kernel's speed.** The measuring agent wrote by hand what such a rewrite would give: 2.7, 3.2 and 3.8 ms for 100,000 documents at 8, 16 and 32 states, where the program's step takes 6.9, 64 and 887 ms. Keeping every 0-or-1 value as a bit isn't enough, 6.2, 23 and 431 ms: the 8, 16 or 32 table reads that feed one sum have to become one AND of two words. When this check ended, nobody had written the rewriter.
- **Since then, a code writer produces that form from the unchanged program.** [bit-emit.ts](../bit-emit.ts) takes 3.5, 3.4 and 4.4 ms for the same search, with rules that don't name the program, see [Can the code writer do it?](#can-the-code-writer-do-it).

## The tables

These are the few rows that answer the question, printed by `summarize.ts --from lab/json-search/million/results/check --table report --kernel-run compact-1000000-short`. results/check/tables.md has every table of the review's runs, and results/tables.md every table of the first runs: each layout and count, every kernel at three state capacities in three runs, the load, the program at each count, regular JavaScript per pattern, and the map.

**1. Memory at 1,000,000 documents, one run each.** A process's memory is its footprint once every document is on the GPU, and the largest footprint it had until then.

| Layout | Bytes per document | GPU buffers: documents + kinds or scope bits + results | JavaScript | Chrome's GPU process | The page's renderer process, with its workers | Documents per buffer under WebGPU's default limits |
| --- | --- | --- | --- | --- | --- | --- |
| today's, through searcher.ts, with the texts in the page | 2,052 + 2,048 | 2.05 GB + 2.05 GB + 20 MB | 358 MB | 6.26 GB, at most 8.09 GB | 2.48 GB, at most 4.61 GB | 65,408 |
| bytes, 512 per document, with the texts in the page | 512 + 128 | 512 MB + 128 MB + 4 MB | 341 MB | 850 MB, at most 1.64 GB | 614 MB, at most 1.53 GB | 262,144, so four buffers |
| bytes, packed, with the texts in the page | 301 on average + 4 + 128 | 305 MB + 128 MB + 4 MB | 341 MB | 1.12 GB, at most 1.59 GB | 575 MB, at most 1.55 GB | 445,000 on average |
| bytes, 512 per document, no texts in the page | 512 + 128 | 512 MB + 128 MB + 4 MB | 5 MB | 851 MB, at most 1.67 GB | 174 MB, at most 1.50 GB |  |

**2. The load, ms from the navigation, 512 bytes per document, 8 workers, one run each.**

| Documents | The kernel is compiled | The first piece of 25,000 arrives | Its answer is in JavaScript | The last piece arrives | Every document searched | The workers' time, summed: texts, bytes, scope bits | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 | 141 | 257 | 274 | 261 | 293 | 439, 41, 220 | 5.11 |
| 1,000,000 | 207 | 236 | 271 | 855 | 900 | 3663, 394, 2153 | 3.64 |

**3. One search of 1,000,000 documents, ms.** A kernel's cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample. From `compact-1000000-short`, where a series is 15 searches after a rest of 3 s (load average 3.4 to 7.9), `program-1000000` (3.9 to 6.0) and `js-1000000` (3.2 to 7.7).

| What runs on the GPU | Patterns of up to 8 states | up to 16 states | up to 32 states |
| --- | --- | --- | --- |
| hand-written kernel on bytes: which documents match, with a scope (string values) | 4.64 (4.61 to 4.68); 14.1 (14.0 to 14.4) | 7.75 (7.73 to 7.82); 17.8 (15.4 to 18.0) | 14.4 (14.4 to 14.5); 24.5 (24.4 to 33.3) |
| the same without a scope | 4.32 (4.29 to 4.39); 13.5 (13.1 to 15.3) | 7.27 (7.22 to 7.37); 17.4 (13.4 to 22.1) | 14.0 (13.9 to 14.4); 24.1 (23.0 to 25.4) |
| hand-written kernel on bytes: a match count per document, with a scope (string values) | 16.7 (16.6 to 17.2); 25.6 (25.5 to 25.7) | 21.0 (20.9 to 21.1); 30.7 (29.5 to 30.9) | 30.8 (30.7 to 39.5); 40.7 (40.6 to 40.9) |
| the same without a scope | 15.2 (15.2 to 16.0); 24.3 (22.9 to 24.8) | 20.1 (20.1 to 20.5); 29.9 (29.8 to 30.0) | 30.1 (29.7 to 38.4); 39.7 (39.6 to 43.8) |
| the lab's `bitRowKernel` as it is, one f32 per code point, a count per document | 27.8 (27.6 to 28.0); 36.5 (35.1 to 36.8) | 32.8 (28.9 to 42.4); 38.5 (38.4 to 39.3) | 51.4 (40.2 to 66.8); 50.1 (49.8 to 51.2) |
| searcher.ts, the program as the page runs it today, one f32 per code point, a count per document | 99.2 (64.9 to 111); 74.0 (64.8 to 90.4) | 594 (590 to 597); 635 (597 to 672) | 8870 (8759 to 9097);  |

The same searches in `compact-1000000`, where a series is at least 15 searches and 1 s, with no rest before it (load average 3.6 to 6.1), again back to back; after a pause of 200 ms. Which documents match, with a scope: 4.64 (4.59 to 5.24); 14.1 (8.40 to 14.3) at 8 states, 7.75 (7.71 to 7.98); 17.7 (17.3 to 17.9) at 16, and 14.5 (14.4 to 15.1); 24.5 (20.3 to 26.1) at 32. Without a scope: 4.38 (4.33 to 4.68); 13.5 (8.63 to 13.8) at 8 states, 7.14 (7.07 to 7.50); 17.2 (17.0 to 17.3) at 16, and 18.8 (15.3 to 21.1); 24.2 (22.6 to 25.1) at 32. A count per document, with a scope: 17.4 (16.8 to 17.9); 25.9 (25.7 to 26.0) at 8 states, 21.1 (21.0 to 21.6); 30.7 (21.4 to 32.0) at 16, and 46.3 (34.3 to 56.4); 44.3 (41.0 to 52.3) at 32. Without a scope: 15.3 (15.2 to 15.9); 24.3 (24.2 to 24.4) at 8 states, 20.2 (20.1 to 20.7); 30.0 (29.8 to 30.3) at 16, and 29.9 (29.5 to 31.1); 39.6 (39.5 to 39.8) at 32. `bitRowKernel`: 28.1 (27.8 to 28.9); 36.9 (36.8 to 37.0) at 8 states, 29.8 (29.5 to 30.7); 39.0 (38.7 to 39.4) at 16, and 40.5 (40.1 to 41.7); 50.1 (49.9 to 51.7) at 32.

| Regular JavaScript on one thread, 9 runs each | The five ordinary patterns, the smallest and the largest median | `([a-z]+)+x` |
| --- | --- | --- |
| `texts.filter(text => pattern.test(text)).length`, whole text | 58.0 to 315 | 14929 (14691 to 15504) |
| a walk over objects that were parsed once: string values, and keys | 195 to 273, and 197 to 276 | 4259 (4241 to 4309), and 15831 (15792 to 15895) |
| arrays of strings that were collected once: string values, and keys | 74.4 to 148, and 93.2 to 156 | 4152 (4090 to 4269), and 16267 (15990 to 17320) |
| the whole-text filter in 8 workers, which isn't what Cheng asked about | 8.54 to 43.7 | 1854 (1829 to 1886) |
| `JSON.parse` of every document, the validation at load | 609 (601 to 650) |  |

The same searches after a pause of 200 ms, from the runs that time each search both ways, as the smallest and the largest median of the five ordinary patterns. `js-pause-1000000` (load average 2.3 to 4.8): 77.8 to 315 ms on one thread after a pause against 58.0 to 309 ms without one, and 16.0 to 59.1 ms in 8 workers against 8.38 to 44.0 ms. `js-pause-1000000-ordinary` (load average 2.5 to 3.5): 61.6 to 317 ms on one thread after a pause against 57.9 to 313 ms without one, and 8.96 to 46.0 ms in 8 workers against 8.79 to 45.2 ms. `js-pause-1000000-ordinary-2` (load average 2.8 to 3.7): 61.8 to 312 ms on one thread after a pause against 58.7 to 306 ms without one, and 8.98 to 47.2 ms in 8 workers against 8.48 to 46.2 ms.

Every RegExp above has no flag, as in `/error/`. Other plain ways to write the whole-text search, from `js-forms-1000000` (load average 2.7 to 4.9): the same filter, the filter with the u flag, a loop that counts instead of `filter`, and `text.includes(word)` for a plain word took 188, 188, 188, 186 ms for `error`; 204, 220, 197 ms for `[a-z]+Id`; 310, 345, 313 ms for `[a-z0-9.]+@[a-z.]+`; 59.4, 67.8, 54.7 ms for `\d\d\d\d-\d\d-\d\d`; 14459, 14866, 14118 ms for `([a-z]+)+x`; 73.8, 72.8, 68.9, 69.3 ms for `connection reset`.

**4. What was compared.** Every timed search of the 5 kernel and program runs, 30,835 searches, was compared with the lab's plain JavaScript loop over the same automaton for every document of its run: the match count per document where the kernel returns counts, and whether the document has a match where it returns bits, with `table-loop.ts`'s display kinds as the mask for a scope. 12,666,700,000 values, 0 mismatched. Over the 1,000,000 documents and the 6 patterns, `pattern.test(text)`, the walk over keys and the walk over string values say "this document has a match" for exactly the same documents as the loop. The scope bits from the highlighter's pass on the GPU: 32,000,000 words compared with the table loop's, 0 mismatched. The review's independent count, which shares only the document generator with the above, compared what the main kernels returned over everything, string values and keys with `RegExp` over the whole text and over every string value and key of the parsed document. The report's six patterns: 54 searches, 54,000,000 documents' answers, 0 differ. `"[^"]+"` and `Müller`: 10 searches over the whole text, 10,000,000 answers, 0 differ. 8 searches inside string values or keys, 8,000,000 answers, of which 3,780,726 differ from the parsed values and 2,796 from the string tokens as written. A kernel's scope reads the text as written, with its quotes and escapes, which is where the two added patterns differ, see independent.txt.

**5. The map of 1,000,000 documents, ms, 11 paints each.**

| What is painted | Canvas pixels | Writing the pixels and `putImageData` |
| --- | --- | --- |
| one pixel per document, from counts | 1000 by 1000 | 1.72 (1.05 to 1.89) |
| one pixel per document, from bits | 1000 by 1000 | 1.83 (1.14 to 1.91) |
| 2 by 2 pixels per document, from bits | 2000 by 2000 | 2.88 (2.17 to 3.42) |
| the demo page's paintCells, with its gaps | 1000 by 3999 | 6.38 (5.21 to 7.37) |

**6. The program's step and what a rewrite of its operations gives, 100,000 documents as one f32 per code point, ms.** Back to back; after a pause of 200 ms. From `compact-100000`, load average 2.0 to 5.5.

| What runs on the GPU | 8 states | 16 states | 32 states |
| --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | 6.94 (6.87 to 7.50); 16.9 (13.7 to 17.1) | 64.3 (62.5 to 67.2); 76.0 (74.3 to 77.4) | 887 (866 to 901); 904 (873 to 1006) |
| rewrite 1: every 0-or-1 value as a bit, one table read per pair of states | 6.15 (6.01 to 7.09); 16.2 (12.8 to 18.1) | 22.7 (22.4 to 24.1); 33.6 (33.0 to 35.0) | 431 (421 to 510); 437 (428 to 515) |
| rewrite 2: also the reads of one sum as one word | 2.68 (2.62 to 2.92); 8.18 (4.42 to 8.26) | 3.20 (3.10 to 3.59); 11.2 (6.12 to 11.8) | 3.82 (3.77 to 4.05); 13.8 (12.7 to 16.6) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | 3.61 (3.35 to 3.94); 10.9 (10.8 to 12.7) | 3.61 (3.54 to 3.78); 11.7 (11.6 to 11.8) | 4.84 (4.78 to 5.34); 14.2 (8.86 to 14.6) |

Notes on the tables:

- **A back to back series isn't always steady, so the time after a pause is the one to compare.** In the run without rests, `compact-1000000`, the searches of some series at 32 states got slower one after the other, e.g. from 34 to 56 ms for a count with a scope, and the searches after the pauses that followed got faster again, from 52 to 41 ms. In the run with a rest of 3 s before each series, every series of the kernels on bytes was steady, and `bitRowKernel`'s weren't at 16 and 32 states. In the first runs the same happened from 16 states on. `searcher.ts`'s series at 8 states also rose, from 65 to 111 ms, and the same search inside string values was steady at 65 ms. A page that searches per keystroke doesn't keep the GPU at full load, and the times after a pause agree between every run: 14.1 ms, 17.7 to 17.9 ms and 24.5 ms for "which documents match" at 8, 16 and 32 states.
- **A pause costs a search about 10 ms, and small searches during the pause don't avoid that.** After 200 ms or 1 s without work, the search for one bit per document takes 13.5 to 14.2 ms instead of 4.3 to 4.7 ms. With a search of 64 documents every 16 ms or every 50 ms during the pause, the search after the pause takes 13.2 to 14.0 ms, against 13.8 to 14.5 ms with nothing in between in the same run.
- **What favors which side.** Back to back favors the GPU, so the time after a pause is the one to compare. A pause changes JavaScript's time less, and not in every run: in two of the review's three runs a search after a pause of 200 ms took at most 7 ms longer on one thread and the same time in 8 workers, and in the third it took up to 20 ms longer on one thread, e.g. 78 instead of 58 ms for the date, and 8 to 16 ms longer in 8 workers. JavaScript's numbers are 9 runs after one run of warmup, on one of 18 cores, and a GPU pass uses the whole GPU. A kernel's time is the same for every pattern of a state capacity, so `([a-z]+)+x` costs a kernel 14 ms. RegExp reads every regular expression of JavaScript, and a kernel reads the lab's pattern language: literals, classes, `.`, `\d`, `\w`, `?`, `*`, `+`, `|` and groups.
- **What a byte is.** A byte holds code point + 1, 0 past the text's end, and 255 for every code point from U+00FE up, so a position is still a code point, and the highlighter's answer for a position is the answer for a byte. 46,600 of the million documents hold such a code point. A pattern whose class boundaries all lie at U+00FE or below finds the same matches as on code points: the six patterns here, and e.g. `"[^"]+"` and `Müller`, which the review compared with RegExp over the whole text of every document. `東京` doesn't, and neither does `.+`, whose `.` leaves out U+2028 and U+2029, which one more reserved byte value would fix. As UTF-8, 1,492 documents are longer than 512 bytes, the longest 528, and a pattern would have to be compiled to an automaton over bytes.
- **What "inside string values" means for a kernel.** A kernel's scope reads the text as written between the quotes, and an escape ends a match. A walk over parsed objects reads the decoded value. For the six patterns the kernel and the walk agree on every document. They differ where a pattern reads an escaped character: `Müller` inside string values is in 13,882 documents for the kernel and in 16,273 for the walk, since 2,391 documents write the name as `M\u00fcller`.
- **What each choice costs at 8 states, back to back.** The scope bits: 4.3 to 4.6 ms for one bit per document, and 15.2 to 16.7 ms for counts. Reading back 4 MB of counts instead of 125 KB of bits: nothing that could be measured, 15.2 against 15.3 ms with a second pass that packs the counts into bits. What makes the one-bit answer cheap is the forward pass that doesn't run, 15.2 to 4.3 ms. The class of a byte from 32 comparisons instead of one table read: 23.1 against 15.3 ms. Four buffers instead of one: 16.3 against 15.3 ms. Packed bytes are slower for counts although their loops run 59% of the positions, 37.6 against 15.3 ms, and as fast for bits, 4.55 against 4.64 ms. They save 207 MB.
- **Where the scope bits come from.** In the load of table 2 the workers run table-loop.ts's plain JavaScript highlighter, 2.2 s of the workers' 6.2 s. The repo's own highlighter gives the same bits on the GPU: its unchanged pass over pieces of 50,000 documents, between a kernel that unpacks bytes into f32 cells and one that packs display kinds into 2 bits, takes 47 ms for a million documents when the passes follow each other, 57 ms after a pause of 1 s and 83 ms the first time, plus 72 ms to compile the three shaders, with 205 MB of buffers for one piece. The table loop on one thread takes 1.2 s, and packing its kinds 0.5 s.
- **The map.** No frame was late in any paint: the second animation frame after a paint came 33.3 ms after the paint started, two frames at 60 Hz. Today's map leaves a gap between cells, so its layout for a million documents is 1,000 by 3,999 px.

## What the review changed

The review ran the load, the kernels, the program, regular JavaScript, the rewrites and the scope bits again, each in a new Chrome process, at a 1-minute load average of 2.0 to 7.9. What the review confirmed is in the tables above. What the review corrected, with the first runs' number first:

- **Every timed RegExp had the u flag**, which a programmer who writes `/error/` doesn't add, and which makes a search with a character class 8 to 14% slower in Chrome 155. Without the flag the whole-text filter takes 58 to 315 ms instead of 68 to 331 ms, e.g. 58 instead of 68 ms for the date. The page now builds each RegExp without a flag unless `--regexp-flags` gives one, and the `forms` part of the `js` mode times the other plain ways to write the search.
- **Today's program was called "about what RegExp takes on one thread" at a million documents.** The 68 to 331 ms that the 75 ms were compared with are for all five patterns. The three ordinary patterns that run on the 8-state program take RegExp 185 to 315 ms, so today's program is 2.5 to 4 times faster than one thread there.
- **The times of the kernels that return counts at 16 and 32 states were too high**, also after a pause, since the GPU got slower during those series of the first run. A count without a scope takes 20.1; 29.9 ms at 16 states and 30.1; 39.7 ms at 32, back to back; after a pause, where the first run gave 30.3; 32.8 and 47.2; 43.8. `bitRowKernel` on one f32 per code point takes 29.8; 39.0 and 40.5; 50.1 ms, where the first run gave 46.8; 45.3 and 63.6; 58.5. The times for "which documents match" after a pause were right.
- **The memory table left out the largest footprint during the load**: 1.6 to 1.7 GB for the GPU process and 1.5 GB for the renderer as bytes, and 8.1 GB and 4.6 GB in today's layout. After the load, the GPU process held 0.85 GB in three of the review's runs and 1.1 GB in one, where the first runs gave 0.8 to 1.2 GB, so the differences between the layouts in the first table were differences between runs.
- **"128 table reads are a transition cell gated by one bit" holds for 120 of them.** The forward step's 8 reads from state 0 are gated by `continuing[0] + start`, a sum of two bits that the builder copies into each read. The sum is an OR only because the two bits are never both 1, which `orExclusive`'s caller knows and the compiled program doesn't say. step-bits.ts now counts these reads.
- **Two of the costs of a choice were noise.** Four buffers instead of one cost 16.3 against 15.3 ms, not 19.1 against 15.2, and packed bytes aren't slower for one bit per document, 4.55 against 4.64 ms, not 5.6 against 4.8.
- **The map paints in 1.7 to 6.4 ms** in the review's run, where the first run gave 3.7 to 10.2 ms.
- **"A pause doesn't change JavaScript's time" held in two of the review's three runs.** In the third, a search after a pause took up to 20 ms longer on one thread and 8 to 16 ms longer in 8 workers, see the note above. The first run that said so ran at a load average of 9 to 11, where a search without a pause was already slower, e.g. 83 ms for the date.
- **The comparison had only been made with the lab's own loop.** The review compared what the kernels return with RegExp and JSON.parse in Bun for every document, see table 4, and found no difference for the six patterns, and the difference between a kernel's scope and parsed values that the note above describes.

## What a page could honestly claim

- **With the hand-written kernel's form**, once an emitter writes it from the repo's program: "Which of 1,000,000 JSON documents match is answered on the GPU at each keystroke, in 14 ms here. `texts.filter(text => pattern.test(text))` takes 185 ms on one thread for the same pattern." Both times measured on the visitor's machine and shown next to each other, as today's page does.
- **With today's program and no emitter work**, for patterns of up to 7 characters or classes only: "The repo's own program searches 1,000,000 documents in 74 ms per keystroke, where RegExp takes 185 to 315 ms on one thread."
- **What a page could not claim.** That the GPU beats JavaScript: 8 workers answer in 8.5 to 44 ms. That a hand-written kernel is the repo's program. That today's program holds up for longer patterns: 0.6 s and 8.9 s. That the numbers hold on another machine: one GPU was measured. That the page is light: 0.85 to 1.1 GB in the GPU process as bytes and 1.7 GB during the load, where JavaScript alone holds the texts in 335 MB, and 6.3 GB in today's layout. That a search inside string values equals a search of the parsed values: a kernel reads the text as written.

## What would have to be built

To get the kernel's numbers from the repo's own program, with how sure the measurements make each part:

1. **An emitter that keeps 0-or-1 values as bits and writes the table reads of one sum as one AND of two words.** `step-bits.ts` reads the compiled step: at 8 states, 234 of the 240 operations of one position hold 0 or 1 or are half of a comparison of two whole numbers, and 128 of them are a transition cell gated by a bit, in 16 groups of 8 reads that feed one ReLU gate each. The emitter needs three things that a loop program's stage doesn't carry yet: which cells are bits, which the cells' declarations say (`inputBit`); that the two bits whose sum gates the forward step's reads from state 0 are never both 1; and that the 8 reads of one gate share their index and read neighboring tables, so that their cells can be packed into one word when a pattern is uploaded, once by row and once by column. Sure of the gain, since the kernel in that form gave the program's answers for every document (table 6). Fairly sure that bits and comparisons are mechanical. Less sure about the packing: the rewrite's result was written by hand, not the rewriter, and the reads are this regular because one helper, `createStepAnd`, writes all of them. This part is built since: [Can the code writer do it?](#can-the-code-writer-do-it)
2. **Documents as bytes, and scope bits from the highlighter.** The loop emitter and the host read an item from a buffer of bytes, and a small kernel packs the highlighter's display kinds into 2 bits. Sure: both exist here as kernels around the highlighter's own unchanged pass, which gave the scope bits of a million documents with every bit equal to the plain JavaScript highlighter's.
3. **Two changes to the search program itself.** The class of a byte from one table read of 256 cells instead of 33 comparisons. And a program for "which documents match" that is the reverse pass alone, since a document has a match exactly when some position can start one. Sure of both: the first is one index read, and the second leaves out a stage. One bit per document then needs a second small pass or an atomic OR in the emitter's output, which cost nothing that could be measured.
4. **The page.** Workers that write the documents' bytes, four buffers for a device with default limits, bits read back, a map of 1,000 by 1,000 cells without gaps, the text of the one document on screen written when it is shown, and a message or a second layout for a pattern that reads code points past U+00FD. Sure, since each part ran in the measurement page except the message.

What each part buys, for a million documents after a pause, at 8, 16 and 32 states: today's program takes 74 ms, 0.6 s and 8.9 s with 4.1 GB of buffers. Part 1 alone gives `bitRowKernel`'s times on today's layout, 37, 39 and 50 ms. Bytes instead of f32 values give 33, 38 and 49 ms with 0.6 GB of buffers, the class from one table read 24, 30 and 40 ms, and the reverse pass alone 14, 18 and 25 ms.

## Can the code writer do it?

Cheng asked: "does the program as written change? Or it's just compiler optimizations we need?", and whether the rewrite wasn't built for lack of time or because of an unknown. The unknown was whether packing the table reads can be a general rule of the GPU code writer, or only fits what one helper writes. This section is the answer, measured on October 14, 2026 on the same machine. The writer is [bit-emit.ts](../bit-emit.ts), next to loop-emit.ts, which is unchanged and is still what the demo page runs.

- **Yes: the writer produces rewrite 2's form from the unchanged search program, and runs within 0.5 ms of it.** For 100,000 documents, back to back, bit-emit.ts's shader takes 3.5, 3.4 and 4.4 ms at 8, 16 and 32 states, the hand-written rewrite 3.0, 3.4 and 4.0 ms in the same run, and loop-emit.ts's shader 7.2, 63 and 944 ms. After a pause of 200 ms: 9.9, 11.0 and 13.5 ms, against 8.6, 10.6 and 13.0 ms and 17.2, 66 and 972 ms. With a scope, which is what the demo page runs: 4.4, 4.5 and 5.6 ms back to back and 11.3, 12.0 and 14.1 ms after a pause, where loop-emit.ts's shader takes 7.7, 65 and 941 ms and 17.4, 66 and 994 ms.
- **The rules are general, and the program doesn't change.** Each rule is a statement about a compiled stage: an operation's kind, terms and weights, an index read's candidates and out-of-range rules, and the ranges, grids and exact bits that the circuit keeps per wire. No rule names regex search, `createStepAnd`, a state count or a position. The rules fire on programs written without `createStepAnd` and `noneOf`, with their index reads and gates written out, and don't fire on six near misses. search-step.ts, data-program.ts, bits.ts and `orExclusive` are unchanged. One declaration is new: the circuit keeps which cells are declared exact bits, and no compiled program changed with it.
- **Every value is the same.** On the GPU, 3,386,100,000 outputs of bit-emit.ts's shaders against loop-emit.ts's over 100,000 documents, for the search, the highlighter and a third program, 0 mismatched. Through the WGSL interpreter, both writers' shaders against the CPU executor on every case of search.test.ts and on 14 small programs.

So the program is still only affine sums, ReGLU gates and index reads, and differentiable as before. What is new is how the GPU code writer writes each operation for inference.

### What the writer proves

A value is "whole" when it is proven to be a whole number within ±2^24, e.g. a class within 0..16, and a whole number within 0..1 is a bit. A whole number is an `i32` in the shader and a bit a `u32` that holds 0 or 1. A source cell is whole by its declaration: an exact bit, or a grid of 1 or more with a range inside ±2^24, e.g. `input([0, 16], {grid: 1})`. An operation is whole when its operands are whole, its weights and biases are whole numbers, and the bias's absolute value plus, for each term, the weight's absolute value times the operand's largest absolute value is at most 2^24. FP32 holds every whole number up to 2^24, so the f32 statement computes every product and every partial sum without rounding, in any order, and `i32` arithmetic gives the same number. An index read is whole when every candidate that its index can reach is whole. An operation that the circuit declares on a grid with a small range is whole too, e.g. the bit that emitCompare returns from a sign cascade.

The circuit's own grids don't reach far enough for this: an index read gets no grid, so in the search step nothing after the class read has one. The writer runs its own pass over a stage's operations.

A register or a field is held as an integer only when the cells bound to it are declared whole and every stage that writes it writes a proven whole number, a proven bit for a register of bits. The writer starts from the declarations, holds a register as f32 when some stage writes an unproven value into it, and proves the stages again until nothing changes. The declared range of a cell that is bound to a register is taken as the builder takes it, e.g. a match count within 0..512: the writer proves that every write is a whole number, and doesn't prove that a counter stays below its declared maximum.

### The rules

Each rule says which operations it matches, what it writes, and why the integer statement gives the f32 statement's value for every input that the declared ranges allow.

1. **Sum.** An affine operation that is whole is an `i32` sum, e.g. `1i - i32(notContinuing) + 2i * i32(start)` for a position's mark. JS: `!bit`, as `1 - bit`, is `bit ^ 1u`. Nothing rounds, by the proof above.
2. **Gate.** A ReLU gate `max(0, bias + Σ weight × value)` over whole values matches when the bias plus the positive weights is exactly 1, every value with a positive weight is a bit, and every value with a negative weight is never negative. The rule writes the AND of the bits with a positive weight and of "no value with a negative weight is 1 or more", e.g. `relu(a - b)` is `a & (b ^ 1u)` and `relu(1 - a - b - c)` is `(a | b | c) ^ 1u`. The sum is at most 1, and it is 1 only when every bit with a positive weight is 1 and every value with a negative weight is 0: one such bit at 0, or one such value at 1 or more, takes at least 1 off, since the weights are whole numbers. Any other whole gate is `u32(sum > 0i)` when its range is within 0..1 and `max(sum, 0i)` otherwise, and a ReGLU product is `(left sum) * max(gate sum, 0i)`.
3. **Comparison.** In a gate of rule 2, a value with a negative weight that is itself `max(0, sum)` of whole numbers is tested as `sum <= 0`, with the subtracted terms on the right. So the two gates that emitCompare builds for `codePoint >= boundary`, `relu(1 - relu(boundary - codePoint))`, are `u32(boundary <= codePoint)`, and the inner gate has no statement. `max(0, sum)` is 0 exactly when the sum is 0 or less.
4. **Read.** An index read whose index form is whole computes the index as an `i32` sum without a floor, keeps the clamp and the selects for a side that reads +0 only where the index's range reaches that side, and converts the value with `u32()` or `i32()` when every reachable candidate is a bit or whole. The floor of a whole number is the number itself, and a clamp to a range that the index never leaves changes nothing.
5. **Packed reads.** A gated read is an index read whose candidates are all shared cells declared as exact bits, and whose index form is `base + gate`: `gate` is the bias plus the terms over bits whose weight is at least the table's length, and for every combination of those bits either `gate` is one fixed number, where the read is `table[base]`, or the index lies past an end of the table that reads +0. The writer goes through the combinations, 16 at most. So the read is `table[base] && open`, with `open` a function of the gating bits. JS for what `createStepAnd` writes: `transitions[class][from][to] && bit`, as a read at `class + 16 × (1 - bit)` in a table of 16. The rule matches two or more gated reads with a negative weight in one gate of rule 2 that have the same base, and writes `(packed_words[start + base] & opens) == 0u`: bit k of the word at `base` is table k's cell at `base`, and bit k of `opens` is read k's `open`. Bit k of the AND is then read k, and the gate needs all of them to be 0. A side of the table that reads +0 is a word of zeros next to the table's words, e.g. a 17th word for class 16, the class that no step reads.
6. **Lanes.** Bits that are stored together are one `u32` word, each bit at its own position in the word, its lane: a field of bits, and registers of bits that the same stages write, e.g. the 8 `reached[s]` bits. Where a word is needed, i.e. for such a field or such registers, for the open bits of rule 5, and for the bits that must all be 0 in a gate of rule 2, a list of bits is one word expression when the bits are neighboring lanes of a stored word, shared cells (packed once per document), gated reads with one base (rule 5's word itself), the negations of such a list, or gates of one form whose operands are such lists, the first operand of every gate, the second, and so on. E.g. `continuing[s] = relu(reached[s] - notReach[s])` for 8 states is `reached & (notReach ^ 255u)`, and "no state continues" is `continuing == 0u`. AND, OR and XOR compute each bit of a word from the same bit of their operands, so bit k of the word operation is gate k of rule 2. Any other list of bits is written into its lanes one by one, `b0 | (b1 << 1u) | ...`, which is what loop-emit.ts does for a field of bits. A word of registers only pays when the stages read it as a word, so the writer writes the stages a second time with plain variables for a word of which half the registers or more were read one by one.
7. **Everything else** is the f32 statement that loop-emit.ts writes, from the same row writer in emit.ts, with `f32()` where the statement reads a whole number, and `u32()` or `i32()` where an integer statement reads a value that the circuit declares whole. In the highlighter's step, the 15 statements of a sign cascade stay f32 between integer statements.

**Two gating bits.** The forward step's reads from state 0 have the index `16 + class - 16 × continuing[0] - 16 × start`. With both bits at 1 the index would be `class - 16`, which clamps to row 0, so these reads are gated reads only if the two bits are never both 1. `orExclusive`'s caller knows that, and the compiled program doesn't say it. The writer proves it: it takes both bits as 1 and follows the gates. A gate of rule 2 that is 1 says that its bits with a positive weight are 1 and its values with a negative weight are 0, and `1 - bit` says the opposite of its bit. `start` is `relu(notContinuing - notReach[0])`, so notContinuing is 1. notContinuing is `relu(1 - Σ continuing[s])`, so continuing[0] is 0, which contradicts continuing[0] at 1. A combination that can't happen counts as open, so `open` is `continuing[0] | start`.

Statements are written when a later statement or an output first needs them. So a table read that only feeds a packed word, the inner gate of a comparison, and a gate that a word operation computes have no statement of their own. The search step's shader is 141, 165 and 213 statements at 8, 16 and 32 states, where loop-emit.ts writes 496, 1,368 and 4,648. Its forward step at 8 states, without the mark and the match count:

```wgsl
let c_w1: u32 = field1[j];                  // the 8 notReach bits of this position
let c_m0: u32 = rw1 & (c_w1 ^ 255u);        // continuing = reached & ~notReach
let c_v1133b: u32 = u32(c_m0 == 0u);        // notContinuing
let c_f1108b: u32 = (c_w1 >> 0u) & 1u;      // notReach[0]
let c_v1190b: u32 = c_v1133b & (c_f1108b ^ 1u);   // start
let c_f1107i: i32 = field0[j * 1u + 0u];    // the code point's class
let c_m1: u32 = c_m0 | c_v1190b;            // the open bits: continuing, and start in lane 0
let c_v1201b: u32 = u32((packed_words[u32(136i + c_f1107i)] & c_m1) == 0u);   // no step into state 0
// ... the same for states 1 to 7, at 153i, 170i, and so on
let c_m2: u32 = c_v1201b | (c_v1202b << 1u) | (c_v1203b << 2u) | (c_v1204b << 3u) | (c_v1205b << 4u) | (c_v1206b << 5u) | (c_v1207b << 6u) | (c_v1208b << 7u);
let c_m3: u32 = c_m2 ^ 255u;
rw1 = c_m3;                                 // the next reached bits
```

### The facts the writer needs, and how each is carried

| Fact | Who knew it | How the writer gets it |
| --- | --- | --- |
| Which shared cells hold exactly 0 or 1: the transition cells, the accepting cells, the kinds that a scope reads | The cell's declaration, `inputBit()`. Only cells.ts's validator kept it. The circuit kept the range 0..1, which also allows 0.5 | **New:** `Circuit.exactBits`, set by `assumeBit(wire)`, which cells.ts's `createCircuit` calls for every cell declared as an exact bit |
| Which other cells are whole numbers | The cell's declared grid and range, e.g. `input([0, 16], {grid: 1})` | The circuit's `grids` and `ranges`, as before |
| Which operations are whole | Nobody: the circuit's grids stop at an index read | The writer's own pass over the stage's operations, and for an operation that the builder declares, e.g. emitCompare's bit, the circuit's grid and range |
| Which registers and fields hold bits or whole numbers | The declarations of the cells bound to them | Those declarations, and a proof that every stage writes a whole number or a bit. `fields[].bits` of the loop program is only a layout, as in loop-emit.ts |
| That `continuing[0]` and `start` are never both 1 | `orExclusive`'s caller | Proven by the writer from the gates, see above. No declaration |
| That the reads of one gate have the same base, and which cells go into one word | Nobody | Each read's index form, candidates and out-of-range rules. The writer hands the runner the plan |
| Which registers are the lanes of one word | Nobody | The stages that write them |

**The one change outside the code writer, the runner and the interpreter.** src/runtime/numeric-ui-core.ts gets `exactBits`, one boolean per wire, and `assumeBit`, and src/runtime/cells.ts's `createCircuit` calls `assumeBit` for each exact bit cell. Nothing in the builder or the compiler reads the declaration. `assumeGrid(wire, 1)` would say the same about a value within 0..1, but a grid changes what is built afterwards, e.g. emitCompare builds integer bits instead of a sign cascade for a sum that reads the wire, which is why `stateBit` and `event` take the grid as an option. That no compiled program changed was checked two ways. A digest of every layer's arrays, the roots and the wire order is the same before and after the change for the search step's three stages at 8, 16 and 32 states with and without a scope, the highlighter's two stages, regex search and the masked search with every position written out, HandwiredOS (4,254 operations, 123 layers) and the photo gallery (1,759 operations, 67 layers). And a test in tests/runtime/cells.test.ts builds one program twice, over `inputBit()` cells and over cells within 0..1, and expects equal operations, grids and compiled layers. The tests of tests/, lab/json-search and lab/regex-search pass.

Two ways to carry "never both 1" that weren't needed: `orExclusive` could declare the pair with `assumeOneHot([a, b], true)`, or a range of 0..1 on the sum. Either is a builder helper recording what its caller promises. The proof inside the writer needs neither, and it also refuses a pair that can both be 1.

### The packing plan, and what a runner does with it

`emitBitLoopWgsl(loop)` returns loop-emit.ts's module and `packedCells`: for each word of the buffer `packed_words`, the shared cells that are its bits. The runner packs the words from the shared values without knowing the program:

```ts
// bit-emit.ts. Bit b of word w is the shared cell packedCells[w][b], which holds 0 or 1. A word without cells is 0.
export function packWords(packedCells: readonly (readonly number[])[], shared: Float32Array, target = new Uint32Array(packedCells.length)) {
  for (let word = 0; word < packedCells.length; word++) {
    const cells = packedCells[word]!
    let bits = 0
    for (let bit = 0; bit < cells.length; bit++) if (shared[cells[bit]!] !== 0) bits |= 1 << bit
    target[word] = bits
  }
  return target
}
```

gpu/host.ts's `createProgramRunner` creates `packed_words` after the output buffers when the shader has a plan, and calls `packWords` when it is created and each time shared values are uploaded, e.g. a new pattern's cells. The same function fills the words for the WGSL interpreter in the tests. The plans it applied:

| Program | Words | What a word holds |
| --- | --- | --- |
| the search step at 8, 16 and 32 states, with or without a scope | 272, 544 and 1,088 | 17 words per gate, one per class and one of zeros for class 16, each with 8, 16 or 32 transition cells. Every transition cell is in two words, once by row for the reverse step and once by column for the forward step, as in bit-rows.ts's hand-written tables |
| the characters of the wanted sets | 130 | a word of zeros, 128 words of 4 bits, one per code point below 128 and one bit per set, and a word of zeros |
| flags, `manyTables` | 12 | 6 words of 32 flags and 6 words of 8 flags: 5 rows and a word of zeros, for 40 tables |
| flags, `zeroBelow` | 7 | a word of zeros, 5 rows of 3 flags, a word of zeros |
| flags, `ungated` | 5 | 5 rows of 3 flags, without a word of zeros, since a row past the table reads the last row |
| switches, `lanes` | 6 | 5 rows of 6 cells, and a word of zeros |

On the GPU, host.ts's runner applied the search step's plans in every run below, and the plan of the characters' program in `writers-100000`. The small programs' plans were applied by the same function for the interpreter.

### The programs, and which rules fired

The numbers are operations of one position. "Packed reads" is how many index reads became bits of how many word reads. The last two columns are the statements of each writer's shader. bit-emit.test.ts pins each row's rule counts.

| Program | Operations | Sum | Gate | Comparison | Other gates and products | Read | Packed reads | Lanes | f32 statements | Statements, loop-emit.ts | Statements, bit-emit.ts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| the search step, 8 states | 248 | 3 | 51 | 33 |  | 1 | 128 in 16 | 32 |  | 496 | 141 |
| the search step, 16 states | 680 | 3 | 67 | 33 |  | 1 | 512 in 32 | 64 |  | 1,368 | 165 |
| the search step, 32 states | 2,312 | 3 | 99 | 33 |  | 1 | 2,048 in 64 | 128 |  | 4,648 | 213 |
| the search step, 8 states, with a scope | 251 | 4 | 51 | 33 | 1 | 2 | 128 in 16 | 32 |  | 503 | 147 |
| the search step, 16 states, with a scope | 683 | 4 | 67 | 33 | 1 | 2 | 512 in 32 | 64 |  | 1,375 | 171 |
| the search step, 32 states, with a scope | 2,315 | 4 | 99 | 33 | 1 | 2 | 2,048 in 64 | 128 |  | 4,655 | 219 |
| the JSON highlighter's step | 54 | 12 | 1 | 1 | 7 | 18 |  |  | 15 | 107 | 103 |
| the characters of the wanted sets | 7 | 2 | 1 |  |  |  | 4 in 1 |  |  | 36 | 30 |
| flags, `gated` | 7 | 2 | 2 |  |  |  | 3 in 1 |  |  | 37 | 33 |
| flags, `ungated` | 7 | 2 | 2 |  |  |  | 3 in 1 |  |  | 34 | 29 |
| flags, `manyTables` | 44 | 2 | 2 |  |  |  | 40 in 2 |  |  | 149 | 71 |
| flags, `zeroBelow` | 7 | 2 | 2 |  |  |  | 3 in 1 |  |  | 37 | 33 |
| flags, `exclusiveBits` | 9 | 2 | 4 |  |  |  | 3 in 1 |  |  | 40 | 37 |
| switches, `lanes` | 15 | 2 | 1 |  |  |  | 6 in 1 | 6 |  | 61 | 37 |
| near miss: flags, `shortGate` | 7 | 2 | 2 |  |  | 3 |  |  |  | 37 | 38 |
| near miss: flags, `fractionInGate` | 7 |  |  |  |  | 3 |  |  | 4 | 38 | 41 |
| near miss: flags, `differentIndexes` | 7 | 2 | 2 |  |  | 3 |  |  |  | 37 | 38 |
| near miss: flags, `fractionAsBit` | 7 | 2 | 2 |  |  |  |  |  | 3 | 37 | 38 |
| near miss: flags, `twoFreeBits` | 7 | 2 | 2 |  |  | 1 | 2 in 1 |  |  | 38 | 36 |
| near miss: switches, `oneByOne` | 9 | 2 | 7 |  |  |  |  |  |  | 42 | 43 |
| bits next to ordinary numbers | 21 |  |  |  | 1 | 2 |  |  | 18 | 50 | 49 |
| a field declared as bits, without a proof | 4 |  |  |  |  |  |  |  | 4 | 33 | 33 |

- **The search step.** Every operation is written by a rule at each capacity, and no f32 statement is left. Four operations per state are lanes of a word operation: the first notFinish bits, the next notFinish bits, continuing, and the next reached bits.
- **The highlighter's step** has no gated reads. Its tables are whole numbers, so its reads and sums are integer statements, and the comparison of the container code with a level weight is a sign cascade whose 15 operations multiply by 2^24 and stay f32.
- **The characters of the wanted sets** ([character-sets.ts](character-sets.ts)) runs over the same documents as the search: which characters are digits, lowercase letters, uppercase letters or JSON's punctuation, for the sets that are wanted, and how many. Four tables of 128 bits are read at the code point, with `indexReadAffine` and one gate written out. Its whole step is `u32((packed_words[1 + clamp(codePoint, -1, 128)] & wanted) == 0u)`, with the four wanted cells packed into a word once per document.
- **flags** asks "does any wanted flag hold at this row?" for each of a document's 12 rows: 3 tables of 5 flags, read with `indexReadAffine` directly, one gate over the reads, a count and a bit carried in registers. `gated` is the form of rule 5. `ungated` reads without a gating bit, so every read is always open and the word needs no AND. `manyTables` has 40 tables, two words. `zeroBelow` has rows from -1 on and reads +0 below the table. `exclusiveBits` gates table 0 by two bits `p && !q` and `p && q`, which the writer proves never both 1, by other gates than the search step's.
- **switches, `lanes`** keeps six switches on while a table and a shared cell don't turn them off. Its six gates are one statement, `rw0 & ((sw0 | a_m0) ^ 63u)`, with `a_m0` the packed word of six tables at the row, and "no switch is on" is `a_m1 == 0u`.
- **The near misses**, where a rule must not fire, and doesn't. `shortGate`: rows start at -1 and an unwanted table's index moves by 5 where 6 is needed, so its row -1 reads row 4, and no read is `table[row] && wanted`. This one wasn't planned: it was the first `zeroBelow`, and the rule refused it. `fractionInGate`: the gate also subtracts a number within 0..1 that isn't whole, so the gate, the count and the carried bit are f32 statements, the two registers are held as f32, and the reads are bits read one by one. `differentIndexes`: table k is read at row + k, so no two reads have the same base, and each is read on its own as a bit. `fractionAsBit`: the gating value is declared within 0..1 and not as a bit, and holds e.g. 0.5, where the read is two rows further on: the index isn't whole and keeps its floor. `twoFreeBits`: table 0 is gated by two bits that can both be 1, where the read is row 0 through the clamp, so table 0 is read on its own and the other two tables are still one word. `oneByOne`: each switch reads two other switches, so the word of registers is given up and the registers are variables.
- **Bits next to ordinary numbers**: a value such as 12.5 is compared with a limit by a sign cascade (f32), the result is a bit that the builder declares, a streak is counted in `i32`, a total of f32 weights is summed in f32, and a whole bucket picks the weight.
- **A field declared as bits, without a proof**: the loop program says `bits: true` for a field whose values come from a cell declared within 0..1 and not as a bit. The field is still one word per position, as in loop-emit.ts, its bits are read back as f32 values, and the count that reads them is an f32 register.

### The values that were compared

- **On the GPU, shader against shader**, `writers-100000`, the 'writers' mode of page.ts, at a load average of 4.1 to 4.9: every output of bit-emit.ts's shader against loop-emit.ts's for 100,000 documents. The highlighter's summary and display kinds: 51,600,000 values, 0 mismatched. The count and the marks of the characters' program for 5 choices of sets: 256,500,000 values, 0 mismatched, and each of the 500,000 counts, 48,340,424 characters in all, equals the count of a plain JavaScript loop over the text. The search step's match count of every document and mark of every position, for the six patterns at each capacity that holds a pattern (4 at 8 states, 5 at 16, 6 at 32), without a scope and with each of three scopes, 60 searches: 3,078,000,000 values, 0 mismatched, with 1,254,405 matches among them. In total 3,386,100,000 values.
- **On the GPU, against the lab's plain JavaScript loop**: every timed search of the two timing runs below, 11,419 searches, 1,141,900,000 match counts, 0 mismatched.
- **Through the WGSL interpreter, against the CPU executor.** search.test.ts runs both writers' shaders wherever it ran loop-emit.ts's: the 274 patterns of 8 states with 8 texts each, with either kind of field and stopping at the text's end; 16 and 32 states with patterns of exactly that many states; 512 positions over generated documents; the search with a scope over five scopes; and the highlighter's 2,509 texts. bit-emit.test.ts runs the 14 small programs for 40 shared tables and 6 documents each, 3,120 to 3,360 values per program and writer, 0 different, and the characters' program over 26 documents against the plain JavaScript count.

### The timings

One search of 100,000 documents as one f32 per code point, ms, as in table 6: back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample. From `compact-100000-second`, at a load average of 5.7 to 9.0, with a rest of 3 s before each series. All engines ran in the one Chrome process.

| What runs on the GPU | The search reads | 8 states | 16 states | 32 states |
| --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 7.18 (6.99 to 7.92); 17.2 (8.11 to 17.5) | 63.1 (61.3 to 67.6); 65.5 (62.7 to 66.9) | 944 (933 to 976); 972 (924 to 1016) |
| the same step, as bit-emit.ts writes it | everything | 3.49 (3.37 to 4.05); 9.89 (3.86 to 10.2) | 3.43 (3.25 to 4.16); 11.0 (10.7 to 11.5) | 4.42 (4.22 to 5.72); 13.5 (7.45 to 14.1) |
| rewrite 2, written by hand | everything | 2.96 (2.88 to 3.75); 8.57 (8.26 to 8.86) | 3.35 (3.23 to 3.71); 10.6 (3.67 to 10.9) | 3.99 (3.89 to 5.12); 13.0 (5.38 to 13.6) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | everything | 7.71 (7.40 to 9.34); 17.4 (7.64 to 17.8) | 65.2 (62.7 to 68.8); 65.7 (64.1 to 68.3) | 941 (933 to 1010); 994 (979 to 1037) |
| the same | string values | 7.61 (7.33 to 8.47); 17.3 (8.02 to 17.7) | 66.1 (63.8 to 68.6); 66.4 (64.2 to 67.7) | 1045 (1008 to 1161); 1033 (985 to 1104) |
| the same | keys | 7.56 (7.35 to 8.27); 17.2 (8.43 to 17.4) | 66.4 (63.1 to 69.3); 66.3 (63.8 to 69.7) | 1106 (1093 to 1161); 1094 (1041 to 1134) |
| the step with a scope, as bit-emit.ts writes it | everything | 4.42 (4.22 to 5.25); 11.3 (4.45 to 11.9) | 4.49 (4.32 to 4.95); 12.0 (5.29 to 12.2) | 5.55 (5.11 to 6.32); 14.1 (6.42 to 14.6) |
| the same | string values | 4.30 (4.13 to 4.61); 11.1 (4.97 to 11.6) | 4.60 (4.33 to 5.15); 11.9 (4.63 to 12.3) | 5.62 (5.12 to 6.75); 14.2 (6.91 to 17.5) |
| the same | keys | 4.32 (4.20 to 4.99); 11.1 (4.88 to 11.4) | 4.52 (4.36 to 6.14); 11.9 (5.03 to 12.1) | 5.53 (4.98 to 8.98); 14.2 (6.75 to 18.3) |

- **A first run gave the same picture**, `compact-100000`, load average 4.5 to 8.9. Back to back, everything: 7.68, 65.0 and 919 ms for loop-emit.ts's shader, 3.52, 3.66 and 4.78 ms for bit-emit.ts's, 3.01, 3.67 and 4.36 ms for rewrite 2. With a scope, everything: 7.82, 67.2 and 1,133 ms against 4.43, 4.75 and 5.50 ms. In that run several series after a pause held searches at the back to back speed, e.g. a median of 6.62 ms for bit-emit.ts's shader at 8 states with samples from 4.21 to 11.1 ms, so its times after a pause say less.
- **The time to compile a shader**, ms, at 8, 16 and 32 states, each with a salt that no earlier run used, in the two runs: loop-emit.ts's shader 48, 130 and 543, and 44, 138 and 612. bit-emit.ts's 20, 22 and 39, and 17, 32 and 38. With a scope: loop-emit.ts's 52, 144 and 655, and 46, 148 and 568. bit-emit.ts's 21, 21 and 49, and 84, 62 and 169 in the first run, three slower compiles that weren't looked into. Rewrite 2: 16, 22 and 27, and 15, 25 and 28. The page compiles one shader per state capacity: in the second run the three shaders with a scope compiled in 0.09 s in all, where loop-emit.ts's took 0.85 s.
- **1,000,000 documents: not run.** The run needs one f32 per code point, 2.05 GB, and as much again for the display kinds with a scope. The rule for this job was to start it only with 16 GB of memory free, and run.ts found 15.99 GB at the one attempt, with 5.9 of 7.2 GB of swap in use, and didn't start. From the 100,000 documents, ten times the work would be 35 to 45 ms back to back without a scope, which nobody measured.

### What failed, and what was tried

- **Registers of bits as one word without the Lanes rule.** Before rule 6, the shader took 3.2, 3.6 and 5.9 ms at 8, 16 and 32 states, where rewrite 2 took 2.7, 3.2 and 4.0 ms in the same run: every state's bit was its own `u32`, so each position unpacked a word into 32 bits, ran 32 ANDs, and packed 32 bits again. Holding the registers as lanes of one word while writing every operation as before was slower, 8.6 against 7.2 ms at 32 states in one run: the Metal compiler doesn't put the lanes back together. The writer has to see the word operation.
- **A gate form that matched too much.** With gated reads allowed as lanes, the eight notReach gates of the reverse step also match rule 6 the other way around, as "one gate form in every lane", where every lane's open bit is the same register written eight times. Gated reads now count as lanes only when their open bits are a whole word too. Otherwise each gate keeps its own reads.
- **The 0.5 ms that are left at 8 states** weren't found. bit-emit.ts's shader takes 3.5 ms where rewrite 2 takes 3.0 ms. At 16 states the two are within 0.1 ms, and at 32 states bit-emit.ts's shader is 0.3 to 0.4 ms slower, about 10%, in every run. Two differences were taken out in turn and the time stayed: the mark of every position, which rewrite 2 doesn't compute, and the shared cells read once before the loops, e.g. the 32 class boundaries, where rewrite 2 reads them where it uses them. Not tried: comparing code points as f32, as rewrite 2 does, where bit-emit.ts converts the code point to `i32` and compares integers.
- **A first version of rule 2 wrote `[codePoint >= 0]` as two statements**, since the inner gate `relu(-codePoint)` is itself within 0..1 and was taken for a bit before it was taken for a comparison. The order of the two tests was the fix.
- **Nothing failed in the values.** No run found a mismatch, and the first shader compiled on the GPU as written. The interpreter refuses two things that would show a writer's mistake, and neither fired: `i32()` of a number that isn't whole, which WGSL truncates, and a mix of `|`, `&` and `^` without parentheses, which WGSL refuses too.

### What is still unknown

- **Any other GPU or browser.** Every run was headless Chrome 155 on the one Apple M5 Max. Whether integer comparisons and bit operations are as fast as f32 statements elsewhere isn't measured.
- **A million documents with this writer**, see above, and the writer on bytes instead of one f32 per code point: parts 2 and 3 of "What would have to be built" are as they were.
- **The page.** searcher.ts and the demo page still run loop-emit.ts's shader. What a runner needs is in host.ts already: a shader with `packedCells` gets its `packed_words` buffer. A second job puts `emitBitLoopWgsl` into searcher.ts.
- **Programs with other forms.** Gated reads with a positive weight in a gate, i.e. "every one of these reads is 1", are read one by one, not packed. A register word is built from the registers' order and their writers, so two groups of registers that one stage writes together share a word, and whether that helps depends on the program. A loop program with a gather isn't written at all, as in loop-emit.ts. The rules were run on the two programs that the page has and on 15 programs written to probe them, by the writer's author.
- **The declared range of a cell bound to a register is trusted**, as the builder trusts it. A register that leaves its declared range could make rule 2 or rule 4 write another value than the f32 statement. The writer proves that a register holds a whole number, and for a register of bits that it holds 0 or 1.
- **Why a search after a pause varies**, as in the first check: within one series after a pause of 200 ms, single searches ran at the back to back speed.

### The writer's size

bit-emit.ts is 1,032 lines, 836 of code and 166 of comments, where loop-emit.ts is 242. About 75 of them write the shader around the stages a second time, as loop-emit.ts does, since loop-emit.ts stays as it is. Writing the search step's shader at 32 states takes the writer 14 to 18 ms in Bun, where loop-emit.ts takes 3 to 7 ms. bit-emit.test.ts is 491 lines. Outside the writer: 27 lines in gpu/host.ts for the packed words, 77 in wgsl-interpreter.ts for integer statements, 28 in src/runtime for the exact bit declaration, and the two modes of page.ts and the table of summarize.ts for the measurements.

## Not measured, and what went wrong

- **Any other machine, browser or GPU, and a page with a real display.** Every run was headless Chrome 155 on one Apple M5 Max, whose adapter allows buffers of 4,294,967,292 bytes. Not measured, and from WebGPU's default limits alone: a device without larger limits binds 134,217,728 bytes per storage buffer, creates buffers of up to 268,435,456 bytes, binds 8 storage buffers per shader stage and dispatches 65,535 workgroups per dimension, so the four buffers of 128,000,000 bytes, the scope bits in one binding of 128,000,000 bytes, the kernel's 4 storage buffers and a dispatch of 3,907 workgroups per buffer all fit. Whether another device has 1.7 GB for the GPU process during the load, or how fast its GPU runs these loops, isn't measured.
- **A quiet machine.** The 1-minute load average was 2.0 to 7.9 over the review's runs, and 1.4 to 11.9 over the first runs. Noisy in the review's runs: the back to back series at 32 states of `compact-1000000` for the count with a scope, the one-bit answer without a scope and the four buffers; `bitRowKernel`'s back to back series at 16 and 32 states of `compact-1000000-short`; the program's back to back series at 8 states for everything and for keys, which rose from 65 to 111 ms; and several series after a pause that hold one search at the back to back speed, e.g. 8.4 ms in a series whose median is 14.1 ms.
- **Why the GPU gets slower during some back to back series.** The time rises from one search to the next and falls again during pauses. Whether the GPU's own power management, its temperature or another process's work on the same GPU is the reason wasn't found.
- **An emitter**, when this check ended. Rewrite 2 is its result written by hand, for the search step without a scope, on one f32 per code point. The emitter exists since, see [Can the code writer do it?](#can-the-code-writer-do-it)
- **The marks of the document on screen.** The kernels return counts or bits. A page would run a second small pass over the documents that it shows, as today's page does.
- **UTF-8, or 2 bytes per code point** for a pattern that reads code points past U+00FD, and packed bytes in several buffers.
- **A load from the network.** The workers write the documents themselves, 3.7 to 4.5 s of worker time. A real page would download about 300 MB, and would have to keep the texts.
- **Keeping the GPU awake with larger work during a pause.** Only searches of 64 documents every 16 or 50 ms were tried.
- **Other ways to make regular JavaScript faster**, e.g. one RegExp with the g flag over all documents joined into one string. The review timed the plain forms only, see under table 3.
- **What went wrong.** The first version of the kernel over four buffers read empty buffers, a bug in the measurement page that the comparison caught, with 3.1 million mismatched values, and that was fixed before any run in results/. Nothing failed to fit: the 2.05 GB `Float32Array` and its single `writeBuffer` in `createGpuSearcher` worked. No run was stopped by the memory watch: the least memory available during a run was 9.4 GB in the first runs and 10.3 GB in the review's.

## How to run it

From the repo root. Each run starts its own headless Chrome with WebGPU on a new profile folder, and ends it before the next run starts, since a page with a million documents holds several GB. run.ts reads how much memory is free before a run of 500,000 documents or more, and stops a run whose Chrome leaves less than 3 GB available.

```sh
bun lab/json-search/million/all.ts --out <folder>                    # every run, about two hours
bun lab/json-search/million/all.ts --out <folder> --group load       # tables 1 and 2: the load and the memory per layout, the scope bits from the GPU
bun lab/json-search/million/all.ts --out <folder> --group compact    # tables 3, 5 and 6: the kernels at 100,000 to 1,000,000 documents, the map, the rewrites
bun lab/json-search/million/all.ts --out <folder> --group rested     # table 3 again: the kernels at 1,000,000 documents with a rest before each series
bun lab/json-search/million/all.ts --out <folder> --group program    # tables 1 and 3: searcher.ts, what the demo page runs today
bun lab/json-search/million/all.ts --out <folder> --group js         # table 3: regular JavaScript, after a pause, and its other plain forms
bun lab/json-search/million/all.ts --out <folder> --group warm       # a search after a pause in which the GPU was kept busy
bun lab/json-search/million/stats.ts > <folder>/stats.txt            # the documents and the patterns on bytes, without a GPU
bun lab/json-search/million/summarize.ts --from <folder>             # every table, as markdown: results/tables.md
bun lab/json-search/million/summarize.ts --from <folder> --table report [--kernel-run compact-1000000-short]   # the tables above
bun lab/json-search/million/step-bits.ts                             # which operations of the program's search step hold 0 or 1
bun lab/json-search/million/answers-run.ts --out <new folder> --profile <new folder>   # what each kernel returns for every document
bun lab/json-search/million/independent.ts --answers <that folder>   # table 4's second part: the answers against RegExp and JSON.parse
# "Can the code writer do it?": the two timing runs, the values of both writers' shaders, and their tables
bun lab/json-search/million/run.ts --mode compact --count 100000 --engines rewrite-2,program-step,program-bits,program-step-masked,program-bits-masked --rest 3000 --profile <new folder> --out <folder>/compact-100000.json
bun lab/json-search/million/run.ts --mode writers --count 100000 --profile <new folder> --out <folder>/writers-100000.json
bun lab/json-search/million/summarize.ts --from <folder> --table writer
bun test lab/json-search/bit-emit.test.ts lab/json-search/search.test.ts   # the rules that fire, and both writers' shaders against the CPU executor
```

Table 4 comes from every kernel and program run. A single run is `bun lab/json-search/million/run.ts --mode compact --count 1000000 --profile <new folder> --out <file.json>`, and run.ts lists the other options. The ports are 4511 for the page and 9511 for Chrome's debugger unless `--port` and `--devtools-port` say otherwise. results/ holds the JSON files of the first runs, and tables.md, which `summarize.ts --from lab/json-search/million/results` printed. results/check/ holds the review's runs: the JSON files, tables.md, and independent.txt, which independent.ts printed.

## The files

| File | What it holds |
| --- | --- |
| `layouts.ts` | The compact layouts: what a byte is, 512 bytes per document, packed bytes with a start per document, 2 scope bits per position, and a pattern's tables for kernels that read bytes |
| `character-sets.ts` | A third loop program over the documents, for the code writer's check: which characters are in one of the wanted sets, and how many |
| `kernels.ts` | The WGSL kernels: `byteKernel` with its options (layout, class lookup, scope bits, counts or one bit per document), the pass that packs counts into bits, the two kernels around the highlighter's own pass, and `rewriteKernel`, what a mechanical rewrite of the program's search step would give |
| `engine.ts` | Runs one kernel over documents that are on the GPU and times one search, with the documents in one buffer or in several |
| `expected.ts` | What every search is compared with: the lab's plain JavaScript loop over the same automaton, per document and scope. Also the regular JavaScript searches |
| `page.ts`, `page.html` | The measurement page, one mode per run: `compact`, `program`, `load`, `js`, `scopes`, `writers` |
| `worker.ts` | The page's worker: writes pieces of the documents with their bytes and scope bits, or holds a share of the texts for the whole-text search in several workers |
| `run.ts`, `all.ts` | One run in its own Chrome, and every run in turn |
| `summarize.ts` | The tables from the runs' JSON files |
| `stats.ts`, `step-bits.ts` | The documents and patterns on bytes, and the program's search step read for values that are 0 or 1, both without a GPU |
| `answers-page.ts`, `answers-page.html`, `answers-run.ts`, `independent.ts` | The review's independent count: a page that posts what each kernel returned for every document, and a script that compares those answers with RegExp and JSON.parse, with none of expected.ts's code |
| `results/`, `results/check/`, `results/writer/` | The first runs' JSON files, stats.ts's output and every table; the review's runs: their JSON files, every table of them, and independent.ts's output; and the code writer's runs with their tables |

Two small changes outside this folder: `runPage` in gpu/chrome.ts takes more routes for its server and more flags for Chrome, and the lab's tsconfig.json includes this folder. The code writer and its tests are in the lab's folder: [bit-emit.ts](../bit-emit.ts) and bit-emit.test.ts.

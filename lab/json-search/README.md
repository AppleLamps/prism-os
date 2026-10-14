# The JSON highlighter and regex search over many documents on the GPU

## What it is

Cheng asked: "I was wondering if there's a point where regex search or json highlighter, or a combination of these into the same app, is clearly more performant from the gpu parallelism? Then we can make a demo where we search a ton of jsons or something". This folder answers that with measurements, and holds the pieces a demo page needs.

Both are fixed numeric programs. The JSON highlighter ([src/json-highlighter](../../src/json-highlighter/README.md)), built with its default limits, reads up to 512 code points from cells and returns what each character is shown as, where the first error is, and whether the text is valid. Regex search ([lab/regex-search](../regex-search/README.md)), in its form (a), reads a text and a pattern, both from cells, and returns the pattern's non-overlapping matches, leftmost and then longest. On the CPU executor one document takes 80 µs for the highlighter and 2 to 5 ms for a search of a pattern of up to 16 states, whatever the text, and a round trip to the GPU alone takes 0.6 ms or more, so one document is no case for a GPU. Many documents are: every document runs the same operations, and no document reads another one's values.

The folder was built in three stages:

1. **The highlighter with every position written out.** emit.ts writes the compiled program as one WGSL compute shader with one statement per operation, and one compute pass runs it once per document. 100,000 documents that are already on the GPU take 3.75 ms, against 87.5 ms for JSON.parse in the same page. The shader takes about 2 s to compile.
2. **Both programs as loops over a document's positions.** The work of one position is built once with the builder, and loop-emit.ts, this stage's code writer, writes it once in the shader, inside a `for` loop, with one f32 statement per operation. That is docs/patterns.md's pattern for repeated work. The highlighter's shader then compiles in 0.04 s and validates 100,000 documents that are already on the GPU in 2.2 ms. Regex search's shader compiles in 0.05 to 0.1 s at 8 states, where the same program with every position written out, at 256 positions, took 107 to 130 s in a scratch probe, and searches 100,000 documents in 7 ms when searches follow each other. A search can read only some kinds of characters, e.g. string values, by reading the highlighter's display kinds, which stay on the GPU. searcher.ts is one module that does all of it for a page, on the GPU or on the CPU.
3. **A second code writer for the search's shaders**, on October 14, 2026. A search step takes one table read per pair of states, so loop-emit.ts's shaders take 8, 69 and 945 ms for a search of 100,000 documents at 8, 16 and 32 states when searches follow each other. bit-emit.ts writes the same search program another way: a value that it proves to be 0 or 1 is a bit, and the table reads that one gate combines are one AND of two 32-bit words. Its shaders take 4.6, 4.7 and 5.2 ms when searches follow each other, and the demo page's searches run them: at a keystroke, a search on the page takes 12 to 15 ms, where it took 18, 77 and 900 ms. The program is unchanged, weighted sums, ReLU gates and table reads, and so is every value.

Every value that came back from the GPU was compared with a value computed on the CPU, and none differed: 7.3 to 7.6 billion per run in the first stage, against the CPU executor, 0.7 to 1.0 billion per run in the second, against a plain JavaScript highlighter and a plain JavaScript loop over the same automaton, which each run first compares with the programs on the CPU for its first 200 documents, and 1.1 billion per run in the third, the same way.

A review then ran the first two stages again, compared the GPU with the programs that have every position written out, on the CPU executor, for documents and patterns at the limits and for all 100,000 documents, timed JavaScript in several workers, and corrected this README where it claimed more than the measurements show. [What the review found, and what changed](#what-the-review-found-and-what-changed) has the list. Two more reviewers checked the third stage's writer, see [million/README.md](million/README.md#what-two-checks-found-and-what-was-done).

The demo page comes first, then the answer, how to run everything, what was built, the checks and every measurement. The measurements of October 13 are of stage 2's shaders, loop-emit.ts's, and their sections say so. [Measured results: the searcher with bit-emit.ts's shaders](#measured-results-the-searcher-with-bit-emittss-shaders) has the ones of the shaders that the searcher and the page use now.

## The demo page

demo.html is the page that the answer below allows: `bun start` serves it at /json-search/, and the demo site publishes it there. It searches 100,000 generated JSON documents again at each keystroke, on the GPU, and shows the search's own time next to RegExp's for the same search.

How it works:

- **The documents.** The page writes them itself, with documents.ts's generator and none of the documents that it breaks on purpose. So every document is valid JSON of up to 512 code points: a package manifest, a user record, a log event, editor settings, an order, a map feature or sensor readings, about 300 characters each, and which of them a document is follows from a hash of its index. Each document's characters go to the GPU once, as numbers.
- **The JSON highlighter** is one small step, built by hand from weighted sums, ReLU gates and table reads. It runs at each of a document's 512 positions, once when the page loads, and says what each character is, e.g. part of a key or of a string value. The page uses that answer twice: for the colors of the document that it shows, and to let a search read only keys or only string values.
- **Regex search** is a second such step. A keystroke turns the pattern into tables of numbers, and the step runs over each document's positions, backward and then forward, and counts the matches. It reads the highlighter's answer for each character from the GPU's memory.
- **One pass runs every document.** No document reads another document's numbers, so the GPU runs all of them at the same time. JavaScript gets back one match count per document, which it paints on the map, and a mark per character for the one document that it shows.
- **The GPU's code is written from the programs, before any pattern exists.** searcher.ts holds the search program in three sizes, for patterns of up to 8, 16 and 32 states, and a pattern runs on the smallest one that holds it, e.g. `error` on the first and the Try list's date on the second. A code writer, bit-emit.ts, writes each size's shader, and the page compiles all three when it loads, so no keystroke waits for a compile and no pattern is compiled into GPU code. [The second code writer](#the-second-code-writer-bit-emitts) says how that writer makes the three sizes take nearly the same time on the GPU. On the CPU, behind the page's toggle, a search on the largest takes 13 times as long as on the smallest, which is why there are three.

What the page shows, from top to bottom, and how each number is measured:

- **The pattern field with two toggles.** All, Keys or String values is what the search reads. GPU or CPU is where the search program runs.
- **One line of numbers**, e.g. "10,559 of 100,000 documents match. This program: 13 ms on the GPU. Native RegExp: 21 ms." The line names both, because "16 s on the CPU" alone reads as the time of the browser's own RegExp.
  - The count is the number of documents with at least one match.
  - The time on the GPU runs from before the pattern is compiled until every document's count is copied out of the GPU's buffer: compiling the pattern, uploading its cells, the pass and the readback, `timings.totalMs` of the searcher's result. No search's time holds a shader's compile, since every search program is compiled when the page loads.
  - RegExp's time is measured in a worker, on one thread, for the same pattern and the same documents: plain-search.ts runs `RegExp` on each document, or on each key or each string value, and counts every match. A pass that takes under 100 ms is made twice, and the faster one counts. Finding the keys and the string values happens once, with table-loop.ts's plain JavaScript highlighter, and isn't part of the time.
  - The page waits 10 s for RegExp's time, and then the line says "Native RegExp: more than 10 s." RegExp can backtrack for minutes, e.g. on `(([a-z]+)+)+x`, which has one pair of parentheses more than the Try list's pattern, and a `RegExp` call that is running can only be stopped by ending its worker. So this worker does nothing but time RegExp: the page ends it after those 10 s, or after 1 s when the timing is for a search that the page has left since, e.g. after another keystroke, and the next timing starts a new worker, which writes its documents again, about half a second.
  - A pattern with a syntax error, or one that needs more than the largest program's 32 states, gets a sentence in the line's place.
- **The map**: one cell per document, in the documents' order, row after row. A document with a match is copper, and its mark is larger than its cell, about 2 CSS px wide among 100,000 documents, so that a single match can be seen. The pointer picks the nearest document with a match, or the document under it where a search on the CPU hasn't been yet and when no document has a match. A click keeps the picked document, and Enter and Shift+Enter step to the next and the previous document with a match, as a browser's find bar does, with the focus in the field or anywhere else on the page except a link or a button.
- **One document**, colored by the highlighter's display kinds, with the search's matches marked. On the GPU both are read back for that one document: the kinds from the highlighter's output buffer, and the marks from a pass over that document alone.

With the toggle on CPU, or in a browser without WebGPU, both programs run in a second worker as generated JavaScript, through `createCpuSearcher`. That worker starts when the page first needs it:

- The worker searches the documents in their order, a piece of about 8 ms at a time, and posts each piece's counts. So the map fills in from the top while the line says how far the search is, e.g. "928 of the first 8,773 documents match. This program: 2.2 s on the CPU so far.", and a keystroke replaces the search in progress within a piece's time.
- The time in the line is the search program's own: the sum of the pieces' loops, `timings.evaluateMs`.
- The highlighter runs on a document when a search first reaches it, 93 µs per document, and its time isn't part of the search's, as it isn't on the GPU. So the first search on the CPU takes about 9 s longer on the clock than the line says, and every later one takes what the line says.

What the page leaves out on purpose:

- **It never says that the GPU beats RegExp or JavaScript.** The line gives both times for every pattern. RegExp's is the shorter one for the patterns that RegExp matches fastest, e.g. 13 ms on the GPU against 9 ms for the date of the Try list, and the longer one for others, e.g. 12 ms against 19 to 21 ms for `error` and for the Try list's email address and its keys, and 11 ms against 2.1 s for `([a-z]+)+x`, which makes RegExp backtrack.
- **It runs no self check when it loads.** Both programs hold only integers, which a GPU computes exactly in any order, and this folder's tests and its runs on the GPU compare the two backends, see [Correctness checks](#correctness-checks). `selfCheck` stays in searcher.ts for those: the tests run it on a GPU searcher whose passes the WGSL interpreter runs, and the measurement pages on the GPU.
- **It shows no documents with errors.** The lab's measurements keep the generator's 1 broken document in 10.

Other states:

- **A window narrower than 720 px**, e.g. a phone, gets 20,000 documents, and the title says so. 100,000 documents take 410 MB on the GPU, and on the CPU the worker for it holds 448 MB for them. The page decides once, when it starts: a window that changes its width later, e.g. a phone turned on its side, keeps its documents, and the title keeps their count.
- **A GPU whose buffers hold fewer documents** than the page wants gets the count that fits, and the page says so, in its title and in a sentence, e.g. "One buffer of this GPU holds 65,000 documents, so the page searches 65,000 instead of 100,000." `?buffer=134217728` in the page's address asks the GPU for buffers of at most that many bytes, which shows this state on a machine that grants more.
- **A first visit**, where the GPU has no compiled shader in a cache: `?salt=7` writes that number into every shader's source, and with a number that no earlier load used the GPU compiles all four shaders from scratch, which is how the first visit below was measured. The number is a whole number from 0 to 4294967295, which a shader holds as a u32, and the page ignores any other.
- **A GPU that stops working** while the page is open: the page goes on with both programs on the CPU, and says why.
- **A worker that fails**, e.g. because its script didn't load: the page says so in the line's place and searches no more, also not on the GPU.

Measured on October 14, 2026 on an Apple M5 Max in headless Chrome for Testing 155.0.8059.79, with the built site served under a path prefix. Two builds were loaded in turn: the page of October 13, whose searches run loop-emit.ts's shaders and which compiles only the shader for 8 states when it loads, and the page as it is now. In the three tables, the loads of a window are in one Chrome process, one build after the other, at a 1-minute load average of 0.9 to 2.9. A cell is the median, with the range in parentheses.

| | 1440 by 900 at two device pixels per CSS px, 100,000 documents, 6 loads each: before | Now | 390 by 844 at three, with touch, 20,000 documents, 5 loads each: before | Now |
| --- | --- | --- | --- | --- |
| The documents ready to search, from the navigation | 521 ms (516 to 531) | 536 ms (534 to 561) | 168 ms (165 to 190) | 208 ms (201 to 210) |
| Of that: writing the documents, writing their characters as numbers, creating the GPU's searcher | 322, 53 and 75 ms | 323, 53 and 88 ms | 71, 10 and 26 ms | 71, 10 and 64 ms |
| The first search's answer painted, from the navigation | 561 ms (543 to 576) | 560 ms (557 to 596) | 191 ms (190 to 220) | 240 ms (224 to 241) |
| The first search, as the line shows it | 17.4 ms (14.3 to 20.8) | 8.9 ms (8.0 to 11.5) | 9.0 ms (8.7 to 14.0) | 4.3 ms (4.2 to 4.3) |
| A search while typing, a key every 150 ms, 42 and 35 searches | 17.3 ms (17.0 to 28.4) | 11.0 ms (8.4 to 18.9) | 8.8 ms (8.4 to 13.1) | 4.1 ms (3.8 to 7.9) |
| Painting the map for such a search | 1.3 ms (0.7 to 2.2) | 1.2 ms (0.7 to 3.7) | 0.9 ms (0.5 to 1.6) | 0.8 ms (0.4 to 1.8) |
| From the key's event to the frame after the one that painted its answer | 34.3 ms (18.7 to 53.6) | 32.6 ms (18.6 to 46.7) | 27.4 ms (18.2 to 36.0) | 27.7 ms (18.4 to 40.2) |
| Longest time that the page's thread was held: while loading, and while typing, in 2 of the loads | 21 and 24 ms | 23 and 15 ms | 18 and 8 ms | 17 and 8 ms |

One search as the page's line shows it, by the program that the pattern runs on, in 4 of the wide window's loads of each build. The page was given nine patterns, five on the program of 8 states, two on 16 and two on 32. Each pattern was searched 9 times with a pause of 200 ms after the previous search's answer was painted, which is what a keystroke gets, and 5 times for `([a-z]+)+x`. Then it was searched 12 times with each search started as soon as the one before it was painted, which is one search every other frame, the page's fastest rate:

| The program of | Before, after a pause of 200 ms | Before, a search every other frame | Now, after a pause of 200 ms | Now, a search every other frame |
| --- | --- | --- | --- | --- |
| 8 states | 17.8 ms (15.9 to 22.2) | 8.5 ms (7.5 to 15.5) | 11.8 ms (10.8 to 16.4) | 7.7 ms (5.3 to 13.2) |
| 16 states | 76.9 ms (74.7 to 80.5) | 66.4 ms (63.8 to 69.6) | 12.5 ms (11.6 to 16.4) | 7.7 ms (5.6 to 14.6) |
| 32 states | 901 ms (868 to 933) | 881 ms (863 to 920) | 14.5 ms (13.7 to 18.9) | 8.1 ms (5.4 to 11.8) |

The page's first pattern and its four examples in the same loads, each with what it reads, and one pattern for the largest program. The search's two columns are after a pause of 200 ms. RegExp's column is the time that the page's worker measured for the pattern as typed, which the page's line shows, in the 12 loads of both builds, 101 to 156 timings per pattern, and 12 for `([a-z]+)+x`:

| Pattern | The search reads | The program of | Before | Now | Native RegExp |
| --- | --- | --- | --- | --- | --- |
| `error`, which the page starts with | everything | 8 states | 17.7 ms (15.9 to 18.5) | 12.0 ms (10.9 to 14.9) | 20.8 ms (19.7 to 26.6) |
| `[a-z0-9.]+@[a-z.]+` | string values | 8 states | 17.8 ms (17.3 to 18.7) | 11.6 ms (10.8 to 13.7) | 21.3 ms (20.0 to 28.2) |
| `[a-z]+Id` | keys | 8 states | 17.9 ms (17.2 to 18.6) | 11.6 ms (10.9 to 13.6) | 19.3 ms (18.4 to 25.1) |
| `\d\d\d\d-\d\d-\d\d` | everything | 16 states | 76.4 ms (74.7 to 78.8) | 13.1 ms (11.6 to 16.4) | 8.9 ms (8.1 to 14.3) |
| `([a-z]+)+x` | everything | 8 states | 17.2 ms (17.0 to 22.2) | 11.0 ms (10.8 to 16.4) | 2.1 s (2.0 to 2.2) |
| `connection reset` | everything | 32 states | 904 ms (876 to 918) | 15.0 ms (13.7 to 18.9) | 8.0 ms (7.6 to 14.0) |

- **What a visitor gets from the change.** A search for a pattern of 8 to 31 characters or classes, e.g. the Try list's date, answers in 12 to 15 ms instead of 77 ms or 0.9 s, so the map follows such a pattern at each key as it follows a short one. A short pattern's search takes 12 ms instead of 18 ms after a pause. The load takes about what it took: in the wide window the documents are ready 15 ms later and the first search's answer is painted at the same time, since that search takes 8 ms less. In the narrow window the first search's answer is painted 49 ms later, since there the GPU is done with the highlighter before JavaScript has built the three search programs.
- **RegExp's time depends on the pattern more than the search's does.** With the three other patterns of the per-program table, RegExp took 18.8 ms (18.1 to 24.4) for `(the|an?) [a-z]+` in string values, 27.7 ms (25.6 to 32.6) for `(the|an?|some) [a-z]+(ing)?s?` and 28.2 ms (26.5 to 33.4) for the pattern of 32 states, where the search took 11.9, 12.4 and 14.4 ms after a pause. So of these eight ordinary patterns, the search after a pause took less time than RegExp on six and more on two, the date and `connection reset`. At one search every other frame it took 7.7 to 8.4 ms on each of them, which is about RegExp's time on those two.
- **RegExp's time is for the pattern as typed.** The same pattern inside a group is another search for RegExp: `(error)` took 9.5 ms where `error` took 20.8 ms, and `([a-z0-9.]+@[a-z.]+)` and `([a-z]+Id)` took 30 and 32 ms where the patterns as typed took 21 and 19 ms. The measurement's script searches a pattern in turn with the same pattern in a group, so that every search is a new one for the page, and it reads RegExp's time by the pattern that the time is for.
- **Each load in a new Chrome process with a new profile folder**, 4 loads of each build in the wide window, at a load average of 2.0 to 2.4: the documents ready after 540 ms (535 to 567) before and 555 ms (551 to 562) now, of which creating the searcher takes 83 ms (81 to 84) and 90 ms (88 to 96), the first search's answer painted after 584 ms (572 to 610) and 583 ms (578 to 593), the first search 19.9 ms (19.8 to 20.1) and 12.4 ms (11.5 to 12.8), a search while typing 17.2 and 11.0 ms. So a first load in a new process shows "This program: 12 ms on the GPU" or 13 ms for the page's first pattern, where a later load in the same process shows about 9 ms.
- **Two earlier measurements of the same day, each load in a new process, agree on the search times and differ on the load by a few ms.** They ran while other jobs used the machine, at load averages of 2.6 to 23, and they counted the documents' ready time from the start of the page's script, which is 20 to 36 ms after the navigation. Creating the searcher in the wide window: 86 ms before and 89 ms now in 6 loads each, and 75 and 86 ms in 4 loads each. The first search's answer painted: 597 and 578 ms, and 605 and 593 ms. In the narrow window: creating the searcher 39 and 70 ms, and 39 and 72 ms, and the first search's answer painted after 212 and 245 ms, and 227 and 242 ms. So over every set of loads, creating the searcher takes 3 to 14 ms longer in the wide window and 31 to 38 ms longer in the narrow one, and the first search's answer is painted at the same time or up to 19 ms earlier in the wide window, and 15 to 49 ms later in the narrow one. At the higher load, the program of 32 states of the page before took 1.1 s per search (0.93 to 1.5) where it took 0.9 s here.
- **When each size's GPU code is compiled: all three when the page loads.** The other choice was to compile the larger two right after the first search is painted. Compiling all three at load delays the first search's paint by nothing in the wide window and by 15 to 49 ms in the narrow one, and with it no keystroke ever waits for a compile, where a visitor who types a long pattern in the first 0.1 s after the first paint would have waited with the other choice. Building one program and writing its shader is 7, 12 and 31 ms of JavaScript at 8, 16 and 32 states. The searcher does that while the GPU compiles the highlighter's shader, and gives each of the six pieces a task of its own, so the page's thread is held for 23 ms (21 to 25) while loading, where it was held for 21 ms (20 to 21), in 2 loads each. A first version, which built the three programs in one piece after the highlighter's compile, painted the first search 19 ms later than the other choice with the shaders in the cache, 613 against 594 ms, and held the thread for 50 ms. The narrow window's delay comes from those 50 ms of JavaScript, which there take longer than the GPU takes for the highlighter. So a device whose JavaScript is several times slower than this machine's could paint its first search more than 0.1 s later than with the other choice, which wasn't measured.
- **The page compiles four shaders at load and none later**, counted by wrapping `createShaderModule` in every load above: the highlighter's, 5,704 characters, and the three search programs', 7,748, 9,794 and 14,324 characters, all before the first search's answer is painted. The page before compiled two at load, 5,704 and 32,636 characters, a third at the first pattern of 9 or more states and a fourth at the first of 17 or more.
- **A first visit, where the GPU compiles every shader without a cache** (`?salt=` with a new number per load, each load in a new process, 4 loads each, load average 3.4 to 11.7, counted from the start of the page's script): the documents are ready after 675 ms (594 to 694) before and 650 ms (590 to 691) now, of which creating the searcher takes 184 ms (152 to 195) and 166 ms (148 to 175), and the first search's answer is painted after 741 ms (671 to 763) and 700 ms (645 to 748). Three more such loads of the page as it is now: creating the searcher 154 ms (148 to 224), and the first search's answer painted after 677 ms (675 to 744). The other loads above find the shaders that an earlier Chrome process compiled, which a shader's text decides, not the profile folder.
- **The longest hold while typing** was 24 ms (22 to 26) before and 15 ms (14 to 15) now in the wide window, in 2 loads each. The table of October 13 had 5 and 3 ms there, and this work didn't look for the reason.
- **A whole search on the CPU**, 100,000 documents, a pattern of up to 8 states, is the same code as before, and takes what it took: 13 s as the line shows it for both builds, in two runs each on October 14, and 21.4 to 21.9 s on the clock with the highlighter, and 12.8 and 12.7 s for a second search. On October 13, in Google Chrome 155: 14.3, 14.2 and 14.2 s as the line shows it, and 23.0, 14.3 and 14.3 s on the clock.
- **The first search on the CPU waits for its worker**, which starts at the toggle and writes its documents first: the line says "Searching 100,000 documents…" from 0.25 to 0.27 s after the toggle, and shows the search's first numbers after 0.37 to 0.41 s, in both builds.
- **Without WebGPU**, measured on October 13, the documents are ready after 0.36 s, the line's first numbers show within 0.49 to 0.53 s of the navigation, and the first search is done after 23.1 to 23.3 s, of which the search program takes 14.0 to 14.1 s.
- **Typing while a search runs on the CPU**, measured on October 13, held the page's thread for at most 6.3 ms, and a key's own search showed its first numbers 15 to 34 ms after the key.
- **Memory**, by Chrome's `performance.measureUserAgentSpecificMemory`: the page's JavaScript holds 140 MB at rest on the GPU, 48 MB of it on the page's thread, mostly the documents' texts, 87 MB in the worker that times RegExp, its own copy of the texts and the plain JavaScript highlighter's kinds, and 4 MB for the canvas. The page's thread held 43 MB before: the three search programs that are built at load are the other 5 MB. After a search on the CPU it holds 588 MB, 448 MB of them in the worker for the CPU: the CPU searcher keeps every document's cells and display kinds as f32 values, 205 MB each, next to that worker's copy of the texts.
- **The table of October 13**, from Google Chrome 155 at a load average of 3.2 to 5.2, with 8 and 4 loads, each in a new process, and the ready time counted from the start of the page's script: the documents ready after 583 ms and 165 ms, the first search's answer painted after 653 and 220 ms, the first search 20.4 and 13.5 ms, a search while typing 15.6 and 8.8 ms, and the page's thread held for 23 and 5 ms and for 21 and 3 ms. The "before" columns above are that page again.

The page's files:

| File | What it holds |
| --- | --- |
| `demo.html`, `demo.css` | The page and its styles, on top of assets/site.css and assets/tool.css |
| `demo.ts` | The page's state and its frame: DOM reads, what arrived and the inputs, what the page shows, DOM and canvas writes, then the work that is due. Listeners and the workers' messages only record what arrived and schedule a frame |
| `demo-map.ts` | The map without a DOM: how large a cell is, which document the pointer picks, the next document with a match, and the cells' pixels |
| `demo-text.ts` | The page's documents, the line of numbers and the other sentences, and a document's text as runs of characters that look the same |
| `demo-worker.ts` | The workers' script, which the page starts twice: one worker times RegExp, and the other runs a search on the CPU in pieces and returns one document's kinds and marks |
| `demo.test.ts` | 21 tests of the map, the documents, the sentences, the worker and the page's searches on the GPU, without a browser. Bun runs the worker as a worker, and the WGSL interpreter runs the GPU's passes |

scripts/demo-site-pages.ts lists the workers' script next to the page, since Bun's bundler doesn't follow `new Worker(...)`: the site's build writes it as one file, json-search/demo-worker.js, and the development server builds it at each request.

## Is the GPU clearly faster?

The short answer to Cheng's question, for all of it. Every number is for one Apple M5 Max and the 100,000 generated documents. The highlighter's numbers and the JavaScript baselines are from headless Chrome 155 on October 13, 2026, and a range is what the runs of this folder measured over about four hours. The search's numbers are from October 14, with bit-emit.ts's shaders, in headless Chrome for Testing 155.0.8059.79, at a 1-minute load average of 2.5 to 23, since other jobs used the machine.

- **Against the same programs on the CPU: yes, by a wide margin, from about ten documents on.** For 100,000 documents that are already on the GPU, the highlighter's pass takes 2.2 ms and a search 4.5 to 5.2 ms, on any of the three search programs, when one evaluation follows the other. On the CPU, the highlighter as the repo ships it, with every position written out, takes 8.4 to 9.2 s on the executor and 2.1 s as generated JavaScript. A search of a pattern of up to 8 states takes 14 s as generated JavaScript, with loops that stop at each text's end, and 3.2 minutes on the executor, and a search of a pattern of 17 to 32 states takes 3 minutes as generated JavaScript.
- **Against plain JavaScript on one thread, for the highlighter's pass alone: yes, from about 10,000 documents that are already on the GPU.** For 10,000 documents the pass takes 0.65 ms back to back and 2.6 to 3.4 ms after a pause, against 7 to 10 ms for JSON.parse and 12 to 17 ms for a JavaScript highlighter. For 100,000 documents it takes 2.2 ms and 8.3 to 9.7 ms, against 75 to 103 ms and 119 to 152 ms. Below about 1,000 documents JavaScript takes less time.
- **But a page runs that pass once per set of documents, and from the texts the GPU isn't faster.** A document's display kinds and first error only change when its text changes. For 100,000 documents, JavaScript writes the cells in 44 to 51 ms, and the upload of 205 MB, the highlighter's shader and its pass take about 0.1 s, during which the three search programs are built and compiled too: 0.15 s before the page has its answers, where the JavaScript highlighter takes 0.12 to 0.15 s.
- **Against RegExp on one thread, for regex search: faster when searches follow each other, and faster for most patterns at a keystroke.** One search of 100,000 documents takes 4.5 to 5.2 ms when searches follow each other, whatever the pattern's size up to 32 states, and 11 to 16 ms after a pause of 200 ms or more, which is what a page that searches per keystroke gets. RegExp takes 8 to 43 ms to count every match of the ten ordinary patterns that were measured, and 5 to 35 ms to say only whether each document has one.
  - When searches follow each other, the GPU takes 1.5 to 9 times less than RegExp's count, on every one of those patterns. That is the searcher called again as soon as its answer arrives. The demo page starts a search only in a frame, so its fastest rate is one search every other frame, and a search then takes 7.7 to 8.4 ms, which is about what RegExp takes for the two patterns that it matches fastest, 8 to 9 ms for the date and `connection reset`.
  - After a pause, it takes less on seven of the ten, up to 3.5 times less, about the same on one, and more on the two that RegExp matches fastest, `\d\d\d\d-\d\d-\d\d` and `connection reset`, which take RegExp 8 to 9 ms and the GPU 12 to 16 ms.
  - On a pattern that makes RegExp backtrack, it takes 5 to 12 ms against 2.1 s.
  - Until October 14, with loop-emit.ts's shaders, the answer was "about even, and only for short patterns": 7 to 8 ms back to back and 17 to 21 ms after a pause at up to 8 states, 64 ms at up to 16 states and 0.87 s at up to 32.
- **Against JavaScript in several workers: no.** Every comparison above gives JavaScript one of this machine's 18 cores. With the documents shared among 8 workers, RegExp counts every match in 100,000 documents in 1.9 to 6.7 ms and JSON.parse validates them in 10.9 ms, and with 16 workers in 1.3 to 4.0 ms and 6.2 ms, from the request until every worker's answer has arrived. The GPU's 4.5 to 5.2 ms back to back is in the range of 8 workers, and its 11 to 16 ms after a pause is 2 to 8 times as long, with workers that weren't timed after a pause. The pattern that backtracks takes 279 and 136 ms there, which the GPU's 5 to 12 ms still beats.
- **For both in one app:** loading and validating is about even with plain JavaScript, and each keystroke after that is a search of 11 to 16 ms for a pattern of any size that the programs hold, also when it reads only string values or keys, against 13 to 24 ms for RegExp on each string value.

So with bit-emit.ts's shaders the search on the GPU takes less time than the browser's own regex engine on one thread from a few thousand documents on when searches follow each other, and at a keystroke it takes less for most ordinary patterns from 15,000 to 54,000 documents on, and more for the patterns that RegExp matches fastest. It doesn't take less than RegExp in 8 workers. The highlighter's pass is clearly faster only as a repeated pass over documents that stay on the GPU, which a page has no reason to repeat. What the GPU gives is the repo's own programs at the speed of native code on one thread or better, where the CPU takes 200 to 40,000 times as long for the same programs.

A demo that searches a ton of JSON documents is honest if it says what it shows: the repo's own programs, built with the builder and compiled once, the same ones that take seconds to minutes on the CPU, answering in 11 to 16 ms per keystroke for 100,000 documents, whatever the pattern's size up to 31 characters or classes, with every value equal to the CPU's, next to the time of the browser's native regex engine for the same search, which is longer for most ordinary patterns and shorter for some, and 2 s for a pattern that makes it backtrack. It isn't honest if it claims to beat RegExp on every pattern, or JavaScript in several workers.

### The three rows

The task: 100,000 generated JSON documents of up to 512 code points, 300 on average, 1 in 10 broken. Once: which are valid, where is the first error, and what is each character shown as. Then per keystroke: how many matches of a pattern lie inside each document's string values. Everything was measured in the same Chrome page, and a time on the CPU that isn't for all 100,000 documents says how many it was measured on.

| | Validate and highlight every document, once | One search inside string values, pattern of up to 8 states | The same search with `([a-z]+)+x`, which makes RegExp backtrack |
| --- | --- | --- | --- |
| Plain JavaScript on one thread: a table loop, then RegExp on each string value | 119 to 152 ms | 15 to 24 ms, after 72 to 117 ms once to find the string values | 546 to 617 ms |
| The same programs on the CPU: as generated JavaScript, and on the executor | 2.1 s, extrapolated from 5,000 documents, and 8.4 to 9.2 s, with every position written out | 24.5 s as a loop over all 512 positions, extrapolated from 200 documents, 14 s for all 100,000 documents as a loop that stops at the text's end, and 3.2 minutes with every position written out, extrapolated from 40 | the same |
| The same programs on the GPU | 0.15 s from the texts. The pass alone, with the documents already there: 2.2 ms back to back, and 8.3 to 9.7 ms after a pause of 200 ms or more | 4.5 ms back to back, and 12.5 to 13.1 ms after a pause of 200 ms or more | the same |

- The GPU's 0.15 s is 44 to 51 ms of JavaScript writing every document's cells, and 95 ms for the upload of 205 MB, the highlighter's shader and its pass, and the three search programs, which JavaScript builds while the GPU compiles the highlighter's shader, and whose shaders the GPU compiles while the pass runs. With loop-emit.ts's search shaders, of which only the one for 8 states was compiled at creation, the same took 0.17 to 0.18 s.
- The loop forms run slower on the CPU than the forms with every position written out, since this folder's CPU runner calls the executor once per position, and the executor checks every source cell's range on each call: the highlighter's loop takes 90 µs per document as generated JavaScript and 2.7 ms on the executor, and a search at 8 states 2.1 to 3.4 ms per document on the executor. So the table gives each program's faster form on the CPU.
- Row 1 isn't the same search as rows 2 and 3 for every pattern: RegExp takes the first alternative that matches, and the program the longest match. On the patterns measured here the counts are equal for every document.
- JSON.parse, which only says whether a document is valid, takes 67 to 103 ms for the 100,000 documents on one thread, and 6 to 11 ms in 8 to 16 workers.

### What depends on what

**The pattern's size decides which program runs, and with bit-emit.ts's shaders it no longer decides the time.** A search step takes one table read per pair of states, so there is one program per state capacity, and a pattern runs on the smallest one that holds it. A pattern has one state per character or class it reads, plus one, e.g. `error` has 6 and `connection reset` has 17. One search of the demo page's 100,000 documents through the searcher, with both writers' shaders taking turns in one Chrome process, back to back; after a pause of 200 ms:

| The pattern has | loop-emit.ts's shader, until October 14 | bit-emit.ts's shader | RegExp, every match, the measured patterns of that size | The hand-written kernel, which isn't the program |
| --- | --- | --- | --- | --- |
| up to 8 states | 7.81; 16.5 ms | 4.60; 11.3 ms | 11.8 to 42.8 ms, and 2,143 ms for `([a-z]+)+x` | 3.38; 11.0 ms |
| 9 to 16 states | 68.8; 69.6 ms | 4.72; 11.9 ms | 8.3 and 29.1 ms | 3.69; 11.7 ms |
| 17 to 32 states | 945; 948 ms | 5.24; 13.2 ms | 8.1 and 28.9 ms | 4.85; 14.2 ms |

With loop-emit.ts's shaders, the search that was as fast as RegExp held patterns of up to 7 characters or classes. The hand-written kernel showed that this GPU can run the same automaton 2 to 13 times faster than RegExp counts on one thread, at any of these sizes, when a row of states is one 32-bit word and searches follow each other. The repo's program has no such word: an AND of two words isn't a sum or a ReLU gate. But the GPU code that a writer writes for the program can have one, where the writer proves that the AND gives the gate's value. That is what bit-emit.ts does, and its shaders take 1.1 to 1.4 times the kernel's time for the unchanged program, see [The second code writer](#the-second-code-writer-bit-emitts). The kernel's times are from stage 2's runs, over the generated documents and without the searcher's scope.

**The document count.** A pass has a floor, one document's operations in one GPU thread, and a round trip to the GPU: a search of 100 to 10,000 documents takes 0.6 to 1.9 ms on any of the three programs, where loop-emit.ts's shaders took about 2 ms at 8 states, 8 to 9 ms at 16 and 77 to 132 ms at 32. RegExp's time grows with the count from the first document. So the GPU takes less time than RegExp on each string value from about 2,000 to about 13,000 documents on, depending on the pattern and the run, when searches follow each other, and from 15,000 to 54,000 after a pause, or not at all up to 100,000 for the date and `connection reset` in one of the two runs. These counts are interpolated between four measured counts, and one pattern's count moved by up to 1.8 times between the two runs, e.g. from 7,400 to 13,000 for `connection reset`.

**Whether the GPU was busy.** A search after a pause of 200 ms or more takes 2.4 to 3.2 times the back to back time at 100,000 documents, 11 to 16 ms instead of 4.5 to 5.2 ms, as in the first stage. A page that searches per keystroke gets the slower number.

**How many cores JavaScript gets.** RegExp and JSON.parse above run on one thread. Eight workers that each hold an eighth of the documents count a pattern's matches in 1.9 to 6.7 ms, which is what the GPU takes back to back and less than it takes after a pause, see [JavaScript in several workers](#javascript-in-several-workers).

**What else the machine does.** With loop-emit.ts's shaders, in the three search runs and the review's run, at a 1-minute load average of 2.2 to 7.5, a search of 100,000 documents at 8 states took 6.9 to 7.3 ms. In two single runs at a load average of 6 to 15 it took 10.8 and 11.1 ms, and during two seconds of the review's first-stage run the highlighter took 13 to 20 ms where it otherwise took 4 ms. Other processes use the same GPU. With bit-emit.ts's shaders, the back to back time at 8 states was 4.5 to 4.7 ms in four runs at load averages from 2.5 to 23, and single searches after a pause ran from 4.4 to 15 ms.

**The documents.** These have a median of 300 code points. On the GPU the program runs all 512 positions of every document, and RegExp reads only the text, so shorter documents favor RegExp and documents near 512 favor the GPU.

**The machine.** One Apple M5 Max, one browser, headless. The compile times, the pause behavior, the exactness without guards, and whether integer and word operations are as fast as f32 statements may all differ on another GPU. The searcher's self check is there for the exactness.

### What a demo would show

A page built on searcher.ts runs the repo's own programs: the highlighter's step and regex search's step, built with the builder, compiled once each, and run once per position of every document on the GPU. It doesn't run the hand-written kernel. With 100,000 documents:

- It loads in about 0.15 s: 44 to 51 ms of JavaScript writing cells, and 95 ms for the upload, the highlighter's shader and pass, and the three search programs. That is about what plain JavaScript takes to validate and highlight the same documents, 0.12 to 0.15 s.
- Every keystroke searches all 100,000 documents in 4.5 to 5.2 ms when searches follow each other and in 11 to 16 ms after a pause of 200 ms or more, for a pattern of any size up to 32 states, in every document or only inside string values or keys, and returns the marks of the documents on screen. A scroll takes 0.6 to 2.1 ms, since it searches only those.
- A longer pattern costs little more than a short one: 4.6, 4.7 and 5.2 ms back to back at up to 8, 16 and 32 states, and 11.3, 11.9 and 13.2 ms after a pause. With loop-emit.ts's shaders it cost 69 ms at 9 to 16 states and about 0.95 s at 17 to 32.
- A pattern like `([a-z]+)+x` takes the same 5 to 12 ms, where RegExp takes 0.56 to 2.1 s on one thread.
- The same programs on the CPU, behind the same interface, take 0.14 ms per document as generated JavaScript, 14 s for 100,000 documents, for one search of a pattern of up to 8 states, which a page can show by running them in a worker, a few documents at a time, as the demo page does.
- RegExp on one thread answers the same searches in 8 to 43 ms, and in 8 workers in 2 to 7 ms. So a page shows RegExp's time next to its own for every pattern, as the demo page does, and doesn't claim a faster search.

## How to run it

From the repo root:

```sh
bun start                                        # the demo site, with the demo page at /json-search/
bun test lab/json-search                         # 175 tests in 7 files, about 1 minute, no GPU
bunx tsgo -p lab/json-search                     # type-check, including gpu/
bunx oxlint --type-aware lab/json-search         # lint
bun lab/json-search/report.ts sizes              # the first stage's two programs and their shaders, with and without guards
bun lab/json-search/report.ts loops              # the loop programs' stages and their shaders
bun lab/json-search/report.ts documents          # the 100,000 documents' shapes, defects and lengths
bun lab/json-search/report.ts examples 8         # the first 8 documents' texts
bun lab/json-search/report.ts edge-cases         # the searcher on the CPU against the written-out programs on the executor, at the limits, about 5 minutes
bun lab/json-search/gpu/run.ts --mode main --profile <new folder> --out <file.json>    # the first stage's timings, about 8 minutes
bun lab/json-search/gpu/run.ts --mode check --profile <new folder> --out <file.json>   # its shaders with and without guards, about 1 minute
bun lab/json-search/gpu/search-run.ts --profile <new folder> --out <file.json>         # regex search at every capacity, about 13 minutes
bun lab/json-search/gpu/combined-run.ts --profile <new folder> --out <file.json>       # the searcher at every document count, about 7 minutes
bun lab/json-search/gpu/writers-run.ts --profile <new folder> --out <file.json>        # the searcher with loop-emit.ts's shaders and with bit-emit.ts's, in turn, about 4 minutes
bun lab/json-search/gpu/review-run.ts --mode edge --profile <new folder> --out <file.json>       # the review: documents and patterns at the limits on the GPU, about 5 minutes
bun lab/json-search/gpu/review-run.ts --mode many --profile <new folder> --out <file.json>       # the review: 100,000 documents on the GPU against the programs on the CPU, about 6 minutes
bun lab/json-search/gpu/review-run.ts --mode baselines --profile <new folder> --out <file.json>  # the review: other plain JavaScript baselines, and workers, about 3 minutes
```

Each `run` script starts its own headless Chrome with WebGPU on a profile folder that no other Chrome uses, serves its page with cross-origin isolation headers so that `performance.now()` reads in steps of 5 µs, and ends only the Chrome it started. `--chrome <path>` names another browser than /Applications/Google Chrome.app, e.g. Chrome for Testing. combined-run.ts and review-run.ts measure the searcher as it is, with bit-emit.ts's search shaders, and `--search-writer loop-emit` gives them the searcher of the runs of October 13. `--port` and `--devtools-port` choose its two ports: 4421 and 9421 by default for run.ts, 4424 and 9424 for search-run.ts and combined-run.ts, 4427 and 9427 for review-run.ts, and 4429 and 9429 for writers-run.ts. The raw results are in results/, and three scripts print every table below from them:

```sh
bun lab/json-search/gpu/summarize.ts --main lab/json-search/results/gpu-main-1.json,lab/json-search/results/gpu-main-2.json,lab/json-search/results/gpu-main-3.json --checks lab/json-search/results/gpu-check-1.json
bun lab/json-search/gpu/search-summarize.ts --search lab/json-search/results/search-main-1.json,lab/json-search/results/search-main-2.json,lab/json-search/results/search-main-3.json --combined lab/json-search/results/combined-main-1.json,lab/json-search/results/combined-main-2.json,lab/json-search/results/combined-main-3.json,lab/json-search/results/combined-main-4.json,lab/json-search/results/combined-main-5.json
bun lab/json-search/gpu/review-summarize.ts --baselines lab/json-search/results/review-baselines-1.json,lab/json-search/results/review-baselines-2.json,lab/json-search/results/review-baselines-3.json --edge lab/json-search/results/review-edge-1.json --many lab/json-search/results/review-many-1.json
```

The review's reruns of the three measurement pages are results/review-rerun-gpu-main.json, review-rerun-search.json and review-rerun-combined.json, and the first two scripts print their tables when given one of them alone.

The runs of October 14, with bit-emit.ts's search shaders, and the tables of [Measured results: the searcher with bit-emit.ts's shaders](#measured-results-the-searcher-with-bit-emittss-shaders):

```sh
bun lab/json-search/gpu/writers-summarize.ts lab/json-search/results/writers-1.json,lab/json-search/results/writers-2.json
bun lab/json-search/gpu/search-summarize.ts --combined lab/json-search/results/combined-bit-emit-1.json,lab/json-search/results/combined-bit-emit-2.json
bun lab/json-search/gpu/review-summarize.ts --edge lab/json-search/results/review-edge-bit-emit-1.json --many lab/json-search/results/review-many-bit-emit-1.json
bun lab/json-search/gpu/review-summarize.ts --edge lab/json-search/results/review-edge-bit-emit-2.json   # the limits once more, with the self check's 11 searches
```

The demo page's own times, in [The demo page](#the-demo-page), were measured with scratch scripts that aren't in the repo: they load the built site in headless Chrome and read `window.jsonSearch`, which holds each painted search's time, the load's times and the GPU's programs.

| File | What it holds |
| --- | --- |
| `emit.ts` | The emitter: a compiled tensor program as one WGSL compute shader, one invocation per document, with index reads |
| `loop-program.ts` | A program as loops over a document's positions: stages, registers, fields and outputs, and its runner on the CPU |
| `loop-emit.ts` | A loop program as one WGSL shader, with each stage's statements once inside a `for` loop |
| `bit-emit.ts` | A second writer for the same loop programs, which holds proven whole numbers as integers, packs gated table reads into words, and writes the same gate over every bit of a word as one word operation. It writes the shaders of the demo page's searches, see [The second code writer](#the-second-code-writer-bit-emitts) |
| `wgsl-interpreter.ts` | A strict interpreter for the WGSL that emit.ts, loop-emit.ts and bit-emit.ts write, so the shader text is tested on the CPU |
| `interpreted-gpu.ts` | A WebGPU device for tests: the calls that gpu/host.ts makes, with WebGPU's stack of error scopes and a compute pass that runs the shader's text through the interpreter, so `createGpuSearcher` runs under `bun test` |
| `program.ts` | The highlighter with every position written out, compiled for two sets of outputs, and a document's cells |
| `json-step.ts` | The highlighter as a loop program |
| `search-step.ts` | Regex search's form (a) as a loop program, which can read display kinds, and the same search with every position written out |
| `searcher.ts` | The module for a demo page: validate every document once, search them per keystroke, on the GPU or on the CPU |
| `demo.html`, `demo.css`, `demo.ts` | The demo page, its styles, and its state and frame: see [The demo page](#the-demo-page) |
| `demo-map.ts`, `demo-text.ts` | The page's parts without a DOM: the map's cells and pixels, and the page's documents, sentences and numbers |
| `demo-worker.ts` | The page's two workers: RegExp's time for the search on screen in one, and both programs on the CPU in the other, a few documents at a time |
| `plain-search.ts` | The same answers in plain JavaScript, as a baseline: the table loop, then RegExp |
| `bit-rows.ts` | The same automaton with 32-bit rows, as comparisons: a plain JavaScript loop and a hand-written kernel |
| `documents.ts` | The generated documents: 7 shapes, 16 labeled defects, a pure function of a seed and an index |
| `table-loop.ts` | A plain JavaScript highlighter over the program's own tables, the fastest JavaScript baseline here |
| `generated-js.ts` | A program's operations as JavaScript statements, a CPU backend without the executor's loop over layers |
| `check.ts` | The executor's outputs for many documents, and the count of values that differ |
| `edge-cases.ts` | The review's documents and patterns at the limits, and the comparison of a searcher with the programs that have every position written out, on the CPU executor |
| `gpu/host.ts` | The WebGPU host: a device with the buffer limits it needs, a store for the documents' cells, and a runner per shader with compile time, evaluation, readback of chosen documents, and a self check |
| `gpu/page.ts`, `gpu/run.ts`, `gpu/summarize.ts` | The first stage's measurement page, its harness and its tables |
| `gpu/search-page.ts`, `gpu/search-run.ts` | The measurement page for regex search at every capacity, and its harness |
| `gpu/combined-page.ts`, `gpu/combined-run.ts` | The measurement page for the searcher, and its harness |
| `gpu/writers-page.ts`, `gpu/writers-run.ts`, `gpu/writers-summarize.ts` | The measurement page for the searcher with loop-emit.ts's shaders and with bit-emit.ts's, taking turns in one Chrome process, its harness and its tables |
| `gpu/search-summarize.ts` | The tables of the last two |
| `gpu/review-page.ts`, `gpu/review-run.ts`, `gpu/review-summarize.ts` | The review's page, its harness and its tables: the limits on the GPU, 100,000 documents against the programs on the CPU, and other plain JavaScript baselines |
| `gpu/chrome.ts`, `gpu/measure.ts` | What the harnesses and the pages share: the headless Chrome driver, and the sampling helpers |
| `results/` | The raw results |
| `report.ts` | Sizes and the documents' distribution, without a GPU |
| `json-search.test.ts`, `search.test.ts`, `bit-emit.test.ts`, `searcher.test.ts`, `edge-cases.test.ts`, `demo.test.ts` | The tests |
| `million/` | A check of a million documents with hand-written kernels, and the making and the reviews of bit-emit.ts, see [million/README.md](million/README.md) |

## What was built

### The emitter

`emitWgsl(program, {instanceCells, outputGroups, guard})` takes what `circuit.compileTensorProgram` returns and writes one `let` per operation, in the layers' order. JS for what one invocation does: `for (const operation of program) values[operation.position] = operation.run(values)`, with the document's cells and the shared table as the first values. It starts from [lab/ui-exploration/codegen/wgsl.ts](../ui-exploration/codegen/wgsl.ts), whose `flattenProgram` never reads a layer's index reads, so an index read would silently become a constant 0 there. Three things are new:

- **Index reads.** The highlighter's batch programs are 64% to 67% index reads, e.g. the class of a code point, `classes[codePoint + 1]`, is one read. A read is two statements: the index, `let p4576: i32 = i32(floor(1.0f + c0));`, and the candidate at the clamped index, `let v4576: f32 = shared_values[u32(514i + clamp(p4576, 0i, 128i) * 1i)];`. A side with the `'zero'` rule wraps the read in a `select`, e.g. `select(<read>, 0.0f, p5095 > 424i)`. Both rules on both sides are covered. The candidates must be source cells at evenly spaced positions, which is how the compiler stores a run of cells: shared cells, e.g. a table, or one document's own cells.
- **Output groups.** Each group of outputs gets its own buffer, e.g. 3 summary values per document in one and 512 display kinds per document in the other. A page can then read back the summary of every document and the kinds of only the documents on screen, each as one contiguous copy.
- **Long sums continue in a new statement** every 32 terms, e.g. the count of error-free positions is a sum of 513 terms in 17 statements, so no expression nests deeply.

An index read whose candidates are computed per document throws, e.g. the highlighter's `firstErrorKind` reads one of 513 computed error kinds. One `let` per value can't be indexed. The second stage's loop returns the first error's kind another way, see [The highlighter's step](#the-highlighters-step).

The `guard` option is codegen's: `'max'` wraps every product whose weight isn't a power of two and every partial sum in `max(x, lowest)`, with `lowest` read from a buffer, which is what keeps Apple's Metal compiler from fusing `a + w * x` and from regrouping sums. The highlighter holds only integers below 2^24 and no boolean atoms, so each of its products and partial sums is exact in any grouping, and its shaders are emitted with `guard: 'none'`. Its only values of 2^24 or more are 12 weights of a sign cascade at position 511, which multiply by a power of two.

### The highlighter with every position written out

`buildBatchPrograms()` builds the highlighter's circuit once, the loop form, and compiles it for two sets of outputs. A set keeps only the operations its outputs need.

| Outputs | What a document gets | Live operations | Layers | Index reads | WGSL statements | WGSL bytes |
| --- | --- | --- | --- | --- | --- | --- |
| summary | `valid`, `firstErrorPosition` (-1 when valid), `truncated` | 7,186 | 536 | 4,609 | 11,814 | 728,228 |
| display | those 3, and the 512 display kinds in a second output group | 7,698 | 536 | 5,121 | 13,350 | 820,204 |

Both leave out `firstErrorKind`, `depthExceeded`, `caretBracket` and `matchingBracket`: the first two read among computed values, see above, and the bracket at the caret is one editor's state, not a batch's. Without them no operation reads the caret. The full program is 15,928 operations.

A document's cells are its 512 code points, -1 after the text, and the text's length in code points: 513 float32 values, 2,052 bytes, so 100,000 documents are 205.2 MB. The other 4,062 source cells, i.e. the caret and the 15 tables, are the same for every document and sit in one shared buffer of 18 KB.

### The documents

`documentAt(seed, index)` returns a text, its shape and its defect. Every choice is a hash of the seed, the document's index and a counter, with `lowbias32` from chenguini's ui.md ("Pseudo-Random"), and no `Math.random`, so a page can make document 73,512 without making the ones before it.

- **7 shapes**: package manifests, user records, log events, editor settings, orders, map features, and arrays of sensor readings. They hold nested objects and arrays, negative and fractional numbers, exponents like `2.5e-7`, `true`, `false`, `null`, escapes like `\"`, `\\`, `\n` and `\t`, and names and units past U+007F, e.g. `"Søren Müller"`, `"東京"` and `"µg/m³"`.
- **4 ways of writing**: on one line, on one line with a space after each comma and colon, indented by 2 spaces, and indented by tabs. In 15% of the documents, characters past U+007F are written as `\u` escapes, e.g. `\u00b5g/m\u00b3` for `µg/m³`.
- **16 defects**, in 1 document of 10: a missing quote, a trailing comma, a bad escape, a missing colon, a key without quotes, a text cut short, single quotes, a literal like `True` or `undefined`, a number like `+1` or `012`, a missing comma, a closing bracket of the other kind, a raw control character in a string, a comment, text after the value, 16 to 19 containers around the document, and several records that together pass 512 code points. JSON.parse rejects the first 14. The last 2 are valid JSON that the highlighter doesn't hold: it reports `tooDeep` at the 17th nested opener and `tooLong` at code point 512.

A valid document that comes out longer than 512 code points is built again with fewer fields, so every document except the too long ones fits the capacity.

The 100,000 documents of the measurements, seed 20261013:

| Code points | 0 to 63 | 64 to 127 | 128 to 191 | 192 to 255 | 256 to 319 | 320 to 383 | 384 to 447 | 448 to 512 | more than 512 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Documents | 649 | 5,668 | 12,674 | 17,596 | 19,005 | 18,607 | 14,999 | 10,201 | 601 |

89,943 are valid and 10,057 are broken. The lengths run from 1 to 1,529 code points, with quartiles of 215, 300 and 387 and a mean of 301.2, and the 601 documents longer than 512 are the `tooLong` ones. 25,067 documents hold characters past U+007F. Each shape has 14,131 to 14,481 documents, and each defect 474 to 748, e.g. 616 with a missing quote, 608 with a trailing comma, 616 with a bad escape, 622 nested too deep. `bun lab/json-search/report.ts documents` prints every count.

### The host

gpu/host.ts is plain functions with no page globals:

- `requestBatchDevice(largestBufferBytes)` asks the adapter for storage buffers of the size the batch needs, and no more. Without the request a device binds at most 128 MiB per storage buffer, i.e. 65,408 documents, while this adapter allows 4 GB.
- `createDocumentStore(device, cellsPerDocument, capacity)` is the documents' cells on the GPU. `store.write(cells, count)` uploads them once, and every runner reads the same store.
- `createProgramRunner(device, shader, sharedValues, store, salt)` compiles one shader, times the compile, and uploads the shared table. The optional `salt` is a number written into the shader's source without changing its work, so that a salt no earlier run used compiles without hitting a shader cache, which is how the measurements get cold compile times. `runner.evaluate({count, readbacks, cells, timestamps})` runs one compute pass over the first `count` documents and copies out the chosen documents of the chosen output groups, e.g. `[{group: 0, firstDocument: 0, documentCount: 100000}, {group: 1, firstDocument: 49968, documentCount: 64}]` for the summary of every document and the kinds of 64. With `cells` it uploads new cells first. It returns the time of each part: the `writeBuffer` calls, encoding and submitting, the wait until the readback is mapped, and copying the values out.
- `selfCheck(runner, program, cells, count)` runs the first `count` documents on the CPU executor and on the GPU and counts the values that differ, for a page to decide whether to trust this GPU.

### The first stage's CPU baselines

All of them run in the measurement page, on the same documents as the GPU:

- **JSON.parse** in a `try`, for validity only. It accepts nesting past depth 16 and texts past 512 code points, which the highlighter reports.
- **reference.ts**, the plain JavaScript highlighter of [tests/json-highlighter/reference.ts](../../tests/json-highlighter/reference.ts), which the page imports as it is: a scanner and a parser with a real stack. It was written to be read next to JSON's grammar, not to be fast, e.g. it tests a character with `String.fromCodePoint` and `includes`.
- **The table loop**, table-loop.ts: one loop over the text that reads the program's own tables as typed arrays, with one bit per depth for the container kinds. It returns the display kinds, the first error's position and kind, and `truncated`, and is what I'd write for speed.
- **Generated JavaScript** of the same compiled programs, one statement per operation in functions of 128 operations.
- **The CPU executor** on the same compiled programs.

### A program as a loop over positions

The first stage's shader has one statement per operation, and both programs write one position's work out once per position. So the shader grows with the capacity: 13,350 statements for the highlighter's 512 code points, which take 2.3 s to compile, and 91,774 for regex search's form (a) at 8 states and 256 code points, which took 107 to 130 s to compile in a scratch probe made before this folder. [docs/patterns.md](../../docs/patterns.md#a-loop-over-items-that-mixes-per-item-work-with-values-carried-to-the-next-item) has the pattern for that: the work of one item is ordinary builder code, compiled once as its own small program, and it runs once per item.

loop-program.ts describes one document's program in that form. JS for what a looped stage does:

```js
for (let position = 0; position < positions; position++) {
  const values = step(codePoints[position], carried) // the compiled step, e.g. 37 operations
  carried = values.next // registers, e.g. a state machine's state
  perPosition[position] = values.kept // a field, for a later loop or for the page
}
```

- A **stage** is one compiled program that runs once, forward over the positions, or backward.
- Each source cell of a stage is one of: the document's cell at the loop's position, e.g. the code point; one fixed cell of the document, e.g. the text's length; a **register**, one number carried from a position to the next, with an initial value; a **field**, one number per position that one loop writes and a later loop reads; or a cell that every document shares, e.g. a table or a pattern's cells.
- A stage's outputs go to registers, to fields, to the document's own outputs, or to an output per position for the documents of a window, e.g. the ones on screen.

`createLoopRunner(loop, backend)` runs a loop program on the CPU, on the executor or as generated JavaScript. `emitLoopWgsl(loop)` writes it as one shader: each stage's statements once, inside a `for` loop, a register as a `var`, and a field as an array of the function. The statements are the first stage's, one `let` per operation, through a row writer that emit.ts now shares. Two choices came out of measuring, see [The choices that were measured](#the-choices-that-were-measured):

- **A stage's statements are written in the order of use**, each one right after the statements it reads, where the compiled program lists them layer after layer, e.g. all 1,024 table reads of a step before the 32 sums that read them.
- **A field of bits is one u32 word per position**, e.g. the reverse pass's 32 bits × 512 positions in 2 KB instead of 64 KB of f32 values.

A loop shader takes three more parameters than the first stage's: the first document to run, and the window of documents that get per position outputs. So one evaluation can run every document and return the marks of the 64 on screen, or run only those 64 after a scroll.

### The second code writer, bit-emit.ts

loop-emit.ts writes every operation of a step as one f32 statement. For regex search that is one table read per pair of states, `transitions[class][from][to] && bit`, i.e. 128, 512 and 2,048 reads per position at 8, 16 and 32 states, and one search of 100,000 documents takes its shaders 7.8, 69 and 945 ms when searches follow each other. After [the check of a million documents](million/README.md) had shown that a hand-written rewrite of those reads is 2.6, 20 and 230 times faster, Cheng asked: "does the program as written change? Or it's just compiler optimizations we need?". It is the second. `emitBitLoopWgsl(loop)` takes the same loop program and writes the same shader around it, and writes each operation in the cheapest form that it can prove gives the f32 statement's value:

- **A value that is proven to be a whole number is an `i32`, and one that is proven to be 0 or 1 is a bit.** E.g. the ReLU gate `relu(a - b)` over two bits is `a & (b ^ 1u)`, and the two gates that the builder writes for `codePoint >= boundary` are one integer comparison.
- **The table reads that one gate combines are one AND of two 32-bit words.** The gate of a state `to` says "no state that continues steps to `to` on this class". loop-emit.ts writes it as 8 table reads and a sum at 8 states. bit-emit.ts writes `(packed_words[first + class] & continuing) == 0u`, where `first` is the place of that gate's words: bit `from` of the packed word is the cell `transitions[class][from][to]`, and bit `from` of `continuing` is that state's bit. gpu/host.ts's runner packs the words from the pattern's cells at each upload with `packWords`, e.g. the 1,024 transition cells of a pattern at 8 states into 272 words, each cell once for the reverse pass and once for the forward pass.
- **The same gate for every state is one word operation**, e.g. `continuing[s] = relu(reached[s] - notReach[s])` for 8 states is `reached & (notReach ^ 255u)`.

The search step's shader is then 147, 171 and 219 statements at 8, 16 and 32 states, where loop-emit.ts writes 503, 1,375 and 4,655, and one search takes 4.6, 4.7 and 5.2 ms when searches follow each other, and 11.3, 11.9 and 13.2 ms after a pause of 200 ms, which is what a keystroke gets. Nothing else changed:

- **The program is as it was written**: weighted sums, ReLU gates and table reads, built by search-step.ts with lab/regex-search's own helpers. No compiled program changed, the CPU runs it as before, and it is as differentiable as before. What is new is how the GPU's code holds a value, which is the code writer's business.
- **Every value is the same.** [Measured results: the searcher with bit-emit.ts's shaders](#measured-results-the-searcher-with-bit-emittss-shaders) has the comparisons on the GPU, and the tests run both writers' shaders through the WGSL interpreter.
- **The rules name no program.** Each one is stated over what a compiled stage holds: an operation's kind, terms and weights, an index read's candidates, and the ranges, grids and exact bits that the circuit keeps per wire. [million/README.md](million/README.md#can-the-code-writer-do-it) has each rule with why it gives the f32 statement's value, the 73 programs and the random programs that two reviewers wrote to break the first version, what they found, and what the writer doesn't do, e.g. a list of bits that a program reads in another order than it stores them gets no word operation.

The searcher uses bit-emit.ts for the search programs, and loop-emit.ts for the highlighter. The highlighter's step reads tables of whole numbers and has no gate over several table reads, so bit-emit.ts writes integer statements for it and packs nothing, 103 statements instead of 107, and its pass doesn't get faster: 2.3 to 3.9 ms for 100,000 documents from loop-emit.ts's shader and 2.3 to 4.5 ms from bit-emit.ts's. `writers` in the searcher's options picks the other writer for either, which the tests and gpu/writers-run.ts use.

### Regex search's step

search-step.ts builds one code point's work of lab/regex-search's form (a) with that folder's own `emitClasses` and `createStepAnd`, which data-program.ts exports. The stages:

| Stage | Runs | What it computes | Operations at 8, 16 and 32 states |
| --- | --- | --- | --- |
| start | once | `notFinish[s] = !accepting[s]`, the reverse pass's bits before the last code point | 8, 16, 32 |
| reverse | from the last position down | the code point's class, `notReach[s]`, and the next `notFinish[s]` | 148, 356, 1,156 |
| forward | from position 0 up | whether a match continues or starts here, the next `reached[s]`, and the match count so far | 92, 308, 1,124 |

The class and the `notReach` bits of every position are fields that the forward loop reads back. The carried bits and the match count are registers. A document is 122,888 operations at 8 states and 512 positions, 339,984 at 16 states, and 1,167,392 at 32. That is the work of the program with every position written out, plus about 9 operations per position for values that are outputs of a step and were copied into their readers there, since a step still takes one table read per pair of states, `transitions[class][from][to] && bit`.

The outputs are the match count of every document, and for the documents of the window a mark per code point: 0 outside a match, 1 inside one, and 2 at a match's first code point, i.e. form (a)'s `highlighted + starts`.

A new pattern writes cells and changes no program, as in form (a): 1,097 cells at 8 states, 4,177 at 16 and 16,481 at 32. `built.writePattern(shared, compilePattern(pattern))` writes them with lab/regex-search's own `writePattern`, and the runner uploads them before the pass.

`stopAtLength` makes both loops stop at the text's end. A cell past the end holds -1, whose class has no steps, so the reverse loop's bits stay what `start` wrote and the forward loop finds nothing there. It gives the same outputs. It was slower on this GPU with either writer's shader, e.g. 13.3 ms against 4.4 ms at 8 states with bit-emit.ts's, so the GPU searcher leaves it off, and it saves the share of positions that hold no text on the CPU, 40% for these documents, so the CPU searcher turns it on.

### The highlighter's step

json-step.ts writes highlighter.ts's stages for one position, with the same tables, reads and comparisons: a step for positions 0 to 511, 37 operations, 12 of them table reads, and an end step for position 512, 17 operations. The tokenizer's state, the depth, the container code, the grammar's state, the count of positions in the error state and the first error's kind are registers. The display kinds are an output per position. The shader is 107 statements and 5,704 bytes.

Three things differ from highlighter.ts, and the values are the same in each:

- **`inObject` is a sign cascade at every position.** highlighter.ts compares the container code with a level weight in 2 operations at positions 1 to 510, where the code's range stays below 2^24, and in a sign cascade of 17 operations at position 511. One step serves every position, so its code has position 511's range. That makes a document 18,961 operations, where the display program with every position written out is 7,698.
- **Position 0 computes `[0 >= levelWeight[0]]`**, which is 0, where highlighter.ts writes the constant 0.
- **`firstErrorKind` is a register.** highlighter.ts reads it among the 513 positions' error kinds, at the count of positions before the error, which the first stage's emitter can't write. The step adds the position's error kind where the grammar enters the error state, which happens at most once. So the loop is the first GPU form here that returns the first error's kind.

It leaves out `depthExceeded`, which is `firstErrorKind === tooDeep`, and the bracket at the caret, which is one editor's state.

### The combination: a search that reads only some display kinds

With `masked`, search-step.ts's reverse step also reads the display kind of its code point, and nine cells that say which kinds the search reads. A code point of another kind is replaced by -1, the value of a cell past the text's end, which no step reads:

```ts
const bit = circuit.indexReadAffine([[kind, 1]], 0, searchable, 'clamp', 'clamp') // searchable[kind]
circuit.assumeGrid(bit, 1) // without it the class comparisons become sign cascades
const searched = circuit.roundAffine([[circuit.reglu([[codePoint, 1]], 1, [[bit, 1]], 0), 1]], -1) // (codePoint + 1) × bit − 1
```

That is the scratch prototype's construction, 3 more operations per position, and a match then lies inside one run of searched characters, e.g. inside one string value. On the GPU the kinds are the highlighter's per position output, a buffer that stays there, and the search shader reads it as a second input. So the highlighter runs once when the documents load, and a search runs only the search.

The scopes are sets of display kinds: `'everything'`, `'strings'` for the characters shown as string values, with their quotes, `'keys'`, `'stringsAndKeys'`, or any list of kinds, e.g. `[displayKind.number]`. An escape such as `\n` is a kind of its own, so no match of `'strings'` crosses one, and after the first error the highlighter shows every later key as a string. The characters are read as typed: with `'everything'` the escape `\u00e9` is 6 characters, and with `'strings'` it isn't read at all.

I didn't build the prototype's single circuit that holds both programs. highlighter.ts creates its own source table, so that needs a changed copy of it, and the kinds don't change when the pattern does. `buildMaskedSearch` is the masked search with every position written out, as one program for the CPU executor to compare with. It holds a copy of data-program.ts's two passes, which `buildDataSearch` builds inline and doesn't export.

### The searcher, one module for a demo page

searcher.ts has no page globals:

```ts
const {device} = await requestBatchDevice(bufferBytesFor(texts.length))
const searcher = await createGpuSearcher(device, texts) // or createCpuSearcher(texts)
searcher.validation.valid[7] // 1 when document 7 is valid JSON
const result = await searcher.search({pattern: '(the|an?) [a-z]+', scope: 'strings', window: {firstDocument: 0, documentCount: 40}})
if (result?.status === 'searched') result.matchCounts[7] // matches inside document 7's string values
```

- **Creating it** writes and uploads every document's cells, compiles the highlighter's loop shader, validates every document, and builds and compiles the search program of every state capacity, so that no search waits for a compile. `searcher.validation` holds `valid`, `firstErrorPosition`, `firstErrorKind` and `truncated` per document, and `searcher.load` the times.
- **`search`** compiles the pattern, uploads its cells, and returns every document's match count, the totals, the marks of the window's documents, and the times. `documents: 'window'` searches only the window's documents, for a scroll with an unchanged pattern. A syntax error returns its message and position, and a pattern that fits no program returns what it needs, e.g. "the pattern needs 33 states, and the program holds 32".
- **One program per state capacity**, 8, 16 and 32 by default. A pattern runs on the smallest one that holds it. A step takes one table read per pair of states, so on the CPU a search takes 2.4 and 13 times as long at 16 and 32 states as at 8, and the CPU searcher builds a larger program at the first search that needs it. On the GPU, with bit-emit.ts's shaders, the three take nearly the same time, 4.6, 4.7 and 5.2 ms for 100,000 documents when searches follow each other, and all three are compiled when the searcher is created.
- **One evaluation in flight, and only the newest request gets a result.** A request waits for the one before it, and a request that a newer one replaced, before or while it ran, resolves to `undefined`. A result arrives after the frame that asked for it, so a page treats it as an input of a later frame.
- **`kinds(window)`** copies the display kinds of some documents out of the GPU without a pass, e.g. the ones that scrolled into view.
- **`selfCheck(documents)`** compares the first documents with the same programs on the other backend: the GPU with generated JavaScript, and the CPU version with the executor. It checks the highlighter, and each search program with every one of its 11 searches that the program holds, among them a pattern of exactly 8, 16 and 32 states, one of characters above U+00FF, one that matches at every document's last character, and `[^,]+`, whose matches only the end of the searched characters stops. The tests and the measurement pages run it. The demo page doesn't, see [The demo page](#the-demo-page).
- **`limits`** is what the device granted and how many documents fit one buffer, and `programs()` lists each program's operations, statements and compile time.
- **`writers`**, an option of `createGpuSearcher`, says which of the two code writers writes the search programs' shaders and the highlighter's: `{search: 'bit-emit', highlighter: 'loop-emit'}` unless given, see [The second code writer](#the-second-code-writer-bit-emitts).
- **`createCpuSearcher(texts)`** has the same interface and runs the same loop programs as generated JavaScript. Its search loops stop at the text's end, and a search takes 0.14 ms per document of 300 code points at 8 states, so a page gives it hundreds of documents, or searches a few documents at a time in a worker, with `documents: 'window'`. For that, the option `highlight: 'whenFirstRead'` runs the highlighter on a document when a search or `kinds` first reads it, instead of on every document when the searcher is created, which takes about 9 s for 100,000 documents. A search's timings then leave the highlighter's time out, and reading `validation` runs the highlighter on every document that it hasn't run on yet.

### The comparisons that aren't the program

- **bit-rows.ts** is the same automaton with every row of a class's transition matrix as one 32-bit word, as a plain JavaScript loop and as a hand-written WGSL kernel from the scratch probe. A row there is one AND and one comparison per state, `(row[class][from] & finish) !== 0`, where the program takes one table read per pair of states. The kernel shows what this GPU does with the search when nothing has to be a sum, a ReLU gate or a table read of f32 values. The loop is the plain JavaScript baseline for the automaton, and what every GPU readback is compared with.
- **plain-search.ts** is what I'd write in plain JavaScript for the searcher's answers: the table loop once, then RegExp per search, on each run of searched characters for a scope other than everything. RegExp takes the first alternative that matches where the program takes the longest match, e.g. `a|abab` finds 2 matches in `xabab` where the program finds 1, so it's a baseline and not a check. On every pattern measured here the two counts are equal for every document.

## Correctness checks

### The first stage

json-search.test.ts has the first stage's 17 tests:

- A small program with every kind of row gives the executor's values through the WGSL interpreter, with and without guards, over 600 instances: index reads with each of the 4 pairs of rules, a fractional index form, a reversed table, a table of one repeated cell, a table of the instance's own cells, sums and products that round, both forms of ReGLU, a boolean atom, a shared cell read directly, and a sum of 40 terms. Generated JavaScript gives the same values.
- Both of the highlighter's shaders give the executor's outputs through the interpreter on all 2,509 texts of the highlighter's own tests, e.g. texts at and past the capacity and at depth 16 and 17: 7,527 summary values and 1,292,135 values with the kinds. With guards, on every fifth text. Generated JavaScript gives them on all 2,509.
- The executor's summary and kinds equal reference.ts's on those texts, and the table loop equals reference.ts on them and on 3,000 generated documents.
- `writeDocumentCells` writes what the highlighter's `writeText` writes, including lone surrogates and a text of 300 emoji.
- The emitter refuses `firstErrorKind`, and literals are exact float32 values, e.g. `0x1.000002p24f` for 16,777,218.
- Over 20,000 generated documents: a document is valid exactly when its label says so, JSON.parse agrees except for `tooDeep` and `tooLong`, every document fits the capacity except `tooLong`, every shape and defect appears, and a hash of the first 2,000 texts is pinned, so a change to the generator fails a test instead of silently changing every timing's input.

The interpreter rounds every f32 operation on its own, and says nothing about what a GPU compiler does. In headless Chrome:

- In each of the 3 main runs, every readback of every timed evaluation was compared with the CPU executor's outputs for the same documents: 26,918 to 27,901 readbacks and 7.3 to 7.6 billion values per run, with 0 mismatched values. For the expected values, the executor ran the display program over all 100,000 documents once per run, which took 8.3 to 8.7 s. Zeros of either sign count as equal.
- A readback is compared in whole, with one exception. Comparing the 51.2 million display kinds of 100,000 documents takes 54 ms, during which the GPU has nothing to do, and an evaluation after a pause is slower, see [After a pause](#after-a-pause). So the back to back series that reads back every kind compares the summary of every document and the kinds of 256 documents per readback, a different 256 each time, and a second series compares every value of every readback.
- With an upload per evaluation, consecutive evaluations upload the documents in their own order and in reverse order, and each readback is compared in the order that was uploaded, so a readback that matches shows that the new cells arrived.
- The highlighter's 2,509 test texts ran through both shaders on the GPU in every run: 7,527 summary values and 1,292,135 values with the kinds, 0 mismatched.
- The CPU versions agree on all 100,000 documents, in every run: the executor's `valid` is 1 exactly for the documents without a defect, JSON.parse agrees except for the 1,223 `tooDeep` and `tooLong` documents, and reference.ts and the table loop give the executor's `firstErrorPosition`, `truncated` and 512 kinds for every document. Generated JavaScript gives the executor's values on the first 5,000 documents.
- The check run compiled both shaders with and without guards, and compared the test texts and every output of the first 20,000 documents:

| Outputs | Guard | WGSL statements | WGSL bytes | Guards | Compile shader ms | Test texts: values, mismatched | Generated documents: documents, values, mismatched | Summary back to back ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| summary | none | 11,814 | 728,228 | 0 | 1,805 | 7,527, 0 | 20,000, 60,000, 0 | 1.14 (1.09 to 1.26) |
| display | none | 13,350 | 820,204 | 0 | 2,291 | 1,292,135, 0 | 20,000, 10,300,000, 0 | 1.58 (1.55 to 1.82) |
| summary | max | 11,814 | 848,193 | 9,225 | 4,011 | 7,527, 0 | 20,000, 60,000, 0 | 0.95 (0.92 to 1.03) |
| display | max | 13,350 | 946,825 | 9,737 | 5,227 | 1,292,135, 0 | 20,000, 10,300,000, 0 | 1.71 (1.59 to 2.09) |

  The last column is one evaluation of 20,000 documents with the summary read back, as the median, the smallest and the largest of 200 samples in that one process. The guards double the compile time, and in this one process they don't change an evaluation's time by more than the order of the measurements does.
- Only one GPU and one compiler were tested: an Apple M5 Max through Metal, in Chrome 155. Whether another GPU gives the same bits without guards isn't known, which is what `selfCheck` is for.

### Regex search, the highlighter's loop and the searcher

`bun test lab/json-search` runs 175 tests in 7 files without a GPU, 21 of them the demo page's, in demo.test.ts. The ones for the loops, in search.test.ts and searcher.test.ts:

- **Regex search's loop against form (a).** For 274 patterns of up to 8 states with 8 texts each, at a capacity of 40 positions, the loop program gives the match count and the marks of lab/regex-search's `buildDataSearch` on the CPU executor: on the executor, as generated JavaScript, and through the WGSL interpreter. The interpreter also runs the shader in the compiled program's statement order, with the bits as f32 values, and stopping at the text's end, each on every third or fifth pattern. The patterns are lab/regex-search's edge cases, the measurement's patterns, random ones, and the capacities: patterns of exactly 8 states, and one with 16 classes and 32 class boundaries, `([aeimquyC]|[cekmsuAC]|…|a|c)+`. Every pattern gets an empty text, a text as long as the program holds, a longer one, and two that end with a match on the last position. The full program's outputs are compared with lab/regex-search's automaton simulator first, so a mistake shared by the loop and the full program fails too.
- **16 and 32 states**, including patterns with exactly that many states: the loop as generated JavaScript and through the interpreter against form (a) at 24 positions.
- **512 positions in the store's layout**: 60 generated documents and 4 patterns at 8 states against form (a) with every position written out, which the builder writes as 127,414 operations. The plain JavaScript loop over 32-bit rows gives the same counts and marks there.
- **The window and the first document**: a document outside the window writes no marks, a window past the documents writes nothing, and a run that starts at document 2 writes only that document's count and marks.
- **The highlighter's loop**: on all 2,509 texts of the highlighter's own tests, `valid`, `firstErrorPosition`, `truncated`, `firstErrorKind` and the 512 display kinds equal the executor's for highlighter.ts, on the executor, as generated JavaScript and through the interpreter. The texts reach every error kind.
- **The masked search**: over 103 texts, 6 patterns and 5 scopes, `buildMaskedSearch` finds what the automaton simulator finds in the code points of the searched kinds, with every kind searchable it gives form (a)'s outputs, and the masked loop gives `buildMaskedSearch`'s outputs as generated JavaScript and through the interpreter.
- **The searcher on the CPU**: its validation and kinds against tests/json-highlighter/reference.ts on 64 texts, its counts and marks against the automaton simulator for 5 scopes and 4 patterns, a search of only the window's documents against the full one, the state capacity chosen per pattern, the results for a syntax error and for a pattern of 33 states, three requests of which only the newest gets a result, the self check between generated JavaScript and the executor, and a searcher that runs the highlighter when a document is first read against one that runs it at creation.
- **The searcher on the GPU, without a GPU.** interpreted-gpu.ts is a WebGPU device with the calls that gpu/host.ts makes, whose compute pass runs the shader's text through the WGSL interpreter. So `createGpuSearcher` runs under `bun test` as the page runs it: bit-emit.ts's shaders for the three search programs and loop-emit.ts's for the highlighter, all compiled at creation, the runner's buffers and packed words, and the readbacks. Over 10 documents its validation, kinds, counts and marks equal the CPU searcher's, for every document in one pass and for a window alone, with a pattern that fills each of the three programs. The same holds with the other writer for each shader. Three requests at once give only the newest a result. More of what the page's path does, each with a test that fails when the code is changed on purpose:
  - The searcher is created as the page creates it, with the cells that the page wrote and with a shader salt, and all four shaders hold the salt before the first search.
  - A runner packs its words when it is created, so an evaluation that uploads no shared values searches for the pattern that the runner was created with.
  - A bind group that the device refuses while the three search runners are created at the same time fails the creation with the device's message as a validation error, for each of the four runners. The device keeps WebGPU's stack of error scopes for this. With an await between the runner's two pops, the fourth runner's error came out as "out of memory", as it did on the GPU.
  - The self check runs its 11 searches on every program that holds them, 30 in all, with 0 values different, over four documents in which each search has a match: the first one is written by hand, since `connection rese` and `東京` find nothing in the first four generated documents, and a search without a match compares only zeros.
  - With the bits of `packWords` put into other places on purpose, six tests fail, four of these, edge-cases.test.ts's test of the GPU searcher and the demo page's, so the tests do read the packed words. With bit 7, 15 or 31 of every word left out, with code points above U+00FF read as U+00FF, and with the -1 of a cell past the text's end read as U+0000, the self check's test fails.
- **The demo page's own searches**, in demo.test.ts: for the pattern that the page starts with and each example of its Try list, read from demo.html, the GPU searcher over the interpreted device gives the counts of the page's first 40 documents, and the kinds and marks of the document that the page would show, that the CPU searcher of the page's worker gives.
- **bit-emit.ts's rules**, in bit-emit.test.ts and million/writer-probes.test.ts: which rules fire on the search step, the highlighter's step and 87 small programs, the programs where a rule must not fire, and both writers' shaders against the CPU executor through the interpreter, see [million/README.md](million/README.md#the-values-that-were-compared).
- The hand-written kernel has no test under `bun test`. Its JavaScript twin, the loop over 32-bit rows, is tested, and the kernel itself is only checked on the GPU.

In headless Chrome:

- **Every readback of every timed search** was compared with the plain JavaScript loop over 32-bit rows: 27,136 to 34,892 searches and 0.70 to 0.99 billion values per run, 0 mismatched. Consecutive searches use different patterns, so a readback that matches shows that the new pattern's cells arrived.
- **The plain loop isn't the program**, so each run first compares it with the program on the CPU: with the loop program as generated JavaScript for the first 200 documents, for every pattern that fits, at every capacity, 4,004,000 values per run, and with form (a) with every position written out on the executor for the first 40 documents, at the four capacities up to 16 states, 492,800 values per run. None differed. Running the program itself over 100,000 documents on the CPU takes 25 s to 6 minutes per pattern as generated JavaScript, and 10 times that on the executor.
- **The searcher**: in each of 5 runs, the validation of every document and every display kind against the table loop, 57.3 million values, 9,430 to 9,823 searches with 390 to 409 million values against the plain loop masked by the table loop's kinds, the plain loop against the loop program on the CPU for the first 200 documents, 10.8 million values for 10 patterns and 3 scopes, and the searcher's self check, 2.6 million values. None differed.
- On these documents RegExp's count equals the program's for every measured pattern and every document, in every scope. That is a property of these patterns, not of RegExp: `a|abab` finds 2 matches in `xabab` where the program finds 1.
- Only one GPU and one compiler were tested, as in the first stage: an Apple M5 Max through Metal, in Chrome 155.

### The review's checks: the limits, and the programs with every position written out

The checks above compare the GPU with the CPU executor for the first stage, and for the second stage with a plain JavaScript highlighter and a plain JavaScript loop over the automaton, which each run compares with the programs on the CPU for its first 200 documents. The documents are generated JSON, of which 601 in 100,000 pass the capacity and none is empty. So the review added documents and patterns at the limits, and a reference that is the repo's own programs with every position written out.

edge-cases.ts has 280 hand-written documents and the comparison:

- **Lengths**: the empty text, every ASCII character as a text of one code point, lone surrogates, and texts of 511, 512, 513 and 514 code points: a string, an array, spaces, a number or an error at the last position, a bracket that opens at the last position, a string of emoji, an escape that the capacity cuts, and texts of 1,200 and 2,000 code points.
- **Nesting**: arrays, objects, and both in turn, 1, 2, 15, 16, 17, 18 and 40 deep, 16 and 17 openers that end exactly at code point 511, braces closed by brackets, only closers, only openers, and texts that keep adding 2^15 to the container code after the first error, e.g. `[[[[[[[[[[[[[[[{]{]{]…`.
- **Matches**: at the first and at the last position, a match whose last code point the capacity cuts, 512 times the same character, emoji around a match, the same words as a key, as a value and outside strings, and an escape inside a string.
- **Patterns**, 18, 5 and 4 at 8, 16 and 32 states: as many states as each program holds, e.g. `abcdefg` and 31 times `a`, one of each capacity with 16 classes and 32 class boundaries, the empty class `[]`, which matches nothing, `[^]`, which matches every code point on its own, `[^]+`, which matches the whole text, and the empty pattern and `a*`, whose empty matches the search never reports. Every pattern runs over every kind of character, and a second time over string values, keys, both, numbers and literals, or no kind at all.
- `edgeDocuments` adds generated documents of which every one is broken, generated documents with 1 in 10 broken, and the highlighter's own kinds of test texts with another seed.
- `compareWithWrittenOutPrograms(searcher, texts, searches)` takes a searcher on the CPU or on the GPU, and compares its validation, every display kind, every match count and every mark with [src/json-highlighter/highlighter.ts](../../src/json-highlighter/highlighter.ts) and with `buildMaskedSearch`, both on the CPU executor. It also counts what the expected values hold, e.g. matches and marked positions, so that zeros compared with zeros can't pass unnoticed.

Without a GPU:

- edge-cases.test.ts, 6 tests in about 25 s: the executor's values say that the documents reach the limits, e.g. a string of 512 code points is valid, one of 513 is `tooLong` at code point 512, 16 arrays deep is valid and 17 is `tooDeep` at code point 16, `[^]` finds 512 matches in 512 and in 513 times `a`, and `abcdefg` matches on the last 7 positions and not when the capacity cuts its `g`. The searcher as generated JavaScript gives the written-out programs' values: the validation and kinds of all 280 documents, and 24 searches at 8 states over the 144 documents of more than one code point. So does the searcher on the CPU executor for 36 documents and 8 searches, a window of 16 at a time, and at 16 states for 72 documents and 10 searches. At 32 states the two CPU backends are compared. With `truncated` computed as `length >= 512` in json-step.ts, the second test fails with 70 different values. The searcher on the GPU, over the interpreted device, gives the written-out programs' values for 48 of the documents and 12 searches at 8 states, and the CPU searcher's for the patterns that fill 16 and 32 states over 19 documents whose matches touch the first and the last position.
- `bun lab/json-search/report.ts edge-cases`, about 5 minutes: 1,449 documents and 46 searches up to 16 states, 34.2 million search values and 747,684 validation values, 0 different, with 540,943 expected matches. At 32 states, against the written-out program of 1,167,392 operations: 144 documents and 8 searches, 590,976 values, 0 different. The loop programs on the CPU executor: 36 documents and 16 searches, 295,808 values, 0 different. The highlighter's loop alone over 31,629 more texts: 16.3 million values, 0 different.

In headless Chrome, one process each (results/review-edge-1.json and review-many-1.json, 1-minute load average 3.3 to 4.4 and 2.2 to 3.6):

- **The limits on the GPU**: a GPU searcher over the same 1,449 documents, against the written-out programs on the CPU executor. Validation and kinds: 747,684 values, 0 different. 46 searches up to 16 states, every match count and the marks of every document: 34.2 million values, 0 different, with 540,943 expected matches and 1.68 million marked positions, and 36 of the 46 searches find something. The executor took 179 s for the expected values. At 32 states, against the loop program as generated JavaScript: 8 searches, 2.8 million values, 0 different, and against the loop program on the CPU executor for 32 of the documents: 131,328 values, 0 different.
- **Three requests at once on the GPU**, 20 rounds: the two older requests resolved to `undefined` every time, and the newest one's counts and marks equal those of the same search alone, 2.65 million values, 0 different.
- **The first stage's two shaders** over the same 1,449 documents, against the executor: 4,347 and 746,235 values, 0 different.
- **All 100,000 generated documents**: the searcher's validation and every display kind against highlighter.ts on the CPU executor, 51.6 million values, 0 different, of which 47.0 million expected kinds aren't 0. Five searches against the loop programs as generated JavaScript over every document, four at 8 states and one at 16, which took the CPU 25 s and 63 s each: 992,160 values, 0 different, 2.67 million expected matches. Two searches at 32 states over the first 10,000 documents, and three searches on the CPU executor over the first 2,000: 189,840 values, 0 different.
- So on this GPU the loops gave the full programs' values at every limit that was tried. Other GPUs, other browsers, and other documents remain untested.

## Measured results: the highlighter with every position written out

Measured on October 13, 2026, on an Apple M5 Max with 18 cores and 36 GiB, macOS 27.0, Bun 1.4.3, and headless Chrome 155.0.8059.40 through Metal, with timestamp queries. The page is cross-origin isolated, so `performance.now()` reads in steps of 5 µs. Other agents' work ran on the machine throughout. The 1-minute load average, sampled every 10 s, was 1.62 to 5.19 during run 1, 2.62 to 8.73 during run 2, and 2.96 to 12.29 during run 3.

Method:

- A run is one fresh Chrome process with a fresh profile folder and a shader salt that no earlier run used, and takes 7.3 minutes. There are 3 main runs, results/gpu-main-1.json to gpu-main-3.json, and 1 check run, results/gpu-check-1.json. A cell of a table shows the median of the 3 runs' medians, and their range in parentheses.
- One evaluation's time runs from before the commands are encoded until the values that were read back are copied out of the mapped buffers into JavaScript arrays. With an upload it starts before JavaScript writes the cells.
- **Back to back**: each evaluation starts as soon as the previous one's values are compared, at most 0.4 ms later. At least 0.3 s and 3 evaluations of warmup, then at least 15 samples and 1.5 s, and at most 200 samples.
- **After a pause**: the page waits with `setTimeout` and then evaluates once, 5 times per pause length and run.
- **With an upload**: for every evaluation, JavaScript writes the cells of every document again from the texts and uploads them with one `writeBuffer` call.
- **The CPU baselines** loop over the first n documents in the same page: 0.5 s and at least 2 passes of warmup, then 5 samples of whole passes, each at least 0.2 s. The executor and generated JavaScript run the first 300 and the first 5,000 documents, and their ms are that µs per document times the count, an extrapolation.
- What an evaluation computes and reads back:

| Variant | Shader | Read back |
| --- | --- | --- |
| summary | summary | `valid`, `firstErrorPosition` and `truncated` of every document, 12 bytes per document |
| display-window | display | the summary of every document, and the 512 display kinds of 64 documents in the middle of the batch, e.g. the ones a list shows |
| display-all | display | the summary and the 512 display kinds of every document, 2,060 bytes per document |

### Sizes and compile times

| Outputs | Source cells | Live operations | Layers | Stored weights | Index reads | WGSL statements | WGSL bytes | Build ms | Compile program ms | Emit WGSL ms | Compile shader ms, cold |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| summary | 4,575 | 7,186 | 536 | 12,307 | 4,609 | 11,814 | 728,228 | 32.7 (31.4 to 33.1) | 7.83 (7.68 to 7.88) | 17.3 (16.9 to 18.4) | 1,871 (1,777 to 2,071) |
| display | 4,575 | 7,698 | 536 | 13,331 | 5,121 | 13,350 | 820,204 | 32.7 (31.4 to 33.1) | 3.96 (3.64 to 7.60) | 14.0 (13.7 to 20.6) | 2,336 (2,236 to 2,557) |

Build, compile program and emit are JavaScript in the page: `buildHighlighter('loop')`, `compileTensorProgram` and `emitWgsl`. The shader compile runs from `createShaderModule` until `createComputePipelineAsync` resolves, including reading the compilation messages. Before both, each process compiles a shader with one empty function, so that the one-time setup of a process's first pipeline isn't counted: 33.5 ms (32.7 to 34.3).

So a page pays about 1.9 s once for the summary shader, or about 2.3 s for the display shader, before its first evaluation. I looked for a cache and found none: the same shader text with run 3's salt compiled in 1.78 s and 2.30 s in a new Chrome process on a copy of run 3's profile folder, and in 1.96 s and 2.51 s on a fresh profile folder (results/gpu-warm-copied-profile.json and gpu-warm-fresh-profile.json, one process each). A page that stays open, or a reload in the same process, wasn't tried.

### The CPU baselines

µs per document:

| Documents | JSON.parse µs per document | table loop µs per document | reference.ts µs per document | generated JavaScript, summary, sampled µs per document | generated JavaScript, display, sampled µs per document | executor, summary, sampled µs per document | executor, display, sampled µs per document |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 0.74 (0.72 to 0.74) | 1.16 (1.15 to 1.20) | 4.98 (4.97 to 5.07) | 18.1 (17.5 to 18.3) | 20.1 (19.8 to 21.4) | 80.7 (77.5 to 82.1) | 86.8 (81.8 to 90.7) |
| 1,000 | 0.59 (0.57 to 0.60) | 1.20 (1.19 to 1.40) | 5.27 (5.21 to 6.03) | 18.4 (18.0 to 20.1) | 20.6 (20.1 to 22.9) | 78.8 (76.3 to 91.6) | 87.3 (82.5 to 99.9) |
| 10,000 | 0.92 (0.86 to 0.93) | 1.28 (1.18 to 1.28) | 5.65 (5.21 to 5.73) | 17.6 (17.2 to 18.5) | 20.3 (20.1 to 20.7) | 81.6 (78.6 to 82.6) | 85.7 (82.1 to 86.1) |
| 100,000 | 0.88 (0.87 to 0.89) | 1.19 (1.19 to 1.20) | 5.18 (5.16 to 5.24) | 17.9 (17.4 to 19.2) | 20.6 (20.3 to 20.8) | 76.7 (75.5 to 77.2) | 83.9 (81.0 to 87.3) |

ms for the whole batch:

| Documents | JSON.parse ms | table loop ms | reference.ts ms | generated JavaScript, summary ms, extrapolated | generated JavaScript, display ms, extrapolated | executor, summary ms, extrapolated | executor, display ms, extrapolated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 0.07 (0.07 to 0.07) | 0.12 (0.11 to 0.12) | 0.50 (0.50 to 0.51) | 1.81 (1.75 to 1.83) | 2.01 (1.98 to 2.14) | 8.07 (7.75 to 8.21) | 8.68 (8.18 to 9.07) |
| 1,000 | 0.59 (0.57 to 0.60) | 1.20 (1.19 to 1.40) | 5.27 (5.21 to 6.03) | 18.4 (18.0 to 20.1) | 20.6 (20.1 to 22.9) | 78.8 (76.3 to 91.6) | 87.3 (82.5 to 99.9) |
| 10,000 | 9.22 (8.55 to 9.29) | 12.8 (11.8 to 12.8) | 56.4 (52.1 to 57.3) | 176 (172 to 185) | 203 (201 to 207) | 816 (786 to 826) | 857 (821 to 861) |
| 100,000 | 87.5 (86.9 to 89.2) | 119 (119 to 120) | 518 (516 to 524) | 1,789 (1,740 to 1,918) | 2,061 (2,028 to 2,080) | 7,673 (7,549 to 7,720) | 8,390 (8,098 to 8,730) |

- JSON.parse's time depends on how many documents are broken, since a broken one costs a thrown `SyntaxError`: 0.64 µs (0.59 to 0.69) per valid document and 4.70 µs (4.42 to 5.06) per document where it throws. The 8,834 documents where it throws are 8.8% of this batch and about 40% of JSON.parse's time.
- The table loop takes 1.2 to 1.3 µs per document, about 4 ns per code point, and reference.ts 5.0 to 5.7 µs. The table loop is the fair comparison for the display kinds.
- The executor takes 77 to 87 µs per document and generated JavaScript 18 to 21 µs, whatever the document, since both run every operation.

### With the documents already on the GPU

One evaluation, ms. The compute pass comes from a second back to back series with a timestamp query, so at small counts it can exceed the first series' total:

| Variant | Documents | MB read back | Back to back | Compute pass, timestamps | After a pause of 1 ms | After a pause of 4 ms | After a pause of 16 ms | After a pause of 50 ms | After a pause of 200 ms | After a pause of 1,000 ms | After a pause of 3,000 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| summary | 100 | 0.001 | 0.73 (0.70 to 0.75) | 0.68 (0.68 to 1.04) | 1.31 (1.28 to 1.31) | 2.07 (2.07 to 2.11) | 2.21 (2.19 to 2.24) | 2.37 (2.26 to 2.39) | 2.38 (2.35 to 2.44) | 2.39 (2.39 to 2.40) | 8.18 (7.77 to 8.36) |
| summary | 1,000 | 0.012 | 0.77 (0.76 to 0.78) | 1.01 (0.71 to 1.04) | 1.34 (1.33 to 1.37) | 1.77 (1.73 to 2.17) | 2.35 (2.26 to 2.37) | 2.41 (2.37 to 2.44) | 2.49 (2.48 to 2.50) | 2.56 (2.53 to 3.00) | 8.75 (8.27 to 9.03) |
| summary | 10,000 | 0.120 | 0.76 (0.74 to 0.80) | 0.52 (0.51 to 1.20) | 0.88 (0.78 to 1.42) | 1.34 (1.33 to 2.04) | 1.55 (1.45 to 2.66) | 2.68 (2.67 to 2.78) | 2.75 (2.67 to 2.78) | 2.75 (2.71 to 2.76) | 8.67 (8.67 to 14.93) |
| summary | 100,000 | 1.200 | 3.75 (3.72 to 3.79) | 3.43 (3.43 to 3.45) | 4.19 (4.17 to 4.35) | 4.25 (4.23 to 4.30) | 4.30 (4.30 to 4.31) | 5.52 (4.62 to 7.16) | 11.0 (10.9 to 11.1) | 11.0 (11.0 to 11.0) | 18.4 (16.7 to 23.2) |
| display-window | 100 | 0.132 | 0.77 (0.67 to 0.83) | 0.45 (0.45 to 0.72) | 0.82 (0.72 to 1.44) | 1.50 (1.20 to 1.88) | 2.25 (1.88 to 2.40) | 3.02 (2.60 to 3.37) | 2.70 (2.69 to 3.01) | 2.94 (2.73 to 3.02) | 23.2 (13.7 to 28.5) |
| display-window | 1,000 | 0.143 | 0.72 (0.71 to 0.90) | 0.46 (0.46 to 0.46) | 0.72 (0.69 to 0.75) | 1.24 (1.22 to 1.38) | 1.45 (1.29 to 1.62) | 2.72 (2.67 to 2.85) | 2.73 (2.68 to 3.34) | 2.77 (2.75 to 3.42) | 25.6 (17.5 to 40.2) |
| display-window | 10,000 | 0.251 | 1.03 (0.95 to 1.42) | 0.71 (0.66 to 1.15) | 1.19 (1.06 to 1.50) | 1.88 (1.76 to 1.97) | 2.95 (2.74 to 3.11) | 3.11 (3.10 to 4.17) | 3.19 (3.08 to 4.23) | 3.16 (3.12 to 3.26) | 14.6 (14.3 to 19.2) |
| display-window | 100,000 | 1.331 | 5.66 (5.61 to 5.87) | 5.31 (5.29 to 5.32) | 6.58 (6.42 to 6.70) | 6.33 (6.24 to 6.98) | 6.64 (6.21 to 6.91) | 7.61 (6.58 to 7.71) | 14.5 (12.2 to 14.7) | 13.8 (12.3 to 14.9) | 27.5 (22.5 to 29.3) |
| display-all | 100 | 0.206 | 0.77 (0.71 to 1.10) | 0.79 (0.45 to 1.62) | 1.46 (0.77 to 2.14) | 2.31 (1.57 to 2.38) | 2.43 (2.34 to 2.73) | 2.80 (2.56 to 3.27) | 2.79 (2.64 to 3.62) | 3.41 (2.64 to 3.72) | 25.0 (14.0 to 30.9) |
| display-all | 1,000 | 2.060 | 1.22 (0.84 to 1.51) | 0.46 (0.46 to 1.68) | 1.44 (1.43 to 2.52) | 1.53 (1.51 to 2.62) | 2.74 (2.04 to 2.81) | 3.56 (2.75 to 3.76) | 3.82 (2.83 to 4.05) | 3.27 (2.91 to 3.69) | 13.3 (12.9 to 15.6) |
| display-all | 10,000 | 20.600 | 3.36 (2.00 to 3.38) | 2.24 (2.24 to 2.25) | 3.74 (2.46 to 3.77) | 3.82 (2.81 to 3.83) | 3.78 (3.78 to 3.82) | 3.84 (3.81 to 4.14) | 4.07 (3.83 to 5.36) | 3.97 (3.82 to 6.35) | 20.1 (16.5 to 31.7) |
| display-all | 100,000 | 206.000 | 13.7 (13.4 to 13.7) | 5.49 (5.41 to 5.50) | 16.4 (14.6 to 16.6) | 17.9 (16.6 to 18.5) | 16.9 (16.6 to 18.0) | 19.3 (16.7 to 19.4) | 19.7 (19.5 to 22.4) | 20.2 (19.4 to 27.1) | 45.5 (42.6 to 50.1) |

The parts of one back to back evaluation, ms, as medians of the runs' medians. "Gap before" is the time between the end of the previous evaluation and the start of this one, i.e. the comparison:

| Variant | Documents | Encode and submit | Submit to mapped | Copy out | Total | Gap before, ms |
| --- | --- | --- | --- | --- | --- | --- |
| summary | 100 | 0.005 | 0.720 | 0.000 | 0.725 | 0.000 |
| summary | 1,000 | 0.005 | 0.760 | 0.000 | 0.770 | 0.000 |
| summary | 10,000 | 0.005 | 0.745 | 0.005 | 0.755 | 0.015 |
| summary | 100,000 | 0.010 | 3.715 | 0.020 | 3.748 | 0.150 |
| display-window | 100 | 0.005 | 0.765 | 0.005 | 0.770 | 0.035 |
| display-window | 1,000 | 0.005 | 0.705 | 0.005 | 0.720 | 0.035 |
| display-window | 10,000 | 0.010 | 1.005 | 0.010 | 1.030 | 0.060 |
| display-window | 100,000 | 0.010 | 5.630 | 0.025 | 5.660 | 0.285 |
| display-all | 100 | 0.005 | 0.760 | 0.005 | 0.770 | 0.055 |
| display-all | 1,000 | 0.005 | 1.173 | 0.035 | 1.220 | 0.135 |
| display-all, every value compared | 1,000 | 0.005 | 0.810 | 0.030 | 0.84 (0.83 to 2.15) | 0.490 |
| display-all | 10,000 | 0.010 | 3.035 | 0.310 | 3.355 | 0.160 |
| display-all, every value compared | 10,000 | 0.015 | 3.415 | 0.320 | 3.75 (3.24 to 3.78) | 5.155 |
| display-all | 100,000 | 0.015 | 10.565 | 3.065 | 13.660 | 0.400 |
| display-all, every value compared | 100,000 | 0.025 | 12.855 | 3.163 | 16.0 (15.4 to 17.2) | 53.910 |

In display-all's rows of the first table, an evaluation after a pause follows a comparison of every value, so at 100,000 documents the GPU has been left alone for 54 ms more than the column says.

- Up to 10,000 documents an evaluation takes 0.6 to 0.8 ms whatever the count: 0.58 ms for 1 document, 0.73 ms for 100, 0.76 ms for 10,000. That is the round trip to the GPU, almost all of it between `submit` and the readback being mapped. Then the pass grows with the count: 1.34 ms at 30,000 and 3.75 ms at 100,000, i.e. 34 ns per document for 7,186 operations, about 210 billion operations per second.
- The kinds cost little when they stay on the GPU. The display shader with the kinds of 64 documents read back takes 5.66 ms at 100,000 documents, 1.9 ms more than the summary, for 512 more operations and 512 more values written per document.
- Reading back every kind is where the time goes otherwise: 13.7 ms at 100,000 documents for 206 MB, of which the compute pass is 5.5 ms and copying the mapped values into a JavaScript array is 3.1 ms. With every value of every readback compared, which leaves the GPU alone for 54 ms between evaluations, the same evaluation takes 16.0 ms (15.4 to 17.2).

### After a pause

The back to back numbers need the GPU to be busy. The table above has one evaluation after the page waited 1 ms to 3 s. Below is the summary variant again with a timestamp query around the compute pass, as total ms and pass ms. Reading the timestamps back takes a moment after each evaluation, so this series' short pauses are longer than their names, and its totals are higher than the table above. The last column is a pause of 1 s during which the page dispatches the shader over 1 document every 16 ms:

| Documents | Back to back: total, pass | Pause of 1 ms: total, pass | Pause of 4 ms: total, pass | Pause of 16 ms: total, pass | Pause of 50 ms: total, pass | Pause of 200 ms: total, pass | Pause of 1,000 ms: total, pass | Pause of 3,000 ms: total, pass | Pause of 1,000 ms with a one-document dispatch every 16 ms: total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 1.02, 0.68 | 2.37, 1.50 | 2.50, 1.50 | 2.78, 1.52 | 2.57, 1.56 | 2.56, 1.56 | 2.63, 1.56 | 8.63, 1.56 | 2.30 (2.28 to 2.32) |
| 1,000 | 1.39, 1.01 | 2.46, 1.57 | 2.44, 1.59 | 2.52, 1.61 | 2.62, 1.64 | 2.62, 1.64 | 2.69, 1.64 | 7.75, 1.65 | 2.30 (2.24 to 2.38) |
| 10,000 | 0.94, 0.52 | 2.81, 1.87 | 2.90, 1.87 | 2.81, 1.88 | 2.93, 1.90 | 2.94, 1.91 | 3.01, 1.90 | 9.45, 1.88 | 2.59 (2.52 to 2.67) |
| 100,000 | 3.92, 3.43 | 5.64, 4.24 | 5.66, 4.30 | 6.48, 4.78 | 9.18, 7.85 | 11.86, 10.65 | 11.94, 10.22 | 19.22, 10.09 | 11.1 (10.9 to 12.3) |

- An evaluation of up to 10,000 documents takes 1.5 to 2.4 ms after a pause of 16 ms, and 2.4 to 2.8 ms after 50 ms to 1 s, instead of 0.7 to 0.8 ms. At 100,000 documents it takes 4.30 ms after 16 ms, 5.52 ms after 50 ms, 11.0 ms after 200 ms or 1 s, and 18.4 ms after 3 s, against 3.75 ms back to back.
- Most of the difference is the compute pass itself: at 100,000 documents the timestamp queries give 3.43 ms back to back, 4.2 to 4.8 ms after a pause of 1 to 16 ms, 7.9 ms after 50 ms, and 10.1 to 10.7 ms after 200 ms or more. At 100 to 10,000 documents the pass goes from 0.5 to 1.0 ms to 1.5 to 1.9 ms.
- After 3 s the pass takes what it takes after 1 s, and the rest of the round trip takes 5 to 7 ms more, e.g. 8.63 ms in all for a pass of 1.56 ms at 100 documents. With the display shader, an evaluation after 3 s took 13 to 50 ms at every count.
- A one-document dispatch every 16 ms during the pause doesn't help: 2.30 to 2.59 ms and 11.1 ms, against 2.39 to 2.75 ms and 11.0 ms without.
- I didn't find the cause. A GPU that lowers its clock when it has little to do would explain the pass, and a process or a thread that goes to sleep would explain the rest after 3 s. Neither is verified, and headless Chrome has no display to keep the GPU busy, so a visible page may differ.
- So a page that evaluates once per keystroke should expect the first table's columns from 50 ms to 1 s: 2.4 to 3.2 ms up to 10,000 documents, and 5.5 to 14.5 ms at 100,000, for the summary alone or with the kinds of 64 documents.

### With an upload per evaluation

One evaluation that writes every document's cells in JavaScript, uploads them, runs the pass and reads back, ms:

| Variant | Documents | MB uploaded | MB read back | Writing the cells in JavaScript | writeBuffer call | Submit to mapped | Copy out | Total with the cells |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| summary | 100 | 0.21 | 0.001 | 0.04 (0.04 to 0.04) | 0.05 (0.05 to 0.05) | 0.77 (0.76 to 0.78) | 0.00 (0.00 to 0.01) | 0.87 (0.85 to 0.87) |
| summary | 1,000 | 2.05 | 0.012 | 0.38 (0.37 to 0.38) | 0.50 (0.50 to 0.51) | 1.84 (0.67 to 1.85) | 0.01 (0.01 to 0.01) | 2.72 (1.57 to 2.75) |
| summary | 10,000 | 20.52 | 0.120 | 3.69 (3.66 to 3.71) | 0.31 (0.30 to 0.31) | 4.11 (4.09 to 4.30) | 0.01 (0.01 to 0.01) | 8.13 (8.10 to 8.32) |
| summary | 100,000 | 205.20 | 1.200 | 37.0 (36.8 to 37.2) | 3.10 (3.03 to 3.13) | 26.4 (26.0 to 27.8) | 0.03 (0.03 to 0.03) | 66.6 (66.5 to 68.0) |
| display-all | 100 | 0.21 | 0.206 | 0.04 (0.04 to 0.04) | 0.05 (0.05 to 0.05) | 0.77 (0.77 to 0.91) | 0.01 (0.01 to 0.01) | 0.87 (0.86 to 1.01) |
| display-all | 1,000 | 2.05 | 2.060 | 0.38 (0.37 to 0.38) | 0.49 (0.49 to 0.50) | 1.39 (1.17 to 2.20) | 0.03 (0.03 to 0.04) | 2.29 (2.06 to 3.15) |
| display-all | 10,000 | 20.52 | 20.600 | 3.68 (3.67 to 3.75) | 0.30 (0.30 to 0.32) | 5.17 (4.50 to 5.37) | 0.32 (0.31 to 0.33) | 9.49 (8.80 to 9.73) |
| display-all | 100,000 | 205.20 | 206.000 | 38.1 (37.3 to 38.2) | 3.13 (3.05 to 3.18) | 32.0 (31.4 to 32.7) | 3.16 (3.10 to 3.17) | 76.3 (75.6 to 77.8) |

- At 100,000 documents the summary takes 66.6 ms: 37.0 ms of JavaScript writing 51.3 million cells from the texts, 3.1 ms in the `writeBuffer` call, and 26.4 ms from `submit` to the mapped readback, which is the 205 MB reaching the GPU and then the pass. The pass's own 3.4 ms is about a twentieth of the total.
- JavaScript writing the cells takes 0.37 µs per document, which alone is more than half of what JSON.parse takes for a valid document.
- The first load of a page is this case once: uploading 205.2 MB and evaluating 100,000 documents for the first time took 96 ms (49 to 100), after the shader compile.

### The crossover

The document count from which the GPU takes less time than each baseline at every larger measured count, interpolated between the two neighboring measured counts. The summary is compared with JSON.parse and with the summary programs on the CPU, and the display variants with the display programs. `summarize.ts` also prints each run's own crossover and the ms on both sides at every count.

| GPU series | JSON.parse | table loop | reference.ts | generated JavaScript, extrapolated | executor, extrapolated |
| --- | --- | --- | --- | --- | --- |
| summary, back to back | 1,300 (1,300 to 1,300) | 590 (510 to 590) | 140 (140 to 140) | 37 (36 to 41) | 8 (7 to 9) |
| summary, after a pause of 16 ms | 2,700 (2,600 to 2,900) | 1,800 (1,800 to 1,900) | 430 (380 to 440) | 120 (120 to 130) | below 100 |
| summary, after a pause of 1,000 ms | 3,100 (3,100 to 3,400) | 2,100 (2,100 to 2,200) | 470 (440 to 470) | 130 (130 to 140) | below 100 |
| summary, with an upload | 7,000 (5,700 to 8,400) | 3,200 (1,300 to 3,600) | 210 (160 to 220) | below 100 | below 100 |
| display-window, back to back |  | 620 (500 to 710) | 150 (130 to 160) | below 100 | below 100 |
| display-window, after a pause of 16 ms |  | 1,200 (1,100 to 1,400) | 380 (310 to 410) | 110 | below 100 |
| display-window, after a pause of 1,000 ms |  | 2,300 (2,100 to 2,800) | 540 (490 to 600) | 140 (140 to 140) | below 100 |
| display-all, back to back |  | 1,000 (680 to 1,300) | 160 (150 to 200) | below 100 | below 100 |
| display-all, with an upload |  | 3,300 (2,500 to 4,100) | 200 (170 to 230) | below 100 | below 100 |

The summary back to back at every measured count, ms:

| Documents | 1 | 10 | 30 | 100 | 300 | 1,000 | 3,000 | 10,000 | 30,000 | 100,000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Total | 0.58 (0.57 to 0.72) | 0.64 (0.61 to 0.67) | 0.67 (0.66 to 0.72) | 0.73 (0.70 to 0.75) | 0.66 (0.62 to 0.67) | 0.77 (0.76 to 0.78) | 0.60 (0.60 to 0.70) | 0.76 (0.74 to 0.80) | 1.34 (1.33 to 1.42) | 3.75 (3.72 to 3.79) |
| Compute pass | 0.43 (0.43 to 1.04) | 0.53 (0.52 to 0.55) | 0.68 (0.52 to 0.76) | 0.68 (0.68 to 1.04) | 0.55 (0.42 to 0.75) | 1.01 (0.71 to 1.04) | 0.62 (0.45 to 0.90) | 0.52 (0.51 to 1.20) | 1.13 (1.12 to 1.13) | 3.43 (3.43 to 3.45) |

### Is the GPU clearly faster, for the highlighter with every position written out

Yes, in one condition: many documents that are already on the GPU. No, for a few documents, and not clearly when every evaluation has to bring its documents along.

**Where it is clearly faster.** With 100,000 documents on the GPU, one evaluation gives `valid`, the first error's position and `truncated` for every document in 3.75 ms when evaluations follow each other, and in 5.5 to 11 ms when the page evaluates after a pause of 50 ms to 1 s, e.g. once per keystroke. In the same page:

| Compared with | ms for 100,000 documents | The GPU takes this many times less, back to back | After a pause of 1 s |
| --- | --- | --- | --- |
| JSON.parse, validity only | 87.5 | 23 | 8 |
| The table loop, plain JavaScript with the same outputs | 119 | 32 | 11 |
| reference.ts, plain JavaScript written to be read | 518 | 138 | 47 |
| Generated JavaScript of the same program, extrapolated | 1,789 | 477 | 163 |
| The CPU executor on the same program, extrapolated | 7,673 | 2,046 | 698 |

With the display kinds of the 64 documents on screen read back as well, the GPU takes 5.66 ms back to back and 13.8 ms after 1 s, which is still 21 and 9 times less than the table loop.

**From how many documents.** Against the same program on the CPU, from about 8 documents for the executor and about 40 for generated JavaScript. Against plain JavaScript with the same outputs, from about 600 documents back to back and about 2,000 after a pause. Against JSON.parse, from about 1,300 documents back to back and about 3,000 after a pause. "Clearly" starts about 10 times higher: at 10,000 documents the GPU takes 0.76 ms back to back and 2.7 ms after a pause of 50 ms or more, against 9.2 ms for JSON.parse and 12.8 ms for the table loop, i.e. 3 to 17 times less.

**Where it isn't.**

- At 100 documents the GPU is slower than every plain JavaScript baseline, and up to about 600 documents slower than the table loop, since a round trip takes 0.6 to 0.8 ms at best and 1.5 to 2.8 ms after a pause, whatever the count. JSON.parse takes 0.07 ms for 100 documents.
- When every evaluation uploads its documents, the GPU takes 66.6 ms for 100,000 documents, against 87.5 ms for JSON.parse and 119 ms for the table loop: 1.3 and 1.8 times less, from about 7,000 and 3,200 documents on. That isn't clearly faster, and more than half of the 66.6 ms is JavaScript writing cells, not the GPU.
- The first evaluation waits for the shader to compile, about 2 s, and JSON.parse has checked 100,000 documents 20 times over by then.
- Reading every display kind back to JavaScript takes 13.7 ms for 100,000 documents, 9 times less than the table loop, but 206 MB per evaluation is nothing a page needs. Reading back what is on screen is the practical form.

**What this means for the JSON half alone.** A document's kinds and first error only change when its text changes, so once the documents are on the GPU and evaluated, the highlighter has nothing left to compute for them. For JSON alone the honest number is therefore the one with an upload: slower than JSON.parse below about 7,000 documents, about even at 10,000 (8.1 ms against 9.2 ms), and 1.3 times faster at 100,000. The condition where the GPU is clearly faster, documents that stay while something shared changes, is what a search adds: a new pattern is about a thousand shared cells, and every document's cells stay where they are.

**What the numbers depend on.**

- The documents: JSON.parse and the JavaScript highlighters take longer for longer documents and stop early at an error, while the GPU runs all 7,186 operations for every document. These documents have a median of 300 code points, so shorter documents move every crossover up, and documents near 512 move it down. With fewer broken documents JSON.parse gets faster, down to 0.64 µs per document with none.
- The machine: one Apple M5 Max, one browser, headless. The shader compile time, the pause behavior and the exactness without guards may all differ on another GPU.
- The baselines are single-threaded JavaScript in the page. With 16 workers JSON.parse takes 6.2 ms for the 100,000 documents instead of 76 to 103 ms, see [JavaScript in several workers](#javascript-in-several-workers).

## Measured results: regex search as a loop

These are the measurements of loop-emit.ts's shaders, which the searcher used until October 14, 2026. The patterns, RegExp's times, the CPU's times and the hand-written kernel's times hold as they are, and [Measured results: the searcher with bit-emit.ts's shaders](#measured-results-the-searcher-with-bit-emittss-shaders) has the search's times with the shaders that the searcher uses now.

Measured on October 13, 2026, on the same machine and browser as the first stage: an Apple M5 Max with 18 cores and 36 GiB, macOS 27.0, Bun 1.4.3, and headless Chrome 155.0.8059.40 through Metal, with timestamp queries, cross-origin isolated. Other agents' work ran on the machine throughout, and so did mine: `bun test lab/json-search`, about 30 s of one core, ran a few times during the runs. The 1-minute load average, sampled every 10 s, was 3.06 to 7.49 during run 1, 3.09 to 6.96 during run 2, and 3.49 to 7.29 during run 3.

Method:

- A run is one fresh Chrome process with a fresh profile folder and a shader salt that no earlier run used: results/search-main-1.json to search-main-3.json, 12 to 13.4 minutes each. A cell shows the median of the 3 runs' medians, and their range in parentheses.
- **One search** is what a page does when the pattern changes: JavaScript compiles the pattern and writes its cells, the cells are uploaded, one pass runs every document, and the match count of every document comes back, with the marks of 64 documents in the middle of the batch. Its time runs from before `compilePattern` until the values are copied into JavaScript arrays. Consecutive searches use different patterns, the ones that fit the capacity in turn: 7 at 8 states, 9 at 16 and all 10 at 32.
- **Back to back** and **after a pause** mean what they mean in the first stage. A back to back series is at least 15 samples and 1 s after a warmup, and a search that takes longer than about 0.3 s is sampled 5 times.
- **The capacities** are 8, 16 and 32 states at 256 and 512 positions, each with 16 classes and 32 class boundaries. At 256 positions a search reads each document's first 256 code points, 228.5 on average, and at 512 positions 299.8 on average.
- **The baselines** run in the same page on the same code points: RegExp with the `u` flag, as `text.match(patternWithTheGFlag)?.length` for every match and as `test` for whether a document has one; the plain JavaScript loop over 32-bit rows; and the program on the CPU for the first documents, as generated JavaScript (200 documents) and on the executor (8), and form (a) with every position written out on the executor (40), up to 16 states, since building it holds about 0.5 KB of heap per operation.
- Run 1 also measured the shader that stops at the text's end. Its shaders are one statement shorter than the repo's: the parameter for the first document was added between runs 1 and 2.

### The step and its shader

| States | Operations per position: reverse step, forward step | Operations per document at 256 positions | At 512 positions | Cells a pattern writes | WGSL statements | WGSL bytes | Compile shader ms, cold, 256 positions | 512 positions | Hand-written kernel, compile ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 148, 92 | 61,448 | 122,888 | 1,097 | 496 | 32,127 | 111 (100 to 121) | 114 (106 to 116) | 31 (12 to 41) |
| 16 | 356, 308 | 170,000 | 339,984 | 4,177 | 1,368 | 103,771 | 260 (259 to 301) | 264 (261 to 266) | 31 (12 to 42) |
| 32 | 1,156, 1,124 | 583,712 | 1,167,392 | 16,481 | 4,648 | 399,113 | 1,018 (1,012 to 1,078) | 1,081 (1,001 to 1,228) | 37 (14 to 66) |

The shader of one empty function that each process compiles first: 34.4 (32.3 to 61.8) ms.

### The patterns, and RegExp in the same page

The first 256 code points of each document, a mean of 228.5 code points. ms for 100,000 documents, and µs per document at 100,000 and at 1,000:

| Pattern | States | Matches | Documents with a match | RegExp, every match: ms | µs per document | µs per document at 1,000 documents | RegExp test: ms | µs per document |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `(the\|an?) [a-z]+` | 8 | 15,572 | 12,268 | 17.3 (16.7 to 17.5) | 0.173 (0.167 to 0.175) | 0.094 (0.092 to 0.096) | 15.3 (15.0 to 15.6) | 0.153 (0.150 to 0.156) |
| `error` | 6 | 10,323 | 8,804 | 16.1 (16.0 to 16.5) | 0.161 (0.160 to 0.165) | 0.099 (0.099 to 0.103) | 14.8 (14.8 to 15.3) | 0.148 (0.148 to 0.153) |
| `[a-z0-9.]+@[a-z.]+` | 4 | 14,478 | 14,457 | 33.1 (31.2 to 34.5) | 0.331 (0.312 to 0.345) | 0.251 (0.247 to 0.277) | 26.9 (26.1 to 27.6) | 0.269 (0.261 to 0.276) |
| `"[a-z]+":` | 5 | 819,107 | 85,885 | 25.1 (24.7 to 26.1) | 0.251 (0.247 to 0.261) | 0.202 (0.198 to 0.209) | 4.80 (4.50 to 5.00) | 0.048 (0.045 to 0.050) |
| `[A-Z][a-z]+ [A-Z][a-z]+` | 6 | 19,331 | 16,817 | 10.6 (10.1 to 11.1) | 0.106 (0.101 to 0.111) | 0.059 (0.059 to 0.062) | 8.70 (8.30 to 9.10) | 0.087 (0.083 to 0.091) |
| `\d+\.\d+` | 4 | 193,511 | 76,451 | 13.9 (13.7 to 14.4) | 0.139 (0.137 to 0.144) | 0.086 (0.086 to 0.087) | 7.00 (6.60 to 7.40) | 0.070 (0.066 to 0.074) |
| `\d\d\d\d-\d\d-\d\d` | 11 | 21,649 | 21,635 | 7.30 (6.80 to 7.30) | 0.073 (0.068 to 0.073) | 0.040 (0.037 to 0.041) | 5.90 (5.80 to 5.90) | 0.059 (0.058 to 0.059) |
| `(the\|an?\|some) [a-z]+(ing)?s?` | 16 | 16,885 | 12,973 | 20.5 (20.5 to 21.1) | 0.205 (0.205 to 0.211) | 0.123 (0.117 to 0.125) | 18.9 (17.8 to 20.5) | 0.189 (0.178 to 0.205) |
| `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? ` | 32 | 14,265 | 11,276 | 20.2 (19.9 to 22.2) | 0.202 (0.199 to 0.222) | 0.122 (0.116 to 0.149) | 18.5 (18.5 to 20.8) | 0.185 (0.185 to 0.208) |
| `([a-z]+)+x` | 3 | 57,091 | 42,950 | 1,699 (1,652 to 1,776) | 16.987 (16.524 to 17.764) | 16.964 (16.151 to 17.496) | 1,302 (1,270 to 1,308) | 13.019 (12.704 to 13.076) |

The first 512 code points of each document, a mean of 299.8 code points. ms for 100,000 documents, and µs per document at 100,000 and at 1,000:

| Pattern | States | Matches | Documents with a match | RegExp, every match: ms | µs per document | µs per document at 1,000 documents | RegExp test: ms | µs per document |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `(the\|an?) [a-z]+` | 8 | 42,356 | 27,064 | 23.2 (22.8 to 24.4) | 0.232 (0.228 to 0.244) | 0.147 (0.128 to 0.159) | 19.3 (19.2 to 20.6) | 0.193 (0.192 to 0.206) |
| `error` | 6 | 12,482 | 10,541 | 21.0 (19.4 to 21.4) | 0.210 (0.194 to 0.214) | 0.130 (0.119 to 0.135) | 18.8 (17.1 to 18.8) | 0.188 (0.171 to 0.188) |
| `[a-z0-9.]+@[a-z.]+` | 4 | 14,555 | 14,457 | 42.8 (39.7 to 60.5) | 0.428 (0.397 to 0.605) | 0.341 (0.327 to 0.372) | 34.8 (34.0 to 41.6) | 0.348 (0.340 to 0.416) |
| `"[a-z]+":` | 5 | 1,037,641 | 85,885 | 30.3 (30.0 to 30.4) | 0.303 (0.300 to 0.304) | 0.243 (0.242 to 0.247) | 4.70 (4.50 to 4.80) | 0.047 (0.045 to 0.048) |
| `[A-Z][a-z]+ [A-Z][a-z]+` | 6 | 23,862 | 20,033 | 11.8 (11.5 to 12.0) | 0.118 (0.115 to 0.120) | 0.071 (0.069 to 0.073) | 9.30 (9.00 to 9.50) | 0.093 (0.090 to 0.095) |
| `\d+\.\d+` | 4 | 254,601 | 81,439 | 16.5 (16.5 to 16.9) | 0.165 (0.165 to 0.169) | 0.106 (0.105 to 0.107) | 6.50 (6.40 to 6.70) | 0.065 (0.064 to 0.067) |
| `\d\d\d\d-\d\d-\d\d` | 11 | 27,809 | 27,713 | 8.30 (7.90 to 8.50) | 0.083 (0.079 to 0.085) | 0.049 (0.049 to 0.052) | 6.50 (6.50 to 6.70) | 0.065 (0.065 to 0.067) |
| `(the\|an?\|some) [a-z]+(ing)?s?` | 16 | 46,068 | 28,339 | 29.1 (28.1 to 30.0) | 0.291 (0.281 to 0.300) | 0.200 (0.188 to 0.205) | 23.8 (23.6 to 24.4) | 0.238 (0.236 to 0.244) |
| `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? ` | 32 | 40,611 | 24,738 | 28.9 (28.5 to 29.0) | 0.289 (0.285 to 0.290) | 0.199 (0.193 to 0.213) | 24.7 (24.6 to 25.1) | 0.247 (0.246 to 0.251) |
| `([a-z]+)+x` | 3 | 69,548 | 47,512 | 2,143 (2,138 to 2,451) | 21.426 (21.381 to 24.510) | 20.515 (20.369 to 22.723) | 1,482 (1,468 to 1,491) | 14.817 (14.675 to 14.913) |

Patterns and sizes where RegExp's count differs from the automaton's for some document: 0.

### The CPU, µs per document

| States | Positions | Plain JavaScript loop over 32-bit rows | The loop program as generated JavaScript, sampled | The loop program on the CPU executor, sampled | Form (a) with every position written out, on the CPU executor, sampled |
| --- | --- | --- | --- | --- | --- |
| 8 | 256 | 3.01 (2.92 to 3.09) | 117 | 1,392 (1,371 to 1,495) | 726 (701 to 834) |
| 8 | 512 | 4.30 (4.21 to 4.32) | 241 (240 to 249) | 3,354 (3,353 to 3,494) | 1,922 (1,920 to 2,097) |
| 16 | 256 | 4.97 (4.96 to 4.99) | 301 (295 to 305) | 5,602 (5,189 to 5,639) | 2,915 (2,691 to 3,076) |
| 16 | 512 | 6.40 (6.37 to 6.55) | 586 (585 to 594) | 10,503 (10,380 to 10,573) | 5,329 (5,216 to 5,495) |
| 32 | 256 | 7.47 (7.40 to 7.60) | 1,776 (1,715 to 1,861) | 19,654 (18,975 to 20,079) |  |
| 32 | 512 | 9.92 (9.76 to 10.69) | 3,577 (3,389 to 3,948) | 39,920 (37,694 to 45,098) |  |

### One search, ms: the program's step in a loop

| States | Positions | Documents | Back to back | Compute pass, timestamps | After a pause of 16 ms | After a pause of 200 ms | After a pause of 1,000 ms | First search |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 256 | 100 | 1.17 (0.61 to 1.43) | 1.63 (0.38 to 1.66) | 2.44 (2.11 to 2.45) | 2.55 (2.51 to 2.96) | 2.60 (2.56 to 3.23) | 8.21 (7.80 to 43.05) |
| 8 | 256 | 1,000 | 0.98 (0.58 to 1.13) | 0.63 (0.35 to 0.73) | 2.31 (2.25 to 2.44) | 2.62 (2.48 to 2.90) | 2.81 (2.50 to 2.91) | 11.5 (6.9 to 13.8) |
| 8 | 256 | 10,000 | 0.77 (0.69 to 0.78) | 0.48 | 1.65 (1.55 to 2.42) | 3.45 (3.10 to 3.51) | 3.31 (3.07 to 3.86) | 8.52 (6.07 to 9.26) |
| 8 | 256 | 100,000 | 3.70 (3.62 to 3.99) | 3.29 (3.25 to 4.52) | 4.42 (4.16 to 5.30) | 12.4 (12.2 to 12.9) | 12.3 (12.3 to 13.0) | 19.1 (17.5 to 25.4) |
| 8 | 512 | 100 | 1.00 (0.98 to 1.02) | 1.09 (1.00 to 1.20) | 2.82 (2.66 to 4.18) | 4.27 (4.22 to 4.87) | 4.39 (4.30 to 4.52) | 14.1 (13.2 to 14.4) |
| 8 | 512 | 1,000 | 1.10 (0.93 to 1.67) | 1.43 (1.16 to 1.80) | 4.03 (2.93 to 4.14) | 4.25 (4.19 to 4.27) | 4.28 (4.17 to 4.33) | 8.91 (8.77 to 9.52) |
| 8 | 512 | 10,000 | 1.61 (1.27 to 1.69) | 1.34 (1.01 to 1.61) | 3.62 (1.85 to 3.79) | 5.35 (5.32 to 5.38) | 5.45 (5.33 to 5.48) | 10.2 (9.3 to 10.7) |
| 8 | 512 | 100,000 | 7.04 (7.02 to 7.33) | 6.61 (6.55 to 7.87) | 7.66 (7.56 to 8.42) | 16.7 (9.6 to 17.0) | 17.0 (16.9 to 17.1) | 22.4 (21.4 to 58.0) |
| 16 | 256 | 100 | 3.83 (3.81 to 4.03) | 3.51 | 4.35 (3.96 to 4.40) | 12.7 (12.6 to 12.7) | 12.8 (12.6 to 12.8) | 19.9 (19.0 to 21.5) |
| 16 | 256 | 1,000 | 3.79 (3.77 to 3.82) | 3.46 (3.45 to 3.47) | 4.34 (4.24 to 4.35) | 12.7 (12.6 to 12.8) | 12.6 (12.5 to 12.7) | 13.1 (9.0 to 13.3) |
| 16 | 256 | 10,000 | 4.56 (4.51 to 4.60) | 4.17 (4.16 to 4.17) | 5.00 (4.98 to 5.09) | 14.0 (10.2 to 14.3) | 13.8 (13.7 to 13.9) | 13.7 (9.6 to 15.2) |
| 16 | 256 | 100,000 | 32.5 (32.4 to 33.0) | 32.1 (32.0 to 32.4) | 33.3 (33.0 to 33.4) | 33.7 (33.5 to 33.9) | 43.0 (42.7 to 43.1) | 41.1 (40.9 to 41.7) |
| 16 | 512 | 100 | 7.43 (7.40 to 7.45) | 7.09 (7.08 to 7.14) | 8.02 (7.92 to 8.07) | 17.0 (15.2 to 18.4) | 18.2 (17.5 to 18.2) | 27.7 (26.1 to 28.1) |
| 16 | 512 | 1,000 | 7.29 (7.26 to 7.29) | 6.94 (6.91 to 6.94) | 8.02 (7.93 to 8.16) | 17.3 (12.2 to 18.3) | 18.2 (17.3 to 18.5) | 15.7 (13.4 to 17.8) |
| 16 | 512 | 10,000 | 8.69 (8.63 to 8.70) | 8.27 (8.25 to 8.28) | 9.07 (8.92 to 9.12) | 16.2 (15.3 to 17.8) | 18.9 (18.5 to 19.2) | 18.4 (14.5 to 18.6) |
| 16 | 512 | 100,000 | 63.8 (63.6 to 64.6) | 63.8 (62.6 to 64.3) | 64.2 (63.9 to 65.2) | 65.1 (64.4 to 65.3) | 74.2 (73.6 to 75.6) | 71.6 (68.5 to 74.4) |
| 32 | 256 | 100 | 38.4 (38.3 to 38.5) | 37.9 (37.9 to 38.0) | 38.8 (38.5 to 39.1) | 39.1 (39.0 to 40.1) | 48.5 (48.4 to 48.7) | 55.0 (54.1 to 59.7) |
| 32 | 256 | 1,000 | 42.2 (42.2 to 42.8) | 41.9 (41.8 to 42.4) | 42.7 (42.6 to 43.2) | 43.0 (42.5 to 43.2) | 53.1 (52.3 to 53.5) | 48.0 (47.7 to 48.7) |
| 32 | 256 | 10,000 | 66.2 (66.0 to 66.6) | 65.5 (65.3 to 65.6) | 66.5 (65.9 to 66.5) | 67.7 (66.1 to 67.9) | 76.2 (75.7 to 77.3) | 73.9 (71.3 to 76.2) |
| 32 | 256 | 100,000 | 441 (435 to 442) | 444 (440 to 445) | 437 (436 to 445) | 439 (436 to 442) | 451 (447 to 453) | 447 (446 to 455) |
| 32 | 512 | 100 | 76.9 (76.6 to 77.0) | 77.2 (75.7 to 77.6) | 77.3 (77.2 to 77.7) | 77.5 (77.1 to 78.1) | 87.3 (86.6 to 88.4) | 133 (95 to 175) |
| 32 | 512 | 1,000 | 85.3 (85.3 to 86.3) | 84.7 (84.6 to 85.7) | 85.0 (84.8 to 85.9) | 85.8 (85.3 to 87.2) | 95.0 (94.9 to 95.1) | 90.8 (89.1 to 91.1) |
| 32 | 512 | 10,000 | 131 (130 to 131) | 130 (128 to 130) | 131 (131 to 132) | 132 (131 to 133) | 141 (139 to 142) | 134 (133 to 136) |
| 32 | 512 | 100,000 | 871 (866 to 872) | 877 (867 to 890) | 878 (869 to 881) | 869 (864 to 870) | 882 | 870 (869 to 879) |

### One search, ms: the hand-written kernel, for comparison

| States | Positions | Documents | Back to back | Compute pass, timestamps | After a pause of 16 ms | After a pause of 200 ms | After a pause of 1,000 ms | First search |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 256 | 100 | 0.42 (0.38 to 0.50) | 0.20 (0.19 to 0.75) | 1.08 (0.97 to 1.53) | 1.63 (1.58 to 2.61) | 1.60 (1.57 to 1.64) | 0.88 (0.73 to 1.41) |
| 8 | 256 | 1,000 | 0.98 (0.75 to 1.00) | 0.39 (0.32 to 0.73) | 1.15 (1.15 to 1.21) | 1.57 (1.54 to 1.58) | 1.62 (1.55 to 1.64) | 6.40 (5.48 to 6.76) |
| 8 | 256 | 10,000 | 0.67 (0.63 to 0.80) | 0.56 (0.47 to 1.01) | 1.81 (1.72 to 1.86) | 1.92 (1.89 to 1.94) | 1.98 (1.83 to 1.98) | 6.56 (6.51 to 7.36) |
| 8 | 256 | 100,000 | 1.73 (1.70 to 1.74) | 1.40 (1.39 to 1.86) | 2.26 (2.23 to 2.86) | 6.82 (6.81 to 6.96) | 6.80 (6.55 to 6.81) | 9.83 (8.65 to 20.21) |
| 8 | 512 | 100 | 0.59 (0.55 to 0.60) | 0.42 (0.37 to 0.45) | 1.89 (1.38 to 2.32) | 2.41 (2.14 to 3.41) | 2.56 (2.11 to 3.41) | 0.93 (0.88 to 0.95) |
| 8 | 512 | 1,000 | 0.58 (0.56 to 0.62) | 0.35 (0.35 to 0.38) | 1.58 (1.14 to 2.35) | 2.55 (2.42 to 3.08) | 2.57 (2.41 to 2.62) | 7.60 (4.67 to 13.77) |
| 8 | 512 | 10,000 | 0.76 (0.74 to 0.79) | 0.51 (0.49 to 0.51) | 1.69 (1.58 to 1.83) | 2.95 (2.95 to 3.07) | 3.09 (3.01 to 3.31) | 8.00 (5.12 to 8.61) |
| 8 | 512 | 100,000 | 3.38 (3.31 to 3.39) | 3.00 (2.99 to 3.06) | 3.92 (3.80 to 4.05) | 11.0 (10.9 to 12.4) | 11.1 (10.9 to 11.1) | 16.7 (15.2 to 24.3) |
| 16 | 256 | 100 | 0.42 (0.40 to 0.45) | 0.23 (0.22 to 0.24) | 0.96 (0.95 to 1.04) | 1.71 (1.39 to 1.83) | 1.78 (1.47 to 1.84) | 0.68 (0.63 to 0.76) |
| 16 | 256 | 1,000 | 0.70 (0.37 to 0.72) | 0.62 (0.19 to 0.82) | 1.52 (0.97 to 1.57) | 1.70 (1.62 to 1.83) | 1.77 (1.36 to 1.83) | 6.63 (5.68 to 6.70) |
| 16 | 256 | 10,000 | 0.74 (0.48 to 0.80) | 0.57 (0.46 to 0.57) | 1.75 (1.21 to 2.06) | 2.19 (2.06 to 2.22) | 2.20 (2.17 to 2.32) | 6.89 (4.18 to 7.40) |
| 16 | 256 | 100,000 | 1.83 (1.78 to 1.96) | 1.53 (1.52 to 1.53) | 2.37 (2.33 to 2.47) | 7.91 (7.91 to 7.94) | 7.99 (7.90 to 8.06) | 13.3 (13.2 to 13.4) |
| 16 | 512 | 100 | 0.64 (0.62 to 0.65) | 0.45 (0.44 to 0.45) | 1.21 (1.17 to 1.30) | 2.83 (2.78 to 2.98) | 2.83 (2.78 to 3.57) | 0.93 (0.91 to 0.97) |
| 16 | 512 | 1,000 | 0.65 (0.61 to 0.84) | 0.47 (0.42 to 0.61) | 1.53 (1.16 to 2.45) | 3.01 (2.83 to 3.05) | 3.67 (2.75 to 3.70) | 7.77 (7.47 to 8.16) |
| 16 | 512 | 10,000 | 0.82 (0.82 to 0.93) | 0.63 (0.62 to 0.66) | 1.47 (1.42 to 1.82) | 4.18 (3.51 to 4.38) | 3.70 (3.58 to 3.83) | 13.7 (8.7 to 16.9) |
| 16 | 512 | 100,000 | 3.69 (3.57 to 3.75) | 3.29 (3.28 to 3.34) | 4.17 (4.06 to 4.22) | 11.7 (11.6 to 12.0) | 11.8 (11.7 to 12.3) | 16.7 (13.3 to 17.4) |
| 32 | 256 | 100 | 0.57 (0.55 to 0.58) | 0.35 (0.33 to 0.36) | 1.17 (1.11 to 1.26) | 2.21 (2.20 to 2.25) | 2.28 (2.24 to 2.31) | 0.92 (0.89 to 0.99) |
| 32 | 256 | 1,000 | 0.79 (0.66 to 0.81) | 0.55 (0.49 to 0.55) | 1.91 (1.37 to 1.93) | 2.16 (2.12 to 2.17) | 2.23 (2.11 to 2.25) | 7.88 (7.19 to 8.13) |
| 32 | 256 | 10,000 | 0.61 (0.56 to 0.86) | 0.37 (0.37 to 0.54) | 1.22 (1.13 to 1.56) | 2.62 (2.51 to 2.68) | 2.64 (2.58 to 2.73) | 7.98 (7.45 to 8.26) |
| 32 | 256 | 100,000 | 2.54 (2.53 to 2.54) | 2.21 | 3.07 (3.01 to 3.08) | 10.0 (10.0 to 10.1) | 10.1 (10.1 to 10.2) | 15.7 (11.1 to 15.8) |
| 32 | 512 | 100 | 0.88 (0.87 to 0.98) | 0.62 (0.62 to 0.63) | 1.46 (1.40 to 1.52) | 3.64 (3.62 to 3.80) | 3.68 (3.66 to 4.03) | 1.22 (1.11 to 1.85) |
| 32 | 512 | 1,000 | 0.82 (0.79 to 0.83) | 0.58 | 1.55 (1.45 to 1.67) | 3.62 (3.60 to 3.62) | 3.59 (3.59 to 4.17) | 9.39 (8.87 to 12.61) |
| 32 | 512 | 10,000 | 1.01 (0.98 to 1.07) | 0.77 (0.77 to 0.78) | 1.71 (1.63 to 1.74) | 4.35 (4.29 to 4.37) | 4.37 (4.36 to 4.38) | 10.1 (6.5 to 10.5) |
| 32 | 512 | 100,000 | 4.85 (4.80 to 5.00) | 4.49 (4.48 to 4.93) | 5.47 (5.29 to 5.69) | 14.2 (13.7 to 14.2) | 14.4 (14.1 to 14.5) | 19.9 (15.1 to 19.9) |

### One search, ms: the step with both loops stopping at the text's end, run 1 only

| States | Positions | Documents | Back to back | Compute pass, timestamps | After a pause of 16 ms | After a pause of 200 ms | After a pause of 1,000 ms | First search |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 256 | 100 | 0.61 | 0.38 |  |  |  | 2.10 |
| 8 | 256 | 1,000 | 0.62 | 0.35 |  |  |  | 1.23 |
| 8 | 256 | 10,000 | 0.81 | 0.52 |  |  |  | 1.56 |
| 8 | 256 | 100,000 | 4.20 | 3.77 |  |  |  | 4.99 |
| 8 | 512 | 100 | 1.71 | 1.47 |  |  |  | 2.08 |
| 8 | 512 | 1,000 | 1.75 | 1.50 |  |  |  | 2.98 |
| 8 | 512 | 10,000 | 1.50 | 1.27 |  |  |  | 3.70 |
| 8 | 512 | 100,000 | 9.44 | 9.12 |  |  |  | 12.7 |
| 16 | 256 | 100 | 3.91 | 3.56 |  |  |  | 6.12 |
| 16 | 256 | 1,000 | 3.87 | 3.51 |  |  |  | 8.54 |
| 16 | 256 | 10,000 | 4.73 | 4.36 |  |  |  | 8.96 |
| 16 | 256 | 100,000 | 38.9 | 38.6 |  |  |  | 43.8 |
| 16 | 512 | 100 | 7.92 | 7.57 |  |  |  | 10.00 |
| 16 | 512 | 1,000 | 7.89 | 7.59 |  |  |  | 13.5 |
| 16 | 512 | 10,000 | 9.20 | 8.86 |  |  |  | 14.1 |
| 16 | 512 | 100,000 | 78.7 | 77.3 |  |  |  | 86.5 |
| 32 | 256 | 100 | 30.3 | 30.2 |  |  |  | 40.4 |
| 32 | 256 | 1,000 | 33.4 | 32.7 |  |  |  | 39.0 |
| 32 | 256 | 10,000 | 58.1 | 56.3 |  |  |  | 67.2 |
| 32 | 256 | 100,000 | 523 | 510 |  |  |  | 519 |
| 32 | 512 | 100 | 61.3 | 60.9 |  |  |  | 83.3 |
| 32 | 512 | 1,000 | 64.6 | 64.4 |  |  |  | 71.8 |
| 32 | 512 | 10,000 | 119 | 119 |  |  |  | 123 |
| 32 | 512 | 100,000 | 1,251 | 1,242 |  |  |  | 1,254 |

### The parts of one back to back search of the step, ms

| States | Positions | Documents | JavaScript: compile the pattern, write its cells | writeBuffer calls | Submit to mapped | Copy out | Total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 256 | 100,000 | 0.030 (0.015 to 0.035) | 0.005 (0.000 to 0.005) | 3.615 (3.585 to 3.930) | 0.015 (0.010 to 0.020) | 3.695 (3.615 to 3.993) |
| 8 | 512 | 100,000 | 0.030 (0.025 to 0.030) | 0.005 | 6.960 (6.960 to 7.242) | 0.020 (0.015 to 0.020) | 7.040 (7.020 to 7.325) |
| 16 | 256 | 100,000 | 0.045 (0.035 to 0.050) | 0.010 (0.005 to 0.010) | 32.400 (32.310 to 32.918) | 0.020 (0.015 to 0.020) | 32.495 (32.355 to 33.007) |
| 16 | 512 | 100,000 | 0.053 (0.050 to 0.063) | 0.010 (0.005 to 0.010) | 63.675 (63.520 to 64.442) | 0.025 (0.020 to 0.025) | 63.845 (63.617 to 64.563) |
| 32 | 256 | 100,000 | 0.105 (0.102 to 0.110) | 0.025 | 440.505 (435.215 to 442.008) | 0.025 (0.020 to 0.025) | 440.685 (435.393 to 442.200) |
| 32 | 512 | 100,000 | 0.100 (0.100 to 0.105) | 0.025 | 870.730 (865.405 to 872.125) | 0.025 (0.020 to 0.030) | 870.900 (865.575 to 872.310) |

### The step at 8 states and 512 positions against RegExp counting every match

| What runs | ms at 100 documents | ms at 1,000 documents | ms at 10,000 documents | ms at 100,000 documents | Documents from which the GPU takes less time, back to back | After a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- |
| the step on the GPU, back to back | 1.00 | 1.10 | 1.61 | 7.04 | |  |
| the step on the GPU, after a pause of 200 ms | 4.27 | 4.25 | 5.35 | 16.7 | |  |
| RegExp, `(the\|an?) [a-z]+` | 0.01 | 0.15 | 2.23 | 23.2 | 4,000 | 21,000 |
| RegExp, `error` | 0.01 | 0.13 | 2.01 | 21.0 | 5,100 | 27,000 |
| RegExp, `[a-z0-9.]+@[a-z.]+` | 0.03 | 0.34 | 4.16 | 42.8 | 1,700 | 11,000 |
| RegExp, `"[a-z]+":` | 0.02 | 0.24 | 2.89 | 30.3 | 2,500 | 14,000 |
| RegExp, `[A-Z][a-z]+ [A-Z][a-z]+` | 0.01 | 0.07 | 1.08 | 11.8 | 13,000 | never, up to 100,000 |
| RegExp, `\d+\.\d+` | 0.01 | 0.11 | 1.52 | 16.5 | 10,000 | never, up to 100,000 |
| RegExp, `([a-z]+)+x` | 1.83 | 20.5 | 218 | 2,143 | below 100 | 130 |

### What the tables say

- **The compile is no longer the limit.** The step's shader compiles cold in 0.11 s at 8 states, 0.26 s at 16 and 1.0 to 1.1 s at 32, for 496, 1,368 and 4,648 statements, whatever the number of positions. The scratch probe's shader with every position written out, 91,774 statements at 8 states and 256 positions, took 107 to 130 s.
- **At 8 states a search of 100,000 documents takes 7.04 ms at 512 positions and 3.70 ms at 256**, back to back, and 16.7 to 17.0 ms and 12.3 to 12.4 ms after a pause of 200 ms or more. JavaScript's part, compiling the pattern and writing 1,097 cells, is 0.03 ms of that.
- **The capacity costs more than its operations.** At 512 positions and 100,000 documents, 16 states take 63.8 ms and 32 states 871 ms: 9 and 124 times the 8-state time, for 2.8 and 9.5 times the operations.
- **A pass has a floor that the document count doesn't lower**: one document's operations run one after the other in one GPU thread. At 512 positions, 100 documents take 1.00 ms at 8 states, 7.43 ms at 16 and 76.9 ms at 32, and 10,000 documents take 1.61 ms, 8.69 ms and 131 ms. So up to about 10,000 documents the time is nearly flat, and from there it grows with the count.
- **The hand-written kernel takes 3.38, 3.69 and 4.85 ms** for 100,000 documents at 8, 16 and 32 states and 512 positions, and 11.1 to 14.4 ms after a pause of 1 s. It is 2 times faster than the program's step at 8 states, 17 times at 16 and 180 times at 32, since a row of up to 32 states is one word there.
- **RegExp takes 0.08 to 0.43 µs per document on the nine ordinary patterns**, i.e. 8.3 to 42.8 ms for 100,000 documents of 512 code points, and 4.7 to 34.8 ms for `test`. On `([a-z]+)+x` it takes 21.4 µs per document, 2,143 ms for 100,000: a run of lowercase letters that no `x` follows is split in every possible way before the match fails. The program's time is the same for every pattern of a capacity.
- **Against RegExp counting every match, the step at 8 states and 512 positions takes less time from 1,700 to 13,000 documents on, depending on the pattern**, when searches follow each other. After a pause of 200 ms it takes less time from 11,000 to 27,000 documents on for four of the six ordinary patterns, and for two it never does up to 100,000. On `([a-z]+)+x` it takes less time from below 100 documents, and from 130 after a pause.
- **The same program on the CPU takes 241 µs per document as generated JavaScript, and on the executor 1.9 ms with every position written out and 3.4 ms as a loop**, at 8 states and 512 positions, i.e. 24 s, 3.2 minutes and 5.6 minutes for 100,000 documents, where the GPU takes 7.04 ms. The plain JavaScript loop over 32-bit rows takes 4.3 µs per document there, 430 ms for 100,000.
- **Stopping the loops at the text's end was slower** in run 1 at 100,000 documents in every capacity, e.g. 9.44 ms against 7.02 ms at 8 states and 512 positions and 78.7 ms against 63.6 ms at 16, although the documents have 300 code points on average.

### The choices that were measured

Three choices of the loop shader, timed next to each other in one more Chrome process (results/search-choices-1.json), at 512 positions, searches following each other, ms as median with the smallest and the largest sample. The load average was 5.74 to 11.99 during this run, higher than during the three runs above, which shows in the first row: 11.1 ms where those runs measured 7.04 ms.

| States | Documents | The shader as built: statements in the order of use, bits as words, every position | Statements layer after layer | Bits as one f32 each | Loops stop at the text's end |
| --- | --- | --- | --- | --- | --- |
| 8 | 10,000 | 1.41 (1.29 to 1.59) | 1.58 (1.47 to 1.74) | 2.63 (2.49 to 2.86) | 2.16 (2.02 to 2.37) |
| 8 | 100,000 | 11.1 (7.7 to 14.2) | 11.6 (9.1 to 13.2) | 21.6 (21.1 to 22.3) | 12.8 (11.0 to 15.6) |
| 16 | 10,000 | 8.66 (7.95 to 9.18) | 11.5 (11.1 to 11.9) | 8.28 (8.10 to 9.14) | 9.25 (9.00 to 9.82) |
| 16 | 100,000 | 64.0 (60.5 to 68.5) | 99.3 (96.8 to 105.7) | 82.8 (75.5 to 89.8) | 79.7 (75.7 to 82.4) |
| 32 | 10,000 | 132 (130 to 135) | 157 (153 to 174) | 98.6 (95.1 to 101.5) | 116 (114 to 123) |
| 32 | 100,000 | 884 (864 to 887) | 2,041 (2,005 to 2,065) | 694 (687 to 726) | 1,328 (1,290 to 1,369) |

- **The order of a stage's statements.** The compiled program lists a layer of table reads before the layer of sums that read them, e.g. 1,024 reads and then 32 sums at 32 states. Writing each statement right after the ones it reads took 1.6 times less at 16 states and 2.3 times less at 32, for 100,000 documents, and about the same at 8. An earlier run of one process, results/search-explore-2.json, measured 1.4, 1.4 and 2.1 times. Every row computes the same value in either order.
- **The reverse pass's bits as one u32 word per position.** One f32 per bit took 2 times as long at 8 states and 1.3 times as long at 16, and 1.3 times less at 32. The words are the default, since 8 states is the capacity that is as fast as RegExp, and since 32 f32 bits for 512 positions are 64 KB of memory per document where the words are 2 KB.
- **Stopping at the text's end.** It was slower at 100,000 documents at every capacity, and faster only at 32 states and 10,000 documents. The loops run every position by default, which is also what the program with every position written out does.
- All three give the same outputs: 0 mismatched values in this run, and under `bun test` through the interpreter.

## Measured results: the searcher

These too are measurements of October 13, 2026, of the searcher with loop-emit.ts's shaders for the search programs, which compiled only the program of 8 states when it was created. The highlighter's pass, the plain JavaScript baselines and the CPU's times hold as they are, and the next section has the same page's tables for the searcher as it is now.

The same machine, browser and day. This page uses searcher.ts as a demo page would: per document count it creates a GPU searcher over the first documents, checks it, and times it.

Method:

- A run is one fresh Chrome process with a fresh profile folder and a new shader salt: results/combined-main-1.json to combined-main-5.json, about 7 minutes each. The 1-minute load average was 4.08 to 7.14, 3.14 to 5.52, 3.06 to 11.25, 3.56 to 10.21 and 3.10 to 4.86 during the five. A cell shows the median of the 5 runs' medians, and their range in parentheses.
- **Creating the searcher** is timed once per count and run, cold: a different salt per count.
- **The highlighter's pass** is `searcher.validate()`: one pass over every document, with `valid`, `firstErrorPosition`, `truncated` and `firstErrorKind` of every document read back, 16 bytes per document. The display kinds stay on the GPU.
- **One search** is `searcher.search({pattern, scope, window})` with a window of 64 documents in the middle of the batch: its time runs from the call until the promise resolves, with the copies of every document's match count and the window's marks. Consecutive searches use different patterns of the same capacity in turn: 6 patterns at 8 states, 2 at 16 and 2 at 32. The 32-state program is timed up to 10,000 documents.
- Every match count of every search, and the marks, are compared with the plain JavaScript loop over 32-bit rows, masked by the table loop's kinds. The comparison takes about 0.75 ms, so a "back to back" search here starts that long after the one before it.
- **Plain JavaScript** is plain-search.ts: the table loop, and per search RegExp on each run of searched characters. The first two runs used an earlier version of it that found the runs again in every search, 76 to 95 ms for 100,000 documents, which I replaced with one that keeps each scope's runs as strings. So the RegExp table comes from runs 3 to 5.
- **The same programs on the CPU** are `createCpuSearcher` over the first 200 documents as generated JavaScript, and over the first 16 on the executor. Its search loops ran all 512 positions in these runs.
- **The first stage's display shader**, every position written out, is compiled and timed at the end of each run, with the summary of every document and the kinds of 64 read back, as in that stage's display-window variant.

### Creating the searcher

| Documents | MB of cells | JavaScript writing the cells, ms | Upload, compile the highlighter's shader, validate, ms | Total with the first search shader, ms |
| --- | --- | --- | --- | --- |
| 100 | 0.21 | 0.41 (0.39 to 0.45) | 31.8 (28.7 to 56.2) | 79.6 (74.1 to 166.4) |
| 1,000 | 2.05 | 0.60 (0.51 to 0.63) | 20.2 (19.2 to 22.6) | 67.1 (65.1 to 75.4) |
| 10,000 | 20.5 | 4.69 (4.52 to 5.14) | 29.6 (27.6 to 33.3) | 78.7 (76.2 to 89.9) |
| 100,000 | 205 | 43.8 (42.8 to 46.9) | 85.5 (77.8 to 177.8) | 177 (169 to 280) |

| Program | Operations per stage | WGSL statements | Compile shader ms, by document count |
| --- | --- | --- | --- |
| JSON highlighter | 37, 17 | 107 | 100: 18 (15 to 41); 1,000: 14 (14 to 15); 10,000: 17 (16 to 20); 100,000: 42 (40 to 70) |
| regex search, 8 states | 8, 151, 92 | 503 | 100: 44 (42 to 106); 1,000: 45 (44 to 51); 10,000: 43 (42 to 50); 100,000: 46 (44 to 53) |
| regex search, 16 states | 16, 359, 308 | 1,375 | 100: 126 (122 to 272); 1,000: 126 (123 to 136); 10,000: 130 (127 to 136); 100,000: 127 (123 to 216) |
| regex search, 32 states | 32, 1,159, 1,124 | 4,655 | 100: 591 (487 to 1,026); 1,000: 571 (546 to 585); 10,000: 580 (522 to 621); 100,000:  |

The first stage's display shader, every position written out, in the same processes: 13,350 statements, compiled in 2,204 (2,176 to 4,628) ms.

### The highlighter's pass over every document, ms

| Documents | The loop: back to back | Compute pass, timestamps | After a pause of 16 ms | After a pause of 200 ms | After a pause of 1,000 ms | Every position written out, back to back | Table loop, plain JavaScript | JSON.parse |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 0.59 (0.44 to 0.68) | 0.48 (0.27 to 0.49) | 1.72 (0.96 to 1.94) | 1.90 (1.83 to 1.94) | 1.95 (1.92 to 1.97) | 0.71 (0.67 to 0.82) | 0.12 (0.11 to 0.13) | 0.05 |
| 1,000 | 0.65 (0.42 to 1.04) | 0.47 (0.24 to 0.76) | 1.45 (1.09 to 1.92) | 1.92 (1.88 to 2.66) | 1.96 (1.86 to 2.05) | 0.69 (0.68 to 0.80) | 1.48 (1.45 to 1.50) | 0.63 (0.63 to 0.64) |
| 10,000 | 0.65 (0.63 to 1.13) | 0.45 (0.44 to 1.24) | 2.32 (1.65 to 2.64) | 2.58 (2.54 to 2.66) | 2.63 (2.58 to 2.68) | 0.92 (0.91 to 0.94) | 15.0 (13.9 to 16.5) | 7.78 (7.24 to 8.46) |
| 100,000 | 2.19 (2.17 to 2.31) | 1.89 (1.85 to 2.06) | 2.74 (2.62 to 3.03) | 8.28 (8.23 to 8.72) | 8.28 (8.26 to 9.07) | 5.68 (5.58 to 6.10) | 146 (139 to 152) | 78.8 (75.2 to 84.2) |

### One search through the searcher, ms

| States | Scope | Documents | Back to back | Compute pass, timestamps | After a pause of 16 ms | After a pause of 200 ms | After a pause of 1,000 ms | Only the window's 64 documents |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | strings | 100 | 2.27 (1.70 to 2.86) | 2.77 (2.49 to 3.11) | 4.34 (3.37 to 4.52) | 4.52 (4.51 to 4.66) | 4.63 (4.46 to 4.71) | 1.20 (1.07 to 1.79) |
| 8 | strings | 1,000 | 2.28 (1.08 to 2.87) | 2.81 (0.89 to 3.02) | 4.39 (3.34 to 4.51) | 4.55 (4.55 to 4.60) | 4.61 (4.29 to 4.64) | 2.53 (1.81 to 2.68) |
| 8 | strings | 10,000 | 2.12 (1.89 to 2.54) | 3.20 (3.14 to 3.26) | 5.30 (4.29 to 5.73) | 5.81 (5.64 to 5.89) | 5.84 (5.73 to 5.96) | 2.50 (1.52 to 2.90) |
| 8 | strings | 100,000 | 7.63 (7.42 to 8.11) | 6.94 (6.92 to 9.82) | 8.30 (7.99 to 12.24) | 17.5 (10.1 to 17.6) | 17.6 (17.6 to 18.0) | 1.18 (1.12 to 1.27) |
| 8 | everything | 100 | 2.19 (1.04 to 2.84) | 2.54 (0.80 to 3.04) |  |  |  |  |
| 8 | everything | 1,000 | 2.04 (1.30 to 2.33) | 2.92 (2.49 to 3.15) |  |  |  |  |
| 8 | everything | 10,000 | 2.05 (1.57 to 2.31) | 3.03 (2.58 to 3.21) |  |  |  |  |
| 8 | everything | 100,000 | 7.75 (7.45 to 8.23) | 6.94 (6.92 to 6.97) |  |  |  |  |
| 8 | keys | 100 | 1.83 (1.04 to 2.28) | 1.90 (0.80 to 2.80) |  |  |  |  |
| 8 | keys | 1,000 | 2.28 (1.87 to 2.81) | 2.51 (1.75 to 3.01) |  |  |  |  |
| 8 | keys | 10,000 | 2.23 (2.11 to 2.42) | 3.10 (1.90 to 3.19) |  |  |  |  |
| 8 | keys | 100,000 | 7.76 (7.72 to 7.83) | 6.93 (6.92 to 6.97) |  |  |  |  |
| 16 | strings | 100 | 7.70 (7.69 to 7.82) | 7.40 (7.38 to 7.42) | 8.10 (7.87 to 8.16) | 17.7 (8.9 to 18.7) | 17.9 (17.7 to 18.6) | 7.78 (7.71 to 7.89) |
| 16 | strings | 1,000 | 7.63 (7.58 to 7.77) | 7.27 (7.24 to 7.27) | 8.24 (8.02 to 8.33) | 17.5 (9.7 to 17.6) | 17.8 (17.7 to 17.8) | 7.89 (7.84 to 7.90) |
| 16 | strings | 10,000 | 8.86 (8.76 to 8.91) | 8.42 (8.37 to 8.99) | 9.39 (9.07 to 9.77) | 19.0 (11.0 to 19.2) | 18.9 (18.7 to 19.0) | 7.85 (7.79 to 8.04) |
| 16 | strings | 100,000 | 65.3 (64.9 to 66.0) | 64.6 (64.2 to 65.2) | 65.5 (64.5 to 66.5) | 65.9 (65.1 to 66.6) | 76.2 (75.0 to 77.9) | 7.84 (7.73 to 8.06) |
| 16 | everything | 100 | 7.80 (7.69 to 8.01) | 7.44 (7.39 to 7.45) |  |  |  |  |
| 16 | everything | 1,000 | 7.73 (7.67 to 7.80) | 7.34 (7.26 to 7.35) |  |  |  |  |
| 16 | everything | 10,000 | 9.07 (9.00 to 9.27) | 8.57 (8.51 to 8.64) |  |  |  |  |
| 16 | everything | 100,000 | 66.1 (65.5 to 67.2) | 64.9 (64.1 to 65.3) |  |  |  |  |
| 16 | keys | 100 | 7.67 (7.65 to 8.10) | 7.39 (7.35 to 7.41) |  |  |  |  |
| 16 | keys | 1,000 | 7.71 (7.62 to 7.76) | 7.27 (7.24 to 7.29) |  |  |  |  |
| 16 | keys | 10,000 | 9.04 (8.86 to 9.11) | 8.49 (8.46 to 8.60) |  |  |  |  |
| 16 | keys | 100,000 | 65.7 (65.4 to 66.1) | 64.6 (64.5 to 65.2) |  |  |  |  |
| 32 | strings | 100 | 76.7 (76.3 to 77.0) | 76.2 (75.9 to 76.3) | 77.2 (76.9 to 78.2) | 76.9 (76.8 to 77.3) | 87.1 (86.4 to 87.8) | 58.5 (58.0 to 59.0) |
| 32 | strings | 1,000 | 85.6 (85.0 to 86.0) | 84.6 (84.2 to 84.8) | 85.7 (85.6 to 86.0) | 85.3 (84.2 to 86.2) | 95.8 (94.8 to 96.1) | 58.4 (57.4 to 59.2) |
| 32 | strings | 10,000 | 132 (131 to 132) | 130 (130 to 131) | 132 (131 to 132) | 132 (132 to 133) | 141 (140 to 142) | 58.3 (57.7 to 58.8) |
| 32 | everything | 100 | 76.8 (76.3 to 76.9) | 76.4 (75.7 to 77.1) |  |  |  |  |
| 32 | everything | 1,000 | 85.9 (84.4 to 86.3) | 84.4 (83.7 to 85.1) |  |  |  |  |
| 32 | everything | 10,000 | 132 (131 to 133) | 131 (130 to 131) |  |  |  |  |
| 32 | keys | 100 | 76.4 (75.4 to 76.6) | 75.9 (74.8 to 77.1) |  |  |  |  |
| 32 | keys | 1,000 | 85.4 (85.3 to 85.6) | 84.6 (84.1 to 84.9) |  |  |  |  |
| 32 | keys | 10,000 | 132 (131 to 132) | 130 (130 to 131) |  |  |  |  |

### The same searches in plain JavaScript

| Pattern | States | strings: matches | ms for 100,000 documents | µs per document | at 1,000 documents | everything: matches | ms for 100,000 documents | µs per document | at 1,000 documents | keys: matches | ms for 100,000 documents | µs per document | at 1,000 documents |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `(the\|an?) [a-z]+` | 8 | 41,347 | 22.6 (19.2 to 23.2) | 0.226 (0.192 to 0.232) | 0.148 (0.143 to 0.150) | 42,356 | 24.5 (23.2 to 27.9) | 0.245 (0.232 to 0.279) | 0.171 (0.163 to 0.171) | 0 | 21.0 (18.3 to 22.5) | 0.210 (0.183 to 0.225) | 0.188 (0.175 to 0.202) |
| `error` | 6 | 3,211 | 23.0 (19.9 to 24.3) | 0.230 (0.199 to 0.243) | 0.169 (0.160 to 0.191) | 12,482 | 23.2 (21.0 to 24.4) | 0.232 (0.210 to 0.244) | 0.137 (0.129 to 0.139) | 9,092 | 28.8 (24.1 to 29.7) | 0.288 (0.241 to 0.297) | 0.244 (0.234 to 0.275) |
| `[a-z0-9.]+@[a-z.]+` | 4 | 14,407 | 24.2 (21.3 to 24.9) | 0.242 (0.213 to 0.249) | 0.186 (0.178 to 0.199) | 14,555 | 44.1 (41.0 to 44.2) | 0.441 (0.410 to 0.442) | 0.385 (0.362 to 0.393) | 0 | 23.3 (21.0 to 24.1) | 0.233 (0.210 to 0.241) | 0.215 (0.209 to 0.222) |
| `[A-Z][a-z]+ [A-Z][a-z]+` | 6 | 23,518 | 18.4 (15.9 to 18.8) | 0.184 (0.159 to 0.188) | 0.149 (0.140 to 0.156) | 23,862 | 13.0 (12.0 to 13.0) | 0.130 (0.120 to 0.130) | 0.076 (0.074 to 0.081) | 0 | 21.4 (18.5 to 23.2) | 0.214 (0.185 to 0.232) | 0.190 (0.187 to 0.203) |
| `\d+\.\d+` | 4 | 47,972 | 16.8 (14.9 to 16.9) | 0.168 (0.149 to 0.169) | 0.137 (0.133 to 0.147) | 254,601 | 17.4 (16.2 to 17.6) | 0.174 (0.162 to 0.176) | 0.127 (0.127 to 0.128) | 24 | 19.3 (16.4 to 19.4) | 0.193 (0.164 to 0.194) | 0.179 (0.172 to 0.184) |
| `([a-z]+)+x` | 3 | 44,399 | 567 (546 to 617) | 5.671 (5.458 to 6.165) | 5.723 (5.587 to 5.873) | 69,548 | 2,128 (2,077 to 2,143) | 21.282 (20.765 to 21.434) | 20.786 (20.648 to 22.416) | 24,213 | 1,601 (1,587 to 1,612) | 16.011 (15.871 to 16.120) | 16.207 (15.860 to 16.584) |
| `\d\d\d\d-\d\d-\d\d` | 11 | 27,415 | 12.7 (12.7 to 13.1) | 0.127 (0.127 to 0.131) | 0.112 (0.108 to 0.122) | 27,809 | 8.70 (8.50 to 8.70) | 0.087 (0.085 to 0.087) | 0.055 (0.053 to 0.058) | 0 | 15.8 (14.9 to 16.4) | 0.158 (0.149 to 0.164) | 0.154 (0.146 to 0.159) |
| `(the\|an?\|some) [a-z]+(ing)?s?` | 16 | 44,981 | 21.2 (20.7 to 24.7) | 0.212 (0.207 to 0.247) | 0.149 (0.146 to 0.159) | 46,068 | 28.9 (28.0 to 37.0) | 0.289 (0.280 to 0.370) | 0.210 (0.189 to 0.220) | 0 | 20.1 (19.5 to 20.2) | 0.201 (0.195 to 0.202) | 0.194 (0.192 to 0.198) |
| `connection reset` | 17 | 1,420 | 14.4 (13.9 to 14.9) | 0.144 (0.139 to 0.149) | 0.141 (0.139 to 0.154) | 1,438 | 8.10 (8.00 to 8.40) | 0.081 (0.080 to 0.084) | 0.044 (0.040 to 0.047) | 0 | 17.9 (17.2 to 18.3) | 0.179 (0.172 to 0.183) | 0.184 (0.175 to 0.216) |
| `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? ` | 32 | 39,667 | 20.4 (20.3 to 20.7) | 0.204 (0.203 to 0.207) | 0.156 (0.141 to 0.159) | 40,611 | 29.0 (27.8 to 29.1) | 0.290 (0.278 to 0.291) | 0.216 (0.196 to 0.227) | 0 | 19.1 (19.1 to 20.9) | 0.191 (0.191 to 0.209) | 0.197 (0.193 to 0.199) |

strings: 785,185 runs in 100,000 documents, found once in 94.5 (83.9 to 117.4) ms.

everything: 100,000 runs in 100,000 documents, found once in 2.65 (2.60 to 2.80) ms.

keys: 1,230,015 runs in 100,000 documents, found once in 101 (83 to 104) ms.

Patterns, scopes and counts where RegExp's count differs from the program's for some document: 0.

### The same programs on the CPU, µs per document

| Backend | Documents sampled | Validate | Search, 8 states | 16 states | 32 states |
| --- | --- | --- | --- | --- | --- |
| generated JavaScript | 200 | 108 (93 to 179) | 245 (242 to 255) | 597 (595 to 638) | 3,614 (3,408 to 4,041) |
| CPU executor | 16 | 2,910 (2,814 to 3,031) | 3,424 (3,264 to 3,633) | 10,648 (10,424 to 11,281) | 38,656 (37,333 to 41,148) |

The Validate column is one run per process over the first documents, which includes building the program and the first, unoptimized calls. Warm and over all 100,000 documents, the highlighter's loop takes 90 µs per document as generated JavaScript, and 2.7 ms on the executor over 2,000 documents (results/review-many-1.json). These are the loop forms through this folder's CPU runner, which calls the executor once per position, and the executor checks every source cell's range on each call. The highlighter with every position written out takes 20.6 µs per document as generated JavaScript and 84 µs on the executor, see [The CPU baselines](#the-cpu-baselines), and form (a) with every position written out takes 1.9 ms per document on the executor at 8 states, see [The CPU, µs per document](#the-cpu-µs-per-document).

Since these runs, the CPU searcher's search loops stop at the text's end, see [Where the CPU's time goes](#where-the-cpus-time-goes).

### Where the CPU's time goes

Cheng asked, before the demo page got its CPU toggle, whether the 24.5 s above are a horribly inefficient number, and whether the CPU version could be simplified to take less, without tuning it for one use. Measured in headless Chrome 155 on the same machine on October 13, 2026, on a page's thread with a clock of 5 µs, over 400 of the demo page's documents, 302 code points on average, best of 8 runs. The page that measured it was a scratch file and isn't in the repo:

| | µs per document and search | Of that, the program's operations alone | The operations, ns each | The rest, ns per position |
| --- | --- | --- | --- | --- |
| 8 states, every position | 240 to 254 | 141 to 151 | 1.13 to 1.22 | 190 to 200 |
| 8 states, stopping at the text's end | 143 to 147 | 83 to 88 | 1.13 to 1.20 | 194 to 198 |
| 16 states, stopping at the text's end, 100 documents | 338 | 231 | 1.15 | 353 |
| 32 states, stopping at the text's end, 20 documents | 1,832 | 1,662 | 2.41 | 560 |
| The highlighter, every position | 93 | | | |

- **About 60% of the time is the program's own arithmetic, and 40% is this folder's runner.** "The operations alone" calls each stage's generated functions as often as the runner does and nothing else. The rest is loop-program.ts's `run`: at every position it copies the item, the registers and the fields into the operations' array and the outputs back, 55 copies at 8 states, each through an object that says where the value comes from, with a `switch` on each write's kind.
- **So the 24.5 s weren't horribly inefficient, and the operations cost about what generated JavaScript's arithmetic costs**: 1.15 ns each, a few float32 additions and products with their rounding. In Bun 1.4.3 the same operations take 0.81 to 0.92 ns each.
- **The one cheap and general saving was the positions that hold no text.** The loops ran all 512 positions of documents that have 300 code points on average. `stopAtLength` already existed for the shader, with tests, and the CPU searcher now turns it on: 143 to 147 µs per document instead of 240 to 254. In the demo page's worker a search of all 100,000 documents took 24.2, 24.0 and 23.9 s before and 14.0, 14.1 and 13.9 s after, in the development build, and 14.2 to 14.3 s in the built site. The highlighter's loop has no such option: its step isn't written to be skipped past the text's end.
- **Not done: a runner whose copies are generated statements too**, i.e. one generated function per stage that reads its item, registers and fields and writes its outputs itself. The operations alone are the floor for it: 83 to 88 µs per document, at most 1.7 times faster than the 143 to 147 µs. It would be a change to loop-program.ts for every loop program, not for this page. I stopped at the saving that was asked for.
- **In Chrome the time didn't depend on which other programs had run**: the 8 states' times after the programs for 16 and 32 states had run in the same page are the upper ends of the ranges above, within 6% of the first ones. In Bun, where the lab's tests run, it did. With four runners for 8 states created one after the other in one process, a search that stops at the text's end took 137 µs per document on the first runner and 292 µs on the third, and one that runs every position 218 µs on the second and 444 µs on the fourth, while the operations alone stayed at 63 to 64 and 107 to 109 µs: the runner's copies got slower, not the program.

### What the searcher's tables say

- **Creating a searcher for 100,000 documents takes 177 ms**: 43.8 ms of JavaScript writing 51.3 million cells, 85.5 ms for uploading 205 MB, compiling the highlighter's shader and validating every document, and the rest for compiling the search shader of 8 states.
- **The highlighter's loop shader compiles in 14 to 42 ms**, where the display shader with every position written out compiled in 2,204 ms in the same processes.
- **The loop validates 100,000 documents in 2.19 ms back to back and 8.28 ms after a pause of 200 ms or more**, with the display kinds of every document written on the GPU. That is the evaluation's own time. From the call of `searcher.validate()` until its promise resolves, which adds JavaScript turning the summary into four typed arrays, the review measured 2.36 ms against 2.12 ms. The shader with every position written out takes 5.68 ms back to back in the same processes, although the loop runs 18,961 operations per document instead of 7,698. I didn't look for the reason. One difference is that a loop's body has 37 values alive, and the other shader 13,350.
- **In the same page the table loop takes 146 ms and JSON.parse 78.8 ms** for the 100,000 documents, 67 and 36 times the loop's back to back time, and 18 and 10 times its time after a pause. At 1,000 documents the loop on the GPU takes 0.65 ms, what JSON.parse takes, and 1.9 ms after a pause. The first stage's page measured the same table loop at 119 ms, and the review's pages at 123 to 139 ms. The pass is over documents that are already on the GPU: from the texts, the searcher's 130 ms of cells, upload, compile and pass are what the table loop takes.
- **A search through the searcher takes 7.63 ms at 8 states and 100,000 documents**, and 17.5 to 17.6 ms after a pause of 200 ms or more, in every scope: a scope is nine shared cells. That is about 0.6 ms more than the step alone in the section before, for reading the kinds, the copies of the results, and the 0.75 ms between two searches here.
- **A longer pattern costs what it costs without the searcher**: 65.3 ms at up to 16 states, and 132 ms at up to 32 states for 10,000 documents.
- **Searching only the window's 64 documents**, as after a scroll, takes 1.2 to 2.5 ms at 8 states, 7.8 ms at 16 and 58 ms at 32: one document's operations in one GPU thread, whatever the count.
- **RegExp on each string value takes 12.7 to 24.2 ms for 100,000 documents on the nine ordinary patterns**, 15.8 to 28.8 ms on each key, and 8.1 to 44.1 ms on the whole text, after finding the runs once, 95 ms for the 785,185 string values and 101 ms for the 1,230,015 keys. So at 8 states the searcher is 2.2 to 3.2 times faster than RegExp on string values when searches follow each other, and about even after a pause. On `([a-z]+)+x` RegExp takes 567 ms on the string values, 1,601 ms on the keys and 2,128 ms on the whole text.
- **The same loop programs on the CPU**, as generated JavaScript, take 90 to 108 µs per document to validate and 245, 597 and 3,614 µs per document and search at 8, 16 and 32 states, i.e. 9 to 11 s, 24.5 s, 1.0 minute and 6.0 minutes for 100,000 documents. On the executor the loops take 2.7 to 2.9 ms per document to validate and 3.4, 10.6 and 38.7 ms per search. Those aren't the CPU's best times for these programs: with every position written out, the highlighter takes 8.4 to 9.2 s for 100,000 documents on the executor and 2.1 s as generated JavaScript, and a search at 8 states takes 1.9 ms per document on the executor, 3.2 minutes.
- **The self check** over 300 documents takes about 0.43 s: 0.35 s of generated JavaScript and 0.08 s on the GPU.

## Measured results: the searcher with bit-emit.ts's shaders

Measured on October 14, 2026 on the same Apple M5 Max, with 18 cores and 36 GiB, macOS 27.0 and Bun 1.4.3, in headless Chrome for Testing 155.0.8059.79 through Metal, with timestamp queries, cross-origin isolated. The measurements above are from Google Chrome 155.0.8059.40. Other jobs ran on the machine throughout, among them other browsers and test runs, and the 1-minute load average went from 2.5 to 23.

Two measurement pages, each run twice, a run in a new Chrome process with a new profile folder and a shader salt that no earlier run used:

- **gpu/writers-run.ts**, results/writers-1.json and writers-2.json, about 4 minutes each, at a load average of 2.5 to 5.0 and of 4.4 to 7.0. It creates the searcher three times on one device, over the demo page's 100,000 documents, which are all valid JSON: with loop-emit.ts's shaders for the search programs, as until October 14, with bit-emit.ts's, as now, and with bit-emit.ts's shader for the highlighter too. The searchers take turns, three per pattern each, so that two times that are compared lie a few seconds apart. A turn is 15 searches back to back after 2 of warmup, then 9 searches each after a pause of 200 ms, and 5 and 4 for a search that takes about 1 s. A search's time runs from the call of `searcher.search` until its promise resolves. A turn of the highlighter's pass is 15 passes back to back, 15 more that ask the GPU for the pass's own time, in turn with the first 15, and 9 passes each after a pause.
- **gpu/combined-run.ts**, results/combined-bit-emit-1.json and combined-bit-emit-2.json, 6.4 minutes each, at a load average of 3.5 to 23 and of 2.9 to 8.2. It is the page of [Measured results: the searcher](#measured-results-the-searcher) with the searcher as it is now, over the generated documents with 1 in 10 broken, at 100 to 100,000 documents, and with its method. The program of 32 states is now timed at every count.

gpu/writers-summarize.ts and gpu/search-summarize.ts print the tables below from those files. A cell is the median of the turns' or the runs' medians. The writers' tables give the smallest and the largest sample in parentheses, and the others the range of the two runs.

### Both writers' shaders in one Chrome process: creating the searcher, ms

| The searcher with | Created in | JSON highlighter: statements, compile | regex search, 8 states: statements, compile | regex search, 16 states: statements, compile | regex search, 32 states: statements, compile |
| --- | --- | --- | --- | --- | --- |
| loop-emit.ts's search shaders | 677 (664 to 689) | 107, 74.5 (73.9 to 75.1) | 503, 97.9 (95.8 to 100) | 1,375, 182 (178 to 185) | 4,655, 579 (567 to 591) |
| bit-emit.ts's search shaders | 101 (98.4 to 103) | 107, 51.4 (51.0 to 51.7) | 147, 21.8 (21.6 to 21.9) | 171, 23.8 (23.5 to 24.1) | 219, 32.6 (30.8 to 34.4) |
| bit-emit.ts's search shaders and highlighter shader | 84.5 (83.6 to 85.3) | 103, 41.8 (40.9 to 42.6) | 147, 21.8 (21.8 to 21.8) | 171, 24.3 (24.0 to 24.7) | 219, 31.0 (30.9 to 31.1) |

The cells of every document are written before the searchers are created, so their 44 ms aren't in these times. The three searchers are created one after the other, each with its own copy of the documents on the GPU, and each one's shaders are compiled at the same time.

### One search of 100,000 documents through the searcher, by the program that the pattern runs on, ms

| The program of | Patterns | loop-emit.ts's shader, back to back | bit-emit.ts's shader, back to back | loop-emit.ts's shader, after a pause of 200 ms | bit-emit.ts's shader, after the same pause |
| --- | --- | --- | --- | --- | --- |
| 8 states | 5 | 7.81 (7.32 to 10.3) | 4.60 (4.13 to 8.46) | 16.5 (7.49 to 25.7) | 11.3 (4.42 to 14.9) |
| 16 states | 2 | 68.8 (64.1 to 74.3) | 4.72 (4.32 to 5.71) | 69.6 (65.1 to 77.4) | 11.9 (4.79 to 16.6) |
| 32 states | 2 | 945 (923 to 1012) | 5.24 (4.74 to 6.66) | 948 (892 to 991) | 13.2 (5.18 to 18.4) |

### The same, by pattern, ms

| Pattern | The search reads | States, and the program | Documents with a match | loop-emit.ts's shader, back to back | bit-emit.ts's shader, back to back | loop-emit.ts's shader, after a pause of 200 ms | bit-emit.ts's shader, after the same pause |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `error` | everything | 6, 8 | 10,559 | 7.81 (7.39 to 9.29) | 4.57 (4.19 to 8.46) | 17.0 (7.49 to 22.6) | 11.5 (4.61 to 14.9) |
| `[a-z0-9.]+@[a-z.]+` | string values | 4, 8 | 14,481 | 7.74 (7.33 to 10.3) | 4.50 (4.24 to 5.75) | 16.3 (7.63 to 23.3) | 11.1 (4.59 to 12.3) |
| `[a-z]+Id` | keys | 4, 8 | 23,795 | 7.99 (7.39 to 9.88) | 4.60 (4.20 to 5.64) | 16.1 (8.08 to 24.3) | 11.6 (4.42 to 13.5) |
| `([a-z]+)+x` | everything | 3, 8 | 47,577 | 7.89 (7.32 to 10.0) | 4.57 (4.16 to 5.72) | 17.1 (7.62 to 25.7) | 11.3 (4.72 to 13.9) |
| `(the\|an?) [a-z]+` | string values | 8, 8 | 27,189 | 7.78 (7.35 to 9.64) | 4.72 (4.13 to 6.78) | 14.2 (7.89 to 21.8) | 11.0 (4.68 to 13.3) |
| `\d\d\d\d-\d\d-\d\d` | everything | 11, 16 | 27,803 | 68.5 (64.1 to 74.3) | 4.72 (4.39 to 5.45) | 69.0 (65.1 to 73.7) | 11.7 (4.79 to 13.5) |
| `(the\|an?\|some) [a-z]+(ing)?s?` | everything | 16, 16 | 28,467 | 69.0 (65.3 to 73.8) | 4.72 (4.32 to 5.71) | 69.9 (65.7 to 77.4) | 12.3 (4.83 to 16.6) |
| `connection reset` | everything | 17, 32 | 1,440 | 940 (923 to 976) | 5.16 (4.74 to 6.47) | 945 (892 to 983) | 13.2 (5.33 to 18.4) |
| `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? ` | everything | 32, 32 | 24,845 | 954 (930 to 1012) | 5.31 (4.82 to 6.66) | 953 (934 to 991) | 13.4 (5.18 to 17.3) |

Every document's match count and the marks of 64 documents, from either writer's shaders: 2,389,824 values in 18 searches, 0 differ.

### The highlighter's pass over every document, from either writer's shader, ms

| The highlighter's shader, written by | Back to back | The compute pass alone, timestamps | After a pause |
| --- | --- | --- | --- |
| loop-emit.ts | 2.42 (2.30 to 4.50) | 1.86 (1.78 to 3.30) | 8.93 (2.60 to 11.8) |
| bit-emit.ts | 3.01 (2.29 to 6.13) | 2.06 (1.76 to 4.44) | 9.74 (2.97 to 11.6) |

The validation and every display kind, from either writer's shader: 103,200,000 values, 0 differ.

### bit-emit.ts's search shader with loops that run every position, and with loops that stop at the text's end, ms

| States | The loops | Statements | Compile | Back to back | After a pause |
| --- | --- | --- | --- | --- | --- |
| 8 | run every position | 147 | 18.5 to 19.5 | 4.40 (4.14 to 5.83) | 11.4 (4.66 to 12.9) |
| 8 | stop at the text's end | 153 | 17.9 to 19.5 | 13.3 (11.6 to 14.7) | 16.4 (12.7 to 28.9) |
| 16 | run every position | 171 | 23.7 to 24.7 | 4.52 (4.18 to 5.05) | 12.1 (4.76 to 12.8) |
| 16 | stop at the text's end | 177 | 21.8 to 22.2 | 13.0 (11.9 to 14.3) | 17.6 (12.4 to 31.1) |
| 32 | run every position | 219 | 28.7 to 29.4 | 4.96 (4.58 to 5.67) | 14.2 (4.79 to 17.4) |
| 32 | stop at the text's end | 225 | 28.8 to 30.6 | 12.6 (11.3 to 14.3) | 18.4 (12.0 to 26.8) |

The matches that every evaluation of the two shaders counted, at 8, 16 and 32 states: 12,507 and 12,507; 27,803 and 27,803; 1,440 and 1,440, the same.

### The searcher at every document count: creating it

| Documents | MB of cells | JavaScript writing the cells, ms | Upload, the highlighter's shader and pass, and every search program built and compiled, ms | Total, ms |
| --- | --- | --- | --- | --- |
| 100 | 0.21 | 0.52 (0.41 to 0.64) | 118 (88 to 148) | 119 (89 to 149) |
| 1,000 | 2.05 | 0.64 (0.63 to 0.65) | 66.9 (66.5 to 67.3) | 67.5 (67.1 to 67.9) |
| 10,000 | 20.5 | 5.97 (5.20 to 6.74) | 72.5 (67.6 to 77.3) | 78.5 (72.8 to 84.1) |
| 100,000 | 205 | 50.5 | 95.3 (95.0 to 95.6) | 146 |

| Program | Operations per stage | WGSL statements | Compile shader ms, by document count |
| --- | --- | --- | --- |
| JSON highlighter | 37, 17 | 107 | 100: 61 (45 to 77); 1,000: 31; 10,000: 35 (31 to 38); 100,000: 45 (44 to 45) |
| regex search, 8 states | 8, 151, 92 | 147 | 100: 27 (22 to 33); 1,000: 22; 10,000: 22 (21 to 22); 100,000: 21 |
| regex search, 16 states | 16, 359, 308 | 171 | 100: 32 (25 to 38); 1,000: 25 (24 to 25); 10,000: 25 (24 to 25); 100,000: 24 (23 to 24) |
| regex search, 32 states | 32, 1,159, 1,124 | 219 | 100: 41 (31 to 51); 1,000: 31 (31 to 32); 10,000: 32 (31 to 33); 100,000: 30 |

The first stage's display shader, every position written out, in the same processes: 13,350 statements, compiled in 4,473 (4,233 to 4,713) ms.

### One search through the searcher at every document count, ms

| States | Scope | Documents | Back to back | Compute pass, timestamps | After a pause of 16 ms | After a pause of 200 ms | After a pause of 1,000 ms | Only the window's 64 documents |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | strings | 100 | 1.45 (1.00 to 1.90) | 0.55 (0.41 to 0.70) | 1.74 (1.17 to 2.31) | 2.43 (2.41 to 2.45) | 2.54 (2.45 to 2.64) | 0.90 (0.80 to 1.01) |
| 8 | strings | 1,000 | 0.93 (0.61 to 1.25) | 0.95 (0.34 to 1.57) | 1.89 (1.64 to 2.14) | 2.68 (2.15 to 3.21) | 2.57 (2.16 to 2.99) | 0.80 (0.64 to 0.97) |
| 8 | strings | 10,000 | 0.94 | 0.60 | 2.69 (2.54 to 2.84) | 4.31 (4.03 to 4.60) | 4.17 (4.01 to 4.33) | 0.62 (0.62 to 0.63) |
| 8 | strings | 100,000 | 4.51 (4.49 to 4.54) | 3.89 (3.88 to 3.90) | 5.23 (5.05 to 5.43) | 12.6 (12.5 to 12.7) | 12.9 (12.7 to 13.1) | 1.21 (0.62 to 1.79) |
| 8 | everything | 100 | 0.90 (0.79 to 1.01) | 0.52 (0.36 to 0.68) |  |  |  |  |
| 8 | everything | 1,000 | 0.64 (0.61 to 0.67) | 0.34 |  |  |  |  |
| 8 | everything | 10,000 | 0.94 (0.94 to 0.95) | 0.60 |  |  |  |  |
| 8 | everything | 100,000 | 4.57 (4.55 to 4.59) | 3.90 (3.89 to 3.90) |  |  |  |  |
| 8 | keys | 100 | 1.54 (1.16 to 1.92) | 0.99 (0.42 to 1.56) |  |  |  |  |
| 8 | keys | 1,000 | 1.23 (0.60 to 1.86) | 0.51 (0.34 to 0.68) |  |  |  |  |
| 8 | keys | 10,000 | 0.94 | 0.60 (0.60 to 0.61) |  |  |  |  |
| 8 | keys | 100,000 | 4.74 (4.48 to 5.00) | 3.92 (3.89 to 3.94) |  |  |  |  |
| 16 | strings | 100 | 1.01 (0.91 to 1.12) | 0.61 (0.43 to 0.79) | 2.17 (1.71 to 2.62) | 2.75 | 2.69 (2.64 to 2.74) | 0.93 (0.78 to 1.08) |
| 16 | strings | 1,000 | 0.89 (0.69 to 1.09) | 0.59 (0.39 to 0.78) | 2.07 (1.34 to 2.81) | 3.05 (2.65 to 3.45) | 3.02 (2.67 to 3.37) | 0.92 (0.76 to 1.09) |
| 16 | strings | 10,000 | 1.02 | 0.68 (0.66 to 0.71) | 2.50 (1.89 to 3.11) | 4.16 (3.61 to 4.71) | 4.06 (3.57 to 4.55) | 0.92 (0.71 to 1.12) |
| 16 | strings | 100,000 | 4.63 (4.51 to 4.76) | 4.07 (4.03 to 4.12) | 5.18 (4.98 to 5.38) | 13.6 (13.0 to 14.2) | 13.7 (13.5 to 13.9) | 0.71 (0.70 to 0.72) |
| 16 | everything | 100 | 0.90 (0.73 to 1.07) | 0.40 (0.40 to 0.41) |  |  |  |  |
| 16 | everything | 1,000 | 0.88 (0.69 to 1.08) | 0.59 (0.39 to 0.78) |  |  |  |  |
| 16 | everything | 10,000 | 1.28 (1.02 to 1.55) | 1.26 (0.66 to 1.87) |  |  |  |  |
| 16 | everything | 100,000 | 4.52 (4.47 to 4.57) | 4.04 (4.03 to 4.05) |  |  |  |  |
| 16 | keys | 100 | 0.87 (0.67 to 1.08) | 0.61 (0.42 to 0.79) |  |  |  |  |
| 16 | keys | 1,000 | 0.88 (0.68 to 1.09) | 0.59 (0.39 to 0.78) |  |  |  |  |
| 16 | keys | 10,000 | 1.46 (1.02 to 1.91) | 0.92 (0.66 to 1.19) |  |  |  |  |
| 16 | keys | 100,000 | 4.47 (4.46 to 4.48) | 4.02 (4.01 to 4.03) |  |  |  |  |
| 32 | strings | 100 | 1.76 (1.35 to 2.18) | 0.78 (0.54 to 1.03) | 1.51 (1.51 to 1.52) | 3.60 (3.44 to 3.77) | 3.49 (3.39 to 3.59) | 1.39 (1.10 to 1.68) |
| 32 | strings | 1,000 | 1.07 (0.96 to 1.19) | 0.52 | 2.40 (1.21 to 3.58) | 4.02 (3.26 to 4.79) | 3.77 (3.64 to 3.90) | 1.52 (0.98 to 2.07) |
| 32 | strings | 10,000 | 1.90 (1.24 to 2.57) | 1.74 (0.79 to 2.69) | 3.10 (2.49 to 3.70) | 5.01 (4.44 to 5.58) | 4.97 (4.46 to 5.49) | 0.98 (0.97 to 0.99) |
| 32 | strings | 100,000 | 5.02 (4.97 to 5.07) | 4.43 (4.41 to 4.46) | 5.77 (5.36 to 6.19) | 15.8 (15.5 to 16.0) | 15.5 (15.4 to 15.6) | 0.96 (0.95 to 0.98) |
| 32 | everything | 100 | 1.60 (0.98 to 2.23) | 1.47 (0.54 to 2.41) |  |  |  |  |
| 32 | everything | 1,000 | 1.32 (0.97 to 1.67) | 1.47 (0.53 to 2.41) |  |  |  |  |
| 32 | everything | 10,000 | 1.23 (1.23 to 1.24) | 0.79 |  |  |  |  |
| 32 | everything | 100,000 | 5.07 (4.91 to 5.23) | 4.47 (4.46 to 4.47) |  |  |  |  |
| 32 | keys | 100 | 1.55 (0.99 to 2.12) | 1.00 (0.55 to 1.45) |  |  |  |  |
| 32 | keys | 1,000 | 1.13 (1.01 to 1.24) | 0.96 (0.54 to 1.37) |  |  |  |  |
| 32 | keys | 10,000 | 1.24 (1.23 to 1.25) | 0.79 |  |  |  |  |
| 32 | keys | 100,000 | 4.94 (4.93 to 4.96) | 4.41 (4.40 to 4.43) |  |  |  |  |

### One search through the searcher against RegExp on each string value: ms at each document count, and the count from which the GPU takes less time

| What runs | ms at 100 documents | ms at 1,000 documents | ms at 10,000 documents | ms at 100,000 documents | Documents from which the GPU takes less time, back to back | After a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- |
| the searcher's program of 8 states, back to back | 1.45 | 0.93 | 0.94 | 4.51 | |  |
| the same after a pause of 200 ms | 2.43 | 2.68 | 4.31 | 12.6 | | |
| the searcher's program of 16 states, back to back | 1.01 | 0.89 | 1.02 | 4.63 | |  |
| the same after a pause of 200 ms | 2.75 | 3.05 | 4.16 | 13.6 | | |
| the searcher's program of 32 states, back to back | 1.76 | 1.07 | 1.90 | 5.02 | |  |
| the same after a pause of 200 ms | 3.60 | 4.02 | 5.01 | 15.8 | | |
| RegExp, `(the\|an?) [a-z]+`, which the searcher runs on 8 states | 0.01 | 0.16 | 1.71 | 19.3 | 3,200 | 19,000 |
| RegExp, `error`, which the searcher runs on 8 states | 0.01 | 0.19 | 1.87 | 20.5 | 2,800 | 17,000 |
| RegExp, `[a-z0-9.]+@[a-z.]+`, which the searcher runs on 8 states | 0.02 | 0.21 | 2.03 | 21.8 | 2,500 | 16,000 |
| RegExp, `[A-Z][a-z]+ [A-Z][a-z]+`, which the searcher runs on 8 states | 0.01 | 0.17 | 1.53 | 16.5 | 3,700 | 26,000 |
| RegExp, `\d+\.\d+`, which the searcher runs on 8 states | 0.01 | 0.15 | 1.42 | 15.4 | 4,200 | 33,000 |
| RegExp, `([a-z]+)+x`, which the searcher runs on 8 states | 0.58 | 5.88 | 53.2 | 556 | 140 | 230 |
| RegExp, `\d\d\d\d-\d\d-\d\d`, which the searcher runs on 16 states | 0.01 | 0.12 | 1.22 | 14.8 | 6,100 | 51,000 |
| RegExp, `(the\|an?\|some) [a-z]+(ing)?s?`, which the searcher runs on 16 states | 0.01 | 0.16 | 1.85 | 22.6 | 2,900 | 16,000 |
| RegExp, `connection reset`, which the searcher runs on 32 states | 0.01 | 0.15 | 1.36 | 15.5 | 11,000 | never, up to 100,000 |
| RegExp, `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? `, which the searcher runs on 32 states | 0.01 | 0.16 | 1.81 | 20.7 | 10,000 | 25,000 |

### The same programs on the CPU in these runs, µs per document

| Backend | Documents sampled | Validate | Search, 8 states | 16 states | 32 states |
| --- | --- | --- | --- | --- | --- |
| generated JavaScript | 200 | 156 (144 to 167) | 128 (127 to 128) | 315 (315 to 316) | 1,955 (1,909 to 2,002) |
| CPU executor | 16 | 2,956 (2,952 to 2,960) | 2,143 (2,141 to 2,146) | 6,690 (6,604 to 6,777) | 25,253 (22,570 to 27,935) |

### The checks of these runs

Run 1: validation of 111,100 documents against the table loop, 57,327,600 values, 0 mismatched. 22,153 searches read back, 1,085,831,640 values compared with the plain JavaScript loop, 0 mismatched. The plain loop against the loop program on the CPU: 10,773,000 values, 0 mismatched. The searcher's self check: 12,828,000 values, 0 mismatched.
Run 2: validation of 111,100 documents against the table loop, 57,327,600 values, 0 mismatched. 21,348 searches read back, 1,067,465,196 values compared with the plain JavaScript loop, 0 mismatched. The plain loop against the loop program on the CPU: 10,773,000 values, 0 mismatched. The searcher's self check: 12,828,000 values, 0 mismatched.

### The review's checks again, on the GPU

gpu/review-run.ts's two modes that compare a GPU searcher with the programs on the CPU, each once more with the searcher as it is now (results/review-edge-bit-emit-1.json and review-many-bit-emit-1.json, 4.1 and 4.0 minutes, load average 4.6 to 6.1 and 4.9 to 5.9). The counts are the ones of [The review's checks](#the-reviews-checks-the-limits-and-the-programs-with-every-position-written-out), since the documents, the searches and the references are the same:

- **The limits**: the 1,449 documents, against the written-out programs on the CPU executor. Validation and kinds: 747,684 values, 0 different. 46 searches up to 16 states, every match count and the marks of every document: 34.2 million values, 0 different, with 540,943 expected matches. At 32 states, against the loop program as generated JavaScript: 8 searches, 2.8 million values, 0 different, and against the loop program on the CPU executor for 32 of the documents: 131,328 values, 0 different.
- **Three requests at once**, 20 rounds: the two older requests resolved to `undefined` every time, and the newest one's counts and marks equal those of the same search alone, 2.65 million values, 0 different.
- **All 100,000 generated documents**: validation and every display kind against highlighter.ts on the CPU executor, 51.6 million values, 0 different. Five searches against the loop programs as generated JavaScript over every document, four at 8 states and one at 16: 992,160 values, 0 different, 2.67 million expected matches. Two searches at 32 states over the first 10,000 documents, and three searches on the CPU executor over the first 2,000: 189,840 values, 0 different.
- **The self check**, 300 documents: 24 searches, i.e. each of the 9 that it had then on every program that holds it, 3,848,400 values, 0 different, in 4.9 to 6.6 s of generated JavaScript and 0.14 to 0.30 s on the GPU, in this run and in each of the two runs of gpu/combined-run.ts at 1,000 documents and more.
- **Once more after a review of the page**, the mode of the limits (results/review-edge-bit-emit-2.json, 4.0 minutes, load average 0.9 to 4.0). Two things had changed. The self check has two more searches, `[^,]+` in everything and in string values, since none of the 9 had a class that holds the characters next to a match, and a shader that took the -1 of a cell past the text's end for a character passed all of them. And gpu/host.ts pops its two error scopes in one step, since the three search runners are created at the same time. The counts of the limits are the same, 0 different, and the self check's 30 searches, i.e. each of its 11 on every program that holds it, compare 4,771,800 values, 0 different, in 5.8 s of generated JavaScript and 0.17 s on the GPU.

### What these tables say

- **A search takes 4.6, 4.7 and 5.2 ms at 8, 16 and 32 states for 100,000 documents, back to back, and 11.3, 11.9 and 13.2 ms after a pause of 200 ms**, where loop-emit.ts's shaders take 7.8, 69 and 945 ms and 16.5, 70 and 948 ms in the same processes. That is 1.7, 15 and 180 times less back to back. Over the generated documents, in two other processes: 4.5, 4.6 and 5.0 ms, and 12.6, 13.6 and 15.8 ms after a pause.
- **The pass alone, from timestamp queries, takes 3.9, 4.1 and 4.4 ms**, so about 0.6 ms of a back to back search is JavaScript, the upload and the readback. Packing the words is part of that: 272, 544 and 1,088 words from 1,135 to 16,591 cells at each upload.
- **Every value is the same from both writers' shaders**: 2.4 million match counts and marks in 18 searches, and 103 million values of the highlighter. Against the plain JavaScript loop, 22,153 and 21,348 searches with 1.09 and 1.07 billion values, none different.
- **The floor no longer grows with the pattern's size.** 100 to 10,000 documents take 0.6 to 1.9 ms at any of the three sizes, where loop-emit.ts's shaders took 8 ms at 16 states and 77 to 132 ms at 32. A search of only the window's 64 documents, as after a scroll, takes 0.6 to 2.1 ms, where it took 7.8 ms at 16 states and 58 ms at 32.
- **The search shaders compile in 22, 24 and 33 ms without a cache**, where loop-emit.ts's take 98, 182 and 579 ms. Creating the searcher with all three takes 0.10 s after the cells are written, and 0.68 s with loop-emit.ts's three.
- **The highlighter's pass doesn't get faster from bit-emit.ts's shader**: 2.3 to 3.9 ms back to back from loop-emit.ts's and 2.3 to 4.5 ms from bit-emit.ts's, as the medians of six turns each. In two of the six pairs of turns the two were the same within 0.03 ms, and in four bit-emit.ts's was 0.5 to 0.7 ms slower. So the searcher keeps loop-emit.ts's shader for the highlighter. Its step has no gate over several table reads, which is where bit-emit.ts's gain comes from.
- **Stopping the loops at the text's end is slower with bit-emit.ts's shader too**: 12.6 to 13.3 ms back to back against 4.4 to 5.0 ms, although the documents have 300 code points on average, and 16 to 18 ms against 11 to 14 ms after a pause. In one more Chrome process, a first version of this page whose result file wasn't kept, the shaders that stop also compiled in 227, 250 and 344 ms, where the others took 19, 26 and 34 ms, which [million/README.md](million/README.md#what-is-still-unknown) lists as unexplained. So the GPU searcher's loops run every position.
- **Against RegExp on each string value, the GPU takes less time from 2,000 to 13,000 documents on when searches follow each other**, depending on the pattern and the run, and from 15,000 to 54,000 after a pause, or not at all up to 100,000 for the date and `connection reset` in one run. With loop-emit.ts's shaders the same table gave 9,500 to 11,000 and 16,000 to 25,000 at 8 states, and never at 16 states.
- **On the CPU nothing changed**: 128, 315 and 1,955 µs per document and search at 8, 16 and 32 states as generated JavaScript, with loops that stop at the text's end.

## What the review found, and what changed

A second pass over this folder on October 13, 2026, a few hours after that day's measurements, so the GPU's search times in this section are the ones of loop-emit.ts's shaders. Each measurement page ran once more in a fresh Chrome process, the code and the tests were read, the GPU was compared with the CPU at the limits of both programs, and the plain JavaScript baselines were written in other ways and given more threads.

The review found no defect in the programs, the shaders, the host or the searcher: every value that it read back from the GPU equals the CPU's, see [The review's checks](#the-reviews-checks-the-limits-and-the-programs-with-every-position-written-out). It found these problems in the write-up and gaps in the checks, which are fixed:

- **The times for "the same programs on the CPU" were the loop forms' times through this folder's CPU runner, from one cold run.** The summary said that validating 100,000 documents takes 11 s as generated JavaScript and 5 minutes on the executor. Both came from one run per process over the first 200 and 16 documents, which includes building the program, and they time the loop form, which the runner calls once per position while the executor checks every source cell's range on each call. The highlighter as the repo ships it, with every position written out, takes 8.4 to 9.2 s on the executor, which every first-stage run measured over all 100,000 documents, and 2.1 s as generated JavaScript. The search's 6 minutes on the executor was the loop form too, and form (a) with every position written out takes 1.9 ms per document there, 3.2 minutes. The summary now gives each program's faster form on the CPU, and says which one.
- **"Validated and highlighted on the GPU in 2.2 ms, where JavaScript takes 146 ms" compared a second pass with a first one.** The 2.2 ms is the pass over documents that are already on the GPU, and a page needs that pass once. From the texts, the GPU's answers arrive after 0.13 s, where the plain JavaScript highlighter takes 0.12 to 0.15 s. The summary and the three rows now say so, and no longer call the highlighter's part of a combined app clearly faster.
- **Every baseline ran on one of 18 cores, which the summary didn't say.** [JavaScript in several workers](#javascript-in-several-workers) is new. With 8 workers RegExp counts a pattern's matches in 100,000 documents in 1.9 to 6.7 ms, less than the GPU's 7 to 21 ms.
- **The same plain JavaScript highlighter measured 119 ms in one page and 146 ms in another**, and the summary quoted the larger one. It is the same loop over the same documents. The review's pages measured 123, 132 and 139 ms, and writing the kinds into one array of 512 or into an array of every document's kinds makes no difference, 123 against 122 ms. The summary now gives the range.
- **The ranges were the spread of runs made within half an hour of each other.** The table below has the review's runs next to them: most cells agree within 5%, and some differ by 10 to 20%, e.g. the first stage's JSON.parse, 103 ms where the three runs had 87.5 ms (86.9 to 89.2). No conclusion changes. The summary's ranges now cover every run.
- **The crossovers against RegExp had two digits.** They are interpolated between four counts, and the review's run moved single patterns by up to 40%, e.g. `\d+\.\d+` from 10,000 to 6,100 documents. The summary now says about 2,000 to about 13,000.
- **The loop shaders' compile times differ between pages.** The three search runs measured 0.11, 0.26 and 1.1 s at 8, 16 and 32 states, and the searcher's runs and the review's search run 0.05, 0.13 and 0.5 to 0.65 s for the same shaders with a new salt. I didn't find out why. The summary says 0.05 to 0.1 s at 8 states.
- **"A few ms per keystroke" was 7.6 to 17.6 ms**, and a keystroke comes after a pause, so the summary now says 8 to 21 ms.
- **`searcher.validate()`'s time leaves out JavaScript's part after the readback**, turning the summary into four typed arrays: 2.36 ms from the call until the promise resolves, against 2.12 ms for the evaluation, in the same run.
- **The searches on the GPU had been compared with a plain JavaScript loop, and with the programs on the CPU only for each run's first 200 documents.** The loop is another implementation of the same automaton, not the program. The review compared the GPU with the loop programs as generated JavaScript over all 100,000 documents, and with the programs that have every position written out, on the CPU executor, over 1,449 documents at the limits.
- **No check ran a search at 512 positions at the limits**: an empty text, a text of exactly 512 code points, a match on the last position, 512 matches in one document, or patterns that fill 16 and 32 states together with 16 classes and 32 class boundaries. The generated documents have none of these. edge-cases.ts and its 5 tests are new, and so is `bun lab/json-search/report.ts edge-cases`.
- **Only the newest of several requests getting a result was tested on the CPU searcher alone**, where an evaluation finishes before the next request is made. On the GPU, three requests at once behaved the same in 20 rounds.
- **Nothing said that the self check's searches find something.** A new test does: each of the four finds matches in the first 300 generated documents, 13,188 in all, so a GPU that returned zeros would fail the check.

What the review looked for and didn't find:

- **A median that is a minimum or a maximum.** The summarize scripts take the mean of the middle two values of an even count, and every row of the tables above is printed by them from results/, which the review compared line by line.
- **A baseline timed in another runtime.** Every baseline runs in the Chrome page that runs the GPU.
- **A timing that leaves out JavaScript's work, the upload or the readback.** A search's time runs from before `compilePattern` until the results are copied. The times with the documents already on the GPU upload nothing per evaluation, and say so. `searcher.validate()` above is the one exception.
- **A baseline written slowly.** Counting a pattern's matches with `match`, with `match` without the `u` flag, with a loop of `test` and with a loop of `exec` takes the same time within 12% on every pattern but one, see the table below.
- **A mistake at a limit.** See the checks.

### The review's runs next to the earlier ones

One fresh Chrome process per page, between 11:25 and 11:53 on the same day, three hours after the first stage's runs and between 40 minutes and two hours after the others, at a 1-minute load average of 2.55 to 8.32, 2.24 to 5.88 and 1.86 to 4.06 (results/review-rerun-gpu-main.json, review-rerun-search.json, review-rerun-combined.json). ms for 100,000 documents:

| What | The earlier runs: median (range) | The review's run |
| --- | --- | --- |
| First stage: the summary, documents on the GPU, back to back | 3.75 (3.72 to 3.79) | 4.13 |
| The same after a pause of 1 s | 11.0 (11.0 to 11.0) | 11.0 |
| The same with an upload per evaluation | 66.6 (66.5 to 68.0) | 77.5 |
| First stage's page: JSON.parse | 87.5 (86.9 to 89.2) | 103 |
| First stage's page: the table loop | 119 (119 to 120) | 132 |
| First stage's page: the executor over all 100,000 documents, display program, one pass | 8,300 to 8,700 | 9,248 |
| The summary shader's compile | 1,871 (1,777 to 2,071) | 1,983 |
| The search step, 8 states, 512 positions, back to back | 7.04 (7.02 to 7.33) | 6.86 |
| The same after a pause of 200 ms | 16.7 (9.6 to 17.0) | 17.2 |
| The search step, 16 states | 63.8 (63.6 to 64.6) | 64.5 |
| The search step, 32 states | 871 (866 to 872) | 860 |
| The hand-written kernel, 8 states | 3.38 (3.31 to 3.39) | 3.31 |
| RegExp, every match, `(the\|an?) [a-z]+` | 23.2 (22.8 to 24.4) | 23.3 |
| The search shader's compile, 8 states, 512 positions | 114 (106 to 116) | 51 |
| Creating the searcher | 177 (169 to 280) | 166 |
| The highlighter's loop, back to back | 2.19 (2.17 to 2.31) | 2.18 |
| The same after a pause of 1 s | 8.28 (8.26 to 9.07) | 9.27 |
| One search through the searcher, 8 states, string values, back to back | 7.63 (7.42 to 8.11) | 7.57 |
| The same after a pause of 200 ms | 17.5 (10.1 to 17.6) | 20.8 |
| The same after a pause of 1 s | 17.6 (17.6 to 18.0) | 19.3 |
| Searcher's page: the table loop | 146 (139 to 152) | 139 |
| Searcher's page: JSON.parse | 78.8 (75.2 to 84.2) | 74.7 |
| RegExp on each string value, the five patterns of up to 8 states that don't backtrack | 16.8 to 24.2 | 15.3 to 22.7 |

- Every readback of the reruns was compared as before: 7.60 billion values against the executor in the first stage's page, 711 million and 406 million against the plain JavaScript loop in the other two, and 57.3 million against the table loop, none different.
- For about two seconds of the first-stage run, the summary of 100,000 documents took 13 to 20 ms after pauses of 1 to 16 ms, where the earlier runs measured 4.2 to 4.3 ms, and the series with a timestamp query before it had a median of 7.8 ms instead of 3.9 ms. The next series measured 4.3 to 6.3 ms again. Another process was using the GPU or the machine, which a page in a browser has to expect.

### JavaScript in several workers

The baselines above run on one thread, and the machine has 18 cores. The review's page gives each of N workers an equal share of the 100,000 documents once, as strings cut to their first 512 code points. One request is one message to every worker, each worker answers with one typed array, e.g. a match count per document, and the request's time runs until the last answer has arrived in the page. 5 requests of warmup and 15 samples, or at least 1 and 3 for the pattern that backtracks. Three fresh Chrome processes (results/review-baselines-1.json to review-baselines-3.json), at a 1-minute load average of 2.61 to 3.15, 3.99 to 6.04 and 3.78 to 7.67. ms for 100,000 documents:

| What | One thread in the page | 1 worker | 2 workers | 4 workers | 8 workers | 16 workers |
| --- | --- | --- | --- | --- | --- | --- |
| Sending the documents to the workers, once | | 18.8 (18.6 to 21.1) | 12.8 (12.1 to 14.5) | 10.9 (10.8 to 10.9) | 11.4 (10.4 to 12.0) | 11.9 (11.6 to 25.6) |
| JSON.parse | 77.7 (76.1 to 80.4) | 64.7 (64.1 to 70.7) | 32.8 (31.7 to 33.4) | 17.3 (16.2 to 17.7) | 10.9 (10.5 to 11.0) | 6.19 (5.80 to 6.69) |
| RegExp, every match, `(the\|an?) [a-z]+` | 23.2 (23.0 to 23.4) | 24.6 (23.6 to 25.0) | 12.7 (12.3 to 12.7) | 6.56 (6.49 to 6.74) | 4.30 (4.09 to 4.31) | 2.65 (2.52 to 2.66) |
| RegExp, every match, `error` | 21.0 (20.7 to 21.2) | 21.8 (21.2 to 21.8) | 11.3 (11.0 to 11.4) | 6.01 (5.83 to 6.09) | 3.66 (3.48 to 3.78) | 2.23 (2.15 to 2.46) |
| RegExp, every match, `[a-z0-9.]+@[a-z.]+` | 41.3 (40.1 to 41.4) | 42.5 (41.7 to 42.8) | 21.9 (21.5 to 22.0) | 11.2 (11.1 to 11.2) | 6.72 (6.29 to 6.78) | 4.01 (3.87 to 4.07) |
| RegExp, every match, `"[a-z]+":` | 30.1 (29.9 to 30.3) | 31.5 (31.1 to 31.5) | 16.2 (15.9 to 16.4) | 8.52 (8.30 to 8.69) | 5.48 (4.89 to 5.50) | 3.12 (3.05 to 3.20) |
| RegExp, every match, `[A-Z][a-z]+ [A-Z][a-z]+` | 11.8 (11.8 to 11.9) | 12.5 (12.5 to 12.6) | 6.81 (6.54 to 6.85) | 3.67 (3.63 to 3.77) | 2.50 (2.36 to 2.58) | 1.65 (1.64 to 1.67) |
| RegExp, every match, `\d+\.\d+` | 16.8 (16.8 to 17.5) | 17.3 (17.2 to 17.4) | 9.83 (9.59 to 9.99) | 4.97 (4.80 to 4.99) | 3.24 (3.09 to 3.28) | 2.08 (2.07 to 2.11) |
| RegExp, every match, `\d\d\d\d-\d\d-\d\d` | 8.30 (8.00 to 8.60) | 9.04 (9.03 to 9.15) | 4.91 (4.80 to 4.94) | 2.75 (2.69 to 2.77) | 1.91 (1.81 to 2.01) | 1.34 (1.34 to 1.39) |
| RegExp, every match, `(the\|an?\|some) [a-z]+(ing)?s?` | 27.7 (27.1 to 28.6) | 29.1 (28.8 to 29.4) | 15.1 (14.4 to 15.5) | 7.73 (7.68 to 7.80) | 4.92 (4.78 to 5.10) | 3.32 (3.05 to 3.51) |
| RegExp, every match, `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? ` | 28.2 (28.0 to 30.1) | 30.1 (29.6 to 30.4) | 15.5 (15.4 to 15.5) | 7.95 (7.90 to 8.05) | 5.12 (4.93 to 5.16) | 3.18 (3.05 to 3.55) |
| RegExp, every match, `([a-z]+)+x` | 2,114 (2,102 to 2,336) | 2,201 (2,105 to 2,227) | 1,094 (1,077 to 1,133) | 559 (545 to 561) | 279 (277 to 288) | 136 (134 to 138) |

- One worker takes about what the page's own thread takes, so a request's messages cost little. Sending the documents takes 11 to 19 ms, once.
- With 4 workers RegExp takes 3.7 to 11.2 ms on the six patterns of up to 8 states, about what the search step takes on the GPU when searches follow each other, 7 ms, and with 8 workers it takes less, 2.5 to 6.7 ms. After a pause the GPU takes 17 to 21 ms, which 2 workers match or beat on five of those six patterns.
- JSON.parse in 16 workers, 6 ms, takes 3 times the highlighter's pass back to back, 2.2 ms, and less than the pass after a pause, 8.3 to 9.3 ms. It only says whether a document is valid.
- The pattern that backtracks still takes 136 ms with 16 workers, 6 to 19 times the GPU's 7 to 21 ms.
- Not measured: the table loop in workers, workers after a pause, and how many cores a visitor's machine has.
- Since October 14, with bit-emit.ts's shaders, a search on the GPU takes 4.5 to 5.2 ms back to back and 11 to 16 ms after a pause, for a pattern of any size. So the GPU's back to back time lies between what 4 workers take, 2.8 to 11.2 ms on the nine ordinary patterns, and what 8 workers take, 1.9 to 6.7 ms, and its time after a pause is in the range of 2 workers, 4.9 to 21.9 ms. The pattern that backtracks takes 136 ms with 16 workers, 9 to 30 times the GPU's time.

The same page timed four ways to count a pattern's matches on one thread, and the table loop written two ways, ms for 100,000 documents:

| Pattern | Matches | `text.match(pattern)` with the `g` and `u` flags, as measured above | The same without the `u` flag | A loop of `pattern.test(text)` | A loop of `pattern.exec(text)` |
| --- | --- | --- | --- | --- | --- |
| `(the\|an?) [a-z]+` | 42,356 | 23.2 (23.0 to 23.4) | 23.3 | 22.3 (22.3 to 22.6) | 23.5 (23.4 to 23.5) |
| `error` | 12,482 | 21.0 (20.7 to 21.2) | 20.8 (20.2 to 21.2) | 20.5 (20.0 to 20.5) | 20.8 (20.2 to 21.1) |
| `[a-z0-9.]+@[a-z.]+` | 14,555 | 41.3 (40.1 to 41.4) | 38.2 (37.2 to 38.4) | 40.6 (40.3 to 40.6) | 40.6 (40.0 to 41.0) |
| `"[a-z]+":` | 1,037,641 | 30.1 (29.9 to 30.3) | 30.0 (29.8 to 30.2) | 31.0 (30.9 to 31.1) | 36.4 (36.3 to 36.6) |
| `[A-Z][a-z]+ [A-Z][a-z]+` | 23,862 | 11.8 (11.8 to 11.9) | 11.6 (11.5 to 11.6) | 11.6 (11.4 to 11.7) | 12.0 (11.8 to 12.1) |
| `\d+\.\d+` | 254,601 | 16.8 (16.8 to 17.5) | 16.0 (16.0 to 17.1) | 15.6 (15.4 to 15.7) | 17.7 (17.4 to 17.7) |
| `\d\d\d\d-\d\d-\d\d` | 27,809 | 8.30 (8.00 to 8.60) | 7.40 (7.30 to 7.80) | 7.90 (7.70 to 8.20) | 8.30 (8.20 to 8.40) |
| `(the\|an?\|some) [a-z]+(ing)?s?` | 46,068 | 27.7 (27.1 to 28.6) | 28.2 (27.3 to 28.3) | 26.8 (26.4 to 29.3) | 28.0 (27.4 to 30.4) |
| `(the\|an?\|some\|this\|that\|these) [a-z]+(ing\|ed\|s)? ` | 40,611 | 28.2 (28.0 to 30.1) | 28.3 (26.7 to 29.1) | 27.6 (27.1 to 28.3) | 28.5 (27.9 to 29.9) |
| `([a-z]+)+x` | 69,548 | 2,114 (2,102 to 2,336) | 2,162 (2,123 to 2,274) | 2,160 (2,151 to 2,205) | 2,170 (2,099 to 2,182) |

| JSON.parse | Table loop, every document's kinds into one array of 512 | Table loop, into an array of every document's kinds |
| --- | --- | --- |
| 77.7 (76.1 to 80.4) | 123 (121 to 123) | 122 (121 to 122) |

- The four ways give the same counts. `match` builds an array of the matched strings, and the loops build nothing or one array per match, and the times differ by 12% or less, except that the loop of `exec` takes 20% more on the pattern with a million matches.
- The table loop takes the same time either way, so the 119 and 146 ms of the two earlier pages aren't a difference in what the loop writes.

## What fit well

- **The same compiled program runs on three backends from one list of rows.** `flattenProgram` feeds the WGSL emitter and the JavaScript generator, and both give the executor's bits: every one of 7.3 to 7.6 billion values per run from the GPU in the first stage, with no guards.
- **docs/patterns.md's pattern for repeated work carried over to the GPU without changing either program's arithmetic.** A step is built with the same builder calls, for regex search with data-program.ts's own `emitClasses` and `createStepAnd`, and the loop gives the values of the program with every position written out: on the executor, as generated JavaScript, through the interpreter, and on the GPU.
- **The compile time went from the limit to a detail.** Regex search at 8 states compiles in 0.1 s where the same work written out took 107 to 130 s, and the highlighter in 0.04 s where it took 2.2 to 2.3 s. A shader's length is now the work of one position, whatever the capacity. bit-emit.ts's search shaders compile in 0.02 to 0.03 s at each of the three sizes.
- **The search got 1.7 to 180 times faster with no change to the program.** Which values are bits, which reads share an index, and that two gating bits are never both 1 are all in the compiled program or provable from it, so a second code writer could write the reads of one gate as one AND of two words, and every value stayed the same. The program is still what the CPU runs, and still weighted sums, ReLU gates and table reads.
- **A program that holds only integers needs no guards.** Both loops are emitted without them. Every value is a bit, a small index, a code point or a count, so any order and any fusing of the operations gives the same bits.
- **An index read is one buffer read**, where codegen's gathers write a `switch` with one case per candidate.
- **Compiling for fewer outputs removes the operations nobody reads.** 7,186 of the highlighter's 15,928 operations remain for the first stage's summary, with no change to the highlighter.
- **One register put the first error's kind on the GPU**, which the first stage's shader couldn't return.
- **The display kinds as a buffer between two programs.** The highlighter's per position output is the search's second input, so "matches inside string values" costs 3 more operations per position and nothing crosses to JavaScript.
- **A pattern as data makes a keystroke cheap to send.** A search uploads 4 KB of cells at 8 states and 66 KB at 32, with bit-emit.ts's shaders the same cells again as 1 to 4 KB of packed words, and nothing per document. JavaScript's part, compiling the pattern and writing its cells, takes 0.03 to 0.1 ms.
- **Output groups and the window keep the readback small**: 400 KB of match counts for 100,000 documents, and 131 KB of marks or kinds for the 64 on screen.
- **Documents as a pure function of a seed and an index** made the pages, the tests and the report agree on the texts without passing files around.
- **Every value from the GPU could be checked**, about a billion per run, because a plain JavaScript loop over the same automaton gives the expected counts of 100,000 documents in half a second.
- **One unattended command per run**, which compares everything it reads back and records the load average next to the timings.

## What got awkward

- **A search step's cost grows with the square of the state capacity, and with one f32 statement per operation it grew faster than that on this GPU.** A position is 240, 664 and 2,280 operations at 8, 16 and 32 states, and with loop-emit.ts's shaders 100,000 documents take 7.04, 63.8 and 871 ms, i.e. 9 and 124 times the 8-state time for 2.8 and 9.5 times the operations. The hand-written kernel takes 3.38, 3.69 and 4.85 ms, since a row of 32 states is one word there, and since October 14 bit-emit.ts's shaders come close, at 4.6, 4.7 and 5.2 ms. All of these are times of searches that follow each other. On the CPU the cost still grows with the capacity, 0.14, 0.34 and 1.8 ms per document.
- **One document's operations run one after the other in one GPU thread**, so a pass has a floor that the document count doesn't lower: with loop-emit.ts's shaders 100 documents take 1.0 ms at 8 states, 7.4 ms at 16 and 77 ms at 32, nearly what 10,000 take. With bit-emit.ts's the floor is 0.6 to 1.9 ms at every size.
- **RegExp is fast.** It takes 0.08 to 0.43 µs per document on ordinary patterns, 0.3 to 1.4 ns per code point, so 100,000 documents take 8 to 43 ms on one CPU core, and 1.3 to 6.7 ms in 8 to 16 workers. Only a pattern that makes it backtrack is slow.
- **The comparison with one thread flatters the GPU.** A GPU pass uses every GPU thread, and each plain JavaScript baseline one of 18 cores. With workers, plain JavaScript scales almost with their number up to 8, e.g. JSON.parse takes 77.7, 32.8, 17.3, 10.9 and 6.2 ms on 1 thread and in 2, 4, 8 and 16 workers.
- **The order of a stage's statements changed the time by up to 2.3 times**, and stopping the loops at the text's end made a search slower although it runs 40% fewer positions, 3 times slower with bit-emit.ts's shaders. Neither follows from WGSL, so another GPU compiler may behave differently.
- **The highlighter's pass got nothing from the second code writer.** Its step reads tables of whole numbers, one read per value, so there is no row of bits to put into a word, and integer statements weren't faster than f32 statements here.
- **Two code writers for one kind of program.** loop-emit.ts stays for the highlighter and as the plain form to compare with, and bit-emit.ts repeats about 75 of its lines for the shader around the stages.
- **The highlighter's step is larger than a written out position.** One step serves every position, so every position gets position 511's sign cascade, 17 operations instead of 2: 18,961 operations per document instead of 7,698.
- **A mask of display kinds is coarser than JSON's structure.** An escape inside a string value is its own kind, so a match of `'strings'` can't cross `\n`, and an escape inside a key is the same kind as one inside a value.
- **The kinds are f32 values, 2 KB per document**, next to the 2 KB of cells: 410 MB on the GPU for 100,000 documents, and JavaScript takes 44 ms to write the cells.
- **The shader of the first stage takes about 2 s to compile**, and I found no cache that shortens a second process's compile. The loops made that stage's shaders unnecessary for a demo.
- **One evaluation's time depends on what the GPU did just before**, in both stages: 2 to 3 times as long after a pause of 200 ms or more.
- **Measuring changed the measurement.** Comparing 51.2 million values takes 54 ms, and that pause made the next evaluation slower, so the first stage's first batch of runs was discarded.
- **`depthExceeded` and the matching bracket aren't on the GPU.** The first is `firstErrorKind === tooDeep`, which a page computes. The second reads among computed values, and belongs to one editor, not to a batch.
- **A device binds 128 MiB per storage buffer unless the page asks for more**, i.e. 65,408 documents.
- **JSON.parse's and RegExp's times depend on the documents and the pattern**, so every comparison with them is a range.
- **The repo's lint has no exception for generated code**, so generated-js.ts calls `Reflect.construct(Function, [source])`.
- **The WGSL interpreter grew into a small language**: `var`, `for`, `if`, bit operators and several buffers, about 380 lines that have to follow both emitters, and 80 more for bit-emit.ts's integer statements. codegen's interpreter couldn't be edited tonight, so it's a changed copy.
- **Three measurement pages share less code than they should.** gpu/measure.ts holds the sampling helpers for the third page, and the first two still have their own copies, because they were running while the third was written.

## Not done

- A cheaper step for 16 and 32 states stood here, with two ideas that weren't tried: a table read by the bytes of the state word, or the reads of one sum as an inner loop in the shader. It is done since, another way and without another step: bit-emit.ts writes the unchanged step's reads as ANDs of words, see [The second code writer](#the-second-code-writer-bit-emitts).
- bit-emit.ts's shaders on a million documents, on bytes instead of one f32 per code point, and on any other loop program of the repo than the two here, see [million/README.md](million/README.md#what-is-still-unknown).
- The hand-written kernel as a searcher. It has no mask and no marks, and it isn't the repo's program.
- The matching bracket on the GPU.
- Any GPU other than an Apple M5 Max through Metal, any browser other than Chrome 155, and a page with a real display. Every run was headless.
- Packing a document or its kinds into fewer bytes, e.g. 4 bits per display kind, which would cut the kinds from 205 MB to 26 MB for 100,000 documents.
- More than 512 positions per document, and more than 100,000 documents. One dispatch holds 4,194,240 documents at a workgroup of 64.
- A CPU runner whose copies are generated statements too, see [Where the CPU's time goes](#where-the-cpus-time-goes).
- The table loop in several workers, and workers after a pause. JSON.parse and RegExp in 1 to 16 workers are in [JavaScript in several workers](#javascript-in-several-workers).
- Other workgroup sizes than 64.
- Regex search's forms (b) and (c) as loops. Form (b) builds the pattern into the program, so every pattern would be a new shader.
- Uploading only the documents that changed, e.g. one edited document of 2,052 bytes, which `store.write(cells, 1, index)` already allows. The searcher takes its documents once.
- Whether a reload in the same Chrome process, or a page that stays open, compiles the same shader faster. A new Chrome process with a new profile folder does, when an earlier process compiled the same shader text: 3 to 5 ms instead of 20 to 22 ms for bit-emit.ts's search shader of 8 states ([million/README.md](million/README.md#the-timings)).
- A second Chrome process for the review's checks at the limits and over 100,000 documents, which ran once each, and a device that grants less than the documents need, where `createGpuSearcher` throws with a message that no browser run has shown.

## Entry points for a demo page

| What | Where |
| --- | --- |
| The module for a page | `createGpuSearcher(device, texts, options)`, `createCpuSearcher(texts, options)` and `bufferBytesFor(documentCount)` in searcher.ts, with the types `Searcher`, `SearchRequest`, `SearchResult` and `Validation`. `requestBatchDevice(bytes)` in gpu/host.ts gives the device |
| The same answers in plain JavaScript, for a comparison on the page | `createPlainSearch(texts)` in plain-search.ts: `validation`, `kinds`, `validateMs`, and `search(pattern, scope)` |
| Documents | `documentAt(seed, index)`, `generateDocuments(count)`, `describeDocuments(documents)`, `defaultSeed` in documents.ts |
| Names for what the searcher returns | `errorKinds` and `displayKind` in src/json-highlighter/kinds.ts, and `searchScopes` and `searchableKinds(scope)` in search-step.ts |
| A loop program | `LoopProgram`, `createStage`, `createLoopRunner(loop, backend)`, `describeLoop(loop)` in loop-program.ts, and `emitLoopWgsl(loop)` in loop-emit.ts |
| The same loop program with integers and packed words | `emitBitLoopWgsl(loop)` in bit-emit.ts, which returns `emitLoopWgsl`'s module with `packedCells` and `rules`, and `packWords(packedCells, shared)` for the buffer `packed_words`, which `createProgramRunner` fills by itself |
| The two loop programs | `buildJsonLoop()` in json-step.ts, and `buildSearchLoop(capacity, {positions, cellsPerDocument, masked, stopAtLength})` in search-step.ts, with `writePattern(shared, compiled)` and `writeScope(shared, scope)` |
| The programs with every position written out | `buildBatchPrograms()` in program.ts, `buildDataSearch(capacity)` in lab/regex-search/data-program.ts, and `buildMaskedSearch(capacity)` in search-step.ts |
| A shader from any compiled program without gathers | `emitWgsl(program, {instanceCells, outputGroups, guard, workgroupSize})` in emit.ts, and `packSharedValues(shader, source)` for its shared buffer |
| The GPU | `requestBatchDevice(largestBufferBytes)`, `createDocumentStore(device, cellsPerDocument, capacity)`, and `createProgramRunner(device, shader, sharedValues, store, salt, {inputs, windowCapacity})` with `evaluate`, `read`, `writeShared`, `outputBuffers`, `compileMs` and `destroy`, in gpu/host.ts |
| A shader's text on the CPU, for tests | `createWgslInterpreter(code)` in wgsl-interpreter.ts |
| The GPU searcher in tests, without a GPU | `createGpuSearcher(createInterpretedDevice(), texts)`, with interpreted-gpu.ts's device, whose compute pass is that interpreter |
| Other baselines | `highlightWithTables(text, kinds, kindsOffset)` in table-loop.ts, `createBitRowSearch(bitRowTables(compiled, states), positions)` and `bitRowKernel(states, positions, cellsPerDocument)` in bit-rows.ts, `emitJavaScript(program, options)` in generated-js.ts |

What a page has to do with the searcher:

- **Ask for a device that holds the documents.** `requestBatchDevice(bufferBytesFor(count))` asks for buffers of the size the batch needs, and `searcher.limits.maxDocuments` says how many fit. A device from `requestDevice()` without limits binds 128 MiB per buffer, 65,408 documents. 100,000 documents take 410 MB on the GPU, so 20,000 to 50,000 is a safer default.
- **Without WebGPU, run `createCpuSearcher` in a worker**, with `highlight: 'whenFirstRead'` and a few documents per search, as demo-worker.ts does. `searcher.selfCheck(300)` compares a GPU's values with the CPU's: 11 searches on every program that holds them, in about 6 s, nearly all of it for the generated JavaScript that the GPU's values are compared with, at 16 and 32 states. A searcher with `stateCapacities: [8]` checks 9 of the searches on one program. The demo page doesn't run it, since both programs hold only integers, see [The demo page](#the-demo-page).
- **Derive the request from the page's state in each frame**: when the pattern or the scope differs from the result on screen, `search({pattern, scope, window})`, and when only the window moved, `search({pattern, scope, window, documents: 'window'})` and `kinds(window)`. A request that resolves to `undefined` was replaced by a newer one. A result is an input of a later frame, never of the frame that asked for it.
- **Quote the time after a pause.** A page that searches once per keystroke gets the columns "after a pause" of the tables above, 2 to 3 times the back to back time.
- **Show plain JavaScript's time next to the GPU's instead of claiming a faster search.** `createPlainSearch(texts)` gives the same answers on one thread, in 13 to 24 ms per search of 100,000 documents on each string value and 8 to 43 ms on the whole text, for ordinary patterns. At a keystroke the GPU's 11 to 16 ms is less than that for most patterns and more for some, and JavaScript in 8 workers takes less than both. What the page can claim is the repo's own programs at that speed: the same search takes 14 s on the CPU.
- **A larger program costs little on the GPU and much on the CPU.** `result.states` is the capacity, 8, 16 or 32. With bit-emit.ts's shaders a search of 100,000 documents takes 4.6, 4.7 and 5.2 ms at the three when searches follow each other, and 11 to 13 ms after a pause, and creating the GPU searcher compiles all three, so no search waits for a compile. On the CPU a search takes 2.4 and 13 times as long at 16 and 32 states as at 8, and the first search on a larger program builds it first. The demo page shows each search's time next to RegExp's for the same pattern.
- **A mark** is 0 outside a match, 1 inside one and 2 at a match's first code point, 512 per document of the window, indexed by code point, and so are the kinds. A character past U+FFFF is one code point and two UTF-16 units.

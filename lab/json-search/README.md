# The JSON highlighter over many documents on the GPU

## What it is

Cheng asked: "I was wondering if there's a point where regex search or json highlighter, or a combination of these into the same app, is clearly more performant from the gpu parallelism? Then we can make a demo where we search a ton of jsons or something". This folder is the JSON half of the answer. The regex half and the demo page come after it and aren't here.

The JSON highlighter ([src/json-highlighter](../../src/json-highlighter/README.md)) is one fixed numeric program: JavaScript writes up to 512 code points into cells, and the program returns what each character is shown as, where the first error is, and whether the text is valid. One document takes 80 to 90 µs on the CPU executor in Chrome, which runs every one of the program's operations whatever the text, and a round trip to the GPU alone takes 0.6 ms or more, so one document is no case for a GPU. Many documents are: every document runs the same operations, and no document reads another one's values.

So this folder emits the compiled program as one WGSL compute shader that runs every operation for one document, and one WebGPU compute pass runs that shader once per document, for up to 100,000 documents. It measures the pass against JSON.parse, two plain JavaScript highlighters, generated JavaScript of the same program, and the CPU executor, all in the same page of headless Chrome, and compares every value the GPU returned with the executor's.

The answer in plain words is in [Is the GPU clearly faster?](#is-the-gpu-clearly-faster).

## How to run it

From the repo root:

```sh
bun test lab/json-search                         # 17 tests in 1 file, about 7 seconds, no GPU
bunx tsgo -p lab/json-search                     # type-check, including gpu/
bunx oxlint --type-aware lab/json-search         # lint
bun lab/json-search/report.ts sizes              # both programs and their shaders, with and without guards
bun lab/json-search/report.ts documents          # the 100,000 documents' shapes, defects and lengths
bun lab/json-search/report.ts examples 8         # the first 8 documents' texts
bun lab/json-search/gpu/run.ts --mode main --profile <new folder> --out <file.json>    # every timing below in one fresh headless Chrome, about 8 minutes
bun lab/json-search/gpu/run.ts --mode check --profile <new folder> --out <file.json>   # both shaders with and without guards, about 1 minute
```

`run.ts` starts its own headless Chrome with WebGPU on a profile folder that no other Chrome uses, serves the page with cross-origin isolation headers so that `performance.now()` reads in steps of 5 µs, and ends only the Chrome it started. `--port` and `--devtools-port` choose its two ports, 4421 and 9421 by default. The raw results are in results/, and `bun lab/json-search/gpu/summarize.ts --main lab/json-search/results/gpu-main-1.json,lab/json-search/results/gpu-main-2.json,lab/json-search/results/gpu-main-3.json --checks lab/json-search/results/gpu-check-1.json` prints every table of [Measured results](#measured-results) from them.

| File | What it holds |
| --- | --- |
| `emit.ts` | The emitter: a compiled tensor program as one WGSL compute shader, one invocation per document, with index reads |
| `wgsl-interpreter.ts` | A strict interpreter for the WGSL that emit.ts writes, so the shader text is tested on the CPU |
| `program.ts` | The highlighter compiled for two sets of outputs, a document's cells, and the pieces a host needs for each set |
| `documents.ts` | The generated documents: 7 shapes, 16 labeled defects, a pure function of a seed and an index |
| `table-loop.ts` | A plain JavaScript highlighter over the program's own tables, the fastest JavaScript baseline here |
| `generated-js.ts` | The program's operations as JavaScript statements, a CPU baseline without the executor's loop over layers |
| `check.ts` | The executor's outputs for many documents, and the count of values that differ |
| `gpu/host.ts` | The WebGPU host: a device with the buffer limits it needs, a store for the documents' cells, a runner per shader with compile time, evaluation and readback of chosen documents, and a self check |
| `gpu/page.ts`, `gpu/run.ts`, `gpu/summarize.ts`, `results/` | The measurement page, the headless Chrome harness, the tables, and the raw results |
| `report.ts` | Sizes and the documents' distribution, without a GPU |
| `json-search.test.ts` | The tests |

## What was built

### The emitter

`emitWgsl(program, {instanceCells, outputGroups, guard})` takes what `circuit.compileTensorProgram` returns and writes one `let` per operation, in the layers' order. JS for what one invocation does: `for (const operation of program) values[operation.position] = operation.run(values)`, with the document's cells and the shared table as the first values. It starts from [lab/ui-exploration/codegen/wgsl.ts](../ui-exploration/codegen/wgsl.ts), whose `flattenProgram` never reads a layer's index reads, so an index read would silently become a constant 0 there. Three things are new:

- **Index reads.** The highlighter's batch programs are 64% to 67% index reads, e.g. the class of a code point, `classes[codePoint + 1]`, is one read. A read is two statements: the index, `let p4576: i32 = i32(floor(1.0f + c0));`, and the candidate at the clamped index, `let v4576: f32 = shared_values[u32(514i + clamp(p4576, 0i, 128i) * 1i)];`. A side with the `'zero'` rule wraps the read in a `select`, e.g. `select(<read>, 0.0f, p5095 > 424i)`. Both rules on both sides are covered. The candidates must be source cells at evenly spaced positions, which is how the compiler stores a run of cells: shared cells, e.g. a table, or one document's own cells.
- **Output groups.** Each group of outputs gets its own buffer, e.g. 3 summary values per document in one and 512 display kinds per document in the other. A page can then read back the summary of every document and the kinds of only the documents on screen, each as one contiguous copy.
- **Long sums continue in a new statement** every 32 terms, e.g. the count of error-free positions is a sum of 513 terms in 17 statements, so no expression nests deeply.

An index read whose candidates are computed per document throws, e.g. the highlighter's `firstErrorKind` reads one of 513 computed error kinds. One `let` per value can't be indexed, and a 513-case `switch` or an array per invocation wasn't tried.

The `guard` option is codegen's: `'max'` wraps every product whose weight isn't a power of two and every partial sum in `max(x, lowest)`, with `lowest` read from a buffer, which is what keeps Apple's Metal compiler from fusing `a + w * x` and from regrouping sums. The highlighter holds only integers below 2^24 and no boolean atoms, so each of its products and partial sums is exact in any grouping, and its shaders are emitted with `guard: 'none'`. Its only values of 2^24 or more are 12 weights of a sign cascade at position 511, which multiply by a power of two.

### The programs

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

### The CPU baselines

All of them run in the measurement page, on the same documents as the GPU:

- **JSON.parse** in a `try`, for validity only. It accepts nesting past depth 16 and texts past 512 code points, which the highlighter reports.
- **reference.ts**, the plain JavaScript highlighter of [tests/json-highlighter/reference.ts](../../tests/json-highlighter/reference.ts), which the page imports as it is: a scanner and a parser with a real stack. It was written to be read next to JSON's grammar, not to be fast, e.g. it tests a character with `String.fromCodePoint` and `includes`.
- **The table loop**, table-loop.ts: one loop over the text that reads the program's own tables as typed arrays, with one bit per depth for the container kinds. It returns the display kinds, the first error's position and kind, and `truncated`, and is what I'd write for speed.
- **Generated JavaScript** of the same compiled programs, one statement per operation in functions of 128 operations.
- **The CPU executor** on the same compiled programs.

## Correctness checks

`bun test lab/json-search` runs 17 tests without a GPU:

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

## Measured results

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

display-all's evaluations after a pause follow a comparison of every value, so at 100,000 documents the GPU has been left alone for 54 ms more than the column says.

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

## Is the GPU clearly faster?

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
- When every evaluation uploads its documents, the GPU takes 66.6 ms for 100,000 documents, against 87.5 ms for JSON.parse and 119 ms for the table loop: 1.3 and 1.8 times less, from about 7,000 and 3,200 documents on. That isn't a clear win, and more than half of the 66.6 ms is JavaScript writing cells, not the GPU.
- The first evaluation waits for the shader to compile, about 2 s, and JSON.parse has checked 100,000 documents 20 times over by then.
- Reading every display kind back to JavaScript takes 13.7 ms for 100,000 documents, 9 times less than the table loop, but 206 MB per evaluation is nothing a page needs. Reading back what is on screen is the practical form.

**What this means for the JSON half alone.** A document's kinds and first error only change when its text changes, so once the documents are on the GPU and evaluated, the highlighter has nothing left to compute for them. For JSON alone the honest number is therefore the one with an upload: slower than JSON.parse below about 7,000 documents, about even at 10,000 (8.1 ms against 9.2 ms), and 1.3 times faster at 100,000. The condition where the GPU is clearly faster, documents that stay while something shared changes, is what a search adds: a new pattern is about a thousand shared cells, and every document's cells stay where they are. That is the regex half, which isn't measured here.

**What the numbers depend on.**

- The documents: JSON.parse and the JavaScript highlighters take longer for longer documents and stop early at an error, while the GPU runs all 7,186 operations for every document. These documents have a median of 300 code points, so shorter documents move every crossover up, and documents near 512 move it down. With fewer broken documents JSON.parse gets faster, down to 0.64 µs per document with none.
- The machine: one Apple M5 Max, one browser, headless. The shader compile time, the pause behavior and the exactness without guards may all differ on another GPU.
- The baselines are single-threaded JavaScript in the page. JavaScript in several workers wasn't measured.

## What fit well

- **The same compiled program runs on three backends from one list of rows.** `flattenProgram` feeds the WGSL emitter and the JavaScript generator, and both give the executor's bits: every one of 7.3 to 7.6 billion values per run from the GPU, with no guards.
- **A program that holds only integers needs no guards.** Every weight and bias of the highlighter is an integer, and every value stays below 2^24 except in one sign cascade, whose products are by a power of two. The check run's shaders with guards gave the same values, and took 4.0 s and 5.2 s to compile instead of 1.8 s and 2.3 s.
- **An index read is one buffer read.** The highlighter's tables stay in one shared buffer of 18 KB, and a read costs a `floor`, a `clamp` and a load, where codegen's gathers write a `switch` with one case per candidate.
- **Compiling for fewer outputs removes the operations nobody reads.** 7,186 of the full program's 15,928 operations remain for the summary, with no change to the highlighter.
- **Output groups make the display kinds nearly free until they're read**: 1.9 ms more per 100,000 documents when only 64 documents' kinds leave the GPU.
- **Documents as a pure function of a seed and an index** made the page, the tests and the report agree on the texts without passing files around, and every run times the same 100,000 texts.
- **One unattended command per run.** A run takes 7.3 minutes, compares everything it reads back, and records the load average next to the timings.

## What got awkward

- **The shader takes about 2 s to compile**, 1.87 s for 11,814 statements and 2.34 s for 13,350, on every first use, and I found no cache that shortens a second process's compile. A demo has to show that it's compiling.
- **One evaluation's time depends on what the GPU did just before.** 0.76 ms becomes 2.7 ms and 3.75 ms becomes 11 ms after a pause of 200 ms, and a small dispatch per frame doesn't prevent it. A page reports honest numbers only if it says how it evaluates.
- **Measuring changed the measurement.** Comparing 51.2 million values takes 54 ms, and that pause made the next evaluation 2.3 ms slower. The first batch of runs didn't record the pause, and was discarded.
- **`firstErrorKind`, `depthExceeded` and the matching bracket can't be emitted.** Their index reads pick among 513 values computed per document, and a shader with one `let` per value has nothing to index. A page gets the kind of the first error from the table loop or the executor for the few documents it shows.
- **A document is 2,052 bytes of float32 cells for at most 512 code points.** 100,000 documents are 205 MB on the GPU and again in JavaScript, and writing those cells takes JavaScript 37 ms.
- **A device binds 128 MiB per storage buffer unless the page asks for more**, i.e. 65,408 documents, so 100,000 documents fail on a device from `requestDevice()` without `requiredLimits`.
- **JSON.parse's time depends on the documents.** A document where it throws costs 7 times a valid one, so the fraction of broken documents changes the crossover.
- **The repo's lint has no exception for generated code.** oxlint flags `new Function`, so generated-js.ts calls `Reflect.construct(Function, [source])`.
- **Two interpreters.** codegen's WGSL interpreter has no `floor`, `u32()`, `<` or `>`, and other agents were working in other folders, so wgsl-interpreter.ts is a changed copy instead of an edit.

## Not done

- The regex half, the combined program and the demo page.
- `firstErrorKind`, `depthExceeded`, `caretBracket` and `matchingBracket` on the GPU, e.g. with a 513-case `switch` or an array per invocation.
- Any GPU other than an Apple M5 Max through Metal, any browser other than Chrome 155, and a page with a real display.
- Packing a document into fewer bytes. The highlighter only reads a code point through the class table, which clamps at U+007F, so one byte per code point would give the same outputs with a quarter of the memory, the upload and the cell writing. It would be specific to this program: a search has to tell code points past U+007F apart.
- One position's step emitted once inside a WGSL loop, instead of 512 copies of it, which might cut the 2 s compile to tens of ms. It needs the builder's structure, which a compiled program no longer has.
- Other workgroup sizes than 64. text-walker's sweep found 64 and 256 about even and 16 slower.
- More than 100,000 documents. One dispatch holds 4,194,240 at a workgroup of 64, and 1,000,000 documents are 2 GB of cells.
- Uploading only the documents that changed, e.g. one edited document of 2,052 bytes, which `store.write(cells, 1, index)` already allows.
- JavaScript in several workers as a baseline.
- Whether a reload in the same Chrome process, or a page that stays open, compiles the same shader faster.

## Entry points for the next stages

| What | Where |
| --- | --- |
| A shader from any compiled program without gathers | `emitWgsl(program, {instanceCells, outputGroups, guard, workgroupSize})` in emit.ts, and `packSharedValues(shader, source)` for its shared buffer |
| The same program as JavaScript, e.g. as a baseline | `emitJavaScript(program, {instanceCells, outputGroups})` in generated-js.ts |
| The shader text on the CPU, for tests | `createWgslInterpreter(code)` in wgsl-interpreter.ts |
| The highlighter for a batch | `buildBatchPrograms()` in program.ts: per output set `program`, `instanceCells`, `outputGroups`, `sharedValues`, `evaluate`, `writeSource`, `emitShader`, `packShared`, `emitJavaScript`. `writeDocumentCells(cells, offset, text)`, `cellsPerDocument`, `summaryNames`, `kindCount` |
| Documents | `documentAt(seed, index)`, `generateDocuments(count)`, `describeDocuments(documents)`, `defaultSeed` in documents.ts |
| The GPU | `requestBatchDevice(largestBufferBytes)`, `createDocumentStore(device, cellsPerDocument, capacity)`, `createProgramRunner(device, shader, sharedValues, store, salt)` with `evaluate`, `writeShared`, `compileMs` and `destroy`, and `selfCheck(runner, program, cells, count)` in gpu/host.ts |
| Baselines | `highlightWithTables(text, kinds, kindsOffset)` and `tableLoopResult` in table-loop.ts, `highlightReference` in tests/json-highlighter/reference.ts |
| Comparing with the executor | `expectedOutputs(program, cells, count)` and `countMismatches(actual, expected, length)` in check.ts |

A search program can share a store with the highlighter when its per-document cells are the same 513 cells in the same order: both runners then read one upload, and a new pattern is `runner.writeShared(patternCells, offset)`.


# JSON search

A page that searches 100,000 generated JSON documents again at each keystroke, on the GPU, with two fixed numeric programs. A JSON highlighter reads up to 512 code points of a document and returns what each character is shown as, where the first error is, and whether the text is valid. A search reads a document and a pattern, both from cells, and returns the pattern's matches. Both are weighted sums, ReLU gates and table reads, written by builder code, and none of their weights is trained. One document is no case for a GPU: a round trip to the GPU alone takes 0.6 ms or more. Many documents are, since every document runs the same operations, and no document reads another one's values.

From the repo root:

```sh
bun start                         # the demo site, with the page at /json-search/
bun test tests/json-search        # 182 tests in 10 files, about 40 s, no GPU
bun run check                     # type-check and lint, with the rest of the repo
```

The measurement scripts, their pages, the raw results and every table that they print are in [lab/json-search](../../lab/json-search/README.md).

## The page

assets/json-search.html searches the documents at each keystroke and shows the search's own time next to RegExp's for the same search.

How it works:

- **The documents.** The page writes them itself, with documents.ts's generator and none of the documents that it breaks on purpose. So every document is valid JSON of up to 512 code points: a package manifest, a user record, a log event, editor settings, an order, a map feature or sensor readings, about 300 characters each, and which of them a document is follows from a hash of its index. Each document's characters go to the GPU once, as numbers.
- **The JSON highlighter** is one small step that runs at each of a document's 512 positions, once when the page loads, and says what each character is, e.g. part of a key or of a string value. The page uses that answer twice: for the colors of the document that it shows, and to let a search read only keys or only string values.
- **The search** is a second such step. A keystroke turns the pattern into tables of numbers, and the step runs over each document's positions, backward and then forward, and counts the matches. It reads the highlighter's answer for each character from the GPU's memory.
- **One pass runs every document.** No document reads another document's numbers, so the GPU runs all of them at the same time. JavaScript gets back one match count per document, which it paints on the map, and a mark per character for the one document that it shows.
- **The GPU's code is written from the programs, before any pattern exists.** searcher.ts holds the search program in three sizes, for patterns of up to 8, 16 and 32 states, and a pattern runs on the smallest one that holds it, e.g. `error` on the first and the Try list's date on the second. A code writer, bit-emit.ts, writes each size's shader, and the page compiles all three when it loads, so no keystroke waits for a compile and no pattern is compiled into GPU code. On the GPU the three sizes take nearly the same time ([two writers of GPU code](#two-writers-of-gpu-code)). On the CPU, behind the page's toggle, a search on the largest takes 13 times as long as on the smallest, which is why there are three.

What the page shows, from top to bottom, and how each number is measured:

- **The pattern field with two toggles.** All, Keys or String values is what the search reads. GPU or CPU is where the search program runs.
- **One line of numbers**, e.g. "10,559 of 100,000 documents match. This program: 13 ms on the GPU. Native RegExp: 21 ms." The line names both, because "16 s on the CPU" alone reads as the time of the browser's own RegExp.
  - The count is the number of documents with at least one match.
  - The time on the GPU runs from before the pattern is compiled until every document's count is copied out of the GPU's buffer: compiling the pattern, uploading its cells, the pass and the readback, `timings.totalMs` of the searcher's result.
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
- **It runs no self check when it loads.** Both programs hold only integers, which a GPU computes exactly in any order, and the tests and lab/json-search's runs on the GPU compare the two backends ([how to test](#how-to-test)). searcher.ts has `selfCheck` for a page that wants one.
- **It shows no documents with errors.** lab/json-search's measurements keep the generator's 1 broken document in 10.

Other states:

- **A window narrower than 720 px**, e.g. a phone, gets 20,000 documents, and the title says so. 100,000 documents take 410 MB on the GPU, and on the CPU the worker for it holds 448 MB for them. The page decides once, when it starts: a window that changes its width later, e.g. a phone turned on its side, keeps its documents, and the title keeps their count.
- **A GPU whose buffers hold fewer documents** than the page wants gets the count that fits, and the page says so, in its title and in a sentence, e.g. "One buffer of this GPU holds 65,000 documents, so the page searches 65,000 instead of 100,000." `?buffer=134217728` in the page's address asks the GPU for buffers of at most that many bytes, which shows this state on a machine that grants more.
- **A first visit**, where the GPU has no compiled shader in a cache: `?salt=7` writes that number into every shader's source, and with a number that no earlier load used the GPU compiles all four shaders from scratch. The number is a whole number from 0 to 4294967295, which a shader holds as a u32, and the page ignores any other.
- **A GPU that stops working** while the page is open: the page goes on with both programs on the CPU, and says why.
- **A worker that fails**, e.g. because its script didn't load: the page says so in the line's place and searches no more, also not on the GPU.

What it costs, on an Apple M5 Max in headless Chrome for Testing 155, in a window of 1440 by 900 px with 100,000 documents: the documents are ready to search 0.54 s after the navigation, 0.32 s of which is writing them, and the first search's answer is painted after 0.56 s. A search takes 11 ms while typing, as the line shows it, and 12 to 15 ms after a pause of 200 ms, depending on which of the three programs the pattern runs on. Native RegExp takes 8 to 28 ms for the same eight ordinary patterns on one thread. The same search on the CPU takes 13 s, after 9 s for the highlighter at the first search. The page's JavaScript holds 140 MB at rest and 588 MB after a search on the CPU. [The demo page's times](../../lab/json-search/README.md#the-demo-pages-times) has the tables, and [Is the GPU clearly faster?](../../lab/json-search/README.md#is-the-gpu-clearly-faster) the comparison with RegExp, with JSON.parse and with JavaScript in several workers.

## What the highlighter shows

Each of a document's first 512 code points gets one display kind: whitespace, punctuation, string, key, escape, number, literal or error, and a cell past the text's end gets `pastEnd` (highlighter/kinds.ts). A document's summary is `valid`, `firstErrorPosition`, `firstErrorKind`, e.g. `expectedColon` or `badNumber`, and `truncated`. Three rules go past JSON's grammar:

- **The first error's position** is the first code point at which the text stops being the start of a valid JSON text, or the text's length when the text is such a start but isn't complete, e.g. 3 for `[1 2]` and 2 for `[1`.
- **After a tokenizer error**, e.g. the `x` of `[x]` or the `1` of `01`, the rest of the line is shown as an error, and tokenizing starts again after the next line feed, so later lines keep their colors.
- **A string is shown as a key** when the grammar accepts it in a key position before the first error. A key after the first error is shown as a string.

tests/json-search/highlighter/reference.ts implements these rules as a scanner and a parser, and the tests compare the program with it ([how to test](#how-to-test)).

## What the search finds

From a scan position, the longest non-empty match that starts there is reported, and the scan continues at its end. When no match starts there, the scan moves one code point on. So the search finds every non-overlapping, non-empty match, leftmost and then longest. E.g. `a|ab` on `xabx` finds `ab`, where JavaScript's own `String.prototype.match` returns `a`, and `a*` on `baab` finds `aa` and never reports an empty match. RegExp takes the first alternative that matches, so its count can differ from the program's, e.g. `a|abab` finds 2 matches in `xabab` where the program finds 1. The page's RegExp time is therefore a baseline and not a check. On the patterns that lab/json-search measured, the page's among them, the two counts are equal for every document.

The pattern language is a subset of JavaScript's RegExp syntax with the `u` flag: literal code points, `.`, which doesn't match `\n`, `\r`, U+2028 or U+2029, `\d`, `\w`, character classes with ranges and negation, e.g. `[a-z_]` or `[^0-9]`, `?`, `*`, `+`, `|` and groups. Everything else, e.g. `*?`, `{2}`, `^` or `(?:`, throws a `PatternSyntaxError` with its position. regex/pattern.ts compiles a pattern into an automaton with one state per character or class that the pattern reads, plus one, e.g. `error` has 6 states and `connection reset` has 17, and into character classes, i.e. sets of code points that every step reads the same way. A pattern that needs more than a program holds gets a named message instead of a wrong answer, e.g. "the pattern needs 33 states, and the program holds 32" ([a fixed maximum with a named fallback](../../docs/behavior-choices.md#a-fixed-maximum-with-a-named-fallback)).

A search can read only some kinds of characters, e.g. string values, and a match then lies inside one run of such characters. The scopes are sets of the highlighter's display kinds: `'everything'`, `'strings'` for the characters shown as string values, with their quotes, `'keys'`, `'stringsAndKeys'`, or any list of kinds, e.g. `[displayKind.number]`. An escape such as `\n` is a kind of its own, so no match of `'strings'` crosses one, and a key after the first error is a string ([what the highlighter shows](#what-the-highlighter-shows)). The characters are read as typed: with `'everything'` the escape `\u00e9` is 6 characters, and with `'strings'` it isn't read at all.

## How the two programs work

### A document's cells

A document's cells are its first 512 code points, -1 after the text, and the text's length in code points: 513 float32 values, 2,052 bytes, so 100,000 documents are 205.2 MB (`writeDocumentCells` in program.ts). A surrogate pair is one code point. The tables of a program and the cells of a pattern are the same for every document and sit in one shared buffer.

### A program as a loop over positions

Both programs do one position's work at every position of a document. Written out once per position, a program grows with the capacity, and so does its shader: one shader with a statement per operation of the search at 8 states and 256 positions, 91,774 statements, took 107 to 130 s to compile ([the three stages](../../lab/json-search/README.md#the-question-and-the-three-stages)). [docs/patterns.md](../../docs/patterns.md#a-loop-over-items-that-mixes-per-item-work-with-values-carried-to-the-next-item) has the pattern for that: the work of one item is ordinary builder code, compiled once as its own small program, and it runs once per item.

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

`createLoopRunner(loop, backend)` runs a loop program on the CPU, on the executor or as generated JavaScript. `emitLoopWgsl(loop)` and `emitBitLoopWgsl(loop)` write it as one shader: each stage's statements once, inside a `for` loop, a register as a `var`, and a field as an array of the function. So a shader's length is the work of one position, whatever the capacity, and the page's four shaders compile in 0.02 to 0.05 s each. A shader takes the first document to run and the window of documents that get per position outputs as parameters, so one evaluation can run every document and return the marks of the 64 on screen, or run only those 64 after a scroll.

### The highlighter's step

json-step.ts builds one position's work from the tables of highlighter/tables.ts and from values carried from the position before:

1. The character's class, read from a table of 129 cells.
2. The tokenizer's event, e.g. `stringStart` or `badNumber`, and its next state, each as one read at (state, class).
3. The depth after the character, a running total of +1 and −1.
4. The container kinds as one integer, a running total of ±2^depth for braces. Whether the innermost container is an object is one comparison of that integer with 2^(depth − 1) ([a stack of one bit per level](../../docs/patterns.md#a-stack-of-one-bit-per-level)).
5. The grammar between tokens, a state machine of 8 states over (token, depth class, container kind), as one read.
6. The display kind, one read at (event, grammar state), and the error kind of this position.

The tokenizer's state, the depth, the container code, the grammar's state, the count of positions in the error state and the first error's kind are registers, and the display kinds are an output per position. The step for positions 0 to 511 is 37 operations, 12 of them table reads, and an end step for position 512 is 17 operations: it handles the end of the text, or the 513th code point of a longer one, and gives `valid`, `firstErrorPosition`, `firstErrorKind` and `truncated`. A document is 18,961 operations. What follows from running one step at every position:

- **`inObject` is a sign cascade of 17 operations.** One step serves every position, so the container code has the range of position 511, where its difference with a level weight can reach 2^24, and `emitCompare` builds a sign cascade instead of a 2-operation integer bit. Both are exact comparisons of integers.
- **The first error's position is a count.** The grammar's error state never goes back, so the positions before it are 513 minus the positions in it ([the count](../../docs/patterns.md#findindex-when-the-test-flips-once-along-the-items)).
- **The first error's kind is a register.** The step adds the position's error kind where the grammar enters the error state, which happens at most once.

Two errors are named fallbacks: the highlighter reports `tooDeep` at the 17th nested opener and `tooLong` at code point 512, for documents that are valid JSON.

### The search's step

The search runs two passes over a document's code points, since a longest match is only known after reading past its end, and a program can't go back ([a loop whose decision needs later input](../../docs/patterns.md#a-loop-whose-decision-needs-later-input)). The automaton is data: its transition matrix for each character class, its accepting states and the class of every code point sit in cells, so a new pattern writes cells and changes no program. search-step.ts builds one code point's work with regex/data-program.ts's `emitClasses` and `createStepAnd`. The stages:

| Stage | Runs | What it computes | Operations at 8, 16 and 32 states |
| --- | --- | --- | --- |
| start | once | `notFinish[s] = !accepting[s]`, the reverse pass's bits before the last code point | 8, 16, 32 |
| reverse | from the last position down | the code point's class, `notReach[s]`, and the next `notFinish[s]` | 148, 356, 1,156 |
| forward | from position 0 up | whether a match continues or starts here, the next `reached[s]`, and the match count so far | 92, 308, 1,124 |

The class and the `notReach` bits of every position are fields that the forward loop reads back, and the carried bits and the match count are registers. A step takes one table read per pair of states, `transitions[class][from][to] && bit`, so a document of 512 positions is 122,888 operations at 8 states, 339,984 at 16, and 1,167,392 at 32.

The outputs are the match count of every document, and for the documents of the window a mark per code point: 0 outside a match, 1 inside one, and 2 at a match's first code point. A character past U+FFFF is one code point and two UTF-16 units.

A new pattern writes 1,097 cells at 8 states, 4,177 at 16 and 16,481 at 32: `built.writePattern(shared, compilePattern(pattern))` writes them, and the runner uploads them before the pass. JavaScript's part of a search, compiling the pattern and writing its cells, takes 0.03 to 0.1 ms.

`stopAtLength` makes both loops stop at the text's end. A cell past the end holds -1, whose class has no steps, so the outputs are the same. It was slower on the GPU, e.g. 13.3 ms against 4.4 ms at 8 states, so the GPU searcher leaves it off, and it saves the share of positions that hold no text on the CPU, 40% for the page's documents, so the CPU searcher turns it on.

With `masked`, the reverse step also reads the display kind of its code point, and nine cells that say which kinds the search reads. A code point of another kind is replaced by -1, the value of a cell past the text's end, which no step reads:

```ts
const bit = circuit.indexReadAffine([[kind, 1]], 0, searchable, 'clamp', 'clamp') // searchable[kind]
circuit.assumeGrid(bit, 1) // without it the class comparisons become sign cascades
const searched = circuit.roundAffine([[circuit.reglu([[codePoint, 1]], 1, [[bit, 1]], 0), 1]], -1) // (codePoint + 1) × bit − 1
```

That is 3 more operations per position, 151, 359 and 1,159 for the reverse step. On the GPU the kinds are the highlighter's per position output, a buffer that stays there, and the search shader reads it as a second input. So the highlighter runs once when the documents load, and a search runs only the search.

### Two writers of GPU code

A compiled program says what each operation computes, and not how a backend has to hold its values, and src/json-search has two writers of WGSL for the same loop programs:

- **loop-emit.ts** writes every operation of a step as one f32 statement. For the search that is one table read per pair of states, i.e. 128, 512 and 2,048 reads per position at 8, 16 and 32 states. It writes a stage's statements in the order of use, each one right after the statements it reads, and a field of bits as one u32 word per position.
- **bit-emit.ts** takes the same loop program, writes the same shader around it, and writes each operation in the cheapest form that it can prove gives the f32 statement's value:
  - **A value that is proven to be a whole number is an `i32`, and one that is proven to be 0 or 1 is a bit.** E.g. the ReLU gate `relu(a - b)` over two bits is `a & (b ^ 1u)`, and the two gates that the builder writes for `codePoint >= boundary` are one integer comparison.
  - **The table reads that one gate combines are one AND of two 32-bit words.** The gate of a state `to` says "no state that continues steps to `to` on this class". loop-emit.ts writes it as 8 table reads and a sum at 8 states. bit-emit.ts writes `(packed_words[first + class] & continuing) == 0u`, where `first` is the place of that gate's words: bit `from` of the packed word is the cell `transitions[class][from][to]`, and bit `from` of `continuing` is that state's bit. gpu/host.ts's runner packs the words from the pattern's cells at each upload with `packWords`, e.g. the 1,024 transition cells of a pattern at 8 states into 272 words.
  - **The same gate for every state is one word operation**, e.g. `continuing[s] = relu(reached[s] - notReach[s])` for 8 states is `reached & (notReach ^ 255u)`.

| The search's shader at 8, 16 and 32 states, reading display kinds | loop-emit.ts | bit-emit.ts |
| --- | --- | --- |
| Statements | 503, 1,375 and 4,655, and 496, 1,368 and 4,648 for a search that reads no display kinds | 147, 171 and 219 |
| One search of 100,000 documents, when searches follow each other | 7.8, 69 and 945 ms | 4.6, 4.7 and 5.2 ms |
| The same after a pause of 200 ms, which a keystroke gets | 16.5, 70 and 948 ms | 11.3, 11.9 and 13.2 ms |

The program is the same for both writers: weighted sums, ReLU gates and table reads, which the CPU runs, and which stays as differentiable as any other. Every value is the same from both, which the tests check through a WGSL interpreter and lab/json-search's runs on the GPU. bit-emit.ts's rules name no program: each one is stated over what a compiled stage holds, i.e. an operation's kind, terms and weights, an index read's candidates, and the ranges, grids and exact bits that the circuit keeps per wire. [lab/json-search/million/README.md](../../lab/json-search/million/README.md#can-the-code-writer-do-it) has each rule with why it gives the f32 statement's value, and what the writer doesn't do, e.g. a list of bits that a program reads in another order than it stores them gets no word operation.

The searcher uses bit-emit.ts for the search programs and loop-emit.ts for the highlighter, whose shader is 107 statements. The highlighter's step reads tables of whole numbers and has no gate over several table reads, so bit-emit.ts packs nothing there, and its shader isn't faster. `writers` in the searcher's options picks the other writer for either.

### The searcher

searcher.ts is the module for a page, with no page globals:

```ts
const {device} = await requestBatchDevice(bufferBytesFor(texts.length))
const searcher = await createGpuSearcher(device, texts) // or createCpuSearcher(texts)
searcher.validation.valid[7] // 1 when document 7 is valid JSON
const result = await searcher.search({pattern: '(the|an?) [a-z]+', scope: 'strings', window: {firstDocument: 0, documentCount: 40}})
if (result?.status === 'searched') result.matchCounts[7] // matches inside document 7's string values
```

- **Creating it** writes and uploads every document's cells, compiles the highlighter's shader, validates every document, and builds and compiles the search program of every state capacity, so that no search waits for a compile. `searcher.validation` holds `valid`, `firstErrorPosition`, `firstErrorKind` and `truncated` per document, and `searcher.load` the times.
- **`search`** compiles the pattern, uploads its cells, and returns every document's match count, the totals, the marks of the window's documents, and the times. `documents: 'window'` searches only the window's documents, for a scroll with an unchanged pattern. A syntax error returns its message and position, and a pattern that fits no program returns what it needs.
- **One program per state capacity**, 8, 16 and 32 by default. A pattern runs on the smallest one that holds it, and `result.states` is that capacity.
- **One evaluation in flight, and only the newest request gets a result.** A request waits for the one before it, and a request that a newer one replaced, before or while it ran, resolves to `undefined`. A result arrives after the frame that asked for it, so a page treats it as an input of a later frame.
- **`kinds(window)`** copies the display kinds of some documents out of the GPU without a pass, e.g. the ones that scrolled into view.
- **`selfCheck(documents)`** compares the first documents with the same programs on the other backend: the GPU with generated JavaScript, and the CPU version with the executor. It checks the highlighter, and each search program with every one of its 11 searches that the program holds, among them a pattern of exactly 8, 16 and 32 states, one of characters above U+00FF, one that matches at every document's last character, and `[^,]+`, whose matches only the end of the searched characters stops. Over 300 documents it takes about 6 s, nearly all of it for the generated JavaScript at 16 and 32 states.
- **`limits`** is what the device granted and how many documents fit one buffer, and `programs()` lists each program's operations, statements and compile time.
- **`createCpuSearcher(texts)`** has the same interface and runs the same loop programs as generated JavaScript. A search takes 0.14 ms per document of 300 code points at 8 states, and 2.4 and 13 times as long at 16 and 32 states, so a page gives it hundreds of documents, or searches a few documents at a time in a worker, with `documents: 'window'`. For that, the option `highlight: 'whenFirstRead'` runs the highlighter on a document when a search or `kinds` first reads it, instead of on every document when the searcher is created, which takes about 9 s for 100,000 documents. It builds a larger search program at the first search that needs it.

What a page has to do with the searcher:

- **Ask for a device that holds the documents.** `requestBatchDevice(bufferBytesFor(count))` asks for buffers of the size the batch needs, and `searcher.limits.maxDocuments` says how many fit. A device from `requestDevice()` without limits binds 128 MiB per buffer, 65,408 documents.
- **Without WebGPU, run `createCpuSearcher` in a worker**, with `highlight: 'whenFirstRead'` and a few documents per search, as demo-worker.ts does.
- **Derive the request from the page's state in each frame**: when the pattern or the scope differs from the result on screen, `search({pattern, scope, window})`, and when only the window moved, `search({pattern, scope, window, documents: 'window'})` and `kinds(window)`.
- **Quote the time after a pause.** A page that searches once per keystroke gets 2 to 3 times the time of searches that follow each other, since an evaluation takes longer when the GPU had nothing to do just before.
- **Show plain JavaScript's time next to the GPU's instead of claiming a faster search.** `createPlainSearch(texts)` in plain-search.ts gives the same answers on one thread.

### The GPU host

gpu/host.ts is plain functions with no page globals:

- `requestBatchDevice(largestBufferBytes)` asks the adapter for storage buffers of the size the batch needs, and no more.
- `createDocumentStore(device, cellsPerDocument, capacity)` is the documents' cells on the GPU. `store.write(cells, count)` uploads them once, and every runner reads the same store.
- `createProgramRunner(device, shader, sharedValues, store, salt)` compiles one shader, times the compile, and uploads the shared table. The optional `salt` is a number written into the shader's source without changing its work, so that a salt no earlier run used compiles without hitting a shader cache. `runner.evaluate({count, readbacks, cells, timestamps})` runs one compute pass over the first `count` documents and copies out the chosen documents of the chosen output groups, e.g. the match count of every document and the marks of 64. It returns the time of each part: the `writeBuffer` calls, encoding and submitting, the wait until the readback is mapped, and copying the values out.

### The documents

`documentAt(seed, index)` in documents.ts returns a text, its shape and its defect. Every choice is a hash of the seed, the document's index and a counter, and no `Math.random`, so a page can make document 73,512 without making the ones before it, and the page, the tests and the measurements agree on the texts without passing files around. The documents have 7 shapes, 4 ways of writing, e.g. on one line or indented by tabs, and 16 defects, e.g. a missing quote or a trailing comma, in a share of the documents that the caller chooses: none on the page, and 1 in 10 in the measurements ([the documents of the measurements](../../lab/json-search/README.md#the-documents-of-the-measurements)).

## Files

| File | What it holds |
| --- | --- |
| [`assets/json-search.html`](../../assets/json-search.html), [`assets/json-search.css`](../../assets/json-search.css) | The page and its styles, on top of assets/site.css and assets/tool.css |
| `demo.ts` | The page's state and its frame: DOM reads, what arrived and the inputs, what the page shows, DOM and canvas writes, then the work that is due. Listeners and the workers' messages only record what arrived and schedule a frame |
| `demo-map.ts` | The map without a DOM: how large a cell is, which document the pointer picks, the next document with a match, and the cells' pixels |
| `demo-text.ts` | The page's documents, the line of numbers and the other sentences, and a document's text as runs of characters that look the same |
| `demo-worker.ts` | The workers' script, which the page starts twice: one worker times RegExp, and the other runs a search on the CPU in pieces and returns one document's kinds and marks. scripts/demo-site-pages.ts lists it next to the page, since Bun's bundler doesn't follow `new Worker(...)` |
| `searcher.ts` | The module for a page: validate every document once, search them per keystroke, on the GPU or on the CPU |
| `loop-program.ts` | A program as loops over a document's positions: stages, registers, fields and outputs, and its runner on the CPU |
| `json-step.ts`, `highlighter/` | The highlighter as a loop program, with its names and numbers in `kinds.ts` and its tables in `tables.ts` |
| `search-step.ts`, `regex/` | The search as a loop program, which can read display kinds. `pattern.ts` is the pattern language and its compilation into an automaton, `data-program.ts` the automaton's cells and the two operations that read them, and `bits.ts` AND NOT, NOT and "none of" on bits, which fold bits that builder code already knows |
| `program.ts` | A document's cells |
| `emit.ts` | A compiled program as a list of rows, one per operation, and the WGSL statement for each row, with index reads |
| `loop-emit.ts`, `bit-emit.ts` | The two writers of a loop program's shader |
| `generated-js.ts` | A program's operations as JavaScript statements, a CPU backend without the executor's loop over layers |
| `gpu/host.ts` | The WebGPU host: a device with the buffer limits it needs, a store for the documents' cells, and a runner per shader with compile time, evaluation and readback of chosen documents |
| `documents.ts` | The generated documents |
| `table-loop.ts`, `plain-search.ts` | The same answers in plain JavaScript, for the page's RegExp time: a highlighter as one loop over the program's own tables, then RegExp per search |
| [`tests/json-search/`](../../tests/json-search) | The tests and what only tests and measurements load, see below |

## How to test

`bun test tests/json-search` runs without a GPU and without a browser. Every comparison is exact, since every value of both programs is a bit or a small integer. `bun run test` runs the same files with the rest of the repo and gives each test 30 s, where `bun test` alone gives 5 s, which a test can exceed on a busy machine.

What the programs are compared with was written from the rules, and not from the programs:

- **tests/json-search/highlighter/reference.ts** is a hand-written scanner and parser with a real stack, written to be read next to JSON's grammar. reference.test.ts checks it against JSON.parse and against the definitions of the errors, on texts from corpus.ts.
- **tests/json-search/regex/reference.ts** has two references for [what the search finds](#what-the-search-finds). `automatonMatches` runs the compiled automaton from each scan position until no state is left, and keeps the last position where an accepting state was reached. `regexpMatches` doesn't use the compiled automaton: it tests every substring with `new RegExp('^(?:' + pattern + ')$', 'u')`.

The tests, by file:

- **json-step.test.ts**: the highlighter's step, run over a document's positions on the CPU executor and as generated JavaScript, gives the reference's summary, first error kind and display kinds on 2,509 test texts, which reach every error kind, on 280 documents at the limits, and on an object inside arrays and an array inside objects at every depth from 1 to 16. On the literal evaluator, every declared grid and index read holds at every position.
- **regex/regex-search.test.ts**: the search's step gives both references' matches on 26 hand-written cases and on the random patterns that fit its small program, more than 250 of 400, with 6 texts each, a syntax error for syntax outside the language, a named message for a pattern that doesn't fit, and holds its declarations at every position.
- **search.test.ts**: the loop programs and both writers' shaders, through the WGSL interpreter, give the automaton reference's match count and marks for 274 patterns of up to 8 states with 8 texts each, at 16 and 32 states, at 512 positions over generated documents, and in every scope, and the highlighter's shaders give the reference's values on the 2,509 texts. It pins the sizes that this README gives.
- **searcher.test.ts**: the searcher on the CPU against both references, and the searcher on the GPU as a page creates it, where tests/json-search/interpreted-gpu.ts is a WebGPU device whose compute pass runs the shader's text through the interpreter. Only the newest of several requests gets a result, and a self check finds no difference between the backends.
- **edge-cases.test.ts**: a searcher on the CPU and on the GPU against both references over the documents and patterns of edge-cases.ts, which are at the limits, e.g. the empty text, texts of 511 to 514 code points, nesting 16 and 17 deep, a match on the last position, and patterns that fill a program's states ([the list](../../lab/json-search/README.md#the-reviews-checks-the-limits-and-the-programs-with-every-position-written-out)).
- **bit-emit.test.ts**, **writer-probes.test.ts**: which of bit-emit.ts's rules fire on the two steps and on small programs, the programs where a rule must not fire, and both writers' shaders against the CPU executor.
- **demo.test.ts**: the map, the page's documents and sentences, the worker, which Bun runs as a worker, and the page's own searches on the GPU against the CPU.
- **json-search.test.ts**: a program with every kind of row as generated JavaScript and as both writers' shaders, `writeDocumentCells`, the table loop against the reference, and the generated documents, whose first 2,000 texts have a pinned hash, so a change to the generator fails a test instead of silently changing every measurement's input.

What only tests and measurements load is next to the tests: wgsl-interpreter.ts, a strict interpreter for the WGSL that the two writers write, which rounds every f32 operation on its own and says nothing about what a GPU compiler does; bit-rows.ts, the same automaton with every row of a class's transition matrix as one 32-bit word, as a plain JavaScript loop and as a hand-written WGSL kernel, which lab/json-search's runs compare every GPU readback with; and writer-probes.ts, writer-fuzz.ts and character-sets.ts, programs for the checks of bit-emit.ts. On a GPU, lab/json-search's measurement pages compared every value that they read back with the CPU's, about a billion per run, and none differed ([correctness checks on the GPU](../../lab/json-search/README.md#correctness-checks-on-the-gpu)). Only one GPU and one compiler were tested: an Apple M5 Max through Metal, in Chrome 155.

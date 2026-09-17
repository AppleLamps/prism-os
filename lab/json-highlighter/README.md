# JSON highlighter

A monospace text box that holds up to 512 code points, highlighted on every keystroke by one numeric program. JavaScript writes each code point, the text's length and the caret into cells. The program returns what every character is shown as (whitespace, punctuation, key, string, escape, number, literal, error, or after the text), the first error's position and kind, whether the text is too long, whether the first error is nesting past the maximum depth, and the bracket that matches the bracket at the caret. It's a temporary demo of a traditional JavaScript task, to see how the approach handles it.

Every capacity is fixed while building, and what doesn't fit has a named output. Past 512 code points, the program reads the first 512, `truncated` is 1, and the first error is `tooLong` at 512 unless an error comes first. An opening bracket at depth 16 is the error `tooDeep`, and `depthExceeded` is 1 when `tooDeep` is the first error. An earlier error hides nesting past the maximum depth, e.g. `x` on the first line followed by 17 `[` reports `unexpectedCharacter` at 0 and `depthExceeded` 0. Any text within capacity costs the same: evaluating an empty text takes 147 µs in Bun, and writing and evaluating a full text 155 µs, of which the writes take about 2 µs.

## Run it

```sh
bun test lab/json-highlighter                         # 12 tests, about 4 s
bunx tsgo -p lab/json-highlighter                     # type-check
bunx oxlint --type-aware lab/json-highlighter         # lint
bun lab/json-highlighter/index.html                   # the page; add ?form=brent-kung or ?form=sklansky for the other builds
bun lab/json-highlighter/measure.ts                   # sizes, then µs per evaluation with each form in its own process, about 20 s
bun lab/json-highlighter/measure-browser.ts loop 80   # keystroke frames in headless Chrome, CHROME_PATH overrides the binary
```

| File | What it holds |
| --- | --- |
| `kinds.ts` | The capacity, the maximum depth, the display kinds and the error kinds, with an example of each error |
| `tables.ts` | The character classes, the tokenizer's 26 states and 25 events, the grammar's 8 states, and the tables JavaScript writes into cells, each built from a transition function, e.g. `lexerStep(state, characterClass)` |
| `highlighter.ts` | The cells, the program in three forms, and the host code that writes the text |
| `reference.ts` | The same highlighter in plain JavaScript: a scanner that consumes one token at a time and a parser with a real stack. It doesn't read tables.ts |
| `corpus.ts` | Edge cases, random JSON, random edits of random JSON, and the 512 code point text for timings |
| `highlighter.test.ts` | The program against the reference, and the reference against JSON.parse |
| `measure.ts`, `measure-browser.ts` | Sizes and µs in Bun, and keystroke frames in headless Chrome |
| `index.html`, `main.ts`, `prefix-networks.ts` | The page, where Tab types a tab and Escape then Tab moves focus out of the editor, and the prefix networks copied from the guide's examples |

## What the program computes

Each stage runs over 513 positions: the 512 cells, and position 512, which is the end of the text, or the 513th code point of a longer text.

1. **A character class per position.** `classes[codePoint + 1]`, one index read from 129 cells. The empty cell value -1 reads `end`, and every code point from U+0080 up clamps to the entry of U+007F, `other`, which is only allowed inside strings ([patterns.md, "A loop over data that rarely changes"](../../docs/patterns.md#a-loop-over-data-that-rarely-changes)).
2. **The tokenizer.** A state machine of 26 states over 33 classes, e.g. `hex2` after two hex digits of a `\u` escape, or `fal` after the letters of false read so far. The `'loop'` form reads `lexerNext[state × 33 + class]` once per position. `'brent-kung'` and `'sklansky'` turn each position into a table of 26 reads and combine tables with one read per state ([patterns.md, "A state machine over queued events"](../../docs/patterns.md#a-state-machine-over-queued-events)). One more read per position gives the event, e.g. `stringStart` or `badNumber`, from the state before the position and its class.
3. **Depth before every position.** Running totals of +1 for `{` and `[` and -1 for `}` and `]` events ([patterns.md, "Running totals"](../../docs/patterns.md#running-totals)), as a chain or a prefix network.
4. **The container kind at the current depth.** JSON's grammar needs a stack, e.g. to know whether a comma leads to a key or a value. At a bounded depth, the stack's kinds fit in one integer whose bit d − 1 is 1 when the container at depth d is an object:

   ```js
   // familiar: a stack of container kinds
   if (character === '{') stack.push('object')
   if (character === '}') stack.pop()
   const inObject = stack.at(-1) === 'object'
   // the program: a running total, and one comparison with the bit of the current depth
   code += character === '{' ? 2 ** depthBefore : character === '}' ? -(2 ** (depthBefore - 1)) : 0
   const inObject = code >= 2 ** (depth - 1)
   ```

   The weight is one index read at `depthBefore × 25 + event`, and the comparison is `emitCompare` on integers, 2 operations ([expressions.md, `a >= b`](../../docs/expressions.md#familiar-expressions)). The code is exact before the first error, since every container below the current depth is still open and every closer matched its opener's kind, so no bit at or above the depth is set. After the first error the code can be wrong, e.g. `[}` subtracts a brace's bit that was never added, but the grammar reads nothing after its first error. Weights reach 2^15 at depth 16, so the code stays within ±511 × 2^15. At positions 1 to 510, the code minus a level weight of up to 2^15 stays below 2^24, and `emitCompare` builds integer bits. At position 511 the difference can reach exactly 2^24, one step past what integer bits allow, and `emitCompare` builds a sign cascade of 17 operations, which is also exact. `circuit.roundingPoints()` reports 5,127 integer bit operations and 17 sign cascade operations in every form, and a test checks both counts.
5. **The grammar between tokens.** A state machine of 8 states, e.g. `keyOrClose` after `{`, over 88 symbols, `token × 8 + depthClass × 2 + inObject`, where the depth class tells the top level, depth 1, depths 2 to 15 and depth 16 apart. Built as a loop or a prefix scan like stage 2. Strings in a key position lead to the state `colon`, so a string character is shown as a key when the grammar's state after it is `colon`, one read per cell at `event × 8 + grammarState`.
6. **The first error.** The grammar's `error` state never goes back, so the bits `[state after the position === error]` read 0...0 1...1, and their count of zeros is the first error's position ([patterns.md, "`findIndex` when the test flips once along the items"](../../docs/patterns.md#findindex-when-the-test-flips-once-along-the-items)). Every position computes an error kind, the lexer's kind of its event plus the grammar's kind of its step, and the first error's kind is one index read at the count.
7. **The matching bracket.** Brackets pair by depth, whatever their kinds. An opener's match is the closer just before the first later position whose depth before it is at most the opener's depth before it, and a closer's match is the last earlier position whose depth before it is below the closer's. Each position computes whether it's such a hit, `[depthBefore <= threshold]` and on the right side of the bracket, then a running count of hits gives the first hit as the count of `[hitsThrough < 1]` bits and the last hit as the count of `[hitsThrough < totalHits]` bits. Two `emitFirstActive` trees gave the same answers in 9,241 operations in the loop form, and the count in 6,687.

The rules that go past JSON's grammar are written out at the top of reference.ts, e.g. the first error's position is the first code point at which the text stops being the start of some valid JSON text, so `[1 2]` reports `expectedCommaOrClose` at 3, and `[1` reports `unexpectedEnd` at 2. After a lexer error, e.g. the `x` of `[x]`, the rest of the line shows as an error, and tokenizing starts again after the next line feed, so later lines keep their colors. The bracket at the caret is the code point before the caret when it's a bracket, otherwise the code point at the caret. The caret cell holds 0 to 513, so a caret past code point 512, e.g. at 600 in a text of 699 code points, has neither code point among the cells, and no bracket is at the caret.

## Results

Measured on September 17, 2026 on an Apple M5 Max with macOS 27.0: Bun 1.4.0, and Chrome 153.0.8010.48 headless in a 900 × 800 window. µs in Bun are the median of 30 batches of 50 evaluations after 200 warm-up evaluations, each form in its own process, on a valid 512 code point text that alternates one digit. Chrome timings come from the page's `performance.now()`, which Chrome rounds to 0.1 ms, over 70 keystrokes that type a digit or a Backspace into the full text, after 10 warm-up keystrokes. Other work ran on the machine at the same time, with load averages from 3.3 to 5.1. Each Chrome number is the range over two runs per form, which differed by up to 2.5 times at this load, e.g. Brent-Kung's evaluate median was 0.6 ms in one run and 1.5 ms in the other.

| Form | Live operations | Index reads | Layers | Stored weights | Bun, write and evaluate | Bun, with createEvaluator's checks | Chrome evaluate, median and 95th percentile | Chrome DOM writes, median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| loop | 15,928 | 6,154 | 1,043 | 28,744 | 155 µs | 173 µs | 0.4 to 0.6 ms, 1.0 ms | 0.1 to 0.2 ms |
| brent-kung | 51,860 | 40,596 | 81 | 72,298 | 386 µs | 391 µs | 0.6 to 1.5 ms, 0.6 to 2.3 ms | 0.1 to 0.2 ms |
| sklansky | 99,627 | 84,490 | 64 | 123,938 | 754 µs | 778 µs | 2.1 to 3.4 ms, 4.3 to 4.6 ms | 0.2 ms |

For comparison, in the same Bun processes on the same text, the plain JavaScript reference takes 11 to 13 µs and JSON.parse 1 µs. In Chrome, the time from the input event to the frame after the DOM writes has a median from 19.7 to 22.3 ms in every form, mostly waiting for frames at 60 Hz. After the DOM writes, the page copies the textarea's scroll position to the `<pre>`, which lays out the `<pre>` right away. That layout isn't in the DOM writes column, but it is in the time to the next frame.

Every form has 4,575 source cells: 514 that JavaScript writes on each keystroke (512 code points, the length and the caret), and 4,061 table cells written once, e.g. 858 each for the tokenizer's next state and event tables and 704 each for the grammar's next state and error tables.

Operations by stage, each measured up to that stage's wires, so later rows include earlier ones:

| Up to | loop | brent-kung | sklansky |
| --- | --- | --- | --- |
| every position's event (stages 1 and 2) | 1,540 in 514 layers | 27,878 in 19 layers | 61,444 in 12 layers |
| the grammar's state after every position (stages 1 to 5) | 6,670 in 533 layers | 42,100 in 76 layers | 88,576 in 59 layers |
| every output except the matching bracket | 9,241 in 538 layers | 44,671 in 81 layers | 91,147 in 64 layers |
| every output | 15,928 in 1,043 layers | 51,860 in 81 layers | 99,627 in 64 layers |

The tests run 2,509 texts: 129 edge cases, 700 random JSON texts, 1,600 random edits of random JSON, and 80 texts from under to past the capacity. JSON.parse accepts 1,093 of them, and the reference reports 1,020 valid. The comparison with JSON.parse skips the 105 texts whose first error is `tooDeep` or `tooLong`: 73 that JSON.parse accepts, and 32 that it rejects. For every other text, the reference is valid exactly when JSON.parse succeeds. The reference reports every error kind, from 482 `unexpectedCharacter` to 16 `mismatchedBracket`. Over the first 1,200 texts, every prefix of a valid text is valid or ends with `unexpectedEnd` at its length, and an invalid text cut at its first error has no earlier error. The program matches the reference on every output at a random caret for all 2,509 texts in the loop and Brent-Kung forms, and for 429 of them in the Sklansky form, at every caret position of 7 nested and broken texts in all three forms, at 7 carets from 511 to 10,000 of a 699 code point text in all three forms, at carets 0 and 1 of the 512 code point text `[`, 510 spaces, `]`, whose match comes from the hit at position 512, and the literal instruction evaluator gives the compiled layers' values on 60 texts per form, with `validateIndexReads`, `validateGrids` and `validateNoNaN` passing. A check outside the repo corrupted one table cell at a time, e.g. a comma inside an object at depths 2 to 15 leading to a value instead of a key, and 5 to 305 of the 2,509 texts then disagreed with the reference.

## What fit well

- A tokenizer is already a table-driven state machine, so its tables moved into cells unchanged, and the loop form reads 3 tables per position: the class, the next state and the event.
- The first error is a count, since an error state that never goes back gives bits that flip once. Its kind is one index read at that count.
- The reference and the program were written separately, from the rules at the top of reference.ts, and agreed on the first run. JSON.parse checks the reference's validity, and table corruptions show the comparison can fail.
- The cost doesn't depend on the text: an empty text and a full text take about the same µs, 147 and 155 in Bun with about 2 µs of writes, which is the worst case a keystroke can hit.

## What got awkward

- **The stack.** No entry in patterns.md or expressions.md covers a stack. The integer code in stage 4 works for two reasons that the construction depends on: the grammar ignores everything after its first error, and at 512 code points with a maximum depth of 16, the code's range of ±511 × 2^15 barely fits. `emitCompare` builds integer bits at every position except 511, where the code minus the level weight reaches exactly 2^24 and it builds a sign cascade of 17 operations. Depth 17 needs weights up to 2^16, whose totals pass 2^24 from about position 255 on, and `emitCompare` would build sign cascades of 17 or more operations there instead of 2.
- **Prefix scans cost much more than the loop here.** The tokenizer has 26 states, so each combine is 26 reads: Brent-Kung is 18 times the loop's operations for the tokenizer, and 2.5 times its µs in Bun for the whole program. patterns.md says operations cost more than layers on today's CPU executor, and this demo measures that at 26 states.
- **Fewer operations didn't give fewer µs.** Replacing the two `emitFirstActive` trees with the running count removed 2,554 operations from the loop form, but the count is a chain that starts after the depth totals, so layers went from 574 to 1,043, and µs stayed about the same, 141 before and 148 after. The executor pays per layer too.
- **Grids on index reads.** Index reads get no inferred grid, so every read that feeds `emitCompare`, e.g. a depth change or a level weight, needs `circuit.assumeGrid(read, 1)`. Without it, `emitCompare` builds a sign cascade with no warning. `circuit.roundingPoints()` tells which construction each comparison built, e.g. by counting its `'sign cascade'` entries, and execution-model.md's Rounding points section documents it, but expressions.md's `a >= b` row and its Decision bits section don't point to it. This demo first counted operations instead, and missed the sign cascade at position 511 described in stage 4.
- **createEvaluator on a program without state.** The program keeps no state, but `createEvaluator` checks all 4,575 cells before and after each evaluation and returns every cell's next value, most of them constant tables: 173 µs against 155 µs for `circuit.createTensorEvaluator` on the outputs only.
- **Error recovery belongs to the behavior.** Showing the rest of an error line as an error, and starting again after a line feed, is part of the tokenizer's tables and had to be copied in the reference's scanner, as did which bracket at the caret counts and when a string is a key.

## Notes on the docs

- patterns.md's state machine entry uses `sklanskyPrefix` from the guide example's prefix-networks.ts, which src/runtime doesn't export, so this folder copies the file.
- The same entry's cost, O(S × k log k), is Sklansky's. Brent-Kung gives O(S × k), and with a constant initial state, only entry 0 of each prefix that starts at position 0 is live, so measured counts come out below S times the number of combines.
- expressions.md's `table[index]` row doesn't say that a read has no grid, which execution-model.md's Grids section does. The row is where a reader looks before comparing a read value.
- patterns.md's "`findIndex` when passing items can be anywhere" points to a tree. When the first and the last hit are both needed, a running count of the hits and two sums of monotone bits gave both in fewer operations here.
- tutorial.md builds around state cells and `advanceFrame`. A program that is a function of its inputs, like this one, uses neither, and the tutorial doesn't say what to leave out, e.g. that `table.finish()` works with no state cells.

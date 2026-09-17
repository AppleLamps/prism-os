# Code points in cells: line breaking as table reads inside the circuit

## What it is and how to run it

This prototype copies [text-editing](#merged-from-text-editing-september-16-2026)'s text field circuit and moves the string boundary down one level. Each cell holds only a Unicode code point, below 2^21 and so exact in FP32. The circuit reads each cell's line break class, its advance, and whether a line may break after it from tables in the source table. Break opportunities between ideographs, no break before closing punctuation, hanging spaces, and numbers like `$1,299.99` staying together are decided in the circuit. JS no longer segments graphemes, classifies them with a regex, or hands out codes from a 96-entry vocabulary.

The short answer: reading class, advance and break bit from tables costs 8 live operations per cell, all index reads, in 3 layers. text-editing's packed decode was also 8 atoms per cell, in 5 layers, and it only knew spaces and newlines as break opportunities. Against pretext's pre-wrap walker, line start mismatches over 41,820 layouts in 13 text families went from 8,806 (text-editing's rules) to 418 with the pair table, and to 215 when CJK runs that don't fit on a line are kept whole. text-editing's CJK family went from 2,023 of 2,460 layouts to 0.

Run from the repo root:

```sh
bun test lab/ui-exploration/code-points                            # 38 tests, under a second
bunx tsgo -p lab/ui-exploration/code-points                        # typecheck
bun lab/ui-exploration/code-points/pretext-agreement.ts census     # agreement with pretext, causes of the remaining mismatches, boundary census, about 6 seconds
bun lab/ui-exploration/code-points/report.ts                       # every measurement, about 10 seconds
bun lab/ui-exploration/code-points/report.ts decode exhaustive     # chosen sections: sizes variants phases decode tables exhaustive typing font
bun lab/ui-exploration/code-points/demo.html                       # browser demo
```

Two session scratch scripts (scratch folder `phase3/code-points/`, not in the repo) came before this folder's code. `overflow-categories.ts` is the JS experiment that found which remaining mismatches go away when CJK runs are kept whole, before that rule went into the circuit. `attribution-probe.ts` is the experiment behind the causes table that `pretext-agreement.ts census` prints.

The runtime is `numeric-ui-core.ts`, a copy of index-read's runtime copy (in [pixel-output](../pixel-output/numeric-ui-core.ts) since September 16, 2026), which adds the `indexRead` instruction to the repo root runtime (commit a915dcb). That runtime moved into src/runtime/ on September 17, 2026. This folder changed only how that copy builds and compiles reads over large tables. See [what got awkward](#what-got-awkward). The baseline is text-editing's editor circuit, JS model, integer building blocks and width table on the shared runtime (`../../../src/runtime/numeric-ui-core.ts`): `grapheme-editor-circuit.ts`, `grapheme-reference.ts`, `grapheme-integer-circuits.ts` and `grapheme-width-table.ts`, with text-editing's `fake-canvas.ts`. They moved here with their tests when text-editing was merged into this folder on September 16, 2026 (see [Merged from text-editing](#merged-from-text-editing-september-16-2026)). Before that they were imported from `../text-editing/`, and until September 15, 2026 this folder held copies of them as `baseline-*.ts`. `report.ts` and `pretext-agreement.ts` measure the baseline next to the new circuit. `line-break-data.ts` is pretext's generated UAX #14 table (Unicode 17, MIT License), copied from tonight's read-only clone. `pretext-agreement.ts` measured against phase 1's copy of pretext's source (commit 477510e4 of https://github.com/chenglou/pretext), not a live checkout. That copy isn't in the repo: the script reads the folder from `PRETEXT_SRC`, and `lab/ui-exploration/text-tabulated/pretext/` holds the same files.

I didn't open the demo in a browser, since no browser automation was allowed. A later Chrome check opened the demo, see [Browser check](#browser-check). `bun build lab/ui-exploration/code-points/demo.ts` bundles it, and the tests exercise every module the demo uses except `demo.ts` itself.

## What was built

### Files

| File | What it holds |
| --- | --- |
| `line-break-classes.ts` | The 41 classes, `classOfCodePoint`, the ordered pair rules, the rule for when a run may break inside, class properties, and code point iteration |
| `tables.ts` | The two-level class table, class property tables, pair tables, and the advance table JS fills per code point |
| `editor-circuit.ts` | Source table layout, the circuit (per cell reads, layout, key step, display), a decode-only circuit, and a machine that measures new code points, writes events, evaluates and writes back |
| `reference.ts` | The plain JS editor over code points that the circuit is checked against. It calls the class and pair functions directly and never reads tables. `referenceLayout` also takes optional changes that only `pretext-agreement.ts` uses, to find the causes of mismatches |
| `integer-circuits.ts` | text-editing's integer building blocks, with `measureCircuit` counting index reads |
| `keyboard.ts`, `projection.ts` | Keys, typed text, IME text and pointers to events; outputs to glyph spans, caret and selection rectangles |
| `pretext-agreement.ts` | Line starts against pretext before and after, the causes of the remaining mismatches, and the boundary census |
| `report.ts` | Every other measurement |
| `editor.test.ts`, `tables.test.ts`, `integer-circuits.test.ts` | Differential tests, table tests, building block tests |
| `demo.html`, `demo.ts` | Browser demo |
| `numeric-ui-core.ts`, `line-break-data.ts`, `test-support.ts` | Copies described above, and random inputs |
| `grapheme-editor-circuit.ts`, `grapheme-reference.ts`, `grapheme-integer-circuits.ts`, `grapheme-width-table.ts`, `grapheme-keyboard.ts`, `grapheme-projection.ts`, `grapheme-test-support.ts`, `fake-canvas.ts` | text-editing's grapheme version, the baseline, moved here on September 16, 2026: its circuit, JS model, building blocks, width table, input, projection and random inputs, and the deterministic fake canvas |
| `grapheme-editor.test.ts`, `grapheme-integer-circuits.test.ts`, `grapheme-input.test.ts` | text-editing's differential tests, building block tests, and input, width table and projection tests |

### Cells and tables

A cell holds a code point, and 0 marks an empty cell after the text. The source table holds these tables, written by JS:

| Table | Source cells | Written |
| --- | ---: | --- |
| class block offsets, one per 128 code points | 8,704 | once |
| class pages: 194 distinct pages of 128 classes | 24,832 | once |
| class properties: space or newline, newline, word | 123 | once |
| pair table: 41 × 41 break bits | 1,681 | once |
| emergency pair table: 41 × 41 bits, read only when CJK runs are kept whole | 1,681 | once |
| advance block offsets | 8,704 | when a code point from a new block of 128 appears |
| advance pages: 64 pages of 128 advances in quarter pixels | 8,192 | when a code point first appears |
| total | 53,917 | |

Both two-level tables store an offset per block instead of a page number: `blockOffsets[b] = (page - b) * 128`. The entry for a code point then sits at `blockOffsets[floor(codePoint / 128)] + codePoint`, a sum of two exact integers, so the second read needs no remainder. For example, U+5B57 字 is in block 182. If that block's classes are on page 12, its class is at `(12 - 182) * 128 + 0x5B57`.

The first read needs `floor(codePoint / 128)`. The default, `blockIndex: 'shift read'`, writes the index form as the cell times 2^-7 and lets the executor's index read take the floor. FP32 holds any code point times 2^-7 exactly, so the floor lands on the block. `'floor atoms'` computes the block with text-editing's 3-atom floor first, so every index form holds an exact integer, the promise index-read's `validateIndexReads` checks. `validateCodePointReads` checks the default: every index form is an exact integer, except a single integer cell times 2^-7.

### Per cell reads

Each key step, and the final layout, reads per cell:

1. the class block offset, then the class (2 reads)
2. the advance block offset, then the advance (2 reads)
3. space or newline, newline, and word, each read from a class property table at the class (3 reads)
4. `breakAfter[c] = pairs[class[c] * 41 + class[c + 1]]`, with the empty class after the last cell (1 read)
5. with `overflow: 'cjk whole'`, the emergency bit from the second pair table (1 read)

Live operations only keep what a step uses. The final layout doesn't read word bits, and a key slot that doesn't lay out only keeps the reads behind its word targets.

### Classes

The 41 classes start from UAX #14 as pretext's generated table projects them, e.g. AI, SG and XX read as AL, and H2, H3, JL, JV and JT read as ID. Then they add the distinctions pretext's `analysis.ts` makes that a pair of neighbors can express:

- `ID_CJK`: anything inside pretext's CJK ranges whose class isn't CL, CP, OP, NS, CJ, EX, CM, GL or QU, e.g. 字, の, 한, and fullwidth digits. pretext puts a break opportunity around each of them.
- `CL_CJK`, `OP_CJK`, `NS_CJK`: closing punctuation, opening punctuation and nonstarters inside the CJK ranges, e.g. 、。」，, 「（【 and 々・.
- `QU_OPEN` (“ ‘ « ‹ „ ‚), `QU_CLOSE` (” » ›), `AP` (U+0027 and U+2019) and other `QU` (U+0022): pretext glues opening quotes to what follows, closing quotes to what precedes, and apostrophes to both sides.
- `LF` for U+000A, and `SP` for U+0020 and U+0009 (the spaces that hang), `GL` for U+00A0, U+2007, U+202F, U+2060 and U+FEFF, `ZW` for U+200B, `SHY` for U+00AD, and `empty` for code point 0.

JS runs `classOfCodePoint` once per code point when it builds the class table, 1,114,112 calls in 35 to 63 ms across runs. Blocks with identical classes share a page, e.g. every block of CJK ideographs. That gives 194 pages, where pretext's projected classes alone give 189.

### Pair rules

`pairRules` is an ordered list, and the first rule that applies decides. Each rule names the UAX #14 rule it simplifies or the pretext behavior it follows. `report.ts tables` prints how many of the 1,681 cells each rule decides. A few of them:

- break after spaces, even before closing punctuation, as pretext does: `SP ÷ AL`, `SP ÷ CL`
- no break before closing punctuation and nonstarters, e.g. `字。`, `word,`, `字々`
- no break after opening punctuation, e.g. `「字`, `(word`
- letters and digits stay together, numbers keep their signs, separators and affixes (LB23 to LB25, LB28 to LB30), e.g. `3.14`, `$5`, `100%`, `jolly$5`, `hello,world`, `a/b`
- break everywhere else (LB31), e.g. between ideographs, `字a`, `a字`, `。字`, `word-|next`

595 of the 1,681 cells allow a break.

### Layout changes from text-editing

- `breakAfter` replaces the space class as the leaf of the latest-opportunity scans. Everything else about the line walk is text-editing's.
- `positionReads: 'index'` reads a table with one index read wherever the circuit already has the position as a count, e.g. the first cell that doesn't fit, the caret, or a glyph's line. text-editing built a one-hot group from neighbor differences of the count's comparison bits and gathered through it (`'one-hot'`, the default here, so the main comparison isolates the code point change).
- `overflow: 'cjk whole'` keeps a run with no break opportunity whole when it doesn't fit on a line by itself and the glyph that doesn't fit, or the glyph before it, has a CJK class, e.g. 字。 on a line narrower than two ideographs. The line then ends at the run's next opportunity, which a suffix minimum over the break bits gives. With the default, `'anywhere'`, the run breaks at the glyph that doesn't fit, as in text-editing.
- Pasted code points go straight into cells. text-editing looked up each pasted code in the width table through a 96-entry one-hot: 1,552 live operations for 8 codes, now 16 masks.

## Measured results

Counts are exact. µs are rough single-threaded CPU numbers on a machine shared with many other agents.

### Agreement with pretext

`pretext-agreement.ts` lays out each text at 41 widths from 30 px to 400 px with pretext's `layoutWithLines` in pre-wrap mode and with the JS editor model, using the fake canvas (whole quarter pixels per character, no kerning), and compares line starts. The first seven families are text-editing's, with the same seeds. The "before" column reruns text-editing's width table and walker, and reproduces text-editing's 2,023 for the CJK family.

| Text family | Layouts | Before: grapheme codes, breaks at spaces and newlines | After: code points and pair table | After, CJK runs kept whole |
| --- | ---: | ---: | ---: | ---: |
| words, commas, spaces, double spaces and newlines | 12,300 | 0 | 0 | 0 |
| leading spaces after newlines | 2,460 | 0 | 0 | 0 |
| long space runs | 2,460 | 0 | 0 | 0 |
| lines holding only spaces | 2,460 | 0 | 0 | 0 |
| text starting with spaces | 2,460 | 0 | 0 | 0 |
| no-break spaces (U+00A0, U+202F) between words | 2,460 | 0 | 0 | 0 |
| CJK ideographs, kana and Hangul next to Latin words | 2,460 | 2,023 | 0 | 0 |
| Chinese and Japanese sentences with CJK punctuation | 2,460 | 1,080 | 115 | 0 |
| CJK next to Latin words and punctuation, with and without spaces | 2,460 | 1,531 | 51 | 34 |
| numbers: prices, percents, times, decimals, dates, signs and ranges | 2,460 | 784 | 176 | 176 |
| Latin punctuation without spaces: hyphens, slashes, brackets, quotes, apostrophes, ellipses, dashes | 2,460 | 377 | 0 | 0 |
| Japanese kana with small kana, prolonged sound marks and iteration marks | 2,460 | 1,391 | 76 | 5 |
| Korean words with spaces and punctuation | 2,460 | 1,620 | 0 | 0 |
| all families | 41,820 | 8,806 | 418 | 215 |

A first version of the pair rules lacked UAX #14's `AL × PR`, `PO × AL`, `NU × PR` and `PO × NU` and had 572 mismatches after. Adding those pairs removed 154, all in the numbers and Latin punctuation families.

### Where the remaining 215 come from

`pretext-agreement.ts census` finds the cause of each one by changing the JS walker in three ways. Each change makes the walker do what pretext does in one case, and a mismatch counts under the change that fixes it by itself. All three changes together fix all 215, and none of them makes a layout that matched pretext stop matching. The circuit implements none of these changes.

| Cause | Layouts | Example |
| --- | ---: | --- |
| pretext breaks after a hyphen between digits | 140 | `784 0-\|93` |
| pretext breaks after a hyphen between a word and digits | 36 | `pneumonoultramicroscopic-\|7471` |
| pretext starts the next line at the space after a CJK unit that doesn't fit | 26 | `…jugs试、\| ` at 30 px |
| pretext doesn't break after `!` before an ASCII letter | 12 | `wizards!black` |
| both of the last two causes in one layout | 1 | `wizards!black の， ` at 30 px |

- **A hyphen before digits (176).** pretext breaks after the hyphen in `0-93` and in `pneumonoultramicroscopic-7471`, but keeps a sign with its number, e.g. ` -5`. UAX #14 (LB25) keeps the hyphen with the digit in all of these cases, and so does the pair table. A pair of neighbors can't tell a range from a sign; the character before the hyphen decides.
- **The space after an overflowing CJK unit (26: 21 in the CJK next to Latin family, 5 in the kana family).** At 30 px, where two ideographs (32 px) don't fit, pretext moves the space that follows an overflowing unit to the next line. For example, in `…jugs试、 ` the unit 试、 overflows, and pretext starts a line at the trailing space. The editor hangs that space on the overflowing line, as it hangs any trailing space.
- **`!` before a letter (12, plus the 1 layout with both causes).** All 13 layouts come from one text in the CJK next to Latin family containing `wizards!black`. pretext doesn't break there, while the pair table breaks after EX before a letter. This is the EX ÷ AL row of the census below.

### Where the pair table and pretext's analysis disagree

The census compares, boundary by boundary, where pretext's prepared segments allow a break and where the pair table does. It skips boundaries before spaces, newlines, zero width spaces and soft hyphens, and after newlines, since both sides handle those separately.

| Classes around the boundary | pretext breaks, pair table doesn't | Pair table breaks, pretext doesn't | Agree | Example |
| --- | ---: | ---: | ---: | --- |
| HY ÷ NU | 35 | 0 | 18 | `784 0-\|93` |
| EX ÷ AL | 0 | 1 | 2 | `zards!\|black` |
| all boundaries | 35 | 1 | 76,266 | |

The second row is Chrome's pair table for ASCII, which pretext follows. It doesn't break after `!` before an ASCII letter. It does break after `?` before a letter, and after `!` before a letter outside ASCII: pretext keeps `wizards!black` in one segment, but breaks `wizards?|black` and `wizards!|éclair`. `!` and `?` are both EX in UAX #14, so this rule doesn't need a third neighbor. Splitting `!` from the other EX code points, and ASCII letters from the other letters, would express it as pair rules.

Where the pair table departs from UAX #14 on purpose, to follow pretext's Blink profile or to stay a pair table:

- A break after spaces is allowed even before closing punctuation. UAX #14's LB13 and LB14 hold across spaces.
- Letters, digits and symbols inside the CJK ranges break around every character, e.g. fullwidth `１２３`, because pretext does that.
- Small kana and U+30FC (CJ) break like ideographs, as Blink's normal rules do.
- A combining mark isn't resolved to its base's class (LB9); before a letter it acts as a letter.
- ZWJ (LB8a), regional indicator parity (LB30a), Aksara (LB28a) and LB30's East Asian width condition are left out or simplified.
- Thai, Lao, Khmer and Burmese (SA) act as letters, so a run never breaks inside; dictionary breaks aren't modeled.

### Correctness of the circuit

| Check | Size | Mismatches |
| --- | --- | ---: |
| `editor.test.ts`: 4 differential configs against the JS model over random mixed text (Latin, digits, CJK, kana starters, CJK and ASCII punctuation, no-break and zero width spaces, emoji, a supplementary ideograph): runs breaking anywhere with one-hot reads; CJK runs kept whole with one-hot reads and 2 keys per evaluation; floor atoms, Brent-Kung scans, index reads and CJK runs kept whole; index reads with buffer-only key slots and gather shifts. Every state and display output is checked every frame, and one-hot promises and index forms every 40 frames. The field width changes every 40 frames, keeping the text. In the two configs that keep CJK runs whole, the rule changes the final layout in 17 and 63 frames | capacities 16 to 20, 400 to 700 frames per config, 10 to 17 field widths per config | 0 |
| `editor.test.ts`: hand-computed wrapping of `ab 字字。字字` at 100, 130 and 200 units with runs breaking anywhere, and at 100 units with CJK runs kept whole, in the circuit and the JS model | 4 layouts | 0 |
| `report.ts exhaustive`: every Unicode code point through a 4,096-cell decode circuit, class, advance and break bit, both block index variants | 1,114,112 code points, 272 evaluations each | 0 |
| `report.ts typing`: capacity 256, 12 line slots, 4 keys per evaluation with 1 layout slot, index reads, CJK runs kept whole, fake canvas widths, a paragraph of Chinese, Japanese, Korean and Latin text with random edits, in a 320 px field and then a 30 px field. At 320 px nothing in the paragraph is wide enough for the CJK run rule to change a layout. At 30 px, where e.g. 字， doesn't fit on a line, the rule changes the final layout in 347 frames | 320 px: 1,500 frames, 2,864 keys. 30 px: 1,443 frames, 2,707 keys, and 57 frames that needed more than 12 lines started over from an empty field. 0 dropped code points | 0 |
| `report.ts font`: after a font change from 16 px to 20 px, line starts and glyph x positions against the JS model | 156 code points | 0 |

The differential tests found one bug. The first pair rules said no break between a trailing space and the empty cell after the text. Empty cells' fit edges include the trailing spaces' advances, so when trailing spaces pass the edge, the first cell that doesn't fit is the end of the text, and the line must break exactly there. text-editing's space class had opened that opportunity implicitly. Two tests showed 6 and 7 display mismatches, all on texts ending in a space or a tab. A rule now breaks after a space before the empty cell.

### Cost per cell

A decode-only circuit over 256 cells and the same tables (`report.ts decode`):

| Block index | Live ops per cell | Of which index reads | Layers |
| --- | ---: | ---: | ---: |
| shift read, with word bits | 8 | 8 | 3 |
| shift read, without word bits, as the final layout | 7 | 7 | 3 |
| floor atoms, with word bits | 11 | 8 | 6 |
| floor atoms, without word bits | 10 | 7 | 6 |
| text-editing's packed decode: a floor of 3 atoms, 3 comparisons, 2 affines, no break bits | 8 | 0 | 5 |

In the capacity 256 one-key circuit the decode phases are 2,048 live ops for the key's layout and 1,792 for the final layout, the same counts as text-editing's decode. They span layers 0 to 2 instead of 0 to 4.

### Whole circuit

One key per evaluation, 12 line slots, paste limit 8, glyph outputs on (`report.ts sizes` and `variants`). The baseline row is text-editing's circuit on the shared runtime with 96 grapheme codes. "Shared runtime compile rules" compiles the code point circuit with the lowering and depth rules of the shared runtime: bit gathers only and build-time depths.

| Circuit, capacity 256 | Live ops | Layers | Stored weights | Gather reads / table entries | Index reads | Executor µs |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| baseline: grapheme codes | 54,431 | 239 | 113,830 | 397 / 34,866 | 0 | 410 |
| code points, one-hot position reads, shared runtime compile rules | 52,895 | 235 | 109,244 | 389 / 34,098 | 3,840 | |
| code points, one-hot position reads | 52,895 | 222 | 109,244 | 389 / 34,098 | 3,840 | 545 |
| code points, index position reads | 42,326 | 222 | 89,584 | 5 / 90 | 4,224 | 475 |
| code points, one-hot position reads, CJK runs kept whole | 82,488 | 282 | 155,667 | 484 / 58,513 | 4,352 | |
| code points, index position reads, CJK runs kept whole | 47,808 | 258 | 100,006 | 5 / 90 | 4,831 | |

| Capacity | Baseline | Code points, one-hot position reads | Code points, index position reads |
| ---: | ---: | ---: | ---: |
| 32 | 8,217 | 6,681 | 5,296 |
| 64 | 14,427 | 12,891 | 10,194 |
| 128 | 27,389 | 25,853 | 20,532 |
| 256 | 54,431 | 52,895 | 42,326 |

The code point circuit with one-hot reads is exactly 1,536 live ops smaller at every capacity: decode costs what it did, and the pasted code lookups (1,552 ops) became 16 masks. Layers drop from 239 to 235 because decode takes 3 layers instead of 5 in both the key and the final layout, and to 222 once depths are recomputed after lowering. Index position reads take the line breaking of one layout from 6,460 to 3,376 live ops, glyph positions from 6,657 to 3,585, and caret and selection display from 1,213 to 175.

Other variants at capacity 256, index position reads: 4 keys per evaluation with 1 layout slot is 71,618 live ops and 500 layers (baseline 90,635 and 536), 4 keys all laying out is 114,938 and 610, paste limit 1 is 42,121 (baseline 52,882), and no glyph outputs is 38,742. Floor atoms instead of shift reads add exactly 1,536 live ops and 6 layers.

Keeping CJK runs whole costs 5,482 live ops and 36 layers with index reads: in each layout, one emergency pair read per cell and a suffix minimum over the break bits, then per line slot 4 reads (the emergency bit and the run's end at the cell that doesn't fit, the key at the run's end, and the newline bit of the run's last cell) plus a few pick and maximum atoms. With one-hot reads it costs 29,593, because the run's end is a new position per line slot, and reading the key and newline bit there needs one-hot groups of 257 comparisons each.

### Tables and validation

The executor validates every source cell's range on every evaluation. At capacity 256 with index reads, the source table has 54,211 cells, 53,917 of them tables. Validation takes about 49 µs of an evaluation of about 447 µs (`report.ts tables`, rough).

JS builds the class table once per process, in 35 to 63 ms across runs, and the property and pair tables in about 1 to 2 ms. `report.ts` prints the time of the first call, which builds the table; later calls return the same table.

### What a font change rewrites

`report.ts font` loads the 156-code-point paragraph (92 distinct code points) and changes the fake canvas from 16 px to 20 px. text-editing has no font change path, so its row packs the paragraph with text-editing's width table at both sizes, in JS without running its circuit, and counts the packed values that differ.

| | Table entries rewritten | Of which changed | Source cells written | Text cells changed | Lines before and after |
| --- | ---: | ---: | ---: | ---: | --- |
| code points | 92 advance entries | 91 | 92 | 0 | 7 and 8 |
| text-editing | 92 grapheme table entries | 91 | 247: 92 table entries and 155 text cells | 155 of 156 | |

In both rows the entry that doesn't change is the newline's, whose advance stays 0, and in text-editing the newline's packed text cell doesn't change either. The class, property and pair tables never change with the font.

## What this shows about how far the approach goes

### What fit well

- **A code point is a good cell.** It's exact in FP32, one number moves per edit like text-editing's packed cell, and it's a key into Unicode's own data instead of a code JS assigned.
- **Table reads made break decisions free per cell.** 8 index reads give the class, advance, three property bits and the break bit, in 3 layers. text-editing's 8 atoms in 5 layers only gave the property bits and the advance.
- **The two-level table fits the executor.** Storing offsets instead of page numbers makes the second index a plain sum. Letting the index read floor a shifted cell saves 3 atoms and 3 layers per cell. All 1,114,112 code points read back with no mismatches.
- **Line breaking rules became data.** 41 classes and a 41 × 41 bit table follow pretext's analysis on all but 36 of 76,302 boundaries in the test families. Changing a rule between the existing classes is a table write, not a circuit change. A rule that needs a new class, e.g. `!` apart from the other EX code points, changes the class count, which is the pair read's coefficient (class × 41) and the size of the class property and pair tables, so the circuit is rebuilt.
- **The string boundary moved down.** JS no longer segments graphemes, runs a regex per new grapheme, keeps a vocabulary that fills up, or feeds pasted codes through one-hot lookups.
- **A font change is a table change.** It rewrites the advance entries of the code points seen so far: 92 entries for the paragraph, and no text cells.
- **Reading at counts the circuit already has pays off here too.** With index reads, the one-key circuit at capacity 256 is 42,326 live ops, 22% below text-editing. Keeping CJK runs whole then adds one emergency pair read per cell, a suffix minimum, and 4 reads plus a few pick and maximum atoms per line slot, 5,482 live ops in all.

### What got awkward

- **Tables are large, and the executor validates them on every evaluation.** 53,917 table cells cost about 49 µs of about 447 µs per evaluation, though almost all of them change only when a new code point or font arrives.
- **Some rules need more than two neighbors.** Number ranges versus signs (176 layouts) and pretext's lone kinsoku opener would need the class before the pair. A table over three classes would be 41^3 = 68,921 cells. `!` versus `?` before letters (13 layouts) looks similar but isn't: both are EX, so finer classes would keep it a pair rule.
- **Advance pages are per block of 128.** The typing paragraph's 92 code points needed 34 pages plus the all-zero page (4,480 cells), because ideographs spread across many blocks. The page pool is fixed at build time, and a full pool drops new code points and reports how many.
- **One code point per cell splits grapheme clusters.** An emoji ZWJ sequence, a flag, or a letter with combining marks takes several cells, each with its own advance and a caret stop inside it. A line may break after a ZWJ, where UAX #14 says it mustn't.
- **Advances per code point ignore kerning and shaping.** The fake canvas adds per character, so pretext agrees, but real fonts won't. The demo draws one span per code point at the circuit's positions.
- **The shift read is outside index-read's promise.** `validateIndexReads` wants integer index forms, so this folder has its own check that also accepts a cell times 2^-7.
- **The runtime copy needed changes for large tables.** index-read's builder copied the candidate array of each read, built its expression key by joining every candidate into a string (about 170 KB for a class page read, times about 2,000 reads per circuit), and scanned every candidate once per read while building and compiling. The copy here keys a table by its array's identity and visits each array once per circuit and per compile. Counts and program semantics don't change.
- **Keeping CJK runs whole is expensive with one-hot reads** (29,593 more live ops), because a new position per line slot needs new one-hot groups.

### What stayed outside the circuit

- Newline normalization (CR LF, CR and FF to LF, as pretext does in pre-wrap) and iterating code points.
- Building the class table once, from pretext's UAX #14 data plus five sets: glue, opening quotes, closing quotes, apostrophes, and pretext's CJK ranges.
- Measuring a code point the first time it appears, and choosing its advance page.
- Key names to events, IME composition (the browser commits text, and the demo inserts it), clipboard, focus and pointer capture.
- Not built: grapheme clusters, bidi, kerning and shaping, tab stops, drawing a hyphen at a soft hyphen break, `word-break: keep-all`, `line-break: strict` or `loose`, language tailoring, and dictionary breaks for Thai and similar scripts.

## How it connects to the talk

text-editing's grapheme table was a tokenizer. JS gave each new grapheme the next free code, decided its class with a regex, and dropped graphemes once 96 codes were taken. The talk says tokenizers will go away, and this prototype removes this one by going one level lower: cells hold Unicode's own numbers, and the circuit looks up class, advance and break rules at those numbers.

What appeared at the higher level is line breaking for Chinese, Japanese and Korean inside the circuit: breaks between ideographs, kinsoku, and numbers that stay together. The per cell cost stayed the same. The granularity gap is real: a code point isn't what a person sees as one character, and emoji or accented letters built from several code points now split across cells. Homogeneity is also real: every cell does the same 8 reads, and the uniform way of directing all of them is writing tables. Line breaking behavior is 1,681 bits, and a font is a set of advance entries.

## Open questions and next steps

- **Grapheme clusters as another pair table.** UAX #29's grapheme rules are almost all pair rules over about 15 classes. The exceptions, ZWJ sequences and regional indicator pairs, need one more cell of context or a parity scan. A boundary bit per cell would stop the caret, deletion and line breaks inside clusters.
- **A second pair read over the classes before and after**, e.g. `(class[c - 1], class[c + 1])`, might separate number ranges from signs without a 68,921-cell table.
- **Finer classes for `!`.** Splitting `!` from the other EX code points, and ASCII letters from the other letters, would follow Chrome's pair table for ASCII with pair rules and fix the 12 layouts that only `!` causes.
- **Validate static tables once, when JS writes them**, instead of on every evaluation.
- **Cheaper advances for CJK:** a smaller page size, or advance classes, since most ideographs share one advance in a font.
- **Generated code and the GPU:** in generated JS or WGSL a table read is a texel fetch, and the class and pair tables would be shared by every instance.
- **The space after an overflowing CJK unit:** check whether Chrome does what pretext does, before deciding which one the editor should follow.
- **Real fonts:** compare the demo's per code point spans with native text rendering, and measure how much per code point advances drift from shaped text.

## Merged from text-editing, September 16, 2026

[text-editing](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/text-editing) put a text field's editing model into one circuit over grapheme codes, and this folder started as a copy of it. Its grapheme version, which `report.ts` and `pretext-agreement.ts` measure as the baseline, moved here with its tests as the `grapheme-*.ts` files and `fake-canvas.ts` (see [Files](#files)). Its demo, `report.ts`, `pretext-agreement.ts`, generated JS (`codegen.ts`) and README are at the tag. The numbers below are text-editing's measurements from September 13, 2026, on the grapheme version at 256 cells and 12 line slots.

- **Size and exactness.** One key per evaluation is 54,431 live operations in 239 layers. A key that may read line geometry (up, down, Home, End, click) adds 29,115 operations, and a key that only reads the buffer (typing, deleting, left and right, word jumps) adds 12,068. A second key adds about 180 layers, and later keys about 120 each with a layout or about 59 without. Four keys in one evaluation took 739 µs with one layout slot, against 1,780 µs for four one-key evaluations. Operations grow by about 210 per cell, and layers by 8 per doubling of the capacity. Layout values are integers in quarter pixels, and the circuit matched a plain JS editor on every one of about 35,000 random frames, at capacities 17 to 512 with up to 4 keys per evaluation.
- **Constructions.** An edit replaces `[editStart, editEnd)` with the pasted codes through a head mask, a tail mask and two barrel shifters of log2(capacity) stages: 6,387 operations, and about 50 layers whatever the edit. `shift: 'gather'` uses one gather read per cell instead: 50,623 operations and 213 layers for the whole circuit, but 168,498 gather table entries. Word targets are tournaments of maxima and minima at the caret, which saved 2,822 operations against two more prefix scans. Position keys are parallel prefix sums of advances (Sklansky by default; Brent-Kung gives 47,123 operations in 255 layers), plus `maxWidthLimit` per newline, so no line reaches past a newline. The line walk is 32 layers of prefix scans, then exactly 12 layers per line slot. Up and down keep a preferred x, and every other key clears it.
- **The integer comparison.** `[a >= b]` is one boolean atom on `0.5 + (a - b) × 2^-24`, with the partial sums checked from declared ranges while building, where a ReLU ramp takes 3 operations. numeric-ui-core.ts builds the same form as `emitCompare`'s integer bits with `{endWithBoolean: true}` ([execution-model.md](../../../docs/execution-model.md#comparisons)).
- **FP32 budget.** Position keys must satisfy about `2 × capacity × (1023 + maxWidthLimit) < 2^23`, which the builder checks. At quarter-pixel units, capacity 256 fits fields up to 3,584 px, 512 up to 1,536 px, and 1,024 only 512 px. Capacity 2,048 doesn't build.
- **Limits.** Lines past the 12th slot aren't laid out, and an overflow output reports it. text-editing's demo hid the caret while that output was set, while this folder's demo shows the warning and keeps the caret visible (see [Browser check](#browser-check)). A full 96-entry width table drops new graphemes. End on a soft-wrapped line lands before the trailing space, so the editor keeps no caret affinity state. In Chrome, canvas measured an emoji at 21 px while the DOM drew it at 17 px, so the next glyph started 4 px too far right, which wasn't fixed.
- **Bugs the checks found.** Using a space's own left edge as its fit edge let trailing spaces push a line break, so fit edges became a prefix maximum over the right edges of non-space cells. The JS width table put U+00A0 in the space class, and 1,011 of 2,460 layouts with no-break spaces differed from pretext. `grapheme-input.test.ts` checks the fix.
- **Generated JS.** At capacity 64, JavaScriptCore settled at about 32 µs per evaluation after 6 s, 3.5 times faster than the executor. At capacity 256 it stayed around 20 ms per evaluation for the first 9 to 12 s, then settled at about 950 µs (3,940 functions of 16 rows) or 600 to 700 µs (1,011 functions of 64 rows), still slower than the executor's 430 µs.
- **Ideas not tried.** If the executor accepted a run of ones as a group, the atoms that take differences of neighboring bits would go away: about 3,300 per layout key and 6,700 for the final layout at 256 cells. Comparing fit edges with the start key plus maxWidth directly, and reading the next start through one gather over a combined case one-hot, might bring a line slot from 12 to about 9 layers. Scrolling by carrying the first visible line's start in state, and undo that records only the edit range and the removed codes, weren't built.

## Browser check

2026-09-13, Chrome, in a hidden tab with a 1,160 by 853 CSS px viewport, served with `bun lab/ui-exploration/code-points/demo.html`. The hidden tab didn't render frames on its own, so a console script replaced `requestAnimationFrame` with a Worker timer every 16 ms.

- Loads, no console errors, with the textarea focused. The panel: 77,100 live ops (7,135 index reads), 572 layers, 160,405 stored weights, built in 584 ms. The starter text is 62 code points on 2 lines at 380 px: "Type in any script: 中文、日本語のかな、한국어, " and "or English. 句読点「。」は行頭に来ません。".
- A real click after the text, then real typing of " Price $1,299.99 on 2025-09-13.": 93 code points on 3 lines, "11 events in 3 evaluations, 5.80 ms". The space before "Price" hangs at the end of line 2.
- Real clicks on Insert Chinese, Insert Korean and Insert mixed: 208 code points on 7 lines, and 111 code points measured on 54 of 64 advance pages.
- A real drag of the width slider to 160 px: lines 1 to 11 end within the 160 px box (at most 153.0 px, with trailing spaces hanging), no line starts with 、, 。 or 」, 「 starts a line, and "$1,299.99" stays on one line. The text then needs more than 12 lines, the warning appears, and line 12 holds all the remaining text unwrapped, 890.5 px wide and clipped by the field.
- Scripted IME composition on the hidden textarea, back at 380 px: while composing, the buffer stayed at 208 code points, and `compositionend` with "输入法。" added 4 code points in 1 event and cleared the textarea.
- Real typing of " 한글 OK": 218 code points.
- A real click on the font size button: "font change to 22px: 117 advance entries rewritten (117 changed), 117 source cells written, 0 text cells rewritten". The text rewrapped to 9 lines, all within 380 px (at most 379.5 px). Between neighboring glyphs, the DOM's right edge and the circuit's next left edge differ by at most 0.125 px either way, so canvas measurement and DOM rendering agree at 22 px.
- Real Backspace 3 times, ArrowLeft twice and Shift+ArrowLeft 3 times: " OK" was deleted, and "法。 " is drawn selected.
- Small problem, not fixed: while the text needs more than 12 lines, the caret and the hidden textarea follow the circuit's caret x, e.g. 890.5 px in the 160 px field. The field clips the caret, but `demo.ts` keeps the textarea at the caret so an input method's candidate window opens there. text-editing's demo hid its caret in the same state ([demo.ts at the tag](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/text-editing/demo.ts)).
- GIF: `~/Downloads/ui-exploration-code-points-demo.gif` (17 frames). No fixes.

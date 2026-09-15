Size: loop. Short entry: [patterns.md, "Following links one at a time"](../../../../patterns.md#following-links-one-at-a-time).

# Following links by doubling

Computes where every line of a paragraph starts from a table whose entry s is where the next line starts when a line starts at segment s, reaching line L with about log2 L reads that run one after another, instead of L.

```txt
segment s        0   1   2   3   4   5   6   7   8   9 | 10 = past the end
1 line later     3   3   4   6   6   8   9   9  10  10 | 10     nextStart[s]
2 lines later    6   6   6   9   9  10  10  10  10  10 | 10     (1 line later)[(1 line later)[s]]
4 lines later   10  10  10  10  10  10  10  10  10  10 | 10     (2 lines later)[(2 lines later)[s]]

line 1 = (1 line later)[0]        = 3         line 0 starts at 0
line 2 = (2 lines later)[0]       = 6
line 3 = (1 line later)[line 2]   = 9
line 4 = (4 lines later)[0]       = 10, past the end, so the paragraph has 4 lines
```

## The loop it replaces

```ts
let start = 0
for (let line = 0; line < lineSlots; line++) {
  starts.push(start)
  if (start < segmentCount) start = nextStart[start]
}
```

Pointer jumping (Wyllie, 1979) replaces every link by the link it points to, so each round doubles how far every link reaches. Any table of links works the same way, e.g. a comment's ancestor 8 levels up from a table of parents:

```ts
const jumps = [[...nextStart, segmentCount]]
for (let level = 1; 2 ** level < lineSlots; level++) {
  const previous = jumps[level - 1]
  jumps.push(previous.map(target => previous[target]))
}
for (let line = 1; line < lineSlots; line++) {
  const level = Math.floor(Math.log2(line))
  starts.push(jumps[level][starts[line - 2 ** level]])
}
```

## The circuit

Each `previous[target]` is a read at a computed index, `circuit.indexRead`, which is one operation at any table size ([pointer-jumping.ts](../examples/patterns/combining-steps/pointer-jumping.ts), trimmed):

```ts
const jumps: Wire[][] = [nextStart]
for (let level = 1; 2 ** level < lineSlots; level++) {
  const previous = jumps[level - 1]
  // Where the line 2^level lines later starts: jump 2^(level - 1) lines, twice.
  jumps.push(previous.map(target => circuit.indexRead(target, previous)))
}
const starts: Wire[] = [circuit.affine([], 0)]
for (let line = 1; line < lineSlots; line++) {
  const level = Math.floor(Math.log2(line))
  starts.push(circuit.indexRead(starts[line - 2 ** level], jumps[level]))
}
```

Every read of one level reads the level before, so a level is one layer. The table needs no past-the-end entry: a read at position segmentCount clamps to the last segment, whose next start is always segmentCount. When a read's index is a constant, e.g. line 0's start, the builder picks the entry while building, and the read costs no operation.

## Cost

For n segments and L line slots:

| Form | Operations | Layers | 63 segments, 32 line slots | 1,023 segments, 157 line slots |
| --- | --- | --- | --- | --- |
| walk | O(L) | O(L) | 94 operations, 32 layers | 469 operations, 157 layers |
| pointer jumping | O(n log L) | O(log L) | 342 operations, 7 layers | 7,623 operations, 10 layers |

The sizes include the line count, 2 ReLUs per line slot, but not the next-start table, which dominates at realistic sizes, e.g. 190,279 operations for 1,023 segments in index-read. Before numeric-ui-core.ts had the index read instruction, each read built a one-hot over n positions, about 3 operations per position, so pointer jumping grew like n² log L: 34,007 operations in 19 layers at 63 segments and 32 line slots ([chains](../sections/chains.md#way-3-pointer-jumping-for-linked-structures)).

## When it's exact

Selections over integer tables: positions are integers below 2^24, and a read copies them without rounding, so every grouping gives the same bits. The tests compare both circuits with the walk in both evaluators, over 60 random and 4 adversarial paragraphs at each of 1, 2, 10, 15 and 63 segments, with more and fewer line slots than lines, and over 12 paragraphs of 1,023 segments into 157 line slots. The adversarial paragraphs put every segment on its own line, hold the whole paragraph on one line, fill each line exactly, and follow one long line with lines of one segment.

The conditions: every `nextStart[s]` holds an integer within 1..n, and `nextStart[n − 1]` is n, as greedy line breaking gives, so that a read clamped at the end still reads n. `validateIndexReads` checks the integers in tests.

## When not to use it

- When few links need following, e.g. a card caption of at most 3 lines.
- When the next-start table dominates, as for text at 1,023 segments, or when each line needs its own width, which one next-start table can't express ([text](../sections/text.md#five-ways-to-recover-lines)).
- On today's CPU executor, where the walk is about 16 times fewer operations at 1,023 segments.

## Where it's used

- [chains](../sections/chains.md#way-3-pointer-jumping-for-linked-structures), way 3, with one-hot reads in [examples/chains/pointer-jumping.ts](../examples/chains/pointer-jumping.ts).
- [index-read](../../index-read/README.md): the line starts of a 1,023-segment paragraph from pretext's next-start table, 490 layers by walking and 66 by pointer jumping, in its copy of the runtime.
- [text](../sections/text.md#five-ways-to-recover-lines) lists pointer jumping among five ways to recover lines, and [text-walker](../../text-walker/README.md) built it with one-hots at 255 segments, where one-hots were 83% of 235,633 operations.
- Example and test: [pointer-jumping.ts](../examples/patterns/combining-steps/pointer-jumping.ts) and [pointer-jumping.test.ts](../examples/patterns/combining-steps/pointer-jumping.test.ts).

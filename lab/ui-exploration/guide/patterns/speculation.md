Size: loop. Short entry: [patterns.md, "A state machine over queued events"](../../../../docs/patterns.md#a-state-machine-over-queued-events).

# Speculation

Run the next block of steps once for every value the state could hold when the block starts, so the runs don't read the results of earlier steps, then keep the run that starts where the state actually is, like a carry-select adder picks each block's sum by the carry that actually arrived.

```txt
8 queued key events, 5 buttons, focus starts at 1          R = ArrowRight, L = ArrowLeft, - = empty entry

                     block 0: R R R -                 block 1: L - - -
runs from every start, in the same layers:
                     ends by start [3 4 4 4 4]        ends by start [0 0 1 2 3]
picks, one per block:
focus 1 --> [3 4 4 4 4] at 1 = 4 --> [0 0 1 2 3] at 4 = 3 --> final focus 3
```

A block's runs read only the block's own queue entries, so the runs of every block are computed in the same layers. Only the reads that pick a run form a chain, one read per block.

## The loop it replaces

Keyboard focus in a toolbar, over the key events queued in one frame, e.g. autorepeat while the main thread was busy:

```ts
let focusedIndex = initialFocus
for (const key of keyQueue) {
  if (key === 'ArrowRight') focusedIndex = Math.min(buttonCount - 1, focusedIndex + 1)
  else if (key === 'ArrowLeft') focusedIndex = Math.max(0, focusedIndex - 1)
  else if (key === 'Home') focusedIndex = 0
  else if (key === 'End') focusedIndex = buttonCount - 1
}
```

Each event's step reads the previous event's `focusedIndex`, so as a circuit the loop is 2 layers per event.

## The circuit

One key event on an integer focused index is 3 operations: `relu(moved) - relu(moved - (buttonCount - 1))` clamps the move, and a ReLU-gated product replaces the move for Home and End. Speculation builds each block's runs from constant starts, and reads the run where focus is ([speculation.ts](../examples/patterns/candidates-and-tables/speculation.ts)):

```ts
for (let firstEntry = 0; firstEntry < entryCount; firstEntry += form.blockSize) {
  const block = entries.slice(firstEntry, firstEntry + form.blockSize)
  // endByStart[start] is where focus ends after this block when the block starts at `start`.
  const endByStart = Array.from({length: buttonCount}, (_, start) => block.reduce(step, circuit.affine([], start)))
  // Pick the run that starts where focus actually is: 1 index read per block.
  finalFocus = circuit.indexRead(finalFocus, endByStart)
}
```

Indexed by the start, a block's runs are the block's transition table, so speculation is one more way to group the steps. Building each block's table by speculation over half-blocks, then halves of those, gives a balanced tree of table combines, which gives only each block's end. Keeping the state after every event from every start along the way gives Sklansky's network ([chains, way 2](../sections/chains.md#why-it-works-and-how-it-relates-to-way-1)), a [prefix scan](state-machine-prefix-scan.md) that gives the state before every event. When the state is a one-hot, e.g. the chains section's button, picking the run is a sum of ANDs instead of one index read.

## Cost

For k events, S possible values of the state carried between blocks, and blocks of B events: about S times the loop's operations, and about B × (one step's layers) + k / B layers, which is lowest at B about √k, so O(√k) depth. The loop is O(k) operations and O(k) layers.

Measured by the example's test, with 5 buttons:

| Events | Form | Operations | Layers | Index reads |
| ---: | --- | ---: | ---: | ---: |
| 16 | loop | 49 | 33 | 0 |
| 16 | speculation, blocks of 4 | 260 | 13 | 4 |
| 64 | loop | 193 | 129 | 0 |
| 64 | speculation, blocks of 8 | 1,000 | 25 | 8 |

## When it's exact

- The runs cover every value the state can hold when a block starts. When no run covers a start, the read picks the wrong run: the index read returns the nearest end of the table, or +0 with `{outOfRange: 'zero'}`, and every later block starts from the wrong focus.
- The index of each read that picks a run holds an integer within its declared range, which `validateIndexReads` checks in tests. Here every step is sums and ReLUs of integers below 2^23, and the host contract allows at most one key per queue entry, written as exact bits.
- The test compares both forms with the loop on all 3,125 queues of 4 events from every start, on 300 random queues each of 16 and 64 events, and on named queues, e.g. End followed by ArrowRight until the queue is full. Every queue runs through the compiled program, and every 20th queue also through `evaluateReference`, whose values `validateIndexReads` checks.

## When not to use it

- When the carried state has many possible values, since every block runs once per value, e.g. a line's start among 1,000 segments, where [pointer jumping](pointer-jumping.md) fits better, or a continuous value, e.g. where a dragged window landed, which no finite set of runs covers.
- On today's CPU executor, whose time follows operations and not layers: speculation costs about S times the loop's operations there, and makes nothing faster ([chains](../sections/chains.md#why-depth-matters-and-when)).
- When depth matters most and a prefix scan applies: speculation with blocks of √k sits between the loop and the scan, both in operations and in depth.

## Where it's used

- [Chains, way 2](../sections/chains.md#way-2-speculation): a button that acts on release, over 64 queued pointer events, is 1,612 operations and 17 layers with speculation, against the loop's 516 operations and 65 layers ([button-forms.ts](../examples/chains/button-forms.ts)).
- The guide's [decisions that can wait](../review-and-decisions.md#decisions-that-can-wait): speculation over press sessions, i.e. running one press session's hit tests against each possible outcome of the session before it, e.g. which window rose to the front, isn't built, because a drag's outcome includes where the window landed.
- [Run every candidate, then pick one](run-every-candidate.md) also runs several candidates, but keeps the one with the best score instead of the one that matches.
- Example and test: [speculation.ts](../examples/patterns/candidates-and-tables/speculation.ts) and [speculation.test.ts](../examples/patterns/candidates-and-tables/speculation.test.ts).

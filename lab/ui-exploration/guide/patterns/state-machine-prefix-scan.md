Size: loop. Short entry: [patterns.md, "A state machine over queued events"](../../../../docs/patterns.md#a-state-machine-over-queued-events).

# Events through a state machine, as a prefix scan

Computes a button's state before every pointer event queued in one frame, and how many clicks the queue holds, with a chain of combines that grows like log2 k for k events instead of k.

```txt
each event as a table from state to next state, over the states idle, armed, pressedOutside:
  downOnButton = [armed, armed, pressedOutside]      moveOutside = [idle, pressedOutside, pressedOutside]

two events as one table, one read per state:  combined[state] = later[earlier[state]]
  downOnButton, then moveOutside = [pressedOutside, pressedOutside, pressedOutside]

events     T0       T1       T2       T3       T4       T5       T6       T7
            \_______/         \_______/         \_______/         \_______/        combines, level 1
             T0..1             T2..3             T4..5             T6..7
                \_________________/                 \_________________/            level 2
                      T0..3                               T4..7
                         \___________________________________/                     level 3
                                          T0..7
the state after event 7 is T0..7[initialState], and the other prefixes, e.g. T0..2 and T4..6, fill in the same way
```

## The loop it replaces

```ts
let state = initialState
let clicks = 0
for (const event of events) {
  if (state === armed && event === 'up') clicks++
  state = nextButtonState(state, event)
}
```

Each iteration reads the state the previous iteration produced. Reducing over tables instead of states removes that dependency:

```ts
const tables = events.map(event => [idle, armed, pressedOutside].map(state => nextButtonState(state, event)))
const combine = (earlier: number[], later: number[]) => earlier.map(state => later[state]!)
const finalState = tables.reduce(combine)[initialState]
```

`combine(combine(a, b), c)` equals `combine(a, combine(b, c))`, because both mean "a, then b, then c". So the reduce can combine events 0 and 1, events 2 and 3, and so on at the same time.

## The circuit

The machine's tables are source cells holding integers that JavaScript writes: `next[state × 5 + eventKind]` and `clicks[state × 5 + eventKind]`, with one event kind per queue entry, e.g. 4 for 'up' and 0 for an empty entry. Every read is one `circuit.indexRead` or `circuit.indexReadAffine` operation ([state-machine-prefix-scan.ts](../examples/patterns/combining-steps/state-machine-prefix-scan.ts), trimmed):

```ts
// tables[event][state]: the state after this event, one read per state, all in the first layer.
const tables = eventKinds.map(kind => Array.from({length: stateCount}, (_, state) =>
  circuit.indexReadAffine([[kind, 1]], state * eventKindCount, nextCells, 'clamp', 'clamp')))
// Two events as one table: later[earlier[state]].
const prefixes = sklanskyPrefix(tables, (earlier, later) => earlier.map(middle => circuit.indexRead(middle, later)))
const statesAfter = prefixes.map(prefix => circuit.indexRead(initialState, prefix))
// The click reads depend only on the state before each event and the event kinds, not on each other.
const clicks = circuit.affine(statesBefore.map((state, entry) =>
  [circuit.indexReadAffine([[state, eventKindCount], [eventKinds[entry], 1]], 0, clickCells, 'clamp', 'clamp'), 1]))
```

`sklanskyPrefix` and `brentKungPrefix` in [prefix-networks.ts](../examples/patterns/combining-steps/prefix-networks.ts) compute every prefix, which per-event outputs need. A plain balanced tree gives only the final state. The loop form carries the state with one read per event, `state = next[state × 5 + eventKind]`. Because the tables are cells, one compiled program runs any machine with the same number of states: the tests run the button and a toggle switch that flips on release through the same program.

## Cost

For k events and S states:

| Form | Operations | Layers | Measured, 3 states and 64 events |
| --- | --- | --- | --- |
| loop | O(k) | O(k) | 129 operations, 65 layers |
| Sklansky's network | O(S × k log k) | O(log k) | 897 operations, 10 layers |
| Brent-Kung's network | O(S × k) | O(log k), with about twice as many levels | 681 operations, 14 layers |

At 256 events, the loop is 513 operations in 257 layers, Sklansky's scan 4,353 in 12, and Brent-Kung's 2,787 in 18. A scan's layers are its combine levels plus 4: the event tables, applying each prefix to the initial state, the click reads and the click sum. The [chains](../sections/chains.md#way-1-combine-steps-with-a-prefix-scan) section stores each table as a transition matrix of bits instead, where combining two tables takes up to S³ products instead of S reads: Sklansky's scan over 64 events of the same button was 2,872 operations in 9 layers there, one layer fewer because each event's matrix is a sum of event bits that needs no layer of its own.

## When it's exact

Selections over integer tables: a read copies an integer without rounding, so every grouping of the combines gives the same bits. The tests compare the state before every event, the final state and the click count of every form with the loop, in both evaluators, over all 1,875 queues of 4 events from every initial state, over 300 random and 18 adversarial queues each of 16 and 64 events, e.g. only empty entries, only ups, back-to-back clicks, and a press that moves outside and back inside, and over 200 runs each of 16 and 64 events that alternate the button and the toggle switch.

The conditions: every table cell holds an integer within 0..S − 1, and every event kind an integer within 0..4. The executors check the declared ranges on every evaluation, but a fractional cell doesn't throw: the read floors it, and only `validateIndexReads` catches it in tests.

## When not to use it

- On today's CPU executor, which pays per operation: at 64 events the loop is about 7 times fewer operations than Sklansky's scan.
- When the state has cheaper structure, e.g. a count, a latch or an OR that resets. input handled pointer moves with running counts of downs and ups and latches, at no extra depth per queued event.
- When an event's table depends on state, e.g. whether a move passes the drag threshold depends on the press point. Compute that state with its own scan first.

## Where it's used

- [chains](../sections/chains.md#way-1-combine-steps-with-a-prefix-scan), way 1: the same button as transition matrices of bits, with Sklansky's and Brent-Kung's networks, in [examples/chains](../examples/chains/button-forms.ts).
- [input](../../input/README.md): keyboard focus over 12 controls as 13 × 13 transition matrices, at 16 queued key events, 31 layers with Sklansky's scan against 53 for the loop, for about twice the operations.
- [Running totals](running-totals.md) use the same prefix networks with additions as the combine.
- Example and test: [state-machine-prefix-scan.ts](../examples/patterns/combining-steps/state-machine-prefix-scan.ts) and [state-machine-prefix-scan.test.ts](../examples/patterns/combining-steps/state-machine-prefix-scan.test.ts).

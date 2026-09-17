// A queue of pointer events through a button's state machine, over the runtime in
// src/runtime/. The machine's transition table and click table live in source cells as
// integers that JavaScript writes, so one compiled program runs any machine with the
// same number of states, e.g. the button and a toggle switch. Three builds compute the
// state before every queued event, the final state and the click count:
// - 'loop': carry the state from one event to the next, one index read per event.
// - 'sklansky' and 'brent-kung': turn each event into a table from state to next state,
//   combine tables with a prefix network, where combining two tables is one index read
//   per state, and read each prefix at the initial state.
import {Circuit, type Wire, asWire} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {brentKungPrefix, sklanskyPrefix} from './prefix-networks.ts'

export const buttonEvents = ['none', 'downOnButton', 'moveInside', 'moveOutside', 'up'] as const
export type ButtonEvent = typeof buttonEvents[number]
export const eventKindCount = buttonEvents.length

export const idle = 0
export const armed = 1
export const pressedOutside = 2

export function nextButtonState(state: number, event: ButtonEvent): number {
  if (state === idle) return event === 'downOnButton' ? armed : idle
  if (event === 'up') return idle
  if (state === armed) return event === 'moveOutside' ? pressedOutside : armed
  return event === 'moveInside' ? armed : pressedOutside
}

// The loop every build is checked against.
export function runButtonQueue(initialState: number, events: readonly ButtonEvent[]) {
  let state = initialState
  let clicks = 0
  for (const event of events) {
    if (state === armed && event === 'up') clicks++
    state = nextButtonState(state, event)
  }
  return {finalState: state, clicks}
}

export type MachineTables = {
  stateCount: number
  // next[state × eventKindCount + kind] is the state after an event of that kind.
  next: readonly number[]
  // clicks[state × eventKindCount + kind] is 1 when that transition counts as a click.
  clicks: readonly number[]
}

function tabulate(stateCount: number, transition: (state: number, event: ButtonEvent) => number): number[] {
  return Array.from({length: stateCount * eventKindCount}, (_, pair) =>
    transition(Math.floor(pair / eventKindCount), buttonEvents[pair % eventKindCount]!))
}

// The button as tables. States past the button's 3 keep their state.
export function buttonTables(stateCount: number): MachineTables {
  return {
    stateCount,
    next: tabulate(stateCount, (state, event) => (state >= 3 ? state : nextButtonState(state, event))),
    clicks: tabulate(stateCount, (state, event) => (state === armed && event === 'up' ? 1 : 0)),
  }
}

// A switch that flips on release, over the same events: 0 off, 1 pressed while off,
// 2 on, 3 pressed while on. Moving outside cancels a press. The count is the number of flips.
export const toggleTables: MachineTables = {
  stateCount: 4,
  next: tabulate(4, (state, event) => {
    if (state === 0) return event === 'downOnButton' ? 1 : 0
    if (state === 2) return event === 'downOnButton' ? 3 : 2
    if (event === 'up') return state === 1 ? 2 : 0
    if (event === 'moveOutside') return state === 1 ? 0 : 2
    return state
  }),
  clicks: tabulate(4, (state, event) => ((state === 1 || state === 3) && event === 'up' ? 1 : 0)),
}

// The same loop over tables, with every state before an event.
export function runQueue(tables: MachineTables, initialState: number, eventKinds: readonly number[]) {
  const statesBefore: number[] = []
  let state = initialState
  let clicks = 0
  for (const kind of eventKinds) {
    statesBefore.push(state)
    clicks += tables.clicks[state * eventKindCount + kind]!
    state = tables.next[state * eventKindCount + kind]!
  }
  return {statesBefore, finalState: state, clicks}
}

export type ScanForm = 'loop' | 'sklansky' | 'brent-kung'

export function buildEventQueue(stateCount: number, queueLength: number, form: ScanForm) {
  const tableSize = stateCount * eventKindCount
  const circuit = new Circuit(1 + 2 * tableSize + queueLength)
  // Cells: the initial state, the next-state table, the click table, then one event
  // kind per queue entry, e.g. 4 for 'up' and 0 for an empty entry.
  const initialState = circuit.source(0)
  const nextCells = Array.from({length: tableSize}, (_, pair) => circuit.source(1 + pair))
  const clickCells = Array.from({length: tableSize}, (_, pair) => circuit.source(1 + tableSize + pair))
  const eventKinds = Array.from({length: queueLength}, (_, entry) => circuit.source(1 + 2 * tableSize + entry))
  circuit.assumeRange(initialState, 0, stateCount - 1)
  for (const cell of nextCells) circuit.assumeRange(cell, 0, stateCount - 1)
  for (const cell of clickCells) circuit.assumeRange(cell, 0, 1)
  for (const cell of eventKinds) circuit.assumeRange(cell, 0, eventKindCount - 1)
  // table[state][kind] with the table flattened, as one index read.
  const readPair = (state: Wire, kind: Wire, table: readonly Wire[]) =>
    circuit.indexReadAffine([[state, eventKindCount], [kind, 1]], 0, table, 'clamp', 'clamp')

  let statesBefore: Wire[]
  let finalState: Wire
  if (form === 'loop') {
    statesBefore = []
    let state: Wire = initialState
    for (const kind of eventKinds) {
      statesBefore.push(state)
      state = readPair(state, asWire(kind), nextCells)
    }
    finalState = state
  } else {
    // tables[event][state] is the state after this event from that state: one index read
    // per state, all in the first layer.
    const tables = eventKinds.map(kind => Array.from({length: stateCount}, (_, state) =>
      circuit.indexReadAffine([[asWire(kind), 1]], state * eventKindCount, nextCells, 'clamp', 'clamp')))
    const network = form === 'sklansky' ? sklanskyPrefix : brentKungPrefix
    // Two events as one table: first `earlier`, then `later`, i.e. later[earlier[state]].
    const prefixes = network(tables, (earlier, later) => earlier.map(middle => circuit.indexRead(middle, later)))
    const statesAfter = prefixes.map(prefix => circuit.indexRead(initialState, prefix))
    statesBefore = [initialState, ...statesAfter.slice(0, -1)]
    finalState = statesAfter.at(-1)!
  }
  // The click bits depend only on the state before each event and the event kinds, not on each other.
  const clicks = circuit.affine(statesBefore.map((state, entry) => [readPair(state, asWire(eventKinds[entry]!), clickCells), 1] as const))
  return {circuit, initialState, nextCells, clickCells, eventKinds, statesBefore, finalState, clicks}
}

export type EventQueueCircuit = ReturnType<typeof buildEventQueue>

export function writeEventQueue(
  built: EventQueueCircuit,
  source: Float32Array,
  tables: MachineTables,
  initialState: number,
  eventKinds: readonly number[],
) {
  source[built.initialState] = initialState
  built.nextCells.forEach((cell, pair) => {
    source[cell] = tables.next[pair]!
  })
  built.clickCells.forEach((cell, pair) => {
    source[cell] = tables.clicks[pair]!
  })
  built.eventKinds.forEach((cell, entry) => {
    source[cell] = eventKinds[entry] ?? 0
  })
}

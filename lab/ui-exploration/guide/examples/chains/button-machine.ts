// A button that acts on release, the way native buttons behave: a press on the
// button arms it, moving the pointer outside disarms it, moving back inside arms it
// again, and a release while armed is a click. Between two events the button
// carries one of 3 states, and a queue of events affects later events only through
// that state. button-forms.ts builds the same queue three ways.
import {Circuit, type Wire} from '../../../../../numeric-ui-core.ts'

export const idle = 0
export const armed = 1
export const pressedOutside = 2
export const stateCount = 3

export type ButtonEvent = 'none' | 'downOnButton' | 'moveInside' | 'moveOutside' | 'up'
export const buttonEvents: readonly ButtonEvent[] = ['none', 'downOnButton', 'moveInside', 'moveOutside', 'up']

export function nextButtonState(state: number, event: ButtonEvent): number {
  if (state === idle) return event === 'downOnButton' ? armed : idle
  if (event === 'up') return idle
  if (state === armed) return event === 'moveOutside' ? pressedOutside : armed
  return event === 'moveInside' ? armed : pressedOutside
}

// The plain JavaScript loop that every circuit form is checked against.
export function runButtonQueue(initialState: number, events: readonly ButtonEvent[]) {
  let state = initialState
  let clicks = 0
  for (const event of events) {
    if (state === armed && event === 'up') clicks++
    state = nextButtonState(state, event)
  }
  return {finalState: state, clicks}
}

// The source cells for one queued event: exact bits, at most one of them 1. A slot
// with no event has all four at 0.
export type EventSlot = {downOnButton: Wire, moveInside: Wire, moveOutside: Wire, up: Wire}

export type ButtonQueueCircuit = {
  circuit: Circuit
  // The state before the first event as a one-hot: 3 source cells, exactly one of them 1.
  initialState: Wire[]
  slots: EventSlot[]
}

export function createButtonQueueCircuit(slotCount: number): ButtonQueueCircuit {
  const circuit = new Circuit(stateCount + 4 * slotCount)
  for (let wire = 0; wire < circuit.sourceSize; wire++) circuit.assumeRange(wire, 0, 1)
  const initialState = Array.from({length: stateCount}, (_, state) => state)
  const slots = Array.from({length: slotCount}, (_, slot) => {
    const firstCell = stateCount + 4 * slot
    return {downOnButton: firstCell, moveInside: firstCell + 1, moveOutside: firstCell + 2, up: firstCell + 3}
  })
  return {circuit, initialState, slots}
}

export function writeButtonQueue(
  queue: ButtonQueueCircuit,
  source: Float32Array,
  initialState: number,
  events: readonly ButtonEvent[],
) {
  source.fill(0)
  source[queue.initialState[initialState]!] = 1
  events.forEach((event, slot) => {
    if (event !== 'none') source[queue.slots[slot]![event]] = 1
  })
}

// matrix[from][to] is an exact bit that is 1 when the event moves the button from
// state `from` to state `to`. null stands for a constant 0, so nothing is built for
// it. Every row has exactly one 1, because an event takes each state to one state.
export type TransitionMatrix = readonly (readonly (Wire | null)[])[]

// state[s] is an exact bit that is 1 when the button is in state s; null is a constant 0.
export type StateBits = readonly (Wire | null)[]

export function eventTransitions(circuit: Circuit, slot: EventSlot): TransitionMatrix {
  const {downOnButton, moveInside, moveOutside, up} = slot
  return [
    // From idle, to idle, armed, pressedOutside.
    [circuit.affine([[downOnButton, -1]], 1), downOnButton, null],
    // From armed.
    [up, circuit.affine([[moveOutside, -1], [up, -1]], 1), moveOutside],
    // From pressedOutside.
    [up, moveInside, circuit.affine([[moveInside, -1], [up, -1]], 1)],
  ]
}

// AND of two exact bits as one ReLU-gated product: a × max(0, b) is a when b is 1,
// and 0 when b is 0.
export function and(circuit: Circuit, a: Wire, b: Wire): Wire {
  return circuit.reglu([[a, 1]], 0, [[b, 1]], 0)
}

// The state after one more event: next[to] = sum over `from` of
// (state[from] AND matrix[from][to]). Only the current state's row contributes, so
// the sum is again an exact bit.
export function applyTransitions(circuit: Circuit, state: StateBits, matrix: TransitionMatrix): StateBits {
  return Array.from({length: stateCount}, (_, to) => {
    const terms: [Wire, number][] = []
    state.forEach((isCurrent, from) => {
      const moves = matrix[from]?.[to] ?? null
      if (isCurrent !== null && moves !== null) terms.push([and(circuit, isCurrent, moves), 1])
    })
    return terms.length === 0 ? null : circuit.affine(terms)
  })
}

// Two events as one: combined[from][to] = sum over `middle` of
// (earlier[from][middle] AND later[middle][to]). Row `from` of `earlier` is the state
// reached when starting in `from`, so combining applies `later` to every row.
export function composeTransitions(
  circuit: Circuit,
  earlier: TransitionMatrix,
  later: TransitionMatrix,
): TransitionMatrix {
  return earlier.map(row => applyTransitions(circuit, row, later))
}

// The outputs every form shares: the final state, which JS writes back as next
// state, and the number of clicks. Once the state before every event is computed, the
// per-event click bits don't read each other.
export function buttonOutputs(
  circuit: Circuit,
  queue: ButtonQueueCircuit,
  statesBefore: readonly StateBits[],
  finalState: StateBits,
): Wire[] {
  const clickTerms: [Wire, number][] = []
  statesBefore.forEach((state, slot) => {
    const armedBefore = state[armed] ?? null
    if (armedBefore !== null) clickTerms.push([and(circuit, armedBefore, queue.slots[slot]!.up), 1])
  })
  const finalBits = finalState.map(bit => bit ?? circuit.affine([], 0))
  return [...finalBits, circuit.affine(clickTerms)]
}

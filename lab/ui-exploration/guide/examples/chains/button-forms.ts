// The same queue of button events (button-machine.ts) built three ways: one event
// after another, as a prefix scan of transition matrices, and by speculation.
import type {Wire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {brentKungPrefix, sklanskyPrefix} from '../../../../../src/runtime/prefix-networks.ts'
import {
  type ButtonQueueCircuit,
  type StateBits,
  type TransitionMatrix,
  applyTransitions,
  buttonOutputs,
  composeTransitions,
  createButtonQueueCircuit,
  eventTransitions,
} from './button-machine.ts'

export type ButtonForm =
  | {kind: 'sequential'}
  | {kind: 'prefix scan', network: 'sklansky' | 'brent-kung'}
  | {kind: 'speculation', blockSize: number}

export type BuiltButtonQueue = ButtonQueueCircuit & {roots: Wire[]}

type QueueStates = {statesBefore: StateBits[], finalState: StateBits}

// Which outputs the circuit keeps. 'final state and clicks' is what a frame needs: the
// state to write back and the number of clicks. 'every state after every event' also
// outputs the 3 state bits after each event. That matters for the size of a prefix
// scan: the click bits only read the `armed` column of each prefix, so with fewer
// outputs the compiler removes the ANDs of the other columns that nothing else reads.
export type ButtonOutputs = 'final state and clicks' | 'every state after every event'

export function buildButtonQueue(
  slotCount: number,
  form: ButtonForm,
  outputs: ButtonOutputs = 'final state and clicks',
): BuiltButtonQueue {
  const queue = createButtonQueueCircuit(slotCount)
  const matrices = queue.slots.map(slot => eventTransitions(queue.circuit, slot))
  const states = form.kind === 'sequential'
    ? sequentialStates(queue, matrices)
    : form.kind === 'prefix scan'
      ? prefixScanStates(queue, matrices, form.network)
      : speculationStates(queue, matrices, form.blockSize)
  // The final state's 3 bits, then the click count.
  const roots = buttonOutputs(queue.circuit, queue, states.statesBefore, states.finalState)
  if (outputs === 'every state after every event') {
    // statesBefore[i + 1] is the state after event i. The state after the last event
    // is the final state, which is already an output.
    for (const state of states.statesBefore.slice(1)) {
      for (const bit of state) roots.push(bit ?? queue.circuit.affine([], 0))
    }
  }
  return {...queue, roots}
}

// The forms the report measures and the tests check, with speculation using blocks
// of about √k events.
export function buttonForms(slotCount: number): {label: string, form: ButtonForm}[] {
  const blockSize = Math.max(1, Math.round(Math.sqrt(slotCount)))
  return [
    {label: 'sequential', form: {kind: 'sequential'}},
    {label: 'prefix scan, Sklansky', form: {kind: 'prefix scan', network: 'sklansky'}},
    {label: 'prefix scan, Brent-Kung', form: {kind: 'prefix scan', network: 'brent-kung'}},
    {label: `speculation, blocks of ${blockSize}`, form: {kind: 'speculation', blockSize}},
  ]
}

// The familiar loop: carry the state from one event to the next. Each event's step
// reads the state after the previous event, so depth grows by about one layer per event.
function sequentialStates(queue: ButtonQueueCircuit, matrices: readonly TransitionMatrix[]): QueueStates {
  const statesBefore: StateBits[] = []
  let state: StateBits = queue.initialState
  for (const matrix of matrices) {
    statesBefore.push(state)
    state = applyTransitions(queue.circuit, state, matrix)
  }
  return {statesBefore, finalState: state}
}

// prefixes[i] describes events 0..i together, for every possible starting state at
// once. Applying it to the actual initial state gives the state after event i.
function prefixScanStates(
  queue: ButtonQueueCircuit,
  matrices: readonly TransitionMatrix[],
  network: 'sklansky' | 'brent-kung',
): QueueStates {
  const scan = network === 'sklansky' ? sklanskyPrefix : brentKungPrefix
  const prefixes = scan(matrices, (earlier, later) => composeTransitions(queue.circuit, earlier, later))
  const statesAfter = prefixes.map(prefix => applyTransitions(queue.circuit, queue.initialState, prefix))
  return {statesBefore: [queue.initialState, ...statesAfter.slice(0, -1)], finalState: statesAfter.at(-1)!}
}

// Carry-select speculation: split the queue into blocks. Every block runs from each
// of the 3 possible start states, without reading the results of the blocks before
// it. Then one select per block picks the run that matches the actual start state,
// and that chain of selects is the only part where each block reads the block before it.
function speculationStates(
  queue: ButtonQueueCircuit,
  matrices: readonly TransitionMatrix[],
  blockSize: number,
): QueueStates {
  const statesBefore: StateBits[] = []
  let blockStartState: StateBits = queue.initialState
  for (let firstSlot = 0; firstSlot < matrices.length; firstSlot += blockSize) {
    // runsFromEveryStart[t][start] is the state after event t of this block when the
    // block starts in `start`. Indexed by `start`, those runs are exactly the rows
    // of the transition matrix for events 0..t of the block.
    const runsFromEveryStart: TransitionMatrix[] = []
    for (const matrix of matrices.slice(firstSlot, firstSlot + blockSize)) {
      const previousRuns = runsFromEveryStart.at(-1)
      runsFromEveryStart.push(
        previousRuns === undefined ? matrix : composeTransitions(queue.circuit, previousRuns, matrix),
      )
    }
    statesBefore.push(blockStartState)
    for (const runs of runsFromEveryStart.slice(0, -1)) {
      statesBefore.push(applyTransitions(queue.circuit, blockStartState, runs))
    }
    blockStartState = applyTransitions(queue.circuit, blockStartState, runsFromEveryStart.at(-1)!)
  }
  return {statesBefore, finalState: blockStartState}
}

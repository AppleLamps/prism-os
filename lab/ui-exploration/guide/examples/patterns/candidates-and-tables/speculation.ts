// Speculation: keyboard focus in a toolbar over a queue of key events, built two ways. The loop
// carries the focused index from one event to the next. Speculation splits the queue into blocks,
// runs every block once from each possible focused index at the block's start, so the runs don't
// read the results of earlier blocks, and then reads the run that starts where focus actually is, like a
// carry-select adder picks each block's sum by the carry that actually arrived.
//
// Host contract: the focused index is a whole number within 0..buttonCount - 1, and each queue entry
// holds at most one key, as exact bits.
import {Circuit, type Wire} from '../../../../../../numeric-ui-core.ts'

export type FocusKey = 'none' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
export const focusKeys: readonly FocusKey[] = ['none', 'ArrowLeft', 'ArrowRight', 'Home', 'End']

// The plain JavaScript loop every circuit form is checked against.
export function runFocusQueue(buttonCount: number, initialFocus: number, keys: readonly FocusKey[]): number {
  let focusedIndex = initialFocus
  for (const key of keys) {
    if (key === 'ArrowRight') focusedIndex = Math.min(buttonCount - 1, focusedIndex + 1)
    else if (key === 'ArrowLeft') focusedIndex = Math.max(0, focusedIndex - 1)
    else if (key === 'Home') focusedIndex = 0
    else if (key === 'End') focusedIndex = buttonCount - 1
  }
  return focusedIndex
}

// The source cells of one queue entry.
export type KeyEntry = {arrowLeft: Wire, arrowRight: Wire, home: Wire, end: Wire}

export type FocusForm = {kind: 'loop'} | {kind: 'speculation', blockSize: number}

// One key event on an integer focused index, in 3 operations and 2 layers.
function emitFocusStep(circuit: Circuit, buttonCount: number, focusedIndex: Wire, entry: KeyEntry): Wire {
  // JS: focusedIndex + 1 for ArrowRight and - 1 for ArrowLeft, an integer within -1..buttonCount.
  const moved: [Wire, number][] = [[focusedIndex, 1], [entry.arrowRight, 1], [entry.arrowLeft, -1]]
  // Clamped to 0..buttonCount - 1 as relu(moved) - relu(moved - (buttonCount - 1)), exact for integers.
  const aboveFirst = circuit.reglu([], 1, moved, 0)
  const pastLast = circuit.reglu([], 1, moved, -(buttonCount - 1))
  // Home and End replace the move: clamped × (1 - home - end) + (buttonCount - 1) × end.
  const kept = circuit.reglu([[aboveFirst, 1], [pastLast, -1]], 0, [[entry.home, -1], [entry.end, -1]], 1)
  const next = circuit.affine([[kept, 1], [entry.end, buttonCount - 1]])
  circuit.assumeRange(next, 0, buttonCount - 1)
  return next
}

export function buildFocusQueue(buttonCount: number, entryCount: number, form: FocusForm) {
  // Source cells: the focused index before the queue, then 4 bits per queue entry.
  const circuit = new Circuit(1 + 4 * entryCount)
  const initialFocus = circuit.source(0)
  circuit.assumeRange(initialFocus, 0, buttonCount - 1)
  const entries = Array.from({length: entryCount}, (_, entry): KeyEntry => {
    const firstCell = 1 + 4 * entry
    return {
      arrowLeft: circuit.source(firstCell),
      arrowRight: circuit.source(firstCell + 1),
      home: circuit.source(firstCell + 2),
      end: circuit.source(firstCell + 3),
    }
  })
  for (let cell = 1; cell < circuit.sourceSize; cell++) circuit.assumeRange(circuit.source(cell), 0, 1)
  const step = (focusedIndex: Wire, entry: KeyEntry) => emitFocusStep(circuit, buttonCount, focusedIndex, entry)

  let finalFocus: Wire = initialFocus
  // Each block's runs, for tests: blockRuns[block][start].
  const blockRuns: Wire[][] = []
  if (form.kind === 'loop') {
    for (const entry of entries) finalFocus = step(finalFocus, entry)
  } else {
    for (let firstEntry = 0; firstEntry < entryCount; firstEntry += form.blockSize) {
      const block = entries.slice(firstEntry, firstEntry + form.blockSize)
      // endByStart[start] is where focus ends after this block when the block starts at `start`. The runs
      // read only this block's entries, so the runs of every block share the same layers.
      const endByStart = Array.from({length: buttonCount}, (_, start) => block.reduce(step, circuit.affine([], start)))
      blockRuns.push(endByStart)
      // Pick the run that starts where focus actually is: 1 index read per block.
      finalFocus = circuit.indexRead(finalFocus, endByStart)
    }
  }
  return {circuit, initialFocus, entries, blockRuns, roots: [finalFocus]}
}

export function writeFocusQueue(
  built: ReturnType<typeof buildFocusQueue>,
  source: Float32Array,
  initialFocus: number,
  keys: readonly FocusKey[],
) {
  source.fill(0)
  source[built.initialFocus] = initialFocus
  keys.forEach((key, index) => {
    const entry = built.entries[index]!
    if (key === 'ArrowLeft') source[entry.arrowLeft] = 1
    else if (key === 'ArrowRight') source[entry.arrowRight] = 1
    else if (key === 'Home') source[entry.home] = 1
    else if (key === 'End') source[entry.end] = 1
  })
}

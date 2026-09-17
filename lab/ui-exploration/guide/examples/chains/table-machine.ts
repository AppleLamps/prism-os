// One circuit that runs any state machine with up to 4 states over the 5 button
// event kinds, with the machine's transition table held in source cells instead of
// written into the circuit. Two different machines are then two source tables for
// one compiled program, which is what lets different chains of logic run together
// as instances of that program. The price is interpreter overhead: for every event,
// the circuit reads the table through a one-hot over all (state, event kind) pairs.
import {Circuit, type Wire, asWire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {type ButtonEvent, type EventSlot, and, armed, buttonEvents, nextButtonState} from './button-machine.ts'

export const tableStateCount = 4
const eventKindCount = buttonEvents.length

export type MachineTable = {
  // next[from][eventKind] is the state after an event of that kind.
  next: readonly (readonly number[])[]
  // counts[from][eventKind] is 1 when that transition adds 1 to the output count, e.g. a click.
  counts: readonly (readonly number[])[]
}

// button-machine.ts's button as a table. State 3 is unused and stays put.
export const buttonTable: MachineTable = {
  next: Array.from({length: tableStateCount}, (_, from) =>
    buttonEvents.map(event => (from === 3 ? 3 : nextButtonState(from, event)))),
  counts: Array.from({length: tableStateCount}, (_, from) =>
    buttonEvents.map(event => (from === armed && event === 'up' ? 1 : 0))),
}

// A different machine over the same events: a switch that flips on release, where a
// press that moves outside cancels. States: 0 off, 1 pressed while off, 2 on,
// 3 pressed while on. The count is the number of flips.
const toggleNext = (from: number, event: ButtonEvent) => {
  if (from === 0) return event === 'downOnButton' ? 1 : 0
  if (from === 2) return event === 'downOnButton' ? 3 : 2
  if (event === 'up') return from === 1 ? 2 : 0
  if (event === 'moveOutside') return from === 1 ? 0 : 2
  return from
}
export const toggleTable: MachineTable = {
  next: Array.from({length: tableStateCount}, (_, from) => buttonEvents.map(event => toggleNext(from, event))),
  counts: Array.from({length: tableStateCount}, (_, from) =>
    buttonEvents.map(event => ((from === 1 || from === 3) && event === 'up' ? 1 : 0))),
}

// The plain JavaScript loop, for any table.
export function runTableMachine(table: MachineTable, initialState: number, events: readonly ButtonEvent[]) {
  let state = initialState
  let count = 0
  for (const event of events) {
    const eventKind = buttonEvents.indexOf(event)
    count += table.counts[state]![eventKind]!
    state = table.next[state]![eventKind]!
  }
  return {finalState: state, count}
}

export type TableMachineCircuit = {
  circuit: Circuit
  initialState: Wire[]
  // nextCells[from][eventKind][to] is an exact bit: 1 when the table sends `from` to `to`.
  nextCells: Wire[][][]
  countCells: Wire[][]
  slots: EventSlot[]
  // The final state as a one-hot, then the count.
  roots: Wire[]
}

export function buildTableMachine(slotCount: number): TableMachineCircuit {
  let cellCount = 0
  const allocate = () => asWire(cellCount++)
  const initialState = Array.from({length: tableStateCount}, allocate)
  const nextCells = Array.from({length: tableStateCount}, () =>
    Array.from({length: eventKindCount}, () => Array.from({length: tableStateCount}, allocate)))
  const countCells = Array.from({length: tableStateCount}, () => Array.from({length: eventKindCount}, allocate))
  const slots = Array.from({length: slotCount}, (): EventSlot =>
    ({downOnButton: allocate(), moveInside: allocate(), moveOutside: allocate(), up: allocate()}))
  const circuit = new Circuit(cellCount)
  for (let wire = 0; wire < circuit.sourceSize; wire++) circuit.assumeRange(circuit.source(wire), 0, 1)

  let state: Wire[] = initialState
  const countTerms: [Wire, number][] = []
  for (const slot of slots) {
    const none = circuit.affine([[slot.downOnButton, -1], [slot.moveInside, -1], [slot.moveOutside, -1], [slot.up, -1]], 1)
    // Same order as buttonEvents.
    const eventBits = [none, slot.downOnButton, slot.moveInside, slot.moveOutside, slot.up]
    // pairs[from × 5 + eventKind] is 1 for the current (state, event kind) pair: an
    // exact one-hot over 20 pairs, declared so the compiler turns each masked sum
    // over it into one gather read.
    const pairs = state.flatMap(isCurrent => eventBits.map(isEvent => and(circuit, isCurrent, isEvent)))
    circuit.assumeOneHot(pairs)
    const readTable = (cells: readonly Wire[]) =>
      circuit.affine(cells.map((cell, pair): [Wire, number] => [circuit.multiply(cell, pairs[pair]!), 1]))
    countTerms.push([readTable(countCells.flat()), 1])
    state = Array.from({length: tableStateCount}, (_, to) => {
      const isNext = readTable(nextCells.flatMap(row => row.map(cells => cells[to]!)))
      circuit.assumeRange(isNext, 0, 1)
      return isNext
    })
  }
  return {circuit, initialState, nextCells, countCells, slots, roots: [...state, circuit.affine(countTerms)]}
}

export function writeTableMachine(
  built: TableMachineCircuit,
  source: Float32Array,
  table: MachineTable,
  initialState: number,
  events: readonly ButtonEvent[],
) {
  source.fill(0)
  source[built.initialState[initialState]!] = 1
  for (let from = 0; from < tableStateCount; from++) {
    for (let eventKind = 0; eventKind < eventKindCount; eventKind++) {
      source[built.nextCells[from]![eventKind]![table.next[from]![eventKind]!]!] = 1
      source[built.countCells[from]![eventKind]!] = table.counts[from]![eventKind]!
    }
  }
  events.forEach((event, slot) => {
    if (event !== 'none') source[built.slots[slot]![event]] = 1
  })
}

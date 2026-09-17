import {describe, expect, test} from 'bun:test'
import {Circuit, type Wire} from '../../src/runtime/numeric-ui-core.ts'
import {brentKungPrefix, sklanskyPrefix} from '../../src/runtime/prefix-networks.ts'

// Combines strings, so any wrong grouping or order shows up in the text. Each item also holds the length of the longest
// chain of combines that produced it.
type Tracked = {text: string, depth: number}

function runStrings(network: typeof sklanskyPrefix, count: number) {
  let combines = 0
  const items = Array.from({length: count}, (_, index): Tracked => ({text: `${index},`, depth: 0}))
  const prefixes = network(items, (earlier, later) => {
    combines++
    return {text: earlier.text + later.text, depth: Math.max(earlier.depth, later.depth) + 1}
  })
  return {prefixes, combines, depth: Math.max(...prefixes.map(prefix => prefix.depth))}
}

// A state machine over queued events as a prefix scan: each event is a table of S index reads from state to next state,
// and two tables combine as later[earlier[state]]. With the initial state in a cell, each prefix is read at that cell.
// With the constant initial state 0, each prefix is read at entry 0.
function buildStateMachineScan(network: typeof sklanskyPrefix, stateCount: number, eventCount: number, symbolCount: number, initial: 'cell' | 'constant') {
  const tableSize = stateCount * symbolCount
  const circuit = new Circuit(1 + tableSize + eventCount)
  const cell = (index: number, maximum: number) => {
    const wire = circuit.source(index)
    circuit.assumeRange(wire, 0, maximum)
    circuit.assumeGrid(wire, 1)
    return wire
  }
  const initialState = cell(0, stateCount - 1)
  const next = Array.from({length: tableSize}, (_, entry) => cell(1 + entry, stateCount - 1))
  const symbols = Array.from({length: eventCount}, (_, event) => cell(1 + tableSize + event, symbolCount - 1))
  const tables = symbols.map(symbol => Array.from({length: stateCount}, (_, state) =>
    circuit.indexReadAffine([[symbol, 1]], state * symbolCount, next, 'clamp', 'clamp')))
  let combines = 0
  const prefixes = network(tables, (earlier: Wire[], later: Wire[]) => {
    combines++
    return earlier.map(middle => circuit.indexRead(middle, later))
  })
  const statesAfter = prefixes.map(prefix => initial === 'cell' ? circuit.indexRead(initialState, prefix) : prefix[0]!)
  const program = circuit.compileTensorProgram(statesAfter)
  return {circuit, statesAfter, combines, liveOperations: program.valueCount - program.sourceSize}
}

describe('prefix networks', () => {
  test('every prefix is the ordered combination of its items, for 1 to 70 items', () => {
    for (let count = 1; count <= 70; count++) {
      const expected = Array.from({length: count}, (_, index) =>
        Array.from({length: index + 1}, (_, item) => `${item},`).join(''))
      expect(runStrings(sklanskyPrefix, count).prefixes.map(prefix => prefix.text)).toEqual(expected)
      expect(runStrings(brentKungPrefix, count).prefixes.map(prefix => prefix.text)).toEqual(expected)
    }
  })

  test('combines and longest chains follow the formulas for powers of two', () => {
    for (const count of [4, 16, 64, 256]) {
      const log = Math.log2(count)
      expect(runStrings(sklanskyPrefix, count)).toMatchObject({combines: (count / 2) * log, depth: log})
      expect(runStrings(brentKungPrefix, count)).toMatchObject({combines: 2 * count - 2 - log, depth: 2 * log - 2})
    }
  })

  test('a state machine scan gives the loop\'s states, in S × (k + combines) + k live operations, or k + S × combines from a constant initial state', () => {
    const stateCount = 4
    const eventCount = 32
    const symbolCount = 3
    let seed = 7
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (const network of [sklanskyPrefix, brentKungPrefix]) {
      for (const initial of ['cell', 'constant'] as const) {
        const scan = buildStateMachineScan(network, stateCount, eventCount, symbolCount, initial)
        expect(scan.liveOperations).toBe(initial === 'cell'
          ? stateCount * (eventCount + scan.combines) + eventCount
          : eventCount + stateCount * scan.combines)
        const evaluate = scan.circuit.createTensorEvaluator(scan.statesAfter)
        for (let trial = 0; trial < 10; trial++) {
          const source = new Float32Array(scan.circuit.sourceSize)
          source[0] = initial === 'cell' ? Math.floor(random() * stateCount) : 0
          for (let entry = 0; entry < stateCount * symbolCount; entry++) source[1 + entry] = Math.floor(random() * stateCount)
          for (let event = 0; event < eventCount; event++) source[1 + stateCount * symbolCount + event] = Math.floor(random() * symbolCount)
          const statesAfter = evaluate(source)
          let state = source[0]
          for (let event = 0; event < eventCount; event++) {
            state = source[1 + state * symbolCount + source[1 + stateCount * symbolCount + event]!]!
            expect(statesAfter[event]).toBe(state)
          }
        }
      }
    }
  })
})

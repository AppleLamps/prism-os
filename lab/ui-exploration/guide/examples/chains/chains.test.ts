import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups, validateTensorEvaluation} from '../../../../../src/runtime/numeric-ui-core.ts'
import {buildButtonQueue, buttonForms} from './button-forms.ts'
import {type ButtonEvent, buttonEvents, runButtonQueue, stateCount, writeButtonQueue} from './button-machine.ts'
import {measureProgram} from './measure.ts'
import {buildLineStarts, greedyNextStarts, jumpLineStarts, walkLineStarts} from './pointer-jumping.ts'
import {brentKungPrefix, sklanskyPrefix} from './prefix-networks.ts'
import {buildTableMachine, buttonTable, runTableMachine, tableStateCount, toggleTable, writeTableMachine} from './table-machine.ts'

function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

describe('prefix networks', () => {
  // Combines strings, so any wrong grouping or order shows up in the text. Each item
  // also holds the length of the longest chain of combines that produced it.
  type Tracked = {text: string, depth: number}
  function run(network: typeof sklanskyPrefix, count: number) {
    let combines = 0
    const items = Array.from({length: count}, (_, index): Tracked => ({text: `${index},`, depth: 0}))
    const prefixes = network(items, (earlier, later) => {
      combines++
      return {text: earlier.text + later.text, depth: Math.max(earlier.depth, later.depth) + 1}
    })
    return {prefixes, combines, depth: Math.max(...prefixes.map(prefix => prefix.depth))}
  }

  test('every prefix is the ordered combination of its items, for 1 to 70 items', () => {
    for (let count = 1; count <= 70; count++) {
      const expected = Array.from({length: count}, (_, index) =>
        Array.from({length: index + 1}, (_, item) => `${item},`).join(''))
      expect(run(sklanskyPrefix, count).prefixes.map(prefix => prefix.text)).toEqual(expected)
      expect(run(brentKungPrefix, count).prefixes.map(prefix => prefix.text)).toEqual(expected)
    }
  })

  test('work and depth follow the formulas for powers of two', () => {
    for (const count of [4, 16, 64, 256]) {
      const log = Math.log2(count)
      expect(run(sklanskyPrefix, count)).toMatchObject({combines: (count / 2) * log, depth: log})
      expect(run(brentKungPrefix, count)).toMatchObject({combines: 2 * count - 2 - log, depth: 2 * log - 2})
    }
  })
})

describe('a queue of button events', () => {
  const oneHot = (state: number) => Array.from({length: stateCount}, (_, candidate) => (candidate === state ? 1 : 0))

  function expectMatchesLoop(
    slotCount: number,
    queues: readonly {initialState: number, events: ButtonEvent[]}[],
    outputs: Parameters<typeof buildButtonQueue>[2] = 'final state and clicks',
  ) {
    for (const {label, form} of buttonForms(slotCount)) {
      const built = buildButtonQueue(slotCount, form, outputs)
      const evaluate = built.circuit.createTensorEvaluator(built.roots)
      const source = new Float32Array(built.circuit.sourceSize)
      for (const [index, {initialState, events}] of queues.entries()) {
        writeButtonQueue(built, source, initialState, events)
        const actualOutputs = Array.from(evaluate(source))
        const expected = runButtonQueue(initialState, events)
        const expectedOutputs = [...oneHot(expected.finalState), expected.clicks]
        if (outputs === 'every state after every event') {
          // The state after event i is the loop's final state over the first i + 1 events.
          for (let event = 0; event < slotCount - 1; event++) {
            expectedOutputs.push(...oneHot(runButtonQueue(initialState, events.slice(0, event + 1)).finalState))
          }
        }
        if (actualOutputs.join() !== expectedOutputs.join()) {
          throw new Error(`${label}, k = ${slotCount}, ${outputs}: queue ${events.join(' ')} from state ${initialState} gave ${actualOutputs.join()}, expected ${expectedOutputs.join()}`)
        }
        // A few full checks of the compiled program against the reference evaluator.
        if (index < 3) validateTensorEvaluation(source, built.circuit, built.circuit.evaluateTensor(source))
      }
    }
  }

  test('every queue of 4 events from every initial state matches the loop', () => {
    const queues: {initialState: number, events: ButtonEvent[]}[] = []
    for (let initialState = 0; initialState < stateCount; initialState++) {
      for (let code = 0; code < buttonEvents.length ** 4; code++) {
        const events = Array.from({length: 4}, (_, slot) =>
          buttonEvents[Math.floor(code / buttonEvents.length ** slot) % buttonEvents.length]!)
        queues.push({initialState, events})
      }
    }
    expect(queues.length).toBe(1875)
    expectMatchesLoop(4, queues)
  })

  test('random queues of 16 and 64 events match the loop, with either set of outputs', () => {
    const random = createRandom(7)
    for (const slotCount of [16, 64]) {
      const queues = Array.from({length: 400}, () => ({
        initialState: Math.floor(random() * stateCount),
        events: Array.from({length: slotCount}, () => buttonEvents[Math.floor(random() * buttonEvents.length)]!),
      }))
      expectMatchesLoop(slotCount, queues)
      expectMatchesLoop(slotCount, queues, 'every state after every event')
    }
  })

  test('sizes printed by report.ts', () => {
    const sizes = (slotCount: number, outputs: Parameters<typeof buildButtonQueue>[2]) =>
      buttonForms(slotCount).map(({label, form}) => {
        const built = buildButtonQueue(slotCount, form, outputs)
        const {operations, layers, storedWeights} = measureProgram(built.circuit, built.roots)
        return `k=${slotCount} ${label}: ${operations} operations, ${layers} layers, ${storedWeights} weights`
      })
    // With every state after every event as outputs, fewer combines are removed as unread.
    expect([16, 64].flatMap(slotCount => sizes(slotCount, 'every state after every event'))).toEqual([
      'k=16 sequential: 177 operations, 17 layers, 627 weights',
      'k=16 prefix scan, Sklansky: 986 operations, 7 layers, 4320 weights',
      'k=16 prefix scan, Brent-Kung: 824 operations, 9 layers, 3423 weights',
      'k=16 speculation, blocks of 4: 469 operations, 9 layers, 1778 weights',
      'k=64 sequential: 705 operations, 65 layers, 2547 weights',
      'k=64 prefix scan, Sklansky: 5666 operations, 9 layers, 27432 weights',
      'k=64 prefix scan, Brent-Kung: 3722 operations, 13 layers, 16179 weights',
      'k=64 speculation, blocks of 8: 2121 operations, 17 layers, 8610 weights',
    ])
    expect([4, 16, 64].flatMap(slotCount => sizes(slotCount, 'final state and clicks'))).toEqual([
      'k=4 sequential: 36 operations, 5 layers, 123 weights',
      'k=4 prefix scan, Sklansky: 100 operations, 5 layers, 350 weights',
      'k=4 prefix scan, Brent-Kung: 100 operations, 5 layers, 350 weights',
      'k=4 speculation, blocks of 2: 70 operations, 5 layers, 223 weights',
      'k=16 sequential: 132 operations, 17 layers, 507 weights',
      'k=16 prefix scan, Sklansky: 568 operations, 7 layers, 2459 weights',
      'k=16 prefix scan, Brent-Kung: 586 operations, 9 layers, 2540 weights',
      'k=16 speculation, blocks of 4: 360 operations, 9 layers, 1355 weights',
      'k=64 sequential: 516 operations, 65 layers, 2043 weights',
      'k=64 prefix scan, Sklansky: 2872 operations, 9 layers, 13487 weights',
      'k=64 prefix scan, Brent-Kung: 2692 operations, 13 layers, 12272 weights',
      'k=64 speculation, blocks of 8: 1612 operations, 17 layers, 6427 weights',
    ])
  })
})

describe('one circuit for any 4-state machine', () => {
  test('the button and the toggle switch run through the same compiled program', () => {
    const random = createRandom(17)
    for (const slotCount of [4, 16, 64]) {
      const built = buildTableMachine(slotCount)
      const evaluate = built.circuit.createTensorEvaluator(built.roots)
      const source = new Float32Array(built.circuit.sourceSize)
      for (let run = 0; run < 400; run++) {
        const isButton = run % 2 === 0
        const table = isButton ? buttonTable : toggleTable
        const initialState = Math.floor(random() * (isButton ? stateCount : tableStateCount))
        const events = Array.from({length: slotCount}, () => buttonEvents[Math.floor(random() * buttonEvents.length)]!)
        writeTableMachine(built, source, table, initialState, events)
        const expected = runTableMachine(table, initialState, events)
        expect(Array.from(evaluate(source))).toEqual([
          ...Array.from({length: tableStateCount}, (_, state) => (state === expected.finalState ? 1 : 0)),
          expected.count,
        ])
        if (isButton) {
          const button = runButtonQueue(initialState, events)
          expect([expected.finalState, expected.count]).toEqual([button.finalState, button.clicks])
        }
        if (run < 2) validateOneHotGroups(built.circuit, built.circuit.evaluateReference(source))
      }
    }
  })

  test('sizes printed by report.ts', () => {
    const sizes = [4, 16, 64].map(slotCount => {
      const built = buildTableMachine(slotCount)
      const {operations, layers, storedWeights, gatherReads} = measureProgram(built.circuit, built.roots)
      return `k=${slotCount}: ${operations} operations, ${layers} layers, ${storedWeights} weights, ${gatherReads} gather reads`
    })
    expect(sizes).toEqual([
      'k=4: 105 operations, 10 layers, 180 weights, 20 gather reads',
      'k=16: 417 operations, 34 layers, 720 weights, 80 gather reads',
      'k=64: 1665 operations, 130 layers, 2880 weights, 320 gather reads',
    ])
  })
})

describe('line starts from a next-start table', () => {
  function randomParagraph(random: () => number, segmentCount: number) {
    // Widths from 20 to 80 px against a 160 px line, so every line holds 2 to 8 segments.
    const widths = Array.from({length: segmentCount}, () => 20 + Math.floor(random() * 61))
    return greedyNextStarts(widths, 160)
  }

  test('pointer jumping in plain JS matches the walk', () => {
    const random = createRandom(11)
    for (let paragraph = 0; paragraph < 300; paragraph++) {
      const segmentCount = 1 + Math.floor(random() * 80)
      const lineSlots = 1 + Math.floor(random() * 40)
      const nextStart = randomParagraph(random, segmentCount)
      expect(jumpLineStarts(nextStart, lineSlots)).toEqual(walkLineStarts(nextStart, lineSlots))
    }
  })

  test('both circuits match the walk', () => {
    const random = createRandom(13)
    for (const [segmentCount, lineSlots] of [[15, 8], [63, 32]] as const) {
      for (const form of ['sequential', 'pointer jumping'] as const) {
        const built = buildLineStarts(segmentCount, lineSlots, form)
        const evaluate = built.circuit.createTensorEvaluator(built.roots)
        for (let paragraph = 0; paragraph < 150; paragraph++) {
          const nextStart = randomParagraph(random, segmentCount)
          const source = Float32Array.from(nextStart)
          const expected = walkLineStarts(nextStart, lineSlots)
          expect(Array.from(evaluate(source))).toEqual([...expected.starts, expected.lineCount])
          if (paragraph < 2) validateOneHotGroups(built.circuit, built.circuit.evaluateReference(source))
        }
      }
    }
  })

  test('sizes printed by report.ts', () => {
    const sizes = ([[15, 8], [63, 32]] as const).flatMap(([segmentCount, lineSlots]) =>
      (['sequential', 'pointer jumping'] as const).map(form => {
        const built = buildLineStarts(segmentCount, lineSlots, form)
        const {operations, layers, storedWeights, gatherReads} = measureProgram(built.circuit, built.roots)
        return `${segmentCount} segments, ${lineSlots} line slots, ${form}: ${operations} operations, ${layers} layers, ${storedWeights} weights, ${gatherReads} gather reads`
      }))
    expect(sizes).toEqual([
      '15 segments, 8 line slots, sequential: 215 operations, 20 layers, 400 weights, 6 gather reads',
      '15 segments, 8 line slots, pointer jumping: 1043 operations, 11 layers, 1950 weights, 34 gather reads',
      '63 segments, 32 line slots, sequential: 3935 operations, 92 layers, 7744 weights, 30 gather reads',
      '63 segments, 32 line slots, pointer jumping: 34007 operations, 19 layers, 66926 weights, 278 gather reads',
    ])
  })
})

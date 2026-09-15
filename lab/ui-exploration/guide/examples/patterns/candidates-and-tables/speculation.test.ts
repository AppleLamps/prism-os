import {describe, expect, test} from 'bun:test'
import {validateIndexReads, validateTensorEvaluation} from '../../../../../../numeric-ui-core.ts'
import {createRandom, formatSize, measureProgram} from './measure.ts'
import {type FocusForm, type FocusKey, buildFocusQueue, focusKeys, runFocusQueue, writeFocusQueue} from './speculation.ts'

const buttonCount = 5

type Queue = {initialFocus: number, keys: FocusKey[]}

function formsFor(entryCount: number): FocusForm[] {
  return [{kind: 'loop'}, {kind: 'speculation', blockSize: Math.round(Math.sqrt(entryCount))}]
}

// Runs every queue through both forms and compares the final focus with the loop. Every 20th queue also runs
// through evaluateReference, whose values validateIndexReads checks.
function expectMatchesLoop(entryCount: number, queues: readonly Queue[]) {
  for (const form of formsFor(entryCount)) {
    const built = buildFocusQueue(buttonCount, entryCount, form)
    const evaluate = built.circuit.createTensorEvaluator(built.roots)
    const source = new Float32Array(built.circuit.sourceSize)
    queues.forEach(({initialFocus, keys}, index) => {
      writeFocusQueue(built, source, initialFocus, keys)
      const expected = runFocusQueue(buttonCount, initialFocus, keys)
      const actual = evaluate(source)[0]
      if (actual !== expected) throw new Error(`${form.kind}, ${entryCount} events: ${keys.join(' ')} from ${initialFocus} gave ${actual}, expected ${expected}`)
      if (index % 20 === 0) {
        const values = built.circuit.evaluateReference(source)
        expect(values[built.roots[0]!]).toBe(expected)
        validateIndexReads(built.circuit, values)
      }
      if (index < 2) validateTensorEvaluation(source, built.circuit, built.circuit.evaluateTensor(source))
    })
  }
}

describe('speculation over a queue of key events', () => {
  test('every queue of 4 events from every initial focus matches the loop', () => {
    const queues: Queue[] = []
    for (let initialFocus = 0; initialFocus < buttonCount; initialFocus++) {
      for (let code = 0; code < focusKeys.length ** 4; code++) {
        const keys = Array.from({length: 4}, (_, entry) => focusKeys[Math.floor(code / focusKeys.length ** entry) % focusKeys.length]!)
        queues.push({initialFocus, keys})
      }
    }
    expect(queues.length).toBe(3125)
    expectMatchesLoop(4, queues)
  })

  test('random and named queues of 16 and 64 events match the loop', () => {
    const random = createRandom(5)
    for (const entryCount of [16, 64]) {
      const repeat = (key: FocusKey, count: number): FocusKey[] => Array.from({length: count}, () => key)
      const named: Queue[] = [
        {initialFocus: 0, keys: repeat('ArrowRight', entryCount)},
        {initialFocus: buttonCount - 1, keys: repeat('ArrowLeft', entryCount)},
        {initialFocus: 0, keys: ['End', ...repeat('ArrowRight', entryCount - 1)]},
        {initialFocus: buttonCount - 1, keys: ['Home', ...repeat('ArrowLeft', entryCount - 1)]},
        {initialFocus: 0, keys: Array.from({length: entryCount}, (_, entry): FocusKey => (entry % 2 === 0 ? 'ArrowLeft' : 'ArrowRight'))},
        {initialFocus: 3, keys: repeat('none', entryCount)},
        {initialFocus: 2, keys: [...repeat('none', entryCount - 1), 'Home']},
      ]
      const randomQueues = Array.from({length: 300}, (): Queue => ({
        initialFocus: Math.floor(random() * buttonCount),
        keys: Array.from({length: entryCount}, () => focusKeys[Math.floor(random() * focusKeys.length)]!),
      }))
      expectMatchesLoop(entryCount, [...named, ...randomQueues])
    }
  })

  test("the pattern doc's diagram: 8 events in blocks of 4, from focus 1", () => {
    const keys: FocusKey[] = ['ArrowRight', 'ArrowRight', 'ArrowRight', 'none', 'ArrowLeft', 'none', 'none', 'none']
    const built = buildFocusQueue(buttonCount, 8, {kind: 'speculation', blockSize: 4})
    const source = new Float32Array(built.circuit.sourceSize)
    writeFocusQueue(built, source, 1, keys)
    const values = built.circuit.evaluateReference(source)
    expect(built.blockRuns.map(runs => runs.map(wire => values[wire]! + 0))).toEqual([[3, 4, 4, 4, 4], [0, 0, 1, 2, 3]])
    expect(values[built.roots[0]!]).toBe(3)
    expect(runFocusQueue(buttonCount, 1, keys)).toBe(3)
  })

  test('sizes quoted in the pattern doc', () => {
    const sizes = [16, 64].flatMap(entryCount => formsFor(entryCount).map(form => {
      const built = buildFocusQueue(buttonCount, entryCount, form)
      const label = form.kind === 'loop' ? 'loop' : `speculation, blocks of ${form.blockSize}`
      return `${entryCount} events, ${label}: ${formatSize(measureProgram(built.circuit, built.roots))}`
    }))
    expect(sizes).toEqual([
      '16 events, loop: 49 operations, 33 layers, 192 weights, 0 gather reads, 0 index reads',
      '16 events, speculation, blocks of 4: 260 operations, 13 layers, 916 weights, 0 gather reads, 4 index reads',
      '64 events, loop: 193 operations, 129 layers, 768 weights, 0 gather reads, 0 index reads',
      '64 events, speculation, blocks of 8: 1000 operations, 25 layers, 3752 weights, 0 gather reads, 8 index reads',
    ])
  })
})

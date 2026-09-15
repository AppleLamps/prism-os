// Checks state-machine-prefix-scan.ts against the loop over every short queue, random queues
// and adversarial queues, in both evaluators, and pins the sizes that
// patterns/state-machine-prefix-scan.md quotes.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/patterns/combining-steps
import {describe, expect, test} from 'bun:test'
import {validateIndexReads} from '../../../../../../numeric-ui-core.ts'
import {createRandom, evaluateBoth, measureProgram} from './measure.ts'
import {
  type ButtonEvent,
  type MachineTables,
  type ScanForm,
  buildEventQueue,
  buttonEvents,
  buttonTables,
  eventKindCount,
  runButtonQueue,
  runQueue,
  toggleTables,
  writeEventQueue,
} from './state-machine-prefix-scan.ts'

const forms: readonly ScanForm[] = ['loop', 'sklansky', 'brent-kung']
const kindOf = (event: ButtonEvent) => buttonEvents.indexOf(event)

type Queue = {tables: MachineTables, initialState: number, eventKinds: number[]}

// Runs queues through one build in both evaluators, and compares the final state, the
// click count and the state before every event with the loop.
function expectMatchesLoop(stateCount: number, queueLength: number, form: ScanForm, queues: readonly Queue[]) {
  const built = buildEventQueue(stateCount, queueLength, form)
  const roots = [built.finalState, built.clicks, ...built.statesBefore]
  const evaluate = built.circuit.createTensorEvaluator(roots)
  const source = new Float32Array(built.circuit.sourceSize)
  for (const [index, {tables, initialState, eventKinds}] of queues.entries()) {
    writeEventQueue(built, source, tables, initialState, eventKinds)
    const {outputs, values} = evaluateBoth(built.circuit, evaluate, roots, source)
    if (index < 3) validateIndexReads(built.circuit, values)
    const expected = runQueue(tables, initialState, eventKinds)
    const expectedOutputs = [expected.finalState, expected.clicks, ...expected.statesBefore]
    if (outputs.join() !== expectedOutputs.join()) {
      throw new Error(`${form}, ${queueLength} events: from state ${initialState}, queue ${eventKinds.join()} gave ${outputs.join()}, expected ${expectedOutputs.join()}`)
    }
  }
}

describe('events through a state machine', () => {
  test('the tables describe the button loop', () => {
    const random = createRandom(2)
    const tables = buttonTables(3)
    for (let trial = 0; trial < 500; trial++) {
      const events = Array.from({length: 1 + Math.floor(random() * 20)}, () => buttonEvents[Math.floor(random() * eventKindCount)]!)
      const initialState = Math.floor(random() * 3)
      const expected = runButtonQueue(initialState, events)
      const actual = runQueue(tables, initialState, events.map(kindOf))
      expect([actual.finalState, actual.clicks]).toEqual([expected.finalState, expected.clicks])
    }
  })

  test('every queue of 4 events from every initial state matches the loop', () => {
    const tables = buttonTables(3)
    const queues: Queue[] = []
    for (let initialState = 0; initialState < 3; initialState++) {
      for (let code = 0; code < eventKindCount ** 4; code++) {
        const eventKinds = Array.from({length: 4}, (_, entry) => Math.floor(code / eventKindCount ** entry) % eventKindCount)
        queues.push({tables, initialState, eventKinds})
      }
    }
    expect(queues.length).toBe(1875)
    for (const form of forms) expectMatchesLoop(3, 4, form, queues)
  })

  test('random and adversarial queues of 16 and 64 events match the loop', () => {
    const random = createRandom(7)
    const tables = buttonTables(3)
    for (const queueLength of [16, 64]) {
      const adversarial: ButtonEvent[][] = [
        Array<ButtonEvent>(queueLength).fill('none'),
        Array<ButtonEvent>(queueLength).fill('up'),
        Array<ButtonEvent>(queueLength).fill('downOnButton'),
        // A press that moves outside and back inside without releasing.
        Array.from({length: queueLength}, (_, entry): ButtonEvent => (entry === 0 ? 'downOnButton' : entry % 2 === 1 ? 'moveOutside' : 'moveInside')),
        // Clicks back to back.
        Array.from({length: queueLength}, (_, entry): ButtonEvent => (entry % 2 === 0 ? 'downOnButton' : 'up')),
        // Only the last entry holds an event.
        Array.from({length: queueLength}, (_, entry): ButtonEvent => (entry === queueLength - 1 ? 'up' : 'none')),
      ]
      const queues: Queue[] = []
      for (const events of adversarial) {
        for (let initialState = 0; initialState < 3; initialState++) queues.push({tables, initialState, eventKinds: events.map(kindOf)})
      }
      for (let trial = 0; trial < 300; trial++) {
        queues.push({
          tables,
          initialState: Math.floor(random() * 3),
          eventKinds: Array.from({length: queueLength}, () => Math.floor(random() * eventKindCount)),
        })
      }
      for (const form of forms) expectMatchesLoop(3, queueLength, form, queues)
    }
  })

  test('one compiled program runs the button and the toggle switch', () => {
    const random = createRandom(17)
    for (const queueLength of [16, 64]) {
      const queues: Queue[] = Array.from({length: 200}, (_, trial) => ({
        tables: trial % 2 === 0 ? buttonTables(4) : toggleTables,
        initialState: Math.floor(random() * (trial % 2 === 0 ? 3 : 4)),
        eventKinds: Array.from({length: queueLength}, () => Math.floor(random() * eventKindCount)),
      }))
      for (const form of forms) expectMatchesLoop(4, queueLength, form, queues)
    }
  })

  test('sizes quoted in the doc', () => {
    const size = (stateCount: number, queueLength: number, form: ScanForm) => {
      const built = buildEventQueue(stateCount, queueLength, form)
      const {operations, layers, indexReads} = measureProgram(built.circuit, [built.finalState, built.clicks])
      return `${stateCount} states, ${queueLength} events, ${form}: ${operations} operations, ${layers} layers, ${indexReads} index reads`
    }
    expect([16, 64, 256].flatMap(queueLength => forms.map(form => size(3, queueLength, form)))).toEqual([
      '3 states, 16 events, loop: 33 operations, 17 layers, 32 index reads',
      '3 states, 16 events, sklansky: 177 operations, 8 layers, 176 index reads',
      '3 states, 16 events, brent-kung: 159 operations, 10 layers, 158 index reads',
      '3 states, 64 events, loop: 129 operations, 65 layers, 128 index reads',
      '3 states, 64 events, sklansky: 897 operations, 10 layers, 896 index reads',
      '3 states, 64 events, brent-kung: 681 operations, 14 layers, 680 index reads',
      '3 states, 256 events, loop: 513 operations, 257 layers, 512 index reads',
      '3 states, 256 events, sklansky: 4353 operations, 12 layers, 4352 index reads',
      '3 states, 256 events, brent-kung: 2787 operations, 18 layers, 2786 index reads',
    ])
    expect(forms.map(form => size(4, 64, form))).toEqual([
      '4 states, 64 events, loop: 129 operations, 65 layers, 128 index reads',
      '4 states, 64 events, sklansky: 1153 operations, 10 layers, 1152 index reads',
      '4 states, 64 events, brent-kung: 865 operations, 14 layers, 864 index reads',
    ])
  })
})

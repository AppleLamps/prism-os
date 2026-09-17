import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../src/runtime/numeric-ui-core.ts'
import type {QueuedEvent} from '../input/events.ts'
import {authoredBehavior, testWindowsConfig as config, withBehavior} from './fixtures.ts'
import {createWindowsMachine as createInputMachine, type WindowsVariant as InputVariant} from '../input/windows.ts'
import {generateWindowsTrace} from './input-traces.ts'
import {measureProgram} from '../input/kit.ts'
import {createWindowsMachine, createWindowsState, windowsOracleFrame, type WindowsConfig, type WindowsVariant} from './windows.ts'
import {compareLiftedWithInput} from './lifted.ts'

const folded: WindowsVariant & InputVariant = {kind: 'folded', maximumDowns: 2, pressPoint: 'session'}

describe('lifting the double click distance into its own cell', () => {
  test('the lifted folded build has the same live operations, layers and stored weights as input\'s', () => {
    const input = createInputMachine(config, 16, folded)
    const lifted = createWindowsMachine(config, 16, folded)
    const inputMeasure = measureProgram(input.circuit, input.roots)
    const liftedMeasure = measureProgram(lifted.circuit, lifted.roots)
    expect(liftedMeasure).toEqual(inputMeasure)
    expect(liftedMeasure.liveOperations).toBe(1494)
    expect(liftedMeasure.layers).toBe(55)
    expect(liftedMeasure.weights).toBe(6110)
    expect(lifted.layout.size).toBe(input.layout.size + 1)
  })

  test('at the authored values, every output is bit-identical to input\'s circuit over input\'s random trace', () => {
    const frames = generateWindowsTrace(config, {seed: 1002, frames: 1500, capacity: 16, maximumDowns: 2})
    const result = compareLiftedWithInput(config, 16, folded, frames)
    expect(result.frames).toBe(1500)
    expect(result.outputsCompared).toBe(1500 * 64)
    expect(result.differingOutputs).toBe(0)
    expect(result.oracleMismatchedFrames).toBe(0)
    expect(result.toggles).toBeGreaterThan(10)
    expect(result.commits).toBeGreaterThan(10)
  })

  test('the unrolled form is bit-identical too', () => {
    const frames = generateWindowsTrace(config, {seed: 7, frames: 300, capacity: 8, maximumDowns: 2})
    const result = compareLiftedWithInput(config, 8, {kind: 'unrolled'}, frames)
    expect(result.differingOutputs).toBe(0)
    expect(result.oracleMismatchedFrames).toBe(0)
  })
})

const down = (x: number, y: number, time = 0): QueuedEvent => ({kind: 'down', x, y, time})
const up = (x: number, y: number, time = 0): QueuedEvent => ({kind: 'up', x, y, time})
const move = (x: number, y: number, time = 0): QueuedEvent => ({kind: 'move', x, y, time})

// Window 0's title band is y 1..27, and its maximize button starts at x 472.
const title0 = {x: 200, y: 10}

function runFrames(behaviorConfig: WindowsConfig, frames: readonly {frameDelta: number, events: QueuedEvent[]}[]) {
  const machine = createWindowsMachine(behaviorConfig, 16, folded)
  const oracle = createWindowsState(behaviorConfig)
  for (const frame of frames) {
    const expectedDisplay = windowsOracleFrame(behaviorConfig, oracle, frame.frameDelta, frame.events)
    machine.writeFrame(frame.frameDelta, frame.events)
    validateOneHotGroups(machine.circuit, machine.circuit.evaluateTensor(machine.source))
    const actual = machine.step(frame.frameDelta, frame.events)
    expect(actual.state).toEqual(oracle)
    expect(actual.display).toEqual(expectedDisplay)
  }
  return oracle
}

function secondClickAt(offset: number): {frameDelta: number, events: QueuedEvent[]}[] {
  return [
    {frameDelta: 16.6875, events: [down(title0.x, title0.y, -10), up(title0.x, title0.y, -2)]},
    {frameDelta: 120, events: [down(title0.x + offset, title0.y, -6), up(title0.x + offset, title0.y, 0)]},
  ]
}

describe('the lifted cells act separately', () => {
  test('a second click 8 px away toggles with distance 10 and slop 4', () => {
    const state = runFrames(withBehavior(config, {...authoredBehavior, doubleClickDistance: 10}), secondClickAt(8))
    expect(state.maximized[0]).toBe(true)
  })

  test('a second click 8 px away does not toggle with distance 4 and slop 10', () => {
    const state = runFrames(withBehavior(config, {...authoredBehavior, slop: 10}), secondClickAt(8))
    expect(state.maximized[0]).toBe(false)
  })

  test('with slop 10, a 6 px wobble during a button press still clicks', () => {
    const button0 = {x: 485, y: 10}
    const state = runFrames(withBehavior(config, {...authoredBehavior, slop: 10}), [
      {frameDelta: 16.6875, events: [down(button0.x, button0.y, -12), move(button0.x + 6, button0.y + 3, -6), up(button0.x + 5, button0.y, 0)]},
    ])
    expect(state.maximized[0]).toBe(true)
  })

  test('a 300 ms interval rejects a 400 ms gap that the authored 500 ms accepts', () => {
    const frames = [
      {frameDelta: 16.6875, events: [down(title0.x, title0.y, -10), up(title0.x, title0.y, 0)]},
      {frameDelta: 400, events: [down(title0.x, title0.y, 0), up(title0.x, title0.y, 0)]},
    ]
    expect(runFrames(config, frames).maximized[0]).toBe(true)
    expect(runFrames(withBehavior(config, {...authoredBehavior, doubleClickInterval: 300}), frames).maximized[0]).toBe(false)
  })
})

// Runs input's original window circuit (lab/ui-exploration/input/windows.ts)
// and the lifted build (windows.ts) side by side over the same frames, and
// compares every output bit for bit. Both builds also go through the lifted
// oracle every frame. At the authored values the double click distance equals
// the slop, so both circuits compute the same behavior.

import {writeEventQueue} from '../input/events.ts'
import {
  buildWindowsCircuit as buildInputCircuit,
  createWindowsState as createInputState,
  flattenWindowsCells as flattenInputCells,
  writeWindowsConstants as writeInputConstants,
  writeWindowsState as writeInputState,
  type WindowsVariant as InputVariant,
} from '../input/windows.ts'
import type {Frame} from './input-traces.ts'
import {readOneHot} from '../input/kit.ts'
import {
  buildWindowsCircuit,
  createWindowsState,
  readWindowsState,
  windowsOracleFrame,
  writeWindowsConstants,
  writeWindowsState,
  type WindowsConfig,
  type WindowsVariant,
} from './windows.ts'

export type LiftedComparison = {
  frames: number
  events: number
  outputsCompared: number
  differingOutputs: number
  firstDifference: string | null
  oracleMismatchedFrames: number
  toggles: number
  commits: number
}

export function compareLiftedWithInput(config: WindowsConfig, capacity: number, variant: WindowsVariant & InputVariant, frames: readonly Frame[]): LiftedComparison {
  const input = buildInputCircuit(config, capacity, variant)
  const lifted = buildWindowsCircuit(config, capacity, variant)
  const evaluateInput = input.circuit.createTensorEvaluator(input.roots)
  const evaluateLifted = lifted.circuit.createTensorEvaluator(lifted.roots)
  const inputSource = new Float32Array(input.layout.size)
  const liftedSource = new Float32Array(lifted.layout.size)
  writeInputConstants(inputSource, input.constants, config)
  writeInputState(inputSource, input.cells, createInputState(config))
  writeWindowsConstants(liftedSource, lifted.constants, config)
  writeWindowsState(liftedSource, lifted.cells, createWindowsState(config))
  const inputStateCells = flattenInputCells(input.cells)
  const liftedStateCells = lifted.stateCells
  const count = config.windows.length
  const dragOwnerOutputs = Array.from({length: count}, (_, index) => liftedStateCells.length + count * 4 + index)
  const oracle = createWindowsState(config)
  const result: LiftedComparison = {frames: 0, events: 0, outputsCompared: 0, differingOutputs: 0, firstDifference: null, oracleMismatchedFrames: 0, toggles: 0, commits: 0}
  for (const frame of frames) {
    inputSource[input.frameDelta] = frame.frameDelta
    liftedSource[lifted.frameDelta] = frame.frameDelta
    writeEventQueue(inputSource, input.slots, frame.events)
    writeEventQueue(liftedSource, lifted.slots, frame.events)
    const inputOutputs = evaluateInput(inputSource)
    const liftedOutputs = evaluateLifted(liftedSource)
    for (let output = 0; output < lifted.roots.length; output++) {
      result.outputsCompared++
      if (!Object.is(inputOutputs[output], liftedOutputs[output])) {
        result.differingOutputs++
        result.firstDifference ??= `frame ${result.frames} output ${output}: input ${inputOutputs[output]}, lifted ${liftedOutputs[output]}`
      }
    }
    for (let index = 0; index < inputStateCells.length; index++) inputSource[inputStateCells[index]!] = inputOutputs[index]!
    for (let index = 0; index < liftedStateCells.length; index++) liftedSource[liftedStateCells[index]!] = liftedOutputs[index]!

    const maximizedBefore = [...oracle.maximized]
    const leftBefore = [...oracle.left]
    const topBefore = [...oracle.top]
    const expectedDisplay = windowsOracleFrame(config, oracle, frame.frameDelta, frame.events)
    result.toggles += oracle.maximized.filter((value, index) => value !== maximizedBefore[index]).length
    result.commits += oracle.left.filter((value, index) => value !== leftBefore[index] || oracle.top[index] !== topBefore[index]).length
    const actualDisplay = {
      rectangles: Array.from({length: count}, (_, index) => {
        const base = liftedStateCells.length + index * 4
        return {left: liftedOutputs[base]!, top: liftedOutputs[base + 1]!, width: liftedOutputs[base + 2]!, height: liftedOutputs[base + 3]!}
      }),
      dragOwner: readOneHot(liftedOutputs, dragOwnerOutputs, 'drag owner'),
    }
    const actualState = readWindowsState(liftedSource, lifted.cells)
    if (JSON.stringify({state: actualState, display: actualDisplay}) !== JSON.stringify({state: oracle, display: expectedDisplay})) result.oracleMismatchedFrames++
    result.frames++
    result.events += frame.events.length
  }
  return result
}

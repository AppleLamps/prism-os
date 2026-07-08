// Comparison helpers between the oracle and the circuit machine. Everything is
// compared for exact FP32 equality: coordinates are integer pixels, so even the
// continuous outputs must match bit-for-bit.

import {
  type EventWindowMachine,
  type MachineFrame,
  rectangleStateCell,
  rectangleStateField,
  sourceField,
} from './circuit.ts'
import {
  type BehaviorConfig,
  type FrameInput,
  type FrameOutput,
  type OracleState,
  oracleTick,
  rectangleCount,
} from './oracle.ts'

export function collectFrameMismatches(
  frame: MachineFrame,
  expected: FrameOutput,
): string[] {
  const mismatches: string[] = []
  if (frame.focused !== expected.focused) {
    mismatches.push(`focused: circuit ${frame.focused}, oracle ${expected.focused}`)
  }
  if (frame.dragOwner !== expected.dragOwner) {
    mismatches.push(`dragOwner: circuit ${frame.dragOwner}, oracle ${expected.dragOwner}`)
  }
  for (let index = 0; index < rectangleCount; index++) {
    if (frame.maximized[index]! !== expected.maximized[index]!) {
      mismatches.push(`maximized[${index}]: circuit ${frame.maximized[index]}, oracle ${expected.maximized[index]}`)
    }
    const circuitGeometry = frame.displayed[index]!
    const oracleGeometry = expected.displayed[index]!
    for (const field of ['left', 'top', 'width', 'height'] as const) {
      if (circuitGeometry[field] !== oracleGeometry[field]) {
        mismatches.push(
          `displayed[${index}].${field}: circuit ${circuitGeometry[field]}, oracle ${oracleGeometry[field]}`,
        )
      }
    }
  }
  return mismatches
}

// Compares the machine's state cells (after a step) against the oracle state
// (after the matching tick). Archive cells and everPressed are excluded: the
// oracle does not model them.
export function collectStateMismatches(
  source: Float32Array,
  state: OracleState,
): string[] {
  const mismatches: string[] = []
  const check = (label: string, cell: number, expected: number) => {
    if (source[cell]! !== expected) {
      mismatches.push(`${label}: circuit ${source[cell]}, oracle ${expected}`)
    }
  }
  check('pointerX', sourceField.pointerX, state.pointerX)
  check('pointerY', sourceField.pointerY, state.pointerY)
  check('pressActive', sourceField.pressActive, state.pressed ? 1 : 0)
  check('pressX', sourceField.pressX, state.pressX)
  check('pressY', sourceField.pressY, state.pressY)
  check('grabLeft', sourceField.grabLeft, state.grabLeft)
  check('grabTop', sourceField.grabTop, state.grabTop)
  check('pressOnTitle', sourceField.pressOnTitle, state.pressOnTitle ? 1 : 0)
  check('pressWasFocused', sourceField.pressWasFocused, state.pressWasFocused ? 1 : 0)
  check('pressOnMaximized', sourceField.pressOnMaximized, state.pressOnMaximized ? 1 : 0)
  check('slopLatch', sourceField.slopLatch, state.pressed && state.slopExceeded ? 1 : 0)
  for (let index = 0; index < rectangleCount; index++) {
    check(
      `pressRectangle[${index}]`,
      sourceField.pressRectangleStart + index,
      state.pressedRectangle === index ? 1 : 0,
    )
    check(
      `rectangleLeft[${index}]`,
      rectangleStateCell(index, rectangleStateField.left),
      state.rectangleLeft[index]!,
    )
    check(
      `rectangleTop[${index}]`,
      rectangleStateCell(index, rectangleStateField.top),
      state.rectangleTop[index]!,
    )
    check(
      `maximized[${index}]`,
      rectangleStateCell(index, rectangleStateField.maximized),
      state.maximized[index]! ? 1 : 0,
    )
    check(
      `focused[${index}]`,
      rectangleStateCell(index, rectangleStateField.focused),
      state.focused === index ? 1 : 0,
    )
  }
  return mismatches
}

export type ClosedLoopResult = {
  frames: number
  divergences: number
  firstDivergenceFrame: number
  firstDivergenceDetail: string[]
}

// Runs the hardened machine as the state machine over a trace: its own outputs
// latch its next event window; the oracle runs in parallel purely as a judge.
export function runClosedLoop(
  config: BehaviorConfig,
  trace: readonly FrameInput[],
  machine: EventWindowMachine,
  oracleState: OracleState,
  onFrame?: (frameIndex: number, frame: MachineFrame) => void,
): ClosedLoopResult {
  let divergences = 0
  let firstDivergenceFrame = -1
  let firstDivergenceDetail: string[] = []
  for (let frameIndex = 0; frameIndex < trace.length; frameIndex++) {
    const input = trace[frameIndex]!
    const frame = machine.step(input)
    const expected = oracleTick(config, oracleState, input)
    const mismatches = [
      ...collectFrameMismatches(frame, expected),
      ...collectStateMismatches(machine.source, oracleState),
    ]
    if (mismatches.length > 0) {
      divergences++
      if (firstDivergenceFrame === -1) {
        firstDivergenceFrame = frameIndex
        firstDivergenceDetail = mismatches
      }
    }
    onFrame?.(frameIndex, frame)
  }
  return {frames: trace.length, divergences, firstDivergenceFrame, firstDivergenceDetail}
}

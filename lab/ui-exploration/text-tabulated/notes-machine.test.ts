import {expect, test} from 'bun:test'
import {installFakeCanvas} from './fake-canvas.ts'
import {createNotesMachine, createStepClock, notesLayout, prepareNotesBlocks} from './notes-machine.ts'
import {checkNotesTraces} from './notes-trace-check.ts'
import {referenceSpringStep} from './springs.ts'

installFakeCanvas('blink')

const blocks = prepareNotesBlocks()

test('every frame of scripted resize traces matches pretext: line counts, widths, cursors, line text, tight widths', () => {
  const result = checkNotesTraces(blocks, [1, 2])
  expect(result.decisionProblems.slice(0, 5)).toEqual([])
  expect(result.decisionProblemCount).toBe(0)
  expect(result.frames).toBe(729)
  expect(result.comparisons).toBe(result.frames * blocks.length)
  // The fake canvas's widths are multiples of fontSize/64, so width deltas add up exactly and delta rows
  // give bit-equal widths. With other advances they drift (see report.ts nondyadic).
  expect(result.maxLineWidthDrift).toBe(0)
  expect(result.lineXDrift).toBeLessThan(1e-3)
  // The drag reached both clamps, and the spring never left the tabulated range.
  expect(result.narrowestContentWidth).toBeLessThan(notesLayout.minWindowWidth - 2 * notesLayout.padding + 1)
  expect(result.widestContentWidth).toBeGreaterThan(notesLayout.maxWindowWidth - 2 * notesLayout.padding - 1)
  expect(result.narrowestContentWidth).toBeGreaterThanOrEqual(notesLayout.tabulateFrom)
  expect(result.widestContentWidth).toBeLessThanOrEqual(notesLayout.tabulateTo)
  // Springs and stacking against the float64 mirror.
  expect(result.geometryDrift).toBeLessThan(0.01)
  expect(result.settled).toBe(true)
})

test('matrix-power springs follow a float64 step loop', () => {
  const machine = createNotesMachine(blocks)
  let position = notesLayout.initialWindowWidth
  let velocity = 0
  machine.pointerDown(notesLayout.windowLeft + notesLayout.initialWindowWidth, notesLayout.windowTop + 20)
  machine.step(0)
  machine.pointerMove(notesLayout.windowLeft + 900)
  let maximumDrift = 0
  for (const steps of [4, 4, 1, 300, 0, 2, 17, 4, 4, 4, 60, 4]) {
    machine.step(steps)
    const reference = referenceSpringStep(position, velocity, 900, steps, notesLayout.spring)
    position = reference.position
    velocity = reference.velocity
    maximumDrift = Math.max(maximumDrift, Math.abs(machine.readWindow().width - position))
  }
  expect(maximumDrift).toBeLessThan(1e-3)
})

test('the step clock uses 4ms steps with at most 300 per frame', () => {
  const clock = createStepClock(1000)
  expect(clock(1016.7)).toBe(4)
  expect(clock(1020)).toBe(1)
  expect(clock(1021)).toBe(0)
  expect(clock(9000)).toBe(300)
  expect(clock(9004)).toBe(1)
})

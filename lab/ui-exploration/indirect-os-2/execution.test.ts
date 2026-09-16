// Stage 5: generated JavaScript and tiered execution, bit for bit against the executor.
import {expect, test} from 'bun:test'
import {compileScalarProgram, comparePacked} from './codegen.ts'
import {lineFitEpsilon, loadPretext} from '../text-walker/fake-canvas.ts'
import {fastParagraph} from './fast-walker.ts'
import {configurations} from './configurations.ts'
import {createIndirectOSMachine} from './indirect-os.ts'
import {notesText, testFont} from './paragraph.ts'
import {generateQueueTrace} from './queue-traces.ts'
import {createTieredEvaluator} from './tiered.ts'

const pretext = await loadPretext()
const paragraph = fastParagraph(pretext.prepareWithSegments(notesText, testFont))
const {final} = configurations(paragraph, lineFitEpsilon)
const {frames} = generateQueueTrace({seed: 3, frames: 60, capacity: 8, maximumDowns: 2})

test('generated JavaScript equals the executor on every live wire of the whole program along a queue trace', () => {
  const machine = createIndirectOSMachine(final)
  const generated = compileScalarProgram(machine.tensorProgram, {rowsPerFunction: 128})
  let time = 0
  let checked = 0
  let evaluationsWithEvents = 0
  machine.observe({
    beforeEvaluate(source) {
      const expected = machine.circuit.evaluateTensor(source)
      generated.run(source)
      const comparison = comparePacked(machine.tensorProgram, generated.values, expected)
      expect(comparison.firstMismatch).toBeNull()
      checked += comparison.checked
    },
  })
  for (const frame of frames) {
    if (frame.events.length > 0) evaluationsWithEvents++
    machine.stepFrame(frame.viewport.width, frame.viewport.height, time += frame.elapsed, frame.events)
  }
  expect(machine.tensorProgram.valueCount - machine.tensorProgram.sourceSize).toBeGreaterThan(18_000)
  expect(checked).toBeGreaterThan(60 * 18_000)
  expect(evaluationsWithEvents).toBeGreaterThan(25)
})

test('a machine that promotes to generated code mid-trace writes back the same tables as an executor-only machine', () => {
  const executorOnly = createIndirectOSMachine(final)
  const tiered = createIndirectOSMachine(final)
  const evaluator = createTieredEvaluator(tiered.circuit, tiered.roots)
  tiered.setEvaluator(source => evaluator.evaluate(source))
  let time = 0
  frames.forEach((frame, index) => {
    if (index === 20) expect(evaluator.promote(tiered.source, 5)).toBe(true)
    time += frame.elapsed
    executorOnly.stepFrame(frame.viewport.width, frame.viewport.height, time, frame.events)
    tiered.stepFrame(frame.viewport.width, frame.viewport.height, time, frame.events)
    expect(Array.from(tiered.source)).toEqual(Array.from(executorOnly.source))
  })
  expect(evaluator.tier).toBe('generated')
  expect(evaluator.stats.verifiedWires).toBe(tiered.tensorProgram.valueCount)
})

import {describe, expect, test} from 'bun:test'
import {validateTensorEvaluation} from '../../numeric-ui-core.ts'
import {
  createCandidateGalleryMachine,
  geometryField,
  photoCount as candidatePhotoCount,
  sourceField as candidateSourceTable,
} from './candidate-gallery.ts'

// The candidate gallery's part of oracle-trace.test.ts, which moved here with the gallery.

// Seeded hash from numeric-ui-core.test.ts; the only source of "randomness".
function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

type Machine = {
  circuit: Parameters<typeof validateTensorEvaluation>[1]
  source: Float32Array
}

// Snapshot the source exactly as the machine sees it at the top of step(),
// before its writeback: copy the live table, then overwrite the fields that
// step() assigns from its arguments prior to evaluating the circuit. Comparing
// the reference and tensor evaluators on this snapshot is bit-for-bit identical
// to what the machine itself evaluates that frame.
function verifyStep(machine: Machine, prefields: readonly (readonly [number, number])[]) {
  const snapshot = new Float32Array(machine.source)
  for (const [field, value] of prefields) snapshot[field] = value
  const tensorValues = machine.circuit.evaluateTensor(snapshot)
  validateTensorEvaluation(snapshot, machine.circuit, tensorValues)
  return machine.circuit.tensorProgram!.wireOrder.length
}

describe('production circuits match the reference interpreter across scripted traces', () => {
  test('candidate gallery: layout tournament, focus clicks, tiny viewports', () => {
    const machine = createCandidateGalleryMachine()
    const random = createRandom(0x1ca4e5)
    let comparisons = 0
    let steps = 0
    let width = 1400
    let height = 680

    function advance() {
      comparisons += verifyStep(machine, [
        [candidateSourceTable.viewportWidth, width],
        [candidateSourceTable.viewportHeight, height],
      ])
      steps++
      return machine.step(width, height)
    }

    function thumbnail(values: Float32Array, item: number) {
      const start = item * geometryField.size
      const thumbnails = machine.output.thumbnails
      return {
        left: values[thumbnails[start + geometryField.left]!]!,
        top: values[thumbnails[start + geometryField.top]!]!,
        width: values[thumbnails[start + geometryField.width]!]!,
        height: values[thumbnails[start + geometryField.height]!]!,
      }
    }

    // Cycle through wide/balanced/tall viewports so every layout wins, clicking
    // a different thumbnail in each so focus routes through the shared state.
    const viewportCycle = [
      [1400, 680],
      [984, 730],
      [760, 517],
      [610, 830],
      [600, 517],
    ] as const
    let values = advance()
    for (let round = 0; round < 22; round++) {
      const [cycleWidth, cycleHeight] = viewportCycle[round % viewportCycle.length]!
      width = cycleWidth
      height = cycleHeight
      values = advance()
      const item = round % candidatePhotoCount
      const target = thumbnail(values, item)
      if (target.width > 0 && target.height > 0) {
        const offsetX = 0.5 + random() * Math.max(0, target.width - 1)
        const offsetY = 0.5 + random() * Math.max(0, target.height - 1)
        machine.click(target.left + offsetX, target.top + offsetY)
      } else {
        // Click into empty space; focus must stay exactly where it is.
        machine.click(-50, -50)
      }
      values = advance()
    }

    // Tiny and zero viewports, plus a click that lands nowhere.
    for (const [resizeWidth, resizeHeight] of [
      [0, 0],
      [1, 1],
      [20, 300],
      [300, 20],
      [2000, 400],
    ] as const) {
      width = resizeWidth
      height = resizeHeight
      machine.click(random() * resizeWidth, random() * resizeHeight)
      values = advance()
      values = advance()
    }

    expect(steps).toBeGreaterThanOrEqual(50)
    expect(comparisons).toBeGreaterThan(0)
    console.log(`candidate gallery: ${steps} steps, ${comparisons} wire comparisons`)
  })
})

import {describe, expect, test} from 'bun:test'
import {
  type Circuit,
  asWire,
  validateOneHotGroups,
  validateTensorEvaluation,
} from '../../numeric-ui-core.ts'
import {createCandidateGalleryMachine} from './candidate-gallery.ts'

// The candidate gallery's part of gather-lowering.test.ts, which moved here with the gallery.
// The candidate gallery declares finite pixel ranges and one-hot groups, so recognition engages on it. This
// test pins the gather read counts that lab/status.md reports, and checks the lowered program against the
// reference evaluator on every wire across an interaction trace.

type CompiledProgram = ReturnType<Circuit['compileTensorProgram']>

// Seeded hash, copied from numeric-ui-core.test.ts so every run is deterministic.
function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function randomInteger(random: () => number, limit: number) {
  return Math.floor(random() * limit)
}

function gatherStatistics(program: CompiledProgram) {
  let readCount = 0
  let computeCount = 0
  let storedWeightCount = 0
  let gatherBytes = 0
  for (const layer of program.layers) {
    readCount += layer.gatherReads.length
    computeCount += layer.gatherComputes.length
    storedWeightCount += layer.weights.length
    for (const compute of layer.gatherComputes) {
      // The bit table plus the slot number (stored as one 32-bit value).
      gatherBytes += compute.bitPositions.byteLength + 4
    }
    for (const read of layer.gatherReads) {
      // The candidate table plus row, slot, and mask flag (three 32-bit values).
      gatherBytes += read.candidatePositions.byteLength + 12
    }
  }
  return {readCount, computeCount, slotCount: program.gatherSlotCount, storedWeightCount, gatherBytes}
}

describe('the candidate gallery', () => {
  test('candidate-gallery lowers its 26 layout selection reads', () => {
    const machine = createCandidateGalleryMachine()
    const {circuit} = machine
    const lowered = gatherStatistics(machine.tensorProgram)
    const plain = gatherStatistics(
      circuit.compileTensorProgram(Array.from(machine.tensorProgram.roots, asWire), false),
    )
    // One declared group: the argmax winner. The click selection's gate, the
    // clickActive cell, is declared within 0..1, which isn't a proven bit, so
    // emitFirstActive declares no group for it. The hero sums lower too, since
    // circuit.multiply keeps the product of the Contact layout's bit and its
    // constant-zero hero rectangle, so each sum covers all 3 members.
    expect(circuit.oneHotGroups.length).toBe(1)
    expect(lowered.readCount).toBe(26)
    expect(lowered.slotCount).toBe(1)
    expect(lowered.storedWeightCount).toBeLessThan(plain.storedWeightCount)
    console.log(
      `[survey] candidate-gallery: groups=${circuit.oneHotGroups.length}`
        + ` gatherReads=${lowered.readCount} slots=${lowered.slotCount}`
        + ` storedWeights=${lowered.storedWeightCount}`
        + ` (dense compile of the same roots: ${plain.storedWeightCount})`,
    )

    // Interaction trace: resizes and clicks, every frame compared wire-for-wire
    // against the reference evaluator, with the declared group checked exactly.
    const random = createRandom(0xca11)
    const viewports = [
      [1280, 800], [700, 900], [420, 700], [1600, 500], [900, 900],
    ] as const
    for (let step = 0; step < 60; step++) {
      const [width, height] = viewports[step % viewports.length]!
      if (step % 4 === 2) {
        machine.click(randomInteger(random, width), randomInteger(random, height))
      }
      machine.source[0] = width
      machine.source[1] = height
      const reference = circuit.evaluateReference(machine.source)
      validateOneHotGroups(circuit, reference)
      const values = circuit.evaluateTensor(machine.source)
      validateTensorEvaluation(machine.source, circuit, values)
      machine.step(width, height)
    }
  })
})

import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  checkHardenedWiring,
  createWiringCircuit,
  describeWiring,
  gateSlots,
  groundTruthOutputs,
  hardenWiring,
  inputBitsOfRow,
  inputCount,
  layerOneGateCount,
  rowCount,
  sourceFromWiring,
  trainWiring,
  type HardenedWiring,
} from './exp-learned-wiring.ts'
import {createRandom} from './exp-learned-wiring.ts'

// A hand-built wiring of the hidden circuit, expressed in the experiment's own
// hardened format: g0 = AND(in0, in1), out0 = OR(g0, in2), out1 = XOR(in1,
// in3). g1 is an unused filler gate. Layer-2 candidate indices: inputs 0..3,
// then g0 = 4, g1 = 5.
const groundTruthWiring: HardenedWiring = [
  {selectA: 0, selectB: 1, truth: [0, 0, 0, 1]}, // g0 = AND(in0, in1)
  {selectA: 0, selectB: 0, truth: [0, 0, 0, 0]}, // g1 = FALSE, unused
  {selectA: 4, selectB: 2, truth: [0, 1, 1, 1]}, // out0 = OR(g0, in2)
  {selectA: 1, selectB: 3, truth: [0, 1, 1, 0]}, // out1 = XOR(in1, in3)
]

// The harness must be able to express the hidden circuit at all: the
// hand-built wiring runs bit-exactly through both evaluators, independent of
// any training.
test('hand-built ground-truth wiring reproduces the truth table exactly', () => {
  const {exact, correctBits, totalBits} = checkHardenedWiring(groundTruthWiring)
  assert.equal(exact, true)
  assert.equal(correctBits, totalBits)
  assert.equal(totalBits, rowCount * 2)
})

// The soft gate is claimed to be Petersen's 16-gate mixture collapsed to four
// truth-table cells. Check the emitted circuit computes exactly the multilinear
// interpolation for fractional truth cells AND fractional inputs -- the soft
// regime training lives in.
test('soft gate output equals the multilinear interpolation of its truth cells', () => {
  const {circuit, layerOne} = createWiringCircuit()
  const source = sourceFromWiring(groundTruthWiring)
  const random = createRandom(0x9e_37_79)
  const g0 = gateSlots[0]!
  for (let probe = 0; probe < 20; probe++) {
    // g0 selects in0 and in1 one-hot, so a and b are the raw input cells.
    const a = random()
    const b = random()
    const truth = [random(), random(), random(), random()]
    source[0] = a
    source[1] = b
    for (let index = 0; index < 4; index++) source[g0.truthStart + index] = truth[index]!
    const values = circuit.evaluateReference(source)
    const expected =
      truth[0]! * (1 - a) * (1 - b)
      + truth[1]! * a * (1 - b)
      + truth[2]! * (1 - a) * b
      + truth[3]! * a * b
    const observed = values[layerOne[0]!]!
    assert.ok(
      Math.abs(observed - expected) < 1e-5,
      `soft gate mismatch: observed ${observed}, expected ${expected}`,
    )
  }
})

// Headline: with four of the 16 input rows held out, training recovers wiring
// whose HARDENED circuit is bit-exact on every row -- including the rows it
// never saw. Wiring is identifiable only up to behavior, so the assertion is
// behavioral; the recovered structure is logged for the record.
//
// The held-out rows must keep the hidden circuit identifiable from what
// remains: rows 3 and 9 are the only rows separating the true hidden gate
// AND(in0, in1) from the impostor AND(in0, in3) while in2 = 0, so they stay in
// training. (An earlier hold-out set removed both, and training duly fit every
// training row with the impostor -- an underdetermined experiment design, not
// a failed learner.) Rows 5, 6, 12, 15 are safe to hold out: each (in1, in3)
// combination keeps three of its four rows, and in2 = 1 rows keep four.
test('trained wiring hardens to bit-exact behavior on all rows, held-out included', () => {
  const heldOutRows = [5, 6, 12, 15]
  const trainingRows = Array.from({length: rowCount}, (_, row) => row).filter(
    row => !heldOutRows.includes(row),
  )
  const seeds = [1, 2, 3, 4, 5, 6]
  let passed = 0
  let firstPassing: HardenedWiring | undefined
  for (const seed of seeds) {
    const result = trainWiring({seed, trainingRows})
    const wiring = hardenWiring(result.source)
    const {exact} = checkHardenedWiring(wiring)
    if (exact) {
      passed++
      firstPassing ??= wiring
    }
  }
  console.log(`[wiring] ${passed}/${seeds.length} seeds hardened to exact behavior`)
  assert.ok(passed >= 4, `expected at least 4/${seeds.length} seeds to recover exact wiring, got ${passed}`)
  assert.ok(firstPassing !== undefined)
  console.log('[wiring]\n' + describeWiring(firstPassing))

  // out0 depends on three inputs, so an exact wiring must route it through a
  // layer-1 intermediate: at least one of its selections points past the raw
  // inputs.
  const out0 = firstPassing[layerOneGateCount]!
  assert.ok(
    out0.selectA >= inputCount || out0.selectB >= inputCount,
    'an exact out0 must read a layer-1 gate',
  )
})

// Training on the complete truth table (no held-out rows) is the easier
// regime; it should recover exact wiring at least as reliably.
test('trained wiring hardens exactly when trained on the full truth table', () => {
  const seeds = [1, 2, 3]
  let passed = 0
  for (const seed of seeds) {
    const result = trainWiring({seed})
    const wiring = hardenWiring(result.source)
    const {exact} = checkHardenedWiring(wiring)
    if (exact) passed++
  }
  assert.ok(passed >= 2, `expected at least 2/${seeds.length} seeds, got ${passed}`)
})

// Sanity for the row encoding and the hidden law itself, mirroring the style
// of exp-integer-boolean's specification test.
test('ground-truth law matches its specification on hand-checked rows', () => {
  // Row 0: all inputs 0 -> hidden 0, out0 0, out1 0.
  assert.deepEqual(groundTruthOutputs(inputBitsOfRow(0)), [0, 0])
  // Row 3 = in0, in1 -> hidden 1, out0 1; out1 = in1 xor in3 = 1.
  assert.deepEqual(groundTruthOutputs(inputBitsOfRow(3)), [1, 1])
  // Row 4 = in2 -> out0 1 without the hidden gate; out1 0.
  assert.deepEqual(groundTruthOutputs(inputBitsOfRow(4)), [1, 0])
  // Row 10 = in1, in3 -> hidden 0, out0 0; out1 = 1 xor 1 = 0.
  assert.deepEqual(groundTruthOutputs(inputBitsOfRow(10)), [0, 0])
})

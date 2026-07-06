import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  bf16IntegerBit,
  bf16RoundingBoolean,
  checkHardenedIntegerExact,
  createIntegerRevealCircuit,
  fp32RoundingBoolean,
  roundToBf16,
  trainIntegerReveal,
} from './exp-integer-boolean.ts'
import {
  baseVisibleVector,
  buildCases,
  groundTruthRelation,
  hardenRelation,
  relationBitsEqual,
  selectedCell,
  slotCount,
  sourceFromBits,
  writeInputs,
} from './exp-ste-reveal.ts'

const seeds = [1, 2, 3, 4]

// The hand-built ground-truth relation must run bit-exactly through a circuit
// that structurally contains no boolean atom -- the decision is carried
// entirely by relu(score) - relu(score - 1) on integer scores.
test('ground-truth reveal law runs exactly with no boolean atom', () => {
  const {circuit} = createIntegerRevealCircuit()
  assert.ok(
    circuit.operations.every(operation => operation.kind !== 'boolean'),
    'circuit must not contain boolean atoms',
  )
  const relation = groundTruthRelation()
  const baseVisible = baseVisibleVector()
  const cases = buildCases(relation, baseVisible)
  const {exact, correctBits, totalBits} = checkHardenedIntegerExact(relation, baseVisible, cases)
  assert.equal(exact, true)
  assert.equal(correctBits, totalBits)
  assert.equal(totalBits, slotCount * cases.length)
})

// Headline: the plain reference backward pass -- no straight-through estimator,
// no surrogate slope -- trains the relation cells, and rounding them to bits
// hardens to exact behavior. Every seed is also checked for recovering the
// hidden matrix cell-for-cell, which at least one seed must achieve.
test('native reference backprop trains the relation; hardened bits are exact', () => {
  const relation = groundTruthRelation()
  const baseVisible = baseVisibleVector()
  const cases = buildCases(relation, baseVisible)
  let passed = 0
  let recoveredMatrix = 0
  for (const seed of seeds) {
    const result = trainIntegerReveal(baseVisible, cases, {seed})
    const hardened = hardenRelation(result.learnedRelation)
    const {exact} = checkHardenedIntegerExact(hardened, baseVisible, cases)
    if (exact) passed++
    if (relationBitsEqual(hardened, relation)) recoveredMatrix++
  }
  assert.ok(passed >= 3, `expected at least 3/4 seeds to harden exactly, got ${passed}/4`)
  assert.ok(
    recoveredMatrix >= 1,
    `expected at least one seed to recover the exact matrix, got ${recoveredMatrix}/4`,
  )
})

// Multi-selection probe, outside the seven single-selection cases: selecting
// slots 0 and 2 together must reveal the union {3, 4, 5}. Under the unmodified
// ground truth, rows 0 and 2 share no target, so every score stays 0 or 1;
// the second probe augments the relation with (2 reveals 4) so slot 4's score
// is the integer 2 (both selected rows firing), checking through the circuit
// that clamp01 of a count above 1 is still the exact bit 1 -- the count
// contract composes past the 0/1 range training exercised.
test('circuit is exact on multi-selection probes, including a score of 2', () => {
  const baseVisible = baseVisibleVector()
  const {circuit, visibility} = createIntegerRevealCircuit()

  function probeSelecting0And2(relation: Uint8Array): number[] {
    const source = sourceFromBits(relation)
    writeInputs(source, baseVisible, -1)
    source[selectedCell(0)] = 1
    source[selectedCell(2)] = 1
    const referenceValues = circuit.evaluateReference(source)
    const tensorValues = circuit.evaluateTensor(source)
    const observed: number[] = []
    for (let j = 0; j < slotCount; j++) {
      assert.equal(tensorValues[visibility[j]!]!, referenceValues[visibility[j]!]!)
      observed.push(referenceValues[visibility[j]!]!)
    }
    return observed
  }

  assert.deepEqual(probeSelecting0And2(groundTruthRelation()), [0, 0, 0, 1, 1, 1])

  const overlapping = groundTruthRelation()
  overlapping[2 * slotCount + 4] = 1 // selecting 2 now also reveals 4
  // Slot 4's score is R[0][4] + R[2][4] = 2; the output must still be the
  // exact bit 1, not 2 and not a fraction.
  assert.deepEqual(probeSelecting0And2(overlapping), [0, 0, 0, 1, 1, 1])
})

// Precision portability. Rounding every arithmetic step to bfloat16 (7 stored
// mantissa bits), the relu-difference bit stays exact across the whole signed
// integer range bfloat16 represents exactly, while the 2^23 rounding trick
// collapses: its odd base is not representable, and near 2^23 the value
// spacing is 65_536, so even boolean(1) comes back as 0.
test('the relu-difference bit survives bfloat16; the rounding trick does not', () => {
  // FP32 sanity for the rounding boolean, matching execution-model.md.
  assert.equal(fp32RoundingBoolean(0.25), 0)
  assert.equal(fp32RoundingBoolean(0.75), 1)
  assert.equal(fp32RoundingBoolean(1), 1)

  // The magic constant itself does not survive bfloat16.
  assert.equal(roundToBf16(8_388_609), 8_388_608)

  // Under bfloat16 the rounding trick returns 0 for scores that must be 1.
  assert.equal(bf16RoundingBoolean(1), 0)
  assert.equal(bf16RoundingBoolean(0.75), 0)

  // The relu-difference bit is exact for every integer bfloat16 stores
  // exactly: 0 or negative counts stay hidden, counts of 1 or more show.
  for (let score = -256; score <= 256; score++) {
    assert.equal(
      bf16IntegerBit(score),
      score >= 1 ? 1 : 0,
      `bf16 integer bit is wrong at score ${score}`,
    )
  }

  // Reveal-sized counts accumulate exactly under bfloat16: summing up to seven
  // 0/1 terms never rounds, so the score feeding the bit is the true count.
  let count = 0
  for (let step = 0; step < 7; step++) {
    count = roundToBf16(count + 1)
    assert.equal(count, step + 1)
    assert.equal(bf16IntegerBit(count), 1)
  }
})

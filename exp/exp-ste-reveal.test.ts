import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  baseVisibleVector,
  buildCases,
  checkHardenedExact,
  createRevealCircuit,
  expectedVisibility,
  groundTruthRelation,
  hardenRelation,
  relationBitsEqual,
  slotCount,
  sourceFromBits,
  trainReveal,
  writeInputs,
} from './exp-ste-reveal.ts'

const seeds = [1, 2, 3, 4]

// Sanity: the ground-truth law is what the prompt describes. Selecting 2
// reveals 3; selecting 0 reveals 4 and 5; everything else unaffected.
test('ground-truth reveal law matches the specification', () => {
  const relation = groundTruthRelation()
  const baseVisible = baseVisibleVector()
  const reveal2 = expectedVisibility(relation, baseVisible, 2)
  assert.deepEqual([...reveal2], [0, 0, 0, 1, 0, 0])
  const reveal0 = expectedVisibility(relation, baseVisible, 0)
  assert.deepEqual([...reveal0], [0, 0, 0, 0, 1, 1])
  const reveal1 = expectedVisibility(relation, baseVisible, 1)
  assert.deepEqual([...reveal1], [0, 0, 0, 0, 0, 0])
  const none = expectedVisibility(relation, baseVisible, -1)
  assert.deepEqual([...none], [0, 0, 0, 0, 0, 0])
})

// A hand-built ground-truth source table must reproduce the law exactly through
// the compiled circuit -- this is the target the trainer must reach, verified
// independently of any training.
test('hand-built ground-truth circuit reproduces the law exactly', () => {
  const relation = groundTruthRelation()
  const baseVisible = baseVisibleVector()
  const cases = buildCases(relation, baseVisible)
  const {exact, correctBits, totalBits} = checkHardenedExact(relation, baseVisible, cases)
  assert.equal(exact, true)
  assert.equal(correctBits, totalBits)
  assert.equal(totalBits, slotCount * cases.length)
})

// Headline: gradient descent edits the behavior cells, and the rounded result
// hardens to bit-exact forward execution on every training case. At least 3 of
// 4 seeds must converge and pass hardened exactness.
test('trained relation hardens to bit-exact behavior (sigmoidSte)', () => {
  const relation = groundTruthRelation()
  const baseVisible = baseVisibleVector()
  const cases = buildCases(relation, baseVisible)
  let passed = 0
  for (const seed of seeds) {
    const result = trainReveal(baseVisible, cases, {
      seed,
      mode: 'sigmoidSte',
      temperature: 6,
      learningRate: 0.2,
      epochs: 400,
    })
    const hardened = hardenRelation(result.learnedRelation)
    const {exact, correctBits, totalBits} = checkHardenedExact(hardened, baseVisible, cases)
    if (exact && correctBits === totalBits) passed++
  }
  assert.ok(passed >= 3, `expected at least 3/4 seeds to harden exactly, got ${passed}/4`)
})

// Plain STE also works on this substrate, demonstrating the surrogate-shape
// choice is not load-bearing for recovering a clean bit matrix here.
test('trained relation hardens to bit-exact behavior (plain ste)', () => {
  const relation = groundTruthRelation()
  const baseVisible = baseVisibleVector()
  const cases = buildCases(relation, baseVisible)
  let passed = 0
  for (const seed of seeds) {
    const result = trainReveal(baseVisible, cases, {
      seed,
      mode: 'ste',
      learningRate: 0.2,
      epochs: 400,
    })
    const hardened = hardenRelation(result.learnedRelation)
    const {exact} = checkHardenedExact(hardened, baseVisible, cases)
    if (exact) passed++
  }
  assert.ok(passed >= 3, `expected at least 3/4 seeds to harden exactly with plain ste, got ${passed}/4`)
})

// The recovered LAW (the rounded R matrix) equals the hidden ground-truth
// matrix cell-for-cell on a converged seed -- stronger than reproducing the
// observed cases. We then probe a HELD-OUT compositional input (select slots 0
// and 2 simultaneously, never shown in training) and check the hardened circuit
// composes the two rows correctly: it should reveal {3,4,5}. Because each
// relation cell is gated independently by its own selection bit, recovering R
// exactly makes multi-selection generalize by construction -- the network
// learned the composable law, not a memorized lookup table.
test('hardened circuit generalizes to a held-out multi-selection probe', () => {
  const relation = groundTruthRelation()
  const baseVisible = baseVisibleVector()
  const cases = buildCases(relation, baseVisible)
  // Find a seed that recovers the exact matrix.
  let hardened: Uint8Array | undefined
  for (const seed of seeds) {
    const result = trainReveal(baseVisible, cases, {
      seed,
      mode: 'sigmoidSte',
      temperature: 6,
      learningRate: 0.2,
      epochs: 400,
    })
    const bits = hardenRelation(result.learnedRelation)
    if (relationBitsEqual(bits, relation)) {
      hardened = bits
      break
    }
  }
  assert.ok(hardened !== undefined, 'no seed recovered the exact relation matrix')

  // Multi-selection {0, 2}: write a two-hot input directly (not via writeInputs,
  // which only does single selections). The law says the visible set is the
  // union of row 0's and row 2's reveals: {4,5} union {3} = {3,4,5}.
  const {circuit, visibility} = createRevealCircuit()
  const source = sourceFromBits(hardened)
  writeInputs(source, baseVisible, -1)
  setSelected(source, [0, 2])
  const referenceValues = circuit.evaluateReference(source)
  const tensorValues = circuit.evaluateTensor(source)
  const observed: number[] = []
  for (let j = 0; j < slotCount; j++) {
    assert.equal(tensorValues[visibility[j]!]!, referenceValues[visibility[j]!]!)
    observed.push(referenceValues[visibility[j]!]!)
  }
  assert.deepEqual(observed, [0, 0, 0, 1, 1, 1])
})

// Helper: set a multi-hot selection directly into a source table. Mirrors the
// selection-cell layout exposed by exp-ste-reveal without single-hot
// restriction. Defined locally so the experiment module keeps its single-hot
// writeInputs contract.
function setSelected(source: Float32Array, selected: readonly number[]) {
  const selectedSet = new Set(selected)
  // Selection cells are the last `slotCount` source cells.
  const start = source.length - slotCount
  for (let i = 0; i < slotCount; i++) source[start + i] = selectedSet.has(i) ? 1 : 0
}

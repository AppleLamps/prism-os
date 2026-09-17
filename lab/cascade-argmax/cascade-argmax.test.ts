import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {validateTensorEvaluation} from '../../src/runtime/numeric-ui-core.ts'
import {
  buildArgmaxTree,
  circuitOpCounts,
  leftmostArgmax,
  runArgmaxTree,
} from './cascade-argmax.ts'

const f32 = Math.fround

class RandomSource {
  state: number
  constructor(seed: number) {
    this.state = seed | 0
  }
  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) | 0
    return (this.state >>> 0) / 4_294_967_296
  }
}

function ulpAt(value: number): number {
  let candidate = 2 ** -149
  while (f32(value + candidate) === value) candidate *= 2
  return candidate
}

// Production's measured unresolved band: within this absolute score difference it can keep the
// left candidate even when the right one is strictly greater. The adversarial sweep asserts the
// band edge; 2.5e-7 is just above the largest kept-left difference observed (2**24 differences
// of scores near 0.25 and 0.75).
const productionBandBound = 2.5e-7

// Adversarial score pairs: bases across the whole [0, 1] magnitude range, offset by 0 to 16
// FP32 ulps in both directions, plus the interval endpoints.
function adversarialPairs(): [number, number][] {
  const bases = [0, 2 ** -126, 2 ** -100, 1e-6, 1e-3, 0.1, 0.25, 0.5, 0.5 + 2 ** -24, 0.75, 0.9, 1 - 2 ** -24, 1]
  const pairs: [number, number][] = []
  for (const rawBase of bases) {
    const base = f32(rawBase)
    for (const k of [0, 1, 2, 3, 4, 8, 16]) {
      let other = base
      for (let step = 0; step < k; step++) other = f32(other + ulpAt(other))
      if (other > 1) continue
      pairs.push([base, other])
      pairs.push([other, base])
    }
  }
  return pairs
}

test('exact ties keep the left candidate in both trees, at every magnitude', () => {
  const production = buildArgmaxTree(2, 'production')
  const cascade = buildArgmaxTree(2, 'cascade')
  for (const rawValue of [0, 2 ** -149, 2 ** -126, 1e-6, 0.1, 0.25, 0.5, 0.75, 1 - 2 ** -24, 1]) {
    const value = f32(rawValue)
    for (const backend of ['reference', 'tensor'] as const) {
      const productionRun = runArgmaxTree(production, [value, value], backend)
      const cascadeRun = runArgmaxTree(cascade, [value, value], backend)
      assert.equal(productionRun.winner, 0, `production tie at ${value}`)
      assert.equal(cascadeRun.winner, 0, `cascade tie at ${value}`)
      assert.ok(productionRun.exactOneHot && cascadeRun.exactOneHot)
      assert.equal(cascadeRun.score, value)
    }
  }
})

test('adversarial pairs: the cascade always picks the true maximum; production diverges only inside its measured band, always by keeping left', () => {
  const production = buildArgmaxTree(2, 'production')
  const cascade = buildArgmaxTree(2, 'cascade')
  let agreements = 0
  let bandDivergences = 0
  for (const [left, right] of adversarialPairs()) {
    const expected = leftmostArgmax([left, right])
    for (const backend of ['reference', 'tensor'] as const) {
      const cascadeRun = runArgmaxTree(cascade, [left, right], backend)
      // The strong claim: the cascade decision equals the native comparison on every pair,
      // and its winning score is exactly the maximum.
      assert.equal(cascadeRun.winner, expected, `cascade at (${left}, ${right})`)
      assert.ok(cascadeRun.exactOneHot)
      assert.equal(cascadeRun.score, Math.max(left, right))

      const productionRun = runArgmaxTree(production, [left, right], backend)
      if (productionRun.winner === cascadeRun.winner) {
        agreements++
        continue
      }
      // Any divergence must sit inside production's unresolved band, and must be production
      // keeping the left candidate where the right one is strictly greater — never the reverse.
      bandDivergences++
      assert.equal(productionRun.winner, 0, 'production divergence must keep left')
      assert.equal(expected, 1)
      const difference = right - left
      assert.ok(difference > 0 && difference < productionBandBound,
        `divergence outside the band: d = ${difference}`)
    }
  }
  assert.ok(agreements > 0 && bandDivergences > 0, 'sweep should exercise both regimes')
})

test('random and near-tie score vectors at 3, 8, 20, 64 candidates match the leftmost-max rule through both evaluators', () => {
  const random = new RandomSource(20260708)
  for (const candidateCount of [3, 8, 20, 64]) {
    const cascade = buildArgmaxTree(candidateCount, 'cascade')
    const production = buildArgmaxTree(candidateCount, 'production')
    const trials = 2000
    let productionBandDivergences = 0
    for (let trial = 0; trial < trials; trial++) {
      const scores = Array.from({length: candidateCount}, () => f32(random.next()))
      // A quarter of the trials plant an exact duplicate of the maximum after it, so the
      // leftmost tie rule is exercised at every width.
      if (trial % 4 === 0) {
        const winner = leftmostArgmax(scores)
        const duplicateAt = winner + 1 + Math.floor(random.next() * (candidateCount - winner - 1))
        if (duplicateAt < candidateCount) scores[duplicateAt] = scores[winner]!
      }
      const expected = leftmostArgmax(scores)
      const backend = trial % 2 === 0 ? 'reference' : 'tensor'
      const cascadeRun = runArgmaxTree(cascade, scores, backend)
      assert.equal(cascadeRun.winner, expected)
      assert.ok(cascadeRun.exactOneHot)
      assert.equal(cascadeRun.score, scores[expected]!)
      const productionRun = runArgmaxTree(production, scores, backend)
      if (productionRun.winner !== expected) {
        // Only production's band can explain a divergence on random data.
        const difference = scores[expected]! - scores[productionRun.winner]!
        assert.ok(difference >= 0 && difference < productionBandBound)
        productionBandDivergences++
      }
    }
    assert.ok(productionBandDivergences < trials / 100, 'random data should rarely enter the band')
  }
}, 60_000)

test('near-tie vectors: a later candidate one ulp above the leader — cascade resolves it, production keeps the leader', () => {
  const cascade = buildArgmaxTree(8, 'cascade')
  const production = buildArgmaxTree(8, 'production')
  const base = f32(0.5)
  const scores = Array<number>(8).fill(f32(0.25))
  scores[2] = base
  scores[6] = f32(base + ulpAt(base))
  assert.equal(leftmostArgmax(scores), 6)
  for (const backend of ['reference', 'tensor'] as const) {
    assert.equal(runArgmaxTree(cascade, scores, backend).winner, 6)
    assert.equal(runArgmaxTree(production, scores, backend).winner, 2)
  }
})

test('the compiled tensor backend agrees with the reference on every live wire', () => {
  for (const variant of ['production', 'cascade'] as const) {
    const tree = buildArgmaxTree(8, variant)
    const random = new RandomSource(7)
    for (let trial = 0; trial < 5; trial++) {
      const source = new Float32Array(tree.circuit.sourceSize)
      for (const wire of tree.scoreWires) source[wire] = f32(random.next())
      source[tree.unitWire] = 1
      validateTensorEvaluation(source, tree.circuit, tree.circuit.evaluateTensor(source))
    }
  }
})

test('op count structure: the cascade uses zero boolean atoms; production uses one per comparison', () => {
  for (const candidateCount of [3, 8, 20, 64]) {
    const cascade = circuitOpCounts(buildArgmaxTree(candidateCount, 'cascade').circuit)
    const production = circuitOpCounts(buildArgmaxTree(candidateCount, 'production').circuit)
    assert.equal(cascade.boolean, 0)
    assert.equal(production.boolean, candidateCount - 1)
    assert.ok(cascade.operations > production.operations)
  }
})

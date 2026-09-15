// Two ways the order of builder statements changes the compiled program, each
// shown as a pair of builds that differ only in statement order.
import {Circuit, type Wire} from '../../../../../numeric-ui-core.ts'
import {measureProgram} from './costs.ts'
import {seededRandom} from './frame-rate-check.ts'

// 1. A declared range only affects operations created after the declaration.
// multiply(value, timestep) is one ReLU-gated product when the timestep's range
// is already declared nonnegative, and three operations (two ReLU-gated products
// and their difference) when it isn't.
export function buildProduct(declareTimestepRange: 'before the product' | 'after the product') {
  const circuit = new Circuit(2)
  const value = 0
  const timestep = 1
  if (declareTimestepRange === 'before the product') circuit.assumeRange(timestep, 0, 0.032)
  const product = circuit.multiply(value, timestep)
  if (declareTimestepRange === 'after the product') circuit.assumeRange(timestep, 0, 0.032)
  return {circuit, product, size: measureProgram(circuit, [product])}
}

// 2. An ordinary affine sum adds its terms in wire-number order, and wire
// numbers follow creation order. With a bias and two fractional terms, FP32
// rounds differently depending on which product was created first.
export function buildWeightedSum(firstProduct: 'left' | 'right') {
  const circuit = new Circuit(4)
  let left: Wire
  let right: Wire
  if (firstProduct === 'left') {
    left = circuit.multiply(0, 1)
    right = circuit.multiply(2, 3)
  } else {
    right = circuit.multiply(2, 3)
    left = circuit.multiply(0, 1)
  }
  const sum = circuit.affine([[left, 0.1], [right, 0.7]], 0.3)
  return {circuit, sum}
}

// The FP32 accumulation the executor performs, in a given term order.
export function referenceWeightedSum(leftProduct: number, rightProduct: number, order: 'left first' | 'right first') {
  const bias = Math.fround(0.3)
  const leftTerm = Math.fround(Math.fround(0.1) * leftProduct)
  const rightTerm = Math.fround(Math.fround(0.7) * rightProduct)
  return order === 'left first'
    ? Math.fround(Math.fround(bias + leftTerm) + rightTerm)
    : Math.fround(Math.fround(bias + rightTerm) + leftTerm)
}

export function checkBuildOrder(seed: number, sampleCount: number) {
  const random = seededRandom(seed)
  const before = buildProduct('before the product')
  const after = buildProduct('after the product')
  const evaluateBefore = before.circuit.createTensorEvaluator([before.product])
  const evaluateAfter = after.circuit.createTensorEvaluator([after.product])
  let productDifferences = 0
  for (let sample = 0; sample < sampleCount; sample++) {
    const source = Float32Array.of((random() * 2 - 1) * 1000, random() * 0.032)
    if (evaluateBefore(source)[0] !== evaluateAfter(source)[0]) productDifferences++
  }

  const leftFirst = buildWeightedSum('left')
  const rightFirst = buildWeightedSum('right')
  const evaluateLeftFirst = leftFirst.circuit.createTensorEvaluator([leftFirst.sum])
  const evaluateRightFirst = rightFirst.circuit.createTensorEvaluator([rightFirst.sum])
  let sumDifferences = 0
  let referenceMismatches = 0
  for (let sample = 0; sample < sampleCount; sample++) {
    const source = Float32Array.from({length: 4}, () => (random() * 2 - 1) * 100)
    const leftProduct = Math.fround(source[0]! * source[1]!)
    const rightProduct = Math.fround(source[2]! * source[3]!)
    const leftFirstValue = evaluateLeftFirst(source)[0]!
    const rightFirstValue = evaluateRightFirst(source)[0]!
    if (leftFirstValue !== rightFirstValue) sumDifferences++
    if (leftFirstValue !== referenceWeightedSum(leftProduct, rightProduct, 'left first')) referenceMismatches++
    if (rightFirstValue !== referenceWeightedSum(leftProduct, rightProduct, 'right first')) referenceMismatches++
  }
  return {
    productBeforeSize: before.size,
    productAfterSize: after.size,
    productDifferences,
    sumDifferences,
    referenceMismatches,
    samples: sampleCount,
  }
}

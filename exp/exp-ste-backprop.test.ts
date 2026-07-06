import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit, type Terms, type Wire} from '../numeric-ui-core.ts'
import {backpropagateSurrogate} from './exp-ste-backprop.ts'

// Deterministic LCG matching the style used elsewhere in the repo.
function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

// Build a seeded random boolean-free circuit: affine and reglu atoms only,
// each reading a couple of earlier wires. Source ranges are left unconstrained
// (the default unknown range) so reglu gates may be positive or negative.
function randomBooleanFreeCircuit(seed: number, sourceSize: number, operationCount: number) {
  const random = createRandom(seed)
  const circuit = new Circuit(sourceSize)
  for (let operation = 0; operation < operationCount; operation++) {
    const available = sourceSize + operation
    const pickWire = () => Math.floor(random() * available)
    const coefficient = () => Math.fround(random() * 4 - 2)
    const leftTerms: [Wire, number][] = [
      [pickWire(), coefficient()],
      [pickWire(), coefficient()],
    ]
    if (random() < 0.5) {
      circuit.affine(leftTerms, Math.fround(random() * 2 - 1))
    } else {
      const gateTerms: [Wire, number][] = [
        [pickWire(), coefficient()],
        [pickWire(), coefficient()],
      ]
      circuit.reglu(leftTerms, Math.fround(random() * 2 - 1), gateTerms, Math.fround(random() * 2 - 1))
    }
  }
  return circuit
}

function randomSource(random: () => number, size: number) {
  const source = new Float32Array(size)
  for (let wire = 0; wire < size; wire++) source[wire] = Math.fround(random() * 2 - 1)
  return source
}

function randomOutputGradients(random: () => number, width: number) {
  const outputGradients = new Float32Array(width)
  for (let wire = 0; wire < width; wire++) outputGradients[wire] = Math.fround(random() * 2 - 1)
  return outputGradients
}

test('surrogate backprop equals the reference on boolean-free circuits', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const circuit = randomBooleanFreeCircuit(seed, 5, 40)
    const width = circuit.sourceSize + circuit.operations.length
    const random = createRandom(seed ^ 0x9e_37_79_b9)
    const source = randomSource(random, circuit.sourceSize)
    const values = circuit.evaluateReference(source)
    const outputGradients = randomOutputGradients(random, width)

    const reference = circuit.backpropagateReference(values, outputGradients)
    for (const mode of ['ste', 'sigmoidSte'] as const) {
      const surrogate = backpropagateSurrogate(circuit, values, outputGradients, {mode})
      assert.equal(surrogate.length, reference.length)
      for (let wire = 0; wire < reference.length; wire++) {
        assert.equal(
          surrogate[wire],
          reference[wire],
          `seed ${seed} mode ${mode} wire ${wire} diverged from reference`,
        )
      }
    }
  }
})

// A float64 forward shadow of the circuit. Backprop differentiates the FP32
// arithmetic "as real-valued"; this evaluator carries the same algebra in
// double precision so central differences can probe the analytic gradient
// without FP32 rounding noise swamping the step.
function evaluateShadow(circuit: Circuit, source: Float64Array): Float64Array {
  const evaluateTerms = (values: Float64Array, terms: Terms, bias: number) => {
    let value = bias
    for (const [wire, coefficient] of terms) value += coefficient * values[wire]!
    return value
  }
  const values = new Float64Array(circuit.sourceSize + circuit.operations.length)
  values.set(source)
  for (let operation = 0; operation < circuit.operations.length; operation++) {
    const op = circuit.operations[operation]!
    let value = evaluateTerms(values, op.leftTerms, op.leftBias)
    if (op.kind === 'reglu') {
      value *= Math.max(0, evaluateTerms(values, op.gateTerms, op.gateBias))
    }
    values[circuit.sourceSize + operation] = value
  }
  return values
}

test('surrogate backprop matches central differences on a float64 shadow', () => {
  for (const seed of [11, 12, 13, 14]) {
    const circuit = randomBooleanFreeCircuit(seed, 4, 25)
    const width = circuit.sourceSize + circuit.operations.length
    const random = createRandom(seed ^ 0x12_34_56_78)
    const source = randomSource(random, circuit.sourceSize)
    const values = circuit.evaluateReference(source)
    // Weight one scalar output so the gradient is the derivative of that wire.
    const outputWire = width - 1
    const outputGradients = new Float32Array(width)
    outputGradients[outputWire] = 1

    const analytic = backpropagateSurrogate(circuit, values, outputGradients, {mode: 'ste'})

    const shadowSource = Float64Array.from(source)
    const step = 1e-4
    for (let wire = 0; wire < circuit.sourceSize; wire++) {
      const original = shadowSource[wire]!
      shadowSource[wire] = original + step
      const high = evaluateShadow(circuit, shadowSource)[outputWire]!
      shadowSource[wire] = original - step
      const low = evaluateShadow(circuit, shadowSource)[outputWire]!
      shadowSource[wire] = original
      const numeric = (high - low) / (2 * step)
      assert.ok(
        Math.abs(numeric - analytic[wire]!) <= 1e-2 * (1 + Math.abs(numeric)),
        `seed ${seed} wire ${wire}: analytic ${analytic[wire]} vs numeric ${numeric}`,
      )
    }
  }
})

// Re-derive clamp01 locally (it is not exported): relu(v) - relu(v-1), with the
// result asserted into [0,1] so boolean() will accept it. relu(u) is reglu with
// left bias 1 gated by u, exactly as emitRelu does in core.
function emitReluLocal(circuit: Circuit, value: Wire): Wire {
  return circuit.reglu([], 1, [[value, 1]], 0)
}

function emitClamp01Local(circuit: Circuit, value: Wire): Wire {
  const positive = emitReluLocal(circuit, value)
  const aboveOne = emitReluLocal(circuit, circuit.affine([[value, 1]], -1))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

// 1-D threshold classifier: bit = boolean(clamp01(x - b)). b is a source
// parameter cell, x a source input. The bit is 1 when x - b >= 0.5, i.e. when
// x >= b + 0.5. With true threshold 0.37 the label data is generated as
// x >= 0.37, so the learnable parameter settles at b = 0.37 - 0.5 = -0.13.
function buildThresholdClassifier() {
  const parameterWire = 0
  const inputWire = 1
  const circuit = new Circuit(2)
  circuit.assumeRange(parameterWire, -4, 4)
  circuit.assumeRange(inputWire, 0, 1)
  const shifted = circuit.affine([[inputWire, 1], [parameterWire, -1]])
  const clamped = emitClamp01Local(circuit, shifted)
  const bit = circuit.boolean(clamped)
  return {circuit, parameterWire, inputWire, bit}
}

// Decision boundary x* solving clamp01(x - b) = 0.5, i.e. x - b = 0.5.
function decisionBoundary(b: number) {
  return b + 0.5
}

type DataPoint = {x: number, label: number}

function makeDataset(seed: number, count: number, trueThreshold: number): DataPoint[] {
  const random = createRandom(seed)
  const data: DataPoint[] = []
  for (let index = 0; index < count; index++) {
    const x = Math.fround(random())
    data.push({x, label: x >= trueThreshold ? 1 : 0})
  }
  return data
}

// Train b by gradient descent with the sigmoid surrogate. Loss = (bit - label)^2
// summed over the dataset. dLoss/dbit = 2 (bit - label); the surrogate carries
// that back through the boolean into the parameter cell.
function trainThreshold(
  seed: number,
  options: {
    mode: 'ste' | 'sigmoidSte'
    temperature: number
    learningRate: number
    epochs: number
    trueThreshold: number
    sampleCount: number
  },
) {
  const {circuit, parameterWire, inputWire, bit} = buildThresholdClassifier()
  const width = circuit.sourceSize + circuit.operations.length
  const dataset = makeDataset(seed, options.sampleCount, options.trueThreshold)
  const source = new Float32Array(2)
  // Start the boundary away from the truth so convergence is meaningful.
  source[parameterWire] = 0
  let b = 0
  for (let epoch = 0; epoch < options.epochs; epoch++) {
    let gradient = 0
    for (const point of dataset) {
      source[parameterWire] = b
      source[inputWire] = point.x
      const values = circuit.evaluateReference(source)
      const predicted = values[bit]!
      const outputGradients = new Float32Array(width)
      outputGradients[bit] = 2 * (predicted - point.label)
      const grads = backpropagateSurrogate(circuit, values, outputGradients, {
        mode: options.mode,
        temperature: options.temperature,
      })
      gradient += grads[parameterWire]!
    }
    gradient /= dataset.length
    b -= options.learningRate * gradient
    b = Math.max(-4, Math.min(4, b))
  }
  // Recover the implied threshold from the learned boundary.
  return decisionBoundary(b)
}

// Stable hyperparameters found by sweeping (see the report). The two levers
// that matter:
//   * Learning rate: 0.6 oscillates. The squared-error loss on a hard 0/1 bit
//     is piecewise constant, so the surrogate gradient only sees the boundary
//     band; a large step overshoots the data gap and the boundary bounces
//     between the two clouds without ever settling inside the gap. lr 0.1
//     lets it settle.
//   * Sample count: 128 samples leaves a wide empty gap between the largest
//     x < 0.37 and the smallest x >= 0.37. Once every sample is correctly
//     classified the loss is exactly zero and the gradient is exactly zero
//     (the dead-plateau failure), so the boundary freezes wherever it happened
//     to stop inside that gap -- which can be 0.04 off. 512 samples narrows
//     the gap below the 0.02 tolerance, so the frozen boundary is close enough.
const stableThresholdConfig = {
  temperature: 6,
  learningRate: 0.1,
  epochs: 600,
  trueThreshold: 0.37,
  sampleCount: 512,
} as const

function convergedSeeds(mode: 'ste' | 'sigmoidSte') {
  const seeds = [1, 2, 3, 4]
  const recovered = seeds.map(seed =>
    trainThreshold(seed, {mode, ...stableThresholdConfig}))
  const successes = recovered.filter(
    threshold => Math.abs(threshold - stableThresholdConfig.trueThreshold) < 0.02,
  ).length
  return {successes, recovered}
}

test('sigmoid surrogate learns a 1-D threshold classifier across seeds', () => {
  const {successes, recovered} = convergedSeeds('sigmoidSte')
  assert.ok(
    successes >= 3,
    `only ${successes}/4 seeds converged; recovered thresholds ${recovered.map(value => value.toFixed(4)).join(', ')}`,
  )
})

test('plain straight-through estimator also learns the threshold across seeds', () => {
  const {successes, recovered} = convergedSeeds('ste')
  assert.ok(
    successes >= 3,
    `only ${successes}/4 seeds converged; recovered thresholds ${recovered.map(value => value.toFixed(4)).join(', ')}`,
  )
})

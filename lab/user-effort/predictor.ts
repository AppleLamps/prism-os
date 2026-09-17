import {Circuit, type Wire} from '../../src/runtime/numeric-ui-core.ts'
import {observationInput, type EffortInput, type Observation} from './domain.ts'

export const parameterNames = ['base', 'difficulty / 6', 'clutter', 'motor context', '(difficulty / 6) * motor context'] as const
export const parameterCount = parameterNames.length
const featureCount = 3

// Logarithm and geometry measurement are fixed preprocessing, not learned operations.
export function inputFeatures(input: EffortInput): Float32Array {
  return Float32Array.of(Math.log2(1 + input.distance / input.targetWidth) / 6, input.clutter, input.motorContext)
}

export function createPredictor(parameters: readonly number[] = [0, 0, 0, 0, 0]) {
  if (parameters.length !== parameterCount) throw new Error('expected five parameters')
  const circuit = new Circuit(parameterCount + featureCount)
  const difficulty: Wire = parameterCount
  const clutter: Wire = parameterCount + 1
  const motorContext: Wire = parameterCount + 2
  circuit.assumeRange(difficulty, 0, 2)
  circuit.assumeRange(clutter, 0, 1)
  circuit.assumeRange(motorContext, 0, 1)
  const interaction = circuit.multiply(difficulty, motorContext)
  const output = circuit.roundAffine([
    [0, 1],
    [circuit.multiply(1, difficulty), 1],
    [circuit.multiply(2, clutter), 1],
    [circuit.multiply(3, motorContext), 1],
    [circuit.multiply(4, interaction), 1],
  ])
  const source = new Float32Array(circuit.sourceSize)
  source.set(parameters)
  const evaluate = circuit.createTensorEvaluator([output])
  return {
    circuit, source, output,
    predict(input: EffortInput) {
      source.set(inputFeatures(input), parameterCount)
      return evaluate(source)[0]! * 1000
    },
  }
}

export function trainPredictor(observations: readonly Observation[], epochs = 800) {
  if (observations.length === 0) throw new Error('training needs observations')
  const model = createPredictor()
  const examples = observations.map(observation => ({features: inputFeatures(observationInput(observation)), target: observation.durationMs / 1000}))
  const firstMoments = new Float64Array(parameterCount)
  const secondMoments = new Float64Array(parameterCount)
  const gradients = new Float64Array(parameterCount)
  const outputGradients = new Float32Array(model.circuit.sourceSize + model.circuit.operations.length)
  const losses: number[] = []
  for (let epoch = 1; epoch <= epochs; epoch++) {
    gradients.fill(0)
    let loss = 0
    for (const example of examples) {
      model.source.set(example.features, parameterCount)
      const values = model.circuit.evaluateReference(model.source)
      const error = values[model.output]! - example.target
      loss += error * error / examples.length
      outputGradients[model.output] = 2 * error / examples.length
      const backward = model.circuit.backpropagateReference(values, outputGradients)
      for (let parameter = 0; parameter < parameterCount; parameter++) gradients[parameter]! += backward[parameter]!
    }
    for (let parameter = 0; parameter < parameterCount; parameter++) {
      const gradient = gradients[parameter]!
      firstMoments[parameter] = 0.9 * firstMoments[parameter]! + 0.1 * gradient
      secondMoments[parameter] = 0.999 * secondMoments[parameter]! + 0.001 * gradient * gradient
      const first = firstMoments[parameter]! / (1 - 0.9 ** epoch)
      const second = secondMoments[parameter]! / (1 - 0.999 ** epoch)
      model.source[parameter]! -= 0.04 * first / (Math.sqrt(second) + 1e-8)
    }
    losses.push(loss)
  }
  return {parameters: Array.from(model.source.slice(0, parameterCount)), epochs, losses}
}

export function predictionErrors(observations: readonly Observation[], predict: (input: EffortInput) => number, target: (observation: Observation) => number) {
  let squaredError = 0
  let absoluteError = 0
  for (const observation of observations) {
    const error = predict(observationInput(observation)) - target(observation)
    squaredError += error * error
    absoluteError += Math.abs(error)
  }
  return {rmseMs: Math.sqrt(squaredError / observations.length), maeMs: absoluteError / observations.length}
}

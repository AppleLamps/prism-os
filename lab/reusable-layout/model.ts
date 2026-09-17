import {Circuit, type Wire} from '../../src/runtime/numeric-ui-core.ts'
import {createRandom} from './data.ts'
import type {PreparedScene} from './layout.ts'

export const featureCount = 8
export const hiddenWidth = 12
const firstBias = featureCount * hiddenWidth
const outputWeights = firstBias + hiddenWidth
const outputBias = outputWeights + hiddenWidth
export const parameterCount = outputBias + 1

export function itemFeatures(scene: PreparedScene, index: number): Float32Array {
  const item = scene.items[index]!
  let meanRatio = 0
  let meanImportance = 0
  for (const entry of scene.items) {
    meanRatio += entry.aspectRatio / scene.items.length
    meanImportance += entry.importance / scene.items.length
  }
  return Float32Array.of(
    scene.width / 1280,
    item.aspectRatio / 3,
    item.text.totalWidth / 1000,
    item.importance,
    scene.items.length / 16,
    meanRatio / 3,
    index / Math.max(1, scene.items.length - 1),
    meanImportance,
  )
}

export function createRule(parameters?: readonly number[]) {
  const circuit = new Circuit(parameterCount + featureCount)
  for (let index = 0; index < featureCount; index++) circuit.assumeRange(parameterCount + index, 0, 8)
  const hidden: Wire[] = []
  for (let neuron = 0; neuron < hiddenWidth; neuron++) {
    const terms: [Wire, number][] = [[firstBias + neuron, 1]]
    for (let feature = 0; feature < featureCount; feature++) {
      terms.push([circuit.multiply(neuron * featureCount + feature, parameterCount + feature), 1])
    }
    const sum = circuit.roundAffine(terms)
    hidden.push(circuit.reglu([], 1, [[sum, 1]], 0))
  }
  const output = circuit.roundAffine([
    [outputBias, 1],
    ...hidden.map((wire, index): [Wire, number] => [circuit.multiply(outputWeights + index, wire), 1]),
  ])
  const source = new Float32Array(circuit.sourceSize)
  if (parameters !== undefined) {
    if (parameters.length !== parameterCount) throw new Error('model parameter count differs')
    source.set(parameters)
  }
  const evaluate = circuit.createTensorEvaluator([output])
  return {
    circuit, output, source,
    predict(features: Float32Array) {
      source.set(features, parameterCount)
      return evaluate(source)[0]! * 400
    },
    preferences(scene: PreparedScene) {
      return scene.items.map((_, index) => {
        source.set(itemFeatures(scene, index), parameterCount)
        return evaluate(source)[0]! * 400
      })
    },
  }
}

export type TrainingExample = {features: Float32Array, target: number}

export function trainRule(examples: readonly TrainingExample[], seed: number, epochs = 160) {
  const random = createRandom(seed)
  const rule = createRule()
  for (let index = 0; index < parameterCount; index++) rule.source[index] = (random() - 0.5) * 0.4
  for (let index = 0; index < hiddenWidth; index++) rule.source[firstBias + index] = 0.1
  rule.source[outputBias] = 0.56
  const first = new Float64Array(parameterCount)
  const second = new Float64Array(parameterCount)
  const gradients = new Float64Array(parameterCount)
  const seeds = new Float32Array(rule.circuit.sourceSize + rule.circuit.operations.length)
  const order = Array.from({length: examples.length}, (_, index) => index)
  let updates = 0
  const losses: number[] = []
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let end = order.length - 1; end > 0; end--) {
      const other = Math.floor(random() * (end + 1))
      ;[order[end], order[other]] = [order[other]!, order[end]!]
    }
    let totalLoss = 0
    for (let start = 0; start < order.length; start += 32) {
      gradients.fill(0)
      const end = Math.min(order.length, start + 32)
      for (let offset = start; offset < end; offset++) {
        const example = examples[order[offset]!]!
        rule.source.set(example.features, parameterCount)
        const values = rule.circuit.evaluateReference(rule.source)
        const error = values[rule.output]! - example.target / 400
        totalLoss += error * error
        seeds[rule.output] = 2 * error / (end - start)
        const backward = rule.circuit.backpropagateReference(values, seeds)
        for (let parameter = 0; parameter < parameterCount; parameter++) gradients[parameter]! += backward[parameter]!
      }
      updates++
      for (let parameter = 0; parameter < parameterCount; parameter++) {
        const gradient = gradients[parameter]!
        first[parameter] = 0.9 * first[parameter]! + 0.1 * gradient
        second[parameter] = 0.999 * second[parameter]! + 0.001 * gradient * gradient
        const step = 0.008 * (first[parameter]! / (1 - 0.9 ** updates))
          / (Math.sqrt(second[parameter]! / (1 - 0.999 ** updates)) + 1e-8)
        rule.source[parameter]! -= step
      }
    }
    losses.push(totalLoss / examples.length)
  }
  return {parameters: Array.from(rule.source.slice(0, parameterCount)), losses, seed, epochs}
}

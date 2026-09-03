// Training through the argmax with no surrogate gradient. The task: a selection table with one
// row per case and one weight cell per candidate; the circuit reads the active case as a one-hot
// context, forms candidate scores, and the cascade argmax picks a winner. The loss is squared
// error between the selected one-hot and the target one-hot, so the only gradient path into the
// weights runs through softened comparisons. The exact hard comparison is used
// only for verification, not as a source of useful training gradients.
//
// Train soft, run exact: the soft form keeps the hard topology and anneals the seven stage
// scales upward. Each clamp01 stage is a ramp below its saturation point, so the composite
// decision is a piecewise-linear saturating slope of the score difference; the ramp offset
// centers it on zero difference so both orderings receive gradient. After the last soft stage
// the weights transfer unchanged into the hard circuit (same source layout), which selects
// exact winners.

import {Circuit, type Wire, invariant} from '../../numeric-ui-core.ts'
import {
  type CascadeOptions,
  emitCascadeArgmax,
  hardCascadeOptions,
  softCascadeOptions,
} from './cascade-argmax.ts'

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

export type TrainingConfig = {
  candidateCount: number
  caseCount: number
  epochsPerStage: number
  learningRate: number
  // Total gains of the soft stages, annealed upward. The hard form follows.
  softStageGains: number[]
  softComparator?: 'cascade' | 'single-ramp'
}

export const defaultTrainingConfig: TrainingConfig = {
  candidateCount: 8,
  caseCount: 16,
  epochsPerStage: 150,
  learningRate: 0.15,
  softStageGains: [2 ** 3, 2 ** 6, 2 ** 10, 2 ** 15, 2 ** 21],
}

type SelectionCircuit = {
  circuit: Circuit
  contextWires: Wire[]
  weightWires: Wire[][]
  selected: Wire[]
}

// Sources: [unit, context one-hot (caseCount), weights (caseCount x candidateCount)].
// score_i = sum over cases of context_case * weight[case][i]; with an exact one-hot context the
// score equals the active row's weight, and it stays in [0, 1].
function buildSelectionCircuit(config: TrainingConfig, options: CascadeOptions): SelectionCircuit {
  const {candidateCount, caseCount} = config
  const circuit = new Circuit(1 + caseCount + caseCount * candidateCount)
  const unit = 0
  circuit.assumeRange(unit, 1, 1)
  const contextWires: Wire[] = []
  for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
    const wire = 1 + caseIndex
    circuit.assumeRange(wire, 0, 1)
    contextWires.push(wire)
  }
  const weightWires: Wire[][] = []
  for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
    const row: Wire[] = []
    for (let item = 0; item < candidateCount; item++) {
      const wire = 1 + caseCount + caseIndex * candidateCount + item
      circuit.assumeRange(wire, 0, 1)
      row.push(wire)
    }
    weightWires.push(row)
  }
  const scores: Wire[] = []
  for (let item = 0; item < candidateCount; item++) {
    const products: [Wire, number][] = []
    for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
      const product = circuit.reglu(
        [[weightWires[caseIndex]![item]!, 1]], 0,
        [[contextWires[caseIndex]!, 1]], 0,
      )
      products.push([product, 1])
    }
    const score = circuit.affine(products)
    // Sound at runtime: the context is an exact one-hot, so the sum is one weight in [0, 1].
    circuit.assumeRange(score, 0, 1)
    scores.push(score)
  }
  const {selected} = emitCascadeArgmax(circuit, scores, unit, options)
  return {circuit, contextWires, weightWires, selected}
}

export type TrainingRun = {
  seed: number
  targets: number[]
  softCorrectByStage: number[]
  hardenedCorrect: number
  hardenedExactOneHot: boolean
  caseCount: number
}

export function trainSelection(seed: number, config: TrainingConfig = defaultTrainingConfig): TrainingRun {
  const random = new RandomSource(seed)
  const {candidateCount, caseCount} = config
  const targets = Array.from({length: caseCount}, () => Math.floor(random.next() * candidateCount))
  // Weights start close together so every comparison sits inside the widest soft ramp and
  // receives gradient from the first epoch.
  const weights = Array.from(
    {length: caseCount},
    () => Array.from({length: candidateCount}, () => 0.5 + 0.04 * (random.next() - 0.5)),
  )

  const fillSource = (selection: SelectionCircuit, caseIndex: number): Float32Array => {
    const source = new Float32Array(selection.circuit.sourceSize)
    source[0] = 1
    source[selection.contextWires[caseIndex]!] = 1
    for (let row = 0; row < caseCount; row++) {
      for (let item = 0; item < candidateCount; item++) {
        source[selection.weightWires[row]![item]!] = weights[row]![item]!
      }
    }
    return source
  }

  const softCorrectByStage: number[] = []
  for (const totalGain of config.softStageGains) {
    const selection = buildSelectionCircuit(config, softCascadeOptions(totalGain, config.softComparator))
    const width = selection.circuit.sourceSize + selection.circuit.operations.length
    // The gradient magnitude scales with the ramp slope, so the step size shrinks as the ramp
    // sharpens; clipping keeps late stages from overshooting.
    const stageLearningRate = config.learningRate / Math.sqrt(totalGain)
    let stageCorrect = 0
    for (let epoch = 0; epoch < config.epochsPerStage; epoch++) {
      stageCorrect = 0
      for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
        const source = fillSource(selection, caseIndex)
        const values = selection.circuit.evaluateReference(source)
        const outputGradients = new Float32Array(width)
        let winner = 0
        for (let item = 0; item < candidateCount; item++) {
          const wire = selection.selected[item]!
          const targetValue = item === targets[caseIndex] ? 1 : 0
          outputGradients[wire] = 2 * (values[wire]! - targetValue)
          if (values[wire]! > values[selection.selected[winner]!]!) winner = item
        }
        if (winner === targets[caseIndex]) stageCorrect++
        const gradients = selection.circuit.backpropagateReference(values, outputGradients)
        for (let row = 0; row < caseCount; row++) {
          for (let item = 0; item < candidateCount; item++) {
            const wire = selection.weightWires[row]![item]!
            const step = stageLearningRate * Math.max(-1, Math.min(1, gradients[wire]!))
            weights[row]![item] = Math.min(1, Math.max(0, weights[row]![item]! - step))
          }
        }
      }
      if (stageCorrect === caseCount && epoch > 10) break
    }
    softCorrectByStage.push(stageCorrect)
  }

  // Harden: same weights, exact cascade. Winners must be exact through both evaluators.
  const hardened = buildSelectionCircuit(config, hardCascadeOptions())
  hardened.circuit.tensorProgram = hardened.circuit.compileTensorProgram(hardened.selected)
  let hardenedCorrect = 0
  let hardenedExactOneHot = true
  for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
    const source = fillSource(hardened, caseIndex)
    const referenceValues = hardened.circuit.evaluateReference(source)
    const tensorValues = hardened.circuit.evaluateTensor(source)
    let correct = true
    for (let item = 0; item < candidateCount; item++) {
      const wire = hardened.selected[item]!
      const expected = item === targets[caseIndex] ? 1 : 0
      if (referenceValues[wire] !== expected) correct = false
      if (tensorValues[wire] !== referenceValues[wire]) correct = false
      if (referenceValues[wire] !== 0 && referenceValues[wire] !== 1) hardenedExactOneHot = false
    }
    if (correct) hardenedCorrect++
  }
  invariant(softCorrectByStage.length === config.softStageGains.length, 'stage accounting')
  return {seed, targets, softCorrectByStage, hardenedCorrect, hardenedExactOneHot, caseCount}
}

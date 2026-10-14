// Learned wiring: recover a circuit's CONNECTIONS from behavior, one level
// below learned cells.
//
// lab/event-window/integer-bits.ts learns the VALUES in a relation table whose
// wiring is fixed: every (source, target) pair exists as a cell, and training
// decides each cell's bit. The July 2026 plan for differentiable logic gates,
// exp/exp-dlgn-plan.md (removed; README.md's "Related work" keeps its sources,
// https://github.com/chenglou/handwired/blob/exploration-2026-09/exp/exp-dlgn-plan.md),
// goes further in its stage 3 -- learn which OPERATION each node computes --
// but explicitly parks connection learning:
// "Connections (fan-in wiring) stay random and fixed per Petersen -- learning
// wiring too is not attempted here (it is the expensive open problem)." This
// experiment probes that open problem at the smallest interesting scale: a
// two-layer circuit where both input connections of every gate AND the gate's
// operation are trainable source cells, recovered from input/output examples
// alone, then hardened to an exact circuit.
//
// Parameterization decisions:
//
// - A gate's operation is stored as its TRUTH TABLE: four source cells
//   (f00, f10, f01, f11), each in [0,1]. The soft output is the multilinear
//   interpolation
//     f00*(1-a)*(1-b) + f10*a*(1-b) + f01*(1-a)*b + f11*a*b
//   This is Petersen et al.'s 16-gate softmax mixture (README.md's "Related work")
//   collapsed to its four independent dimensions: every convex mixture of the
//   16 relaxed gates evaluates to the interpolation of some truth table in
//   [0,1]^4, and mixtures sharing a truth table compute identical functions,
//   so the 16-way mixture is redundant by 12 dimensions. Hardening rounds each
//   cell to a bit, and any four bits are a valid gate -- there is no "snapped
//   to an invalid operation" failure mode.
// - A gate input is a convex mixture over candidate wires: one selection cell
//   per candidate. The trainer stores selection LOGITS and writes their
//   softmax into the source cells each epoch, with an inverse temperature that
//   anneals upward so mixtures sharpen toward one-hot over training -- without
//   the anneal, selections plateau at blurred mixtures whose truth cells
//   compensate, and the hardened circuit is wrong. The softmax and its
//   backward pass live in the trainer; the circuit sees only multiplies and
//   adds (the July plan's stage 2, "bake the softmax on the parameter
//   side"). Hardening keeps the argmax candidate.
// - No boolean atom appears anywhere, so Circuit.backpropagateReference
//   differentiates everything natively (lab/event-window/integer-bits.ts makes
//   the same move on the decision side), and a hardened gate fed exact bits
//   produces exact bits by integer arithmetic.
//
// Hidden ground truth, never shown to the trainer as structure:
//   hidden = AND(in0, in1)
//   out0   = OR(hidden, in2)
//   out1   = XOR(in1, in3)
// out0 depends on three inputs, so no single two-input gate can express it:
// matching the behavior forces the trainer to route through a layer-1
// intermediate. Wiring is identifiable only up to behavior (NAND feeding
// "NOT A OR B" also computes out0), so the tests assert bit-exact behavior on
// ALL 16 input rows -- including rows held out from training -- rather than
// one canonical structure.

import {
  Circuit,
  type Wire,
  emitMultiply,
  invariant,
  validateCircuit,
} from '../../../src/runtime/numeric-ui-core.ts'
// Deterministic LCG, matching src/learned-gallery/trainable-geometry.ts.
export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

export const inputCount = 4
export const layerOneGateCount = 2
export const layerTwoGateCount = 2 // these are the circuit outputs
export const rowCount = 1 << inputCount

// Candidate wires a gate may connect to: layer-1 gates choose among the raw
// inputs; layer-2 gates choose among the inputs plus every layer-1 output.
const layerOneCandidateCount = inputCount
const layerTwoCandidateCount = inputCount + layerOneGateCount

export type GateSlot = {
  layer: 1 | 2
  candidateCount: number
  selectAStart: number
  selectBStart: number
  truthStart: number
}

function buildGateSlots(): GateSlot[] {
  const slots: GateSlot[] = []
  let cursor = inputCount
  for (let gate = 0; gate < layerOneGateCount + layerTwoGateCount; gate++) {
    const layer = gate < layerOneGateCount ? 1 : 2
    const candidateCount = layer === 1 ? layerOneCandidateCount : layerTwoCandidateCount
    slots.push({
      layer,
      candidateCount,
      selectAStart: cursor,
      selectBStart: cursor + candidateCount,
      truthStart: cursor + candidateCount * 2,
    })
    cursor += candidateCount * 2 + 4
  }
  return slots
}

export const gateSlots: readonly GateSlot[] = buildGateSlots()
export const sourceSize =
  inputCount + gateSlots.reduce((sum, slot) => sum + slot.candidateCount * 2 + 4, 0)

// A convex mixture over candidate wires. Each product is a single reglu
// because the selection cell is the provably non-negative operand. Interval
// arithmetic alone would bound the sum by the candidate count; the [0,1] range
// is the trainer's contract that each selection group sums to 1.
function emitMixture(
  circuit: Circuit,
  selectStart: number,
  candidates: readonly Wire[],
): Wire {
  const terms: (readonly [Wire, number])[] = candidates.map(
    (candidate, index) => [emitMultiply(circuit, candidate, selectStart + index), 1],
  )
  const mixture = circuit.affine(terms)
  circuit.assumeRange(mixture, 0, 1)
  return mixture
}

// Multilinear interpolation of a truth table stored in four source cells. The
// four region masses (1-a)(1-b), a(1-b), (1-a)b, ab share one product wire;
// each mass then multiplies its truth cell with one reglu (the truth cell is
// the provably non-negative operand, so the multiply is exact for any mass
// sign).
function emitTruthTableGate(
  circuit: Circuit,
  truthStart: number,
  a: Wire,
  b: Wire,
): Wire {
  const product = emitMultiply(circuit, a, b)
  const mass00 = circuit.affine([[a, -1], [b, -1], [product, 1]], 1)
  const mass10 = circuit.affine([[a, 1], [product, -1]])
  const mass01 = circuit.affine([[b, 1], [product, -1]])
  const output = circuit.affine([
    [emitMultiply(circuit, mass00, truthStart + 0), 1],
    [emitMultiply(circuit, mass10, truthStart + 1), 1],
    [emitMultiply(circuit, mass01, truthStart + 2), 1],
    [emitMultiply(circuit, product, truthStart + 3), 1],
  ])
  // The masses sum to 1 for a, b in [0,1], so the output is a convex
  // combination of cells in [0,1]. Interval arithmetic cannot see the masses
  // are coupled, so pin the range by contract.
  circuit.assumeRange(output, 0, 1)
  return output
}

export function createWiringCircuit() {
  const circuit = new Circuit(sourceSize)
  // Inputs are bits (or soft bits during probing); selection and truth cells
  // are trained inside [0,1].
  for (let index = 0; index < sourceSize; index++) circuit.assumeRange(index, 0, 1)

  const inputs: Wire[] = Array.from({length: inputCount}, (_, index) => index)
  const layerOne: Wire[] = []
  const outputs: Wire[] = []
  for (const slot of gateSlots) {
    const candidates = slot.layer === 1 ? inputs : [...inputs, ...layerOne]
    invariant(candidates.length === slot.candidateCount, 'candidate list mismatches the slot layout')
    const a = emitMixture(circuit, slot.selectAStart, candidates)
    const b = emitMixture(circuit, slot.selectBStart, candidates)
    const gate = emitTruthTableGate(circuit, slot.truthStart, a, b)
    if (slot.layer === 1) layerOne.push(gate)
    else outputs.push(gate)
  }

  invariant(
    circuit.operations.every(operation => operation.kind !== 'boolean'),
    'the wiring circuit must not contain boolean atoms',
  )
  validateCircuit(circuit)
  return {circuit, outputs, layerOne}
}

// Row r encodes input bit i as (r >> i) & 1.
export function inputBitsOfRow(row: number): number[] {
  invariant(Number.isInteger(row) && row >= 0 && row < rowCount, 'row index is out of range')
  return Array.from({length: inputCount}, (_, index) => (row >> index) & 1)
}

export function groundTruthOutputs(bits: readonly number[]): [number, number] {
  const hidden = bits[0]! & bits[1]!
  return [hidden | bits[2]!, bits[1]! ^ bits[3]!]
}

export type WiringTrainOptions = {
  seed?: number
  learningRate?: number
  epochs?: number
  trainingRows?: readonly number[]
  // Softmax inverse temperature over the selection logits, annealed linearly
  // from start to end across each restart window. Higher = sharper mixtures.
  sharpnessStart?: number
  sharpnessEnd?: number
  // Epochs to spend on one initialization before drawing fresh noise. Wiring
  // recovery either converges within roughly a hundred epochs or sits on a
  // plateau (typically an unlearned XOR), so restarts inside the same epoch
  // budget recover most stuck initializations.
  restartEpochs?: number
}

export type WiringTrainResult = {
  source: Float32Array
  finalLoss: number
  epochsRun: number
}

// Trainer-side bookkeeping: the flat order of all selection groups, and where
// each group's logits and source cells live.
type SelectionGroup = {sourceStart: number, logitStart: number, count: number}

function buildSelectionGroups(): SelectionGroup[] {
  const groups: SelectionGroup[] = []
  let logitStart = 0
  for (const slot of gateSlots) {
    for (const sourceStart of [slot.selectAStart, slot.selectBStart]) {
      groups.push({sourceStart, logitStart, count: slot.candidateCount})
      logitStart += slot.candidateCount
    }
  }
  return groups
}

// Evaluate a hardened wiring in plain JS -- gate truth tables over the wired
// candidates -- so the trainer can cheaply probe "would hardening right now be
// exact?" without building a circuit. The candidate order matches
// createWiringCircuit: inputs first, then layer-1 outputs.
export function simulateWiring(wiring: HardenedWiring, bits: readonly number[]): number[] {
  const values = [...bits]
  const outputs: number[] = []
  for (let gate = 0; gate < wiring.length; gate++) {
    const hardened = wiring[gate]!
    const a = values[hardened.selectA]!
    const b = values[hardened.selectB]!
    const output = hardened.truth[a + 2 * b]!
    if (gateSlots[gate]!.layer === 1) values.push(output)
    else outputs.push(output)
  }
  return outputs
}

// Whether a hardened wiring reproduces the ground truth on the given rows.
// The trainer only ever probes this on its TRAINING rows -- stopping early on
// held-out rows would leak the test set into training.
function hardenedIsExactOn(wiring: HardenedWiring, rows: readonly number[]): boolean {
  for (const row of rows) {
    const bits = inputBitsOfRow(row)
    const expected = groundTruthOutputs(bits)
    const observed = simulateWiring(wiring, bits)
    if (observed[0] !== expected[0] || observed[1] !== expected[1]) return false
  }
  return true
}

// Train every wiring parameter -- selection logits and truth cells for all
// four gates -- against input/output examples of the hidden circuit, using the
// plain reference backward pass. The parameter vector is [selection logits,
// truth cells]; each epoch writes softmax(sharpness * logits) into the
// selection source cells, backpropagates to the source cells, and converts
// selection-cell gradients to logit gradients by the softmax Jacobian.
export function trainWiring(options: WiringTrainOptions = {}): WiringTrainResult {
  const seed = options.seed ?? 1
  const learningRate = options.learningRate ?? 0.05
  const epochs = options.epochs ?? 6000
  const trainingRows = options.trainingRows ?? Array.from({length: rowCount}, (_, row) => row)
  const sharpnessStart = options.sharpnessStart ?? 2
  const sharpnessEnd = options.sharpnessEnd ?? 12
  const restartEpochs = options.restartEpochs ?? 1000
  const {circuit, outputs} = createWiringCircuit()
  const selectionGroups = buildSelectionGroups()
  const logitCount = selectionGroups.reduce((sum, group) => sum + group.count, 0)
  const truthCellCount = gateSlots.length * 4

  const random = createRandom(seed ^ 0x3c_6e_f3)
  const source = new Float32Array(sourceSize)
  const logits = new Float64Array(logitCount)
  const parameterCount = logitCount + truthCellCount
  const firstMoment = new Float64Array(parameterCount)
  const secondMoment = new Float64Array(parameterCount)

  // Logits start near zero with noise (softmax near uniform) to break
  // symmetry; truth cells start near 0.5 with noise so every gate begins
  // inside the trainable interior of its interpolation. A restart draws fresh
  // noise from the same deterministic stream and clears the optimizer state.
  function initializeParameters() {
    for (let index = 0; index < logitCount; index++) logits[index] = (random() * 2 - 1) * 0.1
    for (const slot of gateSlots) {
      for (let index = 0; index < 4; index++) {
        source[slot.truthStart + index] = 0.5 + (random() * 2 - 1) * 0.15
      }
    }
    firstMoment.fill(0)
    secondMoment.fill(0)
  }
  initializeParameters()

  function writeSelections(sharpness: number) {
    for (const group of selectionGroups) {
      let maximum = -Infinity
      for (let index = 0; index < group.count; index++) {
        maximum = Math.max(maximum, sharpness * logits[group.logitStart + index]!)
      }
      let sum = 0
      for (let index = 0; index < group.count; index++) {
        const weight = Math.exp(sharpness * logits[group.logitStart + index]! - maximum)
        source[group.sourceStart + index] = weight
        sum += weight
      }
      for (let index = 0; index < group.count; index++) {
        source[group.sourceStart + index] = Math.fround(source[group.sourceStart + index]! / sum)
      }
    }
  }

  const firstDecay = 0.9
  const secondDecay = 0.999
  let finalLoss = 0
  let epochsRun = 0
  let sinceRestart = 0

  for (let epoch = 0; epoch < epochs; epoch++) {
    epochsRun = epoch + 1
    if (sinceRestart >= restartEpochs) {
      initializeParameters()
      sinceRestart = 0
    }
    const progress = restartEpochs <= 1 ? 1 : sinceRestart / (restartEpochs - 1)
    const sharpness = sharpnessStart + (sharpnessEnd - sharpnessStart) * progress
    writeSelections(sharpness)

    const sourceGradients = new Float64Array(sourceSize)
    let lossSum = 0
    for (const row of trainingRows) {
      const bits = inputBitsOfRow(row)
      for (let index = 0; index < inputCount; index++) source[index] = bits[index]!
      const expected = groundTruthOutputs(bits)
      const values = circuit.evaluateReference(source)
      const outputGradients = new Float32Array(values.length)
      for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
        const wire = outputs[outputIndex]!
        const error = values[wire]! - expected[outputIndex]!
        lossSum += 0.5 * error * error
        outputGradients[wire] = Math.fround(error)
      }
      const gradients = circuit.backpropagateReference(values, outputGradients)
      for (let cell = inputCount; cell < sourceSize; cell++) {
        sourceGradients[cell] = sourceGradients[cell]! + gradients[cell]!
      }
    }
    finalLoss = lossSum
    if (lossSum < 1e-7) break
    // Periodically probe whether hardening right now already reproduces every
    // TRAINING row; sharpening past that point only wastes epochs. Held-out
    // rows are deliberately not consulted.
    if (sinceRestart % 10 === 0 && hardenedIsExactOn(hardenWiring(source), trainingRows)) break

    // Chain rule through the baked softmax: for group weights m and
    // per-weight gradients g, dL/dlogit_k = sharpness * m_k * (g_k - sum_j m_j g_j).
    const parameterGradients = new Float64Array(parameterCount)
    for (const group of selectionGroups) {
      let weightedMean = 0
      for (let index = 0; index < group.count; index++) {
        weightedMean += source[group.sourceStart + index]! * sourceGradients[group.sourceStart + index]!
      }
      for (let index = 0; index < group.count; index++) {
        parameterGradients[group.logitStart + index] =
          sharpness
          * source[group.sourceStart + index]!
          * (sourceGradients[group.sourceStart + index]! - weightedMean)
      }
    }
    for (let gate = 0; gate < gateSlots.length; gate++) {
      const slot = gateSlots[gate]!
      for (let index = 0; index < 4; index++) {
        parameterGradients[logitCount + gate * 4 + index] = sourceGradients[slot.truthStart + index]!
      }
    }

    const firstCorrection = 1 - firstDecay ** (sinceRestart + 1)
    const secondCorrection = 1 - secondDecay ** (sinceRestart + 1)
    const scale = 1 / trainingRows.length
    for (let parameter = 0; parameter < parameterCount; parameter++) {
      const gradient = parameterGradients[parameter]! * scale
      firstMoment[parameter] = firstDecay * firstMoment[parameter]! + (1 - firstDecay) * gradient
      secondMoment[parameter] =
        secondDecay * secondMoment[parameter]! + (1 - secondDecay) * gradient * gradient
      const correctedFirst = firstMoment[parameter]! / firstCorrection
      const correctedSecond = secondMoment[parameter]! / secondCorrection
      const step = learningRate * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8)
      if (parameter < logitCount) {
        logits[parameter] = logits[parameter]! - step
      } else {
        const gate = Math.floor((parameter - logitCount) / 4)
        const cell = gateSlots[gate]!.truthStart + (parameter - logitCount) % 4
        source[cell] = Math.fround(Math.max(0, Math.min(1, source[cell]! - step)))
      }
    }
    sinceRestart++
  }

  writeSelections(sharpnessEnd)
  return {source, finalLoss, epochsRun}
}

export type HardenedGate = {
  selectA: number
  selectB: number
  truth: readonly [number, number, number, number]
}

export type HardenedWiring = readonly HardenedGate[]

function argmaxCell(source: Float32Array, start: number, count: number): number {
  let best = 0
  for (let index = 1; index < count; index++) {
    if (source[start + index]! > source[start + best]!) best = index
  }
  return best
}

// HARDEN: each selection group keeps its argmax candidate; each truth cell
// rounds to a bit. Any result is a valid two-input gate wired to real
// candidates, so hardening cannot produce an invalid circuit -- only a wrong
// one, which the behavior check catches.
export function hardenWiring(source: Float32Array): HardenedWiring {
  return gateSlots.map(slot => ({
    selectA: argmaxCell(source, slot.selectAStart, slot.candidateCount),
    selectB: argmaxCell(source, slot.selectBStart, slot.candidateCount),
    truth: [
      source[slot.truthStart + 0]! >= 0.5 ? 1 : 0,
      source[slot.truthStart + 1]! >= 0.5 ? 1 : 0,
      source[slot.truthStart + 2]! >= 0.5 ? 1 : 0,
      source[slot.truthStart + 3]! >= 0.5 ? 1 : 0,
    ] as const,
  }))
}

// Write a hardened wiring back into a fresh source table: one-hot selections,
// bit truth tables.
export function sourceFromWiring(wiring: HardenedWiring): Float32Array {
  invariant(wiring.length === gateSlots.length, 'wiring must describe every gate')
  const source = new Float32Array(sourceSize)
  for (let gate = 0; gate < wiring.length; gate++) {
    const slot = gateSlots[gate]!
    const hardened = wiring[gate]!
    invariant(
      hardened.selectA >= 0 && hardened.selectA < slot.candidateCount
        && hardened.selectB >= 0 && hardened.selectB < slot.candidateCount,
      'hardened selection is out of candidate range',
    )
    source[slot.selectAStart + hardened.selectA] = 1
    source[slot.selectBStart + hardened.selectB] = 1
    for (let index = 0; index < 4; index++) {
      const bit = hardened.truth[index]!
      invariant(bit === 0 || bit === 1, 'hardened truth cells must be bits')
      source[slot.truthStart + index] = bit
    }
  }
  return source
}

// Run the hardened wiring over all 16 input rows and check both evaluators
// produce the exact ground-truth output bits. Also asserts every output IS an
// exact 0 or 1: hardened gates on bit inputs are integer arithmetic.
export function checkHardenedWiring(
  wiring: HardenedWiring,
): {exact: boolean, correctBits: number, totalBits: number} {
  const {circuit, outputs} = createWiringCircuit()
  const source = sourceFromWiring(wiring)
  let correctBits = 0
  let totalBits = 0
  let exact = true
  for (let row = 0; row < rowCount; row++) {
    const bits = inputBitsOfRow(row)
    for (let index = 0; index < inputCount; index++) source[index] = bits[index]!
    const expected = groundTruthOutputs(bits)
    const referenceValues = circuit.evaluateReference(source)
    const tensorValues = circuit.evaluateTensor(source)
    for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
      totalBits++
      const bit = referenceValues[outputs[outputIndex]!]!
      invariant(bit === 0 || bit === 1, 'hardened wiring output must be an exact bit')
      invariant(
        tensorValues[outputs[outputIndex]!] === bit,
        'tensor and reference disagree on an output bit',
      )
      if (bit === expected[outputIndex]!) correctBits++
      else exact = false
    }
  }
  return {exact, correctBits, totalBits}
}

// Gate names indexed by f00 + 2*f10 + 4*f01 + 8*f11, the 16 two-input gates
// of Petersen et al. 2022.
const gateNames: readonly string[] = [
  'FALSE',
  'NOR',
  'A AND NOT B',
  'NOT B',
  'NOT A AND B',
  'NOT A',
  'XOR',
  'NAND',
  'AND',
  'XNOR',
  'A',
  'A OR NOT B',
  'B',
  'NOT A OR B',
  'OR',
  'TRUE',
]

// Human-readable wiring, for the test log: which candidates each gate selected
// and which of the 16 operations its truth table hardened to.
export function describeWiring(wiring: HardenedWiring): string {
  const candidateNames = [
    ...Array.from({length: inputCount}, (_, index) => `in${index}`),
    ...Array.from({length: layerOneGateCount}, (_, index) => `g${index}`),
  ]
  return wiring
    .map((gate, index) => {
      const label = index < layerOneGateCount ? `g${index}` : `out${index - layerOneGateCount}`
      const operation =
        gateNames[gate.truth[0] + gate.truth[1] * 2 + gate.truth[2] * 4 + gate.truth[3] * 8]!
      return `${label} = ${operation}(${candidateNames[gate.selectA]!}, ${candidateNames[gate.selectB]!})`
    })
    .join('\n')
}

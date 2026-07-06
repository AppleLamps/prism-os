// Learning BEHAVIOR on the boolean substrate: a 6-slot reveal relation.
//
// The repo's thesis says state and behavior both live as numbers in one source
// table. trainable-geometry.ts already learns *geometry* (continuous rectangle
// coordinates) with the reference backprop. But the reference backprop THROWS
// at boolean atoms, and behavior -- which slot is visible, which decision a
// click owns -- is exactly the part that rounds to an exact bit. So behavior
// has been the one thing this substrate could compile but not train.
//
// This experiment closes that gap on a concrete behavioral law:
//
//   visibility[j] = boolean(clamp01(baseVisible[j] + sum_i R[i][j] * selected[i]))
//
// `selected` is a one-hot input over 6 slots (or all-zero for "nothing
// selected"). R is a 6x6 relation matrix whose cells live in the source table
// as TRAINABLE PARAMETERS. A hidden ground-truth R defines the desired reveal
// behavior; we recover it from (selected -> expected visibility) examples using
// the surrogate gradient from exp-ste-backprop.ts, then HARDEN: round each
// learned R cell to an exact 0/1 bit, write the bits back into the source
// table, and check the hardened circuit reproduces the ground truth EXACTLY
// (strict === on every visibility bit) for all seven input cases. This is the
// DLGN train-soft / run-exact recipe demonstrated on this substrate.
//
// Parameterization choice (the prompt asks us to decide and justify):
//   We train RAW relation cells and CLAMP them into [0,1] after every optimizer
//   step, rather than training an unconstrained logit and squashing with a
//   sigmoid. Two reasons. (1) boolean()'s build-time contract requires its
//   input wire to be provably within [0,1]; the score baseVisible + sum R*sel
//   is a sum of products of [0,1] values, which we wrap in clamp01 +
//   assumeRange(0,1) once at build time -- this needs R itself to sit in [0,1]
//   so the source-range validator (validateSourceRanges) accepts the table on
//   every forward pass during training. (2) Hardening is then a single round():
//   each cell is already in [0,1], so round(R[i][j]) is the exact bit, and the
//   forward score becomes an exact integer combination that the boolean atom
//   rounds identically every time. A sigmoid logit would need an extra squash
//   wire and would not keep the source cells inside their assumed range.

import {
  Circuit,
  type Wire,
  emitMultiply,
  invariant,
  validateCircuit,
} from '../numeric-ui-core.ts'
import {backpropagateSurrogate, type SurrogateMode} from './exp-ste-backprop.ts'

export const slotCount = 6
export const caseCount = slotCount + 1 // 6 single selections + the none case

// Deterministic LCG, matching trainable-geometry.ts and the surrogate tests.
export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

// Source-table layout: 36 trainable relation cells, then 6 baseVisible
// constants, then 6 one-hot selection inputs.
const relationStart = 0
const relationSize = slotCount * slotCount
const baseVisibleStart = relationStart + relationSize
const selectedStart = baseVisibleStart + slotCount
export const sourceSize = selectedStart + slotCount

export function relationCell(source: Wire, target: Wire): Wire {
  return relationStart + source * slotCount + target
}
export function baseVisibleCell(target: Wire): Wire {
  return baseVisibleStart + target
}
export function selectedCell(source: Wire): Wire {
  return selectedStart + source
}

// Build the behavior circuit once. Relation cells and baseVisible are assumed
// to lie in [0,1]; selection inputs are one-hot in [0,1]. The visibility score
// for slot j is baseVisible[j] + sum_i R[i][j] * selected[i], clamped to [0,1]
// and rounded to an exact bit by a boolean atom.
export function createRevealCircuit() {
  const circuit = new Circuit(sourceSize)
  const unit = circuit.affine([], 1)
  circuit.assumeRange(unit, 1, 1)
  for (let cell = relationStart; cell < relationStart + relationSize; cell++) {
    circuit.assumeRange(cell, 0, 1)
  }
  for (let j = 0; j < slotCount; j++) circuit.assumeRange(baseVisibleCell(j), 0, 1)
  for (let i = 0; i < slotCount; i++) circuit.assumeRange(selectedCell(i), 0, 1)

  // Pre-round score wires (before the boolean) for each slot: useful both for
  // training (the surrogate routes through the boolean into these) and for the
  // hardened exactness check.
  const scores: Wire[] = []
  const visibility: Wire[] = []
  for (let j = 0; j < slotCount; j++) {
    // sum_i R[i][j] * selected[i]. selected is non-negative so each multiply is
    // a single reglu (emitMultiply's isNonNegative(b) branch).
    const contributions: (readonly [Wire, number])[] = [[baseVisibleCell(j), 1]]
    for (let i = 0; i < slotCount; i++) {
      contributions.push([emitMultiply(circuit, relationCell(i, j), selectedCell(i)), 1])
    }
    const raw = circuit.affine(contributions)
    const score = emitClampZeroOne(circuit, raw, unit)
    scores.push(score)
    visibility.push(circuit.boolean(score))
  }

  validateCircuit(circuit)
  return {circuit, unit, scores, visibility}
}

// clamp01 expressed in the three atoms (mirrors numeric-ui-core's private
// emitClampZeroOne, which is not exported): relu(x) - relu(x - 1), proved to
// sit in [0,1].
function emitClampZeroOne(circuit: Circuit, value: Wire, unit: Wire): Wire {
  const positive = circuit.reglu([], 1, [[value, 1]], 0)
  const aboveOne = circuit.reglu([], 1, [[value, 1], [unit, -1]], 0)
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

// The hidden ground-truth reveal law, as a 6x6 bit matrix groundTruth[i][j] = 1
// iff selecting slot i reveals slot j. The prompt's example: selecting 2
// reveals 3; selecting 0 reveals 4 and 5; everything else unaffected.
export function groundTruthRelation(): Uint8Array {
  const relation = new Uint8Array(relationSize)
  const set = (i: number, j: number) => { relation[i * slotCount + j] = 1 }
  set(2, 3)
  set(0, 4)
  set(0, 5)
  return relation
}

// baseVisible: every slot starts hidden (0). Selecting a related slot reveals
// it. This keeps the ground truth a pure function of the relation matrix.
export function baseVisibleVector(): Float32Array {
  return new Float32Array(slotCount)
}

// Expected visibility for a given selection under a bit relation. A slot j is
// visible iff baseVisible[j] + (selected slot's relation to j) >= 0.5. With
// baseVisible 0 and one-hot selection, that is exactly groundTruth[selected][j]
// (or all-zero when nothing is selected). We compute it through the same
// clamp01 + threshold semantics for honesty.
export function expectedVisibility(
  relation: Uint8Array,
  baseVisible: Float32Array,
  selected: number, // 0..slotCount-1, or -1 for none
): Uint8Array {
  const out = new Uint8Array(slotCount)
  for (let j = 0; j < slotCount; j++) {
    let score = baseVisible[j]!
    if (selected >= 0) score += relation[selected * slotCount + j]!
    const clamped = Math.min(1, Math.max(0, score))
    out[j] = clamped >= 0.5 ? 1 : 0
  }
  return out
}

// The seven training cases: one per single selection plus the none case. Each
// case is a one-hot (or all-zero) selection and the expected visibility vector.
export type RevealCase = {
  selected: number // 0..slotCount-1 or -1
  expected: Uint8Array
}

export function buildCases(relation: Uint8Array, baseVisible: Float32Array): RevealCase[] {
  const cases: RevealCase[] = []
  for (let selected = 0; selected < slotCount; selected++) {
    cases.push({selected, expected: expectedVisibility(relation, baseVisible, selected)})
  }
  cases.push({selected: -1, expected: expectedVisibility(relation, baseVisible, -1)})
  return cases
}

// Write a selection (one-hot or all-zero) and baseVisible into a source table
// that already holds the relation cells.
export function writeInputs(source: Float32Array, baseVisible: Float32Array, selected: number) {
  for (let i = 0; i < slotCount; i++) source[selectedCell(i)] = selected === i ? 1 : 0
  for (let j = 0; j < slotCount; j++) source[baseVisibleCell(j)] = baseVisible[j]!
}

export type TrainOptions = {
  seed?: number
  learningRate?: number
  epochs?: number
  mode?: SurrogateMode
  temperature?: number
}

export type TrainResult = {
  source: Float32Array
  learnedRelation: Float32Array // the 36 raw cells after training
  finalLoss: number
  epochs: number
  convergedEpoch: number // first epoch the soft visibility matched all bits, or -1
  mode: SurrogateMode
}

// Train the relation cells to reproduce the cases. Uses Adam over the 36
// relation cells, the surrogate gradient through the boolean atoms, and a
// per-bit squared error on the boolean (rounded) output. Relation cells are
// clamped back into [0,1] after every step so the source table stays valid and
// hardening is a clean round.
//
// Training reads only the behavioral `cases` and `baseVisible`; it never sees
// the hidden ground-truth relation matrix. Recovering that matrix is therefore
// genuine learning from observed behavior, not copying.
export function trainReveal(
  baseVisible: Float32Array,
  cases: readonly RevealCase[],
  options: TrainOptions = {},
): TrainResult {
  const seed = options.seed ?? 1
  const learningRate = options.learningRate ?? 0.2
  const epochs = options.epochs ?? 400
  const mode = options.mode ?? 'sigmoidSte'
  const temperature = options.temperature ?? 6
  const {circuit, visibility} = createRevealCircuit()

  const random = createRandom(seed ^ 0x5f_2e_91)
  const source = new Float32Array(sourceSize)
  // Initialize relation cells near 0.5 (the decision boundary) so the surrogate
  // gradient has slope to work with regardless of which bit each cell wants.
  for (let cell = relationStart; cell < relationStart + relationSize; cell++) {
    source[cell] = 0.5 + (random() * 2 - 1) * 0.1
  }

  const firstMoment = new Float32Array(relationSize)
  const secondMoment = new Float32Array(relationSize)
  const firstDecay = 0.9
  const secondDecay = 0.999
  let trainingStep = 0
  let convergedEpoch = -1

  function softBitsMatch(): boolean {
    for (const probe of cases) {
      writeInputs(source, baseVisible, probe.selected)
      const values = circuit.evaluateReference(source)
      for (let j = 0; j < slotCount; j++) {
        if (values[visibility[j]!]! !== probe.expected[j]!) return false
      }
    }
    return true
  }

  for (let epoch = 0; epoch < epochs; epoch++) {
    const accumulated = new Float32Array(relationSize)
    let lossSum = 0
    for (const probe of cases) {
      writeInputs(source, baseVisible, probe.selected)
      const values = circuit.evaluateReference(source)
      const outputGradients = new Float32Array(values.length)
      for (let j = 0; j < slotCount; j++) {
        const predicted = values[visibility[j]!]!
        const error = predicted - probe.expected[j]!
        lossSum += 0.5 * error * error
        outputGradients[visibility[j]!] = Math.fround(error)
      }
      const gradients = backpropagateSurrogate(circuit, values, outputGradients, {mode, temperature})
      for (let cell = 0; cell < relationSize; cell++) {
        accumulated[cell] = Math.fround(accumulated[cell]! + gradients[relationStart + cell]!)
      }
    }

    if (convergedEpoch < 0 && softBitsMatch()) convergedEpoch = epoch

    trainingStep++
    const firstCorrection = 1 - firstDecay ** trainingStep
    const secondCorrection = 1 - secondDecay ** trainingStep
    const scale = 1 / cases.length
    for (let cell = 0; cell < relationSize; cell++) {
      const gradient = accumulated[cell]! * scale
      firstMoment[cell] = firstDecay * firstMoment[cell]! + (1 - firstDecay) * gradient
      secondMoment[cell] =
        secondDecay * secondMoment[cell]! + (1 - secondDecay) * gradient * gradient
      const correctedFirst = firstMoment[cell]! / firstCorrection
      const correctedSecond = secondMoment[cell]! / secondCorrection
      let updated = source[relationStart + cell]!
        - learningRate * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8)
      updated = Math.max(0, Math.min(1, updated))
      source[relationStart + cell] = Math.fround(updated)
    }
  }

  const learnedRelation = new Float32Array(relationSize)
  for (let cell = 0; cell < relationSize; cell++) {
    learnedRelation[cell] = source[relationStart + cell]!
  }

  let finalLoss = 0
  for (const probe of cases) {
    writeInputs(source, baseVisible, probe.selected)
    const values = circuit.evaluateReference(source)
    for (let j = 0; j < slotCount; j++) {
      const error = values[visibility[j]!]! - probe.expected[j]!
      finalLoss += 0.5 * error * error
    }
  }

  if (convergedEpoch < 0 && softBitsMatch()) convergedEpoch = epochs

  return {source, learnedRelation, finalLoss, epochs, convergedEpoch, mode}
}

// HARDEN: round each learned raw cell to an exact 0/1 bit. Returns a fresh
// source table whose relation cells are exact bits.
export function hardenRelation(learnedRelation: Float32Array): Uint8Array {
  const bits = new Uint8Array(relationSize)
  for (let cell = 0; cell < relationSize; cell++) {
    bits[cell] = learnedRelation[cell]! >= 0.5 ? 1 : 0
  }
  return bits
}

// Write hardened relation bits into a source table and return it.
export function sourceFromBits(relationBits: Uint8Array): Float32Array {
  const source = new Float32Array(sourceSize)
  for (let cell = 0; cell < relationSize; cell++) source[relationStart + cell] = relationBits[cell]!
  return source
}

// Run the hardened circuit over all cases and report whether every visibility
// bit strictly equals the expected ground-truth bit. Uses the compiled tensor
// evaluator so the claim is about real fused execution, not just the reference
// interpreter. Returns the count of exactly-correct bits and the total.
export function checkHardenedExact(
  relationBits: Uint8Array,
  baseVisible: Float32Array,
  cases: readonly RevealCase[],
): {exact: boolean, correctBits: number, totalBits: number} {
  const {circuit, visibility} = createRevealCircuit()
  const source = sourceFromBits(relationBits)
  let correctBits = 0
  let totalBits = 0
  let exact = true
  for (const probe of cases) {
    writeInputs(source, baseVisible, probe.selected)
    const referenceValues = circuit.evaluateReference(source)
    const tensorValues = circuit.evaluateTensor(source)
    for (let j = 0; j < slotCount; j++) {
      totalBits++
      const bit = referenceValues[visibility[j]!]!
      // The compiled tensor program must agree bit-for-bit with the reference.
      invariant(tensorValues[visibility[j]!]! === bit, 'tensor and reference disagree on a visibility bit')
      if (bit === probe.expected[j]!) correctBits++
      else exact = false
    }
  }
  return {exact, correctBits, totalBits}
}

// Whether the learned relation bits exactly equal the ground-truth relation
// bits cell-for-cell (a stronger statement than reproducing the training cases:
// it means the recovered LAW matches, not just the observed behavior).
export function relationBitsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let cell = 0; cell < a.length; cell++) if (a[cell] !== b[cell]) return false
  return true
}

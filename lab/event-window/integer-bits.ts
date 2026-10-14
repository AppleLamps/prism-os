// Integer-exact bits: the reveal-behavior decision without the boolean atom.
//
// The boolean atom rounds a score in [0,1] to an exact bit by exploiting FP32
// mantissa width: add 8_388_609, subtract it back, and the fraction is gone
// (evaluateBoolean in numeric-ui-core.ts). That construction is FP32-specific:
// the base must sit in [2^23, 2^24), the window where FP32's value spacing is
// exactly 1, so adding a score in [0,1] rounds the fraction away, and the base
// must be odd so 0.5 rounds up under ties-to-even; 8_388_609 = 2^23 + 1 is the
// smallest such odd integer, and bfloat16 cannot represent it at all. Rounding
// also has no honest derivative, which is why backpropagateReference throws at
// boolean atoms unless the caller passes {booleanGradient: 'straight-through'},
// and the removed surrogate experiments had to invent slopes.
//
// This experiment removes the boolean atom for decisions whose hardened score
// is an INTEGER. The identity is one the repo already owns as clamp01:
//
//   relu(score) - relu(score - 1)
//
// For any integer score this equals the exact bit of "score >= 1": integers
// cannot land inside the open band (0, 1), so the ramp never emits a fraction.
// The reveal law's score is a sum of 0/1 relation cells gated by 0/1 selection
// bits, so the hardened score is an integer count in 0..7 and the decision
// "count >= 1" needs no rounding at all. Percepta's LLM-computer construction
// (percepta.ai/blog/constructing-llm-computer) builds its indicators the same
// way: exact step functions from ReLU differences over integer-valued wires.
//
// What this buys, measured here on the same 6-slot reveal law, hidden ground
// truth, and training cases as the superseded surrogate experiment:
//
// 1. Native gradients. During training the relation cells are fractional, the
//    score sits inside [0, 1], and clamp01 passes it through as an honest
//    differentiable ramp. The circuit is affine+reglu only, so
//    Circuit.backpropagateReference works unmodified -- no straight-through
//    estimator, no surrogate slope to choose. Train-soft / run-exact stops
//    being two mechanisms (invented backward pass + hard forward pass) and
//    becomes one expression, soft exactly while the cells are soft and exact
//    exactly when the cells are bits.
//
// 2. Precision portability. The relu-difference bit is exact in any float
//    format whose mantissa represents the integers involved (FP32: |score| up
//    to 2^24; bfloat16: |score| up to 256). The tests simulate bfloat16 by
//    rounding after every arithmetic step and show the relu-difference bit
//    stays exact while the 2^23 trick returns 0 for boolean(1).
//
// What this does NOT replace: decisions that threshold genuinely continuous
// quantities at 0.5 -- pointer hit-testing against fractional spring-animated
// geometry, for example. There the rounding boolean is total on all of [0,1],
// while the ramp would emit fractions like 0.73 near the boundary and break
// downstream exact-bit invariants. The magic constant retreats to the
// continuous frontier; counting-style behavior decisions do not need it.

import {
  Circuit,
  type Wire,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
} from '../../src/runtime/numeric-ui-core.ts'
// --- The reveal-law scaffolding ----------------------------------------------
// This layout, ground truth, and case machinery originally lived in the
// surrogate-gradient experiment (exp-ste-reveal.ts), which this experiment
// superseded; the scaffolding moved here when that file was removed. See
// lab/research-sweep.md for the supersession record.

export const slotCount = 6

// Deterministic LCG, matching src/learned-gallery/trainable-geometry.ts.
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

// The hidden ground-truth reveal law, as a 6x6 bit matrix groundTruth[i][j] = 1
// iff selecting slot i reveals slot j: selecting 2 reveals 3; selecting 0
// reveals 4 and 5; everything else unaffected.
export function groundTruthRelation(): Uint8Array {
  const relation = new Uint8Array(relationSize)
  const set = (i: number, j: number) => { relation[i * slotCount + j] = 1 }
  set(2, 3)
  set(0, 4)
  set(0, 5)
  return relation
}

// baseVisible: every slot starts hidden, so the ground truth is a pure
// function of the relation matrix.
export function baseVisibleVector(): Float32Array {
  return new Float32Array(slotCount)
}

// Expected visibility for a given selection under a bit relation, computed
// through the same clamp-then-decide semantics the circuit uses.
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

// The seven training cases: one per single selection plus the none case.
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

// HARDEN: round each learned raw cell to an exact 0/1 bit.
export function hardenRelation(learnedRelation: Float32Array): Uint8Array {
  const bits = new Uint8Array(relationSize)
  for (let cell = 0; cell < relationSize; cell++) {
    bits[cell] = learnedRelation[cell]! >= 0.5 ? 1 : 0
  }
  return bits
}

// Write hardened relation bits into a fresh source table.
export function sourceFromBits(relationBits: Uint8Array): Float32Array {
  const source = new Float32Array(sourceSize)
  for (let cell = 0; cell < relationSize; cell++) source[relationStart + cell] = relationBits[cell]!
  return source
}

// Whether two relation bit matrices agree cell-for-cell (a stronger statement
// than reproducing the training cases: the recovered LAW matches).
export function relationBitsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let cell = 0; cell < a.length; cell++) if (a[cell] !== b[cell]) return false
  return true
}

// clamp01(score) = relu(score) - relu(score - 1). For an integer score this is
// exactly the bit of "score >= 1"; for a fractional score inside [0, 1] it is
// the identity ramp that training differentiates through.
function emitIntegerBit(circuit: Circuit, score: Wire): Wire {
  const positive = emitRelu(circuit, score)
  const aboveOne = circuit.reglu([], 1, [[score, 1]], -1)
  const bit = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// Same source layout and visibility law as the superseded surrogate circuit,
// with the clamp01 + boolean pair replaced by the single relu-difference bit.
// The circuit contains no boolean atom, so both the 2^23 constant and the
// surrogate backward pass are structurally absent.
export function createIntegerRevealCircuit() {
  const circuit = new Circuit(sourceSize)
  for (let i = 0; i < slotCount; i++) {
    for (let j = 0; j < slotCount; j++) circuit.assumeRange(relationCell(i, j), 0, 1)
  }
  for (let j = 0; j < slotCount; j++) circuit.assumeRange(baseVisibleCell(j), 0, 1)
  for (let i = 0; i < slotCount; i++) circuit.assumeRange(selectedCell(i), 0, 1)

  const visibility: Wire[] = []
  for (let j = 0; j < slotCount; j++) {
    const contributions: (readonly [Wire, number])[] = [[baseVisibleCell(j), 1]]
    for (let i = 0; i < slotCount; i++) {
      contributions.push([emitMultiply(circuit, relationCell(i, j), selectedCell(i)), 1])
    }
    visibility.push(emitIntegerBit(circuit, circuit.affine(contributions)))
  }

  invariant(
    circuit.operations.every(operation => operation.kind !== 'boolean'),
    'the integer reveal circuit must not contain boolean atoms',
  )
  validateCircuit(circuit)
  return {circuit, visibility}
}

export type IntegerTrainOptions = {
  seed?: number
  learningRate?: number
  epochs?: number
}

export type IntegerTrainResult = {
  source: Float32Array
  learnedRelation: Float32Array // the 36 raw cells after training
  finalLoss: number
  convergedEpoch: number // first epoch every rounded output matched, or -1
}

// Train the 36 relation cells with the plain reference backward pass. The
// mechanical difference from the superseded surrogate trainer is what is absent:
// no surrogate mode, no temperature. backpropagateReference differentiates the
// whole circuit because no boolean atom exists to throw at.
export function trainIntegerReveal(
  baseVisible: Float32Array,
  cases: readonly RevealCase[],
  options: IntegerTrainOptions = {},
): IntegerTrainResult {
  const seed = options.seed ?? 1
  const learningRate = options.learningRate ?? 0.2
  const epochs = options.epochs ?? 200
  const {circuit, visibility} = createIntegerRevealCircuit()

  const random = createRandom(seed ^ 0x5f_2e_91)
  const source = new Float32Array(sourceSize)
  // Relation cells occupy the first 36 source cells (relationCell(0, 0) is 0).
  // Initialize near the middle of [0, 1] so every cell starts inside the
  // differentiable band of its downstream ramp.
  for (let cell = 0; cell < relationSize; cell++) {
    source[cell] = 0.5 + (random() * 2 - 1) * 0.1
  }

  const firstMoment = new Float32Array(relationSize)
  const secondMoment = new Float32Array(relationSize)
  const firstDecay = 0.9
  const secondDecay = 0.999
  let convergedEpoch = -1

  function roundedBitsMatch(): boolean {
    for (const probe of cases) {
      writeInputs(source, baseVisible, probe.selected)
      const values = circuit.evaluateReference(source)
      for (let j = 0; j < slotCount; j++) {
        const rounded = values[visibility[j]!]! >= 0.5 ? 1 : 0
        if (rounded !== probe.expected[j]!) return false
      }
    }
    return true
  }

  for (let epoch = 0; epoch < epochs; epoch++) {
    const accumulated = new Float32Array(relationSize)
    for (const probe of cases) {
      writeInputs(source, baseVisible, probe.selected)
      const values = circuit.evaluateReference(source)
      const outputGradients = new Float32Array(values.length)
      for (let j = 0; j < slotCount; j++) {
        const error = values[visibility[j]!]! - probe.expected[j]!
        outputGradients[visibility[j]!] = Math.fround(error)
      }
      const gradients = circuit.backpropagateReference(values, outputGradients)
      for (let cell = 0; cell < relationSize; cell++) {
        accumulated[cell] = Math.fround(accumulated[cell]! + gradients[cell]!)
      }
    }

    if (convergedEpoch < 0 && roundedBitsMatch()) convergedEpoch = epoch

    const firstCorrection = 1 - firstDecay ** (epoch + 1)
    const secondCorrection = 1 - secondDecay ** (epoch + 1)
    const scale = 1 / cases.length
    for (let cell = 0; cell < relationSize; cell++) {
      const gradient = accumulated[cell]! * scale
      firstMoment[cell] = firstDecay * firstMoment[cell]! + (1 - firstDecay) * gradient
      secondMoment[cell] =
        secondDecay * secondMoment[cell]! + (1 - secondDecay) * gradient * gradient
      const correctedFirst = firstMoment[cell]! / firstCorrection
      const correctedSecond = secondMoment[cell]! / secondCorrection
      let updated = source[cell]!
        - learningRate * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8)
      updated = Math.max(0, Math.min(1, updated))
      source[cell] = Math.fround(updated)
    }
  }

  const learnedRelation = new Float32Array(relationSize)
  for (let cell = 0; cell < relationSize; cell++) learnedRelation[cell] = source[cell]!

  let finalLoss = 0
  for (const probe of cases) {
    writeInputs(source, baseVisible, probe.selected)
    const values = circuit.evaluateReference(source)
    for (let j = 0; j < slotCount; j++) {
      const error = values[visibility[j]!]! - probe.expected[j]!
      finalLoss += 0.5 * error * error
    }
  }
  if (convergedEpoch < 0 && roundedBitsMatch()) convergedEpoch = epochs

  return {source, learnedRelation, finalLoss, convergedEpoch}
}

// Run the hardened integer circuit over the cases and check every visibility
// value strictly equals the expected bit. Beyond the superseded check, this
// also asserts each output IS an exact 0 or 1 -- the relu difference of an
// integer score must never emit a fraction.
export function checkHardenedIntegerExact(
  relationBits: Uint8Array,
  baseVisible: Float32Array,
  cases: readonly RevealCase[],
): {exact: boolean, correctBits: number, totalBits: number} {
  const {circuit, visibility} = createIntegerRevealCircuit()
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
      invariant(bit === 0 || bit === 1, 'hardened integer visibility must be an exact bit')
      invariant(
        tensorValues[visibility[j]!] === bit,
        'tensor and reference disagree on a visibility bit',
      )
      if (bit === probe.expected[j]!) correctBits++
      else exact = false
    }
  }
  return {exact, correctBits, totalBits}
}

// --- bfloat16 simulation -----------------------------------------------------
// bfloat16 keeps FP32's exponent but only 7 stored mantissa bits, so integers
// are exact only up to 256. These helpers round a value to the nearest
// bfloat16 (ties to even) so a test can re-run each construction with the
// rounding applied after every arithmetic step, the way bfloat16 hardware
// would.

const float32Scratch = new Float32Array(1)
const uint32Scratch = new Uint32Array(float32Scratch.buffer)

export function roundToBf16(value: number): number {
  float32Scratch[0] = value
  const bits = uint32Scratch[0]!
  const rounding = 0x7f_ff + ((bits >>> 16) & 1)
  uint32Scratch[0] = (bits + rounding) & 0xff_ff_00_00
  return float32Scratch[0]
}

// The repo's rounding boolean, restated locally so the test can contrast it
// with the bfloat16 run without importing a private core function.
export function fp32RoundingBoolean(score: number): number {
  const base = 8_388_609
  const shifted = Math.fround(Math.fround(score) + base)
  return Math.fround(shifted - base)
}

// The same construction under bfloat16: every intermediate value is rounded to
// bfloat16, as bfloat16 arithmetic would. The odd base itself does not survive
// (roundToBf16(8_388_609) is 8_388_608), and additions near 2^23 round to a
// spacing of 65_536, so the trick stops producing bits.
export function bf16RoundingBoolean(score: number): number {
  const base = roundToBf16(8_388_609)
  const shifted = roundToBf16(roundToBf16(score) + base)
  return roundToBf16(shifted - base)
}

// relu(score) - relu(score - 1) under bfloat16. relu introduces no rounding of
// its own; the subtractions stay exact while the integers involved are within
// bfloat16's exact-integer range.
export function bf16IntegerBit(score: number): number {
  const value = roundToBf16(score)
  const positive = Math.max(0, value)
  const aboveOne = Math.max(0, roundToBf16(value - 1))
  return roundToBf16(positive - aboveOne)
}

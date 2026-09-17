import {describe, expect, test} from 'bun:test'
import {
  Circuit,
  type Wire,
  emitArgmax,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitSelect,
  emitSpring,
  validateCircuit,
  validateTensorEvaluation,
  validateTensorProgram,
  asWire,
} from '../../src/runtime/numeric-ui-core.ts'

// Seeded hash, copied from numeric-ui-core.test.ts so the suite stays deterministic.
function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function randomInteger(random: () => number, limit: number) {
  return Math.floor(random() * limit)
}

// Coefficients that are NOT exact powers of two, so the per-product fround in the
// compiled evaluator must round mid-mantissa instead of trivially landing exact.
const NON_DYADIC = [
  1 / 3,
  0.1,
  0.7,
  1e-3,
  12_345.6789,
  -1 / 3,
  -0.1,
  -0.7,
  -1e-3,
  -12_345.6789,
  0.123_456_789,
  2 / 7,
  -2 / 7,
  3.141_592_653_589_793,
  -0.987_654_321,
] as const

function randomCoefficient(random: () => number) {
  return NON_DYADIC[randomInteger(random, NON_DYADIC.length)]!
}

// A non-dyadic source value in [low, high], so range preconditions still hold.
function randomUnitValue(random: () => number) {
  // Keep strictly inside (0, 1) to avoid exact endpoints that the existing suite
  // already covers; the boundary battery handles the endpoints separately.
  return random() * 0.999_998 + 0.000_001
}

describe('hardened random verification', () => {
  test('non-dyadic macro circuits preserve every live FP32 wire', () => {
    const random = createRandom(0x9e37_79b9)
    const circuitCount = 320
    let macroApplications = 0

    for (let circuitIndex = 0; circuitIndex < circuitCount; circuitIndex++) {
      // A pool of range-tracked unit sources feeds boolean/argmax/firstActive
      // preconditions; one extra source is pinned to exactly 1 to serve as the
      // unit wire that argmax requires.
      const unitSourceCount = 3 + randomInteger(random, 4)
      const freeSourceCount = 2 + randomInteger(random, 3)
      const unitWire = unitSourceCount + freeSourceCount
      const sourceSize = unitWire + 1
      const circuit = new Circuit(sourceSize)
      for (let wire = 0; wire < unitSourceCount; wire++) circuit.assumeRange(asWire(wire), 0, 1)
      // Free sources span a non-trivial signed range so products and selects vary.
      for (let wire = unitSourceCount; wire < unitWire; wire++) circuit.assumeRange(asWire(wire), -2, 2)
      circuit.assumeRange(asWire(unitWire), 1, 1)

      // unitWires: provably within [0,1], legal for boolean/argmax/firstActive.
      const unitWires: Wire[] = Array.from({length: unitSourceCount}, (_, wire) => asWire(wire))
      // allWires: anything, legal as affine/reglu/multiply operands.
      const allWires: Wire[] = Array.from({length: sourceSize}, (_, wire) => asWire(wire))

      const pickUnit = () => unitWires[randomInteger(random, unitWires.length)]!
      const pickAny = () => allWires[randomInteger(random, allWires.length)]!
      const randomTerms = () =>
        Array.from(
          {length: 1 + randomInteger(random, 4)},
          () => [pickAny(), randomCoefficient(random)] as const,
        )

      const operationCount = 6 + randomInteger(random, 14)
      for (let operation = 0; operation < operationCount; operation++) {
        const choice = randomInteger(random, 11)
        let produced: Wire
        if (choice === 0) {
          produced = circuit.affine(randomTerms(), randomCoefficient(random))
        } else if (choice === 1) {
          produced = circuit.reglu(
            randomTerms(),
            randomCoefficient(random),
            randomTerms(),
            randomCoefficient(random),
          )
        } else if (choice === 2) {
          produced = emitMultiply(circuit, pickAny(), pickAny())
          macroApplications++
        } else if (choice === 3) {
          produced = emitMaximum(circuit, pickAny(), pickAny())
          macroApplications++
        } else if (choice === 4) {
          produced = emitMinimum(circuit, pickAny(), pickAny())
          macroApplications++
        } else if (choice === 5) {
          produced = emitSelect(circuit, pickUnit(), pickAny(), pickAny())
          macroApplications++
        } else if (choice === 6) {
          // boolean precondition: the score must live in [0,1]; a unit source does.
          produced = circuit.boolean(pickUnit())
          // The exact 0/1 result is a fresh legal unit/score source.
          circuit.assumeRange(produced, 0, 1)
          unitWires.push(produced)
        } else if (choice === 7) {
          const scoreCount = 2 + randomInteger(random, 6)
          const scores = Array.from({length: scoreCount}, () => pickUnit())
          const winner = emitArgmax(circuit, scores, asWire(unitWire))
          macroApplications++
          // One-hot selectors are exact bits in [0,1]; the kept score is in [0,1].
          for (const selector of winner.selected) {
            circuit.assumeRange(selector, 0, 1)
            unitWires.push(selector)
          }
          circuit.assumeRange(winner.score, 0, 1)
          unitWires.push(winner.score)
          produced = winner.score
        } else if (choice === 8) {
          const candidateCount = 2 + randomInteger(random, 6)
          const candidates = Array.from({length: candidateCount}, () => pickUnit())
          const selected = emitFirstActive(circuit, pickUnit(), candidates)
          macroApplications++
          for (const selector of selected) {
            circuit.assumeRange(selector, 0, 1)
            unitWires.push(selector)
          }
          produced = selected[selected.length - 1]!
        } else if (choice === 9) {
          // A four-step spring over signed free sources with non-dyadic constants.
          const stiffness = circuit.affine([], 0.07)
          circuit.assumeRange(stiffness, 0, 1)
          const damping = circuit.affine([], 0.3)
          circuit.assumeRange(damping, 0, 1)
          const timestep = circuit.affine([], 0.1)
          circuit.assumeRange(timestep, 0, 1)
          const settleDistance = circuit.affine([], 1e-3)
          circuit.assumeRange(settleDistance, 0, 1)
          const settleSpeed = circuit.affine([], 1e-3)
          circuit.assumeRange(settleSpeed, 0, 1)
          const scale = circuit.affine([], 12_345.6789)
          circuit.assumeRange(scale, 0, 13_000)
          const spring = emitSpring(
            circuit,
            pickAny(),
            pickAny(),
            pickAny(),
            stiffness,
            damping,
            timestep,
            settleDistance,
            settleSpeed,
            scale,
            scale,
            asWire(unitWire),
          )
          macroApplications++
          // active is the clamp result, provably in [0,1].
          circuit.assumeRange(spring.active, 0, 1)
          unitWires.push(spring.active)
          produced = spring.position
        } else {
          // Plain reglu acting as a gated product, stressing more fround paths.
          produced = circuit.reglu(
            randomTerms(),
            randomCoefficient(random),
            [[pickAny(), randomCoefficient(random)]],
            randomCoefficient(random),
          )
        }
        allWires.push(produced)
      }

      validateCircuit(circuit)
      const operandWires = allWires.filter(wire => wire >= sourceSize)
      const rootCount = 1 + randomInteger(random, 5)
      const roots = Array.from(
        {length: rootCount},
        () => operandWires[randomInteger(random, operandWires.length)]!,
      )
      const program = circuit.compileTensorProgram(roots)
      circuit.tensorProgram = program
      validateTensorProgram(circuit, program)

      for (let inputIndex = 0; inputIndex < 5; inputIndex++) {
        const source = Float32Array.from({length: sourceSize}, (_, wire) => {
          if (wire === unitWire) return 1
          if (wire < unitSourceCount) return randomUnitValue(random)
          return random() * 4 - 2
        })
        const tensor = circuit.evaluateTensor(source)
        validateTensorEvaluation(source, circuit, tensor)
      }
    }

    // The suite must have actually exercised macro lowering, not just plain atoms.
    expect(macroApplications).toBeGreaterThan(0)
  })
})

describe('boolean boundary battery', () => {
  // Adjacent-ulp points around 0.5: one ulp below, exactly 0.5, and just above.
  const cases = [
    [0.499_999_97, 0],
    [0.5, 1],
    [0.500_000_06, 1],
  ] as const

  test('boolean rounds adjacent-ulp scores identically in both evaluators', () => {
    const circuit = new Circuit(1)
    circuit.assumeRange(circuit.source(0), 0, 1)
    const decision = circuit.boolean(circuit.source(0))
    circuit.tensorProgram = circuit.compileTensorProgram([decision])

    for (const [score, expected] of cases) {
      const source = Float32Array.from([score])
      const reference = circuit.evaluateReference(source)
      const tensor = circuit.evaluateTensor(source)
      // Both evaluators land on the same exact bit, and it is the documented one.
      expect(reference[decision]).toBe(expected)
      expect(tensor[decision]).toBe(expected)
      expect(tensor[decision]).toBe(reference[decision])
      validateTensorEvaluation(source, circuit, tensor)
    }
  })
})

describe('argmax sub-margin and exact ties', () => {
  function buildArgmax(scoreCount: number) {
    const circuit = new Circuit(scoreCount + 1)
    const unitWire = scoreCount
    for (let wire = 0; wire < scoreCount; wire++) circuit.assumeRange(asWire(wire), 0, 1)
    circuit.assumeRange(asWire(unitWire), 1, 1)
    const winner = emitArgmax(
      circuit,
      Array.from({length: scoreCount}, (_, item) => item).map(asWire),
      asWire(unitWire),
    )
    circuit.tensorProgram = circuit.compileTensorProgram([...winner.selected, winner.score])
    return {circuit, winner, unitWire}
  }

  function oneHot(values: Float32Array, selected: readonly Wire[]) {
    return selected.map(wire => values[wire])
  }

  test('a right score larger by less than 2**-24 still keeps the left candidate', () => {
    // Two candidates: right exceeds left by a sub-margin amount, so left wins.
    const {circuit, winner} = buildArgmax(2)
    const subMargin = 2 ** -25
    for (const base of [0.25, 0.5, 0.75, 1 / 3, 0.7]) {
      const left = Math.fround(base)
      const right = Math.fround(base + subMargin)
      // The right value must genuinely be greater after fround, else the test is vacuous.
      if (!(right > left)) continue
      const source = Float32Array.from([left, right, 1])
      const tensor = circuit.evaluateTensor(source)
      validateTensorEvaluation(source, circuit, tensor)
      expect(oneHot(tensor, winner.selected)).toEqual([1, 0])
    }
  })

  test('exact ties choose the left candidate at every tree position for sizes 2..9', () => {
    for (let scoreCount = 2; scoreCount <= 9; scoreCount++) {
      const {circuit, winner} = buildArgmax(scoreCount)
      // For each adjacent pair (positions i and i+1 carrying the joint maximum),
      // an exact tie must resolve to the lower (left) index.
      for (const tieValue of [0.25, 0.5, 0.7]) {
        for (let position = 0; position + 1 < scoreCount; position++) {
          const scores = Array.from({length: scoreCount}, () => 0)
          scores[position] = tieValue
          scores[position + 1] = tieValue
          const source = Float32Array.from([...scores, 1])
          const tensor = circuit.evaluateTensor(source)
          validateTensorEvaluation(source, circuit, tensor)
          // The selected one-hot must place its single 1 at the left tied index,
          // regardless of which subtree the pair lands in.
          const expected = winner.selected.map((_, item) => Number(item === position))
          expect(oneHot(tensor, winner.selected)).toEqual(expected)
          expect(tensor[winner.score]).toBe(Math.fround(tieValue))
        }
      }
    }
  })

  test('a global exact tie across all positions selects index zero', () => {
    for (let scoreCount = 2; scoreCount <= 9; scoreCount++) {
      const {circuit, winner} = buildArgmax(scoreCount)
      const source = Float32Array.from([...Array.from({length: scoreCount}, () => 0.5), 1])
      const tensor = circuit.evaluateTensor(source)
      validateTensorEvaluation(source, circuit, tensor)
      const expected = winner.selected.map((_, item) => Number(item === 0))
      expect(oneHot(tensor, winner.selected)).toEqual(expected)
    }
  })
})

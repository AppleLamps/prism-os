import {describe, expect, test} from 'bun:test'
import {Circuit, validateOneHotGroups, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {
  aboveZero,
  atLeastZero,
  belowZero,
  emitAll,
  emitAny,
  emitFirstSetBit,
  emitGather,
  emitIndexOneHot,
  emitPrefixSums,
  emitStepMatrix,
  matrixPower,
  springStepMatrix,
} from './kit.ts'

let seed = 20260913
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 2 ** 32
}

// Magnitudes below 2^e for e in -25..26, so values span the declared range of ±2^26.
const randomMagnitude = () => 2 ** Math.floor(random() * 52 - 25)

function fp32Pair(): [number, number] {
  const a = Math.fround((random() * 2 - 1) * randomMagnitude())
  const choice = random()
  // Equal values, adjacent FP32 values, and unrelated values.
  if (choice < 0.2) return [a, a]
  if (choice < 0.5) return [a, Math.fround(a * (1 + (random() < 0.5 ? -1 : 1) * 2 ** -23))]
  if (choice < 0.6) return [0, a]
  return [a, Math.fround((random() * 2 - 1) * randomMagnitude())]
}

describe('comparisons on preserved differences', () => {
  test('match the FP32 comparison of the difference for adjacent, equal, and far-apart values', () => {
    const pairCount = 2000
    const circuit = new Circuit(pairCount * 2)
    for (let wire = 0; wire < pairCount * 2; wire++) circuit.assumeRange(wire, -(2 ** 26), 2 ** 26)
    const outputs: {atLeast: Wire, above: Wire, below: Wire, both: Wire, either: Wire}[] = []
    for (let pair = 0; pair < pairCount; pair++) {
      const difference = circuit.roundAffine([[pair * 2, 1], [pair * 2 + 1, -1]])
      outputs.push({
        atLeast: emitAll(circuit, [atLeastZero(difference)]),
        above: emitAll(circuit, [aboveZero(difference)], {booleanAtom: true}),
        below: emitAny(circuit, [belowZero(difference)]),
        both: emitAll(circuit, [atLeastZero(difference), belowZero(difference)]),
        either: emitAny(circuit, [aboveZero(difference), belowZero(difference)], {booleanAtom: true}),
      })
    }
    const source = new Float32Array(pairCount * 2)
    for (let pair = 0; pair < pairCount; pair++) {
      const [a, b] = fp32Pair()
      source[pair * 2] = a
      source[pair * 2 + 1] = b
    }
    const values = circuit.evaluateTensor(source)
    let mismatches = 0
    let bandCases = 0
    for (let pair = 0; pair < pairCount; pair++) {
      const difference = Math.fround(source[pair * 2]! - source[pair * 2 + 1]!)
      if (difference !== 0 && Math.abs(difference) < 2 ** -41) {
        bandCases++
        continue
      }
      const expected = [difference >= 0, difference > 0, difference < 0, false, difference !== 0]
      const output = outputs[pair]!
      const actual = [output.atLeast, output.above, output.below, output.both, output.either].map(wire => values[wire]!)
      for (let index = 0; index < 5; index++) {
        if (actual[index] !== (expected[index] ? 1 : 0)) mismatches++
      }
    }
    expect(mismatches).toBe(0)
    // The generator deliberately makes adjacent values at magnitudes down to 2^-25, whose
    // differences fall inside the documented 2^-41 band; those are skipped, not checked.
    expect(pairCount - bandCases).toBeGreaterThan(pairCount * 0.9)
  })

  test('no upper magnitude limit: differences far above 2^23 still compare exactly', () => {
    const circuit = new Circuit(2)
    circuit.assumeRange(0, -1e30, 1e30)
    circuit.assumeRange(1, -1e30, 1e30)
    const difference = circuit.roundAffine([[0, 1], [1, -1]])
    const atLeast = emitAll(circuit, [atLeastZero(difference)])
    const cases: [number, number][] = [[1e25, -1e25], [-3e20, 2e20], [2 ** 30, 2 ** 30], [16777217, 16777216]]
    for (const [a, b] of cases) {
      const values = circuit.evaluateTensor(new Float32Array([a, b]))
      expect(values[atLeast]).toBe(Math.fround(a) - Math.fround(b) >= 0 ? 1 : 0)
    }
  })
})

describe('integer one-hots and gathers', () => {
  test('index one-hot members, thresholds, and a lowered gather are exact', () => {
    const count = 50
    const circuit = new Circuit(2 + count)
    circuit.assumeRange(0, 0, count - 1)
    circuit.assumeRange(1, 0, 1)
    for (let wire = 2; wire < 2 + count; wire++) circuit.assumeRange(wire, -1000, 1000)
    const {members, atLeast} = emitIndexOneHot(circuit, 0, count, 1)
    const candidates = Array.from({length: count}, (_, index) => 2 + index)
    const gathered = emitGather(circuit, members, candidates)
    const thresholds = Array.from({length: count + 1}, (_, index) => atLeast(index))
    const roots = [...members, gathered, ...thresholds]
    const program = circuit.compileTensorProgram(roots)
    expect(program.layers.reduce((total, layer) => total + layer.gatherReads.length, 0)).toBe(1)
    const source = new Float32Array(2 + count)
    for (let index = 0; index < count; index++) source[2 + index] = Math.fround(random() * 2000 - 1000)
    for (let present = 0; present <= 1; present++) {
      for (let index = 0; index < count; index++) {
        if (present === 0 && index > 0) break
        source[0] = index
        source[1] = present
        const values = circuit.evaluateTensor(source)
        validateOneHotGroups(circuit, values)
        members.forEach((member, position) => expect(values[member]).toBe(present === 1 && position === index ? 1 : 0))
        thresholds.forEach((wire, position) => expect(values[wire]).toBe(present === 1 && index >= position ? 1 : 0))
        expect(values[gathered]).toBe(present === 1 ? source[2 + index]! : 0)
      }
    }
  })

  test('first set bit selects the lowest index among set bits', () => {
    const count = 37
    const circuit = new Circuit(count + 1)
    for (let wire = 0; wire <= count; wire++) circuit.assumeRange(wire, 0, 1)
    const selected = emitFirstSetBit(circuit, count, Array.from({length: count}, (_, index) => index))
    const source = new Float32Array(count + 1)
    for (let trial = 0; trial < 300; trial++) {
      let first = -1
      for (let index = 0; index < count; index++) {
        source[index] = random() < 0.08 ? 1 : 0
        if (first < 0 && source[index] === 1) first = index
      }
      source[count] = trial % 5 === 0 ? 0 : 1
      const values = circuit.evaluateTensor(source)
      selected.forEach((wire, index) => expect(values[wire]).toBe(source[count] === 1 && index === first ? 1 : 0))
    }
  })

  test('triangle and Brent-Kung prefix sums agree with a float64 running sum to a small drift', () => {
    const count = 61
    for (const mode of ['triangle', 'brent-kung'] as const) {
      const circuit = new Circuit(count)
      for (let wire = 0; wire < count; wire++) circuit.assumeRange(wire, 0, 4096)
      const sums = emitPrefixSums(circuit, Array.from({length: count}, (_, index) => index), 40, 24, mode)
      const source = Float32Array.from({length: count}, () => Math.fround(random() * 400))
      const values = circuit.evaluateTensor(source)
      let running = 40
      for (let k = 0; k <= count; k++) {
        expect(Math.abs(values[sums[k]!]! - running)).toBeLessThan(0.01)
        if (k < count) running += source[k]! + 24
      }
    }
  })
})

describe('step matrix', () => {
  test('whole steps and leftover match floor division, and the matrix matches float64 powers', () => {
    const constants = {stiffness: 290, damping: 30, stepMilliseconds: 4}
    const circuit = new Circuit(1)
    circuit.assumeRange(0, 0, 16380)
    const stepMatrix = emitStepMatrix(circuit, 0, constants)
    const roots = [stepMatrix.steps, stepMatrix.leftover, ...stepMatrix.matrix]
    const evaluate = circuit.createTensorEvaluator(roots)
    const oneStep = springStepMatrix(constants)
    const elapsedCases = [0, 3.999755859375, 4, 1023.75, 1024, 4095.9375, 16380, 16379.5, 8.125]
    for (let trial = 0; trial < 200; trial++) elapsedCases.push(Math.round(random() * 16380 * 64) / 64)
    for (const elapsed of elapsedCases) {
      const outputs = evaluate(new Float32Array([elapsed]))
      const steps = Math.floor(elapsed / 4)
      expect(outputs[0]).toBe(steps)
      expect(outputs[1]).toBe(elapsed - steps * 4)
      const expected = matrixPower(oneStep, steps)
      // Relative error: long stalls decay entries to 1e-6 and far below, where absolute bounds hide errors.
      // Multiplying the digit matrices costs about 2e-6 relative; a telescoped table lookup was off by 10%.
      for (let entry = 0; entry < 4; entry++) {
        expect(Math.abs(outputs[2 + entry]! - expected[entry]!)).toBeLessThan(1e-5 * Math.abs(expected[entry]!) + 1e-30)
      }
    }
  })
})

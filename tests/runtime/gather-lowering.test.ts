import {describe, expect, test} from 'bun:test'
import {
  Circuit,
  type Wire,
  asWire,
  emitArgmax,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  inlineCircuit,
  invariant,
  validateCircuit,
  validateOneHotGroups,
  validateTensorProgram,
} from '../../src/runtime/numeric-ui-core.ts'
import {createWindowManagerMachine} from '../../src/handwiredos/window-manager.ts'

// Tests of gather lowering, described in execution-model.md "One-hot groups and
// gathers": a masked sum over a declared one-hot group compiles to a read of the
// selected candidate. These tests moved here from lab/gather-lowering on
// September 16, 2026. That folder's README, with the July exactness argument,
// benchmarks and executor study, is at
// https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/gather-lowering

type CompiledProgram = ReturnType<Circuit['compileTensorProgram']>

// Seeded hash, copied from numeric-ui-core.test.ts so every run is deterministic.
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

// The repo's agreement standard for compiled backends is ===, which treats
// +0 and -0 as equal; Object.is additionally treats NaN as equal to itself so
// a wire that legitimately computes NaN in both evaluators still counts as
// matching. Any other difference is a real mismatch.
function sameNumericValue(left: number, right: number) {
  return left === right || Object.is(left, right)
}

function gatherStatistics(program: CompiledProgram) {
  let readCount = 0
  let computeCount = 0
  let storedWeightCount = 0
  let gatherBytes = 0
  for (const layer of program.layers) {
    readCount += layer.gatherReads.length
    computeCount += layer.gatherComputes.length
    storedWeightCount += layer.weights.length
    for (const compute of layer.gatherComputes) {
      // The bit table plus the slot number (stored as one 32-bit value).
      gatherBytes += compute.bitPositions.byteLength + 4
    }
    for (const read of layer.gatherReads) {
      // The candidate table plus row, slot, and mask flag (three 32-bit values).
      gatherBytes += read.candidatePositions.byteLength + 12
    }
  }
  return {readCount, computeCount, slotCount: program.gatherSlotCount, storedWeightCount, gatherBytes}
}

// The set of wires whose defining operation was lowered to a gather read.
function loweredWires(program: CompiledProgram): Set<number> {
  const wires = new Set<number>()
  let availableValues = program.sourceSize
  for (const layer of program.layers) {
    for (const read of layer.gatherReads) {
      wires.add(program.wireOrder[availableValues + read.row]!)
    }
    availableValues += layer.outputSize
  }
  return wires
}

// Unit-level coverage of the recognition algorithm: which sums lower, which
// must not, and how recognition behaves under the builder's own rewrites
// (affine inlining, expression deduplication, constant folding). Every lowered
// case is also checked bit-for-bit against the reference evaluator.
describe('recognition', () => {
  function compileBoth(circuit: Circuit, roots?: readonly Wire[]) {
    const lowered = circuit.compileTensorProgram(roots, true)
    const plain = circuit.compileTensorProgram(roots, false)
    validateTensorProgram(circuit, lowered)
    validateTensorProgram(circuit, plain)
    return {lowered, plain}
  }

  function expectExact(circuit: Circuit, program: CompiledProgram, source: Float32Array) {
    const reference = circuit.evaluateReference(source)
    circuit.tensorProgram = program
    const tensor = circuit.evaluateTensor(source)
    for (const wire of program.wireOrder) {
      if (!sameNumericValue(tensor[wire]!, reference[wire]!)) {
        throw new Error(
          `wire ${wire}: tensor ${tensor[wire]} does not match reference ${reference[wire]}`,
        )
      }
    }
    return reference
  }

  // slotCount bits declared one-hot, slotCount non-negative values, one masked
  // sum reading the selected value.
  function buildBasicRead(slotCount: number, bias = 0) {
    const circuit = new Circuit(slotCount * 2)
    const bits = Array.from({length: slotCount}, (_, slot) => circuit.source(slot))
    const values = Array.from({length: slotCount}, (_, slot) => circuit.source(slotCount + slot))
    circuit.assumeOneHot(bits)
    for (const value of values) circuit.assumeRange(value, 0, 4096)
    const read = circuit.affine(
      bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]),
      bias,
    )
    return {circuit, bits, values, read}
  }

  function basicSource(slotCount: number, selectedSlot: number) {
    const source = new Float32Array(slotCount * 2)
    if (selectedSlot >= 0) source[selectedSlot] = 1
    for (let slot = 0; slot < slotCount; slot++) {
      source[slotCount + slot] = Math.fround(10.5 + slot * 3.25)
    }
    return source
  }

  test('a one-hot-masked sum lowers to one gather and drops its products', () => {
    const slotCount = 8
    const {circuit, read} = buildBasicRead(slotCount)
    const {lowered, plain} = compileBoth(circuit, [read])

    const loweredStats = gatherStatistics(lowered)
    const plainStats = gatherStatistics(plain)
    expect(loweredStats.readCount).toBe(1)
    expect(loweredStats.slotCount).toBe(1)
    // The dense form stores 2 weights per product plus 1 per sum term.
    expect(plainStats.storedWeightCount).toBe(3 * slotCount)
    // The gather row stores no weights, and the products fall out of the live
    // set entirely: only the sum itself remains past the sources.
    expect(loweredStats.storedWeightCount).toBe(0)
    expect(lowered.valueCount).toBe(circuit.sourceSize + 1)

    for (let selectedSlot = 0; selectedSlot < slotCount; selectedSlot++) {
      const source = basicSource(slotCount, selectedSlot)
      const reference = expectExact(circuit, lowered, source)
      expectExact(circuit, plain, source)
      expect(reference[read]).toBe(source[slotCount + selectedSlot])
    }
  })

  test('a bias on the masked sum survives lowering exactly', () => {
    const {circuit, read} = buildBasicRead(4, 0.1)
    const {lowered} = compileBoth(circuit, [read])
    expect(gatherStatistics(lowered).readCount).toBe(1)
    for (let selectedSlot = 0; selectedSlot < 4; selectedSlot++) {
      const source = basicSource(4, selectedSlot)
      const reference = expectExact(circuit, lowered, source)
      expect(reference[read]).toBe(Math.fround(Math.fround(0.1) + source[4 + selectedSlot]!))
    }
  })

  test('signed values lower through the mixed-sign product pair', () => {
    // Declaring the group after building the products keeps the bits' ranges
    // unknown at emit time, so emitMultiply takes its mixed-sign path: two reglu
    // arms subtracted by an affine, which composition then splays into the sum.
    const slotCount = 6
    const circuit = new Circuit(slotCount * 2)
    const bits = Array.from({length: slotCount}, (_, slot) => circuit.source(slot))
    const values = Array.from({length: slotCount}, (_, slot) => circuit.source(slotCount + slot))
    for (const value of values) circuit.assumeRange(value, -4096, 4096)
    const read = circuit.affine(
      bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]),
    )
    circuit.assumeOneHot(bits, false, {allowExistingReaders: true})
    const {lowered} = compileBoth(circuit, [read])
    expect(gatherStatistics(lowered).readCount).toBe(1)

    for (let selectedSlot = 0; selectedSlot < slotCount; selectedSlot++) {
      const source = new Float32Array(slotCount * 2)
      source[selectedSlot] = 1
      for (let slot = 0; slot < slotCount; slot++) {
        source[slotCount + slot] = Math.fround((slot % 2 === 0 ? -1 : 1) * (20.75 + slot))
      }
      const reference = expectExact(circuit, lowered, source)
      expect(reference[read]).toBe(source[slotCount + selectedSlot])
    }
  })

  test('the bit-in-gate orientation lowers for values that may be negative', () => {
    // With the bits declared before the multiply, a signed value makes
    // emitMultiply put the bit in the gate: fround(value * max(0, bit)).
    const slotCount = 5
    const circuit = new Circuit(slotCount * 2)
    const bits = Array.from({length: slotCount}, (_, slot) => circuit.source(slot))
    const values = Array.from({length: slotCount}, (_, slot) => circuit.source(slotCount + slot))
    circuit.assumeOneHot(bits)
    for (const value of values) circuit.assumeRange(value, -1e6, 1e6)
    const read = circuit.affine(
      bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]),
    )
    const {lowered} = compileBoth(circuit, [read])
    expect(gatherStatistics(lowered).readCount).toBe(1)
    const source = new Float32Array(slotCount * 2)
    source[2] = 1
    for (let slot = 0; slot < slotCount; slot++) {
      source[slotCount + slot] = Math.fround(-1000.5 + slot * 7.75)
    }
    const reference = expectExact(circuit, lowered, source)
    expect(reference[read]).toBe(source[slotCount + 2])
  })

  test('sums that are not pure masked reads stay dense and stay exact', () => {
    const slotCount = 4
    const build = (mutate: (circuit: Circuit, terms: [Wire, number][]) => void) => {
      const circuit = new Circuit(slotCount * 2 + 1)
      const bits = Array.from({length: slotCount}, (_, slot) => circuit.source(slot))
      const values = Array.from({length: slotCount}, (_, slot) => circuit.source(slotCount + slot))
      circuit.assumeOneHot(bits)
      for (const value of values) circuit.assumeRange(value, 0, 4096)
      circuit.assumeRange(circuit.source(slotCount * 2), 0, 4096)
      const terms: [Wire, number][] = bits.map((bit, slot) => [
        emitMultiply(circuit, bit, values[slot]!),
        1,
      ])
      mutate(circuit, terms)
      const read = circuit.affine(terms)
      return {circuit, read}
    }

    const cases: [string, (circuit: Circuit, terms: [Wire, number][]) => void][] = [
      ['a scaled term', (_circuit, terms) => {
        terms[1]![1] = 2
      }],
      ['a missing member product', (_circuit, terms) => {
        terms.pop()
      }],
      ['an extra unrelated term', (circuit, terms) => {
        terms.push([circuit.affine([[circuit.source(slotCount * 2), 1]], 5), 1])
      }],
    ]
    for (const [label, mutate] of cases) {
      const {circuit, read} = build(mutate)
      const {lowered} = compileBoth(circuit, [read])
      expect(gatherStatistics(lowered).readCount, label).toBe(0)
      const source = new Float32Array(slotCount * 2 + 1)
      source[1] = 1
      for (let slot = 0; slot < slotCount; slot++) source[slotCount + slot] = 3 + slot
      source[slotCount * 2] = 11
      expectExact(circuit, lowered, source)
    }
  })

  test('a sum mixing products of two different groups stays dense', () => {
    const circuit = new Circuit(8)
    circuit.assumeOneHot([circuit.source(0), circuit.source(1)])
    circuit.assumeOneHot([circuit.source(2), circuit.source(3)])
    for (let value = 4; value < 8; value++) circuit.assumeRange(circuit.source(value), 0, 100)
    // Bit 0 reads value 4, bit 1 value 5, bit 2 value 6 and bit 3 value 7.
    const read = circuit.affine([0, 1, 2, 3].map(bit => [
      emitMultiply(circuit, circuit.source(bit), circuit.source(4 + bit)),
      1,
    ]))
    const {lowered} = compileBoth(circuit, [read])
    expect(gatherStatistics(lowered).readCount).toBe(0)
    expectExact(circuit, lowered, Float32Array.from([1, 0, 0, 1, 5, 6, 7, 8]))
  })

  test('a hand-written bit-in-left product over a signed value is rejected', () => {
    // fround(bit * max(0, value)) only reads the value when the relu is the
    // identity. With a possibly-negative value the recognizer must leave the sum
    // dense — and the dense form is then the circuit author's own bug to notice,
    // because relu already clipped the stored value.
    const circuit = new Circuit(4)
    const bits = [circuit.source(0), circuit.source(1)]
    const values = [circuit.source(2), circuit.source(3)]
    circuit.assumeOneHot(bits)
    for (const value of values) circuit.assumeRange(value, -100, 100)
    const read = circuit.affine(bits.map((bit, slot) => [
      circuit.reglu([[bit, 1]], 0, [[values[slot]!, 1]], 0),
      1,
    ]))
    const {lowered} = compileBoth(circuit, [read])
    expect(gatherStatistics(lowered).readCount).toBe(0)
    expectExact(circuit, lowered, Float32Array.from([0, 1, 7, -9]))
  })

  test('a size-1 group lowers its biased read and aliases its bare read', () => {
    const circuit = new Circuit(2)
    const bit = circuit.source(0)
    const value = circuit.source(1)
    circuit.assumeOneHot([bit])
    circuit.assumeRange(value, 0, 100)
    const product = emitMultiply(circuit, bit, value)
    // The bare sum affine([[product, 1]]) aliases straight back to the product,
    // so there is no sum operation to lower; a bias forces a real operation.
    const bareRead = circuit.affine([[product, 1]])
    expect(bareRead).toBe(product)
    const biasedRead = circuit.affine([[product, 1]], 2)
    const {lowered} = compileBoth(circuit, [bareRead, biasedRead])
    expect(gatherStatistics(lowered).readCount).toBe(1)
    const reference = expectExact(circuit, lowered, Float32Array.from([1, 42]))
    expect(reference[biasedRead]).toBe(44)
  })

  test('many reads against one group share a single index resolution', () => {
    const slotCount = 8
    const readCount = 5
    const circuit = new Circuit(slotCount + slotCount * readCount)
    const bits = Array.from({length: slotCount}, (_, slot) => circuit.source(slot))
    circuit.assumeOneHot(bits)
    const reads: Wire[] = []
    for (let field = 0; field < readCount; field++) {
      const values = Array.from(
        {length: slotCount},
        (_, slot) => circuit.source(slotCount + field * slotCount + slot),
      )
      for (const value of values) circuit.assumeRange(value, 0, 1e6)
      reads.push(circuit.affine(
        bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]),
      ))
    }
    const {lowered} = compileBoth(circuit, reads)
    const statistics = gatherStatistics(lowered)
    expect(statistics.readCount).toBe(readCount)
    expect(statistics.computeCount).toBe(1)
    expect(statistics.slotCount).toBe(1)

    const source = new Float32Array(circuit.sourceSize)
    source[3] = 1
    for (let cell = slotCount; cell < circuit.sourceSize; cell++) {
      source[cell] = Math.fround(cell * 1.5)
    }
    expectExact(circuit, lowered, source)
  })

  test('identical reads deduplicate to one wire and one gather', () => {
    const slotCount = 4
    const {circuit, bits, values, read} = buildBasicRead(slotCount)
    const duplicate = circuit.affine(
      bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]),
    )
    expect(duplicate).toBe(read)
    const {lowered} = compileBoth(circuit, [read, duplicate])
    expect(gatherStatistics(lowered).readCount).toBe(1)
  })

  test('a gather output can be the candidate of another gather', () => {
    // Two libraries: the first gather picks a value, and that value is one of
    // the candidates the second group reads. Exactness must hold through the
    // chain because the first gather's output is bit-identical to its sum.
    const circuit = new Circuit(4 + 4 + 2 + 1)
    const firstBits = [0, 1, 2, 3].map(cell => circuit.source(cell))
    const firstValues = [4, 5, 6, 7].map(cell => circuit.source(cell))
    const secondBits = [circuit.source(8), circuit.source(9)]
    const plainValue = circuit.source(10)
    circuit.assumeOneHot(firstBits)
    circuit.assumeOneHot(secondBits)
    for (const value of firstValues) circuit.assumeRange(value, 0, 1000)
    circuit.assumeRange(plainValue, 0, 1000)
    const firstRead = circuit.affine(
      firstBits.map((bit, slot) => [emitMultiply(circuit, bit, firstValues[slot]!), 1]),
    )
    const secondRead = circuit.affine([
      [emitMultiply(circuit, secondBits[0]!, firstRead), 1],
      [emitMultiply(circuit, secondBits[1]!, plainValue), 1],
    ])
    const {lowered} = compileBoth(circuit, [secondRead])
    expect(gatherStatistics(lowered).readCount).toBe(2)

    for (const [firstSlot, secondSlot] of [[0, 0], [2, 0], [3, 1]] as const) {
      const source = new Float32Array(circuit.sourceSize)
      source[firstSlot] = 1
      source[8 + secondSlot] = 1
      for (let slot = 0; slot < 4; slot++) source[4 + slot] = Math.fround(100.5 + slot)
      source[plainValue] = 999
      const reference = expectExact(circuit, lowered, source)
      expect(reference[secondRead]).toBe(
        secondSlot === 0 ? source[4 + firstSlot]! : 999,
      )
    }
  })

  test('an all-zero-allowed group multiplies the gathered value by its mass', () => {
    const slotCount = 4
    const circuit = new Circuit(slotCount * 2)
    const bits = Array.from({length: slotCount}, (_, slot) => circuit.source(slot))
    const values = Array.from({length: slotCount}, (_, slot) => circuit.source(slotCount + slot))
    circuit.assumeOneHot(bits, true)
    for (const value of values) circuit.assumeRange(value, 0, 4096)
    const read = circuit.affine(
      bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]),
    )
    const {lowered} = compileBoth(circuit, [read])
    expect(gatherStatistics(lowered).readCount).toBe(1)

    // Every one-hot state plus the all-zero state.
    for (let selectedSlot = -1; selectedSlot < slotCount; selectedSlot++) {
      const source = basicSource(slotCount, selectedSlot)
      const reference = expectExact(circuit, lowered, source)
      expect(reference[read]).toBe(selectedSlot < 0 ? 0 : source[slotCount + selectedSlot]!)
    }
  })

  test('recognition survives the affine inlining of argmax selection wires', () => {
    // This replicates candidate-gallery's selectValue in miniature: argmax over
    // three scores produces selection wires, some of which are two-term affines
    // that the builder inlines into any consumer. The product reglus therefore
    // store the selection wire's expanded definition, and recognition has to
    // recover the wire through the deduplication map.
    const scoreCount = 3
    const circuit = new Circuit(scoreCount + scoreCount + 1)
    const scores = Array.from({length: scoreCount}, (_, score) => circuit.source(score))
    const values = Array.from({length: scoreCount}, (_, candidate) => circuit.source(scoreCount + candidate))
    const unit = circuit.source(scoreCount + scoreCount)
    for (const score of scores) circuit.assumeRange(score, 0, 1)
    for (const value of values) circuit.assumeRange(value, 0, 4096)
    circuit.assumeRange(unit, 1, 1)
    const winner = emitArgmax(circuit, scores, unit)
    const read = circuit.affine(winner.selected.map((bit, candidate) => [
      emitMultiply(circuit, bit, values[candidate]!),
      1,
    ]))
    const {lowered} = compileBoth(circuit, [read, ...winner.selected])
    expect(gatherStatistics(lowered).readCount).toBe(1)

    for (const scoreValues of [[0.2, 0.9, 0.5], [0.9, 0.2, 0.5], [0.5, 0.5, 0.5], [0.1, 0.2, 0.9]]) {
      const source = Float32Array.from([...scoreValues, 17.5, 23.25, 31.125, 1])
      const reference = expectExact(circuit, lowered, source)
      const winnerIndex = winner.selected.findIndex(bit => reference[bit] === 1)
      expect(reference[read]).toBe(source[scoreCount + winnerIndex])
    }
  })

  test('emitArgmax declares its group; emitFirstActive only for proven bits', () => {
    const circuit = new Circuit(5)
    const scores = [circuit.source(0), circuit.source(1), circuit.source(2)]
    const gate = circuit.source(3)
    const unit = circuit.source(4)
    for (const wire of [...scores, gate]) circuit.assumeRange(wire, 0, 1)
    circuit.assumeRange(unit, 1, 1)
    // Argmax declares unconditionally: fractional scores only feed the boolean
    // comparisons, and the tournament still routes the unit down one path.
    const winner = emitArgmax(circuit, scores, unit)
    expect(circuit.oneHotGroups.length).toBe(1)
    expect(circuit.oneHotGroups[0]!.members).toEqual(winner.selected)
    expect(circuit.oneHotGroups[0]!.allowAllZero).toBe(false)

    // A 0..1 range admits fractional values, so this selection is not provably
    // one-hot and must stay undeclared.
    emitFirstActive(circuit, gate, scores)
    expect(circuit.oneHotGroups.length).toBe(1)

    // Boolean atoms produce exact bits, and the unit wire's range pins it to 1,
    // so this selection is provably one-hot-or-all-zero and declares itself.
    const bits = scores.map(score => circuit.boolean(score))
    const selected = emitFirstActive(circuit, unit, bits)
    expect(circuit.oneHotGroups.length).toBe(2)
    expect(circuit.oneHotGroups[1]!.members).toEqual(selected)
    expect(circuit.oneHotGroups[1]!.allowAllZero).toBe(true)

    const values = circuit.evaluateReference(Float32Array.from([0.5, 0.75, 0.25, 0, 1]))
    validateOneHotGroups(circuit, values)
  })

  test('fractional first-active selections never lower a masked sum', () => {
    // emitFirstActive's preconditions only bound its inputs to 0..1, and
    // fractional scores are legal: candidates [0.5, 0] route mass 0.25 to each
    // output, so the selection is not a one-hot. An unconditional declaration
    // here once lowered this read to a gather returning 50 while the reference
    // computes 75.
    const circuit = new Circuit(5)
    const gate = circuit.source(0)
    const candidates = [circuit.source(1), circuit.source(2)]
    const values = [circuit.source(3), circuit.source(4)]
    for (const wire of [gate, ...candidates]) circuit.assumeRange(wire, 0, 1)
    for (const value of values) circuit.assumeRange(value, 0, 1000)
    const selected = emitFirstActive(circuit, gate, candidates)
    const read = circuit.affine(selected.map((bit, item) => [
      emitMultiply(circuit, bit, values[item]!),
      1,
    ]))
    expect(circuit.oneHotGroups.length).toBe(0)
    const {lowered, plain} = compileBoth(circuit, [read])
    expect(gatherStatistics(lowered).readCount).toBe(0)

    const source = Float32Array.from([1, 0.5, 0, 100, 200])
    const reference = expectExact(circuit, lowered, source)
    expectExact(circuit, plain, source)
    expect(reference[read]).toBe(75)
  })

  test('emitFirstActive accepts candidates that fold to one shared constant', () => {
    // The candidates share a constant, but multiplication preserves distinct
    // routing operations. Their all-zero group is legal and remains checkable.
    const circuit = new Circuit(1)
    const unit = circuit.source(0)
    circuit.assumeRange(unit, 1, 1)
    const zero = circuit.constant(0)
    const selected = emitFirstActive(circuit, unit, [zero, zero])
    expect(selected.length).toBe(2)
    expect(circuit.oneHotGroups.length).toBe(1)
    const values = circuit.evaluateReference(Float32Array.from([1]))
    expect(selected.map(wire => values[wire])).toEqual([0, 0])
    validateOneHotGroups(circuit, values)
  })

  test('candidates with unbounded declared ranges are refused in every orientation', () => {
    // A range that admits Infinity breaks the exactness argument: with the
    // offending value infinite and its bit 0, the reference computes
    // fround(Infinity * 0) = NaN and the whole sum poisons to NaN, while a
    // gather would skip that product and return the selected value.
    const infinity = Number.POSITIVE_INFINITY
    const buildRead = (declareBitsFirst: boolean, valueRange: [number, number]) => {
      const circuit = new Circuit(4)
      const bits = [circuit.source(0), circuit.source(1)]
      const values = [circuit.source(2), circuit.source(3)]
      if (declareBitsFirst) circuit.assumeOneHot(bits)
      for (const value of values) circuit.assumeRange(value, valueRange[0], valueRange[1])
      const read = circuit.affine(bits.map((bit, item) => [
        emitMultiply(circuit, bit, values[item]!),
        1,
      ]))
      if (!declareBitsFirst) circuit.assumeOneHot(bits, false, {allowExistingReaders: true})
      return {circuit, read}
    }

    const cases: [string, boolean, [number, number]][] = [
      // Bits declared first, non-negative unbounded values: emitMultiply puts
      // the bit on the left, and the value's maximum is not finite.
      ['bit on the left', true, [0, infinity]],
      // Bits declared first, fully unknown values: emitMultiply puts the bit in
      // the gate, and the value's range is unbounded on both ends.
      ['bit in the gate', true, [-infinity, infinity]],
      // Bits declared after the reads: emitMultiply takes the mixed-sign pair
      // path, whose arms carry the same unbounded value.
      ['mixed-sign pair', false, [-infinity, infinity]],
    ]
    for (const [label, declareBitsFirst, valueRange] of cases) {
      const {circuit, read} = buildRead(declareBitsFirst, valueRange)
      const {lowered} = compileBoth(circuit, [read])
      expect(gatherStatistics(lowered).readCount, label).toBe(0)
      // The selected slot holds 5, the non-selected slot holds Infinity: both
      // evaluators must agree on the NaN the dense sum produces.
      const source = Float32Array.from([1, 0, 5, infinity])
      const reference = circuit.evaluateReference(source)
      expect(Number.isNaN(reference[read]!), label).toBe(true)
      expectExact(circuit, lowered, source)
    }
  })

  test('an ignorable filler term over an unbounded value blocks lowering', () => {
    const buildRead = (fillerMaximum: number) => {
      const circuit = new Circuit(5)
      const bits = [circuit.source(0), circuit.source(1)]
      const values = [circuit.source(2), circuit.source(3)]
      const fillerValue = circuit.source(4)
      circuit.assumeOneHot(bits)
      for (const value of values) circuit.assumeRange(value, 0, 100)
      circuit.assumeRange(fillerValue, 0, fillerMaximum)
      const read = circuit.affine([
        [emitMultiply(circuit, bits[0]!, values[0]!), 1],
        [emitMultiply(circuit, bits[1]!, values[1]!), 1],
        // The filler shape: fround(x * max(0, -bit)), a signed zero for exact
        // bits but NaN when x is infinite.
        [circuit.reglu([[fillerValue, 1]], 0, [[bits[0]!, -1]], 0), 1],
      ])
      return {circuit, read}
    }

    const finite = buildRead(100)
    const {lowered: finiteLowered} = compileBoth(finite.circuit, [finite.read])
    expect(gatherStatistics(finiteLowered).readCount).toBe(1)
    expectExact(finite.circuit, finiteLowered, Float32Array.from([0, 1, 7, 9, 50]))

    const unbounded = buildRead(Number.POSITIVE_INFINITY)
    const {lowered: unboundedLowered} = compileBoth(unbounded.circuit, [unbounded.read])
    expect(gatherStatistics(unboundedLowered).readCount).toBe(0)
    const source = Float32Array.from([1, 0, 7, 9, Number.POSITIVE_INFINITY])
    const reference = unbounded.circuit.evaluateReference(source)
    expect(Number.isNaN(reference[unbounded.read]!)).toBe(true)
    expectExact(unbounded.circuit, unboundedLowered, source)
  })

  test('a result that is exactly zero may carry the other sign of zero', () => {
    // The lowering agreement standard is ===, the same comparison
    // validateTensorEvaluation uses, and === treats +0 and -0 as equal. These
    // two cases pin the one known divergence class: the reference accumulates
    // signed zeros from every product in wire order, while the gather adds only
    // the selected contribution, so an exactly-zero result can come out as +0
    // on one side and -0 on the other.
    const buildRead = (allowAllZero: boolean) => {
      const circuit = new Circuit(4)
      const bits = [circuit.source(0), circuit.source(1)]
      const signedValue = circuit.source(2)
      const nonnegativeValue = circuit.source(3)
      circuit.assumeOneHot(bits, allowAllZero)
      circuit.assumeRange(signedValue, -10, 10)
      circuit.assumeRange(nonnegativeValue, 0, 10)
      const read = circuit.affine([
        [emitMultiply(circuit, bits[0]!, signedValue), 1],
        [emitMultiply(circuit, bits[1]!, nonnegativeValue), 1],
      ], -0)
      return {circuit, read}
    }

    // Case A: all-zero-allowed group, inactive. The reference walks the -0 bias
    // through a -0 then a +0 product and lands on +0; the gather adds
    // fround(0 * -5) = -0 onto the -0 bias and lands on -0.
    {
      const {circuit, read} = buildRead(true)
      const {lowered} = compileBoth(circuit, [read])
      expect(gatherStatistics(lowered).readCount).toBe(1)
      const source = Float32Array.from([0, 0, -5, 7])
      const reference = circuit.evaluateReference(source)
      circuit.tensorProgram = lowered
      const tensor = circuit.evaluateTensor(source)
      expect(tensor[read] === reference[read]!).toBe(true)
      expect(Object.is(reference[read], 0)).toBe(true)
      expect(Object.is(tensor[read], -0)).toBe(true)
    }
    // Case B: strict one-hot selecting a value that is itself -0, with a
    // positive candidate later in wire order pulling the reference back to +0.
    {
      const {circuit, read} = buildRead(false)
      const {lowered} = compileBoth(circuit, [read])
      expect(gatherStatistics(lowered).readCount).toBe(1)
      const source = Float32Array.from([1, 0, -0, 7])
      const reference = circuit.evaluateReference(source)
      circuit.tensorProgram = lowered
      const tensor = circuit.evaluateTensor(source)
      expect(tensor[read] === reference[read]!).toBe(true)
      expect(Object.is(reference[read], 0)).toBe(true)
      expect(Object.is(tensor[read], -0)).toBe(true)
    }
  })

  test('inlineCircuit carries declared groups into the target circuit', () => {
    const child = new Circuit(4)
    const childBits = [child.source(0), child.source(1)]
    const childValues = [child.source(2), child.source(3)]
    child.assumeOneHot(childBits, true)
    for (const value of childValues) child.assumeRange(value, 0, 100)
    const childRead = child.affine(childBits.map((bit, slot) => [
      emitMultiply(child, bit, childValues[slot]!),
      1,
    ]))
    const parent = new Circuit(5)
    const parentBits = [parent.source(1), parent.source(2)]
    const parentValues = [parent.source(3), parent.source(4)]
    for (const wire of parentBits) parent.assumeRange(wire, 0, 1)
    for (const wire of parentValues) parent.assumeRange(wire, 0, 100)
    const wireMap = inlineCircuit(parent, child, [...parentBits, ...parentValues])

    expect(parent.oneHotGroups.length).toBe(1)
    expect(parent.oneHotGroups[0]!.members).toEqual(parentBits)
    expect(parent.oneHotGroups[0]!.allowAllZero).toBe(true)

    const read = wireMap[childRead]!
    const {lowered} = compileBoth(parent, [read])
    expect(gatherStatistics(lowered).readCount).toBe(1)
    expectExact(parent, lowered, Float32Array.from([9, 0, 1, 5, 7]))
  })

  test('lowering can be turned off per compile', () => {
    const {circuit, read} = buildBasicRead(4)
    const plain = circuit.compileTensorProgram([read], false)
    expect(gatherStatistics(plain).readCount).toBe(0)
    expect(gatherStatistics(plain).storedWeightCount).toBe(12)
    expectExact(circuit, plain, basicSource(4, 2))
  })

  test('gather outputs feed downstream macros exactly', () => {
    const slotCount = 6
    const {circuit, bits, values, read} = buildBasicRead(slotCount)
    const other = circuit.affine(
      bits.map((bit, slot) => [
        emitMultiply(circuit, bit, values[(slot + 1) % slotCount]!),
        1,
      ]),
    )
    const largest = emitMaximum(circuit, read, other)
    const scaled = emitMultiply(circuit, read, other)
    const {lowered} = compileBoth(circuit, [largest, scaled])
    expect(gatherStatistics(lowered).readCount).toBe(2)
    for (let selectedSlot = 0; selectedSlot < slotCount; selectedSlot++) {
      expectExact(circuit, lowered, basicSource(slotCount, selectedSlot))
    }
  })

  test('a violated one-hot contract diverges and validation catches it', () => {
    // Two bits set at once: the reference sums both values while the gather
    // reads the slot addressed by the corrupted index. The lowering contract is
    // exactly the declared invariant, so validateOneHotGroups is the check a
    // trainer must run before writing hardened bits back into the source table.
    const slotCount = 4
    const {circuit, read} = buildBasicRead(slotCount)
    const {lowered} = compileBoth(circuit, [read])
    const source = basicSource(slotCount, 0)
    source[2] = 1 // second active bit, violating the declaration
    const reference = circuit.evaluateReference(source)
    circuit.tensorProgram = lowered
    const tensor = circuit.evaluateTensor(source)
    expect(tensor[read]).not.toBe(reference[read]!)
    expect(() => validateOneHotGroups(circuit, reference)).toThrow(/one-hot group/)
  })

  describe('adversarial value magnitudes', () => {
    // FP32 extremes within declared ranges: the largest finite float, the
    // smallest normal, subnormals, negative zero, and integers at the 2^24
    // boundary where FP32 loses integer exactness. The gather must reproduce
    // each stored value bit-for-bit because fround(1 * value) = value for every
    // finite value.
    const extremes = [
      3.4028234663852886e38,
      -3.4028234663852886e38,
      1.1754943508222875e-38,
      -1.401298464324817e-45,
      -0,
      0,
      16_777_216,
      16_777_217,
      -16_777_215,
      0.1,
    ] as const

    test('extreme candidates gather bit-for-bit', () => {
      const slotCount = extremes.length
      const circuit = new Circuit(slotCount * 2)
      const bits = Array.from({length: slotCount}, (_, slot) => circuit.source(slot))
      const values = Array.from({length: slotCount}, (_, slot) => circuit.source(slotCount + slot))
      circuit.assumeOneHot(bits)
      for (const value of values) {
        circuit.assumeRange(value, -3.4028234663852886e38, 3.4028234663852886e38)
      }
      const read = circuit.affine(
        bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]),
      )
      const {lowered} = compileBoth(circuit, [read])
      expect(gatherStatistics(lowered).readCount).toBe(1)

      for (let selectedSlot = 0; selectedSlot < slotCount; selectedSlot++) {
        const source = new Float32Array(slotCount * 2)
        source[selectedSlot] = 1
        for (let slot = 0; slot < slotCount; slot++) {
          source[slotCount + slot] = extremes[slot]!
        }
        const reference = expectExact(circuit, lowered, source)
        expect(sameNumericValue(reference[read]!, Math.fround(extremes[selectedSlot]!))).toBe(true)
      }
    })
  })
})

// Structural asymptotics of the lowering on a photo library shape: slotCount
// items, readCount stored value fields per item (geometry cells and the like),
// and a one-hot selection over the items, all in the source table. Each read
// looks up one field of the selected item through a one-hot-masked sum. The
// timings of this shape were measured by lab/gather-lowering/benchmark.ts, at
// the tag named at the top of this file.
describe('library circuits', () => {
  function buildLibraryCircuit(slotCount: number, readCount: number) {
    const circuit = new Circuit(slotCount + slotCount * readCount)
    const bits = Array.from({length: slotCount}, (_, slot) => circuit.source(slot))
    circuit.assumeOneHot(bits)
    const valueCell = (field: number, slot: number) => slotCount + field * slotCount + slot
    for (let field = 0; field < readCount; field++) {
      for (let slot = 0; slot < slotCount; slot++) {
        circuit.assumeRange(circuit.source(valueCell(field, slot)), 0, 1e6)
      }
    }
    const reads: Wire[] = []
    for (let field = 0; field < readCount; field++) {
      reads.push(circuit.affine(bits.map((bit, slot) => [
        emitMultiply(circuit, bit, circuit.source(valueCell(field, slot))),
        1,
      ])))
    }
    return {circuit, reads, valueCell}
  }

  // Every field value is distinct, so a wrong gather index can't accidentally
  // produce the right answer.
  function fillLibrarySource(
    source: Float32Array,
    slotCount: number,
    readCount: number,
    selectedSlot: number,
  ) {
    source.fill(0)
    source[selectedSlot] = 1
    for (let field = 0; field < readCount; field++) {
      for (let slot = 0; slot < slotCount; slot++) {
        source[slotCount + field * slotCount + slot] = Math.fround(
          1 + field * 7919 + slot * 13.25,
        )
      }
    }
  }

  test('stored weights per read drop from 3N to zero under lowering', () => {
    for (const slotCount of [64, 256]) {
      for (const readCount of [1, 4]) {
        const {circuit, reads} = buildLibraryCircuit(slotCount, readCount)
        const lowered = circuit.compileTensorProgram(reads, true)
        const plain = circuit.compileTensorProgram(reads, false)
        validateTensorProgram(circuit, lowered)
        validateTensorProgram(circuit, plain)
        const loweredStats = gatherStatistics(lowered)
        const plainStats = gatherStatistics(plain)

        // Dense form: per read, N products of 2 stored weights each plus an
        // N-term sum. Lowered form: no stored weights at all — the products are
        // dead and each read is one gather row.
        expect(plainStats.storedWeightCount).toBe(3 * slotCount * readCount)
        expect(loweredStats.storedWeightCount).toBe(0)
        expect(loweredStats.readCount).toBe(readCount)
        expect(loweredStats.computeCount).toBe(1)
        // Only the read outputs survive past the sources.
        expect(lowered.valueCount).toBe(circuit.sourceSize + readCount)
        expect(plain.valueCount).toBe(circuit.sourceSize + readCount + slotCount * readCount)

        // What remains proportional to N: the shared bit table (N entries) and
        // one candidate table per read (N entries each), as index bookkeeping
        // rather than FP32 weights.
        expect(loweredStats.gatherBytes).toBeGreaterThan(0)
        expect(loweredStats.gatherBytes).toBeLessThanOrEqual(
          4 * slotCount * (readCount + 1) + 16 * readCount + 4,
        )
      }
    }
  })

  test('lowered and dense programs agree with the reference across selections', () => {
    const slotCount = 128
    const readCount = 4
    const {circuit, reads, valueCell} = buildLibraryCircuit(slotCount, readCount)
    const lowered = circuit.compileTensorProgram(reads, true)
    const plain = circuit.compileTensorProgram(reads, false)
    const source = new Float32Array(circuit.sourceSize)
    for (const selectedSlot of [0, 1, 63, 64, 126, 127]) {
      fillLibrarySource(source, slotCount, readCount, selectedSlot)
      const reference = circuit.evaluateReference(source)
      circuit.tensorProgram = lowered
      const tensorLowered = circuit.evaluateTensor(source)
      circuit.tensorProgram = plain
      const tensorPlain = circuit.evaluateTensor(source)
      for (let field = 0; field < readCount; field++) {
        const read = reads[field]!
        expect(reference[read]).toBe(source[valueCell(field, selectedSlot)])
        expect(sameNumericValue(tensorLowered[read]!, reference[read]!)).toBe(true)
        expect(sameNumericValue(tensorPlain[read]!, reference[read]!)).toBe(true)
      }
    }
  })
})

// Randomized differential exactness: thousands of seeded circuits containing
// one-hot groups of every supported origin (declared source bits, declared
// after the reads were built, emitArgmax, emitFirstActive), masked reads in
// every orientation emitMultiply produces, chained gathers, deduplicated
// reads, decoy sums that must not lower, and downstream consumers. Every wire
// of every circuit is compared across the reference evaluator, the tensor
// program with lowering, and the tensor program without lowering.
describe('seeded circuits', () => {
  type GroupKind = 'declaredBefore' | 'declaredAfter' | 'argmax' | 'firstActive'

  type BuiltGroup = {
    kind: GroupKind
    members: readonly Wire[]
    allowAllZero: boolean
    // Source cells the sampler writes to steer this group.
    controlStart: number
    controlCount: number
  }

  const extremeValues = [
    3.4028234663852886e38,
    -3.4028234663852886e38,
    1.1754943508222875e-38,
    1.401298464324817e-45,
    -0,
    0,
    16_777_216,
    -16_777_217,
    2.5,
    -0.1,
  ] as const

  test('seeded circuits with gathers match the reference on every wire', () => {
    const random = createRandom(0x6a7 << 12 | 0x3e5)
    const circuitCount = 3_000
    const samplesPerCircuit = 3
    let totalReads = 0
    let totalDecoys = 0
    let chainedReads = 0
    let chainedCandidatePicks = 0
    let pairFormCircuits = 0
    let allowAllZeroGroups = 0
    let comparedWires = 0

    for (let circuitIndex = 0; circuitIndex < circuitCount; circuitIndex++) {
      const groupCount = 1 + randomInteger(random, 2)
      const groupPlans: {kind: GroupKind, size: number}[] = []
      for (let group = 0; group < groupCount; group++) {
        const kind = (['declaredBefore', 'declaredAfter', 'argmax', 'firstActive'] as const)[
          randomInteger(random, 4)
        ]!
        const size = randomInteger(random, 20) === 0
          ? 17
          : 1 + randomInteger(random, 9)
        groupPlans.push({kind, size})
      }

      // Source layout: per group, `size` control cells (bits or scores), then
      // shared value pools: nonneg, signed, and extreme-range cells.
      const nonnegCount = 6
      const signedCount = 6
      const extremeCount = 4
      let sourceSize = 0
      const controlStarts: number[] = []
      for (const plan of groupPlans) {
        controlStarts.push(sourceSize)
        sourceSize += plan.size
      }
      const nonnegStart = sourceSize
      sourceSize += nonnegCount
      const signedStart = sourceSize
      sourceSize += signedCount
      const extremeStart = sourceSize
      sourceSize += extremeCount
      const unitCell = sourceSize
      sourceSize += 1

      const circuit = new Circuit(sourceSize)
      const unitWire = circuit.source(unitCell)
      for (let cell = 0; cell < nonnegCount; cell++) {
        circuit.assumeRange(circuit.source(nonnegStart + cell), 0, 1e6)
      }
      for (let cell = 0; cell < signedCount; cell++) {
        circuit.assumeRange(circuit.source(signedStart + cell), -1e6, 1e6)
      }
      for (let cell = 0; cell < extremeCount; cell++) {
        circuit.assumeRange(
          circuit.source(extremeStart + cell),
          -3.4028234663852886e38,
          3.4028234663852886e38,
        )
      }
      circuit.assumeRange(unitWire, 1, 1)

      // Build the groups. declaredAfter groups postpone their declaration until
      // after the reads exist, so emitMultiply sees bits of unknown range and
      // takes its mixed-sign path against signed values.
      const groups: BuiltGroup[] = []
      const lateDeclarations: {members: readonly Wire[], allowAllZero: boolean}[] = []
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
        const plan = groupPlans[groupIndex]!
        const controlStart = controlStarts[groupIndex]!
        const controls = Array.from({length: plan.size}, (_, cell) => circuit.source(controlStart + cell))
        if (plan.kind === 'argmax') {
          for (const control of controls) circuit.assumeRange(control, 0, 1)
          const winner = emitArgmax(circuit, controls, unitWire)
          groups.push({
            kind: plan.kind,
            members: winner.selected,
            allowAllZero: false,
            controlStart,
            controlCount: plan.size,
          })
        } else if (plan.kind === 'firstActive') {
          for (const control of controls) circuit.assumeRange(control, 0, 1)
          // emitFirstActive declares its selection only for provably exact
          // bits, so the candidates go through boolean atoms first (the sampler
          // writes exact 0/1 into the control cells, which the rounding keeps).
          const selected = emitFirstActive(
            circuit,
            unitWire,
            controls.map(control => circuit.boolean(control)),
          )
          invariant(
            circuit.oneHotGroups.some(group =>
              group.members.length === selected.length
              && group.members.every((member, item) => member === selected[item])),
            'first-active selection over proven bits must declare its group',
          )
          allowAllZeroGroups++
          groups.push({
            kind: plan.kind,
            members: selected,
            allowAllZero: true,
            controlStart,
            controlCount: plan.size,
          })
        } else {
          const allowAllZero = randomInteger(random, 3) === 0
          if (plan.kind === 'declaredBefore') {
            circuit.assumeOneHot(controls, allowAllZero)
          } else {
            lateDeclarations.push({members: controls, allowAllZero})
          }
          if (allowAllZero) allowAllZeroGroups++
          groups.push({
            kind: plan.kind,
            members: controls,
            allowAllZero,
            controlStart,
            controlCount: plan.size,
          })
        }
      }

      // Value pool: direct sources plus derived wires. Small derived affines get
      // inlined into the product reglus, exercising the recognizer's resolution
      // through the deduplication map. Derived values stay well inside FP32 so
      // candidates are always finite, which is the lowering contract; the
      // extreme cells are used directly, where finiteness is guaranteed.
      const valuePool: Wire[] = []
      for (let cell = 0; cell < nonnegCount; cell++) valuePool.push(circuit.source(nonnegStart + cell))
      for (let cell = 0; cell < signedCount; cell++) valuePool.push(circuit.source(signedStart + cell))
      for (let cell = 0; cell < extremeCount; cell++) valuePool.push(circuit.source(extremeStart + cell))
      for (let derived = 0; derived < 3; derived++) {
        valuePool.push(circuit.affine([
          [circuit.source(nonnegStart + randomInteger(random, nonnegCount)), 0.5],
          [circuit.source(signedStart + randomInteger(random, signedCount)), 0.25],
        ], randomInteger(random, 5) - 2))
      }
      valuePool.push(emitMultiply(
        circuit,
        circuit.source(nonnegStart + randomInteger(random, nonnegCount)),
        circuit.source(signedStart + randomInteger(random, signedCount)),
      ))

      const readWires = new Set<Wire>()
      const decoyWires = new Set<Wire>()
      const pickValue = () => valuePool[randomInteger(random, valuePool.length)]!
      let usedPairForm = false
      for (const group of groups) {
        const readCount = 1 + randomInteger(random, 3)
        for (let read = 0; read < readCount; read++) {
          const bias = randomInteger(random, 3) === 0 ? randomInteger(random, 7) - 3 : 0
          const candidates = Array.from({length: group.members.length}, pickValue)
          // Chaining is counted by actual use: a candidate that is itself an
          // earlier read makes this a gather feeding a gather.
          let pickedReadCandidates = 0
          for (const candidate of candidates) {
            if (readWires.has(candidate)) pickedReadCandidates++
          }
          chainedCandidatePicks += pickedReadCandidates
          if (pickedReadCandidates > 0) chainedReads++
          const sum = circuit.affine(
            group.members.map((bit, position) => [
              emitMultiply(circuit, bit, candidates[position]!),
              1,
            ]),
            bias,
          )
          if (group.kind === 'declaredAfter'
              && candidates.some(candidate => !circuit.isNonNegative(candidate))) {
            usedPairForm = true
          }
          // A sum of one unbiased term aliases back to the product; only real
          // sum operations are lowering candidates.
          if (sum >= circuit.sourceSize
              && circuit.operations[sum - circuit.sourceSize]!.kind === 'affine') {
            readWires.add(sum)
          }
          // Occasionally the read joins the value pool, where later picks can
          // chain on it. Only sums with finite stored ranges are eligible:
          // reads built before their group's declaration compute their range
          // from then-unbounded bit ranges, and the finiteness rule correctly
          // refuses such wires as candidates of a later gather.
          const sumRange = circuit.ranges[sum]!
          if (randomInteger(random, 3) === 0
              && Number.isFinite(sumRange.minimum)
              && Number.isFinite(sumRange.maximum)) {
            valuePool.push(sum)
          }
        }

        // One decoy per group: a sum that is nearly the idiom but must stay
        // dense. Its value is still compared for exactness.
        const decoyKind = randomInteger(random, 3)
        if (group.members.length >= 2) {
          const candidates = Array.from({length: group.members.length}, pickValue)
          const terms: [Wire, number][] = group.members.map((bit, position) => [
            emitMultiply(circuit, bit, candidates[position]!),
            1,
          ])
          if (decoyKind === 0) terms[randomInteger(random, terms.length)]![1] = 0.5
          else if (decoyKind === 1) terms.pop()
          else terms.push([pickValue(), 1])
          decoyWires.add(circuit.affine(terms))
          totalDecoys++
        }
      }
      for (const declaration of lateDeclarations) {
        circuit.assumeOneHot(declaration.members, declaration.allowAllZero, {allowExistingReaders: true})
      }
      if (usedPairForm) pairFormCircuits++

      // Downstream consumers of the reads keep the gathers feeding real work.
      const readList = [...readWires]
      if (readList.length >= 2) {
        emitMaximum(circuit, readList[0]!, readList[1]!)
        emitMinimum(circuit, readList[0]!, readList[readList.length - 1]!)
      }

      validateCircuit(circuit)
      const lowered = circuit.compileTensorProgram(undefined, true)
      const plain = circuit.compileTensorProgram(undefined, false)
      validateTensorProgram(circuit, lowered)
      validateTensorProgram(circuit, plain)
      const statistics = gatherStatistics(lowered)
      // Every built read lowers; decoys never do. Other operations may lower
      // too (a mixed-sign multiply against a size-1 group is itself a complete
      // masked read), which the wire-by-wire comparison below still verifies.
      const loweredWireSet = loweredWires(lowered)
      for (const read of readWires) {
        if (!loweredWireSet.has(read)) {
          throw new Error(`circuit ${circuitIndex}: read wire ${read} did not lower`)
        }
      }
      for (const decoy of decoyWires) {
        if (loweredWireSet.has(decoy)) {
          throw new Error(`circuit ${circuitIndex}: decoy wire ${decoy} lowered`)
        }
      }
      expect(gatherStatistics(plain).readCount).toBe(0)
      totalReads += statistics.readCount

      for (let sample = 0; sample < samplesPerCircuit; sample++) {
        const source = new Float32Array(sourceSize)
        source[unitCell] = 1
        for (const group of groups) {
          if (group.kind === 'argmax') {
            for (let cell = 0; cell < group.controlCount; cell++) {
              source[group.controlStart + cell] = Math.fround(random())
            }
          } else if (group.kind === 'firstActive') {
            for (let cell = 0; cell < group.controlCount; cell++) {
              source[group.controlStart + cell] = randomInteger(random, 3) === 0 ? 1 : 0
            }
          } else {
            const inactive = group.allowAllZero && randomInteger(random, 4) === 0
            if (!inactive) {
              source[group.controlStart + randomInteger(random, group.controlCount)] = 1
            }
          }
        }
        for (let cell = 0; cell < nonnegCount; cell++) {
          source[nonnegStart + cell] = Math.fround(random() * 1e6)
        }
        for (let cell = 0; cell < signedCount; cell++) {
          source[signedStart + cell] = Math.fround(random() * 2e6 - 1e6)
        }
        for (let cell = 0; cell < extremeCount; cell++) {
          source[extremeStart + cell] =
            extremeValues[randomInteger(random, extremeValues.length)]!
        }

        const reference = circuit.evaluateReference(source)
        validateOneHotGroups(circuit, reference)
        circuit.tensorProgram = lowered
        const tensorLowered = circuit.evaluateTensor(source)
        circuit.tensorProgram = plain
        const tensorPlain = circuit.evaluateTensor(source)
        for (let wire = 0; wire < reference.length; wire++) {
          comparedWires++
          if (!sameNumericValue(tensorLowered[wire]!, reference[wire]!)) {
            throw new Error(
              `circuit ${circuitIndex} sample ${sample} wire ${wire}: `
                + `lowered ${tensorLowered[wire]} vs reference ${reference[wire]}`,
            )
          }
          if (!sameNumericValue(tensorPlain[wire]!, reference[wire]!)) {
            throw new Error(
              `circuit ${circuitIndex} sample ${sample} wire ${wire}: `
                + `plain ${tensorPlain[wire]} vs reference ${reference[wire]}`,
            )
          }
        }
      }
    }

    // The suite must actually have exercised what it claims to cover. Chained
    // coverage counts actual use: reads with at least one candidate that is
    // itself an earlier read, and the number of such candidate picks.
    expect(totalReads).toBeGreaterThan(4_000)
    expect(totalDecoys).toBeGreaterThan(1_500)
    expect(chainedReads).toBeGreaterThan(300)
    expect(chainedCandidatePicks).toBeGreaterThan(400)
    expect(pairFormCircuits).toBeGreaterThan(100)
    expect(allowAllZeroGroups).toBeGreaterThan(300)
    expect(comparedWires).toBeGreaterThan(500_000)
    console.log(
      `[differential] circuits=${circuitCount} reads=${totalReads} decoys=${totalDecoys}`
        + ` chainedReads=${chainedReads} chainedCandidatePicks=${chainedCandidatePicks}`
        + ` pairFormCircuits=${pairFormCircuits}`
        + ` allowAllZeroGroups=${allowAllZeroGroups} comparedWires=${comparedWires}`,
    )
  })
})

// HandwiredOS declares finite pixel ranges and one-hot groups, yet none of its sums
// lowers to a gather read, which this test pins. The program of the repo whose
// masked sums do lower is the candidate gallery:
// lab/candidate-gallery/gather-lowering.test.ts pins its 26 gather reads and checks
// the lowered program against the reference evaluator on every wire across an
// interaction trace. tests/handwiredos/oracle-trace.test.ts does the latter for
// HandwiredOS.
describe('HandwiredOS', () => {
  test('window-manager declares its stacking order as 6 one-hot groups, and none of its sums lowers', () => {
    const machine = createWindowManagerMachine()
    const {circuit} = machine
    const statistics = gatherStatistics(machine.tensorProgram)
    const dense = circuit.compileTensorProgram(Array.from(machine.tensorProgram.roots, asWire), false)
    // The source table declares the 3 stack rows and 3 stack columns as one-hot
    // groups with cells.ts's permutation. A sum over a group of 3 has 3 terms, which
    // the builder copies into each operation that reads the sum, so the
    // frontmost-window selection sums stay dense (execution-model.md's "One-hot
    // groups and gathers"). With four windows, until October 13, 2026, they lowered
    // to 12 gather reads. The photo gallery's click selection gates on a product
    // that is not a provably exact bit, so it declares nothing. Monitor's list
    // (value-list.ts) declares no group: only the table's validator checks its three
    // location bits.
    expect(circuit.oneHotGroups.length).toBe(6)
    expect(statistics.readCount).toBe(0)
    expect(statistics.slotCount).toBe(0)
    // So the compiled program is the dense compile of the same roots.
    expect(statistics.storedWeightCount).toBe(gatherStatistics(dense).storedWeightCount)
    expect(machine.tensorProgram.valueCount).toBe(dense.valueCount)
    expect(machine.tensorProgram.layers.length).toBe(dense.layers.length)
  })
})

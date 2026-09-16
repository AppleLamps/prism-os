import {describe, expect, test} from 'bun:test'
import {
  Circuit,
  type Wire,
  emitArgmax,
  emitFirstActive,
  emitMaximum,
  emitMultiply,
  inlineCircuit,
  validateOneHotGroups,
  validateTensorProgram,
} from '../../numeric-ui-core.ts'
import {type CompiledProgram, gatherStatistics, sameNumericValue} from './measure.ts'

// Unit-level coverage of the recognition algorithm: which sums lower, which
// must not, and how recognition behaves under the builder's own rewrites
// (affine inlining, expression deduplication, constant folding). Every lowered
// case is also checked bit-for-bit against the reference evaluator.

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
  const bits = Array.from({length: slotCount}, (_, slot) => slot)
  const values = Array.from({length: slotCount}, (_, slot) => slotCount + slot)
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
  const bits = Array.from({length: slotCount}, (_, slot) => slot)
  const values = Array.from({length: slotCount}, (_, slot) => slotCount + slot)
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
  const bits = Array.from({length: slotCount}, (_, slot) => slot)
  const values = Array.from({length: slotCount}, (_, slot) => slotCount + slot)
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
    const bits = Array.from({length: slotCount}, (_, slot) => slot)
    circuit.assumeOneHot(bits)
    for (let slot = 0; slot < slotCount; slot++) {
      circuit.assumeRange(slotCount + slot, 0, 4096)
    }
    circuit.assumeRange(slotCount * 2, 0, 4096)
    const terms: [Wire, number][] = bits.map((bit, slot) => [
      emitMultiply(circuit, bit, slotCount + slot),
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
      terms.push([circuit.affine([[slotCount * 2, 1]], 5), 1])
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
  circuit.assumeOneHot([0, 1])
  circuit.assumeOneHot([2, 3])
  for (let value = 4; value < 8; value++) circuit.assumeRange(value, 0, 100)
  const read = circuit.affine([
    [emitMultiply(circuit, 0, 4), 1],
    [emitMultiply(circuit, 1, 5), 1],
    [emitMultiply(circuit, 2, 6), 1],
    [emitMultiply(circuit, 3, 7), 1],
  ])
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
  circuit.assumeOneHot([0, 1])
  circuit.assumeRange(2, -100, 100)
  circuit.assumeRange(3, -100, 100)
  const read = circuit.affine([
    [circuit.reglu([[0, 1]], 0, [[2, 1]], 0), 1],
    [circuit.reglu([[1, 1]], 0, [[3, 1]], 0), 1],
  ])
  const {lowered} = compileBoth(circuit, [read])
  expect(gatherStatistics(lowered).readCount).toBe(0)
  expectExact(circuit, lowered, Float32Array.from([0, 1, 7, -9]))
})

test('a size-1 group lowers its biased read and aliases its bare read', () => {
  const circuit = new Circuit(2)
  circuit.assumeOneHot([0])
  circuit.assumeRange(1, 0, 100)
  const product = emitMultiply(circuit, 0, 1)
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
  const bits = Array.from({length: slotCount}, (_, slot) => slot)
  circuit.assumeOneHot(bits)
  const reads: Wire[] = []
  for (let field = 0; field < readCount; field++) {
    const values = Array.from(
      {length: slotCount},
      (_, slot) => slotCount + field * slotCount + slot,
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
  const firstBits = [0, 1, 2, 3]
  const firstValues = [4, 5, 6, 7]
  const secondBits = [8, 9]
  const plainValue = 10
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
  const bits = Array.from({length: slotCount}, (_, slot) => slot)
  circuit.assumeOneHot(bits, true)
  for (let slot = 0; slot < slotCount; slot++) {
    circuit.assumeRange(slotCount + slot, 0, 4096)
  }
  const read = circuit.affine(
    bits.map((bit, slot) => [emitMultiply(circuit, bit, slotCount + slot), 1]),
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
  const unit = scoreCount + scoreCount
  const circuit = new Circuit(scoreCount + scoreCount + 1)
  for (let score = 0; score < scoreCount; score++) circuit.assumeRange(score, 0, 1)
  for (let value = scoreCount; value < unit; value++) circuit.assumeRange(value, 0, 4096)
  circuit.assumeRange(unit, 1, 1)
  const winner = emitArgmax(
    circuit,
    Array.from({length: scoreCount}, (_, score) => score),
    unit,
  )
  const read = circuit.affine(winner.selected.map((bit, candidate) => [
    emitMultiply(circuit, bit, scoreCount + candidate),
    1,
  ]))
  const {lowered} = compileBoth(circuit, [read, ...winner.selected])
  expect(gatherStatistics(lowered).readCount).toBe(1)

  for (const scores of [[0.2, 0.9, 0.5], [0.9, 0.2, 0.5], [0.5, 0.5, 0.5], [0.1, 0.2, 0.9]]) {
    const source = Float32Array.from([...scores, 17.5, 23.25, 31.125, 1])
    const reference = expectExact(circuit, lowered, source)
    const winnerIndex = winner.selected.findIndex(bit => reference[bit] === 1)
    expect(reference[read]).toBe(source[scoreCount + winnerIndex])
  }
})

test('emitArgmax declares its group; emitFirstActive only for proven bits', () => {
  const circuit = new Circuit(5)
  for (let wire = 0; wire < 4; wire++) circuit.assumeRange(wire, 0, 1)
  circuit.assumeRange(4, 1, 1)
  // Argmax declares unconditionally: fractional scores only feed the boolean
  // comparisons, and the tournament still routes the unit down one path.
  const winner = emitArgmax(circuit, [0, 1, 2], 4)
  expect(circuit.oneHotGroups.length).toBe(1)
  expect(circuit.oneHotGroups[0]!.members).toEqual(winner.selected)
  expect(circuit.oneHotGroups[0]!.allowAllZero).toBe(false)

  // A 0..1 range admits fractional values, so this selection is not provably
  // one-hot and must stay undeclared.
  emitFirstActive(circuit, 3, [0, 1, 2])
  expect(circuit.oneHotGroups.length).toBe(1)

  // Boolean atoms produce exact bits, and the unit wire's range pins it to 1,
  // so this selection is provably one-hot-or-all-zero and declares itself.
  const bits = [circuit.boolean(0), circuit.boolean(1), circuit.boolean(2)]
  const selected = emitFirstActive(circuit, 4, bits)
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
  for (const wire of [0, 1, 2]) circuit.assumeRange(wire, 0, 1)
  for (const wire of [3, 4]) circuit.assumeRange(wire, 0, 1000)
  const selected = emitFirstActive(circuit, 0, [1, 2])
  const read = circuit.affine(selected.map((bit, item) => [
    emitMultiply(circuit, bit, 3 + item),
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
  circuit.assumeRange(0, 1, 1)
  const zero = circuit.affine([])
  const selected = emitFirstActive(circuit, 0, [zero, zero])
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
    const bits = [0, 1]
    if (declareBitsFirst) circuit.assumeOneHot(bits)
    circuit.assumeRange(2, valueRange[0], valueRange[1])
    circuit.assumeRange(3, valueRange[0], valueRange[1])
    const read = circuit.affine(bits.map((bit, item) => [
      emitMultiply(circuit, bit, 2 + item),
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
    circuit.assumeOneHot([0, 1])
    circuit.assumeRange(2, 0, 100)
    circuit.assumeRange(3, 0, 100)
    circuit.assumeRange(4, 0, fillerMaximum)
    const read = circuit.affine([
      [emitMultiply(circuit, 0, 2), 1],
      [emitMultiply(circuit, 1, 3), 1],
      // The filler shape: fround(x * max(0, -bit)), a signed zero for exact
      // bits but NaN when x is infinite.
      [circuit.reglu([[4, 1]], 0, [[0, -1]], 0), 1],
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
    circuit.assumeOneHot([0, 1], allowAllZero)
    circuit.assumeRange(2, -10, 10)
    circuit.assumeRange(3, 0, 10)
    const read = circuit.affine([
      [emitMultiply(circuit, 0, 2), 1],
      [emitMultiply(circuit, 1, 3), 1],
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
  child.assumeOneHot([0, 1], true)
  for (const value of [2, 3]) child.assumeRange(value, 0, 100)
  const childRead = child.affine([
    [emitMultiply(child, 0, 2), 1],
    [emitMultiply(child, 1, 3), 1],
  ])
  const parent = new Circuit(5)
  for (const wire of [1, 2]) parent.assumeRange(wire, 0, 1)
  for (const wire of [3, 4]) parent.assumeRange(wire, 0, 100)
  const wireMap = inlineCircuit(parent, child, [1, 2, 3, 4])

  expect(parent.oneHotGroups.length).toBe(1)
  expect(parent.oneHotGroups[0]!.members).toEqual([1, 2])
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
    const bits = Array.from({length: slotCount}, (_, slot) => slot)
    circuit.assumeOneHot(bits)
    for (let slot = 0; slot < slotCount; slot++) {
      circuit.assumeRange(slotCount + slot, -3.4028234663852886e38, 3.4028234663852886e38)
    }
    const read = circuit.affine(
      bits.map((bit, slot) => [emitMultiply(circuit, bit, slotCount + slot), 1]),
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

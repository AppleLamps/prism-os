import {expect, test} from 'bun:test'
import {
  Circuit,
  type Wire,
  emitArgmax,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  invariant,
  validateCircuit,
  validateOneHotGroups,
  validateTensorProgram,
} from '../../numeric-ui-core.ts'
import {
  createRandom,
  gatherStatistics,
  loweredWires,
  randomInteger,
  sameNumericValue,
} from './measure.ts'

// Randomized differential exactness: thousands of seeded circuits containing
// one-hot groups of every supported origin (declared source bits, declared
// after the reads were built, emitArgmax, emitFirstActive), masked reads in
// every orientation emitMultiply produces, chained gathers, deduplicated
// reads, decoy sums that must not lower, and downstream consumers. Every wire
// of every circuit is compared across the reference evaluator, the tensor
// program with lowering, and the tensor program without lowering.

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
  const circuitCount = 2_000
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
    const unitWire = sourceSize
    sourceSize += 1

    const circuit = new Circuit(sourceSize)
    for (let cell = 0; cell < nonnegCount; cell++) {
      circuit.assumeRange(nonnegStart + cell, 0, 1e6)
    }
    for (let cell = 0; cell < signedCount; cell++) {
      circuit.assumeRange(signedStart + cell, -1e6, 1e6)
    }
    for (let cell = 0; cell < extremeCount; cell++) {
      circuit.assumeRange(
        extremeStart + cell,
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
      if (plan.kind === 'argmax') {
        for (let cell = 0; cell < plan.size; cell++) {
          circuit.assumeRange(controlStart + cell, 0, 1)
        }
        const winner = emitArgmax(
          circuit,
          Array.from({length: plan.size}, (_, cell) => controlStart + cell),
          unitWire,
        )
        groups.push({
          kind: plan.kind,
          members: winner.selected,
          allowAllZero: false,
          controlStart,
          controlCount: plan.size,
        })
      } else if (plan.kind === 'firstActive') {
        for (let cell = 0; cell < plan.size; cell++) {
          circuit.assumeRange(controlStart + cell, 0, 1)
        }
        // emitFirstActive declares its selection only for provably exact
        // bits, so the candidates go through boolean atoms first (the sampler
        // writes exact 0/1 into the control cells, which the rounding keeps).
        const selected = emitFirstActive(
          circuit,
          unitWire,
          Array.from({length: plan.size}, (_, cell) => circuit.boolean(controlStart + cell)),
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
        const members = Array.from({length: plan.size}, (_, cell) => controlStart + cell)
        const allowAllZero = randomInteger(random, 3) === 0
        if (plan.kind === 'declaredBefore') {
          circuit.assumeOneHot(members, allowAllZero)
        } else {
          lateDeclarations.push({members, allowAllZero})
        }
        if (allowAllZero) allowAllZeroGroups++
        groups.push({
          kind: plan.kind,
          members,
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
    for (let cell = 0; cell < nonnegCount; cell++) valuePool.push(nonnegStart + cell)
    for (let cell = 0; cell < signedCount; cell++) valuePool.push(signedStart + cell)
    for (let cell = 0; cell < extremeCount; cell++) valuePool.push(extremeStart + cell)
    for (let derived = 0; derived < 3; derived++) {
      valuePool.push(circuit.affine([
        [nonnegStart + randomInteger(random, nonnegCount), 0.5],
        [signedStart + randomInteger(random, signedCount), 0.25],
      ], randomInteger(random, 5) - 2))
    }
    valuePool.push(emitMultiply(
      circuit,
      nonnegStart + randomInteger(random, nonnegCount),
      signedStart + randomInteger(random, signedCount),
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
      circuit.assumeOneHot(declaration.members, declaration.allowAllZero)
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
    const lowered_ = loweredWires(lowered)
    for (const read of readWires) {
      if (!lowered_.has(read)) {
        throw new Error(`circuit ${circuitIndex}: read wire ${read} did not lower`)
      }
    }
    for (const decoy of decoyWires) {
      if (lowered_.has(decoy)) {
        throw new Error(`circuit ${circuitIndex}: decoy wire ${decoy} lowered`)
      }
    }
    expect(gatherStatistics(plain).readCount).toBe(0)
    totalReads += statistics.readCount

    for (let sample = 0; sample < samplesPerCircuit; sample++) {
      const source = new Float32Array(sourceSize)
      source[unitWire] = 1
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

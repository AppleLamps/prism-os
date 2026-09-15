import {expect, test} from 'bun:test'
import {emitFloorDivide, SourceLayout} from './constructions.ts'
import {
  compileModes,
  compileWith,
  countWireMismatches,
  createRandom,
  programStatistics,
  randomInteger,
} from './measure.ts'
import {validateIndexReads, validateOneHotGroups, validateTensorProgram} from './numeric-ui-core.ts'
import {
  buildFilteredList,
  buildLineRecovery,
  buildPhotoStrip,
  buildTableRead,
  buildThumbnailTargets,
  buildVariableRowList,
  buildVirtualList,
  type PretextFixture,
  referenceFilteredList,
  referencePhotoStrip,
  referenceVariableRowList,
  referenceVirtualList,
  thumbnailFields,
} from './workloads.ts'

// Small versions of report.ts's workloads, checked against plain JS references
// and against pretext's own results, through the one-hot construction (lowered)
// and through the index read instruction.

const fixture = await Bun.file(new URL('./pretext-fixture.json', import.meta.url)).json() as PretextFixture

function expectOutputs(actual: ArrayLike<number>, expected: readonly number[], label: string) {
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== Math.fround(expected[index]!)) {
      throw new Error(`${label}: output ${index} is ${actual[index]}, expected ${Math.fround(expected[index]!)}`)
    }
  }
}

test('floor division of integer scroll offsets is exact, where a rounded reciprocal misses rows', () => {
  // floor(fround(fround(1 / 41) * 41)) is 0, not 1.
  expect(Math.floor(Math.fround(Math.fround(1 / 41) * 41))).toBe(0)
  const random = createRandom(11)
  for (const divisor of [1, 3, 28, 30, 41, 97, 1000]) {
    const layout = new SourceLayout()
    const numerator = layout.cell(0, 0, 2 ** 21)
    const circuit = layout.createCircuit()
    const quotient = emitFloorDivide(circuit, numerator, divisor)
    const evaluate = circuit.createTensorEvaluator([quotient])
    const samples = [0, 1, divisor - 1, divisor, divisor + 1, 2 ** 21, 2 ** 21 - 1]
    for (let trial = 0; trial < 2000; trial++) {
      const multiple = randomInteger(random, Math.floor(2 ** 21 / divisor)) * divisor
      samples.push(multiple, Math.max(0, multiple - 1), Math.min(2 ** 21, multiple + 1), randomInteger(random, 2 ** 21))
    }
    for (const value of samples) {
      expect(evaluate(Float32Array.from([value]))[0]).toBe(Math.floor(value / divisor))
    }
  }
})

test('values[index] over 64 entries: every construction reads the entry and the index read is one operation', () => {
  const count = 64
  const oneHot = buildTableRead(count, 'one-hot')
  const instruction = buildTableRead(count, 'instruction')
  const programs = [
    ...[compileModes.dense, compileModes.gather, compileModes.lowered].map(mode =>
      ({circuit: oneHot.circuit, program: compileWith(oneHot.circuit, oneHot.roots, mode)})),
    {circuit: instruction.circuit, program: instruction.circuit.compileTensorProgram(instruction.roots)},
  ]
  expect(programStatistics(programs[2]!.program).liveOperations).toBe(1)
  expect(programStatistics(programs[3]!.program).liveOperations).toBe(1)
  for (let index = 0; index < count; index++) {
    const source = oneHot.layout.table()
    source[oneHot.index] = index
    for (const {circuit, program} of programs) {
      const {mismatches, reference} = countWireMismatches(circuit, program, source)
      expect(mismatches).toBe(0)
      expect(reference[circuit === oneHot.circuit ? oneHot.read : instruction.read]).toBe(index)
    }
  }
})

test('line recovery at 63 segments matches pretext through the lowered one-hot and the index read', () => {
  const sample = fixture.samples[0]!
  expect(sample.segmentCount).toBe(63)
  for (const formulation of ['sequential', 'jumping'] as const) {
    for (const construction of ['one-hot', 'instruction'] as const) {
      const built = buildLineRecovery(sample, fixture.lineFitEpsilon, construction, formulation)
      const program = compileWith(built.circuit, built.roots, compileModes.all)
      validateTensorProgram(built.circuit, program)
      const statistics = programStatistics(program)
      if (construction === 'one-hot') expect(statistics.bitComputes).toBe(0)
      const evaluate = built.circuit.createTensorEvaluator(built.roots, true, compileModes.all.options)
      const table = built.layout.table()
      for (const [width, lineCount, maxLineWidth] of sample.stats.filter((_, index) => index % 8 === 0)) {
        table[built.maxWidth] = width
        const output = evaluate(table)
        expect(output[0], `${formulation} ${construction} lineCount at ${width}`).toBe(lineCount)
        expect(output[1], `${formulation} ${construction} maxLineWidth at ${width}`).toBe(Math.fround(maxLineWidth))
        if (formulation === 'sequential') expect(output[2]).toBe(0)
      }
      if (formulation === 'sequential') {
        for (const {width, starts, widths} of sample.lines) {
          table[built.maxWidth] = width
          const output = evaluate(table)
          for (let line = 0; line < starts.length; line++) {
            expect(output[3 + line * 2]).toBe(starts[line]!)
            expect(output[4 + line * 2]).toBe(Math.fround(widths[line]!))
          }
        }
      }
      for (const width of [sample.minimumWidth, 200.125, sample.maximumWidth]) {
        table[built.maxWidth] = width
        const {mismatches, reference} = countWireMismatches(built.circuit, program, table)
        expect(mismatches).toBe(0)
        if (construction === 'one-hot') validateOneHotGroups(built.circuit, reference)
        else validateIndexReads(built.circuit, reference)
      }
    }
  }
})

test('a fixed-height virtual list of 300 rows fills 8 slots exactly, both ways', () => {
  const options = {rowCount: 300, fieldCount: 3, slotCount: 8, rowHeight: 28}
  const random = createRandom(5)
  const oneHot = buildVirtualList(options, 'one-hot')
  const instruction = buildVirtualList(options, 'instruction')
  const oneHotProgram = compileWith(oneHot.circuit, oneHot.roots, compileModes.lowered)
  const instructionProgram = instruction.circuit.compileTensorProgram(instruction.roots)
  expect(programStatistics(oneHotProgram).indexComputes).toBe(1)
  expect(programStatistics(instructionProgram).candidateTableEntries).toBe(0)
  const evaluateOneHot = oneHot.circuit.createTensorEvaluator(oneHot.roots, true, compileModes.lowered.options)
  const evaluateInstruction = instruction.circuit.createTensorEvaluator(instruction.roots)
  const maximum = (options.rowCount - 1) * options.rowHeight
  const scrollTops = [0, 1, 27, 28, 29, 280, maximum - 1, maximum]
  for (let trial = 0; trial < 100; trial++) scrollTops.push(randomInteger(random, maximum + 1))
  for (const scrollTop of scrollTops) {
    const expected = referenceVirtualList(options, scrollTop)
    const oneHotSource = oneHot.layout.table()
    oneHotSource[oneHot.scrollTop] = scrollTop
    expectOutputs(evaluateOneHot(oneHotSource), expected, `one-hot at ${scrollTop}`)
    const instructionSource = instruction.layout.table()
    instructionSource[instruction.scrollTop] = scrollTop
    expectOutputs(evaluateInstruction(instructionSource), expected, `instruction at ${scrollTop}`)
  }
  const source = instruction.layout.table()
  source[instruction.scrollTop] = 4321
  expect(countWireMismatches(instruction.circuit, instructionProgram, source).mismatches).toBe(0)
  const denseSource = oneHot.layout.table()
  denseSource[oneHot.scrollTop] = 4321
  expect(countWireMismatches(oneHot.circuit, oneHotProgram, denseSource).mismatches).toBe(0)
})

test('a variable-height list of 300 rows: counting and binary search find the same first row', () => {
  const options = {rowCount: 300, fieldCount: 2, slotCount: 6, rowHeight: 0}
  const random = createRandom(9)
  const variants = [
    buildVariableRowList(options, 'one-hot', 'count'),
    buildVariableRowList(options, 'instruction', 'count'),
    buildVariableRowList(options, 'instruction', 'binary-search'),
  ]
  const total = variants[0]!.total
  const evaluators = variants.map(variant =>
    variant.circuit.createTensorEvaluator(variant.roots, true, compileModes.lowered.options))
  expect(programStatistics(compileWith(variants[2]!.circuit, variants[2]!.roots, compileModes.all)).layers).toBeLessThan(60)
  const scrollTops = [0, 1, total - 1]
  for (let trial = 0; trial < 150; trial++) scrollTops.push(randomInteger(random, total))
  for (const scrollTop of scrollTops) {
    const expected = referenceVariableRowList(options, scrollTop)
    variants.forEach((variant, index) => {
      const source = variant.layout.table()
      source[variant.scrollTop] = scrollTop
      // Also land exactly on and just before a row top.
      expectOutputs(evaluators[index]!(source), expected, `variant ${index} at ${scrollTop}`)
      const onTop = source[variant.scrollTop + 1 + 57]!
      source[variant.scrollTop] = onTop
      expectOutputs(evaluators[index]!(source), referenceVariableRowList(options, onTop), `variant ${index} on a top`)
      source[variant.scrollTop] = onTop - 1
      expectOutputs(evaluators[index]!(source), referenceVariableRowList(options, onTop - 1), `variant ${index} before a top`)
    })
  }
  for (const variant of variants) {
    const source = variant.layout.table()
    source[variant.scrollTop] = 1234
    expect(countWireMismatches(variant.circuit, compileWith(variant.circuit, variant.roots, compileModes.all), source).mismatches).toBe(0)
  }
})

test('a filtered list of 100 items into 10 slots: compaction and binary search over prefix counts agree', () => {
  const itemCount = 100
  const slotCount = 10
  const random = createRandom(13)
  const variants = (['one-hot', 'instruction'] as const).map(construction => {
    const built = buildFilteredList(itemCount, slotCount, construction)
    const program = compileWith(built.circuit, built.roots, compileModes.all)
    validateTensorProgram(built.circuit, program)
    return {built, program, evaluate: built.circuit.createTensorEvaluator(built.roots, true, compileModes.all.options)}
  })
  for (let trial = 0; trial < 300; trial++) {
    const density = trial % 10 === 0 ? 0 : random() * 0.4
    const pattern = Array.from({length: itemCount}, () => (random() < density ? 1 : 0))
    const expected = referenceFilteredList(itemCount, slotCount, pattern)
    for (const {built, program, evaluate} of variants) {
      const source = built.layout.table()
      pattern.forEach((bit, item) => { source[built.visible[item]!] = bit })
      expectOutputs(evaluate(source), expected, `trial ${trial}`)
      if (trial % 50 === 0) expect(countWireMismatches(built.circuit, program, source).mismatches).toBe(0)
    }
  }
})

test('a photo strip of 40 photos centers the focused photo, with focus as bits, as a relu one-hot, and as an index', () => {
  const photoCount = 40
  for (const construction of ['source-one-hot', 'one-hot', 'instruction'] as const) {
    const built = buildPhotoStrip(photoCount, construction)
    const program = compileWith(built.circuit, built.roots, compileModes.all)
    validateTensorProgram(built.circuit, program)
    const evaluate = built.circuit.createTensorEvaluator(built.roots, true, compileModes.all.options)
    for (let focused = 0; focused < photoCount; focused++) {
      for (const [stripHeight, viewportWidth, gap] of [[120, 1280, 12], [333, 1917, 7]] as const) {
        const source = built.layout.table()
        if (construction === 'source-one-hot') {
          for (let photo = 0; photo < photoCount; photo++) source[built.focus[photo]!] = photo === focused ? 1 : 0
        } else {
          source[built.focus[0]!] = focused
        }
        source[built.stripHeight] = stripHeight
        source[built.viewportWidth] = viewportWidth
        source[built.gap] = gap
        expectOutputs(
          evaluate(source),
          referencePhotoStrip(photoCount, focused, stripHeight, viewportWidth, gap),
          `${construction} focused ${focused}`,
        )
        if (focused % 13 === 0) expect(countWireMismatches(built.circuit, program, source).mismatches).toBe(0)
      }
    }
  }
})

test('thumbnail strip targets of 12 and 40 photos: constants per focus and a table read agree', () => {
  for (const photoCount of [12, 40]) {
    for (const construction of ['source-one-hot-constants', 'instruction'] as const) {
      const built = buildThumbnailTargets(photoCount, construction)
      const evaluate = built.circuit.createTensorEvaluator(built.roots)
      for (let focused = 0; focused < photoCount; focused++) {
        const source = built.layout.table()
        if (construction === 'instruction') {
          source[built.focus[0]!] = focused
        } else {
          for (let photo = 0; photo < photoCount; photo++) source[built.focus[photo]!] = photo === focused ? 1 : 0
        }
        const expected: number[] = []
        for (let item = 0; item < photoCount; item++) expected.push(...thumbnailFields(item, focused, photoCount))
        expectOutputs(evaluate(source), expected, `${construction} ${photoCount} focused ${focused}`)
      }
    }
  }
})

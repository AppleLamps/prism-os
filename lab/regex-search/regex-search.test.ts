// Compares the form of the program that stays in this folder, form (c), with the two plain JavaScript references: the
// automaton simulator and the RegExp test of every substring. Hand-written expectations come first, so a mistake
// shared by the program and the references fails too. Form (a), which JSON search runs, has the same tests in
// tests/json-search/regex/regex-search.test.ts, and both files draw their cases, patterns and texts from
// tests/json-search/regex/test-patterns.ts.
import {expect, test} from 'bun:test'
import {type Circuit, validateGrids, validateIndexReads, validateNoNaN} from '../../src/runtime/numeric-ui-core.ts'
import {type DataCapacity, buildDataSearch, writePattern} from '../../src/json-search/regex/data-program.ts'
import {codePointsOf, matchesFromBits, writeText} from '../../src/json-search/regex/host.ts'
import {capacityErrors, compilePattern} from '../../src/json-search/regex/pattern.ts'
import {automatonMatches, regexpMatches} from '../../tests/json-search/regex/reference.ts'
import {boundaryText, createRandom, fullText, handWrittenCases, pairs, randomNode, randomText} from '../../tests/json-search/regex/test-patterns.ts'
import {augmentedLeaves, prefixNetworkPlan, productTreeInputs, runPlanInJavaScript} from './tree-inputs.ts'
import {buildTreeSearch, createTreeSearch} from './tree-program.ts'

const smallCapacity: DataCapacity = {states: 8, classes: 6, boundaries: 12, textLength: 16}

test('edge cases: form (c) finds the hand-written matches', () => {
  const trees = [createTreeSearch(smallCapacity), createTreeSearch(smallCapacity, 'sklansky')]
  for (const [pattern, text, expected] of handWrittenCases) {
    const compiled = compilePattern(pattern)
    const codePoints = codePointsOf(text)
    expect(capacityErrors(compiled, smallCapacity)).toEqual([])
    const treeOutputs = trees.map(tree => {
      tree.setPattern(compiled)
      return tree.run(codePoints)
    })
    // The tree program with Brent-Kung and with Sklansky.
    const versions = treeOutputs.map(output => matchesFromBits(output.highlighted, output.starts)).map(pairs)
    for (const matches of versions) expect([pattern, text, matches]).toEqual([pattern, text, expected])
  }
})

test('random patterns and texts: form (c) matches RegExp', () => {
  const random = createRandom(20260917)
  const tree = createTreeSearch(smallCapacity)
  let fitting = 0
  let texts = 0
  let matches = 0
  for (let patternIndex = 0; patternIndex < 400; patternIndex++) {
    const pattern = randomNode(random, 3).source
    const compiled = compilePattern(pattern)
    const fits = capacityErrors(compiled, smallCapacity).length === 0
    if (fits) {
      tree.setPattern(compiled)
      fitting++
    }
    const patternTexts = [
      ...Array.from({length: 4}, () => codePointsOf(randomText(random, smallCapacity.textLength))),
      ...Array.from({length: 2}, () => boundaryText(random, compiled, smallCapacity.textLength)),
    ]
    for (const codePoints of patternTexts) {
      const expected = pairs(regexpMatches(pattern, codePoints))
      if (fits) {
        const treeOutput = tree.run(codePoints)
        expect([pattern, codePoints, pairs(matchesFromBits(treeOutput.highlighted, treeOutput.starts))]).toEqual([pattern, codePoints, expected])
        expect(treeOutput.matchCount).toBe(expected.length)
      }
      texts++
      matches += expected.length
    }
  }
  // The random patterns must mostly fit the small program, and the texts must mostly contain matches.
  expect(fitting).toBeGreaterThan(250)
  expect(matches).toBeGreaterThan(texts)
})

// Every wire holds a value within its range, declared or inferred. Form (c) declares 0..textLength on the operations that
// hold ends, which only this check tests.
function validateRanges(circuit: Circuit, values: Float32Array) {
  circuit.ranges.forEach(({minimum, maximum}, wire) => {
    if (!(values[wire]! >= minimum && values[wire]! <= maximum)) throw new Error(`wire ${wire} holds ${values[wire]}, outside ${minimum}..${maximum}`)
  })
}

test('declarations hold in form (c): index reads read integers, grids and ranges hold, and nothing is NaN', () => {
  const random = createRandom(7)
  const searches = [createTreeSearch(smallCapacity), createTreeSearch(smallCapacity, 'sklansky')]
  let checked = 0
  while (checked < 60) {
    const compiled = compilePattern(randomNode(random, 3).source)
    if (capacityErrors(compiled, smallCapacity).length > 0) continue
    const codePoints = codePointsOf(randomText(random, smallCapacity.textLength))
    for (const search of searches) {
      search.setPattern(compiled)
      writeText(search.source, search.built.cells.text, codePoints)
      const {circuit} = search.built
      const values = circuit.evaluateReference(search.source)
      validateIndexReads(circuit, values)
      validateGrids(circuit, values)
      validateNoNaN(circuit, values)
      validateRanges(circuit, values)
    }
    checked++
  }
})

// The clamped product of (S + 1) × (S + 1) 0/1 matrices, row by row.
function clampedProduct(left: Uint8Array, right: Uint8Array, size: number) {
  const product = new Uint8Array(size * size)
  for (let from = 0; from < size; from++) {
    for (let middle = 0; middle < size; middle++) {
      if (left[from * size + middle] === 0) continue
      for (let to = 0; to < size; to++) product[from * size + to] ||= right[middle * size + to]!
    }
  }
  return product
}

test('form (c)\'s longest ends equal the loop in tree-inputs.ts, both plans in JavaScript, form (a)\'s reverse pass, and the augmented 0/1 products', () => {
  const random = createRandom(31)
  const capacity: DataCapacity = {states: 8, classes: 6, boundaries: 12, textLength: 13}
  const networks = ['brent-kung', 'sklansky'] as const
  const trees = networks.map(network => buildTreeSearch(capacity, network))
  const data = buildDataSearch(capacity)
  const plans = networks.map(network => prefixNetworkPlan(capacity.textLength, network))
  let checked = 0
  while (checked < 80) {
    const compiled = compilePattern(randomNode(random, 3).source)
    if (capacityErrors(compiled, capacity).length > 0) continue
    const codePoints = random() < 0.5 ? codePointsOf(randomText(random, capacity.textLength)) : boundaryText(random, compiled, capacity.textLength)
    const inputs = productTreeInputs(compiled, codePoints, capacity)
    for (const plan of plans) expect([compiled.pattern, [...runPlanInJavaScript(inputs, plan)]]).toEqual([compiled.pattern, [...inputs.longestEnds]])
    for (const tree of trees) {
      const source = new Float32Array(tree.initialSource)
      writePattern(source, tree, compiled)
      writeText(source, tree.cells.text, codePoints)
      const values = tree.circuit.evaluateReference(source)
      expect([compiled.pattern, tree.longestEnds.flatMap(ends => ends.map(wire => values[wire]))]).toEqual([compiled.pattern, [...inputs.longestEnds]])
    }
    const dataSource = new Float32Array(data.initialSource)
    writePattern(dataSource, data, compiled)
    writeText(dataSource, data.cells.text, codePoints)
    const dataValues = data.circuit.evaluateReference(dataSource)
    const dataReach = data.notReachAt.flatMap(notReach => notReach.map(bit => typeof bit === 'boolean' ? Number(!bit) : 1 - dataValues[bit]!))
    expect([compiled.pattern, dataReach]).toEqual([compiled.pattern, [...inputs.reach]])
    // The last column of A[j] × … × A[N - 1] holds the reach bits at j.
    const size = capacity.states + 1
    const augmented = augmentedLeaves(inputs)
    let suffixProduct: Uint8Array | undefined
    for (let position = capacity.textLength - 1; position >= 0; position--) {
      const leaf = augmented.subarray(position * size * size, (position + 1) * size * size)
      suffixProduct = suffixProduct === undefined ? leaf : clampedProduct(leaf, suffixProduct, size)
      const lastColumn = Array.from({length: capacity.states}, (_, state) => suffixProduct![state * size + capacity.states])
      expect([compiled.pattern, position, lastColumn]).toEqual([compiled.pattern, position, [...inputs.reach.subarray(position * capacity.states, (position + 1) * capacity.states)]])
    }
    checked++
  }
})

test('random patterns at capacity and full texts: form (c) with both networks matches RegExp', () => {
  const random = createRandom(4242)
  // A text length that isn't a power of two, so both networks have incomplete blocks.
  const capacity: DataCapacity = {states: 16, classes: 8, boundaries: 16, textLength: 37}
  const trees = [createTreeSearch(capacity), createTreeSearch(capacity, 'sklansky')]
  let patterns = 0
  let matches = 0
  while (patterns < 30) {
    const pattern = randomNode(random, 4).source
    const compiled = compilePattern(pattern)
    if (compiled.automaton.stateCount <= 8 || capacityErrors(compiled, capacity).length > 0) continue
    for (const tree of trees) tree.setPattern(compiled)
    for (const codePoints of [fullText(random, capacity.textLength), fullText(random, capacity.textLength), boundaryText(random, compiled, capacity.textLength)]) {
      const expected = pairs(regexpMatches(pattern, codePoints))
      for (const output of trees.map(tree => tree.run(codePoints))) {
        expect([pattern, codePoints, pairs(matchesFromBits(output.highlighted, output.starts))]).toEqual([pattern, codePoints, expected])
      }
      matches += expected.length
    }
    patterns++
  }
  expect(matches).toBeGreaterThan(90)
}, 60_000)

test('form (c) at 32 states, 16 classes and 32 boundaries, over 16 code points, with a match on the last cell', () => {
  const capacity = {states: 32, classes: 16, boundaries: 32, textLength: 16}
  const tree = createTreeSearch(capacity)
  const pattern = '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? '
  const compiled = compilePattern(pattern)
  tree.setPattern(compiled)
  const codePoints = codePointsOf('a cat, these ox ')
  expect(codePoints.length).toBe(16)
  const expected = pairs(regexpMatches(pattern, codePoints))
  expect(expected).toEqual([[7, 16]])
  const output = tree.run(codePoints)
  expect(pairs(matchesFromBits(output.highlighted, output.starts))).toEqual(expected)
}, 60_000)

test('form (c) at 1, 2, 3 and 17 code points with both networks: edge patterns and texts match the automaton simulator, and every range holds', () => {
  // Text lengths where Math.max(1, ceil(log2 N)) sets the jump levels, where a network has no combine or one, and one past
  // a power of two.
  const patterns = ['a', 'a*', '[^]*', '.+', 'a|ab', 'a+b|a', '(ab|a)(bc|c)*', '[^a]+', 'x|', 'a?b?c?', 'a(xa)*', '.*x']
  for (const textLength of [1, 2, 3, 17]) {
    const capacity: DataCapacity = {states: 8, classes: 8, boundaries: 16, textLength}
    const trees = [createTreeSearch(capacity), createTreeSearch(capacity, 'sklansky')]
    const repeated = (unit: string) => codePointsOf(unit.repeat(textLength)).slice(0, textLength)
    const texts = [[], repeated('a'), repeated('ab'), repeated('aab'), repeated('xa'), [...repeated('x').slice(1), 97], repeated('a😀'), codePointsOf('ba')]
    for (const pattern of patterns) {
      const compiled = compilePattern(pattern)
      expect([pattern, capacityErrors(compiled, capacity)]).toEqual([pattern, []])
      for (const tree of trees) {
        tree.setPattern(compiled)
        for (const codePoints of texts.map(text => text.slice(0, textLength))) {
          const expected = pairs(automatonMatches(compiled, codePoints))
          const output = tree.run(codePoints)
          const label = [pattern, tree.built.network, codePoints]
          expect([label, pairs(matchesFromBits(output.highlighted, output.starts)), output.matchCount]).toEqual([label, expected, expected.length])
          const {circuit} = tree.built
          const values = circuit.evaluateReference(tree.source)
          validateIndexReads(circuit, values)
          validateGrids(circuit, values)
          validateNoNaN(circuit, values)
          validateRanges(circuit, values)
        }
      }
    }
  }
}, 60_000)

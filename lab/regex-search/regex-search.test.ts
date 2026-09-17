// Compares the three programs with the two plain JavaScript references: the automaton simulator and the RegExp test of
// every substring. Hand-written expectations come first, so a mistake shared by every version fails too.
import {expect, test} from 'bun:test'
import {type Circuit, validateGrids, validateIndexReads, validateNoNaN} from '../../src/runtime/numeric-ui-core.ts'
import {createBuiltInSearch} from './builtin-program.ts'
import {type DataCapacity, buildDataSearch, createDataSearch, writePattern} from './data-program.ts'
import {type Match, codePointsOf, matchesFromBits, writeText} from './host.ts'
import {type CompiledPattern, PatternSyntaxError, capacityErrors, compilePattern, maxCodePoint, parsePattern} from './pattern.ts'
import {automatonMatches, regexpMatches} from './reference.ts'
import {augmentedLeaves, prefixNetworkPlan, productTreeInputs, runPlanInJavaScript} from './tree-inputs.ts'
import {buildTreeSearch, createTreeSearch} from './tree-program.ts'

const smallCapacity: DataCapacity = {states: 8, classes: 6, boundaries: 12, textLength: 16}

function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <Item>(random: () => number, items: readonly Item[]) => items[Math.floor(random() * items.length)]!
const pairs = (matches: readonly Match[]) => matches.map(({start, end}) => [start, end])

// Every version's matches for one pattern and text: [data program, built-in program, tree program with Brent-Kung, tree
// program with Sklansky, automaton simulator, RegExp].
function allVersions(pattern: string, text: string, data = createDataSearch(smallCapacity), trees = [createTreeSearch(smallCapacity), createTreeSearch(smallCapacity, 'sklansky')]) {
  const compiled = compilePattern(pattern)
  const codePoints = codePointsOf(text)
  expect(capacityErrors(compiled, data.built.capacity)).toEqual([])
  data.setPattern(compiled)
  const dataOutput = data.run(codePoints)
  const builtInOutput = createBuiltInSearch(compiled, data.built.capacity.textLength).run(codePoints)
  const treeOutputs = trees.map(tree => {
    tree.setPattern(compiled)
    return tree.run(codePoints)
  })
  return [
    matchesFromBits(dataOutput.highlighted, dataOutput.starts),
    matchesFromBits(builtInOutput.highlighted, builtInOutput.starts),
    ...treeOutputs.map(output => matchesFromBits(output.highlighted, output.starts)),
    automatonMatches(compiled, codePoints),
    regexpMatches(pattern, codePoints),
  ].map(pairs)
}

test('edge cases: every version finds the hand-written matches', () => {
  const data = createDataSearch(smallCapacity)
  const trees = [createTreeSearch(smallCapacity), createTreeSearch(smallCapacity, 'sklansky')]
  const cases: [pattern: string, text: string, expected: number[][]][] = [
    ['a', 'baaab', [[1, 2], [2, 3], [3, 4]]], // adjacent matches stay separate
    ['a*', 'baab', [[1, 3]]], // the empty match isn't reported
    ['', 'abc', []],
    ['()*', 'abc', []],
    ['a|ab', 'xabx', [[1, 3]]], // longest, where RegExp's own search returns a
    ['(a|ab)(c|bcd)', 'abcd abc', [[0, 4], [5, 8]]],
    ['a+b|a', 'aaac aab', [[0, 1], [1, 2], [2, 3], [5, 8]]], // a longest match needs code points past its end to decide
    ['aba', 'ababa', [[0, 3]]], // the overlapping aba at 2 isn't reported
    ['a(bc)*', 'abcbcbx', [[0, 5]]],
    ['.+', 'ab\ncd\re f', [[0, 2], [3, 5], [6, 7], [8, 9]]], // . doesn't match line terminators
    ['[^a]+', 'b\ncad', [[0, 3], [4, 5]]], // a negated class does
    ['.', 'a b', [[0, 1], [2, 3]]],
    ['[^a]', '\u{10FFFF}\u{10FFFE}', [[0, 1], [1, 2]]], // up to the last code point
    ['[^\u{10FFFE}]', '\u{10FFFE}\u{10FFFF}', [[1, 2]]], // a negated set whose last interval is only the last code point
    ['.+', '\u{10FFFF}', [[0, 1]]],
    ['\\w+', '-_aZ09-', [[1, 6]]],
    ['\\d+', '/0189:', [[1, 5]]],
    ['😀+', 'x😀😀y😀', [[1, 3], [4, 5]]], // one code point per cell
    ['[]', 'abc', []],
    ['[^]', 'ab', [[0, 1], [1, 2]]],
    ['[^]*', 'ab\nc', [[0, 4]]],
    ['\\d+\\.\\d+', 'pi 3.14, e 2.7.', [[3, 7], [11, 14]]],
    ['[a-c-]+', 'x-ab-cd', [[1, 6]]],
    ['(x|y)*z', 'xxyzyz zz', [[0, 4], [4, 6], [7, 8], [8, 9]]],
    ['abc', 'ab', []], // a match that would run past the end of the text
    ['b+', 'aaaaaaaaaaaaaabb', [[14, 16]]], // a match that ends on the last cell
  ]
  for (const [pattern, text, expected] of cases) {
    for (const matches of allVersions(pattern, text, data, trees)) expect([pattern, text, matches]).toEqual([pattern, text, expected])
  }
})

test('syntax outside the language throws a PatternSyntaxError', () => {
  for (const pattern of ['a**', '*a', 'a{2}', '^a', 'a$', '(a', 'a)', '[a', '[z-a]', '\\q', 'a*?', '(?:a)', '[\\d-a]', 'a\\', ']', 'a|+']) {
    expect(() => parsePattern(pattern)).toThrow(PatternSyntaxError)
  }
  expect(() => parsePattern('a*?')).toThrow('*? is a lazy quantifier')
})

test('capacity errors name what the pattern needs', () => {
  const capacity = {states: 32, classes: 16, boundaries: 32}
  expect(capacityErrors(compilePattern('abcdefghijklmnopqrstuvwxyzABCDEF'), capacity).map(error => error.message)).toEqual([
    'the pattern needs 33 states, and the program holds 32',
    'the pattern needs 32 character classes, and the program holds 16',
    // a..z are neighbors, so their 26 classes need 27 boundaries, and A..F need 7.
    'the pattern needs 34 class boundaries, and the program holds 32',
  ])
  // One class that is 22 separate letters: 1 class, 44 boundaries.
  expect(capacityErrors(compilePattern('[acegikmoqsuwyACEGIKMOQ]'), capacity).map(error => error.reason)).toEqual(['boundaries'])
  expect(capacityErrors(compilePattern('(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? '), capacity)).toEqual([])
  const data = createDataSearch(smallCapacity)
  expect(() => data.setPattern(compilePattern('abcdefgh'))).toThrow('the pattern needs 9 states, and the program holds 8')
  expect(() => writeText(data.source, data.built.cells.text, codePointsOf('a'.repeat(17)))).toThrow('the text has 17 code points, and the program holds 16')
})

// Random patterns over a small alphabet that includes syntax characters, line terminators and an emoji.
type Rendered = {source: string, precedence: 0 | 1 | 2 | 3} // 0 alternation, 1 sequence, 2 repeat, 3 atom or group
const wrap = (node: Rendered, minimum: number) => node.precedence >= minimum ? node.source : `(${node.source})`
const classCharacters = ['a', 'b', 'c', '0', '9', 'é', '😀', '\u{10FFFE}', '\n', '.', '\\-', '\\]']

function randomAtom(random: () => number): Rendered {
  const roll = random()
  if (roll < 0.4) return {source: pick(random, ['a', 'b', 'c', '0', '\\.', '-', '\n', 'é', '😀']), precedence: 3}
  if (roll < 0.52) return {source: '.', precedence: 3}
  if (roll < 0.58) return {source: pick(random, ['\\d', '\\w']), precedence: 3}
  if (roll < 0.62) return {source: '()', precedence: 3}
  const items = Array.from({length: Math.floor(random() * 4)}, () => {
    const low = pick(random, classCharacters)
    if (random() < 0.3 && !low.startsWith('\\')) {
      const high = pick(random, classCharacters.filter(character => !character.startsWith('\\') && character.codePointAt(0)! >= low.codePointAt(0)!))
      return `${low}-${high}`
    }
    return random() < 0.1 ? '\\d' : low
  })
  return {source: `[${random() < 0.3 ? '^' : ''}${items.join('')}]`, precedence: 3}
}

function randomNode(random: () => number, depth: number): Rendered {
  const roll = random()
  if (depth <= 0 || roll < 0.4) return randomAtom(random)
  if (roll < 0.62) return {source: Array.from({length: 2 + Math.floor(random() * 2)}, () => wrap(randomNode(random, depth - 1), 1)).join(''), precedence: 1}
  if (roll < 0.8) return {source: Array.from({length: 2}, () => random() < 0.1 ? '' : wrap(randomNode(random, depth - 1), 1)).join('|'), precedence: 0}
  return {source: wrap(randomNode(random, depth - 1), 3) + pick(random, ['?', '*', '+']), precedence: 2}
}

// '9', 'Z', '_', U+2028, U+2029 and U+10FFFF are where \d, \w, . and negated classes start or stop.
const textAlphabet = ['a', 'b', 'c', '0', '9', 'Z', '_', '-', '.', '\n', '\r', ' ', ' ', 'é', '😀', '\u{10FFFF}', 'x', ' ', ']']
const randomText = (random: () => number, maximumLength: number) =>
  Array.from({length: Math.floor(random() * (maximumLength + 1))}, () => pick(random, textAlphabet)).join('')

// A text of the code points just below, at and above each of the pattern's class boundaries, plus 0 and U+10FFFF, e.g.
// for [a-c]+, a text over `, a, b, c, d, NUL and U+10FFFF.
function boundaryText(random: () => number, {partition}: CompiledPattern, length: number) {
  const nearBoundaries = [0, maxCodePoint, ...partition.boundaries.flatMap(boundary => [boundary - 1, boundary, boundary + 1])]
    .filter(codePoint => codePoint <= maxCodePoint)
  return Array.from({length}, () => pick(random, nearBoundaries))
}

test('random patterns and texts: every program matches both references', () => {
  const random = createRandom(20260917)
  const data = createDataSearch(smallCapacity)
  const tree = createTreeSearch(smallCapacity)
  let fitting = 0
  let texts = 0
  let matches = 0
  for (let patternIndex = 0; patternIndex < 400; patternIndex++) {
    const pattern = randomNode(random, 3).source
    const compiled = compilePattern(pattern)
    const builtIn = createBuiltInSearch(compiled, smallCapacity.textLength)
    const fits = capacityErrors(compiled, smallCapacity).length === 0
    if (fits) {
      data.setPattern(compiled)
      tree.setPattern(compiled)
      fitting++
    }
    const patternTexts = [
      ...Array.from({length: 4}, () => codePointsOf(randomText(random, smallCapacity.textLength))),
      ...Array.from({length: 2}, () => boundaryText(random, compiled, smallCapacity.textLength)),
    ]
    for (const codePoints of patternTexts) {
      const expected = pairs(regexpMatches(pattern, codePoints))
      expect([pattern, codePoints, pairs(automatonMatches(compiled, codePoints))]).toEqual([pattern, codePoints, expected])
      const builtInOutput = builtIn.run(codePoints)
      expect([pattern, codePoints, pairs(matchesFromBits(builtInOutput.highlighted, builtInOutput.starts))]).toEqual([pattern, codePoints, expected])
      if (fits) {
        const dataOutput = data.run(codePoints)
        expect([pattern, codePoints, pairs(matchesFromBits(dataOutput.highlighted, dataOutput.starts))]).toEqual([pattern, codePoints, expected])
        expect(dataOutput.matchCount).toBe(expected.length)
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

test('declarations hold: index reads read integers, grids and ranges hold, and nothing is NaN', () => {
  const random = createRandom(7)
  const searches = [createDataSearch(smallCapacity), createTreeSearch(smallCapacity), createTreeSearch(smallCapacity, 'sklansky')]
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

// A text of exactly `length` code points over the random text alphabet.
const fullText = (random: () => number, length: number) => Array.from({length}, () => codePointsOf(pick(random, textAlphabet))[0]!)

test('random patterns at capacity and full texts: form (c) with both networks matches forms (a) and (b) and both references', () => {
  const random = createRandom(4242)
  // A text length that isn't a power of two, so both networks have incomplete blocks.
  const capacity: DataCapacity = {states: 16, classes: 8, boundaries: 16, textLength: 37}
  const data = createDataSearch(capacity)
  const trees = [createTreeSearch(capacity), createTreeSearch(capacity, 'sklansky')]
  let patterns = 0
  let matches = 0
  while (patterns < 30) {
    const pattern = randomNode(random, 4).source
    const compiled = compilePattern(pattern)
    if (compiled.automaton.stateCount <= 8 || capacityErrors(compiled, capacity).length > 0) continue
    data.setPattern(compiled)
    for (const tree of trees) tree.setPattern(compiled)
    const builtIn = createBuiltInSearch(compiled, capacity.textLength)
    for (const codePoints of [fullText(random, capacity.textLength), fullText(random, capacity.textLength), boundaryText(random, compiled, capacity.textLength)]) {
      const expected = pairs(regexpMatches(pattern, codePoints))
      expect([pattern, codePoints, pairs(automatonMatches(compiled, codePoints))]).toEqual([pattern, codePoints, expected])
      for (const output of [data.run(codePoints), builtIn.run(codePoints), ...trees.map(tree => tree.run(codePoints))]) {
        expect([pattern, codePoints, pairs(matchesFromBits(output.highlighted, output.starts))]).toEqual([pattern, codePoints, expected])
      }
      matches += expected.length
    }
    patterns++
  }
  expect(matches).toBeGreaterThan(90)
}, 60_000)

test('random strings of syntax characters: whatever parsePattern accepts, RegExp accepts and matches the same way', () => {
  const random = createRandom(99)
  const alphabet = ['a', 'b', '(', ')', '[', ']', '|', '*', '+', '?', '.', '^', '-', '\\', 'd', 'w', '{', '}', 'é', '$']
  let accepted = 0
  for (let index = 0; index < 20_000; index++) {
    const pattern = Array.from({length: Math.floor(random() * 9)}, () => pick(random, alphabet)).join('')
    let compiled
    try {
      compiled = compilePattern(pattern)
    } catch (error) {
      expect(error).toBeInstanceOf(PatternSyntaxError)
      continue
    }
    expect(() => new RegExp(`^(?:${pattern})$`, 'u')).not.toThrow()
    const codePoints = codePointsOf(randomText(random, 10).replaceAll('c', 'd'))
    expect([pattern, pairs(automatonMatches(compiled, codePoints))]).toEqual([pattern, pairs(regexpMatches(pattern, codePoints))])
    accepted++
  }
  expect(accepted).toBeGreaterThan(2_000)
})

test('the largest capacity at 256 code points: 32 states, 16 classes and 32 boundaries, with a match on the last cell', () => {
  const capacity = {states: 32, classes: 16, boundaries: 32, textLength: 256}
  const data = createDataSearch(capacity)
  // 31 atoms and 13 classes.
  const pattern = '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? '
  const compiled = compilePattern(pattern)
  expect([compiled.automaton.stateCount, compiled.partition.classCount]).toEqual([32, 13])
  data.setPattern(compiled)
  const words = 'the cat sat on some mats, this dog barked at these cats and an owl hooted. that '
  const codePoints = codePointsOf(words.repeat(4).slice(0, 256 - 'this word '.length) + 'this word ')
  expect(codePoints.length).toBe(256)
  const expected = pairs(regexpMatches(pattern, codePoints))
  expect(expected.at(-1)).toEqual([246, 256])
  const output = data.run(codePoints)
  expect(pairs(matchesFromBits(output.highlighted, output.starts))).toEqual(expected)
  const builtInOutput = createBuiltInSearch(compiled, 256).run(codePoints)
  expect(pairs(matchesFromBits(builtInOutput.highlighted, builtInOutput.starts))).toEqual(expected)
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

// Regex search's program with the pattern as data (data-program.ts), which JSON search's step is built from, against
// the two plain JavaScript references: the automaton simulator and the RegExp test of every substring. Hand-written
// expectations come first, so a mistake shared by every version fails too. Also the pattern language's syntax errors
// and pattern.ts's capacity errors. lab/regex-search/regex-search.test.ts has the same tests for the forms of the
// program that stayed in lab/, over the same cases, patterns and texts (test-patterns.ts).
// Run from the repo root: bun test tests/json-search/regex
import {expect, test} from 'bun:test'
import {type Circuit, validateGrids, validateIndexReads, validateNoNaN} from '../../../src/runtime/numeric-ui-core.ts'
import {type DataCapacity, createDataSearch} from '../../../src/json-search/regex/data-program.ts'
import {codePointsOf, matchesFromBits, writeText} from '../../../src/json-search/regex/host.ts'
import {PatternSyntaxError, capacityErrors, compilePattern, parsePattern} from '../../../src/json-search/regex/pattern.ts'
import {automatonMatches, regexpMatches} from './reference.ts'
import {boundaryText, createRandom, fullText, handWrittenCases, pairs, pick, randomNode, randomText} from './test-patterns.ts'

const smallCapacity: DataCapacity = {states: 8, classes: 6, boundaries: 12, textLength: 16}

test('edge cases: the program and both references find the hand-written matches', () => {
  const data = createDataSearch(smallCapacity)
  for (const [pattern, text, expected] of handWrittenCases) {
    const compiled = compilePattern(pattern)
    const codePoints = codePointsOf(text)
    expect(capacityErrors(compiled, data.built.capacity)).toEqual([])
    data.setPattern(compiled)
    const dataOutput = data.run(codePoints)
    // The program, the automaton simulator and RegExp.
    const versions = [matchesFromBits(dataOutput.highlighted, dataOutput.starts), automatonMatches(compiled, codePoints), regexpMatches(pattern, codePoints)].map(pairs)
    for (const matches of versions) expect([pattern, text, matches]).toEqual([pattern, text, expected])
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

test('random patterns and texts: the program matches both references', () => {
  const random = createRandom(20260917)
  const data = createDataSearch(smallCapacity)
  let fitting = 0
  let texts = 0
  let matches = 0
  for (let patternIndex = 0; patternIndex < 400; patternIndex++) {
    const pattern = randomNode(random, 3).source
    const compiled = compilePattern(pattern)
    const fits = capacityErrors(compiled, smallCapacity).length === 0
    if (fits) {
      data.setPattern(compiled)
      fitting++
    }
    const patternTexts = [
      ...Array.from({length: 4}, () => codePointsOf(randomText(random, smallCapacity.textLength))),
      ...Array.from({length: 2}, () => boundaryText(random, compiled, smallCapacity.textLength)),
    ]
    for (const codePoints of patternTexts) {
      const expected = pairs(regexpMatches(pattern, codePoints))
      expect([pattern, codePoints, pairs(automatonMatches(compiled, codePoints))]).toEqual([pattern, codePoints, expected])
      if (fits) {
        const dataOutput = data.run(codePoints)
        expect([pattern, codePoints, pairs(matchesFromBits(dataOutput.highlighted, dataOutput.starts))]).toEqual([pattern, codePoints, expected])
        expect(dataOutput.matchCount).toBe(expected.length)
      }
      texts++
      matches += expected.length
    }
  }
  // The random patterns must mostly fit the small program, and the texts must mostly contain matches.
  expect(fitting).toBeGreaterThan(250)
  expect(matches).toBeGreaterThan(texts)
})

// Every wire holds a value within its range, declared or inferred.
function validateRanges(circuit: Circuit, values: Float32Array) {
  circuit.ranges.forEach(({minimum, maximum}, wire) => {
    if (!(values[wire]! >= minimum && values[wire]! <= maximum)) throw new Error(`wire ${wire} holds ${values[wire]}, outside ${minimum}..${maximum}`)
  })
}

test('declarations hold: index reads read integers, grids and ranges hold, and nothing is NaN', () => {
  const random = createRandom(7)
  const search = createDataSearch(smallCapacity)
  let checked = 0
  while (checked < 60) {
    const compiled = compilePattern(randomNode(random, 3).source)
    if (capacityErrors(compiled, smallCapacity).length > 0) continue
    const codePoints = codePointsOf(randomText(random, smallCapacity.textLength))
    search.setPattern(compiled)
    writeText(search.source, search.built.cells.text, codePoints)
    const {circuit} = search.built
    const values = circuit.evaluateReference(search.source)
    validateIndexReads(circuit, values)
    validateGrids(circuit, values)
    validateNoNaN(circuit, values)
    validateRanges(circuit, values)
    checked++
  }
})

test('random patterns at capacity and full texts: the program matches both references', () => {
  const random = createRandom(4242)
  // The text length of lab/regex-search's test of form (c), which isn't a power of two.
  const capacity: DataCapacity = {states: 16, classes: 8, boundaries: 16, textLength: 37}
  const data = createDataSearch(capacity)
  let patterns = 0
  let matches = 0
  while (patterns < 30) {
    const pattern = randomNode(random, 4).source
    const compiled = compilePattern(pattern)
    if (compiled.automaton.stateCount <= 8 || capacityErrors(compiled, capacity).length > 0) continue
    data.setPattern(compiled)
    for (const codePoints of [fullText(random, capacity.textLength), fullText(random, capacity.textLength), boundaryText(random, compiled, capacity.textLength)]) {
      const expected = pairs(regexpMatches(pattern, codePoints))
      expect([pattern, codePoints, pairs(automatonMatches(compiled, codePoints))]).toEqual([pattern, codePoints, expected])
      const output = data.run(codePoints)
      expect([pattern, codePoints, pairs(matchesFromBits(output.highlighted, output.starts))]).toEqual([pattern, codePoints, expected])
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
}, 60_000)

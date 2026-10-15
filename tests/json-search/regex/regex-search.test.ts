// JSON search's search program (src/json-search/search-step.ts) against the two plain JavaScript references: the
// automaton simulator and the RegExp test of every substring. The program is the work of one code point, which
// loop-program.ts runs once per position, here on the CPU executor, without a scope, at small capacities. Hand-written
// expectations come first, so a mistake shared by every version fails too. Also the pattern language's syntax errors
// and pattern.ts's capacity errors. The cases, patterns and texts are in test-patterns.ts.
// Run from the repo root: bun test tests/json-search/regex
import {expect, test} from 'bun:test'
import {type Circuit, validateGrids, validateIndexReads, validateNoNaN} from '../../../src/runtime/numeric-ui-core.ts'
import {createLoopRunner} from '../../../src/json-search/loop-program.ts'
import {type CompiledPattern, PatternSyntaxError, type SearchCapacity, capacityErrors, compilePattern, parsePattern} from '../../../src/json-search/regex/pattern.ts'
import {buildSearchLoop} from '../../../src/json-search/search-step.ts'
import {type Match, automatonMatches, regexpMatches} from './reference.ts'
import {boundaryText, codePointsOf, createRandom, fullText, handWrittenCases, pairs, pick, randomNode, randomText} from './test-patterns.ts'

type StepCapacity = SearchCapacity & {textLength: number}
const smallCapacity: StepCapacity = {states: 8, classes: 6, boundaries: 12, textLength: 16}

// The matches that a document's marks describe: 2 at a match's first code point, 1 at its other code points, and 0
// outside a match.
function matchesFromMarks(marks: ArrayLike<number>): Match[] {
  const matches: Match[] = []
  for (let position = 0; position < marks.length; position++) {
    const mark = marks[position]
    if (mark === 2) {
      matches.push({start: position, end: position + 1})
    } else if (mark === 1) {
      const current = matches.at(-1)
      if (current?.end !== position) throw new Error(`position ${position} is marked as inside a match, and no match reaches it`)
      current.end++
    } else if (mark !== 0) {
      throw new Error(`the mark at position ${position} is ${mark}, and a mark is 0, 1 or 2`)
    }
  }
  return matches
}

// The search step for texts of up to `textLength` code points, run over a text's positions on the CPU executor, which
// defines a program's values.
function createStepSearch({textLength, ...capacity}: StepCapacity) {
  const built = buildSearchLoop(capacity, {positions: textLength, cellsPerDocument: textLength + 1, masked: false, stopAtLength: false})
  const runner = createLoopRunner(built.loop, 'executor')
  const shared = new Float32Array(built.loop.sharedValues)
  const cells = new Float32Array(textLength + 1)
  const matchCount = new Float32Array(1)
  const marks = new Float32Array(textLength)
  return {
    built, shared, cells,
    setPattern(compiled: CompiledPattern) {
      built.writePattern(shared, compiled)
      runner.setShared(shared)
    },
    // A document's cells as the step reads them: the code points, -1 in every cell past the text, then the text's length.
    writeText(codePoints: readonly number[]) {
      if (codePoints.length > textLength) throw new Error(`the text has ${codePoints.length} code points, and the program holds ${textLength}`)
      for (let position = 0; position < textLength; position++) cells[position] = codePoints[position] ?? -1
      cells[textLength] = codePoints.length
    },
    run(codePoints: readonly number[]) {
      this.writeText(codePoints)
      runner.run([cells], 0, [matchCount, marks], 0, 0)
      return {matchCount: matchCount[0]!, matches: matchesFromMarks(marks)}
    },
  }
}

test('edge cases: the step and both references find the hand-written matches', () => {
  const step = createStepSearch(smallCapacity)
  for (const [pattern, text, expected] of handWrittenCases) {
    const compiled = compilePattern(pattern)
    const codePoints = codePointsOf(text)
    expect(capacityErrors(compiled, smallCapacity)).toEqual([])
    step.setPattern(compiled)
    const output = step.run(codePoints)
    // The step, the automaton simulator and RegExp.
    const versions = [output.matches, automatonMatches(compiled, codePoints), regexpMatches(pattern, codePoints)].map(pairs)
    for (const matches of versions) expect([pattern, text, matches]).toEqual([pattern, text, expected])
    expect([pattern, text, output.matchCount]).toEqual([pattern, text, expected.length])
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
  // Writing a pattern that doesn't fit into the step's cells throws the same message.
  const step = createStepSearch(smallCapacity)
  expect(() => step.setPattern(compilePattern('abcdefgh'))).toThrow('the pattern needs 9 states, and the program holds 8')
})

test('random patterns and texts: the step matches both references', () => {
  const random = createRandom(20260917)
  const step = createStepSearch(smallCapacity)
  let fitting = 0
  let texts = 0
  let matches = 0
  for (let patternIndex = 0; patternIndex < 400; patternIndex++) {
    const pattern = randomNode(random, 3).source
    const compiled = compilePattern(pattern)
    const fits = capacityErrors(compiled, smallCapacity).length === 0
    if (fits) {
      step.setPattern(compiled)
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
        const output = step.run(codePoints)
        expect([pattern, codePoints, pairs(output.matches)]).toEqual([pattern, codePoints, expected])
        expect(output.matchCount).toBe(expected.length)
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

test('declarations hold at every position: index reads read integers, grids and ranges hold, and nothing is NaN', () => {
  const random = createRandom(7)
  const step = createStepSearch(smallCapacity)
  const {loop} = step.built
  let checked = 0
  let matches = 0
  while (checked < 60) {
    const pattern = randomNode(random, 3).source
    const compiled = compilePattern(pattern)
    if (capacityErrors(compiled, smallCapacity).length > 0) continue
    const codePoints = codePointsOf(randomText(random, smallCapacity.textLength))
    step.setPattern(compiled)
    step.writeText(codePoints)
    // JS: what loop-program.ts's runner does, with circuit.evaluateReference, which computes every operation as built,
    // in place of the compiled stage.
    let registers = loop.registers.map(register => register.initial)
    const fields = loop.fields.map(field => new Float32Array(loop.positions * field.width))
    const marks = Array<number>(loop.positions).fill(0)
    for (const stage of loop.stages) {
      const source = step.shared.slice(stage.sharedOffset, stage.sharedOffset + stage.program.sourceSize)
      const count = stage.repeat === 'once' ? 1 : loop.positions
      for (let index = 0; index < count; index++) {
        const position = stage.repeat === 'backward' ? count - 1 - index : index
        for (const [wire, binding] of stage.bindings) {
          source[wire] = binding.kind === 'item' ? step.cells[position]!
            : binding.kind === 'cell' ? step.cells[binding.column]!
            : binding.kind === 'register' ? registers[binding.register]!
            : fields[binding.field]![position * loop.fields[binding.field]!.width + binding.component]!
        }
        const values = stage.circuit.evaluateReference(source)
        validateIndexReads(stage.circuit, values)
        validateGrids(stage.circuit, values)
        validateNoNaN(stage.circuit, values)
        validateRanges(stage.circuit, values)
        const nextRegisters = [...registers]
        for (const {wire, write} of stage.outputs) {
          if (write.kind === 'register') nextRegisters[write.register] = values[wire]!
          else if (write.kind === 'field') fields[write.field]![position * loop.fields[write.field]!.width + write.component] = values[wire]!
          else if (write.kind === 'position') marks[position] = values[wire]!
          else throw new Error('no stage of the search step writes a document\'s output')
        }
        registers = nextRegisters
      }
    }
    // The values of every operation as built are the references' matches too.
    const expected = pairs(regexpMatches(pattern, codePoints))
    expect([pattern, codePoints, pairs(matchesFromMarks(marks))]).toEqual([pattern, codePoints, expected])
    expect(loop.results.map(result => registers[result.register])).toEqual([expected.length])
    matches += expected.length
    checked++
  }
  expect(matches).toBeGreaterThan(60)
})

test('random patterns at capacity and full texts: the step matches both references', () => {
  const random = createRandom(4242)
  // A text length that isn't a power of two.
  const capacity: StepCapacity = {states: 16, classes: 8, boundaries: 16, textLength: 37}
  const step = createStepSearch(capacity)
  let patterns = 0
  let matches = 0
  while (patterns < 30) {
    const pattern = randomNode(random, 4).source
    const compiled = compilePattern(pattern)
    if (compiled.automaton.stateCount <= 8 || capacityErrors(compiled, capacity).length > 0) continue
    step.setPattern(compiled)
    for (const codePoints of [fullText(random, capacity.textLength), fullText(random, capacity.textLength), boundaryText(random, compiled, capacity.textLength)]) {
      const expected = pairs(regexpMatches(pattern, codePoints))
      expect([pattern, codePoints, pairs(automatonMatches(compiled, codePoints))]).toEqual([pattern, codePoints, expected])
      const output = step.run(codePoints)
      expect([pattern, codePoints, pairs(output.matches)]).toEqual([pattern, codePoints, expected])
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
  const step = createStepSearch(capacity)
  // 31 atoms and 13 classes.
  const pattern = '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? '
  const compiled = compilePattern(pattern)
  expect([compiled.automaton.stateCount, compiled.partition.classCount]).toEqual([32, 13])
  step.setPattern(compiled)
  const words = 'the cat sat on some mats, this dog barked at these cats and an owl hooted. that '
  const codePoints = codePointsOf(words.repeat(4).slice(0, 256 - 'this word '.length) + 'this word ')
  expect(codePoints.length).toBe(256)
  const expected = pairs(regexpMatches(pattern, codePoints))
  expect(expected.at(-1)).toEqual([246, 256])
  const output = step.run(codePoints)
  expect(pairs(output.matches)).toEqual(expected)
  expect(output.matchCount).toBe(expected.length)
}, 60_000)

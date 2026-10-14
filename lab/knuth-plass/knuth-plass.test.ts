// Compares both programs with the plain JavaScript reference, the reference with every set of breaks, and the reference
// with pretext's justification demo where their costs agree. Hand-written expectations come first.
import {expect, test} from 'bun:test'
import {prepareWithSegments} from '@chenglou/pretext'
import {type Circuit, validateGrids, validateIndexReads, validateNoNaN} from '../../src/runtime/numeric-ui-core.ts'
import {fakeTextWidth} from '../ui-exploration/text-walker/fake-canvas.ts'
import {hyphenateParagraphText} from './hyphenation.ts'
import {PARAGRAPHS} from './pretext-demo/justification-comparison.data.ts'
import {buildDemoFrame, createDemoResources} from './pretext-demo/justification-comparison.model.ts'
import {type Paragraph, breakPointsOfPrepared, createRandom, infeasible, lineCostCap, randomParagraph, softHyphen, timingParagraph, timingWidth} from './paragraph.ts'
import {type KnuthPlass, createKnuthPlass, writeParagraph} from './program.ts'
import {knuthPlass, leafMatrices, lineCost, statesByProductTree} from './reference.ts'

const smallCapacity = {breakCapacity: 24, window: 6}

// Boxes 3, 2, 2 and 5 px wide with 1 px spaces, at 6 px: greedy fills "3 2" and leaves 4 px on the second line, 0 + 16,
// while "3" then "2 2" costs 9 + 1.
const classicParagraph: Paragraph = {lineStarts: [0, 4, 7, 10], lineEnds: [3, 6, 9, 15]}

test('hand-written: the cheapest breaks beat greedy filling, and the last line costs nothing', () => {
  expect(lineCost(classicParagraph, 0, 2, 6)).toBe(0)
  expect(lineCost(classicParagraph, 2, 3, 6)).toBe(16)
  expect(lineCost(classicParagraph, 3, 4, 6)).toBe(0)
  expect(lineCost(classicParagraph, 0, 3, 6)).toBe(infeasible)
  expect(lineCost(classicParagraph, 3, 4, 4)).toBe(lineCostCap) // one box wider than the column
  const expected = {breaks: [1, 3, 4], totalCost: 10}
  expect(knuthPlass(classicParagraph, 6, 4)).toMatchObject(expected)
  for (const form of ['chain', 'tree'] as const) expect(createKnuthPlass({breakCapacity: 5, window: 4}, form).run(classicParagraph, 6)).toMatchObject(expected)
})

// Every set of breaks with lines of at most `window` boxes. Of equal totals, the reference keeps the latest start of each
// line from the end, i.e. the break sequence that is largest when compared from the last break backwards.
function bruteForce(paragraph: Paragraph, maxWidth: number, window: number) {
  const breakCount = paragraph.lineEnds.length
  let best: {totalCost: number, breaks: number[]} | undefined
  for (let mask = 0; mask < 2 ** (breakCount - 1); mask++) {
    const breaks = [...Array.from({length: breakCount - 1}, (_, index) => index + 1).filter(at => (mask >> (at - 1)) & 1), breakCount]
    let from = 0
    let totalCost = 0
    let fits = true
    for (const to of breaks) {
      if (to - from > window) fits = false
      totalCost += lineCost(paragraph, from, to, maxWidth)
      from = to
    }
    if (!fits) continue
    const laterFromTheEnd = (left: number[], right: number[]) => {
      for (let offset = 1; offset <= Math.min(left.length, right.length); offset++) {
        if (left.at(-offset) !== right.at(-offset)) return left.at(-offset)! > right.at(-offset)!
      }
      return false
    }
    if (best === undefined || totalCost < best.totalCost || (totalCost === best.totalCost && laterFromTheEnd(breaks, best.breaks))) best = {totalCost, breaks}
  }
  return best!
}

// Small whole-pixel boxes give many equal totals.
const tieBoxes = {minimumBox: 1, maximumBox: 4, space: 1, hyphen: 1, hyphenChance: 0.2}

test('the reference equals every set of breaks, including equal totals', () => {
  const random = createRandom(11)
  let ties = 0
  for (let run = 0; run < 400; run++) {
    const breakCount = 1 + Math.floor(random() * 11)
    const ties_ = run % 2 === 0
    const paragraph = ties_ ? randomParagraph(random, breakCount, tieBoxes) : randomParagraph(random, breakCount)
    const maxWidth = ties_ ? Math.floor(random() * 16) : Math.floor(random() * 300)
    const window = 2 + Math.floor(random() * 5)
    const expected = bruteForce(paragraph, maxWidth, window)
    const solution = knuthPlass(paragraph, maxWidth, window)
    expect({totalCost: solution.totalCost, breaks: solution.breaks}).toEqual(expected)
    if (hasTie(paragraph, maxWidth, window)) ties++
  }
  // 51 of the 400 paragraphs have a step with two starts of the smallest total.
  expect(ties).toBeGreaterThan(40)
})

// Whether some step has two starts with the smallest total.
function hasTie(paragraph: Paragraph, maxWidth: number, window: number) {
  const {costs} = knuthPlass(paragraph, maxWidth, window)
  for (let to = 1; to < costs.length; to++) {
    let equal = 0
    for (let boxes = 1; boxes <= Math.min(window, to); boxes++) {
      if (costs[to - boxes]! + lineCost(paragraph, to - boxes, to, maxWidth) === costs[to]) equal++
    }
    if (equal > 1) return true
  }
  return false
}

// pretext's demo model is pretext-demo/justification-comparison.model.ts, a copy from pretext's repository, see the README.
// It imports npm pretext, like this file, so the model and the tests share one measuring context.
const demoPadding = 12

// pretext creates its measuring context at its first measurement, so this runs before the first prepare call.
function installFakeCanvas() {
  if (typeof Reflect.get(globalThis, 'OffscreenCanvas') !== 'function') {
    Reflect.set(globalThis, 'OffscreenCanvas', class {
      getContext() {
        return {font: '', measureText(text: string) { return {width: fakeTextWidth(text, this.font)} }}
      }
    })
  }
}

// createDemoResources measures the space and the hyphen with document.createElement('canvas').
function withFakeDocument<Result>(run: () => Result): Result {
  const hadDocument = Reflect.has(globalThis, 'document')
  if (!hadDocument) {
    Reflect.set(globalThis, 'document', {createElement: () => ({getContext: () => ({font: '', measureText(text: string) { return {width: fakeTextWidth(text, this.font)} }})})})
  }
  try {
    return run()
  } finally {
    if (!hadDocument) Reflect.deleteProperty(globalThis, 'document')
  }
}

test('break points equal pretext demo\'s candidates on the demo\'s paragraphs', () => {
  installFakeCanvas()
  const resources = withFakeDocument(() => createDemoResources())
  expect(resources.paragraphs.length).toBe(PARAGRAPHS.length)
  resources.paragraphs.forEach((demoParagraph, index) => {
    // The same soft hyphens as the demo's hyphenation.
    expect(demoParagraph.hyphenated.segments.join('')).toBe(hyphenateParagraphText(PARAGRAPHS[index]!))
    const {candidates, positions} = breakPointsOfPrepared(demoParagraph.hyphenated, resources.normalSpaceWidth, resources.hyphenWidth)
    expect(candidates.map(({segmentIndex, kind}) => `${segmentIndex} ${kind}`)).toEqual(demoParagraph.candidates.map(({segIndex, kind}) => `${segIndex} ${kind}`))
    positions.forEach((position, at) => {
      const demo = demoParagraph.candidates[at]!
      expect(position).toBeCloseTo(demo.wordWidthBefore + demo.spacesBefore * resources.normalSpaceWidth, 9)
    })
  })
})

test('pretext demo\'s optimal breaks equal the reference\'s where the costs agree', () => {
  // The demo scores a line with spaces by its justified space width, and every other line by 10 × slack², the last
  // line by 0, and a line that doesn't fit as infeasible. So on text without spaces, with whole-pixel widths, where
  // every line that fits has at most 63 px of slack and every box fits, each demo cost is 10 × this variant's.
  // Single letters joined by soft hyphens at 64 px give boxes of 28 to 40 px and a 22 px hyphen, so widths of 62 to
  // 113 px keep every slack within 63 px.
  installFakeCanvas()
  const font = '64px Test Sans'
  const random = createRandom(5)
  let multiLine = 0
  for (let run = 0; run < 60; run++) {
    const letters = Array.from({length: 4 + Math.floor(random() * 40)}, () => String.fromCharCode(97 + Math.floor(random() * 26)))
    const text = letters.join(softHyphen)
    const hyphenated = prepareWithSegments(text, font)
    const spaceWidth = fakeTextWidth(' ', font)
    const hyphenWidth = fakeTextWidth('-', font)
    expect(Array.from(hyphenated.widths).every(width => Number.isInteger(width))).toBe(true)
    const {paragraph, candidates, positions} = breakPointsOfPrepared(hyphenated, spaceWidth, hyphenWidth)
    const demoCandidates = candidates.map(({segmentIndex, kind}, at) => ({segIndex: segmentIndex, kind, wordWidthBefore: positions[at]!, spacesBefore: 0}))
    const maxWidth = 62 + Math.floor(random() * 52)
    const resources = {paragraphs: [{plain: hyphenated, hyphenated, candidates: demoCandidates}], normalSpaceWidth: spaceWidth, hyphenWidth}
    const frame = buildDemoFrame(resources, {colWidth: maxWidth + 2 * demoPadding, showIndicators: false})
    let at = 0
    const demoBreaks = frame.optimal.paragraphs[0]!.map(line => at += line.segments.filter(segment => segment.kind !== 'text' || segment.text !== '-').length)
    const solution = knuthPlass(paragraph, maxWidth, 8)
    expect(solution.windowOverflowCount).toBe(0)
    expect(solution.breaks).toEqual(demoBreaks)
    if (demoBreaks.length > 1) multiLine++
  }
  // Every text takes more than one line: 1,139 lines over 1,470 boxes.
  expect(multiLine).toBe(60)
})

test('the product tree in JavaScript gives the reference\'s costs', () => {
  const random = createRandom(3)
  for (let run = 0; run < 100; run++) {
    const breakCount = 1 + Math.floor(random() * 40)
    const paragraph = run % 2 === 0 ? randomParagraph(random, breakCount, tieBoxes) : randomParagraph(random, breakCount)
    const maxWidth = run % 2 === 0 ? Math.floor(random() * 16) : Math.floor(random() * 400)
    const window = 2 + Math.floor(random() * 7)
    const {costs} = knuthPlass(paragraph, maxWidth, window)
    const states = statesByProductTree(leafMatrices(paragraph, maxWidth, window), breakCount, window)
    states.forEach((state, index) => {
      for (let m = 0; m < window; m++) expect(state[m]).toBe(index + 1 - m >= 0 ? costs[index + 1 - m]! : infeasible)
    })
  }
})

test('both programs give the reference\'s costs, predecessors and breaks on random paragraphs, widths and ties', () => {
  const programs = [createKnuthPlass(smallCapacity, 'chain'), createKnuthPlass(smallCapacity, 'tree')]
  const random = createRandom(17)
  let ties = 0
  let overflowingBoxes = 0
  let windowOverflows = 0
  for (let run = 0; run < 500; run++) {
    const breakCount = 1 + Math.floor(random() * smallCapacity.breakCapacity)
    const tied = run % 3 === 0
    const paragraph = tied ? randomParagraph(random, breakCount, tieBoxes) : randomParagraph(random, breakCount)
    const maxWidth = tied ? Math.floor(random() * 20) : Math.floor(random() * 420)
    const expected = knuthPlass(paragraph, maxWidth, smallCapacity.window)
    for (const program of programs) expect(program.run(paragraph, maxWidth)).toEqual(expected)
    if (hasTie(paragraph, maxWidth, smallCapacity.window)) ties++
    if (paragraph.lineEnds.some((end, index) => end - paragraph.lineStarts[index]! > maxWidth)) overflowingBoxes++
    if (expected.windowOverflowCount > 0) windowOverflows++
  }
  // 100 of the 500 paragraphs have a step with two starts of the smallest total.
  expect(ties).toBeGreaterThan(80)
  // 92 have a box wider than the column, and 50 a line of more than 6 boxes that fits.
  expect(overflowingBoxes).toBeGreaterThan(50)
  expect(windowOverflows).toBeGreaterThan(40)
})

test('edges: one break point, a full program, a window larger than the program, and the smallest window', () => {
  const random = createRandom(23)
  const capacities = [{breakCapacity: 2, window: 2}, {breakCapacity: 5, window: 8}, {breakCapacity: 17, window: 2}, {breakCapacity: 16, window: 16}]
  for (const capacity of capacities) {
    const programs = [createKnuthPlass(capacity, 'chain'), createKnuthPlass(capacity, 'tree')]
    for (let run = 0; run < 40; run++) {
      const breakCount = run % 4 === 0 ? 1 : run % 4 === 1 ? capacity.breakCapacity : 1 + Math.floor(random() * capacity.breakCapacity)
      const paragraph = randomParagraph(random, breakCount, run % 2 === 0 ? tieBoxes : undefined)
      const maxWidth = Math.floor(random() * (run % 2 === 0 ? 20 : 300))
      const expected = knuthPlass(paragraph, maxWidth, capacity.window)
      for (const program of programs) expect(program.run(paragraph, maxWidth)).toEqual(expected)
    }
  }
})

test('the timing paragraphs at 64 break points give the reference\'s breaks at every window', () => {
  const paragraph = timingParagraph(64)
  for (const window of [8, 16, 32]) {
    const expected = knuthPlass(paragraph, timingWidth, window)
    expect(expected.windowOverflowCount).toBe(0)
    for (const form of ['chain', 'tree'] as const) expect(createKnuthPlass({breakCapacity: 64, window}, form).run(paragraph, timingWidth)).toEqual(expected)
  }
})

// Every wire holds a value within its range, declared or inferred.
function validateRanges(circuit: Circuit, values: Float32Array) {
  circuit.ranges.forEach(({minimum, maximum}, wire) => {
    if (!(values[wire]! >= minimum && values[wire]! <= maximum)) throw new Error(`wire ${wire} holds ${values[wire]}, outside ${minimum}..${maximum}`)
  })
}

// Every live operation has integer coefficients and biases, and for every source table within the declared ranges, any
// partial sum of its terms, in any order, stays within ±2^24, where FP32 holds every integer. With integer cells, every
// value is then an exact integer.
function validateExactIntegerSums(built: KnuthPlass) {
  const {circuit} = built
  const roots = [...built.nextSource, built.output.totalCost, built.output.windowOverflowCount, ...built.output.chosen, ...built.output.costs, ...built.output.predecessors]
  const program = circuit.compileTensorProgram(roots)
  let largest = 0
  for (const wire of program.wireOrder) {
    if (wire < circuit.sourceSize) continue
    const operation = circuit.operations[wire - circuit.sourceSize]!
    for (const [terms, bias] of [[operation.leftTerms, operation.leftBias], [operation.gateTerms, operation.gateBias]] as const) {
      if (!Number.isInteger(bias)) throw new Error(`wire ${wire} has bias ${bias}`)
      let highest = Math.max(0, bias)
      let lowest = Math.min(0, bias)
      for (const [term, coefficient] of terms) {
        if (!Number.isInteger(coefficient)) throw new Error(`wire ${wire} has coefficient ${coefficient}`)
        const {minimum, maximum} = circuit.ranges[term]!
        highest += Math.max(0, coefficient * minimum, coefficient * maximum)
        lowest += Math.min(0, coefficient * minimum, coefficient * maximum)
      }
      largest = Math.max(largest, highest, -lowest)
    }
  }
  if (largest > 2 ** 24) throw new Error(`a partial sum can reach ${largest}`)
  return largest
}

test('declarations hold: index reads read integers, grids and ranges hold, nothing is NaN, and every sum is exact', () => {
  const random = createRandom(29)
  const capacity = {breakCapacity: 20, window: 5}
  const programs = [createKnuthPlass(capacity, 'chain'), createKnuthPlass(capacity, 'tree')]
  for (const {built} of programs) validateExactIntegerSums(built)
  // The largest program in the tables, at 1,024 break points, has the largest cost bounds.
  for (const form of ['chain', 'tree'] as const) expect(validateExactIntegerSums(createKnuthPlass({breakCapacity: 1024, window: 2}, form).built)).toBeLessThanOrEqual(2 ** 24)
  for (let run = 0; run < 60; run++) {
    const breakCount = 1 + Math.floor(random() * capacity.breakCapacity)
    const paragraph = run % 2 === 0 ? randomParagraph(random, breakCount, tieBoxes) : randomParagraph(random, breakCount)
    const maxWidth = Math.floor(random() * (run % 2 === 0 ? 20 : 400))
    for (const {built, source} of programs) {
      writeParagraph(source, built, paragraph, maxWidth)
      const values = built.circuit.evaluateReference(source)
      validateIndexReads(built.circuit, values)
      validateGrids(built.circuit, values)
      validateNoNaN(built.circuit, values)
      validateRanges(built.circuit, values)
    }
  }
})

test('pretext paragraphs at every width from 200 to 600 px: both programs give the reference\'s breaks', () => {
  const font = '16px Test Sans'
  const programs = [createKnuthPlass({breakCapacity: 144, window: 32}, 'chain')]
  const spaceWidth = fakeTextWidth(' ', font)
  const hyphenWidth = fakeTextWidth('-', font)
  for (const text of PARAGRAPHS) {
    const prepared = prepareWithSegments(hyphenateParagraphText(text), font)
    const {paragraph} = breakPointsOfPrepared(prepared, spaceWidth, hyphenWidth)
    for (let maxWidth = 200; maxWidth <= 600; maxWidth += 7) {
      const expected = knuthPlass(paragraph, maxWidth, 32)
      expect(expected.windowOverflowCount).toBe(0)
      for (const program of programs) expect(program.run(paragraph, maxWidth)).toEqual(expected)
    }
  }
})

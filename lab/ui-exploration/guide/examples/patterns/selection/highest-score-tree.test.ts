import {describe, expect, test} from 'bun:test'
import {validateGrids, validateOneHotGroups} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {buildBestLayout, highestScoreReference, type HighestScoreForm} from './highest-score-tree.ts'
import {createBothEvaluators, createRandom, measureProgram, nextFloat32Up} from './kit.ts'

type Variant = readonly [HighestScoreForm, {grid?: number}]

const variants: readonly Variant[] = [
  ['emitArgmax', {}],
  ['exact tree', {}],
  ['exact chain', {}],
  ['exact tree', {grid: 1 / 64}],
  ['exact chain', {grid: 1 / 64}],
]

// Writes scores and widths into a fresh source table for buildBestLayout.
function layoutSource(built: ReturnType<typeof buildBestLayout>, scores: readonly number[], widths: readonly number[]) {
  const source = new Float32Array(built.circuit.sourceSize)
  source[built.unit] = 1
  scores.forEach((score, layout) => {
    source[built.scores[layout]!] = score
    source[built.thumbnailWidths[layout]!] = widths[layout]!
  })
  return source
}

function pickedLayout(form: HighestScoreForm, scores: readonly number[], options: {grid?: number} = {}) {
  const built = buildBestLayout(scores.length, form, options)
  return built.circuit.evaluateReference(layoutSource(built, scores, scores.map(() => 0)))[built.bestLayout]
}

describe('the highest score, in a tree', () => {
  test('every form picks the loop\'s layout on random scores and exact ties, in both evaluators', () => {
    const random = createRandom(21)
    let checks = 0
    let mismatches = 0
    for (const layoutCount of [1, 2, 3, 8, 13]) {
      for (const [form, options] of variants) {
        const built = buildBestLayout(layoutCount, form, options)
        const evaluate = createBothEvaluators(built.circuit, [...built.selected, built.bestLayout, built.chosenThumbnailWidth, built.score])
        for (let trial = 0; trial < 200; trial++) {
          // Scores on the 1/64 grid tie often. Without a grid, half the trials draw from a few values, so they tie too.
          const fewValues = [0, 0.25, 0.3, 0.7, 1]
          const scores = Array.from({length: layoutCount}, () => options.grid !== undefined
            ? Math.round(random() * 64) / 64
            : trial % 2 === 0 ? fewValues[Math.floor(random() * fewValues.length)]! : Math.fround(random()))
          if (trial === 0) scores.fill(scores[0]!)
          const widths = scores.map(() => Math.round(random() * 4096) / 4)
          const {roots, everyWire} = evaluate(layoutSource(built, scores, widths))
          validateOneHotGroups(built.circuit, everyWire)
          if (options.grid !== undefined) validateGrids(built.circuit, everyWire)
          const expected = highestScoreReference(scores)
          const expectedRoots = [
            ...scores.map((_, layout) => layout === expected ? 1 : 0),
            expected,
            widths[expected]!,
            Math.fround(scores[expected]!),
          ]
          if (roots.some((value, index) => value !== expectedRoots[index])) mismatches++
          checks++
        }
      }
    }
    expect(checks).toBe(5_000)
    expect(mismatches).toBe(0)
  })

  test('adjacent FP32 scores: the exact forms match the loop, and emitArgmax keeps the left layout when the right score is up to 2.09e-7 larger', () => {
    const argmax = buildBestLayout(2, 'emitArgmax')
    const exact = buildBestLayout(2, 'exact tree')
    let largestKept = 0
    let smallestLost = Infinity
    let exactMismatches = 0
    for (let left = 0; left <= 1024; left++) {
      const leftScore = Math.fround(left / 1024 - left / 1_000_000)
      for (let steps = 1; steps <= 8; steps++) {
        const rightScore = nextFloat32Up(leftScore, steps)
        if (rightScore > 1) break
        const scores = [leftScore, rightScore]
        const argmaxValues = argmax.circuit.evaluateReference(layoutSource(argmax, scores, [0, 0]))
        if (argmaxValues[argmax.bestLayout] === 0) largestKept = Math.max(largestKept, rightScore - leftScore)
        else smallestLost = Math.min(smallestLost, rightScore - leftScore)
        const exactValues = exact.circuit.evaluateReference(layoutSource(exact, scores, [0, 0]))
        if (exactValues[exact.bestLayout] !== 1) exactMismatches++
      }
    }
    expect(exactMismatches).toBe(0)
    expect(largestKept).toBe(2.086162567138672e-7)
    expect(smallestLost).toBe(1.043081283569336e-7)

    // Four scores within a few FP32 steps of each other, in random order: the exact tree and the exact
    // chain always match the loop, while emitArgmax sometimes doesn't.
    const random = createRandom(22)
    const forms = ['exact tree', 'exact chain', 'emitArgmax'] as const
    const built = forms.map(form => buildBestLayout(4, form))
    const evaluators = built.map(({circuit, selected}) => createBothEvaluators(circuit, selected))
    const mismatches = [0, 0, 0]
    for (let trial = 0; trial < 2_000; trial++) {
      let score = Math.fround(0.2 + 0.7 * random())
      const scores = Array.from({length: 4}, () => {
        score = nextFloat32Up(score, Math.floor(random() * 4))
        return score
      }).sort(() => random() - 0.5)
      const expected = highestScoreReference(scores)
      forms.forEach((_, index) => {
        const {roots} = evaluators[index]!(layoutSource(built[index]!, scores, [0, 0, 0, 0]))
        if (roots.some((bit, layout) => bit !== (layout === expected ? 1 : 0))) mismatches[index]!++
      })
    }
    expect(mismatches[0]).toBe(0)
    expect(mismatches[1]).toBe(0)
    expect(mismatches[2]).toBeGreaterThan(0)
  })

  test('emitArgmax\'s tie band isn\'t transitive, so its tree can pick a different layout from the loop', () => {
    const oneStepUp = nextFloat32Up(0.5, 1)
    const twoStepsUp = nextFloat32Up(0.5, 2)
    // Within the band, the left layout is kept: 0.5 over one step above it, and one step above over two steps above.
    expect(pickedLayout('emitArgmax', [0.5, oneStepUp])).toBe(0)
    expect(pickedLayout('emitArgmax', [oneStepUp, twoStepsUp])).toBe(0)
    // Two steps apart, the right layout is picked.
    expect(pickedLayout('emitArgmax', [0.5, twoStepsUp])).toBe(1)
    const scores = [0, 0.5, oneStepUp, twoStepsUp]
    expect(highestScoreReference(scores)).toBe(3)
    expect(pickedLayout('emitArgmax', scores)).toBe(1)
    expect(pickedLayout('exact tree', scores)).toBe(3)
    expect(pickedLayout('exact chain', scores)).toBe(3)
  })

  test('the worked example: [0.2 0.7 0.7 0.1 0.4 0.9 0.3 0.9] picks layout 5', () => {
    const scores = [0.2, 0.7, 0.7, 0.1, 0.4, 0.9, 0.3, 0.9]
    expect(highestScoreReference(scores)).toBe(5)
    for (const [form, options] of variants.slice(0, 3)) expect(pickedLayout(form, scores, options)).toBe(5)
  })

  test('on a grid, every comparison is an integer bit; without one, a sign cascade', () => {
    const onGrid = buildBestLayout(8, 'exact tree', {grid: 1 / 64})
    const kinds = new Set(onGrid.circuit.roundingPoints().map(point => point.kind))
    expect([...kinds]).toEqual(['integer bit'])
    const withoutGrid = buildBestLayout(8, 'exact tree')
    expect([...new Set(withoutGrid.circuit.roundingPoints().map(point => point.kind))]).toEqual(['sign cascade'])
    const argmax = buildBestLayout(8, 'emitArgmax')
    expect([...new Set(argmax.circuit.roundingPoints().map(point => point.kind))]).toEqual(['boolean'])
  })

  test('sizes quoted in the pattern', () => {
    const size = (layoutCount: number, [form, options]: Variant) => {
      const built = buildBestLayout(layoutCount, form, options)
      const {operations, layers, storedWeights} = measureProgram(built.circuit, built.selected)
      return `${operations} operations, ${layers} layers, ${storedWeights} weights`
    }
    expect([3, 8, 64].map(layoutCount => variants.map(variant => size(layoutCount, variant)))).toEqual([
      ['10 operations, 8 layers, 19 weights', '40 operations, 37 layers, 62 weights', '40 operations, 37 layers, 62 weights',
        '12 operations, 11 layers, 22 weights', '12 operations, 11 layers, 22 weights'],
      ['45 operations, 15 layers, 88 weights', '150 operations, 57 layers, 235 weights', '150 operations, 137 layers, 237 weights',
        '52 operations, 18 layers, 95 weights', '52 operations, 46 layers, 97 weights'],
      ['437 operations, 33 layers, 848 weights', '1382 operations, 117 layers, 2171 weights', '1382 operations, 1257 layers, 2198 weights',
        '500 operations, 39 layers, 911 weights', '500 operations, 438 layers, 938 weights'],
    ])
    const built = buildBestLayout(3, 'emitArgmax')
    expect(measureProgram(built.circuit, [built.bestLayout, built.chosenThumbnailWidth]))
      .toEqual({operations: 12, layers: 10, storedWeights: 22, gatherReads: 1})
  })
})

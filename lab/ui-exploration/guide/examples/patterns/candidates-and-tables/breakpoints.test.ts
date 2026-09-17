import {describe, expect, test} from 'bun:test'
import {validateGrids, validateTensorEvaluation} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {
  buildBreakpointLayout,
  findBreakpoints,
  flattenMessageList,
  layoutMessageList,
  maximumContainerWidth,
  messageTexts,
  minimumContainerWidth,
  prepareMessage,
  widthGridSteps,
} from './breakpoints.ts'
import {createRandom, formatSize, measureProgram} from './measure.ts'

const messages = messageTexts.map(prepareMessage)
const layoutAt = (containerWidth: number) => flattenMessageList(layoutMessageList(messages, containerWidth))

describe('breakpoints found ahead of time', () => {
  const table = findBreakpoints(layoutAt, minimumContainerWidth, maximumContainerWidth)
  const built = buildBreakpointLayout(table)
  const evaluate = built.circuit.createTensorEvaluator(built.roots)
  const gridStep = 1 / widthGridSteps

  test('each threshold is the smallest width on the grid where its interval starts', () => {
    expect(table.thresholds.length).toBe(45)
    expect(table.layoutCalls).toBe(1391)
    table.thresholds.forEach((threshold, index) => {
      expect(Number.isInteger(threshold * widthGridSteps)).toBe(true)
      if (index > 0) expect(threshold).toBeGreaterThan(table.thresholds[index - 1]!)
      expect(layoutAt(threshold)).toEqual(table.valuesByInterval[index + 1]!)
      expect(layoutAt(threshold - gridStep)).toEqual(table.valuesByInterval[index]!)
    })
    // Some bubble's height changes at 14 of the 45 thresholds. At the others only a shrink-wrapped width changes.
    const heightChanges = table.thresholds.filter((_, index) =>
      table.valuesByInterval[index]!.slice(5, 10).join() !== table.valuesByInterval[index + 1]!.slice(5, 10).join())
    expect(heightChanges.length).toBe(14)
  })

  test('every width on the grid gives the same layout as the JavaScript loop', () => {
    const source = new Float32Array(1)
    let checks = 0
    for (let steps = minimumContainerWidth * widthGridSteps; steps <= maximumContainerWidth * widthGridSteps; steps++) {
      source[0] = steps / widthGridSteps
      const actual = evaluate(source)
      const expected = layoutAt(steps / widthGridSteps)
      if (!expected.every((value, output) => value === actual[output])) {
        throw new Error(`width ${steps / widthGridSteps}: got ${Array.from(actual).join()}, expected ${expected.join()}`)
      }
      checks++
    }
    expect(checks).toBe(71_681)
  })

  test('evaluateReference gives the JavaScript layout next to every threshold, at the ends and at random widths', () => {
    const random = createRandom(9)
    const widths = [
      minimumContainerWidth,
      maximumContainerWidth,
      ...table.thresholds.flatMap(threshold => [threshold - gridStep, threshold, threshold + gridStep]),
      ...Array.from({length: 200}, () => minimumContainerWidth + Math.floor(random() * (maximumContainerWidth - minimumContainerWidth) * widthGridSteps) / widthGridSteps),
    ]
    for (const width of widths) {
      const values = built.circuit.evaluateReference(Float32Array.of(width))
      expect(built.roots.map(root => values[root]!).join()).toBe(layoutAt(width).join())
      validateGrids(built.circuit, values)
    }
    const source = Float32Array.of(300)
    validateTensorEvaluation(source, built.circuit, built.circuit.evaluateTensor(source))
  })

  test('the host contract: a width off the grid fails validateGrids, and a width outside the table fails the range check', () => {
    expect(() => validateGrids(built.circuit, built.circuit.evaluateReference(Float32Array.of(300.01)))).toThrow()
    expect(() => evaluate(Float32Array.of(maximumContainerWidth + gridStep))).toThrow()
    expect(() => evaluate(Float32Array.of(minimumContainerWidth - gridStep))).toThrow()
  })

  test('sizes quoted in the pattern doc', () => {
    expect(formatSize(measureProgram(built.circuit, built.roots))).toBe('106 operations, 3 layers, 201 weights, 0 gather reads, 0 index reads')
    expect(formatSize(measureProgram(built.circuit, [built.roots.at(-1)!]))).toBe('29 operations, 3 layers, 42 weights, 0 gather reads, 0 index reads')
    // Both operations of every threshold's comparison are recorded as integer bits.
    const kinds = built.circuit.roundingPoints().map(point => point.kind)
    expect(kinds.length).toBe(90)
    expect([...new Set(kinds)]).toEqual(['integer bit'])
  })
})

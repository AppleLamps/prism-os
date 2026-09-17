import {describe, expect, test} from 'bun:test'
import {validateGrids, validateOneHotGroups} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {createBothEvaluators, createRandom, measureProgram, randomInteger} from './kit.ts'
import {boxesGapX, boxMinSizeX, buildColumnLayout, columnLayoutReference, columnThresholds, maximumColumns} from './threshold-counts.ts'

describe('threshold counts instead of floor and division', () => {
  test('the column count, rows and columns equal index.ts at every whole-pixel width from 0 to 8,192 px', () => {
    const itemCount = 221
    const built = buildColumnLayout(itemCount)
    const evaluate = built.circuit.createTensorEvaluator([built.columnCount, ...built.rows, ...built.columns])
    const source = new Float32Array(1)
    let mismatches = 0
    for (let width = 0; width <= 8192; width++) {
      source[0] = width
      const outputs = evaluate(source)
      const expected = columnLayoutReference(width, itemCount)
      if (outputs[0] !== expected.columnCount) mismatches++
      for (let item = 0; item < itemCount; item++) {
        if (outputs[1 + item] !== expected.rows[item]) mismatches++
        if (outputs[1 + itemCount + item] !== expected.columns[item]) mismatches++
      }
    }
    expect(mismatches).toBe(0)
  })

  test('both evaluators equal index.ts next to every threshold and at random widths up to 16,384 px', () => {
    const random = createRandom(13)
    const itemCount = 64
    const built = buildColumnLayout(itemCount)
    const evaluate = createBothEvaluators(built.circuit, [built.columnCount, ...built.rows, ...built.columns])
    const widths = [0, 1, 16_384, ...columnThresholds.flatMap(threshold => [threshold - 1, threshold, threshold + 1])]
    for (let trial = 0; trial < 200; trial++) widths.push(randomInteger(random, 0, 16_384))
    for (const width of widths) {
      const {outputs, values} = evaluate(Float32Array.from([width]))
      const expected = columnLayoutReference(width, itemCount)
      expect(outputs).toEqual([expected.columnCount, ...expected.rows, ...expected.columns])
      validateOneHotGroups(built.circuit, values)
      validateGrids(built.circuit, values)
    }
  })

  test('floor of an FP32 reciprocal picks one column too few exactly at the thresholds', () => {
    const reciprocal = Math.fround(1 / (boxMinSizeX + boxesGapX))
    const wrongWidths: number[] = []
    for (let width = 0; width <= 8192; width++) {
      const quotient = Math.fround(Math.fround(width - boxesGapX) * reciprocal)
      const columnCount = Math.min(Math.max(1, Math.floor(quotient)), maximumColumns)
      if (columnCount !== columnLayoutReference(width, 0).columnCount) wrongWidths.push(width)
    }
    expect(wrongWidths).toEqual(columnThresholds)
    expect(Math.fround(Math.fround(1000 - boxesGapX) * reciprocal)).toBe(3.999999761581421)
  })

  test('numbers quoted in the doc', () => {
    expect(columnThresholds).toEqual([512, 756, 1000, 1244, 1488, 1732])
    const built = buildColumnLayout(11)
    const values = built.circuit.evaluateReference(Float32Array.from([1000]))
    expect(built.reached.map(wire => values[wire])).toEqual([1, 1, 1, 0, 0, 0])
    expect(values[built.columnCount]).toBe(4)
    expect(built.hasColumns.map(wire => values[wire])).toEqual([0, 0, 0, 1, 0, 0, 0])
    expect(values[built.rows[10]!]).toBe(2)
    expect(values[built.columns[10]!]).toBe(2)
  })

  test('sizes quoted in the doc', () => {
    const alone = buildColumnLayout(0)
    expect(measureProgram(alone.circuit, [alone.columnCount])).toMatchObject({liveOperations: 13, layers: 3})
    expect(alone.circuit.roundingPoints().every(point => point.kind === 'integer bit')).toBe(true)
    for (const [itemCount, liveOperations] of [[221, 458], [10_000, 10_435]] as const) {
      const built = buildColumnLayout(itemCount)
      expect(measureProgram(built.circuit, [built.columnCount, ...built.rows, ...built.columns])).toMatchObject({liveOperations, layers: 4})
    }
  })
})

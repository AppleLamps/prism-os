import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {buildPointedRow, pointedRowReference, type PointedRowForm} from './count-instead-of-search.ts'
import {createBothEvaluators, createRandom, measureProgram} from './kit.ts'

const forms: PointedRowForm[] = ['count', 'tree']

describe('count instead of search', () => {
  test('both forms find the loop\'s row on random heights, zero-height rows and pointers on every row edge, in both evaluators', () => {
    const random = createRandom(31)
    let checks = 0
    let mismatches = 0
    for (const rowCount of [1, 2, 5, 48]) {
      for (const form of forms) {
        const built = buildPointedRow(rowCount, form)
        const evaluate = createBothEvaluators(built.circuit, [built.pointedRow, built.onRows, built.pointedRowTop, ...built.isPointedRow])
        const source = new Float32Array(built.circuit.sourceSize)
        for (let layout = 0; layout < 10; layout++) {
          // Quarter-pixel heights up to 128 px, with about 1 row in 6 collapsed to 0 px.
          const heights = Array.from({length: rowCount}, () => random() < 0.15 ? 0 : Math.round(random() * 512) / 4)
          const rowBottoms: number[] = []
          let rowBottom = 0
          heights.forEach((height, row) => {
            rowBottom += height
            rowBottoms.push(rowBottom)
            source[built.rowBottoms[row]!] = rowBottom
          })
          const contentHeight = rowBottom
          const pointers = [-20, -1 / 64, 0, 1 / 64, contentHeight + 20]
          for (let sample = 0; sample < 30; sample++) pointers.push(Math.round((random() * (contentHeight + 40) - 20) * 64) / 64)
          for (const bottom of rowBottoms) pointers.push(bottom - 1 / 64, bottom, bottom + 1 / 64)
          for (const pointerY of pointers) {
            source[built.pointerY] = pointerY
            const {roots, everyWire} = evaluate(source)
            validateOneHotGroups(built.circuit, everyWire)
            const expected = pointedRowReference(heights, pointerY)
            const [pointedRow, onRows, pointedRowTop, ...isPointedRow] = roots
            const expectedTop = expected <= 0 ? 0 : rowBottoms[expected - 1]!
            const matches = onRows === (expected === -1 ? 0 : 1)
              && isPointedRow.every((bit, row) => bit === (row === expected ? 1 : 0))
              && pointedRowTop === (expected === -1 ? 0 : expectedTop)
              // The count is the pointed row only while the pointer is on the rows.
              && (expected === -1 || pointedRow === expected)
            if (!matches) mismatches++
            checks++
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(2_000)
    expect(mismatches).toBe(0)
  })

  test('the worked example: heights 40, 40, 0, 60 and 40 px at pointerY 90', () => {
    const built = buildPointedRow(5, 'count')
    const values = built.circuit.evaluateReference(Float32Array.from([90, 40, 80, 80, 140, 180]))
    expect(built.rowAbove.map(wire => values[wire])).toEqual([1, 1, 1, 0, 0])
    expect(values[built.pointedRow]).toBe(3)
    expect(built.isPointedRow.map(wire => values[wire])).toEqual([0, 0, 0, 1, 0])
    expect(values[built.onRows]).toBe(1)
    expect(values[built.pointedRowTop]).toBe(80)
    expect(pointedRowReference([40, 40, 0, 60, 40], 90)).toBe(3)
  })

  test('unsorted row bottoms give a wrong count without an error, which validateOneHotGroups catches', () => {
    // A negative height, e.g. from a resize bug, makes the bottoms 40, 30, 80.
    const built = buildPointedRow(3, 'count')
    const values = built.circuit.evaluateReference(Float32Array.from([35, 40, 30, 80]))
    expect(pointedRowReference([40, -10, 50], 35)).toBe(0)
    expect(values[built.pointedRow]).toBe(1)
    expect(() => validateOneHotGroups(built.circuit, values)).toThrow()
  })

  test('sizes quoted in the pattern', () => {
    const sizes = [16, 64, 256, 1024].map(rowCount => [rowCount, ...forms.map(form => {
      const built = buildPointedRow(rowCount, form)
      const {operations, layers, storedWeights} = measureProgram(built.circuit, [built.pointedRow, ...built.isPointedRow])
      return `${form}: ${operations} operations, ${layers} layers, ${storedWeights} weights`
    })])
    expect(sizes).toEqual([
      [16, 'count: 51 operations, 3 layers, 98 weights', 'tree: 111 operations, 24 layers, 211 weights'],
      [64, 'count: 195 operations, 3 layers, 386 weights', 'tree: 447 operations, 34 layers, 863 weights'],
      [256, 'count: 771 operations, 3 layers, 1538 weights', 'tree: 1791 operations, 44 layers, 3468 weights'],
      [1024, 'count: 3075 operations, 3 layers, 6146 weights', 'tree: 7167 operations, 54 layers, 13891 weights'],
    ])
    const built = buildPointedRow(1024, 'count')
    expect(measureProgram(built.circuit, [built.pointedRowTop]).gatherReads).toBe(1)
  })
})

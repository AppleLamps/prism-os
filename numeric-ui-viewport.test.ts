import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  Circuit,
  emitMaximum,
  emitMinimum,
  emitRelu,
  validateTensorEvaluation,
  validateTensorProgram,
} from './numeric-ui-core.ts'

const rowCount = 8
const sourceField = {
  viewportHeight: 0,
  scrollY: 1,
  rowHeight: 2,
  gap: 3,
  size: 4,
} as const

test('one fixed circuit scrolls and clips preallocated rows', () => {
  const {circuit, rows} = compileViewport()
  const roots = rows.flatMap(row => [row.top, row.clippedTop, row.clippedHeight, row.visible])
  const program = circuit.tensorProgram = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, program)

  const cases = [
    {
      scrollY: 0,
      expected: [
        [0, 0, 30, 1],
        [40, 40, 30, 1],
        [80, 80, 20, 1],
        [120, 100, 0, 0],
      ],
    },
    {
      scrollY: 15,
      expected: [
        [-15, 0, 15, 1],
        [25, 25, 30, 1],
        [65, 65, 30, 1],
        [105, 100, 0, 0],
      ],
    },
    {
      scrollY: 40,
      expected: [
        [-40, 0, 0, 0],
        [0, 0, 30, 1],
        [40, 40, 30, 1],
        [80, 80, 20, 1],
      ],
    },
  ] as const

  for (const {scrollY, expected} of cases) {
    const source = new Float32Array([100, scrollY, 30, 10])
    const values = circuit.evaluateTensor(source)
    validateTensorEvaluation(source, circuit, values)
    assert.deepEqual(
      rows.slice(0, 4).map(row => [
        values[row.top],
        values[row.clippedTop],
        values[row.clippedHeight],
        values[row.visible],
      ]),
      expected,
    )
    assert.equal(circuit.tensorProgram, program)
  }
})

function compileViewport() {
  const circuit = new Circuit(sourceField.size)
  for (let field = 0; field < sourceField.size; field++) {
    circuit.assumeRange(field, 0, Number.POSITIVE_INFINITY)
  }
  const zero = circuit.affine([])
  const stride = circuit.affine([[sourceField.rowHeight, 1], [sourceField.gap, 1]])
  const rows = Array.from({length: rowCount}, (_, row) => {
    const top = circuit.affine([[stride, row], [sourceField.scrollY, -1]])
    const bottom = circuit.affine([[top, 1], [sourceField.rowHeight, 1]])
    const clippedTop = emitMinimum(
      circuit,
      emitMaximum(circuit, top, zero),
      sourceField.viewportHeight,
    )
    const clippedBottom = emitMinimum(circuit, bottom, sourceField.viewportHeight)
    const clippedHeight = emitRelu(
      circuit,
      circuit.affine([[clippedBottom, 1], [clippedTop, -1]]),
    )
    const visibleScore = emitClampZeroOne(circuit, clippedHeight)
    return {
      top,
      clippedTop,
      clippedHeight,
      visible: circuit.boolean(visibleScore),
    }
  })
  return {circuit, rows}
}

function emitClampZeroOne(circuit: Circuit, value: number) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

// Plain JS generated from a compiled tensor program, adapted from phase 1's codegen-study.ts.
// Functions are split by statement count, not by rows: a single row can be a 251-term prefix sum, and one gather
// index computation reads every member of its group.

import type {Circuit} from '../../../src/runtime/numeric-ui-core.ts'

type Program = ReturnType<Circuit['compileTensorProgram']>
type Generated = (v: Float32Array, f: (x: number) => number, gi: Int32Array, gm: Float32Array, tables: Int32Array[]) => void

export function generateProgram(program: Program, statementBudget = 300) {
  const literal = (value: number) => Object.is(value, -0) ? '-0' : String(value)
  const bodies: string[] = []
  let current: string[] = []
  let statements = 0
  const flush = () => {
    if (current.length > 0) bodies.push(`let a = 0, g = 0\n${current.join('\n')}`)
    current = []
    statements = 0
  }
  const push = (code: string, count: number) => {
    current.push(code)
    statements += count
    if (statements >= statementBudget) flush()
  }
  let available = program.sourceSize
  let tableIndex = 0
  const tables: Int32Array[] = []
  for (const layer of program.layers) {
    const gateProjectionByRow = new Map<number, number>()
    layer.gateRows.forEach((row, gateIndex) => gateProjectionByRow.set(row, layer.outputSize + gateIndex))
    const booleanRows = new Set(layer.booleanRows)
    const readByRow = new Map(layer.gatherReads.map(read => [read.row, read]))
    const tableByRow = new Map<number, number>()
    for (const read of layer.gatherReads) {
      tableByRow.set(read.row, tableIndex++)
      tables.push(Int32Array.from(read.candidatePositions))
    }
    for (const compute of layer.gatherComputes) {
      // The index and mass accumulate in the shared arrays, so one computation can span functions.
      push(`gi[${compute.slot}] = 0; gm[${compute.slot}] = 0`, 1)
      ;[...compute.bitPositions].forEach((position, bitIndex) => push(`gi[${compute.slot}] += ${bitIndex} * v[${position}]; gm[${compute.slot}] += v[${position}]`, 1))
    }
    const rowStatements = (row: number, variable: string, lines: string[]) => {
      lines.push(`${variable} = ${literal(layer.bias[row]!)}`)
      for (let index = layer.rowOffsets[row]!; index < layer.rowOffsets[row + 1]!; index++) {
        lines.push(`${variable} = f(${variable} + f(${literal(layer.weights[index]!)} * v[${layer.inputIndices[layer.columns[index]!]!}]))`)
      }
    }
    for (let row = 0; row < layer.outputSize; row++) {
      const lines: string[] = []
      rowStatements(row, 'a', lines)
      const read = readByRow.get(row)
      if (read !== undefined) {
        const limit = read.candidatePositions.length - 1
        const contribution = `v[tables[${tableByRow.get(row)}][Math.min(Math.max(gi[${read.slot}], 0), ${limit})]]`
        lines.push(read.masked ? `a = f(a + f(gm[${read.slot}] * ${contribution}))` : `a = f(a + ${contribution})`)
      }
      const gateProjection = gateProjectionByRow.get(row)
      if (gateProjection !== undefined) {
        rowStatements(gateProjection, 'g', lines)
        lines.push('a = f(a * Math.max(0, g))')
      } else if (booleanRows.has(row)) {
        lines.push('a = f(f(f(a) + 8388609) - 8388609)')
      }
      lines.push(`v[${available + row}] = a`)
      push(lines.join('\n'), lines.length)
    }
    available += layer.outputSize
  }
  flush()
  const functions = bodies.map(body => new Function('v', 'f', 'gi', 'gm', 'tables', body) as Generated)
  const packed = new Float32Array(program.valueCount)
  const gatherIndices = new Int32Array(Math.max(1, program.gatherSlotCount))
  const gatherMasses = new Float32Array(Math.max(1, program.gatherSlotCount))
  let statementTotal = 0
  for (const body of bodies) statementTotal += body.split('\n').length
  return {
    functionCount: functions.length,
    statementTotal,
    packed,
    run(sources: Float32Array) {
      packed.set(sources, 0)
      for (const generatedFunction of functions) generatedFunction(packed, Math.fround, gatherIndices, gatherMasses, tables)
    },
  }
}

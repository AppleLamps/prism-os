// Plain JS generated from a compiled tensor program, adapted from the phase 1 codegen study
// (scratchpad/phase1/runtime/codegen-study.ts). Every row becomes a few statements with the same
// FP32 rounding steps as the executor, split into functions of a few dozen rows so JavaScriptCore
// optimizes them.

import type {Circuit, Wire} from '../../../numeric-ui-core.ts'

type Program = ReturnType<Circuit['compileTensorProgram']>
type Generated = (v: Float32Array, f: (x: number) => number, gi: Int32Array, gm: Float32Array, tables: Int32Array[]) => void

function literal(value: number) {
  return Object.is(value, -0) ? '-0' : String(value)
}

function generateStatements(program: Program): string[][] {
  const chunks: string[][] = []
  let available = program.sourceSize
  let tableIndex = 0
  for (const layer of program.layers) {
    const prelude: string[] = []
    const gateProjectionByRow = new Map<number, number>()
    layer.gateRows.forEach((row, gateIndex) => gateProjectionByRow.set(row, layer.outputSize + gateIndex))
    const booleanRows = new Set(layer.booleanRows)
    const readByRow = new Map(layer.gatherReads.map(read => [read.row, read]))
    const tableByRow = new Map<number, number>()
    for (const read of layer.gatherReads) tableByRow.set(read.row, tableIndex++)
    for (const compute of layer.gatherComputes) {
      const parts = [...compute.bitPositions].map((position, bitIndex) => `index += ${bitIndex} * v[${position}]; mass += v[${position}];`)
      prelude.push(`{ let index = 0, mass = 0; ${parts.join(' ')} gi[${compute.slot}] = index; gm[${compute.slot}] = mass }`)
    }
    chunks.push(prelude)
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
      chunks.push(lines)
    }
    available += layer.outputSize
  }
  return chunks
}

export function createGeneratedEvaluator(program: Program, roots: readonly Wire[], rowsPerFunction = 64) {
  const chunks = generateStatements(program)
  const bodies: string[] = []
  let current: string[] = []
  for (const chunk of chunks) {
    current.push(...chunk)
    if (current.length >= rowsPerFunction * 4) {
      bodies.push(`let a = 0, g = 0\n${current.join('\n')}`)
      current = []
    }
  }
  if (current.length > 0) bodies.push(`let a = 0, g = 0\n${current.join('\n')}`)
  const functions = bodies.map(body => new Function('v', 'f', 'gi', 'gm', 'tables', body) as Generated)
  const packed = new Float32Array(program.valueCount)
  const gatherIndices = new Int32Array(Math.max(1, program.gatherSlotCount))
  const gatherMasses = new Float32Array(Math.max(1, program.gatherSlotCount))
  const tables = program.layers.flatMap(layer => layer.gatherReads.map(read => Int32Array.from(read.candidatePositions)))
  const positions = roots.map(root => program.wireOrder.indexOf(root))
  const outputs = new Float32Array(roots.length)
  return {
    functionCount: functions.length,
    evaluate(source: Float32Array): Float32Array {
      packed.set(source)
      for (const generated of functions) generated(packed, Math.fround, gatherIndices, gatherMasses, tables)
      for (let index = 0; index < positions.length; index++) outputs[index] = packed[positions[index]!]!
      return outputs
    },
  }
}

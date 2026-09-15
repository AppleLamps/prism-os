// Plain JavaScript generated from compileTensorProgram's output.
//
// The executor in numeric-ui-core.ts interprets each layer: it stages inputs,
// walks CSR rows, applies gates, rounds booleans and appends outputs. This file
// writes the same arithmetic out as JavaScript statements, one statement per
// live value, split into functions of a bounded row count, and compiles them
// with `new Function`. Every statement keeps the executor's FP32 rounding order,
// so every live wire is bit-identical to the reference evaluator.
//
// Rewrites that keep exactness (x is always a float32 value, because it comes
// out of a Float32Array or out of Math.fround):
// - fround(1 * x) is x, and fround(-1 * x) is -x, so ±1 weights skip the product.
// - fround(-0 + x) is x for every x, and fround(+0 + x) is x + 0, which only
//   turns -0 into +0.
// - Writing into a Float32Array rounds, so the outermost fround of a statement
//   can be dropped when the result is stored directly.
import type {Circuit} from '../index-read/numeric-ui-core.ts'

export type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

export type Term = {weight: number, position: number}

export type ValueRow = {
  kind: 'affine' | 'reglu' | 'boolean' | 'gather' | 'index'
  // Packed position of the output value.
  position: number
  bias: number
  terms: Term[]
  // ReGLU rows: the gate. Index rows (pixel-output): the index form.
  gateBias: number
  gateTerms: Term[]
  // Gather rows only: the group slot, whether the group allows all zeros.
  slot: number
  masked: boolean
  // Gather and index rows: the packed positions of the candidates in table order.
  candidates: number[]
  // Index rows only: an index below 0 (or past the last candidate) reads +0 instead of the nearest end.
  belowZero: boolean
  aboveZero: boolean
}

export type GatherCompute = {slot: number, bits: number[]}

type CandidateTable = {candidateCount: number, candidateBase: number, candidateStride: number, candidatePositions: ArrayLike<number>}

// index-read's runtime stores evenly spaced candidates as a base and a stride.
function candidateList(table: CandidateTable): number[] {
  return table.candidatePositions.length > 0
    ? Array.from(table.candidatePositions)
    : Array.from({length: table.candidateCount}, (_, index) => table.candidateBase + index * table.candidateStride)
}

export type Step =
  | {kind: 'row', row: ValueRow}
  | {kind: 'gatherCompute', compute: GatherCompute}

export type FlatProgram = {
  sourceSize: number
  valueCount: number
  gatherSlotCount: number
  layerCount: number
  storedWeights: number
  rowCount: number
  steps: Step[]
  wireOrder: ArrayLike<number>
  // Packed position of each circuit wire, or -1 when the wire isn't live.
  positionOfWire: Int32Array
}

// Turn the per-layer CSR matrices into one list of rows in execution order.
// Rows of one layer only read earlier layers, so evaluating rows one at a time
// and storing each output immediately is equivalent to the executor's
// stage-then-append order.
export function flattenProgram(program: TensorProgram): FlatProgram {
  const steps: Step[] = []
  let available = program.sourceSize
  let storedWeights = 0
  let rowCount = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    const gateProjectionByRow = new Map<number, number>()
    layer.gateRows.forEach((row, gateIndex) => gateProjectionByRow.set(row, layer.outputSize + gateIndex))
    const booleanRows = new Set(layer.booleanRows)
    const readByRow = new Map(layer.gatherReads.map(read => [read.row, read]))
    const indexReadByRow = new Map(layer.indexReads.map(read => [read.row, read]))
    for (const compute of layer.gatherComputes) {
      if (compute.indexPosition >= 0) throw new Error('gather groups resolved from an index wire are not supported here; compile with lowerIndexOneHots: false')
      steps.push({kind: 'gatherCompute', compute: {slot: compute.slot, bits: [...compute.bitPositions]}})
    }
    const termsOf = (projectionRow: number): Term[] => {
      const terms: Term[] = []
      for (let index = layer.rowOffsets[projectionRow]!; index < layer.rowOffsets[projectionRow + 1]!; index++) {
        terms.push({weight: layer.weights[index]!, position: layer.inputIndices[layer.columns[index]!]!})
      }
      return terms
    }
    for (let row = 0; row < layer.outputSize; row++) {
      const read = readByRow.get(row)
      const indexRead = indexReadByRow.get(row)
      const gateProjection = gateProjectionByRow.get(row)
      const kind: ValueRow['kind'] = read !== undefined
        ? 'gather'
        : indexRead !== undefined
          ? 'index'
          : gateProjection !== undefined
            ? 'reglu'
            : booleanRows.has(row) ? 'boolean' : 'affine'
      // An index read's index form is its own projection row, after the gate rows.
      const secondRow = indexRead !== undefined ? indexRead.indexRow : gateProjection
      steps.push({
        kind: 'row',
        row: {
          kind,
          position: available + row,
          bias: layer.bias[row]!,
          terms: termsOf(row),
          gateBias: secondRow === undefined ? 0 : layer.bias[secondRow]!,
          gateTerms: secondRow === undefined ? [] : termsOf(secondRow),
          slot: read?.slot ?? -1,
          masked: read?.masked ?? false,
          candidates: read !== undefined ? candidateList(read) : indexRead !== undefined ? candidateList(indexRead) : [],
          belowZero: indexRead?.belowZero ?? false,
          aboveZero: indexRead?.aboveZero ?? false,
        },
      })
      rowCount++
    }
    available += layer.outputSize
  }
  const positionOfWire = new Int32Array(program.width).fill(-1)
  for (let position = 0; position < program.valueCount; position++) {
    positionOfWire[program.wireOrder[position]!] = position
  }
  return {
    sourceSize: program.sourceSize,
    valueCount: program.valueCount,
    gatherSlotCount: program.gatherSlotCount,
    layerCount: program.layers.length,
    storedWeights,
    rowCount,
    steps,
    wireOrder: program.wireOrder,
    positionOfWire,
  }
}

export function jsLiteral(value: number): string {
  if (Object.is(value, -0)) return '-0'
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  return String(value)
}

// A generated expression and whether its value is already a float32 value.
export type Expression = {text: string, rounded: boolean}

export function rounded(expression: Expression, fround = 'f'): string {
  return expression.rounded ? expression.text : `${fround}(${expression.text})`
}

function termExpression(term: Term, read: (position: number) => string, fround: string): string {
  if (term.weight === 1) return read(term.position)
  if (term.weight === -1) return `-${read(term.position)}`
  return `${fround}(${jsLiteral(term.weight)} * ${read(term.position)})`
}

// The executor's row accumulation: value = bias, then
// value = fround(value + fround(weight * input)) for each term in stored order.
export function sumExpression(
  bias: number,
  terms: readonly Term[],
  read: (position: number) => string,
  fround = 'f',
): Expression {
  if (terms.length === 0) return {text: jsLiteral(bias), rounded: true}
  const firstTerm = termExpression(terms[0]!, read, fround)
  let expression: Expression = Object.is(bias, -0)
    ? {text: firstTerm, rounded: true}
    : bias === 0
      ? {text: `(${firstTerm} + 0)`, rounded: true}
      : {text: `${jsLiteral(bias)} + ${firstTerm}`, rounded: false}
  // Chrome's V8 throws "Maximum call stack size exceeded" while compiling f(...) calls nested
  // about 660 deep, and a row with 1,000 terms nests 1,003 deep. So every 256 terms the rounded
  // running sum goes into `t` through a comma expression, which V8 parses without nesting. Every
  // FP32 value stays the same, since the same rounding steps run in the same order.
  let prefix = ''
  for (let index = 1; index < terms.length; index++) {
    const term = terms[index]!
    if (index % 256 === 0) {
      prefix += `t = ${rounded(expression, fround)}, `
      expression = {text: 't', rounded: true}
    }
    const operand = rounded(expression, fround)
    expression = term.weight === -1
      ? {text: `${operand} - ${read(term.position)}`, rounded: false}
      : {text: `${operand} + ${termExpression(term, read, fround)}`, rounded: false}
  }
  return prefix === '' ? expression : {text: `(${prefix}${expression.text})`, rounded: expression.rounded}
}

// The value a row stores, as an expression whose final rounding may be left to
// the Float32Array store. `gatherIndex` and `gatherMass` name the slot's index
// and mass; `candidate` reads the selected candidate given a clamped index.
export type RowReaders = {
  read: (position: number) => string
  gatherIndex: (slot: number) => string
  gatherMass: (slot: number) => string
  candidate: (row: ValueRow, clampedIndex: string) => string
  fround: string
}

export function rowValueExpression(row: ValueRow, readers: RowReaders): string {
  const {read, fround} = readers
  switch (row.kind) {
    case 'affine':
      return sumExpression(row.bias, row.terms, read, fround).text
    case 'reglu': {
      const left = sumExpression(row.bias, row.terms, read, fround)
      const gate = rounded(sumExpression(row.gateBias, row.gateTerms, read, fround), fround)
      // fround(1 * max(0, g)) is max(0, g) for a float32 g.
      if (row.terms.length === 0 && row.bias === 1) return `Math.max(0, ${gate})`
      return `${rounded(left, fround)} * Math.max(0, ${gate})`
    }
    case 'boolean': {
      const score = rounded(sumExpression(row.bias, row.terms, read, fround), fround)
      return `${fround}(${score} + 8388609) - 8388609`
    }
    case 'gather': {
      const limit = row.candidates.length - 1
      const clamped = `Math.min(Math.max(${readers.gatherIndex(row.slot)}, 0), ${limit})`
      const selected = readers.candidate(row, clamped)
      const contribution = row.masked ? `${fround}(${readers.gatherMass(row.slot)} * ${selected})` : selected
      return `${jsLiteral(row.bias)} + ${contribution}`
    }
    case 'index': {
      // pixel-output: candidates[floor(index)], clamped to the table like the executor's 'clamp' reads.
      if (row.belowZero || row.aboveZero) throw new Error('index reads that read zero outside the table are not generated')
      const index = rounded(sumExpression(row.gateBias, row.gateTerms, read, fround), fround)
      return readers.candidate(row, `Math.min(Math.max(Math.floor(${index}), 0), ${row.candidates.length - 1})`)
    }
  }
}

// The executor computes a group's index as a left fold of position * bit in
// doubles, stored into an Int32Array (ToInt32), and the mass as a left fold of
// bits stored into a Float32Array. Folding in the same order reproduces both.
export function gatherIndexExpression(compute: GatherCompute, read: (position: number) => string): string {
  return ['0', ...compute.bits.map((position, bitIndex) => `${bitIndex} * ${read(position)}`)].join(' + ')
}

export function gatherMassExpression(compute: GatherCompute, read: (position: number) => string): string {
  return ['0', ...compute.bits.map(position => read(position))].join(' + ')
}

export type FroundAccess = 'closure' | 'Math.fround'

export type ScalarCodeOptions = {
  // Upper bound on value rows per generated function. JavaScriptCore stops
  // optimizing functions past a bytecode size, so this keeps each one small.
  rowsPerFunction: number
  froundAccess?: FroundAccess
}

export type ScalarModule = {
  source: string
  tables: Int32Array[]
  functionCount: number
}

export function generateScalarModule(steps: readonly Step[], options: ScalarCodeOptions): ScalarModule {
  const fround = options.froundAccess === 'Math.fround' ? 'Math.fround' : 'f'
  const tables: Int32Array[] = []
  const tableNameByRow = new Map<ValueRow, string>()
  const readers: RowReaders = {
    read: position => `v[${position}]`,
    gatherIndex: slot => `gi[${slot}]`,
    gatherMass: slot => `gm[${slot}]`,
    candidate: (row, clamped) => `v[${tableNameByRow.get(row)!}[${clamped}]]`,
    fround,
  }
  const functions: string[] = []
  let current: string[] = []
  let rowsInCurrent = 0
  const flush = () => {
    if (current.length === 0) return
    functions.push(`function chunk${functions.length}(v, gi, gm) {\n${current.join('\n')}\n}`)
    current = []
    rowsInCurrent = 0
  }
  for (const step of steps) {
    if (step.kind === 'gatherCompute') {
      const {compute} = step
      current.push(`gi[${compute.slot}] = ${gatherIndexExpression(compute, readers.read)}`)
      current.push(`gm[${compute.slot}] = ${gatherMassExpression(compute, readers.read)}`)
      continue
    }
    const {row} = step
    if (row.kind === 'gather' || row.kind === 'index') {
      const name = `T${tables.length}`
      tables.push(Int32Array.from(row.candidates))
      tableNameByRow.set(row, name)
    }
    current.push(`v[${row.position}] = ${rowValueExpression(row, readers)}`)
    rowsInCurrent++
    if (rowsInCurrent === options.rowsPerFunction) flush()
  }
  flush()
  const prelude = [
    '"use strict"',
    'const f = Math.fround',
    'let t = 0',
    ...tables.map((_, index) => `const T${index} = T[${index}]`),
  ]
  const source = `${prelude.join('\n')}\nreturn [\n${functions.join(',\n')}\n]`
  return {source, tables, functionCount: functions.length}
}

export type GeneratedFunction = (v: Float32Array, gi: Int32Array, gm: Float32Array) => void

export type ScalarProgram = {
  flat: FlatProgram
  values: Float32Array
  functions: GeneratedFunction[]
  sourceBytes: number
  generateMilliseconds: number
  compileMilliseconds: number
  run: (source: Float32Array) => void
}

export function compileScalarProgram(program: TensorProgram, options: ScalarCodeOptions): ScalarProgram {
  const generateStart = performance.now()
  const flat = flattenProgram(program)
  const generated = generateScalarModule(flat.steps, options)
  const generateMilliseconds = performance.now() - generateStart
  const compileStart = performance.now()
  const functions = new Function('T', generated.source)(generated.tables) as GeneratedFunction[]
  const compileMilliseconds = performance.now() - compileStart
  const values = new Float32Array(program.valueCount)
  const gatherIndices = new Int32Array(Math.max(1, program.gatherSlotCount))
  const gatherMasses = new Float32Array(Math.max(1, program.gatherSlotCount))
  const functionCount = functions.length
  return {
    flat,
    values,
    functions,
    sourceBytes: generated.source.length,
    generateMilliseconds,
    compileMilliseconds,
    run(source: Float32Array) {
      values.set(source)
      for (let index = 0; index < functionCount; index++) functions[index]!(values, gatherIndices, gatherMasses)
    },
  }
}

export function sameFloat(left: number, right: number) {
  return Object.is(left, right) || (Number.isNaN(left) && Number.isNaN(right))
}

export type Comparison = {
  checked: number
  mismatches: number
  // Mismatches where both values are zeros of different signs.
  signedZeroMismatches: number
  firstMismatch: string | null
}

// Compare packed values against the reference evaluator, wire by wire.
export function compareWithReference(
  circuit: Circuit,
  program: TensorProgram,
  packedValues: Float32Array,
  source: Float32Array,
): Comparison {
  const expected = circuit.evaluateReference(source)
  return comparePacked(program, packedValues, expected)
}

export function comparePacked(program: TensorProgram, packedValues: ArrayLike<number>, expectedByWire: ArrayLike<number>): Comparison {
  let mismatches = 0
  let signedZeroMismatches = 0
  let firstMismatch: string | null = null
  for (let position = 0; position < program.valueCount; position++) {
    const wire = program.wireOrder[position]!
    const left = packedValues[position]!
    const right = expectedByWire[wire]!
    if (sameFloat(left, right)) continue
    mismatches++
    if (left === 0 && right === 0) signedZeroMismatches++
    firstMismatch ??= `wire ${wire} (packed ${position}): generated ${left}, reference ${right}`
  }
  return {checked: program.valueCount, mismatches, signedZeroMismatches, firstMismatch}
}

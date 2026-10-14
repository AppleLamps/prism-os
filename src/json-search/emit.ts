// One WGSL compute shader from a compiled tensor program: one invocation runs every operation of the program for one
// instance, e.g. one JSON document, with one `let` per operation. It starts from lab/ui-exploration/codegen/wgsl.ts, whose
// flattenProgram ignores index reads, and adds them with both out-of-range rules.
//
// What the shader reads and writes:
//   shared_values      the program's source table, uploaded once, e.g. the highlighter's 4,061 table cells, then the
//                      lowest float32 value at lowestOffset for the guards
//   instance_sources   the source cells that differ per instance, cellsPerInstance float32 values per instance, in the
//                      order of options.instanceCells, e.g. 512 code points and the length per document
//   instance_outputs_g one buffer per group of options.outputGroups, e.g. group 0 for 3 summary values per document and
//                      group 1 for 512 display kinds, so a page can read back one group whole and a few documents of the other
//
// An index read is two statements: `let p7: i32 = i32(floor(<index form>));` and a read of the candidate at
// clamp(p7, 0, last). A side with the 'zero' rule wraps the read in a select, e.g. `select(<read>, 0.0f, p7 > 128i)`.
// The candidates must be source cells at evenly spaced positions, e.g. a table of constant cells, which is how
// compileTensorProgram stores a run of cells. A read whose candidates are computed per instance, e.g. the highlighter's
// firstErrorKind, which reads one of 513 computed error kinds, throws: one `let` per value can't be indexed.
//
// Exactness. A row's sum is written as one chain in the executor's order, `bias + w1 * a - b`, which WGSL parses left to
// right. Apple's Metal compiler fuses `a + w * x` into one multiply-add and regroups sums (the comment at the top of
// codegen's wgsl.ts has the measurements), so with guard: 'none' only a program whose every product and partial sum is
// exact gives the executor's bits, e.g. one that holds only integers below 2^24, like the JSON highlighter. With
// guard: 'max', every product whose weight isn't a power of two and every partial sum is wrapped in max(x, lowest), which
// kept the executor's rounding in every program codegen measured. Booleans are select(0.0f, 1.0f, score >= 0.5f). A NaN
// index, or any NaN or Infinity, isn't reproduced, and zeros may differ in sign, which never changes a nonzero value of
// these instructions.
import {type Circuit, invariant} from '../runtime/numeric-ui-core.ts'

export type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

export type Term = {weight: number, position: number}

// One operation, in execution order. `position` is the packed position of its value: the source table comes first, then
// every layer's outputs.
export type Row =
  | {kind: 'affine' | 'boolean', position: number, bias: number, terms: Term[]}
  | {kind: 'reglu', position: number, bias: number, terms: Term[], gateBias: number, gateTerms: Term[]}
  | {
    kind: 'index', position: number, indexBias: number, indexTerms: Term[], belowZero: boolean, aboveZero: boolean,
    // Candidate k is the source cell at candidateBase + k × candidateStride.
    candidateCount: number, candidateBase: number, candidateStride: number,
  }

// The layers' CSR matrices as one list of rows. A layer's rows only read earlier layers, so running the rows one at a
// time gives the executor's values.
export function flattenProgram(program: TensorProgram): Row[] {
  const rows: Row[] = []
  let available = program.sourceSize
  for (const layer of program.layers) {
    invariant(layer.gatherReads.length === 0 && layer.gatherComputes.length === 0, 'this emitter doesn\'t write gathers, and codegen\'s wgsl.ts does')
    const gateProjectionByRow = new Map<number, number>()
    layer.gateRows.forEach((row, gateIndex) => gateProjectionByRow.set(row, layer.outputSize + gateIndex))
    const booleanRows = new Set(layer.booleanRows)
    const readByRow = new Map(layer.indexReads.map(read => [read.row, read]))
    const termsOf = (projectionRow: number): Term[] => {
      const terms: Term[] = []
      for (let index = layer.rowOffsets[projectionRow]!; index < layer.rowOffsets[projectionRow + 1]!; index++) {
        terms.push({weight: layer.weights[index]!, position: layer.inputIndices[layer.columns[index]!]!})
      }
      return terms
    }
    for (let row = 0; row < layer.outputSize; row++) {
      const position = available + row
      const read = readByRow.get(row)
      const gateProjection = gateProjectionByRow.get(row)
      if (read !== undefined) {
        invariant(gateProjection === undefined && !booleanRows.has(row), 'an index read row is neither a gate row nor a boolean row')
        const last = read.candidateBase + (read.candidateCount - 1) * read.candidateStride
        const computed = read.candidatePositions.length > 0
          ? read.candidatePositions.some(candidate => candidate >= program.sourceSize)
          : read.candidateBase >= program.sourceSize || last >= program.sourceSize
        invariant(!computed, 'an index read whose candidates are computed values isn\'t emitted, only one whose candidates are source cells')
        invariant(read.candidatePositions.length === 0, 'an index read whose source cells aren\'t evenly spaced isn\'t emitted')
        rows.push({
          kind: 'index', position, indexBias: layer.bias[read.indexRow]!, indexTerms: termsOf(read.indexRow), belowZero: read.belowZero, aboveZero: read.aboveZero,
          candidateCount: read.candidateCount, candidateBase: read.candidateBase, candidateStride: read.candidateStride,
        })
      } else if (gateProjection !== undefined) {
        invariant(!booleanRows.has(row), 'a gate row isn\'t a boolean row')
        rows.push({kind: 'reglu', position, bias: layer.bias[row]!, terms: termsOf(row), gateBias: layer.bias[gateProjection]!, gateTerms: termsOf(gateProjection)})
      } else {
        rows.push({kind: booleanRows.has(row) ? 'boolean' : 'affine', position, bias: layer.bias[row]!, terms: termsOf(row)})
      }
    }
    available += layer.outputSize
  }
  invariant(available === program.valueCount, 'the layers hold every live value')
  return rows
}

// The packed position of each wire. A source wire's position is the wire itself.
export function positionsOfWires(program: TensorProgram, wires: readonly number[]): number[] {
  const positionOfWire = new Int32Array(program.width).fill(-1)
  for (let position = 0; position < program.valueCount; position++) positionOfWire[program.wireOrder[position]!] = position
  return wires.map(wire => {
    const position = positionOfWire[wire]
    invariant(position !== undefined && position >= 0, `wire ${wire} isn't a live value of this program`)
    return position
  })
}

const lowestFloat32 = -3.4028234663852886e38

// A float32 value as one WGSL literal with the exact bits, like codegen's wgslFloat. WGSL folds an expression of two
// literals in 64 bits, so no statement combines two literals.
export function wgslFloat(value: number): string {
  invariant(Number.isFinite(value) && Math.fround(value) === value, 'a WGSL literal must be a finite float32 value')
  if (Object.is(value, -0)) return '(-0.0f)'
  if (Number.isInteger(value) && Math.abs(value) < 2 ** 24) return value < 0 ? `(${value}.0f)` : `${value}.0f`
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, Math.abs(value))
  const bits = view.getUint32(0)
  const exponentBits = (bits >>> 23) & 0xff
  const fraction = ((bits & 0x7fffff) << 1).toString(16).padStart(6, '0')
  const magnitude = exponentBits === 0 ? `0x0.${fraction}p-126f` : `0x1.${fraction}p${exponentBits - 127}f`
  return value < 0 ? `(-${magnitude})` : magnitude
}

const isPowerOfTwo = (magnitude: number) => magnitude > 0 && Number.isInteger(Math.log2(magnitude))
// A candidate table may run backwards, e.g. a reversed run of cells has a stride of -1.
export const wgslInt = (value: number) => value < 0 ? `(${value}i)` : `${value}i`

export type Guard = 'none' | 'max'

type WgslOptions = {
  // The source wires that differ per instance, in the order of the instance buffer's columns.
  instanceCells: readonly number[]
  // Each group's wires are written to that group's output buffer, in order.
  outputGroups: readonly (readonly number[])[]
  workgroupSize?: number
  guard?: Guard
}

export type WgslModule = {
  code: string
  workgroupSize: number
  guard: Guard
  // The `let` statements and output writes, without the fixed lines around them.
  statementCount: number
  bytes: number
  // The shared buffer holds the source table, then the lowest float32 value at lowestOffset.
  sharedLength: number
  lowestOffset: number
  cellsPerInstance: number
  // Values per instance in each output buffer.
  outputCounts: number[]
  rowCounts: {affine: number, reglu: number, boolean: number, index: number}
  guards: number
  // Weights and biases that are integers of 2^24 or more, or not integers, e.g. a sign cascade's weights of 2^24.
  largeIntegerLiterals: number
  fractionalLiterals: number
}

// A sum of more terms continues in a new statement, so that no expression nests deeper than this many guards.
const termsPerStatement = 32

export type IndexRow = Extract<Row, {kind: 'index'}>

// Writes rows as WGSL `let` statements, one row at a time, into `body`. The caller says how a source cell is read and
// where an index read's candidates are, so the same statements serve a shader that runs a whole program once per
// instance (emitWgsl below) and one that runs a program once per position inside a loop (loop-emit.ts).
export function createRowWriter(sourceSize: number, options: {
  guard: Guard
  // Goes before the name of every `let`, so that two programs in one function don't share names, e.g. 'b_' gives b_v4576.
  prefix: string
  // The text that reads the source cell at a packed position, e.g. 's12' for a shared cell that the caller hoists.
  source: (position: number) => string
  // The text that reads an index read's candidate at the clamped index.
  candidate: (row: IndexRow, clamped: string) => string
}) {
  const {guard, prefix} = options
  const body: string[] = []
  const counts = {guards: 0, largeIntegerLiterals: 0, fractionalLiterals: 0}
  const rowCounts = {affine: 0, reglu: 0, boolean: 0, index: 0}

  const literal = (value: number) => {
    if (!Number.isInteger(value)) counts.fractionalLiterals++
    else if (Math.abs(value) >= 2 ** 24) counts.largeIntegerLiterals++
    return wgslFloat(value)
  }
  const guarded = (text: string) => {
    if (guard === 'none') return text
    counts.guards++
    return `max(${text}, lowest)`
  }
  const name = (position: number) => position >= sourceSize ? `${prefix}v${position}` : options.source(position)
  // |weight| × value. A product with a power of two is exact, so fusing it into a sum changes nothing.
  const product = (term: Term) => {
    const magnitude = Math.abs(term.weight)
    if (magnitude === 1) return name(term.position)
    const text = `${literal(magnitude)} * ${name(term.position)}`
    return isPowerOfTwo(magnitude) ? text : guarded(text)
  }
  // The executor's left fold, value = fround(value + fround(weight × input)) from the bias, as an expression. With no
  // guard it's a chain that needs parentheses before a product, e.g. `2.0f + v7 - 3.0f * v9`. `partial` names the
  // statements that a long sum continues in.
  const sum = (partial: string, bias: number, terms: readonly Term[]) => {
    if (terms.length === 0) return literal(bias)
    let text = ''
    terms.forEach((term, index) => {
      const operand = product(term)
      // A bias of 0 is skipped: 0 + x is x, except that it turns -0 into +0.
      if (index === 0 && bias === 0) text = term.weight < 0 ? `-${operand}` : operand
      else text = guarded(`${index === 0 ? literal(bias) : text} ${term.weight < 0 ? '-' : '+'} ${operand}`)
      if ((index + 1) % termsPerStatement === 0 && index + 1 < terms.length) {
        const partialName = `${partial}_${(index + 1) / termsPerStatement}`
        body.push(`let ${partialName}: f32 = ${text};`)
        text = partialName
      }
    })
    return text
  }

  function write(row: Row) {
    rowCounts[row.kind]++
    const target = `${prefix}v${row.position}`
    switch (row.kind) {
      case 'affine':
        body.push(`let ${target}: f32 = ${sum(target, row.bias, row.terms)};`)
        break
      case 'boolean':
        body.push(`let ${target}: f32 = select(0.0f, 1.0f, ${sum(target, row.bias, row.terms)} >= 0.5f);`)
        break
      case 'reglu': {
        const gate = `max(0.0f, ${sum(`${prefix}g${row.position}`, row.gateBias, row.gateTerms)})`
        // fround(1 × max(0, gate)) is max(0, gate).
        if (row.terms.length === 0 && row.bias === 1) body.push(`let ${target}: f32 = ${gate};`)
        else body.push(`let ${target}: f32 = ${guarded(`(${sum(target, row.bias, row.terms)}) * ${gate}`)};`)
        break
      }
      case 'index': {
        const index = `${prefix}p${row.position}`
        body.push(`let ${index}: i32 = i32(floor(${sum(index, row.indexBias, row.indexTerms)}));`)
        const last = row.candidateCount - 1
        let read = options.candidate(row, `clamp(${index}, 0i, ${last}i)`)
        if (row.aboveZero) read = `select(${read}, 0.0f, ${index} > ${last}i)`
        if (row.belowZero) read = `select(${read}, 0.0f, ${index} < 0i)`
        body.push(`let ${target}: f32 = ${read};`)
        break
      }
    }
  }
  return {body, counts, rowCounts, name, write}
}

export function emitWgsl(program: TensorProgram, options: WgslOptions): WgslModule {
  const workgroupSize = options.workgroupSize ?? 64
  const guard = options.guard ?? 'none'
  const rows = flattenProgram(program)
  const {sourceSize} = program
  const columnOfSource = new Map<number, number>()
  options.instanceCells.forEach((wire, column) => {
    invariant(wire < sourceSize && program.wireOrder[wire] === wire, 'an instance cell must be a source wire')
    invariant(!columnOfSource.has(wire), 'an instance cell is listed once')
    columnOfSource.set(wire, column)
  })
  const outputs = options.outputGroups.map(group => positionsOfWires(program, group))
  const lowestOffset = sourceSize
  const usedColumns = new Set<number>()
  const hoisted = new Set<number>()
  const {body, counts, rowCounts, name, write} = createRowWriter(sourceSize, {
    guard, prefix: '',
    source: position => {
      const column = columnOfSource.get(position)
      if (column !== undefined) {
        usedColumns.add(column)
        return `c${column}`
      }
      hoisted.add(position)
      return `s${position}`
    },
    // Every candidate is a shared cell, or every candidate is an instance cell at evenly spaced columns.
    candidate: (row, clamped) => {
      const firstColumn = columnOfSource.get(row.candidateBase)
      if (firstColumn === undefined) {
        for (let candidate = 0; candidate < row.candidateCount; candidate++) {
          invariant(!columnOfSource.has(row.candidateBase + candidate * row.candidateStride), 'an index read\'s candidates are all shared cells or all instance cells')
        }
        return `shared_values[u32(${row.candidateBase}i + ${clamped} * ${wgslInt(row.candidateStride)})]`
      }
      const columnStride = row.candidateCount > 1 ? columnOfSource.get(row.candidateBase + row.candidateStride)! - firstColumn : 0
      for (let candidate = 0; candidate < row.candidateCount; candidate++) {
        const column = columnOfSource.get(row.candidateBase + candidate * row.candidateStride)
        invariant(column === firstColumn + candidate * columnStride, 'an index read\'s instance cells sit at evenly spaced columns')
      }
      return `instance_sources[source_base + u32(${firstColumn}i + ${clamped} * ${wgslInt(columnStride)})]`
    },
  })
  for (const row of rows) write(row)
  outputs.forEach((positions, group) => {
    positions.forEach((position, output) => body.push(`instance_outputs_${group}[output_base_${group} + ${output}u] = ${name(position)};`))
  })

  const code = [
    'struct Params {',
    '  count: u32,',
    '  pad0: u32,',
    '  pad1: u32,',
    '  pad2: u32,',
    '}',
    '@group(0) @binding(0) var<uniform> params: Params;',
    '@group(0) @binding(1) var<storage, read> shared_values: array<f32>;',
    '@group(0) @binding(2) var<storage, read> instance_sources: array<f32>;',
    ...outputs.map((_, group) => `@group(0) @binding(${3 + group}) var<storage, read_write> instance_outputs_${group}: array<f32>;`),
    '',
    `@compute @workgroup_size(${workgroupSize})`,
    'fn main(@builtin(global_invocation_id) id: vec3<u32>) {',
    'let i: u32 = id.x;',
    'if (i >= params.count) {',
    'return;',
    '}',
    // Static uses keep both bindings in the automatic pipeline layout, e.g. when no row reads a shared cell.
    '_ = arrayLength(&shared_values);',
    '_ = arrayLength(&instance_sources);',
    `let source_base: u32 = i * ${options.instanceCells.length}u;`,
    ...outputs.map((positions, group) => `let output_base_${group}: u32 = i * ${positions.length}u;`),
    ...(guard === 'max' ? [`let lowest: f32 = shared_values[${lowestOffset}u];`] : []),
    ...[...hoisted].sort((left, right) => left - right).map(position => `let s${position}: f32 = shared_values[${position}u];`),
    ...[...usedColumns].sort((left, right) => left - right).map(column => `let c${column}: f32 = instance_sources[source_base + ${column}u];`),
    ...body,
    '}',
    '',
  ].join('\n')
  return {
    code, workgroupSize, guard, statementCount: body.length, bytes: code.length, sharedLength: sourceSize + 1, lowestOffset,
    cellsPerInstance: options.instanceCells.length, outputCounts: outputs.map(positions => positions.length), rowCounts, ...counts,
  }
}

// The shared buffer's contents: the source table, with whatever the instance cells hold, which the shader doesn't read,
// then the lowest float32 value.
export function packSharedValues(module: Pick<WgslModule, 'sharedLength' | 'lowestOffset'>, source: Float32Array, target = new Float32Array(module.sharedLength)) {
  invariant(source.length === module.lowestOffset && target.length === module.sharedLength, 'the source table has the program\'s length')
  target.set(source)
  target[module.lowestOffset] = lowestFloat32
  return target
}

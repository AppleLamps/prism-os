// The same compiled program as JavaScript statements, one per operation, like lab/ui-exploration/codegen/codegen.ts, with
// index reads added: a baseline that runs the program's own operations on the CPU without the executor's loop over
// layers. Every statement keeps the executor's FP32 rounding order, so every value has the executor's bits.
import {invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type TensorProgram, type Term, flattenProgram, positionsOfWires} from './emit.ts'

// JavaScriptCore and V8 stop optimizing very large functions, so the statements are split into functions of this many
// operations.
const rowsPerFunction = 128
// A sum of more terms is written as several statements. V8's parser overflows its stack on `f(...)` nested about 660
// deep, and the highlighter's widest sum has 513 terms.
const termsPerStatement = 16

const literal = (value: number) => Object.is(value, -0) ? '-0' : String(value)

// The program's rows as functions over one array `v` of every value: the source table comes first, as in the compiled
// program, and each function writes the values of its rows.
export function compileChunks(program: TensorProgram) {
  const rows = flattenProgram(program)
  const read = (position: number) => `v[${position}]`
  const piece = (term: Term) => term.weight === 1 ? read(term.position) : term.weight === -1 ? `-${read(term.position)}` : `f(${literal(term.weight)} * ${read(term.position)})`
  // The executor's left fold as a float32 expression. `statements` receives the earlier parts of a long sum, which
  // continue through the local variable t.
  const sum = (statements: string[], bias: number, terms: readonly Term[]) => {
    if (terms.length === 0) return literal(bias)
    // fround(-0 + x) is x, and fround(+0 + x) is x + 0, which only turns -0 into +0.
    let text = Object.is(bias, -0) ? piece(terms[0]!) : bias === 0 ? `(${piece(terms[0]!)} + 0)` : `f(${literal(bias)} + ${piece(terms[0]!)})`
    for (let index = 1; index < terms.length; index++) {
      if (index % termsPerStatement === 0) {
        statements.push(`t = ${text}`)
        text = 't'
      }
      text = `f(${text} + ${piece(terms[index]!)})`
    }
    return text
  }
  const functions: string[] = []
  let current: string[] = []
  let rowsInCurrent = 0
  const flush = () => {
    if (current.length === 0) return
    functions.push(`function chunk${functions.length}(v) {\nlet t = 0\nlet p = 0\nlet g = 0\n${current.join('\n')}\n}`)
    current = []
    rowsInCurrent = 0
  }
  for (const row of rows) {
    const target = read(row.position)
    switch (row.kind) {
      case 'affine':
        current.push(`${target} = ${sum(current, row.bias, row.terms)}`)
        break
      case 'boolean':
        current.push(`${target} = f(f(${sum(current, row.bias, row.terms)} + 8388609) - 8388609)`)
        break
      case 'reglu':
        current.push(`g = Math.max(0, ${sum(current, row.gateBias, row.gateTerms)})`)
        // Storing into the Float32Array rounds the product once, like the executor's fround.
        current.push(row.terms.length === 0 && row.bias === 1 ? `${target} = g` : `${target} = ${sum(current, row.bias, row.terms)} * g`)
        break
      case 'index': {
        const last = row.candidateCount - 1
        const below = row.belowZero ? '0' : read(row.candidateBase)
        const above = row.aboveZero ? '0' : read(row.candidateBase + last * row.candidateStride)
        current.push(`p = Math.floor(${sum(current, row.indexBias, row.indexTerms)})`)
        current.push(`${target} = p < 0 ? ${below} : p > ${last} ? ${above} : v[${row.candidateBase} + p * ${row.candidateStride}]`)
        break
      }
    }
    rowsInCurrent++
    if (rowsInCurrent === rowsPerFunction) flush()
  }
  flush()
  const source = `"use strict"\nconst f = Math.fround\nreturn [\n${functions.join(',\n')}\n]`
  // The Function constructor compiles the generated source, as codegen's compileScalarProgram does.
  const compile = Reflect.construct(Function, [source]) as () => ((values: Float32Array) => void)[]
  return {chunks: compile(), sourceBytes: source.length}
}

export function emitJavaScript(program: TensorProgram, options: {instanceCells: readonly number[], outputGroups: readonly (readonly number[])[]}) {
  const {chunks, sourceBytes} = compileChunks(program)
  const cellPositions = Int32Array.from(options.instanceCells)
  const outputPositions = options.outputGroups.map(group => Int32Array.from(positionsOfWires(program, group)))
  const values = new Float32Array(program.valueCount)
  const cellCount = cellPositions.length
  return {
    sourceBytes,
    functionCount: chunks.length,
    // Runs the first `count` instances. `shared` is the source table, `cells` holds cellCount values per instance, and
    // each output group is written to its own array.
    run(shared: Float32Array, cells: Float32Array, count: number, outputs: readonly Float32Array[]) {
      invariant(shared.length === program.sourceSize, 'the source table has the program\'s length')
      values.set(shared)
      for (let instance = 0; instance < count; instance++) {
        const base = instance * cellCount
        for (let column = 0; column < cellCount; column++) values[cellPositions[column]!] = cells[base + column]!
        for (let index = 0; index < chunks.length; index++) chunks[index]!(values)
        for (let group = 0; group < outputPositions.length; group++) {
          const positions = outputPositions[group]!
          const target = outputs[group]!
          const outputBase = instance * positions.length
          for (let output = 0; output < positions.length; output++) target[outputBase + output] = values[positions[output]!]!
        }
      }
    },
  }
}

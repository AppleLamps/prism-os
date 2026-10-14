// The JSON highlighter (highlighter/highlighter.ts) compiled for many documents: the same circuit, the loop form, compiled
// once per set of outputs, so each set keeps only the operations its outputs need.
//   'summary'  valid, firstErrorPosition, truncated: 3 values per document
//   'display'  those 3, and the 512 display kinds in a second output group
// Both sets leave out firstErrorKind, depthExceeded and the bracket at the caret, whose index reads pick among values
// computed per document, which emit.ts can't write as one `let` per value. Without them no operation reads the caret.
//
// A document's cells are the 512 code points, -1 past the text, and the text's length in code points: 513 float32
// values, 2,052 bytes. Every other source cell, i.e. the caret and the 4,061 table cells, is the same for every
// document.
import {buildHighlighter, writeText} from './highlighter/highlighter.ts'
import {capacity} from './highlighter/kinds.ts'
import {type Guard, type TensorProgram, type WgslModule, emitWgsl, packSharedValues} from './emit.ts'
import {emitJavaScript} from './generated-js.ts'

export const cellsPerDocument = capacity + 1
const summaryNames = ['valid', 'firstErrorPosition', 'truncated'] as const
/** @public */
export const summaryCount = summaryNames.length
/** @public */
export const kindCount = capacity

type RootSet = 'summary' | 'display'
const rootSets: readonly RootSet[] = ['summary', 'display']

// highlighter.ts's lengthLimit, which that file doesn't export: a longer text writes this length.
const lengthLimit = 1_048_576

// Writes one document's cells at `offset`, as highlighter.ts's writeText does: the first 512 code points, -1 after them,
// and the whole text's length. A surrogate pair is one code point, and a lone surrogate is its own code point.
export function writeDocumentCells(cells: Float32Array, offset: number, text: string) {
  const unitCount = text.length
  let length = 0
  for (let index = 0; index < unitCount; index++) {
    let codePoint = text.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < unitCount) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        index++
      }
    }
    if (length < capacity) cells[offset + length] = codePoint
    length++
  }
  for (let position = Math.min(length, capacity); position < capacity; position++) cells[offset + position] = -1
  cells[offset + capacity] = Math.min(length, lengthLimit)
}

export type BatchProgram = {
  rootSet: RootSet
  program: TensorProgram
  // The source wires of one document's cells, in the order of writeDocumentCells.
  instanceCells: number[]
  // Group 0 is the summary. With 'display', group 1 is the 512 display kinds.
  outputGroups: number[][]
  outputCounts: number[]
  // The source table with an empty document in the cells.
  sharedValues: Float32Array
  sizes: {sourceCells: number, operations: number, layers: number, storedWeights: number, indexReads: number, compileMs: number}
  // The CPU executor on one source table. It returns every output, group after group, in an array that the next call
  // overwrites.
  evaluate: (source: Float32Array) => Float32Array
  // Copies document `index` of `cells` into `source`, a copy of sharedValues, for evaluate.
  writeSource: (source: Float32Array, cells: Float32Array, index: number) => Float32Array
  emitShader: (options?: {guard?: Guard, workgroupSize?: number}) => WgslModule
  // The shared buffer for a shader of emitShader.
  packShared: (shader: Pick<WgslModule, 'sharedLength' | 'lowestOffset'>) => Float32Array
  // The same operations as JavaScript statements, see generated-js.ts.
  emitJavaScript: () => ReturnType<typeof emitJavaScript>
}

// Builds the highlighter's circuit once and compiles it for each root set.
/** @public */
export function buildBatchPrograms(sets: readonly RootSet[] = rootSets) {
  const buildStarted = performance.now()
  const built = buildHighlighter('loop')
  const buildMs = performance.now() - buildStarted
  const {cells, output, circuit} = built
  const instanceCells: number[] = [...cells.codePoints, cells.textLength]
  const summary = [output.valid, output.firstErrorPosition, output.truncated]
  const sharedValues = new Float32Array(built.initialSource)
  const programs = sets.map((rootSet): BatchProgram => {
    const outputGroups = rootSet === 'summary' ? [summary] : [summary, [...output.displayKinds]]
    const compileStarted = performance.now()
    const program = circuit.compileTensorProgram(outputGroups.flat())
    const compileMs = performance.now() - compileStarted
    const wgslOptions = {instanceCells, outputGroups}
    return {
      rootSet, program, instanceCells, outputGroups, outputCounts: outputGroups.map(group => group.length), sharedValues,
      sizes: {
        sourceCells: program.sourceSize,
        operations: program.valueCount - program.sourceSize,
        layers: program.layers.length,
        storedWeights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
        indexReads: program.layers.reduce((total, layer) => total + layer.indexReads.length, 0),
        compileMs,
      },
      evaluate: circuit.createTensorProgramEvaluator(program),
      writeSource(source, documentCells, index) {
        const base = index * cellsPerDocument
        for (let column = 0; column < cellsPerDocument; column++) source[instanceCells[column]!] = documentCells[base + column]!
        return source
      },
      emitShader: (options = {}) => emitWgsl(program, {...wgslOptions, ...options}),
      packShared: shader => packSharedValues(shader, sharedValues),
      emitJavaScript: () => emitJavaScript(program, wgslOptions),
    }
  })
  return {built, buildMs, programs, writeText: (source: Float32Array, text: string) => writeText(cells, source, text, 0)}
}

/** @public */
export function buildBatchProgram(rootSet: RootSet) {
  return buildBatchPrograms([rootSet]).programs[0]!
}

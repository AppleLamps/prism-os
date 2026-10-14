// Exports a batch for the GPU step: the compiled per-paragraph program, the instance cells of `count` paragraphs, and
// pretext's line counts at each width.
//   bun lab/ui-exploration/text-walker/batch/export.ts <folder> [--size long] [--count 4096] [--formulation index-read]
//     [--widths 160,320,480] [--first-seed 0]
// Files in <folder>:
//   manifest.json             the options, the capacity, the cell layout, the output names, the program's sizes, and the files
//   program.json              the compiled TensorProgram, see serializeTensorProgram
//   instance-cells.f32        count × (2 × segments + 2) float32 values, one row per paragraph, with maxWidth = the first width
//   expected-line-counts.i32  count × widths.length int32 values: pretext's layout() line count of each paragraph at each width
//   texts.json                the paragraph texts
// In code, exportBatch returns the same things without writing files.
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {invariant} from '../../../../src/runtime/numeric-ui-core.ts'
import type {TensorProgram} from '../../codegen/codegen.ts'
import {type ParagraphSize, assertFits, batchCapacities, batchFont, batchParagraphs, expectedLineCount, lineHeight} from './paragraphs.ts'
import {type BatchProgram, type Formulation, buildBatchProgram, decodeOutputs, instanceCellCount, paragraphSourceTable, writeInstanceCells} from './programs.ts'

type SerializedTable = {table: number, type: string}

// A TensorProgram as JSON: every typed array becomes {table, type}, an index into `tables` and the array's type, e.g.
// Uint32Array. Reads of the same table share one array in the program, and one entry in `tables`.
export function serializeTensorProgram(program: TensorProgram) {
  const tables: number[][] = []
  const ids = new Map<object, number>()
  const convert = (value: unknown): unknown => {
    if (ArrayBuffer.isView(value)) {
      let id = ids.get(value)
      if (id === undefined) {
        id = tables.length
        ids.set(value, id)
        tables.push(Array.from(value as unknown as ArrayLike<number>))
      }
      return {table: id, type: value.constructor.name} satisfies SerializedTable
    }
    if (Array.isArray(value)) return value.map(convert)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, convert(entry)]))
    return value
  }
  return {program: convert(program), tables}
}

const typedArrays: Record<string, new (values: readonly number[]) => ArrayBufferView> = {
  Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array,
}

export function deserializeTensorProgram(serialized: {program: unknown, tables: number[][]}): TensorProgram {
  const restored = new Map<number, ArrayBufferView>()
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert)
    if (value !== null && typeof value === 'object') {
      if ('table' in value && 'type' in value && Object.keys(value).length === 2) {
        const {table, type} = value as SerializedTable
        let array = restored.get(table)
        if (array === undefined) {
          const constructor = typedArrays[type]
          invariant(constructor !== undefined, `unknown typed array ${type}`)
          array = new constructor(serialized.tables[table]!)
          restored.set(table, array)
        }
        return array
      }
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, convert(entry)]))
    }
    return value
  }
  return convert(serialized.program) as TensorProgram
}

export type ExportOptions = {
  size: ParagraphSize
  count: number
  formulation: Formulation
  widths: readonly number[]
  firstSeed: number
}

export function exportBatch(options: ExportOptions) {
  const capacity = batchCapacities[options.size]
  const paragraphs = batchParagraphs(options.size, options.count, options.firstSeed)
  for (const paragraph of paragraphs) assertFits(capacity, paragraph)
  invariant(options.widths.length > 0 && options.widths.every(width => width >= capacity.minimumWidth && width <= capacity.maximumWidth), `widths must lie in ${capacity.minimumWidth}..${capacity.maximumWidth}`)
  const program: BatchProgram = buildBatchProgram(options.formulation, capacity)
  const columns = instanceCellCount(capacity)
  const instanceCells = new Float32Array(options.count * columns)
  paragraphs.forEach((paragraph, index) => writeInstanceCells(instanceCells, index * columns, capacity, paragraph, options.widths[0]!))
  const expectedLineCounts = new Int32Array(options.count * options.widths.length)
  paragraphs.forEach((paragraph, index) => {
    options.widths.forEach((width, widthIndex) => {
      expectedLineCounts[index * options.widths.length + widthIndex] = expectedLineCount(paragraph, width)
    })
  })
  // The exported program must give the exported counts, e.g. for the first 16 paragraphs at every width.
  for (let index = 0; index < Math.min(16, options.count); index++) {
    options.widths.forEach((width, widthIndex) => {
      const outputs = decodeOutputs(program, program.compiled.evaluate(paragraphSourceTable(program, paragraphs[index]!, width)))
      invariant(outputs.lineCount === expectedLineCounts[index * options.widths.length + widthIndex] && outputs.moreLinesThanSlots + outputs.windowOverflow + outputs.runOverflow === 0, `the program doesn't give pretext's line count for paragraph ${index} at ${width} px`)
    })
  }
  const tensorProgram = program.compiled.circuit.tensorProgram!
  const manifest = {
    ...options,
    capacity,
    font: batchFont,
    lineHeight,
    pretext: '@chenglou/pretext 1.0.0 with lab/ui-exploration/text-walker/fake-canvas.ts\'s fakeTextWidth',
    sourceSize: program.fc.circuit.sourceSize,
    cellLayout: 'source table: cell 0 is the constant 1, then one paragraph\'s instance cells. Instance cells: maxWidth, startCursor, widths[0..segments - 1], breakAfter[0..segments - 1]. A paragraph of n segments is written at the end of the widths and break-after cells, after zero-width padding, with startCursor = segments - n.',
    instanceSourceWires: program.instanceSourceWires,
    outputNames: program.outputNames,
    roots: program.compiled.roots,
    sizes: program.compiled.size,
    indexReads: program.indexReads,
    files: {
      program: 'program.json',
      instanceCells: 'instance-cells.f32',
      expectedLineCounts: 'expected-line-counts.i32',
      texts: 'texts.json',
    },
  }
  return {manifest, program, tensorProgram, instanceCells, expectedLineCounts, texts: paragraphs.map(paragraph => paragraph.text)}
}

if (import.meta.main) {
  const folder = process.argv[2]
  if (folder === undefined || folder.startsWith('--')) throw new Error('usage: bun export.ts <folder> [--size long] [--count 4096] [--formulation index-read] [--widths 160,320,480] [--first-seed 0]')
  const argument = (name: string) => {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
  }
  const exported = exportBatch({
    size: (argument('--size') ?? 'long') as ParagraphSize,
    count: Number(argument('--count') ?? 4096),
    formulation: (argument('--formulation') ?? 'index-read') as Formulation,
    widths: (argument('--widths') ?? '160,320,480').split(',').map(Number),
    firstSeed: Number(argument('--first-seed') ?? 0),
  })
  mkdirSync(folder, {recursive: true})
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(exported.manifest, null, 2))
  writeFileSync(join(folder, 'program.json'), JSON.stringify(serializeTensorProgram(exported.tensorProgram)))
  writeFileSync(join(folder, 'instance-cells.f32'), exported.instanceCells)
  writeFileSync(join(folder, 'expected-line-counts.i32'), exported.expectedLineCounts)
  writeFileSync(join(folder, 'texts.json'), JSON.stringify(exported.texts))
  console.log(JSON.stringify({folder, ...exported.manifest.sizes, count: exported.manifest.count}))
}

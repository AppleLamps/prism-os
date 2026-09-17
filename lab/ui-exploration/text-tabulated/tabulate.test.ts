import {expect, test} from 'bun:test'
import {installFakeCanvas} from './fake-canvas.ts'
import {createRandom, nextFloat32Down, nextFloat32Up} from './float32.ts'
import {measureLineStats, prepareWithSegments, type PrepareOptions} from './pretext/layout.ts'
import {measureBlock, tabulateBlock, type BlockSpec, type BlockTable} from './tabulate.ts'
import {SourceLayout, allocateBlockGatherCells, emitBlockDeltaRows, type BlockOutputs} from './step-circuit.ts'
import type {Circuit, Wire} from '../../../src/runtime/numeric-ui-core.ts'

installFakeCanvas('blink')

const font = '16px Test Sans'
const outputs: BlockOutputs = {lineCount: true, maxLineWidth: true, layoutWidth: false, cursors: true, lineWidths: true}

const samples: {name: string, text: string, options?: PrepareOptions, from: number, to: number}[] = [
  {name: 'plain paragraph', text: 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs! Sphinx of black quartz, judge my vow.', from: 60, to: 700},
  {name: 'soft hyphen, URL, emergency breaks', text: 'Mina replied: trans­atlantic labels at https://example.com/reports/q3-final-draft?lang=ar are still weird.', from: 8, to: 700},
  {name: 'pre-wrap tabs and newlines', text: 'name\tvalue\nwidth\t320px\n\nheight\t20px and a longer tail', options: {whiteSpace: 'pre-wrap'}, from: 8, to: 400},
  {name: 'letter spacing', text: 'Letter spaced words wrap here and there', options: {letterSpacing: 1.5}, from: 8, to: 500},
  {name: 'mixed CJK', text: 'AGI 春天到了. 中文标签 and more 漢字かな交じり文', from: 8, to: 400},
]

function expectedRow(table: BlockTable, spec: BlockSpec, width: number): number[] {
  const direct = measureBlock(spec, width)
  const stats = measureLineStats(spec.prepared, width)
  const endId = table.cursors.length - 1
  const idOf = (segmentIndex: number, graphemeIndex: number) => {
    const id = table.cursors.findIndex(cursor => cursor.segmentIndex === segmentIndex && cursor.graphemeIndex === graphemeIndex)
    return id === -1 ? -1 : id
  }
  const row = [stats.lineCount, stats.maxLineWidth]
  for (let slot = 0; slot < table.slotCount; slot++) {
    const line = direct.lines[slot]
    row.push(line === undefined ? endId : idOf(line.startSegment, line.startGrapheme))
    row.push(line === undefined ? endId : idOf(line.endSegment, line.endGrapheme))
    row.push(line?.width ?? 0)
  }
  if (direct.lines.length > table.slotCount) row.push(-1)
  return row
}

function rootsOf(wires: ReturnType<typeof emitBlockDeltaRows>): Wire[] {
  const roots: Wire[] = [wires.lineCount!, wires.maxLineWidth!]
  for (let slot = 0; slot < wires.starts.length; slot++) roots.push(wires.starts[slot]!, wires.ends[slot]!, wires.lineWidths[slot]!)
  return roots
}

function testWidthsFor(table: BlockTable, from: number, to: number): number[] {
  const widths: number[] = []
  for (const threshold of table.thresholds) widths.push(threshold, nextFloat32Down(threshold), nextFloat32Up(threshold))
  const random = createRandom(11)
  for (let trial = 0; trial < 400; trial++) widths.push(Math.fround(from + random() * (to - from)))
  return widths
}

function countMismatches(evaluate: (source: Float32Array) => Float32Array, input: Float32Array, widthCell: Wire, table: BlockTable, spec: BlockSpec, widths: readonly number[]) {
  let mismatches = 0
  for (const width of widths) {
    input[widthCell] = width
    const actual = evaluate(input)
    const expected = expectedRow(table, spec, width)
    if (expected.length !== actual.length || expected.some((value, index) => Math.fround(value) !== actual[index])) mismatches++
  }
  return mismatches
}

for (const sample of samples) {
  test(`${sample.name}: delta rows and gathered rows match pretext at every threshold and one ulp around it`, () => {
    const prepared = prepareWithSegments(sample.text, font, sample.options)
    const spec: BlockSpec = {prepared, mode: 'plain', maxWidthAt: width => width}
    const table = tabulateBlock(spec, sample.from, sample.to, 1)
    expect(table.thresholds.length).toBeGreaterThan(0)
    const widths = testWidthsFor(table, sample.from, sample.to)
    for (const mode of ['delta', 'gather'] as const) {
      const source = new SourceLayout()
      const widthCell = source.cell('width', 100, 0, 8192)
      const allocation = mode === 'gather' ? allocateBlockGatherCells(source, 'block', table, outputs) : null
      const circuit: Circuit = source.createCircuit()
      const wires = allocation === null ? emitBlockDeltaRows(circuit, widthCell, table, outputs) : allocation.emit(circuit, widthCell)
      const evaluate = circuit.createTensorEvaluator(rootsOf(wires))
      expect(countMismatches(evaluate, source.table(), widthCell, table, spec, widths)).toBe(0)
    }
  })
}

test('gathered rows take an edited paragraph without recompiling, within capacity', () => {
  const originalText = 'Tables live in source cells, so editing text rewrites cells and keeps the compiled circuit.'
  const editedText = 'Tables live in source cells, so editing this text rewrites cells and keeps the same compiled circuit!'
  const from = 60
  const to = 600
  const original: BlockSpec = {prepared: prepareWithSegments(originalText, font), mode: 'plain', maxWidthAt: width => width}
  const edited: BlockSpec = {prepared: prepareWithSegments(editedText, font), mode: 'plain', maxWidthAt: width => width}
  const originalTable = tabulateBlock(original, from, to, 1)
  const editedTable = tabulateBlock(edited, from, to, 1)
  const capacity = Math.max(originalTable.thresholds.length, editedTable.thresholds.length) + 8
  const slotCapacity = Math.max(originalTable.slotCount, editedTable.slotCount)
  // Pad both tables to the same slot count so they share one cell layout.
  const padSlots = (table: BlockTable): BlockTable => {
    const endId = table.cursors.length - 1
    const pad = (rows: number[][], value: number) => rows.map(row => [...row, ...Array<number>(slotCapacity - row.length).fill(value)])
    return {...table, slotCount: slotCapacity, startIds: pad(table.startIds, endId), endIds: pad(table.endIds, endId), lineWidths: pad(table.lineWidths, 0)}
  }
  const originalPadded = padSlots(originalTable)
  const editedPadded = padSlots(editedTable)
  const source = new SourceLayout()
  const widthCell = source.cell('width', 100, 0, 8192)
  const cursorCapacity = Math.max(originalTable.cursors.length, editedTable.cursors.length) + 16
  const allocation = allocateBlockGatherCells(source, 'block', originalPadded, outputs, capacity, cursorCapacity)
  const circuit: Circuit = source.createCircuit()
  const evaluate = circuit.createTensorEvaluator(rootsOf(allocation.emit(circuit, widthCell)))
  const input = source.table()
  expect(countMismatches(evaluate, input, widthCell, originalPadded, original, testWidthsFor(originalTable, from, to))).toBe(0)
  // Rewrite the cells with the edited table; unused threshold slots stay above every width.
  const edit = allocateBlockGatherCells(new SourceLayout(), 'block', editedPadded, outputs, capacity, cursorCapacity)
  allocation.thresholdCells.forEach((cell, index) => { input[cell] = editedTable.thresholds[index] ?? 8192 })
  allocation.valueCells.forEach((cells, row) => cells.forEach((cell, piece) => {
    const values = edit.rows[row]!.values
    input[cell] = values[Math.min(piece, values.length - 1)]!
  }))
  expect(countMismatches(evaluate, input, widthCell, editedPadded, edited, testWidthsFor(editedTable, from, to))).toBe(0)
})

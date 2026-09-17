// batch/gpu's shaders through codegen's strict WGSL interpreter (lab/ui-exploration/codegen/wgsl-interpreter.ts), which
// rounds every f32 operation on its own: line counts against pretext's layout() with both plans and both guards, the
// wrapping seeds of timingParagraphs, and the cells' hash. A real GPU compiler may contract or regroup; gpu/run.ts's check
// mode covers that.
import {expect, test} from 'bun:test'
import {createWgslInterpreter} from '../../../codegen/wgsl-interpreter.ts'
import {type ParagraphSize, batchCapacities, batchParagraphs, batchText, expectedLineCount, timingParagraphs} from '../paragraphs.ts'
import {instanceCellCount, writeInstanceCells} from '../programs.ts'
import {createCellsHasher, createSharedWidthWriter, sharedWidthCellCount} from './cells.ts'
import {buildBatchShader} from './shaders.ts'

// Includes a width where some span equals it exactly, e.g. 200.125 px, and both ends of the capacity.
const widths = [160, 200.125, 320, 479.75, 480]

test('both shaders give pretext\'s line counts through the WGSL interpreter', () => {
  for (const [size, count] of [['short', 12], ['long', 2]] as [ParagraphSize, number][]) {
    const capacity = batchCapacities[size]
    const paragraphs = batchParagraphs(size, count)
    const expected = paragraphs.flatMap(paragraph => widths.map(width => expectedLineCount(paragraph, width)))
    for (const guard of ['max', 'none'] as const) {
      const own = buildBatchShader(size, 'own-width', guard)
      const columns = instanceCellCount(capacity)
      expect(own.instanceSourceCount).toBe(columns)
      const cells = new Float32Array(paragraphs.length * widths.length * columns)
      paragraphs.forEach((paragraph, index) => widths.forEach((width, widthIndex) => writeInstanceCells(cells, (index * widths.length + widthIndex) * columns, capacity, paragraph, width)))
      const ownOutputs = new Float32Array(expected.length)
      createWgslInterpreter(own.code)(Float32Array.from(own.sharedValues), cells, expected.length, ownOutputs)
      expect(Array.from(ownOutputs)).toEqual(expected)

      const shared = buildBatchShader(size, 'shared-width', guard)
      const sharedColumns = sharedWidthCellCount(capacity)
      expect(shared.instanceSourceCount).toBe(sharedColumns)
      const sharedCells = new Float32Array(paragraphs.length * sharedColumns)
      const writeShared = createSharedWidthWriter(capacity)
      paragraphs.forEach((paragraph, index) => writeShared(sharedCells, index * sharedColumns, paragraph))
      const sharedValues = Float32Array.from(shared.sharedValues)
      const interpret = createWgslInterpreter(shared.code)
      const sharedOutputs = new Float32Array(paragraphs.length)
      widths.forEach((width, widthIndex) => {
        sharedValues[shared.maxWidthOffset] = width
        interpret(sharedValues, sharedCells, paragraphs.length, sharedOutputs)
        expect(Array.from(sharedOutputs)).toEqual(paragraphs.map((_, index) => expected[index * widths.length + widthIndex]!))
      })
    }
  }
}, 60_000)

test('timingParagraphs wraps its seeds after 65,535, and the cells hash doesn\'t depend on how the cells are split', () => {
  const [last, first] = timingParagraphs('short', 2, 65_535)
  expect(last!.text).toBe(batchText('short', 65_535))
  expect(first!.text).toBe(batchText('short', 0))
  const capacity = batchCapacities.short
  const columns = instanceCellCount(capacity)
  const paragraphs = batchParagraphs('short', 5)
  const cells = new Float32Array(paragraphs.length * columns)
  paragraphs.forEach((paragraph, index) => writeInstanceCells(cells, index * columns, capacity, paragraph, 320))
  const whole = createCellsHasher()
  whole.add(cells)
  const split = createCellsHasher()
  split.add(cells.subarray(0, 2 * columns))
  split.add(cells.subarray(2 * columns))
  expect(split.value()).toBe(whole.value())
})

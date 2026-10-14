import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit} from '../../src/runtime/numeric-ui-core.ts'
import {createWindowManagerMachine} from '../../src/handwiredos/window-manager.ts'
import {createMonitorFooter, frameTimeScale, frameTimesPath, measureProgram} from '../../src/handwiredos/monitor-footer.ts'

// The bytes of every typed array that a compiled program holds, each array once,
// found by walking the program's own fields.
function bytesOfEveryArray(program: object) {
  const arrays = new Set<ArrayBufferView>()
  const visit = (value: unknown) => {
    if (ArrayBuffer.isView(value)) arrays.add(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit)
  }
  visit(program)
  let bytes = 0
  for (const array of arrays) bytes += array.byteLength
  return bytes
}

// A stand-in for an element that createMonitorFooter writes into: the markup it is given,
// and one part per selector that the monitor asks for, with the part's text and
// attributes.
function createFakeElement() {
  const parts = new Map<string, {textContent: string, attributes: Record<string, string>, setAttribute: (name: string, value: string) => void}>()
  const part = (selector: string) => {
    let found = parts.get(selector)
    if (found === undefined) {
      const attributes: Record<string, string> = {}
      found = {textContent: '', attributes, setAttribute: (name, value) => {
        attributes[name] = value
      }}
      parts.set(selector, found)
    }
    return found
  }
  return {innerHTML: '', querySelector: part, part}
}

test('the footer shows the program\'s layers, stored weights and size, and draws each frame\'s time', () => {
  const program = createWindowManagerMachine().tensorProgram
  const footer = createFakeElement()
  const monitor = createMonitorFooter(footer as unknown as HTMLElement, program)
  const count = (value: number) => value.toLocaleString('en-US')
  // The counts are the compiled program's, in the order in which a narrow footer keeps them.
  const {weights, bytes} = measureProgram(program)
  assert.deepEqual(
    [...footer.innerHTML.matchAll(/<li title="[^"]+"><b>([^<]+)<\/b> ([^<]+)<\/li>/g)].map(([, shown, noun]) => [shown, noun]),
    [[count(program.layers.length), 'layers'], [count(weights), 'weights'], [`${Math.round(bytes / 1000)}`, 'KB']],
  )
  assert.ok(bytes > 100_000 && bytes < 999_500, `${bytes} bytes`)

  // A frame's time: the figure beside the chart, the chart's line up to its right
  // edge, and what a pointer that rests on the chart reads, which names the scale.
  const caption = (scale: number) => `The program's time in each of the last 60 frames, from 0 at the chart's bottom to ${scale} ms at its top.`
  monitor.update(0.3)
  assert.equal(footer.part('.monitor-frame-time').textContent, '0.30')
  assert.equal(footer.part('.monitor-chart .line').attributes['d'], 'M59 0.700')
  assert.equal(footer.part('.monitor-chart .area').attributes['d'], 'M59 0.700V1H59Z')
  assert.equal(footer.part('.monitor-chart .end').attributes['d'], 'M59 0.700h0')
  assert.equal(footer.part('.monitor-frame').attributes['title'], caption(1))
  // A longer frame moves the scale to 5 ms, and the earlier frame's point with it.
  monitor.update(3.2)
  assert.equal(footer.part('.monitor-frame-time').textContent, '3.20')
  assert.equal(footer.part('.monitor-chart .line').attributes['d'], 'M58 0.940L59 0.360')
  assert.equal(footer.part('.monitor-frame').attributes['title'], caption(5))
  // The chart keeps the last 60 frames: once the long frame has left it, the scale is 1 ms again.
  for (let frame = 0; frame < 60; frame++) monitor.update(0.5)
  assert.equal(footer.part('.monitor-chart .line').attributes['d'], `M${Array.from({length: 60}, (_, index) => `${index} 0.500`).join('L')}`)
  assert.equal(footer.part('.monitor-frame').attributes['title'], caption(1))
})

test('Monitor\'s size of the program counts every array once, also a table that many index reads share', () => {
  // HandwiredOS: on October 13, 2026 the Notes flow reads 5 tables with 2,320 index
  // reads, and every read of a table points at the same array of the table's
  // positions. Counted once per read, those arrays would add up to about 1.06 MB,
  // twice the rest of the program.
  const program = createWindowManagerMachine().tensorProgram
  const {weights, bytes} = measureProgram(program)
  assert.equal(weights, program.layers.reduce((sum, layer) => sum + layer.weights.length, 0))
  assert.equal(bytes, bytesOfEveryArray(program))
  const indexReads = program.layers.flatMap(layer => layer.indexReads)
  const tables = new Set(indexReads.map(read => read.candidatePositions))
  assert.ok(indexReads.length > 100 * tables.size, `${indexReads.length} index reads of ${tables.size} tables`)
  // What the old sum added for the shared tables alone is more than the whole program.
  const perRead = indexReads.reduce((sum, read) => sum + read.candidatePositions.byteLength, 0)
  assert.ok(perRead > bytes, `${perRead} bytes counted per read, ${bytes} bytes in all`)

  // Two reads of one table of 4 computed values, and one read of another table: the
  // first table's positions are counted once. The values are listed out of the order
  // in which the program computes them, since a table whose values lie at even steps
  // in the program stores no positions.
  const circuit = new Circuit(6)
  const cells = [0, 1, 2, 3].map(slot => circuit.source(slot))
  for (const cell of cells) circuit.assumeRange(cell, 0, 4096)
  const doubled = cells.map(cell => circuit.affine([[cell, 2]]))
  const tripled = cells.map(cell => circuit.affine([[cell, 3]]))
  const doubledTable = [doubled[0]!, doubled[2]!, doubled[1]!, doubled[3]!]
  const tripledTable = [tripled[3]!, tripled[0]!, tripled[2]!, tripled[1]!]
  const [first, second] = [4, 5].map(slot => {
    const index = circuit.source(slot)
    circuit.assumeRange(index, 0, 3)
    return index
  })
  const small = circuit.compileTensorProgram([
    circuit.indexRead(first!, doubledTable),
    circuit.indexRead(second!, doubledTable),
    circuit.indexRead(first!, tripledTable),
  ])
  const smallReads = small.layers.flatMap(layer => layer.indexReads)
  assert.equal(smallReads.length, 3)
  assert.equal(smallReads[0]!.candidatePositions, smallReads[1]!.candidatePositions)
  assert.notEqual(smallReads[0]!.candidatePositions, smallReads[2]!.candidatePositions)
  assert.equal(smallReads[0]!.candidatePositions.length, 4)
  assert.equal(measureProgram(small).bytes, bytesOfEveryArray(small))
})

test('the frame time chart\'s scale is the smallest of 1, 2, 5, 10 ms and so on that holds the longest frame', () => {
  assert.equal(frameTimeScale(0), 1)
  assert.equal(frameTimeScale(0.4), 1)
  assert.equal(frameTimeScale(1), 1)
  assert.equal(frameTimeScale(1.1), 2)
  assert.equal(frameTimeScale(3.2), 5)
  assert.equal(frameTimeScale(5), 5)
  assert.equal(frameTimeScale(7), 10)
  assert.equal(frameTimeScale(16.7), 20)
  assert.equal(frameTimeScale(180), 200)
})

test('the frame time chart\'s line ends at the right edge, with 0 ms at the bottom', () => {
  assert.equal(frameTimesPath([0.5], 60, 1), 'M59 0.500')
  assert.equal(frameTimesPath([0.5, 1], 60, 1), 'M58 0.500L59 0.000')
  assert.equal(frameTimesPath([0, 0.25, 2], 60, 2), 'M57 1.000L58 0.875L59 0.000')
  // A time above the scale stays at the top.
  assert.equal(frameTimesPath([3], 60, 2), 'M59 0.000')
  // A full chart starts at the left edge.
  assert.ok(frameTimesPath(Array<number>(60).fill(0.1), 60, 1).startsWith('M0 0.900L1 0.900'))
})

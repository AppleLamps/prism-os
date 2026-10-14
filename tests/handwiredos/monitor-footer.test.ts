import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit} from '../../src/runtime/numeric-ui-core.ts'
import {createWindowManagerMachine} from '../../src/handwiredos/window-manager.ts'
import {averageFrameTimes, createMonitorFooter, frameTimeScale, frameTimesPath, measureProgram} from '../../src/handwiredos/monitor-footer.ts'

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

test('the footer shows the program\'s layers, stored weights and size, and draws the frames\' times as averages of 10 frames', () => {
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
  assert.ok(bytes > 50_000 && bytes < 999_500, `${bytes} bytes`)

  // The first frame: the number beside the chart, the chart's line up to its right
  // edge, and what a pointer that rests on the chart reads, which names the scale.
  const caption = (scale: string) => `The program's time per frame. A browser's clock counts in steps of 0.1 ms or more, so each of the chart's 60 points, and the number beside it, is the average of the 10 frames up to it. The chart goes from 0 at its bottom to ${scale} ms at its top.`
  monitor.update(0.3)
  assert.equal(footer.part('.monitor-frame-time').textContent, '0.30')
  assert.equal(footer.part('.monitor-chart .line').attributes['d'], 'M59 0.400')
  assert.equal(footer.part('.monitor-chart .area').attributes['d'], 'M59 0.400V1H59Z')
  assert.equal(footer.part('.monitor-chart .end').attributes['d'], 'M59 0.400h0')
  assert.equal(footer.part('.monitor-frame').attributes['title'], caption('0.5'))
  // A second frame of 0.1 ms: the last point and the number are the two frames'
  // average, 0.2 ms, and the first point stays the first frame's 0.3 ms.
  monitor.update(0.1)
  assert.equal(footer.part('.monitor-frame-time').textContent, '0.20')
  assert.equal(footer.part('.monitor-chart .line').attributes['d'], 'M58 0.400L59 0.600')
  assert.equal(footer.part('.monitor-chart .end').attributes['d'], 'M59 0.600h0')
  // The difference of two readings of a clock with 0.1 ms steps is 0.1 ms give or
  // take a rounding error, e.g. 0.1 + 1e-13. A time is kept in whole µs, so ten such
  // frames average exactly 100 µs: the number reads 0.10, and the point lies at a
  // fifth of the 0.5 ms scale, which the chart's first two points still need.
  for (let frame = 0; frame < 10; frame++) monitor.update(frame % 2 === 0 ? 0.1 + 1e-13 : 0.1 - 1e-13)
  assert.equal(footer.part('.monitor-frame-time').textContent, '0.10')
  assert.equal(footer.part('.monitor-chart .end').attributes['d'], 'M59 0.800h0')
  assert.equal(footer.part('.monitor-frame').attributes['title'], caption('0.5'))
  // One frame of 3.2 ms raises the average of the 10 frames up to it to 0.41 ms, and
  // the 9 points after it too: the chart shows a step, as high as the frame was long
  // and 10 frames wide.
  monitor.update(3.2)
  assert.equal(footer.part('.monitor-frame-time').textContent, '0.41')
  assert.equal(footer.part('.monitor-frame').attributes['title'], caption('0.5'))
  for (let frame = 0; frame < 9; frame++) monitor.update(0.1)
  assert.equal(footer.part('.monitor-frame-time').textContent, '0.41')
  monitor.update(0.1)
  assert.equal(footer.part('.monitor-frame-time').textContent, '0.10')
  // The chart keeps the last 60 points: once the step has left it, every point is
  // 0.1 ms, at the top of a scale of 0.1 ms.
  for (let frame = 0; frame < 60; frame++) monitor.update(0.1)
  assert.equal(footer.part('.monitor-chart .line').attributes['d'], `M${Array.from({length: 60}, (_, index) => `${index} 0.000`).join('L')}`)
  assert.equal(footer.part('.monitor-frame').attributes['title'], caption('0.1'))
  // Frames of 12 ms: the number has three digits, and the scale is 20 ms.
  for (let frame = 0; frame < 10; frame++) monitor.update(12.34)
  assert.equal(footer.part('.monitor-frame-time').textContent, '12.3')
  assert.equal(footer.part('.monitor-frame').attributes['title'], caption('20'))
})

test('a point of the frame time chart is the average of the 10 frames up to it, or of the frames there are', () => {
  assert.deepEqual(averageFrameTimes([0, 100, 200], 2, 2), [50, 150])
  assert.deepEqual(averageFrameTimes([0, 100, 200], 60, 10), [0, 50, 100])
  // 69 frames, of which the first takes 2,300 µs and the others 100 µs: the chart's
  // 60 points start at the tenth frame, whose average is the last to hold the first
  // frame.
  const times = [2300, ...Array<number>(68).fill(100)]
  const points = averageFrameTimes(times, 60, 10)
  assert.equal(points.length, 60)
  assert.deepEqual([points[0], points[1], points[59]], [320, 100, 100])
  // With 3 more frames before them, no point holds one of the first three frames.
  assert.ok(averageFrameTimes([2300, 400, 300, ...Array<number>(69).fill(100)], 60, 10).every(point => point === 100))
})

test('Monitor\'s size of the program counts every array once, also a table that many index reads share', () => {
  const program = createWindowManagerMachine().tensorProgram
  const {weights, bytes} = measureProgram(program)
  assert.equal(weights, program.layers.reduce((sum, layer) => sum + layer.weights.length, 0))
  assert.equal(bytes, bytesOfEveryArray(program))

  // HandwiredOS reads no table by index, so the shared tables are a program of this
  // test's: 2 tables of 32 computed values, one read by index 200 times and the other
  // once. Every read of a table points at the same array of the table's positions.
  // Each table lists its values in pairs that are swapped against the order in which
  // the program computes them, since a table whose values lie at even steps in the
  // program stores no positions.
  const circuit = new Circuit(34)
  const cells = Array.from({length: 32}, (_, slot) => circuit.source(slot))
  for (const cell of cells) circuit.assumeRange(cell, 0, 4096)
  const doubled = cells.map(cell => circuit.affine([[cell, 2]]))
  const tripled = cells.map(cell => circuit.affine([[cell, 3]]))
  const doubledTable = doubled.map((_, slot) => doubled[slot ^ 1]!)
  const tripledTable = tripled.map((_, slot) => tripled[slot ^ 1]!)
  const [first, second] = [32, 33].map(slot => {
    const index = circuit.source(slot)
    circuit.assumeRange(index, 0, 31)
    return index
  })
  const small = circuit.compileTensorProgram([
    ...Array.from({length: 200}, (_, offset) => circuit.indexReadAffine([[first!, 1]], offset, doubledTable, 'clamp', 'clamp')),
    circuit.indexRead(second!, tripledTable),
  ])
  const smallReads = small.layers.flatMap(layer => layer.indexReads)
  assert.equal(smallReads.length, 201)
  assert.equal(new Set(smallReads.map(read => read.candidatePositions)).size, 2)
  assert.equal(smallReads[0]!.candidatePositions, smallReads[199]!.candidatePositions)
  assert.notEqual(smallReads[0]!.candidatePositions, smallReads[200]!.candidatePositions)
  assert.equal(smallReads[0]!.candidatePositions.length, 32)
  const smallBytes = measureProgram(small).bytes
  assert.equal(smallBytes, bytesOfEveryArray(small))
  // Counted once per read, the tables' positions alone would be more than the whole program.
  const perRead = smallReads.reduce((sum, read) => sum + read.candidatePositions.byteLength, 0)
  assert.ok(perRead > smallBytes, `${perRead} bytes counted per read, ${smallBytes} bytes in all`)
})

test('the frame time chart\'s scale is the smallest of 0.1, 0.2, 0.5, 1, 2, 5 ms and so on that holds the highest point', () => {
  // In µs.
  assert.equal(frameTimeScale(0), 100)
  assert.equal(frameTimeScale(40), 100)
  assert.equal(frameTimeScale(100), 100)
  assert.equal(frameTimeScale(101), 200)
  assert.equal(frameTimeScale(160), 200)
  assert.equal(frameTimeScale(320), 500)
  assert.equal(frameTimeScale(1_000), 1_000)
  assert.equal(frameTimeScale(1_100), 2_000)
  assert.equal(frameTimeScale(3_200), 5_000)
  assert.equal(frameTimeScale(7_000), 10_000)
  assert.equal(frameTimeScale(16_700), 20_000)
  assert.equal(frameTimeScale(180_000), 200_000)
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

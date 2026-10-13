import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit, emitMultiply} from '../../src/runtime/numeric-ui-core.ts'
import {createWindowManagerMachine} from '../../src/handwiredos/window-manager.ts'
import {describeOperations} from '../../src/handwiredos/files.ts'
import {countOperationKinds, createMonitor, frameTimeScale, frameTimesPath, measureProgram} from '../../src/handwiredos/monitor.ts'

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

test('Monitor counts HandwiredOS\'s operations by kind as the circuit names them', () => {
  const machine = createWindowManagerMachine()
  const program = machine.tensorProgram
  // The kind of every operation that the compiler kept, read from the circuit.
  const built = {affine: 0, reglu: 0, boolean: 0, index: 0}
  for (let packed = program.sourceSize; packed < program.valueCount; packed++) {
    built[machine.circuit.operations[program.wireOrder[packed]! - program.sourceSize]!.kind]++
  }
  const kinds = countOperationKinds(program)
  // A gather read is an affine operation that the compiler turned into a read.
  assert.equal(kinds.affine + kinds.gatherReads, built.affine)
  assert.equal(kinds.reglu, built.reglu)
  assert.equal(kinds.boolean, built.boolean)
  assert.equal(kinds.indexReads, built.index)
  assert.ok(kinds.affine > 0 && kinds.gatherReads > 0 && kinds.reglu > 0 && kinds.boolean > 0)
})

test('Monitor counts index reads and gather reads apart from affine operations', () => {
  // 4 bits declared one-hot, 4 values, one sum of bit × value, which the compiler
  // turns into a gather read, one index read of the values, one boolean, and one
  // sum of the three.
  const circuit = new Circuit(10)
  const bits = [0, 1, 2, 3].map(slot => circuit.source(slot))
  const values = [4, 5, 6, 7].map(slot => circuit.source(slot))
  circuit.assumeOneHot(bits)
  for (const value of values) circuit.assumeRange(value, 0, 4096)
  const selected = circuit.affine(bits.map((bit, slot) => [emitMultiply(circuit, bit, values[slot]!), 1]))
  const index = circuit.source(8)
  circuit.assumeRange(index, 0, 3)
  const read = circuit.indexRead(index, values)
  const score = circuit.source(9)
  circuit.assumeRange(score, 0, 1)
  const rounded = circuit.boolean(score)
  const sum = circuit.roundAffine([[selected, 1], [read, 1], [rounded, 1]])
  const program = circuit.compileTensorProgram([sum])
  assert.deepEqual(countOperationKinds(program), {affine: 1, gatherReads: 1, reglu: 0, boolean: 1, indexReads: 1})

  // Without gather lowering, the masked sum and its 4 products stay.
  const dense = circuit.compileTensorProgram([sum], false)
  const denseKinds = countOperationKinds(dense)
  assert.equal(denseKinds.gatherReads, 0)
  assert.equal(denseKinds.indexReads, 1)
  assert.equal(denseKinds.boolean, 1)
  assert.equal(denseKinds.affine + denseKinds.reglu, dense.valueCount - dense.sourceSize - 2)
})

test('Monitor\'s legend and the rows of Files\' Operations location count the same four kinds', () => {
  const machine = createWindowManagerMachine()
  const program = machine.tensorProgram
  // What Files shows: one row per live operation, whose kind cell has the kind's class.
  const operations = describeOperations(program, machine.packedValues)
  const rowsByKind: Record<string, number> = {}
  for (let row = 0; row < operations.rowCount; row++) {
    const kindClass = operations.kindClass!(row)
    rowsByKind[kindClass] = (rowsByKind[kindClass] ?? 0) + 1
  }
  // What Monitor shows: the markup that createMonitor writes into its two elements,
  // which stand in for the Monitor window's content box and the system bar's counters.
  const element = () => ({innerHTML: '', querySelector: () => ({})})
  const [content, statistics] = [element(), element()]
  createMonitor({content: content as unknown as HTMLElement, statistics: statistics as unknown as HTMLElement}, program)
  const count = (text: string) => Number(text.replaceAll(',', ''))
  const legend = [...content.innerHTML.matchAll(/<li class="(kind-[a-z]+)"[^>]*><b>([\d,]+)<\/b> ([^<]+)<\/li>/g)]
    .map(([, kindClass, entryCount, name]) => ({kindClass: kindClass!, count: count(entryCount!), name: name!}))
  assert.deepEqual(legend.map(entry => [entry.kindClass, entry.name]), [['kind-affine', 'affine'], ['kind-reglu', 'ReGLU'], ['kind-boolean', 'boolean'], ['kind-index', 'index']])
  assert.deepEqual(Object.fromEntries(legend.map(entry => [entry.kindClass, entry.count])), rowsByKind)
  // The bar's segments grow by the same counts, in the same order.
  const segments = [...content.innerHTML.matchAll(/<i class="(kind-[a-z]+)" style="flex-grow: (\d+)"/g)].map(([, kindClass, grow]) => [kindClass, Number(grow)])
  assert.deepEqual(segments, legend.map(entry => [entry.kindClass, entry.count]))
  // The two totals, in Monitor's figures and in the system bar, are Files' row count.
  assert.equal(count(/<dt>Operations<\/dt><dd>([\d,]+)<\/dd>/.exec(content.innerHTML)![1]!), operations.rowCount)
  assert.equal(count(/<b>([\d,]+)<\/b> operations/.exec(statistics.innerHTML)![1]!), operations.rowCount)
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

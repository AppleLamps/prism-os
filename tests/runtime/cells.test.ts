import {expect, test} from 'bun:test'
import {
  type CellWires,
  type SourceTable,
  anyNumber,
  constant,
  createEvaluator,
  createSourceTable,
  event,
  input,
  inputBit,
  list,
  oneHot,
  permutation,
  state,
  stateBit,
} from '../../src/runtime/cells.ts'
import {type Circuit, type Wire, asWire, emitCompare, emitSelect} from '../../src/runtime/numeric-ui-core.ts'

// One cell of every kind, a one-hot group, a permutation, and a cell declared in a second call under a name.
function smallTable() {
  const table = createSourceTable()
  const cells = table.declare({
    margin: constant(12, [0, 64]),
    width: input([0, 100], {initial: 40, grid: 1}),
    click: event(),
    snap: inputBit(),
    count: state([0, 10], {initial: 2}),
    open: stateBit(1),
    choice: oneHot(list(3, index => stateBit(Number(index === 1)))),
    order: permutation([2, 0, 1]),
  })
  const child = table.declare({velocity: state(anyNumber)}, 'child')
  // Every state cell except count, each one keeping its value.
  const keep = {open: cells.open, choice: cells.choice, order: cells.order, child}
  return {table, cells, keep}
}

test('positions follow declaration order, and a name prefixes the cells of a later call', () => {
  const {table, cells, keep} = smallTable()
  expect<unknown>(cells).toEqual({margin: 0, width: 1, click: 2, snap: 3, count: 4, open: 5, choice: [6, 7, 8], order: [[9, 10, 11], [12, 13, 14], [15, 16, 17]]})
  expect<number>(keep.child.velocity).toBe(18)
  expect(table.size).toBe(19)
  expect(table.nameOf(keep.child.velocity)).toBe('child.velocity')
  expect(table.nameOf(cells.order[1]![2]!)).toBe('order[1][2]')
  expect([cells.margin, cells.width, cells.click, cells.count, keep.child.velocity].map(table.policyOf)).toEqual(['constant', 'input', 'event', 'state', 'state'])
  expect(() => permutation([0, 0, 2])).toThrow('0, 0, 2 is not a permutation of 0..2')
})

test('createCircuit declares ranges, grids and one-hot groups, and finish derives next values and the initial table', () => {
  const {table, cells, keep} = smallTable()
  const circuit = table.createCircuit()
  expect(circuit.ranges[cells.width]).toEqual({minimum: 0, maximum: 100})
  expect(circuit.grids[cells.width]).toBe(1)
  // The choice group, then the permutation's three rank groups and three item groups.
  expect(circuit.oneHotGroups.length).toBe(7)
  const nextCount = circuit.affine([[cells.count, 1], [cells.click, 1]])
  table.next(cells.count, nextCount)
  table.next(keep, keep)
  const {nextSource, initialSource} = table.finish()
  // A constant or an input holds itself, an event holds the constant 0, and a state cell holds its next value.
  expect([nextSource[cells.margin], nextSource[cells.width], nextSource[cells.snap], nextSource[cells.count]]).toEqual([cells.margin, cells.width, cells.snap, nextCount])
  expect(circuit.operations[nextSource[cells.click]! - circuit.sourceSize]).toMatchObject({kind: 'affine', leftTerms: [], leftBias: 0})
  expect([...initialSource]).toEqual([12, 40, 0, 0, 2, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0])
})

test('createCircuit declares exact bits, and an operation that reads one is built as before', () => {
  const {table, cells} = smallTable()
  const circuit = table.createCircuit()
  // click, snap, open, the three choice cells and the permutation's nine cells.
  const declaredBits = circuit.exactBits.flatMap((isBit, wire) => isBit ? [wire] : [])
  expect(declaredBits).toEqual([cells.click, cells.snap, cells.open, ...cells.choice, ...cells.order.flat()])
  // A bit gets no grid from the declaration, so a sum that reads it has none, and emitCompare would still build a
  // sign cascade for the sum: assumeGrid(wire, 1) is the declaration that changes that.
  expect(circuit.grids[cells.snap]).toBe(undefined)
  const sum = circuit.affine([[cells.width, 1], [cells.snap, 1]])
  expect([circuit.grids[sum], circuit.exactBits[sum], circuit.ranges[sum]]).toEqual([undefined, false, {minimum: 0, maximum: 101}])
  // The declaration narrows the range to 0..1, and a range outside 0..1 contradicts it.
  circuit.assumeBit(cells.margin)
  expect([circuit.ranges[cells.margin], circuit.exactBits[cells.margin]]).toEqual([{minimum: 0, maximum: 1}, true])
  expect(() => circuit.assumeBit(circuit.affine([[cells.count, 1]], 5))).toThrow('numeric range contradicts known bounds')
})

test('a program built over exact bits has the operations and the compiled layers of the same program built over cells within 0..1', () => {
  // The same builder code twice: once with the three bits declared with inputBit, once as plain cells within 0..1.
  const build = (bit: () => ReturnType<typeof inputBit>) => {
    const table = createSourceTable()
    const cells = table.declare({enabled: bit(), flags: list(4, bit), row: input([0, 3], {grid: 1}), width: input([0, 100], {grid: 1 / 64}), limit: input([0, 100])})
    const circuit = table.createCircuit()
    const flag = circuit.indexRead(cells.row, cells.flags)
    // A comparison whose operand reads a bit: with a grid on the bit, the builder would write integer bits here.
    const scaled = circuit.roundAffine([[cells.width, 1], [cells.enabled, 8]])
    const over = emitCompare(circuit, scaled, '>', cells.limit)
    const output = [circuit.reglu([[cells.width, 1]], 0, [[flag, 1], [cells.enabled, 1]], -1), over, circuit.multiply(cells.enabled, cells.width), emitSelect(circuit, flag, cells.width, cells.limit)]
    return {circuit, program: circuit.compileTensorProgram(output)}
  }
  const withBits = build(() => inputBit())
  const without = build(() => input([0, 1]))
  expect([withBits.circuit.exactBits.filter(Boolean).length, without.circuit.exactBits.filter(Boolean).length]).toEqual([5, 0])
  expect(withBits.circuit.operations.length).toBeGreaterThan(20)
  expect(withBits.circuit.operations).toEqual(without.circuit.operations)
  expect(withBits.circuit.grids).toEqual(without.circuit.grids)
  expect(withBits.program).toEqual(without.program)
})

test('a state cell without a next value, or with two, fails while building, and so does a call out of order', () => {
  const missing = smallTable()
  missing.table.createCircuit()
  missing.table.next(missing.keep, missing.keep)
  expect(() => missing.table.finish()).toThrow('count never received a next value')
  const {table, cells} = smallTable()
  expect(() => table.next(cells.count, cells.width)).toThrow('call createCircuit before table.next')
  table.createCircuit()
  expect(() => table.declare({late: event()})).toThrow('declare every cell before createCircuit')
  table.next(cells.count, cells.width)
  expect(() => table.next(cells.count, cells.width)).toThrow('count already has a next value')
  expect(() => table.next(cells.width, cells.count)).toThrow('width is not a state cell')
  expect(() => table.next(cells.open, asWire(10_000))).toThrow('the next value of open is not a wire of the circuit')
})

test('next pairs state with wires by field name, and a different shape pairs nothing', () => {
  const table = createSourceTable()
  const cells = table.declare({spring: {position: state([0, 100], {initial: 10}), velocity: state([-100, 100])}})
  const circuit = table.createCircuit()
  const nextPosition = circuit.affine([[cells.spring.position, 1], [cells.spring.velocity, 0.5]])
  const nextVelocity = circuit.affine([[cells.spring.velocity, 0.9]])
  const renamed = {position: nextPosition, speed: nextVelocity} as unknown as typeof cells.spring
  expect(() => table.next(cells.spring, renamed)).toThrow('next state has fields position, speed but the stored struct has position, velocity')
  // The object literal lists the fields in the other order.
  table.next(cells.spring, {velocity: nextVelocity, position: nextPosition})
  expect(table.finish().nextSource).toEqual([nextPosition, nextVelocity])
})

test('the validator names the cell or rule that a table breaks', () => {
  const {table, cells, keep} = smallTable()
  table.atMostOne('click or snap', [cells.click, cells.snap])
  table.createCircuit()
  table.next({count: cells.count, ...keep}, {count: cells.count, ...keep})
  const {initialSource, validate} = table.finish()
  const broken = (edit: (source: Float32Array) => void) => () => {
    const source = new Float32Array(initialSource)
    edit(source)
    validate(source)
  }
  expect(broken(source => { source[cells.width] = 101 })).toThrow('width must be finite and within 0..100, got 101')
  expect(broken(source => { source[cells.width] = 40.5 })).toThrow('width must be a multiple of 1, got 40.5')
  expect(broken(source => { source[keep.child.velocity] = Infinity })).toThrow('child.velocity must be finite')
  expect(broken(source => { source[cells.click] = 0.5 })).toThrow('click must be exactly 0 or 1, got 0.5')
  expect(broken(source => { source[cells.choice[0]!] = 1 })).toThrow('choice breaks its oneHot rule with mass 2')
  expect(broken(source => { source[cells.order[0]![2]!] = 0 })).toThrow('order rank 0 breaks its oneHot rule with mass 0')
  expect(broken(source => source.set([1, 1], cells.click))).toThrow('click or snap breaks its atMostOne rule with mass 2')
  expect(() => validate(new Float32Array(3))).toThrow('the table holds 3 numbers, but 19 cells are declared')
})

test('createEvaluator returns next values in cell order and outputs in the output shape, and checks both tables', () => {
  const table = createSourceTable()
  const cells = table.declare({press: event(), on: stateBit(), speed: state([0, 8], {initial: 2})})
  const circuit = table.createCircuit()
  // JS: if (press) on = !on; speed *= 2
  const on = emitSelect(circuit, cells.press, cells.on, circuit.affine([[cells.on, -1]], 1))
  const speed = circuit.affine([[cells.speed, 2]])
  table.next(cells.on, on)
  table.next(cells.speed, speed)
  const evaluate = createEvaluator({...table.finish(), output: {on, speed: {doubled: speed}}})
  const source = new Float32Array([1, 0, 2])
  const first = evaluate(source)
  expect([...first.nextValues]).toEqual([0, 1, 4])
  expect(first.output).toEqual({on: 1, speed: {doubled: 4}})
  source.set(first.nextValues)
  source.set(evaluate(source).nextValues)
  // The third evaluation doubles 8 to 16, past the declared range.
  expect(() => evaluate(source)).toThrow('speed must be finite and within 0..8, got 16')
  // The table is checked before the program runs: a press of 0.5 throws, although the press cell's next value is 0.
  expect(() => evaluate(new Float32Array([0.5, 0, 2]))).toThrow('press must be exactly 0 or 1, got 0.5')
})

test('createEvaluator checks that outputs are finite, and names the operation that produced a NaN', () => {
  const table = createSourceTable()
  const cells = table.declare({pressed: stateBit(1), width: input([0, 3.4e38], {initial: 3})})
  const circuit = table.createCircuit()
  table.next(cells.pressed, cells.pressed)
  // JS: pressed ? 7 : width * 2. Both sides of a select always compute, and width * 2 overflows to Infinity at 3e38.
  const doubledWidth = circuit.roundAffine([[cells.width, 2]])
  const shown = emitSelect(circuit, cells.pressed, doubledWidth, circuit.constant(7))
  const evaluate = createEvaluator({...table.finish(), output: {shown}})
  expect(evaluate(new Float32Array([1, 3])).output).toEqual({shown: 7})
  expect(() => evaluate(new Float32Array([1, 3e38]))).toThrow(/^output shown must be finite, got NaN\. wire \d+ is the first NaN: .*, in select\(gate wire 0 = 1/)
})

test('a failed check gets no NaN message when no checked value is NaN, even when an unused operation is NaN', () => {
  const table = createSourceTable()
  const cells = table.declare({pressed: stateBit(1), width: input([0, 3.4e38], {initial: 3}), speed: state([0, 8], {initial: 2})})
  const circuit = table.createCircuit()
  table.next(cells.pressed, cells.pressed)
  // Read by no next value or output, e.g. left over from an earlier version of the builder. It's NaN at width 3e38.
  emitSelect(circuit, cells.pressed, circuit.roundAffine([[cells.width, 2]]), circuit.constant(7))
  const speed = circuit.affine([[cells.speed, 2]])
  table.next(cells.speed, speed)
  const evaluate = createEvaluator({...table.finish(), output: {speed}})
  // speed doubles from 8 to 16, past its range.
  expect(() => evaluate(new Float32Array([1, 3e38, 8]))).toThrow(/^speed must be finite and within 0\.\.8, got 16$/)
})

test('a failed check gets a NaN message when the value that failed is NaN, and not for a NaN value that the check did not reach', () => {
  const table = createSourceTable()
  const cells = table.declare({
    pressed: stateBit(1),
    width: input([0, 3.4e38], {initial: 3}),
    speed: state([0, 8], {initial: 2}),
    shown: state(anyNumber),
  })
  const circuit = table.createCircuit()
  table.next(cells.pressed, cells.pressed)
  // JS: speed *= 2
  table.next(cells.speed, circuit.affine([[cells.speed, 2]]))
  // JS: shown = pressed ? 7 : width * 2. Both sides of a select always compute, so the select is NaN at width 3e38.
  const shown = emitSelect(circuit, cells.pressed, circuit.roundAffine([[cells.width, 2]]), circuit.constant(7))
  table.next(cells.shown, shown)
  const evaluate = createEvaluator({...table.finish(), output: {shown}})
  // speed doubles from 8 to 16, past its range, and the check throws there, before it reaches the NaN next value of
  // shown and the NaN output.
  expect(() => evaluate(new Float32Array([1, 3e38, 8, 0]))).toThrow(/^speed must be finite and within 0\.\.8, got 16$/)
  expect(() => evaluate(new Float32Array([1, 3e38, 2, 0]))).toThrow(
    new RegExp(`^shown must be finite and within -Infinity\\.\\.Infinity, got NaN\\. wire \\d+ is the first NaN: .*, in select\\(gate wire ${cells.pressed} = 1`),
  )
})

test('the NaN message names the first NaN that the NaN output reads, and a NaN operand of a select gets no select context', () => {
  const table = createSourceTable()
  const cells = table.declare({pressed: stateBit(1), width: input([0, 3.4e38], {initial: 3})})
  const circuit = table.createCircuit()
  table.next(cells.pressed, cells.pressed)
  // Read by no output, and NaN at width 3e38.
  emitSelect(circuit, cells.pressed, circuit.roundAffine([[cells.width, 2]]), circuit.constant(7))
  // JS: pressed ? width * 2 + width * -2 : 7. At width 3e38, the side the gate picks is Infinity - Infinity.
  const plus = circuit.roundAffine([[cells.width, 2]])
  const minus = circuit.roundAffine([[cells.width, -2]])
  const difference = circuit.roundAffine([[plus, 1], [minus, 1]])
  const shown = emitSelect(circuit, cells.pressed, circuit.constant(7), difference)
  const evaluate = createEvaluator({...table.finish(), output: {shown}})
  expect(() => evaluate(new Float32Array([1, 3e38]))).toThrow(
    new RegExp(`^output shown must be finite, got NaN\\. wire ${difference} is the first NaN: a sum of wire ${plus} = Infinity, wire ${minus} = -Infinity$`),
  )
})

test('table.next and createEvaluator refuse plain numbers where wires are expected, in the type checker', () => {
  const table = createSourceTable()
  const cells = table.declare({
    press: event(),
    on: stateBit(),
    spring: {displacement: state([-40, 40]), velocity: state([-1280, 1280])},
    pair: list(2, () => stateBit()),
    count: state([0, 10]),
    flag: stateBit(),
  })
  table.createCircuit()
  // Each call writes a position counted by hand where a wire is meant, e.g. 0 is the press cell, and 6 is the count
  // cell. At runtime, a next value is only checked to be a wire of the circuit, and a stored position to be a state
  // cell, so these calls build without an error, and `bun run check` is what refuses them.
  // @ts-expect-error a plain number as a next value
  table.next(cells.on, 0)
  // @ts-expect-error a plain number inside a next-state object
  table.next(cells.spring, {displacement: 0, velocity: cells.spring.velocity})
  // @ts-expect-error a list of plain numbers as next values
  table.next(cells.pair, [0, 0])
  // @ts-expect-error a plain number as the stored cell
  table.next(6, cells.press)
  // @ts-expect-error a plain number inside a stored object
  table.next({flag: 7}, {flag: cells.press})
  // @ts-expect-error a plain number as an output
  const evaluate = createEvaluator({...table.finish(), output: {typo: 1}})
  const result = evaluate(new Float32Array([1, 0, 5, 7, 0, 0, 3, 0]))
  // on, the spring's displacement, both pair cells, count and flag took the press cell's 1, and the output read the on
  // cell.
  expect([...result.nextValues]).toEqual([0, 1, 1, 7, 1, 1, 1, 1])
  expect<unknown>(result.output).toEqual({typo: 0})
})

// A component: its own cells, and a build function that reads a wire from its parent.
const counterCells = {count: state([0, 1000])}
function buildCounter(circuit: Circuit, table: SourceTable, counter: CellWires<typeof counterCells>, press: Wire) {
  const count = circuit.affine([[counter.count, 1], [press, 1]])
  table.next(counter, {count})
  return {count}
}

test('a component is declared nested in its parent or in a second call, and built with the parent\'s wires', () => {
  const table = createSourceTable()
  const cells = table.declare({press: event(), counters: list(2, () => counterCells)})
  const extra = table.declare(counterCells, 'extra')
  const circuit = table.createCircuit()
  const counters = [...cells.counters, extra].map(counter => buildCounter(circuit, table, counter, cells.press))
  expect([table.nameOf(cells.counters[1]!.count), table.nameOf(extra.count)]).toEqual(['counters[1].count', 'extra.count'])
  const evaluate = createEvaluator({...table.finish(), output: counters})
  expect(evaluate(new Float32Array([1, 5, 0, 7])).output).toEqual([{count: 6}, {count: 1}, {count: 8}])
})

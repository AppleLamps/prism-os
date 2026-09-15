import {expect, test} from 'bun:test'
import {anyNumber, bit, constant, createSourceTable, event, input, list, oneHot, permutation, state} from './table.ts'
import {createNotation} from './wires.ts'

function smallTable() {
  const table = createSourceTable()
  const cells = table.allocate('', {
    unit: constant(1, [1, 1]),
    width: input([0, 100], 40),
    click: event(),
    count: state([0, 10], 2),
    choice: oneHot(list(3, index => bit(Number(index === 1)))),
    order: permutation([2, 0, 1]),
  })
  const child = table.scope('child').allocate('', {velocity: state(anyNumber)})
  return {table, cells, child}
}

test('offsets follow declaration order, and scopes prefix names', () => {
  const {table, cells, child} = smallTable()
  expect(cells).toEqual({unit: 0, width: 1, click: 2, count: 3, choice: [4, 5, 6], order: [[7, 8, 9], [10, 11, 12], [13, 14, 15]]})
  expect(child.velocity).toBe(16)
  expect(table.nameOf(child.velocity)).toBe('child.velocity')
  expect(table.nameOf(cells.order[1]![2]!)).toBe('order[1][2]')
})

test('createCircuit declares ranges and one-hot groups, and finish derives writeback', () => {
  const {table, cells, child} = smallTable()
  const circuit = table.createCircuit()
  expect(circuit.ranges[cells.width]).toEqual({minimum: 0, maximum: 100})
  // One choice group plus three rank groups and three item groups.
  expect(circuit.oneHotGroups.length).toBe(7)
  const $ = createNotation(circuit, cells.unit)
  table.next(cells.count, $.sum(cells.count, cells.click))
  table.next(cells.choice, cells.choice)
  table.next(cells.order, cells.order)
  table.next(child, {velocity: $.scale(child.velocity, 0.5)})
  const {nextSource, initialSource} = table.finish()
  expect(nextSource[cells.unit]).toBe(cells.unit)
  expect(nextSource[cells.width]).toBe(cells.width)
  expect(nextSource[cells.click]).toBe($.zero)
  expect([...initialSource]).toEqual([1, 40, 0, 2, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0])
})

test('a state cell without a next value, or with two, fails while building', () => {
  const missing = smallTable()
  missing.table.createCircuit()
  expect(() => missing.table.finish()).toThrow('count never received a next value')
  const twice = smallTable()
  twice.table.createCircuit()
  twice.table.next(twice.cells.count, twice.cells.width)
  expect(() => twice.table.next(twice.cells.count, twice.cells.width)).toThrow('count already has a next value')
  expect(() => twice.table.next(twice.cells.width, twice.cells.count)).toThrow('width is not a state cell')
})

test('next pairs state with wires by field name, and a different shape fails without assigning anything', () => {
  const table = createSourceTable()
  const cells = table.allocate('', {unit: constant(1, [1, 1]), spring: {position: state([0, 100], 10), velocity: state([-100, 100])}})
  const circuit = table.createCircuit()
  const $ = createNotation(circuit, cells.unit)
  const nextPosition = $.sum(cells.spring.position, [cells.spring.velocity, 0.5])
  const nextVelocity = $.scale(cells.spring.velocity, 0.9)
  const missingField = {position: nextPosition} as unknown as typeof cells.spring
  expect(() => table.next(cells.spring, missingField)).toThrow('next state has fields position but the stored struct has position, velocity')
  const renamedField = {position: nextPosition, speed: nextVelocity} as unknown as typeof cells.spring
  expect(() => table.next(cells.spring, renamedField)).toThrow('next state has fields position, speed but the stored struct has position, velocity')
  // The object literal lists the fields in the other order.
  table.next(cells.spring, {velocity: nextVelocity, position: nextPosition})
  const {nextSource} = table.finish()
  expect(nextSource[cells.spring.position]).toBe(nextPosition)
  expect(nextSource[cells.spring.velocity]).toBe(nextVelocity)
})

test('the derived validator names the cell or group that breaks its contract', () => {
  const {table, cells, child} = smallTable()
  const circuit = table.createCircuit()
  table.next(cells.count, cells.count)
  table.next(cells.choice, cells.choice)
  table.next(cells.order, cells.order)
  table.next(child, child)
  void circuit
  const {initialSource, validate} = table.finish()
  const broken = (edit: (source: Float32Array) => void) => () => {
    const source = new Float32Array(initialSource)
    edit(source)
    validate(source)
  }
  expect(broken(source => { source[cells.width] = 101 })).toThrow('width must be finite and within 0..100')
  expect(broken(source => { source[child.velocity] = Infinity })).toThrow('child.velocity must be finite')
  expect(broken(source => { source[cells.click] = 0.5 })).toThrow('click must be exactly 0 or 1')
  expect(broken(source => { source[cells.choice[0]!] = 1 })).toThrow('choice breaks its oneHot rule with mass 2')
  expect(broken(source => { source[cells.order[0]![2]!] = 0 })).toThrow('order rank 0 breaks its oneHot rule with mass 0')
})

import {expect, test} from 'bun:test'
import {collectFrameMismatches} from '../../event-window/harness.ts'
import {createOracleState, oracleTick} from '../../event-window/oracle.ts'
import {createBehaviorConfig, generateTrace} from '../../event-window/trace.ts'
import {SourceLayout} from './constructions.ts'
import {
  buildEventWindowCircuit,
  createEventWindowMachine,
  writeFrameInputToSource,
} from './event-window-circuit.ts'
import {compileModes, compileWith, countWireMismatches, programStatistics} from './measure.ts'
import {emitFirstActive, isProvenBit, validateOneHotGroups, type Wire} from './numeric-ui-core.ts'

// Gather lowering that sees through products of bits: exact-bit provenance, and
// masked reads over families of bits of which at most one can be 1.

test('products, complements, selects, and sums of an at-most-one family are proven bits; a plain 0..1 cell is not', () => {
  const layout = new SourceLayout()
  const first = layout.cell(0, 0, 1)
  const second = layout.cell(0, 0, 1)
  const unit = layout.cell(1, 1, 1)
  const soft = layout.cell(0.5, 0, 1)
  const circuit = layout.createCircuit()
  circuit.assumeBit(first)
  circuit.assumeBit(second)
  expect(isProvenBit(circuit, first)).toBe(true)
  expect(isProvenBit(circuit, soft)).toBe(false)
  expect(isProvenBit(circuit, circuit.multiply(first, second))).toBe(true)
  expect(isProvenBit(circuit, circuit.multiply(first, soft))).toBe(false)
  const complementByBias = circuit.roundAffine([[first, -1]], 1)
  const complementByUnit = circuit.affine([[unit, 1], [first, -1]])
  expect(isProvenBit(circuit, complementByBias)).toBe(true)
  expect(isProvenBit(circuit, complementByUnit)).toBe(true)
  expect(isProvenBit(circuit, circuit.select(first, second, complementByUnit))).toBe(true)
  expect(isProvenBit(circuit, circuit.select(first, second, soft))).toBe(false)
  // first * second + first * (1 - second) is a bit; first * second + first * (1 - first)
  // is not proven, since second and 1 - first can both be 1; first + second is not a bit.
  const secondComplement = circuit.roundAffine([[second, -1]], 1)
  expect(isProvenBit(circuit, circuit.affine([
    [circuit.multiply(first, second), 1],
    [circuit.multiply(first, secondComplement), 1],
  ]))).toBe(true)
  expect(isProvenBit(circuit, circuit.affine([
    [circuit.multiply(first, second), 1],
    [circuit.multiply(first, complementByUnit), 1],
  ]))).toBe(false)
  expect(isProvenBit(circuit, circuit.affine([[first, 1], [second, 1]]))).toBe(false)
})

test('masked reads over {bit, 1 - bit} and over disjoint sums of a first-active selection lower without a declared group', () => {
  const layout = new SourceLayout()
  const active = layout.cell(1, 0, 1)
  const hits = layout.cells(4, () => 0, 0, 1)
  const soft = layout.cell(0.5, 0, 1)
  const values = layout.cells(2, index => 100 + index, -1000, 1000)
  const circuit = layout.createCircuit()
  circuit.assumeBit(active)
  for (const hit of hits) circuit.assumeBit(hit)
  const routed = emitFirstActive(circuit, active, hits)
  // Proven bits let the first-active selection declare its group.
  expect(circuit.oneHotGroups.length).toBe(1)
  const combined = [
    circuit.affine([[routed[0]!, 1], [routed[2]!, 1]]),
    circuit.affine([[routed[1]!, 1], [routed[3]!, 1]]),
  ]
  const pairRead = circuit.affine(combined.map((mask, index) => [circuit.multiply(mask, values[index]!), 1] as const))
  const complement = circuit.roundAffine([[active, -1]], 1)
  const choiceRead = circuit.affine([
    [circuit.multiply(active, values[0]!), 1],
    [circuit.multiply(complement, values[1]!), 1],
  ])
  const softRead = circuit.affine([
    [circuit.multiply(soft, values[0]!), 1],
    [circuit.multiply(circuit.roundAffine([[soft, -1]], 1), values[1]!), 1],
  ])
  const roots: Wire[] = [pairRead, choiceRead, softRead]
  expect(programStatistics(compileWith(circuit, roots, compileModes.gather)).gatherReads).toBe(0)
  const program = compileWith(circuit, roots, compileModes.all)
  expect(programStatistics(program).gatherReads).toBe(2)
  for (let mask = 0; mask < 32; mask++) {
    const source = layout.table()
    source[active] = mask & 1
    hits.forEach((hit, index) => { source[hit] = (mask >> (index + 1)) & 1 })
    const {mismatches, reference} = countWireMismatches(circuit, program, source)
    expect(mismatches).toBe(0)
    validateOneHotGroups(circuit, reference)
  }
})

test('the event-window copy lowers 11 reads (42 with selects) and a closed loop matches the oracle and the reference on every wire', () => {
  const {circuit, output} = buildEventWindowCircuit('exact')
  const roots = [...output.nextSource, ...output.displayed, ...output.dragOwner]
  expect(programStatistics(compileWith(circuit, roots, compileModes.dense)).gatherReads).toBe(0)
  expect(programStatistics(compileWith(circuit, roots, compileModes.gather)).gatherReads).toBe(1)
  expect(programStatistics(compileWith(circuit, roots, compileModes.all)).gatherReads).toBe(11)
  const withSelects = compileWith(circuit, roots, compileModes.allWithSelects)
  expect(programStatistics(withSelects).gatherReads).toBe(42)
  for (const seed of [21, 22]) {
    const config = createBehaviorConfig(seed * 104_729 + 1)
    const trace = generateTrace(config, seed, 1500)
    // The machine compiles with every lowering except selects.
    const machine = createEventWindowMachine(config)
    const machineReads = programStatistics(machine.circuit.tensorProgram!).gatherReads
    expect(machineReads).toBe(11)
    const machineWithSelects = compileWith(machine.circuit, roots, compileModes.allWithSelects)
    const state = createOracleState(config)
    let frame = 0
    for (const input of trace) {
      const steppedSource = new Float32Array(machine.source)
      writeFrameInputToSource(input, steppedSource)
      const {mismatches, reference} = countWireMismatches(machine.circuit, machineWithSelects, steppedSource)
      expect(mismatches).toBe(0)
      if (frame % 50 === 0) validateOneHotGroups(machine.circuit, reference)
      const machineFrame = machine.step(input)
      expect(collectFrameMismatches(machineFrame, oracleTick(config, state, input))).toEqual([])
      frame++
    }
  }
})

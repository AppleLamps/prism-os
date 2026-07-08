// The latch bank generalizes to a window of the last K press records (record 0
// is the live press latch; older records shift deeper on each pointer-down).
// The behavior itself only reads record 0 — these tests pin that down: deeper
// windows change nothing about behavior, archive records hold exactly the
// previous press sessions, and the cost grows linearly with K.

import {expect, test} from 'bun:test'
import {
  archiveCell,
  archiveField,
  buildEventWindowCircuit,
  createEventWindowMachine,
  sourceField,
} from './circuit.ts'
import {runClosedLoop} from './harness.ts'
import {createOracleState, rectangleCount} from './oracle.ts'
import {measureCircuitCost} from './stats.ts'
import {createBehaviorConfig, generateTrace} from './trace.ts'

test('deeper press windows leave the behavior untouched', () => {
  const config = createBehaviorConfig(41)
  const trace = generateTrace(config, 410, 5_000)
  const shallow = createEventWindowMachine(config, {pressRecordCount: 1})
  const deep = createEventWindowMachine(config, {pressRecordCount: 8})
  for (const input of trace) {
    const shallowFrame = shallow.step(input)
    const deepFrame = deep.step(input)
    expect(deepFrame.displayed).toEqual(shallowFrame.displayed)
    expect(deepFrame.dragOwner).toBe(shallowFrame.dragOwner)
    expect(deepFrame.focused).toBe(shallowFrame.focused)
    expect(deepFrame.maximized).toEqual(shallowFrame.maximized)
    // Every behavior state cell (everything below the archive block) matches.
    for (let cell = 0; cell < sourceField.archiveStart; cell++) {
      expect(deep.source[cell]).toBe(shallow.source[cell])
    }
  }
})

test('a K = 4 window stays closed-loop exact and archives the previous press sessions', () => {
  const config = createBehaviorConfig(42)
  const trace = generateTrace(config, 420, 5_000)
  const machine = createEventWindowMachine(config, {pressRecordCount: 4})
  const archivedRecordCount = 3

  // JS mirror of the expected archive: on each pointer-down the outgoing live
  // press record shifts into slot 0.
  const expectedArchive: number[][] = []
  const liveRecordCells = [
    sourceField.everPressed,
    sourceField.pressX,
    sourceField.pressY,
    sourceField.pressRectangleStart,
    sourceField.pressRectangleStart + 1,
    sourceField.pressRectangleStart + 2,
    sourceField.pressRectangleStart + 3,
    sourceField.grabLeft,
    sourceField.grabTop,
    sourceField.pressOnTitle,
    sourceField.pressWasFocused,
    sourceField.pressOnMaximized,
  ]
  let archiveChecks = 0
  const state = createOracleState(config)
  const beforeStep = new Float32Array(machine.source.length)
  let divergences = 0
  for (const input of trace) {
    beforeStep.set(machine.source)
    const frame = machine.step(input)
    if (input?.kind === 'down') {
      expectedArchive.unshift(liveRecordCells.map(cell => beforeStep[cell]!))
      if (expectedArchive.length > archivedRecordCount) expectedArchive.pop()
    }
    for (let record = 0; record < archivedRecordCount; record++) {
      const expected = expectedArchive[record] ?? Array<number>(archiveField.size).fill(0)
      for (let field = 0; field < archiveField.size; field++) {
        if (machine.source[archiveCell(record, field)] !== expected[field]!) divergences++
        archiveChecks++
      }
    }
    void frame
  }
  // The oracle judges the behavior cells over the same trace on a fresh machine.
  const result = runClosedLoop(
    config,
    trace,
    createEventWindowMachine(config, {pressRecordCount: 4}),
    state,
  )
  expect(result.divergences).toBe(0)
  expect(divergences).toBe(0)
  expect(archiveChecks).toBe(trace.length * archivedRecordCount * archiveField.size)
})

test('circuit cost grows linearly with the press window size K', () => {
  const costs = [1, 2, 4, 8].map(pressRecordCount =>
    measureCircuitCost(buildEventWindowCircuit('exact', pressRecordCount)))
  const [k1, k2, k4, k8] = costs as [
    ReturnType<typeof measureCircuitCost>,
    ReturnType<typeof measureCircuitCost>,
    ReturnType<typeof measureCircuitCost>,
    ReturnType<typeof measureCircuitCost>,
  ]
  // Each archived record costs the same fixed bundle of shift selects.
  const perRecordOperations = k2.operations - k1.operations
  expect(perRecordOperations).toBeGreaterThan(0)
  expect(k4.operations).toBe(k2.operations + 2 * perRecordOperations)
  expect(k8.operations).toBe(k4.operations + 4 * perRecordOperations)
  const perRecordWeights = k2.storedWeights - k1.storedWeights
  expect(k4.storedWeights).toBe(k2.storedWeights + 2 * perRecordWeights)
  expect(k8.storedWeights).toBe(k4.storedWeights + 4 * perRecordWeights)
  // The archive is a shallow shift register: depth does not grow with K.
  expect(k2.depth).toBe(k1.depth)
  expect(k8.depth).toBe(k1.depth)
  expect(rectangleCount).toBe(4)
})

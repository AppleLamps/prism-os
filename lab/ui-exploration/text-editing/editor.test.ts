import {expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../numeric-ui-core.ts'
import {createEditorMachine, writeEvent} from './editor-circuit.ts'
import {measureCircuit} from './integer-circuits.ts'
import {takeFrameEvents} from './keyboard.ts'
import {
  classCodes,
  type EditorConfig,
  type EditorEvent,
  type EditorState,
  emptyState,
  event,
  type KeyKind,
  layoutSlotCount,
  packCell,
  referenceFrame,
  referenceLayout,
} from './reference.ts'
import {createRandom, randomEvent, testTable} from './test-support.ts'

function runDifferential(config: EditorConfig, frames: number, seed: number) {
  const machine = createEditorMachine(config)
  const {table, codes} = testTable(config.codeLimit)
  table.forEach((packed, code) => machine.setTableEntry(code, packed))
  const random = createRandom(seed)
  const geometry = {maxWidth: 0, lineHeight: 64}
  let state: EditorState = emptyState(config)
  const queue: EditorEvent[] = []
  const reset = () => {
    geometry.maxWidth = 80 + Math.floor(random() * 320)
    machine.setGeometry(geometry.maxWidth, geometry.lineHeight)
    state = emptyState(config)
    machine.load(state)
    queue.length = 0
  }
  reset()
  let checkedFrames = 0
  let resets = 0
  let stateMismatches = 0
  let displayMismatches = 0
  const kindsSeen = new Set<KeyKind>()
  for (let frame = 0; frame < frames; frame++) {
    const wanted = Math.floor(random() * (config.keysPerFrame + 1))
    while (queue.length < wanted) queue.push(randomEvent(random, config, codes, geometry))
    const events = takeFrameEvents(queue, config.keysPerFrame, layoutSlotCount(config))
    const expected = referenceFrame(config, table, geometry, state, events)
    if (expected.maximumLineCount > config.lineSlots) {
      resets++
      reset()
      continue
    }
    if (frame % 40 === 0) {
      for (let slot = 0; slot < config.keysPerFrame; slot++) writeEvent(machine.source, config, machine.build.source, slot, events[slot] ?? event('none'))
      validateOneHotGroups(machine.build.circuit, machine.build.circuit.evaluateTensor(machine.source))
    }
    const actual = machine.runFrame(events)
    for (const input of events) kindsSeen.add(input.kind)
    checkedFrames++
    if (JSON.stringify(actual.state) !== JSON.stringify(expected.state)) {
      stateMismatches++
      if (stateMismatches === 1) console.log('state mismatch', JSON.stringify(state), JSON.stringify(events), JSON.stringify(expected.state), JSON.stringify(actual.state))
      machine.load(expected.state)
    }
    const {overflowCount, ...display} = actual.display
    expect(overflowCount).toBe(0)
    const trimmed = {...display, glyphLine: display.glyphLine.slice(0, expected.state.length), glyphX: display.glyphX.slice(0, expected.state.length)}
    const expectedDisplay = config.glyphOutputs ? expected.display : {...expected.display, glyphLine: [], glyphX: []}
    if (JSON.stringify(trimmed) !== JSON.stringify(expectedDisplay)) {
      displayMismatches++
      if (displayMismatches === 1) console.log('display mismatch', JSON.stringify(expected.state), JSON.stringify(expectedDisplay), JSON.stringify(trimmed))
    }
    state = expected.state
  }
  return {checkedFrames, resets, stateMismatches, displayMismatches, kindsSeen, machine}
}

test('the circuit matches the JS editor on random keystrokes, two keys per evaluation', () => {
  const config: EditorConfig = {capacity: 20, lineSlots: 6, pasteLimit: 3, codeLimit: 12, keysPerFrame: 2, maxWidthLimit: 4096, glyphOutputs: true, scan: 'sklansky'}
  const result = runDifferential(config, 700, 11)
  expect(result.stateMismatches).toBe(0)
  expect(result.displayMismatches).toBe(0)
  expect(result.checkedFrames).toBeGreaterThan(500)
  expect(result.kindsSeen.size).toBe(18)
  expect(measureCircuit(result.machine.build.circuit, result.machine.build.roots).gatherReads).toBeGreaterThan(0)
})

test('the circuit matches the JS editor with an odd capacity and Brent-Kung scans', () => {
  const config: EditorConfig = {capacity: 17, lineSlots: 5, pasteLimit: 4, codeLimit: 12, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'brent-kung'}
  const result = runDifferential(config, 700, 23)
  expect(result.stateMismatches).toBe(0)
  expect(result.displayMismatches).toBe(0)
  expect(result.checkedFrames).toBeGreaterThan(500)
})

test('buffer-only key slots and gather shifts match the JS editor', () => {
  const config: EditorConfig = {capacity: 18, lineSlots: 5, pasteLimit: 3, codeLimit: 12, keysPerFrame: 3, layoutSlots: 1, shift: 'gather', maxWidthLimit: 2048, glyphOutputs: true, scan: 'brent-kung'}
  const result = runDifferential(config, 600, 31)
  expect(result.stateMismatches).toBe(0)
  expect(result.displayMismatches).toBe(0)
  expect(result.checkedFrames).toBeGreaterThan(400)
  expect(result.kindsSeen.size).toBe(18)
})

test('wrapping breaks after spaces, inside long words, and at newlines', () => {
  const config: EditorConfig = {capacity: 24, lineSlots: 8, pasteLimit: 4, codeLimit: 12, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: true, scan: 'sklansky'}
  const {table} = testTable(config.codeLimit)
  const machine = createEditorMachine(config)
  table.forEach((packed, code) => machine.setTableEntry(code, packed))
  machine.setGeometry(100, 64)
  // Codes 1..7 are word characters 20..50 wide, 8 is a 10-wide space, 10 is a newline.
  const cells = [1, 2, 8, 3, 4, 8, 5, 5, 5, 5, 10, 10, 6, 8, 8, 8].map(code => table[code]!)
  const state: EditorState = {...emptyState(config), cells: [...cells, ...Array(config.capacity - cells.length).fill(0)], length: cells.length}
  machine.load(state)
  const frame = machine.runFrame([event('none')])
  const layout = referenceLayout(state, 100)
  expect(layout.starts).toEqual(frame.display.lineStarts.slice(0, frame.display.lineCount))
  // "12 34 " fits in 100 only up to the second word; the four 5s (four times 40) break inside the
  // word; two newlines leave an empty line; trailing spaces hang on the last line.
  expect(layout.starts).toEqual([0, 3, 6, 8, 11, 12])
})

test('several keystrokes in one evaluation equal the same keystrokes one per evaluation', () => {
  const base: EditorConfig = {capacity: 16, lineSlots: 5, pasteLimit: 3, codeLimit: 12, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'sklansky'}
  const single = createEditorMachine(base)
  const unrolled = createEditorMachine({...base, keysPerFrame: 3})
  const {table, codes} = testTable(base.codeLimit)
  for (const machine of [single, unrolled]) {
    table.forEach((packed, code) => machine.setTableEntry(code, packed))
    machine.setGeometry(120, 64)
  }
  const random = createRandom(5)
  const geometry = {maxWidth: 120, lineHeight: 64}
  let state = emptyState(base)
  let mismatches = 0
  let compared = 0
  for (let frame = 0; frame < 200; frame++) {
    const events = Array.from({length: 3}, () => randomEvent(random, base, codes, geometry))
    if (referenceFrame(base, table, geometry, state, events).maximumLineCount > base.lineSlots) {
      state = emptyState(base)
      single.load(state)
      unrolled.load(state)
      continue
    }
    let singleFrame = single.runFrame([])
    for (const input of events) singleFrame = single.runFrame([input])
    const unrolledFrame = unrolled.runFrame(events)
    compared++
    if (JSON.stringify(singleFrame) !== JSON.stringify(unrolledFrame)) mismatches++
    state = unrolledFrame.state
  }
  expect(compared).toBeGreaterThan(100)
  expect(mismatches).toBe(0)
})

test('keys that read line geometry are refused in buffer-only slots', () => {
  const config: EditorConfig = {capacity: 12, lineSlots: 3, pasteLimit: 2, codeLimit: 12, keysPerFrame: 2, layoutSlots: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'sklansky'}
  const machine = createEditorMachine(config)
  expect(() => machine.runFrame([event('left'), event('up')])).toThrow('layout slot')
  const queue = [event('insert', {codes: [1]}), event('left'), event('up'), event('right')]
  expect(takeFrameEvents(queue, 2, 1).map(input => input.kind)).toEqual(['insert', 'left'])
  expect(takeFrameEvents(queue, 2, 1).map(input => input.kind)).toEqual(['up', 'right'])
})

test('a new code only adds a table entry', () => {
  const config: EditorConfig = {capacity: 12, lineSlots: 3, pasteLimit: 2, codeLimit: 12, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'sklansky'}
  const machine = createEditorMachine(config)
  machine.setGeometry(500, 64)
  machine.setTableEntry(11, packCell(11, classCodes.word, 77))
  const frame = machine.runFrame([event('insert', {codes: [11, 11]})])
  expect(frame.state.cells.slice(0, 3)).toEqual([packCell(11, classCodes.word, 77), packCell(11, classCodes.word, 77), 0])
  expect(frame.display.caretX).toBe(154)
})

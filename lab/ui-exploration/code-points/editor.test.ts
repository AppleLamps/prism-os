import {expect, test} from 'bun:test'
import {validateOneHotGroups} from './numeric-ui-core.ts'
import {createEditorMachine, validateCodePointReads, writeAdvanceTable, writeEvent} from './editor-circuit.ts'
import {measureCircuit} from './integer-circuits.ts'
import {eventsForText, takeFrameEvents} from './keyboard.ts'
import {codePointsOf} from './line-break-classes.ts'
import {
  type CharacterModel,
  type EditorConfig,
  type EditorEvent,
  type EditorState,
  emptyState,
  event,
  type KeyKind,
  layoutSlotCount,
  referenceFrame,
  referenceLayout,
} from './reference.ts'
import {advanceUnits} from './tables.ts'
import {createRandom, randomEvent, testAdvance} from './test-support.ts'

const model: CharacterModel = {advanceOf: codePoint => advanceUnits(testAdvance, codePoint)}

function stateOf(config: EditorConfig, text: string): EditorState {
  const codes = codePointsOf(text)
  return {...emptyState(config), cells: [...codes, ...Array(config.capacity - codes.length).fill(0)], length: codes.length}
}

function runDifferential(config: EditorConfig, frames: number, seed: number) {
  const machine = createEditorMachine(config, testAdvance)
  const random = createRandom(seed)
  const geometry = {maxWidth: 0, lineHeight: 64}
  let state: EditorState = emptyState(config)
  const queue: EditorEvent[] = []
  const pickWidth = () => {
    geometry.maxWidth = 80 + Math.floor(random() * 320)
    machine.setGeometry(geometry.maxWidth, geometry.lineHeight)
  }
  const reset = () => {
    pickWidth()
    state = emptyState(config)
    machine.load(state)
    queue.length = 0
  }
  reset()
  let checkedFrames = 0
  let resets = 0
  let stateMismatches = 0
  let displayMismatches = 0
  let droppedCodePoints = 0
  let readsValidated = 0
  const kindsSeen = new Set<KeyKind>()
  const widthsChecked = new Set<number>()
  let framesChangedByWholeRuns = 0
  for (let frame = 0; frame < frames; frame++) {
    // A new field width every 40 frames, keeping the text, so each config lays out at many widths.
    // A text that needs more lines than the circuit has at the new width resets below.
    if (frame > 0 && frame % 40 === 0) pickWidth()
    const wanted = Math.floor(random() * (config.keysPerFrame + 1))
    while (queue.length < wanted) queue.push(randomEvent(random, config, geometry))
    const events = takeFrameEvents(queue, config.keysPerFrame, layoutSlotCount(config))
    const expected = referenceFrame(config, model, geometry, state, events)
    if (expected.maximumLineCount > config.lineSlots) {
      resets++
      reset()
      continue
    }
    if (frame % 40 === 0) {
      // Every wire, including dead ones: one-hot promises hold, and every index form is exact.
      for (const input of events) for (const codePoint of input.codes) machine.advances.ensure(codePoint)
      writeAdvanceTable(machine.source, machine.build.source, machine.advances)
      for (let slot = 0; slot < config.keysPerFrame; slot++) writeEvent(machine.source, config, machine.build.source, slot, events[slot] ?? event('none'))
      const values = machine.build.circuit.evaluateTensor(machine.source)
      validateOneHotGroups(machine.build.circuit, values)
      readsValidated += validateCodePointReads(machine.build.circuit, values)
    }
    const actual = machine.runFrame(events)
    droppedCodePoints += actual.droppedCodePoints
    for (const input of events) kindsSeen.add(input.kind)
    checkedFrames++
    widthsChecked.add(geometry.maxWidth)
    // Whether this frame's final layout uses the rule that keeps CJK runs whole.
    const anywhereStarts = referenceLayout(expected.state, model, geometry.maxWidth, 'anywhere').starts
    if (JSON.stringify(anywhereStarts) !== JSON.stringify(referenceLayout(expected.state, model, geometry.maxWidth, 'cjk whole').starts)) framesChangedByWholeRuns++
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
  return {checkedFrames, resets, stateMismatches, displayMismatches, droppedCodePoints, readsValidated, kindsSeen, widths: widthsChecked.size, framesChangedByWholeRuns, machine}
}

test('the circuit matches the JS editor on random mixed text with runs breaking anywhere', () => {
  const config: EditorConfig = {capacity: 16, lineSlots: 6, pasteLimit: 3, advancePageLimit: 32, keysPerFrame: 1, maxWidthLimit: 4096, glyphOutputs: true, scan: 'sklansky'}
  const result = runDifferential(config, 400, 7)
  expect(result.stateMismatches).toBe(0)
  expect(result.displayMismatches).toBe(0)
  expect(result.checkedFrames).toBeGreaterThan(250)
  expect(result.widths).toBeGreaterThanOrEqual(8)
})

test('the circuit matches the JS editor on random mixed text, two keys per evaluation, CJK runs kept whole', () => {
  const config: EditorConfig = {capacity: 20, lineSlots: 6, pasteLimit: 3, advancePageLimit: 32, keysPerFrame: 2, maxWidthLimit: 4096, glyphOutputs: true, scan: 'sklansky', overflow: 'cjk whole'}
  const result = runDifferential(config, 700, 11)
  expect(result.stateMismatches).toBe(0)
  expect(result.displayMismatches).toBe(0)
  expect(result.droppedCodePoints).toBe(0)
  expect(result.checkedFrames).toBeGreaterThan(450)
  expect(result.readsValidated).toBeGreaterThan(0)
  expect(result.kindsSeen.size).toBe(18)
  expect(result.widths).toBeGreaterThanOrEqual(12)
  expect(result.framesChangedByWholeRuns).toBeGreaterThan(0)
  expect(measureCircuit(result.machine.build.circuit, result.machine.build.roots).indexReads).toBeGreaterThan(0)
})

test('the circuit matches the JS editor with an odd capacity, Brent-Kung scans, floor atoms, index reads at counts and CJK runs kept whole', () => {
  const config: EditorConfig = {capacity: 17, lineSlots: 5, pasteLimit: 4, advancePageLimit: 32, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'brent-kung', blockIndex: 'floor atoms', positionReads: 'index', overflow: 'cjk whole'}
  const result = runDifferential(config, 700, 23)
  expect(result.stateMismatches).toBe(0)
  expect(result.displayMismatches).toBe(0)
  expect(result.checkedFrames).toBeGreaterThan(450)
  expect(result.widths).toBeGreaterThanOrEqual(12)
  expect(result.framesChangedByWholeRuns).toBeGreaterThan(0)
})

test('buffer-only key slots, gather shifts and index reads at counts match the JS editor', () => {
  const config: EditorConfig = {capacity: 18, lineSlots: 5, pasteLimit: 3, advancePageLimit: 32, keysPerFrame: 3, layoutSlots: 1, shift: 'gather', maxWidthLimit: 2048, glyphOutputs: true, scan: 'brent-kung', positionReads: 'index'}
  const result = runDifferential(config, 600, 31)
  expect(result.stateMismatches).toBe(0)
  expect(result.displayMismatches).toBe(0)
  expect(result.checkedFrames).toBeGreaterThan(350)
  expect(result.kindsSeen.size).toBe(18)
})

test('wrapping breaks between ideographs, keeps closing punctuation on its line, and hangs spaces', () => {
  const config: EditorConfig = {capacity: 24, lineSlots: 8, pasteLimit: 4, advancePageLimit: 16, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: true, scan: 'sklansky'}
  const machine = createEditorMachine(config, testAdvance)
  // a is 30 units, b is 37, a space is 10, and 字 and 。 are 64 each.
  const state = stateOf(config, 'ab 字字。字字')
  machine.load(state)
  const startsAt = (maxWidth: number) => {
    machine.setGeometry(maxWidth, 64)
    const frame = machine.runFrame([event('none')])
    return frame.display.lineStarts.slice(0, frame.display.lineCount)
  }
  // At 200, 字字 fits after "ab " only up to one 字, so the line breaks between the two ideographs.
  // The second line is 字。字 and breaks before the last 字.
  expect(referenceLayout(state, model, 200).starts).toEqual([0, 4, 7])
  expect(startsAt(200)).toEqual([0, 4, 7])
  // At 130, the third line would start at 。, which can't start a line, so 字。 moves together.
  expect(referenceLayout(state, model, 130).starts).toEqual([0, 3, 4, 6])
  expect(startsAt(130)).toEqual([0, 3, 4, 6])
  // At 100, 字。 doesn't fit by itself. Breaking anywhere puts 。 on its own line; keeping CJK runs
  // whole overflows the line instead.
  expect(referenceLayout(state, model, 100).starts).toEqual([0, 3, 4, 5, 6, 7])
  expect(startsAt(100)).toEqual([0, 3, 4, 5, 6, 7])
  const whole = createEditorMachine({...config, overflow: 'cjk whole'}, testAdvance)
  whole.load(state)
  whole.setGeometry(100, 64)
  const wholeFrame = whole.runFrame([event('none')])
  expect(referenceLayout(state, model, 100, 'cjk whole').starts).toEqual([0, 3, 4, 6, 7])
  expect(wholeFrame.display.lineStarts.slice(0, wholeFrame.display.lineCount)).toEqual([0, 3, 4, 6, 7])
})

test('several keystrokes in one evaluation equal the same keystrokes one per evaluation', () => {
  const base: EditorConfig = {capacity: 16, lineSlots: 5, pasteLimit: 3, advancePageLimit: 32, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'sklansky'}
  const single = createEditorMachine(base, testAdvance)
  const unrolled = createEditorMachine({...base, keysPerFrame: 3}, testAdvance)
  for (const machine of [single, unrolled]) machine.setGeometry(120, 64)
  const random = createRandom(5)
  const geometry = {maxWidth: 120, lineHeight: 64}
  let state = emptyState(base)
  let mismatches = 0
  let compared = 0
  for (let frame = 0; frame < 200; frame++) {
    const events = Array.from({length: 3}, () => randomEvent(random, base, geometry))
    if (referenceFrame(base, model, geometry, state, events).maximumLineCount > base.lineSlots) {
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
  const config: EditorConfig = {capacity: 12, lineSlots: 3, pasteLimit: 2, advancePageLimit: 8, keysPerFrame: 2, layoutSlots: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'sklansky'}
  const machine = createEditorMachine(config, testAdvance)
  expect(() => machine.runFrame([event('left'), event('up')])).toThrow('layout slot')
  const queue = [event('insert', {codes: [0x61]}), event('left'), event('up'), event('right')]
  expect(takeFrameEvents(queue, 2, 1).map(input => input.kind)).toEqual(['insert', 'left'])
  expect(takeFrameEvents(queue, 2, 1).map(input => input.kind)).toEqual(['up', 'right'])
})

test('a new code point only writes advance table cells, and a font change only rewrites seen advances', () => {
  const config: EditorConfig = {capacity: 12, lineSlots: 3, pasteLimit: 4, advancePageLimit: 8, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'sklansky'}
  const machine = createEditorMachine(config, testAdvance)
  machine.setGeometry(1000, 64)
  const [typed] = eventsForText('ab字', config.pasteLimit)
  const frame = machine.runFrame([typed!])
  expect(frame.state.cells.slice(0, 4)).toEqual([0x61, 0x62, 0x5B57, 0])
  // a is 30, b is 37 and 字 is 64.
  expect(frame.display.caretX).toBe(131)
  // Two blocks got pages: U+0000..U+007F and U+5B00..U+5B7F.
  expect(machine.advances.pagesInUse()).toBe(3)
  const font = machine.setFont(codePoint => 2 * testAdvance(codePoint))
  expect(font).toEqual({rewrittenEntries: 3, changedEntries: 3, sourceCellsWritten: 3})
  expect(machine.runFrame([]).display.caretX).toBe(262)
})

test('a full advance table drops code points from blocks it has no page for', () => {
  const config: EditorConfig = {capacity: 12, lineSlots: 3, pasteLimit: 4, advancePageLimit: 2, keysPerFrame: 1, maxWidthLimit: 2048, glyphOutputs: false, scan: 'sklansky'}
  const machine = createEditorMachine(config, testAdvance)
  machine.setGeometry(1000, 64)
  const frame = machine.runFrame(eventsForText('a字b', config.pasteLimit))
  expect(frame.droppedCodePoints).toBe(1)
  expect(frame.state.cells.slice(0, 3)).toEqual([0x61, 0x62, 0])
})

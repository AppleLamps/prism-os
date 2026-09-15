import {expect, test} from 'bun:test'
import {createEditorMachine} from './editor-circuit.ts'
import {eventForPointer, eventsForKey, eventsForText, takeFrameEvents} from './keyboard.ts'
import {projectFrame, selectedText} from './projection.ts'
import {classCodes, type EditorConfig, type EditorState, referenceLayout, unpackCell} from './reference.ts'
import {classifyGrapheme, createWidthTable, encodeText, segmentGraphemes} from './width-table.ts'

const measure = (text: string) => text === 'W' ? 12.3 : 7.5

test('graphemes get codes on first use and full tables drop new graphemes', () => {
  const table = createWidthTable(4, 4, measure)
  expect(encodeText(table, 'aWa')).toEqual([1, 2, 1])
  expect(unpackCell(table.packed[2]!)).toEqual({code: 2, classCode: classCodes.word, advance: 49})
  expect(table.codeOf('\n')).toBe(3)
  expect(unpackCell(table.packed[3]!).advance).toBe(0)
  expect(table.codeOf('z')).toBeNull()
  expect(classifyGrapheme(' ')).toBe(classCodes.space)
  expect(classifyGrapheme(',')).toBe(classCodes.other)
  expect(segmentGraphemes('é👍🏽\r\n')).toEqual(['é', '👍🏽', '\n'])
})

test('no-break spaces are ordinary glyphs, so they never open a break opportunity', () => {
  expect(classifyGrapheme('\t')).toBe(classCodes.space)
  expect(classifyGrapheme('\u00A0')).toBe(classCodes.other)
  expect(classifyGrapheme('\u202F')).toBe(classCodes.other)
  // Every glyph is 7.5px, i.e. 30 units, so a 120-unit line holds four glyphs.
  const lineStartsOf = (text: string) => {
    const table = createWidthTable(16, 4, measure)
    const codes = encodeText(table, text)
    const state: EditorState = {cells: codes.map(code => table.packed[code]!), length: codes.length, caret: 0, anchor: 0, preferredX: 0, hasPreferredX: 0}
    return referenceLayout(state, 120).starts
  }
  // "ab cd ef" breaks after each space. With a no-break space, "ab\u00A0cd" is one word, so the
  // first line breaks inside it after four glyphs.
  expect(lineStartsOf('ab cd ef')).toEqual([0, 3, 6])
  expect(lineStartsOf('ab\u00A0cd ef')).toEqual([0, 4])
})

test('keys map to editor events with macOS modifiers, and paste splits by the paste limit', () => {
  const table = createWidthTable(32, 4, measure)
  const key = (name: string, modifiers: Partial<{shiftKey: boolean, altKey: boolean, metaKey: boolean, ctrlKey: boolean}> = {}) =>
    eventsForKey({key: name, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...modifiers}, table, 3)
  expect(key('ArrowLeft', {altKey: true, shiftKey: true})?.[0]).toMatchObject({kind: 'wordLeft', shift: true})
  expect(key('ArrowRight', {metaKey: true})?.[0]?.kind).toBe('lineEnd')
  expect(key('ArrowUp', {metaKey: true})?.[0]?.kind).toBe('documentStart')
  expect(key('Backspace', {altKey: true})?.[0]?.kind).toBe('wordBackspace')
  expect(key('a', {metaKey: true})?.[0]?.kind).toBe('selectAll')
  expect(key('r', {metaKey: true})).toBeNull()
  expect(key('Shift')).toBeNull()
  expect(key('Enter')?.[0]?.codes).toEqual([table.codeOf('\n')!])
  expect(eventsForText('abcdefg', table, 3).map(input => input.codes.length)).toEqual([3, 3, 1])
  expect(eventForPointer({kind: 'pointerDown', shiftKey: true, x: 10.6, y: 30}, 4, 2048)).toMatchObject({kind: 'pointerDown', shift: true, pointerX: 42, pointerY: 120})
  const queue = eventsForText('abcdefg', table, 1)
  expect(takeFrameEvents(queue, 4).length).toBe(4)
  expect(queue.length).toBe(3)
})

test('projection turns a frame into glyph spans, a caret, and selection rectangles', () => {
  const config: EditorConfig = {capacity: 16, lineSlots: 4, pasteLimit: 8, codeLimit: 16, keysPerFrame: 2, maxWidthLimit: 2048, glyphOutputs: true, scan: 'sklansky'}
  const table = createWidthTable(config.codeLimit, 4, measure)
  const machine = createEditorMachine(config)
  machine.setGeometry(4 * 40, 4 * 20)
  const events = [...eventsForText('ab cd ef', table, config.pasteLimit), {kind: 'left' as const, shift: true, codes: [], pointerX: 0, pointerY: 0}]
  table.packed.forEach((packed, code) => machine.setTableEntry(code, packed))
  const frame = machine.runFrame(events)
  const view = projectFrame(table, frame, 4 * 20)
  expect(view.text).toBe('ab cd ef')
  // Each glyph is 7.5px, so 40px fits "ab cd" (5 glyphs) and "ef" wraps.
  expect(view.glyphs.map(glyph => glyph.top)).toEqual([0, 0, 0, 0, 0, 0, 20, 20])
  expect(view.glyphs[7]).toMatchObject({text: 'f', left: 7.5, width: 7.5})
  expect(view.caret).toMatchObject({left: 7.5, top: 20})
  expect(view.selections).toEqual([{left: 7.5, top: 20, width: 7.5, height: 20}])
  expect(selectedText(table, frame)).toBe('f')
})

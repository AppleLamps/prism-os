// The plain JavaScript editor model the circuit is checked against. It keeps the same numbers as the
// source table (packed cells, length, caret, anchor, preferred x) but computes everything with
// ordinary loops: a sequential greedy line walker, linear word scans, and array splices.

export type ScanStrategy = 'sklansky' | 'brent-kung'

export type EditorConfig = {
  // Number of code cells in the buffer.
  capacity: number
  // Number of line slots the circuit lays out. Text that needs more lines is out of contract.
  lineSlots: number
  // Most codes one insert event can carry (typing is 1, paste is up to this many).
  pasteLimit: number
  // Number of entries in the prepared width table.
  codeLimit: number
  // Keystrokes the circuit applies in one evaluation, one unrolled step each.
  keysPerFrame: number
  // maxWidth must stay below this, in layout units. It is also the offset a newline adds to the
  // position keys, so a line never reaches past a newline.
  maxWidthLimit: number
  // Whether the circuit also outputs a line index and x offset per glyph.
  glyphOutputs: boolean
  scan: ScanStrategy
  // The first layoutSlots key slots accept every key and lay out the buffer before applying it.
  // Later slots skip that layout, so they only accept keys that don't read line geometry (see
  // layoutKinds). Defaults to keysPerFrame.
  layoutSlots?: number
  // How an edit moves cells: log2(capacity) stages of selects, or one gather read per cell over a
  // shared one-hot of the shift. Defaults to 'barrel'.
  shift?: 'barrel' | 'gather'
}

export function layoutSlotCount(config: EditorConfig) {
  return Math.min(config.keysPerFrame, config.layoutSlots ?? config.keysPerFrame)
}

export const keyKinds = [
  'none',
  'insert',
  'backspace',
  'delete',
  'wordBackspace',
  'left',
  'right',
  'wordLeft',
  'wordRight',
  'lineStart',
  'lineEnd',
  'up',
  'down',
  'documentStart',
  'documentEnd',
  'selectAll',
  'pointerDown',
  'pointerDrag',
] as const

export type KeyKind = (typeof keyKinds)[number]

export const movementKinds: readonly KeyKind[] = ['left', 'right', 'wordLeft', 'wordRight', 'lineStart', 'lineEnd', 'up', 'down', 'documentStart', 'documentEnd']

// Keys whose result depends on line geometry, so they need a layout of the buffer before them.
export const layoutKinds: readonly KeyKind[] = ['lineStart', 'lineEnd', 'up', 'down', 'pointerDown', 'pointerDrag']

export const classCodes = {other: 0, word: 1, space: 2, newline: 3} as const

// A cell packs code * 4096 + class * 1024 + advance into one exact FP32 integer, so an edit moves
// one number per cell. Advances are integers in layout units below 1024.
export const cellPacking = {codeScale: 4096, classScale: 1024, advanceLimit: 1024} as const

export function packCell(code: number, classCode: number, advance: number): number {
  if (!Number.isInteger(advance) || advance < 0 || advance >= cellPacking.advanceLimit) throw new Error(`advance ${advance} is outside 0..1023`)
  return code * cellPacking.codeScale + classCode * cellPacking.classScale + advance
}

export function unpackCell(value: number) {
  const code = Math.floor(value / cellPacking.codeScale)
  const remainder = value - code * cellPacking.codeScale
  const classCode = Math.floor(remainder / cellPacking.classScale)
  return {code, classCode, advance: remainder - classCode * cellPacking.classScale}
}

export type EditorState = {
  cells: number[]
  length: number
  caret: number
  anchor: number
  preferredX: number
  hasPreferredX: number
}

export type EditorEvent = {
  kind: KeyKind
  shift: boolean
  codes: readonly number[]
  pointerX: number
  pointerY: number
}

export type FieldGeometry = {
  // Layout units, e.g. quarter pixels.
  maxWidth: number
  lineHeight: number
}

export function emptyState(config: EditorConfig): EditorState {
  return {cells: Array(config.capacity).fill(0), length: 0, caret: 0, anchor: 0, preferredX: 0, hasPreferredX: 0}
}

export function event(kind: KeyKind, options: Partial<Omit<EditorEvent, 'kind'>> = {}): EditorEvent {
  return {kind, shift: options.shift ?? false, codes: options.codes ?? [], pointerX: options.pointerX ?? 0, pointerY: options.pointerY ?? 0}
}

export type ReferenceLayout = {
  // Start cell of every line.
  starts: number[]
  // Whether the line ends with a newline cell.
  forced: boolean[]
}

export function referenceLayout(state: EditorState, maxWidth: number): ReferenceLayout {
  const starts = [0]
  const forced: boolean[] = []
  let start = 0
  for (;;) {
    let width = 0
    let lastOpportunity = start
    let next = -1
    let endsWithNewline = false
    for (let cell = start; cell < state.length; cell++) {
      const {classCode, advance} = unpackCell(state.cells[cell]!)
      if (classCode === classCodes.newline) {
        next = cell + 1
        endsWithNewline = true
        break
      }
      if (classCode === classCodes.space) {
        // Spaces hang past the edge and open a break opportunity after themselves.
        width += advance
        lastOpportunity = cell + 1
        continue
      }
      if (width + advance > maxWidth) {
        // Break at the last opportunity on this line, or inside the word when there is none.
        next = lastOpportunity > start ? lastOpportunity : Math.max(cell, start + 1)
        break
      }
      width += advance
    }
    forced.push(endsWithNewline)
    if (next < 0 || (!endsWithNewline && next >= state.length)) break
    starts.push(next)
    start = next
  }
  return {starts, forced}
}

function advanceAt(state: EditorState, cell: number) {
  return unpackCell(state.cells[cell]!).advance
}

function widthBetween(state: EditorState, from: number, to: number) {
  let width = 0
  for (let cell = from; cell < to; cell++) width += advanceAt(state, cell)
  return width
}

function lineOfPosition(layout: ReferenceLayout, position: number) {
  let line = 0
  while (line + 1 < layout.starts.length && layout.starts[line + 1]! <= position) line++
  return line
}

function endCaretOf(state: EditorState, layout: ReferenceLayout, line: number) {
  return line === layout.starts.length - 1 ? state.length : layout.starts[line + 1]! - 1
}

function isWordCell(state: EditorState, cell: number) {
  return cell < state.length && unpackCell(state.cells[cell]!).classCode === classCodes.word
}

export function referenceWordLeft(state: EditorState, position: number) {
  for (let candidate = position - 1; candidate >= 1; candidate--) {
    if (isWordCell(state, candidate) && !isWordCell(state, candidate - 1)) return candidate
  }
  return 0
}

export function referenceWordRight(state: EditorState, position: number) {
  for (let candidate = position + 1; candidate <= state.length; candidate++) {
    if (isWordCell(state, candidate - 1) && !isWordCell(state, candidate)) return candidate
  }
  return state.length
}

// The caret position a pointer at x (relative to the line start) lands on: one past every glyph on
// the line whose center is left of x, clamped to the line's caret range.
export function referenceHit(state: EditorState, layout: ReferenceLayout, line: number, x: number) {
  const end = endCaretOf(state, layout, line)
  let position = layout.starts[line]!
  let lineX = 0
  while (position < end) {
    const advance = advanceAt(state, position)
    if (2 * lineX + advance >= 2 * x) break
    lineX += advance
    position++
  }
  return position
}

export function referenceStep(config: EditorConfig, table: readonly number[], geometry: FieldGeometry, state: EditorState, input: EditorEvent): EditorState {
  if (input.kind === 'none') return state
  const layout = referenceLayout(state, geometry.maxWidth)
  const {length, caret, anchor} = state
  const lineCount = layout.starts.length
  const selectionStart = Math.min(anchor, caret)
  const selectionEnd = Math.max(anchor, caret)
  const hasSelection = selectionEnd > selectionStart
  const caretLine = lineOfPosition(layout, caret)
  const caretX = widthBetween(state, layout.starts[caretLine]!, caret)
  const targetX = state.hasPreferredX === 1 ? state.preferredX : caretX
  const collapse = hasSelection && !input.shift

  const replace = (start: number, end: number, codes: readonly number[]): EditorState => {
    const room = config.capacity - length + (end - start)
    const inserted = codes.slice(0, Math.min(codes.length, room)).map(code => table[code]!)
    const cells = [...state.cells.slice(0, start), ...inserted, ...state.cells.slice(end, length)]
    while (cells.length < config.capacity) cells.push(0)
    const position = start + inserted.length
    return {cells, length: start + inserted.length + (length - end), caret: position, anchor: position, preferredX: 0, hasPreferredX: 0}
  }
  const move = (target: number): EditorState =>
    ({...state, caret: target, anchor: input.shift ? anchor : target, preferredX: 0, hasPreferredX: 0})
  const moveVertically = (target: number): EditorState =>
    ({...state, caret: target, anchor: input.shift ? anchor : target, preferredX: targetX, hasPreferredX: 1})
  const pointerHit = () => {
    const clickedLine = Math.min(Math.floor(input.pointerY / geometry.lineHeight), lineCount - 1, config.lineSlots - 1)
    return referenceHit(state, layout, clickedLine, input.pointerX)
  }

  switch (input.kind) {
    case 'insert':
      return replace(selectionStart, selectionEnd, input.codes)
    case 'backspace':
      return replace(hasSelection ? selectionStart : Math.max(caret - 1, 0), selectionEnd, [])
    case 'delete':
      return replace(selectionStart, hasSelection ? selectionEnd : Math.min(caret + 1, length), [])
    case 'wordBackspace':
      return replace(hasSelection ? selectionStart : referenceWordLeft(state, caret), selectionEnd, [])
    case 'left':
      return move(collapse ? selectionStart : Math.max(caret - 1, 0))
    case 'right':
      return move(collapse ? selectionEnd : Math.min(caret + 1, length))
    case 'wordLeft':
      return move(referenceWordLeft(state, caret))
    case 'wordRight':
      return move(referenceWordRight(state, caret))
    case 'lineStart':
      return move(layout.starts[caretLine]!)
    case 'lineEnd':
      return move(endCaretOf(state, layout, caretLine))
    case 'up':
      return moveVertically(caretLine === 0 ? 0 : referenceHit(state, layout, caretLine - 1, targetX))
    case 'down':
      return moveVertically(caretLine === lineCount - 1 ? length : referenceHit(state, layout, caretLine + 1, targetX))
    case 'documentStart':
      return move(0)
    case 'documentEnd':
      return move(length)
    case 'selectAll':
      return {...state, caret: length, anchor: 0, preferredX: 0, hasPreferredX: 0}
    case 'pointerDown': {
      const target = pointerHit()
      return {...state, caret: target, anchor: input.shift ? anchor : target, preferredX: 0, hasPreferredX: 0}
    }
    case 'pointerDrag':
      return {...state, caret: pointerHit(), preferredX: 0, hasPreferredX: 0}
  }
}

export type EditorDisplay = {
  // Start cell per line slot; slots past the last line hold capacity + 1.
  lineStarts: number[]
  lineCount: number
  caretLine: number
  caretX: number
  // Selection rectangle per line slot, as x offsets from the line start. Equal values mean none.
  selectionLeft: number[]
  selectionRight: number[]
  // Line index and x offset per glyph (only cells below length are meaningful).
  glyphLine: number[]
  glyphX: number[]
}

export function referenceDisplay(config: EditorConfig, geometry: FieldGeometry, state: EditorState): EditorDisplay {
  const layout = referenceLayout(state, geometry.maxWidth)
  const lineCount = layout.starts.length
  const lineStarts = Array.from({length: config.lineSlots}, (_, line) => line < lineCount ? layout.starts[line]! : config.capacity + 1)
  const caretLine = lineOfPosition(layout, state.caret)
  const selectionStart = Math.min(state.anchor, state.caret)
  const selectionEnd = Math.max(state.anchor, state.caret)
  const selectionLeft: number[] = []
  const selectionRight: number[] = []
  for (let line = 0; line < config.lineSlots; line++) {
    if (line >= lineCount) {
      selectionLeft.push(0)
      selectionRight.push(0)
      continue
    }
    const start = layout.starts[line]!
    const paintedEnd = line === lineCount - 1 ? state.length : layout.starts[line + 1]! - (layout.forced[line] ? 1 : 0)
    const clampToLine = (position: number) => Math.min(Math.max(position, start), paintedEnd)
    selectionLeft.push(widthBetween(state, start, clampToLine(selectionStart)))
    selectionRight.push(widthBetween(state, start, clampToLine(selectionEnd)))
  }
  const glyphLine: number[] = []
  const glyphX: number[] = []
  for (let cell = 0; cell < state.length; cell++) {
    const line = lineOfPosition(layout, cell)
    glyphLine.push(line)
    glyphX.push(widthBetween(state, layout.starts[line]!, cell))
  }
  return {
    lineStarts,
    lineCount,
    caretLine,
    caretX: widthBetween(state, layout.starts[caretLine]!, state.caret),
    selectionLeft,
    selectionRight,
    glyphLine,
    glyphX,
  }
}

// Line count of every layout a frame reads: the state before each key, and the final state.
export function referenceFrame(config: EditorConfig, table: readonly number[], geometry: FieldGeometry, state: EditorState, events: readonly EditorEvent[]) {
  let current = state
  let maximumLineCount = referenceLayout(current, geometry.maxWidth).starts.length
  for (const input of events) {
    current = referenceStep(config, table, geometry, current, input)
    maximumLineCount = Math.max(maximumLineCount, referenceLayout(current, geometry.maxWidth).starts.length)
  }
  return {state: current, display: referenceDisplay(config, geometry, current), maximumLineCount}
}

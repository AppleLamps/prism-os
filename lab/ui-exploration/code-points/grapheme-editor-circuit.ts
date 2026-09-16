// A text field whose editing model is one fixed circuit. The source table holds a packed code
// buffer, length, caret, selection anchor, preferred x, a prepared width table, and one event slot
// per queued keystroke. Each slot unrolls one step: decode the cells, lay out the buffer (only in
// layout slots), decide the caret, anchor and edit range, then rewrite every cell. A final layout
// produces the display outputs. Strings never enter; JS maps codes back to graphemes.

import {Circuit, type Wire, invariant} from '../../../numeric-ui-core.ts'
import {
  andBits,
  atLeastZero,
  barrelShiftTowardEnd,
  barrelShiftTowardStart,
  bitCountFor,
  constant,
  floorByPowerOfTwo,
  gather,
  integerBits,
  integerMaximum,
  integerMinimum,
  integerOneHot,
  maskValue,
  materialize,
  oneHotFromMonotone,
  pick,
  prefixScan,
  tournament,
} from './grapheme-integer-circuits.ts'
import {
  cellPacking,
  type EditorConfig,
  type EditorDisplay,
  type EditorEvent,
  type EditorState,
  keyKinds,
  type KeyKind,
  layoutKinds,
  layoutSlotCount,
  movementKinds,
} from './grapheme-reference.ts'

export type SlotLayout = {
  kind: number
  shift: number
  count: number
  codes: number
  pointerX: number
  pointerY: number
}

export type SourceLayout = {
  size: number
  unit: number
  maxWidth: number
  lineHeight: number
  length: number
  caret: number
  anchor: number
  preferredX: number
  hasPreferredX: number
  cells: number
  table: number
  slots: SlotLayout[]
}

export function createSourceLayout(config: EditorConfig): SourceLayout {
  let cursor = 0
  const take = (count: number) => {
    const start = cursor
    cursor += count
    return start
  }
  const layout = {
    unit: take(1),
    maxWidth: take(1),
    lineHeight: take(1),
    length: take(1),
    caret: take(1),
    anchor: take(1),
    preferredX: take(1),
    hasPreferredX: take(1),
    cells: take(config.capacity),
    table: take(config.codeLimit),
    slots: Array.from({length: config.keysPerFrame}, (): SlotLayout => ({
      kind: take(keyKinds.length),
      shift: take(1),
      count: take(1),
      codes: take(config.pasteLimit),
      pointerX: take(1),
      pointerY: take(1),
    })),
  }
  return {...layout, size: cursor}
}

export function editorLimits(config: EditorConfig) {
  const advanceMaximum = cellPacking.advanceLimit - 1
  const newlineOffset = config.maxWidthLimit
  // Position keys: advance prefix sums plus newlineOffset per newline before the position.
  const keyMaximum = config.capacity * (advanceMaximum + newlineOffset)
  const lineXMaximum = config.capacity * advanceMaximum
  const pointerXMaximum = config.maxWidthLimit
  const cellMaximum = config.codeLimit * cellPacking.codeScale - 1
  invariant(2 * (keyMaximum + Math.max(lineXMaximum, pointerXMaximum)) < 2 ** 23, 'capacity and maxWidthLimit leave no exact FP32 headroom for position keys')
  invariant(cellMaximum < 2 ** 23, 'codeLimit is too large for packed cells')
  invariant(config.capacity >= 2 && config.lineSlots >= 1 && config.pasteLimit >= 1 && config.codeLimit >= 2, 'editor config is too small')
  return {advanceMaximum, newlineOffset, keyMaximum, lineXMaximum, pointerXMaximum, cellMaximum, pointerYMaximum: 2 ** 16}
}

// Operations appended from firstOperation until the next phase belong to this phase.
export type Phase = {name: string, scope: string, firstOperation: number}

type Context = {
  circuit: Circuit
  config: EditorConfig
  limits: ReturnType<typeof editorLimits>
  source: SourceLayout
  zero: Wire
  phases: Phase[]
  // 'layout key', 'buffer key', or 'final'.
  scope: string
}

function mark(context: Context, name: string) {
  context.phases.push({name, scope: context.scope, firstOperation: context.circuit.operations.length})
}

type StateWires = {
  cells: Wire[]
  length: Wire
  caret: Wire
  anchor: Wire
  preferredX: Wire
  hasPreferredX: Wire
}

type DecodedCells = {
  advance: Wire[]
  hang: Wire[]
  newline: Wire[]
  word: Wire[]
}

type LayoutWires = {
  // Position keys: keys[p] = advance sum before cell p + newlineOffset * newlines before p, p = 0..capacity.
  keys: Wire[]
  // 2 * keys[c] + advance[c], the doubled glyph center, c = 0..capacity-1.
  centers: Wire[]
  starts: Wire[]
  startKeys: Wire[]
  exists: Wire[]
  forced: Wire[]
  endCarets: Wire[]
  lineCount: Wire
  overflow: Wire
}

// A cell is code * 4096 + class * 1024 + advance. One floor recovers the code, and three
// comparisons on the remainder give the class bits.
function decodeCells(context: Context, cells: readonly Wire[]): DecodedCells {
  const {circuit, limits} = context
  const {codeScale, classScale} = cellPacking
  mark(context, 'decode cells')
  const decoded: DecodedCells = {advance: [], hang: [], newline: [], word: []}
  for (const value of cells) {
    const code = floorByPowerOfTwo(circuit, value, Math.log2(codeScale))
    const classAtLeast = (classCode: number) => atLeastZero(circuit, [[value, 1], [code, -codeScale]], -classCode * classScale)
    const wordOrAbove = classAtLeast(1)
    const hang = classAtLeast(2)
    const newline = classAtLeast(3)
    decoded.advance.push(materialize(circuit, [[value, 1], [code, -codeScale], [wordOrAbove, -classScale], [hang, -classScale], [newline, -classScale]], 0, 0, limits.advanceMaximum))
    decoded.word.push(materialize(circuit, [[wordOrAbove, 1], [hang, -1]], 0, 0, 1))
    decoded.hang.push(hang)
    decoded.newline.push(newline)
  }
  return decoded
}

function buildLayout(context: Context, state: StateWires, decoded: DecodedCells): LayoutWires {
  const {circuit, config, limits, zero} = context
  const capacity = config.capacity
  const {advance, hang, newline} = decoded

  mark(context, 'layout: prefix sums and scans')
  const sum = (earlier: Wire, later: Wire) => circuit.roundAffine([[earlier, 1], [later, 1]])
  const maximum = (earlier: Wire, later: Wire) => integerMaximum(circuit, earlier, later)
  const advanceWithNewlines = advance.map((wire, cell) => materialize(circuit, [[wire, 1], [newline[cell]!, limits.newlineOffset]], 0, 0, limits.advanceMaximum + limits.newlineOffset))
  const keys = [zero, ...prefixScan(advanceWithNewlines, sum, config.scan)]
  for (const key of keys) circuit.assumeRange(key, 0, limits.keyMaximum)

  // Spaces hang, so a cell's fit edge is the right edge of the last non-space cell at or before it.
  // A run of spaces can't overflow even when its own advances pass the edge. A newline counts as
  // content whose right edge includes the newline offset, so it never fits on the line it ends.
  // Right edges never decrease, so the edge is a prefix maximum.
  const contentRightEdges = keys.slice(1).map((key, cell) => maskValue(circuit, key, circuit.affine([[hang[cell]!, -1], [newline[cell]!, 1]], 1)))
  const fitEdges = prefixScan(contentRightEdges, maximum, config.scan)
  const centers = advance.map((wire, cell) => materialize(circuit, [[keys[cell]!, 2], [wire, 1]], 0, 0, 2 * limits.keyMaximum + limits.advanceMaximum))

  // Break tables: a break opportunity sits after every space or newline. For a first failing cell c,
  // breakStarts[c] is where the next line starts when the line breaks at an opportunity, and
  // breakKeys[c] is the position key there.
  const opportunityLeaves = [zero, ...hang.map((bit, cell) => circuit.affine([[bit, cell + 1]]))]
  const opportunityKeyLeaves = [zero, ...hang.map((bit, cell) => maskValue(circuit, keys[cell + 1]!, bit))]
  const latestOpportunity = prefixScan(opportunityLeaves, maximum, config.scan)
  const latestOpportunityKey = prefixScan(opportunityKeyLeaves, maximum, config.scan)
  const breakStarts = latestOpportunity.map((wire, cell) => cell === capacity ? wire : pick(circuit, newline[cell]!, wire, constant(circuit, cell + 1)))
  const breakKeys = latestOpportunityKey.map((wire, cell) => cell === capacity ? wire : pick(circuit, newline[cell]!, wire, keys[cell + 1]!))
  const newlineTable = [...newline, zero]
  const keysAfter = keys.map((_, cell) => keys[Math.min(cell + 1, capacity)]!)
  const lastKey = keys[capacity]!
  const noLine = constant(circuit, capacity + 1)

  mark(context, 'layout: line breaking')
  const starts: Wire[] = [zero]
  const startKeys: Wire[] = [zero]
  const forced: Wire[] = []
  for (let line = 0; line < config.lineSlots; line++) {
    const start = starts[line]!
    const startKey = startKeys[line]!
    const fitLimit = materialize(circuit, [[startKey, 1], [context.source.maxWidth, 1]], 0, 0, limits.keyMaximum + limits.newlineOffset)
    // fits[c] = [fitEdge[c] <= fitLimit]. Fit edges never decrease, so the bits are a run of ones and
    // the number of ones is the first cell that doesn't fit.
    const fits = fitEdges.map(edge => atLeastZero(circuit, [[fitLimit, 1], [edge, -1]]))
    const failing = oneHotFromMonotone(circuit, fits)
    const firstFailing = materialize(circuit, fits.map(bit => [bit, 1]), 0, 0, capacity)
    const breakStart = gather(circuit, failing, breakStarts)
    const breakKey = gather(circuit, failing, breakKeys)
    const endsWithNewline = gather(circuit, failing, newlineTable)
    const failingKey = gather(circuit, failing, keys)
    const failingKeyAfter = gather(circuit, failing, keysAfter)
    // No opportunity after the line start: break inside the word, at the failing cell, but always
    // take at least one cell.
    const insideWord = atLeastZero(circuit, [[start, 1], [breakStart, -1]])
    const stuck = atLeastZero(circuit, [[start, 1], [firstFailing, -1]])
    const insideStart = materialize(circuit, [[firstFailing, 1], [stuck, 1]], 0, 0, capacity + 1)
    const insideKey = pick(circuit, stuck, failingKey, failingKeyAfter)
    const next = pick(circuit, insideWord, breakStart, insideStart)
    const nextKey = pick(circuit, insideWord, breakKey, insideKey)
    // The text ends on this line when everything fits, or when a soft break lands at the end.
    const textEnds = atLeastZero(circuit, [[next, 1], [fits[capacity - 1]!, capacity], [state.length, -1], [endsWithNewline, -1]])
    starts.push(pick(circuit, textEnds, next, noLine))
    startKeys.push(pick(circuit, textEnds, nextKey, lastKey))
    forced.push(endsWithNewline)
  }
  const exists = starts.map((start, line) => line === 0 ? constant(circuit, 1) : atLeastZero(circuit, [[state.length, 1], [start, -1]]))
  const endCarets = Array.from({length: config.lineSlots}, (_, line) => {
    const beforeNextStart = materialize(circuit, [[starts[line + 1]!, 1]], -1, 0, capacity)
    const endCaret = pick(circuit, exists[line + 1]!, state.length, beforeNextStart)
    circuit.assumeRange(endCaret, 0, capacity)
    return endCaret
  })
  const lineCount = materialize(circuit, exists.slice(0, config.lineSlots).map(bit => [bit, 1]), 0, 1, config.lineSlots)
  return {keys, centers, starts, startKeys, exists, forced, endCarets, lineCount, overflow: exists[config.lineSlots]!}
}

// One-hot of the line containing a position: [position >= start of line k] is a run of ones.
function lineGroup(context: Context, layout: LayoutWires, position: Wire) {
  const {circuit, config} = context
  const atLeast = Array.from({length: config.lineSlots - 1}, (_, index) => atLeastZero(circuit, [[position, 1], [layout.starts[index + 1]!, -1]]))
  const line = atLeast.length === 0 ? context.zero : materialize(circuit, atLeast.map(bit => [bit, 1]), 0, 0, config.lineSlots - 1)
  return {members: oneHotFromMonotone(circuit, atLeast), line, atLeast}
}

// Latest word start before the caret and earliest word end after it, as masked tournaments.
// caretAtLeast[p] is [caret >= p + 1], i.e. [p < caret].
function wordTargets(context: Context, decoded: DecodedCells, caretAtLeast: readonly Wire[], length: Wire) {
  const {circuit, config, zero} = context
  const capacity = config.capacity
  const {word} = decoded
  const leftLeaves = Array.from({length: capacity}, (_, position) => {
    if (position === 0) return zero
    const wordStart = circuit.reglu([[word[position]!, 1]], 0, [[word[position - 1]!, -1]], 1)
    return circuit.reglu([[wordStart, position]], 0, [[caretAtLeast[position]!, 1]], 0)
  })
  const noWordEnd = capacity + 1
  const rightLeaves = Array.from({length: capacity}, (_, index) => {
    const position = index + 1
    const wordEnd = position === capacity ? word[capacity - 1]! : circuit.reglu([[word[position - 1]!, 1]], 0, [[word[position]!, -1]], 1)
    // [position > caret] = 1 - [caret >= position].
    const endAfterCaret = circuit.reglu([[wordEnd, 1]], 0, [[caretAtLeast[position - 1]!, -1]], 1)
    return materialize(circuit, [[endAfterCaret, position - noWordEnd]], noWordEnd, position, noWordEnd)
  })
  return {
    left: tournament(leftLeaves, (earlier, later) => integerMaximum(circuit, earlier, later)),
    right: integerMinimum(circuit, tournament(rightLeaves, (earlier, later) => integerMinimum(circuit, earlier, later)), length),
  }
}

function buildStep(context: Context, state: StateWires, decoded: DecodedCells, layout: LayoutWires | null, slot: SlotLayout): StateWires {
  const {circuit, config, limits, zero} = context
  const capacity = config.capacity
  const lines = config.lineSlots
  const kinds = keyKinds.map((_, index) => slot.kind + index)
  const kindBit = (kind: KeyKind) => kinds[keyKinds.indexOf(kind)]!
  const byKind = (candidates: Partial<Record<KeyKind, Wire>>, fallback: Wire) => gather(circuit, kinds, keyKinds.map(kind => candidates[kind] ?? fallback))
  const {caret, anchor, length} = state
  mark(context, 'key: caret and word targets')

  const selectionStart = integerMinimum(circuit, anchor, caret)
  const selectionEnd = integerMaximum(circuit, anchor, caret)
  const hasSelection = atLeastZero(circuit, [[selectionEnd, 1], [selectionStart, -1]], -1)
  const caretAtLeast = Array.from({length: capacity}, (_, index) => atLeastZero(circuit, [[caret, 1]], -(index + 1)))
  const words = wordTargets(context, decoded, caretAtLeast, length)
  const collapse = circuit.reglu([[hasSelection, 1]], 0, [[slot.shift, -1]], 1)
  circuit.assumeRange(collapse, 0, 1)
  const oneBack = circuit.reglu([], 1, [[caret, 1]], -1)
  circuit.assumeRange(oneBack, 0, capacity)
  const oneForward = integerMinimum(circuit, materialize(circuit, [[caret, 1]], 1, 1, capacity + 1), length)

  // Line geometry targets, only in layout slots.
  let lineTargets: Partial<Record<KeyKind, Wire>> = {}
  let targetX = zero
  if (layout !== null) {
    mark(context, 'key: lines and hit test')
    const caretPosition = oneHotFromMonotone(circuit, caretAtLeast)
    const caretKey = gather(circuit, caretPosition, layout.keys)
    const caretLine = lineGroup(context, layout, caret)
    const lineSlice = (wires: readonly Wire[], offset = 0) => wires.slice(offset, offset + lines)
    const caretLineStart = gather(circuit, caretLine.members, lineSlice(layout.starts))
    const caretLineKey = gather(circuit, caretLine.members, lineSlice(layout.startKeys))
    const caretLineEnd = gather(circuit, caretLine.members, layout.endCarets)
    const nextLineExists = gather(circuit, caretLine.members, lineSlice(layout.exists, 1))
    const caretX = materialize(circuit, [[caretKey, 1], [caretLineKey, -1]], 0, 0, limits.lineXMaximum)
    targetX = pick(circuit, state.hasPreferredX, caretX, state.preferredX)

    // The line under the pointer, clamped to the last line.
    const pointerRows = Array.from({length: lines - 1}, (_, index) => atLeastZero(circuit, [[slot.pointerY, 1], [context.source.lineHeight, -(index + 1)]]))
    const pointerRow = pointerRows.length === 0 ? zero : materialize(circuit, pointerRows.map(bit => [bit, 1]), 0, 0, lines - 1)
    const lastLine = materialize(circuit, [[layout.lineCount, 1]], -1, 0, lines - 1)
    const clickedLine = integerMinimum(circuit, pointerRow, lastLine)

    // One hit test per step: the up, down and pointer kinds each pick their target line and x.
    const lineAbove = materialize(circuit, [[caretLine.line, 1]], -1, -1, lines - 2)
    const lineBelow = materialize(circuit, [[caretLine.line, 1]], 1, 1, lines)
    const hitLine = byKind({up: lineAbove, down: lineBelow, pointerDown: clickedLine, pointerDrag: clickedLine}, zero)
    const hitX = byKind({up: targetX, down: targetX, pointerDown: slot.pointerX, pointerDrag: slot.pointerX}, zero)
    const hitAtLeast = Array.from({length: lines - 1}, (_, index) => atLeastZero(circuit, [[hitLine, 1]], -(index + 1)))
    const hitGroup = oneHotFromMonotone(circuit, hitAtLeast)
    const hitLineStart = gather(circuit, hitGroup, lineSlice(layout.starts))
    const hitLineKey = gather(circuit, hitGroup, lineSlice(layout.startKeys))
    const hitLineEnd = gather(circuit, hitGroup, layout.endCarets)
    const pointerKey = materialize(circuit, [[hitLineKey, 2], [hitX, 2]], 0, 0, 2 * (limits.keyMaximum + Math.max(limits.lineXMaximum, limits.pointerXMaximum)))
    // Glyph centers never decrease, so the glyphs left of the pointer are a count.
    const centersLeft = materialize(circuit, layout.centers.map(center => [atLeastZero(circuit, [[pointerKey, 1], [center, -1]], -1), 1]), 0, 0, capacity)
    const hit = integerMinimum(circuit, integerMaximum(circuit, centersLeft, hitLineStart), hitLineEnd)
    const isFirstLine = caretLine.atLeast.length === 0 ? constant(circuit, 1) : materialize(circuit, [[caretLine.atLeast[0]!, -1]], 1, 0, 1)
    lineTargets = {
      lineStart: caretLineStart,
      lineEnd: caretLineEnd,
      up: pick(circuit, isFirstLine, hit, zero),
      down: pick(circuit, nextLineExists, length, hit),
      pointerDown: hit,
      pointerDrag: hit,
    }
  }

  // Edits: replace [editStart, editEnd) with the pasted codes.
  mark(context, 'key: edit range, caret and anchor')
  const room = materialize(circuit, [[selectionEnd, 1], [selectionStart, -1], [length, -1]], capacity, 0, capacity)
  const pasteCount = integerMinimum(circuit, slot.count, room)
  const editStart = byKind({
    insert: selectionStart,
    backspace: pick(circuit, hasSelection, oneBack, selectionStart),
    delete: selectionStart,
    wordBackspace: pick(circuit, hasSelection, words.left, selectionStart),
  }, zero)
  const editEnd = byKind({
    insert: selectionEnd,
    backspace: selectionEnd,
    delete: pick(circuit, hasSelection, oneForward, selectionEnd),
    wordBackspace: selectionEnd,
  }, zero)
  const insertCount = maskValue(circuit, pasteCount, kindBit('insert'))
  circuit.assumeRange(insertCount, 0, config.pasteLimit)
  const editCaret = materialize(circuit, [[editStart, 1], [insertCount, 1]], 0, 0, capacity)
  const newLength = materialize(circuit, [[length, 1], [editEnd, -1], [editStart, 1], [insertCount, 1]], 0, 0, capacity)

  const newCaret = byKind({
    none: caret,
    insert: editCaret,
    backspace: editCaret,
    delete: editCaret,
    wordBackspace: editCaret,
    left: pick(circuit, collapse, oneBack, selectionStart),
    right: pick(circuit, collapse, oneForward, selectionEnd),
    wordLeft: words.left,
    wordRight: words.right,
    documentStart: zero,
    documentEnd: length,
    selectAll: length,
    ...lineTargets,
  }, zero)
  circuit.assumeRange(newCaret, 0, capacity)
  const extendsSelection = circuit.reglu([[slot.shift, 1]], 0, [...movementKinds, 'pointerDown' as const].map(kind => [kindBit(kind), 1]), 0)
  const keepAnchor = materialize(circuit, [[kindBit('none'), 1], [kindBit('pointerDrag'), 1], [extendsSelection, 1]], 0, 0, 1)
  const anchorTarget = materialize(circuit, [[newCaret, 1], [maskValue(circuit, length, kindBit('selectAll')), -1]], 0, 0, capacity)
  const newAnchor = pick(circuit, keepAnchor, anchorTarget, anchor)
  const vertical = circuit.affine([[kindBit('up'), 1], [kindBit('down'), 1]])
  const newHasPreferredX = materialize(circuit, [[kindBit('up'), 1], [kindBit('down'), 1], [andBits(circuit, state.hasPreferredX, kindBit('none')), 1]], 0, 0, 1)
  const newPreferredX = materialize(circuit, [[maskValue(circuit, targetX, vertical), 1], [maskValue(circuit, state.preferredX, kindBit('none')), 1]], 0, 0, limits.lineXMaximum)

  // Cells: head keeps cells before editStart, the pasted codes land at editStart, and the tail from
  // editEnd moves by editEnd - editStart - insertCount.
  mark(context, 'key: pasted code lookups')
  const pasted: Wire[] = Array.from({length: config.pasteLimit}, (_, index) => {
    const code = integerOneHot(circuit, slot.codes + index, config.codeLimit)
    const tableEntries = Array.from({length: config.codeLimit}, (_, entry) => context.source.table + entry)
    const entry = gather(circuit, code, tableEntries)
    const accepted = atLeastZero(circuit, [[insertCount, 1]], -(index + 1))
    return maskValue(circuit, entry, accepted)
  })
  mark(context, 'key: cell rewrite')
  const heads = Array.from({length: capacity}, (_, cell) => maskValue(circuit, state.cells[cell]!, atLeastZero(circuit, [[editStart, 1]], -(cell + 1))))
  const tails = Array.from({length: capacity}, (_, cell) => maskValue(circuit, state.cells[cell]!, atLeastZero(circuit, [[editEnd, -1]], cell)))
  const shiftToStart = materialize(circuit, [[editEnd, 1], [editStart, -1], [insertCount, -1]], config.pasteLimit, 0, capacity + config.pasteLimit)
  let movedTails: (Wire | null)[]
  let placedPaste: (Wire | null)[]
  if ((config.shift ?? 'barrel') === 'barrel') {
    const shiftBits = integerBits(circuit, shiftToStart, bitCountFor(capacity + config.pasteLimit))
    movedTails = barrelShiftTowardStart(circuit, [...Array<Wire | null>(config.pasteLimit).fill(null), ...tails], shiftBits, capacity)
    placedPaste = barrelShiftTowardEnd(circuit, pasted, integerBits(circuit, editStart, bitCountFor(capacity)), capacity)
  } else {
    // One shared one-hot per shift amount, then one gather read per cell. The reads store no weights
    // but each one keeps a candidate table as long as the group.
    const shiftGroup = integerOneHot(circuit, shiftToStart, capacity + config.pasteLimit + 1)
    const startGroup = integerOneHot(circuit, editStart, capacity + 1)
    movedTails = Array.from({length: capacity}, (_, cell) =>
      gather(circuit, shiftGroup, shiftGroup.map((_, shift) => tails[cell + shift - config.pasteLimit] ?? zero)))
    placedPaste = Array.from({length: capacity}, (_, cell) =>
      gather(circuit, startGroup, startGroup.map((_, start) => cell - start >= 0 ? pasted[cell - start] ?? zero : zero)))
  }
  const cells = heads.map((head, cell) => {
    const terms: [Wire, number][] = [[head, 1]]
    if (placedPaste[cell] !== null) terms.push([placedPaste[cell]!, 1])
    if (movedTails[cell] !== null) terms.push([movedTails[cell]!, 1])
    return materialize(circuit, terms, 0, 0, limits.cellMaximum)
  })
  return {cells, length: newLength, caret: newCaret, anchor: newAnchor, preferredX: newPreferredX, hasPreferredX: newHasPreferredX}
}

type DisplayWires = {
  lineStarts: Wire[]
  lineCount: Wire
  overflowCount: Wire
  caretLine: Wire
  caretX: Wire
  selectionLeft: Wire[]
  selectionRight: Wire[]
  glyphLine: Wire[]
  glyphX: Wire[]
}

function buildDisplay(context: Context, state: StateWires, layout: LayoutWires, overflowBits: readonly Wire[]): DisplayWires {
  const {circuit, config, limits} = context
  const capacity = config.capacity
  const lines = config.lineSlots
  mark(context, 'display: caret and selection')
  const caretKey = gather(circuit, integerOneHot(circuit, state.caret, capacity + 1), layout.keys)
  const anchorKey = gather(circuit, integerOneHot(circuit, state.anchor, capacity + 1), layout.keys)
  const selectionStartKey = integerMinimum(circuit, anchorKey, caretKey)
  const selectionEndKey = integerMaximum(circuit, anchorKey, caretKey)
  const caretLine = lineGroup(context, layout, state.caret)
  const caretLineKey = gather(circuit, caretLine.members, layout.startKeys.slice(0, lines))
  const caretX = materialize(circuit, [[caretKey, 1], [caretLineKey, -1]], 0, 0, limits.lineXMaximum)
  const selectionLeft: Wire[] = []
  const selectionRight: Wire[] = []
  for (let line = 0; line < lines; line++) {
    const startKey = layout.startKeys[line]!
    // A line that ends with a newline paints up to the newline, not past its offset.
    const beforeNewline = materialize(circuit, [[layout.startKeys[line + 1]!, 1], [layout.forced[line]!, -limits.newlineOffset]], 0, 0, limits.keyMaximum)
    const paintedEndKey = pick(circuit, layout.exists[line + 1]!, layout.keys[capacity]!, beforeNewline)
    const clampToLine = (key: Wire) => integerMinimum(circuit, integerMaximum(circuit, key, startKey), paintedEndKey)
    selectionLeft.push(materialize(circuit, [[clampToLine(selectionStartKey), 1], [startKey, -1]], 0, 0, limits.lineXMaximum))
    selectionRight.push(materialize(circuit, [[clampToLine(selectionEndKey), 1], [startKey, -1]], 0, 0, limits.lineXMaximum))
  }
  const glyphLine: Wire[] = []
  const glyphX: Wire[] = []
  if (config.glyphOutputs) {
    mark(context, 'display: glyph positions')
    for (let cell = 0; cell < capacity; cell++) {
      const atLeast = Array.from({length: lines - 1}, (_, index) => atLeastZero(circuit, [[layout.starts[index + 1]!, -1]], cell))
      const members = oneHotFromMonotone(circuit, atLeast)
      glyphLine.push(atLeast.length === 0 ? context.zero : materialize(circuit, atLeast.map(bit => [bit, 1]), 0, 0, lines - 1))
      const lineKey = gather(circuit, members, layout.startKeys.slice(0, lines))
      glyphX.push(materialize(circuit, [[layout.keys[cell]!, 1], [lineKey, -1]], 0, -limits.keyMaximum, limits.keyMaximum))
    }
  }
  return {
    lineStarts: layout.starts.slice(0, lines),
    lineCount: layout.lineCount,
    overflowCount: materialize(circuit, overflowBits.map(bit => [bit, 1]), 0, 0, overflowBits.length),
    caretLine: caretLine.line,
    caretX,
    selectionLeft,
    selectionRight,
    glyphLine,
    glyphX,
  }
}

export type EditorBuild = {
  config: EditorConfig
  circuit: Circuit
  source: SourceLayout
  nextState: StateWires
  display: DisplayWires
  // Roots in a fixed order: next state first, then display.
  roots: Wire[]
  phases: Phase[]
}

export function buildEditorCircuit(config: EditorConfig): EditorBuild {
  const limits = editorLimits(config)
  const source = createSourceLayout(config)
  const circuit = new Circuit(source.size)
  circuit.assumeRange(source.unit, 1, 1)
  circuit.assumeRange(source.maxWidth, 1, config.maxWidthLimit - 1)
  circuit.assumeRange(source.lineHeight, 1, 4096)
  circuit.assumeRange(source.length, 0, config.capacity)
  circuit.assumeRange(source.caret, 0, config.capacity)
  circuit.assumeRange(source.anchor, 0, config.capacity)
  circuit.assumeRange(source.preferredX, 0, limits.lineXMaximum)
  circuit.assumeRange(source.hasPreferredX, 0, 1)
  for (let cell = 0; cell < config.capacity; cell++) circuit.assumeRange(source.cells + cell, 0, limits.cellMaximum)
  for (let entry = 0; entry < config.codeLimit; entry++) circuit.assumeRange(source.table + entry, 0, limits.cellMaximum)
  for (const slot of source.slots) {
    // JS writes exactly one kind per slot; tests check the promise with validateOneHotGroups.
    circuit.assumeOneHot(keyKinds.map((_, index) => slot.kind + index))
    circuit.assumeRange(slot.shift, 0, 1)
    circuit.assumeRange(slot.count, 0, config.pasteLimit)
    for (let index = 0; index < config.pasteLimit; index++) circuit.assumeRange(slot.codes + index, 0, config.codeLimit - 1)
    circuit.assumeRange(slot.pointerX, 0, limits.pointerXMaximum)
    circuit.assumeRange(slot.pointerY, 0, limits.pointerYMaximum)
  }
  const context: Context = {circuit, config, limits, source, zero: constant(circuit, 0), phases: [], scope: 'sources'}
  let state: StateWires = {
    cells: Array.from({length: config.capacity}, (_, cell) => source.cells + cell),
    length: source.length,
    caret: source.caret,
    anchor: source.anchor,
    preferredX: source.preferredX,
    hasPreferredX: source.hasPreferredX,
  }
  const overflowBits: Wire[] = []
  const layoutSlots = layoutSlotCount(config)
  source.slots.forEach((slot, index) => {
    context.scope = index < layoutSlots ? 'layout key' : 'buffer key'
    const decoded = decodeCells(context, state.cells)
    let layout: LayoutWires | null = null
    if (index < layoutSlots) {
      layout = buildLayout(context, state, decoded)
      overflowBits.push(layout.overflow)
    }
    state = buildStep(context, state, decoded, layout, slot)
  })
  context.scope = 'final'
  const finalLayout = buildLayout(context, state, decodeCells(context, state.cells))
  overflowBits.push(finalLayout.overflow)
  const display = buildDisplay(context, state, finalLayout, overflowBits)
  const roots = [
    ...state.cells,
    state.length,
    state.caret,
    state.anchor,
    state.preferredX,
    state.hasPreferredX,
    ...display.lineStarts,
    display.lineCount,
    display.overflowCount,
    display.caretLine,
    display.caretX,
    ...display.selectionLeft,
    ...display.selectionRight,
    ...display.glyphLine,
    ...display.glyphX,
  ]
  return {config, circuit, source, nextState: state, display, roots, phases: context.phases}
}

export type EditorFrame = {
  state: EditorState
  display: EditorDisplay & {overflowCount: number}
}

export function writeEvent(source: Float32Array, config: EditorConfig, layout: SourceLayout, slotIndex: number, input: EditorEvent) {
  const slot = layout.slots[slotIndex]!
  invariant(input.codes.length <= config.pasteLimit, 'too many codes for one event')
  invariant(slotIndex < layoutSlotCount(config) || !layoutKinds.includes(input.kind), 'a key that reads line geometry needs a layout slot')
  for (let index = 0; index < keyKinds.length; index++) source[slot.kind + index] = 0
  source[slot.kind + keyKinds.indexOf(input.kind)] = 1
  source[slot.shift] = input.shift ? 1 : 0
  source[slot.count] = input.codes.length
  for (let index = 0; index < config.pasteLimit; index++) source[slot.codes + index] = input.codes[index] ?? 0
  source[slot.pointerX] = input.pointerX
  source[slot.pointerY] = input.pointerY
}

export function writeState(source: Float32Array, config: EditorConfig, layout: SourceLayout, state: EditorState) {
  for (let cell = 0; cell < config.capacity; cell++) source[layout.cells + cell] = state.cells[cell]!
  source[layout.length] = state.length
  source[layout.caret] = state.caret
  source[layout.anchor] = state.anchor
  source[layout.preferredX] = state.preferredX
  source[layout.hasPreferredX] = state.hasPreferredX
}

export function readFrame(config: EditorConfig, values: Float32Array): EditorFrame {
  let cursor = 0
  const take = (count: number) => {
    const slice = Array.from(values.subarray(cursor, cursor + count))
    cursor += count
    return slice
  }
  const cells = take(config.capacity)
  const [length, caret, anchor, preferredX, hasPreferredX] = take(5) as [number, number, number, number, number]
  const lineStarts = take(config.lineSlots)
  const [lineCount, overflowCount, caretLine, caretX] = take(4) as [number, number, number, number]
  const selectionLeft = take(config.lineSlots)
  const selectionRight = take(config.lineSlots)
  const glyphLine = config.glyphOutputs ? take(config.capacity) : []
  const glyphX = config.glyphOutputs ? take(config.capacity) : []
  return {
    state: {cells, length, caret, anchor, preferredX, hasPreferredX},
    display: {lineStarts, lineCount, overflowCount, caretLine, caretX, selectionLeft, selectionRight, glyphLine, glyphX},
  }
}

export type EditorMachine = {
  build: EditorBuild
  source: Float32Array
  setGeometry: (maxWidth: number, lineHeight: number) => void
  setTableEntry: (code: number, packed: number) => void
  load: (state: EditorState) => void
  // Applies up to keysPerFrame events in one evaluation, writes the next state back into the table.
  runFrame: (events: readonly EditorEvent[]) => EditorFrame
}

export function createEditorMachine(config: EditorConfig, build = buildEditorCircuit(config)): EditorMachine {
  const {circuit, source: layout, roots} = build
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(layout.size)
  source[layout.unit] = 1
  source[layout.maxWidth] = 1
  source[layout.lineHeight] = 1
  for (let slot = 0; slot < config.keysPerFrame; slot++) source[layout.slots[slot]!.kind] = 1
  return {
    build,
    source,
    setGeometry: (maxWidth, lineHeight) => {
      source[layout.maxWidth] = maxWidth
      source[layout.lineHeight] = lineHeight
    },
    setTableEntry: (code, packed) => {
      source[layout.table + code] = packed
    },
    load: state => writeState(source, config, layout, state),
    runFrame: events => {
      invariant(events.length <= config.keysPerFrame, 'more events than key slots')
      for (let slot = 0; slot < config.keysPerFrame; slot++) {
        writeEvent(source, config, layout, slot, events[slot] ?? {kind: 'none', shift: false, codes: [], pointerX: 0, pointerY: 0})
      }
      const frame = readFrame(config, evaluate(source))
      writeState(source, config, layout, frame.state)
      return frame
    },
  }
}

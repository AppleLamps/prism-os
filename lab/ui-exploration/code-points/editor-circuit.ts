// A text field whose editing model is one fixed circuit, with one Unicode code point per cell. The
// source table holds the code point buffer, length, caret, selection anchor, preferred x, the line
// break tables (a two-level class table, class properties, and a pair table of break bits), a
// two-level advance table, and one event slot per queued keystroke. Each slot unrolls one step: read
// every cell's class, advance and break bit from the tables, lay out the buffer (only in layout
// slots), decide the caret, anchor and edit range, then rewrite every cell. A final layout produces
// the display outputs. Strings never enter; JS iterates code points, measures new ones, and fills
// tables.
//
// Copied from lab/ui-exploration/text-editing/editor-circuit.ts. What changed: cells hold code points
// instead of packed grapheme codes; decoding reads tables instead of floors and comparisons; break
// opportunities come from the pair table instead of the space class; pasted code points go into cells
// directly instead of through a one-hot lookup; and positionReads: 'index' reads tables at counts the
// circuit already has.

import {Circuit, type Wire, invariant} from './numeric-ui-core.ts'
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
  suffixScan,
  tournament,
} from './integer-circuits.ts'
import {classCount, LB} from './line-break-classes.ts'
import {
  type AdvanceTable,
  advanceLimit,
  blockCount,
  classTables,
  codePointMaximum,
  createAdvanceTable,
  type MeasureCodePoint,
  pageBits,
  pageSize,
  propertyTables,
} from './tables.ts'
import {
  type EditorConfig,
  type EditorDisplay,
  type EditorEvent,
  type EditorState,
  keyKinds,
  type KeyKind,
  layoutKinds,
  layoutSlotCount,
  movementKinds,
} from './reference.ts'

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
  classBlocks: number
  classPages: number
  spaceOrNewline: number
  newline: number
  word: number
  pairs: number
  emergencyPairs: number
  advanceBlocks: number
  advancePages: number
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
    classBlocks: take(blockCount),
    classPages: take(classTables().pageCount * pageSize),
    spaceOrNewline: take(classCount),
    newline: take(classCount),
    word: take(classCount),
    pairs: take(classCount * classCount),
    emergencyPairs: take(classCount * classCount),
    advanceBlocks: take(blockCount),
    advancePages: take(config.advancePageLimit * pageSize),
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

// Source cells that hold tables, as opposed to state, geometry and events.
export function tableSourceCells(layout: SourceLayout, config: EditorConfig) {
  return {
    classBlocks: blockCount,
    classPages: classTables().pageCount * pageSize,
    classProperties: 3 * classCount,
    pairs: classCount * classCount,
    emergencyPairs: classCount * classCount,
    advanceBlocks: blockCount,
    advancePages: config.advancePageLimit * pageSize,
    total: layout.slots[0] === undefined ? layout.size - layout.classBlocks : layout.slots[0].kind - layout.classBlocks,
  }
}

export function editorLimits(config: EditorConfig) {
  const advanceMaximum = advanceLimit - 1
  const newlineOffset = config.maxWidthLimit
  // Position keys: advance prefix sums plus newlineOffset per newline before the position.
  const keyMaximum = config.capacity * (advanceMaximum + newlineOffset)
  const lineXMaximum = config.capacity * advanceMaximum
  const pointerXMaximum = config.maxWidthLimit
  invariant(2 * (keyMaximum + Math.max(lineXMaximum, pointerXMaximum)) < 2 ** 23, 'capacity and maxWidthLimit leave no exact FP32 headroom for position keys')
  invariant(config.capacity >= 2 && config.lineSlots >= 1 && config.pasteLimit >= 1 && config.advancePageLimit >= 2, 'editor config is too small')
  return {advanceMaximum, newlineOffset, keyMaximum, lineXMaximum, pointerXMaximum, cellMaximum: codePointMaximum, pointerYMaximum: 2 ** 16}
}

// Operations appended from firstOperation until the next phase belong to this phase.
export type Phase = {name: string, scope: string, firstOperation: number}

// Source wires of every table, each created once, so every read of a table shares one candidates
// array.
type Tables = {
  classBlocks: Wire[]
  classPages: Wire[]
  spaceOrNewline: Wire[]
  newline: Wire[]
  word: Wire[]
  pairs: Wire[]
  emergencyPairs: Wire[]
  advanceBlocks: Wire[]
  advancePages: Wire[]
}

type Context = {
  circuit: Circuit
  config: EditorConfig
  limits: ReturnType<typeof editorLimits>
  source: SourceLayout
  tables: Tables
  zero: Wire
  phases: Phase[]
  // 'layout key', 'buffer key', or 'final'.
  scope: string
}

type DecodeContext = Pick<Context, 'circuit' | 'config' | 'tables' | 'phases' | 'scope'>

function mark(context: Pick<Context, 'circuit' | 'phases' | 'scope'>, name: string) {
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
  classes: Wire[]
  advance: Wire[]
  // 1 for spaces and newlines, which don't count toward a line's fit edge.
  spaceOrNewline: Wire[]
  newline: Wire[]
  word: Wire[]
  // breakAfter[c] is 1 when a line may break between cell c and cell c + 1.
  breakAfter: Wire[]
  // 1 when a run that doesn't fit on a line by itself may break between cell c and cell c + 1.
  emergencyBreakAfter: Wire[]
}

// A position the circuit already holds as an integer, e.g. the first cell that doesn't fit, together
// with its run of ones atLeast[j] = [index >= j + 1]. readAt reads a table at the position.
type Position = {index: Wire, atLeast: () => readonly Wire[], members?: Wire[]}

function countPosition(index: Wire, atLeast: readonly Wire[]): Position {
  return {index, atLeast: () => atLeast}
}

// A position whose run of ones is only built when a one-hot read needs it, for an integer in
// 0..positions-1.
function comparedPosition(context: Context, index: Wire, positions: number): Position {
  let atLeast: Wire[] | null = null
  return {index, atLeast: () => atLeast ??= Array.from({length: positions - 1}, (_, position) => atLeastZero(context.circuit, [[index, 1]], -(position + 1)))}
}

// Both forms clamp an index outside the table to its nearest end, which is what the one-hot's first
// and last members do.
function readAt(context: Context, position: Position, table: readonly Wire[]): Wire {
  const {circuit, config} = context
  if (table.length === 1) return table[0]!
  if ((config.positionReads ?? 'one-hot') === 'index') return circuit.indexRead(position.index, table)
  position.members ??= oneHotFromMonotone(circuit, position.atLeast())
  return gather(circuit, position.members, table)
}

// Per cell: the block's offset (1 read, or 3 floor atoms and 1 read), the class (1 read), the
// advance's block offset and advance (2 reads), then 1 read per class property and 1 pair read for
// the break bit. A key step that doesn't lay out only keeps the reads its word targets use.
function decodeCells(context: DecodeContext, cells: readonly Wire[]): DecodedCells {
  const {circuit, config, tables} = context
  mark(context, 'decode: class and advance reads')
  const blocks = new Map<Wire, Wire>()
  const blockOffset = (cell: Wire, blockTable: readonly Wire[]) => {
    if ((config.blockIndex ?? 'shift read') === 'shift read') {
      // floor(codePoint * 2^-7) is exact in FP32 for any code point, so the read lands on the block.
      return circuit.indexReadAffine([[cell, 2 ** -pageBits]], 0, blockTable, 'clamp', 'clamp')
    }
    let block = blocks.get(cell)
    if (block === undefined) {
      block = floorByPowerOfTwo(circuit, cell, pageBits)
      blocks.set(cell, block)
    }
    return circuit.indexRead(block, blockTable)
  }
  const classes = cells.map(cell => circuit.indexReadAffine([[blockOffset(cell, tables.classBlocks), 1], [cell, 1]], 0, tables.classPages, 'clamp', 'clamp'))
  const advance = cells.map(cell => circuit.indexReadAffine([[blockOffset(cell, tables.advanceBlocks), 1], [cell, 1]], 0, tables.advancePages, 'clamp', 'clamp'))
  mark(context, 'decode: class properties and break bits')
  const spaceOrNewline = classes.map(lineBreakClass => circuit.indexRead(lineBreakClass, tables.spaceOrNewline))
  const newline = classes.map(lineBreakClass => circuit.indexRead(lineBreakClass, tables.newline))
  const word = classes.map(lineBreakClass => circuit.indexRead(lineBreakClass, tables.word))
  const breakAfter = classes.map((lineBreakClass, cell) => cell + 1 < classes.length
    ? circuit.indexReadAffine([[lineBreakClass, classCount], [classes[cell + 1]!, 1]], 0, tables.pairs, 'clamp', 'clamp')
    : circuit.indexReadAffine([[lineBreakClass, classCount]], LB.empty, tables.pairs, 'clamp', 'clamp'))
  const emergencyBreakAfter = classes.map((lineBreakClass, cell) => cell + 1 < classes.length
    ? circuit.indexReadAffine([[lineBreakClass, classCount], [classes[cell + 1]!, 1]], 0, tables.emergencyPairs, 'clamp', 'clamp')
    : circuit.indexReadAffine([[lineBreakClass, classCount]], LB.empty, tables.emergencyPairs, 'clamp', 'clamp'))
  return {classes, advance, spaceOrNewline, newline, word, breakAfter, emergencyBreakAfter}
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

function buildLayout(context: Context, state: StateWires, decoded: DecodedCells): LayoutWires {
  const {circuit, config, limits, zero} = context
  const capacity = config.capacity
  const {advance, spaceOrNewline, newline, breakAfter} = decoded

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
  const contentRightEdges = keys.slice(1).map((key, cell) => maskValue(circuit, key, circuit.affine([[spaceOrNewline[cell]!, -1], [newline[cell]!, 1]], 1)))
  const fitEdges = prefixScan(contentRightEdges, maximum, config.scan)
  const centers = advance.map((wire, cell) => materialize(circuit, [[keys[cell]!, 2], [wire, 1]], 0, 0, 2 * limits.keyMaximum + limits.advanceMaximum))

  // Break tables: a break opportunity sits after cell c when the pair table says so. For a first
  // failing cell c, breakStarts[c] is where the next line starts when the line breaks at an
  // opportunity, and breakKeys[c] is the position key there.
  const opportunityLeaves = [zero, ...breakAfter.map((bit, cell) => circuit.affine([[bit, cell + 1]]))]
  const opportunityKeyLeaves = [zero, ...breakAfter.map((bit, cell) => maskValue(circuit, keys[cell + 1]!, bit))]
  const latestOpportunity = prefixScan(opportunityLeaves, maximum, config.scan)
  const latestOpportunityKey = prefixScan(opportunityKeyLeaves, maximum, config.scan)
  const breakStarts = latestOpportunity.map((wire, cell) => cell === capacity ? wire : pick(circuit, newline[cell]!, wire, constant(circuit, cell + 1)))
  const breakKeys = latestOpportunityKey.map((wire, cell) => cell === capacity ? wire : pick(circuit, newline[cell]!, wire, keys[cell + 1]!))
  const newlineTable = [...newline, zero]
  const keysAfter = keys.map((_, cell) => keys[Math.min(cell + 1, capacity)]!)
  const lastKey = keys[capacity]!
  const noLine = constant(circuit, capacity + 1)

  // Only for overflow: 'cjk whole'. emergencyBefore[c] says whether a run may break before cell c when
  // it doesn't fit by itself, and overflowStarts[c] is the first break opportunity at or after cell c,
  // where a run that's kept whole ends. Opportunities never go backward, so it's a suffix minimum.
  const keepsCJKWhole = config.overflow === 'cjk whole'
  const emergencyBefore = [constant(circuit, 1), ...decoded.emergencyBreakAfter]
  const overflowStarts = keepsCJKWhole
    ? suffixScan([...breakAfter.map((bit, cell) => materialize(circuit, [[bit, cell - capacity]], capacity + 1, cell + 1, capacity + 1)), noLine], (earlier, later) => integerMinimum(circuit, earlier, later), config.scan)
    : []

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
    const firstFailing = materialize(circuit, fits.map(bit => [bit, 1]), 0, 0, capacity)
    const failing = countPosition(firstFailing, fits)
    const breakStart = readAt(context, failing, breakStarts)
    const breakKey = readAt(context, failing, breakKeys)
    const endsWithNewline = readAt(context, failing, newlineTable)
    const failingKey = readAt(context, failing, keys)
    const failingKeyAfter = readAt(context, failing, keysAfter)
    // No opportunity after the line start: break inside the word, at the failing cell, but always
    // take at least one cell.
    const insideWord = atLeastZero(circuit, [[start, 1], [breakStart, -1]])
    const stuck = atLeastZero(circuit, [[start, 1], [firstFailing, -1]])
    let insideStart = materialize(circuit, [[firstFailing, 1], [stuck, 1]], 0, 0, capacity + 1)
    let insideKey = pick(circuit, stuck, failingKey, failingKeyAfter)
    let lineEndsWithNewline = endsWithNewline
    if (keepsCJKWhole) {
      // A run touching CJK classes that doesn't fit by itself stays whole up to its next opportunity.
      const breaksInside = integerMaximum(circuit, readAt(context, failing, emergencyBefore), stuck)
      const overflowStart = readAt(context, failing, overflowStarts)
      const overflowKey = readAt(context, comparedPosition(context, overflowStart, capacity + 1), keys)
      const overflowLastCell = materialize(circuit, [[overflowStart, 1]], -1, 0, capacity)
      const overflowEndsWithNewline = readAt(context, comparedPosition(context, overflowLastCell, capacity + 1), newlineTable)
      insideStart = pick(circuit, breaksInside, overflowStart, insideStart)
      insideKey = pick(circuit, breaksInside, overflowKey, insideKey)
      lineEndsWithNewline = pick(circuit, insideWord, endsWithNewline, pick(circuit, breaksInside, overflowEndsWithNewline, endsWithNewline))
    }
    const next = pick(circuit, insideWord, breakStart, insideStart)
    const nextKey = pick(circuit, insideWord, breakKey, insideKey)
    // The text ends on this line when everything fits, or when a soft break lands at the end.
    const textEnds = atLeastZero(circuit, [[next, 1], [fits[capacity - 1]!, capacity], [state.length, -1], [lineEndsWithNewline, -1]])
    starts.push(pick(circuit, textEnds, next, noLine))
    startKeys.push(pick(circuit, textEnds, nextKey, lastKey))
    forced.push(lineEndsWithNewline)
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

// The line containing a position: [position >= start of line k] is a run of ones, and its count is
// the line.
function lineGroup(context: Context, layout: LayoutWires, position: Wire) {
  const {circuit, config} = context
  const atLeast = Array.from({length: config.lineSlots - 1}, (_, index) => atLeastZero(circuit, [[position, 1], [layout.starts[index + 1]!, -1]]))
  const line = atLeast.length === 0 ? context.zero : materialize(circuit, atLeast.map(bit => [bit, 1]), 0, 0, config.lineSlots - 1)
  return {position: countPosition(line, atLeast), line, atLeast}
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
    const caretKey = readAt(context, countPosition(caret, caretAtLeast), layout.keys)
    const caretLine = lineGroup(context, layout, caret)
    const lineSlice = (wires: readonly Wire[], offset = 0) => wires.slice(offset, offset + lines)
    const caretLineStart = readAt(context, caretLine.position, lineSlice(layout.starts))
    const caretLineKey = readAt(context, caretLine.position, lineSlice(layout.startKeys))
    const caretLineEnd = readAt(context, caretLine.position, layout.endCarets)
    const nextLineExists = readAt(context, caretLine.position, lineSlice(layout.exists, 1))
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
    const hitGroup = comparedPosition(context, hitLine, lines)
    const hitLineStart = readAt(context, hitGroup, lineSlice(layout.starts))
    const hitLineKey = readAt(context, hitGroup, lineSlice(layout.startKeys))
    const hitLineEnd = readAt(context, hitGroup, layout.endCarets)
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

  // Edits: replace [editStart, editEnd) with the pasted code points.
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

  // Cells: head keeps cells before editStart, the pasted code points land at editStart, and the tail
  // from editEnd moves by editEnd - editStart - insertCount.
  mark(context, 'key: pasted code points')
  const pasted: Wire[] = Array.from({length: config.pasteLimit}, (_, index) => {
    const accepted = atLeastZero(circuit, [[insertCount, 1]], -(index + 1))
    return maskValue(circuit, slot.codes + index, accepted)
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
  const caretKey = readAt(context, comparedPosition(context, state.caret, capacity + 1), layout.keys)
  const anchorKey = readAt(context, comparedPosition(context, state.anchor, capacity + 1), layout.keys)
  const selectionStartKey = integerMinimum(circuit, anchorKey, caretKey)
  const selectionEndKey = integerMaximum(circuit, anchorKey, caretKey)
  const caretLine = lineGroup(context, layout, state.caret)
  const caretLineKey = readAt(context, caretLine.position, layout.startKeys.slice(0, lines))
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
    const lineStartKeys = layout.startKeys.slice(0, lines)
    for (let cell = 0; cell < capacity; cell++) {
      const atLeast = Array.from({length: lines - 1}, (_, index) => atLeastZero(circuit, [[layout.starts[index + 1]!, -1]], cell))
      const line = atLeast.length === 0 ? context.zero : materialize(circuit, atLeast.map(bit => [bit, 1]), 0, 0, lines - 1)
      glyphLine.push(line)
      const lineKey = readAt(context, countPosition(line, atLeast), lineStartKeys)
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

function sourceRun(start: number, count: number): Wire[] {
  return Array.from({length: count}, (_, index) => start + index)
}

// Declares every table's source range and returns the tables' source wires.
function declareTables(circuit: Circuit, source: SourceLayout, config: EditorConfig): Tables {
  const classes = classTables()
  const tables: Tables = {
    classBlocks: sourceRun(source.classBlocks, blockCount),
    classPages: sourceRun(source.classPages, classes.pageCount * pageSize),
    spaceOrNewline: sourceRun(source.spaceOrNewline, classCount),
    newline: sourceRun(source.newline, classCount),
    word: sourceRun(source.word, classCount),
    pairs: sourceRun(source.pairs, classCount * classCount),
    emergencyPairs: sourceRun(source.emergencyPairs, classCount * classCount),
    advanceBlocks: sourceRun(source.advanceBlocks, blockCount),
    advancePages: sourceRun(source.advancePages, config.advancePageLimit * pageSize),
  }
  for (const wire of tables.classBlocks) circuit.assumeRange(wire, -(blockCount - 1) * pageSize, (classes.pageCount - 1) * pageSize)
  for (const wire of tables.classPages) circuit.assumeRange(wire, 0, classCount - 1)
  for (const wire of [...tables.spaceOrNewline, ...tables.newline, ...tables.word, ...tables.pairs, ...tables.emergencyPairs]) circuit.assumeRange(wire, 0, 1)
  for (const wire of tables.advanceBlocks) circuit.assumeRange(wire, -(blockCount - 1) * pageSize, (config.advancePageLimit - 1) * pageSize)
  for (const wire of tables.advancePages) circuit.assumeRange(wire, 0, advanceLimit - 1)
  return tables
}

export type DecodeBuild = {
  config: EditorConfig
  circuit: Circuit
  source: SourceLayout
  decoded: DecodedCells
  phases: Phase[]
}

// Only the per-cell reads, over cellCount code point cells and the same tables: for exhaustive checks
// of the tables and for the cost per cell.
export function buildDecodeCircuit(cellCount: number, advancePageLimit: number, blockIndex: EditorConfig['blockIndex'] = 'shift read'): DecodeBuild {
  const config: EditorConfig = {capacity: cellCount, lineSlots: 1, pasteLimit: 1, advancePageLimit, keysPerFrame: 0, maxWidthLimit: 2, glyphOutputs: false, scan: 'sklansky', blockIndex}
  const source = createSourceLayout(config)
  const circuit = new Circuit(source.size)
  for (let cell = 0; cell < cellCount; cell++) circuit.assumeRange(source.cells + cell, 0, codePointMaximum)
  const context: DecodeContext = {circuit, config, tables: declareTables(circuit, source, config), phases: [], scope: 'decode'}
  const decoded = decodeCells(context, sourceRun(source.cells, cellCount))
  return {config, circuit, source, decoded, phases: context.phases}
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
  for (let cell = 0; cell < config.capacity; cell++) circuit.assumeRange(source.cells + cell, 0, codePointMaximum)
  const tables = declareTables(circuit, source, config)
  for (const slot of source.slots) {
    // JS writes exactly one kind per slot; tests check the promise with validateOneHotGroups.
    circuit.assumeOneHot(keyKinds.map((_, index) => slot.kind + index))
    circuit.assumeRange(slot.shift, 0, 1)
    circuit.assumeRange(slot.count, 0, config.pasteLimit)
    for (let index = 0; index < config.pasteLimit; index++) circuit.assumeRange(slot.codes + index, 0, codePointMaximum)
    circuit.assumeRange(slot.pointerX, 0, limits.pointerXMaximum)
    circuit.assumeRange(slot.pointerY, 0, limits.pointerYMaximum)
  }
  const context: Context = {circuit, config, limits, source, tables, zero: constant(circuit, 0), phases: [], scope: 'sources'}
  let state: StateWires = {
    cells: sourceRun(source.cells, config.capacity),
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

// Every index read's index form must hold an exact integer, except the block reads of 'shift read',
// whose form is one integer cell times 2^-7: FP32 holds that product exactly, so floor lands on the
// block. Meant for tests; the evaluators don't check it.
export function validateCodePointReads(circuit: Circuit, values: Float32Array): number {
  let checked = 0
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    if (operation.kind !== 'index') continue
    let index = Math.fround(operation.gateBias)
    for (const [wire, coefficient] of operation.gateTerms) index = Math.fround(index + Math.fround(coefficient * values[wire]!))
    const shiftRead = operation.gateTerms.length === 1 && operation.gateBias === 0 && operation.gateTerms[0]![1] === 2 ** -pageBits
    const exact = shiftRead ? Number.isInteger(values[operation.gateTerms[0]![0]]!) : Number.isInteger(index)
    invariant(exact, `index read wire ${circuit.sourceSize + operationIndex} has index ${index}`)
    checked++
  }
  return checked
}

export type EditorFrame = {
  state: EditorState
  display: EditorDisplay & {overflowCount: number}
}

export function writeEvent(source: Float32Array, config: EditorConfig, layout: SourceLayout, slotIndex: number, input: EditorEvent) {
  const slot = layout.slots[slotIndex]!
  invariant(input.codes.length <= config.pasteLimit, 'too many code points for one event')
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

// The Unicode tables, written once per machine.
export function writeStaticTables(source: Float32Array, layout: SourceLayout) {
  const classes = classTables()
  const properties = propertyTables()
  source.set(classes.blockOffsets, layout.classBlocks)
  source.set(classes.pages, layout.classPages)
  source.set(properties.spaceOrNewline, layout.spaceOrNewline)
  source.set(properties.newline, layout.newline)
  source.set(properties.word, layout.word)
  source.set(properties.pairs, layout.pairs)
  source.set(properties.emergencyPairs, layout.emergencyPairs)
}

// Copies the advance table cells JS wrote since the last copy. Returns how many cells it wrote.
export function writeAdvanceTable(source: Float32Array, layout: SourceLayout, advances: AdvanceTable): number {
  let written = 0
  for (const block of advances.takeWrittenBlocks()) {
    source[layout.advanceBlocks + block] = advances.blockOffsets[block]!
    written++
  }
  for (const entry of advances.takeWrittenEntries()) {
    source[layout.advancePages + entry] = advances.pages[entry]!
    written++
  }
  return written
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
  advances: AdvanceTable
  setGeometry: (maxWidth: number, lineHeight: number) => void
  // Measures every code point in the state, then writes the state.
  load: (state: EditorState) => void
  // Measures new code points in the events, applies up to keysPerFrame events in one evaluation, and
  // writes the next state back into the table. A code point whose block finds no free advance page is
  // dropped from its event and counted.
  runFrame: (events: readonly EditorEvent[]) => EditorFrame & {droppedCodePoints: number}
  // A font change: re-measures every code point seen so far. Text cells and Unicode tables stay.
  setFont: (measure: MeasureCodePoint) => {rewrittenEntries: number, changedEntries: number, sourceCellsWritten: number}
}

export function createEditorMachine(config: EditorConfig, measure: MeasureCodePoint, build = buildEditorCircuit(config)): EditorMachine {
  const {circuit, source: layout, roots} = build
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(layout.size)
  const advances = createAdvanceTable(config.advancePageLimit, measure)
  source[layout.unit] = 1
  source[layout.maxWidth] = 1
  source[layout.lineHeight] = 1
  for (let slot = 0; slot < config.keysPerFrame; slot++) source[layout.slots[slot]!.kind] = 1
  writeStaticTables(source, layout)
  writeAdvanceTable(source, layout, advances)
  return {
    build,
    source,
    advances,
    setGeometry: (maxWidth, lineHeight) => {
      source[layout.maxWidth] = maxWidth
      source[layout.lineHeight] = lineHeight
    },
    load: state => {
      for (let cell = 0; cell < state.length; cell++) invariant(advances.ensure(state.cells[cell]!), 'no free advance page for a loaded code point')
      writeAdvanceTable(source, layout, advances)
      writeState(source, config, layout, state)
    },
    runFrame: events => {
      invariant(events.length <= config.keysPerFrame, 'more events than key slots')
      let droppedCodePoints = 0
      const accepted = events.map((input): EditorEvent => {
        if (input.codes.length === 0) return input
        const codes = input.codes.filter(codePoint => {
          if (advances.ensure(codePoint)) return true
          droppedCodePoints++
          return false
        })
        if (codes.length === input.codes.length) return input
        return codes.length === 0 ? {...input, kind: 'none', codes} : {...input, codes}
      })
      writeAdvanceTable(source, layout, advances)
      for (let slot = 0; slot < config.keysPerFrame; slot++) {
        writeEvent(source, config, layout, slot, accepted[slot] ?? {kind: 'none', shift: false, codes: [], pointerX: 0, pointerY: 0})
      }
      const frame = readFrame(config, evaluate(source))
      writeState(source, config, layout, frame.state)
      return {...frame, droppedCodePoints}
    },
    setFont: nextMeasure => {
      const counts = advances.remeasure(nextMeasure)
      return {...counts, sourceCellsWritten: writeAdvanceTable(source, layout, advances)}
    },
  }
}

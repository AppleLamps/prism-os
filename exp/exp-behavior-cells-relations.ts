// Spec: Dynamic Behavior Cells -- the 8-slot slot-world keystone.
// Encoding angle: RELATIONS-CENTRIC (ideas.md 'Relations').
//
// The keystone claim: changing *behavior* (layout mode, gap, visibility,
// reveal relations) lives in the SAME flat Float32Array source table as state
// and flows through the SAME compiled circuit. The circuit is a fixed function
// f(source) -> outputs; "behavior" is just a region of source that downstream
// affine/reglu/boolean atoms read as coefficients-by-data. Editing a behavior
// cell needs ZERO recompilation.
//
// Why relations-centric:
//   The genuine n x n relation here is reveal[i][j] -- "selecting slot i reveals
//   slot j". The spec's effective-visibility law reads that table directly:
//     effVisible[j] = boolean(clamp01(visible[j] + sum_i selected[i]*reveal[i][j]))
//   Layout modes are *also* relation patterns rather than an opaque scalar: a
//   ROW is a single left-to-right follow-chain over the visible slots, a COLUMN
//   is the same chain rotated onto the vertical axis, and a GRID is two
//   interleaved chains (4-wide row-major). We therefore store the mode as three
//   explicit one-hot follow-axis bits (rowBit, columnBit, gridBit) -- a tiny
//   relation header -- and derive geometry as a per-mode blend selected by those
//   bits. Genuinely scalar facts (gap, slot padding) where a relation makes no
//   sense stay as scalar cells, exactly as the prompt allows.
//
// Storing the mode as explicit bits (rather than a single 0/1/2 scalar) is the
// "Builder B" choice: it makes the manifold probe (Section 6) informative --
// lerping rowBit 1->0 while columnBit 0->1 passes through (0.5,0.5), where
// boolean() rounds BOTH to 1 in a band around t=0.5, so V5 (one-hot mode) and
// V4 (no overlap) both drop to 0. That hole is the headline lattice finding.
//
// No division anywhere. Equal-track sizing in ROW/COLUMN uses precomputed FP32
// reciprocals of the fixed track counts 1..8, selected by the visible-count via
// integer-equality bits (the compaction prefix trick). GRID uses constant
// reciprocals of 4 and 2. selection and track-count routing use emitArgmax /
// integer-equality, never a runtime 1/n atom.

import {
  Circuit,
  type Wire,
  emitArgmax,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
  validateTensorEvaluation,
  validateTensorProgram,
  validateWireView,
} from '../numeric-ui-core.ts'

export const slotCount = 8
export const gridColumns = 4
export const gridRows = 2

// ---------------------------------------------------------------------------
// Source-table field maps (offsets are this builder's choice; only the semantic
// field list is contractual). A cold agent edits the live machine using ONLY
// these names, so they are self-explanatory.
// ---------------------------------------------------------------------------

// 2A. Constants -- not behavior, not state.
export const constantField = {
  viewportWidth: 0,
  viewportHeight: 1,
  unit: 2, // the literal 1, used by clamp/argmax macros
  slotPad: 3, // structural margin subtracted from each side of the viewport
  size: 4,
} as const

// 2B. Behavior cells -- the dynamic-behavior region (the thing under test).
// Mode header (relations-centric one-hot follow-axis bits), then gap, then the
// 8 base visibility bits, then the 8x8 reveal relation table (row-major:
// revealStart + i*slotCount + j is "selecting i reveals j").
const behaviorStart = constantField.size
export const behaviorField = {
  rowBit: behaviorStart + 0, // ROW: single horizontal follow-chain
  columnBit: behaviorStart + 1, // COLUMN: single vertical follow-chain
  gridBit: behaviorStart + 2, // GRID: two interleaved chains (4-wide)
  gap: behaviorStart + 3, // pixels between adjacent visible slots
  visibleStart: behaviorStart + 4, // visible[0..7]
  revealStart: behaviorStart + 4 + slotCount, // reveal[i][j], 64 cells
  size: behaviorStart + 4 + slotCount + slotCount * slotCount,
} as const

// 2C. State cells -- changing state, not behavior.
const stateStart = behaviorField.size
export const stateField = {
  clickActive: stateStart + 0,
  clickX: stateStart + 1,
  clickY: stateStart + 2,
  size: stateStart + 3,
} as const

// The full source table.
export const sourceField = {
  ...constantField,
  rowBit: behaviorField.rowBit,
  columnBit: behaviorField.columnBit,
  gridBit: behaviorField.gridBit,
  gap: behaviorField.gap,
  visibleStart: behaviorField.visibleStart,
  revealStart: behaviorField.revealStart,
  clickActive: stateField.clickActive,
  clickX: stateField.clickX,
  clickY: stateField.clickY,
  size: stateField.size,
} as const

// Helpers to address the per-slot / relation regions.
export function visibleSourceField(slot: number): number {
  invariant(slot >= 0 && slot < slotCount, 'visibility slot index is out of range')
  return behaviorField.visibleStart + slot
}

export function revealSourceField(from: number, to: number): number {
  invariant(from >= 0 && from < slotCount, 'reveal source slot index is out of range')
  invariant(to >= 0 && to < slotCount, 'reveal target slot index is out of range')
  return behaviorField.revealStart + from * slotCount + to
}

// Layout-mode codes, exposed so callers and the reference agree on names.
export const layoutMode = {row: 0, column: 1, grid: 2} as const
export type LayoutModeName = keyof typeof layoutMode

// ---------------------------------------------------------------------------
// Output wire field maps (contract). Geometry is continuous FP32; validity is
// exact bits. A flat Wire[] view is validated with validateWireView.
// ---------------------------------------------------------------------------

export const slotOutputField = {x: 0, y: 1, w: 2, h: 3, size: 4} as const

export const validityField = {
  sizesNonnegative: 0, // V1
  withinViewport: 1, // V2
  atMostOneSelected: 2, // V3
  noVisibleOverlap: 3, // V4
  oneLayoutMode: 4, // V5 (structural)
  selectionImpliesVisible: 5, // V6 (structural)
  allValid: 6, // aggregate
  size: 7,
} as const

export type BehaviorOutput = {
  // Per-slot geometry, flattened slot-major: slot j fields at j*slotOutputField.size.
  slotRects: Wire[]
  selected: Wire[] // one-hot selection bit per slot
  effVisible: Wire[] // effective visibility bit per slot (after reveal)
  validity: Wire[] // V1..V6 + allValid, indexed by validityField
}

// Bounds shared by construction and the assumeRange contract.
const viewportFloor = 1
const viewportCeiling = 4096
const gapCeiling = 512
const slotPadCeiling = 256

// ---------------------------------------------------------------------------
// Local macros re-derived from the allowed primitives.
// ---------------------------------------------------------------------------

// clamp01(v) = relu(v) - relu(v-1), then pin to [0,1].
function emitClamp01(circuit: Circuit, value: Wire): Wire {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

// abs(x) = relu(x) + relu(-x).
function emitAbsolute(circuit: Circuit, value: Wire): Wire {
  const positive = emitRelu(circuit, value)
  const negative = emitRelu(circuit, circuit.affine([[value, -1]]))
  const result = circuit.affine([[positive, 1], [negative, 1]])
  const range = circuit.ranges[value]!
  const maximum = Math.max(Math.abs(range.minimum), Math.abs(range.maximum))
  circuit.assumeRange(result, 0, maximum)
  return result
}

// AND of two exact bits via multiply; the product of two [0,1] bits is a bit.
function emitAnd(circuit: Circuit, a: Wire, b: Wire): Wire {
  const result = emitMultiply(circuit, a, b)
  circuit.assumeRange(result, 0, 1)
  return result
}

// Integer equality bit: 1 iff count == target, for integer-valued count in
// [0, hi]. boolean(clamp01(1 - abs(count - target))); abs is 0 at equality and
// >= 1 otherwise, so the clamped score is exactly 1 only when equal.
function emitIntEqualsConstant(circuit: Circuit, count: Wire, target: number): Wire {
  const difference = circuit.affine([[count, 1]], -target)
  const distance = emitAbsolute(circuit, difference)
  const score = emitClamp01(circuit, circuit.affine([[constantField.unit, 1], [distance, -1]]))
  return circuit.boolean(score)
}

// ---------------------------------------------------------------------------
// Behavioral-dimension gating. The growth protocol (Section 5) builds variants
// that enable D0..Dk. Each dimension is a boolean flag the builder reads to
// decide whether to wire that knob live or bake a constant.
// ---------------------------------------------------------------------------

export type BehaviorDimensions = {
  gap: boolean // D1: gap as a live cell
  visibility: boolean // D2: per-slot visibility bits + size gating
  layoutMode: boolean // D3: 3-way mode blend + V5
  selection: boolean // D4: click -> selection one-hot
  reveal: boolean // D5: reveal-relation table + effective visibility
  validity: boolean // D6: full validity output set
}

export const baselineDimensions: BehaviorDimensions = {
  gap: false,
  visibility: false,
  layoutMode: false,
  selection: false,
  reveal: false,
  validity: false,
}

export const fullDimensions: BehaviorDimensions = {
  gap: true,
  visibility: true,
  layoutMode: true,
  selection: true,
  reveal: true,
  validity: true,
}

// The ordered dimension list used by the growth protocol (D0..D6).
export const growthDimensionOrder = [
  'baseline',
  'gap',
  'visibility',
  'layoutMode',
  'selection',
  'reveal',
  'validity',
] as const

export function dimensionsThrough(level: number): BehaviorDimensions {
  return {
    gap: level >= 1,
    visibility: level >= 2,
    layoutMode: level >= 3,
    selection: level >= 4,
    reveal: level >= 5,
    validity: level >= 6,
  }
}

// ---------------------------------------------------------------------------
// The circuit builder. One fixed shape per dimension set; geometry for all
// three modes is computed unconditionally and blended, so the circuit never
// branches on the mode value.
// ---------------------------------------------------------------------------

export type BehaviorCircuit = {
  circuit: Circuit
  output: BehaviorOutput
  roots: Wire[]
  dimensions: BehaviorDimensions
}

export function createBehaviorCircuit(
  dimensions: BehaviorDimensions = fullDimensions,
): BehaviorCircuit {
  const circuit = new Circuit(sourceField.size)

  // Constants.
  circuit.assumeRange(constantField.viewportWidth, viewportFloor, viewportCeiling)
  circuit.assumeRange(constantField.viewportHeight, viewportFloor, viewportCeiling)
  circuit.assumeRange(constantField.unit, 1, 1)
  circuit.assumeRange(constantField.slotPad, 0, slotPadCeiling)

  // Behavior cells -- ranges so every downstream boolean/clamp input is provably
  // in [0,1].
  circuit.assumeRange(behaviorField.rowBit, 0, 1)
  circuit.assumeRange(behaviorField.columnBit, 0, 1)
  circuit.assumeRange(behaviorField.gridBit, 0, 1)
  circuit.assumeRange(behaviorField.gap, 0, gapCeiling)
  for (let slot = 0; slot < slotCount; slot++) {
    circuit.assumeRange(visibleSourceField(slot), 0, 1)
  }
  for (let from = 0; from < slotCount; from++) {
    for (let to = 0; to < slotCount; to++) {
      circuit.assumeRange(revealSourceField(from, to), 0, 1)
    }
  }

  // State cells.
  circuit.assumeRange(stateField.clickActive, 0, 1)
  circuit.assumeRange(stateField.clickX, 0, viewportCeiling)
  circuit.assumeRange(stateField.clickY, 0, viewportCeiling)

  const unit = constantField.unit
  const W = constantField.viewportWidth
  const H = constantField.viewportHeight

  // Usable area: viewport minus slotPad on each side.
  const usableX = circuit.affine([[constantField.slotPad, 1]])
  const usableY = circuit.affine([[constantField.slotPad, 1]])
  const usableW = circuit.affine([[W, 1], [constantField.slotPad, -2]])
  const usableH = circuit.affine([[H, 1], [constantField.slotPad, -2]])
  // usableW/usableH could go negative for a pathological slotPad > W/2; relu so
  // sizes stay nonnegative by construction (V1 then proves it).
  const usableWClamped = emitRelu(circuit, usableW)
  const usableHClamped = emitRelu(circuit, usableH)

  // Gap: live cell when D1 enabled, otherwise baked to the baseline 8px.
  const gap = dimensions.gap ? behaviorField.gap : circuit.affine([[unit, baselineGap]])

  // ----- Mode one-hot (m_row, m_column, m_grid) -----
  // When D3 enabled, read the three explicit bits (relations-centric header) and
  // harden each with boolean. When disabled, bake the baseline GRID mode.
  let mRow: Wire
  let mColumn: Wire
  let mGrid: Wire
  if (dimensions.layoutMode) {
    mRow = circuit.boolean(behaviorField.rowBit)
    mColumn = circuit.boolean(behaviorField.columnBit)
    mGrid = circuit.boolean(behaviorField.gridBit)
  } else {
    mRow = circuit.affine([], 0)
    mColumn = circuit.affine([], 0)
    mGrid = circuit.affine([[unit, 1]])
    circuit.assumeRange(mRow, 0, 1)
    circuit.assumeRange(mColumn, 0, 1)
    circuit.assumeRange(mGrid, 0, 1)
  }

  // ----- Base visibility bits -----
  const baseVisible: Wire[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    if (dimensions.visibility) {
      baseVisible.push(circuit.boolean(visibleSourceField(slot)))
    } else {
      const allVisible = circuit.affine([[unit, 1]])
      circuit.assumeRange(allVisible, 0, 1)
      baseVisible.push(allVisible)
    }
  }

  // ----- Selection one-hot from the click latch against PRE-REVEAL rects -----
  // Built from base visibility only, breaking the reveal cycle. When D4 is
  // disabled selection is all-zero (no interaction).
  let selected: Wire[]
  if (dimensions.selection) {
    const preRevealRects = computeSlotRects(
      circuit,
      unit,
      usableX,
      usableY,
      usableWClamped,
      usableHClamped,
      gap,
      baseVisible,
      mRow,
      mColumn,
      mGrid,
    )
    selected = computeSelection(circuit, unit, preRevealRects)
  } else {
    selected = makeZeroBits(circuit)
  }

  // ----- Effective visibility after reveal -----
  // effVisible[j] = boolean(clamp01(baseVisible[j] + sum_i selected[i]*reveal[i][j]))
  // With at-most-one selected (V3), the inner sum has at most one nonzero term,
  // so the pre-clamp value stays in [0,1]; clamp01 is defensive.
  const effVisible: Wire[] = []
  for (let to = 0; to < slotCount; to++) {
    if (!dimensions.reveal) {
      effVisible.push(baseVisible[to]!)
      continue
    }
    const revealTerms: [Wire, number][] = [[baseVisible[to]!, 1]]
    for (let from = 0; from < slotCount; from++) {
      const revealCell = circuit.boolean(revealSourceField(from, to))
      const contribution = emitAnd(circuit, selected[from]!, revealCell)
      revealTerms.push([contribution, 1])
    }
    const score = emitClamp01(circuit, circuit.affine(revealTerms))
    effVisible.push(circuit.boolean(score))
  }

  // ----- Final geometry from effective visibility, blended across modes -----
  const finalRects = computeSlotRects(
    circuit,
    unit,
    usableX,
    usableY,
    usableWClamped,
    usableHClamped,
    gap,
    effVisible,
    mRow,
    mColumn,
    mGrid,
  )

  // Gate each rect's size by its effective visibility: hidden slot -> w=h=0.
  const slotRects: Wire[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const base = slot * 4
    const x = finalRects[base + 0]!
    const y = finalRects[base + 1]!
    const w = emitMultiply(circuit, effVisible[slot]!, finalRects[base + 2]!)
    const h = emitMultiply(circuit, effVisible[slot]!, finalRects[base + 3]!)
    slotRects.push(x, y, w, h)
  }

  // ----- Validity outputs -----
  const validity = dimensions.validity
    ? computeValidity(circuit, unit, W, H, slotRects, selected, effVisible, mRow, mColumn, mGrid)
    : makeTrivialValidity(circuit, unit)

  const output: BehaviorOutput = {slotRects, selected, effVisible, validity}

  // Roots: only the outputs reachable / meaningful at this dimension level, so
  // dead-wire elimination in compileTensorProgram is honest for the growth
  // measurement.
  const roots: Wire[] = [...slotRects]
  if (dimensions.selection || dimensions.reveal) roots.push(...selected, ...effVisible)
  else roots.push(...effVisible)
  if (dimensions.validity) roots.push(...validity)

  return {circuit, output, roots, dimensions}
}

const baselineGap = 8

function makeZeroBits(circuit: Circuit): Wire[] {
  const zeros: Wire[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const zero = circuit.affine([], 0)
    circuit.assumeRange(zero, 0, 1)
    zeros.push(zero)
  }
  return zeros
}

// ---------------------------------------------------------------------------
// Per-mode geometry, computed unconditionally and blended by the mode bits. The
// blend reads mode bits as coefficients, so the circuit shape is identical
// regardless of which mode is active.
// ---------------------------------------------------------------------------

function computeSlotRects(
  circuit: Circuit,
  unit: Wire,
  usableX: Wire,
  usableY: Wire,
  usableW: Wire,
  usableH: Wire,
  gap: Wire,
  visible: readonly Wire[],
  mRow: Wire,
  mColumn: Wire,
  mGrid: Wire,
): Wire[] {
  // Track count = number of visible slots, integer in [0,8].
  const trackCountTerms: [Wire, number][] = visible.map(bit => [bit, 1] as [Wire, number])
  const trackCount = circuit.affine(trackCountTerms)
  circuit.assumeRange(trackCount, 0, slotCount)

  // Dynamic reciprocal of the track count, selected with no division. recip(0)
  // is irrelevant (no slot visible) so we map it to 0.
  const recipTrack = selectReciprocal(circuit, trackCount)

  // prefix[i] = number of visible slots with index < i; the visible slot's
  // track index along the single-track axis.
  const prefix: Wire[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const terms: [Wire, number][] = []
    for (let earlier = 0; earlier < slot; earlier++) terms.push([visible[earlier]!, 1])
    const wire = circuit.affine(terms)
    circuit.assumeRange(wire, 0, slot)
    prefix.push(wire)
  }

  // ROW: single horizontal track. slotWidth = relu(usableW - (n-1)*gap) * recip(n)
  // gapTotal = (n-1)*gap. innerW available for slots = usableW - gapTotal.
  const rowGapTotal = circuit.affine([[trackCount, 1], [unit, -1]])
  const rowInnerW = emitRelu(circuit, circuit.affine([
    [usableW, 1],
    [emitMultiply(circuit, emitRelu(circuit, rowGapTotal), gap), -1],
  ]))
  const rowSlotW = emitMultiply(circuit, rowInnerW, recipTrack)

  // COLUMN: single vertical track.
  const colInnerH = emitRelu(circuit, circuit.affine([
    [usableH, 1],
    [emitMultiply(circuit, emitRelu(circuit, rowGapTotal), gap), -1],
  ]))
  const colSlotH = emitMultiply(circuit, colInnerH, recipTrack)

  // GRID: fixed 4-wide x 2-tall, constant reciprocals (no dynamic division).
  const gridCellW = circuit.affine([
    [emitRelu(circuit, circuit.affine([[usableW, 1], [gap, -(gridColumns - 1)]])), 1 / gridColumns],
  ])
  const gridCellH = circuit.affine([
    [emitRelu(circuit, circuit.affine([[usableH, 1], [gap, -(gridRows - 1)]])), 1 / gridRows],
  ])

  const rects: Wire[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const track = prefix[slot]!

    // ROW rect for this slot. x = usableX + track*(slotW + gap).
    const rowStride = circuit.affine([[rowSlotW, 1], [gap, 1]])
    const rowX = circuit.affine([[usableX, 1], [emitMultiply(circuit, track, rowStride), 1]])
    const rowY = usableY
    const rowW = rowSlotW
    const rowH = usableH

    // COLUMN rect. y = usableY + track*(slotH + gap).
    const colStride = circuit.affine([[colSlotH, 1], [gap, 1]])
    const colX = usableX
    const colY = circuit.affine([[usableY, 1], [emitMultiply(circuit, track, colStride), 1]])
    const colW = usableW
    const colH = colSlotH

    // GRID rect. column = slot % gridColumns, row = slot // gridColumns (const).
    const column = slot % gridColumns
    const row = Math.floor(slot / gridColumns)
    const gridX = circuit.affine([
      [usableX, 1],
      [gridCellW, column],
      [gap, column],
    ])
    const gridY = circuit.affine([
      [usableY, 1],
      [gridCellH, row],
      [gap, row],
    ])
    const gridW = gridCellW
    const gridH = gridCellH

    // Blend: rect = m_row*row + m_column*column + m_grid*grid via nested select.
    rects.push(
      blendMode(circuit, mRow, mColumn, mGrid, rowX, colX, gridX),
      blendMode(circuit, mRow, mColumn, mGrid, rowY, colY, gridY),
      blendMode(circuit, mRow, mColumn, mGrid, rowW, colW, gridW),
      blendMode(circuit, mRow, mColumn, mGrid, rowH, colH, gridH),
    )
  }
  return rects
}

// Blend three per-mode values by the one-hot mode bits, exactly the spec's
// formula: value = m_row*rowValue + m_column*columnValue + m_grid*gridValue.
// With a valid one-hot this is exactly the active mode's value. In the
// manifold-probe band where two bits are 1, this is their SUM -- which produces
// out-of-place, overlapping rects that V4 (and V5) flag, the lattice hole.
function blendMode(
  circuit: Circuit,
  mRow: Wire,
  mColumn: Wire,
  mGrid: Wire,
  rowValue: Wire,
  columnValue: Wire,
  gridValue: Wire,
): Wire {
  return circuit.affine([
    [emitMultiply(circuit, mRow, rowValue), 1],
    [emitMultiply(circuit, mColumn, columnValue), 1],
    [emitMultiply(circuit, mGrid, gridValue), 1],
  ])
}

// Select 1/n for the integer track count n in [0,8] with no division: build an
// integer-equality bit per candidate count and dot it with precomputed FP32
// reciprocals. recip(0) maps to 0 (no visible slot -> width unused).
function selectReciprocal(circuit: Circuit, trackCount: Wire): Wire {
  const reciprocals = [0, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8]
  const terms: [Wire, number][] = []
  for (let count = 1; count <= slotCount; count++) {
    const isCount = emitIntEqualsConstant(circuit, trackCount, count)
    terms.push([isCount, reciprocals[count]!])
  }
  const result = circuit.affine(terms)
  circuit.assumeRange(result, 0, 1)
  return result
}

// ---------------------------------------------------------------------------
// Selection: one-hot from (clickActive, clickX, clickY) against PRE-REVEAL rects.
// ---------------------------------------------------------------------------

function computeSelection(
  circuit: Circuit,
  unit: Wire,
  rects: readonly Wire[],
): Wire[] {
  // inside_j = 1 iff click is in [x, x+w] x [y, y+h]. Each edge test is a bit.
  const hitScores: Wire[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const base = slot * 4
    const x = rects[base + 0]!
    const y = rects[base + 1]!
    const w = rects[base + 2]!
    const h = rects[base + 3]!
    // ax = clickX - x >= 0 ; bx = (x+w) - clickX >= 0 ; same for y.
    const afterLeft = pointGEBit(circuit, circuit.affine([[stateField.clickX, 1], [x, -1]]))
    const beforeRight = pointGEBit(
      circuit,
      circuit.affine([[x, 1], [w, 1], [stateField.clickX, -1]]),
    )
    const afterTop = pointGEBit(circuit, circuit.affine([[stateField.clickY, 1], [y, -1]]))
    const beforeBottom = pointGEBit(
      circuit,
      circuit.affine([[y, 1], [h, 1], [stateField.clickY, -1]]),
    )
    const insideX = emitAnd(circuit, afterLeft, beforeRight)
    const insideY = emitAnd(circuit, afterTop, beforeBottom)
    const inside = emitAnd(circuit, insideX, insideY)
    const score = emitAnd(circuit, circuit.boolean(circuit.affine([[stateField.clickActive, 1]])), inside)
    hitScores.push(score)
  }
  // emitArgmax over the hit scores gives an exact one-hot (top index wins ties),
  // guaranteeing at most one selected slot. Gate by clickActive so no click ->
  // no selection.
  const {selected} = emitArgmax(circuit, hitScores, unit)
  const gated: Wire[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const bit = emitAnd(circuit, selected[slot]!, hitScores[slot]!)
    gated.push(bit)
  }
  return gated
}

// Bit that is 1 iff value >= 0, for a value whose magnitude fits the viewport.
// boolean(clamp01(value*BIG + 0.5)) rounds any strictly-positive value to 1 and
// any negative to 0; but to stay range-safe we instead use the sign via relu:
// a value >= 0 has relu(value) == value and relu(-value) == 0, so
// 1 - boolean(clamp01(relu(-value))) is 1 exactly when value >= 0... we want a
// clean integer-free test. Use: ge = boolean(clamp01(1 - relu(-value)*BIG)) is
// fragile; instead clamp the indicator: any value < 0 yields relu(-value) > 0,
// and clamp01 of a large multiple saturates to 1. We pick a scale that turns the
// smallest representable negative gap into >= 1.
function pointGEBit(circuit: Circuit, value: Wire): Wire {
  // negPart > 0 exactly when value < 0. Scale so any negative saturates clamp01.
  const negPart = emitRelu(circuit, circuit.affine([[value, -1]]))
  const saturated = emitClamp01(circuit, circuit.affine([[negPart, hitTestScale]]))
  // ge bit = 1 - (value<0 indicator).
  const ge = circuit.affine([[constantField.unit, 1], [circuit.boolean(saturated), -1]])
  circuit.assumeRange(ge, 0, 1)
  return circuit.boolean(ge)
}

// Scale that turns a strictly-positive gap into a clamp01 saturation of 1,
// while keeping the scaled product well under the FP32 region where v-1 == v
// (ULP reaches 1 only near 8.4e6). With coordinate magnitudes <= ~8192 px, a
// scale of 64 keeps products <= ~5e5 (ULP ~0.06, so v-1 stays distinct and
// clamp01 returns an exact 1), and resolves any gap down to ~0.016 px.
const hitTestScale = 64

// ---------------------------------------------------------------------------
// Validity outputs (V1..V6 + allValid).
// ---------------------------------------------------------------------------

function computeValidity(
  circuit: Circuit,
  unit: Wire,
  W: Wire,
  H: Wire,
  slotRects: readonly Wire[],
  selected: readonly Wire[],
  effVisible: readonly Wire[],
  mRow: Wire,
  mColumn: Wire,
  mGrid: Wire,
): Wire[] {
  // V1 sizesNonnegative: every slot has w>=0 and h>=0. violation = relu(-w)+relu(-h).
  let v1Violation = circuit.affine([], 0)
  for (let slot = 0; slot < slotCount; slot++) {
    const base = slot * 4
    const w = slotRects[base + 2]!
    const h = slotRects[base + 3]!
    const negW = emitRelu(circuit, circuit.affine([[w, -1]]))
    const negH = emitRelu(circuit, circuit.affine([[h, -1]]))
    v1Violation = circuit.affine([[v1Violation, 1], [negW, 1], [negH, 1]])
  }
  const v1 = violationToBit(circuit, v1Violation)

  // V2 withinViewport: visible slots satisfy x>=0,y>=0,x+w<=W,y+h<=H.
  let v2Violation = circuit.affine([], 0)
  for (let slot = 0; slot < slotCount; slot++) {
    const base = slot * 4
    const x = slotRects[base + 0]!
    const y = slotRects[base + 1]!
    const w = slotRects[base + 2]!
    const h = slotRects[base + 3]!
    const leftViol = emitRelu(circuit, circuit.affine([[x, -1]]))
    const topViol = emitRelu(circuit, circuit.affine([[y, -1]]))
    const rightViol = emitRelu(circuit, circuit.affine([[x, 1], [w, 1], [W, -1]]))
    const bottomViol = emitRelu(circuit, circuit.affine([[y, 1], [h, 1], [H, -1]]))
    const rawViol = circuit.affine([[leftViol, 1], [topViol, 1], [rightViol, 1], [bottomViol, 1]])
    const gated = emitMultiply(circuit, effVisible[slot]!, rawViol)
    v2Violation = circuit.affine([[v2Violation, 1], [gated, 1]])
  }
  const v2 = violationToBit(circuit, v2Violation)

  // V3 atMostOneSelected: sum_j selected <= 1. boolean(clamp01(1 - relu(sum-1))).
  const selectionSum = circuit.affine(selected.map(bit => [bit, 1] as [Wire, number]))
  const overOne = emitRelu(circuit, circuit.affine([[selectionSum, 1], [unit, -1]]))
  const v3 = circuit.boolean(emitClamp01(circuit, circuit.affine([[unit, 1], [overOne, -1]])))

  // V4 noVisibleOverlap: for every pair a<b both visible, rects are separated.
  // Separated iff relu(gx)+relu(gy) > 0 where gx = max(x_a-(x_b+w_b), x_b-(x_a+w_a)),
  // gy similarly. overlapPair = effVisible_a*effVisible_b*boolean(both gaps <= 0).
  let overlapSum = circuit.affine([], 0)
  for (let a = 0; a < slotCount; a++) {
    for (let b = a + 1; b < slotCount; b++) {
      const baseA = a * 4
      const baseB = b * 4
      const xa = slotRects[baseA + 0]!
      const ya = slotRects[baseA + 1]!
      const wa = slotRects[baseA + 2]!
      const ha = slotRects[baseA + 3]!
      const xb = slotRects[baseB + 0]!
      const yb = slotRects[baseB + 1]!
      const wb = slotRects[baseB + 2]!
      const hb = slotRects[baseB + 3]!
      // gx = max(x_a-(x_b+w_b), x_b-(x_a+w_a)); separated horizontally iff gx>=0.
      const gxLeft = circuit.affine([[xa, 1], [xb, -1], [wb, -1]])
      const gxRight = circuit.affine([[xb, 1], [xa, -1], [wa, -1]])
      const gyTop = circuit.affine([[ya, 1], [yb, -1], [hb, -1]])
      const gyBottom = circuit.affine([[yb, 1], [ya, -1], [ha, -1]])
      // separationMargin = relu(gxLeft)+relu(gxRight)+relu(gyTop)+relu(gyBottom).
      // Touching edges (margin 0) count as separated, so overlap requires
      // margin strictly < epsilon on every axis. boolean of clamp01(1 - margin*BIG)
      // is 1 only when margin == 0 (true overlap), else 0.
      const margin = circuit.affine([
        [emitRelu(circuit, gxLeft), 1],
        [emitRelu(circuit, gxRight), 1],
        [emitRelu(circuit, gyTop), 1],
        [emitRelu(circuit, gyBottom), 1],
      ])
      const overlapping = circuit.boolean(
        emitClamp01(circuit, circuit.affine([[unit, 1], [margin, -hitTestScale]])),
      )
      const bothVisible = emitAnd(circuit, effVisible[a]!, effVisible[b]!)
      const overlapPair = emitAnd(circuit, bothVisible, overlapping)
      overlapSum = circuit.affine([[overlapSum, 1], [overlapPair, 1]])
    }
  }
  const overOverlap = emitRelu(circuit, circuit.affine([[overlapSum, 1]]))
  const v4 = circuit.boolean(emitClamp01(circuit, circuit.affine([[unit, 1], [overOverlap, -1]])))

  // V5 oneLayoutMode: exactly one of (m_row,m_column,m_grid). modeSum is an
  // integer in [0,3]; valid iff == 1. boolean(clamp01(1 - abs(modeSum-1))).
  const modeSum = circuit.affine([[mRow, 1], [mColumn, 1], [mGrid, 1]])
  circuit.assumeRange(modeSum, 0, 3)
  const v5 = emitIntEqualsConstant(circuit, modeSum, 1)

  // V6 selectionImpliesVisible: AND_i (1 - selected_i*(1 - effVisible_i)).
  let v6 = circuit.affine([[unit, 1]])
  circuit.assumeRange(v6, 0, 1)
  for (let slot = 0; slot < slotCount; slot++) {
    const notVisible = circuit.affine([[unit, 1], [effVisible[slot]!, -1]])
    circuit.assumeRange(notVisible, 0, 1)
    const conflict = emitAnd(circuit, selected[slot]!, notVisible)
    const ok = circuit.affine([[unit, 1], [conflict, -1]])
    circuit.assumeRange(ok, 0, 1)
    v6 = emitAnd(circuit, v6, circuit.boolean(ok))
  }

  // Aggregate: allValid = boolean(V1*V2*V3*V4*V5*V6).
  let product = v1
  for (const bit of [v2, v3, v4, v5, v6]) product = emitAnd(circuit, product, bit)
  const allValid = circuit.boolean(product)

  const validity = Array<Wire>(validityField.size)
  validity[validityField.sizesNonnegative] = v1
  validity[validityField.withinViewport] = v2
  validity[validityField.atMostOneSelected] = v3
  validity[validityField.noVisibleOverlap] = v4
  validity[validityField.oneLayoutMode] = v5
  validity[validityField.selectionImpliesVisible] = v6
  validity[validityField.allValid] = allValid
  return validity
}

// violation -> bit: 1 iff violation == 0. boolean(clamp01(1 - violation*BIG)).
function violationToBit(circuit: Circuit, violation: Wire): Wire {
  const clamped = emitClamp01(circuit, circuit.affine([[constantField.unit, 1], [violation, -hitTestScale]]))
  return circuit.boolean(clamped)
}

// Baseline-only validity (D<6): emit constant-1 bits so the wire view is always
// complete and validateWireView passes at every level.
function makeTrivialValidity(circuit: Circuit, unit: Wire): Wire[] {
  const validity = Array<Wire>(validityField.size)
  for (let field = 0; field < validityField.size; field++) {
    const one = circuit.boolean(circuit.affine([[unit, 1]]))
    validity[field] = one
  }
  return validity
}

// ---------------------------------------------------------------------------
// Machine factory with a step() wrapper (mirrors createWindowManagerMachine).
// The circuit compiles ONCE; editing source cells never recompiles.
// ---------------------------------------------------------------------------

export type BehaviorMachine = ReturnType<typeof createBehaviorMachine>

export function createBehaviorMachine(dimensions: BehaviorDimensions = fullDimensions) {
  const {circuit, output, roots} = createBehaviorCircuit(dimensions)
  const wireCount = validateCircuit(circuit)
  validateWireView(output.slotRects, slotCount * slotOutputField.size, wireCount)
  validateWireView(output.selected, slotCount, wireCount)
  validateWireView(output.effVisible, slotCount, wireCount)
  validateWireView(output.validity, validityField.size, wireCount)

  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, tensorProgram)

  const source = new Float32Array(sourceField.size)
  // Baseline source: GRID, gap=8, all visible, reveal all zero, no click.
  source[constantField.unit] = 1
  source[constantField.viewportWidth] = 1280
  source[constantField.viewportHeight] = 800
  source[constantField.slotPad] = 16
  source[behaviorField.rowBit] = 0
  source[behaviorField.columnBit] = 0
  source[behaviorField.gridBit] = 1
  source[behaviorField.gap] = baselineGap
  for (let slot = 0; slot < slotCount; slot++) source[visibleSourceField(slot)] = 1

  return {
    circuit,
    output,
    source,
    tensorProgram,
    dimensions,
    // Evaluate the live source through the fixed circuit. No recompilation.
    step(): Float32Array {
      return circuit.evaluateTensor(source)
    },
    // Behavior-cell editors (names a cold agent uses).
    setLayoutMode(name: LayoutModeName) {
      source[behaviorField.rowBit] = name === 'row' ? 1 : 0
      source[behaviorField.columnBit] = name === 'column' ? 1 : 0
      source[behaviorField.gridBit] = name === 'grid' ? 1 : 0
    },
    setModeBits(rowBit: number, columnBit: number, gridBit: number) {
      source[behaviorField.rowBit] = rowBit
      source[behaviorField.columnBit] = columnBit
      source[behaviorField.gridBit] = gridBit
    },
    setGap(value: number) {
      source[behaviorField.gap] = value
    },
    setVisible(slot: number, value: number) {
      source[visibleSourceField(slot)] = value
    },
    setReveal(from: number, to: number, value: number) {
      source[revealSourceField(from, to)] = value
    },
    setClick(active: number, x: number, y: number) {
      source[stateField.clickActive] = active
      source[stateField.clickX] = x
      source[stateField.clickY] = y
    },
    clearClick() {
      source[stateField.clickActive] = 0
      source[stateField.clickX] = 0
      source[stateField.clickY] = 0
    },
    readSlotRect(values: Float32Array, slot: number) {
      const base = slot * slotOutputField.size
      return {
        x: values[output.slotRects[base + slotOutputField.x]!]!,
        y: values[output.slotRects[base + slotOutputField.y]!]!,
        w: values[output.slotRects[base + slotOutputField.w]!]!,
        h: values[output.slotRects[base + slotOutputField.h]!]!,
      }
    },
    readSelected(values: Float32Array, slot: number) {
      return values[output.selected[slot]!]!
    },
    readEffVisible(values: Float32Array, slot: number) {
      return values[output.effVisible[slot]!]!
    },
    readValidity(values: Float32Array, field: keyof typeof validityField) {
      return values[output.validity[validityField[field]]!]!
    },
  }
}

// Re-export core helpers the growth + manifold protocols in the tests reach for.
export {validateTensorEvaluation, validateTensorProgram}

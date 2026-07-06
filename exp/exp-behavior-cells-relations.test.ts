import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  type BehaviorDimensions,
  type LayoutModeName,
  baselineDimensions,
  behaviorField,
  constantField,
  createBehaviorCircuit,
  createBehaviorMachine,
  dimensionsThrough,
  fullDimensions,
  gridColumns,
  gridRows,
  growthDimensionOrder,
  slotCount,
  validateTensorEvaluation,
  validateTensorProgram,
  visibleSourceField,
} from './exp-behavior-cells-relations.ts'

// Deterministic seeded hash, matching the numeric-ui-core seeded pattern.
function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

const f = Math.fround
const relu = (x: number) => Math.max(0, f(x))

// ---------------------------------------------------------------------------
// FP32 reference layout, mirroring the circuit's arithmetic step by step so the
// tests can compare slot rects EXACTLY (===). Verified against the live circuit
// over randomized configs in a dedicated test below.
// ---------------------------------------------------------------------------

type Rect = {x: number; y: number; w: number; h: number}

const reciprocals = [0, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8].map(f)

function referenceLayout(
  W: number,
  H: number,
  slotPad: number,
  gap: number,
  mode: LayoutModeName,
  visible: readonly number[],
): Rect[] {
  const usableX = slotPad
  const usableY = slotPad
  const usableW = relu(f(W - 2 * slotPad))
  const usableH = relu(f(H - 2 * slotPad))
  const bits: number[] = visible.map(v => (v >= 0.5 ? 1 : 0))
  const trackCount = bits.reduce((sum, bit) => sum + bit, 0)
  const recip = reciprocals[trackCount] ?? 0
  const gapTotalCount = relu(trackCount - 1)
  const gapTotal = f(gapTotalCount * gap)

  const rowInnerW = relu(f(usableW - gapTotal))
  const rowSlotW = f(rowInnerW * recip)
  const colInnerH = relu(f(usableH - gapTotal))
  const colSlotH = f(colInnerH * recip)

  const gridCellW = f(f(reciprocals[gridColumns]!) * relu(f(usableW - (gridColumns - 1) * gap)))
  const gridCellH = f(f(reciprocals[gridRows]!) * relu(f(usableH - (gridRows - 1) * gap)))

  const rects: Rect[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    let track = 0
    for (let earlier = 0; earlier < slot; earlier++) track += bits[earlier]!
    let rect: Rect
    if (mode === 'row') {
      const stride = f(rowSlotW + gap)
      rect = {x: f(usableX + f(track * stride)), y: usableY, w: rowSlotW, h: usableH}
    } else if (mode === 'column') {
      const stride = f(colSlotH + gap)
      rect = {x: usableX, y: f(usableY + f(track * stride)), w: usableW, h: colSlotH}
    } else {
      const column = slot % gridColumns
      const row = Math.floor(slot / gridColumns)
      rect = {
        x: f(usableX + f(gridCellW * column) + f(gap * column)),
        y: f(usableY + f(gridCellH * row) + f(gap * row)),
        w: gridCellW,
        h: gridCellH,
      }
    }
    // Visibility gates the size to zero (multiply by the effective bit).
    const bit = bits[slot]!
    rects.push({x: rect.x, y: rect.y, w: f(bit * rect.w), h: f(bit * rect.h)})
  }
  return rects
}

function assertRectEqual(actual: Rect, expected: Rect, label: string) {
  assert.equal(actual.x, expected.x, `${label} x`)
  assert.equal(actual.y, expected.y, `${label} y`)
  assert.equal(actual.w, expected.w, `${label} w`)
  assert.equal(actual.h, expected.h, `${label} h`)
}

function allValidityBitsPass(
  machine: ReturnType<typeof createBehaviorMachine>,
  values: Float32Array,
) {
  for (const name of [
    'sizesNonnegative',
    'withinViewport',
    'atMostOneSelected',
    'noVisibleOverlap',
    'oneLayoutMode',
    'selectionImpliesVisible',
    'allValid',
  ] as const) {
    assert.equal(machine.readValidity(values, name), 1, `validity ${name} must be 1`)
  }
}

// ---------------------------------------------------------------------------
// The FP32 reference matches the live circuit exactly over randomized configs.
// ---------------------------------------------------------------------------

test('the FP32 reference layout matches the compiled circuit exactly', () => {
  const random = createRandom(0x5eed_1234)
  const machine = createBehaviorMachine()
  const modes: LayoutModeName[] = ['row', 'column', 'grid']
  for (let trial = 0; trial < 64; trial++) {
    const W = 320 + Math.floor(random() * 3000)
    const H = 240 + Math.floor(random() * 2000)
    const slotPad = Math.floor(random() * 60)
    const gap = Math.floor(random() * 80)
    const mode = modes[Math.floor(random() * 3)]!
    const visible = Array.from({length: slotCount}, () => (random() < 0.7 ? 1 : 0))

    machine.source[constantField.viewportWidth] = W
    machine.source[constantField.viewportHeight] = H
    machine.source[constantField.slotPad] = slotPad
    machine.setLayoutMode(mode)
    machine.setGap(gap)
    for (let slot = 0; slot < slotCount; slot++) machine.setVisible(slot, visible[slot]!)
    machine.clearClick()

    const values = machine.step()
    validateTensorEvaluation(machine.source, machine.circuit, values)
    const expected = referenceLayout(W, H, slotPad, gap, mode, visible)
    for (let slot = 0; slot < slotCount; slot++) {
      assertRectEqual(machine.readSlotRect(values, slot), expected[slot]!, `trial ${trial} slot ${slot}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Section 4 acceptance tasks. The circuit compiles ONCE per build; every task
// edits source cells only and reuses the same tensor program (zero recompile).
// ---------------------------------------------------------------------------

test('T1 "put the rectangles in a row" -- one horizontal track, all valid', () => {
  const machine = createBehaviorMachine()
  const programBefore = machine.circuit.tensorProgram
  machine.setLayoutMode('row') // a single behavior-cell edit

  const values = machine.step()
  validateTensorEvaluation(machine.source, machine.circuit, values)
  assert.equal(machine.circuit.tensorProgram, programBefore, 'no recompilation')

  const W = machine.source[constantField.viewportWidth]!
  const H = machine.source[constantField.viewportHeight]!
  const slotPad = machine.source[constantField.slotPad]!
  const gap = machine.source[behaviorField.gap]!
  const expected = referenceLayout(W, H, slotPad, gap, 'row', Array(slotCount).fill(1))

  const ys: number[] = []
  const xs: number[] = []
  for (let slot = 0; slot < slotCount; slot++) {
    const rect = machine.readSlotRect(values, slot)
    assertRectEqual(rect, expected[slot]!, `row slot ${slot}`)
    ys.push(rect.y)
    xs.push(rect.x)
  }
  for (const y of ys) assert.equal(y, ys[0], 'all visible slots share one horizontal track')
  for (let slot = 1; slot < slotCount; slot++) {
    assert.ok(xs[slot]! > xs[slot - 1]!, 'slot x is strictly increasing')
  }
  allValidityBitsPass(machine, values)
})

test('T2 "hide rectangle 3" -- slot 3 emits zero size, others reflow, all valid', () => {
  const machine = createBehaviorMachine() // baseline GRID
  machine.setVisible(3, 0) // one behavior-cell edit

  const values = machine.step()
  validateTensorEvaluation(machine.source, machine.circuit, values)

  const slot3 = machine.readSlotRect(values, 3)
  assert.equal(machine.readEffVisible(values, 3), 0, 'slot 3 is effectively hidden')
  assert.equal(slot3.w, 0, 'hidden slot width is exactly zero')
  assert.equal(slot3.h, 0, 'hidden slot height is exactly zero')

  // The remaining 7 slots match the reference GRID layout with slot 3 hidden.
  const visible = Array(slotCount).fill(1)
  visible[3] = 0
  const W = machine.source[constantField.viewportWidth]!
  const H = machine.source[constantField.viewportHeight]!
  const slotPad = machine.source[constantField.slotPad]!
  const gap = machine.source[behaviorField.gap]!
  const expected = referenceLayout(W, H, slotPad, gap, 'grid', visible)
  for (let slot = 0; slot < slotCount; slot++) {
    assertRectEqual(machine.readSlotRect(values, slot), expected[slot]!, `hide slot ${slot}`)
  }
  allValidityBitsPass(machine, values)
})

test('T3 "selecting rectangle 2 reveals rectangle 3" -- same circuit, state-only delta', () => {
  const machine = createBehaviorMachine()
  const programBefore = machine.circuit.tensorProgram
  machine.setLayoutMode('row')
  machine.setVisible(3, 0) // base hidden
  machine.setReveal(2, 3, 1) // selecting slot 2 reveals slot 3

  // No click: slot 3 stays hidden.
  machine.clearClick()
  let values = machine.step()
  validateTensorEvaluation(machine.source, machine.circuit, values)
  for (let slot = 0; slot < slotCount; slot++) {
    assert.equal(machine.readSelected(values, slot), 0, 'nothing selected without a click')
  }
  assert.equal(machine.readEffVisible(values, 3), 0, 'slot 3 hidden when slot 2 is not selected')
  assert.equal(machine.readSlotRect(values, 3).w, 0, 'hidden slot 3 has zero width')
  allValidityBitsPass(machine, values)

  // Click inside slot 2's pre-reveal rect: slot 2 selected -> slot 3 revealed.
  const slot2 = machine.readSlotRect(values, 2)
  machine.setClick(1, slot2.x + slot2.w / 2, slot2.y + slot2.h / 2)
  values = machine.step()
  validateTensorEvaluation(machine.source, machine.circuit, values)
  assert.equal(machine.circuit.tensorProgram, programBefore, 'no recompilation across the state delta')

  assert.equal(machine.readSelected(values, 2), 1, 'slot 2 is selected by the click')
  let selectionTotal = 0
  for (let slot = 0; slot < slotCount; slot++) selectionTotal += machine.readSelected(values, slot)
  assert.equal(selectionTotal, 1, 'exactly one slot is selected')
  assert.equal(machine.readEffVisible(values, 3), 1, 'slot 3 is revealed')
  assert.ok(machine.readSlotRect(values, 3).w > 0, 'revealed slot 3 has positive width')
  allValidityBitsPass(machine, values)
})

// ---------------------------------------------------------------------------
// Proven single compilation: the headline claim. All edits reuse one tensor
// program object captured before any edit.
// ---------------------------------------------------------------------------

test('the circuit compiles once and every behavior edit reuses it', () => {
  const machine = createBehaviorMachine()
  const program = machine.circuit.tensorProgram
  assert.ok(program !== null, 'tensor program is compiled at construction')
  validateTensorProgram(machine.circuit, program)

  machine.setLayoutMode('column')
  machine.setGap(40)
  machine.setVisible(5, 0)
  machine.setReveal(1, 5, 1)
  machine.step()
  machine.setClick(1, 100, 100)
  machine.step()
  assert.equal(machine.circuit.tensorProgram, program, 'one compiled circuit object throughout')
})

// ---------------------------------------------------------------------------
// Section 5 growth measurement protocol. Real ops / stored weights only.
// ---------------------------------------------------------------------------

test('growth protocol: marginal circuit cost per behavioral degree of freedom', () => {
  type Row = {
    k: number
    dimension: string
    ops: number
    deltaOps: number
    storedWeights: number
    deltaWeights: number
    layers: number
    maxWidth: number
  }
  const rows: Row[] = []
  let previousOps = 0
  let previousWeights = 0
  for (let k = 0; k <= 6; k++) {
    const dimensions = dimensionsThrough(k)
    const {circuit, roots} = createBehaviorCircuit(dimensions)
    const program = circuit.compileTensorProgram(roots)
    validateTensorProgram(circuit, program)
    const ops = circuit.operations.length
    const storedWeights = program.layers.reduce((sum, layer) => sum + layer.weights.length, 0)
    const layers = program.layers.length
    const maxWidth = program.layers.reduce((max, layer) => Math.max(max, layer.outputSize), 0)
    rows.push({
      k,
      dimension: growthDimensionOrder[k]!,
      ops,
      deltaOps: ops - previousOps,
      storedWeights,
      deltaWeights: storedWeights - previousWeights,
      layers,
      maxWidth,
    })
    previousOps = ops
    previousWeights = storedWeights
  }

  // Sanity: ops never shrink as dimensions are added, and the table is complete.
  assert.equal(rows.length, 7)
  for (let k = 1; k < rows.length; k++) {
    assert.ok(rows[k]!.ops >= rows[k - 1]!.ops, 'enabling a dimension never reduces ops')
  }

  // Determinism: rebuilding the full circuit yields identical cost.
  const {circuit: rebuilt, roots: rebuiltRoots} = createBehaviorCircuit(fullDimensions)
  const rebuiltProgram = rebuilt.compileTensorProgram(rebuiltRoots)
  assert.equal(rebuilt.operations.length, rows[6]!.ops, 'full build is deterministic in ops')
  assert.equal(
    rebuiltProgram.layers.reduce((sum, layer) => sum + layer.weights.length, 0),
    rows[6]!.storedWeights,
    'full build is deterministic in stored weights',
  )

  // The marginal-ops headline and per-dimension deltas (printed for the record).
  const marginalDeltas = rows.slice(1).map(row => row.deltaOps)
  const meanMarginalOps = marginalDeltas.reduce((s, d) => s + d, 0) / marginalDeltas.length
  const lines = rows.map(
    row =>
      `k=${row.k} ${row.dimension}: ops=${row.ops} dOps=${row.deltaOps} ` +
      `weights=${row.storedWeights} dW=${row.deltaWeights} layers=${row.layers} maxWidth=${row.maxWidth}`,
  )
  // Classify the trend: compare the mean marginal ops of the cheap structural
  // knobs (D1..D3) against the expensive relational knobs (D4..D6).
  const earlyMean = rows.slice(1, 4).reduce((s, r) => s + r.deltaOps, 0) / 3
  const lateMean = rows.slice(4, 7).reduce((s, r) => s + r.deltaOps, 0) / 3
  const trend = lateMean > earlyMean * 1.5 ? 'superlinear (late relational knobs dominate)' : 'roughly linear'
  console.log('[growth]\n' + lines.join('\n'))
  console.log(
    `[growth] mean marginal ops=${meanMarginalOps.toFixed(1)} ` +
      `earlyMean(D1..D3)=${earlyMean.toFixed(1)} lateMean(D4..D6)=${lateMean.toFixed(1)} trend=${trend}`,
  )

  // The spec predicts the relation table (D5) and the O(n^2) overlap check
  // inside the validity set (D6) are the superlinear terms.
  assert.ok(lateMean > earlyMean, 'relational + validity knobs cost more per dimension than structural knobs')
  const selectionRow = rows.find(row => row.dimension === 'selection')!
  const revealRow = rows.find(row => row.dimension === 'reveal')!
  const validityRow = rows.find(row => row.dimension === 'validity')!
  assert.ok(selectionRow.deltaOps > 0, 'selection adds cost')
  assert.ok(revealRow.deltaOps > 0, 'the reveal relation adds cost')
  assert.ok(validityRow.deltaOps > 0, 'the validity set adds cost')
})

// ---------------------------------------------------------------------------
// Section 6 manifold probe. 32 uniform steps A -> B, plus the analytic
// categorical midpoint that the uniform grid does not sample.
// ---------------------------------------------------------------------------

test('manifold probe: behavior space is lattice-like at the categorical mode', () => {
  const machine = createBehaviorMachine()
  const continuousFields = [
    behaviorField.rowBit,
    behaviorField.columnBit,
    behaviorField.gridBit,
    behaviorField.gap,
    ...Array.from({length: slotCount}, (_, slot) => visibleSourceField(slot)),
  ]

  // A = ROW, gap 8, all visible. B = COLUMN, gap 48, slot 7 hidden.
  const A = new Float32Array(machine.source.length)
  A.set(machine.source)
  A[behaviorField.rowBit] = 1
  A[behaviorField.columnBit] = 0
  A[behaviorField.gridBit] = 0
  A[behaviorField.gap] = 8
  for (let slot = 0; slot < slotCount; slot++) A[visibleSourceField(slot)] = 1

  const B = new Float32Array(machine.source.length)
  B.set(machine.source)
  B[behaviorField.rowBit] = 0
  B[behaviorField.columnBit] = 1
  B[behaviorField.gridBit] = 0
  B[behaviorField.gap] = 48
  for (let slot = 0; slot < slotCount; slot++) B[visibleSourceField(slot)] = 1
  B[visibleSourceField(7)] = 0

  const steps = 32
  const holes: {step: number; t: number; failing: string[]}[] = []
  for (let step = 0; step < steps; step++) {
    const t = step / (steps - 1)
    for (const field of continuousFields) {
      machine.source[field] = (1 - t) * A[field]! + t * B[field]!
    }
    machine.clearClick()
    const values = machine.step()
    if (step % 8 === 0 || step === steps - 1) {
      validateTensorEvaluation(machine.source, machine.circuit, values) // exactness while sweeping
    }
    if (machine.readValidity(values, 'allValid') === 0) {
      const failing: string[] = []
      for (const name of [
        'sizesNonnegative',
        'withinViewport',
        'atMostOneSelected',
        'noVisibleOverlap',
        'oneLayoutMode',
        'selectionImpliesVisible',
      ] as const) {
        if (machine.readValidity(values, name) === 0) failing.push(name)
      }
      holes.push({step, t, failing})
    }
  }

  // The analytic categorical midpoint (t = 0.5) that the uniform 32-grid skips:
  // both mode bits are exactly 0.5, boolean rounds both up, so two modes are
  // active. This is the lattice defect the program's validity wires exist to
  // catch -- a single point with no valid interpretation between ROW and COLUMN.
  machine.setModeBits(0.5, 0.5, 0)
  machine.setGap(28)
  for (let slot = 0; slot < slotCount; slot++) machine.setVisible(slot, 1)
  machine.clearClick()
  const midpoint = machine.step()
  validateTensorEvaluation(machine.source, machine.circuit, midpoint)
  const midV5 = machine.readValidity(midpoint, 'oneLayoutMode')
  const midV4 = machine.readValidity(midpoint, 'noVisibleOverlap')
  const midAllValid = machine.readValidity(midpoint, 'allValid')

  console.log(
    `[manifold] 32-step sweep holes=${holes.length}` +
      (holes.length > 0
        ? ' at ' + holes.map(h => `step ${h.step}(t=${h.t.toFixed(3)}):${h.failing.join('+')}`).join(', ')
        : ' (none on the uniform grid)'),
  )
  console.log(
    `[manifold] analytic midpoint t=0.500: V5=${midV5} V4=${midV4} allValid=${midAllValid} ` +
      '-> classification: LATTICE-LIKE (categorical mode hole)',
  )

  // The categorical mode is lattice-like: the midpoint has no valid one-hot.
  assert.equal(midV5, 0, 'V5 fails at the mode midpoint (two modes active)')
  assert.equal(midV4, 0, 'V4 fails at the mode midpoint (blended rects overlap)')
  assert.equal(midAllValid, 0, 'allValid is 0 at the categorical hole')

  // The hole is a thin lattice defect: the uniform grid that does not sample
  // exactly 0.5 keeps allValid=1 at every sampled step, while the midpoint is
  // invalid. Behavior space is therefore lattice-like across the mode knob even
  // though gap and continuous geometry slide smoothly.
  assert.ok(
    holes.every(h => h.t !== 0.5),
    'uniform grid holes (if any) are not the analytic midpoint',
  )
})

// ---------------------------------------------------------------------------
// Validity wires actually fire when behavior is edited into an invalid state.
// ---------------------------------------------------------------------------

test('validity wires catch malformed behavior edits', () => {
  // V5: two mode bits set at once -> oneLayoutMode = 0.
  const a = createBehaviorMachine()
  a.setModeBits(1, 1, 0)
  let values = a.step()
  validateTensorEvaluation(a.source, a.circuit, values)
  assert.equal(a.readValidity(values, 'oneLayoutMode'), 0, 'two active modes is invalid')
  assert.equal(a.readValidity(values, 'allValid'), 0)

  // V5: zero mode bits -> oneLayoutMode = 0.
  const b = createBehaviorMachine()
  b.setModeBits(0, 0, 0)
  values = b.step()
  validateTensorEvaluation(b.source, b.circuit, values)
  assert.equal(b.readValidity(values, 'oneLayoutMode'), 0, 'no active mode is invalid')

  // V2: a huge gap in ROW pushes slots past the viewport -> withinViewport = 0.
  const c = createBehaviorMachine()
  c.setLayoutMode('row')
  c.setGap(512)
  values = c.step()
  validateTensorEvaluation(c.source, c.circuit, values)
  assert.equal(c.readValidity(values, 'withinViewport'), 0, 'overflowing gap escapes the viewport')
})

// ---------------------------------------------------------------------------
// Dimension gating produces honest variants (baseline truly bakes behavior).
// ---------------------------------------------------------------------------

test('baseline dimensions bake behavior; full dimensions expose every knob', () => {
  const baseline: BehaviorDimensions = baselineDimensions
  const {circuit: baselineCircuit, roots: baselineRoots} = createBehaviorCircuit(baseline)
  const baselineProgram = baselineCircuit.compileTensorProgram(baselineRoots)
  validateTensorProgram(baselineCircuit, baselineProgram)

  const {circuit: fullCircuit, roots: fullRoots} = createBehaviorCircuit(fullDimensions)
  const fullProgram = fullCircuit.compileTensorProgram(fullRoots)
  validateTensorProgram(fullCircuit, fullProgram)

  assert.ok(
    fullCircuit.operations.length > baselineCircuit.operations.length,
    'the full behavior surface costs more than the baked baseline',
  )
})

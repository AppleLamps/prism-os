// Differential checking between the circuit and the hn.js-derived reference.
//
// Decisions (pointed row, gutter, ancestor, shrink, collapse, visibility, slot
// assignment) must match exactly, unless the reference says the decision was within
// `tie` px of its threshold, where FP32 rounding in the circuit may legitimately
// resolve it the other way. Those are counted separately. Positions are compared
// with a tolerance, and the largest drift is reported.

import {buildThreadCircuit, createThreadMachine, readThreadFrame, type BuiltThreadCircuit, type ThreadCircuitOptions} from './thread-circuit.ts'
import {
  containerWidthF, referenceFrame, rowFrameFields, slotFrameFields,
  type FrameBranches, type FrameInputs, type FrameMargins, type ThreadFrame, type ThreadState,
} from './thread-frame.ts'
import {commentWidthAt} from './text-heights.ts'
import {threadLayout} from './thread-model.ts'
import type {PreparedThread} from './thread-prepare.ts'

export type Mismatch = {path: string, reference: number, circuit: number, margin: number}

export type Comparison = {
  decisionMismatches: Mismatch[]
  tieMismatches: Mismatch[]
  positionMismatches: Mismatch[]
  maxDrift: number
  maxDriftPath: string
  decisions: number
  positions: number
}

export function emptyComparison(): Comparison {
  return {decisionMismatches: [], tieMismatches: [], positionMismatches: [], maxDrift: 0, maxDriftPath: '', decisions: 0, positions: 0}
}

const hitDecisionFields = new Set(['shrink', 'collapsed', 'emphasis', 'gutterEmphasis'])
const rowExactFields = new Set(['textHeight', 'naturalHeight'])

export function compareFrames(
  into: Comparison,
  reference: ThreadFrame,
  margins: FrameMargins,
  circuit: ThreadFrame,
  tolerance: {position: number, tie: number},
): {tie: boolean} {
  const tie = tolerance.tie
  // Decisions upstream of everything: whether scroll smoothing runs, whether all comments fit, whether the width changed.
  const upstreamMargin = Math.min(margins.smoothing, margins.fits, margins.widthChanged)
  const hitMargin = Math.min(upstreamMargin, margins.hit)
  const visualMargin = Math.min(upstreamMargin, margins.overscroll)
  let frameTie = false
  const decision = (path: string, referenceValue: number, circuitValue: number, margin: number, affectsWholeFrame: boolean) => {
    into.decisions++
    if (referenceValue === circuitValue) return
    const mismatch = {path, reference: referenceValue, circuit: circuitValue, margin}
    if (margin < tie) {
      into.tieMismatches.push(mismatch)
      if (affectsWholeFrame) frameTie = true
    } else {
      into.decisionMismatches.push(mismatch)
    }
  }
  const pending: Mismatch[] = []
  const position = (path: string, referenceValue: number, circuitValue: number) => {
    into.positions++
    const drift = Math.abs(referenceValue - circuitValue)
    if (!(drift <= tolerance.position)) pending.push({path, reference: referenceValue, circuit: circuitValue, margin: drift})
    else if (drift > into.maxDrift) {
      into.maxDrift = drift
      into.maxDriftPath = path
    }
  }

  const referenceGlobal = reference.global
  const circuitGlobal = circuit.global
  decision('global.pointerOn', referenceGlobal.pointerOn, circuitGlobal.pointerOn, hitMargin, true)
  if (referenceGlobal.pointerOn === 1 || referenceGlobal.pointerOn === 2) decision('global.pointedRow', referenceGlobal.pointedRow, circuitGlobal.pointedRow, hitMargin, true)
  if (referenceGlobal.pointerOn === 2) decision('global.ancestor', referenceGlobal.ancestor, circuitGlobal.ancestor, hitMargin, true)
  decision('global.toggleRegion', referenceGlobal.toggleRegion, circuitGlobal.toggleRegion, Math.min(hitMargin, margins.toggle), true)
  decision('global.peeking', referenceGlobal.peeking, circuitGlobal.peeking, hitMargin, true)
  decision('global.cursorCode', referenceGlobal.cursorCode, circuitGlobal.cursorCode, Math.min(hitMargin, margins.toggle, margins.cursor), false)
  decision('global.scheduleNextRender', referenceGlobal.scheduleNextRender, circuitGlobal.scheduleNextRender, Math.min(margins.smoothing, margins.peekMoving, margins.moving), false)
  const occupancyMargin = Math.min(visualMargin, ...margins.occupancy)
  decision('global.slotOverflow', referenceGlobal.slotOverflow, circuitGlobal.slotOverflow, occupancyMargin, false)
  for (const field of ['scrollTop', 'scrollTopCap', 'containerWidth', 'containerLeft', 'containerHeight', 'submissionHeight', 'submissionLine1Top', 'submissionLine2Top', 'searchLeft', 'searchTop', 'scrollerTop', 'scrollerHeight', 'scrollerPeekUp', 'placeholderHeight'] as const) {
    position(`global.${field}`, referenceGlobal[field], circuitGlobal[field])
  }

  for (let row = 0; row < reference.rows.length; row++) {
    const referenceRow = reference.rows[row]!
    const circuitRow = circuit.rows[row]!
    const gutterTied = margins.gutterSelect[row]! < tie
    for (const field of rowFrameFields) {
      const path = `rows[${row}].${field}`
      if (rowExactFields.has(field)) {
        decision(path, referenceRow[field], circuitRow[field], Infinity, true)
      } else if (hitDecisionFields.has(field)) {
        decision(path, referenceRow[field], circuitRow[field], hitMargin, true)
      } else if (field === 'visible') {
        decision(path, referenceRow[field], circuitRow[field], Math.min(visualMargin, margins.visible[row]!), false)
      } else if (field === 'occupiesSlot') {
        decision(path, referenceRow[field], circuitRow[field], Math.min(visualMargin, margins.occupancy[row]!), false)
      } else if (field === 'gutterVisible') {
        decision(path, referenceRow[field], circuitRow[field], Math.min(visualMargin, margins.gutterVisible[row]!), false)
      } else if ((field === 'gutterTop' || field === 'gutterBottom') && gutterTied) {
        // The gutter top picks one of three values by <= 4px tests; a tie there moves the gutter, not a row.
        if (Math.abs(referenceRow[field] - circuitRow[field]) > tolerance.position) {
          into.tieMismatches.push({path, reference: referenceRow[field], circuit: circuitRow[field], margin: margins.gutterSelect[row]!})
        }
      } else {
        position(path, referenceRow[field], circuitRow[field])
      }
    }
  }

  for (let slot = 0; slot < reference.slots.length; slot++) {
    const referenceSlot = reference.slots[slot]!
    const circuitSlot = circuit.slots[slot]!
    decision(`slots[${slot}].present`, referenceSlot.present, circuitSlot.present, occupancyMargin, false)
    if (referenceSlot.present !== 1) continue
    decision(`slots[${slot}].row`, referenceSlot.row, circuitSlot.row, occupancyMargin, false)
    if (referenceSlot.row !== circuitSlot.row) continue
    for (const field of slotFrameFields) {
      if (field === 'present' || field === 'row') continue
      if (field === 'emphasis' || field === 'collapsed') decision(`slots[${slot}].${field}`, referenceSlot[field], circuitSlot[field], hitMargin, false)
      else position(`slots[${slot}].${field}`, referenceSlot[field], circuitSlot[field])
    }
  }

  const referenceNext = reference.next
  const circuitNext = circuit.next
  for (const field of ['scrollTopPrevious', 'scrollDeltaPrevious', 'scrollerPeekUp', 'containerWidthPrevious'] as const) {
    position(`next.${field}`, referenceNext[field], circuitNext[field])
  }
  // next.collapsed and next.restTargetsPrevious are the same wires (and the same reference arrays) as rows[].collapsed
  // and rows[].naturalHeight, which were already compared, so comparing them again would only inflate the count.
  for (let row = 0; row < reference.rows.length; row++) {
    position(`next.restHeights[${row}]`, referenceNext.restHeights[row]!, circuitNext.restHeights[row]!)
    position(`next.heights[${row}]`, referenceNext.heights[row]!, circuitNext.heights[row]!)
  }
  // A tied upstream or hit-test decision moves positions everywhere, so position mismatches only count in frames without one.
  if (!frameTie) into.positionMismatches.push(...pending)
  return {tie: frameTie}
}

export function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const onGrid = (value: number, steps = 64) => Math.round(value * steps) / steps

function naturalHeightsFor(prepared: PreparedThread, containerWidth: number, collapsed: readonly number[]) {
  return prepared.tables.indents.map((indent, row) => {
    if (prepared.tables.ancestors[row]!.some(ancestor => collapsed[ancestor] === 1)) return 0
    if (collapsed[row] === 1) return threadLayout.collapsedRowHeight
    return prepared.textHeightAt(row, commentWidthAt(containerWidth, indent)) + threadLayout.rowHeightExtra
  })
}

// A random but reachable-looking state: some comments collapsed, rows mid-animation, scroll smoothing in progress.
export function randomState(prepared: PreparedThread, random: () => number, windowWidth: number): ThreadState {
  const rowCount = prepared.tables.rowCount
  const containerWidthPrevious = random() < 0.7 ? containerWidthF(windowWidth) : containerWidthF(Math.round(320 + random() * 1100))
  const collapsed = Array.from({length: rowCount}, () => random() < 0.08 ? 1 : 0)
  const restTargetsPrevious = naturalHeightsFor(prepared, containerWidthPrevious, collapsed)
  const animated = (settled: number) => {
    const choice = random()
    if (choice < 0.6) return settled
    if (choice < 0.7) return 0
    return onGrid(random() * (settled + 40))
  }
  const content = restTargetsPrevious.reduce((total, height) => total + height, 0)
  return {
    scrollTopPrevious: onGrid(-40 + random() * (content + 80)),
    scrollDeltaPrevious: random() < 0.5 ? 0 : onGrid((random() * 2 - 1) * 40),
    scrollerPeekUp: random() < 0.7 ? 0 : onGrid(random() * 100),
    containerWidthPrevious,
    collapsed,
    restHeights: restTargetsPrevious.map(animated),
    heights: restTargetsPrevious.map(animated),
    restTargetsPrevious,
  }
}

export type TargetKind = 'banner' | 'gutter'

// Scroll one comment's natural top to about 200px below the submission header, then point at its banner or at one
// of its gutter columns. When the comments don't fit, hn.js makes the header 100 - min(40, scrollTop) tall.
export function targetedInputs(prepared: PreparedThread, random: () => number, state: ThreadState, row: number, kind: TargetKind, windowWidth: number, windowHeight: number): FrameInputs {
  // A random offset on the 1/4px grid strictly between 0 and `size`. Rounding to the grid could land exactly on the
  // region's far edge, e.g. a gutter press at x = (indent + 1) * 24, which is the comment's banner, not its gutter.
  const inside = (size: number) => (1 + Math.floor(random() * (size * 4 - 1))) / 4
  const containerWidth = containerWidthF(windowWidth)
  const containerLeft = (windowWidth - containerWidth) / 2
  const naturalHeights = naturalHeightsFor(prepared, containerWidth, state.collapsed)
  let prefix = 0
  for (let i = 0; i < row; i++) prefix += naturalHeights[i]!
  const scrollTopReal = Math.max(0, Math.round(prefix - 200))
  const submissionHeight = threadLayout.submissionHeightNatural - Math.min(threadLayout.submissionHeightDelta, scrollTopReal)
  const pageTop = threadLayout.currentContainerTop + submissionHeight - scrollTopReal + prefix
  const indent = prepared.tables.indents[row]!
  return {
    windowWidth,
    windowHeight,
    scrollTopReal,
    pointerX: containerLeft + (kind === 'banner' ? onGrid((indent + 1) * 24 + random() * 200, 4) : inside((indent + 1) * 24)),
    // The banner is the first 24px of the row; a gutter press can land anywhere in the first 40px.
    pointerY: pageTop + inside(Math.min(kind === 'banner' ? threadLayout.userHeightNatural : 40, naturalHeights[row]!)),
    pointerDown: kind === 'gutter' || random() < 0.5 ? 1 : 0,
    click: kind === 'banner' || random() < 0.5 ? 1 : 0,
  }
}

export function randomInputs(prepared: PreparedThread, random: () => number, state: ThreadState): FrameInputs {
  const windowWidth = random() < 0.7 ? Math.round(320 + random() * 1100) : onGrid(320 + random() * 1100)
  const windowHeight = Math.round(300 + random() * 1000)
  const containerWidth = containerWidthF(windowWidth)
  const containerLeft = (windowWidth - containerWidth) / 2
  const naturalHeights = naturalHeightsFor(prepared, containerWidth, state.collapsed)
  const content = naturalHeights.reduce((total, height) => total + height, 0)
  const mode = random()
  if (mode < 0.35) {
    const candidates = naturalHeights.flatMap((height, row) => height > 0 ? [row] : [])
    const row = candidates[Math.floor(random() * candidates.length)]!
    return targetedInputs(prepared, random, state, row, random() < 0.5 ? 'banner' : 'gutter', windowWidth, Math.max(windowHeight, 700))
  }
  const gutterBias = mode < 0.65
  const pointerX = containerLeft + (gutterBias ? onGrid(random() * 24 * (prepared.tables.maxIndent + 2), 4) : onGrid(-40 + random() * (containerWidth + 80), 4))
  return {
    windowWidth,
    windowHeight,
    scrollTopReal: Math.round(-40 + random() * (content + 40)),
    pointerX,
    pointerY: onGrid(-20 + random() * (windowHeight + 40), 4),
    pointerDown: random() < 0.5 ? 1 : 0,
    click: random() < 0.25 ? 1 : 0,
  }
}

export type DifferentialSummary = {
  frames: number
  tieFrames: number
  comparison: Comparison
  // How often the reference took each branch, so a test can tell a branch was exercised.
  fitsFrames: number
  smoothingFrames: number
  widthChangedFrames: number
  toggleFrames: number
  peekFrames: number
  shrinkFrames: number
  overflowFrames: number
  // Frames where a click collapsed a comment, and where a click expanded one.
  collapseFrames: number
  expandFrames: number
  // Targeted sweep only: banner clicks that didn't toggle their comment, and gutter presses that didn't land on the
  // comment's gutter.
  targetMisses: number
}

function emptySummary(): DifferentialSummary {
  return {frames: 0, tieFrames: 0, comparison: emptyComparison(), fitsFrames: 0, smoothingFrames: 0, widthChangedFrames: 0, toggleFrames: 0, peekFrames: 0, shrinkFrames: 0, overflowFrames: 0, collapseFrames: 0, expandFrames: 0, targetMisses: 0}
}

function countFrame(summary: DifferentialSummary, state: ThreadState, expected: ThreadFrame, branches: FrameBranches) {
  summary.frames++
  if (branches.fits) summary.fitsFrames++
  if (branches.smoothing) summary.smoothingFrames++
  if (branches.widthChanged) summary.widthChangedFrames++
  if (expected.next.collapsed.some((bit, row) => bit !== state.collapsed[row])) summary.toggleFrames++
  if (expected.next.collapsed.some((bit, row) => bit === 1 && state.collapsed[row] === 0)) summary.collapseFrames++
  if (expected.next.collapsed.some((bit, row) => bit === 0 && state.collapsed[row] === 1)) summary.expandFrames++
  if (expected.global.peeking === 1) summary.peekFrames++
  if (expected.rows.some(row => row.shrink === 1)) summary.shrinkFrames++
  if (expected.global.slotOverflow === 1) summary.overflowFrames++
}

function checkFrame(summary: DifferentialSummary, prepared: PreparedThread, built: BuiltThreadCircuit, machine: ReturnType<typeof createThreadMachine>, state: ThreadState, inputs: FrameInputs, tolerance: {position: number, tie: number}) {
  const {frame: expected, margins, branches} = referenceFrame(prepared, state, inputs, built.options.slotCount, built.options.slotMode)
  resetMachineState(machine, built, state)
  const actual = readThreadFrame(built, machine.step(inputs))
  if (compareFrames(summary.comparison, expected, margins, actual, tolerance).tie) summary.tieFrames++
  countFrame(summary, state, expected, branches)
  return expected
}

export function runSingleFrameDifferential(
  prepared: PreparedThread,
  built: BuiltThreadCircuit,
  trials: number,
  seed: number,
  tolerance = {position: 0.05, tie: 0.02},
): DifferentialSummary {
  const random = seededRandom(seed)
  const summary = emptySummary()
  const machine = createThreadMachine(built, randomState(prepared, random, 1024))
  for (let trial = 0; trial < trials; trial++) {
    const state = randomState(prepared, random, Math.round(320 + random() * 1100))
    checkFrame(summary, prepared, built, machine, state, randomInputs(prepared, random, state), tolerance)
  }
  return summary
}

// Every comment, 3 frames: click its banner while it's expanded, click its banner while it's collapsed, and press one
// of its gutter columns. The target's ancestors are expanded so the comment is visible, so both directions of the
// toggle get checked for every row. `targetMisses` counts targets that weren't hit.
export function runTargetedSweep(prepared: PreparedThread, built: BuiltThreadCircuit, seed: number, tolerance = {position: 0.05, tie: 0.02}): DifferentialSummary {
  const random = seededRandom(seed)
  const summary = emptySummary()
  const machine = createThreadMachine(built, randomState(prepared, random, 1024))
  for (let row = 0; row < prepared.tables.rowCount; row++) {
    for (const target of ['banner of an expanded comment', 'banner of a collapsed comment', 'gutter'] as const) {
      const windowWidth = Math.round(700 + random() * 600)
      const state = randomState(prepared, random, windowWidth)
      state.scrollDeltaPrevious = 0
      state.containerWidthPrevious = containerWidthF(windowWidth)
      for (const ancestor of prepared.tables.ancestors[row]!) state.collapsed[ancestor] = 0
      if (target !== 'gutter') state.collapsed[row] = target === 'banner of a collapsed comment' ? 1 : 0
      const kind = target === 'gutter' ? 'gutter' : 'banner'
      const expected = checkFrame(summary, prepared, built, machine, state, targetedInputs(prepared, random, state, row, kind, windowWidth, 900), tolerance)
      const hit = kind === 'gutter'
        ? expected.global.pointerOn === 2 && expected.global.pointedRow === row
        : expected.next.collapsed[row] !== state.collapsed[row]
      if (!hit) summary.targetMisses++
    }
  }
  return summary
}

function resetMachineState(machine: ReturnType<typeof createThreadMachine>, built: BuiltThreadCircuit, state: ThreadState) {
  const {layout} = built
  machine.source[layout.cell.scrollTopPrevious] = state.scrollTopPrevious
  machine.source[layout.cell.scrollDeltaPrevious] = state.scrollDeltaPrevious
  machine.source[layout.cell.scrollerPeekUp] = state.scrollerPeekUp
  machine.source[layout.cell.containerWidthPrevious] = state.containerWidthPrevious
  machine.source.set(state.collapsed, layout.collapsed)
  machine.source.set(state.restHeights, layout.restHeights)
  machine.source.set(state.heights, layout.heights)
  machine.source.set(state.restTargetsPrevious, layout.restTargetsPrevious)
}

// A scripted session. The circuit and the reference each run on their own feedback, so FP32 and float64
// easing drift apart over frames; decisions still have to agree.
export function scenarioInputs(prepared: PreparedThread, frames: number): (frame: number, reference: ThreadFrame | null) => FrameInputs {
  const tables = prepared.tables
  const deepRow = tables.indents.findIndex(indent => indent >= 3)
  const parentWithChildren = tables.descendantCounts.findIndex((count, row) => count >= 2 && row > 0)
  let pointerX = 300
  let pointerY = 300
  let scrollTopReal = 0
  let windowWidth = 1024
  let windowHeight = 800
  return (frame, reference) => {
    const phase = frame / frames
    let pointerDown = 0
    let click = 0
    const pageYOfRow = (row: number, offset: number) => {
      if (reference === null) return 300
      let top = 0
      for (let i = 0; i < row; i++) top += reference.rows[i]!.naturalHeight
      return threadLayout.currentContainerTop + reference.global.submissionHeight - reference.global.scrollTopCap + top + offset
    }
    const leftOf = (level: number) => reference === null ? 100 : reference.global.containerLeft + level * threadLayout.indentWidth + 10.5
    if (phase < 0.12) {
      scrollTopReal = Math.round(frame * 23)
      pointerX = 400 + frame
      pointerY = 200 + frame * 2.5
    } else if (phase < 0.3) {
      // scroll the deep row into view, then press its level-1 gutter
      if (deepRow > 0 && reference !== null) {
        let top = 0
        for (let i = 0; i < deepRow; i++) top += reference.rows[i]!.naturalHeight
        scrollTopReal = Math.max(0, Math.round(top - 200))
        pointerX = leftOf(1)
        pointerY = pageYOfRow(deepRow, 30.25)
        pointerDown = phase > 0.16 ? 1 : 0
      }
    } else if (phase < 0.42) {
      pointerDown = 0
    } else if (phase < 0.62) {
      // collapse a comment with children through its banner, wait, then expand it
      if (parentWithChildren >= 0 && reference !== null) {
        let top = 0
        for (let i = 0; i < parentWithChildren; i++) top += reference.rows[i]!.naturalHeight
        scrollTopReal = Math.max(0, Math.round(top - 100))
        pointerX = leftOf(tables.indents[parentWithChildren]! + 2)
        pointerY = pageYOfRow(parentWithChildren, 10.5)
        const localFrame = frame - Math.ceil(0.42 * frames)
        click = localFrame === 8 || localFrame === Math.round(0.1 * frames) ? 1 : 0
      }
    } else if (phase < 0.8) {
      // resize from 1024px down to about 500px
      windowWidth = Math.round(1024 - (phase - 0.62) / 0.18 * 520)
      windowHeight = 800 + Math.round(Math.sin(frame) * 10)
    } else {
      // widen, then scroll past the end to exercise the overscroll squash
      windowWidth = 1300
      const scrollEnd = reference === null ? 0 : reference.global.placeholderHeight - reference.global.scrollerHeight
      scrollTopReal = Math.min(Math.round(scrollTopReal + 180), Math.max(0, Math.round(scrollEnd + 120)))
      pointerY = 500.5
    }
    return {windowWidth, windowHeight, scrollTopReal, pointerX, pointerY, pointerDown, click}
  }
}

export function runScenarioDifferential(
  prepared: PreparedThread,
  built: BuiltThreadCircuit,
  frames: number,
  tolerance = {position: 0.5, tie: 0.05},
): DifferentialSummary & {collapsedFrames: number} {
  const summary = emptySummary()
  let collapsedFrames = 0
  const initial = initialStateAt(prepared, 1024)
  const machine = createThreadMachine(built, initial)
  let referenceState = initial
  let previousReference: ThreadFrame | null = null
  const inputsAt = scenarioInputs(prepared, frames)
  for (let frame = 0; frame < frames; frame++) {
    const inputs = inputsAt(frame, previousReference)
    const {frame: expected, margins, branches} = referenceFrame(prepared, referenceState, inputs, built.options.slotCount, built.options.slotMode)
    const actual = readThreadFrame(built, machine.step(inputs))
    if (compareFrames(summary.comparison, expected, margins, actual, tolerance).tie) summary.tieFrames++
    countFrame(summary, referenceState, expected, branches)
    if (expected.next.collapsed.some(bit => bit === 1)) collapsedFrames++
    referenceState = expected.next
    previousReference = expected
  }
  return {...summary, collapsedFrames}
}

function initialStateAt(prepared: PreparedThread, windowWidth: number): ThreadState {
  const containerWidth = containerWidthF(windowWidth)
  const naturalHeights = naturalHeightsFor(prepared, containerWidth, prepared.tables.indents.map(() => 0))
  return {
    scrollTopPrevious: 0,
    scrollDeltaPrevious: 0,
    scrollerPeekUp: 0,
    containerWidthPrevious: containerWidth,
    collapsed: naturalHeights.map(() => 0),
    restHeights: [...naturalHeights],
    heights: [...naturalHeights],
    restTargetsPrevious: [...naturalHeights],
  }
}

export function buildForPrepared(prepared: PreparedThread, options: ThreadCircuitOptions) {
  return buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, options)
}

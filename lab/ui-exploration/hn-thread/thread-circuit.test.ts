import {describe, expect, test} from 'bun:test'
import {installFakeCanvas} from './fake-canvas.ts'
import {validateOneHotGroups} from '../../../numeric-ui-core.ts'
import {getEngineProfile} from '../text-tabulated/pretext/measurement.ts'
import {thread} from './hn-data.ts'
import {prepareThread} from './thread-prepare.ts'
import {commentTextHeight, commentWidthAt, staircaseHeight} from './text-heights.ts'
import {buildForPrepared, randomInputs, randomState, runScenarioDifferential, runSingleFrameDifferential, runTargetedSweep, seededRandom, type DifferentialSummary} from './differential.ts'
import {createThreadMachine, writeInputs} from './thread-circuit.ts'

// pretext reads the canvas and navigator lazily, on the first measurement.
installFakeCanvas()

const tiny = prepareThread(thread.comments.slice(0, 3))
const small = prepareThread(thread.comments.slice(0, 60))
const full = prepareThread(thread.comments)

function expectNoMismatches(summary: DifferentialSummary) {
  expect(summary.comparison.decisionMismatches.slice(0, 5)).toEqual([])
  expect(summary.comparison.positionMismatches.slice(0, 5)).toEqual([])
}

describe('prepared breakpoints', () => {
  test('pretext runs with the Chrome profile under the fake canvas', () => {
    expect(getEngineProfile().lineFitEpsilon).toBe(0.005)
    expect(getEngineProfile().inlineItemBreaks).toBe('joined-text')
  })

  test('staircases reproduce pretext heights at random and boundary widths', () => {
    const random = seededRandom(3)
    let checks = 0
    for (let row = 0; row < small.tables.rowCount; row++) {
      const staircase = small.staircases[row]!
      const indent = small.tables.indents[row]!
      const widths: number[] = []
      for (let sample = 0; sample < 40; sample++) widths.push(Math.round((375 + random() * 825) * 64) / 64)
      for (const step of staircase.steps) widths.push(Math.floor(step.containerWidth * 64) / 64, Math.ceil(step.containerWidth * 64) / 64)
      for (const width of widths) {
        expect(staircaseHeight(staircase, width)).toBe(commentTextHeight(small.preparedComments[row]!, commentWidthAt(width, indent)))
        checks++
      }
    }
    expect(checks).toBeGreaterThan(2400)
  })
})

describe('thread circuit', () => {
  const builtTiny = buildForPrepared(tiny, {slotCount: 4, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'})
  const builtSmall = buildForPrepared(small, {slotCount: 16, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'})
  const builtSmallWindow = buildForPrepared(small, {slotCount: 16, slotMode: 'window', naturalPrefix: 'fold', visualPrefix: 'brent-kung'})
  const builtFull = buildForPrepared(full, {slotCount: 48, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'})

  test('declared one-hot groups hold on random states', () => {
    const random = seededRandom(11)
    for (let trial = 0; trial < 20; trial++) {
      const state = randomState(full, random, 1024)
      const machine = createThreadMachine(builtFull, state)
      writeInputs(machine.source, builtFull.layout, randomInputs(full, random, state))
      validateOneHotGroups(builtFull.circuit, builtFull.circuit.evaluateTensor(machine.source))
    }
  })

  test('single frames match the reference, 60 comments, 16 slots', () => {
    const summary = runSingleFrameDifferential(small, builtSmall, 600, 5)
    expectNoMismatches(summary)
    expect(summary.tieFrames).toBeLessThan(10)
    expect(summary.toggleFrames).toBeGreaterThan(30)
    expect(summary.shrinkFrames).toBeGreaterThan(20)
    expect(summary.overflowFrames).toBeGreaterThan(5)
    expect(summary.smoothingFrames).toBeGreaterThan(100)
    expect(summary.widthChangedFrames).toBeGreaterThan(100)
  })

  test('every comment: banner clicks from both states and a gutter press match the reference', () => {
    const summary = runTargetedSweep(small, builtSmall, 13)
    expectNoMismatches(summary)
    // Every banner click toggles its comment, once from expanded and once from collapsed, and every gutter press lands
    // on the comment's gutter.
    expect(summary.targetMisses).toBe(0)
    expect(summary.collapseFrames).toBe(small.tables.rowCount)
    expect(summary.expandFrames).toBe(small.tables.rowCount)
    expect(summary.peekFrames).toBe(small.tables.rowCount)
  })

  test('a 3-comment thread, where every comment fits and the header grows', () => {
    const summary = runSingleFrameDifferential(tiny, builtTiny, 300, 17)
    expectNoMismatches(summary)
    expect(summary.fitsFrames).toBeGreaterThan(30)
  })

  test('window slots and the other prefix sum constructions match the reference', () => {
    const summary = runSingleFrameDifferential(small, builtSmallWindow, 300, 19)
    expectNoMismatches(summary)
    expect(summary.tieFrames).toBeLessThan(6)
  })

  test('single frames match the reference, 251 comments, 48 slots', () => {
    const summary = runSingleFrameDifferential(full, builtFull, 100, 7)
    expectNoMismatches(summary)
    expect(summary.tieFrames).toBeLessThan(4)
  })

  test('a scripted session of scrolling, peeking, collapsing and resizing matches the reference', () => {
    const summary = runScenarioDifferential(full, builtFull, 300)
    expect(summary.peekFrames).toBeGreaterThan(20)
    expect(summary.collapsedFrames).toBeGreaterThan(20)
    expectNoMismatches(summary)
  })
})

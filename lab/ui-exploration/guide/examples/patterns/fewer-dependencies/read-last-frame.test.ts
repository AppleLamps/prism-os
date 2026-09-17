// Checks the drawer's thumbnail layout in drawer-grid.ts against the JavaScript loop
// it replaces, over random widths and widths next to every column threshold, in both
// evaluators. Checks along traces that the 'last evaluation' layout lays out for the
// width that the last evaluation that wrote state back drew, and pins the sizes and
// lags that guide/patterns/read-last-frame.md quotes. Run from the repo root:
// bun test lab/ui-exploration/guide/examples/patterns/fewer-dependencies
import {expect, test} from 'bun:test'
import type {WriteBack} from '../../../../../../src/runtime/host-timing.ts'
import {springMatrixPower, springStepMatrix} from '../../../../../../src/runtime/host-timing.ts'
import {evaluateBoth, frameTimesAt, measureProgram, nextFloat32, seededRandom} from './helpers.ts'
import {
  type DrawerLayout,
  type DrawerRun,
  type WidthSource,
  buildDrawerGrid,
  drawerCell,
  drawerLayout,
  drawerSpring,
  initialDrawerTable,
  layoutThumbnails,
  readDrawerLayout,
  runDrawerGrid,
  widthLimit,
} from './drawer-grid.ts'

const sources: readonly WidthSource[] = ['this evaluation', 'last evaluation', 'stepped springs']
const seeds = [1, 2, 3, 4, 5, 6, 7, 8]

// 8 toggles between frames on the 1/64 ms grid, 150 to 1,050 ms apart, so some
// toggles land while the drawer still moves.
function toggleTimes(seed: number): number[] {
  const random = seededRandom(seed)
  const times: number[] = []
  let time = 200
  for (let index = 0; index < 8; index++) {
    time += 150 + random() * 900
    times.push(Math.round(time * 64) / 64)
  }
  return times
}

// The largest distance in px between two layouts, or Infinity when their column counts differ.
function layoutDistance(left: DrawerLayout, right: DrawerLayout) {
  if (left.columnCount !== right.columnCount) return Number.POSITIVE_INFINITY
  let worst = 0
  left.lefts.forEach((value, index) => {
    worst = Math.max(worst, Math.abs(value - right.lefts[index]!), Math.abs(left.tops[index]! - right.tops[index]!))
  })
  return worst
}

test("sizes: reading last evaluation's width takes the drawer from 30 layers to 17 with the same 144 operations, and reading the springs right after their steps gives 21 layers", () => {
  const sizes = sources.map(source => {
    const {circuit, roots} = buildDrawerGrid(source)
    return measureProgram(circuit, roots)
  })
  expect(sizes).toEqual([
    {operations: 144, layers: 30},
    {operations: 144, layers: 17},
    {operations: 145, layers: 21},
  ])
})

test('the layout equals the JavaScript loop over random widths and widths next to every column threshold, in both evaluators', () => {
  // In the 'last evaluation' program the width the layout reads is a source cell, so any width can be written.
  const {circuit, roots} = buildDrawerGrid('last evaluation')
  const evaluate = circuit.createTensorEvaluator(roots)
  const powers = Array.from({length: 301}, (_, steps) => springMatrixPower(springStepMatrix(drawerSpring), steps))
  const random = seededRandom(31)
  const widths = [0, 119, 120, drawerLayout.closedWidth, drawerLayout.openWidth, widthLimit]
  for (let columns = 2; columns <= drawerLayout.maximumColumns; columns++) {
    const threshold = columns * drawerLayout.minimumCellWidth
    widths.push(nextFloat32(threshold, -1), threshold, nextFloat32(threshold, 1))
  }
  for (let sample = 0; sample < 4000; sample++) widths.push(Math.fround(random() * widthLimit))
  let worst = 0
  for (const width of widths) {
    const table = initialDrawerTable()
    table.set(powers[Math.floor(random() * powers.length)]!, drawerCell.matrixStart)
    table[drawerCell.settleCheck] = random() < 0.5 ? 1 : 0
    table[drawerCell.toggleActive] = random() < 0.5 ? 1 : 0
    table[drawerCell.open] = random() < 0.5 ? 1 : 0
    table[drawerCell.displacement] = (random() * 2 - 1) * 400
    table[drawerCell.velocity] = (random() * 2 - 1) * 4000
    table[drawerCell.previousWidth] = width
    const outputs = evaluateBoth(circuit, evaluate, roots, table)
    worst = Math.max(worst, layoutDistance(readDrawerLayout(outputs), layoutThumbnails(width)))
  }
  expect(worst).toBeLessThan(5e-4)
})

test("along traces, every layout equals the JavaScript loop over the width it read, and 'last evaluation' reads the width that the last evaluation that wrote state back drew", () => {
  for (const writeBack of ['every evaluation', 'events and settle checks'] as const) {
    for (const seed of seeds.slice(0, 4)) {
      const times = toggleTimes(seed)
      const frames = frameTimesAt(60, times.at(-1)! + 1500)
      for (const source of sources) {
        const run = runDrawerGrid(frames, times, writeBack, source)
        let worst = 0
        let outsideDeclaredRange = 0
        let staleMismatches = 0
        let lastWrittenWidth: number = drawerLayout.closedWidth
        for (const evaluation of run.evaluations) {
          if (!(evaluation.layoutWidth >= 0 && evaluation.layoutWidth <= widthLimit)) outsideDeclaredRange++
          worst = Math.max(worst, layoutDistance(evaluation.layout, layoutThumbnails(evaluation.layoutWidth)))
          if (source === 'last evaluation' && !Object.is(evaluation.layoutWidth, lastWrittenWidth)) staleMismatches++
          if (evaluation.writesBack) lastWrittenWidth = evaluation.drawnWidth
        }
        expect(outsideDeclaredRange).toBe(0)
        expect(worst).toBeLessThan(5e-4)
        expect(staleMismatches).toBe(0)
      }
    }
  }
})

test('both evaluators draw the same frames for every width source', () => {
  const times = toggleTimes(1)
  const frames = frameTimesAt(60, times.at(-1)! + 1500)
  for (const source of sources) {
    const compiled = runDrawerGrid(frames, times, 'every evaluation', source, 'compiled')
    const reference = runDrawerGrid(frames, times, 'every evaluation', source, 'reference')
    expect(reference.evaluations).toEqual(compiled.evaluations)
  }
})

// Compares each frame of a run with the same frame of the run that lays out for this
// evaluation's width, summed or maximized over the 8 traces.
function lagAgainstThisEvaluation(hz: number, writeBack: WriteBack, source: WidthSource) {
  let frames = 0
  let differentColumnCounts = 0
  let widthLag = 0
  let thumbnailDistance = 0
  for (const seed of seeds) {
    const times = toggleTimes(seed)
    const frameTimes = frameTimesAt(hz, times.at(-1)! + 1500)
    const run: DrawerRun = runDrawerGrid(frameTimes, times, writeBack, source)
    const baseline = runDrawerGrid(frameTimes, times, writeBack, 'this evaluation')
    for (const [time, frame] of run.frames) {
      const other = baseline.frames.get(time)!
      frames++
      widthLag = Math.max(widthLag, Math.abs(frame.layoutWidth - other.drawnWidth))
      if (frame.layout.columnCount !== other.layout.columnCount) differentColumnCounts++
      frame.layout.lefts.forEach((left, index) => {
        thumbnailDistance = Math.max(thumbnailDistance, Math.abs(left - other.layout.lefts[index]!), Math.abs(frame.layout.tops[index]! - other.layout.tops[index]!))
      })
    }
  }
  return {frames, differentColumnCounts, widthLag, thumbnailDistance}
}

test("lag: last evaluation's width trails the drawer by up to 60 px at 60 fps and 159 px at 10 fps, and 174 px at 60 fps when only events and settle checks write back, while the springs right after their steps draw the same layout", () => {
  const sixty = lagAgainstThisEvaluation(60, 'every evaluation', 'last evaluation')
  expect(sixty.frames).toBe(3007)
  expect(sixty.differentColumnCounts).toBe(158)
  expect(sixty.widthLag).toBeCloseTo(60.31, 2)
  expect(sixty.thumbnailDistance).toBeCloseTo(532.95, 2)

  const ten = lagAgainstThisEvaluation(10, 'every evaluation', 'last evaluation')
  expect(ten.frames).toBe(505)
  expect(ten.differentColumnCounts).toBe(53)
  expect(ten.widthLag).toBeCloseTo(158.56, 2)
  expect(ten.thumbnailDistance).toBeCloseTo(611.53, 2)

  // With commits at events, the copy is as old as the last event or settle check.
  const commits = lagAgainstThisEvaluation(60, 'events and settle checks', 'last evaluation')
  expect(commits.differentColumnCounts).toBe(340)
  expect(commits.widthLag).toBeCloseTo(173.77, 2)
  expect(commits.thumbnailDistance).toBeCloseTo(640.27, 2)

  for (const hz of [60, 10]) {
    for (const writeBack of ['every evaluation', 'events and settle checks'] as const) {
      const stepped = lagAgainstThisEvaluation(hz, writeBack, 'stepped springs')
      expect({differentColumnCounts: stepped.differentColumnCounts, widthLag: stepped.widthLag, thumbnailDistance: stepped.thumbnailDistance})
        .toEqual({differentColumnCounts: 0, widthLag: 0, thumbnailDistance: 0})
    }
  }
})

import {expect, test} from 'bun:test'
import {lineFitEpsilon, loadPretext, makeParagraph, viewPrepared} from './fake-canvas.ts'
import {fastMismatches} from './fast-check.ts'
import {
  buildGatheredLines,
  buildPointerJumping,
  buildSegmentScan,
  buildSegmentWalker,
  buildSequentialLines,
  fastParagraph,
  fastWindow,
  type FastBuild,
  type FastParagraph,
} from './fast-walker.ts'
import {testFont} from './samples.ts'

const pretext = await loadPretext()
type Prepared = ReturnType<typeof pretext.prepareWithSegments>

function mismatchesOverWidths(build: FastBuild, table: Float32Array, prepared: Prepared, paragraph: FastParagraph, name: string): unknown[] {
  const failures: unknown[] = []
  for (let quarter = 640; quarter <= 1280; quarter += 6) {
    for (const offset of [0, 0.125]) {
      const problems = fastMismatches(pretext, build, table, prepared, paragraph, quarter / 4 + offset)
      if (problems.length > 0) failures.push({name, width: quarter / 4 + offset, problems: problems.slice(0, 3)})
    }
  }
  return failures
}

test('five ways to recover lines from the next-start arithmetic match pretext at 63 segments', () => {
  const prepared = pretext.prepareWithSegments(makeParagraph(32, 7), testFont)
  const paragraph = fastParagraph(prepared)
  const window = fastWindow(paragraph, 320, lineFitEpsilon)
  const lineSlots = pretext.walkLineRanges(prepared, 160, () => {})
  const options = {window, lineSlots, epsilon: lineFitEpsilon}
  const builds = {
    sequentialLines: buildSequentialLines(paragraph, options),
    gatheredLines: buildGatheredLines(paragraph, {...options, perLineWidths: false, segmentGeometry: true}),
    segmentScan: buildSegmentScan(paragraph, options),
    pointerJumping: buildPointerJumping(paragraph, options),
    segmentWalker: buildSegmentWalker(paragraph, {epsilon: lineFitEpsilon}),
  }
  // Which outputs each build has, so the comparison above isn't vacuous for any of them.
  const probe = Object.fromEntries(Object.entries(builds).map(([name, build]) => {
    const output = build.decode(build.compiled.evaluate(build.fc.source.table()))
    return [name, {starts: output.starts.length > 0, segments: output.lineIndex.length > 0, isLineStart: output.isLineStart.length > 0}]
  }))
  expect(probe).toEqual({
    sequentialLines: {starts: true, segments: false, isLineStart: false},
    gatheredLines: {starts: true, segments: true, isLineStart: false},
    segmentScan: {starts: false, segments: false, isLineStart: true},
    pointerJumping: {starts: false, segments: false, isLineStart: false},
    segmentWalker: {starts: false, segments: true, isLineStart: false},
  })
  for (const [name, build] of Object.entries(builds)) {
    expect(mismatchesOverWidths(build, build.fc.source.table(), prepared, paragraph, name)).toEqual([])
  }
})

test('a window or a line slot count too small for the text is reported', () => {
  const prepared = pretext.prepareWithSegments(makeParagraph(32, 7), testFont)
  const paragraph = fastParagraph(prepared)
  const window = fastWindow(paragraph, 320, lineFitEpsilon)
  const lineCountAt160 = pretext.walkLineRanges(prepared, 160, () => {})
  const overflowAt = (build: FastBuild, maxWidth: number) => {
    const table = build.fc.source.table()
    table[build.fc.maxWidth] = maxWidth
    const output = build.decode(build.compiled.evaluate(table))
    return {windowOverflow: output.windowOverflow > 0, moreLinesThanSlots: output.moreLinesThanSlots > 0}
  }
  // 4 line slots for 9 lines. Pointer jumping with 4 slots has 2 levels, so it counts at most 4 lines.
  const fewSlots = {window, lineSlots: 4, epsilon: lineFitEpsilon}
  expect(lineCountAt160).toBe(9)
  for (const build of [buildSequentialLines(paragraph, fewSlots), buildGatheredLines(paragraph, {...fewSlots, perLineWidths: false, segmentGeometry: false}), buildPointerJumping(paragraph, fewSlots)]) {
    expect(overflowAt(build, 160)).toEqual({windowOverflow: false, moreLinesThanSlots: true})
  }
  // A window of 6 segments, where lines at 320 px reach about 20.
  const smallWindow = {window: 6, lineSlots: lineCountAt160, epsilon: lineFitEpsilon}
  for (const build of [buildSequentialLines(paragraph, smallWindow), buildGatheredLines(paragraph, {...smallWindow, perLineWidths: false, segmentGeometry: false}), buildSegmentScan(paragraph, smallWindow), buildPointerJumping(paragraph, smallWindow)]) {
    expect(overflowAt(build, 320).windowOverflow).toBe(true)
  }
})

test('editing segment widths in the source table re-breaks the paragraph without recompiling', () => {
  const prepared = pretext.prepareWithSegments(makeParagraph(40, 11), testFont)
  const view = viewPrepared(prepared)
  const paragraph = fastParagraph(prepared)
  const original = [...paragraph.widths]
  // Words only get wider, so the window computed from the original widths still bounds every line.
  const build = buildGatheredLines(paragraph, {window: fastWindow(paragraph, 320, lineFitEpsilon), lineSlots: pretext.walkLineRanges(prepared, 160, () => {}) + 12, epsilon: lineFitEpsilon, perLineWidths: false, segmentGeometry: true})
  const table = build.fc.source.table()
  let random = 3
  const nextRandom = () => (random = (Math.imul(random, 1103515245) + 12345) >>> 0) / 2 ** 32
  const failures: unknown[] = []
  for (let trial = 0; trial < 40; trial++) {
    const edited = original.map((width, j) => paragraph.breakAfter[j] === 1 ? width : width + Math.floor(nextRandom() * 96) / 4)
    // pretext's walker reads the prepared widths directly, so the reference sees the same edit.
    edited.forEach((width, j) => {
      view.widths[j] = width
      table[build.fc.widthCells[j]!] = width
    })
    const maxWidth = Math.floor(160 * 4 + nextRandom() * 640) / 4
    const problems = fastMismatches(pretext, build, table, prepared, {...paragraph, widths: edited}, maxWidth)
    if (problems.length > 0) failures.push({trial, maxWidth, problems: problems.slice(0, 3)})
  }
  expect(failures).toEqual([])
})

test('runs of break-after segments longer than the run limit set runOverflow; a larger runLimit takes other break-after bits without recompiling', () => {
  // Every fourth word is followed by a space and two zero-width spaces, so the paragraph has runs of 3 break-after segments.
  const words = makeParagraph(31, 7).split(' ')
  const text = words.map((word, index) => index === words.length - 1 ? word : word + (index % 4 === 1 ? ' ​​' : ' ')).join('')
  const prepared = pretext.prepareWithSegments(text, testFont)
  const paragraph = fastParagraph(prepared)
  // Another paragraph with the same segment count and widths, whose runs are 1 long: the zero-width spaces don't break.
  const otherParagraph = {widths: paragraph.widths, breakAfter: paragraph.breakAfter.map((bit, j) => bit === 1 && paragraph.breakAfter[j - 1] === 1 ? 0 : bit)}
  const window = fastWindow(paragraph, 320, lineFitEpsilon)
  const lineSlots = pretext.walkLineRanges(prepared, 160, () => {})
  const withRealBits = (build: FastBuild) => {
    const table = build.fc.source.table()
    paragraph.breakAfter.forEach((bit, j) => { table[build.fc.breakAfterCells[j]!] = bit })
    return table
  }
  const buildAll = (runLimit: number | null) => {
    const options = runLimit === null ? {window, lineSlots, epsilon: lineFitEpsilon} : {window, lineSlots, epsilon: lineFitEpsilon, runLimit}
    return {
      sequentialLines: buildSequentialLines(otherParagraph, options),
      gatheredLines: buildGatheredLines(otherParagraph, {...options, perLineWidths: false, segmentGeometry: true}),
      segmentScan: buildSegmentScan(otherParagraph, options),
      pointerJumping: buildPointerJumping(otherParagraph, options),
    }
  }
  // runOverflow counts the positions where a run longer than the limit starts: two per run of 3 with limit 1.
  const longerRunStarts = paragraph.breakAfter.filter((bit, j) => bit === 1 && paragraph.breakAfter[j + 1] === 1).length
  expect(longerRunStarts).toBe(16)
  // Built with the default run limit of the other paragraph (1), the circuits report the real runs.
  for (const [name, build] of Object.entries(buildAll(null))) {
    expect({name, runLimit: build.fc.runLimit}).toEqual({name, runLimit: 1})
    const table = withRealBits(build)
    table[build.fc.maxWidth] = 240
    expect({name, runOverflow: build.decode(build.compiled.evaluate(table)).runOverflow}).toEqual({name, runOverflow: longerRunStarts})
  }
  // Built from the other paragraph with runLimit 3, the circuits match pretext on the real bits.
  const failures: unknown[] = []
  for (const [name, build] of Object.entries({...buildAll(3), segmentWalker: buildSegmentWalker(otherParagraph, {epsilon: lineFitEpsilon})})) {
    failures.push(...mismatchesOverWidths(build, withRealBits(build), prepared, paragraph, name))
  }
  expect(failures).toEqual([])
})

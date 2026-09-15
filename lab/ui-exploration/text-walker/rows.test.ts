import {expect, test} from 'bun:test'
import {lineFitEpsilon, loadPretext, viewPrepared} from './fake-canvas.ts'
import {buildUnits, evaluateUnitRow, unitRow} from './rows.ts'
import {buildRowTable, buildRowsCircuit} from './rows-circuit.ts'
import {ladderSamples, testFont, type LadderSample} from './samples.ts'

const pretext = await loadPretext()

function nextRandomFrom(seed: number) {
  let random = seed
  return () => (random = (Math.imul(random, 1103515245) + 12345) >>> 0) / 2 ** 32
}

function randomWidth(sample: LadderSample, nextRandom: () => number, trial: number) {
  return Math.floor(sample.minWidth * 4 + nextRandom() * (sample.maxWidth - sample.minWidth) * 4) / 4 + (trial % 2 === 0 ? 0 : 0.125)
}

test.each(ladderSamples.map(sample => [sample.step, sample] as const))('rows restated from the walker match pretext: %s', (_, sample) => {
  const prepared = pretext.prepareWithSegments(sample.text, testFont, sample.options)
  const view = viewPrepared(prepared)
  const options = {emergencyFromWidth: sample.minWidth}
  const units = buildUnits(view, options)
  const rows = Array.from({length: units.count + 1}, (_, unit) => unitRow(view, units, unit, options))
  const failures: unknown[] = []
  const stride = Math.max(1, Math.floor((sample.maxWidth - sample.minWidth) * 4 / 300))
  for (let quarter = sample.minWidth * 4; quarter <= sample.maxWidth * 4; quarter += stride) {
    for (const offset of [0, 0.125]) {
      const width = quarter / 4 + offset
      const expected: number[][] = []
      pretext.walkLineRanges(prepared, width, line => expected.push([units.index(line.start), units.index(line.end), line.width]))
      const actual: number[][] = []
      for (let unit = 0; ;) {
        const outcome = evaluateUnitRow(rows[unit]!, width, lineFitEpsilon)
        if (outcome.lineStart === units.count) break
        actual.push([outcome.lineStart, outcome.end, Math.max(0, outcome.width)])
        unit = outcome.next
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({width, expected: expected.slice(0, 4), actual: actual.slice(0, 4)})
    }
  }
  const nextRandom = nextRandomFrom(12345)
  for (let trial = 0; trial < 60; trial++) {
    let cursor = {segmentIndex: 0, graphemeIndex: 0}
    let unit = 0
    for (let line = 0; line < 200; line++) {
      const width = randomWidth(sample, nextRandom, trial)
      const range = pretext.layoutNextLineRange(prepared, cursor, width)
      const outcome = evaluateUnitRow(rows[unit]!, width, lineFitEpsilon)
      const expected = range === null ? [units.count] : [units.index(range.start), units.index(range.end), range.width]
      const actual = outcome.lineStart === units.count ? [units.count] : [outcome.lineStart, outcome.end, Math.max(0, outcome.width)]
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({trial, line, width, expected, actual})
      if (range === null) break
      cursor = range.end
      unit = outcome.next
    }
  }
  expect(failures).toEqual([])
})

test('the rows circuit walks per-line widths like sequential layoutNextLineRange calls', () => {
  for (const step of ['soft hyphens', 'all features together']) {
    const sample = ladderSamples.find(candidate => candidate.step === step)!
    const prepared = pretext.prepareWithSegments(sample.text, testFont, sample.options)
    const table = buildRowTable(viewPrepared(prepared), {emergencyFromWidth: sample.minWidth, maximumWidth: sample.maxWidth, epsilon: lineFitEpsilon})
    const lineSlots = pretext.walkLineRanges(prepared, sample.minWidth, () => {}) + 2
    const build = buildRowsCircuit(table, {lineSlots, epsilon: lineFitEpsilon, perLineWidths: true})
    const source = build.source.table()
    const nextRandom = nextRandomFrom(777)
    const failures: unknown[] = []
    for (let trial = 0; trial < 40; trial++) {
      const widths = build.lineWidthCells.map(() => randomWidth(sample, nextRandom, trial))
      widths.forEach((width, line) => { source[build.lineWidthCells[line]!] = width })
      const expected: number[][] = []
      let cursor = {segmentIndex: 0, graphemeIndex: 0}
      for (const width of widths) {
        const range = pretext.layoutNextLineRange(prepared, cursor, width)
        if (range === null) break
        expected.push([table.units.index(range.start), table.units.index(range.end), Math.fround(range.width)])
        cursor = range.end
      }
      while (expected.length < lineSlots) expected.push([table.units.count, table.units.count, 0])
      const output = build.decode(build.compiled.evaluate(source))
      const actual = output.lines.map(line => [line.start, line.end, line.width])
      if (output.moreLinesThanSlots !== 0 || JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({step, trial, expected: expected.slice(0, 4), actual: actual.slice(0, 4)})
    }
    expect(failures).toEqual([])
  }
})

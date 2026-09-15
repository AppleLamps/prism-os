// Heavy measurements behind README.md. Prints markdown tables.
//   bun lab/ui-exploration/text-tabulated/report.ts [corpora] [hn] [oracle] [long] [rich] [prewrap] [notes] [edit] [scale] [nondyadic]
// No arguments runs every section, with nondyadic in a second process. Corpora and pretext's test data
// are read from the pretext clone in the session scratchpad; the HN thread from
// ~/github/vibescript/demos/nicer-hacker-news/data.ts.

import type {Wire} from '../../../numeric-ui-core.ts'
import {installFakeCanvas} from './fake-canvas.ts'
import {createRandom, nextFloat32Down, nextFloat32Up} from './float32.ts'
import {layout, layoutWithLines, measureLineStats, prepareWithSegments, type PrepareOptions} from './pretext/layout.ts'
import {measureRichInlineStats, prepareRichInline, walkRichInlineLineRanges, type PreparedRichInline, type RichInlineItem} from './pretext/rich-inline.ts'
import {measureBlock, pieceAt, restrictTable, tableStats, tabulateBlock, tabulateOverWidths, type BlockSpec, type BlockTable} from './tabulate.ts'
import {SourceLayout, allocateBlockGatherCells, emitAtLeast, emitAtLeastScaled, emitBlockDeltaRows, emitDeltaRow, programStats, type BlockOutputs} from './step-circuit.ts'
import {createNotesMachine, notesLayout, outputsFor, prepareNotesBlocks} from './notes-machine.ts'
import {checkNotesTraces} from './notes-trace-check.ts'
import {emitMatrixSpring, emitStepMatrix, stepBitCount} from './springs.ts'
import {referenceBlock} from './reference.ts'
import {notesContent} from './notes-content.ts'

const pretextCopy = 'scratchpad/pretext-copy'
const hnDataPath = '~/github/vibescript/demos/nicer-hacker-news/data.ts'
const requested = new Set(process.argv.slice(2))
// The nondyadic section measures with a different fake canvas, and pretext keeps the canvas it first
// measures with, so that section runs on its own.
const nonDyadic = requested.has('nondyadic')
if (nonDyadic && requested.size > 1) throw new Error('run the nondyadic section on its own')
installFakeCanvas('blink', {nonDyadic})
const runSection = (name: string) => requested.size === 0 ? name !== 'nondyadic' : requested.has(name)

// ---------------------------------------------------------------- helpers

function markdown(headers: string[], rows: (string | number)[][]) {
  console.log(`| ${headers.join(' | ')} |`)
  console.log(`| ${headers.map(() => '---').join(' | ')} |`)
  for (const row of rows) console.log(`| ${row.map(cell => typeof cell === 'number' ? cell.toLocaleString('en-US') : cell).join(' | ')} |`)
  console.log('')
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

function medianMicroseconds(run: () => void, iterations: number): number {
  const samples: number[] = []
  for (let sample = 0; sample < 5; sample++) {
    for (let warm = 0; warm < Math.min(50, iterations); warm++) run()
    const started = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) run()
    samples.push((performance.now() - started) * 1000 / iterations)
  }
  return percentile(samples, 0.5)
}

const heightsOutputs: BlockOutputs = {lineCount: true, maxLineWidth: false, layoutWidth: false, cursors: false, lineWidths: false}
const statsOutputs: BlockOutputs = {lineCount: true, maxLineWidth: true, layoutWidth: false, cursors: false, lineWidths: false}
const paintOutputs: BlockOutputs = {lineCount: true, maxLineWidth: false, layoutWidth: false, cursors: true, lineWidths: false}

// One circuit holding every table, all reading one shared width cell, so a threshold that several tables
// have becomes one comparison. With `widthPerTable`, every table reads its own width cell instead, so no
// comparison is shared. That is the size to expect when thresholds of different paragraphs don't
// coincide, as with real fonts.
function sharedWidthCircuit(tables: readonly BlockTable[], outputs: BlockOutputs, widthPerTable = false) {
  const source = new SourceLayout()
  const width = source.cell('width', 300, 0, 8192)
  const tableWidths = widthPerTable ? tables.map((_, index) => source.cell(`width${index}`, 300, 0, 8192)) : []
  const circuit = source.createCircuit()
  const roots: Wire[] = []
  tables.forEach((original, index) => {
    const table = outputs.cursors || outputs.lineWidths ? original : restrictTable(original, {maxLineWidth: outputs.maxLineWidth, layoutWidth: outputs.layoutWidth})
    const wires = emitBlockDeltaRows(circuit, widthPerTable ? tableWidths[index]! : width, table, outputs)
    for (const wire of [wires.lineCount, wires.maxLineWidth, wires.layoutWidth, ...wires.starts, ...wires.ends, ...wires.lineWidths]) if (wire !== null) roots.push(wire)
  })
  return {source, width, circuit, roots, stats: programStats(circuit, roots)}
}

// Circuit sizes for many paragraph tables at once, with comparisons shared across paragraphs and without.
function sharingSizes(tables: readonly BlockTable[], withPainting: boolean) {
  const lineCountThresholds = tables.flatMap(table => restrictTable(table, {maxLineWidth: false, layoutWidth: false}).thresholds)
  return {
    distinctLineCountThresholds: new Set(lineCountThresholds).size,
    heights: sharedWidthCircuit(tables, heightsOutputs).stats,
    heightsPerTable: sharedWidthCircuit(tables, heightsOutputs, true).stats,
    painting: withPainting ? sharedWidthCircuit(tables, paintOutputs).stats : null,
    paintingPerTable: withPainting ? sharedWidthCircuit(tables, paintOutputs, true).stats : null,
  }
}

const plainSpec = (text: string, font: string, options?: PrepareOptions): BlockSpec => ({prepared: prepareWithSegments(text, font, options), mode: 'plain', maxWidthAt: width => width})

function decodeHnHtml(html: string) {
  return html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&#x2F;', '/')
    .replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')
}

// ---------------------------------------------------------------- realistic content

async function corporaSection() {
  console.log('## pretext corpora, one table per paragraph, widths 300..900\n')
  const sources = JSON.parse(await Bun.file(`${pretextCopy}/corpora/sources.json`).text()) as {id: string, font_size_px: number, min_width: number, max_width: number, output: string}[]
  const rows: (string | number)[][] = []
  const totals = {paragraphs: 0, lineCountThresholds: 0, distinctLineCountThresholds: 0, thresholds: 0, heightsLiveOperations: 0, heightsPerTableLiveOperations: 0}
  for (const source of sources) {
    const text = await Bun.file(`${pretextCopy}/${source.output}`).text()
    const paragraphs = text.split(/\n+/).map(paragraph => paragraph.trim()).filter(paragraph => paragraph.length > 0)
    const font = `${source.font_size_px}px Test Sans`
    const started = performance.now()
    const tables = paragraphs.map(paragraph => tabulateBlock(plainSpec(paragraph, font), source.min_width, source.max_width, 1))
    const seconds = (performance.now() - started) / 1000
    const stats = tables.map(tableStats)
    const sizes = sharingSizes(tables, true)
    totals.paragraphs += paragraphs.length
    totals.lineCountThresholds += sum(stats.map(entry => entry.lineCountChanges))
    totals.distinctLineCountThresholds += sizes.distinctLineCountThresholds
    totals.thresholds += sum(stats.map(entry => entry.thresholds))
    totals.heightsLiveOperations += sizes.heights.liveOperations
    totals.heightsPerTableLiveOperations += sizes.heightsPerTable.liveOperations
    rows.push([
      source.id,
      paragraphs.length,
      text.length,
      `${sum(stats.map(entry => entry.lineCountChanges))} / ${percentile(stats.map(entry => entry.lineCountChanges), 1)}`,
      sizes.distinctLineCountThresholds,
      `${sum(stats.map(entry => entry.thresholds))} / ${percentile(stats.map(entry => entry.thresholds), 1)}`,
      `${sizes.heights.liveOperations} / ${sizes.heights.layers} / ${sizes.heights.storedWeights}`,
      `${sizes.heightsPerTable.liveOperations} / ${sizes.heightsPerTable.storedWeights}`,
      `${sizes.painting!.liveOperations} / ${sizes.painting!.storedWeights}`,
      sizes.paintingPerTable!.liveOperations,
      seconds.toFixed(1),
    ])
  }
  markdown(['corpus', 'paragraphs', 'characters', 'line count thresholds: total / most in one paragraph', 'distinct line count threshold values', 'all thresholds (painting): total / most', 'heights circuit: live ops / layers / weights', 'heights circuit, one width cell per paragraph: live ops / weights', 'painting circuit: live ops / weights', 'painting circuit, one width cell per paragraph: live ops', 'tabulate s'], rows)
  console.log(JSON.stringify(totals), '\n')
}

async function hnSection() {
  console.log('## nicer-hacker-news threads: one table per comment paragraph, window widths 375..1200\n')
  const {dataRaw} = await import(hnDataPath) as {dataRaw: {title: string, comments: {indent: number, comment: string}[]}[]}
  const rows: (string | number)[][] = []
  for (const thread of dataRaw) {
    const tables: BlockTable[] = []
    let characters = 0
    const started = performance.now()
    for (const comment of thread.comments) {
      const paragraphs = comment.comment.split(/<p>/).map(decodeHnHtml).filter(text => text.trim() !== '')
      for (const text of paragraphs) {
        characters += text.length
        const indentWidth = comment.indent * 24 + 24 + 20
        tables.push(tabulateBlock({prepared: prepareWithSegments(text, '12px Verdana, Geneva, sans-serif'), mode: 'plain', maxWidthAt: width => width - indentWidth}, 375, 1200, 1))
      }
    }
    const seconds = (performance.now() - started) / 1000
    const stats = tables.map(tableStats)
    const sizes = sharingSizes(tables, true)
    rows.push([
      thread.title.slice(0, 40),
      thread.comments.length,
      tables.length,
      characters,
      `${sum(stats.map(entry => entry.lineCountChanges))} / ${percentile(stats.map(entry => entry.lineCountChanges), 1)}`,
      sizes.distinctLineCountThresholds,
      `${sum(stats.map(entry => entry.thresholds))} / ${percentile(stats.map(entry => entry.thresholds), 1)}`,
      `${sizes.heights.liveOperations} / ${sizes.heights.layers} / ${sizes.heights.storedWeights}`,
      `${sizes.heightsPerTable.liveOperations} / ${sizes.heightsPerTable.storedWeights}`,
      `${sizes.painting!.liveOperations} / ${sizes.painting!.storedWeights}`,
      `${sizes.paintingPerTable!.liveOperations} / ${sizes.paintingPerTable!.storedWeights}`,
      seconds.toFixed(1),
    ])
  }
  markdown(['thread', 'comments', 'paragraphs', 'characters', 'line count thresholds: total / most', 'distinct line count threshold values', 'all thresholds: total / most', 'heights circuit: live ops / layers / weights', 'heights circuit, one width cell per paragraph: live ops / weights', 'painting circuit: live ops / weights', 'painting circuit, one width cell per paragraph: live ops / weights', 'tabulate s'], rows)
}

type OracleCase = {group: string, text: string, font: string, options: PrepareOptions}

// pretext's own edge-case data: TEXTS plus the oracle cases (soft hyphens, letter spacing, pre-wrap,
// symbols, keep-all).
async function loadOracleCases(): Promise<OracleCase[]> {
  const data = await import(`${pretextCopy}/src/test-data.ts`) as Record<string, unknown>
  const cases: OracleCase[] = []
  for (const entry of data['TEXTS'] as {text: string}[]) cases.push({group: 'TEXTS', text: entry.text, font: '16px Test Sans', options: {}})
  for (const name of ['DISCRETIONARY_ORACLE_CASES', 'LETTER_SPACING_ORACLE_CASES', 'PRE_WRAP_ORACLE_CASES', 'SYMBOL_ORACLE_CASES', 'KEEP_ALL_ORACLE_CASES']) {
    for (const entry of data[name] as {text: string, font: string, letterSpacing?: number, whiteSpace?: 'normal' | 'pre-wrap', wordBreak?: 'normal' | 'keep-all'}[]) {
      const options: PrepareOptions = {}
      if (entry.letterSpacing !== undefined) options.letterSpacing = entry.letterSpacing
      if (entry.whiteSpace !== undefined) options.whiteSpace = entry.whiteSpace
      if (entry.wordBreak !== undefined) options.wordBreak = entry.wordBreak
      cases.push({group: name, text: entry.text, font: entry.font.replace(/\d+(\.\d+)?px/, match => match), options})
    }
  }
  return cases
}

type GroupResult = {cases: number, thresholds: number, checked: number, decisionMismatches: number, deltaWidthsNotBitEqual: number, deltaMaximumDrift: number, gatheredMismatches: number}

// Tabulates every case over widths 2..700, then compares delta rows and gathered rows with pretext at
// every threshold, one ulp on either side, and 100 random widths.
function checkTablesAgainstPretext(cases: readonly OracleCase[]): Map<string, GroupResult> {
  const byGroup = new Map<string, GroupResult>()
  const random = createRandom(5)
  for (const testCase of cases) {
    const spec = plainSpec(testCase.text, testCase.font, testCase.options)
    if (spec.prepared.segments.length === 0) continue
    const table = tabulateBlock(spec, 2, 700, 1)
    const outputs: BlockOutputs = {lineCount: true, maxLineWidth: true, layoutWidth: false, cursors: true, lineWidths: true}
    // Delta rows (weights) and gathered rows (cells) for the same table.
    const {source, width, circuit, roots} = sharedWidthCircuit([table], outputs)
    const evaluate = circuit.createTensorEvaluator(roots)
    const input = source.table()
    const gatherSource = new SourceLayout()
    const gatherWidth = gatherSource.cell('width', 300, 0, 8192)
    const allocation = allocateBlockGatherCells(gatherSource, 'block', table, outputs)
    const gatherCircuit = gatherSource.createCircuit()
    const gatherWires = allocation.emit(gatherCircuit, gatherWidth)
    const gatherRoots = [gatherWires.lineCount!, gatherWires.maxLineWidth!, ...gatherWires.starts, ...gatherWires.ends, ...gatherWires.lineWidths]
    const evaluateGathered = gatherCircuit.createTensorEvaluator(gatherRoots)
    const gatherInput = gatherSource.table()
    const widths: number[] = []
    for (const threshold of table.thresholds) widths.push(threshold, nextFloat32Down(threshold), nextFloat32Up(threshold))
    for (let trial = 0; trial < 100; trial++) widths.push(Math.fround(2 + random() * 698))
    const result = byGroup.get(testCase.group) ?? {cases: 0, thresholds: 0, checked: 0, decisionMismatches: 0, deltaWidthsNotBitEqual: 0, deltaMaximumDrift: 0, gatheredMismatches: 0}
    for (const testWidth of widths) {
      input[width] = testWidth
      gatherInput[gatherWidth] = testWidth
      const actual = evaluate(input)
      const gathered = evaluateGathered(gatherInput)
      const direct = measureBlock(spec, testWidth)
      const stats = measureLineStats(spec.prepared, testWidth)
      // Same order as sharedWidthCircuit's roots: line count, max width, every start, every end, every width.
      const idOf = (segmentIndex: number, graphemeIndex: number) => table.cursors.findIndex(cursor => cursor.segmentIndex === segmentIndex && cursor.graphemeIndex === graphemeIndex)
      const endId = table.cursors.length - 1
      const slots = Array.from({length: table.slotCount}, (_, slot) => direct.lines[slot])
      const expected = [
        stats.lineCount,
        stats.maxLineWidth,
        ...slots.map(line => line === undefined ? endId : idOf(line.startSegment, line.startGrapheme)),
        ...slots.map(line => line === undefined ? endId : idOf(line.endSegment, line.endGrapheme)),
        ...slots.map(line => line?.width ?? 0),
      ]
      // Decisions: line count and cursor ids (every output that isn't a width).
      const widthIndex = (index: number) => index === 1 || index >= 2 + 2 * table.slotCount
      const decisionWrong = direct.lines.length > table.slotCount || expected.some((value, index) => !widthIndex(index) && value !== actual[index])
      if (decisionWrong) result.decisionMismatches++
      let widthsBitEqual = true
      expected.forEach((value, index) => {
        if (!widthIndex(index)) return
        const drift = Math.abs(actual[index]! - Math.fround(value))
        if (drift !== 0) widthsBitEqual = false
        result.deltaMaximumDrift = Math.max(result.deltaMaximumDrift, drift)
      })
      if (!widthsBitEqual) result.deltaWidthsNotBitEqual++
      if (direct.lines.length > table.slotCount || expected.some((value, index) => Math.fround(value) !== gathered[index])) result.gatheredMismatches++
    }
    result.cases++
    result.thresholds += table.thresholds.length
    result.checked += widths.length
    byGroup.set(testCase.group, result)
  }
  return byGroup
}

function printOracleTable(byGroup: Map<string, GroupResult>) {
  markdown(
    ['group', 'cases', 'thresholds', 'widths checked', 'wrong line counts or cursors', 'delta rows: widths with a width output not bit-equal', 'delta rows: largest width drift (px)', 'gathered rows: widths not bit-equal on any output'],
    [...byGroup].map(([group, entry]) => [group, entry.cases, entry.thresholds, entry.checked, entry.decisionMismatches, entry.deltaWidthsNotBitEqual, entry.deltaMaximumDrift.toExponential(2), entry.gatheredMismatches]),
  )
}

async function oracleSection() {
  console.log("## pretext's test data as tables, checked against pretext\n")
  printOracleTable(checkTablesAgainstPretext(await loadOracleCases()))
}

// ---------------------------------------------------------------- limits

async function longSection() {
  console.log('## one long paragraph (The Great Gatsby, first N words), widths 300..900, 16px\n')
  const gatsby = await Bun.file(`${pretextCopy}/corpora/en-gatsby-opening.txt`).text()
  const words = gatsby.split(/\s+/).filter(word => word.length > 0)
  const rows: (string | number)[][] = []
  for (const wordCount of [64, 256, 1024, 4096]) {
    const text = words.slice(0, wordCount).join(' ')
    const spec = plainSpec(text, '16px Test Sans')
    const table = tabulateBlock(spec, 300, 900, 1)
    const stats = tableStats(table)
    const heights = sharedWidthCircuit([table], heightsOutputs).stats
    const lineStats = sharedWidthCircuit([table], statsOutputs).stats
    const painting = sharedWidthCircuit([table], paintOutputs).stats
    const gatherCells = (table.thresholds.length + 1) * (1 + 2 * table.slotCount) + table.thresholds.length
    rows.push([
      wordCount,
      text.length,
      spec.prepared.segments.length,
      Math.round(table.tabulateMilliseconds),
      table.measureCalls,
      stats.lineCountChanges,
      stats.maxLineWidthChanges,
      stats.thresholds,
      stats.slotCount,
      stats.startChanges + stats.endChanges,
      `${heights.liveOperations} / ${heights.storedWeights}`,
      `${lineStats.liveOperations} / ${lineStats.storedWeights}`,
      `${painting.liveOperations} / ${painting.storedWeights}`,
      gatherCells,
    ])
  }
  markdown(['words', 'characters', 'segments', 'tabulate ms', 'layout calls', 'line count thresholds', 'maxLineWidth changes', 'all thresholds', 'line slots', 'cursor changes (start + end)', 'heights: live ops / weights', 'line count + maxLineWidth: live ops / weights', 'painting: live ops / weights', 'painting as gathered cells'], rows)
}

type RichSample = {lineCount: number, maxLineWidth: number, ends: number[], widths: number[]}

function measureRich(flow: PreparedRichInline, width: number): RichSample {
  const ends: number[] = []
  const widths: number[] = []
  walkRichInlineLineRanges(flow, width, line => {
    ends.push(line.end.itemIndex * 1_000_000 + line.end.segmentIndex * 1_000 + line.end.graphemeIndex)
    widths.push(line.width)
  })
  const stats = measureRichInlineStats(flow, width)
  return {lineCount: stats.lineCount, maxLineWidth: stats.maxLineWidth, ends, widths}
}

const sameRich = (left: RichSample, right: RichSample) =>
  left.lineCount === right.lineCount && left.maxLineWidth === right.maxLineWidth && left.ends.length === right.ends.length
  && left.ends.every((end, index) => end === right.ends[index]) && left.widths.every((width, index) => width === right.widths[index])

function richSection() {
  console.log('## rich inline with chips and code spans, widths 40..700\n')
  const body = '500 17px Test Sans'
  const code = '600 14px Test Mono'
  const chip = '700 12px Test Sans'
  const flows: {name: string, items: RichInlineItem[]}[] = [
    {name: 'phase 1 rich note (15 items)', items: [
      {text: 'Ship ', font: body}, {text: '@maya', font: chip, break: 'never', extraWidth: 22}, {text: "'s ", font: body},
      {text: 'rich-note', font: code, extraWidth: 14}, {text: ' card once ', font: body}, {text: 'pre-wrap', font: code, extraWidth: 14},
      {text: ' lands. Status ', font: body}, {text: 'blocked', font: chip, break: 'never', extraWidth: 22}, {text: ' by ', font: body},
      {text: 'vertical text', font: '600 17px Test Sans'}, {text: ' research, but 北京 copy and QA are both green. Keep ', font: body},
      {text: 'layoutNextLine()', font: code, extraWidth: 14}, {text: ' public, tag this ', font: body}, {text: 'P1', font: chip, break: 'never', extraWidth: 22}, {text: '.', font: body},
    ]},
    {name: 'chat message (24 items)', items: [
      {text: 'Thanks ', font: body}, {text: '@nora', font: chip, break: 'never', extraWidth: 22}, {text: '! I pushed the fix to ', font: body},
      {text: 'measureRichInlineStats()', font: code, extraWidth: 14}, {text: ' and the ', font: body}, {text: 'bubbles', font: code, extraWidth: 14},
      {text: ' demo now shrink-wraps again. Two follow-ups: ', font: body}, {text: 'perf', font: chip, break: 'never', extraWidth: 22},
      {text: ' the resize path still calls ', font: body}, {text: 'layout()', font: code, extraWidth: 14}, {text: ' per bubble, and ', font: body},
      {text: 'a11y', font: chip, break: 'never', extraWidth: 22}, {text: ' we should expose the tight width to screen readers. See ', font: body},
      {text: 'https://example.com/issues/2231', font: code, extraWidth: 14}, {text: ' before Friday; ', font: body}, {text: '@kenji', font: chip, break: 'never', extraWidth: 22},
      {text: ' owns the Safari side, ', font: body}, {text: '@mina', font: chip, break: 'never', extraWidth: 22}, {text: ' owns QA.', font: body},
      {text: ' ETA ', font: body}, {text: 'Thu', font: chip, break: 'never', extraWidth: 22}, {text: ' 👍', font: body}, {text: ' ', font: body}, {text: 'done', font: chip, break: 'never', extraWidth: 22},
    ]},
  ]
  const rows: (string | number)[][] = []
  for (const flowCase of flows) {
    const flow = prepareRichInline(flowCase.items)
    const from = 40
    const to = 700
    const started = performance.now()
    const steps = tabulateOverWidths(width => measureRich(flow, width), sameRich, from, to, 1)
    const tabulateMilliseconds = performance.now() - started
    // Every candidate interval on the 1/64 px grid (fonts 17, 14 and 12 px; integer extra widths).
    const exhaustiveWidths: number[] = []
    for (let g = from; g <= to; g += 1 / 64) exhaustiveWidths.push(g - 0.0025, g + 1 / 128)
    let exhaustiveChanges = 0
    let lineCountIncreases = 0
    let previous: RichSample | null = null
    let tableMismatches = 0
    let farthestMismatch = 0
    const exhaustiveStarted = performance.now()
    for (const width of exhaustiveWidths) {
      const sample = measureRich(flow, width)
      if (previous !== null && !sameRich(previous, sample)) exhaustiveChanges++
      if (previous !== null && sample.lineCount > previous.lineCount) lineCountIncreases++
      previous = sample
      const piece = pieceAt(steps.thresholds, width)
      if (!sameRich(steps.samples[piece]!, sample)) {
        tableMismatches++
        const distance = Math.min(...steps.thresholds.map(threshold => Math.abs(threshold - width)))
        farthestMismatch = Math.max(farthestMismatch, distance)
      }
    }
    const exhaustiveMilliseconds = performance.now() - exhaustiveStarted
    // Painting circuit: line count, max width, each line's end cursor and width.
    const slotCount = Math.max(...steps.samples.map(sample => sample.ends.length))
    const source = new SourceLayout()
    const width = source.cell('width', 300, 0, 8192)
    const circuit = source.createCircuit()
    const bits = steps.thresholds.map(threshold => emitAtLeast(circuit, width, threshold))
    const roots = [emitDeltaRow(circuit, bits, steps.samples.map(sample => sample.lineCount)), emitDeltaRow(circuit, bits, steps.samples.map(sample => sample.maxLineWidth))]
    for (let slot = 0; slot < slotCount; slot++) {
      roots.push(emitDeltaRow(circuit, bits, steps.samples.map(sample => sample.ends[slot] ?? -1)))
      roots.push(emitDeltaRow(circuit, bits, steps.samples.map(sample => sample.widths[slot] ?? 0)))
    }
    const stats = programStats(circuit, roots)
    const lineCountThresholds = steps.samples.filter((sample, index) => index > 0 && sample.lineCount !== steps.samples[index - 1]!.lineCount).length
    rows.push([
      flowCase.name,
      Math.round(tabulateMilliseconds),
      lineCountThresholds,
      steps.thresholds.length,
      exhaustiveChanges,
      lineCountIncreases,
      `${tableMismatches} of ${exhaustiveWidths.length}`,
      farthestMismatch.toFixed(4),
      `${stats.liveOperations} / ${stats.layers} / ${stats.storedWeights}`,
      Math.round(exhaustiveMilliseconds),
    ])
  }
  markdown(['flow', 'tabulate ms (1px sampling)', 'line count thresholds', 'all thresholds', 'layout changes on the exhaustive 1/64px sweep', 'line count increases on that sweep', 'widths where the table disagrees with pretext', 'farthest disagreement from a threshold (px)', 'painting circuit: live ops / layers / weights', 'exhaustive sweep ms'], rows)
}

function prewrapSection() {
  console.log('## pre-wrap text with tabs and newlines, widths 40..800, 13px\n')
  const texts = [
    {name: 'tab-separated table', text: 'name\tvalue\tunit\nwidth\t320\tpx\nheight\t20\tpx\nline height\t1.4\t\nletter spacing\t0.5\tpx\nfont\tHelvetica Neue, Arial\t\npadding\t12 16\tpx\n'},
    {name: 'code block', text: 'function layoutBubble(prepared, maxWidth) {\n\tconst initial = collectWrapMetrics(prepared, maxWidth)\n\tlet lo = 1\n\tlet hi = Math.max(1, Math.ceil(maxWidth))\n\twhile (lo < hi) {\n\t\tconst mid = Math.floor((lo + hi) / 2)\n\t\tif (layout(prepared, mid, 20).lineCount <= initial.lineCount) hi = mid\n\t\telse lo = mid + 1\n\t}\n\treturn collectWrapMetrics(prepared, lo)\n}\n'},
    {name: 'chat log with blank lines', text: 'Nora:\tplease keep 10 000 rows visible\n\nMina:\ttrans­atlantic labels are still weird\n\n\nKenji:\t「了解です」 before pasting 価格は¥12,800です\n'},
  ]
  const rows: (string | number)[][] = []
  const random = createRandom(9)
  for (const entry of texts) {
    const spec = plainSpec(entry.text, '13px Test Mono', {whiteSpace: 'pre-wrap'})
    const table = tabulateBlock(spec, 40, 800, 1)
    const stats = tableStats(table)
    const outputs: BlockOutputs = {lineCount: true, maxLineWidth: true, layoutWidth: false, cursors: true, lineWidths: true}
    const {source, width, circuit, roots, stats: circuitStats} = sharedWidthCircuit([table], outputs)
    const evaluate = circuit.createTensorEvaluator(roots)
    const input = source.table()
    let mismatches = 0
    const widths: number[] = []
    for (const threshold of table.thresholds) widths.push(threshold, nextFloat32Down(threshold))
    for (let trial = 0; trial < 1000; trial++) widths.push(Math.fround(40 + random() * 760))
    for (const testWidth of widths) {
      input[width] = testWidth
      const actual = evaluate(input)
      const direct = layoutWithLines(spec.prepared, testWidth, 20)
      if (actual[0] !== direct.lineCount || actual[1] !== Math.fround(measureLineStats(spec.prepared, testWidth).maxLineWidth)) mismatches++
    }
    rows.push([entry.name, entry.text.length, stats.lineCountChanges, stats.thresholds, stats.slotCount, `${circuitStats.liveOperations} / ${circuitStats.storedWeights}`, `${mismatches} of ${widths.length}`])
  }
  markdown(['text', 'characters', 'line count thresholds', 'all thresholds', 'line slots', 'painting circuit: live ops / weights', 'line count or max width mismatches'], rows)
}

// ---------------------------------------------------------------- the Notes machine

function notesSection() {
  console.log('## the Notes window\n')
  const started = performance.now()
  const blocks = prepareNotesBlocks()
  const tabulateMilliseconds = performance.now() - started
  markdown(['block', 'characters', 'thresholds', 'line count thresholds', 'line slots', 'cursor changes', 'tabulate ms'], blocks.map(block => {
    const stats = tableStats(block.table)
    return [block.kind, block.text.length, stats.thresholds, stats.lineCountChanges, stats.slotCount, stats.startChanges + stats.endChanges, block.table.tabulateMilliseconds.toFixed(1)]
  }))
  const buildStarted = performance.now()
  const machine = createNotesMachine(blocks)
  const buildMilliseconds = performance.now() - buildStarted
  const whole = machine.stats()
  // Components on their own.
  const textOnly = (() => {
    const source = new SourceLayout()
    const width = source.cell('width', 300, 0, 8192)
    const circuit = source.createCircuit()
    const roots: Wire[] = []
    for (const block of blocks) {
      const wires = emitBlockDeltaRows(circuit, width, block.table, outputsFor(block.kind))
      for (const wire of [wires.lineCount, wires.maxLineWidth, wires.layoutWidth, ...wires.starts, ...wires.ends, ...wires.lineWidths]) if (wire !== null) roots.push(wire)
    }
    return programStats(circuit, roots)
  })()
  const heightsOnly = sharedWidthCircuit(blocks.map(block => block.table), heightsOutputs).stats
  const springsOnly = (() => {
    const source = new SourceLayout()
    const stepBits = Array.from({length: stepBitCount}, (_, bit) => source.cell(`bit${bit}`, 0, 0, 1))
    const springCount = 1 + blocks.length + blocks.filter(block => block.kind === 'bubble').length
    const springCells = Array.from({length: springCount}, (_, index) => [source.cell(`position${index}`, 0, -16384, 16384), source.cell(`velocity${index}`, 0, -1e6, 1e6), source.cell(`destination${index}`, 0, -16384, 16384)] as const)
    const circuit = source.createCircuit()
    const matrix = emitStepMatrix(circuit, stepBits, notesLayout.spring)
    const roots: Wire[] = []
    for (const [position, velocity, destination] of springCells) {
      const spring = emitMatrixSpring(circuit, matrix, position, velocity, destination)
      roots.push(spring.position, spring.velocity, spring.active)
    }
    return {...programStats(circuit, roots), springCount}
  })()
  markdown(['circuit', 'live ops', 'layers', 'stored weights'], [
    ['whole Notes machine', whole.liveOperations, whole.layers, whole.storedWeights],
    ['text tables alone (painting outputs)', textOnly.liveOperations, textOnly.layers, textOnly.storedWeights],
    ['text tables alone (line counts only)', heightsOnly.liveOperations, heightsOnly.layers, heightsOnly.storedWeights],
    [`${springsOnly.springCount} springs sharing one step matrix`, springsOnly.liveOperations, springsOnly.layers, springsOnly.storedWeights],
  ])
  // The same outputs as gathered rows: count the cells that allocateBlockGatherCells allocates.
  const gatherCells = sum(blocks.map(block => {
    const cells = new SourceLayout()
    allocateBlockGatherCells(cells, 'block', block.table, outputsFor(block.kind))
    return cells.values.length
  }))
  console.log(JSON.stringify({tabulateMilliseconds: Math.round(tabulateMilliseconds), buildAndCompileMilliseconds: Math.round(buildMilliseconds), gatheredTableCells: gatherCells}), '\n')
  // Rough per-frame timings: the circuit versus calling pretext for the same outputs.
  const circuitMicroseconds = medianMicroseconds(() => { machine.step(4) }, 2000)
  const contentWidth = 520.5
  const pretextMicroseconds = medianMicroseconds(() => { for (const block of blocks) referenceBlock(block, contentWidth) }, 2000)
  const heightsMicroseconds = medianMicroseconds(() => { for (const block of blocks) layout(block.prepared, block.spec.maxWidthAt(contentWidth), block.lineHeight) }, 5000)
  markdown(['per frame (rough, shared machine)', 'µs'], [
    ['Notes circuit step (springs, drag, all text outputs)', circuitMicroseconds.toFixed(1)],
    ['pretext for the same text outputs (layoutWithLines, measureLineStats, tight-width searches)', pretextMicroseconds.toFixed(1)],
    ['pretext layout() heights only', heightsMicroseconds.toFixed(2)],
  ])
}

function editSection() {
  console.log('## rebuilding tables while typing into a paragraph, one character per edit\n')
  const blocks = prepareNotesBlocks()
  const target = 2
  const finalText = notesContent.paragraphs[1]!
  const rows: (string | number)[][] = []
  for (const mode of ['append', 'insert in the middle'] as const) {
    const prepareMs: number[] = []
    const tabulateMs: number[] = []
    const rebuildMs: number[] = []
    const changedThresholds: number[] = []
    let previousThresholds: number[] | null = null
    for (let length = 120; length <= finalText.length; length++) {
      const text = mode === 'append'
        ? finalText.slice(0, length)
        : finalText.slice(0, 60) + finalText.slice(finalText.length - (length - 60))
      let started = performance.now()
      const prepared = prepareWithSegments(text, blocks[target]!.font)
      prepareMs.push(performance.now() - started)
      started = performance.now()
      const spec: BlockSpec = {prepared, mode: 'plain', maxWidthAt: width => width}
      const table = tabulateBlock(spec, notesLayout.tabulateFrom, notesLayout.tabulateTo, notesLayout.tabulateStep)
      tabulateMs.push(performance.now() - started)
      started = performance.now()
      const editedBlocks = blocks.map((block, index) => index === target ? {...block, text, prepared, spec, table} : block)
      createNotesMachine(editedBlocks)
      rebuildMs.push(performance.now() - started)
      if (previousThresholds !== null) {
        const before = new Set(previousThresholds)
        const after = new Set(table.thresholds)
        changedThresholds.push([...after].filter(value => !before.has(value)).length + [...before].filter(value => !after.has(value)).length)
      }
      previousThresholds = table.thresholds
    }
    rows.push([
      mode,
      prepareMs.length,
      `${percentile(prepareMs, 0.5).toFixed(2)} / ${percentile(prepareMs, 1).toFixed(2)}`,
      `${percentile(tabulateMs, 0.5).toFixed(1)} / ${percentile(tabulateMs, 1).toFixed(1)}`,
      `${percentile(rebuildMs, 0.5).toFixed(1)} / ${percentile(rebuildMs, 1).toFixed(1)}`,
      `${percentile(changedThresholds, 0.5)} / ${percentile(changedThresholds, 1)}`,
    ])
  }
  markdown(['edit', 'edits', 'prepare ms: median / max', 'tabulate ms: median / max', 'rebuild and compile the whole Notes circuit ms: median / max', 'thresholds added or removed per keystroke: median / max'], rows)
}

function scaleSection() {
  console.log('## runtime uniform font scale (tables tabulated at 15px)\n')
  const text = notesContent.paragraphs[1]!
  const baseSpec = plainSpec(text, '15px Test Sans')
  const table = restrictTable(tabulateBlock(baseSpec, 150, 1100, 1), {maxLineWidth: false, layoutWidth: false})
  const source = new SourceLayout()
  const width = source.cell('width', 300, 0, 8192)
  const fontScale = source.cell('fontScale', 1, 0.25, 4)
  const circuit = source.createCircuit()
  const bits = table.thresholds.map(threshold => emitAtLeastScaled(circuit, width, fontScale, threshold, 0.005))
  const lineCount = emitDeltaRow(circuit, bits, table.lineCount)
  const evaluate = circuit.createTensorEvaluator([lineCount])
  const stats = programStats(circuit, [lineCount])
  const input = source.table()
  const random = createRandom(3)
  const rows: (string | number)[][] = []
  for (const scale of [0.8, 1, 1.2, 1.5, 2]) {
    const prepared = prepareWithSegments(text, `${15 * scale}px Test Sans`)
    input[fontScale] = scale
    const scaledThresholds = table.thresholds.map(threshold => scale * (threshold + 0.005) - 0.005)
    const widths: number[] = []
    for (let trial = 0; trial < 3000; trial++) widths.push(Math.fround(150 * Math.min(1, scale) + random() * (1100 - 150) * Math.min(1, scale)))
    for (const threshold of scaledThresholds) for (const offset of [-1e-3, -1e-4, 0, 1e-4, 1e-3]) widths.push(Math.fround(threshold + offset))
    // Only widths inside both the base range and the scaled table's range are checked.
    const lowest = 150 * Math.max(1, scale)
    const highest = 1100 * Math.min(1, scale)
    const checked = widths.filter(testWidth => testWidth >= lowest && testWidth <= highest)
    const thresholdsLeftOut = scaledThresholds.filter(threshold => threshold < lowest || threshold > highest)
    let mismatches = 0
    let farthest = 0
    for (const testWidth of checked) {
      input[width] = testWidth
      const actual = evaluate(input)[0]
      const expected = layout(prepared, testWidth, 1).lineCount
      if (actual !== expected) {
        mismatches++
        farthest = Math.max(farthest, Math.min(...scaledThresholds.map(threshold => Math.abs(threshold - testWidth))))
      }
    }
    const leftOut = thresholdsLeftOut.length === 0 ? '' : ` (left out: ${thresholdsLeftOut.map(threshold => threshold.toFixed(1)).join(', ')})`
    rows.push([scale, `${15 * scale}px`, `${lowest}..${highest}`, checked.length, `${scaledThresholds.length - thresholdsLeftOut.length} of ${scaledThresholds.length}${leftOut}`, mismatches, farthest.toExponential(2)])
  }
  console.log(`line count circuit with a runtime scale: ${stats.liveOperations} live ops, ${stats.layers} layers, ${stats.storedWeights} weights, ${table.thresholds.length} thresholds\n`)
  markdown(['font scale', 'pretext prepared at', 'checked range (px)', 'widths checked', 'scaled thresholds inside the checked range', 'line count mismatches', 'farthest mismatch from a scaled threshold (px)'], rows)
}

// ---------------------------------------------------------------- non-dyadic advances

// The same exactness checks with every character's advance scaled by its own factor in 1..1.05, so
// widths aren't multiples of a power-of-two fraction and thresholds of different paragraphs rarely coincide.
async function nonDyadicSection() {
  console.log('## non-dyadic advances (every character scaled by its own factor in 1..1.05)\n')
  console.log("### pretext's test data as tables, checked against pretext\n")
  printOracleTable(checkTablesAgainstPretext(await loadOracleCases()))
  console.log('### the Notes window: scripted resize traces (seeds 1 and 2)\n')
  const trace = checkNotesTraces(prepareNotesBlocks(), [1, 2])
  console.log(JSON.stringify({...trace, decisionProblems: trace.decisionProblems.slice(0, 5)}, null, 2), '\n')
  console.log('### heights circuits with and without shared comparisons\n')
  const sources = JSON.parse(await Bun.file(`${pretextCopy}/corpora/sources.json`).text()) as {id: string, font_size_px: number, min_width: number, max_width: number, output: string}[]
  const rows: (string | number)[][] = []
  for (const id of ['en-gatsby-opening', 'ar-al-bukhala']) {
    const source = sources.find(entry => entry.id === id)!
    const text = await Bun.file(`${pretextCopy}/${source.output}`).text()
    const paragraphs = text.split(/\n+/).map(paragraph => paragraph.trim()).filter(paragraph => paragraph.length > 0)
    const font = `${source.font_size_px}px Test Sans`
    const tables = paragraphs.map(paragraph => tabulateBlock(plainSpec(paragraph, font), source.min_width, source.max_width, 1))
    const sizes = sharingSizes(tables, false)
    rows.push([
      id,
      paragraphs.length,
      sum(tables.map(table => tableStats(table).lineCountChanges)),
      sizes.distinctLineCountThresholds,
      `${sizes.heights.liveOperations} / ${sizes.heights.layers} / ${sizes.heights.storedWeights}`,
      `${sizes.heightsPerTable.liveOperations} / ${sizes.heightsPerTable.storedWeights}`,
    ])
  }
  markdown(['corpus', 'paragraphs', 'line count thresholds', 'distinct line count threshold values', 'heights circuit: live ops / layers / weights', 'heights circuit, one width cell per paragraph: live ops / weights'], rows)
}

if (runSection('corpora')) await corporaSection()
if (runSection('hn')) await hnSection()
if (runSection('oracle')) await oracleSection()
if (runSection('long')) await longSection()
if (runSection('rich')) richSection()
if (runSection('prewrap')) prewrapSection()
if (runSection('notes')) notesSection()
if (runSection('edit')) editSection()
if (runSection('scale')) scaleSection()
if (runSection('nondyadic')) await nonDyadicSection()
// With no arguments, the nondyadic section runs in its own process (see installFakeCanvas above).
if (requested.size === 0) Bun.spawnSync(['bun', process.argv[1]!, 'nondyadic'], {stdout: 'inherit', stderr: 'inherit'})

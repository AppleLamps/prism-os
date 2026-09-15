// Measurements for the code point editor. Run from the repo root:
//   bun lab/ui-exploration/code-points/report.ts                  (everything, about 10 seconds)
//   bun lab/ui-exploration/code-points/report.ts decode tables    (chosen sections; see `sections`)
// Counts are exact. CPU timings are rough: other processes share the machine.

import {buildEditorCircuit as buildBaselineCircuit, type EditorBuild as BaselineBuild, writeEvent as writeBaselineEvent, writeState as writeBaselineState} from '../text-editing/editor-circuit.ts'
import {measureCircuit as measureBaselineCircuit} from '../text-editing/integer-circuits.ts'
import {classCodes, type EditorConfig as BaselineConfig, emptyState as emptyBaselineState, event as baselineEvent, packCell} from '../text-editing/reference.ts'
import {createWidthTable, encodeText} from '../text-editing/width-table.ts'
import {buildDecodeCircuit, buildEditorCircuit, createEditorMachine, type EditorBuild, tableSourceCells, writeAdvanceTable, writeStaticTables} from './editor-circuit.ts'
import {fakeTextWidth} from '../text-editing/fake-canvas.ts'
import {type CircuitSize, measureCircuit} from './integer-circuits.ts'
import {takeFrameEvents} from './keyboard.ts'
import {breaksBetween, classCount, classOfCodePoint, codePointsOf, LB, pairRuleFor, pairRules} from './line-break-classes.ts'
import type {CompileOptions, Wire} from './numeric-ui-core.ts'
import {type CharacterModel, type EditorConfig, type EditorEvent, type EditorState, emptyState, event, layoutSlotCount, referenceFrame, referenceLayout} from './reference.ts'
import {advanceUnits, blockCount, classTables, codePointLimit, createAdvanceTable, pageSize, propertyTables} from './tables.ts'
import {createRandom, randomCodePoint, randomEvent, testAdvance} from './test-support.ts'

const baseConfig: EditorConfig = {capacity: 256, lineSlots: 12, pasteLimit: 8, advancePageLimit: 64, keysPerFrame: 1, maxWidthLimit: 8192, glyphOutputs: true, scan: 'sklansky'}
const baselineConfig: BaselineConfig = {capacity: 256, lineSlots: 12, pasteLimit: 8, codeLimit: 96, keysPerFrame: 1, maxWidthLimit: 8192, glyphOutputs: true, scan: 'sklansky'}
// The shared runtime's lowering rules: bit gathers only, build-time depths.
const sharedRuntimeCompile: CompileOptions = {lowerIndexOneHots: false, inferBitFamilies: false, recomputeDepths: false}

function format(value: number) {
  return value.toLocaleString('en-US')
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[sorted.length >> 1]!
}

function microseconds(run: () => void, milliseconds = 150) {
  const warmStart = performance.now()
  while (performance.now() - warmStart < milliseconds) run()
  const samples: number[] = []
  for (let sample = 0; sample < 7; sample++) {
    let iterations = 0
    const start = performance.now()
    while (performance.now() - start < milliseconds / 5) {
      run()
      iterations++
    }
    samples.push(((performance.now() - start) * 1000) / iterations)
  }
  return median(samples)
}

function timed<T>(run: () => T): {value: T, milliseconds: number} {
  const start = performance.now()
  const value = run()
  return {value, milliseconds: performance.now() - start}
}

// A typical frame: three quarters full of mixed text, a selection, one insert per slot.
function typicalMachine(config: EditorConfig) {
  const machine = createEditorMachine(config, testAdvance)
  machine.setGeometry(1280, 80)
  const random = createRandom(3)
  const state = emptyState(config)
  state.length = Math.floor(config.capacity * 0.75)
  for (let cell = 0; cell < state.length; cell++) {
    let codePoint = randomCodePoint(random)
    while (codePoint === 0x0A) codePoint = randomCodePoint(random)
    state.cells[cell] = codePoint
  }
  state.caret = Math.floor(state.length / 2)
  state.anchor = Math.floor(state.length / 3)
  machine.load(state)
  return machine
}

function executorMicroseconds(editor: EditorBuild) {
  const machine = typicalMachine(editor.config)
  const evaluate = editor.circuit.createTensorEvaluator(editor.roots)
  for (let slot = 0; slot < editor.config.keysPerFrame; slot++) machine.source[editor.source.slots[slot]!.kind + 1] = 1
  return microseconds(() => evaluate(machine.source))
}

function baselineSource(build: BaselineBuild) {
  const {config, source: layout} = build
  const source = new Float32Array(layout.size)
  source[layout.unit] = 1
  source[layout.maxWidth] = 1280
  source[layout.lineHeight] = 80
  for (let code = 1; code < config.codeLimit; code++) source[layout.table + code] = packCell(code, code % 11 < 7 ? classCodes.word : code % 11 < 9 ? classCodes.space : classCodes.other, 20 + (code % 30))
  const random = createRandom(3)
  const state = emptyBaselineState(config)
  state.length = Math.floor(config.capacity * 0.75)
  for (let cell = 0; cell < state.length; cell++) state.cells[cell] = source[layout.table + 1 + Math.floor(random() * (config.codeLimit - 1))]!
  state.caret = Math.floor(state.length / 2)
  state.anchor = Math.floor(state.length / 3)
  writeBaselineState(source, config, layout, state)
  for (let slot = 0; slot < config.keysPerFrame; slot++) writeBaselineEvent(source, config, layout, slot, baselineEvent('insert', {codes: [1]}))
  return source
}

const sizeHeader = '| circuit | sources (tables) | live ops | affine / reglu / boolean / index | layers | stored weights | gather reads / table entries | index reads / table entries | build ms | executor µs |\n| --- | ---: | ---: | --- | ---: | ---: | --- | --- | ---: | ---: |'

function sizeRow(label: string, size: CircuitSize, tableCells: number, buildMilliseconds: number, executor: number | null) {
  return `| ${label} | ${format(size.sources)} (${format(tableCells)}) | ${format(size.liveOperations)} | ${format(size.affine)} / ${format(size.reglu)} / ${format(size.boolean)} / ${format(size.index)} | ${size.layers} | ${format(size.storedWeights)} | ${format(size.gatherReads)} / ${format(size.gatherTableEntries)} | ${format(size.indexReads)} / ${format(size.indexTableEntries)} | ${buildMilliseconds.toFixed(0)} | ${executor === null ? '' : executor.toFixed(0)} |`
}

function baselineRow(label: string, config: BaselineConfig, withTiming: boolean) {
  const {value: build, milliseconds} = timed(() => buildBaselineCircuit(config))
  const size = measureBaselineCircuit(build.circuit, build.roots)
  let executor: number | null = null
  if (withTiming) {
    const evaluate = build.circuit.createTensorEvaluator(build.roots)
    const source = baselineSource(build)
    executor = microseconds(() => evaluate(source))
  }
  return sizeRow(label, {...size, index: 0, indexReads: 0, indexTableEntries: 0}, config.codeLimit, milliseconds, executor)
}

function codePointRow(label: string, config: EditorConfig, withTiming: boolean, options: CompileOptions = {}) {
  const {value: build, milliseconds} = timed(() => buildEditorCircuit(config))
  const size = measureCircuit(build.circuit, build.roots, options)
  return sizeRow(label, size, tableSourceCells(build.source, config).total, milliseconds, withTiming ? executorMicroseconds(build) : null)
}

function sectionSizes() {
  console.log('## Size by capacity (one key per evaluation, 12 line slots, paste limit 8, glyph outputs on)\n')
  console.log('The baseline is text-editing\'s circuit, imported from ../text-editing/, on the shared runtime with 96 grapheme codes. The code point rows use this folder\'s runtime copy with 64 advance pages. "Tables" counts table source cells: the grapheme table for the baseline; class, property, pair and advance tables for code points.\n')
  console.log(sizeHeader)
  for (const capacity of [32, 64, 128, 256]) {
    const withTiming = capacity === 256
    console.log(baselineRow(`capacity ${capacity}, baseline (grapheme codes)`, {...baselineConfig, capacity}, withTiming))
    console.log(codePointRow(`capacity ${capacity}, code points, one-hot position reads, shared runtime compile rules`, {...baseConfig, capacity}, false, sharedRuntimeCompile))
    console.log(codePointRow(`capacity ${capacity}, code points, one-hot position reads`, {...baseConfig, capacity}, withTiming))
    console.log(codePointRow(`capacity ${capacity}, code points, index position reads`, {...baseConfig, capacity, positionReads: 'index'}, withTiming))
  }
  console.log('')
}

function sectionVariants() {
  console.log('## Variants (capacity 256, 12 line slots, one key)\n')
  console.log(sizeHeader)
  const variants: [string, Partial<EditorConfig>][] = [
    ['one-hot position reads, shift read blocks', {}],
    ['one-hot position reads, floor atoms blocks', {blockIndex: 'floor atoms'}],
    ['index position reads, shift read blocks', {positionReads: 'index'}],
    ['index position reads, floor atoms blocks', {positionReads: 'index', blockIndex: 'floor atoms'}],
    ['index position reads, no glyph outputs', {positionReads: 'index', glyphOutputs: false}],
    ['index position reads, paste limit 1', {positionReads: 'index', pasteLimit: 1}],
    ['index position reads, 4 keys, 1 with layout', {positionReads: 'index', keysPerFrame: 4, layoutSlots: 1}],
    ['index position reads, 4 keys, all with layout', {positionReads: 'index', keysPerFrame: 4}],
    ['one-hot position reads, CJK runs kept whole', {overflow: 'cjk whole'}],
    ['index position reads, CJK runs kept whole', {positionReads: 'index', overflow: 'cjk whole'}],
  ]
  for (const [label, change] of variants) console.log(codePointRow(label, {...baseConfig, ...change}, false))
  console.log(baselineRow('baseline, 4 keys, 1 with layout', {...baselineConfig, keysPerFrame: 4, layoutSlots: 1}, false))
  console.log(baselineRow('baseline, paste limit 1', {...baselineConfig, pasteLimit: 1}, false))
  console.log('')
}

type PhaseTotals = {operations: number, weights: number, reads: number, minimumLayer: number, maximumLayer: number}

// The parts of a compiled program both runtimes share; the baseline's layers have no index reads.
type ProgramShape = {
  sourceSize: number
  wireOrder: ArrayLike<number>
  layers: readonly {
    outputSize: number
    gateRows: ArrayLike<number>
    rowOffsets: ArrayLike<number>
    gatherReads: readonly {row: number}[]
    indexReads?: readonly {row: number, indexRow: number}[]
  }[]
}

// Splits live operations, stored weights, reads, and layer span by builder phase.
function phaseBreakdown(program: ProgramShape, phases: readonly {name: string, scope: string, firstOperation: number}[]) {
  const phaseOf = (wire: Wire) => {
    const operation = wire - program.sourceSize
    let found = -1
    for (let index = 0; index < phases.length; index++) if (phases[index]!.firstOperation <= operation) found = index
    return phases[found]
  }
  const totals = new Map<string, PhaseTotals>()
  let available = program.sourceSize
  program.layers.forEach((layer, layerIndex) => {
    const extraRows = new Map<number, number>()
    Array.from(layer.gateRows).forEach((row, gate) => extraRows.set(row, layer.outputSize + gate))
    const indexRows = new Map((layer.indexReads ?? []).map(read => [read.row, read.indexRow]))
    const readRows = new Set([...layer.gatherReads.map(read => read.row), ...(layer.indexReads ?? []).map(read => read.row)])
    for (let row = 0; row < layer.outputSize; row++) {
      let weights = layer.rowOffsets[row + 1]! - layer.rowOffsets[row]!
      for (const extra of [extraRows.get(row), indexRows.get(row)]) if (extra !== undefined) weights += layer.rowOffsets[extra + 1]! - layer.rowOffsets[extra]!
      const phase = phaseOf(program.wireOrder[available + row]!)
      const key = phase === undefined ? 'constants' : `${phase.scope}: ${phase.name}`
      const entry = totals.get(key) ?? {operations: 0, weights: 0, reads: 0, minimumLayer: Infinity, maximumLayer: -Infinity}
      entry.operations++
      entry.weights += weights
      if (readRows.has(row)) entry.reads++
      entry.minimumLayer = Math.min(entry.minimumLayer, layerIndex)
      entry.maximumLayer = Math.max(entry.maximumLayer, layerIndex)
      totals.set(key, entry)
    }
    available += layer.outputSize
  })
  return totals
}

function printPhases(title: string, totals: Map<string, PhaseTotals>) {
  console.log(`### ${title}\n`)
  console.log('| part | live ops | stored weights | gather or index reads | layer span |')
  console.log('| --- | ---: | ---: | ---: | --- |')
  for (const [key, entry] of totals) console.log(`| ${key} | ${format(entry.operations)} | ${format(entry.weights)} | ${format(entry.reads)} | ${entry.minimumLayer}..${entry.maximumLayer} |`)
  console.log('')
}

function sectionPhases() {
  console.log('## Where the operations go (capacity 256, 12 line slots, one key)\n')
  console.log('Operations are counted in the phase that first built them, so a phase that reuses an earlier wire costs nothing for it.\n')
  const baseline = buildBaselineCircuit(baselineConfig)
  printPhases('baseline (grapheme codes, shared runtime)', phaseBreakdown(baseline.circuit.compileTensorProgram(baseline.roots), baseline.phases))
  for (const positionReads of ['one-hot', 'index'] as const) {
    const build = buildEditorCircuit({...baseConfig, positionReads})
    printPhases(`code points, ${positionReads} position reads`, phaseBreakdown(build.circuit.compileTensorProgram(build.roots), build.phases))
  }
}

function sectionDecode() {
  console.log('## Per cell decode and break bits\n')
  console.log('A circuit holding only the per cell reads over 256 code point cells and the same tables. Roots are every class, advance, space or newline bit, newline bit, word bit and break bit.\n')
  console.log('| block index | live ops | per cell | index reads | reglu / boolean / affine | layers | stored weights |')
  console.log('| --- | ---: | ---: | ---: | --- | ---: | ---: |')
  for (const blockIndex of ['shift read', 'floor atoms'] as const) {
    const build = buildDecodeCircuit(256, 64, blockIndex)
    const {decoded} = build
    const roots = [...decoded.classes, ...decoded.advance, ...decoded.spaceOrNewline, ...decoded.newline, ...decoded.word, ...decoded.breakAfter]
    const size = measureCircuit(build.circuit, roots)
    console.log(`| ${blockIndex} | ${format(size.liveOperations)} | ${(size.liveOperations / 256).toFixed(2)} | ${format(size.indexReads)} | ${format(size.reglu)} / ${format(size.boolean)} / ${format(size.affine)} | ${size.layers} | ${format(size.storedWeights)} |`)
    const withoutWord = measureCircuit(build.circuit, roots.filter(wire => !decoded.word.includes(wire)))
    console.log(`| ${blockIndex}, without word bits (the final layout doesn't read them) | ${format(withoutWord.liveOperations)} | ${(withoutWord.liveOperations / 256).toFixed(2)} | ${format(withoutWord.indexReads)} | ${format(withoutWord.reglu)} / ${format(withoutWord.boolean)} / ${format(withoutWord.affine)} | ${withoutWord.layers} | ${format(withoutWord.storedWeights)} |`)
  }
  console.log('\nFor comparison, text-editing\'s decode is 8 atoms per cell (one floor of 3 atoms, 3 comparisons, 2 affines) in 5 layers, and gives the advance, space, newline and word bits, with break opportunities only at spaces and newlines.\n')
}

function sectionTables() {
  console.log('## Tables\n')
  // classTables() is cached, and earlier sections may have built it, so print the first call's time.
  const classes = classTables()
  const {value: properties, milliseconds: propertyMilliseconds} = timed(() => propertyTables())
  console.log('| table | source cells | filled by | written when |')
  console.log('| --- | ---: | --- | --- |')
  console.log(`| class blocks (offset per 128 code points) | ${format(blockCount)} | JS, from pretext's Unicode 17 class data plus the CJK distinctions (${classes.buildMilliseconds.toFixed(0)} ms, once per process) | once |`)
  console.log(`| class pages (${classes.pageCount} distinct pages of 128 classes) | ${format(classes.pageCount * pageSize)} | same | once |`)
  console.log(`| class properties (space or newline, newline, word) | ${3 * classCount} | JS, from the class functions (${propertyMilliseconds.toFixed(1)} ms with the pair table) | once |`)
  console.log(`| pair table (${classCount} × ${classCount} break bits) | ${format(properties.pairs.length)} | JS, from the pair rules | once |`)
  console.log(`| emergency pair table (${classCount} × ${classCount} bits, read only when CJK runs are kept whole) | ${format(properties.emergencyPairs.length)} | JS, from classesMayBreakInside | once |`)
  console.log(`| advance blocks | ${format(blockCount)} | JS | when a code point from a new block appears |`)
  console.log(`| advance pages (64 pages of 128 advances) | ${format(64 * pageSize)} | JS, measuring one code point | when a code point first appears, and every seen code point on a font change |`)
  const tableCells = 2 * blockCount + classes.pageCount * pageSize + 3 * classCount + properties.pairs.length + properties.emergencyPairs.length + 64 * pageSize
  console.log(`| total | ${format(tableCells)} | | |\n`)

  console.log('Pair table cells decided by each rule (first rule that applies):\n')
  console.log('| rule | breaks | cells |')
  console.log('| --- | --- | ---: |')
  const counts = new Map<string, number>()
  for (let before = 0; before < classCount; before++) for (let after = 0; after < classCount; after++) {
    const rule = pairRuleFor(before, after)
    counts.set(rule.name, (counts.get(rule.name) ?? 0) + 1)
  }
  for (const rule of pairRules) console.log(`| ${rule.name} | ${rule.breaks ? 'yes' : 'no'} | ${format(counts.get(rule.name) ?? 0)} |`)
  let breaking = 0
  for (const bit of properties.pairs) breaking += bit
  console.log(`\n${format(breaking)} of ${format(properties.pairs.length)} pair cells allow a break.\n`)

  console.log('Source range validation, which the executor runs over every source cell on every evaluation (capacity 256, one key, index position reads):\n')
  const build = buildEditorCircuit({...baseConfig, positionReads: 'index'})
  const machine = typicalMachine(build.config)
  const validate = microseconds(() => build.circuit.validateSourceRanges(machine.source))
  const evaluate = build.circuit.createTensorEvaluator(build.roots)
  const total = microseconds(() => evaluate(machine.source))
  const layout = build.source
  const cells = tableSourceCells(layout, build.config)
  console.log('| source cells | of which tables | validation µs per evaluation | evaluation µs including validation |')
  console.log('| ---: | ---: | ---: | ---: |')
  console.log(`| ${format(layout.size)} | ${format(cells.total)} | ${validate.toFixed(1)} | ${total.toFixed(0)} |\n`)
}

// Every code point through the decode circuit, 4,096 per evaluation.
function sectionExhaustive() {
  console.log('## Every Unicode code point through the decode circuit\n')
  console.log('| block index | code points | evaluations | class mismatches | advance mismatches | break bit mismatches | ms |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  const batch = 4096
  for (const blockIndex of ['shift read', 'floor atoms'] as const) {
    const start = performance.now()
    const build = buildDecodeCircuit(batch, 64, blockIndex)
    const {circuit, source, decoded} = build
    const evaluate = circuit.createTensorEvaluator([...decoded.classes, ...decoded.advance, ...decoded.breakAfter])
    const values = new Float32Array(source.size)
    writeStaticTables(values, source)
    let classMismatches = 0
    let advanceMismatches = 0
    let breakMismatches = 0
    let evaluations = 0
    for (let first = 0; first < codePointLimit; first += batch) {
      const advances = createAdvanceTable(64, testAdvance)
      const codePoints = Array.from({length: batch}, (_, cell) => (first + cell) % codePointLimit)
      for (const codePoint of codePoints) advances.ensure(codePoint)
      values.fill(0, source.advanceBlocks, source.advancePages + 64 * pageSize)
      writeAdvanceTable(values, source, advances)
      codePoints.forEach((codePoint, cell) => {
        values[source.cells + cell] = codePoint
      })
      const outputs = evaluate(values)
      evaluations++
      for (let cell = 0; cell < batch; cell++) {
        const codePoint = codePoints[cell]!
        const lineBreakClass = classOfCodePoint(codePoint)
        if (outputs[cell] !== lineBreakClass) classMismatches++
        if (outputs[batch + cell] !== advanceUnits(testAdvance, codePoint)) advanceMismatches++
        const next = cell + 1 < batch ? classOfCodePoint(codePoints[cell + 1]!) : LB.empty
        if (outputs[2 * batch + cell] !== (breaksBetween(lineBreakClass, next) ? 1 : 0)) breakMismatches++
      }
    }
    console.log(`| ${blockIndex} | ${format(codePointLimit)} | ${evaluations} | ${classMismatches} | ${advanceMismatches} | ${breakMismatches} | ${(performance.now() - start).toFixed(0)} |`)
  }
  console.log('\nThe last batch wraps around to code point 0 to fill its cells.\n')
}

const paragraph = 'Pretext 在浏览器里测量文字，然后用纯算术排版。日本語の文章も「かな」と漢字が混ざります。Hangul 한국어 텍스트도 됩니다. Numbers like $1,299.99, 42% and 10:30 stay together; so do words-with-hyphens.\n最后一行：结束！'

type TypingSession = {fieldPixels: number, frames: number, seed: number, clearAbove: number, wrapParagraph: boolean}

// Types the paragraph with random edits and checks every frame against the JS model. It also counts
// frames whose final layout changes when CJK runs are kept whole, i.e. whether the session uses that
// rule at all. A frame whose layouts need more lines than the circuit has starts over from an empty
// field. With wrapParagraph, typing then goes on where it stopped in the paragraph, and wraps around
// at its end.
function runTypingSession(machine: ReturnType<typeof createEditorMachine>, config: EditorConfig, model: CharacterModel, session: TypingSession) {
  const paragraphCodes = codePointsOf(paragraph)
  const geometry = {maxWidth: session.fieldPixels * 4, lineHeight: 20 * 4}
  machine.setGeometry(geometry.maxWidth, geometry.lineHeight)
  let state = emptyState(config)
  machine.load(state)
  const random = createRandom(session.seed)
  const result = {checked: 0, keys: 0, mismatches: 0, outOfContract: 0, dropped: 0, maximumLines: 0, framesChangedByWholeRuns: 0}
  let typedIndex = 0
  const queue: EditorEvent[] = []
  for (let frame = 0; frame < session.frames; frame++) {
    for (let burst = Math.floor(random() * 5); burst > 0; burst--) {
      const roll = random()
      if ((session.wrapParagraph || typedIndex < paragraphCodes.length) && roll < 0.7) {
        queue.push(event('insert', {codes: [paragraphCodes[typedIndex++ % paragraphCodes.length]!]}))
      } else if (roll < 0.95) {
        const input = randomEvent(random, config, geometry)
        queue.push(input.kind === 'insert' ? event('insert', {codes: input.codes.map((_, index) => paragraphCodes[(typedIndex + index * 7) % paragraphCodes.length]!)}) : input)
      } else if (state.length > session.clearAbove) {
        queue.push(event('selectAll'), event('delete'))
        if (!session.wrapParagraph) typedIndex = 0
      }
    }
    const events = takeFrameEvents(queue, config.keysPerFrame, layoutSlotCount(config))
    const expected = referenceFrame(config, model, geometry, state, events)
    if (expected.maximumLineCount > config.lineSlots) {
      result.outOfContract++
      state = emptyState(config)
      machine.load(state)
      if (!session.wrapParagraph) typedIndex = 0
      queue.length = 0
      continue
    }
    const anywhereStarts = referenceLayout(expected.state, model, geometry.maxWidth, 'anywhere').starts
    const wholeStarts = referenceLayout(expected.state, model, geometry.maxWidth, 'cjk whole').starts
    if (JSON.stringify(anywhereStarts) !== JSON.stringify(wholeStarts)) result.framesChangedByWholeRuns++
    const actual = machine.runFrame(events)
    result.dropped += actual.droppedCodePoints
    result.checked++
    result.keys += events.length
    result.maximumLines = Math.max(result.maximumLines, expected.display.lineCount)
    const {overflowCount: _, ...display} = actual.display
    const trimmed = {...display, glyphLine: display.glyphLine.slice(0, expected.state.length), glyphX: display.glyphX.slice(0, expected.state.length)}
    if (JSON.stringify(actual.state) !== JSON.stringify(expected.state) || JSON.stringify(trimmed) !== JSON.stringify(expected.display)) {
      result.mismatches++
      machine.load(expected.state)
    }
    state = expected.state
  }
  return result
}

function sectionTyping() {
  const config: EditorConfig = {...baseConfig, keysPerFrame: 4, layoutSlots: 1, positionReads: 'index', overflow: 'cjk whole'}
  const measure = (codePoint: number) => fakeTextWidth(String.fromCodePoint(codePoint), '16px Test Sans') * 4
  const model: CharacterModel = {advanceOf: codePoint => advanceUnits(measure, codePoint)}
  const machine = createEditorMachine(config, measure)
  console.log('## Typing sessions with fake canvas widths (capacity 256, 12 line slots, 4 keys per evaluation with 1 layout slot, index position reads, CJK runs kept whole, mixed Chinese, Japanese, Korean and Latin text)\n')
  console.log('Ideographs are 16px wide. In the 30px field a unit like 字， doesn\'t fit on a line by itself, so keeping CJK runs whole changes where lines start. In the 320px field nothing in the paragraph is that wide, so that session never uses the rule. Both sessions share one circuit and one advance table.\n')
  console.log('| field | frames checked | keys applied | state or display mismatches | frames out of contract (started over) | dropped code points | frames whose final layout changes when CJK runs are kept whole | most lines |')
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  const sessions: TypingSession[] = [
    {fieldPixels: 320, frames: 1500, seed: 99, clearAbove: 200, wrapParagraph: false},
    {fieldPixels: 30, frames: 1500, seed: 100, clearAbove: 12, wrapParagraph: true},
  ]
  for (const session of sessions) {
    const result = runTypingSession(machine, config, model, session)
    console.log(`| ${session.fieldPixels}px | ${format(result.checked)} | ${format(result.keys)} | ${result.mismatches} | ${result.outOfContract} | ${result.dropped} | ${format(result.framesChangedByWholeRuns)} | ${result.maximumLines} |`)
  }
  console.log(`\nadvance pages in use ${machine.advances.pagesInUse()}, code points measured ${machine.advances.seen.length}\n`)
}

function sectionFont() {
  console.log('## What a font change rewrites (capacity 256, the typing paragraph loaded, 16px to 20px)\n')
  const config: EditorConfig = {...baseConfig, positionReads: 'index'}
  const measureAt = (size: number) => (codePoint: number) => fakeTextWidth(String.fromCodePoint(codePoint), `${size}px Test Sans`) * 4
  const machine = createEditorMachine(config, measureAt(16))
  machine.setGeometry(320 * 4, 80)
  const state: EditorState = emptyState(config)
  const codes = codePointsOf(paragraph)
  codes.forEach((codePoint, cell) => {
    state.cells[cell] = codePoint
  })
  state.length = codes.length
  machine.load(state)
  const before = machine.runFrame([])
  const cellsBefore = Array.from(machine.source.subarray(machine.build.source.cells, machine.build.source.cells + config.capacity))
  const rewrite = machine.setFont(measureAt(20))
  const after = machine.runFrame([])
  const cellsAfter = Array.from(machine.source.subarray(machine.build.source.cells, machine.build.source.cells + config.capacity))
  const model: CharacterModel = {advanceOf: codePoint => advanceUnits(measureAt(20), codePoint)}
  const expected = referenceFrame(config, model, {maxWidth: 320 * 4, lineHeight: 80}, state, [])
  const matches = JSON.stringify(after.display.lineStarts) === JSON.stringify(expected.display.lineStarts) && JSON.stringify(after.display.glyphX.slice(0, state.length)) === JSON.stringify(expected.display.glyphX)
  // text-editing has no font change path, so its row packs the paragraph with text-editing's width
  // table at both sizes, without running a circuit, and counts the table entries and text cells whose
  // packed values differ. A font change would write every table entry and every changed text cell.
  const baselineTableAt = (size: number) => createWidthTable(baselineConfig.codeLimit, 4, grapheme => fakeTextWidth(grapheme, `${size}px Test Sans`))
  const smallTable = baselineTableAt(16)
  const largeTable = baselineTableAt(20)
  const smallCells = encodeText(smallTable, paragraph).map(code => smallTable.packed[code]!)
  const largeCells = encodeText(largeTable, paragraph).map(code => largeTable.packed[code]!)
  const baselineEntries = smallTable.graphemes.length - 1
  const baselineChangedEntries = smallTable.packed.filter((packed, code) => code > 0 && packed !== largeTable.packed[code]).length
  const baselineChangedCells = smallCells.filter((cell, index) => cell !== largeCells[index]).length
  console.log('| | code points | distinct code points or graphemes | table entries rewritten | of which changed | source cells written | text cells changed | lines before | lines after | after matches the JS model |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
  console.log(`| code points | ${codes.length} | ${machine.advances.seen.length} | ${rewrite.rewrittenEntries} | ${rewrite.changedEntries} | ${rewrite.sourceCellsWritten} | ${cellsBefore.filter((value, cell) => value !== cellsAfter[cell]).length} | ${before.display.lineCount} | ${after.display.lineCount} | ${matches ? 'yes' : 'no'} |`)
  console.log(`| baseline (text-editing), packed in JS at both sizes, no circuit run | ${smallCells.length} | ${baselineEntries} | ${baselineEntries} | ${baselineChangedEntries} | ${baselineEntries} + ${baselineChangedCells} = ${baselineEntries + baselineChangedCells} | ${baselineChangedCells} | | | |\n`)
}

const sections: Record<string, () => void> = {
  sizes: sectionSizes,
  variants: sectionVariants,
  phases: sectionPhases,
  decode: sectionDecode,
  tables: sectionTables,
  exhaustive: sectionExhaustive,
  typing: sectionTyping,
  font: sectionFont,
}

const requested = process.argv.slice(2)
for (const [name, section] of Object.entries(sections)) {
  if (requested.length === 0 || requested.includes(name)) section()
}

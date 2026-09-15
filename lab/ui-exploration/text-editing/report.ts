// Measurements for the text editing circuit. Run from the repo root:
//   bun lab/ui-exploration/text-editing/report.ts            (everything, several minutes)
//   bun lab/ui-exploration/text-editing/report.ts sizes keys (chosen sections; see `sections` below)
// Counts are exact. CPU timings are rough: other processes share the machine.

import type {Wire} from '../../../numeric-ui-core.ts'
import {createGeneratedEvaluator} from './codegen.ts'
import {buildEditorCircuit, createEditorMachine, type EditorBuild, writeEvent, writeState} from './editor-circuit.ts'
import {fakeTextWidth} from './fake-canvas.ts'
import {measureCircuit} from './integer-circuits.ts'
import {takeFrameEvents} from './keyboard.ts'
import {emptyState, type EditorConfig, type EditorEvent, type EditorState, event, layoutSlotCount, referenceFrame, referenceStep} from './reference.ts'
import {createRandom, randomEvent, testTable} from './test-support.ts'
import {createWidthTable, encodeText} from './width-table.ts'

const baseConfig: EditorConfig = {capacity: 256, lineSlots: 12, pasteLimit: 8, codeLimit: 96, keysPerFrame: 1, maxWidthLimit: 8192, glyphOutputs: true, scan: 'sklansky'}

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

function build(config: EditorConfig) {
  const start = performance.now()
  const editor = buildEditorCircuit(config)
  const buildMilliseconds = performance.now() - start
  const size = measureCircuit(editor.circuit, editor.roots)
  return {editor, size, buildMilliseconds}
}

// A source table holding a typical state: three quarters full, a selection, one insert per slot.
function typicalSource(editor: EditorBuild) {
  const {config, source: layout} = editor
  const {table, codes} = testTable(config.codeLimit)
  const source = new Float32Array(layout.size)
  source[layout.unit] = 1
  source[layout.maxWidth] = 1280
  source[layout.lineHeight] = 80
  table.forEach((packed, code) => {
    source[layout.table + code] = packed
  })
  const random = createRandom(3)
  const state: EditorState = emptyState(config)
  const length = Math.floor(config.capacity * 0.75)
  for (let cell = 0; cell < length; cell++) {
    const pool = random() < 0.8 ? codes.word : codes.space
    state.cells[cell] = table[pool[Math.floor(random() * pool.length)]!]!
  }
  state.length = length
  state.caret = Math.floor(length / 2)
  state.anchor = Math.floor(length / 3)
  writeState(source, config, layout, state)
  for (let slot = 0; slot < config.keysPerFrame; slot++) writeEvent(source, config, layout, slot, event('insert', {codes: [1]}))
  return source
}

type Timing = {executor?: number, generated?: number}

function sizeRow(label: string, result: ReturnType<typeof build>, timing: Timing = {}) {
  const {size} = result
  return `| ${label} | ${format(size.sources)} | ${format(size.liveOperations)} | ${format(size.affine)} / ${format(size.reglu)} / ${format(size.boolean)} | ${format(size.layers)} | ${format(size.storedWeights)} | ${format(size.gatherReads)} / ${format(size.gatherTableEntries)} | ${format(size.widestLayer)} | ${result.buildMilliseconds.toFixed(0)} | ${timing.executor === undefined ? '' : timing.executor.toFixed(0)} | ${timing.generated === undefined ? '' : timing.generated.toFixed(1)} |`
}

const sizeHeader = '| config | sources | live ops | affine / reglu / boolean | layers | stored weights | gather reads / table entries | widest layer | build ms | executor µs | generated JS µs |\n| --- | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |'

function timeExecutor(editor: EditorBuild) {
  const evaluate = editor.circuit.createTensorEvaluator(editor.roots)
  const source = typicalSource(editor)
  return microseconds(() => evaluate(source))
}

function timeGenerated(editor: EditorBuild) {
  const program = editor.circuit.compileTensorProgram(editor.roots)
  const generated = createGeneratedEvaluator(program, editor.roots)
  const source = typicalSource(editor)
  const expected = Array.from(editor.circuit.createTensorEvaluator(editor.roots)(source))
  const actual = Array.from(generated.evaluate(source))
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('generated JS disagrees with the executor')
  return microseconds(() => generated.evaluate(source), 1500)
}

function sectionSizes() {
  console.log('## Size by capacity (one key per evaluation, 12 line slots, paste limit 8, 96 codes, glyph outputs on)\n')
  console.log(sizeHeader)
  for (const capacity of [32, 64, 128, 256]) {
    const result = build({...baseConfig, capacity})
    console.log(sizeRow(`capacity ${capacity}`, result, {executor: timeExecutor(result.editor), generated: timeGenerated(result.editor)}))
  }
  console.log('')
}

type Size = ReturnType<typeof measureCircuit>

// Per-key increments between rows with different key counts, as [smaller row, its key count, larger
// row, its key count]. A count that grows by the same amount per key in every step prints once.
// Layers print per step, because depth doesn't add up per key.
function describeSteps(steps: [from: Size, fromKeys: number, to: Size, toKeys: number][]) {
  const perKey = (field: 'liveOperations' | 'storedWeights' | 'gatherTableEntries') => {
    const values = steps.map(([from, fromKeys, to, toKeys]) => (to[field] - from[field]) / (toKeys - fromKeys))
    return values.every(value => value === values[0]) ? format(values[0]!) : values.map(format).join(' / ')
  }
  const layers = steps.map(([from, fromKeys, to, toKeys]) => `${fromKeys} to ${toKeys} keys +${to.layers - from.layers} (${format((to.layers - from.layers) / (toKeys - fromKeys))} per key)`).join(', ')
  return `${perKey('liveOperations')} live ops, ${perKey('storedWeights')} stored weights and ${perKey('gatherTableEntries')} gather table entries per key; layers from ${layers}`
}

function sectionKeys() {
  console.log('## Cost per queued keystroke (12 line slots)\n')
  for (const capacity of [64, 256]) {
    console.log(sizeHeader)
    const rows: [string, EditorConfig][] = [
      ['display only, 0 keys', {...baseConfig, capacity, keysPerFrame: 0}],
      ['1 key', {...baseConfig, capacity, keysPerFrame: 1}],
      ['2 keys, both with layout', {...baseConfig, capacity, keysPerFrame: 2}],
      ['4 keys, all with layout', {...baseConfig, capacity, keysPerFrame: 4}],
      ['2 keys, 1 with layout and 1 buffer-only', {...baseConfig, capacity, keysPerFrame: 2, layoutSlots: 1}],
      ['4 keys, 1 with layout and 3 buffer-only', {...baseConfig, capacity, keysPerFrame: 4, layoutSlots: 1}],
      ['8 keys, 1 with layout and 7 buffer-only', {...baseConfig, capacity, keysPerFrame: 8, layoutSlots: 1}],
    ]
    const results = rows.map(([label, config]) => {
      const result = build(config)
      console.log(sizeRow(`capacity ${capacity}, ${label}`, result, {executor: timeExecutor(result.editor)}))
      return result.size
    })
    const [zero, one, twoLayout, fourLayout, twoBuffer, fourBuffer, eightBuffer] = results as [Size, Size, Size, Size, Size, Size, Size]
    console.log(`\ncapacity ${capacity}: display only is ${format(zero.liveOperations)} live ops and ${zero.layers} layers. The first key adds ${format(one.liveOperations - zero.liveOperations)} live ops and ${one.layers - zero.layers} layers.`)
    console.log(`Each further key with a layout: ${describeSteps([[one, 1, twoLayout, 2], [twoLayout, 2, fourLayout, 4]])}.`)
    console.log(`Each further buffer-only key: ${describeSteps([[one, 1, twoBuffer, 2], [twoBuffer, 2, fourBuffer, 4], [fourBuffer, 4, eightBuffer, 8]])}.`)
    console.log('Live ops, stored weights and gather table entries add up per key, but layers don\'t.\n')
  }
}

function sectionLines() {
  console.log('## Line slots (capacity 128, one key per evaluation)\n')
  console.log(sizeHeader)
  for (const lineSlots of [4, 8, 16, 32]) console.log(sizeRow(`${lineSlots} line slots`, build({...baseConfig, capacity: 128, lineSlots})))
  console.log('')
}

function sectionVariants() {
  console.log('## Variants (capacity 64 and 256, 12 line slots, one key)\n')
  console.log(sizeHeader)
  const variants: [string, Partial<EditorConfig>][] = [
    ['baseline (Sklansky scans, barrel shift, glyph outputs)', {}],
    ['Brent-Kung scans', {scan: 'brent-kung'}],
    ['gather shift instead of barrel shift', {shift: 'gather'}],
    ['no glyph outputs', {glyphOutputs: false}],
    ['paste limit 1 (typing only)', {pasteLimit: 1}],
    ['paste limit 32', {pasteLimit: 32}],
    ['32 codes in the table', {codeLimit: 32}],
    ['512 codes in the table', {codeLimit: 512}],
  ]
  for (const capacity of [64, 256]) {
    for (const [label, change] of variants) console.log(sizeRow(`capacity ${capacity}, ${label}`, build({...baseConfig, capacity, ...change})))
  }
  console.log('')
}

// Splits live operations, stored weights, gather table entries, and layer span by builder phase.
function phaseBreakdown(editor: EditorBuild) {
  const {circuit, roots, phases} = editor
  const program = circuit.compileTensorProgram(roots)
  const phaseOf = (wire: Wire) => {
    const operation = wire - circuit.sourceSize
    let found = -1
    for (let index = 0; index < phases.length; index++) if (phases[index]!.firstOperation <= operation) found = index
    return phases[found]
  }
  type Totals = {operations: number, weights: number, tableEntries: number, minimumLayer: number, maximumLayer: number}
  const totals = new Map<string, Totals>()
  let available = program.sourceSize
  program.layers.forEach((layer, layerIndex) => {
    const gateByRow = new Map<number, number>()
    layer.gateRows.forEach((row, gate) => gateByRow.set(row, layer.outputSize + gate))
    const tableByRow = new Map(layer.gatherReads.map(read => [read.row, read.candidatePositions.length]))
    for (let row = 0; row < layer.outputSize; row++) {
      let weights = layer.rowOffsets[row + 1]! - layer.rowOffsets[row]!
      const gate = gateByRow.get(row)
      if (gate !== undefined) weights += layer.rowOffsets[gate + 1]! - layer.rowOffsets[gate]!
      const phase = phaseOf(program.wireOrder[available + row]!)
      const key = phase === undefined ? 'constants' : `${phase.scope}: ${phase.name}`
      const entry = totals.get(key) ?? {operations: 0, weights: 0, tableEntries: 0, minimumLayer: Infinity, maximumLayer: -Infinity}
      entry.operations++
      entry.weights += weights
      entry.tableEntries += tableByRow.get(row) ?? 0
      entry.minimumLayer = Math.min(entry.minimumLayer, layerIndex)
      entry.maximumLayer = Math.max(entry.maximumLayer, layerIndex)
      totals.set(key, entry)
    }
    available += layer.outputSize
  })
  return totals
}

function sectionPhases() {
  const configs: [string, EditorConfig][] = [
    ['1 key', {...baseConfig, keysPerFrame: 1}],
    ['4 keys, 1 with layout and 3 buffer-only', {...baseConfig, keysPerFrame: 4, layoutSlots: 1}],
  ]
  for (const [label, config] of configs) {
    const {editor, size} = build(config)
    console.log(`## Where the operations go (capacity 256, 12 line slots, ${label}; ${format(size.liveOperations)} live ops, ${size.layers} layers)\n`)
    console.log('Operations are counted in the phase that first built them, so a phase that reuses an earlier wire costs nothing for it. Counts for a key scope add up over every key with that scope.\n')
    console.log('| part | live ops | stored weights | gather table entries | layer span |')
    console.log('| --- | ---: | ---: | ---: | --- |')
    for (const [key, totals] of phaseBreakdown(editor)) {
      console.log(`| ${key} | ${format(totals.operations)} | ${format(totals.weights)} | ${format(totals.tableEntries)} | ${totals.minimumLayer}..${totals.maximumLayer} |`)
    }
    console.log('')
  }
}

function sectionEvaluationsPerFrame() {
  console.log('## Four keystrokes in a frame (capacity 256, 12 line slots, 180 cells of text)\n')
  const configs: [string, EditorConfig][] = [
    ['4 evaluations of the one-key circuit', {...baseConfig, keysPerFrame: 1}],
    ['1 evaluation of the four-key circuit, all slots with layout', {...baseConfig, keysPerFrame: 4}],
    ['1 evaluation of the four-key circuit, 1 layout slot', {...baseConfig, keysPerFrame: 4, layoutSlots: 1}],
  ]
  const {table} = testTable(baseConfig.codeLimit)
  const typed = [event('insert', {codes: [1]}), event('insert', {codes: [8]}), event('left', {shift: true}), event('backspace')]
  const state = emptyState(baseConfig)
  for (let cell = 0; cell < 180; cell++) state.cells[cell] = table[1 + (cell % 9)]!
  state.length = 180
  state.caret = 90
  state.anchor = 90
  console.log('| method | µs per frame, executor, including write-back |\n| --- | ---: |')
  for (const [label, config] of configs) {
    const machine = createEditorMachine(config)
    table.forEach((packed, code) => machine.setTableEntry(code, packed))
    machine.setGeometry(1280, 80)
    const run = config.keysPerFrame === 1
      ? () => {
          machine.load(state)
          for (const input of typed) machine.runFrame([input])
        }
      : () => {
          machine.load(state)
          machine.runFrame(typed)
        }
    console.log(`| ${label} | ${microseconds(run).toFixed(0)} |`)
  }
  const referenceMicroseconds = microseconds(() => {
    let current = state
    for (const input of typed) current = referenceStep(baseConfig, table, {maxWidth: 1280, lineHeight: 80}, current, input)
  })
  console.log(`| plain JS reference model, 4 steps (no display) | ${referenceMicroseconds.toFixed(1)} |`)
  console.log('')
}

// Types a paragraph through the circuit with widths from the fake canvas (16px, quarter pixel
// units) and random edits, checking every frame against the JS model.
function sectionTypingSession() {
  const config: EditorConfig = {...baseConfig, keysPerFrame: 4, layoutSlots: 1}
  const unitsPerPixel = 4
  const widthTable = createWidthTable(config.codeLimit, unitsPerPixel, grapheme => fakeTextWidth(grapheme, '16px Test Sans'))
  const paragraph = 'The quick brown fox jumps over the lazy dog, while seven wizards quietly hex every jolly gnome.\nPack my box with five dozen liquor jugs! Sphinx of black quartz: judge my vow. Supercalifragilisticexpialidocious words break inside.'
  const paragraphCodes = encodeText(widthTable, paragraph)
  const machine = createEditorMachine(config)
  const geometry = {maxWidth: 320 * unitsPerPixel, lineHeight: 20 * unitsPerPixel}
  machine.setGeometry(geometry.maxWidth, geometry.lineHeight)
  const random = createRandom(99)
  const {codes: randomCodes} = testTable(12)
  let state = emptyState(config)
  let checked = 0
  let mismatches = 0
  let outOfContract = 0
  let typedIndex = 0
  let maximumLines = 0
  let keys = 0
  const queue: EditorEvent[] = []
  for (let frame = 0; frame < 1500; frame++) {
    for (let burst = Math.floor(random() * 5); burst > 0; burst--) {
      const roll = random()
      if (typedIndex < paragraphCodes.length && roll < 0.7) {
        queue.push(event('insert', {codes: [paragraphCodes[typedIndex++]!]}))
      } else if (roll < 0.95) {
        const input = randomEvent(random, config, randomCodes, geometry)
        queue.push(input.kind === 'insert' ? event('insert', {codes: input.codes.map(code => paragraphCodes[code % paragraphCodes.length]!)}) : input)
      } else if (state.length > 200) {
        queue.push(event('selectAll'), event('delete'))
        typedIndex = 0
      }
    }
    const events = takeFrameEvents(queue, config.keysPerFrame, layoutSlotCount(config))
    widthTable.packed.forEach((packed, code) => machine.setTableEntry(code, packed))
    const expected = referenceFrame(config, widthTable.packed, geometry, state, events)
    if (expected.maximumLineCount > config.lineSlots) {
      outOfContract++
      state = emptyState(config)
      machine.load(state)
      typedIndex = 0
      queue.length = 0
      continue
    }
    const actual = machine.runFrame(events)
    checked++
    keys += events.length
    maximumLines = Math.max(maximumLines, expected.display.lineCount)
    const {overflowCount: _, ...display} = actual.display
    const trimmed = {...display, glyphLine: display.glyphLine.slice(0, expected.state.length), glyphX: display.glyphX.slice(0, expected.state.length)}
    if (JSON.stringify(actual.state) !== JSON.stringify(expected.state) || JSON.stringify(trimmed) !== JSON.stringify(expected.display)) {
      mismatches++
      machine.load(expected.state)
    }
    state = expected.state
  }
  console.log('## Typing session with fake canvas widths (capacity 256, 12 line slots, 4 keys per evaluation with 1 layout slot, 320px field)\n')
  console.log(`frames checked ${checked}, keys applied ${keys}, state or display mismatches ${mismatches}, frames out of contract ${outOfContract}, table entries used ${widthTable.graphemes.length}, most lines ${maximumLines}\n`)
}

const sections: Record<string, () => void> = {
  sizes: sectionSizes,
  keys: sectionKeys,
  lines: sectionLines,
  variants: sectionVariants,
  phases: sectionPhases,
  frames: sectionEvaluationsPerFrame,
  typing: sectionTypingSession,
}

const requested = process.argv.slice(2)
for (const [name, section] of Object.entries(sections)) {
  if (requested.length === 0 || requested.includes(name)) section()
}

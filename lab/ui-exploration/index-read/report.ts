// Heavy measurements behind the README tables. Every row builds a circuit,
// compiles it, checks outputs against plain JS references (or pretext's own
// results from pretext-fixture.json), and times rough evaluations.
//
// Run: bun lab/ui-exploration/index-read/report.ts [table] [lines] [list] [variable] [compaction] [strip] [thumbnails] [floor] [depths] [event-window]
// No arguments runs every part. Results go to report-output.json in this folder
// (merged with earlier runs of other parts) and are printed as markdown tables.
import {collectFrameMismatches} from '../../event-window/harness.ts'
import {createOracleState, oracleTick} from '../../event-window/oracle.ts'
import {createBehaviorConfig, generateTrace} from '../../event-window/trace.ts'
import {buildEventWindowCircuit as buildSharedEventWindowCircuit} from '../../event-window/circuit.ts'
import {emitFloorDivide, SourceLayout} from './constructions.ts'
import {buildEventWindowCircuit, createEventWindowMachine, writeFrameInputToSource} from './event-window-circuit.ts'
import {
  type CompileMode,
  compileModes,
  compileWith,
  countWireMismatches,
  createRandom,
  medianMicroseconds,
  programStatistics,
  randomInteger,
} from './measure.ts'
import type {Circuit, Wire} from './numeric-ui-core.ts'
import {
  buildFilteredList,
  buildLineRecovery,
  buildPhotoStrip,
  buildTableRead,
  buildThumbnailTargets,
  buildVariableRowList,
  buildVirtualList,
  type PretextFixture,
  referenceFilteredList,
  referencePhotoStrip,
  referenceVariableRowList,
  referenceVirtualList,
  thumbnailFields,
} from './workloads.ts'

const requested = new Set(process.argv.slice(2))
const runPart = (name: string) => requested.size === 0 || requested.has(name)
const outputUrl = new URL('./report-output.json', import.meta.url)
const results: Record<string, unknown[]> = await Bun.file(outputUrl).exists()
  ? await Bun.file(outputUrl).json() as Record<string, unknown[]>
  : {}
const f = Math.fround

type Row = Record<string, string | number>

function timed<T>(run: () => T): [T, number] {
  const started = performance.now()
  const value = run()
  return [value, Math.round(performance.now() - started)]
}

// Compile one circuit under one mode, check it, and time it.
function measure(
  part: string,
  labels: Row,
  circuit: Circuit,
  roots: readonly Wire[],
  mode: CompileMode,
  check: (evaluate: (source: Float32Array) => Float32Array) => {checked: number, mismatches: number},
  timingSource: Float32Array,
  buildMilliseconds: number,
): Row {
  const [program, compileMilliseconds] = timed(() => compileWith(circuit, roots, mode))
  const statistics = programStatistics(program)
  const evaluate = circuit.createTensorEvaluator(roots, mode.lowerGathers, mode.options)
  const {checked, mismatches} = check(evaluate)
  const wireCheck = countWireMismatches(circuit, program, timingSource)
  const iterations = Math.max(3, Math.min(20_000, Math.round(2_000_000 / Math.max(1, statistics.liveOperations + statistics.storedWeights))))
  const microseconds = medianMicroseconds(() => { evaluate(timingSource) }, iterations, 3)
  const row: Row = {
    ...labels,
    mode: mode.label,
    buildMs: buildMilliseconds,
    compileMs: compileMilliseconds,
    sourceCells: statistics.sourceCells,
    liveOperations: statistics.liveOperations,
    layers: statistics.layers,
    storedWeights: statistics.storedWeights,
    gatherReads: statistics.gatherReads,
    bitComputes: statistics.bitComputes,
    indexComputes: statistics.indexComputes,
    indexReads: statistics.indexReads,
    tableEntries: statistics.candidateTableEntries + statistics.bitTableEntries,
    checked,
    mismatches: mismatches + wireCheck.mismatches,
    microseconds,
  }
  console.log(part, JSON.stringify(row))
  return row
}

function printTable(title: string, rows: readonly Row[], columns: readonly string[]) {
  console.log(`\n### ${title}\n`)
  console.log(`| ${columns.join(' | ')} |`)
  console.log(`| ${columns.map(() => '---').join(' | ')} |`)
  for (const row of rows) console.log(`| ${columns.map(column => String(row[column] ?? '')).join(' | ')} |`)
}

const sizeColumns = ['liveOperations', 'layers', 'storedWeights', 'gatherReads', 'indexReads', 'tableEntries', 'checked', 'mismatches', 'microseconds', 'buildMs']

// ---------------------------------------------------------------- values[index]

if (runPart('table')) {
  const rows: Row[] = []
  for (const count of [64, 1024, 10_000]) {
    const random = createRandom(count)
    const indices = [0, count - 1]
    for (let trial = 0; trial < 500; trial++) indices.push(randomInteger(random, count))
    for (const construction of ['one-hot', 'instruction'] as const) {
      const [built, buildMilliseconds] = timed(() => buildTableRead(count, construction))
      const check = (evaluate: (source: Float32Array) => Float32Array) => {
        let mismatches = 0
        const source = built.layout.table()
        for (const index of indices) {
          source[built.index] = index
          if (evaluate(source)[0] !== index) mismatches++
        }
        return {checked: indices.length, mismatches}
      }
      const timingSource = built.layout.table()
      timingSource[built.index] = Math.floor(count / 3)
      const modes = construction === 'one-hot'
        ? [compileModes.dense, compileModes.gather, compileModes.lowered]
        : [compileModes.all]
      for (const mode of modes) {
        rows.push(measure('table', {count, construction}, built.circuit, built.roots, mode, check, timingSource, buildMilliseconds))
      }
    }
  }
  results['table'] = rows
  printTable('values[index]', rows, ['count', 'construction', 'mode', ...sizeColumns])
}

// ---------------------------------------------------------------- line recovery

if (runPart('lines')) {
  const fixture = await Bun.file(new URL('./pretext-fixture.json', import.meta.url)).json() as PretextFixture
  const rows: Row[] = []
  for (const sample of fixture.samples) {
    for (const formulation of ['table-only', 'sequential', 'jumping'] as const) {
      const constructions = formulation === 'table-only'
        ? ['instruction'] as const
        : formulation === 'jumping' && sample.segmentCount > 255
          ? ['instruction'] as const
          : ['one-hot', 'instruction'] as const
      for (const construction of constructions) {
        const [built, buildMilliseconds] = timed(() =>
          buildLineRecovery(sample, fixture.lineFitEpsilon, construction, formulation))
        const statsStride = sample.segmentCount <= 63 ? 4 : sample.segmentCount <= 255 ? 16 : 64
        const check = (evaluate: (source: Float32Array) => Float32Array) => {
          let checked = 0
          let mismatches = 0
          if (formulation === 'table-only') return {checked, mismatches}
          const table = built.layout.table()
          sample.stats.forEach(([width, lineCount, maxLineWidth], index) => {
            if (index % statsStride !== 0) return
            table[built.maxWidth] = width
            const output = evaluate(table)
            checked++
            if (output[0] !== lineCount || output[1] !== f(maxLineWidth)) mismatches++
            if (formulation === 'sequential' && output[2] !== 0) mismatches++
          })
          if (formulation === 'sequential') {
            for (const {width, starts, widths} of sample.lines) {
              table[built.maxWidth] = width
              const output = evaluate(table)
              checked++
              let wrong = false
              for (let line = 0; line < starts.length; line++) {
                if (output[3 + line * 2] !== starts[line] || output[4 + line * 2] !== f(widths[line]!)) wrong = true
              }
              if (wrong) mismatches++
            }
          }
          return {checked, mismatches}
        }
        const timingSource = built.layout.table()
        timingSource[built.maxWidth] = 240
        const modes = construction === 'one-hot'
          ? [compileModes.dense, compileModes.gather, compileModes.lowered]
          : [compileModes.all]
        for (const mode of modes) {
          rows.push(measure(
            'lines',
            {segments: sample.segmentCount, window: sample.window, lineSlots: sample.lineSlots, formulation, construction},
            built.circuit,
            built.roots,
            mode,
            check,
            timingSource,
            buildMilliseconds,
          ))
        }
      }
    }
  }
  results['lines'] = rows
  printTable('line recovery', rows, ['segments', 'formulation', 'construction', 'mode', ...sizeColumns])
}

// ---------------------------------------------------------------- virtual lists

if (runPart('list')) {
  const rows: Row[] = []
  for (const rowCount of [1000, 10_000]) {
    const options = {rowCount, fieldCount: 3, slotCount: 24, rowHeight: 28}
    const random = createRandom(rowCount + 1)
    const maximum = (rowCount - 1) * options.rowHeight
    const scrollTops = [0, 27, 28, maximum - 1, maximum]
    for (let trial = 0; trial < 300; trial++) scrollTops.push(randomInteger(random, maximum + 1))
    for (const construction of ['one-hot', 'instruction'] as const) {
      const [built, buildMilliseconds] = timed(() => buildVirtualList(options, construction))
      const check = (evaluate: (source: Float32Array) => Float32Array) => {
        let mismatches = 0
        const source = built.layout.table()
        for (const scrollTop of scrollTops) {
          source[built.scrollTop] = scrollTop
          const output = evaluate(source)
          const expected = referenceVirtualList(options, scrollTop)
          if (expected.some((value, index) => output[index] !== f(value))) mismatches++
        }
        return {checked: scrollTops.length, mismatches}
      }
      const timingSource = built.layout.table()
      timingSource[built.scrollTop] = Math.floor(maximum / 3)
      const modes = construction === 'one-hot'
        ? [compileModes.dense, compileModes.gather, compileModes.lowered]
        : [compileModes.all]
      for (const mode of modes) {
        rows.push(measure('list', {rows: rowCount, slots: options.slotCount, fields: options.fieldCount, construction}, built.circuit, built.roots, mode, check, timingSource, buildMilliseconds))
      }
    }
  }
  results['list'] = rows
  printTable('fixed-height virtual list, 24 slots, 3 fields', rows, ['rows', 'construction', 'mode', ...sizeColumns])
}

if (runPart('variable')) {
  const rows: Row[] = []
  for (const rowCount of [1000, 10_000]) {
    const options = {rowCount, fieldCount: 2, slotCount: 24, rowHeight: 0}
    const random = createRandom(rowCount + 2)
    const variants = [
      ['one-hot', 'count'],
      ['instruction', 'count'],
      ['instruction', 'binary-search'],
    ] as const
    for (const [construction, formulation] of variants) {
      const [built, buildMilliseconds] = timed(() => buildVariableRowList(options, construction, formulation))
      const scrollTops = [0, 1, built.total - 1]
      for (let trial = 0; trial < 300; trial++) scrollTops.push(randomInteger(random, built.total))
      const check = (evaluate: (source: Float32Array) => Float32Array) => {
        let mismatches = 0
        const source = built.layout.table()
        for (const scrollTop of scrollTops) {
          source[built.scrollTop] = scrollTop
          const output = evaluate(source)
          const expected = referenceVariableRowList(options, scrollTop)
          if (expected.some((value, index) => output[index] !== f(value))) mismatches++
        }
        return {checked: scrollTops.length, mismatches}
      }
      const timingSource = built.layout.table()
      timingSource[built.scrollTop] = Math.floor(built.total / 3)
      const modes = construction === 'one-hot'
        ? [compileModes.gather, compileModes.lowered]
        : [compileModes.all]
      for (const mode of modes) {
        rows.push(measure('variable', {rows: rowCount, slots: options.slotCount, fields: options.fieldCount, construction, formulation}, built.circuit, built.roots, mode, check, timingSource, buildMilliseconds))
      }
    }
  }
  results['variable'] = rows
  printTable('variable-height virtual list, 24 slots, 2 fields', rows, ['rows', 'construction', 'formulation', 'mode', ...sizeColumns])
}

// ---------------------------------------------------------------- filtered list

if (runPart('compaction')) {
  const rows: Row[] = []
  for (const [itemCount, slotCount] of [[100, 10], [1000, 20], [10_000, 24]] as const) {
    const random = createRandom(itemCount + slotCount)
    const patterns: number[][] = []
    for (let trial = 0; trial < 200; trial++) {
      const density = trial % 10 === 0 ? 0 : random() * 0.3
      patterns.push(Array.from({length: itemCount}, () => (random() < density ? 1 : 0)))
    }
    const constructions = itemCount > 1000 ? ['instruction'] as const : ['one-hot', 'instruction'] as const
    for (const construction of constructions) {
      const [built, buildMilliseconds] = timed(() => buildFilteredList(itemCount, slotCount, construction))
      const check = (evaluate: (source: Float32Array) => Float32Array) => {
        let mismatches = 0
        const source = built.layout.table()
        for (const pattern of patterns) {
          pattern.forEach((bit, item) => { source[built.visible[item]!] = bit })
          const output = evaluate(source)
          const expected = referenceFilteredList(itemCount, slotCount, pattern)
          if (expected.some((value, index) => output[index] !== value)) mismatches++
        }
        return {checked: patterns.length, mismatches}
      }
      const timingSource = built.layout.table()
      patterns[3]!.forEach((bit, item) => { timingSource[built.visible[item]!] = bit })
      rows.push(measure('compaction', {items: itemCount, slots: slotCount, construction}, built.circuit, built.roots, compileModes.all, check, timingSource, buildMilliseconds))
    }
  }
  results['compaction'] = rows
  printTable('filtered list: the first slotCount visible items', rows, ['items', 'slots', 'construction', ...sizeColumns])
}

// ---------------------------------------------------------------- photo strip

if (runPart('strip')) {
  const rows: Row[] = []
  for (const photoCount of [12, 221, 1024]) {
    const random = createRandom(photoCount + 3)
    const focusedIndices = [0, photoCount - 1]
    for (let trial = 0; trial < 60; trial++) focusedIndices.push(randomInteger(random, photoCount))
    for (const construction of ['source-one-hot', 'one-hot', 'instruction'] as const) {
      const [built, buildMilliseconds] = timed(() => buildPhotoStrip(photoCount, construction))
      const writeFocus = (source: Float32Array, focused: number) => {
        if (construction === 'source-one-hot') {
          for (let photo = 0; photo < photoCount; photo++) source[built.focus[photo]!] = photo === focused ? 1 : 0
        } else {
          source[built.focus[0]!] = focused
        }
      }
      const check = (evaluate: (source: Float32Array) => Float32Array) => {
        let mismatches = 0
        const source = built.layout.table()
        for (const focused of focusedIndices) {
          writeFocus(source, focused)
          const stripHeight = 40 + (focused % 7) * 31
          source[built.stripHeight] = stripHeight
          const output = evaluate(source)
          const expected = referencePhotoStrip(photoCount, focused, stripHeight, 1280, 12)
          if (expected.some((value, index) => output[index] !== value)) mismatches++
        }
        return {checked: focusedIndices.length, mismatches}
      }
      const timingSource = built.layout.table()
      writeFocus(timingSource, Math.floor(photoCount / 3))
      const modes = construction === 'one-hot'
        ? [compileModes.dense, compileModes.gather, compileModes.lowered]
        : [compileModes.all]
      for (const mode of modes) {
        rows.push(measure('strip', {photos: photoCount, construction}, built.circuit, built.roots, mode, check, timingSource, buildMilliseconds))
      }
    }
  }
  results['strip'] = rows
  printTable('photo strip centered on the focused photo', rows, ['photos', 'construction', 'mode', ...sizeColumns])
}

if (runPart('thumbnails')) {
  const rows: Row[] = []
  for (const photoCount of [12, 221, 1024]) {
    for (const construction of ['source-one-hot-constants', 'instruction'] as const) {
      const [built, buildMilliseconds] = timed(() => buildThumbnailTargets(photoCount, construction))
      const writeFocus = (source: Float32Array, focused: number) => {
        if (construction === 'instruction') {
          source[built.focus[0]!] = focused
        } else {
          for (let photo = 0; photo < photoCount; photo++) source[built.focus[photo]!] = photo === focused ? 1 : 0
        }
      }
      const focusedIndices = [0, 1, photoCount - 1, Math.floor(photoCount / 2), Math.floor(photoCount / 3)]
      const check = (evaluate: (source: Float32Array) => Float32Array) => {
        let mismatches = 0
        const source = built.layout.table()
        for (const focused of focusedIndices) {
          writeFocus(source, focused)
          const output = evaluate(source)
          for (let item = 0; item < photoCount; item++) {
            const expected = thumbnailFields(item, focused, photoCount)
            if (expected.some((value, field) => output[item * 3 + field] !== f(value))) mismatches++
          }
        }
        return {checked: focusedIndices.length * photoCount, mismatches}
      }
      const timingSource = built.layout.table()
      writeFocus(timingSource, 5)
      rows.push(measure('thumbnails', {photos: photoCount, construction}, built.circuit, built.roots, compileModes.all, check, timingSource, buildMilliseconds))
    }
  }
  results['thumbnails'] = rows
  printTable('thumbnail strip targets (offset, distance, spread per thumbnail)', rows, ['photos', 'construction', ...sizeColumns])
}

// ---------------------------------------------------------------- floor division

if (runPart('floor')) {
  // How often floor(fround(fround(1 / rowHeight) * scrollTop)) misses the row,
  // checked at every multiple of the height and one below it, where it can.
  const failingHeights: number[] = []
  const examples: string[] = []
  for (let rowHeight = 1; rowHeight <= 512; rowHeight++) {
    const reciprocal = f(1 / rowHeight)
    let missed = false
    for (let row = 0; row * rowHeight <= 2 ** 21; row++) {
      for (const scrollTop of [row * rowHeight, row * rowHeight - 1]) {
        if (scrollTop < 0) continue
        const approximate = Math.floor(f(reciprocal * scrollTop))
        if (approximate !== Math.floor(scrollTop / rowHeight)) {
          if (!missed && examples.length < 4) {
            examples.push(`height ${rowHeight} at scrollTop ${scrollTop} gives row ${approximate}, not ${Math.floor(scrollTop / rowHeight)}`)
          }
          missed = true
        }
      }
    }
    if (missed) failingHeights.push(rowHeight)
  }
  let correctedChecks = 0
  let correctedMismatches = 0
  let construction: Row = {}
  for (const rowHeight of failingHeights.slice(0, 10)) {
    const layout = new SourceLayout()
    const numerator = layout.cell(0, 0, 2 ** 21)
    const circuit = layout.createCircuit()
    const quotient = emitFloorDivide(circuit, numerator, rowHeight)
    const statistics = programStatistics(circuit.compileTensorProgram([quotient]))
    construction = {liveOperations: statistics.liveOperations, layers: statistics.layers, storedWeights: statistics.storedWeights}
    const evaluate = circuit.createTensorEvaluator([quotient])
    const source = new Float32Array(1)
    for (let row = 0; row * rowHeight <= 2 ** 21; row++) {
      for (const scrollTop of [row * rowHeight, row * rowHeight - 1]) {
        if (scrollTop < 0) continue
        source[0] = scrollTop
        correctedChecks++
        if (evaluate(source)[0] !== Math.floor(scrollTop / rowHeight)) correctedMismatches++
      }
    }
  }
  const row: Row = {
    heightsChecked: 512,
    heightsWithMissedRows: failingHeights.length,
    examples: examples.join('; '),
    correctedHeights: Math.min(10, failingHeights.length),
    correctedChecks,
    correctedMismatches,
    ...construction,
  }
  console.log('floor', JSON.stringify(row))
  results['floor'] = [row]
  printTable('floor division of integer scroll offsets', [row], Object.keys(row))
}

// ---------------------------------------------------------------- depths

if (runPart('depths')) {
  const fixture = await Bun.file(new URL('./pretext-fixture.json', import.meta.url)).json() as PretextFixture
  const rows: Row[] = []
  const variants = [
    ['bit gather, build-time depths', {lowerIndexOneHots: false, inferBitFamilies: false, recomputeDepths: false}],
    ['bit gather, recomputed depths', {lowerIndexOneHots: false, inferBitFamilies: false, recomputeDepths: true}],
    ['recognized, build-time depths', {lowerIndexOneHots: true, inferBitFamilies: false, recomputeDepths: false}],
    ['recognized, recomputed depths', {lowerIndexOneHots: true, inferBitFamilies: false, recomputeDepths: true}],
  ] as const
  for (const [sampleIndex, formulation] of [[0, 'sequential'], [1, 'sequential'], [2, 'sequential'], [0, 'jumping'], [1, 'jumping']] as const) {
    const sample = fixture.samples[sampleIndex]!
    const built = buildLineRecovery(sample, fixture.lineFitEpsilon, 'one-hot', formulation)
    const row: Row = {segments: sample.segmentCount, formulation}
    for (const [label, options] of variants) {
      row[label] = programStatistics(built.circuit.compileTensorProgram(built.roots, true, options)).layers
    }
    console.log('depths', JSON.stringify(row))
    rows.push(row)
  }
  results['depths'] = rows
  printTable('layers of line recovery with the relu one-hot', rows, ['segments', 'formulation', ...variants.map(([label]) => label)])
}

// ---------------------------------------------------------------- event-window

if (runPart('event-window')) {
  const rows: Row[] = []
  {
    const {circuit, output} = buildSharedEventWindowCircuit('exact')
    const program = circuit.compileTensorProgram([...output.nextSource, ...output.displayed, ...output.dragOwner])
    let storedWeights = 0
    let gatherReads = 0
    for (const layer of program.layers) {
      storedWeights += layer.weights.length
      gatherReads += layer.gatherReads.length
    }
    const row: Row = {runtime: 'shared numeric-ui-core.ts', mode: 'default', liveOperations: program.valueCount - circuit.sourceSize, layers: program.layers.length, storedWeights, gatherReads, groups: circuit.oneHotGroups.length}
    console.log(JSON.stringify(row))
    rows.push(row)
  }
  const {circuit, output} = buildEventWindowCircuit('exact')
  const roots = [...output.nextSource, ...output.displayed, ...output.dragOwner]
  const programs = [compileModes.dense, compileModes.gather, compileModes.all, compileModes.allWithSelects].map(mode =>
    ({mode, program: compileWith(circuit, roots, mode)}))
  let framesChecked = 0
  const mismatchesByMode = programs.map(() => 0)
  let oracleMismatches = 0
  for (const seed of [21, 22]) {
    const config = createBehaviorConfig(seed * 104_729 + 1)
    const trace = generateTrace(config, seed, 10_000)
    const machine = createEventWindowMachine(config)
    const state = createOracleState(config)
    for (const input of trace) {
      const steppedSource = new Float32Array(machine.source)
      writeFrameInputToSource(input, steppedSource)
      programs.forEach(({program}, index) => {
        mismatchesByMode[index]! += countWireMismatches(machine.circuit, program, steppedSource).mismatches
      })
      if (collectFrameMismatches(machine.step(input), oracleTick(config, state, input)).length > 0) oracleMismatches++
      framesChecked++
    }
  }
  const timingSource = createEventWindowMachine(createBehaviorConfig(3)).source
  programs.forEach(({mode, program}, index) => {
    const statistics = programStatistics(program)
    const evaluate = circuit.createTensorEvaluator(roots, mode.lowerGathers, mode.options)
    const source = timingSource
    const row: Row = {
      runtime: 'index-read copy',
      mode: mode.label,
      liveOperations: statistics.liveOperations,
      layers: statistics.layers,
      storedWeights: statistics.storedWeights,
      gatherReads: statistics.gatherReads,
      bitComputes: statistics.bitComputes,
      groups: circuit.oneHotGroups.length,
      framesChecked,
      wireMismatches: mismatchesByMode[index]!,
      oracleMismatches,
      microseconds: medianMicroseconds(() => { evaluate(source) }, 5000, 3),
    }
    console.log(JSON.stringify(row))
    rows.push(row)
  })
  results['event-window'] = rows
  printTable('event-window', rows, ['runtime', 'mode', 'liveOperations', 'layers', 'storedWeights', 'gatherReads', 'bitComputes', 'framesChecked', 'wireMismatches', 'oracleMismatches', 'microseconds'])
}

// Re-read right before writing, so parts run by separate processes keep each
// other's results.
const latest: Record<string, unknown[]> = await Bun.file(outputUrl).exists()
  ? await Bun.file(outputUrl).json() as Record<string, unknown[]>
  : {}
for (const part of ['table', 'lines', 'list', 'variable', 'compaction', 'strip', 'thumbnails', 'floor', 'depths', 'event-window']) {
  if (runPart(part) && results[part] !== undefined) latest[part] = results[part]
}
await Bun.write(outputUrl, JSON.stringify(latest, null, 1))

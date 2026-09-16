// Heavy measurements for the README: stage and circuit sizes, differential traces against index.ts
// and gallery-circuit.ts, fold order effects, scaling to 1,000 and 10,000 photos, and IndirectOS.
// Run: bun lab/ui-exploration/instanced-items/report.ts [section ...]
// Sections: sizes, traces, orders, scaling, precision, indirect-os, rebuild. Without arguments, every section runs
// (several minutes; the 10,000-photo duplicated circuit needs about 3 GB of heap). Results merge
// into results.json. Run one process at a time: each process rewrites results.json from what it read at start.
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {createWindowManagerMachine} from '../codegen/window-manager-copy.ts'
import {createExecutor} from './executor.ts'
import {createDuplicatedMachine, expandDuplicated, measureCircuit, type PrefixLowering} from './expand.ts'
import {FakeBrowser} from '../gallery/fake-dom.ts'
import {buildGalleryCircuit, springNames, type GalleryCircuitOptions} from '../gallery/gallery-circuit.ts'
import {runScenario, scriptedTrace, type DifferentialReport} from './gallery-differential.ts'
import {createDuplicatedEngine, createOriginalEngine, createStagedEngine, createTeeEngine, createTeeStats, summarizeTee, type GalleryEngine} from './gallery-engine.ts'
import {initializeEngine} from './gallery-host.ts'
import {buildStagedGallery, sharedCellNames, springFields, type StagedGalleryOptions} from './gallery-staged.ts'
import {applySession, cellTable, outputTable, runIndirectOSComparison, sessionFrames, sessionFrameTime} from './indirect-os-compare.ts'
import {createStagedIndirectOSMachine} from './indirect-os-staged.ts'
import {photoGalleryData, type PhotoData} from '../gallery/photo-data.ts'
import {createReferenceGallery} from '../gallery/reference.ts'
import {stageStats, type StagedProgram} from './staged.ts'
import {syntheticPhotos} from './synthetic-photos.ts'

const resultsUrl = new URL('results.json', import.meta.url)
const output: Record<string, unknown> = existsSync(resultsUrl) ? JSON.parse(readFileSync(resultsUrl, 'utf8')) as Record<string, unknown> : {}
const log = (label: string, value: unknown) => {
  output[label] = value
  console.log(`\n=== ${label}`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
  writeFileSync(resultsUrl, `${JSON.stringify(output, null, 1)}\n`)
}
const requested = process.argv.slice(2)
const wants = (name: string) => requested.length === 0 || requested.includes(name)

function microsecondsPerCall(run: () => void, minimumWarmRuns = 100, warmMilliseconds = 1500) {
  const warmStart = performance.now()
  let warmRuns = 0
  while (performance.now() - warmStart < warmMilliseconds || warmRuns < minimumWarmRuns) {
    run()
    warmRuns++
  }
  const samples: number[] = []
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now()
    let runs = 0
    while (performance.now() - start < 100 || runs < 3) {
      run()
      runs++
    }
    samples.push((performance.now() - start) / runs * 1000)
  }
  return Number(samples.sort((left, right) => left - right)[3]!.toFixed(1))
}

function stageTable(program: StagedProgram) {
  return program.steps.map(step => step.kind === 'stage'
    ? stageStats(program, step.stage)
    : {name: step.reduction.name, kind: step.reduction.kind, ...(step.reduction.kind === 'prefix' ? {order: step.reduction.order} : {})})
}

function perAxisOperations(program: StagedProgram) {
  const totals: Record<string, number> = {}
  for (const step of program.steps) {
    if (step.kind !== 'stage') continue
    const stats = stageStats(program, step.stage)
    totals[stats.axis] = (totals[stats.axis] ?? 0) + stats.liveOperations
  }
  return totals
}

// A mid-animation state: open photo 40 and step five frames.
function prepareAnimatingState(engine: GalleryEngine, photos: readonly PhotoData[]) {
  initializeEngine(engine, photos, 1440, 900, 0)
  engine.setCell('focusedIndex', 40)
  engine.setCell('focusedPresent', 1)
  for (let frame = 0; frame < 5; frame++) {
    engine.setCell('frameDuration', 16.5)
    engine.step()
  }
}

function copyEngineState(from: GalleryEngine, to: GalleryEngine) {
  for (const name of sharedCellNames) to.setCell(name, from.getCell(name))
  for (let index = 0; index < from.count; index++) {
    for (const spring of springNames) for (const field of springFields) to.setSpring(index, spring, field, from.getSpring(index, spring, field))
  }
}

function summarizeTraces(reports: DifferentialReport[]) {
  const errors: Record<string, number> = {}
  for (const report of reports) for (const [kind, stat] of Object.entries(report.errors)) errors[kind] = Math.max(errors[kind] ?? 0, stat.maximumAbsolute)
  const sum = (pick: (report: DifferentialReport) => number) => reports.reduce((total, report) => total + pick(report), 0)
  const sumRecords = (pick: (report: DifferentialReport) => Record<string, number>) => {
    const totals: Record<string, number> = {}
    for (const report of reports) for (const [kind, count] of Object.entries(pick(report))) totals[kind] = (totals[kind] ?? 0) + count
    return totals
  }
  return {
    traces: reports.length,
    frames: sum(report => report.frames),
    framesIn1D: sum(report => report.framesIn1D),
    animatingFrames: sum(report => report.animatingFrames),
    events: sumRecords(report => report.events),
    decisionChecks: sum(report => report.decisionChecks),
    decisionMismatches: sum(report => report.decisionMismatches),
    'how often index.ts changed each decision': sumRecords(report => report.referenceChanges),
    firstMismatches: reports.flatMap(report => report.firstMismatches).slice(0, 5),
    maximumAbsoluteErrors: errors,
  }
}

function compactTee(stats: ReturnType<typeof createTeeStats>) {
  const summary = summarizeTee(stats)
  return {
    frames: summary.frames,
    compared: summary.compared,
    identical: summary.identical,
    identicalFraction: Number((summary.identical / summary.compared).toFixed(4)),
    decisionMismatches: summary.decisionMismatches,
    firstDecisionMismatches: summary.firstDecisionMismatches,
    outputs: Object.fromEntries(Object.entries(summary.outputs).map(([name, entry]) => [name, {identical: entry.identical, compared: entry.compared, maximumDifference: entry.maximumDifference}])),
  }
}

// === sizes: the staged gallery's stages, its duplicated circuit, and gallery-circuit.ts, at 221 photos
if (wants('sizes')) {
  const staged = buildStagedGallery(photoGalleryData)
  log('staged gallery at 221 photos: stages and reductions', stageTable(staged.program))
  log('staged gallery at 221 photos: live operations per axis (map stages over photos run once per photo)', perAxisOperations(staged.program))
  const configurations: [string, StagedGalleryOptions, PrefixLowering][] = [
    ['sequential prefix sums, triangle lowering', {}, 'triangle'],
    ['sequential prefix sums, chain lowering', {}, 'chain'],
    ['Brent-Kung prefix sums', {prefixOrder: 'brent-kung'}, 'triangle'],
  ]
  log('duplicated circuit of the staged gallery at 221 photos', configurations.map(([name, options, prefixLowering]) => {
    const program = buildStagedGallery(photoGalleryData, options).program
    const {liveOperations, layers, storedWeights, gatherReads, widestLayer} = measureCircuit(expandDuplicated(program, {prefixLowering}).circuit, expandDuplicated(program, {prefixLowering}).roots)
    return {name, liveOperations, layers, storedWeights, gatherReads, widestLayer}
  }))
  log('gallery-circuit.ts at 221 photos', ([['triangle prefix sums (default)', {}], ['Brent-Kung prefix sums', {prefixMode: 'brent-kung'}]] as [string, GalleryCircuitOptions][]).map(([name, options]) => {
    const built = buildGalleryCircuit(photoGalleryData, options)
    const {liveOperations, layers, storedWeights, gatherReads, widestLayer} = measureCircuit(built.circuit, built.roots)
    return {name, liveOperations, layers, storedWeights, gatherReads, widestLayer}
  }))
}

// === traces: decisions against index.ts, and every output against gallery-circuit.ts frame by frame
if (wants('traces')) {
  const staged = buildStagedGallery(photoGalleryData)
  const original = buildGalleryCircuit(photoGalleryData)
  const viewports = [[1440, 900], [390, 844], [2560, 1400], [800, 600], [1024, 1366], [1920, 1080]] as const
  for (const durations of ['dyadic', 'realistic'] as const) {
    const stats = createTeeStats()
    const reports = viewports.map(([width, height], index) => runScenario({
      seed: 5000 + index, frames: 600, width, height, durations, photos: photoGalleryData,
      engine: createTeeEngine(createStagedEngine(staged, createExecutor(staged.program)), createOriginalEngine(original), stats),
    }))
    log(`6 random traces of 600 frames, ${durations} frame times, free-running: staged program against index.ts`, summarizeTraces(reports))
    log(`the same ${durations} traces: staged program against gallery-circuit.ts, one evaluation from identical cells per frame`, compactTee(stats))
  }
  const scriptedStats = createTeeStats()
  const scripted = runScenario({
    seed: 0, frames: 420, width: 1440, height: 900, photos: photoGalleryData, script: scriptedTrace,
    engine: createTeeEngine(createStagedEngine(staged, createExecutor(staged.program)), createOriginalEngine(original), scriptedStats),
  })
  log('scripted trace: staged program against index.ts', summarizeTraces([scripted]))
  log('scripted trace: staged program against gallery-circuit.ts', compactTee(scriptedStats))
  const duplicatedStats = createTeeStats()
  const duplicated = [1, 2].map(seed => runScenario({
    seed, frames: 300, width: seed === 1 ? 1440 : 390, height: 900, durations: 'dyadic', photos: photoGalleryData,
    engine: createTeeEngine(createStagedEngine(staged, createExecutor(staged.program)), createDuplicatedEngine(staged, createDuplicatedMachine(expandDuplicated(staged.program))), duplicatedStats),
  }))
  log('2 random traces of 300 frames: staged executor against the staged program\'s duplicated circuit', {...compactTee(duplicatedStats), decisionMismatchesAgainstIndexTs: duplicated.reduce((total, report) => total + report.decisionMismatches, 0)})
}

// === orders: what changing a reduction's fold order does to the outputs
if (wants('orders')) {
  const sequential = buildStagedGallery(photoGalleryData)
  const brentKung = buildStagedGallery(photoGalleryData, {prefixOrder: 'brent-kung'})
  const original = buildGalleryCircuit(photoGalleryData)
  const pairs: [string, () => GalleryEngine, () => GalleryEngine][] = [
    ['staged, sequential prefix sums, against staged, Brent-Kung prefix sums', () => createStagedEngine(sequential, createExecutor(sequential.program)), () => createStagedEngine(brentKung, createExecutor(brentKung.program))],
    ['staged, Brent-Kung prefix sums, against gallery-circuit.ts', () => createStagedEngine(brentKung, createExecutor(brentKung.program)), () => createOriginalEngine(original)],
    ['staged, Brent-Kung prefix sums, against its duplicated circuit', () => createStagedEngine(brentKung, createExecutor(brentKung.program)), () => createDuplicatedEngine(brentKung, createDuplicatedMachine(expandDuplicated(brentKung.program)))],
  ]
  for (const [name, primary, secondary] of pairs) {
    const stats = createTeeStats()
    const report = runScenario({seed: 0, frames: 420, width: 1440, height: 900, photos: photoGalleryData, script: scriptedTrace, engine: createTeeEngine(primary(), secondary(), stats)})
    log(`fold orders, scripted trace: ${name}`, {...compactTee(stats), decisionMismatchesAgainstIndexTs: report.decisionMismatches})
  }
}

// === scaling: 221, 1,000 and 10,000 photos through every CPU executor
if (wants('scaling')) {
  const rows: Record<string, unknown>[] = []
  for (const count of [221, 1000, 10_000]) {
    const photos = count === 221 ? photoGalleryData : syntheticPhotos(count)
    const options: StagedGalleryOptions = count === 221 ? {prefixOrder: 'brent-kung'} : {prefixOrder: 'brent-kung', coordinateLimit: 2 ** 24}
    let start = performance.now()
    const staged = buildStagedGallery(photos, options)
    const buildMilliseconds = performance.now() - start
    start = performance.now()
    const executor = createExecutor(staged.program)
    const executorMilliseconds = performance.now() - start
    const engine = createStagedEngine(staged, executor)
    prepareAnimatingState(engine, photos)
    const sharedSnapshot = new Float32Array(executor.shared)
    const columnSnapshot = executor.columns.map(column => column === null ? null : new Float32Array(column))
    const restore = () => {
      executor.shared.set(sharedSnapshot)
      executor.columns.forEach((column, index) => {
        if (column !== null) column.set(columnSnapshot[index]!)
      })
    }
    const stagedMicroseconds = microsecondsPerCall(() => {
      restore()
      executor.step()
    })
    const byStep = new Map<string, number>()
    for (let run = 0; run < 50; run++) {
      restore()
      executor.timedStep(byStep)
    }
    const slowestSteps = [...byStep].sort(([, left], [, right]) => right - left).slice(0, 8).map(([name, total]) => ({step: name, microseconds: Number((total / 50 * 1000).toFixed(1))}))
    restore()
    start = performance.now()
    const duplicated = expandDuplicated(staged.program)
    const expandMilliseconds = performance.now() - start
    start = performance.now()
    const size = measureCircuit(duplicated.circuit, duplicated.roots)
    const compileMilliseconds = performance.now() - start
    const duplicatedEngine = createDuplicatedEngine(staged, createDuplicatedMachine(duplicated))
    copyEngineState(engine, duplicatedEngine)
    const source = new Float32Array(duplicated.circuit.sourceSize)
    duplicated.sourceLayout.forEach(({value, instance}, wire) => {
      source[wire] = executor.get(staged.program.handle(value), instance)
    })
    const evaluate = duplicated.circuit.createTensorEvaluator(duplicated.roots)
    const duplicatedMicroseconds = microsecondsPerCall(() => evaluate(source), 5, count >= 10_000 ? 5000 : 1500)
    const referenceBrowser = new FakeBrowser(1440, 900)
    const reference = createReferenceGallery(referenceBrowser, [...photos])
    let now = 1000
    let frame = 0
    const referenceMicroseconds = microsecondsPerCall(() => {
      if (frame % 40 === 0) referenceBrowser.hash = frame % 80 === 0 ? `#${photos[40]!.id}` : ''
      frame++
      now += 16.5
      reference.render(now)
    }, 20)
    let originalRow: Record<string, unknown> = {}
    if (count <= 1000) {
      const built = buildGalleryCircuit(photos, {prefixMode: 'brent-kung'})
      const originalSize = measureCircuit(built.circuit, built.roots)
      const originalEngine = createOriginalEngine(built)
      prepareAnimatingState(originalEngine, photos)
      const originalSource = new Float32Array(built.layout.size)
      for (const name of sharedCellNames) originalSource[built.cells[name]] = originalEngine.getCell(name)
      for (let index = 0; index < count; index++) {
        for (const spring of springNames) for (const field of springFields) originalSource[built.cells.photos[index]!.springs[spring][field]] = originalEngine.getSpring(index, spring, field)
      }
      const originalEvaluate = built.circuit.createTensorEvaluator(built.roots)
      originalRow = {originalLiveOperations: originalSize.liveOperations, originalLayers: originalSize.layers, originalStoredWeights: originalSize.storedWeights, originalExecutorMicroseconds: microsecondsPerCall(() => originalEvaluate(originalSource), 5)}
    }
    const row = {
      photos: count,
      stagedBuildMilliseconds: Math.round(buildMilliseconds),
      stagedExecutorCreateMilliseconds: Math.round(executorMilliseconds),
      stagedMicroseconds,
      stagedPerPhotoOperations: perAxisOperations(staged.program)['photos'],
      slowestSteps,
      duplicatedExpandMilliseconds: Math.round(expandMilliseconds),
      duplicatedCompileMilliseconds: Math.round(compileMilliseconds),
      duplicatedLiveOperations: size.liveOperations,
      duplicatedLayers: size.layers,
      duplicatedStoredWeights: size.storedWeights,
      duplicatedExecutorMicroseconds: duplicatedMicroseconds,
      ...originalRow,
      indexTsRenderMicroseconds: referenceMicroseconds,
      heapMegabytes: Math.round(process.memoryUsage().heapUsed / 1e6),
    }
    rows.push(row)
    log(`scaling, ${count} photos (Brent-Kung prefix sums, mid-animation frame)`, row)
  }
  log('scaling summary', rows)
}

// === precision: decisions against index.ts on synthetic photos, where page coordinates pass a million pixels
if (wants('precision')) {
  for (const stale of ['1000 synthetic photos, 2 random traces of 300 frames: staged program against index.ts', '10000 synthetic photos, 2 random traces of 120 frames: staged program against index.ts']) delete output[stale]
  for (const [count, frames] of [[1000, 300], [10_000, 120]] as const) {
    const photos = syntheticPhotos(count)
    for (const prefixOrder of ['sequential', 'brent-kung'] as const) {
      const staged = buildStagedGallery(photos, {coordinateLimit: 2 ** 24, prefixOrder})
      for (const resync of [false, true]) {
        const reports = [0, 1].map(seed => runScenario({
          seed: 7000 + seed, frames, width: seed === 0 ? 1440 : 2560, height: seed === 0 ? 900 : 1400, durations: 'dyadic', eventRate: 2, resync, photos,
          engine: createStagedEngine(staged, createExecutor(staged.program)),
        }))
        // The summary keeps maxima over both traces; perTrace keeps each seed's own maxima, so errors can be attributed to a seed.
        const perTrace = reports.map((report, index) => ({
          seed: 7000 + index,
          viewport: index === 0 ? '1440x900' : '2560x1400',
          decisionChecks: report.decisionChecks,
          decisionMismatches: report.decisionMismatches,
          maximumAbsoluteErrors: Object.fromEntries(Object.entries(report.errors).map(([kind, stat]) => [kind, stat.maximumAbsolute])),
          worst: Object.fromEntries(['destination x', 'destination y', 'style transform'].map(kind => [kind, report.errors[kind]?.worst ?? ''])),
        }))
        log(`${count} synthetic photos, ${prefixOrder} prefix sums, 2 random traces of ${frames} frames, ${resync ? 'state copied from index.ts every frame' : 'free-running'}: staged program against index.ts`, {...summarizeTraces(reports), perTrace})
      }
    }
  }
}

const pickSize = ({liveOperations, layers, storedWeights, gatherReads, widestLayer}: ReturnType<typeof measureCircuit>) => ({liveOperations, layers, storedWeights, gatherReads, widestLayer})

function summarizeIndirectOS(result: ReturnType<typeof runIndirectOSComparison>) {
  return {
    frames: result.frames, compared: result.compared, identical: result.identical, decisionMismatches: result.decisionMismatches,
    differing: Object.fromEntries([...result.byLabel].filter(([, entry]) => entry.identical !== entry.compared).map(([label, entry]) => [label, {identical: entry.identical, compared: entry.compared, maximumDifference: entry.maximumDifference}])),
  }
}

// === IndirectOS: sizes and the frame-by-frame comparison with window-manager.ts
if (wants('indirect-os')) {
  const free = runIndirectOSComparison({resync: false})
  const resynced = runIndirectOSComparison({resync: true})
  const originalSize = measureCircuit(free.original.circuit, [...free.original.tensorProgram.roots])
  const duplicated = expandDuplicated(free.staged.built.program)
  const stagedSize = measureCircuit(duplicated.circuit, duplicated.roots)
  log('IndirectOS sizes', {'window-manager.ts': pickSize(originalSize), 'staged program, duplicated circuit': pickSize(stagedSize), 'staged program, live operations per axis': perAxisOperations(free.staged.built.program)})
  log('IndirectOS staged stages and reductions', stageTable(free.staged.built.program))
  log('IndirectOS against window-manager.ts, free-running', summarizeIndirectOS(free))
  log('IndirectOS against window-manager.ts, cells copied every frame', summarizeIndirectOS(resynced))
  const warmState = free.staged.executor
  log('IndirectOS rough µs per evaluation', {
    'window-manager.ts executor (evaluateTensor, no validation)': microsecondsPerCall(() => free.original.circuit.evaluateTensor(free.original.source)),
    'staged executor (generated JS per stage)': microsecondsPerCall(() => warmState.step()),
  })
}

// === rebuild: what rebuilding exported small affines at stage boundaries changes on the workloads,
// measured by building each program again with the rebuild off
if (wants('rebuild')) {
  const duplicatedSize = (program: StagedProgram) => {
    const duplicated = expandDuplicated(program)
    return pickSize(measureCircuit(duplicated.circuit, duplicated.roots))
  }
  const photoStages = (program: StagedProgram) => Object.fromEntries(program.steps.flatMap(step => step.kind === 'stage' && step.stage.axis === 'photos' ? [[step.stage.name, stageStats(program, step.stage).liveOperations]] : []))
  log('rebuild rule, gallery at 221 photos (sequential prefix sums as triangles): sizes', Object.fromEntries(([true, false] as const).map(rebuildSmallAffines => {
    const {program} = buildStagedGallery(photoGalleryData, {rebuildSmallAffines})
    return [rebuildSmallAffines ? 'with the rule' : 'without the rule', {operationsPerAxis: perAxisOperations(program), photoStages: photoStages(program), duplicated: duplicatedSize(program)}]
  })))
  const original = buildGalleryCircuit(photoGalleryData)
  for (const prefixOrder of ['sequential', 'brent-kung'] as const) {
    const withRule = buildStagedGallery(photoGalleryData, {prefixOrder})
    const withoutRule = buildStagedGallery(photoGalleryData, {prefixOrder, rebuildSmallAffines: false})
    const pairs: [string, () => GalleryEngine, () => GalleryEngine][] = [
      ['with the rule, against gallery-circuit.ts', () => createStagedEngine(withRule, createExecutor(withRule.program)), () => createOriginalEngine(original)],
      ['without the rule, against gallery-circuit.ts', () => createStagedEngine(withoutRule, createExecutor(withoutRule.program)), () => createOriginalEngine(original)],
      ['without the rule, against with the rule', () => createStagedEngine(withoutRule, createExecutor(withoutRule.program)), () => createStagedEngine(withRule, createExecutor(withRule.program))],
      ['without the rule, against its own duplicated circuit', () => createStagedEngine(withoutRule, createExecutor(withoutRule.program)), () => createDuplicatedEngine(withoutRule, createDuplicatedMachine(expandDuplicated(withoutRule.program)))],
    ]
    for (const [name, primary, secondary] of pairs) {
      const stats = createTeeStats()
      const report = runScenario({seed: 0, frames: 420, width: 1440, height: 900, photos: photoGalleryData, script: scriptedTrace, engine: createTeeEngine(primary(), secondary(), stats)})
      log(`rebuild rule, scripted trace, ${prefixOrder} prefix sums: ${name}`, {...compactTee(stats), decisionMismatchesAgainstIndexTs: report.decisionMismatches})
    }
  }

  // IndirectOS: both staged programs through the session, free-running, compared on every output and next cell.
  const withMachine = createStagedIndirectOSMachine()
  const withoutMachine = createStagedIndirectOSMachine({rebuildSmallAffines: false})
  const tableMachine = createWindowManagerMachine()
  const comparedValues = (machine: typeof withMachine) => [
    ...outputTable(tableMachine, machine).map(({label, value, instance}) => ({label, value, instance})),
    ...cellTable(machine).map(({label, value, instance}) => ({label: `next ${label}`, value, instance})),
  ]
  const withValues = comparedValues(withMachine)
  const withoutValues = comparedValues(withoutMachine)
  const byLabel: Record<string, {compared: number, identical: number, maximumDifference: number}> = {}
  let compared = 0
  let identical = 0
  for (let frame = 0; frame < sessionFrames; frame++) {
    for (const machine of [withMachine, withoutMachine]) {
      applySession(machine, frame)
      machine.step(1280, 800, sessionFrameTime(frame))
    }
    withValues.forEach((entry, index) => {
      const other = withoutValues[index]!
      const left = withMachine.executor.get(entry.value, entry.instance)
      const right = withoutMachine.executor.get(other.value, other.instance)
      const stat = byLabel[entry.label] ??= {compared: 0, identical: 0, maximumDifference: 0}
      stat.compared++
      compared++
      if (left === right) {
        stat.identical++
        identical++
      } else {
        stat.maximumDifference = Math.max(stat.maximumDifference, Math.abs(left - right))
      }
    })
  }
  log('rebuild rule, IndirectOS', {
    'with the rule': {operationsPerAxis: perAxisOperations(withMachine.built.program), duplicated: duplicatedSize(withMachine.built.program)},
    'without the rule': {
      operationsPerAxis: perAxisOperations(withoutMachine.built.program),
      duplicated: duplicatedSize(withoutMachine.built.program),
      'against window-manager.ts, free-running': summarizeIndirectOS(runIndirectOSComparison({resync: false, rebuildSmallAffines: false})),
      'against window-manager.ts, cells copied every frame': summarizeIndirectOS(runIndirectOSComparison({resync: true, rebuildSmallAffines: false})),
    },
    'without the rule against with the rule, free-running over the session': {
      frames: sessionFrames, compared, identical,
      differing: Object.fromEntries(Object.entries(byLabel).filter(([, stat]) => stat.identical !== stat.compared)),
    },
  })
}

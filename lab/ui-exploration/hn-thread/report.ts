// Heavy measurements for the README. Run from the repo root:
//   bun lab/ui-exploration/hn-thread/report.ts            (everything, writes results.json)
//   bun lab/ui-exploration/hn-thread/report.ts scale      (one section: scale, variants, breakpoints, differential, slots,
//                                                          codegen; replaces only that section's entries in results.json)
// CPU timings are rough: other processes share the machine. Prefer the counts.

import {installFakeCanvas} from './fake-canvas.ts'
import {thread} from './hn-data.ts'
import {prepareThread, initialThreadState, type PreparedThread} from './thread-prepare.ts'
import {commentTextHeight, commentWidthAt, staircaseHeight} from './text-heights.ts'
import {buildThreadCircuit, createThreadMachine, programStats, writeInputs, type ThreadCircuitOptions} from './thread-circuit.ts'
import {referenceFrame, type FrameInputs} from './thread-frame.ts'
import {randomInputs, randomState, runScenarioDifferential, runSingleFrameDifferential, runTargetedSweep, seededRandom, type DifferentialSummary} from './differential.ts'
import {generateProgram} from './codegen.ts'
import {threadLayout} from './thread-model.ts'
import {naturalHeightsAt} from './thread-prepare.ts'

installFakeCanvas()

const sectionFilter = process.argv[2]
const results: Record<string, unknown> = {}
const run = (name: string) => sectionFilter === undefined || sectionFilter === name

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[sorted.length >> 1]!
}

function microseconds(action: () => void, targetMilliseconds = 40, warmMilliseconds = 300) {
  const warmStart = performance.now()
  let warmRuns = 0
  while (performance.now() - warmStart < warmMilliseconds || warmRuns < 20) {
    action()
    warmRuns++
  }
  const probeStart = performance.now()
  for (let index = 0; index < 5; index++) action()
  const once = Math.max(1e-6, (performance.now() - probeStart) / 5)
  const iterations = Math.max(1, Math.round(targetMilliseconds / once))
  const samples: number[] = []
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) action()
    samples.push((performance.now() - start) / iterations * 1000)
  }
  return Number(median(samples).toFixed(2))
}

function printTable(title: string, rows: Record<string, unknown>[]) {
  console.log(`\n## ${title}`)
  if (rows.length === 0) return
  const columns = Object.keys(rows[0]!)
  console.log(`| ${columns.join(' | ')} |`)
  console.log(`| ${columns.map(() => '---').join(' | ')} |`)
  for (const row of rows) console.log(`| ${columns.map(column => String(row[column])).join(' | ')} |`)
}

const sampleInputs: FrameInputs = {windowWidth: 1024, windowHeight: 800, scrollTopReal: 1200, pointerX: 60.5, pointerY: 420.25, pointerDown: 1, click: 0}

function tableSizes(prepared: PreparedThread) {
  const steps = prepared.staircases.map(staircase => staircase.steps.length)
  return {
    breakpoints: steps.reduce((total, count) => total + count, 0),
    maxBreakpointsPerComment: Math.max(...steps),
    ancestorTableEntries: prepared.tables.rowCount * (prepared.tables.maxIndent + 1),
    ancestorListEntries: prepared.tables.ancestors.reduce((total, list) => total + list.length, 0),
    subtreeEndEntries: prepared.tables.rowCount,
  }
}

const defaultOptions: ThreadCircuitOptions = {slotCount: 48, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'}

if (run('scale')) {
  const scaleRows: Record<string, unknown>[] = []
  const sectionRows: Record<string, unknown>[] = []
  for (const count of [30, 60, 125, 251]) {
    const prepared = prepareThread(thread.comments.slice(0, count))
    const buildStart = performance.now()
    const built = buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, defaultOptions)
    const buildMilliseconds = performance.now() - buildStart
    const compileStart = performance.now()
    const stats = programStats(built)
    const compileMilliseconds = performance.now() - compileStart
    const demoStats = programStats(built, built.demoRoots)
    const state = initialThreadState(prepared, 1024)
    const machine = createThreadMachine(built, state)
    writeInputs(machine.source, built.layout, sampleInputs)
    const evaluate = built.circuit.createTensorEvaluator(built.roots)
    const source = Float32Array.from(machine.source)
    const circuitMicroseconds = microseconds(() => evaluate(source))
    const referenceMicroseconds = microseconds(() => referenceFrame(prepared, state, sampleInputs, defaultOptions.slotCount))
    const sizes = tableSizes(prepared)
    const windowStats = programStats(buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, {...defaultOptions, slotMode: 'window'}))
    const noSlotStats = programStats(buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, {...defaultOptions, slotCount: 0}))
    scaleRows.push({
      comments: count,
      maxIndent: prepared.tables.maxIndent,
      sourceCells: stats.sourceCells,
      breakpoints: sizes.breakpoints,
      liveOperations: stats.liveOperations,
      layers: stats.layers,
      widestLayer: stats.widestLayer,
      storedWeights: stats.storedWeights,
      gatherReads: stats.gatherReads,
      gatherTableEntries: stats.gatherTableEntries,
      comparisons: built.comparisonCount,
      outputs: stats.roots,
      demoLiveOperations: demoStats.liveOperations,
      demoStoredWeights: demoStats.storedWeights,
      demoOutputs: demoStats.roots,
      windowSlotsLiveOperations: windowStats.liveOperations,
      windowSlotsLayers: windowStats.layers,
      windowSlotsStoredWeights: windowStats.storedWeights,
      noSlotsLiveOperations: noSlotStats.liveOperations,
      noSlotsStoredWeights: noSlotStats.storedWeights,
      buildMs: buildMilliseconds.toFixed(0),
      compileMs: compileMilliseconds.toFixed(0),
      tabulateMs: prepared.tabulateMilliseconds.toFixed(0),
      circuitMicroseconds,
      referenceMicroseconds,
    })
    for (const section of stats.liveBySection) {
      sectionRows.push({comments: count, section: section.name, liveOperations: section.liveOperations, storedWeights: section.storedWeights, deepestLayer: section.deepestLayer})
    }
    results[`scale ${count}`] = {...stats, program: undefined, demo: {...demoStats, program: undefined}, sizes, buildMilliseconds, compileMilliseconds, circuitMicroseconds, referenceMicroseconds}
  }
  printTable('Scale, 48 slots, Brent-Kung natural prefix, fold visual prefix', scaleRows)
  printTable('Live operations by section', sectionRows)
}

if (run('variants')) {
  const prepared = prepareThread(thread.comments)
  const variantRows: Record<string, unknown>[] = []
  const variants: [string, ThreadCircuitOptions][] = [
    ['default: 48 slots, natural Brent-Kung, visual fold', defaultOptions],
    ['natural fold', {...defaultOptions, naturalPrefix: 'fold'}],
    ['visual Brent-Kung', {...defaultOptions, visualPrefix: 'brent-kung'}],
    ['both Brent-Kung', {...defaultOptions, naturalPrefix: 'brent-kung', visualPrefix: 'brent-kung'}],
    ['0 slots (per-row outputs only)', {...defaultOptions, slotCount: 0}],
    ['16 slots', {...defaultOptions, slotCount: 16}],
    ['32 slots', {...defaultOptions, slotCount: 32}],
    ['96 slots', {...defaultOptions, slotCount: 96}],
    ['48 window slots', {...defaultOptions, slotMode: 'window'}],
    ['96 window slots', {...defaultOptions, slotMode: 'window', slotCount: 96}],
    ['48 window slots, both prefix sums fold', {...defaultOptions, slotMode: 'window', naturalPrefix: 'fold'}],
  ]
  for (const [label, options] of variants) {
    const built = buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, options)
    const stats = programStats(built)
    const demoStats = programStats(built, built.demoRoots)
    const slotSection = stats.liveBySection.find(section => section.name === 'DOM slots')
    const differential = runSingleFrameDifferential(prepared, built, 150, 21)
    variantRows.push({
      variant: label,
      liveOperations: stats.liveOperations,
      layers: stats.layers,
      storedWeights: stats.storedWeights,
      demoLiveOperations: demoStats.liveOperations,
      demoLayers: demoStats.layers,
      slotOperations: slotSection?.liveOperations ?? 0,
      decisionMismatches: differential.comparison.decisionMismatches.length,
      tieFrames: differential.tieFrames,
      maxPositionDrift: differential.comparison.maxDrift.toExponential(2),
      positionMismatches: differential.comparison.positionMismatches.length,
    })
  }
  printTable('Variants, 251 comments (150 random single frames each)', variantRows)
  results['variants'] = variantRows
}

if (run('breakpoints')) {
  // Sweep every comment's height over container widths 375..1200 at 1/4px with pretext directly: count increases
  // (non-monotone steps), count changes, and check the tabulated staircase at every sample.
  const prepared = prepareThread(thread.comments)
  let samples = 0
  let changes = 0
  let increases = 0
  let staircaseMismatches = 0
  const sweepStart = performance.now()
  for (let row = 0; row < prepared.tables.rowCount; row++) {
    const indent = prepared.tables.indents[row]!
    let previous = -1
    for (let quarter = 375 * 4; quarter <= 1200 * 4; quarter++) {
      const containerWidth = quarter / 4
      const height = commentTextHeight(prepared.preparedComments[row]!, commentWidthAt(containerWidth, indent))
      if (previous !== -1 && height !== previous) {
        changes++
        if (height > previous) increases++
      }
      if (staircaseHeight(prepared.staircases[row]!, containerWidth) !== height) staircaseMismatches++
      previous = height
      samples++
    }
  }
  const sizes = tableSizes(prepared)
  const summary = {
    comments: prepared.tables.rowCount,
    samples,
    heightChangesSeenAtQuarterPixels: changes,
    increasesWithWidth: increases,
    tabulatedBreakpoints: sizes.breakpoints,
    staircaseMismatches,
    maxBreakpointsPerComment: sizes.maxBreakpointsPerComment,
    sweepSeconds: ((performance.now() - sweepStart) / 1000).toFixed(1),
    tabulateMilliseconds: prepared.tabulateMilliseconds.toFixed(0),
    prepareMilliseconds: prepared.prepareMilliseconds.toFixed(0),
  }
  printTable('Breakpoints: pretext sweep at 1/4px vs tabulated staircases', [summary])
  results['breakpoints'] = summary
}

if (run('differential')) {
  const rows: Record<string, unknown>[] = []
  const summarize = (comments: number, kind: string, summary: DifferentialSummary) => {
    rows.push({
      comments,
      kind,
      frames: summary.frames,
      decisionsCompared: summary.comparison.decisions,
      decisionMismatches: summary.comparison.decisionMismatches.length,
      tieFrames: summary.tieFrames,
      tieMismatches: summary.comparison.tieMismatches.length,
      // The reference's largest distance to a threshold among the tie mismatches
      maxTieMargin: Math.max(0, ...summary.comparison.tieMismatches.map(mismatch => mismatch.margin)).toExponential(2),
      positionMismatches: summary.comparison.positionMismatches.length,
      maxPositionDrift: summary.comparison.maxDrift.toExponential(2),
      maxDriftAt: summary.comparison.maxDriftPath,
      branches: `toggle ${summary.toggleFrames} (collapse ${summary.collapseFrames}, expand ${summary.expandFrames}), peek ${summary.peekFrames}, shrink ${summary.shrinkFrames}, overflow ${summary.overflowFrames}, fits ${summary.fitsFrames}, smoothing ${summary.smoothingFrames}, resize ${summary.widthChangedFrames}, target misses ${summary.targetMisses}`,
    })
    results[`differential ${comments} ${kind}`] = {
      ...summary,
      comparison: {
        ...summary.comparison,
        decisionMismatches: summary.comparison.decisionMismatches.slice(0, 20),
        tieMismatches: summary.comparison.tieMismatches.slice(0, 20),
        positionMismatches: summary.comparison.positionMismatches.slice(0, 20),
      },
    }
  }
  const tiny = prepareThread(thread.comments.slice(0, 3))
  summarize(3, 'random single frames', runSingleFrameDifferential(tiny, buildThreadCircuit({tables: tiny.tables, staircases: tiny.staircases}, {...defaultOptions, slotCount: 4}), 2000, 103))
  for (const count of [60, 251]) {
    const prepared = prepareThread(thread.comments.slice(0, count))
    const slotCount = count === 60 ? 16 : 48
    const built = buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, {...defaultOptions, slotCount})
    summarize(count, `random single frames, ${slotCount} rank slots`, runSingleFrameDifferential(prepared, built, count === 60 ? 4000 : 1500, 101))
    summarize(count, 'every comment: banner clicks from both states and a gutter press', runTargetedSweep(prepared, built, 107))
    const scenario = runScenarioDifferential(prepared, built, 900)
    summarize(count, `scripted session (${scenario.collapsedFrames} frames with a collapsed comment)`, scenario)
    const windowBuilt = buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, {...defaultOptions, slotCount, slotMode: 'window'})
    summarize(count, `random single frames, ${slotCount} window slots`, runSingleFrameDifferential(prepared, windowBuilt, count === 60 ? 2000 : 600, 109))
  }
  printTable('Differential checks against the hn.js-derived reference', rows)
}

if (run('slots')) {
  // How many slots each mode needs: rank slots need one per row in view that is at least 0.25px tall; window slots
  // need one per row in the visible index range, including zero-height rows.
  const prepared = prepareThread(thread.comments)
  const random = seededRandom(31)
  const percentile = (values: number[], fraction: number) => [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(values.length * fraction))]!
  const rows: Record<string, unknown>[] = []
  for (const kind of ['random states (10% of rows mid-animation at 0px)', 'settled states'] as const) {
    const occupying: number[] = []
    const visible: number[] = []
    for (let trial = 0; trial < 3000; trial++) {
      const state = randomState(prepared, random, Math.round(700 + random() * 700))
      if (kind === 'settled states') {
        state.heights = [...state.restTargetsPrevious]
        state.restHeights = [...state.restTargetsPrevious]
        state.scrollerPeekUp = 0
      }
      const inputs = {...randomInputs(prepared, random, state), pointerDown: 0, click: 0}
      const {frame} = referenceFrame(prepared, state, inputs, 1000, 'rank')
      occupying.push(frame.rows.filter(row => row.occupiesSlot === 1).length)
      visible.push(frame.rows.filter(row => row.visible === 1).length)
    }
    rows.push({states: kind, rankSlotsMedian: percentile(occupying, 0.5), rankSlotsP99: percentile(occupying, 0.99), rankSlotsMax: Math.max(...occupying), windowSlotsMedian: percentile(visible, 0.5), windowSlotsP99: percentile(visible, 0.99), windowSlotsMax: Math.max(...visible)})
  }
  // Collapse the comment with the most descendants while its banner is near the top of the scroller, then let the
  // heights ease for 90 frames.
  const parent = prepared.tables.descendantCounts.indexOf(Math.max(...prepared.tables.descendantCounts))
  const naturalHeights = naturalHeightsAt(prepared, 1280)
  let parentTop = 0
  for (let row = 0; row < parent; row++) parentTop += naturalHeights[row]!
  const scrollTopReal = Math.max(0, parentTop - 100)
  // hn.js: once the comments overflow, the submission header is 100 - min(40, scrollTop) tall
  const submissionHeight = threadLayout.submissionHeightNatural - Math.min(threadLayout.submissionHeightDelta, scrollTopReal)
  let state = initialThreadState(prepared, 1280)
  state.scrollTopPrevious = scrollTopReal
  let maxOccupying = 0
  let maxVisible = 0
  let settledVisible = 0
  let settledOccupying = 0
  let toggled = false
  for (let frame = 0; frame < 90; frame++) {
    const inputs: FrameInputs = {
      windowWidth: 1280,
      windowHeight: 1000,
      scrollTopReal,
      pointerX: (1280 - 1200) / 2 + (prepared.tables.indents[parent]! + 2) * threadLayout.indentWidth,
      pointerY: threadLayout.currentContainerTop + submissionHeight - scrollTopReal + parentTop + 10.5,
      pointerDown: 0,
      click: frame === 0 ? 1 : 0,
    }
    const {frame: result} = referenceFrame(prepared, state, inputs, 1000, 'rank')
    const occupying = result.rows.filter(row => row.occupiesSlot === 1).length
    const visible = result.rows.filter(row => row.visible === 1).length
    maxOccupying = Math.max(maxOccupying, occupying)
    maxVisible = Math.max(maxVisible, visible)
    settledOccupying = occupying
    settledVisible = visible
    if (result.next.collapsed[parent] === 1) toggled = true
    state = result.next
  }
  if (!toggled) throw new Error('the collapse case did not toggle the comment')
  rows.push({
    states: `collapsing comment ${parent} (${prepared.tables.descendantCounts[parent]} descendants) in view, 90 frames`,
    rankSlotsMedian: `settled ${settledOccupying}`,
    rankSlotsP99: '',
    rankSlotsMax: maxOccupying,
    windowSlotsMedian: `settled ${settledVisible}`,
    windowSlotsP99: '',
    windowSlotsMax: maxVisible,
  })
  printTable('Slots needed, 251 comments, window heights 700..1400px', rows)
  results['slots'] = rows
}

// One codegen configuration, run by the codegen section in its own process: report.ts codegen-one <comments> <budget>
// prints one JSON row.
function measureGeneratedProgram(count: number, statementBudget: number) {
  const prepared = prepareThread(thread.comments.slice(0, count))
  const built = buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, defaultOptions)
  const program = built.circuit.compileTensorProgram(built.demoRoots)
  const machine = createThreadMachine(built, initialThreadState(prepared, 1024), built.demoRoots)
  writeInputs(machine.source, built.layout, sampleInputs)
  const source = Float32Array.from(machine.source)
  const expected = built.circuit.evaluateTensor(source)
  const generated = generateProgram(program, statementBudget)
  generated.run(source)
  let mismatches = 0
  for (let packed = 0; packed < program.valueCount; packed++) {
    const left = generated.packed[packed]!
    const right = expected[program.wireOrder[packed]!]!
    if (!(left === right || Object.is(left, right))) mismatches++
  }
  const row: Record<string, unknown> = {
    comments: count,
    statementBudget,
    liveOperations: program.valueCount - program.sourceSize,
    generatedFunctions: generated.functionCount,
    generatedStatements: generated.statementTotal,
    liveWireMismatches: mismatches,
  }
  let runs = 1
  for (const checkpoint of [10, 100, 1000, 3000, 6000, 10000]) {
    while (runs < checkpoint) {
      generated.run(source)
      runs++
    }
    const batches: number[] = []
    for (let batch = 0; batch < 3; batch++) {
      const start = performance.now()
      for (let index = 0; index < 20; index++) generated.run(source)
      runs += 20
      batches.push((performance.now() - start) / 20 * 1000)
    }
    row[`µs after ${checkpoint} frames`] = median(batches).toFixed(0)
  }
  const evaluate = built.circuit.createTensorEvaluator(built.demoRoots)
  row['executor µs'] = microseconds(() => evaluate(source))
  return row
}

if (sectionFilter === 'codegen-one') {
  console.log(JSON.stringify(measureGeneratedProgram(Number(process.argv[3]), Number(process.argv[4]))))
}

if (run('codegen')) {
  // Plain JS generated from the compiled program, split into functions of at most 100 or at most 300 statements. Each
  // function runs once per frame, so JavaScriptCore only optimizes them after many frames: at several points along the
  // way, time 3 batches of 20 frames and keep the median batch. Each configuration runs in its own process, because
  // when the 300-statement functions ran in the same process right after the 100-statement ones, they stayed slow.
  const rows: Record<string, unknown>[] = []
  for (const count of [30, 251]) {
    for (const statementBudget of [100, 300]) {
      const child = Bun.spawnSync([process.execPath, import.meta.path, 'codegen-one', String(count), String(statementBudget)], {stdout: 'pipe', stderr: 'inherit'})
      if (child.exitCode !== 0) throw new Error(`codegen-one ${count} ${statementBudget} exited with ${child.exitCode}`)
      rows.push(JSON.parse(child.stdout.toString()) as Record<string, unknown>)
    }
  }
  printTable('Generated plain JS (demo roots) as the engine optimizes it, each configuration in its own process', rows)
  results['codegen'] = rows
}

// Every section's entries are keyed by names starting with the section name. A one-section run replaces only that
// section's entries in results.json.
// A codegen-one child process writes nothing; its parent collects the rows.
if (sectionFilter !== 'codegen-one') {
  const resultsFile = Bun.file(new URL('./results.json', import.meta.url))
  let merged: Record<string, unknown> = results
  if (sectionFilter !== undefined && await resultsFile.exists()) {
    const existing = await resultsFile.json() as Record<string, unknown>
    merged = Object.fromEntries(Object.entries(existing).filter(([key]) => key !== sectionFilter && !key.startsWith(`${sectionFilter} `)))
    Object.assign(merged, results)
  }
  await Bun.write(resultsFile, JSON.stringify(merged, null, 2))
}

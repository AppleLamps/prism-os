// Measurements for indirect-os-2. Run from the repository root:
//   bun lab/ui-exploration/indirect-os-2/report.ts                 every part, several minutes
//   bun lab/ui-exploration/indirect-os-2/report.ts structure traces   some parts
// Parts: structure, traces, timings, tierup, framerate. Prints markdown tables and
// merges results into results.json next to this file. Counts are exact; µs are
// rough, because other agents share the machine.
import {compileScalarProgram, comparePacked} from './codegen.ts'
import {createBoxCheck, windowAndPhotoBoxes, wordBoxes} from './box-check.ts'
import {configurations} from './configurations.ts'
import {lineFitEpsilon, loadPretext} from './fake-canvas.ts'
import {fastParagraph} from './fast-walker.ts'
import {compareFrameRates} from './framerate.ts'
import {type IndirectOSMachine, type IndirectOSOptions, buildIndirectOS, createIndirectOSMachine} from './indirect-os.ts'
import {createRandom, randomInteger} from './input-kit.ts'
import {deepestPathSections, programSize, sectionBreakdown} from './measure.ts'
import {referenceNotesFlow} from './notes-reference.ts'
import {createOracleState, oracleEvaluation} from './oracle.ts'
import {createPair, runRandomTrace} from './pair-traces.ts'
import {notesOptionsFor, notesText, testFont} from './paragraph.ts'
import {generateQueueTrace} from './queue-traces.ts'
import {sessionEvents, sessionFrameCount, sessionFrameTime, sessionViewport} from './session.ts'
import {leafWires} from './table.ts'
import {countOneHotOperations} from './text-kit.ts'
import {createTieredEvaluator} from './tiered.ts'
import {read} from './wires.ts'

const folder = import.meta.dir
const pretext = await loadPretext()
const prepared = pretext.prepareWithSegments(notesText, testFont)
const paragraph = fastParagraph(prepared)
const sets = configurations(paragraph, lineFitEpsilon)
const allConfigurations = [...sets.steps, ...sets.alternatives, ...sets.interference]
const results: Record<string, unknown> = {}
const table = (rows: readonly (readonly (string | number)[])[]) => console.log(`${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n`)
const count = (value: number) => value.toLocaleString('en-US')
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!

// The session with the latch machine's API: presses act on the down there, and
// a Photos click also needs the DOM click at local coordinates.
function stepSession(machine: IndirectOSMachine, frame: number, frameTime = sessionFrameTime(frame)) {
  const events = sessionEvents(frame)
  if (machine.options.input.kind === 'queue') return machine.stepFrame(sessionViewport.width, sessionViewport.height, frameTime, events).values
  for (const event of events) {
    if (event.kind === 'key') {
      if (event.key === 'ArrowRight') machine.photoNext()
      else if (event.key === 'ArrowLeft') machine.photoPrevious()
      else machine.photoClose()
    } else if (event.kind === 'down') machine.pointerDown(event.x, event.y)
    else if (event.kind === 'move') machine.pointerMove(event.x, event.y)
    else machine.pointerUp(event.x, event.y)
  }
  if (frame === 170) machine.photoClick(472, 309)
  return machine.step(sessionViewport.width, sessionViewport.height, frameTime)
}

function recordSessionTables(options: IndirectOSOptions) {
  const machine = createIndirectOSMachine(options, {validate: false})
  const tables: Float32Array[] = []
  machine.observe({beforeEvaluate: source => { tables.push(Float32Array.from(source)) }})
  for (let frame = 0; frame < sessionFrameCount; frame++) stepSession(machine, frame)
  return {machine, tables}
}

function microsecondsPerEvaluation(tables: readonly Float32Array[], run: (table: Float32Array) => void, warmupMilliseconds: number, measureMilliseconds: number) {
  let index = 0
  const warmupStarted = performance.now()
  while (performance.now() - warmupStarted < warmupMilliseconds) run(tables[index++ % tables.length]!)
  const samples: number[] = []
  const started = performance.now()
  while (performance.now() - started < measureMilliseconds) {
    const sampleStarted = performance.now()
    for (let repeat = 0; repeat < 10; repeat++) run(tables[index++ % tables.length]!)
    samples.push((performance.now() - sampleStarted) * 100)
  }
  return Number(median(samples).toFixed(1))
}

async function structure() {
  console.log('## Structure\n')
  const rows: (string | number)[][] = [['configuration', 'source cells', 'live operations', 'layers', 'stored weights', 'gather reads', 'widest layer', 'build ms']]
  const sizes: Record<string, unknown> = {}
  for (const {label, options} of allConfigurations) {
    const started = performance.now()
    const built = buildIndirectOS(options)
    const buildMilliseconds = performance.now() - started
    const size = programSize(built.circuit, [...built.nextSource, ...leafWires(built.output)])
    sizes[label] = {...size, sourceCells: built.table.size, buildMilliseconds}
    rows.push([label, built.table.size, count(size.live), size.layers, count(size.weights), size.gatherReads, size.widestLayer, buildMilliseconds.toFixed(0)])
  }
  table(rows)
  const differences: (string | number)[][] = [['change', 'live operations', 'layers', 'stored weights']]
  sets.steps.slice(1).forEach(({label}, index) => {
    const before = sizes[sets.steps[index]!.label] as ReturnType<typeof programSize>
    const after = sizes[label] as ReturnType<typeof programSize>
    const signed = (value: number) => (value > 0 ? `+${count(value)}` : count(value))
    differences.push([label, signed(after.live - before.live), signed(after.layers - before.layers), signed(after.weights - before.weights)])
  })
  console.log('Differences between consecutive steps\n')
  table(differences)
  const breakdowns: Record<string, unknown> = {}
  for (const {label, options} of [sets.steps[3]!, sets.steps[4]!, sets.steps[5]!, sets.alternatives[3]!]) {
    const built = buildIndirectOS(options)
    const roots = [...built.nextSource, ...leafWires(built.output)]
    const breakdown = sectionBreakdown(built.circuit, roots)
    const path = deepestPathSections(built.circuit, roots)
    const program = built.circuit.compileTensorProgram(roots)
    const oneHotOperations = countOneHotOperations(built.circuit, program.wireOrder)
    breakdowns[label] = {breakdown, path, oneHotOperations}
    console.log(`### ${label}\n`)
    table([['section', 'live operations', 'stored weights'], ...breakdown.map(row => [row.label, count(row.live), count(row.weights)])])
    console.log(`deepest path (${path.depth} operations): ${path.sections.map(([section, operations]) => `${section} ${operations}`).join(', ')}`)
    if (oneHotOperations > 0) console.log(`integer one-hot operations: ${count(oneHotOperations)}; line recovery groups: ${options.notes?.bands ?? 0}`)
    console.log()
  }
  results['structure'] = {sizes, breakdowns}
}

async function traces() {
  console.log('## Traces\n')
  const rows: (string | number)[][] = [['check', 'frames', 'compared values', 'mismatches', 'notes']]
  const record: Record<string, unknown> = {}

  // 1. Timestep declared: every root bit for bit against window-manager.ts.
  for (const seed of [1, 2, 3]) {
    const result = runRandomTrace(createPair(sets.steps[1]!.options, 'all roots'), seed, 2000)
    record[`declared seed ${seed}`] = result
    rows.push([`timestep declared vs window-manager.ts, all roots, seed ${seed}`, result.frames, count(result.comparedValues), result.mismatchedValues, `held drags ${result.coverage.heldDragMoves}, held resizes ${result.coverage.heldResizeMoves}`])
  }
  // 2. Spring bank: discrete state and geometry against window-manager.ts.
  for (const [label, options, seed] of [['bank', sets.steps[2]!.options, 5], ['bank, Photos stepped springs', sets.steps[3]!.options, 12], ['bank, Photos stepped springs', sets.steps[3]!.options, 6]] as const) {
    const result = runRandomTrace(createPair(options, 'discrete'), seed, 3000)
    record[`${label} seed ${seed}`] = result
    rows.push([`${label} vs window-manager.ts, discrete state and geometry, seed ${seed}`, result.frames, count(result.comparedValues), result.mismatchedValues, `photo focus changes ${result.coverage.photoFocusChanges}, closes ${result.coverage.closes}, held drags ${result.coverage.heldDragMoves}`])
  }
  // 3. The whole program against the one-event-at-a-time oracle.
  for (const seed of [1, 2, 3, 4]) {
    const machine = createIndirectOSMachine(sets.final)
    const oracle = createOracleState()
    const {frames, redraws, dropped} = generateQueueTrace({seed, frames: 3000, capacity: 8, maximumDowns: 2})
    let time = 0
    let mismatches = 0
    let events = 0
    let keys = 0
    for (const frame of frames) {
      events += frame.events.length
      keys += frame.events.filter(event => event.kind === 'key').length
      oracleEvaluation(oracle, frame.viewport, frame.events)
      machine.stepFrame(frame.viewport.width, frame.viewport.height, time += frame.elapsed, frame.events)
      const {source, cells} = machine
      const queue = cells.queue!
      const state = {
        windows: cells.windows.map(window => [source[window.left], source[window.top], source[window.width], source[window.height], source[window.open], source[window.minimized], source[window.maximized]]),
        order: cells.stack.map(row => row.findIndex(wire => source[wire] === 1)),
        press: [source[queue.press.active], source[queue.press.x], source[queue.press.y], queue.press.window.findIndex(wire => source[wire] === 1), queue.press.region.findIndex(wire => source[wire] === 1), queue.press.dock.findIndex(wire => source[wire] === 1), source[queue.press.slop]],
        photoFocus: cells.photoState.focus.findIndex(wire => source[wire] === 1),
      }
      const expected = {
        windows: oracle.windows.map(window => [window.left, window.top, window.width, window.height, Number(window.open), Number(window.minimized), Number(window.maximized)]),
        order: oracle.order,
        press: [Number(oracle.press.active), oracle.press.x, oracle.press.y, oracle.press.window, oracle.press.region, oracle.press.dock, Number(oracle.press.slop)],
        photoFocus: oracle.photoFocus,
      }
      if (JSON.stringify(state) !== JSON.stringify(expected)) mismatches++
    }
    record[`oracle seed ${seed}`] = {frames: frames.length, events, keys, mismatches, redraws, dropped}
    rows.push([`whole program vs one-event-at-a-time oracle, seed ${seed}`, frames.length, `${count(events)} events`, mismatches, `${keys} keys, ${redraws} points moved off hit thresholds, ${dropped} dropped`])
  }
  // 4. Every spring box against float64 doctrine springs.
  {
    const machine = createIndirectOSMachine(sets.final, {debugOutputs: true})
    const check = createBoxCheck(machine, [...windowAndPhotoBoxes(machine), ...wordBoxes(machine)])
    const {frames} = generateQueueTrace({seed: 21, frames: 3000, capacity: 8, maximumDowns: 2})
    let time = 0
    for (const frame of frames) machine.stepFrame(frame.viewport.width, frame.viewport.height, time += frame.elapsed, frame.events)
    record['float64 boxes'] = check
    rows.push(['window, thumbnail and word boxes vs float64 springs, restarted each evaluation', check.evaluations, `${count(check.boxesChecked)} boxes`, check.settleMismatches + check.clockMismatches, `max position error ${check.maxPositionError.toExponential(2)} px, max velocity error ${check.maxVelocityError.toExponential(2)} px/s`])
  }
  // 5. Settled Notes flows against pretext.
  {
    const notesOptions = sets.final.notes!
    const machine = createIndirectOSMachine(sets.final, {debugOutputs: true})
    const random = createRandom(101)
    const viewport = {width: 1280, height: 800}
    let time = 0
    let wordMismatches = 0
    let bandMismatches = 0
    let overflowStates = 0
    let wordsChecked = 0
    let bandsChecked = 0
    let multiSlotBands = 0
    const arrangements = 150
    for (let trial = 0; trial < arrangements; trial++) {
      const {source, cells} = machine
      cells.windows.forEach((window, index) => {
        const width = randomInteger(random, 280, 720)
        const height = randomInteger(random, 190, 560)
        source[window.width] = width
        source[window.height] = height
        source[window.left] = randomInteger(random, 0, viewport.width - width)
        source[window.top] = randomInteger(random, 36, 724 - height)
        source[window.minimized] = index !== 1 && random() < 0.15 ? 1 : 0
        source[window.maximized] = index !== 1 && random() < 0.05 ? 1 : 0
      })
      const order = [0, 1, 2, 3].sort(() => random() - 0.5)
      cells.stack.forEach((row, rank) => row.forEach((wire, index) => { source[wire] = order[rank] === index ? 1 : 0 }))
      let values = machine.values
      for (let frame = 0; frame < 20; frame++) {
        values = machine.stepFrame(viewport.width, viewport.height, time += 1000, []).values
        if (values[machine.output.animationActive] === 0) break
      }
      const windows = read(values, machine.output.windows)
      const notes = windows[1]!
      const contentLeft = notes.translateX + 1
      const contentTop = notes.translateY + 45
      const arrangement = {
        columnLeft: notesOptions.padding,
        columnWidth: Math.min(notesOptions.maximumColumnWidth, Math.max(0, notes.width - 2 - 2 * notesOptions.padding)),
        obstacles: [0, 2, 3].map(index => ({left: windows[index]!.translateX - contentLeft, top: windows[index]!.translateY - contentTop, width: windows[index]!.width, height: windows[index]!.height, active: windows[index]!.opacity === 1 && order.indexOf(index) > order.indexOf(1)})),
      }
      const reference = referenceNotesFlow(pretext.layoutNextLineRange as never, prepared, paragraph, arrangement, notesOptions)
      const output = read(values, machine.output.notes!)
      let wordIndex = 0
      paragraph.breakAfter.forEach((breakAfter, segment) => {
        if (breakAfter === 1) return
        const expected = reference.segments[segment]!
        const word = output.words[wordIndex++]!
        wordsChecked++
        if (word.visible !== Number(expected.visible) || (expected.visible && (word.x !== Math.fround(expected.x) || word.y !== expected.y))) wordMismatches++
      })
      const circuitBands = read(values, machine.debug.notes!.bands)
      reference.bands.forEach((band, index) => {
        const top = notesOptions.padding + index * notesOptions.lineHeight
        const blocking = arrangement.obstacles.filter(obstacle => obstacle.active && !(top + notesOptions.lineHeight <= obstacle.top - notesOptions.verticalPadding || top >= obstacle.top + obstacle.height + notesOptions.verticalPadding))
        if (blocking.length >= 2) multiSlotBands++
        bandsChecked++
        const circuit = circuitBands[index]!
        const start = band.line === null ? paragraph.widths.length : band.line.start.segmentIndex
        const lineWidth = band.line === null ? 0 : Math.fround(band.line.width)
        const sameSlot = circuit.usable === Number(band.usable) && (!band.usable || (circuit.left === band.left && circuit.width === band.slotWidth))
        if (!sameSlot || (band.usable && (circuit.start !== start || circuit.lineWidth !== lineWidth))) bandMismatches++
      })
      if (output.windowOverflow !== 0 || output.runOverflow !== 0) overflowStates++
    }
    record['notes vs pretext'] = {arrangements, wordsChecked, wordMismatches, bandsChecked, bandMismatches, multiSlotBands, overflowStates}
    rows.push([`settled Notes flow vs pretext layoutNextLineRange, random arrangements`, arrangements, `${count(wordsChecked)} words, ${count(bandsChecked)} bands`, wordMismatches + bandMismatches, `slot, line start and painted width per band; ${multiSlotBands} bands blocked by two or three windows; ${overflowStates} states with an overflow`])
  }
  // 6. Generated JavaScript on every live wire.
  {
    const machine = createIndirectOSMachine(sets.final, {validate: false})
    const generated = compileScalarProgram(machine.tensorProgram, {rowsPerFunction: 32})
    let checked = 0
    let mismatches = 0
    let evaluations = 0
    machine.observe({
      beforeEvaluate(source) {
        generated.run(source)
        const comparison = comparePacked(machine.tensorProgram, generated.values, machine.circuit.evaluateTensor(source))
        checked += comparison.checked
        mismatches += comparison.mismatches
        evaluations++
      },
    })
    for (let frame = 0; frame < sessionFrameCount; frame++) stepSession(machine, frame)
    const {frames} = generateQueueTrace({seed: 31, frames: 400, capacity: 8, maximumDowns: 2})
    let time = sessionFrameTime(sessionFrameCount)
    for (const frame of frames) machine.stepFrame(frame.viewport.width, frame.viewport.height, time += frame.elapsed, frame.events)
    record['generated wires'] = {evaluations, checked, mismatches}
    rows.push(['generated JavaScript vs executor, every live wire, session and a random trace', evaluations, count(checked), mismatches, '32 rows per function'])
  }
  table(rows)
  results['traces'] = record
}

async function timings() {
  console.log('## Warm µs per evaluation, over the session\'s source tables\n')
  const rows: (string | number)[][] = [['configuration', 'live operations', 'layers', 'executor µs', 'generated µs, 32 rows', 'generated µs, 128 rows', 'executor µs / generated µs']]
  const record: Record<string, unknown> = {}
  for (const {label, options} of [...sets.steps, sets.alternatives[3]!, sets.alternatives[4]!]) {
    const {machine, tables} = recordSessionTables(options)
    const evaluate = machine.circuit.createTensorEvaluator(machine.roots)
    const executor = microsecondsPerEvaluation(tables, table => { evaluate(table) }, 1000, 1500)
    const generated32 = compileScalarProgram(machine.tensorProgram, {rowsPerFunction: 32})
    const generated32Microseconds = microsecondsPerEvaluation(tables, table => generated32.run(table), 8000, 1500)
    const generated128 = compileScalarProgram(machine.tensorProgram, {rowsPerFunction: 128})
    const generated128Microseconds = microsecondsPerEvaluation(tables, table => generated128.run(table), 8000, 1500)
    const program = machine.tensorProgram
    record[label] = {executor, generated32: generated32Microseconds, generated128: generated128Microseconds, evaluations: tables.length}
    rows.push([label, count(program.valueCount - program.sourceSize), program.layers.length, executor, generated32Microseconds, generated128Microseconds, (executor / Math.min(generated32Microseconds, generated128Microseconds)).toFixed(1)])
  }
  table(rows)
  // The host step: derived validation, evaluation, writeback, output contracts.
  const machine = createIndirectOSMachine(sets.final)
  const evaluator = createTieredEvaluator(machine.circuit, machine.roots, {rowsPerFunction: 32})
  machine.setEvaluator(table => evaluator.evaluate(table))
  for (let frame = 0; frame < sessionFrameCount; frame++) stepSession(machine, frame)
  evaluator.promote(machine.source, 8000)
  const stepSamples: number[] = []
  const validateSamples: number[] = []
  let time = sessionFrameTime(sessionFrameCount)
  for (let frame = 0; frame < 3000; frame++) {
    const started = performance.now()
    machine.stepFrame(1280, 800, time += 16.6875, frame % 50 === 0 ? [{kind: 'down', x: 600, y: 120}, {kind: 'up', x: 600, y: 120}] : [])
    stepSamples.push((performance.now() - started) * 1000)
    const validateStarted = performance.now()
    machine.validate(machine.source)
    validateSamples.push((performance.now() - validateStarted) * 1000)
  }
  console.log(`whole program machine.stepFrame on generated code (validation, evaluation, writeback, contracts): median ${median(stepSamples).toFixed(1)} µs; derived source validator alone ${median(validateSamples).toFixed(2)} µs over ${machine.source.length} cells\n`)
  results['timings'] = {...record, wholeStepMicroseconds: median(stepSamples), validatorMicroseconds: median(validateSamples)}
}

// One fresh process per backend: µs per evaluation by evaluation count.
async function tierupChild(backend: string) {
  const {machine, tables} = recordSessionTables(sets.final)
  const buildStarted = performance.now()
  const evaluate = machine.circuit.createTensorEvaluator(machine.roots)
  let run: (table: Float32Array) => void = table => { evaluate(table) }
  let setupMilliseconds = performance.now() - buildStarted
  let evaluator: ReturnType<typeof createTieredEvaluator> | null = null
  if (backend === 'generated') {
    const started = performance.now()
    const generated = compileScalarProgram(machine.tensorProgram, {rowsPerFunction: 32})
    setupMilliseconds = performance.now() - started
    run = table => generated.run(table)
  } else if (backend === 'tiered') {
    evaluator = createTieredEvaluator(machine.circuit, machine.roots, {rowsPerFunction: 32})
    run = table => { evaluator!.evaluate(table) }
  }
  const buckets = [[1, 1], [2, 10], [11, 100], [101, 1000], [1001, 10_000], [10_001, 30_000], [30_001, 100_000]] as const
  const totals = buckets.map(() => 0)
  const started = performance.now()
  for (let evaluation = 1; evaluation <= 100_000; evaluation++) {
    // Tiered: promote after 1,000 evaluations, warming for 1 s on a copy of the table.
    if (evaluator !== null && evaluation === 1001) evaluator.promote(tables[0]!, 1000)
    const table = tables[evaluation % tables.length]!
    const evaluationStarted = performance.now()
    run(table)
    const elapsed = (performance.now() - evaluationStarted) * 1000
    const bucket = buckets.findIndex(([low, high]) => evaluation >= low && evaluation <= high)
    totals[bucket] = totals[bucket]! + elapsed
  }
  const totalMilliseconds = performance.now() - started
  console.log(JSON.stringify({backend, setupMilliseconds, totalMilliseconds, buckets: buckets.map(([low, high], index) => ({low, high, microseconds: totals[index]! / (high - low + 1)})), promotion: evaluator?.stats ?? null}))
}

async function tierup() {
  console.log('## Tier-up in fresh processes, whole program, µs per evaluation\n')
  const rows: (string | number)[][] = [['backend', 'setup ms', 'evaluation 1', '2-10', '11-100', '101-1,000', '1,001-10,000', '10,001-30,000', '30,001-100,000', 'total s for 100,000']]
  const record: unknown[] = []
  for (const backend of ['executor', 'generated', 'tiered']) {
    const child = Bun.spawnSync({cmd: ['bun', `${folder}/report.ts`, 'child', 'tierup', backend], stdout: 'pipe', stderr: 'pipe'})
    const line = child.stdout.toString().trim().split('\n').at(-1)!
    const parsed = JSON.parse(line) as {backend: string, setupMilliseconds: number, totalMilliseconds: number, buckets: {microseconds: number}[]}
    record.push(parsed)
    rows.push([backend, parsed.setupMilliseconds.toFixed(0), ...parsed.buckets.map(bucket => bucket.microseconds.toFixed(0)), (parsed.totalMilliseconds / 1000).toFixed(1)])
  }
  table(rows)
  console.log('tiered: executor for the first 1,000 evaluations, then generated code, promoted with 1 s of warmup inside evaluation 1,001\n')
  results['tierup'] = record
}

// The session at 60 and 120 fps (framerate.ts). Every event sits on a 60 fps
// frame time, which 120 fps also renders, so both apply each press at its own time.
async function framerate() {
  console.log('## Frame-rate independence, 60 fps vs 120 fps at shared timestamps\n')
  const queue = sets.steps[4]!.options
  const rows: (string | number)[][] = [['configuration', 'shared frames', 'windows, max px', 'thumbnails, max px', 'words, max px', 'frames with different stacking, flags, photo focus, word visibility', 'frames with different animationActive']]
  const record: Record<string, unknown> = {}
  for (const [label, options] of [
    [sets.steps[3]!.label, sets.steps[3]!.options],
    [sets.steps[4]!.label, queue],
    ['Notes around current-frame obstacles', {...queue, notes: notesOptionsFor(paragraph, lineFitEpsilon, {obstacles: 'current-frame'})}],
    ['Notes around stepped-springs obstacles', {...queue, notes: notesOptionsFor(paragraph, lineFitEpsilon, {obstacles: 'stepped-springs'})}],
    ['Notes around destination obstacles', {...queue, notes: notesOptionsFor(paragraph, lineFitEpsilon, {obstacles: 'destinations'})}],
  ] as [string, IndirectOSOptions][]) {
    const result = compareFrameRates(options)
    record[label] = result
    rows.push([label, result.sharedFrames, result.windows.toExponential(2), result.thumbnails.toExponential(2), options.notes === null ? '-' : result.words.toExponential(2), result.discreteMismatches, result.animationMismatches])
  }
  table(rows)
  results['framerate'] = record
}

const argv = process.argv.slice(2)
if (argv[0] === 'child') {
  if (argv[1] === 'tierup') await tierupChild(argv[2]!)
} else {
  const parts = argv.length === 0 ? ['structure', 'traces', 'timings', 'tierup', 'framerate'] : argv
  const runners: Record<string, () => Promise<void>> = {structure, traces, timings, tierup, framerate}
  for (const part of parts) await runners[part]!()
  const path = `${folder}/results.json`
  const previous = await Bun.file(path).exists() ? JSON.parse(await Bun.file(path).text()) as Record<string, unknown> : {}
  await Bun.write(path, `${JSON.stringify({...previous, ...results}, null, 2)}\n`)
  console.log('wrote results.json')
}
void notesOptionsFor

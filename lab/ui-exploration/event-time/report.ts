// Measurements for README.md. Run from the repo root:
//   bun lab/ui-exploration/event-time/report.ts
// Prints markdown tables and writes results.json next to this file. Counts are
// exact; timings are rough because other processes share the machine.
import type {Circuit} from '../../../numeric-ui-core.ts'
import {
  type DisplayRecord,
  type SettlePolicy,
  coalescePointerMoves,
  compareCommitLogs,
  compareDisplays,
  continuousOffsets,
  createCommitter,
  replayCommitPerEvent,
  sequentialSettleProbe,
} from './commits.ts'
import {createEventTimeScene} from './demo-model.ts'
import {type EventTimeOptions, createEventTimeMachine, displayLayout} from './event-machine.ts'
import {planInstances} from '../codegen/instance.ts'
import {createTracks, planKeyframes, trackKeyframes} from './keyframes.ts'
import {compareScreens, holdLastFrame, screenGroups, simulateKeyframePresenter, staleWindow, stallWindow, type Stall} from './playback.ts'
import {controlField, photoField} from '../spring-bank/photo-gallery.ts'
import {createPredictor, frameCells, sampleCount, snapStatistics} from './prediction.ts'
import {checkCommitSprings, createDisplaySpringCheck} from './springs-check.ts'
import {
  type FrameRecord,
  type FrameSchedule,
  type TraceEvent,
  compareAtSharedTimes,
  createIndirectOSTrace,
  offsetPresses,
  randomPressOffsets,
  replayTrace,
  scheduleFrameTimes,
} from '../spring-bank/trace.ts'
import {createWgslInterpreter} from '../codegen/wgsl-interpreter.ts'
import {emitInstanceWgsl, packSharedBuffer} from '../codegen/wgsl.ts'
import {
  bankOptions,
  bankSourceField,
  createWindowManagerMachine,
  dockOutputField,
  photoSourceField,
  sourceField,
  windowOutputField,
} from '../spring-bank/window-manager.ts'

const results: Record<string, unknown> = {}
const reportStart = performance.now()

function markdownTable(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return ''
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const format = (value: unknown) => value === undefined
    ? ''
    : typeof value === 'number'
      ? (Number.isInteger(value) ? value.toLocaleString('en-US') : value.toPrecision(3))
      : String(value)
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(column => format(row[column])).join(' | ')} |`),
  ].join('\n')
}

function print(title: string, rows: Record<string, unknown>[], key: string) {
  results[key] = rows
  console.log(`\n## ${title}\n`)
  console.log(markdownTable(rows))
}

function median(values: readonly number[]) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
}

type Program = ReturnType<Circuit['compileTensorProgram']>
function programSize(program: Program) {
  return {
    live: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    weights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
  }
}

const baseTrace = createIndirectOSTrace()
const resizeTrace = createIndirectOSTrace({liveResize: true})
const durationMs = baseTrace.durationMs + 2000
const stall500: Stall = {startMs: 2701, durationMs: 500}
const stall2s: Stall = {startMs: 7001, durationMs: 2000}
const frames = (fps: number, stall?: Stall): FrameSchedule => stall === undefined ? {fps, durationMs} : {fps, durationMs, stall}
const traces: [string, readonly TraceEvent[]][] = [
  ['presses on 30 fps frames', baseTrace.events],
  ['every event 1 ms later', offsetPresses(baseTrace.events, () => 1)],
  ['random press offsets, seed 7', offsetPresses(baseTrace.events, randomPressOffsets(7, 30))],
  ['random press offsets, seed 99', offsetPresses(baseTrace.events, randomPressOffsets(99, 30))],
  ['live resize, random press offsets, seed 7', offsetPresses(resizeTrace.events, randomPressOffsets(7, 30))],
  ['live resize, random press offsets, seed 99', offsetPresses(resizeTrace.events, randomPressOffsets(99, 30))],
]
const traceEvents = (label: string) => traces.find(([name]) => name === label)![1]
const schedules: [string, FrameSchedule][] = [
  ['10 fps', frames(10)],
  ['30 fps', frames(30)],
  ['60 fps', frames(60)],
  ['120 fps', frames(120)],
  ['60 fps, 500 ms stall', frames(60, stall500)],
  ['60 fps, 2 s stall', frames(60, stall2s)],
  ['240 fps, 500 ms stall', frames(240, stall500)],
]
type Variant = {label: string, options: Partial<EventTimeOptions>, settle: SettlePolicy}
const variants: Variant[] = [
  {label: 'source-matrix, predicted settle', options: {springs: 'source-matrix'}, settle: 'predicted'},
  {label: 'source-matrix, interval settle', options: {springs: 'source-matrix'}, settle: 'interval'},
  {label: 'split-table, predicted settle', options: {springs: 'split-table'}, settle: 'predicted'},
  {label: 'split-table, interval settle', options: {springs: 'split-table'}, settle: 'interval'},
]
const replay = (variant: Variant, events: readonly TraceEvent[], schedule: FrameSchedule) =>
  replayCommitPerEvent(createEventTimeMachine(variant.options), events, scheduleFrameTimes(schedule), {settle: variant.settle, durationMs})

// Event latches are 1 in the committed table only between an event receiver
// and the commit that consumes it. Coordinates keep the last event's values.
const latchCells = [
  sourceField.downActive, sourceField.moveActive, sourceField.upActive,
  photoSourceField.clickActive, photoSourceField.previousActive, photoSourceField.nextActive, photoSourceField.closeActive,
]
const coordinateCells = [
  sourceField.downX, sourceField.downY, sourceField.moveX, sourceField.moveY, sourceField.upX, sourceField.upY,
  photoSourceField.clickX, photoSourceField.clickY,
]

// 1. Program sizes: all roots, commit roots, display roots, and which source cells display rows depend on.
{
  const rows: Record<string, unknown>[] = []
  for (const [label, options] of [
    ['split-table, Photos reads current frame', {springs: 'split-table', photosInputs: 'current-frame'}],
    ['source-matrix, Photos reads current frame', {springs: 'source-matrix', photosInputs: 'current-frame'}],
    ['source-matrix, Photos reads previous frame', {springs: 'source-matrix', photosInputs: 'previous-frame'}],
    ['source-matrix, Photos reads stepped springs', {springs: 'source-matrix', photosInputs: 'stepped-springs'}],
  ] as [string, Partial<EventTimeOptions>][]) {
    const machine = createEventTimeMachine({...options, evaluator: 'executor'})
    const all = programSize(machine.base.tensorProgram)
    const commit = programSize(machine.circuit.compileTensorProgram(machine.commitRoots))
    const displayProgram = machine.circuit.compileTensorProgram(machine.displayRoots)
    const display = programSize(displayProgram)
    const clockCells = options.springs === 'source-matrix' ? frameCells : [bankSourceField.frameDeltaMs]
    // planInstances counts rows that depend on the given cells, directly or through other rows.
    const dependents = (cells: readonly number[]) => planInstances(displayProgram, cells, machine.displayRoots).counts
    rows.push({
      variant: label,
      'all roots: live / layers / weights': `${all.live} / ${all.layers} / ${all.weights}`,
      'commit roots (next-source)': `${commit.live} / ${commit.layers} / ${commit.weights}`,
      'display roots (projections)': `${display.live} / ${display.layers} / ${display.weights}`,
      'display rows that depend on event latches': dependents(latchCells).instanceRows,
      'display rows that depend on event coordinates': dependents(coordinateCells).instanceRows,
      'display rows that depend on latches or coordinates': dependents([...latchCells, ...coordinateCells]).instanceRows,
      'display rows that depend on the clock': dependents(clockCells).instanceRows,
      'display rows that depend on none of these': dependents([...latchCells, ...coordinateCells, ...clockCells]).sharedRows,
      'next-source cells copied through unchanged': machine.output.nextSource.filter((wire, field) => wire === field).length,
      'source cells': machine.table.length,
    })
  }
  print('Program sizes', rows, 'programSizes')
}

// 2. Commit per event across frame rates, against 240 fps.
{
  const rows: Record<string, unknown>[] = []
  const idleRows: Record<string, unknown>[] = []
  for (const [traceLabel, events] of traces) {
    for (const variant of variants) {
      const reference = replay(variant, events, frames(240))
      const summary = {
        schedules: 0,
        differentSchedules: 0,
        differingCommits: 0,
        differingCells: 0,
        sharedFrames: 0,
        bitMismatchFrames: 0,
        maxContinuousDifference: 0,
      }
      for (const [, schedule] of schedules) {
        const other = replay(variant, events, schedule)
        const commits = compareCommitLogs(reference.commits, other.commits)
        const displays = compareDisplays(reference.displays, other.displays)
        summary.schedules++
        if (!commits.sameSchedule) summary.differentSchedules++
        summary.differingCommits += commits.differingCommits
        summary.differingCells += commits.differingCells
        summary.sharedFrames += displays.sharedFrames
        summary.bitMismatchFrames += displays.bitMismatchFrames
        summary.maxContinuousDifference = Math.max(summary.maxContinuousDifference, displays.maxContinuousDifference)
      }
      rows.push({
        trace: traceLabel,
        variant: variant.label,
        commits: reference.commits.length,
        'event commits': reference.counts.event,
        'settle commits': reference.counts.settle,
        'frame schedules compared': summary.schedules,
        'schedules with a different commit sequence': summary.differentSchedules,
        'commits whose table differs in any bit': summary.differingCommits,
        'shared display frames': summary.sharedFrames,
        'display frames with any different bit': summary.bitMismatchFrames,
        'max position difference (px)': summary.maxContinuousDifference,
      })
      if (variant.label === 'source-matrix, predicted settle' || variant.label === 'source-matrix, interval settle') {
        const lastEventTime = events[events.length - 1]!.time
        const lastCommit = reference.commits[reference.commits.length - 1]!
        idleRows.push({
          trace: traceLabel,
          variant: variant.label,
          'distinct event timestamps': new Set(events.map(event => event.time)).size,
          'commits in 11 s': reference.commits.length,
          'settle commits after the last event': reference.commits.filter(commit => commit.time > lastEventTime).length,
          'last commit (ms)': Math.round(lastCommit.time * 100) / 100,
          'trace ends (ms)': durationMs,
          'settle commit still scheduled at the end': reference.nextSettleTime === null ? 'none' : reference.nextSettleTime,
          'displays at 60 fps that report animating': replay(variant, events, frames(60)).displays.filter(record => record.animationActive > 0).length,
        })
      }
    }
  }
  print('Commit per event across frame rates, compared with 240 fps (10, 30, 60, 120 fps, 60 fps with 500 ms and 2 s stalls, 240 fps with a 500 ms stall)', rows, 'commitsAcrossRates')
  print('Commits while idle', idleRows, 'idleCommits')
}

// 2b. For contrast: frames write back (spring-bank's model), with event-time evaluations.
{
  const rows: Record<string, unknown>[] = []
  for (const [traceLabel, events] of traces) {
    const run = (schedule: FrameSchedule) => {
      const machine = createWindowManagerMachine({...bankOptions, springs: 'source-matrix'})
      const frameTimes = scheduleFrameTimes(schedule)
      const frameTimeSet = new Set(frameTimes)
      const tables = new Map<number, Float32Array>()
      const records: FrameRecord[] = replayTrace(machine, events, frameTimes, {
        evaluateAtEventTimes: true,
        afterStep: (_, time) => {
          if (frameTimeSet.has(time)) tables.set(time, Float32Array.from(machine.source))
        },
      })
      return {records, tables}
    }
    const reference = run(frames(240))
    const referenceByTime = new Map(reference.records.map(record => [record.time, record]))
    // Window opacity is every 6th window value, photo and thumbnail opacity every 5th after the 24 window values.
    const isOpacity = (offset: number) => offset < 24 ? offset % 6 === 5 : (offset - 24) % 5 === 4
    const summary = {sharedFrames: 0, differentTables: 0, mostCells: 0, maxDifference: 0, maxPositionDifference: 0, activeMismatches: 0}
    for (const [, schedule] of schedules) {
      const other = run(schedule)
      const comparison = compareAtSharedTimes(reference.records, other.records)
      summary.sharedFrames += comparison.sharedFrames
      summary.maxDifference = Math.max(summary.maxDifference, comparison.maxContinuousDifference)
      summary.activeMismatches += comparison.animationActiveMismatchFrames
      for (const record of other.records) {
        const match = referenceByTime.get(record.time)
        if (match === undefined) continue
        record.continuous.forEach((value, offset) => {
          if (!isOpacity(offset)) summary.maxPositionDifference = Math.max(summary.maxPositionDifference, Math.abs(value - match.continuous[offset]!))
        })
      }
      for (const [time, table] of other.tables) {
        const match = reference.tables.get(time)
        if (match === undefined) continue
        let cells = 0
        for (let cell = 0; cell < table.length; cell++) if (!Object.is(table[cell], match[cell])) cells++
        if (cells > 0) summary.differentTables++
        summary.mostCells = Math.max(summary.mostCells, cells)
      }
    }
    rows.push({
      trace: traceLabel,
      'shared frames': summary.sharedFrames,
      'frames whose written-back table differs in any bit': summary.differentTables,
      'most differing cells in one frame': summary.mostCells,
      'max difference, opacity included': summary.maxDifference,
      'max position and size difference (px)': summary.maxPositionDifference,
      'frames with different animationActive': summary.activeMismatches,
    })
  }
  print('For contrast: frames that write back, with event-time evaluations (spring-bank), source-matrix, same schedules against 240 fps', rows, 'writeBackAcrossRates')
}

// 3. Costs per commit and per display.
{
  const eventsEvery5Ms = traceEvents('live resize, random press offsets, seed 7')
  const rows: Record<string, unknown>[] = []
  for (const [traceLabel, events] of [
    ['live resize, seed 7, pointer moves every 5 ms', eventsEvery5Ms],
    ['the same, pointer moves coalesced to 120 Hz', coalescePointerMoves(eventsEvery5Ms, 120)],
  ] as [string, readonly TraceEvent[]][]) {
    for (const evaluator of ['executor', 'generated'] as const) {
      for (const springs of ['split-table', 'source-matrix'] as const) {
        const machine = createEventTimeMachine({springs, evaluator})
        const initial = machine.snapshot()
        const commit = machine.commit
        const display = machine.display
        let commitMs = 0
        let commits = 0
        let displayMs = 0
        let displays = 0
        machine.commit = time => {
          const started = performance.now()
          const evaluation = commit(time)
          commitMs += performance.now() - started
          commits++
          return evaluation
        }
        machine.display = time => {
          const started = performance.now()
          const evaluation = display(time)
          displayMs += performance.now() - started
          displays++
          return evaluation
        }
        const perRound: {commit: number, display: number, commits: number, displays: number}[] = []
        for (let round = 0; round < 14; round++) {
          machine.restore(initial)
          commitMs = 0
          commits = 0
          displayMs = 0
          displays = 0
          // Interval settle commits, so no settle probe runs displays inside the timing.
          replayCommitPerEvent(machine, events, scheduleFrameTimes(frames(60)), {settle: 'interval', durationMs, recordTables: false, recordDisplays: false})
          perRound.push({commit: commitMs * 1000 / commits, display: displayMs * 1000 / displays, commits, displays})
        }
        const warm = perRound.slice(7)
        rows.push({
          trace: traceLabel,
          evaluator,
          springs,
          events: events.length,
          'commits per replay': warm[0]!.commits,
          'µs per commit (rough)': median(warm.map(entry => entry.commit)),
          'displays per replay (60 fps)': warm[0]!.displays,
          'µs per display (rough)': median(warm.map(entry => entry.display)),
        })
      }
    }
  }
  print('Cost per commit and per display, 14 replays, median of the last 7', rows, 'costs')
}

// 4. What differs between a commit evaluation and a display at the same time.
{
  const machine = createEventTimeMachine({springs: 'source-matrix', evaluator: 'executor'})
  const layout = displayLayout(machine)
  const invert = (fields: Record<string, number>) => Object.fromEntries(Object.entries(fields).filter(([name]) => name !== 'size').map(([name, value]) => [value, name]))
  const windowNames = invert(windowOutputField)
  const dockNames = invert(dockOutputField)
  const photoNames = invert(photoField)
  const controlNames = invert(controlField)
  const label = (offset: number) => {
    if (offset < layout.dockItems) return `window ${windowNames[(offset - layout.windows) % windowOutputField.size]}`
    if (offset < layout.animationActive) return `dock ${dockNames[(offset - layout.dockItems) % dockOutputField.size]}`
    if (offset === layout.animationActive) return 'animationActive'
    if (offset === layout.backdropOpacity) return 'backdrop opacity'
    if (offset < layout.thumbnails) return `photo ${photoNames[(offset - layout.photos) % photoField.size]}`
    if (offset < layout.previousControl) return `thumbnail ${photoNames[(offset - layout.thumbnails) % photoField.size]}`
    return `control ${controlNames[(offset - layout.previousControl) % controlField.size]}`
  }
  const differences = new Map<string, {commits: number, maxDifference: number}>()
  let eventCommits = 0
  const eventCells = {commits: 0, leavingNonzeroLatch: 0, leavingNonzeroCoordinates: 0}
  replayCommitPerEvent(machine, traceEvents('live resize, random press offsets, seed 7'), [], {
    settle: 'predicted',
    durationMs,
    recordTables: false,
    afterCommit(kind, time, evaluation) {
      // Displays copy the written-back table, so these are the event cells every later display sees.
      eventCells.commits++
      if (latchCells.some(cell => machine.table[cell] !== 0)) eventCells.leavingNonzeroLatch++
      if (coordinateCells.some(cell => machine.table[cell] !== 0)) eventCells.leavingNonzeroCoordinates++
      if (kind !== 'event') return
      eventCommits++
      const committed = Float32Array.from(machine.displayRoots, wire => evaluation.values[wire]!)
      const shown = machine.display(time)
      const differingLabels = new Map<string, number>()
      machine.displayRoots.forEach((wire, offset) => {
        const value = shown.values[wire]!
        if (Object.is(value, committed[offset])) return
        const name = label(offset)
        differingLabels.set(name, Math.max(differingLabels.get(name) ?? 0, Math.abs(value - committed[offset]!)))
      })
      for (const [name, difference] of differingLabels) {
        const entry = differences.get(name) ?? {commits: 0, maxDifference: 0}
        entry.commits++
        entry.maxDifference = Math.max(entry.maxDifference, difference)
        differences.set(name, entry)
      }
    },
  })
  const rows = [...differences].map(([name, entry]) => ({
    output: name,
    'event commits where the commit evaluation and a display at the same time differ': entry.commits,
    'of event commits': eventCommits,
    'max difference': entry.maxDifference,
  }))
  print('Outputs that differ between an event commit\'s evaluation and a display at the same timestamp (live resize, seed 7)', rows, 'commitVersusDisplay')
  print('Event cells in the written-back table after each commit (live resize, seed 7)', [{
    commits: eventCells.commits,
    'commits that leave a nonzero event latch': eventCells.leavingNonzeroLatch,
    'commits that leave nonzero event coordinates': eventCells.leavingNonzeroCoordinates,
  }], 'eventCellsOnDisplays')
}

// 5. Float64 doctrine springs on commits and displays.
{
  const rows: Record<string, unknown>[] = []
  for (const traceLabel of ['every event 1 ms later', 'live resize, random press offsets, seed 7']) {
    for (const springs of ['split-table', 'source-matrix'] as const) {
      const machine = createEventTimeMachine({springs, evaluator: 'executor', debugOutputs: true})
      const commits = checkCommitSprings(machine)
      const displays = createDisplaySpringCheck(machine)
      replayCommitPerEvent(machine, traceEvents(traceLabel), scheduleFrameTimes(frames(60)), {
        settle: 'predicted',
        durationMs,
        recordTables: false,
        recordDisplays: false,
        afterDisplay: (evaluation, time) => displays.check(evaluation, time),
      })
      rows.push({
        trace: traceLabel,
        springs,
        commits: commits.frames,
        'commits that step': commits.stepFrames,
        'commits: max position error (px)': commits.maxPositionError,
        'commits: settle bit mismatches': commits.settleMismatches,
        'displays at 60 fps': displays.result.displays,
        'displays: max position error (px)': displays.result.maxPositionError,
        'displays: max velocity error (px/s)': displays.result.maxVelocityError,
        'displays: settle bit mismatches': displays.result.settleMismatches,
      })
    }
  }
  print('Window springs against float64 doctrine loops', rows, 'float64Springs')
}

// 6. Predictions: sizes, cost, bit checks against displays, settling.
{
  const rows: Record<string, unknown>[] = []
  for (const photosInputs of ['current-frame', 'previous-frame', 'stepped-springs'] as const) {
    const machine = createEventTimeMachine({springs: 'source-matrix', photosInputs})
    const predictor = createPredictor(machine)
    const offsets = continuousOffsets(machine)
    const tables: Float32Array[] = []
    const stats = {predictions: 0, values: 0, mismatches: 0, probeDisagreements: 0, noSettle: 0, animatingAfterSettle: 0, maxSnapDifference: 0}
    const settleSteps = new Map<number | null, number>()
    replayCommitPerEvent(machine, traceEvents('live resize, random press offsets, seed 7'), [], {
      settle: 'predicted',
      durationMs,
      recordTables: false,
      afterCommit() {
        if (!machine.running()) return
        const prediction = predictor.predict()
        stats.predictions++
        if (tables.length < 12) tables.push(Float32Array.from(machine.table))
        for (let sample = 0; sample < sampleCount; sample++) {
          const evaluation = machine.display(prediction.originTime + sample * 4)
          for (let root = 0; root < prediction.rootCount; root++) {
            stats.values++
            if (!Object.is(evaluation.values[machine.displayPositions[root]!], prediction.samples[sample * prediction.rootCount + root])) stats.mismatches++
          }
        }
        if (sequentialSettleProbe(machine) !== prediction.settleStep) stats.probeDisagreements++
        if (prediction.settleStep === null) stats.noSettle++
        settleSteps.set(prediction.settleStep, (settleSteps.get(prediction.settleStep) ?? 0) + 1)
        const snap = snapStatistics(prediction, predictor.activeColumn, offsets)
        stats.animatingAfterSettle += snap.animatingAfterSettle
        stats.maxSnapDifference = Math.max(stats.maxSnapDifference, snap.maxSnapDifference)
      },
    })
    const target = new Float32Array(sampleCount * predictor.roots.length)
    const predictionTimes: number[] = []
    const displayTimes: number[] = []
    const probeTimes: number[] = []
    for (let round = 0; round < 30; round++) {
      for (const table of tables) {
        machine.table.set(table)
        let started = performance.now()
        predictor.predict(target)
        predictionTimes.push(performance.now() - started)
        if (round % 3 !== 0) continue
        started = performance.now()
        for (let sample = 0; sample < sampleCount; sample++) machine.display(machine.lastCommitTime! + sample * 4)
        displayTimes.push(performance.now() - started)
        started = performance.now()
        sequentialSettleProbe(machine)
        probeTimes.push(performance.now() - started)
      }
    }
    const size = programSize(predictor.program)
    rows.push({
      'Photos reads': photosInputs,
      'display program: live rows / layers': `${size.live} / ${size.layers}`,
      'per-sample rows': predictor.plan.counts.instanceRows,
      'per-sample layers': predictor.plan.counts.instanceLayers,
      'per-sample weights': predictor.plan.counts.instanceWeights,
      'shared rows': predictor.plan.counts.sharedRows,
      'predictions checked': stats.predictions,
      'values checked against displays': stats.values,
      mismatches: stats.mismatches,
      'settle step differs from the sequential probe': stats.probeDisagreements,
      'settle steps seen': [...settleSteps].map(([step, count]) => `${step ?? 'none'}×${count}`).join(', '),
      'samples after the settle step that still report animating': stats.animatingAfterSettle,
      'max snap difference (px)': stats.maxSnapDifference,
      'ms per prediction, 301 samples (rough)': median(predictionTimes.slice(predictionTimes.length >> 1)),
      'ms for 301 display evaluations (rough)': median(displayTimes.slice(displayTimes.length >> 1)),
      'ms for the sequential settle probe (rough)': median(probeTimes.slice(probeTimes.length >> 1)),
    })
  }
  print('Predictions of all 301 samples (live resize, seed 7, every commit that leaves the clock running)', rows, 'predictions')
}

// 7. What is on screen at 240 fps times, against 240 fps displays, with and without stalls.
{
  const rows: Record<string, unknown>[] = []
  const heldRows: Record<string, unknown>[] = []
  const invalidationRows: Record<string, unknown>[] = []
  const stallLabel = (stall: Stall | undefined) => stall === undefined ? 'none' : `${stall.durationMs} ms at ${stall.startMs} ms`
  // Presses on 30 fps frames reach the compositor before both stalls (240 fps
  // renders every 30 fps frame time); in the other traces an event arrives after
  // the last main-thread frame before each stall.
  for (const traceLabel of ['presses on 30 fps frames', 'every event 1 ms later', 'random press offsets, seed 7', 'live resize, random press offsets, seed 7', 'live resize, random press offsets, seed 99']) {
    const events = traceEvents(traceLabel)
    const times = scheduleFrameTimes(frames(240))
    const referenceMachine = createEventTimeMachine({springs: 'source-matrix'})
    const reference: DisplayRecord[] = replayCommitPerEvent(referenceMachine, events, times, {settle: 'predicted', durationMs}).displays
    const groups = screenGroups(createTracks(referenceMachine), referenceMachine.displayRoots.length)
    for (const stall of [undefined, stall500, stall2s]) {
      const machine = createEventTimeMachine({springs: 'source-matrix'})
      const presenter = simulateKeyframePresenter(machine, createPredictor(machine), events, times, stall === undefined ? {durationMs} : {durationMs, stall})
      const stale = staleWindow(events, times, stall)
      const byStale = compareScreens(reference, presenter.rows, groups, stale)
      const byStall = compareScreens(reference, presenter.rows, groups, stallWindow(stall))
      rows.push({
        trace: traceLabel,
        stall: stallLabel(stall),
        'stale interval': stale === null ? 'none' : `${Math.round(stale[0])}..${stale[1]} ms`,
        'frames (240 fps times)': byStale.frames,
        'transform and opacity: frames with any different bit outside the stale interval': byStale.groups.composited.differingFramesOutsideWindow,
        'transform and opacity inside the stale interval: frames with any different bit': byStale.groups.composited.differingFramesInsideWindow,
        'transform and opacity inside the stale interval: max px': byStale.groups.composited.maxPxInsideWindow,
        'width, height, z-index: frames with any different bit': byStall.groups.layout.differingFrames,
        'width, height, z-index: of those, outside the stall': byStall.groups.layout.differingFramesOutsideWindow,
        'width and height: max px': byStall.groups.layout.maxPx,
        'all outputs outside the stall: frames with any different bit': byStall.groups.all.differingFramesOutsideWindow,
        'frames where an animation blends two samples': presenter.stats.blendedFrames,
      })
      if (stall === undefined) {
        invalidationRows.push({
          trace: traceLabel,
          predictions: presenter.stats.predictions,
          'event commits': presenter.stats.eventCommits,
          'event commits before the previous prediction settled': presenter.stats.invalidatedWhileAnimating,
          'predictions with animated elements': presenter.stats.predictionsWithAnimatedTracks,
          'mean animated elements per such prediction': presenter.stats.animatedTracks / Math.max(1, presenter.stats.predictionsWithAnimatedTracks),
          'most animated elements': presenter.stats.maxAnimatedTracks,
          'animations started': presenter.stats.animations,
          'keyframe objects created in 11 s': presenter.stats.keyframes,
        })
      }
    }
    for (const stall of [undefined, stall500, stall2s]) {
      const records = replayCommitPerEvent(createEventTimeMachine({springs: 'source-matrix'}), events, scheduleFrameTimes(frames(60, stall)), {settle: 'predicted', durationMs}).displays
      const comparison = compareScreens(reference, holdLastFrame(records, times), groups, stallWindow(stall))
      heldRows.push({
        trace: traceLabel,
        stall: stallLabel(stall),
        'frames (240 fps times)': comparison.frames,
        'frames with any different bit': comparison.groups.all.differingFrames,
        'transform and opacity outside the stall: max px': comparison.groups.composited.maxPxOutsideWindow,
        'transform and opacity inside the stall: max px': comparison.groups.composited.maxPxInsideWindow,
        'width and height inside the stall: max px': comparison.groups.layout.maxPxInsideWindow,
      })
    }
  }
  print('What predicted keyframes show at 240 fps times, compared with 240 fps display evaluations', rows, 'keyframePlayback')
  print('What display frames at 60 fps show at 240 fps times, last frame held, compared with 240 fps display evaluations', heldRows, 'heldFrames')
  print('Predictions and invalidation along each trace', invalidationRows, 'invalidation')
}

// 7b. Early Photos reads when displays never write back.
{
  const events = traceEvents('live resize, random press offsets, seed 7')
  const times = scheduleFrameTimes(frames(240))
  const photosStart = 24
  const photosDifference = (left: Float32Array, right: Float32Array) => {
    let maximum = 0
    for (let offset = photosStart; offset < left.length; offset++) maximum = Math.max(maximum, Math.abs(left[offset]! - right[offset]!))
    return maximum
  }
  const commitPerEvent = (photosInputs: EventTimeOptions['photosInputs']) =>
    replayCommitPerEvent(createEventTimeMachine({springs: 'source-matrix', photosInputs}), events, times, {settle: 'predicted', durationMs})
  const writeBack = (photosInputs: EventTimeOptions['photosInputs']) =>
    replayTrace(createWindowManagerMachine({...bankOptions, springs: 'source-matrix', photosInputs}), events, times, {evaluateAtEventTimes: true})
  const currentCommits = commitPerEvent('current-frame')
  const currentFrames = writeBack('current-frame')
  const rows: Record<string, unknown>[] = []
  for (const photosInputs of ['previous-frame', 'stepped-springs'] as const) {
    for (const [model, left, right] of [
      ['commit per event, 240 fps displays', currentCommits.displays, commitPerEvent(photosInputs).displays],
      ['frames write back at 240 fps, with event-time evaluations', currentFrames, writeBack(photosInputs)],
    ] as [string, readonly {time: number, continuous: Float32Array}[], readonly {time: number, continuous: Float32Array}[]][]) {
      let maximum = 0
      let worstTime = 0
      let framesOver = 0
      left.forEach((record, index) => {
        const difference = photosDifference(record.continuous, right[index]!.continuous)
        if (difference > 0.001) framesOver++
        if (difference > maximum) {
          maximum = difference
          worstTime = record.time
        }
      })
      rows.push({
        'Photos reads': photosInputs,
        model,
        frames: left.length,
        'max Photos difference from current-frame reads (px)': maximum,
        'at (ms)': Math.round(worstTime),
        'frames differing by more than 0.001 px': framesOver,
      })
    }
  }
  print('Photos reading early inputs, compared with current-frame reads (live resize, seed 7)', rows, 'earlyPhotosInputs')
}

// 7c. The page's work per commit: plan and keyframe objects for a maximize.
{
  const coldStart = performance.now()
  const scene = createEventTimeScene()
  const buildMilliseconds = performance.now() - coldStart
  scene.mount(0, 1280, 800)
  const mountPredictionMilliseconds = scene.timings.lastPredictionMilliseconds
  scene.pointerDown(100, 1163, 212)
  scene.pointerUp(100, 1163, 212)
  const firstAnimatedPredictionMilliseconds = scene.timings.lastPredictionMilliseconds
  const planTimes: number[] = []
  let keyframes = 0
  for (let round = 0; round < 60; round++) {
    const started = performance.now()
    const plan = planKeyframes(scene.prediction, scene.tracks)
    keyframes = 0
    for (const planned of plan.tracks) {
      if (planned.animated.composited) keyframes += trackKeyframes(scene.prediction, plan, planned.track, 'composited').length
      if (planned.animated.layout) keyframes += trackKeyframes(scene.prediction, plan, planned.track, 'layout').length
    }
    planTimes.push(performance.now() - started)
  }
  const {plan} = scene
  print('The page\'s work for one commit (maximize Photos)', [{
    'scene build ms (circuit, programs, generated code)': buildMilliseconds,
    'first prediction ms (mount, cold code)': mountPredictionMilliseconds,
    'second prediction ms': firstAnimatedPredictionMilliseconds,
    'settle step': plan.lastSample,
    'animated elements': plan.animatedTrackCount,
    'composited animations': plan.compositedAnimationCount,
    'layout animations': plan.layoutAnimationCount,
    'keyframe objects': keyframes,
    'ms to plan and build keyframe objects (rough)': median(planTimes.slice(30)),
  }], 'pageWork')
}

// 8. WGSL for the per-sample part.
{
  const rows: Record<string, unknown>[] = []
  for (const photosInputs of ['current-frame', 'previous-frame', 'stepped-springs'] as const) {
    const machine = createEventTimeMachine({springs: 'source-matrix', photosInputs})
    const predictor = createPredictor(machine)
    const committer = createCommitter(machine, {settle: 'predicted'})
    machine.setViewport(1280, 800)
    committer.mount(0)
    committer.commitEvents(100, () => {
      machine.base.pointerDown(1163, 212)
      machine.base.pointerUp(1163, 212)
    })
    const outputCount = predictor.plan.outputs.length
    const cpu = new Float32Array(sampleCount * outputCount)
    predictor.runner.runShared(machine.table)
    predictor.runner.runInstances(predictor.powers(), sampleCount, cpu)
    const module = emitInstanceWgsl(predictor.plan, {guard: 'max'})
    const interpreted = new Float32Array(sampleCount * outputCount)
    createWgslInterpreter(module.code)(packSharedBuffer(module, predictor.runner), predictor.powers(), sampleCount, interpreted)
    let mismatches = 0
    cpu.forEach((value, index) => {
      if (value !== interpreted[index]) mismatches++
    })
    rows.push({
      'Photos reads': photosInputs,
      'shader statements': module.statementCount,
      'max guards': module.exposure.guards,
      'boolean rows': module.exposure.booleanRows,
      'gather reads': module.exposure.gatherReads,
      'shader KB': Math.round(module.code.length / 1000),
      'outputs interpreted with strict f32': cpu.length,
      'differ from the CPU instance loop': mismatches,
    })
  }
  print('Per-sample WGSL, interpreted on the CPU (Photos maximize, 301 samples)', rows, 'wgsl')
  const gpuRows: Record<string, unknown>[] = []
  for (const file of ['gpu-results-wgpu.json', 'gpu-results-dawn.json']) {
    const handle = Bun.file(new URL(`./${file}`, import.meta.url))
    if (!(await handle.exists())) continue
    const saved = await handle.json() as {runtime: string, results: Record<string, unknown>[]}
    for (const result of saved.results) {
      gpuRows.push({
        runtime: saved.runtime,
        'Photos reads': result['photosInputs'],
        guard: result['guard'],
        'committed tables': result['tables'],
        'outputs compared': result['comparedOutputs'],
        'outputs that differ': result['mismatches'],
        'largest difference': result['maximumDifference'],
        'animation bits that differ': result['animationBitMismatches'],
        'shader compile ms': result['shaderCompileMilliseconds'],
        'CPU instance loop ms': result['medianCpuMilliseconds'],
        'GPU upload + dispatch + readback ms': result['medianGpuMilliseconds'],
      })
    }
  }
  print('Per-sample WGSL on the GPU (saved outputs of gpu-prediction.ts)', gpuRows, 'gpu')
}

results['reportSeconds'] = Math.round((performance.now() - reportStart) / 100) / 10
console.log(`\nReport took ${results['reportSeconds']} s`)
await Bun.write(new URL('./results.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`)

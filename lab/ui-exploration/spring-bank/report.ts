// Measurements for README.md. Run from the repo root:
//   bun lab/ui-exploration/spring-bank/report.ts
// Prints markdown tables and writes results.json next to this file. Counts are
// exact; timings are rough because other processes share the machine.
import {Circuit, type Wire, emitSpring} from '../../../numeric-ui-core.ts'
import {createPhotoGalleryMachine as createOriginalPhotosMachine} from '../../../photo-gallery.ts'
import {createWindowManagerMachine as createOriginalMachine} from '../../../window-manager.ts'
import {checkSpec, compareBankWithReference} from './bank-check.ts'
import {createBankMachine, laneField} from './bank-machine.ts'
import {createPhotoGalleryMachine} from './photo-gallery.ts'
import {createPredictiveScene, predictSerial, predictiveSampleCount, predictiveSpec} from './predictive.ts'
import {
  type SpringPowers,
  createConstantPowerGroup,
  createSourceMatrixGroup,
  createSourceTableGroup,
  createSpringClock,
  emitSpringBox,
  frameMatrixBound,
  sectionRanges,
} from './spring-bank.ts'
import {defaultClockConfig} from './spring-math.ts'
import {
  type FrameSchedule,
  type ReplayMachine,
  type TraceEvent,
  compareAtSharedTimes,
  createIndirectOSTrace,
  createWindowSpringCheck,
  offsetPresses,
  randomPressOffsets,
  replayTrace,
  scheduleFrameTimes,
  settleTimes,
} from './trace.ts'
import {bankOptions, createWindowManagerMachine, originalOptions} from './window-manager.ts'

const results: Record<string, unknown> = {}

function markdownTable(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return ''
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const format = (value: unknown) => value === undefined
    ? '0'
    : typeof value === 'number'
      ? (Number.isInteger(value) ? value.toLocaleString('en-US') : value.toPrecision(3))
      : String(value)
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(column => format(row[column])).join(' | ')} |`),
  ].join('\n')
}

function median(values: number[]) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
}

// Label operations by the spring builder that created them. Bank builders
// record their operation index ranges with withSection. emitSpring doesn't, so
// operations created with emitSpring on the call stack are labeled here; this
// only runs while building the circuits being attributed. The JavaScriptCore
// stack trace leaves out some intermediate frames, which is why the bank uses
// recorded ranges instead of the stack.
Error.stackTraceLimit = 80
let attributing = false
const emitSpringLabelsByCircuit = new WeakMap<Circuit, string[]>()
const originalAppend = Circuit.prototype.append
Circuit.prototype.append = function appendWithLabel(this: Circuit, ...args: Parameters<Circuit['append']>) {
  const before = this.operations.length
  const wire = originalAppend.apply(this, args)
  if (attributing && this.operations.length > before && /emitSpring\b/.test(new Error().stack ?? '')) {
    let labels = emitSpringLabelsByCircuit.get(this)
    if (labels === undefined) {
      labels = []
      emitSpringLabelsByCircuit.set(this, labels)
    }
    labels[this.operations.length - 1] = 'emitSpring'
  }
  return wire
}

// Spring builder labels recorded on one circuit, by operation index.
function localLabels(circuit: Circuit): (string | undefined)[] {
  const labels: (string | undefined)[] = [...(emitSpringLabelsByCircuit.get(circuit) ?? [])]
  for (const section of sectionRanges(circuit)) {
    for (let index = section.start; index < section.end; index++) labels[index] = `bank ${section.label}`
  }
  return labels
}

type InlinedCircuit = {circuit: Circuit, wireMap: readonly Wire[]}

// Operations that inlineCircuit copies from Photos into IndirectOS have no
// recorded label in the parent circuit, so the labels recorded on the Photos
// circuit are mapped through inlineCircuit's wire map.
function operationLabels(circuit: Circuit, inlined: InlinedCircuit | undefined) {
  const labels = localLabels(circuit)
  if (inlined === undefined) return labels
  localLabels(inlined.circuit).forEach((label, index) => {
    const wire = inlined.wireMap[inlined.circuit.sourceSize + index]!
    if (label !== undefined && wire >= circuit.sourceSize) labels[wire - circuit.sourceSize] ??= `Photos ${label}`
  })
  return labels
}

type Program = {
  valueCount: number
  sourceSize: number
  wireOrder: ArrayLike<number>
  layers: {outputSize: number, weights: Float32Array, gateRows: ArrayLike<number>, booleanRows: ArrayLike<number>, gatherReads: unknown[]}[]
}

function programSize(program: Program) {
  return {
    sources: program.sourceSize,
    live: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    widest: Math.max(...program.layers.map(layer => layer.outputSize)),
    weights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    reglu: program.layers.reduce((total, layer) => total + layer.gateRows.length, 0),
    booleans: program.layers.reduce((total, layer) => total + layer.booleanRows.length, 0),
    gathers: program.layers.reduce((total, layer) => total + layer.gatherReads.length, 0),
  }
}

function liveByLabel(circuit: Circuit, program: Program, labels: readonly (string | undefined)[]) {
  const counts: Record<string, number> = {}
  for (let index = program.sourceSize; index < program.valueCount; index++) {
    const label = labels[program.wireOrder[index]! - circuit.sourceSize] ?? 'other'
    counts[label] = (counts[label] ?? 0) + 1
  }
  return counts
}

const springLabels = ['emitSpring', 'bank clock', 'bank group', 'bank box']
const sumLabels = (counts: Record<string, number>, names: readonly string[]) =>
  names.reduce((total, name) => total + (counts[name] ?? 0), 0)

// Walk back from the deepest live operation, always into a dependency one layer
// shallower, and count the path's operations by label. Also report the most
// spring operations over every chain of maximum depth, so the count doesn't
// depend on which dependency the walk picks.
function deepestPath(circuit: Circuit, program: Program, labels: readonly (string | undefined)[]) {
  let wire = -1
  let depth = 0
  for (let index = program.sourceSize; index < program.valueCount; index++) {
    const candidate = program.wireOrder[index]!
    if (circuit.depths[candidate]! > depth) {
      depth = circuit.depths[candidate]!
      wire = candidate
    }
  }
  const counts: Record<string, number> = {}
  let pathOperations = 0
  let pathSpringOperations = 0
  while (wire >= circuit.sourceSize) {
    const operation = circuit.operations[wire - circuit.sourceSize]!
    const label = labels[wire - circuit.sourceSize]
    counts[label ?? 'other'] = (counts[label ?? 'other'] ?? 0) + 1
    pathOperations++
    if (label !== undefined) pathSpringOperations++
    const dependencies = [...operation.leftTerms, ...operation.gateTerms].map(([dependency]) => dependency)
    const next = dependencies.find(dependency => circuit.depths[dependency] === circuit.depths[wire]! - 1)
    if (next === undefined) break
    wire = next
  }
  // Operations only read earlier wires, so one pass in index order is enough.
  const mostSpringOperations = new Int32Array(circuit.operations.length)
  for (let index = 0; index < circuit.operations.length; index++) {
    const operation = circuit.operations[index]!
    const ownDepth = circuit.depths[circuit.sourceSize + index]!
    let previous = 0
    for (const [dependency] of [...operation.leftTerms, ...operation.gateTerms]) {
      if (dependency >= circuit.sourceSize && circuit.depths[dependency] === ownDepth - 1) {
        previous = Math.max(previous, mostSpringOperations[dependency - circuit.sourceSize]!)
      }
    }
    mostSpringOperations[index] = previous + (labels[index] === undefined ? 0 : 1)
  }
  let mostOnAnyDeepestChain = 0
  for (let index = program.sourceSize; index < program.valueCount; index++) {
    const candidate = program.wireOrder[index]!
    if (candidate >= circuit.sourceSize && circuit.depths[candidate] === depth) {
      mostOnAnyDeepestChain = Math.max(mostOnAnyDeepestChain, mostSpringOperations[candidate - circuit.sourceSize]!)
    }
  }
  return {
    'path operations': pathOperations,
    'spring operations on the path': pathSpringOperations,
    'most spring operations on any deepest chain': mostOnAnyDeepestChain,
    ...counts,
  }
}

function evaluationMicroseconds(circuit: Circuit, source: Float32Array) {
  const samples: number[] = []
  for (let warm = 0; warm < 300; warm++) circuit.evaluateTensor(source)
  for (let round = 0; round < 7; round++) {
    const iterations = 300
    const started = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) circuit.evaluateTensor(source)
    samples.push((performance.now() - started) * 1000 / iterations)
  }
  return median(samples)
}

// 1. Sizes of IndirectOS variants.
{
  attributing = true
  const rows: Record<string, unknown>[] = []
  const deepest: Record<string, unknown>[] = []
  type SizedMachine = {circuit: Circuit, tensorProgram: Program, source: Float32Array, inlinedPhotos?: InlinedCircuit}
  const variants: [string, () => SizedMachine][] = [
    ['original window-manager.ts', () => createOriginalMachine()],
    ['copy, springs: original', () => createWindowManagerMachine(originalOptions)],
    ['copy, original springs, Photos reads previous frame', () => createWindowManagerMachine({...originalOptions, photosInputs: 'previous-frame'})],
  ]
  for (const springs of ['split-table', 'binary-powers', 'source-table', 'source-matrix'] as SpringPowers[]) {
    variants.push([`bank ${springs}`, () => createWindowManagerMachine({...bankOptions, springs})])
  }
  variants.push(['bank split-table, doctrine retarget', () => createWindowManagerMachine({...bankOptions, retarget: 'doctrine'})])
  variants.push(['bank split-table, Photos reads previous frame', () => createWindowManagerMachine({...bankOptions, photosInputs: 'previous-frame'})])
  variants.push(['bank split-table, Photos reads stepped springs', () => createWindowManagerMachine({...bankOptions, photosInputs: 'stepped-springs'})])
  variants.push(['bank source-matrix, Photos reads stepped springs', () => createWindowManagerMachine({...bankOptions, springs: 'source-matrix', photosInputs: 'stepped-springs'})])
  for (const [label, create] of variants) {
    const machine = create()
    const labels = operationLabels(machine.circuit, machine.inlinedPhotos)
    const counts = liveByLabel(machine.circuit, machine.tensorProgram, labels)
    rows.push({
      variant: label,
      ...programSize(machine.tensorProgram),
      'window spring builder live ops': sumLabels(counts, springLabels),
      'Photos spring builder live ops (inlined)': machine.inlinedPhotos === undefined
        ? 'n/a'
        : sumLabels(counts, springLabels.map(name => `Photos ${name}`)),
      'µs per evaluation (rough)': evaluationMicroseconds(machine.circuit, machine.source),
    })
    // The original file doesn't expose its inlined Photos circuit, so its
    // thumbnail springs would count as other operations. `copy, springs:
    // original` builds the same circuit and does expose it.
    if (machine.inlinedPhotos !== undefined) {
      deepest.push({variant: label, ...deepestPath(machine.circuit, machine.tensorProgram, labels)})
    }
  }
  attributing = false
  results['indirectOSSizes'] = rows
  results['deepestPath'] = deepest
  console.log('## IndirectOS sizes\n')
  console.log(markdownTable(rows))
  console.log('\nThe spring builder columns count live operations created inside emitSpring, or inside the bank clock, group, and box builders: for the window springs, and for the thumbnail springs inlined from Photos. Clamps and selects around the springs count elsewhere.\n')
  console.log('## Operations along the deepest path, by builder\n')
  console.log(markdownTable(deepest))
}

// 2. Photos standalone, where the thumbnail springs sit at the end of the circuit.
{
  attributing = true
  const rows: Record<string, unknown>[] = []
  for (const [label, create] of [
    ['original photo-gallery.ts', () => createOriginalPhotosMachine()],
    // The copy's bank springs always read a frame matrix from 4 source cells;
    // standalone, JS writes M^4 (16 ms) once, so there is no clock.
    ['copy, bank springs with a JS-written fixed 16 ms frame matrix (no clock)', () => createPhotoGalleryMachine({springs: 'source-matrix', retarget: 'deferred'})],
  ] as const) {
    const machine = create()
    const labels = operationLabels(machine.circuit, undefined)
    rows.push({
      variant: label,
      ...programSize(machine.tensorProgram),
      'thumbnail spring builder live ops': sumLabels(liveByLabel(machine.circuit, machine.tensorProgram, labels), springLabels),
    })
  }
  attributing = false
  results['photosSizes'] = rows
  console.log('\n## Photos standalone\n')
  console.log(markdownTable(rows))
}

// 3. Unit costs of the bank pieces against one emitSpring lane.
{
  const rows: Record<string, unknown>[] = []
  const measureUnit = (label: string, build: (circuit: Circuit) => Wire[], sourceSize: number) => {
    const circuit = new Circuit(sourceSize)
    const roots = build(circuit)
    rows.push({construction: label, ...programSize(circuit.compileTensorProgram(roots))})
  }
  measureUnit('emitSpring, one lane (runtime stiffness, damping, timestep)', circuit => {
    for (let wire = 0; wire < 11; wire++) circuit.assumeRange(wire, 0, Number.POSITIVE_INFINITY)
    circuit.assumeRange(10, 1, 1)
    const spring = emitSpring(circuit, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    return [spring.position, spring.velocity, spring.active]
  }, 11)
  const clockCells = {frameDeltaMs: 0, leftoverMs: 1, running: 2, unit: 3}
  const withClock = (circuit: Circuit) => {
    circuit.assumeRange(3, 1, 1)
    return createSpringClock(circuit, clockCells, defaultClockConfig)
  }
  measureUnit('clock: step count and leftover', circuit => {
    const clock = withClock(circuit)
    return [clock.stepCount, clock.nextLeftoverMs]
  }, 4)
  const constants = {stiffness: 650, damping: 45}
  for (const powers of ['split-table', 'binary-powers'] as const) {
    measureUnit(`clock plus one ${powers} group frame matrix`, circuit => {
      const group = createConstantPowerGroup(circuit, withClock(circuit), constants, powers)
      return [...group.frame]
    }, 4)
  }
  measureUnit('clock plus one source-table group frame matrix', circuit => {
    const clock = withClock(circuit)
    const cell = (index: number) => [4 + 4 * index, 5 + 4 * index, 6 + 4 * index, 7 + 4 * index] as const
    const group = createSourceTableGroup(circuit, clock, {
      coarse: Array.from({length: clock.coarseOneHot.length}, (_, index) => cell(index)),
      fine: Array.from({length: clock.fineOneHot.length}, (_, index) => cell(clock.coarseOneHot.length + index)),
    }, 256)
    return [...group.frame]
  }, 4 + 4 * 35)
  for (const laneCount of [1, 2, 5]) {
    for (const snap of [false, true]) {
      // Sources: unit, settleDistance, settleSpeed, snap, 4 frame cells, then 4 cells per lane.
      measureUnit(`one box of ${laneCount} lane${laneCount > 1 ? 's' : ''}${snap ? ' with a snap bit' : ''}, frame matrix given`, circuit => {
        circuit.assumeRange(0, 1, 1)
        for (const wire of [1, 2, 3]) circuit.assumeRange(wire, 0, 1)
        const group = createSourceMatrixGroup(circuit, [4, 5, 6, 7], frameMatrixBound(constants, defaultClockConfig))
        const box = emitSpringBox(circuit, Array.from({length: laneCount}, (_, lane) => ({
          group,
          position: 8 + lane * 4,
          velocity: 9 + lane * 4,
          destination: 10 + lane * 4,
          previousDestination: 11 + lane * 4,
        })), {unit: 0, settleDistance: 1, settleSpeed: 2, retarget: 'deferred', ...(snap ? {snap: 3} : {})})
        return [...box.positions, ...box.velocities, box.active]
      }, 8 + laneCount * 4)
    }
  }
  results['unitCosts'] = rows
  console.log('\n## Unit costs\n')
  console.log(markdownTable(rows))
}

// 4. Frame-rate independence along one trace, compared with 120 fps at the
// timestamps both runs rendered.
const trace = createIndirectOSTrace()
const resizeTrace = createIndirectOSTrace({liveResize: true})
const longDurationMs = trace.durationMs + 2000
type ReplayVariant = {label: string, create: () => ReplayMachine, evaluateAtEventTimes?: boolean}
const replayVariant = (variant: ReplayVariant, events: readonly TraceEvent[], schedule: FrameSchedule) =>
  replayTrace(variant.create(), events, scheduleFrameTimes(schedule), {evaluateAtEventTimes: variant.evaluateAtEventTimes === true})
function frameRateTable(events: readonly TraceEvent[], variants: readonly ReplayVariant[], schedules: [string, FrameSchedule][]) {
  const rows: Record<string, unknown>[] = []
  const settle: Record<string, unknown>[] = []
  for (const variant of variants) {
    const reference = replayVariant(variant, events, {fps: 120, durationMs: longDurationMs})
    settle.push({variant: variant.label, run: '120 fps', 'animation end times (ms)': settleTimes(reference).map(time => time.toFixed(1)).join(', ')})
    for (const [scheduleLabel, schedule] of schedules) {
      const other = replayVariant(variant, events, schedule)
      const comparison = compareAtSharedTimes(reference, other)
      rows.push({
        variant: variant.label,
        'compared with 120 fps': scheduleLabel,
        'shared frames': comparison.sharedFrames,
        'max position difference (px)': comparison.maxContinuousDifference,
        'at time (ms)': Math.round(comparison.worstTime),
        'frames with different focus, stack, flags': comparison.discreteMismatchFrames,
        'frames with different animationActive': comparison.animationActiveMismatchFrames,
      })
      settle.push({variant: variant.label, run: scheduleLabel, 'animation end times (ms)': settleTimes(other).map(time => time.toFixed(1)).join(', ')})
    }
  }
  return {rows, settle}
}
const bankDeferred: ReplayVariant = {label: 'bank split-table, deferred retarget', create: () => createWindowManagerMachine(bankOptions)}
const bankDoctrine: ReplayVariant = {label: 'bank split-table, doctrine retarget', create: () => createWindowManagerMachine({...bankOptions, retarget: 'doctrine'})}
const originalFile: ReplayVariant = {label: 'original window-manager.ts', create: () => createOriginalMachine()}
const withEventTimes = (variant: ReplayVariant): ReplayVariant =>
  ({...variant, label: `${variant.label}, event-time evaluations`, evaluateAtEventTimes: true})
{
  const schedules: [string, FrameSchedule][] = [
    ['10 fps', {fps: 10, durationMs: longDurationMs}],
    ['30 fps', {fps: 30, durationMs: longDurationMs}],
    ['60 fps', {fps: 60, durationMs: longDurationMs}],
    ['60 fps, 500 ms stall during an animation', {fps: 60, durationMs: longDurationMs, stall: {startMs: 2701, durationMs: 500}}],
    ['60 fps, 2 s stall during an animation', {fps: 60, durationMs: longDurationMs, stall: {startMs: 7001, durationMs: 2000}}],
  ]
  const variants: ReplayVariant[] = [
    bankDeferred,
    {label: 'bank source-matrix, deferred retarget', create: () => createWindowManagerMachine({...bankOptions, springs: 'source-matrix'})},
    bankDoctrine,
    originalFile,
  ]
  const {rows, settle} = frameRateTable(trace.events, variants, schedules)
  results['frameRateIndependence'] = rows
  results['settleTimes'] = settle
  console.log('\n## Frame-rate independence (same trace, compared at timestamps both runs rendered)\n')
  console.log(trace.segments.map(segment => `- ${segment.time.toFixed(1)} ms: ${segment.label}`).join('\n'))
  console.log('')
  console.log(markdownTable(rows))
  console.log('\n## Animation end times\n')
  console.log(markdownTable(settle))

  const resize = frameRateTable(resizeTrace.events, [bankDeferred, withEventTimes(bankDeferred), originalFile], schedules.slice(0, 4))
  results['frameRateIndependenceLiveResize'] = resize.rows
  console.log('\n## Frame-rate independence with a live resize of Photos at 5333 ms (destinations move every frame)\n')
  console.log(markdownTable(resize.rows))
}

// 4b. Presses between frames. The trace above puts every press on a 30 fps
// frame time; here presses move off that grid, so each frame rate processes a
// press in a frame at a different time. Event-time evaluations evaluate the
// circuit once more at each event's timestamp, without rendering.
{
  const schedules: [string, FrameSchedule][] = [
    ['10 fps', {fps: 10, durationMs: longDurationMs}],
    ['30 fps', {fps: 30, durationMs: longDurationMs}],
    ['60 fps', {fps: 60, durationMs: longDurationMs}],
    ['60 fps, 500 ms stall', {fps: 60, durationMs: longDurationMs, stall: {startMs: 2701, durationMs: 500}}],
  ]
  const traces: [string, readonly TraceEvent[]][] = [
    ['every event 1 ms later', offsetPresses(trace.events, () => 1)],
    ['random press offsets in 0..30 ms, seed 7', offsetPresses(trace.events, randomPressOffsets(7, 30))],
    ['random press offsets in 0..30 ms, seed 99', offsetPresses(trace.events, randomPressOffsets(99, 30))],
    ['live resize, random press offsets in 0..30 ms, seed 7', offsetPresses(resizeTrace.events, randomPressOffsets(7, 30))],
    ['live resize, random press offsets in 0..30 ms, seed 99', offsetPresses(resizeTrace.events, randomPressOffsets(99, 30))],
  ]
  const variants = [bankDeferred, bankDoctrine, originalFile, withEventTimes(bankDeferred), withEventTimes(bankDoctrine), withEventTimes(originalFile)]
  const rows: Record<string, unknown>[] = []
  const worst = new Map<string, Record<string, number>>()
  for (const [traceLabel, events] of traces) {
    for (const variant of variants) {
      const reference = replayVariant(variant, events, {fps: 120, durationMs: longDurationMs})
      const row: Record<string, unknown> = {trace: traceLabel, variant: variant.label}
      const summary = worst.get(variant.label) ?? {}
      let activeMismatchFrames = 0
      let discreteMismatchFrames = 0
      for (const [scheduleLabel, schedule] of schedules) {
        const comparison = compareAtSharedTimes(reference, replayVariant(variant, events, schedule))
        const column = `${scheduleLabel} (px)`
        row[column] = comparison.maxContinuousDifference
        summary[column] = Math.max(summary[column] ?? 0, comparison.maxContinuousDifference)
        activeMismatchFrames += comparison.animationActiveMismatchFrames
        discreteMismatchFrames += comparison.discreteMismatchFrames
      }
      row['frames with different animationActive'] = activeMismatchFrames
      row['frames with different focus, stack, flags'] = discreteMismatchFrames
      const activeColumn = 'frames with different animationActive'
      const discreteColumn = 'frames with different focus, stack, flags'
      summary[activeColumn] = (summary[activeColumn] ?? 0) + activeMismatchFrames
      summary[discreteColumn] = (summary[discreteColumn] ?? 0) + discreteMismatchFrames
      worst.set(variant.label, summary)
      rows.push(row)
    }
  }
  const summaryRows = [...worst].map(([label, summary]) => ({variant: label, ...summary}))
  results['pressesBetweenFrames'] = rows
  results['pressesBetweenFramesWorst'] = summaryRows
  console.log('\n## Presses between frames: max position difference from 120 fps at shared timestamps\n')
  console.log(markdownTable(rows))
  console.log('\n## Presses between frames: worst over the five traces (mismatch frames summed)\n')
  console.log(markdownTable(summaryRows))
}

// 5. Float64 doctrine check of the window springs inside IndirectOS.
{
  const rows: Record<string, unknown>[] = []
  for (const springs of ['split-table', 'binary-powers', 'source-table', 'source-matrix'] as SpringPowers[]) {
    for (const retarget of ['deferred', 'doctrine'] as const) {
      for (const fps of [30, 120]) {
        const machine = createWindowManagerMachine({...bankOptions, springs, retarget, debugOutputs: true})
        const check = createWindowSpringCheck(machine)
        replayTrace(machine, resizeTrace.events, scheduleFrameTimes({fps, durationMs: resizeTrace.durationMs}), {
          beforeStep: () => check.beforeStep(),
          afterStep: (values, time) => check.afterStep(values, time),
        })
        rows.push({
          springs,
          retarget,
          fps,
          frames: check.result.frames,
          'frames with steps': check.result.stepFrames,
          'max position error (px)': check.result.maxPositionError,
          'max velocity error (px/s)': check.result.maxVelocityError,
          'settle bit mismatches': check.result.settleMismatches,
        })
      }
    }
  }
  results['float64Check'] = rows
  console.log('\n## Window springs against float64 doctrine loops, one frame at a time (live resize trace)\n')
  console.log(markdownTable(rows))
}

// 5b. The standalone bank against float64 doctrine springs, along random frame
// times with 500 ms and 2 s stalls and retargets (bank-check.ts).
{
  const rows: Record<string, unknown>[] = []
  for (const powers of ['split-table', 'binary-powers', 'source-table', 'source-matrix'] as SpringPowers[]) {
    for (const retarget of ['deferred', 'doctrine'] as const) {
      const restarted = compareBankWithReference(createBankMachine(checkSpec, {powers, retarget}), retarget, checkSpec.groups, 400)
      const freeRunning = compareBankWithReference(createBankMachine(checkSpec, {powers, retarget}), retarget, checkSpec.groups, 3000, 'free-running')
      rows.push({
        powers,
        retarget,
        'restarted every frame, 400 frames: max position error (px)': restarted.maxPositionError,
        'restarted: frames with a different settle bit': restarted.settleMismatchFrames,
        'free-running, 3,000 frames: max position error while both animate (px)': freeRunning.maxPositionErrorWhileBothActive,
        'free-running: max position error (px)': freeRunning.maxPositionError,
        'free-running: frames with a different settle bit': freeRunning.settleMismatchFrames,
      })
    }
  }
  results['standaloneBankAccuracy'] = rows
  console.log('\n## Standalone bank against float64 doctrine loops\n')
  console.log(markdownTable(rows))
}

// 6. What reading early inputs costs Photos: compare its outputs frame by frame
// with the current-frame variant along the live resize trace at 60 fps.
{
  const schedule = scheduleFrameTimes({fps: 60, durationMs: resizeTrace.durationMs})
  const current = replayTrace(createWindowManagerMachine(bankOptions), resizeTrace.events, schedule)
  const windowGeometryCount = 24
  const rows: Record<string, unknown>[] = []
  for (const photosInputs of ['previous-frame', 'stepped-springs'] as const) {
    const other = replayTrace(createWindowManagerMachine({...bankOptions, photosInputs}), resizeTrace.events, schedule)
    let maxWindowDifference = 0
    let maxPhotosDifference = 0
    let maxPhotosDifferenceDuringResize = 0
    let framesWithPhotosDifference = 0
    let discreteMismatchFrames = 0
    const resizeStart = resizeTrace.segments.find(segment => segment.label.startsWith('resize'))!.time
    current.forEach((record, index) => {
      const match = other[index]!
      let photosDifference = 0
      for (let offset = 0; offset < record.continuous.length; offset++) {
        const difference = Math.abs(record.continuous[offset]! - match.continuous[offset]!)
        if (offset < windowGeometryCount) maxWindowDifference = Math.max(maxWindowDifference, difference)
        else photosDifference = Math.max(photosDifference, difference)
      }
      if (photosDifference > 1e-3) framesWithPhotosDifference++
      maxPhotosDifference = Math.max(maxPhotosDifference, photosDifference)
      if (record.time >= resizeStart && record.time <= resizeStart + 340) {
        maxPhotosDifferenceDuringResize = Math.max(maxPhotosDifferenceDuringResize, photosDifference)
      }
      if (record.discrete.some((value, offset) => value !== match.discrete[offset])) discreteMismatchFrames++
    })
    rows.push({
      'Photos reads': photosInputs,
      frames: current.length,
      'max window geometry difference (px)': maxWindowDifference,
      'max Photos difference (px)': maxPhotosDifference,
      'max Photos difference during the live resize (px)': maxPhotosDifferenceDuringResize,
      'frames where Photos differs by more than 0.001 px': framesWithPhotosDifference,
      'frames with different focus, stack, flags': discreteMismatchFrames,
    })
  }
  let maxPhotosWindowWidthStep = 0
  for (let index = 1; index < current.length; index++) {
    // Window 3 (Photos) width output.
    maxPhotosWindowWidthStep = Math.max(maxPhotosWindowWidthStep, Math.abs(current[index]!.continuous[20]! - current[index - 1]!.continuous[20]!))
  }
  results['earlyPhotosInputs'] = rows
  results['largestPhotosWindowWidthChangePerFrame'] = maxPhotosWindowWidthStep
  console.log('\n## Photos reading early inputs, compared with current-frame reads (live resize trace, 60 fps)\n')
  console.log(markdownTable(rows))
  console.log(`\nLargest change of the Photos window width between two 60 fps frames along the trace: ${maxPhotosWindowWidthStep.toFixed(1)} px`)
}

// 7. Predictive keyframes: cost per sample.
{
  const rows: Record<string, unknown>[] = []
  for (const powers of ['split-table', 'binary-powers', 'source-matrix'] as SpringPowers[]) {
    const scene = createPredictiveScene(powers)
    scene.arrange(1280, 800)
    scene.render(0, 'serial')
    scene.fling(1280, 800)
    scene.render(16, 'serial')
    const serial: number[] = []
    for (let round = 0; round < 15; round++) {
      const started = performance.now()
      predictSerial(scene.machine, predictiveSampleCount)
      serial.push((performance.now() - started) * 1000 / predictiveSampleCount)
    }
    rows.push({
      prediction: `${predictiveSampleCount} separate evaluations, ${powers}`,
      ...programSize(scene.machine.program),
      'µs per sample (rough)': median(serial.slice(5)),
    })
    if (powers !== 'split-table') continue
    const batch: number[] = []
    for (let round = 0; round < 15; round++) {
      const started = performance.now()
      scene.batch.predict(scene.machine)
      batch.push((performance.now() - started) * 1000 / predictiveSampleCount)
    }
    rows.push({
      prediction: `one batched evaluation of ${predictiveSampleCount} samples`,
      ...programSize(scene.batch.program),
      'µs per sample (rough)': median(batch.slice(5)),
    })
    // Plain float64 JS for context: carry state and step every lane once per sample.
    const plain: number[] = []
    const laneGroups = predictiveSpec.boxes.flatMap(box => box.lanes.map(lane => lane.group))
    for (let round = 0; round < 15; round++) {
      const positions = laneGroups.map((_, lane) => scene.machine.source[scene.machine.laneCell(lane, laneField.position)]!)
      const velocities = laneGroups.map((_, lane) => scene.machine.source[scene.machine.laneCell(lane, laneField.velocity)]!)
      const destinations = laneGroups.map((_, lane) => scene.machine.source[scene.machine.laneCell(lane, laneField.destination)]!)
      const output = new Float64Array(predictiveSampleCount * laneGroups.length)
      const started = performance.now()
      for (let sample = 0; sample < predictiveSampleCount; sample++) {
        for (let lane = 0; lane < laneGroups.length; lane++) {
          if (sample > 0) {
            const constants = predictiveSpec.groups[laneGroups[lane]!]!
            const acceleration = -constants.stiffness * (positions[lane]! - destinations[lane]!) - constants.damping * velocities[lane]!
            velocities[lane]! += acceleration * 0.004
            positions[lane]! += velocities[lane]! * 0.004
          }
          output[sample * laneGroups.length + lane] = positions[lane]!
        }
      }
      plain.push((performance.now() - started) * 1000 / predictiveSampleCount)
    }
    rows.push({prediction: 'plain JS loop carrying state, for context', 'µs per sample (rough)': median(plain.slice(5))})
    // Independent samples could snap at sample i and leave the destination again
    // at i + 1; count how often that happens.
    const samples = predictSerial(scene.machine, predictiveSampleCount)
    const laneCount = scene.machine.laneCount
    let unsnaps = 0
    for (let box = 0; box < predictiveSpec.boxes.length; box++) {
      let wasSnapped = false
      for (let sample = 0; sample < predictiveSampleCount; sample++) {
        const snapped = [0, 1, 2].every(lane =>
          samples[sample * laneCount + box * 3 + lane] === scene.machine.source[scene.machine.laneCell(box * 3 + lane, laneField.destination)])
        if (wasSnapped && !snapped) unsnaps++
        wasSnapped = snapped
      }
    }
    results['predictionUnsnaps'] = unsnaps
  }
  const machine = createWindowManagerMachine(bankOptions)
  rows.push({
    prediction: 'whole IndirectOS bank circuit per sample, for scale',
    ...programSize(machine.tensorProgram),
    'µs per sample (rough)': evaluationMicroseconds(machine.circuit, machine.source),
  })
  results['predictiveCosts'] = rows
  console.log('\n## Predictive keyframes\n')
  console.log(markdownTable(rows))
  console.log(`\nPredicted boxes that snap and then leave their destination again: ${results['predictionUnsnaps']}`)
}

// 8. Frame matrix entry bounds, which set the declared ranges.
{
  const bounds = [
    {constants: 'stiffness 650, damping 45 (IndirectOS)', bound: frameMatrixBound({stiffness: 650, damping: 45}, defaultClockConfig)},
    {constants: 'stiffness 290, damping 24', bound: frameMatrixBound({stiffness: 290, damping: 24}, defaultClockConfig)},
    {constants: 'stiffness 333, damping 12', bound: frameMatrixBound({stiffness: 333, damping: 12}, defaultClockConfig)},
  ]
  results['frameMatrixBounds'] = bounds
  console.log('\n## Largest frame matrix entry over 0..300 steps\n')
  console.log(markdownTable(bounds))
}

await Bun.write(new URL('./results.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`)

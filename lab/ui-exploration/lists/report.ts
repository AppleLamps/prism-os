// Heavy measurement for the collection prototypes.
// Run from the repo root: bun lab/ui-exploration/lists/report.ts [list] [routing] [cards] [flick] [hazard] [pieces]
// Writes lab/ui-exploration/lists/results.json and prints one JSON line per row.
// Timings are rough: other agents share this machine.
import {SourceLayout, createRandom, emitCatchUpClock, emitSpringLane, eulerStepMatrix, measure, stagePowers} from './common.ts'
import {checkList, checkReleaseVelocity, checkRouting, demoRowHeights, routingPatterns, sweepUniformList} from './checks.ts'
import {createListRunner, buildList, type ListVariant} from './list.ts'
import {buildRouting, writeRoutingSource} from './routing.ts'
import {buildCards, createCardsMachine} from './cards.ts'
import {buildFlick} from './flick.ts'
import {demoCardSizes, runCardsDifferential, runFlickDifferential, type CardsDifferential, type FlickDifferential} from './traces.ts'
import {emitBoundedReciprocal, emitReleaseVelocity, releaseVelocityLimit, type SampleWires} from './velocity.ts'
import {emitSpring, type Circuit, type Wire} from '../../../src/runtime/numeric-ui-core.ts'

const selected = new Set(process.argv.slice(2))
const wants = (name: string) => selected.size === 0 || selected.has(name)
const results: Record<string, unknown[]> = {}
function record(section: string, row: Record<string, unknown>) {
  (results[section] ??= []).push(row)
  console.log(JSON.stringify({section, ...row}))
}

function milliseconds(run: () => void) {
  const start = performance.now()
  run()
  return Math.round((performance.now() - start) * 10) / 10
}

function medianMicroseconds(run: () => void) {
  let calls = 1
  for (;;) {
    const start = performance.now()
    for (let call = 0; call < calls; call++) run()
    if (performance.now() - start >= 10 || calls >= 1 << 20) break
    calls *= 2
  }
  const samples: number[] = []
  for (let batch = 0; batch < 11; batch++) {
    const start = performance.now()
    for (let call = 0; call < calls; call++) run()
    samples.push((performance.now() - start) * 1000 / calls)
  }
  samples.sort((left, right) => left - right)
  return Math.round(samples[5]! * 100) / 100
}

function compiledSize(circuit: Circuit, roots: readonly Wire[]) {
  let size: ReturnType<typeof measure> | undefined
  const compileMs = milliseconds(() => { size = measure(circuit, roots) })
  return {...size!, compileMs}
}

// Live operations and stored weights attributed to builder sections.
function sectionSplit(circuit: Circuit, roots: readonly Wire[], sections: readonly {name: string, start: number, end: number}[]) {
  const program = circuit.compileTensorProgram(roots)
  const split = sections.map(section => ({name: section.name, liveOperations: 0, storedWeights: 0}))
  const sectionOf = (wire: number) => {
    const operation = wire - circuit.sourceSize
    return split[sections.findIndex(section => operation >= section.start && operation < section.end)]!
  }
  let available = program.sourceSize
  for (const layer of program.layers) {
    for (let row = 0; row < layer.outputSize; row++) {
      const entry = sectionOf(program.wireOrder[available + row]!)
      entry.liveOperations++
      entry.storedWeights += layer.rowOffsets[row + 1]! - layer.rowOffsets[row]!
    }
    for (let gate = 0; gate < layer.gateRows.length; gate++) {
      const entry = sectionOf(program.wireOrder[available + layer.gateRows[gate]!]!)
      const projectionRow = layer.outputSize + gate
      entry.storedWeights += layer.rowOffsets[projectionRow + 1]! - layer.rowOffsets[projectionRow]!
    }
    available += layer.outputSize
  }
  return split
}

if (wants('list')) {
  const variants: {label: string, variant: ListVariant}[] = []
  for (const rowCount of [1_000, 10_000, 100_000]) variants.push({label: `uniform, data in JS, ${rowCount} rows`, variant: {kind: 'uniform', rowCount, rowHeight: 40, dataRead: 'js'}})
  for (const rowCount of [1_000, 3_000, 10_000, 30_000]) variants.push({label: `uniform, data through one-hot, ${rowCount} rows`, variant: {kind: 'uniform', rowCount, rowHeight: 40, dataRead: 'oneHot'}})
  for (const rowCount of [1_000, 3_000, 10_000, 30_000]) variants.push({label: `variable, prefix in circuit (Brent-Kung), data in JS, ${rowCount} rows`, variant: {kind: 'variable', rowCount, minimumHeight: 36, maximumHeight: 72, prefix: 'brentKung', dataRead: 'js'}})
  variants.push({label: 'variable, prefix in circuit (Brent-Kung), data through one-hot, 10000 rows', variant: {kind: 'variable', rowCount: 10_000, minimumHeight: 36, maximumHeight: 72, prefix: 'brentKung', dataRead: 'oneHot'}})
  variants.push({label: 'variable, prefix in circuit (blocked), data in JS, 10000 rows', variant: {kind: 'variable', rowCount: 10_000, minimumHeight: 36, maximumHeight: 72, prefix: 'blocked', dataRead: 'js'}})
  variants.push({label: 'variable, bottoms from JS, data in JS, 10000 rows', variant: {kind: 'variable', rowCount: 10_000, minimumHeight: 36, maximumHeight: 72, prefix: 'js', dataRead: 'js'}})
  variants.push({label: 'variable, bottoms from JS, data through one-hot, 10000 rows', variant: {kind: 'variable', rowCount: 10_000, minimumHeight: 36, maximumHeight: 72, prefix: 'js', dataRead: 'oneHot'}})
  for (const {label, variant} of variants) {
    let list: ReturnType<typeof buildList> | undefined
    const buildMs = milliseconds(() => { list = buildList(variant) })
    const size = compiledSize(list!.circuit, list!.roots)
    const heights = variant.kind === 'uniform' ? Array.from({length: variant.rowCount}, () => variant.rowHeight) : demoRowHeights(variant.rowCount, 1, 36, 72)
    const check = checkList(list!, heights, variant.rowCount <= 10_000 ? 2000 : 300, 7)
    const runner = createListRunner(list!)
    if (variant.kind === 'variable') runner.setRows(heights)
    const random = createRandom(3)
    const scrollRange = Math.min(40 * variant.rowCount, 36 * variant.rowCount) - 800
    const microseconds = medianMicroseconds(() => { runner.run(Math.floor(random() * scrollRange * 4) / 4, 600) })
    record('list', {label, sourceCells: list!.circuit.sourceSize, buildMs, ...size, microsecondsPerFrame: microseconds, trials: check.trials, mismatches: check.mismatches})
  }
  const sweepList = buildList({kind: 'uniform', rowCount: 10_000, rowHeight: 40, dataRead: 'js'})
  for (const viewportHeight of [600, 920]) {
    let sweep: ReturnType<typeof sweepUniformList> | undefined
    const ms = milliseconds(() => { sweep = sweepUniformList(sweepList, 40, viewportHeight) })
    record('list-sweep', {label: `every quarter-pixel scrollTop of 10,000 uniform rows, viewport ${viewportHeight}: rows, y, and slots against the occlusion test`, ...sweep!, ms})
  }
}

if (wants('routing')) {
  for (const itemCount of [100, 300, 1000, 3000]) {
    for (const slotCount of [10, 20, 40]) {
      let routing: ReturnType<typeof buildRouting> | undefined
      const buildMs = milliseconds(() => { routing = buildRouting({itemCount, slotCount, prefix: 'brentKung'})})
      const size = compiledSize(routing!.circuit, routing!.roots)
      const visibility = measure(routing!.circuit, routing!.parts.visibility)
      const counts = measure(routing!.circuit, routing!.parts.counts)
      const check = checkRouting(routing!, routingPatterns(itemCount, slotCount, itemCount <= 1000 ? 200 : 40, itemCount + slotCount), 2)
      const run = routing!.circuit.createTensorEvaluator(routing!.roots)
      const source = new Float32Array(routing!.circuit.sourceSize)
      const timingPattern = routingPatterns(itemCount, slotCount, 5, 99).at(-1)!
      writeRoutingSource(routing!, source, timingPattern.items, timingPattern.lower, timingPattern.upper, timingPattern.pointerX)
      const microseconds = medianMicroseconds(() => { run(source) })
      record('routing', {
        itemCount, slotCount, buildMs, ...size, microsecondsPerFrame: microseconds, patterns: check.patterns, mismatches: check.mismatches,
        visibilityOperations: visibility.liveOperations,
        prefixCountOperations: counts.liveOperations - visibility.liveOperations,
        routingAndSlotOperations: size.liveOperations - counts.liveOperations,
      })
    }
  }
  for (const prefix of ['chain', 'blocked', 'brentKung', 'wide'] as const) {
    let routing: ReturnType<typeof buildRouting> | undefined
    const buildMs = milliseconds(() => { routing = buildRouting({itemCount: 1000, slotCount: 20, prefix})})
    const size = compiledSize(routing!.circuit, routing!.roots)
    const check = checkRouting(routing!, routingPatterns(1000, 20, 30, 5))
    record('routing-prefix', {prefix, buildMs, ...size, mismatches: check.mismatches})
  }
}

if (wants('cards')) for (const layout of ['rankCount', 'incremental'] as const) {
  for (const cardCount of [5, 20, 50, 100, 200]) {
    let built: ReturnType<typeof buildCards> | undefined
    const buildMs = milliseconds(() => { built = buildCards(demoCardSizes(cardCount), {layout}) })
    const size = compiledSize(built!.circuit, built!.roots)
    const split = sectionSplit(built!.circuit, built!.roots, built!.sections)
    const machine = createCardsMachine(built!, 1024)
    machine.step({frameTime: 5000, windowSizeX: 1024, events: {mouseup: null, mousemove: null, pointerdown: null}})
    const evaluate = built!.circuit.createTensorEvaluator(built!.roots)
    const microseconds = medianMicroseconds(() => { evaluate(machine.source) })
    // Seeds 1..20 for every card count up to 100; fewer frames per seed as the circuit grows.
    const framesPerSeed = cardCount <= 5 ? 3000 : cardCount <= 20 ? 2000 : cardCount <= 50 ? 1500 : cardCount <= 100 ? 600 : 0
    const seeds = framesPerSeed === 0 ? [] : Array.from({length: 20}, (_, index) => index + 1)
    const differentials = seeds.map(seed => runCardsDifferential(seed, cardCount, framesPerSeed, built!))
    const sum = (read: (entry: CardsDifferential) => number) => differentials.reduce((total, entry) => total + read(entry), 0)
    const largest = (read: (entry: CardsDifferential) => number) => Math.max(0, ...differentials.map(read))
    const runsWhere = (test: (entry: CardsDifferential) => boolean) => differentials.filter(test).length
    record('cards', {
      layout, cardCount, sourceCells: built!.circuit.sourceSize, buildMs, ...size, microsecondsPerFrame: microseconds,
      seeds: seeds.length,
      framesPerSeed,
      differentialFrames: sum(entry => entry.frames),
      decisionMismatchFrames: sum(entry => entry.decisionMismatchFrames),
      animatingMismatchFrames: sum(entry => entry.animatingMismatchFrames),
      runsWithAnimatingMismatch: runsWhere(entry => entry.animatingMismatchFrames > 0),
      maximumPositionErrorBeforeAnimatingMismatch: largest(entry => entry.maximumPositionErrorBeforeAnimatingMismatch),
      maximumPositionError: largest(entry => entry.maximumPositionError),
      runsWithPositionErrorAbove1px: runsWhere(entry => entry.maximumPositionError > 1),
      maximumScaleError: largest(entry => entry.maximumScaleError),
      reorderFrames: sum(entry => entry.reorderFrames),
      cardReleases: sum(entry => entry.cardReleases),
      clampedReleases: sum(entry => entry.clampedReleases),
      sections: split,
    })
  }
}

if (wants('cards-seeds')) {
  // More seeds at 50 and 100 cards, with the incremental layout because it's
  // faster (both layouts give identical differential results). Before the release
  // velocity clamp, seeds 10 and 401 at 100 cards and seed 22 at 50 cards stopped
  // on a source range error (a card velocity beyond its declared range). Seed 302
  // at 50 cards shows a large position error after a differing animating bit.
  for (const {cardCount, framesPerSeed, seeds} of [
    {cardCount: 50, framesPerSeed: 1500, seeds: [...Array.from({length: 60}, (_, index) => index + 1), 302]},
    {cardCount: 100, framesPerSeed: 1200, seeds: [...Array.from({length: 60}, (_, index) => index + 1), 401]},
  ]) {
    const built = buildCards(demoCardSizes(cardCount), {layout: 'incremental'})
    const differentials: CardsDifferential[] = []
    const stoppedRuns: string[] = []
    for (const seed of seeds) {
      try {
        differentials.push(runCardsDifferential(seed, cardCount, framesPerSeed, built))
      } catch (error) {
        stoppedRuns.push(`seed ${seed}: ${String(error).slice(0, 120)}`)
      }
    }
    const sum = (read: (entry: CardsDifferential) => number) => differentials.reduce((total, entry) => total + read(entry), 0)
    const largest = (read: (entry: CardsDifferential) => number) => Math.max(0, ...differentials.map(read))
    const runsWhere = (test: (entry: CardsDifferential) => boolean) => differentials.filter(test).length
    record('cards-seeds', {
      layout: 'incremental', cardCount, seeds: seeds.length, framesPerSeed, stoppedRuns,
      differentialFrames: sum(entry => entry.frames),
      decisionMismatchFrames: sum(entry => entry.decisionMismatchFrames),
      animatingMismatchFrames: sum(entry => entry.animatingMismatchFrames),
      runsWithAnimatingMismatch: runsWhere(entry => entry.animatingMismatchFrames > 0),
      maximumPositionErrorBeforeAnimatingMismatch: largest(entry => entry.maximumPositionErrorBeforeAnimatingMismatch),
      maximumPositionError: largest(entry => entry.maximumPositionError),
      runsWithPositionErrorAbove1px: runsWhere(entry => entry.maximumPositionError > 1),
      cardReleases: sum(entry => entry.cardReleases),
      clampedReleases: sum(entry => entry.clampedReleases),
    })
  }
}

if (wants('flick')) {
  let built: ReturnType<typeof buildFlick> | undefined
  const buildMs = milliseconds(() => { built = buildFlick() })
  const size = compiledSize(built!.circuit, built!.roots)
  const seeds = Array.from({length: 25}, (_, index) => index + 1)
  const differentials = seeds.map(seed => runFlickDifferential(seed, 5000, built!))
  const sum = (read: (entry: FlickDifferential) => number) => differentials.reduce((total, entry) => total + read(entry), 0)
  const largest = (read: (entry: FlickDifferential) => number) => Math.max(0, ...differentials.map(read))
  const evaluate = built!.circuit.createTensorEvaluator(built!.roots)
  const source = new Float32Array(built!.circuit.sourceSize)
  source[built!.cells.windowW] = 1280
  source[built!.cells.windowH] = 800
  const microseconds = medianMicroseconds(() => { evaluate(source) })
  record('flick', {
    sourceCells: built!.circuit.sourceSize, buildMs, ...size, microsecondsPerFrame: microseconds,
    seeds: seeds.length,
    framesPerSeed: 5000,
    frames: sum(entry => entry.frames),
    flicks: sum(entry => entry.flicks),
    clampedFlicks: sum(entry => entry.clampedFlicks),
    decisionMismatchFrames: sum(entry => entry.decisionMismatchFrames),
    scheduleMismatchFrames: sum(entry => entry.scheduleMismatchFrames),
    maximumPositionError: largest(entry => entry.maximumPositionError),
    maximumRestError: largest(entry => entry.maximumRestError),
    maximumFlickSpeed: largest(entry => entry.maximumFlickSpeed),
  })
}

if (wants('hazard')) {
  // The same reciprocal seed, weighted exact bits, built as a plain affine (the
  // builder inlines each bit's two relus) or as roundAffine (each bit stays a
  // wire), measured on the seed alone and after 4 Newton steps.
  for (const seedForm of ['composed', 'materialized'] as const) {
    for (const newtonSteps of [0, 4]) {
      const layout = new SourceLayout()
      const dt = layout.cell(0, 128)
      const circuit = layout.createCircuit()
      const reciprocal = emitBoundedReciprocal(circuit, dt, newtonSteps, seedForm)
      const run = circuit.createTensorEvaluator([reciprocal])
      let worst = 0
      let worstAtDt = 0
      let valuesAbove1Percent = 0
      for (let step = 1; step <= 128 * 64; step++) {
        const value = step / 64
        const error = Math.abs(run(Float32Array.of(value))[0]! * value - 1)
        if (error > worst) {
          worst = error
          worstAtDt = value
        }
        if (error > 0.01) valuesAbove1Percent++
      }
      record('hazard', {seedForm, newtonSteps, dtValues: 128 * 64, worstRelativeErrorOfReciprocal: worst, worstAtDt, valuesAbove1Percent})
    }
  }
}

if (wants('pieces')) {
  const powers = stagePowers(eulerStepMatrix(290, 24, 0.004), 9)
  {
    // One spring lane as cards.ts and flick.ts build it, with position,
    // destination, velocity, and the 9 step bits as source cells.
    const layout = new SourceLayout()
    const position = layout.cell(-(2 ** 16), 2 ** 16)
    const destination = layout.cell(-(2 ** 16), 2 ** 16)
    const velocity = layout.cell(-(2 ** 20), 2 ** 20)
    const stepBits = layout.cells(9, 0, 1)
    const circuit = layout.createCircuit()
    const lane = emitSpringLane(circuit, position, destination, velocity, stepBits, powers)
    record('pieces', {label: 'one spring lane: 9 matrix-power stages plus settling (position, destination, velocity, and step bits as source cells)', ...measure(circuit, [lane.position, lane.velocity, lane.active])})
  }
  {
    // HandwiredOS emitSpring, with its parameters as source cells.
    const layout = new SourceLayout()
    const [position, destination, velocity, stiffness, damping, timestep, settleDistance, settleSpeed, settleDistanceScale, settleSpeedScale, unit] = layout.cells(11, -65536, 65536)
    const circuit = layout.createCircuit()
    circuit.assumeRange(stiffness!, 0, 1000)
    circuit.assumeRange(damping!, 0, 100)
    circuit.assumeRange(timestep!, 0, 0.032)
    circuit.assumeRange(settleDistance!, 0, 1)
    circuit.assumeRange(settleSpeed!, 0, 1)
    circuit.assumeRange(settleDistanceScale!, 0, 1000)
    circuit.assumeRange(settleSpeedScale!, 0, 1000)
    circuit.assumeRange(unit!, 1, 1)
    const spring = emitSpring(circuit, position!, destination!, velocity!, stiffness!, damping!, timestep!, settleDistance!, settleSpeed!, settleDistanceScale!, settleSpeedScale!, unit!)
    record('pieces', {label: 'HandwiredOS emitSpring: 4 substeps of a runtime timestep (parameters as source cells)', ...measure(circuit, [spring.position, spring.velocity, spring.active])})
  }
  {
    // The catch-up clock as cards.ts builds it, including the animating gate and
    // the 2^15 ms clamp on elapsed time. Checked on every elapsed value on the
    // 1/64 ms grid in 0..2^15 (written as backlog, with frameDelta 0), plus random
    // (animating, backlog, frameDelta) triples, some of which reach the clamp.
    const layout = new SourceLayout()
    const animating = layout.cell(0, 1)
    const backlog = layout.cell(0, 2 ** 15)
    const frameDelta = layout.cell(0, 2 ** 14)
    const circuit = layout.createCircuit()
    const clock = emitCatchUpClock(circuit, animating, backlog, frameDelta, 9)
    const roots = [clock.steps, ...clock.stepBits]
    const run = circuit.createTensorEvaluator(roots)
    const source = new Float32Array(circuit.sourceSize)
    let checked = 0
    let mismatches = 0
    const check = (animatingValue: number, backlogValue: number, frameDeltaValue: number) => {
      source[animating] = animatingValue
      source[backlog] = backlogValue
      source[frameDelta] = frameDeltaValue
      const outputs = run(source)
      const elapsedValue = animatingValue === 1 ? Math.min(2 ** 15, backlogValue + frameDeltaValue) : 0
      const expectedSteps = Math.min(300, Math.floor(elapsedValue / 4))
      let ok = outputs[0] === expectedSteps
      for (let bit = 0; ok && bit < 9; bit++) ok = outputs[1 + bit] === ((expectedSteps >> bit) & 1)
      checked++
      if (!ok) mismatches++
    }
    const ms = milliseconds(() => {
      for (let gridSteps = 0; gridSteps <= 2 ** 15 * 64; gridSteps++) check(1, gridSteps / 64, 0)
      const random = createRandom(17)
      for (let trial = 0; trial < 200_000; trial++) {
        check(random() < 0.9 ? 1 : 0, Math.floor(random() * 2 ** 15 * 64) / 64, Math.floor(random() * 2 ** 14 * 64) / 64)
      }
    })
    record('pieces', {label: 'catch-up clock: min(300, floor(elapsed / 4)) and its 9 bits, including the animating gate and the 2^15 ms clamp on elapsed', ...measure(circuit, roots), inputsChecked: checked, mismatches, ms})
  }
  for (const velocityLimit of [undefined, releaseVelocityLimit]) {
    // Release velocity with the 24 samples and the count as source cells.
    const layout = new SourceLayout()
    const count = layout.cell(1, 24)
    const samples: SampleWires[] = Array.from({length: 24}, () => ({x: layout.cell(-32768, 32768), y: layout.cell(-32768, 32768), time: layout.cell(-65536, 1024), real: layout.cell(0, 1)}))
    const circuit = layout.createCircuit()
    const release = emitReleaseVelocity(circuit, samples, count, {velocityLimit})
    const check = checkReleaseVelocity(4000, 11, velocityLimit)
    record('pieces', {
      label: velocityLimit === undefined ? 'release velocity: 24 samples, window search, gather, 4 Newton steps (samples as source cells)' : 'release velocity with the ±2^16 px/s clamp (samples as source cells)',
      ...measure(circuit, [release.velocityX, release.velocityY]),
      ...check,
    })
  }
}

// Sections that were not run keep their previous rows.
const resultsFile = Bun.file(new URL('./results.json', import.meta.url))
const previous = await resultsFile.exists() ? await resultsFile.json() as Record<string, unknown[]> : {}
await Bun.write(resultsFile, JSON.stringify({...previous, ...results}, null, 2) + '\n')

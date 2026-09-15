// Measurements for the README: circuit sizes, live operations per phase, rough timings, exactness over
// streams, line changes of visible words, interruptions and frames to settle, and where arriving
// words start.
// Run: bun lab/ui-exploration/streaming-words/report.ts [sizes] [phases] [streams] [interrupt] [spawn]
// With no arguments it runs every part. Results merge into results.json next to this file.
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {loadPretext} from './fake-canvas.ts'
import {createGeneratedEvaluator} from './generated.ts'
import {indexReadRuntime, medianMicroseconds, type Runtime} from './kit.ts'
import {buildForTurns, conversationTurns, replyTurns, rightAlignedTurns, testFont} from './samples.ts'
import {StreamSession, timedChunks} from './session.ts'
import {referenceWordsFromTable, referenceWordsStep, wordDrift, type ReferenceWords} from './spring-reference.ts'
import {defaultFlowLayout, liveOperationsByPhase, type LineCountMode, type SpawnMode, type StreamBuild} from './stream-circuit.ts'
import {chunkEvents, layoutFlow, layoutMismatches, lineHops, referenceLayout, writeFlowState, type ChunkMode, type Turn} from './stream-model.ts'
import {defaultSpringConfig} from './word-springs.ts'

const pretext = await loadPretext()
const requested = new Set(process.argv.slice(2))
const runPart = (name: string) => requested.size === 0 || requested.has(name)
const format = (value: number) => value.toLocaleString('en-US')
const printRow = (cells: (string | number)[]) => console.log(`| ${cells.map(cell => typeof cell === 'number' ? format(cell) : cell).join(' | ')} |`)
const resultsPath = new URL('./results.json', import.meta.url).pathname
const results: Record<string, unknown> = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {}
const columnWidthFor = (maxWidth: number) => maxWidth + 80

function timingIterations(liveOperations: number) {
  return Math.max(20, Math.min(2000, Math.floor(4e6 / liveOperations)))
}

// Writes the state after `fraction` of the stream's chunks, so timing runs on a realistic table.
function midStreamTable(build: StreamBuild, turns: readonly Turn[], fraction: number, maxWidth: number) {
  const events = chunkEvents(turns)
  const prefixLengths = turns.map(() => 0)
  for (const event of events.slice(0, Math.floor(events.length * fraction))) prefixLengths[event.turn] = event.end
  const table = build.initialTable()
  table[build.cells.maxWidth] = maxWidth
  table[build.cells.columnWidth] = columnWidthFor(maxWidth)
  writeFlowState(build, table, layoutFlow(pretext, testFont, turns, prefixLengths, maxWidth))
  if (build.cells.stepCount !== null) table[build.cells.stepCount] = 4
  return table
}

// Streams every chunk at one width and compares with pretext. Also returns a signature of every
// state's layout outputs, so variants can be compared with each other bit for bit.
function streamStates(build: StreamBuild, turns: readonly Turn[], maxWidth: number) {
  const table = build.initialTable()
  table[build.cells.maxWidth] = maxWidth
  table[build.cells.columnWidth] = columnWidthFor(maxWidth)
  const prefixLengths = turns.map(() => 0)
  let states = 0
  let mismatchedStates = 0
  let hops = 0
  let growingSegmentHops = 0
  let previous: ReturnType<typeof referenceLayout> | null = null
  const signatures: string[] = []
  let firstProblem: string | null = null
  for (const event of chunkEvents(turns)) {
    prefixLengths[event.turn] = event.end
    const state = layoutFlow(pretext, testFont, turns, prefixLengths, maxWidth)
    writeFlowState(build, table, state)
    const expected = referenceLayout(state, {layout: defaultFlowLayout, columnWidth: columnWidthFor(maxWidth), turnCapacity: build.options.turnCapacity, rightAlignedTurns})
    const problems = layoutMismatches(build, table, state, expected)
    if (problems.length > 0) {
      mismatchedStates++
      firstProblem ??= problems[0]!
    }
    const change = lineHops(previous, expected)
    hops += change.hops
    growingSegmentHops += change.growingSegmentHops
    previous = expected
    const outputs = build.outputs(build.compiled.evaluate(table))
    signatures.push([
      outputs.lineCount, outputs.windowOverflow, outputs.moreLinesThanSlots,
      ...outputs.lineIndex.subarray(0, state.arrivedCount), ...outputs.x.subarray(0, state.arrivedCount),
      ...outputs.targetX.subarray(0, state.arrivedCount), ...outputs.targetY.subarray(0, state.arrivedCount),
      ...outputs.turnWidth, ...outputs.turnLineCount, ...outputs.turnTop, ...outputs.turnLeft,
    ].join(','))
    states++
  }
  return {states, mismatchedStates, hops, growingSegmentHops, signatures, firstProblem}
}

// Compiles with the index-read runtime but none of its compile changes, so only the instruction differs.
const instructionOnly = indexReadRuntime({lowerIndexOneHots: false, inferBitFamilies: false, recomputeDepths: false})
// The runtime's defaults: relu one-hots resolved from their index wire, bit families, recomputed depths.
const indexReadDefaults = indexReadRuntime({})

type Variant = {name: string, lineCountMode: LineCountMode, runtime?: Runtime, bubbles: boolean, spawn: SpawnMode | null, conversation: boolean}

function buildVariant(words: number, variant: Variant) {
  const turns = variant.conversation ? conversationTurns(words, 3) : replyTurns(words, 3)
  const build = buildForTurns(pretext, turns, {
    lineCountMode: variant.lineCountMode,
    turnCapacity: variant.conversation ? turns.length : 1,
    bubbles: variant.bubbles,
    springs: variant.spawn === null ? null : {config: defaultSpringConfig, spawn: variant.spawn},
    ...(variant.runtime === undefined ? {} : {runtime: variant.runtime}),
  })
  return {turns, build}
}

if (runPart('sizes')) {
  console.log('\n## Circuit sizes and rough timings\n')
  printRow(['Words', 'Segments', 'Turns', 'Variant', 'Live ops', 'Layers', 'Stored weights', 'Gather reads', 'Gather table entries', 'Index reads', 'One-hot ops', 'Build ms', 'Executor µs', 'Generated JS µs (seconds of warmup)', 'Mismatched states (3-char chunks, 240 px)', 'Same layout outputs as the first variant of its kind'])
  printRow(Array(16).fill('---'))
  const rows: unknown[] = []
  const variants: Variant[] = [
    {name: 'layout; lineCount by counting line starts', lineCountMode: 'count', bubbles: false, spawn: null, conversation: false},
    {name: 'layout; lineCount by a one-hot masked read', lineCountMode: 'one-hot', bubbles: false, spawn: null, conversation: false},
    {name: 'layout; lineCount by the index read instruction', lineCountMode: 'index-read', runtime: instructionOnly, bubbles: false, spawn: null, conversation: false},
    {name: 'layout; one-hot variant, compiled by the index-read runtime with its defaults', lineCountMode: 'one-hot', runtime: indexReadDefaults, bubbles: false, spawn: null, conversation: false},
    {name: 'layout + bubble', lineCountMode: 'count', bubbles: true, spawn: null, conversation: false},
    {name: 'layout + bubble + springs (in place)', lineCountMode: 'count', bubbles: true, spawn: 'in-place', conversation: false},
    {name: 'layout + bubble + springs (in place), index-read runtime defaults', lineCountMode: 'count', runtime: indexReadDefaults, bubbles: true, spawn: 'in-place', conversation: false},
    {name: 'layout + bubble + springs (from previous)', lineCountMode: 'count', bubbles: true, spawn: 'from-previous', conversation: false},
    {name: 'conversation: layout + bubbles', lineCountMode: 'count', bubbles: true, spawn: null, conversation: true},
    {name: 'conversation: layout + bubbles + springs (in place)', lineCountMode: 'count', bubbles: true, spawn: 'in-place', conversation: true},
    {name: 'conversation: layout + bubbles + springs (in place), index-read runtime defaults', lineCountMode: 'count', runtime: indexReadDefaults, bubbles: true, spawn: 'in-place', conversation: true},
  ]
  for (const words of [48, 96]) {
    const baselines = new Map<string, string[]>()
    for (const variant of variants) {
      const {turns, build} = buildVariant(words, variant)
      const stream = streamStates(build, turns, 240)
      const kind = `${variant.conversation}:${variant.bubbles}`
      if (!baselines.has(kind)) baselines.set(kind, stream.signatures)
      const same = JSON.stringify(stream.signatures) === JSON.stringify(baselines.get(kind)) ? 'yes' : 'no'
      const table = midStreamTable(build, turns, 0.6, 240)
      const size = build.compiled.size
      const executorMicroseconds = medianMicroseconds(() => { build.compiled.evaluate(table) }, timingIterations(size.liveOperations))
      let generatedMicroseconds: number | string = '-'
      let generatedWarmSeconds = 0
      if (variant.runtime === undefined) {
        const generated = createGeneratedEvaluator(build)
        // Generated functions run once per evaluation, so JavaScriptCore optimizes them only after
        // thousands of evaluations. Warm in 1 s slices until the median improves by less than 5%, up to 12 s.
        const started = performance.now()
        let previous = Number.POSITIVE_INFINITY
        for (;;) {
          const sliceEnd = performance.now() + 1000
          while (performance.now() < sliceEnd) generated.evaluate(table)
          const median = medianMicroseconds(() => { generated.evaluate(table) }, timingIterations(size.liveOperations))
          generatedWarmSeconds = Math.round((performance.now() - started) / 1000)
          if (median > previous * 0.95 || performance.now() - started > 12000) {
            generatedMicroseconds = Math.min(median, previous)
            break
          }
          previous = median
        }
      }
      const row = {
        words, segments: build.options.capacity, turns: build.options.turnCapacity, variant: variant.name, ...size,
        buildMilliseconds: Math.round(build.buildMilliseconds), executorMicroseconds, generatedMicroseconds, generatedWarmSeconds,
        states: stream.states, mismatchedStates: stream.mismatchedStates, sameOutputs: same, window: build.options.window, lineSlots: build.options.lineSlots,
      }
      rows.push(row)
      printRow([words, build.options.capacity, build.options.turnCapacity, variant.name, size.liveOperations, size.layers, size.storedWeights, size.gatherReads, size.gatherTableEntries, size.indexReads, size.oneHotOperations, row.buildMilliseconds, executorMicroseconds, generatedMicroseconds === '-' ? '-' : `${generatedMicroseconds} (${generatedWarmSeconds} s)`, `${stream.mismatchedStates} / ${stream.states}`, same])
    }
  }
  results['sizes'] = rows
}

if (runPart('phases')) {
  console.log('\n## Live operations per phase (shared runtime)\n')
  const rows: unknown[] = []
  for (const words of [48, 96]) {
    for (const variant of [
      {name: 'reply: layout + bubble + springs (in place)', lineCountMode: 'count', bubbles: true, spawn: 'in-place', conversation: false},
      {name: 'conversation: layout + bubbles + springs (in place)', lineCountMode: 'count', bubbles: true, spawn: 'in-place', conversation: true},
    ] as Variant[]) {
      const {build} = buildVariant(words, variant)
      const phases = liveOperationsByPhase(build)
      console.log(`\n${words} words, ${build.options.capacity} segments, ${build.options.turnCapacity} turns, ${build.options.lineSlots} line slots, window ${build.options.window}: ${variant.name}\n`)
      printRow(['Phase', 'Live ops', 'Share'])
      printRow(['---', '---', '---'])
      for (const phase of phases) printRow([phase.name, phase.liveOperations, `${Math.round(100 * phase.liveOperations / build.compiled.size.liveOperations)}%`])
      rows.push({words, variant: variant.name, segments: build.options.capacity, turns: build.options.turnCapacity, lineSlots: build.options.lineSlots, window: build.options.window, phases})
    }
  }
  results['phases'] = rows
}

if (runPart('streams')) {
  console.log('\n## Exactness over streams, and line changes of visible words\n')
  printRow(['Stream', 'Words', 'Segments', 'Chunks', 'Width', 'States', 'Mismatched states', 'Line changes of visible segments', 'Of which the growing segment', 'Per 1,000 chunks', 'pretext prepare + walk µs per chunk'])
  printRow(Array(11).fill('---'))
  const rows: unknown[] = []
  for (const words of [48, 96]) {
    for (const kind of ['reply', 'conversation'] as const) {
      const shapeTurns = kind === 'reply' ? replyTurns(words, 3) : conversationTurns(words, 3)
      const build = buildForTurns(pretext, shapeTurns, {lineCountMode: 'count', turnCapacity: shapeTurns.length, bubbles: true, springs: null})
      for (const mode of [1, 3, 'word'] as ChunkMode[]) {
        const turns = shapeTurns.map(turn => ({...turn, mode}))
        for (const width of [160, 240, 320]) {
          const started = performance.now()
          const prefixLengths = turns.map(() => 0)
          const events = chunkEvents(turns)
          for (const event of events) {
            prefixLengths[event.turn] = event.end
            layoutFlow(pretext, testFont, turns, prefixLengths, width)
          }
          const layoutMicroseconds = Math.round((performance.now() - started) * 1000 / events.length)
          const stream = streamStates(build, turns, width)
          const perThousand = Number((stream.hops * 1000 / stream.states).toFixed(1))
          rows.push({kind, words, segments: build.options.capacity, mode, width, states: stream.states, mismatchedStates: stream.mismatchedStates, hops: stream.hops, growingSegmentHops: stream.growingSegmentHops, perThousand, layoutMicroseconds, firstProblem: stream.firstProblem})
          printRow([kind, words, build.options.capacity, String(mode), width, stream.states, stream.mismatchedStates, stream.hops, stream.growingSegmentHops, perThousand, layoutMicroseconds])
        }
      }
    }
  }
  results['streams'] = rows
}

type PlayResult = {
  stopWrites: number | null
  departing: number
  framesToSettleAfterStop: number
  framesToSettleAfterLastChunk: number
  perFrameDrift: {position: number, opacity: number}
  accumulatedDrift: {position: number, opacity: number}
  layoutMismatchedStates: number
  departingOpacityAtSettle: number
  arrivedMovedByStop: number
  arrivals: {distance: number, startsLine: boolean}[]
  frames: number
}

function play(build: StreamBuild, turns: readonly Turn[], spawn: SpawnMode, stopFraction: number | null, maxWidth: number): PlayResult {
  const chunks = timedChunks(turns, 0, 40, 200)
  const session = new StreamSession(build, pretext, testFont, turns, chunks, {startTime: 0, maxWidth, columnWidth: columnWidthFor(maxWidth)})
  if (stopFraction !== null) {
    const pressTime = chunks[Math.floor(chunks.length * stopFraction)]!.time + 13
    session.requestStop(pressTime, pressTime + 110)
  }
  const frameMilliseconds = 1000 / 60
  let synced: ReferenceWords = referenceWordsFromTable(build, session.table)
  let independent: ReferenceWords = referenceWordsFromTable(build, session.table)
  let previousArrived = 0
  const perFrameDrift = {position: 0, opacity: 0}
  const accumulatedDrift = {position: 0, opacity: 0}
  let layoutMismatchedStates = 0
  let stopFrame = -1
  let lastChunkFrame = -1
  let departing = 0
  let arrivedMovedByStop = 0
  const arrivals: PlayResult['arrivals'] = []
  let frame = 1
  for (; frame < 5000; frame++) {
    const now = frame * frameMilliseconds
    const arrivedBefore = session.table[build.cells.arrivedCount]!
    // The targets shown before the frame that handles the Stop.
    let targetsBefore: {x: Float32Array, y: Float32Array} | null = null
    if (session.pendingStop !== null && now >= session.pendingStop.releaseTime) {
      const before = build.outputs(build.compiled.evaluate(session.table))
      targetsBefore = {x: Float32Array.from(before.targetX), y: Float32Array.from(before.targetY)}
    }
    const result = session.frame(now)
    const {outputs} = result
    const arrived = session.table[build.cells.arrivedCount]!
    // The synced reference starts every frame from the circuit's own state: drift within one frame.
    const step = referenceWordsStep(synced, outputs, arrived, previousArrived, result.steps, defaultSpringConfig, spawn)
    const drift = wordDrift(outputs, step.next)
    perFrameDrift.position = Math.max(perFrameDrift.position, drift.position)
    perFrameDrift.opacity = Math.max(perFrameDrift.opacity, drift.opacity)
    // The independent reference never reads the circuit's state: drift accumulated over the session.
    independent = referenceWordsStep(independent, outputs, arrived, previousArrived, result.steps, defaultSpringConfig, spawn).next
    const independentDrift = wordDrift(outputs, independent)
    accumulatedDrift.position = Math.max(accumulatedDrift.position, independentDrift.position)
    accumulatedDrift.opacity = Math.max(accumulatedDrift.opacity, independentDrift.opacity)
    synced = referenceWordsFromTable(build, session.table)
    previousArrived = arrived
    for (let j = arrivedBefore; j < arrived; j++) {
      if (session.state.breakAfter[j] === 1) continue
      arrivals.push({distance: Math.hypot(outputs.springX[j]! - outputs.targetX[j]!, outputs.springY[j]! - outputs.targetY[j]!), startsLine: j > 0 && outputs.lineIndex[j]! > outputs.lineIndex[j - 1]!})
    }
    if (result.chunksApplied > 0 || result.stopApplied) {
      const expected = referenceLayout(session.state, {layout: defaultFlowLayout, columnWidth: columnWidthFor(maxWidth), turnCapacity: build.options.turnCapacity, rightAlignedTurns})
      if (layoutMismatches(build, session.table, session.state, expected).length > 0) layoutMismatchedStates++
    }
    if (result.chunksApplied > 0 && session.applied === chunks.length) lastChunkFrame = frame
    if (result.stopApplied) {
      stopFrame = frame
      departing = arrivedBefore - arrived
      for (let j = 0; j < arrived; j++) arrivedMovedByStop = Math.max(arrivedMovedByStop, Math.hypot(outputs.targetX[j]! - targetsBefore!.x[j]!, outputs.targetY[j]! - targetsBefore!.y[j]!))
    }
    if (session.done() && session.pendingStop === null && outputs.animating === 0) break
  }
  const outputs = build.outputs(build.compiled.evaluate(session.table))
  const arrived = session.table[build.cells.arrivedCount]!
  let departingOpacityAtSettle = 0
  for (let j = arrived; j < build.options.capacity; j++) departingOpacityAtSettle = Math.max(departingOpacityAtSettle, Math.abs(outputs.opacity[j]!))
  return {
    stopWrites: session.stopWriteCount,
    departing,
    framesToSettleAfterStop: stopFrame < 0 ? -1 : frame - stopFrame,
    framesToSettleAfterLastChunk: lastChunkFrame < 0 ? -1 : frame - lastChunkFrame,
    perFrameDrift,
    accumulatedDrift,
    layoutMismatchedStates,
    departingOpacityAtSettle,
    arrivedMovedByStop,
    arrivals,
    frames: frame,
  }
}

// A Stop at every press time: 13 ms after every chunk but the last (after the last chunk the reply is
// done, so there is nothing left to stop), handled 110 ms later. One session plays the stream without
// a Stop. At the frame that handles each Stop, a fork of that session applies the Stop and plays until
// every spring has settled. The growing word is the last segment that had arrived at the press: the
// only arrived segment whose width a Stop can write back.
type SweptStop = {
  chunk: number
  stopWrites: number
  fading: number
  growingWordMove: number
  earlierWordsMove: number
  fadingTargetsMove: number
  fadingLineChange: boolean
  framesToSettle: number
  fadingOpacityAtSettle: number
  springsOffTargetAtSettle: number
  mismatched: boolean
  shownText: string
  pressText: string
}

function sweepStops(build: StreamBuild, turns: readonly Turn[], maxWidth: number): SweptStop[] {
  const frameMilliseconds = 1000 / 60
  const chunks = timedChunks(turns, 0, 40, 200)
  const referenceOptions = {layout: defaultFlowLayout, columnWidth: columnWidthFor(maxWidth), turnCapacity: build.options.turnCapacity, rightAlignedTurns}
  const base = new StreamSession(build, pretext, testFont, turns, chunks, {startTime: 0, maxWidth, columnWidth: columnWidthFor(maxWidth)})
  const pressTimes = chunks.slice(0, -1).map(chunk => chunk.time + 13)
  const stops: SweptStop[] = []
  let next = 0
  for (let frame = 1; next < pressTimes.length; frame++) {
    const now = frame * frameMilliseconds
    for (; next < pressTimes.length && now >= pressTimes[next]! + 110; next++) {
      const session = base.fork()
      session.requestStop(pressTimes[next]!, pressTimes[next]! + 110)
      const before = build.outputs(build.compiled.evaluate(session.table))
      const targetXBefore = Float32Array.from(before.targetX)
      const targetYBefore = Float32Array.from(before.targetY)
      const shownState = session.state
      const shown = session.table[build.cells.arrivedCount]!
      const stop = session.frame(now)
      if (!stop.stopApplied) throw new Error('the fork should handle its Stop in this frame')
      const arrived = session.table[build.cells.arrivedCount]!
      const growing = arrived - 1
      const move = (j: number) => Math.hypot(stop.outputs.targetX[j]! - targetXBefore[j]!, stop.outputs.targetY[j]! - targetYBefore[j]!)
      let earlierWordsMove = 0
      for (let j = 0; j < growing; j++) earlierWordsMove = Math.max(earlierWordsMove, move(j))
      const growingWordMove = move(growing)
      let fadingTargetsMove = 0
      let fadingLineChange = false
      for (let j = arrived; j < shown; j++) {
        fadingTargetsMove = Math.max(fadingTargetsMove, move(j))
        if (stop.outputs.targetY[j] !== targetYBefore[j]) fadingLineChange = true
      }
      const animatingAtStop = stop.outputs.animating
      const mismatched = layoutMismatches(build, session.table, session.state, referenceLayout(session.state, referenceOptions)).length > 0
      let outputs = stop.outputs
      let framesToSettle = 0
      if (animatingAtStop !== 0) {
        do {
          framesToSettle++
          if (framesToSettle > 5000) throw new Error('a Stop never settled')
          outputs = session.frame((frame + framesToSettle) * frameMilliseconds).outputs
        } while (outputs.animating !== 0)
      } else {
        outputs = build.outputs(build.compiled.evaluate(session.table))
      }
      let fadingOpacityAtSettle = 0
      let springsOffTargetAtSettle = 0
      for (let j = 0; j < build.options.capacity; j++) {
        if (j >= arrived) fadingOpacityAtSettle = Math.max(fadingOpacityAtSettle, Math.abs(outputs.opacity[j]!))
        if (outputs.springX[j] !== outputs.targetX[j] || outputs.springY[j] !== outputs.targetY[j] || outputs.opacity[j] !== (j < arrived ? 1 : 0)) springsOffTargetAtSettle++
      }
      stops.push({
        chunk: next, stopWrites: session.stopWriteCount!, fading: shown - arrived, growingWordMove, earlierWordsMove, fadingTargetsMove, fadingLineChange,
        framesToSettle, fadingOpacityAtSettle, springsOffTargetAtSettle, mismatched, shownText: shownState.texts[growing] ?? '', pressText: session.state.texts[growing]!,
      })
    }
    base.frame(now)
  }
  return stops
}

if (runPart('interrupt')) {
  console.log('\n## Interruptions at 60 fps, a chunk every 40 ms, Stop handled 110 ms after the press\n')
  printRow(['Words', 'Chunks', 'Stop at', 'Cells written by Stop', 'Segments fading out', 'Arrived targets moved by Stop, x and y (px)', 'Frames to settle after Stop', 'Opacity of faded segments at settle', 'Per-frame drift (px)', 'Accumulated drift (px)', 'Accumulated opacity drift', 'Mismatched states'])
  printRow(Array(12).fill('---'))
  const rows: unknown[] = []
  const builds = new Map<number, StreamBuild>()
  for (const words of [48, 96]) {
    const build = buildForTurns(pretext, replyTurns(words, 3), {lineCountMode: 'count', turnCapacity: 1, bubbles: true, springs: {config: defaultSpringConfig, spawn: 'in-place'}})
    builds.set(words, build)
    for (const mode of [1, 3, 'word'] as ChunkMode[]) {
      const turns = replyTurns(words, mode)
      for (const stopFraction of [null, 0.25, 0.5, 0.75]) {
        const played = play(build, turns, 'in-place', stopFraction, 240)
        const stopLabel = stopFraction === null ? 'no Stop' : `${stopFraction * 100}% of chunks`
        const settle = stopFraction === null ? `(after last chunk) ${played.framesToSettleAfterLastChunk}` : played.framesToSettleAfterStop
        rows.push({words, mode, stopFraction, ...played, arrivals: undefined})
        printRow([words, String(mode), stopLabel, played.stopWrites ?? '-', played.departing, played.arrivedMovedByStop, settle, played.departingOpacityAtSettle, played.perFrameDrift.position.toExponential(2), played.accumulatedDrift.position.toExponential(2), played.accumulatedDrift.opacity.toExponential(2), played.layoutMismatchedStates])
      }
    }
  }
  results['interrupt'] = rows

  console.log('\n## A Stop at every press time: 13 ms after every chunk but the last, handled 110 ms later\n')
  printRow(['Words', 'Chunks', 'Width', 'Press times', 'Stops writing 1 / 2 / other cells', 'Stops writing 1 cell that moved a target', 'Stops that moved the growing word', 'Growing word moved (max px)', 'Words before the growing word moved (max px)', 'Stops that moved fading segments', 'Of which a fading segment changed line', 'Fading segments moved (max px)', 'Frames to settle after Stop (max)', 'Frames to settle when no target moved (max)', 'Springs off their targets at settle', 'Opacity of faded segments at settle (max)', 'Mismatched states', 'First move: chunk, text shown, text at the press, px'])
  printRow(Array(18).fill('---'))
  const sweepRows: unknown[] = []
  const maximum = (values: readonly number[]) => values.reduce((largest, value) => Math.max(largest, value), 0)
  for (const words of [48, 96]) {
    const build = builds.get(words)!
    for (const mode of [1, 3, 'word'] as ChunkMode[]) {
      const turns = replyTurns(words, mode)
      for (const width of [160, 240, 320]) {
        const stops = sweepStops(build, turns, width)
        const movedGrowingWord = stops.filter(stop => stop.growingWordMove > 0)
        const noTargetMoved = stops.filter(stop => stop.growingWordMove === 0 && stop.fadingTargetsMove === 0)
        const firstMove = movedGrowingWord[0]
        const row = {
          words, mode, width,
          pressTimes: stops.length,
          oneCellStops: stops.filter(stop => stop.stopWrites === 1).length,
          twoCellStops: stops.filter(stop => stop.stopWrites === 2).length,
          otherStops: stops.filter(stop => stop.stopWrites !== 1 && stop.stopWrites !== 2).length,
          oneCellStopsMovingATarget: stops.filter(stop => stop.stopWrites === 1 && (stop.growingWordMove > 0 || stop.earlierWordsMove > 0 || stop.fadingTargetsMove > 0)).length,
          stopsMovingGrowingWord: movedGrowingWord.length,
          growingWordMaximumMove: maximum(stops.map(stop => stop.growingWordMove)),
          earlierWordsMaximumMove: maximum(stops.map(stop => stop.earlierWordsMove)),
          stopsMovingFadingSegments: stops.filter(stop => stop.fadingTargetsMove > 0).length,
          stopsMovingFadingSegmentsToAnotherLine: stops.filter(stop => stop.fadingLineChange).length,
          fadingSegmentsMaximumMove: maximum(stops.map(stop => stop.fadingTargetsMove)),
          maximumFramesToSettle: maximum(stops.map(stop => stop.framesToSettle)),
          maximumFramesToSettleWhenNoTargetMoved: maximum(noTargetMoved.map(stop => stop.framesToSettle)),
          springsOffTargetAtSettle: stops.reduce((total, stop) => total + stop.springsOffTargetAtSettle, 0),
          fadingOpacityAtSettle: maximum(stops.map(stop => stop.fadingOpacityAtSettle)),
          mismatchedStates: stops.filter(stop => stop.mismatched).length,
          firstMove: firstMove === undefined ? null : {chunk: firstMove.chunk, shownText: firstMove.shownText, pressText: firstMove.pressText, move: firstMove.growingWordMove},
        }
        sweepRows.push(row)
        printRow([
          words, String(mode), width, row.pressTimes, `${row.oneCellStops} / ${row.twoCellStops} / ${row.otherStops}`, row.oneCellStopsMovingATarget,
          row.stopsMovingGrowingWord, row.growingWordMaximumMove.toFixed(2), row.earlierWordsMaximumMove, row.stopsMovingFadingSegments, row.stopsMovingFadingSegmentsToAnotherLine, row.fadingSegmentsMaximumMove.toFixed(2),
          row.maximumFramesToSettle, row.maximumFramesToSettleWhenNoTargetMoved, row.springsOffTargetAtSettle, row.fadingOpacityAtSettle, row.mismatchedStates,
          firstMove === undefined ? '-' : `${firstMove.chunk}, "${firstMove.shownText}", "${firstMove.pressText}", ${firstMove.growingWordMove.toFixed(2)}`,
        ])
      }
    }
  }
  results['stopSweep'] = sweepRows
}

if (runPart('spawn')) {
  console.log('\n## Where an arriving word starts (whole-word chunks, 240 px)\n')
  printRow(['Words', 'Spawn', 'Arriving words', 'Words that start a line', 'Distance to target on arrival, words on the same line (mean / max px)', 'Distance to target on arrival, words that start a line (mean / max px)', 'Frames to settle after the last chunk'])
  printRow(Array(7).fill('---'))
  const rows: unknown[] = []
  for (const words of [48, 96]) {
    for (const spawn of ['in-place', 'from-previous'] as SpawnMode[]) {
      const turns = replyTurns(words, 'word')
      const build = buildForTurns(pretext, turns, {lineCountMode: 'count', turnCapacity: 1, bubbles: true, springs: {config: defaultSpringConfig, spawn}})
      const played = play(build, turns, spawn, null, 240)
      const summarize = (distances: number[]) => distances.length === 0 ? '-' : `${(distances.reduce((total, value) => total + value, 0) / distances.length).toFixed(1)} / ${Math.max(...distances).toFixed(1)}`
      const sameLine = played.arrivals.filter(arrival => !arrival.startsLine).map(arrival => arrival.distance)
      const lineStarts = played.arrivals.filter(arrival => arrival.startsLine).map(arrival => arrival.distance)
      rows.push({words, spawn, arrivals: played.arrivals.length, lineStarts: lineStarts.length, sameLine: summarize(sameLine), lineStartDistances: summarize(lineStarts), framesToSettleAfterLastChunk: played.framesToSettleAfterLastChunk, drift: played.accumulatedDrift})
      printRow([words, spawn, played.arrivals.length, lineStarts.length, summarize(sameLine), summarize(lineStarts), played.framesToSettleAfterLastChunk])
    }
  }
  results['spawn'] = rows
}

writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`)

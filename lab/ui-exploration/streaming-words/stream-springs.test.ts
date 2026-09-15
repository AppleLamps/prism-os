import {expect, test} from 'bun:test'
import {defaultFlowLayout, type SpawnMode, type StreamBuild} from './stream-circuit.ts'
import {loadPretext} from './fake-canvas.ts'
import {createGeneratedEvaluator} from './generated.ts'
import {buildForTurns, conversationTurns, replyTurns, rightAlignedTurns, testFont} from './samples.ts'
import {StreamSession, timedChunks} from './session.ts'
import {referenceWordsFromTable, referenceWordsStep, wordDrift} from './spring-reference.ts'
import {layoutFlow, layoutMismatches, referenceLayout, type ChunkMode, type Turn} from './stream-model.ts'
import {defaultSpringConfig} from './word-springs.ts'

const pretext = await loadPretext()
const maxWidth = 240
const columnWidth = 320
const frameMilliseconds = 1000 / 60

const builds = new Map<string, StreamBuild>()
function buildWithSprings(turns: readonly Turn[], turnCapacity: number, spawn: SpawnMode): StreamBuild {
  const key = `${turns.map(turn => turn.text).join('|')}:${turnCapacity}:${spawn}`
  let build = builds.get(key)
  if (build === undefined) {
    build = buildForTurns(pretext, turns, {lineCountMode: 'count', turnCapacity, bubbles: true, springs: {config: defaultSpringConfig, spawn}})
    builds.set(key, build)
  }
  return build
}

// Plays a stream at 60 fps with an optional Stop, checks layout at every applied state and the springs
// against float64 iteration, and runs until every spring has settled.
function play(turns: readonly Turn[], turnCapacity: number, spawn: SpawnMode, stop: {pressTime: number, releaseTime: number} | null) {
  const build = buildWithSprings(turns, turnCapacity, spawn)
  const chunks = timedChunks(turns, 0, 40, 200)
  const session = new StreamSession(build, pretext, testFont, turns, chunks, {startTime: 0, maxWidth, columnWidth})
  if (stop !== null) session.requestStop(stop.pressTime, stop.releaseTime)
  let words = referenceWordsFromTable(build, session.table)
  let previousArrived = 0
  const layoutFailures: unknown[] = []
  let worstPosition = 0
  let worstOpacity = 0
  let stopFrame = -1
  let departing = 0
  const arrivals: {segment: number, frame: number, distance: number, startsLine: boolean}[] = []
  // The targets shown before the frame that handles the Stop, and the targets that frame computes.
  let targetsBeforeStop: {x: Float32Array, y: Float32Array} | null = null
  let stopTargets: {before: {x: Float32Array, y: Float32Array}, after: {x: Float32Array, y: Float32Array}} | null = null
  let frame = 1
  for (; frame < 3000; frame++) {
    const now = frame * frameMilliseconds
    const arrivedBefore = session.table[build.cells.arrivedCount]!
    if (session.pendingStop !== null && now >= session.pendingStop.releaseTime) {
      const before = build.outputs(build.compiled.evaluate(session.table))
      targetsBeforeStop = {x: Float32Array.from(before.targetX), y: Float32Array.from(before.targetY)}
    }
    const result = session.frame(now)
    if (result.stopApplied) stopTargets = {before: targetsBeforeStop!, after: {x: Float32Array.from(result.outputs.targetX), y: Float32Array.from(result.outputs.targetY)}}
    const arrived = session.table[build.cells.arrivedCount]!
    const step = referenceWordsStep(words, result.outputs, arrived, previousArrived, result.steps, defaultSpringConfig, spawn)
    const drift = wordDrift(result.outputs, step.next)
    worstPosition = Math.max(worstPosition, drift.position)
    worstOpacity = Math.max(worstOpacity, drift.opacity)
    words = referenceWordsFromTable(build, session.table)
    previousArrived = arrived
    for (let j = arrivedBefore; j < arrived; j++) {
      if (session.state.breakAfter[j] === 1) continue
      const distance = Math.hypot(result.outputs.springX[j]! - result.outputs.targetX[j]!, result.outputs.springY[j]! - result.outputs.targetY[j]!)
      arrivals.push({segment: j, frame, distance, startsLine: j > 0 && result.outputs.lineIndex[j]! > result.outputs.lineIndex[j - 1]!})
    }
    if (result.chunksApplied > 0 || result.stopApplied) {
      const expected = referenceLayout(session.state, {layout: defaultFlowLayout, columnWidth, turnCapacity, rightAlignedTurns})
      const problems = layoutMismatches(build, session.table, session.state, expected)
      if (problems.length > 0) layoutFailures.push({frame, problems: problems.slice(0, 3)})
    }
    if (result.stopApplied) {
      stopFrame = frame
      departing = arrivedBefore - arrived
    }
    if (session.done() && session.pendingStop === null && result.outputs.animating === 0) break
  }
  const outputs = build.outputs(build.compiled.evaluate(session.table))
  return {build, session, outputs, layoutFailures, worstPosition, worstOpacity, stopFrame, settledFrame: frame, departing, arrivals, stopTargets}
}

test('Stop between words writes one cell, and the words shown after the press fade out in place', () => {
  const turns = replyTurns(48, 'word')
  const chunks = timedChunks(turns, 0, 40, 200)
  // Pressed 10 ms after chunk 30 arrived and handled 110 ms later. By then 3 more words, each a space
  // segment plus a word segment, have arrived. The first 2 were shown in earlier frames and fade out;
  // the third arrived in the frame that handles the Stop, so it's never shown.
  const pressTime = chunks[30]!.time + 10
  const releaseTime = pressTime + 110
  const played = play(turns, 1, 'in-place', {pressTime, releaseTime})
  expect(played.layoutFailures).toEqual([])
  expect(played.session.stopWriteCount).toBe(1)
  expect(played.session.stateAt(releaseTime).arrivedCount - played.session.stateAt(pressTime).arrivedCount).toBe(6)
  expect(played.departing).toBe(4)
  // Every spring settled exactly: arrived words on their targets and opaque, departing words gone.
  const {outputs, build} = played
  const arrived = played.session.table[build.cells.arrivedCount]!
  expect(arrived).toBe(played.session.stateAt(pressTime).arrivedCount)
  for (let j = 0; j < build.options.capacity; j++) {
    expect([outputs.springX[j], outputs.springY[j], outputs.opacity[j]]).toEqual([outputs.targetX[j]!, outputs.targetY[j]!, j < arrived ? 1 : 0])
  }
  expect(outputs.animating).toBe(0)
  expect(played.worstPosition).toBeLessThan(1e-3)
  expect(played.worstOpacity).toBeLessThan(1e-6)
  expect(played.settledFrame - played.stopFrame).toBeLessThan(90)
})

test('Stop inside a word also writes that word back to its width at the press', () => {
  const turns = replyTurns(48, 1 as ChunkMode)
  const chunks = timedChunks(turns, 0, 40, 200)
  // Pressed right after the first character of a word of at least 6 characters. The characters that
  // arrive before the release extend the same word.
  const text = turns[0]!.text
  const words = text.split(' ')
  const wordIndex = words.findIndex((word, index) => index >= 15 && word.length >= 6)
  const wordStart = words.slice(0, wordIndex).join(' ').length + 1
  expect(words[wordIndex]!.length).toBeGreaterThanOrEqual(6)
  const pressTime = chunks[wordStart]!.time + 10
  const played = play(turns, 1, 'in-place', {pressTime, releaseTime: pressTime + 110})
  expect(played.layoutFailures).toEqual([])
  expect(played.session.stopWriteCount).toBe(2)
  expect(played.departing).toBe(0)
})

test('Stop inside a word that wrapped between the press and the click sends that word back to the previous line', () => {
  const turns = replyTurns(48, 1 as ChunkMode)
  const chunks = timedChunks(turns, 0, 40, 200)
  const referenceOptions = {layout: defaultFlowLayout, columnWidth, turnCapacity: 1, rightAlignedTurns}
  const layoutAt = (time: number) => {
    let end = 0
    for (const chunk of chunks) {
      if (chunk.time > time) break
      end = chunk.end
    }
    const state = layoutFlow(pretext, testFont, turns, [end], maxWidth)
    return {state, reference: referenceLayout(state, referenceOptions)}
  }
  // The first press whose growing word moved to the next line in a frame before the one that handles
  // the Stop. That frame is the first frame at or after the click.
  const pressTime = chunks.map(chunk => chunk.time + 13).find(time => {
    const atPress = layoutAt(time)
    const shown = layoutAt((Math.ceil((time + 110) / frameMilliseconds) - 1) * frameMilliseconds)
    const growing = atPress.state.arrivedCount - 1
    return shown.reference.lineIndex[growing]! > atPress.reference.lineIndex[growing]!
  })
  expect(pressTime).toBeDefined()
  const played = play(turns, 1, 'in-place', {pressTime: pressTime!, releaseTime: pressTime! + 110})
  expect(played.layoutFailures).toEqual([])
  expect(played.session.stopWriteCount).toBe(2)
  const {build, outputs} = played
  const arrived = played.session.table[build.cells.arrivedCount]!
  const growing = arrived - 1
  const {before, after} = played.stopTargets!
  // The growing word goes back to the end of the previous line.
  expect(before.y[growing]! - after.y[growing]!).toBe(defaultFlowLayout.lineHeight)
  expect(after.x[growing]! - before.x[growing]!).toBeGreaterThan(100)
  // Every word before it keeps its target.
  for (let j = 0; j < growing; j++) expect([after.x[j], after.y[j]]).toEqual([before.x[j]!, before.y[j]!])
  // Every spring still settles exactly on its target.
  for (let j = 0; j < build.options.capacity; j++) {
    expect([outputs.springX[j], outputs.springY[j], outputs.opacity[j]]).toEqual([outputs.targetX[j]!, outputs.targetY[j]!, j < arrived ? 1 : 0])
  }
})

test('an arriving word fades in at its place, or slides out of the previous word', () => {
  const turns = replyTurns(48, 'word')
  const inPlace = play(turns, 1, 'in-place', null)
  const fromPrevious = play(turns, 1, 'from-previous', null)
  expect(inPlace.layoutFailures).toEqual([])
  expect(fromPrevious.layoutFailures).toEqual([])
  expect(inPlace.arrivals.length).toBe(48)
  expect(fromPrevious.arrivals.length).toBe(48)
  // In place: on the frame a word arrives, its spring already sits on its target.
  expect(inPlace.arrivals.every(arrival => arrival.distance === 0)).toBe(true)
  // From the previous word: words that start a line travel from the end of the previous line.
  const lineStarts = fromPrevious.arrivals.filter(arrival => arrival.startsLine)
  expect(lineStarts.length).toBeGreaterThan(5)
  expect(lineStarts.every(arrival => arrival.distance > 100)).toBe(true)
  expect(fromPrevious.arrivals.filter(arrival => !arrival.startsLine && arrival.segment > 0).every(arrival => arrival.distance > 0 && arrival.distance < 10)).toBe(true)
  expect(fromPrevious.worstPosition).toBeLessThan(1e-3)
})

test('a streamed conversation settles every word and bubble, and generated JS matches the executor bit for bit', () => {
  const turns = conversationTurns(48, 3)
  const played = play(turns, 4, 'in-place', null)
  expect(played.layoutFailures).toEqual([])
  const {build, session, outputs} = played
  expect(Array.from(outputs.bubbleWidth)).toEqual(Array.from(outputs.turnWidth))
  expect(Array.from(outputs.bubbleTop)).toEqual(Array.from(outputs.turnTop))
  expect(Array.from(outputs.bubbleOpacity)).toEqual([1, 1, 1, 1])
  const generated = createGeneratedEvaluator(build)
  // Compare on a state with springs in motion: a narrower width reflows every turn.
  session.setWidths(200, 300)
  session.table[build.cells.stepCount!] = 4
  const executor = Float32Array.from(build.compiled.evaluate(session.table))
  const fromGenerated = generated.evaluate(session.table)
  let differing = 0
  for (let index = 0; index < executor.length; index++) if (!Object.is(executor[index], fromGenerated[index])) differing++
  expect(executor.length).toBeGreaterThan(900)
  expect(differing).toBe(0)
  expect(build.outputs(executor).animating).toBeGreaterThan(0)
})

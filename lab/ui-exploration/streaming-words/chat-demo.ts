// The demo's logic, without the DOM: a scripted conversation where the user's messages arrive whole
// and the replies stream in chunks, a Stop button handled at its press's timestamp, a width slider,
// and a check of every state against pretext. demo.ts only measures nothing, reads inputs, and
// projects this module's outputs onto the page; chat-demo.test.ts runs it headlessly.
import {buildStreamCircuit, type FlowLayout, type SpawnMode, type StreamBuild, type StreamOutputs} from './stream-circuit.ts'
import {StreamSession, timedChunks} from './session.ts'
import {layoutMismatches, lineCountOf, lineHops, referenceLayout, segmentCountOf, windowForTurns, type ChunkMode, type ReferenceLayout, type Turn} from './stream-model.ts'
import {defaultSpringConfig} from './word-springs.ts'

type Pretext = typeof import('./pretext-src/layout.ts')

// No hyphens or apostrophes, so every prefix stays on pretext's fast path and segments the same way
// as the whole text.
export const demoScript: readonly {speaker: 'user' | 'assistant', text: string}[] = [
  {speaker: 'user', text: 'What would a chat reply look like if every word were its own unit?'},
  {speaker: 'assistant', text: 'Every word arrives on its own, finds its line with the same arithmetic as every other word, and follows its own spring. Nobody builds the bubble around this reply. It is the widest line among my words, and a count of the lines they start.'},
  {speaker: 'user', text: 'And if I stop it halfway?'},
  {speaker: 'assistant', text: 'The count goes back to what had arrived when you pressed, and later words fade out. Greedy line breaking never looks ahead, so every word before the one still arriving stays where it is.'},
]

export const demoLayout: FlowLayout = {top: 12, left: 12, lineHeight: 24, paddingX: 12, paddingY: 8, gap: 12}
export const minimumWidth = 240
export const maximumWidth = 480
// Real canvas widths aren't multiples of 1/4 px, so FP32 sums and pretext's float64 sums can differ
// in their last bits. x, targets and bubble widths may differ by this much; line indices, line counts
// and bubble presence must be equal.
export const demoTolerance = 0.01

export const columnWidthFor = (maxWidth: number) => Math.round(maxWidth * 1.25) + 2 * demoLayout.paddingX + 2 * demoLayout.left
// User messages sit on the right.
export const rightAlignedTurns = (turn: number) => demoScript[turn]?.speaker === 'user'

export type DemoProjection = {
  words: {text: string, x: number, y: number, opacity: number}[]
  bubbles: {left: number, top: number, width: number, height: number, opacity: number, speaker: 'user' | 'assistant'}[]
  contentHeight: number
}

export type DemoStats = {
  segments: number
  arrived: number
  liveOperations: number
  layers: number
  storedWeights: number
  buildMilliseconds: number
  medianEvaluationMicroseconds: number
  checkedStates: number
  mismatchedStates: number
  lineChanges: number
  lastStopWrites: number | null
  lastStopFading: number
}

export class ChatDemo {
  readonly pretext: Pretext
  readonly font: string
  readonly builds = new Map<SpawnMode, StreamBuild>()
  chunkMode: ChunkMode = 3
  chunkMilliseconds = 45
  spawn: SpawnMode = 'in-place'
  maxWidth = 360
  session: StreamSession
  texts: string[] = []
  checkedStates = 0
  mismatchedStates = 0
  lineChanges = 0
  lastStopWrites: number | null = null
  lastStopFading = 0
  pressTime: number | null = null
  recentMicroseconds: number[] = []
  firstMismatch: string | null = null
  previousReference: ReferenceLayout | null = null

  constructor(pretext: Pretext, font: string, now: number) {
    this.pretext = pretext
    this.font = font
    for (const {text} of demoScript) {
      if (text.includes('-')) throw new Error('demo texts must not contain hyphens')
    }
    this.session = this.createSession(now)
  }

  turns(): Turn[] {
    return demoScript.map(({speaker, text}) => ({text, mode: speaker === 'user' ? 'whole' : this.chunkMode}))
  }

  build(): StreamBuild {
    let build = this.builds.get(this.spawn)
    if (build === undefined) {
      const texts = demoScript.map(turn => turn.text)
      build = buildStreamCircuit({
        capacity: segmentCountOf(this.pretext, this.font, texts),
        window: windowForTurns(this.pretext, this.font, texts, maximumWidth, 0.005),
        lineSlots: lineCountOf(this.pretext, this.font, texts, minimumWidth) + 1,
        epsilon: 0.005,
        lineCountMode: 'count',
        turnCapacity: demoScript.length,
        rightAlignedTurns,
        layout: demoLayout,
        bubbles: true,
        springs: {config: defaultSpringConfig, spawn: this.spawn},
      })
      this.builds.set(this.spawn, build)
    }
    return build
  }

  createSession(now: number): StreamSession {
    const turns = this.turns()
    const build = this.build()
    this.texts = Array.from({length: build.options.capacity}, () => '')
    this.previousReference = null
    this.lastStopWrites = null
    this.lastStopFading = 0
    this.pressTime = null
    // The first user message is already there on first paint; the reply starts streaming 400 ms later.
    return new StreamSession(build, this.pretext, this.font, turns, timedChunks(turns, now - 400, this.chunkMilliseconds, 400), {startTime: now, maxWidth: this.maxWidth, columnWidth: columnWidthFor(this.maxWidth)})
  }

  restart(now: number): void {
    this.session = this.createSession(now)
  }

  setChunkMode(mode: ChunkMode, now: number): void {
    this.chunkMode = mode
    this.restart(now)
  }

  setSpawn(spawn: SpawnMode, now: number): void {
    this.spawn = spawn
    this.restart(now)
  }

  setWidth(maxWidth: number): void {
    this.maxWidth = maxWidth
    this.session.setWidths(maxWidth, columnWidthFor(maxWidth))
    // Line changes caused by the width aren't counted as line changes from arriving chunks.
    this.previousReference = this.check()
  }

  pressStop(time: number): void {
    if (!this.session.done()) this.pressTime = time
  }

  // A click without a pointer press, e.g. from the keyboard, stops at the click itself.
  releaseStop(time: number): void {
    if (this.session.done()) return
    this.session.requestStop(this.pressTime ?? time, time)
    this.pressTime = null
  }

  // Whether the page should render another frame.
  animating(): boolean {
    return !this.session.done() || this.session.pendingStop !== null || this.pressTime !== null || this.lastAnimating
  }

  lastAnimating = true

  frame(now: number): StreamOutputs {
    const session = this.session
    const arrivedBefore = session.table[session.build.cells.arrivedCount]!
    const result = session.frame(now)
    this.recentMicroseconds.push(session.lastEvaluationMicroseconds)
    if (this.recentMicroseconds.length > 120) this.recentMicroseconds.shift()
    const state = session.state
    if (result.chunksApplied > 0) {
      for (let j = 0; j < state.arrivedCount; j++) this.texts[j] = state.texts[j]!
    }
    if (result.stopApplied) {
      // The growing word goes back to its text at the press; later segments keep theirs while they fade.
      for (let j = 0; j < state.arrivedCount; j++) this.texts[j] = state.texts[j]!
      this.lastStopWrites = session.stopWriteCount
      this.lastStopFading = Math.max(0, arrivedBefore - state.arrivedCount)
    }
    if (result.chunksApplied > 0 || result.stopApplied) {
      const reference = this.check()
      if (result.chunksApplied > 0) this.lineChanges += lineHops(this.previousReference, reference).hops
      this.previousReference = reference
    }
    this.lastAnimating = result.outputs.animating !== 0
    return result.outputs
  }

  check(): ReferenceLayout {
    const session = this.session
    const reference = referenceLayout(session.state, {layout: demoLayout, columnWidth: columnWidthFor(this.maxWidth), turnCapacity: demoScript.length, rightAlignedTurns})
    const problems = layoutMismatches(session.build, session.table, session.state, reference, demoTolerance)
    this.checkedStates++
    if (problems.length > 0) {
      this.mismatchedStates++
      this.firstMismatch ??= problems[0]!
    }
    return reference
  }

  projection(outputs: StreamOutputs): DemoProjection {
    const build = this.session.build
    const words = this.texts.map((text, j) => ({text, x: outputs.springX[j]!, y: outputs.springY[j]!, opacity: Math.max(0, Math.min(1, outputs.opacity[j]!))}))
    const bubbles = demoScript.map((turn, index) => ({
      left: outputs.bubbleLeft[index]!,
      top: outputs.bubbleTop[index]!,
      width: outputs.bubbleWidth[index]! + 2 * demoLayout.paddingX,
      height: outputs.bubbleHeight[index]!,
      opacity: Math.max(0, Math.min(1, outputs.bubbleOpacity[index]!)),
      speaker: turn.speaker,
    }))
    let contentHeight = demoLayout.top
    for (let turn = 0; turn < build.options.turnCapacity; turn++) contentHeight = Math.max(contentHeight, outputs.bubbleTop[turn]! + outputs.bubbleHeight[turn]!)
    return {words, bubbles, contentHeight: contentHeight + demoLayout.top}
  }

  stats(): DemoStats {
    const build = this.session.build
    const sorted = [...this.recentMicroseconds].sort((left, right) => left - right)
    return {
      segments: build.options.capacity,
      arrived: this.session.table[build.cells.arrivedCount]!,
      liveOperations: build.compiled.size.liveOperations,
      layers: build.compiled.size.layers,
      storedWeights: build.compiled.size.storedWeights,
      buildMilliseconds: build.buildMilliseconds,
      medianEvaluationMicroseconds: sorted[sorted.length >> 1] ?? 0,
      checkedStates: this.checkedStates,
      mismatchedStates: this.mismatchedStates,
      lineChanges: this.lineChanges,
      lastStopWrites: this.lastStopWrites,
      lastStopFading: this.lastStopFading,
    }
  }
}

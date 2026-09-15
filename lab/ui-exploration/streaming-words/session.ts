// A streamed conversation over time: chunks arrive at timestamps, frames evaluate the circuit with
// fixed 4 ms spring steps, and Stop applies at the press's timestamp.
//
// Stop is pressed at `pressTime` and handled when the button's click arrives at `releaseTime`, later.
// Chunks that arrived in between were already written and shown. At the release, the table goes
// back to the state at the press: arrivedCount, plus the growing word's width when the press fell
// inside a word. Those later segments keep their places and fade out.
import {settleAtTargets, writeBack, type StreamBuild, type StreamOutputs} from './stream-circuit.ts'
import {applyWrites, chunkEvents, flowStateWrites, layoutFlow, stopWrites, type CellWrite, type ChunkEvent, type FlowState, type Turn} from './stream-model.ts'

type Pretext = typeof import('../text-walker/pretext-src/layout.ts')

export const stepMilliseconds = 4

export type TimedChunk = ChunkEvent & {time: number}

// Chunk k of a turn arrives chunkMilliseconds after the previous chunk; a new turn waits
// turnPauseMilliseconds first.
export function timedChunks(turns: readonly Turn[], startTime: number, chunkMilliseconds: number, turnPauseMilliseconds: number): TimedChunk[] {
  let time = startTime
  let previousTurn = -1
  return chunkEvents(turns).map(event => {
    time += event.turn === previousTurn ? chunkMilliseconds : turnPauseMilliseconds
    previousTurn = event.turn
    return {...event, time}
  })
}

export type FrameResult = {
  outputs: StreamOutputs
  steps: number
  chunksApplied: number
  // Cell writes this frame made before evaluating: chunk writes, or the Stop's writes.
  writes: CellWrite[]
  stopApplied: boolean
}

export class StreamSession {
  readonly build: StreamBuild
  readonly table: Float32Array
  readonly pretext: Pretext
  readonly font: string
  readonly turns: readonly Turn[]
  readonly chunks: readonly TimedChunk[]
  maxWidth: number
  applied = 0
  stopped = false
  state: FlowState
  animatedUntil: number
  pendingStop: {pressTime: number, releaseTime: number} | null = null
  stopWriteCount: number | null = null
  // The state before the frame that applied the last chunk, for counting line changes.
  previousState: FlowState | null = null
  lastEvaluationMicroseconds = 0

  constructor(build: StreamBuild, pretext: Pretext, font: string, turns: readonly Turn[], chunks: readonly TimedChunk[], options: {startTime: number, maxWidth: number, columnWidth: number}) {
    this.build = build
    this.pretext = pretext
    this.font = font
    this.turns = turns
    this.chunks = chunks
    this.maxWidth = options.maxWidth
    this.table = build.initialTable()
    this.table[build.cells.maxWidth] = options.maxWidth
    this.table[build.cells.columnWidth] = options.columnWidth
    this.animatedUntil = options.startTime
    this.state = layoutFlow(pretext, font, turns, turns.map(() => 0), options.maxWidth)
    settleAtTargets(build, this.table)
  }

  prefixLengthsAt(time: number): number[] {
    const lengths = this.turns.map(() => 0)
    for (const chunk of this.chunks) {
      if (chunk.time > time) break
      lengths[chunk.turn] = chunk.end
    }
    return lengths
  }

  stateAt(time: number): FlowState {
    return layoutFlow(this.pretext, this.font, this.turns, this.prefixLengthsAt(time), this.maxWidth)
  }

  // An independent copy from this moment on, e.g. to try a Stop at every press time from one stream
  // without replaying the frames before each press.
  fork(): StreamSession {
    return Object.assign(Object.create(StreamSession.prototype) as StreamSession, this, {table: Float32Array.from(this.table)})
  }

  requestStop(pressTime: number, releaseTime: number): void {
    this.pendingStop = {pressTime, releaseTime}
  }

  setWidths(maxWidth: number, columnWidth: number): void {
    this.maxWidth = maxWidth
    this.table[this.build.cells.maxWidth] = maxWidth
    this.table[this.build.cells.columnWidth] = columnWidth
    // Segment widths don't depend on the line width; only pretext's reference lines do.
    this.state = layoutFlow(this.pretext, this.font, this.turns, this.state.prefixLengths, maxWidth)
  }

  done(): boolean {
    return this.stopped || this.applied === this.chunks.length
  }

  frame(now: number): FrameResult {
    let writes: CellWrite[] = []
    let chunksApplied = 0
    let stopApplied = false
    // Chunks that arrive in the frame that handles the Stop came after the press and were never shown,
    // so they are dropped. Writing them would change the widths of segments that are fading out.
    const stopDue = this.pendingStop !== null && now >= this.pendingStop.releaseTime
    if (!this.stopped && !stopDue) {
      while (this.applied < this.chunks.length && this.chunks[this.applied]!.time <= now) {
        this.applied++
        chunksApplied++
      }
      if (chunksApplied > 0) {
        this.previousState = this.state
        this.state = layoutFlow(this.pretext, this.font, this.turns, this.prefixLengthsAt(this.chunks[this.applied - 1]!.time), this.maxWidth)
        writes = flowStateWrites(this.build, this.table, this.state)
        applyWrites(this.table, writes)
      }
    }
    if (this.pendingStop !== null && now >= this.pendingStop.releaseTime) {
      const pressState = this.stateAt(this.pendingStop.pressTime)
      const stop = stopWrites(this.build, this.table, pressState)
      applyWrites(this.table, stop)
      writes = [...writes, ...stop]
      this.stopWriteCount = stop.length
      this.previousState = this.state
      this.state = pressState
      this.stopped = true
      this.pendingStop = null
      stopApplied = true
    }
    const maximumSteps = 2 ** (this.build.options.springs?.config.stepBits ?? 8) - 1
    const elapsedSteps = Math.floor((now - this.animatedUntil) / stepMilliseconds)
    const steps = Math.max(0, Math.min(maximumSteps, elapsedSteps))
    // The doctrine's catch-up cap: after a long stall, drop the time the springs couldn't step.
    this.animatedUntil = elapsedSteps > maximumSteps ? now : this.animatedUntil + steps * stepMilliseconds
    const {cells} = this.build
    if (cells.stepCount !== null) this.table[cells.stepCount] = steps
    const started = performance.now()
    const outputs = this.build.outputs(this.build.compiled.evaluate(this.table))
    this.lastEvaluationMicroseconds = (performance.now() - started) * 1000
    writeBack(this.build, this.table, outputs)
    return {outputs, steps, chunksApplied, writes, stopApplied}
  }
}

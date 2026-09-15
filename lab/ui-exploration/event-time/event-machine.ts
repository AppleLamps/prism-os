// Commit per event, sample per frame.
//
// IndirectOS (spring-bank's bank circuit, deferred
// retargeting) writes its next-source outputs back only in commit evaluations:
// at event timestamps, and at fixed simulated times after them (commits.ts).
// A display evaluation computes what the screen shows at a frame's timestamp
// from the last committed table, with the time since that commit, and discards
// its next-source outputs. So committed state never depends on which frames
// were rendered.
import {type Wire, invariant} from '../../../numeric-ui-core.ts'
import {compileScalarProgram} from '../codegen/codegen.ts'
import {advanceReferenceClock, defaultClockConfig, quantizeFrameTime} from '../spring-bank/spring-math.ts'
import {
  type WindowManagerOptions,
  bankOptions,
  bankSourceField,
  createWindowManagerMachine,
  sourceField,
  validateWindowManagerOutput,
  validateWindowManagerSource,
  writeBankFrame,
} from '../spring-bank/window-manager.ts'

export type EventTimeOptions = {
  springs: 'split-table' | 'source-matrix'
  photosInputs: WindowManagerOptions['photosInputs']
  // 'executor' runs the shared runtime's executor over all roots. 'generated'
  // runs codegen.ts's generated JavaScript over two smaller programs: one with
  // the next-source roots for commits, one with the projection roots for
  // displays.
  evaluator: 'executor' | 'generated'
  // Executor only: run the copied JS validators around every evaluation.
  validate: boolean
  // Compile each window's snap bit as an output, for the float64 spring check.
  debugOutputs: boolean
}

export const defaultEventTimeOptions: EventTimeOptions = {
  springs: 'source-matrix',
  photosInputs: 'current-frame',
  evaluator: 'generated',
  validate: false,
  debugOutputs: false,
}

// values[index[wire]] is a wire's value; index[wire] is -1 when the program
// doesn't compute that wire. The executor's values are indexed by wire.
export type Evaluation = {
  values: Float32Array
  index: Int32Array
}

export function readWire(evaluation: Evaluation, wire: Wire) {
  const position = evaluation.index[wire]!
  invariant(position >= 0, 'wire is not computed by this program')
  return evaluation.values[position]!
}

type Evaluator = {
  evaluation: Evaluation
  run: (source: Float32Array) => void
}

const numericTolerance = 1e-5

export function createEventTimeMachine(options: Partial<EventTimeOptions> = {}) {
  const settings: EventTimeOptions = {...defaultEventTimeOptions, ...options}
  invariant(!settings.validate || settings.evaluator === 'executor', 'the validators read wire-indexed values from the executor')
  const base = createWindowManagerMachine({
    ...bankOptions,
    springs: settings.springs,
    retarget: 'deferred',
    photosInputs: settings.photosInputs,
    debugOutputs: settings.debugOutputs,
  })
  const {circuit, output} = base
  // The committed table. Event receivers latch into it, and only commits write it.
  const table = base.source
  const scratch = new Float32Array(table.length)
  const displayRoots: Wire[] = [
    ...output.windows,
    ...output.dockItems,
    output.animationActive,
    output.photos.backdropOpacity,
    ...output.photos.photos,
    ...output.photos.thumbnails,
    ...output.photos.previousControl,
    ...output.photos.nextControl,
  ]
  // animationActive is also the next-source value of the clock's running cell.
  const commitRoots: Wire[] = [...output.nextSource]

  let commitEvaluator: Evaluator
  let displayEvaluator: Evaluator
  if (settings.evaluator === 'executor') {
    const identity = Int32Array.from({length: circuit.sourceSize + circuit.operations.length}, (_, wire) => wire)
    const evaluation: Evaluation = {values: new Float32Array(0), index: identity}
    const run = (source: Float32Array) => {
      if (settings.validate) validateWindowManagerSource(source, numericTolerance)
      evaluation.values = circuit.evaluateTensor(source)
      if (settings.validate) validateWindowManagerOutput(evaluation.values, output, numericTolerance)
    }
    commitEvaluator = {evaluation, run}
    displayEvaluator = {evaluation, run}
  } else {
    const generated = (roots: readonly Wire[]): Evaluator => {
      const program = compileScalarProgram(circuit.compileTensorProgram(roots), {rowsPerFunction: 128})
      return {evaluation: {values: program.values, index: program.flat.positionOfWire}, run: program.run}
    }
    commitEvaluator = generated(commitRoots)
    displayEvaluator = generated(displayRoots)
  }
  const nextSourcePositions = Int32Array.from(output.nextSource, wire => commitEvaluator.evaluation.index[wire]!)
  const displayPositions = Int32Array.from(displayRoots, wire => displayEvaluator.evaluation.index[wire]!)
  invariant(nextSourcePositions.every(position => position >= 0), 'commit program misses a next-source wire')
  invariant(displayPositions.every(position => position >= 0), 'display program misses a projection wire')

  // Quantized to the clock's 1/64 ms grid.
  let lastCommitTime: number | null = null
  let lateCommits = 0

  function deltaSinceCommit(time: number) {
    invariant(lastCommitTime !== null, 'no commit yet')
    return Math.min(defaultClockConfig.maxFrameDeltaMs, Math.max(0, quantizeFrameTime(time, defaultClockConfig) - lastCommitTime))
  }

  return {
    base,
    circuit,
    output,
    options: settings,
    table,
    displayRoots,
    commitRoots,
    displayPositions,
    get lastCommitTime() {
      return lastCommitTime
    },
    get lateCommits() {
      return lateCommits
    },
    setViewport(width: number, height: number) {
      table[sourceField.viewportWidth] = width
      table[sourceField.viewportHeight] = height
    },
    // Advance the committed table to `time`, consuming latched events, and write
    // next-source back. A time before the last commit runs zero steps.
    commit(time: number): Evaluation {
      const quantized = quantizeFrameTime(time, defaultClockConfig)
      let delta = 0
      if (lastCommitTime !== null) {
        if (quantized < lastCommitTime) lateCommits++
        delta = deltaSinceCommit(time)
      }
      lastCommitTime = Math.max(lastCommitTime ?? quantized, quantized)
      writeBankFrame(table, base.options, delta)
      commitEvaluator.run(table)
      const values = commitEvaluator.evaluation.values
      for (let field = 0; field < table.length; field++) table[field] = values[nextSourcePositions[field]!]!
      return commitEvaluator.evaluation
    },
    // What the screen shows at `time`, from the last committed table. Writes
    // nothing back. The returned evaluation is reused by the next call.
    display(time: number): Evaluation {
      scratch.set(table)
      writeBankFrame(scratch, base.options, deltaSinceCommit(time))
      displayEvaluator.run(scratch)
      return displayEvaluator.evaluation
    },
    // The step count a display at `time` runs: min(300, floor((leftover + delta) / 4))
    // while the committed clock runs, else 0.
    stepsAt(time: number) {
      return advanceReferenceClock({
        leftoverMs: table[bankSourceField.clockLeftoverMs]!,
        running: table[bankSourceField.clockRunning]! > 0,
      }, deltaSinceCommit(time), defaultClockConfig).steps
    },
    running() {
      return table[bankSourceField.clockRunning]! > 0
    },
    leftoverMs() {
      return table[bankSourceField.clockLeftoverMs]!
    },
    snapshot(): MachineSnapshot {
      return {table: Float32Array.from(table), lastCommitTime}
    },
    restore(snapshot: MachineSnapshot) {
      table.set(snapshot.table)
      lastCommitTime = snapshot.lastCommitTime
    },
  }
}

export type MachineSnapshot = {table: Float32Array, lastCommitTime: number | null}

export type EventTimeMachine = ReturnType<typeof createEventTimeMachine>

// Offsets of each output group inside displayRoots.
export function displayLayout(machine: Pick<EventTimeMachine, 'output'>) {
  const {output} = machine
  const windows = 0
  const dockItems = windows + output.windows.length
  const animationActive = dockItems + output.dockItems.length
  const backdropOpacity = animationActive + 1
  const photos = backdropOpacity + 1
  const thumbnails = photos + output.photos.photos.length
  const previousControl = thumbnails + output.photos.thumbnails.length
  const nextControl = previousControl + output.photos.previousControl.length
  const size = nextControl + output.photos.nextControl.length
  return {windows, dockItems, animationActive, backdropOpacity, photos, thumbnails, previousControl, nextControl, size}
}

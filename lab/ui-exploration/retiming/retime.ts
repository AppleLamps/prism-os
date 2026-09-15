// Retiming search: which values should read last frame's value, chosen by
// replaying traces and measuring what a viewer would see.
//
// A model is a compiled program plus a description of what's visible: geometry
// in px, scale (converted to px), opacity, and decisions that must stay exact
// bits. A trace drives a model's source table frame by frame. The reference is
// the same model without cuts, on the same trace, closed loop: each run carries
// its own state, so a cut's effect can compound over frames.
import {
  type DepthAnalysis,
  type FlatProgram,
  type Graph,
  analyzeDepth,
  createRetimedEvaluator,
  criticalLevels,
  maskOf,
  minimumCut,
} from './flat.ts'

export type OutputGroup = {
  position: Int32Array
  label: string[]
  // Packed positions whose reference values must both be > 0 for the entry to
  // count, e.g. a window's opacity. -1 means no condition.
  maskA: Int32Array
  maskB: Int32Array
}

export type MetricSpec = {
  px: OutputGroup
  // Converted to px as |Δscale| × size / 2, with size from the reference frame.
  scale: OutputGroup & {size: Int32Array}
  opacity: OutputGroup
  // Exact bits and integers: any difference is a mismatch.
  decisions: OutputGroup
  // Outputs that are integers at rest but fractional in some frames, e.g. the
  // original IndirectOS's animationActive (a clamp) and a window's stack (its rank
  // plus 40 × its animation weight). In a frame where the reference or the retimed
  // value is an integer and the two differ, e.g. stack 4 against 44 or animationActive
  // 0 against 1, that's a decision mismatch. When both are fractional, the difference
  // is reported as maxUnitless but not budgeted.
  unitless: OutputGroup
}

export class OutputGroupBuilder {
  positions: number[] = []
  labels: string[] = []
  masksA: number[] = []
  masksB: number[] = []
  sizes: number[] = []

  add(position: number, label: string, maskA = -1, maskB = -1, size = -1) {
    if (position < 0) throw new Error(`output ${label} isn't live`)
    this.positions.push(position)
    this.labels.push(label)
    this.masksA.push(maskA)
    this.masksB.push(maskB)
    this.sizes.push(size)
  }

  build(): OutputGroup & {size: Int32Array} {
    return {
      position: Int32Array.from(this.positions),
      label: this.labels,
      maskA: Int32Array.from(this.masksA),
      maskB: Int32Array.from(this.masksB),
      size: Int32Array.from(this.sizes),
    }
  }
}

export function outputLabelMap(metric: MetricSpec) {
  const labels = new Map<number, string>()
  for (const group of [metric.px, metric.scale, metric.opacity, metric.decisions, metric.unitless]) {
    group.position.forEach((value, index) => { if (!labels.has(value)) labels.set(value, group.label[index]!) })
  }
  return labels
}

export type Model = {
  name: string
  program: FlatProgram
  metric: MetricSpec
}

export type TraceRun = {
  frames: number
  // Write this frame's inputs, evaluate, and write next-source cells back.
  frame(index: number, evaluate: (source: Float32Array) => Float32Array): void
}

export type Trace<M extends Model> = {
  name: string
  createRun(model: M): TraceRun
}

type GroupRecording = {values: Float32Array, visible: Uint8Array}

export type Recording = {
  trace: string
  frames: number
  px: GroupRecording
  scale: GroupRecording
  scaleSize: Float32Array
  opacity: GroupRecording
  decisions: GroupRecording
  unitless: GroupRecording
  // Frames in which each packed value differs from the previous frame.
  changeCount: Int32Array
}

export type SearchCase<M extends Model> = {trace: Trace<M>, recording: Recording}

function visible(values: Float32Array, group: OutputGroup, index: number) {
  const maskA = group.maskA[index]!
  const maskB = group.maskB[index]!
  return (maskA < 0 || values[maskA]! > 0) && (maskB < 0 || values[maskB]! > 0)
}

function allocateGroup(frames: number, group: OutputGroup): GroupRecording {
  return {values: new Float32Array(frames * group.position.length), visible: new Uint8Array(frames * group.position.length)}
}

function storeGroup(values: Float32Array, group: OutputGroup, target: GroupRecording, frame: number) {
  const count = group.position.length
  for (let index = 0; index < count; index++) {
    target.values[frame * count + index] = values[group.position[index]!]!
    target.visible[frame * count + index] = visible(values, group, index) ? 1 : 0
  }
}

export function recordTrace<M extends Model>(model: M, trace: Trace<M>, cuts: readonly number[] = []): Recording {
  const run = trace.createRun(model)
  const {metric, program} = model
  const frames = run.frames
  const recording: Recording = {
    trace: trace.name,
    frames,
    px: allocateGroup(frames, metric.px),
    scale: allocateGroup(frames, metric.scale),
    scaleSize: new Float32Array(frames * metric.scale.position.length),
    opacity: allocateGroup(frames, metric.opacity),
    decisions: allocateGroup(frames, metric.decisions),
    unitless: allocateGroup(frames, metric.unitless),
    changeCount: new Int32Array(program.valueCount),
  }
  const evaluator = createRetimedEvaluator(program, cuts)
  const previous = new Float32Array(program.valueCount)
  for (let frame = 0; frame < frames; frame++) {
    run.frame(frame, evaluator.evaluate)
    const values = evaluator.values
    storeGroup(values, metric.px, recording.px, frame)
    storeGroup(values, metric.scale, recording.scale, frame)
    const scaleCount = metric.scale.position.length
    for (let index = 0; index < scaleCount; index++) recording.scaleSize[frame * scaleCount + index] = values[metric.scale.size[index]!]!
    storeGroup(values, metric.opacity, recording.opacity, frame)
    storeGroup(values, metric.decisions, recording.decisions, frame)
    storeGroup(values, metric.unitless, recording.unitless, frame)
    if (frame > 0) {
      for (let position = 0; position < program.valueCount; position++) {
        if (!Object.is(values[position], previous[position])) recording.changeCount[position]!++
      }
    }
    previous.set(values.subarray(0, program.valueCount))
  }
  return recording
}

export function recordCases<M extends Model>(model: M, traces: readonly Trace<M>[]): SearchCase<M>[] {
  return traces.map(trace => ({trace, recording: recordTrace(model, trace)}))
}

// Decision outputs whose reference values aren't always integers in this recording.
export function fractionalDecisions(model: Model, recording: Recording) {
  const count = model.metric.decisions.position.length
  const labels = new Set<string>()
  for (let frame = 0; frame < recording.frames; frame++) {
    for (let index = 0; index < count; index++) {
      if (!Number.isInteger(recording.decisions.values[frame * count + index])) labels.add(model.metric.decisions.label[index]!)
    }
  }
  return [...labels]
}

// Cut values that didn't change in any frame of these recordings: their error
// there is 0 by construction, so the traces say nothing about them.
export function untestedCuts(cuts: readonly number[], recordings: readonly Recording[]) {
  return cuts.filter(position => recordings.every(recording => recording.changeCount[position] === 0))
}

export type Budget = {px: number, opacity: number}

export type ReplayResult = {
  trace: string
  frames: number
  framesRun: number
  maxPx: number
  maxPxLabel: string
  maxPxFrame: number
  maxOpacity: number
  maxOpacityLabel: string
  maxUnitless: number
  maxUnitlessLabel: string
  // Counted over (frame, decision output) pairs, including unitless outputs in
  // frames where one side is an integer.
  decisionMismatches: number
  // The part of decisionMismatches that comes from unitless outputs.
  unitlessMismatches: number
  mismatchFrames: number
  firstMismatch: string | null
  mismatchLabels: string[]
  // True when the replay stopped at the first frame over budget.
  stoppedEarly: boolean
  withinBudget: boolean
}

const sameValue = (left: number, right: number) => left === right || (Number.isNaN(left) && Number.isNaN(right))

function largestDifference(values: Float32Array, group: OutputGroup, target: GroupRecording, frame: number, current: number): {value: number, index: number} {
  const count = group.position.length
  let value = current
  let where = -1
  for (let index = 0; index < count; index++) {
    const actual = values[group.position[index]!]!
    // An entry counts when it's visible in the reference frame or in the retimed
    // frame: something shown that shouldn't be is visible too.
    if (target.visible[frame * count + index] === 0 && !visible(values, group, index)) continue
    const difference = Math.abs(actual - target.values[frame * count + index]!)
    if (!(difference <= value)) {
      value = Number.isNaN(difference) ? Infinity : difference
      where = index
    }
  }
  return {value, index: where}
}

export function replay<M extends Model>(model: M, cuts: readonly number[], trace: Trace<M>, recording: Recording, budget: Budget | null): ReplayResult {
  const run = trace.createRun(model)
  const {metric, program} = model
  const evaluator = createRetimedEvaluator(program, cuts)
  const result: ReplayResult = {
    trace: trace.name, frames: run.frames, framesRun: 0, maxPx: 0, maxPxLabel: '', maxPxFrame: -1, maxOpacity: 0, maxOpacityLabel: '',
    maxUnitless: 0, maxUnitlessLabel: '', decisionMismatches: 0, unitlessMismatches: 0, mismatchFrames: 0, firstMismatch: null, mismatchLabels: [], stoppedEarly: false, withinBudget: true,
  }
  if (run.frames !== recording.frames) throw new Error('trace frame count differs from the recording')
  const mismatchLabels = new Set<string>()
  const scaleCount = metric.scale.position.length
  const decisionCount = metric.decisions.position.length
  const unitlessCount = metric.unitless.position.length
  const overBudget = () => budget !== null && (result.maxPx > budget.px || result.maxOpacity > budget.opacity || result.decisionMismatches > 0)
  for (let frame = 0; frame < run.frames; frame++) {
    try {
      run.frame(frame, evaluator.evaluate)
    } catch (error) {
      // The host couldn't act on the retimed outputs, e.g. a focused index out of range.
      result.decisionMismatches++
      result.mismatchFrames++
      result.firstMismatch ??= `frame ${frame}: host threw ${(error as Error).message}`
      result.stoppedEarly = frame + 1 < run.frames
      break
    }
    const values = evaluator.values
    result.framesRun++
    const px = largestDifference(values, metric.px, recording.px, frame, result.maxPx)
    if (px.index >= 0) {
      result.maxPx = px.value
      result.maxPxLabel = metric.px.label[px.index]!
      result.maxPxFrame = frame
    }
    for (let index = 0; index < scaleCount; index++) {
      if (recording.scale.visible[frame * scaleCount + index] === 0) continue
      const difference = Math.abs(values[metric.scale.position[index]!]! - recording.scale.values[frame * scaleCount + index]!) * Math.abs(recording.scaleSize[frame * scaleCount + index]!) / 2
      if (!(difference <= result.maxPx)) {
        result.maxPx = Number.isNaN(difference) ? Infinity : difference
        result.maxPxLabel = metric.scale.label[index]!
        result.maxPxFrame = frame
      }
    }
    const opacity = largestDifference(values, metric.opacity, recording.opacity, frame, result.maxOpacity)
    if (opacity.index >= 0) {
      result.maxOpacity = opacity.value
      result.maxOpacityLabel = metric.opacity.label[opacity.index]!
    }
    const unitless = largestDifference(values, metric.unitless, recording.unitless, frame, result.maxUnitless)
    if (unitless.index >= 0) {
      result.maxUnitless = unitless.value
      result.maxUnitlessLabel = metric.unitless.label[unitless.index]!
    }
    let frameMismatches = 0
    for (let index = 0; index < decisionCount; index++) {
      const actual = values[metric.decisions.position[index]!]!
      const expected = recording.decisions.values[frame * decisionCount + index]!
      if (sameValue(actual, expected)) continue
      frameMismatches++
      const label = metric.decisions.label[index]!
      mismatchLabels.add(label)
      result.firstMismatch ??= `frame ${frame}: ${label} is ${actual}, reference ${expected}`
    }
    for (let index = 0; index < unitlessCount; index++) {
      const actual = values[metric.unitless.position[index]!]!
      const expected = recording.unitless.values[frame * unitlessCount + index]!
      if (sameValue(actual, expected) || !(Number.isInteger(actual) || Number.isInteger(expected))) continue
      frameMismatches++
      result.unitlessMismatches++
      const label = metric.unitless.label[index]!
      mismatchLabels.add(label)
      result.firstMismatch ??= `frame ${frame}: ${label} is ${actual}, reference ${expected}`
    }
    result.decisionMismatches += frameMismatches
    if (frameMismatches > 0) result.mismatchFrames++
    if (overBudget()) {
      result.stoppedEarly = frame + 1 < run.frames
      break
    }
  }
  result.withinBudget = !overBudget()
  result.mismatchLabels = [...mismatchLabels].slice(0, 12)
  return result
}

// Replays on several traces and combines: the largest errors, summed mismatches.
// With a budget, stops at the first trace over budget.
export function replayCases<M extends Model>(model: M, cuts: readonly number[], cases: readonly SearchCase<M>[], budget: Budget | null): ReplayResult {
  const combined: ReplayResult = {
    trace: cases.map(item => item.trace.name).join(' + '), frames: 0, framesRun: 0, maxPx: 0, maxPxLabel: '', maxPxFrame: -1, maxOpacity: 0, maxOpacityLabel: '',
    maxUnitless: 0, maxUnitlessLabel: '', decisionMismatches: 0, unitlessMismatches: 0, mismatchFrames: 0, firstMismatch: null, mismatchLabels: [], stoppedEarly: false, withinBudget: true,
  }
  for (const {trace, recording} of cases) {
    const result = replay(model, cuts, trace, recording, budget)
    combined.frames += result.frames
    combined.framesRun += result.framesRun
    if (result.maxPx > combined.maxPx) {
      combined.maxPx = result.maxPx
      combined.maxPxLabel = `${result.maxPxLabel} (${trace.name}, frame ${result.maxPxFrame})`
      combined.maxPxFrame = result.maxPxFrame
    }
    if (result.maxOpacity > combined.maxOpacity) {
      combined.maxOpacity = result.maxOpacity
      combined.maxOpacityLabel = `${result.maxOpacityLabel} (${trace.name})`
    }
    if (result.maxUnitless > combined.maxUnitless) {
      combined.maxUnitless = result.maxUnitless
      combined.maxUnitlessLabel = `${result.maxUnitlessLabel} (${trace.name})`
    }
    combined.decisionMismatches += result.decisionMismatches
    combined.unitlessMismatches += result.unitlessMismatches
    combined.mismatchFrames += result.mismatchFrames
    if (result.firstMismatch !== null) combined.firstMismatch ??= `${trace.name}, ${result.firstMismatch}`
    combined.mismatchLabels = [...new Set([...combined.mismatchLabels, ...result.mismatchLabels])].slice(0, 12)
    combined.stoppedEarly ||= result.stoppedEarly
    if (!result.withinBudget) {
      combined.withinBudget = false
      if (budget !== null) break
    }
  }
  return combined
}

export type Candidate = {
  strategy: string
  // Values added to the cut set.
  added: number[]
  layersAfter: number
}

export type SearchStep = {
  step: number
  strategy: string
  cuts: number[]
  added: number[]
  layersBefore: number
  layersAfter: number
  result: ReplayResult
  candidatesGenerated: number
  candidatesReplayed: number
  candidatesWithinBudget: number
  rejectedForDecisions: number
  rejectedForPx: number
  rejectedForOpacity: number
  milliseconds: number
}

export type SearchOptions = {
  budget: Budget
  maxSteps: number
  // A layer removed at an error below this many px counts as removed at this error.
  errorFloor: number
  log?: (line: string) => void
}

export type SearchEnd = {
  layers: number
  candidatesGenerated: number
  candidatesReplayed: number
  rejectedForDecisions: number
  rejectedForPx: number
  rejectedForOpacity: number
  // Among the rejected candidates that remove the most layers, replayed in full,
  // the one with the fewest mismatches, then the smallest error.
  closest: {strategy: string, added: number[], layersAfter: number, result: ReplayResult} | null
}

export type SearchRun = {steps: SearchStep[], end: SearchEnd, cuts: number[], milliseconds: number}

export type CandidateGenerator = (cuts: readonly number[], analysis: DepthAnalysis) => Candidate[]

// Greedy: at each step, generate candidate cut sets that shorten the longest chain,
// replay them on every case, and keep the one that removes the most layers per px
// of error among those within budget on all cases. Stops when none is within budget.
export function greedySearch<M extends Model>(
  model: M,
  graph: Graph,
  cases: readonly SearchCase<M>[],
  generate: CandidateGenerator,
  options: SearchOptions,
  initialCuts: readonly number[] = [],
): SearchRun {
  const started = performance.now()
  const steps: SearchStep[] = []
  let cuts = [...initialCuts]
  let end: SearchEnd | null = null
  for (let step = 0; step < options.maxSteps; step++) {
    const stepStarted = performance.now()
    const analysis = analyzeDepth(graph, maskOf(graph.program, cuts))
    const layersBefore = analysis.layers
    const seen = new Set<string>()
    const candidates = generate(cuts, analysis).filter(candidate => {
      if (candidate.layersAfter >= layersBefore || candidate.added.length === 0) return false
      const key = [...candidate.added].sort((left, right) => left - right).join(',')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    candidates.sort((left, right) => left.layersAfter - right.layersAfter || left.added.length - right.added.length)
    let best: {candidate: Candidate, result: ReplayResult, score: number} | null = null
    let replayed = 0
    let withinBudget = 0
    let rejectedForDecisions = 0
    let rejectedForPx = 0
    let rejectedForOpacity = 0
    const rejected: Candidate[] = []
    for (const candidate of candidates) {
      const removed = layersBefore - candidate.layersAfter
      // Sorted by layers removed, so once the best score beats what any later
      // candidate could reach at the error floor, stop.
      if (best !== null && removed / options.errorFloor < best.score) break
      const result = replayCases(model, [...cuts, ...candidate.added], cases, options.budget)
      replayed++
      if (!result.withinBudget) {
        if (result.decisionMismatches > 0) rejectedForDecisions++
        else if (result.maxPx > options.budget.px) rejectedForPx++
        else rejectedForOpacity++
        rejected.push(candidate)
        continue
      }
      withinBudget++
      const score = removed / Math.max(result.maxPx, options.errorFloor)
      if (best === null || score > best.score || (score === best.score && candidate.added.length < best.candidate.added.length)) {
        best = {candidate, result, score}
      }
    }
    if (best === null) {
      let closest: SearchEnd['closest'] = null
      for (const candidate of rejected.slice(0, 12)) {
        const result = replayCases(model, [...cuts, ...candidate.added], cases, null)
        if (closest === null || result.decisionMismatches < closest.result.decisionMismatches
          || (result.decisionMismatches === closest.result.decisionMismatches && result.maxPx < closest.result.maxPx)) {
          closest = {strategy: candidate.strategy, added: candidate.added, layersAfter: candidate.layersAfter, result}
        }
      }
      end = {layers: layersBefore, candidatesGenerated: candidates.length, candidatesReplayed: replayed, rejectedForDecisions, rejectedForPx, rejectedForOpacity, closest}
      options.log?.(`step ${step}: ${candidates.length} candidates, none within budget (decisions ${rejectedForDecisions}, px ${rejectedForPx}, opacity ${rejectedForOpacity})`)
      break
    }
    cuts = [...cuts, ...best.candidate.added]
    const record: SearchStep = {
      step,
      strategy: best.candidate.strategy,
      cuts: [...cuts],
      added: best.candidate.added,
      layersBefore,
      layersAfter: best.candidate.layersAfter,
      result: best.result,
      candidatesGenerated: candidates.length,
      candidatesReplayed: replayed,
      candidatesWithinBudget: withinBudget,
      rejectedForDecisions,
      rejectedForPx,
      rejectedForOpacity,
      milliseconds: performance.now() - stepStarted,
    }
    steps.push(record)
    options.log?.(`step ${step}: ${layersBefore} -> ${record.layersAfter} layers, +${best.candidate.added.length} registers (${best.candidate.strategy}), ${best.result.maxPx.toFixed(4)} px, opacity ${best.result.maxOpacity.toFixed(4)}; replayed ${replayed} of ${candidates.length}, ${(record.milliseconds / 1000).toFixed(1)} s`)
  }
  end ??= {layers: analyzeDepth(graph, maskOf(graph.program, cuts)).layers, candidatesGenerated: 0, candidatesReplayed: 0, rejectedForDecisions: 0, rejectedForPx: 0, rejectedForOpacity: 0, closest: null}
  return {steps, end, cuts, milliseconds: performance.now() - started}
}

// Strategy 1: along the longest chain. Every longest chain passes through exactly
// one critical value per depth, so the critical values at one depth are a cut set.
// A depth with one critical value is a single value on every longest chain; a depth
// with a few is that value's neighbors on parallel chains.
export function levelCandidates(graph: Graph, maxLevelSize: number): CandidateGenerator {
  return (cuts, analysis) => {
    const levels = criticalLevels(graph, analysis)
    const candidates: Candidate[] = []
    for (let level = 1; level < levels.length; level++) {
      const members = levels[level]!
      if (members.length === 0 || members.length > maxLevelSize) continue
      const mask = maskOf(graph.program, [...cuts, ...members])
      candidates.push({strategy: `critical values at depth ${level}`, added: members, layersAfter: analyzeDepth(graph, mask).layers})
    }
    return candidates
  }
}

// Strategy 2: minimum vertex cuts. For a target depth, the fewest values (or the
// values that change least often in the traces) whose cuts bring every chain to the
// target, found by max flow. These cut sets can separate a whole subcircuit, e.g.
// the inputs of an inlined child app, where the critical values at one depth can't.
export function minimumCutCandidates(graph: Graph, recordings: readonly Recording[], maxRegisters: number): CandidateGenerator {
  const changes = new Int32Array(graph.program.valueCount)
  for (const recording of recordings) for (let position = 0; position < changes.length; position++) changes[position] = changes[position]! + recording.changeCount[position]!
  return (cuts, analysis) => {
    const mask = maskOf(graph.program, cuts)
    const layers = analysis.layers
    const targets = new Set<number>()
    const lowest = Math.ceil(layers / 2)
    for (const reduction of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128]) {
      if (layers - reduction >= lowest) targets.add(layers - reduction)
    }
    targets.add(lowest)
    const candidates: Candidate[] = []
    const capacities: [string, (position: number) => number][] = [
      ['fewest registers', () => 1],
      ['fewest changing registers', position => 1 + changes[position]!],
    ]
    for (const target of targets) {
      for (const [name, capacity] of capacities) {
        const added = minimumCut(graph, analysis, mask, target, capacity)
        if (added === null || added.length === 0 || added.length > maxRegisters) continue
        const after = analyzeDepth(graph, maskOf(graph.program, [...cuts, ...added])).layers
        candidates.push({strategy: `minimum cut to ${target} layers, ${name}`, added, layersAfter: after})
      }
    }
    return candidates
  }
}

// What a value reads and what reads it, by name: the source cells in its upstream
// cone nearest first, and the named outputs its downstream cone reaches, grouped.
export function describeValue(
  graph: Graph,
  position: number,
  sourceName: (cell: number) => string,
  outputLabels: ReadonlyMap<number, string>,
  limits = {sources: 5, outputs: 6},
): {reads: string[], feeds: string[]} {
  const {program, inputStart, inputPosition, readerStart, readerRow} = graph
  const reads: string[] = []
  const readSet = new Set<string>()
  const seen = new Set<number>([position])
  let frontier = [position]
  while (frontier.length > 0 && reads.length < limits.sources) {
    const next: number[] = []
    for (const value of frontier) {
      if (value < program.sourceSize) continue
      const row = value - program.sourceSize
      for (let index = inputStart[row]!; index < inputStart[row + 1]!; index++) {
        const input = inputPosition[index]!
        if (seen.has(input)) continue
        seen.add(input)
        if (input < program.sourceSize) {
          const name = sourceName(input)
          if (!readSet.has(name) && reads.length < limits.sources) {
            readSet.add(name)
            reads.push(name)
          }
        } else {
          next.push(input)
        }
      }
    }
    frontier = next
  }
  const groups = new Map<string, number>()
  const downstream = new Set<number>([position])
  const stack = [position]
  while (stack.length > 0) {
    const value = stack.pop()!
    const label = outputLabels.get(value)
    if (label !== undefined) {
      const group = label.replace(/\[\d+\]/g, '[]').replace(/\d+/g, '#')
      groups.set(group, (groups.get(group) ?? 0) + 1)
    }
    for (let index = readerStart[value]!; index < readerStart[value + 1]!; index++) {
      const reader = program.sourceSize + readerRow[index]!
      if (downstream.has(reader)) continue
      downstream.add(reader)
      stack.push(reader)
    }
  }
  const feeds = [...groups].sort((left, right) => right[1] - left[1]).slice(0, limits.outputs).map(([group, count]) => `${group} (${count})`)
  return {reads, feeds}
}

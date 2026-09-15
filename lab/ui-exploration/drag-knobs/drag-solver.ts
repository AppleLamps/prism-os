// Direct manipulation of design knobs on any compiled UI, with no inverse code per widget.
//
// A designer drags an output edge, e.g. a card's right edge (x + width). The solver:
// 1. Seeds the output gradient on that edge's wires and backpropagates, which gives the edge's
//    slope with respect to every knob cell. Booleans are either straight-through (the runtime's
//    backpropagateReference, as the brief specified) or frozen (backward.ts), which gives the
//    exact slope inside the current decision region.
// 2. Takes a minimal-norm step over the unlocked knobs, in units of each knob's magnitude:
//    with scale_k = max(|knob_k|, magnitudeFloor_k), knob_k += error × g_k × scale_k² / Σ_j (g_j × scale_j)².
//    A knob sitting at a bound, whose step would push it further out, leaves the step.
//    Repeat for up to maxSteps steps.
// 3. If the error stays above tolerance, a step changes a visible decision, or the result
//    adds violations (e.g. horizontal overflow), it evaluates candidates as instances of the
//    same circuit, with the knobs as per-instance cells, and picks the valid candidate closest
//    to the target. Two candidate families:
//    - 'gradient line': 256 points along the first step's direction, knobs = start + t × error × direction
//      for t from -1 to 4, as the brief specified.
//    - 'gradient line and knob sweeps': half the budget on that line, half sweeping each unlocked
//      knob across its range, then up to maxSteps gradient steps from the chosen candidate.
//      A decision knob, e.g. a grid's minimum cell width, has gradient 0 everywhere, so only a
//      sweep can move it.
// The only code specific to a UI is the DragProblem: which cells are knobs, which integer
// outputs are decisions, and which output counts violations.
import type {Circuit, Wire} from '../../../numeric-ui-core.ts'
import {backpropagate, type BooleanGradient} from './backward.ts'
import {compileScalarProgram} from './codegen.ts'
import {compileInstanceProgram, planInstances, type InstanceRunner} from './instance.ts'

export type KnobSpec = {name: string, cell: Wire, minimum: number, maximum: number, magnitudeFloor: number}

// A weighted sum of output wires, e.g. a rectangle's right edge is [[x, 1], [width, 1]].
export type EdgeTerms = readonly (readonly [wire: Wire, coefficient: number])[]

export type DragProblem = {
  circuit: Circuit
  knobs: readonly KnobSpec[]
  // Integer outputs a designer sees as discrete results, e.g. column counts and line counts.
  decisions: readonly Wire[]
  // A count of violations. A candidate is valid when it has no more violations than the frame
  // started with. null means every candidate is valid.
  violations: Wire | null
  // Every wire an edge may read. The instance program outputs these.
  outputs: readonly Wire[]
  // Unclamped margins next to exact decisions, which flip queries read.
  margins: readonly Wire[]
}

export type SearchFamily = 'gradient line' | 'gradient line and knob sweeps'

export type DragSolverOptions = {
  tolerance: number
  maxSteps: number
  candidates: number
  search: SearchFamily
  // 'generated': generated JS for the forward pass (scattered back to wire order for
  // backpropagation); 'reference': the reference evaluator.
  forward: 'reference' | 'generated'
  // Search when a gradient step changes any visible decision, even if the edge reached its
  // target (the brief's rule). With false, only the error and validity trigger search.
  searchOnDecisionChange: boolean
  booleanGradient: BooleanGradient
}

export const defaultSolverOptions: DragSolverOptions = {
  tolerance: 0.5,
  maxSteps: 3,
  candidates: 256,
  search: 'gradient line and knob sweeps',
  forward: 'generated',
  searchOnDecisionChange: true,
  booleanGradient: 'frozen',
}

// A candidate replaces the current best only if it is closer to the target by at least this many
// pixels, so FP32 noise (e.g. 9.9999 against 10) doesn't pick a candidate that changes knobs for nothing.
const improvementThreshold = 0.01

export type FrameOutcome = 'already there' | 'gradient' | 'search' | 'unsolved'

export type SearchPick = 'start' | 'gradient' | 'line' | 'sweep' | 'polished'

export type FrameResult = {
  startError: number
  // Error after the gradient steps, before any search.
  gradientError: number
  finalError: number
  steps: number
  // How many gradient steps first brought the error within tolerance, or null if none did.
  solvedAtStep: number | null
  // A gradient step found no knob to move because every unlocked knob has gradient 0.
  zeroGradient: boolean
  // A gradient step found no knob to move because every unlocked knob with a nonzero gradient
  // sits at the range bound the step would push it past, e.g. gap = 0 while the edge needs a
  // smaller gap.
  blockedAtBound: boolean
  // Some gradient step changed a visible decision.
  gradientChangedDecision: boolean
  gradientValid: boolean
  searched: boolean
  picked: SearchPick
  outcome: FrameOutcome
  // Indices into problem.decisions whose values differ between the frame's start and its result.
  changedDecisions: number[]
  knobs: number[]
  microseconds: {gradient: number, search: number}
}

export type DragSolver = ReturnType<typeof createDragSolver>

export function edgeValue(values: ArrayLike<number>, edge: EdgeTerms): number {
  let total = 0
  for (const [wire, coefficient] of edge) total += coefficient * values[wire]!
  return total
}

export function createDragSolver(problem: DragProblem, options: DragSolverOptions = defaultSolverOptions) {
  const {circuit, knobs} = problem
  const width = circuit.sourceSize + circuit.operations.length
  const violationsWire = problem.violations
  const instanceOutputs = [...new Set([...problem.outputs, ...problem.decisions, ...problem.margins, ...(violationsWire === null ? [] : [violationsWire])])]
  const outputIndex = new Map(instanceOutputs.map((wire, index) => [wire, index]))
  // The forward pass only computes the wires the problem declares (and what they depend on),
  // so reading any other wire would silently return 0.
  const requireOutput = (wire: Wire) => {
    if (!outputIndex.has(wire)) throw new Error(`wire ${wire} is not an output of this drag problem`)
  }

  let evaluate: (source: Float32Array) => Float32Array
  if (options.forward === 'reference') {
    evaluate = source => circuit.evaluateReference(source)
  } else {
    // Gathers stay unlowered here, so every product a masked sum reads is live and holds its value.
    const forwardProgram = circuit.compileTensorProgram(instanceOutputs, false)
    const scalar = compileScalarProgram(forwardProgram, {rowsPerFunction: 128})
    const wireValues = new Float32Array(width)
    const wireOrder = forwardProgram.wireOrder
    evaluate = source => {
      circuit.validateSourceRanges(source)
      scalar.run(source)
      const packed = scalar.values
      for (let position = 0; position < wireOrder.length; position++) wireValues[wireOrder[position]!] = packed[position]!
      return wireValues
    }
  }

  const instanceProgram = circuit.compileTensorProgram(instanceOutputs)
  const plan = planInstances(instanceProgram, knobs.map(knob => knob.cell), instanceOutputs)
  const runner: InstanceRunner = compileInstanceProgram(plan, {rowsPerFunction: 128, blockSize: 256})
  let instanceSources = new Float32Array(options.candidates * knobs.length)
  let instanceResults = new Float32Array(options.candidates * instanceOutputs.length)

  // Evaluates `count` rows of knob values (count × knobs.length) against the shared source.
  // The returned array is reused by the next call.
  const evaluateCandidates = (source: Float32Array, rows: Float32Array, count: number) => {
    if (instanceResults.length < count * instanceOutputs.length) instanceResults = new Float32Array(count * instanceOutputs.length)
    circuit.validateSourceRanges(source)
    runner.runShared(source)
    runner.runInstances(rows, count, instanceResults)
    return instanceResults
  }
  const candidateValue = (results: Float32Array, candidate: number, wire: Wire) =>
    results[candidate * instanceOutputs.length + outputIndex.get(wire)!]!
  const candidateEdge = (results: Float32Array, candidate: number, edge: EdgeTerms) => {
    let total = 0
    for (const [wire, coefficient] of edge) total += coefficient * candidateValue(results, candidate, wire)
    return total
  }

  const gradientOf = (values: Float32Array, terms: EdgeTerms) => {
    const seeds = new Float32Array(width)
    for (const [wire, coefficient] of terms) seeds[wire] = seeds[wire]! + coefficient
    return backpropagate(circuit, values, seeds, options.booleanGradient)
  }
  const clampKnob = (index: number, value: number) => Math.min(knobs[index]!.maximum, Math.max(knobs[index]!.minimum, value))
  const magnitude = (index: number, value: number) => Math.max(Math.abs(value), knobs[index]!.magnitudeFloor)

  // The knob change per pixel of error. The direction is null when no unlocked knob can move the
  // edge; `anyGradient` then says whether some unlocked knob had a nonzero gradient but sat at a bound.
  const projectedDirection = (knobValues: ArrayLike<number>, gradients: Float32Array, unlocked: readonly number[], error: number) => {
    const direction = new Float64Array(knobs.length)
    let normSquared = 0
    let anyGradient = false
    const active: number[] = []
    for (const index of unlocked) {
      const knob = knobs[index]!
      const gradient = gradients[knob.cell]!
      if (gradient === 0) continue
      anyGradient = true
      const value = knobValues[index]!
      const change = error * gradient
      if ((change > 0 && value >= knob.maximum) || (change < 0 && value <= knob.minimum)) continue
      normSquared += (gradient * magnitude(index, value)) ** 2
      active.push(index)
    }
    if (normSquared === 0) return {direction: null, anyGradient}
    for (const index of active) direction[index] = gradients[knobs[index]!.cell]! * magnitude(index, knobValues[index]!) ** 2 / normSquared
    return {direction, anyGradient}
  }

  const readKnobs = (source: ArrayLike<number>) => knobs.map(knob => source[knob.cell]!)
  const writeKnobs = (source: Float32Array, knobValues: ArrayLike<number>) => knobs.forEach((knob, index) => { source[knob.cell] = knobValues[index]! })
  const readDecisions = (values: ArrayLike<number>) => problem.decisions.map(wire => values[wire]!)
  const readViolations = (values: ArrayLike<number>) => violationsWire === null ? 0 : values[violationsWire]!
  const sameDecisions = (values: ArrayLike<number>, reference: readonly number[]) => problem.decisions.every((wire, index) => values[wire] === reference[index])

  // Up to maxSteps projected minimal-norm steps from the knobs in `source` (mutated in place).
  const gradientSteps = (source: Float32Array, unlocked: readonly number[], edge: EdgeTerms, target: number, startDecisions: readonly number[]) => {
    let values = evaluate(source)
    let error = target - edgeValue(values, edge)
    let steps = 0
    let solvedAtStep: number | null = Math.abs(error) <= options.tolerance ? 0 : null
    let zeroGradient = false
    let blockedAtBound = false
    let changedDecision = false
    let firstDirection: Float64Array | null = null
    while (Math.abs(error) > options.tolerance && steps < options.maxSteps) {
      const {direction, anyGradient} = projectedDirection(readKnobs(source), gradientOf(values, edge), unlocked, error)
      if (direction === null) {
        if (anyGradient) blockedAtBound = true
        else zeroGradient = true
        break
      }
      firstDirection ??= direction
      for (const index of unlocked) {
        const cell = knobs[index]!.cell
        source[cell] = clampKnob(index, source[cell]! + error * direction[index]!)
      }
      values = evaluate(source)
      steps++
      error = target - edgeValue(values, edge)
      if (!sameDecisions(values, startDecisions)) changedDecision = true
      if (solvedAtStep === null && Math.abs(error) <= options.tolerance) solvedAtStep = steps
    }
    return {error, steps, solvedAtStep, zeroGradient, blockedAtBound, changedDecision, firstDirection, violations: readViolations(values)}
  }

  const solveFrame = (source: Float32Array, unlocked: readonly number[], edge: EdgeTerms, target: number): FrameResult => {
    for (const [wire] of edge) requireOutput(wire)
    const gradientStart = performance.now()
    const startKnobs = readKnobs(source)
    const startValues = evaluate(source)
    const startDecisions = readDecisions(startValues)
    const startViolations = readViolations(startValues)
    const startError = target - edgeValue(startValues, edge)
    const stepped = new Float32Array(source)
    const gradient = gradientSteps(stepped, unlocked, edge, target, startDecisions)
    const gradientValid = gradient.violations <= startViolations
    const gradientMicroseconds = (performance.now() - gradientStart) * 1000

    const searchStart = performance.now()
    let best = {knobs: readKnobs(stepped), error: gradient.error, picked: 'gradient' as SearchPick}
    const accepted = Math.abs(gradient.error) <= options.tolerance && gradientValid && !(options.searchOnDecisionChange && gradient.changedDecision)
    let searched = false
    if (!accepted) {
      searched = true
      const distance = (knobValues: ArrayLike<number>) => {
        let total = 0
        knobs.forEach((_, index) => { total += ((knobValues[index]! - startKnobs[index]!) / magnitude(index, startKnobs[index]!)) ** 2 })
        return total
      }
      // The frame's start is always a valid fallback.
      best = {knobs: startKnobs, error: startError, picked: 'start'}
      let bestDistance = 0
      const consider = (knobValues: number[], error: number, picked: SearchPick) => {
        const candidateDistance = distance(knobValues)
        const closer = Math.abs(error) < Math.abs(best.error) - improvementThreshold
        const asClose = Math.abs(error) <= Math.abs(best.error) + improvementThreshold
        if (closer || (asClose && candidateDistance < bestDistance)) {
          best = {knobs: knobValues, error, picked}
          bestDistance = candidateDistance
        }
      }
      if (gradientValid) consider(readKnobs(stepped), gradient.error, 'gradient')
      const rows: number[][] = []
      const families: SearchPick[] = []
      const lineCount = gradient.firstDirection === null ? 0 : options.search === 'gradient line' ? options.candidates : options.candidates >> 1
      for (let point = 0; point < lineCount; point++) {
        const t = -1 + 5 * point / Math.max(1, lineCount - 1)
        rows.push(startKnobs.map((value, index) => clampKnob(index, value + t * startError * gradient.firstDirection![index]!)))
        families.push('line')
      }
      if (options.search === 'gradient line and knob sweeps' && unlocked.length > 0) {
        const perKnob = Math.floor((options.candidates - lineCount) / unlocked.length)
        for (const index of unlocked) {
          const knob = knobs[index]!
          for (let point = 0; point < perKnob; point++) {
            const row = [...startKnobs]
            row[index] = knob.minimum + (knob.maximum - knob.minimum) * point / Math.max(1, perKnob - 1)
            rows.push(row)
            families.push('sweep')
          }
        }
      }
      if (rows.length > 0) {
        if (instanceSources.length < rows.length * knobs.length) instanceSources = new Float32Array(rows.length * knobs.length)
        rows.forEach((row, candidate) => row.forEach((value, index) => { instanceSources[candidate * knobs.length + index] = value }))
        const results = evaluateCandidates(source, instanceSources, rows.length)
        rows.forEach((_, candidate) => {
          const violations = violationsWire === null ? 0 : candidateValue(results, candidate, violationsWire)
          if (violations > startViolations) return
          // Read the knobs back as FP32, which is what the instance evaluated.
          const knobValues = Array.from(instanceSources.subarray(candidate * knobs.length, (candidate + 1) * knobs.length))
          consider(knobValues, target - candidateEdge(results, candidate, edge), families[candidate]!)
        })
      }
      if (options.search === 'gradient line and knob sweeps' && Math.abs(best.error) > options.tolerance && best.picked !== 'start' && best.picked !== 'gradient') {
        const polished = new Float32Array(source)
        writeKnobs(polished, best.knobs)
        const polishedDecisions = readDecisions(evaluate(polished))
        const polish = gradientSteps(polished, unlocked, edge, target, polishedDecisions)
        if (polish.violations <= startViolations && Math.abs(polish.error) < Math.abs(best.error)) {
          best = {knobs: readKnobs(polished), error: polish.error, picked: 'polished'}
        }
      }
    }
    writeKnobs(source, best.knobs)
    const finalValues = evaluate(source)
    const finalError = target - edgeValue(finalValues, edge)
    const changedDecisions: number[] = []
    problem.decisions.forEach((wire, index) => { if (finalValues[wire] !== startDecisions[index]) changedDecisions.push(index) })
    const outcome: FrameOutcome = Math.abs(startError) <= options.tolerance && best.picked === 'gradient'
      ? 'already there'
      : Math.abs(finalError) > options.tolerance ? 'unsolved' : searched ? 'search' : 'gradient'
    return {
      startError,
      gradientError: gradient.error,
      finalError,
      steps: gradient.steps,
      solvedAtStep: gradient.solvedAtStep,
      zeroGradient: gradient.zeroGradient,
      blockedAtBound: gradient.blockedAtBound,
      gradientChangedDecision: gradient.changedDecision,
      gradientValid,
      searched,
      picked: best.picked,
      outcome,
      changedDecisions,
      knobs: readKnobs(source),
      microseconds: {gradient: gradientMicroseconds, search: searched ? (performance.now() - searchStart) * 1000 : 0},
    }
  }

  return {problem, options, plan, runner, instanceOutputs, requireOutput, evaluate, evaluateCandidates, candidateValue, gradientOf, solveFrame}
}

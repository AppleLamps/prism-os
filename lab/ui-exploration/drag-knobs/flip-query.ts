// Flip queries: "which knob change flips this decision?", from an unclamped margin next to
// each exact decision. A decision flips where its margin crosses 0. One backward pass on the
// margin gives its gradient with respect to every knob, so the predicted change for knob k is
// -margin / gradient_k. The prediction is exact when the margin is linear in the knob and no
// other decision flips first, e.g. a grid bit [inner + epsilon >= c × minCellWidth + (c - 1) × gap]
// is linear in the gap and the minimum cell width.
//
// Each prediction is checked independently of the gradient: the knob is scanned over its range
// as 256 instances in the predicted direction (both directions when there is no prediction), the
// first change of the results is located, and bisection with the evaluator narrows it down.
import type {Wire} from '../../../numeric-ui-core.ts'
import {edgeValue, type DragSolver, type EdgeTerms} from './drag-solver.ts'

export type MarginQuery = {
  label: string
  // margin = Σ coefficient × value. The decision flips where the margin crosses 0.
  terms: EdgeTerms
  // Discrete results that change when the decision flips, e.g. a grid's column count.
  results: readonly Wire[]
  // The results the query asks about, e.g. [3] for "drops to 3 columns". A prediction holds only
  // if the results just past it equal these. Without them, any change counts.
  expected?: readonly number[]
}

export type FlipAnswer = {
  label: string
  knob: string
  margin: number
  gradient: number
  // -margin / gradient, or null when the gradient is 0.
  predictedChange: number | null
  insideRange: boolean
  // Just past the predicted change the results differ (and equal the expected results, when the
  // query has them), and just before it they don't.
  holds: boolean | null
  // Where the results first change along this knob, or null if they never do inside the range.
  actualChange: number | null
  resultsAfter: number[] | null
}

export function answerFlipQueries(
  solver: DragSolver,
  source: Float32Array,
  query: MarginQuery,
  knobIndices: readonly number[],
  options: {scan: boolean} = {scan: true},
): FlipAnswer[] {
  const {problem} = solver
  for (const [wire] of query.terms) solver.requireOutput(wire)
  for (const wire of query.results) solver.requireOutput(wire)
  const values = new Float32Array(solver.evaluate(source))
  const margin = edgeValue(values, query.terms)
  const startResults = query.results.map(wire => values[wire]!)
  const gradients = solver.gradientOf(values, query.terms)
  const differs = (other: ArrayLike<number>) => query.results.some((wire, index) => other[wire] !== startResults[index])
  const flippedAt = (knobIndex: number, knobValue: number) => {
    const probe = new Float32Array(source)
    probe[problem.knobs[knobIndex]!.cell] = knobValue
    const probeValues = solver.evaluate(probe)
    return {flipped: differs(probeValues), results: query.results.map(wire => probeValues[wire]!)}
  }
  return knobIndices.map(knobIndex => {
    const knob = problem.knobs[knobIndex]!
    const value = source[knob.cell]!
    const gradient = gradients[knob.cell]!
    const predictedChange = gradient === 0 ? null : -margin / gradient
    const insideRange = predictedChange !== null && value + predictedChange >= knob.minimum && value + predictedChange <= knob.maximum
    let holds: boolean | null = null
    if (predictedChange !== null && insideRange) {
      // Step past the crossing by at least 1/64 px of margin, or 0.1% of the change.
      const overshoot = Math.sign(predictedChange || gradient) * Math.max(Math.abs(predictedChange) * 1e-3, 1 / (64 * Math.abs(gradient)))
      const after = Math.min(knob.maximum, Math.max(knob.minimum, value + predictedChange + overshoot))
      const before = value + predictedChange - overshoot
      const beforeInRange = before >= knob.minimum && before <= knob.maximum
      const past = flippedAt(knobIndex, after)
      const matchesExpected = query.expected === undefined || query.expected.every((expectedValue, index) => past.results[index] === expectedValue)
      holds = past.flipped && matchesExpected && (!beforeInRange || Math.sign(before - value) !== Math.sign(predictedChange) || !flippedAt(knobIndex, before).flipped)
    }
    let actualChange: number | null = null
    let resultsAfter: number[] | null = null
    if (options.scan) {
      const directions = predictedChange === null ? [1, -1] : [Math.sign(predictedChange) || 1]
      const perDirection = Math.floor(solver.options.candidates / directions.length)
      const rows = new Float32Array(perDirection * directions.length * problem.knobs.length)
      const points: number[] = []
      directions.forEach((direction, directionIndex) => {
        const bound = direction > 0 ? knob.maximum : knob.minimum
        for (let point = 1; point <= perDirection; point++) {
          const candidate = directionIndex * perDirection + point - 1
          problem.knobs.forEach((other, otherIndex) => { rows[candidate * problem.knobs.length + otherIndex] = source[other.cell]! })
          const knobValue = value + (bound - value) * point / perDirection
          rows[candidate * problem.knobs.length + knobIndex] = knobValue
          points.push(rows[candidate * problem.knobs.length + knobIndex]!)
        }
      })
      const results = solver.evaluateCandidates(source, rows, points.length)
      let bestChange: number | null = null
      directions.forEach((_, directionIndex) => {
        for (let point = 0; point < perDirection; point++) {
          const candidate = directionIndex * perDirection + point
          if (!query.results.some((wire, index) => solver.candidateValue(results, candidate, wire) !== startResults[index])) continue
          // Bisect between the previous point (or the start) and this one.
          let low = point === 0 ? value : points[candidate - 1]!
          let high = points[candidate]!
          for (let iteration = 0; iteration < 24; iteration++) {
            const middle = (low + high) / 2
            if (Math.fround(middle) === Math.fround(low) || Math.fround(middle) === Math.fround(high)) break
            if (flippedAt(knobIndex, middle).flipped) high = middle
            else low = middle
          }
          const change = high - value
          if (bestChange === null || Math.abs(change) < Math.abs(bestChange)) {
            bestChange = change
            resultsAfter = flippedAt(knobIndex, high).results
          }
          break
        }
      })
      actualChange = bestChange
    }
    return {label: query.label, knob: knob.name, margin, gradient, predictedChange, insideRange, holds, actualChange, resultsAfter}
  })
}

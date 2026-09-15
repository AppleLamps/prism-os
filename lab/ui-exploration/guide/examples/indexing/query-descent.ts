// A toy: move a query index by gradient descent so that a read lands on the
// entry holding a target id. The gradient of every read comes from
// Circuit.backpropagateReference on the compiled circuit's operations.
import {buildLinearRead} from './linear-read.ts'
import {buildSoftAttentionRead} from './soft-attention.ts'

// 0 where the table holds the target, 1 elsewhere. A read over this table is the
// expected per-entry loss under the read's weights: it's small only when the
// weights sit on the matching entry, and a blend of two wrong entries can't
// make it small.
export function matchLoss(itemIds: readonly number[], targetId: number): number[] {
  return itemIds.map(itemId => itemId === targetId ? 0 : 1)
}

export type DescentOptions = {
  startQuery: number
  steps: number
  learningRate: number
  // The largest distance, in positions, that one step may move the query.
  maximumStep: number
}

function clampQuery(query: number, count: number) {
  return Math.min(Math.max(query, 0), count - 1)
}

function stepQuery(query: number, change: number, count: number, maximumStep: number) {
  return clampQuery(query + Math.min(Math.max(change, -maximumStep), maximumStep), count)
}

// Minimizes a soft attention read over entryLosses. sharpnessAt gives the
// sharpness for each step, e.g. a schedule that starts wide and ends sharp. The
// loss curves more sharply as the sharpness grows, so the learning rate is
// divided by the sharpness.
export function descendSoftAttention(
  entryLosses: readonly number[],
  options: DescentOptions & {sharpnessAt: (step: number) => number},
): number[] {
  const reader = buildSoftAttentionRead(entryLosses.length)
  let query = options.startQuery
  const queries = [query]
  for (let step = 0; step < options.steps; step++) {
    const sharpness = options.sharpnessAt(step)
    const values = reader.circuit.evaluateReference(reader.source(query, sharpness, entryLosses))
    const outputGradients = new Float32Array(values.length)
    outputGradients[reader.read] = 1
    const gradients = reader.circuit.backpropagateReference(values, outputGradients)
    const change = -options.learningRate / sharpness * gradients[reader.query]!
    query = stepQuery(query, change, entryLosses.length, options.maximumStep)
    queries.push(query)
  }
  return queries
}

// Minimizes a loss of a linear interpolation read over tableValues:
// - 'read': the read itself, e.g. the expected per-entry loss over a matchLoss table,
// - {target}: ((read - target) / scale)², a loss on the blended value.
export function descendLinearRead(
  tableValues: readonly number[],
  options: DescentOptions & {loss: 'read' | {target: number, scale: number}},
): number[] {
  const reader = buildLinearRead(tableValues.length)
  const {loss} = options
  let query = options.startQuery
  const queries = [query]
  for (let step = 0; step < options.steps; step++) {
    const values = reader.circuit.evaluateReference(reader.source(query, tableValues))
    const read = values[reader.read]!
    const outputGradients = new Float32Array(values.length)
    outputGradients[reader.read] = loss === 'read' ? 1 : 2 * (read - loss.target) / (loss.scale * loss.scale)
    const gradients = reader.circuit.backpropagateReference(values, outputGradients)
    const change = -options.learningRate * gradients[reader.index]!
    query = stepQuery(query, change, tableValues.length, options.maximumStep)
    queries.push(query)
  }
  return queries
}

// Holds startSharpness for holdSteps, grows it geometrically to endSharpness over
// rampSteps, then holds endSharpness.
export function sharpnessSchedule(startSharpness: number, endSharpness: number, holdSteps: number, rampSteps: number) {
  return (step: number) => {
    const progress = Math.min(Math.max((step - holdSteps) / rampSteps, 0), 1)
    return Math.fround(startSharpness * (endSharpness / startSharpness) ** progress)
  }
}

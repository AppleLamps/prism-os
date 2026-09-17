// The tallest of n heights, combined in two orders: one item at a time, like the staged program's `max`
// reduction and cards-duplicated.ts, or as a balanced tree, like gallery-circuit.ts's emitMaximumTree.
//
// emitMaximum(a, b) computes b + relu(a - b), and each of its operations rounds to FP32. When a and b are
// far apart, a - b rounds, and adding b back can land one FP32 step away from a. So the result isn't
// always exactly one of the inputs, and combining the same heights in a different order can give different
// bits. On integer heights every step is exact, and both orders give Math.max.
import {Circuit, emitMaximum, type Wire} from '../../../../../src/runtime/numeric-ui-core.ts'

const f = Math.fround

// One combine, with emitMaximum's FP32 steps: f(b + max(0, f(a - b))).
export const combineMaximum = (a: number, b: number) => f(b + Math.max(0, f(a - b)))

export function maximumInItemOrder(heights: Float32Array): number {
  let running = heights[0]!
  for (let index = 1; index < heights.length; index++) running = combineMaximum(running, heights[index]!)
  return running
}

export function maximumAsTree(heights: Float32Array): number {
  let level = [...heights]
  while (level.length > 1) {
    const next: number[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : combineMaximum(level[index]!, right))
    }
    level = next
  }
  return level[0]!
}

export type MaximumOrder = 'item order' | 'tree'

// Heights live in source cells 0..count - 1.
export function buildMaximumCircuit(count: number, order: MaximumOrder) {
  const circuit = new Circuit(count)
  const heights: Wire[] = Array.from({length: count}, (_, cell) => {
    const height = circuit.source(cell)
    circuit.assumeRange(height, 0, 8192)
    return height
  })
  let tallest: Wire
  if (order === 'item order') {
    tallest = heights[0]!
    for (let index = 1; index < count; index++) tallest = emitMaximum(circuit, tallest, heights[index]!)
  } else {
    let level = heights
    while (level.length > 1) {
      const next: Wire[] = []
      for (let index = 0; index < level.length; index += 2) {
        const right = level[index + 1]
        next.push(right === undefined ? level[index]! : emitMaximum(circuit, level[index]!, right))
      }
      level = next
    }
    tallest = level[0]!
  }
  const evaluate = circuit.createTensorEvaluator([tallest])
  return {circuit, tallest, evaluate: (source: Float32Array) => evaluate(source)[0]!}
}

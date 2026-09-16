// What the reference backward pass reports for each kind of operation, next to float64
// finite differences of the same arithmetic. Every row is one small circuit, one input wire
// and one output wire.
import {Circuit, type Wire, emitRelu, emitSelect, asWire} from '../../../../../numeric-ui-core.ts'

// smooth: the arithmetic is smooth at this input, and the backward pass should give its slope.
// corner: the arithmetic has a corner at this input, and the backward pass gives one side's slope.
// wrong: the arithmetic is smooth at this input, and the backward pass gives a different number.
// step: the arithmetic jumps at a threshold, so its slope is 0 on both sides of this input.
export type RowKind = 'smooth' | 'corner' | 'wrong' | 'step'

export type GradientRow = {
  operation: string
  input: string
  withRespectTo: string
  kind: RowKind
  // The forward value of the row's output wire.
  output: number
  // null when the backward pass throws
  backward: number | null
  thrown: string
  leftDifference: number
  centralDifference: number
  rightDifference: number
}

type Built = {circuit: Circuit, output: Wire}

function runBackward(built: Built, source: readonly number[], wire: number, straightThrough = false) {
  const values = built.circuit.evaluateReference(Float32Array.from(source))
  const output = values[built.output]!
  const seeds = new Float32Array(values.length)
  seeds[built.output] = 1
  try {
    const gradients = built.circuit.backpropagateReference(values, seeds, straightThrough ? {booleanGradient: 'straight-through'} : {})
    return {output, backward: gradients[wire]! as number | null, thrown: ''}
  } catch (error) {
    return {output, backward: null, thrown: (error as Error).message}
  }
}

function differences(evaluate: (value: number) => number, value: number, step: number) {
  const below = evaluate(value - step)
  const at = evaluate(value)
  const above = evaluate(value + step)
  return {
    leftDifference: (at - below) / step,
    centralDifference: (above - below) / (2 * step),
    rightDifference: (above - at) / step,
  }
}

// The float64 arithmetic with one source value replaced.
function changedSource(source: readonly number[], wire: number, value: number) {
  const changed = [...source]
  changed[wire] = value
  return changed
}

const relu = (value: number) => Math.max(0, value)

export function basicGradientRows(): GradientRow[] {
  const rows: GradientRow[] = []
  const push = (
    operation: string,
    input: string,
    withRespectTo: string,
    kind: RowKind,
    result: {output: number, backward: number | null, thrown: string},
    difference: {leftDifference: number, centralDifference: number, rightDifference: number},
  ) => rows.push({operation, input, withRespectTo, kind, ...result, ...difference})

  {
    const circuit = new Circuit(2)
    const output = circuit.roundAffine([[circuit.source(0), 0.25], [circuit.source(1), 3]], 1)
    const source = [10, -2]
    const reference = (values: readonly number[]) => 0.25 * values[0]! + 3 * values[1]! + 1
    for (const [name, wire] of [['a', 0], ['b', 1]] as const) {
      push('affine sum `0.25 × a + 3 × b + 1`', 'a = 10, b = −2', name, 'smooth',
        runBackward({circuit, output}, source, wire),
        differences(value => reference(changedSource(source, wire, value)), source[wire]!, 1e-6))
    }
  }

  {
    // Both operands may be negative, so circuit.multiply expands into two ReLU-gated products and
    // their difference, and records the product as a macro that the backward pass differentiates whole.
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(0), -10, 10)
    circuit.assumeRange(circuit.source(1), -10, 10)
    const output = circuit.multiply(circuit.source(0), circuit.source(1))
    push('`circuit.multiply(a, x)`', 'a = 3, x = 0', 'x', 'smooth',
      runBackward({circuit, output}, [3, 0], 1),
      differences(x => 3 * x, 0, 1e-6))
  }

  {
    // The same two ReLU-gated products written by hand, with no macro and with x in the gate:
    // a × max(0, x) − a × max(0, −x). Both ReLUs sit at their corner, where the backward pass
    // uses slope 0, so no gradient reaches x even though the product has slope 3 there.
    const circuit = new Circuit(2)
    const positiveArm = circuit.reglu([[circuit.source(0), 1]], 0, [[circuit.source(1), 1]], 0)
    const negativeArm = circuit.reglu([[circuit.source(0), 1]], 0, [[circuit.source(1), -1]], 0)
    const output = circuit.roundAffine([[positiveArm, 1], [negativeArm, -1]])
    push('two ReLU arms with no macro, `a × max(0, x) − a × max(0, −x)`', 'a = 3, x = 0', 'x', 'wrong',
      runBackward({circuit, output}, [3, 0], 1),
      differences(x => 3 * x, 0, 1e-6))
  }

  {
    const circuit = new Circuit(1)
    const output = emitRelu(circuit, circuit.source(0))
    for (const [x, kind] of [[0, 'corner'], [2, 'smooth']] as const) {
      push('`emitRelu(x)`', `x = ${x}`, 'x', kind, runBackward({circuit, output}, [x], 0), differences(relu, x, 1e-6))
    }
  }

  {
    const circuit = new Circuit(3)
    circuit.assumeRange(circuit.source(0), 0, 1)
    circuit.assumeRange(circuit.source(1), -100, 100)
    circuit.assumeRange(circuit.source(2), -100, 100)
    const output = emitSelect(circuit, circuit.source(0), circuit.source(1), circuit.source(2))
    const blend = (values: readonly number[]) => values[0]! * values[2]! + (1 - values[0]!) * values[1]!
    for (const gate of [0.25, 1]) {
      const source = [gate, 10, 40]
      for (const [name, wire] of [['gate', 0], ['off', 1], ['on', 2]] as const) {
        push('`emitSelect(gate, off, on)`', `gate = ${gate}, off = 10, on = 40`, name, 'smooth',
          runBackward({circuit, output}, source, wire),
          differences(value => blend(changedSource(source, wire, value)), source[wire]!, 1e-6))
      }
    }
  }

  {
    // [value >= 5] as relu(value − 4) − relu(value − 5): exactly 0 or 1 for whole numbers, and a
    // ramp from 0 to 1 between 4 and 5.
    const circuit = new Circuit(1)
    const upper = circuit.reglu([], 1, [[circuit.source(0), 1]], -4)
    const lower = circuit.reglu([], 1, [[circuit.source(0), 1]], -5)
    const output = circuit.roundAffine([[upper, 1], [lower, -1]])
    const reference = (value: number) => relu(value - 4) - relu(value - 5)
    for (const [value, kind] of [[4, 'corner'], [4.5, 'smooth'], [5, 'corner'], [6, 'smooth']] as const) {
      push('integer bit `[value >= 5]`', `value = ${value}`, 'value', kind,
        runBackward({circuit, output}, [value], 0),
        differences(reference, value, 1e-6))
    }
  }

  {
    // [a > b] as one rounding stage: clamp01(0.5 − 2^-25 + 256 × (a − b)), rounded by the boolean atom.
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(0), 0, 16384)
    circuit.assumeRange(circuit.source(1), 0, 16384)
    const difference = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), -1]])
    const justBelowHalf = 0.5 - 2 ** -25
    const positivePart = circuit.reglu([], 1, [[difference, 256]], justBelowHalf)
    const aboveOne = circuit.reglu([], 1, [[difference, 256]], justBelowHalf - 1)
    const score = circuit.affine([[positivePart, 1], [aboveOne, -1]])
    circuit.assumeRange(score, 0, 1)
    const output = circuit.boolean(score)
    const referenceBit = (a: number) => (Math.min(1, Math.max(0, justBelowHalf + 256 * (a - 100))) >= 0.5 ? 1 : 0)
    for (const [label, gap, straightThrough] of [['2^-10', 2 ** -10, false], ['2^-10', 2 ** -10, true], ['0.25', 0.25, true]] as const) {
      push(`boolean atom \`[a > b]\`, ${straightThrough ? 'straight-through' : 'default options'}`, `a − b = ${label}`, 'a', 'step',
        runBackward({circuit, output}, [100 + gap, 100], 0, straightThrough),
        differences(referenceBit, 100 + gap, 1e-6))
    }
  }

  {
    // [d > 0] as a two-stage sign cascade for |d| <= 16384 at a resolution of 2^-30:
    // stage 1 = min(1, relu(2^10 × d)), stage 2 = min(1, 2^20 × stage 1). Nothing rounds, so the
    // real arithmetic is min(1, 2^30 × relu(d)): flat, then a ramp 2^-30 wide, then flat. At
    // exactly d = 2^-30 the output is 1, but the last stage's upper ReLU sits at its corner and
    // passes nothing, so the backward pass still reports the ramp's slope.
    const circuit = new Circuit(1)
    circuit.assumeRange(circuit.source(0), -16384, 16384)
    const firstStage = circuit.roundAffine([
      [circuit.reglu([], 1, [[circuit.source(0), 2 ** 10]], 0), 1],
      [circuit.reglu([], 1, [[circuit.source(0), 2 ** 10]], -1), -1],
    ])
    circuit.assumeRange(firstStage, 0, 1)
    const output = circuit.roundAffine([
      [firstStage, 2 ** 20],
      [circuit.reglu([], 1, [[firstStage, 2 ** 20]], -1), -1],
    ])
    const reference = (d: number) => Math.min(1, 2 ** 30 * relu(d))
    for (const [label, d, step, kind] of [['0.3', 0.3, 1e-6, 'smooth'], ['2^-30', 2 ** -30, 2 ** -35, 'corner'], ['2^-31', 2 ** -31, 2 ** -35, 'smooth']] as const) {
      push('sign cascade `[d > 0]`, 2 stages', `d = ${label}`, 'd', kind,
        runBackward({circuit, output}, [d], 0),
        differences(reference, d, step))
    }
  }

  {
    // rowHeights[rowIndex] through a one-hot of hat functions of a whole-number index. The real
    // arithmetic of the hats interpolates linearly between neighboring entries.
    const rowHeights = [28, 44, 28, 60, 36, 52, 20, 40]
    const circuit = new Circuit(1 + rowHeights.length)
    circuit.assumeRange(circuit.source(0), 0, rowHeights.length - 1)
    for (let entry = 0; entry < rowHeights.length; entry++) circuit.assumeRange(asWire(1 + entry), 0, 100)
    const terms = rowHeights.map((_, position): [Wire, number] => {
      const member = circuit.roundAffine([
        [circuit.reglu([], 1, [[circuit.source(0), 1]], 1 - position), 1],
        [circuit.reglu([], 1, [[circuit.source(0), 1]], -position), -2],
        [circuit.reglu([], 1, [[circuit.source(0), 1]], -1 - position), 1],
      ])
      circuit.assumeRange(member, 0, 1)
      return [circuit.multiply(member, asWire(1 + position)), 1]
    })
    const output = circuit.roundAffine(terms)
    const interpolate = (values: readonly number[]) => {
      const index = values[0]!
      const lower = Math.floor(index)
      const fraction = index - lower
      return values[1 + lower]! * (1 - fraction) + (values[2 + lower] ?? 0) * fraction
    }
    const source = [3, ...rowHeights]
    for (const [name, wire] of [['rowHeights[3]', 4], ['rowHeights[2]', 3]] as const) {
      push('one-hot read `rowHeights[rowIndex]`', 'rowIndex = 3', name, 'smooth',
        runBackward({circuit, output}, source, wire),
        differences(value => interpolate(changedSource(source, wire, value)), source[wire]!, 1e-6))
    }
    push('one-hot read `rowHeights[rowIndex]`', 'rowIndex = 3', 'rowIndex', 'corner',
      runBackward({circuit, output}, source, 0),
      differences(value => interpolate(changedSource(source, 0, value)), 3, 1e-6))
  }

  return rows
}

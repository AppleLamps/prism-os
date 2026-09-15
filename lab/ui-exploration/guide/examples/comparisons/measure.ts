// Circuits and checks shared by comparisons.test.ts and report.ts.
import {Circuit, type Wire} from '../../../../../numeric-ui-core.ts'
import {emitPositiveBitByRounding, planRoundingCompare} from './boolean-atom.ts'
import {roundedOperations} from './exact-arithmetic.ts'
import {createRandom, differenceClasses, f, nextUp, smallestSubnormal} from './fp32.ts'
import {emitPositiveBit, emitTraceCompilerCascade, planSignCascade} from './sign-cascade.ts'

// Two source cells a and b in [0, 16384], so |a - b| <= 2^14, like pixel coordinates.
export function pixelPair(): Circuit {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 16384)
  circuit.assumeRange(1, 0, 16384)
  return circuit
}

// One source cell holding the difference itself, within ±differenceBound.
export function differenceCell(differenceBound: number): Circuit {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, -differenceBound, differenceBound)
  return circuit
}

// Operands a and b in [0, 16384] whose FP32 difference is exactly `difference`.
export function pairWithDifference(difference: number): Float32Array {
  return difference >= 0 ? Float32Array.of(difference, 0) : Float32Array.of(0, -difference)
}

// Operand pairs in [0, 16384]: a fifth equal, a fifth adjacent FP32 values, a fifth that differ by
// about 2^-20 of their size, a fifth with both operands below 2^-20, and a fifth unrelated.
export function randomPixelPairs(seed: number, count: number): [number, number][] {
  const random = createRandom(seed)
  const pairs: [number, number][] = [[0, smallestSubnormal], [smallestSubnormal, 0], [16384, 0], [0, 16384], [0, 0]]
  for (let index = 0; index < count; index++) {
    const kind = index % 5
    const a = kind === 3 ? f(random() * 2 ** -20) : f(random() * 16384)
    const b = kind === 0 ? a
      : kind === 1 ? nextUp(a)
      : kind === 2 ? f(a * (1 + 2 ** -20))
      : kind === 3 ? f(random() * 2 ** -20)
      : f(random() * 16384)
    if (b <= 16384) pairs.push(random() < 0.5 ? [a, b] : [b, a])
  }
  return pairs
}

// One clamp stage in one evaluation: the scaled value it clamps, its limit, and its output.
export type StageValues = {input: number, limit: number, output: number}

export type SignTest = {
  circuit: Circuit
  differenceBound: number
  bit: Wire
  stages?: (values: Float32Array) => StageValues[]
}

// [difference > 0] with the scale inside each ReLU's gate, on a cell that holds the difference.
export function cascadeSignTest(differenceBound: number, stageExponent = 24, inlineStageOutputs = false): SignTest {
  const circuit = differenceCell(differenceBound)
  const plan = planSignCascade({differenceBound, stageExponent})
  const {bit, stageOutputs} = emitPositiveBit(circuit, 0, plan, {inlineStageOutputs})
  return {
    circuit,
    differenceBound,
    bit,
    // The scaled value isn't a wire in this layout, so it's recomputed in float64, where a power of
    // two times an FP32 value is exact.
    stages: values => plan.stages.map(({scale, limit}, index) => ({
      input: scale * (index === 0 ? Math.max(0, values[0]!) : values[stageOutputs[index - 1]!]!),
      limit,
      output: values[stageOutputs[index]!]!,
    })),
  }
}

// [difference > 0] as the trace compiler lays it out, on a cell that holds the difference.
export function traceCompilerSignTest(differenceBound: number, stageExponent: number): SignTest {
  const circuit = differenceCell(differenceBound)
  const {bit, clampInputs, clampOutputs} = emitTraceCompilerCascade(circuit, 0, differenceBound, stageExponent)
  return {
    circuit,
    differenceBound,
    bit,
    stages: values => clampInputs.map((input, index) => ({input: values[input]!, limit: 1, output: values[clampOutputs[index]!]!})),
  }
}

// [difference > 0] with clamp stages when needed and a rounding stage at the end.
export function roundingSignTest(differenceBound: number, resolution?: number): SignTest {
  const circuit = differenceCell(differenceBound)
  const plan = planRoundingCompare(resolution === undefined ? {differenceBound} : {differenceBound, resolution})
  return {circuit, differenceBound, bit: emitPositiveBitByRounding(circuit, 0, plan)}
}

export type ClassResult = {label: string, tested: number, wrong: number, firstWrong: string}

// Evaluates a sign test on every class of FP32 difference within its bound. Checks the bit against
// JavaScript's `difference > 0`, every stage's scaled value against 2^24 times its limit (the range
// where the clamp is exact), every stage output against min(limit, scaled value), the compiled tensor
// program against the reference evaluator on every live wire, and optionally every operation against
// exact arithmetic.
export function checkDifferenceClasses(test: SignTest, options: {seed: number, randomCount: number, exactCheck: boolean}) {
  const program = test.circuit.compileTensorProgram()
  const classes: ClassResult[] = []
  let tested = 0
  let wrong = 0
  let fractional = 0
  let stageViolations = 0
  let largestStageRatio = 0
  let roundedResults = 0
  let tensorMismatches = 0
  for (const {label, values} of differenceClasses(test.differenceBound, createRandom(options.seed), options.randomCount)) {
    const result: ClassResult = {label, tested: values.length, wrong: 0, firstWrong: ''}
    for (const difference of values) {
      const source = Float32Array.of(difference)
      const wires = test.circuit.evaluateReference(source)
      const bit = wires[test.bit]!
      tested++
      if (bit !== 0 && bit !== 1) fractional++
      if (bit !== (difference > 0 ? 1 : 0)) {
        if (result.wrong === 0) result.firstWrong = `${difference} gave ${bit}`
        result.wrong++
      }
      for (const {input, limit, output} of test.stages?.(wires) ?? []) {
        largestStageRatio = Math.max(largestStageRatio, input / (2 ** 24 * limit))
        if (output !== Math.min(limit, input)) stageViolations++
      }
      if (options.exactCheck) roundedResults += roundedOperations(test.circuit, wires).length
      const tensorValues = test.circuit.evaluateTensor(source)
      for (const wire of program.wireOrder) {
        if (!Object.is(tensorValues[wire], wires[wire]) && tensorValues[wire] !== wires[wire]) tensorMismatches++
      }
    }
    wrong += result.wrong
    classes.push(result)
  }
  return {tested, wrong, fractional, stageViolations, largestStageRatio, roundedResults, tensorMismatches, classes}
}

// The trace compiler's column count at viewport width 1732: columnsReal = f(f(width - 24) * f(1/244))
// is one FP32 step below 7, while float64 gives exactly 7.
export function columnsAtLeastSevenAt1732(emit: (circuit: Circuit, columnsReal: Wire, seven: Wire) => Wire) {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 16384)
  circuit.assumeRange(1, 7, 7)
  const widthMinusGutter = circuit.roundAffine([[0, 1]], -24)
  const columnsReal = circuit.roundAffine([[widthMinusGutter, f(1 / 244)]])
  const bit = emit(circuit, columnsReal, 1)
  const values = circuit.evaluateReference(Float32Array.of(1732, 7))
  return {columnsReal: values[columnsReal]!, bit: values[bit]!}
}

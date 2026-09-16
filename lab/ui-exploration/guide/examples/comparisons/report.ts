// Prints the measurements quoted in guide/sections/comparisons.md. From the repo root:
//   bun lab/ui-exploration/guide/examples/comparisons/report.ts
import {Circuit, type Wire} from '../../../../../numeric-ui-core.ts'
import {emitCompare, planCompare} from '../../../numeric-library/comparison.ts'
import {emitAtLeastByRounding, emitAtLeastIntegerByRounding, emitGreaterByRounding, emitRoundingStage, planRoundingCompare} from './boolean-atom.ts'
import {buildLineFill, chainFormLabels, chainForms, countLineFillMismatches} from './chain.ts'
import {createRandom, differenceClasses, largestFinite, measureCost, smallestSubnormal} from './fp32.ts'
import {emitAtLeastInteger, emitAtLeastOnGrid} from './integer-bit.ts'
import {cascadeSignTest, checkDifferenceClasses, columnsAtLeastSevenAt1732, pairWithDifference, pixelPair, randomPixelPairs, roundingSignTest, type SignTest, traceCompilerSignTest} from './measure.ts'
import {evaluateWithMode, executorModes} from './rewrites.ts'
import {emitAtLeast, emitEqual, emitGreater, emitTraceCompilerCascade, planSignCascade} from './sign-cascade.ts'

type Row = (string | number)[]

function printTable(title: string, header: readonly string[], rows: readonly Row[]) {
  console.log(`\n### ${title}\n`)
  console.log(`| ${header.join(' | ')} |`)
  console.log(`| ${header.map(() => '---').join(' | ')} |`)
  for (const row of rows) console.log(`| ${row.join(' | ')} |`)
}

const exponentLabel = (value: number) => `2^${Math.log2(value)}`

// -----------------------------------------------------------------------------------------------
// Cost by how far each stage multiplies
{
  const rows: Row[] = []
  for (const stageExponent of [1, 8, 23, 24]) {
    const circuit = pixelPair()
    const {operations, layers} = measureCost(circuit, [emitGreater(circuit, circuit.source(0), circuit.source(1), {stageExponent})])
    const stages = planSignCascade({differenceBound: 16384, stageExponent}).stages.length
    rows.push([`scale inside the ReLU's gate, at most 2^${stageExponent} per later stage`, stages, operations, layers])
  }
  for (const stageExponent of [1, 8, 23]) {
    const circuit = pixelPair()
    const difference = circuit.roundAffine([[circuit.source(0), 1], [circuit.source(1), -1]])
    const {bit, clampInputs} = emitTraceCompilerCascade(circuit, difference, 16384, stageExponent)
    const {operations, layers} = measureCost(circuit, [bit])
    rows.push([`trace compiler layout, 2^${stageExponent} per later stage`, clampInputs.length, operations, layers])
  }
  {
    const circuit = pixelPair()
    const {operations, layers} = measureCost(circuit, [emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1))])
    const plan = planRoundingCompare({differenceBound: 16384})
    rows.push(['clamp stages, then a rounding stage', `${plan.clampStages?.stages.length ?? 0} + 1`, operations, layers])
  }
  printTable('[a > b] for a, b in [0, 16384], every pair of distinct FP32 values, including the difference operation', ['layout', 'clamp stages', 'operations', 'layers'], rows)
}

// -----------------------------------------------------------------------------------------------
// Cost by stated resolution
{
  const rows: Row[] = []
  for (const resolution of [2 ** -149, 2 ** -60, 2 ** -30, 2 ** -10, 2 ** -6, 1]) {
    const cascadeCircuit = pixelPair()
    const cascade = measureCost(cascadeCircuit, [emitGreater(cascadeCircuit, cascadeCircuit.source(0), cascadeCircuit.source(1), {resolution})])
    const roundingCircuit = pixelPair()
    const rounding = measureCost(roundingCircuit, [emitGreaterByRounding(roundingCircuit, roundingCircuit.source(0), roundingCircuit.source(1), {resolution})])
    const cascadeStages = planSignCascade({differenceBound: 16384, resolution}).stages.length
    const roundingPlan = planRoundingCompare({differenceBound: 16384, resolution})
    rows.push([
      exponentLabel(resolution),
      `${cascadeStages} / ${cascade.operations} / ${cascade.layers}`,
      `${roundingPlan.clampStages?.stages.length ?? 0} + 1 / ${rounding.operations} / ${rounding.layers}`,
    ])
  }
  printTable('[a > b] for a, b in [0, 16384] by stated resolution: stages / operations / layers', ['resolution', 'sign cascade', 'clamp stages + rounding stage'], rows)
}

// -----------------------------------------------------------------------------------------------
// Integer forms and equality
{
  const rows: Row[] = []
  {
    const circuit = new Circuit(1)
    circuit.assumeRange(circuit.source(0), -(2 ** 20), 2 ** 20)
    rows.push(['integer bit [value >= 7], value from a source cell', ...Object.values(measureCost(circuit, [emitAtLeastInteger(circuit, circuit.source(0), 7)]))])
  }
  {
    const circuit = pixelPair()
    rows.push(['integer bit [a >= b], a and b on a 1/64 grid', ...Object.values(measureCost(circuit, [emitAtLeastOnGrid(circuit, circuit.source(0), circuit.source(1), 1 / 64)]))])
  }
  {
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(0), 0, 2 ** 22)
    circuit.assumeRange(circuit.source(1), 0, 2 ** 22)
    rows.push(['one boolean atom [a >= b], integers in [0, 2^22]', ...Object.values(measureCost(circuit, [emitAtLeastIntegerByRounding(circuit, circuit.source(0), circuit.source(1))]))])
  }
  {
    const circuit = pixelPair()
    const bit = emitAtLeast(circuit, circuit.source(0), circuit.source(1), {resolution: 1 / 64})
    // Read the negation from a product, the way a select would, so the negation is copied in.
    rows.push(['sign cascade [a >= b] at resolution 1/64, read by one product', ...Object.values(measureCost(circuit, [circuit.reglu([[circuit.source(0), 1]], 0, [[bit, 1]], 0)]))])
  }
  {
    const circuit = pixelPair()
    rows.push(['sign cascade [a === b], every FP32 value', ...Object.values(measureCost(circuit, [emitEqual(circuit, circuit.source(0), circuit.source(1))]))])
  }
  printTable('Integer forms and equality', ['form', 'operations', 'layers'], rows)
}

// -----------------------------------------------------------------------------------------------
// Every class of FP32 difference
{
  const configurations: [label: string, build: () => SignTest, randomCount: number, exactCheck: boolean][] = [
    ['gate layout, 2^24 per later stage, bound 2^128', () => cascadeSignTest(largestFinite, 24), 2000, true],
    ['gate layout, 2^23 per later stage, bound 2^128', () => cascadeSignTest(largestFinite, 23), 2000, true],
    ['gate layout, 2^8 per later stage, bound 2^128', () => cascadeSignTest(largestFinite, 8), 2000, true],
    ['gate layout, 2^1 per later stage, bound 2^128', () => cascadeSignTest(largestFinite, 1), 500, false],
    ['gate layout, 2^24 per later stage, bound 2^14', () => cascadeSignTest(16384, 24), 2000, true],
    ['trace compiler layout, 2^23 per later stage, bound 2^14', () => traceCompilerSignTest(16384, 23), 2000, true],
    ['trace compiler layout, 2^8 per later stage, bound 2^14', () => traceCompilerSignTest(16384, 8), 2000, true],
    ['trace compiler layout, 2^1 per later stage, bound 2^14', () => traceCompilerSignTest(16384, 1), 500, false],
    ['gate layout with stage outputs copied into the next stage, bound 2^14', () => cascadeSignTest(16384, 24, true), 2000, true],
    ['one rounding stage, bound 2^14, planned for resolution 2^-31', () => roundingSignTest(16384, 2 ** -31), 2000, true],
    ['clamp stages + rounding stage, bound 2^128', () => roundingSignTest(largestFinite), 2000, true],
  ]
  const rows: Row[] = []
  for (const [label, build, randomCount, exactCheck] of configurations) {
    const test = build()
    const {operations, layers} = measureCost(test.circuit, [test.bit])
    const result = checkDifferenceClasses(test, {seed: 7, randomCount, exactCheck})
    rows.push([
      label,
      `${operations} / ${layers}`,
      result.tested,
      result.wrong,
      result.fractional,
      test.stages === undefined ? '-' : result.largestStageRatio,
      test.stages === undefined ? '-' : result.stageViolations,
      exactCheck ? result.roundedResults : 'not checked',
      result.tensorMismatches,
      result.classes.map(({label: classLabel, tested, wrong, firstWrong}) => `${classLabel} ${wrong}/${tested}${wrong > 0 ? ` (first: ${firstWrong})` : ''}`).join('; '),
    ])
  }
  printTable('[difference > 0] over every class of FP32 difference within the bound', ['configuration', 'operations / layers', 'values', 'wrong bits', 'outputs not 0 or 1', 'largest scaled value / (2^24 × limit)', 'stage outputs that differ from min(limit, scaled value)', 'operation results that rounded', 'tensor program wires that differ from the reference', 'wrong per class'], rows)
}

// -----------------------------------------------------------------------------------------------
// Operand pairs, including equal and adjacent values
{
  const pairs = randomPixelPairs(11, 20000)
  const forms: [string, (circuit: Circuit) => [Wire, Wire, Wire | null]][] = [
    ['sign cascade, every FP32 value', circuit => [emitGreater(circuit, circuit.source(0), circuit.source(1)), emitAtLeast(circuit, circuit.source(0), circuit.source(1)), emitEqual(circuit, circuit.source(0), circuit.source(1))]],
    ['sign cascade, resolution 2^-10', circuit => [emitGreater(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -10}), emitAtLeast(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -10}), null]],
    ['clamp stages + rounding stage, every FP32 value', circuit => [emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1)), emitAtLeastByRounding(circuit, circuit.source(0), circuit.source(1)), null]],
    ['one rounding stage, resolution 2^-31', circuit => [emitGreaterByRounding(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -31}), emitAtLeastByRounding(circuit, circuit.source(0), circuit.source(1), {resolution: 2 ** -31}), null]],
  ]
  const rows: Row[] = []
  for (const [label, build] of forms) {
    const circuit = pixelPair()
    const [greater, atLeast, equal] = build(circuit)
    let wrongGreater = 0
    let wrongAtLeast = 0
    let wrongEqual = 0
    let fractional = 0
    for (const [a, b] of pairs) {
      const values = circuit.evaluateReference(Float32Array.of(a, b))
      if (values[greater] !== (a > b ? 1 : 0)) wrongGreater++
      if (values[atLeast] !== (a >= b ? 1 : 0)) wrongAtLeast++
      if (equal !== null && values[equal] !== (a === b ? 1 : 0)) wrongEqual++
      for (const wire of [greater, atLeast]) if (values[wire] !== 0 && values[wire] !== 1) fractional++
    }
    rows.push([label, pairs.length, wrongGreater, wrongAtLeast, equal === null ? '-' : wrongEqual, fractional])
  }
  printTable('Operand pairs in [0, 16384]: a fifth equal, a fifth adjacent FP32 values, a fifth both below 2^-20', ['form', 'pairs', 'wrong [a > b]', 'wrong [a >= b]', 'wrong [a === b]', 'outputs not 0 or 1'], rows)
}

// -----------------------------------------------------------------------------------------------
// The column boundary at viewport width 1732
{
  const roundingStageWithScale = (scale: number) => (circuit: Circuit, columnsReal: Wire, seven: Wire) => {
    const difference = circuit.roundAffine([[seven, 1], [columnsReal, -1]])
    const bit = circuit.affine([[emitRoundingStage(circuit, difference, scale), -1]], 1)
    circuit.assumeRange(bit, 0, 1)
    return bit
  }
  const cascade = columnsAtLeastSevenAt1732((circuit, columnsReal, seven) => emitAtLeast(circuit, columnsReal, seven))
  const planned = columnsAtLeastSevenAt1732((circuit, columnsReal, seven) => emitAtLeastByRounding(circuit, columnsReal, seven, {resolution: 2 ** -30}))
  const columnsReal = cascade.columnsReal
  const rows: Row[] = [
    ['JavaScript on the FP32 value', columnsReal >= 7 ? 1 : 0],
    ['JavaScript in float64, where (1732 - 24) / 244 is exactly 7', (1732 - 24) / 244 >= 7 ? 1 : 0],
    ['sign cascade', cascade.bit],
    [`rounding stage planned from the declared range for resolution 2^-30 (scale ${exponentLabel(planRoundingCompare({differenceBound: 64, resolution: 2 ** -30}).finalScale)})`, planned.bit],
  ]
  for (const exponent of [-4, -5, -6, -15]) rows.push([`rounding stage with scale 2^${exponent}`, columnsAtLeastSevenAt1732(roundingStageWithScale(2 ** exponent)).bit])
  printTable(`[columnsReal >= 7] at viewport width 1732, where columnsReal = ${columnsReal}`, ['computed by', 'bit'], rows)
}

// -----------------------------------------------------------------------------------------------
// numeric-library's emitCompare with large declared bounds
{
  const rows: Row[] = []
  for (const bound of [2 ** 15, 2 ** 23, 2 ** 30, 2 ** 60]) {
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(0), -bound / 2, bound / 2)
    circuit.assumeRange(circuit.source(1), -bound / 2, bound / 2)
    const bit = emitCompare(circuit, circuit.source(0), circuit.source(1), '>')
    const values = circuit.evaluateReference(Float32Array.of(smallestSubnormal, 0))
    rows.push([exponentLabel(bound), planCompare(bound).clampScales[0] ?? '-', values[bit]!])
  }
  printTable('numeric-library emitCompare(a, b, \'>\') with operands declared within ±bound/2, at a = 2^-149, b = 0', ['difference bound', 'first clamp scale', '[a > b] (JavaScript: 1)'], rows)
}

// -----------------------------------------------------------------------------------------------
// Executor modes
{
  type Form = {label: string, circuit: Circuit, bit: Wire, cases: {source: Float32Array, expected: number}[]}
  const random = createRandom(3)
  const differences = differenceClasses(16384, random, 2000).flatMap(({values}) => values)
  const differenceCases = differences.map(difference => ({source: Float32Array.of(difference), expected: difference > 0 ? 1 : 0}))
  const forms: Form[] = []
  {
    const circuit = new Circuit(1)
    circuit.assumeRange(circuit.source(0), -1000, 1000)
    const cases = Array.from({length: 2001}, (_, index) => ({source: Float32Array.of(index - 1000), expected: index - 1000 >= 7 ? 1 : 0}))
    forms.push({label: 'integer bit [value >= 7]', circuit, bit: emitAtLeastInteger(circuit, circuit.source(0), 7), cases})
  }
  {
    const circuit = pixelPair()
    const cases = Array.from({length: 4000}, () => [Math.round(random() * 16384 * 64) / 64, Math.round(random() * 16384 * 64) / 64] as const)
      .concat([[100, 100], [100, 100 + 1 / 64], [100 + 1 / 64, 100]])
      .map(([a, b]) => ({source: Float32Array.of(a, b), expected: a >= b ? 1 : 0}))
    forms.push({label: 'integer bit [a >= b] on a 1/64 grid', circuit, bit: emitAtLeastOnGrid(circuit, circuit.source(0), circuit.source(1), 1 / 64), cases})
  }
  {
    const circuit = new Circuit(2)
    circuit.assumeRange(circuit.source(0), 0, 2 ** 22)
    circuit.assumeRange(circuit.source(1), 0, 2 ** 22)
    const cases = Array.from({length: 4000}, (_, index) => {
      const a = Math.floor(random() * 2 ** 22)
      const b = index % 3 === 0 ? a : index % 3 === 1 ? Math.min(2 ** 22, a + 1) : Math.floor(random() * 2 ** 22)
      return {source: Float32Array.of(a, b), expected: a >= b ? 1 : 0}
    })
    forms.push({label: 'one boolean atom [a >= b], integers in [0, 2^22]', circuit, bit: emitAtLeastIntegerByRounding(circuit, circuit.source(0), circuit.source(1)), cases})
  }
  for (const [label, build] of [
    ['sign cascade [difference > 0], every FP32 value', () => cascadeSignTest(16384)],
    ['sign cascade with stage outputs copied into the next stage', () => cascadeSignTest(16384, 24, true)],
    ['one rounding stage [difference > 0], resolution 2^-31', () => roundingSignTest(16384, 2 ** -31)],
    ['clamp stages + rounding stage [difference > 0], every FP32 value', () => roundingSignTest(16384)],
  ] as const) {
    const test = build()
    forms.push({label, circuit: test.circuit, bit: test.bit, cases: differenceCases})
  }
  const rows: Row[] = []
  for (const form of forms) {
    const row: Row = [form.label, form.cases.length]
    for (const mode of executorModes) {
      row.push(form.cases.filter(({source, expected}) => evaluateWithMode(form.circuit, source, mode)[form.bit] !== expected).length)
    }
    rows.push(row)
  }
  printTable('Wrong outputs per executor mode', ['form', 'cases', ...executorModes], rows)
}

// -----------------------------------------------------------------------------------------------
// Backpropagation
{
  const gradientRow = (label: string, circuit: Circuit, bit: Wire, source: Float32Array, options?: {booleanGradient: 'straight-through'}): Row => {
    const values = circuit.evaluateReference(source)
    const seeds = new Float32Array(values.length)
    seeds[bit] = 1
    try {
      const gradients = circuit.backpropagateReference(values, seeds, options)
      let nonFinite = 0
      let largest = 0
      for (let wire = circuit.sourceSize; wire < gradients.length; wire++) {
        const gradient = gradients[wire]!
        if (!Number.isFinite(gradient)) nonFinite++
        else largest = Math.max(largest, Math.abs(gradient))
      }
      return [label, values[bit]!, gradients[0]!, circuit.sourceSize > 1 ? gradients[1]! : '-', nonFinite, largest]
    } catch (error) {
      return [label, values[bit]!, `throws: ${(error as Error).message}`, '-', '-', '-']
    }
  }
  const rows: Row[] = []
  const cascadeCircuit = pixelPair()
  const cascadeBit = emitGreater(cascadeCircuit, cascadeCircuit.source(0), cascadeCircuit.source(1))
  for (const difference of [-1, 0, smallestSubnormal, 2 ** -148, 2 ** -30, 0.3, 100]) {
    rows.push(gradientRow(`sign cascade [a > b], every FP32 value, a - b = ${difference}`, cascadeCircuit, cascadeBit, pairWithDifference(difference)))
  }
  const rampCircuit = pixelPair()
  const rampBit = emitGreater(rampCircuit, rampCircuit.source(0), rampCircuit.source(1), {resolution: 1})
  for (const difference of [-0.5, 0.5, 1, 2]) {
    rows.push(gradientRow(`sign cascade at resolution 1 (one clamp), a - b = ${difference}`, rampCircuit, rampBit, pairWithDifference(difference)))
  }
  const roundingCircuit = pixelPair()
  const roundingBit = emitGreaterByRounding(roundingCircuit, roundingCircuit.source(0), roundingCircuit.source(1), {resolution: 2 ** -31})
  rows.push(gradientRow('one rounding stage, a - b = 0.25, no option', roundingCircuit, roundingBit, pairWithDifference(0.25)))
  for (const difference of [-1, 0, 2 ** -10, 0.25, 100]) {
    rows.push(gradientRow(`one rounding stage, straight-through, a - b = ${difference}`, roundingCircuit, roundingBit, pairWithDifference(difference), {booleanGradient: 'straight-through'}))
  }
  const endCircuit = pixelPair()
  const endBit = emitGreaterByRounding(endCircuit, endCircuit.source(0), endCircuit.source(1))
  for (const difference of [-1, smallestSubnormal, 2 ** -130, 2 ** -100, 0.3]) {
    rows.push(gradientRow(`clamp stages + rounding stage, straight-through, a - b = ${difference}`, endCircuit, endBit, pairWithDifference(difference), {booleanGradient: 'straight-through'}))
  }
  const integerCircuit = new Circuit(1)
  integerCircuit.assumeRange(integerCircuit.source(0), -1000, 1000)
  const integerBit = emitAtLeastInteger(integerCircuit, integerCircuit.source(0), 5)
  for (const value of [3, 4, 4.5, 5, 6]) {
    rows.push(gradientRow(`integer bit [value >= 5], value = ${value}`, integerCircuit, integerBit, Float32Array.of(value)))
  }
  printTable('backpropagateReference with gradient 1 on the bit', ['form and input', 'bit', 'gradient on a (or value)', 'gradient on b', 'nonfinite internal gradients', 'largest finite internal |gradient|'], rows)
}

// -----------------------------------------------------------------------------------------------
// A chain of 20 dependent decisions
{
  const itemCount = 20
  const rows: Row[] = []
  for (const form of chainForms) {
    const {circuit, lineWidth} = buildLineFill(form, itemCount)
    const {operations, layers} = measureCost(circuit, [lineWidth])
    const grid = countLineFillMismatches(form, itemCount, 1000, true, 21)
    const float = countLineFillMismatches(form, itemCount, 1000, false, 22)
    rows.push([
      chainFormLabels[form],
      operations,
      layers,
      layers / itemCount,
      `${grid.wrongDecisions} / ${grid.fractionalDecisions} / ${grid.wrongWidths}`,
      `${float.wrongDecisions} / ${float.fractionalDecisions} / ${float.wrongWidths}`,
    ])
  }
  printTable(`Toolbar line fill with ${itemCount} items, each decision reading the width placed so far (1,000 cases each; ${itemCount * 1000} decisions)`, ['form', 'operations', 'layers', 'layers per item', '1/64 px widths: wrong decisions / fractional decisions / wrong final widths', 'arbitrary FP32 widths: wrong decisions / fractional decisions / wrong final widths'], rows)
}

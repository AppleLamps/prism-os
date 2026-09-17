// Equivalence harness. For every trial it samples inputs inside the declared ranges, then runs:
//   1. the compiled circuit through the literal reference evaluator,
//   2. the compiled circuit through the compiled tensor backend,
//   3. the fround twin (FP32 interpreter),
//   4. the float64 interpreter,
//   5. the selected source executed by the JS engine.
// 1, 2 and 3 must agree bit-for-bit on every output (plus or minus zero compare as equal, the
// same equality the repo's differential tests use). 4 must agree with 5 independently of the
// circuit. Precision drift is measured between 3 and 5, not treated as a compiler failure.

import {invariant, validateTensorEvaluation} from '../../src/runtime/numeric-ui-core.ts'
import ts from 'typescript'
import type {FitRelation} from './annotations.ts'
import type {CompiledProgram, FunctionLike} from './compile.ts'
import {Interpreter, type MarginInfo, type RuntimeValue, runtimeObject} from './twin.ts'
import {NativeExecutor} from './native.ts'

export class RandomSource {
  state: number

  constructor(seed: number) {
    this.state = seed | 0
  }

  // Uniform in [0, 1). The repo's LCG.
  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) | 0
    return (this.state >>> 0) / 4_294_967_296
  }
}

export type SampleRange = {minimum: number, maximum: number, integer: boolean}

export type Mismatch = {
  trial: number
  name: string
  referenceValue: number
  tensorValue: number | null
  twinValue: number | null
  inputs: [string, number][]
}

export type EquivalenceReport = {
  trials: number
  outputsChecked: number
  // How many verification legs each output comparison actually had. threeWay compares the
  // reference evaluator, the tensor backend, and the fround twin. Constant-folded outputs have
  // no tensor leg (they never enter the tensor program). A nullable output whose twin is null
  // has no twin leg for its value slot (the circuit's value is arbitrary when the presence bit
  // is 0), leaving reference versus tensor.
  legs: {threeWay: number, withoutTensorLeg: number, withoutTwinLeg: number, referenceOnly: number}
  mismatches: Mismatch[]
  marginViolations: number
  sourceSemantics: {
    outputsChecked: number
    mismatchCount: number
    mismatches: {
      trial: number
      name: string
      interpreterValue: number | null | undefined
      nativeValue: number | null | undefined
      inputs: [string, number][]
    }[]
  }
  drift: {
    outputsCompared: number
    bitEqualCount: number
    maxAbsoluteDrift: number
    maxRelativeDrift: number
    presenceDisagreements: number
  }
}

export type HarnessOptions = {
  trials: number
  seed: number
  // Finite sampling ranges for inputs whose declared range is unbounded (they still validate
  // against the declared range). Keyed by input name.
  sampleRanges?: Record<string, {minimum?: number, maximum?: number}>
  // Overrides the sampler entirely, e.g. for exhaustive sweeps.
  generateInputs?: (trial: number, random: RandomSource) => Map<string, number>
  // Skips trials whose sampled inputs violate cross-input constraints (e.g. "given max >= min").
  acceptInputs?: (values: Map<string, number>) => boolean
}

export function sampleValue(range: SampleRange, random: RandomSource): number {
  invariant(
    Number.isFinite(range.minimum) && Number.isFinite(range.maximum) && range.minimum <= range.maximum,
    `sampling needs a finite range, got ${range.minimum}..${range.maximum}`,
  )
  const pick = random.next()
  // Boundary and integer emphasis: ties and exact hits are where decision bits earn their keep.
  if (pick < 0.04) return range.minimum
  if (pick < 0.08) return range.maximum
  if (pick < 0.12 && range.minimum <= 0 && range.maximum >= 0) return 0
  if (range.integer) {
    const span = Math.floor(range.maximum) - Math.ceil(range.minimum)
    return Math.ceil(range.minimum) + Math.min(span, Math.floor(random.next() * (span + 1)))
  }
  if (pick < 0.2) {
    // An exact integer inside the range, to exercise comparison ties.
    const integer = Math.round(range.minimum + random.next() * (range.maximum - range.minimum))
    if (integer >= range.minimum && integer <= range.maximum) return integer
  }
  return Math.fround(range.minimum + random.next() * (range.maximum - range.minimum))
}

export function marginsByPosition(program: CompiledProgram): Map<string, MarginInfo> {
  const margins = new Map<string, MarginInfo>()
  for (const site of program.comparisonSites) {
    if (site.epsilon === null) continue
    const existing = margins.get(site.positionKey)
    if (existing === undefined || existing.epsilon < site.epsilon) {
      margins.set(site.positionKey, {epsilon: site.epsilon, tieIsTrue: site.tieIsTrue})
    }
  }
  return margins
}

// Flattens an interpreter result into named numeric outputs, mirroring the compiler's output
// flattening. null entries pair with the circuit's nullable encoding (a presence bit + a value).
export function flattenRuntimeOutputs(prefix: string, value: RuntimeValue, out: Map<string, number | null>) {
  if (typeof value === 'number') {
    out.set(prefix, value)
    return
  }
  if (typeof value === 'boolean') {
    out.set(prefix, value ? 1 : 0)
    return
  }
  if (value === null) {
    out.set(prefix, null)
    return
  }
  if (typeof value === 'string') return
  if (value.kind === 'object') {
    for (const [field, fieldValue] of value.fields) flattenRuntimeOutputs(`${prefix}.${field}`, fieldValue, out)
    return
  }
  if (value.kind === 'array') {
    value.elements.forEach((element, index) => flattenRuntimeOutputs(`${prefix}[${index}]`, element, out))
  }
}

// Resolves what the interpreter's outputs say a circuit output should be. Returns 'skip' for a
// nullable value slot whose presence bit is 0 (the circuit's value is arbitrary there).
function expectedValue(name: string, interpreterOutputs: Map<string, number | null>): number | 'skip' {
  if (name.endsWith('.present')) {
    const base = interpreterOutputs.get(name.slice(0, -'.present'.length))
    invariant(base !== undefined, `interpreter did not produce ${name}`)
    return base === null ? 0 : 1
  }
  if (name.endsWith('.value')) {
    const base = interpreterOutputs.get(name.slice(0, -'.value'.length))
    invariant(base !== undefined, `interpreter did not produce ${name}`)
    return base ?? 'skip'
  }
  const value = interpreterOutputs.get(name)
  invariant(value !== undefined && value !== null, `interpreter did not produce ${name}`)
  return value
}

// Turns "given max >= min" style annotations into a sample filter.
export function relationsAccept(relations: FitRelation[]): ((values: Map<string, number>) => boolean) | undefined {
  if (relations.length === 0) return undefined
  return values => {
    for (const relation of relations) {
      const subject = values.get(relation.subject)
      const other = values.get(relation.other)
      if (subject === undefined || other === undefined) continue
      switch (relation.comparison) {
        case '>': if (!(subject > other)) return false; break
        case '>=': if (!(subject >= other)) return false; break
        case '<': if (!(subject < other)) return false; break
        case '<=': if (!(subject <= other)) return false; break
      }
    }
    return true
  }
}

export type TrialRunner = {
  run: (executor: Pick<Interpreter, 'mode' | 'callFunction' | 'runStatements' | 'evaluateExpression'>, values: Map<string, number>) => Map<string, number | null>
}

// Twin setup for a compiled function: rebuild the parameter list (numbers, or objects whose
// fields were declared as dotted inputs), call it, and flatten the return value plus any
// mutated object parameter fields.
export function functionTrialRunner(declaration: FunctionLike, functionName: string): TrialRunner {
  const parameterNames: string[] = []
  for (const parameter of declaration.parameters) {
    invariant(ts.isIdentifier(parameter.name), 'destructured parameters are outside the subset')
    parameterNames.push(parameter.name.text)
  }
  return {
    run: (interpreter, values) => {
      const objectArgs = new Map<string, RuntimeValue & {kind: 'object'}>()
      const args: RuntimeValue[] = parameterNames.map(name => {
        const direct = values.get(name)
        if (direct !== undefined) return direct
        const fields: Record<string, RuntimeValue> = {}
        let found = false
        for (const [inputName, value] of values) {
          if (inputName.startsWith(`${name}.`)) {
            fields[inputName.slice(name.length + 1)] = value
            found = true
          }
        }
        invariant(found, `no input values for parameter ${name}`)
        const objectValue = runtimeObject(fields)
        objectArgs.set(name, objectValue)
        return objectValue
      })
      const returned = interpreter.callFunction(functionName, args)
      const outputs = new Map<string, number | null>()
      flattenRuntimeOutputs('return', returned, outputs)
      for (const [name, objectValue] of objectArgs) flattenRuntimeOutputs(name, objectValue, outputs)
      return outputs
    },
  }
}

export function runEquivalence(
  program: CompiledProgram,
  sourceFile: ts.SourceFile,
  runner: TrialRunner,
  options: HarnessOptions,
): EquivalenceReport {
  const random = new RandomSource(options.seed)
  const circuit = program.circuit
  const outputWires = [...new Set(
    program.outputs.flatMap(output => (output.num.kind === 'wire' ? [output.num.wire] : [])),
  )]
  if (outputWires.length > 0) {
    circuit.tensorProgram = circuit.compileTensorProgram(outputWires)
  }

  const twin = new Interpreter(sourceFile, 'fp32', marginsByPosition(program))
  const original = new Interpreter(sourceFile, 'fp64')
  const native = new NativeExecutor(sourceFile)

  const sampleRangeFor = (name: string, spec: SampleRange): SampleRange => {
    const override = options.sampleRanges?.[name]
    return {
      minimum: Math.max(spec.minimum, override?.minimum ?? spec.minimum),
      maximum: Math.min(spec.maximum, override?.maximum ?? spec.maximum),
      integer: spec.integer,
    }
  }

  const report: EquivalenceReport = {
    trials: options.trials,
    outputsChecked: 0,
    legs: {threeWay: 0, withoutTensorLeg: 0, withoutTwinLeg: 0, referenceOnly: 0},
    mismatches: [],
    marginViolations: 0,
    sourceSemantics: {outputsChecked: 0, mismatchCount: 0, mismatches: []},
    drift: {
      outputsCompared: 0,
      bitEqualCount: 0,
      maxAbsoluteDrift: 0,
      maxRelativeDrift: 0,
      presenceDisagreements: 0,
    },
  }

  for (let trial = 0; trial < options.trials; trial++) {
    let values: Map<string, number>
    if (options.generateInputs !== undefined) {
      values = options.generateInputs(trial, random)
    } else {
      let attempts = 0
      do {
        invariant(attempts++ < 10_000, 'input constraints rejected too many samples')
        values = new Map()
        for (const input of program.inputs) {
          const sampled = sampleValue(sampleRangeFor(input.name, input.spec), random)
          values.set(input.name, input.spec.integer ? sampled : Math.fround(sampled))
        }
      } while (options.acceptInputs !== undefined && !options.acceptInputs(values))
    }

    const source = new Float32Array(circuit.sourceSize)
    source[program.oneWire] = 1
    for (const input of program.inputs) {
      const value = values.get(input.name)
      invariant(value !== undefined, `no sampled value for input ${input.name}`)
      source[input.wire] = value
    }

    const referenceValues = circuit.evaluateReference(source)
    let tensorValues: Float32Array | null = null
    if (outputWires.length > 0) {
      tensorValues = circuit.evaluateTensor(source)
      if (trial < 3) validateTensorEvaluation(source, circuit, tensorValues)
    }

    const twinInputs = new Map([...values].map(([name, value]) => [name, Math.fround(value)]))
    const twinOutputs = runner.run(twin, twinInputs)
    const originalOutputs = runner.run(original, values)
    const nativeOutputs = runner.run(native, values)
    for (const name of new Set([...originalOutputs.keys(), ...nativeOutputs.keys()])) {
      const interpreterValue = originalOutputs.get(name)
      const nativeValue = nativeOutputs.get(name)
      report.sourceSemantics.outputsChecked++
      if (interpreterValue === nativeValue || Object.is(interpreterValue, nativeValue)) continue
      report.sourceSemantics.mismatchCount++
      if (report.sourceSemantics.mismatches.length < 10) {
        report.sourceSemantics.mismatches.push({trial, name, interpreterValue, nativeValue, inputs: [...values]})
      }
    }

    for (const output of program.outputs) {
      const referenceValue = output.num.kind === 'constant' ? output.num.value : referenceValues[output.num.wire]!
      const tensorValue = output.num.kind === 'constant' || tensorValues === null
        ? null
        : tensorValues[output.num.wire]!
      const twinExpected = expectedValue(output.name, twinOutputs)
      report.outputsChecked++
      const hasTensorLeg = tensorValue !== null
      const hasTwinLeg = twinExpected !== 'skip'
      if (hasTensorLeg && hasTwinLeg) report.legs.threeWay++
      else if (hasTensorLeg) report.legs.withoutTwinLeg++
      else if (hasTwinLeg) report.legs.withoutTensorLeg++
      else report.legs.referenceOnly++
      const tensorAgrees = tensorValue === null || tensorValue === referenceValue
      const twinAgrees = twinExpected === 'skip' || twinExpected === referenceValue
      if (!tensorAgrees || !twinAgrees) {
        if (report.mismatches.length < 10) {
          report.mismatches.push({
            trial,
            name: output.name,
            referenceValue,
            tensorValue,
            twinValue: twinExpected === 'skip' ? null : twinExpected,
            inputs: [...values.entries()],
          })
        }
        continue
      }

      // Drift against native JS is separate from source-interpreter correctness.
      const originalExpected = expectedValue(output.name, nativeOutputs)
      if (output.name.endsWith('.present')) {
        if (twinExpected !== originalExpected) report.drift.presenceDisagreements++
        continue
      }
      if (twinExpected === 'skip' || originalExpected === 'skip') {
        if ((twinExpected === 'skip') !== (originalExpected === 'skip')) report.drift.presenceDisagreements++
        continue
      }
      report.drift.outputsCompared++
      if (Math.fround(originalExpected) === twinExpected) report.drift.bitEqualCount++
      const absolute = Math.abs(twinExpected - originalExpected)
      if (absolute > report.drift.maxAbsoluteDrift) report.drift.maxAbsoluteDrift = absolute
      const relative = absolute / Math.max(Math.abs(originalExpected), 1e-30)
      if (relative > report.drift.maxRelativeDrift) report.drift.maxRelativeDrift = relative
    }
  }

  report.marginViolations = twin.marginViolations.length
  return report
}

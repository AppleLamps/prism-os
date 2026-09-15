// Runs a UI's trace once with the stored interpreter and once per perturbed
// mode, and counts what changes.
//
// - The stored run records every source table the app evaluates, classifies rows
//   and outputs (rows that are always exact bits, outputs that are always
//   integers, source cells that are always integers), and checks the stored
//   interpreter against the production executor on every evaluated root.
// - A mode run replays the app with the mode driving its own state (closed loop).
//   On call k it also evaluates the stored interpreter and the mode on the stored
//   run's k-th source table, so the same pass measures the open loop (same inputs,
//   perturbed arithmetic) and the closed loop (the mode's own state).
import type {Circuit, Wire} from '../../../numeric-ui-core.ts'
import {createWorkspace, evaluate, installInterpreter, type EvaluationCall, type Mode, type ModeProgram, type Workspace} from './interpreter.ts'

// How the host reads a settle output: the exact value, or only whether it's
// positive (IndirectOS requests another frame when animationActive > 0).
export type NamedWires = {name: string, wires: readonly Wire[], decision?: 'exact' | 'positive'}

export type WorkloadInstance = {
  circuit: Circuit
  // Continuous outputs whose drift is reported in px. Wires that are integers in
  // every stored evaluation are left out.
  drift: NamedWires[]
  // Settle and animation bits.
  settle: NamedWires[]
  // Next-source wire per source cell, for tracing drift across frames.
  nextSource?: readonly (readonly [cell: number, wire: Wire])[]
  // Runs the trace and returns the prototype's own checks against its independent reference.
  run: () => Record<string, number>
}

export type Workload = {
  name: string
  description: string
  create: () => WorkloadInstance
}

export type LoopCounts = {
  booleansChecked: number
  booleanFlips: number
  // Rows that are exact bits in every stored evaluation and take both values.
  bitRowsChecked: number
  // The mode returned the other bit.
  bitRowFlips: number
  // The mode returned a value that isn't 0 or 1, and the largest distance from the stored bit.
  bitRowNonBits: number
  bitRowLargestNonBitDistance: number
  gatherIndicesChecked: number
  gatherIndexFlips: number
  // Evaluated roots that are integers in every stored evaluation: next-source
  // bits and counts, cursor codes, slot indices, and similar decisions.
  decisionOutputsChecked: number
  decisionOutputFlips: number
  settleChecked: number
  settleFlips: number
  framesWithDecisionFlips: number
  maximumDrift: number
  maximumDriftWhere: string
  driftByName: Record<string, number>
}

export type OpenLoop = LoopCounts & {liveValuesChecked: number, liveValuesDiffering: number}

export type ClosedLoop = LoopCounts & {
  // Calls where some always-integer source cell differs from the stored run's table.
  divergenceFrames: number
  firstDivergenceFrame: number
  integerStateCellFlips: number
  maximumContinuousStateDrift: number
  rangeViolationFrames: number
  callsCompared: number
  extraCalls: number
}

export type ModeResult = {
  mode: Mode
  openLoop: OpenLoop
  closedLoop: ClosedLoop
  reference: Record<string, number> | {error: string}
  milliseconds: number
}

export type ProgramStructure = {
  liveOperations: number
  layers: number
  storedWeights: number
  rows: number
  booleanRows: number
  gatherSlots: number
  roundingPointRows: number
  roundingPointFraction: number
  seeds: ModeProgram['points']['seeds']
  orderSensitiveRows: number
  orderSensitiveRoundingPoints: number
  bitRows: number
  decisionOutputs: number
}

export type WorkloadResult = {
  name: string
  description: string
  calls: number
  structure: ProgramStructure
  storedCheck: {rootsChecked: number, mismatches: number}
  reference: Record<string, number>
  modes: ModeResult[]
}

type Classification = {
  modeProgram: ModeProgram
  bitRows: Int32Array
  booleanRows: Int32Array
  decisionPositions: Int32Array
  settlePositions: {name: string, positions: Int32Array, decision: 'exact' | 'positive'}[]
  driftPositions: {name: string, positions: Int32Array}[]
  integerSourceCells: Int32Array
  continuousSourceCells: Int32Array
}

export type StoredRecording = {
  sources: Float32Array[]
  modeProgram: ModeProgram
  classification: Classification
}

function emptyCounts(): LoopCounts {
  return {
    booleansChecked: 0, booleanFlips: 0, bitRowsChecked: 0, bitRowFlips: 0, bitRowNonBits: 0, bitRowLargestNonBitDistance: 0, gatherIndicesChecked: 0, gatherIndexFlips: 0,
    decisionOutputsChecked: 0, decisionOutputFlips: 0, settleChecked: 0, settleFlips: 0, framesWithDecisionFlips: 0,
    maximumDrift: 0, maximumDriftWhere: '', driftByName: {},
  }
}

export function structureOf(modeProgram: ModeProgram): Omit<ProgramStructure, 'bitRows' | 'decisionOutputs'> {
  const {program, packed, points} = modeProgram
  let booleanRows = 0
  for (let row = 0; row < packed.rowCount; row++) if (packed.kind[row] === 2) booleanRows++
  return {
    liveOperations: packed.valueCount - packed.sourceSize,
    layers: program.layers.length,
    storedWeights: packed.storedWeights,
    rows: packed.rowCount,
    booleanRows,
    gatherSlots: packed.gatherSlotCount,
    roundingPointRows: points.roundingPointRows,
    roundingPointFraction: points.roundingPointRows / packed.rowCount,
    seeds: points.seeds,
    orderSensitiveRows: points.orderSensitiveRows,
    orderSensitiveRoundingPoints: points.orderSensitiveRoundingPoints,
  }
}

// Stored run: record source tables, classify rows, and check the stored
// interpreter against the production executor on every root.
export function recordStored(instance: WorkloadInstance): {recording: StoredRecording, reference: Record<string, number>, storedCheck: WorkloadResult['storedCheck']} {
  const sources: Float32Array[] = []
  let modeProgram: ModeProgram | null = null
  let alwaysBit: Uint8Array | null = null
  let sawZero: Uint8Array | null = null
  let sawOne: Uint8Array | null = null
  let alwaysIntegerValue: Uint8Array | null = null
  let alwaysIntegerSource: Uint8Array | null = null
  let rootsChecked = 0
  let mismatches = 0
  let originalEvaluator: ((source: Float32Array) => Float32Array) | null = null
  let rootPositions: Int32Array | null = null
  const {original, restore} = installInterpreter(instance.circuit, {
    mode: 'stored',
    onEvaluate: (call: EvaluationCall) => {
      if (modeProgram === null) {
        modeProgram = call.modeProgram
        alwaysBit = new Uint8Array(call.modeProgram.packed.valueCount).fill(1)
        sawZero = new Uint8Array(call.modeProgram.packed.valueCount)
        sawOne = new Uint8Array(call.modeProgram.packed.valueCount)
        alwaysIntegerValue = new Uint8Array(call.modeProgram.packed.valueCount).fill(1)
        alwaysIntegerSource = new Uint8Array(call.modeProgram.packed.sourceSize).fill(1)
        const roots = [...call.modeProgram.program.roots]
        originalEvaluator = original.createTensorEvaluator(roots)
        rootPositions = Int32Array.from(roots, root => call.modeProgram.packed.flat.positionOfWire[root]!)
      }
      if (call.modeProgram !== modeProgram) throw new Error('a workload may evaluate only one compiled program')
      const source = new Float32Array(call.source)
      sources.push(source)
      const {values} = call
      for (let position = 0; position < values.length; position++) {
        const value = values[position]!
        if (value === 0) sawZero![position] = 1
        else if (value === 1) sawOne![position] = 1
        else alwaysBit![position] = 0
        if (!Number.isInteger(value)) alwaysIntegerValue![position] = 0
      }
      for (let cell = 0; cell < source.length; cell++) if (!Number.isInteger(source[cell]!)) alwaysIntegerSource![cell] = 0
      const expected = originalEvaluator!(source)
      for (let index = 0; index < rootPositions!.length; index++) {
        rootsChecked++
        if (!Object.is(expected[index], Math.fround(values[rootPositions![index]!]!))) mismatches++
      }
    },
  })
  let reference: Record<string, number>
  try {
    reference = instance.run()
  } finally {
    restore()
  }
  if (modeProgram === null) throw new Error(`workload evaluated nothing`)
  const program: ModeProgram = modeProgram
  const {packed} = program
  const positionsOf = (wires: readonly Wire[], filterIntegers: boolean) => Int32Array.from(
    wires.map(wire => packed.flat.positionOfWire[wire]!).filter(position => position >= 0 && !(filterIntegers && alwaysIntegerValue![position] === 1)),
  )
  const bitRows: number[] = []
  const booleanRows: number[] = []
  for (let row = 0; row < packed.rowCount; row++) {
    if (packed.kind[row] === 2) booleanRows.push(row)
    const position = packed.position[row]!
    if (alwaysBit![position] === 1 && sawZero![position] === 1 && sawOne![position] === 1) bitRows.push(row)
  }
  const decisionPositions = [...new Set(program.program.roots)].map(root => packed.flat.positionOfWire[root]!).filter(position => alwaysIntegerValue![position] === 1)
  const integerSourceCells: number[] = []
  const continuousSourceCells: number[] = []
  for (let cell = 0; cell < packed.sourceSize; cell++) (alwaysIntegerSource![cell] === 1 ? integerSourceCells : continuousSourceCells).push(cell)
  const classification: Classification = {
    modeProgram: program,
    bitRows: Int32Array.from(bitRows),
    booleanRows: Int32Array.from(booleanRows),
    decisionPositions: Int32Array.from(decisionPositions),
    settlePositions: instance.settle.map(group => ({name: group.name, positions: positionsOf(group.wires, false), decision: group.decision ?? 'exact'})),
    driftPositions: instance.drift.map(group => ({name: group.name, positions: positionsOf(group.wires, true)})),
    integerSourceCells: Int32Array.from(integerSourceCells),
    continuousSourceCells: Int32Array.from(continuousSourceCells),
  }
  return {recording: {sources, modeProgram: program, classification}, reference, storedCheck: {rootsChecked, mismatches}}
}

function compareInto(
  counts: LoopCounts,
  classification: Classification,
  frame: number,
  values: Float64Array,
  valuesWorkspace: Workspace,
  reference: Float64Array,
  referenceWorkspace: Workspace,
) {
  const {packed} = classification.modeProgram
  // Decisions are compared as the FP32 values the host and the next frame would
  // store, so a float64 integer like 1234.000000001 isn't counted as a flip.
  const f = Math.fround
  let flips = 0
  for (const row of classification.booleanRows) {
    const position = packed.position[row]!
    counts.booleansChecked++
    if (f(values[position]!) !== reference[position]) counts.booleanFlips++
  }
  for (const row of classification.bitRows) {
    const position = packed.position[row]!
    counts.bitRowsChecked++
    const value = f(values[position]!)
    if (value === reference[position]) continue
    if (value === 0 || value === 1) {
      counts.bitRowFlips++
      flips++
    } else {
      counts.bitRowNonBits++
      counts.bitRowLargestNonBitDistance = Math.max(counts.bitRowLargestNonBitDistance, Math.abs(value - reference[position]!))
    }
  }
  for (let slot = 0; slot < packed.gatherSlotCount; slot++) {
    counts.gatherIndicesChecked++
    if (valuesWorkspace.gatherIndex[slot] !== referenceWorkspace.gatherIndex[slot]) {
      counts.gatherIndexFlips++
      flips++
    }
  }
  for (const position of classification.decisionPositions) {
    counts.decisionOutputsChecked++
    if (f(values[position]!) !== reference[position]) {
      counts.decisionOutputFlips++
      flips++
    }
  }
  for (const group of classification.settlePositions) {
    for (const position of group.positions) {
      counts.settleChecked++
      const differs = group.decision === 'positive'
        ? (values[position]! > 0) !== (reference[position]! > 0)
        : f(values[position]!) !== reference[position]
      if (differs) counts.settleFlips++
    }
  }
  if (flips > 0) counts.framesWithDecisionFlips++
  for (const group of classification.driftPositions) {
    let groupMaximum = counts.driftByName[group.name] ?? 0
    for (const position of group.positions) {
      const drift = Math.abs(Math.fround(values[position]!) - reference[position]!)
      if (!(drift <= groupMaximum)) groupMaximum = Number.isNaN(drift) ? Infinity : drift
      if (!(drift <= counts.maximumDrift)) {
        counts.maximumDrift = Number.isNaN(drift) ? Infinity : drift
        counts.maximumDriftWhere = `frame ${frame}, ${group.name}, wire ${packed.flat.wireOrder[position]}: ${Math.fround(values[position]!)} against ${reference[position]}`
      }
    }
    counts.driftByName[group.name] = groupMaximum
  }
}

export type ModeRunOptions = {
  // Called on every compared call, e.g. to trace drift.
  onCall?: (context: {frame: number, modeSource: Float32Array, storedSource: Float32Array, modeValues: Float64Array, storedValues: Float64Array, openValues: Float64Array}) => void
}

export function runMode(workload: Workload, recording: StoredRecording, mode: Mode, options: ModeRunOptions = {}): ModeResult {
  const start = performance.now()
  const instance = workload.create()
  const openLoop: OpenLoop = {...emptyCounts(), liveValuesChecked: 0, liveValuesDiffering: 0}
  const closedLoop: ClosedLoop = {
    ...emptyCounts(), divergenceFrames: 0, firstDivergenceFrame: -1, integerStateCellFlips: 0, maximumContinuousStateDrift: 0,
    rangeViolationFrames: 0, callsCompared: 0, extraCalls: 0,
  }
  const {classification} = recording
  const {packed, rules} = recording.modeProgram
  const referenceWorkspace = createWorkspace(packed)
  const openWorkspace = createWorkspace(packed)
  let frame = 0
  const {restore} = installInterpreter(instance.circuit, {
    mode,
    onEvaluate: call => {
      if (frame >= recording.sources.length) {
        closedLoop.extraCalls++
        frame++
        return
      }
      const storedSource = recording.sources[frame]!
      const storedValues = evaluate(packed, rules.stored, storedSource, referenceWorkspace)
      const openValues = evaluate(packed, rules[mode], storedSource, openWorkspace)
      compareInto(openLoop, classification, frame, openValues, openWorkspace, storedValues, referenceWorkspace)
      for (let position = packed.sourceSize; position < packed.valueCount; position++) {
        openLoop.liveValuesChecked++
        if (openValues[position] !== storedValues[position]) openLoop.liveValuesDiffering++
      }
      compareInto(closedLoop, classification, frame, call.values, call.workspace, storedValues, referenceWorkspace)
      closedLoop.callsCompared++
      let stateFlips = 0
      for (const cell of classification.integerSourceCells) if (call.source[cell] !== storedSource[cell]) stateFlips++
      closedLoop.integerStateCellFlips += stateFlips
      if (stateFlips > 0) {
        closedLoop.divergenceFrames++
        if (closedLoop.firstDivergenceFrame < 0) closedLoop.firstDivergenceFrame = frame
      }
      for (const cell of classification.continuousSourceCells) {
        const drift = Math.abs(call.source[cell]! - storedSource[cell]!)
        if (!(drift <= closedLoop.maximumContinuousStateDrift)) closedLoop.maximumContinuousStateDrift = Number.isNaN(drift) ? Infinity : drift
      }
      const {ranges} = instance.circuit
      for (let cell = 0; cell < packed.sourceSize; cell++) {
        const value = call.source[cell]!
        if (!(value >= ranges[cell]!.minimum && value <= ranges[cell]!.maximum)) {
          closedLoop.rangeViolationFrames++
          break
        }
      }
      options.onCall?.({frame, modeSource: call.source, storedSource, modeValues: call.values, storedValues, openValues})
      frame++
    },
  })
  let reference: ModeResult['reference']
  try {
    reference = instance.run()
  } catch (error) {
    reference = {error: String(error)}
  } finally {
    restore()
  }
  return {mode, openLoop, closedLoop, reference, milliseconds: performance.now() - start}
}

export function runWorkload(workload: Workload, modesToRun: readonly Mode[], log: (line: string) => void = () => {}): WorkloadResult {
  const stored = recordStored(workload.create())
  const {classification} = stored.recording
  const result: WorkloadResult = {
    name: workload.name,
    description: workload.description,
    calls: stored.recording.sources.length,
    structure: {...structureOf(stored.recording.modeProgram), bitRows: classification.bitRows.length, decisionOutputs: classification.decisionPositions.length},
    storedCheck: stored.storedCheck,
    reference: stored.reference,
    modes: [],
  }
  log(`${workload.name}: ${result.calls} calls, ${result.structure.liveOperations} live ops, stored check ${stored.storedCheck.mismatches} of ${stored.storedCheck.rootsChecked}`)
  for (const mode of modesToRun) {
    const modeResult = runMode(workload, stored.recording, mode)
    result.modes.push(modeResult)
    log(`  ${mode}: open booleans ${modeResult.openLoop.booleanFlips}, bits ${modeResult.openLoop.bitRowFlips} (non-bits ${modeResult.openLoop.bitRowNonBits}), gather ${modeResult.openLoop.gatherIndexFlips}, decisions ${modeResult.openLoop.decisionOutputFlips}, drift ${modeResult.openLoop.maximumDrift.toPrecision(3)}; closed divergence ${modeResult.closedLoop.divergenceFrames}, drift ${modeResult.closedLoop.maximumDrift.toPrecision(3)}; ${modeResult.milliseconds.toFixed(0)} ms`)
  }
  return result
}

// ----- Tracing a difference back to where it starts -----

export type TraceStep = {
  position: number
  wire: number
  kind: string
  preserveRounding: boolean
  macro: string
  bias: number
  gateBias: number
  a: number
  b: number
  difference: number
  // The input with the largest contribution to this row's difference.
  largestInput: {side: 'left' | 'gate' | 'candidate', weight: number, position: number, a: number, b: number, contribution: number} | null
  terms: {weight: number, a: number, b: number}[]
  gateTerms: {weight: number, a: number, b: number}[]
}

const kindNames = ['affine', 'reglu', 'boolean', 'gather']

// Walks back from a packed position through the input whose weighted difference
// is largest, until reaching a row whose inputs are all equal (the difference
// starts in that row's own arithmetic) or a source cell.
export function traceDifference(circuit: Circuit, modeProgram: ModeProgram, a: Float64Array, b: Float64Array, position: number, maximumSteps = 60): {steps: TraceStep[], endsAtSourceCell: number} {
  const {packed} = modeProgram
  const steps: TraceStep[] = []
  let current = position
  for (let step = 0; step < maximumSteps; step++) {
    if (current < packed.sourceSize) return {steps, endsAtSourceCell: current}
    const row = packed.rowOfPosition[current]!
    const wire = packed.flat.wireOrder[current]!
    const operation = circuit.operations[wire - circuit.sourceSize]!
    const left = () => {
      let total = packed.bias[row]!
      for (let term = packed.leftStart[row]!; term < packed.leftEnd[row]!; term++) total += packed.weights[term]! * b[packed.inputs[term]!]!
      return total
    }
    const gate = () => {
      let total = packed.gateBias[row]!
      for (let term = packed.gateStart[row]!; term < packed.gateEnd[row]!; term++) total += packed.weights[term]! * b[packed.inputs[term]!]!
      return total
    }
    const isReglu = packed.kind[row] === 1
    const gateValue = isReglu ? Math.max(0, gate()) : 1
    const leftValue = isReglu ? left() : 1
    let largest: TraceStep['largestInput'] = null
    const consider = (side: 'left' | 'gate' | 'candidate', weight: number, input: number, scale: number) => {
      const contribution = Math.abs(weight * (a[input]! - b[input]!) * scale)
      if (contribution > 0 && (largest === null || contribution > largest.contribution)) {
        largest = {side, weight, position: input, a: a[input]!, b: b[input]!, contribution}
      }
    }
    for (let term = packed.leftStart[row]!; term < packed.leftEnd[row]!; term++) consider('left', packed.weights[term]!, packed.inputs[term]!, gateValue)
    for (let term = packed.gateStart[row]!; term < packed.gateEnd[row]!; term++) consider('gate', packed.weights[term]!, packed.inputs[term]!, Math.abs(leftValue))
    if (packed.kind[row] === 3) {
      for (let candidate = packed.candidateStart[row]!; candidate < packed.candidateEnd[row]!; candidate++) consider('candidate', 1, packed.candidates[candidate]!, 1)
    }
    const termsOf = (start: number, end: number) => Array.from({length: end - start}, (_, index) => ({weight: packed.weights[start + index]!, a: a[packed.inputs[start + index]!]!, b: b[packed.inputs[start + index]!]!}))
    steps.push({
      position: current,
      wire,
      kind: kindNames[packed.kind[row]!]!,
      preserveRounding: operation.preserveRounding === true,
      macro: operation.macro === undefined ? '' : operation.macro.kind,
      bias: packed.bias[row]!,
      gateBias: packed.gateBias[row]!,
      a: a[current]!,
      b: b[current]!,
      difference: a[current]! - b[current]!,
      largestInput: largest,
      terms: termsOf(packed.leftStart[row]!, packed.leftEnd[row]!).slice(0, 12),
      gateTerms: termsOf(packed.gateStart[row]!, packed.gateEnd[row]!).slice(0, 12),
    })
    const next: TraceStep['largestInput'] = largest
    if (next === null) return {steps, endsAtSourceCell: -1}
    current = (next as {position: number}).position
  }
  return {steps, endsAtSourceCell: -1}
}

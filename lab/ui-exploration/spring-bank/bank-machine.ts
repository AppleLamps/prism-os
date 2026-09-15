// A standalone spring bank: a source table with a clock, one frame matrix per
// group, and boxes of lanes whose destinations JS writes. Tests and the
// predictive keyframes demo build on it.
import {Circuit, type Wire, invariant, validateCircuit, validateTensorProgram} from '../../../numeric-ui-core.ts'
import {
  type SpringGroup,
  type SpringPowers,
  type WireMatrix,
  createConstantPowerGroup,
  createSourceMatrixGroup,
  createSourceTableGroup,
  createSpringClock,
  emitSpringBox,
  frameMatrixBound,
  powerTables,
} from './spring-bank.ts'
import {
  type RetargetTiming,
  type SpringClockConfig,
  type SpringConstants,
  advanceReferenceClock,
  createFrameDeltaTracker,
  defaultClockConfig,
  eulerStepMatrix,
  matrixPower,
} from './spring-math.ts'

export type BankSpec = {
  groups: readonly SpringConstants[]
  boxes: readonly {lanes: readonly {group: number}[]}[]
}

export type BankOptions = {
  powers: SpringPowers
  retarget: RetargetTiming
  config?: SpringClockConfig
  // Runtime tables and matrices must stay within this magnitude.
  runtimeBound?: number
}

export const laneField = {
  position: 0,
  velocity: 1,
  destination: 2,
  previousDestination: 3,
  size: 4,
} as const

export const bankField = {
  unit: 0,
  frameDeltaMs: 1,
  leftoverMs: 2,
  running: 3,
  settleDistance: 4,
  settleSpeed: 5,
  groupStart: 6,
} as const

export function createBankMachine(spec: BankSpec, options: BankOptions) {
  const config = options.config ?? defaultClockConfig
  const runtimeBound = options.runtimeBound ?? 256
  const coarseCount = Math.floor(config.maxSteps / config.fineSteps) + 1
  const cellsPerGroup = options.powers === 'source-matrix'
    ? 4
    : options.powers === 'source-table'
      ? 4 * (coarseCount + config.fineSteps)
      : 0
  const laneStart = bankField.groupStart + spec.groups.length * cellsPerGroup
  const laneCount = spec.boxes.reduce((total, box) => total + box.lanes.length, 0)
  const sourceSize = laneStart + laneCount * laneField.size
  const groupCell = (group: number, offset: number) => bankField.groupStart + group * cellsPerGroup + offset
  const laneCell = (lane: number, field: number) => laneStart + lane * laneField.size + field

  const circuit = new Circuit(sourceSize)
  const unit = bankField.unit
  circuit.assumeRange(unit, 1, 1)
  circuit.assumeRange(bankField.settleDistance, 0, 1)
  circuit.assumeRange(bankField.settleSpeed, 0, 1)

  const clock = options.powers === 'source-matrix'
    ? undefined
    : createSpringClock(circuit, {
        frameDeltaMs: bankField.frameDeltaMs,
        leftoverMs: bankField.leftoverMs,
        running: bankField.running,
        unit,
      }, config)
  if (clock === undefined) circuit.assumeRange(bankField.running, 0, 1)

  const matrixCells = (group: number, start: number): WireMatrix =>
    [groupCell(group, start), groupCell(group, start + 1), groupCell(group, start + 2), groupCell(group, start + 3)]
  const groups: SpringGroup[] = spec.groups.map((constants, group) => {
    if (options.powers === 'source-matrix') return createSourceMatrixGroup(circuit, matrixCells(group, 0), runtimeBound)
    invariant(clock !== undefined, 'constant and table powers need the circuit clock')
    if (options.powers === 'source-table') {
      return createSourceTableGroup(circuit, clock, {
        coarse: Array.from({length: coarseCount}, (_, index) => matrixCells(group, 4 * index)),
        fine: Array.from({length: config.fineSteps}, (_, index) => matrixCells(group, 4 * (coarseCount + index))),
      }, runtimeBound)
    }
    return createConstantPowerGroup(circuit, clock, constants, options.powers)
  })

  const nextSource: Wire[] = Array.from({length: sourceSize}, (_, wire) => wire)
  const positions: Wire[] = []
  const velocities: Wire[] = []
  const boxActive: Wire[] = []
  let lane = 0
  for (const box of spec.boxes) {
    const laneIndices = box.lanes.map(() => lane++)
    const result = emitSpringBox(circuit, box.lanes.map((laneSpec, index) => ({
      group: groups[laneSpec.group]!,
      position: laneCell(laneIndices[index]!, laneField.position),
      velocity: laneCell(laneIndices[index]!, laneField.velocity),
      destination: laneCell(laneIndices[index]!, laneField.destination),
      previousDestination: laneCell(laneIndices[index]!, laneField.previousDestination),
    })), {
      unit,
      settleDistance: bankField.settleDistance,
      settleSpeed: bankField.settleSpeed,
      retarget: options.retarget,
    })
    laneIndices.forEach((laneIndex, index) => {
      positions.push(result.positions[index]!)
      velocities.push(result.velocities[index]!)
      nextSource[laneCell(laneIndex, laneField.position)] = result.positions[index]!
      nextSource[laneCell(laneIndex, laneField.velocity)] = result.velocities[index]!
      nextSource[laneCell(laneIndex, laneField.previousDestination)] = result.nextPreviousDestinations[index]!
    })
    boxActive.push(result.active)
  }
  const activeSum = circuit.affine(boxActive.map(active => [active, 1]))
  const animationActive = circuit.affine([
    [circuit.reglu([], 1, [[activeSum, 1]], 0), 1],
    [circuit.reglu([], 1, [[activeSum, 1]], -1), -1],
  ])
  circuit.assumeRange(animationActive, 0, 1)
  nextSource[bankField.running] = animationActive
  nextSource[bankField.frameDeltaMs] = circuit.affine([])
  if (clock !== undefined) nextSource[bankField.leftoverMs] = clock.nextLeftoverMs

  const roots = [...nextSource, ...positions, ...velocities, ...boxActive, animationActive]
  if (clock !== undefined) roots.push(clock.stepCount)
  validateCircuit(circuit)
  const program = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, program)
  circuit.tensorProgram = program
  const evaluate = circuit.createTensorEvaluator(roots)
  const output = {
    positionStart: sourceSize,
    velocityStart: sourceSize + laneCount,
    boxActiveStart: sourceSize + 2 * laneCount,
    animationActive: sourceSize + 2 * laneCount + spec.boxes.length,
    stepCount: clock === undefined ? -1 : sourceSize + 2 * laneCount + spec.boxes.length + 1,
  }

  const source = new Float32Array(sourceSize)
  source[unit] = 1
  source[bankField.settleDistance] = 0.01
  source[bankField.settleSpeed] = 0.01
  const groupConstants = spec.groups.map(constants => ({...constants}))

  function writeGroupTables(group: number) {
    if (options.powers !== 'source-table') return
    const tables = powerTables(groupConstants[group]!, config)
    const cells = [...tables.coarse, ...tables.fine]
    cells.forEach((matrix, index) => {
      invariant(matrix.every(entry => Math.abs(entry) <= runtimeBound), 'power table entry exceeds its declared bound')
      for (let entry = 0; entry < 4; entry++) source[groupCell(group, 4 * index + entry)] = matrix[entry]!
    })
  }
  spec.groups.forEach((_, group) => writeGroupTables(group))
  const frameDelta = createFrameDeltaTracker(config)

  // Source-matrix hosts compute the step count here and write M^steps.
  function writeHostFrame(source: Float32Array, frameDeltaMs: number) {
    const {steps, leftoverMs} = advanceReferenceClock({
      leftoverMs: source[bankField.leftoverMs]!,
      running: source[bankField.running]! > 0,
    }, frameDeltaMs, config)
    source[bankField.leftoverMs] = leftoverMs
    groupConstants.forEach((constants, group) => {
      const frame = matrixPower(eulerStepMatrix(constants, config.stepMs), steps)
      for (let entry = 0; entry < 4; entry++) source[groupCell(group, entry)] = frame[entry]!
    })
    return steps
  }

  function evaluateFrame(table: Float32Array, frameDeltaMs: number) {
    if (options.powers === 'source-matrix') writeHostFrame(table, frameDeltaMs)
    else table[bankField.frameDeltaMs] = frameDeltaMs
    return evaluate(table)
  }

  return {
    circuit,
    program,
    source,
    spec,
    options,
    config,
    output,
    laneCount,
    laneCell,
    groupCell,
    evaluate,
    boundForConstants: (constants: SpringConstants) => frameMatrixBound(constants, config),
    step(frameTime: number) {
      const values = evaluateFrame(source, frameDelta(frameTime))
      for (let wire = 0; wire < sourceSize; wire++) source[wire] = values[wire]!
      return values
    },
    // Evaluate a copy of `table` as if `frameDeltaMs` had passed, without
    // touching the machine's own state.
    evaluateFrame,
    setDestination(laneIndex: number, destination: number) {
      source[laneCell(laneIndex, laneField.destination)] = destination
    },
    setGroupConstants(group: number, constants: SpringConstants) {
      invariant(options.powers === 'source-table' || options.powers === 'source-matrix', 'constant powers are fixed at build time')
      groupConstants[group] = {...constants}
      writeGroupTables(group)
    },
  }
}

export type BankMachine = ReturnType<typeof createBankMachine>

import {
  Circuit,
  type Wire,
  emitMultiply,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
  asWire,
} from '../../src/runtime/numeric-ui-core.ts'

export const inputNames = ['pointerX', 'panelLeft', 'scale', 'distractor'] as const
export type InputName = (typeof inputNames)[number]

export const operationNames = ['add', 'subtract', 'multiply'] as const
export type OperationName = (typeof operationNames)[number]

export type CoordinateInputs = Record<InputName, number>

export type InstructionCandidate = {
  operation: OperationName
  leftRegister: number
  rightRegister: number
}

export type ProgramGroup = {
  name: string
  sourceWires: Wire[]
  parameterOffset: number
  candidates: InstructionCandidate[]
}

export type ProgramLayout = {
  sourceSize: number
  programCellCount: number
  inputWires: Wire[]
  instructionGroups: ProgramGroup[]
}

export type ProgramBuild = {
  circuit: Circuit
  layout: ProgramLayout
  instructionWires: Wire[]
  outputWire: Wire
  intermediateMode: 'connected' | 'removed'
}

export type DecodedInstruction = {
  operation: OperationName
  left: string
  right: string
}

function createCandidates(registerCount: number): InstructionCandidate[] {
  const candidates: InstructionCandidate[] = []
  for (const operation of operationNames) {
    for (let leftRegister = 0; leftRegister < registerCount; leftRegister++) {
      for (let rightRegister = 0; rightRegister < registerCount; rightRegister++) {
        candidates.push({operation, leftRegister, rightRegister})
      }
    }
  }
  return candidates
}

export function createProgramLayout(instructionCount: 1 | 2 = 2): ProgramLayout {
  let nextSource = inputNames.length
  let nextParameter = 0
  const instructionGroups: ProgramGroup[] = []
  for (let instruction = 0; instruction < instructionCount; instruction++) {
    const candidates = createCandidates(inputNames.length + instruction)
    const sourceWires = Array.from(
      {length: candidates.length},
      (_, index) => asWire(nextSource + index),
    )
    instructionGroups.push({
      name: `instruction ${instruction}`,
      sourceWires,
      parameterOffset: nextParameter,
      candidates,
    })
    nextSource += candidates.length
    nextParameter += candidates.length
  }
  return {
    sourceSize: nextSource,
    programCellCount: nextParameter,
    inputWires: inputNames.map((_, index) => asWire(index)),
    instructionGroups,
  }
}

function emitCandidate(
  circuit: Circuit,
  candidate: InstructionCandidate,
  registers: readonly Wire[],
): Wire {
  const left = registers[candidate.leftRegister]!
  const right = registers[candidate.rightRegister]!
  if (candidate.operation === 'add') return circuit.roundAffine([[left, 1], [right, 1]])
  if (candidate.operation === 'subtract') return circuit.roundAffine([[left, 1], [right, -1]])
  return emitMultiply(circuit, left, right)
}

function emitInstruction(
  circuit: Circuit,
  group: ProgramGroup,
  registers: readonly Wire[],
): Wire {
  const candidates = group.candidates.map(candidate => emitCandidate(circuit, candidate, registers))
  return circuit.roundAffine(candidates.map((candidate, index): readonly [Wire, number] => [
    emitMultiply(circuit, group.sourceWires[index]!, candidate),
    1,
  ]))
}

export function buildProgram(
  instructionCount: 1 | 2 = 2,
  selectionMode: 'soft' | 'hard' = 'soft',
  intermediateMode: 'connected' | 'removed' = 'connected',
): ProgramBuild {
  const layout = createProgramLayout(instructionCount)
  const circuit = new Circuit(layout.sourceSize)
  for (const inputWire of layout.inputWires) circuit.assumeRange(inputWire, -128, 128)
  for (const group of layout.instructionGroups) {
    for (const selector of group.sourceWires) circuit.assumeRange(selector, 0, 1)
    if (selectionMode === 'hard') circuit.assumeOneHot(group.sourceWires)
  }

  const registers = [...layout.inputWires]
  const instructionWires: Wire[] = []
  for (let instruction = 0; instruction < layout.instructionGroups.length; instruction++) {
    const output = emitInstruction(circuit, layout.instructionGroups[instruction]!, registers)
    instructionWires.push(output)
    registers.push(
      intermediateMode === 'removed' && instruction === 0
        ? layout.inputWires[inputNames.indexOf('distractor')]!
        : output,
    )
  }

  const outputWire = instructionWires[instructionWires.length - 1]!
  validateCircuit(circuit)
  validateWireView(
    instructionWires,
    instructionCount,
    circuit.sourceSize + circuit.operations.length,
  )
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(instructionWires)
  validateTensorProgram(circuit, tensorProgram)
  return {circuit, layout, instructionWires, outputWire, intermediateMode}
}

export function writeInputs(
  source: Float32Array,
  layout: ProgramLayout,
  inputs: CoordinateInputs,
) {
  invariant(source.length === layout.sourceSize, 'source table size mismatch')
  for (let index = 0; index < inputNames.length; index++) {
    source[layout.inputWires[index]!] = inputs[inputNames[index]!]!
  }
}

export function writeProgram(
  source: Float32Array,
  layout: ProgramLayout,
  program: ArrayLike<number>,
) {
  invariant(source.length === layout.sourceSize, 'source table size mismatch')
  invariant(program.length === layout.programCellCount, 'program cell count mismatch')
  for (const group of layout.instructionGroups) {
    for (let index = 0; index < group.sourceWires.length; index++) {
      source[group.sourceWires[index]!] = program[group.parameterOffset + index]!
    }
  }
}

function groupWinner(group: ProgramGroup, program: ArrayLike<number>): number {
  let winner = 0
  for (let index = 1; index < group.sourceWires.length; index++) {
    if (program[group.parameterOffset + index]! > program[group.parameterOffset + winner]!) {
      winner = index
    }
  }
  return winner
}

export function hardenProgram(
  layout: ProgramLayout,
  softProgram: ArrayLike<number>,
): Float32Array {
  invariant(softProgram.length === layout.programCellCount, 'program cell count mismatch')
  const hardened = new Float32Array(layout.programCellCount)
  for (const group of layout.instructionGroups) {
    hardened[group.parameterOffset + groupWinner(group, softProgram)] = 1
  }
  return hardened
}

function registerName(index: number): string {
  return index < inputNames.length ? inputNames[index]! : `instruction${index - inputNames.length}`
}

export function decodeProgram(
  layout: ProgramLayout,
  program: ArrayLike<number>,
): DecodedInstruction[] {
  invariant(program.length === layout.programCellCount, 'program cell count mismatch')
  return layout.instructionGroups.map(group => {
    const candidate = group.candidates[groupWinner(group, program)]!
    return {
      operation: candidate.operation,
      left: registerName(candidate.leftRegister),
      right: registerName(candidate.rightRegister),
    }
  })
}

function findCandidate(
  group: ProgramGroup,
  operation: OperationName,
  leftRegister: number,
  rightRegister: number,
) {
  const index = group.candidates.findIndex(candidate =>
    candidate.operation === operation
    && candidate.leftRegister === leftRegister
    && candidate.rightRegister === rightRegister)
  invariant(index >= 0, 'requested instruction is outside the program vocabulary')
  return index
}

export function encodeCoordinateProgram(layout: ProgramLayout): Float32Array {
  invariant(layout.instructionGroups.length === 2, 'coordinate program needs two instructions')
  const program = new Float32Array(layout.programCellCount)
  const first = layout.instructionGroups[0]!
  const second = layout.instructionGroups[1]!
  program[first.parameterOffset + findCandidate(
    first,
    'subtract',
    inputNames.indexOf('pointerX'),
    inputNames.indexOf('panelLeft'),
  )] = 1
  program[second.parameterOffset + findCandidate(
    second,
    'multiply',
    inputNames.indexOf('scale'),
    inputNames.length,
  )] = 1
  return program
}

export function encodeTwoAddProgram(
  layout: ProgramLayout,
  thirdAddend: 'scale' | 'distractor',
): Float32Array {
  invariant(layout.instructionGroups.length === 2, 'two-add program needs two instructions')
  const program = new Float32Array(layout.programCellCount)
  const first = layout.instructionGroups[0]!
  const second = layout.instructionGroups[1]!
  program[first.parameterOffset + findCandidate(
    first,
    'add',
    inputNames.indexOf('pointerX'),
    inputNames.indexOf('panelLeft'),
  )] = 1
  program[second.parameterOffset + findCandidate(
    second,
    'add',
    inputNames.length,
    inputNames.indexOf(thirdAddend),
  )] = 1
  return program
}

export function encodePrimitiveProgram(
  layout: ProgramLayout,
  operation: OperationName,
  left: InputName,
  right: InputName,
): Float32Array {
  invariant(layout.instructionGroups.length === 1, 'primitive program needs one instruction')
  const program = new Float32Array(layout.programCellCount)
  const group = layout.instructionGroups[0]!
  program[group.parameterOffset + findCandidate(
    group,
    operation,
    inputNames.indexOf(left),
    inputNames.indexOf(right),
  )] = 1
  return program
}

export function executeDecodedProgram(
  program: readonly DecodedInstruction[],
  inputs: CoordinateInputs,
  intermediateMode: 'connected' | 'removed' = 'connected',
): number {
  const registers = new Map<string, number>(
    inputNames.map(name => [name, Math.fround(inputs[name])]),
  )
  let result = 0
  for (let instruction = 0; instruction < program.length; instruction++) {
    const choice = program[instruction]!
    const left = registers.get(choice.left)!
    const right = registers.get(choice.right)!
    if (choice.operation === 'add') result = Math.fround(left + right)
    else if (choice.operation === 'subtract') result = Math.fround(left - right)
    else result = Math.fround(left * right)
    registers.set(
      `instruction${instruction}`,
      intermediateMode === 'removed' && instruction === 0 ? Math.fround(inputs.distractor) : result,
    )
  }
  return result
}

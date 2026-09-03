import {
  type CertificationCase,
  type TrainingTask,
  taskOracle,
} from './oracle.ts'
import {
  type DecodedInstruction,
  createProgramLayout,
  executeDecodedProgram,
  inputNames,
} from './program.ts'

export type ProgramSearchResult = {
  candidateProgramCount: number
  exactPrograms: DecodedInstruction[][]
  bestOneInstruction: DecodedInstruction
  bestOneInstructionMismatches: number
}

function decodeCandidate(instruction: number, candidateIndex: number): DecodedInstruction {
  const layout = createProgramLayout(2)
  const candidate = layout.instructionGroups[instruction]!.candidates[candidateIndex]!
  const registerName = (index: number) =>
    index < inputNames.length ? inputNames[index]! : `instruction${index - inputNames.length}`
  return {
    operation: candidate.operation,
    left: registerName(candidate.leftRegister),
    right: registerName(candidate.rightRegister),
  }
}

function mismatchCount(
  program: readonly DecodedInstruction[],
  cases: readonly CertificationCase[],
  task: TrainingTask,
  stopAfter = Number.POSITIVE_INFINITY,
) {
  let mismatches = 0
  for (const certificationCase of cases) {
    const target = taskOracle(task, certificationCase.inputs)
    if (executeDecodedProgram(program, certificationCase.inputs) !== target) {
      mismatches++
      if (mismatches >= stopAfter) break
    }
  }
  return mismatches
}

export function searchProgramSpace(
  cases: readonly CertificationCase[],
  task: TrainingTask = {kind: 'coordinate'},
): ProgramSearchResult {
  const layout = createProgramLayout(2)
  const firstGroup = layout.instructionGroups[0]!
  const secondGroup = layout.instructionGroups[1]!
  let bestOneInstruction = decodeCandidate(0, 0)
  let bestOneInstructionMismatches = Number.POSITIVE_INFINITY
  for (let candidate = 0; candidate < firstGroup.candidates.length; candidate++) {
    const instruction = decodeCandidate(0, candidate)
    const mismatches = mismatchCount([instruction], cases, task, bestOneInstructionMismatches)
    if (mismatches < bestOneInstructionMismatches) {
      bestOneInstruction = instruction
      bestOneInstructionMismatches = mismatches
    }
  }

  const exactPrograms: DecodedInstruction[][] = []
  let candidateProgramCount = 0
  for (let first = 0; first < firstGroup.candidates.length; first++) {
    const firstInstruction = decodeCandidate(0, first)
    for (let second = 0; second < secondGroup.candidates.length; second++) {
      candidateProgramCount++
      const program = [firstInstruction, decodeCandidate(1, second)]
      if (mismatchCount(program, cases, task, 1) === 0) exactPrograms.push(program)
    }
  }
  return {
    candidateProgramCount,
    exactPrograms,
    bestOneInstruction,
    bestOneInstructionMismatches,
  }
}

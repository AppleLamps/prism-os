import {type CoordinateInputs, type InputName, type OperationName} from './program.ts'

export class RandomSource {
  state: number

  constructor(seed: number) {
    this.state = seed | 0
  }

  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) | 0
    return (this.state >>> 0) / 4_294_967_296
  }
}

export function coordinateOracle(inputs: CoordinateInputs): number {
  const translatedX = Math.fround(Math.fround(inputs.pointerX) - Math.fround(inputs.panelLeft))
  return Math.fround(translatedX * Math.fround(inputs.scale))
}

export function twoAddOracle(
  inputs: CoordinateInputs,
  thirdAddend: 'scale' | 'distractor',
): number {
  const firstSum = Math.fround(Math.fround(inputs.pointerX) + Math.fround(inputs.panelLeft))
  return Math.fround(firstSum + Math.fround(inputs[thirdAddend]))
}

export type PrimitiveTask = {
  kind: 'primitive'
  operation: OperationName
  left: InputName
  right: InputName
}

export type TrainingTask =
  | {kind: 'coordinate'}
  | {kind: 'two-add', thirdAddend: 'scale' | 'distractor'}
  | PrimitiveTask

export const primitiveTasks: PrimitiveTask[] = [
  {kind: 'primitive', operation: 'add', left: 'pointerX', right: 'panelLeft'},
  {kind: 'primitive', operation: 'subtract', left: 'pointerX', right: 'panelLeft'},
  {kind: 'primitive', operation: 'multiply', left: 'pointerX', right: 'scale'},
]

export function taskOracle(task: TrainingTask, inputs: CoordinateInputs): number {
  if (task.kind === 'coordinate') return coordinateOracle(inputs)
  if (task.kind === 'two-add') return twoAddOracle(inputs, task.thirdAddend)
  const left = Math.fround(inputs[task.left])
  const right = Math.fround(inputs[task.right])
  if (task.operation === 'add') return Math.fround(left + right)
  if (task.operation === 'subtract') return Math.fround(left - right)
  return Math.fround(left * right)
}

const trainingCoordinates = Array.from({length: 17}, (_, index) => -16 + index * 2)
const trainingScales = [2, 4, 6] as const

export function createTrainingInputs(random: RandomSource): CoordinateInputs {
  const coordinate = () => trainingCoordinates[Math.floor(random.next() * trainingCoordinates.length)]!
  return {
    pointerX: coordinate(),
    panelLeft: coordinate(),
    scale: trainingScales[Math.floor(random.next() * trainingScales.length)]!,
    distractor: coordinate(),
  }
}

export function createTrainingGrid(): CoordinateInputs[] {
  const inputs: CoordinateInputs[] = []
  for (const pointerX of trainingCoordinates) {
    for (const panelLeft of trainingCoordinates) {
      for (const scale of trainingScales) {
        for (const distractor of trainingCoordinates) {
          inputs.push({pointerX, panelLeft, scale, distractor})
        }
      }
    }
  }
  return inputs
}

export type CertificationCase = {
  inputs: CoordinateInputs
  target: number
  family: 'unseen' | 'extrapolation' | 'translation' | 'fractional' | 'input-rounding'
}

export function createIntegerCertificationCases(): CertificationCase[] {
  const cases: CertificationCase[] = []
  const unseenCoordinates = Array.from({length: 16}, (_, index) => -15 + index * 2)
  const unseenScales = [1, 3, 5] as const
  const unseen: CertificationCase[] = []
  for (const pointerX of unseenCoordinates) {
    for (const panelLeft of unseenCoordinates) {
      for (const scale of unseenScales) {
        for (const distractor of unseenCoordinates) {
          const inputs = {pointerX, panelLeft, scale, distractor}
          unseen.push({inputs, target: coordinateOracle(inputs), family: 'unseen'})
        }
      }
    }
  }
  cases.push(...unseen)

  const extrapolationCoordinates = [-63, -31, -1, 1, 31, 63] as const
  const extrapolationScales = [-5, -3, 7] as const
  const extrapolationDistractors = [-61, 1, 59] as const
  for (const pointerX of extrapolationCoordinates) {
    for (const panelLeft of extrapolationCoordinates) {
      for (const scale of extrapolationScales) {
        for (const distractor of extrapolationDistractors) {
          const inputs = {pointerX, panelLeft, scale, distractor}
          cases.push({inputs, target: coordinateOracle(inputs), family: 'extrapolation'})
        }
      }
    }
  }

  for (const original of unseen) {
    for (const translation of [-32, 32] as const) {
      const inputs = {
        ...original.inputs,
        pointerX: original.inputs.pointerX + translation,
        panelLeft: original.inputs.panelLeft + translation,
      }
      cases.push({inputs, target: original.target, family: 'translation'})
    }
  }
  return cases
}

export function createFractionalCertificationCases(): CertificationCase[] {
  const cases: CertificationCase[] = []
  const coordinates = [-63.75, -1, -(2 ** -24), 0, 2 ** -24, 1, 63.75]
  const scales = [-1.5, -(2 ** -24), 2 ** -149, 0, 2 ** -24, 1, 3.25]
  for (const pointerX of coordinates) {
    for (const panelLeft of coordinates) {
      for (const scale of scales) {
        for (const distractor of coordinates) {
          const inputs = {pointerX, panelLeft, scale, distractor}
          cases.push({inputs, target: coordinateOracle(inputs), family: 'fractional'})
        }
      }
    }
  }
  return cases
}

export function createCertificationCases(): CertificationCase[] {
  const cases = [...createIntegerCertificationCases(), ...createFractionalCertificationCases()]
  for (const value of [1 + 2 ** -24, 1 + 3 * 2 ** -24, -(1 + 2 ** -24), 2 ** -150]) {
    for (const inputName of ['pointerX', 'panelLeft', 'scale', 'distractor'] as const) {
      const inputs = {pointerX: 1, panelLeft: 1, scale: 1, distractor: -1, [inputName]: value}
      cases.push({inputs, target: coordinateOracle(inputs), family: 'input-rounding'})
    }
  }
  return cases
}

export const controlIDs = ['confirm', 'details', 'cancel'] as const
export type ControlID = typeof controlIDs[number]
export type Point = {x: number, y: number}
export type Control = Point & {id: ControlID, width: number, height: number}
export type Layout = {
  id: string
  viewport: {width: number, height: number}
  controls: readonly Control[]
  clutter: number
}
export type EffortInput = {
  distance: number
  targetWidth: number
  clutter: number
  motorContext: number
}
export type Observation = {
  id: string
  shownLayout: Layout
  layoutSelectionProbability: number
  task: ControlID
  taskAssignmentProbability: number
  pointer: Point
  motorContext: number
  durationMs: number
}
export type DesignerConstraints = {minimumTargetWidth: number, maximumClutter: number}
export type TaskProbabilities = Readonly<Record<ControlID, number>>

export function effortInput(layout: Layout, task: ControlID, pointer: Point, motorContext: number): EffortInput {
  const control = layout.controls.find(control => control.id === task)
  if (control === undefined) throw new Error(`required control is missing: ${task}`)
  return {
    distance: Math.hypot(control.x + control.width / 2 - pointer.x, control.y + control.height / 2 - pointer.y),
    targetWidth: control.width,
    clutter: layout.clutter,
    motorContext,
  }
}

export function observationInput(observation: Observation): EffortInput {
  return effortInput(observation.shownLayout, observation.task, observation.pointer, observation.motorContext)
}

export function layoutViolations(layout: Layout, constraints: DesignerConstraints): string[] {
  const violations: string[] = []
  for (const id of controlIDs) {
    if (layout.controls.filter(control => control.id === id).length !== 1) violations.push(`expected exactly one ${id}`)
  }
  if (layout.clutter > constraints.maximumClutter) violations.push('too much clutter')
  for (const control of layout.controls) {
    if (control.width < constraints.minimumTargetWidth || control.height < 32) violations.push(`${control.id} is too small`)
    if (control.x < 8 || control.y < 8 || control.x + control.width > layout.viewport.width - 8 || control.y + control.height > layout.viewport.height - 8) {
      violations.push(`${control.id} is outside the viewport padding`)
    }
  }
  for (let first = 0; first < layout.controls.length; first++) {
    for (let second = first + 1; second < layout.controls.length; second++) {
      const a = layout.controls[first]!
      const b = layout.controls[second]!
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) violations.push('controls overlap')
    }
  }
  return violations
}

export function validateTaskProbabilities(probabilities: TaskProbabilities) {
  let sum = 0
  for (const id of controlIDs) {
    const probability = probabilities[id]
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('invalid task probability')
    sum += probability
  }
  if (Math.abs(sum - 1) > 1e-12) throw new Error('task probabilities must sum to one')
}

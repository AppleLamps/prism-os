import {controlIDs, effortInput, layoutViolations, validateTaskProbabilities, type Control, type ControlID, type DesignerConstraints, type EffortInput, type Layout, type Point, type TaskProbabilities} from './domain.ts'

function control(id: ControlID, centerX: number, centerY: number, width: number): Control {
  return {id, x: centerX - width / 2, y: centerY - 20, width, height: 40}
}

export const candidates: readonly Layout[] = [
  {id: 'near-small', viewport: {width: 800, height: 600}, clutter: 0.85, controls: [control('confirm', 190, 220, 32), control('details', 190, 300, 32), control('cancel', 190, 380, 32)]},
  {id: 'wide-confirm', viewport: {width: 800, height: 600}, clutter: 0.25, controls: [control('confirm', 340, 240, 104), control('details', 480, 320, 56), control('cancel', 480, 420, 56)]},
  {id: 'wide-details', viewport: {width: 800, height: 600}, clutter: 0.25, controls: [control('confirm', 480, 320, 56), control('details', 340, 240, 104), control('cancel', 480, 420, 56)]},
  {id: 'balanced', viewport: {width: 800, height: 600}, clutter: 0.1, controls: [control('confirm', 430, 200, 72), control('details', 430, 300, 72), control('cancel', 430, 400, 72)]},
]

export type SelectionSituation = {
  name: string
  pointer: Point
  motorContext: number
  taskProbabilities: TaskProbabilities
  constraints: DesignerConstraints
}

export function expectedCost(layout: Layout, situation: SelectionSituation, cost: (input: EffortInput) => number): number {
  validateTaskProbabilities(situation.taskProbabilities)
  let total = 0
  for (const task of controlIDs) total += situation.taskProbabilities[task] * cost(effortInput(layout, task, situation.pointer, situation.motorContext))
  return total
}

export function selectLayout(layouts: readonly Layout[], situation: SelectionSituation, cost: (input: EffortInput) => number) {
  validateTaskProbabilities(situation.taskProbabilities)
  let selected: Layout | null = null
  let minimum = Infinity
  for (const layout of layouts) {
    if (layoutViolations(layout, situation.constraints).length !== 0) continue
    const value = expectedCost(layout, situation, cost)
    if (!Number.isFinite(value)) throw new Error('nonfinite layout cost')
    if (value < minimum) {
      selected = layout
      minimum = value
    }
  }
  return selected
}

export function selectionSituations(): SelectionSituation[] {
  const goals: {name: string, probabilities: TaskProbabilities}[] = [
    {name: 'confirm-heavy', probabilities: {confirm: 0.8, details: 0.1, cancel: 0.1}},
    {name: 'details-heavy', probabilities: {confirm: 0.1, details: 0.8, cancel: 0.1}},
    {name: 'cancel-heavy', probabilities: {confirm: 0.1, details: 0.1, cancel: 0.8}},
    {name: 'equal-tasks', probabilities: {confirm: 1 / 3, details: 1 / 3, cancel: 1 / 3}},
    {name: 'mixed-tasks', probabilities: {confirm: 0.5, details: 0.4, cancel: 0.1}},
  ]
  const situations: SelectionSituation[] = []
  for (const goal of goals) {
    for (const motorContext of [0.125, 0.375, 0.625, 0.875]) {
      for (const minimumTargetWidth of [32, 48, 72]) {
        for (const maximumClutter of [1, 0.5]) {
          situations.push({name: goal.name, pointer: {x: 96, y: 300}, motorContext, taskProbabilities: goal.probabilities, constraints: {minimumTargetWidth, maximumClutter}})
        }
      }
    }
  }
  return situations
}

export function compareSelections(predict: (input: EffortInput) => number, simulator: (input: EffortInput) => number) {
  const methods = [
    {name: 'predicted-effort', cost: predict},
    {name: 'shortest-distance', cost: (input: EffortInput) => input.distance},
    {name: 'simulator-optimal', cost: simulator},
  ]
  const situations = selectionSituations()
  const rows = situations.map(situation => {
    const optimal = selectLayout(candidates, situation, simulator)
    if (optimal === null) throw new Error('authored candidates do not satisfy constraints')
    const optimumMs = expectedCost(optimal, situation, simulator)
    return {
      situation,
      optimumMs,
      selections: methods.map(method => {
        const selected = selectLayout(candidates, situation, method.cost)
        if (selected === null) throw new Error('authored candidates do not satisfy constraints')
        const expectedDurationMs = expectedCost(selected, situation, simulator)
        return {method: method.name, layout: selected.id, expectedDurationMs, regretMs: expectedDurationMs - optimumMs, matchesOptimal: selected.id === optimal.id}
      }),
    }
  })
  function summarize(selectedRows: typeof rows) {
    return methods.map((method, methodIndex) => {
      let duration = 0
      let regret = 0
      let maximumRegret = 0
      let matches = 0
      for (const row of selectedRows) {
        const selection = row.selections[methodIndex]!
        duration += selection.expectedDurationMs
        regret += selection.regretMs
        maximumRegret = Math.max(maximumRegret, selection.regretMs)
        matches += Number(selection.matchesOptimal)
      }
      return {method: method.name, meanDurationMs: duration / selectedRows.length, meanRegretMs: regret / selectedRows.length, maximumRegretMs: maximumRegret, matchesOptimal: matches, situations: selectedRows.length}
    })
  }
  // Report the cases where constraints permit every candidate separately.
  const allCandidatesAllowed = rows.filter(row => candidates.every(layout => layoutViolations(layout, row.situation.constraints).length === 0))
  return {summary: summarize(rows), allCandidatesAllowed: summarize(allCandidatesAllowed), rows}
}

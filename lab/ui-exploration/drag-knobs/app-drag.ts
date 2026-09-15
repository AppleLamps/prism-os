// The app shell as a DragProblem: the five lifted knobs, every rectangle edge as an output,
// the visible discrete results (grid column counts, text line counts, wrap line indices, the
// sidebar's shown bit) as decisions, and the horizontal overflow count as violations.
// Plus flip queries for a grid's column count and a text's line count, built from the
// decision records the builder keeps next to each exact bit.
import type {Wire} from '../../../numeric-ui-core.ts'
import {authoredKnobs, createAppShell, designOptions, knobNames, knobSpecs, type AppShell, type KnobName} from './app-shell.ts'
import {writeLayoutSources} from './builder.ts'
import type {DragProblem, EdgeTerms, KnobSpec} from './drag-solver.ts'
import type {MarginQuery} from './flip-query.ts'
import type {TextTable} from './tree.ts'

export type EdgeSide = 'left' | 'right' | 'top' | 'bottom'

export type AppDrag = ReturnType<typeof createAppDrag>

export function createAppDrag(tables: ReadonlyMap<string, TextTable>, shell: AppShell = createAppShell(designOptions)) {
  const knobs: KnobSpec[] = knobNames.map(name => {
    const cell = shell.knobCells.get(name)
    if (cell === undefined) throw new Error(`knob ${name} is not lifted`)
    return {name, cell, minimum: knobSpecs[name].minimum, maximum: knobSpecs[name].maximum, magnitudeFloor: knobSpecs[name].magnitudeFloor}
  })
  const knobIndex = Object.fromEntries(knobNames.map((name, index) => [name, index])) as Record<KnobName, number>
  const rectWires = [...shell.layout.rects.values()].flatMap(rect => [rect.x, rect.y, rect.width, rect.height])
  const decisionWires = [...new Set([
    ...shell.layout.gridColumns.values(),
    ...shell.layout.lines.values(),
    ...[...shell.layout.wrapLines.values()].flat(),
    shell.sidebarShown,
  ])]
  const decisionNames: string[] = []
  {
    const names = new Map<Wire, string>()
    for (const [name, wire] of shell.layout.gridColumns) names.set(wire, `${name} columns`)
    for (const [name, wire] of shell.layout.lines) if (!names.has(wire)) names.set(wire, `${name} lines`)
    for (const [name, list] of shell.layout.wrapLines) list.forEach((wire, index) => { if (!names.has(wire)) names.set(wire, `${name} child ${index} line`) })
    if (!names.has(shell.sidebarShown)) names.set(shell.sidebarShown, 'sidebar shown')
    for (const wire of decisionWires) decisionNames.push(names.get(wire)!)
  }
  const problem: DragProblem = {
    circuit: shell.circuit,
    knobs,
    decisions: decisionWires,
    violations: shell.layout.overflowCount,
    outputs: rectWires,
    // Every recorded decision's difference wire: grid bits, line thresholds, wrap fits, water
    // fill clamps, the hit test and breakpoint, and the overflow checks.
    margins: [...new Set(shell.circuit.decisions.map(record => record.difference))],
  }

  // A settled design frame: the given viewport, scroll 0, the sidebar open and at rest.
  const createSource = (viewportWidth: number, viewportHeight: number, knobValues: Readonly<Record<string, number>> = authoredKnobs) => {
    const values = shell.table.createValues()
    writeLayoutSources(values, shell.sources, {viewportWidth, viewportHeight, mainScroll: 0}, tables)
    values[shell.settledCell!] = 1
    for (const name of knobNames) values[shell.knobCells.get(name)!] = knobValues[name] ?? authoredKnobs[name]
    return values
  }

  const edge = (node: string, side: EdgeSide): EdgeTerms => {
    const rect = shell.layout.rects.get(node)
    if (rect === undefined) throw new Error(`unknown node ${node}`)
    switch (side) {
      case 'left': return [[rect.x, 1]]
      case 'right': return [[rect.x, 1], [rect.width, 1]]
      case 'top': return [[rect.y, 1]]
      case 'bottom': return [[rect.y, 1], [rect.height, 1]]
    }
  }

  const gridQueries = (gridName: string, values: ArrayLike<number>): MarginQuery[] => {
    const columnsWire = shell.layout.gridColumns.get(gridName)!
    const columns = values[columnsWire]!
    const queries: MarginQuery[] = []
    for (const record of shell.circuit.decisions) {
      if (record.kind !== 'grid' || record.node !== gridName) continue
      if (record.detail === columns + 1) queries.push({label: `${gridName} rises to ${columns + 1} columns`, terms: [[record.difference, 1]], results: [columnsWire], expected: [columns + 1]})
      if (record.detail === columns) queries.push({label: `${gridName} drops to ${columns - 1} columns`, terms: [[record.difference, 1]], results: [columnsWire], expected: [columns - 1]})
    }
    return queries
  }

  // The nearest line-count threshold on each side of the text's current width.
  const lineQueries = (textName: string, values: ArrayLike<number>): MarginQuery[] => {
    const linesWire = shell.layout.lines.get(textName)!
    const lines = values[linesWire]!
    let below: {difference: Wire, margin: number} | null = null
    let above: {difference: Wire, margin: number} | null = null
    for (const record of shell.circuit.decisions) {
      if (record.kind !== 'lines' || record.node !== textName) continue
      const margin = values[record.difference]!
      // Unused threshold cells hold a large negative width, far from any real width.
      if (Math.abs(margin) > 2048) continue
      if (margin < 0 && (below === null || margin > below.margin)) below = {difference: record.difference, margin}
      if (margin >= 0 && (above === null || margin < above.margin)) above = {difference: record.difference, margin}
    }
    const queries: MarginQuery[] = []
    if (below !== null) queries.push({label: `${textName} wraps to ${lines - 1} lines`, terms: [[below.difference, 1]], results: [linesWire], expected: [lines - 1]})
    if (above !== null) queries.push({label: `${textName} wraps to ${lines + 1} lines`, terms: [[above.difference, 1]], results: [linesWire], expected: [lines + 1]})
    return queries
  }

  const gridOfCard = (card: string) => Number(card.replace(/^card(\d+).*$/, '$1')) < 8 ? 'recent.grid' : 'shared.grid'

  return {shell, problem, knobIndex, decisionNames, createSource, edge, gridQueries, lineQueries, gridOfCard}
}

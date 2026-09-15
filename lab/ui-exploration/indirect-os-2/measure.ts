// Compile-time measurements: live operations, layers, stored weights, gather
// reads, and how they split over labeled build sections (spring-bank.ts
// withSection), including along the deepest path.
import type {Circuit, Wire} from '../../../numeric-ui-core.ts'
import {sectionRanges} from '../spring-bank/spring-bank.ts'

export type ProgramSize = {live: number, layers: number, weights: number, gatherReads: number, widestLayer: number}

export function programSize(circuit: Circuit, roots: readonly Wire[]): ProgramSize {
  const program = circuit.compileTensorProgram(roots)
  return {
    live: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    weights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    gatherReads: program.layers.reduce((total, layer) => total + layer.gatherReads.length, 0),
    widestLayer: Math.max(0, ...program.layers.map(layer => layer.outputSize)),
  }
}

// The innermost labeled section that created each operation, or 'other'.
function sectionLabeler(circuit: Circuit) {
  const sections = [...sectionRanges(circuit)].sort((left, right) => (left.end - left.start) - (right.end - right.start))
  return (operationIndex: number) => sections.find(section => operationIndex >= section.start && operationIndex < section.end)?.label ?? 'other'
}

export function sectionBreakdown(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  const labelOf = sectionLabeler(circuit)
  const rows = new Map<string, {live: number, weights: number}>()
  let available = program.sourceSize
  for (const layer of program.layers) {
    const gateByRow = new Map<number, number>()
    layer.gateRows.forEach((row, gate) => gateByRow.set(row, layer.outputSize + gate))
    for (let row = 0; row < layer.outputSize; row++) {
      const wire = program.wireOrder[available + row]!
      const label = labelOf(wire - program.sourceSize)
      const gateRow = gateByRow.get(row)
      const weights = layer.rowOffsets[row + 1]! - layer.rowOffsets[row]!
        + (gateRow === undefined ? 0 : layer.rowOffsets[gateRow + 1]! - layer.rowOffsets[gateRow]!)
      const entry = rows.get(label) ?? {live: 0, weights: 0}
      entry.live++
      entry.weights += weights
      rows.set(label, entry)
    }
    available += layer.outputSize
  }
  return [...rows.entries()].sort((left, right) => right[1].live - left[1].live).map(([label, entry]) => ({label, ...entry}))
}

// Walks back from the deepest live operation, one dependency per layer, and
// counts the sections along that path.
export function deepestPathSections(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  const labelOf = sectionLabeler(circuit)
  const live = new Set<number>()
  for (let position = program.sourceSize; position < program.valueCount; position++) live.add(program.wireOrder[position]!)
  let deepest = -1
  for (const wire of live) if (deepest === -1 || circuit.depths[wire]! > circuit.depths[deepest]!) deepest = wire
  const counts = new Map<string, number>()
  let wire = deepest
  while (wire >= circuit.sourceSize) {
    const operation = circuit.operations[wire - circuit.sourceSize]!
    const label = labelOf(wire - circuit.sourceSize)
    counts.set(label, (counts.get(label) ?? 0) + 1)
    let next = -1
    for (const [dependency] of [...operation.leftTerms, ...operation.gateTerms]) {
      if (next === -1 || circuit.depths[dependency]! > circuit.depths[next]!) next = dependency
    }
    if (next === -1) break
    wire = next
  }
  return {depth: deepest === -1 ? 0 : circuit.depths[deepest]!, sections: [...counts.entries()].sort((left, right) => right[1] - left[1])}
}

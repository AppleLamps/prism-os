// Source table allocation, operation tagging, decision records, and compiled-program
// measurement. Copied from lab/ui-exploration/layout-tree, plus DecisionRecord.
import {Circuit, type Wire} from '../../../numeric-ui-core.ts'

export type DecisionKind = 'grid' | 'lines' | 'wrap' | 'fill' | 'app' | 'overflow'

// One exact decision bit = [difference >= 0], and the unclamped difference wire next to it.
// The difference is the decision's margin: its distance from flipping, in the units of the
// compared values (pixels for layout). `detail` says which decision of the node this is, e.g.
// the column count c for a grid bit [inner + epsilon >= c * minCellWidth + (c - 1) * gap].
export type DecisionRecord = {
  kind: DecisionKind
  node: string
  detail: number
  difference: Wire
  bit: Wire
  tag: string
}

// A Circuit that remembers which tag was active when each operation was created, so a
// compiled program's live operations and stored weights can be split by pass and level.
// Deduplicated expressions keep the tag of their first creator.
export class TaggedCircuit extends Circuit {
  tagNames: string[] = ['untagged']
  tagIndexByName = new Map<string, number>([['untagged', 0]])
  currentTag = 0
  operationTags: number[] = []
  decisions: DecisionRecord[] = []

  override append(...args: Parameters<Circuit['append']>): Wire {
    const before = this.operations.length
    const wire = super.append(...args)
    if (this.operations.length > before) this.operationTags.push(this.currentTag)
    return wire
  }

  withTag<T>(name: string, run: () => T): T {
    let tag = this.tagIndexByName.get(name)
    if (tag === undefined) {
      tag = this.tagNames.length
      this.tagNames.push(name)
      this.tagIndexByName.set(name, tag)
    }
    const previous = this.currentTag
    this.currentTag = tag
    try {
      return run()
    } finally {
      this.currentTag = previous
    }
  }
}

export class SourceTable {
  names: string[] = []
  initialValues: number[] = []
  minimums: number[] = []
  maximums: number[] = []
  indexByName = new Map<string, Wire>()

  cell(name: string, initial: number, minimum: number, maximum: number): Wire {
    if (this.indexByName.has(name)) throw new Error(`duplicate source cell ${name}`)
    const wire = this.names.length
    this.names.push(name)
    this.initialValues.push(initial)
    this.minimums.push(minimum)
    this.maximums.push(maximum)
    this.indexByName.set(name, wire)
    return wire
  }

  wire(name: string): Wire {
    const wire = this.indexByName.get(name)
    if (wire === undefined) throw new Error(`unknown source cell ${name}`)
    return wire
  }

  createCircuit(): TaggedCircuit {
    const circuit = new TaggedCircuit(this.names.length)
    for (let wire = 0; wire < this.names.length; wire++) circuit.assumeRange(wire, this.minimums[wire]!, this.maximums[wire]!)
    return circuit
  }

  createValues(): Float32Array {
    return Float32Array.from(this.initialValues)
  }
}

export type ProgramStats = {
  sources: number
  operationsBuilt: number
  liveOperations: number
  layers: number
  storedWeights: number
  widestLayer: number
  gatherReads: number
}

export function programStats(circuit: Circuit, roots: readonly Wire[]): ProgramStats {
  const program = circuit.compileTensorProgram(roots)
  return {
    sources: circuit.sourceSize,
    operationsBuilt: circuit.operations.length,
    liveOperations: program.wireOrder.length - circuit.sourceSize,
    layers: program.layers.length,
    storedWeights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    widestLayer: Math.max(0, ...program.layers.map(layer => layer.outputSize)),
    gatherReads: program.layers.reduce((total, layer) => total + layer.gatherReads.length, 0),
  }
}

// Deterministic pseudo-random numbers (mulberry32).
export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

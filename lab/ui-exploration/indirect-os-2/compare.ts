// Structural comparison of two circuits over the operations reachable from
// their roots. Each live wire gets a canonical id built from its kind, rounding
// flag, biases, terms (as canonical ids of the term wires), macro operands, and
// inferred range. Source wires are named by their table offset.
//
// strict: terms are compared in stored order. The builder sorts ordinary
// affine terms by wire number, and FP32 accumulation follows that order, so a
// strict match means both circuits accumulate every sum in the same order.
// relaxed: terms are compared as unordered sets, which shows whether a strict
// difference is only about accumulation order.
import type {Circuit, Terms, Wire} from '../../../numeric-ui-core.ts'

type Mode = 'strict' | 'relaxed'

function createCanonicalizer(intern: Map<string, number>, mode: Mode) {
  return (circuit: Circuit) => {
    const memo = new Int32Array(circuit.sourceSize + circuit.operations.length).fill(-1)
    const idOf = (key: string) => {
      let id = intern.get(key)
      if (id === undefined) {
        id = intern.size
        intern.set(key, id)
      }
      return id
    }
    const terms = (list: Terms) => {
      const parts = list.map(([wire, coefficient]) => `${canonical(wire)}*${coefficient}`)
      if (mode === 'relaxed') parts.sort()
      return parts.join(',')
    }
    function canonical(wire: Wire): number {
      if (memo[wire] !== -1) return memo[wire]!
      let key: string
      if (wire < circuit.sourceSize) {
        key = `source ${wire}`
      } else {
        const operation = circuit.operations[wire - circuit.sourceSize]!
        const macro = operation.macro === undefined
          ? ''
          : operation.macro.kind === 'multiply'
            ? `multiply ${canonical(operation.macro.left)} ${canonical(operation.macro.right)}`
            : `select ${canonical(operation.macro.gate)} ${canonical(operation.macro.off)} ${canonical(operation.macro.on)}`
        key = [
          operation.kind,
          operation.preserveRounding === true ? 'round' : '',
          operation.leftBias,
          terms(operation.leftTerms),
          operation.gateBias,
          terms(operation.gateTerms),
          macro,
        ].join('|')
      }
      const range = circuit.ranges[wire]!
      memo[wire] = idOf(`${key}|range ${range.minimum} ${range.maximum}`)
      return memo[wire]!
    }
    return canonical
  }
}

export function programStats(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  return {
    built: circuit.operations.length,
    live: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    weights: program.layers.reduce((sum, layer) => sum + layer.weights.length, 0),
    gatherReads: program.layers.reduce((sum, layer) => sum + layer.gatherReads.length, 0),
    layerWidths: program.layers.map(layer => layer.outputSize),
  }
}

// Canonical ids of every live wire, counted as a multiset.
function liveIdCounts(circuit: Circuit, roots: readonly Wire[], canonical: (wire: Wire) => number) {
  const program = circuit.compileTensorProgram(roots)
  const counts = new Map<number, number>()
  for (let index = program.sourceSize; index < program.wireOrder.length; index++) {
    const id = canonical(program.wireOrder[index]!)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

export function compareCircuits(
  original: {circuit: Circuit, roots: readonly Wire[]},
  rewrite: {circuit: Circuit, roots: readonly Wire[]},
) {
  const result: Record<Mode, {matchingRoots: number, liveOnlyInOriginal: number, liveOnlyInRewrite: number}> = {
    strict: {matchingRoots: 0, liveOnlyInOriginal: 0, liveOnlyInRewrite: 0},
    relaxed: {matchingRoots: 0, liveOnlyInOriginal: 0, liveOnlyInRewrite: 0},
  }
  for (const mode of ['strict', 'relaxed'] as const) {
    const makeCanonicalizer = createCanonicalizer(new Map(), mode)
    const originalCanonical = makeCanonicalizer(original.circuit)
    const rewriteCanonical = makeCanonicalizer(rewrite.circuit)
    original.roots.forEach((wire, index) => {
      if (originalCanonical(wire) === rewriteCanonical(rewrite.roots[index]!)) result[mode].matchingRoots++
    })
    const originalCounts = liveIdCounts(original.circuit, original.roots, originalCanonical)
    const rewriteCounts = liveIdCounts(rewrite.circuit, rewrite.roots, rewriteCanonical)
    for (const [id, count] of originalCounts) result[mode].liveOnlyInOriginal += Math.max(0, count - (rewriteCounts.get(id) ?? 0))
    for (const [id, count] of rewriteCounts) result[mode].liveOnlyInRewrite += Math.max(0, count - (originalCounts.get(id) ?? 0))
  }
  return {
    rootCount: original.roots.length,
    ...result,
    original: programStats(original.circuit, original.roots),
    rewrite: programStats(rewrite.circuit, rewrite.roots),
  }
}

// A compiled program as one list of rows in execution order, an evaluator that
// can place one-frame delays (registers) on values, and the depth analysis the
// search needs.
//
// A cut on a packed value p adds a register cell r. Every row that reads p
// (as a term, a gate term, a gather candidate or a gather bit) reads r instead,
// and r holds the value p had at the end of the previous evaluation. Outputs and
// next-source write-backs still read p itself, so a cut delays what the circuit
// computes from p, not what the host sees of p. p is still computed every
// evaluation, because the register needs it.
//
// Depth is the longest chain of rows from sources, where a register counts as a
// source. It's the number of layers an executor needs after re-layering rows by
// that chain.
import type {Circuit} from '../../../numeric-ui-core.ts'

export type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

export const rowKind = {affine: 0, reglu: 1, boolean: 2, gather: 3} as const

export type FlatProgram = {
  sourceSize: number
  // Packed values: sources, then rows in execution order.
  valueCount: number
  rowCount: number
  compiledLayers: number
  storedWeights: number
  wireOrder: ArrayLike<number>
  positionOfWire: Int32Array
  kind: Uint8Array
  bias: Float64Array
  gateBias: Float64Array
  termStart: Int32Array
  termPosition: Int32Array
  termWeight: Float64Array
  gateStart: Int32Array
  gatePosition: Int32Array
  gateWeight: Float64Array
  // Gather rows: the one-hot slot, whether the group allows all zeros, candidates.
  gatherSlot: Int32Array
  gatherMasked: Uint8Array
  candidateStart: Int32Array
  candidatePosition: Int32Array
  // Gather index computations, each run right before `computeRow[c]`.
  computeRow: Int32Array
  computeSlot: Int32Array
  bitStart: Int32Array
  bitPosition: Int32Array
  // The bits each slot reads, for depth.
  slotCompute: Int32Array
}

// The same rows as the executor, flattened like codegen's flattenProgram: rows of
// one layer only read earlier layers, so evaluating rows one at a time and storing
// each output immediately equals the executor's stage-then-append order.
export function flattenProgram(program: TensorProgram): FlatProgram {
  let rowCount = 0
  let termCount = 0
  let gateCount = 0
  let candidateCount = 0
  let computeCount = 0
  let bitCount = 0
  let storedWeights = 0
  for (const layer of program.layers) {
    rowCount += layer.outputSize
    storedWeights += layer.weights.length
    termCount += layer.weights.length
    for (const read of layer.gatherReads) candidateCount += read.candidatePositions.length
    computeCount += layer.gatherComputes.length
    for (const compute of layer.gatherComputes) bitCount += compute.bitPositions.length
  }
  gateCount = termCount
  const kind = new Uint8Array(rowCount)
  const bias = new Float64Array(rowCount)
  const gateBias = new Float64Array(rowCount)
  const termStart = new Int32Array(rowCount + 1)
  const termPosition = new Int32Array(termCount)
  const termWeight = new Float64Array(termCount)
  const gateStart = new Int32Array(rowCount + 1)
  const gatePosition = new Int32Array(gateCount)
  const gateWeight = new Float64Array(gateCount)
  const gatherSlot = new Int32Array(rowCount).fill(-1)
  const gatherMasked = new Uint8Array(rowCount)
  const candidateStart = new Int32Array(rowCount + 1)
  const candidatePosition = new Int32Array(candidateCount)
  const computeRow = new Int32Array(computeCount)
  const computeSlot = new Int32Array(computeCount)
  const bitStart = new Int32Array(computeCount + 1)
  const bitPosition = new Int32Array(bitCount)
  const slotCompute = new Int32Array(program.gatherSlotCount).fill(-1)
  let row = 0
  let term = 0
  let gate = 0
  let candidate = 0
  let compute = 0
  let bit = 0
  let available = program.sourceSize
  for (const layer of program.layers) {
    for (const gatherCompute of layer.gatherComputes) {
      computeRow[compute] = row
      computeSlot[compute] = gatherCompute.slot
      slotCompute[gatherCompute.slot] = compute
      bitStart[compute] = bit
      for (const position of gatherCompute.bitPositions) bitPosition[bit++] = position
      compute++
      bitStart[compute] = bit
    }
    const gateProjectionByRow = new Map<number, number>()
    layer.gateRows.forEach((outputRow, gateIndex) => gateProjectionByRow.set(outputRow, layer.outputSize + gateIndex))
    const booleanRows = new Set(layer.booleanRows)
    const readByRow = new Map(layer.gatherReads.map(read => [read.row, read]))
    for (let layerRow = 0; layerRow < layer.outputSize; layerRow++) {
      if (available + layerRow !== program.sourceSize + row) throw new Error('rows must be packed in execution order')
      const read = readByRow.get(layerRow)
      const gateProjection = gateProjectionByRow.get(layerRow)
      kind[row] = read !== undefined ? rowKind.gather : gateProjection !== undefined ? rowKind.reglu : booleanRows.has(layerRow) ? rowKind.boolean : rowKind.affine
      bias[row] = layer.bias[layerRow]!
      termStart[row] = term
      for (let index = layer.rowOffsets[layerRow]!; index < layer.rowOffsets[layerRow + 1]!; index++) {
        termWeight[term] = layer.weights[index]!
        termPosition[term] = layer.inputIndices[layer.columns[index]!]!
        term++
      }
      gateStart[row] = gate
      if (gateProjection !== undefined) {
        gateBias[row] = layer.bias[gateProjection]!
        for (let index = layer.rowOffsets[gateProjection]!; index < layer.rowOffsets[gateProjection + 1]!; index++) {
          gateWeight[gate] = layer.weights[index]!
          gatePosition[gate] = layer.inputIndices[layer.columns[index]!]!
          gate++
        }
      }
      candidateStart[row] = candidate
      if (read !== undefined) {
        gatherSlot[row] = read.slot
        gatherMasked[row] = read.masked ? 1 : 0
        for (const position of read.candidatePositions) candidatePosition[candidate++] = position
      }
      row++
      termStart[row] = term
      gateStart[row] = gate
      candidateStart[row] = candidate
    }
    available += layer.outputSize
  }
  const positionOfWire = new Int32Array(program.width).fill(-1)
  for (let position = 0; position < program.valueCount; position++) positionOfWire[program.wireOrder[position]!] = position
  return {
    sourceSize: program.sourceSize,
    valueCount: program.valueCount,
    rowCount,
    compiledLayers: program.layers.length,
    storedWeights,
    wireOrder: program.wireOrder,
    positionOfWire,
    kind,
    bias,
    gateBias,
    termStart,
    termPosition: termPosition,
    termWeight,
    gateStart,
    gatePosition: gatePosition.subarray(0, gate),
    gateWeight: gateWeight.subarray(0, gate),
    gatherSlot,
    gatherMasked,
    candidateStart,
    candidatePosition,
    computeRow,
    computeSlot,
    bitStart,
    bitPosition,
    slotCompute,
  }
}

// The position arrays an evaluation reads. A cut set rewrites a copy of them.
export type ReadPositions = {
  term: Int32Array
  gate: Int32Array
  candidate: Int32Array
  bit: Int32Array
}

export function originalReads(program: FlatProgram): ReadPositions {
  return {term: program.termPosition, gate: program.gatePosition, candidate: program.candidatePosition, bit: program.bitPosition}
}

export function cutReads(program: FlatProgram, cuts: readonly number[]): ReadPositions {
  const registerOf = new Map<number, number>()
  cuts.forEach((position, register) => registerOf.set(position, program.valueCount + register))
  const remap = (positions: Int32Array) => {
    const copy = new Int32Array(positions)
    for (let index = 0; index < copy.length; index++) {
      const register = registerOf.get(copy[index]!)
      if (register !== undefined) copy[index] = register
    }
    return copy
  }
  return {term: remap(program.termPosition), gate: remap(program.gatePosition), candidate: remap(program.candidatePosition), bit: remap(program.bitPosition)}
}

// FP32 evaluation with the executor's accumulation order. `values` holds the
// packed values followed by register cells.
export function evaluateRows(program: FlatProgram, reads: ReadPositions, values: Float32Array, gatherIndex: Int32Array, gatherMass: Float32Array) {
  const f = Math.fround
  const {rowCount, kind, bias, gateBias, termStart, termWeight, gateStart, gateWeight, gatherSlot, gatherMasked, candidateStart, computeRow, computeSlot, bitStart, sourceSize} = program
  const termPosition = reads.term
  const gatePosition = reads.gate
  const candidatePosition = reads.candidate
  const bitPosition = reads.bit
  const computeCount = computeRow.length
  let compute = 0
  for (let row = 0; row < rowCount; row++) {
    while (compute < computeCount && computeRow[compute] === row) {
      let index = 0
      let mass = 0
      const start = bitStart[compute]!
      const end = bitStart[compute + 1]!
      for (let bit = start; bit < end; bit++) {
        const bitValue = values[bitPosition[bit]!]!
        index += (bit - start) * bitValue
        mass += bitValue
      }
      gatherIndex[computeSlot[compute]!] = index
      gatherMass[computeSlot[compute]!] = mass
      compute++
    }
    let total = bias[row]!
    const termEnd = termStart[row + 1]!
    for (let term = termStart[row]!; term < termEnd; term++) total = f(total + f(termWeight[term]! * values[termPosition[term]!]!))
    const rowKindValue = kind[row]!
    if (rowKindValue === 0) {
      values[sourceSize + row] = total
    } else if (rowKindValue === 1) {
      let gate = gateBias[row]!
      const gateEnd = gateStart[row + 1]!
      for (let term = gateStart[row]!; term < gateEnd; term++) gate = f(gate + f(gateWeight[term]! * values[gatePosition[term]!]!))
      values[sourceSize + row] = f(total * Math.max(0, gate))
    } else if (rowKindValue === 2) {
      values[sourceSize + row] = f(f(total + 8388609) - 8388609)
    } else {
      const slot = gatherSlot[row]!
      const start = candidateStart[row]!
      const limit = candidateStart[row + 1]! - start - 1
      const index = Math.min(Math.max(gatherIndex[slot]!, 0), limit)
      let contribution = values[candidatePosition[start + index]!]!
      if (gatherMasked[row] === 1) contribution = f(gatherMass[slot]! * contribution)
      values[sourceSize + row] = f(total + contribution)
    }
  }
}

// An evaluator with registers. The first evaluation fills the registers from an
// evaluation without cuts on the same source table, i.e. it assumes the previous
// frame showed the same inputs.
export function createRetimedEvaluator(program: FlatProgram, cuts: readonly number[]) {
  const reads = cuts.length === 0 ? originalReads(program) : cutReads(program, cuts)
  const plain = originalReads(program)
  const values = new Float32Array(program.valueCount + cuts.length)
  const gatherIndex = new Int32Array(Math.max(1, program.slotCompute.length))
  const gatherMass = new Float32Array(Math.max(1, program.slotCompute.length))
  const cutPositions = Int32Array.from(cuts)
  let warm = false
  return {
    values,
    evaluate(source: Float32Array): Float32Array {
      values.set(source)
      if (!warm && cuts.length > 0) {
        evaluateRows(program, plain, values, gatherIndex, gatherMass)
        for (let register = 0; register < cutPositions.length; register++) values[program.valueCount + register] = values[cutPositions[register]!]!
      }
      warm = true
      evaluateRows(program, reads, values, gatherIndex, gatherMass)
      for (let register = 0; register < cutPositions.length; register++) values[program.valueCount + register] = values[cutPositions[register]!]!
      return values
    },
  }
}

export type Graph = {
  program: FlatProgram
  // For each row, the packed positions it reads (terms, gate terms, candidates, gather bits), deduplicated.
  inputStart: Int32Array
  inputPosition: Int32Array
  // For each packed position, the rows that read it.
  readerStart: Int32Array
  readerRow: Int32Array
}

export function buildGraph(program: FlatProgram): Graph {
  const {rowCount, valueCount, sourceSize} = program
  const inputs: number[][] = []
  for (let row = 0; row < rowCount; row++) {
    const set = new Set<number>()
    for (let term = program.termStart[row]!; term < program.termStart[row + 1]!; term++) set.add(program.termPosition[term]!)
    for (let term = program.gateStart[row]!; term < program.gateStart[row + 1]!; term++) set.add(program.gatePosition[term]!)
    for (let candidate = program.candidateStart[row]!; candidate < program.candidateStart[row + 1]!; candidate++) set.add(program.candidatePosition[candidate]!)
    const slot = program.gatherSlot[row]!
    if (slot >= 0) {
      const compute = program.slotCompute[slot]!
      for (let bit = program.bitStart[compute]!; bit < program.bitStart[compute + 1]!; bit++) set.add(program.bitPosition[bit]!)
    }
    inputs.push([...set].sort((left, right) => left - right))
  }
  const inputStart = new Int32Array(rowCount + 1)
  for (let row = 0; row < rowCount; row++) inputStart[row + 1] = inputStart[row]! + inputs[row]!.length
  const inputPosition = new Int32Array(inputStart[rowCount]!)
  const readerCount = new Int32Array(valueCount)
  for (let row = 0; row < rowCount; row++) {
    inputPosition.set(inputs[row]!, inputStart[row]!)
    for (const position of inputs[row]!) readerCount[position]!++
  }
  const readerStart = new Int32Array(valueCount + 1)
  for (let position = 0; position < valueCount; position++) readerStart[position + 1] = readerStart[position]! + readerCount[position]!
  const fill = new Int32Array(readerStart.subarray(0, valueCount))
  const readerRow = new Int32Array(readerStart[valueCount]!)
  for (let row = 0; row < rowCount; row++) {
    for (const position of inputs[row]!) readerRow[fill[position]!++] = row
  }
  if (sourceSize < 0) throw new Error('unreachable')
  return {program, inputStart, inputPosition, readerStart, readerRow}
}

export type DepthAnalysis = {
  // Longest chain of rows from sources ending at each packed value (0 for sources).
  depth: Int32Array
  // Longest chain of rows starting at each packed value (0 for sources).
  height: Int32Array
  layers: number
}

export function analyzeDepth(graph: Graph, isCut: Uint8Array): DepthAnalysis {
  const {program, inputStart, inputPosition} = graph
  const {rowCount, valueCount, sourceSize} = program
  const depth = new Int32Array(valueCount)
  let layers = 0
  for (let row = 0; row < rowCount; row++) {
    let deepest = 0
    for (let index = inputStart[row]!; index < inputStart[row + 1]!; index++) {
      const position = inputPosition[index]!
      if (isCut[position] === 1) continue
      const inputDepth = depth[position]!
      if (inputDepth > deepest) deepest = inputDepth
    }
    depth[sourceSize + row] = deepest + 1
    if (deepest + 1 > layers) layers = deepest + 1
  }
  const height = new Int32Array(valueCount)
  for (let row = rowCount - 1; row >= 0; row--) {
    const position = sourceSize + row
    if (height[position] === 0) height[position] = 1
    const rowHeight = height[position]!
    for (let index = inputStart[row]!; index < inputStart[row + 1]!; index++) {
      const input = inputPosition[index]!
      if (input < sourceSize || isCut[input] === 1) continue
      if (rowHeight + 1 > height[input]!) height[input] = rowHeight + 1
    }
  }
  return {depth, height, layers}
}

export function maskOf(program: FlatProgram, cuts: readonly number[]) {
  const mask = new Uint8Array(program.valueCount)
  for (const position of cuts) mask[position] = 1
  return mask
}

export function layersWithCuts(graph: Graph, cuts: readonly number[]) {
  return analyzeDepth(graph, maskOf(graph.program, cuts)).layers
}

// Values on some longest chain, grouped by depth. Every longest chain passes
// through exactly one critical value at each depth, so cutting every critical
// value at one depth breaks every longest chain.
export function criticalLevels(graph: Graph, analysis: DepthAnalysis): number[][] {
  const {program} = graph
  const levels: number[][] = Array.from({length: analysis.layers + 1}, () => [])
  for (let row = 0; row < program.rowCount; row++) {
    const position = program.sourceSize + row
    if (analysis.depth[position]! + analysis.height[position]! - 1 === analysis.layers) levels[analysis.depth[position]!]!.push(position)
  }
  return levels
}

// A minimum set of values to cut so that no chain is longer than `target`, among
// cuts that split each long chain once. A value v is cuttable when both parts of a
// chain split at v fit: depth(v) <= target and height(v) - 1 <= target. Capacities
// weight each value; the result minimizes their sum. Returns null when some long
// chain has no cuttable value.
export function minimumCut(graph: Graph, analysis: DepthAnalysis, isCut: Uint8Array, target: number, capacity: (position: number) => number): number[] | null {
  const {program, inputStart, inputPosition, readerStart, readerRow} = graph
  const {sourceSize, rowCount} = program
  const {depth, height} = analysis
  const long = (position: number) => position >= sourceSize && depth[position]! + height[position]! - 1 > target
  // Node ids: 0 is the source, 1 is the sink, value v gets 2 + 2k (in) and 3 + 2k (out).
  const nodeOf = new Int32Array(program.valueCount).fill(-1)
  const longValues: number[] = []
  for (let row = 0; row < rowCount; row++) {
    const position = sourceSize + row
    if (long(position)) {
      nodeOf[position] = 2 + 2 * longValues.length
      longValues.push(position)
    }
  }
  if (longValues.length === 0) return []
  const nodeCount = 2 + 2 * longValues.length
  const infinite = 1e18
  const edgeTo: number[] = []
  const edgeCapacity: number[] = []
  const edgeNext: number[] = []
  const head = new Int32Array(nodeCount).fill(-1)
  const addEdge = (from: number, to: number, amount: number) => {
    edgeTo.push(to); edgeCapacity.push(amount); edgeNext.push(head[from]!); head[from] = edgeTo.length - 1
    edgeTo.push(from); edgeCapacity.push(0); edgeNext.push(head[to]!); head[to] = edgeTo.length - 1
  }
  for (const position of longValues) {
    const inNode = nodeOf[position]!
    const cuttable = depth[position]! <= target && height[position]! - 1 <= target
    addEdge(inNode, inNode + 1, cuttable ? capacity(position) : infinite)
    let hasLongInput = false
    const row = position - sourceSize
    for (let index = inputStart[row]!; index < inputStart[row + 1]!; index++) {
      const input = inputPosition[index]!
      if (isCut[input] === 1 || nodeOf[input]! < 0) continue
      if (depth[input]! + height[position]! <= target) continue
      hasLongInput = true
      addEdge(nodeOf[input]! + 1, inNode, infinite)
    }
    // A long value with no input on a long chain starts its long chains.
    if (!hasLongInput) addEdge(0, inNode, infinite)
    let hasLongReader = false
    for (let index = readerStart[position]!; index < readerStart[position + 1]!; index++) {
      const reader = sourceSize + readerRow[index]!
      if (isCut[position] === 1 || nodeOf[reader]! < 0) continue
      if (depth[position]! + height[reader]! <= target) continue
      hasLongReader = true
    }
    if (!hasLongReader) addEdge(inNode + 1, 1, infinite)
  }
  // Dinic's algorithm.
  const level = new Int32Array(nodeCount)
  const iterator = new Int32Array(nodeCount)
  const queue = new Int32Array(nodeCount)
  let flow = 0
  for (;;) {
    level.fill(-1)
    level[0] = 0
    let queueHead = 0
    let queueTail = 0
    queue[queueTail++] = 0
    while (queueHead < queueTail) {
      const node = queue[queueHead++]!
      for (let edge = head[node]!; edge !== -1; edge = edgeNext[edge]!) {
        if (edgeCapacity[edge]! > 0 && level[edgeTo[edge]!] === -1) {
          level[edgeTo[edge]!] = level[node]! + 1
          queue[queueTail++] = edgeTo[edge]!
        }
      }
    }
    if (level[1] === -1) break
    iterator.set(head)
    const stackNode: number[] = []
    const stackEdge: number[] = []
    // Iterative depth-first search for blocking flow.
    for (;;) {
      stackNode.length = 0
      stackEdge.length = 0
      let node = 0
      let found = false
      while (true) {
        if (node === 1) { found = true; break }
        let advanced = false
        while (iterator[node] !== -1) {
          const edge = iterator[node]!
          const to = edgeTo[edge]!
          if (edgeCapacity[edge]! > 0 && level[to] === level[node]! + 1) {
            stackNode.push(node)
            stackEdge.push(edge)
            node = to
            advanced = true
            break
          }
          iterator[node] = edgeNext[edge]!
        }
        if (advanced) continue
        if (stackNode.length === 0) break
        level[node] = -1
        node = stackNode.pop()!
        const edge = stackEdge.pop()!
        iterator[node] = edgeNext[edge]!
      }
      if (!found) break
      let amount = infinite
      for (const edge of stackEdge) amount = Math.min(amount, edgeCapacity[edge]!)
      if (amount >= infinite) return null
      for (const edge of stackEdge) {
        edgeCapacity[edge] = edgeCapacity[edge]! - amount
        edgeCapacity[edge ^ 1] = edgeCapacity[edge ^ 1]! + amount
      }
      flow += amount
      if (flow >= infinite) return null
    }
  }
  // Values whose in-node is reachable from the source and out-node isn't are cut.
  const reachable = new Uint8Array(nodeCount)
  reachable[0] = 1
  const stack = [0]
  while (stack.length > 0) {
    const node = stack.pop()!
    for (let edge = head[node]!; edge !== -1; edge = edgeNext[edge]!) {
      if (edgeCapacity[edge]! > 0 && reachable[edgeTo[edge]!] === 0) {
        reachable[edgeTo[edge]!] = 1
        stack.push(edgeTo[edge]!)
      }
    }
  }
  const cuts: number[] = []
  for (const position of longValues) {
    const inNode = nodeOf[position]!
    if (reachable[inNode] === 1 && reachable[inNode + 1] === 0) cuts.push(position)
  }
  return cuts
}

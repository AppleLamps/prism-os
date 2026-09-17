// Plain JavaScript around the GPU measurement of form (c)'s tree, shared by the page and the Bun scripts:
// - classInputs: for a pattern and a text, the class of every code point and one S × S 0/1 matrix per class.
// - createLeafWriter: the (S + 1) × (S + 1) leaf matrices the GPU multiplies, written from the class matrices.
// - gpuPlan: form (c)'s prefix network as slots and one list of combines per level and per kind of product.
// - denseReach, bitmaskReach: two plain JavaScript loops over the automaton that compute the same bits.
// Every version returns the reach bits: reach[j][s] is 1 when some path from state s at position j reads at least one
// code point and ends in an accepting state, i.e. form (a)'s reverse pass, and form (c)'s longestEnds[j][s] > 0. They're
// packed as one 32-bit word per position, with bit s for state s, since S ≤ 32.
import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {codePointsOf} from '../host.ts'
import type {CompiledPattern} from '../pattern.ts'
import {sampleText} from '../sample-text.ts'
import {prefixNetworkPlan} from '../tree-inputs.ts'
import type {PrefixNetwork} from '../tree-program.ts'

// The same text as report.ts: sample-text.ts's prose, repeated and cut to textLength code points.
export const textOf = (textLength: number) => codePointsOf(sampleText.repeat(Math.ceil(textLength / sampleText.length))).slice(0, textLength)

export type ClassInputs = {
  states: number
  textLength: number
  // The automaton's classes, plus a last class for the code points that no step reads, whose matrix is all 0.
  classCount: number
  // classOf[j] is the class of code point j.
  classOf: Uint8Array
  // classMatrices[(c × S + s) × S + t] is 1 when a step from state s reads a code point of class c and goes to state t,
  // the cell transitions[c][s][t] that writePattern writes.
  classMatrices: Uint8Array
  accepting: Uint8Array
}

// Positions from codePoints.length to textLength - 1 are past the end of the text, like form (a)'s -1 cells, and get the
// last class, whose matrix is all 0.
export function classInputs({automaton, partition}: CompiledPattern, codePoints: readonly number[], states: number, textLength = codePoints.length): ClassInputs {
  invariant(automaton.stateCount <= states, `the pattern needs ${automaton.stateCount} states, and the matrices hold ${states}`)
  invariant(codePoints.length <= textLength, `the text has ${codePoints.length} code points, and the tree holds ${textLength}`)
  const classCount = partition.classCount + 1
  const targets = automaton.targets.map(stateTargets => new Set(stateTargets))
  const classMatrices = new Uint8Array(classCount * states * states)
  partition.classReads.forEach((reads, classIndex) => {
    for (let from = 0; from < automaton.stateCount; from++) {
      for (let to = 0; to < automaton.stateCount; to++) {
        if (reads[to] === true && targets[from]!.has(to)) classMatrices[(classIndex * states + from) * states + to] = 1
      }
    }
  })
  const {boundaries, regionClasses} = partition
  const classOf = new Uint8Array(textLength).fill(classCount - 1)
  codePoints.forEach((codePoint, position) => {
    // The region is the number of boundaries at or below the code point.
    let low = 0
    let high = boundaries.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (boundaries[middle]! <= codePoint) low = middle + 1
      else high = middle
    }
    const classIndex = regionClasses[low]!
    classOf[position] = classIndex === -1 ? classCount - 1 : classIndex
  })
  const accepting = Uint8Array.from({length: states}, (_, state) => automaton.accepting[state] === true ? 1 : 0)
  return {states, textLength, classCount, classOf, classMatrices, accepting}
}

// JS: reach[j][s] = states.some(t => step[j][s][t] && (accepting[t] || reach[j + 1][t])), from the end of the text, with
// S × S reads per position and no early exit, like one step of form (a)'s reverse pass. Writes N × S bytes into reach.
export function denseReach({states, textLength, classOf, classMatrices, accepting}: ClassInputs, reach: Uint8Array) {
  const finishes = Uint8Array.from(accepting)
  for (let position = textLength - 1; position >= 0; position--) {
    const classBase = classOf[position]! * states * states
    const out = position * states
    for (let from = 0; from < states; from++) {
      const row = classBase + from * states
      let bit = 0
      for (let to = 0; to < states; to++) bit |= classMatrices[row + to]! & finishes[to]!
      reach[out + from] = bit
    }
    for (let state = 0; state < states; state++) finishes[state] = accepting[state]! | reach[out + state]!
  }
}

export type BitmaskInputs = {states: number, textLength: number, classOf: Uint8Array, rows: Uint32Array, acceptingMask: number}

// rows[c × S + s] has bit t set when a step from state s reads a code point of class c and goes to state t.
export function bitmaskInputs({states, textLength, classCount, classOf, classMatrices, accepting}: ClassInputs): BitmaskInputs {
  invariant(states <= 32, `a row of ${states} states doesn't fit in 32 bits`)
  const rows = new Uint32Array(classCount * states)
  for (let row = 0; row < classCount * states; row++) {
    let word = 0
    for (let to = 0; to < states; to++) if (classMatrices[row * states + to] === 1) word |= 1 << to
    rows[row] = word
  }
  let acceptingMask = 0
  accepting.forEach((bit, state) => {
    if (bit === 1) acceptingMask |= 1 << state
  })
  return {states, textLength, classOf, rows, acceptingMask}
}

// The same loop as denseReach with every matrix row as a 32-bit word: S word operations per position instead of S × S
// reads. Writes one word per position into words.
export function bitmaskReach({states, textLength, classOf, rows, acceptingMask}: BitmaskInputs, words: Uint32Array) {
  let finishes = acceptingMask
  for (let position = textLength - 1; position >= 0; position--) {
    const base = classOf[position]! * states
    let word = 0
    for (let from = 0; from < states; from++) if ((rows[base + from]! & finishes) !== 0) word |= 1 << from
    words[position] = word
    finishes = acceptingMask | word
  }
}

export function packReach(reach: Uint8Array, states: number, textLength: number): Uint32Array {
  invariant(states <= 32, `a row of ${states} states doesn't fit in 32 bits`)
  const words = new Uint32Array(textLength)
  for (let position = 0; position < textLength; position++) {
    let word = 0
    for (let state = 0; state < states; state++) if (reach[position * states + state] === 1) word |= 1 << state
    words[position] = word
  }
  return words
}

// A[j] = [[T[j], T[j] × accepting], [0, 1]] as (S + 1) × (S + 1) floats, the same matrices as tree-inputs.ts's
// augmentedLeaves: the last column of the clamped product A[j] × … × A[N − 1] holds reach[j], followed by a 1.
export function createLeafWriter({states, textLength, classCount, classOf, classMatrices, accepting}: ClassInputs) {
  const size = states + 1
  const perClass = new Float32Array(classCount * size * size)
  for (let classIndex = 0; classIndex < classCount; classIndex++) {
    const base = classIndex * size * size
    for (let from = 0; from < states; from++) {
      let finishes = 0
      for (let to = 0; to < states; to++) {
        const step = classMatrices[(classIndex * states + from) * states + to]!
        perClass[base + from * size + to] = step
        if (step === 1 && accepting[to] === 1) finishes = 1
      }
      perClass[base + from * size + states] = finishes
    }
    perClass[base + states * size + states] = 1
  }
  const views = Array.from({length: classCount}, (_, classIndex) => perClass.subarray(classIndex * size * size, (classIndex + 1) * size * size))
  return {
    size,
    // perClass[(c × size + s) × size + t] is entry (s, t) of the leaf of a code point of class c.
    perClass,
    // Writes every leaf into leaves, N × size × size floats in text order, and the last leaf's last column into lastColumn.
    write(leaves: Float32Array, lastColumn: Float32Array) {
      for (let position = 0; position < textLength; position++) leaves.set(views[classOf[position]!]!, position * size * size)
      const last = (textLength - 1) * size * size
      for (let row = 0; row < size; row++) lastColumn[row] = leaves[last + row * size + states]!
    },
  }
}

// Form (c)'s network as GPU work, over two kinds of slots:
// - A matrix slot holds an (S + 1) × (S + 1) matrix. Slots 0..N − 1 are the leaves in text order, and the others are
//   the results of combines that multiply two matrices.
// - A vector slot holds the last column of a suffix product. Vector slot j is position j's, so reading slots 0..N − 1
//   in order gives the reach bits. Slot N − 1 is the last leaf's last column, and every other vector slot is the result
//   of a combine that multiplies a matrix with a vector.
// A level's combines of one kind are triples [earlier matrix slot, later slot, result slot] in matrixTriples or
// vectorTriples, from offset to offset + count. A combine reads only slots written by earlier levels, so one dispatch
// can run all of a level's combines of one kind at once.
export type GpuLevel = {matrixOffset: number, matrixCount: number, vectorOffset: number, vectorCount: number}
export type GpuPlan = {textLength: number, matrixSlots: number, levels: GpuLevel[], matrixTriples: Uint32Array, vectorTriples: Uint32Array}

export function gpuPlan(textLength: number, network: PrefixNetwork = 'brent-kung'): GpuPlan {
  const plan = prefixNetworkPlan(textLength, network)
  invariant(plan.suffixNodes[textLength - 1] === textLength - 1, 'the suffix at the last position is its own leaf')
  const vectorSlots = new Map(plan.suffixNodes.map((node, position) => [node, position]))
  const matrixSlots = new Map<number, number>()
  const slotOf = (slots: Map<number, number>, node: number, kind: string) => {
    const slot = slots.get(node)
    invariant(slot !== undefined, `node ${node} has no ${kind} slot`)
    return slot
  }
  const matrixSlotOf = (node: number) => node < textLength ? node : slotOf(matrixSlots, node, 'matrix')
  const matrixTriples: number[] = []
  const vectorTriples: number[] = []
  const levels = plan.levels.map((level): GpuLevel => {
    const matrixOffset = matrixTriples.length / 3
    const vectorOffset = vectorTriples.length / 3
    for (const {result, earlier, later, laterIsSuffix} of level) {
      if (laterIsSuffix) {
        vectorTriples.push(matrixSlotOf(earlier), slotOf(vectorSlots, later, 'vector'), slotOf(vectorSlots, result, 'vector'))
      } else {
        const slot = textLength + matrixSlots.size
        matrixSlots.set(result, slot)
        matrixTriples.push(matrixSlotOf(earlier), matrixSlotOf(later), slot)
      }
    }
    return {matrixOffset, matrixCount: matrixTriples.length / 3 - matrixOffset, vectorOffset, vectorCount: vectorTriples.length / 3 - vectorOffset}
  })
  invariant(vectorTriples.length / 3 === textLength - 1, 'every position but the last is the result of one combine with a vector')
  return {textLength, matrixSlots: textLength + matrixSlots.size, levels, matrixTriples: Uint32Array.from(matrixTriples), vectorTriples: Uint32Array.from(vectorTriples)}
}

// The plan with the kernels' arithmetic in JavaScript: result = min(1, earlier × later), one level at a time. Returns the
// reach words, for checking a plan without a GPU.
export function runGpuPlanInJavaScript(plan: GpuPlan, states: number, leaves: Float32Array, lastColumn: Float32Array): Uint32Array {
  const size = states + 1
  const area = size * size
  const matrices = new Float32Array(plan.matrixSlots * area)
  matrices.set(leaves)
  const vectors = new Float32Array(plan.textLength * size)
  vectors.set(lastColumn, (plan.textLength - 1) * size)
  for (const {matrixOffset, matrixCount, vectorOffset, vectorCount} of plan.levels) {
    for (let combine = matrixOffset; combine < matrixOffset + matrixCount; combine++) {
      const earlier = plan.matrixTriples[combine * 3]! * area
      const later = plan.matrixTriples[combine * 3 + 1]! * area
      const result = plan.matrixTriples[combine * 3 + 2]! * area
      for (let from = 0; from < size; from++) {
        for (let to = 0; to < size; to++) {
          let total = 0
          for (let middle = 0; middle < size; middle++) total += matrices[earlier + from * size + middle]! * matrices[later + middle * size + to]!
          matrices[result + from * size + to] = Math.min(total, 1)
        }
      }
    }
    for (let combine = vectorOffset; combine < vectorOffset + vectorCount; combine++) {
      const earlier = plan.vectorTriples[combine * 3]! * area
      const later = plan.vectorTriples[combine * 3 + 1]! * size
      const result = plan.vectorTriples[combine * 3 + 2]! * size
      for (let from = 0; from < size; from++) {
        let total = 0
        for (let middle = 0; middle < size; middle++) total += matrices[earlier + from * size + middle]! * vectors[later + middle]!
        vectors[result + from] = Math.min(total, 1)
      }
    }
  }
  const words = new Uint32Array(plan.textLength)
  for (let position = 0; position < plan.textLength; position++) {
    let word = 0
    for (let state = 0; state < states; state++) if (vectors[position * size + state]! > 0.5) word |= 1 << state
    words[position] = word
  }
  return words
}

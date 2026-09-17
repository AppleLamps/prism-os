// Plain JavaScript around form (c)'s tree, for tests and for another executor of the same tree, e.g. a GPU kernel that
// multiplies one level of pairs per dispatch:
// - productTreeInputs: for a pattern and a text, one S × S 0/1 matrix per code point, the accepting states, and what the
//   program computes at every position, from a loop over positions written from the definition, not from the tree.
// - prefixNetworkPlan: the combines of form (c)'s network in levels, where every combine of a level reads only leaves and
//   results of earlier levels.
// - runPlanInJavaScript: the plan over the leaves, with the same arithmetic as the program.
// - augmentedLeaves: (S + 1) × (S + 1) 0/1 matrices whose clamped products give the reach bits without integers.
import {invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type CompiledPattern, setContains} from './pattern.ts'
import {brentKungPrefix, sklanskyPrefix} from './prefix-networks.ts'
import type {PrefixNetwork} from './tree-program.ts'

export type ProductTreeInputs = {
  // S, the matrix size, which can be larger than the automaton's state count. Extra states have no steps.
  states: number
  // N, the number of positions. Positions past the end of the text have zero matrices.
  textLength: number
  // leaves[(j × S + s) × S + t] is 1 when a step from state s reads code point j and goes to state t, i.e. the cell
  // transitions[class of code point j][s][t] that form (a) and form (c) read.
  leaves: Uint8Array
  // accepting[s] is 1 for an accepting state.
  accepting: Uint8Array
  // longestEnds[j × S + s] is the end of the longest path from state s at position j that reads at least one code point
  // and ends in an accepting state, or 0 when no such path exists. longestEnds[j × S + 0] is the end of the longest match
  // that starts at j.
  longestEnds: Int32Array
  // reach[j × S + s] is 1 when longestEnds[j × S + s] > 0, the bit form (a)'s reverse pass computes.
  reach: Uint8Array
}

export function productTreeInputs({automaton}: CompiledPattern, codePoints: readonly number[], {states, textLength}: {states: number, textLength: number}): ProductTreeInputs {
  invariant(automaton.stateCount <= states, `the pattern needs ${automaton.stateCount} states, and the matrices hold ${states}`)
  invariant(codePoints.length <= textLength, `the text has ${codePoints.length} code points, and the tree holds ${textLength}`)
  const targets = automaton.targets.map(stateTargets => new Set(stateTargets))
  const leaves = new Uint8Array(textLength * states * states)
  codePoints.forEach((codePoint, position) => {
    for (let to = 0; to < automaton.stateCount; to++) {
      if (!setContains(automaton.stateSets[to]!, codePoint)) continue
      for (let from = 0; from < automaton.stateCount; from++) {
        if (targets[from]!.has(to)) leaves[(position * states + from) * states + to] = 1
      }
    }
  })
  const accepting = new Uint8Array(states)
  automaton.accepting.forEach((isAccepting, state) => {
    accepting[state] = isAccepting ? 1 : 0
  })
  const longestEnds = new Int32Array(textLength * states)
  for (let position = textLength - 1; position >= 0; position--) {
    for (let from = 0; from < states; from++) {
      let end = 0
      for (let to = 0; to < states; to++) {
        if (leaves[(position * states + from) * states + to] === 0) continue
        if (accepting[to] === 1) end = Math.max(end, position + 1)
        if (position + 1 < textLength) end = Math.max(end, longestEnds[(position + 1) * states + to]!)
      }
      longestEnds[position * states + from] = end
    }
  }
  const reach = Uint8Array.from(longestEnds, end => end > 0 ? 1 : 0)
  return {states, textLength, leaves, accepting, longestEnds, reach}
}

// Node k < textLength is the leaf of position k. Node textLength + i is the result of combine i. A combine's result
// covers the positions of `earlier` followed by the positions of `later`, and when `later` reaches the end of the text,
// only the result's ends are used, so a combine with laterIsSuffix can skip the matrix product.
export type Combine = {result: number, earlier: number, later: number, laterIsSuffix: boolean}
export type PrefixNetworkPlan = {
  textLength: number
  levels: Combine[][]
  // suffixNodes[j] is the node whose ends are longestEnds at position j.
  suffixNodes: number[]
}

export function prefixNetworkPlan(textLength: number, network: PrefixNetwork): PrefixNetworkPlan {
  type Node = {node: number, level: number, suffix: boolean}
  const combines: (Combine & {level: number})[] = []
  // The same order as buildTreeSearch: from the end of the text, and item 0 is a suffix.
  const items: Node[] = Array.from({length: textLength}, (_, index) => ({node: textLength - 1 - index, level: 0, suffix: index === 0}))
  const prefix = network === 'sklansky' ? sklanskyPrefix : brentKungPrefix
  const suffixes = prefix(items, (laterInText, earlierInText) => {
    invariant(!earlierInText.suffix, 'a combine reads a suffix as its earlier block')
    const combine = {result: textLength + combines.length, earlier: earlierInText.node, later: laterInText.node, laterIsSuffix: laterInText.suffix, level: 1 + Math.max(laterInText.level, earlierInText.level)}
    combines.push(combine)
    return {node: combine.result, level: combine.level, suffix: laterInText.suffix}
  }).toReversed()
  const levels: Combine[][] = []
  for (const {level, ...combine} of combines) (levels[level - 1] ??= []).push(combine)
  return {textLength, levels, suffixNodes: suffixes.map(suffix => suffix.node)}
}

// The plan's arithmetic in JavaScript: matrix = clamp(earlier.matrix × later.matrix), and ends[s] = Math.max(earlier.ends[s],
// ...states.map(u => earlier.matrix[s][u] ? later.ends[u] : 0)). Returns longestEnds as productTreeInputs lays it out.
export function runPlanInJavaScript({states, textLength, leaves, accepting}: ProductTreeInputs, plan: PrefixNetworkPlan): Int32Array {
  invariant(plan.textLength === textLength, 'the plan is for a different text length')
  const nodeCount = textLength + plan.levels.reduce((total, level) => total + level.length, 0)
  const matrices = Array<Uint8Array | undefined>(nodeCount)
  const ends = Array<Int32Array>(nodeCount)
  for (let position = 0; position < textLength; position++) {
    const matrix = leaves.subarray(position * states * states, (position + 1) * states * states)
    matrices[position] = matrix
    ends[position] = Int32Array.from({length: states}, (_, from) => {
      for (let to = 0; to < states; to++) if (matrix[from * states + to] === 1 && accepting[to] === 1) return position + 1
      return 0
    })
  }
  for (const level of plan.levels) {
    for (const {result, earlier, later, laterIsSuffix} of level) {
      const earlierMatrix = matrices[earlier]!
      const resultEnds = new Int32Array(states)
      for (let from = 0; from < states; from++) {
        let end = ends[earlier]![from]!
        for (let middle = 0; middle < states; middle++) {
          if (earlierMatrix[from * states + middle] === 1) end = Math.max(end, ends[later]![middle]!)
        }
        resultEnds[from] = end
      }
      ends[result] = resultEnds
      if (laterIsSuffix) continue
      const laterMatrix = matrices[later]!
      const product = new Uint8Array(states * states)
      for (let from = 0; from < states; from++) {
        for (let middle = 0; middle < states; middle++) {
          if (earlierMatrix[from * states + middle] === 0) continue
          for (let to = 0; to < states; to++) product[from * states + to] ||= laterMatrix[middle * states + to]!
        }
      }
      matrices[result] = product
    }
  }
  const longestEnds = new Int32Array(textLength * states)
  plan.suffixNodes.forEach((node, position) => longestEnds.set(ends[node]!, position * states))
  return longestEnds
}

// A[j] = [[leaf j, leaf j × accepting], [0, 1]], of size (S + 1) × (S + 1), so that [reach at j, 1] = A[j] × [reach at
// j + 1, 1] with 0/1 products clamped to 0/1. The reach bits at position j are the first S entries of the last column
// of the clamped product A[j] × A[j + 1] × … × A[N - 1].
export function augmentedLeaves({states, textLength, leaves, accepting}: ProductTreeInputs): Uint8Array {
  const size = states + 1
  const augmented = new Uint8Array(textLength * size * size)
  for (let position = 0; position < textLength; position++) {
    const base = position * size * size
    for (let from = 0; from < states; from++) {
      let finishes = 0
      for (let to = 0; to < states; to++) {
        const step = leaves[(position * states + from) * states + to]!
        augmented[base + from * size + to] = step
        if (step === 1 && accepting[to] === 1) finishes = 1
      }
      augmented[base + from * size + states] = finishes
    }
    augmented[base + states * size + states] = 1
  }
  return augmented
}

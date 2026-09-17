// The highest score, in a tree: e.g. picking the candidate layout that fits the viewport best, like
// candidate-gallery.ts's choice among its cinema, contact sheet and story layouts.
//
// JS, keeping the best so far, with ties going to the earlier candidate:
//   let bestLayout = 0
//   for (let layout = 1; layout < scores.length; layout++) {
//     if (scores[layout] > scores[bestLayout]) bestLayout = layout
//   }
//
// emitArgmax in numeric-ui-core.ts compares neighboring scores up a balanced tree with boolean atoms,
// keeps the larger score of each pair, and routes a 1 back down to the highest score. emitHighestScoreExact
// below builds the same tree with emitCompare's exact comparisons, the variant lab/cascade-argmax built
// by hand before emitCompare existed.
import {Circuit, emitArgmax, emitCompare, emitSelect, invariant, type Wire} from '../../../../../../src/runtime/numeric-ui-core.ts'

export function highestScoreReference(scores: ArrayLike<number>): number {
  let bestCandidate = 0
  for (let candidate = 1; candidate < scores.length; candidate++) {
    if (scores[candidate]! > scores[bestCandidate]!) bestCandidate = candidate
  }
  return bestCandidate
}

export type Grouping = 'balanced' | 'chain'

type ScoreNode =
  | {score: Wire, item: number}
  | {score: Wire, rightIsLarger: Wire, left: ScoreNode, right: ScoreNode}

// [right > left] from emitCompare is exact for every pair of values within the declared ranges, so the
// right candidate is kept only when its score is strictly larger, and on a tie the left one is kept. That combining
// step selects the same candidate however the candidates are grouped, so 'chain', which combines in the
// loop's order, and 'balanced', a tree, select the same candidate. Scores need finite declared ranges,
// and don't have to lie within 0..1.
export function emitHighestScoreExact(
  circuit: Circuit,
  scores: readonly Wire[],
  unit: Wire,
  grouping: Grouping,
): {selected: Wire[], score: Wire} {
  invariant(scores.length > 0, 'a selection needs at least one score')
  const combine = (left: ScoreNode, right: ScoreNode): ScoreNode => {
    const rightIsLarger = emitCompare(circuit, right.score, '>', left.score)
    const score = emitSelect(circuit, rightIsLarger, left.score, right.score)
    // With an exact bit as the gate, the select returns exactly one of the two scores.
    const leftRange = circuit.ranges[left.score]!
    const rightRange = circuit.ranges[right.score]!
    circuit.assumeRange(
      score,
      Math.min(leftRange.minimum, rightRange.minimum),
      Math.max(leftRange.maximum, rightRange.maximum),
    )
    return {score, rightIsLarger, left, right}
  }
  let level: ScoreNode[] = scores.map((score, item) => ({score, item}))
  if (grouping === 'chain') {
    let best = level[0]!
    for (let item = 1; item < level.length; item++) best = combine(best, level[item]!)
    level = [best]
  }
  while (level.length > 1) {
    const next: ScoreNode[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : combine(level[index]!, right))
    }
    level = next
  }
  const root = level[0]!
  const selected = Array<Wire>(scores.length)
  // The unit travels down the recorded decisions, so exactly one candidate receives it.
  const route = (node: ScoreNode, routeWire: Wire) => {
    if ('item' in node) {
      selected[node.item] = routeWire
      return
    }
    const rightRoute = circuit.multiply(routeWire, node.rightIsLarger)
    const leftRoute = circuit.affine([[routeWire, 1], [rightRoute, -1]])
    circuit.assumeRange(leftRoute, 0, 1)
    route(node.left, leftRoute)
    route(node.right, rightRoute)
  }
  route(root, unit)
  circuit.assumeOneHot(selected)
  return {selected, score: root.score}
}

export type HighestScoreForm = 'emitArgmax' | 'exact tree' | 'exact chain'

// Source table: [unit, then a score and a thumbnail width for each candidate layout]. The unit cell
// holds 1. Scores are within 0..1, and with {grid}, e.g. 1/64, they're declared on that grid, so
// emitCompare builds integer bits instead of a sign cascade.
export function buildBestLayout(layoutCount: number, form: HighestScoreForm, options: {grid?: number} = {}) {
  const circuit = new Circuit(1 + 2 * layoutCount)
  const unit = circuit.source(0)
  circuit.assumeRange(unit, 1, 1)
  const scores = Array.from({length: layoutCount}, (_, layout) => circuit.source(1 + 2 * layout))
  const thumbnailWidths = Array.from({length: layoutCount}, (_, layout) => circuit.source(2 + 2 * layout))
  for (const score of scores) {
    circuit.assumeRange(score, 0, 1)
    if (options.grid !== undefined) circuit.assumeGrid(score, options.grid)
  }
  for (const width of thumbnailWidths) circuit.assumeRange(width, 0, 16_384)
  const {selected, score} = form === 'emitArgmax'
    ? emitArgmax(circuit, scores, unit)
    : emitHighestScoreExact(circuit, scores, unit, form === 'exact tree' ? 'balanced' : 'chain')
  const bestLayout = circuit.roundAffine(selected.map((bit, layout) => [bit, layout] as const))
  // The chosen layout's thumbnail width: a masked sum over the one-hot, which the compiler lowers to
  // one gather.
  const chosenThumbnailWidth = circuit.affine(
    selected.map((bit, layout) => [circuit.multiply(thumbnailWidths[layout]!, bit), 1] as const),
  )
  return {circuit, unit, scores, thumbnailWidths, selected, score, bestLayout, chosenThumbnailWidth}
}

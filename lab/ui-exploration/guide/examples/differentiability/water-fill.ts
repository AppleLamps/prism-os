// Implicit differentiation of a layout solver's result, in plain float64 JS.
//
// A row of children grows to fill a container, each in proportion to its grow
// weight and none past its maximum width, like CSS flex-grow for children with
// flex-basis: 0, min-width: 0 and a max-width. The solver finds a level λ where
//   F(λ) = sum over children of min(maximumWidth_i, λ × growWeight_i) − containerWidth = 0
// and each child is min(maximumWidth_i, λ × growWeight_i) wide.
//
// Here the solver is a bisection loop, a stand-in for any loop that runs until it
// settles. Differentiating that loop step by step gives 0: each round only
// copies a bound after a comparison. Implicit differentiation differentiates the
// equation F(λ, parameters) = 0 at the solution instead:
//   dλ/dparameter = −(∂F/∂parameter) / (∂F/∂λ)
// where ∂F/∂λ is the sum of the grow weights of children below their maximum.

export type GrowRow = {
  containerWidth: number
  growWeights: readonly number[]
  maximumWidths: readonly number[]
}

function filledWidth(row: GrowRow, level: number) {
  let total = 0
  for (let child = 0; child < row.growWeights.length; child++) {
    total += Math.min(row.maximumWidths[child]!, level * row.growWeights[child]!)
  }
  return total
}

function highestLevel(row: GrowRow) {
  return Math.max(...row.maximumWidths.map((maximum, child) => maximum / row.growWeights[child]!))
}

export function solveLevelByBisection(row: GrowRow, rounds = 200) {
  let low = 0
  let high = highestLevel(row)
  for (let round = 0; round < rounds; round++) {
    const middle = (low + high) / 2
    if (filledWidth(row, middle) < row.containerWidth) low = middle
    else high = middle
  }
  return (low + high) / 2
}

// The same loop with a derivative carried next to every number (forward-mode
// differentiation, i.e. dual numbers), with respect to the container width. The
// bounds start as constants and are only ever copied from the middle, so every
// derivative stays 0.
export function bisectionLevelDerivative(row: GrowRow, rounds = 200) {
  let low = {value: 0, derivative: 0}
  let high = {value: highestLevel(row), derivative: 0}
  for (let round = 0; round < rounds; round++) {
    const middle = {value: (low.value + high.value) / 2, derivative: (low.derivative + high.derivative) / 2}
    if (filledWidth(row, middle.value) < row.containerWidth) low = middle
    else high = middle
  }
  return (low.derivative + high.derivative) / 2
}

export function childWidths(row: GrowRow, level: number) {
  return row.growWeights.map((weight, child) => Math.min(row.maximumWidths[child]!, level * weight))
}

export type LevelGradient = {
  containerWidth: number
  maximumWidths: number[]
  growWeights: number[]
}

export function levelGradientByImplicitDifferentiation(row: GrowRow, level: number): LevelGradient {
  const growing = row.growWeights.map((weight, child) => level * weight < row.maximumWidths[child]!)
  const growingWeight = row.growWeights.reduce((sum, weight, child) => (growing[child] ? sum + weight : sum), 0)
  return {
    // ∂F/∂containerWidth = −1
    containerWidth: 1 / growingWeight,
    // ∂F/∂maximumWidth_j = 1 for a child at its maximum, 0 otherwise
    maximumWidths: growing.map(isGrowing => (isGrowing ? 0 : -1 / growingWeight)),
    // ∂F/∂growWeight_j = λ for a growing child, 0 otherwise
    growWeights: growing.map(isGrowing => (isGrowing ? -level / growingWeight : 0)),
  }
}

export function randomGrowRow(random: () => number, childCount = 6): GrowRow {
  const growWeights = Array.from({length: childCount}, () => 1 + Math.round(4 * random()) / 2)
  const maximumWidths = Array.from({length: childCount}, () => 80 + Math.round(320 * random()))
  const total = maximumWidths.reduce((sum, width) => sum + width, 0)
  return {containerWidth: Math.round(total * (0.3 + 0.6 * random())), growWeights, maximumWidths}
}

export type WaterFillCheck = {
  rows: number
  pairs: number
  // Pairs skipped because a child reaches or leaves its maximum within the difference's step.
  pairsAcrossAClamp: number
  largestRelativeError: number
  largestBisectionDerivative: number
}

export function checkWaterFill(random: () => number, rowCount = 50): WaterFillCheck {
  const result: WaterFillCheck = {rows: rowCount, pairs: 0, pairsAcrossAClamp: 0, largestRelativeError: 0, largestBisectionDerivative: 0}
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = randomGrowRow(random)
    const level = solveLevelByBisection(row)
    const implicit = levelGradientByImplicitDifferentiation(row, level)
    result.largestBisectionDerivative = Math.max(result.largestBisectionDerivative, Math.abs(bisectionLevelDerivative(row)))
    const growingSet = (candidate: GrowRow, candidateLevel: number) =>
      candidate.growWeights.map((weight, child) => candidateLevel * weight < candidate.maximumWidths[child]!).join()
    const baseSet = growingSet(row, level)
    const compare = (implicitValue: number, change: (step: number) => GrowRow, scale: number) => {
      const step = 1e-6 * scale
      const below = change(-step)
      const above = change(step)
      const levelBelow = solveLevelByBisection(below)
      const levelAbove = solveLevelByBisection(above)
      if (growingSet(below, levelBelow) !== baseSet || growingSet(above, levelAbove) !== baseSet) {
        result.pairsAcrossAClamp++
        return
      }
      result.pairs++
      const finiteDifference = (levelAbove - levelBelow) / (2 * step)
      const error = Math.abs(implicitValue - finiteDifference) / Math.max(Math.abs(finiteDifference), 1e-9)
      result.largestRelativeError = Math.max(result.largestRelativeError, error)
    }
    compare(implicit.containerWidth, step => ({...row, containerWidth: row.containerWidth + step}), row.containerWidth)
    for (let child = 0; child < row.growWeights.length; child++) {
      compare(implicit.maximumWidths[child]!, step => ({...row, maximumWidths: row.maximumWidths.map((width, index) => (index === child ? width + step : width))}), row.maximumWidths[child]!)
      compare(implicit.growWeights[child]!, step => ({...row, growWeights: row.growWeights.map((weight, index) => (index === child ? weight + step : weight))}), row.growWeights[child]!)
    }
  }
  return result
}

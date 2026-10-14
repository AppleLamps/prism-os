import {
  Circuit,
  type Wire,
  assertFiniteValues,
  asWire,
  emitMultiply,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from '../../src/runtime/numeric-ui-core.ts'

export const trainableGeometryField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  size: 4,
} as const

export type TrainableGeometry = {
  left: number
  top: number
  width: number
  height: number
}

export type TrainableGeometryTarget = {
  geometries: Float32Array
  active: Uint8Array
  // Which output rectangles the active targets are fitted with, 1 for as many slots as there are active targets.
  // Without it they are the first outputs, e.g. outputs 0 to 9 for 10 targets.
  outputs?: Uint8Array
}

type ParameterLayout = {
  firstLeftWeights: number
  firstLeftBiases: number
  firstGateWeights: number
  firstGateBiases: number
  secondLeftWeights: number
  secondLeftBiases: number
  secondGateWeights: number
  secondGateBiases: number
  outputWeights: number
  outputBiases: number
  size: number
}

export type TrainableGeometryOptions = {
  slotCount?: number
  hiddenWidth?: number
  seed?: number
  learningRate?: number
  weightDecay?: number
  matching?: 'assignment' | 'ordered'
  positionalFrequencyCount?: number
}

const outputFieldCount = trainableGeometryField.size
// The four kinds of edge of a rectangle: left, right, top and bottom. An edge is the rectangle's position on the
// kind's axis, plus its size on that axis for a right or a bottom edge.
const edgeKinds = [
  {positionField: trainableGeometryField.left, sizeField: trainableGeometryField.width, far: 0},
  {positionField: trainableGeometryField.left, sizeField: trainableGeometryField.width, far: 1},
  {positionField: trainableGeometryField.top, sizeField: trainableGeometryField.height, far: 0},
  {positionField: trainableGeometryField.top, sizeField: trainableGeometryField.height, far: 1},
] as const

// The loss has two parts. Both are means over the target's rectangles and their four edges.
//
// 1. The distance from the target: the Huber loss of each output edge against its target rectangle's edge, i.e.
//    half the squared error up to an error of geometryLossThreshold and linear beyond it, e.g. 5e-7 for an edge
//    that is 0.1% of the stage off. The four edges are compared, and not left, top, width and height, because
//    the penalty pulls on edges: with a loss on the width, a pull on a right edge also moved the left edge, and
//    a corner resized by 11 px ended neither in line nor on its rectangle. The price is a first fit that is less
//    close: the page's Story sketch ends with one edge 0.15% of the stage from where it is drawn, and it was
//    0.03% with a loss on left, top, width and height (October 14, 2026).
// 2. The misalignment penalty, which reads only the outputs and never the target: every two output rectangles
//    are charged for the gap between their edges of one kind, i.e. left with left, right with right, top with top
//    and bottom with bottom. pairCost is the charge and pairPull its slope.
const geometryLossThreshold = 0.08

// The penalty's pull between two edges of one kind is penaltyStiffness times their gap, and at most the reach
// minus the gap. So it is strongest between edges that are nearly in line, it falls to 0 at a gap of one reach,
// and edges a reach or more apart are left alone. A limit that falls from a gap of 0 is the form that kept photos
// in line over sessions of edits: with a limit that stayed full for the first 2 px of a gap, 21% of a session's
// edits ended with two photo edges 0.5 to 8 px apart, and with this form 1.8% (October 14, 2026, sessions of 40
// small drags and resizes, with a reach of 8 px on a stage of 538 by 430 px).
const penaltyStiffness = 5
// The penalty's weight against the distance from the target. The other edges of a line hold an edge with a pull
// of at most one reach, and at a weight of 2 that holds the edge until its target is 2 reaches from the line. So
// an edge joins a line within one reach of it and leaves the line at two reaches, and the same target can end in
// two layouts, depending on where the outputs were before. Measured on the page's three presets with the 178
// rough drags and resizes of each size that move an edge of a line, at a reach of 2% of the stage: a photo that
// started on its rectangle joined its lines in all of the edits of half a reach, in 69% of the edits of one
// reach and in none of the edits of one and a half. A photo that started on its lines stayed on them in all of
// the edits of one reach, in 89% of the edits of one and a half, in 58% of the edits of 1.8 reaches, and at two
// reaches only in the 5 edits whose rectangle the stage's edge stopped at 1.8 (October 14, 2026).
export const penaltyStrength = 2
// After a reset the penalty is off until the outputs are close to the target, i.e. until the distance from the
// target is below penaltyOnsetDistance, and until penaltyOnsetSteps steps have run at the latest. Then it rises to
// its strength over penaltyRiseSteps steps. The seeded weights put the outputs in a pile, where every edge is
// within the reach of every other, so the penalty waits until the outputs are where the target has them: which
// edges end on one line then depends on the target and not on the paths that the outputs took out of the pile.
// A distance of 1e-6 is an error of 0.14% of the stage in the middle case, 0.8 px on a stage of 538 px. With a
// fixed wait of 200 steps instead, 2 of 200 variants of the page's Story sketch ended with one photo 5 to 8 px
// off its row after 2,000 steps: those fits are slow, the photo was still 9 px from its place and so out of the
// row's reach of 8 px when the penalty came on, and the rest of the fit was slower with the penalty on. With
// this rule every line of all 200 is within 0.15 px when training stops (October 14, 2026).
const penaltyOnsetDistance = 1e-6
const penaltyOnsetSteps = 1000
const penaltyRiseSteps = 200
// Two more sets of numbers go into the penalty's pull. Ordinary code computes them from the outputs' edges at the
// start of each frame of training (startFrame), and a frame's steps hold them constant. Neither reads the target.
//
// The line counts. Edges of one kind that are within lineGap reaches of the next one count as one line. A pair's
// charge and pull are divided by the number of edges on the two edges' lines, so a row of 4 holds an edge as far
// as a row of 2 does, and a long line doesn't pull harder than a short one.
const lineGap = 1 / 8
// The multipliers, one per kind of edge and pair of rectangles (the method of multipliers). A pull that is only
// the slope of a cost leaves a held edge where its two pulls balance, a fraction of a px off its line. So each
// frame adds a share of a pair's gap to the pair's multiplier, and the multiplier is added to the pair's pull,
// within the same limit: a gap that stays open is pulled harder and harder until it closes or the limit is
// reached. The multipliers are state of the training, like Adam's moments, and not part of the loss: the loss that
// the page shows is the cost without them. The share is multiplierGrowth per training step, so a frame of 10
// steps adds 0.2 of a gap's pull and a frame of 5 steps half of that, and the multipliers grow as fast per second
// on a 120 Hz display as on a 60 Hz one.
const multiplierGrowth = 0.02

// The pull between two edges of one kind whose gap is `gap`, in the units of the distance term's slope: positive
// pulls the first edge down and the second up. `multiplier` is the pair's multiplier, or 0 for the slope of the
// loss alone.
export function pairPull(gap: number, multiplier: number, reach: number) {
  const limit = Math.max(0, reach - Math.abs(gap))
  return Math.max(-limit, Math.min(limit, multiplier + penaltyStiffness * gap))
}

// pairPull summed from a gap of 0 to `gap`, i.e. the function whose slope pairPull is. From a gap of one reach on
// it stays what it is there. With a multiplier of 0 it is the charge of the loss: half the stiffness times the
// squared gap for a small gap, and less than that from where the pull meets its limit. The multiplier is within
// the reach, as startFrame and setPenaltyReach leave it, so the pull meets only its upper limit on the way up.
export function pairCost(gap: number, multiplier: number, reach: number) {
  // The mirrored pair has the same sum.
  const end = Math.min(Math.abs(gap), reach)
  const signedMultiplier = gap < 0 ? -multiplier : multiplier
  // Up to `rise` the pull is the multiplier plus the stiffness times the gap, and from there on the limit.
  const rise = Math.min(end, (reach - signedMultiplier) / (penaltyStiffness + 1))
  return signedMultiplier * rise + 0.5 * penaltyStiffness * rise * rise
    + reach * (end - rise) - 0.5 * (end * end - rise * rise)
}

function createParameterLayout(
  hiddenWidth: number,
  inputFeatureCount: number,
): ParameterLayout {
  let offset = 0
  function allocate(size: number) {
    const start = offset
    offset += size
    return start
  }
  return {
    firstLeftWeights: allocate(hiddenWidth * inputFeatureCount),
    firstLeftBiases: allocate(hiddenWidth),
    firstGateWeights: allocate(hiddenWidth * inputFeatureCount),
    firstGateBiases: allocate(hiddenWidth),
    secondLeftWeights: allocate(hiddenWidth * hiddenWidth),
    secondLeftBiases: allocate(hiddenWidth),
    secondGateWeights: allocate(hiddenWidth * hiddenWidth),
    secondGateBiases: allocate(hiddenWidth),
    outputWeights: allocate(outputFieldCount * hiddenWidth),
    outputBiases: allocate(outputFieldCount),
    size: offset,
  }
}

function parameterField(start: number, row: number, width: number, column: number) {
  return asWire(start + row * width + column)
}

function emitDynamicProjection(
  circuit: Circuit,
  inputs: readonly Wire[],
  weightsStart: number,
  biasWire: Wire,
  row: number,
) {
  return circuit.affine([
    [biasWire, 1],
    ...inputs.map((input, column): readonly [Wire, number] => [
      emitMultiply(
        circuit,
        parameterField(weightsStart, row, inputs.length, column),
        input,
      ),
      1,
    ]),
  ])
}

function createTrainableGeometryCircuit(
  slotCount: number,
  hiddenWidth: number,
  positionalFrequencyCount: number,
) {
  const inputFeatureCount = 2 + positionalFrequencyCount * 2
  const parameters = createParameterLayout(hiddenWidth, inputFeatureCount)
  const circuit = new Circuit(parameters.size)
  const geometries: Wire[] = []

  for (let item = 0; item < slotCount; item++) {
    const position = slotCount === 1 ? 0 : item / (slotCount - 1) * 2 - 1
    const features = [1, position]
    for (let frequency = 1; frequency <= positionalFrequencyCount; frequency++) {
      const angle = Math.PI * frequency * position
      features.push(Math.sin(angle), Math.cos(angle))
    }
    invariant(features.length === inputFeatureCount, 'position feature shape mismatch')
    const first: Wire[] = []
    for (let neuron = 0; neuron < hiddenWidth; neuron++) {
      const leftTerms = features.map(
        (feature, column): readonly [Wire, number] => [
          parameterField(
            parameters.firstLeftWeights,
            neuron,
            inputFeatureCount,
            column,
          ),
          feature,
        ],
      )
      leftTerms.push([asWire(parameters.firstLeftBiases + neuron), 1])
      const gateTerms = features.map(
        (feature, column): readonly [Wire, number] => [
          parameterField(
            parameters.firstGateWeights,
            neuron,
            inputFeatureCount,
            column,
          ),
          feature,
        ],
      )
      gateTerms.push([asWire(parameters.firstGateBiases + neuron), 1])
      first.push(circuit.reglu(leftTerms, 0, gateTerms, 0))
    }

    const second: Wire[] = []
    for (let neuron = 0; neuron < hiddenWidth; neuron++) {
      second.push(circuit.reglu(
        [[
          emitDynamicProjection(
            circuit,
            first,
            parameters.secondLeftWeights,
            asWire(parameters.secondLeftBiases + neuron),
            neuron,
          ),
          1,
        ]],
        0,
        [[
          emitDynamicProjection(
            circuit,
            first,
            parameters.secondGateWeights,
            asWire(parameters.secondGateBiases + neuron),
            neuron,
          ),
          1,
        ]],
        0,
      ))
    }

    const raw: Wire[] = []
    for (let field = 0; field < outputFieldCount; field++) {
      raw.push(emitDynamicProjection(
        circuit,
        second,
        parameters.outputWeights,
        asWire(parameters.outputBiases + field),
        field,
      ))
    }
    geometries.push(...raw)
  }

  validateCircuit(circuit)
  validateWireView(
    geometries,
    slotCount * trainableGeometryField.size,
    circuit.sourceSize + circuit.operations.length,
  )
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(geometries)
  validateTensorProgram(circuit, tensorProgram)
  return {circuit, geometries, parameters, tensorProgram}
}

function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

function initializeParameters(
  source: Float32Array,
  parameters: ParameterLayout,
  hiddenWidth: number,
  inputFeatureCount: number,
  seed: number,
) {
  const random = createRandom(seed)
  function randomSigned(scale: number) {
    return (random() * 2 - 1) * scale
  }
  const firstScale = Math.sqrt(2 / (inputFeatureCount + hiddenWidth))
  const hiddenScale = Math.sqrt(2 / (hiddenWidth * 2))
  const outputScale = Math.sqrt(2 / (hiddenWidth + outputFieldCount))

  for (let neuron = 0; neuron < hiddenWidth; neuron++) {
    for (let feature = 0; feature < inputFeatureCount; feature++) {
      source[parameterField(
        parameters.firstLeftWeights,
        neuron,
        inputFeatureCount,
        feature,
      )] = randomSigned(firstScale)
      source[parameterField(
        parameters.firstGateWeights,
        neuron,
        inputFeatureCount,
        feature,
      )] = randomSigned(firstScale)
    }
    source[parameters.firstLeftBiases + neuron] = randomSigned(0.1)
    source[parameters.firstGateBiases + neuron] = 1 + randomSigned(0.05)
    for (let input = 0; input < hiddenWidth; input++) {
      source[parameterField(
        parameters.secondLeftWeights,
        neuron,
        hiddenWidth,
        input,
      )] = randomSigned(hiddenScale)
      source[parameterField(
        parameters.secondGateWeights,
        neuron,
        hiddenWidth,
        input,
      )] = randomSigned(hiddenScale)
    }
    source[parameters.secondLeftBiases + neuron] = randomSigned(0.1)
    source[parameters.secondGateBiases + neuron] = 1 + randomSigned(0.05)
  }
  for (let field = 0; field < outputFieldCount; field++) {
    for (let input = 0; input < hiddenWidth; input++) {
      source[parameterField(
        parameters.outputWeights,
        field,
        hiddenWidth,
        input,
      )] = randomSigned(outputScale * 0.35)
    }
  }
  source[parameters.outputBiases + trainableGeometryField.left] = 0.5
  source[parameters.outputBiases + trainableGeometryField.top] = 0.5
  source[parameters.outputBiases + trainableGeometryField.width] = 0.18
  source[parameters.outputBiases + trainableGeometryField.height] = 0.18
}

function minimumCostAssignment(costs: readonly (readonly number[])[]) {
  const rowCount = costs.length
  const columnCount = costs[0]?.length ?? 0
  invariant(rowCount <= columnCount, 'rectangle assignment needs enough outputs')
  const rowPotentials = new Float64Array(rowCount + 1)
  const columnPotentials = new Float64Array(columnCount + 1)
  const matchedRowByColumn = new Int32Array(columnCount + 1)
  const previousColumn = new Int32Array(columnCount + 1)

  for (let row = 1; row <= rowCount; row++) {
    matchedRowByColumn[0] = row
    const minimumCosts = new Float64Array(columnCount + 1)
    minimumCosts.fill(Number.POSITIVE_INFINITY)
    const visited = new Uint8Array(columnCount + 1)
    let column = 0
    do {
      visited[column] = 1
      const currentRow = matchedRowByColumn[column]!
      let nextColumn = 0
      let delta = Number.POSITIVE_INFINITY
      for (
        let candidateColumn = 1;
        candidateColumn <= columnCount;
        candidateColumn++
      ) {
        if (visited[candidateColumn] === 1) continue
        const cost = costs[currentRow - 1]![candidateColumn - 1]!
          - rowPotentials[currentRow]!
          - columnPotentials[candidateColumn]!
        if (cost < minimumCosts[candidateColumn]!) {
          minimumCosts[candidateColumn] = cost
          previousColumn[candidateColumn] = column
        }
        if (minimumCosts[candidateColumn]! < delta) {
          delta = minimumCosts[candidateColumn]!
          nextColumn = candidateColumn
        }
      }
      invariant(Number.isFinite(delta), 'rectangle assignment has no finite solution')
      for (
        let candidateColumn = 0;
        candidateColumn <= columnCount;
        candidateColumn++
      ) {
        if (visited[candidateColumn] === 1) {
          const matchedRow = matchedRowByColumn[candidateColumn]!
          rowPotentials[matchedRow] = rowPotentials[matchedRow]! + delta
          columnPotentials[candidateColumn] =
            columnPotentials[candidateColumn]! - delta
        } else {
          minimumCosts[candidateColumn] =
            minimumCosts[candidateColumn]! - delta
        }
      }
      column = nextColumn
    } while (matchedRowByColumn[column] !== 0)

    do {
      const priorColumn = previousColumn[column]!
      matchedRowByColumn[column] = matchedRowByColumn[priorColumn]!
      column = priorColumn
    } while (column !== 0)
  }

  const outputByTarget = new Int32Array(rowCount)
  for (let column = 1; column <= columnCount; column++) {
    const row = matchedRowByColumn[column]!
    if (row > 0) outputByTarget[row - 1] = column - 1
  }
  return outputByTarget
}

function robustLoss(error: number) {
  const magnitude = Math.abs(error)
  return magnitude <= geometryLossThreshold
    ? 0.5 * error * error
    : geometryLossThreshold * (magnitude - 0.5 * geometryLossThreshold)
}

function robustGradient(error: number) {
  return Math.max(
    -geometryLossThreshold,
    Math.min(geometryLossThreshold, error),
  )
}

export function createTrainableGeometryMachine(
  target: TrainableGeometryTarget,
  options: TrainableGeometryOptions = {},
) {
  const slotCount = options.slotCount ?? target.active.length
  const hiddenWidth = options.hiddenWidth ?? 6
  const seed = options.seed ?? 0x51_7a_9e
  const learningRate = options.learningRate ?? 0.008
  // The decay is added to the gradient, and Adam scales a gradient by its size, so the decay pulls the weights
  // toward 0 about as hard as the loss pulls them wherever the loss's gradient is as small as the decay's. That
  // sets how closely the outputs can match the target: with 0.000_02, the value until October 13, 2026, the
  // presets were still 1.4 to 1.8 px off after 500 steps, and with this value 0.01 to 0.14 px (px on a stage of
  // 538 by 430, with that day's loss on left, top, width and height). Without any decay, a unit whose gate has
  // closed for every slot in use gets no gradient and can't open again: over 200 random edits in a row, 2 to 4 of
  // the first layer's 6 units ended shut in 4 of 6 runs. This decay still brings such a unit's weights back
  // toward 0: with it, 2 units ended shut in 1 of 12 runs, and 1 or none in the others.
  const weightDecay = options.weightDecay ?? 0.000_000_2
  const matching = options.matching ?? 'assignment'
  const positionalFrequencyCount = options.positionalFrequencyCount ?? 4
  const inputFeatureCount = 2 + positionalFrequencyCount * 2
  invariant(slotCount === target.active.length, 'target slot count mismatch')
  invariant(target.geometries.length === slotCount * outputFieldCount, 'target shape mismatch')
  invariant(hiddenWidth >= 1, 'hidden width must be positive')
  invariant(
    Number.isInteger(positionalFrequencyCount) && positionalFrequencyCount >= 0,
    'position frequency count must be a nonnegative integer',
  )
  const {circuit, geometries, parameters, tensorProgram} =
    createTrainableGeometryCircuit(
      slotCount,
      hiddenWidth,
      positionalFrequencyCount,
    )
  const source = new Float32Array(parameters.size)
  const initialSource = new Float32Array(parameters.size)
  const firstMoment = new Float32Array(parameters.size)
  const secondMoment = new Float32Array(parameters.size)
  // Every step taken since the last reset, including the steps that trainOrUndo took back.
  let trainingStep = 0
  // The step count of Adam's bias corrections, which trainOrUndo takes back with the moments.
  let momentStep = 0
  // The part of the learning rate that trainOrUndo's steps use, from 1/4096 to 1, and how many frames in a row
  // were taken back at 1/64 of the rate or less.
  let learningRateScale = 1
  let framesTakenBackAtLowRate = 0
  const savedSource = new Float32Array(parameters.size)
  const savedFirstMoment = new Float32Array(parameters.size)
  const savedSecondMoment = new Float32Array(parameters.size)

  // The misalignment penalty's reach for left and right edges, as a fraction of the stage's width, and for top and
  // bottom edges, as a fraction of its height. 0 is no penalty. setPenaltyReach changes them.
  const reachOfKind = [0, 0, 0, 0]
  // What a frame's steps hold constant, see startFrame. The pairs' multipliers, by kind of edge and by the two
  // target slots, the lower slot first: a positive multiplier pulls the lower slot's edge down.
  const multipliers = new Float64Array(edgeKinds.length * slotCount * slotCount)
  // For each kind of edge and target slot, the number of edges on the line of the slot's output edge, and a
  // number that the edges of one line share.
  const lineSize = new Int32Array(edgeKinds.length * slotCount)
  const lineOf = new Int32Array(edgeKinds.length * slotCount)
  // The penalty's weight in this frame: 0 while the penalty is off after a reset, up to penaltyStrength.
  let frameStrength = 0
  // The step at which the penalty began to rise after the last reset, or null while it is off.
  let penaltyOnsetStep: number | null = null
  // The output edges of one kind, by target slot.
  const edges = new Float64Array(slotCount)

  function activeTargetItems() {
    const items: number[] = []
    for (let item = 0; item < slotCount; item++) {
      if (target.active[item] === 1) items.push(item)
    }
    return items
  }

  function outputEdge(values: Float32Array, outputItem: number, kind: number) {
    const {positionField, sizeField, far} = edgeKinds[kind]!
    const start = outputItem * outputFieldCount
    return values[geometries[start + positionField]!]! + far * values[geometries[start + sizeField]!]!
  }

  function targetEdge(targetItem: number, kind: number) {
    const {positionField, sizeField, far} = edgeKinds[kind]!
    const start = targetItem * outputFieldCount
    return target.geometries[start + positionField]! + far * target.geometries[start + sizeField]!
  }

  function geometryLoss(
    values: Float32Array,
    targetItem: number,
    outputItem: number,
  ) {
    let loss = 0
    for (let kind = 0; kind < edgeKinds.length; kind++) {
      loss += robustLoss(outputEdge(values, outputItem, kind) - targetEdge(targetItem, kind))
    }
    return loss
  }

  function activeOutputItems(outputCount: number) {
    if (target.outputs === undefined) {
      return Array.from({length: outputCount}, (_, item) => item)
    }
    const items: number[] = []
    for (let item = 0; item < slotCount; item++) {
      if (target.outputs[item] === 1) items.push(item)
    }
    invariant(items.length === outputCount, 'as many outputs as targets must be active')
    return items
  }

  function matchRectangles(
    values: Float32Array,
    targetItems: readonly number[],
  ) {
    const outputItems = activeOutputItems(targetItems.length)
    if (matching === 'ordered') {
      return Int32Array.from(outputItems)
    }
    const costs = targetItems.map(targetItem =>
      outputItems.map(outputItem =>
        geometryLoss(values, targetItem, outputItem)))
    return minimumCostAssignment(costs).map(index => outputItems[index]!)
  }

  // Writes the output edges of one kind into `edges`, by the slot of the target that each output is paired with.
  function readEdges(
    values: Float32Array,
    targetItems: readonly number[],
    outputByTarget: Int32Array,
    kind: number,
  ) {
    for (let index = 0; index < targetItems.length; index++) {
      edges[targetItems[index]!] = outputEdge(values, outputByTarget[index]!, kind)
    }
  }

  // The number that a pair's charge and pull are divided by: the number of edges on the two edges' lines. An edge
  // that joins a line of 3 is divided by 4 before it joins, 1 and 3, and by 4 after.
  function lineCount(kind: number, firstSlot: number, secondSlot: number) {
    const first = kind * slotCount + firstSlot
    const second = kind * slotCount + secondSlot
    return lineOf[first] === lineOf[second] ? lineSize[first]! : lineSize[first]! + lineSize[second]!
  }

  // Computes, from the outputs at the start of a frame of `steps` training steps, what the frame's steps hold
  // constant: the penalty's weight, the multipliers and the line counts. With them constant, the frame's steps
  // follow the slope of one function, which measure returns as `followed`, so trainOrUndo can compare that
  // function before and after the steps.
  function startFrame(values: Float32Array, steps: number) {
    const targetItems = activeTargetItems()
    const outputByTarget = matchRectangles(values, targetItems)
    if (penaltyOnsetStep === null) {
      let fromTarget = 0
      for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
        fromTarget += geometryLoss(values, targetItems[targetIndex]!, outputByTarget[targetIndex]!)
      }
      if (fromTarget < penaltyOnsetDistance * targetItems.length * edgeKinds.length || trainingStep >= penaltyOnsetSteps) {
        penaltyOnsetStep = trainingStep
      }
    }
    frameStrength = penaltyOnsetStep === null
      ? 0
      : penaltyStrength * Math.min(1, (trainingStep - penaltyOnsetStep) / penaltyRiseSteps)
    const order = [...targetItems]
    for (let kind = 0; kind < edgeKinds.length; kind++) {
      const reach = reachOfKind[kind]!
      readEdges(values, targetItems, outputByTarget, kind)
      // Each pair's multiplier grows by a share of the gap's pull, within the pull's limit at this gap. While the
      // penalty is off the limit is 0, and a pair with a rectangle that is gone has no multiplier, so a rectangle
      // added later doesn't start with the pulls of the one that had its slot.
      for (let first = 0; first < slotCount; first++) {
        for (let second = first + 1; second < slotCount; second++) {
          const pair = (kind * slotCount + first) * slotCount + second
          if (target.active[first] !== 1 || target.active[second] !== 1) {
            multipliers[pair] = 0
            continue
          }
          const gap = edges[first]! - edges[second]!
          const limit = frameStrength === 0 ? 0 : Math.max(0, reach - Math.abs(gap))
          multipliers[pair] = Math.max(-limit, Math.min(limit, multipliers[pair]! + multiplierGrowth * steps * penaltyStiffness * gap))
        }
      }
      // The lines: the edges by position, where an edge farther than lineGap reaches from the one before it
      // starts a new line.
      order.sort((a, b) => edges[a]! - edges[b]!)
      for (let lineStart = 0; lineStart < order.length;) {
        let lineEnd = lineStart + 1
        while (lineEnd < order.length && edges[order[lineEnd]!]! - edges[order[lineEnd - 1]!]! <= reach * lineGap) lineEnd++
        for (let position = lineStart; position < lineEnd; position++) {
          lineOf[kind * slotCount + order[position]!] = lineStart
          lineSize[kind * slotCount + order[position]!] = lineEnd - lineStart
        }
        lineStart = lineEnd
      }
    }
  }

  // The two parts of the loss for these outputs, and `followed`: the function whose slope a frame's steps follow,
  // which is the loss with each pair's multiplier in its pull, and with a pair beyond the reach counted at the
  // charge of one reach instead of 0, so that the function has no jump where a pair parts.
  function measure(values: Float32Array) {
    const targetItems = activeTargetItems()
    if (targetItems.length === 0) return {fromTarget: 0, misalignment: 0, followed: 0}
    const outputByTarget = matchRectangles(values, targetItems)
    let fromTarget = 0
    for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
      fromTarget += geometryLoss(
        values,
        targetItems[targetIndex]!,
        outputByTarget[targetIndex]!,
      )
    }
    let misalignment = 0
    let followedPenalty = 0
    for (let kind = 0; kind < edgeKinds.length; kind++) {
      const reach = reachOfKind[kind]!
      readEdges(values, targetItems, outputByTarget, kind)
      for (let firstIndex = 0; firstIndex < targetItems.length; firstIndex++) {
        const first = targetItems[firstIndex]!
        for (let secondIndex = firstIndex + 1; secondIndex < targetItems.length; secondIndex++) {
          const second = targetItems[secondIndex]!
          const gap = edges[first]! - edges[second]!
          const count = lineCount(kind, first, second)
          if (Math.abs(gap) < reach) misalignment += pairCost(gap, 0, reach) / count
          followedPenalty += pairCost(gap, multipliers[(kind * slotCount + first) * slotCount + second]!, reach) / count
        }
      }
    }
    const scale = 1 / (targetItems.length * edgeKinds.length)
    return {
      fromTarget: fromTarget * scale,
      misalignment: frameStrength * misalignment * scale,
      followed: (fromTarget + frameStrength * followedPenalty) * scale,
    }
  }

  function trainStep(stepLearningRate: number) {
    const values = circuit.evaluateReference(source)
    const targetItems = activeTargetItems()
    if (targetItems.length === 0) return
    const outputByTarget = matchRectangles(values, targetItems)
    const outputGradients = new Float32Array(values.length)
    const gradientScale = 1 / (targetItems.length * edgeKinds.length)
    // An edge's slope goes to the output's position, and for a right or a bottom edge to its size too.
    function addEdgeGradient(targetIndex: number, kind: number, amount: number) {
      const {positionField, sizeField, far} = edgeKinds[kind]!
      const start = outputByTarget[targetIndex]! * outputFieldCount
      const positionWire = geometries[start + positionField]!
      outputGradients[positionWire] = Math.fround(outputGradients[positionWire]! + amount)
      if (far === 1) {
        const sizeWire = geometries[start + sizeField]!
        outputGradients[sizeWire] = Math.fround(outputGradients[sizeWire]! + amount)
      }
    }
    for (let kind = 0; kind < edgeKinds.length; kind++) {
      for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
        const error = outputEdge(values, outputByTarget[targetIndex]!, kind) - targetEdge(targetItems[targetIndex]!, kind)
        addEdgeGradient(targetIndex, kind, robustGradient(error) * gradientScale)
      }
      const reach = reachOfKind[kind]!
      readEdges(values, targetItems, outputByTarget, kind)
      for (let firstIndex = 0; firstIndex < targetItems.length; firstIndex++) {
        const first = targetItems[firstIndex]!
        for (let secondIndex = firstIndex + 1; secondIndex < targetItems.length; secondIndex++) {
          const second = targetItems[secondIndex]!
          const pull = pairPull(edges[first]! - edges[second]!, multipliers[(kind * slotCount + first) * slotCount + second]!, reach)
          const amount = frameStrength * pull / lineCount(kind, first, second) * gradientScale
          addEdgeGradient(firstIndex, kind, amount)
          addEdgeGradient(secondIndex, kind, -amount)
        }
      }
    }
    const gradients = circuit.backpropagateReference(values, outputGradients)
    trainingStep++
    momentStep++
    const firstDecay = 0.9
    const secondDecay = 0.999
    const firstCorrection = 1 - firstDecay ** momentStep
    const secondCorrection = 1 - secondDecay ** momentStep
    let gradientMagnitude = 0
    for (let parameter = 0; parameter < parameters.size; parameter++) {
      gradients[parameter] = Math.fround(
        gradients[parameter]! + source[parameter]! * weightDecay,
      )
      gradientMagnitude += gradients[parameter]! * gradients[parameter]!
    }
    const gradientScaleLimit = Math.min(1, 1 / Math.sqrt(gradientMagnitude))
    for (let parameter = 0; parameter < parameters.size; parameter++) {
      const gradient = gradients[parameter]! * gradientScaleLimit
      firstMoment[parameter] =
        firstDecay * firstMoment[parameter]! + (1 - firstDecay) * gradient
      secondMoment[parameter] =
        secondDecay * secondMoment[parameter]!
        + (1 - secondDecay) * gradient * gradient
      const correctedFirst = firstMoment[parameter]! / firstCorrection
      const correctedSecond = secondMoment[parameter]! / secondCorrection
      source[parameter] = Math.fround(
        source[parameter]!
          - stepLearningRate * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8),
      )
      source[parameter] = Math.max(-6, Math.min(6, source[parameter]!))
    }
  }

  function reset() {
    initializeParameters(
      source,
      parameters,
      hiddenWidth,
      inputFeatureCount,
      seed,
    )
    initialSource.set(source)
    firstMoment.fill(0)
    secondMoment.fill(0)
    multipliers.fill(0)
    penaltyOnsetStep = null
    trainingStep = 0
    momentStep = 0
    learningRateScale = 1
    framesTakenBackAtLowRate = 0
  }

  // The outputs with their loss, for a caller that takes no step: the line counts and the penalty's weight are the
  // ones that a frame would start with now.
  function evaluate() {
    const values = circuit.evaluateTensor(source)
    assertFiniteValues(values, 'trainable geometry values')
    startFrame(values, 0)
    const {fromTarget, misalignment} = measure(values)
    return {values, loss: fromTarget + misalignment, fromTarget, misalignment, step: trainingStep}
  }

  reset()
  return {
    circuit,
    geometries,
    source,
    target,
    tensorProgram,
    parameterCount: parameters.size,
    hiddenWidth,
    get trainingStep() {
      return trainingStep
    },
    reset,
    // Plain Adam steps, each as a frame of its own, and none taken back.
    train(steps = 1) {
      invariant(Number.isInteger(steps) && steps >= 0, 'training step count is invalid')
      for (let step = 0; step < steps; step++) {
        startFrame(circuit.evaluateTensor(source), 1)
        trainStep(learningRate)
      }
      return evaluate()
    },
    // Like train, for a page that trains a few steps per frame and draws the result: steps that leave the function
    // they follow higher than it was before them are taken back, so the page never draws a worse fit than the frame
    // before. That function is the loss while no multiplier is at work, e.g. with the penalty off.
    // Adam at a fixed learning rate doesn't come to rest once the loss is low. Its steps keep their size while the
    // gradients shrink, and every few hundred steps they overshoot: on the page, the loss rose up to 60 times within
    // 20 steps, the photos jumped up to 14 px and came back, and an edit's 500 steps could end in the middle of
    // such a jump (October 13, 2026). So after steps that were taken back, the steps that follow use half the
    // learning rate, down to 1/64 of it, and after steps that were kept, 1.15 times as much, up to the full rate.
    // The growth was 1.5 until the penalty came: with the penalty on, 38% of an edit's frames were taken back with
    // 1.5 and 25% with 1.15, and the photos of a line ended half as far apart (October 14, 2026, on an earlier
    // form of the penalty).
    //
    // The rate stays as it is when the target changes. While the weights are at rest it is low, and the first
    // frames of a drag raise it again, from 1/64 to the full rate in 30 kept frames. Full steps from weights at
    // rest are the same overshoot: with the rate set to full at every change of the target, each frame of a drag
    // was taken back, and the photo stood still under a rectangle dragged 70 px away. With plain steps in those
    // frames, the first one threw the other photos up to 256 px off.
    //
    // When 5 frames in a row at 1/64 were taken back, the rate goes on halving, down to 1/4096, and each kept
    // frame doubles it until it is at 1/64 again. Adam's steps are larger than its learning rate for a while
    // after the gradients change, since its second moments follow more slowly than its first. So after a
    // rectangle was added far from the photo that it got, every frame at 1/64 could be taken back, with the photo
    // standing still 30 px from its rectangle: in 8 sessions of 200 random edits, 3 of 1,600 edits ended that way,
    // and none with this rule. Halving below 1/64 after every frame that is taken back, without waiting for 5,
    // slows the small moves near the end of a fit: 1.9% of 3,840 small session edits then ended with two photo
    // edges neither in line nor a reach apart, where it is 1.1% with this rule and 1.2% with no rate below 1/64
    // (October 14, 2026).
    trainOrUndo(steps: number) {
      invariant(Number.isInteger(steps) && steps >= 0, 'training step count is invalid')
      const valuesBefore = circuit.evaluateTensor(source)
      startFrame(valuesBefore, steps)
      const before = measure(valuesBefore)
      savedSource.set(source)
      savedFirstMoment.set(firstMoment)
      savedSecondMoment.set(secondMoment)
      const savedMomentStep = momentStep
      for (let step = 0; step < steps; step++) trainStep(learningRate * learningRateScale)
      let values = circuit.evaluateTensor(source)
      let after = measure(values)
      const undone = after.followed > before.followed
      if (undone) {
        source.set(savedSource)
        firstMoment.set(savedFirstMoment)
        secondMoment.set(savedSecondMoment)
        momentStep = savedMomentStep
        if (learningRateScale <= 1 / 64) framesTakenBackAtLowRate++
        learningRateScale = Math.max(framesTakenBackAtLowRate >= 5 ? 1 / 4096 : 1 / 64, learningRateScale * 0.5)
        values = circuit.evaluateTensor(source)
        after = before
      } else {
        learningRateScale = Math.min(1, learningRateScale * (learningRateScale < 1 / 64 ? 2 : 1.15))
        if (learningRateScale >= 1 / 64) framesTakenBackAtLowRate = 0
      }
      assertFiniteValues(values, 'trainable geometry values')
      return {
        values,
        loss: after.fromTarget + after.misalignment,
        fromTarget: after.fromTarget,
        misalignment: after.misalignment,
        step: trainingStep,
        undone,
      }
    },
    // How close two output edges of one kind have to be for the penalty to pull them together: `across` for left
    // and right edges, as a fraction of the stage's width, and `down` for top and bottom edges, as a fraction of its
    // height. 0 switches the penalty off. A multiplier stays within the new reach.
    setPenaltyReach(across: number, down: number) {
      invariant(across >= 0 && down >= 0, 'penalty reach must be nonnegative')
      reachOfKind[0] = reachOfKind[1] = across
      reachOfKind[2] = reachOfKind[3] = down
      for (let kind = 0; kind < edgeKinds.length; kind++) {
        const reach = reachOfKind[kind]!
        for (let pair = kind * slotCount * slotCount; pair < (kind + 1) * slotCount * slotCount; pair++) {
          multipliers[pair] = Math.max(-reach, Math.min(reach, multipliers[pair]!))
        }
      }
    },
    evaluate,
    match(values: Float32Array) {
      const targetItems = activeTargetItems()
      return {
        targetItems,
        outputByTarget: matchRectangles(values, targetItems),
      }
    },
    initialSource,
  }
}

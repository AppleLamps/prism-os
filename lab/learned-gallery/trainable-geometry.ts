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
  // Per slot, a number that is larger the later the slot's rectangle was last edited, e.g. 0 for a rectangle as a
  // preset drew it and a running count for the others. An edge goes onto a line that older rectangles made, and
  // never the other way around (alignRectangles). Without it, no rectangle is older than another.
  editOrder?: Uint32Array
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
  // How close two edges of the target have to be to count as one line, see alignRectangles. 0 fits the target as
  // it is. setAlignmentReach changes it later.
  alignmentReach?: number
}

// The reach that the page starts with: 3% of the stage, i.e. 16 px across and 13 px down on a stage of 538 by
// 430 px. A hand that puts a rectangle back in its row is rarely farther off, and edges that a sketch means to be
// apart are rarely that close.
export const defaultAlignmentReach = 0.03

const outputFieldCount = trainableGeometryField.size
const geometryLossThreshold = 0.08
// The loss is the mean of the Huber loss over each rectangle's left, top, width and height, where an error in
// width or height counts twice. With equal weights the network fits positions sooner than sizes, so after the
// page's 500 steps the right and bottom edges were the ones off their lines: Story's worst line was 0.47 px apart
// with equal weights and 0.26 px with these, and among 200 variants of Story's proportions, every line was within
// 0.25 px in 80 with equal weights and in 131 with these (October 13, 2026, px on a stage of 538 by 430).
const fieldWeights = [1, 1, 2, 2] as const
const fieldWeightSum = 6
// The two axes of a rectangle: the field of its low edge and the field of its size.
const axes = [
  [trainableGeometryField.left, trainableGeometryField.width],
  [trainableGeometryField.top, trainableGeometryField.height],
] as const

// Moves the edges of rectangles that are nearly on one line onto that line, and writes the result to `aligned`,
// which has the layout of `target.geometries`. The network is fitted to this result, so photos line up although
// the sketch was drawn by hand.
//
// Left edges are compared with left edges, and likewise right, top and bottom edges. The edges are taken from the
// rectangle edited longest ago to the one edited last. An edge within `reach` of a line that older edges made
// goes onto the nearest such line, and any other edge makes a line where it is. So a rectangle that was just
// dragged back into its row moves onto the row's line, the row stays where it is, and no edge moves farther than
// the reach. Rectangles that are equally old, e.g. the ones that a preset drew, make their lines together: sorted
// by position, edges within the reach of the next one meet at their mean.
//
// Positions are fractions of the stage, e.g. a reach of 0.03 is 3% of the stage's width for left and right edges
// and 3% of its height for top and bottom edges.
//
// A rectangle that the lines would leave less than half as wide or as tall as it was drawn keeps its own two
// edges on that axis, e.g. a narrow rectangle between two lines that would otherwise close it.
export function alignRectangles(target: TrainableGeometryTarget, reach: number, aligned: Float32Array) {
  aligned.set(target.geometries)
  if (reach <= 0) return
  const items: number[] = []
  for (let item = 0; item < target.active.length; item++) {
    if (target.active[item] === 1) items.push(item)
  }
  const ages = items.map(item => target.editOrder?.[item] ?? 0)
  // Each active rectangle's two edges on the current axis, after the move.
  const moved = [new Float64Array(items.length), new Float64Array(items.length)] as const
  const edges = new Float64Array(items.length)
  const order = items.map((_, index) => index)
  const lines: number[] = []
  // The edges of one age that are on no older line, by position.
  const free: number[] = []
  for (const [positionField, sizeField] of axes) {
    for (let side = 0; side < 2; side++) {
      for (let index = 0; index < items.length; index++) {
        const start = items[index]! * outputFieldCount
        edges[index] = target.geometries[start + positionField]! + side * target.geometries[start + sizeField]!
      }
      // From the oldest rectangle to the newest, and by position among equally old ones.
      order.sort((a, b) => ages[a]! - ages[b]! || edges[a]! - edges[b]!)
      lines.length = 0
      for (let groupStart = 0; groupStart < order.length;) {
        let groupEnd = groupStart + 1
        while (groupEnd < order.length && ages[order[groupEnd]!] === ages[order[groupStart]!]) groupEnd++
        // lines holds the lines of the older rectangles here. This group's own lines are added after the loop.
        free.length = 0
        for (let position = groupStart; position < groupEnd; position++) {
          const index = order[position]!
          let nearest = -1
          for (let line = 0; line < lines.length; line++) {
            const distance = Math.abs(lines[line]! - edges[index]!)
            if (distance <= reach && (nearest < 0 || distance < Math.abs(lines[nearest]! - edges[index]!))) nearest = line
          }
          if (nearest >= 0) moved[side]![index] = lines[nearest]!
          else free.push(index)
        }
        for (let runStart = 0; runStart < free.length;) {
          let runEnd = runStart + 1
          let sum = edges[free[runStart]!]!
          while (runEnd < free.length && edges[free[runEnd]!]! - edges[free[runEnd - 1]!]! <= reach) sum += edges[free[runEnd++]!]!
          const line = sum / (runEnd - runStart)
          for (let position = runStart; position < runEnd; position++) moved[side]![free[position]!] = line
          lines.push(line)
          runStart = runEnd
        }
        groupStart = groupEnd
      }
    }
    for (let index = 0; index < items.length; index++) {
      const start = items[index]! * outputFieldCount
      const size = moved[1][index]! - moved[0][index]!
      if (size < 0.5 * target.geometries[start + sizeField]!) continue
      aligned[start + positionField] = moved[0][index]!
      aligned[start + sizeField] = size
    }
  }
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
  // 538 by 430). Without any decay, a unit whose gate has closed for every slot in use gets no gradient and can't
  // open again: over 200 random edits in a row, 2 to 4 of the first layer's 6 units ended shut in 4 of 6 runs.
  // This decay still brings such a unit's weights back toward 0: with it, 2 units ended shut in 1 of 12 runs, and
  // 1 or none in the others.
  const weightDecay = options.weightDecay ?? 0.000_000_2
  const matching = options.matching ?? 'assignment'
  const positionalFrequencyCount = options.positionalFrequencyCount ?? 4
  let alignmentReach = options.alignmentReach ?? defaultAlignmentReach
  const inputFeatureCount = 2 + positionalFrequencyCount * 2
  invariant(slotCount === target.active.length, 'target slot count mismatch')
  invariant(target.geometries.length === slotCount * outputFieldCount, 'target shape mismatch')
  invariant(hiddenWidth >= 1, 'hidden width must be positive')
  invariant(
    Number.isInteger(positionalFrequencyCount) && positionalFrequencyCount >= 0,
    'position frequency count must be a nonnegative integer',
  )
  invariant(alignmentReach >= 0, 'alignment reach must be nonnegative')
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
  // The part of the learning rate that trainOrUndo's steps use, from 0 to 1.
  let learningRateScale = 1
  const savedSource = new Float32Array(parameters.size)
  const savedFirstMoment = new Float32Array(parameters.size)
  const savedSecondMoment = new Float32Array(parameters.size)
  // The target as the loss reads it: with the edges that are nearly on one line moved onto that line.
  const aligned = new Float32Array(target.geometries.length)

  function activeTargetItems() {
    const items: number[] = []
    for (let item = 0; item < slotCount; item++) {
      if (target.active[item] === 1) items.push(item)
    }
    return items
  }

  function geometryLoss(
    values: Float32Array,
    targetItem: number,
    outputItem: number,
  ) {
    const targetStart = targetItem * outputFieldCount
    const outputStart = outputItem * outputFieldCount
    let loss = 0
    for (let field = 0; field < outputFieldCount; field++) {
      loss += fieldWeights[field]! * robustLoss(
        values[geometries[outputStart + field]!]!
          - aligned[targetStart + field]!,
      )
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

  function measure(values: Float32Array) {
    const targetItems = activeTargetItems()
    if (targetItems.length === 0) return 0
    alignRectangles(target, alignmentReach, aligned)
    const outputByTarget = matchRectangles(values, targetItems)
    let loss = 0
    for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
      loss += geometryLoss(
        values,
        targetItems[targetIndex]!,
        outputByTarget[targetIndex]!,
      )
    }
    return loss / (targetItems.length * fieldWeightSum)
  }

  function trainStep(stepLearningRate: number) {
    const values = circuit.evaluateReference(source)
    const targetItems = activeTargetItems()
    if (targetItems.length === 0) return
    alignRectangles(target, alignmentReach, aligned)
    const outputByTarget = matchRectangles(values, targetItems)
    const outputGradients = new Float32Array(values.length)
    const gradientScale = 1 / (targetItems.length * fieldWeightSum)
    for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
      const targetStart = targetItems[targetIndex]! * outputFieldCount
      const outputStart = outputByTarget[targetIndex]! * outputFieldCount
      for (let field = 0; field < outputFieldCount; field++) {
        const wire = geometries[outputStart + field]!
        const error = values[wire]! - aligned[targetStart + field]!
        outputGradients[wire] = Math.fround(
          outputGradients[wire]!
            + fieldWeights[field]! * robustGradient(error) * gradientScale,
        )
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

  function clearOptimizer() {
    firstMoment.fill(0)
    secondMoment.fill(0)
    trainingStep = 0
    momentStep = 0
    learningRateScale = 1
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
    clearOptimizer()
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
    clearOptimizer,
    train(steps = 1) {
      invariant(Number.isInteger(steps) && steps >= 0, 'training step count is invalid')
      for (let step = 0; step < steps; step++) trainStep(learningRate)
      const values = circuit.evaluateTensor(source)
      assertFiniteValues(values, 'trainable geometry values')
      return {values, loss: measure(values), step: trainingStep}
    },
    // Like train, for a page that trains a few steps per frame and draws the result: steps that leave the loss
    // higher than it was before them are taken back, so the page never draws a worse fit than the frame before.
    // Adam at a fixed learning rate doesn't come to rest once the loss is low. Its steps keep their size while the
    // gradients shrink, and every few hundred steps they overshoot: on the page, the loss rose up to 60 times within
    // 20 steps, the photos jumped up to 14 px and came back, and an edit's 500 steps could end in the middle of
    // such a jump (October 13, 2026). So after steps that were taken back, the steps that follow use half the
    // learning rate, down to 1/64 of it, and after steps that were kept, half as much again, up to the full rate.
    //
    // The rate stays as it is when the target changes. While the weights are at rest it is low, and the first
    // frames of a drag raise it again, from 1/64 to the full rate in 11 kept frames. Full steps from weights at
    // rest are the same overshoot: with the rate set to full at every change of the target, each frame of a drag
    // was taken back, and the photo stood still under a rectangle dragged 70 px away. With plain steps in those
    // frames, the first one threw the other photos up to 256 px off.
    trainOrUndo(steps: number) {
      invariant(Number.isInteger(steps) && steps >= 0, 'training step count is invalid')
      const lossBefore = measure(circuit.evaluateTensor(source))
      savedSource.set(source)
      savedFirstMoment.set(firstMoment)
      savedSecondMoment.set(secondMoment)
      const savedMomentStep = momentStep
      for (let step = 0; step < steps; step++) trainStep(learningRate * learningRateScale)
      let values = circuit.evaluateTensor(source)
      let loss = measure(values)
      const undone = loss > lossBefore
      if (undone) {
        source.set(savedSource)
        firstMoment.set(savedFirstMoment)
        secondMoment.set(savedSecondMoment)
        momentStep = savedMomentStep
        learningRateScale = Math.max(1 / 64, learningRateScale * 0.5)
        values = circuit.evaluateTensor(source)
        loss = lossBefore
      } else {
        learningRateScale = Math.min(1, learningRateScale * 1.5)
      }
      assertFiniteValues(values, 'trainable geometry values')
      return {values, loss, step: trainingStep, undone}
    },
    // How close two edges of the target have to be to count as one line. 0 fits the target as it is.
    setAlignmentReach(reach: number) {
      invariant(reach >= 0, 'alignment reach must be nonnegative')
      alignmentReach = reach
    },
    // The target as the loss reads it now, with the layout of target.geometries.
    alignedTarget() {
      alignRectangles(target, alignmentReach, aligned)
      return aligned
    },
    evaluate() {
      const values = circuit.evaluateTensor(source)
      assertFiniteValues(values, 'trainable geometry values')
      return {values, loss: measure(values), step: trainingStep}
    },
    match(values: Float32Array) {
      const targetItems = activeTargetItems()
      alignRectangles(target, alignmentReach, aligned)
      return {
        targetItems,
        outputByTarget: matchRectangles(values, targetItems),
      }
    },
    initialSource,
  }
}

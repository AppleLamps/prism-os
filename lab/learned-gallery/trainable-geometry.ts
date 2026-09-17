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
  relationStrength?: number
  relationSigma?: number
}

const outputFieldCount = trainableGeometryField.size
const geometryLossThreshold = 0.08
const relationChannels = [
  [[trainableGeometryField.left, 1]],
  [[trainableGeometryField.top, 1]],
  [[trainableGeometryField.left, 1], [trainableGeometryField.width, 1]],
  [[trainableGeometryField.top, 1], [trainableGeometryField.height, 1]],
] as const

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
  const weightDecay = options.weightDecay ?? 0.000_02
  const matching = options.matching ?? 'assignment'
  const positionalFrequencyCount = options.positionalFrequencyCount ?? 4
  const relationStrength = options.relationStrength ?? 8
  const relationSigma = options.relationSigma ?? 0.025
  const inputFeatureCount = 2 + positionalFrequencyCount * 2
  invariant(slotCount === target.active.length, 'target slot count mismatch')
  invariant(target.geometries.length === slotCount * outputFieldCount, 'target shape mismatch')
  invariant(hiddenWidth >= 1, 'hidden width must be positive')
  invariant(
    Number.isInteger(positionalFrequencyCount) && positionalFrequencyCount >= 0,
    'position frequency count must be a nonnegative integer',
  )
  invariant(relationStrength >= 0, 'relation strength must be nonnegative')
  invariant(relationSigma > 0, 'relation sigma must be positive')
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
  let trainingStep = 0

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
      loss += robustLoss(
        values[geometries[outputStart + field]!]!
          - target.geometries[targetStart + field]!,
      )
    }
    return loss
  }

  function matchRectangles(
    values: Float32Array,
    targetItems: readonly number[],
  ) {
    const outputCount = targetItems.length
    if (matching === 'ordered') {
      return Int32Array.from({length: outputCount}, (_, item) => item)
    }
    const costs = targetItems.map(targetItem =>
      Array.from({length: outputCount}, (_, outputItem) =>
        geometryLoss(values, targetItem, outputItem)))
    return minimumCostAssignment(costs)
  }

  function targetRelationValue(
    geometryValues: Float32Array,
    item: number,
    channel: (typeof relationChannels)[number],
  ) {
    const start = item * outputFieldCount
    let value = 0
    for (const [field, coefficient] of channel) {
      value += geometryValues[start + field]! * coefficient
    }
    return value
  }

  function outputRelationValue(
    values: Float32Array,
    item: number,
    channel: (typeof relationChannels)[number],
  ) {
    const start = item * outputFieldCount
    let value = 0
    for (const [field, coefficient] of channel) {
      value += values[geometries[start + field]!]! * coefficient
    }
    return value
  }

  function relationFacts(
    values: Float32Array,
    targetItems: readonly number[],
    outputByTarget: Int32Array,
  ) {
    const facts: {
      outputItem: number
      channel: (typeof relationChannels)[number]
      weight: number
      difference: number
    }[] = []
    let mass = 0
    for (const channel of relationChannels) {
      const targetValues = targetItems.map(item =>
        targetRelationValue(target.geometries, item, channel))
      for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
        let mode = targetValues[targetIndex]!
        let neighborhoodMass = 1
        for (let iteration = 0; iteration < 4; iteration++) {
          let weightedValue = 0
          neighborhoodMass = 0
          for (const targetValue of targetValues) {
            const normalizedDifference =
              (mode - targetValue) / relationSigma
            const weight = Math.exp(
              -0.5 * normalizedDifference * normalizedDifference,
            )
            weightedValue += weight * targetValue
            neighborhoodMass += weight
          }
          mode = weightedValue / neighborhoodMass
        }
        const weight = Math.max(0, 1 - 1 / neighborhoodMass)
        if (weight < 0.001) continue
        const outputItem = outputByTarget[targetIndex]!
        const difference =
          outputRelationValue(values, outputItem, channel) - mode
        facts.push({outputItem, channel, weight, difference})
        mass += weight
      }
    }
    return {facts, mass}
  }

  function measure(values: Float32Array) {
    const targetItems = activeTargetItems()
    if (targetItems.length === 0) return 0
    const outputByTarget = matchRectangles(values, targetItems)
    let loss = 0
    for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
      loss += geometryLoss(
        values,
        targetItems[targetIndex]!,
        outputByTarget[targetIndex]!,
      )
    }
    loss /= targetItems.length * outputFieldCount
    if (relationStrength > 0) {
      const relations = relationFacts(values, targetItems, outputByTarget)
      if (relations.mass > 0) {
        let relationLoss = 0
        for (const relation of relations.facts) {
          relationLoss += 0.5
            * relation.weight
            * relation.difference
            * relation.difference
        }
        loss += relationStrength * relationLoss / relations.mass
      }
    }
    return loss
  }

  function trainStep() {
    const values = circuit.evaluateReference(source)
    const targetItems = activeTargetItems()
    if (targetItems.length === 0) return
    const outputByTarget = matchRectangles(values, targetItems)
    const outputGradients = new Float32Array(values.length)
    const gradientScale = 1 / (targetItems.length * outputFieldCount)
    for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
      const targetStart = targetItems[targetIndex]! * outputFieldCount
      const outputStart = outputByTarget[targetIndex]! * outputFieldCount
      for (let field = 0; field < outputFieldCount; field++) {
        const wire = geometries[outputStart + field]!
        const error = values[wire]! - target.geometries[targetStart + field]!
        outputGradients[wire] = Math.fround(
          outputGradients[wire]!
            + robustGradient(error) * gradientScale,
        )
      }
    }
    if (relationStrength > 0) {
      const relations = relationFacts(values, targetItems, outputByTarget)
      if (relations.mass > 0) {
        const relationScale = relationStrength / relations.mass
        for (const relation of relations.facts) {
          const gradient =
            relation.weight * relation.difference * relationScale
          const outputStart = relation.outputItem * outputFieldCount
          for (const [field, coefficient] of relation.channel) {
            const wire = geometries[outputStart + field]!
            outputGradients[wire] = Math.fround(
              outputGradients[wire]! + gradient * coefficient,
            )
          }
        }
      }
    }
    const gradients = circuit.backpropagateReference(values, outputGradients)
    trainingStep++
    const firstDecay = 0.9
    const secondDecay = 0.999
    const firstCorrection = 1 - firstDecay ** trainingStep
    const secondCorrection = 1 - secondDecay ** trainingStep
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
          - learningRate * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8),
      )
      source[parameter] = Math.max(-6, Math.min(6, source[parameter]!))
    }
  }

  function clearOptimizer() {
    firstMoment.fill(0)
    secondMoment.fill(0)
    trainingStep = 0
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
      for (let step = 0; step < steps; step++) trainStep()
      const values = circuit.evaluateTensor(source)
      assertFiniteValues(values, 'trainable geometry values')
      return {values, loss: measure(values), step: trainingStep}
    },
    evaluate() {
      const values = circuit.evaluateTensor(source)
      assertFiniteValues(values, 'trainable geometry values')
      return {values, loss: measure(values), step: trainingStep}
    },
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

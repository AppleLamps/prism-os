import {
  Circuit,
  type Wire,
  assertFiniteValues,
  emitMinimum,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from './numeric-ui-core.ts'

export const learnedPhotoCount = 12
export const learnedSlotCount = 20

export const learnedGeometryField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  size: 4,
} as const

export const learnedLayoutNames = ['Cinema', 'Contact', 'Story'] as const

export type LearnedLayoutName = Lowercase<(typeof learnedLayoutNames)[number]>

type NumericGeometry = {
  left: number
  top: number
  width: number
  height: number
}

export type LearnedTargetGeometry = NumericGeometry

export type LearnedGalleryTarget = {
  geometries: Float32Array
  active: Uint8Array
}

type WireGeometry = {
  left: Wire
  top: Wire
  width: Wire
  height: Wire
}

const learnableField = {
  cinema: 0,
  contactWithinRemaining: 1,
  horizontalOffset: 2,
  verticalOffset: 3,
  horizontalScale: 4,
  verticalScale: 5,
  presenceStart: 6,
  unit: 6 + learnedSlotCount,
  size: 7 + learnedSlotCount,
} as const

const parameterCount = learnableField.unit
const targetRoughness = 0.002
const presenceLossWeight = 1
const geometryLossThreshold = 0.04

const photoNames = [
  'Misty Lake',
  'Desert Light',
  'Pacific Edge',
  'Midnight City',
  'Forest Path',
  'Alpine Dawn',
  'Amalfi Morning',
  'North Falls',
  'Lavender Hour',
  'Concrete Curve',
  'Blue Lagoon',
  'Autumn Road',
] as const

function presenceField(item: number) {
  invariant(
    Number.isInteger(item) && item >= 0 && item < learnedSlotCount,
    'learned slot index is invalid',
  )
  return learnableField.presenceStart + item
}

function createContactLayout(rowCount: number): NumericGeometry[] {
  const gap = 0.025
  const width = (1 - gap * 5) / 4
  const height = (1 - gap * (rowCount + 1)) / rowCount
  const geometries: NumericGeometry[] = [{left: 0, top: 0, width: 0, height: 0}]
  for (let item = 0; item < learnedSlotCount - 1; item++) {
    const column = item % 4
    const row = Math.floor(item / 4)
    geometries.push({
      left: gap + column * (width + gap),
      top: gap + row * (height + gap),
      width,
      height,
    })
  }
  return geometries
}

function createCinemaLayout(rowCount: number): NumericGeometry[] {
  const gap = 0.025
  const railWidth = 0.27
  const heroWidth = 1 - railWidth - gap * 3
  const thumbnailWidth = (railWidth - gap) / 2
  const thumbnailHeight = (1 - gap * (rowCount + 1)) / rowCount
  const railLeft = gap * 2 + heroWidth
  const geometries: NumericGeometry[] = [{
    left: gap,
    top: gap,
    width: heroWidth,
    height: 1 - gap * 2,
  }]
  for (let item = 0; item < learnedSlotCount - 1; item++) {
    const column = item % 2
    const row = Math.floor(item / 2)
    geometries.push({
      left: railLeft + column * (thumbnailWidth + gap),
      top: gap + row * (thumbnailHeight + gap),
      width: thumbnailWidth,
      height: thumbnailHeight,
    })
  }
  return geometries
}

function createStoryLayout(rowCount: number): NumericGeometry[] {
  const gap = 0.025
  const columnCount = 3
  const heroHeight = rowCount <= 4 ? 0.5 : 0.42
  const thumbnailWidth = (1 - gap * 4) / 3
  const thumbnailHeight = (1 - heroHeight - gap * (rowCount + 2)) / rowCount
  const thumbnailTop = heroHeight + gap * 2
  const geometries: NumericGeometry[] = [{
    left: gap,
    top: gap,
    width: 1 - gap * 2,
    height: heroHeight,
  }]
  for (let item = 0; item < learnedSlotCount - 1; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    geometries.push({
      left: gap + column * (thumbnailWidth + gap),
      top: thumbnailTop + row * (thumbnailHeight + gap),
      width: thumbnailWidth,
      height: thumbnailHeight,
    })
  }
  return geometries
}

const compactLayouts = {
  cinema: createCinemaLayout(Math.ceil(learnedPhotoCount / 2)),
  contact: createContactLayout(Math.ceil(learnedPhotoCount / 4)),
  story: createStoryLayout(Math.ceil(learnedPhotoCount / 3)),
} satisfies Record<LearnedLayoutName, NumericGeometry[]>

const expandedLayouts = {
  cinema: createCinemaLayout(Math.ceil((learnedSlotCount - 1) / 2)),
  contact: createContactLayout(Math.ceil((learnedSlotCount - 1) / 4)),
  story: createStoryLayout(Math.ceil((learnedSlotCount - 1) / 3)),
} satisfies Record<LearnedLayoutName, NumericGeometry[]>

for (const name of ['cinema', 'contact', 'story'] as const) {
  for (let item = learnedPhotoCount + 1; item < learnedSlotCount; item++) {
    compactLayouts[name][item] = expandedLayouts[name][item]!
  }
}

export function createLearnedGalleryTarget(
  name: LearnedLayoutName = 'story',
): LearnedGalleryTarget {
  const base = compactLayouts[name]
  const geometries = new Float32Array(base.length * learnedGeometryField.size)
  const active = new Uint8Array(base.length)
  for (let item = 0; item < base.length; item++) {
    const geometry = base[item]!
    const start = item * learnedGeometryField.size
    if (
      item > learnedPhotoCount
      || geometry.width === 0
      || geometry.height === 0
    ) {
      continue
    }
    active[item] = 1
    const horizontalJitter = ((item * 7) % 5 - 2) * targetRoughness
    const verticalJitter = ((item * 11) % 5 - 2) * targetRoughness
    const widthJitter = ((item * 13) % 3 - 1) * targetRoughness
    const heightJitter = ((item * 17) % 3 - 1) * targetRoughness
    geometries[start + learnedGeometryField.left] =
      0.012 + geometry.left * 0.965 + horizontalJitter
    geometries[start + learnedGeometryField.top] =
      0.01 + geometry.top * 0.95 + verticalJitter
    geometries[start + learnedGeometryField.width] =
      geometry.width * 0.965 + widthJitter
    geometries[start + learnedGeometryField.height] =
      geometry.height * 0.95 + heightJitter
  }
  return {geometries, active}
}

function minimumCostAssignment(costs: readonly (readonly number[])[]) {
  const rowCount = costs.length
  const columnCount = costs[0]?.length ?? 0
  invariant(rowCount <= columnCount, 'rectangle assignment needs enough outputs')
  for (const row of costs) {
    invariant(
      row.length === columnCount,
      'rectangle assignment rows must have equal width',
    )
    assertFiniteValues(row, 'rectangle assignment costs')
  }
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

function flattenWireGeometries(geometries: readonly WireGeometry[]) {
  const wires: Wire[] = []
  for (const geometry of geometries) {
    wires.push(geometry.left, geometry.top, geometry.width, geometry.height)
  }
  return wires
}

export function createLearnedGalleryCircuit() {
  const circuit = new Circuit(learnableField.size)
  for (let field = 0; field < learnableField.unit; field++) {
    circuit.assumeRange(field, 0, 1)
  }
  circuit.assumeRange(learnableField.unit, 1, 1)
  const unit = learnableField.unit
  const cinema = learnableField.cinema
  const contactWithinRemaining = learnableField.contactWithinRemaining
  const remainingAfterCinema = circuit.affine([[cinema, -1]], 1)
  circuit.assumeRange(remainingAfterCinema, 0, 1)
  const contact = emitMultiply(circuit, remainingAfterCinema, contactWithinRemaining)
  const story = emitMultiply(
    circuit,
    remainingAfterCinema,
    circuit.affine([[contactWithinRemaining, -1]], 1),
  )
  const weights = [cinema, contact, story]
  const horizontalOffset = circuit.affine([
    [learnableField.horizontalOffset, 0.1],
  ], -0.05)
  const verticalOffset = circuit.affine([
    [learnableField.verticalOffset, 0.1],
  ], -0.05)
  const horizontalScale = circuit.affine([
    [learnableField.horizontalScale, 0.2],
  ], 0.9)
  const verticalScale = circuit.affine([
    [learnableField.verticalScale, 0.2],
  ], 0.9)
  circuit.assumeRange(horizontalScale, 0.9, 1.1)
  circuit.assumeRange(verticalScale, 0.9, 1.1)
  const presence = Array.from(
    {length: learnedSlotCount},
    (_, item) => presenceField(item),
  )
  const expandedPresence = emitRelu(circuit, circuit.affine(
    presence.map(wire => [wire, 1]),
    -(learnedPhotoCount + 1),
  ))
  const expandedMass = emitMinimum(circuit, unit, expandedPresence)

  const geometries: WireGeometry[] = []
  for (let item = 0; item < learnedSlotCount; item++) {
    function layoutValue(
      name: LearnedLayoutName,
      field: keyof NumericGeometry,
    ) {
      const compact = compactLayouts[name][item]![field]
      const expanded = expandedLayouts[name][item]![field]
      return circuit.affine([[expandedMass, expanded - compact]], compact)
    }
    function mix(field: keyof NumericGeometry) {
      return circuit.affine([
        [emitMultiply(circuit, cinema, layoutValue('cinema', field)), 1],
        [emitMultiply(circuit, contact, layoutValue('contact', field)), 1],
        [emitMultiply(circuit, story, layoutValue('story', field)), 1],
      ])
    }
    geometries.push({
      left: circuit.affine([
        [emitMultiply(circuit, mix('left'), horizontalScale), 1],
        [horizontalOffset, 1],
      ]),
      top: circuit.affine([
        [emitMultiply(circuit, mix('top'), verticalScale), 1],
        [verticalOffset, 1],
      ]),
      width: emitMultiply(circuit, mix('width'), horizontalScale),
      height: emitMultiply(circuit, mix('height'), verticalScale),
    })
  }

  return {
    circuit,
    output: {
      geometries: flattenWireGeometries(geometries),
      weights,
      presence,
    },
  }
}

export function createLearnedGalleryMachine(
  targetName: LearnedLayoutName = 'story',
) {
  const {circuit, output} = createLearnedGalleryCircuit()
  const wireCount = validateCircuit(circuit)
  validateWireView(
    output.geometries,
    learnedSlotCount * learnedGeometryField.size,
    wireCount,
  )
  validateWireView(output.weights, learnedLayoutNames.length, wireCount)
  validateWireView(output.presence, learnedSlotCount, wireCount)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([
    ...output.geometries,
    ...output.weights,
    ...output.presence,
  ])
  validateTensorProgram(circuit, tensorProgram)
  const target = createLearnedGalleryTarget(targetName)
  const source = new Float32Array(learnableField.size)
  const firstMoment = new Float32Array(parameterCount)
  const secondMoment = new Float32Array(parameterCount)
  let trainingStep = 0

  function clearOptimizer() {
    firstMoment.fill(0)
    secondMoment.fill(0)
    trainingStep = 0
  }

  function reset() {
    source.fill(0.5)
    source[learnableField.cinema] = 0.55
    source[learnableField.unit] = 1
    clearOptimizer()
  }

  function activeTargetItems() {
    const items: number[] = []
    for (let item = 0; item < learnedSlotCount; item++) {
      if (target.active[item] === 1) items.push(item)
    }
    return items
  }

  function targetFieldCount(activeCount: number) {
    return activeCount * learnedGeometryField.size
      + learnedSlotCount * presenceLossWeight
  }

  function robustGeometryLoss(error: number) {
    const magnitude = Math.abs(error)
    return magnitude <= geometryLossThreshold
      ? 0.5 * error * error
      : geometryLossThreshold * (magnitude - 0.5 * geometryLossThreshold)
  }

  function robustGeometryGradient(error: number) {
    return Math.max(
      -geometryLossThreshold,
      Math.min(geometryLossThreshold, error),
    )
  }

  function geometryLoss(
    values: Float32Array,
    targetItem: number,
    outputItem: number,
  ) {
    const targetStart = targetItem * learnedGeometryField.size
    const outputStart = outputItem * learnedGeometryField.size
    let loss = 0
    for (let field = 0; field < learnedGeometryField.size; field++) {
      const error = values[output.geometries[outputStart + field]!]!
        - target.geometries[targetStart + field]!
      loss += robustGeometryLoss(error)
    }
    return loss
  }

  function matchRectangles(
    values: Float32Array,
    targetItems: readonly number[],
  ) {
    const costs = targetItems.map(targetItem =>
      Array.from({length: learnedSlotCount}, (_, outputItem) =>
        geometryLoss(values, targetItem, outputItem)))
    return minimumCostAssignment(costs)
  }

  function measure(values: Float32Array) {
    const targetItems = activeTargetItems()
    const outputByTarget = matchRectangles(values, targetItems)
    const matchedOutputs = new Uint8Array(learnedSlotCount)
    for (const outputItem of outputByTarget) matchedOutputs[outputItem] = 1
    let loss = 0
    for (let item = 0; item < learnedSlotCount; item++) {
      const expectedPresence = matchedOutputs[item]!
      const presenceError = values[output.presence[item]!]! - expectedPresence
      loss += 0.5 * presenceLossWeight * presenceError * presenceError
    }
    for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
      loss += geometryLoss(
        values,
        targetItems[targetIndex]!,
        outputByTarget[targetIndex]!,
      )
    }
    return loss / targetFieldCount(targetItems.length)
  }

  function trainStep() {
    const values = circuit.evaluateReference(source)
    const targetItems = activeTargetItems()
    const outputByTarget = matchRectangles(values, targetItems)
    const matchedOutputs = new Uint8Array(learnedSlotCount)
    for (const outputItem of outputByTarget) matchedOutputs[outputItem] = 1
    const outputGradients = new Float32Array(values.length)
    const gradientScale = 1 / targetFieldCount(targetItems.length)
    for (let item = 0; item < learnedSlotCount; item++) {
      const expectedPresence = matchedOutputs[item]!
      const presenceWire = output.presence[item]!
      outputGradients[presenceWire] = Math.fround(
        presenceLossWeight
          * (values[presenceWire]! - expectedPresence)
          * gradientScale,
      )
    }
    for (let targetIndex = 0; targetIndex < targetItems.length; targetIndex++) {
      const targetStart = targetItems[targetIndex]! * learnedGeometryField.size
      const outputStart = outputByTarget[targetIndex]! * learnedGeometryField.size
      for (let field = 0; field < learnedGeometryField.size; field++) {
        const wire = output.geometries[outputStart + field]!
        const error = values[wire]!
          - target.geometries[targetStart + field]!
        outputGradients[wire] = Math.fround(
          outputGradients[wire]!
            + robustGeometryGradient(error) * gradientScale,
        )
      }
    }
    const gradients = circuit.backpropagateReference(values, outputGradients)
    trainingStep++
    const firstDecay = 0.9
    const secondDecay = 0.999
    const learningRate = 0.03
    const firstCorrection = 1 - firstDecay ** trainingStep
    const secondCorrection = 1 - secondDecay ** trainingStep
    for (let parameter = 0; parameter < parameterCount; parameter++) {
      const gradient = gradients[parameter]!
      firstMoment[parameter] = firstDecay * firstMoment[parameter]! + (1 - firstDecay) * gradient
      secondMoment[parameter] = secondDecay * secondMoment[parameter]!
        + (1 - secondDecay) * gradient * gradient
      const correctedFirst = firstMoment[parameter]! / firstCorrection
      const correctedSecond = secondMoment[parameter]! / secondCorrection
      source[parameter] = source[parameter]!
        - learningRate * correctedFirst / (Math.sqrt(correctedSecond) + 1e-8)
      source[parameter] = Math.min(1, Math.max(0, source[parameter]!))
    }
  }

  reset()

  function setTargetGeometry(item: number, geometry: LearnedTargetGeometry) {
    invariant(
      Number.isInteger(item) && item >= 0 && item < learnedSlotCount,
      'target slot index is invalid',
    )
    invariant(
      Number.isFinite(geometry.left)
        && Number.isFinite(geometry.top)
        && Number.isFinite(geometry.width)
        && Number.isFinite(geometry.height)
        && geometry.left >= 0
        && geometry.top >= 0
        && geometry.width > 0
        && geometry.height > 0
        && geometry.left + geometry.width <= 1
        && geometry.top + geometry.height <= 1,
      'target geometry must be a positive rectangle within the stage',
    )
    const start = item * learnedGeometryField.size
    target.geometries[start + learnedGeometryField.left] = geometry.left
    target.geometries[start + learnedGeometryField.top] = geometry.top
    target.geometries[start + learnedGeometryField.width] = geometry.width
    target.geometries[start + learnedGeometryField.height] = geometry.height
    target.active[item] = 1
    clearOptimizer()
  }

  return {
    circuit,
    output,
    source,
    target,
    tensorProgram,
    get trainingStep() {
      return trainingStep
    },
    reset,
    setTargetGeometry,
    addTargetGeometry(geometry: LearnedTargetGeometry) {
      const item = target.active.indexOf(0)
      if (item < 0) return -1
      setTargetGeometry(item, geometry)
      return item
    },
    removeTargetGeometry(item: number) {
      invariant(
        Number.isInteger(item) && item >= 0 && item < learnedSlotCount,
        'target slot index is invalid',
      )
      target.active[item] = 0
      target.geometries.fill(
        0,
        item * learnedGeometryField.size,
        (item + 1) * learnedGeometryField.size,
      )
      clearOptimizer()
    },
    train(steps = 1) {
      invariant(Number.isInteger(steps) && steps >= 0, 'training step count is invalid')
      for (let step = 0; step < steps; step++) trainStep()
      const values = circuit.evaluateTensor(source)
      assertFiniteValues(values, 'learned gallery values')
      return {
        values,
        loss: measure(values),
        step: trainingStep,
      }
    },
    evaluate() {
      const values = circuit.evaluateTensor(source)
      assertFiniteValues(values, 'learned gallery values')
      return {
        values,
        loss: measure(values),
        step: trainingStep,
      }
    },
  }
}

type LearnedGalleryDomCache = {
  targetStage: HTMLElement
  weightValues: HTMLElement[]
  targetRectangles: HTMLElement[]
  learnedRectangles: HTMLElement[]
}

function requireElement(document: Document, selector: string, message: string) {
  const element = document.querySelector<HTMLElement>(selector)
  invariant(element !== null, message)
  return element
}

function projectGeometry(
  element: HTMLElement,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  element.style.left = `${left * 100}%`
  element.style.top = `${top * 100}%`
  element.style.width = `${Math.max(0, width) * 100}%`
  element.style.height = `${Math.max(0, height) * 100}%`
}

function createLearnedGalleryDomCache(document: Document): LearnedGalleryDomCache {
  const targetStage = requireElement(document, '#learning-target', 'learning target is missing')
  const learnedStage = requireElement(document, '#learning-result', 'learning result is missing')
  const weightValues = Array.from(
    document.querySelectorAll<HTMLElement>('.learning-weight b'),
  )
  invariant(weightValues.length === learnedLayoutNames.length, 'learning weights are missing')
  const targetRectangles: HTMLElement[] = []
  const learnedRectangles: HTMLElement[] = []

  for (let item = 0; item < learnedSlotCount; item++) {
    const targetRectangle = document.createElement('div')
    targetRectangle.className = 'target-rectangle'
    targetRectangle.dataset['targetIndex'] = `${item}`
    const resizeHandle = document.createElement('i')
    resizeHandle.className = 'target-resize-handle'
    targetRectangle.appendChild(resizeHandle)
    targetStage.appendChild(targetRectangle)
    targetRectangles.push(targetRectangle)

    const learnedRectangle = document.createElement('div')
    const photo = item === 0 ? 0 : (item - 1) % learnedPhotoCount
    learnedRectangle.className = `learned-rectangle image-${photo}`
    if (item === 0) {
      const title = document.createElement('span')
      title.textContent = photoNames[0]
      learnedRectangle.appendChild(title)
    }
    learnedStage.appendChild(learnedRectangle)
    learnedRectangles.push(learnedRectangle)
  }

  return {
    targetStage, // cache lifetime: mount
    weightValues, // cache lifetime: mount
    targetRectangles, // cache lifetime: mount
    learnedRectangles, // cache lifetime: mount
  }
}

function renderLearnedGallery(
  domCache: LearnedGalleryDomCache,
  machine: ReturnType<typeof createLearnedGalleryMachine>,
  result: ReturnType<typeof machine.evaluate>,
  selectedTarget: number | null,
) {
  for (let item = 0; item < domCache.targetRectangles.length; item++) {
    const start = item * learnedGeometryField.size
    const active = machine.target.active[item] === 1
    const rectangle = domCache.targetRectangles[item]!
    rectangle.className = selectedTarget === item
      ? 'target-rectangle is-selected'
      : 'target-rectangle'
    rectangle.style.display = active ? 'block' : 'none'
    projectGeometry(
      rectangle,
      machine.target.geometries[start + learnedGeometryField.left]!,
      machine.target.geometries[start + learnedGeometryField.top]!,
      machine.target.geometries[start + learnedGeometryField.width]!,
      machine.target.geometries[start + learnedGeometryField.height]!,
    )
  }
  for (let item = 0; item < domCache.learnedRectangles.length; item++) {
    const start = item * learnedGeometryField.size
    const rectangle = domCache.learnedRectangles[item]!
    const geometryWires = machine.output.geometries
    projectGeometry(
      rectangle,
      result.values[geometryWires[start + learnedGeometryField.left]!]!,
      result.values[geometryWires[start + learnedGeometryField.top]!]!,
      result.values[geometryWires[start + learnedGeometryField.width]!]!,
      result.values[geometryWires[start + learnedGeometryField.height]!]!,
    )
    rectangle.style.opacity = `${result.values[machine.output.presence[item]!]!}`
  }
  for (let layout = 0; layout < machine.output.weights.length; layout++) {
    domCache.weightValues[layout]!.textContent =
      result.values[machine.output.weights[layout]!]!.toFixed(3)
  }
}

if (typeof document !== 'undefined' && document.querySelector('#learning-demo') !== null) {
  type PointerFact = {
    kind: 'down' | 'move' | 'up'
    pointerId: number
    clientX: number
    clientY: number
    target: EventTarget | null
  }

  type EditorDrag = {
    mode: 'move' | 'resize'
    pointerId: number
    item: number
    startX: number
    startY: number
    geometry: LearnedTargetGeometry
  }

  const maximumTrainingSteps = 900
  const stepsPerFrame = 5
  const minimumRectangleSize = 0.04
  const addedRectangleWidth = 0.2
  const addedRectangleHeight = 0.14
  const machine = createLearnedGalleryMachine()
  const domCache = createLearnedGalleryDomCache(document)
  let deleteRequested = false
  let selectedTarget: number | null = null
  let editorDrag: EditorDrag | null = null
  let pointerFacts: PointerFact[] = []
  let scheduledFrame: number | null = null

  function readTargetGeometry(item: number): LearnedTargetGeometry {
    const start = item * learnedGeometryField.size
    return {
      left: machine.target.geometries[start + learnedGeometryField.left]!,
      top: machine.target.geometries[start + learnedGeometryField.top]!,
      width: machine.target.geometries[start + learnedGeometryField.width]!,
      height: machine.target.geometries[start + learnedGeometryField.height]!,
    }
  }

  function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value))
  }

  function renderLearningFrame() {
    scheduledFrame = null
    const targetBounds = domCache.targetStage.getBoundingClientRect()
    const targetWidth = domCache.targetStage.clientWidth
    const targetHeight = domCache.targetStage.clientHeight
    function normalizedPointer(fact: PointerFact) {
      return {
        x: clamp(
          (fact.clientX - targetBounds.left - domCache.targetStage.clientLeft) / targetWidth,
          0,
          1,
        ),
        y: clamp(
          (fact.clientY - targetBounds.top - domCache.targetStage.clientTop) / targetHeight,
          0,
          1,
        ),
      }
    }

    for (const fact of pointerFacts) {
      const pointer = normalizedPointer(fact)
      if (fact.kind === 'down') {
        const eventTarget = fact.target instanceof Element ? fact.target : null
        const targetRectangle = eventTarget?.closest<HTMLElement>('.target-rectangle')
        const targetIndexText = targetRectangle?.dataset['targetIndex']
        if (targetIndexText !== undefined) {
          const item = Number(targetIndexText)
          invariant(
            Number.isInteger(item) && item >= 0 && item < learnedSlotCount,
            'target rectangle index is invalid',
          )
          selectedTarget = item
          editorDrag = {
            mode: eventTarget?.closest('.target-resize-handle') === null ? 'move' : 'resize',
            pointerId: fact.pointerId,
            item,
            startX: pointer.x,
            startY: pointer.y,
            geometry: readTargetGeometry(item),
          }
        } else {
          const left = clamp(
            pointer.x - addedRectangleWidth / 2,
            0,
            1 - addedRectangleWidth,
          )
          const top = clamp(
            pointer.y - addedRectangleHeight / 2,
            0,
            1 - addedRectangleHeight,
          )
          const item = machine.addTargetGeometry({
            left,
            top,
            width: addedRectangleWidth,
            height: addedRectangleHeight,
          })
          selectedTarget = item < 0 ? null : item
          editorDrag = item < 0
            ? null
            : {
              mode: 'move',
              pointerId: fact.pointerId,
              item,
              startX: pointer.x,
              startY: pointer.y,
              geometry: readTargetGeometry(item),
            }
        }
      } else if (
        fact.kind === 'move'
        && editorDrag !== null
        && editorDrag.pointerId === fact.pointerId
      ) {
        const horizontalChange = pointer.x - editorDrag.startX
        const verticalChange = pointer.y - editorDrag.startY
        const geometry = editorDrag.geometry
        machine.setTargetGeometry(
          editorDrag.item,
          editorDrag.mode === 'move'
            ? {
              left: clamp(geometry.left + horizontalChange, 0, 1 - geometry.width),
              top: clamp(geometry.top + verticalChange, 0, 1 - geometry.height),
              width: geometry.width,
              height: geometry.height,
            }
            : {
              left: geometry.left,
              top: geometry.top,
              width: clamp(
                geometry.width + horizontalChange,
                minimumRectangleSize,
                1 - geometry.left,
              ),
              height: clamp(
                geometry.height + verticalChange,
                minimumRectangleSize,
                1 - geometry.top,
              ),
            },
        )
      } else if (
        fact.kind === 'up'
        && editorDrag?.pointerId === fact.pointerId
      ) {
        editorDrag = null
      }
    }
    pointerFacts = []
    if (deleteRequested && selectedTarget !== null) {
      machine.removeTargetGeometry(selectedTarget)
      selectedTarget = null
      editorDrag = null
    }
    deleteRequested = false

    const trainingSteps = Math.min(
      stepsPerFrame,
      maximumTrainingSteps - machine.trainingStep,
    )
    const result = trainingSteps > 0
      ? machine.train(trainingSteps)
      : machine.evaluate()
    const training = result.step < maximumTrainingSteps
    renderLearnedGallery(domCache, machine, result, selectedTarget)
    if (training) scheduleRender()
  }

  function scheduleRender() {
    if (scheduledFrame !== null) return
    scheduledFrame = requestAnimationFrame(renderLearningFrame)
  }

  domCache.targetStage.addEventListener('pointerdown', event => {
    domCache.targetStage.focus({preventScroll: true})
    domCache.targetStage.setPointerCapture(event.pointerId)
    pointerFacts.push({
      kind: 'down',
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
    })
    scheduleRender()
  })
  domCache.targetStage.addEventListener('pointermove', event => {
    pointerFacts.push({
      kind: 'move',
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
    })
    scheduleRender()
  })
  function finishPointer(event: PointerEvent) {
    pointerFacts.push({
      kind: 'up',
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
    })
    scheduleRender()
  }
  domCache.targetStage.addEventListener('pointerup', finishPointer)
  domCache.targetStage.addEventListener('pointercancel', finishPointer)
  domCache.targetStage.addEventListener('keydown', event => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    event.preventDefault()
    deleteRequested = true
    scheduleRender()
  })
  renderLearningFrame()
}

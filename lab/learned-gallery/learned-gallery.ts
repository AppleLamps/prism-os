import {
  createTrainableGeometryMachine,
  trainableGeometryField,
  type TrainableGeometry,
  type TrainableGeometryTarget,
} from './trainable-geometry.ts'
import {invariant} from '../../src/runtime/numeric-ui-core.ts'

export const learnedPhotoCount = 12
export const learnedSlotCount = 20
export const learnedGeometryField = trainableGeometryField

export const learnedLayoutNames = ['Cinema', 'Contact', 'Story'] as const

export type LearnedLayoutName = Lowercase<(typeof learnedLayoutNames)[number]>
export type LearnedTargetGeometry = TrainableGeometry
export type LearnedGalleryTarget = TrainableGeometryTarget

const targetRoughness = 0.002

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

function createContactLayout(rowCount: number): TrainableGeometry[] {
  const gap = 0.025
  const width = (1 - gap * 5) / 4
  const height = (1 - gap * (rowCount + 1)) / rowCount
  return Array.from({length: learnedSlotCount}, (_, item) => ({
    left: gap + item % 4 * (width + gap),
    top: gap + Math.floor(item / 4) * (height + gap),
    width,
    height,
  }))
}

function createCinemaLayout(rowCount: number): TrainableGeometry[] {
  const gap = 0.025
  const railWidth = 0.27
  const heroWidth = 1 - railWidth - gap * 3
  const thumbnailWidth = (railWidth - gap) / 2
  const thumbnailHeight = (1 - gap * (rowCount + 1)) / rowCount
  const railLeft = gap * 2 + heroWidth
  const geometries: TrainableGeometry[] = [{
    left: gap,
    top: gap,
    width: heroWidth,
    height: 1 - gap * 2,
  }]
  for (let item = 0; item < learnedSlotCount - 1; item++) {
    geometries.push({
      left: railLeft + item % 2 * (thumbnailWidth + gap),
      top: gap + Math.floor(item / 2) * (thumbnailHeight + gap),
      width: thumbnailWidth,
      height: thumbnailHeight,
    })
  }
  return geometries
}

function createStoryLayout(rowCount: number): TrainableGeometry[] {
  const gap = 0.025
  const heroHeight = rowCount <= 4 ? 0.5 : 0.42
  const thumbnailWidth = (1 - gap * 4) / 3
  const thumbnailHeight = (1 - heroHeight - gap * (rowCount + 2)) / rowCount
  const thumbnailTop = heroHeight + gap * 2
  const geometries: TrainableGeometry[] = [{
    left: gap,
    top: gap,
    width: 1 - gap * 2,
    height: heroHeight,
  }]
  for (let item = 0; item < learnedSlotCount - 1; item++) {
    geometries.push({
      left: gap + item % 3 * (thumbnailWidth + gap),
      top: thumbnailTop + Math.floor(item / 3) * (thumbnailHeight + gap),
      width: thumbnailWidth,
      height: thumbnailHeight,
    })
  }
  return geometries
}

const initialLayouts = {
  cinema: createCinemaLayout(Math.ceil(learnedPhotoCount / 2)),
  contact: createContactLayout(Math.ceil(learnedPhotoCount / 4)),
  story: createStoryLayout(Math.ceil(learnedPhotoCount / 3)),
} satisfies Record<LearnedLayoutName, TrainableGeometry[]>

export function createLearnedGalleryTarget(
  name: LearnedLayoutName = 'story',
): LearnedGalleryTarget {
  const base = initialLayouts[name]
  const count = name === 'contact' ? learnedPhotoCount : learnedPhotoCount + 1
  const geometries = new Float32Array(
    learnedSlotCount * learnedGeometryField.size,
  )
  const active = new Uint8Array(learnedSlotCount)
  for (let item = 0; item < count; item++) {
    const geometry = base[item]!
    const start = item * learnedGeometryField.size
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

export function createLearnedGalleryMachine(
  targetName: LearnedLayoutName = 'story',
) {
  const target = createLearnedGalleryTarget(targetName)
  const machine = createTrainableGeometryMachine(target)

  function setTargetGeometry(
    item: number,
    geometry: LearnedTargetGeometry,
  ) {
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
  }

  return {
    ...machine,
    // The spread above copies trainingStep's value at this moment, which is 0, so the wrapper has its own getter.
    get trainingStep() {
      return machine.trainingStep
    },
    output: {
      geometries: machine.geometries,
    },
    target,
    setTargetGeometry,
    activeCount() {
      let count = 0
      for (const active of target.active) count += active
      return count
    },
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
    },
  }
}

type LearnedGalleryDomCache = {
  targetStage: HTMLElement
  targetRectangles: HTMLElement[]
  learnedRectangles: HTMLElement[]
  coefficientCount: HTMLElement
  trainingLoss: HTMLElement
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
  const targetStage = requireElement(
    document,
    '#learning-target',
    'learning target is missing',
  )
  const learnedStage = requireElement(
    document,
    '#learning-result',
    'learning result is missing',
  )
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
    const photo = item % learnedPhotoCount
    learnedRectangle.className = `learned-rectangle image-${photo}`
    const title = document.createElement('span')
    title.textContent = photoNames[photo]!
    learnedRectangle.appendChild(title)
    learnedStage.appendChild(learnedRectangle)
    learnedRectangles.push(learnedRectangle)
  }

  return {
    targetStage,
    targetRectangles,
    learnedRectangles,
    coefficientCount: requireElement(
      document,
      '#learning-coefficients',
      'coefficient count is missing',
    ),
    trainingLoss: requireElement(
      document,
      '#learning-loss',
      'training loss is missing',
    ),
  }
}

function renderLearnedGallery(
  domCache: LearnedGalleryDomCache,
  machine: ReturnType<typeof createLearnedGalleryMachine>,
  result: ReturnType<typeof machine.evaluate>,
  selectedTarget: number | null,
) {
  for (let item = 0; item < learnedSlotCount; item++) {
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
  const activeCount = machine.activeCount()
  for (let item = 0; item < learnedSlotCount; item++) {
    const start = item * learnedGeometryField.size
    const rectangle = domCache.learnedRectangles[item]!
    rectangle.style.display = item < activeCount ? 'block' : 'none'
    projectGeometry(
      rectangle,
      result.values[machine.geometries[start + learnedGeometryField.left]!]!,
      result.values[machine.geometries[start + learnedGeometryField.top]!]!,
      result.values[machine.geometries[start + learnedGeometryField.width]!]!,
      result.values[machine.geometries[start + learnedGeometryField.height]!]!,
    )
  }
  domCache.coefficientCount.textContent =
    machine.parameterCount.toLocaleString('en-US')
  domCache.trainingLoss.textContent = result.loss.toExponential(2)
}

if (
  typeof document !== 'undefined'
  && document.querySelector('#learning-demo') !== null
) {
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

  const maximumTrainingSteps = 500
  const stepsPerFrame = 10
  const minimumRectangleSize = 0.04
  const addedRectangleWidth = 0.2
  const addedRectangleHeight = 0.14
  const machine = createLearnedGalleryMachine()
  const domCache = createLearnedGalleryDomCache(document)
  let deleteRequested = false
  let targetChanged = false
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
          (fact.clientX - targetBounds.left - domCache.targetStage.clientLeft)
            / targetWidth,
          0,
          1,
        ),
        y: clamp(
          (fact.clientY - targetBounds.top - domCache.targetStage.clientTop)
            / targetHeight,
          0,
          1,
        ),
      }
    }

    for (const fact of pointerFacts) {
      const pointer = normalizedPointer(fact)
      if (fact.kind === 'down') {
        const eventTarget = fact.target instanceof Element ? fact.target : null
        const targetRectangle =
          eventTarget?.closest<HTMLElement>('.target-rectangle')
        const targetIndexText = targetRectangle?.dataset['targetIndex']
        if (targetIndexText !== undefined) {
          const item = Number(targetIndexText)
          invariant(
            Number.isInteger(item) && item >= 0 && item < learnedSlotCount,
            'target rectangle index is invalid',
          )
          selectedTarget = item
          editorDrag = {
            mode: eventTarget?.closest('.target-resize-handle') === null
              ? 'move'
              : 'resize',
            pointerId: fact.pointerId,
            item,
            startX: pointer.x,
            startY: pointer.y,
            geometry: readTargetGeometry(item),
          }
        } else {
          const item = machine.addTargetGeometry({
            left: clamp(
              pointer.x - addedRectangleWidth / 2,
              0,
              1 - addedRectangleWidth,
            ),
            top: clamp(
              pointer.y - addedRectangleHeight / 2,
              0,
              1 - addedRectangleHeight,
            ),
            width: addedRectangleWidth,
            height: addedRectangleHeight,
          })
          selectedTarget = item < 0 ? null : item
          targetChanged = item >= 0
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
              left: clamp(
                geometry.left + horizontalChange,
                0,
                1 - geometry.width,
              ),
              top: clamp(
                geometry.top + verticalChange,
                0,
                1 - geometry.height,
              ),
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
        targetChanged = true
      } else if (
        fact.kind === 'up'
        && editorDrag?.pointerId === fact.pointerId
      ) {
        editorDrag = null
        if (targetChanged) machine.reset()
        targetChanged = false
      }
    }
    pointerFacts = []
    if (deleteRequested && selectedTarget !== null) {
      machine.removeTargetGeometry(selectedTarget)
      machine.reset()
      selectedTarget = null
      editorDrag = null
    }
    deleteRequested = false

    const trainingSteps = editorDrag === null
      ? Math.min(
        stepsPerFrame,
        maximumTrainingSteps - machine.trainingStep,
      )
      : 0
    const result = trainingSteps > 0
      ? machine.train(trainingSteps)
      : machine.evaluate()
    renderLearnedGallery(domCache, machine, result, selectedTarget)
    if (result.step < maximumTrainingSteps && editorDrag === null) {
      scheduleRender()
    }
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

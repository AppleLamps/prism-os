// The learned gallery: a small network outputs one rectangle for each photo, and the page trains the network's 244
// weights with backpropagation until the rectangles match a sketch that the visitor edits. The weights are the
// program's only inputs. trainable-geometry.ts holds the network, the loss and the optimizer. This file holds the
// preset sketches, the editor, which is the page's state and what one frame does to that state, and the page.
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

// The page's stage is 5 wide and 4 tall (learned-gallery.css), and a layout's numbers are fractions of the stage, so
// a vertical fraction is 5/4 of the horizontal fraction of the same length on screen, e.g. the margin is 0.036 of
// the width and 0.045 of the height.
const layoutMarginX = 0.036
const layoutGapX = 0.02
const layoutMarginY = layoutMarginX * 5 / 4
const layoutGapY = layoutGapX * 5 / 4
const layoutWidth = 1 - layoutMarginX * 2
const layoutHeight = 1 - layoutMarginY * 2

// The first cells of a grid, row by row.
function createGridCells(
  left: number,
  top: number,
  width: number,
  height: number,
  columnCount: number,
  rowCount: number,
  cellCount: number,
): TrainableGeometry[] {
  const cellWidth = (width - layoutGapX * (columnCount - 1)) / columnCount
  const cellHeight = (height - layoutGapY * (rowCount - 1)) / rowCount
  return Array.from({length: cellCount}, (_, cell) => ({
    left: left + cell % columnCount * (cellWidth + layoutGapX),
    top: top + Math.floor(cell / columnCount) * (cellHeight + layoutGapY),
    width: cellWidth,
    height: cellHeight,
  }))
}

// Each layout has fewer rectangles than there are photos and leaves its last cell empty, so a visitor has room to
// add one. Edges of different rectangles are either equal or at least 0.09 apart: the loss pulls edges that are
// within about 0.05 of each other toward a shared value (relationSigma in trainable-geometry.ts), so the network
// doesn't fit such edges closely, e.g. a row of 4 cells above a row of 5 stayed 1.3% of the stage off after
// 1,500 steps.

// 4 columns and 3 rows.
function createContactLayout(): TrainableGeometry[] {
  return createGridCells(layoutMarginX, layoutMarginY, layoutWidth, layoutHeight, 4, 3, 11)
}

// A large rectangle, and a rail of 2 columns and 5 rows beside it.
function createCinemaLayout(): TrainableGeometry[] {
  const railColumnWidth = 0.13
  const railWidth = railColumnWidth * 2 + layoutGapX
  const heroWidth = layoutWidth - railWidth - layoutGapX
  return [
    {left: layoutMarginX, top: layoutMarginY, width: heroWidth, height: layoutHeight},
    ...createGridCells(layoutMarginX + heroWidth + layoutGapX, layoutMarginY, railWidth, layoutHeight, 2, 5, 8),
  ]
}

// A large rectangle, two beside it, and 2 rows of 4 below. Among 200 variants of these proportions, the network's
// fit after 500 steps from its seeded start left a largest error from 0.13% to 2.9% of the stage, with a median of
// 1.2%. These proportions are one of the closest fits, 0.15%, and a test keeps it under 0.3%.
function createStoryLayout(): TrainableGeometry[] {
  const heroWidth = 0.6
  const heroHeight = 0.52
  return [
    {left: layoutMarginX, top: layoutMarginY, width: heroWidth, height: heroHeight},
    ...createGridCells(
      layoutMarginX + heroWidth + layoutGapX,
      layoutMarginY,
      layoutWidth - heroWidth - layoutGapX,
      heroHeight,
      1,
      2,
      2,
    ),
    ...createGridCells(
      layoutMarginX,
      layoutMarginY + heroHeight + layoutGapY,
      layoutWidth,
      layoutHeight - heroHeight - layoutGapY,
      4,
      2,
      7,
    ),
  ]
}

const initialLayouts = {
  cinema: createCinemaLayout(),
  contact: createContactLayout(),
  story: createStoryLayout(),
} satisfies Record<LearnedLayoutName, TrainableGeometry[]>

export function createLearnedGalleryTarget(
  name: LearnedLayoutName = 'story',
): LearnedGalleryTarget {
  const geometries = new Float32Array(
    learnedSlotCount * learnedGeometryField.size,
  )
  const active = new Uint8Array(learnedSlotCount)
  const layout = initialLayouts[name]
  for (let item = 0; item < layout.length; item++) {
    const geometry = layout[item]!
    const start = item * learnedGeometryField.size
    active[item] = 1
    geometries[start + learnedGeometryField.left] = geometry.left
    geometries[start + learnedGeometryField.top] = geometry.top
    geometries[start + learnedGeometryField.width] = geometry.width
    geometries[start + learnedGeometryField.height] = geometry.height
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

  function activeCount() {
    let count = 0
    for (const active of target.active) count += active
    return count
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
    activeCount,
    // Replaces the whole sketch with a preset. The weights stay as they are until reset().
    setTargetLayout(name: LearnedLayoutName) {
      const layout = createLearnedGalleryTarget(name)
      target.geometries.set(layout.geometries)
      target.active.set(layout.active)
    },
    // Returns the new rectangle's slot, or -1 when every photo already has a rectangle.
    addTargetGeometry(geometry: LearnedTargetGeometry) {
      if (activeCount() >= learnedPhotoCount) return -1
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

// After the sketch changes, training runs this many more steps from the current weights.
export const trainingStepsAfterChange = 500
// Training steps are tied to time, as chenguini's ui.md ties animation steps: 600 a second is 10 steps in a frame
// of a 60 Hz display and 5 in a frame of a 120 Hz display, so training lasts as long on both.
export const msPerTrainingStep = 1000 / 600
// The most steps one frame trains, e.g. in the first frame after the tab was in the background. A frame also trains
// no more steps than fit in trainingMsPerFrame at the cost per step measured in the frame before, so a slow device
// trains fewer steps per frame instead of dropping frames. One step took 0.26 ms in Bun and about 0.4 ms in Chrome
// 155 on an M5 Max (October 13, 2026), where 6 ms is 15 steps. Before the first measurement a frame trains at most
// unmeasuredTrainingStepsPerFrame steps, and the frames after it make up for the difference.
export const maximumTrainingStepsPerFrame = 20
export const trainingMsPerFrame = 6
export const unmeasuredTrainingStepsPerFrame = 4
// The loss chart shows this many of the latest steps.
export const chartStepCount = trainingStepsAfterChange

const minimumRectangleSize = 0.04
const addedRectangleWidth = 0.2
const addedRectangleHeight = 0.16
// A press this close to a rectangle's bottom right corner resizes the rectangle, in CSS pixels, and at most half
// of the rectangle's width and height, so a small rectangle can still be moved.
const mouseHandleReach = 16
const touchHandleReach = 28
// A finger that moves farther than this from where it pressed empty space isn't a tap, in CSS pixels.
const tapSlop = 10

// What a pointer, a key or a button did since the last frame. Positions are CSS pixels from the top left corner of
// the sketch's stage, inside its border. A move's `pressed` says whether a mouse button, a finger or a pen's tip
// was down during the move.
export type LearnedGalleryInput =
  | {kind: 'pointer down', pointerId: number, x: number, y: number, touch: boolean}
  | {kind: 'pointer move', pointerId: number, x: number, y: number, touch: boolean, pressed: boolean}
  | {kind: 'pointer up' | 'pointer cancel' | 'pointer leave', pointerId: number}
  | {kind: 'delete'}
  | {kind: 'layout', name: LearnedLayoutName}
  | {kind: 'train again'}

type EditorDrag = {
  mode: 'move' | 'resize'
  pointerId: number
  item: number
  // Where the press was, in fractions of the stage, and the rectangle's geometry at the press.
  startX: number
  startY: number
  geometry: LearnedTargetGeometry
}

export type LearnedGalleryFrame = {
  // The program's outputs, read through machine.geometries, with their loss and the number of optimizer steps since
  // the weights were last reset.
  values: Float32Array
  loss: number
  step: number
  // Whether steps remain, i.e. whether the page needs another frame.
  training: boolean
  stepsThisFrame: number
  // The average cost of a step over the latest training that took a step, or null before the first step, e.g. in
  // the page's first frame. A training that takes no step, e.g. "Train again" with an empty sketch, keeps the number.
  msPerStep: number | null
  activeCount: number
  // The preset that the sketch still equals, or null after an edit.
  layout: LearnedLayoutName | null
  selected: number | null
  // The output rectangle that the loss pairs with the selected rectangle.
  selectedOutput: number | null
  hovered: number | null
  cursor: 'default' | 'crosshair' | 'grab' | 'grabbing' | 'nwse-resize'
  // Which output rectangles are in use, 1 for as many as the sketch has rectangles. Output k shows photo k.
  outputs: Uint8Array
  // The z-index of each sketch rectangle and of each output rectangle: a smaller rectangle is above a larger one,
  // so no rectangle is hidden under another.
  sketchStack: number[]
  outputStack: number[]
  // The loss after each frame's steps, for the latest chartStepCount steps.
  history: readonly {step: number, loss: number}[]
  // Side effects for the page: a press focuses the stage, and a drag that started in this frame and is still held
  // captures its pointer.
  pressed: boolean
  capturedPointer: number | null
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

// Ranks from 0 for the largest area. Equal areas rank in slot order.
function stackByArea(areas: readonly number[]) {
  const order = areas.map((_, item) => item).sort((a, b) => areas[b]! - areas[a]! || a - b)
  const stack = Array<number>(areas.length).fill(0)
  order.forEach((item, rank) => {
    stack[item] = rank
  })
  return stack
}

// The page's state, and what one frame does to it, without the DOM: the frame's inputs go in as numbers, and what
// the page draws comes out. readClock times the training steps and returns milliseconds.
export function createLearnedGalleryEditor(readClock: () => number = () => performance.now()) {
  const machine = createLearnedGalleryMachine()
  let layout: LearnedLayoutName | null = 'story'
  let selected: number | null = null
  let drag: EditorDrag | null = null
  // A finger's press on empty space, which adds a rectangle if the finger lifts where it pressed. A mouse adds at
  // the press and keeps dragging the new rectangle.
  let pendingTap: {pointerId: number, x: number, y: number} | null = null
  // The mouse's last position over the stage, in fractions of the stage. null for a finger, and after a leave.
  let hover: {x: number, y: number} | null = null
  let stepsRemaining = trainingStepsAfterChange
  // The time that training has reached, like animatedUntilTime in ui.md's render loop. null while nothing trains.
  let trainedUntilTime: number | null = null
  let measuredMsPerStep = 0
  // The steps of the current training and the time they took, and their average, which the page shows. The
  // average stays while a later training takes no step.
  let runSteps = 0
  let runMs = 0
  let averageMsPerStep: number | null = null
  // The outputs that training fits to the sketch. A new rectangle takes the lowest free output, and a deleted
  // rectangle frees the output that it was paired with, so the photo on the deleted rectangle is the one that
  // disappears, and no other photo moves.
  const outputs = new Uint8Array(learnedSlotCount)
  machine.target.outputs = outputs
  function useFirstOutputs() {
    outputs.fill(0)
    outputs.fill(1, 0, machine.activeCount())
  }
  useFirstOutputs()
  let result = machine.evaluate()
  let history = [{step: result.step, loss: result.loss}]

  function readTargetGeometry(item: number): LearnedTargetGeometry {
    const start = item * learnedGeometryField.size
    return {
      left: machine.target.geometries[start + learnedGeometryField.left]!,
      top: machine.target.geometries[start + learnedGeometryField.top]!,
      width: machine.target.geometries[start + learnedGeometryField.width]!,
      height: machine.target.geometries[start + learnedGeometryField.height]!,
    }
  }

  function stackSketch() {
    return stackByArea(Array.from({length: learnedSlotCount}, (_, item) => {
      if (machine.target.active[item] !== 1) return 0
      const geometry = readTargetGeometry(item)
      return geometry.width * geometry.height
    }))
  }

  // The topmost rectangle under a point, and whether the point is on its corner. reachX and reachY are the corner's
  // size in fractions of the stage.
  function hitTest(x: number, y: number, reachX: number, reachY: number) {
    const stack = stackSketch()
    let hit: {item: number, resize: boolean} | null = null
    let hitRank = -1
    for (let item = 0; item < learnedSlotCount; item++) {
      if (machine.target.active[item] !== 1 || stack[item]! < hitRank) continue
      const {left, top, width, height} = readTargetGeometry(item)
      if (x < left || y < top || x > left + width || y > top + height) continue
      hitRank = stack[item]!
      hit = {
        item,
        resize: x >= left + width - Math.min(reachX, width / 2) && y >= top + height - Math.min(reachY, height / 2),
      }
    }
    return hit
  }

  function addRectangle(x: number, y: number) {
    const item = machine.addTargetGeometry({
      left: clamp(x - addedRectangleWidth / 2, 0, 1 - addedRectangleWidth),
      top: clamp(y - addedRectangleHeight / 2, 0, 1 - addedRectangleHeight),
      width: addedRectangleWidth,
      height: addedRectangleHeight,
    })
    if (item >= 0) outputs[outputs.indexOf(0)] = 1
    return item
  }

  function pairedOutput(item: number) {
    const {targetItems, outputByTarget} = machine.match(result.values)
    return outputByTarget[targetItems.indexOf(item)] ?? null
  }

  function frame(
    frameTime: number,
    stageWidth: number,
    stageHeight: number,
    inputs: readonly LearnedGalleryInput[],
  ): LearnedGalleryFrame {
    // Handle inputs.
    let sketchEdited = false
    let restarted = false
    let pressed = false
    let dragStarted = false
    const mouseReachX = mouseHandleReach / stageWidth
    const mouseReachY = mouseHandleReach / stageHeight
    for (const input of inputs) {
      switch (input.kind) {
        case 'pointer down': {
          // A second finger changes nothing while the first one drags.
          if (drag !== null && drag.pointerId !== input.pointerId) break
          const x = input.x / stageWidth
          const y = input.y / stageHeight
          const reach = input.touch ? touchHandleReach : mouseHandleReach
          const hit = hitTest(x, y, reach / stageWidth, reach / stageHeight)
          pressed = true
          hover = input.touch ? null : {x, y}
          drag = null
          pendingTap = null
          if (hit !== null) {
            selected = hit.item
            dragStarted = true
            drag = {
              mode: hit.resize ? 'resize' : 'move',
              pointerId: input.pointerId,
              item: hit.item,
              startX: x,
              startY: y,
              geometry: readTargetGeometry(hit.item),
            }
          } else if (input.touch) {
            selected = null
            pendingTap = {pointerId: input.pointerId, x, y}
          } else {
            const item = addRectangle(x, y)
            // With a rectangle for every photo already, a press on empty space only clears the selection.
            selected = item < 0 ? null : item
            if (item >= 0) {
              sketchEdited = true
              dragStarted = true
              drag = {
                mode: 'move',
                pointerId: input.pointerId,
                item,
                startX: x,
                startY: y,
                geometry: readTargetGeometry(item),
              }
            }
          }
          break
        }
        case 'pointer move': {
          const x = input.x / stageWidth
          const y = input.y / stageHeight
          hover = input.touch ? null : {x, y}
          if (
            pendingTap?.pointerId === input.pointerId
            && Math.hypot((x - pendingTap.x) * stageWidth, (y - pendingTap.y) * stageHeight) > tapSlop
          ) {
            pendingTap = null
          }
          if (drag?.pointerId !== input.pointerId) break
          // The release never arrived, e.g. the button went up while another window had the mouse. Without this,
          // the rectangle would follow the mouse with no button held.
          if (!input.pressed) {
            drag = null
            break
          }
          const horizontalChange = x - drag.startX
          const verticalChange = y - drag.startY
          const {left, top, width, height} = drag.geometry
          const before = readTargetGeometry(drag.item)
          machine.setTargetGeometry(
            drag.item,
            drag.mode === 'move'
              ? {
                left: clamp(left + horizontalChange, 0, 1 - width),
                top: clamp(top + verticalChange, 0, 1 - height),
                width,
                height,
              }
              : {
                left,
                top,
                width: clamp(width + horizontalChange, minimumRectangleSize, 1 - left),
                height: clamp(height + verticalChange, minimumRectangleSize, 1 - top),
              },
          )
          const after = readTargetGeometry(drag.item)
          // A move that changes nothing, e.g. against the stage's edge, starts no training.
          if (
            after.left !== before.left
            || after.top !== before.top
            || after.width !== before.width
            || after.height !== before.height
          ) {
            sketchEdited = true
          }
          break
        }
        case 'pointer up':
        case 'pointer cancel':
          if (drag?.pointerId === input.pointerId) drag = null
          if (pendingTap?.pointerId === input.pointerId) {
            if (input.kind === 'pointer up') {
              const item = addRectangle(pendingTap.x, pendingTap.y)
              if (item >= 0) {
                selected = item
                sketchEdited = true
              }
            }
            pendingTap = null
          }
          break
        case 'pointer leave':
          hover = null
          break
        case 'delete': {
          if (selected === null) break
          const output = pairedOutput(selected)
          invariant(output !== null, 'the selected rectangle has no output')
          machine.removeTargetGeometry(selected)
          outputs[output] = 0
          selected = null
          drag = null
          sketchEdited = true
          break
        }
        case 'layout':
          machine.setTargetLayout(input.name)
          useFirstOutputs()
          layout = input.name
          selected = null
          drag = null
          pendingTap = null
          sketchEdited = false
          restarted = true
          break
        case 'train again':
          restarted = true
          break
      }
    }
    const activeCount = machine.activeCount()
    if (sketchEdited) layout = null
    // A preset and "Train again" start from the seeded weights, and their frame draws those weights' output before
    // any step, as the page's first frame does. Every other change continues from the current weights and the
    // optimizer's current state, so the photos follow a drag instead of forming again from a pile.
    if (restarted) {
      machine.reset()
      trainedUntilTime = null
    }
    if (sketchEdited || restarted) {
      if (stepsRemaining === 0 || restarted) {
        runSteps = 0
        runMs = 0
      }
      // With no rectangle there is nothing to train, and no reason for another frame.
      stepsRemaining = activeCount > 0 ? trainingStepsAfterChange : 0
      // The weights have somewhere to go again, so the steps are full steps again (trainOrUndo).
      machine.restoreLearningRate()
    }

    // Layout and cursor.
    let hovered: number | null = null
    let cursor: LearnedGalleryFrame['cursor'] = 'default'
    if (drag !== null) {
      hovered = drag.item
      cursor = drag.mode === 'move' ? 'grabbing' : 'nwse-resize'
    } else if (hover !== null) {
      const hit = hitTest(hover.x, hover.y, mouseReachX, mouseReachY)
      if (hit !== null) {
        hovered = hit.item
        cursor = hit.resize ? 'nwse-resize' : 'grab'
      } else if (activeCount < learnedPhotoCount) {
        cursor = 'crosshair'
      }
    }

    // Training: as many steps as the time since the last frame holds, within the caps.
    let newTrainedUntilTime = trainedUntilTime ?? frameTime
    const stepsThisFrame = Math.max(0, Math.min(
      stepsRemaining,
      maximumTrainingStepsPerFrame,
      measuredMsPerStep > 0
        ? Math.max(1, Math.floor(trainingMsPerFrame / measuredMsPerStep))
        : unmeasuredTrainingStepsPerFrame,
      Math.floor((frameTime - newTrainedUntilTime) / msPerTrainingStep),
    ))
    newTrainedUntilTime += stepsThisFrame * msPerTrainingStep
    if (stepsThisFrame > 0) {
      const trainingStart = readClock()
      // Steps that raise the loss are taken back, so a photo never jumps away from where it has settled.
      result = machine.trainOrUndo(stepsThisFrame)
      const trainingMs = readClock() - trainingStart
      measuredMsPerStep = trainingMs / stepsThisFrame
      runSteps += stepsThisFrame
      runMs += trainingMs
      averageMsPerStep = runMs / runSteps
    } else if (sketchEdited || restarted) {
      result = machine.evaluate()
    }
    if (restarted) history = []
    if (stepsThisFrame > 0 || sketchEdited || restarted) {
      history.push({step: result.step, loss: result.loss})
      // One sample before the chart's first step stays, so the line starts at the chart's left edge.
      while (history.length > 2 && history[1]!.step <= result.step - chartStepCount) history.shift()
    }

    // Commit state.
    stepsRemaining -= stepsThisFrame
    const training = stepsRemaining > 0
    trainedUntilTime = training ? newTrainedUntilTime : null

    const values = result.values
    return {
      values,
      loss: result.loss,
      step: result.step,
      training,
      stepsThisFrame,
      msPerStep: averageMsPerStep,
      activeCount,
      layout,
      selected,
      selectedOutput: selected === null ? null : pairedOutput(selected),
      hovered,
      cursor,
      outputs,
      sketchStack: stackSketch(),
      outputStack: stackByArea(Array.from({length: learnedSlotCount}, (_, item) => {
        if (outputs[item] !== 1) return 0
        const start = item * learnedGeometryField.size
        return Math.max(0, values[machine.geometries[start + learnedGeometryField.width]!]!)
          * Math.max(0, values[machine.geometries[start + learnedGeometryField.height]!]!)
      })),
      history,
      pressed,
      capturedPointer: drag !== null && dragStarted ? drag.pointerId : null,
    }
  }

  return {machine, frame}
}

type LearnedGalleryEditor = ReturnType<typeof createLearnedGalleryEditor>

type LearnedGalleryDomCache = {
  sketchStage: HTMLElement // mount lifetime
  // One node per photo, since the sketch holds at most one rectangle per photo and a new rectangle takes the lowest
  // free slot.
  sketchRectangles: HTMLElement[] // mount lifetime
  outputRectangles: HTMLElement[] // mount lifetime
  emptyHint: HTMLElement // mount lifetime
  rectangleCount: HTMLElement // mount lifetime
  layoutButtons: {name: LearnedLayoutName, button: HTMLButtonElement}[] // mount lifetime
  deleteButton: HTMLButtonElement // mount lifetime
  trainButton: HTMLButtonElement // mount lifetime
  chart: SVGSVGElement // mount lifetime
  chartArea: SVGPolygonElement // mount lifetime
  chartLine: SVGPolylineElement // mount lifetime
  chartMarker: SVGCircleElement // mount lifetime
  chartHairline: SVGLineElement // mount lifetime
  trainingStep: HTMLElement // mount lifetime
  trainingLoss: HTMLElement // mount lifetime
  stepCostClause: HTMLElement // mount lifetime
  stepCost: HTMLElement // mount lifetime
}

function requireElement<Found extends Element = HTMLElement>(document: Document, selector: string, message: string) {
  const element = document.querySelector<Found>(selector)
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

function createLearnedGalleryDomCache(document: Document, editor: LearnedGalleryEditor): LearnedGalleryDomCache {
  const sketchStage = requireElement(
    document,
    '#learning-target',
    'learning target is missing',
  )
  const outputStage = requireElement(
    document,
    '#learning-result',
    'learning result is missing',
  )
  const sketchRectangles: HTMLElement[] = []
  const outputRectangles: HTMLElement[] = []

  for (let item = 0; item < learnedPhotoCount; item++) {
    const sketchRectangle = document.createElement('div')
    sketchStage.appendChild(sketchRectangle)
    sketchRectangles.push(sketchRectangle)

    const outputRectangle = document.createElement('div')
    outputRectangle.setAttribute('role', 'img')
    outputRectangle.setAttribute('aria-label', photoNames[item]!)
    outputStage.appendChild(outputRectangle)
    outputRectangles.push(outputRectangle)
  }

  const layoutButtons = [...document.querySelectorAll<HTMLButtonElement>('#learning-layouts button')].map(
    (button): LearnedGalleryDomCache['layoutButtons'][number] => {
      const name = button.dataset['layout']
      invariant(name === 'cinema' || name === 'contact' || name === 'story', 'a layout button names no layout')
      return {name, button}
    },
  )

  // The numbers of the statistics line that never change, written once.
  const machine = editor.machine
  for (const [selector, value] of [
    ['#learning-coefficients', machine.parameterCount],
    ['#learning-steps-after-change', trainingStepsAfterChange],
    ['#learning-steps-per-second', Math.round(1000 / msPerTrainingStep)],
    ['#learning-operations', machine.circuit.operations.length],
    ['#learning-layers', machine.tensorProgram.layers.length],
  ] as const) {
    requireElement(document, selector, `${selector} is missing`).textContent = value.toLocaleString('en-US')
  }

  return {
    sketchStage,
    sketchRectangles,
    outputRectangles,
    emptyHint: requireElement(document, '#learning-empty', 'empty sketch hint is missing'),
    rectangleCount: requireElement(document, '#learning-count', 'rectangle count is missing'),
    layoutButtons,
    deleteButton: requireElement<HTMLButtonElement>(document, '#learning-delete', 'delete button is missing'),
    trainButton: requireElement<HTMLButtonElement>(document, '#learning-train', 'train button is missing'),
    chart: requireElement<SVGSVGElement>(document, '#learning-chart', 'loss chart is missing'),
    chartArea: requireElement<SVGPolygonElement>(document, '#learning-chart polygon', 'loss area is missing'),
    chartLine: requireElement<SVGPolylineElement>(document, '#learning-chart polyline', 'loss line is missing'),
    chartMarker: requireElement<SVGCircleElement>(document, '#learning-chart circle', 'loss marker is missing'),
    chartHairline: requireElement<SVGLineElement>(document, '#learning-chart line', 'loss hairline is missing'),
    trainingStep: requireElement(document, '#learning-step', 'training step is missing'),
    trainingLoss: requireElement(
      document,
      '#learning-loss',
      'training loss is missing',
    ),
    stepCostClause: requireElement(document, '#learning-step-cost-clause', 'step cost clause is missing'),
    stepCost: requireElement(document, '#learning-step-cost', 'step cost is missing'),
  }
}

// The chart's vertical axis is logarithmic, from a loss of 1 at the top to 1e-8 at the bottom: the loss falls from
// about 0.2 to about 1e-7 while training, which a linear axis would show as one drop followed by a flat line.
const chartLogTop = 0
const chartLogBottom = -8
// Room around the line for its marker, a dot of 4 px radius with a 1 px ring, in CSS pixels.
const chartPadding = 5

function mountLearnedGallery(document: Document, window: Window) {
  // A press or a move as the listener records it. The frame turns its position into the stage's coordinates.
  type RawPointer = {pointerId: number, clientX: number, clientY: number, touch: boolean, button: number, buttons: number}
  type OtherInput = Exclude<LearnedGalleryInput, {kind: 'pointer down' | 'pointer move'}>
  type RawInput = ({kind: 'pointer down'} & RawPointer) | ({kind: 'pointer move'} & RawPointer) | OtherInput

  const editor = createLearnedGalleryEditor()
  const machine = editor.machine
  const domCache = createLearnedGalleryDomCache(document, editor)
  // What the text nodes and the chart hold now. A frame writes one only when it changes, since writing a text node
  // again collapses a selection inside it.
  const written = {rectangleCount: '', trainingStep: '', trainingLoss: '', stepCost: '', chartLine: ''}
  let rawInputs: RawInput[] = []
  // The mouse's clientX while it is over the chart, where the chart then reads out the nearest sample.
  let chartPointerX: number | null = null
  let scheduledRaf: number | null = null

  function scheduleRender() {
    scheduledRaf ??= window.requestAnimationFrame(renderLearnedGallery)
  }

  function renderLearnedGallery(frameTime: number) {
    scheduledRaf = null
    // DOM reads.
    const stageBounds = domCache.sketchStage.getBoundingClientRect()
    const stageLeft = stageBounds.left + domCache.sketchStage.clientLeft
    const stageTop = stageBounds.top + domCache.sketchStage.clientTop
    const stageWidth = domCache.sketchStage.clientWidth
    const stageHeight = domCache.sketchStage.clientHeight
    // The chart takes the width that its row leaves, and its coordinates are CSS pixels.
    const chartBounds = domCache.chart.getBoundingClientRect()

    // Inputs, cursor and training.
    const inputs: LearnedGalleryInput[] = []
    for (const input of rawInputs) {
      if (input.kind !== 'pointer down' && input.kind !== 'pointer move') {
        inputs.push(input)
        continue
      }
      if (stageWidth <= 0 || stageHeight <= 0) continue
      const position = {
        pointerId: input.pointerId,
        x: input.clientX - stageLeft,
        y: input.clientY - stageTop,
        touch: input.touch,
      }
      if (input.kind === 'pointer move') {
        inputs.push({kind: 'pointer move', ...position, pressed: input.buttons !== 0})
      } else if (input.button === 0) {
        // Only the main button presses, e.g. the right button opens the browser's menu.
        inputs.push({kind: 'pointer down', ...position})
      }
    }
    rawInputs = []
    const frame = editor.frame(frameTime, stageWidth, stageHeight, inputs)

    // The chart: steps from left to right, with the latest sample at the right end once 500 steps have run.
    const latestSample = frame.history.at(-1)!
    const firstChartStep = Math.max(0, latestSample.step - chartStepCount)
    const chartLeft = 1
    const chartSpan = Math.max(0, chartBounds.width - chartLeft - chartPadding)
    const chartX = (step: number) => chartLeft + Math.max(0, step - firstChartStep) / chartStepCount * chartSpan
    const chartY = (loss: number) =>
      chartPadding
      + clamp((chartLogTop - Math.log10(loss)) / (chartLogTop - chartLogBottom), 0, 1)
        * Math.max(0, chartBounds.height - chartPadding * 2)
    // Under the mouse, the chart marks the sample nearest to the mouse, and the two numbers beside it show that
    // sample instead of the latest one.
    let markedSample = latestSample
    if (chartPointerX !== null) {
      const pointerX = chartPointerX - chartBounds.left
      for (const sample of frame.history) {
        if (Math.abs(chartX(sample.step) - pointerX) < Math.abs(chartX(markedSample.step) - pointerX)) markedSample = sample
      }
    }

    // DOM writes.
    for (let item = 0; item < learnedPhotoCount; item++) {
      const start = item * learnedGeometryField.size
      const sketchRectangle = domCache.sketchRectangles[item]!
      sketchRectangle.className = `target-rectangle${frame.selected === item ? ' is-selected' : ''}${frame.hovered === item ? ' is-hovered' : ''}`
      sketchRectangle.style.display = machine.target.active[item] === 1 ? 'block' : 'none'
      sketchRectangle.style.zIndex = `${frame.sketchStack[item]!}`
      projectGeometry(
        sketchRectangle,
        machine.target.geometries[start + learnedGeometryField.left]!,
        machine.target.geometries[start + learnedGeometryField.top]!,
        machine.target.geometries[start + learnedGeometryField.width]!,
        machine.target.geometries[start + learnedGeometryField.height]!,
      )
      const outputRectangle = domCache.outputRectangles[item]!
      outputRectangle.className = `learned-rectangle image-${item}${frame.selectedOutput === item ? ' is-selected' : ''}`
      outputRectangle.style.display = frame.outputs[item] === 1 ? 'block' : 'none'
      outputRectangle.style.zIndex = `${frame.outputStack[item]!}`
      projectGeometry(
        outputRectangle,
        frame.values[machine.geometries[start + learnedGeometryField.left]!]!,
        frame.values[machine.geometries[start + learnedGeometryField.top]!]!,
        frame.values[machine.geometries[start + learnedGeometryField.width]!]!,
        frame.values[machine.geometries[start + learnedGeometryField.height]!]!,
      )
    }
    domCache.sketchStage.style.cursor = frame.cursor
    // An empty sketch says how to add a rectangle.
    domCache.emptyHint.style.display = frame.activeCount === 0 ? 'block' : 'none'
    for (const {name, button} of domCache.layoutButtons) {
      button.setAttribute('aria-pressed', frame.layout === name ? 'true' : 'false')
    }
    domCache.deleteButton.disabled = frame.selected === null

    const rectangleCount = `${frame.activeCount} of ${learnedPhotoCount} rectangles`
    if (written.rectangleCount !== rectangleCount) {
      domCache.rectangleCount.textContent = written.rectangleCount = rectangleCount
    }
    const trainingStep = markedSample.step.toLocaleString('en-US')
    if (written.trainingStep !== trainingStep) domCache.trainingStep.textContent = written.trainingStep = trainingStep
    // e.g. 3.04e-7 with a minus sign, U+2212, instead of toExponential's hyphen.
    const trainingLoss = markedSample.loss === 0 ? '0' : markedSample.loss.toExponential(2).replace('-', '\u2212')
    if (written.trainingLoss !== trainingLoss) domCache.trainingLoss.textContent = written.trainingLoss = trainingLoss
    // The statistics line says what a step costs once a step has been timed, i.e. from the page's second frame on.
    // A no-break space, U+00A0, keeps the unit on the number's line.
    const stepCost = frame.msPerStep === null ? '' : `${frame.msPerStep.toFixed(2)}\u00a0ms`
    if (written.stepCost !== stepCost) domCache.stepCost.textContent = written.stepCost = stepCost
    domCache.stepCostClause.style.display = frame.msPerStep === null ? 'none' : 'inline'

    const chartLine = frame.history.map(sample => `${chartX(sample.step).toFixed(1)},${chartY(sample.loss).toFixed(1)}`).join(' ')
    if (written.chartLine !== chartLine) {
      domCache.chartLine.setAttribute('points', written.chartLine = chartLine)
      // The wash under the line: the line's points, closed along the chart's bottom edge.
      domCache.chartArea.setAttribute(
        'points',
        `${chartLine} ${chartX(latestSample.step).toFixed(1)},${chartBounds.height} ${chartX(frame.history[0]!.step).toFixed(1)},${chartBounds.height}`,
      )
    }
    const markerX = chartX(markedSample.step).toFixed(1)
    domCache.chartMarker.setAttribute('cx', markerX)
    domCache.chartMarker.setAttribute('cy', chartY(markedSample.loss).toFixed(1))
    domCache.chartHairline.setAttribute('x1', markerX)
    domCache.chartHairline.setAttribute('x2', markerX)
    domCache.chartHairline.setAttribute('y2', `${chartBounds.height}`)
    domCache.chartHairline.style.display = chartPointerX === null ? 'none' : 'inline'

    // Side effects. The stage takes focus at a press so that the Delete key reaches it, and captures the pointer
    // of a drag so that the drag continues outside the stage.
    if (frame.pressed) domCache.sketchStage.focus({preventScroll: true})
    if (frame.capturedPointer !== null) domCache.sketchStage.setPointerCapture(frame.capturedPointer)
    if (frame.training) scheduleRender()
  }

  function recordPointer(kind: 'pointer down' | 'pointer move') {
    return (event: PointerEvent) => {
      rawInputs.push({
        kind,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        touch: event.pointerType === 'touch',
        button: event.button,
        buttons: event.buttons,
      })
      scheduleRender()
    }
  }
  function record(input: OtherInput) {
    rawInputs.push(input)
    scheduleRender()
  }
  domCache.sketchStage.addEventListener('pointerdown', recordPointer('pointer down'))
  domCache.sketchStage.addEventListener('pointermove', recordPointer('pointer move'))
  domCache.sketchStage.addEventListener('pointerup', event => record({kind: 'pointer up', pointerId: event.pointerId}))
  domCache.sketchStage.addEventListener('pointercancel', event => record({kind: 'pointer cancel', pointerId: event.pointerId}))
  domCache.sketchStage.addEventListener('pointerleave', event => record({kind: 'pointer leave', pointerId: event.pointerId}))
  domCache.sketchStage.addEventListener('keydown', event => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    event.preventDefault()
    record({kind: 'delete'})
  })
  domCache.deleteButton.addEventListener('click', () => record({kind: 'delete'}))
  domCache.trainButton.addEventListener('click', () => record({kind: 'train again'}))
  for (const {name, button} of domCache.layoutButtons) {
    button.addEventListener('click', () => record({kind: 'layout', name}))
  }
  domCache.chart.addEventListener('pointermove', event => {
    chartPointerX = event.pointerType === 'mouse' ? event.clientX : null
    scheduleRender()
  })
  domCache.chart.addEventListener('pointerleave', () => {
    chartPointerX = null
    scheduleRender()
  })
  // The chart's width follows the window's.
  window.addEventListener('resize', scheduleRender)
  // The first frame is requested before the first paint, so it draws before the page shows.
  scheduleRender()
}

if (
  typeof document !== 'undefined'
  && document.querySelector('#learning-demo') !== null
) {
  mountLearnedGallery(document, window)
}

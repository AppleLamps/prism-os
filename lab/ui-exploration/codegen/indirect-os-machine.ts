// A copy of createWindowManagerMachine (window-manager.ts) whose step can use
// either the shared executor or generated JavaScript, with the per-frame
// JavaScript validation switchable. The circuit, its output wires, and the
// initial source table come from the production module's code, through
// window-manager-copy.ts (the same code without the mount at import time), so
// both machines run the identical program.
import {
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertUnitInterval,
  invariant,
} from '../../../src/runtime/numeric-ui-core.ts'
import {
  createWindowManagerMachine,
  dockOutputField,
  dragSourceField,
  photoFocusSourceField,
  photoSourceField,
  photoThumbnailSpringSourceField,
  resizeSourceField,
  sourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from './window-manager-copy.ts'
import {itemCount as photoCount, thumbnailSpringField, validatePhotoGalleryOutput} from './photo-gallery-copy.ts'
import {compileScalarProgram, type FroundAccess} from './codegen.ts'
import {createTieredEvaluator} from './tiered.ts'

// 'tiered' starts on the executor, and machine.tiered.promote(source) switches it to
// generated JS once every live wire matches the executor.
export type Evaluator = 'executor' | 'generated' | 'tiered'

export type IndirectOSMachineOptions = {
  evaluator: Evaluator
  validate: boolean
  rowsPerFunction?: number
  froundAccess?: FroundAccess
}

type WindowManagerOutput = ReturnType<typeof createWindowManagerMachine>['output']

// window-manager.ts keeps its spring layout private; these mirror
// springStateField there (10 cells per window, scale at 4).
const springStateSize = 10
const springScaleField = 4
const springPositionFields = [0, 1, 2, 3, 4] as const
const springVelocityFields = [5, 6, 7, 8, 9] as const
const eventActiveFields = [sourceField.downActive, sourceField.moveActive, sourceField.upActive] as const
const eventCoordinateFields = [sourceField.downX, sourceField.downY, sourceField.moveX, sourceField.moveY, sourceField.upX, sourceField.upY] as const
const photoEventActiveFields = [photoSourceField.clickActive, photoSourceField.previousActive, photoSourceField.nextActive, photoSourceField.closeActive] as const
const photoEventCoordinateFields = [photoSourceField.clickX, photoSourceField.clickY] as const
const photoConstantFields = [photoSourceField.gap, photoSourceField.mainInset, photoSourceField.thumbnailHeight, photoSourceField.controlSize] as const
const constantFields = [
  sourceField.margin, sourceField.titleHeight, sourceField.minWidth, sourceField.minHeight, sourceField.resizeGrip,
  sourceField.buttonSize, sourceField.buttonGap, sourceField.dockHeight, sourceField.dockGap, sourceField.dockItemWidth,
  sourceField.systemBarHeight, sourceField.springStiffness, sourceField.springDamping, sourceField.springMaxFrameDuration,
  sourceField.springSettleDistance, sourceField.springSettleSpeed, sourceField.springSettleDistanceScale, sourceField.springSettleSpeedScale,
] as const

function springSourceField(windowIndex: number, field: number) {
  return sourceField.springStart + windowIndex * springStateSize + field
}

export function createIndirectOSMachine(options: IndirectOSMachineOptions) {
  const buildStart = performance.now()
  const production = createWindowManagerMachine()
  const buildAndCompileMilliseconds = performance.now() - buildStart
  const {circuit, output} = production
  const program = production.tensorProgram
  const roots = [...program.roots]
  const source = new Float32Array(production.source)
  const numericTolerance = 1e-5

  let values: Float32Array
  let indexOfWire: Int32Array
  let evaluate: (source: Float32Array) => void
  let generateMilliseconds = 0
  let compileMilliseconds = 0
  let sourceBytes = 0
  let functionCount = 0
  const tiered = options.evaluator === 'tiered'
    ? createTieredEvaluator(circuit, roots, options.rowsPerFunction === undefined ? {} : {rowsPerFunction: options.rowsPerFunction})
    : null
  if (options.evaluator === 'executor' || tiered !== null) {
    // Both return root values in the order of roots.
    const evaluator = tiered === null ? circuit.createTensorEvaluator(roots) : (input: Float32Array) => tiered.evaluate(input)
    indexOfWire = new Int32Array(program.width).fill(-1)
    roots.forEach((root, index) => {
      if (indexOfWire[root] === -1) indexOfWire[root] = index
    })
    values = new Float32Array(roots.length)
    evaluate = input => {
      values.set(evaluator(input))
    }
  } else {
    const generated = compileScalarProgram(program, {
      rowsPerFunction: options.rowsPerFunction ?? 128,
      ...(options.froundAccess === undefined ? {} : {froundAccess: options.froundAccess}),
    })
    generateMilliseconds = generated.generateMilliseconds
    compileMilliseconds = generated.compileMilliseconds
    sourceBytes = generated.sourceBytes
    functionCount = generated.functions.length
    indexOfWire = generated.flat.positionOfWire
    values = generated.values
    evaluate = generated.run
  }
  const nextSourceIndex = Int32Array.from(output.nextSource, wire => indexOfWire[wire]!)
  const wireValues = new Float32Array(program.width)
  const liveWires = Int32Array.from({length: program.width}, (_, wire) => wire).filter(wire => indexOfWire[wire]! >= 0)

  function receivePointer(activeField: number, xField: number, yField: number, x: number, y: number) {
    invariant(Number.isFinite(x) && Number.isFinite(y), 'pointer coordinates must be finite')
    source[activeField] = 1
    source[xField] = x
    source[yField] = y
  }

  function receivePhotoEvent(field: number, x = source[photoSourceField.clickX]!, y = source[photoSourceField.clickY]!) {
    for (const eventField of photoEventActiveFields) source[eventField] = 0
    source[field] = 1
    source[photoSourceField.clickX] = x
    source[photoSourceField.clickY] = y
  }

  return {
    circuit,
    output,
    source,
    program,
    values,
    indexOfWire,
    tiered,
    cold: {buildAndCompileMilliseconds, generateMilliseconds, compileMilliseconds, sourceBytes, functionCount},
    read(wire: Wire) {
      return values[indexOfWire[wire]!]!
    },
    step(viewportWidth: number, viewportHeight: number, frameTime: number) {
      invariant(Number.isFinite(frameTime) && frameTime >= 0, 'frame time must be nonnegative')
      source[sourceField.viewportWidth] = viewportWidth
      source[sourceField.viewportHeight] = viewportHeight
      source[sourceField.frameTime] = frameTime
      if (options.validate) validateWindowManagerSource(source, numericTolerance)
      evaluate(source)
      if (options.validate) {
        // The production validators read full wire arrays.
        for (let index = 0; index < liveWires.length; index++) {
          const wire = liveWires[index]!
          wireValues[wire] = values[indexOfWire[wire]!]!
        }
        validateWindowManagerOutput(wireValues, output, numericTolerance)
      }
      for (let field = 0; field < source.length; field++) source[field] = values[nextSourceIndex[field]!]!
      return values
    },
    pointerDown(x: number, y: number) {
      receivePointer(sourceField.downActive, sourceField.downX, sourceField.downY, x, y)
    },
    pointerMove(x: number, y: number) {
      receivePointer(sourceField.moveActive, sourceField.moveX, sourceField.moveY, x, y)
    },
    pointerUp(x: number, y: number) {
      receivePointer(sourceField.upActive, sourceField.upX, sourceField.upY, x, y)
    },
    photoClick(x: number, y: number) {
      receivePhotoEvent(photoSourceField.clickActive, x, y)
    },
    photoNext() {
      receivePhotoEvent(photoSourceField.nextActive)
    },
    photoPrevious() {
      receivePhotoEvent(photoSourceField.previousActive)
    },
    photoClose() {
      receivePhotoEvent(photoSourceField.closeActive)
    },
  }
}

export type IndirectOSMachine = ReturnType<typeof createIndirectOSMachine>
type EventTarget = Pick<IndirectOSMachine, 'pointerDown' | 'pointerMove' | 'pointerUp' | 'photoClick' | 'photoNext' | 'photoPrevious' | 'photoClose'>

// A deterministic 240-frame session over IndirectOS's initial layout at
// 1280×800, with one 90 ms stall at frame 90. Windows are numbered by
// windowIndex; Photos is window 3. Each press lands on the part named in the
// comments, and indirect-os-machine.test.ts checks both the part under each
// press (with referenceOwnership) and the state change the press causes.
export function interactionFrameTime(frame: number) {
  return 1000 + frame * 16.667 + (frame >= 90 ? 90 : 0)
}

export function applyInteraction(machine: EventTarget, frame: number) {
  // Drag window 0 by its title bar, by (200, 100).
  if (frame === 5) machine.pointerDown(150, 70)
  if (frame > 5 && frame <= 30) machine.pointerMove(150 + (frame - 5) * 8, 70 + (frame - 5) * 4)
  if (frame === 31) machine.pointerUp(350, 170)
  // Resize window 0 by its resize grip, now at 750..774 × 470..494, from 520×340 to 620×400.
  if (frame === 60) machine.pointerDown(762, 482)
  if (frame > 60 && frame <= 80) machine.pointerMove(762 + (frame - 60) * 5, 482 + (frame - 60) * 3)
  if (frame === 81) machine.pointerUp(862, 542)
  // Close window 1 with its close button, then reopen it from its dock item.
  if (frame === 100) machine.pointerDown(891, 126)
  if (frame === 101) machine.pointerUp(891, 126)
  if (frame === 115) machine.pointerDown(609, 762)
  if (frame === 116) machine.pointerUp(609, 762)
  // Maximize Photos with its maximize button.
  if (frame === 130) machine.pointerDown(1163, 212)
  if (frame === 131) machine.pointerUp(1163, 212)
  // Inside the maximized Photos window, whose click coordinates are relative
  // to its content area: click photo 5 in the grid, go to the next photo and
  // back, then close the focused photo.
  if (frame === 160) machine.photoClick(472, 309)
  if (frame === 175) machine.photoNext()
  if (frame === 190) machine.photoPrevious()
  if (frame === 200) machine.photoClose()
  // Restore Photos with the same button, now at the maximized window's corner.
  if (frame === 210) machine.pointerDown(1221, 70)
  if (frame === 211) machine.pointerUp(1221, 70)
  // Minimize window 1 with its minimize button.
  if (frame === 225) machine.pointerDown(835, 126)
  if (frame === 226) machine.pointerUp(835, 126)
}

function validateWindowManagerSource(values: Float32Array, tolerance: number) {
  invariant(values.length === sourceField.size, 'source table has the wrong length')
  assertFiniteValues(values, 'source table')
  assertNonNegativeFinite(values[sourceField.viewportWidth], 'viewport width')
  assertNonNegativeFinite(values[sourceField.viewportHeight], 'viewport height')
  assertNonNegativeFinite(values[sourceField.frameTime], 'frame time')
  assertNonNegativeFinite(values[sourceField.previousFrameTime], 'previous frame time')
  assertUnitInterval(values[sourceField.timeInitialized], 'time initialized', tolerance)
  invariant(values[sourceField.unit] === 1, 'unit cell must equal one')
  for (const field of constantFields) assertNonNegativeFinite(values[field], 'window manager constant')
  for (const field of eventActiveFields) assertUnitInterval(values[field], 'event latch', tolerance)
  for (const field of eventCoordinateFields) invariant(Number.isFinite(values[field]), 'event coordinate must be finite')
  for (const field of photoConstantFields) assertNonNegativeFinite(values[field], 'Photos constant')
  let photoEventMass = 0
  for (const field of photoEventActiveFields) {
    assertUnitInterval(values[field], 'Photos event latch', tolerance)
    photoEventMass += values[field]
  }
  invariant(photoEventMass <= 1 + tolerance, 'Photos event mass must not exceed one')
  for (const field of photoEventCoordinateFields) invariant(Number.isFinite(values[field]), 'Photos event coordinate must be finite')
  let photoFocusMass = 0
  for (let item = 0; item < photoCount; item++) {
    const focus = values[photoFocusSourceField(item)]
    assertUnitInterval(focus, `photo focus ${item}`, tolerance)
    photoFocusMass += focus
    assertNonNegativeFinite(values[photoThumbnailSpringSourceField(item, thumbnailSpringField.centerX)], `photo thumbnail ${item} center`, tolerance)
    invariant(Number.isFinite(values[photoThumbnailSpringSourceField(item, thumbnailSpringField.centerXVelocity)]), `photo thumbnail ${item} center velocity must be finite`)
    assertUnitInterval(values[photoThumbnailSpringSourceField(item, thumbnailSpringField.scale)], `photo thumbnail ${item} scale`, tolerance)
    invariant(Number.isFinite(values[photoThumbnailSpringSourceField(item, thumbnailSpringField.scaleVelocity)]), `photo thumbnail ${item} scale velocity must be finite`)
  }
  invariant(photoFocusMass <= 1 + tolerance, 'photo focus mass must not exceed one')
  invariant(Number.isFinite(values[sourceField.pointerX]), 'pointer x must be finite')
  invariant(Number.isFinite(values[sourceField.pointerY]), 'pointer y must be finite')
  let dragMass = 0
  let resizeMass = 0
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    for (const field of [windowStateField.left, windowStateField.top, windowStateField.width, windowStateField.height]) {
      assertNonNegativeFinite(values[windowSourceField(windowIndex, field)], 'window geometry')
    }
    for (const field of [windowStateField.open, windowStateField.minimized, windowStateField.maximized, windowStateField.present]) {
      assertUnitInterval(values[windowSourceField(windowIndex, field)], 'window flag', tolerance)
    }
    const drag = values[dragSourceField(windowIndex)]
    const resize = values[resizeSourceField(windowIndex)]
    assertUnitInterval(drag, 'drag target', tolerance)
    assertUnitInterval(resize, 'resize target', tolerance)
    dragMass += drag
    resizeMass += resize
    for (let lane = 0; lane < springPositionFields.length; lane++) {
      invariant(Number.isFinite(values[springSourceField(windowIndex, springPositionFields[lane]!)]), 'spring position must be finite')
      invariant(Number.isFinite(values[springSourceField(windowIndex, springVelocityFields[lane]!)]), 'spring velocity must be finite')
    }
    assertUnitInterval(values[springSourceField(windowIndex, springScaleField)], 'spring scale', tolerance)
  }
  invariant(dragMass <= 1 + tolerance, 'drag target mass must not exceed one')
  invariant(resizeMass <= 1 + tolerance, 'resize target mass must not exceed one')
  for (let rank = 0; rank < windowCount; rank++) {
    let rankMass = 0
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
      const stack = values[stackSourceField(rank, windowIndex)]
      assertUnitInterval(stack, 'stack cell', tolerance)
      rankMass += stack
    }
    invariant(Math.abs(rankMass - 1) <= tolerance, 'stack rank mass must equal one')
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    let windowMass = 0
    for (let rank = 0; rank < windowCount; rank++) windowMass += values[stackSourceField(rank, windowIndex)]!
    invariant(Math.abs(windowMass - 1) <= tolerance, 'stack window mass must equal one')
  }
}

function validateWindowManagerOutput(values: Float32Array, output: WindowManagerOutput, tolerance: number) {
  const nextSource = Float32Array.from(output.nextSource, wire => values[wire]!)
  validateWindowManagerSource(nextSource, tolerance)
  for (const field of eventActiveFields) invariant(nextSource[field] === 0, 'event latch must reset after refresh')
  for (const field of photoEventActiveFields) invariant(nextSource[field] === 0, 'Photos event latch must reset after refresh')
  validatePhotoGalleryOutput(values, output.photos, tolerance)
  assertUnitInterval(values[output.animationActive], 'animation active', tolerance)
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const outputStart = windowIndex * windowOutputField.size
    for (const field of [windowOutputField.width, windowOutputField.height, windowOutputField.contentWidth, windowOutputField.contentHeight]) {
      assertNonNegativeFinite(values[output.windows[outputStart + field]!], 'projected window geometry', tolerance)
    }
    for (const field of [windowOutputField.scale, windowOutputField.opacity, windowOutputField.focused, windowOutputField.maximized]) {
      assertUnitInterval(values[output.windows[outputStart + field]!], 'projected window flag', tolerance)
    }
    for (const field of [windowOutputField.translateX, windowOutputField.translateY]) {
      invariant(Number.isFinite(values[output.windows[outputStart + field]!]), 'projected window translation must be finite')
    }
    assertNonNegativeFinite(values[output.windows[outputStart + windowOutputField.stack]!], 'projected stack', tolerance)
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    const outputStart = windowIndex * dockOutputField.size
    for (const field of [dockOutputField.left, dockOutputField.top, dockOutputField.width, dockOutputField.height]) {
      assertNonNegativeFinite(values[output.dockItems[outputStart + field]!], 'projected dock geometry', tolerance)
    }
    for (const field of [dockOutputField.inactive, dockOutputField.focused, dockOutputField.open]) {
      assertUnitInterval(values[output.dockItems[outputStart + field]!], 'projected dock flag', tolerance)
    }
  }
}

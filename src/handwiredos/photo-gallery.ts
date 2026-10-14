import {
  type Circuit,
  type SpringMatrixWires,
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertUnitInterval,
  assertWire,
  emitAnimatedObject,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from '../runtime/numeric-ui-core.ts'
import {
  type EvaluationKind,
  type PlannedEvaluation,
  type SpringClock,
  type SpringConstants,
  type WriteBack,
  advanceFrame,
  defaultSpringClockConfig,
  springMatrixBound,
  springMatrixPower,
  springStepMatrix,
  stoppedSpringClock,
} from '../runtime/host-timing.ts'
import {
  type CellWires,
  type SourceTable,
  anyNumber,
  constant,
  createSourceTable,
  event,
  fieldIndices,
  input,
  inputBit,
  list,
  oneHot,
  state,
  stateBit,
  unitInterval,
} from '../runtime/cells.ts'

export const itemCount = 12
export const columnCount = 4
export const rowCount = 3
// The limits on a photo's proportions in the grid, see buildPhotos. The pictures are
// square, and a photo shows the middle of its picture: at 1.25 times as tall as
// wide, 80% of the picture's width, and at twice as wide as tall, half of its
// height. Where HandwiredOS's starting arrangement chooses Photos' height for its
// photos, it follows the first limit, see photosTallestFor in arrangement.ts. The
// second limit is the proportion that the photos have in the smallest Photos
// window, 47 × 24 px.
export const maximumPhotoTallness = 1.25
export const maximumPhotoWideness = 2
// The limits on the open photo's proportions. They allow more than the grid's, so
// that the open photo stays as it was in the windows that people see most: its box
// is 1.9 times as wide as tall in HandwiredOS's Photos at its default size, up to
// 2.4 times in a maximized Photos on a desk, e.g. at 1512 × 860 px, and 1.8 times
// as tall as wide in a maximized Photos on a phone 390 × 844 px.
export const maximumOpenPhotoTallness = 2
export const maximumOpenPhotoWideness = 2.5

// The thumbnails, the zoom and HandwiredOS's windows share these constants, so one
// spring matrix serves all of them.
export const springConstants: SpringConstants = {stiffness: 650, damping: 45}
// Every FP32 matrix entry the host writes for up to 300 steps stays within this
// bound.
const matrixBound = springMatrixBound(springConstants)

// Per thumbnail: each spring's displacement from the destination in effect, its
// velocity, and that destination. The drawn value is destination + displacement,
// which the program computes and doesn't store. Displacements and velocities need
// no declared range. The destinations written back are this evaluation's thumbnail
// targets. A target center is the viewport's middle plus at most about 232 px
// either way, so -16,384..32,768 holds it for any viewport within 0..16,384.
const thumbnailSpringCells = {
  centerXDisplacement: state(anyNumber),
  centerXVelocity: state(anyNumber),
  centerXDestination: state([-16_384, 32_768]),
  scaleDisplacement: state(anyNumber),
  scaleVelocity: state(anyNumber),
  scaleDestination: state(unitInterval),
}

// A zoom spring: its displacement from its destination, which is 0 or 1, and its
// velocity, see "The zoom" in buildPhotos. Like a thumbnail's, they need no declared
// range. The destination isn't stored: it follows from openSpring and the focus cells.
const zoomSpringCells = {
  displacement: state(anyNumber),
  velocity: state(anyNumber),
}
// A zoom is settled within 1/65,536 of its end, and under 1/65,536 per second. The
// default thresholds, 0.01 px and 0.01 px/s, are for springs in pixels: this spring
// goes from 0 to 1, and 0.01 of a photo's way is 10 px for a photo that grows by
// 1,000 px in a maximized Photos, which would show as a jump at the end. At 1/65,536
// the same photo is within 0.02 px.
/** @public */
export const zoomSettleThreshold = 2 ** -16
// How fast the photos in their cells fade while another photo opens: their opacity is
// 1 - gridFadeRate × the other photo's zoom, so it is 0 from 1/1,025 before the zoom's
// end, which is under 1 px for a photo that grows by 1,000 px. With a rate of 1, the
// opacity would be 0 when the zoom first reaches 1, about a millionth again for a few
// frames when the spring swings back, and 0 when it settles, and the page would take
// the 11 other photos' nodes out of the DOM, put them back and take them out again.
/** @public */
export const gridFadeRate = 1 + 2 ** -10

// Photos' own cells. A host declares them once, e.g. nested as {photos: photoCells}
// in HandwiredOS, adds the rule for photoEvents, and passes the cells' wires to
// buildPhotos.
export const photoCells = {
  // Spacing and control-size constants live in the tens of pixels; 1024 is
  // generous.
  gap: constant(18, [0, 1024]),
  mainInset: constant(92, [0, 1024]),
  thumbnailHeight: constant(82, [0, 1024]),
  controlSize: constant(52, [0, 1024]),
  // x and y are in the host's coordinates, e.g. HandwiredOS's viewport coordinates.
  // The host passes buildPhotos the click position relative to Photos' content box.
  click: {active: event(), x: input(anyNumber), y: input(anyNumber)},
  previous: event(),
  next: event(),
  close: event(),
  // The open photo, or none while the grid shows.
  focus: oneHot(list(itemCount, () => stateBit()), {allowAllZero: true, declareToCircuit: false}),
  thumbnails: list(itemCount, () => thumbnailSpringCells),
  // The zoom between a photo's cell and the open photo's rectangle, see "The zoom"
  // in buildPhotos.
  zoom: {
    springs: list(2, () => zoomSpringCells),
    // Which of the two springs is the open photo's: 0 or 1. The other one takes the
    // photo that was closed last back to its cell.
    openSpring: stateBit(),
    // The photo that was closed last, or none before the first close.
    closedLast: oneHot(list(itemCount, () => stateBit()), {allowAllZero: true, declareToCircuit: false}),
    // 1 while one of the two springs moves, as of the last evaluation that wrote
    // state back. The thumbnails read it, see buildPhotos.
    underWay: stateBit(),
  },
}
type PhotoCells = CellWires<typeof photoCells>

// Photos' event cells. A later event within one evaluation replaces an earlier one,
// so at most one of them is 1, e.g. table.atMostOne('photos events',
// photoEvents(cells.photos)).
export function photoEvents(cells: PhotoCells) {
  return [cells.click.active, cells.previous, cells.next, cells.close]
}

const {thumbnails: thumbnailCells, zoom: zoomCells, ...photoCellsBeforeThumbnails} = photoCells
// Photos on its own, with the cells that a host otherwise provides: the viewport,
// how visible Photos is, whether Photos takes events, the unit, and what advanceFrame
// plans. The table keeps the layout it had before Photos became a component, with
// these cells between the focus cells and the thumbnails, and the zoom's cells last.
const photoGalleryCells = {
  viewportWidth: input([0, 16_384]),
  viewportHeight: input([0, 16_384]),
  ...photoCellsBeforeThumbnails,
  present: input(unitInterval, {initial: 1}),
  interactive: inputBit(1),
  unit: constant(1, [1, 1]),
  // The spring matrix, settle check bit and snap bit that the host writes before
  // each evaluation, see advanceFrame in host-timing.ts.
  springMatrix: [
    state([-matrixBound, matrixBound], {initial: 1}),
    state([-matrixBound, matrixBound]),
    state([-matrixBound, matrixBound]),
    state([-matrixBound, matrixBound], {initial: 1}),
  ] as const,
  settleCheck: stateBit(),
  snap: stateBit(),
  thumbnails: thumbnailCells,
  zoom: zoomCells,
}

// The standalone table's cell positions under their earlier names, e.g.
// sourceField.clickX is the position of click.x, and
// thumbnailSpringField.centerXDestination is the index of centerXDestination within
// one thumbnail's spring cells.
const layout = createSourceTable()
const positions = layout.declare(photoGalleryCells)

/** @public */
export const thumbnailSpringField = fieldIndices(thumbnailSpringCells)

/** @public */
export const sourceField = {
  viewportWidth: positions.viewportWidth,
  viewportHeight: positions.viewportHeight,
  gap: positions.gap,
  mainInset: positions.mainInset,
  thumbnailHeight: positions.thumbnailHeight,
  controlSize: positions.controlSize,
  clickActive: positions.click.active,
  clickX: positions.click.x,
  clickY: positions.click.y,
  previousActive: positions.previous,
  nextActive: positions.next,
  closeActive: positions.close,
  focusStart: positions.focus[0]!,
  present: positions.present,
  interactive: positions.interactive,
  unit: positions.unit,
  springMatrixStart: positions.springMatrix[0],
  settleCheck: positions.settleCheck,
  snap: positions.snap,
  thumbnailSpringStart: positions.thumbnails[0]!.centerXDisplacement,
  size: layout.size,
}

/** @public */
export function focusField(item: number) {
  invariant(Number.isInteger(item) && item >= 0 && item < itemCount, 'photo index is invalid')
  return positions.focus[item]!
}

// A photo's outputs. zoom is how far the photo is open, from 0 in its cell to 1 in
// the open photo's rectangle, and stack is the photo's z-index, see "The zoom" in
// buildPhotos.
export const photoField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  opacity: 4,
  zoom: 5,
  stack: 6,
  size: 7,
}

// A thumbnail's outputs. focused is 1 for the open photo's thumbnail.
export const thumbnailField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  opacity: 4,
  focused: 5,
  size: 6,
}

export const controlField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  opacity: 4,
  size: 5,
}

const geometryFields = ['left', 'top', 'width', 'height'] as const

type Geometry = Record<(typeof geometryFields)[number], Wire>

type PhotoProjection = Geometry & {
  opacity: Wire
  zoom: Wire
  stack: Wire
}

type ThumbnailProjection = Geometry & {
  opacity: Wire
  focused: Wire
}

type ThumbnailTarget = {
  centerX: Wire
  scale: Wire
  focused: Wire
}

// What buildPhotos returns, e.g. HandwiredOS's output.photos.
export type PhotoOutputs = {
  backdropOpacity: Wire
  animationActive: Wire
  photos: Wire[]
  thumbnails: Wire[]
  previousControl: Wire[]
  nextControl: Wire[]
}

// The standalone gallery's outputs, with the wire that holds each cell's next value.
export type PhotoGalleryOutput = PhotoOutputs & {nextSource: Wire[]}

// The host's wires that Photos reads: the content box's size, the click position
// relative to the content box, how visible Photos is, whether Photos takes events,
// the unit, and what advanceFrame plans.
type PhotoHost = {
  viewportWidth: Wire
  viewportHeight: Wire
  click: {x: Wire, y: Wire}
  present: Wire
  interactive: Wire
  unit: Wire
  springMatrix: SpringMatrixWires
  settleCheck: Wire
  snap: Wire
}

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

// Builds Photos into the host's circuit, pairs Photos' state cells with their next
// values, and returns Photos' outputs.
export function buildPhotos(circuit: Circuit, table: SourceTable, cells: PhotoCells, host: PhotoHost): PhotoOutputs {
  // The ranges that Photos assumes of the host's wires. Pixel-space sizes carry an
  // honest finite ceiling: 16384 covers the largest real displays (8K is 7680 wide)
  // with headroom while staying far inside FP32's exact-integer band
  // (execution-model.md's macro contracts keep min, max and clamp operands under
  // 2^23). Finite bounds also make the geometry eligible for gather lowering. In
  // HandwiredOS, the bounds are contracts on the window's content size, which is
  // clamped to the viewport and so honors them.
  circuit.assumeRange(host.viewportWidth, 0, 16_384)
  circuit.assumeRange(host.viewportHeight, 0, 16_384)
  circuit.assumeRange(host.present, 0, 1)
  circuit.assumeRange(host.interactive, 0, 1)
  circuit.assumeRange(host.unit, 1, 1)
  for (const entry of host.springMatrix) circuit.assumeRange(entry, -matrixBound, matrixBound)
  circuit.assumeRange(host.settleCheck, 0, 1)
  circuit.assumeRange(host.snap, 0, 1)
  const {viewportWidth, viewportHeight, click, present, interactive, unit} = host
  const events = photoEvents(cells)
  const zero = circuit.constant(0)
  // The grid: 4 columns and 3 rows of photos, with the gap around and between them.
  // A slot is what the content box leaves for one photo, e.g. 117 × 104 px in
  // HandwiredOS's Photos at its default size.
  const slotWidth = emitRelu(
    circuit,
    circuit.affine([
      [viewportWidth, 1 / columnCount],
      [cells.gap, -(columnCount + 1) / columnCount],
    ]),
  )
  const slotHeight = emitRelu(
    circuit,
    circuit.affine([
      [viewportHeight, 1 / rowCount],
      [cells.gap, -(rowCount + 1) / rowCount],
    ]),
  )
  // A photo fills its slot up to a limit on its proportions: it is at most
  // maximumPhotoTallness times as tall as wide, and at most maximumPhotoWideness
  // times as wide as tall. Past a limit the photos stop growing in that direction,
  // the gaps stay, and the grid is centered in the content box. E.g. in a content box
  // of 364 × 662 px, a maximized Photos on a phone 390 × 844 px, a slot is
  // 68.5 × 196.7 px and a photo 68.5 × 85.6 px, with 166.6 px free above and below
  // the grid. Without the limit the photos were strips, each showing a third of its
  // picture's width. A click in the free part hits no photo.
  const slotExcess = emitProportionExcess(circuit, slotWidth, slotHeight, maximumPhotoWideness, maximumPhotoTallness)
  const gridWidth = emitWithoutExcess(circuit, slotWidth, slotExcess.width)
  const gridHeight = emitWithoutExcess(circuit, slotHeight, slotExcess.height)
  // What a limit takes from every photo, added up over a row or a column and halved.
  const gridOriginX = circuit.affine([[slotExcess.width, columnCount / 2]])
  const gridOriginY = circuit.affine([[slotExcess.height, rowCount / 2]])

  const gridLeft = Array.from({length: columnCount}, (_, column) =>
    circuit.affine([[gridOriginX, 1], [cells.gap, 1 + column], [gridWidth, column]]))
  const gridTop = Array.from({length: rowCount}, (_, row) =>
    circuit.affine([[gridOriginY, 1], [cells.gap, 1 + row], [gridHeight, row]]))
  const gridColumnHit = gridLeft.map(left =>
    emitIntervalHit(circuit, click.x, left, gridWidth))
  const gridRowHit = gridTop.map(top =>
    emitIntervalHit(circuit, click.y, top, gridHeight))
  const gridHit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    gridHit.push(emitMinimum(circuit, gridColumnHit[column]!, gridRowHit[row]!))
  }

  const thumbnailBaseSize = emitMinimum(
    circuit,
    cells.thumbnailHeight,
    emitMinimum(
      circuit,
      circuit.affine([[viewportWidth, 1 / 6]]),
      circuit.affine([[viewportHeight, 0.24]]),
    ),
  )
  const mainInset = emitMinimum(
    circuit,
    cells.mainInset,
    circuit.affine([[viewportWidth, 0.08]]),
  )
  // The open photo's box: the content box without the insets at its sides, the gap
  // above it, and the thumbnails with the gap above and below them. The open photo
  // fills the box up to its own two limits, maximumOpenPhotoWideness and
  // maximumOpenPhotoTallness, and past a limit it is centered in the box. E.g. in a
  // maximized Photos on a phone held sideways, 844 × 390 px, the box is 687 × 104 px
  // and the open photo 260 × 104 px, where it was a band of 687 × 104 px that showed
  // 15% of its picture's height. A click in the free part of the box is a click
  // beside the photo, which closes it.
  const mainBoxWidth = emitRelu(circuit, circuit.affine([
    [viewportWidth, 1],
    [mainInset, -2],
  ]))
  const mainBoxHeight = emitRelu(circuit, circuit.affine([
    [viewportHeight, 1],
    [thumbnailBaseSize, -1],
    [cells.gap, -3],
  ]))
  const mainExcess = emitProportionExcess(circuit, mainBoxWidth, mainBoxHeight, maximumOpenPhotoWideness, maximumOpenPhotoTallness)
  const main: Geometry = {
    left: circuit.affine([[mainInset, 1], [mainExcess.width, 0.5]]),
    top: circuit.affine([[cells.gap, 1], [mainExcess.height, 0.5]]),
    width: emitWithoutExcess(circuit, mainBoxWidth, mainExcess.width),
    height: emitWithoutExcess(circuit, mainBoxHeight, mainExcess.height),
  }
  const mainHit = emitRectangleHit(circuit, click, main)

  const previousFocusMass = circuit.affine(cells.focus.map(wire => [wire, 1]))
  circuit.assumeRange(previousFocusMass, 0, 1)
  const previousGridMass = circuit.affine([[previousFocusMass, -1]], 1)

  const thumbnailOuterInset = emitMinimum(
    circuit,
    cells.gap,
    circuit.affine([[viewportWidth, 0.5]]),
  )
  const thumbnailImageSpan = circuit.affine([
    [thumbnailBaseSize, thumbnailFalloffMass()],
  ])
  const thumbnailGap = emitMinimum(
    circuit,
    circuit.constant(12),
    emitRelu(circuit, circuit.affine([
      [viewportWidth, 1 / 8],
      [thumbnailOuterInset, -2 / 8],
      [thumbnailImageSpan, -1 / 8],
    ])),
  )
  const thumbnailCenterY = circuit.affine([
    [viewportHeight, 1],
    [cells.gap, -1],
    [thumbnailBaseSize, -0.5],
  ])
  function projectThumbnailTargets(focus: readonly Wire[], focusMass: Wire) {
    const result: ThumbnailTarget[] = []
    for (let item = 0; item < itemCount; item++) {
      const offsetTerms: [Wire, number][] = []
      const distanceTerms: [Wire, number][] = []
      const spreadTerms: [Wire, number][] = []
      for (let focusedItem = 0; focusedItem < itemCount; focusedItem++) {
        let offset = item - focusedItem
        if (offset > itemCount / 2) offset -= itemCount
        if (offset < -itemCount / 2) offset += itemCount
        const visibleOffset = Math.abs(offset) < 5 ? offset : 0
        offsetTerms.push([
          focus[focusedItem]!,
          visibleOffset,
        ])
        distanceTerms.push([focus[focusedItem]!, Math.abs(offset)])
        spreadTerms.push([
          focus[focusedItem]!,
          Math.sign(visibleOffset) * thumbnailSpread(Math.abs(visibleOffset)),
        ])
      }
      const offset = circuit.affine(offsetTerms)
      const distance = circuit.affine(distanceTerms)
      const spread = circuit.affine(spreadTerms)
      const falloff = emitRelu(circuit, circuit.affine([
        [focusMass, 1],
        [distance, -0.22],
      ]))
      const centerX = circuit.affine([
        [viewportWidth, 0.5],
        [emitMultiply(circuit, thumbnailBaseSize, spread), 1],
        [emitMultiply(circuit, thumbnailGap, offset), 1],
      ])
      result.push({
        centerX,
        scale: falloff,
        focused: focus[item]!,
      })
    }
    return result
  }

  function projectThumbnail(target: ThumbnailTarget): ThumbnailProjection {
    const visibleScale = emitMultiply(circuit, present, target.scale)
    const size = emitMultiply(circuit, thumbnailBaseSize, visibleScale)
    return {
      left: circuit.affine([[target.centerX, 1], [size, -0.5]]),
      top: emitRelu(circuit, circuit.affine([[thumbnailCenterY, 1], [size, -0.5]])),
      width: size,
      height: size,
      opacity: visibleScale,
      focused: target.focused,
    }
  }

  const currentThumbnailTargets = projectThumbnailTargets(cells.focus, previousFocusMass)
  const thumbnailHit: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    thumbnailHit.push(emitRectangleHit(circuit, click, projectThumbnail(currentThumbnailTargets[item]!)))
  }

  // The controls stand at the middle of the open photo's box, which is the middle
  // of the open photo too.
  const controlTop = emitRelu(circuit, circuit.affine([
    [cells.gap, 1],
    [mainBoxHeight, 0.5],
    [cells.controlSize, -0.5],
  ]))
  const controlInset = circuit.affine([[cells.gap, 0.5]])
  const previousControl: Geometry = {
    left: controlInset,
    top: controlTop,
    width: cells.controlSize,
    height: cells.controlSize,
  }
  const nextControl: Geometry = {
    left: emitRelu(circuit, circuit.affine([
      [viewportWidth, 1],
      [controlInset, -1],
      [cells.controlSize, -1],
    ])),
    top: controlTop,
    width: cells.controlSize,
    height: cells.controlSize,
  }
  const controlVerticalHit = emitIntervalHit(
    circuit,
    click.y,
    controlTop,
    cells.controlSize,
  )
  const previousControlHit = emitMinimum(
    circuit,
    emitIntervalHit(
      circuit,
      click.x,
      previousControl.left,
      previousControl.width,
    ),
    controlVerticalHit,
  )
  const nextControlHit = emitMinimum(
    circuit,
    emitIntervalHit(
      circuit,
      click.x,
      nextControl.left,
      nextControl.width,
    ),
    controlVerticalHit,
  )

  const effectiveEvents = events.map(wire =>
    emitMultiply(circuit, interactive, wire))
  const eventMass = circuit.affine(effectiveEvents.map(wire => [wire, 1]))
  circuit.assumeRange(eventMass, 0, 1)
  const eventInactive = circuit.affine([[eventMass, -1]], 1)
  const clickActive = effectiveEvents[0]!
  const clickGridGate = emitMultiply(circuit, clickActive, previousGridMass)
  const focusedClick = emitMultiply(circuit, clickActive, previousFocusMass)
  circuit.assumeRange(focusedClick, 0, 1)
  const [
    previousControlClick,
    nextControlClick,
    ...focusedSurfaceClicks
  ] = emitFirstActive(
    circuit,
    focusedClick,
    [previousControlHit, nextControlHit, ...thumbnailHit, mainHit],
  )
  const thumbnailClicks = focusedSurfaceClicks.slice(0, itemCount)
  const clickMainGate = focusedSurfaceClicks[itemCount]!
  const currentFocusGate = circuit.affine([[eventInactive, 1], [clickMainGate, 1]])
  const previousFocusGate = circuit.affine([
    [effectiveEvents[1]!, 1],
    [previousControlClick!, 1],
  ])
  const nextFocusGate = circuit.affine([
    [effectiveEvents[2]!, 1],
    [nextControlClick!, 1],
  ])
  const nextFocus: Wire[] = []
  for (let item = 0; item < itemCount; item++) {
    const previousShift = cells.focus[(item + 1) % itemCount]!
    const nextShift = cells.focus[(item + itemCount - 1) % itemCount]!
    nextFocus.push(circuit.affine([
      [emitMultiply(circuit, currentFocusGate, cells.focus[item]!), 1],
      [emitMultiply(circuit, clickGridGate, gridHit[item]!), 1],
      [thumbnailClicks[item]!, 1],
      [emitMultiply(circuit, previousFocusGate, previousShift), 1],
      [emitMultiply(circuit, nextFocusGate, nextShift), 1],
    ]))
  }

  const nextFocusMass = circuit.affine(nextFocus.map(wire => [wire, 1]))
  circuit.assumeRange(nextFocusMass, 0, 1)

  // The zoom. A click on a photo in the grid opens it: the photo moves and grows from
  // its cell to the open photo's rectangle, and a close takes it back to its cell.
  // A spring animates one number, the zoom: how far the photo is open, from 0 in its
  // cell to 1 in the open photo's rectangle. Each of the photo's left, top, width and
  // height is that far between the cell's and the open rectangle's, e.g.
  //   left = (1 - zoom) × cellLeft + zoom × openLeft
  // so at zoom 0 and at zoom 1 the photo has the exact FP32 values of its cell and of
  // the open rectangle, which a click is tested against. The spring has the windows'
  // and the thumbnails' constants, so the host's one matrix steps it. A spring for
  // each of left, top, width and height would draw the same rectangles while the box
  // keeps its size, since all four would have covered the same share of their way at
  // every time. They differ when the box changes its size, e.g. while the window is
  // resized: the cell and the open rectangle are this evaluation's, so the photo
  // follows the new layout at once, and a zoom that is under way continues from the
  // share that it had reached.
  //
  // In plain JavaScript every photo would have its own spring:
  //   photo.zoom.destination = photo === openPhoto ? 1 : 0
  // A spring costs its operations in every evaluation, whether it moves or not, and at
  // most one photo is open, so the program has two springs for the 12 photos, which
  // takes about 300 operations less than 12 springs:
  // - The open photo's spring. Its destination is 1 while a photo is open.
  // - The other spring, which takes the photo that was closed last back to its cell.
  //   Its destination is 0.
  // openSpring says which of the two is the open photo's, and four rules cover every
  // event:
  // - A close swaps the two. The spring that opened the photo takes it back from
  //   where it is, with its velocity, e.g. a close during the opening turns the photo
  //   around. The other spring becomes the open photo's and is put at rest at 0. If
  //   it was still taking an earlier photo back, that photo is in its cell from this
  //   evaluation on. This is the only case where a photo jumps to its cell, and it
  //   takes a close, an open of another photo and a second close within the half
  //   second that a zoom lasts.
  // - An open of the photo that was closed last swaps the two back, so the spring
  //   that holds that photo opens it again from where it is.
  // - An open of another photo starts the open photo's spring from 0, while the other
  //   spring goes on taking the closed photo back.
  // - A step to the previous or next photo, or a click on a thumbnail, changes which
  //   photo the open photo's spring draws, and no spring: the new photo is in the
  //   open rectangle at once, as before the zoom existed, or as far open as the old
  //   one was if the step comes during the opening. A step onto the photo that is on
  //   its way back ends that return.
  //
  // What the page draws from the outputs:
  // - A photo's opacity is 1 minus the zoom of the other photos, so the grid fades
  //   while a photo opens, e.g. to 0.3 when the photo is 0.7 open, and comes back
  //   while it closes. The content box behind the photos has one color, so this
  //   looks like a sheet that fades in over the grid. With the open photo at its
  //   end, the others are at opacity 0 and their nodes leave the DOM, as before, see
  //   gridFadeRate. The photo on its way back fades only with a photo that opens
  //   meanwhile.
  // - stack is the z-index: 3 for the open photo, and 1 for the photo that was closed
  //   last, so that it passes above the photos in their cells, which have 0. The
  //   stylesheet puts the thumbnails at 2, between the two, and the controls above
  //   all. The photo that was closed last keeps 1 in its cell, where it overlaps no
  //   other photo.
  // - The picture's crop: a photo is one node in its cell and in the open rectangle,
  //   and the stylesheet's background-size: cover fits the picture to the node in
  //   every frame, so the crop changes with the rectangle's proportions and never
  //   jumps.
  // - The backdrop, the previous and next controls, and the open photo's shadow and
  //   name fade with the zoom. The thumbnails have their own springs, see below.
  //
  // A press acts on destinations, as in the rest of HandwiredOS. While a photo
  // opens, a click is tested against the open photo's rectangle, the controls and the
  // thumbnails' destinations, e.g. a click beside the open rectangle closes the photo
  // that is still growing. While a photo returns, a click is tested against the cells,
  // e.g. a click on the returning photo's cell opens it again. `present` only decides
  // whether the photos are drawn: the springs go on while Photos flies to the dock, and
  // a window that comes back in the middle of a zoom shows the zoom under way.
  const closing = emitFirstOnly(circuit, previousFocusMass, nextFocusMass)
  // 1 when the photo that is open after this evaluation is the one that was closed last.
  const closedLastIsOpen = circuit.affine(
    nextFocus.map((wire, item) => [emitBoth(circuit, wire, cells.zoom.closedLast[item]!), 1]),
  )
  circuit.assumeRange(closedLastIsOpen, 0, 1)
  // An open of the photo that was closed last: no photo was open, and that photo is now.
  const reopening = emitFirstOnly(circuit, closedLastIsOpen, previousFocusMass)
  const swap = circuit.affine([[closing, 1], [reopening, 1]])
  circuit.assumeRange(swap, 0, 1)
  // openSpring after the swap: 1 when exactly one of openSpring and swap is 1.
  const nextOpenSpring = circuit.affine([
    [emitFirstOnly(circuit, cells.zoom.openSpring, swap), 1],
    [emitFirstOnly(circuit, swap, cells.zoom.openSpring), 1],
  ])
  circuit.assumeRange(nextOpenSpring, 0, 1)
  table.next(cells.zoom.openSpring, nextOpenSpring)
  // The spring that wasn't the open photo's is put at rest at 0 by a close, which
  // makes it the open photo's, and by a step onto the photo that it was taking back.
  const steppedOntoClosedLast = emitBoth(circuit, previousFocusMass, closedLastIsOpen)
  const otherSpringStops = circuit.affine([[closing, 1], [steppedOntoClosedLast, 1]])
  circuit.assumeRange(otherSpringStops, 0, 1)
  const zoomSprings = cells.zoom.springs.map((spring, index) => {
    // Whether this spring is the open photo's, before and after this evaluation's events.
    const wasOpenSpring = index === 0 ? circuit.affine([[cells.zoom.openSpring, -1]], 1) : cells.zoom.openSpring
    const isOpenSpring = index === 0 ? circuit.affine([[nextOpenSpring, -1]], 1) : nextOpenSpring
    const keepsMoving = circuit.reglu(
      [],
      1,
      [[host.snap, -1], [emitFirstOnly(circuit, otherSpringStops, wasOpenSpring), -1]],
      1,
    )
    const snap = circuit.affine([[keepsMoving, -1]], 1)
    circuit.assumeRange(snap, 0, 1)
    // The destination is 1 for the open photo's spring while a photo is open. The
    // steps simulate time before this evaluation's events, so they pull toward the
    // destination that the stored openSpring and focus cells give.
    const object = emitAnimatedObject(circuit, [{
      matrix: host.springMatrix,
      displacement: spring.displacement,
      velocity: spring.velocity,
      destination: emitBoth(circuit, isOpenSpring, nextFocusMass),
      destinationDuringSteps: emitBoth(circuit, wasOpenSpring, previousFocusMass),
    }], {settleCheck: host.settleCheck, snap, settleDistance: zoomSettleThreshold, settleSpeed: zoomSettleThreshold})
    table.next(spring, {displacement: object.displacements[0]!, velocity: object.velocities[0]!})
    // Clamped only where drawn, e.g. a zoom that overshoots 1 by 0.003 keeps its
    // stored displacement, and the photo stays inside the open rectangle.
    return {isOpenSpring, zoom: emitClampZeroOne(circuit, object.positions[0]!), active: object.active}
  })
  const [firstSpring, secondSpring] = zoomSprings as [typeof zoomSprings[number], typeof zoomSprings[number]]
  // The zoom of the open photo, and of the photo that was closed last.
  const openZoom = circuit.affine([
    [emitMultiply(circuit, firstSpring.zoom, firstSpring.isOpenSpring), 1],
    [emitMultiply(circuit, secondSpring.zoom, secondSpring.isOpenSpring), 1],
  ])
  circuit.assumeRange(openZoom, 0, 1)
  const returnZoom = circuit.affine([
    [emitMultiply(circuit, firstSpring.zoom, secondSpring.isOpenSpring), 1],
    [emitMultiply(circuit, secondSpring.zoom, firstSpring.isOpenSpring), 1],
  ])
  circuit.assumeRange(returnZoom, 0, 1)
  // A close makes the open photo the one that was closed last.
  const nextClosedLast = cells.zoom.closedLast.map((closedLast, item) => {
    const next = circuit.affine([
      [closedLast, 1],
      [circuit.reglu([[cells.focus[item]!, 1], [closedLast, -1]], 0, [[closing, 1]], 0), 1],
    ])
    circuit.assumeRange(next, 0, 1)
    return next
  })
  table.next(cells.zoom.closedLast, nextClosedLast)
  // How far the lightbox covers the grid: the two zooms together, at most 1. The
  // backdrop and the controls have this opacity, and a photo in its cell has the rest.
  const zoomSum = circuit.affine([[openZoom, 1], [returnZoom, 1]])
  const lightboxOpacity = circuit.affine([
    [zoomSum, 1],
    [emitRelu(circuit, circuit.affine([[zoomSum, 1]], -1)), -1],
  ])
  circuit.assumeRange(lightboxOpacity, 0, 1)
  // The part of it that the returning photo adds, which doesn't fade that photo itself.
  const returningShare = circuit.affine([[lightboxOpacity, 1], [openZoom, -1]])
  circuit.assumeRange(returningShare, 0, 1)
  const lightboxPresent = emitMultiply(circuit, present, lightboxOpacity)

  const photos: PhotoProjection[] = []
  for (let item = 0; item < itemCount; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    const focused = nextFocus[item]!
    const closedLast = nextClosedLast[item]!
    // The open photo has the open photo's spring, and the photo that was closed last
    // has the other one, unless it is the open photo again.
    const zoom = circuit.affine([
      [emitMultiply(circuit, openZoom, focused), 1],
      [circuit.reglu([[returnZoom, 1]], 0, [[closedLast, 1], [focused, -1]], 0), 1],
    ])
    circuit.assumeRange(zoom, 0, 1)
    // (1 - zoom) × cellValue + zoom × openValue. Each product reads its wires as they
    // are, so at zoom 0 the sum is cellValue × 1 + 0, the cell's own FP32 value, and
    // at zoom 1 it is the open rectangle's.
    const between = (cellValue: Wire, openValue: Wire) => circuit.affine([
      [circuit.append('reglu', [[cellValue, 1]], 0, [[zoom, -1]], 1, {preserveRounding: true}), 1],
      [emitMultiply(circuit, openValue, zoom), 1],
    ])
    // The zoom of the other photos: the open photo's unless this is the open photo,
    // and the returning photo's unless this is the open or the returning photo.
    const fadedByOpen = circuit.reglu([], 1, [[openZoom, 1], [focused, -1]], 0)
    const fadedByReturning = circuit.reglu([], 1, [[returningShare, 1], [focused, -1], [closedLast, -1]], 0)
    photos.push({
      left: between(gridLeft[column]!, main.left),
      top: between(gridTop[row]!, main.top),
      width: between(gridWidth, main.width),
      height: between(gridHeight, main.height),
      opacity: circuit.reglu([[present, 1]], 0, [[fadedByOpen, -gridFadeRate], [fadedByReturning, -gridFadeRate]], 1),
      zoom,
      stack: circuit.affine([[focused, 3], [closedLast, 1]]),
    })
  }

  const thumbnailTargets = projectThumbnailTargets(nextFocus, nextFocusMass)
  // Thumbnails are springs while a photo is open or a zoom is under way: at an open
  // they grow out of the strip's middle to their places, and at a close they shrink
  // back into it, since with no photo open every thumbnail's destination is the
  // strip's middle at size 0. With no photo open and no zoom under way they snap onto
  // that destination, e.g. while the window is resized with the grid in view, so
  // that nothing moves where nothing is drawn. They also snap when the host plans a
  // snap. Whether a zoom is under way comes from the stored underWay bit, i.e. from
  // the evaluation before this one, which is at most one settle check late and keeps
  // the thumbnails' operations out of the layers after the zoom's settle bits: reading
  // this evaluation's bits made the program 7 layers deeper.
  const underWay = circuit.affine([
    [circuit.reglu([], 1, [[firstSpring.active, -1], [secondSpring.active, -1]], 1), -1],
  ], 1)
  circuit.assumeRange(underWay, 0, 1)
  table.next(cells.zoom.underWay, underWay)
  const stripIdle = circuit.reglu(
    [],
    1,
    [[previousFocusMass, -1], [nextFocusMass, -1], [cells.zoom.underWay, -1]],
    1,
  )
  const thumbnailsKeepMoving = circuit.reglu([], 1, [[host.snap, -1], [stripIdle, -1]], 1)
  const snapThumbnails = circuit.affine([[thumbnailsKeepMoving, -1]], 1)
  circuit.assumeRange(snapThumbnails, 0, 1)
  const thumbnailProjections: ThumbnailProjection[] = []
  const activityTerms: [Wire, number][] = [[firstSpring.active, 1], [secondSpring.active, 1]]
  for (let item = 0; item < itemCount; item++) {
    const target = thumbnailTargets[item]!
    // centerX and scale settle together. The steps simulate time before this
    // evaluation's events, so they pull toward the destinations that the previous
    // evaluation wrote back.
    const thumbnail = emitAnimatedObject(circuit, [
      {
        matrix: host.springMatrix,
        displacement: cells.thumbnails[item]!.centerXDisplacement,
        velocity: cells.thumbnails[item]!.centerXVelocity,
        destination: target.centerX,
        destinationDuringSteps: cells.thumbnails[item]!.centerXDestination,
      },
      {
        matrix: host.springMatrix,
        displacement: cells.thumbnails[item]!.scaleDisplacement,
        velocity: cells.thumbnails[item]!.scaleVelocity,
        destination: target.scale,
        destinationDuringSteps: cells.thumbnails[item]!.scaleDestination,
      },
    ], {settleCheck: host.settleCheck, snap: snapThumbnails})
    // Clamped only where drawn, e.g. a scale that undershoots 0 while springing
    // keeps its stored displacement.
    const centerX = emitMinimum(
      circuit,
      emitMaximum(circuit, zero, thumbnail.positions[0]!),
      viewportWidth,
    )
    const scale = emitMinimum(
      circuit,
      emitMaximum(circuit, zero, thumbnail.positions[1]!),
      unit,
    )
    table.next(cells.thumbnails[item]!, {
      centerXDisplacement: thumbnail.displacements[0]!,
      centerXVelocity: thumbnail.velocities[0]!,
      centerXDestination: target.centerX,
      scaleDisplacement: thumbnail.displacements[1]!,
      scaleVelocity: thumbnail.velocities[1]!,
      scaleDestination: target.scale,
    })
    thumbnailProjections.push(projectThumbnail({
      centerX,
      scale,
      focused: target.focused,
    }))
    activityTerms.push([thumbnail.active, 1])
  }
  const animationActive = emitClampZeroOne(
    circuit,
    circuit.affine(activityTerms),
  )

  table.next(cells.focus, nextFocus)
  const previousControlOutput = [
    previousControl.left,
    previousControl.top,
    previousControl.width,
    previousControl.height,
    lightboxPresent,
  ]
  const nextControlOutput = [
    nextControl.left,
    nextControl.top,
    nextControl.width,
    nextControl.height,
    lightboxPresent,
  ]

  return {
    backdropOpacity: lightboxPresent,
    animationActive,
    photos: flattenPhotos(photos),
    thumbnails: flattenThumbnails(thumbnailProjections),
    previousControl: previousControlOutput,
    nextControl: nextControlOutput,
  }
}

// Photos on its own, in a table that also holds the host's cells. The program writes
// back the identity matrix and 0 settle check and snap bits.
export function createPhotoGalleryCircuit() {
  const table = createSourceTable()
  const cells = table.declare(photoGalleryCells)
  table.atMostOne('events', photoEvents(cells))
  const circuit = table.createCircuit()
  const photos = buildPhotos(circuit, table, cells, {
    viewportWidth: cells.viewportWidth,
    viewportHeight: cells.viewportHeight,
    click: cells.click,
    present: cells.present,
    interactive: cells.interactive,
    unit: cells.unit,
    springMatrix: cells.springMatrix,
    settleCheck: cells.settleCheck,
    snap: cells.snap,
  })
  // The stored table holds the identity matrix and no settle check or snap, so
  // evaluating it directly runs 0 steps.
  const zero = circuit.constant(0)
  table.next(
    {springMatrix: cells.springMatrix, settleCheck: cells.settleCheck, snap: cells.snap},
    {springMatrix: [cells.unit, zero, zero, cells.unit], settleCheck: zero, snap: zero},
  )
  const {nextSource, initialSource, validate} = table.finish()
  const output: PhotoGalleryOutput = {nextSource, ...photos}
  return {circuit, cells, output, initialSource, validate}
}

// What the host writes into the 4 matrix cells for each step count, see
// advanceFrame in host-timing.ts. HandwiredOS writes the same matrices.
const springStep = springStepMatrix(springConstants)
export const springMatrixPowers = Array.from(
  {length: defaultSpringClockConfig.maxStepsPerFrame + 1},
  (_, steps) => springMatrixPower(springStep, steps),
)

type PhotoGalleryEvent = {
  kind: 'mount' | 'resize' | 'click' | 'previous' | 'next' | 'close'
  // Shares the time origin of requestAnimationFrame timestamps, e.g. event.timeStamp.
  timeStamp: number
  // Writes the event into the table: a latch, or the viewport for a mount or resize.
  apply: (table: Float32Array) => void
}

type PhotoGalleryEvaluation = {
  kind: EvaluationKind
  timeMs: number
  steps: number
  writesBack: boolean
  events: PhotoGalleryEvent['kind'][]
}

type PhotoGalleryObserver = {
  // The table just before an evaluation, after the host wrote the matrix, the
  // bits, present, interactive and the events.
  beforeEvaluate?: (table: Float32Array, evaluation: PlannedEvaluation<PhotoGalleryEvent>) => void
  // The evaluated values, and the table: the stored table after write-back, or
  // the copy that a 'frame' evaluation ran on.
  afterEvaluate?: (values: Float32Array, table: Float32Array, evaluation: PlannedEvaluation<PhotoGalleryEvent>) => void
}

/** @public */
export function createPhotoGalleryMachine(options: {writeBack?: WriteBack} = {}) {
  const writeBack = options.writeBack ?? 'events and settle checks'
  const {circuit, cells, output, initialSource, validate} = createPhotoGalleryCircuit()
  const source = new Float32Array(initialSource)
  const wireCount = validateCircuit(circuit)
  validatePhotoGalleryOutputWires(output, wireCount)
  const roots = [
    ...output.nextSource,
    output.backdropOpacity,
    output.animationActive,
    ...output.photos,
    ...output.thumbnails,
    ...output.previousControl,
    ...output.nextControl,
  ]
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, tensorProgram)
  // Reuses its buffers across evaluations. Each evaluation copies the roots into
  // `values`, which the validators and callers index by wire.
  const evaluateRoots = circuit.createTensorProgramEvaluator(tensorProgram)
  const values = new Float32Array(wireCount)
  const scratch = new Float32Array(source.length)
  const numericTolerance = 1e-5
  let clock: SpringClock = stoppedSpringClock
  let queued: (Omit<PhotoGalleryEvent, 'timeStamp'> & {timeStamp: number | undefined})[] = []
  let mounted = false
  let queuedViewport: readonly [width: number, height: number] = [0, 0]
  let previousFrameTime = 0
  let present = 1
  let interactive = 1
  const observers: PhotoGalleryObserver[] = []
  const evaluations: PhotoGalleryEvaluation[] = []
  // The stored table as the last step left it. Only step() writes the stored table,
  // so a difference at the next step is a write from outside the machine.
  const storedAfterLastStep = Float32Array.from(source)

  function queue(kind: PhotoGalleryEvent['kind'], timeStamp: number | undefined, apply: (table: Float32Array) => void) {
    invariant(timeStamp === undefined || Number.isFinite(timeStamp), 'an event timestamp must be finite')
    const event = {kind, timeStamp, apply}
    // A mount applies before the events queued before the first step.
    if (kind === 'mount') queued.unshift(event)
    else queued.push(event)
  }

  function queueViewport(kind: 'mount' | 'resize', width: number, height: number, timeStamp: number | undefined) {
    queuedViewport = [width, height]
    queue(kind, timeStamp, table => {
      table[cells.viewportWidth] = width
      table[cells.viewportHeight] = height
    })
  }

  function receiveEvent(
    kind: 'click' | 'previous' | 'next' | 'close',
    field: Wire,
    timeStamp: number | undefined,
    x?: number,
    y?: number,
  ) {
    queue(kind, timeStamp, table => {
      for (const eventField of photoEvents(cells)) table[eventField] = 0
      table[field] = 1
      if (x !== undefined && y !== undefined) {
        table[cells.click.x] = x
        table[cells.click.y] = y
      }
    })
  }

  // One evaluation that advanceFrame planned: write the matrix, the settle check
  // and snap bits, present, interactive and the events, evaluate, and write next
  // state back when the evaluation writes back.
  function evaluate(evaluation: PlannedEvaluation<PhotoGalleryEvent>) {
    const table = evaluation.writesBack ? source : scratch
    if (!evaluation.writesBack) scratch.set(source)
    table.set(springMatrixPowers[evaluation.steps]!, cells.springMatrix[0])
    table[cells.settleCheck] = evaluation.settleCheck ? 1 : 0
    table[cells.snap] = evaluation.snap ? 1 : 0
    // present and interactive set no destination, so every evaluation of a step
    // reads the ones passed to that step, e.g. a click's evaluation.
    table[cells.present] = present
    table[cells.interactive] = interactive
    for (const event of evaluation.events) event.apply(table)
    validate(table)
    for (const observer of observers) observer.beforeEvaluate?.(table, evaluation)
    const rootValues = evaluateRoots(table)
    for (let index = 0; index < roots.length; index++) values[roots[index]!] = rootValues[index]!
    // The next-state values are the first roots. Only roots are written into
    // `values`, so the finite check covers the roots, not every wire.
    const nextSourceValues = rootValues.subarray(0, source.length)
    validate(nextSourceValues)
    assertFiniteValues(rootValues, 'tensor output')
    validatePhotoGalleryOutput(values, output, numericTolerance)
    if (evaluation.writesBack) source.set(nextSourceValues)
    evaluations.push({
      kind: evaluation.kind,
      timeMs: evaluation.timeMs,
      steps: evaluation.steps,
      writesBack: evaluation.writesBack,
      events: evaluation.events.map(event => event.kind),
    })
    for (const observer of observers) observer.afterEvaluate?.(values, table, evaluation)
    return values[output.animationActive]! > 0
  }

  return {
    circuit,
    cells,
    output,
    source,
    tensorProgram,
    // A host requests frames while clock.animatedUntilMs isn't null.
    get clock() {
      return clock
    },
    // The evaluations of the last step, in order.
    evaluations: evaluations as readonly PhotoGalleryEvaluation[],
    observe(observer: PhotoGalleryObserver) {
      observers.push(observer)
    },
    // Runs the frame at frameTime, by default 16 ms after the previous frame, and
    // returns the values of its 'frame' evaluation. An event without a timestamp
    // applies at this frame's time. The returned values, indexed by wire, are the
    // machine's own array, which the next step overwrites, so a caller that keeps a
    // frame's values across steps copies them, e.g. with values.slice().
    step(
      viewportWidth: number,
      viewportHeight: number,
      nextPresent = 1,
      nextInteractive = 1,
      frameTime = previousFrameTime + 16,
    ) {
      invariant(Number.isFinite(frameTime), 'frame time must be finite')
      // A value written straight into `source` between steps, e.g. a latch, would
      // apply only in 'frame' evaluations, which run on a copy, so it would never
      // commit, and a latch would apply again in every later frame. Values written
      // before the first step commit with the mount, e.g. a changed constant.
      if (mounted) {
        for (let field = 0; field < source.length; field++) {
          if (source[field] !== storedAfterLastStep[field]) {
            invariant(false, `source cell ${field} was written between steps. Queue input with the event methods instead, e.g. click(x, y, timeStamp) or resize(width, height, timeStamp)`)
          }
        }
      }
      present = nextPresent
      interactive = nextInteractive
      if (!mounted) {
        mounted = true
        const earliest = queued.reduce((time, event) => Math.min(time, event.timeStamp ?? frameTime), frameTime)
        queueViewport('mount', viewportWidth, viewportHeight, earliest)
      } else if (viewportWidth !== queuedViewport[0] || viewportHeight !== queuedViewport[1]) {
        // The viewport sets thumbnail destinations, so a change reaches the program
        // as an event. Written without one, it would change destinations only in
        // frame evaluations, which never start the clock.
        queueViewport('resize', viewportWidth, viewportHeight, frameTime)
      }
      const events = queued.map(event => ({...event, timeStamp: event.timeStamp ?? frameTime}))
      queued = []
      evaluations.length = 0
      clock = advanceFrame(clock, frameTime, events, evaluate, writeBack)
      previousFrameTime = frameTime
      storedAfterLastStep.set(source)
      return values
    },
    resize(width: number, height: number, timeStamp?: number) {
      queueViewport('resize', width, height, timeStamp)
    },
    click(x: number, y: number, timeStamp?: number) {
      receiveEvent('click', cells.click.active, timeStamp, x, y)
    },
    previous(timeStamp?: number) {
      receiveEvent('previous', cells.previous, timeStamp)
    },
    next(timeStamp?: number) {
      receiveEvent('next', cells.next, timeStamp)
    },
    close(timeStamp?: number) {
      receiveEvent('close', cells.close, timeStamp)
    },
  }
}

function thumbnailFalloff(distance: number) {
  return Math.max(0, 1 - 0.22 * distance)
}

function thumbnailFalloffMass() {
  let mass = thumbnailFalloff(0)
  for (let distance = 1; distance < 5; distance++) {
    mass += 2 * thumbnailFalloff(distance)
  }
  return mass
}

function thumbnailSpread(distance: number) {
  let spread = 0
  for (let step = 1; step <= distance; step++) {
    spread += (
      thumbnailFalloff(step - 1)
      + thumbnailFalloff(step)
    ) / 2
  }
  return spread
}

// The photos' outputs in photoField's order.
function flattenPhotos(projections: readonly PhotoProjection[]) {
  const output: Wire[] = []
  for (const projection of projections) {
    output.push(
      projection.left,
      projection.top,
      projection.width,
      projection.height,
      projection.opacity,
      projection.zoom,
      projection.stack,
    )
  }
  return output
}

// The thumbnails' outputs in thumbnailField's order.
function flattenThumbnails(projections: readonly ThumbnailProjection[]) {
  const output: Wire[] = []
  for (const projection of projections) {
    output.push(
      projection.left,
      projection.top,
      projection.width,
      projection.height,
      projection.opacity,
      projection.focused,
    )
  }
  return output
}

export function createPhotoGalleryRenderer(document: Document, root: HTMLElement) {
  const backdrop = root.querySelector<HTMLElement>('.photos-backdrop')
  const previousControl = root.querySelector<HTMLElement>('.photos-previous')
  const nextControl = root.querySelector<HTMLElement>('.photos-next')
  invariant(backdrop !== null, 'backdrop is missing')
  invariant(previousControl !== null, 'previous control is missing')
  invariant(nextControl !== null, 'next control is missing')
  const photoElements = Array<HTMLElement | null>(itemCount).fill(null)
  const thumbnailElements = Array<HTMLElement | null>(itemCount).fill(null)

  function projectGeometry(
    element: HTMLElement,
    values: Float32Array,
    output: readonly Wire[],
    outputStart = 0,
  ) {
    const left = values[output[outputStart + controlField.left]!]!
    const top = values[output[outputStart + controlField.top]!]!
    element.style.width = `${values[output[outputStart + controlField.width]!]!}px`
    element.style.height = `${values[output[outputStart + controlField.height]!]!}px`
    element.style.transform = `translate3d(${left}px,${top}px,0)`
  }

  function createPhotoElement(item: number, thumbnail: boolean) {
    const element = document.createElement('div')
    element.className =
      `${thumbnail ? 'photos-thumbnail' : 'photos-photo'} image-${item}`
    if (!thumbnail) {
      const title = document.createElement('span')
      title.textContent = photoNames[item]!
      element.appendChild(title)
    }
    root.appendChild(element)
    return element
  }

  // Keeps an item's node in the DOM only while the program draws the item, i.e. while
  // its size and opacity outputs are positive, and writes the node's rectangle and
  // opacity. photoField and thumbnailField hold these five outputs at the same
  // places. Returns the node, or null for an item that isn't drawn.
  function projectItem(
    elements: (HTMLElement | null)[],
    item: number,
    values: Float32Array,
    output: readonly Wire[],
    outputStart: number,
    thumbnail: boolean,
  ) {
    const width = values[output[outputStart + photoField.width]!]!
    const height = values[output[outputStart + photoField.height]!]!
    const opacity = values[output[outputStart + photoField.opacity]!]!
    const visible = width > 0 && height > 0 && opacity > 0
    let element = elements[item] ?? null
    if (!visible) {
      if (element !== null) {
        element.remove()
        elements[item] = null
      }
      return null
    }
    if (element === null) {
      element = createPhotoElement(item, thumbnail)
      elements[item] = element
    }
    projectGeometry(element, values, output, outputStart)
    element.style.opacity = `${opacity}`
    return element
  }

  return {
    render(values: Float32Array, output: PhotoOutputs) {
      backdrop.style.opacity = `${values[output.backdropOpacity]}`
      for (let item = 0; item < itemCount; item++) {
        const photoStart = item * photoField.size
        const photo = projectItem(photoElements, item, values, output.photos, photoStart, false)
        if (photo !== null) {
          // --zoom scales the photo's shadow and fades its name in, see handwired-os.css.
          photo.style.setProperty('--zoom', `${values[output.photos[photoStart + photoField.zoom]!]}`)
          photo.style.zIndex = `${values[output.photos[photoStart + photoField.stack]!]}`
        }
        const thumbnailStart = item * thumbnailField.size
        const thumbnail = projectItem(thumbnailElements, item, values, output.thumbnails, thumbnailStart, true)
        if (thumbnail !== null) {
          thumbnail.style.setProperty('--focused', `${values[output.thumbnails[thumbnailStart + thumbnailField.focused]!]}`)
        }
      }
      projectGeometry(previousControl, values, output.previousControl)
      projectGeometry(nextControl, values, output.nextControl)
      previousControl.style.opacity =
        `${values[output.previousControl[controlField.opacity]!]}`
      nextControl.style.opacity =
        `${values[output.nextControl[controlField.opacity]!]}`
    },
  }
}

// What two limits on a photo's proportions take from a box's width and from its
// height: the width past maximumWideness times the height, and the height past
// maximumTallness times the width, e.g. 20 px of width from a box of 220 × 100 px
// that may be twice as wide as tall. At most one of the two is more than 0, and a
// box within both limits gets an exact 0 for each, so its photos are laid out with
// the same FP32 values as without the limits.
function emitProportionExcess(circuit: Circuit, width: Wire, height: Wire, maximumWideness: number, maximumTallness: number) {
  return {
    width: emitRelu(circuit, circuit.affine([[width, 1], [height, -maximumWideness]])),
    height: emitRelu(circuit, circuit.affine([[height, 1], [width, -maximumTallness]])),
  }
}

// A box's width or height without what a limit takes from it. The excess is at
// most the size, so the result is between 0 and the size, and a size is at most
// 16,384 px, see buildPhotos. The builder can't infer that from the difference, and
// without the declared range each product with the result takes a second
// operation, for negative values that never come.
function emitWithoutExcess(circuit: Circuit, size: Wire, excess: Wire) {
  const result = circuit.affine([[size, 1], [excess, -1]])
  circuit.assumeRange(result, 0, 16_384)
  return result
}

function emitRectangleHit(circuit: Circuit, click: {x: Wire, y: Wire}, geometry: Geometry): Wire {
  const horizontalHit = emitIntervalHit(
    circuit,
    click.x,
    geometry.left,
    geometry.width,
  )
  const verticalHit = emitIntervalHit(
    circuit,
    click.y,
    geometry.top,
    geometry.height,
  )
  return emitMinimum(circuit, horizontalHit, verticalHit)
}

function emitIntervalHit(circuit: Circuit, position: Wire, start: Wire, size: Wire): Wire {
  return circuit.boolean(
    emitClampZeroOne(circuit, emitIntervalDistance(circuit, position, start, size)),
  )
}

// How far the position lies inside the interval from start to start + size: the
// smaller of its distances to the two ends, e.g. 3 when the position is 3 px past
// start in a 100 px interval, and negative outside the interval. HandwiredOS's dock
// hit test uses it too.
export function emitIntervalDistance(circuit: Circuit, position: Wire, start: Wire, size: Wire): Wire {
  const end = circuit.affine([[start, 1], [size, 1]])
  return emitMinimum(
    circuit,
    circuit.affine([[position, 1], [start, -1]]),
    circuit.affine([[end, 1], [position, -1]]),
  )
}

export function validatePhotoGalleryOutputWires(
  output: PhotoOutputs,
  wireCount: number,
) {
  assertWire(output.backdropOpacity, wireCount)
  assertWire(output.animationActive, wireCount)
  validateWireView(output.photos, itemCount * photoField.size, wireCount)
  validateWireView(output.thumbnails, itemCount * thumbnailField.size, wireCount)
  validateWireView(output.previousControl, controlField.size, wireCount)
  validateWireView(output.nextControl, controlField.size, wireCount)
}

export function validatePhotoGalleryOutput(
  values: Float32Array,
  output: PhotoOutputs,
  tolerance = 1e-9,
) {
  // The machine checks that every root value is finite before calling this.
  assertUnitInterval(values[output.backdropOpacity], 'backdrop opacity', tolerance)
  assertUnitInterval(values[output.animationActive], 'animation active', tolerance)
  for (let item = 0; item < itemCount; item++) {
    const outputStart = item * photoField.size
    for (const field of geometryFields) {
      assertNonNegativeFinite(values[output.photos[outputStart + photoField[field]]!], `photo ${field}`)
    }
    assertUnitInterval(
      values[output.photos[outputStart + photoField.opacity]!],
      'photo opacity',
      tolerance,
    )
    assertUnitInterval(
      values[output.photos[outputStart + photoField.zoom]!],
      'photo zoom',
      tolerance,
    )
    // 3 for the open photo plus 1 for the photo that was closed last.
    const stack = values[output.photos[outputStart + photoField.stack]!]
    invariant(stack === 0 || stack === 1 || stack === 3 || stack === 4, `photo stack must be 0, 1, 3 or 4, got ${stack}`)
  }
  for (let item = 0; item < itemCount; item++) {
    const outputStart = item * thumbnailField.size
    for (const field of geometryFields) {
      const value = values[output.thumbnails[outputStart + thumbnailField[field]]!]
      // A thumbnail's left is its springing center minus half its size, so it can
      // overshoot past 0, e.g. to -0.74 px when a photo is open and the viewport grows
      // from 33×339 to 1435×668.
      if (field === 'left') invariant(Number.isFinite(value), `thumbnail left must be finite, got ${value}`)
      else assertNonNegativeFinite(value, `thumbnail ${field}`)
    }
    assertUnitInterval(
      values[output.thumbnails[outputStart + thumbnailField.opacity]!],
      'thumbnail opacity',
      tolerance,
    )
    assertUnitInterval(
      values[output.thumbnails[outputStart + thumbnailField.focused]!],
      'thumbnail focus',
      tolerance,
    )
  }
  for (const control of [output.previousControl, output.nextControl]) {
    for (const field of geometryFields) {
      assertNonNegativeFinite(values[control[controlField[field]]!], `control ${field}`)
    }
    assertUnitInterval(values[control[controlField.opacity]!], 'control opacity', tolerance)
  }
}

function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1]], -1))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

// 1 when both bits are 1, as relu(first + second - 1), e.g. this spring is the open
// photo's and a photo is open.
function emitBoth(circuit: Circuit, first: Wire, second: Wire): Wire {
  return circuit.reglu([], 1, [[first, 1], [second, 1]], -1)
}

// 1 when the first bit is 1 and the second is 0, as relu(first - second), e.g. a
// photo was open and none is now.
function emitFirstOnly(circuit: Circuit, first: Wire, second: Wire): Wire {
  return circuit.reglu([], 1, [[first, 1], [second, -1]], 0)
}

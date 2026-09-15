// Photos as a component. `buildPhotos` is notation/photos.ts with one switch:
// thumbnail springs are either the original emitSpring lanes or spring bank
// boxes. With original springs it creates the same operations in the same
// order as photo-gallery.ts, so the base circuit stays identical.
//
// `photoLayout`, `photoClick`, `photoKeys` and `renderPhotos` are the parts the
// event queue build uses: Photos no longer receives latched events, it receives
// one click per press session and one folded run of key presses per segment
// between presses (see desktop-queue.ts).
import {type Wire, invariant} from '../../../numeric-ui-core.ts'
import {type SpringGroup, emitSpringBox} from './spring-bank.ts'
import {
  type Allocated,
  type SourceTable,
  anyNumber,
  bit,
  constant,
  event,
  exactBit,
  input,
  list,
  nonNegative,
  oneHot,
  state,
  unitInterval,
} from './table.ts'
import {type Notation, type Rect, type SpringParams, type Vec2, bias} from './wires.ts'

// category: declarations
export const photoCount = 12
export const columnCount = 4
export const rowCount = 3
const pixel = [0, 16_384] as const
const smallPixel = [0, 1024] as const
export const photoConstantCells = {
  gap: constant(18, smallPixel),
  mainInset: constant(92, smallPixel),
  thumbnailHeight: constant(82, smallPixel),
  controlSize: constant(52, smallPixel),
}
export const photoLatchCells = {
  clickActive: event(),
  clickX: input(anyNumber),
  clickY: input(anyNumber),
  previousActive: event(),
  nextActive: event(),
  closeActive: event(),
}
export const photoStateCells = {
  focus: oneHot(list(photoCount, () => bit()), {allowAllZero: true, declareToCircuit: false}),
  thumbnails: list(photoCount, () => ({
    centerX: state(pixel),
    centerXVelocity: state(anyNumber),
    scale: state(unitInterval),
    scaleVelocity: state(anyNumber),
  })),
}
// The destination each thumbnail lane stepped toward last frame (deferred
// retargeting). A thumbnail's target center can sit outside the strip, so it's
// declared wider than the viewport.
export const photoBankCells = list(photoCount, () => ({centerX: state([-16_384, 32_768]), scale: state(unitInterval)}))
export type PhotoConstantCells = Allocated<typeof photoConstantCells>
export type PhotoLatchCells = Allocated<typeof photoLatchCells>
export type PhotoStateCells = Allocated<typeof photoStateCells>
export type PhotoBankCells = Allocated<typeof photoBankCells>
export type PhotoCells = PhotoConstantCells & PhotoLatchCells & PhotoStateCells

export type PhotoSprings =
  | {kind: 'original', params: SpringParams}
  | {kind: 'bank', group: SpringGroup, settleDistance: Wire, settleSpeed: Wire, destinations: PhotoBankCells}
export type PhotoInputs = {viewport: Vec2, present: Wire, interactive: Wire, springs: PhotoSprings}

export function declarePhotoRules(table: SourceTable, cells: PhotoLatchCells) {
  table.atMostOne('photos events', [cells.clickActive, cells.previousActive, cells.nextActive, cells.closeActive])
}

// category: validation
// The runtime half of the input contracts, checked by the host after every evaluation.
export const photoInputContract = {viewport: nonNegative, present: [-1e-5, 1 + 1e-5], interactive: exactBit} as const

// Debug wires for the float64 spring check: the snap bit shared by all thumbnails and each box's active bit.
export type PhotoDebug = {snap: Wire, active: Wire[]}

// category: behavior
export function buildPhotos($: Notation, table: SourceTable, cells: PhotoCells, inputs: PhotoInputs) {
  const {sum, scale, relu, mul, min, assume, lookup, separableHit, intervalHit, rect} = $
  const {gap, controlSize, focus} = cells
  const {viewport, present, interactive, springs} = inputs
  const click = $.vec2(cells.clickX, cells.clickY)
  // Input contracts: the host's wires must honor the ranges Photos assumes.
  assume(viewport.x, ...pixel)
  assume(viewport.y, ...pixel)
  assume(present, 0, 1)
  assume(interactive, 0, 1)
  if (springs.kind === 'original') {
    for (const wire of Object.values(springs.params)) assume(wire, 0, Number.POSITIVE_INFINITY)
  }

  const gridWidth = relu(sum([viewport.x, 1 / columnCount], [gap, -(columnCount + 1) / columnCount]))
  const gridHeight = relu(sum([viewport.y, 1 / rowCount], [gap, -(rowCount + 1) / rowCount]))
  const gridLeft = list(columnCount, column => sum([gap, 1 + column], [gridWidth, column]))
  const gridTop = list(rowCount, row => sum([gap, 1 + row], [gridHeight, row]))
  const columnHit = gridLeft.map(left => intervalHit(click.x, left, gridWidth))
  const rowHit = gridTop.map(top => intervalHit(click.y, top, gridHeight))
  const gridHit = list(photoCount, item => min(columnHit[item % columnCount]!, rowHit[Math.floor(item / columnCount)]!))

  const thumbnailBaseSize = min(cells.thumbnailHeight, min(scale(viewport.x, 1 / 6), scale(viewport.y, 0.24)))
  const mainInset = min(cells.mainInset, scale(viewport.x, 0.08))
  const main = rect(mainInset, gap, relu(sum(viewport.x, [mainInset, -2])), relu(sum(viewport.y, [thumbnailBaseSize, -1], [gap, -3])))
  const mainHit = separableHit(click, main)
  const previousFocusMass = assume(sum(...focus), 0, 1)
  const previousGridMass = sum([previousFocusMass, -1], bias(1))

  const thumbnailOuterInset = min(gap, scale(viewport.x, 0.5))
  const thumbnailImageSpan = scale(thumbnailBaseSize, falloffMass())
  const thumbnailGap = min($.constant(12), relu(sum([viewport.x, 1 / 8], [thumbnailOuterInset, -2 / 8], [thumbnailImageSpan, -1 / 8])))
  const thumbnailCenterY = sum(viewport.y, [gap, -1], [thumbnailBaseSize, -0.5])
  const thumbnailTargets = (focusBits: readonly Wire[], focusMass: Wire) => list(photoCount, item => {
    const offsets = list(photoCount, focused => cyclicOffset(item, focused))
    const visibleOffsets = offsets.map(offset => Math.abs(offset) < 5 ? offset : 0)
    const offset = lookup(focusBits, visibleOffsets)
    const distance = lookup(focusBits, offsets.map(Math.abs))
    const spread = lookup(focusBits, visibleOffsets.map(visible => Math.sign(visible) * spreadAt(Math.abs(visible))))
    const falloff = relu(sum(focusMass, [distance, -0.22]))
    return {centerX: sum([viewport.x, 0.5], mul(thumbnailBaseSize, spread), mul(thumbnailGap, offset)), scale: falloff, focused: focusBits[item]!}
  })
  const projectThumbnail = (target: {centerX: Wire, scale: Wire, focused: Wire}) => {
    const visibleScale = mul(present, target.scale)
    const size = mul(thumbnailBaseSize, visibleScale)
    const box = rect(sum(target.centerX, [size, -0.5]), relu(sum(thumbnailCenterY, [size, -0.5])), size, size)
    return {...box, opacity: visibleScale, focused: target.focused}
  }
  const thumbnailHit = thumbnailTargets(focus, previousFocusMass).map(target => separableHit(click, projectThumbnail(target)))

  const controlTop = relu(sum(gap, [main.height, 0.5], [controlSize, -0.5]))
  const controlInset = scale(gap, 0.5)
  const previousControl = rect(controlInset, controlTop, controlSize, controlSize)
  const nextControl = rect(relu(sum(viewport.x, [controlInset, -1], [controlSize, -1])), controlTop, controlSize, controlSize)
  const controlVerticalHit = intervalHit(click.y, controlTop, controlSize)
  const controlHit = (control: Rect) => min(intervalHit(click.x, control.left, control.width), controlVerticalHit)
  const previousControlHit = controlHit(previousControl)
  const nextControlHit = controlHit(nextControl)

  // Events count only while Photos is focused. In the lightbox, one click picks
  // previous, next, a thumbnail, or the main image, in that priority order.
  const events = [cells.clickActive, cells.previousActive, cells.nextActive, cells.closeActive].map(latch => mul(interactive, latch))
  const [clickEvent, previousEvent, nextEvent] = events as [Wire, Wire, Wire, Wire]
  const eventInactive = sum([assume(sum(...events), 0, 1), -1], bias(1))
  const clickGridGate = mul(clickEvent, previousGridMass)
  const focusedClick = assume(mul(clickEvent, previousFocusMass), 0, 1)
  const [previousControlClick, nextControlClick, ...surfaceClicks] = $.firstActive(focusedClick, [previousControlHit, nextControlHit, ...thumbnailHit, mainHit])
  const keepFocusGate = sum(eventInactive, surfaceClicks[photoCount]!)
  const previousGate = sum(previousEvent, previousControlClick!)
  const nextGate = sum(nextEvent, nextControlClick!)
  const nextFocus = list(photoCount, item => sum(
    mul(keepFocusGate, focus[item]!),
    mul(clickGridGate, gridHit[item]!),
    surfaceClicks[item]!,
    mul(previousGate, focus[(item + 1) % photoCount]!),
    mul(nextGate, focus[(item + photoCount - 1) % photoCount]!),
  ))
  table.next(focus, nextFocus)
  return renderPhotos($, table, cells, {viewport, present, gridLeft, gridTop, gridWidth, gridHeight, main, previousControl, nextControl, thumbnailTargets, projectThumbnail}, previousFocusMass, nextFocus, springs)
}

export type PhotoLayout = {
  viewport: Vec2
  present: Wire
  gridLeft: Wire[]
  gridTop: Wire[]
  gridWidth: Wire
  gridHeight: Wire
  main: Rect
  previousControl: Rect
  nextControl: Rect
  thumbnailTargets: (focusBits: readonly Wire[], focusMass: Wire) => {centerX: Wire, scale: Wire, focused: Wire}[]
  projectThumbnail: (target: {centerX: Wire, scale: Wire, focused: Wire}) => Rect & {opacity: Wire, focused: Wire}
}

// The part of Photos after this frame's focus is known: grid and lightbox
// projections, thumbnail springs, and the animation bit.
export function renderPhotos(
  $: Notation, table: SourceTable, cells: PhotoStateCells, layout: PhotoLayout, previousFocusMass: Wire, nextFocus: readonly Wire[], springs: PhotoSprings,
) {
  const {sum, mul, min, max, assume, select, rect, zero, unit} = $
  const {viewport, present, gridLeft, gridTop, main} = layout
  const nextFocusMass = assume(sum(...nextFocus), 0, 1)
  const nextGridMass = sum([nextFocusMass, -1], bias(1))
  const gridLeftShown = gridLeft.map(left => mul(nextGridMass, left))
  const gridTopShown = gridTop.map(top => mul(nextGridMass, top))
  const gridWidthShown = mul(nextGridMass, layout.gridWidth)
  const gridHeightShown = mul(nextGridMass, layout.gridHeight)
  const targets = layout.thumbnailTargets(nextFocus, nextFocusMass)
  // Thumbnails animate only when the lightbox was open before and after this frame.
  const animateThumbnails = mul(previousFocusMass, nextFocusMass)
  const snapThumbnails = sum([animateThumbnails, -1], bias(1))
  const animationTerms: Wire[] = []
  const boxActive: Wire[] = []
  const thumbnails = targets.map((target, item) => {
    const stored = cells.thumbnails[item]!
    let centerX: Wire
    let thumbnailScale: Wire
    if (springs.kind === 'original') {
      const centerSpring = $.spring(stored.centerX, stored.centerXVelocity, target.centerX, springs.params)
      const scaleSpring = $.spring(stored.scale, stored.scaleVelocity, target.scale, springs.params)
      centerX = select(snapThumbnails, min(max(zero, centerSpring.position), viewport.x), target.centerX)
      thumbnailScale = select(snapThumbnails, min(max(zero, scaleSpring.position), unit), target.scale)
      table.next(stored, {
        centerX,
        centerXVelocity: select(snapThumbnails, centerSpring.velocity, zero),
        scale: thumbnailScale,
        scaleVelocity: select(snapThumbnails, scaleSpring.velocity, zero),
      })
      animationTerms.push(mul(animateThumbnails, centerSpring.active), mul(animateThumbnails, scaleSpring.active))
    } else {
      const destinations = springs.destinations[item]!
      const box = emitSpringBox($.circuit, [
        {group: springs.group, position: stored.centerX, velocity: stored.centerXVelocity, destination: target.centerX, previousDestination: destinations.centerX},
        {group: springs.group, position: stored.scale, velocity: stored.scaleVelocity, destination: target.scale, previousDestination: destinations.scale},
      ], {unit, settleDistance: springs.settleDistance, settleSpeed: springs.settleSpeed, retarget: 'deferred', snap: snapThumbnails})
      // spring-bank/photo-gallery.ts: the strip layout keeps every target inside
      // 0..viewport, so clamping both branches gives the same values as the
      // original's select without one.
      centerX = min(max(zero, box.positions[0]!), viewport.x)
      thumbnailScale = min(max(zero, box.positions[1]!), unit)
      table.next(stored, {centerX, centerXVelocity: box.velocities[0]!, scale: thumbnailScale, scaleVelocity: box.velocities[1]!})
      table.next(destinations, {centerX: box.nextPreviousDestinations[0]!, scale: box.nextPreviousDestinations[1]!})
      animationTerms.push(box.active)
      boxActive.push(box.active)
    }
    return layout.projectThumbnail({centerX, scale: thumbnailScale, focused: target.focused})
  })
  const animationActive = $.clamp01(sum(...animationTerms), 1)
  const photos = list(photoCount, item => {
    const focused = nextFocus[item]!
    const show = (gridValue: Wire, mainValue: Wire) => sum(gridValue, mul(focused, mainValue))
    return {
      ...rect(
        show(gridLeftShown[item % columnCount]!, main.left),
        show(gridTopShown[Math.floor(item / columnCount)]!, main.top),
        show(gridWidthShown, main.width),
        show(gridHeightShown, main.height),
      ),
      opacity: mul(present, sum(nextGridMass, focused)),
      focused,
    }
  })
  const lightboxOpacity = mul(present, nextFocusMass)
  const debug: PhotoDebug = {snap: snapThumbnails, active: boxActive}
  return {
    output: {
      backdropOpacity: lightboxOpacity,
      animationActive,
      photos,
      thumbnails,
      previousControl: {...layout.previousControl, opacity: lightboxOpacity},
      nextControl: {...layout.nextControl, opacity: lightboxOpacity},
    },
    debug,
  }
}
export type PhotoOutputs = ReturnType<typeof renderPhotos>['output']

// Photos layout for a viewport, without hit tests. The queue build lays Photos
// out twice: once at the window's destination size for hit tests, and once at
// the animated size for drawing.
export function photoLayout($: Notation, cells: PhotoConstantCells, viewport: Vec2, present: Wire): PhotoLayout {
  const {sum, scale, relu, mul, min, lookup, rect} = $
  const {gap, controlSize} = cells
  const gridWidth = relu(sum([viewport.x, 1 / columnCount], [gap, -(columnCount + 1) / columnCount]))
  const gridHeight = relu(sum([viewport.y, 1 / rowCount], [gap, -(rowCount + 1) / rowCount]))
  const gridLeft = list(columnCount, column => sum([gap, 1 + column], [gridWidth, column]))
  const gridTop = list(rowCount, row => sum([gap, 1 + row], [gridHeight, row]))
  const thumbnailBaseSize = min(cells.thumbnailHeight, min(scale(viewport.x, 1 / 6), scale(viewport.y, 0.24)))
  const mainInset = min(cells.mainInset, scale(viewport.x, 0.08))
  const main = rect(mainInset, gap, relu(sum(viewport.x, [mainInset, -2])), relu(sum(viewport.y, [thumbnailBaseSize, -1], [gap, -3])))
  const thumbnailOuterInset = min(gap, scale(viewport.x, 0.5))
  const thumbnailImageSpan = scale(thumbnailBaseSize, falloffMass())
  const thumbnailGap = min($.constant(12), relu(sum([viewport.x, 1 / 8], [thumbnailOuterInset, -2 / 8], [thumbnailImageSpan, -1 / 8])))
  const thumbnailCenterY = sum(viewport.y, [gap, -1], [thumbnailBaseSize, -0.5])
  const thumbnailTargets = (focusBits: readonly Wire[], focusMass: Wire) => list(photoCount, item => {
    const offsets = list(photoCount, focused => cyclicOffset(item, focused))
    const visibleOffsets = offsets.map(offset => Math.abs(offset) < 5 ? offset : 0)
    const offset = lookup(focusBits, visibleOffsets)
    const distance = lookup(focusBits, offsets.map(Math.abs))
    const spread = lookup(focusBits, visibleOffsets.map(visible => Math.sign(visible) * spreadAt(Math.abs(visible))))
    const falloff = relu(sum(focusMass, [distance, -0.22]))
    return {centerX: sum([viewport.x, 0.5], mul(thumbnailBaseSize, spread), mul(thumbnailGap, offset)), scale: falloff, focused: focusBits[item]!}
  })
  const projectThumbnail = (target: {centerX: Wire, scale: Wire, focused: Wire}) => {
    const visibleScale = mul(present, target.scale)
    const size = mul(thumbnailBaseSize, visibleScale)
    const box = rect(sum(target.centerX, [size, -0.5]), relu(sum(thumbnailCenterY, [size, -0.5])), size, size)
    return {...box, opacity: visibleScale, focused: target.focused}
  }
  const controlTop = relu(sum(gap, [main.height, 0.5], [controlSize, -0.5]))
  const controlInset = scale(gap, 0.5)
  const previousControl = rect(controlInset, controlTop, controlSize, controlSize)
  const nextControl = rect(relu(sum(viewport.x, [controlInset, -1], [controlSize, -1])), controlTop, controlSize, controlSize)
  return {viewport, present, gridLeft, gridTop, gridWidth, gridHeight, main, previousControl, nextControl, thumbnailTargets, projectThumbnail}
}

// One click at a local point, when `gate` is 1. With no photo open, a click on a
// grid cell opens that photo. In the lightbox, one click picks previous, next, a
// thumbnail, or the main image, in that priority order, and a click on none of
// them closes the lightbox.
export function photoClick($: Notation, layout: PhotoLayout, focus: readonly Wire[], gate: Wire, click: Vec2): Wire[] {
  const {sum, mul, min, not, assume, separableHit, intervalHit} = $
  invariant(focus.length === photoCount, 'photo focus needs one bit per photo')
  const {gridLeft, gridTop, gridWidth, gridHeight, main} = layout
  const columnHit = gridLeft.map(left => intervalHit(click.x, left, gridWidth))
  const rowHit = gridTop.map(top => intervalHit(click.y, top, gridHeight))
  const gridHit = list(photoCount, item => min(columnHit[item % columnCount]!, rowHit[Math.floor(item / columnCount)]!))
  const focusMass = assume(sum(...focus), 0, 1)
  const thumbnailHit = layout.thumbnailTargets(focus, focusMass).map(target => separableHit(click, layout.projectThumbnail(target)))
  const controlHit = (control: Rect) => min(intervalHit(click.x, control.left, control.width), intervalHit(click.y, control.top, control.height))
  const mainHit = separableHit(click, main)
  const gridGate = mul(gate, not(focusMass))
  const lightboxGate = assume(mul(gate, focusMass), 0, 1)
  const [previousClick, nextClick, ...surfaceClicks] = $.firstActive(lightboxGate, [controlHit(layout.previousControl), controlHit(layout.nextControl), ...thumbnailHit, mainHit])
  const keep = sum(not(gate), surfaceClicks[photoCount]!)
  return list(photoCount, item => assume(sum(
    mul(keep, focus[item]!),
    mul(gridGate, gridHit[item]!),
    surfaceClicks[item]!,
    mul(previousClick!, focus[(item + 1) % photoCount]!),
    mul(nextClick!, focus[(item + photoCount - 1) % photoCount]!),
  ), 0, 1))
}

// A run of key presses between two clicks, folded: ArrowRight moves the open
// photo forward, ArrowLeft back, Escape closes the lightbox. Escape clears the
// focus, and next or previous with no photo open do nothing, so the whole run
// is "clear if any Escape, otherwise rotate by rights minus lefts". The rotation
// is an integer in -maximumKeys..maximumKeys; its one-hot reads the rotated
// focus through gathers.
export function photoKeys($: Notation, focus: readonly Wire[], rotation: {oneHot: readonly Wire[], low: number}, clear: Wire): Wire[] {
  const {mul, not, assume, circuit} = $
  const keep = not(clear)
  return list(photoCount, item => {
    const candidates = rotation.oneHot.map((_, position) => focus[mod(item - (rotation.low + position), photoCount)]!)
    const rotated = circuit.roundAffine(rotation.oneHot.map((bit, position) => [circuit.multiply(candidates[position]!, bit), 1] as const))
    return assume(mul(keep, assume(rotated, 0, 1)), 0, 1)
  })
}

// category: behavior
export function cyclicOffset(item: number, focused: number) {
  let offset = item - focused
  if (offset > photoCount / 2) offset -= photoCount
  if (offset < -photoCount / 2) offset += photoCount
  return offset
}

const falloff = (distance: number) => Math.max(0, 1 - 0.22 * distance)

export function falloffMass() {
  let mass = falloff(0)
  for (let distance = 1; distance < 5; distance++) mass += 2 * falloff(distance)
  return mass
}

// The trapezoid integral of the falloff, so neighbors spread apart smoothly.
export function spreadAt(distance: number) {
  let spread = 0
  for (let step = 1; step <= distance; step++) spread += (falloff(step - 1) + falloff(step)) / 2
  return spread
}

function mod(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus
}

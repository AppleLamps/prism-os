// Photos as a component: its own cells, allocated in whatever table hosts it,
// and a build function that reads the host's wires as inputs. Rewrites
// photo-gallery.ts (createPhotoGalleryCircuit) with the same operations in the
// same order.
import type {Wire} from '../../../numeric-ui-core.ts'
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
export const photoCells = {
  gap: constant(18, smallPixel),
  mainInset: constant(92, smallPixel),
  thumbnailHeight: constant(82, smallPixel),
  controlSize: constant(52, smallPixel),
  clickActive: event(),
  clickX: input(anyNumber),
  clickY: input(anyNumber),
  previousActive: event(),
  nextActive: event(),
  closeActive: event(),
  focus: oneHot(list(photoCount, () => bit()), {allowAllZero: true, declareToCircuit: false}),
  thumbnails: list(photoCount, () => ({
    centerX: state(pixel),
    centerXVelocity: state(anyNumber),
    scale: state(unitInterval),
    scaleVelocity: state(anyNumber),
  })),
}
export type PhotoCells = Allocated<typeof photoCells>
export type PhotoInputs = {viewport: Vec2, present: Wire, interactive: Wire, springs: SpringParams}

export function declarePhotoRules(table: SourceTable, cells: PhotoCells) {
  table.atMostOne('photos events', [cells.clickActive, cells.previousActive, cells.nextActive, cells.closeActive])
}

// category: validation
// The runtime half of the input contracts: the host checks the wires it passed
// in after every evaluation, with the rules photo-gallery.ts applies to its own
// source table. The spring constants are source cells, so the table checks them.
export const photoInputContract = {viewport: nonNegative, present: [-1e-5, 1 + 1e-5], interactive: exactBit, springs: {timestep: nonNegative}} as const

// category: behavior
export function buildPhotos($: Notation, table: SourceTable, cells: PhotoCells, inputs: PhotoInputs) {
  const {sum, scale, relu, mul, min, max, assume, lookup, separableHit, intervalHit, select, rect, zero, unit} = $
  const {gap, controlSize, focus} = cells
  const {viewport, present, interactive, springs} = inputs
  const click = $.vec2(cells.clickX, cells.clickY)
  // Input contracts: the host's wires must honor the ranges Photos assumes.
  assume(viewport.x, ...pixel)
  assume(viewport.y, ...pixel)
  assume(present, 0, 1)
  assume(interactive, 0, 1)
  for (const wire of Object.values(springs)) assume(wire, 0, Number.POSITIVE_INFINITY)

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
  // Offsets, distances, and spread from the focused photo are build-time
  // constants in the weights over the focus bits.
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

  const nextFocusMass = assume(sum(...nextFocus), 0, 1)
  const nextGridMass = sum([nextFocusMass, -1], bias(1))
  const gridLeftShown = gridLeft.map(left => mul(nextGridMass, left))
  const gridTopShown = gridTop.map(top => mul(nextGridMass, top))
  const gridWidthShown = mul(nextGridMass, gridWidth)
  const gridHeightShown = mul(nextGridMass, gridHeight)
  const targets = thumbnailTargets(nextFocus, nextFocusMass)
  // Thumbnails animate only when the lightbox was open before and after this frame.
  const animateThumbnails = mul(previousFocusMass, nextFocusMass)
  const snapThumbnails = sum([animateThumbnails, -1], bias(1))
  const animationTerms: Wire[] = []
  const thumbnails = targets.map((target, item) => {
    const stored = cells.thumbnails[item]!
    const centerSpring = $.spring(stored.centerX, stored.centerXVelocity, target.centerX, springs)
    const scaleSpring = $.spring(stored.scale, stored.scaleVelocity, target.scale, springs)
    const centerX = select(snapThumbnails, min(max(zero, centerSpring.position), viewport.x), target.centerX)
    const thumbnailScale = select(snapThumbnails, min(max(zero, scaleSpring.position), unit), target.scale)
    table.next(stored, {
      centerX,
      centerXVelocity: select(snapThumbnails, centerSpring.velocity, zero),
      scale: thumbnailScale,
      scaleVelocity: select(snapThumbnails, scaleSpring.velocity, zero),
    })
    const projection = projectThumbnail({centerX, scale: thumbnailScale, focused: target.focused})
    animationTerms.push(mul(animateThumbnails, centerSpring.active), mul(animateThumbnails, scaleSpring.active))
    return projection
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
  return {
    backdropOpacity: lightboxOpacity,
    animationActive,
    photos,
    thumbnails,
    previousControl: {...previousControl, opacity: lightboxOpacity},
    nextControl: {...nextControl, opacity: lightboxOpacity},
  }
}
export type PhotoOutputs = ReturnType<typeof buildPhotos>

// category: behavior
function cyclicOffset(item: number, focused: number) {
  let offset = item - focused
  if (offset > photoCount / 2) offset -= photoCount
  if (offset < -photoCount / 2) offset += photoCount
  return offset
}

const falloff = (distance: number) => Math.max(0, 1 - 0.22 * distance)

function falloffMass() {
  let mass = falloff(0)
  for (let distance = 1; distance < 5; distance++) mass += 2 * falloff(distance)
  return mass
}

// The trapezoid integral of the falloff, so neighbors spread apart smoothly.
function spreadAt(distance: number) {
  let spread = 0
  for (let step = 1; step <= distance; step++) spread += (falloff(step - 1) + falloff(step)) / 2
  return spread
}

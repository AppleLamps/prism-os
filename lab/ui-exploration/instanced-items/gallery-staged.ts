// chenglou.github.io's photo gallery render path as a staged program: the same
// behavior as gallery-circuit.ts (the duplicated circuit from
// lab/ui-exploration/gallery), with each per-photo section written once as a
// map stage and every loop across photos written as a reduction.
//
// Section by section against gallery-circuit.ts:
// - pointer, keys, focus arithmetic, column count, scroll, anchor and clock stay
//   shared stages with the same constructions;
// - the click hit test, sizes, grid targets, destinations, the anchor predicate,
//   springs and occlusion become map stages over photos;
// - the click tournament becomes firstActive, the row maxima groupMax, the row
//   tops and strip lefts prefixSum, the hover and animation counts sum, and the
//   reads at the focus and the anchor gatherAt.
//
// What changes because a map stage is written once:
// - Each photo's constants (its width, aspect ratio, row and column for every
//   column count) are per-instance constants, read by products or gathers
//   instead of being weights. For example the 2D width is
//   min(boxMaxSizeX × widthFactor, w) with widthFactor a per-photo constant.
// - The focus one-hot comes from each photo comparing its own index with the
//   new focused index: [d = 0] for d = newIndex - index, as relu(d + 1) -
//   2 relu(d) + relu(d - 1). gallery-circuit.ts builds one shared chain of ramps.
// - The prefix sums add the gap into each value first (width + 52), where
//   gallery-circuit.ts adds 52 × k as the bias of each row. Both are exact
//   integers only when the widths are, so positions drift apart by FP32
//   rounding.
import {Circuit, type Wire} from '../../../numeric-ui-core.ts'
import {galleryConstants, springNames, type SpringName} from './gallery-circuit.ts'
import {
  aboveZero,
  atLeastZero,
  atMostZero,
  belowZero,
  emitAll,
  emitAnd,
  emitAny,
  emitGated,
  emitGather,
  emitIntegerAtLeastZero,
  emitSaturateCount,
  emitSpring,
  emitSpringBank,
  emitStepMatrix,
  type SpringBank,
  type SpringProducts,
  type WireMatrix,
} from './kit.ts'
import type {PhotoData} from './photo-data.ts'
import {type InstanceArray, type PrefixOrder, StagedProgram, type Value} from './staged.ts'

export type StagedGalleryOptions = {
  prefixOrder?: PrefixOrder
  coordinateLimit?: number
  springProducts?: SpringProducts
  // See StagedProgram's constructor. True by default.
  rebuildSmallAffines?: boolean
}

export const sharedCellNames = [
  'windowSizeX', 'windowSizeY', 'scrollX', 'scrollY', 'reducedMotion', 'focusedIndex', 'focusedPresent',
  'keyEscape', 'keyArrowLeft', 'keyArrowRight', 'clickActive', 'clickX', 'clickY', 'clickOnPrompt',
  'moveActive', 'moveX', 'moveY', 'frameDuration', 'pointerX', 'pointerY', 'pointerPresent', 'anchor',
  'previousWindowSizeX', 'committedScrollY', 'leftoverMilliseconds', 'animating',
] as const
export type SharedCellName = typeof sharedCellNames[number]

export const sharedOutputNames = [
  'newFocusedIndex', 'newFocusedPresent', 'focusChanged', 'adjustedScrollTop', 'scrollChanged', 'cursorZoomIn',
  'cursorZoomOut', 'placeholderHeight', 'stillAnimating', 'selectPrompt', 'columns', 'steps',
] as const
export type SharedOutputName = typeof sharedOutputNames[number]

export const photoOutputNames = ['visible', 'focused', 'blurred', 'sizeX', 'sizeY', 'x', 'y', 'scale', 'fxFactor', 'destX', 'destY', 'destSizeX', 'destSizeY'] as const
export type PhotoOutputName = typeof photoOutputNames[number]

export const springFields = ['displacement', 'velocity', 'destination'] as const
export type SpringField = typeof springFields[number]

export function buildStagedGallery(photos: readonly PhotoData[], options: StagedGalleryOptions = {}) {
  const count = photos.length
  const K = galleryConstants
  const prefixOrder = options.prefixOrder ?? 'sequential'
  const program = new StagedProgram({rebuildSmallAffines: options.rebuildSmallAffines})
  const viewportLimit = 16384
  const coordinateLimit = options.coordinateLimit ?? 2 ** 22
  const pointerLimit = 2 ** 16
  const velocityLimit = 2 ** 26
  const maximumColumns = K.maximumColumns

  const cell = (name: SharedCellName, minimum: number, maximum: number) => program.sharedCell(name, minimum, maximum)
  const cells = {
    windowSizeX: cell('windowSizeX', 0, viewportLimit),
    windowSizeY: cell('windowSizeY', 0, viewportLimit),
    scrollX: cell('scrollX', -coordinateLimit, coordinateLimit),
    scrollY: cell('scrollY', -coordinateLimit, coordinateLimit),
    reducedMotion: cell('reducedMotion', 0, 1),
    focusedIndex: cell('focusedIndex', 0, count - 1),
    focusedPresent: cell('focusedPresent', 0, 1),
    keyEscape: cell('keyEscape', 0, 1),
    keyArrowLeft: cell('keyArrowLeft', 0, 1),
    keyArrowRight: cell('keyArrowRight', 0, 1),
    clickActive: cell('clickActive', 0, 1),
    clickX: cell('clickX', -pointerLimit, pointerLimit),
    clickY: cell('clickY', -pointerLimit, pointerLimit),
    clickOnPrompt: cell('clickOnPrompt', 0, 1),
    moveActive: cell('moveActive', 0, 1),
    moveX: cell('moveX', -pointerLimit, pointerLimit),
    moveY: cell('moveY', -pointerLimit, pointerLimit),
    frameDuration: cell('frameDuration', 0, 2 ** 30),
    pointerX: cell('pointerX', -pointerLimit, pointerLimit),
    pointerY: cell('pointerY', -pointerLimit, pointerLimit),
    pointerPresent: cell('pointerPresent', 0, 1),
    anchor: cell('anchor', 0, count - 1),
    previousWindowSizeX: cell('previousWindowSizeX', 0, viewportLimit),
    committedScrollY: cell('committedScrollY', -coordinateLimit, coordinateLimit),
    leftoverMilliseconds: cell('leftoverMilliseconds', 0, 4),
    animating: cell('animating', 0, 1),
  } satisfies Record<SharedCellName, Value>

  const items = program.array('photos', count)
  const state = {} as Record<SpringName, Record<SpringField, Value>>
  for (const name of springNames) {
    state[name] = {
      displacement: items.cell(`${name}.displacement`, -coordinateLimit, coordinateLimit),
      velocity: items.cell(`${name}.velocity`, -velocityLimit, velocityLimit),
      destination: items.cell(`${name}.destination`, -coordinateLimit, coordinateLimit),
    }
  }
  const ratio = (photo: PhotoData) => photo.w / photo.h
  const photoConstant = (name: string, value: (photo: PhotoData, index: number) => number) => items.constant(name, photos.map(value))
  const index = photoConstant('index', (_, position) => position)
  const width = photoConstant('width', photo => photo.w)
  const widthFactor = photoConstant('widthFactor', photo => {
    const ar = ratio(photo)
    const factor = ar === 1 ? 0.85 : ar < 1 ? 1.05 : 1
    return Math.min(1, factor * ar)
  })
  const inverseAspect = photoConstant('inverseAspect', photo => 1 / ratio(photo))
  const aspect = photoConstant('aspect', ratio)
  const heightOverWidth = photoConstant('heightOverWidth', photo => photo.h / photo.w)
  const columnCounts = Array.from({length: maximumColumns}, (_, position) => position + 1)
  const rowCounts = columnCounts.map(columnCount => Math.ceil(count / columnCount))
  const rowOf = columnCounts.map(columnCount => photoConstant(`row for ${columnCount} columns`, (_, position) => Math.floor(position / columnCount)))
  const columnOf = columnCounts.map(columnCount => photoConstant(`column for ${columnCount} columns`, (_, position) => position % columnCount))
  // A row start in any row but the last, for the anchor search.
  const rowStartOf = columnCounts.map((columnCount, variant) => photoConstant(`row start for ${columnCount} columns`, (_, position) =>
    position % columnCount === 0 && Math.floor(position / columnCount) < rowCounts[variant]! - 1 ? 1 : 0))
  const rows: InstanceArray[] = columnCounts.map((columnCount, variant) => program.array(`rows for ${columnCount} columns`, rowCounts[variant]!))

  // === pointer: index.ts:236-247, 265
  const pointer = program.shared('pointer', {
    moveActive: cells.moveActive, clickActive: cells.clickActive, pointerX: cells.pointerX, pointerY: cells.pointerY,
    clickX: cells.clickX, clickY: cells.clickY, moveX: cells.moveX, moveY: cells.moveY, pointerPresent: cells.pointerPresent,
    scrollX: cells.scrollX, scrollY: cells.scrollY,
  }, (circuit, input) => {
    const x = circuit.select(input.moveActive, circuit.select(input.clickActive, input.pointerX, input.clickX), input.moveX)
    const y = circuit.select(input.moveActive, circuit.select(input.clickActive, input.pointerY, input.clickY), input.moveY)
    const present = emitAny(circuit, [], {bits: [input.pointerPresent, input.clickActive, input.moveActive]})
    const localX = circuit.roundAffine([[x, 1], [input.scrollX, 1]])
    const localY = circuit.roundAffine([[y, 1], [input.scrollY, 1]])
    return {x, y, present, localX, localY}
  })

  // === keys and the strip's click regions: index.ts:269-289
  const keys = program.shared('keys', {
    focusedIndex: cells.focusedIndex, focusedPresent: cells.focusedPresent, keyEscape: cells.keyEscape,
    keyArrowLeft: cells.keyArrowLeft, keyArrowRight: cells.keyArrowRight, clickActive: cells.clickActive,
    clickOnPrompt: cells.clickOnPrompt, localX: pointer.localX, windowSizeX: cells.windowSizeX,
  }, (circuit, input) => {
    const atLeastOne = emitIntegerAtLeastZero(circuit, [[input.focusedIndex, 1]], -1)
    const atMostSecondLast = emitIntegerAtLeastZero(circuit, [[input.focusedIndex, -1]], count - 2)
    const atLast = emitIntegerAtLeastZero(circuit, [[input.focusedIndex, 1]], -(count - 1))
    const moveLeft = emitAnd(circuit, [input.keyArrowLeft, input.focusedPresent, atLeastOne])
    const moveRight = emitAnd(circuit, [input.keyArrowRight, input.focusedPresent, atMostSecondLast])
    const keyPresent = circuit.affine([
      [input.keyArrowLeft, 1], [input.keyArrowRight, 1],
      [emitAnd(circuit, [input.focusedPresent], [input.keyEscape, input.keyArrowLeft, input.keyArrowRight]), 1],
    ])
    circuit.assumeRange(keyPresent, 0, 1)
    const keyIndex = emitGated(circuit, [[input.focusedIndex, 1], [moveLeft, -1], [moveRight, 1]], 0, keyPresent)
    const gate2D = emitAnd(circuit, [input.clickActive], [input.clickOnPrompt, input.focusedPresent])
    const gate1D = emitAnd(circuit, [input.clickActive, input.focusedPresent], [input.clickOnPrompt])
    const beyondLeftRegion = circuit.roundAffine([[input.localX, 1]], -K.hitArea1DSizeX)
    const intoRightRegion = circuit.roundAffine([[input.localX, 1], [input.windowSizeX, -1]], K.hitArea1DSizeX)
    const leftRegion = emitAll(circuit, [atLeastZero(input.localX), atMostZero(beyondLeftRegion)], {bits: [atLeastOne]})
    const rightRegion = emitAll(circuit, [atLeastZero(intoRightRegion)], {bits: [atMostSecondLast], forbidden: [leftRegion]})
    const present1D = circuit.affine([[leftRegion, 1], [rightRegion, 1]])
    const index1D = emitGated(circuit, [[input.focusedIndex, 1], [leftRegion, -1], [rightRegion, 1]], 0, present1D)
    return {atLeastOne, atLast, keyPresent, keyIndex, gate2D, gate1D, present1D, index1D}
  })

  // === 2D click: the first box whose previous destination contains the pointer (hitTest2DMode)
  const hit = program.map(items, 'click hit test', {
    localX: pointer.localX, localY: pointer.localY,
    x: state.x.destination, sizeX: state.sizeX.destination, y: state.y.destination, sizeY: state.sizeY.destination,
  }, (circuit, input) => ({
    bit: emitAll(circuit, [
      atLeastZero(circuit.roundAffine([[input.localX, 1], [input.x, -1]])),
      aboveZero(circuit.roundAffine([[input.x, 1], [input.sizeX, 1], [input.localX, -1]])),
      atLeastZero(circuit.roundAffine([[input.localY, 1], [input.y, -1]])),
      aboveZero(circuit.roundAffine([[input.y, 1], [input.sizeY, 1], [input.localY, -1]])),
    ], {booleanAtom: true}),
  }))
  const click = program.firstActive(hit.bit, keys.gate2D, 'click selection')

  // === new focus from keys and clicks: index.ts:216-228, 269-289
  const focus = program.shared('focus', {
    keyIndex: keys.keyIndex, keyPresent: keys.keyPresent, gate2D: keys.gate2D, gate1D: keys.gate1D,
    present1D: keys.present1D, index1D: keys.index1D, hitIndex: click.index, hitPresent: click.present,
    focusedIndex: cells.focusedIndex, focusedPresent: cells.focusedPresent,
  }, (circuit, input) => {
    const index2D = circuit.affine([[input.hitIndex, 1], [circuit.reglu([[input.keyIndex, 1]], 0, [[input.hitPresent, -1]], 1), 1]])
    const present2D = emitAny(circuit, [], {bits: [input.keyPresent, input.hitPresent]})
    const newIndex = circuit.roundAffine([
      [input.keyIndex, 1],
      [circuit.reglu([[index2D, 1], [input.keyIndex, -1]], 0, [[input.gate2D, 1]], 0), 1],
      [circuit.reglu([[input.index1D, 1], [input.keyIndex, -1]], 0, [[input.gate1D, 1]], 0), 1],
    ])
    const newPresent = circuit.roundAffine([
      [input.keyPresent, 1],
      [circuit.reglu([[present2D, 1], [input.keyPresent, -1]], 0, [[input.gate2D, 1]], 0), 1],
      [circuit.reglu([[input.present1D, 1], [input.keyPresent, -1]], 0, [[input.gate1D, 1]], 0), 1],
    ])
    circuit.assumeRange(newIndex, 0, count - 1)
    circuit.assumeRange(newPresent, 0, 1)
    const difference = (a: Wire, b: Wire) => [
      [circuit.reglu([], 1, [[a, 1], [b, -1]], 0), 1],
      [circuit.reglu([], 1, [[b, 1], [a, -1]], 0), 1],
    ] as const
    const changed = emitSaturateCount(circuit, circuit.affine([...difference(newIndex, input.focusedIndex), ...difference(newPresent, input.focusedPresent)]))
    return {newIndex, newPresent, changed}
  })

  // === column count and box width: index.ts:83-91; strip maxima: index.ts:358-362
  const columns = program.shared('column count', {windowSizeX: cells.windowSizeX, windowSizeY: cells.windowSizeY}, (circuit, input) => {
    const atLeast: Wire[] = []
    for (let columnCount = 2; columnCount <= maximumColumns; columnCount++) {
      atLeast[columnCount] = emitIntegerAtLeastZero(circuit, [[input.windowSizeX, 1]], -(K.boxesGapX + (K.boxMinSizeX + K.boxesGapX) * columnCount))
    }
    const oneHot: Wire[] = []
    for (let columnCount = 1; columnCount <= maximumColumns; columnCount++) {
      const member = columnCount === 1
        ? circuit.affine([[atLeast[2]!, -1]], 1)
        : columnCount === maximumColumns
          ? atLeast[columnCount]!
          : circuit.affine([[atLeast[columnCount]!, 1], [atLeast[columnCount + 1]!, -1]])
      circuit.assumeRange(member, 0, 1)
      oneHot.push(member)
    }
    circuit.assumeOneHot(oneHot)
    const widths = oneHot.map((_, position) => {
      const columnCount = position + 1
      return circuit.roundAffine([[input.windowSizeX, 1 / columnCount]], -K.boxesGapX * (columnCount + 1) / columnCount)
    })
    const selectedWidth = emitGather(circuit, oneHot, widths)
    const boxMaxSizeX = circuit.affine([[circuit.reglu([], 1, [[selectedWidth, 1]], -1), 1]], 1)
    circuit.assumeRange(boxMaxSizeX, 1, viewportLimit)
    const value = circuit.affine(oneHot.map((member, position) => [member, position + 1] as const))
    const box1DMaxSizeX = circuit.affine([[circuit.reglu([], 1, [[input.windowSizeX, 1]], -(2 * K.boxes1DGapX + 2 * K.hitArea1DSizeX + 1)), 1]], 1)
    const maximumY = circuit.affine([[circuit.reglu([], 1, [[input.windowSizeY, 1]], -(K.windowPaddingTop + K.prompt1DSizeY + K.boxes1DGapY + 1)), 1]], 1)
    return {oneHot, boxMaxSizeX, value, box1DMaxSizeX, maximumY}
  })

  // === 2D sizes (index.ts:296-305), strip widths (index.ts:358-386), and each photo against the new focus
  const largestWidth = Math.max(...photos.map(photo => photo.w))
  const sizes = program.map(items, 'sizes and focus relation', {
    boxMaxSizeX: columns.boxMaxSizeX, box1DMaxSizeX: columns.box1DMaxSizeX, maximumY: columns.maximumY,
    newIndex: focus.newIndex, newPresent: focus.newPresent,
    width, widthFactor, inverseAspect, aspect, heightOverWidth, index,
  }, (circuit, input) => {
    const scaled = circuit.multiply(input.boxMaxSizeX, input.widthFactor)
    const sizeX2D = circuit.affine([[scaled, 1], [circuit.reglu([], 1, [[scaled, 1], [input.width, -1]], 0), -1]])
    circuit.assumeRange(sizeX2D, 0, largestWidth)
    const sizeY2D = circuit.roundAffine([[circuit.multiply(sizeX2D, input.inverseAspect), 1]], K.promptSizeY)
    circuit.assumeRange(sizeY2D, 0, coordinateLimit)

    const cappedByBox = circuit.affine([[input.box1DMaxSizeX, 1], [circuit.reglu([], 1, [[input.box1DMaxSizeX, 1], [input.width, -1]], 0), -1]])
    circuit.assumeRange(cappedByBox, 0, largestWidth)
    const tallest = circuit.multiply(input.maximumY, input.aspect)
    const base = circuit.affine([[cappedByBox, 1], [circuit.reglu([], 1, [[cappedByBox, 1], [tallest, -1]], 0), -1]])
    circuit.assumeRange(base, 0, largestWidth)
    const unfocusedWidth = circuit.affine([[base, 0.7]])
    const stripStep = circuit.roundAffine([[unfocusedWidth, 1]], K.boxes1DGapX)

    // d = newIndex - index. Integers, so every ramp below is exact.
    const ramp = (offset: number) => circuit.reglu([], 1, [[input.newIndex, 1], [input.index, -1]], offset)
    const equal = (offset: number) => circuit.affine([[ramp(1 - offset), 1], [ramp(-offset), -2], [ramp(-1 - offset), 1]])
    const member = emitAnd(circuit, [equal(0), input.newPresent])
    // [index < newIndex] and [index > newIndex], both 0 without a focus.
    const before = circuit.affine([[ramp(0), 1], [ramp(-1), -1]])
    circuit.assumeRange(before, 0, 1)
    const atOrBeforeFocus = circuit.affine([[ramp(1), 1], [ramp(0), -1]])
    circuit.assumeRange(atOrBeforeFocus, 0, 1)
    const after = emitAnd(circuit, [input.newPresent], [atOrBeforeFocus])
    const blurred = emitAnd(circuit, [circuit.affine([[equal(-1), 1], [equal(0), 1], [equal(1), 1]]), input.newPresent])
    const stripSizeX = circuit.affine([[base, 0.7], [emitGated(circuit, [[base, 0.3]], 0, member), 1]])
    const stripSizeY = circuit.roundAffine([[circuit.multiply(stripSizeX, input.heightOverWidth), 1]], K.prompt1DSizeY)
    circuit.assumeRange(stripSizeY, 0, coordinateLimit)
    return {sizeX2D, sizeY2D, base, stripStep, stripSizeX, stripSizeY, member, before, after, blurred, focusedNext: equal(1), focusedPrevious: equal(-1)}
  })

  // === rows for each column count: index.ts:293-312 and 329-334
  const rowTops: Value[] = []
  const rowCenters: Value[] = []
  const rowTotals: Value[] = []
  columnCounts.forEach((columnCount, variant) => {
    const rowArray = rows[variant]!
    const maximum = program.groupMax(sizes.sizeY2D, rowArray, rowOf[variant]!, `row maxima, ${columnCount} columns`)
    const step = program.map(rowArray, `row step, ${columnCount} columns`, {maximum}, (circuit, input) => ({step: circuit.roundAffine([[input.maximum, 1]], K.boxesGapY)}))
    const tops = program.prefixSum(step.step, `row tops, ${columnCount} columns`, {bias: K.windowPaddingTop, order: prefixOrder})
    const center = program.map(rowArray, `row centers, ${columnCount} columns`, {top: tops.before, maximum}, (circuit, input) => ({center: circuit.roundAffine([[input.top, 1], [input.maximum, 0.5]])}))
    const back = program.gatherIndexed({top: tops.before, center: center.center}, items, rowOf[variant]!, `row values back to photos, ${columnCount} columns`)
    rowTops.push(back.top)
    rowCenters.push(back.center)
    rowTotals.push(tops.total)
  })

  // === 2D destinations and hover on the new targets: index.ts:326-347
  const grid = program.map(items, 'grid targets and hover', {
    localX: pointer.localX, localY: pointer.localY, present: pointer.present, boxMaxSizeX: columns.boxMaxSizeX,
    oneHot: columns.oneHot, sizeX: sizes.sizeX2D, sizeY: sizes.sizeY2D,
    columnOf, rowCenters, rowTops, rowStartOf,
  }, (circuit, input) => {
    const column = emitGather(circuit, input.oneHot, input.columnOf)
    const cellCenter = circuit.reglu([[column, 1]], 0.5, [[input.boxMaxSizeX, 1]], 0)
    const centerX = circuit.roundAffine([[cellCenter, 1], [column, K.boxesGapX]], K.boxesGapX)
    const centerY = emitGather(circuit, input.oneHot, input.rowCenters)
    const hovered = emitAll(circuit, [
      atLeastZero(circuit.roundAffine([[input.localX, 1], [centerX, -1], [input.sizeX, 0.5]])),
      aboveZero(circuit.roundAffine([[centerX, 1], [input.sizeX, 0.5], [input.localX, -1]])),
      atLeastZero(circuit.roundAffine([[input.localY, 1], [centerY, -1], [input.sizeY, 0.5]])),
      aboveZero(circuit.roundAffine([[centerY, 1], [input.sizeY, 0.5], [input.localY, -1]])),
    ], {bits: [input.present], booleanAtom: true})
    return {centerX, centerY, hovered, rowTop: emitGather(circuit, input.oneHot, input.rowTops), rowStart: emitGather(circuit, input.oneHot, input.rowStartOf)}
  })
  const gridHoverCount = program.countBits(grid.hovered, 'grid hover count')

  // === strip lefts: prefix sums of unfocused widths plus gaps, read at the focus
  const strip = program.prefixSum(sizes.stripStep, 'strip lefts', {order: prefixOrder})
  const stripAtFocus = program.gatherAt(strip.before, focus.newIndex, 'strip left at the focus', focus.newPresent)
  const stripAfterFocus = program.gatherAt(strip.through, focus.newIndex, 'strip left after the focus', focus.newPresent)

  // === strip hover regions and the cursor: index.ts:317-347
  const hover = program.shared('strip hover and cursor', {
    localX: pointer.localX, present: pointer.present, windowSizeX: cells.windowSizeX,
    newIndex: focus.newIndex, newPresent: focus.newPresent, gridHoverCount,
  }, (circuit, input) => {
    const newAtLeastOne = emitIntegerAtLeastZero(circuit, [[input.newIndex, 1]], -1)
    const newAtLast = emitIntegerAtLeastZero(circuit, [[input.newIndex, 1]], -(count - 1))
    const leftHover = emitAll(circuit, [atLeastZero(input.localX), atMostZero(circuit.roundAffine([[input.localX, 1]], -K.hitArea1DSizeX))], {bits: [input.present, newAtLeastOne]})
    const notLast = circuit.affine([[input.newPresent, 1], [newAtLast, -1]])
    const rightHover = emitAll(circuit, [atLeastZero(circuit.roundAffine([[input.localX, 1], [input.windowSizeX, -1]], K.hitArea1DSizeX))], {bits: [input.present, notLast], forbidden: [leftHover]})
    const anyGridHover = emitSaturateCount(circuit, input.gridHoverCount)
    const cursorZoomIn = circuit.affine([[emitAnd(circuit, [anyGridHover], [input.newPresent]), 1], [leftHover, 1], [rightHover, 1]])
    const cursorZoomOut = circuit.affine([[input.newPresent, 1], [leftHover, -1], [rightHover, -1]])
    return {leftHover, rightHover, cursorZoomIn: circuit.roundAffine([[cursorZoomIn, 1]]), cursorZoomOut: circuit.roundAffine([[cursorZoomOut, 1]])}
  })

  // === mode select, strip hover, magnet, destinations: index.ts:317-398
  const destinations = program.map(items, 'destinations', {
    localX: pointer.localX, localY: pointer.localY, windowSizeX: cells.windowSizeX, windowSizeY: cells.windowSizeY, scrollY: cells.scrollY,
    newPresent: focus.newPresent, leftHover: hover.leftHover, rightHover: hover.rightHover,
    stripAtFocus, stripAfterFocus, stripBefore: strip.before,
    centerX: grid.centerX, centerY: grid.centerY, hovered2D: grid.hovered,
    sizeX: sizes.sizeX2D, sizeY: sizes.sizeY2D, base: sizes.base, stripSizeX: sizes.stripSizeX, stripSizeY: sizes.stripSizeY,
    member: sizes.member, before: sizes.before, after: sizes.after, focusedNext: sizes.focusedNext, focusedPrevious: sizes.focusedPrevious,
  }, (circuit, input) => {
    const stripY = circuit.affine([[circuit.reglu([], 1, [[input.windowSizeY, 0.5], [input.stripSizeY, -0.5]], -K.windowPaddingTop), 1], [input.scrollY, 1]], K.windowPaddingTop)
    const gridX: [Wire, number][] = [[input.centerX, 1], [input.sizeX, -0.5]]
    const gridY: [Wire, number][] = [[input.centerY, 1], [input.sizeY, -0.5]]
    const negate = (terms: [Wire, number][]) => terms.map(([wire, coefficient]) => [wire, -coefficient] as [Wire, number])
    const startLeft = K.hitArea1DSizeX + K.boxes1DGapX
    const x = circuit.affine([
      ...gridX,
      [emitGated(circuit, [[input.stripBefore, 1], [input.stripAtFocus, -1], ...negate(gridX)], startLeft, input.before), 1],
      [emitGated(circuit, [[input.windowSizeX, 0.5], [input.base, -0.5], ...negate(gridX)], 0, input.member), 1],
      [emitGated(circuit, [[input.windowSizeX, 1], [input.stripBefore, 1], [input.stripAfterFocus, -1], ...negate(gridX)], -K.hitArea1DSizeX, input.after), 1],
    ])
    const y = circuit.affine([...gridY, [emitGated(circuit, [[stripY, 1], ...negate(gridY)], 0, input.newPresent), 1]])
    const sizeX = circuit.affine([[input.sizeX, 1], [emitGated(circuit, [[input.stripSizeX, 1], [input.sizeX, -1]], 0, input.newPresent), 1]])
    const sizeY = circuit.affine([[input.sizeY, 1], [emitGated(circuit, [[input.stripSizeY, 1], [input.sizeY, -1]], 0, input.newPresent), 1]])
    // index.ts:382-394: hovering the strip's left region highlights the photo before the focus.
    const stripHovered = circuit.affine([[emitAnd(circuit, [input.leftHover, input.focusedNext]), 1], [emitAnd(circuit, [input.rightHover, input.focusedPrevious]), 1]])
    const hovered = circuit.affine([[emitAnd(circuit, [input.hovered2D], [input.newPresent]), 1], [stripHovered, 1]])
    circuit.assumeRange(hovered, 0, 1)
    const magnet = 1 / K.hoverMagnetFactor
    const destX = circuit.roundAffine([[x, 1], [emitGated(circuit, [[input.localX, magnet], [x, -magnet], [sizeX, -magnet / 2]], 0, hovered), 1]])
    const destY = circuit.roundAffine([[y, 1], [emitGated(circuit, [[input.localY, magnet], [y, -magnet], [sizeY, -magnet / 2]], 0, hovered), 1]])
    const scale = circuit.affine([[hovered, 0.02]], 1)
    const fxFactor = circuit.affine([[input.newPresent, -0.8], [input.member, 0.8], [stripHovered, 0.3]], 1)
    return {destX, destY, destSizeX: sizeX, destSizeY: sizeY, scale, fxFactor}
  })

  // === scroll adjustment and anchor: index.ts:317-324, 348-357
  const focusedTop = program.gatherAt(grid.rowTop, cells.focusedIndex, 'row top at the old focus', cells.focusedPresent)
  const focusedSizeY = program.gatherAt(sizes.sizeY2D, cells.focusedIndex, 'height at the old focus', cells.focusedPresent)
  const anchorDestY = program.gatherAt(destinations.destY, cells.anchor, 'destination at the anchor')
  const scroll = program.shared('scroll', {
    scrollY: cells.scrollY, windowSizeX: cells.windowSizeX, windowSizeY: cells.windowSizeY, previousWindowSizeX: cells.previousWindowSizeX,
    committedScrollY: cells.committedScrollY, focusedPresent: cells.focusedPresent, newPresent: focus.newPresent,
    focusedTop, focusedSizeY, anchorDestY,
  }, (circuit, input) => {
    const dismissed = emitAnd(circuit, [input.focusedPresent], [input.newPresent])
    const notFullyShown = emitAny(circuit, [
      atMostZero(circuit.roundAffine([[input.focusedTop, 1], [input.scrollY, -1]])),
      atLeastZero(circuit.roundAffine([[input.focusedTop, 1], [input.focusedSizeY, 1], [input.scrollY, -1], [input.windowSizeY, -1]])),
    ])
    const reveal = emitAnd(circuit, [dismissed, notFullyShown])
    const afterDismiss = circuit.roundAffine([
      [input.scrollY, 1], [emitGated(circuit, [[input.focusedTop, 1], [input.scrollY, -1]], -(K.boxesGapY + K.gapTopPeek), reveal), 1],
    ])
    const resized = emitSaturateCount(circuit, circuit.affine([
      [circuit.reglu([], 1, [[input.windowSizeX, 1], [input.previousWindowSizeX, -1]], 0), 1],
      [circuit.reglu([], 1, [[input.previousWindowSizeX, 1], [input.windowSizeX, -1]], 0), 1],
    ]))
    const keepAnchor = emitAnd(circuit, [resized], [input.newPresent])
    const adjusted = circuit.roundAffine([
      [afterDismiss, 1],
      [emitGated(circuit, [[circuit.reglu([], 1, [[input.anchorDestY, 1]], -K.gapTopPeek), 1], [afterDismiss, -1]], 0, keepAnchor), 1],
    ])
    const movedSinceCommit = circuit.roundAffine([[adjusted, 1], [input.committedScrollY, -1]])
    const anchorOffset = circuit.roundAffine([[input.anchorDestY, 1], [adjusted, -1]], -K.gapTopPeek)
    const farFromAnchor = emitAny(circuit, [
      aboveZero(circuit.roundAffine([[anchorOffset, 1], [input.windowSizeY, -0.1]])),
      aboveZero(circuit.roundAffine([[anchorOffset, -1], [input.windowSizeY, -0.1]])),
    ])
    const scrollMoved = emitAny(circuit, [aboveZero(movedSinceCommit), belowZero(movedSinceCommit)])
    const search = emitAnd(circuit, [scrollMoved, farFromAnchor], [input.newPresent])
    const threshold = circuit.roundAffine([[adjusted, 1], [input.windowSizeY, 0.2]])
    const delta = circuit.roundAffine([[adjusted, 1], [input.scrollY, -1]])
    const changed = emitAny(circuit, [aboveZero(delta), belowZero(delta)])
    return {adjusted, search, threshold, delta, changed}
  })
  // The anchor search walks the leftmost column for the first box whose bottom is more than 20% of
  // the window below the scroll position. Those bottoms increase with the row, so the first match is
  // the number of rows before it: a count of predicate bits over row starts, not a loop.
  const anchorPredicate = program.map(items, 'anchor predicate', {
    destY: destinations.destY, destSizeY: destinations.destSizeY, threshold: scroll.threshold, rowStart: grid.rowStart,
  }, (circuit, input) => ({
    below: emitAll(circuit, [aboveZero(circuit.roundAffine([[input.destY, 1], [input.destSizeY, 1], [input.threshold, -1]]))], {bits: [input.rowStart], booleanAtom: true}),
  }))
  const belowCount = program.countBits(anchorPredicate.below, 'row starts below the threshold')
  const anchor = program.shared('anchor', {anchor: cells.anchor, search: scroll.search, oneHot: columns.oneHot, belowCount}, (circuit, input) => {
    const candidates = columnCounts.map((columnCount, variant) => circuit.affine([[input.belowCount, -columnCount]], columnCount * (rowCounts[variant]! - 1)))
    const found = emitGather(circuit, input.oneHot, candidates)
    const nextAnchor = circuit.roundAffine([[input.anchor, 1], [emitGated(circuit, [[found, 1], [input.anchor, -1]], 0, input.search), 1]])
    circuit.assumeRange(nextAnchor, 0, count - 1)
    return {nextAnchor}
  })

  // === the clock and the shared spring matrix: index.ts:399-407, 172-194
  const clock = program.shared('clock', {
    leftoverMilliseconds: cells.leftoverMilliseconds, frameDuration: cells.frameDuration, animating: cells.animating,
    reducedMotion: cells.reducedMotion, keyArrowLeft: cells.keyArrowLeft, keyArrowRight: cells.keyArrowRight,
    focusedPresent: cells.focusedPresent, newPresent: focus.newPresent, atLeastOne: keys.atLeastOne, atLast: keys.atLast,
  }, (circuit, input) => {
    const constants = {stiffness: K.stiffness, damping: K.damping, stepMilliseconds: K.msPerAnimationStep}
    const cap = K.msPerAnimationStep * (16 ** 3 - 1)
    const elapsedRaw = circuit.roundAffine([[input.leftoverMilliseconds, 1], [input.frameDuration, 1]])
    const capped = circuit.affine([[elapsedRaw, 1], [circuit.reglu([], 1, [[elapsedRaw, 1]], -cap), -1]])
    const elapsed = emitGated(circuit, [[capped, 1]], 0, input.animating)
    const stepMatrix = emitStepMatrix(circuit, elapsed, constants)
    const bank = emitSpringBank(circuit, stepMatrix, circuit.affine([[input.reducedMotion, -1]], 1), options.springProducts)
    const leftEdge = emitAnd(circuit, [input.keyArrowLeft, input.focusedPresent, input.newPresent], [input.atLeastOne])
    const rightEdge = emitAnd(circuit, [input.keyArrowRight, input.focusedPresent, input.atLast, input.newPresent])
    return {entries: bank.entries, leftover: stepMatrix.leftover, steps: stepMatrix.steps, leftEdge, rightEdge}
  })
  const products = options.springProducts ?? 'signed'

  // === springs (index.ts:399-407) and occlusion (index.ts:410-419)
  const springs = program.map(items, 'springs and occlusion', {
    state, entries: clock.entries, leftEdge: clock.leftEdge, rightEdge: clock.rightEdge, member: sizes.member,
    destX: destinations.destX, destY: destinations.destY, destSizeX: destinations.destSizeX, destSizeY: destinations.destSizeY,
    scale: destinations.scale, fxFactor: destinations.fxFactor, delta: scroll.delta, adjusted: scroll.adjusted,
    windowSizeX: cells.windowSizeX, windowSizeY: cells.windowSizeY,
  }, (circuit, input) => {
    const bank: SpringBank = {products, entries: input.entries as WireMatrix, offsets: [0, 0, 0, 0]}
    if (products === 'offset') throw new Error('the staged gallery keeps signed spring products')
    const actives: Wire[] = []
    const step = (name: SpringName, destination: Wire, velocity: Wire, extraTerms: readonly (readonly [Wire, number])[] = []) => {
      const spring = input.state[name]
      const displacement = circuit.roundAffine([[spring.destination, 1], [destination, -1], [spring.displacement, 1], ...extraTerms])
      const result = emitSpring(circuit, bank, displacement, velocity)
      actives.push(result.active)
      const position = circuit.roundAffine([[destination, 1], [result.displacement, 1]])
      return {position, displacement: result.displacement, velocity: result.velocity, destination}
    }
    // index.ts:381: x.v += edgeRubberBandVelocityX / (i === newFocused ? 1 : 4)
    const kickedVelocityX = circuit.roundAffine([
      [input.state.x.velocity, 1], [input.leftEdge, 500], [input.rightEdge, -500],
      [emitGated(circuit, [[input.leftEdge, 1500], [input.rightEdge, -1500]], 0, input.member), 1],
    ])
    const lanes = {
      sizeX: step('sizeX', input.destSizeX, input.state.sizeX.velocity),
      sizeY: step('sizeY', input.destSizeY, input.state.sizeY.velocity),
      x: step('x', input.destX, kickedVelocityX),
      // index.ts:400: y.pos += adjustedScrollTop - currentScrollY
      y: step('y', input.destY, input.state.y.velocity, [[input.delta, 1]]),
      scale: step('scale', input.scale, input.state.scale.velocity),
      fxFactor: step('fxFactor', input.fxFactor, input.state.fxFactor.velocity),
    }
    const visible = emitAll(circuit, [
      atLeastZero(circuit.roundAffine([[input.windowSizeY, 1], [lanes.y.position, -1], [input.adjusted, 1]], K.browserUIMaxSizeBottom)),
      atLeastZero(circuit.roundAffine([[lanes.y.position, 1], [lanes.sizeY.position, 1], [input.adjusted, -1]], K.browserUIMaxSizeTop)),
      atLeastZero(circuit.roundAffine([[input.windowSizeX, 1], [lanes.x.position, -1]])),
      atLeastZero(circuit.roundAffine([[lanes.x.position, 1], [lanes.sizeX.position, 1]])),
    ], {booleanAtom: true})
    return {lanes, activeCount: circuit.affine(actives.map(active => [active, 1] as const)), visible}
  })
  const activeCount = program.sum(springs.activeCount, 'active springs', {minimum: 0, maximum: 6 * count})

  const outputs = program.shared('outputs', {
    activeCount, clickActive: cells.clickActive, clickOnPrompt: cells.clickOnPrompt, oneHot: columns.oneHot, rowTotals,
  }, (circuit, input) => ({
    stillAnimating: emitSaturateCount(circuit, input.activeCount),
    selectPrompt: emitAnd(circuit, [input.clickActive, input.clickOnPrompt]),
    placeholderHeight: emitGather(circuit, input.oneHot, input.rowTotals),
  }))

  const sharedOutputs: Record<SharedOutputName, Value> = {
    newFocusedIndex: focus.newIndex, newFocusedPresent: focus.newPresent, focusChanged: focus.changed,
    adjustedScrollTop: scroll.adjusted, scrollChanged: scroll.changed, cursorZoomIn: hover.cursorZoomIn, cursorZoomOut: hover.cursorZoomOut,
    placeholderHeight: outputs.placeholderHeight, stillAnimating: outputs.stillAnimating, selectPrompt: outputs.selectPrompt,
    columns: columns.value, steps: clock.steps,
  }
  const photoOutputs: Record<PhotoOutputName, Value> = {
    visible: springs.visible, focused: sizes.member, blurred: sizes.blurred,
    sizeX: springs.lanes.sizeX.position, sizeY: springs.lanes.sizeY.position, x: springs.lanes.x.position, y: springs.lanes.y.position,
    scale: springs.lanes.scale.position, fxFactor: springs.lanes.fxFactor.position,
    destX: destinations.destX, destY: destinations.destY, destSizeX: destinations.destSizeX, destSizeY: destinations.destSizeY,
  }
  program.output(sharedOutputs)
  program.output(photoOutputs)

  program.next(cells.pointerX, pointer.x)
  program.next(cells.pointerY, pointer.y)
  program.next(cells.pointerPresent, pointer.present)
  program.next(cells.anchor, anchor.nextAnchor)
  program.next(cells.previousWindowSizeX, cells.windowSizeX)
  program.next(cells.committedScrollY, scroll.adjusted)
  program.next(cells.leftoverMilliseconds, clock.leftover)
  program.next(cells.animating, outputs.stillAnimating)
  for (const name of springNames) {
    for (const field of springFields) program.next(state[name][field], springs.lanes[name][field])
  }
  return {program, count, cells, state, sharedOutputs, photoOutputs}
}

export type StagedGallery = ReturnType<typeof buildStagedGallery>

// Unused below, exported for tests that build a map stage by hand.
export type {Circuit}

// chenglou.github.io's photo gallery render path (fixture index.ts:230-473), hand-authored as one circuit.
//
// One evaluation is one call of `render(now)`: it reads the viewport, scroll position, URL focus,
// event latches and the committed state, and computes the new focus, the 2D grid or 1D strip
// destinations, hover, the scroll anchor, every spring, occlusion bits, and the next committed state.
// Strings, DOM nodes, `scrollTo` and `pushState` stay in JS (gallery-app.ts).
import {Circuit, emitFirstActive, invariant, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {
  aboveZero,
  atLeastZero,
  atMostZero,
  belowZero,
  emitAll,
  emitAnd,
  emitAny,
  emitFirstSetBit,
  emitGated,
  emitGather,
  emitIndexOneHot,
  emitIntegerAtLeastZero,
  emitMaximumTree,
  emitMinimumConstant,
  emitPrefixSums,
  emitSaturateCount,
  emitSpring,
  emitSpringBank,
  emitStepMatrix,
  Sections,
  SourceLayout,
  type PrefixMode,
  type SpringProducts,
} from './kit.ts'
import type {PhotoData} from './photo-data.ts'

export const galleryConstants = {
  promptSizeY: 52,
  prompt1DSizeY: 72,
  boxesGapX: 24,
  boxesGapY: 24,
  boxes1DGapX: 52,
  boxes1DGapY: 28,
  windowPaddingTop: 40,
  gapTopPeek: 40,
  hitArea1DSizeX: 100,
  boxMinSizeX: 220,
  maximumColumns: 7,
  msPerAnimationStep: 4,
  stiffness: 290,
  damping: 30,
  hoverMagnetFactor: 40,
  browserUIMaxSizeTop: 100,
  browserUIMaxSizeBottom: 150,
} as const

export const springNames = ['sizeX', 'sizeY', 'x', 'y', 'scale', 'fxFactor'] as const
export type SpringName = typeof springNames[number]

// Caption line breakpoints per photo, tabulated by a pretext prepare step (captions.ts).
// `twoLines` is the inner width below which the prompt needs at least two lines, `threeLines`
// the width below which it needs at least three. Used by the vibescript port's layout rules.
export type CaptionBreakpoints = {twoLines: number, threeLines: number}[]

export type GalleryCircuitOptions = {
  prefixMode?: PrefixMode
  // How a click picks the first box containing the pointer: a tournament over hit bits
  // ('first-set-bit', 2 log2 n layers), the library's emitFirstActive, or 'prefix-count':
  // bit_i AND no earlier hit, as relu(bit_i - Σ_(j<i) bit_j) in one layer with n^2/2 weights.
  clickSelection?: 'first-set-bit' | 'library-first-active' | 'prefix-count'
  // With captions, 2D and 1D item heights follow vibescript's photo-gallery port (layout.ts):
  // prompt heights from line counts instead of index.ts's fixed 44px and 64px boxes.
  captions?: CaptionBreakpoints
  springProducts?: SpringProducts
  // Measurement only: take the new focus straight from the URL (no keys, no clicks), so the 1D strip
  // can be compiled alone with the focused index as an input, like the trace compiler's 1D slice.
  focusFromUrlOnly?: boolean
}

// Committed spring state. index.ts keeps absolute positions; here each spring keeps its displacement
// from the destination it had last frame, plus that destination. FP32 positions near 100,000px are
// 1/64px apart, so an absolute position there could never come within 0.01px of its destination and
// the spring would never settle. A displacement resolves finely at any distance from the origin.
export type PhotoCells = {
  springs: Record<SpringName, {displacement: Wire, velocity: Wire, destination: Wire}>
}

export type PhotoOutputs = {
  springs: Record<SpringName, Wire>
  visible: Wire
  focused: Wire
  blurred: Wire
  destX: Wire
  destY: Wire
  destSizeX: Wire
  destSizeY: Wire
}

export function buildGalleryCircuit(photos: readonly PhotoData[], options: GalleryCircuitOptions = {}) {
  const count = photos.length
  invariant(count >= 8, 'the gallery circuit expects at least a full row of photos')
  const prefixMode = options.prefixMode ?? 'triangle'
  const captions = options.captions
  invariant(captions === undefined || captions.length === count, 'one caption breakpoint entry per photo')
  const K = galleryConstants
  const layout = new SourceLayout()
  const viewportLimit = 16384
  const coordinateLimit = 2 ** 22
  const pointerLimit = 2 ** 16
  const velocityLimit = 2 ** 26
  const bit = (name: string) => layout.add(name, 0, 1)

  // Inputs written by JS every frame (DOM reads and event latches).
  const windowSizeX = layout.add('windowSizeX', 0, viewportLimit) // integer clientWidth
  const windowSizeY = layout.add('windowSizeY', 0, viewportLimit)
  const scrollX = layout.add('scrollX', -coordinateLimit, coordinateLimit)
  const scrollY = layout.add('scrollY', -coordinateLimit, coordinateLimit)
  const reducedMotion = bit('reducedMotion')
  const focusedIndex = layout.add('focusedIndex', 0, count - 1) // from the URL hash; 0 when absent
  const focusedPresent = bit('focusedPresent')
  const keyEscape = bit('keyEscape')
  const keyArrowLeft = bit('keyArrowLeft')
  const keyArrowRight = bit('keyArrowRight')
  const clickActive = bit('clickActive')
  const clickX = layout.add('clickX', -pointerLimit, pointerLimit)
  const clickY = layout.add('clickY', -pointerLimit, pointerLimit)
  const clickOnPrompt = bit('clickOnPrompt')
  const moveActive = bit('moveActive')
  const moveX = layout.add('moveX', -pointerLimit, pointerLimit)
  const moveY = layout.add('moveY', -pointerLimit, pointerLimit)
  const frameDuration = layout.add('frameDuration', 0, 2 ** 30)
  // Committed state, written back from next-source outputs.
  const pointerX = layout.add('pointerX', -pointerLimit, pointerLimit)
  const pointerY = layout.add('pointerY', -pointerLimit, pointerLimit)
  const pointerPresent = bit('pointerPresent')
  const anchor = layout.add('anchor', 0, count - 1)
  const previousWindowSizeX = layout.add('previousWindowSizeX', 0, viewportLimit)
  const committedScrollY = layout.add('committedScrollY', -coordinateLimit, coordinateLimit)
  const leftoverMilliseconds = layout.add('leftoverMilliseconds', 0, 4)
  const animating = bit('animating')
  const photoCells: PhotoCells[] = photos.map((_, index) => {
    const springs = {} as PhotoCells['springs']
    for (const name of springNames) {
      springs[name] = {
        displacement: layout.add(`photo${index}.${name}.displacement`, -coordinateLimit, coordinateLimit),
        velocity: layout.add(`photo${index}.${name}.velocity`, -velocityLimit, velocityLimit),
        destination: layout.add(`photo${index}.${name}.destination`, -coordinateLimit, coordinateLimit),
      }
    }
    return {springs}
  })

  const circuit = new Circuit(layout.size)
  layout.applyRanges(circuit)
  const sections = new Sections(circuit)

  // === pointer: index.ts:236-247, 265
  const pointer = sections.run('pointer', () => {
    const x = circuit.select(moveActive, circuit.select(clickActive, pointerX, clickX), moveX)
    const y = circuit.select(moveActive, circuit.select(clickActive, pointerY, clickY), moveY)
    const present = emitAny(circuit, [], {bits: [pointerPresent, clickActive, moveActive]})
    const localX = circuit.roundAffine([[x, 1], [scrollX, 1]])
    const localY = circuit.roundAffine([[y, 1], [scrollY, 1]])
    return {x, y, present, localX, localY}
  })

  // === new focus from keys and clicks: index.ts:269-289, 216-228
  const focus = sections.run('focus from keys and clicks', () => {
    const atLeastOne = emitIntegerAtLeastZero(circuit, [[focusedIndex, 1]], -1)
    const atMostSecondLast = emitIntegerAtLeastZero(circuit, [[focusedIndex, -1]], count - 2)
    const atLast = emitIntegerAtLeastZero(circuit, [[focusedIndex, 1]], -(count - 1))
    const moveLeft = emitAnd(circuit, [keyArrowLeft, focusedPresent, atLeastOne])
    const moveRight = emitAnd(circuit, [keyArrowRight, focusedPresent, atMostSecondLast])
    const keyPresent = circuit.affine([
      [keyArrowLeft, 1], [keyArrowRight, 1],
      [emitAnd(circuit, [focusedPresent], [keyEscape, keyArrowLeft, keyArrowRight]), 1],
    ])
    circuit.assumeRange(keyPresent, 0, 1)
    const keyIndex = emitGated(circuit, [[focusedIndex, 1], [moveLeft, -1], [moveRight, 1]], 0, keyPresent)

    // 2D click: first box whose previous destination contains the pointer (hitTest2DMode).
    const gate2D = emitAnd(circuit, [clickActive], [clickOnPrompt, focusedPresent])
    const hitBits = photoCells.map(({springs}) => emitAll(circuit, [
      atLeastZero(circuit.roundAffine([[pointer.localX, 1], [springs.x.destination, -1]])),
      aboveZero(circuit.roundAffine([[springs.x.destination, 1], [springs.sizeX.destination, 1], [pointer.localX, -1]])),
      atLeastZero(circuit.roundAffine([[pointer.localY, 1], [springs.y.destination, -1]])),
      aboveZero(circuit.roundAffine([[springs.y.destination, 1], [springs.sizeY.destination, 1], [pointer.localY, -1]])),
    ], {booleanAtom: true}))
    const selected = options.clickSelection === 'library-first-active'
      ? emitFirstActive(circuit, gate2D, hitBits)
      : options.clickSelection === 'prefix-count'
        ? hitBits.map((hitBit, index) => {
          const first = circuit.reglu([], 1, [[hitBit, 1], [gate2D, 1], ...hitBits.slice(0, index).map(earlier => [earlier, -1] as const)], -1)
          circuit.assumeRange(first, 0, 1)
          return first
        })
        : emitFirstSetBit(circuit, gate2D, hitBits)
    const hitIndex = circuit.affine(selected.map((wire, index) => [wire, index] as const))
    const hitPresent = circuit.affine(selected.map(wire => [wire, 1] as const))
    circuit.assumeRange(hitPresent, 0, 1)
    const index2D = circuit.affine([[hitIndex, 1], [circuit.reglu([[keyIndex, 1]], 0, [[hitPresent, -1]], 1), 1]])
    const present2D = emitAny(circuit, [], {bits: [keyPresent, hitPresent]})

    // 1D click: left or right region (hitTest1DMode), using the focus from the URL.
    const gate1D = emitAnd(circuit, [clickActive, focusedPresent], [clickOnPrompt])
    const beyondLeftRegion = circuit.roundAffine([[pointer.localX, 1]], -K.hitArea1DSizeX)
    const intoRightRegion = circuit.roundAffine([[pointer.localX, 1], [windowSizeX, -1]], K.hitArea1DSizeX)
    const leftRegion = emitAll(circuit, [atLeastZero(pointer.localX), atMostZero(beyondLeftRegion)], {bits: [atLeastOne]})
    const rightRegion = emitAll(circuit, [atLeastZero(intoRightRegion)], {bits: [atMostSecondLast], forbidden: [leftRegion]})
    const present1D = circuit.affine([[leftRegion, 1], [rightRegion, 1]])
    const index1D = emitGated(circuit, [[focusedIndex, 1], [leftRegion, -1], [rightRegion, 1]], 0, present1D)

    if (options.focusFromUrlOnly === true) {
      return {atLeastOne, atLast, newIndex: focusedIndex, newPresent: focusedPresent, changed: circuit.affine([], 0), hitBits, selected}
    }
    const newIndex = circuit.roundAffine([
      [keyIndex, 1],
      [circuit.reglu([[index2D, 1], [keyIndex, -1]], 0, [[gate2D, 1]], 0), 1],
      [circuit.reglu([[index1D, 1], [keyIndex, -1]], 0, [[gate1D, 1]], 0), 1],
    ])
    const newPresent = circuit.roundAffine([
      [keyPresent, 1],
      [circuit.reglu([[present2D, 1], [keyPresent, -1]], 0, [[gate2D, 1]], 0), 1],
      [circuit.reglu([[present1D, 1], [keyPresent, -1]], 0, [[gate1D, 1]], 0), 1],
    ])
    circuit.assumeRange(newIndex, 0, count - 1)
    circuit.assumeRange(newPresent, 0, 1)
    const difference = (a: Wire, b: Wire) => [
      [circuit.reglu([], 1, [[a, 1], [b, -1]], 0), 1],
      [circuit.reglu([], 1, [[b, 1], [a, -1]], 0), 1],
    ] as const
    const changed = emitSaturateCount(circuit, circuit.affine([
      ...difference(newIndex, focusedIndex), ...difference(newPresent, focusedPresent),
    ]))
    return {atLeastOne, atLast, newIndex, newPresent, changed, hitBits, selected}
  })
  const mode1D = focus.newPresent

  // === column count and box width: index.ts:83-91
  const columns = sections.run('column count', () => {
    const atLeast: Wire[] = []
    for (let columnCount = 2; columnCount <= K.maximumColumns; columnCount++) {
      atLeast[columnCount] = emitIntegerAtLeastZero(circuit, [[windowSizeX, 1]], -(K.boxesGapX + (K.boxMinSizeX + K.boxesGapX) * columnCount))
    }
    const oneHot: Wire[] = []
    for (let columnCount = 1; columnCount <= K.maximumColumns; columnCount++) {
      const member = columnCount === 1
        ? circuit.affine([[atLeast[2]!, -1]], 1)
        : columnCount === K.maximumColumns
          ? atLeast[columnCount]!
          : circuit.affine([[atLeast[columnCount]!, 1], [atLeast[columnCount + 1]!, -1]])
      circuit.assumeRange(member, 0, 1)
      oneHot.push(member)
    }
    circuit.assumeOneHot(oneHot)
    const widths = oneHot.map((_, index) => {
      const columnCount = index + 1
      return circuit.roundAffine([[windowSizeX, 1 / columnCount]], -K.boxesGapX * (columnCount + 1) / columnCount)
    })
    const selectedWidth = emitGather(circuit, oneHot, widths)
    const boxMaxSizeX = circuit.affine([[circuit.reglu([], 1, [[selectedWidth, 1]], -1), 1]], 1)
    circuit.assumeRange(boxMaxSizeX, 1, viewportLimit)
    const value = circuit.affine(oneHot.map((member, index) => [member, index + 1] as const))
    return {oneHot, boxMaxSizeX, value}
  })

  // Captions: [inner width < breakpoint] for a box width, where inner width = boxWidth - 24.
  const needsLines = (boxWidth: Wire, breakpoint: number) =>
    emitAll(circuit, [aboveZero(circuit.roundAffine([[boxWidth, -1]], breakpoint + 24))])

  // === 2D item sizes: index.ts:296-305
  const sizes2D = sections.run('2D sizes', () => photos.map((photo, index) => {
    const ar = photo.w / photo.h
    const factor = ar === 1 ? 0.85 : ar < 1 ? 1.05 : 1
    const widthFactor = Math.min(1, factor * ar)
    const sizeX = circuit.affine([
      [columns.boxMaxSizeX, widthFactor],
      [circuit.reglu([], 1, [[columns.boxMaxSizeX, widthFactor]], -photo.w), -1],
    ])
    circuit.assumeRange(sizeX, 0, photo.w)
    let sizeY: Wire
    if (captions === undefined) {
      sizeY = circuit.affine([[sizeX, 1 / ar]], K.promptSizeY)
    } else {
      // vibescript layout.ts: imageSizeY + (8 + 18 * min(lines, 2)) + 8
      const twoLines = needsLines(sizeX, captions[index]!.twoLines)
      sizeY = circuit.affine([[sizeX, 1 / ar], [twoLines, 18]], 34)
    }
    circuit.assumeRange(sizeY, 0, coordinateLimit)
    return {sizeX, sizeY}
  }))

  // === rows for each column count: index.ts:293-312 and 329-334
  const rows = sections.run('2D rows', () => columns.oneHot.map((_, columnIndex) => {
    const columnCount = columnIndex + 1
    const rowCount = Math.ceil(count / columnCount)
    const maximums: Wire[] = []
    for (let row = 0; row < rowCount; row++) {
      const members = sizes2D.slice(row * columnCount, Math.min(count, (row + 1) * columnCount)).map(size => size.sizeY)
      maximums.push(emitMaximumTree(circuit, members))
    }
    const tops = emitPrefixSums(circuit, maximums, K.windowPaddingTop, K.boxesGapY, prefixMode)
    const centers = maximums.map((maximum, row) => circuit.affine([[tops[row]!, 1], [maximum, 0.5]]))
    const cellCenters = Array.from({length: columnCount}, (_, column) =>
      circuit.affine([[columns.boxMaxSizeX, column + 0.5]], K.boxesGapX * (column + 1)))
    return {columnCount, rowCount, tops, centers, cellCenters}
  }))
  const placeholderHeight = emitGather(circuit, columns.oneHot, rows.map(variant => variant.tops[variant.rowCount]!))

  // === 2D destinations and hover on the new targets: index.ts:326-347
  const grid = sections.run('2D targets and hover', () => photos.map((_, index) => {
    const {sizeX, sizeY} = sizes2D[index]!
    const centerX = emitGather(circuit, columns.oneHot, rows.map(variant => variant.cellCenters[index % variant.columnCount]!))
    const centerY = emitGather(circuit, columns.oneHot, rows.map(variant => variant.centers[Math.floor(index / variant.columnCount)]!))
    const hovered = emitAll(circuit, [
      atLeastZero(circuit.roundAffine([[pointer.localX, 1], [centerX, -1], [sizeX, 0.5]])),
      aboveZero(circuit.roundAffine([[centerX, 1], [sizeX, 0.5], [pointer.localX, -1]])),
      atLeastZero(circuit.roundAffine([[pointer.localY, 1], [centerY, -1], [sizeY, 0.5]])),
      aboveZero(circuit.roundAffine([[centerY, 1], [sizeY, 0.5], [pointer.localY, -1]])),
    ], {bits: [pointer.present], booleanAtom: true})
    return {centerX, centerY, sizeX, sizeY, hovered}
  }))

  // === 1D strip: index.ts:358-386
  const newFocus = sections.run('focus one-hot', () => emitIndexOneHot(circuit, focus.newIndex, count, focus.newPresent))
  const strip = sections.run('1D layout', () => {
    const box1DMaxSizeX = circuit.affine([[circuit.reglu([], 1, [[windowSizeX, 1]], -(2 * K.boxes1DGapX + 2 * K.hitArea1DSizeX + 1)), 1]], 1)
    const imageMaxSizeY = (promptAreaY: number) => circuit.affine([[
      circuit.reglu([], 1, [[windowSizeY, 1]], -(K.windowPaddingTop + promptAreaY + K.boxes1DGapY + 1)), 1,
    ]], 1)
    const baseWidth = (photo: PhotoData, maximumY: Wire) => {
      const ar = photo.w / photo.h
      const cappedByBox = emitMinimumConstant(circuit, box1DMaxSizeX, photo.w)
      circuit.assumeRange(cappedByBox, 0, photo.w)
      const base = circuit.affine([[cappedByBox, 1], [circuit.reglu([], 1, [[cappedByBox, 1], [maximumY, -ar]], 0), -1]])
      circuit.assumeRange(base, 0, photo.w)
      return base
    }
    const fixedMaximumY = imageMaxSizeY(K.prompt1DSizeY)
    let items: {unfocusedWidth: Wire, focusedWidth: Wire, sizeX: Wire, sizeY: Wire}[]
    if (captions === undefined) {
      items = photos.map((photo, index) => {
        const base = baseWidth(photo, fixedMaximumY)
        const sizeX = circuit.affine([[base, 0.7], [emitGated(circuit, [[base, 0.3]], 0, newFocus.members[index]!), 1]])
        const sizeY = circuit.affine([[sizeX, photo.h / photo.w]], K.prompt1DSizeY)
        return {unfocusedWidth: circuit.affine([[base, 0.7]]), focusedWidth: base, sizeX, sizeY}
      })
    } else {
      // vibescript layout.ts get1DItemSize: a fixed point between prompt height and image width.
      // Prompt areas for 1, 2 and 3 lines are 16 + 56/3 * lines. Starting from 3 lines, the loop
      // settles on 3 lines if the 3-line image still needs 3 lines, else on 2 lines if the 2-line
      // image needs 2 lines, else on 1 line. So it unrolls into two threshold tests per scale.
      const lineHeight = (64 - 8) / 3
      const promptArea = (lines: number) => 8 + lineHeight * lines + 8
      const maximumY = [1, 2, 3].map(lines => imageMaxSizeY(promptArea(lines)))
      items = photos.map((photo, index) => {
        const breakpoints = captions[index]!
        const bases = maximumY.map(maximum => baseWidth(photo, maximum))
        const settle = (scale: number) => {
          const widths = bases.map(base => circuit.affine([[base, scale]]))
          const threeLines = needsLines(widths[2]!, breakpoints.threeLines)
          const twoLines = needsLines(widths[1]!, breakpoints.twoLines)
          const atLeastTwo = emitAny(circuit, [], {bits: [threeLines, twoLines]})
          // width = w1 + atLeastTwo (w2 - w1) + threeLines (w3 - w2)
          const width = circuit.affine([
            [widths[0]!, 1],
            [emitGated(circuit, [[widths[1]!, 1], [widths[0]!, -1]], 0, atLeastTwo), 1],
            [emitGated(circuit, [[widths[2]!, 1], [widths[1]!, -1]], 0, threeLines), 1],
          ])
          const area = circuit.affine([[atLeastTwo, lineHeight], [threeLines, lineHeight]], promptArea(1))
          return {width, area}
        }
        const unfocused = settle(0.7)
        const focusedItem = settle(1)
        const member = newFocus.members[index]!
        const sizeX = circuit.affine([[unfocused.width, 1], [emitGated(circuit, [[focusedItem.width, 1], [unfocused.width, -1]], 0, member), 1]])
        const area = circuit.affine([[unfocused.area, 1], [emitGated(circuit, [[focusedItem.area, 1], [unfocused.area, -1]], 0, member), 1]])
        const sizeY = circuit.affine([[sizeX, photo.h / photo.w], [area, 1]])
        return {unfocusedWidth: unfocused.width, focusedWidth: focusedItem.width, sizeX, sizeY}
      })
    }
    // Left edges: strip positions are prefix sums of unfocused widths plus gaps.
    const prefix = emitPrefixSums(circuit, items.map(item => item.unfocusedWidth), 0, K.boxes1DGapX, prefixMode)
    const prefixAtFocus = emitGather(circuit, newFocus.members, prefix.slice(0, count))
    const prefixAfterFocus = emitGather(circuit, newFocus.members, prefix.slice(1, count + 1))
    const startLeft = K.hitArea1DSizeX + K.boxes1DGapX
    const stripX = items.map((item, index) => circuit.roundAffine([
      [emitGated(circuit, [[prefix[index]!, 1], [prefixAtFocus, -1]], startLeft, newFocus.atLeast(index + 1)), 1],
      [emitGated(circuit, [[windowSizeX, 0.5], [item.focusedWidth, -0.5]], 0, newFocus.members[index]!), 1],
      [emitGated(circuit, [[windowSizeX, 1], [prefix[index]!, 1], [prefixAfterFocus, -1]], -K.hitArea1DSizeX,
        circuit.affine([[focus.newPresent, 1], [newFocus.atLeast(index), -1]])), 1],
    ]))
    const perItem = items.map((item, index) => {
      const y = circuit.affine([
        [circuit.reglu([], 1, [[windowSizeY, 0.5], [item.sizeY, -0.5]], -K.windowPaddingTop), 1], [scrollY, 1],
      ], K.windowPaddingTop)
      return {
        sizeX: item.sizeX,
        sizeY: item.sizeY,
        y,
        // i < focused: startLeft - (prefix[focused] - prefix[i])
        beforeTerms: [[prefix[index]!, 1], [prefixAtFocus, -1]] as [Wire, number][],
        beforeBias: startLeft,
        // i == focused: (windowSizeX - width) / 2
        focusTerms: [[windowSizeX, 0.5], [item.focusedWidth, -0.5]] as [Wire, number][],
        // i > focused: windowSizeX - hitArea1DSizeX + prefix[i] - prefix[focused + 1]
        afterTerms: [[windowSizeX, 1], [prefix[index]!, 1], [prefixAfterFocus, -1]] as [Wire, number][],
        afterBias: -K.hitArea1DSizeX,
      }
    })
    return Object.assign(perItem, {stripX})
  })

  // === mode select, 1D hover, magnet, destinations: index.ts:317-398
  const destinations = sections.run('destinations and hover', () => {
    const leftHover = emitAll(circuit, [
      atLeastZero(pointer.localX), atMostZero(circuit.roundAffine([[pointer.localX, 1]], -K.hitArea1DSizeX)),
    ], {bits: [pointer.present, newFocus.atLeast(1)]})
    const notLast = circuit.affine([[focus.newPresent, 1], [newFocus.atLeast(count - 1), -1]])
    const rightHover = emitAll(circuit, [
      atLeastZero(circuit.roundAffine([[pointer.localX, 1], [windowSizeX, -1]], K.hitArea1DSizeX)),
    ], {bits: [pointer.present, notLast], forbidden: [leftHover]})
    const anyGridHover = emitSaturateCount(circuit, circuit.affine(grid.map(item => [item.hovered, 1] as const)))
    const cursorZoomIn = circuit.affine([[emitAnd(circuit, [anyGridHover], [mode1D]), 1], [leftHover, 1], [rightHover, 1]])
    const cursorZoomOut = circuit.affine([[mode1D, 1], [leftHover, -1], [rightHover, -1]])
    const perPhoto = photos.map((_, index) => {
      const item = grid[index]!
      const stripItem = strip[index]!
      const member = newFocus.members[index]!
      const gridX: [Wire, number][] = [[item.centerX, 1], [item.sizeX, -0.5]]
      const gridY: [Wire, number][] = [[item.centerY, 1], [item.sizeY, -0.5]]
      const negate = (terms: [Wire, number][]) => terms.map(([wire, coefficient]) => [wire, -coefficient] as [Wire, number])
      const after = circuit.affine([[focus.newPresent, 1], [newFocus.atLeast(index), -1]])
      const x = circuit.affine([
        ...gridX,
        [emitGated(circuit, [...stripItem.beforeTerms, ...negate(gridX)], stripItem.beforeBias, newFocus.atLeast(index + 1)), 1],
        [emitGated(circuit, [...stripItem.focusTerms, ...negate(gridX)], 0, member), 1],
        [emitGated(circuit, [...stripItem.afterTerms, ...negate(gridX)], stripItem.afterBias, after), 1],
      ])
      const y = circuit.affine([...gridY, [emitGated(circuit, [[stripItem.y, 1], ...negate(gridY)], 0, mode1D), 1]])
      const sizeX = circuit.affine([[item.sizeX, 1], [emitGated(circuit, [[stripItem.sizeX, 1], [item.sizeX, -1]], 0, mode1D), 1]])
      const sizeY = circuit.affine([[item.sizeY, 1], [emitGated(circuit, [[stripItem.sizeY, 1], [item.sizeY, -1]], 0, mode1D), 1]])
      const hoverTerms: [Wire, number][] = []
      if (index + 1 < count) hoverTerms.push([emitAnd(circuit, [leftHover, newFocus.members[index + 1]!]), 1])
      if (index > 0) hoverTerms.push([emitAnd(circuit, [rightHover, newFocus.members[index - 1]!]), 1])
      const stripHovered = circuit.affine(hoverTerms)
      const hovered = circuit.affine([[emitAnd(circuit, [item.hovered], [mode1D]), 1], [stripHovered, 1]])
      circuit.assumeRange(hovered, 0, 1)
      const magnet = 1 / K.hoverMagnetFactor
      const destX = circuit.roundAffine([[x, 1], [emitGated(circuit, [[pointer.localX, magnet], [x, -magnet], [sizeX, -magnet / 2]], 0, hovered), 1]])
      const destY = circuit.roundAffine([[y, 1], [emitGated(circuit, [[pointer.localY, magnet], [y, -magnet], [sizeY, -magnet / 2]], 0, hovered), 1]])
      const scale = circuit.affine([[hovered, 0.02]], 1)
      const fxFactor = circuit.affine([[mode1D, -0.8], [member, 0.8], [stripHovered, 0.3]], 1)
      return {destX, destY, destSizeX: sizeX, destSizeY: sizeY, scale, fxFactor}
    })
    return {perPhoto, cursorZoomIn, cursorZoomOut}
  })

  // === scroll adjustment and anchor: index.ts:317-324, 348-357
  const scroll = sections.run('scroll and anchor', () => {
    const oldFocus = emitIndexOneHot(circuit, focusedIndex, count, focusedPresent)
    const focusedTop = emitGather(circuit, columns.oneHot, rows.map(variant => emitGather(
      circuit, oldFocus.members, photos.map((_, index) => variant.tops[Math.floor(index / variant.columnCount)]!),
    )))
    const focusedSizeY = emitGather(circuit, oldFocus.members, sizes2D.map(size => size.sizeY))
    const dismissed = emitAnd(circuit, [focusedPresent], [focus.newPresent])
    const notFullyShown = emitAny(circuit, [
      atMostZero(circuit.roundAffine([[focusedTop, 1], [scrollY, -1]])),
      atLeastZero(circuit.roundAffine([[focusedTop, 1], [focusedSizeY, 1], [scrollY, -1], [windowSizeY, -1]])),
    ])
    const reveal = emitAnd(circuit, [dismissed, notFullyShown])
    const afterDismiss = circuit.roundAffine([
      [scrollY, 1], [emitGated(circuit, [[focusedTop, 1], [scrollY, -1]], -(K.boxesGapY + K.gapTopPeek), reveal), 1],
    ])
    const anchorOneHot = emitIndexOneHot(circuit, anchor, count)
    const anchorDestY = emitGather(circuit, anchorOneHot.members, destinations.perPhoto.map(item => item.destY))
    const resized = emitSaturateCount(circuit, circuit.affine([
      [circuit.reglu([], 1, [[windowSizeX, 1], [previousWindowSizeX, -1]], 0), 1],
      [circuit.reglu([], 1, [[previousWindowSizeX, 1], [windowSizeX, -1]], 0), 1],
    ]))
    const keepAnchor = emitAnd(circuit, [resized], [mode1D])
    const adjusted = circuit.roundAffine([
      [afterDismiss, 1],
      [emitGated(circuit, [[circuit.reglu([], 1, [[anchorDestY, 1]], -K.gapTopPeek), 1], [afterDismiss, -1]], 0, keepAnchor), 1],
    ])
    const movedSinceCommit = circuit.roundAffine([[adjusted, 1], [committedScrollY, -1]])
    const anchorOffset = circuit.roundAffine([[anchorDestY, 1], [adjusted, -1]], -K.gapTopPeek)
    const farFromAnchor = emitAny(circuit, [
      aboveZero(circuit.roundAffine([[anchorOffset, 1], [windowSizeY, -0.1]])),
      aboveZero(circuit.roundAffine([[anchorOffset, -1], [windowSizeY, -0.1]])),
    ])
    const scrollMoved = emitAny(circuit, [aboveZero(movedSinceCommit), belowZero(movedSinceCommit)])
    const search = emitAnd(circuit, [scrollMoved, farFromAnchor], [mode1D])
    // The anchor search walks the leftmost column for the first box whose bottom is more than
    // 20% of the window below the scroll position. Those bottoms increase with the row, so the
    // first match is the number of rows before it: a count of predicate bits, not a loop.
    const threshold = circuit.roundAffine([[adjusted, 1], [windowSizeY, 0.2]])
    const belowThreshold = destinations.perPhoto.map(item => emitAll(circuit, [
      aboveZero(circuit.roundAffine([[item.destY, 1], [item.destSizeY, 1], [threshold, -1]])),
    ], {booleanAtom: true}))
    const candidates = rows.map(variant => circuit.affine(
      Array.from({length: variant.rowCount - 1}, (_, row) => [belowThreshold[row * variant.columnCount]!, -variant.columnCount] as const),
      variant.columnCount * (variant.rowCount - 1),
    ))
    const found = emitGather(circuit, columns.oneHot, candidates)
    const nextAnchor = circuit.roundAffine([[anchor, 1], [emitGated(circuit, [[found, 1], [anchor, -1]], 0, search), 1]])
    circuit.assumeRange(nextAnchor, 0, count - 1)
    const delta = circuit.roundAffine([[adjusted, 1], [scrollY, -1]])
    const changed = emitAny(circuit, [aboveZero(delta), belowZero(delta)])
    return {adjusted, delta, changed, nextAnchor}
  })

  // === springs: index.ts:399-407, 172-194
  const animation = sections.run('springs', () => {
    const constants = {stiffness: K.stiffness, damping: K.damping, stepMilliseconds: K.msPerAnimationStep}
    const cap = K.msPerAnimationStep * (16 ** 3 - 1)
    const elapsedRaw = circuit.roundAffine([[leftoverMilliseconds, 1], [frameDuration, 1]])
    const capped = circuit.affine([[elapsedRaw, 1], [circuit.reglu([], 1, [[elapsedRaw, 1]], -cap), -1]])
    const elapsed = emitGated(circuit, [[capped, 1]], 0, animating)
    const stepMatrix = emitStepMatrix(circuit, elapsed, constants)
    const bank = emitSpringBank(circuit, stepMatrix, circuit.affine([[reducedMotion, -1]], 1), options.springProducts)
    // index.ts:369-372 computes the edge rubber band inside its 1D branch, so it needs a new focus too:
    // ArrowLeft on the first photo plus a click that dismisses the strip in the same frame adds nothing.
    const leftEdge = emitAnd(circuit, [keyArrowLeft, focusedPresent, mode1D], [focus.atLeastOne])
    const rightEdge = emitAnd(circuit, [keyArrowRight, focusedPresent, focus.atLast, mode1D])
    const actives: Wire[] = []
    const perPhoto = photoCells.map((cells, index) => {
      const target = destinations.perPhoto[index]!
      const member = newFocus.members[index]!
      const step = (name: SpringName, destination: Wire, velocity: Wire, extraTerms: readonly (readonly [Wire, number])[] = []) => {
        const spring = cells.springs[name]
        const displacement = circuit.roundAffine([[spring.destination, 1], [destination, -1], [spring.displacement, 1], ...extraTerms])
        const result = emitSpring(circuit, bank, displacement, velocity)
        actives.push(result.active)
        const position = circuit.roundAffine([[destination, 1], [result.displacement, 1]])
        return {position, displacement: result.displacement, velocity: result.velocity, destination}
      }
      const x = cells.springs.x
      // index.ts:381: x.v += edgeRubberBandVelocityX / (i === newFocused ? 1 : 4)
      const kickedVelocityX = circuit.roundAffine([
        [x.velocity, 1], [leftEdge, 500], [rightEdge, -500],
        [emitGated(circuit, [[leftEdge, 1500], [rightEdge, -1500]], 0, member), 1],
      ])
      return {
        kickedVelocityX,
        sizeX: step('sizeX', target.destSizeX, cells.springs.sizeX.velocity),
        sizeY: step('sizeY', target.destSizeY, cells.springs.sizeY.velocity),
        x: step('x', target.destX, kickedVelocityX),
        // index.ts:400: y.pos += adjustedScrollTop - currentScrollY
        y: step('y', target.destY, cells.springs.y.velocity, [[scroll.delta, 1]]),
        scale: step('scale', target.scale, cells.springs.scale.velocity),
        fxFactor: step('fxFactor', target.fxFactor, cells.springs.fxFactor.velocity),
      }
    })
    const stillAnimating = emitSaturateCount(circuit, circuit.affine(actives.map(active => [active, 1] as const)))
    return {perPhoto, stillAnimating, leftover: stepMatrix.leftover, steps: stepMatrix.steps}
  })

  // === occlusion: index.ts:410-419
  const visibility = sections.run('occlusion', () => animation.perPhoto.map(springs => emitAll(circuit, [
    atLeastZero(circuit.roundAffine([[windowSizeY, 1], [springs.y.position, -1], [scroll.adjusted, 1]], K.browserUIMaxSizeBottom)),
    atLeastZero(circuit.roundAffine([[springs.y.position, 1], [springs.sizeY.position, 1], [scroll.adjusted, -1]], K.browserUIMaxSizeTop)),
    atLeastZero(circuit.roundAffine([[windowSizeX, 1], [springs.x.position, -1]])),
    atLeastZero(circuit.roundAffine([[springs.x.position, 1], [springs.sizeX.position, 1]])),
  ], {booleanAtom: true})))

  const outputs = sections.run('outputs', () => {
    const photosOut: PhotoOutputs[] = photos.map((_, index) => {
      const springs = animation.perPhoto[index]!
      const blurTerms: [Wire, number][] = [[newFocus.members[index]!, 1]]
      if (index > 0) blurTerms.push([newFocus.members[index - 1]!, 1])
      if (index + 1 < count) blurTerms.push([newFocus.members[index + 1]!, 1])
      const target = destinations.perPhoto[index]!
      return {
        springs: {
          sizeX: springs.sizeX.position, sizeY: springs.sizeY.position, x: springs.x.position,
          y: springs.y.position, scale: springs.scale.position, fxFactor: springs.fxFactor.position,
        },
        visible: visibility[index]!,
        focused: newFocus.members[index]!,
        blurred: circuit.roundAffine(blurTerms),
        destX: target.destX,
        destY: target.destY,
        destSizeX: target.destSizeX,
        destSizeY: target.destSizeY,
      }
    })
    return {
      newFocusedIndex: focus.newIndex,
      newFocusedPresent: focus.newPresent,
      focusChanged: focus.changed,
      adjustedScrollTop: scroll.adjusted,
      scrollChanged: scroll.changed,
      cursorZoomIn: circuit.roundAffine([[destinations.cursorZoomIn, 1]]),
      cursorZoomOut: circuit.roundAffine([[destinations.cursorZoomOut, 1]]),
      placeholderHeight,
      stillAnimating: animation.stillAnimating,
      selectPrompt: emitAnd(circuit, [clickActive, clickOnPrompt]),
      columns: columns.value,
      boxMaxSizeX: columns.boxMaxSizeX,
      steps: animation.steps,
      photos: photosOut,
    }
  })

  const nextSource: [cell: Wire, wire: Wire][] = [
    [pointerX, pointer.x],
    [pointerY, pointer.y],
    [pointerPresent, pointer.present],
    [anchor, scroll.nextAnchor],
    [previousWindowSizeX, windowSizeX],
    [committedScrollY, scroll.adjusted],
    [leftoverMilliseconds, animation.leftover],
    [animating, animation.stillAnimating],
  ]
  photoCells.forEach((cells, index) => {
    const springs = animation.perPhoto[index]!
    for (const name of springNames) {
      nextSource.push([cells.springs[name].displacement, springs[name].displacement])
      nextSource.push([cells.springs[name].velocity, springs[name].velocity])
      nextSource.push([cells.springs[name].destination, springs[name].destination])
    }
  })

  const globalOutputs = [
    outputs.newFocusedIndex, outputs.newFocusedPresent, outputs.focusChanged, outputs.adjustedScrollTop,
    outputs.scrollChanged, outputs.cursorZoomIn, outputs.cursorZoomOut, outputs.placeholderHeight,
    outputs.stillAnimating, outputs.selectPrompt, outputs.columns, outputs.steps,
  ]
  // outputs.boxMaxSizeX is left out of the roots: the compiler folds that affine wire into its consumers,
  // and making it a root would store one more operation. Tests evaluate it as its own root.
  const photoOutputs = outputs.photos.flatMap(photo => [photo.visible, photo.focused, photo.blurred, ...springNames.map(name => photo.springs[name])])
  const roots = [...new Set([...globalOutputs, ...photoOutputs, ...nextSource.map(([, wire]) => wire)])]
  // Roots for measuring one feature alone (compiled with only these roots, every dependency counts).
  // layout2D and layout1D produce the same outputs as the trace compiler's slices (real-slice.ts):
  // the 2D slice gives each photo's x, y, sizeX, sizeY, scale and fxFactor destinations plus the total
  // height; the 1D slice gives x, y, sizeX, sizeY, scale and fxFactor destinations plus the x velocity
  // after the edge rubber band. The wires that only these slices use don't exist in the full circuit's roots.
  const constantOne = circuit.affine([], 1)
  const slices = {
    columnCount: [columns.value, columns.boxMaxSizeX],
    layout2D: [
      ...grid.flatMap(item => [
        circuit.affine([[item.centerX, 1], [item.sizeX, -0.5]]),
        circuit.affine([[item.centerY, 1], [item.sizeY, -0.5]]),
        item.sizeX, item.sizeY,
      ]),
      // index.ts:335-336: scale and fxFactor destinations are 1 for every photo in the grid.
      constantOne,
      placeholderHeight,
    ],
    layout1D: [
      ...strip.flatMap((item, index) => [
        strip.stripX[index]!, item.y, item.sizeX, item.sizeY,
        // index.ts:383: fxFactor destination 1 for the focused photo, 0.2 for the others, before hover.
        circuit.affine([[newFocus.members[index]!, 0.8]], 0.2),
        animation.perPhoto[index]!.kickedVelocityX,
      ]),
      // index.ts:382: scale destination 1.
      constantOne,
    ],
    clickHitTest: [...focus.selected],
    hover2D: grid.map(item => item.hovered),
    destinations: destinations.perPhoto.flatMap(item => [item.destX, item.destY, item.destSizeX, item.destSizeY, item.scale, item.fxFactor]),
    anchor: [scroll.nextAnchor, scroll.adjusted],
    occlusion: visibility,
  }
  return {
    circuit,
    layout,
    sections,
    slices,
    cells: {
      windowSizeX, windowSizeY, scrollX, scrollY, reducedMotion, focusedIndex, focusedPresent,
      keyEscape, keyArrowLeft, keyArrowRight, clickActive, clickX, clickY, clickOnPrompt,
      moveActive, moveX, moveY, frameDuration, pointerX, pointerY, pointerPresent, anchor,
      previousWindowSizeX, committedScrollY, leftoverMilliseconds, animating, photos: photoCells,
    },
    outputs,
    nextSource,
    roots,
  }
}

export type GalleryCircuit = ReturnType<typeof buildGalleryCircuit>

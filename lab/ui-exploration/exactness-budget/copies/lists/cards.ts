// draggable-cards as one circuit: ranks as state, rank counting for the live
// reorder, springs toward slots as matrix powers with vibescript's fixed 4 ms
// steps and catch-up, a pinned dragged card, z bands, and release velocity from
// a pointer ring buffer.
//
// Host contract (what JS does at the boundary):
// - frame times and event times are multiples of 1/64 ms; frameDelta is clamped
//   to 2^14 ms, and event times are written relative to the frame time
// - pointer coordinates are multiples of 1/64 px within ±2^15 px; card heights
//   are multiples of 1/64 px (the demo's 30 + hash * 150 heights are quantized once)
// - one sample per event kind per frame (mouseup, mousemove, pointerdown)
// - JS clears the event latches after each step
// Two limits the demo doesn't have, applied in both this circuit and
// cards-reference.ts:
// - the release velocity is clamped to ±2^16 px/s per axis (velocity.ts)
// - the pointer buffer keeps its newest 24 samples. The demo's buffer shifts at
//   most once per frame and resets only on a frame that ends with the pointer up,
//   so once it holds more than 20 samples, each frame with an up, a move, and a
//   down (3 pushes, 1 shift) grows it by 2, without limit.
// Spring velocity cells are declared as ±2^20 px/s, which leaves room for a
// clamped release added to a card that is still moving.
import {emitFirstActive, emitMaximum, emitMinimum, type Wire} from '../../../../../numeric-ui-core.ts'
import {
  SourceLayout,
  atLeastContinuous,
  constant,
  emitCatchUpClock,
  emitSpringLane,
  eulerStepMatrix,
  integerAtLeastOne,
  notBit,
  orBits,
  stagePowers,
} from './common.ts'
import {emitReleaseVelocity, releaseVelocityLimit, type SampleWires} from './velocity.ts'

export const cardWidth = 320
export const cardsPaddingTop = 50
export const cardsPointerCapacity = 24
export const frameDeltaMaximum = 2 ** 14
export const eventTimeMinimum = -(2 ** 16)
const pointerLimit = 2 ** 15
const positionLimit = 2 ** 16
const velocityLimit = 2 ** 20
const stageCount = 9
const springPowers = stagePowers(eulerStepMatrix(290, 24, 0.004), stageCount)

type Latch = {active: Wire, x: Wire, y: Wire, time: Wire}
type CardCells = {rank: Wire, xPos: Wire, xVelocity: Wire, yPos: Wire, yVelocity: Wire, scalePos: Wire, scaleVelocity: Wire, destY: Wire}

export type CardsCircuit = ReturnType<typeof buildCards>

// layout 'rankCount' recomputes the stack layout from ranks every frame (n^2/2
// comparisons) and finds the first hit card in data order through the rank
// permutation matrix (n^2 bits). layout 'incremental' uses the fact that a drag
// moves one card: passed cards shift by the dragged card's height, a released
// card's top is one O(n) sum, and the first hit is a minimum over ranks. It needs
// destY to hold the layout top of every card that is not dragged, which the demo
// maintains after its first frame, so its machine starts from a laid-out state.
export type CardsLayout = 'rankCount' | 'incremental'

export function buildCards(sizes: readonly number[], options: {layout?: CardsLayout} = {}) {
  const layoutMode = options.layout ?? 'rankCount'
  const cardCount = sizes.length
  const layout = new SourceLayout()
  const windowSizeX = layout.cell(cardWidth, 8192)
  const frameDelta = layout.cell(0, frameDeltaMaximum)
  const latch = (): Latch => ({
    active: layout.cell(0, 1),
    x: layout.cell(-pointerLimit, pointerLimit),
    y: layout.cell(-pointerLimit, pointerLimit),
    time: layout.cell(eventTimeMinimum, 1024),
  })
  const up = latch()
  const move = latch()
  const down = latch()
  const wasDown = layout.cell(0, 1)
  const dragged = layout.cells(cardCount, 0, 1)
  const deltaX = layout.cell(-2 * positionLimit, 2 * positionLimit)
  const deltaY = layout.cell(-2 * positionLimit, 2 * positionLimit)
  const lastDragged = layout.cells(cardCount, 0, 1)
  const pointerCount = layout.cell(1, cardsPointerCapacity)
  const samples: SampleWires[] = Array.from({length: cardsPointerCapacity}, () => ({
    x: layout.cell(-pointerLimit, pointerLimit),
    y: layout.cell(-pointerLimit, pointerLimit),
    time: layout.cell(eventTimeMinimum, 1024),
    real: layout.cell(0, 1),
  }))
  const animating = layout.cell(0, 1)
  const backlog = layout.cell(0, 2 ** 15)
  const cards: CardCells[] = sizes.map(() => ({
    rank: layout.cell(0, cardCount - 1),
    xPos: layout.cell(-positionLimit, positionLimit),
    xVelocity: layout.cell(-velocityLimit, velocityLimit),
    yPos: layout.cell(-positionLimit, positionLimit),
    yVelocity: layout.cell(-velocityLimit, velocityLimit),
    scalePos: layout.cell(-8, 8),
    scaleVelocity: layout.cell(-velocityLimit, velocityLimit),
    destY: layout.cell(-positionLimit, positionLimit),
  }))
  const circuit = layout.createCircuit()
  circuit.assumeOneHot(dragged, true)
  circuit.assumeOneHot(lastDragged, true)

  const sections: {name: string, start: number, end: number}[] = []
  let sectionStart = 0
  const endSection = (name: string) => {
    sections.push({name, start: sectionStart, end: circuit.operations.length})
    sectionStart = circuit.operations.length
  }
  const one = constant(circuit, 1)

  // === clock: steps = min(300, floor(elapsed / 4)), as vibescript's catch-up
  const {elapsed, steps, stepBits} = emitCatchUpClock(circuit, animating, backlog, frameDelta, stageCount)
  endSection('clock and step bits')

  // === pointer state: 'up' | 'down' at frame start, 'firstDown' within a frame
  const isDown = integerAtLeastOne(circuit, [[wasDown, 1], [up.active, -1], [down.active, -1]], 0)
  const isFirstDown = down.active
  const isUp = circuit.roundAffine([[down.active, -1], [isDown, -1]], 1)
  circuit.assumeRange(isUp, 0, 1)

  // === pointer buffer: push the up, move, and down samples in that order.
  // The 8 combinations of latches form a one-hot, and every buffer cell is one
  // gather over those combinations.
  const oldSamples: SampleWires[] = samples.map(sample => ({
    ...sample,
    time: emitMaximum(circuit, circuit.roundAffine([[sample.time, 1], [frameDelta, -1]]), constant(circuit, eventTimeMinimum)),
  }))
  const patternIndex = circuit.roundAffine([[up.active, 4], [move.active, 2], [down.active, 1]])
  const patternRamps = new Map<number, Wire>()
  for (let k = -1; k <= 8; k++) patternRamps.set(k, circuit.reglu([], 1, [[patternIndex, 1]], -k))
  const patterns = Array.from({length: 8}, (_, q) => circuit.roundAffine([[patternRamps.get(q - 1)!, 1], [patternRamps.get(q)!, -2], [patternRamps.get(q + 1)!, 1]]))
  circuit.assumeOneHot(patterns)
  const merged: SampleWires[] = []
  for (let age = 0; age < cardsPointerCapacity; age++) {
    const candidates = patterns.map((_, q) => {
      const pushed = [(q & 4) !== 0 ? up : undefined, (q & 2) !== 0 ? move : undefined, (q & 1) !== 0 ? down : undefined].filter(entry => entry !== undefined)
      if (age < pushed.length) {
        const latchCells = pushed[pushed.length - 1 - age]!
        return {x: latchCells.x, y: latchCells.y, time: latchCells.time, real: one}
      }
      return oldSamples[Math.min(cardsPointerCapacity - 1, age - pushed.length)]!
    })
    const pick = (field: keyof SampleWires, minimum: number, maximum: number) => {
      const wire = circuit.affine(patterns.map((pattern, q) => [circuit.multiply(pattern, candidates[q]![field]), 1]))
      circuit.assumeRange(wire, minimum, maximum)
      return wire
    }
    merged.push({
      x: pick('x', -pointerLimit, pointerLimit),
      y: pick('y', -pointerLimit, pointerLimit),
      time: pick('time', eventTimeMinimum, 1024),
      real: pick('real', 0, 1),
    })
  }
  // The demo's buffer can grow past the capacity: a frame with an up, a move, and
  // a down pushes 3 samples and shifts once. Both sides keep the newest 24; the
  // gathers above already drop the older samples, so only the count is clamped.
  const pushedCount = circuit.roundAffine([[pointerCount, 1], [up.active, 1], [move.active, 1], [down.active, 1]])
  const mergedCount = circuit.roundAffine([[pushedCount, 1], [circuit.reglu([], 1, [[pushedCount, 1]], -cardsPointerCapacity), -1]])
  circuit.assumeRange(mergedCount, 1, cardsPointerCapacity)
  const pointerX = merged[0]!.x
  const pointerY = merged[0]!.y
  endSection('pointer state and buffer')

  // === hit test against the springs' current positions, first match in data order
  const hits = cards.map((card, c) => {
    const left = atLeastContinuous(circuit, [[pointerX, 1], [card.xPos, -1]], 0, 256)
    const right = atLeastContinuous(circuit, [[pointerX, 1], [card.xPos, -1]], -cardWidth, 256)
    const top = atLeastContinuous(circuit, [[pointerY, 1], [card.yPos, -1]], 0, 256)
    const bottom = atLeastContinuous(circuit, [[pointerY, 1], [card.yPos, -1]], -sizes[c]!, 256)
    return integerAtLeastOne(circuit, [[left, 1], [right, -1], [top, 1], [bottom, -1]], -1)
  })
  const anyHit = orBits(circuit, hits)
  endSection('hit tests')

  let firstHit: Wire[]
  if (layoutMode === 'rankCount') {
    // permutation[rank][card] = [rank[card] == rank], from shared relu ramps.
    const permutation: Wire[][] = Array.from({length: cardCount}, () => [])
    cards.forEach(card => {
      const ramps = new Map<number, Wire>()
      for (let k = -1; k <= cardCount; k++) ramps.set(k, circuit.reglu([], 1, [[card.rank, 1]], -k))
      for (let rank = 0; rank < cardCount; rank++) {
        permutation[rank]!.push(circuit.roundAffine([[ramps.get(rank - 1)!, 1], [ramps.get(rank)!, -2], [ramps.get(rank + 1)!, 1]]))
      }
    })
    permutation.forEach(row => circuit.assumeOneHot(row))
    for (let c = 0; c < cardCount; c++) circuit.assumeOneHot(permutation.map(row => row[c]!))
    const hitAtRank = permutation.map(row => {
      const wire = circuit.affine(row.map((member, c) => [circuit.multiply(member, hits[c]!), 1]))
      circuit.assumeRange(wire, 0, 1)
      return wire
    })
    const selectedRank = emitFirstActive(circuit, isFirstDown, hitAtRank)
    if (new Set(selectedRank).size === selectedRank.length) circuit.assumeOneHot(selectedRank, true)
    firstHit = cards.map((_, c) => {
      const wire = circuit.affine(permutation.map((row, rank) => [circuit.multiply(row[c]!, selectedRank[rank]!), 1]))
      circuit.assumeRange(wire, 0, 1)
      return wire
    })
  } else {
    // The first match in data order is the hit card with the smallest rank:
    // key = rank, or cardCount for a card that is not hit, then an exact integer
    // minimum tree and one equality per card.
    let level = cards.map((card, c) => circuit.roundAffine([[card.rank, 1], [hits[c]!, -cardCount]], cardCount))
    while (level.length > 1) {
      const next: Wire[] = []
      for (let index = 0; index < level.length; index += 2) {
        next.push(index + 1 < level.length ? emitMinimum(circuit, level[index]!, level[index + 1]!) : level[index]!)
      }
      level = next
    }
    const smallestHitRank = level[0]!
    firstHit = cards.map((card, c) => {
      const equal = integerAtLeastOne(circuit, [
        [integerAtLeastOne(circuit, [[card.rank, 1], [smallestHitRank, -1]], 1), 1],
        [integerAtLeastOne(circuit, [[smallestHitRank, 1], [card.rank, -1]], 1), 1],
      ], -1)
      return circuit.roundAffine([[integerAtLeastOne(circuit, [[isFirstDown, 1], [hits[c]!, 1], [equal, 1]], -2), 1]])
    })
  }
  circuit.assumeOneHot(firstHit, true)
  endSection('first match by rank')

  // === dragged card and grab offset
  const newDragged = cards.map((_, c) => circuit.roundAffine([[integerAtLeastOne(circuit, [[isDown, 1], [dragged[c]!, 1]], -1), 1], [firstHit[c]!, 1]]))
  circuit.assumeOneHot(newDragged, true)
  const anyNewDragged = circuit.affine(newDragged.map(bit => [bit, 1]))
  circuit.assumeRange(anyNewDragged, 0, 1)
  const hitX = circuit.affine(firstHit.map((bit, c) => [circuit.multiply(bit, cards[c]!.xPos), 1]))
  const hitY = circuit.affine(firstHit.map((bit, c) => [circuit.multiply(bit, cards[c]!.yPos), 1]))
  const nextDeltaX = circuit.select(isFirstDown, deltaX, circuit.roundAffine([[pointerX, 1], [hitX, -1]]))
  const nextDeltaY = circuit.select(isFirstDown, deltaY, circuit.roundAffine([[pointerY, 1], [hitY, -1]]))
  const centerX = circuit.roundAffine([[windowSizeX, 0.5]], -cardWidth / 2)
  const draggedX = circuit.roundAffine([[pointerX, 1], [nextDeltaX, -1]])
  const pinnedX = circuit.roundAffine([[draggedX, 1 - 1 / 1.5], [centerX, 1 / 1.5]])
  const pinnedY = circuit.roundAffine([[pointerY, 1], [nextDeltaY, -1]])
  endSection('drag ownership and pins')

  // === release velocity from the last 100 ms of samples
  const release = emitReleaseVelocity(circuit, merged, mergedCount, {velocityLimit: releaseVelocityLimit})
  endSection('release velocity')

  // === live reorder: the swap loops' result as counts
  const draggedRank = circuit.affine(newDragged.map((bit, c) => [circuit.multiply(bit, cards[c]!.rank), 1]))
  circuit.assumeRange(draggedRank, 0, cardCount - 1)
  const passUp: Wire[] = []
  const passDown: Wire[] = []
  cards.forEach((card, c) => {
    const before = integerAtLeastOne(circuit, [[draggedRank, 1], [card.rank, -1]], 0)
    const after = integerAtLeastOne(circuit, [[card.rank, 1], [draggedRank, -1]], 0)
    // pointerY < destY + size / 2 and pointerY > destY + size / 2. destY is on the
    // 1/64 px grid for laid-out cards, but a card released and passed in the same
    // frame still holds its pinned destination, so these use the continuous form.
    const below = notBit(circuit, atLeastContinuous(circuit, [[pointerY, 1], [card.destY, -1]], -sizes[c]! / 2, 256))
    const above = notBit(circuit, atLeastContinuous(circuit, [[card.destY, 1], [pointerY, -1]], sizes[c]! / 2, 256))
    passUp.push(integerAtLeastOne(circuit, [[anyNewDragged, 1], [before, 1], [below, 1]], -2))
    passDown.push(integerAtLeastOne(circuit, [[anyNewDragged, 1], [after, 1], [above, 1]], -2))
  })
  const totalUp = circuit.roundAffine(passUp.map(bit => [bit, 1]))
  const totalDown = circuit.roundAffine(passDown.map(bit => [bit, 1]))
  const draggedShift = circuit.roundAffine([[totalDown, 1], [totalUp, -1]])
  const nextRanks = cards.map((card, c) => {
    const rank = circuit.roundAffine([[card.rank, 1], [passUp[c]!, 1], [passDown[c]!, -1], [circuit.multiply(newDragged[c]!, draggedShift), 1]])
    circuit.assumeRange(rank, 0, cardCount - 1)
    return rank
  })
  endSection('rank update')

  let tops: Wire[]
  if (layoutMode === 'rankCount') {
    // === stack layout from ranks: top = padding + sizes of cards ranked before
    const rankedBefore: Wire[][] = cards.map(() => [])
    for (let c = 0; c < cardCount; c++) {
      for (let other = 0; other < c; other++) {
        rankedBefore[c]![other] = integerAtLeastOne(circuit, [[nextRanks[c]!, 1], [nextRanks[other]!, -1]], 0)
      }
    }
    tops = cards.map((_, c) => {
      const terms: [Wire, number][] = []
      let bias = cardsPaddingTop
      for (let other = 0; other < cardCount; other++) {
        if (other < c) terms.push([rankedBefore[c]![other]!, sizes[other]!])
        else if (other > c) {
          // [rank[other] < rank[c]] = 1 - [rank[c] < rank[other]] for a permutation
          terms.push([rankedBefore[other]![c]!, -sizes[other]!])
          bias += sizes[other]!
        }
      }
      return circuit.roundAffine(terms, bias)
    })
  } else {
    // === incremental layout: a card passed by the drag moves by the dragged
    // card's height; the card released this frame gets its top from one sum.
    const draggedSize = circuit.roundAffine(newDragged.map((bit, c) => [bit, sizes[c]!]))
    circuit.assumeRange(draggedSize, 0, Math.max(...sizes))
    const releasedRank = circuit.affine(dragged.map((bit, c) => [circuit.multiply(bit, cards[c]!.rank), 1]))
    circuit.assumeRange(releasedRank, 0, cardCount - 1)
    const releasedTop = circuit.roundAffine(cards.map((card, c) => [integerAtLeastOne(circuit, [[releasedRank, 1], [card.rank, -1]], 0), sizes[c]!]), cardsPaddingTop)
    tops = cards.map((card, c) => {
      const base = circuit.select(dragged[c]!, card.destY, releasedTop)
      const shift = circuit.roundAffine([[passUp[c]!, 1], [passDown[c]!, -1]])
      circuit.assumeRange(shift, -1, 1)
      return circuit.roundAffine([[base, 1], [circuit.multiply(shift, draggedSize), 1]])
    })
  }
  endSection('stack layout')

  // === destinations, pinning, and springs
  const releaseBits = cards.map((_, c) => integerAtLeastOne(circuit, [[isUp, 1], [dragged[c]!, 1]], -1))
  const lane = (positionIn: Wire, destination: Wire, velocityIn: Wire) => emitSpringLane(circuit, positionIn, destination, velocityIn, stepBits, springPowers)
  const destYs: Wire[] = []
  const laneResults = cards.map((card, c) => {
    const destX = circuit.select(newDragged[c]!, centerX, pinnedX)
    const destY = circuit.select(newDragged[c]!, tops[c]!, pinnedY)
    destYs.push(destY)
    const destScale = circuit.roundAffine([[newDragged[c]!, 0.1]], 1)
    const posInX = circuit.select(newDragged[c]!, card.xPos, pinnedX)
    const posInY = circuit.select(newDragged[c]!, card.yPos, pinnedY)
    const velocityInX = circuit.roundAffine([[card.xVelocity, 1], [circuit.multiply(releaseBits[c]!, release.velocityX), 1]])
    const velocityInY = circuit.roundAffine([[card.yVelocity, 1], [circuit.multiply(releaseBits[c]!, release.velocityY), 1]])
    return {
      x: lane(posInX, destX, velocityInX),
      y: lane(posInY, destY, velocityInY),
      scale: lane(card.scalePos, destScale, card.scaleVelocity),
    }
  })
  const stillAnimating = orBits(circuit, laneResults.flatMap(result => [result.x.active, result.y.active, result.scale.active]))
  endSection('springs')

  // === z bands and cursor
  const zIndex = cards.map((_, c) => {
    const lastOnly = integerAtLeastOne(circuit, [[lastDragged[c]!, 1], [newDragged[c]!, -1]], 0)
    return circuit.roundAffine([
      [nextRanks[c]!, 1],
      [circuit.multiply(newDragged[c]!, circuit.roundAffine([[nextRanks[c]!, -1]], cardCount + 2)), 1],
      [circuit.multiply(lastOnly, circuit.roundAffine([[nextRanks[c]!, -1]], cardCount + 1)), 1],
    ])
  })
  const cursor = circuit.roundAffine([[anyNewDragged, 1], [orBits(circuit, [anyNewDragged, anyHit]), 1]])

  // === commit
  const anyDragged = circuit.affine(dragged.map(bit => [bit, 1]))
  const releasedDrag = integerAtLeastOne(circuit, [[anyDragged, 1], [anyNewDragged, -1]], 0)
  const nextLastDragged = cards.map((_, c) => circuit.roundAffine([
    [integerAtLeastOne(circuit, [[lastDragged[c]!, 1], [releasedDrag, -1]], 0), 1],
    [integerAtLeastOne(circuit, [[releasedDrag, 1], [dragged[c]!, 1]], -1), 1],
  ]))
  const notUp = notBit(circuit, isUp)
  const countAfterShift = circuit.roundAffine([[mergedCount, 1], [integerAtLeastOne(circuit, [[mergedCount, 1]], -20), -1]])
  const nextCount = circuit.roundAffine([[countAfterShift, 1], [circuit.multiply(isUp, circuit.roundAffine([[countAfterShift, -1]], 1)), 1]])
  const nextSamples = merged.map((sample, age) => age === 0
    ? {x: circuit.multiply(notUp, sample.x), y: circuit.multiply(notUp, sample.y), time: sample.time, real: circuit.multiply(notUp, sample.real)}
    : sample)
  const nextBacklog = circuit.multiply(stillAnimating, circuit.roundAffine([[elapsed, 1], [steps, -4]]))
  endSection('z, cursor, and commit')

  const nextSource: [cell: Wire, wire: Wire][] = [
    [wasDown, notUp],
    ...dragged.map((cell, c): [Wire, Wire] => [cell, newDragged[c]!]),
    [deltaX, nextDeltaX],
    [deltaY, nextDeltaY],
    ...lastDragged.map((cell, c): [Wire, Wire] => [cell, nextLastDragged[c]!]),
    [pointerCount, nextCount],
    ...samples.flatMap((sample, age): [Wire, Wire][] => [
      [sample.x, nextSamples[age]!.x],
      [sample.y, nextSamples[age]!.y],
      [sample.time, nextSamples[age]!.time],
      [sample.real, nextSamples[age]!.real],
    ]),
    [animating, stillAnimating],
    [backlog, nextBacklog],
    ...cards.flatMap((card, c): [Wire, Wire][] => [
      [card.rank, nextRanks[c]!],
      [card.xPos, laneResults[c]!.x.position],
      [card.xVelocity, laneResults[c]!.x.velocity],
      [card.yPos, laneResults[c]!.y.position],
      [card.yVelocity, laneResults[c]!.y.velocity],
      [card.scalePos, laneResults[c]!.scale.position],
      [card.scaleVelocity, laneResults[c]!.scale.velocity],
      [card.destY, destYs[c]!],
    ]),
  ]
  const outputs = {
    x: laneResults.map(result => result.x.position),
    y: laneResults.map(result => result.y.position),
    scale: laneResults.map(result => result.scale.position),
    zIndex,
    dragged: newDragged,
    cursor,
    stillAnimating,
    mergedCount,
  }
  const roots = [...nextSource.map(([, wire]) => wire), ...outputs.x, ...outputs.y, ...outputs.scale, ...zIndex, ...newDragged, cursor, stillAnimating, mergedCount]
  return {
    circuit, sizes, sections, nextSource, outputs, roots, layout: layoutMode,
    cells: {windowSizeX, frameDelta, up, move, down, wasDown, dragged, deltaX, deltaY, lastDragged, pointerCount, samples, animating, backlog, cards},
  }
}

export type CardsFrameInput = {
  frameTime: number
  windowSizeX: number
  events: {
    mouseup: {pageX: number, pageY: number, timeStamp: number} | null
    mousemove: {pageX: number, pageY: number, timeStamp: number} | null
    pointerdown: {pageX: number, pageY: number, timeStamp: number} | null
  }
}

export type CardsFrameOutput = {
  x: number[]
  y: number[]
  scale: number[]
  zIndex: number[]
  dragged: boolean[]
  order: number[]
  cursor: 'auto' | 'grab' | 'grabbing'
  stillAnimating: boolean
  pointerLength: number
}

export function createCardsMachine(built: CardsCircuit, initialWindowSizeX: number) {
  const {circuit, cells, nextSource, roots, sizes} = built
  const cardCount = sizes.length
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(circuit.sourceSize)
  source[cells.windowSizeX] = initialWindowSizeX
  source[cells.pointerCount] = 1
  source[cells.samples[0]!.time] = eventTimeMinimum
  cells.cards.forEach((card, c) => {
    source[card.rank] = c
    source[card.xPos] = (initialWindowSizeX - cardWidth) / 2
    source[card.scalePos] = 1
  })
  let previousFrameTime: number | undefined
  const outputStart = nextSource.length
  const cursorNames = ['auto', 'grab', 'grabbing'] as const
  function writeLatch(latch: Latch, event: {pageX: number, pageY: number, timeStamp: number} | null, frameTime: number) {
    source[latch.active] = event === null ? 0 : 1
    source[latch.x] = event === null ? 0 : event.pageX
    source[latch.y] = event === null ? 0 : event.pageY
    source[latch.time] = event === null ? 0 : Math.max(eventTimeMinimum, event.timeStamp - frameTime)
  }
  return {
    source,
    // beforeEvaluate sees the source table with this frame's inputs written, e.g.
    // to check the one-hot groups on the reference evaluator.
    step(input: CardsFrameInput, beforeEvaluate?: (source: Float32Array) => void): CardsFrameOutput {
      source[cells.windowSizeX] = input.windowSizeX
      source[cells.frameDelta] = previousFrameTime === undefined ? 0 : Math.min(frameDeltaMaximum, input.frameTime - previousFrameTime)
      previousFrameTime = input.frameTime
      writeLatch(cells.up, input.events.mouseup, input.frameTime)
      writeLatch(cells.move, input.events.mousemove, input.frameTime)
      writeLatch(cells.down, input.events.pointerdown, input.frameTime)
      beforeEvaluate?.(source)
      const values = evaluate(source)
      for (let index = 0; index < nextSource.length; index++) source[nextSource[index]![0]] = values[index]!
      writeLatch(cells.up, null, 0)
      writeLatch(cells.move, null, 0)
      writeLatch(cells.down, null, 0)
      const read = (offset: number) => values[outputStart + offset]!
      const output: CardsFrameOutput = {
        x: Array.from({length: cardCount}, (_, c) => read(c)),
        y: Array.from({length: cardCount}, (_, c) => read(cardCount + c)),
        scale: Array.from({length: cardCount}, (_, c) => read(2 * cardCount + c)),
        zIndex: Array.from({length: cardCount}, (_, c) => read(3 * cardCount + c)),
        dragged: Array.from({length: cardCount}, (_, c) => read(4 * cardCount + c) === 1),
        order: [],
        cursor: cursorNames[read(5 * cardCount)]!,
        stillAnimating: read(5 * cardCount + 1) === 1,
        pointerLength: read(5 * cardCount + 2),
      }
      const ranks = cells.cards.map(card => source[card.rank]!)
      output.order = ranks.map((_, c) => c).sort((left, right) => ranks[left]! - ranks[right]!)
      return output
    },
  }
}

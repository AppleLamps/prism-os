// gesture-flick-snap-target as one circuit. The demo renders two superposed
// springs, spring1 (release position with the flick velocity toward the decay
// rest position) plus spring2 (rest position toward the corner) minus the rest
// position. With equal stiffness and damping each Euler step is linear, so the
// sum is one spring from the release position with the flick velocity toward
// the corner; the rest position only picks the corner and places the marker.
//
// Host contract: the same as cards.ts (1/64 ms frame and event times, event
// times relative to the frame time, 1/64 px pointer coordinates within ±2^15 px).
// Like cards.ts, the release velocity is clamped to ±2^16 px/s per axis, in this
// circuit and in flick-reference.ts; the demo has no clamp. Spring velocity cells
// are declared as ±2^20 px/s.
import {emitMaximum, emitMinimum, type Wire} from '../../../numeric-ui-core.ts'
import {
  SourceLayout,
  andBits,
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

export const pipWidth = 120
export const pipHeight = 80
export const pipCornerPad = 20
export const flickHistoryCapacity = 20
const frameDeltaMaximum = 2 ** 14
const eventTimeMinimum = -(2 ** 16)
const pointerLimit = 2 ** 15
const positionLimit = 2 ** 16
const velocityLimit = 2 ** 20
const stageCount = 9
const springPowers = stagePowers(eulerStepMatrix(290, 24, 0.004), stageCount)

type Latch = {active: Wire, x: Wire, y: Wire, time: Wire}

export type FlickCircuit = ReturnType<typeof buildFlick>

export function buildFlick() {
  const layout = new SourceLayout()
  const windowW = layout.cell(pipWidth + 2 * pipCornerPad, 8192)
  const windowH = layout.cell(pipHeight + 2 * pipCornerPad, 8192)
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
  const dragging = layout.cell(0, 1)
  const offsetX = layout.cell(-2 * positionLimit, 2 * positionLimit)
  const offsetY = layout.cell(-2 * positionLimit, 2 * positionLimit)
  const dragPosX = layout.cell(-positionLimit, positionLimit)
  const dragPosY = layout.cell(-positionLimit, positionLimit)
  const historyCount = layout.cell(0, flickHistoryCapacity)
  const history = Array.from({length: flickHistoryCapacity}, () => ({
    x: layout.cell(-pointerLimit, pointerLimit),
    y: layout.cell(-pointerLimit, pointerLimit),
    time: layout.cell(eventTimeMinimum, 1024),
  }))
  const springPosX = layout.cell(-positionLimit, positionLimit)
  const springPosY = layout.cell(-positionLimit, positionLimit)
  const springVelocityX = layout.cell(-velocityLimit, velocityLimit)
  const springVelocityY = layout.cell(-velocityLimit, velocityLimit)
  const springDestX = layout.cell(-positionLimit, positionLimit)
  const springDestY = layout.cell(-positionLimit, positionLimit)
  const restX = layout.cell(-positionLimit, positionLimit)
  const restY = layout.cell(-positionLimit, positionLimit)
  const showMarker = layout.cell(0, 1)
  const animating = layout.cell(0, 1)
  const backlog = layout.cell(0, 2 ** 15)
  const circuit = layout.createCircuit()
  const one = constant(circuit, 1)

  // === events: the demo takes the coordinates of the last assigned event, in
  // the order mouseup, mousemove, pointerdown
  const pick = (field: 'x' | 'y' | 'time') => circuit.select(down.active, circuit.select(move.active, up[field], move[field]), down[field])
  const pointerX = pick('x')
  const pointerY = pick('y')
  const pointerDefined = orBits(circuit, [up.active, move.active, down.active])
  const hitBox = (boxX: Wire, boxY: Wire) => {
    const left = atLeastContinuous(circuit, [[pointerX, 1], [boxX, -1]], 0, 256)
    const right = atLeastContinuous(circuit, [[pointerX, 1], [boxX, -1]], -pipWidth, 256)
    const top = atLeastContinuous(circuit, [[pointerY, 1], [boxY, -1]], 0, 256)
    const bottom = atLeastContinuous(circuit, [[pointerY, 1], [boxY, -1]], -pipHeight, 256)
    return integerAtLeastOne(circuit, [[left, 1], [right, -1], [top, 1], [bottom, -1]], -1)
  }
  const currentX = circuit.select(dragging, springPosX, dragPosX)
  const currentY = circuit.select(dragging, springPosY, dragPosY)
  const hitDown = andBits(circuit, [down.active, hitBox(currentX, currentY)])
  const dragging1 = orBits(circuit, [dragging, hitDown])
  const offset1X = circuit.select(hitDown, offsetX, circuit.roundAffine([[pointerX, 1], [currentX, -1]]))
  const offset1Y = circuit.select(hitDown, offsetY, circuit.roundAffine([[pointerY, 1], [currentY, -1]]))
  const dragPos1X = circuit.select(hitDown, dragPosX, currentX)
  const dragPos1Y = circuit.select(hitDown, dragPosY, currentY)
  const moving = andBits(circuit, [dragging1, move.active])
  const upping = andBits(circuit, [dragging1, up.active])
  const followsPointer = orBits(circuit, [moving, upping])
  const dragPos2X = circuit.select(followsPointer, dragPos1X, circuit.roundAffine([[pointerX, 1], [offset1X, -1]]))
  const dragPos2Y = circuit.select(followsPointer, dragPos1Y, circuit.roundAffine([[pointerY, 1], [offset1Y, -1]]))
  const dragging3 = integerAtLeastOne(circuit, [[dragging1, 1], [up.active, -1]], 0)

  // === history: reset to [down sample] on a hit, then push on move and on up.
  // The 8 combinations of (reset, move push, up push) form a one-hot.
  const oldHistory = history.map(sample => ({
    ...sample,
    time: emitMaximum(circuit, circuit.roundAffine([[sample.time, 1], [frameDelta, -1]]), constant(circuit, eventTimeMinimum)),
  }))
  const patternIndex = circuit.roundAffine([[hitDown, 4], [moving, 2], [upping, 1]])
  const ramps = new Map<number, Wire>()
  for (let k = -1; k <= 8; k++) ramps.set(k, circuit.reglu([], 1, [[patternIndex, 1]], -k))
  const patterns = Array.from({length: 8}, (_, q) => circuit.roundAffine([[ramps.get(q - 1)!, 1], [ramps.get(q)!, -2], [ramps.get(q + 1)!, 1]]))
  circuit.assumeOneHot(patterns)
  const pushedCount = (q: number) => ((q & 2) !== 0 ? 1 : 0) + ((q & 1) !== 0 ? 1 : 0)
  const merged: SampleWires[] = Array.from({length: flickHistoryCapacity}, (_, age) => {
    const candidate = (q: number) => {
      const reset = (q & 4) !== 0
      const fresh = pushedCount(q) + (reset ? 1 : 0)
      if (age < fresh) return {x: pointerX, y: pointerY, time: circuit.roundAffine([[pick('time'), 1]])}
      return oldHistory[Math.min(flickHistoryCapacity - 1, age - pushedCount(q))]!
    }
    const read = (field: 'x' | 'y' | 'time', minimum: number, maximum: number) => {
      const wire = circuit.affine(patterns.map((pattern, q) => [circuit.multiply(pattern, candidate(q)[field]), 1]))
      circuit.assumeRange(wire, minimum, maximum)
      return wire
    }
    return {x: read('x', -pointerLimit, pointerLimit), y: read('y', -pointerLimit, pointerLimit), time: read('time', eventTimeMinimum, 1024), real: one}
  })
  const countCandidates = patterns.map((_, q) => (q & 4) !== 0
    ? constant(circuit, 1 + pushedCount(q))
    : emitMinimum(circuit, circuit.roundAffine([[historyCount, 1]], pushedCount(q)), constant(circuit, flickHistoryCapacity)))
  const nextHistoryCount = circuit.affine(patterns.map((pattern, q) => [circuit.multiply(pattern, countCandidates[q]!), 1]))
  circuit.assumeRange(nextHistoryCount, 0, flickHistoryCapacity)

  // === release: velocity, decay rest position, nearest corner, one spring
  const release = emitReleaseVelocity(circuit, merged, nextHistoryCount, {velocityLimit: releaseVelocityLimit})
  const releaseRestX = circuit.roundAffine([[dragPos2X, 1], [release.velocityX, 1 / 4.5]])
  const releaseRestY = circuit.roundAffine([[dragPos2Y, 1], [release.velocityY, 1 / 4.5]])
  // The corners are {20, w - 140} x {20, h - 100}; squared distance separates by
  // axis, and the demo's strict < over [top-left, top-right, bottom-left,
  // bottom-right] sends exact ties to the left and to the top.
  const rightSide = notBit(circuit, atLeastContinuous(circuit, [[windowW, 0.5], [releaseRestX, -1]], -(pipWidth / 2), 256))
  const bottomSide = notBit(circuit, atLeastContinuous(circuit, [[windowH, 0.5], [releaseRestY, -1]], -(pipHeight / 2), 256))
  const cornerX = circuit.select(rightSide, constant(circuit, pipCornerPad), circuit.roundAffine([[windowW, 1]], -pipWidth - pipCornerPad))
  const cornerY = circuit.select(bottomSide, constant(circuit, pipCornerPad), circuit.roundAffine([[windowH, 1]], -pipHeight - pipCornerPad))
  const nextRestX = circuit.select(upping, restX, releaseRestX)
  const nextRestY = circuit.select(upping, restY, releaseRestY)
  const startPosX = circuit.select(upping, springPosX, dragPos2X)
  const startPosY = circuit.select(upping, springPosY, dragPos2Y)
  const startVelocityX = circuit.select(upping, springVelocityX, release.velocityX)
  const startVelocityY = circuit.select(upping, springVelocityY, release.velocityY)
  const destX = circuit.select(upping, springDestX, cornerX)
  const destY = circuit.select(upping, springDestY, cornerY)

  // === animation, only while not dragging
  const animatingEffective = integerAtLeastOne(circuit, [[animating, 1], [upping, -1]], 0)
  const {elapsed, steps, stepBits} = emitCatchUpClock(circuit, animatingEffective, backlog, frameDelta, stageCount)
  const lane = (position: Wire, destination: Wire, velocity: Wire) => {
    const stepped = emitSpringLane(circuit, position, destination, velocity, stepBits, springPowers)
    return {
      position: circuit.select(dragging3, stepped.position, position),
      velocity: circuit.select(dragging3, stepped.velocity, velocity),
      active: stepped.active,
    }
  }
  const laneX = lane(startPosX, destX, startVelocityX)
  const laneY = lane(startPosY, destY, startVelocityY)
  const stillAnimating = integerAtLeastOne(circuit, [[orBits(circuit, [laneX.active, laneY.active]), 1], [dragging3, -1]], 0)
  const nextBacklog = circuit.multiply(stillAnimating, circuit.roundAffine([[elapsed, 1], [steps, -4]]))

  // === projection
  const renderX = circuit.select(dragging3, laneX.position, dragPos2X)
  const renderY = circuit.select(dragging3, laneY.position, dragPos2Y)
  const cursorHit = andBits(circuit, [pointerDefined, hitBox(renderX, renderY)])
  const cursor = circuit.roundAffine([[dragging3, 1], [orBits(circuit, [dragging3, cursorHit]), 1]])
  const scheduleAnother = orBits(circuit, [dragging3, stillAnimating])
  const nextShowMarker = orBits(circuit, [showMarker, upping])

  const nextSource: [cell: Wire, wire: Wire][] = [
    [dragging, dragging3],
    [offsetX, offset1X],
    [offsetY, offset1Y],
    [dragPosX, dragPos2X],
    [dragPosY, dragPos2Y],
    [historyCount, nextHistoryCount],
    ...history.flatMap((sample, age): [Wire, Wire][] => [[sample.x, merged[age]!.x], [sample.y, merged[age]!.y], [sample.time, merged[age]!.time]]),
    [springPosX, laneX.position],
    [springPosY, laneY.position],
    [springVelocityX, laneX.velocity],
    [springVelocityY, laneY.velocity],
    [springDestX, destX],
    [springDestY, destY],
    [restX, nextRestX],
    [restY, nextRestY],
    [showMarker, nextShowMarker],
    [animating, stillAnimating],
    [backlog, nextBacklog],
  ]
  const outputs = [renderX, renderY, nextShowMarker, nextRestX, nextRestY, cursor, scheduleAnother]
  const roots = [...nextSource.map(([, wire]) => wire), ...outputs]
  return {
    circuit, nextSource, roots,
    cells: {windowW, windowH, frameDelta, up, move, down, springPosX, springPosY, springDestX, springDestY, restX, restY, history},
  }
}

export type FlickFrameInput = {
  frameTime: number
  windowW: number
  windowH: number
  events: {
    mouseup: {pageX: number, pageY: number, timeStamp: number} | null
    mousemove: {pageX: number, pageY: number, timeStamp: number} | null
    pointerdown: {pageX: number, pageY: number, timeStamp: number} | null
  }
}

export function createFlickMachine(built: FlickCircuit, windowW: number, windowH: number) {
  const {circuit, cells, nextSource, roots} = built
  const evaluate = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(circuit.sourceSize)
  const cornerX = pipCornerPad
  const cornerY = windowH - pipHeight - pipCornerPad
  source[cells.windowW] = windowW
  source[cells.windowH] = windowH
  source[cells.springPosX] = cornerX
  source[cells.springDestX] = cornerX
  source[cells.restX] = cornerX
  source[cells.springPosY] = cornerY
  source[cells.springDestY] = cornerY
  source[cells.restY] = cornerY
  let previousFrameTime: number | undefined
  const writeLatch = (latch: Latch, event: {pageX: number, pageY: number, timeStamp: number} | null, frameTime: number) => {
    source[latch.active] = event === null ? 0 : 1
    source[latch.x] = event === null ? 0 : event.pageX
    source[latch.y] = event === null ? 0 : event.pageY
    source[latch.time] = event === null ? 0 : Math.max(eventTimeMinimum, event.timeStamp - frameTime)
  }
  const cursorNames = ['auto', 'grab', 'grabbing'] as const
  return {
    source,
    step(input: FlickFrameInput) {
      source[cells.windowW] = input.windowW
      source[cells.windowH] = input.windowH
      source[cells.frameDelta] = previousFrameTime === undefined ? 0 : Math.min(frameDeltaMaximum, input.frameTime - previousFrameTime)
      previousFrameTime = input.frameTime
      writeLatch(cells.up, input.events.mouseup, input.frameTime)
      writeLatch(cells.move, input.events.mousemove, input.frameTime)
      writeLatch(cells.down, input.events.pointerdown, input.frameTime)
      const values = evaluate(source)
      for (let index = 0; index < nextSource.length; index++) source[nextSource[index]![0]] = values[index]!
      writeLatch(cells.up, null, 0)
      writeLatch(cells.move, null, 0)
      writeLatch(cells.down, null, 0)
      const base = nextSource.length
      return {
        x: values[base]!,
        y: values[base + 1]!,
        showRestMarker: values[base + 2] === 1,
        restX: values[base + 3]!,
        restY: values[base + 4]!,
        cursor: cursorNames[values[base + 5]!]!,
        scheduleAnother: values[base + 6] === 1,
      }
    },
  }
}

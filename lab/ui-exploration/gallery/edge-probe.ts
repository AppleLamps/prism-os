// Pointers right next to box edges. index.ts keeps box edges in float64 and the circuit keeps them in
// FP32. Far down the page the two drift apart, e.g. 0.18px at 98,197px, because row tops are prefix
// sums of non-integer row heights. The kit's comparisons are exact on their FP32 inputs, so hover and
// click decisions should only differ from index.ts for pointers between index.ts's version of an edge
// and the circuit's version. This probe tries quarter-pixel pointers around every onscreen box edge,
// compares the cursor (hover) and the URL focus after a click, and sorts each mismatch by whether the
// pointer lies between the two versions of the edge.
import {createPair} from './differential.ts'
import type {GalleryCircuit} from './gallery-circuit.ts'

export type EdgeProbeOptions = {
  built: GalleryCircuit
  width: number
  height: number
  // 0 is the top of the page, 1 the bottom.
  scrollFraction: number
  maximumClickTrials?: number
}

type EdgeName = 'top' | 'bottom' | 'left' | 'right'

type EdgePoint = {
  photo: number
  edge: EdgeName
  clientX: number
  clientY: number
  referenceEdge: number
  circuitEdge: number
  // index.ts's edge and the circuit's edge disagree about whether this pointer is inside the box.
  betweenEdges: boolean
}

export type EdgeProbeResult = {
  width: number
  height: number
  scrollY: number
  largestEdgeDrift: number
  points: number
  pointsBetweenEdges: number
  hoverMismatches: number
  hoverMismatchesBetweenEdges: number
  clickTrials: number
  clickTrialsBetweenEdges: number
  clickMismatches: number
  clickMismatchesBetweenEdges: number
  examples: string[]
}

const quarterPixel = (value: number) => Math.round(value * 4) / 4

function setUp(options: EdgeProbeOptions) {
  const pair = createPair({seed: 0, frames: 0, width: options.width, height: options.height, resync: false, built: options.built})
  let now = 1000
  const render = () => {
    now += 16.5
    pair.reference.render(now)
    pair.app.render(now)
  }
  // The right 24px gap never holds a box, so this pointer hovers nothing and adds no magnet offset.
  const moveAway = () => {
    pair.reference.mousemove(options.width - 2, 2)
    pair.app.mousemove(options.width - 2, 2)
  }
  render()
  // Both sides get the same integer scroll position, below either side's scroll limit.
  const maximumScroll = Math.min(pair.referenceBrowser.documentHeight(), pair.appBrowser.documentHeight()) - options.height
  const scrollY = Math.floor(options.scrollFraction * Math.max(0, maximumScroll))
  pair.referenceBrowser.scrollY = scrollY
  pair.appBrowser.scrollY = scrollY
  render()
  moveAway()
  render()
  return {...pair, render, moveAway, scrollY}
}

function edgePoints(pair: ReturnType<typeof setUp>): EdgePoint[] {
  const {reference, app, referenceBrowser} = pair
  const {cells} = app.machine.built
  const source = app.machine.source
  const {scrollX, scrollY, clientWidth, clientHeight} = referenceBrowser
  const atLeast = (local: number, edge: number) => local >= edge
  const below = (local: number, edge: number) => local < edge
  const points: EdgePoint[] = []
  reference.data.forEach((box, photo) => {
    const springs = cells.photos[photo]!.springs
    const circuitX = source[springs.x.destination]!
    const circuitY = source[springs.y.destination]!
    // The circuit's hit test adds position and size in FP32 before comparing (gallery-circuit.ts, hitBits).
    const circuitRight = Math.fround(circuitX + source[springs.sizeX.destination]!)
    const circuitBottom = Math.fround(circuitY + source[springs.sizeY.destination]!)
    const centerClientX = quarterPixel(box.x.dest + box.sizeX.dest / 2 - scrollX)
    const centerClientY = quarterPixel(box.y.dest + box.sizeY.dest / 2 - scrollY)
    const edges: [EdgeName, boolean, number, number, (local: number, edge: number) => boolean][] = [
      ['top', true, box.y.dest, circuitY, atLeast],
      ['bottom', true, box.y.dest + box.sizeY.dest, circuitBottom, below],
      ['left', false, box.x.dest, circuitX, atLeast],
      ['right', false, box.x.dest + box.sizeX.dest, circuitRight, below],
    ]
    for (const [edge, vertical, referenceEdge, circuitEdge, inside] of edges) {
      const low = Math.min(referenceEdge, circuitEdge)
      const high = Math.max(referenceEdge, circuitEdge)
      for (let local = Math.floor(low * 4) / 4 - 0.25; local <= high + 0.25; local += 0.25) {
        const clientX = vertical ? centerClientX : local - scrollX
        const clientY = vertical ? local - scrollY : centerClientY
        if (clientX < 0 || clientX > clientWidth || clientY < 0 || clientY > clientHeight) continue
        points.push({photo, edge, clientX, clientY, referenceEdge, circuitEdge, betweenEdges: inside(local, referenceEdge) !== inside(local, circuitEdge)})
      }
    }
  })
  return points
}

export function probeEdges(options: EdgeProbeOptions): EdgeProbeResult {
  const hoverPair = setUp(options)
  const points = edgePoints(hoverPair)
  const result: EdgeProbeResult = {
    width: options.width, height: options.height, scrollY: hoverPair.scrollY,
    largestEdgeDrift: points.reduce((largest, point) => Math.max(largest, Math.abs(point.referenceEdge - point.circuitEdge)), 0),
    points: points.length, pointsBetweenEdges: points.filter(point => point.betweenEdges).length,
    hoverMismatches: 0, hoverMismatchesBetweenEdges: 0,
    clickTrials: 0, clickTrialsBetweenEdges: 0, clickMismatches: 0, clickMismatchesBetweenEdges: 0,
    examples: [],
  }
  const describe = (point: EdgePoint, what: string) =>
    `${options.width}x${options.height} scrollY ${hoverPair.scrollY}, photo ${point.photo} ${point.edge} edge at client (${point.clientX}, ${point.clientY}): index.ts edge ${point.referenceEdge}, circuit edge ${point.circuitEdge}; ${what}`

  for (const point of points) {
    hoverPair.reference.mousemove(point.clientX, point.clientY)
    hoverPair.app.mousemove(point.clientX, point.clientY)
    hoverPair.render()
    const referenceCursor = hoverPair.reference.body.styleValues.get('cursor')
    const circuitCursor = hoverPair.view.cursor
    if (referenceCursor !== circuitCursor) {
      result.hoverMismatches++
      if (point.betweenEdges) result.hoverMismatchesBetweenEdges++
      if (result.examples.length < 6) result.examples.push(describe(point, `index.ts cursor ${referenceCursor}, circuit cursor ${circuitCursor}`))
    }
    hoverPair.moveAway()
    hoverPair.render()
  }

  // Each click gets a fresh pair, because a click that opens a photo changes the state.
  const clickPoints = [...points.filter(point => point.betweenEdges), ...points.filter(point => !point.betweenEdges)]
    .slice(0, options.maximumClickTrials ?? Infinity)
  for (const point of clickPoints) {
    const trial = setUp(options)
    trial.reference.click(point.clientX, point.clientY, 'box', point.photo)
    trial.app.click(point.clientX, point.clientY, -1)
    trial.render()
    result.clickTrials++
    if (point.betweenEdges) result.clickTrialsBetweenEdges++
    if (trial.referenceBrowser.hash !== trial.appBrowser.hash) {
      result.clickMismatches++
      if (point.betweenEdges) result.clickMismatchesBetweenEdges++
      if (result.examples.length < 6) {
        const shortHash = (hash: string) => hash === '' ? 'none' : hash.slice(0, 9)
        result.examples.push(describe(point, `after a click index.ts focus ${shortHash(trial.referenceBrowser.hash)}, circuit focus ${shortHash(trial.appBrowser.hash)}`))
      }
    }
  }
  return result
}

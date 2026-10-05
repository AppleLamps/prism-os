import {expect, test} from 'bun:test'
import {createPortLayout, loadCaptionBreakpoints, type PortRect} from './captions-reference.ts'
import {createGalleryMachine, initializeSource} from './gallery-app.ts'
import {buildGalleryCircuit} from './gallery-circuit.ts'
import {photoGalleryData} from './photo-data.ts'

const breakpoints = loadCaptionBreakpoints()
const built = buildGalleryCircuit(photoGalleryData, {captions: breakpoints})
const machine = createGalleryMachine(built)
const port = createPortLayout(photoGalleryData, breakpoints)
const sources = port.makeLayoutSources(photoGalleryData)

// Circuit destinations with no pointer, no events, and the given URL focus.
export function circuitDestinations(width: number, height: number, scrollY: number, focused: number): PortRect[] {
  const {cells, outputs} = built
  initializeSource(machine, photoGalleryData, width, height, scrollY)
  machine.source[cells.scrollY] = scrollY
  machine.source[cells.committedScrollY] = scrollY
  machine.source[cells.focusedIndex] = Math.max(0, focused)
  machine.source[cells.focusedPresent] = focused >= 0 ? 1 : 0
  machine.step()
  return outputs.photos.map(photo => ({
    x: machine.read(photo.destX), y: machine.read(photo.destY), sizeX: machine.read(photo.destSizeX), sizeY: machine.read(photo.destSizeY),
  }))
}

function compare(expected: PortRect[], actual: PortRect[]) {
  let lineDecisionMismatches = 0
  let maximumPositionError = 0
  let maximumSizeError = 0
  expected.forEach((rect, index) => {
    const other = actual[index]!
    // A different line count moves the box height by a whole line (18px or 18.67px).
    if (Math.abs(rect.sizeY - other.sizeY) > 1) lineDecisionMismatches++
    else {
      maximumSizeError = Math.max(maximumSizeError, Math.abs(rect.sizeX - other.sizeX), Math.abs(rect.sizeY - other.sizeY))
      maximumPositionError = Math.max(maximumPositionError, Math.abs(rect.x - other.x), Math.abs(rect.y - other.y))
    }
  })
  return {lineDecisionMismatches, maximumPositionError, maximumSizeError}
}

test('grid with measured captions matches the chenguini port layout across widths', () => {
  let checked = 0
  const captionHeights = new Map<number, number>()
  for (const width of [320, 333, 390, 512, 600, 756, 800, 1000, 1024, 1280, 1440, 1732, 1920, 2000]) {
    const expected = port.getGridLayout(sources, width).items.map(item => item.layoutBox)
    const result = compare(expected, circuitDestinations(width, 900, 0, -1))
    expect(result.lineDecisionMismatches).toBe(0)
    expect(result.maximumSizeError).toBeLessThan(0.01)
    expect(result.maximumPositionError).toBeLessThan(0.1)
    checked += expected.length
    expected.forEach((rect, index) => {
      // Height below the image: 8 + 18 * lines + 8, so 34 for one line and 52 for two.
      const below = Math.round(rect.sizeY - rect.sizeX * photoGalleryData[index]!.h / photoGalleryData[index]!.w)
      captionHeights.set(below, (captionHeights.get(below) ?? 0) + 1)
    })
  }
  expect(checked).toBe(14 * 221)
  expect(captionHeights.get(34) ?? 0).toBeGreaterThan(100)
  expect(captionHeights.get(52) ?? 0).toBeGreaterThan(100)
})

test('strip with the caption fixed point matches the chenguini port layout', () => {
  let seed = 11
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const lineCounts = new Set<number>()
  for (let trial = 0; trial < 30; trial++) {
    const width = 320 + Math.floor(random() * 1680)
    const height = 480 + Math.floor(random() * 920)
    const focused = Math.floor(random() * photoGalleryData.length)
    const scrollY = Math.round(random() * 4000 * 4) / 4
    const expected = port.getLineLayout(sources, focused, width, height, scrollY).items.map(item => item.layoutBox)
    const actual = circuitDestinations(width, height, scrollY, focused)
    const result = compare(expected, actual)
    expect(result.lineDecisionMismatches).toBe(0)
    expect(result.maximumSizeError).toBeLessThan(0.02)
    expect(result.maximumPositionError).toBeLessThan(0.5)
    const focusedItem = expected[focused]!
    const imageHeight = focusedItem.sizeX * photoGalleryData[focused]!.h / photoGalleryData[focused]!.w
    lineCounts.add(Math.round((focusedItem.sizeY - imageHeight - 16) / (56 / 3)))
  }
  // The trials must reach more than one settled caption height.
  expect(lineCounts.size).toBeGreaterThan(1)
})

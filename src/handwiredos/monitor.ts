// The footer of the Files window, and the system bar's counters: how large the
// compiled program is, and how long it ran in each of the last 60 frames.
// Everything here is JavaScript text and SVG that the page computes from the
// compiled program and from the frame times. None of it is an output of the program.
//
// The mount calls createMonitor once, and update after each frame with the time the
// program took in that frame.
import {type Circuit, invariant} from '../runtime/numeric-ui-core.ts'

type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

// How many frames the chart shows.
export const frameCapacity = 60

// The stored weights, and the bytes of every array the program holds. The index
// reads of one table share one array of the table's positions, e.g. HandwiredOS's
// 2,320 index reads share 5 arrays of 1,572 bytes in all, so each array is counted
// once, however many reads point at it.
/** @public */
export function measureProgram(program: TensorProgram) {
  let weights = 0
  let bytes = program.roots.byteLength + program.wireOrder.byteLength
  const indexTables = new Set<ArrayBufferView>()
  for (const layer of program.layers) {
    weights += layer.weights.length
    bytes +=
      layer.weights.byteLength
      + layer.bias.byteLength
      + layer.inputIndices.byteLength
      + layer.gateRows.byteLength
      + layer.booleanRows.byteLength
      + layer.rowOffsets.byteLength
      + layer.columns.byteLength
    for (const compute of layer.gatherComputes) bytes += compute.bitPositions.byteLength
    for (const read of layer.gatherReads) bytes += read.candidatePositions.byteLength
    for (const read of layer.indexReads) indexTables.add(read.candidatePositions)
  }
  for (const table of indexTables) bytes += table.byteLength
  return {weights, bytes}
}

// The top of the chart's scale for the longest frame it shows: the smallest of 1,
// 2, 5, 10, 20, 50 ms and so on that the frame fits under, e.g. 5 for 3.2 ms.
/** @public */
export function frameTimeScale(longestMs: number) {
  for (let magnitude = 1; ; magnitude *= 10) {
    for (const step of [1, 2, 5]) {
      if (step * magnitude >= longestMs) return step * magnitude
    }
  }
}

// The chart's line as an SVG path in a box `capacity - 1` wide and 1 tall: one
// point per frame, the last frame at the right edge, 0 ms at the bottom and `scale`
// ms at the top. E.g. the times [0.5, 1] with capacity 60 and scale 1 give
// 'M58 0.500L59 0.000'.
/** @public */
export function frameTimesPath(times: readonly number[], capacity: number, scale: number) {
  const first = capacity - times.length
  return `M${times.map((time, index) => `${first + index} ${(1 - Math.min(time / scale, 1)).toFixed(3)}`).join('L')}`
}

const formatCount = (value: number) => value.toLocaleString('en-US')
// 1 KB is 1,000 bytes, e.g. 386,312 bytes is ['386', 'KB'].
const formatBytes = (bytes: number) => bytes < 999_500 ? [`${Math.round(bytes / 1_000)}`, 'KB'] : [(bytes / 1_000_000).toFixed(1), 'MB']
// Browsers report times in steps of 0.1 ms or coarser, e.g. '0.40'.
const formatMilliseconds = (value: number) => value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : formatCount(Math.round(value))

export function createMonitor(elements: {footer: HTMLElement, statistics: HTMLElement}, program: TensorProgram) {
  const operations = program.valueCount - program.sourceSize
  const {weights, bytes} = measureProgram(program)
  const [size, sizeUnit] = formatBytes(bytes)
  // The counts, the most important first: a footer too narrow for all of them shows
  // the first ones. The sidebar above the footer shows the number of operations.
  const counts = [
    {count: formatCount(program.layers.length), noun: 'layers', title: 'The operations of one layer read only earlier layers, so they can run together.'},
    {count: formatCount(weights), noun: 'weights', title: 'The numbers that the program stores: what each operation multiplies earlier values by.'},
    {count: size, noun: sizeUnit, title: 'The bytes of every array that the compiled program holds.'},
  ]

  elements.statistics.innerHTML =
    `<span><b>${formatCount(operations)}</b> operations</span>`
    + `<span><b>${formatCount(program.layers.length)}</b> layers</span>`
    + '<span><b class="system-frame-time"></b> ms in the last frame</span>'
  elements.footer.innerHTML = `
    <ul class="monitor-counts">
      ${counts.map(entry => `<li title="${entry.title}"><b>${entry.count}</b> ${entry.noun}</li>`).join('')}
    </ul>
    <div class="monitor-frame">
      <svg class="monitor-chart" viewBox="0 0 ${frameCapacity - 1} 1" preserveAspectRatio="none" aria-hidden="true">
        <path class="area"/><path class="line"/><path class="end"/>
      </svg>
      <span class="monitor-frame-figure"><b class="monitor-frame-time"></b> ms</span>
    </div>`

  const query = (root: HTMLElement, selector: string) => {
    const element = root.querySelector<HTMLElement | SVGElement>(selector)
    invariant(element !== null, `Monitor's ${selector} is missing`)
    return element
  }
  const domCache = {
    barFrameTime: query(elements.statistics, '.system-frame-time'), // mount lifetime
    frame: query(elements.footer, '.monitor-frame'), // mount lifetime
    frameTime: query(elements.footer, '.monitor-frame-time'), // mount lifetime
    area: query(elements.footer, '.monitor-chart .area'), // mount lifetime
    line: query(elements.footer, '.monitor-chart .line'), // mount lifetime
    end: query(elements.footer, '.monitor-chart .end'), // mount lifetime
  }

  // The last frames' times, oldest first.
  const times: number[] = []
  // The text last written, and the scale that the chart's caption last named, so
  // that a frame writes only what changed.
  let frameTimeText = ''
  let captionScale = 0

  return {
    // Records the time the program took in the frame that just ran, in ms, and
    // draws it. A frame's DOM writes.
    update(frameMs: number) {
      if (times.length === frameCapacity) times.shift()
      times.push(frameMs)

      const nextFrameTimeText = formatMilliseconds(frameMs)
      if (nextFrameTimeText !== frameTimeText) {
        frameTimeText = nextFrameTimeText
        domCache.frameTime.textContent = frameTimeText
        domCache.barFrameTime.textContent = frameTimeText
      }
      // The chart has no axis. What a pointer that rests on it reads names the scale,
      // which changes only when a frame is longer than every frame the chart shows.
      const scale = frameTimeScale(Math.max(...times))
      if (scale !== captionScale) {
        captionScale = scale
        domCache.frame.setAttribute('title', `The program's time in each of the last ${frameCapacity} frames, from 0 at the chart's bottom to ${formatCount(scale)} ms at its top.`)
      }
      const line = frameTimesPath(times, frameCapacity, scale)
      domCache.line.setAttribute('d', line)
      domCache.area.setAttribute('d', `${line}V1H${frameCapacity - times.length}Z`)
      // The last frame's point again, as a line of no length, whose round caps draw
      // the dot at the chart's right edge.
      domCache.end.setAttribute('d', `${frameTimesPath([frameMs], frameCapacity, scale)}h0`)
    },
  }
}

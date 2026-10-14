// The footer of the Monitor window: how large the compiled program is, and how
// long it ran per frame over the last 60 frames. Everything here is JavaScript text
// and SVG that the page computes from the compiled program and from the frame
// times. None of it is an output of the program. The list above the footer is the
// program's, see value-list.ts.
//
// The mount calls createMonitorFooter once, and update after each frame with the
// time the program took in that frame.
//
// A browser's clock counts in steps, 0.1 ms in Chrome and 1 ms in Safari and
// Firefox, and the program takes about 0.1 to 0.2 ms a frame. So one frame's time
// reads as 0, 0.1, 0.2 or 0.3 ms in Chrome, and a chart of single frames would show
// those steps and little else. The reading is right on average, though, since a
// frame starts anywhere within a step. So each point of the chart, and the number
// beside the chart, is the average of 10 frames: in Chrome a multiple of 0.01 ms.
import {type Circuit, invariant} from '../runtime/numeric-ui-core.ts'

type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

// How many points the chart shows, one per frame, and how many frames a point
// averages: the frame at the point and the 9 before it.
export const frameCapacity = 60
export const averagedFrames = 10

// The stored weights, and the bytes of every array the program holds. The index
// reads of one table share one array of the table's positions, e.g. 200 reads of a
// table of 32 values share one array of 128 bytes, so each array is counted once,
// however many reads point at it.
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

// One point per frame for the last `pointCount` frames of `times`: the average of
// the `window` frames up to the point's frame, or of the frames there are when the
// list starts later. E.g. [0, 100, 200] with 2 points of 2 frames gives [50, 150].
/** @public */
export function averageFrameTimes(times: readonly number[], pointCount: number, window: number) {
  const points: number[] = []
  for (let last = Math.max(0, times.length - pointCount); last < times.length; last++) {
    const first = Math.max(0, last - window + 1)
    let sum = 0
    for (let frame = first; frame <= last; frame++) sum += times[frame]!
    points.push(sum / (last - first + 1))
  }
  return points
}

// The top of the chart's scale for the highest point it shows, both in µs: the
// smallest of 100, 200, 500, 1,000, 2,000, 5,000 µs and so on that the point fits
// under, e.g. 500 for 320 µs.
/** @public */
export function frameTimeScale(highestMicroseconds: number) {
  for (let magnitude = 100; ; magnitude *= 10) {
    for (const step of [1, 2, 5]) {
      if (step * magnitude >= highestMicroseconds) return step * magnitude
    }
  }
}

// The chart's line as an SVG path in a box `capacity - 1` wide and 1 tall: one
// point per frame, the last frame at the right edge, 0 at the bottom and `scale` at
// the top, in the unit of `times`. E.g. the times [0.5, 1] with capacity 60 and
// scale 1 give 'M58 0.500L59 0.000'.
/** @public */
export function frameTimesPath(times: readonly number[], capacity: number, scale: number) {
  const first = capacity - times.length
  return `M${times.map((time, index) => `${first + index} ${(1 - Math.min(time / scale, 1)).toFixed(3)}`).join('L')}`
}

const formatCount = (value: number) => value.toLocaleString('en-US')
// 1 KB is 1,000 bytes, e.g. 386,312 bytes is ['386', 'KB'].
const formatBytes = (bytes: number) => bytes < 999_500 ? [`${Math.round(bytes / 1_000)}`, 'KB'] : [(bytes / 1_000_000).toFixed(1), 'MB']
// A time in ms with three digits under 100 ms, e.g. '0.16' or '12.3'.
const formatMilliseconds = (value: number) => value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : formatCount(Math.round(value))

export function createMonitorFooter(footer: HTMLElement, program: TensorProgram) {
  const {weights, bytes} = measureProgram(program)
  const [size, sizeUnit] = formatBytes(bytes)
  // The counts, the most important first: a footer too narrow for all of them shows
  // the first ones. The sidebar above the footer shows the number of operations.
  const counts = [
    {count: formatCount(program.layers.length), noun: 'layers', title: 'The operations of one layer read only earlier layers, so they can run together.'},
    {count: formatCount(weights), noun: 'weights', title: 'The numbers that the program stores: what each operation multiplies earlier values by.'},
    {count: size, noun: sizeUnit, title: 'The bytes of every array that the compiled program holds.'},
  ]

  footer.innerHTML = `
    <ul class="monitor-counts">
      ${counts.map(entry => `<li title="${entry.title}"><b>${entry.count}</b> ${entry.noun}</li>`).join('')}
    </ul>
    <div class="monitor-frame" role="group">
      <svg class="monitor-chart" viewBox="0 0 ${frameCapacity - 1} 1" preserveAspectRatio="none" aria-hidden="true">
        <path class="area"/><path class="line"/><path class="end"/>
      </svg>
      <span class="monitor-frame-figure"><b class="monitor-frame-time"></b> ms</span>
    </div>`

  const query = (selector: string) => {
    const element = footer.querySelector<HTMLElement | SVGElement>(selector)
    invariant(element !== null, `Monitor's ${selector} is missing`)
    return element
  }
  const domCache = {
    frame: query('.monitor-frame'), // mount lifetime
    frameTime: query('.monitor-frame-time'), // mount lifetime
    area: query('.monitor-chart .area'), // mount lifetime
    line: query('.monitor-chart .line'), // mount lifetime
    end: query('.monitor-chart .end'), // mount lifetime
  }

  // The last frames' times in whole µs, oldest first: as many as the chart's points
  // average.
  const times: number[] = []
  // The text last written, and the scale that the chart's caption last named, so
  // that a frame writes only what changed.
  let frameTimeText = ''
  let captionScale = 0

  return {
    // Records the time the program took in the frame that just ran, in ms, and
    // draws the chart with it. A frame's DOM writes.
    update(frameMs: number) {
      if (times.length === frameCapacity + averagedFrames - 1) times.shift()
      times.push(Math.round(frameMs * 1000))
      const points = averageFrameTimes(times, frameCapacity, averagedFrames)
      const lastPoint = points[points.length - 1]!

      // The number beside the chart is the chart's last point.
      const nextFrameTimeText = formatMilliseconds(lastPoint / 1000)
      if (nextFrameTimeText !== frameTimeText) {
        frameTimeText = nextFrameTimeText
        domCache.frameTime.textContent = frameTimeText
      }
      // The chart has no axis. The title of the chart and its figure, which a pointer
      // that rests on them reads and which names the group for a screen reader, says
      // what the chart shows and names the scale. The scale changes only when a point
      // is higher than every point the chart shows, or when such a point leaves it.
      const scale = frameTimeScale(Math.max(...points))
      if (scale !== captionScale) {
        captionScale = scale
        domCache.frame.setAttribute('title', `The program's time per frame. A browser's clock counts in steps of 0.1 ms or more, so each of the chart's ${frameCapacity} points, and the number beside it, is the average of the ${averagedFrames} frames up to it. The chart goes from 0 at its bottom to ${formatCount(scale / 1000)} ms at its top.`)
      }
      const line = frameTimesPath(points, frameCapacity, scale)
      domCache.line.setAttribute('d', line)
      domCache.area.setAttribute('d', `${line}V1H${frameCapacity - points.length}Z`)
      // The last point again, as a line of no length, whose round caps draw the dot
      // at the chart's right edge.
      domCache.end.setAttribute('d', `${frameTimesPath([lastPoint], frameCapacity, scale)}h0`)
    },
  }
}

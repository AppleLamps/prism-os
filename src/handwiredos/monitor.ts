// Monitor's content and the system bar's counters: what the compiled program is
// made of, and how long it ran in each of the last 60 frames. Everything here is
// JavaScript text and SVG that the page computes from the compiled program and from
// the frame times. None of it is an output of the program.
//
// The mount calls createMonitor once, and update after each frame with the time the
// program took in that frame.
import {type Circuit, invariant} from '../runtime/numeric-ui-core.ts'

type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

// How many frames the chart shows.
const frameCapacity = 60

// The program's operations by kind, e.g. {affine: 5_413, gatherReads: 908, reglu:
// 7_022, boolean: 676, indexReads: 0} for HandwiredOS with the baked Notes paragraph.
// A gather read is an affine operation that sums values masked by a one-hot
// selection, which the compiler turned into one read of the selected value. So a
// count of affine operations in the program as it was built is affine + gatherReads.
type OperationKinds = {
  affine: number
  gatherReads: number
  reglu: number
  boolean: number
  indexReads: number
}

/** @public */
export function countOperationKinds(program: TensorProgram): OperationKinds {
  const kinds = {affine: 0, gatherReads: 0, reglu: 0, boolean: 0, indexReads: 0}
  for (const layer of program.layers) {
    // A layer has one output row per operation. Its ReGLU rows, boolean rows, index
    // reads and gather reads are listed, and the rows left over are weighted sums.
    kinds.reglu += layer.gateRows.length
    kinds.boolean += layer.booleanRows.length
    kinds.indexReads += layer.indexReads.length
    kinds.gatherReads += layer.gatherReads.length
    kinds.affine += layer.outputSize - layer.gateRows.length - layer.booleanRows.length - layer.indexReads.length - layer.gatherReads.length
  }
  return kinds
}

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
// 1 KB is 1,000 bytes, e.g. 386,312 bytes is '386 KB'.
const formatBytes = (bytes: number) => bytes < 999_500 ? `${Math.round(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`
// Browsers report times in steps of 0.1 ms or coarser, e.g. '0.40'.
const formatMilliseconds = (value: number) => value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : formatCount(Math.round(value))

export function createMonitor(elements: {content: HTMLElement, statistics: HTMLElement}, program: TensorProgram) {
  const kinds = countOperationKinds(program)
  const operations = program.valueCount - program.sourceSize
  invariant(
    kinds.affine + kinds.gatherReads + kinds.reglu + kinds.boolean + kinds.indexReads === operations,
    'the layers hold another number of operations than the program reports',
  )
  const {weights, bytes} = measureProgram(program)
  const share = (count: number) => `${Math.round(count / operations * 100)}%`
  const affine = kinds.affine + kinds.gatherReads
  const parts = [
    {
      className: 'kind-affine',
      count: affine,
      name: 'affine',
      title: `Affine, a weighted sum of earlier values: ${formatCount(affine)} operations, ${share(affine)}.`
        + (kinds.gatherReads > 0 ? ` The compiler turned ${formatCount(kinds.gatherReads)} of them into reads of one selected value.` : ''),
    },
    {
      className: 'kind-reglu',
      count: kinds.reglu,
      name: 'ReGLU',
      title: `ReGLU, a weighted sum multiplied by another one while that one is positive: ${formatCount(kinds.reglu)} operations, ${share(kinds.reglu)}.`,
    },
    {
      className: 'kind-boolean',
      count: kinds.boolean,
      name: 'boolean',
      title: `Boolean, a value between 0 and 1 rounded to 0 or 1: ${formatCount(kinds.boolean)} operations, ${share(kinds.boolean)}.`,
    },
    {
      className: 'kind-index',
      count: kinds.indexReads,
      name: kinds.indexReads === 1 ? 'index read' : 'index reads',
      title: `Index read, a copy of the table entry at a computed position: ${formatCount(kinds.indexReads)} operations, ${share(kinds.indexReads)}.`,
    },
  ].filter(part => part.count > 0)

  elements.statistics.innerHTML =
    `<span><b>${formatCount(operations)}</b> operations</span>`
    + `<span><b>${formatCount(program.layers.length)}</b> layers</span>`
    + '<span><b class="system-frame-time"></b> ms in the last frame</span>'
  elements.content.innerHTML = `
    <p class="monitor-lede">The whole desktop is one program: ${formatCount(weights)} weights, ${formatBytes(bytes)}.</p>
    <dl class="monitor-figures">
      <div><dt>Operations</dt><dd>${formatCount(operations)}</dd></div>
      <div><dt>Layers</dt><dd>${formatCount(program.layers.length)}</dd></div>
      <div><dt>Last frame</dt><dd><span class="monitor-frame-time"></span><small>ms</small></dd></div>
    </dl>
    <figure class="monitor-chart">
      <div class="monitor-plot">
        <svg viewBox="0 0 ${frameCapacity - 1} 1" preserveAspectRatio="none" aria-hidden="true">
          <path class="area"/><path class="line"/><path class="end-ring"/><path class="end"/>
        </svg>
        <span class="monitor-scale monitor-scale-top"></span>
        <span class="monitor-scale monitor-scale-bottom">0</span>
      </div>
      <figcaption>The program's time in each of the last ${frameCapacity} frames</figcaption>
    </figure>
    <div class="monitor-parts">
      <div class="monitor-bar" role="img" aria-label="Operations by kind: ${parts.map(part => `${formatCount(part.count)} ${part.name}`).join(', ')}">
        ${parts.map(part => `<i class="${part.className}" style="flex-grow: ${part.count}" title="${part.title}"></i>`).join('')}
      </div>
      <ul class="monitor-legend">
        ${parts.map(part => `<li class="${part.className}" title="${part.title}"><b>${formatCount(part.count)}</b> ${part.name}</li>`).join('')}
      </ul>
    </div>`

  const query = (root: HTMLElement, selector: string) => {
    const element = root.querySelector<HTMLElement | SVGElement>(selector)
    invariant(element !== null, `Monitor's ${selector} is missing`)
    return element
  }
  const domCache = {
    barFrameTime: query(elements.statistics, '.system-frame-time'), // mount lifetime
    frameTime: query(elements.content, '.monitor-frame-time'), // mount lifetime
    scaleTop: query(elements.content, '.monitor-scale-top'), // mount lifetime
    area: query(elements.content, '.monitor-plot .area'), // mount lifetime
    line: query(elements.content, '.monitor-plot .line'), // mount lifetime
    endRing: query(elements.content, '.monitor-plot .end-ring'), // mount lifetime
    end: query(elements.content, '.monitor-plot .end'), // mount lifetime
  }

  // The last frames' times, oldest first.
  const times: number[] = []
  // The text last written, so that a frame writes only the text that changed.
  let frameTimeText = ''
  let scaleText = ''

  return {
    // Records the time the program took in the frame that just ran, in ms, and
    // draws it.
    update(frameMs: number) {
      if (times.length === frameCapacity) times.shift()
      times.push(frameMs)

      const nextFrameTimeText = formatMilliseconds(frameMs)
      if (nextFrameTimeText !== frameTimeText) {
        frameTimeText = nextFrameTimeText
        domCache.frameTime.textContent = frameTimeText
        domCache.barFrameTime.textContent = frameTimeText
      }
      const scale = frameTimeScale(Math.max(...times))
      const nextScaleText = `${formatCount(scale)} ms`
      if (nextScaleText !== scaleText) {
        scaleText = nextScaleText
        domCache.scaleTop.textContent = scaleText
      }
      const line = frameTimesPath(times, frameCapacity, scale)
      // The last frame's point again, as a line of no length, whose round caps draw
      // the dot at the chart's right edge.
      const end = `${frameTimesPath([frameMs], frameCapacity, scale)}h0`
      domCache.line.setAttribute('d', line)
      domCache.area.setAttribute('d', `${line}V1H${frameCapacity - times.length}Z`)
      domCache.endRing.setAttribute('d', end)
      domCache.end.setAttribute('d', end)
    },
  }
}

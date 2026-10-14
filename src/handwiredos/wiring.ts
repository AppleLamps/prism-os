// The desk's wallpaper: the compiled program's stored weights, one arc per weight,
// from the value that the weight reads to the operation that reads it. Values lie
// along the canvas's bottom edge in the program's order, the table's cells first
// and then one column per layer, so an arc's width says how many layers back an
// operation reads. E.g. the widest arcs, on the left, read the table's cells in the
// last layers. A weight that adds is drawn in copper, and one that subtracts in
// indigo. A gather read and an index read store no weights for the values they
// copy, so they draw no arc.
//
// The picture depends only on the program and on the canvas's size, which follows
// from the viewport's. The page's frame draws it: in the first frame, and again
// after the viewport has changed its size, see createWiringRenderer.
import type {Circuit} from '../runtime/numeric-ui-core.ts'

type TensorProgram = ReturnType<Circuit['compileTensorProgram']>

type WiringOptions = {
  // The picture's size in CSS px, and the canvas's pixels per CSS px.
  width: number
  height: number
  pixelRatio: number
  // The two colors, e.g. '#a64d1d', each arc's opacity, and its width in CSS px.
  // Arcs overlap, so many weights between the same two layers add up to a line.
  adds: string
  subtracts: string
  alpha: number
  lineWidth: number
}

// Draws the arcs over the whole canvas: the first cell at its left edge, the last
// layer's end at its right edge, and every arc standing on the middle of its
// bottom row of pixels. An arc is the upper half of an ellipse, and all arcs have
// the same proportions: one as wide as the canvas is as tall as the canvas, or at
// most 1.25 times as tall as half its width, on a canvas taller than that, e.g. a
// phone's.
/** @public */
export function drawWiring(canvas: HTMLCanvasElement, program: TensorProgram, options: WiringOptions) {
  const {width, height, pixelRatio} = options
  canvas.width = Math.round(width * pixelRatio)
  canvas.height = Math.round(height * pixelRatio)
  const context = canvas.getContext('2d')
  if (context === null || width <= 0 || height <= 0) return
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.lineWidth = options.lineWidth
  context.globalAlpha = options.alpha

  // The x of every value, in the program's packed order. The cells share the first
  // column, and every layer gets a column of the same width, with its operations
  // spread across the column in their order.
  const columnWidth = width / (program.layers.length + 1)
  const x = new Float32Array(program.valueCount)
  for (let cell = 0; cell < program.sourceSize; cell++) {
    x[cell] = cell / program.sourceSize * columnWidth
  }
  let layerStart = program.sourceSize
  program.layers.forEach((layer, layerIndex) => {
    for (let row = 0; row < layer.outputSize; row++) {
      x[layerStart + row] = (layerIndex + 1 + row / layer.outputSize) * columnWidth
    }
    layerStart += layer.outputSize
  })

  const baseline = height - 0.5 / pixelRatio
  const heightPerRadius = Math.min(baseline / (width / 2), 1.25)
  // All the arcs of the weights that subtract, then all the arcs of the weights that
  // add, so the second color lies on top where the two overlap. Many arcs between
  // the same two layers add up to a band of both colors, and with copper on top a
  // band comes out brown, like ink on the desk's paper. With indigo on top the bands
  // came out gray.
  for (const subtracts of [true, false]) {
    context.strokeStyle = subtracts ? options.subtracts : options.adds
    layerStart = program.sourceSize
    for (const layer of program.layers) {
      // A layer's rows: one per operation, then one gate row per ReGLU, then one
      // index row per index read. A gate row's and an index row's weights belong to
      // the operation they gate or index.
      const rowCount = layer.rowOffsets.length - 1
      for (let row = 0; row < rowCount; row++) {
        let operationRow = row
        if (row >= layer.outputSize) {
          const extra = row - layer.outputSize
          operationRow = extra < layer.gateRows.length
            ? layer.gateRows[extra]!
            : layer.indexReads[extra - layer.gateRows.length]!.row
        }
        const to = x[layerStart + operationRow]!
        for (let stored = layer.rowOffsets[row]!; stored < layer.rowOffsets[row + 1]!; stored++) {
          if ((layer.weights[stored]! < 0) !== subtracts) continue
          const radius = (to - x[layer.inputIndices[layer.columns[stored]!]!]!) / 2
          if (radius <= 0) continue
          context.beginPath()
          context.ellipse(to - radius, baseline, radius, radius * heightPerRadius, 0, Math.PI, 2 * Math.PI)
          context.stroke()
        }
      }
      layerStart += layer.outputSize
    }
  }
}

// The opacity of one arc, for a program that stores `weightCount` weights. Every
// program's picture gets the same amount of ink, that of 2,600 arcs at full
// opacity, shared among its arcs: e.g. 29% an arc for 8,965 weights, and 6% for
// 43,180. So the desk looks about as dark whether the program grows or shrinks. A
// program of fewer than 2,600 weights draws every arc in full.
/** @public */
export function arcOpacity(weightCount: number) {
  return Math.min(1, 2_600 / weightCount)
}

// The canvas's rectangle on the desktop, in CSS px, for a viewport and the height
// of the system bar: 24 px in from the viewport's left and right edges, from 12 px
// under the system bar down to 6 px above the viewport's bottom. The canvas's last
// row is then the row of the dock's wire, see .dock-wire in handwired-os.css, so
// the arcs stand on the wire's row.
function wiringRectangle(viewportWidth: number, viewportHeight: number, systemBarHeight: number) {
  return {
    left: 24,
    top: systemBarHeight + 12,
    width: Math.max(0, viewportWidth - 48),
    height: Math.max(0, viewportHeight - systemBarHeight - 18),
  }
}

// How long the canvas keeps a new size before its picture is drawn again. While a
// person resizes the browser's window, every frame has another viewport, and one
// drawing of 8,965 arcs takes about 3 ms of script. So a frame only gives the
// canvas its new rectangle, the browser stretches the old picture over it, and
// the picture is drawn once the size has stayed the same for this long.
const restBeforeDrawingMs = 150

// The wallpaper's part of the page's frame. `colors` holds the stylesheet's
// --copper and --wire-indigo, e.g. '#a64d1d'.
export function createWiringRenderer(canvas: HTMLCanvasElement, program: TensorProgram, colors: {adds: string, subtracts: string}, systemBarHeight: number) {
  let weightCount = 0
  for (const layer of program.layers) weightCount += layer.weights.length
  // The size that the canvas's picture was drawn for, or null before the first
  // drawing. Cache lifetime: until the canvas has had another size for
  // restBeforeDrawingMs.
  let drawn: {width: number, height: number} | null = null
  // The canvas's size in the last frame, and the time of the first frame that had
  // that size.
  let size = {width: 0, height: 0, since: 0}
  return {
    // A frame's DOM writes for the wallpaper: the canvas's rectangle for the
    // viewport, and the picture when the canvas has none yet, i.e. in the page's
    // first frame, or when its size has changed and rested. Returns whether the
    // picture is still to be drawn for the canvas's size, and the page then
    // requests another frame.
    render(viewportWidth: number, viewportHeight: number, frameTime: number) {
      const {left, top, width, height} = wiringRectangle(viewportWidth, viewportHeight, systemBarHeight)
      canvas.style.left = `${left}px`
      canvas.style.top = `${top}px`
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      if (width !== size.width || height !== size.height) size = {width, height, since: frameTime}
      if (drawn !== null) {
        if (drawn.width === width && drawn.height === height) return false
        if (frameTime - size.since < restBeforeDrawingMs) return true
      }
      drawWiring(canvas, program, {
        width,
        height,
        // 2 canvas pixels per CSS px on every display, so a 0.5 px line covers whole
        // canvas pixels. With 1 pixel per px, a line that covers half a pixel at 6%
        // changes some color channels by less than one of their 255 steps, which
        // rounds, and where thousands of arcs overlap the picture came out olive
        // instead of copper. A canvas of more than 16 million pixels, 64 MB, gets
        // fewer pixels per px, e.g. 1.41 for a 3840 × 2160 px viewport.
        pixelRatio: Math.min(2, Math.sqrt(16_000_000 / Math.max(width * height, 1))),
        adds: colors.adds,
        subtracts: colors.subtracts,
        // The stylesheet shows the canvas at 36% of its opacity, so one arc alone of
        // 8,965 is drawn at 29% × 36%, about 10%, and a place where many arcs overlap
        // reaches at most 36% of the arc's color. On a canvas shown in full, with each
        // arc at 36% of its opacity here, such places came out as dark as the color
        // itself.
        alpha: arcOpacity(weightCount),
        lineWidth: 0.5,
      })
      drawn = {width, height}
      return false
    },
  }
}

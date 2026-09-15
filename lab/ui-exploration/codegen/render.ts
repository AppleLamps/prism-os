// Projections from instance outputs to RGBA pixels, for the demo canvas.
// They only read output tables, so tests can run them without a browser.
import {lifeOutputField} from './life-calendar.ts'
import {sdfOutputField} from './sdf-shapes.ts'
import {ownerCode} from './window-ownership.ts'

type Color = readonly [number, number, number]

const ownerColors: readonly Color[] = [
  [24, 26, 34],
  [66, 133, 244], [234, 84, 106], [250, 188, 45], [52, 199, 120],
  [120, 160, 255], [255, 140, 160], [255, 220, 120], [120, 230, 170],
]

function setPixel(pixels: Uint8ClampedArray, index: number, color: Color, shade = 1) {
  pixels[index * 4] = color[0] * shade
  pixels[index * 4 + 1] = color[1] * shade
  pixels[index * 4 + 2] = color[2] * shade
  pixels[index * 4 + 3] = 255
}

// Owner colors, with the title bar, buttons and resize grip darkened so the
// press regions show up inside each window.
export function renderOwnership(outputs: Float32Array, count: number, pixels: Uint8ClampedArray) {
  for (let pixel = 0; pixel < count; pixel++) {
    const owner = outputs[pixel * 2]!
    const region = outputs[pixel * 2 + 1]!
    const color = ownerColors[Math.min(owner, ownerColors.length - 1)] ?? ownerColors[0]!
    setPixel(pixels, pixel, color, owner === ownerCode.desktop ? 1 : region === 0 ? 0.9 : 0.35 + region * 0.08)
  }
}

export function renderShapes(outputs: Float32Array, count: number, pixels: Uint8ClampedArray) {
  for (let pixel = 0; pixel < count; pixel++) {
    const base = pixel * sdfOutputField.size
    setPixel(pixels, pixel, [outputs[base + sdfOutputField.red]!, outputs[base + sdfOutputField.green]!, outputs[base + sdfOutputField.blue]!])
  }
}

const layoutColors: readonly Color[] = [[66, 133, 244], [52, 199, 120], [250, 188, 45]]

// Which layout wins at each (width, height), shaded by the winning score.
export function renderCandidateGrid(outputs: Float32Array, size: number, outputCount: number, pixels: Uint8ClampedArray) {
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const instance = row * size + column
      const base = instance * outputCount
      let winner = 0
      for (let layout = 0; layout < 3; layout++) if (outputs[base + layout] === 1) winner = layout
      const score = outputs[base + 3 + winner]!
      // Draw with height increasing upward.
      setPixel(pixels, (size - 1 - row) * size + column, layoutColors[winner]!, 0.45 + 0.55 * score)
    }
  }
}

// Paint each cell's square; cell positions are relative to the grid's corner,
// which sits at (offsetX, offsetY) in the canvas.
export function renderLifeCalendar(outputs: Float32Array, count: number, blockSize: number, width: number, height: number, pixels: Uint8ClampedArray, offsetX = 0, offsetY = 0) {
  pixels.fill(0)
  for (let index = 0; index < width * height; index++) pixels[index * 4 + 3] = 255
  const inset = Math.max(0.5, blockSize * 0.12)
  for (let cell = 0; cell < count; cell++) {
    const base = cell * lifeOutputField.size
    const color: Color = outputs[base + lifeOutputField.hovered] === 1
      ? [255, 255, 255]
      : outputs[base + lifeOutputField.today] === 1
        ? [0, 109, 50]
        : outputs[base + lifeOutputField.filled] === 1 ? [57, 211, 83] : [55, 62, 72]
    const pill = outputs[base + lifeOutputField.pillFilled] === 1 || outputs[base + lifeOutputField.pillEmpty] === 1
    const dayOfWeek = outputs[base + lifeOutputField.dayOfWeek]!
    const x = outputs[base + lifeOutputField.x]! + offsetX
    const y = outputs[base + lifeOutputField.y]! + offsetY
    const left = Math.floor(x + (pill && dayOfWeek !== 0 ? 0 : inset))
    const right = Math.ceil(x + blockSize - (pill && dayOfWeek !== 6 ? 0 : inset))
    const top = Math.floor(y + inset)
    const bottom = Math.ceil(y + blockSize - inset)
    for (let row = Math.max(0, top); row < Math.min(height, bottom); row++) {
      for (let column = Math.max(0, left); column < Math.min(width, right); column++) setPixel(pixels, row * width + column, color)
    }
  }
}

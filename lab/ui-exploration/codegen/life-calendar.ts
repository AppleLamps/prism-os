// life-calendar's per-cell map (vibescript demos/life-calendar) as one circuit
// evaluated over its 27,393 cells.
//
// Shared part, computed once per frame: the demo's grid sizing (sqrt, runtime
// division, floor and ceil) rewritten as 141 threshold tests with constant
// coefficients, from the phase-one script demos/life-grid.ts; the grid offset;
// and the pointer relative to the grid.
//
// Per-cell part, with the cell index as the only per-instance cell:
// - week = floor(cell / 7), computed as round(cell / 7 - 3/7). The fractional
//   part of cell / 7 is a multiple of 1/7, so after subtracting 3/7 it's at
//   most 3/7 away from an integer and rounding never meets a tie.
// - row = floor(week / m), where the column count is 7m and m comes from a
//   shared one-hot. It's round(week · (1/m) - (m - 1) / (2m)): the quotient's
//   fractional part is a multiple of 1/m, and both 1/m and the offset are
//   shared affine reads of the one-hot. The margin to a tie is 1/(2m) ≥ 1/280,
//   about 15 FP32 steps at quotients near 4,000.
// - column, position, filled, today, the pill kinds, and hover. Hover is a
//   per-cell hit test against the shared pointer, the way a shader tests every
//   fragment, so no floor division of the pointer is needed.
import {Circuit, type Wire, emitMultiply, emitRelu} from '../../../numeric-ui-core.ts'

export const life = Math.floor(75 * 365.25)
const candidateCount = 140
const gridGap = 8

export const lifeSourceField = {windowWidth: 0, windowHeight: 1, pointerX: 2, pointerY: 3, unit: 4, age: 5, cell: 6, size: 7} as const
export const lifeOutputField = {x: 0, y: 1, filled: 2, today: 3, pillFilled: 4, pillEmpty: 5, dayOfWeek: 6, hovered: 7, row: 8, column: 9, size: 10} as const

// Two scale-and-clamp stages: 1 when value ≥ 2^-14, 0 when value ≤ 0.
function emitPositiveBit(circuit: Circuit, value: Wire, unit: Wire) {
  let stage = emitRelu(circuit, value)
  for (let round = 0; round < 2; round++) {
    const scaled = circuit.roundAffine([[stage, 128]])
    const positive = emitRelu(circuit, scaled)
    const aboveOne = emitRelu(circuit, circuit.roundAffine([[scaled, 1], [unit, -1]]))
    stage = circuit.roundAffine([[positive, 1], [aboveOne, -1]])
    circuit.assumeRange(stage, 0, 1)
  }
  return stage
}

// [difference ≥ 1] for an integer difference.
function emitIntegerAtLeastOne(circuit: Circuit, difference: Wire) {
  const bit = circuit.affine([[emitRelu(circuit, difference), 1], [emitRelu(circuit, circuit.affine([[difference, 1]], -1)), -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// [difference ≥ 0] for an integer difference.
function emitIntegerAtLeastZero(circuit: Circuit, difference: Wire) {
  const bit = circuit.affine([[emitRelu(circuit, circuit.affine([[difference, 1]], 1)), 1], [emitRelu(circuit, difference), -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// Math.round with ties to even, for |value| < 2^22: at 2^23 + 2^22 FP32 steps
// are whole numbers, so adding the base rounds and subtracting it is exact.
function emitRoundInteger(circuit: Circuit, value: Wire) {
  const shifted = circuit.roundAffine([[value, 1]], 12_582_912)
  return circuit.roundAffine([[shifted, 1]], -12_582_912)
}

// [left - right ≥ 0] for continuous values: a preserved difference scaled by
// 2^9 and clamped, then the boolean atom. Exact for |left - right| from 2^-11
// to 2^13 (phase-one measurement); pixel coordinates sit well inside that.
function emitAtLeast(circuit: Circuit, terms: readonly [Wire, number][], unit: Wire) {
  const difference = circuit.roundAffine(terms)
  const score = circuit.roundAffine([[difference, 512]], 0.5)
  const positive = emitRelu(circuit, score)
  const aboveOne = emitRelu(circuit, circuit.roundAffine([[score, 1], [unit, -1]]))
  const clamped = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return circuit.boolean(clamped)
}

export function createLifeCalendarCircuit() {
  const field = lifeSourceField
  const circuit = new Circuit(field.size)
  circuit.assumeRange(field.windowWidth, 0, 16_384)
  circuit.assumeRange(field.windowHeight, 0, 16_384)
  circuit.assumeRange(field.pointerX, -16_384, 16_384)
  circuit.assumeRange(field.pointerY, -16_384, 16_384)
  circuit.assumeRange(field.unit, 1, 1)
  circuit.assumeRange(field.age, 0, life - 1)
  circuit.assumeRange(field.cell, 0, life - 1)
  const unit = field.unit
  const gridSizeX = circuit.roundAffine([[field.windowWidth, 1]], -gridGap)
  const gridSizeY = circuit.roundAffine([[field.windowHeight, 1]], -gridGap)

  // countX ≥ 7m  <=>  life · gridSizeX ≥ 49 m (m + 1) · gridSizeY.
  const thresholds: Wire[] = []
  for (let m = 1; m <= candidateCount + 1; m++) {
    const excess = circuit.roundAffine([[gridSizeY, 49 * m * (m + 1) / life], [gridSizeX, -1]])
    const bit = circuit.roundAffine([[emitPositiveBit(circuit, excess, unit), -1], [unit, 1]])
    circuit.assumeRange(bit, 0, 1)
    thresholds.push(bit)
  }
  const weeksPerRow: Wire[] = []
  for (let m = 1; m <= candidateCount; m++) {
    const member = circuit.roundAffine([[thresholds[m - 1]!, 1], [thresholds[m]!, -1]])
    circuit.assumeRange(member, 0, 1)
    weeksPerRow.push(member)
  }
  const oneHotAffine = (value: (m: number) => number) =>
    circuit.affine(weeksPerRow.map((member, index) => [member, value(index + 1)] as [Wire, number]))
  const countX = circuit.affine([[circuit.affine(thresholds.slice(0, candidateCount).map(bit => [bit, 1] as [Wire, number])), 7]])
  const rowCount = (m: number) => Math.ceil(life / (7 * m))
  const countY = oneHotAffine(rowCount)
  const reciprocalCountY = oneHotAffine(m => 1 / rowCount(m))
  circuit.assumeRange(reciprocalCountY, 0, 1)
  const blockSize = emitMultiply(circuit, gridSizeY, reciprocalCountY)
  const gridFinalSizeX = emitMultiply(circuit, countX, blockSize)
  const gridFinalSizeY = emitMultiply(circuit, countY, blockSize)
  const reciprocalWeeksPerRow = oneHotAffine(m => Math.fround(1 / m))
  circuit.assumeRange(reciprocalWeeksPerRow, 0, 1)
  const rowOffset = oneHotAffine(m => (m - 1) / (2 * m))
  const gridLeft = circuit.roundAffine([[field.windowWidth, 0.5], [gridFinalSizeX, -0.5]])
  const gridTop = circuit.roundAffine([[field.windowHeight, 0.5], [gridFinalSizeY, -0.5]])
  const pointerX = circuit.roundAffine([[field.pointerX, 1], [gridLeft, -1]])
  const pointerY = circuit.roundAffine([[field.pointerY, 1], [gridTop, -1]])
  const ageWeek = emitRoundInteger(circuit, circuit.roundAffine([[field.age, 1 / 7]], -3 / 7))
  const lifeWeek = Math.floor(life / 7)

  const cell = field.cell
  const week = emitRoundInteger(circuit, circuit.roundAffine([[cell, 1 / 7]], -3 / 7))
  const dayOfWeek = circuit.affine([[cell, 1], [week, -7]])
  const row = emitRoundInteger(circuit, circuit.roundAffine([[emitMultiply(circuit, week, reciprocalWeeksPerRow), 1], [rowOffset, -1]]))
  const column = circuit.affine([[cell, 1], [emitMultiply(circuit, row, countX), -1]])
  const x = emitMultiply(circuit, column, blockSize)
  const y = emitMultiply(circuit, row, blockSize)
  const filled = emitIntegerAtLeastOne(circuit, circuit.affine([[field.age, 1], [cell, -1]]))
  const cellMinusAge = circuit.affine([[cell, 1], [field.age, -1]])
  const today = circuit.affine([[emitIntegerAtLeastZero(circuit, cellMinusAge), 1], [emitIntegerAtLeastOne(circuit, cellMinusAge), -1]])
  const pillFilled = emitIntegerAtLeastOne(circuit, circuit.affine([[ageWeek, 1], [week, -1]]))
  const weekMinusLifeWeek = circuit.affine([[week, 1]], -lifeWeek)
  const isLifeWeek = circuit.affine([[emitIntegerAtLeastZero(circuit, weekMinusLifeWeek), 1], [emitIntegerAtLeastOne(circuit, weekMinusLifeWeek), -1]])
  circuit.assumeRange(isLifeWeek, 0, 1)
  const pillEmpty = emitMultiply(
    circuit,
    emitIntegerAtLeastOne(circuit, circuit.affine([[week, 1], [ageWeek, -1]])),
    circuit.affine([[unit, 1], [isLifeWeek, -1]]),
  )
  const insideX = emitMultiply(
    circuit,
    emitAtLeast(circuit, [[pointerX, 1], [x, -1]], unit),
    circuit.affine([[unit, 1], [emitAtLeast(circuit, [[pointerX, 1], [x, -1], [blockSize, -1]], unit), -1]]),
  )
  const insideY = emitMultiply(
    circuit,
    emitAtLeast(circuit, [[pointerY, 1], [y, -1]], unit),
    circuit.affine([[unit, 1], [emitAtLeast(circuit, [[pointerY, 1], [y, -1], [blockSize, -1]], unit), -1]]),
  )
  const hovered = emitMultiply(circuit, insideX, insideY)
  const outputs = Array<Wire>(lifeOutputField.size)
  outputs[lifeOutputField.x] = x
  outputs[lifeOutputField.y] = y
  outputs[lifeOutputField.filled] = filled
  outputs[lifeOutputField.today] = today
  outputs[lifeOutputField.pillFilled] = pillFilled
  outputs[lifeOutputField.pillEmpty] = pillEmpty
  outputs[lifeOutputField.dayOfWeek] = dayOfWeek
  outputs[lifeOutputField.hovered] = hovered
  outputs[lifeOutputField.row] = row
  outputs[lifeOutputField.column] = column
  return {
    circuit,
    outputs,
    shared: {countX, countY, blockSize, gridFinalSizeX, gridFinalSizeY, gridLeft, gridTop},
    instanceSources: [lifeSourceField.cell],
  }
}

export function lifeCalendarSource(windowWidth: number, windowHeight: number, pointerX: number, pointerY: number, age: number) {
  const source = new Float32Array(lifeSourceField.size)
  source[lifeSourceField.windowWidth] = windowWidth
  source[lifeSourceField.windowHeight] = windowHeight
  source[lifeSourceField.pointerX] = pointerX
  source[lifeSourceField.pointerY] = pointerY
  source[lifeSourceField.unit] = 1
  source[lifeSourceField.age] = age
  return source
}

export function lifeCellIndices() {
  return Float32Array.from({length: life}, (_, cell) => cell)
}

// The demo's own float64 formulas (grid-sizing.ts and the draw loop in index.ts).
export function referenceLifeCalendar(windowWidth: number, windowHeight: number, pointerX: number, pointerY: number, age: number) {
  const gridSizeX = windowWidth - gridGap
  const gridSizeY = windowHeight - gridGap
  const blockSizeGuess = (life * Math.sqrt((4 * life * gridSizeX * gridSizeY + (7 * gridSizeY) ** 2) / (life ** 2)) + 7 * gridSizeY) / 2 / life
  const countX = Math.floor((gridSizeX / blockSizeGuess) / 7) * 7
  const countY = Math.ceil(life / countX)
  const blockSize = gridSizeY / countY
  const gridFinalSizeX = countX * blockSize
  const gridFinalSizeY = countY * blockSize
  const gridLeft = (windowWidth - gridFinalSizeX) / 2
  const gridTop = (windowHeight - gridFinalSizeY) / 2
  const px = pointerX - gridLeft
  const py = pointerY - gridTop
  const hover = px < 0 || px >= gridFinalSizeX || py < 0 || py >= gridFinalSizeY
    ? null
    : Math.floor(py / blockSize) * countX + Math.floor(px / blockSize)
  const ageWeek = Math.floor(age / 7)
  const lifeWeek = Math.floor(life / 7)
  return {
    countX,
    countY,
    blockSize,
    hover,
    cell(cell: number) {
      const week = Math.floor(cell / 7)
      const row = Math.floor(cell / countX)
      const column = cell % countX
      const values = Array<number>(lifeOutputField.size)
      values[lifeOutputField.x] = column * blockSize
      values[lifeOutputField.y] = row * blockSize
      values[lifeOutputField.filled] = cell < age ? 1 : 0
      values[lifeOutputField.today] = cell === age ? 1 : 0
      values[lifeOutputField.pillFilled] = week < ageWeek ? 1 : 0
      values[lifeOutputField.pillEmpty] = week > ageWeek && week !== lifeWeek ? 1 : 0
      values[lifeOutputField.dayOfWeek] = cell % 7
      values[lifeOutputField.hovered] = hover === cell ? 1 : 0
      values[lifeOutputField.row] = row
      values[lifeOutputField.column] = column
      return values
    },
  }
}

import assert from 'node:assert/strict'
import {
  Circuit,
  emitAnd,
  emitEqualForInteger,
  emitGreaterThanForInteger,
  emitGreaterThanOrEqualForInteger,
  emitMaximum,
  emitMinimum,
  emitMultiply,
  emitSelect,
} from './numeric-ui-core.mjs'

const ITEM_COUNT = 4
const MAX_COLUMNS = 3
const SPRING_SUBSTEPS = 4
const RANDOM_CASES = 10_000
const EPSILON = 1e-8

// Persistent numeric table layout. Constants and changing source facts share one table.
const SOURCE = {
  viewportLeft: 0,
  viewportTop: 1,
  viewportRight: 2,
  viewportBottom: 3,
  pointerX: 4,
  pointerY: 5,
  gapX: 6,
  gapY: 7,
  boxMinWidth: 8,
  promptHeight: 9,
  windowPaddingTop: 10,
  springK: 11,
  springB: 12,
  springDt: 13,
  boolA: 14,
  boolB: 15,
  chooseYes: 16,
  chooseNo: 17,
  clampValue: 18,
  clampLow: 19,
  clampHigh: 20,
  itemStart: 21,
}

const ITEM = {
  naturalWidth: 0,
  heightPerWidth: 1,
  left: 2,
  top: 3,
  right: 4,
  bottom: 5,
  springPos: 6,
  springDest: 7,
  springVelocity: 8,
  size: 9,
}

const SOURCE_SIZE = SOURCE.itemStart + ITEM_COUNT * ITEM.size

function itemSource(item, field) {
  return SOURCE.itemStart + item * ITEM.size + field
}

function compileCircuit() {
  const circuit = new Circuit(SOURCE_SIZE)
  const output = {}

  output.notA = circuit.affine([[SOURCE.boolA, -1]], 1)
  output.and = emitMultiply(circuit, SOURCE.boolA, SOURCE.boolB)
  output.or = circuit.affine([
    [SOURCE.boolA, 1],
    [SOURCE.boolB, 1],
    [output.and, -1],
  ])
  output.chosen = emitSelect(circuit, SOURCE.boolA, SOURCE.chooseYes, SOURCE.chooseNo)
  output.clamped = emitMinimum(
    circuit,
    emitMaximum(circuit, SOURCE.clampValue, SOURCE.clampLow),
    SOURCE.clampHigh,
  )

  output.hit = []
  output.visible = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    output.hit.push(emitAnd(circuit, [
      emitGreaterThanOrEqualForInteger(circuit, SOURCE.pointerX, itemSource(item, ITEM.left)),
      emitGreaterThanForInteger(circuit, itemSource(item, ITEM.right), SOURCE.pointerX),
      emitGreaterThanOrEqualForInteger(circuit, SOURCE.pointerY, itemSource(item, ITEM.top)),
      emitGreaterThanForInteger(circuit, itemSource(item, ITEM.bottom), SOURCE.pointerY),
    ]))
    output.visible.push(emitAnd(circuit, [
      emitGreaterThanForInteger(circuit, itemSource(item, ITEM.right), SOURCE.viewportLeft),
      emitGreaterThanForInteger(circuit, SOURCE.viewportRight, itemSource(item, ITEM.left)),
      emitGreaterThanForInteger(circuit, itemSource(item, ITEM.bottom), SOURCE.viewportTop),
      emitGreaterThanForInteger(circuit, SOURCE.viewportBottom, itemSource(item, ITEM.top)),
    ]))
  }

  output.winner = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    const terms = [output.hit[item]]
    for (let higher = item + 1; higher < ITEM_COUNT; higher++) {
      terms.push(circuit.affine([[output.hit[higher], -1]], 1))
    }
    output.winner.push(emitAnd(circuit, terms))
  }
  output.hasSelection = circuit.affine(output.winner.map(wire => [wire, 1]))
  output.selectedIndex = circuit.affine(output.winner.map((wire, item) => [wire, item]))

  const viewportWidth = circuit.affine([[SOURCE.viewportRight, 1], [SOURCE.viewportLeft, -1]])
  const columnCountTerms = []
  for (let columns = 2; columns <= MAX_COLUMNS; columns++) {
    const threshold = circuit.affine([
      [SOURCE.boxMinWidth, columns],
      [SOURCE.gapX, columns + 1],
    ])
    columnCountTerms.push([
      emitGreaterThanOrEqualForInteger(circuit, viewportWidth, threshold),
      1,
    ])
  }
  output.columnCount = circuit.affine(columnCountTerms, 1)

  const useColumns = []
  for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
    useColumns[columns] = emitEqualForInteger(
      circuit,
      output.columnCount,
      circuit.affine([], columns),
    )
  }

  const candidate = []
  for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
    const boxMaxWidth = circuit.affine([
      [viewportWidth, 1 / columns],
      [SOURCE.gapX, -(columns + 1) / columns],
    ])
    const width = []
    const height = []
    const left = []
    for (let item = 0; item < ITEM_COUNT; item++) {
      width[item] = emitMinimum(circuit, itemSource(item, ITEM.naturalWidth), boxMaxWidth)
      height[item] = circuit.affine([
        [emitMultiply(circuit, width[item], itemSource(item, ITEM.heightPerWidth)), 1],
        [SOURCE.promptHeight, 1],
      ])
      const column = item % columns
      left[item] = circuit.affine([
        [SOURCE.gapX, 1 + column],
        [boxMaxWidth, column],
        [width[item], -0.5],
      ])
      left[item] = circuit.affine([[left[item], 1], [boxMaxWidth, 0.5]])
    }

    const rowCount = Math.ceil(ITEM_COUNT / columns)
    const rowHeight = []
    for (let row = 0; row < rowCount; row++) {
      rowHeight[row] = height[row * columns]
      for (let column = 1; column < columns; column++) {
        const item = row * columns + column
        if (item < ITEM_COUNT) rowHeight[row] = emitMaximum(circuit, rowHeight[row], height[item])
      }
    }

    const rowTop = [SOURCE.windowPaddingTop]
    for (let row = 1; row < rowCount; row++) {
      rowTop[row] = circuit.affine([
        [rowTop[row - 1], 1],
        [rowHeight[row - 1], 1],
        [SOURCE.gapY, 1],
      ])
    }

    const top = []
    for (let item = 0; item < ITEM_COUNT; item++) {
      const row = Math.floor(item / columns)
      top[item] = circuit.affine([
        [rowTop[row], 1],
        [rowHeight[row], 0.5],
        [height[item], -0.5],
      ])
    }
    candidate[columns] = {width, height, left, top}
  }

  output.layout = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    const layout = {column: [], row: [], left: [], top: [], width: [], height: []}
    for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
      layout.column.push([useColumns[columns], item % columns])
      layout.row.push([useColumns[columns], Math.floor(item / columns)])
      for (const field of ['left', 'top', 'width', 'height']) {
        layout[field].push([
          emitMultiply(circuit, useColumns[columns], candidate[columns][field][item]),
          1,
        ])
      }
    }
    output.layout.push({
      column: circuit.affine(layout.column),
      row: circuit.affine(layout.row),
      left: circuit.affine(layout.left),
      top: circuit.affine(layout.top),
      width: circuit.affine(layout.width),
      height: circuit.affine(layout.height),
    })
  }

  output.spring = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    let position = itemSource(item, ITEM.springPos)
    let velocity = itemSource(item, ITEM.springVelocity)
    for (let step = 0; step < SPRING_SUBSTEPS; step++) {
      const displacement = circuit.affine([
        [position, 1],
        [itemSource(item, ITEM.springDest), -1],
      ])
      const springForce = emitMultiply(
        circuit,
        circuit.affine([[SOURCE.springK, -1]]),
        displacement,
      )
      const dampingForce = emitMultiply(
        circuit,
        circuit.affine([[SOURCE.springB, -1]]),
        velocity,
      )
      velocity = circuit.affine([
        [velocity, 1],
        [emitMultiply(
          circuit,
          circuit.affine([[springForce, 1], [dampingForce, 1]]),
          SOURCE.springDt,
        ), 1],
      ])
      position = circuit.affine([
        [position, 1],
        [emitMultiply(circuit, velocity, SOURCE.springDt), 1],
      ])
    }
    output.spring.push({position, velocity})
  }

  return {circuit, output}
}

function reference(source) {
  const result = {}
  result.notA = 1 - source[SOURCE.boolA]
  result.and = source[SOURCE.boolA] * source[SOURCE.boolB]
  result.or = source[SOURCE.boolA] + source[SOURCE.boolB] - result.and
  result.chosen = source[SOURCE.boolA] === 1 ? source[SOURCE.chooseYes] : source[SOURCE.chooseNo]
  result.clamped = Math.min(Math.max(source[SOURCE.clampValue], source[SOURCE.clampLow]), source[SOURCE.clampHigh])

  result.hit = []
  result.visible = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    result.hit.push(Number(
      source[SOURCE.pointerX] >= source[itemSource(item, ITEM.left)] &&
      source[SOURCE.pointerX] < source[itemSource(item, ITEM.right)] &&
      source[SOURCE.pointerY] >= source[itemSource(item, ITEM.top)] &&
      source[SOURCE.pointerY] < source[itemSource(item, ITEM.bottom)],
    ))
    result.visible.push(Number(
      source[itemSource(item, ITEM.right)] > source[SOURCE.viewportLeft] &&
      source[itemSource(item, ITEM.left)] < source[SOURCE.viewportRight] &&
      source[itemSource(item, ITEM.bottom)] > source[SOURCE.viewportTop] &&
      source[itemSource(item, ITEM.top)] < source[SOURCE.viewportBottom],
    ))
  }

  result.winner = Array(ITEM_COUNT).fill(0)
  for (let item = ITEM_COUNT - 1; item >= 0; item--) {
    if (result.hit[item] === 1) {
      result.winner[item] = 1
      break
    }
  }
  result.hasSelection = result.winner.reduce((sum, value) => sum + value, 0)
  result.selectedIndex = result.winner.reduce((sum, value, item) => sum + value * item, 0)

  const viewportWidth = source[SOURCE.viewportRight] - source[SOURCE.viewportLeft]
  result.columnCount = Math.max(
    1,
    Math.min(MAX_COLUMNS, Math.floor((viewportWidth - source[SOURCE.gapX]) / (source[SOURCE.boxMinWidth] + source[SOURCE.gapX]))),
  )
  const boxMaxWidth =
    (viewportWidth - source[SOURCE.gapX] - result.columnCount * source[SOURCE.gapX]) /
    result.columnCount
  const width = []
  const height = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    width[item] = Math.min(source[itemSource(item, ITEM.naturalWidth)], boxMaxWidth)
    height[item] = width[item] * source[itemSource(item, ITEM.heightPerWidth)] + source[SOURCE.promptHeight]
  }
  const rowCount = Math.ceil(ITEM_COUNT / result.columnCount)
  const rowHeight = []
  for (let row = 0; row < rowCount; row++) {
    rowHeight[row] = height[row * result.columnCount]
    for (let column = 1; column < result.columnCount; column++) {
      const item = row * result.columnCount + column
      if (item < ITEM_COUNT) rowHeight[row] = Math.max(rowHeight[row], height[item])
    }
  }
  const rowTop = [source[SOURCE.windowPaddingTop]]
  for (let row = 1; row < rowCount; row++) {
    rowTop[row] = rowTop[row - 1] + rowHeight[row - 1] + source[SOURCE.gapY]
  }
  result.layout = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    const column = item % result.columnCount
    const row = Math.floor(item / result.columnCount)
    result.layout.push({
      column,
      row,
      left:
        source[SOURCE.gapX] +
        (boxMaxWidth + source[SOURCE.gapX]) * column +
        (boxMaxWidth - width[item]) / 2,
      top: rowTop[row] + (rowHeight[row] - height[item]) / 2,
      width: width[item],
      height: height[item],
    })
  }

  result.spring = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    let position = source[itemSource(item, ITEM.springPos)]
    const destination = source[itemSource(item, ITEM.springDest)]
    let velocity = source[itemSource(item, ITEM.springVelocity)]
    for (let step = 0; step < SPRING_SUBSTEPS; step++) {
      const force = -source[SOURCE.springK] * (position - destination) - source[SOURCE.springB] * velocity
      velocity += force * source[SOURCE.springDt]
      position += velocity * source[SOURCE.springDt]
    }
    result.spring.push({position, velocity})
  }
  return result
}

function makeRandomSource(random) {
  const source = new Float64Array(SOURCE_SIZE)
  source[SOURCE.viewportLeft] = randomInteger(random, -100, 100)
  source[SOURCE.viewportTop] = randomInteger(random, -100, 100)
  source[SOURCE.viewportRight] = source[SOURCE.viewportLeft] + randomInteger(random, 300, 1_200)
  source[SOURCE.viewportBottom] = source[SOURCE.viewportTop] + randomInteger(random, 300, 900)
  source[SOURCE.pointerX] = randomInteger(random, -250, 1_300)
  source[SOURCE.pointerY] = randomInteger(random, -250, 1_000)
  source[SOURCE.gapX] = randomInteger(random, 8, 32)
  source[SOURCE.gapY] = randomInteger(random, 8, 32)
  source[SOURCE.boxMinWidth] = randomInteger(random, 80, 240)
  source[SOURCE.promptHeight] = randomInteger(random, 20, 80)
  source[SOURCE.windowPaddingTop] = randomInteger(random, 0, 80)
  source[SOURCE.springK] = randomBetween(random, 100, 360)
  source[SOURCE.springB] = randomBetween(random, 10, 50)
  source[SOURCE.springDt] = randomBetween(random, 0.001, 0.012)
  source[SOURCE.boolA] = randomInteger(random, 0, 1)
  source[SOURCE.boolB] = randomInteger(random, 0, 1)
  source[SOURCE.chooseYes] = randomBetween(random, -1_000, 1_000)
  source[SOURCE.chooseNo] = randomBetween(random, -1_000, 1_000)
  source[SOURCE.clampLow] = randomBetween(random, -500, 0)
  source[SOURCE.clampHigh] = randomBetween(random, 0, 500)
  source[SOURCE.clampValue] = randomBetween(random, -1_000, 1_000)

  for (let item = 0; item < ITEM_COUNT; item++) {
    const left = randomInteger(random, -250, 1_100)
    const top = randomInteger(random, -250, 850)
    source[itemSource(item, ITEM.naturalWidth)] = randomBetween(random, 120, 1_000)
    source[itemSource(item, ITEM.heightPerWidth)] = randomBetween(random, 0.4, 2.2)
    source[itemSource(item, ITEM.left)] = left
    source[itemSource(item, ITEM.top)] = top
    source[itemSource(item, ITEM.right)] = left + randomInteger(random, 20, 500)
    source[itemSource(item, ITEM.bottom)] = top + randomInteger(random, 20, 500)
    source[itemSource(item, ITEM.springPos)] = randomBetween(random, -1_000, 1_000)
    source[itemSource(item, ITEM.springDest)] = randomBetween(random, -1_000, 1_000)
    source[itemSource(item, ITEM.springVelocity)] = randomBetween(random, -500, 500)
  }
  return source
}

function verifyOutput(actualValues, output, expected) {
  assertClose(actualValues[output.notA], expected.notA, 'notA')
  assertClose(actualValues[output.and], expected.and, 'and')
  assertClose(actualValues[output.or], expected.or, 'or')
  assertClose(actualValues[output.chosen], expected.chosen, 'chosen')
  assertClose(actualValues[output.clamped], expected.clamped, 'clamped')
  assertArrayClose(actualValues, output.hit, expected.hit, 'hit')
  assertArrayClose(actualValues, output.visible, expected.visible, 'visible')
  assertArrayClose(actualValues, output.winner, expected.winner, 'winner')
  assertClose(actualValues[output.hasSelection], expected.hasSelection, 'hasSelection')
  assertClose(actualValues[output.selectedIndex], expected.selectedIndex, 'selectedIndex')
  assertClose(actualValues[output.columnCount], expected.columnCount, 'columnCount')
  for (let item = 0; item < ITEM_COUNT; item++) {
    for (const field of ['column', 'row', 'left', 'top', 'width', 'height']) {
      assertClose(actualValues[output.layout[item][field]], expected.layout[item][field], `layout[${item}].${field}`)
    }
    assertClose(actualValues[output.spring[item].position], expected.spring[item].position, `spring[${item}].position`)
    assertClose(actualValues[output.spring[item].velocity], expected.spring[item].velocity, `spring[${item}].velocity`)
  }
}

function assertArrayClose(values, wires, expected, label) {
  for (let i = 0; i < wires.length; i++) assertClose(values[wires[i]], expected[i], `${label}[${i}]`)
}

function assertClose(actual, expected, label) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected))
  assert.ok(
    Math.abs(actual - expected) <= EPSILON * scale,
    `${label}: expected ${expected}, received ${actual}`,
  )
}

function randomInteger(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min
}

function randomBetween(random, min, max) {
  return random() * (max - min) + min
}

function makeRandom(seed) {
  let state = seed >>> 0
  return function random() {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const {circuit, output} = compileCircuit()
const random = makeRandom(0xc0ffee)
let edgeCases = 0

{
  const source = makeRandomSource(makeRandom(1))
  source[SOURCE.viewportLeft] = 0
  source[SOURCE.viewportTop] = 0
  source[SOURCE.viewportRight] = 500
  source[SOURCE.viewportBottom] = 500
  source[SOURCE.pointerX] = 100
  source[SOURCE.pointerY] = 100
  const rectangles = [
    [0, 0, 100, 100],      // Pointer is on the excluded right and bottom edges.
    [100, 100, 200, 200],  // Pointer is on the included left and top edges.
    [100, 100, 200, 200],  // Overlaps item 1 and wins because its index is higher.
    [500, 0, 600, 100],    // Touches the viewport edge without entering it.
  ]
  for (let item = 0; item < ITEM_COUNT; item++) {
    const [left, top, right, bottom] = rectangles[item]
    source[itemSource(item, ITEM.left)] = left
    source[itemSource(item, ITEM.top)] = top
    source[itemSource(item, ITEM.right)] = right
    source[itemSource(item, ITEM.bottom)] = bottom
  }
  verifyOutput(circuit.evaluateReadable(source), output, reference(source))
  edgeCases++
}

for (const width of [371, 372, 545, 546]) {
  const source = makeRandomSource(makeRandom(width))
  source[SOURCE.viewportLeft] = 10
  source[SOURCE.viewportRight] = source[SOURCE.viewportLeft] + width
  source[SOURCE.gapX] = 24
  source[SOURCE.boxMinWidth] = 150
  verifyOutput(circuit.evaluateReadable(source), output, reference(source))
  edgeCases++
}

for (let test = 0; test < RANDOM_CASES; test++) {
  const source = makeRandomSource(random)
  verifyOutput(circuit.evaluateReadable(source), output, reference(source))
}

console.log(`Verified ${edgeCases} edge cases and ${RANDOM_CASES.toLocaleString()} randomized fixed-table UI derivations.`)
console.table(circuit.stats())

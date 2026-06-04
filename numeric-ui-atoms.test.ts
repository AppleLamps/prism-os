import assert from 'node:assert/strict'
import {test} from 'bun:test'
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
  type Wire,
} from './numeric-ui-core.ts'

const ITEM_COUNT = 4
const MAX_COLUMNS = 3
const SPRING_SUBSTEPS = 4
const RANDOM_CASES = 10_000
const EPSILON = 1e-8

type Term = [wire: Wire, coefficient: number]
type Random = () => number
type LayoutField = 'left' | 'top' | 'width' | 'height'

type LayoutValues = {
  column: number
  row: number
  left: number
  top: number
  width: number
  height: number
}

type SpringValues = {
  position: number
  velocity: number
}

type AtomOutput = {
  notA: number
  and: number
  or: number
  chosen: number
  clamped: number
  hit: number[]
  visible: number[]
  winner: number[]
  hasSelection: number
  selectedIndex: number
  columnCount: number
  layout: LayoutValues[]
  spring: SpringValues[]
}

type Candidate = {
  width: Wire[]
  height: Wire[]
  left: Wire[]
  top: Wire[]
}

type LayoutTerms = {
  column: Term[]
  row: Term[]
  left: Term[]
  top: Term[]
  width: Term[]
  height: Term[]
}

const layoutFields: LayoutField[] = ['left', 'top', 'width', 'height']

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

function itemSource(item: number, field: number): Wire {
  return SOURCE.itemStart + item * ITEM.size + field
}

function compileCircuit() {
  const circuit = new Circuit(SOURCE_SIZE)

  const notA = circuit.affine([[SOURCE.boolA, -1]], 1)
  const and = emitMultiply(circuit, SOURCE.boolA, SOURCE.boolB)
  const or = circuit.affine([
    [SOURCE.boolA, 1],
    [SOURCE.boolB, 1],
    [and, -1],
  ])
  const chosen = emitSelect(circuit, SOURCE.boolA, SOURCE.chooseYes, SOURCE.chooseNo)
  const clamped = emitMinimum(
    circuit,
    emitMaximum(circuit, SOURCE.clampValue, SOURCE.clampLow),
    SOURCE.clampHigh,
  )

  const hit: Wire[] = []
  const visible: Wire[] = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    hit.push(emitAnd(circuit, [
      emitGreaterThanOrEqualForInteger(circuit, SOURCE.pointerX, itemSource(item, ITEM.left)),
      emitGreaterThanForInteger(circuit, itemSource(item, ITEM.right), SOURCE.pointerX),
      emitGreaterThanOrEqualForInteger(circuit, SOURCE.pointerY, itemSource(item, ITEM.top)),
      emitGreaterThanForInteger(circuit, itemSource(item, ITEM.bottom), SOURCE.pointerY),
    ]))
    visible.push(emitAnd(circuit, [
      emitGreaterThanForInteger(circuit, itemSource(item, ITEM.right), SOURCE.viewportLeft),
      emitGreaterThanForInteger(circuit, SOURCE.viewportRight, itemSource(item, ITEM.left)),
      emitGreaterThanForInteger(circuit, itemSource(item, ITEM.bottom), SOURCE.viewportTop),
      emitGreaterThanForInteger(circuit, SOURCE.viewportBottom, itemSource(item, ITEM.top)),
    ]))
  }

  const winner: Wire[] = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    const terms = [hit[item]!]
    for (let higher = item + 1; higher < ITEM_COUNT; higher++) {
      terms.push(circuit.affine([[hit[higher]!, -1]], 1))
    }
    winner.push(emitAnd(circuit, terms))
  }
  const hasSelection = circuit.affine(winner.map(wire => [wire, 1]))
  const selectedIndex = circuit.affine(winner.map((wire, item) => [wire, item]))

  const viewportWidth = circuit.affine([[SOURCE.viewportRight, 1], [SOURCE.viewportLeft, -1]])
  const columnCountTerms: Term[] = []
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
  const columnCount = circuit.affine(columnCountTerms, 1)

  const useColumns: (Wire | undefined)[] = []
  for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
    useColumns[columns] = emitEqualForInteger(
      circuit,
      columnCount,
      circuit.affine([], columns),
    )
  }

  const candidate: (Candidate | undefined)[] = []
  for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
    const boxMaxWidth = circuit.affine([
      [viewportWidth, 1 / columns],
      [SOURCE.gapX, -(columns + 1) / columns],
    ])
    const width: Wire[] = []
    const height: Wire[] = []
    const left: Wire[] = []
    for (let item = 0; item < ITEM_COUNT; item++) {
      width[item] = emitMinimum(circuit, itemSource(item, ITEM.naturalWidth), boxMaxWidth)
      height[item] = circuit.affine([
        [emitMultiply(circuit, width[item]!, itemSource(item, ITEM.heightPerWidth)), 1],
        [SOURCE.promptHeight, 1],
      ])
      const column = item % columns
      left[item] = circuit.affine([
        [SOURCE.gapX, 1 + column],
        [boxMaxWidth, column],
        [width[item]!, -0.5],
      ])
      left[item] = circuit.affine([[left[item]!, 1], [boxMaxWidth, 0.5]])
    }

    const rowCount = Math.ceil(ITEM_COUNT / columns)
    const rowHeight: Wire[] = []
    for (let row = 0; row < rowCount; row++) {
      rowHeight[row] = height[row * columns]!
      for (let column = 1; column < columns; column++) {
        const item = row * columns + column
        if (item < ITEM_COUNT) rowHeight[row] = emitMaximum(circuit, rowHeight[row]!, height[item]!)
      }
    }

    const rowTop: Wire[] = [SOURCE.windowPaddingTop]
    for (let row = 1; row < rowCount; row++) {
      rowTop[row] = circuit.affine([
        [rowTop[row - 1]!, 1],
        [rowHeight[row - 1]!, 1],
        [SOURCE.gapY, 1],
      ])
    }

    const top: Wire[] = []
    for (let item = 0; item < ITEM_COUNT; item++) {
      const row = Math.floor(item / columns)
      top[item] = circuit.affine([
        [rowTop[row]!, 1],
        [rowHeight[row]!, 0.5],
        [height[item]!, -0.5],
      ])
    }
    candidate[columns] = {width, height, left, top}
  }

  const layoutOutput: LayoutValues[] = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    const layout: LayoutTerms = {column: [], row: [], left: [], top: [], width: [], height: []}
    for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
      layout.column.push([useColumns[columns]!, item % columns])
      layout.row.push([useColumns[columns]!, Math.floor(item / columns)])
      for (const field of layoutFields) {
        layout[field].push([
          emitMultiply(circuit, useColumns[columns]!, candidate[columns]![field][item]!),
          1,
        ])
      }
    }
    layoutOutput.push({
      column: circuit.affine(layout.column),
      row: circuit.affine(layout.row),
      left: circuit.affine(layout.left),
      top: circuit.affine(layout.top),
      width: circuit.affine(layout.width),
      height: circuit.affine(layout.height),
    })
  }

  const spring: SpringValues[] = []
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
    spring.push({position, velocity})
  }

  const output: AtomOutput = {
    notA,
    and,
    or,
    chosen,
    clamped,
    hit,
    visible,
    winner,
    hasSelection,
    selectedIndex,
    columnCount,
    layout: layoutOutput,
    spring,
  }
  return {circuit, output}
}

function reference(source: Float64Array): AtomOutput {
  const read = (wire: Wire) => source[wire]!
  const notA = 1 - read(SOURCE.boolA)
  const and = read(SOURCE.boolA) * read(SOURCE.boolB)
  const or = read(SOURCE.boolA) + read(SOURCE.boolB) - and
  const chosen = read(SOURCE.boolA) === 1 ? read(SOURCE.chooseYes) : read(SOURCE.chooseNo)
  const clamped = Math.min(Math.max(read(SOURCE.clampValue), read(SOURCE.clampLow)), read(SOURCE.clampHigh))

  const hit: number[] = []
  const visible: number[] = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    hit.push(Number(
      read(SOURCE.pointerX) >= read(itemSource(item, ITEM.left)) &&
      read(SOURCE.pointerX) < read(itemSource(item, ITEM.right)) &&
      read(SOURCE.pointerY) >= read(itemSource(item, ITEM.top)) &&
      read(SOURCE.pointerY) < read(itemSource(item, ITEM.bottom)),
    ))
    visible.push(Number(
      read(itemSource(item, ITEM.right)) > read(SOURCE.viewportLeft) &&
      read(itemSource(item, ITEM.left)) < read(SOURCE.viewportRight) &&
      read(itemSource(item, ITEM.bottom)) > read(SOURCE.viewportTop) &&
      read(itemSource(item, ITEM.top)) < read(SOURCE.viewportBottom),
    ))
  }

  const winner = Array<number>(ITEM_COUNT).fill(0)
  for (let item = ITEM_COUNT - 1; item >= 0; item--) {
    if (hit[item] === 1) {
      winner[item] = 1
      break
    }
  }
  const hasSelection = winner.reduce((sum, value) => sum + value, 0)
  const selectedIndex = winner.reduce((sum, value, item) => sum + value * item, 0)

  const viewportWidth = read(SOURCE.viewportRight) - read(SOURCE.viewportLeft)
  const columnCount = Math.max(
    1,
    Math.min(MAX_COLUMNS, Math.floor((viewportWidth - read(SOURCE.gapX)) / (read(SOURCE.boxMinWidth) + read(SOURCE.gapX)))),
  )
  const boxMaxWidth =
    (viewportWidth - read(SOURCE.gapX) - columnCount * read(SOURCE.gapX)) /
    columnCount
  const width: number[] = []
  const height: number[] = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    width[item] = Math.min(read(itemSource(item, ITEM.naturalWidth)), boxMaxWidth)
    height[item] = width[item]! * read(itemSource(item, ITEM.heightPerWidth)) + read(SOURCE.promptHeight)
  }
  const rowCount = Math.ceil(ITEM_COUNT / columnCount)
  const rowHeight: number[] = []
  for (let row = 0; row < rowCount; row++) {
    rowHeight[row] = height[row * columnCount]!
    for (let column = 1; column < columnCount; column++) {
      const item = row * columnCount + column
      if (item < ITEM_COUNT) rowHeight[row] = Math.max(rowHeight[row]!, height[item]!)
    }
  }
  const rowTop = [read(SOURCE.windowPaddingTop)]
  for (let row = 1; row < rowCount; row++) {
    rowTop[row] = rowTop[row - 1]! + rowHeight[row - 1]! + read(SOURCE.gapY)
  }
  const layout: LayoutValues[] = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    const column = item % columnCount
    const row = Math.floor(item / columnCount)
    layout.push({
      column,
      row,
      left:
        read(SOURCE.gapX) +
        (boxMaxWidth + read(SOURCE.gapX)) * column +
        (boxMaxWidth - width[item]!) / 2,
      top: rowTop[row]! + (rowHeight[row]! - height[item]!) / 2,
      width: width[item]!,
      height: height[item]!,
    })
  }

  const spring: SpringValues[] = []
  for (let item = 0; item < ITEM_COUNT; item++) {
    let position = read(itemSource(item, ITEM.springPos))
    const destination = read(itemSource(item, ITEM.springDest))
    let velocity = read(itemSource(item, ITEM.springVelocity))
    for (let step = 0; step < SPRING_SUBSTEPS; step++) {
      const force = -read(SOURCE.springK) * (position - destination) - read(SOURCE.springB) * velocity
      velocity += force * read(SOURCE.springDt)
      position += velocity * read(SOURCE.springDt)
    }
    spring.push({position, velocity})
  }
  return {
    notA,
    and,
    or,
    chosen,
    clamped,
    hit,
    visible,
    winner,
    hasSelection,
    selectedIndex,
    columnCount,
    layout,
    spring,
  }
}

function makeRandomSource(random: Random): Float64Array {
  const source = new Float64Array(SOURCE_SIZE)
  source[SOURCE.viewportLeft] = randomInteger(random, -100, 100)
  source[SOURCE.viewportTop] = randomInteger(random, -100, 100)
  source[SOURCE.viewportRight] = source[SOURCE.viewportLeft]! + randomInteger(random, 300, 1_200)
  source[SOURCE.viewportBottom] = source[SOURCE.viewportTop]! + randomInteger(random, 300, 900)
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

function verifyOutput(actualValues: Float64Array, output: AtomOutput, expected: AtomOutput) {
  assertClose(actualValues[output.notA]!, expected.notA, 'notA')
  assertClose(actualValues[output.and]!, expected.and, 'and')
  assertClose(actualValues[output.or]!, expected.or, 'or')
  assertClose(actualValues[output.chosen]!, expected.chosen, 'chosen')
  assertClose(actualValues[output.clamped]!, expected.clamped, 'clamped')
  assertArrayClose(actualValues, output.hit, expected.hit, 'hit')
  assertArrayClose(actualValues, output.visible, expected.visible, 'visible')
  assertArrayClose(actualValues, output.winner, expected.winner, 'winner')
  assertClose(actualValues[output.hasSelection]!, expected.hasSelection, 'hasSelection')
  assertClose(actualValues[output.selectedIndex]!, expected.selectedIndex, 'selectedIndex')
  assertClose(actualValues[output.columnCount]!, expected.columnCount, 'columnCount')
  for (let item = 0; item < ITEM_COUNT; item++) {
    for (const field of ['column', 'row', 'left', 'top', 'width', 'height'] as const) {
      assertClose(actualValues[output.layout[item]![field]]!, expected.layout[item]![field], `layout[${item}].${field}`)
    }
    assertClose(actualValues[output.spring[item]!.position]!, expected.spring[item]!.position, `spring[${item}].position`)
    assertClose(actualValues[output.spring[item]!.velocity]!, expected.spring[item]!.velocity, `spring[${item}].velocity`)
  }
}

function assertArrayClose(values: Float64Array, wires: Wire[], expected: number[], label: string) {
  for (let i = 0; i < wires.length; i++) assertClose(values[wires[i]!]!, expected[i]!, `${label}[${i}]`)
}

function assertClose(actual: number, expected: number, label: string) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected))
  assert.ok(
    Math.abs(actual - expected) <= EPSILON * scale,
    `${label}: expected ${expected}, received ${actual}`,
  )
}

function randomInteger(random: Random, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min
}

function randomBetween(random: Random, min: number, max: number): number {
  return random() * (max - min) + min
}

function makeRandom(seed: number): Random {
  let state = seed >>> 0
  return function random() {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

test('fixed-table atom circuit matches the readable reference', () => {
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
    const rectangles: [left: number, top: number, right: number, bottom: number][] = [
      [0, 0, 100, 100],      // Pointer is on the excluded right and bottom edges.
      [100, 100, 200, 200],  // Pointer is on the included left and top edges.
      [100, 100, 200, 200],  // Overlaps item 1 and wins because its index is higher.
      [500, 0, 600, 100],    // Touches the viewport edge without entering it.
    ]
    for (let item = 0; item < ITEM_COUNT; item++) {
      const [left, top, right, bottom] = rectangles[item]!
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
    source[SOURCE.viewportRight] = source[SOURCE.viewportLeft]! + width
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
})

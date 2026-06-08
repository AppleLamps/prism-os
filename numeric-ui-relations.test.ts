import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  Circuit,
  emitMultiply,
  validateTensorEvaluation,
  validateTensorProgram,
} from './numeric-ui-core.ts'

const itemCount = 4
const relationCount = itemCount * itemCount
const sourceField = {
  gap: 0,
  size: 1,
  horizontalRelations: 2,
  verticalRelations: 2 + relationCount,
  sizeInCells: 2 + relationCount * 2,
} as const

const layouts = {
  grid: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  row: [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ],
  stack: [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ],
  overlap: [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ],
} as const

test('relation numbers change structure without changing instructions', () => {
  const {circuit, positions} = compileRelationLayout()
  const program = circuit.tensorProgram = circuit.compileTensorProgram(positions.flat())
  validateTensorProgram(circuit, program)

  for (const [name, expectedRanks] of Object.entries(layouts)) {
    const source = new Float32Array(sourceField.sizeInCells)
    source[sourceField.gap] = 10
    source[sourceField.size] = 100
    writeRanksAsRelations(source, sourceField.horizontalRelations, expectedRanks.map(rank => rank[0]))
    writeRanksAsRelations(source, sourceField.verticalRelations, expectedRanks.map(rank => rank[1]))
    const values = circuit.evaluateTensor(source)
    validateTensorEvaluation(source, circuit, values)

    assert.deepEqual(
      positions.map(([x, y]) => [values[x], values[y]]),
      expectedRanks.map(([x, y]) => [10 + x * 110, 10 + y * 110]),
      name,
    )
    assert.equal(circuit.tensorProgram, program)
  }
})

function compileRelationLayout() {
  const circuit = new Circuit(sourceField.sizeInCells)
  circuit.assumeRange(sourceField.gap, 0, Number.POSITIVE_INFINITY)
  circuit.assumeRange(sourceField.size, 0, Number.POSITIVE_INFINITY)
  for (let relation = 0; relation < relationCount * 2; relation++) {
    circuit.assumeRange(sourceField.horizontalRelations + relation, 0, 1)
  }
  const stride = circuit.affine([[sourceField.gap, 1], [sourceField.size, 1]])
  const positions = Array.from({length: itemCount}, (_, item) => {
    const horizontalRank = relationRank(circuit, sourceField.horizontalRelations, item)
    const verticalRank = relationRank(circuit, sourceField.verticalRelations, item)
    return [
      circuit.affine([
        [sourceField.gap, 1],
        [emitMultiply(circuit, horizontalRank, stride), 1],
      ]),
      circuit.affine([
        [sourceField.gap, 1],
        [emitMultiply(circuit, verticalRank, stride), 1],
      ]),
    ] as const
  })
  return {circuit, positions}
}

function relationRank(circuit: Circuit, relationStart: number, item: number) {
  return circuit.affine(
    Array.from(
      {length: itemCount},
      (_, influencingItem) => [
        relationStart + item * itemCount + influencingItem,
        1,
      ] as const,
    ),
  )
}

function writeRanksAsRelations(
  source: Float32Array,
  relationStart: number,
  ranks: readonly number[],
) {
  for (let item = 0; item < itemCount; item++) {
    for (let influencingItem = 0; influencingItem < ranks[item]!; influencingItem++) {
      source[relationStart + item * itemCount + influencingItem] = 1
    }
  }
}

// Tables that JavaScript writes: numbers prepared outside the program and written into source cells, so
// the compiled program stays the same when the numbers change.
// 1. A comment thread's ancestor table. hn.js climbs from the comment under the pointer to its ancestor at
//    the pointed indent level with a `while` loop. JavaScript runs that loop for every row and level while
//    preparing, and the circuit reads the loop's result with one index read.
// 2. The spring matrix. host-timing.ts computes the matrix of all of this evaluation's 4 ms steps for one
//    stiffness and damping pair, and every spring with those constants applies the same 4 cells.
import {Circuit, type SpringMatrixWires, emitApplySpringMatrix, invariant, asWire} from '../../../../../../numeric-ui-core.ts'
import {type SpringConstants, type SpringMatrix, defaultSpringClockConfig} from '../../../../../../host-timing.ts'

// hn.js line 333, the loop the ancestor table replaces.
export function findAncestor(indents: readonly number[], pointedRow: number, pointedLevel: number): number {
  let ancestor = pointedRow
  while (ancestor > 0 && indents[ancestor]! > pointedLevel) ancestor--
  return ancestor
}

// What JavaScript writes whenever the thread changes: ancestorAtLevel[row × levelCount + level]. Rows past
// the thread's last comment point at themselves, so every cell stays within its declared range.
export function prepareAncestorTable(indents: readonly number[], rowCapacity: number, levelCount: number): number[] {
  invariant(indents.length <= rowCapacity, 'the thread has more comments than the table has rows')
  const table: number[] = []
  for (let row = 0; row < rowCapacity; row++) {
    for (let level = 0; level < levelCount; level++) {
      table.push(row < indents.length ? findAncestor(indents, row, level) : row)
    }
  }
  return table
}

export function buildAncestorLookup(rowCapacity: number, levelCount: number) {
  // Source cells: the pointed row and level, which an earlier part of the program would compute from the
  // pointer, then the ancestor table, then every row's top.
  const cells = {pointedRow: 0, pointedLevel: 1, tableStart: 2, rowTopsStart: 2 + rowCapacity * levelCount}
  const circuit = new Circuit(cells.rowTopsStart + rowCapacity)
  circuit.assumeRange(asWire(cells.pointedRow), 0, rowCapacity - 1)
  circuit.assumeRange(asWire(cells.pointedLevel), 0, levelCount - 1)
  const ancestorTable = Array.from({length: rowCapacity * levelCount}, (_, entry) => cells.tableStart + entry)
  for (const cell of ancestorTable) circuit.assumeRange(asWire(cell), 0, rowCapacity - 1)
  const rowTops = Array.from({length: rowCapacity}, (_, row) => cells.rowTopsStart + row)
  for (const cell of rowTops) circuit.assumeRange(asWire(cell), 0, 2 ** 20)
  // JS: let ancestor = row; while (ancestor > 0 && indents[ancestor] > level) ancestor--
  const ancestor = circuit.indexReadAffine([[asWire(cells.pointedRow), levelCount], [asWire(cells.pointedLevel), 1]], 0, ancestorTable.map(asWire), 'clamp', 'clamp')
  // JS: rowTops[ancestor]
  const ancestorTop = circuit.indexRead(ancestor, rowTops.map(asWire))
  return {circuit, cells, ancestorTable, rowTops, ancestor, ancestorTop, roots: [ancestor, ancestorTop]}
}

// index.ts's spring steps, the loop the spring matrix replaces: one semi-implicit Euler step per 4 ms, for
// every spring. Each spring stores its displacement from its destination.
export function stepSpringsReference(
  constants: SpringConstants,
  steps: number,
  displacements: readonly number[],
  velocities: readonly number[],
) {
  const dt = defaultSpringClockConfig.stepMs / 1000
  const nextDisplacements = [...displacements]
  const nextVelocities = [...velocities]
  for (let step = 0; step < steps; step++) {
    for (let spring = 0; spring < nextDisplacements.length; spring++) {
      nextVelocities[spring] = nextVelocities[spring]! + (-constants.stiffness * nextDisplacements[spring]! - constants.damping * nextVelocities[spring]!) * dt
      nextDisplacements[spring] = nextDisplacements[spring]! + nextVelocities[spring]! * dt
    }
  }
  return {displacements: nextDisplacements, velocities: nextVelocities}
}

// matrixBound is the largest magnitude the host may write into the 4 matrix cells, e.g. the largest
// springMatrixBound over every stiffness and damping pair a designer may pick at runtime.
export function buildSharedSpring(springCount: number, matrixBound: number) {
  // Source cells: the spring matrix, then each spring's displacement and velocity.
  const circuit = new Circuit(4 + 2 * springCount)
  const matrix: SpringMatrixWires = [asWire(0), asWire(1), asWire(2), asWire(3)]
  for (const cell of matrix) circuit.assumeRange(cell, -matrixBound, matrixBound)
  const springs = Array.from({length: springCount}, (_, spring) => ({displacement: 4 + 2 * spring, velocity: 5 + 2 * spring}))
  // JS: for (let step = 0; step < steps; step++) { velocity += ...; displacement += velocity × dt }
  const stepped = springs.map(spring => emitApplySpringMatrix(circuit, matrix, asWire(spring.displacement), asWire(spring.velocity)))
  return {circuit, matrix, springs, roots: stepped.flatMap(({displacement, velocity}) => [displacement, velocity])}
}

export function writeSharedSpring(
  built: ReturnType<typeof buildSharedSpring>,
  source: Float32Array,
  matrix: SpringMatrix,
  displacements: readonly number[],
  velocities: readonly number[],
) {
  built.matrix.forEach((cell, entry) => {
    source[cell] = matrix[entry]!
  })
  built.springs.forEach((spring, index) => {
    source[spring.displacement] = displacements[index]!
    source[spring.velocity] = velocities[index]!
  })
}

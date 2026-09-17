import {describe, expect, test} from 'bun:test'
import {type SpringConstants, springMatrixBound, springMatrixPower, springStepMatrix} from '../../../../../../src/runtime/host-timing.ts'
import {validateIndexReads, validateTensorEvaluation} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {createRandom, formatSize, measureProgram} from './measure.ts'
import {
  buildAncestorLookup,
  buildSharedSpring,
  findAncestor,
  prepareAncestorTable,
  stepSpringsReference,
  writeSharedSpring,
} from './tables-javascript-writes.ts'

describe('an ancestor table that JavaScript writes', () => {
  const diagramIndents = [0, 1, 2, 1, 2, 3]
  const diagramRowTops = [0, 40, 80, 120, 160, 200]

  function diagramSource(built: ReturnType<typeof buildAncestorLookup>) {
    const source = new Float32Array(built.circuit.sourceSize)
    source.set(prepareAncestorTable(diagramIndents, 6, 4), built.cells.tableStart)
    source.set(diagramRowTops, built.cells.rowTopsStart)
    source[built.cells.pointedRow] = 5
    source[built.cells.pointedLevel] = 2
    return source
  }

  test("the pattern doc's diagram", () => {
    expect(prepareAncestorTable(diagramIndents, 6, 4)).toEqual([
      0, 0, 0, 0,
      0, 1, 1, 1,
      0, 1, 2, 2,
      0, 3, 3, 3,
      0, 3, 4, 4,
      0, 3, 4, 5,
    ])
    const built = buildAncestorLookup(6, 4)
    const values = built.circuit.evaluateReference(diagramSource(built))
    expect([values[built.ancestor], values[built.ancestorTop]]).toEqual([4, 160])
  })

  test('random and named threads through one compiled program match the while loop, in both evaluators', () => {
    const rowCapacity = 64
    const levelCount = 8
    const built = buildAncestorLookup(rowCapacity, levelCount)
    const evaluate = built.circuit.createTensorEvaluator(built.roots)
    const source = new Float32Array(built.circuit.sourceSize)
    const random = createRandom(21)
    // A valid thread: the first comment is top-level, and each comment is at most one level deeper than the one before.
    const randomThread = () => {
      const rowCount = 1 + Math.floor(random() * rowCapacity)
      const indents = [0]
      for (let row = 1; row < rowCount; row++) indents.push(Math.floor(random() * (Math.min(levelCount - 1, indents[row - 1]! + 1) + 1)))
      return indents
    }
    const threads = [
      [0],
      Array.from({length: rowCapacity}, () => 0),
      Array.from({length: rowCapacity}, (_, row) => Math.min(row, levelCount - 1)),
      Array.from({length: rowCapacity}, (_, row) => row % 2),
      ...Array.from({length: 41}, randomThread),
    ]
    expect(threads.length).toBe(45)
    threads.forEach((indents, thread) => {
      // What the host writes when the thread changes. The compiled program stays the same.
      source.set(prepareAncestorTable(indents, rowCapacity, levelCount), built.cells.tableStart)
      for (let row = 0; row < rowCapacity; row++) source[built.cells.rowTopsStart + row] = row * 36 + Math.floor(random() * 24)
      for (let row = 0; row < indents.length; row++) {
        for (let level = 0; level < levelCount; level++) {
          source[built.cells.pointedRow] = row
          source[built.cells.pointedLevel] = level
          const ancestor = findAncestor(indents, row, level)
          const expected = [ancestor, source[built.cells.rowTopsStart + ancestor]!].join()
          const actual = Array.from(evaluate(source)).join()
          if (actual !== expected) throw new Error(`thread ${thread}, row ${row}, level ${level}: got ${actual}, expected ${expected}`)
          if ((row + level) % 13 === 0) {
            const values = built.circuit.evaluateReference(source)
            expect([values[built.ancestor], values[built.ancestorTop]].join()).toBe(expected)
            validateIndexReads(built.circuit, values)
          }
        }
      }
    })
    validateTensorEvaluation(source, built.circuit, built.circuit.evaluateTensor(source))
  })

  test("gradients reach the table's values, and the index gets none", () => {
    const built = buildAncestorLookup(6, 4)
    const values = built.circuit.evaluateReference(diagramSource(built))
    const outputGradients = new Float32Array(values.length)
    outputGradients[built.ancestorTop] = 1
    expect(() => built.circuit.backpropagateReference(values, outputGradients)).toThrow('cannot backpropagate into the index of an index read')
    const gradients = built.circuit.backpropagateReference(values, outputGradients, {indexGradient: 'zero'})
    expect(built.rowTops.map(cell => gradients[cell])).toEqual([0, 0, 0, 0, 1, 0])
    expect(built.ancestorTable.every(cell => gradients[cell] === 0)).toBe(true)
    expect([gradients[built.cells.pointedRow], gradients[built.cells.pointedLevel]]).toEqual([0, 0])
  })

  test('sizes quoted in the pattern doc', () => {
    for (const [rowCapacity, levelCount] of [[64, 8], [1024, 16]] as const) {
      const built = buildAncestorLookup(rowCapacity, levelCount)
      expect(formatSize(measureProgram(built.circuit, built.roots))).toBe('2 operations, 2 layers, 3 weights, 0 gather reads, 2 index reads')
    }
  })
})

describe('a spring matrix that JavaScript writes', () => {
  const pairs: SpringConstants[] = [
    {stiffness: 290, damping: 30},
    {stiffness: 650, damping: 45},
    {stiffness: 120, damping: 14},
    {stiffness: 170, damping: 26},
  ]
  // Declared on the matrix cells: the largest bound over every pair the host may write.
  const matrixBound = Math.max(...pairs.map(pair => springMatrixBound(pair)))
  const springCount = 8

  test("one compiled program applies any pair's matrix for any step count, close to the float64 loop, in both evaluators", () => {
    const built = buildSharedSpring(springCount, matrixBound)
    const evaluate = built.circuit.createTensorEvaluator(built.roots)
    const source = new Float32Array(built.circuit.sourceSize)
    const random = createRandom(33)
    let largestDisplacementError = 0
    let largestVelocityError = 0
    for (let run = 0; run < 400; run++) {
      const pair = pairs[run % pairs.length]!
      const steps = run < 16 ? [0, 1, 4, 300][run % 4]! : Math.floor(random() * 301)
      // Displacements within ±800 px and velocities within ±2,000 px/s on a 1/64 grid, then a spring at rest
      // and a spring released from rest.
      const displacements = Array.from({length: springCount}, () => Math.round((random() * 1600 - 800) * 64) / 64)
      const velocities = Array.from({length: springCount}, () => Math.round((random() * 4000 - 2000) * 64) / 64)
      displacements[0] = 0
      velocities[0] = 0
      displacements[1] = 800
      velocities[1] = 0
      writeSharedSpring(built, source, springMatrixPower(springStepMatrix(pair), steps), displacements, velocities)
      const actual = Array.from(evaluate(source))
      const expected = stepSpringsReference(pair, steps, displacements, velocities)
      for (let spring = 0; spring < springCount; spring++) {
        largestDisplacementError = Math.max(largestDisplacementError, Math.abs(actual[2 * spring]! - expected.displacements[spring]!))
        largestVelocityError = Math.max(largestVelocityError, Math.abs(actual[2 * spring + 1]! - expected.velocities[spring]!))
      }
      // A spring at rest stays exactly at rest, and 0 steps leave every spring unchanged.
      expect([actual[0], actual[1]].join()).toBe('0,0')
      if (steps === 0) expect(actual.join()).toBe(displacements.flatMap((displacement, spring) => [displacement, velocities[spring]!]).join())
      if (run % 40 === 0) {
        const values = built.circuit.evaluateReference(source)
        expect(built.roots.map(root => values[root]!).join()).toBe(actual.join())
        validateTensorEvaluation(source, built.circuit, built.circuit.evaluateTensor(source))
      }
    }
    expect(largestDisplacementError).toBeLessThan(1e-4)
    expect(largestVelocityError).toBeLessThan(1e-3)
  })

  test('the backward pass reaches the 4 matrix cells, and JavaScript finishes the chain rule to stiffness and damping', () => {
    const built = buildSharedSpring(1, matrixBound)
    const source = new Float32Array(built.circuit.sourceSize)
    // Stiffness 290 and damping 30, 16 steps, from 100 px short of the destination and at rest, like the
    // differentiability section's example.
    const pair = {stiffness: 290, damping: 30}
    const steps = 16
    writeSharedSpring(built, source, springMatrixPower(springStepMatrix(pair), steps), [-100], [0])
    const values = built.circuit.evaluateReference(source)
    const outputGradients = new Float32Array(values.length)
    outputGradients[built.roots[0]!] = 1
    const gradients = built.circuit.backpropagateReference(values, outputGradients)
    // displacement' = m[0] × displacement + m[1] × velocity
    expect(built.matrix.map(cell => gradients[cell])).toEqual([-100, 0, 0, 0])
    // d displacement' / d parameter = sum over entries of (d displacement' / d entry) × (d entry / d parameter),
    // with d entry / d parameter from a central difference of the float64 matrix power.
    const h = 1e-3
    const chainRule = {stiffness: 0, damping: 0}
    for (const parameter of ['stiffness', 'damping'] as const) {
      const shifted = (delta: number): SpringConstants => ({...pair, [parameter]: pair[parameter] + delta})
      const plus = springMatrixPower(springStepMatrix(shifted(h)), steps)
      const minus = springMatrixPower(springStepMatrix(shifted(-h)), steps)
      chainRule[parameter] = built.matrix.reduce((total, cell, entry) => total + gradients[cell]! * (plus[entry]! - minus[entry]!) / (2 * h), 0)
      const loopDifference = (stepSpringsReference(shifted(h), steps, [-100], [0]).displacements[0]!
        - stepSpringsReference(shifted(-h), steps, [-100], [0]).displacements[0]!) / (2 * h)
      expect(Math.abs(chainRule[parameter] - loopDifference)).toBeLessThan(1e-6 * Math.abs(loopDifference))
    }
    expect(chainRule.stiffness).toBeCloseTo(0.1055, 4)
    expect(chainRule.damping).toBeCloseTo(-0.5047, 4)
  })

  test('sizes quoted in the pattern doc', () => {
    const oneSpring = buildSharedSpring(1, matrixBound)
    expect(formatSize(measureProgram(oneSpring.circuit, oneSpring.roots))).toBe('14 operations, 3 layers, 28 weights, 0 gather reads, 0 index reads')
    const twentySprings = buildSharedSpring(20, matrixBound)
    expect(formatSize(measureProgram(twentySprings.circuit, twentySprings.roots))).toBe('280 operations, 3 layers, 560 weights, 0 gather reads, 0 index reads')
  })
})

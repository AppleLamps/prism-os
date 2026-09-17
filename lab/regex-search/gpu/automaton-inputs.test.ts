// Checks automaton-inputs.ts against tree-inputs.ts, which is written from the definition: the leaf matrices, both plain
// loops, and the GPU plan run in JavaScript all give productTreeInputs's reach bits. The kernels themselves run only in
// page.ts, which compares every readback with the bit files that cpu-time.ts writes.
import {expect, test} from 'bun:test'
import {codePointsOf} from '../host.ts'
import {compilePattern} from '../pattern.ts'
import {patternsByStates} from '../report.ts'
import {augmentedLeaves, productTreeInputs} from '../tree-inputs.ts'
import {bitmaskInputs, bitmaskReach, classInputs, createLeafWriter, denseReach, gpuPlan, packReach, runGpuPlanInJavaScript, textOf} from './automaton-inputs.ts'

const firstDifference = (left: ArrayLike<number>, right: ArrayLike<number>) => {
  if (left.length !== right.length) return `lengths ${left.length} and ${right.length}`
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return `index ${index}: ${left[index]} and ${right[index]}`
  return undefined
}

test('leaves, both plain loops and the GPU plan in JavaScript give the reference reach bits', () => {
  const cases: {states: number, pattern: string, codePoints: number[], textLength?: number}[] = [
    ...[8, 16, 32].flatMap(states => [1, 2, 37, 256, 1024].map(textLength => ({states, pattern: patternsByStates[states]!, codePoints: textOf(textLength)}))),
    // Code points that no step reads, e.g. the emoji and U+2028, and a match on the last code point.
    {states: 8, pattern: '[^a-z]x|\\d+', codePoints: codePointsOf('a😀x12 xb 9 ab😀x')},
    {states: 32, pattern: '(the|an?|some|this|that|these) [a-z]+(ing|ed|s)? ', codePoints: codePointsOf('a cat, these ox ')},
    // A text shorter than N, where [^a] reads every code point of the text but none of the positions past its end.
    {states: 8, pattern: '[^a]+', codePoints: codePointsOf('bab'), textLength: 37},
    // 32 states that all reach an accepting state, so bit 31 of the words is 1 at some positions.
    {states: 32, pattern: '[ab]*'.repeat(31), codePoints: codePointsOf('abxab'.repeat(8))},
  ]
  for (const {states, pattern, codePoints, textLength = codePoints.length} of cases) {
    const compiled = compilePattern(pattern)
    const reference = productTreeInputs(compiled, codePoints, {states, textLength})
    const expected = packReach(reference.reach, states, textLength)
    const label = `${pattern} at S = ${states}, N = ${textLength}`
    const inputs = classInputs(compiled, codePoints, states, textLength)
    const writer = createLeafWriter(inputs)
    const leaves = new Float32Array(textLength * writer.size * writer.size)
    const lastColumn = new Float32Array(writer.size)
    writer.write(leaves, lastColumn)
    expect([label, firstDifference(leaves, augmentedLeaves(reference))]).toEqual([label, undefined])
    const reach = new Uint8Array(textLength * states)
    denseReach(inputs, reach)
    expect([label, firstDifference(reach, reference.reach)]).toEqual([label, undefined])
    const words = new Uint32Array(textLength)
    bitmaskReach(bitmaskInputs(inputs), words)
    expect([label, firstDifference(words, expected)]).toEqual([label, undefined])
    expect([label, firstDifference(runGpuPlanInJavaScript(gpuPlan(textLength), states, leaves, lastColumn), expected)]).toEqual([label, undefined])
  }
}, 60_000)

test('the plan runs every level after the levels it reads, and writes every slot once', () => {
  for (const textLength of [1, 2, 3, 37, 256, 1024, 16_384]) {
    const plan = gpuPlan(textLength)
    const matrixLevel = new Int32Array(plan.matrixSlots).fill(-1)
    const vectorLevel = new Int32Array(textLength).fill(-1)
    for (let slot = 0; slot < textLength; slot++) matrixLevel[slot] = 0
    vectorLevel[textLength - 1] = 0
    plan.levels.forEach(({matrixOffset, matrixCount, vectorOffset, vectorCount}, index) => {
      const level = index + 1
      for (let combine = matrixOffset; combine < matrixOffset + matrixCount; combine++) {
        const [earlier, later, result] = plan.matrixTriples.subarray(combine * 3, combine * 3 + 3)
        expect([matrixLevel[earlier!]! >= 0, matrixLevel[earlier!]! < level, matrixLevel[later!]! >= 0, matrixLevel[later!]! < level, matrixLevel[result!]]).toEqual([true, true, true, true, -1])
        matrixLevel[result!] = level
      }
      for (let combine = vectorOffset; combine < vectorOffset + vectorCount; combine++) {
        const [earlier, later, result] = plan.vectorTriples.subarray(combine * 3, combine * 3 + 3)
        expect([matrixLevel[earlier!]! >= 0, matrixLevel[earlier!]! < level, vectorLevel[later!]! >= 0, vectorLevel[later!]! < level, vectorLevel[result!]]).toEqual([true, true, true, true, -1])
        vectorLevel[result!] = level
      }
    })
    expect([textLength, matrixLevel.includes(-1), vectorLevel.includes(-1)]).toEqual([textLength, false, false])
  }
})

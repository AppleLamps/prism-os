// The CPU side of every comparison: the executor's outputs for many documents, and counting values that differ.
import {invariant} from '../runtime/numeric-ui-core.ts'
import {type BatchProgram, cellsPerDocument} from './program.ts'

// How many of the first `length` values differ. Zeros of either sign count as equal, as in every GPU comparison of this
// repo, and a NaN on either side counts as a difference.
export function countMismatches(actual: ArrayLike<number>, expected: ArrayLike<number>, length: number) {
  let mismatches = 0
  for (let index = 0; index < length; index++) if (actual[index] !== expected[index]) mismatches++
  return mismatches
}

// The executor's outputs for the first `count` documents of `cells`, one array per output group, document after
// document. A Uint8Array target holds a group whose values are small integers in a quarter of the memory, e.g. the
// display kinds of 100,000 documents in 51 MB.
export function expectedOutputs(program: BatchProgram, cells: Float32Array, count: number, targets?: (Float32Array | Uint8Array)[]) {
  const outputs = targets ?? program.outputCounts.map(outputCount => new Float32Array(count * outputCount))
  const source = new Float32Array(program.sharedValues)
  for (let index = 0; index < count; index++) {
    const values = program.evaluate(program.writeSource(source, cells, index))
    let read = 0
    for (let group = 0; group < outputs.length; group++) {
      const target = outputs[group]!
      const outputCount = program.outputCounts[group]!
      const base = index * outputCount
      for (let output = 0; output < outputCount; output++) {
        const value = values[read++]!
        if (target instanceof Uint8Array && !(Number.isInteger(value) && value >= 0 && value <= 255)) invariant(false, `output ${output} of document ${index} is ${value}, which a byte doesn't hold`)
        target[base + output] = value
      }
    }
  }
  invariant(cells.length >= count * cellsPerDocument, 'the cells hold every document')
  return outputs
}

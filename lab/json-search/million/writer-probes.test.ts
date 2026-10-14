// A reviewer's check of bit-emit.ts, kept as tests: the programs of writer-probes.ts and a sample of writer-fuzz.ts's
// random programs, each as both writers' shaders through the strict WGSL interpreter against the CPU executor.
// A program of `knownDefects` is one where bit-emit.ts stops, writes a shader that a GPU refuses, or gives another
// value than loop-emit.ts's shader, as found on October 14, 2026. Its test is marked as failing, so that it reports
// when the writer is fixed, and the entry can go.
// Run from the repo root: bun test lab/json-search/million/writer-probes.test.ts
import {describe, expect, test} from 'bun:test'
import {buildLanes, buildScalar} from './writer-fuzz.ts'
import {compareProbe, probes} from './writer-probes.ts'

const knownDefects: Record<string, string> = {
  // A list of more than 32 shared cells, of their negations, or of gates of one form over them is written as one word:
  // `(s34b << 32u)`, or a mask of 40 bits.
  noneOf33: 'a shift by 32 bits',
  noneOf40: 'a shift by 32 bits',
  noneOfNegations40: 'a mask of 40 bits for a u32',
  noneOfGates40: 'a mask of 40 bits for a u32',
  // A weight that i32 doesn't hold on a value that is proven to be 0, e.g. a sign cascade's 2^127.
  comparedZeros: 'the literal 1.7014118346046923e+38i',
  largeWeightOnZero: 'the literal 2147483648i',
  // A field that the loop program declares as plain numbers and two loops fill: the writer holds it as a word of bits
  // and then wants one stage to write every bit.
  splitField: 'bit-emit.ts stops with "a stage that writes a field of bits writes every bit of it"',
  // The register is held as f32, and the operation that reads it is still taken for a whole number: i32(0.5).
  registerFractionWritten: 'i32() of a number that isn\'t whole',
}

describe('bit-emit.ts on a reviewer\'s programs', () => {
  for (const [name, build] of Object.entries(probes)) {
    const check = () => {
      const result = compareProbe(build(), 20261014, 24)
      expect([result.threw, result.mismatches, result.values > 1000 && result.nonZero > 0]).toEqual([undefined, [0, 0], true])
    }
    const defect = knownDefects[name]
    if (defect === undefined) test(`${name}: both shaders give the executor's values`, check)
    else test.failing(`${name}: known defect, ${defect}`, check)
  }
})

describe('bit-emit.ts on random programs', () => {
  for (const [kind, build] of [['scalar', buildScalar], ['lanes', buildLanes]] as const) {
    test(`${kind}: 150 random programs give the executor's values from both shaders`, () => {
      const totals = {programs: 0, values: 0, stopped: [] as string[], different: [] as string[]}
      for (let seed = 1; seed <= 150; seed++) {
        let result
        try {
          result = compareProbe(build(seed), seed, 8)
        } catch {
          // The builder or the executor refused the random program.
          continue
        }
        totals.programs++
        totals.values += result.values
        if (result.threw !== undefined) totals.stopped.push(`seed ${seed}: ${result.threw}`)
        else if (result.mismatches[0] + result.mismatches[1] > 0) totals.different.push(`seed ${seed}: ${result.firstMismatch}`)
      }
      expect([totals.stopped, totals.different, totals.programs > 140, totals.values > 100_000]).toEqual([[], [], true, true])
    })
  }
})

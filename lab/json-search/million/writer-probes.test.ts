// A reviewer's check of bit-emit.ts, kept as tests: the programs of writer-probes.ts and a sample of writer-fuzz.ts's
// random programs, each as both writers' shaders through the strict WGSL interpreter against the CPU executor.
// Eight of the programs found defects on October 14, 2026, which are fixed since: a gate over more than 32 bits
// (noneOf33, noneOf40, noneOfNegations40, noneOfGates40), a weight that i32 doesn't hold (comparedZeros,
// largeWeightOnZero), a field that two loops fill (splitField), and a register whose own stage breaks its declared grid
// (registerFractionWritten), where bit-emit.ts's shader gave 7 for the executor's 6.5.
// Run from the repo root: bun test lab/json-search/million/writer-probes.test.ts
import {describe, expect, test} from 'bun:test'
import {buildLanes, buildScalar} from './writer-fuzz.ts'
import {compareProbe, probes} from './writer-probes.ts'

describe('bit-emit.ts on a reviewer\'s programs', () => {
  for (const [name, build] of Object.entries(probes)) {
    test(`${name}: both shaders give the executor's values`, () => {
      const result = compareProbe(build(), 20261014, 24)
      expect([result.threw, result.mismatches, result.values > 1000 && result.nonZero > 0]).toEqual([undefined, [0, 0], true])
    })
  }
})

describe('bit-emit.ts on random programs', () => {
  // In a 'broken' program, two registers' own stage writes numbers that their cells' declarations rule out.
  for (const [kind, build] of [['scalar', buildScalar], ['lanes', buildLanes], ['broken', (seed: number) => buildScalar(seed, true)]] as const) {
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

// A reviewer's check of bit-emit.ts, kept as tests: the programs of writer-probes.ts and a sample of writer-fuzz.ts's
// random programs, each as both writers' shaders through the strict WGSL interpreter against the CPU executor.
// Eight of the programs found defects on October 14, 2026, which are fixed since: a gate over more than 32 bits
// (noneOf33, noneOf40, noneOfNegations40, noneOfGates40), a weight that i32 doesn't hold (comparedZeros,
// largeWeightOnZero), a field that two loops fill (splitField), and a register whose own stage breaks its declared grid
// (registerFractionWritten), where bit-emit.ts's shader gave 7 for the executor's 6.5.
// Run from the repo root: bun test lab/json-search/million/writer-probes.test.ts
import {describe, expect, test} from 'bun:test'
import {emitBitLoopWgsl} from '../bit-emit.ts'
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

describe('the form that bit-emit.ts writes for the same program written in other ways', () => {
  // Per probe: the rules that fired, the packed words, and the shader's statements.
  const formOf = (name: string) => {
    const shader = emitBitLoopWgsl(probes[name]!().loop)
    return [Object.fromEntries(Object.entries(shader.rules).filter(([, count]) => count > 0)), shader.packedCells.length, shader.statementCount]
  }
  // The search step's two passes written without the repo's helpers: 16 gates of 8 reads are 16 word reads, and four
  // lists of 8 bits are word operations. loop-emit.ts writes 395 statements for it.
  const miniSearch = [{sum: 3, gate: 18, packedRead: 128, packedWord: 16, lane: 32}, 272, 75]

  test('the search step\'s passes: the same form whatever the tables\' layout and the order in which a gate\'s reads are built', () => {
    for (const name of ['miniSearch', 'miniSearchByTable', 'miniSearchByClassReversed', 'miniSearchDescending', 'miniSearchRotated']) expect([name, ...formOf(name)]).toEqual([name, ...miniSearch])
  })

  test('`transition && bit` as a plain read and an AND gate: every pass is word operations, and the forward pass keeps one read per state on its own', () => {
    // State 0's AND gate reads the sum of two bits that are never both 1, so it is another kind of gate than the
    // other states', and its read stays out of the word: 8 reads and 8 comparisons for the 8 states that are stepped into.
    const form = [{sum: 3, gate: 19, comparison: 8, read: 8, packedRead: 120, packedWord: 16, lane: 159}, 272, 115]
    expect([formOf('miniSearchAndGate'), formOf('miniSearchAndGateDescending')]).toEqual([form, form])
  })

  test('a second list of carried bits in the same loop: each list is a word of its own', () => {
    expect(formOf('switchesAndSeen')).toEqual([{sum: 2, gate: 1, packedRead: 8, packedWord: 1, lane: 24}, 6, 58])
    const lines = emitBitLoopWgsl(probes['switchesAndSeen']!().loop).code.split('\n')
    expect(lines.filter(line => line.startsWith('var r'))).toEqual(['var r16: i32 = 0i;', 'var rw0: u32 = 255u;', 'var rw1: u32 = 0u;'])
  })

  test('the limits: a list that is read in another order than its bits are stored is built bit by bit', () => {
    // Switch k reads switch 7 - k: the registers are variables of their own, and every gate is one statement.
    expect(formOf('switchesReversed')).toEqual([{sum: 2, gate: 9, read: 8}, 0, 73])
    // The notReach bits are stored in reverse order of the states: the reads are still packed, 24 of the 32 lanes
    // are left, and the list that the forward pass reads is put together from 8 bits.
    expect(formOf('miniSearchFieldReversed')).toEqual([{sum: 11, gate: 26, packedRead: 128, packedWord: 16, lane: 24}, 272, 112])
    // Five gating bits on a read, where the rule goes through at most four: the reads are read one by one.
    expect(formOf('fiveBits')).toEqual([{sum: 2, gate: 2, read: 3}, 0, 42])
  })

  test('a table of bits doesn\'t have to be declared with inputBit: cells on a grid of 1 within 0..1 and constants are packed, whole numbers and ordinary numbers aren\'t', () => {
    const packed = [{sum: 2, gate: 2, packedRead: 3, packedWord: 1}, 6, 33]
    expect([formOf('gridBitTables'), formOf('constantTables')]).toEqual([packed, packed])
    expect([formOf('wholeTables')[1], formOf('floatTables')[1]]).toEqual([0, 0])
  })

  test('a gate over more than 32 bits is tested 32 bits at a time', () => {
    const lines = emitBitLoopWgsl(probes['noneOf40']!().loop).code.split('\n')
    expect(lines.filter(line => line.includes('== 0u'))).toEqual(['let a_v43b: u32 = u32(sw0 == 0u) & u32(sw1 == 0u);'])
    expect(lines.filter(line => line.startsWith('let sw1'))).toEqual(['let sw1: u32 = s34b | (s35b << 1u) | (s36b << 2u) | (s37b << 3u) | (s38b << 4u) | (s39b << 5u) | (s40b << 6u) | (s41b << 7u);'])
  })
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

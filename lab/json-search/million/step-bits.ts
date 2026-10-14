// What an emitter could know about the program's own search step without running it: which of its operations hold a
// value that is 0 or 1, which ReLU gates are an AND, an OR or a test against 0 of such values, and which table reads are
// a transition cell gated by one bit. It reads the compiled stages of search-step.ts and the ranges and grids that the
// builder keeps per wire, and prints one row per stage and state capacity.
//
//   bun lab/json-search/million/step-bits.ts
import {flattenProgram} from '../../../src/json-search/emit.ts'
import {cellsPerDocument} from '../../../src/json-search/program.ts'
import {boundaryCapacity, buildSearchLoop, classCapacity} from '../../../src/json-search/search-step.ts'

const rows: string[] = ['| States | Stage | Operations | Hold 0 or 1 | A comparison of two whole numbers, as two ReLU gates | A ReLU gate over bits with weights of 1 and -1 | A sum of bits | Table reads | Of those, a transition cell gated by a bit | Of those, gated by the sum of two bits | Reads that feed one gate | Other operations |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
for (const states of [8, 16, 32]) {
  const built = buildSearchLoop({states, classes: classCapacity, boundaries: boundaryCapacity}, {positions: 512, cellsPerDocument, masked: false, stopAtLength: false})
  for (const stage of built.loop.stages) {
    const {program, circuit} = stage
    const wireAt = (position: number) => program.wireOrder[position]!
    // A source cell is a bit when its range is 0..1. In this program every such cell is declared with inputBit, whose
    // `exactBit` says that it holds exactly 0 or 1. The circuit keeps the range and not that declaration, so an emitter
    // would need the cells' declarations passed along with a stage.
    const isBitWire = (wire: number) => {
      const range = circuit.ranges[wire]!
      return range.minimum === 0 && range.maximum === 1
    }
    const flat = flattenProgram(program)
    const bitPositions = new Set<number>()
    for (let position = 0; position < program.sourceSize; position++) if (isBitWire(wireAt(position))) bitPositions.add(position)
    const counts = {operations: flat.length, bits: 0, comparisons: 0, bitGates: 0, bitSums: 0, reads: 0, gatedReads: 0, sumGatedReads: 0, other: 0}
    // The inner gate of a comparison, relu(boundary - codePoint), by its position.
    const innerOfComparison = new Set<number>()
    const gatedReadPositions = new Set<number>()
    const readsPerGate = new Map<number, number>()
    for (const row of flat) {
      const range = circuit.ranges[wireAt(row.position)]!
      const withinUnit = range.minimum >= 0 && range.maximum <= 1
      if (row.kind === 'index') {
        counts.reads++
        const candidatesAreBits = Array.from({length: row.candidateCount}, (_, index) => row.candidateBase + index * row.candidateStride).every(position => bitPositions.has(position))
        if (candidatesAreBits) {
          bitPositions.add(row.position)
          counts.bits++
        }
        // JS: transitions[class][from][to] && bit, as a read at class + classes * (1 - bit), which is 0 past the table.
        // The forward stage's reads from state 0 have two such terms: their bit is live[0] = continuing[0] + start, a sum
        // that the builder copies into the read. The sum is an OR only because the two bits are never both 1, which
        // orExclusive's caller knows and the compiled program doesn't say.
        const gates = row.indexTerms.filter(term => Math.abs(term.weight) === row.candidateCount && bitPositions.has(term.position))
        if (candidatesAreBits && gates.length > 0 && row.aboveZero) {
          counts.gatedReads++
          if (gates.length > 1) counts.sumGatedReads++
          gatedReadPositions.add(row.position)
        }
        continue
      }
      const terms = row.kind === 'reglu' ? row.gateTerms : row.terms
      const overBits = terms.every(term => bitPositions.has(term.position) && Math.abs(term.weight) === 1)
      if (row.kind === 'reglu' && row.terms.length === 0 && row.bias === 1) {
        // max(0, 1 - max(0, boundary - codePoint)) is [codePoint >= boundary] for whole numbers.
        const inner = terms.length === 1 && terms[0]!.weight === -1 && row.gateBias === 1 && innerOfComparison.has(terms[0]!.position)
        if (inner) {
          counts.comparisons++
          counts.bits++
          bitPositions.add(row.position)
          continue
        }
        if (overBits && withinUnit && terms.length > 0) {
          counts.bitGates++
          counts.bits++
          bitPositions.add(row.position)
          const reads = terms.filter(term => gatedReadPositions.has(term.position)).length
          if (reads > 0) readsPerGate.set(reads, (readsPerGate.get(reads) ?? 0) + 1)
          continue
        }
        // Not a bit itself: the inner gate of a comparison.
        if (terms.length <= 2 && !withinUnit) {
          innerOfComparison.add(row.position)
          counts.comparisons++
          continue
        }
      }
      if (row.kind === 'affine' && overBits && withinUnit && terms.length > 0) {
        counts.bitSums++
        counts.bits++
        bitPositions.add(row.position)
        continue
      }
      counts.other++
    }
    const perGate = [...readsPerGate].map(([reads, gates]) => `${gates} gates of ${reads} reads`).join(', ')
    rows.push(`| ${states} | ${stage.name} | ${counts.operations} | ${counts.bits} | ${counts.comparisons} | ${counts.bitGates} | ${counts.bitSums} | ${counts.reads} | ${counts.gatedReads} | ${counts.sumGatedReads} | ${perGate} | ${counts.other} |`)
  }
}
console.log(rows.join('\n'))

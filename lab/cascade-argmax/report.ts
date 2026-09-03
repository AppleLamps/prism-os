// Prints the README's measured tables. Run with: bun lab/cascade-argmax/report.ts

import {
  type ArgmaxTree,
  type ArgmaxVariant,
  buildArgmaxTree,
  circuitOpCounts,
} from './cascade-argmax.ts'
import {defaultTrainingConfig, trainSelection} from './training.ts'

class RandomSource {
  state: number
  constructor(seed: number) {
    this.state = seed | 0
  }
  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) | 0
    return (this.state >>> 0) / 4_294_967_296
  }
}

// Fastest-of-three timing of the compiled tensor backend, microseconds per evaluation.
function timeTensor(tree: ArgmaxTree, evaluationsPerRound = 2000): number {
  const random = new RandomSource(99)
  const sources: Float32Array[] = Array.from({length: 64}, () => {
    const source = new Float32Array(tree.circuit.sourceSize)
    for (const wire of tree.scoreWires) source[wire] = Math.fround(random.next())
    source[tree.unitWire] = 1
    return source
  })
  // Warmup, then three rounds; keep the fastest.
  for (let i = 0; i < 300; i++) tree.circuit.evaluateTensor(sources[i % sources.length]!)
  let best = Number.POSITIVE_INFINITY
  for (let round = 0; round < 3; round++) {
    const start = performance.now()
    for (let i = 0; i < evaluationsPerRound; i++) {
      tree.circuit.evaluateTensor(sources[i % sources.length]!)
    }
    best = Math.min(best, performance.now() - start)
  }
  return (best * 1000) / evaluationsPerRound
}

console.log('## Cost: cascade versus production argmax\n')
console.log('| candidates | variant | ops | affine | reglu | boolean | layers | stored weights | tensor µs/eval |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const candidateCount of [3, 8, 20, 64]) {
  for (const variant of ['production', 'cascade'] as ArgmaxVariant[]) {
    const tree = buildArgmaxTree(candidateCount, variant)
    const counts = circuitOpCounts(tree.circuit)
    const microseconds = timeTensor(tree)
    console.log(`| ${candidateCount} | ${variant} | ${counts.operations} | ${counts.affine} | ${counts.reglu} | ${counts.boolean} | ${counts.layers} | ${counts.storedWeights} | ${microseconds.toFixed(1)} |`)
  }
}

console.log('\n## Training through the argmax (10 seeds)\n')
console.log('| seed | soft stage correct (of 16) | hardened correct | exact one-hot |')
console.log('| --- | --- | --- | --- |')
let totalCorrect = 0
for (let seed = 1; seed <= 10; seed++) {
  const run = trainSelection(seed)
  totalCorrect += run.hardenedCorrect
  console.log(`| ${seed} | ${run.softCorrectByStage.join(', ')} | ${run.hardenedCorrect}/${run.caseCount} | ${run.hardenedExactOneHot ? 'yes' : 'no'} |`)
}
console.log(`\nHardened winners: ${totalCorrect}/160 across 10 seeds.`)
console.log('\n## Single-ramp training baseline (fresh seeds)\n')
let rampCorrect = 0
for (let seed = 101; seed <= 110; seed++) {
  rampCorrect += trainSelection(seed, {...defaultTrainingConfig, softComparator: 'single-ramp'}).hardenedCorrect
}
console.log(`Single-ramp hardened winners: ${rampCorrect}/160. This is per-case table fitting, not unseen-context generalization.`)

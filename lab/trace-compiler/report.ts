// Prints the README's measured tables: gauntlet results, real-file slice results, rejection
// probes, and the residue taxonomy. Run with: bun lab/trace-compiler/report.ts

import {runGauntlet} from './gauntlet.ts'
import {loadRealTarget, runRealSlices} from './real-slice.ts'
import {runCensus, summarizeCensus} from './residue-census.ts'
import type {EquivalenceReport} from './harness.ts'
import type {CompiledProgram} from './compile.ts'

const legTotals = {threeWay: 0, withoutTensorLeg: 0, withoutTwinLeg: 0, referenceOnly: 0}
const source = process.argv.includes('--live') ? 'live' : 'fixture'
let sourceOutputsChecked = 0
let mismatchCount = 0

function row(program: CompiledProgram, report: EquivalenceReport): string {
  const counts = program.opCounts
  sourceOutputsChecked += report.sourceSemantics.outputsChecked
  mismatchCount += report.mismatches.length + report.sourceSemantics.mismatchCount
  const drift = report.drift
  const bitEqual = drift.outputsCompared === 0
    ? 'n/a'
    : `${(100 * drift.bitEqualCount / drift.outputsCompared).toFixed(1)}%`
  const maxDrift = drift.outputsCompared === 0 ? 'n/a' : drift.maxAbsoluteDrift.toExponential(1)
  legTotals.threeWay += report.legs.threeWay
  legTotals.withoutTensorLeg += report.legs.withoutTensorLeg
  legTotals.withoutTwinLeg += report.legs.withoutTwinLeg
  legTotals.referenceOnly += report.legs.referenceOnly
  const legs = report.legs.withoutTensorLeg === 0 && report.legs.withoutTwinLeg === 0 && report.legs.referenceOnly === 0
    ? 'all'
    : `${report.legs.threeWay} (+${report.legs.withoutTensorLeg} no tensor leg, +${report.legs.withoutTwinLeg} no twin leg, +${report.legs.referenceOnly} reference only)`
  return [
    counts.operations,
    counts.reglu,
    counts.boolean,
    counts.layers,
    counts.storedWeights,
    report.trials,
    report.outputsChecked,
    legs,
    report.mismatches.length,
    report.sourceSemantics.mismatchCount,
    bitEqual,
    maxDrift,
  ].join(' | ')
}

console.log('## Gauntlet\n')
console.log('| function | ops | reglu | boolean | layers | stored weights | trials | outputs checked | three-way | circuit mismatches | native mismatches | twin==f64 bits | max abs drift |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const run of runGauntlet()) {
  console.log(`| ${run.entry.name} | ${row(run.compiled.program, run.report)} |`)
}

console.log(`\n## Gallery slices (${source})\n`)
const real = runRealSlices(20260706, source)
console.log('| slice | ops | reglu | boolean | layers | stored weights | trials | outputs checked | three-way | circuit mismatches | native mismatches | twin==f64 bits | max abs drift |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const slice of real.slices) {
  console.log(`| ${slice.name} | ${row(slice.program, slice.report)} |`)
}

console.log(`\nVerification legs across both tables: ${legTotals.threeWay} three-way, ${legTotals.withoutTensorLeg} without the tensor leg (constant-folded outputs), ${legTotals.withoutTwinLeg} without the twin leg (nullable value slots whose twin is null), ${legTotals.referenceOnly} reference only.`)
console.log(`Native JS independently checked ${sourceOutputsChecked} float64 interpreter outputs. Precision drift does not count as a mismatch.`)
if (mismatchCount > 0) process.exitCode = 1

console.log('\n## Rejection probes\n')
for (const probe of real.probes) {
  console.log(`- ${probe.name}: line ${probe.diagnostic.line}, [${probe.diagnostic.category}] ${probe.diagnostic.construct} — \`${probe.diagnostic.snippet}\``)
}

console.log('\n## Residue taxonomy\n')
const target = loadRealTarget(source)
const units = runCensus(target, real.slices)
const summary = summarizeCensus(units)
console.log('| category | count | example (line) | fixability | how |')
console.log('| --- | --- | --- | --- | --- |')
for (const taxonomyRow of summary.rows) {
  const example = taxonomyRow.exampleText.length > 60 ? `${taxonomyRow.exampleText.slice(0, 60)}…` : taxonomyRow.exampleText
  console.log(`| ${taxonomyRow.category} | ${taxonomyRow.count} | \`${example}\` (${taxonomyRow.exampleLine}) | ${taxonomyRow.fixability} | ${taxonomyRow.how} |`)
}
console.log(`\nTotals: ${summary.totalUnits} units in the render path.`)
console.log(`Compiled and equivalence-verified in a slice: ${summary.compiledUnits} (${(100 * summary.compiledUnits / summary.totalUnits).toFixed(1)}% of all units).`)
console.log(`Numeric units (excluding DOM reads/writes, browser side effects, debug-only): ${summary.numericUnits}.`)
console.log(`Numeric units compiled or classified as candidates: ${summary.numericClassifiedUnits} (${(100 * summary.numericClassifiedUnits / summary.numericUnits).toFixed(1)}% of numeric units). Candidate classification is not evidence of successful compilation.`)
console.log(`Numeric units verified bit-exactly: ${summary.compiledUnits} (${(100 * summary.compiledUnits / summary.numericUnits).toFixed(1)}% of numeric units).`)

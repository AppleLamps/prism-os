// Prints the numbers that guide/sections/text.md quotes for the example paragraph. From the repo root:
//   bun lab/ui-exploration/guide/examples/text/report.ts
import {buildCandidateCircuit, deriveCandidates} from './candidates.ts'
import {buildWalkerCircuit} from './counting.ts'
import {exampleParagraph, layoutLines} from './paragraph.ts'
import {programSize} from './size.ts'
import {buildLineCountCircuit, buildTabulatedCircuit, restrictToLineCount, tabulateWidths} from './tabulated.ts'

const narrowestWidth = 43
const widestWidth = 360
const segmentCount = exampleParagraph.segmentWidths.length
const lineSlots = layoutLines(exampleParagraph, narrowestWidth).length
console.log(`paragraph: ${segmentCount} segments, ${lineSlots} lines at ${narrowestWidth} px, ${layoutLines(exampleParagraph, widestWidth).length} line at ${widestWidth} px`)

const table = tabulateWidths(exampleParagraph, narrowestWidth, widestWidth, 1, lineSlots)
const lineCountTable = restrictToLineCount(table)
const samples = Math.floor(widestWidth - narrowestWidth) + 1
console.log(`tabulation over ${narrowestWidth}..${widestWidth} px: ${table.thresholds.length} thresholds from ${table.walkerCalls} walker calls (${samples} samples, ${table.walkerCalls - samples} bisection steps), ${lineCountTable.thresholds.length} of them change the line count`)
console.log(`line count thresholds: ${lineCountTable.thresholds.join(', ')}`)
const tabulated = buildTabulatedCircuit(table)
console.log('tabulated circuit, line count + widest line + every line slot\'s end:', programSize(tabulated.circuit, tabulated.roots))
const heights = buildLineCountCircuit(lineCountTable)
console.log('tabulated circuit, line count only:', programSize(heights.circuit, heights.roots))

const walker = buildWalkerCircuit(exampleParagraph, lineSlots)
console.log('walker, every word\'s line end and painted width:', programSize(walker.circuit, walker.tableRoots))
console.log(`walker, plus ${lineSlots} line slots (tracked = integer one-hot operations):`, programSize(walker.circuit, walker.roots, walker.oneHotWires))
console.log(`line slots × 2 × segments = ${lineSlots} × 2 × ${segmentCount} = ${lineSlots * 2 * segmentCount}`)

const firstLine = deriveCandidates(exampleParagraph, 0)
console.log('candidates for the line that starts at "The":')
for (const candidate of firstLine.candidates) {
  const {end, paintedWidth} = candidate.lineIfFails
  console.log(`  "${exampleParagraph.labels[end]}": fitWidth ${candidate.fitWidth}; if it fails, the line ends before segment ${end}, painted width ${paintedWidth}`)
}
console.log(`  every candidate fits: the line ends at segment ${firstLine.lineIfAllFit.end}, painted width ${firstLine.lineIfAllFit.paintedWidth}`)
const wordStarts = exampleParagraph.breaksAfter.flatMap((breakAfter, segment) => breakAfter === 0 ? [segment] : [])
const capacity = Math.max(...wordStarts.map(start => deriveCandidates(exampleParagraph, start).candidates.length))
const candidateCircuit = buildCandidateCircuit(segmentCount, capacity)
console.log(`candidate circuit for one line, ${capacity} candidates:`, programSize(candidateCircuit.circuit, candidateCircuit.roots))

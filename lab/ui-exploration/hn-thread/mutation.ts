// Mutation check for the differential tests: in each build section, corrupt one live operation at a time (flip and
// scale its first coefficient, or scale a relu's output by 6), rebuild the program, and see whether the same checks
// the unit tests run (random single frames and the every-comment sweep) report a mismatch.
// Run from the repo root: bun lab/ui-exploration/hn-thread/mutation.ts

import {installFakeCanvas} from './fake-canvas.ts'
import {thread} from './hn-data.ts'
import {prepareThread, type PreparedThread} from './thread-prepare.ts'
import {buildForPrepared, runSingleFrameDifferential, runTargetedSweep} from './differential.ts'
import type {ThreadCircuitOptions} from './thread-circuit.ts'

installFakeCanvas()

const small = prepareThread(thread.comments.slice(0, 60))
const tiny = prepareThread(thread.comments.slice(0, 3))
const options = (slotCount: number): ThreadCircuitOptions => ({slotCount, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'})
const picksPerSection = 6

type MutableOperation = {kind: string, leftTerms: [number, number][], gateTerms: [number, number][], leftBias: number}

function mutateAndCheck(prepared: PreparedThread, slotCount: number, sectionName: string, attempt: number, withSweep: boolean) {
  const built = buildForPrepared(prepared, options(slotCount))
  const program = built.circuit.compileTensorProgram(built.roots)
  const section = built.sections.find(entry => entry.name === sectionName)!
  const live = [...program.wireOrder].filter(wire => wire >= section.firstWire && wire < section.endWire)
  const pick = live[Math.floor((attempt + 0.5) / picksPerSection * live.length)]
  if (pick === undefined) return null
  const operation = built.circuit.operations[pick - built.circuit.sourceSize]! as unknown as MutableOperation
  const shape = `${operation.kind} with ${operation.leftTerms.length} left terms and ${operation.gateTerms.length} gate terms`
  if (operation.leftTerms.length > 0) operation.leftTerms[0] = [operation.leftTerms[0]![0], -operation.leftTerms[0]![1] - 1]
  else operation.leftBias += 5
  built.circuit.tensorProgram = null
  const random = runSingleFrameDifferential(prepared, built, 300, 9)
  let mismatches = random.comparison.decisionMismatches.length + random.comparison.positionMismatches.length
  if (withSweep) {
    const sweep = runTargetedSweep(prepared, built, 13)
    mismatches += sweep.comparison.decisionMismatches.length + sweep.comparison.positionMismatches.length
  }
  return {caught: mismatches > 0, description: `wire ${pick}, ${shape}`}
}

const lines: string[] = []
let caughtTotal = 0
let triedTotal = 0
for (const section of buildForPrepared(small, options(16)).sections) {
  let caught = 0
  let tried = 0
  const missed: string[] = []
  for (let attempt = 0; attempt < picksPerSection; attempt++) {
    const result = mutateAndCheck(small, 16, section.name, attempt, true)
    if (result === null) continue
    tried++
    if (result.caught) caught++
    else missed.push(result.description)
  }
  caughtTotal += caught
  triedTotal += tried
  lines.push(`| ${section.name} | ${caught}/${tried} | ${missed.join('; ')} |`)
}
{
  let caught = 0
  let tried = 0
  for (let attempt = 0; attempt < picksPerSection; attempt++) {
    const result = mutateAndCheck(tiny, 4, 'vertical sizing', attempt, false)
    if (result === null) continue
    tried++
    if (result.caught) caught++
  }
  lines.push(`| vertical sizing, 3-comment thread (the branch where every comment fits) | ${caught}/${tried} | |`)
}
console.log('| section (60 comments, 16 slots) | caught | missed |')
console.log('| --- | --- | --- |')
console.log(lines.join('\n'))
console.log(`\ncaught ${caughtTotal}/${triedTotal} across the 60-comment sections`)

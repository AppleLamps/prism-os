// Writes paragraphs for the GPU step: the leaf min-plus matrices, the cells they come from, and the expected result.
//   bun lab/knuth-plass/export.ts <folder> [--breaks 1024] [--window 16] [--width 300] [--count 1] [--first-seed 0]
// Paragraph k is timingParagraph(breaks, firstSeed + k), so --first-seed 1024 with --breaks 1024 gives the timing
// paragraph at 1,024 break points. Files in <folder>, with every count × ... layout in row order:
//   manifest.json               the options, the constants, the conventions below, and each paragraph's total
//   leaves.f32                  count × breaks × window × window: M[to] for to = 1..breaks
//   initial-state.f32           window: s[0]
//   line-starts.i32             count × breaks: lineStarts, whole pixels
//   line-ends.i32               count × breaks: lineEnds, whole pixels
//   expected-costs.f32          count × (breaks + 1): cost[0..breaks]
//   expected-predecessors.i32   count × (breaks + 1): the start of each best last line, and 0 for break point 0
//   expected-breaks.u8          count × breaks: 1 where break point `to` is chosen
// In code, exportBatch returns the same things without writing files.
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {invariant} from '../../src/runtime/numeric-ui-core.ts'
import {infeasible, largestBreakCapacity, lineCostCap, maxWidthLimit, slackLimit, timingBoxes, timingParagraph} from './paragraph.ts'
import {initialState, knuthPlass, leafMatrices, statesByProductTree} from './reference.ts'

export type ExportOptions = {breaks: number, window: number, width: number, count: number, firstSeed: number}

export const conventions = [
  'The state after break point `to` is s[to] = [cost[to], cost[to - 1], ..., cost[to - window + 1]], with `infeasible` for positions before 0, and s[0] = initial-state.f32.',
  's[to] = M[to] ⊗ s[to - 1], where (A ⊗ B)[r][c] = min(infeasible, min over m of A[r][m] + B[m][c]), and the same with B a vector. Every entry is an integer within 0..infeasible, so every sum of two entries is exact in float32.',
  'Row 0 of M[to] holds lineCost(to - 1 - m, to) at column m, or infeasible where to - 1 - m < 0. Row r >= 1 holds 0 at column r - 1, and infeasible elsewhere.',
  'cost[to] = s[to][0]. The product is associative, so any grouping of M[breaks] ⊗ ... ⊗ M[1] ⊗ s[0] gives s[breaks], e.g. Brent-Kung\'s network in reference.ts\'s statesByProductTree.',
  'predecessors[to] = to - boxes for the boxes = 1..min(window, to) with the smallest cost[to - boxes] + M[to][0][boxes - 1], and the smallest boxes of equal totals.',
  'The chosen break points are breaks, predecessors[breaks], predecessors[predecessors[breaks]], ..., down to but not including 0.',
]

export function exportBatch(options: ExportOptions) {
  const {breaks, window, width, count, firstSeed} = options
  invariant(Number.isInteger(breaks) && breaks >= 1 && breaks <= largestBreakCapacity, `breaks must be within 1..${largestBreakCapacity}`)
  invariant(Number.isInteger(window) && window >= 2, 'window must be at least 2')
  invariant(Number.isInteger(width) && width >= 0 && width <= maxWidthLimit, `width must be a whole number within 0..${maxWidthLimit}`)
  const size = window * window
  const leaves = new Float32Array(count * breaks * size)
  const lineStarts = new Int32Array(count * breaks)
  const lineEnds = new Int32Array(count * breaks)
  const costs = new Float32Array(count * (breaks + 1))
  const predecessors = new Int32Array(count * (breaks + 1))
  const chosen = new Uint8Array(count * breaks)
  const paragraphs: {seed: number, totalCost: number, lineCount: number, windowOverflowCount: number}[] = []
  for (let index = 0; index < count; index++) {
    const seed = firstSeed + index
    const paragraph = timingParagraph(breaks, seed)
    const solution = knuthPlass(paragraph, width, window)
    const paragraphLeaves = leafMatrices(paragraph, width, window)
    // The leaves through the product tree give the reference's costs.
    const states = statesByProductTree(paragraphLeaves, breaks, window)
    states.forEach((state, at) => invariant(state[0] === solution.costs[at + 1], `paragraph ${index}: the product tree's cost at break point ${at + 1} differs from the reference`))
    leaves.set(paragraphLeaves, index * breaks * size)
    lineStarts.set(paragraph.lineStarts, index * breaks)
    lineEnds.set(paragraph.lineEnds, index * breaks)
    costs.set(solution.costs, index * (breaks + 1))
    predecessors.set(solution.predecessors, index * (breaks + 1))
    for (const at of solution.breaks) chosen[index * breaks + at - 1] = 1
    paragraphs.push({seed, totalCost: solution.totalCost, lineCount: solution.breaks.length, windowOverflowCount: solution.windowOverflowCount})
  }
  const manifest = {
    options, constants: {infeasible, lineCostCap, slackLimit, maxWidthLimit}, boxes: timingBoxes, conventions, paragraphs,
    files: {
      'leaves.f32': 'count × breaks × window × window float32, M[to] for to = 1..breaks, rows in order',
      'initial-state.f32': 'window float32, s[0]',
      'line-starts.i32': 'count × breaks int32, lineStarts in whole pixels',
      'line-ends.i32': 'count × breaks int32, lineEnds in whole pixels',
      'expected-costs.f32': 'count × (breaks + 1) float32, cost[0..breaks]',
      'expected-predecessors.i32': 'count × (breaks + 1) int32',
      'expected-breaks.u8': 'count × breaks uint8, 1 where break point `to` is chosen',
    },
  }
  return {manifest, files: {'leaves.f32': leaves, 'initial-state.f32': Float32Array.from(initialState(window)), 'line-starts.i32': lineStarts, 'line-ends.i32': lineEnds, 'expected-costs.f32': costs, 'expected-predecessors.i32': predecessors, 'expected-breaks.u8': chosen}}
}

if (import.meta.main) {
  const folder = process.argv[2]
  if (folder === undefined || folder.startsWith('--')) throw new Error('usage: bun lab/knuth-plass/export.ts <folder> [--breaks 1024] [--window 16] [--width 300] [--count 1] [--first-seed 0]')
  const argument = (name: string, fallback: number) => {
    const index = process.argv.indexOf(name)
    return index === -1 ? fallback : Number(process.argv[index + 1])
  }
  const options = {breaks: argument('--breaks', 1024), window: argument('--window', 16), width: argument('--width', 300), count: argument('--count', 1), firstSeed: argument('--first-seed', 0)}
  const {manifest, files} = exportBatch(options)
  mkdirSync(folder, {recursive: true})
  writeFileSync(join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [name, array] of Object.entries(files)) writeFileSync(join(folder, name), new Uint8Array(array.buffer, array.byteOffset, array.byteLength))
  console.log(`wrote ${Object.keys(files).length + 1} files to ${folder}: ${options.count} paragraphs of ${options.breaks} break points, window ${options.window}, ${options.width} px`)
}

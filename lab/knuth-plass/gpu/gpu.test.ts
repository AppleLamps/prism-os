// Checks the GPU plan without a GPU: its levels read only slots that earlier levels wrote, and the kernels' arithmetic in
// JavaScript gives reference.ts's costs, pointers and breaks, for both kernels, one paragraph or many.
import {expect, test} from 'bun:test'
import {exportBatch} from '../export.ts'
import {type Paragraph, createRandom, infeasible, lineCostCap, randomParagraph, timingParagraph} from '../paragraph.ts'
import {knuthPlass} from '../reference.ts'
import {type Kernel, batchParagraphs, breaksOf, expectedOut, expectedStates, gpuPlan, hasTie, knuthPlassTyped, matrixTripleSize, noPath, runPlanInJavaScript, vectorTripleSize, writeLineCosts, writePositions} from './plan.ts'

const tieBoxes = {minimumBox: 1, maximumBox: 4, space: 1, hyphen: 1, hyphenChance: 0.2}

test('every level reads only leaves and slots written by earlier levels, and writes every slot once', () => {
  for (const breaks of [...Array.from({length: 70}, (_, index) => index + 1), 255, 256, 1000, 1024, 4096]) {
    const plan = gpuPlan(breaks)
    const writtenMatrix = new Map<number, number>()
    const writtenVector = new Map<number, number>([[0, 0]])
    plan.levels.forEach((level, index) => {
      const depth = index + 1
      for (let combine = level.matrixOffset; combine < level.matrixOffset + level.matrixCount; combine++) {
        const [later, earlier, result] = plan.matrixTriples.subarray(combine * matrixTripleSize, combine * matrixTripleSize + 3)
        for (const slot of [later!, earlier!]) expect(slot < breaks || writtenMatrix.get(slot)! < depth).toBe(true)
        expect(writtenMatrix.has(result!)).toBe(false)
        writtenMatrix.set(result!, depth)
      }
      for (let combine = level.vectorOffset; combine < level.vectorOffset + level.vectorCount; combine++) {
        const [later, earlier, result] = plan.vectorTriples.subarray(combine * vectorTripleSize, combine * vectorTripleSize + 3)
        expect(later! < breaks || writtenMatrix.get(later!)! < depth).toBe(true)
        expect(writtenVector.get(earlier!)! < depth).toBe(true)
        expect(writtenVector.has(result!)).toBe(false)
        writtenVector.set(result!, depth)
      }
    })
    expect(writtenVector.size).toBe(breaks)
    expect(writtenMatrix.size).toBe(plan.productSlots)
    if (breaks >= 4 && Number.isInteger(Math.log2(breaks))) expect(plan.levels.length).toBe(2 * Math.log2(breaks) - 2)
  }
  // 4,096 break points: 22 levels, and 4,083 matrix products.
  const large = gpuPlan(4096)
  expect(large.levels.length).toBe(22)
  expect(large.matrixTriples.length / matrixTripleSize).toBe(4083)
})

function checkBatch(paragraphs: Paragraph[], widths: number[], window: number, kernels: readonly Kernel[]) {
  const breaks = paragraphs[0]!.lineEnds.length
  const plan = gpuPlan(breaks)
  const lineCosts = new Uint32Array(paragraphs.length * breaks * window)
  writeLineCosts(paragraphs, widths, window, lineCosts)
  const solutions = paragraphs.map((paragraph, index) => knuthPlass(paragraph, widths[index]!, window))
  for (const kernel of kernels) {
    // Entries that no dispatch writes hold 7, which would change a minimum if a kernel read one.
    const {out, states} = runPlanInJavaScript(plan, kernel, window, paragraphs.length, lineCosts, 7)
    solutions.forEach((solution, index) => {
      expect(Array.from(out.subarray(index * (breaks + 1), (index + 1) * (breaks + 1)))).toEqual(expectedOut(solution.costs, solution.predecessors))
      expect(breaksOf(out, index, breaks)).toEqual(solution.breaks)
      expect(Array.from(states.subarray(index * breaks * window, (index + 1) * breaks * window))).toEqual(Array.from(expectedStates(solution.costs, window)))
    })
  }
  return solutions
}

test('both kernels in JavaScript give the reference\'s costs, states, pointers and breaks, one paragraph at a time', () => {
  const random = createRandom(41)
  let ties = 0
  for (let run = 0; run < 400; run++) {
    const breaks = run % 50 === 0 ? 64 + Math.floor(random() * 200) : 1 + Math.floor(random() * 40)
    const tied = run % 3 === 0
    const paragraph = tied ? randomParagraph(random, breaks, tieBoxes) : randomParagraph(random, breaks)
    const width = tied ? Math.floor(random() * 20) : Math.floor(random() * 420)
    const window = [2, 3, 5, 8, 16, 32][run % 6]!
    const [solution] = checkBatch([paragraph], [width], window, ['full', 'dense-rows'])
    if (hasTie(paragraph, width, window, solution!.costs)) ties++
  }
  expect(ties).toBeGreaterThan(60)
})

test('many paragraphs in one batch, each at its own width, give each paragraph\'s own result', () => {
  const random = createRandom(43)
  for (let run = 0; run < 40; run++) {
    const breaks = 1 + Math.floor(random() * 33)
    const count = 1 + Math.floor(random() * 9)
    const paragraphs = Array.from({length: count}, (_, index) => index % 2 === 0 ? randomParagraph(random, breaks, tieBoxes) : randomParagraph(random, breaks))
    const widths = paragraphs.map((_, index) => index % 2 === 0 ? Math.floor(random() * 20) : Math.floor(random() * 400))
    checkBatch(paragraphs, widths, [2, 6, 8, 16][run % 4]!, ['full', 'dense-rows'])
  }
})

test('past 1,056 break points: 4,096 one-box lines wider than the column, whose totals pass 2^22, stay exact', () => {
  const paragraph = randomParagraph(createRandom(47), 4096, {minimumBox: 30, maximumBox: 40, space: 2, hyphen: 3, hyphenChance: 0.1})
  const [solution] = checkBatch([paragraph], [25], 8, ['full', 'dense-rows'])
  // Every line holds one box that doesn't fit, including the last line, so every line costs lineCostCap.
  expect(solution!.totalCost).toBe(4096 * lineCostCap)
  expect(solution!.totalCost).toBeGreaterThan(2 ** 22)
  expect(noPath).toBeGreaterThan(4096 * lineCostCap)
  // The timing paragraph at 4,096 break points, with the kernel the timings use at W = 32.
  checkBatch([timingParagraph(4096)], [300], 32, ['dense-rows'])
})

test('the GPU\'s line costs are row 0 of export.ts\'s leaves, and the kernels in JavaScript give export.ts\'s expected results', () => {
  const options = {breaks: 64, window: 8, width: 300, count: 3, firstSeed: 64}
  const {files} = exportBatch(options)
  const paragraphs = batchParagraphs(options.breaks, options.count)
  const lineCosts = new Uint32Array(options.count * options.breaks * options.window)
  writeLineCosts(paragraphs, paragraphs.map(() => options.width), options.window, lineCosts)
  for (let leaf = 0; leaf < options.count * options.breaks; leaf++) {
    for (let m = 0; m < options.window; m++) {
      const exported = files['leaves.f32'][leaf * options.window * options.window + m]!
      // An entry before break point 0 is infeasible in the export and noPath on the GPU.
      expect(lineCosts[leaf * options.window + m]).toBe(exported === infeasible && (leaf % options.breaks) - m < 0 ? noPath : exported)
    }
  }
  const {out} = runPlanInJavaScript(gpuPlan(options.breaks), 'dense-rows', options.window, options.count, lineCosts)
  for (let paragraph = 0; paragraph < options.count; paragraph++) {
    const base = paragraph * (options.breaks + 1)
    expect(out[base]).toBe(files['expected-costs.f32'][base + options.breaks])
    expect(Array.from(out.subarray(base + 1, base + options.breaks + 1))).toEqual(Array.from(files['expected-predecessors.i32'].subarray(base + 1, base + options.breaks + 1)))
  }
})

test('the typed loop gives the reference\'s costs, predecessors and total', () => {
  const random = createRandom(53)
  for (let run = 0; run < 300; run++) {
    const breaks = 1 + Math.floor(random() * 60)
    const tied = run % 2 === 0
    const paragraph = tied ? randomParagraph(random, breaks, tieBoxes) : randomParagraph(random, breaks)
    const width = tied ? Math.floor(random() * 20) : Math.floor(random() * 420)
    const window = 2 + Math.floor(random() * 31)
    const positions = new Int32Array(2 * breaks)
    writePositions([paragraph], positions)
    const costs = new Float64Array(breaks + 1)
    const predecessors = new Int32Array(breaks + 1)
    const total = knuthPlassTyped(positions, 0, breaks, width, window, costs, predecessors)
    const expected = knuthPlass(paragraph, width, window)
    expect({total, costs: Array.from(costs), predecessors: Array.from(predecessors)}).toEqual({total: expected.totalCost, costs: expected.costs, predecessors: expected.predecessors})
  }
})

import {describe, expect, test} from 'bun:test'
import {createCandidateGalleryCircuit, createCandidateGalleryMachine} from '../../../../../../candidate-gallery.ts'
import {validateOneHotGroups, validateTensorEvaluation} from '../../../../../../numeric-ui-core.ts'
import {createRandom, formatSize, measureProgram} from './measure.ts'
import {buildCandidateGallery, candidateSource, chooseLayout, flattenChoice, layoutNames, viewportLimit} from './run-every-candidate.ts'

describe('run every candidate, then pick one', () => {
  const built = buildCandidateGallery()
  const evaluate = built.circuit.createTensorEvaluator(built.roots)

  // Compares the compiled program's outputs, and optionally evaluateReference's, with the JavaScript loop.
  // join() writes -0 and +0 the same way.
  function expectSameChoice(viewportWidth: number, viewportHeight: number, withReference: boolean) {
    const source = candidateSource(viewportWidth, viewportHeight)
    const expected = flattenChoice(chooseLayout(viewportWidth, viewportHeight)).join()
    const actual = Array.from(evaluate(source)).join()
    if (actual !== expected) throw new Error(`${viewportWidth} × ${viewportHeight}: the compiled program gave ${actual}, the loop ${expected}`)
    if (!withReference) return
    const values = built.circuit.evaluateReference(source)
    const referenceOutputs = built.roots.map(root => values[root]!).join()
    if (referenceOutputs !== expected) throw new Error(`${viewportWidth} × ${viewportHeight}: evaluateReference gave ${referenceOutputs}, the loop ${expected}`)
    validateOneHotGroups(built.circuit, values)
  }

  test('a sweep, random viewports and named cases pick the same layout as the loop, in both evaluators', () => {
    const pickedCounts = layoutNames.map(() => 0)
    let sweepCount = 0
    for (let viewportWidth = 0; viewportWidth <= viewportLimit; viewportWidth += 32) {
      for (let viewportHeight = 0; viewportHeight <= viewportLimit; viewportHeight += 32) {
        expectSameChoice(viewportWidth, viewportHeight, viewportWidth % 512 === 0 && viewportHeight % 512 === 0)
        pickedCounts[chooseLayout(viewportWidth, viewportHeight).chosenLayout]!++
        sweepCount++
      }
    }
    expect(sweepCount).toBe(16_641)
    // Every layout gets picked somewhere in the sweep.
    expect(pickedCounts.every(count => count > 0)).toBe(true)
    const random = createRandom(3)
    for (let sample = 0; sample < 2000; sample++) {
      expectSameChoice(Math.floor(random() * (viewportLimit + 1)), Math.floor(random() * (viewportLimit + 1)), sample % 40 === 0)
    }
    // Empty and largest viewports, sizes where a layout's ReLUs start or stop clamping, and exact ties.
    const named: [number, number][] = [
      [0, 0], [viewportLimit, viewportLimit], [viewportLimit, 0], [0, viewportLimit],
      [79, 600], [80, 600], [81, 600], [143, 400], [144, 400], [145, 400], [1279, 700], [1280, 700], [1281, 700],
      [112, 96], [1024, 480], [1400, 680],
    ]
    for (const [viewportWidth, viewportHeight] of named) expectSameChoice(viewportWidth, viewportHeight, true)
    for (const [viewportWidth, viewportHeight] of named.slice(12)) {
      const source = candidateSource(viewportWidth, viewportHeight)
      validateTensorEvaluation(source, built.circuit, built.circuit.evaluateTensor(source))
    }
  })

  test('named cases quoted in the pattern doc', () => {
    // The diagram's viewport picks the strip layout.
    expect(chooseLayout(1024, 480)).toMatchObject({chosenLayout: 2, scores: [0.703125, 0.84375, 0.9375]})
    // On exact ties, the leftmost layout is kept: the hero and grid layouts tie at 112 × 96, and every layout scores 1 at 1400 × 680.
    expect(chooseLayout(112, 96)).toMatchObject({chosenLayout: 0, scores: [0.03125, 0.03125, 0]})
    expect(chooseLayout(1400, 680)).toMatchObject({chosenLayout: 0, scores: [1, 1, 1]})
  })

  test('sizes quoted in the pattern doc', () => {
    expect(formatSize(measureProgram(built.circuit, built.roots))).toBe('114 operations, 25 layers, 132 weights, 18 gather reads, 0 index reads')
    expect(formatSize(measureProgram(built.circuit, built.scores))).toBe('60 operations, 16 layers, 89 weights, 0 gather reads, 0 index reads')
    expect(formatSize(measureProgram(built.circuit, built.selected))).toBe('71 operations, 24 layers, 107 weights, 0 gather reads, 0 index reads')
    // The Dynamic UI demo at the repo root.
    const machine = createCandidateGalleryMachine()
    expect(formatSize(measureProgram(machine.circuit, [...machine.tensorProgram.roots]))).toBe('417 operations, 60 layers, 848 weights, 26 gather reads, 0 index reads')
    const demo = createCandidateGalleryCircuit()
    expect(formatSize(measureProgram(demo.circuit, demo.output.scores))).toBe('81 operations, 18 layers, 140 weights, 0 gather reads, 0 index reads')
  })
})

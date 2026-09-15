import {describe as suite, expect, test} from 'bun:test'
import {createAppDrag} from './app-drag.ts'
import {createAppShell, designOptions, knobNames, readKnobs} from './app-shell.ts'
import {appTextTables} from './app-text-tables.ts'
import {createRandom, programStats} from './circuit-tools.ts'
import {sameFloat} from '../codegen/codegen.ts'
import {compareLayouts} from './compare.ts'
import {createDemoModel} from './demo-model.ts'
import {createDragSolver, defaultSolverOptions, edgeValue} from './drag-solver.ts'
import {answerFlipQueries} from './flip-query.ts'
import {createGalleryDrag} from './gallery-drag.ts'
import {instanceSourceTable} from '../codegen/instance.ts'
import {layoutReference, overflowCountReference} from './reference.ts'
import {appEdgeOf, runScriptedDrag, scriptAppDrags, summarizeFrames} from './scripted-drags.ts'

const tables = new Map(Object.entries(appTextTables))
const app = createAppDrag(tables)
const solver = createDragSolver(app.problem)
const everyKnob = app.problem.knobs.map((_, index) => index)
const knob = (name: string) => app.problem.knobs.findIndex(other => other.name === name)

suite('lifting design numbers', () => {
  test('with nothing lifted the copy compiles into layout-tree\'s app shell, and lifting all five knobs adds 60 live ops', () => {
    const baseline = createAppShell()
    expect(programStats(baseline.circuit, baseline.roots)).toMatchObject({liveOperations: 2806, layers: 115, storedWeights: 7451})
    const all = createAppShell({liftedKnobs: knobNames})
    expect(programStats(all.circuit, all.roots)).toMatchObject({liveOperations: 2866, layers: 116, storedWeights: 7776})
  })

  test('the lifted design circuit matches the JS reference at random knob values', () => {
    const random = createRandom(4)
    let worst = 0
    const mismatches: string[] = []
    for (let trial = 0; trial < 30; trial++) {
      const knobs: Record<string, number> = {}
      for (const spec of app.problem.knobs) knobs[spec.name] = spec.minimum + random() * (spec.maximum - spec.minimum)
      const viewportWidth = 320 + Math.floor(random() * 2000)
      const source = app.createSource(viewportWidth, 820, knobs)
      const values = solver.evaluate(source)
      const circuitKnobs = readKnobs(app.shell, source)
      const expected = layoutReference(app.shell.root, {viewportWidth, viewportHeight: 820, mainScroll: 0, sidebarWidth: viewportWidth >= 640 ? circuitKnobs.sidebarOpenWidth : 0}, tables, circuitKnobs)
      const difference = compareLayouts(expected, app.shell.readWires(values))
      worst = Math.max(worst, difference.maxDrift)
      mismatches.push(...difference.discreteMismatches)
      expect(values[app.shell.layout.overflowCount!]).toBe(overflowCountReference(app.shell.root, expected, circuitKnobs))
    }
    expect(mismatches).toEqual([])
    expect(worst).toBeLessThan(0.01)
  })
})

suite('gradients and evaluation backends', () => {
  test('the generated forward pass gives the reference evaluator\'s values and gradients, and instances match the reference bit for bit', () => {
    const reference = createDragSolver(app.problem, {...defaultSolverOptions, forward: 'reference'})
    const source = app.createSource(1280, 820)
    const referenceValues = app.shell.circuit.evaluateReference(source)
    const generatedValues = new Float32Array(solver.evaluate(source))
    for (const wire of solver.instanceOutputs) expect(sameFloat(referenceValues[wire]!, generatedValues[wire]!)).toBe(true)
    const edge = app.edge('card5', 'bottom')
    const generatedGradients = solver.gradientOf(generatedValues, edge)
    const referenceGradients = reference.gradientOf(referenceValues, edge)
    for (const spec of app.problem.knobs) expect(generatedGradients[spec.cell]).toBe(referenceGradients[spec.cell]!)
    const random = createRandom(8)
    const count = 12
    const rows = new Float32Array(count * app.problem.knobs.length)
    for (let candidate = 0; candidate < count; candidate++) {
      app.problem.knobs.forEach((spec, index) => { rows[candidate * app.problem.knobs.length + index] = spec.minimum + random() * (spec.maximum - spec.minimum) })
    }
    const results = solver.evaluateCandidates(source, rows, count)
    let compared = 0
    for (let candidate = 0; candidate < count; candidate++) {
      const expected = app.shell.circuit.evaluateReference(instanceSourceTable(solver.plan, source, rows, candidate))
      for (const wire of solver.instanceOutputs) {
        if (!sameFloat(solver.candidateValue(results, candidate, wire), expected[wire]!)) throw new Error(`candidate ${candidate} wire ${wire}`)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(10_000)
  })

  test('frozen and straight-through gradients both equal central differences where no decision flips nearby', () => {
    const straightThrough = createDragSolver(app.problem, {...defaultSolverOptions, booleanGradient: 'straight-through'})
    const source = app.createSource(1280, 820)
    const values = new Float32Array(solver.evaluate(source))
    const checks: [string, 'left' | 'right' | 'top' | 'bottom', string, number][] = [
      ['card3', 'bottom', 'cardPadding', 2],
      ['card3', 'bottom', 'titleScale', 20],
      ['card1', 'left', 'sidebarOpenWidth', 0.75],
      ['card1', 'left', 'gap', 0.25],
      ['sidebar', 'right', 'sidebarOpenWidth', 1],
    ]
    for (const modeSolver of [solver, straightThrough]) {
      expect(modeSolver.options.booleanGradient).toBe(modeSolver === solver ? 'frozen' : 'straight-through')
      for (const [node, side, name, expected] of checks) {
        const edge = app.edge(node, side)
        const cell = app.problem.knobs[knob(name)]!.cell
        const gradient = modeSolver.gradientOf(values, edge)[cell]!
        expect(gradient).toBeCloseTo(expected, 5)
        const step = name === 'titleScale' ? 0.002 : 0.25
        const plus = new Float32Array(source)
        const minus = new Float32Array(source)
        plus[cell] = source[cell]! + step
        minus[cell] = source[cell]! - step
        const difference = (edgeValue(solver.evaluate(plus), edge) - edgeValue(solver.evaluate(minus), edge)) / (2 * step)
        expect(Math.abs(difference - gradient)).toBeLessThan(0.02)
      }
    }
    // A grid's minimum cell width only feeds the column count decision, so its gradient on a card edge is 0.
    expect(solver.gradientOf(values, app.edge('card1', 'right'))[app.problem.knobs[knob('minCardWidth')]!.cell]).toBe(0)
  })

  test('frozen booleans give 0 where straight-through leaves an FP32 residue (app shell) or a phantom slope through the argmax (candidate-gallery)', () => {
    const straightThrough = createDragSolver(app.problem, {...defaultSolverOptions, booleanGradient: 'straight-through'})
    const source = app.createSource(1420, 820)
    const values = new Float32Array(solver.evaluate(source))
    const edge = app.edge('card5', 'right')
    const minCardWidthCell = app.problem.knobs[knob('minCardWidth')]!.cell
    expect(solver.gradientOf(values, edge)[minCardWidthCell]).toBe(0)
    const residue = straightThrough.gradientOf(values, edge)[minCardWidthCell]!
    expect(residue).not.toBe(0)
    expect(Math.abs(residue)).toBeLessThanOrEqual(1 / 32)

    const gallery = createGalleryDrag()
    const frozenGallery = createDragSolver(gallery.problem)
    const straightThroughGallery = createDragSolver(gallery.problem, {...defaultSolverOptions, booleanGradient: 'straight-through'})
    const gallerySource = gallery.createSource(1000, 750)
    const galleryValues = new Float32Array(frozenGallery.evaluate(gallerySource))
    const scaleKnobs = gallery.problem.knobs.filter(spec => spec.name.endsWith('Scale'))
    const thumbnailLeft = gallery.edge(0, 'left')
    const frozenGradients = frozenGallery.gradientOf(galleryValues, thumbnailLeft)
    const straightThroughGradients = straightThroughGallery.gradientOf(galleryValues, thumbnailLeft)
    expect(scaleKnobs.every(spec => frozenGradients[spec.cell] === 0)).toBe(true)
    const phantom = scaleKnobs.find(spec => straightThroughGradients[spec.cell] !== 0)!
    expect(phantom).toBeDefined()
    // The quality scale doesn't move the thumbnail at all within a tiny step, so the true slope is 0.
    const plus = new Float32Array(gallerySource)
    plus[phantom.cell] = gallerySource[phantom.cell]! * (1 + 1e-4)
    expect(edgeValue(frozenGallery.evaluate(plus), thumbnailLeft)).toBe(edgeValue(galleryValues, thumbnailLeft))
  })
})

suite('dragging edges', () => {
  test('a 40 px drag of a card title\'s bottom edge stays within 0.5 px on every frame', () => {
    const source = app.createSource(1280, 820)
    const edge = app.edge('card1.title', 'bottom')
    const start = edgeValue(solver.evaluate(source), edge)
    for (let frame = 1; frame <= 6; frame++) {
      const result = solver.solveFrame(source, everyKnob, edge, start + 40 * frame / 6)
      expect(Math.abs(result.finalError)).toBeLessThanOrEqual(0.5)
    }
  })

  test('the sidebar\'s right edge solves in one step, and the solver refuses to push the sidebar below its 208 px nav rows', () => {
    const source = app.createSource(1280, 820)
    const edge = app.edge('sidebar', 'right')
    const first = solver.solveFrame(source, everyKnob, edge, 250)
    expect(first.solvedAtStep).toBe(1)
    expect(first.outcome).toBe('gradient')
    const narrow = solver.solveFrame(source, everyKnob, edge, 190)
    expect(narrow.gradientValid).toBe(false)
    expect(source[app.problem.knobs[knob('sidebarOpenWidth')]!.cell]).toBeGreaterThanOrEqual(208)
  })

  test('the right edge of a card in the last column has gradient 0 for every knob', () => {
    const source = app.createSource(1280, 820)
    const result = solver.solveFrame(source, everyKnob, app.edge('card3', 'right'), edgeValue(solver.evaluate(source), app.edge('card3', 'right')) + 20)
    expect(result.zeroGradient).toBe(true)
    expect(result.blockedAtBound).toBe(false)
    expect(result.searched).toBe(true)
  })

  test('a knob at its range bound blocks the gradient step, and the solver counts that apart from a zero gradient', () => {
    const source = app.createSource(1280, 820, {gap: 0})
    const values = new Float32Array(solver.evaluate(source))
    const gapCell = app.problem.knobs[knob('gap')]!.cell
    // A card in a grid's second row sits one row gap lower, so its bottom edge has gradient 1 for the gap.
    const node = Array.from({length: 8}, (_, index) => `card${index}`).find(name => solver.gradientOf(values, app.edge(name, 'bottom'))[gapCell] === 1)
    expect(node).toBeDefined()
    const edge = app.edge(node!, 'bottom')
    // Moving the edge up needs a negative gap.
    const result = solver.solveFrame(source, [knob('gap')], edge, edgeValue(values, edge) - 20)
    expect(result.blockedAtBound).toBe(true)
    expect(result.zeroGradient).toBe(false)
    expect(result.steps).toBe(0)
    expect(source[gapCell]).toBe(0)
  })

  test('scripted drags run and summarize', () => {
    const drags = scriptAppDrags(6, 913, 3)
    const runs = drags.map(drag => runScriptedDrag(solver, app.createSource, appEdgeOf(app), drag))
    const summary = summarizeFrames(runs.flatMap(run => run.frames))
    expect(summary.frames).toBe(18)
    expect(summary.solvedBySearch + summary.unsolved + runs.flatMap(run => run.frames).filter(frame => frame.outcome === 'gradient').length).toBe(summary.moving)
  })
})

suite('flip queries', () => {
  test('the grid\'s column count flips exactly where the margin gradient predicts', () => {
    const source = app.createSource(1280, 820)
    const values = new Float32Array(solver.evaluate(source))
    expect(values[app.shell.layout.gridColumns.get('recent.grid')!]).toBe(4)
    const drop = app.gridQueries('recent.grid', values).find(query => query.label.includes('drops to 3'))!
    const answers = answerFlipQueries(solver, source, drop, everyKnob)
    const byKnob = Object.fromEntries(answers.map(answer => [answer.knob, answer]))
    // inner 1028 px + 1/64 >= 4 × minCardWidth + 3 × gap: 1028.015625 - 916 = 112.015625 px of margin.
    expect(byKnob['minCardWidth']!.predictedChange).toBeCloseTo(28.0039, 3)
    expect(byKnob['minCardWidth']!.holds).toBe(true)
    expect(Math.abs(byKnob['minCardWidth']!.actualChange! - byKnob['minCardWidth']!.predictedChange!)).toBeLessThan(1e-3)
    expect(byKnob['sidebarOpenWidth']!.predictedChange).toBeCloseTo(112.0156, 3)
    expect(byKnob['sidebarOpenWidth']!.holds).toBe(true)
    expect(byKnob['cardPadding']!.predictedChange).toBeNull()
  })

  test('candidate-gallery: a 60 px hero drag solves in one step, and at the tied viewport the unclamped margin predicts when Contact takes over', () => {
    const gallery = createGalleryDrag()
    const gallerySolver = createDragSolver(gallery.problem)
    const all = gallery.problem.knobs.map((_, index) => index)
    const source = gallery.createSource(1280, 800)
    const heroRight = gallery.edge(-1, 'right')
    const drag = new Float32Array(source)
    const result = gallerySolver.solveFrame(drag, all, heroRight, edgeValue(gallerySolver.evaluate(drag), heroRight) + 60)
    expect(result.solvedAtStep).toBe(1)
    const values = new Float32Array(gallerySolver.evaluate(source))
    const {output} = gallery.machine
    expect(output.scores.map(wire => values[wire])).toEqual([1, 1, 1])
    // The clamped margin between the tied winner and a rival has gradient 0 for every knob.
    const clamped = gallerySolver.gradientOf(values, [[output.scores[0]!, 1], [output.scores[1]!, -1]])
    expect(gallery.problem.knobs.every(spec => clamped[spec.cell] === 0)).toBe(true)
    const contact = gallery.layoutQueries(values).find(query => query.label.startsWith('Contact'))!
    const answers = answerFlipQueries(gallerySolver, source, contact, all)
    const rail = answers.find(answer => answer.knob === 'cinemaRailMaximum')!
    expect(rail.predictedChange).toBeCloseTo(58, 2)
    expect(rail.holds).toBe(true)
    expect(Math.abs(rail.actualChange! - rail.predictedChange!)).toBeLessThan(1e-2)
  })
})

suite('demo model', () => {
  test('dragging a card\'s right edge moves the knobs and produces flip sentences', () => {
    const model = createDemoModel(tables, 1280, 820)
    const card = model.layout().rects.get('card1')!
    const handle = model.hitTest(card.x + card.width - 2, card.y + 40)
    expect(handle).toEqual({node: 'card1', side: 'right'})
    expect(model.pointerDown(card.x + card.width - 2, card.y + 40)).toBe(true)
    const frame = model.pointerMove(card.x + card.width + 28, card.y + 40)!
    expect(Math.abs(frame.finalError)).toBeLessThanOrEqual(0.5)
    const moved = model.layout().rects.get('card1')!
    expect(moved.x + moved.width).toBeCloseTo(card.x + card.width + 30, 0)
    expect(model.knobs()['sidebarOpenWidth']).not.toBe(220)
    model.pointerUp()
    expect(model.flipSentences().length).toBeGreaterThan(0)
    model.setLocked('sidebarOpenWidth', true)
    expect(model.state().locked).toContain('sidebarOpenWidth')
  })
})

void designOptions

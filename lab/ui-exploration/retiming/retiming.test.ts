import {describe as suite, expect, test} from 'bun:test'
import {Circuit} from '../../../numeric-ui-core.ts'
import {createWindowManagerMachine as createProductionMachine} from '../../../window-manager.ts'
import {analyzeDepth, buildGraph, createRetimedEvaluator, criticalLevels, flattenProgram, layersWithCuts, maskOf, minimumCut} from './flat.ts'
import {type Model, type Trace, greedySearch, levelCandidates, recordTrace, replay} from './retime.ts'
import {type IndirectOSModel, bankOptions, codegenSession, createIndirectOSModel, liveResizeTrace, originalOptions, photosPreviousFrameCuts, randomInteractionTrace} from './indirect-os.ts'
import {appShellFrames, appShellTrace, createAppShellModel, smoothResizeFrames} from './app-shell.ts'
import {createHNModel, scriptedSession} from './hn-thread.ts'
import {createGalleryModel, galleryTrace, recordGalleryActions} from './gallery.ts'
import {createWindowManagerMachine as createCopiedMachine} from './copies/spring-bank/window-manager.ts'

const original = createIndirectOSModel('original', originalOptions)
const bank = createIndirectOSModel('bank', bankOptions)

suite('flat programs', () => {
  test('the evaluator matches the shared executor on every live wire along the codegen session', () => {
    const machine = createCopiedMachine(originalOptions)
    const run = codegenSession.createRun(original)
    const evaluator = createRetimedEvaluator(original.program, [])
    let checked = 0
    let mismatches = 0
    for (let frame = 0; frame < 140; frame++) {
      run.frame(frame, source => {
        const values = evaluator.evaluate(source)
        if (frame % 20 === 0) {
          const expected = machine.circuit.evaluateTensor(source)
          for (let position = 0; position < original.program.valueCount; position++) {
            checked++
            if (!Object.is(values[position], expected[original.program.wireOrder[position]!])) mismatches++
          }
        }
        return values
      })
    }
    expect(checked).toBeGreaterThan(30_000)
    expect(mismatches).toBe(0)
  })

  test("spring-bank's copy with the original springs compiles the production IndirectOS", () => {
    const production = createProductionMachine().tensorProgram
    const copied = flattenProgram(createCopiedMachine(originalOptions).tensorProgram)
    const productionFlat = flattenProgram(production)
    expect([copied.rowCount, copied.compiledLayers, copied.storedWeights]).toEqual([5253, 192, 11598])
    expect([productionFlat.rowCount, productionFlat.compiledLayers, productionFlat.storedWeights]).toEqual([5253, 192, 11598])
  })

  test('a cut equals reading a source cell that holds last frame\'s value', () => {
    // a = relu(x + 1), b = relu(2a - 3), c = round(b + a). Cutting a makes b and c
    // read last frame's a.
    const build = (readPrevious: boolean) => {
      const circuit = new Circuit(2)
      circuit.assumeRange(0, -100, 100)
      circuit.assumeRange(1, 0, 1000)
      const a = circuit.reglu([], 1, [[0, 1]], 1)
      const aRead = readPrevious ? 1 : a
      const b = circuit.reglu([], 1, [[aRead, 2]], -3)
      const c = circuit.roundAffine([[b, 1], [aRead, 1]])
      return {circuit, a, b, c}
    }
    const cutCircuit = build(false)
    const cellCircuit = build(true)
    const cutProgram = flattenProgram(cutCircuit.circuit.compileTensorProgram([cutCircuit.a, cutCircuit.c]))
    const cellProgram = cellCircuit.circuit.compileTensorProgram([cellCircuit.c])
    const aPosition = cutProgram.positionOfWire[cutCircuit.a]!
    const evaluator = createRetimedEvaluator(cutProgram, [aPosition])
    const cellSource = new Float32Array(2)
    const inputs = [3, 7.5, -2, 10, 10, 0.25]
    cellSource[1] = inputs[0]! + 1
    for (const x of inputs) {
      const values = evaluator.evaluate(Float32Array.of(x, 0))
      cellSource[0] = x
      const expected = cellCircuit.circuit.evaluateTensor(cellSource)
      expect(values[cutProgram.positionOfWire[cutCircuit.c]!]).toBe(expected[cellCircuit.c]!)
      cellSource[1] = Math.max(0, x + 1)
    }
    const graph = buildGraph(cutProgram)
    expect(analyzeDepth(graph, maskOf(cutProgram, [])).layers).toBe(3)
    expect(layersWithCuts(graph, [aPosition])).toBe(2)
    expect(cellProgram.layers.length).toBe(2)
  })

  test('critical values at one depth break every longest chain, and minimum cuts reach their target', () => {
    const analysis = analyzeDepth(bank.graph, maskOf(bank.program, []))
    expect(analysis.layers).toBe(136)
    const levels = criticalLevels(bank.graph, analysis)
    for (let level = 1; level <= analysis.layers; level++) expect(levels[level]!.length).toBeGreaterThan(0)
    expect(layersWithCuts(bank.graph, levels[100]!)).toBeLessThan(analysis.layers)
    for (const target of [130, 104, 90]) {
      const cuts = minimumCut(bank.graph, analysis, maskOf(bank.program, []), target, () => 1)
      expect(cuts).not.toBeNull()
      expect(layersWithCuts(bank.graph, cuts!)).toBeLessThanOrEqual(target)
    }
  })
})

suite('other workloads', () => {
  function executorMismatches<M extends Model>(model: M, circuit: Circuit, trace: Trace<M>, checkedFrames: readonly number[]) {
    const run = trace.createRun(model)
    const evaluator = createRetimedEvaluator(model.program, [])
    let checked = 0
    let mismatches = 0
    for (let frame = 0; frame <= Math.max(...checkedFrames); frame++) {
      run.frame(frame, source => {
        const values = evaluator.evaluate(source)
        if (checkedFrames.includes(frame)) {
          const expected = circuit.evaluateTensor(source)
          for (let position = 0; position < model.program.valueCount; position++) {
            checked++
            const actual = values[position]!
            const wire = expected[model.program.wireOrder[position]!]!
            if (!Object.is(actual, wire) && !(Number.isNaN(actual) && Number.isNaN(wire))) mismatches++
          }
        }
        return values
      })
    }
    return {checked, mismatches}
  }

  test('the evaluator matches the shared executor on the app shell, hn-thread and the gallery', () => {
    const shell = createAppShellModel('app shell')
    const shellCheck = executorMismatches(shell, shell.shell.circuit, appShellTrace('frames', appShellFrames().slice(1900)), [0, 40, 150])
    expect(shellCheck.mismatches).toBe(0)
    const hn = createHNModel('hn thread')
    const hnCheck = executorMismatches(hn, hn.built.circuit, scriptedSession(hn, 40), [0, 39])
    expect(hnCheck.mismatches).toBe(0)
    const gallery = createGalleryModel('gallery')
    const galleryCheck = executorMismatches(gallery, gallery.built.circuit, galleryTrace(recordGalleryActions(5001, 60, 390, 844)), [0, 59])
    expect(galleryCheck.mismatches).toBe(0)
    expect(shellCheck.checked + hnCheck.checked + galleryCheck.checked).toBeGreaterThan(200_000)
  })
})

suite('hand-chosen cuts', () => {
  test("Photos reading last frame's window size: 136 to 89 layers, 85.7 px on spring-bank's live resize trace", () => {
    const trace = liveResizeTrace(60)
    const recording = recordTrace(bank, trace)
    const cuts = photosPreviousFrameCuts(bank)
    expect(layersWithCuts(bank.graph, cuts)).toBe(89)
    // Neither part works alone: content width and height, then opacity.
    expect(layersWithCuts(bank.graph, cuts.slice(0, 2))).toBe(121)
    expect(layersWithCuts(bank.graph, cuts.slice(2))).toBe(136)
    const result = replay(bank, cuts, trace, recording, null)
    expect(result.maxPx).toBeCloseTo(85.6997, 3)
    expect(result.maxPxLabel).toBe('photos[3].left')
    expect(result.decisionMismatches).toBe(2)
    expect(replay(bank, [], trace, recording, null).maxPx).toBe(0)
  })

  test('with the original springs, animationActive a frame late counts as a mismatch where one side is an integer', () => {
    const trace = liveResizeTrace(60)
    const recording = recordTrace(original, trace)
    const cuts = photosPreviousFrameCuts(original)
    expect([layersWithCuts(original.graph, cuts), layersWithCuts(original.graph, cuts.slice(0, 2)), layersWithCuts(original.graph, cuts.slice(2))]).toEqual([116, 185, 191])
    const result = replay(original, cuts, trace, recording, null)
    expect(result.maxPx).toBeCloseTo(88.858, 2)
    expect(result.decisionMismatches).toBe(1)
    expect(result.unitlessMismatches).toBe(1)
    expect(result.firstMismatch).toBe('frame 365: animationActive is 1, reference 0')
  })

  test("registers on Photos' content size and opacity give the compiled previous-frame variant's outputs, except while the viewport clamps the window", () => {
    const variant = createIndirectOSModel('previous frame', {...originalOptions, photosInputs: 'previous-frame'})
    const cuts = photosPreviousFrameCuts(original)
    const compare = (trace: Trace<IndirectOSModel>) => {
      const retimed = recordTrace(original, trace, cuts)
      const compiled = recordTrace(variant, trace)
      const count = original.metric.px.position.length
      const frames = new Set<number>()
      let largest = 0
      for (const group of ['px', 'scale', 'opacity', 'decisions', 'unitless'] as const) {
        const groupCount = original.metric[group].position.length
        retimed[group].values.forEach((value, index) => {
          if (Object.is(value, compiled[group].values[index])) return
          frames.add(Math.floor(index / groupCount))
          if (group === 'px') largest = Math.max(largest, Math.abs(value - compiled.px.values[index]!))
        })
      }
      return {frames: frames.size, largest, count}
    }
    expect(compare(liveResizeTrace(60)).frames).toBe(0)
    // Frame 244 shrinks the viewport below Photos' width: the window's rendered width
    // clamps at once, and its spring state follows over 16 frames. The registers
    // hold the clamped content width; the compiled variant reads the spring state.
    const seed3 = compare(randomInteractionTrace(original, 3, 400))
    expect(seed3.frames).toBe(17)
    expect(seed3.largest).toBeCloseTo(34.947, 2)
  })

  test("the app shell's spring register gives the same outputs as layout-tree's compiled previous-frame variant", () => {
    const base = createAppShellModel('app shell')
    const variant = createAppShellModel('previous frame', {springFeedsLayout: 'previous frame'})
    expect(layersWithCuts(base.graph, [base.springPosition])).toBe(83)
    expect(variant.program.compiledLayers).toBe(83)
    const trace = appShellTrace('smooth resize', smoothResizeFrames())
    const retimed = recordTrace(base, trace, [base.springPosition])
    const compiled = recordTrace(variant, trace)
    expect(retimed.px.values).toEqual(compiled.px.values)
    expect(retimed.decisions.values).toEqual(compiled.decisions.values)
    const reference = recordTrace(base, trace)
    const result = replay(base, [base.springPosition], trace, reference, null)
    expect(result.maxPx).toBeGreaterThan(1000)
    expect(result.decisionMismatches).toBeGreaterThan(0)
  })
})

suite('search', () => {
  test('every accepted step stays within budget and removes layers', () => {
    const trace = liveResizeTrace(60)
    const recording = recordTrace(bank, trace)
    const run = greedySearch(bank, bank.graph, [{trace, recording}], levelCandidates(bank.graph, 8), {budget: {px: 1, opacity: 0.02}, maxSteps: 4, errorFloor: 0.01})
    expect(run.steps.length).toBe(4)
    let layers = 136
    for (const step of run.steps) {
      expect(step.layersAfter).toBeLessThan(layers)
      layers = step.layersAfter
      expect(step.result.maxPx).toBeLessThanOrEqual(1)
      expect(step.result.decisionMismatches).toBe(0)
      expect(replay(bank, step.cuts, trace, recording, null).maxPx).toBe(step.result.maxPx)
    }
    expect(layersWithCuts(bank.graph, run.cuts)).toBe(layers)
  })

  test('replay stops at the first frame over budget', () => {
    const trace = codegenSession
    const recording = recordTrace(original, trace)
    const result = replay(original, photosPreviousFrameCuts(original), trace, recording, {px: 1, opacity: 0.02})
    expect(result.withinBudget).toBe(false)
    expect(result.stoppedEarly).toBe(true)
    expect(result.framesRun).toBeLessThan(240)
  })
})

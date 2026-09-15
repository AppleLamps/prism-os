// Measurements for the drag-knobs prototype. Run from the repo root:
//   bun lab/ui-exploration/drag-knobs/report.ts
// Prints markdown tables and writes report-results.json next to this file. Takes about 25 s.
// Timings are rough: other processes share the machine.
import type {Wire} from '../../../numeric-ui-core.ts'
import {createAppDrag} from './app-drag.ts'
import {createAppShell, designOptions, knobNames, readKnobs, type AppShell} from './app-shell.ts'
import {appTextTables} from './app-text-tables.ts'
import {backpropagate} from './backward.ts'
import {createRandom, programStats} from './circuit-tools.ts'
import {compareLayouts} from './compare.ts'
import {createDragSolver, defaultSolverOptions, type DragProblem, type DragSolver, type DragSolverOptions, type EdgeTerms, type FrameResult} from './drag-solver.ts'
import {answerFlipQueries, type FlipAnswer, type MarginQuery} from './flip-query.ts'
import {createGalleryDrag} from './gallery-drag.ts'
import {layoutReference, overflowCountReference} from './reference.ts'
import {
  appDragCategories,
  appEdgeOf,
  galleryDragCategories,
  galleryEdgeOf,
  runScriptedDrag,
  scriptAppDrags,
  scriptGalleryDrags,
  summarizeFrames,
  type DragRun,
  type ScriptedDrag,
} from './scripted-drags.ts'

const results: Record<string, unknown> = {}
const format = (value: number) => Number.isInteger(value) ? value.toLocaleString('en-US') : Number(value.toPrecision(4)).toString()
function printTable(title: string, headers: readonly string[], rows: readonly (readonly (string | number)[])[]) {
  console.log(`\n### ${title}\n`)
  console.log(`| ${headers.join(' | ')} |`)
  console.log(`| ${headers.map(() => '---').join(' | ')} |`)
  for (const cells of rows) console.log(`| ${cells.map(cell => typeof cell === 'number' ? format(cell) : cell).join(' | ')} |`)
}
const percent = (part: number, whole: number) => whole === 0 ? '-' : `${(100 * part / whole).toFixed(1)}%`
const tables = new Map(Object.entries(appTextTables))
const reportStarted = performance.now()

function statsRow(label: string, shell: AppShell, roots: readonly Wire[]) {
  const stats = programStats(shell.circuit, roots)
  return [label, stats.sources, stats.operationsBuilt, stats.liveOperations, stats.layers, stats.storedWeights]
}

// ---------------------------------------------------------------- A: what lifting costs
const designShell = createAppShell(designOptions)
const app = createAppDrag(tables, designShell)
{
  const rows: (string | number)[][] = []
  const baseline = createAppShell()
  rows.push(statsRow('nothing lifted (layout-tree\'s app shell)', baseline, baseline.roots))
  for (const name of knobNames) {
    const shell = createAppShell({liftedKnobs: [name]})
    rows.push(statsRow(`${name} alone`, shell, shell.roots))
  }
  const all = createAppShell({liftedKnobs: knobNames})
  rows.push(statsRow('all five knobs', all, all.roots))
  const settled = createAppShell({liftedKnobs: knobNames, settledPreview: true})
  rows.push(statsRow('all five knobs + the design.settled cell', settled, settled.roots))
  rows.push(statsRow('+ the overflow count as an output', designShell, [...designShell.roots, designShell.layout.overflowCount!]))
  const designRoots = [...new Set([...app.problem.outputs, ...app.problem.decisions, ...app.problem.margins, app.problem.violations!])]
  const visibleMargins = designShell.circuit.decisions.filter(record => record.kind === 'grid' || record.kind === 'lines' || record.kind === 'wrap').map(record => record.difference)
  rows.push(statsRow('drag program: every rectangle, visible decision and overflow count', designShell, [...new Set([...app.problem.outputs, ...app.problem.decisions, app.problem.violations!])]))
  rows.push(statsRow('+ the margins of grid, line and wrap decisions', designShell, [...new Set([...app.problem.outputs, ...app.problem.decisions, app.problem.violations!, ...visibleMargins])]))
  rows.push(statsRow('+ the margins of every recorded decision (the solver\'s program)', designShell, designRoots))
  printTable('Lifting design numbers into source cells (interactive roots unless noted)', ['variant', 'sources', 'operations built', 'live ops', 'layers', 'stored weights'], rows)
  const counts = designShell.circuit.decisions.reduce((map, record) => map.set(record.kind, (map.get(record.kind) ?? 0) + 1), new Map<string, number>())
  console.log('\nrecorded decisions by kind:', JSON.stringify(Object.fromEntries(counts)))
  results['lifting'] = {rows, decisionsByKind: Object.fromEntries(counts)}
}

// ---------------------------------------------------------------- B: the lifted circuit against the JS reference
{
  const random = createRandom(31)
  const totals = {settings: 0, continuous: 0, discrete: 0, mismatches: 0, worstDrift: 0, overflowMismatches: 0, sidebarMismatches: 0}
  const solver = createDragSolver(app.problem)
  for (let trial = 0; trial < 300; trial++) {
    const knobs: Record<string, number> = {}
    for (const knob of app.problem.knobs) knobs[knob.name] = knob.minimum + random() * (knob.maximum - knob.minimum)
    const viewportWidth = 320 + Math.floor(random() * 2080)
    const viewportHeight = 480 + Math.floor(random() * 700)
    const source = app.createSource(viewportWidth, viewportHeight, knobs)
    const values = solver.evaluate(source)
    const actual = designShell.readWires(values)
    const circuitKnobs = readKnobs(designShell, source)
    const sidebarWidth = viewportWidth >= 640 ? circuitKnobs.sidebarOpenWidth : 0
    const expected = layoutReference(designShell.root, {viewportWidth, viewportHeight, mainScroll: 0, sidebarWidth}, tables, circuitKnobs)
    const difference = compareLayouts(expected, actual)
    totals.settings++
    totals.continuous += difference.continuousCompared
    totals.discrete += difference.discreteCompared
    totals.mismatches += difference.discreteMismatches.length
    totals.worstDrift = Math.max(totals.worstDrift, difference.maxDrift)
    if (overflowCountReference(designShell.root, expected, circuitKnobs) !== values[designShell.layout.overflowCount!]) totals.overflowMismatches++
    if (actual.rects.get('sidebar')!.width !== sidebarWidth) totals.sidebarMismatches++
  }
  printTable('The lifted design circuit against the JS reference, at random knob values and viewports', ['knob settings', 'positions and sizes compared', 'max drift px', 'discrete results compared', 'discrete mismatches', 'overflow count mismatches', 'sidebar width mismatches'],
    [[totals.settings, totals.continuous, totals.worstDrift, totals.discrete, totals.mismatches, totals.overflowMismatches, totals.sidebarMismatches]])
  results['referenceCheck'] = totals
}

// ---------------------------------------------------------------- C: scripted drags
const frameHeaders = ['strategy / category', 'frames', 'moving frames', 'solved by 1 gradient step', 'solved within 3 steps', 'gradient 0 for every unlocked knob at the start', 'every unlocked knob with a gradient is at its range bound at the start', 'a gradient step changed a visible decision', 'searched', 'solved after search', 'unsolved', 'frames whose result flips a decision', 'mean µs', 'median µs', 'p90 µs', 'mean µs of searched / not searched frames']
const summaryRow = (label: string, frames: readonly FrameResult[]) => {
  const summary = summarizeFrames(frames)
  return [label, summary.frames, summary.moving, percent(summary.solvedInOneStep, summary.moving), percent(summary.solvedWithinThreeSteps, summary.moving),
    percent(summary.zeroGradient, summary.moving), percent(summary.blockedAtBound, summary.moving), percent(summary.gradientChangedDecision, summary.moving), percent(summary.searched, summary.moving),
    percent(summary.solvedBySearch, summary.moving), percent(summary.unsolved, summary.moving), percent(summary.decisionFlips, summary.frames),
    Math.round(summary.meanMicroseconds), Math.round(summary.medianMicroseconds), Math.round(summary.p90Microseconds),
    `${Math.round(summary.searchedMeanMicroseconds)} / ${Math.round(summary.notSearchedMeanMicroseconds)}`]
}
const strategies: [string, DragSolverOptions][] = [
  ['A: brief (straight-through booleans; gradient line; search on any decision change)', {...defaultSolverOptions, booleanGradient: 'straight-through', search: 'gradient line', searchOnDecisionChange: true}],
  ['B: frozen booleans; gradient line; search on any decision change', {...defaultSolverOptions, booleanGradient: 'frozen', search: 'gradient line', searchOnDecisionChange: true}],
  ['C: frozen booleans; gradient line and knob sweeps; search on any decision change', {...defaultSolverOptions, booleanGradient: 'frozen', search: 'gradient line and knob sweeps', searchOnDecisionChange: true}],
  ['D: frozen booleans; gradient line and knob sweeps; search only on error or overflow', {...defaultSolverOptions, booleanGradient: 'frozen', search: 'gradient line and knob sweeps', searchOnDecisionChange: false}],
]
const analysisStrategy = 3

type Capture = {drag: ScriptedDrag, frame: number, sourceBefore: Float32Array, target: number, result: FrameResult}

function runStrategies(problem: DragProblem, drags: readonly ScriptedDrag[], createSource: Parameters<typeof runScriptedDrag>[1], edgeOf: (drag: ScriptedDrag) => EdgeTerms) {
  const runs: DragRun[][] = []
  const captures: Capture[] = []
  const solvers: DragSolver[] = []
  strategies.forEach(([, options], strategyIndex) => {
    const solver = createDragSolver(problem, options)
    solvers.push(solver)
    // Warm-up, so JIT tiers settle before timing.
    for (const drag of drags.slice(0, 30)) runScriptedDrag(solver, createSource, edgeOf, drag)
    runs.push(drags.map(drag => runScriptedDrag(solver, createSource, edgeOf, drag, strategyIndex !== analysisStrategy ? undefined : (frame, sourceBefore, target, result) => {
      if (result.outcome === 'unsolved') captures.push({drag, frame, sourceBefore, target, result})
    })))
  })
  return {runs, captures, solvers}
}

function printDragTables(title: string, drags: readonly ScriptedDrag[], runs: readonly DragRun[][], categories: readonly string[]) {
  const rows: (string | number)[][] = []
  strategies.forEach(([label], strategyIndex) => rows.push(summaryRow(label, runs[strategyIndex]!.flatMap(run => run.frames))))
  printTable(`${title}: every frame, by strategy`, frameHeaders, rows)
  const categoryRows: (string | number)[][] = []
  for (const category of categories) {
    strategies.forEach(([label], strategyIndex) => {
      categoryRows.push(summaryRow(`${category}, ${label.slice(0, 1)}`, runs[strategyIndex]!.filter(run => run.drag.category === category).flatMap(run => run.frames)))
    })
  }
  printTable(`${title}: by category (A to D are the strategies above)`, frameHeaders, categoryRows)
  const unlockRows: (string | number)[][] = []
  for (const mode of ['all', 'subset'] as const) {
    strategies.forEach(([label], strategyIndex) => {
      unlockRows.push(summaryRow(`${mode === 'all' ? 'every knob unlocked' : 'a subset unlocked'}, ${label.slice(0, 1)}`, runs[strategyIndex]!.filter(run => run.drag.unlockMode === mode).flatMap(run => run.frames)))
    })
  }
  printTable(`${title}: by which knobs the designer unlocked`, frameHeaders, unlockRows)
  const dragRows = strategies.map(([label], strategyIndex) => {
    const strategyRuns = runs[strategyIndex]!
    const finalSolved = strategyRuns.filter(run => Math.abs(run.frames.at(-1)!.finalError) <= 0.5).length
    const everyFrame = strategyRuns.filter(run => run.frames.every(frame => Math.abs(frame.finalError) <= 0.5)).length
    const flipped = strategyRuns.filter(run => run.frames.some(frame => frame.changedDecisions.length > 0)).length
    const picks = new Map<string, number>()
    for (const frame of strategyRuns.flatMap(run => run.frames)) if (frame.searched) picks.set(frame.picked, (picks.get(frame.picked) ?? 0) + 1)
    return [label, drags.length, percent(finalSolved, drags.length), percent(everyFrame, drags.length), percent(flipped, drags.length), JSON.stringify(Object.fromEntries(picks))]
  })
  printTable(`${title}: per drag`, ['strategy', 'drags', 'last frame within 0.5 px', 'every frame within 0.5 px', 'drags that flip a decision', 'what search picked (searched frames)'], dragRows)
  return {rows, categoryRows, unlockRows, dragRows}
}

const appDrags = scriptAppDrags(500, 913)
const appStrategies = runStrategies(app.problem, appDrags, app.createSource, appEdgeOf(app))
results['appDrags'] = printDragTables('App shell, 500 drags × 6 frames', appDrags, appStrategies.runs, appDragCategories)
{
  // Which decisions flip, and whether they belong to the dragged rectangle.
  const kinds = new Map<string, {total: number, own: number}>()
  appStrategies.runs[analysisStrategy]!.forEach(run => {
    for (const frame of run.frames) {
      for (const index of frame.changedDecisions) {
        const name = app.decisionNames[index]!
        const kind = name.endsWith(' columns') ? 'grid column count' : name.endsWith(' lines') ? 'text line count' : name.includes(' line') ? 'wrap line index' : 'sidebar shown'
        const node = run.drag.node.replace(/\.title$/, '')
        const own = node.startsWith('card') && (name.startsWith(`${node}.`) || name === `${app.gridOfCard(node)} columns`)
        const entry = kinds.get(kind) ?? {total: 0, own: 0}
        entry.total++
        if (own) entry.own++
        kinds.set(kind, entry)
      }
    }
  })
  printTable('App shell, strategy D: decisions that flipped in accepted results', ['decision kind', 'flips', 'in the dragged card or its grid'], [...kinds].map(([kind, entry]) => [kind, entry.total, entry.own]))
  results['appFlipKinds'] = Object.fromEntries(kinds)
}

// ---------------------------------------------------------------- D: why frames stay unsolved
function analyzeUnsolved(title: string, solver: DragSolver, runs: readonly DragRun[], captures: readonly Capture[], edgeOf: (drag: ScriptedDrag) => EdgeTerms) {
  const random = createRandom(57)
  const {problem} = solver
  // Every unsolved frame runs the heavier search, including frames whose gradient step reached the
  // target but added overflow (the overflow wall), which are also counted in their own columns.
  type Entry = {moving: number, solved: number, unsolved: number, zeroGradient: number, blockedAtBound: number, overflowWall: number, overflowWallReached: number, reachable: number, notFound: number}
  const emptyEntry = (): Entry => ({moving: 0, solved: 0, unsolved: 0, zeroGradient: 0, blockedAtBound: 0, overflowWall: 0, overflowWallReached: 0, reachable: 0, notFound: 0})
  const byCategory = new Map<string, Entry>()
  const entryOf = (category: string) => {
    const entry = byCategory.get(category) ?? emptyEntry()
    byCategory.set(category, entry)
    return entry
  }
  for (const run of runs) {
    const entry = entryOf(run.drag.category)
    for (const frame of run.frames) {
      if (Math.abs(frame.startError) <= 0.5) continue
      entry.moving++
      if (frame.outcome !== 'unsolved') entry.solved++
    }
  }
  const examples: string[] = []
  const wallExamples: string[] = []
  const started = performance.now()
  for (const capture of captures) {
    const entry = entryOf(capture.drag.category)
    entry.unsolved++
    if (capture.result.zeroGradient && capture.result.steps === 0) entry.zeroGradient++
    if (capture.result.blockedAtBound && capture.result.steps === 0) entry.blockedAtBound++
    const overflowWall = Math.abs(capture.result.gradientError) <= 0.5 && !capture.result.gradientValid
    if (overflowWall) entry.overflowWall++
    const edge = edgeOf(capture.drag)
    const unlocked = capture.drag.unlocked.map(name => problem.knobs.findIndex(knob => knob.name === name))
    const count = 4096
    const rows = new Float32Array(count * problem.knobs.length)
    for (let candidate = 0; candidate < count; candidate++) {
      problem.knobs.forEach((knob, index) => {
        rows[candidate * problem.knobs.length + index] = unlocked.includes(index) ? knob.minimum + random() * (knob.maximum - knob.minimum) : capture.sourceBefore[knob.cell]!
      })
    }
    const startValues = solver.evaluate(capture.sourceBefore)
    const startViolations = problem.violations === null ? 0 : startValues[problem.violations]!
    const candidates = solver.evaluateCandidates(capture.sourceBefore, rows, count)
    let best = -1
    let bestError = Number.POSITIVE_INFINITY
    for (let candidate = 0; candidate < count; candidate++) {
      if (problem.violations !== null && solver.candidateValue(candidates, candidate, problem.violations) > startViolations) continue
      let value = 0
      for (const [wire, coefficient] of edge) value += coefficient * solver.candidateValue(candidates, candidate, wire)
      if (Math.abs(capture.target - value) < bestError) {
        bestError = Math.abs(capture.target - value)
        best = candidate
      }
    }
    let reachable = false
    if (best >= 0) {
      const polished = new Float32Array(capture.sourceBefore)
      problem.knobs.forEach((knob, index) => { polished[knob.cell] = rows[best * problem.knobs.length + index]! })
      const polish = solver.solveFrame(polished, unlocked, edge, capture.target)
      reachable = Math.abs(polish.finalError) <= 0.5
      const example = `${capture.drag.category} (drag ${capture.drag.index}, frame ${capture.frame}, unlocked ${capture.drag.unlocked.join(', ')}): the solver ended ${capture.result.finalError.toFixed(2)} px away; random search + polish ends ${polish.finalError.toFixed(3)} px away`
      if (reachable && !overflowWall && examples.length < 5) examples.push(example)
      if (reachable && overflowWall && wallExamples.length < 5) wallExamples.push(example)
    }
    if (reachable) {
      entry.reachable++
      if (overflowWall) entry.overflowWallReached++
    } else {
      entry.notFound++
    }
  }
  const total = emptyEntry()
  for (const entry of byCategory.values()) for (const key of Object.keys(total) as (keyof Entry)[]) total[key] += entry[key]
  const row = (label: string, entry: Entry) => [label, entry.moving, entry.solved, entry.unsolved, entry.zeroGradient, entry.blockedAtBound, entry.overflowWall, entry.overflowWallReached, entry.reachable, entry.notFound, percent(entry.solved, entry.solved + entry.reachable)]
  printTable(`${title}: every unsolved frame, checked with 4,096 random candidates plus polish (${Math.round((performance.now() - started) / 1000)} s)`, ['category', 'moving frames', 'solved by the solver', 'unsolved', 'gradient 0 for every unlocked knob at the start', 'every unlocked knob with a gradient is at its range bound at the start', 'the gradient reached the target but added overflow', '... of which the heavier search reaches 0.5 px', 'the heavier search reaches 0.5 px', 'no candidate found', 'solved among frames something reaches'],
    [...[...byCategory].map(([category, entry]) => row(category, entry)), row('every category', total)])
  if (examples.length > 0) console.log(`\nframes the heavier search reached:\n- ${examples.join('\n- ')}`)
  if (wallExamples.length > 0) console.log(`\nframes whose gradient step added overflow, which the heavier search reached without adding overflow:\n- ${wallExamples.join('\n- ')}`)
  return {byCategory: Object.fromEntries(byCategory), total, examples, wallExamples}
}
results['appUnsolved'] = analyzeUnsolved('App shell, strategy D', appStrategies.solvers[analysisStrategy]!, appStrategies.runs[analysisStrategy]!, appStrategies.captures, appEdgeOf(app))

// ---------------------------------------------------------------- E: gradients against finite differences
// FP32 values near v are spaced 2^(floor(log2 v) - 23) apart, so a central difference over a span s
// can't resolve slopes more finely than a few of those spacings divided by s.
const fp32Spacing = (value: number) => Math.pow(2, Math.floor(Math.log2(Math.max(Math.abs(value), 2 ** -30))) - 23)
function compareGradients(title: string, solver: DragSolver, drags: readonly ScriptedDrag[], createSource: Parameters<typeof runScriptedDrag>[1], edgeOf: (drag: ScriptedDrag) => EdgeTerms, stepOf: (knob: number, level: number) => number) {
  const {problem} = solver
  const levels = ['small', 'medium', 'large'] as const
  const modes = ['straight-through', 'frozen'] as const
  type Total = {pairs: number, agree: number, visibleFlip: number, hiddenFlip: number, noFlip: number, worstNoFlip: number, worstLabel: string}
  const totals = modes.map(() => levels.map((): Total => ({pairs: 0, agree: 0, visibleFlip: 0, hiddenFlip: 0, noFlip: 0, worstNoFlip: 0, worstLabel: ''})))
  const knobTotals = problem.knobs.map(() => ({zeroFrozen: 0, zeroStraightThrough: 0, differentModes: 0, largeDisagreeFrozen: 0}))
  const pointsPerDrag = problem.knobs.length * levels.length * 2
  const rows = new Float32Array(pointsPerDrag * problem.knobs.length)
  const width = problem.circuit.sourceSize + problem.circuit.operations.length
  for (const drag of drags) {
    const source = createSource(drag.viewportWidth, drag.viewportHeight, drag.startKnobs)
    const edge = edgeOf(drag)
    const startValues = new Float32Array(solver.evaluate(source))
    const seeds = new Float32Array(width)
    for (const [wire, coefficient] of edge) seeds[wire] = seeds[wire]! + coefficient
    const gradientsByMode = modes.map(mode => backpropagate(problem.circuit, startValues, seeds, mode))
    const startKnobs = problem.knobs.map(knob => source[knob.cell]!)
    problem.knobs.forEach((knob, knobIndex) => levels.forEach((_, level) => [1, -1].forEach((sign, signIndex) => {
      const candidate = (knobIndex * levels.length + level) * 2 + signIndex
      startKnobs.forEach((value, index) => { rows[candidate * problem.knobs.length + index] = value })
      rows[candidate * problem.knobs.length + knobIndex] = Math.min(knob.maximum, Math.max(knob.minimum, startKnobs[knobIndex]! + sign * stepOf(knobIndex, level)))
    })))
    const candidates = solver.evaluateCandidates(source, rows, pointsPerDrag)
    const edgeAt = (candidate: number) => {
      let value = 0
      for (const [wire, coefficient] of edge) value += coefficient * solver.candidateValue(candidates, candidate, wire)
      return value
    }
    const visibleChanged = (candidate: number) => problem.decisions.some(wire => solver.candidateValue(candidates, candidate, wire) !== startValues[wire])
    const hiddenChanged = (candidate: number) => problem.margins.some(wire => (solver.candidateValue(candidates, candidate, wire) >= 0) !== (startValues[wire]! >= 0))
    problem.knobs.forEach((knob, knobIndex) => {
      const frozen = gradientsByMode[1]![knob.cell]!
      const straightThrough = gradientsByMode[0]![knob.cell]!
      if (frozen === 0) knobTotals[knobIndex]!.zeroFrozen++
      if (straightThrough === 0) knobTotals[knobIndex]!.zeroStraightThrough++
      if (frozen !== straightThrough) knobTotals[knobIndex]!.differentModes++
      levels.forEach((_, level) => {
        const plus = (knobIndex * levels.length + level) * 2
        const minus = plus + 1
        const span = rows[plus * problem.knobs.length + knobIndex]! - rows[minus * problem.knobs.length + knobIndex]!
        if (span === 0) return
        const plusEdge = edgeAt(plus)
        const minusEdge = edgeAt(minus)
        const finiteDifference = (plusEdge - minusEdge) / span
        const noise = 4 * Math.max(fp32Spacing(plusEdge), fp32Spacing(minusEdge)) / span
        modes.forEach((mode, modeIndex) => {
          const gradient = gradientsByMode[modeIndex]![knob.cell]!
          const total = totals[modeIndex]![level]!
          total.pairs++
          const disagreement = Math.abs(gradient - finiteDifference)
          if (disagreement <= 0.01 + 0.001 * Math.abs(gradient) + noise) {
            total.agree++
            return
          }
          if (mode === 'frozen' && level === 2) knobTotals[knobIndex]!.largeDisagreeFrozen++
          if (visibleChanged(plus) || visibleChanged(minus)) total.visibleFlip++
          else if (hiddenChanged(plus) || hiddenChanged(minus)) total.hiddenFlip++
          else {
            total.noFlip++
            if (disagreement > total.worstNoFlip) {
              total.worstNoFlip = disagreement
              total.worstLabel = `${drag.category} vs ${knob.name}: gradient ${gradient.toPrecision(4)}, central difference ${finiteDifference.toPrecision(4)}`
            }
          }
        })
      })
    })
  }
  const tableRows: (string | number)[][] = []
  modes.forEach((mode, modeIndex) => levels.forEach((label, level) => {
    const total = totals[modeIndex]![level]!
    tableRows.push([`${mode}, ${label} step`, total.pairs, total.agree, total.visibleFlip, total.hiddenFlip, total.noFlip, total.worstLabel || '-'])
  }))
  printTable(`${title}: the dragged edge's gradient against central differences at each drag's start (steps: ${problem.knobs.map((knob, index) => `${knob.name} ${[0, 1, 2].map(level => format(stepOf(index, level))).join(' / ')}`).join('; ')})`,
    ['booleans, step', 'knob and drag pairs', 'agree within 0.01 + 0.1% + FP32 noise', 'disagree: a visible decision flips within ± step', 'disagree: only a hidden decision flips (water fill, overflow, breakpoint, hit test)', 'disagree: no recorded decision flips', 'largest disagreement with no recorded flip'], tableRows)
  printTable(`${title}: per knob, at each drag's start`, ['knob', 'frozen gradient is 0', 'straight-through gradient is 0', 'the two modes differ', 'frozen disagrees with the large-step difference'],
    problem.knobs.map((knob, index) => [knob.name, knobTotals[index]!.zeroFrozen, knobTotals[index]!.zeroStraightThrough, knobTotals[index]!.differentModes, knobTotals[index]!.largeDisagreeFrozen]))
  return {totals, knobTotals}
}
results['appGradients'] = compareGradients('App shell', appStrategies.solvers[analysisStrategy]!, appDrags, app.createSource, appEdgeOf(app),
  (knob, level) => [0.01, 1, 8][level]! * (app.problem.knobs[knob]!.name === 'titleScale' ? 0.01 : 1))

// ---------------------------------------------------------------- F: flip queries
type FlipTotals = {answers: number, zeroGradient: number, zeroGradientButFlips: number, outsideRange: number, outsideButFlips: number, inside: number, holds: number, matchesScan: number, examples: string[], misses: string[]}
const newFlipTotals = (): FlipTotals => ({answers: 0, zeroGradient: 0, zeroGradientButFlips: 0, outsideRange: 0, outsideButFlips: 0, inside: 0, holds: 0, matchesScan: 0, examples: [], misses: []})
function tallyFlip(totals: FlipTotals, answer: FlipAnswer, knob: {magnitudeFloor: number}, startValue: number, unit: string) {
  totals.answers++
  if (answer.predictedChange === null) {
    totals.zeroGradient++
    if (answer.actualChange !== null) totals.zeroGradientButFlips++
    return
  }
  if (!answer.insideRange) {
    totals.outsideRange++
    if (answer.actualChange !== null) totals.outsideButFlips++
    return
  }
  totals.inside++
  if (answer.holds) totals.holds++
  const tolerance = 1e-3 * knob.magnitudeFloor + 1e-4 * Math.abs(answer.predictedChange)
  const matches = answer.actualChange !== null && Math.abs(answer.actualChange - answer.predictedChange) <= tolerance
  if (matches) totals.matchesScan++
  const sentence = `${answer.label} if ${answer.knob} reaches ${format(startValue + answer.predictedChange)}${unit} (now ${format(startValue)}; the scan finds ${answer.actualChange === null ? 'no flip' : format(startValue + answer.actualChange)})`
  if (answer.holds && matches && totals.examples.length < 6) totals.examples.push(sentence)
  if ((!answer.holds || !matches) && totals.misses.length < 6) totals.misses.push(`${sentence}, results just past the first flip ${JSON.stringify(answer.resultsAfter)}`)
}
function printFlipTotals(title: string, groups: ReadonlyMap<string, FlipTotals>) {
  printTable(title, ['query', 'answers (query × knob)', 'gradient 0', '... of which the scan still finds a flip', 'predicted change leaves the range', '... of which the scan still finds a flip', 'predicted inside the range', 'holds just past the prediction', 'the scan\'s first flip matches the prediction'],
    [...groups].map(([label, totals]) => [label, totals.answers, totals.zeroGradient, totals.zeroGradientButFlips, totals.outsideRange, totals.outsideButFlips, totals.inside, totals.holds, totals.matchesScan]))
  for (const [label, totals] of groups) {
    if (totals.examples.length > 0) console.log(`\n${label}, predictions that held:\n- ${totals.examples.join('\n- ')}`)
    if (totals.misses.length > 0) console.log(`\n${label}, predictions that missed:\n- ${totals.misses.join('\n- ')}`)
  }
}
{
  const solver = appStrategies.solvers[analysisStrategy]!
  const groups = new Map<string, FlipTotals>([['grid column count', newFlipTotals()], ['card title line count', newFlipTotals()]])
  const perKnob = new Map<string, FlipTotals>()
  const started = performance.now()
  let queries = 0
  for (const drag of appDrags.filter((_, index) => index % 5 === 0)) {
    const source = app.createSource(drag.viewportWidth, drag.viewportHeight, drag.startKnobs)
    const values = new Float32Array(solver.evaluate(source))
    const card = drag.node.startsWith('card') ? drag.node.replace(/\.title$/, '') : 'card0'
    const all = app.problem.knobs.map((_, index) => index)
    const kinds: [string, MarginQuery[]][] = [['grid column count', app.gridQueries(app.gridOfCard(card), values)], ['card title line count', app.lineQueries(`${card}.title`, values)]]
    for (const [kind, list] of kinds) {
      for (const query of list) {
        queries++
        for (const answer of answerFlipQueries(solver, source, query, all)) {
          const knob = app.problem.knobs.find(other => other.name === answer.knob)!
          const unit = knob.name === 'titleScale' ? '' : ' px'
          tallyFlip(groups.get(kind)!, answer, knob, source[knob.cell]!, unit)
          const knobGroup = perKnob.get(`${kind}, ${knob.name}`) ?? newFlipTotals()
          tallyFlip(knobGroup, answer, knob, source[knob.cell]!, unit)
          perKnob.set(`${kind}, ${knob.name}`, knobGroup)
        }
      }
    }
  }
  printFlipTotals(`App shell flip queries at 100 drag start states (${queries} queries, ${Math.round(performance.now() - started)} ms including scans)`, groups)
  printTable('App shell flip queries by knob', ['query, knob', 'answers', 'gradient 0', 'scan finds a flip anyway', 'predicted change leaves the range', 'predicted inside the range', 'holds', 'matches the scan'],
    [...perKnob].map(([label, totals]) => [label, totals.answers, totals.zeroGradient, totals.zeroGradientButFlips, totals.outsideRange, totals.inside, totals.holds, totals.matchesScan]))
  results['appFlips'] = {groups: Object.fromEntries(groups), perKnob: Object.fromEntries(perKnob)}
}

// ---------------------------------------------------------------- G: candidate-gallery
const gallery = createGalleryDrag()
{
  const {circuit, roots, output} = gallery.machine
  const row = (label: string, list: readonly Wire[]) => {
    const stats = programStats(circuit, list)
    return [label, stats.operationsBuilt, stats.liveOperations, stats.layers, stats.storedWeights]
  }
  printTable('candidate-gallery program size', ['roots', 'operations built', 'live ops', 'layers', 'stored weights'], [
    row('the machine\'s roots (as in the repo root)', roots),
    row('+ the 3 unclamped raw scores', [...roots, ...output.rawScores]),
    row('drag program: hero, thumbnails, selected layout, hero presence, clamped and raw scores', [...new Set([...gallery.problem.outputs, ...gallery.problem.decisions, ...gallery.problem.margins])]),
  ])
}
const galleryDrags = scriptGalleryDrags(250, 77, gallery.authored)
const galleryStrategies = runStrategies(gallery.problem, galleryDrags, gallery.createSource, galleryEdgeOf(gallery))
results['galleryDrags'] = printDragTables('candidate-gallery, 250 drags × 6 frames', galleryDrags, galleryStrategies.runs, galleryDragCategories)
{
  const rows: (string | number)[][] = []
  for (const mode of ['gap and rail maximum only', 'other subsets'] as const) {
    strategies.forEach(([label], strategyIndex) => {
      rows.push(summaryRow(`${mode}, ${label.slice(0, 1)}`, galleryStrategies.runs[strategyIndex]!.filter(run => run.drag.unlockMode === 'subset' && (run.drag.unlocked.join() === 'gap,cinemaRailMaximum') === (mode === 'gap and rail maximum only')).flatMap(run => run.frames)))
    })
  }
  printTable('candidate-gallery: subsets split by whether only the two geometry knobs are unlocked', frameHeaders, rows)
  results['galleryGeometryOnly'] = rows
}
results['galleryUnsolved'] = analyzeUnsolved('candidate-gallery, strategy D', galleryStrategies.solvers[analysisStrategy]!, galleryStrategies.runs[analysisStrategy]!, galleryStrategies.captures, galleryEdgeOf(gallery))
results['galleryGradients'] = compareGradients('candidate-gallery', galleryStrategies.solvers[analysisStrategy]!, galleryDrags, gallery.createSource, galleryEdgeOf(gallery),
  (knob, level) => {
    const spec = gallery.problem.knobs[knob]!
    const base = spec.name === 'gap' || spec.name === 'cinemaRailMaximum' ? 1 : spec.magnitudeFloor
    return [0.01, 1, 8][level]! * base
  })
{
  const solver = galleryStrategies.solvers[analysisStrategy]!
  const {output} = gallery.machine
  const all = gallery.problem.knobs.map((_, index) => index)
  const scan = {viewports: 0, ties: 0, clampedGradientZero: 0, clampedGradientZeroAtTies: 0, unclampedGradientNonzeroAtTies: 0}
  const groups = new Map<string, FlipTotals>([['tied top score', newFlipTotals()], ['no tie', newFlipTotals()]])
  let index = 0
  for (let viewportWidth = 320; viewportWidth <= 1920; viewportWidth += 20) {
    for (let viewportHeight = 400; viewportHeight <= 1200; viewportHeight += 50) {
      const source = gallery.createSource(viewportWidth, viewportHeight)
      const values = new Float32Array(solver.evaluate(source))
      const scores = output.scores.map(wire => values[wire]!)
      const winner = gallery.selectedIndex(values)
      const sorted = [...scores].sort((left, right) => right - left)
      const tie = sorted[0] === sorted[1]
      scan.viewports++
      if (tie) scan.ties++
      let runnerUp = -1
      scores.forEach((score, rival) => { if (rival !== winner && (runnerUp < 0 || score > scores[runnerUp]!)) runnerUp = rival })
      const clamped = solver.gradientOf(values, [[output.scores[winner]!, 1], [output.scores[runnerUp]!, -1]])
      const clampedZero = gallery.problem.knobs.every(knob => clamped[knob.cell] === 0)
      if (clampedZero) scan.clampedGradientZero++
      if (tie && clampedZero) scan.clampedGradientZeroAtTies++
      const unclamped = solver.gradientOf(values, [[output.rawScores[winner]!, 1], [output.scores[runnerUp]!, -1]])
      if (tie && gallery.problem.knobs.some(knob => unclamped[knob.cell] !== 0)) scan.unclampedGradientNonzeroAtTies++
      if (index++ % 9 === 0) {
        const group = groups.get(tie ? 'tied top score' : 'no tie')!
        for (const query of gallery.layoutQueries(values)) {
          for (const answer of answerFlipQueries(solver, source, query, all)) {
            const knob = gallery.problem.knobs.find(other => other.name === answer.knob)!
            tallyFlip(group, answer, knob, source[knob.cell]!, '')
          }
        }
      }
    }
  }
  printTable('candidate-gallery: 1,377 viewports (widths 320..1920 by 20, heights 400..1200 by 50), authored knobs', ['viewports', 'tied top clamped score', 'clamped winner-minus-runner-up margin has gradient 0 for every knob', '... at tied viewports', 'at tied viewports, the unclamped margin has a nonzero gradient for some knob'],
    [[scan.viewports, scan.ties, scan.clampedGradientZero, scan.clampedGradientZeroAtTies, scan.unclampedGradientNonzeroAtTies]])
  printFlipTotals('candidate-gallery selected-layout flip queries at every 9th scanned viewport (rival × knob)', groups)
  results['galleryTies'] = {scan, groups: Object.fromEntries(groups)}
}

// ---------------------------------------------------------------- H: timing
{
  const solver = appStrategies.solvers[analysisStrategy]!
  const straightThroughSolver = appStrategies.solvers[0]!
  const source = app.createSource(1280, 820)
  const edge = app.edge('card1', 'bottom')
  const median = (run: () => void, iterations: number) => {
    const samples: number[] = []
    for (let sample = 0; sample < 7; sample++) {
      const started = performance.now()
      for (let iteration = 0; iteration < iterations; iteration++) run()
      samples.push((performance.now() - started) * 1000 / iterations)
    }
    return samples.sort((left, right) => left - right)[3]!
  }
  const referenceSolver = createDragSolver(app.problem, {...defaultSolverOptions, forward: 'reference'})
  const values = new Float32Array(solver.evaluate(source))
  const rows = new Float32Array(4096 * app.problem.knobs.length)
  const random = createRandom(3)
  for (let candidate = 0; candidate < 4096; candidate++) app.problem.knobs.forEach((knob, index) => { rows[candidate * app.problem.knobs.length + index] = knob.minimum + random() * (knob.maximum - knob.minimum) })
  const compileStarted = performance.now()
  const coldSolver = createDragSolver(app.problem)
  const compileMilliseconds = performance.now() - compileStarted
  const coldStarted = performance.now()
  coldSolver.evaluateCandidates(source, rows, 256)
  const coldSearchMilliseconds = performance.now() - coldStarted
  const timing = {
    forwardGeneratedMicroseconds: median(() => { solver.evaluate(source) }, 200),
    forwardReferenceMicroseconds: median(() => { referenceSolver.evaluate(source) }, 50),
    backwardFrozenMicroseconds: median(() => { solver.gradientOf(values, edge) }, 200),
    backwardStraightThroughMicroseconds: median(() => { straightThroughSolver.gradientOf(values, edge) }, 200),
    candidates256Microseconds: median(() => { solver.evaluateCandidates(source, rows, 256) }, 20),
    candidates4096Microseconds: median(() => { solver.evaluateCandidates(source, rows, 4096) }, 3),
    compileMilliseconds,
    coldSearchMilliseconds,
    instanceCounts: solver.plan.counts,
  }
  printTable('App shell timing (rough, median µs, warm unless noted)', ['forward, generated JS', 'forward, reference evaluator', 'backward, frozen booleans', 'backward, straight-through', '256 candidates as instances', '4,096 candidates', 'building the solver (forward and instance programs), ms', 'first 256-candidate search after building, ms', 'per-instance rows / shared rows'],
    [[timing.forwardGeneratedMicroseconds, timing.forwardReferenceMicroseconds, timing.backwardFrozenMicroseconds, timing.backwardStraightThroughMicroseconds, timing.candidates256Microseconds, timing.candidates4096Microseconds, timing.compileMilliseconds, timing.coldSearchMilliseconds, `${timing.instanceCounts.instanceRows} / ${timing.instanceCounts.sharedRows}`]])
  results['timing'] = timing
}

results['reportSeconds'] = (performance.now() - reportStarted) / 1000
console.log(`\nreport took ${Math.round((performance.now() - reportStarted) / 1000)} s`)
await Bun.write(`${import.meta.dir}/report-results.json`, JSON.stringify(results, null, 2))

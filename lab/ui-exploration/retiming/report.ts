// Every measurement in README.md. Run from the repo root:
//   bun lab/ui-exploration/retiming/report.ts [indirect-os | app-shell | hn-thread | gallery]
// With no argument, every section runs. Each section replaces its own entry in
// results.json and prints markdown tables.
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {analyzeDepth, maskOf, type Graph} from './flat.ts'
import {
  type Budget,
  type Model,
  type Recording,
  type SearchCase,
  type SearchRun,
  fractionalDecisions,
  greedySearch,
  levelCandidates,
  minimumCutCandidates,
  recordCases,
  recordTrace,
  replay,
  untestedCuts,
} from './retime.ts'
import {
  bankOptions,
  browserResizeTrace,
  codegenSession,
  createIndirectOSModel,
  describeIndirectOSValue,
  liveResizeTrace,
  originalOptions,
  photosPreviousFrameCuts,
  randomInteractionTrace,
} from './indirect-os.ts'
import {appShellFrames, appShellTrace, createAppShellModel, describeAppShellValue, randomAppShellFrames, smoothResizeFrames} from './app-shell.ts'
import {createHNModel, describeHNValue, randomSession, scriptedSession} from './hn-thread.ts'
import {createGalleryModel, describeGalleryValue, galleryTrace, galleryViewports, recordGalleryActions} from './gallery.ts'

type RetimingModel = Model & {graph: Graph}
type Describe = (position: number) => {place: string, reads: string[], feeds: string[]}

const resultsUrl = new URL('./results.json', import.meta.url)
const requested = process.argv[2]
const budget: Budget = {px: 1, opacity: 0.02}
const noPxBudget: Budget = {px: Number.POSITIVE_INFINITY, opacity: Number.POSITIVE_INFINITY}

const round = (value: number, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : value

// Re-reads the file before writing, so sections run by separate processes keep each other's entries.
function save(key: string, value: unknown) {
  const current = existsSync(resultsUrl) ? JSON.parse(readFileSync(resultsUrl, 'utf8')) as Record<string, unknown> : {}
  current[key] = value
  writeFileSync(resultsUrl, `${JSON.stringify(current, null, 2)}\n`)
}

function printTable(title: string, rows: readonly Record<string, unknown>[]) {
  console.log(`\n### ${title}\n`)
  if (rows.length === 0) {
    console.log('(none)')
    return
  }
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const format = (value: unknown) => typeof value === 'number' ? value.toLocaleString('en-US', {maximumFractionDigits: 4}) : String(value ?? '')
  console.log(`| ${columns.join(' | ')} |`)
  console.log(`| ${columns.map(() => '---').join(' | ')} |`)
  for (const row of rows) console.log(`| ${columns.map(column => format(row[column]).replaceAll('|', '/')).join(' | ')} |`)
}

function programSummary(name: string, model: RetimingModel) {
  return {
    program: name,
    'live ops': model.program.rowCount,
    'compiled layers': model.program.compiledLayers,
    'longest chain (layers)': analyzeDepth(model.graph, maskOf(model.program, [])).layers,
    'stored weights': model.program.storedWeights,
    'source cells': model.program.sourceSize,
  }
}

function resultRow(name: string, registers: number, layers: number, traceName: string, role: string, result: ReturnType<typeof replay>) {
  return {
    cuts: name,
    registers,
    layers,
    trace: traceName,
    role,
    'max px': round(result.maxPx),
    where: result.maxPxLabel === '' ? '' : `${result.maxPxLabel}, frame ${result.maxPxFrame}`,
    'max opacity': round(result.maxOpacity, 4),
    'decision mismatches': result.decisionMismatches,
    'of which in unitless outputs': result.unitlessMismatches,
    'frames with mismatches': result.mismatchFrames,
    'first mismatch': result.firstMismatch ?? '',
    'max unitless': round(result.maxUnitless, 4),
    'unitless where': result.maxUnitlessLabel,
  }
}

// Every recorded output of two runs on the same trace, e.g. registers against a
// compiled variant: the frames in which any output differs and the largest difference.
function compareRecordings(model: RetimingModel, left: Recording, right: Recording) {
  const frames = new Set<number>()
  let entries = 0
  let largest = 0
  let where = ''
  for (const group of ['px', 'scale', 'opacity', 'decisions', 'unitless'] as const) {
    const count = model.metric[group].position.length
    const leftValues = left[group].values
    const rightValues = right[group].values
    for (let index = 0; index < leftValues.length; index++) {
      if (Object.is(leftValues[index], rightValues[index])) continue
      entries++
      const frame = Math.floor(index / count)
      frames.add(frame)
      const difference = Math.abs(leftValues[index]! - rightValues[index]!)
      if (!(difference <= largest)) {
        largest = Number.isNaN(difference) ? Infinity : difference
        where = `${model.metric[group].label[index % count]}, frame ${frame}`
      }
    }
  }
  return {'frames that differ': frames.size, 'outputs that differ': entries, 'largest difference': round(largest), where, 'first frame that differs': frames.size === 0 ? '' : Math.min(...frames)}
}

function validationRows<M extends RetimingModel>(model: M, name: string, cuts: readonly number[], cases: readonly SearchCase<M>[], searched: ReadonlySet<string>) {
  const layers = analyzeDepth(model.graph, maskOf(model.program, cuts)).layers
  return cases.map(({trace, recording}) => resultRow(name, cuts.length, layers, trace.name, searched.has(trace.name) ? 'searched' : 'held out', replay(model, cuts, trace, recording, null)))
}

// A compiled variant replayed against the base model's recordings: its outputs are
// listed in the same order, so entries line up.
function variantRows<M extends RetimingModel>(variant: M, name: string, cases: readonly SearchCase<M>[]) {
  const layers = variant.program.compiledLayers
  return cases.map(({trace, recording}) => resultRow(name, 0, layers, trace.name, 'held out', replay(variant, [], trace, recording, null)))
}

function describeCuts(cuts: readonly number[], describe: Describe, cases: readonly SearchCase<RetimingModel>[]) {
  return cuts.map(position => {
    const description = describe(position)
    const changes = cases.reduce((total, {recording}) => total + recording.changeCount[position]!, 0)
    return {position, place: description.place, reads: description.reads.join(', '), feeds: description.feeds.join(', '), 'frames changed, all traces': changes}
  })
}

// note names what an added set holds, e.g. which hand-chosen registers are among them.
function curveRows(model: RetimingModel, run: SearchRun, initialCuts: readonly number[], note?: (added: readonly number[]) => string) {
  const startLayers = analyzeDepth(model.graph, maskOf(model.program, initialCuts)).layers
  const rows: Record<string, unknown>[] = [{step: 'start', layers: startLayers, registers: initialCuts.length, 'max px': 0, 'decision mismatches': 0}]
  for (const step of run.steps) {
    rows.push({
      step: step.step + 1,
      layers: step.layersAfter,
      registers: step.cuts.length,
      added: step.added.length,
      strategy: step.strategy,
      'max px': round(step.result.maxPx, 4),
      where: step.result.maxPxLabel,
      'max opacity': round(step.result.maxOpacity, 4),
      'decision mismatches': step.result.decisionMismatches,
      'max unitless': round(step.result.maxUnitless, 4),
      'replayed / generated': `${step.candidatesReplayed} / ${step.candidatesGenerated}`,
      ...(note === undefined ? {} : {note: note(step.added)}),
    })
  }
  const closest = run.end.closest
  if (closest !== null) {
    rows.push({
      step: 'next, over budget',
      layers: closest.layersAfter,
      registers: run.cuts.length + closest.added.length,
      added: closest.added.length,
      strategy: closest.strategy,
      'max px': round(closest.result.maxPx, 3),
      where: closest.result.maxPxLabel,
      'max opacity': round(closest.result.maxOpacity, 4),
      'decision mismatches': closest.result.decisionMismatches,
      'max unitless': round(closest.result.maxUnitless, 4),
      'first mismatch': closest.result.firstMismatch ?? '',
      'replayed / generated': `${run.end.candidatesReplayed} / ${run.end.candidatesGenerated}, rejected for decisions ${run.end.rejectedForDecisions}, px ${run.end.rejectedForPx}, opacity ${run.end.rejectedForOpacity}`,
      ...(note === undefined ? {} : {note: note(closest.added)}),
    })
  }
  return rows
}

function placeSummary(descriptions: ReturnType<typeof describeCuts>) {
  const byPlace = new Map<string, {count: number, unchanged: number, example: string}>()
  for (const description of descriptions) {
    const entry = byPlace.get(description.place) ?? {count: 0, unchanged: 0, example: `reads ${description.reads}; feeds ${description.feeds}`}
    entry.count++
    if (description['frames changed, all traces'] === 0) entry.unchanged++
    byPlace.set(description.place, entry)
  }
  return [...byPlace].map(([place, entry]) => ({place, registers: entry.count, 'never changed in any trace': entry.unchanged, example: entry.example}))
}

type SearchSetup<M extends RetimingModel> = {
  label: string
  model: M
  searchCases: readonly SearchCase<M>[]
  allCases: readonly SearchCase<M>[]
  describe: Describe
  maxLevelSize: number
  maxRegisters: number
  budget: Budget
  initialCuts?: readonly number[]
  maxSteps?: number
  note?: (added: readonly number[]) => string
}

type StrategyResult = {curve: Record<string, unknown>[], validation: Record<string, unknown>[], finalCuts: number[]}

function runStrategies<M extends RetimingModel>(setup: SearchSetup<M>): Record<'levels' | 'min-cut', StrategyResult> {
  const output = {} as Record<'levels' | 'min-cut', StrategyResult>
  const searched = new Set(setup.searchCases.map(item => item.trace.name))
  for (const strategy of ['levels', 'min-cut'] as const) {
    const title = `${setup.label}, ${strategy === 'levels' ? 'critical values at one depth' : 'minimum cuts'}`
    console.log(`\n## ${title}`)
    const generate = strategy === 'levels'
      ? levelCandidates(setup.model.graph, setup.maxLevelSize)
      : minimumCutCandidates(setup.model.graph, setup.searchCases.map(item => item.recording), setup.maxRegisters)
    const initialCuts = setup.initialCuts ?? []
    const run = greedySearch(setup.model, setup.model.graph, setup.searchCases, generate, {budget: setup.budget, maxSteps: setup.maxSteps ?? 80, errorFloor: 0.01, log: line => console.log(`  ${line}`)}, initialCuts)
    const curve = curveRows(setup.model, run, initialCuts, setup.note)
    printTable(`${title}: layers against error`, curve)
    const validation = validationRows(setup.model, strategy, run.cuts, setup.allCases, searched)
    printTable(`${title}: final cut set on every trace`, validation)
    const descriptions = describeCuts(run.cuts.slice(initialCuts.length), setup.describe, setup.allCases as readonly SearchCase<RetimingModel>[])
    const places = placeSummary(descriptions)
    printTable(`${title}: where the added registers went`, places)
    const untestedBySearchTraces = untestedCuts(run.cuts, setup.searchCases.map(item => item.recording)).length
    const untestedByAllTraces = untestedCuts(run.cuts, setup.allCases.map(item => item.recording)).length
    console.log(`  registers whose value never changed in the searched traces: ${untestedBySearchTraces} of ${run.cuts.length}; in any trace: ${untestedByAllTraces}; ${round(run.milliseconds / 1000, 1)} s`)
    Object.assign(output, {[strategy]: {
      curve,
      validation,
      places,
      cuts: descriptions,
      untestedBySearchTraces,
      untestedByAllTraces,
      searchSeconds: round(run.milliseconds / 1000, 1),
      finalCuts: run.cuts,
    }})
  }
  return output
}

function indirectOSSection() {
  const setups = [
    {key: 'originalSprings', name: 'IndirectOS, original springs', options: originalOptions, searchTrace: codegenSession.name, variants: [['compiled: Photos reads previous frame', {...originalOptions, photosInputs: 'previous-frame'}]] as const},
    {key: 'bankSprings', name: 'IndirectOS, bank springs (split-table, deferred)', options: bankOptions, searchTrace: liveResizeTrace(60).name, variants: [
      ['compiled: Photos reads previous frame', {...bankOptions, photosInputs: 'previous-frame'}],
      ['compiled: Photos reads stepped springs', {...bankOptions, photosInputs: 'stepped-springs'}],
    ] as const},
  ]
  const sectionResults: Record<string, unknown> = {}
  for (const setup of setups) {
    console.log(`\n# ${setup.name}`)
    const model = createIndirectOSModel(setup.name, setup.options)
    const describe = (position: number) => describeIndirectOSValue(model, position)
    const fixedTraces = [codegenSession, liveResizeTrace(60), liveResizeTrace(10), browserResizeTrace(60)]
    const randomTraces = [1, 2, 3, 4, 5, 6].map(seed => randomInteractionTrace(model, seed, 400))
    const cases = recordCases(model, [...fixedTraces, ...randomTraces])
    const fixedCases = cases.slice(0, fixedTraces.length)
    const searchedRandomCases = cases.slice(fixedTraces.length, fixedTraces.length + 3)
    const searchCase = cases.find(item => item.trace.name === setup.searchTrace)!
    const summary = [programSummary(setup.name, model)]
    const traces = cases.map(item => ({trace: item.trace.name, frames: item.recording.frames, 'fractional decision outputs': fractionalDecisions(model, item.recording).join(', ')}))
    printTable('Program', summary)
    printTable('Traces', traces)

    const handCuts = photosPreviousFrameCuts(model)
    const handNames = ['contentWidth', 'contentHeight', 'opacity']
    const handAmong = (cuts: readonly number[]) => handCuts.flatMap((position, index) => cuts.includes(position) ? [handNames[index]!] : [])
    const note = (added: readonly number[]) => {
      const names = handAmong(added)
      return names.length === 0 ? '' : `hand-chosen: ${names.join(', ')}`
    }
    const hand = validationRows(model, 'registers: Photos reads last frame content size and opacity', handCuts, cases, new Set())
    const variants: Record<string, unknown>[] = []
    const variantModels = setup.variants.map(([variantName, variantOptions]) => [variantName, createIndirectOSModel(variantName, variantOptions)] as const)
    for (const [variantName, variant] of variantModels) {
      variants.push(programSummary(variantName, variant))
      hand.push(...variantRows(variant, variantName, cases))
    }
    printTable('Hand-chosen variants', variants)
    printTable('Hand-chosen cuts on every trace (layers: longest chain for registers, compiled layers for compiled variants)', hand)
    // The registers read last frame's content size, i.e. the window's animated size
    // clamped to last frame's viewport. The compiled variant reads last frame's
    // spring state cell without that clamp, so the two can differ.
    const [previousFrameName, previousFrameVariant] = variantModels[0]!
    const registersAgainstCompiled = cases.map(({trace}) => ({
      trace: trace.name,
      ...compareRecordings(model, recordTrace(model, trace, handCuts), recordTrace(previousFrameVariant, trace)),
    }))
    printTable(`Registers against "${previousFrameName}": every recorded output`, registersAgainstCompiled)

    const common = {model, allCases: cases, describe, maxLevelSize: 8, maxRegisters: 64, note}
    const single = runStrategies({...common, label: `${setup.name}: searched on one trace`, searchCases: [searchCase], budget})
    const scripted = runStrategies({...common, label: `${setup.name}: searched on the four scripted traces`, searchCases: fixedCases, budget})
    const withRandom = runStrategies({...common, label: `${setup.name}: searched on the scripted traces and random seeds 1-3`, searchCases: [...fixedCases, ...searchedRandomCases], budget})
    // Both continuations start from the critical-values cut set of the search above them.
    const scriptedDecisionsOnly = runStrategies({
      ...common,
      label: `${setup.name}: four scripted traces, continued from critical values with exact decisions and no px budget`,
      searchCases: fixedCases,
      budget: noPxBudget,
      initialCuts: scripted.levels.finalCuts,
    })
    const decisionsOnly = runStrategies({
      ...common,
      label: `${setup.name}: scripted and random seeds 1-3, continued from critical values with exact decisions and no px budget`,
      searchCases: [...fixedCases, ...searchedRandomCases],
      budget: noPxBudget,
      initialCuts: withRandom.levels.finalCuts,
    })
    // The same two continuations on a model without the keep-rendering outputs, so a
    // cut may make animationActive (and the bank clock's running bit) a frame late.
    const lagModel = createIndirectOSModel(`${setup.name}, keep-rendering outputs may lag`, setup.options, {keepRenderingMayLag: true})
    const lagCases = recordCases(lagModel, cases.map(item => item.trace))
    const handKeepRenderingMayLag = validationRows(lagModel, 'registers: Photos reads last frame content size and opacity', handCuts, lagCases, new Set())
    printTable('Hand-chosen cut on every trace, keep-rendering outputs may lag', handKeepRenderingMayLag)
    const lagCommon = {...common, model: lagModel, allCases: lagCases}
    const scriptedKeepRenderingMayLag = runStrategies({
      ...lagCommon,
      label: `${setup.name}: four scripted traces, continued from critical values with no px budget, keep-rendering outputs may lag`,
      searchCases: lagCases.slice(0, fixedTraces.length),
      budget: noPxBudget,
      initialCuts: scripted.levels.finalCuts,
    })
    const withRandomKeepRenderingMayLag = runStrategies({
      ...lagCommon,
      label: `${setup.name}: scripted and random seeds 1-3, continued from critical values with no px budget, keep-rendering outputs may lag`,
      searchCases: lagCases.slice(0, fixedTraces.length + 3),
      budget: noPxBudget,
      initialCuts: withRandom.levels.finalCuts,
    })
    const comparison = ([
      ['one trace', single],
      ['four scripted traces', scripted],
      ['four scripted traces, continued, exact decisions, no px budget', scriptedDecisionsOnly],
      ['four scripted traces, continued, no px budget, keep-rendering outputs may lag', scriptedKeepRenderingMayLag],
      ['scripted and random seeds 1-3', withRandom],
      ['scripted and random seeds 1-3, continued, exact decisions, no px budget', decisionsOnly],
      ['scripted and random seeds 1-3, continued, no px budget, keep-rendering outputs may lag', withRandomKeepRenderingMayLag],
    ] as const)
      .flatMap(([searchName, run]) => (['levels', 'min-cut'] as const).map(strategy => {
        const cuts = run[strategy].finalCuts
        const among = handAmong(cuts)
        return {
          search: searchName,
          strategy,
          registers: cuts.length,
          layers: analyzeDepth(model.graph, maskOf(model.program, cuts)).layers,
          'hand-chosen registers among them': `${among.length} of ${handCuts.length}${among.length === 0 ? '' : ` (${among.join(', ')})`}`,
          'registers on Photos inputs': cuts.filter(position => model.photosInputs.has(position)).length,
          'registers inside Photos': cuts.filter(position => model.insidePhotos.has(position)).length,
        }
      }))
    printTable('Does the search pick the hand-chosen cut?', comparison)
    sectionResults[setup.key] = {
      summary, traces, variants, hand, registersAgainstCompiled, handKeepRenderingMayLag,
      single, scripted, scriptedDecisionsOnly, scriptedKeepRenderingMayLag, withRandom, decisionsOnly, withRandomKeepRenderingMayLag, comparison,
    }
  }
  save('indirectOS', sectionResults)
}

function appShellSection() {
  console.log('\n# layout-tree app shell')
  const model = createAppShellModel('app shell')
  const randomSeeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const cases = recordCases(model, [
    appShellTrace('app shell frames (layout-tree report)', appShellFrames()),
    appShellTrace('smooth resize and toggles', smoothResizeFrames()),
    ...randomSeeds.map(seed => appShellTrace(`random session seed ${seed}, 600 frames`, randomAppShellFrames(seed, 600))),
  ])
  const summary = [programSummary('app shell', model)]
  printTable('Program', summary)
  const variantName = 'compiled: layout reads previous frame spring position'
  const variant = createAppShellModel(variantName, {springFeedsLayout: 'previous frame'})
  const variants = [programSummary(variantName, variant)]
  const hand = [...validationRows(model, 'register: layout reads last frame spring position', [model.springPosition], cases, new Set()), ...variantRows(variant, variantName, cases)]
  printTable('Hand-chosen variants', variants)
  printTable('Hand-chosen cut on every trace', hand)
  // In frame 0 the register holds this frame's spring position (the evaluator assumes
  // the previous frame showed the same inputs), while the compiled variant reads the
  // initial spring cell, so the two can differ in frame 0 only.
  const registersAgainstCompiled = cases.map(({trace}) => ({
    trace: trace.name,
    ...compareRecordings(model, recordTrace(model, trace, [model.springPosition]), recordTrace(variant, trace)),
  }))
  printTable(`Register against "${variantName}": every recorded output`, registersAgainstCompiled)
  const describe = (position: number) => describeAppShellValue(model, position)
  const single = runStrategies({label: 'app shell: searched on the report frames', model, searchCases: [cases[0]!], allCases: cases, describe, maxLevelSize: 8, maxRegisters: 64, budget})
  const joint = runStrategies({label: 'app shell: searched on the report frames and random seed 1', model, searchCases: [cases[0]!, cases[2]!], allCases: cases, describe, maxLevelSize: 8, maxRegisters: 64, budget})
  // Random seeds 1 to 4 are cases 2 to 5; the smooth resize and seeds 5 to 10 stay held out.
  const withRandom = runStrategies({label: 'app shell: searched on the report frames and random seeds 1-4', model, searchCases: [cases[0]!, ...cases.slice(2, 6)], allCases: cases, describe, maxLevelSize: 8, maxRegisters: 64, budget})
  save('appShell', {summary, variants, hand, registersAgainstCompiled, single, joint, withRandom})
}

function hnThreadSection() {
  console.log('\n# hn-thread, 251 comments, 48 rank slots')
  const model = createHNModel('hn thread')
  const cases = recordCases(model, [scriptedSession(model, 900), scriptedSession(model, 600), scriptedSession(model, 1800), randomSession(model, 1, 900), randomSession(model, 2, 900), randomSession(model, 3, 900)])
  const summary = [programSummary('hn thread', model)]
  printTable('Program', summary)
  const describe = (position: number) => describeHNValue(model, position)
  const single = runStrategies({label: 'hn thread: searched on the 900-frame session', model, searchCases: [cases[0]!], allCases: cases, describe, maxLevelSize: 8, maxRegisters: 256, budget})
  const joint = runStrategies({label: 'hn thread: searched on the 900-frame session and random seed 1', model, searchCases: [cases[0]!, cases[3]!], allCases: cases, describe, maxLevelSize: 8, maxRegisters: 256, budget})
  // Every trace except random seed 3, which stays held out.
  const allButOne = runStrategies({label: 'hn thread: searched on the three scripted sessions and random seeds 1-2', model, searchCases: cases.slice(0, 5), allCases: cases, describe, maxLevelSize: 8, maxRegisters: 256, budget})
  save('hnThread', {summary, single, joint, allButOne})
}

function gallerySection() {
  console.log('\n# gallery, 221 photos')
  const model = createGalleryModel('gallery')
  // The differential's seeds 5000 to 5005, then seeds 6000 to 6005 on the same
  // viewports, which no search reads.
  const traces = [5000, 6000].flatMap(firstSeed => galleryViewports.map(([width, height], index) => galleryTrace(recordGalleryActions(firstSeed + index, 600, width, height))))
  const cases = recordCases(model, traces)
  const summary = [programSummary('gallery', model)]
  printTable('Program', summary)
  const describe = (position: number) => describeGalleryValue(model, position)
  const single = runStrategies({label: 'gallery: searched on seed 5000', model, searchCases: [cases[0]!], allCases: cases, describe, maxLevelSize: 8, maxRegisters: 256, budget})
  const joint = runStrategies({label: 'gallery: searched on seeds 5000-5002', model, searchCases: cases.slice(0, 3), allCases: cases, describe, maxLevelSize: 8, maxRegisters: 256, budget})
  const allSix = runStrategies({label: 'gallery: searched on seeds 5000-5005', model, searchCases: cases.slice(0, 6), allCases: cases, describe, maxLevelSize: 8, maxRegisters: 256, budget})
  save('gallery', {summary, single, joint, allSix})
}

const sections: Record<string, () => void> = {
  'indirect-os': indirectOSSection,
  'app-shell': appShellSection,
  'hn-thread': hnThreadSection,
  gallery: gallerySection,
}

if (requested !== undefined && sections[requested] === undefined) throw new Error(`unknown section ${requested}; expected one of ${Object.keys(sections).join(', ')}`)
for (const [name, run] of Object.entries(sections)) {
  if (requested === undefined || requested === name) {
    const started = performance.now()
    run()
    console.log(`\n(section ${name}: ${round((performance.now() - started) / 1000, 1)} s)`)
  }
}

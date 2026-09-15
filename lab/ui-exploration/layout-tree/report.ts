// Measurements for the layout tree prototype. Run from the repo root:
//   bun lab/ui-exploration/layout-tree/report.ts
// Prints markdown tables and writes report-results.json next to this file.
// Timings are rough: other processes share the machine.
import {createAppMachine, createAppShell} from './app-shell.ts'
import {appTextTables} from './app-text-tables.ts'
import {allocateLayoutSources, buildLayout, createLayoutReader, passNames, writeLayoutSources} from './builder.ts'
import {attributeProgram, createRandom, programStats, SourceTable, type TagStats} from './circuit-tools.ts'
import {compareLayouts} from './compare.ts'
import {randomInputs, randomScene} from './random-tree.ts'
import {clayGrowLoop, layoutReference, solveWaterLevel} from './reference.ts'
import {box, column, fit, fixed, grid, grow, input, padding, row, stickyScrollAncestor, text, walk, wrap, type LayoutNode, type TextTable} from './tree.ts'

const results: Record<string, unknown> = {}
const format = (value: number) => Number.isInteger(value) ? value.toLocaleString('en-US') : Number(value.toPrecision(3)).toString()
function printTable(title: string, headers: readonly string[], rows: readonly (readonly (string | number)[])[]) {
  console.log(`\n### ${title}\n`)
  console.log(`| ${headers.join(' | ')} |`)
  console.log(`| ${headers.map(() => '---').join(' | ')} |`)
  for (const cells of rows) console.log(`| ${cells.map(cell => typeof cell === 'number' ? format(cell) : cell).join(' | ')} |`)
}
function medianMicroseconds(run: () => void, iterations: number) {
  const samples: number[] = []
  for (let sample = 0; sample < 7; sample++) {
    for (let warm = 0; warm < 50; warm++) run()
    const started = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) run()
    samples.push((performance.now() - started) * 1000 / iterations)
  }
  samples.sort((left, right) => left - right)
  return samples[3]!
}
function aggregate(attribution: Map<string, TagStats>, keyOf: (tag: string) => string) {
  const totals = new Map<string, TagStats>()
  for (const [tag, stats] of attribution) {
    const key = keyOf(tag)
    const entry = totals.get(key) ?? {liveOperations: 0, storedWeights: 0, firstLayer: stats.firstLayer, lastLayer: stats.lastLayer}
    entry.liveOperations += stats.liveOperations
    entry.storedWeights += stats.storedWeights
    entry.firstLayer = Math.min(entry.firstLayer, stats.firstLayer)
    entry.lastLayer = Math.max(entry.lastLayer, stats.lastLayer)
    totals.set(key, entry)
  }
  return totals
}

type Scene = {root: LayoutNode, tables: Map<string, TextTable>, inputBounds: Map<string, readonly [number, number]>}
function compileScene(scene: Scene) {
  const table = new SourceTable()
  const sources = allocateLayoutSources(table, scene.root, {inputBounds: scene.inputBounds})
  const circuit = table.createCircuit()
  const reader = createLayoutReader(buildLayout(circuit, scene.root, sources))
  const evaluate = circuit.createTensorEvaluator(reader.roots)
  const check = (inputs: Record<string, number>) => {
    const values = table.createValues()
    writeLayoutSources(values, sources, inputs, scene.tables)
    const expected = layoutReference(scene.root, inputs, scene.tables)
    const actual = reader.read(evaluate(values))
    return {expected, actual, ...compareLayouts(expected, actual)}
  }
  return {circuit, reader, stats: programStats(circuit, reader.roots), attribution: attributeProgram(circuit, reader.roots), check}
}

// ---------------------------------------------------------------- A: the app shell
{
  const shell = createAppShell()
  const tables = new Map(Object.entries(appTextTables))
  const stats = programStats(shell.circuit, shell.roots)
  const visits = walk(shell.root)
  const kinds = {containers: 0, boxes: 0, texts: 0, maxLevel: 0}
  for (const {node, level} of visits) {
    kinds.maxLevel = Math.max(kinds.maxLevel, level)
    if (node.kind === 'container') kinds.containers++
    else if (node.kind === 'box') kinds.boxes++
    else kinds.texts++
  }
  const thresholdCount = [...tables.values()].reduce((sum, table) => sum + table.thresholds.length, 0)
  printTable('App shell circuit', ['nodes', 'containers / boxes / texts', 'tree levels', 'text thresholds (capacity cells)', 'sources', 'live ops', 'layers', 'stored weights', 'widest layer', 'gather reads'], [[
    visits.length, `${kinds.containers} / ${kinds.boxes} / ${kinds.texts}`, kinds.maxLevel + 1,
    `${thresholdCount} (${[...shell.sources.texts.values()].reduce((sum, cells) => sum + cells.thresholds.length, 0)})`,
    stats.sources, stats.liveOperations, stats.layers, stats.storedWeights, stats.widestLayer, stats.gatherReads,
  ]])
  const attribution = attributeProgram(shell.circuit, shell.roots)
  const byPass = aggregate(attribution, tag => tag.split(':')[0]!)
  printTable('App shell cost by pass', ['pass', 'live ops', 'stored weights', 'layers occupied'], [...['app', ...passNames]].map(name => {
    const entry = byPass.get(name) ?? {liveOperations: 0, storedWeights: 0, firstLayer: 0, lastLayer: -1}
    return [name, entry.liveOperations, entry.storedWeights, entry.lastLayer < 0 ? '-' : `${entry.firstLayer + 1}..${entry.lastLayer + 1}`]
  }))
  const byLevel = aggregate(attribution, tag => tag.split(':')[1] ?? '-')
  const rectDepth = (name: string) => {
    const rect = shell.layout.rects.get(name)!
    return Math.max(...[rect.x, rect.y, rect.width, rect.height].map(wire => shell.circuit.depths[wire]!))
  }
  const outputDepthByLevel = new Map<number, number>()
  for (const {node, level} of visits) outputDepthByLevel.set(level, Math.max(outputDepthByLevel.get(level) ?? 0, rectDepth(node.name)))
  printTable('App shell cost by tree level (ops that size or place a node\'s children, plus the node\'s own fit size)', ['level', 'live ops', 'stored weights', 'deepest rectangle output at this level (layer)'],
    [...outputDepthByLevel.keys()].map(level => {
      const entry = byLevel.get(String(level)) ?? {liveOperations: 0, storedWeights: 0, firstLayer: 0, lastLayer: 0}
      return [level, entry.liveOperations, entry.storedWeights, outputDepthByLevel.get(level)!]
    }))
  // Which rectangles below level 0 read the body row's height? The operations tagged "5 heights:0"
  // size the root column's children, and only the body row's height among them is not a constant.
  // The shared runtime composes small affines into their consumers, so a consumer may reference the
  // body height's own terms instead of its wire. So the check marks every operation with that tag
  // and follows dependencies forward from all of them.
  const bodyHeightTag = shell.circuit.tagIndexByName.get(`${passNames[4]}:0`)!
  const readsBodyHeight = new Uint8Array(shell.circuit.sourceSize + shell.circuit.operations.length)
  shell.circuit.operations.forEach((operation, operationIndex) => {
    const dependencies = [...operation.leftTerms, ...operation.gateTerms]
    if (shell.circuit.operationTags[operationIndex] === bodyHeightTag || dependencies.some(([dependency]) => readsBodyHeight[dependency] === 1)) {
      readsBodyHeight[shell.circuit.sourceSize + operationIndex] = 1
    }
  })
  const rectGroups = new Map<string, {count: number, firstDepth: number, lastDepth: number, names: string[]}>()
  for (const {node, level} of visits) {
    if (level === 0) continue
    const rect = shell.layout.rects.get(node.name)!
    const key = [rect.x, rect.y, rect.width, rect.height].some(wire => readsBodyHeight[wire] === 1)
      ? 'size or position reads the body row\'s height'
      : 'size and position do not read the body row\'s height'
    const depth = rectDepth(node.name)
    const group = rectGroups.get(key) ?? {count: 0, firstDepth: depth, lastDepth: depth, names: []}
    group.count++
    group.firstDepth = Math.min(group.firstDepth, depth)
    group.lastDepth = Math.max(group.lastDepth, depth)
    group.names.push(node.name)
    rectGroups.set(key, group)
  }
  const depthHistogram = new Map<number, number>()
  for (const {node, level} of visits) {
    if (level > 0) depthHistogram.set(rectDepth(node.name), (depthHistogram.get(rectDepth(node.name)) ?? 0) + 1)
  }
  printTable('App shell rectangles below level 0 (depth is the deepest of x, y, width and height; a constant counts as depth 1)', ['rectangles', 'count', 'depth (layers)', 'names'],
    [...rectGroups].map(([key, group]) => [key, group.count, `${group.firstDepth}..${group.lastDepth}`, group.names.length > 24 ? `${group.names.slice(0, 8).join(', ')}, ...` : group.names.join(', ')]))
  console.log('\nrectangles below level 0 by depth, as [depth, count]:', JSON.stringify([...depthHistogram].sort((left, right) => left[0] - right[0])))
  // The longest chain of operations, split into consecutive runs by pass.
  const program = shell.circuit.compileTensorProgram(shell.roots)
  let deepest = -1
  for (let packed = shell.circuit.sourceSize; packed < program.wireOrder.length; packed++) {
    const wire = program.wireOrder[packed]!
    if (deepest < 0 || shell.circuit.depths[wire]! > shell.circuit.depths[deepest]!) deepest = wire
  }
  const chain: string[] = []
  for (let wire = deepest; wire >= shell.circuit.sourceSize;) {
    const operationIndex = wire - shell.circuit.sourceSize
    chain.push(shell.circuit.tagNames[shell.circuit.operationTags[operationIndex]!]!)
    const operation = shell.circuit.operations[operationIndex]!
    const dependencies = [...operation.leftTerms, ...operation.gateTerms].map(([dependency]) => dependency).filter(dependency => dependency >= shell.circuit.sourceSize)
    if (dependencies.length === 0) break
    wire = dependencies.reduce((best, dependency) => shell.circuit.depths[dependency]! > shell.circuit.depths[best]! ? dependency : best)
  }
  chain.reverse()
  const runs: {tag: string, layers: number}[] = []
  for (const tag of chain) {
    const last = runs.at(-1)
    if (last?.tag === tag) last.layers++
    else runs.push({tag, layers: 1})
  }
  printTable('App shell longest chain, as consecutive runs of pass:level', ['pass:level', 'layers on the chain'], runs.map(run => [run.tag, run.layers]))
  const variants: (string | number)[][] = []
  for (const [label, overrides] of [
    ['as built (spring feeds this frame\'s layout, tags wrap)', {}],
    ['layout reads the previous frame\'s spring position', {springFeedsLayout: 'previous frame'}],
    ['no tags wrap', {tags: false}],
    ['previous frame\'s spring position, no tags wrap', {springFeedsLayout: 'previous frame', tags: false}],
  ] as const) {
    const variant = createAppShell(overrides)
    const variantStats = programStats(variant.circuit, variant.roots)
    variants.push([label, variantStats.liveOperations, variantStats.layers, variantStats.storedWeights])
  }
  printTable('App shell depth variants', ['variant', 'live ops', 'layers', 'stored weights'], variants)
  results['appShellChain'] = runs
  results['appShellVariants'] = variants
  results['appShellRectGroups'] = Object.fromEntries(rectGroups)
  results['appShellRectDepthHistogram'] = [...depthHistogram].sort((left, right) => left[0] - right[0])

  const machine = createAppMachine(shell, tables)
  for (let settle = 0; settle < 120; settle++) machine.step({viewportWidth: 1280, viewportHeight: 800, frameDuration: 1 / 60, pointerDown: null, scrollDelta: 0})
  const evaluate = shell.circuit.createTensorEvaluator(shell.roots)
  const values = machine.values
  const circuitMicroseconds = medianMicroseconds(() => { evaluate(values) }, 300)
  const stepMicroseconds = medianMicroseconds(() => { machine.step({viewportWidth: 1280, viewportHeight: 800, frameDuration: 1 / 60, pointerDown: null, scrollDelta: 0}) }, 300)
  const inputs = {viewportWidth: 1280, viewportHeight: 800, mainScroll: 0, sidebarWidth: 220}
  const referenceMicroseconds = medianMicroseconds(() => { layoutReference(shell.root, inputs, tables) }, 300)
  printTable('App shell timing (rough, median microseconds)', ['circuit evaluation', 'machine step (evaluation, reading results into Maps, writeback)', 'JS reference layout'], [[circuitMicroseconds, stepMicroseconds, referenceMicroseconds]])
  results['appShell'] = {stats, kinds, thresholdCount, byPass: Object.fromEntries(byPass), byLevel: Object.fromEntries(byLevel), outputDepthByLevel: Object.fromEntries(outputDepthByLevel), circuitMicroseconds, stepMicroseconds, referenceMicroseconds}

  // Frames of the interactive machine against the JS reference, at the inputs each frame used:
  // viewport widths from 320 to 2400, scroll requests past the content's bottom (the circuit
  // clamps the scroll position to the content's bottom), a request above the top (JS keeps the
  // scroll cell within 0..8192 before the circuit runs), and every frame of a sidebar toggle
  // while its spring moves.
  const frameMachine = createAppMachine(shell, tables)
  const frameTotals = {frames: 0, worstDrift: 0, discrete: 0, mismatches: 0}
  const compareFrame = (result: ReturnType<typeof frameMachine.step>) => {
    const difference = compareLayouts(layoutReference(shell.root, result.inputs, tables), result.layout)
    frameTotals.frames++
    frameTotals.worstDrift = Math.max(frameTotals.worstDrift, difference.maxDrift)
    frameTotals.discrete += difference.discreteCompared
    frameTotals.mismatches += difference.discreteMismatches.length
    return result
  }
  const idle = (viewportWidth: number, scrollDelta = 0, pointerDown: {x: number, y: number} | null = null) =>
    frameMachine.step({viewportWidth, viewportHeight: 820, frameDuration: 1 / 60, pointerDown, scrollDelta})
  for (let viewportWidth = 320; viewportWidth <= 2400; viewportWidth += 80) {
    for (let settle = 0; settle < 60; settle++) idle(viewportWidth)
    for (const scrollDelta of [0, 400, 800, 9000, -20_000]) compareFrame(idle(viewportWidth, scrollDelta))
  }
  for (const viewportWidth of [900, 1440]) {
    let result = idle(viewportWidth)
    for (let settle = 0; settle < 60; settle++) result = idle(viewportWidth)
    const menu = result.layout.rects.get('menuButton')!
    for (let toggle = 0; toggle < 2; toggle++) {
      compareFrame(idle(viewportWidth, 0, {x: menu.x + 20, y: menu.y + 20}))
      for (let frame = 0; frame < 45; frame++) compareFrame(idle(viewportWidth, 37))
    }
  }
  printTable('App shell frames against the JS reference', ['frames compared', 'max drift px', 'discrete results compared', 'discrete mismatches'],
    [[frameTotals.frames, frameTotals.worstDrift, frameTotals.discrete, frameTotals.mismatches]])
  results['appShellFrames'] = frameTotals
}

// ---------------------------------------------------------------- B: cost against child count
{
  const syntheticTable = (index: number): TextTable => {
    const naturalWidth = 120 + (index * 37) % 150
    const minWidth = 40 + (index * 13) % 40
    return {naturalWidth, minWidth, baseLines: 1, thresholds: [minWidth + 5, (minWidth + naturalWidth) / 2, naturalWidth - 3]}
  }
  const maxWidthOf = (index: number) => index % 3 === 0 ? Number.POSITIVE_INFINITY : 60 + (index * 53) % 200
  const smallFitWidth = (index: number) => 20 + (index * 7) % 30
  const strictlyBetween = (value: number, low: number, high: number) => value > low + 1e-6 && value < high - 1e-6
  type Built = {root: LayoutNode, inputs?: Record<string, number>, inputBounds?: Map<string, readonly [number, number]>}
  type Case = {
    name: string
    pass: string
    make: (count: number, tables: Map<string, TextTable>) => Built
    // Whether child `index` sits strictly inside one of its water-filling intervals at this
    // width. When no child does, every child rests at a bound and the level is never used.
    isFree?: (width: number, index: number, tables: Map<string, TextTable>) => boolean
  }
  const cases: Case[] = [
    {
      // A box's fit width is its constant min, so every pairwise ReLU between breakpoints folds.
      name: 'row of grow boxes with min and max, constant fit widths (grow)',
      pass: passNames[1],
      make: count => ({root: row({name: 'root', width: grow(), height: grow(), padding: padding(8), gap: 8},
        Array.from({length: count}, (_, index) => box(`child${index}`, grow((index * 17) % 50, maxWidthOf(index)), fixed(20))))}),
      isFree: (width, index) => strictlyBetween(width, (index * 17) % 50, maxWidthOf(index)),
    },
    {
      // Each child's fit width is its own runtime input, and its min width is the same wire, so
      // the builder builds only the grow water fill.
      name: 'row of grow containers with min and max, runtime fit widths (grow)',
      pass: passNames[1],
      make: count => {
        const inputs: Record<string, number> = {}
        const inputBounds = new Map<string, readonly [number, number]>()
        const children = Array.from({length: count}, (_, index) => {
          inputs[`size${index}`] = smallFitWidth(index)
          inputBounds.set(`size${index}`, [0, 400])
          return row({name: `child${index}`, width: grow(0, maxWidthOf(index)), height: fixed(20)}, [box(`inner${index}`, input(`size${index}`), fixed(20))])
        })
        return {root: row({name: 'root', width: grow(), height: grow(), padding: padding(8), gap: 8}, children), inputs, inputBounds}
      },
      isFree: (width, index) => strictlyBetween(width, smallFitWidth(index), maxWidthOf(index)),
    },
    {
      // Texts can also shrink, so this row builds both water fills.
      name: 'row of grow texts with min and max (grow and shrink)',
      pass: passNames[1],
      make: (count, tables) => ({root: row({name: 'root', width: grow(), height: grow(), padding: padding(8), gap: 8},
        Array.from({length: count}, (_, index) => {
          const naturalWidth = smallFitWidth(index)
          tables.set(`text${index}`, {naturalWidth, minWidth: 10, baseLines: 1, thresholds: [13, (10 + naturalWidth) / 2]})
          return text(`child${index}`, `text${index}`, {width: grow(0, maxWidthOf(index)), lineHeight: 20, capacity: 2})
        }))}),
      isFree: (width, index) => strictlyBetween(width, 10, smallFitWidth(index)) || strictlyBetween(width, smallFitWidth(index), maxWidthOf(index)),
    },
    {
      name: 'row of fit texts (shrink)',
      pass: passNames[1],
      make: (count, tables) => ({root: row({name: 'root', width: grow(), height: grow(), padding: padding(8), gap: 8},
        Array.from({length: count}, (_, index) => {
          tables.set(`text${index}`, syntheticTable(index))
          return text(`child${index}`, `text${index}`, {width: fit(), lineHeight: 20, capacity: 3})
        }))}),
      isFree: (width, index, tables) => strictlyBetween(width, tables.get(`text${index}`)!.minWidth, tables.get(`text${index}`)!.naturalWidth),
    },
    {
      // The column is a fit child of a row, so its widest-child fit width is actually read.
      name: 'column of fit texts inside a row (widest child, stacked heights)',
      pass: passNames[0],
      make: (count, tables) => ({root: row({name: 'root', width: grow(), height: grow(), gap: 8}, [
        column({name: 'list', width: fit(), height: grow(), padding: padding(8), gap: 8, alignX: 'center'},
          Array.from({length: count}, (_, index) => {
            tables.set(`text${index}`, syntheticTable(index))
            return text(`child${index}`, `text${index}`, {width: fit(), lineHeight: 20, capacity: 3})
          })),
        box('rest', grow(), grow()),
      ])}),
    },
    {
      name: 'wrap of fixed boxes (greedy lines)',
      pass: passNames[1],
      make: count => ({root: wrap({name: 'root', width: grow(), height: grow(), padding: padding(8), gap: 8, alignX: 'center', alignY: 'center'},
        Array.from({length: count}, (_, index) => box(`child${index}`, fixed(40 + (index * 37) % 120), fixed(20 + (index * 11) % 40))))}),
    },
    {
      name: 'grid of texts, maxColumns 6 (column-count variants)',
      pass: passNames[3],
      make: (count, tables) => ({root: grid({name: 'root', width: grow(), height: grow(), padding: padding(8), gap: 8, minCellWidth: 150, maxColumns: 6},
        Array.from({length: count}, (_, index) => {
          tables.set(`text${index}`, syntheticTable(index))
          return text(`child${index}`, `text${index}`, {width: grow(), lineHeight: 20, capacity: 3})
        }))}),
    },
  ]
  // Every row is checked at the same sweep of viewport widths, so each water fill is checked at
  // widths where its level is actually solved, not only where every child rests at a bound.
  const sweepWidths: number[] = []
  for (let width = 100; width <= 8150; width += 7.25) sweepWidths.push(width)
  const rows: (string | number)[][] = []
  const driftRows: (string | number)[][] = []
  const scaling: Record<string, unknown[]> = {}
  for (const testCase of cases) {
    scaling[testCase.name] = []
    for (const count of [2, 4, 8, 16, 32, 64]) {
      const tables = new Map<string, TextTable>()
      const built = testCase.make(count, tables)
      const scene = compileScene({root: built.root, tables, inputBounds: built.inputBounds ?? new Map()})
      const pass = aggregate(scene.attribution, tag => tag.split(':')[0]!).get(testCase.pass) ?? {liveOperations: 0, storedWeights: 0, firstLayer: 0, lastLayer: -1}
      let maxDrift = 0
      let worst = ''
      let mismatches = 0
      let discrete = 0
      let freeWidths = 0
      let maxWidthDrift = 0
      for (const viewportWidth of sweepWidths) {
        const difference = scene.check({...built.inputs, viewportWidth, viewportHeight: 800})
        if (difference.maxDrift > maxDrift) {
          maxDrift = difference.maxDrift
          worst = `width ${viewportWidth}, ${difference.worst}`
        }
        mismatches += difference.discreteMismatches.length
        discrete += difference.discreteCompared
        for (let index = 0; index < count; index++) {
          const expectedWidth = difference.expected.rects.get(`child${index}`)!.width
          maxWidthDrift = Math.max(maxWidthDrift, Math.abs(expectedWidth - difference.actual.rects.get(`child${index}`)!.width))
        }
        const isFree = testCase.isFree
        if (isFree !== undefined && Array.from({length: count}, (_, index) => index).some(index => isFree(difference.expected.rects.get(`child${index}`)!.width, index, tables))) freeWidths++
      }
      rows.push([
        testCase.name, count, scene.stats.liveOperations, scene.stats.layers, scene.stats.storedWeights,
        `${testCase.pass}: ${pass.liveOperations} ops, ${pass.storedWeights} weights, ${pass.lastLayer - pass.firstLayer + 1} layers`,
        testCase.isFree === undefined ? '-' : `${freeWidths} of ${sweepWidths.length}`,
        maxDrift, discrete, discrete === 0 ? '-' : mismatches,
      ])
      scaling[testCase.name]!.push({count, ...scene.stats, pass, sweptWidths: sweepWidths.length, freeWidths: testCase.isFree === undefined ? null : freeWidths, maxDrift, worst, maxWidthDrift, discrete, mismatches})
      if (count === 64) driftRows.push([testCase.name, maxDrift, worst, maxWidthDrift])
    }
  }
  printTable(`Cost against child count (one container, whole layout circuit, checked at ${sweepWidths.length} viewport widths from 100 to 8150 in 7.25 px steps)`,
    ['container', 'children', 'live ops', 'layers', 'stored weights', 'the pass that scales', 'swept widths with a free child', 'max drift px', 'discrete results compared', 'discrete mismatches'], rows)
  printTable("Drift at 64 children over the width sweep: the worst value, and the drift in the children's widths alone", ['container', 'max drift px', 'where', "max drift in children's widths px"], driftRows)
  results['scaling'] = scaling
}

// ---------------------------------------------------------------- C: nesting depth
{
  const rows: (string | number)[][] = []
  const nesting: unknown[] = []
  for (const depth of [1, 2, 4, 8, 16, 32]) {
    const tables = new Map<string, TextTable>([['leafText', {naturalWidth: 300, minWidth: 60, baseLines: 1, thresholds: [80, 140, 220]}]])
    let node: LayoutNode = text('leaf', 'leafText', {width: grow(), lineHeight: 20, capacity: 3})
    for (let level = depth - 1; level >= 0; level--) {
      const options = {name: `level${level}`, width: grow(), height: grow(), padding: padding(4), gap: 4, alignX: 'center' as const, alignY: 'center' as const}
      const children: LayoutNode[] = [node, box(`box${level}`, fit(30, 90), fixed(20))]
      node = level % 2 === 0 ? row(options, children) : column(options, children)
    }
    const scene = compileScene({root: node, tables, inputBounds: new Map()})
    let maxDrift = 0
    let mismatches = 0
    for (const viewportWidth of [100, 400, 1200]) {
      const difference = scene.check({viewportWidth, viewportHeight: 900})
      maxDrift = Math.max(maxDrift, difference.maxDrift)
      mismatches += difference.discreteMismatches.length
    }
    const leafDepth = scene.circuit.depths[scene.reader.roots[scene.reader.roots.length - 1]!]!
    rows.push([depth, scene.stats.liveOperations, scene.stats.layers, scene.stats.storedWeights, maxDrift, mismatches])
    nesting.push({depth, ...scene.stats, leafDepth, maxDrift, mismatches})
  }
  printTable('Cost against nesting depth (alternating rows and columns, each with a growing child and a fit box)', ['nesting levels', 'live ops', 'layers', 'stored weights', 'max drift px', 'discrete mismatches'], rows)
  results['nesting'] = nesting
}

// ---------------------------------------------------------------- D: random trees against the JS reference
{
  const rows: (string | number)[][] = []
  const differential: unknown[] = []
  for (const gridAlignedText of [false, true]) {
    const random = createRandom(99)
    let worst = 0
    let mismatches = 0
    let discrete = 0
    let continuous = 0
    let liveTotal = 0
    let maxLive = 0
    let maxLayers = 0
    const drifts: number[] = []
    const coverage: Record<string, number> = {}
    const seeds = 300
    const viewportsPerTree = 20
    for (let seed = 1; seed <= seeds; seed++) {
      const scene = randomScene(seed, {maxDepth: 4, maxChildren: 4, gridAlignedText})
      for (const {node} of walk(scene.root)) {
        const key = node.kind === 'container' ? node.layout + (node.scrollY === null ? '' : ' (scroll)') : node.kind
        coverage[key] = (coverage[key] ?? 0) + 1
        if (node.sticky) {
          const stickyKey = stickyScrollAncestor(scene.root, node) === null ? 'sticky flag where the rule does not apply' : 'sticky node where the rule applies'
          coverage[stickyKey] = (coverage[stickyKey] ?? 0) + 1
        }
      }
      const compiled = compileScene(scene)
      liveTotal += compiled.stats.liveOperations
      maxLive = Math.max(maxLive, compiled.stats.liveOperations)
      maxLayers = Math.max(maxLayers, compiled.stats.layers)
      for (let trial = 0; trial < viewportsPerTree; trial++) {
        const difference = compiled.check(randomInputs(scene, random))
        drifts.push(difference.maxDrift)
        worst = Math.max(worst, difference.maxDrift)
        mismatches += difference.discreteMismatches.length
        discrete += difference.discreteCompared
        continuous += difference.continuousCompared
      }
    }
    drifts.sort((left, right) => left - right)
    const p99 = drifts[Math.floor(drifts.length * 0.99)]!
    rows.push([gridAlignedText ? 'text thresholds on a 1/4 px grid' : 'text thresholds at random reals', `${seeds} x ${viewportsPerTree}`, continuous, worst, p99, discrete, mismatches, liveTotal / seeds, maxLive, maxLayers])
    differential.push({gridAlignedText, seeds, viewportsPerTree, continuous, worst, p99, discrete, mismatches, averageLive: liveTotal / seeds, maxLive, maxLayers, coverage})
    if (!gridAlignedText) console.log('\nrandom tree coverage:', JSON.stringify(coverage))
  }
  printTable('Random trees against the JS reference', ['text tables', 'trees x viewports', 'positions and sizes compared', 'max drift px', 'p99 of per-layout max drift px', 'discrete results compared', 'discrete mismatches', 'average live ops', 'max live ops', 'max layers'], rows)
  results['differential'] = differential
}

// ---------------------------------------------------------------- E: Clay's grow loop against water filling
{
  const rows: (string | number)[][] = []
  const clay: unknown[] = []
  const random = createRandom(7)
  for (const count of [2, 4, 16, 64]) {
    let maxRounds = 0
    let roundsTotal = 0
    let maxDifference = 0
    const trials = 1000
    for (let trial = 0; trial < trials; trial++) {
      const sizes = Array.from({length: count}, () => Math.floor(random() * 200))
      const maximums = sizes.map(size => random() < 0.5 ? Number.POSITIVE_INFINITY : size + Math.floor(random() * 300))
      const space = random() * count * 150
      const loop = clayGrowLoop(sizes, maximums, space)
      const exact = solveWaterLevel(sizes, maximums, sizes.reduce((sum, size) => sum + size, 0) + space)
      maxRounds = Math.max(maxRounds, loop.rounds)
      roundsTotal += loop.rounds
      loop.sizes.forEach((size, index) => { maxDifference = Math.max(maxDifference, Math.abs(size - exact[index]!)) })
    }
    rows.push([count, roundsTotal / trials, maxRounds, maxDifference])
    clay.push({count, averageRounds: roundsTotal / trials, maxRounds, maxDifference})
  }
  printTable("Clay's GROW loop (float32 like clay.h, divides leftover space by all growing children, stops under 0.01 px) against exact water filling", ['grow children', 'average rounds', 'max rounds', 'max size difference px'], rows)
  results['clayGrowLoop'] = clay
}

await Bun.write(`${import.meta.dir}/report-results.json`, `${JSON.stringify(results, null, 2)}\n`)

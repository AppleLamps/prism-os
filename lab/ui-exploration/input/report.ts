// Heavy measurements for this folder: circuit sizes across queue capacities and
// forms, long random traces against the oracles, and rough CPU timings.
// Run: bun lab/ui-exploration/input/report.ts
// Timings share the machine with other work, so read them as rough; the counts
// are exact.

import {Circuit} from '../../../numeric-ui-core.ts'
import {appOracleFrame, createAppMachine, createAppState} from './app.ts'
import {allocateEventQueue, writeEventQueue, type QueuedEvent} from './events.ts'
import {testControlRectangles, testWindowsConfig} from './fixtures.ts'
import {arrowKeys, arrowTables, createKeyboardMachine, keyboardOracleEvent, tabTables, type ControlGeometry, type KeyboardState} from './keyboard.ts'
import {createKit, measureProgram, SourceLayout, sklanskyPrefix, type Kit, type ProgramMeasure, type Term, type Wire} from './kit.ts'
import {createMenuMachine, menuOracleEvent, menuOracleFocusTarget, menuPlacement, menuPlacementFlips, type MenuState} from './menu.ts'
import {generateAppTrace, generateKeyboardTrace, generateMenuTrace, generateWindowsTrace} from './traces.ts'
import {createWindowsMachine, createWindowsState, variantLabel, windowsOracleFrame, type WindowsVariant} from './windows.ts'

const quick = process.argv.includes('--quick')

function row(cells: readonly (string | number)[]) {
  return `| ${cells.map(cell => (typeof cell === 'number' ? cell.toLocaleString('en-US') : cell)).join(' | ')} |`
}

function header(cells: readonly string[]) {
  return [row(cells), row(cells.map(() => '---'))].join('\n')
}

function measureRow(label: string, capacity: number, measure: ProgramMeasure) {
  return row([label, capacity, measure.liveOperations, measure.layers, measure.weights, measure.widestLayer, measure.gatherReads])
}

// Times only the evaluator over prepared source tables.
function timeEvaluations(evaluate: (source: Float32Array) => Float32Array, sources: readonly Float32Array[], evaluationsPerFrame: readonly number[] | null) {
  for (let warmup = 0; warmup < 3; warmup++) {
    for (const source of sources) evaluate(source)
  }
  const start = performance.now()
  const rounds = 3
  for (let round = 0; round < rounds; round++) {
    for (const source of sources) evaluate(source)
  }
  const elapsed = (performance.now() - start) * 1000 / rounds
  const frames = evaluationsPerFrame === null ? sources.length : evaluationsPerFrame.length
  return elapsed / frames
}

// ---------------------------------------------------------------------------
console.log('## Window behaviors: sizes\n')
console.log(header(['form', 'queue capacity', 'live operations', 'layers', 'stored weights', 'widest layer', 'gather reads']))
const windowCapacities = quick ? [1, 4, 16] : [1, 2, 4, 8, 16, 32]
for (const capacity of windowCapacities) {
  const variants: WindowsVariant[] = [{kind: 'unrolled'}]
  for (const maximumDowns of [1, 2, 4]) {
    if (maximumDowns <= capacity) variants.push({kind: 'folded', maximumDowns, pressPoint: 'session'})
  }
  if (capacity >= 2) variants.push({kind: 'folded', maximumDowns: 2, pressPoint: 'prefix-scan'})
  for (const variant of variants) {
    const machine = createWindowsMachine(testWindowsConfig, capacity, variant)
    console.log(measureRow(variantLabel(variant), capacity, measureProgram(machine.circuit, machine.roots)))
  }
}

console.log('\n## Window behaviors: random traces against the oracle, and rough CPU time\n')
console.log(header(['form', 'queue capacity', 'frames', 'events', 'downs', 'maximize toggles', 'drag commits', 'frames with any state or display mismatch', 'µs per frame (evaluations only)']))
{
  const capacity = 16
  const traceFrames = quick ? 2000 : 20000
  for (const [maximumDowns, variants] of [
    [2, [{kind: 'unrolled'}, {kind: 'folded', maximumDowns: 2, pressPoint: 'session'}, {kind: 'folded', maximumDowns: 2, pressPoint: 'prefix-scan'}]],
    [4, [{kind: 'unrolled'}, {kind: 'folded', maximumDowns: 4, pressPoint: 'session'}]],
  ] as const) {
    const frames = generateWindowsTrace(testWindowsConfig, {seed: 1000 + maximumDowns, frames: traceFrames, capacity, maximumDowns})
    for (const variant of variants as readonly WindowsVariant[]) {
      const machine = createWindowsMachine(testWindowsConfig, capacity, variant)
      const evaluate = machine.circuit.createTensorEvaluator(machine.roots)
      const oracle = createWindowsState(testWindowsConfig)
      let mismatches = 0
      let events = 0
      let downs = 0
      let toggles = 0
      let commits = 0
      const sources: Float32Array[] = []
      for (const frame of frames) {
        const maximizedBefore = [...oracle.maximized]
        const leftBefore = [...oracle.left]
        const topBefore = [...oracle.top]
        const display = windowsOracleFrame(testWindowsConfig, oracle, frame.frameDelta, frame.events)
        toggles += oracle.maximized.filter((value, index) => value !== maximizedBefore[index]).length
        commits += oracle.left.filter((value, index) => value !== leftBefore[index] || oracle.top[index] !== topBefore[index]).length
        events += frame.events.length
        downs += frame.events.filter(event => event.kind === 'down').length
        machine.writeFrame(frame.frameDelta, frame.events)
        if (sources.length < 4000) sources.push(new Float32Array(machine.source))
        const actual = machine.step(frame.frameDelta, frame.events)
        if (JSON.stringify(actual) !== JSON.stringify({state: oracle, display})) mismatches++
      }
      const microseconds = timeEvaluations(evaluate, sources, null)
      console.log(row([variantLabel(variant), capacity, frames.length, events, downs, toggles, commits, mismatches, microseconds.toFixed(1)]))
    }
    // The alternative without depth growth: one single-event evaluation per queued event.
    const single = createWindowsMachine(testWindowsConfig, 1, {kind: 'unrolled'})
    const evaluate = single.circuit.createTensorEvaluator(single.roots)
    const oracle = createWindowsState(testWindowsConfig)
    const sources: Float32Array[] = []
    const perFrame: number[] = []
    let mismatches = 0
    for (const frame of frames.slice(0, 4000)) {
      const display = windowsOracleFrame(testWindowsConfig, oracle, frame.frameDelta, frame.events)
      const evaluations = frame.events.length === 0 ? [[]] : frame.events.map(event => [event])
      let actual = null as ReturnType<typeof single.step> | null
      evaluations.forEach((chunk, index) => {
        single.writeFrame(index === 0 ? frame.frameDelta : 0, chunk)
        sources.push(new Float32Array(single.source))
        actual = single.step(index === 0 ? frame.frameDelta : 0, chunk)
      })
      perFrame.push(evaluations.length)
      if (JSON.stringify(actual) !== JSON.stringify({state: oracle, display})) mismatches++
    }
    const microseconds = timeEvaluations(evaluate, sources, perFrame)
    console.log(row([`one evaluation per event (capacity-1 circuit), downs ≤ ${maximumDowns} trace`, 1, perFrame.length, '', '', '', '', mismatches, microseconds.toFixed(1)]))
  }
}

// ---------------------------------------------------------------------------
console.log('\n## Keyboard focus: sizes (12 controls unless noted)\n')
console.log(header(['navigation', 'queue capacity', 'live operations', 'layers', 'stored weights', 'widest layer', 'gather reads']))
for (const capacity of quick ? [1, 8] : [1, 2, 4, 8, 16]) {
  for (const navigation of ['per-event', 'tables'] as const) {
    const machine = createKeyboardMachine(12, capacity, navigation)
    console.log(measureRow(navigation, capacity, measureProgram(machine.circuit, machine.roots)))
  }
}
for (const navigation of ['per-event', 'tables'] as const) {
  const machine = createKeyboardMachine(24, 8, navigation)
  console.log(measureRow(`${navigation}, 24 controls`, 8, measureProgram(machine.circuit, machine.roots)))
}

console.log('\n## Keyboard focus: random traces against the oracle\n')
console.log(header(['navigation', 'queue capacity', 'frames', 'key events', 'focus changes', 'activations', 'frames with any mismatch', 'µs per frame (evaluations only)']))
for (const navigation of ['per-event', 'tables'] as const) {
  const capacity = 8
  const machine = createKeyboardMachine(12, capacity, navigation)
  const evaluate = machine.circuit.createTensorEvaluator(machine.roots)
  let frames = 0
  let keyEvents = 0
  let focusChanges = 0
  let activationTotal = 0
  let mismatches = 0
  const sources: Float32Array[] = []
  for (const [seed, rectangles] of [[31, testControlRectangles], [32, null], [33, null]] as const) {
    const trace = generateKeyboardTrace({seed, frames: quick ? 1000 : 6000, capacity, rectangles, controlCount: 12})
    machine.reset(trace[0]!.layout)
    const oracle: KeyboardState = {focus: -1, pressedControl: -1}
    for (const frame of trace) {
      machine.writeControls(frame.layout)
      const activations = frame.layout.rectangles.map(() => 0)
      const focusBefore = oracle.focus
      for (const event of frame.events) keyboardOracleEvent(frame.layout, oracle, event, activations)
      if (oracle.focus !== focusBefore) focusChanges++
      keyEvents += frame.events.filter(event => event.kind === 'key').length
      activationTotal += activations.reduce((total, value) => total + value, 0)
      writeEventQueue(machine.source, machine.slots, frame.events)
      if (sources.length < 4000) sources.push(new Float32Array(machine.source))
      const result = machine.step(frame.events)
      if (JSON.stringify(result.state) !== JSON.stringify(oracle) || JSON.stringify(result.activations) !== JSON.stringify(activations) || result.focusedIndex !== oracle.focus) mismatches++
      frames++
    }
  }
  console.log(row([navigation, capacity, frames, keyEvents, focusChanges, activationTotal, mismatches, timeEvaluations(evaluate, sources, null).toFixed(1)]))
}

// Keyboard focus as transition matrices: each key event's effect is a one-hot
// transition matrix over the 13 focus states (12 controls plus none). The
// 'scan' form composes the matrices through a Sklansky prefix scan and applies
// the total to the focus. The 'sequential' form multiplies the focus vector by
// each matrix in turn. Both handle the same keys (Tab, Shift+Tab, arrows,
// Escape) and nothing else: no pointer events, Enter, Space, or activations.
function buildKeyboardMatrixFocus(controlCount: number, capacity: number, form: 'scan' | 'sequential') {
  const layout = new SourceLayout()
  const left = layout.cells('left', controlCount, -4096, 4096)
  const top = layout.cells('top', controlCount, -4096, 4096)
  const width = layout.cells('width', controlCount, 1, 4096)
  const height = layout.cells('height', controlCount, 1, 4096)
  const enabled = layout.cells('enabled', controlCount, 0, 1)
  const focus = layout.cells('focus', controlCount, 0, 1)
  const slots = allocateEventQueue(layout, capacity)
  const circuit: Circuit = layout.createCircuit()
  const kit: Kit = createKit(circuit)
  const controls: ControlGeometry[] = left.map((wire, index) => ({left: wire, top: top[index]!, width: width[index]!, height: height[index]!}))
  const tabs = tabTables(kit, enabled)
  const arrows = arrowTables(kit, controls, enabled)
  const states = controlCount + 1
  const none = controlCount
  // Row `from`, column `to`, as term lists; a missing entry is 0.
  const fromTable = (rows: readonly Wire[][], start: readonly Wire[]) => Array.from({length: states}, (_, from) => {
    const row = from === none ? start : rows[from]!
    return [...row, kit.bitAffine(Array.from(row, wire => [wire, -1] as const), 1)]
  })
  const toNone = Array.from({length: states}, () => [...Array<Wire>(controlCount).fill(kit.zero), kit.one])
  const matrices = slots.map(slot => {
    const tabForward = kit.atLeast([[slot.keys.Tab, 1], [slot.shift, -1]], 1)
    const tabBackward = kit.and([slot.keys.Tab, slot.shift])
    const kinds: [Wire, Wire[][]][] = [
      [tabForward, fromTable(tabs.next, tabs.start)],
      [tabBackward, fromTable(tabs.previous, tabs.end)],
      ...arrowKeys.map(key => [slot.keys[key], fromTable(arrows[key].map(row => [...row]), tabs.start)] as [Wire, Wire[][]]),
      [slot.keys.Escape, toNone],
    ]
    const stay = kit.not(kit.bitAffine(kinds.map(([bit]) => [bit, 1] as const)))
    return Array.from({length: states}, (_, from) => Array.from({length: states}, (_, to) => {
      const terms: Term[] = from === to ? [[stay, 1]] : []
      for (const [bit, table] of kinds) {
        const entry = table[from]![to]!
        if (entry === kit.zero) continue
        terms.push(entry === kit.one ? [bit, 1] : [kit.mask(bit, entry), 1])
      }
      return kit.bitAffine(terms)
    }))
  })
  const compose = (earlier: Wire[][], later: Wire[][]) => earlier.map(row => Array.from({length: states}, (_, to) => kit.bitAffine(row.map((entry, middle) => [kit.mask(entry, later[middle]![to]!), 1] as const))))
  const noFocus = kit.bitAffine(focus.map(wire => [wire, -1] as const), 1)
  let finalFocus: Wire[]
  if (form === 'scan') {
    const total = sklanskyPrefix(matrices, compose)[capacity - 1]!
    finalFocus = Array.from({length: controlCount}, (_, to) => kit.bitAffine([
      ...focus.map((wire, from) => [kit.mask(wire, total[from]![to]!), 1] as const),
      [kit.mask(noFocus, total[none]![to]!), 1],
    ]))
  } else {
    let vector: Wire[] = [...focus, noFocus]
    for (const matrix of matrices) {
      const current = vector
      vector = Array.from({length: states}, (_, to) => kit.bitAffine(current.map((entry, from) => [kit.mask(entry, matrix[from]![to]!), 1] as const)))
    }
    finalFocus = vector.slice(0, controlCount)
  }
  return {layout, circuit, left, top, width, height, enabled, focus, slots, roots: finalFocus}
}

console.log('\n## Keyboard focus as transition matrices: prefix scan versus one matrix per event in sequence (Tab, arrows, and Escape only, 12 controls)\n')
console.log(header(['form', 'queue capacity', 'live operations', 'layers', 'stored weights', 'widest layer', 'gather reads', 'frames checked', 'frames with any of these keys', 'focus changes', 'frames with any output not the exact expected one-hot']))
for (const capacity of quick ? [2, 8] : [2, 4, 8, 16]) {
  for (const form of ['scan', 'sequential'] as const) {
    const build = buildKeyboardMatrixFocus(12, capacity, form)
    const evaluate = build.circuit.createTensorEvaluator(build.roots)
    const source = new Float32Array(build.layout.size)
    let frames = 0
    let framesWithKeys = 0
    let focusChanges = 0
    let mismatches = 0
    for (const [seed, rectangles] of [[41, testControlRectangles], [42, null], [43, null]] as const) {
      const trace = generateKeyboardTrace({seed, frames: quick ? 200 : 1000, capacity, rectangles, controlCount: 12})
      const oracle: KeyboardState = {focus: -1, pressedControl: -1}
      for (const frame of trace) {
        const keyEvents: QueuedEvent[] = frame.events.filter(event => event.kind === 'key' && event.key !== 'Enter' && event.key !== 'Space')
        frame.layout.rectangles.forEach((rectangle, index) => {
          source[build.left[index]!] = rectangle.left
          source[build.top[index]!] = rectangle.top
          source[build.width[index]!] = rectangle.width
          source[build.height[index]!] = rectangle.height
          source[build.enabled[index]!] = frame.layout.enabled[index]! ? 1 : 0
          source[build.focus[index]!] = oracle.focus === index ? 1 : 0
        })
        writeEventQueue(source, build.slots, keyEvents)
        const focusBefore = oracle.focus
        const activations = frame.layout.rectangles.map(() => 0)
        for (const event of keyEvents) keyboardOracleEvent(frame.layout, oracle, event, activations)
        if (keyEvents.length > 0) framesWithKeys++
        if (oracle.focus !== focusBefore) focusChanges++
        // Every output must be exactly 1 at the oracle's focus and exactly 0 elsewhere.
        const outputs = evaluate(source)
        if (Array.from(outputs).some((value, index) => value !== (index === oracle.focus ? 1 : 0))) mismatches++
        frames++
      }
    }
    const measure = measureProgram(build.circuit, build.roots)
    const label = form === 'scan' ? 'Sklansky scan of 13 x 13 matrices' : 'focus vector times each 13 x 13 matrix in sequence'
    console.log(row([label, capacity, measure.liveOperations, measure.layers, measure.weights, measure.widestLayer, measure.gatherReads, frames, framesWithKeys, focusChanges, mismatches]))
  }
}

// ---------------------------------------------------------------------------
console.log('\n## Menu bar: sizes\n')
console.log(header(['menus x item slots', 'queue capacity', 'live operations', 'layers', 'stored weights', 'widest layer', 'gather reads']))
for (const capacity of quick ? [1, 8] : [1, 2, 4, 8, 16]) {
  const machine = createMenuMachine(3, 5, capacity)
  console.log(measureRow('3 x 5', capacity, measureProgram(machine.circuit, machine.roots)))
}
{
  const machine = createMenuMachine(6, 8, 8)
  console.log(measureRow('6 x 8', 8, measureProgram(machine.circuit, machine.roots)))
}

console.log('\n## Menu bar: random traces against the oracle\n')
console.log(header(['menus x item slots', 'queue capacity', 'frames', 'events', 'activations', 'frames with an upward flip', 'frames with a right-aligned flip', 'frames with any state, activation, focus target, or placement mismatch', 'µs per frame (evaluations only)']))
{
  const capacity = 8
  const machine = createMenuMachine(3, 5, capacity)
  const evaluate = machine.circuit.createTensorEvaluator(machine.roots)
  let frames = 0
  let events = 0
  let activationTotal = 0
  let upwardFlipFrames = 0
  let rightAlignedFrames = 0
  let mismatches = 0
  const sources: Float32Array[] = []
  for (const seed of [51, 52, 53, 54, 55, 56]) {
    const trace = generateMenuTrace({seed, frames: quick ? 500 : 4000, capacity, menuCount: 3, itemSlots: 5})
    machine.reset(trace[0]!.layout)
    const oracle: MenuState = {open: -1, highlight: -1, titleFocus: -1}
    for (const frame of trace) {
      machine.writeLayout(frame.layout)
      const activations = frame.layout.menus.map(() => Array.from({length: 5}, () => 0))
      for (const event of frame.events) menuOracleEvent(frame.layout, oracle, event, activations)
      events += frame.events.length
      activationTotal += activations.flat().reduce((total, value) => total + value, 0)
      const flips = frame.layout.menus.map((_, index) => menuPlacementFlips(frame.layout, index))
      if (flips.some(flip => flip.up)) upwardFlipFrames++
      if (flips.some(flip => flip.left)) rightAlignedFrames++
      const placements = frame.layout.menus.map((_, index) => menuPlacement(frame.layout, index))
      writeEventQueue(machine.source, machine.slots, frame.events)
      if (sources.length < 4000) sources.push(new Float32Array(machine.source))
      const result = machine.step(frame.events)
      if (
        JSON.stringify(result.state) !== JSON.stringify(oracle)
        || JSON.stringify(result.activations) !== JSON.stringify(activations)
        || result.focusTarget !== menuOracleFocusTarget(frame.layout, oracle, 5)
        || JSON.stringify(result.placements) !== JSON.stringify(placements)
      ) mismatches++
      frames++
    }
  }
  console.log(row(['3 x 5', capacity, frames, events, activationTotal, upwardFlipFrames, rightAlignedFrames, mismatches, timeEvaluations(evaluate, sources, null).toFixed(1)]))
}

// ---------------------------------------------------------------------------
console.log('\n## Combined app (menu bar with 4 menus x 4 slots, 3 windows, 12 keys): sizes\n')
console.log(header(['form', 'queue capacity', 'live operations', 'layers', 'stored weights', 'widest layer', 'gather reads']))
for (const capacity of quick ? [1, 8] : [1, 2, 4, 8, 16]) {
  const machine = createAppMachine(capacity, {width: 1200, height: 760})
  console.log(measureRow('unrolled', capacity, measureProgram(machine.circuit, machine.roots)))
}

console.log('\n## Combined app: random mixed traces against the oracle\n')
console.log(header(['queue capacity', 'frames', 'pointer events', 'key events', 'frames with any mismatch', 'µs per frame (evaluations only)']))
{
  const capacity = 8
  const machine = createAppMachine(capacity, {width: 1200, height: 760})
  const evaluate = machine.circuit.createTensorEvaluator(machine.roots)
  let frames = 0
  let pointerEvents = 0
  let keyEvents = 0
  let mismatches = 0
  const sources: Float32Array[] = []
  for (const seed of [71, 72, 73]) {
    const trace = generateAppTrace({seed, frames: quick ? 500 : 4000, capacity})
    machine.reset(trace[0]!.viewport)
    const oracle = createAppState(trace[0]!.viewport)
    for (const frame of trace) {
      machine.writeViewport(frame.viewport)
      const expected = appOracleFrame(frame.viewport, oracle, frame.frameDelta, frame.events)
      pointerEvents += frame.events.filter(event => event.kind !== 'key').length
      keyEvents += frame.events.filter(event => event.kind === 'key').length
      machine.writeFrame(frame.frameDelta, frame.events)
      if (sources.length < 3000) sources.push(new Float32Array(machine.source))
      const actual = machine.step(frame.frameDelta, frame.events)
      if (JSON.stringify(actual.state) !== JSON.stringify(oracle) || JSON.stringify(actual.outputs) !== JSON.stringify(expected)) mismatches++
      frames++
    }
  }
  console.log(row([capacity, frames, pointerEvents, keyEvents, mismatches, timeEvaluations(evaluate, sources, null).toFixed(1)]))
}

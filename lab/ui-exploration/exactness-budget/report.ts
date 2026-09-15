// Heavy measurements: every UI trace through every mode, the drift trace behind
// IndirectOS's largest closed-loop difference, and life-calendar over 42 states.
// Merges the chosen sections into results.json. From the repo root:
//   bun lab/ui-exploration/exactness-budget/report.ts                  (everything, several minutes)
//   bun lab/ui-exploration/exactness-budget/report.ts gallery cards    (chosen sections)
// Sections: indirect-os, trace, gallery, hn, cards, typing, dock, life, gallery-settle, random-cpu,
// cards-booleans, dock-tie.
// Counts are exact; timings are rough because other agents share the machine.
import {writeFileSync} from 'node:fs'
import {instanceSourceTable, planInstances} from './copies/codegen/instance.ts'
import {buildRandomCircuit, createRandom, randomSource} from './copies/codegen/random-circuit.ts'
import {createWorkspace, evaluate, isOrderSensitive, modeDescriptions, perturbedModes, prepareModeProgram, type Mode} from './interpreter.ts'
import {lifeCalendarStates, runLifeCalendar} from './life-calendar-run.ts'
import {recordStored, runMode, runWorkload, traceDifference, type LoopCounts, type TraceStep, type Workload, type WorkloadResult} from './measure.ts'
import {cardsSourceCellName, cardsWorkload, dockRingWorkload, galleryOutputNames, galleryViewports, galleryWorkload, hnThreadWorkload, indirectOSWorkload, typingWorkload} from './workloads.ts'

const requested = process.argv.slice(2)
const wants = (section: string) => requested.length === 0 || requested.includes(section)
const resultsPath = new URL('./results.json', import.meta.url)
const existing = await Bun.file(resultsPath).exists() ? await Bun.file(resultsPath).json() as Record<string, unknown> : {}
const results: Record<string, unknown> = {...existing, modes: modeDescriptions}
const log = (line: string) => console.log(line)

function save() {
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 1)}\n`)
}

// One row per mode for a set of traces of the same UI: counts add up, maxima
// take the largest, and reference fields named like errors take the largest.
function combine(name: string, traces: readonly WorkloadResult[]) {
  const first = traces[0]!
  const isMaximum = (key: string) => /error|maximum|largest|worst/i.test(key)
  const mergeRecords = (records: readonly Record<string, number>[]) => {
    const merged: Record<string, number> = {}
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'number') continue
        merged[key] = isMaximum(key) ? Math.max(merged[key] ?? 0, value) : (merged[key] ?? 0) + value
      }
    }
    return merged
  }
  const mergeLoops = <T extends LoopCounts>(loops: readonly T[]): T => {
    const merged = {...loops[0]!, driftByName: {} as Record<string, number>}
    for (const [key, value] of Object.entries(loops[0]!)) {
      if (typeof value !== 'number') continue
      const values = loops.map(loop => (loop as unknown as Record<string, number>)[key]!)
      ;(merged as unknown as Record<string, number>)[key] = key === 'firstDivergenceFrame'
        ? Math.min(...values.filter(value => value >= 0), Infinity)
        : isMaximum(key) ? Math.max(...values) : values.reduce((total, value) => total + value, 0)
    }
    let worst = loops[0]!
    for (const loop of loops) {
      if (loop.maximumDrift > worst.maximumDrift) worst = loop
      for (const [driftName, value] of Object.entries(loop.driftByName)) merged.driftByName[driftName] = Math.max(merged.driftByName[driftName] ?? 0, value)
    }
    merged.maximumDriftWhere = worst.maximumDriftWhere
    return merged
  }
  return {
    name,
    traces: traces.map(trace => trace.description),
    calls: traces.reduce((total, trace) => total + trace.calls, 0),
    structure: first.structure,
    storedCheck: mergeRecords(traces.map(trace => trace.storedCheck)),
    reference: mergeRecords(traces.map(trace => trace.reference)),
    modes: first.modes.map((mode, index) => {
      const perTrace = traces.map(trace => trace.modes[index]!)
      return {
        mode: mode.mode,
        openLoop: mergeLoops(perTrace.map(entry => entry.openLoop)),
        closedLoop: {...mergeLoops(perTrace.map(entry => entry.closedLoop)), tracesWithDivergence: perTrace.filter(entry => entry.closedLoop.divergenceFrames > 0).length},
        reference: mergeRecords(perTrace.map(entry => 'error' in entry.reference ? {} : entry.reference)),
        errors: perTrace.flatMap(entry => 'error' in entry.reference ? [entry.reference.error] : []),
        milliseconds: perTrace.reduce((total, entry) => total + entry.milliseconds, 0),
      }
    }),
  }
}

function measure(section: string, workloads: readonly Workload[]) {
  const start = performance.now()
  const traces = workloads.map(workload => runWorkload(workload, perturbedModes, log))
  results[section] = combine(section, traces)
  log(`${section}: ${((performance.now() - start) / 1000).toFixed(1)} s`)
  save()
}

if (wants('indirect-os')) measure('indirect-os', [indirectOSWorkload()])

if (wants('trace')) {
  // Where IndirectOS's largest closed-loop difference comes from: reversed term
  // order, frame 164, Photos' stack order output.
  const workload = indirectOSWorkload()
  const instance = workload.create()
  const stored = recordStored(instance)
  const {modeProgram} = stored.recording
  const {packed} = modeProgram
  const workspace = createWorkspace(packed)
  const summarize = (step: TraceStep) => ({
    wire: step.wire, kind: step.kind, macro: step.macro, roundAffine: step.preserveRounding, bias: step.bias, gateBias: step.gateBias,
    mode: step.a, stored: step.b, difference: step.difference,
    largestInput: step.largestInput === null ? null : {side: step.largestInput.side, weight: step.largestInput.weight, mode: step.largestInput.a, stored: step.largestInput.b},
    terms: step.terms,
    gateTerms: step.gateTerms,
  })
  const traces: Record<string, unknown> = {}
  const nextSourcePositions = (instance.nextSource ?? []).map(([cell, nextWire]) => [cell, packed.flat.positionOfWire[nextWire]!] as const)
  for (const [mode, frame] of [['reversed', 164], ['balanced', 148]] as [Mode, number][]) {
    let wire = -1
    // How each source cell differs from the stored run, per frame, closed loop.
    const stateDifferences: Float32Array[] = []
    // The latest earlier frame whose state still matched the stored run while its
    // next-source outputs didn't, i.e. where the state difference seen at the
    // traced frame last started.
    let lastMatchingState: Record<string, unknown> | null = null
    runMode(workload, stored.recording, mode, {
      onCall: context => {
        stateDifferences.push(Float32Array.from(context.modeSource, (value, cell) => value - context.storedSource[cell]!))
        if (context.frame < frame && context.modeSource.every((value, cell) => value === context.storedSource[cell])) {
          const differing = nextSourcePositions.filter(([, position]) => Math.fround(context.modeValues[position]!) !== context.storedValues[position])
          if (differing.length > 0) {
            const difference = (position: number) => Math.abs(context.modeValues[position]! - context.storedValues[position]!)
            let largest = differing[0]!
            for (const candidate of differing) if (difference(candidate[1]) > difference(largest[1])) largest = candidate
            const trace = traceDifference(instance.circuit, modeProgram, context.modeValues, context.storedValues, largest[1])
            lastMatchingState = {
              frame: context.frame,
              cellsDiffering: differing.map(([cell]) => cell),
              largestCell: largest[0],
              modeValue: context.modeValues[largest[1]],
              storedValue: context.storedValues[largest[1]],
              endsAtSourceCell: trace.endsAtSourceCell,
              steps: trace.steps.map(summarize),
            }
          }
        }
        if (context.frame !== frame) return
        // The output with the largest closed-loop difference in this frame.
        let position = -1
        let largest = 0
        for (const group of instance.drift) {
          for (const candidate of group.wires) {
            const packedPosition = packed.flat.positionOfWire[candidate]!
            const difference = Math.abs(Math.fround(context.modeValues[packedPosition]!) - context.storedValues[packedPosition]!)
            if (difference > largest) {
              largest = difference
              position = packedPosition
              wire = candidate
            }
          }
        }
        const storedOnModeState = new Float64Array(evaluate(packed, modeProgram.rules.stored, context.modeSource, workspace))
        const frameTrace = traceDifference(instance.circuit, modeProgram, context.modeValues, storedOnModeState, position)
        const stateTrace = traceDifference(instance.circuit, modeProgram, storedOnModeState, context.storedValues, position)
        const openTrace = traceDifference(instance.circuit, modeProgram, context.openValues, context.storedValues, position)
        traces[`${mode} frame ${frame}`] = {
          wire,
          modeValue: context.modeValues[position],
          storedValue: context.storedValues[position],
          openLoopValue: context.openValues[position],
          storedArithmeticOnModeState: storedOnModeState[position],
          largestContinuousStateDrift: Math.max(...Array.from(context.modeSource, (value, cell) => Math.abs(value - context.storedSource[cell]!))),
          thisFrameArithmetic: {endsAtSourceCell: frameTrace.endsAtSourceCell, steps: frameTrace.steps.map(summarize)},
          stateDifference: {endsAtSourceCell: stateTrace.endsAtSourceCell, steps: stateTrace.steps.map(summarize)},
          openLoop: {endsAtSourceCell: openTrace.endsAtSourceCell, steps: openTrace.steps.map(summarize)},
        }
      },
    })
    // Follow the source cell where the state-difference trace ended back across
    // frames: when it first differed, and how the difference grew until the traced frame.
    const entry = traces[`${mode} frame ${frame}`] as Record<string, unknown> & {stateDifference: {endsAtSourceCell: number}}
    const cell = entry.stateDifference.endsAtSourceCell
    if (cell >= 0) {
      const differences = stateDifferences.map(table => table[cell]!)
      const firstFrameDiffering = differences.findIndex(value => value !== 0)
      entry['stateCellHistory'] = {
        cell,
        firstFrameDiffering,
        // [frame, mode state minus stored state], every 4 frames and at the traced frame.
        differenceByFrame: differences.flatMap((value, index) => firstFrameDiffering >= 0 && index >= firstFrameDiffering && index <= frame && ((index - firstFrameDiffering) % 4 === 0 || index === frame) ? [[index, value]] : []),
      }
    }
    entry['lastFrameWithMatchingState'] = lastMatchingState
    log(`traced ${mode} frame ${frame}, wire ${wire}`)
  }
  results['trace'] = traces
  save()
}

if (wants('gallery')) measure('gallery', galleryViewports.map((_, index) => galleryWorkload(index, 600)))
if (wants('hn')) measure('hn', [hnThreadWorkload(251, 900)])
if (wants('cards')) {
  measure('cards-20', Array.from({length: 20}, (_, index) => cardsWorkload(index + 1, 20, 600)))
  measure('cards-100', Array.from({length: 10}, (_, index) => cardsWorkload(index + 1, 100, 600)))
}
if (wants('typing')) measure('typing', [typingWorkload(256, 1500)])
if (wants('dock')) measure('dock', [dockRingWorkload(20_000)])

if (wants('life')) {
  const start = performance.now()
  results['life'] = runLifeCalendar(lifeCalendarStates(6), perturbedModes)
  log(`life: ${((performance.now() - start) / 1000).toFixed(1)} s`)
  save()
}

if (wants('gallery-settle')) {
  // Which gallery decision outputs flip, by name, on trace 5001 (the trace whose
  // closed loop diverged), and the chain behind the first flip.
  const workload = galleryWorkload(1, 600)
  const instance = workload.create()
  const names = galleryOutputNames()
  const stored = recordStored(instance)
  const {modeProgram, classification} = stored.recording
  const {packed, points} = modeProgram
  const settle: Record<string, unknown> = {}
  for (const mode of ['balancedFused', 'float64RoundingStrict'] as Mode[]) {
    const flipCounts: Record<string, number> = {}
    const closedFlips: string[] = []
    let firstChain: unknown = null
    const count = (key: string) => { flipCounts[key] = (flipCounts[key] ?? 0) + 1 }
    runMode(workload, stored.recording, mode, {
      onCall: ({frame, modeValues, storedValues, openValues, modeSource, storedSource}) => {
        for (const position of classification.decisionPositions) {
          const name = (names.get(packed.flat.wireOrder[position]!) ?? 'unnamed').replace(/photo \d+/, 'photo i')
          if (Math.fround(openValues[position]!) !== storedValues[position]) {
            count(`open loop: ${name}`)
            if (firstChain === null) {
              const trace = traceDifference(instance.circuit, modeProgram, openValues, storedValues, position)
              firstChain = trace.steps.slice(0, 14).map(step => ({
                name: names.get(step.wire) ?? '', kind: step.kind, macro: step.macro, roundAffine: step.preserveRounding,
                roundingPoint: points.isRoundingPoint[packed.rowOfPosition[step.position]!], bias: step.bias, gateBias: step.gateBias,
                mode: step.a, stored: step.b, terms: step.terms.slice(0, 8), gateTerms: step.gateTerms.slice(0, 8),
              }))
            }
          }
          if (Math.fround(modeValues[position]!) !== storedValues[position]) {
            count(`closed loop: ${name}`)
            if (closedFlips.length < 16) closedFlips.push(`frame ${frame} ${names.get(packed.flat.wireOrder[position]!)}: stored ${storedValues[position]}, mode ${modeValues[position]}`)
          }
        }
        for (const cell of classification.integerSourceCells) {
          if (modeSource[cell] !== storedSource[cell]) count(`closed loop: integer state cell ${cell}`)
        }
      },
    })
    // Which kinds of always-bit rows flip open loop, and whether they are rounding points.
    settle[mode] = {flipCounts, closedFlips, firstChain}
    log(`gallery-settle ${mode}: ${JSON.stringify(flipCounts)}`)
  }
  const bitRowShapes: Record<string, number> = {}
  const shortWorkload = galleryWorkload(0, 120)
  const shortRecording = recordStored(shortWorkload.create()).recording
  runMode(shortWorkload, shortRecording, 'roundingStrict', {
    onCall: ({openValues, storedValues}) => {
      for (const row of shortRecording.classification.bitRows) {
        const position = packed.position[row]!
        if (Math.fround(openValues[position]!) === storedValues[position]) continue
        const wire = packed.flat.wireOrder[position]!
        const operation = instance.circuit.operations[wire - instance.circuit.sourceSize]!
        const key = `${operation.kind}${operation.preserveRounding ? ' roundAffine' : ''}, ${operation.gateTerms.length} gate terms, gate bias ${operation.gateBias}, rounding point ${points.isRoundingPoint[row]}`
        bitRowShapes[key] = (bitRowShapes[key] ?? 0) + 1
      }
    },
  })
  settle['roundingStrict bit rows that flip, trace 5000, 120 frames'] = bitRowShapes
  results['gallery-settle'] = settle
  save()
}

if (wants('random-cpu')) {
  // codegen's 12 random circuits replayed on the CPU. Decision outputs are counted
  // two ways: outputs that are always exactly 0 or 1, and outputs that are always
  // integers, which also catches products past 2^24, where every FP32 value is an integer.
  const cellSets = [[4, 5], [0, 1, 2, 3], [0, 1, 2, 3, 7, 9], [8, 11]]
  const circuits: Record<string, unknown>[] = []
  for (let seed = 1; seed <= 12; seed++) {
    const {circuit, sources, all} = buildRandomCircuit(seed)
    const program = circuit.compileTensorProgram()
    const instanceCells = cellSets[seed % cellSets.length]!
    const plan = planInstances(program, instanceCells, all.filter(wire => wire >= circuit.sourceSize))
    const random = createRandom(seed * 31)
    const count = 256
    const instanceSources = new Float32Array(count * instanceCells.length)
    for (let instance = 0; instance < count; instance++) {
      const other = randomSource(random, true)
      instanceCells.forEach((cell, column) => { instanceSources[instance * instanceCells.length + column] = other[cell]! })
    }
    const modeProgram = prepareModeProgram(circuit, program)
    const {packed} = modeProgram
    const storedWorkspace = createWorkspace(packed)
    const modeWorkspace = createWorkspace(packed)
    const tables: Float32Array[] = []
    for (let instance = 0; instance < count; instance++) {
      const table = instanceSourceTable(plan, sources[0]!, instanceSources, instance)
      const reference = circuit.evaluateReference(table)
      if (!Array.from(program.wireOrder, wire => reference[wire]!).some(value => !Number.isFinite(value))) tables.push(table)
    }
    const bit = new Uint8Array(plan.outputs.length).fill(1)
    const integer = new Uint8Array(plan.outputs.length).fill(1)
    for (const table of tables) {
      const values = evaluate(packed, modeProgram.rules.stored, table, storedWorkspace)
      plan.outputs.forEach((position, index) => {
        if (values[position] !== 0 && values[position] !== 1) bit[index] = 0
        if (!Number.isInteger(values[position]!)) integer[index] = 0
      })
    }
    const entry: Record<string, unknown> = {
      seed, instances: tables.length, bitOutputs: bit.reduce((total, value) => total + value, 0), integerOutputs: integer.reduce((total, value) => total + value, 0),
      rows: packed.rowCount, roundingPointRows: modeProgram.points.roundingPointRows,
      orderSensitiveRoundingPoints: Array.from({length: packed.rowCount}, (_, row) => row).filter(row => modeProgram.points.isRoundingPoint[row] === 1 && isOrderSensitive(packed, row)).length,
    }
    for (const mode of perturbedModes) {
      let bitFlips = 0
      let integerFlips = 0
      for (const table of tables) {
        const stored = new Float64Array(evaluate(packed, modeProgram.rules.stored, table, storedWorkspace))
        const values = evaluate(packed, modeProgram.rules[mode], table, modeWorkspace)
        plan.outputs.forEach((position, index) => {
          if (Math.fround(values[position]!) === stored[position]) return
          if (bit[index] === 1) bitFlips++
          if (integer[index] === 1) integerFlips++
        })
      }
      entry[mode] = {bitFlips, integerFlips}
    }
    circuits.push(entry)
    log(`random-cpu seed ${seed}: ${JSON.stringify(entry)}`)
  }
  results['random-cpu'] = circuits
  save()
}

if (wants('cards-booleans')) {
  // Which boolean atoms flip in cards under fused order, closed loop (the cards
  // tables count 2 at 20 cards and 2 at 100 cards), and the construction behind each flip.
  const traces: Record<string, unknown>[] = []
  const events: Record<string, unknown>[] = []
  for (const [seedCount, cardCount] of [[20, 20], [10, 100]] as const) {
    for (let seed = 1; seed <= seedCount; seed++) {
      const workload = cardsWorkload(seed, cardCount, 600)
      const instance = workload.create()
      const stored = recordStored(instance)
      const {classification, modeProgram} = stored.recording
      const {packed, points} = modeProgram
      const result = runMode(workload, stored.recording, 'fused', {
        onCall: ({frame, modeValues, storedValues, modeSource, storedSource}) => {
          for (const row of classification.booleanRows) {
            const position = packed.position[row]!
            if (Math.fround(modeValues[position]!) === storedValues[position]) continue
            const trace = traceDifference(instance.circuit, modeProgram, modeValues, storedValues, position)
            events.push({
              cardCount, seed, frame,
              roundingPoint: points.isRoundingPoint[row],
              mode: modeValues[position],
              stored: storedValues[position],
              largestStateDifference: Math.max(...Array.from(modeSource, (value, cell) => Math.abs(value - storedSource[cell]!))),
              endsAtSourceCell: trace.endsAtSourceCell,
              endsAtSourceCellName: trace.endsAtSourceCell >= 0 ? cardsSourceCellName(cardCount, trace.endsAtSourceCell) : '',
              // From the boolean atom back: its clamp, the score 256 · difference + 0.5, the difference, and so on.
              steps: trace.steps.map(step => ({
                kind: step.kind, macro: step.macro, roundAffine: step.preserveRounding, bias: step.bias, gateBias: step.gateBias,
                mode: step.a, stored: step.b, terms: step.terms.slice(0, 6), gateTerms: step.gateTerms.slice(0, 6),
              })),
            })
          }
        },
      })
      if (result.openLoop.booleanFlips > 0 || result.closedLoop.booleanFlips > 0) {
        traces.push({
          cardCount, seed,
          openLoopBooleanFlips: result.openLoop.booleanFlips,
          closedLoopBooleanFlips: result.closedLoop.booleanFlips,
          closedLoopBitRowFlips: result.closedLoop.bitRowFlips,
          closedLoopDecisionOutputFlips: result.closedLoop.decisionOutputFlips,
          divergenceFrames: result.closedLoop.divergenceFrames,
          reference: result.reference,
        })
      }
      log(`cards-booleans ${cardCount} cards seed ${seed}: closed loop boolean flips ${result.closedLoop.booleanFlips}`)
    }
  }
  results['cards-booleans'] = {mode: 'fused', traces, events}
  save()
}

if (wants('dock-tie')) {
  // Where the dock's bit-row and gather-index flips under fused order start. For
  // each evaluation with a flip, the first flipped bit row is traced back to the
  // row whose inputs match the stored run while its result doesn't, and endings
  // are counted by row shape and the stored value of the row's runtime input.
  const workload = dockRingWorkload(20_000)
  const instance = workload.create()
  const stored = recordStored(instance)
  const {modeProgram, sources, classification} = stored.recording
  const {packed, rules, points} = modeProgram
  const storedWorkspace = createWorkspace(packed)
  const modeWorkspace = createWorkspace(packed)
  const section: Record<string, unknown> = {}
  for (const mode of ['fused', 'balancedFused'] as Mode[]) {
    let evaluationsWithFlips = 0
    let bitRowFlips = 0
    let gatherIndexFlips = 0
    const endings: Record<string, {evaluations: number, inputs: Record<string, number>}> = {}
    for (let call = 0; call < sources.length; call++) {
      const storedValues = new Float64Array(evaluate(packed, rules.stored, sources[call]!, storedWorkspace))
      const modeValues = evaluate(packed, rules[mode], sources[call]!, modeWorkspace)
      let firstFlipped = -1
      let flips = 0
      for (const row of classification.bitRows) {
        const position = packed.position[row]!
        if (Math.fround(modeValues[position]!) === storedValues[position]) continue
        bitRowFlips++
        flips++
        if (firstFlipped < 0) firstFlipped = position
      }
      for (let slot = 0; slot < packed.gatherSlotCount; slot++) {
        if (modeWorkspace.gatherIndex[slot] !== storedWorkspace.gatherIndex[slot]) {
          gatherIndexFlips++
          flips++
        }
      }
      if (flips === 0) continue
      evaluationsWithFlips++
      let key = 'gather index flips only'
      let input = ''
      if (firstFlipped >= 0) {
        const trace = traceDifference(instance.circuit, modeProgram, modeValues, storedValues, firstFlipped)
        const last = trace.steps.at(-1)!
        key = trace.endsAtSourceCell >= 0
          ? `source cell ${trace.endsAtSourceCell}`
          : `${last.kind}${last.preserveRounding ? ' roundAffine' : ''}, bias ${last.bias}, weights ${last.terms.map(term => term.weight).join(' ')}, rounding point ${points.isRoundingPoint[packed.rowOfPosition[last.position]!]}`
        // The quadrant shift reads an angle, so its input is also written as a multiple of π.
        if (last.terms.length === 1) input = last.bias === 2 ** 23 + 2 ** 22 ? `${last.terms[0]!.b} (${(last.terms[0]!.b / Math.PI).toFixed(6)}π)` : `${last.terms[0]!.b}`
      }
      const entry = endings[key] ??= {evaluations: 0, inputs: {}}
      entry.evaluations++
      if (input !== '') entry.inputs[input] = (entry.inputs[input] ?? 0) + 1
    }
    section[mode] = {evaluationsWithFlips, bitRowFlips, gatherIndexFlips, endings}
    log(`dock-tie ${mode}: ${JSON.stringify(section[mode])}`)
  }
  results['dock-tie'] = section
  save()
}

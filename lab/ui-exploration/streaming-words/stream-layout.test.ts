import {expect, test} from 'bun:test'
import {lineFitEpsilon, loadPretext, makeParagraph} from '../text-walker/fake-canvas.ts'
import {indexReadRuntime} from './kit.ts'
import {buildStreamCircuit, defaultFlowLayout, type LineCountMode, type StreamBuild} from './stream-circuit.ts'
import {chunkEvents, layoutFlow, layoutMismatches, lineCountOf, referenceLayout, segmentCountOf, windowForTurns, writeFlowState, type ChunkMode, type Turn} from './stream-model.ts'

const pretext = await loadPretext()
const font = '16px Test Sans'
const maxWidth = 240
const columnWidth = 320
const rightAlignedTurns = (turn: number) => turn % 2 === 1

function buildFor(turns: readonly Turn[], turnCapacity: number, lineCountMode: LineCountMode, lineSlots?: number): StreamBuild {
  const texts = turns.map(turn => turn.text)
  return buildStreamCircuit({
    capacity: segmentCountOf(pretext, font, texts),
    window: windowForTurns(pretext, font, texts, 320, lineFitEpsilon),
    lineSlots: lineSlots ?? lineCountOf(pretext, font, texts, 160) + 1,
    epsilon: lineFitEpsilon,
    lineCountMode,
    turnCapacity,
    rightAlignedTurns,
    layout: defaultFlowLayout,
    bubbles: true,
    springs: null,
    ...(lineCountMode === 'index-read' ? {runtime: indexReadRuntime({lowerIndexOneHots: false, inferBitFamilies: false, recomputeDepths: false})} : {}),
  })
}

// Streams the turns chunk by chunk, compares every state with pretext, and returns the problems plus
// the global outputs and per-segment geometry of every state.
function streamAndCompare(build: StreamBuild, turns: readonly Turn[]) {
  const table = build.initialTable()
  table[build.cells.maxWidth] = maxWidth
  table[build.cells.columnWidth] = columnWidth
  const prefixLengths = turns.map(() => 0)
  const failures: unknown[] = []
  const trace: number[][] = []
  let states = 0
  for (const event of chunkEvents(turns)) {
    prefixLengths[event.turn] = event.end
    const state = layoutFlow(pretext, font, turns, prefixLengths, maxWidth)
    writeFlowState(build, table, state)
    const expected = referenceLayout(state, {layout: defaultFlowLayout, columnWidth, turnCapacity: build.options.turnCapacity, rightAlignedTurns})
    const problems = layoutMismatches(build, table, state, expected)
    if (problems.length > 0) failures.push({state: states, arrived: state.arrivedCount, problems: problems.slice(0, 3)})
    const outputs = build.outputs(build.compiled.evaluate(table))
    trace.push([outputs.lineCount, outputs.windowOverflow, outputs.moreLinesThanSlots, ...Array.from(outputs.lineIndex.subarray(0, state.arrivedCount)), ...Array.from(outputs.x.subarray(0, state.arrivedCount))])
    states++
  }
  return {failures, trace, states}
}

test('a 48-word reply streamed in 1-character, 3-character and word chunks matches pretext on every prefix', () => {
  const text = makeParagraph(48, 7)
  const build = buildFor([{text, mode: 3}], 1, 'count')
  expect(build.options.capacity).toBe(95)
  const statesByMode: Record<string, number> = {}
  for (const mode of [1, 3, 'word'] as ChunkMode[]) {
    const turns = [{text, mode}]
    const {failures, states} = streamAndCompare(build, turns)
    expect({mode, failures}).toEqual({mode, failures: []})
    statesByMode[String(mode)] = states
  }
  // Character chunks: one state per character of the paragraph; word chunks: one per word.
  expect(statesByMode).toEqual({'1': text.length, '3': Math.ceil(text.length / 3), 'word': 48})
})

test('lineCount through a one-hot masked read, an index read, and a count of line starts agree bit for bit', () => {
  const turns = [{text: makeParagraph(48, 7), mode: 3 as const}]
  const traces = (['count', 'one-hot', 'index-read'] as const).map(mode => {
    const build = buildFor(turns, 1, mode)
    const {failures, trace} = streamAndCompare(build, turns)
    expect({mode, failures}).toEqual({mode, failures: []})
    return {mode, indexReads: build.compiled.size.indexReads, trace}
  })
  expect(traces.map(entry => entry.indexReads)).toEqual([0, 0, 1])
  expect(traces[1]!.trace).toEqual(traces[0]!.trace)
  expect(traces[2]!.trace).toEqual(traces[0]!.trace)
})

test('a conversation of four turns gets a forced break at every turn and bubbles that match pretext', () => {
  const turns: Turn[] = [
    {text: makeParagraph(10, 11), mode: 'word'},
    {text: makeParagraph(14, 12), mode: 3},
    {text: makeParagraph(6, 13), mode: 'word'},
    {text: makeParagraph(18, 14), mode: 1},
  ]
  const build = buildFor(turns, 4, 'count')
  const {failures, states} = streamAndCompare(build, turns)
  expect(failures).toEqual([])
  expect(states).toBe(chunkEvents(turns).length)
})

test('bounds chosen at build time are reported at the arrived count', () => {
  const text = makeParagraph(48, 7)
  const turns = [{text, mode: 'word' as const}]
  // 5 line slots, where the whole reply takes 9 lines at 240 px.
  const build = buildFor(turns, 1, 'count', 5)
  const table = build.initialTable()
  table[build.cells.maxWidth] = maxWidth
  table[build.cells.columnWidth] = columnWidth
  const words = text.split(' ')
  const moreLinesAt = (wordCount: number) => {
    const state = layoutFlow(pretext, font, turns, [words.slice(0, wordCount).join(' ').length], maxWidth)
    writeFlowState(build, table, state)
    const outputs = build.outputs(build.compiled.evaluate(table))
    return {lines: state.turns[0]!.lineStarts.length, moreLinesThanSlots: outputs.moreLinesThanSlots}
  }
  expect(moreLinesAt(48)).toEqual({lines: 9, moreLinesThanSlots: 1})
  expect(moreLinesAt(20)).toEqual({lines: 4, moreLinesThanSlots: 0})

  // Three turns written into a circuit built for two.
  const conversation: Turn[] = [{text: 'hello there', mode: 'word'}, {text: 'hi', mode: 'word'}, {text: 'how are you', mode: 'word'}]
  const small = buildStreamCircuit({...buildFor(conversation, 3, 'count').options, turnCapacity: 2})
  const smallTable = small.initialTable()
  smallTable[small.cells.maxWidth] = maxWidth
  smallTable[small.cells.columnWidth] = columnWidth
  writeFlowState(small, smallTable, layoutFlow(pretext, font, conversation, [11, 2, 11], maxWidth))
  expect(small.outputs(small.compiled.evaluate(smallTable)).turnOverflow).toBe(1)
  writeFlowState(small, smallTable, layoutFlow(pretext, font, conversation, [11, 2, 0], maxWidth))
  expect(small.outputs(small.compiled.evaluate(smallTable)).turnOverflow).toBe(0)
})

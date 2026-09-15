// Replies and conversations for the tests and the report, and a build helper that sizes a circuit's
// bounds from the texts it will stream.
import {lineFitEpsilon, makeParagraph} from '../text-walker/fake-canvas.ts'
import {buildStreamCircuit, defaultFlowLayout, type StreamBuild, type StreamBuildOptions} from './stream-circuit.ts'
import {lineCountOf, segmentCountOf, windowForTurns, type ChunkMode, type Turn} from './stream-model.ts'

type Pretext = typeof import('../text-walker/pretext-src/layout.ts')

export const testFont = '16px Test Sans'
// Every build covers widths from narrowestWidth to widestWidth.
export const narrowestWidth = 160
export const widestWidth = 320

export function replyTurns(wordCount: number, mode: ChunkMode): Turn[] {
  return [{text: makeParagraph(wordCount, 7), mode}]
}

// Word counts per turn, alternating two speakers.
const conversationShapes: Record<number, number[]> = {
  48: [10, 14, 6, 18],
  96: [8, 16, 5, 19, 10, 14, 6, 18],
}

export function conversationTurns(wordCount: number, mode: ChunkMode): Turn[] {
  const shape = conversationShapes[wordCount]
  if (shape === undefined) throw new Error(`no conversation shape for ${wordCount} words`)
  return shape.map((words, turn) => ({text: makeParagraph(words, 11 + turn), mode}))
}

// Odd turns sit on the right, like the other speaker in a chat.
export const rightAlignedTurns = (turn: number) => turn % 2 === 1

export function buildForTurns(
  pretext: Pretext,
  turns: readonly Turn[],
  options: Pick<StreamBuildOptions, 'lineCountMode' | 'turnCapacity' | 'bubbles' | 'springs'> & Partial<StreamBuildOptions>,
): StreamBuild {
  const texts = turns.map(turn => turn.text)
  return buildStreamCircuit({
    capacity: segmentCountOf(pretext, testFont, texts),
    window: windowForTurns(pretext, testFont, texts, widestWidth, lineFitEpsilon),
    lineSlots: lineCountOf(pretext, testFont, texts, narrowestWidth) + 1,
    epsilon: lineFitEpsilon,
    rightAlignedTurns,
    layout: defaultFlowLayout,
    ...options,
  })
}

// Row texts for the text rows list, and each row's width breakpoints from pretext.
//
// A row is a paragraph of plain text laid out like an hn-thread comment at indent 0: 12px Verdana on 14px lines, with
// 24 px of space on the left and 20 px on the right, plus 8 px above and below the text. Its height only changes at a
// few container widths. JavaScript prepares each text with pretext once, finds every whole-pixel container width where
// the row's height changes, and writes those widths into the row's cells (text-rows.ts). The program never runs
// pretext: it counts how many of a row's breakpoints the runtime container width reaches.
import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import {commentLineHeight, commentTextHeight, commentWidthAt, prepareComment, tabulateStaircase, type PreparedComment} from '../hn-thread/text-heights.ts'
import {createRandom} from './common.ts'

export const textRowLayout = {
  // The container widths that tabulateTextRow passes to text-heights.ts's tabulateStaircase, the same as hn-thread's
  // container widths today. The host clamps a narrower container to the minimum.
  minimumContainerWidth: 375,
  maximumContainerWidth: 1200,
  lineHeight: commentLineHeight,
  // 8 px above and 8 px below the text.
  verticalPadding: 16,
  // A row taller than this at the widest container width can't be added.
  maximumRowHeight: 256,
} as const

// No container width reaches this breakpoint, so it fills a row's unused breakpoint cells.
export const unusedBreakpoint = textRowLayout.maximumContainerWidth + 1

// What JavaScript writes into one row's cells.
export type TextRowTable = {
  // The row's height at its minimum width, the tallest height its table gives.
  baseHeight: number
  // The row is laid out at Math.max(containerWidth, minimumWidth), like a CSS min-width. It's the narrowest container
  // width, e.g. 375 px, unless the row loses more lines than its breakpoint cells can hold as the container widens.
  minimumWidth: number
  // Sorted whole-pixel container widths, one per line the row loses as the container gets wider, e.g. [512, 512, 900]
  // for a row that loses 2 lines at 512 px and 1 more at 900 px, padded with unusedBreakpoint.
  breakpoints: number[]
}

export type PreparedText = PreparedComment

export function prepareText(text: string): PreparedText {
  invariant(text.trim() !== '', 'a text row needs some text')
  return prepareComment({blocks: [{kind: 'paragraph', runs: [{kind: 'text', text}]}]})
}

// pretext's height of the row at a container width, including the padding.
export function textRowHeight(prepared: PreparedText, containerWidth: number) {
  return commentTextHeight(prepared, commentWidthAt(containerWidth, 0)) + textRowLayout.verticalPadding
}

// The row's breakpoints, found with text-heights.ts's tabulateStaircase over textRowLayout's container widths. The host only
// writes whole-pixel widths, so the staircase samples pretext at the floor of each width it asks for: every change then
// lands on a whole pixel, and each breakpoint is the smallest whole-pixel width where the new height holds. A text
// whose line count changes more times than breakpointCapacity keeps the changes at the widest widths, and gets the
// minimum width where the first change it can't keep happens.
export function tabulateTextRow(prepared: PreparedText, breakpointCapacity: number, sampleStep = 16): TextRowTable {
  const {minimumContainerWidth, maximumContainerWidth, lineHeight, maximumRowHeight} = textRowLayout
  const staircase = tabulateStaircase(containerWidth => textRowHeight(prepared, Math.floor(containerWidth)), sampleStep, {minimumContainerWidth, maximumContainerWidth})
  // Where the height changes and by how many lines, from the narrowest width up.
  const changes: {width: number, lines: number}[] = []
  let widestHeight = staircase.baseHeight
  for (const step of staircase.steps) {
    invariant(step.delta < 0 && step.delta % lineHeight === 0, `a text row's height must only shrink, by whole lines, as the container widens, got ${step.delta} px at ${step.containerWidth} px`)
    const width = Math.floor(step.containerWidth)
    const previous = changes[changes.length - 1]
    if (previous?.width === width) previous.lines += -step.delta / lineHeight
    else changes.push({width, lines: -step.delta / lineHeight})
    widestHeight += step.delta
  }
  invariant(widestHeight <= maximumRowHeight, `a text row must be at most ${maximumRowHeight} px tall at ${maximumContainerWidth} px, got ${widestHeight} px`)
  // Keep whole changes from the widest width down, while their lines fit the breakpoint cells and the height stays within
  // the maximum.
  let keptChanges = 0
  let keptLines = 0
  let minimumWidth: number = minimumContainerWidth
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index]!
    if (keptLines + change.lines > breakpointCapacity || widestHeight + (keptLines + change.lines) * lineHeight > maximumRowHeight) {
      minimumWidth = change.width
      break
    }
    keptChanges++
    keptLines += change.lines
  }
  const breakpoints = changes.slice(changes.length - keptChanges).flatMap(change => Array<number>(change.lines).fill(change.width))
  while (breakpoints.length < breakpointCapacity) breakpoints.push(unusedBreakpoint)
  return {baseHeight: widestHeight + keptLines * lineHeight, minimumWidth, breakpoints}
}

const shortWords = 'ok yes no sure thanks nice wait what why how when where who that this it is was be are we you they I me my your our the a an to of in on at for with and but or so if then now just still again soon later today tomorrow tonight here there maybe really very pretty good bad fine lunch coffee call meeting train home work'.split(' ')
// The last word is a SHA-256 hash, 64 characters with no break opportunity, wider than a line at narrow widths, so
// both pretext and the browser break it inside the word. An earlier URL word with hyphens and slashes was broken
// differently by Chrome and pretext, see the README's browser check.
const longWords = ['honestly', 'definitely', 'apparently', 'meanwhile', 'screenshot', 'deployment', 'notification', 'configuration', 'internationalization', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']

// A chat message of varied length for row `index`, the same text for the same index: 60% have 1 to 12 words, 35% have
// 12 to 59, and 5% have 60 to 219, the rows that lose the most lines as the container narrows.
export function generateMessage(index: number): string {
  const random = createRandom(index * 7919 + 13)
  const kind = random()
  const wordCount = kind < 0.6 ? 1 + Math.floor(random() * 12) : kind < 0.95 ? 12 + Math.floor(random() * 48) : 60 + Math.floor(random() * 160)
  const words = Array.from({length: wordCount}, () => random() < 0.1 ? longWords[Math.floor(random() * longWords.length)]! : shortWords[Math.floor(random() * shortWords.length)]!)
  const sentence = words.join(' ')
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}${['.', '?', '!', ''][Math.floor(random() * 4)]}`
}

// pretext's prepare for every text, then every row's breakpoints, timed separately.
export function prepareTextRows(texts: readonly string[], breakpointCapacity: number) {
  const prepareStart = performance.now()
  const prepared = texts.map(prepareText)
  const prepareMilliseconds = performance.now() - prepareStart
  const tabulateStart = performance.now()
  const tables = prepared.map(row => tabulateTextRow(row, breakpointCapacity))
  const tabulateMilliseconds = performance.now() - tabulateStart
  return {prepared, tables, prepareMilliseconds, tabulateMilliseconds}
}

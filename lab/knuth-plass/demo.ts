// The page: pretext's greedy breaks and the program's Knuth-Plass breaks for the paragraphs of pretext's justification
// demo, side by side. In each frame where the width changed, JavaScript writes each paragraph's cells and evaluates the
// program once per paragraph. Query parameters: ?form=tree&window=16, and ?check=1 compares every evaluation with
// reference.ts and counts differences in window.knuthPlassMismatches.
import {type LayoutCursor, type LayoutLineRange, type PreparedTextWithSegments, layoutNextLineRange, materializeLineRange, prepareWithSegments} from '@chenglou/pretext'
import {FONT, PARAGRAPHS} from '../../node_modules/@chenglou/pretext/pages/demos/justification-comparison.data.ts'
import {createEvaluator} from '../../src/runtime/cells.ts'
import {hyphenateParagraphText} from './hyphenation.ts'
import {type BreakCandidate, type Paragraph, breakPointsOfPrepared, naturalWidth, slackLimit, softHyphen} from './paragraph.ts'
import {type ProgramForm, buildKnuthPlass, solutionOf, writeParagraph} from './program.ts'
import {knuthPlass} from './reference.ts'

// longestLine: the most boxes on one of the program's lines in this frame.
export type FrameTiming = {width: number, evaluateMs: number, greedyMs: number, domMs: number, longestLine: number, windowOverflow: boolean}

declare global {
  interface Window {
    knuthPlassReady?: boolean
    knuthPlassFrames?: FrameTiming[]
    knuthPlassMismatches?: number
    knuthPlassRender?: (width: number) => void
  }
}

const params = new URLSearchParams(location.search)
const form: ProgramForm = params.get('form') === 'tree' ? 'tree' : 'chain'
const requestedWindow = Number(params.get('window'))
// At 600 px, the program's lines of the demo's paragraphs hold up to 28 boxes.
const lineWindow = Number.isInteger(requestedWindow) && requestedWindow >= 2 && requestedWindow <= 64 ? requestedWindow : 32
const breakCapacity = 144
const check = params.get('check') === '1'

const widthInput = document.querySelector<HTMLInputElement>('#width')!
const widthValue = document.querySelector<HTMLElement>('#width-value')!
const formSelect = document.querySelector<HTMLSelectElement>('#form')!
const statusLine = document.querySelector<HTMLElement>('#status')!
const warningLine = document.querySelector<HTMLElement>('#warning')!
const greedyView = document.querySelector<HTMLElement>('#greedy')!
const optimalView = document.querySelector<HTMLElement>('#optimal')!
const greedyMetrics = document.querySelector<HTMLElement>('#greedy-metrics')!
const optimalMetrics = document.querySelector<HTMLElement>('#optimal-metrics')!
formSelect.value = form
formSelect.addEventListener('change', () => {
  location.search = new URLSearchParams({form: formSelect.value}).toString()
})

const count = (value: number) => value.toLocaleString('en-US')
const milliseconds = (value: number) => `${value < 10 ? value.toFixed(2) : Math.round(value)} ms`
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, character => `&#${character.charCodeAt(0)};`)

await document.fonts.ready
const measuring = new OffscreenCanvas(1, 1).getContext('2d')!
measuring.font = FONT
const spaceWidth = measuring.measureText(' ').width
const hyphenWidth = measuring.measureText('-').width

type Entry = {prepared: PreparedTextWithSegments, paragraph: Paragraph, candidates: BreakCandidate[]}
const entries: Entry[] = PARAGRAPHS.map(text => {
  const prepared = prepareWithSegments(hyphenateParagraphText(text), FONT)
  return {prepared, ...breakPointsOfPrepared(prepared, spaceWidth, hyphenWidth)}
})

// Let the status line paint before building.
await new Promise(resolve => setTimeout(resolve, 0))
const buildStarted = performance.now()
const built = buildKnuthPlass({breakCapacity, window: lineWindow}, form)
const buildMs = performance.now() - buildStarted
const compileStarted = performance.now()
const evaluate = createEvaluator(built)
const compileMs = performance.now() - compileStarted
// createEvaluator doesn't keep its compiled program, so the sizes come from a second compile of the same roots.
const {output} = built
const program = built.circuit.compileTensorProgram([...built.nextSource, output.totalCost, output.windowOverflowCount, ...output.chosen, ...output.costs, ...output.predecessors])
const programSize = `${form} form, up to ${breakCapacity} break points and ${lineWindow} boxes per line: ${count(program.valueCount - program.sourceSize)} live operations in ${count(program.layers.length)} layers, built in ${milliseconds(buildMs)} and compiled in ${milliseconds(compileMs)}`
const source = new Float32Array(built.initialSource)
window.knuthPlassFrames = []
window.knuthPlassMismatches = 0

type Line = {text: string, last: boolean, from: number | undefined, to: number | undefined}

// Where a greedy line ends among the break points: pretext's end cursor can point at a soft hyphen or right after it.
function candidateAt(entry: Entry, cursor: LayoutCursor) {
  if (cursor.graphemeIndex !== 0) return undefined
  const at = cursor.segmentIndex < entry.prepared.segments.length && entry.prepared.segments[cursor.segmentIndex] === softHyphen ? cursor.segmentIndex + 1 : cursor.segmentIndex
  const index = entry.candidates.findIndex(candidate => candidate.segmentIndex === at)
  return index === -1 ? undefined : index
}

function greedyLines(entry: Entry, width: number): Line[] {
  const ranges: LayoutLineRange[] = []
  let cursor: LayoutCursor = {segmentIndex: 0, graphemeIndex: 0}
  for (let range = layoutNextLineRange(entry.prepared, cursor, width); range !== null; range = layoutNextLineRange(entry.prepared, cursor, width)) {
    ranges.push(range)
    cursor = range.end
  }
  let from: number | undefined = 0
  return ranges.map((range, index) => {
    const to = index === ranges.length - 1 ? entry.candidates.length - 1 : candidateAt(entry, range.end)
    const line = {text: materializeLineRange(entry.prepared, range).text.replaceAll(softHyphen, '').trimEnd(), last: index === ranges.length - 1, from, to}
    from = to
    return line
  })
}

function optimalLines(entry: Entry, breaks: readonly number[]): Line[] {
  let from = 0
  return breaks.map((to, index) => {
    const start = entry.candidates[from]!.segmentIndex
    const end = entry.candidates[to]!.segmentIndex
    const text = entry.prepared.segments.slice(start, end).filter(segment => segment !== softHyphen).join('').trimEnd()
    const line = {text: text + (entry.candidates[to]!.kind === 'soft-hyphen' ? '-' : ''), last: index === breaks.length - 1, from, to}
    from = to
    return line
  })
}

// The variant's cost of the lines, and the widest space a justified line gets, from the whole-pixel break points.
function metrics(lineGroups: readonly Line[][], width: number) {
  let lineCount = 0
  let cost = 0
  let widestSpace = 0
  lineGroups.forEach((lines, paragraphIndex) => {
    const entry = entries[paragraphIndex]!
    lineCount += lines.length
    for (const line of lines) {
      if (line.last || line.from === undefined || line.to === undefined) continue
      const slack = width - naturalWidth(entry.paragraph, line.from, line.to)
      cost += slack < 0 ? 0 : Math.min(slack, slackLimit) ** 2
      const spaces = entry.candidates.slice(line.from + 1, line.to + 1).filter(candidate => candidate.kind === 'space').length - (entry.candidates[line.to]!.kind === 'space' ? 1 : 0)
      if (spaces > 0) widestSpace = Math.max(widestSpace, spaceWidth + slack / spaces)
    }
  })
  return `${count(lineCount)} lines, total cost ${count(cost)}, widest space ${widestSpace.toFixed(1)} px`
}

function draw(view: HTMLElement, lineGroups: readonly Line[][], width: number) {
  view.innerHTML = lineGroups.map(lines => `<div class="paragraph">${lines.map(line =>
    `<div class="line${line.last ? ' last' : ''}" style="width: ${width}px">${escapeHtml(line.text)}</div>`).join('')}</div>`).join('')
}

function render(width: number) {
  widthValue.textContent = `${width} px`
  const tooLong = entries.filter(entry => entry.paragraph.lineEnds.length > breakCapacity)
  const evaluateStarted = performance.now()
  const solutions = entries.map(entry => {
    if (entry.paragraph.lineEnds.length > breakCapacity) return undefined
    writeParagraph(source, built, entry.paragraph, width)
    return solutionOf(evaluate(source).output, entry.paragraph.lineEnds.length)
  })
  const evaluateMs = performance.now() - evaluateStarted
  if (check) {
    solutions.forEach((solution, index) => {
      const entry = entries[index]!
      if (solution !== undefined && JSON.stringify(solution) !== JSON.stringify(knuthPlass(entry.paragraph, width, lineWindow))) window.knuthPlassMismatches! += 1
    })
  }
  const optimal = entries.map((entry, index) => {
    const solution = solutions[index]
    return solution === undefined ? [] : optimalLines(entry, solution.breaks)
  })
  const windowOverflow = solutions.some(solution => solution !== undefined && solution.windowOverflowCount > 0)
  const greedyStarted = performance.now()
  const greedy = entries.map(entry => greedyLines(entry, width))
  const greedyMs = performance.now() - greedyStarted
  const domStarted = performance.now()
  draw(greedyView, greedy, width)
  draw(optimalView, optimal, width)
  greedyMetrics.textContent = metrics(greedy, width)
  optimalMetrics.textContent = metrics(optimal, width)
  statusLine.textContent = `${programSize}. This frame: ${entries.length} evaluations in ${milliseconds(evaluateMs)}, greedy breaks in ${milliseconds(greedyMs)}.`
  warningLine.textContent = [
    ...tooLong.map(entry => `A paragraph has ${entry.paragraph.lineEnds.length} break points, and the program holds ${breakCapacity}, so it isn't shown.`),
    ...(windowOverflow ? [`At this width some lines would fit more than ${lineWindow} boxes, which the program doesn't consider, so its breaks are the cheapest among lines of at most ${lineWindow} boxes.`] : []),
  ].join(' ')
  const domMs = performance.now() - domStarted
  const longestLine = Math.max(0, ...optimal.flatMap(lines => lines.map(line => line.to! - line.from!)))
  window.knuthPlassFrames!.push({width, evaluateMs, greedyMs, domMs, longestLine, windowOverflow})
}

let scheduled = false
widthInput.addEventListener('input', () => {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    render(Number(widthInput.value))
  })
})
window.knuthPlassRender = render
render(Number(widthInput.value))
window.knuthPlassReady = true

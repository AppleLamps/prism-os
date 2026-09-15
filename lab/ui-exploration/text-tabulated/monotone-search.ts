// Searches for widths where pretext's line count goes up as the width grows, or where a line's start
// cursor moves backward. Either one breaks the assumption behind tabulation's sampling and behind the
// bubbles demo's binary search.
//
// With the fake canvas, every advance is a multiple of fontSize/64, and pretext compares line widths
// against maxWidth + lineFitEpsilon (rich inline also compares without the epsilon). So results can only
// change at widths g - epsilon or g, for g on that grid. Those widths split the range into intervals
// that each have one layout, and the sweep samples once inside each interval. So the sweep is exhaustive
// for the fake canvas, not a random probe, and band widths are exact.
//
// A band is a run of intervals whose layouts are behind the layout just before the run: more lines than
// at that narrower width, or some line starting earlier. Each case is swept over its whole width range
// as generated, and every band is counted. Shrinking is only used to print minimal examples: the first
// case with a band of 1px or more, the first with a line count increase, and the first with any band
// are each shrunk while such a band survives.
//
// The engine profile is cached on first use, so run one engine per process:
//   bun lab/ui-exploration/text-tabulated/monotone-search.ts blink [--kerning] [--only text|rich] [--texts 400] [--seed 1] [--out file.json] [--no-shrink]

import {installFakeCanvas, type FakeEngine} from './fake-canvas.ts'
import {createRandom} from './float32.ts'
import {prepareWithSegments, walkLineRanges, type PrepareOptions} from './pretext/layout.ts'
import {prepareRichInline, walkRichInlineLineRanges, type RichInlineItem} from './pretext/rich-inline.ts'

const argumentsList = process.argv.slice(2)
const engine = (argumentsList[0] ?? 'blink') as FakeEngine
const kerning = argumentsList.includes('--kerning')
const shrinkExamples = !argumentsList.includes('--no-shrink')
const readNumber = (flag: string, fallback: number) => {
  const index = argumentsList.indexOf(flag)
  return index === -1 ? fallback : Number(argumentsList[index + 1])
}
const textCount = readNumber('--texts', 300)
const seed = readNumber('--seed', 1)
installFakeCanvas(engine, {kerning})
const lineFitEpsilon = engine === 'webkit' ? 1 / 64 : 0.005
const softHyphen = '­'

const random = createRandom(seed)
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
const letters = 'abcdefghijklmnopqrstuvwxyzATVLTory'
const word = (length: number) => Array.from({length}, () => pick([...letters])).join('')

// Pieces aimed at the walker's special cases.
const pieceMakers: (() => string)[] = [
  () => word(1 + Math.floor(random() * 9)),
  () => word(1 + Math.floor(random() * 4)),
  () => word(18 + Math.floor(random() * 25)),
  () => `${word(3)}-${word(5)}-${word(4)}`,
  () => `https://example.com/${word(4)}/${word(6)}-${word(3)}?q=${word(5)}`,
  () => `${word(4)}­${word(5)}­${word(3)}`,
  () => `${word(3)} ${word(4)}`,
  () => `${word(4)}​${word(5)}`,
  () => `${word(3)}⁠${word(4)}`,
  () => `${word(3)}‍${word(3)}`,
  () => '春天到了中文标签',
  () => '漢字かな交じり文',
  () => '👩‍💻 🎉',
  () => `${Math.floor(random() * 99)} ${Math.floor(random() * 999)},${Math.floor(random() * 999)}`,
  () => pick(['.', ',', '!', '—', '「了解です」', '(', ')']),
  () => `${word(2)}${word(2)}`,
]
const preWrapMakers: (() => string)[] = [() => '\t', () => '\t\t', () => '\n', () => '\n\n', () => '  ']

function makeText(preWrap: boolean): string {
  const pieceCount = 3 + Math.floor(random() * 14)
  let text = ''
  for (let index = 0; index < pieceCount; index++) {
    const makers = preWrap && random() < 0.3 ? preWrapMakers : pieceMakers
    text += pick(makers)()
    if (random() < 0.8) text += ' '
  }
  return text
}

type Cursor = [number, number, number]
const compareCursors = (left: Cursor, right: Cursor) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]

// Every width from `from` up to `to` has the same layout; `sample` is one width inside.
type Interval = {sample: number, from: number, to: number}

type BandKind = 'lineCount' | 'lineStart'

// A run of intervals whose layouts are behind the layout just before the run. kind is 'lineCount' when
// some layout in the run has more lines than that narrower layout. reachesSweepEnd: still behind at the
// widest width swept, so `to` is only a lower bound.
type Band = {kind: BandKind, from: number, to: number, width: number, linesBefore: number, mostLines: number, reachesSweepEnd: boolean}

function isBehind(starts: Cursor[], previous: Cursor[]): BandKind | null {
  if (starts.length > previous.length) return 'lineCount'
  for (let slot = 0; slot < starts.length; slot++) if (compareCursors(starts[slot]!, previous[slot]!) < 0) return 'lineStart'
  return null
}

// Walks every interval upward and returns every band in width order. `stopAt` ends the sweep early once
// it accepts a finished band, which keeps shrinking fast.
function sweepBands(layoutAt: (width: number) => Cursor[], intervals: readonly Interval[], stopAt?: (band: Band) => boolean): Band[] {
  const bands: Band[] = []
  let reference: Cursor[] | null = null
  let open: Band | null = null
  for (const interval of intervals) {
    const starts = layoutAt(interval.sample)
    if (reference === null) {
      reference = starts
      continue
    }
    const kind = isBehind(starts, reference)
    if (kind !== null) {
      if (open === null) {
        open = {kind, from: interval.from, to: interval.to, width: 0, linesBefore: reference.length, mostLines: starts.length, reachesSweepEnd: false}
      } else {
        open.to = interval.to
        if (kind === 'lineCount') open.kind = 'lineCount'
        open.mostLines = Math.max(open.mostLines, starts.length)
      }
      continue
    }
    if (open !== null) {
      const band: Band = {...open, width: open.to - open.from}
      bands.push(band)
      open = null
      if (stopAt !== undefined && stopAt(band)) return bands
    }
    reference = starts
  }
  if (open !== null) bands.push({...open, width: open.to - open.from, reachesSweepEnd: true})
  return bands
}

function intervalsOnGrid(grid: number, from: number, to: number, withoutEpsilonToo: boolean): Interval[] {
  const intervals: Interval[] = []
  for (let g = Math.ceil(from / grid) * grid; g <= to; g += grid) {
    if (withoutEpsilonToo) {
      intervals.push({sample: g - lineFitEpsilon / 2, from: g - lineFitEpsilon, to: g}, {sample: g + grid / 2, from: g, to: g + grid - lineFitEpsilon})
    } else {
      intervals.push({sample: g, from: g - lineFitEpsilon, to: g + grid - lineFitEpsilon})
    }
  }
  return intervals
}

type Case = {
  name: 'text' | 'rich inline'
  sweep: () => Band[]
  hasSoftHyphen: () => boolean
  // The same case with every soft hyphen removed from its text.
  sweepWithoutSoftHyphens: () => Band[]
  // Shrinks the case in place while some band that `accept` accepts survives.
  shrink: (accept: (band: Band) => boolean) => void
  describe: () => unknown
}

// Drops chunks of code points, from the end toward the start, while `holds` accepts the shorter text.
function shrinkText(text: string, holds: (candidate: string) => boolean): string {
  let codePoints = [...text]
  for (const size of [64, 16, 4, 1]) {
    for (let index = codePoints.length - size; index >= 0; index -= size) {
      const shorter = [...codePoints.slice(0, index), ...codePoints.slice(index + size)]
      if (shorter.length > 0 && holds(shorter.join(''))) codePoints = shorter
    }
  }
  return codePoints.join('')
}

function textCase(): Case {
  const preWrap = random() < 0.35
  const letterSpacing = pick([0, 0, 0, 0.25, 1.5, 4, -0.75, -2.5])
  const wordBreak = random() < 0.15 ? 'keep-all' as const : 'normal' as const
  let text = makeText(preWrap)
  const options: PrepareOptions = {whiteSpace: preWrap ? 'pre-wrap' : 'normal', letterSpacing, wordBreak}
  const intervals = intervalsOnGrid(0.25, 0.25, 700, false)
  const sweepText = (source: string, stopAt?: (band: Band) => boolean) => {
    const prepared = prepareWithSegments(source, '16px Test Sans', options)
    return sweepBands(width => {
      const starts: Cursor[] = []
      walkLineRanges(prepared, width, line => starts.push([0, line.start.segmentIndex, line.start.graphemeIndex]))
      return starts
    }, intervals, stopAt)
  }
  return {
    name: 'text',
    sweep: () => sweepText(text),
    hasSoftHyphen: () => text.includes(softHyphen),
    sweepWithoutSoftHyphens: () => sweepText(text.replaceAll(softHyphen, '')),
    shrink: accept => {
      text = shrinkText(text, candidate => sweepText(candidate, accept).some(accept))
    },
    describe: () => ({text, options}),
  }
}

function richCase(): Case {
  const fonts = ['16px Test Sans', '12px Test Sans', '20px Test Sans']
  let items: RichInlineItem[] = []
  const itemCount = 2 + Math.floor(random() * 8)
  for (let index = 0; index < itemCount; index++) {
    const chip = random() < 0.35
    const item: RichInlineItem = {text: chip ? word(2 + Math.floor(random() * 8)) : ` ${makeText(false)} `.slice(random() < 0.5 ? 1 : 0), font: pick(fonts)}
    if (chip) item.break = 'never'
    if (random() < 0.5) item.extraWidth = pick([4, 14, 22])
    if (random() < 0.2) item.letterSpacing = pick([0.5, 1.25])
    items.push(item)
  }
  // Letter spacing 1.25 and fonts 12/16/20px put advances on a 1/16 px grid.
  const intervals = intervalsOnGrid(1 / 16, 1, 500, true)
  const sweepFlow = (flowItems: RichInlineItem[], stopAt?: (band: Band) => boolean) => {
    const flow = prepareRichInline(flowItems)
    return sweepBands(width => {
      const starts: Cursor[] = [[0, 0, 0]]
      walkRichInlineLineRanges(flow, width, line => starts.push([line.end.itemIndex, line.end.segmentIndex, line.end.graphemeIndex]))
      starts.pop()
      return starts
    }, intervals, stopAt)
  }
  const survives = (flowItems: RichInlineItem[], accept: (band: Band) => boolean) => flowItems.length > 0 && sweepFlow(flowItems, accept).some(accept)
  const withItem = (index: number, item: RichInlineItem) => items.map((current, itemIndex) => itemIndex === index ? item : current)
  return {
    name: 'rich inline',
    sweep: () => sweepFlow(items),
    hasSoftHyphen: () => items.some(item => item.text.includes(softHyphen)),
    sweepWithoutSoftHyphens: () => sweepFlow(items.map(item => ({...item, text: item.text.replaceAll(softHyphen, '')}))),
    shrink: accept => {
      for (let index = items.length - 1; index >= 0; index--) {
        const fewer = items.filter((_, itemIndex) => itemIndex !== index)
        if (survives(fewer, accept)) items = fewer
      }
      for (let index = 0; index < items.length; index++) {
        for (const property of ['extraWidth', 'letterSpacing', 'break'] as const) {
          if (items[index]![property] === undefined) continue
          const simpler = {...items[index]!}
          delete simpler[property]
          if (survives(withItem(index, simpler), accept)) items = withItem(index, simpler)
        }
        const text = shrinkText(items[index]!.text, candidate => survives(withItem(index, {...items[index]!, text: candidate}), accept))
        items = withItem(index, {...items[index]!, text})
      }
    },
    describe: () => items,
  }
}

const isEpsilonBand = (band: Band) => band.width <= lineFitEpsilon + 1e-9
const isWideBand = (band: Band) => band.width >= 1

type WideCase = {caseIndex: number, widestBand: number, lineCountIncrease: boolean, hasSoftHyphen: boolean, wideWithoutSoftHyphens: boolean}

function createSummary() {
  return {
    cases: 0,
    casesWithBackwardStep: 0,
    casesWithLineCountIncrease: 0,
    bands: 0,
    lineCountBands: 0,
    // Band widths: one epsilon interval, wider but under 1px, and 1px or more.
    epsilonBands: 0,
    bandsBetweenEpsilonAnd1px: 0,
    bandsOf1pxOrMore: 0,
    widestBand: 0,
    widestBandUnder1px: 0,
    bandsReachingSweepEnd: 0,
    casesWithBandOf1pxOrMore: 0,
    casesWithLineCountIncreaseOf1pxOrMore: 0,
    casesWithBandOf1pxOrMoreAndNoSoftHyphen: 0,
    // Swept again with every soft hyphen removed from the text: how many still have a band of 1px or more.
    casesWithBandOf1pxOrMoreWithoutSoftHyphens: 0,
    wideCases: [] as WideCase[],
    examples: [] as unknown[],
  }
}

function exampleKinds(): {label: string, accept: (band: Band) => boolean}[] {
  return [
    {label: 'a band of 1px or more', accept: isWideBand},
    {label: 'a line count increase', accept: band => band.kind === 'lineCount'},
    {label: 'any band', accept: () => true},
  ]
}

const started = performance.now()
// --only text | rich restricts the cases; by default every fourth case is a rich inline flow.
const onlyIndex = argumentsList.indexOf('--only')
const only = onlyIndex === -1 ? 'both' : argumentsList[onlyIndex + 1]
const summaries: Record<Case['name'], ReturnType<typeof createSummary>> = {'text': createSummary(), 'rich inline': createSummary()}
const examplesWanted: Record<Case['name'], ReturnType<typeof exampleKinds>> = {'text': exampleKinds(), 'rich inline': exampleKinds()}
for (let index = 0; index < textCount; index++) {
  const testCase = only === 'text' ? textCase() : only === 'rich' ? richCase() : index % 4 === 3 ? richCase() : textCase()
  const summary = summaries[testCase.name]
  summary.cases++
  const bands = testCase.sweep()
  if (bands.length === 0) continue
  summary.casesWithBackwardStep++
  if (bands.some(band => band.kind === 'lineCount')) summary.casesWithLineCountIncrease++
  for (const band of bands) {
    summary.bands++
    if (band.kind === 'lineCount') summary.lineCountBands++
    if (band.reachesSweepEnd) summary.bandsReachingSweepEnd++
    if (isEpsilonBand(band)) summary.epsilonBands++
    else if (band.width < 1) summary.bandsBetweenEpsilonAnd1px++
    else summary.bandsOf1pxOrMore++
    summary.widestBand = Math.max(summary.widestBand, band.width)
    if (band.width < 1) summary.widestBandUnder1px = Math.max(summary.widestBandUnder1px, band.width)
  }
  const wideBands = bands.filter(isWideBand)
  if (wideBands.length > 0) {
    const hasSoftHyphen = testCase.hasSoftHyphen()
    const wideWithoutSoftHyphens = !hasSoftHyphen || testCase.sweepWithoutSoftHyphens().some(isWideBand)
    const lineCountIncrease = wideBands.some(band => band.kind === 'lineCount')
    summary.casesWithBandOf1pxOrMore++
    if (lineCountIncrease) summary.casesWithLineCountIncreaseOf1pxOrMore++
    if (!hasSoftHyphen) summary.casesWithBandOf1pxOrMoreAndNoSoftHyphen++
    if (wideWithoutSoftHyphens) summary.casesWithBandOf1pxOrMoreWithoutSoftHyphens++
    summary.wideCases.push({caseIndex: index, widestBand: Math.max(...wideBands.map(band => band.width)), lineCountIncrease, hasSoftHyphen, wideWithoutSoftHyphens})
  }
  if (!shrinkExamples) continue
  // Shrink this case for the first example kind it has that hasn't been found yet. Shrinking changes the
  // case, so each case gives at most one example, after its own numbers are counted above.
  const wanted = examplesWanted[testCase.name]
  const kindIndex = wanted.findIndex(kind => bands.some(kind.accept))
  if (kindIndex === -1) continue
  const kind = wanted.splice(kindIndex, 1)[0]!
  const shrinkStarted = performance.now()
  testCase.shrink(kind.accept)
  summary.examples.push({
    label: kind.label,
    caseIndex: index,
    shrunkCase: testCase.describe(),
    bands: testCase.sweep().filter(kind.accept).slice(0, 3),
    shrinkSeconds: Math.round((performance.now() - shrinkStarted) / 100) / 10,
  })
}
const result = {
  engine,
  kerning,
  seed,
  only,
  seconds: Math.round((performance.now() - started) / 100) / 10,
  ...(summaries['text'].cases > 0 ? {text: summaries['text']} : {}),
  ...(summaries['rich inline'].cases > 0 ? {richInline: summaries['rich inline']} : {}),
}
const outIndex = argumentsList.indexOf('--out')
if (outIndex !== -1) await Bun.write(argumentsList[outIndex + 1]!, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, (key, value: unknown) => key === 'wideCases' && Array.isArray(value) ? `${value.length} cases (see --out)` : value, 2))

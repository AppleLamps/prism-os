// A deterministic canvas for running pretext under bun, adapted from the phase 1 recipe.
//
// Widths are whole multiples of 1/64 of the font size (1/4 px at 16px), so every segment width and
// every prefix sum is exact in both float64 and FP32 for paragraphs under 2^22 px. A circuit and
// pretext's float64 walker then cannot disagree through rounding alone. The measurement is additive
// (no kerning), so a word's width equals the sum of its grapheme advances.

const emojiPresentationRe = /\p{Emoji_Presentation}/u
const decimalDigitRe = /\p{Nd}/u
const punctuationRe = /[.,!?;:%)\]}'"”’»›…—-]/u

function parseFontSize(font: string): number {
  const match = font.match(/(\d+(?:\.\d+)?)\s*px/)
  return match ? Number.parseFloat(match[1]!) : 16
}

function isWideCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x30FF) ||
    (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
    (codePoint >= 0xAC00 && codePoint <= 0xD7AF) ||
    (codePoint >= 0xFF00 && codePoint <= 0xFFEF)
  )
}

export function fakeTextWidth(text: string, font: string): number {
  const fontSize = parseFontSize(font)
  // The "Tie Test" font of tests/handwiredos/notes.test.ts, with the same widths as that file's
  // fakeTextWidth. npm pretext keeps the first canvas it measures with, and `bun test` without
  // arguments runs lab/ before tests/, so batch/paragraphs.ts's canvas or lab/knuth-plass's can
  // be the canvas that measures the Notes tie test.
  if (font.includes('Tie Test')) {
    let width = 0
    for (const character of text) width += character === ' ' ? 0.5 : character === 'b' ? 1 / 64 : 1
    return width
  }
  let sixtyFourths = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    if (character === '​' || character === '­' || character === '⁠') continue
    if (character === ' ' || character === ' ') sixtyFourths += 20
    else if (character === '\t') sixtyFourths += 84
    else if (emojiPresentationRe.test(character)) sixtyFourths += 64
    else if (decimalDigitRe.test(character)) sixtyFourths += 33
    else if (isWideCharacter(codePoint)) sixtyFourths += 64
    else if (punctuationRe.test(character)) sixtyFourths += 22
    // Letters vary between 28/64 and 40/64 of the font size, so words get varied widths.
    else sixtyFourths += 28 + (codePoint % 13)
  }
  return sixtyFourths * fontSize / 64
}

const userAgents = {
  blink: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  webkit: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
  gecko: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0',
} as const

export type FakeEngine = keyof typeof userAgents

// Must run before pretext's first prepare or layout call: getEngineProfile() caches the profile.
export function installFakeCanvas(engine: FakeEngine): void {
  class FakeContext {
    font = ''
    measureText(text: string): {width: number} {
      return {width: fakeTextWidth(text, this.font)}
    }
  }
  class FakeOffscreenCanvas {
    getContext(): FakeContext {
      return new FakeContext()
    }
  }
  Reflect.set(globalThis, 'OffscreenCanvas', FakeOffscreenCanvas)
  Object.defineProperty(globalThis, 'navigator', {
    value: {userAgent: userAgents[engine]},
    configurable: true,
    writable: true,
  })
}

// Deterministic word soup for scaling studies.
const words = (
  'the quick brown fox jumps over a lazy dog while seven wizards quietly hex every jolly gnome ' +
  'pack my box with five dozen liquor jugs sphinx of black quartz judge my vow how vexingly ' +
  'quick daft zebras jump bright vixens jump dozy fowl quack'
).split(' ')

export function makeParagraph(wordCount: number, seed = 1): string {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const parts: string[] = []
  for (let index = 0; index < wordCount; index++) {
    let word = words[Math.floor(next() * words.length)]!
    if (next() < 0.08) word += ','
    else if (next() < 0.05) word += '.'
    parts.push(word)
  }
  return parts.join(' ')
}

type Pretext = typeof import('./pretext-src/layout.ts')

// PreparedCore is internal to pretext; these fields exist on every prepared handle at runtime.
export type PreparedView = {
  widths: number[]
  kinds: string[]
  simpleLineWalkFastPath: boolean
  breakableFitAdvances: (number[] | null)[]
  breakablePreferredBreaks: (number[] | null)[]
  chunks: {startSegmentIndex: number, endSegmentIndex: number, consumedEndSegmentIndex: number}[]
  discretionaryHyphenWidth: number
  discretionaryHyphenContexts?: boolean[] | null
  tabStopAdvance: number
  letterSpacing: number
  spacingGraphemeCounts: number[]
  entryGeometry?: unknown
}

export function viewPrepared(prepared: object): PreparedView {
  return prepared as unknown as PreparedView
}

// Every headless check in this folder runs pretext with the Gecko profile: lineFitEpsilon 0.005,
// no return from an unfit soft hyphen, no skipping of narrow tab stops. The profile is cached per
// process, so all modules share one loader.
export const testEngine: FakeEngine = 'gecko'
export const lineFitEpsilon = 0.005
let loaded: Promise<Pretext> | null = null

export function loadPretext(): Promise<Pretext> {
  if (loaded === null) {
    installFakeCanvas(testEngine)
    loaded = import('./pretext-src/layout.ts')
  }
  return loaded
}

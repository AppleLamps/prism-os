// Deterministic fake canvas for running pretext under bun.
//
// Widths are whole multiples of 1/64 of the font size (1/4 px at 16px), so every
// segment width and every prefix sum is exact in both float64 and FP32 for any
// paragraph under 2**24 / 64 px wide. That keeps a circuit and pretext's float64
// walker from disagreeing on rounding alone.
//
// The measurement is additive (no kerning), so WebKit's "measure with following
// space" path and Safari's prefix-width path produce the same numbers as isolated
// measurement.

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
    // Letters vary between 28/64 and 40/64 of the font size, so words have varied widths.
    else sixtyFourths += 28 + (codePoint % 13)
  }
  return sixtyFourths * fontSize / 64
}

const userAgents = {
  blink: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  webkit: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
  gecko: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0',
} as const

export type FakeEngine = keyof typeof userAgents | 'bun-default'

// Call before importing pretext: getEngineProfile() caches the profile on first use.
export function installFakeCanvas(engine: FakeEngine = 'blink'): void {
  class FakeContext {
    font = ''
    measureText(text: string): { width: number } {
      return { width: fakeTextWidth(text, this.font) }
    }
  }
  class FakeOffscreenCanvas {
    constructor(_width: number, _height: number) {}
    getContext(_kind: string): FakeContext {
      return new FakeContext()
    }
  }
  Reflect.set(globalThis, 'OffscreenCanvas', FakeOffscreenCanvas)
  if (engine !== 'bun-default') {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: userAgents[engine] },
      configurable: true,
      writable: true,
    })
  }
}

// Numeric codes for SegmentBreakKind, for writing kinds into a Float32Array source table.
export const kindCodes: Record<string, number> = {
  'text': 0,
  'space': 1,
  'preserved-space': 2,
  'tab': 3,
  'glue': 4,
  'zero-width-break': 5,
  'soft-hyphen': 6,
  'hard-break': 7,
  'control': 8,
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

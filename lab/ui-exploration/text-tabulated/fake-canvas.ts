// Deterministic fake canvas for running pretext under bun (copied from phase 1 and extended).
//
// Widths are whole multiples of 1/64 of the font size (1/4 px at 16px), so every segment width and
// every prefix sum is exact in both float64 and FP32 for any paragraph under 2^24 / 64 px wide.
//
// The default measurement is additive. With `kerning: true`, a few letter pairs and "letter followed
// by space" pairs measure narrower together than apart, so pretext's joined measurements (WebKit's
// "measure with following space", pair-context grapheme advances) stop being sums of isolated widths.
// That is the closest this fake gets to a real font's non-additive widths.
//
// With `nonDyadic: true`, every character's advance is scaled by its own factor between 1 and 1.05,
// e.g. "a" is 34/64 * 1.0475... of the font size, so widths aren't multiples of a power-of-two fraction,
// prefix sums round in float64 as they do with a real font, and thresholds of different paragraphs
// rarely land on the same value. The exhaustive grid argument in monotone-search.ts doesn't apply then.

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

function characterSixtyFourths(character: string): number {
  const codePoint = character.codePointAt(0)!
  if (character === '​' || character === '­' || character === '⁠' || character === '‍') return 0
  if (character === ' ' || character === ' ') return 20
  if (character === '\t') return 84
  if (emojiPresentationRe.test(character)) return 64
  if (decimalDigitRe.test(character)) return 33
  if (isWideCharacter(codePoint)) return 64
  if (punctuationRe.test(character)) return 22
  // Letters vary between 28/64 and 40/64 of the font size, so words have varied widths.
  return 28 + (codePoint % 13)
}

// Pairs that measure narrower together, in 64ths of the font size.
const kerningPairs = new Map<string, number>([
  ['AV', 6], ['VA', 6], ['To', 5], ['Ta', 5], ['Te', 4], ['LT', 5], ['ry', 2], ['y.', 3], ['f ', 2], ['y ', 2], ['r ', 1],
])

// A factor in 1..1.05 per code point, from the fractional part of codePoint times the golden ratio.
function nonDyadicFactor(character: string): number {
  return 1 + ((character.codePointAt(0)! * 0.6180339887498949) % 1) * 0.05
}

export function fakeTextWidth(text: string, font: string, kerning = false, nonDyadic = false): number {
  const fontSize = parseFontSize(font)
  let sixtyFourths = 0
  let previous = ''
  for (const character of text) {
    sixtyFourths += nonDyadic ? characterSixtyFourths(character) * nonDyadicFactor(character) : characterSixtyFourths(character)
    if (kerning && previous !== '') sixtyFourths -= kerningPairs.get(previous + character) ?? 0
    previous = character
  }
  return sixtyFourths * fontSize / 64
}

const userAgents = {
  blink: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  webkit: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
  gecko: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0',
} as const

export type FakeEngine = keyof typeof userAgents

// Must run before the first prepare call: pretext creates its measuring context and caches the engine
// profile on first use (not at import time), so a static import of pretext is fine.
export function installFakeCanvas(engine: FakeEngine = 'blink', options: {kerning?: boolean, nonDyadic?: boolean} = {}): void {
  const kerning = options.kerning ?? false
  const nonDyadic = options.nonDyadic ?? false
  class FakeContext {
    font = ''
    measureText(text: string): {width: number} {
      return {width: fakeTextWidth(text, this.font, kerning, nonDyadic)}
    }
  }
  class FakeOffscreenCanvas {
    constructor(_width: number, _height: number) {}
    getContext(_kind: string): FakeContext {
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

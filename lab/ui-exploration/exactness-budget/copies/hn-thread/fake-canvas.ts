// Deterministic fake canvas for running pretext under bun, adapted from the phase 1
// recipe (scratchpad/phase1/pretext/fake-canvas.ts).
//
// Every character is a whole number of 64ths of the font size, so at 12px every
// segment width is a multiple of 3/16px. Widths and prefix sums are exact in both
// float64 and FP32, so pretext's float64 walker and an FP32 circuit can't
// disagree through rounding alone. Real fonts in the browser move the breakpoints.

const emojiPresentationPattern = /\p{Emoji_Presentation}/u
const decimalDigitPattern = /\p{Nd}/u
const punctuationPattern = /[.,!?;:%)\]}'"”’»›…—-]/u

function parseFontSize(font: string): number {
  const match = font.match(/(\d+(?:\.\d+)?)\s*px/)
  return match ? Number.parseFloat(match[1]!) : 16
}

function isWideCharacter(codePoint: number): boolean {
  return (codePoint >= 0x3000 && codePoint <= 0x30FF)
    || (codePoint >= 0x4E00 && codePoint <= 0x9FFF)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7AF)
    || (codePoint >= 0xFF00 && codePoint <= 0xFFEF)
}

export function fakeTextWidth(text: string, font: string): number {
  const fontSize = parseFontSize(font)
  let sixtyFourths = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    if (character === '​' || character === '­' || character === '⁠') continue
    if (character === ' ' || character === ' ') sixtyFourths += 20
    else if (character === '\t') sixtyFourths += 84
    else if (emojiPresentationPattern.test(character)) sixtyFourths += 64
    else if (decimalDigitPattern.test(character)) sixtyFourths += 33
    else if (isWideCharacter(codePoint)) sixtyFourths += 64
    else if (punctuationPattern.test(character)) sixtyFourths += 22
    // Letters vary between 28/64 and 40/64 of the font size, so words have varied widths.
    else sixtyFourths += 28 + (codePoint % 13)
  }
  return sixtyFourths * fontSize / 64
}

const chromeUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'

// Call before the first pretext call: pretext caches its engine profile and measuring context on first use.
export function installFakeCanvas(): void {
  class FakeContext {
    font = ''
    measureText(text: string): {width: number} {
      return {width: fakeTextWidth(text, this.font)}
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
    value: {userAgent: chromeUserAgent},
    configurable: true,
    writable: true,
  })
}

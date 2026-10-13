// A deterministic canvas for the HandwiredOS text tests: letters vary between 28/64
// and 40/64 of the font size, spaces are 20/64 and punctuation 22/64, so every
// width lies on the 1/64 px grid at 14 px. notes-paragraph.ts's default widths were
// baked with this rule. The "Tie Test" font measures in whole and 1/64 px for
// notes.test.ts's line fit tie test.
//
// Importing this file installs the canvas. pretext creates its measuring context at
// its first measurement and keeps it, so a test file imports this file before its
// first prepare call. All test files of one `bun test` process share that context:
// lab/ui-exploration/text-walker/fake-canvas.ts is the canvas when lab/ runs before
// tests/, e.g. under `bun test` without arguments. It has the same "Tie Test" widths
// and the same widths for letters, spaces and the punctuation below, and other
// widths for digits, tabs, no-break spaces and zero-width characters. So tests here
// measure texts of letters, spaces and that punctuation, or compare with what
// pretext itself reports.
export function fakeTextWidth(text: string, font: string): number {
  const fontSize = Number.parseFloat(font.match(/(\d+(?:\.\d+)?)\s*px/)?.[1] ?? '16')
  if (font.includes('Tie Test')) {
    let width = 0
    for (const character of text) width += character === ' ' ? 0.5 : character === 'b' ? 1 / 64 : 1
    return width
  }
  let sixtyFourths = 0
  for (const character of text) {
    if (character === ' ') sixtyFourths += 20
    else if (/[.,!?;:%)\]}'"”’»›…—-]/u.test(character)) sixtyFourths += 22
    else sixtyFourths += 28 + (character.codePointAt(0)! % 13)
  }
  return sixtyFourths * fontSize / 64
}

class FakeContext {
  font = ''
  measureText(text: string) {
    return {width: fakeTextWidth(text, this.font)}
  }
}
Reflect.set(globalThis, 'OffscreenCanvas', class {
  getContext() {
    return new FakeContext()
  }
})

export const testFont = '14px Test Serif'

// Prepare step for captions: tabulates each prompt's line breakpoints with pretext, the way a page
// would call pretext's prepare() once per text, and writes caption-breakpoints.json.
//
// It runs the vibescript photo-gallery port's own prompt-layout.ts (frozen as port-prompt-layout.ts.txt,
// vibescript commit f37a575) against a copy of pretext's src/, with a deterministic fake canvas and a
// Blink user agent. So the widths are fake per-character advances, not DM Sans: real fonts move the
// breakpoints, and a browser page would compute its own table at load.
//
// Run: bun lab/ui-exploration/gallery/prepare-captions.ts
// PRETEXT_SRC overrides the pretext src folder (default: this session's scratch copy).
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {photoGalleryData} from './photo-data.ts'

const scratch = 'scratchpad/phase2/gallery'
const pretextSource = process.env['PRETEXT_SRC'] ?? `${scratch}/pretext-src`

// Fake canvas from phase 1 (scratchpad/phase1/pretext/fake-canvas.ts): every advance is a whole number of
// 64ths of the font size, so widths and their sums are exact in float64 and FP32.
function fakeTextWidth(text: string, font: string): number {
  const fontSize = Number.parseFloat(font.match(/(\d+(?:\.\d+)?)\s*px/)?.[1] ?? '16')
  let sixtyFourths = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0)!
    if (character === '​' || character === '­' || character === '⁠') continue
    if (character === ' ' || character === ' ' || character === ' ') sixtyFourths += 20
    else if (/\p{Emoji_Presentation}/u.test(character)) sixtyFourths += 64
    else if (/\p{Nd}/u.test(character)) sixtyFourths += 33
    else if (/[.,!?;:%)\]}'"”’»›…—-]/u.test(character)) sixtyFourths += 22
    else sixtyFourths += 28 + (codePoint % 13)
  }
  return sixtyFourths * fontSize / 64
}

Reflect.set(globalThis, 'OffscreenCanvas', class {
  getContext() {
    return {font: '', measureText(this: {font: string}, text: string) { return {width: fakeTextWidth(text, this.font)} }}
  }
})
Object.defineProperty(globalThis, 'navigator', {
  value: {userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'},
  configurable: true,
  writable: true,
})

type PreparedPrompt = unknown
type PromptLayoutModule = {
  preparePrompt(prompt: string): PreparedPrompt
  measurePromptLayout(prompt: PreparedPrompt, outerMaxWidth: number, maxLines: number, lineHeight: number): {lineCount: number}
}

async function loadPortPromptLayout(): Promise<PromptLayoutModule> {
  const original = readFileSync(new URL('port-prompt-layout.ts.txt', import.meta.url), 'utf8')
  const specifier = `'@chenglou/pretext/rich-inline'`
  if (!original.includes(specifier)) throw new Error('unexpected port prompt-layout import')
  mkdirSync(scratch, {recursive: true})
  const rewrittenPath = `${scratch}/port-prompt-layout.ts`
  writeFileSync(rewrittenPath, original.replace(specifier, `'${pretextSource}/rich-inline.ts'`))
  return await import(rewrittenPath) as PromptLayoutModule
}

const promptLayout = await loadPortPromptLayout()
const paddingX = 12
const lineCount = (prepared: PreparedPrompt, innerWidth: number) =>
  promptLayout.measurePromptLayout(prepared, innerWidth + 2 * paddingX, 3, 1).lineCount

// The smallest inner width at which the prompt needs at most `lines - 1` lines.
function breakpoint(prepared: PreparedPrompt, lines: number) {
  let low = 1
  let high = 4096
  if (lineCount(prepared, high) >= lines) return 1e6
  if (lineCount(prepared, low) < lines) return low
  while (high - low > 1e-7) {
    const middle = (low + high) / 2
    if (lineCount(prepared, middle) >= lines) low = middle
    else high = middle
  }
  // Text advances are multiples of 14/64px, so a breakpoint often lands exactly on a round width, where
  // pretext's fit test already fits. Snap down to that width so the table is left-closed like pretext.
  const snapped = Math.floor(high * 2 ** 16) / 2 ** 16
  return snapped > low && lineCount(prepared, snapped) < lines ? snapped : high
}

const started = performance.now()
let increases = 0
let sweepMismatches = 0
let randomMismatches = 0
let sweepSamples = 0
const mismatchExamples: string[] = []
const breakpoints = photoGalleryData.map((photo, index) => {
  const prepared = promptLayout.preparePrompt(photo.prompt)
  const entry = {twoLines: breakpoint(prepared, 2), threeLines: breakpoint(prepared, 3)}
  const staircase = (innerWidth: number) => 1 + (innerWidth < entry.twoLines ? 1 : 0) + (innerWidth < entry.threeLines ? 1 : 0)
  let previous = Infinity
  for (let innerWidth = 1; innerWidth <= 2400; innerWidth += 0.25) {
    const lines = lineCount(prepared, innerWidth)
    if (lines > previous) increases++
    previous = lines
    sweepSamples++
    if (Math.min(lines, 3) !== staircase(innerWidth)) {
      sweepMismatches++
      if (mismatchExamples.length < 10) {
        mismatchExamples.push(`photo ${index} inner ${innerWidth}: pretext ${lines} lines, table ${staircase(innerWidth)} (twoLines ${entry.twoLines}, threeLines ${entry.threeLines})`)
      }
    }
  }
  let seed = index + 1
  for (let trial = 0; trial < 200; trial++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const innerWidth = 1 + (seed / 2 ** 32) * 2400
    if (Math.min(lineCount(prepared, innerWidth), 3) !== staircase(innerWidth)) randomMismatches++
  }
  return entry
})

const output = {
  provenance: {
    promptLayout: 'vibescript demos/photo-gallery/prompt-layout.ts at f37a5751ba5c82c210faec61770efc48b53149d5',
    pretext: 'copy of pretext src/ (scratchpad/pretext-copy, commit 477510e4)',
    canvas: 'fake per-character advances in 64ths of 14px, Blink user agent',
    units: 'inner width = box width - 24; twoLines: below this width the prompt needs at least 2 lines; threeLines: at least 3',
  },
  checks: {prompts: breakpoints.length, sweepSamples, lineCountIncreasesAlongWidth: increases, sweepMismatches, randomMismatches, mismatchExamples, milliseconds: Math.round(performance.now() - started)},
  breakpoints,
}
writeFileSync(new URL('caption-breakpoints.json', import.meta.url), `${JSON.stringify(output, null, 1)}\n`)
console.log(JSON.stringify(output.checks))

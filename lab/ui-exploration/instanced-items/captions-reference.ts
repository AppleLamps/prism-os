// Reference for the caption variant: vibescript's photo-gallery layout.ts and prompt-layout.ts
// (frozen as port-layout.ts.txt and port-prompt-layout.ts.txt, vibescript commit f37a575), executed
// natively. Only pretext's rich-inline line walker is replaced: it reports as many lines as the
// breakpoint table says, i.e. 1 + [inner width < twoLines] + [inner width < threeLines]. The table
// itself is checked against pretext's walker by prepare-captions.ts. Everything else, including the
// port's get1DItemSize fixed-point loop, runs as written.
import {readFileSync} from 'node:fs'
import type {CaptionBreakpoints} from './gallery-circuit.ts'
import type {PhotoData} from './photo-data.ts'

export type PortRect = {x: number, y: number, sizeX: number, sizeY: number}
type PortItem = {layoutBox: PortRect, imageBox: PortRect, prompt: {box: PortRect}}
type PortLayout = {
  makeLayoutSources(data: readonly PhotoData[]): unknown[]
  getGridLayout(sources: unknown[], windowSizeX: number): {cols: number, boxMaxSizeX: number, items: PortItem[], contentHeight: number}
  getLineLayout(sources: unknown[], focused: number, windowSizeX: number, windowSizeY: number, scrollY: number): {items: PortItem[]}
}

export function loadCaptionBreakpoints(): CaptionBreakpoints {
  const parsed = JSON.parse(readFileSync(new URL('caption-breakpoints.json', import.meta.url), 'utf8')) as {breakpoints: CaptionBreakpoints}
  return parsed.breakpoints
}

function moduleBody(fileName: string) {
  const code = new Bun.Transpiler({loader: 'ts'}).transformSync(readFileSync(new URL(fileName, import.meta.url), 'utf8'))
  return code.replace(/^import[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, '').replace(/^export\s+/gm, '')
}

export function createPortLayout(photos: readonly PhotoData[], breakpoints: CaptionBreakpoints): PortLayout {
  const byPrompt = new Map<string, {twoLines: number, threeLines: number}>()
  photos.forEach((photo, index) => byPrompt.set(photo.prompt, breakpoints[index]!))
  type Prepared = {lines: (innerWidth: number) => number}
  const prepareRichInline = (items: {text: string}[]): Prepared => {
    const entry = byPrompt.get(items[1]!.text)
    if (entry === undefined) throw new Error('prompt without breakpoints')
    return {lines: innerWidth => 1 + (innerWidth < entry.twoLines ? 1 : 0) + (innerWidth < entry.threeLines ? 1 : 0)}
  }
  const layoutNextRichInlineLineRange = (prepared: Prepared, innerWidth: number, cursor: {line: number} | undefined) => {
    const next = cursor === undefined ? 1 : cursor.line + 1
    return next > prepared.lines(innerWidth) ? null : {end: {line: next}}
  }
  const materializeRichInlineLineRange = () => ({width: 0, fragments: []})
  const promptLayout = new Function(
    'prepareRichInline', 'layoutNextRichInlineLineRange', 'materializeRichInlineLineRange',
    `${moduleBody('port-prompt-layout.ts.txt')}
return {measurePromptLayout, preparePrompt, prompt1DLineHeight, prompt1DMaxLines, prompt2DLineHeight, prompt2DMaxLines, promptPaddingBottom, promptPaddingTop}`,
  )(prepareRichInline, layoutNextRichInlineLineRange, materializeRichInlineLineRange) as Record<string, unknown>
  const names = Object.keys(promptLayout)
  return new Function(...names, `${moduleBody('port-layout.ts.txt')}
return {makeLayoutSources, getGridLayout, getLineLayout}`)(...names.map(name => promptLayout[name])) as PortLayout
}

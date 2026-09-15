// Headless parser for HN comment HTML. It mirrors
// ~/github/vibescript/demos/nicer-hacker-news/hn-comment-parser.ts, which uses a
// DOM <template>; this version tokenizes the serialized innerHTML instead, so it
// runs under bun without a DOM. It only needs to handle what HN emits: text,
// <p>, <a href>, <i>, <pre><code>, and a handful of entities.

export type HNRun =
  | {kind: 'text', text: string}
  | {kind: 'italic', text: string}
  | {kind: 'link', text: string, href: string}

export type HNBlock =
  | {kind: 'paragraph', runs: HNRun[]}
  | {kind: 'codeBlock', text: string}

export type HNCommentDoc = {blocks: HNBlock[]}

type Token =
  | {kind: 'open', tag: string, attributes: string}
  | {kind: 'close', tag: string}
  | {kind: 'text', text: string}

const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    return namedEntities[body] ?? match
  })
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  const tagPattern = /<(\/?)([a-zA-Z]+)([^>]*)>/g
  let last = 0
  for (const match of html.matchAll(tagPattern)) {
    if (match.index > last) tokens.push({kind: 'text', text: html.slice(last, match.index)})
    const tag = match[2]!.toLowerCase()
    if (match[1] === '/') tokens.push({kind: 'close', tag})
    else tokens.push({kind: 'open', tag, attributes: match[3] ?? ''})
    last = match.index + match[0].length
  }
  if (last < html.length) tokens.push({kind: 'text', text: html.slice(last)})
  return tokens
}

// Index of the token that closes the element opened at `openIndex`, honoring nesting of the same tag.
function findClose(tokens: readonly Token[], openIndex: number, tag: string): number {
  let depth = 0
  for (let index = openIndex; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind === 'open' && token.tag === tag) depth++
    else if (token.kind === 'close' && token.tag === tag) {
      depth--
      if (depth === 0) return index
    }
  }
  return tokens.length
}

function textContent(tokens: readonly Token[], start: number, end: number): string {
  let text = ''
  for (let index = start; index < end; index++) {
    const token = tokens[index]!
    if (token.kind === 'text') text += decodeEntities(token.text)
  }
  return text
}

function readHref(attributes: string): string {
  const match = attributes.match(/href="([^"]*)"/)
  return match == null ? '' : decodeEntities(match[1]!)
}

function normalizeInlineWhitespace(text: string) {
  return text.replace(/\s+/g, ' ')
}

function addRun(runs: HNRun[], next: HNRun) {
  const text = normalizeInlineWhitespace(next.text)
  if (text === '') return
  const previous = runs[runs.length - 1]
  if (previous == null) {
    runs.push({...next, text})
    return
  }
  if (previous.kind === next.kind) {
    if (previous.kind === 'link' && next.kind === 'link' && previous.href !== next.href) {
      runs.push({...next, text})
      return
    }
    previous.text += text
    return
  }
  runs.push({...next, text})
}

function trimParagraphRuns(runs: HNRun[]) {
  while (runs.length > 0) {
    const first = runs[0]!
    first.text = first.text.replace(/^\s+/, '')
    if (first.text !== '') break
    runs.shift()
  }
  while (runs.length > 0) {
    const last = runs[runs.length - 1]!
    last.text = last.text.replace(/\s+$/, '')
    if (last.text !== '') break
    runs.pop()
  }
}

function pushParagraphBlock(blocks: HNBlock[], runs: HNRun[]) {
  trimParagraphRuns(runs)
  if (runs.length > 0) blocks.push({kind: 'paragraph', runs})
}

// Inline content: text, <a>, <i>. Returns the index after the last consumed token.
function parseInline(tokens: readonly Token[], start: number, end: number, runs: HNRun[]) {
  let index = start
  while (index < end) {
    const token = tokens[index]!
    if (token.kind === 'text') {
      addRun(runs, {kind: 'text', text: decodeEntities(token.text)})
      index++
    } else if (token.kind === 'open' && token.tag === 'a') {
      const close = findClose(tokens, index, 'a')
      addRun(runs, {kind: 'link', href: readHref(token.attributes), text: textContent(tokens, index + 1, close)})
      index = close + 1
    } else if (token.kind === 'open' && token.tag === 'i') {
      const close = findClose(tokens, index, 'i')
      addRun(runs, {kind: 'italic', text: textContent(tokens, index + 1, close)})
      index = close + 1
    } else if (token.kind === 'close') {
      index++
    } else {
      throw new Error(`Unsupported HN inline tag <${token.tag}>`)
    }
  }
}

export function parseHNCommentHTML(html: string): HNCommentDoc {
  const tokens = tokenize(html)
  const blocks: HNBlock[] = []
  let currentRuns: HNRun[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token.kind === 'open' && token.tag === 'p') {
      pushParagraphBlock(blocks, currentRuns)
      currentRuns = []
      const close = findClose(tokens, index, 'p')
      const runs: HNRun[] = []
      parseInline(tokens, index + 1, close, runs)
      pushParagraphBlock(blocks, runs)
      index = close + 1
    } else if (token.kind === 'open' && token.tag === 'pre') {
      pushParagraphBlock(blocks, currentRuns)
      currentRuns = []
      const close = findClose(tokens, index, 'pre')
      const text = textContent(tokens, index + 1, close)
      if (text !== '') blocks.push({kind: 'codeBlock', text})
      index = close + 1
    } else {
      // Root-level inline content joins the current paragraph.
      const next = findNextBlockStart(tokens, index)
      parseInline(tokens, index, next, currentRuns)
      index = next
    }
  }
  pushParagraphBlock(blocks, currentRuns)
  return {blocks}
}

function findNextBlockStart(tokens: readonly Token[], start: number) {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind === 'open' && (token.tag === 'p' || token.tag === 'pre')) return index
    if (token.kind === 'open' && (token.tag === 'a' || token.tag === 'i')) index = findClose(tokens, index, token.tag)
  }
  return tokens.length
}

export function commentPlainText(doc: HNCommentDoc): string {
  return doc.blocks.map(block => block.kind === 'paragraph' ? block.runs.map(run => run.text).join('') : block.text).join('\n')
}

// The review's independent count: what the kernels returned for every document (answers-run.ts) against answers that
// share no code with expected.ts or with the lab's automaton. Only the document generator is shared.
//
//   bun lab/json-search/million/independent.ts --answers <the folder that answers-run.ts wrote>
//
// The answers computed here, per document:
//   everything   new RegExp(pattern, 'g') over the whole text: how many matches, and whether there is one
//   strings      JSON.parse, then every string value under the document, the same RegExp on each
//   keys         the same on every key
//   raw strings  the string tokens of the text as written, with their quotes and escapes, split into keys (a token
//   and raw keys followed by a colon) and values. A kernel's scope reads the text as written, so it agrees with these
//                where it disagrees with the parsed values, e.g. for `Müller` in a document that writes \u00fc
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {argument, required} from '../gpu/chrome.ts'
import {documentText} from '../../../src/json-search/demo-text.ts'
import type {Answer, AnswersConfig} from './answers-page.ts'

const folder = required('--answers')
const run = JSON.parse(readFileSync(join(folder, 'answers.json'), 'utf8')) as {page: {config: AnswersConfig, answers: Answer[], error?: string, uncapturedError?: string, finishedAt?: string}}
if (run.page.error !== undefined || run.page.uncapturedError !== undefined || run.page.finishedAt === undefined) throw new Error(`the answers' run didn't finish: ${run.page.error ?? run.page.uncapturedError ?? 'no end'}`)
const {count, patterns} = run.page.config
const only = argument('--pattern')

const sets = ['everything', 'strings', 'keys', 'rawStrings', 'rawKeys'] as const
type SetName = typeof sets[number]
const words = Math.ceil(count / 32)
const mine = patterns.map(source => ({
  source,
  global: new RegExp(source, 'g'),
  bits: Object.fromEntries(sets.map(name => [name, new Uint32Array(words)])) as Record<SetName, Uint32Array>,
  documents: Object.fromEntries(sets.map(name => [name, 0])) as Record<SetName, number>,
  matches: Object.fromEntries(sets.map(name => [name, 0])) as Record<SetName, number>,
}))

// Every string value and every key of a parsed document.
function stringsOf(root: unknown, values: string[], keys: string[]) {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === 'string') values.push(value)
    else if (Array.isArray(value)) stack.push(...(value as unknown[]))
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        keys.push(key)
        stack.push(item)
      }
    }
  }
}

// The string tokens of the text as written. A token followed by a colon is a key.
const token = /"(?:[^"\\]|\\.)*"/g
function rawStringsOf(text: string, values: string[], keys: string[]) {
  token.lastIndex = 0
  for (let match = token.exec(text); match !== null; match = token.exec(text)) {
    let after = token.lastIndex
    while (after < text.length && ' \n\t\r'.includes(text[after]!)) after++
    if (text[after] === ':') keys.push(match[0])
    else values.push(match[0])
  }
}

function countMatches(pattern: RegExp, text: string) {
  pattern.lastIndex = 0
  let found = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found++
    if (match[0].length === 0) pattern.lastIndex++
  }
  return found
}

for (let index = 0; index < count; index++) {
  const text = documentText(index)
  const values: string[] = []
  const keys: string[] = []
  stringsOf(JSON.parse(text), values, keys)
  const rawValues: string[] = []
  const rawKeys: string[] = []
  rawStringsOf(text, rawValues, rawKeys)
  const sum = (pattern: RegExp, texts: readonly string[]) => texts.reduce((total, item) => total + countMatches(pattern, item), 0)
  for (const entry of mine) {
    if (only !== undefined && entry.source !== only) continue
    const found: Record<SetName, number> = {everything: countMatches(entry.global, text), strings: sum(entry.global, values), keys: sum(entry.global, keys), rawStrings: sum(entry.global, rawValues), rawKeys: sum(entry.global, rawKeys)}
    for (const name of sets) {
      if (found[name] === 0) continue
      entry.bits[name][index >> 5]! |= 1 << (index & 31)
      entry.documents[name]++
      entry.matches[name] += found[name]
    }
  }
}

function popCount(value: number) {
  let bits = value >>> 0
  let total = 0
  while (bits !== 0) {
    bits &= bits - 1
    total++
  }
  return total
}
const differing = (left: Uint32Array, right: Uint32Array) => left.reduce((total, word, index) => total + popCount(word ^ right[index]!), 0)
const thousands = (value: number) => value.toLocaleString('en-US')

const rows = ['| Pattern | The search reads | Kernels compared | Documents with a match, by RegExp and JSON.parse | Documents where a kernel answers differently | The same against the string tokens as written | Matches, by RegExp | By the count kernels |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
// The report's six patterns, and the totals for them and for the patterns that answers-run.ts adds.
const reportPatterns = ['error', '[a-z]+Id', '[a-z0-9.]+@[a-z.]+', '\\d\\d\\d\\d-\\d\\d-\\d\\d', '([a-z]+)+x', 'connection reset']
const totals = {report: {searches: 0, differ: 0}, addedWhole: {searches: 0, differ: 0}, addedScoped: {searches: 0, differ: 0, differRaw: 0}}
for (const [patternIndex, entry] of mine.entries()) {
  if (only !== undefined && entry.source !== only) continue
  for (const scope of ['everything', 'strings', 'keys'] as const) {
    const answers = run.page.answers.filter(answer => answer.patternIndex === patternIndex && answer.scope === scope)
    const raw = scope === 'strings' ? 'rawStrings' : scope === 'keys' ? 'rawKeys' : undefined
    let differ = 0
    let differRaw = 0
    const kernelMatches = new Set<number>()
    for (const answer of answers) {
      const bytes = readFileSync(join(folder, `${answer.file}.bin`))
      const values = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      let bits = values
      if (answer.output === 'count') {
        if (values.length !== count) throw new Error(`${answer.file} holds ${values.length} counts`)
        bits = new Uint32Array(words)
        let matches = 0
        for (let index = 0; index < count; index++) {
          if (values[index]! > 0) bits[index >> 5]! |= 1 << (index & 31)
          matches += values[index]!
        }
        kernelMatches.add(matches)
      } else if (values.length !== words) throw new Error(`${answer.file} holds ${values.length} words`)
      differ += differing(bits, entry.bits[scope])
      if (raw !== undefined) differRaw += differing(bits, entry.bits[raw])
      const group = reportPatterns.includes(entry.source) ? totals.report : scope === 'everything' ? totals.addedWhole : totals.addedScoped
      group.searches++
      group.differ += differing(bits, entry.bits[scope])
      if (raw !== undefined && group === totals.addedScoped) totals.addedScoped.differRaw += differing(bits, entry.bits[raw])
    }
    rows.push(`| \`${entry.source.replaceAll('|', '\\|')}\` | ${scope === 'strings' ? 'string values' : scope} | ${answers.length} | ${thousands(entry.documents[scope])} | ${thousands(differ)} | ${raw === undefined ? '' : thousands(differRaw)} | ${thousands(entry.matches[scope])}${raw === undefined || entry.matches[raw] === entry.matches[scope] ? '' : `, and ${thousands(entry.matches[raw])} in the tokens as written`} | ${[...kernelMatches].map(thousands).join(', ')} |`)
  }
}
console.log(rows.join('\n'))
const added = patterns.filter(source => !reportPatterns.includes(source)).map(source => `\`${source}\``).join(' and ')
console.log(`\nThe report's six patterns: ${thousands(totals.report.searches)} searches, ${thousands(totals.report.searches * count)} documents' answers, ${thousands(totals.report.differ)} differ.`)
console.log(`${added}: ${thousands(totals.addedWhole.searches)} searches over the whole text, ${thousands(totals.addedWhole.searches * count)} answers, ${thousands(totals.addedWhole.differ)} differ. ${thousands(totals.addedScoped.searches)} searches inside string values or keys, ${thousands(totals.addedScoped.searches * count)} answers, of which ${thousands(totals.addedScoped.differ)} differ from the parsed values and ${thousands(totals.addedScoped.differRaw)} from the string tokens as written.`)

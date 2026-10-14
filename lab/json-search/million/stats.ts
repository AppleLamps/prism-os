// What the compact layouts do to the generated documents and to the page's patterns, without a GPU: how many
// documents hold a code point that a byte can't keep, how long the documents are as UTF-8, how many bytes each layout
// takes, and which patterns find the same matches on bytes as on code points.
//
//   bun lab/json-search/million/stats.ts [--count 1000000]
import {compilePattern} from '../../../src/json-search/regex/pattern.ts'
import {bitRowTables, createBitRowSearch} from '../../../tests/json-search/bit-rows.ts'
import {documentText} from '../../../src/json-search/demo-text.ts'
import {cellsPerDocument} from '../../../src/json-search/program.ts'
import {bytesPerDocument, packPacked, patternIsExactOnBytes, scopeWordsPerDocument} from './layouts.ts'

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const count = Number(argument('--count') ?? 1_000_000)
const encoder = new TextEncoder()
const started = performance.now()
let characters = 0
let codePoints = 0
let pastAscii = 0
let pastByte = 0
let utf8Bytes = 0
let longestUtf8 = 0
let utf8Past512 = 0
let packedBytes = 0
let longest = 0
// `東京` reads two code points that both become byte 255, so on bytes it would also find any other two such neighbors.
const kanji = compilePattern('東京')
const kanjiSearch = createBitRowSearch(bitRowTables(kanji, 8), 512)
const stored255 = `[${String.fromCodePoint(0xfe)}-${String.fromCodePoint(0x10ffff)}]`
const anyTwo = createBitRowSearch(bitRowTables(compilePattern(stored255 + stored255), 8), 512)
let kanjiDocuments = 0
let anyTwoDocuments = 0
const piece = 20_000
for (let first = 0; first < count; first += piece) {
  const texts = Array.from({length: Math.min(piece, count - first)}, (_, index) => documentText(first + index))
  for (const text of texts) {
    characters += text.length
    const length = Array.from(text).length
    codePoints += length
    longest = Math.max(longest, length)
    if (/[\u0080-\u{10ffff}]/u.test(text)) pastAscii++
    if (/[\u00fe-\u{10ffff}]/u.test(text)) pastByte++
    const bytes = encoder.encode(text).length
    utf8Bytes += bytes
    longestUtf8 = Math.max(longestUtf8, bytes)
    if (bytes > 512) utf8Past512++
    if (kanjiSearch(text) > 0) kanjiDocuments++
    if (anyTwo(text) > 0) anyTwoDocuments++
  }
  packedBytes += packPacked(texts).bytes.length
}
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`
console.log(`${count.toLocaleString('en-US')} documents, written and measured in ${((performance.now() - started) / 1000).toFixed(1)} s`)
console.log(`- ${characters.toLocaleString('en-US')} UTF-16 units, ${codePoints.toLocaleString('en-US')} code points, ${(codePoints / count).toFixed(1)} per document, the longest ${longest}`)
console.log(`- ${pastAscii.toLocaleString('en-US')} documents hold a code point past U+007F, and ${pastByte.toLocaleString('en-US')} hold one past U+00FD, which a byte stores as 255`)
console.log(`- as UTF-8: ${utf8Bytes.toLocaleString('en-US')} bytes, the longest document ${longestUtf8} bytes, ${utf8Past512.toLocaleString('en-US')} documents longer than 512 bytes`)
console.log(`- one f32 per code point: ${megabytes(count * cellsPerDocument * 4)}, and as much again for the display kinds`)
console.log(`- 512 bytes per document: ${megabytes(count * bytesPerDocument)}. Packed, each document padded to 4 bytes: ${megabytes(packedBytes)}, and ${megabytes((count + 1) * 4)} for where each document starts`)
console.log(`- 2 scope bits per position: ${megabytes(count * scopeWordsPerDocument * 4)}. One match count per document: ${megabytes(count * 4)}. One bit per document: ${(count / 8 / 1e3).toFixed(0)} KB`)
console.log('')
console.log('| Pattern | States | Classes | Class boundaries | The largest boundary | The same matches on bytes |')
console.log('| --- | --- | --- | --- | --- | --- |')
for (const pattern of ['error', '[a-z]+Id', '[a-z0-9.]+@[a-z.]+', '\\d\\d\\d\\d-\\d\\d-\\d\\d', '([a-z]+)+x', 'connection reset', '"[^"]+"', 'Müller', '.+', '東京']) {
  const compiled = compilePattern(pattern)
  const {boundaries} = compiled.partition
  console.log(`| \`${pattern.replaceAll('|', '\\|')}\` | ${compiled.automaton.stateCount} | ${compiled.partition.classCount} | ${boundaries.length} | U+${(boundaries.at(-1) ?? 0).toString(16).toUpperCase().padStart(4, '0')} | ${patternIsExactOnBytes(compiled) ? 'yes' : 'no'} |`)
}
console.log('')
console.log(`\`東京\` has a match in ${kanjiDocuments.toLocaleString('en-US')} documents. On bytes, where both of its code points are 255, a kernel could at best find two neighbors of 255, which ${anyTwoDocuments.toLocaleString('en-US')} documents have.`)

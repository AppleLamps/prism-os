// The compact layouts of the documents on the GPU that the million-document check measures, next to today's layout of
// one f32 per code point (program.ts's writeDocumentCells, 513 cells and 2,052 bytes per document).
//
// What a byte is here: one code point per byte, as code point + 1, with 0 for a position past the text's end, and 255
// for every code point from 254 up. So a document is 512 bytes, 128 words of 32 bits, a position is still a code point,
// and the highlighter's answer for a position is the answer for the same byte. What that does to a pattern: a class
// boundary above 254 can't be told on bytes, e.g. `東京` reads two code points that both become 255. A pattern whose
// class boundaries all lie at 254 or below finds the same matches as on code points, e.g. every pattern over ASCII,
// `[^"]+` and `Müller`. patternIsExactOnBytes says which case a pattern is.
//
// The other choice, UTF-8 bytes, keeps every code point, and costs three things: a pattern has to be compiled to an
// automaton over bytes, e.g. `[^"]` becomes four alternatives of 1 to 4 bytes; a document of 512 code points can be up
// to 2,048 bytes, so a fixed size per document wastes or cuts; and a position is no longer a code point, so the
// highlighter has to run on bytes too. stats.ts counts how many generated documents each choice affects.
import {capacity, displayKind} from '../../../src/json-highlighter/kinds.ts'
import type {CompiledPattern} from '../../regex-search/pattern.ts'
import type {BitRowTables} from '../bit-rows.ts'
import {boundaryCapacity, classCapacity} from '../search-step.ts'

export const positions = capacity
export const bytesPerDocument = positions
export const wordsPerDocument = positions / 4
// Two bits per position: bit 0 for a character of a key, bit 1 for a character of a string value. 16 positions a word.
export const scopeWordsPerDocument = positions / 16
export const scopeMasks = {everything: 0, keys: 1, strings: 2} as const
export type ScopeName = keyof typeof scopeMasks
export const scopeNames = ['everything', 'keys', 'strings'] as const

const otherByte = 255
const largestOwnCodePoint = 253

// Writes a text's first 512 code points at bytes[offset], and returns how many it wrote. The bytes after them stay as
// they are, so the caller passes zeroed bytes. A surrogate pair is one code point.
export function writeDocumentBytes(bytes: Uint8Array, offset: number, text: string): number {
  const unitCount = text.length
  let length = 0
  for (let unit = 0; unit < unitCount && length < positions; unit++) {
    const codeUnit = text.charCodeAt(unit)
    if (codeUnit <= largestOwnCodePoint) {
      bytes[offset + length++] = codeUnit + 1
      continue
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && unit + 1 < unitCount && (text.charCodeAt(unit + 1) & 0xfc00) === 0xdc00) unit++
    bytes[offset + length++] = otherByte
  }
  return length
}

// The fixed layout: 512 bytes per document, zero after the text.
export function packFixed(texts: readonly string[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(texts.length * bytesPerDocument)
  for (let row = 0; row < texts.length; row++) writeDocumentBytes(bytes, row * bytesPerDocument, texts[row]!)
  return bytes
}

// The packed layout: the documents' bytes one after the other, each document padded with zeros to a whole word, and
// the word where each document starts, with one more entry for the end of the last one. `firstWord` is where this
// piece starts in the whole buffer, so that pieces packed by different workers join.
export function packPacked(texts: readonly string[], firstWord = 0): {bytes: Uint8Array<ArrayBuffer>, starts: Uint32Array<ArrayBuffer>, words: number} {
  const fixed = new Uint8Array(bytesPerDocument)
  const starts = new Uint32Array(texts.length + 1)
  const bytes = new Uint8Array(texts.length * bytesPerDocument)
  let at = 0
  for (let row = 0; row < texts.length; row++) {
    starts[row] = firstWord + at / 4
    // The length in code points isn't known before writing, so a document is written at the capacity's size first.
    fixed.fill(0)
    const length = writeDocumentBytes(fixed, 0, texts[row]!)
    const padded = Math.ceil(length / 4) * 4
    bytes.set(fixed.subarray(0, padded), at)
    at += padded
  }
  starts[texts.length] = firstWord + at / 4
  return {bytes: bytes.slice(0, at), starts, words: at / 4}
}

// The scope bits of documents from their display kinds, 512 kinds per document, as table-loop.ts's highlightWithTables
// writes them: 2 bits per position, bit 0 for a key's character and bit 1 for a string value's, with their quotes, the
// kinds that search-step.ts's scopes 'keys' and 'strings' read.
export function packScopeBits(kinds: Uint8Array, documentCount: number, words: Uint32Array, firstDocument = 0) {
  for (let row = 0; row < documentCount; row++) {
    const kindBase = row * positions
    const wordBase = (firstDocument + row) * scopeWordsPerDocument
    for (let word = 0; word < scopeWordsPerDocument; word++) {
      let bits = 0
      for (let index = 0; index < 16; index++) {
        const kind = kinds[kindBase + word * 16 + index]!
        if (kind === displayKind.key) bits |= 1 << (index * 2)
        else if (kind === displayKind.string) bits |= 2 << (index * 2)
      }
      words[wordBase + word] = bits
    }
  }
}

// Whether a pattern finds the same matches on bytes as on code points: no class boundary above 254.
export function patternIsExactOnBytes(compiled: CompiledPattern) {
  return compiled.partition.boundaries.every(boundary => boundary <= largestOwnCodePoint + 1)
}

// The tables of one pattern for the kernels of kernels.ts, which read bytes: bit-rows.ts's tables with the class
// boundaries in byte values, and after them the class of each of the 256 byte values, for a kernel that reads the class
// with one table read instead of 32 comparisons.
//   [0, 32)            the boundaries as byte values, 256 for one that no byte reaches
//   [32, 65)           the class of each region, 16 for a region that no step reads
//   [65, 321)          the class of each byte value, 16 for byte 0, a position past the text's end
//   then               the rows, the columns and the accepting states, as in bit-rows.ts
export const byteClassOffset = 2 * boundaryCapacity + 1
export const byteRowsOffset = byteClassOffset + 256
export const byteColumnsOffset = (states: number) => byteRowsOffset + (classCapacity + 1) * states
export const byteAcceptingOffset = (states: number) => byteColumnsOffset(states) + (classCapacity + 1) * states
export const byteTableLength = (states: number) => byteAcceptingOffset(states) + 1

export function byteTables({tables, states, regionsOffset, rowsOffset, acceptingOffset}: BitRowTables): Uint32Array<ArrayBuffer> {
  const result = new Uint32Array(byteTableLength(states))
  for (let index = 0; index < boundaryCapacity; index++) result[index] = Math.min(256, tables[index]! + 1)
  for (let region = 0; region <= boundaryCapacity; region++) result[boundaryCapacity + region] = tables[regionsOffset + region]!
  result[byteClassOffset] = classCapacity
  for (let byte = 1; byte < 256; byte++) {
    let region = 0
    while (region < boundaryCapacity && byte >= result[region]!) region++
    result[byteClassOffset + byte] = result[boundaryCapacity + region]!
  }
  result.set(tables.subarray(rowsOffset, acceptingOffset + 1), byteRowsOffset)
  return result
}

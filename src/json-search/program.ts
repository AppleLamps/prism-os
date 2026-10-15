// A document's cells, as both programs of the page read them: the first 512 code points, -1 past the text, and the
// text's length in code points. That is 513 float32 values, 2,052 bytes.
import {capacity} from './highlighter/kinds.ts'

export const cellsPerDocument = capacity + 1

// The largest text length that is written. A longer text writes this length, which still reads as longer than 512.
// json-step.ts declares the length's cell with this limit.
const lengthLimit = 1_048_576

// Writes one document's cells at `offset`: the first 512 code points, -1 after them, and the whole text's length. A
// surrogate pair is one code point, and a lone surrogate is its own code point.
export function writeDocumentCells(cells: Float32Array, offset: number, text: string) {
  const unitCount = text.length
  let length = 0
  for (let index = 0; index < unitCount; index++) {
    let codePoint = text.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < unitCount) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        index++
      }
    }
    if (length < capacity) cells[offset + length] = codePoint
    length++
  }
  for (let position = Math.min(length, capacity); position < capacity; position++) cells[offset + position] = -1
  cells[offset + capacity] = Math.min(length, lengthLimit)
}

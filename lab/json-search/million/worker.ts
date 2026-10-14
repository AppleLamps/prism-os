// The worker of the million-document check's page, with the two jobs that a page would give to workers:
//
// 'load'    writes pieces of the documents, and for each piece posts the bytes of a compact layout and the scope bits,
//           as transferred buffers, so that the page's thread only uploads them. The scope bits come from table-loop.ts's
//           plain JavaScript highlighter.
// 'hold'    writes a share of the documents and keeps their texts, and then answers 'filter' with
//           texts.filter(text => pattern.test(text)).length, the whole-text search in several workers.
import {documentText} from '../demo-text.ts'
import {highlightWithTables} from '../table-loop.ts'
import {packFixed, packPacked, packScopeBits, positions, scopeWordsPerDocument} from './layouts.ts'

export type LoadRequest = {
  kind: 'load'
  // The pieces this worker writes, in order.
  pieces: {firstDocument: number, documentCount: number}[]
  layout: 'fixed' | 'packed'
  scopeBits: boolean
}
export type LoadedPiece = {
  kind: 'piece'
  firstDocument: number
  documentCount: number
  bytes: Uint8Array<ArrayBuffer>
  // For the packed layout: the word where each document starts within this piece, and one more for the piece's end.
  starts: Uint32Array<ArrayBuffer> | undefined
  scopeWords: Uint32Array<ArrayBuffer> | undefined
  // Where this worker's time went for the piece, in ms.
  generateMs: number
  packMs: number
  highlightMs: number
}
export type HoldRequest = {kind: 'hold', firstDocument: number, documentCount: number}
export type FilterRequest = {kind: 'filter', pattern: string, flags: boolean}
export type FilterAnswer = {kind: 'filtered', matching: number, ms: number, flags: Uint8Array<ArrayBuffer> | undefined}

let held: string[] = []

addEventListener('message', event => {
  const request = event.data as LoadRequest | HoldRequest | FilterRequest
  if (request.kind === 'load') {
    const kinds = new Uint8Array(Math.max(...request.pieces.map(piece => piece.documentCount)) * positions)
    for (const {firstDocument, documentCount} of request.pieces) {
      const started = performance.now()
      const texts = Array.from({length: documentCount}, (_, index) => documentText(firstDocument + index))
      const generated = performance.now()
      const packed = request.layout === 'packed' ? packPacked(texts) : undefined
      const bytes = packed?.bytes ?? packFixed(texts)
      const packedAt = performance.now()
      let scopeWords: Uint32Array<ArrayBuffer> | undefined
      if (request.scopeBits) {
        for (let row = 0; row < documentCount; row++) highlightWithTables(texts[row]!, kinds, row * positions)
        scopeWords = new Uint32Array(documentCount * scopeWordsPerDocument)
        packScopeBits(kinds, documentCount, scopeWords)
      }
      const piece: LoadedPiece = {
        kind: 'piece', firstDocument, documentCount, bytes, starts: packed?.starts, scopeWords,
        generateMs: generated - started, packMs: packedAt - generated, highlightMs: performance.now() - packedAt,
      }
      postMessage(piece, {transfer: [bytes.buffer, ...(packed === undefined ? [] : [packed.starts.buffer]), ...(scopeWords === undefined ? [] : [scopeWords.buffer])]})
    }
    postMessage({kind: 'loaded'})
  } else if (request.kind === 'hold') {
    held = Array.from({length: request.documentCount}, (_, index) => documentText(request.firstDocument + index))
    postMessage({kind: 'holding', documents: held.length})
  } else {
    const pattern = new RegExp(request.pattern, 'u')
    const started = performance.now()
    const matching = held.filter(text => pattern.test(text)).length
    const ms = performance.now() - started
    // Which documents match, for the check, outside the timed part.
    const flags = request.flags ? Uint8Array.from(held, text => pattern.test(text) ? 1 : 0) : undefined
    const answer: FilterAnswer = {kind: 'filtered', matching, ms, flags}
    postMessage(answer, {transfer: flags === undefined ? [] : [flags.buffer]})
  }
})

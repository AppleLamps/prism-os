// The tables JS writes into the circuit's source table. Static ones are written once: a two-level
// table from code point to line break class, one table per class property, and the pair table of
// break bits. The advance table is font data: JS measures a code point the first time it appears
// and writes its advance into a page of 128 entries, e.g. typing 字 (U+5B57) fills one entry of the
// page that holds U+5B00..U+5B7F.

import {breaksBetween, classCount, classesMayBreakInside, classHangs, classIsNewline, classIsWord, classOfCodePoint} from './line-break-classes.ts'

export const pageBits = 7
export const pageSize = 1 << pageBits
export const codePointLimit = 0x110000
export const codePointMaximum = codePointLimit - 1
export const blockCount = codePointLimit >> pageBits
export const advanceLimit = 1024

// blockOffsets[block] = page * 128 - block * 128, so a code point's entry sits at
// blockOffsets[floor(codePoint / 128)] + codePoint. For example U+5B57 is in block 182; if that
// block's classes are on page 12, the class is pages[(12 - 182) * 128 + 0x5B57]. The second index
// is a sum of two exact integers, so it needs no floor and no remainder.
export type ClassTables = {
  blockOffsets: number[]
  pages: number[]
  pageCount: number
  // How long the first call took to build the tables. Later calls return the same tables.
  buildMilliseconds: number
}

let cachedClassTables: ClassTables | null = null

// Blocks with identical classes share a page, e.g. every block of CJK ideographs.
export function classTables(): ClassTables {
  if (cachedClassTables !== null) return cachedClassTables
  const buildStart = performance.now()
  const pageByContent = new Map<string, number>()
  const pages: number[] = []
  const blockOffsets: number[] = []
  const page = Array<number>(pageSize).fill(0)
  for (let block = 0; block < blockCount; block++) {
    for (let low = 0; low < pageSize; low++) page[low] = classOfCodePoint(block * pageSize + low)
    const key = page.join(',')
    let pageIndex = pageByContent.get(key)
    if (pageIndex === undefined) {
      pageIndex = pageByContent.size
      pageByContent.set(key, pageIndex)
      for (const lineBreakClass of page) pages.push(lineBreakClass)
    }
    blockOffsets.push((pageIndex - block) * pageSize)
  }
  cachedClassTables = {blockOffsets, pages, pageCount: pageByContent.size, buildMilliseconds: performance.now() - buildStart}
  return cachedClassTables
}

// The same two reads in JS, for tests.
export function readClassTable(tables: ClassTables, codePoint: number): number {
  return tables.pages[tables.blockOffsets[Math.floor(codePoint / pageSize)]! + codePoint]!
}

export type PropertyTables = {
  // 1 for spaces and newlines: neither counts toward a line's fit edge (a newline gets its own edge
  // through the newline offset in the position keys).
  spaceOrNewline: number[]
  newline: number[]
  word: number[]
  // pairs[before * classCount + after] is 1 when a line may break between the two classes.
  pairs: number[]
  // emergencyPairs[before * classCount + after] is 1 when a run that doesn't fit on a line by itself
  // may break between the two classes.
  emergencyPairs: number[]
}

export function propertyTables(): PropertyTables {
  const classes = Array.from({length: classCount}, (_, lineBreakClass) => lineBreakClass)
  const bit = (value: boolean) => (value ? 1 : 0)
  return {
    spaceOrNewline: classes.map(lineBreakClass => bit(classHangs(lineBreakClass) || classIsNewline(lineBreakClass))),
    newline: classes.map(lineBreakClass => bit(classIsNewline(lineBreakClass))),
    word: classes.map(lineBreakClass => bit(classIsWord(lineBreakClass))),
    pairs: classes.flatMap(before => classes.map(after => bit(breaksBetween(before, after)))),
    emergencyPairs: classes.flatMap(before => classes.map(after => bit(classesMayBreakInside(before, after)))),
  }
}

// Measures one code point in layout units, e.g. quarter pixels. The result is rounded and clamped to
// 0..1023. Newlines and the empty cell always have advance 0.
export type MeasureCodePoint = (codePoint: number) => number

export function advanceUnits(measure: MeasureCodePoint, codePoint: number): number {
  if (codePoint === 0 || codePoint === 0x0A) return 0
  return Math.min(advanceLimit - 1, Math.max(0, Math.round(measure(codePoint))))
}

export type AdvanceTable = {
  pageLimit: number
  // Blocks nobody has typed in point at page 0, which stays all zero.
  blockOffsets: number[]
  pages: number[]
  // Code points measured so far, in first-use order.
  seen: readonly number[]
  pagesInUse: () => number
  // Measures a code point the first time it appears. Returns false when its block needs a page and
  // every page is taken.
  ensure: (codePoint: number) => boolean
  advanceOf: (codePoint: number) => number
  // A font change: measures every code point seen so far again. Nothing else changes.
  remeasure: (measure: MeasureCodePoint) => {rewrittenEntries: number, changedEntries: number}
  // Indices written since the last call, so JS copies only those cells into the source table.
  takeWrittenBlocks: () => number[]
  takeWrittenEntries: () => number[]
}

export function createAdvanceTable(pageLimit: number, measure: MeasureCodePoint): AdvanceTable {
  if (pageLimit < 2) throw new Error('an advance table needs page 0 and at least one page to fill')
  const blockOffsets = Array.from({length: blockCount}, (_, block) => -block * pageSize)
  const pages = Array<number>(pageLimit * pageSize).fill(0)
  const pageOfBlock = new Map<number, number>()
  const measured = new Set<number>()
  const seen: number[] = []
  let currentMeasure = measure
  let writtenBlocks = new Set<number>(blockOffsets.keys())
  let writtenEntries = new Set<number>()
  const entryOf = (codePoint: number) => blockOffsets[codePoint >> pageBits]! + codePoint
  return {
    pageLimit,
    blockOffsets,
    pages,
    seen,
    pagesInUse: () => pageOfBlock.size + 1,
    ensure: codePoint => {
      if (codePoint === 0 || measured.has(codePoint)) return true
      const block = codePoint >> pageBits
      if (!pageOfBlock.has(block)) {
        if (pageOfBlock.size + 1 >= pageLimit) return false
        const page = pageOfBlock.size + 1
        pageOfBlock.set(block, page)
        blockOffsets[block] = (page - block) * pageSize
        writtenBlocks.add(block)
      }
      const entry = entryOf(codePoint)
      pages[entry] = advanceUnits(currentMeasure, codePoint)
      writtenEntries.add(entry)
      measured.add(codePoint)
      seen.push(codePoint)
      return true
    },
    advanceOf: codePoint => pages[entryOf(codePoint)]!,
    remeasure: nextMeasure => {
      currentMeasure = nextMeasure
      let changedEntries = 0
      for (const codePoint of seen) {
        const entry = entryOf(codePoint)
        const units = advanceUnits(nextMeasure, codePoint)
        if (pages[entry] !== units) changedEntries++
        pages[entry] = units
        writtenEntries.add(entry)
      }
      return {rewrittenEntries: seen.length, changedEntries}
    },
    takeWrittenBlocks: () => {
      const blocks = [...writtenBlocks]
      writtenBlocks = new Set()
      return blocks
    },
    takeWrittenEntries: () => {
      const entries = [...writtenEntries]
      writtenEntries = new Set()
      return entries
    },
  }
}

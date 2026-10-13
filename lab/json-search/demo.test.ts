// The demo page's parts that need no browser: the map's geometry and pixels (demo-map.ts), the page's sentences and
// the choice of the document count (demo-text.ts), and the comparison's baselines (demo-baselines.ts).
// Run from the repo root: bun test lab/json-search/demo.test.ts
import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {capacity, displayKind, errorKind} from '../../src/json-highlighter/kinds.ts'
import {createBaselines} from './demo-baselines.ts'
import {
  type MapLayout, blockGapCss, groupDocuments, labelBandCss, mapGrid, mapLayout, markCenterCss, markOffsets, matchesByGroup, nextDocumentWithMatch,
  nominalGroupSizes, paintMarks, positionAt,
} from './demo-map.ts'
import {
  type ComparisonNumbers, type Line, analyzePattern, checkLine, comparisonCells, comparisonVerdict, count, cpuDocumentCount, documentLine, documentRuns,
  documentsThatFit, duration, groupNames, loadNotice, perDocument, programLines, resultLine, roughDuration, runClassName, scopeChoiceOf, validitySentence,
  wantedDocumentCount,
} from './demo-text.ts'
import {generateDocuments, shapes} from './documents.ts'
import {createPlainSearch} from './plain-search.ts'
import {bufferBytesFor, createCpuSearcher} from './searcher.ts'

const text = (line: Line) => line.map(part => typeof part === 'string' ? part : part.strong).join('')
const layoutFor = (widthCss: number, scale: number, groupSizes: readonly number[], nominalSizes: readonly number[] = groupSizes) =>
  mapLayout(mapGrid(widthCss, scale, nominalSizes), groupSizes, nominalSizes)

// The generated documents' groups at 100,000 documents are within 1% of these.
const sizesAt100000 = [12_790, 12_950, 12_843, 12_880, 12_760, 12_900, 12_820, 10_057]

describe('the map of every document', () => {
  test('groups valid documents by their shape and puts the documents with an error last, each group in the documents\' order', () => {
    const shapeOf = Uint8Array.from([2, 0, 1, 0, 2, 1, 0])
    const valid = Uint8Array.from([1, 1, 0, 1, 0, 1, 1])
    const {order, positionOf, groupOf, groupSizes} = groupDocuments(shapeOf, valid, 3)
    expect(groupSizes).toEqual([3, 1, 1, 2])
    expect([...order]).toEqual([1, 3, 6, 5, 0, 2, 4])
    expect([...groupOf]).toEqual([2, 0, 3, 0, 3, 1, 0])
    order.forEach((index, position) => expect(positionOf[index]).toBe(position))
  })

  test('gives every document its own mark inside the map, at every width and screen', () => {
    for (const [widthCss, scale, groupSizes] of [[1070, 2, sizesAt100000], [1070, 1, sizesAt100000], [1070, 3, sizesAt100000], [942, 2, sizesAt100000], [640, 1, sizesAt100000], [324, 3, [2580, 2590, 2560, 2600, 2570, 2550, 2540, 2010]], [324, 2, [70, 55, 66, 71, 60, 64, 62, 52]], [1070, 2, [70, 55, 66, 71, 60, 64, 62, 52]], [200, 1, [0, 3, 0, 1, 0, 0, 2, 0]]] as const) {
      const layout = layoutFor(widthCss, scale, groupSizes)
      const documentCount = groupSizes.reduce((total, size) => total + size, 0)
      const offsets = markOffsets(layout)
      expect(offsets.length).toBe(documentCount)
      expect(layout.width).toBe(widthCss * scale)
      // Every mark lies inside the canvas, no two marks share a pixel, and a mark's first pixel is the mark's own.
      const owner = new Int32Array(layout.width * layout.height).fill(-1)
      for (let position = 0; position < documentCount; position++) {
        const offset = offsets[position]!
        const x = offset % layout.width
        const y = Math.floor(offset / layout.width)
        expect(x + layout.mark).toBeLessThanOrEqual(layout.width)
        expect(y + layout.mark).toBeLessThanOrEqual(layout.height)
        for (let row = 0; row < layout.mark; row++) {
          for (let column = 0; column < layout.mark; column++) {
            const pixel = offset + row * layout.width + column
            if (owner[pixel] !== -1) throw new Error(`positions ${owner[pixel]} and ${position} share a pixel at width ${widthCss}`)
            owner[pixel] = position
          }
        }
        // The point in a mark's middle is over that mark, and so is the mark's own corner.
        const center = markCenterCss(layout, position)
        expect(positionAt(layout, center.x, center.y)).toBe(position)
        expect(positionAt(layout, x / scale, y / scale)).toBe(position)
      }
      // A mark is at least as large as its gap, and blocks of one row don't touch.
      expect(layout.mark).toBeGreaterThanOrEqual(layout.pitch - layout.mark)
      expect(layout.blockStride - layout.columns * layout.pitch + (layout.pitch - layout.mark)).toBeGreaterThanOrEqual(blockGapCss * scale - layout.pitch)
    }
  })

  test('answers -1 for a point over no mark: a label, the room between two blocks, and the empty end of a block\'s last row', () => {
    const layout = layoutFor(1070, 2, sizesAt100000)
    const first = layout.blocks[0]!
    expect(positionAt(layout, 5, labelBandCss - 2)).toBe(-1)
    expect(positionAt(layout, (first.x + layout.columns * layout.pitch + 4) / 2, labelBandCss + 20)).toBe(-1)
    const lastRowCount = first.count % layout.columns
    expect(lastRowCount).toBeGreaterThan(0)
    const lastRowY = (first.y + (first.rows - 1) * layout.pitch) / 2 + 0.25
    expect(positionAt(layout, (first.x + (lastRowCount - 1) * layout.pitch) / 2 + 0.25, lastRowY)).toBe(first.count - 1)
    expect(positionAt(layout, (first.x + lastRowCount * layout.pitch) / 2 + 0.25, lastRowY)).toBe(-1)
    expect(positionAt(layout, -3, 40)).toBe(-1)
    expect(positionAt(layout, 40, layout.height)).toBe(-1)
  })

  test('uses the smallest mark with a gap for 100,000 documents, and larger marks for fewer documents', () => {
    const pitchAndMark = (widthCss: number, scale: number, documentCount: number) => {
      const {pitch, mark, blocksPerRow} = mapGrid(widthCss, scale, nominalGroupSizes(documentCount, 7))
      return [pitch, mark, blocksPerRow]
    }
    expect(pitchAndMark(1070, 1, 100_000)).toEqual([2, 1, 8])
    expect(pitchAndMark(1070, 2, 100_000)).toEqual([3, 2, 8])
    expect(pitchAndMark(1070, 3, 100_000)).toEqual([4, 3, 8])
    expect(pitchAndMark(942, 2, 100_000)).toEqual([3, 2, 4])
    expect(pitchAndMark(1070, 2, 20_000)).toEqual([6, 5, 8])
    expect(pitchAndMark(324, 3, 20_000)).toEqual([6, 5, 2])
    // 500 documents get the largest mark, 12 CSS px from one to the next.
    expect(pitchAndMark(1070, 2, cpuDocumentCount)).toEqual([24, 19, 8])
  })

  test('is as tall before the documents exist as after, and as tall as demo.css says for a page of full width', () => {
    const nominal = nominalGroupSizes(100_000, 7)
    expect(nominal.length).toBe(groupNames.length)
    sizesAt100000.forEach((size, group) => expect(size).toBeLessThanOrEqual(nominal[group]!))
    const css = readFileSync(new URL('./demo.css', import.meta.url), 'utf8')
    const mapHeight = /\n\.map \{[^}]*?height: (\d+)px/.exec(css)?.[1]
    const mapHeightAtOneDevicePixel = /max-resolution: 1\.49dppx\) \{\s*\.map \{ height: (\d+)px/.exec(css)?.[1]
    for (const [scale, cssHeight] of [[2, mapHeight], [1, mapHeightAtOneDevicePixel]] as const) {
      // The page's map is 1104 px less the sheet's two borders of 1 px and its padding of 16 px on each side.
      const before = layoutFor(1070, scale, nominal)
      const after = layoutFor(1070, scale, sizesAt100000, nominal)
      expect(after.height).toBe(before.height)
      expect(after.pitch).toBe(before.pitch)
      expect(Number(cssHeight)).toBe(Math.ceil(before.height / scale))
    }
    // A group larger than its nominal size makes its row of blocks taller, and nothing else changes.
    const larger = layoutFor(1070, 2, sizesAt100000.map((size, group) => group === 3 ? 14_000 : size), nominal)
    expect(larger.height).toBeGreaterThan(layoutFor(1070, 2, nominal).height)
    expect(larger.columns).toBe(layoutFor(1070, 2, nominal).columns)
  })

  test('paints a match in one color, a valid document without one in a second, and an error without one in a third', () => {
    const shapeOf = Uint8Array.from([0, 1, 0, 1, 0, 1])
    const valid = Uint8Array.from([1, 1, 0, 1, 1, 0])
    const map = groupDocuments(shapeOf, valid, 2)
    for (const scale of [1, 2, 3]) {
      const layout: MapLayout = layoutFor(120, scale, map.groupSizes)
      const offsets = markOffsets(layout)
      const pixels = new Uint32Array(layout.width * layout.height)
      const colors = {valid: 11, match: 22, error: 33}
      paintMarks(pixels, layout, offsets, map.order, valid, Float32Array.from([0, 2, 1, 0, 0, 0]), colors)
      const colorOf = (index: number) => pixels[offsets[map.positionOf[index]!]!]
      expect([0, 1, 2, 3, 4, 5].map(colorOf)).toEqual([11, 22, 22, 11, 11, 33])
      // Each mark is a square of `mark` pixels, and nothing else is painted.
      expect(pixels.filter(pixel => pixel !== 0).length).toBe(6 * layout.mark * layout.mark)
      const last = offsets[map.positionOf[5]!]! + (layout.mark - 1) * (layout.width + 1)
      expect(pixels[last]).toBe(33)
      // Without a search, every mark has one of the two quiet colors.
      paintMarks(pixels, layout, offsets, map.order, valid, null, colors)
      expect([0, 1, 2, 3, 4, 5].map(colorOf)).toEqual([11, 11, 33, 11, 11, 33])
    }
  })

  test('counts the documents with a match per group, and steps from one document with a match to the next', () => {
    const counts = Float32Array.from([0, 2, 0, 1, 0, 0, 3])
    expect(matchesByGroup(counts, Uint8Array.from([0, 1, 1, 1, 2, 2, 0]), 3)).toEqual([1, 2, 0])
    expect(nextDocumentWithMatch(counts, 1, 1)).toBe(3)
    expect(nextDocumentWithMatch(counts, 3, 1)).toBe(6)
    expect(nextDocumentWithMatch(counts, 6, 1)).toBe(1)
    expect(nextDocumentWithMatch(counts, 1, -1)).toBe(6)
    expect(nextDocumentWithMatch(counts, 0, -1)).toBe(6)
    expect(nextDocumentWithMatch(counts, 4, -1)).toBe(3)
    expect(nextDocumentWithMatch(Float32Array.from([0, 0, 4]), 2, 1)).toBe(2)
    expect(nextDocumentWithMatch(new Float32Array(5), 2, 1)).toBe(-1)
  })
})

describe('how many documents the page loads', () => {
  test('asks for 100,000 documents, for 20,000 in a narrow window, and for the count that the address names', () => {
    expect(wantedDocumentCount(null, false)).toEqual({documentCount: 100_000, reason: {kind: 'none'}})
    expect(wantedDocumentCount(null, true)).toEqual({documentCount: 20_000, reason: {kind: 'narrowWindow'}})
    expect(wantedDocumentCount(5000, true)).toEqual({documentCount: 5000, reason: {kind: 'asked'}})
    expect(wantedDocumentCount(100_000, false)).toEqual({documentCount: 100_000, reason: {kind: 'none'}})
    // An address that names no usable count gets the window's count.
    for (const asked of [0, -4, 2.5, Number.NaN, 5_000_000]) expect(wantedDocumentCount(asked, false).documentCount).toBe(100_000)
  })

  test('keeps the wanted count when one buffer holds it, and otherwise the largest round count that fits', () => {
    const bytesPerDocument = bufferBytesFor(1)
    expect(bytesPerDocument).toBe(2052)
    expect(documentsThatFit(100_000, bufferBytesFor(100_000), bytesPerDocument)).toBe(100_000)
    expect(documentsThatFit(100_000, 4_294_967_292, bytesPerDocument)).toBe(100_000)
    // What every WebGPU device binds without being asked, 128 MiB, holds 65,408 documents.
    expect(documentsThatFit(100_000, 134_217_728, bytesPerDocument)).toBe(65_000)
    expect(documentsThatFit(20_000, 134_217_728, bytesPerDocument)).toBe(20_000)
    expect(documentsThatFit(100_000, 16_000_000, bytesPerDocument)).toBe(7700)
    expect(documentsThatFit(100_000, 1_000_000, bytesPerDocument)).toBe(487)
    expect(documentsThatFit(100_000, 100, bytesPerDocument)).toBe(1)
  })

  test('says in one sentence what the page shows instead of 100,000 documents on the GPU, and why', () => {
    expect(loadNotice({kind: 'none'}, 100_000)).toBeNull()
    expect(loadNotice({kind: 'noWebGpu'}, 500)).toBe('WebGPU isn’t available in this browser, so the same programs run on the CPU here, on 500 documents.')
    expect(loadNotice({kind: 'cpuAsked'}, 500)).toBe('This page’s address asks for the CPU, so the same programs run on the CPU here, on 500 documents.')
    expect(loadNotice({kind: 'bufferLimit', wanted: 100_000}, 65_000)).toBe('One buffer of this device’s GPU holds 65,000 documents, so the page searches 65,000 instead of 100,000.')
    expect(loadNotice({kind: 'checkFailed', mismatches: 12}, 500)).toBe('This GPU returned 12 values that differ from the CPU’s, so the same programs run on the CPU here, on 500 documents.')
    expect(loadNotice({kind: 'checkFailed', mismatches: 1}, 500)).toContain('1 value that differs from the CPU’s')
    expect(loadNotice({kind: 'gpuFailed', message: 'WebGPU out of memory'}, 500)).toBe('The GPU didn’t run the programs (WebGPU out of memory), so the same programs run on the CPU here, on 500 documents.')
    expect(loadNotice({kind: 'narrowWindow'}, 20_000)).toContain('A narrow window gets 20,000 documents')
    expect(loadNotice({kind: 'asked'}, 5000)).toBe('This page’s address asks for 5,000 documents.')
  })
})

describe('the page\'s sentences', () => {
  test('writes numbers with separators and times with a unit that fits their size', () => {
    expect(count(1_203_712)).toBe('1,203,712')
    expect([0.02, 0.84, 8.14, 17.6, 64.9, 994, 996, 2154, 12_300].map(duration)).toEqual(['under 0.1\u00a0ms', '0.8\u00a0ms', '8.1\u00a0ms', '18\u00a0ms', '65\u00a0ms', '994\u00a0ms', '1.0\u00a0s', '2.2\u00a0s', '12\u00a0s'])
    expect([820, 24_500, 59_400, 59_600, 354_000, 3_600_000 * 1.24].map(roughDuration)).toEqual(['820\u00a0ms', '25\u00a0s', '59\u00a0s', '0.99\u00a0minutes', '5.9\u00a0minutes', '1.2\u00a0hours'])
    expect([0.00146, 0.0841, 0.245, 0.9994, 3.61].map(perDocument)).toEqual(['1.5\u00a0µs', '84\u00a0µs', '245\u00a0µs', '999\u00a0µs', '3.6\u00a0ms'])
  })

  test('says the result of a search with the real count of documents', () => {
    expect(text(resultLine(4812, 9113, 100_000))).toBe('4,812 of 100,000 documents have a match, 9,113 matches in all.')
    expect(text(resultLine(1, 1, 500))).toBe('1 of 500 documents has a match, 1 match in all.')
    expect(text(resultLine(1, 3, 20_000))).toBe('1 of 20,000 documents has a match, 3 matches in all.')
    expect(text(resultLine(0, 0, 65_000))).toBe('None of the 65,000 documents has a match.')
  })

  test('refuses a pattern with a syntax error or one that no search program holds, in a sentence, and names the program for the others', () => {
    const capacities = [8, 16, 32]
    expect(analyzePattern('', capacities)).toEqual({kind: 'empty'})
    expect(analyzePattern('error', capacities)).toEqual({kind: 'fits', patternStates: 6, states: 8})
    expect(analyzePattern('(the|an?) [a-z]+', capacities)).toEqual({kind: 'fits', patternStates: 8, states: 8})
    expect(analyzePattern('\\d\\d\\d\\d-\\d\\d-\\d\\d', capacities)).toEqual({kind: 'fits', patternStates: 11, states: 16})
    expect(analyzePattern('connection reset', capacities)).toEqual({kind: 'fits', patternStates: 17, states: 32})
    expect(analyzePattern('(the', capacities)).toEqual({kind: 'refused', sentence: 'Character 1 of the pattern: this group is never closed.'})
    expect(analyzePattern('ab**', capacities)).toEqual({kind: 'refused', sentence: 'Character 4 of the pattern: nothing to repeat.'})
    expect(analyzePattern('a'.repeat(32), capacities)).toEqual({kind: 'refused', sentence: 'This pattern needs 33 states, and the largest search program holds 32.'})
    // The CPU version holds programs of up to 16 states.
    expect(analyzePattern('connection reset', [8, 16])).toEqual({kind: 'refused', sentence: 'This pattern needs 17 states, and the largest search program holds 16.'})
    expect(scopeChoiceOf('keys')).toBe('keys')
    expect(scopeChoiceOf('stringsAndKeys')).toBe('everything')
    expect(scopeChoiceOf(null)).toBe('everything')
  })

  test('says where a document\'s first error is and what it is', () => {
    expect(validitySentence('{"a": 1}', -1, errorKind.none, capacity)).toBe('Valid JSON.')
    expect(validitySentence('{\n  "a": 1,\n  "b" 2\n}', 18, errorKind.expectedColon, capacity)).toBe('Line 3, column 7. A colon was expected here, after the key.')
    expect(validitySentence('[1, 2', 5, errorKind.unexpectedEnd, capacity)).toBe('Line 1, column 6. The text ends before the value is complete.')
    expect(validitySentence('["a\nb"]', 3, errorKind.controlCharacterInString, capacity)).toBe('Line 1, column 4. This string isn’t closed before the end of its line.')
    expect(validitySentence('["a\tb"]', 3, errorKind.controlCharacterInString, capacity)).toBe('Line 1, column 4. This character needs an escape inside a string, e.g. \\t for a tab.')
    expect(validitySentence(`[${'1, '.repeat(200)}1]`, capacity, errorKind.tooLong, capacity)).toBe('This text has 603 characters, and the program reads the first 512.')
    expect(validitySentence(`${'['.repeat(17)}${']'.repeat(17)}`, 16, errorKind.tooDeep, capacity)).toBe('Line 1, column 17. This bracket opens nesting level 17, and the program follows 16.')
    // A character past U+FFFF is one column.
    expect(validitySentence('["😀", x]', 6, errorKind.unexpectedCharacter, capacity)).toBe('Line 1, column 7. Nothing in JSON starts with this character.')
  })

  test('splits a document into runs by display kind, match and first error, with a mark where an error has no character', () => {
    const {punctuation, key, string, number, whitespace, error, pastEnd} = displayKind
    // {"id": 12, "the tide"} with a search for "the|id" over everything: two matches, in turn.
    const sample = '{"id":12,"the"}'
    const kinds = [punctuation, key, key, key, key, punctuation, number, number, punctuation, string, string, string, string, string, punctuation]
    const marks = [0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 2, 1, 1, 0, 0]
    const {runs, marker} = documentRuns(sample, kinds, marks, -1, capacity)
    expect(marker).toBe(-1)
    expect(runs.map(run => run.text).join('')).toBe(sample)
    expect(runs.map(run => [run.text, runClassName(run)])).toEqual([
      ['{', 'k1'], ['"', 'k8'], ['id', 'k8 hit even'], ['"', 'k8'], [':', 'k1'], ['12', 'k4'], [',', 'k1'], ['"', 'k2'], ['the', 'k2 hit odd'], ['"', 'k2'], ['}', 'k1'],
    ])
    // Two matches that touch are two runs, since each starts with a 2.
    expect(documentRuns('abab', [string, string, string, string], [2, 1, 2, 1], -1, capacity).runs.map(run => [run.text, run.match])).toEqual([['ab', 1], ['ab', 2]])
    // Without a search, the runs follow the kinds alone.
    expect(documentRuns(sample, kinds, null, -1, capacity).runs.map(run => run.text)).toEqual(['{', '"id"', ':', '12', ',', '"the"', '}'])

    // The first error's character is a run of its own.
    const broken = documentRuns('[1 x]', [punctuation, number, whitespace, error, error], null, 3, capacity)
    expect(broken.runs.map(run => [run.text, runClassName(run)])).toEqual([['[', 'k1'], ['1', 'k4'], [' ', 'k0'], ['x', 'k6 first-error'], [']', 'k6']])
    expect(broken.marker).toBe(-1)
    // An error at the end of the text, and one at a line feed, have a mark instead: after the last run, and before
    // the line feed's run.
    expect(documentRuns('[1,', [punctuation, number, punctuation], null, 3, capacity).marker).toBe(3)
    const unclosed = documentRuns('"a\nb"', [string, string, error, error, error], null, 2, capacity)
    expect(unclosed.runs.map(run => run.text)).toEqual(['"a', '\nb"'])
    expect(unclosed.marker).toBe(1)
    // A text longer than the capacity: the mark stands where the programs stop reading, and the rest is one gray run.
    const long = documentRuns('abcdef', [string, string, string, string, pastEnd, pastEnd], null, 4, 4)
    expect(long.runs.map(run => [run.text, runClassName(run)])).toEqual([['abcd', 'k2'], ['ef', 'past-capacity']])
    expect(long.marker).toBe(1)
    // A character past U+FFFF is one position.
    expect(documentRuns('"😀a"', [string, string, string, string], [0, 0, 2, 0], -1, capacity).runs.map(run => [run.text, run.match])).toEqual([['"😀', 0], ['a', 1], ['"', 0]])
  })

  test('names the selected document', () => {
    expect(text(documentLine(7, 100_000, 2, true, 1, true))).toBe('Document 8 of 100,000, a log event, the first with a match')
    expect(text(documentLine(73_511, 100_000, 0, false, 3, false))).toBe('Document 73,512 of 100,000, a package manifest with an error, with 3 matches')
    expect(text(documentLine(0, 500, 6, true, 0, false))).toBe('Document 1 of 500, sensor readings')
    expect(text(documentLine(0, 500, 4, true, null, false))).toBe('Document 1 of 500, an order')
    expect<number>(groupNames.length).toBe(shapes.length + 1)
  })

  test('says each program\'s size from the searcher\'s description', () => {
    const lines = programLines([
      {name: 'JSON highlighter', operations: [37, 17], statements: 107, compileMs: 41.6},
      {name: 'regex search, 8 states', operations: [8, 151, 92], statements: 503, compileMs: 99.7},
      {name: 'regex search, 16 states', operations: [16, 359, 308], statements: undefined, compileMs: undefined},
    ], 512).map(text)
    expect(lines).toEqual([
      'The JSON highlighter is 37 operations at each of a document’s 512 positions, a shader of 107 statements that compiled in 42\u00a0ms.',
      'Regex search for a pattern of up to 8 states is 243 operations at each of a document’s 512 positions, a shader of 503 statements that compiled in 100\u00a0ms.',
      'Regex search for a pattern of up to 16 states is 667 operations at each of a document’s 512 positions.',
    ])
  })

  test('says what the self check found', () => {
    expect(checkLine({state: 'done', values: 164_352, mismatches: 0, documents: 64}, 'gpu')).toEqual({state: 'ok', line: ['Checked against the same programs on the CPU: ', {strong: '164,352'}, ' values of the first 64 documents, none different.']})
    expect(checkLine({state: 'done', values: 164_352, mismatches: 3, documents: 64}, 'gpu').state).toBe('bad')
    expect(text(checkLine({state: 'done', values: 164_352, mismatches: 3, documents: 64}, 'gpu').line)).toBe('Checked against the same programs on the CPU: 3 of 164,352 values differ.')
    expect(checkLine({state: 'checking'}, 'gpu').state).toBe('busy')
    expect(checkLine({state: 'waiting'}, 'gpu').state).toBe('idle')
  })

  test('fills the comparison only with measured numbers, and claims only what they say', () => {
    const numbers: ComparisonNumbers = {
      backend: 'gpu', documentCount: 100_000, scope: 'strings', highlightMs: 8.3, plainHighlightMsPerDocument: 0.00146, plainSampleDocuments: 4000, cpuHighlightMsPerDocument: 0.108, searchMs: 17.5,
      plainSearch: {state: 'done', ms: 22.6, matches: 41_347, differing: 0}, plainRunsMs: 94.5, cpuSearchMsPerDocument: 0.245, cpuSampleDocuments: 32,
    }
    const program = {patternStates: 8, states: 8, smallestStates: 8, operations: 243, smallestOperations: 243}
    const cells = comparisonCells(numbers)
    expect(Object.fromEntries(Object.entries(cells).map(([name, line]) => [name, text(line)]))).toEqual({
      programHighlight: '8.3\u00a0ms', programSearch: '18\u00a0ms', plainHighlight: 'about 146\u00a0ms, from 4,000 documents at 1.5\u00a0µs each', plainSearch: '23\u00a0ms, after 95\u00a0ms once to find the string values',
      cpuHighlight: 'about 11\u00a0s, from 32 documents at 108\u00a0µs each', cpuSearch: 'about 25\u00a0s, from 32 documents at 245\u00a0µs each',
    })
    // 22.6 ms against 17.5 ms is about the same time, and the verdict says so.
    expect(text(comparisonVerdict(numbers, program))).toBe('RegExp and the GPU took about the same time on this pattern. On the CPU, the same search program would take about 1,400\u00a0times as long as on the GPU.')
    // A pattern that makes RegExp backtrack.
    const slow = {...numbers, searchMs: 8, plainSearch: {state: 'done', ms: 567, matches: 44_399, differing: 0}} as const
    expect(text(comparisonVerdict(slow, program))).toStartWith('RegExp took 71\u00a0times as long as the GPU on this pattern. A search program takes the same time for every pattern of up to 8 states, and RegExp’s time depends on the pattern.')
    // A pattern on the larger program, where RegExp is faster: the page says both.
    const larger = {...numbers, searchMs: 65.3, plainSearch: {state: 'done', ms: 12.7, matches: 27_415, differing: 0}} as const
    expect(text(comparisonVerdict(larger, {patternStates: 11, states: 16, smallestStates: 8, operations: 667, smallestOperations: 243}))).toStartWith(
      'This pattern has 11 states, more than the 8 that the smallest search program holds, so it ran on the program for 16, which does 667 operations at each character instead of 243. RegExp was 5.1\u00a0times faster than the GPU on this pattern.')
    // RegExp counts differently on some patterns, and the page says in how many documents.
    const differing = {...numbers, plainSearch: {state: 'done', ms: 22.6, matches: 120, differing: 7}} as const
    expect(text(comparisonVerdict(differing, program))).toContain('RegExp counts 120 matches, and its count differs from the program’s in 7 documents')
    // Before anything is measured, the cells say so and the verdict is empty.
    const unmeasured: ComparisonNumbers = {...numbers, highlightMs: null, plainHighlightMsPerDocument: null, cpuHighlightMsPerDocument: null, searchMs: null, plainSearch: {state: 'none'}, plainRunsMs: null, cpuSearchMsPerDocument: null}
    expect(text(comparisonCells(unmeasured).plainSearch)).toBe('measured once the page is idle')
    expect(comparisonVerdict(unmeasured, program)).toEqual([])
    expect(text(comparisonCells({...numbers, plainSearch: {state: 'running', ms: 1234, documents: 55_000}}).plainSearch)).toBe('1.2\u00a0s so far, for 55,000 documents')
    // A time that was measured on every document isn't said to be from a sample, e.g. the table loop's on the CPU
    // version's 500 documents.
    expect(text(comparisonCells({...numbers, documentCount: 500, plainSampleDocuments: 500}).plainHighlight)).toBe('0.7\u00a0ms')
    // The CPU version has no third row to compare with.
    expect(text(comparisonVerdict({...numbers, backend: 'cpu', searchMs: 126, plainSearch: {state: 'done', ms: 0.2, matches: 203, differing: 0}}, program))).toBe('RegExp was 630\u00a0times faster than the programs on the CPU on this pattern.')
  })
})

describe('the comparison\'s baselines', () => {
  const texts = generateDocuments(620).map(document => document.text)

  // Runs the pieces until the comparison of one search is complete, as the page does from its frames.
  async function measure(baselines: ReturnType<typeof createBaselines>, request: Parameters<ReturnType<typeof createBaselines>['step']>[0], budgetMs: number) {
    let steps = 0
    while (baselines.step(request, budgetMs)) {
      steps++
      // A CPU searcher answers through a promise.
      await Promise.resolve()
      if (steps > 20_000) throw new Error('the comparison never finished')
    }
    return steps
  }

  test('adds up the same RegExp counts in pieces as plain-search.ts does in one call, and says where they differ from the program\'s', async () => {
    const plain = createPlainSearch(texts)
    const searcher = createCpuSearcher(texts)
    const baselines = createBaselines(texts, {withCpu: false})
    expect(baselines.numbers(null)).toEqual({plainHighlightMsPerDocument: null, plainSampleDocuments: texts.length, plainRunsMs: null, plainSearch: {state: 'none'}, cpuHighlightMsPerDocument: null, cpuSearchMsPerDocument: null, cpuSampleDocuments: 32})
    for (const [pattern, scope] of [['error', 'everything'], ['(the|an?) [a-z]+', 'strings'], ['[a-z]+Id', 'keys'], ['a|ab|b', 'everything'], ['a*', 'everything']] as const) {
      const result = await searcher.search({pattern, scope})
      if (result?.status !== 'searched') throw new Error(`the searcher didn't search ${pattern}`)
      const request = {pattern, scope, states: result.states, programCounts: result.matchCounts}
      // A budget of 0 ms does one piece per call, i.e. one chunk of 250 documents, and a search this short is timed
      // twice, so a search of 620 documents is at least 6 pieces.
      const steps = await measure(baselines, request, 0)
      expect(steps).toBeGreaterThanOrEqual(5)
      const expected = plain.search(pattern, scope)
      let differing = 0
      for (let row = 0; row < texts.length; row++) if (expected.matchCounts[row] !== result.matchCounts[row]) differing++
      const numbers = baselines.numbers(request)
      const {plainSearch} = numbers
      if (plainSearch.state !== 'done') throw new Error(`the plain search of ${pattern} isn't done: ${plainSearch.state}`)
      expect([plainSearch.matches, plainSearch.differing]).toEqual([expected.matches, differing])
      expect(plainSearch.ms).toBeGreaterThanOrEqual(0)
      expect(numbers.plainHighlightMsPerDocument).toBeGreaterThan(0)
      expect(numbers.plainRunsMs).toBeGreaterThanOrEqual(0)
      // RegExp takes the first alternative that matches, e.g. a and then b in "tab" where the program takes ab, and it
      // counts empty matches, so these two patterns' counts differ from the program's.
      if (pattern === 'a|ab|b' || pattern === 'a*') expect(differing).toBeGreaterThan(0)
      else expect(differing).toBe(0)
      // The numbers are the request's: another search has none yet.
      expect(baselines.numbers({...request, pattern: `${pattern}x`}).plainSearch).toEqual({state: 'none'})
    }
  })

  test('times the same programs on the CPU on the first documents', async () => {
    const searcher = createCpuSearcher(texts.slice(0, 40))
    const baselines = createBaselines(texts, {withCpu: true})
    const result = await searcher.search({pattern: 'error', scope: 'everything'})
    if (result?.status !== 'searched') throw new Error('the searcher didn\'t search')
    const request: Parameters<typeof baselines.step>[0] = {pattern: 'error', scope: 'everything', states: 8, programCounts: new Float32Array(texts.length)}
    await measure(baselines, request, 2)
    const numbers = baselines.numbers(request)
    expect(numbers.cpuSampleDocuments).toBe(32)
    expect(numbers.cpuHighlightMsPerDocument).toBeGreaterThan(0)
    expect(numbers.cpuSearchMsPerDocument).toBeGreaterThan(0)
    expect(numbers.cpuSearchMsPerDocument).toBeLessThan(50)
    // A search on the program of 16 states is timed on 12 documents.
    const longer = {...request, pattern: '\\d\\d\\d\\d-\\d\\d-\\d\\d', states: 16}
    await measure(baselines, longer, 2)
    expect(baselines.numbers(longer).cpuSampleDocuments).toBe(12)
    expect(baselines.numbers(longer).cpuSearchMsPerDocument).toBeGreaterThan(0)
  })
})

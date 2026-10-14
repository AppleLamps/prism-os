// The demo page's parts that need no browser: the map's geometry and pixels (demo-map.ts), the page's documents,
// sentences and numbers (demo-text.ts), and the worker that runs both programs on the CPU and times RegExp
// (demo-worker.ts), which Bun runs as a worker here.
// Run from the repo root: bun test lab/json-search/demo.test.ts
import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {capacity, displayKind} from '../../src/json-highlighter/kinds.ts'
import {type MapLayout, cellAt, cellCenterCss, mapLayout, nearestMatch, nextMatch, paintCells} from './demo-map.ts'
import {type Line, analyzePattern, count, documentRuns, documentText, documentsThatFit, duration, failureSentence, isScope, loadNotice, resultLine, runClassName} from './demo-text.ts'
import type {WorkerAnswer, WorkerRequest} from './demo-worker.ts'
import {codePointLength} from './documents.ts'
import {createPlainSearch} from './plain-search.ts'
import {bufferBytesFor, createCpuSearcher, defaultStateCapacities} from './searcher.ts'

// A line as plain text.
const text = (line: Line) => line.map(part => typeof part === 'string' ? part : part.strong).join('')
const page = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('the map of every document', () => {
  test('gives every document its own cell inside the canvas, at every width and screen', () => {
    for (const [widthCss, scale, documentCount] of [[630, 2, 100_000], [630, 1, 100_000], [630, 3, 100_000], [900, 2, 65_000], [324, 3, 20_000], [324, 2, 20_000], [630, 2, 500], [200, 1, 7]] as const) {
      const layout = mapLayout(widthCss, scale, documentCount)
      expect(layout.width).toBe(widthCss * scale)
      expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(documentCount)
      expect(layout.columns * (layout.rows - 1)).toBeLessThan(documentCount)
      // Every cell lies inside the canvas, no two cells share a pixel, and a cell's first pixel is the cell's own.
      const owner = new Int32Array(layout.width * layout.height).fill(-1)
      for (let index = 0; index < documentCount; index++) {
        const x = (index % layout.columns) * layout.pitch
        const y = Math.floor(index / layout.columns) * layout.pitch
        expect(x + layout.cell).toBeLessThanOrEqual(layout.width)
        expect(y + layout.cell).toBeLessThanOrEqual(layout.height)
        for (let row = 0; row < layout.cell; row++) {
          for (let column = 0; column < layout.cell; column++) {
            const pixel = (y + row) * layout.width + x + column
            if (owner[pixel] !== -1) throw new Error(`documents ${owner[pixel]} and ${index} share a pixel at width ${widthCss}`)
            owner[pixel] = index
          }
        }
        // The point in a cell's middle is over that cell, and so is the cell's own corner.
        const center = cellCenterCss(layout, index)
        expect(cellAt(layout, center.x, center.y)).toBe(index)
        expect(cellAt(layout, x / scale, y / scale)).toBe(index)
      }
      // A cell is at least as large as its gap.
      expect(layout.cell).toBeGreaterThanOrEqual(layout.pitch - layout.cell)
    }
  })

  test('answers -1 for a point over no cell: outside the map, and the empty end of the last row', () => {
    const layout = mapLayout(630, 2, 100_000)
    const lastRowCount = 100_000 - layout.columns * (layout.rows - 1)
    expect(lastRowCount).toBeGreaterThan(0)
    expect(lastRowCount).toBeLessThan(layout.columns)
    const lastRowY = (layout.rows - 1) * layout.pitch / 2 + 0.25
    expect(cellAt(layout, (lastRowCount - 1) * layout.pitch / 2 + 0.25, lastRowY)).toBe(99_999)
    expect(cellAt(layout, lastRowCount * layout.pitch / 2 + 0.25, lastRowY)).toBe(-1)
    expect(cellAt(layout, -3, 40)).toBe(-1)
    expect(cellAt(layout, 40, -3)).toBe(-1)
    expect(cellAt(layout, 40, layout.height / 2 + 4)).toBe(-1)
  })

  test('uses the smallest cell with a gap for 100,000 documents, and larger cells for fewer documents', () => {
    const pitchAndCell = (widthCss: number, scale: number, documentCount: number) => {
      const {pitch, cell} = mapLayout(widthCss, scale, documentCount)
      return [pitch, cell]
    }
    expect(pitchAndCell(630, 1, 100_000)).toEqual([2, 1])
    expect(pitchAndCell(630, 2, 100_000)).toEqual([3, 2])
    expect(pitchAndCell(630, 3, 100_000)).toEqual([4, 3])
    // What one buffer of every WebGPU device holds, and a phone's 20,000 documents.
    expect(pitchAndCell(630, 2, 65_000)).toEqual([4, 3])
    expect(pitchAndCell(324, 3, 20_000)).toEqual([7, 6])
    // A few documents get the largest cell, 12 CSS px from one to the next.
    expect(pitchAndCell(630, 2, 500)).toEqual([24, 19])
  })

  test('is as tall as demo.css says for a page of full width, so the first paint has the map\'s room', () => {
    const css = page('./demo.css')
    const mapHeight = /\n\.map \{[^}]*?height: (\d+)px/.exec(css)?.[1]
    const mapHeightAtOneDevicePixel = /max-resolution: 1\.49dppx\) \{\s*\.map \{ height: (\d+)px/.exec(css)?.[1]
    // The page is 1104 px wide, the document's panel 416 px and the gap between the two 24 px. The map is what is
    // left, less its sheet's two borders of 1 px and its padding of 16 px on each side.
    const mapWidthCss = 1104 - 416 - 24 - 2 - 32
    for (const [scale, cssHeight] of [[2, mapHeight], [1, mapHeightAtOneDevicePixel]] as const) {
      expect(Number(cssHeight)).toBe(Math.ceil(mapLayout(mapWidthCss, scale, 100_000).height / scale))
    }
  })

  test('the pointer picks the nearest document with a match among the documents searched so far', () => {
    const layout = mapLayout(100, 1, 1600)
    expect([layout.pitch, layout.columns]).toEqual([5, 20])
    const counts = new Float32Array(1600)
    const at = (column: number, row: number) => row * layout.columns + column
    counts[at(3, 2)] = 1
    counts[at(15, 9)] = 4
    counts[at(16, 9)] = 1
    const center = (index: number) => cellCenterCss(layout, index)
    // A point over a cell with a match picks it, and a point over another cell picks the nearest one with a match.
    expect(nearestMatch(layout, counts, 1600, center(at(3, 2)).x, center(at(3, 2)).y)).toBe(at(3, 2))
    expect(nearestMatch(layout, counts, 1600, center(at(0, 0)).x, center(at(0, 0)).y)).toBe(at(3, 2))
    expect(nearestMatch(layout, counts, 1600, center(at(19, 79)).x, center(at(19, 79)).y)).toBe(at(16, 9))
    expect(nearestMatch(layout, counts, 1600, center(at(14, 12)).x, center(at(14, 12)).y)).toBe(at(15, 9))
    // Between two cells that are as near, the first one.
    expect(nearestMatch(layout, counts, 1600, (center(at(15, 9)).x + center(at(16, 9)).x) / 2, center(at(15, 9)).y)).toBe(at(15, 9))
    // A search on the CPU that has answered for the first 100 documents: only those are picked.
    expect(nearestMatch(layout, counts, 100, center(at(19, 79)).x, center(at(19, 79)).y)).toBe(at(3, 2))
    expect(nearestMatch(layout, counts, 40, center(at(3, 2)).x, center(at(3, 2)).y)).toBe(-1)
    expect(nearestMatch(layout, new Float32Array(1600), 1600, 50, 50)).toBe(-1)
  })

  test('steps from one document with a match to the next and the previous, around the ends', () => {
    const counts = Float32Array.from([0, 2, 0, 1, 0, 0, 3])
    expect(nextMatch(counts, 7, 1, 1)).toBe(3)
    expect(nextMatch(counts, 7, 3, 1)).toBe(6)
    expect(nextMatch(counts, 7, 6, 1)).toBe(1)
    expect(nextMatch(counts, 7, 1, -1)).toBe(6)
    expect(nextMatch(counts, 7, 0, -1)).toBe(6)
    expect(nextMatch(counts, 7, 4, -1)).toBe(3)
    expect(nextMatch(Float32Array.from([0, 0, 4]), 3, 2, 1)).toBe(2)
    expect(nextMatch(new Float32Array(5), 5, 2, 1)).toBe(-1)
    // A search on the CPU that has answered for the first 4 documents: the steps stay among those, also from a
    // document that it hasn't reached.
    expect(nextMatch(counts, 4, 3, 1)).toBe(1)
    expect(nextMatch(counts, 4, 6, 1)).toBe(3)
    expect(nextMatch(counts, 0, 2, 1)).toBe(-1)
  })

  test('paints a document without a match as its cell, one with a match as its cell and the gap around it, one not searched yet in a third color, and nothing for a document that isn\'t loaded', () => {
    const colors = {match: 22, plain: 11, waiting: 5}
    for (const scale of [1, 2, 3]) {
      const layout: MapLayout = mapLayout(36, scale, 9)
      const gap = layout.pitch - layout.cell
      expect([layout.columns, layout.rows]).toEqual([3, 3])
      const pixels = new Uint32Array(layout.width * layout.height)
      // What the cell of a document holds, and the pixel diagonally before its first one, in the gap.
      const colorOf = (index: number) => pixels[Math.floor(index / layout.columns) * layout.pitch * layout.width + (index % layout.columns) * layout.pitch]
      const cornerOf = (index: number) => pixels[(Math.floor(index / layout.columns) * layout.pitch - 1) * layout.width + (index % layout.columns) * layout.pitch - 1]
      const every = [0, 1, 2, 3, 4, 5, 6, 7, 8]
      // 7 of the 9 documents are loaded, and a search has answered for the first 5: documents 1 and 4 have a match.
      paintCells(pixels, layout, 7, 5, Float32Array.from([0, 2, 0, 0, 1]), colors, colors.waiting)
      expect(every.map(colorOf)).toEqual([11, 22, 11, 11, 22, 5, 5, 0, 0])
      // Document 4 is in the middle of the map, so its mark is its cell and the whole gap around it. Document 1 is
      // right above it, in the first row: the gap above it is outside the canvas, and the gap below it is the one
      // above document 4, where the two marks join.
      expect(cornerOf(4)).toBe(22)
      const markSide = layout.cell + 2 * gap
      const painted = (color: number) => pixels.filter(pixel => pixel === color).length
      expect(painted(22)).toBe(markSide * markSide + markSide * layout.cell)
      // Every other cell is a square of `cell` pixels in its own color, and nothing else is painted.
      expect([painted(11), painted(5)]).toEqual([3 * layout.cell * layout.cell, 2 * layout.cell * layout.cell])
      expect(painted(0)).toBe(pixels.length - painted(22) - painted(11) - painted(5))
      // The next paint leaves nothing of the last one's marks: without a search, every loaded document's cell has
      // the plain color, and the gaps are empty again.
      paintCells(pixels, layout, 9, 0, new Float32Array(0), colors, colors.plain)
      expect(every.map(colorOf)).toEqual([11, 11, 11, 11, 11, 11, 11, 11, 11])
      expect([painted(11), painted(22), cornerOf(4)]).toEqual([9 * layout.cell * layout.cell, 0, 0])
    }
    // The smallest cell, 1 pixel with a gap of 1, as for 100,000 documents at one device pixel per CSS px: a mark is
    // at most twice the cell's side, so it is the cell and the gap to its right and below it, 2 by 2 pixels.
    const smallest: MapLayout = {scale: 1, documentCount: 9, width: 5, height: 5, pitch: 2, cell: 1, columns: 3, rows: 3}
    const pixels = new Uint32Array(25)
    paintCells(pixels, smallest, 9, 9, Float32Array.from([0, 0, 0, 0, 1, 0, 0, 0, 3]), colors, colors.waiting)
    expect([...pixels]).toEqual([
      11, 0, 11, 0, 11,
      0, 0, 0, 0, 0,
      11, 0, 22, 22, 11,
      0, 0, 22, 22, 0,
      11, 0, 11, 0, 22,
    ])
  })
})

describe('the page\'s documents', () => {
  const texts = Array.from({length: 3000}, (_, index) => documentText(index))

  test('every document is valid JSON that both programs hold: at most 512 code points, and valid to the highlighter', () => {
    for (const document of texts) {
      expect(codePointLength(document)).toBeLessThanOrEqual(capacity)
      expect(() => JSON.parse(document) as unknown).not.toThrow()
    }
    const searcher = createCpuSearcher(texts.slice(0, 300))
    expect(searcher.validation.validCount).toBe(300)
    // The same document every time, since the page and its worker each write the documents.
    expect(documentText(73_512)).toBe(documentText(73_512))
    expect(documentText(73_512)).not.toBe(documentText(73_513))
  })

  test('every example of the page\'s Try list fits a search program and finds something in what it reads', () => {
    const plain = createPlainSearch(texts)
    const examples = [...page('./demo.html').matchAll(/data-pattern="([^"]*)" data-scope="([^"]*)"/g)].map(([, pattern, scope]) => ({pattern: pattern!, scope}))
    expect(examples.length).toBe(4)
    for (const {pattern, scope} of examples) {
      if (!isScope(scope)) throw new Error(`${scope} isn't one of the page's scopes`)
      expect([pattern, analyzePattern(pattern, defaultStateCapacities).kind]).toEqual([pattern, 'fits'])
      expect(plain.search(pattern, scope).matches).toBeGreaterThan(100)
    }
  })

  test('keeps the wanted count when one buffer of the GPU holds it, and otherwise the largest round count that fits', () => {
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

  test('says in one sentence what the page does instead of searching the wanted documents on the GPU, and why', () => {
    expect(loadNotice({kind: 'none'}, 100_000)).toBeNull()
    expect(loadNotice({kind: 'noWebGpu'}, 100_000)).toBe('This browser has no WebGPU, so both programs run on the CPU here, as JavaScript in a worker.')
    expect(loadNotice({kind: 'bufferLimit', wanted: 100_000}, 65_000)).toBe('One buffer of this GPU holds 65,000 documents, so the page searches 65,000 instead of 100,000.')
    expect(loadNotice({kind: 'gpuFailed', message: 'WebGPU out of memory'}, 100_000)).toBe('The GPU didn’t run the programs (WebGPU out of memory), so they run on the CPU here, as JavaScript in a worker.')
  })

  test('says in one sentence why the page can\'t search at all', () => {
    expect(failureSentence({kind: 'documents', message: 'Array buffer allocation failed'})).toBe('The page couldn’t load its documents: Array buffer allocation failed.')
    // A worker whose script didn't load gives no message, and one that throws gives the error's.
    expect(failureSentence({kind: 'worker', message: undefined})).toBe('The script of the page’s workers didn’t load, so the page can’t search.')
    expect(failureSentence({kind: 'worker', message: 'Uncaught RangeError: Array buffer allocation failed'})).toBe('One of the page’s workers stopped (Uncaught RangeError: Array buffer allocation failed), so the page can’t search.')
  })
})

describe('the page\'s sentences', () => {
  test('writes numbers with separators and times with a unit that fits their size', () => {
    expect(count(1_203_712)).toBe('1,203,712')
    expect([0.02, 0.84, 8.14, 17.6, 64.9, 994, 996, 2154, 12_300].map(duration)).toEqual(['under 0.1 ms', '0.8 ms', '8.1 ms', '18 ms', '65 ms', '994 ms', '1.0 s', '2.2 s', '12 s'])
  })

  test('says how many documents match, how long the search took where it ran, and RegExp\'s time once it is measured', () => {
    const measured = (ms: number) => ({kind: 'measured', ms}) as const
    expect(text(resultLine({withMatch: 10_541, searched: 100_000, ms: 22.6}, 100_000, 'gpu', measured(23.4)))).toBe('10,541 of 100,000 documents match. 23 ms on the GPU. RegExp: 23 ms.')
    expect(text(resultLine({withMatch: 10_541, searched: 100_000, ms: 22.6}, 100_000, 'gpu', null))).toBe('10,541 of 100,000 documents match. 23 ms on the GPU.')
    expect(text(resultLine({withMatch: 1, searched: 20_000, ms: 8.14}, 20_000, 'gpu', measured(2143)))).toBe('1 of 20,000 documents matches. 8.1 ms on the GPU. RegExp: 2.1 s.')
    expect(text(resultLine({withMatch: 0, searched: 65_000, ms: 871}, 65_000, 'gpu', measured(28.9)))).toBe('None of the 65,000 documents matches. 871 ms on the GPU. RegExp: 29 ms.')
    expect(text(resultLine({withMatch: 10_541, searched: 100_000, ms: 15_820}, 100_000, 'cpu', measured(23.4)))).toBe('10,541 of 100,000 documents match. 16 s on the CPU. RegExp: 23 ms.')
    // A search on the CPU that hasn't answered for every document yet says how far it is.
    expect(text(resultLine({withMatch: 1304, searched: 12_400, ms: 3120}, 100_000, 'cpu', measured(23.4)))).toBe('1,304 of the first 12,400 documents match. 3.1 s on the CPU so far. RegExp: 23 ms.')
    expect(text(resultLine({withMatch: 0, searched: 2, ms: 0.4}, 100_000, 'cpu', null))).toBe('0 of the first 2 documents match. 0.4 ms on the CPU so far.')
    // A RegExp that the page stopped after 10 s, e.g. for (([a-z]+)+)+x.
    expect(text(resultLine({withMatch: 47_577, searched: 100_000, ms: 17.2}, 100_000, 'gpu', {kind: 'stopped', afterMs: 10_000}))).toBe('47,577 of 100,000 documents match. 17 ms on the GPU. RegExp: more than 10 s.')
    expect(resultLine({withMatch: 10_541, searched: 100_000, ms: 22.6}, 100_000, 'gpu', measured(23.4))[0]).toEqual({strong: '10,541'})
  })

  test('refuses a pattern with a syntax error or one that no search program holds, in a sentence, and names the program for the others', () => {
    const capacities = [8, 16, 32]
    expect(analyzePattern('', capacities)).toEqual({kind: 'empty'})
    expect(analyzePattern('error', capacities)).toEqual({kind: 'fits', states: 8})
    expect(analyzePattern('(the|an?) [a-z]+', capacities)).toEqual({kind: 'fits', states: 8})
    expect(analyzePattern('\\d\\d\\d\\d-\\d\\d-\\d\\d', capacities)).toEqual({kind: 'fits', states: 16})
    expect(analyzePattern('connection reset', capacities)).toEqual({kind: 'fits', states: 32})
    expect(analyzePattern('(the', capacities)).toEqual({kind: 'refused', sentence: 'Character 1 of the pattern: this group is never closed.'})
    expect(analyzePattern('ab**', capacities)).toEqual({kind: 'refused', sentence: 'Character 4 of the pattern: nothing to repeat.'})
    expect(analyzePattern('a'.repeat(32), capacities)).toEqual({kind: 'refused', sentence: 'This pattern needs 33 states, and the largest search program holds 32.'})
    expect([isScope('keys'), isScope('stringsAndKeys'), isScope(undefined)]).toEqual([true, false, false])
  })

  test('splits a document into runs by display kind and match', () => {
    const {punctuation, key, string, number} = displayKind
    // {"id":12,"the"} with a search for "the|id" over everything: two matches, in turn.
    const sample = '{"id":12,"the"}'
    const kinds = [punctuation, key, key, key, key, punctuation, number, number, punctuation, string, string, string, string, string, punctuation]
    const marks = [0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 2, 1, 1, 0, 0]
    const runs = documentRuns(sample, kinds, marks)
    expect(runs.map(run => run.text).join('')).toBe(sample)
    expect(runs.map(run => [run.text, runClassName(run)])).toEqual([
      ['{', 'k1'], ['"', 'k8'], ['id', 'k8 hit even'], ['"', 'k8'], [':', 'k1'], ['12', 'k4'], [',', 'k1'], ['"', 'k2'], ['the', 'k2 hit odd'], ['"', 'k2'], ['}', 'k1'],
    ])
    // Two matches that touch are two runs, since each starts with a 2.
    expect(documentRuns('abab', [string, string, string, string], [2, 1, 2, 1]).map(run => [run.text, run.match])).toEqual([['ab', 1], ['ab', 2]])
    // Without a search, the runs follow the kinds alone.
    expect(documentRuns(sample, kinds, null).map(run => run.text)).toEqual(['{', '"id"', ':', '12', ',', '"the"', '}'])
    // A character past U+FFFF is one position.
    expect(documentRuns('"😀a"', [string, string, string, string], [0, 0, 2, 0]).map(run => [run.text, run.match])).toEqual([['"😀', 0], ['a', 1], ['"', 0]])
  })
})

describe('the page\'s worker', () => {
  const documentCount = 300
  const texts = Array.from({length: documentCount}, (_, index) => documentText(index))

  // The worker with the page's first message sent, its answers so far, and a wait for an answer.
  function startWorker() {
    const worker = new Worker(new URL('./demo-worker.ts', import.meta.url).href)
    const answers: WorkerAnswer[] = []
    let arrived = () => {}
    worker.onmessage = (event: MessageEvent<WorkerAnswer>) => {
      answers.push(event.data)
      arrived()
    }
    const failed = new Promise<never>((_, reject) => {
      worker.onerror = event => reject(new Error(event.message))
    })
    const post = (request: WorkerRequest) => worker.postMessage(request)
    post({kind: 'documents', documentCount})
    const until = async (done: () => boolean) => {
      while (!done()) await Promise.race([failed, new Promise<void>(resolve => { arrived = resolve })])
    }
    return {worker, answers, post, until}
  }
  const searchedOf = (answers: readonly WorkerAnswer[], id: number) => answers.filter((answer): answer is Extract<WorkerAnswer, {kind: 'searched'}> => answer.kind === 'searched' && answer.id === id)

  test('a search on the CPU answers in pieces, in the documents\' order, which add up to the CPU searcher\'s counts', async () => {
    const {worker, answers, post, until} = startWorker()
    const pattern = '(the|an?) [a-z]+'
    post({kind: 'search', search: {id: 1, pattern, scope: 'strings'}})
    const reached = (id: number) => searchedOf(answers, id).reduce((total, piece) => total + piece.matchCounts.length, 0)
    await until(() => reached(1) === documentCount)
    const pieces = searchedOf(answers, 1)
    expect(pieces.length).toBeGreaterThan(2)
    const counts: number[] = []
    for (const piece of pieces) {
      expect(piece.firstDocument).toBe(counts.length)
      expect(piece.ms).toBeGreaterThanOrEqual(0)
      counts.push(...piece.matchCounts)
    }
    const expected = await createCpuSearcher(texts).search({pattern, scope: 'strings'})
    if (expected?.status !== 'searched') throw new Error('the searcher didn\'t search')
    expect(expected.matches).toBeGreaterThan(100)
    expect(counts).toEqual([...expected.matchCounts])

    // A second search replaces one in progress: the first one's pieces stop, and the second one answers for every document.
    post({kind: 'search', search: {id: 2, pattern: 'error', scope: 'everything'}})
    post({kind: 'search', search: {id: 3, pattern: '[a-z]+Id', scope: 'keys'}})
    await until(() => reached(3) === documentCount)
    expect(reached(2)).toBeLessThan(documentCount)
    const second = await createCpuSearcher(texts).search({pattern: '[a-z]+Id', scope: 'keys'})
    if (second?.status !== 'searched') throw new Error('the searcher didn\'t search')
    expect(searchedOf(answers, 3).flatMap(piece => [...piece.matchCounts])).toEqual([...second.matchCounts])
    // And a search that is stopped answers no more.
    post({kind: 'search', search: {id: 4, pattern: 'error', scope: 'everything'}})
    post({kind: 'search', search: null})
    post({kind: 'regExp', key: 'after the stop', pattern: 'error', scope: 'everything'})
    await until(() => answers.some(answer => answer.kind === 'regExp' && answer.key === 'after the stop'))
    expect(reached(4)).toBe(0)
    worker.terminate()
  }, 30_000)

  test('answers with one document\'s display kinds and marks, and with RegExp\'s time for a search', async () => {
    const {worker, answers, post, until} = startWorker()
    const searcher = createCpuSearcher(texts)
    const index = 41
    const window = {firstDocument: index, documentCount: 1}
    post({kind: 'document', key: 'with a search', index, search: {pattern: '[a-z]+', scope: 'keys'}})
    await until(() => answers.length === 1)
    post({kind: 'document', key: 'without', index, search: null})
    post({kind: 'regExp', key: 'time', pattern: '[a-z]+', scope: 'keys'})
    await until(() => answers.length === 3)
    const expected = await searcher.search({pattern: '[a-z]+', scope: 'keys', window, documents: 'window'})
    if (expected?.status !== 'searched') throw new Error('the searcher didn\'t search')
    expect(expected.matches).toBeGreaterThan(0)
    const kinds = [...await searcher.kinds(window)]
    const [withSearch, without, time] = answers
    if (withSearch?.kind !== 'document' || without?.kind !== 'document' || time?.kind !== 'regExp') throw new Error(`unexpected answers: ${answers.map(answer => answer.kind).join(', ')}`)
    expect([withSearch.key, withSearch.index, [...withSearch.kinds], [...withSearch.marks ?? []]]).toEqual(['with a search', index, kinds, [...expected.marks]])
    expect([without.key, without.index, [...without.kinds], without.marks]).toEqual(['without', index, kinds, null])
    expect(time.key).toBe('time')
    expect(time.ms).toBeGreaterThanOrEqual(0)
    worker.terminate()
  }, 30_000)
})

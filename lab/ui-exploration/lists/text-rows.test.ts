// Checks the text rows list (text-rows.ts): row heights against pretext's own layout, and scroll positions, DOM slots
// and anchoring against the plain JavaScript reference (text-rows-reference.ts), over scripted steps and random sessions.
import {describe, expect, test} from 'bun:test'
import {validateGrids, validateIndexReads} from '../../../src/runtime/numeric-ui-core.ts'
import {installFakeCanvas} from '../hn-thread/fake-canvas.ts'
import {createRandom} from './common.ts'
import {createTextRowsReference, referenceMinimumWidth, type ReferenceOutput} from './text-rows-reference.ts'
import {generateMessage, prepareText, tabulateTextRow, textRowHeight, textRowLayout, unusedBreakpoint} from './text-rows-prepare.ts'
import {buildTextRows, createTextRowsMachine, drawnSlots, quantizeTextRowsInput, type TextRowsInput, type TextRowsOptions, type TextRowsOutput} from './text-rows.ts'

// pretext reads the canvas and navigator lazily, on the first measurement.
installFakeCanvas()

const {minimumContainerWidth, maximumContainerWidth, maximumRowHeight} = textRowLayout

function comparable(output: TextRowsOutput): ReferenceOutput {
  return {scrollTop: output.scrollTop, firstRow: output.firstRow, totalHeight: output.totalHeight, full: output.full, slotOverflow: output.slotOverflow, slots: drawnSlots(output)}
}

// Generated messages joined until the text is at least `characters` long, e.g. 1,000 characters, which lose about 15
// lines as the container narrows from 1200 to 375 px.
function textOfLength(seed: number, characters: number) {
  let text = generateMessage(seed)
  for (let index = 1; text.length < characters; index++) text += ` ${generateMessage(seed * 31 + index)}`
  return text
}

function createSession(options: TextRowsOptions) {
  const program = buildTextRows(options)
  const machine = createTextRowsMachine(program)
  const reference = createTextRowsReference(options)
  const tables: ReturnType<typeof tabulateTextRow>[] = []
  return {
    program,
    machine,
    reference,
    tables,
    setText(row: number, text: string) {
      const rowTable = tabulateTextRow(prepareText(text), options.breakpointCapacity)
      machine.writeRow(row, rowTable)
      reference.setRow(row, text)
      tables[row] = rowTable
    },
    // Runs one frame on both sides and returns both outputs.
    frame(frameInput: TextRowsInput) {
      const output = machine.step(frameInput)
      return {output, got: comparable(output), expected: reference.frame(frameInput)}
    },
  }
}

describe('row heights', () => {
  test('every row height equals pretext\'s layout at every whole-pixel container width, including rows past the breakpoint capacity', () => {
    for (const breakpointCapacity of [3, 7]) {
      const capacity = 64
      const program = buildTextRows({capacity, slotCount: 8, breakpointCapacity})
      const machine = createTextRowsMachine(program)
      const texts = Array.from({length: capacity}, (_, row) => row % 8 === 7 ? textOfLength(row, 400 + row * 10) : generateMessage(row))
      const prepared = texts.map(prepareText)
      const minimumWidths = prepared.map((row, index) => {
        const rowTable = tabulateTextRow(row, breakpointCapacity)
        machine.writeRow(index, rowTable)
        // The table's minimum width is the reference's, found by scanning every width down from the widest, and its
        // base height is pretext's height at that width.
        expect(rowTable.minimumWidth).toBe(referenceMinimumWidth(row, breakpointCapacity))
        expect(rowTable.baseHeight).toBe(textRowHeight(row, rowTable.minimumWidth))
        return rowTable.minimumWidth
      })
      const evaluateHeights = program.circuit.createTensorEvaluator(program.rowHeights)
      const mismatches: string[] = []
      let heightChanges = 0
      let previousHeights: number[] = []
      for (let width: number = minimumContainerWidth; width <= maximumContainerWidth; width++) {
        machine.source[program.cells.containerWidth] = width
        const heights = [...evaluateHeights(machine.source)]
        heights.forEach((height, row) => {
          const expected = textRowHeight(prepared[row]!, Math.max(width, minimumWidths[row]!))
          if (height !== expected && mismatches.length < 5) mismatches.push(`row ${row} at ${width} px: ${height}, pretext ${expected}`)
          if (previousHeights.length > 0 && height !== previousHeights[row]) heightChanges++
        })
        previousHeights = heights
      }
      expect(mismatches).toEqual([])
      // The sweep crosses many breakpoints, and some rows are clamped at a minimum width past 375 px.
      expect(heightChanges).toBeGreaterThan(50)
      expect(minimumWidths.filter(width => width > minimumContainerWidth).length).toBeGreaterThan(breakpointCapacity === 3 ? 10 : 4)
    }
  })

  test('a text 160 to 256 px tall at 1200 px gets its minimum width where it would pass 256 px, before it loses 7 lines', () => {
    for (const characters of [1900, 2300, 2700]) {
      const prepared = prepareText(textOfLength(3, characters))
      const widestHeight = textRowHeight(prepared, maximumContainerWidth)
      expect(widestHeight).toBeGreaterThan(160)
      expect(widestHeight).toBeLessThanOrEqual(maximumRowHeight)
      const rowTable = tabulateTextRow(prepared, 7)
      // Fewer than 7 kept lines: the 256 px limit decides the minimum width, not the breakpoint cells.
      expect(rowTable.breakpoints.filter(breakpoint => breakpoint !== unusedBreakpoint).length).toBeLessThan(7)
      expect(rowTable.minimumWidth).toBe(referenceMinimumWidth(prepared, 7))
      expect(rowTable.baseHeight).toBe(textRowHeight(prepared, rowTable.minimumWidth))
      expect(rowTable.baseHeight).toBeLessThanOrEqual(maximumRowHeight)
    }
  })

  test('a text whose height at 1200 px is past 256 px is refused while preparing', () => {
    expect(() => tabulateTextRow(prepareText(textOfLength(5, 6000)), 7)).toThrow('a text row must be at most 256 px tall at 1200 px')
  })
})

describe('slots, scroll position and anchoring', () => {
  test('scripted: a resize that changes every row height keeps the top row of the view in place, edits above the view do too, a scroll and a resize in one frame keep the row scrolled to in place, and a view at the end follows appended rows until the table is full', () => {
    const options = {capacity: 320, slotCount: 64, breakpointCapacity: 7}
    const session = createSession(options)
    // Every row is at least 200 characters, so every row's height at 400 px differs from its height at 1100 px.
    const texts = Array.from({length: 300}, (_, row) => textOfLength(row, 200))
    texts.forEach((text, row) => session.setText(row, text))
    expect(texts.every(text => textRowHeight(prepareText(text), 400) > textRowHeight(prepareText(text), 1100))).toBe(true)
    const view = {containerWidth: 1100, viewportHeight: 700, scrollTop: 0, rowCount: 300}
    const run = () => {
      const {output, got, expected} = session.frame(view)
      expect(got).toEqual(expected)
      view.scrollTop = output.scrollTop
      return got
    }
    const screenTopOf = (frame: ReferenceOutput, row: number) => frame.slots.find(slot => slot.row === row)!.top - frame.scrollTop

    // The first frame starts at the end of the rows, like a chat log.
    let frame = run()
    expect(frame.scrollTop).toBe(frame.totalHeight - 700)
    // The user scrolls to the middle, to a scroll position a quarter pixel off the whole pixels.
    view.scrollTop = Math.floor(frame.totalHeight / 2) + 10.25
    frame = run()
    expect(frame.scrollTop).toBe(view.scrollTop)
    const anchorRow = frame.firstRow
    const screenTop = screenTopOf(frame, anchorRow)
    expect(screenTop).toBeLessThan(0)
    const totalAt1100 = frame.totalHeight

    // A resize to 400 px: every row gets taller, and the anchor row keeps its position on screen.
    view.containerWidth = 400
    frame = run()
    expect(frame.totalHeight).toBeGreaterThan(totalAt1100 + 300 * 14 - 1)
    expect(frame.firstRow).toBe(anchorRow)
    expect(screenTopOf(frame, anchorRow)).toBe(screenTop)
    // And back to 1100 px, the same row at the same place.
    view.containerWidth = 1100
    frame = run()
    expect(frame.totalHeight).toBe(totalAt1100)
    expect(screenTopOf(frame, anchorRow)).toBe(screenTop)

    // An edit 3 rows above the view gives that row a much longer text: the total height grows by that row's change in
    // height, and the rows in view stay where they are.
    const editedRow = anchorRow - 3
    const editedText = textOfLength(9_999, 1000)
    const heightAt1100 = (text: string) => textRowHeight(prepareText(text), Math.max(1100, referenceMinimumWidth(prepareText(text), 7)))
    const heightChange = heightAt1100(editedText) - heightAt1100(texts[editedRow]!)
    expect(heightChange).toBeGreaterThan(28)
    session.setText(editedRow, editedText)
    frame = run()
    expect(frame.totalHeight).toBe(totalAt1100 + heightChange)
    expect(screenTopOf(frame, anchorRow)).toBe(screenTop)

    // A scroll by half a view and a resize to 400 px in one frame: the row at the scroll position the DOM reports, as
    // the DOM showed it before the frame, keeps its position on screen, even though the rows between the old top row
    // and that row got taller.
    const scrolledTo = frame.scrollTop + 350.5
    const rowAtScroll = frame.slots.find(slot => slot.top <= scrolledTo && scrolledTo < slot.top + slot.height)!
    expect(rowAtScroll.row).toBeGreaterThan(anchorRow)
    view.scrollTop = scrolledTo
    view.containerWidth = 400
    frame = run()
    expect(screenTopOf(frame, rowAtScroll.row)).toBe(rowAtScroll.top - scrolledTo)
    view.containerWidth = 1100
    frame = run()
    expect(screenTopOf(frame, rowAtScroll.row)).toBe(rowAtScroll.top - scrolledTo)

    // A view that shows the end of the rows follows an appended row.
    view.scrollTop = frame.totalHeight
    frame = run()
    session.setText(300, 'A new message at the end.')
    view.rowCount = 301
    frame = run()
    expect(frame.scrollTop).toBe(frame.totalHeight - 700)
    expect(frame.slots.some(slot => slot.row === 300)).toBe(true)
    // A view scrolled up doesn't move when rows are appended.
    view.scrollTop = Math.floor(frame.totalHeight / 3)
    frame = run()
    const scrolledUp = frame.scrollTop
    session.setText(301, 'Another message.')
    view.rowCount = 302
    frame = run()
    expect(frame.scrollTop).toBe(scrolledUp)
    expect(frame.full).toBe(0)
    // Appending up to the capacity sets `full`, after which the host refuses rows.
    for (let row = 302; row < 320; row++) session.setText(row, generateMessage(row))
    view.rowCount = 320
    frame = run()
    expect(frame.full).toBe(1)
  })

  test('scripted: a chat log that starts empty keeps scrollTop at 0 and draws exactly the rows below the row count while the rows are shorter than the view, then follows appended rows', () => {
    const options = {capacity: 64, slotCount: 64, breakpointCapacity: 3}
    const session = createSession(options)
    const view = {containerWidth: 800, viewportHeight: 600, scrollTop: 0, rowCount: 0}
    let shortFrames = 0
    let tallFrames = 0
    for (let rowCount = 0; rowCount <= 30; rowCount++) {
      if (rowCount > 0) session.setText(rowCount - 1, generateMessage(500 + rowCount))
      view.rowCount = rowCount
      const {output, got, expected} = session.frame(view)
      expect(got).toEqual(expected)
      // At most 20 rows of at least 30 px fit in 600 px, so 64 slots never overflow.
      expect(got.slotOverflow).toBe(0)
      if (got.totalHeight <= view.viewportHeight) {
        shortFrames++
        expect(got.scrollTop).toBe(0)
        expect(got.slots.map(slot => slot.row)).toEqual(Array.from({length: rowCount}, (_, row) => row))
      } else {
        tallFrames++
        expect(got.scrollTop).toBe(got.totalHeight - view.viewportHeight)
        expect(got.slots.every(slot => slot.row < rowCount)).toBe(true)
      }
      view.scrollTop = output.scrollTop
    }
    expect(shortFrames).toBeGreaterThan(5)
    expect(tallFrames).toBeGreaterThan(5)
  })

  test('random sessions of scrolls, resizes, viewport changes, appends, edits, and scrolls in the same frame as a resize or an edit match the reference on every frame, and every fallback shows up', () => {
    const counts = {frames: 0, resizesThatChangedTotal: 0, anchoredFrames: 0, anchoredFramesWithScroll: 0, followedAppends: 0, refusedAppends: 0, overflowFrames: 0, clampedSlots: 0, emptyViews: 0, shortListFrames: 0, edits: 0}
    const mismatches: string[] = []
    const cases: {options: TextRowsOptions, seeds: number[], frames: number}[] = [
      {options: {capacity: 48, slotCount: 8, breakpointCapacity: 3}, seeds: [1, 2, 3, 4], frames: 500},
      {options: {capacity: 200, slotCount: 16, breakpointCapacity: 7}, seeds: [5, 6], frames: 400},
    ]
    for (const {options, seeds, frames} of cases) {
      for (const seed of seeds) {
        const session = createSession(options)
        const random = createRandom(seed)
        const textFor = (index: number) => random() < 0.15 ? textOfLength(seed * 10_000 + index, 300 + Math.floor(random() * 900)) : generateMessage(seed * 10_000 + index)
        // What the DOM holds before a frame: the scroller's size and scrollTop, and the spacer's height from the last frame.
        // Odd seeds start with 0 to 3 rows, like a new chat log, where the rows are often shorter than the view.
        const initialRows = seed % 2 === 1 ? Math.floor(random() * 4) : Math.floor(random() * options.capacity * 0.7)
        const dom = {containerWidth: 800, viewportHeight: 400, scrollTop: 0, spacerHeight: 0, rowCount: initialRows}
        for (let row = 0; row < dom.rowCount; row++) session.setText(row, textFor(row))
        let previous: ReferenceOutput | undefined
        // A scroll to a random quarter pixel, to a drawn row's edge or a quarter pixel above it, or past either end,
        // which the browser clamps.
        const scroll = () => {
          const maximumDomScroll = Math.max(0, dom.spacerHeight - dom.viewportHeight)
          const pick = random()
          const slot = previous?.slots[Math.floor(random() * previous.slots.length)]
          let target = Math.floor(random() * (maximumDomScroll + 1) * 4) / 4
          if (pick < 0.4 && slot !== undefined) target = [slot.top, slot.top + slot.height, slot.top - 0.25, slot.top + slot.height - 0.25][Math.floor(random() * 4)]!
          else if (pick < 0.5) target = random() < 0.5 ? -100 : maximumDomScroll + 100
          dom.scrollTop = Math.min(maximumDomScroll, Math.max(0, target))
        }
        // A resize to a random width, to one of a drawn row's breakpoints or a pixel below it, or to its minimum width.
        const resize = () => {
          const slot = previous?.slots[Math.floor(random() * previous.slots.length)]
          const rowTable = slot === undefined ? undefined : session.tables[slot.row]
          const breakpoint = rowTable?.breakpoints[Math.floor(random() * rowTable.breakpoints.length)]
          const pick = random()
          if (pick < 0.4 && rowTable !== undefined && breakpoint !== undefined && breakpoint <= maximumContainerWidth) dom.containerWidth = breakpoint - Math.floor(random() * 2)
          else if (pick < 0.5 && rowTable !== undefined) dom.containerWidth = rowTable.minimumWidth - Math.floor(random() * 2)
          else dom.containerWidth = minimumContainerWidth + Math.floor(random() * (maximumContainerWidth - minimumContainerWidth + 1))
        }
        // An edit of a random row's text.
        const edit = (frameIndex: number) => {
          if (dom.rowCount === 0) return
          session.setText(Math.floor(random() * dom.rowCount), textFor(options.capacity + frameIndex))
          counts.edits++
        }
        for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
          const action = random()
          let kind: 'scroll' | 'resize' | 'scroll and resize' | 'viewport' | 'append' | 'edit' | 'scroll and edit'
          if (action < 0.25) {
            kind = 'scroll'
            scroll()
          } else if (action < 0.45) {
            kind = 'resize'
            resize()
          } else if (action < 0.55) {
            kind = 'scroll and resize'
            scroll()
            resize()
          } else if (action < 0.62) {
            // A viewport height change, after which the browser clamps scrollTop.
            kind = 'viewport'
            dom.viewportHeight = [0, 30, 200, Math.floor(random() * 1200)][Math.floor(random() * 4)]!
            dom.scrollTop = Math.min(dom.scrollTop, Math.max(0, dom.spacerHeight - dom.viewportHeight))
          } else if (action < 0.82) {
            // An append, which the host refuses once the table is full.
            kind = 'append'
            if (dom.rowCount < options.capacity) {
              session.setText(dom.rowCount, textFor(dom.rowCount))
              dom.rowCount++
            } else {
              counts.refusedAppends++
            }
          } else if (action < 0.92) {
            kind = 'edit'
            edit(frameIndex)
          } else {
            kind = 'scroll and edit'
            scroll()
            edit(frameIndex)
          }
          const frameInput = quantizeTextRowsInput(dom, options.capacity)
          const atBottomBefore = frameInput.scrollTop + frameInput.viewportHeight >= dom.spacerHeight
          // Independent of the reference: the row at the top of the view as the DOM shows it before this frame, the last
          // frame's drawn row that covers the DOM's scroll position, and its position on screen.
          const rowAtScroll = previous?.slots.find(slot => slot.top <= frameInput.scrollTop && frameInput.scrollTop < slot.top + slot.height)
          const {output, got, expected} = session.frame(frameInput)
          counts.frames++
          if (JSON.stringify(got) !== JSON.stringify(expected) && mismatches.length < 3) {
            mismatches.push(JSON.stringify({seed, frameIndex, kind, frameInput, got: {...got, slots: got.slots.slice(0, 4)}, expected: {...expected, slots: expected.slots.slice(0, 4)}}))
          }
          if (frameIndex % 50 === 0) {
            const values = session.program.circuit.evaluateReference(session.machine.source)
            validateIndexReads(session.program.circuit, values)
            validateGrids(session.program.circuit, values)
          }
          if (kind.includes('resize') && previous !== undefined && got.totalHeight !== previous.totalHeight) counts.resizesThatChangedTotal++
          // When rows change height and the view isn't at the end or clamped, that row keeps its screen position.
          const anchorSlot = rowAtScroll === undefined ? undefined : got.slots.find(slot => slot.row === rowAtScroll.row)
          if ((kind.includes('resize') || kind.includes('edit')) && !atBottomBefore && rowAtScroll !== undefined && anchorSlot !== undefined && got.scrollTop > 0 && got.scrollTop < got.totalHeight - frameInput.viewportHeight && previous !== undefined && got.totalHeight !== previous.totalHeight) {
            expect(anchorSlot.top - got.scrollTop).toBe(rowAtScroll.top - frameInput.scrollTop)
            counts.anchoredFrames++
            if (kind.startsWith('scroll and') && frameInput.scrollTop !== previous.scrollTop) counts.anchoredFramesWithScroll++
          }
          if (kind === 'append' && atBottomBefore && previous !== undefined && got.totalHeight > previous.totalHeight && got.totalHeight > frameInput.viewportHeight) {
            expect(got.scrollTop).toBe(got.totalHeight - frameInput.viewportHeight)
            counts.followedAppends++
          }
          if (got.slotOverflow === 1) counts.overflowFrames++
          counts.clampedSlots += got.slots.filter(slot => slot.clamped === 1).length
          if (got.slots.length === 0) counts.emptyViews++
          if (frameInput.rowCount > 0 && got.totalHeight < frameInput.viewportHeight) counts.shortListFrames++
          // The host writes the program's scroll position and total height into the DOM.
          dom.scrollTop = output.scrollTop
          dom.spacerHeight = output.totalHeight
          previous = expected
        }
      }
    }
    expect(mismatches).toEqual([])
    for (const [name, count] of Object.entries(counts)) expect([name, count > 0]).toEqual([name, true])
    // TEXT_ROWS_COUNTS=1 bun test lab/ui-exploration/lists/text-rows.test.ts prints the counts for the README.
    if (process.env['TEXT_ROWS_COUNTS'] === '1') console.log(JSON.stringify(counts))
  })

  test('10,000 rows: scroll and resize frames match the reference', () => {
    const options = {capacity: 10_000, slotCount: 64, breakpointCapacity: 7}
    const session = createSession(options)
    for (let row = 0; row < options.capacity; row++) session.setText(row, generateMessage(row))
    const random = createRandom(77)
    const view = {containerWidth: 900, viewportHeight: 900, scrollTop: 0, rowCount: options.capacity}
    for (let frameIndex = 0; frameIndex < 24; frameIndex++) {
      if (frameIndex % 3 !== 1) view.scrollTop = Math.floor(random() * 4 * 400_000) / 4
      if (frameIndex % 3 !== 0) view.containerWidth = minimumContainerWidth + Math.floor(random() * 826)
      const {output, got, expected} = session.frame(quantizeTextRowsInput(view, options.capacity))
      expect(got).toEqual(expected)
      view.scrollTop = output.scrollTop
    }
  })
})

describe('refused inputs', () => {
  test('the table check rejects a container width outside 375..1200', () => {
    const session = createSession({capacity: 8, slotCount: 8, breakpointCapacity: 3})
    expect(() => session.machine.step({containerWidth: 1201, viewportHeight: 100, scrollTop: 0, rowCount: 0})).toThrow('containerWidth must be finite and within 375..1200, got 1201')
  })

  test('writeRow refuses breakpoints that decrease or that sit at or below the minimum width, and buildTextRows refuses more than 16,384 rows', () => {
    const {machine} = createSession({capacity: 8, slotCount: 8, breakpointCapacity: 7})
    const unused = unusedBreakpoint
    expect(() => machine.writeRow(0, {baseHeight: 70, minimumWidth: 375, breakpoints: [unused, unused, unused, 375, 375, 375, 375]})).toThrow('row 0\'s breakpoints must never decrease')
    // Every value is a valid breakpoint on its own, but 512 comes after 900.
    expect(() => machine.writeRow(0, {baseHeight: 70, minimumWidth: 375, breakpoints: [900, 512, unused, unused, unused, unused, unused]})).toThrow('row 0\'s breakpoints must never decrease')
    expect(() => machine.writeRow(1, {baseHeight: 70, minimumWidth: 600, breakpoints: [600, unused, unused, unused, unused, unused, unused]})).toThrow('row 1\'s breakpoints must never decrease, and each one must be a whole pixel above the minimum width 600 px')
    // 40 px minus 2 lost lines of 14 px leaves 12 px, less than one line.
    expect(() => machine.writeRow(2, {baseHeight: 40, minimumWidth: 375, breakpoints: [500, 600, unused, unused, unused, unused, unused]})).toThrow('row 2\'s base height must be a whole pixel')
    machine.writeRow(3, {baseHeight: 70, minimumWidth: 375, breakpoints: [512, 512, 900, unused, unused, unused, unused]})
    // 16,384 rows × 256 px is 2^22 px, the largest scroll position at which FP32 still holds every quarter pixel.
    expect(() => buildTextRows({capacity: 16_385, slotCount: 64, breakpointCapacity: 1})).toThrow('capacity must be within 1..16,384')
  })
})

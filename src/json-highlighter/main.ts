// The page: a transparent textarea over a <pre> that shows the text. Each input or caret move schedules one frame, which
// writes the text and the caret into the program's cells, evaluates the program, and writes the DOM from the program's
// outputs: a class per character, the first error, and the bracket that matches the bracket at the caret.
// ?form=brent-kung or ?form=sklansky picks another build of the same program, and ?capacity=512&depth=16 builds other
// limits than the page's 2,048 code points and depth 13, e.g. the defaults that the folder's README measures.
import {invariant} from '../runtime/numeric-ui-core.ts'
import {type ScanForm, createHighlighterMachine, scanForms} from './highlighter.ts'
import {type Limits, displayKind, errorKind, errorKinds, pageLimits} from './kinds.ts'

// One entry per rendered frame. scripts/measure-json-highlighter-browser.ts reads the entries from
// window.jsonHighlighter in headless Chrome.
type FrameTiming = {inputToFrameMs: number, evaluateMs: number, domMs: number}

// One formatter for every count, e.g. 2,048. Number's toLocaleString builds a formatter on each call, which took
// about 25 µs per call in Chrome 155.
const countFormat = new Intl.NumberFormat('en-US')
const formatCount = (value: number) => countFormat.format(value)
// Chrome's clock reads in steps of 0.1 ms on a page like this one, so a shorter time is shown as that.
const formatMs = (milliseconds: number) => milliseconds < 0.05 ? 'under 0.1 ms' : `${milliseconds.toFixed(1)} ms`

// How each form computes the state after every character, for the details line.
const formDescriptions: {[Form in ScanForm]: string} = {
  'loop': 'the loop form of the program, where each character&rsquo;s step reads the state that the step before it left, one layer after another',
  'brent-kung': 'the Brent-Kung form of the program, where the characters&rsquo; steps are combined in a tree, which takes more operations in fewer layers than the loop form',
  'sklansky': 'the Sklansky form of the program, where the characters&rsquo; steps are combined in a tree, which takes more operations in fewer layers than the loop form',
}

// The first error as a sentence. Each sentence is about the character at the error's position, which the page
// underlines, e.g. the 2 of [1 2] for expectedCommaOrClose. kinds.ts has an example of every kind. Every sentence is
// short enough to stay on one line beside the character count in a page 800 px wide, so the lines under the editor
// don't move while errors come and go with the keystrokes.
function errorSentences({maximumDepth}: Limits): {[Kind in typeof errorKinds[number]]: string} {
  return {
    none: 'Valid JSON.',
    unexpectedCharacter: 'Nothing in JSON starts with this character.',
    // For a tab or another control character. A line break has its own sentence, unclosedStringSentence.
    controlCharacterInString: 'This character needs an escape inside a string, e.g. \\t for a tab.',
    badEscape: 'After a backslash come only " \\ / b f n r t or u.',
    badUnicodeEscape: '\\u needs four hexadecimal digits after it, e.g. \\u00e9.',
    badNumber: 'This isn\'t a JSON number, just as 01, 1. and 1e aren\'t.',
    badLiteral: 'This word isn\'t true, false or null.',
    expectedValue: 'A value was expected here, e.g. a string or a number.',
    expectedKey: 'A key in double quotes was expected here, e.g. "name".',
    expectedColon: 'A colon was expected here, after the key.',
    expectedCommaOrClose: 'A comma or a closing bracket was expected here.',
    mismatchedBracket: 'This bracket is the wrong kind: { ends with } and [ with ].',
    extraAfterValue: 'The value ended before this, and only blank space may follow it.',
    tooDeep: `This bracket opens nesting level ${maximumDepth + 1}, and the program follows ${maximumDepth}.`,
    unexpectedEnd: 'The text ends before the value is complete.',
    // The page writes this sentence itself, with the text's length.
    tooLong: '',
  }
}
const unclosedStringSentence = 'This string isn\'t closed before the end of its line.'

// The characters before a lexer error that belong to the token it breaks, by display kind, e.g. the tru of trux for
// badLiteral. The page underlines them together with the error's character, so "this word" has a word to point at.
const stringKinds = [displayKind.string, displayKind.escape, displayKind.key]
const tokenKindsBefore: {[kind: number]: readonly number[]} = {
  [errorKind.controlCharacterInString]: stringKinds,
  [errorKind.badEscape]: [displayKind.escape],
  [errorKind.badUnicodeEscape]: [displayKind.escape],
  [errorKind.badNumber]: [displayKind.number],
  [errorKind.badLiteral]: [displayKind.literal],
}
// The characters after a grammar error's position that belong to the same token, e.g. the whole "b" of {"a": 1 "b": 2}.
const tokenKindsAfter: {[kind: number]: readonly number[]} = {
  [displayKind.string]: stringKinds,
  [displayKind.number]: [displayKind.number],
  [displayKind.literal]: [displayKind.literal],
}
const grammarErrorKinds = [
  errorKind.expectedValue, errorKind.expectedKey, errorKind.expectedColon, errorKind.expectedCommaOrClose,
  errorKind.mismatchedBracket, errorKind.extraAfterValue, errorKind.tooDeep,
]

const lineFeed = 0x0a

// A character's class as one number: its display kind, plus a bit when it's a matched bracket and a bit when it's
// underlined as the first error. pastCode is every character that the program doesn't read.
const matchBit = 16
const errorBit = 32
const pastCode = 64
// k0 to k8, in the order of kinds.ts's displayKinds, e.g. k2 is a string character.
const codeClasses = Array.from({length: pastCode + 1}, (_, code) => code === pastCode
  ? 'past-capacity'
  : `k${code & 15}${(code & matchBit) !== 0 ? ' match' : ''}${(code & errorBit) !== 0 ? ' first-error' : ''}`)

// What a frame shows in the <pre>: the text, a class per character, and three marks.
type Shown = {
  text: string
  // The UTF-16 length of the part of the text that the program reads. The textarea counts UTF-16 code units, and the
  // program counts code points.
  readUnits: number
  // A class code per code unit below readUnits. Both units of a surrogate pair hold the pair's code.
  codes: Uint8Array
  // The code unit where each line starts.
  lineStarts: number[]
  // Where the caret is, and where the end marker is, or -1.
  caretUnit: number
  markerUnit: number
}
const codeAt = (shown: Shown, unit: number) => unit < shown.readUnits ? shown.codes[unit]! : pastCode
// A line ends at its line feed, or at the end of the text.
const lineEnd = (shown: Shown, line: number) => line + 1 < shown.lineStarts.length ? shown.lineStarts[line + 1]! - 1 : shown.text.length
// Where a longer text is cut, or -1.
const cutUnit = (shown: Shown) => shown.readUnits < shown.text.length ? shown.readUnits : -1
// A mark's place in a line, or -1 when the mark is on another line.
const placeInLine = (unit: number, start: number, end: number) => unit >= start && unit <= end ? unit - start : -1

// A line's block in the <pre>, with the spans it holds and each span's class and text, so that writing the line again
// changes only the spans that differ.
type LineBlock = {element: HTMLDivElement, spans: HTMLSpanElement[], classes: string[], texts: string[]}

function sameLine(left: Shown, leftLine: number, right: Shown, rightLine: number) {
  const leftStart = left.lineStarts[leftLine]!
  const leftEnd = lineEnd(left, leftLine)
  const rightStart = right.lineStarts[rightLine]!
  const rightEnd = lineEnd(right, rightLine)
  const length = leftEnd - leftStart
  if (length !== rightEnd - rightStart) return false
  if (placeInLine(left.caretUnit, leftStart, leftEnd) !== placeInLine(right.caretUnit, rightStart, rightEnd)) return false
  if (placeInLine(left.markerUnit, leftStart, leftEnd) !== placeInLine(right.markerUnit, rightStart, rightEnd)) return false
  if (placeInLine(cutUnit(left), leftStart, leftEnd) !== placeInLine(cutUnit(right), rightStart, rightEnd)) return false
  for (let offset = 0; offset < length; offset++) {
    if (left.text.charCodeAt(leftStart + offset) !== right.text.charCodeAt(rightStart + offset)) return false
    if (codeAt(left, leftStart + offset) !== codeAt(right, rightStart + offset)) return false
  }
  return true
}

// Changes a list of DOM nodes into nodes for `newCount` items with few writes. same(newIndex, oldIndex) says whether
// the new item at newIndex shows what the node at oldIndex shows. The nodes that are the same at the start and at the
// end of the list stay. Of the nodes between them, as many as both lists have are kept, and written where they
// differ, and the rest of the new items get new nodes, or the rest of the old nodes are removed. The kept nodes are
// counted from the start or from the end of that stretch, whichever leaves fewer to write, e.g. after a keystroke
// that adds a comma and turns every later key into a string, counting from the end keeps each later node at its item.
function writeList<Entry>(
  entries: Entry[],
  newCount: number,
  parent: Node,
  nodeOf: (entry: Entry) => Node,
  same: (newIndex: number, oldIndex: number) => boolean,
  write: (entry: Entry, newIndex: number, oldIndex: number) => void,
  create: (newIndex: number) => Entry,
): Entry[] {
  const oldCount = entries.length
  const sharedCount = Math.min(oldCount, newCount)
  let prefix = 0
  while (prefix < sharedCount && same(prefix, prefix)) prefix++
  let suffix = 0
  while (suffix < sharedCount - prefix && same(newCount - 1 - suffix, oldCount - 1 - suffix)) suffix++
  const kept = sharedCount - prefix - suffix
  const oldEnd = oldCount - suffix
  const newEnd = newCount - suffix
  let differentFromStart = 0
  let differentFromEnd = 0
  for (let index = 0; index < kept; index++) {
    if (!same(prefix + index, prefix + index)) differentFromStart++
    if (!same(newEnd - 1 - index, oldEnd - 1 - index)) differentFromEnd++
  }
  const fromEnd = differentFromEnd < differentFromStart
  const oldStart = fromEnd ? oldEnd - kept : prefix
  const newStart = fromEnd ? newEnd - kept : prefix
  for (let index = 0; index < kept; index++) {
    if (!same(newStart + index, oldStart + index)) write(entries[oldStart + index]!, newStart + index, oldStart + index)
  }
  // The items that aren't kept are at the other end of the stretch from the kept ones.
  const rest = fromEnd ? prefix : prefix + kept
  if (newCount > oldCount) {
    const following = rest < oldCount ? nodeOf(entries[rest]!) : null
    const created: Entry[] = []
    for (let index = rest; index < rest + newCount - oldCount; index++) {
      const entry = create(index)
      parent.insertBefore(nodeOf(entry), following)
      created.push(entry)
    }
    return [...entries.slice(0, rest), ...created, ...entries.slice(rest)]
  }
  for (const entry of entries.splice(rest, oldCount - newCount)) parent.removeChild(nodeOf(entry))
  return entries
}

function mountJsonHighlighter(document: Document, window: Window) {
  const parameters = new URLSearchParams(window.location.search)
  const requestedForm = parameters.get('form') as ScanForm | null
  const form: ScanForm = requestedForm !== null && scanForms.includes(requestedForm) ? requestedForm : 'loop'
  // A value outside what the builder accepts, or a capacity that would take seconds to build, falls back to the page's.
  const integerParameter = (name: string, minimum: number, maximum: number, fallback: number) => {
    const written = parameters.get(name)
    const value = written === null ? Number.NaN : Number(written)
    return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback
  }
  const limits: Limits = {
    capacity: integerParameter('capacity', 1, 8192, pageLimits.capacity),
    maximumDepth: integerParameter('depth', 2, 24, pageLimits.maximumDepth),
  }
  const {capacity} = limits
  const buildStart = window.performance.now()
  const machine = createHighlighterMachine(form, limits)
  const buildMs = window.performance.now() - buildStart
  const sentences = errorSentences(limits)

  const textarea = document.querySelector('textarea')
  const pre = document.querySelector('pre')
  const gutter = document.querySelector<HTMLElement>('.editor-gutter')
  const status = document.querySelector<HTMLElement>('.status')
  const statusPosition = document.querySelector<HTMLElement>('.status b')
  const statusSentence = document.querySelector<HTMLElement>('.status b + span')
  const count = document.querySelector<HTMLElement>('.capacity')
  const countUsed = document.querySelector<HTMLElement>('.capacity b')
  const countOf = document.querySelector<HTMLElement>('.capacity b + span')
  const statistics = document.querySelector<HTMLElement>('.stats')
  const details = document.querySelector<HTMLElement>('.disclosure .stats')
  invariant(textarea !== null, 'the textarea is missing')
  invariant(pre !== null, 'the <pre> under the textarea is missing')
  invariant(gutter !== null, 'the gutter of line numbers is missing')
  invariant(status !== null && statusPosition !== null && statusSentence !== null, 'the result line is missing')
  invariant(count !== null && countUsed !== null && countOf !== null, 'the character count is missing')
  invariant(statistics !== null, 'the statistics line is missing')
  invariant(details !== null, 'the details line is missing')

  const createLineBlock = (): LineBlock => ({element: document.createElement('div'), spans: [], classes: [], texts: []})
  const domCache = {
    textarea, // mount lifetime
    pre, // mount lifetime
    gutter, // mount lifetime
    status, // mount lifetime
    statusPosition, // mount lifetime
    statusSentence, // mount lifetime
    count, // mount lifetime
    countUsed, // mount lifetime
    statistics, // mount lifetime
    details, // mount lifetime
    // The <pre>'s children, one block per line of the text, so that a keystroke lays out one line and not the whole
    // text. A block lives while the text has its line. The <pre> starts with the one empty line of an empty text.
    lines: [createLineBlock()],
    // The line number of each line, in the gutter, with the same lifetime as the line's block.
    lineNumbers: [] as HTMLSpanElement[],
    // The empty span at the caret's place, which lives while the caret stays at that place in its line.
    caretAnchor: null as HTMLSpanElement | null,
  }
  pre.appendChild(domCache.lines[0]!.element)
  // What the DOM holds now, so a frame writes only what changes. The result line is an ARIA live region, which a
  // screen reader would read again after a write of the same sentence, e.g. on every caret move.
  let shown: Shown = {text: '', readUnits: 0, codes: new Uint8Array(2 * capacity), lineStarts: [0], caretUnit: -1, markerUnit: -1}
  // Each frame is computed into `next`, and after the DOM writes the two trade places.
  let next: Shown = {text: '', readUnits: 0, codes: new Uint8Array(2 * capacity), lineStarts: [0], caretUnit: -1, markerUnit: -1}
  const written = {
    lineNumberClasses: [] as string[],
    statusClass: '',
    statusPosition: '',
    statusSentence: '',
    countClass: '',
    countUsed: '',
    statistics: '',
    details: '',
  }
  countOf.textContent = ` of ${formatCount(capacity)} characters`

  // Writes one line of `next` into its block: a span per run of characters with the same class, e.g. a whole string,
  // and an empty span per mark. Marks at the same place come in the order caret, end marker, cut.
  function writeLine(block: LineBlock, line: number) {
    const start = next.lineStarts[line]!
    const end = lineEnd(next, line)
    const cut = cutUnit(next)
    const classes: string[] = []
    const texts: string[] = []
    let runStart = start
    let runCode = -1
    const endRun = (at: number) => {
      if (at > runStart) {
        classes.push(codeClasses[runCode]!)
        texts.push(next.text.slice(runStart, at))
      }
      runStart = at
    }
    const mark = (at: number, className: string) => {
      endRun(at)
      classes.push(className)
      texts.push('')
    }
    for (let unit = start; ; unit++) {
      if (unit === next.caretUnit) mark(unit, 'caret-anchor')
      if (unit === next.markerUnit) mark(unit, 'end-marker')
      if (unit === cut) mark(unit, 'cut-mark')
      if (unit === end) break
      const code = codeAt(next, unit)
      // Every punctuation mark is a run of its own, so a bracket that becomes a matched bracket changes its span's
      // class and doesn't split or join spans, which would move every later span to another item.
      if (code !== runCode || (code & 15) === displayKind.punctuation) {
        endRun(unit)
        runCode = code
      }
    }
    endRun(end)

    // A keystroke inside a token writes one span's text, also in a text that is one long line.
    const oldClasses = block.classes
    const oldTexts = block.texts
    block.spans = writeList(
      block.spans, classes.length, block.element, span => span,
      (newIndex, oldIndex) => classes[newIndex] === oldClasses[oldIndex] && texts[newIndex] === oldTexts[oldIndex],
      (span, newIndex, oldIndex) => {
        if (texts[newIndex] !== oldTexts[oldIndex]) span.textContent = texts[newIndex]!
        if (classes[newIndex] !== oldClasses[oldIndex]) span.className = classes[newIndex]!
      },
      newIndex => {
        const span = document.createElement('span')
        span.className = classes[newIndex]!
        span.textContent = texts[newIndex]!
        return span
      },
    )
    block.classes = classes
    block.texts = texts
    const anchor = classes.indexOf('caret-anchor')
    if (anchor !== -1) domCache.caretAnchor = block.spans[anchor]!
  }

  // The part of the details line that never changes: the form, the build's time, the numbers that go in, and the
  // two limits.
  const sourceSize = machine.built.circuit.sourceSize
  const detailsStart = `The page runs ${formDescriptions[form]}. The program took <b>${formatCount(Math.round(buildMs))} ms</b> to build when the page loaded. `
    + `It reads <b>${formatCount(sourceSize)}</b> numbers: <b>${formatCount(capacity + 2)}</b> that the page writes on every keystroke, `
    + `for up to <b>${formatCount(capacity)}</b> characters, the text&rsquo;s length and the caret&rsquo;s position, `
    + `and <b>${formatCount(sourceSize - capacity - 2)}</b> that hold JSON&rsquo;s rules as tables. It follows nesting up to <b>${limits.maximumDepth}</b> levels deep.`

  const frameTimings: FrameTiming[] = []
  ;(window as unknown as {jsonHighlighter: unknown}).jsonHighlighter = {form, limits, buildMs, frameTimings}

  // What the listeners record for the next frame.
  const events = {
    // When the first event since the last frame happened.
    firstTime: null as number | null,
    // A key was pressed or the text changed, as opposed to a click that only moves the caret.
    typed: false,
  }
  let scheduledRaf: number | null = null
  function scheduleRender(event: Event) {
    events.firstTime ??= event.timeStamp
    if (event.type === 'input' || event.type === 'keydown') events.typed = true
    scheduledRaf ??= window.requestAnimationFrame(renderHighlighter)
  }

  let renderedText: string | null = null
  let renderedSelectionStart = -1
  let renderedSelectionEnd = -1
  // The run that the statistics line and the details line describe: the first run until a key is pressed, and then
  // the last keystroke. inputToFrameMs is null until the frame after the run.
  type Run = {keystroke: boolean, inputTime: number, evaluateMs: number, domMs: number, inputToFrameMs: number | null}
  let described: Run | null = null
  // The run whose DOM writes haven't reached the screen yet. The next frame completes its timing.
  let pending: Run | null = null

  function renderHighlighter() {
    scheduledRaf = null
    // The time this frame's callback runs. An animation frame's own timestamp is when the frame began, which is
    // before the events that a long task delayed, e.g. the 0.15 s of building the program when the page mounts.
    const frameTime = window.performance.now()

    // DOM reads.
    const text = domCache.textarea.value
    const selectionStart = domCache.textarea.selectionStart
    const selectionEnd = domCache.textarea.selectionEnd

    // The frame after a run's DOM writes approximates when those writes reach the screen.
    if (pending !== null) {
      pending.inputToFrameMs = frameTime - pending.inputTime
      frameTimings.push({inputToFrameMs: pending.inputToFrameMs, evaluateMs: pending.evaluateMs, domMs: pending.domMs})
      pending = null
    }

    // A keystroke fires keydown, input, selectionchange and keyup, and only the first frame after them has anything new.
    const changed = text !== renderedText || selectionStart !== renderedSelectionStart || selectionEnd !== renderedSelectionEnd
    const inputTime = events.firstTime ?? frameTime
    const typed = events.typed
    events.firstTime = null
    events.typed = false

    let evaluateMs = 0
    let domStart = 0
    let revealCaret = false
    if (changed) {
      // The frame that mounts the page leaves the page where it is. Later frames follow the caret, and a selection's
      // end is followed by the browser while the pointer drags it.
      revealCaret = renderedText !== null && selectionStart === selectionEnd
      renderedText = text
      renderedSelectionStart = selectionStart
      renderedSelectionEnd = selectionEnd

      // The caret as a code point index, where capacity + 1 stands for every caret further than that.
      let caret = 0
      for (let unit = 0; unit < selectionStart && caret <= capacity; caret++) unit += text.codePointAt(unit)! > 0xffff ? 2 : 1

      const evaluateStart = window.performance.now()
      const output = machine.run(text, caret)
      domStart = window.performance.now()
      evaluateMs = domStart - evaluateStart
      const kinds = output.displayKinds
      const errorPosition = output.firstErrorPosition
      const errorIsShown = errorPosition !== -1 && output.firstErrorKind !== errorKind.tooLong

      // What to underline: the first error's character, with the rest of its token. A lexer error is at the character
      // that breaks a token, e.g. the comma of tru, so the token's characters before it are underlined too. A grammar
      // error is at a token's first character, e.g. the opening quote of a string where a comma should be, so the
      // token's characters after it are underlined too.
      let underlineStart = -1
      let underlineEnd = -1
      if (errorIsShown) {
        underlineStart = errorPosition
        underlineEnd = errorPosition + 1
        const before = tokenKindsBefore[output.firstErrorKind]
        if (before !== undefined) {
          while (underlineStart > 0 && before.includes(kinds[underlineStart - 1]!)) underlineStart--
        }
        const after = grammarErrorKinds.includes(output.firstErrorKind) ? tokenKindsAfter[kinds[errorPosition]!] : undefined
        if (after !== undefined) {
          while (underlineEnd < capacity && after.includes(kinds[underlineEnd]!)) underlineEnd++
        }
      }

      // The frame to show. One pass over the code points that the program reads gives each its class, finds where the
      // lines start, and finds the first error's line, column and character.
      next.text = text
      next.caretUnit = selectionStart
      next.lineStarts.length = 1
      let unit = 0
      let readCount = 0
      let line = 0
      let lineStartIndex = 0
      let errorLine = -1
      let errorColumn = -1
      let errorUnit = -1
      let errorCharacter = -1
      for (; unit < text.length && readCount < capacity; readCount++) {
        const codePoint = text.codePointAt(unit)!
        let code = kinds[readCount]!
        if (readCount === output.caretBracket || readCount === output.matchingBracket) code |= matchBit
        if (readCount >= underlineStart && readCount < underlineEnd) code |= errorBit
        if (readCount === errorPosition) {
          errorLine = line
          errorColumn = readCount - lineStartIndex + 1
          errorUnit = unit
          errorCharacter = codePoint
        }
        next.codes[unit++] = code
        if (codePoint > 0xffff) next.codes[unit++] = code
        if (codePoint === lineFeed) {
          line++
          lineStartIndex = readCount + 1
          next.lineStarts.push(unit)
        }
      }
      next.readUnits = unit
      // The first error is at the end of the text, or at the first code point that doesn't fit.
      if (errorPosition === readCount) {
        errorLine = line
        errorColumn = readCount - lineStartIndex + 1
        errorUnit = unit
      }
      // The rest of a text that doesn't fit: its lines, and its code points for the result line.
      const cutLine = line
      let codePointCount = readCount
      for (; unit < text.length; codePointCount++) {
        const codePoint = text.codePointAt(unit)!
        unit += codePoint > 0xffff ? 2 : 1
        if (codePoint === lineFeed) next.lineStarts.push(unit)
      }
      const lineCount = next.lineStarts.length
      let caretLine = 0
      while (caretLine + 1 < lineCount && next.lineStarts[caretLine + 1]! <= selectionStart) caretLine++
      // An error at a line feed or at the end of the text has no character to underline, so a mark stands there.
      next.markerUnit = errorIsShown && (errorCharacter === -1 || errorCharacter === lineFeed) ? errorUnit : -1

      // The result line.
      let statusClass = 'status ok'
      let position = ''
      let sentence = sentences.none
      if (output.valid === 0) {
        statusClass = 'status bad'
        position = `Line ${formatCount(errorLine + 1)}, column ${formatCount(errorColumn)}.`
        const kind = errorKinds[output.firstErrorKind] ?? 'none'
        // A textarea's value has line feeds only, also for a text pasted with carriage returns.
        const unclosedString = kind === 'controlCharacterInString' && errorCharacter === lineFeed
        sentence = kind === 'tooLong'
          ? ` This text has ${formatCount(codePointCount)} characters, and the program reads the first ${formatCount(capacity)}.`
          : ` ${unclosedString ? unclosedStringSentence : sentences[kind]}${output.truncated === 1 ? ` Past character ${formatCount(capacity)}, the text isn't read.` : ''}`
      }
      const countClass = output.truncated === 1 ? 'capacity over' : 'capacity'
      const countUsedText = formatCount(codePointCount)

      // DOM writes.
      // A block is written only when its line changed, so a keystroke writes its own line, a keystroke that adds or
      // removes a line inserts or removes a block at that place, and when the caret reaches a bracket whose partner is
      // 50 lines down, 2 blocks are written and not 51.
      domCache.lines = writeList(
        domCache.lines, lineCount, domCache.pre, block => block.element,
        (newLine, oldLine) => sameLine(next, newLine, shown, oldLine),
        writeLine,
        newLine => {
          const block = createLineBlock()
          writeLine(block, newLine)
          return block
        },
      )
      const previous = shown
      shown = next
      next = previous

      // The gutter: a number per line, where the caret's line and the first error's line stand out, and the lines
      // after the cut are fainter.
      const {lineNumbers} = domCache
      while (lineNumbers.length < lineCount) {
        const lineNumber = domCache.gutter.appendChild(document.createElement('span'))
        lineNumber.textContent = String(lineNumbers.length + 1)
        lineNumbers.push(lineNumber)
        written.lineNumberClasses.push('')
      }
      while (lineNumbers.length > lineCount) {
        lineNumbers.pop()!.remove()
        written.lineNumberClasses.pop()
      }
      for (let index = 0; index < lineCount; index++) {
        const className = index === errorLine ? 'is-error' : index === caretLine ? 'is-current' : index > cutLine ? 'is-unread' : ''
        if (written.lineNumberClasses[index] !== className) lineNumbers[index]!.className = written.lineNumberClasses[index] = className
      }

      if (written.statusClass !== statusClass) domCache.status.className = written.statusClass = statusClass
      if (written.statusPosition !== position) domCache.statusPosition.textContent = written.statusPosition = position
      if (written.statusSentence !== sentence) domCache.statusSentence.textContent = written.statusSentence = sentence
      if (written.countClass !== countClass) domCache.count.className = written.countClass = countClass
      if (written.countUsed !== countUsedText) domCache.countUsed.textContent = written.countUsed = countUsedText
    }

    // The statistics line shows a run in the run's own frame. The details line also says when the run's result
    // reached the screen, which the next frame's start stands for, so it shows a keystroke one frame later.
    const domEnd = window.performance.now()
    if (changed) {
      pending = {keystroke: typed, inputTime, evaluateMs, domMs: domEnd - domStart, inputToFrameMs: null}
      if (typed || described === null) described = pending
    }
    if (described !== null) {
      const name = described.keystroke ? 'The last keystroke' : 'The first run'
      const statisticsText = `One program of <b>${formatCount(machine.operationCount)}</b> operations in <b>${formatCount(machine.layerCount)}</b> layers. `
        + `${name} took <b>${formatMs(described.evaluateMs + described.domMs)}</b>.`
      if (written.statistics !== statisticsText) domCache.statistics.innerHTML = written.statistics = statisticsText
      if (!described.keystroke || described.inputToFrameMs !== null) {
        const detailsText = `${detailsStart} ${name} took <b>${formatMs(described.evaluateMs)}</b> to run the program and <b>${formatMs(described.domMs)}</b> to update the page`
          + `${described.inputToFrameMs === null || !described.keystroke ? '.' : `, and its result reached the screen about <b>${Math.round(described.inputToFrameMs)} ms</b> after the key press.`}`
        if (written.details !== detailsText) domCache.details.innerHTML = written.details = detailsText
      }
    }

    // Side effects.
    // The textarea is as large as the <pre> under it. After a keystroke that adds a line or lengthens the longest
    // line, the browser scrolled the caret into view inside a textarea that this frame has just enlarged, so the page
    // scrolls the caret's place in the <pre> into view again, with the new size. This lays out the changed lines here
    // instead of later in the frame, and that layout isn't part of domMs.
    if (revealCaret) domCache.caretAnchor?.scrollIntoView({block: 'nearest', inline: 'nearest'})

    if (pending !== null) scheduledRaf ??= window.requestAnimationFrame(renderHighlighter)
  }

  for (const type of ['input', 'keydown', 'keyup', 'pointerup', 'select']) textarea.addEventListener(type, scheduleRender)
  document.addEventListener('selectionchange', scheduleRender)

  // Tab types a tab, since the tokenizer has rules for tabs, e.g. a tab between quotes is controlCharacterInString.
  // Escape and then Tab moves focus out of the editor, so a keyboard user can still leave it.
  let escapePressed = false
  textarea.addEventListener('keydown', event => {
    const plainTab = event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
    if (plainTab && !escapePressed) {
      // Typing the tab can't wait for the frame: a key pressed before the frame would be typed first. The editing
      // command types the tab the way a key does, so the browser's undo steps back over it. Writing the tab with
      // setRangeText left the undo history pointing at the old text, e.g. in Chrome 155 an undo after a tab put the
      // text from before a paste back behind the current text. setRangeText stays for a browser without the command,
      // and fires no input event there: the keydown listener above has scheduled the frame.
      event.preventDefault()
      if (!document.execCommand('insertText', false, '\t')) textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end')
    }
    escapePressed = event.key === 'Escape'
  })

  // 14 lines, the editor's smallest height in assets/tool.css, of at most 29 characters, which fit in the editor on
  // a phone 390 px wide, where the text is 16 px.
  const sample = `{
  "name": "handwired",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "start": "bun demo.html",
    "test": "bun test"
  },
  "apps": ["Files", "Notes"],
  "spring": [650, 45, 4e-3],
  "escaped": "\\"caf\\u00e9\\"",
  "trained": false,
  "parser": null
}`
  textarea.value = sample
  // The caret starts after the array's opening bracket, so the page opens with a matched pair of brackets.
  const firstCaret = sample.indexOf('[') + 1
  textarea.focus({preventScroll: true})
  textarea.setSelectionRange(firstCaret, firstCaret)
  // The first frame runs here and not in an animation frame, so the text is never painted without its colors.
  renderHighlighter()
}

mountJsonHighlighter(document, window)

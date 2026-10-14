// The pattern language, and its compilation into an automaton with numbered states and character classes, which
// data-program.ts writes into cells.
//
// The language is a subset of JavaScript's RegExp syntax with the u flag, so new RegExp(`^(?:${pattern})$`, 'u') accepts
// every pattern that parsePattern accepts, and matches the same strings:
// - a literal code point, e.g. a or é. The syntax characters ^ $ \ . * + ? ( ) [ ] { } | need a backslash, e.g. \.
// - . matches any code point except the line terminators \n, \r, U+2028 and U+2029, like RegExp without the s flag
// - \d and \w, the ASCII digits and word characters
// - character classes with ranges and negation, e.g. [a-z_] or [^0-9]. [] matches nothing, and [^] matches any code point
// - ?, * and + after a literal, a class or a group
// - | between alternatives, and ( ) groups
// Lazy quantifiers such as *?, counted repetition such as {2}, anchors, other escapes and groups such as (?: throw a
// PatternSyntaxError.
import {invariant} from '../../runtime/numeric-ui-core.ts'

export const maxCodePoint = 0x10ffff
// One past the largest code point.
export const codePointLimit = 0x110000

// Inclusive ranges of code points, sorted, with a gap between neighbors, e.g. [[48, 57], [97, 122]] for [0-9a-z].
type Interval = readonly [low: number, high: number]
type CodePointSet = readonly Interval[]

const code = (character: string) => character.codePointAt(0)!
const syntaxCharacters: ReadonlySet<number> = new Set(Array.from('^$\\.*+?()[]{}|', character => code(character)))
const dotSet: CodePointSet = [[0, 9], [11, 12], [14, 0x2027], [0x202a, maxCodePoint]]
const digitSet: CodePointSet = [[48, 57]]
const wordSet: CodePointSet = [[48, 57], [65, 90], [95, 95], [97, 122]]

function normalizeSet(intervals: readonly Interval[]): CodePointSet {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0])
  const merged: [low: number, high: number][] = []
  for (const [low, high] of sorted) {
    const previous = merged.at(-1)
    if (previous !== undefined && low <= previous[1] + 1) previous[1] = Math.max(previous[1], high)
    else merged.push([low, high])
  }
  return merged
}

function complementSet(set: CodePointSet): CodePointSet {
  const gaps: Interval[] = []
  let next = 0
  for (const [low, high] of set) {
    if (low > next) gaps.push([next, low - 1])
    next = high + 1
  }
  if (next <= maxCodePoint) gaps.push([next, maxCodePoint])
  return gaps
}

/** @public */
export function setContains(set: CodePointSet, codePoint: number) {
  return set.some(([low, high]) => codePoint >= low && codePoint <= high)
}

type PatternNode =
  | {kind: 'atom', set: CodePointSet}
  // An empty sequence matches the empty string, e.g. the pattern () or the right side of a|.
  | {kind: 'sequence', parts: PatternNode[]}
  | {kind: 'alternation', options: PatternNode[]}
  // ? is optional, + repeats, and * is both.
  | {kind: 'repeat', body: PatternNode, optional: boolean, repeats: boolean}

export class PatternSyntaxError extends Error {
  // The index of the code point where the error was found.
  readonly position: number
  constructor(message: string, position: number) {
    super(message)
    this.position = position
  }
}

/** @public */
export function parsePattern(pattern: string): PatternNode {
  const codePoints = Array.from(pattern, character => code(character))
  let position = 0
  const is = (character: string) => codePoints[position] === code(character)
  function fail(message: string, at = position): never {
    throw new PatternSyntaxError(message, at)
  }

  function parseAlternation(): PatternNode {
    const options = [parseSequence()]
    while (is('|')) {
      position++
      options.push(parseSequence())
    }
    return options.length === 1 ? options[0]! : {kind: 'alternation', options}
  }

  function parseSequence(): PatternNode {
    const parts: PatternNode[] = []
    while (position < codePoints.length && !is('|') && !is(')')) parts.push(parseRepeat())
    return parts.length === 1 ? parts[0]! : {kind: 'sequence', parts}
  }

  function parseRepeat(): PatternNode {
    const body = parseAtom()
    if (!(is('?') || is('*') || is('+'))) return body
    const quantifier = String.fromCodePoint(codePoints[position]!)
    position++
    if (is('?')) fail(`${quantifier}? is a lazy quantifier, which this language doesn’t have`)
    if (is('*') || is('+')) fail('nothing to repeat')
    return {kind: 'repeat', body, optional: quantifier !== '+', repeats: quantifier !== '?'}
  }

  function parseAtom(): PatternNode {
    const at = position
    const character = String.fromCodePoint(codePoints[position]!)
    position++
    switch (character) {
      case '(': {
        if (is('?')) fail('groups such as (?: aren’t supported', at)
        const inner = parseAlternation()
        if (!is(')')) fail('this group is never closed', at)
        position++
        return inner
      }
      case '[':
        return {kind: 'atom', set: parseClass(at)}
      case '.':
        return {kind: 'atom', set: dotSet}
      case '\\':
        return {kind: 'atom', set: parseEscape(at, false).set}
      case '?':
      case '*':
      case '+':
        return fail('nothing to repeat', at)
      case '^':
      case '$':
        return fail('the anchors ^ and $ aren’t supported', at)
      case '{':
      case '}':
      case ']':
        return fail(`${character} needs a backslash before it`, at)
      default:
        return {kind: 'atom', set: [[code(character), code(character)]]}
    }
  }

  // After a backslash. codePoint is the escaped code point, or undefined for \d and \w, which can't end a range.
  function parseEscape(at: number, inClass: boolean): {set: CodePointSet, codePoint: number | undefined} {
    const escaped = codePoints[position]
    if (escaped === undefined) return fail('a pattern can’t end with a backslash', at)
    position++
    if (escaped === code('d')) return {set: digitSet, codePoint: undefined}
    if (escaped === code('w')) return {set: wordSet, codePoint: undefined}
    if (syntaxCharacters.has(escaped) || escaped === code('/') || (inClass && escaped === code('-'))) {
      return {set: [[escaped, escaped]], codePoint: escaped}
    }
    return fail(`the escape \\${String.fromCodePoint(escaped)} isn’t supported`, at)
  }

  function parseClassAtom(): {set: CodePointSet, codePoint: number | undefined} {
    const at = position
    const codePoint = codePoints[position]!
    position++
    return codePoint === code('\\') ? parseEscape(at, true) : {set: [[codePoint, codePoint]], codePoint}
  }

  // After [. A - between two class atoms makes a range, and a - first or last is literal, e.g. [-a] or [a-].
  function parseClass(at: number): CodePointSet {
    const negated = is('^')
    if (negated) position++
    const intervals: Interval[] = []
    while (!is(']')) {
      if (position >= codePoints.length) fail('this set of characters is never closed', at)
      const low = parseClassAtom()
      const next = codePoints[position + 1]
      if (is('-') && next !== undefined && next !== code(']')) {
        const dash = position
        position++
        const high = parseClassAtom()
        if (low.codePoint === undefined || high.codePoint === undefined) fail('a range needs one character at each end', dash)
        if (low.codePoint > high.codePoint) fail('this range is out of order', dash)
        intervals.push([low.codePoint, high.codePoint])
      } else {
        intervals.push(...low.set)
      }
    }
    position++
    const set = normalizeSet(intervals)
    return negated ? complementSet(set) : set
  }

  const node = parseAlternation()
  if (position < codePoints.length) fail('this ) closes no group')
  return node
}

// A position automaton (Glushkov's construction): state 0 is the initial state, and state p + 1 is the pattern's p-th
// atom, e.g. (ab)*c has the states initial, a, b and c. Every step into a state reads a code point of that state's set,
// so the automaton has no empty steps, and one step per code point runs it.
type Automaton = {
  stateCount: number
  // targets[s] lists the states one step from s can reach, ascending, e.g. [1, 3] for the initial state of (ab)*c.
  targets: number[][]
  // stateSets[s] is the set a step into s reads. The initial state's set is empty, since no step reaches it.
  stateSets: CodePointSet[]
  accepting: boolean[]
}

type Summary = {nullable: boolean, first: ReadonlySet<number>, last: ReadonlySet<number>}

function buildAutomaton(node: PatternNode): Automaton {
  const sets: CodePointSet[] = []
  const follow: Set<number>[] = []
  const union = (left: ReadonlySet<number>, right: ReadonlySet<number>) => new Set([...left, ...right])
  function summarize(current: PatternNode): Summary {
    switch (current.kind) {
      case 'atom': {
        const atom = sets.length
        sets.push(current.set)
        follow.push(new Set())
        return {nullable: false, first: new Set([atom]), last: new Set([atom])}
      }
      case 'sequence': {
        let summary: Summary = {nullable: true, first: new Set(), last: new Set()}
        for (const part of current.parts) {
          const next = summarize(part)
          for (const atom of summary.last) for (const target of next.first) follow[atom]!.add(target)
          summary = {
            nullable: summary.nullable && next.nullable,
            first: summary.nullable ? union(summary.first, next.first) : summary.first,
            last: next.nullable ? union(summary.last, next.last) : next.last,
          }
        }
        return summary
      }
      case 'alternation': {
        const options = current.options.map(summarize)
        return {
          nullable: options.some(option => option.nullable),
          first: options.reduce((all, option) => union(all, option.first), new Set<number>()),
          last: options.reduce((all, option) => union(all, option.last), new Set<number>()),
        }
      }
      case 'repeat': {
        const body = summarize(current.body)
        if (current.repeats) for (const atom of body.last) for (const target of body.first) follow[atom]!.add(target)
        return {nullable: body.nullable || current.optional, first: body.first, last: body.last}
      }
    }
  }
  const summary = summarize(node)
  const sorted = (atoms: ReadonlySet<number>) => [...atoms].map(atom => atom + 1).sort((left, right) => left - right)
  return {
    stateCount: sets.length + 1,
    targets: [sorted(summary.first), ...follow.map(sorted)],
    stateSets: [[], ...sets],
    accepting: [summary.nullable, ...sets.map((_, atom) => summary.last.has(atom))],
  }
}

// Code points that every step reads the same way share a class, e.g. (the|an?) [a-z]+ has 7 classes: t, h, e, a, n, the
// space, and the other letters of a..z. The partition lists the code points where the class changes.
type ClassPartition = {
  classCount: number
  // Ascending, within 1..0x10FFFF. Region 0 is the code points below boundaries[0], and region k the code points from
  // boundaries[k - 1] up to boundaries[k] - 1, or up to 0x10FFFF for the last region.
  boundaries: number[]
  // The class of each region, or -1 for a region that no step reads.
  regionClasses: number[]
  // classReads[c][s] is whether a step into state s reads the code points of class c.
  classReads: boolean[][]
}

function partitionClasses(automaton: Automaton): ClassPartition {
  const cuts = new Set<number>()
  for (const set of automaton.stateSets) {
    for (const [low, high] of set) {
      cuts.add(low)
      cuts.add(high + 1)
    }
  }
  const regionStarts = [0, ...[...cuts].filter(cut => cut > 0 && cut < codePointLimit).sort((left, right) => left - right)]
  const classBySignature = new Map<string, number>()
  const classReads: boolean[][] = []
  const boundaries: number[] = []
  const regionClasses: number[] = []
  for (const start of regionStarts) {
    // Every code point of a region is inside or outside each set together, so the region's first code point decides.
    const reads = automaton.stateSets.map(set => setContains(set, start))
    let classIndex = -1
    if (reads.some(read => read)) {
      const signature = reads.map(Number).join('')
      classIndex = classBySignature.get(signature) ?? classReads.length
      if (classIndex === classReads.length) {
        classBySignature.set(signature, classIndex)
        classReads.push(reads)
      }
    }
    // A region starts where some set starts or stops. Every set is normalized, with a gap between neighboring intervals,
    // e.g. [a-c] and [e] rather than [a-c] and [d], so that set holds the code point on one side of the start and not the
    // other. So neighboring regions always have different classes, and every region start above 0 is a boundary.
    invariant(start === 0 || regionClasses.at(-1) !== classIndex, `the regions on both sides of ${start} have the same class`)
    if (start > 0) boundaries.push(start)
    regionClasses.push(classIndex)
  }
  return {classCount: classReads.length, boundaries, regionClasses, classReads}
}

export type CompiledPattern = {pattern: string, automaton: Automaton, partition: ClassPartition}

// Throws a PatternSyntaxError for a pattern outside the language.
export function compilePattern(pattern: string): CompiledPattern {
  const automaton = buildAutomaton(parsePattern(pattern))
  return {pattern, automaton, partition: partitionClasses(automaton)}
}

// What the data program holds: S states, C classes and K class boundaries.
export type SearchCapacity = {states: number, classes: number, boundaries: number}

export type CapacityError = {reason: 'states' | 'classes' | 'boundaries', needed: number, capacity: number, message: string}

// The named fallback for a pattern that doesn't fit: a page shows a sentence per error and searches nothing, e.g.
// JSON search's "This pattern needs 40 states, and the largest search program holds 32."
export function capacityErrors(compiled: CompiledPattern, capacity: SearchCapacity): CapacityError[] {
  const needs = [
    {reason: 'states', needed: compiled.automaton.stateCount, capacity: capacity.states, noun: 'states'},
    {reason: 'classes', needed: compiled.partition.classCount, capacity: capacity.classes, noun: 'character classes'},
    {reason: 'boundaries', needed: compiled.partition.boundaries.length, capacity: capacity.boundaries, noun: 'class boundaries'},
  ] as const
  return needs.filter(need => need.needed > need.capacity).map(({reason, needed, capacity: held, noun}) => ({
    reason, needed, capacity: held, message: `the pattern needs ${needed} ${noun}, and the program holds ${held}`,
  }))
}

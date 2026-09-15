// Line break classes of Unicode scalar values, and the pair rule that says whether a line may break
// between two neighboring code points. The circuit reads both from tables that JS fills once: a
// two-level table from code point to class, and a classCount × classCount table of break bits.
//
// The classes start from UAX #14 as projected by pretext's generated table (line-break-data.ts,
// Unicode 17) and add the distinctions pretext's analysis.ts makes that a pair of neighbors can
// express: code points inside pretext's CJK ranges, which break around every character; opening and
// closing quotation marks; apostrophes; the newline; and pre-wrap spaces. The pair rule is a
// simplified UAX #14, tailored toward pretext's Blink profile. It only sees two neighbors, so rules
// that need more context don't fit, e.g. UAX #14's "no break after an opening bracket, even across
// spaces" (LB14 with SP*), or pretext's "a lone kinsoku opener takes the next character with it".

import {getLineBreakClass, LineBreakClass} from './line-break-data.ts'

export const classNames = [
  // The empty cell after the text, i.e. code point 0.
  'empty',
  // U+000A. JS turns CR LF, CR and FF into LF first, as pretext's pre-wrap mode does.
  'LF',
  // U+0020 and U+0009. They hang past a line end.
  'SP',
  // No-break glue, e.g. U+00A0, U+202F and U+2060.
  'GL',
  // U+200B.
  'ZW',
  // U+00AD. The editor breaks after it but doesn't draw the hyphen.
  'SHY',
  'AL', 'HL', 'NU',
  // Anything with a class other than the ones listed below inside pretext's CJK ranges, e.g. 字, の,
  // 한 and fullwidth digits. pretext puts a break opportunity around each of them.
  'ID_CJK',
  // Ideographic outside those ranges, e.g. most emoji.
  'ID',
  // Conditional Japanese starters, e.g. small kana and U+30FC. Blink lets them start a line.
  'CJ',
  // Nonstarters inside the CJK ranges, e.g. 々 and ・, and elsewhere.
  'NS_CJK', 'NS',
  // Closing punctuation inside the CJK ranges, e.g. 、。」，, and elsewhere, e.g. }.
  'CL_CJK', 'CL',
  // ) and ].
  'CP',
  // Opening punctuation inside the CJK ranges, e.g. 「（【, and elsewhere, e.g. ( [ {.
  'OP_CJK', 'OP',
  // “ ‘ ‚ „ « ‹, which pretext keeps with what follows.
  'QU_OPEN',
  // ” » ›, which pretext keeps with what precedes.
  'QU_CLOSE',
  // Other quotation marks, e.g. U+0022, kept on both sides.
  'QU',
  // U+0027 and U+2019, kept inside words on both sides.
  'AP',
  'EX', 'IS', 'SY', 'HY', 'HH', 'BA', 'BB', 'B2', 'IN', 'PR', 'PO', 'CM', 'EB', 'EM', 'RI', 'SA', 'AK',
  // Mandatory breaks other than LF, e.g. U+2028. They end a break opportunity like LF but don't
  // start a new line in the editor.
  'BK',
] as const

export type ClassName = (typeof classNames)[number]

export const classCount = classNames.length

export const LB = Object.fromEntries(classNames.map((name, index) => [name, index])) as {readonly [Name in ClassName]: number}

// pretext's CJK ranges (analysis.ts, cjkRe), including supplementary ideographs.
const cjkRanges: readonly (readonly [number, number])[] = [
  [0x3000, 0x30FF], [0x3130, 0x318F], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xAC00, 0xD7AF], [0xF900, 0xFAFF],
  [0xFF00, 0xFFEF], [0x20000, 0x2A6DF], [0x2A700, 0x2EE5D], [0x2F800, 0x2FA1F], [0x30000, 0x33479],
]

export function isCJKCodePoint(codePoint: number): boolean {
  for (const [low, high] of cjkRanges) if (codePoint >= low && codePoint <= high) return true
  return false
}

const glueCodePoints = new Set([0x00A0, 0x2007, 0x202F, 0x2060, 0xFEFF])
const openingQuoteCodePoints = new Set([0x201C, 0x2018, 0x201A, 0x201E, 0x00AB, 0x2039])
const closingQuoteCodePoints = new Set([0x201D, 0x00BB, 0x203A])
const apostropheCodePoints = new Set([0x0027, 0x2019])

const classByProjectedClass: Record<number, ClassName> = {
  [LineBreakClass.AL]: 'AL',
  [LineBreakClass.AK]: 'AK',
  [LineBreakClass.B2]: 'B2',
  [LineBreakClass.BA]: 'BA',
  [LineBreakClass.BB]: 'BB',
  [LineBreakClass.BK]: 'BK',
  [LineBreakClass.CJ]: 'CJ',
  [LineBreakClass.CL]: 'CL',
  [LineBreakClass.CM]: 'CM',
  [LineBreakClass.CP]: 'CP',
  [LineBreakClass.EB]: 'EB',
  [LineBreakClass.EM]: 'EM',
  [LineBreakClass.EX]: 'EX',
  [LineBreakClass.GL]: 'GL',
  [LineBreakClass.HH]: 'HH',
  [LineBreakClass.HL]: 'HL',
  [LineBreakClass.HY]: 'HY',
  [LineBreakClass.ID]: 'ID',
  [LineBreakClass.IN]: 'IN',
  [LineBreakClass.IS]: 'IS',
  [LineBreakClass.NS]: 'NS',
  [LineBreakClass.NU]: 'NU',
  [LineBreakClass.OP]: 'OP',
  [LineBreakClass.PO]: 'PO',
  [LineBreakClass.PR]: 'PR',
  [LineBreakClass.QU]: 'QU',
  [LineBreakClass.RI]: 'RI',
  [LineBreakClass.SA]: 'SA',
  [LineBreakClass.SP]: 'SP',
  [LineBreakClass.SY]: 'SY',
  [LineBreakClass.WJ]: 'GL',
  [LineBreakClass.ZW]: 'ZW',
}

// The class the circuit's two-level table holds for a code point. This is the one piece of Unicode
// classification left in JS, and it runs once per code point when the table is built.
export function classOfCodePoint(codePoint: number): number {
  if (codePoint === 0) return LB.empty
  if (codePoint === 0x0A) return LB.LF
  if (codePoint === 0x20 || codePoint === 0x09) return LB.SP
  if (codePoint === 0x200B) return LB.ZW
  if (codePoint === 0x00AD) return LB.SHY
  if (glueCodePoints.has(codePoint)) return LB.GL
  if (openingQuoteCodePoints.has(codePoint)) return LB.QU_OPEN
  if (closingQuoteCodePoints.has(codePoint)) return LB.QU_CLOSE
  if (apostropheCodePoints.has(codePoint)) return LB.AP
  const projected = getLineBreakClass(codePoint)
  if (isCJKCodePoint(codePoint)) {
    switch (projected) {
      case LineBreakClass.CL:
      case LineBreakClass.CP:
        return LB.CL_CJK
      case LineBreakClass.OP:
        return LB.OP_CJK
      case LineBreakClass.NS:
        return LB.NS_CJK
      case LineBreakClass.CJ:
        return LB.CJ
      case LineBreakClass.EX:
        return LB.EX
      case LineBreakClass.CM:
        return LB.CM
      case LineBreakClass.GL:
        return LB.GL
      case LineBreakClass.QU:
        return LB.QU
      default:
        // ID, H2 and H3 (projected to ID), AL, NU, PR, PO, and U+3000 (BA): pretext puts a break
        // opportunity around each of them.
        return LB.ID_CJK
    }
  }
  return LB[classByProjectedClass[projected] ?? 'AL']
}

const classSet = (...names: ClassName[]) => {
  const members = new Set(names.map(name => LB[name]))
  return (value: number) => members.has(value)
}

export type PairRule = {
  // What the rule does, with the UAX #14 rule it simplifies or the pretext behavior it follows.
  name: string
  breaks: boolean
  applies: (before: number, after: number) => boolean
}

const newlines = classSet('LF', 'BK')
const closingPunctuation = classSet('CL', 'CP', 'CL_CJK', 'EX', 'IS', 'SY', 'NS', 'NS_CJK', 'IN', 'QU_CLOSE')
const openingPunctuation = classSet('OP', 'OP_CJK', 'QU_OPEN')
const breakAfterPunctuation = classSet('HY', 'HH', 'BA')
const numericPrefixes = classSet('PR', 'HY', 'HH', 'IS', 'SY')
const prefixTargets = classSet('AL', 'HL', 'NU', 'ID', 'ID_CJK', 'OP', 'EB', 'EM')
const prefixSources = classSet('AL', 'HL', 'NU', 'CL', 'CP')
const postfixTargets = classSet('AL', 'HL', 'NU', 'OP')
const letterLike = classSet('AL', 'HL', 'NU', 'SA', 'AK', 'CM')
const letterTargets = classSet('AL', 'HL', 'NU', 'SA', 'AK')
const letters = classSet('AL', 'HL')

// First rule that applies decides. Every pair of classes reaches the last rule at the latest.
export const pairRules: readonly PairRule[] = [
  // Empty cells' fit edges include the trailing spaces' advances, so when trailing spaces pass the
  // edge, the first failing cell is the end of the text, and the line must break exactly there.
  {name: 'trailing spaces: break after the last space of the text, so trailing spaces hang', breaks: true, applies: (before, after) => before === LB.SP && after === LB.empty},
  // A run that's kept whole ends at its first break opportunity, so a newline always ends one.
  {name: 'LB4, LB5: break after a newline', breaks: true, applies: before => newlines(before)},
  {name: 'empty cells: no layout decision reads these pairs', breaks: false, applies: (before, after) => before === LB.empty || after === LB.empty},
  {name: 'LB6: no break before a newline', breaks: false, applies: (_, after) => newlines(after)},
  {name: 'LB7: no break before a space or a zero width space', breaks: false, applies: (_, after) => after === LB.SP || after === LB.ZW},
  {name: 'LB8, LB18: break after spaces and zero width spaces, even before closing punctuation, as pretext does', breaks: true, applies: before => before === LB.SP || before === LB.ZW},
  {name: 'LB9: no break before a combining mark', breaks: false, applies: (_, after) => after === LB.CM},
  {name: 'LB11, LB12, LB12a: no break next to glue', breaks: false, applies: (before, after) => before === LB.GL || after === LB.GL},
  {name: 'LB21: no break before a soft hyphen', breaks: false, applies: (_, after) => after === LB.SHY},
  {name: 'break after a soft hyphen', breaks: true, applies: before => before === LB.SHY},
  {name: 'LB13, LB16, LB22 and kinsoku: no break before closing punctuation, e.g. 字。 or word,', breaks: false, applies: (_, after) => closingPunctuation(after)},
  {name: 'LB14 and kinsoku: no break after opening punctuation, e.g. 「字 or (word', breaks: false, applies: before => openingPunctuation(before)},
  {name: 'LB19: no break on either side of other quotation marks', breaks: false, applies: (before, after) => before === LB.QU || after === LB.QU},
  {name: 'apostrophes stay inside words, as pretext glues them', breaks: false, applies: (before, after) => before === LB.AP || after === LB.AP},
  {name: 'LB21: no break before hyphens and break-after punctuation', breaks: false, applies: (_, after) => breakAfterPunctuation(after)},
  {name: 'LB21: no break after break-before punctuation', breaks: false, applies: before => before === LB.BB},
  {name: 'LB17: no break between em dashes', breaks: false, applies: (before, after) => before === LB.B2 && after === LB.B2},
  {name: 'LB25: signs, prefixes and separators stay with the number after them, e.g. -5, $5, 3.14', breaks: false, applies: (before, after) => after === LB.NU && numericPrefixes(before)},
  {name: 'LB23a, LB24, LB25 and pretext: no break before postfix, e.g. 100% or 字%', breaks: false, applies: (_, after) => after === LB.PO},
  {name: 'LB23a, LB24: a prefix stays with what it attaches to, e.g. $字', breaks: false, applies: (before, after) => before === LB.PR && prefixTargets(after)},
  {name: 'LB24, LB25: no break before a prefix after letters, digits or closing brackets, e.g. jolly$5 or 3.14¥5', breaks: false, applies: (before, after) => after === LB.PR && prefixSources(before)},
  {name: 'LB24, LB25: a postfix stays with letters, digits and openers after it, e.g. 96%seven', breaks: false, applies: (before, after) => before === LB.PO && postfixTargets(after)},
  {name: 'LB23, LB28: letters and digits stay together', breaks: false, applies: (before, after) => letterLike(before) && letterTargets(after)},
  {name: 'LB29 and pretext symbol chains: no break between , . : ; / and a letter, e.g. hello,world or a/b', breaks: false, applies: (before, after) => (before === LB.IS || before === LB.SY) && letters(after)},
  {name: 'LB30: no break after ) or ] before a letter or digit', breaks: false, applies: (before, after) => before === LB.CP && letterTargets(after)},
  {name: 'LB30: no break before a non East Asian opener after a letter or digit, e.g. word(', breaks: false, applies: (before, after) => letterLike(before) && after === LB.OP},
  {name: 'LB30a: no break between regional indicators', breaks: false, applies: (before, after) => before === LB.RI && after === LB.RI},
  {name: 'LB30b: no break between an emoji base and a modifier', breaks: false, applies: (before, after) => before === LB.EB && after === LB.EM},
  {name: 'LB31: break everywhere else, e.g. between ideographs, 字a, a字, 。字, word-next, !word', breaks: true, applies: () => true},
]

export function pairRuleFor(before: number, after: number): PairRule {
  for (const rule of pairRules) if (rule.applies(before, after)) return rule
  throw new Error('the last pair rule applies to every pair')
}

export function breaksBetween(before: number, after: number): boolean {
  return pairRuleFor(before, after).breaks
}

const cjkClasses = classSet('ID_CJK', 'CJ', 'NS_CJK', 'CL_CJK', 'OP_CJK')

// Whether a run with no break opportunity may still break between two classes when the run doesn't
// fit on a line by itself, like CSS overflow-wrap. pretext keeps CJK units whole instead: e.g. 字。 on
// a line narrower than two ideographs overflows the line, while a long Latin word breaks at the glyph
// that doesn't fit.
export function classesMayBreakInside(before: number, after: number): boolean {
  return !cjkClasses(before) && !cjkClasses(after)
}

// Only U+0020 and U+0009 hang past a line end.
export function classHangs(lineBreakClass: number): boolean {
  return lineBreakClass === LB.SP
}

export function classIsNewline(lineBreakClass: number): boolean {
  return lineBreakClass === LB.LF
}

// Option+Left and Option+Right move over runs of word classes. This approximates the text-editing
// prototype's letters, digits, marks, underscore and apostrophe with classes, e.g. AL also holds
// symbols like # and @, and emoji aren't word characters.
const wordClasses = classSet('AL', 'HL', 'NU', 'ID_CJK', 'CJ', 'NS_CJK', 'CM', 'AP', 'SA', 'AK')

export function classIsWord(lineBreakClass: number): boolean {
  return wordClasses(lineBreakClass)
}

// The text boundary: pre-wrap newline normalization (CR LF, CR and FF become LF, as pretext does),
// then one code point per cell. Code point 0 marks empty cells, so it's dropped.
export function codePointsOf(text: string): number[] {
  const codePoints: number[] = []
  for (const character of text.replace(/\r\n|[\r\f]/g, '\n')) {
    const codePoint = character.codePointAt(0)!
    if (codePoint !== 0) codePoints.push(codePoint)
  }
  return codePoints
}

export function textOf(codePoints: readonly number[], from = 0, to = codePoints.length): string {
  let text = ''
  for (let index = from; index < to; index++) if (codePoints[index]! !== 0) text += String.fromCodePoint(codePoints[index]!)
  return text
}

// JavaScript around both programs: text cells in, matches out.
import {type Wire, invariant} from '../../src/runtime/numeric-ui-core.ts'

export type Match = {start: number, end: number}

export function codePointsOf(text: string): number[] {
  return Array.from(text, character => character.codePointAt(0)!)
}

// Writes the text's code points into the text cells, and -1 into every cell past the end of the text.
export function writeText(values: Float32Array, textCells: readonly Wire[], codePoints: readonly number[]) {
  invariant(codePoints.length <= textCells.length, `the text has ${codePoints.length} code points, and the program holds ${textCells.length}`)
  textCells.forEach((wire, position) => {
    values[wire] = codePoints[position] ?? -1
  })
}

// The matches that the program's output bits describe: a match starts at each position whose start bit is 1, and covers
// the highlighted positions after it, up to the next start or the next position that isn't highlighted.
export function matchesFromBits(highlighted: readonly number[], starts: readonly number[]): Match[] {
  const matches: Match[] = []
  highlighted.forEach((bit, position) => {
    invariant(bit === 0 || bit === 1, `highlighted[${position}] must be 0 or 1, got ${bit}`)
    if (starts[position] === 1) {
      invariant(bit === 1, `position ${position} starts a match but isn't highlighted`)
      matches.push({start: position, end: position + 1})
    } else if (bit === 1) {
      const current = matches.at(-1)
      invariant(current?.end === position, `position ${position} is highlighted outside a match`)
      current.end++
    }
  })
  return matches
}

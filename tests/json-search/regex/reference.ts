// Two plain JavaScript references for the search, written from the definition rather than from the programs. Both find
// every non-overlapping, non-empty match, leftmost, then longest: from the scan position, the longest match that starts
// there moves the scan position to the match's end, and when no match starts there, the scan moves one code point on.
// - automatonMatches runs the compiled automaton from each scan position, one code point at a time, until no state is
//   left, and keeps the last position where an accepting state was reached.
// - regexpMatches doesn't use the compiled automaton: it tests every substring with RegExp.
import type {Match} from '../../../src/json-search/regex/host.ts'
import {type CompiledPattern, setContains} from '../../../src/json-search/regex/pattern.ts'

export function automatonMatches({automaton}: CompiledPattern, codePoints: readonly number[]): Match[] {
  const matches: Match[] = []
  let position = 0
  while (position < codePoints.length) {
    let states = new Set([0])
    let longestEnd = -1
    for (let index = position; index < codePoints.length && states.size > 0; index++) {
      const next = new Set<number>()
      for (const state of states) {
        for (const target of automaton.targets[state]!) {
          if (setContains(automaton.stateSets[target]!, codePoints[index]!)) next.add(target)
        }
      }
      states = next
      if ([...states].some(state => automaton.accepting[state])) longestEnd = index + 1
    }
    if (longestEnd > position) {
      matches.push({start: position, end: longestEnd})
      position = longestEnd
    } else {
      position++
    }
  }
  return matches
}

// The u flag makes RegExp read code points, as the programs do, e.g. . matches one emoji instead of half of one.
export function regexpMatches(pattern: string, codePoints: readonly number[]): Match[] {
  const whole = new RegExp(`^(?:${pattern})$`, 'u')
  const matches: Match[] = []
  let position = 0
  while (position < codePoints.length) {
    let longestEnd = -1
    for (let end = codePoints.length; end > position; end--) {
      if (whole.test(String.fromCodePoint(...codePoints.slice(position, end)))) {
        longestEnd = end
        break
      }
    }
    if (longestEnd > position) {
      matches.push({start: position, end: longestEnd})
      position = longestEnd
    } else {
      position++
    }
  }
  return matches
}

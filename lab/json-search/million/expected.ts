// What a kernel's answers are compared with, for every document of a run, and the idiomatic JavaScript searches.
//
// The expected values come from bit-rows.ts's plain JavaScript loop over the same automaton, and for a scope from that
// loop with table-loop.ts's display kinds as the mask, as the lab's runs do. RegExp and a walk over parsed objects
// answer nearly the same questions, so this file also counts the documents where each of them disagrees with the loop
// about whether the document has a match.
import {displayKind} from '../../../src/json-search/highlighter/kinds.ts'
import {type CompiledPattern, capacityErrors, compilePattern} from '../../../src/json-search/regex/pattern.ts'
import {type BitRowTables, bitRowTables, createBitRowSearch} from '../../../tests/json-search/bit-rows.ts'
import {boundaryCapacity, classCapacity, kindCount} from '../../../src/json-search/search-step.ts'
import {type ScopeName, patternIsExactOnBytes, scopeNames} from './layouts.ts'

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json}

// Does any string value under `value` match? The code a JavaScript programmer would write first.
export function valueMatches(value: Json, pattern: RegExp): boolean {
  if (typeof value === 'string') return pattern.test(value)
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    for (const item of value) if (valueMatches(item, pattern)) return true
    return false
  }
  for (const key in value) if (valueMatches(value[key]!, pattern)) return true
  return false
}

// Does any key under `value` match?
export function keyMatches(value: Json, pattern: RegExp): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    for (const item of value) if (keyMatches(item, pattern)) return true
    return false
  }
  for (const key in value) if (pattern.test(key) || keyMatches(value[key]!, pattern)) return true
  return false
}

// Every string value and every key under `value`, for arrays of strings that are collected once.
export function collectStrings(value: Json, values: string[], keys: string[]) {
  if (typeof value === 'string') values.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, values, keys)
  else if (value !== null && typeof value === 'object') {
    for (const key in value) {
      keys.push(key)
      collectStrings(value[key]!, values, keys)
    }
  }
}

const searchableOf = (scope: ScopeName) => {
  const searchable = new Uint8Array(kindCount)
  if (scope === 'everything') searchable.fill(1)
  else searchable[scope === 'keys' ? displayKind.key : displayKind.string] = 1
  return searchable
}

export type ExpectedPattern = {
  pattern: string
  compiled: CompiledPattern
  // How many states the pattern has, and the smallest of the capacities that holds it.
  states: number
  capacity: number
  exactOnBytes: boolean
  // Per scope: the plain loop's match count of every document, one bit per document that has a match, 32 documents a
  // word, and the totals.
  counts: Record<ScopeName, Uint16Array>
  bits: Record<ScopeName, Uint32Array>
  matches: Record<ScopeName, number>
  documentsWithMatch: Record<ScopeName, number>
  // Documents where `new RegExp(pattern, 'u').test(text)` and the plain loop over the whole text disagree.
  regExpDiffers: number
  // Documents where the walk over the parsed object and the plain loop with the scope's mask disagree.
  walkDiffers: {keys: number, strings: number}
}

export function createExpected(patterns: readonly string[], capacities: readonly number[], documentCount: number) {
  // A pattern that fits none of the capacities is left out, e.g. when a run measures only 8 states.
  const entries: (ExpectedPattern & {tables: BitRowTables, search: ReturnType<typeof createBitRowSearch>, regExp: RegExp})[] = patterns.flatMap(pattern => {
    const compiled = compilePattern(pattern)
    const capacity = capacities.find(states => capacityErrors(compiled, {states, classes: classCapacity, boundaries: boundaryCapacity}).length === 0)
    if (capacity === undefined) return []
    const tables = bitRowTables(compiled, capacity)
    const perScope = <Value>(create: () => Value) => Object.fromEntries(scopeNames.map(scope => [scope, create()])) as Record<ScopeName, Value>
    return [{
      pattern, compiled, states: compiled.automaton.stateCount, capacity, exactOnBytes: patternIsExactOnBytes(compiled),
      counts: perScope(() => new Uint16Array(documentCount)), bits: perScope(() => new Uint32Array(Math.ceil(documentCount / 32))),
      matches: perScope(() => 0), documentsWithMatch: perScope(() => 0), regExpDiffers: 0, walkDiffers: {keys: 0, strings: 0},
      tables, search: createBitRowSearch(tables, 512), regExp: new RegExp(pattern, 'u'),
    }]
  })
  const searchable = Object.fromEntries(scopeNames.map(scope => [scope, searchableOf(scope)])) as Record<ScopeName, Uint8Array>

  // Adds the documents `firstDocument` on. `kinds` holds 512 display kinds per document of this piece. With `walk`,
  // every document is also parsed and walked for each pattern, which a piece of invalid JSON would stop.
  function add(firstDocument: number, texts: readonly string[], kinds: Uint8Array, walk: boolean) {
    const parsed = walk ? texts.map(text => JSON.parse(text) as Json) : undefined
    for (const entry of entries) {
      for (const scope of scopeNames) {
        const counts = entry.counts[scope]
        const bits = entry.bits[scope]
        const mask = scope === 'everything' ? undefined : {kinds, offset: 0, searchable: searchable[scope]}
        let matches = 0
        let withMatch = 0
        for (let row = 0; row < texts.length; row++) {
          if (mask !== undefined) mask.offset = row * 512
          const found = entry.search(texts[row]!, undefined, 0, mask)
          const index = firstDocument + row
          counts[index] = found
          matches += found
          if (found > 0) {
            withMatch++
            bits[index >> 5]! |= 1 << (index & 31)
          }
          if (scope === 'everything') {
            if (entry.regExp.test(texts[row]!) !== (found > 0)) entry.regExpDiffers++
          } else if (parsed !== undefined) {
            const walked = scope === 'keys' ? keyMatches(parsed[row]!, entry.regExp) : valueMatches(parsed[row]!, entry.regExp)
            if (walked !== (found > 0)) entry.walkDiffers[scope]++
          }
        }
        entry.matches[scope] += matches
        entry.documentsWithMatch[scope] += withMatch
      }
    }
  }

  return {
    entries: entries as readonly (ExpectedPattern & {tables: BitRowTables})[],
    add,
    describe: () => entries.map(({pattern, states, capacity, exactOnBytes, matches, documentsWithMatch, regExpDiffers, walkDiffers}) => ({pattern, states, capacity, exactOnBytes, matches, documentsWithMatch, regExpDiffers, walkDiffers})),
  }
}

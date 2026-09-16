// Parser for @fit comments: range and integrality annotations on function parameters and
// return values. The grammar covers the forms found in the real target file
// (chenglou.github.io's index.ts) plus the synthetic gauntlet:
//
//   // @fit > 0                      trailing comment on a parameter
//   // @fit int 0..Infinity          integer range, inclusive ends
//   /** @fit
//    * given containerSizeX: int 0..<Infinity     ..< is an exclusive upper end
//    * given max >= min                            relation between two parameters
//    * return.cols: int 1..7
//    * return.boxMaxSizeX > 0
//    */
//
// Anything after @fit that does not parse is reported as a problem instead of being
// silently dropped; unparsed annotations are data for the residue taxonomy.

export type FitRange = {
  subject: string
  integer: boolean
  minimum: number
  maximum: number
}

export type FitRelation = {
  subject: string
  comparison: '>' | '>=' | '<' | '<='
  other: string
}

export type FitAnnotations = {
  ranges: FitRange[]
  relations: FitRelation[]
  problems: string[]
}

export function emptyFitAnnotations(): FitAnnotations {
  return {ranges: [], relations: [], problems: []}
}

// `text` is the comment content after the @fit marker, possibly multi-line.
// `fallbackSubject` names the parameter a trailing comment annotates.
export function parseFitText(text: string, fallbackSubject: string | null): FitAnnotations {
  const result = emptyFitAnnotations()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^[\s*]+/, '').trim()
    if (line === '') continue
    parseFitLine(line, fallbackSubject, result)
  }
  return result
}

function parseFitLine(line: string, fallbackSubject: string | null, result: FitAnnotations) {
  let rest = line
  if (rest.startsWith('given ')) rest = rest.slice('given '.length).trim()

  // Optional subject: identifier possibly with dots (return.cols, scale.dest).
  let subject = fallbackSubject
  const subjectMatch = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*/.exec(rest)
  if (subjectMatch !== null && subjectMatch[1] !== 'int' && subjectMatch[1] !== 'Infinity') {
    subject = subjectMatch[1]!
    rest = rest.slice(subjectMatch[0].length)
    if (rest.startsWith(':')) rest = rest.slice(1).trim()
  }
  if (subject === null) {
    result.problems.push(`@fit line has no subject and no parameter to attach to: "${line}"`)
    return
  }

  let integer = false
  if (rest.startsWith('int')) {
    integer = true
    rest = rest.slice('int'.length).trim()
  }

  // Range form: A..B or A..<B
  const rangeMatch = /^(-?(?:\d+(?:\.\d+)?|Infinity))\s*\.\.(<?)\s*(-?(?:\d+(?:\.\d+)?|Infinity))$/.exec(rest)
  if (rangeMatch !== null) {
    const minimum = Number(rangeMatch[1])
    let maximum = Number(rangeMatch[3])
    if (rangeMatch[2] === '<') {
      // An exclusive upper end tightens integers by one; for continuous values we keep the
      // bound itself, which is safe for range checking (the bound is never produced anyway).
      if (integer && Number.isFinite(maximum)) maximum -= 1
    }
    result.ranges.push({subject, integer, minimum, maximum})
    return
  }

  // Comparison form: > n, >= n, < n, <= n, against a number or another identifier.
  const comparisonMatch = /^(>=|<=|>|<)\s*(-?(?:\d+(?:\.\d+)?|Infinity)|[A-Za-z_$][\w$]*)$/.exec(rest)
  if (comparisonMatch !== null) {
    const comparison = comparisonMatch[1] as FitRelation['comparison']
    const target = comparisonMatch[2]!
    const numeric = Number(target)
    if (Number.isNaN(numeric) && !/^-?Infinity$/.test(target)) {
      result.relations.push({subject, comparison, other: target})
      return
    }
    const bound = numeric
    switch (comparison) {
      case '>':
        // For integers "> 0" means at least 1; for continuous values we keep the open bound
        // as an inclusive one, which only widens the assumed range.
        result.ranges.push({subject, integer, minimum: integer ? bound + 1 : bound, maximum: Number.POSITIVE_INFINITY})
        return
      case '>=':
        result.ranges.push({subject, integer, minimum: bound, maximum: Number.POSITIVE_INFINITY})
        return
      case '<':
        result.ranges.push({subject, integer, minimum: Number.NEGATIVE_INFINITY, maximum: integer ? bound - 1 : bound})
        return
      case '<=':
        result.ranges.push({subject, integer, minimum: Number.NEGATIVE_INFINITY, maximum: bound})
        return
    }
  }

  if (integer && rest === '') {
    result.ranges.push({subject, integer: true, minimum: Number.NEGATIVE_INFINITY, maximum: Number.POSITIVE_INFINITY})
    return
  }

  result.problems.push(`@fit line not understood: "${line}"`)
}

export function mergeFitAnnotations(target: FitAnnotations, extra: FitAnnotations) {
  target.ranges.push(...extra.ranges)
  target.relations.push(...extra.relations)
  target.problems.push(...extra.problems)
}

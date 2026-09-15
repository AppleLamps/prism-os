// Layout constants from ~/github/nicer-hacker-news/hn.js, plus the static tables the
// circuit uses in place of tree walks. The comment tree never changes at runtime,
// so every loop over indents becomes a table computed once here.

export const threadLayout = {
  commentUserGapNatural: 4,
  commentBottomGapNatural: 12,
  commentLeftGap: 24,
  commentRightGap: 20,
  userHeightNatural: 24,
  indentWidth: 24,
  searchHeight: 24,
  searchWidth: 160,
  submissionHeightNatural: 100,
  submissionHeightDelta: 40,
  submissionLine1Height: 18,
  containerBorderRadius: 8,
  currentContainerTop: 44,
  // hn.js: currentContainerHeight = innerHeight - currentContainerTop - 52
  containerBottomGap: 52,
  minimumContainerWidth: 375,
  maximumContainerWidth: 1200,
  // rowHeightNaturalF(commentHeight) = commentHeight + 24 + 4 + 12
  rowHeightExtra: 40,
  // Extension: a collapsed comment keeps its user banner and the 4px gap below it.
  collapsedRowHeight: 28,
  // Extension: rows shorter than this don't take a DOM slot.
  slotMinimumHeight: 0.25,
} as const

export type ThreadTables = {
  rowCount: number
  indents: number[]
  maxIndent: number
  // parent[i] is the closest earlier row with indent[i] - 1, or -1 for top-level comments.
  parents: number[]
  // Proper ancestors, nearest first.
  ancestors: number[][]
  // First row after i's subtree: the first j > i with indent[j] <= indent[i], or rowCount.
  subtreeEnds: number[]
  // hn.js line 333: `let ancestor = i; while (ancestor > 0 && data[ancestor].indent > indentPointed) ancestor--`,
  // tabulated for every row and every indentPointed in 0..maxIndent.
  ancestorAtLevel: number[][]
  descendantCounts: number[]
}

export function buildThreadTables(indents: readonly number[]): ThreadTables {
  const rowCount = indents.length
  const maxIndent = Math.max(0, ...indents)
  const parents: number[] = []
  const ancestors: number[][] = []
  const openAtIndent: number[] = []
  for (let row = 0; row < rowCount; row++) {
    const indent = indents[row]!
    if (row === 0 && indent !== 0) throw new Error('the first comment must be top-level')
    if (row > 0 && indent > indents[row - 1]! + 1) throw new Error(`comment ${row} skips an indent level`)
    const parent = indent === 0 ? -1 : openAtIndent[indent - 1]!
    parents.push(parent)
    ancestors.push(parent === -1 ? [] : [parent, ...ancestors[parent]!])
    openAtIndent[indent] = row
    openAtIndent.length = indent + 1
  }
  const subtreeEnds: number[] = []
  for (let row = 0; row < rowCount; row++) {
    let end = row + 1
    while (end < rowCount && indents[end]! > indents[row]!) end++
    subtreeEnds.push(end)
  }
  const ancestorAtLevel: number[][] = []
  for (let row = 0; row < rowCount; row++) {
    const byLevel: number[] = []
    for (let level = 0; level <= maxIndent; level++) {
      let ancestor = row
      while (ancestor > 0 && indents[ancestor]! > level) ancestor--
      byLevel.push(ancestor)
    }
    ancestorAtLevel.push(byLevel)
  }
  return {
    rowCount,
    indents: [...indents],
    maxIndent,
    parents,
    ancestors,
    subtreeEnds,
    ancestorAtLevel,
    descendantCounts: subtreeEnds.map((end, row) => end - row - 1),
  }
}

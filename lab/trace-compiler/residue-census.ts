// The residue census: every statement of the real render path, classified. A unit is a leaf
// statement, an if condition, or a loop header. Units covered by a compiled-and-verified slice
// count as compiled; other units receive heuristic categories, not actual compiler diagnostics.
// The classification rules are syntactic (marker sets over the unit's source text plus a few
// AST checks); the output table was reviewed line by line against the file.

import ts from 'typescript'
import {invariant} from '../../numeric-ui-core.ts'
import type {RealTarget, SliceResult} from './real-slice.ts'

export type CensusCategory =
  | 'compiled and verified in a slice'
  | 'numeric candidate (not compiled)'
  | 'unbounded range (needs a finite @fit)'
  | 'DOM read'
  | 'DOM write'
  | 'browser side effect'
  | 'event object plumbing'
  | 'string work'
  | 'nullable state'
  | 'dynamic index'
  | 'loop early exit (first match)'
  | 'dynamic loop bound'
  | 'state commit (write-back)'
  | 'debug-only'

export type Fixability = 'compiled' | 'needs compilation' | 'boundary I/O' | 'mechanically fixable' | 'annotation-fixable' | 'supported by the architecture' | 'out of scope'

export const categoryFixability: Record<CensusCategory, {fixability: Fixability, how: string}> = {
  'compiled and verified in a slice': {
    fixability: 'compiled',
    how: 'bit-exact against the fround twin over seeded random inputs',
  },
  'numeric candidate (not compiled)': {
    fixability: 'needs compilation',
    how: 'syntax suggests a possible numeric slice; compilation and verification have not been attempted',
  },
  'unbounded range (needs a finite @fit)': {
    fixability: 'annotation-fixable',
    how: 'Math.floor over the frame-time delta has no finite bound, so the compiler cannot lower it to step bits; a spiral-of-death clamp on the delta (ui.md caps the step count with Math.min(300, ...)) would bound it',
  },
  'DOM read': {
    fixability: 'boundary I/O',
    how: 'stays in the JS glue; the read value enters the source table as an input cell',
  },
  'DOM write': {
    fixability: 'boundary I/O',
    how: 'stays in the JS glue; circuit outputs project onto the DOM in the batched write phase',
  },
  'browser side effect': {
    fixability: 'boundary I/O',
    how: 'scrollTo, pushState, and selection stay imperative; their arguments can be circuit outputs',
  },
  'event object plumbing': {
    fixability: 'mechanically fixable',
    how: 'event handlers store numeric cells (the window-manager pattern: downActive, downX, downY) and render reads the cells',
  },
  'string work': {
    fixability: 'annotation-fixable',
    how: 'encode as integers: key codes as an enum cell, the photo id in the URL hash as an index, the cursor name as a one-hot choice',
  },
  'nullable state': {
    fixability: 'mechanically fixable',
    how: 'a presence bit plus a value; demonstrated by the compiled hitTest1DMode (return.present, return.value)',
  },
  'dynamic index': {
    fixability: 'mechanically fixable',
    how: 'one-hot gather or scatter needs selection plus retrieval; declared one-hot groups can share selection and lower each retrieval to a direct read',
  },
  'loop early exit (first match)': {
    fixability: 'mechanically fixable',
    how: 'per-item condition bits plus a first-match selection tree (the emitFirstActive precedent); recognized but not implemented in this compiler',
  },
  'dynamic loop bound': {
    fixability: 'annotation-fixable',
    how: 'a finite @fit bound turns the loop into a masked unroll (demonstrated by the 1D backward loop); stepSpring’s @fit says int 0..Infinity, so it stays rejected until the bound is finite',
  },
  'state commit (write-back)': {
    fixability: 'supported by the architecture',
    how: 'module state cells become source-table entries written back each frame — the recurrence f(state, input) -> (state, output)',
  },
  'debug-only': {
    fixability: 'out of scope',
    how: 'manual frame stepping for development; not part of the product tick',
  },
}

export type CensusUnit = {
  functionName: string
  line: number
  endLine: number
  text: string
  unitKind: 'statement' | 'if condition' | 'loop header'
  category: CensusCategory
}

// The per-frame render path: render plus every helper it calls.
const renderPathFunctions = [
  'render',
  'colsBoxMaxSizeXF',
  'clamp',
  'hitTest2DMode',
  'hitTest1DMode',
  'stepSprings',
  'stepSpring',
  'springStep',
  'springGoToEnd',
  'springForEach',
]

function unitText(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, ' ')
  return text.length > 88 ? `${text.slice(0, 88)}…` : text
}

function hasMarker(text: string, markers: string[]): boolean {
  return markers.some(marker => text.includes(marker))
}

const domWriteMarkers = ['.style.', 'appendChild', 'removeChild', '.src', 'setProperty', 'webkitLineClamp', 'parentNode', 'promptNode']
const domReadMarkers = [
  'document.documentElement', 'document.body.scrollTop', 'document.body.scrollLeft',
  'window.scrollY', 'window.scrollX', 'window.location', 'reducedMotion.matches',
]
const browserEffectMarkers = ['scrollTo(', 'pushState', 'selection', 'getSelection', 'removeAllRanges', 'addRange', 'createRange', 'selectNodeContents']
const eventMarkers = ['events.', 'clickedTarget', '.clientX', '.clientY', 'instanceof HTMLElement', '.tagName', 'inputCode = ']
const stateCommitPrefixes = ['animatedUntilTime =', 'anchor =', 'windowSizeX =', 'scrollY =', 'return stillAnimating']

// True when the unit indexes an array with something other than a literal or an enclosing
// loop variable (data[hit], rowsTop[Math.floor(focused / cols)], boxes2DSizeY[focused]).
function hasDynamicIndex(node: ts.Node, loopVariables: Set<string>): boolean {
  let found = false
  const visit = (candidate: ts.Node) => {
    if (found) return
    if (ts.isElementAccessExpression(candidate)) {
      const index = candidate.argumentExpression
      const indexIsStatic = ts.isNumericLiteral(index)
        || (ts.isIdentifier(index) && loopVariables.has(index.text))
        || (ts.isPrefixUnaryExpression(index) && ts.isNumericLiteral(index.operand))
        || simpleLoopArithmetic(index, loopVariables)
      if (!indexIsStatic) {
        found = true
        return
      }
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return found
}

// i % cols, i / cols, currentRow + 1: arithmetic over loop variables and identifiers that a
// bounded-integer specialization makes constant.
function simpleLoopArithmetic(index: ts.Expression, loopVariables: Set<string>): boolean {
  let allStatic = true
  const visit = (candidate: ts.Node) => {
    if (ts.isIdentifier(candidate)) {
      if (!loopVariables.has(candidate.text) && candidate.text !== 'cols' && candidate.text !== 'currentRow' && candidate.text !== 'Math' && candidate.text !== 'floor') {
        allStatic = false
      }
      return
    }
    ts.forEachChild(candidate, visit)
  }
  visit(index)
  return allStatic
}

function classify(node: ts.Node, unitKind: CensusUnit['unitKind'], loopVariables: Set<string>, insideLoop: boolean, functionName: string): CensusCategory {
  const text = node.getText().replace(/\s+/g, ' ')
  if (text.includes('debug') || text.includes('isDebug')) return 'debug-only'
  if (hasMarker(text, browserEffectMarkers)) return 'browser side effect'
  if (hasMarker(text, domWriteMarkers)) return 'DOM write'
  if (hasMarker(text, domReadMarkers)) return 'DOM read'
  if (hasMarker(text, eventMarkers)) return 'event object plumbing'
  if (/'[^']*'/.test(text) || text.includes('.id') || text.includes('hashImgId') || text.includes('cursor')) return 'string work'
  if (unitKind === 'statement' && (ts.isReturnStatement(node) || ts.isBreakOrContinueStatement(node)) && insideLoop) {
    return 'loop early exit (first match)'
  }
  if (unitKind === 'loop header' && text.includes('< steps')) return 'dynamic loop bound'
  if (text.includes('stepSprings(') || text.includes('stepSpring(')) return 'dynamic loop bound'
  // The anchor loop searches for the first row past a threshold and exits with break.
  if (unitKind === 'loop header' && text.includes('newAnchor')) return 'loop early exit (first match)'
  if (hasDynamicIndex(node, loopVariables)) return 'dynamic index'
  // The animation clock: Math.floor over the unbounded frame-time delta. The compiler's own
  // floor lowering rejects it (finite range required), so counting it as in-subset would be
  // wrong.
  if (text.includes('Math.floor') && /\bnow\b/.test(text)) return 'unbounded range (needs a finite @fit)'
  if (text.includes('== null') || text.includes('!= null') || text.includes('??') || text.includes('| null')
    || /\b(focused|newFocused|animatedUntilTime|hit)\b/.test(text)) {
    return 'nullable state'
  }
  // The frame's hand-off into module state; helpers' ordinary returns are not commits.
  if (functionName === 'render' && stateCommitPrefixes.some(prefix => text.startsWith(prefix))) {
    return 'state commit (write-back)'
  }
  return 'numeric candidate (not compiled)'
}

export function runCensus(target: RealTarget, slices: SliceResult[]): CensusUnit[] {
  const sourceFile = target.sourceFile
  const covered: [number, number][] = slices.flatMap(slice => slice.coveredLines)
  const isCovered = (start: number, end: number) =>
    covered.some(([coveredStart, coveredEnd]) => start >= coveredStart && end <= coveredEnd)

  const units: CensusUnit[] = []
  const record = (functionName: string, node: ts.Node, unitKind: CensusUnit['unitKind'], loopVariables: Set<string>, insideLoop: boolean, forced: CensusCategory | null): CensusCategory => {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
    const category = forced ?? (isCovered(start, end)
      ? 'compiled and verified in a slice'
      : classify(node, unitKind, loopVariables, insideLoop, functionName))
    units.push({functionName, line: start, endLine: end, text: unitText(node), unitKind, category})
    return category
  }

  // A loop header classifies from its init/condition/incrementor only (its body statements are
  // their own units), but its coverage comes from the header line inside a slice's range.
  const recordLoopHeader = (functionName: string, statement: ts.ForStatement | ts.ForOfStatement, parts: ts.Node[], loopVariables: Set<string>) => {
    const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1
    let category: CensusCategory = isCovered(start, start) ? 'compiled and verified in a slice' : 'numeric candidate (not compiled)'
    if (category !== 'compiled and verified in a slice') {
      for (const part of parts) {
        const partCategory = classify(part, 'loop header', loopVariables, false, functionName)
        if (partCategory !== 'numeric candidate (not compiled)') {
          category = partCategory
          break
        }
      }
    }
    const separator = ts.isForOfStatement(statement) ? ' of ' : '; '
    const text = `for (${parts.map(part => part.getText().replace(/\s+/g, ' ')).join(separator)})`
    units.push({
      functionName,
      line: start,
      endLine: start,
      text: text.length > 88 ? `${text.slice(0, 88)}…` : text,
      unitKind: 'loop header',
      category,
    })
  }

  const walkStatement = (functionName: string, statement: ts.Statement, loopVariables: Set<string>, insideLoop: boolean, forced: CensusCategory | null = null) => {
    if (ts.isBlock(statement)) {
      for (const inner of statement.statements) walkStatement(functionName, inner, loopVariables, insideLoop, forced)
      return
    }
    if (ts.isIfStatement(statement)) {
      const conditionCategory = record(functionName, statement.expression, 'if condition', loopVariables, insideLoop, forced)
      // Everything guarded by a debug flag is debug-only.
      const branchForced = forced ?? (conditionCategory === 'debug-only' ? 'debug-only' : null)
      walkStatement(functionName, statement.thenStatement, loopVariables, insideLoop, branchForced)
      if (statement.elseStatement !== undefined) walkStatement(functionName, statement.elseStatement, loopVariables, insideLoop, branchForced)
      return
    }
    if (ts.isForStatement(statement)) {
      const parts: ts.Node[] = []
      if (statement.initializer !== undefined) parts.push(statement.initializer)
      if (statement.condition !== undefined) parts.push(statement.condition)
      if (statement.incrementor !== undefined) parts.push(statement.incrementor)
      recordLoopHeader(functionName, statement, parts, loopVariables)
      const bodyVariables = new Set(loopVariables)
      if (statement.initializer !== undefined && ts.isVariableDeclarationList(statement.initializer)) {
        for (const declaration of statement.initializer.declarations) {
          if (ts.isIdentifier(declaration.name)) bodyVariables.add(declaration.name.text)
        }
      }
      walkStatement(functionName, statement.statement, bodyVariables, true, forced)
      return
    }
    if (ts.isForOfStatement(statement)) {
      recordLoopHeader(functionName, statement, [statement.initializer, statement.expression], loopVariables)
      walkStatement(functionName, statement.statement, loopVariables, true, forced)
      return
    }
    record(functionName, statement, 'statement', loopVariables, insideLoop, forced)
  }

  for (const functionName of renderPathFunctions) {
    const declaration = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
    )
    invariant(declaration !== undefined, `render path function ${functionName} not found`)
    invariant(declaration.body !== undefined, `${functionName} has no body`)
    for (const statement of declaration.body.statements) {
      walkStatement(functionName, statement, new Set(), false)
    }
  }
  return units
}

export type CensusSummary = {
  totalUnits: number
  compiledUnits: number
  numericUnits: number
  numericClassifiedUnits: number
  rows: {category: CensusCategory, count: number, exampleLine: number, exampleText: string, fixability: Fixability, how: string}[]
}

const boundaryCategories: CensusCategory[] = ['DOM read', 'DOM write', 'browser side effect', 'debug-only']

export function summarizeCensus(units: CensusUnit[]): CensusSummary {
  const byCategory = new Map<CensusCategory, CensusUnit[]>()
  for (const unit of units) {
    const list = byCategory.get(unit.category) ?? []
    list.push(unit)
    byCategory.set(unit.category, list)
  }
  const rows = [...byCategory.entries()]
    .map(([category, list]) => ({
      category,
      count: list.length,
      exampleLine: list[0]!.line,
      exampleText: list[0]!.text,
      fixability: categoryFixability[category].fixability,
      how: categoryFixability[category].how,
    }))
    .sort((left, right) => right.count - left.count)
  const compiledUnits = units.filter(unit => unit.category === 'compiled and verified in a slice').length
  const numericUnits = units.filter(unit => !boundaryCategories.includes(unit.category)).length
  const numericClassifiedUnits = units.filter(
    unit => unit.category === 'compiled and verified in a slice' || unit.category === 'numeric candidate (not compiled)',
  ).length
  return {totalUnits: units.length, compiledUnits, numericUnits, numericClassifiedUnits, rows}
}

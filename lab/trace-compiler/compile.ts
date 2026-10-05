// Compiler from a restricted chenguini-style TypeScript subset to Circuit operations.
//
// Design summary (details in README.md):
// - The compiler walks the TypeScript AST with symbolic values. Compile-time constants fold;
//   runtime numbers become wires. Loops over known ranges unroll; loops whose bounds are runtime
//   integers with @fit bounds unroll over the static range with a per-iteration mask bit.
// - Each affine arithmetic step uses roundAffine, preserving the source's FP32 rounding point
//   instead of allowing the builder to compose the operation into its consumers.
// - Ternaries lower to two masked products: on*bit + off*(1-bit). For finite FP32 operands,
//   multiplying by an exact 1 or 0 does not re-round the selected value.
// - Comparisons on values proven integral use the integer decision-bit form
//   relu(d) - relu(d - 1). Continuous comparisons use the exact sign cascade, not the old
//   boolean-atom margin policy. Exact forward decisions do not imply useful training gradients.

import ts from 'typescript'
import {Circuit, type Wire, invariant, asWire} from '../../src/runtime/numeric-ui-core.ts'
import {
  type FitAnnotations,
  emptyFitAnnotations,
  mergeFitAnnotations,
  parseFitText,
} from './annotations.ts'

const f32 = Math.fround

// ============================== diagnostics ==============================

export type RejectionCategory =
  | 'unsupported syntax'
  | 'string work'
  | 'dynamic division'
  | 'dynamic index'
  | 'runtime-sized array'
  | 'dynamic loop bound'
  | 'early return'
  | 'unbounded range'
  | 'non-numeric value'
  | 'unknown identifier'
  | 'browser API'
  | 'masked structure change'
  | 'wide floor range'
  | 'non-finite branch'
  | 'unsupported call'

export type Diagnostic = {
  line: number
  category: RejectionCategory
  construct: string
  snippet: string
}

export class CompileReject extends Error {
  diagnostic: Diagnostic
  constructor(diagnostic: Diagnostic) {
    super(`line ${diagnostic.line}: [${diagnostic.category}] ${diagnostic.construct}: ${diagnostic.snippet}`)
    this.diagnostic = diagnostic
  }
}

function reject(node: ts.Node, category: RejectionCategory, construct: string): never {
  const file = node.getSourceFile()
  const {line} = file.getLineAndCharacterOfPosition(node.getStart())
  const text = node.getText().replace(/\s+/g, ' ')
  throw new CompileReject({
    line: line + 1,
    category,
    construct,
    snippet: text.length > 90 ? `${text.slice(0, 90)}…` : text,
  })
}

function positionKey(node: ts.Node): string {
  const file = node.getSourceFile()
  const {line, character} = file.getLineAndCharacterOfPosition(node.getStart())
  return `${line + 1}:${character + 1}`
}

// ============================== symbolic values ==============================

export type Num =
  | {kind: 'constant', value: number}
  // narrowed: a tighter sound range than the wire's global one, valid only where the value
  // flows. Set when a ternary branch implies a bound on an identifier (in the false branch of
  // v > max ? max : v, the value v is at most max), the same flow narrowing TypeScript performs
  // for types, applied to numeric ranges.
  | {kind: 'wire', wire: Wire, integer: boolean, narrowed?: {minimum: number, maximum: number}}

export type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction

export type Value =
  | Num
  | {kind: 'null'}
  | {kind: 'nullable', present: Num, value: Num}
  | {kind: 'string', value: string}
  | {kind: 'array', elements: Value[]}
  | {kind: 'object', fields: Map<string, Value>}
  | {kind: 'function', declaration: FunctionLike}

export function constantNum(value: number): Num {
  return {kind: 'constant', value: f32(value)}
}

function isNum(value: Value): value is Num {
  return value.kind === 'constant' || value.kind === 'wire'
}

function numInteger(num: Num): boolean {
  return num.kind === 'constant' ? Number.isInteger(num.value) : num.integer
}

// ============================== comparison sites ==============================

// One entry per comparison event the circuit performs on continuous values. The fround twin
// replays the same events natively and flags any trial whose operand difference falls inside
// the unresolved margin, where the circuit's decision bit may disagree with the native branch.
export type ComparisonSite = {
  positionKey: string
  line: number
  kind: 'continuous' | 'integer' | 'floor'
  // Margin: differences with |d| >= epsilon always resolve correctly. null for integer sites,
  // which are exact.
  epsilon: number | null
  tieIsTrue: boolean
}

// ============================== emitter ==============================

// Integer decision bits and the arithmetic feeding them must keep every intermediate integral
// and exactly representable; staying below 2**23 keeps sums and differences below 2**24.
const integerExactLimit = 2 ** 23

// The largest finite FP32 value. A float64 interval can be finite while its values overflow to
// Infinity in FP32; every guard that clears a value to be computed on a masked-off path must
// check representability against this bound, or fround(Infinity * 0) = NaN poisons the mask.
const fp32MaxFinite = 3.4028234663852886e38

function fitsFp32(range: {minimum: number, maximum: number}): boolean {
  return Math.abs(range.minimum) <= fp32MaxFinite && Math.abs(range.maximum) <= fp32MaxFinite
}

export class Emitter {
  circuit: Circuit
  comparisonSites: ComparisonSite[]
  floorStepLimit: number
  divisorSpanLimit: number

  constructor(circuit: Circuit, floorStepLimit = 64, divisorSpanLimit = 32) {
    this.circuit = circuit
    this.comparisonSites = []
    this.floorStepLimit = floorStepLimit
    this.divisorSpanLimit = divisorSpanLimit
  }

  rangeOf(num: Num): {minimum: number, maximum: number} {
    if (num.kind === 'constant') return {minimum: num.value, maximum: num.value}
    const global = this.circuit.ranges[num.wire]!
    if (num.narrowed === undefined) return global
    return {
      minimum: Math.max(global.minimum, num.narrowed.minimum),
      maximum: Math.min(global.maximum, num.narrowed.maximum),
    }
  }

  // The wire's context-free range, ignoring branch narrowing. Everything stamped onto a circuit
  // wire with assumeRange must be computed from these: the builder's expression dedup shares one
  // wire across every syntactic occurrence of the same expression, so a range fact derived from
  // a branch-narrowed operand (which only holds inside that branch) would silently become a
  // global claim about the shared wire and miscompile the uses outside the branch. Tighter
  // branch-derived hulls travel on the Num's narrowed field instead, which stays local.
  globalRangeOf(num: Num): {minimum: number, maximum: number} {
    if (num.kind === 'constant') return {minimum: num.value, maximum: num.value}
    return this.circuit.ranges[num.wire]!
  }

  // Carries a branch-derived hull on the returned Num when it is tighter than the wire's
  // context-free range.
  attachNarrowedHull(num: Num, minimum: number, maximum: number): Num {
    if (num.kind !== 'wire') return num
    const global = this.circuit.ranges[num.wire]!
    const narrowedMinimum = Math.max(global.minimum, minimum)
    const narrowedMaximum = Math.min(global.maximum, maximum)
    if (narrowedMinimum <= global.minimum && narrowedMaximum >= global.maximum) return num
    if (narrowedMinimum > narrowedMaximum) return num
    return {...num, narrowed: {minimum: narrowedMinimum, maximum: narrowedMaximum}}
  }

  // A wire whose sound value range is a single point is a known constant.
  normalize(num: Num): Num {
    if (num.kind === 'wire') {
      const range = this.rangeOf(num)
      if (range.minimum === range.maximum && Number.isFinite(range.minimum)) {
        return constantNum(range.minimum)
      }
    }
    return num
  }

  isBit(num: Num): boolean {
    if (num.kind === 'constant') return num.value === 0 || num.value === 1
    if (!num.integer) return false
    const range = this.rangeOf(num)
    return range.minimum >= 0 && range.maximum <= 1
  }

  // One frozen operation computing bias + sum(coefficient * term). Restricted to shapes whose
  // FP32 result does not depend on term order, because the builder sorts terms by wire index:
  // at most one term with any bias, two terms with zero bias (FP32 addition commutes), or any
  // shape whose values are all exactly-representable integers (exact arithmetic has no rounding
  // to reorder).
  affineStep(node: ts.Node, terms: [Num, number][], bias: number): Num {
    const wireTerms: [Wire, number][] = []
    let wireTermsInteger = true
    let foldedBias = f32(bias)
    for (const [num, coefficient] of terms) {
      if (coefficient === 0) continue
      const rounded = f32(coefficient)
      if (num.kind === 'constant') {
        foldedBias = f32(foldedBias + f32(rounded * num.value))
        continue
      }
      wireTerms.push([num.wire, rounded])
      wireTermsInteger &&= num.integer && Number.isInteger(rounded)
    }
    if (wireTerms.length === 0) return constantNum(foldedBias)
    const integer = wireTermsInteger && Number.isInteger(foldedBias)
    if (wireTerms.length === 1 && foldedBias === 0 && wireTerms[0]![1] === 1) {
      // Identity; reuse the wire instead of emitting a copy.
      return {kind: 'wire', wire: wireTerms[0]![0], integer: wireTermsInteger}
    }
    const orderFree =
      wireTerms.length === 1
      || (wireTerms.length === 2 && foldedBias === 0)
      || this.termsAreIntegerExact(wireTerms, foldedBias)
    if (!orderFree) {
      reject(node, 'unsupported syntax', 'arithmetic shape whose FP32 result would depend on term order')
    }
    const wire = this.circuit.roundAffine(wireTerms, foldedBias)
    return {kind: 'wire', wire, integer}
  }

  termsAreIntegerExact(terms: [Wire, number][], bias: number): boolean {
    if (!Number.isInteger(bias) || Math.abs(bias) >= integerExactLimit) return false
    let magnitude = Math.abs(bias)
    for (const [wire, coefficient] of terms) {
      if (!Number.isInteger(coefficient)) return false
      const range = this.circuit.ranges[wire]!
      const bound = Math.max(Math.abs(range.minimum), Math.abs(range.maximum)) * Math.abs(coefficient)
      if (!Number.isFinite(bound) || bound >= integerExactLimit) return false
      magnitude += bound
    }
    return magnitude < 2 ** 24
  }

  add(node: ts.Node, a: Num, b: Num): Num {
    if (a.kind === 'constant' && b.kind === 'constant') return constantNum(a.value + b.value)
    if (a.kind === 'wire' && b.kind === 'wire' && a.wire === b.wire) {
      return this.affineStep(node, [[a, 2]], 0)
    }
    if (a.kind === 'constant') return this.affineStep(node, [[b, 1]], a.value)
    if (b.kind === 'constant') return this.affineStep(node, [[a, 1]], b.value)
    return this.affineStep(node, [[a, 1], [b, 1]], 0)
  }

  subtract(node: ts.Node, a: Num, b: Num): Num {
    if (a.kind === 'constant' && b.kind === 'constant') return constantNum(a.value - b.value)
    if (a.kind === 'wire' && b.kind === 'wire' && a.wire === b.wire) return constantNum(0)
    if (a.kind === 'constant') return this.affineStep(node, [[b, -1]], a.value)
    if (b.kind === 'constant') return this.affineStep(node, [[a, 1]], -b.value)
    return this.affineStep(node, [[a, 1], [b, -1]], 0)
  }

  multiplyConstant(node: ts.Node, a: Num, k: number): Num {
    const rounded = f32(k)
    if (a.kind === 'constant') return constantNum(a.value * rounded)
    if (rounded === 0) return constantNum(0)
    if (rounded === 1) return a
    return this.affineStep(node, [[a, rounded]], 0)
  }

  // f(left * max(0, gate)). The caller guarantees gate >= 0 (a decision bit, or a value whose
  // range proves non-negativity), so the relu inside the gate is the identity.
  maskedProduct(node: ts.Node, left: Num, gate: Num): Num {
    if (left.kind === 'constant' && gate.kind === 'constant') {
      return constantNum(left.value * Math.max(0, gate.value))
    }
    if (left.kind === 'constant') {
      if (left.value === 0) return constantNum(0)
      invariant(gate.kind === 'wire', 'unreachable: constant gate is handled above')
      const wire = this.circuit.reglu([], left.value, [[gate.wire, 1]], 0)
      return {kind: 'wire', wire, integer: Number.isInteger(left.value) && gate.integer}
    }
    if (gate.kind === 'constant') {
      invariant(gate.value >= 0, 'masked product gate must be non-negative')
      return this.multiplyConstant(node, left, gate.value)
    }
    const wire = this.circuit.reglu([[left.wire, 1]], 0, [[gate.wire, 1]], 0)
    return {kind: 'wire', wire, integer: left.integer && gate.integer}
  }

  multiply(node: ts.Node, a: Num, b: Num): Num {
    a = this.normalize(a)
    b = this.normalize(b)
    if (a.kind === 'constant' && b.kind === 'constant') return constantNum(a.value * b.value)
    if (a.kind === 'constant') return this.multiplyConstant(node, b, a.value)
    if (b.kind === 'constant') return this.multiplyConstant(node, a, b.value)
    const rangeA = this.rangeOf(a)
    const rangeB = this.rangeOf(b)
    const result: Num = {kind: 'wire', wire: this.circuit.multiply(a.wire, b.wire), integer: a.integer && b.integer}
    const globalHull = productHull(this.globalRangeOf(a), this.globalRangeOf(b))
    this.circuit.assumeRange(result.wire, globalHull.minimum, globalHull.maximum)
    const narrowedHull = productHull(rangeA, rangeB)
    return this.normalize(this.attachNarrowedHull(result, narrowedHull.minimum, narrowedHull.maximum))
  }

  // max(0, f(num + bias)) as a single operation.
  relu(num: Num, bias = 0): Num {
    if (num.kind === 'constant') return constantNum(Math.max(0, f32(num.value + f32(bias))))
    const wire = this.circuit.reglu([], 1, [[num.wire, 1]], f32(bias))
    return {kind: 'wire', wire, integer: num.integer && Number.isInteger(f32(bias))}
  }

  absolute(node: ts.Node, num: Num): Num {
    num = this.normalize(num)
    if (num.kind === 'constant') return constantNum(Math.abs(num.value))
    const range = this.rangeOf(num)
    if (range.minimum >= 0) return num
    if (range.maximum <= 0) return this.multiplyConstant(node, num, -1)
    const positive = this.relu(num)
    const negativePart = this.reluNegated(num)
    let result = this.add(node, positive, negativePart)
    if (result.kind === 'wire') {
      const globalRange = this.globalRangeOf(num)
      this.circuit.assumeRange(result.wire, 0, Math.max(Math.abs(globalRange.minimum), Math.abs(globalRange.maximum)))
      result = this.attachNarrowedHull(result, 0, Math.max(Math.abs(range.minimum), Math.abs(range.maximum)))
    }
    return result
  }

  // max(0, -num) as a single operation.
  reluNegated(num: Num): Num {
    invariant(num.kind === 'wire', 'constant should have folded')
    const wire = this.circuit.reglu([], 1, [[num.wire, -1]], 0)
    return {kind: 'wire', wire, integer: num.integer}
  }

  notBit(node: ts.Node, bit: Num): Num {
    invariant(this.isBit(bit), 'not of a non-bit')
    if (bit.kind === 'constant') return constantNum(1 - bit.value)
    const result = this.affineStep(node, [[bit, -1]], 1)
    if (result.kind === 'wire') this.circuit.assumeRange(result.wire, 0, 1)
    return result
  }

  andBit(node: ts.Node, a: Num, b: Num): Num {
    invariant(this.isBit(a) && this.isBit(b), 'logical and of non-bits')
    if (a.kind === 'constant') return a.value === 0 ? constantNum(0) : b
    if (b.kind === 'constant') return b.value === 0 ? constantNum(0) : a
    return this.maskedProduct(node, a, b)
  }

  orBit(node: ts.Node, a: Num, b: Num): Num {
    invariant(this.isBit(a) && this.isBit(b), 'logical or of non-bits')
    if (a.kind === 'constant') return a.value === 1 ? constantNum(1) : b
    if (b.kind === 'constant') return b.value === 1 ? constantNum(1) : a
    const both = this.maskedProduct(node, a, b)
    const sum = this.add(node, a, b)
    const result = this.subtract(node, sum, both)
    if (result.kind === 'wire') this.circuit.assumeRange(result.wire, 0, 1)
    return result
  }

  // select(bit, off, on) = on*bit + off*(1-bit). Exact for any finite operands because the two
  // products multiply by exact 1 or 0 and the final addition adds an exact zero.
  select(node: ts.Node, bit: Num, whenFalse: Num, whenTrue: Num): Num {
    invariant(this.isBit(bit), 'select gate must be a decision bit')
    bit = this.normalize(bit)
    if (bit.kind === 'constant') return bit.value === 1 ? whenTrue : whenFalse
    if (whenFalse.kind === 'wire' && whenTrue.kind === 'wire' && whenFalse.wire === whenTrue.wire) return whenFalse
    if (whenFalse.kind === 'constant' && whenTrue.kind === 'constant' && whenFalse.value === whenTrue.value) return whenFalse
    // Both branches are computed even when masked off, so both must stay representable in FP32
    // for every input the wires can carry (the global ranges): a branch whose float64 interval
    // is finite but overflows FP32 would compute fround(Infinity * 0) = NaN under the mask and
    // poison the select.
    const globalFalseRange = this.globalRangeOf(whenFalse)
    const globalTrueRange = this.globalRangeOf(whenTrue)
    if (!fitsFp32(globalFalseRange) || !fitsFp32(globalTrueRange)) {
      reject(node, 'non-finite branch', 'select lowering evaluates both branches, so each branch needs a value range representable in FP32')
    }
    const falseRange = this.rangeOf(whenFalse)
    const trueRange = this.rangeOf(whenTrue)
    const onSide = this.maskedProduct(node, whenTrue, bit)
    const offSide = this.maskedProduct(node, whenFalse, this.notBit(node, bit))
    let result = this.add(node, onSide, offSide)
    if (result.kind === 'wire') {
      this.circuit.assumeRange(
        result.wire,
        Math.min(globalFalseRange.minimum, globalTrueRange.minimum),
        Math.max(globalFalseRange.maximum, globalTrueRange.maximum),
      )
      result = this.attachNarrowedHull(
        result,
        Math.min(falseRange.minimum, trueRange.minimum),
        Math.max(falseRange.maximum, trueRange.maximum),
      )
      if (whenFalse.kind !== 'constant' || whenTrue.kind !== 'constant') return this.normalize(result)
    }
    return result
  }

  // clamp01 over a value that is integral at runtime: relu(d) - relu(d - 1) is the exact bit of
  // d >= 1 (expressions.md "Decision bits").
  integerAtLeastOneBit(node: ts.Node, d: Num): Num {
    invariant(numInteger(d), 'integer decision bit needs an integral score')
    if (d.kind === 'constant') return constantNum(d.value >= 1 ? 1 : 0)
    const range = this.rangeOf(d)
    invariant(
      Math.max(Math.abs(range.minimum), Math.abs(range.maximum)) < 2 ** 24,
      'integer decision bit operand exceeds the FP32 exact-integer window',
    )
    if (range.minimum >= 1) return constantNum(1)
    if (range.maximum <= 0) return constantNum(0)
    const positive = this.relu(d)
    const aboveOne = this.relu(d, -1)
    const result = this.subtract(node, positive, aboveOne)
    if (result.kind === 'wire') this.circuit.assumeRange(result.wire, 0, 1)
    return result
  }

  integerComparable(a: Num, b: Num): boolean {
    if (!numInteger(a) || !numInteger(b)) return false
    const rangeA = this.rangeOf(a)
    const rangeB = this.rangeOf(b)
    const magnitude = Math.max(
      Math.abs(rangeA.minimum), Math.abs(rangeA.maximum),
      Math.abs(rangeB.minimum), Math.abs(rangeB.maximum),
    )
    return magnitude < integerExactLimit
  }

  // Decision bit for `left op right`. Integer operands take the exact path; continuous operands
  // take the boolean-atom path, which resolves differences above a per-site margin.
  compare(node: ts.Node, operator: '<' | '<=' | '>' | '>=' | '===' | '!==', left: Num, right: Num): Num {
    left = this.normalize(left)
    right = this.normalize(right)
    if (left.kind === 'constant' && right.kind === 'constant') {
      switch (operator) {
        case '<': return constantNum(left.value < right.value ? 1 : 0)
        case '<=': return constantNum(left.value <= right.value ? 1 : 0)
        case '>': return constantNum(left.value > right.value ? 1 : 0)
        case '>=': return constantNum(left.value >= right.value ? 1 : 0)
        case '===': return constantNum(left.value === right.value ? 1 : 0)
        case '!==': return constantNum(left.value !== right.value ? 1 : 0)
      }
    }
    if (this.integerComparable(left, right)) {
      this.comparisonSites.push({
        positionKey: positionKey(node),
        line: lineOf(node),
        kind: 'integer',
        epsilon: null,
        tieIsTrue: false,
      })
      switch (operator) {
        // a > b for integers is a - b >= 1.
        case '>': return this.integerAtLeastOneBit(node, this.subtract(node, left, right))
        case '<': return this.integerAtLeastOneBit(node, this.subtract(node, right, left))
        // a >= b is a - b + 1 >= 1.
        case '>=': return this.integerAtLeastOneBit(node, this.affinePair(node, left, right, 1))
        case '<=': return this.integerAtLeastOneBit(node, this.affinePair(node, right, left, 1))
        case '===': {
          const geLR = this.integerAtLeastOneBit(node, this.affinePair(node, left, right, 1))
          const geRL = this.integerAtLeastOneBit(node, this.affinePair(node, right, left, 1))
          return this.andBit(node, geLR, geRL)
        }
        case '!==': {
          const equal = this.compare(node, '===', left, right)
          return this.notBit(node, equal)
        }
      }
    }
    switch (operator) {
      case '>': return this.exactPositiveBit(node, this.subtract(node, left, right))
      case '<': return this.exactPositiveBit(node, this.subtract(node, right, left))
      // a >= b is the negation of b > a; the sign bit is exact, so the negation is too.
      case '>=': return this.notBit(node, this.exactPositiveBit(node, this.subtract(node, right, left)))
      case '<=': return this.notBit(node, this.exactPositiveBit(node, this.subtract(node, left, right)))
      case '===': {
        // Strictly greater and strictly less are mutually exclusive bits, so equality is
        // 1 - greater - less in one exact integer step.
        const greater = this.exactPositiveBit(node, this.subtract(node, left, right))
        const less = this.exactPositiveBit(node, this.subtract(node, right, left))
        const equal = this.affineStep(node, [[greater, -1], [less, -1]], 1)
        if (equal.kind === 'wire') this.circuit.assumeRange(equal.wire, 0, 1)
        return equal
      }
      case '!==': {
        const greater = this.exactPositiveBit(node, this.subtract(node, left, right))
        const less = this.exactPositiveBit(node, this.subtract(node, right, left))
        const notEqual = this.add(node, greater, less)
        if (notEqual.kind === 'wire') this.circuit.assumeRange(notEqual.wire, 0, 1)
        return notEqual
      }
    }
  }

  // a - b + bias as one exact integer step.
  affinePair(node: ts.Node, a: Num, b: Num, bias: number): Num {
    if (a.kind === 'constant') return this.affineStep(node, [[b, -1]], a.value + bias)
    if (b.kind === 'constant') return this.affineStep(node, [[a, 1]], bias - b.value)
    return this.affineStep(node, [[a, 1], [b, -1]], bias)
  }

  // Exact bit of [d > 0] for any finite FP32 d, without the boolean atom and without an
  // unresolved margin. relu(d) keeps positive values; one power-of-two scale lifts the whole
  // range near 2**23; then clamp01 followed by another power-of-two scale repeats until every
  // positive value has saturated at exactly 1. Multiplying by a power of two is exact in FP32
  // (the exponent shifts, the mantissa is untouched), and clamp01(v) = v - relu(v - 1) is exact
  // for v < 2**24 (v - 1 is representable there), so every intermediate is either an exact
  // rescaling of d or exactly 1. The FP32 difference f(a - b) is zero exactly when a equals b
  // and keeps the true sign otherwise, so this bit agrees with the native comparison on every
  // input. An earlier version scaled d into a score near 0.5 and rounded with the boolean atom;
  // the exhaustive column-count sweep caught it mis-resolving differences below the score's
  // rounding step (e.g. viewport width 1732, where (1732-24)*fround(1/244) lands one FP32 ulp
  // below 7), which is why the exact cascade replaced it.
  exactPositiveBit(node: ts.Node, d: Num): Num {
    d = this.normalize(d)
    if (d.kind === 'constant') return constantNum(d.value > 0 ? 1 : 0)
    const range = this.rangeOf(d)
    if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum)) {
      reject(node, 'unbounded range', 'a comparison on continuous values needs finite @fit ranges on its operands')
    }
    const magnitude = Math.max(Math.abs(range.minimum), Math.abs(range.maximum))
    invariant(magnitude > 0, 'degenerate comparison should have folded')
    if (magnitude >= 2 ** 23) {
      reject(node, 'unbounded range', 'comparison operands span beyond 2**23; clamp01 would lose the plateau')
    }
    this.comparisonSites.push({
      positionKey: positionKey(node),
      line: lineOf(node),
      kind: 'continuous',
      epsilon: null,
      tieIsTrue: false,
    })
    // First scale: lift the range as close to 2**23 as safe. Capped so the constant stays finite.
    const firstExponent = Math.min(23 - Math.ceil(Math.log2(magnitude)), 120)
    let value = this.multiplyConstant(node, this.relu(d), 2 ** firstExponent)
    // The smallest positive FP32 value is 2**-149; keep scaling by 2**23 until even that
    // saturates to 1.
    let totalExponent = firstExponent
    while (totalExponent < 150) {
      value = this.clampZeroOneContinuous(node, value)
      value = this.multiplyConstant(node, value, 2 ** 23)
      totalExponent += 23
    }
    const bit = this.clampZeroOneContinuous(node, value)
    invariant(bit.kind === 'wire', 'sign cascade folded unexpectedly')
    this.circuit.assumeRange(bit.wire, 0, 1)
    // The cascade produces exactly 0 or 1, so downstream logic may treat the wire as integral.
    return {kind: 'wire', wire: bit.wire, integer: true}
  }

  // clamp01 for a non-negative value below 2**24: v - relu(v - 1). Exact: v - 1 is representable
  // for every FP32 v in [1, 2**24), and below 1 the subtracted term is zero.
  clampZeroOneContinuous(node: ts.Node, value: Num): Num {
    if (value.kind === 'constant') return constantNum(Math.min(1, Math.max(0, value.value)))
    const aboveOne = this.relu(value, -1)
    const result = this.subtract(node, value, aboveOne)
    if (result.kind === 'wire') this.circuit.assumeRange(result.wire, 0, 1)
    return result
  }

  minimum(node: ts.Node, a: Num, b: Num): Num {
    a = this.normalize(a)
    b = this.normalize(b)
    if (a.kind === 'constant' && b.kind === 'constant') return constantNum(Math.min(a.value, b.value))
    const rangeA = this.rangeOf(a)
    const rangeB = this.rangeOf(b)
    if (rangeA.maximum <= rangeB.minimum) return a
    if (rangeB.maximum <= rangeA.minimum) return b
    const bIsSmaller = this.compare(node, '<', b, a)
    let result = this.select(node, bIsSmaller, a, b)
    if (result.kind === 'wire') {
      const globalA = this.globalRangeOf(a)
      const globalB = this.globalRangeOf(b)
      this.circuit.assumeRange(
        result.wire,
        Math.min(globalA.minimum, globalB.minimum),
        Math.min(globalA.maximum, globalB.maximum),
      )
      result = this.attachNarrowedHull(
        result,
        Math.min(rangeA.minimum, rangeB.minimum),
        Math.min(rangeA.maximum, rangeB.maximum),
      )
    }
    return result
  }

  maximum(node: ts.Node, a: Num, b: Num): Num {
    a = this.normalize(a)
    b = this.normalize(b)
    if (a.kind === 'constant' && b.kind === 'constant') return constantNum(Math.max(a.value, b.value))
    const rangeA = this.rangeOf(a)
    const rangeB = this.rangeOf(b)
    if (rangeA.minimum >= rangeB.maximum) return a
    if (rangeB.minimum >= rangeA.maximum) return b
    const bIsLarger = this.compare(node, '>', b, a)
    let result = this.select(node, bIsLarger, a, b)
    if (result.kind === 'wire') {
      const globalA = this.globalRangeOf(a)
      const globalB = this.globalRangeOf(b)
      this.circuit.assumeRange(
        result.wire,
        Math.max(globalA.minimum, globalB.minimum),
        Math.max(globalA.maximum, globalB.maximum),
      )
      result = this.attachNarrowedHull(
        result,
        Math.max(rangeA.minimum, rangeB.minimum),
        Math.max(rangeA.maximum, rangeB.maximum),
      )
    }
    return result
  }

  floor(node: ts.Node, num: Num): Num {
    num = this.normalize(num)
    if (num.kind === 'constant') return constantNum(Math.floor(num.value))
    if (num.integer) return num
    const range = this.rangeOf(num)
    if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum)) {
      reject(node, 'unbounded range', 'Math.floor on a continuous value needs finite @fit ranges')
    }
    const low = Math.floor(range.minimum)
    const high = Math.floor(range.maximum)
    if (low === high) return constantNum(low)
    if (high - low > this.floorStepLimit) {
      reject(node, 'wide floor range', `Math.floor over ${high - low} integer steps exceeds the limit of ${this.floorStepLimit}`)
    }
    // floor(x) = low + sum over k in (low, high] of [x >= k]. Each step bit is an exact sign
    // bit: [x >= k] is the negation of [k - x > 0].
    let sum: Num = constantNum(low)
    for (let k = low + 1; k <= high; k++) {
      const difference = this.affineStep(node, [[num, -1]], k)
      const stepBit = this.notBit(node, this.exactPositiveBit(node, difference))
      sum = this.add(node, sum, stepBit)
    }
    if (sum.kind === 'wire') this.circuit.assumeRange(sum.wire, low, high)
    return sum
  }

  // Exact one-hot decomposition of a bounded integer wire: shared >= bits differenced into
  // equality bits, one per possible value.
  oneHot(node: ts.Node, num: Num, low: number, high: number): Num[] {
    const bits: Num[] = []
    const atLeast: Num[] = []
    for (let k = low + 1; k <= high; k++) {
      atLeast.push(this.integerAtLeastOneBit(node, this.affineStep(node, [[num, 1]], 1 - k)))
    }
    for (let k = low; k <= high; k++) {
      if (k === low && k === high) bits.push(constantNum(1))
      else if (k === low) bits.push(this.notBit(node, atLeast[0]!))
      else if (k === high) bits.push(atLeast[atLeast.length - 1]!)
      else {
        const bit = this.subtract(node, atLeast[k - low - 1]!, atLeast[k - low]!)
        if (bit.kind === 'wire') this.circuit.assumeRange(bit.wire, 0, 1)
        bits.push(bit)
      }
    }
    return bits
  }

  divide(node: ts.Node, a: Num, b: Num): Num {
    a = this.normalize(a)
    b = this.normalize(b)
    // The substrate has no division; a / b lowers to a * (1/b). The fround twin mirrors this
    // rewrite, so the drift it introduces shows up in the twin-versus-float64 statistics.
    if (b.kind === 'constant') {
      if (b.value === 0) reject(node, 'dynamic division', 'division by a constant zero')
      const reciprocal = f32(1 / b.value)
      return this.multiplyConstant(node, a, reciprocal)
    }
    if (!b.integer) reject(node, 'dynamic division', 'division by a runtime non-integer value')
    const range = this.rangeOf(b)
    const low = Math.ceil(range.minimum)
    const high = Math.floor(range.maximum)
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      reject(node, 'unbounded range', 'division by a runtime integer needs finite @fit ranges on the divisor')
    }
    if (low <= 0 && high >= 0) reject(node, 'dynamic division', 'runtime integer divisor may be zero')
    if (high - low > this.divisorSpanLimit) {
      reject(node, 'dynamic division', `runtime integer divisor spans ${high - low + 1} values, above the limit of ${this.divisorSpanLimit + 1}`)
    }
    const equalityBits = this.oneHot(node, b, low, high)
    let sum: Num = constantNum(0)
    for (let k = low; k <= high; k++) {
      const branch = this.multiplyConstant(node, a, f32(1 / k))
      // The branch value is computed for every input and then masked by the equality bit, so it
      // must stay FP32-representable across the numerator's whole context-free range.
      if (!fitsFp32(this.globalRangeOf(branch))) {
        reject(node, 'non-finite branch', 'a divisor branch value can overflow FP32; the masked sum would produce NaN')
      }
      const masked = this.multiply(node, branch, equalityBits[k - low]!)
      sum = this.add(node, sum, masked)
    }
    return sum
  }

  modulo(node: ts.Node, a: Num, b: Num): Num {
    a = this.normalize(a)
    b = this.normalize(b)
    if (a.kind === 'constant' && b.kind === 'constant') {
      if (b.value === 0) reject(node, 'dynamic division', 'modulo by a constant zero')
      return constantNum(a.value % b.value)
    }
    if (!numInteger(a) || !numInteger(b)) reject(node, 'dynamic division', 'modulo needs integer operands')
    const rangeA = this.rangeOf(a)
    if (rangeA.minimum < 0) reject(node, 'dynamic division', 'modulo of a possibly negative value (JS remainder sign)')
    if (rangeA.maximum >= integerExactLimit) reject(node, 'unbounded range', 'modulo dividend exceeds the FP32 exact-integer window')
    if (b.kind === 'constant') return this.moduloByConstant(node, a, b.value)
    const range = this.rangeOf(b)
    const low = Math.ceil(range.minimum)
    const high = Math.floor(range.maximum)
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      reject(node, 'unbounded range', 'modulo by a runtime integer needs finite @fit ranges on the divisor')
    }
    if (low <= 0) reject(node, 'dynamic division', 'runtime modulo divisor must be strictly positive')
    if (high - low > this.divisorSpanLimit) {
      reject(node, 'dynamic division', `runtime modulo divisor spans ${high - low + 1} values, above the limit of ${this.divisorSpanLimit + 1}`)
    }
    const equalityBits = this.oneHot(node, b, low, high)
    let sum: Num = constantNum(0)
    for (let k = low; k <= high; k++) {
      const branch = this.moduloByConstant(node, a, k)
      const masked = this.multiply(node, branch, equalityBits[k - low]!)
      sum = this.add(node, sum, masked)
    }
    if (sum.kind === 'wire') sum = this.attachNarrowedHull(sum, 0, high - 1)
    return sum
  }

  // a % k for a non-negative bounded integer a and constant integer k >= 1, via
  // a - k * (count of multiples of k that a reaches). Every step is exact integer arithmetic.
  moduloByConstant(node: ts.Node, a: Num, k: number): Num {
    invariant(Number.isInteger(k) && k >= 1, 'modulo divisor must be a positive integer')
    if (k === 1) return constantNum(0)
    if (a.kind === 'constant') return constantNum(a.value % k)
    const range = this.rangeOf(a)
    const multiples = Math.floor(range.maximum / k)
    if (multiples === 0) return a
    let quotient: Num = constantNum(0)
    for (let m = 1; m <= multiples; m++) {
      quotient = this.add(node, quotient, this.integerAtLeastOneBit(node, this.affineStep(node, [[a, 1]], 1 - m * k)))
    }
    let result = this.subtract(node, a, this.multiplyConstant(node, quotient, k))
    // The multiple count may come from a narrowed dividend range; for inputs outside it the
    // quotient saturates and the remainder can exceed k - 1, so the bound is a branch fact.
    if (result.kind === 'wire') result = this.attachNarrowedHull(result, 0, k - 1)
    return result
  }
}

function productHull(
  rangeA: {minimum: number, maximum: number},
  rangeB: {minimum: number, maximum: number},
): {minimum: number, maximum: number} {
  const products = [
    rangeA.minimum * rangeB.minimum,
    rangeA.minimum * rangeB.maximum,
    rangeA.maximum * rangeB.minimum,
    rangeA.maximum * rangeB.maximum,
  ].map(product => f32(product))
  if (products.some(Number.isNaN)) return {minimum: -Infinity, maximum: Infinity}
  return {minimum: Math.min(...products), maximum: Math.max(...products)}
}

function lineOf(node: ts.Node): number {
  const file = node.getSourceFile()
  return file.getLineAndCharacterOfPosition(node.getStart()).line + 1
}

// ============================== scopes ==============================

type Binding = {value: Value, mutable: boolean}

export class Scope {
  parent: Scope | null
  bindings: Map<string, Binding>

  constructor(parent: Scope | null) {
    this.parent = parent
    this.bindings = new Map()
  }

  declare(name: string, value: Value, mutable: boolean) {
    this.bindings.set(name, {value, mutable})
  }

  lookup(name: string): Binding | null {
    const binding = this.bindings.get(name)
    if (binding !== undefined) return binding
    return this.parent === null ? null : this.parent.lookup(name)
  }
}

// ============================== execution context ==============================

export type InputSpec = {minimum: number, maximum: number, integer: boolean}

type ModuleContext = {
  functions: Map<string, FunctionLike>
  constantInitializers: Map<string, ts.Expression>
  memoizedConstants: Map<string, Value>
  emitter: Emitter
  moduleScope: Scope
  callDepth: number
  loopBudget: number
}

type ExecutionContext = {
  module: ModuleContext
  scope: Scope
  mask: Num | null
  completion: {returned: {value: Value} | null}
  rejectExpressionEffects: boolean
}

const browserGlobals = new Set([
  'document', 'window', 'navigator', 'history', 'location', 'requestAnimationFrame',
  'addEventListener', 'localStorage', 'matchMedia', 'getSelection', 'HTMLElement',
  'HTMLDivElement', 'HTMLImageElement', 'KeyboardEvent', 'MouseEvent', 'EventTarget',
])

// ============================== statements ==============================

function runStatements(statements: readonly ts.Statement[], ctx: ExecutionContext) {
  for (const statement of statements) {
    if (ctx.completion.returned !== null) return
    runStatement(statement, ctx)
  }
}

function runStatement(statement: ts.Statement, ctx: ExecutionContext) {
  if (ts.isVariableStatement(statement)) {
    runVariableDeclarations(statement.declarationList, ctx)
    return
  }
  if (ts.isExpressionStatement(statement)) {
    runExpressionStatement(statement.expression, ctx)
    return
  }
  if (ts.isIfStatement(statement)) {
    runIfStatement(statement, ctx)
    return
  }
  if (ts.isForStatement(statement)) {
    runForStatement(statement, ctx)
    return
  }
  if (ts.isForOfStatement(statement)) {
    runForOfStatement(statement, ctx)
    return
  }
  if (ts.isReturnStatement(statement)) {
    if (ctx.mask !== null) reject(statement, 'early return', 'return under a runtime condition')
    ctx.completion.returned = {value: statement.expression === undefined ? {kind: 'null'} : evaluate(statement.expression, ctx)}
    return
  }
  if (ts.isBlock(statement)) {
    runStatements(statement.statements, {...ctx, scope: new Scope(ctx.scope)})
    return
  }
  if (statement.kind === ts.SyntaxKind.EmptyStatement) return
  if (ts.isBreakOrContinueStatement(statement)) {
    reject(statement, 'dynamic loop bound', 'break/continue makes the iteration count data-dependent')
  }
  reject(statement, 'unsupported syntax', ts.SyntaxKind[statement.kind])
}

function runVariableDeclarations(list: ts.VariableDeclarationList, ctx: ExecutionContext) {
  const mutable = (list.flags & ts.NodeFlags.Const) === 0
  for (const declaration of list.declarations) {
    if (declaration.initializer === undefined) {
      reject(declaration, 'unsupported syntax', 'declaration without an initializer')
    }
    const value = evaluate(declaration.initializer, ctx)
    bindDeclarationName(declaration.name, value, mutable, ctx)
  }
}

function bindDeclarationName(name: ts.BindingName, value: Value, mutable: boolean, ctx: ExecutionContext) {
  if (ts.isIdentifier(name)) {
    ctx.scope.declare(name.text, value, mutable)
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    if (value.kind !== 'object') reject(name, 'non-numeric value', 'object destructuring of a non-object')
    for (const element of name.elements) {
      if (element.dotDotDotToken !== undefined) reject(element, 'unsupported syntax', 'rest element in destructuring')
      const property = element.propertyName ?? element.name
      if (!ts.isIdentifier(property) || !ts.isIdentifier(element.name)) {
        reject(element, 'unsupported syntax', 'computed destructuring')
      }
      const field = value.fields.get(property.text)
      if (field === undefined) reject(element, 'unknown identifier', `missing field ${property.text}`)
      ctx.scope.declare(element.name.text, field, mutable)
    }
    return
  }
  reject(name, 'unsupported syntax', 'array destructuring')
}

const assignmentOperators = new Map<ts.SyntaxKind, '=' | '+' | '-' | '*' | '/'>([
  [ts.SyntaxKind.EqualsToken, '='],
  [ts.SyntaxKind.PlusEqualsToken, '+'],
  [ts.SyntaxKind.MinusEqualsToken, '-'],
  [ts.SyntaxKind.AsteriskEqualsToken, '*'],
  [ts.SyntaxKind.SlashEqualsToken, '/'],
])

function runExpressionStatement(expression: ts.Expression, ctx: ExecutionContext) {
  if (ts.isBinaryExpression(expression)) {
    const operator = assignmentOperators.get(expression.operatorToken.kind)
    if (operator !== undefined) {
      runAssignment(expression, operator, ctx)
      return
    }
  }
  if (ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)) {
    const operand = expression.operand
    if (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken) {
      const delta = expression.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1
      const target = resolveAssignmentTarget(operand, ctx)
      const current = toNum(target.read(), operand)
      writeMasked(target, current, ctx.module.emitter.add(expression, current, constantNum(delta)), expression, ctx)
      return
    }
  }
  if (ts.isCallExpression(expression)) {
    evaluate(expression, ctx)
    return
  }
  reject(expression, 'unsupported syntax', `expression statement ${ts.SyntaxKind[expression.kind]}`)
}

type AssignmentTarget = {
  read: () => Value
  write: (value: Value) => void
}

function resolveAssignmentTarget(node: ts.Expression, ctx: ExecutionContext): AssignmentTarget {
  if (ctx.rejectExpressionEffects) {
    reject(node, 'unsupported syntax', 'mutation inside a runtime conditional expression; use an if statement')
  }
  if (ts.isIdentifier(node)) {
    const binding = ctx.scope.lookup(node.text)
    if (binding === null) reject(node, 'unknown identifier', `assignment to unknown ${node.text}`)
    if (!binding.mutable) reject(node, 'unsupported syntax', `assignment to const ${node.text}`)
    return {
      read: () => binding.value,
      write: value => { binding.value = value },
    }
  }
  if (ts.isPropertyAccessExpression(node)) {
    const container = evaluate(node.expression, ctx)
    if (container.kind !== 'object') reject(node, 'non-numeric value', 'property assignment on a non-object')
    const field = node.name.text
    return {
      read: () => {
        const value = container.fields.get(field)
        if (value === undefined) reject(node, 'unknown identifier', `missing field ${field}`)
        return value
      },
      write: value => container.fields.set(field, value),
    }
  }
  if (ts.isElementAccessExpression(node)) {
    const container = evaluate(node.expression, ctx)
    if (container.kind !== 'array') reject(node, 'non-numeric value', 'element assignment on a non-array')
    const index = toNum(evaluate(node.argumentExpression, ctx), node.argumentExpression)
    if (index.kind !== 'constant') reject(node, 'dynamic index', 'element assignment at a runtime index')
    const at = index.value
    if (!Number.isInteger(at) || at < 0 || at >= container.elements.length) {
      reject(node, 'dynamic index', `element assignment at out-of-bounds index ${at}`)
    }
    return {
      read: () => container.elements[at]!,
      write: value => { container.elements[at] = value },
    }
  }
  reject(node, 'unsupported syntax', `assignment target ${ts.SyntaxKind[node.kind]}`)
}

function writeMasked(target: AssignmentTarget, current: Value, next: Value, node: ts.Node, ctx: ExecutionContext) {
  if (ctx.mask === null) {
    target.write(next)
    return
  }
  if (!isNum(next) || !isNum(current)) {
    reject(node, 'masked structure change', 'only numeric assignments can run under a runtime condition')
  }
  target.write(ctx.module.emitter.select(node, ctx.mask, current, next))
}

function runAssignment(expression: ts.BinaryExpression, operator: '=' | '+' | '-' | '*' | '/', ctx: ExecutionContext) {
  const target = resolveAssignmentTarget(expression.left, ctx)
  const rightValue = evaluate(expression.right, ctx)
  let next: Value
  if (operator === '=') {
    next = rightValue
    if (ctx.mask !== null) {
      writeMasked(target, target.read(), next, expression, ctx)
      return
    }
    target.write(next)
    return
  }
  const current = toNum(target.read(), expression.left)
  const right = toNum(rightValue, expression.right)
  const emitter = ctx.module.emitter
  switch (operator) {
    case '+': next = emitter.add(expression, current, right); break
    case '-': next = emitter.subtract(expression, current, right); break
    case '*': next = emitter.multiply(expression, current, right); break
    case '/': next = emitter.divide(expression, current, right); break
  }
  writeMasked(target, current, next, expression, ctx)
}

function runIfStatement(statement: ts.IfStatement, ctx: ExecutionContext) {
  const condition = evaluate(statement.expression, ctx)
  const bit = toBit(condition, statement.expression, ctx)
  if (bit.kind === 'constant') {
    const taken = bit.value === 1 ? statement.thenStatement : statement.elseStatement
    if (taken !== undefined) runStatement(taken, {...ctx, scope: new Scope(ctx.scope)})
    return
  }
  const emitter = ctx.module.emitter
  const thenMask = ctx.mask === null ? bit : emitter.andBit(statement, ctx.mask, bit)
  runStatement(statement.thenStatement, {...ctx, scope: new Scope(ctx.scope), mask: thenMask})
  if (statement.elseStatement !== undefined) {
    const notBit = emitter.notBit(statement, bit)
    const elseMask = ctx.mask === null ? notBit : emitter.andBit(statement, ctx.mask, notBit)
    runStatement(statement.elseStatement, {...ctx, scope: new Scope(ctx.scope), mask: elseMask})
  }
}

// for (let i = INIT; i CMP LIMIT; i++/i--) with INIT and LIMIT either compile-time constants or
// bounded runtime integers. Constant bounds unroll directly. A runtime bound unrolls over the
// whole static range with a per-iteration mask; a masked-off iteration only performs
// select(mask, old, new) writes that keep the old value, so it is an exact no-op, which keeps
// the unrolled circuit bit-identical to the twin's native loop.
function runForStatement(statement: ts.ForStatement, ctx: ExecutionContext) {
  const initializer = statement.initializer
  if (initializer === undefined || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) {
    reject(statement, 'unsupported syntax', 'for loop needs a single let initializer')
  }
  const declaration = initializer.declarations[0]!
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) {
    reject(statement, 'unsupported syntax', 'for loop initializer shape')
  }
  const variableName = declaration.name.text
  const condition = statement.condition
  const incrementor = statement.incrementor
  if (condition === undefined || incrementor === undefined || !ts.isBinaryExpression(condition)) {
    reject(statement, 'unsupported syntax', 'for loop needs a comparison condition and an incrementor')
  }
  if (!ts.isIdentifier(condition.left) || condition.left.text !== variableName) {
    reject(statement, 'unsupported syntax', 'for loop condition must compare the loop variable')
  }
  const comparison = comparisonOperatorText(condition.operatorToken.kind)
  if (comparison === null || comparison === '===' || comparison === '!==') {
    reject(statement, 'unsupported syntax', 'for loop condition operator')
  }
  const step = loopStep(incrementor, variableName)
  if (step === null) reject(statement, 'unsupported syntax', 'for loop incrementor must be ++/--/+= 1/-= 1')

  const emitter = ctx.module.emitter
  const start = toNum(evaluate(declaration.initializer, ctx), declaration.initializer)
  if (!numInteger(start)) reject(statement, 'dynamic loop bound', 'for loop start is not an integer')
  const limitProbe = toNum(evaluate(condition.right, {...ctx}), condition.right)
  if (!numInteger(limitProbe)) reject(statement, 'dynamic loop bound', 'for loop limit is not an integer')

  const startRange = emitter.rangeOf(emitter.normalize(start))
  const limitRange = emitter.rangeOf(emitter.normalize(limitProbe))
  if (!Number.isFinite(startRange.minimum) || !Number.isFinite(startRange.maximum)
    || !Number.isFinite(limitRange.minimum) || !Number.isFinite(limitRange.maximum)) {
    reject(statement, 'dynamic loop bound', 'for loop bounds need finite @fit ranges')
  }

  const ascending = step > 0
  let staticFirst: number
  let staticLast: number
  if (ascending) {
    staticFirst = Math.ceil(startRange.minimum)
    staticLast = comparison === '<' ? Math.floor(limitRange.maximum) - 1 : Math.floor(limitRange.maximum)
  } else {
    staticFirst = Math.floor(startRange.maximum)
    staticLast = comparison === '>' ? Math.ceil(limitRange.minimum) + 1 : Math.ceil(limitRange.minimum)
  }
  const iterationCount = ascending ? staticLast - staticFirst + 1 : staticFirst - staticLast + 1
  if (iterationCount > 4096) reject(statement, 'dynamic loop bound', `loop would unroll ${iterationCount} iterations`)
  if (iterationCount <= 0) return

  for (let i = staticFirst; ascending ? i <= staticLast : i >= staticLast; i += step) {
    const iterationScope = new Scope(ctx.scope)
    iterationScope.declare(variableName, constantNum(i), false)
    const iterationCtx: ExecutionContext = {...ctx, scope: iterationScope}
    // The loop runs iteration i when i is on the live side of both the start and the limit.
    let mask = ctx.mask
    const startBit = ascending
      ? emitter.compare(statement, '>=', constantNum(i), start)
      : emitter.compare(statement, '<=', constantNum(i), start)
    mask = mask === null ? startBit : emitter.andBit(statement, mask, startBit)
    const limit = toNum(evaluate(condition.right, iterationCtx), condition.right)
    const limitBit = emitter.compare(statement, comparison, constantNum(i), limit)
    mask = emitter.andBit(statement, mask, limitBit)
    const normalizedMask = emitter.normalize(mask)
    if (normalizedMask.kind === 'constant' && normalizedMask.value === 0) continue
    runStatement(statement.statement, {
      ...iterationCtx,
      mask: normalizedMask.kind === 'constant' && normalizedMask.value === 1 ? ctx.mask : normalizedMask,
    })
    if (ctx.completion.returned !== null) return
    if (ctx.module.loopBudget-- <= 0) reject(statement, 'dynamic loop bound', 'loop unrolling budget exhausted')
  }
}

function comparisonOperatorText(kind: ts.SyntaxKind): '<' | '<=' | '>' | '>=' | '===' | '!==' | null {
  switch (kind) {
    case ts.SyntaxKind.LessThanToken: return '<'
    case ts.SyntaxKind.LessThanEqualsToken: return '<='
    case ts.SyntaxKind.GreaterThanToken: return '>'
    case ts.SyntaxKind.GreaterThanEqualsToken: return '>='
    case ts.SyntaxKind.EqualsEqualsEqualsToken: return '==='
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return '!=='
    default: return null
  }
}

function loopStep(incrementor: ts.Expression, variableName: string): number | null {
  if (ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor)) {
    if (!ts.isIdentifier(incrementor.operand) || incrementor.operand.text !== variableName) return null
    if (incrementor.operator === ts.SyntaxKind.PlusPlusToken) return 1
    if (incrementor.operator === ts.SyntaxKind.MinusMinusToken) return -1
    return null
  }
  if (ts.isBinaryExpression(incrementor) && ts.isIdentifier(incrementor.left) && incrementor.left.text === variableName) {
    if (!ts.isNumericLiteral(incrementor.right) || incrementor.right.text !== '1') return null
    if (incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) return 1
    if (incrementor.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) return -1
  }
  return null
}

function runForOfStatement(statement: ts.ForOfStatement, ctx: ExecutionContext) {
  const iterated = evaluate(statement.expression, ctx)
  if (iterated.kind !== 'array') reject(statement, 'non-numeric value', 'for-of over a non-array')
  if (!ts.isVariableDeclarationList(statement.initializer) || statement.initializer.declarations.length !== 1) {
    reject(statement, 'unsupported syntax', 'for-of initializer shape')
  }
  const declaration = statement.initializer.declarations[0]!
  for (const element of iterated.elements) {
    const iterationScope = new Scope(ctx.scope)
    const iterationCtx: ExecutionContext = {...ctx, scope: iterationScope}
    bindDeclarationName(declaration.name, element, false, iterationCtx)
    runStatement(statement.statement, iterationCtx)
    if (ctx.completion.returned !== null) return
  }
}

// ============================== expressions ==============================

function evaluate(node: ts.Expression, ctx: ExecutionContext): Value {
  if (ts.isNumericLiteral(node)) return constantNum(Number(node.text))
  if (ts.isStringLiteralLike(node)) return {kind: 'string', value: node.text}
  if (ts.isTemplateExpression(node)) reject(node, 'string work', 'template literal')
  if (node.kind === ts.SyntaxKind.TrueKeyword) return constantNum(1)
  if (node.kind === ts.SyntaxKind.FalseKeyword) return constantNum(0)
  if (node.kind === ts.SyntaxKind.NullKeyword) return {kind: 'null'}
  if (ts.isIdentifier(node)) return evaluateIdentifier(node, ctx)
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, ctx)
  if (ts.isNonNullExpression(node)) {
    const value = evaluate(node.expression, ctx)
    if (value.kind === 'nullable') return value.value
    if (value.kind === 'null') reject(node, 'non-numeric value', 'non-null assertion on a value that is always null')
    return value
  }
  if (ts.isPrefixUnaryExpression(node)) return evaluatePrefixUnary(node, ctx)
  if (ts.isPropertyAccessExpression(node)) return evaluatePropertyAccess(node, ctx)
  if (ts.isElementAccessExpression(node)) return evaluateElementAccess(node, ctx)
  if (ts.isCallExpression(node)) return evaluateCall(node, ctx)
  if (ts.isBinaryExpression(node)) return evaluateBinary(node, ctx)
  if (ts.isConditionalExpression(node)) return evaluateConditional(node, ctx)
  if (ts.isObjectLiteralExpression(node)) return evaluateObjectLiteral(node, ctx)
  if (ts.isArrayLiteralExpression(node)) {
    return {kind: 'array', elements: node.elements.map(element => evaluate(element, ctx))}
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return {kind: 'function', declaration: node}
  if (ts.isAsExpression(node)) return evaluate(node.expression, ctx)
  reject(node, 'unsupported syntax', ts.SyntaxKind[node.kind])
}

function evaluateIdentifier(node: ts.Identifier, ctx: ExecutionContext): Value {
  const name = node.text
  if (name === 'Infinity') return {kind: 'constant', value: Number.POSITIVE_INFINITY}
  if (name === 'undefined') return {kind: 'null'}
  if (name === 'NaN') reject(node, 'non-numeric value', 'NaN literal')
  const binding = ctx.scope.lookup(name)
  if (binding !== null) return binding.value
  const module = ctx.module
  const memoized = module.memoizedConstants.get(name)
  if (memoized !== undefined) return memoized
  const declaration = module.functions.get(name)
  if (declaration !== undefined) return {kind: 'function', declaration}
  const initializer = module.constantInitializers.get(name)
  if (initializer !== undefined) {
    const value = evaluate(initializer, {module, scope: module.moduleScope, mask: null, completion: {returned: null}, rejectExpressionEffects: ctx.rejectExpressionEffects})
    module.memoizedConstants.set(name, value)
    return value
  }
  if (browserGlobals.has(name)) reject(node, 'browser API', name)
  if (name === 'Math') reject(node, 'unsupported call', 'Math used outside a recognized call')
  reject(node, 'unknown identifier', name)
}

function evaluatePrefixUnary(node: ts.PrefixUnaryExpression, ctx: ExecutionContext): Value {
  const operand = evaluate(node.operand, ctx)
  const emitter = ctx.module.emitter
  switch (node.operator) {
    case ts.SyntaxKind.MinusToken: {
      const num = toNum(operand, node.operand)
      if (num.kind === 'constant') return {kind: 'constant', value: -num.value}
      return emitter.multiplyConstant(node, num, -1)
    }
    case ts.SyntaxKind.PlusToken: return toNum(operand, node.operand)
    case ts.SyntaxKind.ExclamationToken: {
      const bit = toBit(operand, node.operand, ctx)
      return emitter.notBit(node, bit)
    }
    default: reject(node, 'unsupported syntax', `unary operator ${ts.SyntaxKind[node.operator]}`)
  }
}

function evaluatePropertyAccess(node: ts.PropertyAccessExpression, ctx: ExecutionContext): Value {
  if (ts.isIdentifier(node.expression)) {
    const rootName = node.expression.text
    if (browserGlobals.has(rootName)) reject(node, 'browser API', node.getText())
    if (rootName === 'Math') reject(node, 'unsupported call', `Math.${node.name.text} used outside a call`)
  }
  const container = evaluate(node.expression, ctx)
  const field = node.name.text
  if (container.kind === 'object') {
    const value = container.fields.get(field)
    if (value === undefined) reject(node, 'unknown identifier', `missing field ${field}`)
    return value
  }
  if (container.kind === 'array' && field === 'length') return constantNum(container.elements.length)
  if (container.kind === 'string') reject(node, 'string work', `string property ${field}`)
  reject(node, 'non-numeric value', `property access on ${container.kind}`)
}

function evaluateElementAccess(node: ts.ElementAccessExpression, ctx: ExecutionContext): Value {
  const container = evaluate(node.expression, ctx)
  if (container.kind !== 'array') reject(node, 'non-numeric value', 'indexing a non-array')
  const index = toNum(evaluate(node.argumentExpression, ctx), node.argumentExpression)
  const normalized = ctx.module.emitter.normalize(index)
  if (normalized.kind !== 'constant') {
    reject(node, 'dynamic index', 'array read at a runtime index (needs a one-hot gather)')
  }
  const at = normalized.value
  if (!Number.isInteger(at) || at < 0 || at >= container.elements.length) {
    reject(node, 'dynamic index', `array read at out-of-bounds index ${at}`)
  }
  return container.elements[at]!
}

function evaluateCall(node: ts.CallExpression, ctx: ExecutionContext): Value {
  const emitter = ctx.module.emitter
  if (ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text
    if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Math') {
      const args = node.arguments.map(argument => toNum(evaluate(argument, ctx), argument))
      switch (method) {
        case 'min': return args.reduce((left, right) => emitter.minimum(node, left, right))
        case 'max': return args.reduce((left, right) => emitter.maximum(node, left, right))
        case 'abs': return emitter.absolute(node, requireOneArgument(args))
        case 'floor': return emitter.floor(node, requireOneArgument(args))
        default: reject(node, 'unsupported call', `Math.${method}`)
      }
    }
    const container = evaluate(node.expression.expression, ctx)
    if (container.kind === 'array') {
      if (method === 'push') {
        if (ctx.rejectExpressionEffects) reject(node, 'unsupported syntax', 'array append inside a runtime conditional expression')
        if (ctx.mask !== null) reject(node, 'runtime-sized array', 'array append under a runtime condition')
        for (const argument of node.arguments) container.elements.push(evaluate(argument, ctx))
        return constantNum(container.elements.length)
      }
      if (method === 'at') {
        const index = toNum(evaluate(node.arguments[0]!, ctx), node)
        const normalized = emitter.normalize(index)
        if (normalized.kind !== 'constant') reject(node, 'dynamic index', 'array .at with a runtime index')
        const at = normalized.value < 0 ? container.elements.length + normalized.value : normalized.value
        if (!Number.isInteger(at) || at < 0 || at >= container.elements.length) {
          reject(node, 'dynamic index', `array .at out of bounds`)
        }
        return container.elements[at]!
      }
      reject(node, 'unsupported call', `array method ${method}`)
    }
    if (container.kind === 'string') reject(node, 'string work', `string method ${method}`)
    reject(node, 'unsupported call', node.expression.getText())
  }
  if (ts.isIdentifier(node.expression)) {
    const callee = evaluateIdentifier(node.expression, ctx)
    if (callee.kind !== 'function') reject(node, 'unsupported call', `${node.expression.text} is not a compilable function`)
    return inlineFunctionCall(callee.declaration, node.arguments.map(argument => evaluate(argument, ctx)), node, ctx)
  }
  reject(node, 'unsupported call', node.expression.getText())
}

function requireOneArgument(args: Num[]): Num {
  invariant(args.length === 1, 'expected exactly one argument')
  return args[0]!
}

export function inlineFunctionCall(declaration: FunctionLike, args: Value[], node: ts.Node, ctx: ExecutionContext): Value {
  const module = ctx.module
  if (module.callDepth >= 16) reject(node, 'unsupported call', 'call depth limit (recursion?)')
  const callScope = new Scope(module.moduleScope)
  const callCtx: ExecutionContext = {module, scope: callScope, mask: ctx.mask, completion: {returned: null}, rejectExpressionEffects: ctx.rejectExpressionEffects}
  declaration.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) reject(parameter, 'unsupported syntax', 'destructured parameter')
    let argument = args[index]
    if (argument === undefined) {
      if (parameter.initializer === undefined) reject(node, 'unsupported call', `missing argument ${parameter.name.text}`)
      argument = evaluate(parameter.initializer, callCtx)
    }
    callScope.declare(parameter.name.text, argument, true)
  })
  const body = declaration.body
  if (body === undefined) reject(node, 'unsupported call', 'function without a body')
  module.callDepth++
  try {
    if (ts.isBlock(body)) {
      runStatements(body.statements, callCtx)
      return callCtx.completion.returned === null ? {kind: 'null'} : callCtx.completion.returned.value
    }
    return evaluate(body, callCtx)
  } finally {
    module.callDepth--
  }
}

function evaluateBinary(node: ts.BinaryExpression, ctx: ExecutionContext): Value {
  const kind = node.operatorToken.kind
  if (assignmentOperators.has(kind)) reject(node, 'unsupported syntax', 'assignment used as an expression')
  const emitter = ctx.module.emitter

  if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
    const left = toBit(evaluate(node.left, ctx), node.left, ctx)
    if (left.kind === 'constant') {
      // Match JS short-circuiting: a constant decides without evaluating the other side.
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken && left.value === 0) return constantNum(0)
      if (kind === ts.SyntaxKind.BarBarToken && left.value === 1) return constantNum(1)
      return toBit(evaluate(node.right, ctx), node.right, ctx)
    }
    const right = toBit(evaluate(node.right, {...ctx, rejectExpressionEffects: true}), node.right, ctx)
    return kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? emitter.andBit(node, left, right)
      : emitter.orBit(node, left, right)
  }

  if (kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = evaluate(node.left, ctx)
    if (left.kind === 'null') return evaluate(node.right, ctx)
    if (left.kind !== 'nullable') return left
    const fallback = toNum(evaluate(node.right, {...ctx, rejectExpressionEffects: true}), node.right)
    return emitter.select(node, left.present, fallback, left.value)
  }

  // Loose null tests (x == null, x != null) are the only == / != uses in the subset.
  if (kind === ts.SyntaxKind.EqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken) {
    const rightIsNull = node.right.kind === ts.SyntaxKind.NullKeyword
      || (ts.isIdentifier(node.right) && node.right.text === 'undefined')
    if (!rightIsNull) reject(node, 'unsupported syntax', 'loose equality on non-null operands')
    const left = evaluate(node.left, ctx)
    const isNullBit = left.kind === 'null'
      ? constantNum(1)
      : left.kind === 'nullable'
        ? emitter.notBit(node, left.present)
        : constantNum(0)
    return kind === ts.SyntaxKind.EqualsEqualsToken ? isNullBit : emitter.notBit(node, isNullBit)
  }

  const comparison = comparisonOperatorText(kind)
  if (comparison !== null) {
    const leftValue = evaluate(node.left, ctx)
    const rightValue = evaluate(node.right, ctx)
    if (leftValue.kind === 'string' || rightValue.kind === 'string') {
      reject(node, 'string work', 'string comparison')
    }
    if (leftValue.kind === 'null' || rightValue.kind === 'null'
      || leftValue.kind === 'nullable' || rightValue.kind === 'nullable') {
      if (comparison === '===' || comparison === '!==') {
        const left = toNullable(leftValue)
        const right = toNullable(rightValue)
        if (left === null || right === null) reject(node, 'non-numeric value', 'nullable comparison requires numbers or null')
        if (leftValue.kind === 'null' || rightValue.kind === 'null') {
          const other = leftValue.kind === 'null' ? right : left
          return comparison === '===' ? emitter.notBit(node, other.present) : other.present
        }
        const bothAbsent = emitter.andBit(node, emitter.notBit(node, left.present), emitter.notBit(node, right.present))
        const bothPresent = emitter.andBit(node, left.present, right.present)
        const equalValues = emitter.compare(node, '===', left.value, right.value)
        const equal = emitter.orBit(node, bothAbsent, emitter.andBit(node, bothPresent, equalValues))
        return comparison === '===' ? equal : emitter.notBit(node, equal)
      }
      reject(node, 'non-numeric value', 'ordering comparison on a nullable value')
    }
    return emitter.compare(node, comparison, toNum(leftValue, node.left), toNum(rightValue, node.right))
  }

  const leftOperand = evaluate(node.left, ctx)
  const rightOperand = evaluate(node.right, ctx)
  if (leftOperand.kind === 'string' || rightOperand.kind === 'string') {
    reject(node, 'string work', 'arithmetic on a string')
  }
  const left = toNum(leftOperand, node.left)
  const right = toNum(rightOperand, node.right)
  switch (kind) {
    case ts.SyntaxKind.PlusToken: return emitter.add(node, left, right)
    case ts.SyntaxKind.MinusToken: return emitter.subtract(node, left, right)
    case ts.SyntaxKind.AsteriskToken: return emitter.multiply(node, left, right)
    case ts.SyntaxKind.SlashToken: return emitter.divide(node, left, right)
    case ts.SyntaxKind.PercentToken: return emitter.modulo(node, left, right)
    default: reject(node, 'unsupported syntax', `binary operator ${ts.SyntaxKind[kind]}`)
  }
}

function evaluateConditional(node: ts.ConditionalExpression, ctx: ExecutionContext): Value {
  const bit = toBit(evaluate(node.condition, ctx), node.condition, ctx)
  if (bit.kind === 'constant') {
    return evaluate(bit.value === 1 ? node.whenTrue : node.whenFalse, ctx)
  }
  const branchContext = {...ctx, rejectExpressionEffects: true}
  const whenTrue = evaluate(node.whenTrue, refineScopeForBranch(node.condition, true, branchContext))
  const whenFalse = evaluate(node.whenFalse, refineScopeForBranch(node.condition, false, branchContext))
  const emitter = ctx.module.emitter
  if (isNum(whenTrue) && isNum(whenFalse)) return emitter.select(node, bit, whenFalse, whenTrue)
  // Branches mixing numbers and null lower to a presence bit plus a value.
  const trueNullable = toNullable(whenTrue)
  const falseNullable = toNullable(whenFalse)
  if (trueNullable !== null && falseNullable !== null) {
    return {
      kind: 'nullable',
      present: emitter.select(node, bit, falseNullable.present, trueNullable.present),
      value: emitter.select(node, bit, falseNullable.value, trueNullable.value),
    }
  }
  reject(node, 'non-numeric value', `ternary branches of kinds ${whenTrue.kind} and ${whenFalse.kind}`)
}

// Comparison-guided range refinement for ternary branches. In `v > max ? max : v`, the false
// branch runs only when v <= max, so inside that branch v's range can be intersected with
// max's upper bound. This is the flow narrowing TypeScript performs for types, applied to
// numeric ranges. Without it, interval analysis cannot see that the clamp helper's result stays
// within [min, max], and lowerings that need bounded ranges downstream (like division by the
// clamped column count in colsBoxMaxSizeXF) would reject.
function refineScopeForBranch(condition: ts.Expression, branchIsTrue: boolean, ctx: ExecutionContext): ExecutionContext {
  if (!ts.isBinaryExpression(condition)) return ctx
  const operator = comparisonOperatorText(condition.operatorToken.kind)
  if (operator === null) return ctx
  const effective = branchIsTrue ? operator : negateComparison(operator)
  if (effective === null) return ctx
  const scope = new Scope(ctx.scope)
  refineIdentifierRange(condition.left, condition.right, effective, scope, ctx)
  refineIdentifierRange(condition.right, condition.left, mirrorComparison(effective), scope, ctx)
  if (scope.bindings.size === 0) return ctx
  return {...ctx, scope}
}

type ComparisonText = '<' | '<=' | '>' | '>=' | '===' | '!=='

function negateComparison(operator: ComparisonText): ComparisonText | null {
  switch (operator) {
    case '<': return '>='
    case '<=': return '>'
    case '>': return '<='
    case '>=': return '<'
    // The negation of equality excludes one value but gives no interval bound.
    case '===': return null
    case '!==': return '==='
  }
}

function mirrorComparison(operator: ComparisonText): ComparisonText {
  switch (operator) {
    case '<': return '>'
    case '<=': return '>='
    case '>': return '<'
    case '>=': return '<='
    case '===': return '==='
    case '!==': return '!=='
  }
}

function refineIdentifierRange(
  target: ts.Expression,
  other: ts.Expression,
  operator: ComparisonText,
  scope: Scope,
  ctx: ExecutionContext,
) {
  if (operator === '!==') return
  if (!ts.isIdentifier(target)) return
  const binding = ctx.scope.lookup(target.text)
  if (binding === null || binding.value.kind !== 'wire') return
  const num = binding.value
  // The condition already evaluated once, so re-evaluating the other side is free (expression
  // dedup) and cannot fail.
  const otherValue = evaluate(other, ctx)
  if (!isNum(otherValue)) return
  const emitter = ctx.module.emitter
  const otherRange = emitter.rangeOf(otherValue)
  const currentRange = emitter.rangeOf(num)
  let minimum = currentRange.minimum
  let maximum = currentRange.maximum
  switch (operator) {
    case '<':
      maximum = Math.min(maximum, num.integer && Number.isInteger(otherRange.maximum) ? otherRange.maximum - 1 : otherRange.maximum)
      break
    case '<=': maximum = Math.min(maximum, otherRange.maximum); break
    case '>':
      minimum = Math.max(minimum, num.integer && Number.isInteger(otherRange.minimum) ? otherRange.minimum + 1 : otherRange.minimum)
      break
    case '>=': minimum = Math.max(minimum, otherRange.minimum); break
    case '===':
      minimum = Math.max(minimum, otherRange.minimum)
      maximum = Math.min(maximum, otherRange.maximum)
      break
  }
  // An empty intersection means the branch is unreachable for these ranges; its value never
  // reaches the select output, so keep the original binding.
  if (minimum > maximum) return
  if (minimum === currentRange.minimum && maximum === currentRange.maximum) return
  scope.declare(target.text, {...num, narrowed: {minimum, maximum}}, false)
}

function toNullable(value: Value): {present: Num, value: Num} | null {
  if (value.kind === 'null') return {present: constantNum(0), value: constantNum(0)}
  if (value.kind === 'nullable') return {present: value.present, value: value.value}
  if (isNum(value)) return {present: constantNum(1), value}
  return null
}

function evaluateObjectLiteral(node: ts.ObjectLiteralExpression, ctx: ExecutionContext): Value {
  const fields = new Map<string, Value>()
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      fields.set(property.name.text, evaluateIdentifier(property.name, ctx))
      continue
    }
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      fields.set(property.name.text, evaluate(property.initializer, ctx))
      continue
    }
    reject(property, 'unsupported syntax', 'object literal property shape')
  }
  return {kind: 'object', fields}
}

function toNum(value: Value, node: ts.Node): Num {
  if (isNum(value)) return value
  if (value.kind === 'null') reject(node, 'non-numeric value', 'null used as a number')
  reject(node, 'non-numeric value', `${value.kind} used as a number`)
}

function toBit(value: Value, node: ts.Node, ctx: ExecutionContext): Num {
  if (value.kind === 'null') return constantNum(0)
  if (value.kind === 'nullable') {
    // Truthiness of number|null would have to treat 0 as false; require an explicit null check.
    reject(node, 'non-numeric value', 'truthiness test on a nullable number (write an explicit != null)')
  }
  if (isNum(value)) {
    const normalized = ctx.module.emitter.normalize(value)
    if (normalized.kind === 'constant') {
      // JS truthiness on a constant number.
      return constantNum(normalized.value !== 0 ? 1 : 0)
    }
    if (!ctx.module.emitter.isBit(normalized)) {
      reject(node, 'non-numeric value', 'condition is a number not proven to be 0 or 1')
    }
    return normalized
  }
  reject(node, 'non-numeric value', `${value.kind} used as a condition`)
}

// ============================== compilation entry points ==============================

export type OpCounts = {
  operations: number
  reglu: number
  boolean: number
  affine: number
  layers: number
  storedWeights: number
}

export function circuitOpCounts(circuit: Circuit): OpCounts {
  let reglu = 0
  let booleanCount = 0
  let affine = 0
  let storedWeights = 0
  const depths = new Set<number>()
  for (const operation of circuit.operations) {
    if (operation.kind === 'reglu') reglu++
    else if (operation.kind === 'boolean') booleanCount++
    else affine++
    storedWeights += operation.leftTerms.length + operation.gateTerms.length
    depths.add(operation.depth)
  }
  return {
    operations: circuit.operations.length,
    reglu,
    boolean: booleanCount,
    affine,
    layers: depths.size,
    storedWeights,
  }
}

export type CompiledInput = {name: string, wire: Wire, spec: InputSpec}

export type CompiledOutput = {name: string, num: Num}

export type CompiledProgram = {
  circuit: Circuit
  oneWire: Wire
  inputs: CompiledInput[]
  outputs: CompiledOutput[]
  comparisonSites: ComparisonSite[]
  annotations: FitAnnotations
  opCounts: OpCounts
}

export type CompileOptions = {
  // Extra or tighter input ranges, keyed by parameter name or dotted path into an object
  // parameter (e.g. "config.pos"). These stand in for @fit annotations the source lacks; the
  // README lists every place the real file needed one.
  inputs?: Record<string, Partial<InputSpec>>
  floorStepLimit?: number
}

// A compilation session: allocates input wires up front (the Circuit source width is fixed at
// construction), then runs statements or function bodies against them. Block slices and
// per-value specialization build on this directly; compileFunctionFromSource wraps it.
export class Compilation {
  sourceFile: ts.SourceFile
  circuit: Circuit
  emitter: Emitter
  module: ModuleContext
  inputs: CompiledInput[]

  constructor(sourceFile: ts.SourceFile, inputSpecs: {name: string, spec: InputSpec}[], options: CompileOptions = {}) {
    this.sourceFile = sourceFile
    this.circuit = new Circuit(1 + inputSpecs.length)
    this.circuit.assumeRange(this.circuit.source(0), 1, 1)
    this.inputs = inputSpecs.map(({name, spec}, index) => {
      const wire = this.circuit.source(1 + index)
      // Widen by fround so an FP32-rounded sample of a float64 bound still passes the source
      // range check.
      this.circuit.assumeRange(
        wire,
        Math.min(spec.minimum, f32(spec.minimum)),
        Math.max(spec.maximum, f32(spec.maximum)),
      )
      return {name, wire, spec}
    })
    this.emitter = new Emitter(this.circuit, options.floorStepLimit ?? 64)
    const {functions, constantInitializers} = indexModule(sourceFile)
    this.module = {
      functions,
      constantInitializers,
      memoizedConstants: new Map(),
      emitter: this.emitter,
      moduleScope: new Scope(null),
      callDepth: 0,
      loopBudget: 1_000_000,
    }
  }

  inputNum(name: string): Num {
    const input = this.inputs.find(candidate => candidate.name === name)
    invariant(input !== undefined, `unknown input ${name}`)
    return {kind: 'wire', wire: input.wire, integer: input.spec.integer}
  }

  runStatements(statements: readonly ts.Statement[], bindings: Map<string, Value>): Scope {
    const scope = new Scope(this.module.moduleScope)
    for (const [name, value] of bindings) scope.declare(name, value, true)
    const ctx: ExecutionContext = {module: this.module, scope, mask: null, completion: {returned: null}, rejectExpressionEffects: false}
    runStatements(statements, ctx)
    return scope
  }

  evaluateExpression(expression: ts.Expression, bindings: Map<string, Value>): Value {
    const scope = new Scope(this.module.moduleScope)
    for (const [name, value] of bindings) scope.declare(name, value, true)
    const ctx: ExecutionContext = {module: this.module, scope, mask: null, completion: {returned: null}, rejectExpressionEffects: false}
    return evaluate(expression, ctx)
  }

  callFunction(name: string, args: Value[]): Value {
    const declaration = this.module.functions.get(name)
    invariant(declaration !== undefined, `function ${name} not found`)
    const ctx: ExecutionContext = {module: this.module, scope: this.module.moduleScope, mask: null, completion: {returned: null}, rejectExpressionEffects: false}
    return inlineFunctionCall(declaration, args, declaration, ctx)
  }
}

function indexModule(sourceFile: ts.SourceFile): {
  functions: Map<string, FunctionLike>
  constantInitializers: Map<string, ts.Expression>
} {
  const functions = new Map<string, FunctionLike>()
  const constantInitializers = new Map<string, ts.Expression>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.set(statement.name.text, statement)
      continue
    }
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      if (!isConst) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          constantInitializers.set(declaration.name.text, declaration.initializer)
        }
      }
    }
  }
  return {functions, constantInitializers}
}

// ============================== annotation extraction ==============================

export function extractFunctionAnnotations(sourceFile: ts.SourceFile, declaration: FunctionLike): FitAnnotations {
  const annotations = emptyFitAnnotations()
  const fullText = sourceFile.getFullText()
  const leading = ts.getLeadingCommentRanges(fullText, declaration.getFullStart()) ?? []
  for (const range of leading) {
    const comment = fullText.slice(range.pos, range.end)
    const marker = comment.indexOf('@fit')
    if (marker < 0) continue
    const content = comment.slice(marker + '@fit'.length).replace(/\*\/\s*$/, '')
    mergeFitAnnotations(annotations, parseFitText(content, null))
  }
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name)) continue
    const lineEnd = fullText.indexOf('\n', parameter.getEnd())
    const lineTail = fullText.slice(parameter.getEnd(), lineEnd < 0 ? fullText.length : lineEnd)
    const match = /\/\/\s*@fit\s+(.*)$/.exec(lineTail)
    if (match !== null) {
      mergeFitAnnotations(annotations, parseFitText(match[1]!, parameter.name.text))
    }
  }
  return annotations
}

// ============================== function compilation ==============================

export type CompileResult =
  | {ok: true, program: CompiledProgram, sourceFile: ts.SourceFile, declaration: FunctionLike}
  | {ok: false, diagnostic: Diagnostic}

export function parseSource(sourceText: string, fileName = 'input.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
}

export function compileFunctionFromSource(
  sourceText: string | ts.SourceFile,
  functionName: string,
  options: CompileOptions = {},
): CompileResult {
  const sourceFile = typeof sourceText === 'string' ? parseSource(sourceText) : sourceText
  const {functions} = indexModule(sourceFile)
  const declaration = functions.get(functionName)
  invariant(declaration !== undefined, `function ${functionName} not found in source`)
  const annotations = extractFunctionAnnotations(sourceFile, declaration)

  const specFor = (path: string): InputSpec => {
    const fromAnnotation = annotations.ranges.filter(range => range.subject === path)
    let minimum = Number.NEGATIVE_INFINITY
    let maximum = Number.POSITIVE_INFINITY
    let integer = false
    for (const range of fromAnnotation) {
      minimum = Math.max(minimum, range.minimum)
      maximum = Math.min(maximum, range.maximum)
      integer ||= range.integer
    }
    const override = options.inputs?.[path]
    if (override !== undefined) {
      if (override.minimum !== undefined) minimum = override.minimum
      if (override.maximum !== undefined) maximum = override.maximum
      if (override.integer !== undefined) integer = override.integer
    }
    return {minimum, maximum, integer}
  }

  try {
    // Gather the flat input list: plain numeric parameters, and object parameters whose fields
    // are declared through options (e.g. springStep's config object).
    const inputSpecs: {name: string, spec: InputSpec}[] = []
    const parameterShapes: {name: string, fields: string[] | null}[] = []
    for (const parameter of declaration.parameters) {
      if (!ts.isIdentifier(parameter.name)) reject(parameter, 'unsupported syntax', 'destructured parameter')
      const name = parameter.name.text
      const fieldPaths = Object.keys(options.inputs ?? {}).filter(path => path.startsWith(`${name}.`))
      if (fieldPaths.length > 0) {
        parameterShapes.push({name, fields: fieldPaths.map(path => path.slice(name.length + 1))})
        for (const path of fieldPaths) inputSpecs.push({name: path, spec: specFor(path)})
      } else {
        parameterShapes.push({name, fields: null})
        inputSpecs.push({name, spec: specFor(name)})
      }
    }

    const compilation = new Compilation(sourceFile, inputSpecs, options)
    const args: Value[] = []
    const objectParameters: {name: string, value: Value & {kind: 'object'}, originalFields: Map<string, Num>}[] = []
    for (const shape of parameterShapes) {
      if (shape.fields === null) {
        args.push(compilation.inputNum(shape.name))
        continue
      }
      const fields = new Map<string, Value>()
      const originalFields = new Map<string, Num>()
      for (const field of shape.fields) {
        const num = compilation.inputNum(`${shape.name}.${field}`)
        fields.set(field, num)
        originalFields.set(field, num)
      }
      const objectValue: Value & {kind: 'object'} = {kind: 'object', fields}
      objectParameters.push({name: shape.name, value: objectValue, originalFields})
      args.push(objectValue)
    }

    const returned = compilation.callFunction(functionName, args)
    const outputs: CompiledOutput[] = []
    flattenOutputs('return', returned, outputs, declaration)
    for (const parameter of objectParameters) {
      for (const [field, original] of parameter.originalFields) {
        const current = parameter.value.fields.get(field)!
        if (current !== original) {
          outputs.push({name: `${parameter.name}.${field}`, num: toNum(current, declaration)})
        }
      }
    }

    return {
      ok: true,
      sourceFile,
      declaration,
      program: {
        circuit: compilation.circuit,
        oneWire: asWire(0),
        inputs: compilation.inputs,
        outputs,
        comparisonSites: compilation.emitter.comparisonSites,
        annotations,
        opCounts: circuitOpCounts(compilation.circuit),
      },
    }
  } catch (error) {
    if (error instanceof CompileReject) return {ok: false, diagnostic: error.diagnostic}
    throw error
  }
}

function flattenOutputs(prefix: string, value: Value, outputs: CompiledOutput[], node: ts.Node) {
  if (isNum(value)) {
    outputs.push({name: prefix, num: value})
    return
  }
  switch (value.kind) {
    case 'null': return
    case 'nullable':
      outputs.push({name: `${prefix}.present`, num: value.present})
      outputs.push({name: `${prefix}.value`, num: value.value})
      return
    case 'object':
      for (const [field, fieldValue] of value.fields) flattenOutputs(`${prefix}.${field}`, fieldValue, outputs, node)
      return
    case 'array':
      value.elements.forEach((element, index) => flattenOutputs(`${prefix}[${index}]`, element, outputs, node))
      return
    case 'string':
    case 'function':
      reject(node, 'non-numeric value', `${value.kind} output`)
  }
}

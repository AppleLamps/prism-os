// Three runtime atoms, one direct read at an integer index, plus compile-time
// expansions that lower into those.
//
// This file is a copy of the repo root numeric-ui-core.ts (commit 8c5c4af) with
// these additions, described in index-read's README, which stays at
// https://github.com/chenglou/handwired/blob/exploration-2026-09/lab/ui-exploration/index-read/README.md.
// This copy moved from index-read into lab/ui-exploration/pixel-output on
// September 16, 2026, when index-read was removed. The additions:
// - Circuit.indexRead / emitIndexRead: an instruction that reads
//   candidates[floor(index)] directly, in the reference evaluator and in the
//   tensor executor.
// - A compile pass that recognizes a declared one-hot group built from relu
//   differences of one index wire, and resolves that group's gather reads from
//   the index wire instead of from the N bits, so the one-hot leaves the
//   compiled program.
// - Exact-bit provenance through products, complements, selects and sums
//   (assumeBit plus isProvenBit), and compile-time families of exact bits that
//   let masked reads lower to gathers without a declared group.
// - Candidate tables at contiguous packed positions store one base position
//   instead of one index per candidate.
export type Wire = number

export type Terms = readonly (readonly [wire: Wire, coefficient: number])[]

type AtomKind = 'affine' | 'reglu' | 'boolean' | 'index'

type Macro =
  | {kind: 'multiply', left: Wire, right: Wire}
  | {kind: 'select', gate: Wire, off: Wire, on: Wire}

// What an index read returns when floor(index) is outside 0..count-1: 'clamp'
// reads the nearest end of the table, 'zero' reads +0.
export type OutOfRange = 'clamp' | 'zero'

type IndexRead = {
  candidates: readonly Wire[]
  below: OutOfRange
  above: OutOfRange
}

type Operation = {
  kind: AtomKind
  leftTerms: Terms
  leftBias: number
  // For an index read, gateTerms and gateBias hold the index affine form.
  gateTerms: Terms
  gateBias: number
  depth: number
  preserveRounding?: true
  macro?: Macro
  indexRead?: IndexRead
  // An affine's terms and bias as the caller wrote them, after merging
  // duplicate wires and folding constants, but before small affine producers
  // were composed in. Provenance checks read these to see which wires a small
  // sum was built from.
  authored?: {terms: Terms, bias: number}
}

type NumericRange = {
  minimum: number
  maximum: number
}

type UnsignedIndexArray = Uint8Array | Uint16Array | Uint32Array

// A declared invariant over a set of wires: every member is exactly 0 or 1 and
// their sum is exactly 1. With allowAllZero the all-zero state is also legal
// (emitFirstActive produces that state when its gate is inactive). Like
// assumeRange, the declaration is a contract the builder or trainer promises;
// the compiler uses it to lower one-hot-masked sums to gather reads, and
// validateOneHotGroups can check evaluated values against it in tests.
type OneHotGroup = {
  members: readonly Wire[]
  allowAllZero: boolean
}

// One resolved group index inside a tensor layer, computed once per group per
// evaluation and shared by every read of the group. A bit compute takes the dot
// of the packed one-hot bits with 0..N-1 (exact for 0/1 bits summing to at most
// one). An index compute (indexPosition >= 0) instead floors one packed value,
// the integer the one-hot was built from, and adds indexOffset; out-of-range
// positions clamp or give mass 0, matching how the one-hot was built.
type TensorGatherCompute = {
  slot: number
  bitPositions: UnsignedIndexArray
  indexPosition: number
  indexOffset: number
  indexCount: number
  belowZero: boolean
  aboveZero: boolean
}

// One lowered masked sum: instead of dense rows over N products, the executor
// looks up the packed position of the selected candidate and adds that single
// value onto the row's bias. Groups that allow the all-zero state multiply the
// gathered value by the group mass first, so an inactive group contributes 0.
// When candidatePositions is empty, candidate k lives at
// candidateBase + k * candidateStride.
type TensorGatherRead = {
  row: number
  slot: number
  masked: boolean
  candidateCount: number
  candidateBase: number
  candidateStride: number
  candidatePositions: UnsignedIndexArray
}

// One index read instruction. Its index form is an extra projection row of the
// layer (after the gate rows); the executor floors that row's value and copies
// the selected candidate's packed value into the output row.
type TensorIndexRead = {
  row: number
  indexRow: number
  belowZero: boolean
  aboveZero: boolean
  candidateCount: number
  candidateBase: number
  candidateStride: number
  candidatePositions: UnsignedIndexArray
}

type TensorLayer = {
  inputIndices: UnsignedIndexArray
  inputSize: number
  outputSize: number
  bias: Float32Array
  gateRows: UnsignedIndexArray
  booleanRows: UnsignedIndexArray
  rowOffsets: UnsignedIndexArray
  columns: UnsignedIndexArray
  weights: Float32Array
  gatherComputes: TensorGatherCompute[]
  gatherReads: TensorGatherRead[]
  indexReads: TensorIndexRead[]
}

type TensorProgram = {
  layers: TensorLayer[]
  roots: UnsignedIndexArray
  sourceSize: number
  valueCount: number
  wireOrder: UnsignedIndexArray
  width: number
  gatherSlotCount: number
}

type TensorWorkspace = {
  packedValues: Float32Array
  input: Float32Array
  projection: Float32Array
  gatherIndices: Int32Array
  gatherMasses: Float32Array
}

// A recognized one-hot-masked sum, keyed by its operation index: the affine's
// terms are products of the group's bits against these candidate value wires,
// ordered by group position. groupIndex points into GatherPlanning.groups.
type GatherPlan = {
  groupIndex: number
  candidateWires: readonly Wire[]
}

// A one-hot group whose members are relu-difference indicators of one wire:
// member p is 1 exactly when floor(value of indexWire) + offset === p. below
// and above say what the construction does outside the table.
type IndexResolution = {
  indexWire: Wire
  offset: number
  below: OutOfRange
  above: OutOfRange
}

// The groups gather lowering may use during one compile: every declared group,
// then families of exact bits inferred for this compile only.
type PlanningGroup = {
  members: readonly Wire[]
  allowAllZero: boolean
  inferred: boolean
  resolution?: IndexResolution
}

type GatherPlanning = {
  groups: PlanningGroup[]
  plans: Map<number, GatherPlan>
}

export type CompileOptions = {
  // Resolve relu-difference one-hot groups from their index wire.
  lowerIndexOneHots?: boolean
  // Let masked sums over inferred families of exact bits lower to gathers.
  inferBitFamilies?: boolean
  // Also treat select macros with a proven-bit gate as masked reads over
  // {gate, 1 - gate}. Off by default: a select is already a small expression.
  lowerSelects?: boolean
  // Place each live operation at one plus the depth of what it actually reads
  // after lowering, instead of its build-time depth. A lowered read no longer
  // waits for the products it replaced, so everything downstream can move up.
  // On by default; the shared runtime uses build-time depths.
  recomputeDepths?: boolean
}

export class Circuit {
  sourceSize: number
  operations: Operation[]
  depths: number[]
  constants: (number | undefined)[]
  expressionWires: Map<string, Wire>
  ranges: NumericRange[]
  oneHotGroups: OneHotGroup[]
  declaredBits: Set<Wire>
  sourceBits: Wire[]
  tensorProgram: TensorProgram | null
  groupMembershipCache: {groupCount: number, groupsByWire: Map<Wire, number[]>} | null

  constructor(sourceSize: number) {
    this.sourceSize = sourceSize
    this.operations = []
    this.depths = Array<number>(sourceSize).fill(0)
    this.constants = Array<number | undefined>(sourceSize).fill(undefined)
    this.expressionWires = new Map()
    this.ranges = Array.from({length: sourceSize}, unknownRange)
    this.oneHotGroups = []
    this.declaredBits = new Set()
    this.sourceBits = []
    this.tensorProgram = null
    this.groupMembershipCache = null
  }

  // Declare that a wire holds exactly 0 or 1. Source cells declared this way
  // are checked on every evaluation, next to their ranges. For a computed wire
  // the declaration is the caller's promise, like assumeOneHot.
  assumeBit(wire: Wire) {
    this.assumeRange(wire, 0, 1)
    if (this.declaredBits.has(wire)) return
    this.declaredBits.add(wire)
    if (wire < this.sourceSize) this.sourceBits.push(wire)
    this.tensorProgram = null
  }

  // Read candidates[floor(index)] directly. Outside 0..candidates.length-1 the
  // read clamps to the nearest end or reads +0, per outOfRange; a NaN index
  // reads NaN. Candidates may repeat, may be infinite, and need no range. The
  // promise that makes this equal to a relu one-hot plus a masked sum is that
  // the index holds an exact integer (see validateIndexReads).
  indexRead(index: Wire, candidates: readonly Wire[], options: {outOfRange?: OutOfRange} = {}): Wire {
    assertWire(index, this.sourceSize + this.operations.length)
    const outOfRange = options.outOfRange ?? 'clamp'
    return this.indexReadAffine([[index, 1]], 0, candidates, outOfRange, outOfRange)
  }

  // The same instruction with the index written as an affine form, e.g.
  // [[firstRow, 1]] with bias 3 for the fourth visible row. Small affine
  // producers compose into the form, as they do into a reglu gate.
  indexReadAffine(
    indexTerms: Terms,
    indexBias: number,
    candidates: readonly Wire[],
    below: OutOfRange,
    above: OutOfRange,
  ): Wire {
    invariant(candidates.length > 0, 'an index read needs at least one candidate')
    const width = this.sourceSize + this.operations.length
    for (const candidate of candidates) assertWire(candidate, width)
    for (const [wire] of indexTerms) assertWire(wire, width)
    invariant(Number.isFinite(indexBias), 'index bias must be finite')
    let [terms, bias] = foldConstantTerms(normalizeTerms(indexTerms), indexBias, this.constants)
    ;[terms, bias] = composeAffineTerms(terms, bias, this.sourceSize, this.operations)
    if (terms.length === 0) {
      // A constant index selects its candidate at build time.
      const position = resolveIndexPosition(
        Math.fround(bias),
        candidates.length,
        below === 'zero',
        above === 'zero',
      )
      return position >= 0 ? candidates[position]! : this.affine([], 0)
    }
    const expressionKey = `${serializeExpression('index', [], 0, terms, bias)}|${below},${above}|${candidates.join(',')}`
    const existingWire = this.expressionWires.get(expressionKey)
    if (existingWire !== undefined) return existingWire
    const wire = width
    let depth = 0
    for (const [dependency] of terms) depth = Math.max(depth, this.depths[dependency]!)
    for (const candidate of candidates) depth = Math.max(depth, this.depths[candidate]!)
    this.operations.push({
      kind: 'index',
      leftTerms: [],
      leftBias: 0,
      gateTerms: terms,
      gateBias: bias,
      depth: depth + 1,
      indexRead: {candidates: [...candidates], below, above},
    })
    this.depths.push(depth + 1)
    this.constants.push(undefined)
    this.ranges.push(indexReadRange(
      evaluateAffineRange(terms, bias, this.ranges),
      candidates,
      below,
      above,
      this.ranges,
    ))
    this.expressionWires.set(expressionKey, wire)
    this.tensorProgram = null
    return wire
  }

  assumeRange(wire: Wire, minimum: number, maximum: number) {
    assertWire(wire, this.sourceSize + this.operations.length)
    invariant(minimum <= maximum, 'numeric range is inverted')
    const current = this.ranges[wire]!
    const narrowed = {
      minimum: Math.max(current.minimum, minimum),
      maximum: Math.min(current.maximum, maximum),
    }
    invariant(narrowed.minimum <= narrowed.maximum, 'numeric range contradicts known bounds')
    this.ranges[wire] = narrowed
  }

  // Declare that these wires form an exact one-hot: each is exactly 0 or 1 and
  // exactly one of them is 1 (with allowAllZero, all zeros is also legal). The
  // declaration also narrows every member's range to 0..1. emitArgmax declares
  // its selection automatically (the tournament routes the unit down exactly
  // one path regardless of the scores); emitFirstActive declares its selection
  // only when its gate and candidates are provably exact bits, because
  // fractional scores are legal inputs there and break the property.
  // Hand-declared groups (e.g. a focus one-hot stored in the source table) are
  // the caller's promise, checkable with validateOneHotGroups.
  assumeOneHot(members: readonly Wire[], allowAllZero = false) {
    invariant(members.length > 0, 'a one-hot group needs at least one member')
    const seen = new Set<Wire>()
    for (const member of members) {
      assertWire(member, this.sourceSize + this.operations.length)
      invariant(!seen.has(member), 'one-hot group members must be distinct wires')
      seen.add(member)
      this.assumeRange(member, 0, 1)
    }
    this.oneHotGroups.push({members: [...members], allowAllZero})
    this.tensorProgram = null
  }

  isNonNegative(wire: Wire) {
    return this.ranges[wire]!.minimum >= 0
  }

  affine(terms: Terms, bias = 0): Wire {
    return this.append('affine', terms, bias, [], 0)
  }

  // Keep this evaluation, term order, and input wires intact, including constants.
  roundAffine(terms: Terms, bias = 0): Wire {
    return this.append('affine', terms, bias, [], 0, {preserveRounding: true})
  }

  multiply(left: Wire, right: Wire): Wire {
    const options = {preserveRounding: true, macro: {kind: 'multiply', left, right}} as const
    if (this.isNonNegative(right)) {
      return this.append('reglu', [[left, 1]], 0, [[right, 1]], 0, options)
    }
    if (this.isNonNegative(left)) {
      return this.append('reglu', [[right, 1]], 0, [[left, 1]], 0, options)
    }
    const positive = this.append('reglu', [[left, 1]], 0, [[right, 1]], 0, {preserveRounding: true})
    const negative = this.append('reglu', [[left, 1]], 0, [[right, -1]], 0, {preserveRounding: true})
    return this.append('affine', [[positive, 1], [negative, -1]], 0, [], 0, options)
  }

  select(gate: Wire, off: Wire, on: Wire): Wire {
    const complement = this.roundAffine([[gate, -1]], 1)
    const selectedOn = this.multiply(gate, on)
    const selectedOff = this.multiply(complement, off)
    return this.append('affine', [[selectedOn, 1], [selectedOff, 1]], 0, [], 0, {
      preserveRounding: true,
      macro: {kind: 'select', gate, off, on},
    })
  }

  reglu(leftTerms: Terms, leftBias: number, gateTerms: Terms, gateBias: number): Wire {
    return this.append('reglu', leftTerms, leftBias, gateTerms, gateBias)
  }

  boolean(value: Wire): Wire {
    const range = this.ranges[value]!
    invariant(range.minimum >= 0 && range.maximum <= 1, 'boolean input must be within zero and one')
    return this.append('boolean', [[value, 1]], 0, [], 0)
  }

  append(
    kind: AtomKind,
    leftTerms: Terms,
    leftBias: number,
    gateTerms: Terms,
    gateBias: number,
    options: {preserveRounding?: true, macro?: Macro} = {},
  ): Wire {
    invariant(kind !== 'index', 'index reads are built with indexReadAffine')
    let authored: {terms: Terms, bias: number} | undefined
    if (options.preserveRounding) {
      leftTerms = leftTerms.map(([wire, coefficient]) => [wire, coefficient])
      gateTerms = gateTerms.map(([wire, coefficient]) => [wire, coefficient])
      if (kind === 'affine') authored = {terms: leftTerms, bias: leftBias}
    } else {
      ;[leftTerms, leftBias] = foldConstantTerms(normalizeTerms(leftTerms), leftBias, this.constants)
      ;[gateTerms, gateBias] = foldConstantTerms(normalizeTerms(gateTerms), gateBias, this.constants)
      if (kind === 'affine') authored = {terms: leftTerms, bias: leftBias}
      const initialAlias = kind === 'affine' ? identityWire(leftTerms, leftBias) : undefined
      if (initialAlias !== undefined) return initialAlias
      ;[leftTerms, leftBias] = composeAffineTerms(
        leftTerms,
        leftBias,
        this.sourceSize,
        this.operations,
      )
      ;[gateTerms, gateBias] = composeAffineTerms(
        gateTerms,
        gateBias,
        this.sourceSize,
        this.operations,
      )
      if (kind === 'reglu' && gateTerms.length === 0) {
        const gate = Math.max(0, gateBias)
        kind = 'affine'
        leftTerms = gate === 0
          ? []
          : leftTerms.map(([wire, coefficient]) => [wire, coefficient * gate])
        leftBias *= gate
        gateBias = 0
      } else if (kind === 'reglu' && leftTerms.length === 0 && leftBias === 0) {
        kind = 'affine'
        gateTerms = []
        gateBias = 0
      }
      const composedAlias = kind === 'affine' ? identityWire(leftTerms, leftBias) : undefined
      if (composedAlias !== undefined) return composedAlias
    }
    const expressionKey = serializeExpression(kind, leftTerms, leftBias, gateTerms, gateBias)
      + (options.preserveRounding ? '|round' : '')
      + (options.macro === undefined ? '' : `|${JSON.stringify(options.macro)}`)
    const existingWire = this.expressionWires.get(expressionKey)
    if (existingWire !== undefined) return existingWire
    const wire = this.sourceSize + this.operations.length
    const dependencies = kind === 'reglu' ? [...leftTerms, ...gateTerms] : leftTerms
    let depth = 0
    for (const [dependency] of dependencies) depth = Math.max(depth, this.depths[dependency]!)
    this.operations.push({
      kind,
      leftTerms,
      leftBias,
      gateTerms,
      gateBias,
      depth: depth + 1,
      ...options,
      ...(authored === undefined || kind !== 'affine' ? {} : {authored}),
    })
    this.depths.push(depth + 1)
    this.constants.push(!options.preserveRounding && kind === 'affine' && leftTerms.length === 0 ? leftBias : undefined)
    const leftRange = evaluateAffineRange(leftTerms, leftBias, this.ranges)
    this.ranges.push(
      kind === 'affine'
        ? leftRange
        : kind === 'reglu'
          ? multiplyByReluRange(leftRange, evaluateAffineRange(gateTerms, gateBias, this.ranges))
          : {minimum: 0, maximum: 1},
    )
    this.expressionWires.set(expressionKey, wire)
    this.tensorProgram = null
    return wire
  }

  evaluateReference(source: Float32Array): Float32Array {
    this.validateSourceRanges(source)
    return evaluateOperationStream(source, this)
  }

  backpropagateReference(
    values: Float32Array,
    outputGradients: Float32Array,
    options: {
      booleanGradient?: 'reject' | 'straight-through'
      indexGradient?: 'reject' | 'zero' | 'backward-difference'
    } = {},
  ): Float32Array {
    const width = this.sourceSize + this.operations.length
    invariant(values.length === width, 'forward values have the wrong length')
    invariant(outputGradients.length === width, 'output gradients have the wrong length')
    const gradients = new Float32Array(outputGradients)
    // Differentiate FP32 arithmetic as real-valued; ReLU uses zero slope at its corner.
    for (let operationIndex = this.operations.length - 1; operationIndex >= 0; operationIndex--) {
      const operation = this.operations[operationIndex]!
      const outputWire = this.sourceSize + operationIndex
      const outputGradient = gradients[outputWire]!
      if (outputGradient === 0) continue
      const macro = operation.macro
      if (macro?.kind === 'multiply') {
        accumulateTermGradients(gradients, [[macro.left, values[macro.right]!]], outputGradient)
        accumulateTermGradients(gradients, [[macro.right, values[macro.left]!]], outputGradient)
        continue
      }
      if (macro?.kind === 'select') {
        const gate = values[macro.gate]!
        accumulateTermGradients(gradients, [[macro.off, 1 - gate], [macro.on, gate]], outputGradient)
        accumulateTermGradients(gradients, [[macro.gate, values[macro.on]! - values[macro.off]!]], outputGradient)
        continue
      }
      if (operation.kind === 'index') {
        // The selected candidate receives the output gradient. The index is a
        // step function, so its derivative is zero between integers and
        // undefined at them; the caller picks what to propagate.
        const read = operation.indexRead!
        const count = read.candidates.length
        const belowZero = read.below === 'zero'
        const aboveZero = read.above === 'zero'
        const indexValue = evaluateTerms(values, operation.gateTerms, operation.gateBias)
        const position = resolveIndexPosition(indexValue, count, belowZero, aboveZero)
        if (position >= 0) {
          accumulateTermGradients(gradients, [[read.candidates[position]!, 1]], outputGradient)
        }
        const indexGradient = options.indexGradient ?? 'reject'
        if (indexGradient === 'reject') {
          throw new Error('cannot backpropagate into the index of an index read; pass indexGradient')
        }
        if (indexGradient === 'backward-difference' && Number.isFinite(indexValue)) {
          // What the reference backward pass gives the relu one-hot construction
          // at an integer index i: read(i) - read(i - 1), where read follows the
          // same out-of-range rule as the forward read.
          const readAt = (at: number) => {
            const candidatePosition = resolveIndexPosition(at, count, belowZero, aboveZero)
            return candidatePosition >= 0 ? values[read.candidates[candidatePosition]!]! : candidatePosition === -1 ? 0 : Number.NaN
          }
          const floorIndex = Math.floor(indexValue)
          const difference = readAt(floorIndex) - readAt(floorIndex - 1)
          accumulateTermGradients(gradients, operation.gateTerms, Math.fround(outputGradient * difference))
        }
        continue
      }
      if (operation.kind === 'boolean') {
        if (options.booleanGradient !== 'straight-through') {
          throw new Error('cannot backpropagate through a boolean atom')
        }
        accumulateTermGradients(gradients, operation.leftTerms, outputGradient)
        continue
      }
      if (operation.kind === 'affine') {
        accumulateTermGradients(gradients, operation.leftTerms, outputGradient)
        continue
      }
      const left = evaluateTerms(values, operation.leftTerms, operation.leftBias)
      const gate = evaluateTerms(values, operation.gateTerms, operation.gateBias)
      const activeGate = Math.max(0, gate)
      accumulateTermGradients(
        gradients,
        operation.leftTerms,
        Math.fround(outputGradient * activeGate),
      )
      if (gate > 0) {
        accumulateTermGradients(
          gradients,
          operation.gateTerms,
          Math.fround(outputGradient * left),
        )
      }
    }
    return gradients
  }

  evaluateTensor(source: Float32Array): Float32Array {
    this.validateSourceRanges(source)
    return evaluateTensorProgram(source, this.tensorProgram ??= this.compileTensorProgram())
  }

  // The returned output array is reused and overwritten on the next call.
  createTensorEvaluator(
    roots: readonly Wire[],
    lowerGathers = true,
    options: CompileOptions = {},
  ): (source: Float32Array) => Float32Array {
    const program = this.compileTensorProgram(roots, lowerGathers, options)
    const workspace = createTensorWorkspace(program)
    const positions = roots.map(root => program.wireOrder.indexOf(root))
    const outputs = new Float32Array(roots.length)
    return source => {
      this.validateSourceRanges(source)
      executeTensorProgram(source, program, workspace)
      for (let index = 0; index < positions.length; index++) {
        outputs[index] = workspace.packedValues[positions[index]!]!
      }
      return outputs
    }
  }

  validateSourceRanges(source: Float32Array) {
    invariant(source.length === this.sourceSize, 'source table has the wrong length')
    for (let wire = 0; wire < source.length; wire++) {
      const range = this.ranges[wire]!
      // The message is built only on failure; constructing it eagerly would
      // allocate one string per source cell on every evaluation.
      if (!(source[wire]! >= range.minimum && source[wire]! <= range.maximum)) {
        invariant(false, `source wire ${wire} is outside its assumed range`)
      }
    }
    for (const wire of this.sourceBits) {
      const value = source[wire]!
      if (!(value === 0 || value === 1)) {
        invariant(false, `source wire ${wire} must be exactly 0 or 1`)
      }
    }
  }

  compileTensorProgram(
    roots?: readonly Wire[],
    lowerGathers = true,
    options: CompileOptions = {},
  ): TensorProgram {
    const width = this.sourceSize + this.operations.length
    const normalizedRoots = roots ?? Array.from(
      {length: this.operations.length},
      (_, operationIndex) => this.sourceSize + operationIndex,
    )
    const planning: GatherPlanning = lowerGathers
      ? planGatherLowering(
          this,
          options.lowerIndexOneHots ?? true,
          options.inferBitFamilies ?? true,
          options.lowerSelects ?? false,
        )
      : {groups: [], plans: new Map()}
    const gatherPlans = planning.plans
    const liveOperations = findLiveOperations(
      normalizedRoots,
      this.sourceSize,
      this.operations,
      width,
      gatherPlans,
      planning.groups,
    )
    const effectiveDepths = (options.recomputeDepths ?? true)
      ? computeEffectiveDepths(this, liveOperations, gatherPlans, planning.groups)
      : null
    const operationsByLayer: number[][] = []
    for (let operationIndex = 0; operationIndex < this.operations.length; operationIndex++) {
      if (liveOperations[operationIndex] === 0) continue
      const operation = this.operations[operationIndex]!
      const layerIndex = (effectiveDepths === null ? operation.depth : effectiveDepths[operationIndex]!) - 1
      const operationIndices = operationsByLayer[layerIndex] ??= []
      operationIndices.push(operationIndex)
    }

    const layers: TensorLayer[] = []
    const liveOperationCount = liveOperations.reduce((sum, live) => sum + live, 0)
    const valueCount = this.sourceSize + liveOperationCount
    const wireOrder = new Uint32Array(valueCount)
    const packedIndexByWire = new Int32Array(width)
    packedIndexByWire.fill(-1)
    for (let wire = 0; wire < this.sourceSize; wire++) {
      wireOrder[wire] = wire
      packedIndexByWire[wire] = wire
    }
    let availableValues = this.sourceSize
    const slotByGroup = new Map<number, number>()
    // Reads over the same candidates share one position table.
    const tableCache = new Map<string, UnsignedIndexArray>()
    for (let layerIndex = 0; layerIndex < operationsByLayer.length; layerIndex++) {
      const operationIndices = operationsByLayer[layerIndex]
      if (operationIndices === undefined) continue
      const outputSize = operationIndices.length
      const inputWires = new Set<Wire>()
      for (const operationIndex of operationIndices) {
        // Gather rows read packed values directly by position; they pull
        // nothing through the layer's input gather.
        if (gatherPlans.has(operationIndex)) continue
        const operation = this.operations[operationIndex]!
        for (const [wire] of operation.leftTerms) inputWires.add(wire)
        for (const [wire] of operation.gateTerms) inputWires.add(wire)
      }
      const orderedInputWires = [...inputWires].sort(
        (left, right) => packedIndexByWire[left]! - packedIndexByWire[right]!,
      )
      const inputSize = orderedInputWires.length
      let gateCount = 0
      let booleanCount = 0
      let indexCount = 0
      for (const operationIndex of operationIndices) {
        const kind = this.operations[operationIndex]!.kind
        if (gatherPlans.has(operationIndex)) continue
        if (kind === 'reglu') gateCount++
        else if (kind === 'boolean') booleanCount++
        else if (kind === 'index') indexCount++
      }
      const inputIndices = compactUnsignedIndices(
        orderedInputWires.map(wire => packedIndexByWire[wire]!),
      )
      const inputColumnByWire = new Int32Array(width)
      inputColumnByWire.fill(-1)
      for (let column = 0; column < inputSize; column++) {
        inputColumnByWire[orderedInputWires[column]!] = column
      }
      // Rows: one per output, then one gate row per reglu, then one index row
      // per index read.
      const projectionSize = outputSize + gateCount + indexCount
      const bias = new Float32Array(projectionSize)
      const gateRows: number[] = []
      const booleanRows: number[] = []
      const projectionTerms = Array<Terms>(projectionSize)
      const pendingGatherReads: {row: number, plan: GatherPlan}[] = []
      const pendingIndexReads: {row: number, indexRow: number, read: IndexRead}[] = []
      let gateRow = 0
      let indexRow = 0
      for (let row = 0; row < operationIndices.length; row++) {
        const operationIndex = operationIndices[row]!
        const operation = this.operations[operationIndex]!
        const outputWire = this.sourceSize + operationIndex
        const packedOutput = availableValues + row
        wireOrder[packedOutput] = outputWire
        packedIndexByWire[outputWire] = packedOutput
        bias[row] = operation.leftBias
        const plan = gatherPlans.get(operationIndex)
        if (plan !== undefined) {
          // The lowered sum keeps its bias in the sparse row and stores no
          // weights; the executor adds the gathered value onto the bias.
          projectionTerms[row] = []
          pendingGatherReads.push({row, plan})
          continue
        }
        projectionTerms[row] = operation.leftTerms
        if (operation.kind === 'reglu') {
          const projectionRow = outputSize + gateRow
          bias[projectionRow] = operation.gateBias
          gateRows.push(row)
          projectionTerms[projectionRow] = operation.gateTerms
          gateRow++
        } else if (operation.kind === 'boolean') {
          booleanRows.push(row)
        } else if (operation.kind === 'index') {
          const projectionRow = outputSize + gateCount + indexRow
          bias[projectionRow] = operation.gateBias
          projectionTerms[projectionRow] = operation.gateTerms
          pendingIndexReads.push({row, indexRow: projectionRow, read: operation.indexRead!})
          indexRow++
        }
      }
      const gatherComputes: TensorGatherCompute[] = []
      const gatherReads: TensorGatherRead[] = []
      for (const {row, plan} of pendingGatherReads) {
        const group = planning.groups[plan.groupIndex]!
        const resolution = group.resolution
        let slot = slotByGroup.get(plan.groupIndex)
        if (slot === undefined) {
          // First read of this group: resolve its index here, once, before any
          // of the layer's reads run. Bits, index wires, and candidates sit at
          // strictly earlier depths than the sum they fed, so they are packed.
          slot = slotByGroup.size
          slotByGroup.set(plan.groupIndex, slot)
          if (resolution === undefined) {
            const bitPositions = group.members.map(member => {
              const position = packedIndexByWire[member]!
              invariant(position >= 0 && position < availableValues, 'gather bit is not available')
              return position
            })
            gatherComputes.push({
              slot,
              bitPositions: compactUnsignedIndices(bitPositions),
              indexPosition: -1,
              indexOffset: 0,
              indexCount: group.members.length,
              belowZero: false,
              aboveZero: false,
            })
          } else {
            const position = packedIndexByWire[resolution.indexWire]!
            invariant(position >= 0 && position < availableValues, 'gather index is not available')
            gatherComputes.push({
              slot,
              bitPositions: new Uint8Array(0),
              indexPosition: position,
              indexOffset: resolution.offset,
              indexCount: group.members.length,
              belowZero: resolution.below === 'zero',
              aboveZero: resolution.above === 'zero',
            })
          }
        }
        gatherReads.push({
          row,
          slot,
          masked: group.allowAllZero
            || (resolution !== undefined && (resolution.below === 'zero' || resolution.above === 'zero')),
          ...packCandidateTable(plan.candidateWires, packedIndexByWire, availableValues, tableCache),
        })
      }
      const indexReads: TensorIndexRead[] = pendingIndexReads.map(({row, indexRow: projectionRow, read}) => ({
        row,
        indexRow: projectionRow,
        belowZero: read.below === 'zero',
        aboveZero: read.above === 'zero',
        ...packCandidateTable(read.candidates, packedIndexByWire, availableValues, tableCache),
      }))
      const rowOffsets = Array<number>(projectionSize + 1).fill(0)
      for (let row = 0; row < projectionSize; row++) {
        rowOffsets[row + 1] = rowOffsets[row]! + projectionTerms[row]!.length
      }
      const storedWeightCount = rowOffsets[projectionSize]!
      const columns = Array<number>(storedWeightCount)
      const weights = new Float32Array(storedWeightCount)
      let storedWeight = 0
      for (const terms of projectionTerms) {
        for (const [wire, coefficient] of terms) {
          const column = inputColumnByWire[wire]!
          invariant(column >= 0, 'tensor dependency is not available')
          columns[storedWeight] = column
          weights[storedWeight] = coefficient
          storedWeight++
        }
      }
      layers.push({
        inputIndices,
        inputSize,
        outputSize,
        bias,
        gateRows: compactUnsignedIndices(gateRows),
        booleanRows: compactUnsignedIndices(booleanRows),
        rowOffsets: compactUnsignedIndices(rowOffsets),
        columns: compactUnsignedIndices(columns),
        weights,
        gatherComputes,
        gatherReads,
        indexReads,
      })
      availableValues += outputSize
    }
    return {
      layers,
      roots: compactUnsignedIndices(normalizedRoots),
      sourceSize: this.sourceSize,
      valueCount,
      wireOrder: compactUnsignedIndices(wireOrder),
      width,
      gatherSlotCount: slotByGroup.size,
    }
  }

}

function unknownRange(): NumericRange {
  return {minimum: Number.NEGATIVE_INFINITY, maximum: Number.POSITIVE_INFINITY}
}

function evaluateAffineRange(
  terms: Terms,
  bias: number,
  ranges: readonly NumericRange[],
): NumericRange {
  let minimum = Math.fround(bias)
  let maximum = Math.fround(bias)
  for (const [wire, coefficient] of terms) {
    const range = ranges[wire]!
    const roundedCoefficient = Math.fround(coefficient)
    if (roundedCoefficient > 0) {
      minimum = Math.fround(minimum + Math.fround(roundedCoefficient * range.minimum))
      maximum = Math.fround(maximum + Math.fround(roundedCoefficient * range.maximum))
    } else {
      minimum = Math.fround(minimum + Math.fround(roundedCoefficient * range.maximum))
      maximum = Math.fround(maximum + Math.fround(roundedCoefficient * range.minimum))
    }
    if (Number.isNaN(minimum) || Number.isNaN(maximum)) return unknownRange()
  }
  if (Number.isNaN(minimum) || Number.isNaN(maximum)) return unknownRange()
  return {minimum, maximum}
}

function multiplyByReluRange(left: NumericRange, gate: NumericRange): NumericRange {
  const gateMinimum = Math.max(0, gate.minimum)
  const gateMaximum = Math.max(0, gate.maximum)
  const products = [
    Math.fround(left.minimum * gateMinimum),
    Math.fround(left.minimum * gateMaximum),
    Math.fround(left.maximum * gateMinimum),
    Math.fround(left.maximum * gateMaximum),
  ]
  // Zero times an infinite endpoint can produce NaN. Do not turn it into a
  // finite bound that would later authorize removing an unselected product.
  if (products.some(Number.isNaN)) return unknownRange()
  return {minimum: Math.min(...products), maximum: Math.max(...products)}
}

function findLiveOperations(
  roots: readonly Wire[],
  sourceSize: number,
  operations: readonly Operation[],
  width: number,
  gatherPlans: ReadonlyMap<number, GatherPlan>,
  groups: readonly PlanningGroup[],
): Uint8Array {
  const liveOperations = new Uint8Array(operations.length)
  const pending = [...roots]
  while (pending.length > 0) {
    const wire = pending.pop()!
    assertWire(wire, width)
    if (wire < sourceSize) continue
    const operationIndex = wire - sourceSize
    if (liveOperations[operationIndex] === 1) continue
    liveOperations[operationIndex] = 1
    const plan = gatherPlans.get(operationIndex)
    if (plan !== undefined) {
      // A lowered sum no longer reads its product terms; it reads the group's
      // bits (or, for an index-resolved group, the index wire) and every
      // candidate value directly. Products and bits with no other consumer
      // drop out of the compiled program entirely.
      const group = groups[plan.groupIndex]!
      if (group.resolution === undefined) {
        for (const member of group.members) pending.push(member)
      } else {
        pending.push(group.resolution.indexWire)
      }
      for (const candidate of plan.candidateWires) pending.push(candidate)
      continue
    }
    const operation = operations[operationIndex]!
    for (const [dependency] of operation.leftTerms) pending.push(dependency)
    for (const [dependency] of operation.gateTerms) pending.push(dependency)
    if (operation.indexRead !== undefined) {
      for (const candidate of operation.indexRead.candidates) pending.push(candidate)
    }
  }
  return liveOperations
}

// Depth of every live operation from what it reads after lowering: a lowered
// masked sum reads its group's bits or index wire and its candidates, not its
// products. Operations are appended in dependency order, so one pass suffices.
function computeEffectiveDepths(
  circuit: Circuit,
  liveOperations: Uint8Array,
  gatherPlans: ReadonlyMap<number, GatherPlan>,
  groups: readonly PlanningGroup[],
): Int32Array {
  const depths = new Int32Array(circuit.operations.length)
  const depthOf = (wire: Wire) => (wire < circuit.sourceSize ? 0 : depths[wire - circuit.sourceSize]!)
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    if (liveOperations[operationIndex] === 0) continue
    let depth = 0
    const plan = gatherPlans.get(operationIndex)
    if (plan !== undefined) {
      const group = groups[plan.groupIndex]!
      if (group.resolution === undefined) {
        for (const member of group.members) depth = Math.max(depth, depthOf(member))
      } else {
        depth = depthOf(group.resolution.indexWire)
      }
      for (const candidate of plan.candidateWires) depth = Math.max(depth, depthOf(candidate))
    } else {
      const operation = circuit.operations[operationIndex]!
      for (const [wire] of operation.leftTerms) depth = Math.max(depth, depthOf(wire))
      for (const [wire] of operation.gateTerms) depth = Math.max(depth, depthOf(wire))
      if (operation.indexRead !== undefined) {
        for (const candidate of operation.indexRead.candidates) depth = Math.max(depth, depthOf(candidate))
      }
    }
    depths[operationIndex] = depth + 1
  }
  return depths
}

// Store a candidate table as a base position and a stride when the candidates
// sit at evenly spaced packed positions (e.g. a run of source cells, or a table
// computed in one loop that interleaves with another table), and as one index
// per candidate otherwise. Identical position lists share one array.
function packCandidateTable(
  candidates: readonly Wire[],
  packedIndexByWire: Int32Array,
  availableValues: number,
  tableCache: Map<string, UnsignedIndexArray>,
): {candidateCount: number, candidateBase: number, candidateStride: number, candidatePositions: UnsignedIndexArray} {
  const positions = candidates.map(candidate => {
    const position = packedIndexByWire[candidate]!
    invariant(position >= 0 && position < availableValues, 'gather candidate is not available')
    return position
  })
  const base = positions[0]!
  const stride = positions.length > 1 ? positions[1]! - base : 0
  let evenlySpaced = true
  for (let index = 2; index < positions.length; index++) {
    if (positions[index] !== base + index * stride) {
      evenlySpaced = false
      break
    }
  }
  let candidatePositions: UnsignedIndexArray = new Uint8Array(0)
  if (!evenlySpaced) {
    const key = positions.join(',')
    const shared = tableCache.get(key)
    if (shared === undefined) {
      candidatePositions = compactUnsignedIndices(positions)
      tableCache.set(key, candidatePositions)
    } else {
      candidatePositions = shared
    }
  }
  return {candidateCount: positions.length, candidateBase: base, candidateStride: stride, candidatePositions}
}

type MaskedProduct = {
  coefficient: number
  leftWire: Wire
  gateWire: Wire
  gateCoefficient: number
  exactMultiply?: true
}

// Undo the builder's affine composition for one side of a reglu. Small affine
// wires (fewer than affineShareThreshold terms) are inlined into consumers, so
// a product against such a wire stores the wire's expanded definition rather
// than a single reference. The builder's own deduplication map recovers the
// defining wire: an expanded copy serializes to exactly the key under which
// that wire was registered. sign -1 means the side equals the negated wire
// (the negative arm of a mixed-sign multiply stores gate terms scaled by -1).
function resolveAffineSide(
  circuit: Circuit,
  terms: Terms,
  bias: number,
  allowNegated: boolean,
): {wire: Wire, sign: number} | undefined {
  if (bias === 0 && terms.length === 1) {
    const [wire, coefficient] = terms[0]!
    if (coefficient === 1) return {wire, sign: 1}
    if (coefficient === -1 && allowNegated) return {wire, sign: -1}
    // Other coefficients may still be some wire's whole definition; fall
    // through to the deduplication lookup.
  }
  if (terms.length === 0) return undefined
  const direct = circuit.expressionWires.get(
    serializeExpression('affine', terms, bias, [], 0),
  )
  if (direct !== undefined) return {wire: direct, sign: 1}
  if (!allowNegated) return undefined
  const negatedTerms: Terms = terms.map(([wire, coefficient]) => [wire, -coefficient])
  const negated = circuit.expressionWires.get(
    serializeExpression('affine', negatedTerms, -bias, [], 0),
  )
  if (negated !== undefined) return {wire: negated, sign: -1}
  return undefined
}

// Parse one term of a candidate masked sum. A usable product is a reglu whose
// left side is some wire (possibly stored as that wire's inlined definition)
// and whose gate side is a wire or its negation — exactly the shapes
// emitMultiply builds for bit * value across the orientations it picks.
function maskedProductShape(circuit: Circuit, wire: Wire): Omit<MaskedProduct, 'coefficient'> | undefined {
  if (wire < circuit.sourceSize) return undefined
  const operation = circuit.operations[wire - circuit.sourceSize]!
  if (operation.macro?.kind === 'multiply') {
    return {leftWire: operation.macro.left, gateWire: operation.macro.right, gateCoefficient: 1, exactMultiply: true}
  }
  if (operation.kind !== 'reglu') return undefined
  const left = resolveAffineSide(circuit, operation.leftTerms, operation.leftBias, false)
  if (left === undefined) return undefined
  const gate = resolveAffineSide(circuit, operation.gateTerms, operation.gateBias, true)
  if (gate === undefined) return undefined
  return {leftWire: left.wire, gateWire: gate.wire, gateCoefficient: gate.sign}
}

// Recognize dynamic-lookup idioms: an affine whose terms are products of a
// declared one-hot group against value wires, covering every group position
// exactly once. Such a sum accumulates fround(0 * value) = 0 for every
// non-selected position plus the selected value itself, so an indexed read of
// the selected candidate reproduces it bit-for-bit (see the gather tests under
// lab/gather-lowering for the full argument and its adversarial cases).
function planGatherLowering(
  circuit: Circuit,
  lowerIndexOneHots: boolean,
  inferBitFamilies: boolean,
  lowerSelects: boolean,
): GatherPlanning {
  const groups: PlanningGroup[] = circuit.oneHotGroups.map(group => ({
    members: group.members,
    allowAllZero: group.allowAllZero,
    inferred: false,
  }))
  const plans = new Map<number, GatherPlan>()
  if (groups.length === 0 && !inferBitFamilies) return {groups, plans}
  const groupsByWire = groupMembership(circuit)
  const positionsByGroup = groups.map(group =>
    new Map(group.members.map((member, position) => [member, position] as const)))
  const inferredGroupByKey = new Map<string, number>()
  const provenance = createProvenance(circuit)
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    if (operation.kind !== 'affine' || operation.leftTerms.length === 0) continue
    const products: MaskedProduct[] = []
    let parsed = true
    for (const [wire, coefficient] of operation.leftTerms) {
      if (coefficient !== 1 && coefficient !== -1) {
        parsed = false
        break
      }
      const shape = maskedProductShape(circuit, wire)
      if (shape === undefined) {
        parsed = false
        break
      }
      products.push({coefficient, ...shape})
    }
    if (!parsed) continue
    // Every term of a matching sum references the group through its left or
    // gate wire, so the first product's groups are the only ones to try.
    const first = products[0]!
    const candidateGroups = new Set([
      ...groupsByWire.get(first.gateWire) ?? [],
      ...groupsByWire.get(first.leftWire) ?? [],
    ])
    let planned = false
    for (const groupIndex of candidateGroups) {
      const candidateWires = attemptGatherMatch(
        circuit,
        products,
        groups[groupIndex]!,
        positionsByGroup[groupIndex]!,
      )
      if (candidateWires !== null) {
        plans.set(operationIndex, {groupIndex, candidateWires})
        planned = true
        break
      }
    }
    if (planned || !inferBitFamilies || products.length < 2) continue
    if (operation.macro?.kind === 'select' && !lowerSelects) continue
    // No declared group matches. If the masks are a family of exact bits of
    // which at most one can be 1, the sum is still a pure masked read, so the
    // masks become a group for this compile.
    for (const masks of familyMaskChoices(products, provenance)) {
      if (!provenance.isAtMostOneFamily(masks)) continue
      const key = masks.join(',')
      let groupIndex = inferredGroupByKey.get(key)
      if (groupIndex === undefined) {
        groupIndex = groups.length
        groups.push({members: masks, allowAllZero: true, inferred: true})
        positionsByGroup.push(new Map(masks.map((mask, position) => [mask, position] as const)))
        inferredGroupByKey.set(key, groupIndex)
      }
      const candidateWires = attemptGatherMatch(
        circuit,
        products,
        groups[groupIndex]!,
        positionsByGroup[groupIndex]!,
      )
      if (candidateWires !== null) {
        plans.set(operationIndex, {groupIndex, candidateWires})
        break
      }
    }
  }
  if (lowerIndexOneHots) {
    const usedGroups = new Set<number>()
    for (const plan of plans.values()) usedGroups.add(plan.groupIndex)
    for (const groupIndex of usedGroups) {
      const group = groups[groupIndex]!
      if (group.inferred) continue
      const resolution = recognizeIndexOneHot(circuit, group.members)
      if (resolution !== undefined) group.resolution = resolution
    }
  }
  return {groups, plans}
}

// Mask choices for a sum of exact multiplies: the operand that is a proven bit
// in each product, then all left operands, then all right operands.
function familyMaskChoices(products: readonly MaskedProduct[], provenance: Provenance): Wire[][] {
  const choices: Wire[][] = []
  if (!products.every(product => product.exactMultiply === true && product.coefficient === 1)) return choices
  const proven = products.map(product =>
    provenance.isProvenBit(product.leftWire) ? product.leftWire : product.gateWire)
  const lefts = products.map(product => product.leftWire)
  const rights = products.map(product => product.gateWire)
  for (const choice of [proven, lefts, rights]) {
    if (new Set(choice).size !== choice.length) continue
    if (choices.some(existing => existing.every((wire, index) => wire === choice[index]))) continue
    choices.push(choice)
  }
  return choices
}

function groupMembership(circuit: Circuit): Map<Wire, number[]> {
  const cache = circuit.groupMembershipCache
  if (cache !== null && cache.groupCount === circuit.oneHotGroups.length) return cache.groupsByWire
  const groupsByWire = new Map<Wire, number[]>()
  circuit.oneHotGroups.forEach((group, groupIndex) => {
    for (const member of group.members) {
      const memberGroups = groupsByWire.get(member)
      if (memberGroups === undefined) groupsByWire.set(member, [groupIndex])
      else memberGroups.push(groupIndex)
    }
  })
  circuit.groupMembershipCache = {groupCount: circuit.oneHotGroups.length, groupsByWire}
  return groupsByWire
}

type Provenance = {
  isProvenBit: (wire: Wire) => boolean
  isAtMostOneFamily: (wires: readonly Wire[]) => boolean
}

// Proofs about exact bits, from declarations and from how wires were built.
// A proven bit holds exactly 0 or 1 whenever every declared contract holds. An
// at-most-one family is a set of proven bits of which at most one is 1.
function createProvenance(circuit: Circuit): Provenance {
  const groupsByWire = groupMembership(circuit)
  const bitMemo = new Map<Wire, boolean>()
  const familyMemo = new Map<string, boolean>()
  const maximumDepth = 48
  let hitDepthLimit = false

  const operationOf = (wire: Wire) =>
    wire < circuit.sourceSize ? undefined : circuit.operations[wire - circuit.sourceSize]
  const isPinnedTo = (wire: Wire, value: number) => {
    const range = circuit.ranges[wire]!
    return range.minimum === value && range.maximum === value
  }
  // 1 - bit, written either as bias 1 minus the bit, or as a wire pinned to 1
  // minus the bit. Returns the complemented wire.
  const complementedWire = (wire: Wire): Wire | undefined => {
    const operation = operationOf(wire)
    if (operation?.kind !== 'affine' || operation.macro !== undefined) return undefined
    const {terms, bias} = operation.authored ?? {terms: operation.leftTerms, bias: operation.leftBias}
    if (bias === 1 && terms.length === 1 && terms[0]![1] === -1) return terms[0]![0]
    if (bias === 0 && terms.length === 2) {
      const [left, right] = terms as readonly [readonly [Wire, number], readonly [Wire, number]]
      if (left[1] === 1 && right[1] === -1 && isPinnedTo(left[0], 1)) return right[0]
      if (right[1] === 1 && left[1] === -1 && isPinnedTo(right[0], 1)) return left[0]
    }
    return undefined
  }
  // A sum with coefficient 1 and bias 0 over members of declared groups, or a
  // member itself. Returns the member wires.
  const memberExpansion = (wire: Wire): readonly Wire[] | undefined => {
    if (groupsByWire.has(wire)) return [wire]
    const operation = operationOf(wire)
    if (operation?.kind !== 'affine' || operation.macro !== undefined) return undefined
    const {terms, bias} = operation.authored ?? {terms: operation.leftTerms, bias: operation.leftBias}
    if (bias !== 0 || terms.length === 0) return undefined
    const members: Wire[] = []
    for (const [term, coefficient] of terms) {
      if (coefficient !== 1 || !groupsByWire.has(term)) return undefined
      members.push(term)
    }
    return members
  }

  function provenBit(wire: Wire, depth: number): boolean {
    const cached = bitMemo.get(wire)
    if (cached !== undefined) return cached
    if (depth > maximumDepth) {
      hitDepthLimit = true
      return false
    }
    const limitBefore = hitDepthLimit
    hitDepthLimit = false
    const result = computeProvenBit(wire, depth)
    if (result || !hitDepthLimit) bitMemo.set(wire, result)
    hitDepthLimit = hitDepthLimit || limitBefore
    return result
  }

  function computeProvenBit(wire: Wire, depth: number): boolean {
    if (isPinnedTo(wire, 0) || isPinnedTo(wire, 1)) return true
    if (circuit.declaredBits.has(wire) || groupsByWire.has(wire)) return true
    const operation = operationOf(wire)
    if (operation === undefined) return false
    if (operation.kind === 'boolean') return true
    const macro = operation.macro
    if (macro?.kind === 'multiply') {
      // fround(a * max(0, b)) of two exact bits is an exact bit.
      return provenBit(macro.left, depth + 1) && provenBit(macro.right, depth + 1)
    }
    if (macro?.kind === 'select') {
      // gate * on + (1 - gate) * off is exact at a 0/1 gate for finite operands.
      return provenBit(macro.gate, depth + 1)
        && provenBit(macro.off, depth + 1)
        && provenBit(macro.on, depth + 1)
    }
    if (operation.kind !== 'affine' || macro !== undefined) return false
    const complemented = complementedWire(wire)
    if (complemented !== undefined) return provenBit(complemented, depth + 1)
    const {terms, bias} = operation.authored ?? {terms: operation.leftTerms, bias: operation.leftBias}
    if (bias === 0 && terms.length >= 2 && terms.every(([, coefficient]) => coefficient === 1)) {
      // The sum of an at-most-one family is an exact bit.
      return atMostOneFamily(terms.map(([term]) => term), depth + 1)
    }
    return false
  }

  function atMostOneFamily(wires: readonly Wire[], depth: number): boolean {
    // Wires pinned to 0 never break the property, so they may repeat.
    const active = wires.filter(wire => !isPinnedTo(wire, 0))
    if (new Set(active).size !== active.length) return false
    if (active.length === 0) return true
    if (active.length === 1) return provenBit(active[0]!, depth + 1)
    if (depth > maximumDepth) {
      hitDepthLimit = true
      return false
    }
    const key = active.join(',')
    const cached = familyMemo.get(key)
    if (cached !== undefined) return cached
    const limitBefore = hitDepthLimit
    hitDepthLimit = false
    const result = computeFamily(active, depth)
    if (result || !hitDepthLimit) familyMemo.set(key, result)
    hitDepthLimit = hitDepthLimit || limitBefore
    return result
  }

  function computeFamily(wires: readonly Wire[], depth: number): boolean {
    // Disjoint sums of members of one declared group, where a member counts as
    // its own sum.
    const expansions = wires.map(memberExpansion)
    if (expansions.every(expansion => expansion !== undefined)) {
      const allMembers = expansions.flat()
      if (new Set(allMembers).size === allMembers.length) {
        for (const groupIndex of groupsByWire.get(allMembers[0]!) ?? []) {
          if (allMembers.every(member => groupsByWire.get(member)!.includes(groupIndex))) return true
        }
      }
    }
    // {bit, 1 - bit}.
    if (wires.length === 2) {
      const [left, right] = wires as readonly [Wire, Wire]
      if ((complementedWire(right) === left || complementedWire(left) === right) && provenBit(left, depth + 1)) {
        return true
      }
    }
    const operations = wires.map(operationOf)
    // Selects that share one proven gate, over two families.
    const firstMacro = operations[0]?.macro
    if (firstMacro?.kind === 'select') {
      const gate = firstMacro.gate
      const offs: Wire[] = []
      const ons: Wire[] = []
      let shared = true
      for (const operation of operations) {
        const macro = operation?.macro
        if (macro?.kind !== 'select' || macro.gate !== gate) {
          shared = false
          break
        }
        offs.push(macro.off)
        ons.push(macro.on)
      }
      if (shared && provenBit(gate, depth + 1)) {
        return atMostOneFamily(offs, depth + 1) && atMostOneFamily(ons, depth + 1)
      }
    }
    // Products that share one proven bit, over a family.
    if (firstMacro?.kind === 'multiply') {
      for (const shared of [firstMacro.left, firstMacro.right]) {
        const others: Wire[] = []
        let sharesOperand = true
        for (const operation of operations) {
          const macro = operation?.macro
          if (macro?.kind !== 'multiply' || (macro.left !== shared && macro.right !== shared)) {
            sharesOperand = false
            break
          }
          others.push(macro.left === shared ? macro.right : macro.left)
        }
        if (sharesOperand && provenBit(shared, depth + 1) && atMostOneFamily(others, depth + 1)) return true
      }
    }
    return false
  }

  return {
    isProvenBit: wire => provenBit(wire, 0),
    isAtMostOneFamily: wires => atMostOneFamily(wires, 0),
  }
}

type ReluCombination = {
  indexWire: Wire | undefined
  constant: number
  relus: Map<number, number>
  absoluteWeight: number
}

// Expand a wire into constant + sum of weight * relu(indexWire + bias), through
// affine operations (ordinary or preserved) and plain relus. Returns false for
// anything else. The expansion treats FP32 arithmetic as exact, which holds for
// the small integers the recognition below checks.
function accumulateRelus(
  circuit: Circuit,
  wire: Wire,
  scale: number,
  combination: ReluCombination,
  depth: number,
): boolean {
  if (depth > 6 || wire < circuit.sourceSize) return false
  const operation = circuit.operations[wire - circuit.sourceSize]!
  if (operation.macro !== undefined) return false
  if (operation.kind === 'affine') {
    combination.constant += scale * operation.leftBias
    for (const [term, coefficient] of operation.leftTerms) {
      if (!accumulateRelus(circuit, term, scale * coefficient, combination, depth + 1)) return false
    }
    return true
  }
  if (operation.kind === 'reglu' && operation.leftTerms.length === 0 && operation.gateTerms.length === 1) {
    const [gateWire, gateCoefficient] = operation.gateTerms[0]!
    if (gateCoefficient !== 1) return false
    if (combination.indexWire === undefined) combination.indexWire = gateWire
    else if (combination.indexWire !== gateWire) return false
    const weight = scale * operation.leftBias
    combination.relus.set(operation.gateBias, (combination.relus.get(operation.gateBias) ?? 0) + weight)
    combination.absoluteWeight += Math.abs(weight)
    return true
  }
  return false
}

// Recognize a declared one-hot group whose members are indicators of one index
// wire x built from relus, e.g. [x >= j] = relu(x - j + 1) - relu(x - j) and
// member j = [x >= j] - [x >= j + 1]. Each member must expand to integer
// weights over relu(x + integer bias); its value at every integer x must be
// exactly 0 or 1; and member p must be 1 exactly at x = low + p, where the first
// member may also be 1 for every x below low (the table clamps below) and the
// last member for every x above (the table clamps above). The index wire's
// declared range must sit within ±2^21 so every relu value is an exact integer.
// Given the declared one-hot contract, x then holds a value whose floor picks
// the same member the dense construction picks.
function recognizeIndexOneHot(circuit: Circuit, members: readonly Wire[]): IndexResolution | undefined {
  const exactLimit = 2 ** 21
  let indexWire: Wire | undefined
  type Indicator = {ones: Set<number>, leftTail: number, rightTail: number, windowStart: number, windowEnd: number}
  const indicators: Indicator[] = []
  for (const member of members) {
    const combination: ReluCombination = {indexWire: undefined, constant: 0, relus: new Map(), absoluteWeight: 0}
    if (!accumulateRelus(circuit, member, 1, combination, 0)) return undefined
    if (combination.indexWire === undefined) return undefined
    if (indexWire === undefined) indexWire = combination.indexWire
    else if (indexWire !== combination.indexWire) return undefined
    if (combination.absoluteWeight > 4 || !(combination.constant === 0 || combination.constant === 1)) return undefined
    let slope = 0
    let rightTail = combination.constant
    let windowStart = Number.POSITIVE_INFINITY
    let windowEnd = Number.NEGATIVE_INFINITY
    for (const [bias, weight] of combination.relus) {
      if (!Number.isInteger(bias) || Math.abs(bias) > exactLimit || !Number.isInteger(weight)) return undefined
      slope += weight
      rightTail += weight * bias
      windowStart = Math.min(windowStart, -bias - 1)
      windowEnd = Math.max(windowEnd, -bias + 1)
    }
    if (slope !== 0 || !(rightTail === 0 || rightTail === 1)) return undefined
    const ones = new Set<number>()
    for (let at = windowStart; at <= windowEnd; at++) {
      let value = combination.constant
      for (const [bias, weight] of combination.relus) value += weight * Math.max(0, at + bias)
      if (value === 1) ones.add(at)
      else if (value !== 0) return undefined
    }
    indicators.push({ones, leftTail: combination.constant, rightTail, windowStart, windowEnd})
  }
  if (indexWire === undefined) return undefined
  const range = circuit.ranges[indexWire]!
  if (!(range.minimum >= -exactLimit && range.maximum <= exactLimit)) return undefined
  const count = members.length
  const first = indicators[0]!
  const last = indicators[count - 1]!
  const below: OutOfRange = first.leftTail === 1 ? 'clamp' : 'zero'
  const above: OutOfRange = last.rightTail === 1 ? 'clamp' : 'zero'
  let low: number
  if (below === 'clamp') {
    // The first member's ones run from the window start up to low.
    low = first.windowStart
    while (first.ones.has(low + 1)) low++
  } else {
    if (first.ones.size === 0) return undefined
    low = Math.min(...first.ones)
  }
  for (let position = 0; position < count; position++) {
    const indicator = indicators[position]!
    const clampsBelow = position === 0 && below === 'clamp'
    const clampsAbove = position === count - 1 && above === 'clamp'
    if (indicator.leftTail !== (clampsBelow ? 1 : 0) || indicator.rightTail !== (clampsAbove ? 1 : 0)) {
      return undefined
    }
    for (let at = indicator.windowStart; at <= indicator.windowEnd; at++) {
      const expected = at === low + position
        || (clampsBelow && at <= low)
        || (clampsAbove && at >= low + count - 1)
      if (indicator.ones.has(at) !== expected) return undefined
    }
    // The member's one must sit inside its window, where it was checked.
    if (!clampsBelow && !clampsAbove && !indicator.ones.has(low + position)) return undefined
  }
  return {indexWire, offset: -low, below, above}
}

// Lowering requires value wires with finite declared ranges. A wire whose
// range admits Infinity can poison the dense sum to NaN through a
// non-selected product (fround(Infinity * 0) is NaN) while the gather would
// skip that product entirely, so such reads must stay dense.
function hasFiniteRange(circuit: Circuit, wire: Wire): boolean {
  const range = circuit.ranges[wire]!
  return Number.isFinite(Math.fround(range.minimum)) && Number.isFinite(Math.fround(range.maximum))
}

// Try to interpret the parsed products as one complete read of the group:
// every group position must contribute exactly one value wire, and every term
// must be provably equal to that masked read in FP32. Returns the candidate
// value wires ordered by group position, or null when the sum is not a pure
// masked read of this group.
function attemptGatherMatch(
  circuit: Circuit,
  products: readonly MaskedProduct[],
  group: OneHotGroup,
  positionByMember: ReadonlyMap<Wire, number>,
): readonly Wire[] | null {
  // Index the negative arms of mixed-sign multiplies first. For a value with a
  // signed range, emitMultiply emits pos = reglu(bit; value) and
  // neg = reglu(bit; -value) and subtracts them; only the pair together reads
  // the value exactly, so each arm must find its partner.
  const negativeArms = new Map<string, {used: boolean}>()
  for (const product of products) {
    if (
      product.coefficient === -1
      && product.gateCoefficient === -1
      && positionByMember.has(product.leftWire)
      && !positionByMember.has(product.gateWire)
    ) {
      const key = `${product.leftWire}|${product.gateWire}`
      if (negativeArms.has(key)) return null
      negativeArms.set(key, {used: false})
    }
  }
  const optionsByTerm: {position: number, valueWire: Wire}[][] = []
  for (const product of products) {
    const {coefficient, leftWire, gateWire, gateCoefficient} = product
    if (coefficient === 1 && gateCoefficient === 1) {
      const options: {position: number, valueWire: Wire}[] = []
      const gatePosition = positionByMember.get(gateWire)
      // Bit in the gate: fround(value * max(0, bit)) selects any finite value.
      // The value's declared range must be finite on both ends: a range that
      // admits Infinity lets a non-selected product turn into
      // fround(Infinity * 0) = NaN and poison the dense sum, which a gather
      // would not reproduce.
      if (gatePosition !== undefined && hasFiniteRange(circuit, leftWire)) {
        options.push({position: gatePosition, valueWire: leftWire})
      }
      const leftPosition = positionByMember.get(leftWire)
      if (leftPosition !== undefined) {
        const negativeArm = negativeArms.get(`${leftWire}|${gateWire}`)
        if (product.exactMultiply && hasFiniteRange(circuit, gateWire)) {
          options.push({position: leftPosition, valueWire: gateWire})
        } else if (negativeArm !== undefined && !negativeArm.used && hasFiniteRange(circuit, gateWire)) {
          negativeArm.used = true
          options.push({position: leftPosition, valueWire: gateWire})
        } else if (
          circuit.ranges[gateWire]!.minimum >= 0
          && Number.isFinite(circuit.ranges[gateWire]!.maximum)
        ) {
          // Bit on the left: fround(bit * max(0, value)) reads the value only
          // when the relu is the identity, so the value must be non-negative,
          // and finite for the same NaN reason as above.
          options.push({position: leftPosition, valueWire: gateWire})
        }
      }
      if (options.length === 0) return null
      optionsByTerm.push(options)
    } else if (gateCoefficient === -1 && positionByMember.has(product.gateWire)) {
      // A bit behind a negated gate: max(0, -bit) is exactly 0 for a 0/1 bit,
      // so the term contributes a signed zero the sum ignores — unless the
      // left value could be infinite, in which case the reference computes
      // fround(Infinity * 0) = NaN instead of a zero.
      if (!hasFiniteRange(circuit, leftWire)) return null
      continue
    } else if (
      coefficient === -1
      && gateCoefficient === -1
      && positionByMember.has(leftWire)
    ) {
      // The negative arm of a mixed-sign pair, verified as used below.
      continue
    } else {
      return null
    }
  }
  for (const arm of negativeArms.values()) {
    if (!arm.used) return null
  }
  // Assign positions: fixed terms first, then terms whose bit could sit on
  // either side take whichever position is still open.
  const candidateWires = Array<Wire | undefined>(group.members.length)
  const flexibleTerms: {position: number, valueWire: Wire}[][] = []
  for (const options of optionsByTerm) {
    if (options.length === 1) {
      const {position, valueWire} = options[0]!
      if (candidateWires[position] !== undefined) return null
      candidateWires[position] = valueWire
    } else {
      flexibleTerms.push(options)
    }
  }
  for (const options of flexibleTerms) {
    let placed = false
    for (const {position, valueWire} of options) {
      if (candidateWires[position] === undefined) {
        candidateWires[position] = valueWire
        placed = true
        break
      }
    }
    if (!placed) return null
  }
  for (const candidate of candidateWires) {
    if (candidate === undefined) return null
  }
  return candidateWires as Wire[]
}

function serializeExpression(
  kind: AtomKind,
  leftTerms: Terms,
  leftBias: number,
  gateTerms: Terms,
  gateBias: number,
): string {
  const parts: (string | number)[] = [kind, leftBias]
  for (const [wire, coefficient] of leftTerms) parts.push(wire, coefficient)
  parts.push('|', gateBias)
  for (const [wire, coefficient] of gateTerms) parts.push(wire, coefficient)
  return parts.join(',')
}

function identityWire(terms: Terms, bias: number): Wire | undefined {
  if (bias !== 0 || terms.length !== 1 || terms[0]![1] !== 1) return undefined
  return terms[0]![0]
}

// Keep wide sums as explicit wires so every consumer sees the same FP32 rounding
// point. Small affine forms still compose into their consumers.
const affineShareThreshold = 4

function composeAffineTerms(
  terms: Terms,
  bias: number,
  sourceSize: number,
  operations: readonly Operation[],
): [terms: Terms, bias: number] {
  const composedTerms: [wire: Wire, coefficient: number][] = []
  for (const [wire, coefficient] of terms) {
    const operation = wire < sourceSize ? undefined : operations[wire - sourceSize]
    if (
      operation?.kind !== 'affine'
      || operation.preserveRounding === true
      || operation.leftTerms.length >= affineShareThreshold
    ) {
      composedTerms.push([wire, coefficient])
      continue
    }
    bias += coefficient * operation.leftBias
    for (const [dependency, dependencyCoefficient] of operation.leftTerms) {
      composedTerms.push([dependency, coefficient * dependencyCoefficient])
    }
  }
  return [normalizeTerms(composedTerms), bias]
}

function foldConstantTerms(
  terms: Terms,
  bias: number,
  constants: readonly (number | undefined)[],
): [terms: Terms, bias: number] {
  const dynamicTerms: [wire: Wire, coefficient: number][] = []
  for (const [wire, coefficient] of terms) {
    const constant = constants[wire]
    if (constant === undefined) dynamicTerms.push([wire, coefficient])
    else bias += coefficient * constant
  }
  return [dynamicTerms, bias]
}

function normalizeTerms(terms: Terms): Terms {
  const sortedTerms = [...terms].sort(([leftWire], [rightWire]) => leftWire - rightWire)
  const normalizedTerms: [wire: Wire, coefficient: number][] = []
  for (const [wire, coefficient] of sortedTerms) {
    const previous = normalizedTerms.at(-1)
    if (previous?.[0] === wire) previous[1] += coefficient
    else normalizedTerms.push([wire, coefficient])
  }
  return normalizedTerms.filter(([, coefficient]) => coefficient !== 0)
}

function evaluateOperationStream(
  source: Float32Array,
  circuit: Circuit,
): Float32Array {
  invariant(source.length === circuit.sourceSize, 'source table has the wrong length')
  const values = new Float32Array(circuit.sourceSize + circuit.operations.length)
  values.set(source)
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    let value = evaluateTerms(values, operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') {
      value = Math.fround(
        value * Math.max(
          0,
          evaluateTerms(values, operation.gateTerms, operation.gateBias),
        ),
      )
    } else if (operation.kind === 'boolean') {
      value = evaluateBoolean(value)
    } else if (operation.kind === 'index') {
      const read = operation.indexRead!
      const position = resolveIndexPosition(
        evaluateTerms(values, operation.gateTerms, operation.gateBias),
        read.candidates.length,
        read.below === 'zero',
        read.above === 'zero',
      )
      value = position >= 0 ? values[read.candidates[position]!]! : position === -1 ? 0 : Number.NaN
    }
    values[circuit.sourceSize + operationIndex] = value
  }
  return values
}

function evaluateTensorProgram(
  source: Float32Array,
  program: TensorProgram,
): Float32Array {
  const workspace = createTensorWorkspace(program)
  executeTensorProgram(source, program, workspace)
  const values = new Float32Array(program.width)
  for (let packedIndex = 0; packedIndex < program.wireOrder.length; packedIndex++) {
    values[program.wireOrder[packedIndex]!] = workspace.packedValues[packedIndex]!
  }
  return values
}

function createTensorWorkspace(program: TensorProgram): TensorWorkspace {
  let maxProjectionSize = 0
  let maxInputSize = 0
  for (const layer of program.layers) {
    maxProjectionSize = Math.max(maxProjectionSize, layer.bias.length)
    maxInputSize = Math.max(maxInputSize, layer.inputSize)
  }
  return {
    packedValues: new Float32Array(program.valueCount),
    input: new Float32Array(maxInputSize),
    projection: new Float32Array(maxProjectionSize),
    gatherIndices: new Int32Array(program.gatherSlotCount),
    gatherMasses: new Float32Array(program.gatherSlotCount),
  }
}

function executeTensorProgram(
  source: Float32Array,
  program: TensorProgram,
  workspace: TensorWorkspace,
): void {
  invariant(source.length === program.sourceSize, 'source table has the wrong length')
  const {layers} = program
  const {packedValues, input, projection, gatherIndices, gatherMasses} = workspace
  packedValues.set(source)
  let availableValues = source.length
  for (const layer of layers) {
    const {outputSize} = layer
    for (let column = 0; column < layer.inputSize; column++) {
      input[column] = packedValues[layer.inputIndices[column]!]!
    }
    sparseMatmulAddBias(
      projection,
      layer.weights,
      layer.columns,
      layer.rowOffsets,
      input,
      layer.bias,
    )
    if (layer.gatherReads.length > 0) {
      applyGathers(layer, packedValues, projection, gatherIndices, gatherMasses)
    }
    if (layer.indexReads.length > 0) {
      applyIndexReads(layer, packedValues, projection)
    }
    for (let gateRow = 0; gateRow < layer.gateRows.length; gateRow++) {
      const outputRow = layer.gateRows[gateRow]!
      projection[outputRow] = Math.fround(
        projection[outputRow]! * Math.max(0, projection[outputSize + gateRow]!),
      )
    }
    for (const booleanRow of layer.booleanRows) {
      projection[booleanRow] = evaluateBoolean(projection[booleanRow]!)
    }
    packedValues.set(projection.subarray(0, outputSize), availableValues)
    availableValues += outputSize
  }
}

// Kept out of evaluateTensorProgram on purpose: with these loops inlined, the
// engine's top JIT tier fails to optimize the whole evaluation function and
// gather-heavy programs run several times slower on identical work (measured
// 3.6x-5.3x on Bun 1.3 / JavaScriptCore; the reproducible measurement lives in
// lab/gather-lowering/executor-study.ts).
function applyGathers(
  layer: TensorLayer,
  packedValues: Float32Array,
  projection: Float32Array,
  gatherIndices: Int32Array,
  gatherMasses: Float32Array,
) {
  for (const compute of layer.gatherComputes) {
    if (compute.indexPosition >= 0) {
      // The group was built from relus of this integer, so its selected
      // position is the integer itself, shifted, with the group's rule outside
      // the table. Computed in float64, so no rounding is involved.
      const position = resolveIndexPosition(
        packedValues[compute.indexPosition]! + compute.indexOffset,
        compute.indexCount,
        compute.belowZero,
        compute.aboveZero,
      )
      gatherIndices[compute.slot] = Math.max(position, 0)
      gatherMasses[compute.slot] = position >= 0 ? 1 : position === -1 ? 0 : Number.NaN
      continue
    }
    // The dot of exact 0/1 bits with 0..N-1 is an exact small integer, so the
    // index and the group mass are both computed without rounding.
    let index = 0
    let mass = 0
    for (let position = 0; position < compute.bitPositions.length; position++) {
      const bit = packedValues[compute.bitPositions[position]!]!
      index += position * bit
      mass += bit
    }
    gatherIndices[compute.slot] = index
    gatherMasses[compute.slot] = mass
  }
  for (const read of layer.gatherReads) {
    // Clamp so a violated one-hot contract reads a wrong value instead of
    // reading out of bounds; an exact contract makes the clamp a no-op.
    const limit = read.candidateCount - 1
    const index = Math.min(Math.max(gatherIndices[read.slot]!, 0), limit)
    let contribution = packedValues[
      read.candidatePositions.length === 0
        ? read.candidateBase + index * read.candidateStride
        : read.candidatePositions[index]!
    ]!
    if (read.masked) contribution = Math.fround(gatherMasses[read.slot]! * contribution)
    projection[read.row] = Math.fround(projection[read.row]! + contribution)
  }
}

// Kept out of executeTensorProgram for the same JIT reason as applyGathers.
function applyIndexReads(
  layer: TensorLayer,
  packedValues: Float32Array,
  projection: Float32Array,
) {
  for (const read of layer.indexReads) {
    const position = resolveIndexPosition(
      projection[read.indexRow]!,
      read.candidateCount,
      read.belowZero,
      read.aboveZero,
    )
    if (position >= 0) {
      projection[read.row] = packedValues[
        read.candidatePositions.length === 0
          ? read.candidateBase + position * read.candidateStride
          : read.candidatePositions[position]!
      ]!
    } else {
      projection[read.row] = position === -1 ? 0 : Number.NaN
    }
  }
}

// floor(index) as a table position: 0..count-1 inside the table; outside it the
// nearest end, or -1 where that side reads zero; -2 for a NaN index.
export function resolveIndexPosition(
  index: number,
  count: number,
  belowZero: boolean,
  aboveZero: boolean,
): number {
  if (!(index === index)) return -2
  const position = Math.floor(index)
  if (position < 0) return belowZero ? -1 : 0
  if (position > count - 1) return aboveZero ? -1 : count - 1
  return position
}

// The union of the ranges of every candidate some index in indexRange can reach,
// plus 0 where an out-of-range side reads zero.
function indexReadRange(
  indexRange: NumericRange,
  candidates: readonly Wire[],
  below: OutOfRange,
  above: OutOfRange,
  ranges: readonly NumericRange[],
): NumericRange {
  const count = candidates.length
  const lowestPosition = Math.floor(indexRange.minimum)
  const highestPosition = Math.floor(indexRange.maximum)
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  const include = (range: NumericRange) => {
    minimum = Math.min(minimum, range.minimum)
    maximum = Math.max(maximum, range.maximum)
  }
  const directEnd = Math.min(highestPosition, count - 1)
  for (let position = Math.max(lowestPosition, 0); position <= directEnd; position++) {
    include(ranges[candidates[position]!]!)
  }
  if (lowestPosition < 0) include(below === 'zero' ? {minimum: 0, maximum: 0} : ranges[candidates[0]!]!)
  if (highestPosition > count - 1) {
    include(above === 'zero' ? {minimum: 0, maximum: 0} : ranges[candidates[count - 1]!]!)
  }
  return minimum <= maximum ? {minimum, maximum} : unknownRange()
}

function sparseMatmulAddBias(
  output: Float32Array,
  weights: Float32Array,
  columns: UnsignedIndexArray,
  rowOffsets: UnsignedIndexArray,
  input: Float32Array,
  bias: Float32Array,
) {
  for (let row = 0; row < bias.length; row++) {
    let value = bias[row]!
    for (let index = rowOffsets[row]!; index < rowOffsets[row + 1]!; index++) {
      const product = Math.fround(weights[index]! * input[columns[index]!]!)
      value = Math.fround(value + product)
    }
    output[row] = value
  }
}

function evaluateTerms(
  values: Float32Array,
  terms: Terms,
  bias: number,
): number {
  let value = Math.fround(bias)
  for (const [wire, coefficient] of terms) {
    value = Math.fround(
      value + Math.fround(Math.fround(coefficient) * values[wire]!),
    )
  }
  return value
}

function accumulateTermGradients(
  gradients: Float32Array,
  terms: Terms,
  outputGradient: number,
) {
  for (const [wire, coefficient] of terms) {
    gradients[wire] = Math.fround(
      gradients[wire]! + Math.fround(outputGradient * Math.fround(coefficient)),
    )
  }
}

function evaluateBoolean(value: number): number {
  // FP32 rounds to whole numbers at this size; the odd base makes 0.5 round up.
  const base = 8_388_609
  const score = Math.fround(value)
  const shifted = Math.fround(score + base)
  return Math.fround(shifted - base)
}

function compactUnsignedIndices(values: ArrayLike<number>): UnsignedIndexArray {
  let maximum = 0
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    invariant(Number.isInteger(value) && value >= 0, 'index must be a nonnegative integer')
    maximum = Math.max(maximum, value)
  }
  if (maximum <= 0xff) return Uint8Array.from(values)
  if (maximum <= 0xffff) return Uint16Array.from(values)
  return Uint32Array.from(values)
}

export function emitRelu(circuit: Circuit, value: Wire): Wire {
  return circuit.reglu([], 1, [[value, 1]], 0)
}

export function emitMultiply(circuit: Circuit, a: Wire, b: Wire): Wire {
  return circuit.multiply(a, b)
}

export function emitMaximum(circuit: Circuit, a: Wire, b: Wire): Wire {
  const difference = circuit.roundAffine([[a, 1], [b, -1]])
  const result = circuit.roundAffine([[b, 1], [emitRelu(circuit, difference), 1]])
  const aRange = circuit.ranges[a]!
  const bRange = circuit.ranges[b]!
  // In [0,1], subtraction error is below the midpoint above 1, so the
  // reconstruction cannot round above 1. This does not imply exact max.
  if (aRange.minimum >= 0 && aRange.maximum <= 1 && bRange.minimum >= 0 && bRange.maximum <= 1) {
    circuit.assumeRange(result, 0, 1)
  }
  return result
}

export function emitMinimum(circuit: Circuit, a: Wire, b: Wire): Wire {
  const difference = circuit.roundAffine([[a, 1], [b, -1]])
  const result = circuit.roundAffine([[a, 1], [emitRelu(circuit, difference), -1]])
  // For finite nonnegative operands, rounded max(0, a-b) is within [0,a].
  // The result may undershoot min(a,b), so retain only this weaker bound.
  if (circuit.isNonNegative(a) && circuit.isNonNegative(b) && hasFiniteRange(circuit, a) && hasFiniteRange(circuit, b)) {
    circuit.assumeRange(result, 0, Math.fround(circuit.ranges[a]!.maximum))
  }
  return result
}

export function emitSelect(circuit: Circuit, gate: Wire, off: Wire, on: Wire): Wire {
  return circuit.select(gate, off, on)
}

export function emitSpring(
  circuit: Circuit,
  positionSource: Wire,
  destination: Wire,
  velocitySource: Wire,
  stiffness: Wire,
  damping: Wire,
  timestep: Wire,
  settleDistance: Wire,
  settleSpeed: Wire,
  settleDistanceScale: Wire,
  settleSpeedScale: Wire,
  unit: Wire,
) {
  let position = positionSource
  let velocity = velocitySource
  for (let step = 0; step < 4; step++) {
    const displacement = circuit.affine([[position, 1], [destination, -1]])
    const springForce = emitMultiply(circuit, stiffness, displacement)
    const dampingForce = emitMultiply(circuit, damping, velocity)
    const acceleration = circuit.affine([
      [springForce, -1],
      [dampingForce, -1],
    ])
    velocity = circuit.affine([
      [velocity, 1],
      [emitMultiply(circuit, acceleration, timestep), 1],
    ])
    position = circuit.affine([
      [position, 1],
      [emitMultiply(circuit, velocity, timestep), 1],
    ])
  }

  const distanceAboveThreshold = emitRelu(circuit, circuit.affine([
    [emitAbsolute(circuit, circuit.affine([[position, 1], [destination, -1]])), 1],
    [settleDistance, -1],
  ]))
  const speedAboveThreshold = emitRelu(circuit, circuit.affine([
    [emitAbsolute(circuit, velocity), 1],
    [settleSpeed, -1],
  ]))
  const active = emitClampZeroOne(
    circuit,
    circuit.affine([
      [emitMultiply(circuit, distanceAboveThreshold, settleDistanceScale), 1],
      [emitMultiply(circuit, speedAboveThreshold, settleSpeedScale), 1],
    ]),
    unit,
  )
  return {
    position: emitSelect(circuit, active, destination, position),
    velocity: emitMultiply(circuit, active, velocity),
    active,
  }
}

function emitAbsolute(circuit: Circuit, value: Wire) {
  return circuit.affine([
    [emitRelu(circuit, value), 1],
    [emitRelu(circuit, circuit.affine([[value, -1]])), 1],
  ])
}

function emitClampZeroOne(circuit: Circuit, value: Wire, unit: Wire) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

type WinnerNode =
  | {mass: Wire, item: number}
  | {mass: Wire, left: WinnerNode, right: WinnerNode}

type ArgmaxNode =
  | {score: Wire, item: number}
  | {score: Wire, leftWins: Wire, left: ArgmaxNode, right: ArgmaxNode}

export function emitArgmax(
  circuit: Circuit,
  scores: readonly Wire[],
  unit: Wire,
): {selected: Wire[], score: Wire} {
  invariant(scores.length > 0, 'argmax needs at least one score')
  const unitRange = circuit.ranges[unit]!
  invariant(unitRange.minimum === 1 && unitRange.maximum === 1, 'argmax unit must equal one')
  let level = scores.map((score, item): ArgmaxNode => {
    const range = circuit.ranges[score]!
    invariant(
      range.minimum >= 0 && range.maximum <= 1,
      'argmax scores must be within zero and one',
    )
    return {score, item}
  })
  while (level.length > 1) {
    const next: ArgmaxNode[] = []
    for (let item = 0; item < level.length; item += 2) {
      const left = level[item]!
      const right = level[item + 1]
      if (right === undefined) {
        next.push(left)
        continue
      }
      // One FP32 step above 0.5 makes exact ties choose left without exceeding 1.
      const comparisonBias = 0.5000000596046448
      const comparisonScale = 0.4999999403953552
      const comparison = circuit.affine([
        [left.score, comparisonScale],
        [right.score, -comparisonScale],
      ], comparisonBias)
      circuit.assumeRange(comparison, 0, 1)
      const leftWins = circuit.boolean(comparison)
      next.push({
        score: emitSelect(circuit, leftWins, right.score, left.score),
        leftWins,
        left,
        right,
      })
    }
    level = next
  }

  const root = level[0]!
  const selected = Array<Wire>(scores.length)
  routeArgmax(circuit, root, unit, selected)
  // The tournament routes the unit down exactly one path, so the selection is
  // an exact one-hot by construction; declare it so masked reads of it can
  // lower to gathers.
  circuit.assumeOneHot(selected)
  return {selected, score: root.score}
}

function routeArgmax(
  circuit: Circuit,
  node: ArgmaxNode,
  route: Wire,
  selected: Wire[],
) {
  if ('item' in node) {
    selected[node.item] = route
    return
  }
  const leftRoute = emitMultiply(circuit, route, node.leftWins)
  const rightRoute = circuit.affine([[route, 1], [leftRoute, -1]])
  circuit.assumeRange(rightRoute, 0, 1)
  routeArgmax(circuit, node.left, leftRoute, selected)
  routeArgmax(circuit, node.right, rightRoute, selected)
}

export function emitFirstActive(
  circuit: Circuit,
  active: Wire,
  candidates: readonly Wire[],
): Wire[] {
  if (candidates.length === 0) return []
  const activeRange = circuit.ranges[active]!
  invariant(
    activeRange.minimum >= 0 && activeRange.maximum <= 1,
    'winner selection must be gated within zero and one',
  )
  let level = candidates.map((mass, item): WinnerNode => {
    const range = circuit.ranges[mass]!
    invariant(
      range.minimum >= 0 && range.maximum <= 1,
      'winner candidates must be within zero and one',
    )
    return {mass, item}
  })
  while (level.length > 1) {
    const next: WinnerNode[] = []
    for (let item = 0; item < level.length; item += 2) {
      const left = level[item]!
      const right = level[item + 1]
      next.push(right === undefined
        ? left
        : {
            mass: emitMaximum(circuit, left.mass, right.mass),
            left,
            right,
          })
    }
    level = next
  }

  const root = level[0]!
  const selected = Array<Wire>(candidates.length)
  routeWinner(circuit, root, emitMultiply(circuit, active, root.mass), selected)
  // The selection is one-hot-or-all-zero only when the gate and every
  // candidate are exact bits. Fractional scores in 0..1 are legal inputs here
  // and produce fractional masses (e.g. candidates [0.5, 0] route 0.25 to each
  // output), so declaring unconditionally would be a false contract that
  // gather lowering then miscompiles. Constant candidates can also fold
  // routing wires together, and a group needs distinct members, so those
  // degenerate selections stay undeclared as well.
  const provenance = createProvenance(circuit)
  if (provenance.isProvenBit(active) && candidates.every(candidate => provenance.isProvenBit(candidate))) {
    const distinctMembers = new Set(selected)
    if (distinctMembers.size === selected.length) circuit.assumeOneHot(selected, true)
  }
  return selected
}

// A wire that provably holds an exact 0 or 1: its declared range pins it to
// one of the two values, it was declared with assumeBit, a boolean atom
// produced it, it belongs to a declared one-hot group, or it was built from
// proven bits by a multiply, a select, a complement, or a sum of a family of
// which at most one bit can be 1. A plain 0..1 range is NOT enough — it admits
// fractional values.
export function isProvenBit(circuit: Circuit, wire: Wire): boolean {
  return createProvenance(circuit).isProvenBit(wire)
}

function routeWinner(
  circuit: Circuit,
  node: WinnerNode,
  route: Wire,
  selected: Wire[],
) {
  if ('item' in node) {
    selected[node.item] = route
    return
  }
  const leftRoute = emitMultiply(circuit, route, node.left.mass)
  const rightRoute = circuit.affine([[route, 1], [leftRoute, -1]])
  circuit.assumeRange(rightRoute, 0, 1)
  routeWinner(circuit, node.left, leftRoute, selected)
  routeWinner(circuit, node.right, rightRoute, selected)
}

export function inlineCircuit(
  target: Circuit,
  source: Circuit,
  sourceWires: readonly Wire[],
): Wire[] {
  invariant(sourceWires.length === source.sourceSize, 'inlined source mapping has the wrong length')
  const wireMap = [...sourceWires]
  for (let wire = 0; wire < source.sourceSize; wire++) {
    const range = source.ranges[wire]!
    target.assumeRange(sourceWires[wire]!, range.minimum, range.maximum)
  }
  for (let operationIndex = 0; operationIndex < source.operations.length; operationIndex++) {
    const operation = source.operations[operationIndex]!
    const mapTerms = (terms: Terms): Terms =>
      terms.map(([wire, coefficient]) => [wireMap[wire]!, coefficient])
    let wire: Wire
    if (operation.macro?.kind === 'multiply') {
      wire = target.multiply(wireMap[operation.macro.left]!, wireMap[operation.macro.right]!)
    } else if (operation.macro?.kind === 'select') {
      wire = target.select(wireMap[operation.macro.gate]!, wireMap[operation.macro.off]!, wireMap[operation.macro.on]!)
    } else if (operation.kind === 'reglu') {
      wire = target.append('reglu',
        mapTerms(operation.leftTerms),
        operation.leftBias,
        mapTerms(operation.gateTerms),
        operation.gateBias,
        operation.preserveRounding ? {preserveRounding: true} : {},
      )
    } else if (operation.kind === 'index') {
      const read = operation.indexRead!
      wire = target.indexReadAffine(
        mapTerms(operation.gateTerms),
        operation.gateBias,
        read.candidates.map(candidate => wireMap[candidate]!),
        read.below,
        read.above,
      )
    } else {
      const value = operation.preserveRounding
        ? target.roundAffine(mapTerms(operation.leftTerms), operation.leftBias)
        : target.affine(mapTerms(operation.leftTerms), operation.leftBias)
      wire = operation.kind === 'boolean' ? target.boolean(value) : value
    }
    const sourceWire = source.sourceSize + operationIndex
    const range = source.ranges[sourceWire]!
    target.assumeRange(wire, range.minimum, range.maximum)
    wireMap.push(wire)
  }
  // Declared one-hot groups survive inlining: the property is about runtime
  // values, which the mapped wires still carry.
  for (const group of source.oneHotGroups) {
    target.assumeOneHot(
      group.members.map(member => wireMap[member]!),
      group.allowAllZero,
    )
  }
  for (const wire of source.declaredBits) target.assumeBit(wireMap[wire]!)
  return wireMap
}

export function validateCircuit(circuit: Circuit): number {
  const wireCount = circuit.sourceSize + circuit.operations.length
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    invariant(Number.isFinite(operation.leftBias), 'left bias must be finite')
    invariant(Number.isFinite(operation.gateBias), 'gate bias must be finite')
    validateTerms(operation.leftTerms, circuit.sourceSize + operationIndex)
    validateTerms(operation.gateTerms, circuit.sourceSize + operationIndex)
    if (operation.kind === 'index') {
      const read = operation.indexRead
      invariant(read !== undefined && read.candidates.length > 0, 'index read needs candidates')
      for (const candidate of read.candidates) assertWire(candidate, circuit.sourceSize + operationIndex)
    }
  }
  return wireCount
}

// Check the promise behind every index read against evaluated wire values: the
// index form holds a finite integer, so floor() changes nothing and the read
// equals the relu one-hot construction. Meant for tests; the evaluators never
// pay this cost on their own.
export function validateIndexReads(circuit: Circuit, values: Float32Array) {
  invariant(
    values.length === circuit.sourceSize + circuit.operations.length,
    'index read validation needs the full wire values',
  )
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    if (operation.kind !== 'index') continue
    const index = evaluateTerms(values, operation.gateTerms, operation.gateBias)
    if (!Number.isInteger(index)) {
      invariant(false, `index read wire ${circuit.sourceSize + operationIndex} has a non-integer index ${index}`)
    }
  }
}

export function validateTensorProgram(circuit: Circuit, program: TensorProgram) {
  const {layers, roots, valueCount, wireOrder, width} = program
  invariant(program.sourceSize === circuit.sourceSize, 'tensor source size mismatch')
  invariant(width === circuit.sourceSize + circuit.operations.length, 'tensor width mismatch')
  invariant(valueCount <= width, 'tensor value count exceeds circuit width')
  invariant(wireOrder.length === valueCount, 'tensor wire order size mismatch')
  const seenWires = new Uint8Array(width)
  for (let wire = 0; wire < circuit.sourceSize; wire++) {
    invariant(wireOrder[wire] === wire, 'tensor source order mismatch')
    seenWires[wire] = 1
  }
  const resolvedGatherSlots = new Uint8Array(program.gatherSlotCount)
  let availableValues = circuit.sourceSize
  for (const layer of layers) {
    const {outputSize} = layer
    invariant(outputSize > 0, 'tensor layer must produce at least one value')
    invariant(layer.inputIndices.length === layer.inputSize, 'tensor input index size mismatch')
    for (const inputIndex of layer.inputIndices) {
      invariant(inputIndex < availableValues, 'tensor layer input is not available')
    }
    const gateSize = layer.gateRows.length
    const projectionSize = outputSize + gateSize + layer.indexReads.length
    invariant(layer.bias.length === projectionSize, 'projection bias shape mismatch')
    const seenGateRows = new Uint8Array(outputSize)
    for (const gateRow of layer.gateRows) {
      invariant(gateRow < outputSize, 'gate output row is invalid')
      invariant(seenGateRows[gateRow] === 0, 'gate output row must be unique')
      seenGateRows[gateRow] = 1
    }
    const seenBooleanRows = new Uint8Array(outputSize)
    for (const booleanRow of layer.booleanRows) {
      invariant(booleanRow < outputSize, 'boolean output row is invalid')
      invariant(seenGateRows[booleanRow] === 0, 'boolean output row cannot also be gated')
      invariant(seenBooleanRows[booleanRow] === 0, 'boolean output row must be unique')
      seenBooleanRows[booleanRow] = 1
    }
    invariant(layer.rowOffsets.length === projectionSize + 1, 'sparse row offset shape mismatch')
    invariant(layer.rowOffsets[0] === 0, 'sparse row offsets must start at zero')
    invariant(layer.columns.length === layer.weights.length, 'sparse column shape mismatch')
    invariant(
      layer.rowOffsets[projectionSize] === layer.weights.length,
      'sparse row offsets must end at the stored weight count',
    )
    for (let row = 0; row < projectionSize; row++) {
      invariant(
        layer.rowOffsets[row]! <= layer.rowOffsets[row + 1]!,
        'sparse row offsets must be ordered',
      )
    }
    for (const column of layer.columns) {
      invariant(column < layer.inputSize, 'sparse matrix column is invalid')
    }
    for (const compute of layer.gatherComputes) {
      invariant(
        compute.slot >= 0 && compute.slot < program.gatherSlotCount,
        'gather slot is invalid',
      )
      invariant(resolvedGatherSlots[compute.slot] === 0, 'gather slot must be resolved exactly once')
      resolvedGatherSlots[compute.slot] = 1
      if (compute.indexPosition >= 0) {
        invariant(compute.bitPositions.length === 0, 'an index compute reads no bits')
        invariant(compute.indexPosition < availableValues, 'gather index is not available')
        invariant(Number.isInteger(compute.indexOffset), 'gather index offset must be an integer')
      } else {
        invariant(compute.bitPositions.length === compute.indexCount, 'gather bit table size mismatch')
      }
      for (const bitPosition of compute.bitPositions) {
        invariant(bitPosition < availableValues, 'gather bit is not available')
      }
    }
    const validateCandidateTable = (read: {
      candidateCount: number
      candidateBase: number
      candidateStride: number
      candidatePositions: UnsignedIndexArray
    }) => {
      invariant(read.candidateCount > 0, 'a read needs at least one candidate')
      if (read.candidatePositions.length === 0) {
        const last = read.candidateBase + (read.candidateCount - 1) * read.candidateStride
        invariant(
          Number.isInteger(read.candidateStride)
            && read.candidateBase >= 0 && read.candidateBase < availableValues
            && last >= 0 && last < availableValues,
          'evenly spaced candidates are not available',
        )
      } else {
        invariant(read.candidatePositions.length === read.candidateCount, 'candidate table size mismatch')
        for (const candidatePosition of read.candidatePositions) {
          invariant(candidatePosition < availableValues, 'gather candidate is not available')
        }
      }
    }
    for (const read of layer.gatherReads) {
      invariant(read.row < outputSize, 'gather output row is invalid')
      invariant(seenGateRows[read.row] === 0, 'gather output row cannot be gated')
      invariant(seenBooleanRows[read.row] === 0, 'gather output row cannot be boolean')
      invariant(
        layer.rowOffsets[read.row] === layer.rowOffsets[read.row + 1],
        'gather output row must store no weights',
      )
      invariant(
        read.slot >= 0 && read.slot < program.gatherSlotCount && resolvedGatherSlots[read.slot] === 1,
        'gather read must follow its slot resolution',
      )
      validateCandidateTable(read)
    }
    const seenIndexRows = new Uint8Array(projectionSize)
    for (const read of layer.indexReads) {
      invariant(read.row < outputSize, 'index read output row is invalid')
      invariant(seenGateRows[read.row] === 0, 'index read output row cannot be gated')
      invariant(seenBooleanRows[read.row] === 0, 'index read output row cannot be boolean')
      invariant(
        layer.rowOffsets[read.row] === layer.rowOffsets[read.row + 1],
        'index read output row must store no weights',
      )
      invariant(
        read.indexRow >= outputSize + gateSize && read.indexRow < projectionSize,
        'index row must follow the gate rows',
      )
      invariant(seenIndexRows[read.indexRow] === 0, 'index row must be unique')
      seenIndexRows[read.indexRow] = 1
      validateCandidateTable(read)
    }
    assertFiniteValues(layer.bias, 'projection bias')
    assertFiniteValues(layer.weights, 'projection matrix')
    for (let row = 0; row < outputSize; row++) {
      const wire = wireOrder[availableValues + row]!
      invariant(wire >= circuit.sourceSize && wire < width, 'tensor output wire is invalid')
      invariant(seenWires[wire] === 0, 'tensor wire must be written exactly once')
      seenWires[wire] = 1
    }
    availableValues += outputSize
  }
  invariant(availableValues === valueCount, 'tensor program output size mismatch')
  for (const resolved of resolvedGatherSlots) {
    invariant(resolved === 1, 'every gather slot must be resolved')
  }
  for (const root of roots) invariant(seenWires[root] === 1, 'every tensor root must be present')
}

// Check every declared one-hot group against evaluated wire values: each
// member is exactly 0 or 1 and the members sum to exactly 1 (or 0 where the
// group allows the all-zero state). Meant for tests and for checking trainer
// writebacks; the evaluators never pay this cost on their own.
export function validateOneHotGroups(circuit: Circuit, values: Float32Array) {
  invariant(
    values.length === circuit.sourceSize + circuit.operations.length,
    'one-hot validation needs the full wire values',
  )
  for (const group of circuit.oneHotGroups) {
    let mass = 0
    for (const member of group.members) {
      const value = values[member]!
      if (!(value === 0 || value === 1)) {
        invariant(false, `one-hot member wire ${member} must be exactly 0 or 1, got ${value}`)
      }
      mass += value
    }
    if (!(mass === 1 || (group.allowAllZero && mass === 0))) {
      invariant(false, `one-hot group must have exactly one active member, got mass ${mass}`)
    }
  }
}

export function validateTensorEvaluation(
  source: Float32Array,
  circuit: Circuit,
  tensorValues: Float32Array,
) {
  const expectedValues = evaluateOperationStream(source, circuit)
  invariant(expectedValues.length === tensorValues.length, 'tensor result width mismatch')
  const program = circuit.tensorProgram ??= circuit.compileTensorProgram()
  for (const wire of program.wireOrder) {
    invariant(
      tensorValues[wire] === expectedValues[wire],
      `tensor wire ${wire} does not match the reference FP32 atom program`,
    )
  }
}

export function assertWire(wire: number, limit: number) {
  invariant(Number.isInteger(wire) && wire >= 0 && wire < limit, 'wire is outside the compiled circuit')
}

export function assertNonNegativeFinite(
  value: number | undefined,
  label: string,
  tolerance = 0,
): asserts value is number {
  invariant(
    value !== undefined && Number.isFinite(value) && value >= -tolerance,
    `${label} must be non-negative and finite, got ${value}`,
  )
}

export function assertUnitInterval(
  value: number | undefined,
  label: string,
  tolerance = 1e-9,
): asserts value is number {
  invariant(
    value !== undefined
      && Number.isFinite(value)
      && value >= -tolerance
      && value <= 1 + tolerance,
    `${label} must be within zero and one, got ${value}`,
  )
}

export function assertFiniteValues(values: Iterable<number>, label: string) {
  for (const value of values) invariant(Number.isFinite(value), `${label} contains a non-finite number`)
}

export function validateWireView(wires: readonly Wire[], size: number, wireCount: number) {
  invariant(wires.length === size, 'output wire view has the wrong length')
  for (const wire of wires) assertWire(wire, wireCount)
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (condition !== true) throw new Error(message)
}

function validateTerms(terms: Terms, wireLimit: number) {
  for (const [wire, coefficient] of terms) {
    assertWire(wire, wireLimit)
    invariant(Number.isFinite(coefficient), 'weight must be finite')
  }
}

// Three runtime atoms, plus compile-time expansions that lower into those atoms.
export type Wire = number

export type Terms = readonly (readonly [wire: Wire, coefficient: number])[]

type AtomKind = 'affine' | 'reglu' | 'boolean'

type Macro =
  | {kind: 'multiply', left: Wire, right: Wire}
  | {kind: 'select', gate: Wire, off: Wire, on: Wire}

type Operation = {
  kind: AtomKind
  leftTerms: Terms
  leftBias: number
  gateTerms: Terms
  gateBias: number
  depth: number
  preserveRounding?: true
  macro?: Macro
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

// One resolved group index inside a tensor layer: the executor reads the packed
// one-hot bits, takes their dot with 0..N-1 (exact for 0/1 bits summing to at
// most one), and stores the resulting index and mass for the layer's gather
// reads. Computed once per group per evaluation, shared by every read.
type TensorGatherCompute = {
  slot: number
  bitPositions: UnsignedIndexArray
}

// One lowered masked sum: instead of dense rows over N products, the executor
// looks up the packed position of the selected candidate and adds that single
// value onto the row's bias. Groups that allow the all-zero state multiply the
// gathered value by the group mass first, so an inactive group contributes 0.
type TensorGatherRead = {
  row: number
  slot: number
  masked: boolean
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
// ordered by group position.
type GatherPlan = {
  groupIndex: number
  candidateWires: readonly Wire[]
}

export class Circuit {
  sourceSize: number
  operations: Operation[]
  depths: number[]
  constants: (number | undefined)[]
  expressionWires: Map<string, Wire>
  ranges: NumericRange[]
  oneHotGroups: OneHotGroup[]
  tensorProgram: TensorProgram | null

  constructor(sourceSize: number) {
    this.sourceSize = sourceSize
    this.operations = []
    this.depths = Array<number>(sourceSize).fill(0)
    this.constants = Array<number | undefined>(sourceSize).fill(undefined)
    this.expressionWires = new Map()
    this.ranges = Array.from({length: sourceSize}, unknownRange)
    this.oneHotGroups = []
    this.tensorProgram = null
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
    if (options.preserveRounding) {
      leftTerms = leftTerms.map(([wire, coefficient]) => [wire, coefficient])
      gateTerms = gateTerms.map(([wire, coefficient]) => [wire, coefficient])
    } else {
      ;[leftTerms, leftBias] = foldConstantTerms(normalizeTerms(leftTerms), leftBias, this.constants)
      ;[gateTerms, gateBias] = foldConstantTerms(normalizeTerms(gateTerms), gateBias, this.constants)
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
    this.operations.push({kind, leftTerms, leftBias, gateTerms, gateBias, depth: depth + 1, ...options})
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
    options: {booleanGradient?: 'reject' | 'straight-through'} = {},
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
  createTensorEvaluator(roots: readonly Wire[]): (source: Float32Array) => Float32Array {
    const program = this.compileTensorProgram(roots)
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
  }

  compileTensorProgram(roots?: readonly Wire[], lowerGathers = true): TensorProgram {
    const width = this.sourceSize + this.operations.length
    const normalizedRoots = roots ?? Array.from(
      {length: this.operations.length},
      (_, operationIndex) => this.sourceSize + operationIndex,
    )
    const gatherPlans = lowerGathers ? planGatherLowering(this) : new Map<number, GatherPlan>()
    const liveOperations = findLiveOperations(
      normalizedRoots,
      this.sourceSize,
      this.operations,
      width,
      gatherPlans,
      this.oneHotGroups,
    )
    const operationsByLayer: number[][] = []
    for (let operationIndex = 0; operationIndex < this.operations.length; operationIndex++) {
      if (liveOperations[operationIndex] === 0) continue
      const operation = this.operations[operationIndex]!
      const layerIndex = operation.depth - 1
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
      for (const operationIndex of operationIndices) {
        const kind = this.operations[operationIndex]!.kind
        if (kind === 'reglu') gateCount++
        else if (kind === 'boolean') booleanCount++
      }
      const inputIndices = compactUnsignedIndices(
        orderedInputWires.map(wire => packedIndexByWire[wire]!),
      )
      const inputColumnByWire = new Int32Array(width)
      inputColumnByWire.fill(-1)
      for (let column = 0; column < inputSize; column++) {
        inputColumnByWire[orderedInputWires[column]!] = column
      }
      const projectionSize = outputSize + gateCount
      const bias = new Float32Array(projectionSize)
      const gateRows: number[] = []
      const booleanRows: number[] = []
      const projectionTerms = Array<Terms>(projectionSize)
      const pendingGatherReads: {row: number, plan: GatherPlan}[] = []
      let gateRow = 0
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
        }
      }
      const gatherComputes: TensorGatherCompute[] = []
      const gatherReads: TensorGatherRead[] = []
      for (const {row, plan} of pendingGatherReads) {
        const group = this.oneHotGroups[plan.groupIndex]!
        let slot = slotByGroup.get(plan.groupIndex)
        if (slot === undefined) {
          // First read of this group: resolve its index here, once, before any
          // of the layer's reads run. Bits and candidates sit at strictly
          // earlier depths than the sum they fed, so they are already packed.
          slot = slotByGroup.size
          slotByGroup.set(plan.groupIndex, slot)
          const bitPositions = group.members.map(member => {
            const position = packedIndexByWire[member]!
            invariant(position >= 0 && position < availableValues, 'gather bit is not available')
            return position
          })
          gatherComputes.push({slot, bitPositions: compactUnsignedIndices(bitPositions)})
        }
        const candidatePositions = plan.candidateWires.map(candidate => {
          const position = packedIndexByWire[candidate]!
          invariant(position >= 0 && position < availableValues, 'gather candidate is not available')
          return position
        })
        gatherReads.push({
          row,
          slot,
          masked: group.allowAllZero,
          candidatePositions: compactUnsignedIndices(candidatePositions),
        })
      }
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
  oneHotGroups: readonly OneHotGroup[],
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
      // bits (for the index) and every candidate value directly. Products with
      // no other consumer drop out of the compiled program entirely.
      for (const member of oneHotGroups[plan.groupIndex]!.members) pending.push(member)
      for (const candidate of plan.candidateWires) pending.push(candidate)
      continue
    }
    const operation = operations[operationIndex]!
    for (const [dependency] of operation.leftTerms) pending.push(dependency)
    for (const [dependency] of operation.gateTerms) pending.push(dependency)
  }
  return liveOperations
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
function planGatherLowering(circuit: Circuit): Map<number, GatherPlan> {
  const plans = new Map<number, GatherPlan>()
  if (circuit.oneHotGroups.length === 0) return plans
  const groupsByWire = new Map<Wire, number[]>()
  const positionsByGroup = circuit.oneHotGroups.map((group, groupIndex) => {
    const positions = new Map<Wire, number>()
    for (let position = 0; position < group.members.length; position++) {
      const member = group.members[position]!
      positions.set(member, position)
      const groups = groupsByWire.get(member)
      if (groups === undefined) groupsByWire.set(member, [groupIndex])
      else groups.push(groupIndex)
    }
    return positions
  })
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
    for (const groupIndex of candidateGroups) {
      const candidateWires = attemptGatherMatch(
        circuit,
        products,
        circuit.oneHotGroups[groupIndex]!,
        positionsByGroup[groupIndex]!,
      )
      if (candidateWires !== null) {
        plans.set(operationIndex, {groupIndex, candidateWires})
        break
      }
    }
  }
  return plans
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
    const limit = read.candidatePositions.length - 1
    const index = Math.min(Math.max(gatherIndices[read.slot]!, 0), limit)
    let contribution = packedValues[read.candidatePositions[index]!]!
    if (read.masked) contribution = Math.fround(gatherMasses[read.slot]! * contribution)
    projection[read.row] = Math.fround(projection[read.row]! + contribution)
  }
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
  if (isProvenBit(circuit, active) && candidates.every(candidate => isProvenBit(circuit, candidate))) {
    const distinctMembers = new Set(selected)
    if (distinctMembers.size === selected.length) circuit.assumeOneHot(selected, true)
  }
  return selected
}

// A wire that provably holds an exact 0 or 1: its declared range pins it to
// one of the two values, a boolean atom produced it, or it belongs to a
// declared one-hot group (whose members are exactly 0 or 1 by contract, in
// all-zero-allowed groups too). A plain 0..1 range is NOT enough — it admits
// fractional values.
function isProvenBit(circuit: Circuit, wire: Wire): boolean {
  const range = circuit.ranges[wire]!
  if (range.minimum === range.maximum && (range.minimum === 0 || range.minimum === 1)) {
    return true
  }
  if (
    wire >= circuit.sourceSize
    && circuit.operations[wire - circuit.sourceSize]!.kind === 'boolean'
  ) {
    return true
  }
  for (const group of circuit.oneHotGroups) {
    if (group.members.includes(wire)) return true
  }
  return false
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
  }
  return wireCount
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
    const projectionSize = outputSize + gateSize
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
      for (const bitPosition of compute.bitPositions) {
        invariant(bitPosition < availableValues, 'gather bit is not available')
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
      invariant(read.candidatePositions.length > 0, 'gather read needs at least one candidate')
      for (const candidatePosition of read.candidatePositions) {
        invariant(candidatePosition < availableValues, 'gather candidate is not available')
      }
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

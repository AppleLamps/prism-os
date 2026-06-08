// Three runtime atoms, plus compile-time expansions that lower into those atoms.
export type Wire = number
export type NumericArray = Float32Array | Float64Array

export type Terms = readonly (readonly [wire: Wire, coefficient: number])[]

type AtomKind = 'affine' | 'reglu' | 'boolean'

type Operation = {
  kind: AtomKind
  leftTerms: Terms
  leftBias: number
  gateTerms: Terms
  gateBias: number
  depth: number
}

type NumericRange = {
  minimum: number
  maximum: number
}

export type TensorLayer = {
  inputIndices: Uint32Array
  inputSize: number
  outputSize: number
  bias: Float32Array
  gateRows: Uint32Array
  booleanRows: Uint32Array
  rowOffsets: Uint32Array
  columns: Uint32Array
  weights: Float32Array
}

export type TensorProgram = {
  layers: TensorLayer[]
  roots: Uint32Array
  sourceSize: number
  valueCount: number
  wireOrder: Uint32Array
  width: number
}

export class Circuit {
  sourceSize: number
  operations: Operation[]
  depths: number[]
  constants: (number | undefined)[]
  expressionWires: Map<string, Wire>
  ranges: NumericRange[]
  tensorProgram: TensorProgram | null

  constructor(sourceSize: number) {
    this.sourceSize = sourceSize
    this.operations = []
    this.depths = Array<number>(sourceSize).fill(0)
    this.constants = Array<number | undefined>(sourceSize).fill(undefined)
    this.expressionWires = new Map()
    this.ranges = Array.from({length: sourceSize}, unknownRange)
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

  isNonNegative(wire: Wire) {
    return this.ranges[wire]!.minimum >= 0
  }

  affine(terms: Terms, bias = 0): Wire {
    return this.append('affine', terms, bias, [], 0)
  }

  reglu(leftTerms: Terms, leftBias: number, gateTerms: Terms, gateBias: number): Wire {
    return this.append('reglu', leftTerms, leftBias, gateTerms, gateBias)
  }

  boolean(value: Wire): Wire {
    const range = this.ranges[value]!
    invariant(range.minimum >= 0 && range.maximum <= 1, 'boolean input must be within zero and one')
    return this.append('boolean', [[value, 1]], 0, [], 0)
  }

  append(kind: AtomKind, leftTerms: Terms, leftBias: number, gateTerms: Terms, gateBias: number): Wire {
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
    const expressionKey = serializeExpression(kind, leftTerms, leftBias, gateTerms, gateBias)
    const existingWire = this.expressionWires.get(expressionKey)
    if (existingWire !== undefined) return existingWire
    const wire = this.sourceSize + this.operations.length
    const dependencies = kind === 'reglu' ? [...leftTerms, ...gateTerms] : leftTerms
    let depth = 0
    for (const [dependency] of dependencies) depth = Math.max(depth, this.depths[dependency]!)
    this.operations.push({kind, leftTerms, leftBias, gateTerms, gateBias, depth: depth + 1})
    this.depths.push(depth + 1)
    this.constants.push(kind === 'affine' && leftTerms.length === 0 ? leftBias : undefined)
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

  evaluateReadable(source: NumericArray): Float64Array {
    this.validateSourceRanges(source)
    return evaluateOperationStream(source, this)
  }

  evaluateTensor(source: NumericArray): Float64Array {
    this.validateSourceRanges(source)
    return evaluateTensorProgram(source, this.tensorProgram ??= this.compileTensorProgram())
  }

  evaluateTensorFloat32(source: NumericArray): Float32Array {
    this.validateSourceRanges(source)
    return evaluateTensorProgramFloat32(source, this.tensorProgram ??= this.compileTensorProgram())
  }

  validateSourceRanges(source: NumericArray) {
    invariant(source.length === this.sourceSize, 'source table has the wrong length')
    for (let wire = 0; wire < source.length; wire++) {
      const range = this.ranges[wire]!
      invariant(
        source[wire]! >= range.minimum && source[wire]! <= range.maximum,
        `source wire ${wire} is outside its assumed range`,
      )
    }
  }

  compileTensorProgram(roots?: readonly Wire[]): TensorProgram {
    const width = this.sourceSize + this.operations.length
    const normalizedRoots = roots ?? Array.from(
      {length: this.operations.length},
      (_, operationIndex) => this.sourceSize + operationIndex,
    )
    const liveOperations = findLiveOperations(
      normalizedRoots,
      this.sourceSize,
      this.operations,
      width,
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
    for (let layerIndex = 0; layerIndex < operationsByLayer.length; layerIndex++) {
      const operationIndices = operationsByLayer[layerIndex]
      if (operationIndices === undefined) continue
      const outputSize = operationIndices.length
      const inputWires = new Set<Wire>()
      for (const operationIndex of operationIndices) {
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
      const inputIndices = Uint32Array.from(
        orderedInputWires,
        wire => packedIndexByWire[wire]!,
      )
      const inputColumnByWire = new Int32Array(width)
      inputColumnByWire.fill(-1)
      for (let column = 0; column < inputSize; column++) {
        inputColumnByWire[orderedInputWires[column]!] = column
      }
      const projectionSize = outputSize + gateCount
      const bias = new Float32Array(projectionSize)
      const gateRows = new Uint32Array(gateCount)
      const booleanRows = new Uint32Array(booleanCount)
      const projectionTerms = Array<Terms>(projectionSize)
      let gateRow = 0
      let booleanRow = 0
      for (let row = 0; row < operationIndices.length; row++) {
        const operationIndex = operationIndices[row]!
        const operation = this.operations[operationIndex]!
        const outputWire = this.sourceSize + operationIndex
        const packedOutput = availableValues + row
        wireOrder[packedOutput] = outputWire
        packedIndexByWire[outputWire] = packedOutput
        bias[row] = operation.leftBias
        projectionTerms[row] = operation.leftTerms
        if (operation.kind === 'reglu') {
          const projectionRow = outputSize + gateRow
          bias[projectionRow] = operation.gateBias
          gateRows[gateRow] = row
          projectionTerms[projectionRow] = operation.gateTerms
          gateRow++
        } else if (operation.kind === 'boolean') {
          booleanRows[booleanRow] = row
          booleanRow++
        }
      }
      const rowOffsets = new Uint32Array(projectionSize + 1)
      for (let row = 0; row < projectionSize; row++) {
        rowOffsets[row + 1] = rowOffsets[row]! + projectionTerms[row]!.length
      }
      const storedWeightCount = rowOffsets[projectionSize]!
      const columns = new Uint32Array(storedWeightCount)
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
        gateRows,
        booleanRows,
        rowOffsets,
        columns,
        weights,
      })
      availableValues += outputSize
    }
    return {
      layers,
      roots: Uint32Array.from(normalizedRoots),
      sourceSize: this.sourceSize,
      valueCount,
      wireOrder,
      width,
    }
  }

  stats() {
    let affineCount = 0
    let regluCount = 0
    let booleanCount = 0
    for (const operation of this.operations) {
      if (operation.kind === 'affine') affineCount++
      else if (operation.kind === 'reglu') regluCount++
      else booleanCount++
    }
    return {
      sourceCells: this.sourceSize,
      temporaryCells: this.operations.length,
      affineCount,
      regluCount,
      booleanCount,
      depth: Math.max(...this.depths),
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
  let minimum = bias
  let maximum = bias
  for (const [wire, coefficient] of terms) {
    const range = ranges[wire]!
    if (coefficient > 0) {
      minimum += coefficient * range.minimum
      maximum += coefficient * range.maximum
    } else {
      minimum += coefficient * range.maximum
      maximum += coefficient * range.minimum
    }
  }
  if (Number.isNaN(minimum) || Number.isNaN(maximum)) return unknownRange()
  return {minimum, maximum}
}

function multiplyByReluRange(left: NumericRange, gate: NumericRange): NumericRange {
  const gateMaximum = Math.max(0, gate.maximum)
  if (left.minimum >= 0) {
    return {
      minimum: multiplyBounds(left.minimum, Math.max(0, gate.minimum)),
      maximum: multiplyBounds(left.maximum, gateMaximum),
    }
  }
  if (left.maximum <= 0) {
    return {
      minimum: multiplyBounds(left.minimum, gateMaximum),
      maximum: multiplyBounds(left.maximum, Math.max(0, gate.minimum)),
    }
  }
  return {
    minimum: multiplyBounds(left.minimum, gateMaximum),
    maximum: multiplyBounds(left.maximum, gateMaximum),
  }
}

function multiplyBounds(left: number, right: number): number {
  if (left === 0 || right === 0) return 0
  return left * right
}

function findLiveOperations(
  roots: readonly Wire[],
  sourceSize: number,
  operations: readonly Operation[],
  width: number,
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
    const operation = operations[operationIndex]!
    for (const [dependency] of operation.leftTerms) pending.push(dependency)
    for (const [dependency] of operation.gateTerms) pending.push(dependency)
  }
  return liveOperations
}

function serializeExpression(
  kind: AtomKind,
  leftTerms: Terms,
  leftBias: number,
  gateTerms: Terms,
  gateBias: number,
): string {
  return [
    kind,
    leftBias,
    ...leftTerms.flatMap(([wire, coefficient]) => [wire, coefficient]),
    '|',
    gateBias,
    ...gateTerms.flatMap(([wire, coefficient]) => [wire, coefficient]),
  ].join(',')
}

function identityWire(terms: Terms, bias: number): Wire | undefined {
  if (bias !== 0 || terms.length !== 1 || terms[0]![1] !== 1) return undefined
  return terms[0]![0]
}

function composeAffineTerms(
  terms: Terms,
  bias: number,
  sourceSize: number,
  operations: readonly Operation[],
): [terms: Terms, bias: number] {
  const composedTerms: [wire: Wire, coefficient: number][] = []
  for (const [wire, coefficient] of terms) {
    const operation = wire < sourceSize ? undefined : operations[wire - sourceSize]
    if (operation?.kind !== 'affine') {
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

export function evaluateOperationStream(source: NumericArray, circuit: Circuit): Float64Array {
  invariant(source.length === circuit.sourceSize, 'source table has the wrong length')
  const values = new Float64Array(circuit.sourceSize + circuit.operations.length)
  values.set(source)
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    let value = evaluateTerms(values, operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') {
      value *= Math.max(0, evaluateTerms(values, operation.gateTerms, operation.gateBias))
    } else if (operation.kind === 'boolean') {
      value = evaluateBoolean(value)
    }
    values[circuit.sourceSize + operationIndex] = value
  }
  return values
}

export function evaluateOperationStreamFloat32(
  source: NumericArray,
  circuit: Circuit,
): Float32Array {
  invariant(source.length === circuit.sourceSize, 'source table has the wrong length')
  const values = new Float32Array(circuit.sourceSize + circuit.operations.length)
  values.set(source)
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    let value = evaluateTermsFloat32(values, operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') {
      value = Math.fround(
        value * Math.max(
          0,
          evaluateTermsFloat32(values, operation.gateTerms, operation.gateBias),
        ),
      )
    } else if (operation.kind === 'boolean') {
      value = evaluateBoolean(value)
    }
    values[circuit.sourceSize + operationIndex] = value
  }
  return values
}

export function evaluateTensorProgram(source: NumericArray, program: TensorProgram): Float64Array {
  invariant(source.length === program.sourceSize, 'source table has the wrong length')
  const {layers, valueCount, wireOrder, width} = program
  const packedValues = new Float64Array(valueCount)
  let maxProjectionSize = 0
  let maxInputSize = 0
  for (const layer of layers) maxProjectionSize = Math.max(maxProjectionSize, layer.bias.length)
  for (const layer of layers) maxInputSize = Math.max(maxInputSize, layer.inputSize)
  const input = new Float64Array(maxInputSize)
  const projection = new Float64Array(maxProjectionSize)
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
    for (let gateRow = 0; gateRow < layer.gateRows.length; gateRow++) {
      const outputRow = layer.gateRows[gateRow]!
      projection[outputRow] =
        projection[outputRow]! * Math.max(0, projection[outputSize + gateRow]!)
    }
    for (const booleanRow of layer.booleanRows) {
      projection[booleanRow] = evaluateBoolean(projection[booleanRow]!)
    }
    packedValues.set(projection.subarray(0, outputSize), availableValues)
    availableValues += outputSize
  }
  const values = new Float64Array(width)
  for (let packedIndex = 0; packedIndex < width; packedIndex++) {
    values[wireOrder[packedIndex]!] = packedValues[packedIndex]!
  }
  return values
}

export function evaluateTensorProgramFloat32(
  source: NumericArray,
  program: TensorProgram,
): Float32Array {
  invariant(source.length === program.sourceSize, 'source table has the wrong length')
  const {layers, valueCount, wireOrder, width} = program
  const packedValues = new Float32Array(valueCount)
  let maxProjectionSize = 0
  let maxInputSize = 0
  for (const layer of layers) maxProjectionSize = Math.max(maxProjectionSize, layer.bias.length)
  for (const layer of layers) maxInputSize = Math.max(maxInputSize, layer.inputSize)
  const input = new Float32Array(maxInputSize)
  const projection = new Float32Array(maxProjectionSize)
  packedValues.set(source)
  let availableValues = source.length
  for (const layer of layers) {
    const {outputSize} = layer
    for (let column = 0; column < layer.inputSize; column++) {
      input[column] = packedValues[layer.inputIndices[column]!]!
    }
    sparseMatmulAddBiasFloat32(
      projection,
      layer.weights,
      layer.columns,
      layer.rowOffsets,
      input,
      layer.bias,
    )
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
  const values = new Float32Array(width)
  for (let packedIndex = 0; packedIndex < width; packedIndex++) {
    values[wireOrder[packedIndex]!] = packedValues[packedIndex]!
  }
  return values
}

function sparseMatmulAddBias(
  output: Float64Array,
  weights: Float32Array,
  columns: Uint32Array,
  rowOffsets: Uint32Array,
  input: Float64Array,
  bias: Float32Array,
) {
  for (let row = 0; row < bias.length; row++) {
    let value = bias[row]!
    for (let index = rowOffsets[row]!; index < rowOffsets[row + 1]!; index++) {
      value += weights[index]! * input[columns[index]!]!
    }
    output[row] = value
  }
}

function sparseMatmulAddBiasFloat32(
  output: Float32Array,
  weights: Float32Array,
  columns: Uint32Array,
  rowOffsets: Uint32Array,
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

function evaluateTerms(values: Float64Array, terms: Terms, bias: number): number {
  let value = bias
  for (const [wire, coefficient] of terms) value += coefficient * values[wire]!
  return value
}

function evaluateTermsFloat32(
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

function evaluateBoolean(value: number): number {
  // FP32 rounds to whole numbers at this size; the odd base makes 0.5 round up.
  const base = 8_388_609
  const score = Math.fround(value)
  const shifted = Math.fround(score + base)
  return Math.fround(shifted - base)
}

export function emitRelu(circuit: Circuit, value: Wire): Wire {
  return circuit.reglu([], 1, [[value, 1]], 0)
}

export function emitMultiply(circuit: Circuit, a: Wire, b: Wire): Wire {
  if (circuit.isNonNegative(b)) return circuit.reglu([[a, 1]], 0, [[b, 1]], 0)
  if (circuit.isNonNegative(a)) return circuit.reglu([[b, 1]], 0, [[a, 1]], 0)
  const positive = circuit.reglu([[a, 1]], 0, [[b, 1]], 0)
  const negative = circuit.reglu([[a, 1]], 0, [[b, -1]], 0)
  return circuit.affine([[positive, 1], [negative, -1]])
}

export function emitMaximum(circuit: Circuit, a: Wire, b: Wire): Wire {
  const result = circuit.affine([[b, 1], [emitRelu(circuit, circuit.affine([[a, 1], [b, -1]])), 1]])
  circuit.assumeRange(
    result,
    Math.max(circuit.ranges[a]!.minimum, circuit.ranges[b]!.minimum),
    Math.max(circuit.ranges[a]!.maximum, circuit.ranges[b]!.maximum),
  )
  return result
}

export function emitMinimum(circuit: Circuit, a: Wire, b: Wire): Wire {
  const result = circuit.affine([[a, 1], [emitRelu(circuit, circuit.affine([[a, 1], [b, -1]])), -1]])
  circuit.assumeRange(
    result,
    Math.min(circuit.ranges[a]!.minimum, circuit.ranges[b]!.minimum),
    Math.min(circuit.ranges[a]!.maximum, circuit.ranges[b]!.maximum),
  )
  return result
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
  for (const root of roots) invariant(seenWires[root] === 1, 'every tensor root must be present')
}

export function validateTensorEvaluation(
  source: NumericArray,
  circuit: Circuit,
  tensorValues: NumericArray,
) {
  const expectedValues = evaluateOperationStreamWithFloat32Constants(source, circuit)
  invariant(expectedValues.length === tensorValues.length, 'tensor result width mismatch')
  const program = circuit.tensorProgram ??= circuit.compileTensorProgram()
  for (const wire of program.wireOrder) {
    assertApproximatelyEqual(tensorValues[wire]!, expectedValues[wire]!, `tensor wire ${wire}`)
  }
}

function evaluateOperationStreamWithFloat32Constants(
  source: NumericArray,
  circuit: Circuit,
): Float64Array {
  invariant(source.length === circuit.sourceSize, 'source table has the wrong length')
  const values = new Float64Array(circuit.sourceSize + circuit.operations.length)
  values.set(source)
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    let value = evaluateTermsWithFloat32Constants(
      values,
      operation.leftTerms,
      operation.leftBias,
    )
    if (operation.kind === 'reglu') {
      value *= Math.max(
        0,
        evaluateTermsWithFloat32Constants(
          values,
          operation.gateTerms,
          operation.gateBias,
        ),
      )
    } else if (operation.kind === 'boolean') {
      value = evaluateBoolean(value)
    }
    values[circuit.sourceSize + operationIndex] = value
  }
  return values
}

function evaluateTermsWithFloat32Constants(
  values: Float64Array,
  terms: Terms,
  bias: number,
) {
  let value = Math.fround(bias)
  for (const [wire, coefficient] of terms) {
    value += Math.fround(coefficient) * values[wire]!
  }
  return value
}

export function validateTensorFloat32Evaluation(
  source: NumericArray,
  circuit: Circuit,
  tensorValues: NumericArray,
) {
  const expectedValues = evaluateOperationStreamFloat32(source, circuit)
  invariant(expectedValues.length === tensorValues.length, 'tensor result width mismatch')
  const program = circuit.tensorProgram ??= circuit.compileTensorProgram()
  for (const wire of program.wireOrder) {
    invariant(
      tensorValues[wire] === expectedValues[wire],
      `FP32 tensor wire ${wire} does not match the readable atom program`,
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

export function assertFiniteValues(values: Iterable<number>, label: string) {
  for (const value of values) invariant(Number.isFinite(value), `${label} contains a non-finite number`)
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

function assertApproximatelyEqual(actual: number, expected: number, label: string) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected))
  invariant(Math.abs(actual - expected) <= 1e-9 * scale, `${label} does not match the readable atom program`)
}

// A staged program: shared (uniform) cells, instance arrays of structs, map
// stages written once per item, and reductions across instances between stages.
//
// Every stage is an ordinary Circuit whose source cells are the values it
// imports. A shared stage runs once per evaluation. A map stage runs once per
// instance of one array: its imports are shared values and fields of that
// array. Reductions sit between stages and turn fields into shared values
// (sum, first active, argmax, gather at a shared index), fields into other
// fields (prefix sums, gather at a per-instance index, grouped maxima), or
// shared values into fields (scatter).
//
// The same program runs through three executors: the duplicated circuit, where
// every map stage is copied once per instance and every reduction is lowered
// into atoms (expand.ts); generated JS with one instance loop per stage and a
// plain loop per reduction (executor.ts); and WGSL for the map stages
// (gpu-executor.ts). A reduction's executor loop and its lowering compute the
// same FP32 result, value by value, because both follow the fold order the
// reduction states.
//
// Stage boundaries keep the builder's composition rules intact. A small
// affine wire (fewer than 4 terms, not a preserved rounding point) is composed
// into its consumers by the builder. When a stage exports such a wire, the
// program records its terms, and a later stage that imports it rebuilds the
// affine from the imported terms, so consumers compose it the same way they
// would inside one circuit. Imported cells are laid out in creation order, so
// sums that sort their terms by wire number keep the same order too.
// `new StagedProgram({rebuildSmallAffines: false})` imports the stored value
// instead, so staged.test.ts and report.ts can measure what the rebuild changes.
import {Circuit, invariant, type Wire} from '../../../numeric-ui-core.ts'

export type Range = {minimum: number, maximum: number}

export class Value {
  readonly id: number
  readonly axis: string
  constructor(id: number, axis: string) {
    this.id = id
    this.axis = axis
  }
}

export type ValueStruct = Value | readonly ValueStruct[] | {readonly [key: string]: ValueStruct}
export type WireStruct = Wire | readonly WireStruct[] | {readonly [key: string]: WireStruct}
export type WiresOf<S> = S extends Value ? Wire : {[K in keyof S]: WiresOf<S[K]>}
export type ValuesOf<S> = S extends number ? Value : {[K in keyof S]: ValuesOf<S[K]>}

export type Producer =
  | {kind: 'cell'}
  | {kind: 'constant', values: Float32Array}
  | {kind: 'stage', stage: number, wire: Wire}
  | {kind: 'reduction', reduction: number}

export type ValueInfo = {
  id: number
  name: string
  axis: string
  range: Range
  producer: Producer
  // Set for a small affine exported from a stage: consumers rebuild it from
  // these terms instead of importing its stored value.
  composite?: {terms: [value: number, coefficient: number][], bias: number}
}

export type StageInfo = {
  index: number
  name: string
  kind: 'shared' | 'map'
  axis: string
  circuit: Circuit
  // The value imported into each source cell, in creation order.
  sourceValues: number[]
  rebuilt: {wire: Wire, value: number}[]
  outputs: {value: number, wire: Wire}[]
}

export type PrefixOrder = 'sequential' | 'brent-kung'

// Fold orders, stated as the FP32 steps both the executor and the lowering take.
// f is Math.fround and v the input field in instance order.
export type Reduction =
  // total = f(...f(f(0 + v0) + v1)... + v(n-1))
  | {kind: 'sum', name: string, axis: string, input: number, output: number}
  // sequential: p = f(bias); before_i = p; p = f(p + v_i); through_i = p; total = p.
  // brent-kung: the inclusive sums come from the Brent-Kung network (combine = f(a + b)),
  // then through_i = f(f(bias) + inclusive_i), before_0 = f(bias), before_i = through_(i-1).
  | {kind: 'prefix', name: string, axis: string, input: number, bias: number, order: PrefixOrder, before: number, through: number, total: number}
  // The first instance whose bit is 1, when gate is 1. index is 0 when none is.
  | {kind: 'firstActive', name: string, axis: string, input: number, gate: number, index: number, present: number}
  // The tournament of emitArgmax over scores in 0..1, ties to the lower index.
  | {kind: 'argmax', name: string, axis: string, input: number, index: number, score: number}
  // m = v0; m = f(v_i + max(0, f(m - v_i))) for i = 1..n-1.
  | {kind: 'max', name: string, axis: string, input: number, output: number}
  // present ? f(0 + v[index]) : 0.
  | {kind: 'gatherAt', name: string, axis: string, input: number, index: number, present: number | null, output: number}
  // out_i = from[index_i], where index is a per-instance constant of the target array.
  | {kind: 'gatherIndexed', name: string, from: string, to: string, index: number, inputs: number[], outputs: number[]}
  // bit_i = present and i == index, or f(bit_i * value) with a value.
  | {kind: 'scatter', name: string, axis: string, index: number, present: number | null, value: number | null, output: number}
  // The max fold above over the instances of each group, in instance order.
  // group is a per-instance constant of the source array, nondecreasing, with
  // every group in 0..target count - 1 holding at least one instance.
  | {kind: 'groupMax', name: string, from: string, to: string, input: number, group: number, output: number}

export type Step = {kind: 'stage', stage: StageInfo} | {kind: 'reduction', reduction: Reduction}

export type InstanceArray = {
  name: string
  count: number
  cell: (name: string, minimum: number, maximum: number) => Value
  constant: (name: string, values: ArrayLike<number>, range?: Range) => Value
}

// The builder composes small affine wires into consumers below this term count
// (numeric-ui-core.ts, affineShareThreshold).
const composeThreshold = 4

export function isComposableAffine(circuit: Circuit, wire: Wire) {
  if (wire < circuit.sourceSize) return false
  const operation = circuit.operations[wire - circuit.sourceSize]!
  return operation.kind === 'affine' && operation.preserveRounding !== true && operation.leftTerms.length < composeThreshold
}

function collectLeaves(struct: unknown, isLeaf: (value: unknown) => boolean, path: string, into: {leaf: unknown, path: string}[]) {
  if (isLeaf(struct)) {
    into.push({leaf: struct, path})
    return
  }
  invariant(typeof struct === 'object' && struct !== null, `unexpected struct leaf at ${path}`)
  if (Array.isArray(struct)) {
    struct.forEach((element, index) => collectLeaves(element, isLeaf, `${path}[${index}]`, into))
    return
  }
  for (const [key, element] of Object.entries(struct)) collectLeaves(element, isLeaf, path === '' ? key : `${path}.${key}`, into)
}

function mapLeaves(struct: unknown, isLeaf: (value: unknown) => boolean, leaf: (value: unknown, path: string) => unknown, path = ''): unknown {
  if (isLeaf(struct)) return leaf(struct, path)
  invariant(typeof struct === 'object' && struct !== null, `unexpected struct leaf at ${path}`)
  if (Array.isArray(struct)) return struct.map((element, index) => mapLeaves(element, isLeaf, leaf, `${path}[${index}]`))
  const result: Record<string, unknown> = {}
  for (const [key, element] of Object.entries(struct)) result[key] = mapLeaves(element, isLeaf, leaf, path === '' ? key : `${path}.${key}`)
  return result
}

const isValue = (value: unknown): value is Value => value instanceof Value
const isWire = (value: unknown): value is Wire => typeof value === 'number'

export function valueLeaves(struct: ValueStruct): Value[] {
  const leaves: {leaf: unknown, path: string}[] = []
  collectLeaves(struct, isValue, '', leaves)
  return leaves.map(entry => entry.leaf as Value)
}

export class StagedProgram {
  values: ValueInfo[] = []
  arrays = new Map<string, {name: string, count: number}>()
  steps: Step[] = []
  groups: {members: number[], allowAllZero: boolean}[] = []
  nexts: {cell: number, value: number}[] = []
  outputs = new Set<number>()
  // Values some later step reads as stored numbers.
  consumed = new Set<number>()
  // With false, a stage that imports an exported small affine reads its stored
  // value instead of rebuilding it from its terms. Only tests and report.ts turn
  // the rebuild off, to measure what it changes.
  readonly rebuildSmallAffines: boolean
  private groupKeys = new Set<string>()

  constructor(options: {rebuildSmallAffines?: boolean | undefined} = {}) {
    this.rebuildSmallAffines = options.rebuildSmallAffines ?? true
  }

  private addValue(name: string, axis: string, range: Range, producer: Producer): number {
    invariant(range.minimum <= range.maximum, `range of ${name} is inverted`)
    const id = this.values.length
    this.values.push({id, name, axis, range: {minimum: range.minimum, maximum: range.maximum}, producer})
    return id
  }

  handle(id: number) {
    return new Value(id, this.values[id]!.axis)
  }

  info(value: Value) {
    return this.values[value.id]!
  }

  count(axis: string) {
    if (axis === 'shared') return 1
    const array = this.arrays.get(axis)
    invariant(array !== undefined, `unknown instance array ${axis}`)
    return array.count
  }

  sharedCell(name: string, minimum: number, maximum: number) {
    return this.handle(this.addValue(name, 'shared', {minimum, maximum}, {kind: 'cell'}))
  }

  array(name: string, count: number): InstanceArray {
    invariant(name !== 'shared' && !this.arrays.has(name), `instance array ${name} already exists`)
    invariant(Number.isInteger(count) && count >= 1, 'an instance array needs at least one instance')
    this.arrays.set(name, {name, count})
    return {
      name,
      count,
      cell: (cellName, minimum, maximum) => this.handle(this.addValue(`${name}.${cellName}`, name, {minimum, maximum}, {kind: 'cell'})),
      constant: (constantName, values, range) => {
        invariant(values.length === count, `constant ${constantName} needs one value per instance`)
        const stored = Float32Array.from(values)
        let minimum = Number.POSITIVE_INFINITY
        let maximum = Number.NEGATIVE_INFINITY
        for (const value of stored) {
          invariant(Number.isFinite(value), `constant ${constantName} must be finite`)
          minimum = Math.min(minimum, value)
          maximum = Math.max(maximum, value)
        }
        return this.handle(this.addValue(`${name}.${constantName}`, name, range ?? {minimum, maximum}, {kind: 'constant', values: stored}))
      },
    }
  }

  // Declare exact one-hot groups over values the program already has, e.g. a
  // column count one-hot exported by a shared stage.
  private recordGroup(members: number[], allowAllZero: boolean) {
    const key = `${allowAllZero ? 1 : 0}|${members.join(',')}`
    if (this.groupKeys.has(key)) return
    this.groupKeys.add(key)
    this.groups.push({members, allowAllZero})
  }

  // The struct generics are left unconstrained: constraining them by the
  // recursive struct types makes the typechecker instantiate WiresOf without end.
  shared<I, O>(name: string, inputs: I, build: (circuit: Circuit, input: WiresOf<I>) => O): ValuesOf<O> {
    return this.buildStage('shared', 'shared', name, inputs, build)
  }

  map<I, O>(array: InstanceArray, name: string, inputs: I, build: (circuit: Circuit, input: WiresOf<I>) => O): ValuesOf<O> {
    return this.buildStage('map', array.name, name, inputs, build)
  }

  private buildStage<I, O>(kind: 'shared' | 'map', axis: string, name: string, inputs: I, build: (circuit: Circuit, input: WiresOf<I>) => O): ValuesOf<O> {
    const leaves = valueLeaves(inputs as ValueStruct)
    const importIds = new Set<number>()
    const compositeIds = new Set<number>()
    for (const leaf of leaves) {
      invariant(leaf.axis === 'shared' || leaf.axis === axis, `stage ${name} can't read ${this.values[leaf.id]!.name} from axis ${leaf.axis}`)
      const info = this.values[leaf.id]!
      if (info.composite === undefined) {
        importIds.add(leaf.id)
        continue
      }
      compositeIds.add(leaf.id)
      for (const [term] of info.composite.terms) importIds.add(term)
    }
    const sourceValues = [...importIds].sort((left, right) => left - right)
    const circuit = new Circuit(sourceValues.length)
    const wireOfValue = new Map<number, Wire>()
    const valueOfWire = new Map<Wire, number>()
    sourceValues.forEach((id, cell) => {
      const {range} = this.values[id]!
      const wire = circuit.source(cell)
      circuit.assumeRange(wire, range.minimum, range.maximum)
      wireOfValue.set(id, wire)
      valueOfWire.set(wire, id)
      this.consumed.add(id)
    })
    const rebuilt: {wire: Wire, value: number}[] = []
    for (const id of [...compositeIds].sort((left, right) => left - right)) {
      const {composite, range} = this.values[id]!
      const wire = circuit.affine(composite!.terms.map(([term, coefficient]) => [wireOfValue.get(term)!, coefficient] as const), composite!.bias)
      circuit.assumeRange(wire, range.minimum, range.maximum)
      wireOfValue.set(id, wire)
      if (!valueOfWire.has(wire)) valueOfWire.set(wire, id)
      rebuilt.push({wire, value: id})
    }
    for (const group of this.groups) {
      if (!group.members.every(member => wireOfValue.has(member))) continue
      const wires = group.members.map(member => wireOfValue.get(member)!)
      if (new Set(wires).size === wires.length) circuit.assumeOneHot(wires, group.allowAllZero)
    }
    const groupsBefore = circuit.oneHotGroups.length
    const inputWires = mapLeaves(inputs, isValue, leaf => wireOfValue.get((leaf as Value).id)!) as WiresOf<I>
    const result = build(circuit, inputWires)

    const stageIndex = this.steps.length
    const outputs: {value: number, wire: Wire}[] = []
    const exportWire = (wire: Wire, valueName: string): number => {
      const existing = valueOfWire.get(wire)
      if (existing !== undefined) return existing
      invariant(wire >= circuit.sourceSize && wire < circuit.sourceSize + circuit.operations.length, `stage ${name} returned a wire it doesn't own`)
      const id = this.addValue(valueName, axis, circuit.ranges[wire]!, {kind: 'stage', stage: stageIndex, wire})
      valueOfWire.set(wire, id)
      outputs.push({value: id, wire})
      if (this.rebuildSmallAffines && isComposableAffine(circuit, wire)) {
        const operation = circuit.operations[wire - circuit.sourceSize]!
        this.values[id]!.composite = {
          terms: operation.leftTerms.map(([term, coefficient], index) => [exportWire(term, `${valueName}.term${index}`), coefficient]),
          bias: operation.leftBias,
        }
      }
      return id
    }
    const outputValues = mapLeaves(result, isWire, (leaf, path) => this.handle(exportWire(leaf as Wire, path === '' ? name : `${name}.${path}`))) as ValuesOf<O>
    for (let groupIndex = groupsBefore; groupIndex < circuit.oneHotGroups.length; groupIndex++) {
      const group = circuit.oneHotGroups[groupIndex]!
      const members = group.members.map(member => valueOfWire.get(member))
      if (members.every(member => member !== undefined)) this.recordGroup(members as number[], group.allowAllZero)
    }
    this.steps.push({kind: 'stage', stage: {index: stageIndex, name, kind, axis, circuit, sourceValues, rebuilt, outputs}})
    return outputValues
  }

  private reductionOutput(name: string, axis: string, range: Range) {
    return this.addValue(name, axis, range, {kind: 'reduction', reduction: this.steps.length})
  }

  private read(value: Value, axis: string, what: string) {
    invariant(value.axis === axis, `${what} must be on axis ${axis}, got ${value.axis}`)
    this.consumed.add(value.id)
    return value.id
  }

  private push(reduction: Reduction) {
    this.steps.push({kind: 'reduction', reduction})
  }

  sum(input: Value, name: string, range?: Range) {
    invariant(input.axis !== 'shared', 'sum reads a field')
    const count = this.count(input.axis)
    const source = this.values[input.id]!.range
    const output = this.reductionOutput(name, 'shared', range ?? widenRange({minimum: count * Math.min(0, source.minimum), maximum: count * Math.max(0, source.maximum)}))
    this.push({kind: 'sum', name, axis: input.axis, input: this.read(input, input.axis, name), output})
    return this.handle(output)
  }

  // A count of exact 0/1 bits: a sum whose partial sums are exact integers.
  countBits(input: Value, name: string) {
    return this.sum(input, name, {minimum: 0, maximum: this.count(input.axis)})
  }

  prefixSum(input: Value, name: string, options: {bias?: number, order?: PrefixOrder, range?: Range} = {}) {
    invariant(input.axis !== 'shared', 'a prefix sum reads a field')
    const axis = input.axis
    const bias = Math.fround(options.bias ?? 0)
    const count = this.count(axis)
    const source = this.values[input.id]!.range
    const range = options.range ?? widenRange({minimum: bias + count * Math.min(0, source.minimum), maximum: bias + count * Math.max(0, source.maximum)})
    const inputId = this.read(input, axis, name)
    const before = this.reductionOutput(`${name}.before`, axis, range)
    const through = this.reductionOutput(`${name}.through`, axis, range)
    const total = this.reductionOutput(`${name}.total`, 'shared', range)
    this.push({kind: 'prefix', name, axis, input: inputId, bias, order: options.order ?? 'sequential', before, through, total})
    return {before: this.handle(before), through: this.handle(through), total: this.handle(total)}
  }

  firstActive(input: Value, gate: Value, name: string) {
    const axis = input.axis
    invariant(axis !== 'shared', 'first active reads a field')
    const inputId = this.read(input, axis, name)
    const gateId = this.read(gate, 'shared', `${name} gate`)
    const index = this.reductionOutput(`${name}.index`, 'shared', {minimum: 0, maximum: this.count(axis) - 1})
    const present = this.reductionOutput(`${name}.present`, 'shared', {minimum: 0, maximum: 1})
    this.push({kind: 'firstActive', name, axis, input: inputId, gate: gateId, index, present})
    return {index: this.handle(index), present: this.handle(present)}
  }

  argmax(input: Value, name: string) {
    const axis = input.axis
    invariant(axis !== 'shared', 'argmax reads a field')
    const source = this.values[input.id]!.range
    invariant(source.minimum >= 0 && source.maximum <= 1, 'argmax scores must be within zero and one')
    const inputId = this.read(input, axis, name)
    const index = this.reductionOutput(`${name}.index`, 'shared', {minimum: 0, maximum: this.count(axis) - 1})
    const score = this.reductionOutput(`${name}.score`, 'shared', {minimum: 0, maximum: 1})
    this.push({kind: 'argmax', name, axis, input: inputId, index, score})
    return {index: this.handle(index), score: this.handle(score)}
  }

  max(input: Value, name: string) {
    const axis = input.axis
    invariant(axis !== 'shared', 'max reads a field')
    const output = this.reductionOutput(name, 'shared', widenRange(this.values[input.id]!.range))
    this.push({kind: 'max', name, axis, input: this.read(input, axis, name), output})
    return this.handle(output)
  }

  // index is an integer in 0..count - 1, also when present is 0.
  gatherAt(input: Value, index: Value, name: string, present?: Value) {
    const axis = input.axis
    invariant(axis !== 'shared', 'gather reads a field')
    const indexRange = this.values[index.id]!.range
    invariant(indexRange.minimum >= 0 && indexRange.maximum <= this.count(axis) - 1, `${name}: the index range must lie within the array`)
    const source = this.values[input.id]!.range
    const range = present === undefined ? source : {minimum: Math.min(0, source.minimum), maximum: Math.max(0, source.maximum)}
    const inputId = this.read(input, axis, name)
    const indexId = this.read(index, 'shared', `${name} index`)
    const presentId = present === undefined ? null : this.read(present, 'shared', `${name} present`)
    const output = this.reductionOutput(name, 'shared', range)
    this.push({kind: 'gatherAt', name, axis, input: inputId, index: indexId, present: presentId, output})
    return this.handle(output)
  }

  gatherIndexed<S extends ValueStruct>(inputs: S, to: InstanceArray, index: Value, name: string): S {
    const indexInfo = this.values[index.id]!
    invariant(index.axis === to.name && indexInfo.producer.kind === 'constant', `${name}: the index must be a per-instance constant of ${to.name}`)
    const leaves = valueLeaves(inputs)
    invariant(leaves.length > 0, `${name}: nothing to gather`)
    const from = leaves[0]!.axis
    invariant(from !== 'shared', `${name}: gather from a field`)
    const fromCount = this.count(from)
    for (const position of (indexInfo.producer as {values: Float32Array}).values) {
      invariant(Number.isInteger(position) && position >= 0 && position < fromCount, `${name}: index ${position} is outside ${from}`)
    }
    const inputIds: number[] = []
    const outputIds: number[] = []
    const outputs = mapLeaves(inputs, isValue, (leaf, path) => {
      const value = leaf as Value
      inputIds.push(this.read(value, from, name))
      const output = this.reductionOutput(path === '' ? name : `${name}.${path}`, to.name, this.values[value.id]!.range)
      outputIds.push(output)
      return this.handle(output)
    }) as S
    this.consumed.add(index.id)
    this.push({kind: 'gatherIndexed', name, from, to: to.name, index: index.id, inputs: inputIds, outputs: outputIds})
    return outputs
  }

  scatter(to: InstanceArray, index: Value, name: string, options: {present?: Value, value?: Value} = {}) {
    const indexRange = this.values[index.id]!.range
    invariant(indexRange.minimum >= 0 && indexRange.maximum <= to.count - 1, `${name}: the index range must lie within the array`)
    const indexId = this.read(index, 'shared', `${name} index`)
    const presentId = options.present === undefined ? null : this.read(options.present, 'shared', `${name} present`)
    const valueId = options.value === undefined ? null : this.read(options.value, 'shared', `${name} value`)
    const source = valueId === null ? {minimum: 0, maximum: 1} : this.values[valueId]!.range
    const output = this.reductionOutput(name, to.name, {minimum: Math.min(0, source.minimum), maximum: Math.max(0, source.maximum)})
    this.push({kind: 'scatter', name, axis: to.name, index: indexId, present: presentId, value: valueId, output})
    return this.handle(output)
  }

  groupMax(input: Value, to: InstanceArray, group: Value, name: string) {
    const from = input.axis
    const groupInfo = this.values[group.id]!
    invariant(group.axis === from && groupInfo.producer.kind === 'constant', `${name}: the group must be a per-instance constant of ${from}`)
    const groups = (groupInfo.producer as {values: Float32Array}).values
    let previous = 0
    const seen = new Uint8Array(to.count)
    groups.forEach(value => {
      invariant(Number.isInteger(value) && value >= previous && value < to.count, `${name}: groups must be nondecreasing integers within ${to.name}`)
      previous = value
      seen[value] = 1
    })
    invariant(seen.every(flag => flag === 1), `${name}: every group needs at least one instance`)
    const output = this.reductionOutput(name, to.name, this.values[input.id]!.range)
    this.consumed.add(group.id)
    this.push({kind: 'groupMax', name, from, to: to.name, input: this.read(input, from, name), group: group.id, output})
    return this.handle(output)
  }

  // After an evaluation, the host copies value into cell (both on the same axis).
  next(cell: Value, value: Value) {
    const info = this.values[cell.id]!
    invariant(info.producer.kind === 'cell', `${info.name} isn't a cell`)
    invariant(cell.axis === value.axis, `${info.name} and its next value live on different axes`)
    this.consumed.add(value.id)
    this.nexts.push({cell: cell.id, value: value.id})
  }

  nextStruct<S extends ValueStruct>(cells: S, values: S) {
    const cellLeaves = valueLeaves(cells)
    const valueLeavesList = valueLeaves(values)
    invariant(cellLeaves.length === valueLeavesList.length, 'next needs matching structs')
    cellLeaves.forEach((cell, index) => this.next(cell, valueLeavesList[index]!))
  }

  output(struct: ValueStruct) {
    for (const leaf of valueLeaves(struct)) {
      this.outputs.add(leaf.id)
      this.consumed.add(leaf.id)
    }
  }

  // Stage outputs that later steps, next values, or the host read.
  stageRoots(stage: StageInfo) {
    return stage.outputs.filter(output => this.consumed.has(output.value)).map(output => output.wire)
  }
}

// Declared ranges must stay finite and cover FP32 rounding of the partial sums.
function widenRange(range: Range): Range {
  const slack = (value: number) => Math.abs(value) * 1e-5 + 1e-3
  return {minimum: range.minimum - slack(range.minimum), maximum: range.maximum + slack(range.maximum)}
}

export type StageStats = {name: string, kind: 'shared' | 'map', axis: string, instances: number, liveOperations: number, layers: number, storedWeights: number, gatherReads: number}

export function stageStats(program: StagedProgram, stage: StageInfo): StageStats {
  const compiled = stage.circuit.compileTensorProgram(program.stageRoots(stage))
  let storedWeights = 0
  let gatherReads = 0
  for (const layer of compiled.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
  }
  return {
    name: stage.name,
    kind: stage.kind,
    axis: stage.axis,
    instances: program.count(stage.axis),
    liveOperations: compiled.valueCount - compiled.sourceSize,
    layers: compiled.layers.length,
    storedWeights,
    gatherReads,
  }
}

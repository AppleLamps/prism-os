// The duplicated circuit: today's approach, as the reference for a staged
// program. Shared stages are copied once, map stages once per instance, and
// every reduction is lowered into atoms that compute the fold order the
// reduction states.
//
// Stage operations are copied verbatim: the same kinds, biases, coefficients
// and term order, with wires renumbered. The copy bypasses the builder's
// normalization, so a copied sum keeps the accumulation order it had in its
// stage, and consumers of a copied wire never recompose it. Operations that
// read no per-instance wire come out identical for every instance and are
// shared through the builder's expression table, the way a flat build would
// deduplicate them.
import {Circuit, invariant, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {emitAnd, emitFirstSetBit, emitGather, emitIndexOneHot} from './kit.ts'
import {type Range, type Reduction, type StageInfo, type StagedProgram} from './staged.ts'

type Operation = Circuit['operations'][number]

export type PrefixLowering = 'chain' | 'triangle'

export type DuplicatedCircuit = {
  program: StagedProgram
  circuit: Circuit
  // wires[valueId][instance]; shared values have one entry.
  wires: (Int32Array | null)[]
  roots: Wire[]
  sourceLayout: {value: number, instance: number}[]
}

// numeric-ui-core.ts keys its expression table this way.
function serializeExpression(kind: string, leftTerms: readonly (readonly [Wire, number])[], leftBias: number, gateTerms: readonly (readonly [Wire, number])[], gateBias: number) {
  const parts: (string | number)[] = [kind, leftBias]
  for (const [wire, coefficient] of leftTerms) parts.push(wire, coefficient)
  parts.push('|', gateBias)
  for (const [wire, coefficient] of gateTerms) parts.push(wire, coefficient)
  return parts.join(',')
}

export function rawAppend(target: Circuit, operation: Operation, mapWire: (wire: Wire) => Wire, range: Range): Wire {
  const leftTerms = operation.leftTerms.map(([wire, coefficient]) => [mapWire(wire), coefficient] as [Wire, number])
  const gateTerms = operation.gateTerms.map(([wire, coefficient]) => [mapWire(wire), coefficient] as [Wire, number])
  const source = operation.macro
  const macro = source === undefined
    ? undefined
    : source.kind === 'multiply'
      ? {kind: 'multiply' as const, left: mapWire(source.left), right: mapWire(source.right)}
      : {kind: 'select' as const, gate: mapWire(source.gate), off: mapWire(source.off), on: mapWire(source.on)}
  const key = serializeExpression(operation.kind, leftTerms, operation.leftBias, gateTerms, operation.gateBias)
    + (operation.preserveRounding === true ? '|round' : '')
    + (macro === undefined ? '' : `|${JSON.stringify(macro)}`)
  const existing = target.expressionWires.get(key)
  if (existing !== undefined) return existing
  const wire = target.sourceSize + target.operations.length
  let depth = 0
  for (const [dependency] of leftTerms) depth = Math.max(depth, target.depths[dependency]!)
  for (const [dependency] of gateTerms) depth = Math.max(depth, target.depths[dependency]!)
  target.operations.push({
    kind: operation.kind,
    leftTerms,
    leftBias: operation.leftBias,
    gateTerms,
    gateBias: operation.gateBias,
    depth: depth + 1,
    ...(operation.preserveRounding === true ? {preserveRounding: true as const} : {}),
    ...(macro === undefined ? {} : {macro}),
  })
  target.depths.push(depth + 1)
  target.constants.push(operation.preserveRounding !== true && operation.kind === 'affine' && leftTerms.length === 0 ? operation.leftBias : undefined)
  target.ranges.push({minimum: range.minimum, maximum: range.maximum})
  target.expressionWires.set(key, wire)
  target.tensorProgram = null
  return wire
}

export function liveOperations(circuit: Circuit, roots: readonly Wire[]) {
  const live = new Uint8Array(circuit.operations.length)
  const pending = [...roots]
  while (pending.length > 0) {
    const wire = pending.pop()!
    if (wire < circuit.sourceSize) continue
    const index = wire - circuit.sourceSize
    if (live[index] === 1) continue
    live[index] = 1
    const operation = circuit.operations[index]!
    for (const [dependency] of operation.leftTerms) pending.push(dependency)
    for (const [dependency] of operation.gateTerms) pending.push(dependency)
  }
  return live
}

export function expandDuplicated(program: StagedProgram, options: {prefixLowering?: PrefixLowering} = {}): DuplicatedCircuit {
  const prefixLowering = options.prefixLowering ?? 'triangle'
  const {values} = program
  const sourceLayout: {value: number, instance: number}[] = []
  const sourceValues = values.filter(info => info.producer.kind === 'cell' || info.producer.kind === 'constant')
  for (const info of sourceValues) if (info.axis === 'shared') sourceLayout.push({value: info.id, instance: 0})
  for (const array of program.arrays.values()) {
    const fields = sourceValues.filter(info => info.axis === array.name)
    for (let instance = 0; instance < array.count; instance++) {
      for (const info of fields) sourceLayout.push({value: info.id, instance})
    }
  }
  const circuit = new Circuit(sourceLayout.length)
  const wires: (Int32Array | null)[] = values.map(() => null)
  const wiresOf = (id: number) => {
    const stored = wires[id]
    if (stored !== null && stored !== undefined) return stored
    const info = values[id]!
    const created = new Int32Array(program.count(info.axis)).fill(-1)
    wires[id] = created
    return created
  }
  sourceLayout.forEach(({value, instance}, wire) => {
    const {range} = values[value]!
    circuit.assumeRange(wire, range.minimum, range.maximum)
    wiresOf(value)[instance] = wire
  })
  const wireAt = (id: number, instance: number) => {
    const info = values[id]!
    const wire = wiresOf(id)[info.axis === 'shared' ? 0 : instance]!
    invariant(wire >= 0, `value ${info.name} has no wire yet`)
    return wire
  }
  const groupKeys = new Set<string>()
  const declareGroup = (members: Wire[], allowAllZero: boolean) => {
    const key = `${allowAllZero ? 1 : 0}|${members.join(',')}`
    if (groupKeys.has(key) || new Set(members).size !== members.length) return
    groupKeys.add(key)
    circuit.assumeOneHot(members, allowAllZero)
  }

  const copyStage = (stage: StageInfo) => {
    const roots = program.stageRoots(stage)
    const live = liveOperations(stage.circuit, roots)
    const count = program.count(stage.axis)
    const {sourceSize} = stage.circuit
    const copied = new Int32Array(stage.circuit.operations.length).fill(-1)
    for (let instance = 0; instance < (stage.kind === 'shared' ? 1 : count); instance++) {
      const mapWire = (wire: Wire) => {
        if (wire < sourceSize) return wireAt(stage.sourceValues[wire]!, instance)
        const mapped = copied[wire - sourceSize]!
        invariant(mapped >= 0, 'a copied operation reads an operation that was not copied')
        return mapped
      }
      copied.fill(-1)
      for (let index = 0; index < stage.circuit.operations.length; index++) {
        if (live[index] === 0) continue
        copied[index] = rawAppend(circuit, stage.circuit.operations[index]!, mapWire, stage.circuit.ranges[sourceSize + index]!)
      }
      for (const group of stage.circuit.oneHotGroups) {
        const members = group.members.map(member => member < sourceSize || copied[member - sourceSize]! >= 0 ? mapWire(member) : -1)
        if (members.every(member => member >= 0)) declareGroup(members, group.allowAllZero)
      }
      for (const output of stage.outputs) {
        if (!program.consumed.has(output.value)) continue
        wiresOf(output.value)[stage.kind === 'shared' ? 0 : instance] = mapWire(output.wire)
      }
    }
  }

  const narrow = (wire: Wire, range: Range) => {
    const current = circuit.ranges[wire]!
    const minimum = Math.max(current.minimum, range.minimum)
    const maximum = Math.min(current.maximum, range.maximum)
    if (minimum <= maximum && wire >= circuit.sourceSize) circuit.ranges[wire] = {minimum, maximum}
  }
  // The one-hot of a shared index, built once per index value and shared by
  // every gather and scatter over the same count. Presence gates the results
  // afterwards, so the index needn't be 0 when nothing is present.
  const oneHots = new Map<string, Wire[]>()
  const indexOneHot = (index: number, count: number) => {
    const key = `${index}|${count}`
    const cached = oneHots.get(key)
    if (cached !== undefined) return cached
    const indexWire = wireAt(index, 0)
    // A constant index, e.g. the one Photos window among the windows, folds every ramp into constants.
    const constant = circuit.constants[indexWire]
    const members = count === 1
      ? [circuit.affine([], 1)]
      : constant !== undefined
        ? Array.from({length: count}, (_, position) => circuit.affine([], position === constant ? 1 : 0))
        : emitIndexOneHot(circuit, indexWire, count).members
    oneHots.set(key, members)
    return members
  }
  const materializeSum = (wire: Wire) => wire >= circuit.sourceSize && circuit.operations[wire - circuit.sourceSize]!.kind === 'affine' && circuit.operations[wire - circuit.sourceSize]!.preserveRounding !== true && circuit.operations[wire - circuit.sourceSize]!.leftTerms.length < 4
    ? circuit.roundAffine([[wire, 1]])
    : wire
  const maximumStep = (running: Wire, next: Wire) => {
    const difference = circuit.roundAffine([[running, 1], [next, -1]])
    const positive = circuit.reglu([], 1, [[difference, 1]], 0)
    return circuit.roundAffine([[next, 1], [positive, 1]])
  }

  const lower = (reduction: Reduction) => {
    switch (reduction.kind) {
      case 'sum': {
        const inputs = [...wiresOf(reduction.input)]
        const total = circuit.roundAffine(inputs.map(wire => [wire, 1] as const))
        narrow(total, values[reduction.output]!.range)
        wiresOf(reduction.output)[0] = total
        return
      }
      case 'prefix': {
        const inputs = [...wiresOf(reduction.input)]
        const count = inputs.length
        const before = wiresOf(reduction.before)
        const through = wiresOf(reduction.through)
        const start = circuit.roundAffine([], reduction.bias)
        if (reduction.order === 'sequential') {
          if (prefixLowering === 'chain') {
            let running = start
            for (let instance = 0; instance < count; instance++) {
              before[instance] = running
              running = circuit.roundAffine([[running, 1], [inputs[instance]!, 1]])
              through[instance] = running
            }
          } else {
            for (let instance = 0; instance < count; instance++) {
              through[instance] = circuit.roundAffine(inputs.slice(0, instance + 1).map(wire => [wire, 1] as const), reduction.bias)
              before[instance] = instance === 0 ? start : through[instance - 1]!
            }
          }
        } else {
          const inclusive = [...inputs]
          let span = 1
          for (; span < count; span *= 2) {
            for (let index = 2 * span - 1; index < count; index += 2 * span) {
              inclusive[index] = circuit.roundAffine([[inclusive[index - span]!, 1], [inclusive[index]!, 1]])
            }
          }
          for (span = span / 4; span >= 1; span /= 2) {
            for (let index = 3 * span - 1; index < count; index += 2 * span) {
              inclusive[index] = circuit.roundAffine([[inclusive[index - span]!, 1], [inclusive[index]!, 1]])
            }
          }
          for (let instance = 0; instance < count; instance++) {
            through[instance] = circuit.roundAffine([[inclusive[instance]!, 1]], reduction.bias)
            before[instance] = instance === 0 ? start : through[instance - 1]!
          }
        }
        wiresOf(reduction.total)[0] = through[count - 1]!
        return
      }
      case 'firstActive': {
        const bits = [...wiresOf(reduction.input)]
        const selected = emitFirstSetBit(circuit, wireAt(reduction.gate, 0), bits)
        wiresOf(reduction.index)[0] = circuit.roundAffine(selected.map((wire, instance) => [wire, instance] as const))
        const present = circuit.roundAffine(selected.map(wire => [wire, 1] as const))
        circuit.assumeRange(present, 0, 1)
        wiresOf(reduction.present)[0] = present
        return
      }
      case 'argmax': {
        // emitArgmax's tournament, with the comparison written as a preserved
        // sum so a composable input can't change its accumulation.
        type Node = {score: Wire, item: number}
        let level: Node[] = [...wiresOf(reduction.input)].map((score, item) => ({score: materializeSum(score), item}))
        const routes: {leftWins: Wire, left: number[], right: number[]}[] = []
        let members: number[][] = level.map(node => [node.item])
        while (level.length > 1) {
          const next: Node[] = []
          const nextMembers: number[][] = []
          for (let index = 0; index < level.length; index += 2) {
            const left = level[index]!
            const right = level[index + 1]
            if (right === undefined) {
              next.push(left)
              nextMembers.push(members[index]!)
              continue
            }
            const comparison = circuit.roundAffine([[left.score, 0.4999999403953552], [right.score, -0.4999999403953552]], 0.5000000596046448)
            circuit.assumeRange(comparison, 0, 1)
            const leftWins = circuit.boolean(comparison)
            routes.push({leftWins, left: members[index]!, right: members[index + 1]!})
            next.push({score: circuit.select(leftWins, right.score, left.score), item: -1})
            nextMembers.push([...members[index]!, ...members[index + 1]!])
          }
          level = next
          members = nextMembers
        }
        // An item is selected when it wins every comparison on its path.
        const route = [...wiresOf(reduction.input)].map(() => circuit.affine([], 1))
        for (const {leftWins, left, right} of routes) {
          for (const item of left) route[item] = circuit.multiply(route[item]!, leftWins)
          for (const item of right) route[item] = circuit.multiply(route[item]!, circuit.affine([[leftWins, -1]], 1))
        }
        wiresOf(reduction.index)[0] = circuit.roundAffine(route.map((wire, item) => [wire, item] as const))
        wiresOf(reduction.score)[0] = level[0]!.score
        return
      }
      case 'max': {
        const inputs = [...wiresOf(reduction.input)]
        let running = inputs[0]!
        for (let instance = 1; instance < inputs.length; instance++) running = maximumStep(running, inputs[instance]!)
        wiresOf(reduction.output)[0] = running
        return
      }
      case 'groupMax': {
        const inputs = wiresOf(reduction.input)
        const groups = (values[reduction.group]!.producer as {values: Float32Array}).values
        const output = wiresOf(reduction.output)
        for (let instance = 0; instance < inputs.length; instance++) {
          const group = groups[instance]!
          output[group] = output[group]! < 0 || (instance > 0 && groups[instance - 1] !== group) ? inputs[instance]! : maximumStep(output[group]!, inputs[instance]!)
        }
        return
      }
      case 'gatherAt': {
        const inputs = [...wiresOf(reduction.input)]
        const constantIndex = circuit.constants[wireAt(reduction.index, 0)]
        let gathered = constantIndex !== undefined
          ? circuit.roundAffine([[inputs[constantIndex]!, 1]])
          : inputs.length === 1
            ? circuit.roundAffine([[circuit.multiply(indexOneHot(reduction.index, 1)[0]!, inputs[0]!), 1]])
            : materializeSum(emitGather(circuit, indexOneHot(reduction.index, inputs.length), inputs))
        if (reduction.present !== null) gathered = circuit.multiply(wireAt(reduction.present, 0), gathered)
        wiresOf(reduction.output)[0] = gathered
        return
      }
      case 'gatherIndexed': {
        const indices = (values[reduction.index]!.producer as {values: Float32Array}).values
        reduction.inputs.forEach((input, field) => {
          const from = wiresOf(input)
          const to = wiresOf(reduction.outputs[field]!)
          indices.forEach((index, instance) => {
            to[instance] = from[index]!
          })
        })
        return
      }
      case 'scatter': {
        const count = program.count(reduction.axis)
        const members = indexOneHot(reduction.index, count)
        const present = reduction.present === null ? null : wireAt(reduction.present, 0)
        const output = wiresOf(reduction.output)
        members.forEach((member, instance) => {
          const bit = present === null ? member : emitAnd(circuit, [member, present])
          output[instance] = reduction.value === null ? bit : circuit.multiply(bit, wireAt(reduction.value, 0))
        })
        return
      }
    }
  }

  for (const step of program.steps) {
    if (step.kind === 'stage') copyStage(step.stage)
    else lower(step.reduction)
  }
  const roots: Wire[] = []
  const rootSet = new Set<Wire>()
  const addRoot = (wire: Wire) => {
    if (wire < 0 || rootSet.has(wire)) return
    rootSet.add(wire)
    roots.push(wire)
  }
  for (const id of program.outputs) for (const wire of wiresOf(id)) addRoot(wire)
  for (const {value} of program.nexts) for (const wire of wiresOf(value)) addRoot(wire)
  return {program, circuit, wires, roots, sourceLayout}
}

export type DuplicatedMachine = ReturnType<typeof createDuplicatedMachine>

// A host around the duplicated circuit with the same read and write surface as
// the staged executor: cells by value and instance, outputs by value and instance.
export function createDuplicatedMachine(duplicated: DuplicatedCircuit, evaluator: 'tensor' | 'reference' = 'tensor') {
  const {program, circuit, roots, wires} = duplicated
  const source = new Float32Array(circuit.sourceSize)
  for (const info of program.values) {
    if (info.producer.kind !== 'constant') continue
    const cells = wires[info.id]!
    info.producer.values.forEach((value, instance) => {
      source[cells[instance]!] = value
    })
  }
  const evaluate = evaluator === 'tensor' ? circuit.createTensorEvaluator(roots) : null
  const positionOfRoot = new Map<Wire, number>()
  roots.forEach((wire, index) => positionOfRoot.set(wire, index))
  let latest: Float32Array = new Float32Array(evaluator === 'tensor' ? roots.length : circuit.sourceSize + circuit.operations.length)
  const nextPairs = program.nexts.map(({cell, value}) => ({cells: wires[cell]!, values: wires[value]!}))
  const readWire = (wire: Wire) => evaluator === 'tensor' ? latest[positionOfRoot.get(wire)!]! : latest[wire]!
  return {
    duplicated,
    source,
    step() {
      latest = evaluate === null ? circuit.evaluateReference(source) : evaluate(source)
      for (const {cells, values} of nextPairs) {
        for (let instance = 0; instance < cells.length; instance++) source[cells[instance]!] = readWire(values[instance]!)
      }
    },
    cellWire(id: number, instance = 0) {
      const info = program.values[id]!
      return wires[id]![info.axis === 'shared' ? 0 : instance]!
    },
    // An output or next value from the latest evaluation.
    read(id: number, instance = 0) {
      const info = program.values[id]!
      const wire = wires[id]![info.axis === 'shared' ? 0 : instance]!
      if (wire < circuit.sourceSize && evaluator === 'tensor' && !positionOfRoot.has(wire)) return source[wire]!
      return readWire(wire)
    },
  }
}

export function measureCircuit(circuit: Circuit, roots: readonly Wire[]) {
  const program = circuit.compileTensorProgram(roots)
  let storedWeights = 0
  let gatherReads = 0
  let widestLayer = 0
  for (const layer of program.layers) {
    storedWeights += layer.weights.length
    gatherReads += layer.gatherReads.length
    widestLayer = Math.max(widestLayer, layer.outputSize)
  }
  return {program, liveOperations: program.valueCount - program.sourceSize, layers: program.layers.length, storedWeights, gatherReads, widestLayer}
}

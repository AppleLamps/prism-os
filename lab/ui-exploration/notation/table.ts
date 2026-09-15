// A source table allocator. Every cell is declared once with a range, an
// initial value, and what happens to it after a frame. The table derives the
// offsets, the circuit's range and one-hot declarations, the initial
// Float32Array, a validator, and the next-source writeback mapping.
//
// Declaring and building are two phases because a Circuit needs its source
// size before the first operation exists: allocate every cell (including child
// scopes such as Photos), call createCircuit, then build behavior.
import {Circuit, type Wire, invariant} from '../../../numeric-ui-core.ts'

export type Range = readonly [minimum: number, maximum: number]

export const anyNumber: Range = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
export const nonNegative: Range = [0, Number.POSITIVE_INFINITY]
export const unitInterval: Range = [0, 1]

// constant: written once at creation, kept by the circuit.
// input: written by the host (every frame or on an event), kept by the circuit.
// event: an exact bit written by the host, reset to zero after every frame.
// state: the circuit must assign the next value through table.next.
export type CellPolicy = 'constant' | 'input' | 'event' | 'state'

export type CellSpec = {
  readonly kind: 'cell'
  readonly policy: CellPolicy
  readonly range: Range
  readonly initial: number
  readonly exactBit: boolean
}

type GroupRule = 'oneHot' | 'atMostOne'

// An interface rather than a type alias, so Spec may refer to it recursively.
export interface GroupSpec<Member extends Spec> {
  readonly kind: 'group'
  readonly rule: GroupRule
  readonly allowAllZero: boolean
  // Whether the circuit hears about the group (enabling gather lowering), or
  // only the validator checks it.
  readonly declareToCircuit: boolean
  readonly members: readonly Member[]
}

export type PermutationSpec = {
  readonly kind: 'permutation'
  readonly cells: readonly (readonly CellSpec[])[]
}

export type Spec =
  | CellSpec
  | GroupSpec<Spec>
  | PermutationSpec
  | readonly Spec[]
  | {readonly [field: string]: Spec}

export type Allocated<S> =
  S extends CellSpec ? Wire
    : S extends PermutationSpec ? Wire[][]
      : S extends GroupSpec<infer Member> ? Allocated<Member>[]
        : S extends readonly (infer Element)[] ? Allocated<Element>[]
          : {-readonly [Field in keyof S]: Allocated<S[Field]>}

const cell = (policy: CellPolicy, range: Range, initial: number, exactBit: boolean): CellSpec =>
  ({kind: 'cell', policy, range, initial, exactBit})

export const constant = (initial: number, range: Range) => cell('constant', range, initial, false)
export const input = (range: Range, initial = 0) => cell('input', range, initial, false)
export const event = () => cell('event', unitInterval, 0, true)
export const state = (range: Range, initial = 0) => cell('state', range, initial, false)
export const bit = (initial = 0) => cell('state', unitInterval, initial, true)

export function list<Element>(count: number, make: (index: number) => Element): Element[] {
  return Array.from({length: count}, (_, index) => make(index))
}

// Exactly one member is 1, or none when allowAllZero is set.
export function oneHot<S extends CellSpec>(
  members: readonly S[],
  options: {allowAllZero?: boolean, declareToCircuit?: boolean} = {},
): GroupSpec<S> {
  return {
    kind: 'group',
    rule: 'oneHot',
    allowAllZero: options.allowAllZero ?? false,
    declareToCircuit: options.declareToCircuit ?? true,
    members,
  }
}

// Members sum to at most one. Only the validator checks this rule.
export function atMostOne<S extends Spec>(members: readonly S[]): GroupSpec<S> {
  return {kind: 'group', rule: 'atMostOne', allowAllZero: true, declareToCircuit: false, members}
}

// A stacking order stored as a permutation matrix cells[rank][item]. Every row
// and every column is a declared one-hot group. order[rank] is the item there.
export function permutation(order: readonly number[]): PermutationSpec {
  return {
    kind: 'permutation',
    cells: order.map(item => order.map((_, column) => bit(Number(column === item)))),
  }
}

type AllocatedCell = {name: string, spec: CellSpec, next: Wire | undefined}
type AllocatedGroup = {rule: GroupRule, allowAllZero: boolean, declareToCircuit: boolean, members: Wire[], name: string}

export type SourceTable = ReturnType<typeof createSourceTable>

export function createSourceTable() {
  const cells: AllocatedCell[] = []
  const groups: AllocatedGroup[] = []
  let circuit: Circuit | null = null

  function allocateSpec(name: string, spec: Spec): unknown {
    invariant(circuit === null, 'cells must be allocated before createCircuit')
    if (Array.isArray(spec)) return spec.map((element: Spec, index) => allocateSpec(`${name}[${index}]`, element))
    const tagged = spec as {kind?: unknown}
    if (tagged.kind === 'cell') {
      cells.push({name, spec: spec as CellSpec, next: undefined})
      return cells.length - 1
    }
    if (tagged.kind === 'group') {
      const group = spec as GroupSpec<Spec>
      const members = group.members.map((member, index) => allocateSpec(`${name}[${index}]`, member))
      groups.push({...group, name, members: members.flatMap(leafWires)})
      return members
    }
    if (tagged.kind === 'permutation') {
      const matrix = (spec as PermutationSpec).cells.map((row, rank) =>
        row.map((member, item) => allocateSpec(`${name}[${rank}][${item}]`, member) as Wire))
      matrix.forEach((row, rank) => groups.push({rule: 'oneHot', allowAllZero: false, declareToCircuit: true, members: row, name: `${name} rank ${rank}`}))
      matrix[0]!.forEach((_, item) => groups.push({
        rule: 'oneHot', allowAllZero: false, declareToCircuit: true, members: matrix.map(row => row[item]!), name: `${name} item ${item}`,
      }))
      return matrix
    }
    const result: Record<string, unknown> = {}
    for (const [field, fieldSpec] of Object.entries(spec as Record<string, Spec>)) {
      result[field] = allocateSpec(name === '' ? field : `${name}.${field}`, fieldSpec)
    }
    return result
  }

  function scope(prefix: string) {
    return {
      allocate<S extends Spec>(name: string, spec: S): Allocated<S> {
        return allocateSpec([prefix, name].filter(part => part !== '').join('.'), spec) as Allocated<S>
      },
      scope: (child: string) => scope(prefix === '' ? child : `${prefix}.${child}`),
    }
  }

  return {
    ...scope(''),
    get size() {
      return cells.length
    },
    nameOf: (wire: Wire) => cells[wire]?.name ?? `wire ${wire}`,
    // A validator-only rule over cells that are not next to each other.
    atMostOne(name: string, members: readonly Wire[]) {
      invariant(circuit === null, 'rules must be added before createCircuit')
      groups.push({rule: 'atMostOne', allowAllZero: true, declareToCircuit: false, members: [...members], name})
    },
    createCircuit() {
      invariant(circuit === null, 'createCircuit may only run once')
      circuit = new Circuit(cells.length)
      cells.forEach(({spec}, wire) => circuit!.assumeRange(wire, spec.range[0], spec.range[1]))
      for (const group of groups) {
        if (group.declareToCircuit) circuit.assumeOneHot(group.members, group.allowAllZero)
      }
      return circuit
    },
    // Pair every state cell in `stored` with the wire under the same field name
    // or index in `next`. Field order doesn't matter, e.g. {velocity, position}
    // pairs with {position, velocity}. The whole shape is checked before any
    // cell is assigned, so a failed call leaves the table unchanged.
    next<S>(stored: S, next: S) {
      const pairs: [stored: Wire, next: Wire][] = []
      pairLeaves(stored, next, '', pairs)
      for (const [wire] of pairs) {
        const allocated = cells[wire]
        invariant(allocated !== undefined, `wire ${wire} is not a source cell`)
        invariant(allocated.spec.policy === 'state', `${allocated.name} is not a state cell`)
        invariant(allocated.next === undefined, `${allocated.name} already has a next value`)
      }
      for (const [wire, nextWire] of pairs) cells[wire]!.next = nextWire
    },
    finish() {
      invariant(circuit !== null, 'finish needs the circuit')
      const zero = circuit.affine([])
      const nextSource = cells.map((allocated, wire) => {
        if (allocated.spec.policy === 'event') return zero
        if (allocated.spec.policy !== 'state') return wire
        invariant(allocated.next !== undefined, `${allocated.name} never received a next value`)
        return allocated.next
      })
      const initialSource = Float32Array.from(cells, ({spec}) => spec.initial)
      const validate = createValidator(cells, groups)
      validate(initialSource)
      return {nextSource, initialSource, validate}
    },
  }
}

export function leafWires(struct: unknown): Wire[] {
  if (typeof struct === 'number') return [struct]
  if (Array.isArray(struct)) return struct.flatMap(leafWires)
  invariant(typeof struct === 'object' && struct !== null, 'a struct holds wires, arrays, and objects')
  return Object.values(struct).flatMap(leafWires)
}

// Walk two structs together by field name and index, collecting leaf pairs.
function pairLeaves(stored: unknown, next: unknown, path: string, pairs: [Wire, Wire][]) {
  const at = path === '' ? '' : ` at ${path}`
  if (typeof stored === 'number') {
    invariant(typeof next === 'number', `next state${at} must be a wire`)
    pairs.push([stored, next])
  } else if (Array.isArray(stored)) {
    invariant(Array.isArray(next) && next.length === stored.length, `next state${at} must be a list of ${stored.length}`)
    stored.forEach((element: unknown, index) => pairLeaves(element, next[index], `${path}[${index}]`, pairs))
  } else {
    invariant(typeof stored === 'object' && stored !== null, 'a struct holds wires, arrays, and objects')
    invariant(typeof next === 'object' && next !== null && !Array.isArray(next), `next state${at} must be an object`)
    const storedFields = Object.keys(stored).sort()
    const nextFields = Object.keys(next).sort()
    invariant(storedFields.join() === nextFields.join(), `next state${at} has fields ${nextFields.join(', ')} but the stored struct has ${storedFields.join(', ')}`)
    for (const field of storedFields) {
      pairLeaves((stored as Record<string, unknown>)[field], (next as Record<string, unknown>)[field], path === '' ? field : `${path}.${field}`, pairs)
    }
  }
}

function createValidator(cells: readonly AllocatedCell[], groups: readonly AllocatedGroup[]) {
  const minimums = Float64Array.from(cells, ({spec}) => spec.range[0])
  const maximums = Float64Array.from(cells, ({spec}) => spec.range[1])
  const bitCells = cells.flatMap(({spec}, wire) => spec.exactBit ? [wire] : [])
  const fail = (wire: Wire, value: number, rule: string) =>
    invariant(false, `${cells[wire]!.name} ${rule}, got ${value}`)
  return (source: Float32Array) => {
    invariant(source.length === cells.length, 'source table has the wrong length')
    for (let wire = 0; wire < source.length; wire++) {
      const value = source[wire]!
      if (!(value >= minimums[wire]! && value <= maximums[wire]! && Number.isFinite(value))) {
        fail(wire, value, `must be finite and within ${minimums[wire]}..${maximums[wire]}`)
      }
    }
    for (const wire of bitCells) {
      if (source[wire] !== 0 && source[wire] !== 1) fail(wire, source[wire]!, 'must be exactly 0 or 1')
    }
    for (const group of groups) {
      let mass = 0
      for (const member of group.members) mass += source[member]!
      const valid = group.rule === 'atMostOne'
        ? mass <= 1
        : mass === 1 || (group.allowAllZero && mass === 0)
      if (!valid) invariant(false, `${group.name} breaks its ${group.rule} rule with mass ${mass}`)
    }
  }
}

// Output contracts mirror the output struct. A contract leaf is a Range or
// exactBit, and applies to every wire under that place, e.g. {width: nonNegative}
// or a single Range for a whole list. Fields the contract doesn't name aren't checked.
export const exactBit = 'exactBit'
export type Contract = Range | typeof exactBit | {readonly [field: string]: Contract}

export function createOutputValidator(label: string, outputs: unknown, contract: Contract) {
  const wires: Wire[] = []
  const names: string[] = []
  const minimums: number[] = []
  const maximums: number[] = []
  const bitWires: Wire[] = []
  const bitNames: string[] = []
  function walk(struct: unknown, rule: Contract, name: string) {
    if (Array.isArray(struct)) {
      struct.forEach((element: unknown, index) => walk(element, rule, `${name}[${index}]`))
    } else if (rule === exactBit || isRange(rule)) {
      for (const wire of leafWires(struct)) {
        if (rule === exactBit) {
          bitWires.push(wire)
          bitNames.push(name)
        } else {
          wires.push(wire)
          names.push(name)
          minimums.push(rule[0])
          maximums.push(rule[1])
        }
      }
    } else {
      for (const [field, fieldRule] of Object.entries(rule)) {
        walk((struct as Record<string, unknown>)[field], fieldRule, name === '' ? field : `${name}.${field}`)
      }
    }
  }
  walk(outputs, contract, '')
  return (values: Float32Array) => {
    for (let index = 0; index < wires.length; index++) {
      const value = values[wires[index]!]!
      if (!(value >= minimums[index]! && value <= maximums[index]! && Number.isFinite(value))) {
        invariant(false, `${label} ${names[index]} must be finite and within ${minimums[index]}..${maximums[index]}, got ${value}`)
      }
    }
    for (let index = 0; index < bitWires.length; index++) {
      const value = values[bitWires[index]!]!
      if (value !== 0 && value !== 1) invariant(false, `${label} ${bitNames[index]} must be exactly 0 or 1, got ${value}`)
    }
  }
}

function isRange(rule: Contract): rule is Range {
  return Array.isArray(rule) && typeof rule[0] === 'number'
}

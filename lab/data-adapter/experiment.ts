import {Circuit, emitRelu, type Wire, validateOneHotGroups} from '../../numeric-ui-core.ts'

export const CAPACITY = 12
const COORDINATE_LIMIT = 2 ** 20
const SIZE_LIMIT = 2 ** 16
const ID_LIMIT = 65535
const SOURCE_SIZE = 4 + CAPACITY * 6
const FIELDS = ['left', 'top', 'width', 'height'] as const
const PREDICATES = ['active', 'same-id', 'first-slot'] as const
const STEPS = ['add-width', 'add-height', 'subtract-origin-x', 'subtract-origin-y', 'multiply-scale'] as const
export const TASKS = ['left', 'top', 'right', 'bottom', 'local-left', 'local-top', 'scaled-right', 'scaled-bottom'] as const
type Field = typeof FIELDS[number]
type Predicate = typeof PREDICATES[number]
type Step = typeof STEPS[number]
export type Task = typeof TASKS[number]
export type Slot = {active: boolean, id: number, left: number, top: number, width: number, height: number}
export type Scene = {slots: Slot[], selectedID: number, originX: number, originY: number, scale: number}
export type Program = {predicates: Predicate[], field: Field, steps: Step[]}
export type Answer = {found: number, value: number}
export type LookupDefinition = {predicates: Predicate[], uses: number}

function slotOffset(slot: number) {
  return 4 + slot * 6
}

export function encode(scene: Scene) {
  if (scene.slots.length !== CAPACITY) throw new Error(`expected ${CAPACITY} storage slots`)
  const source = new Float32Array(SOURCE_SIZE)
  const activeIDs = new Set<number>()
  function write(wire: number, value: number, minimum: number, maximum: number, integer = false) {
    if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
      throw new Error(`input ${wire} is outside the experiment's numeric contract`)
    }
    source[wire] = value
  }
  write(0, scene.selectedID, 0, ID_LIMIT, true)
  write(1, scene.originX, -COORDINATE_LIMIT, COORDINATE_LIMIT)
  write(2, scene.originY, -COORDINATE_LIMIT, COORDINATE_LIMIT)
  write(3, scene.scale, -4, 4)
  for (let index = 0; index < CAPACITY; index++) {
    const slot = scene.slots[index]!
    if (slot.active && activeIDs.has(slot.id)) throw new Error('active IDs must be unique')
    if (slot.active) activeIDs.add(slot.id)
    const offset = slotOffset(index)
    source[offset] = Number(slot.active)
    write(offset + 1, slot.id, 0, ID_LIMIT, true)
    write(offset + 2, slot.left, -COORDINATE_LIMIT, COORDINATE_LIMIT)
    write(offset + 3, slot.top, -COORDINATE_LIMIT, COORDINATE_LIMIT)
    write(offset + 4, slot.width, 0, SIZE_LIMIT)
    write(offset + 5, slot.height, 0, SIZE_LIMIT)
  }
  return source
}

// Native lookup and explicitly ordered FP32 arithmetic, independent of the DSL
// and circuit builder. Missing IDs are not transformed from a zero rectangle.
export function oracle(scene: Scene, task: Task): Answer {
  const rectangle = scene.slots.find(slot => slot.active && slot.id === scene.selectedID)
  if (rectangle === undefined) return {found: 0, value: 0}
  const left = Math.fround(rectangle.left)
  const top = Math.fround(rectangle.top)
  const width = Math.fround(rectangle.width)
  const height = Math.fround(rectangle.height)
  const originX = Math.fround(scene.originX)
  const originY = Math.fround(scene.originY)
  const scale = Math.fround(scene.scale)
  let value: number
  switch (task) {
    case 'left': value = left; break
    case 'top': value = top; break
    case 'right': value = Math.fround(left + width); break
    case 'bottom': value = Math.fround(top + height); break
    case 'local-left': value = Math.fround(Math.fround(left - originX) * scale); break
    case 'local-top': value = Math.fround(Math.fround(top - originY) * scale); break
    case 'scaled-right': value = Math.fround(Math.fround(left + width) * scale); break
    case 'scaled-bottom': value = Math.fround(Math.fround(top + height) * scale); break
  }
  return {found: 1, value: value === 0 ? 0 : value}
}

export function enumeratePrograms(): Program[] {
  // Predicates are conjunctions of exact bits. Reordering or repeating the
  // same predicate cannot change the result, so enumerate each subset once.
  const masks: Predicate[][] = [[]]
  for (let first = 0; first < PREDICATES.length; first++) {
    masks.push([PREDICATES[first]!])
    for (let second = first + 1; second < PREDICATES.length; second++) {
      masks.push([PREDICATES[first]!, PREDICATES[second]!])
    }
  }
  const sequences: Step[][] = [[]]
  for (const first of STEPS) {
    sequences.push([first])
    for (const second of STEPS) sequences.push([first, second])
  }
  const programs: Program[] = []
  for (const predicates of masks) {
    for (const field of FIELDS) {
      for (const steps of sequences) programs.push({predicates, field, steps})
    }
  }
  return programs
}

function declareInputs(circuit: Circuit) {
  circuit.assumeRange(0, 0, ID_LIMIT)
  circuit.assumeRange(1, -COORDINATE_LIMIT, COORDINATE_LIMIT)
  circuit.assumeRange(2, -COORDINATE_LIMIT, COORDINATE_LIMIT)
  circuit.assumeRange(3, -4, 4)
  for (let slot = 0; slot < CAPACITY; slot++) {
    const offset = slotOffset(slot)
    circuit.assumeRange(offset, 0, 1)
    circuit.assumeRange(offset + 1, 0, ID_LIMIT)
    circuit.assumeRange(offset + 2, -COORDINATE_LIMIT, COORDINATE_LIMIT)
    circuit.assumeRange(offset + 3, -COORDINATE_LIMIT, COORDINATE_LIMIT)
    circuit.assumeRange(offset + 4, 0, SIZE_LIMIT)
    circuit.assumeRange(offset + 5, 0, SIZE_LIMIT)
  }
}

function compileLookup(circuit: Circuit, predicates: readonly Predicate[]) {
  const bits = Array.from({length: CAPACITY}, (_, slot) => {
    let bit = circuit.affine([], 1)
    for (const predicate of predicates) {
      let next: Wire
      switch (predicate) {
        case 'active': next = slotOffset(slot); break
        case 'first-slot': next = circuit.affine([], Number(slot === 0)); break
        case 'same-id': {
          // IDs and their differences are small exact integers. This is an
          // integer equality construction, not a continuous comparator.
          const difference = circuit.roundAffine([[slotOffset(slot) + 1, 1], [0, -1]])
          const absolute = circuit.roundAffine([
            [emitRelu(circuit, difference), 1],
            [emitRelu(circuit, circuit.roundAffine([[difference, -1]])), 1],
          ])
          next = emitRelu(circuit, circuit.roundAffine([[absolute, -1]], 1))
          circuit.assumeRange(next, 0, 1)
          break
        }
      }
      bit = circuit.multiply(bit, next)
    }
    return bit
  })
  // Only active+ID has a justified one-hot contract for arbitrary slot order.
  // Inactive rows may deliberately repeat the selected ID.
  if (predicates.includes('active') && predicates.includes('same-id')) {
    if (!circuit.oneHotGroups.some(group => group.members.every((wire, index) => wire === bits[index]))) {
      circuit.assumeOneHot(bits, true)
    }
  }
  const count = circuit.roundAffine(bits.map(bit => [bit, 1]))
  const aboveOne = emitRelu(circuit, circuit.roundAffine([[count, 1]], -1))
  const found = circuit.roundAffine([[count, 1], [aboveOne, -1]])
  circuit.assumeRange(found, 0, 1)
  function read(field: Field) {
    const fieldOffset = 2 + FIELDS.indexOf(field)
    return circuit.roundAffine(bits.map((bit, slot) => [circuit.multiply(bit, slotOffset(slot) + fieldOffset), 1]))
  }
  return {found, read}
}

export function buildAdapter(programs: readonly Program[], reusable?: LookupDefinition) {
  const circuit = new Circuit(SOURCE_SIZE)
  declareInputs(circuit)
  const shared = reusable === undefined ? undefined : compileLookup(circuit, reusable.predicates)
  const roots: Wire[] = []
  for (const program of programs) {
    if (reusable !== undefined && !samePredicates(reusable.predicates, program.predicates)) {
      throw new Error('reusable lookup does not match a program')
    }
    const lookup = shared ?? compileLookup(circuit, program.predicates)
    let value = lookup.read(program.field)
    for (const step of program.steps) {
      switch (step) {
        case 'add-width': value = circuit.roundAffine([[value, 1], [lookup.read('width'), 1]]); break
        case 'add-height': value = circuit.roundAffine([[value, 1], [lookup.read('height'), 1]]); break
        case 'subtract-origin-x': value = circuit.roundAffine([[value, 1], [1, -1]]); break
        case 'subtract-origin-y': value = circuit.roundAffine([[value, 1], [2, -1]]); break
        case 'multiply-scale': value = circuit.multiply(value, 3); break
      }
    }
    roots.push(lookup.found, circuit.select(lookup.found, circuit.affine([], 0), value))
  }
  return {circuit, roots}
}

function samePredicates(left: readonly Predicate[], right: readonly Predicate[]) {
  return left.length === right.length && left.every((predicate, index) => predicate === right[index])
}

export function repeatedLookup(programs: readonly Program[]): LookupDefinition | null {
  let mostUsed: LookupDefinition | null = null
  for (const program of programs) {
    const uses = programs.filter(other => samePredicates(program.predicates, other.predicates)).length
    if (uses >= 2 && (mostUsed === null || uses > mostUsed.uses)) {
      mostUsed = {predicates: [...program.predicates], uses}
    }
  }
  return mostUsed
}

export function synthesize(training: readonly Scene[]) {
  const fits = TASKS.map(task => ({task, programs: [] as Program[]}))
  const examples = training.map(scene => ({source: encode(scene), targets: TASKS.map(task => oracle(scene, task))}))
  const candidates = enumeratePrograms()
  let evaluations = 0
  for (const candidate of candidates) {
    const {circuit, roots} = buildAdapter([candidate])
    const possible = TASKS.map(() => true)
    for (const example of examples) {
      const values = circuit.evaluateReference(example.source)
      evaluations++
      for (let task = 0; task < TASKS.length; task++) {
        const target = example.targets[task]!
        possible[task] = possible[task]! && values[roots[0]!] === target.found && values[roots[1]!] === target.value
      }
      if (!possible.some(Boolean)) break
    }
    for (let task = 0; task < TASKS.length; task++) {
      if (possible[task]) fits[task]!.programs.push(candidate)
    }
  }
  return {fits, candidateCount: candidates.length, evaluations}
}

export function makeScene(seed: number, activeCount: number, absent: boolean, fractional: boolean): Scene {
  if (!Number.isInteger(activeCount) || activeCount < 0 || activeCount > CAPACITY) throw new Error('invalid active count')
  let state = seed >>> 0
  function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  function coordinate() {
    return fractional ? (random() - 0.5) * 20000 : Math.floor(random() * 201) - 100
  }
  function size() {
    return fractional ? random() * 4000 : 1 + Math.floor(random() * 70)
  }
  const baseID = fractional ? 10000 + seed % 20000 : seed * 20
  const selectedID = absent || activeCount === 0 ? baseID + 19 : baseID + Math.floor(random() * activeCount)
  const slots = Array.from({length: CAPACITY}, (_, index): Slot => ({
    active: index < activeCount,
    id: index < activeCount ? baseID + index : selectedID,
    left: coordinate(), top: coordinate(), width: size(), height: size(),
  }))
  for (let index = slots.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[slots[index], slots[other]] = [slots[other]!, slots[index]!]
  }
  return {slots, selectedID, originX: coordinate(), originY: coordinate(), scale: fractional ? random() * 8 - 4 : [2, -3, 1][seed % 3]!}
}

export function trainingScenes() {
  const scenes: Scene[] = []
  for (const seed of [1, 2]) {
    for (const count of [1, 2, 3]) {
      for (const absent of [false, true]) scenes.push(makeScene(seed, count, absent, false))
    }
  }
  return scenes
}

export function heldOutScenes() {
  const scenes: Scene[] = []
  for (let seed = 1001; seed <= 1024; seed++) {
    for (const count of [0, 4, 6, 9, 12]) {
      for (const absent of count === 0 ? [true] : [false, true]) {
        const scene = makeScene(seed, count, absent, true)
        scenes.push(scene, {...scene, slots: [...scene.slots].reverse()})
      }
    }
  }
  return scenes
}

export function boundaryScenes() {
  const numbers = [
    [1 + 2 ** -24, 2 ** -24, 1, 3],
    [1, 2 ** -24, 2 ** -24, 3],
    [2 ** -149, 2 ** -149, -(2 ** -149), -2],
    [-0, 0, 0, -0],
    [COORDINATE_LIMIT - 0.0625, SIZE_LIMIT, -COORDINATE_LIMIT, 3.9],
    [-COORDINATE_LIMIT, 0.0625, COORDINATE_LIMIT, -3.9],
  ]
  return numbers.map(([left, width, origin, scale], index) => {
    const scene = makeScene(2026, 6, false, true)
    const selected = scene.slots.find(slot => slot.active && slot.id === scene.selectedID)!
    if (index < 2) {
      scene.selectedID = index === 0 ? 0 : ID_LIMIT
      selected.id = scene.selectedID
      for (const slot of scene.slots) if (!slot.active) slot.id = scene.selectedID
    }
    selected.left = left!
    selected.top = -left!
    selected.width = width!
    selected.height = width!
    scene.originX = origin!
    scene.originY = -origin!
    scene.scale = scale!
    return scene
  })
}

export function verify(programs: readonly Program[], tasks: readonly Task[], scenes: readonly Scene[], reusable?: LookupDefinition) {
  if (programs.length !== tasks.length) throw new Error('program/task count differs')
  const {circuit, roots} = buildAdapter(programs, reusable)
  const tensor = circuit.createTensorEvaluator(roots)
  let comparisons = 0
  for (const scene of scenes) {
    const source = encode(scene)
    const reference = circuit.evaluateReference(source)
    validateOneHotGroups(circuit, reference)
    const compiled = tensor(source)
    for (let index = 0; index < tasks.length; index++) {
      const expected = oracle(scene, tasks[index]!)
      const values = [expected.found, expected.value]
      for (let part = 0; part < 2; part++) {
        const output = index * 2 + part
        if (reference[roots[output]!] !== values[part] || compiled[output] !== values[part]) {
          throw new Error(`${tasks[index]} output ${part}: oracle=${values[part]}, reference=${reference[roots[output]!]}, tensor=${compiled[output]}`)
        }
        comparisons += 2
      }
    }
  }
  return {scenes: scenes.length, comparisons, operations: circuit.operations.length, layers: circuit.compileTensorProgram(roots).layers.length}
}

export function describe(program: Program) {
  const predicates = program.predicates.length === 0 ? 'all slots' : program.predicates.join(' & ')
  return `${predicates} -> read ${program.field}${program.steps.map(step => ` -> ${step}`).join('')}`
}

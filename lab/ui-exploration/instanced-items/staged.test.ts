import {expect, test} from 'bun:test'
import {Circuit, emitMaximum, emitMinimum, emitRelu, type Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {createExecutor} from './executor.ts'
import {createDuplicatedMachine, expandDuplicated, liveOperations} from './expand.ts'
import {emitGather, emitIndexOneHot} from './kit.ts'
import {StagedProgram, type Value} from './staged.ts'

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

// Zeros of either sign count as equal; the atoms never turn a signed zero into
// a different nonzero result.
export const sameOutput = (left: number, right: number) => left === right || (Number.isNaN(left) && Number.isNaN(right))

type Random = () => number

function clamp01(circuit: Circuit, value: Wire) {
  const result = circuit.affine([[emitRelu(circuit, value), 1], [emitRelu(circuit, circuit.affine([[value, 1]], -1)), -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

// Random operations over the given wires. Returns fractional values with small
// finite ranges, exact bits, scores in 0..1, and a few small affines that a
// later stage has to rebuild.
function randomOperations(circuit: Circuit, random: Random, inputs: readonly Wire[], operationCount: number) {
  const pool = [...inputs]
  const bits: Wire[] = []
  const scores: Wire[] = []
  const composable: Wire[] = []
  const pick = () => pool[Math.floor(random() * pool.length)]!
  const coefficient = () => {
    const choice = random()
    return choice < 0.3 ? 1 : choice < 0.45 ? -1 : choice < 0.55 ? 0.5 : Math.fround((random() - 0.5) * 4)
  }
  const bias = () => random() < 0.4 ? 0 : Math.fround((random() - 0.5) * 50)
  const keep = (wire: Wire) => {
    const range = circuit.ranges[wire]!
    if (Number.isFinite(range.minimum) && Number.isFinite(range.maximum) && Math.max(Math.abs(range.minimum), Math.abs(range.maximum)) <= 2 ** 16) pool.push(wire)
    return wire
  }
  for (let operation = 0; operation < operationCount; operation++) {
    switch (Math.floor(random() * 9)) {
      case 0: composable.push(keep(circuit.affine(Array.from({length: 1 + Math.floor(random() * 3)}, () => [pick(), coefficient()] as const), bias()))); break
      case 1: keep(circuit.affine(Array.from({length: 4 + Math.floor(random() * 3)}, () => [pick(), coefficient()] as const), bias())); break
      case 2: keep(circuit.roundAffine(Array.from({length: 1 + Math.floor(random() * 4)}, () => [pick(), coefficient()] as const), bias())); break
      case 3: keep(circuit.reglu([[pick(), coefficient()]], bias(), [[pick(), coefficient()]], bias())); break
      case 4: keep(circuit.multiply(pick(), pick())); break
      case 5: if (bits.length > 0) keep(circuit.select(bits[Math.floor(random() * bits.length)]!, pick(), pick())); break
      case 6: keep(random() < 0.5 ? emitMinimum(circuit, pick(), pick()) : emitMaximum(circuit, pick(), pick())); break
      case 7: {
        const score = clamp01(circuit, circuit.roundAffine([[pick(), 0.01], [pick(), -0.01]], 0.5))
        scores.push(score)
        bits.push(circuit.boolean(score))
        break
      }
      case 8: scores.push(clamp01(circuit, circuit.affine([[pick(), 0.003]], 0.5))); break
    }
  }
  if (bits.length === 0) bits.push(circuit.boolean(clamp01(circuit, circuit.roundAffine([[pick(), 0.01]], 0.5))))
  if (scores.length === 0) scores.push(clamp01(circuit, circuit.affine([[pick(), 0.002]], 0.5)))
  return {pool, bits, scores, composable}
}

function buildRandomProgram(seed: number) {
  const random = createRandom(seed)
  const program = new StagedProgram()
  const count = 1 + Math.floor(random() * 23)
  const groupCount = 1 + Math.floor(random() * count)
  const items = program.array('items', count)
  const groups = program.array('groups', groupCount)
  const sharedValues = [program.sharedCell('a', -100, 100), program.sharedCell('b', -100, 100), program.sharedCell('c', -100, 100)]
  const sharedIndex = program.sharedCell('index', 0, count - 1)
  const selector = program.sharedCell('selector', 0, 3)
  const gateCell = program.sharedCell('gate', 0, 1)
  const itemCells = [items.cell('x', -100, 100), items.cell('y', -100, 100)]
  const itemIndex = items.constant('index', Array.from({length: count}, (_, index) => index))
  const itemWeight = items.constant('weight', Array.from({length: count}, () => Math.fround(random() * 3 - 1)))
  const groupOf = items.constant('group', Array.from({length: count}, (_, index) => Math.min(groupCount - 1, Math.floor(index * groupCount / count))))
  // Every group needs an instance: the formula above covers 0..groupCount - 1 when groupCount <= count.

  const first = program.shared('first', {values: sharedValues, selector}, (circuit, input) => {
    const operations = randomOperations(circuit, random, input.values, 25)
    const oneHot = emitIndexOneHot(circuit, input.selector, 4).members
    return {values: operations.pool.slice(3, 8).concat(operations.composable.slice(0, 2)), bit: operations.bits[0]!, oneHot}
  })
  const firstMap = program.map(items, 'first map', {shared: first.values, x: itemCells, index: itemIndex, weight: itemWeight}, (circuit, input) => {
    const operations = randomOperations(circuit, random, [...input.shared, ...input.x, input.weight], 40)
    // A map stage that returns an imported shared value returns that shared
    // value, so every fractional output reads a field to stay per instance.
    const fractional = operations.pool.slice(-6).map(wire => circuit.roundAffine([[wire, 1], [input.x[0]!, 0.001]]))
    // The random bits and scores above often read only shared values, so they come out the same for
    // every instance. The first active item and the argmax read these two instead: both read the y
    // cell, which the test redraws for every instance before every step, so the selected index varies.
    const y = input.x[1]!
    const activeBit = circuit.boolean(clamp01(circuit, circuit.roundAffine([[y, 0.05]], Math.fround(-2.5 + random()))))
    const rankScore = clamp01(circuit, circuit.roundAffine([[y, 0.004], [input.weight, 0.05], [operations.scores[0]!, 0.1]], 0.45))
    return {
      fractional,
      composable: operations.composable.slice(0, 3),
      bit: operations.bits[0]!,
      score: operations.scores[0]!,
      activeBit,
      rankScore,
      offset: circuit.affine([[input.index, 1], [input.weight, 0.5]], 1),
    }
  })
  const fraction = firstMap.fractional[0]!
  const reductionOutputs: Record<string, Value> = {}
  reductionOutputs['sum'] = program.sum(fraction, 'sum')
  reductionOutputs['count'] = program.countBits(firstMap.bit, 'count')
  const sequential = program.prefixSum(firstMap.fractional[1] ?? fraction, 'sequential prefix', {bias: Math.fround(random() * 10)})
  const brentKung = program.prefixSum(firstMap.fractional[2] ?? fraction, 'brent-kung prefix', {bias: Math.fround(random() * 10), order: 'brent-kung'})
  const gate = program.shared('gate', {gateCell}, (circuit, input) => ({bit: circuit.boolean(input.gateCell)}))
  const active = program.firstActive(firstMap.activeBit, gate.bit, 'first active')
  const best = program.argmax(firstMap.rankScore, 'argmax')
  reductionOutputs['max'] = program.max(firstMap.fractional[3] ?? fraction, 'max')
  reductionOutputs['gathered'] = program.gatherAt(firstMap.fractional[4] ?? fraction, sharedIndex, 'gather at index', active.present)
  reductionOutputs['gatheredAlways'] = program.gatherAt(fraction, sharedIndex, 'gather at index, always present')
  const oneHot = program.scatter(items, sharedIndex, 'scatter bits', {present: gate.bit})
  const scattered = program.scatter(items, sharedIndex, 'scatter value', {value: sequential.total})
  const groupMaximum = program.groupMax(firstMap.fractional[5] ?? fraction, groups, groupOf, 'group max')
  const groupBack = program.gatherIndexed({maximum: groupMaximum}, items, groupOf, 'group max back')

  const second = program.shared('second', {first: first.values, reductions: Object.values(reductionOutputs), active, best, oneHot: first.oneHot, sequentialTotal: sequential.total}, (circuit, input) => {
    const operations = randomOperations(circuit, random, [...input.first, ...input.reductions, input.active.index, input.best.index, input.best.score, input.sequentialTotal], 20)
    // A gather over the imported one-hot group, which lowers to a gather read.
    const pooled = operations.pool.slice(-4)
    return {values: operations.pool.slice(-5), gathered: emitGather(circuit, input.oneHot, pooled)}
  })
  const secondMap = program.map(items, 'second map', {
    shared: [...second.values, second.gathered], fields: [...firstMap.fractional, ...firstMap.composable, firstMap.offset, sequential.before, sequential.through, brentKung.before, brentKung.through, scattered, groupBack.maximum],
    oneHot: first.oneHot, bit: oneHot, y: itemCells[1]!,
  }, (circuit, input) => {
    const operations = randomOperations(circuit, random, [...input.shared, ...input.fields, input.bit, input.y], 40)
    // A gather with shared bits and per-instance candidates.
    const gathered = emitGather(circuit, input.oneHot, input.fields.slice(0, 4).concat(input.fields.slice(0, 4)).slice(0, 4))
    const nextX = emitMinimum(circuit, emitMaximum(circuit, operations.pool.at(-1)!, circuit.affine([], -100)), circuit.affine([], 100))
    return {values: operations.pool.slice(-4), gathered, nextX}
  })
  program.output({first, firstMap, reductionOutputs, sequential, brentKung, active, best, oneHot, scattered, groupMaximum, groupBack, second, secondMap})
  program.next(itemCells[0]!, secondMap.nextX)
  const sharedCells = {a: sharedValues[0]!, b: sharedValues[1]!, c: sharedValues[2]!, index: sharedIndex, selector, gateCell}
  return {program, count, random, sharedCells, itemCells, firstMap, gate, active, best}
}

test('random staged programs: the executor matches the duplicated circuit on every output of every instance, over four steps with writeback, and the first active item and the argmax pick varied indices', () => {
  let compared = 0
  const reductionsSeen = new Set<string>()
  // Evaluations of programs with more than one instance, and how often each selection picked an index other than 0.
  const selections = {evaluations: 0, activeNonzero: 0, argmaxNonzero: 0}
  for (let seed = 1; seed <= 30; seed++) {
    const {program, count, random, sharedCells, itemCells, firstMap, gate, active, best} = buildRandomProgram(seed)
    for (const step of program.steps) if (step.kind === 'reduction') reductionsSeen.add(`${step.reduction.kind}${step.reduction.kind === 'prefix' ? ` ${step.reduction.order}` : ''}`)
    for (const prefixLowering of ['triangle', 'chain'] as const) {
      const executor = createExecutor(program, {rowsPerFunction: 1 + (seed % 9), blockSize: 1 + (seed % 5)})
      const machine = createDuplicatedMachine(expandDuplicated(program, {prefixLowering}), 'reference')
      const setBoth = (value: Value, number: number, instance = 0) => {
        executor.set(value, number, instance)
        machine.source[machine.cellWire(value.id, instance)] = number
      }
      for (const cell of [sharedCells.a, sharedCells.b, sharedCells.c]) setBoth(cell, Math.fround((random() - 0.5) * 200))
      setBoth(sharedCells.index, Math.floor(random() * count))
      setBoth(sharedCells.selector, Math.floor(random() * 4))
      setBoth(sharedCells.gateCell, random() < 0.8 ? 1 : 0)
      for (let instance = 0; instance < count; instance++) {
        for (const cell of itemCells) setBoth(cell, random() < 0.1 ? -0 : Math.fround((random() - 0.5) * 200), instance)
      }
      for (let stepIndex = 0; stepIndex < 4; stepIndex++) {
        executor.step()
        machine.step()
        for (const id of program.outputs) {
          const info = program.values[id]!
          for (let instance = 0; instance < program.count(info.axis); instance++) {
            const left = executor.get(program.handle(id), instance)
            const right = machine.read(id, instance)
            if (!sameOutput(left, right)) throw new Error(`seed ${seed} ${prefixLowering} step ${stepIndex}: ${info.name} instance ${instance}: executor ${left}, duplicated circuit ${right}`)
            compared++
          }
        }
        for (let instance = 0; instance < count; instance++) {
          const left = executor.get(itemCells[0]!, instance)
          const right = machine.source[machine.cellWire(itemCells[0]!.id, instance)]!
          if (!sameOutput(left, right)) throw new Error(`seed ${seed} writeback instance ${instance}: executor ${left}, duplicated circuit ${right}`)
        }
        if (count > 1) {
          // The selections equal what plain loops over the executor's columns pick.
          const bits = Array.from({length: count}, (_, instance) => executor.get(firstMap.activeBit, instance))
          const scores = Array.from({length: count}, (_, instance) => executor.get(firstMap.rankScore, instance))
          const firstSet = executor.get(gate.bit) === 1 ? bits.indexOf(1) : -1
          expect(executor.get(active.present)).toBe(firstSet >= 0 ? 1 : 0)
          expect(executor.get(active.index)).toBe(Math.max(0, firstSet))
          const bestIndex = executor.get(best.index)
          expect(executor.get(best.score)).toBe(scores[bestIndex]!)
          // The tournament compares with coefficients just below one half, so it may pick a score
          // within about 1e-7 of the maximum.
          expect(scores[bestIndex]!).toBeGreaterThanOrEqual(Math.max(...scores) - 1e-6)
          selections.evaluations++
          if (firstSet > 0) selections.activeNonzero++
          if (bestIndex > 0) selections.argmaxNonzero++
        }
        setBoth(sharedCells.index, Math.floor(random() * count))
        setBoth(sharedCells.gateCell, random() < 0.8 ? 1 : 0)
        for (let instance = 0; instance < count; instance++) setBoth(itemCells[1]!, Math.fround((random() - 0.5) * 200), instance)
      }
    }
  }
  expect([...reductionsSeen].sort()).toEqual(['argmax', 'firstActive', 'gatherAt', 'gatherIndexed', 'groupMax', 'max', 'prefix brent-kung', 'prefix sequential', 'scatter', 'sum'])
  expect(compared).toBeGreaterThan(50_000)
  // Measured: 232 evaluations, the first active index nonzero in 114 and the argmax index nonzero in 205.
  expect(selections.evaluations).toBeGreaterThan(150)
  expect(selections.activeNonzero / selections.evaluations).toBeGreaterThan(0.35)
  expect(selections.argmaxNonzero / selections.evaluations).toBeGreaterThan(0.7)
})

// The same two stages, built with and without the rebuild. The first stage exports a small affine with a
// fractional coefficient and bias, 0.1 × relu + 0.3, and the map stage reads it as 3 × boxWidth + factor + 2.
// Rebuilt, the map stage composes it into one sum, factor + 0.3 × relu + 2.9, as a flat circuit does.
// Imported as a stored value, the product and the bias round at a different point.
function buildRebuildProgram(rebuildSmallAffines: boolean) {
  const program = new StagedProgram({rebuildSmallAffines})
  const items = program.array('items', 3)
  const width = program.sharedCell('width', 0, 1000)
  const factor = items.constant('factor', [0.25, 0.5, 0.75])
  const first = program.shared('first', {width}, (circuit, input) => ({boxWidth: circuit.affine([[emitRelu(circuit, circuit.affine([[input.width, 1]], -1)), 0.1]], 0.3)}))
  const sized = program.map(items, 'sized', {boxWidth: first.boxWidth, factor}, (circuit, input) => ({size: circuit.affine([[input.boxWidth, 3], [input.factor, 1]], 2)}))
  program.output(sized)
  const mapStage = program.steps.find(step => step.kind === 'stage' && step.stage.name === 'sized')!
  const importedNames = mapStage.kind === 'stage' ? mapStage.stage.sourceValues.map(id => program.values[id]!.name) : []
  return {program, width, first, sized, importedNames, executor: createExecutor(program)}
}

test('a small affine exported by one stage is rebuilt and composed by the next, as in one flat circuit; importing its stored value instead changes FP32 results', () => {
  const rebuilt = buildRebuildProgram(true)
  const stored = buildRebuildProgram(false)
  expect(rebuilt.program.info(rebuilt.first.boxWidth).composite?.terms.length).toBe(1)
  expect(stored.program.info(stored.first.boxWidth).composite).toBeUndefined()
  // Rebuilt, the map stage imports the ReLU and rebuilds the box width from it. Imported cells are laid out
  // in creation order, so the per-item factor comes first, as the factor cells come before the ReLU in the flat circuit.
  expect(rebuilt.importedNames).toEqual(['items.factor', 'first.boxWidth.term0'])
  expect(stored.importedNames).toEqual(['items.factor', 'first.boxWidth'])
  const flat = new Circuit(4)
  flat.assumeRange(0, 0, 1000)
  const relu = emitRelu(flat, flat.affine([[0, 1]], -1))
  const boxWidth = flat.affine([[relu, 0.1]], 0.3)
  const flatSizes = [1, 2, 3].map(cell => {
    flat.assumeRange(cell, 0.25, 0.75)
    return flat.affine([[boxWidth, 3], [cell, 1]], 2)
  })
  const random = createRandom(2024)
  let compared = 0
  let storedDiffers = 0
  for (let trial = 0; trial < 200; trial++) {
    const widthValue = trial < 4 ? [0, 1, 13.37, 999.99][trial]! : Math.fround(random() * 1000)
    for (const built of [rebuilt, stored]) {
      built.executor.set(built.width, widthValue)
      built.executor.step()
    }
    const flatValues = flat.evaluateReference(new Float32Array([widthValue, 0.25, 0.5, 0.75]))
    flatSizes.forEach((wire, instance) => {
      compared++
      expect(rebuilt.executor.get(rebuilt.sized.size, instance)).toBe(flatValues[wire]!)
      if (stored.executor.get(stored.sized.size, instance) !== flatValues[wire]!) storedDiffers++
    })
  }
  // Measured: 252 of the 600 values differ without the rebuild.
  expect(compared).toBe(600)
  expect(storedDiffers / compared).toBeGreaterThan(0.3)
})

test('in the duplicated circuit, each instance\'s copy of a stage has exactly the stage\'s live operations', () => {
  let copies = 0
  for (let seed = 1; seed <= 30; seed += 3) {
    const {program} = buildRandomProgram(seed)
    const {circuit, wires} = expandDuplicated(program)
    for (const step of program.steps) {
      if (step.kind !== 'stage') continue
      const {stage} = step
      const stageOperations = liveOperations(stage.circuit, program.stageRoots(stage)).reduce((total, flag) => total + flag, 0)
      const instances = stage.kind === 'shared' ? 1 : program.count(stage.axis)
      for (let instance = 0; instance < instances; instance++) {
        const wireOf = (id: number) => wires[id]![program.values[id]!.axis === 'shared' ? 0 : instance]!
        // Walk back from this instance's stage outputs, stopping at the wires the stage imports for this instance.
        const imported = new Set(stage.sourceValues.map(wireOf))
        const visited = new Set<Wire>()
        const pending = stage.outputs.filter(output => program.consumed.has(output.value)).map(output => wireOf(output.value))
        while (pending.length > 0) {
          const wire = pending.pop()!
          if (imported.has(wire) || visited.has(wire)) continue
          if (wire < circuit.sourceSize) throw new Error(`seed ${seed}: stage ${stage.name}, instance ${instance} reads source wire ${wire}, which it doesn't import`)
          visited.add(wire)
          const operation = circuit.operations[wire - circuit.sourceSize]!
          for (const [dependency] of operation.leftTerms) pending.push(dependency)
          for (const [dependency] of operation.gateTerms) pending.push(dependency)
        }
        if (visited.size !== stageOperations) throw new Error(`seed ${seed}: stage ${stage.name}, instance ${instance}: ${visited.size} operations in its copy, ${stageOperations} in the stage`)
        copies++
      }
    }
  }
  expect(copies).toBeGreaterThan(50)
})

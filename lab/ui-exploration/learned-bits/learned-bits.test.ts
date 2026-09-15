import {expect, test} from 'bun:test'
import {authoredFirstActive, authoredTab, certifyCircuit, compileHardNetwork, measureProgram} from './compile.ts'
import {describeCountUnit, describeLeaders, matchPredicates, neededInputs, wiringCoverage} from './inspect.ts'
import {
  copySharedLogits,
  countExactCases,
  createNetwork,
  createRandom,
  createTrainer,
  defaultNetworkOptions,
  defaultTrainOptions,
  evaluateHard,
  harden,
  logitCount,
  setCountUnit,
  splitCases,
  sumSharedGradients,
  trainNetwork,
  type Network,
  type NetworkOptions,
} from './network.ts'
import {dragTask, firstActiveTask, menuSlotEvents, menuSlotStates, menuSlotTask, rectangleHitTask, tabTask, type Task} from './tasks.ts'

function targetIndex(task: Task, caseIndex: number) {
  for (let bit = 0; bit < task.outputCount; bit++) if (task.targets[caseIndex * task.outputCount + bit] === 1) return bit
  return -1
}

function findCase(task: Task, bits: readonly number[]) {
  for (let caseIndex = 0; caseIndex < task.caseCount; caseIndex++) {
    if (bits.every((bit, index) => task.inputs[caseIndex * task.inputCount + index] === bit)) return caseIndex
  }
  return -1
}

test('task ladder: case counts and named cases', () => {
  const tab = tabTask(6)
  expect(tab.caseCount).toBe(896)
  // Focus on control 1, controls 0 and 3 enabled: Tab goes to 3, Shift+Tab to 0.
  const focus = [0, 1, 0, 0, 0, 0]
  const enabled = [1, 0, 0, 1, 0, 0]
  expect(targetIndex(tab, findCase(tab, [...focus, ...enabled, 0]))).toBe(3)
  expect(targetIndex(tab, findCase(tab, [...focus, ...enabled, 1]))).toBe(0)
  // Nothing focused: Tab picks the first enabled, Shift+Tab the last.
  expect(targetIndex(tab, findCase(tab, [0, 0, 0, 0, 0, 0, ...enabled, 0]))).toBe(0)
  expect(targetIndex(tab, findCase(tab, [0, 0, 0, 0, 0, 0, ...enabled, 1]))).toBe(3)
  // The only enabled control keeps focus.
  expect(targetIndex(tab, findCase(tab, [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]))).toBe(3)

  const first = firstActiveTask(8)
  expect(first.caseCount).toBe(256)
  expect(targetIndex(first, findCase(first, [0, 0, 1, 0, 1, 1, 0, 0]))).toBe(2)
  expect(targetIndex(first, 0)).toBe(-1)

  // strictlyInside {left 9, top 22, width 37, height 29}: x in 10..45, y in 23..50.
  const hit = rectangleHitTask()
  expect(hit.caseCount).toBe(4096)
  expect(hit.targets.reduce((total, bit) => total + bit, 0)).toBe(36 * 28)

  // Chebyshev distance above 4 on 5-bit deltas: 9 x 9 of the 1,024 cases are clicks.
  const drag = dragTask()
  expect(drag.caseCount).toBe(1024)
  expect(drag.targets.reduce((total, bit) => total + bit, 0)).toBe(1024 - 81)

  const menu = menuSlotTask()
  expect(menu.caseCount).toBe(menuSlotStates().length * menuSlotEvents().length)
  expect(menu.inputCount).toBe(45)
  expect(menu.outputCount).toBe(16)
})

test('menu slot: Tab focuses the first title, ArrowDown skips a disabled item, releasing on an item activates it', () => {
  const task = menuSlotTask()
  const states = menuSlotStates()
  const events = menuSlotEvents()
  const caseOf = (state: {open: number, highlight: number, titleFocus: number}, eventIndex: number) => {
    const stateIndex = states.findIndex(candidate => candidate.open === state.open && candidate.highlight === state.highlight && candidate.titleFocus === state.titleFocus)
    return stateIndex * events.length + eventIndex
  }
  const keyEvent = (key: string, shift: boolean) => events.findIndex(event => event?.kind === 'key' && event.key === key && event.shift === shift)
  const outputs = (caseIndex: number) => Array.from(task.targets.subarray(caseIndex * task.outputCount, (caseIndex + 1) * task.outputCount))
  // Closed, nothing focused, Tab: title 0 gets focus (outputs 8..10 are title focus).
  expect(outputs(caseOf({open: -1, highlight: -1, titleFocus: -1}, keyEvent('Tab', false))).slice(8, 11)).toEqual([1, 0, 0])
  // Menu 0 open at item 0; item 1 is disabled, so ArrowDown highlights item 2 (outputs 3..7).
  expect(outputs(caseOf({open: 0, highlight: 0, titleFocus: 0}, keyEvent('ArrowDown', false))).slice(3, 8)).toEqual([0, 0, 1, 0, 0])
  // Menu 0 open, up over item 2's row activates item 2 and closes the menu.
  const upOnItem2 = events.findIndex(event => event?.kind === 'up' && event.x === 30 && event.y === 88)
  const released = outputs(caseOf({open: 0, highlight: 2, titleFocus: -1}, upOnItem2))
  expect(released.slice(0, 3)).toEqual([0, 0, 0])
  expect(released.slice(11, 16)).toEqual([0, 0, 1, 0, 0])
})

// Central finite differences on every `step`-th logit of every leader unit.
// Returns per layer how many logits were checked, how many have a nonzero
// analytic gradient, and the worst relative error.
function checkGradients(network: Network, task: Task, step: number) {
  const cases = Int32Array.from({length: task.caseCount}, (_, index) => index)
  const trainer = createTrainer(network, task, cases.length)
  trainer.load(cases, 0, cases.length)
  trainer.forward(0.8)
  trainer.backward(0.8)
  sumSharedGradients(network, trainer.logitGradients)
  const analytic = trainer.logitGradients.map(gradients => Float64Array.from(gradients))
  return network.layers.map((layer, l) => {
    let checked = 0
    let nonzero = 0
    let worst = 0
    for (let unit = 0; unit < layer.width; unit++) {
      if (layer.leaders[unit] !== unit) continue
      for (let index = unit * layer.logitsPerUnit; index < (unit + 1) * layer.logitsPerUnit; index += step) {
        const saved = layer.logits[index]!
        layer.logits[index] = saved + 1e-5
        copySharedLogits(network)
        const up = trainer.forward(0.8)
        layer.logits[index] = saved - 1e-5
        copySharedLogits(network)
        const down = trainer.forward(0.8)
        layer.logits[index] = saved
        copySharedLogits(network)
        const numeric = (up - down) / 2e-5
        const gradient = analytic[l]![index]!
        checked++
        if (Math.abs(gradient) > 1e-6) nonzero++
        worst = Math.max(worst, Math.abs(numeric - gradient) / Math.max(1e-6, Math.abs(numeric) + Math.abs(gradient)))
      }
    }
    return {checked, nonzero, worst}
  })
}

// Every layer checks its logits, and a quarter of them must have a nonzero
// gradient, so a layer that no output reads can't pass on zeros.
function expectGradientsMatch(layers: ReturnType<typeof checkGradients>) {
  for (const layer of layers) {
    expect(layer.nonzero).toBeGreaterThanOrEqual(layer.checked / 4)
    expect(layer.worst).toBeLessThan(1e-3)
  }
}

test('trainer gradients match finite differences for gates and every counting relaxation, through hidden wires', () => {
  const task = tabTask(3)
  const variants: Partial<NetworkOptions>[] = [
    {kind: 'gate', pool: 'previous'},
    {kind: 'count', relaxation: 'expectation', pool: 'all-earlier'},
    {kind: 'count', relaxation: 'normal', pool: 'previous'},
    {kind: 'count', relaxation: 'clamp', pool: 'previous'},
  ]
  for (const variant of variants) {
    const network = createNetwork(task, {...defaultNetworkOptions, ...variant, hiddenWidths: [4, 3], groupSize: 2, candidates: 4, thresholds: 4, initialSpread: 3, residualBias: 0, zeroBias: 0, seed: 5})
    // The first two wires of every layer after the first read the previous
    // layer, so gradients flow back through hidden wires into every layer.
    for (let l = 1; l < network.layers.length; l++) {
      const layer = network.layers[l]!
      const previous = network.layers[l - 1]!
      for (let unit = 0; unit < layer.width; unit++) {
        layer.wires[unit * layer.fanIn] = previous.offset + (unit % previous.width)
        layer.wires[unit * layer.fanIn + 1] = previous.offset + ((unit + 1) % previous.width)
      }
    }
    if (variant.relaxation === 'clamp') {
      // Weights lean toward +1 and the threshold toward 1, so s - E[t] + 1
      // falls inside the clamp's linear region on many cases.
      const random = createRandom(99)
      for (const layer of network.layers) {
        for (let unit = 0; unit < layer.width; unit++) {
          const base = unit * layer.logitsPerUnit
          for (let k = 0; k < layer.fanIn; k++) {
            for (let weight = 0; weight < 3; weight++) layer.logits[base + 3 * k + weight] = weight - 1 + (random() - 0.5)
          }
          for (let t = 0; t < 4; t++) layer.logits[base + 3 * layer.fanIn + t] = (t === 0 ? 2 : 0) + (random() - 0.5)
        }
      }
    }
    expectGradientsMatch(checkGradients(network, task, 1))
  }
})

test('with peaked logits, the expectation relaxation equals the hardened network', () => {
  const task = tabTask(4)
  const cases = Int32Array.from({length: task.caseCount}, (_, index) => index)
  for (const kind of ['count', 'gate'] as const) {
    const network = createNetwork(task, {...defaultNetworkOptions, kind, hiddenWidths: [16, 16], groupSize: 1, initialSpread: 6, residualBias: 0, zeroBias: 0, seed: 9})
    // Every softmax group gets one logit at +40 and the rest at -40.
    for (const layer of network.layers) {
      const groups = kind === 'gate' ? [[0, 16]] : [...Array.from({length: layer.fanIn}, (_, k) => [3 * k, 3]), [3 * layer.fanIn, network.options.thresholds]]
      for (let unit = 0; unit < layer.width; unit++) {
        for (const [start, size] of groups) {
          const base = unit * layer.logitsPerUnit + start!
          let best = 0
          for (let index = 1; index < size!; index++) if (layer.logits[base + index]! > layer.logits[base + best]!) best = index
          for (let index = 0; index < size!; index++) layer.logits[base + index] = index === best ? 40 : -40
        }
      }
    }
    const trainer = createTrainer(network, task, cases.length)
    trainer.load(cases, 0, cases.length)
    trainer.forward(1)
    const relaxed = trainer.relaxedOutputs()
    const {outputs} = evaluateHard(harden(network), task, null)
    let worst = 0
    for (let n = 0; n < task.caseCount; n++) {
      for (let bit = 0; bit < task.outputCount; bit++) worst = Math.max(worst, Math.abs(relaxed[bit * cases.length + n]! - outputs[n * task.outputCount + bit]!))
    }
    expect(worst).toBeLessThan(1e-6)
  }
})

test('a hand-set counting network computes first-active-8 exactly and compiles to the authored circuit', () => {
  const task = firstActiveTask(8)
  const network = createNetwork(task, {...defaultNetworkOptions, hiddenWidths: [], groupSize: 1, candidates: 8, thresholds: 8, complements: false})
  const layer = network.layers[0]!
  for (let index = 0; index < 8; index++) {
    setCountUnit(layer, index, [[index, 1], ...Array.from({length: index}, (_, earlier) => [earlier, -1] as const)], 1, 8)
  }
  expect(wiringCoverage(network, task).coveredOutputs).toBe(8)
  const hard = harden(network)
  expect(countExactCases(hard, task, null)).toBe(256)
  expect(describeCountUnit(hard.layers[0]!.weights.subarray(3 * 8, 4 * 8), 1)).toBe('one wire and none of 3')
  const compiled = compileHardNetwork(hard, task)
  expect(certifyCircuit(compiled.circuit, compiled.roots, task, hard)).toMatchObject({exact: 256, agreesWithNetlist: 256})
  const authored = authoredFirstActive(task)
  expect(measureProgram(compiled.circuit, compiled.roots)).toEqual(measureProgram(authored.circuit, authored.roots))
  expect(matchPredicates(hard, task).rediscovered).toContain('first[5]')
})

test('random hardened networks compile into circuits that equal the JS netlist on every case', () => {
  const task = tabTask(4)
  for (const kind of ['count', 'gate'] as const) {
    for (const pool of ['previous', 'all-earlier'] as const) {
      // Counting units with random logits and no residual bias mostly land on
      // thresholds above their positive count, i.e. constant 0. A residual bias
      // of 4 keeps "the first wire, and some others" alive, so outputs vary.
      const network = createNetwork(task, {...defaultNetworkOptions, kind, pool, hiddenWidths: [24, 24], groupSize: 3, initialSpread: 6, residualBias: kind === 'count' ? 4 : 0, zeroBias: 0, seed: 21})
      const hard = harden(network)
      const {circuit, roots} = compileHardNetwork(hard, task)
      expect(certifyCircuit(circuit, roots, task, hard).agreesWithNetlist).toBe(task.caseCount)
      const {outputs} = evaluateHard(hard, task, null)
      const varyingOutputBits = Array.from({length: task.outputCount}, (_, bit) => new Set(Array.from({length: task.caseCount}, (_, n) => outputs[n * task.outputCount + bit])).size > 1).filter(Boolean).length
      expect(varyingOutputBits).toBeGreaterThanOrEqual(3)
      expect(measureProgram(circuit, roots).reglu).toBeGreaterThanOrEqual(15)
    }
  }
})

test('wiring coverage: first[p] needs x[0..p], and random shared gate templates miss needed inputs', () => {
  const task = firstActiveTask(8)
  const needed = neededInputs(task)
  expect(needed.map(inputs => [...inputs].sort((a, b) => a - b))).toEqual(Array.from({length: 8}, (_, p) => Array.from({length: p + 1}, (_, input) => input)))
  // The sharing section's shared gates, seed 1: 2 random references per channel.
  const randomTemplates = createNetwork(task, {...defaultNetworkOptions, kind: 'gate', sharing: true, hiddenWidths: [32, 32], groupSize: 2, seed: 1})
  expect(wiringCoverage(randomTemplates, task, needed).coveredOutputs).toBe(0)
  expect(wiringCoverage(randomTemplates, task, needed).missing[0]).toEqual({output: 'first[0]', inputs: ['x[0]']})
  // Doubling wiring reads p and p - 1, then p and p - 2, then p and p - 4.
  const doubling = createNetwork(task, {...defaultNetworkOptions, kind: 'gate', sharing: true, wiring: 'doubling', hiddenWidths: [64, 64, 64], groupSize: 4, seed: 2})
  expect(wiringCoverage(doubling, task, needed).coveredOutputs).toBe(8)
})

test('authored Tab: input kit form reproduces 127 operations and 7 layers at 6 controls; the counting form is smaller', () => {
  const task = tabTask(6)
  const inputKit = authoredTab(task, 'input-kit')
  const counting = authoredTab(task, 'counting')
  expect(measureProgram(inputKit.circuit, inputKit.roots)).toMatchObject({liveOperations: 127, layers: 7})
  expect(measureProgram(counting.circuit, counting.roots)).toMatchObject({liveOperations: 68, layers: 6})
  expect(certifyCircuit(inputKit.circuit, inputKit.roots, task).exact).toBe(896)
  expect(certifyCircuit(counting.circuit, counting.roots, task).exact).toBe(896)
})

test('shared units: summed gradients match finite differences on every shared channel', () => {
  const task = tabTask(4)
  const sharedCount = createNetwork(task, {...defaultNetworkOptions, kind: 'count', relaxation: 'normal', candidates: 0, padding: 'zero', pool: 'all-earlier', sharing: true, hiddenWidths: [8], groupSize: 2, initialSpread: 3, residualBias: 0, zeroBias: 0, seed: 4})
  expectGradientsMatch(checkGradients(sharedCount, task, 2))
  const sharedGates = createNetwork(task, {...defaultNetworkOptions, kind: 'gate', padding: 'task', pool: 'previous', sharing: true, hiddenWidths: [8], groupSize: 2, initialSpread: 3, residualBias: 0, zeroBias: 0, seed: 4})
  // Output member m reads hidden channel m at its own position and the other
  // channel one position back, so gradients reach both hidden channels.
  const hidden = sharedGates.layers[0]!
  const output = sharedGates.layers[1]!
  for (let unit = 0; unit < output.width; unit++) {
    const position = output.positions[unit]!
    const member = unit % 2
    output.wires[2 * unit] = hidden.offset + member * 4 + position
    output.wires[2 * unit + 1] = hidden.offset + (1 - member) * 4 + ((position + 3) % 4)
  }
  expectGradientsMatch(checkGradients(sharedGates, task, 1))
})

test('one shared counting unit learns first-active-8 exactly from 60% of the cases, and compiles exactly', () => {
  const task = firstActiveTask(8)
  const network = createNetwork(task, {...defaultNetworkOptions, sharing: true, candidates: 0, relaxation: 'normal', zeroBias: 3, hiddenWidths: [], groupSize: 1, seed: 1})
  const split = splitCases(task, 0.6, 1)
  trainNetwork(network, task, split.train, {...defaultTrainOptions, steps: 1000, learningRate: 0.1, seed: 1})
  const hard = harden(network)
  expect(logitCount(network)).toBe(143)
  expect(countExactCases(hard, task, split.heldOut)).toBe(split.heldOut.length)
  expect(countExactCases(hard, task, null)).toBe(256)
  const {circuit, roots} = compileHardNetwork(hard, task)
  expect(certifyCircuit(circuit, roots, task, hard)).toMatchObject({exact: 256, agreesWithNetlist: 256})
  expect(describeLeaders(hard, task)).toHaveLength(1)
})

test('counting units learn first-active-4 from every case, and the compiled circuit is exact', () => {
  const task = firstActiveTask(4)
  const network = createNetwork(task, {...defaultNetworkOptions, hiddenWidths: [16], groupSize: 1, seed: 1})
  const cases = Int32Array.from({length: task.caseCount}, (_, index) => index)
  trainNetwork(network, task, cases, {...defaultTrainOptions, steps: 300, learningRate: 0.1})
  const hard = harden(network)
  expect(countExactCases(hard, task, null)).toBe(16)
  const {circuit, roots} = compileHardNetwork(hard, task)
  expect(certifyCircuit(circuit, roots, task).exact).toBe(16)
})

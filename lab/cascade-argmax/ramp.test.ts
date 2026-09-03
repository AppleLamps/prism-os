import {expect, test} from 'bun:test'
import {buildArgmaxTree, softCascadeOptions} from './cascade-argmax.ts'
import {defaultTrainingConfig, trainSelection} from './training.ts'

test('a single soft ramp trains the selection table before exact hardening', () => {
  for (let seed = 101; seed <= 110; seed++) {
    const run = trainSelection(seed, {...defaultTrainingConfig, softComparator: 'single-ramp'})
    expect(run.hardenedCorrect).toBe(run.caseCount)
    expect(run.hardenedExactOneHot).toBe(true)
  }
  const cascade = buildArgmaxTree(8, 'cascade', softCascadeOptions(8))
  const ramp = buildArgmaxTree(8, 'cascade', softCascadeOptions(8, 'single-ramp'))
  expect(ramp.circuit.operations.length).toBeLessThan(cascade.circuit.operations.length / 2)
})

test('hard exact decisions do not provide useful score gradients', () => {
  const tree = buildArgmaxTree(2, 'cascade')
  for (const scores of [[0.4, 0.6], [0.6, 0.4], [0.5, 0.5], [0, 2 ** -149]]) {
    const values = tree.circuit.evaluateReference(new Float32Array([...scores, 1]))
    const seeds = new Float32Array(values.length)
    seeds[tree.selected[1]!] = 1
    const gradient = tree.circuit.backpropagateReference(values, seeds)
    expect([...gradient.subarray(0, 2)]).toEqual([0, 0])
  }
})

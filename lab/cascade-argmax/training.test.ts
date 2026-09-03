import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {buildArgmaxTree, circuitOpCounts, softCascadeOptions} from './cascade-argmax.ts'
import {defaultTrainingConfig, trainSelection} from './training.ts'

test('production argmax blocks the reference backward pass; the cascade does not', () => {
  const production = buildArgmaxTree(4, 'production')
  const productionSource = new Float32Array([0.2, 0.8, 0.5, 0.1, 1])
  const productionValues = production.circuit.evaluateReference(productionSource)
  const productionGradients = new Float32Array(productionValues.length)
  // Gradient on the winner's output only. A uniform gradient over all selection outputs cancels
  // exactly, because the routes partition their parent route (selection conserves mass), and a
  // loser's path multiplies by a zero gate that the backward pass skips. The winner's path
  // multiplies by decision bits that are 1, so the gradient reaches the boolean atoms.
  productionGradients[production.selected[1]!] = 1
  assert.throws(
    () => production.circuit.backpropagateReference(productionValues, productionGradients),
    /cannot backpropagate through a boolean atom/,
  )

  // The soft cascade flows gradient from a selection output back to the score cells. The score
  // differences sit inside the soft ramp (width 1/64 here); a saturated soft decision has zero
  // slope by design, which is what the annealing schedule manages during training.
  const cascade = buildArgmaxTree(4, 'cascade', softCascadeOptions(2 ** 6))
  const cascadeSource = new Float32Array([0.2, 0.21, 0.205, 0.203, 1])
  const cascadeValues = cascade.circuit.evaluateReference(cascadeSource)
  const cascadeGradients = new Float32Array(cascadeValues.length)
  cascadeGradients[cascade.selected[1]!] = 1
  const gradients = cascade.circuit.backpropagateReference(cascadeValues, cascadeGradients)
  const scoreGradients = cascade.scoreWires.map(wire => gradients[wire]!)
  assert.ok(scoreGradients.some(gradient => gradient !== 0), `no gradient reached the scores: ${scoreGradients.join(', ')}`)
})

test('selection training through the cascade argmax: soft, annealed, hardened exact, across ten seeds', () => {
  let totalCorrect = 0
  let totalCases = 0
  for (let seed = 1; seed <= 10; seed++) {
    const run = trainSelection(seed)
    totalCorrect += run.hardenedCorrect
    totalCases += run.caseCount
    assert.equal(run.hardenedCorrect, run.caseCount, `seed ${seed}: ${run.hardenedCorrect}/${run.caseCount}`)
    assert.ok(run.hardenedExactOneHot, `seed ${seed}: hardened selection must be an exact one-hot`)
    // The final soft stage should already select every target; hardening changes nothing.
    assert.equal(run.softCorrectByStage.at(-1), run.caseCount)
  }
  assert.equal(totalCorrect, totalCases)
  assert.equal(totalCases, 10 * defaultTrainingConfig.caseCount)
})

test('soft and hard cascade trees contain no boolean atoms', () => {
  // backpropagateReference throws on any boolean atom, so this is the structural side of the
  // training demonstration: neither form has one.
  const soft = circuitOpCounts(buildArgmaxTree(8, 'cascade', softCascadeOptions(2 ** 10)).circuit)
  const hard = circuitOpCounts(buildArgmaxTree(8, 'cascade').circuit)
  assert.equal(soft.boolean, 0)
  assert.equal(hard.boolean, 0)
})

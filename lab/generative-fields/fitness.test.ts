import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {authoredFamilies, buildSource, defaultContext, slotCount} from './fields.ts'
import {createFlowLayoutMachine} from './flow-layout.ts'
import {extractSnapshot, scoreFitness, selectionScore, type LayoutSnapshot} from './fitness.ts'
import {createRandom, sampleFieldVector} from './search.ts'

const machine = createFlowLayoutMachine()

function snapshotFrom(fields: Float64Array): LayoutSnapshot {
  const source = buildSource(fields, defaultContext)
  const values = machine.evaluate(source)
  return extractSnapshot(values, machine.output, source)
}

function cloneSnapshot(snapshot: LayoutSnapshot): LayoutSnapshot {
  return {
    ...snapshot,
    x: new Float64Array(snapshot.x),
    y: new Float64Array(snapshot.y),
    width: new Float64Array(snapshot.width),
    height: new Float64Array(snapshot.height),
    visible: [...snapshot.visible],
    importance: new Float64Array(snapshot.importance),
  }
}

// The fitness gradients treat geometry entries, coveredArea, and contentBottom
// as independent inputs (each seeds its own circuit wire), so the finite
// difference check perturbs them independently too.
test('hand-derived fitness gradients match central finite differences', () => {
  const random = createRandom(0xF17_0001)
  const snapshots = [
    ...authoredFamilies().map(({fields}) => snapshotFrom(fields)),
    ...Array.from({length: 12}, () => snapshotFrom(sampleFieldVector(random))),
  ]
  let checkedCount = 0
  let kinkSkips = 0
  for (const snapshot of snapshots) {
    const {gradient} = scoreFitness(snapshot)

    function check(
      label: string,
      analytic: number,
      applyOffset: (target: LayoutSnapshot, offset: number) => void,
      epsilon: number,
    ) {
      const above = cloneSnapshot(snapshot)
      applyOffset(above, epsilon)
      const below = cloneSnapshot(snapshot)
      applyOffset(below, -epsilon)
      const valueAbove = scoreFitness(above).value
      const valueBelow = scoreFitness(below).value
      const valueCenter = scoreFitness(snapshot).value
      const forwardSlope = (valueAbove - valueCenter) / epsilon
      const backwardSlope = (valueCenter - valueBelow) / epsilon
      // A kink (abs/min/max switching sides) inside the window makes the
      // one-sided slopes disagree; the analytic subgradient is still one of
      // them, so skip the comparison there.
      if (Math.abs(forwardSlope - backwardSlope) > 1e-7 + 0.02 * Math.abs(forwardSlope)) {
        kinkSkips++
        return
      }
      const finiteDifference = (valueAbove - valueBelow) / (2 * epsilon)
      assert.ok(
        Math.abs(analytic - finiteDifference) < 1e-9 + 2e-3 * Math.abs(finiteDifference),
        `${label}: analytic ${analytic} vs finite difference ${finiteDifference}`,
      )
      checkedCount++
    }

    for (let slot = 0; slot < slotCount; slot++) {
      if (!snapshot.visible[slot]!) continue
      check(`x[${slot}]`, gradient.x[slot]!, (target, offset) => {
        target.x[slot] = target.x[slot]! + offset
      }, 1e-3)
      check(`width[${slot}]`, gradient.width[slot]!, (target, offset) => {
        target.width[slot] = target.width[slot]! + offset
      }, 1e-3)
      check(`height[${slot}]`, gradient.height[slot]!, (target, offset) => {
        target.height[slot] = target.height[slot]! + offset
      }, 1e-3)
    }
    check('coveredArea', gradient.coveredArea, (target, offset) => {
      target.coveredArea += offset
    }, 1)
    check('contentBottom', gradient.contentBottom, (target, offset) => {
      target.contentBottom += offset
    }, 1e-3)
  }
  assert.ok(checkedCount > 300, `too few gradient checks ran: ${checkedCount}`)
  assert.ok(kinkSkips < checkedCount * 0.2, `too many kink skips: ${kinkSkips} vs ${checkedCount}`)
})

test('selection score ranks every valid layout above every invalid one', () => {
  const random = createRandom(0x5C0_4E00)
  const scores: {valid: boolean, score: number}[] = []
  for (let trial = 0; trial < 200; trial++) {
    const snapshot = snapshotFrom(sampleFieldVector(random))
    const fitness = scoreFitness(snapshot)
    assert.ok(fitness.value >= 0 && fitness.value <= 1)
    scores.push({valid: snapshot.valid, score: selectionScore(snapshot, fitness.value)})
  }
  const validScores = scores.filter(entry => entry.valid).map(entry => entry.score)
  const invalidScores = scores.filter(entry => !entry.valid).map(entry => entry.score)
  assert.ok(validScores.length > 20 && invalidScores.length > 20)
  assert.ok(Math.min(...validScores) > Math.max(...invalidScores))
})

test('content richness penalizes slab layouts that fill the viewport with few slots', () => {
  const grid = snapshotFrom(authoredFamilies()[0]!.fields)
  const gridFitness = scoreFitness(grid)
  assert.equal(gridFitness.terms.contentRichness, 1)

  // A synthetic two-slab layout: perfect fill, terrible richness.
  const slab = cloneSnapshot(grid)
  for (let slot = 0; slot < slotCount; slot++) slab.visible[slot] = slot < 2
  const slabFitness = scoreFitness(slab)
  assert.equal(slabFitness.terms.contentRichness, 0.2)
})

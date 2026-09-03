import {expect, test} from 'bun:test'
import savedModel from './model.json'
import {createScene} from './data.ts'
import {measureLayout, optimizeInstance, ordinaryPreferences, preferenceLoss, prepareScene, wrapLayout} from './layout.ts'
import {createRule, itemFeatures, parameterCount, trainRule} from './model.ts'
import {heldOutScenes, measuredText, trainingExamples} from './study.ts'

test('held-out item counts, widths, crops, and long captions differ from training', () => {
  const examples = trainingExamples()
  expect(examples).toHaveLength(576)
  expect([...new Set(examples.map(example => example.features[4]!))].sort((a, b) => a - b)).toEqual([0.25, 0.5])
  const trainingWidths = new Set(examples.map(example => example.features[0]))
  for (const scene of heldOutScenes('long')) {
    expect([6, 12]).toContain(scene.items.length)
    expect(trainingWidths.has(itemFeatures(scene, 0)[0])).toBe(false)
    expect(scene.items.every(item => item.caption.length > 100)).toBe(true)
  }
})

test('all methods retain required content, reading order, captions, and strict containment', () => {
  const rule = createRule(savedModel.parameters)
  const frozenParameters = rule.source.slice(0, parameterCount)
  for (const scene of [...heldOutScenes('short'), ...heldOutScenes('long')]) {
    const searched = optimizeInstance(scene)
    const ordinary = wrapLayout(scene, ordinaryPreferences(scene))
    expect(searched.loss).toBeLessThanOrEqual(preferenceLoss(ordinary))
    expect(preferenceLoss(wrapLayout(scene, searched.preferences))).toBe(searched.loss)
    for (const layout of [ordinary, searched.layout, wrapLayout(scene, rule.preferences(scene))]) {
      const metrics = measureLayout(scene, layout)
      expect(metrics.missingContent).toBe(0)
      expect(metrics.textOverflow).toBe(0)
      expect(metrics.horizontalOverflow).toBe(0)
      expect(metrics.overlaps).toBe(0)
      expect(layout.items.map(item => item.item.id)).toEqual(scene.items.map(item => item.id))
      for (const item of layout.items) expect(item.lines.join(' ')).toBe(item.item.caption)
    }
  }
  expect(rule.source.slice(0, parameterCount)).toEqual(frozenParameters)
})

test('storage permutation and arbitrary IDs do not change the learned layout', () => {
  const scene = createScene(122, 12, 900, 'long')
  const original = prepareScene(scene, measuredText)
  const reversed = prepareScene({...scene, items: [...scene.items].reverse()}, measuredText)
  const renumbered = prepareScene({...scene, items: scene.items.map((item, index) => ({...item, id: 999 - index * 13}))}, measuredText)
  const rule = createRule(savedModel.parameters)
  expect(rule.preferences(reversed)).toEqual(rule.preferences(original))
  expect(rule.preferences(renumbered)).toEqual(rule.preferences(original))
})

test('shared circuit evaluates new features identically through both execution paths', () => {
  const rule = createRule(savedModel.parameters)
  const scene = heldOutScenes('long')[0]!
  for (let index = 0; index < scene.items.length; index++) {
    const actual = rule.predict(itemFeatures(scene, index))
    const expected = rule.circuit.evaluateReference(rule.source)[rule.output]! * 400
    expect(actual).toBe(expected)
  }
})

test('shared rule improves the authored preference on held-out scenes without fitting them', () => {
  const rule = createRule(savedModel.parameters)
  for (const content of ['short', 'long'] as const) {
    let ordinaryLoss = 0
    let sharedLoss = 0
    for (const scene of heldOutScenes(content)) {
      ordinaryLoss += preferenceLoss(wrapLayout(scene, ordinaryPreferences(scene)))
      sharedLoss += preferenceLoss(wrapLayout(scene, rule.preferences(scene)))
    }
    expect(sharedLoss).toBeLessThan(ordinaryLoss * 0.5)
  }
})

test('training is reproducible and the saved model is the first declared seed, not a held-out selection', () => {
  const trained = trainRule(trainingExamples(), savedModel.seed, savedModel.epochs)
  expect(trained.losses.at(-1)!).toBeLessThan(trained.losses[0]! * 0.2)
  expect(trained.parameters).toEqual(savedModel.parameters)
}, 10000)

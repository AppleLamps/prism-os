import metrics from './font-metrics.json'
import {createScene, type ContentKind} from './data.ts'
import {meanMovement, measureLayout, optimizeInstance, ordinaryPreferences, prepareScene, wrapLayout, type PreparedScene} from './layout.ts'
import {createRule, itemFeatures, trainRule, type TrainingExample} from './model.ts'

export function measuredText(text: string): number {
  const widths: Record<string, number> = metrics
  const width = widths[text]
  if (width === undefined) throw new Error(`Missing measured word: ${text}`)
  return width
}

export function trainingExamples() {
  const examples: TrainingExample[] = []
  for (let seed = 1; seed <= 16; seed++) {
    for (const count of [4, 8]) {
      for (const width of [480, 768, 1080]) {
        const scene = prepareScene(createScene(seed, count, width, 'short'), measuredText)
        const target = optimizeInstance(scene)
        for (let index = 0; index < count; index++) examples.push({features: itemFeatures(scene, index), target: target.preferences[index]!})
      }
    }
  }
  return examples
}

export function heldOutScenes(content: ContentKind): PreparedScene[] {
  const scenes: PreparedScene[] = []
  for (let seed = 101; seed <= 112; seed++) {
    for (const count of [6, 12]) {
      for (const width of [420, 620, 900, 1180]) scenes.push(prepareScene(createScene(seed, count, width, content), measuredText))
    }
  }
  return scenes
}

export function evaluateMethods(parameters: readonly number[], scenes: readonly PreparedScene[]) {
  const rule = createRule(parameters)
  const methods = {
    wrapping: (scene: PreparedScene) => wrapLayout(scene, ordinaryPreferences(scene)),
    perInstance: (scene: PreparedScene) => optimizeInstance(scene).layout,
    shared: (scene: PreparedScene) => wrapLayout(scene, rule.preferences(scene)),
  }
  const entries = Object.entries(methods).map(([name, calculate]) => {
    for (let warmup = 0; warmup < 20; warmup++) calculate(scenes[warmup % scenes.length]!)
    const times: number[] = []
    const movements: number[] = []
    let loss = 0
    let missing = 0
    let textOverflow = 0
    let horizontalOverflow = 0
    let overlaps = 0
    let height = 0
    for (const scene of scenes) {
      const start = performance.now()
      const layout = calculate(scene)
      times.push((performance.now() - start) * 1000)
      const result = measureLayout(scene, layout)
      loss += result.preferenceLoss
      missing += result.missingContent
      textOverflow = Math.max(textOverflow, result.textOverflow)
      horizontalOverflow = Math.max(horizontalOverflow, result.horizontalOverflow)
      overlaps += result.overlaps
      height += result.height
      movements.push(meanMovement(layout, calculate({...scene, width: scene.width + 1})))
    }
    times.sort((a, b) => a - b)
    movements.sort((a, b) => a - b)
    return [name, {
      scenes: scenes.length,
      meanPreferenceLoss: loss / scenes.length,
      missingContent: missing, maximumTextOverflow: textOverflow, maximumHorizontalOverflow: horizontalOverflow, overlaps,
      meanScrollHeight: height / scenes.length,
      medianMicroseconds: times[Math.floor(times.length / 2)]!,
      p95Microseconds: times[Math.floor(times.length * 0.95)]!,
      meanMovementForOnePixel: movements.reduce((sum, value) => sum + value, 0) / movements.length,
      p95MovementForOnePixel: movements[Math.floor(movements.length * 0.95)]!,
      maximumMovementForOnePixel: movements.at(-1)!,
    }] as const
  })
  return Object.fromEntries(entries)
}

export function measureWidthSweep(parameters: readonly number[]) {
  const rule = createRule(parameters)
  const methods = {
    wrapping: (scene: PreparedScene) => wrapLayout(scene, ordinaryPreferences(scene)),
    perInstance: (scene: PreparedScene) => optimizeInstance(scene).layout,
    shared: (scene: PreparedScene) => wrapLayout(scene, rule.preferences(scene)),
  }
  return Object.fromEntries(Object.entries(methods).map(([name, calculate]) => {
    const movements: number[] = []
    for (const content of ['short', 'long'] as const) {
      const scene = prepareScene(createScene(113, 12, 360, content), measuredText)
      let previous = calculate(scene)
      for (let width = 361; width <= 1180; width++) {
        const next = calculate({...scene, width})
        movements.push(meanMovement(previous, next))
        previous = next
      }
    }
    movements.sort((a, b) => a - b)
    return [name, {
      transitions: movements.length,
      meanMovement: movements.reduce((sum, value) => sum + value, 0) / movements.length,
      p95Movement: movements[Math.floor(movements.length * 0.95)]!,
      maximumMovement: movements.at(-1)!,
      transitionsOverTenPixels: movements.filter(movement => movement > 10).length,
    }]
  }))
}

if (import.meta.main) {
  const examples = trainingExamples()
  const results = []
  for (const seed of [17, 41, 73]) {
    const started = performance.now()
    const trained = trainRule(examples, seed)
    const trainingMilliseconds = performance.now() - started
    const short = evaluateMethods(trained.parameters, heldOutScenes('short'))
    const long = evaluateMethods(trained.parameters, heldOutScenes('long'))
    const widthSweep = measureWidthSweep(trained.parameters)
    const result = {seed, epochs: trained.epochs, trainingExamples: examples.length, initialLoss: trained.losses[0], finalLoss: trained.losses.at(-1), trainingMilliseconds, short, long, widthSweep}
    results.push(result)
    console.log(JSON.stringify(result, null, 2))
    if (process.argv.includes('--write') && seed === 17) {
      await Bun.write(`${import.meta.dir}/model.json`, `${JSON.stringify({version: 1, seed, epochs: trained.epochs, parameters: trained.parameters}, null, 2)}\n`)
    }
  }
  if (process.argv.includes('--write')) await Bun.write(`${import.meta.dir}/results.json`, `${JSON.stringify(results, null, 2)}\n`)
}

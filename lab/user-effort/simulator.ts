import {controlIDs, observationInput, type EffortInput, type Layout, type Observation} from './domain.ts'

// An authored, favorable model for testing the pipeline, not measured human behavior.
export function meanDurationMs(input: EffortInput): number {
  const difficulty = Math.log2(1 + input.distance / input.targetWidth)
  return 200 + 110 * difficulty + 180 * input.clutter + 80 * input.motorContext + 65 * input.motorContext * difficulty
}

export const noiseHalfWidthMs = 35
export const trainingLevels = {
  horizontalDistances: [60, 140, 280, 440, 600],
  widths: [24, 40, 64, 96],
  clutter: [0, 0.5, 1],
  contexts: [0, 0.5, 1],
}
export const heldOutLevels = {
  horizontalDistances: [100, 220, 360, 520],
  widths: [32, 52, 80],
  clutter: [0.25, 0.75],
  contexts: [0.25, 0.75],
}

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

export function createObservations(split: 'train' | 'held-out', seed: number): Observation[] {
  const levels = split === 'train' ? trainingLevels : heldOutLevels
  const random = createRandom(seed)
  const observations: Observation[] = []
  for (const distance of levels.horizontalDistances) {
    for (const width of levels.widths) {
      for (const clutter of levels.clutter) {
        for (const motorContext of levels.contexts) {
          const candidates: Layout[] = [0, 1, 2].map(rotation => ({
            id: `rotation-${rotation}`,
            viewport: {width: 800, height: 600},
            clutter,
            controls: controlIDs.map((id, index) => ({id, x: 64 + distance - width / 2, y: 96 + ((index + rotation) % 3) * 192 - 16, width, height: 32})),
          }))
          for (let repetition = 0; repetition < 4; repetition++) {
            // The task assignment and presentation policy are separate randomized choices.
            const task = controlIDs[Math.floor(random() * controlIDs.length)]!
            const shownLayout = candidates[Math.floor(random() * candidates.length)]!
            const observation: Observation = {
              id: `${split}-${observations.length}`,
              shownLayout,
              layoutSelectionProbability: 1 / candidates.length,
              task,
              taskAssignmentProbability: 1 / controlIDs.length,
              pointer: {x: 64, y: 288},
              motorContext,
              durationMs: 0,
            }
            observation.durationMs = meanDurationMs(observationInput(observation)) + (random() * 2 - 1) * noiseHalfWidthMs
            observations.push(observation)
          }
        }
      }
    }
  }
  return observations
}

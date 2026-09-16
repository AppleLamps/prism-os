// Synthetic photos for scaling the gallery past its 221 real photos: integer
// sizes with the aspect ratios Midjourney produces (square, portrait, landscape,
// panorama), drawn from a seeded generator so every run sees the same list.
import type {PhotoData} from './photo-data.ts'

const shapes = [[2048, 2048], [1792, 2688], [2688, 1792], [1632, 2912], [2912, 1632], [1344, 896], [896, 1344], [1536, 768], [1856, 2464], [2464, 1856], [1456, 816]] as const

export function syntheticPhotos(count: number, seed = 20260913): PhotoData[] {
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  return Array.from({length: count}, (_, index) => {
    const [w, h] = shapes[Math.floor(random() * shapes.length)]!
    // Small integer jitter, so rows don't come out identical.
    const jitter = Math.floor(random() * 97) - 48
    return {id: `synthetic-${index}`, w: w + jitter, h, prompt: `Synthetic photo ${index}`}
  })
}

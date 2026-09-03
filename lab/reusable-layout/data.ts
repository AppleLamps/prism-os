export const photoCaptions = [
  ['Misty Lake', 'Clouds settle between the peaks above a quiet island.', 'Low clouds drift between the peaks. A small island divides the still water, while the distant shoreline disappears into the mist.'],
  ['Desert Light', 'Late sunlight follows the ridges in the sand.', 'The last light of the afternoon draws a bright edge along each ridge, leaving the sheltered side of the dunes in deep shadow.'],
  ['Pacific Edge', 'Waves gather along the rocky coast.', 'A view along the Pacific coast, where long lines of surf reach the dark rocks and open water fills the horizon.'],
  ['Midnight City', 'Windows and street lights mark the evening skyline.', 'After sunset, the buildings become a collection of lit windows. The street below remains busy while the sky turns almost black.'],
  ['Forest Path', 'Stone steps climb through the green woodland.', 'The path climbs between mossy stones and tall trees. Sunlight reaches the steps through a small opening in the canopy above.'],
  ['Alpine Dawn', 'The first light reaches the mountain ridge.', 'Early sunlight reaches the high ridge before the valley below. Snow and exposed rock make a patchwork across the steep mountain face.'],
  ['Amalfi Morning', 'A coastal town catches the morning sun.', 'Buildings follow the steep hillside down toward the sea, with narrow streets connecting the terraces above the bright coastal water.'],
  ['North Falls', 'Water drops into the shaded valley.', 'Water gathers at the edge of the cliff and drops into the valley. Spray hangs above the rocks at the foot of the falls.'],
  ['Lavender Hour', 'Flowering rows stretch toward the horizon.', 'Rows of flowering plants follow the slope of the field. The spaces between them draw long lines toward the last light on the horizon.'],
  ['Concrete Curve', 'Light follows the curve of a concrete wall.', 'The curved wall changes from bright light to shadow as it turns away from the sun. Its simple outline frames a clear patch of sky.'],
  ['Blue Lagoon', 'Clear water meets a pale stretch of shore.', 'The water changes color over the shallow ground near the shore, from pale turquoise beside the beach to blue farther out.'],
  ['Autumn Road', 'A narrow road passes beneath autumn leaves.', 'The road bends between trees at the height of autumn. Fallen leaves gather at its edges and warm colors continue into the distance.'],
] as const

export const capacity = 16
export type ContentKind = 'short' | 'long'
export type PhotoItem = {
  id: number
  readingOrder: number
  photoIndex: number
  caption: string
  aspectRatio: number
  importance: number
}
export type Scene = {width: number, items: PhotoItem[]}

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

export function createScene(seed: number, count: number, width: number, content: ContentKind): Scene {
  if (count < 1 || count > capacity || !Number.isInteger(count)) throw new Error('item count must be from 1 to 16')
  const random = createRandom(seed)
  const ratios = content === 'short' ? [0.8, 1, 1.4, 1.8] : [0.55, 0.7, 1.15, 1.6, 2.2, 2.6]
  const items = Array.from({length: count}, (_, index): PhotoItem => {
    const photoIndex = (index + seed) % photoCaptions.length
    const caption = photoCaptions[photoIndex]!
    return {
      id: seed * capacity + index,
      readingOrder: index,
      photoIndex,
      caption: `${caption[0]}. ${caption[content === 'short' ? 1 : 2]}`,
      aspectRatio: ratios[Math.floor(random() * ratios.length)]!,
      importance: 0.15 + random() * 0.85,
    }
  })
  return {width, items}
}

import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {displacementMap} from '../../src/prismos/glass.ts'

const at = (map: Uint8ClampedArray, width: number, x: number, y: number) => {
  const index = (y * width + x) * 4
  return {r: map[index]!, g: map[index + 1]!, b: map[index + 2]!, a: map[index + 3]!}
}

test('a displacement map has four bytes a pixel and is neutral in the middle', () => {
  const width = 90
  const height = 40
  const map = displacementMap(width, height, 12, 10)
  assert.equal(map.length, width * height * 4)
  assert.deepEqual(at(map, width, 45, 20), {r: 128, g: 128, b: 128, a: 255})
  assert.deepEqual(at(map, width, 30, 15), {r: 128, g: 128, b: 128, a: 255})
})

test('at each edge a displacement map points inward', () => {
  const width = 90
  const height = 40
  const map = displacementMap(width, height, 12, 10)
  const left = at(map, width, 0, 20)
  const right = at(map, width, width - 1, 20)
  const top = at(map, width, 45, 0)
  const bottom = at(map, width, 45, height - 1)
  assert.ok(left.r > 200 && left.g === 128, `left ${JSON.stringify(left)}`)
  assert.ok(right.r < 56 && right.g === 128, `right ${JSON.stringify(right)}`)
  assert.ok(top.g > 200 && top.r === 128, `top ${JSON.stringify(top)}`)
  assert.ok(bottom.g < 56 && bottom.r === 128, `bottom ${JSON.stringify(bottom)}`)
  // In a corner the map points in along the diagonal, and fades toward the bezel's inner edge.
  const corner = at(map, width, 3, 3)
  assert.ok(corner.r > 128 && corner.g > 128, `corner ${JSON.stringify(corner)}`)
  assert.ok(at(map, width, 2, 20).r < left.r)
})

test('a displacement map is symmetric', () => {
  for (const [width, height, radius, bezel] of [[90, 40, 12, 10], [29, 29, 999, 9], [64, 25, 0, 6]] as const) {
    const map = displacementMap(width, height, radius, bezel)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = at(map, width, x, y)
        const mirroredX = at(map, width, width - 1 - x, y)
        const mirroredY = at(map, width, x, height - 1 - y)
        assert.equal(pixel.r + mirroredX.r, 256, `r at ${x},${y} of ${width}x${height}`)
        assert.equal(pixel.g, mirroredX.g)
        assert.equal(pixel.g + mirroredY.g, 256, `g at ${x},${y} of ${width}x${height}`)
        assert.equal(pixel.r, mirroredY.r)
      }
    }
  }
})

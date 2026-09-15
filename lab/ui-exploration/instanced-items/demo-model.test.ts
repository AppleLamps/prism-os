import {expect, test} from 'bun:test'
import {createDemoModel, demoPhotos} from './demo-model.ts'
import type {BoxStyle, GalleryView} from './gallery-host.ts'

test('the demo model runs thousands of synthetic photos, projecting only visible ones, shows photos past index 2,000 (rows past 400) when scrolled far down, and opens a photo on click', () => {
  const photos = demoPhotos(4000)
  const shown = new Map<number, BoxStyle>()
  let placeholderHeight = 0
  let scrollY = 0
  let hash = ''
  const view: GalleryView = {
    showBox: (index, style) => shown.set(index, style),
    hideBox: index => shown.delete(index),
    setBody: (_cursor, _overflow, height) => {
      placeholderHeight = height
    },
  }
  const platform = {
    read: () => ({clientWidth: 1440, clientHeight: 900, scrollX: 0, scrollY, reducedMotion: false, hash}),
    scrollTo: (top: number) => {
      scrollY = top
    },
    pushHash: (next: string) => {
      hash = next
    },
    selectPrompt: () => {},
  }
  const model = createDemoModel(photos, platform, view)
  expect(model.stats.perPhotoOperations).toBe(233)
  let now = 1000
  for (let frame = 0; frame < 40; frame++) model.frame(now += 16.5)
  expect(shown.size).toBeGreaterThan(4)
  expect(shown.size).toBeLessThan(80)
  // Far down the page: rows of 5 columns at 1440px, and the placeholder covers all of them.
  const columns = model.app.engine.output('columns')
  expect(columns).toBe(5)
  expect(placeholderHeight).toBeGreaterThan(200_000)
  scrollY = 150_000
  for (let frame = 0; frame < 40; frame++) model.frame(now += 16.5)
  const visible = [...shown.keys()]
  const firstVisible = Math.min(...visible)
  expect(firstVisible).toBeGreaterThan(2000)
  // A photo's row is its index divided by the column count, rounded down.
  expect(Math.floor(firstVisible / columns)).toBeGreaterThan(400)
  // Click the middle of a visible photo: the strip opens on it.
  const target = visible[Math.floor(visible.length / 2)]!
  const style = shown.get(target)!
  const [x, y] = style.transform.slice('translate3d('.length).match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number)
  model.app.click(x! + Number.parseFloat(style.width) / 2, y! + Number.parseFloat(style.height) / 3 - scrollY, -1)
  model.frame(now += 16.5)
  expect(hash).toBe(`#${photos[target]!.id}`)
  expect(model.hud()).toContain('4,000 photos')
})

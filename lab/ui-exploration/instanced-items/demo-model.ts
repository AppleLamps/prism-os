// The demo page's logic, kept apart from the DOM so a headless test can run it: the staged gallery
// over thousands of synthetic photos, evaluated by the staged executor, projecting only the photos
// the occlusion bits say are visible.
import {createExecutor} from './executor.ts'
import {createStagedEngine} from './gallery-engine.ts'
import {createGalleryApp, projectBoxStyle, type GalleryPlatform, type GalleryView} from './gallery-host.ts'
import {buildStagedGallery} from './gallery-staged.ts'
import {photoGalleryData, type PhotoData} from './photo-data.ts'
import {stageStats} from './staged.ts'
import {syntheticPhotos} from './synthetic-photos.ts'

export function demoPhotos(count: number): PhotoData[] {
  return count === photoGalleryData.length ? photoGalleryData : syntheticPhotos(count)
}

export type DemoModel = ReturnType<typeof createDemoModel>

export function createDemoModel(photos: readonly PhotoData[], platform: GalleryPlatform, view: GalleryView) {
  const buildStart = performance.now()
  // Brent-Kung prefix sums: at 10,000 photos, sequential sums of row heights drift by tens of pixels
  // past a million pixels down the page, and the Brent-Kung order by a few (README.md, "Precision").
  const staged = buildStagedGallery(photos, {coordinateLimit: 2 ** 24, prefixOrder: 'brent-kung'})
  const executor = createExecutor(staged.program)
  const buildMilliseconds = performance.now() - buildStart
  const engine = createStagedEngine(staged, executor)
  const app = createGalleryApp(photos, platform, view, engine)
  let perPhotoOperations = 0
  let sharedOperations = 0
  let mapStages = 0
  for (const step of staged.program.steps) {
    if (step.kind !== 'stage') continue
    const stats = stageStats(staged.program, step.stage)
    if (step.stage.axis === 'photos') {
      perPhotoOperations += stats.liveOperations
      mapStages++
    } else if (step.stage.axis === 'shared') {
      sharedOperations += stats.liveOperations
    }
  }
  const reductions = staged.program.steps.filter(step => step.kind === 'reduction').length
  const visibleColumn = executor.column(staged.photoOutputs.visible)
  const shownBefore = new Uint8Array(photos.length)
  let averageEvaluateMicroseconds = 0
  let averageProjectMicroseconds = 0
  let shown = 0
  const average = (previous: number, sample: number) => previous === 0 ? sample : previous * 0.9 + sample * 0.1
  return {
    app,
    staged,
    executor,
    stats: {photos: photos.length, perPhotoOperations, sharedOperations, mapStages, reductions, buildMilliseconds},
    // One render: evaluate the staged program, then write styles for visible photos only.
    frame(now: number): boolean {
      const start = performance.now()
      app.evaluate(now)
      const evaluated = performance.now()
      shown = 0
      for (let index = 0; index < photos.length; index++) {
        if (visibleColumn[index] === 1) {
          view.showBox(index, projectBoxStyle(engine, photos, index))
          shownBefore[index] = 1
          shown++
        } else if (shownBefore[index] === 1) {
          view.hideBox(index)
          shownBefore[index] = 0
        }
      }
      const present = engine.output('newFocusedPresent') === 1
      const cursor = engine.output('cursorZoomIn') === 1 ? 'zoom-in' : engine.output('cursorZoomOut') === 1 ? 'zoom-out' : 'auto'
      view.setBody(cursor, present ? 'hidden' : 'auto', engine.output('placeholderHeight'))
      const animating = app.sideEffects()
      const projected = performance.now()
      averageEvaluateMicroseconds = average(averageEvaluateMicroseconds, (evaluated - start) * 1000)
      averageProjectMicroseconds = average(averageProjectMicroseconds, (projected - evaluated) * 1000)
      return animating
    },
    get shown() {
      return shown
    },
    hud() {
      const format = (value: number) => Math.round(value).toLocaleString('en-US')
      return [
        `${format(photos.length)} photos, staged program`,
        `${format(perPhotoOperations)} operations per photo in ${mapStages} map stages`,
        `${format(sharedOperations)} shared operations, ${reductions} reductions`,
        `duplicated, it would be about ${format(perPhotoOperations * photos.length)} operations`,
        `evaluate: ${format(averageEvaluateMicroseconds)} µs`,
        `DOM writes for ${shown} visible photos: ${format(averageProjectMicroseconds)} µs`,
      ].join('\n')
    },
  }
}

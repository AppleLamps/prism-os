// A deterministic gallery session that needs no browser and no native index.ts, so the GPU
// scripts (Deno, Node) and the report can drive any engine through the same frames: the initial
// layout animation, hover, a click that opens the strip, arrow keys, the strip's left region,
// Escape, a scroll, a resize (anchor), opening the last photo from the URL, the edge rubber band,
// reduced motion, and a 900 ms stall.
import type {GalleryEngine} from './gallery-engine.ts'
import {initializeEngine} from './gallery-host.ts'
import type {PhotoData} from '../gallery/photo-data.ts'

export const sessionFrames = 220

export function startSession(engine: GalleryEngine, photos: readonly PhotoData[]) {
  initializeEngine(engine, photos, 1440, 900, 0)
}

// Write this frame's inputs. The URL read-back and scrollTo feedback come from the previous frame's
// outputs, like the host does.
export function applySessionFrame(engine: GalleryEngine, frame: number) {
  const count = engine.count
  if (frame > 0) {
    if (engine.output('focusChanged') === 1) {
      engine.setCell('focusedIndex', engine.output('newFocusedIndex'))
      engine.setCell('focusedPresent', engine.output('newFocusedPresent'))
    }
    if (engine.output('scrollChanged') === 1) engine.setCell('scrollY', Math.max(0, engine.output('adjustedScrollTop')))
  }
  engine.setCell('frameDuration', frame === 0 ? 0 : frame === 200 ? 900 : 16.5)
  const move = (x: number, y: number) => {
    engine.setCell('moveActive', 1)
    engine.setCell('moveX', x)
    engine.setCell('moveY', y)
  }
  const key = (name: 'keyEscape' | 'keyArrowLeft' | 'keyArrowRight') => engine.setCell(name, 1)
  switch (frame) {
    case 12: move(300, 300); break
    case 20:
      engine.setCell('clickActive', 1)
      engine.setCell('clickX', 300)
      engine.setCell('clickY', 300)
      break
    case 40: case 50: key('keyArrowRight'); break
    case 60: key('keyArrowLeft'); break
    case 70: move(50, 450); break
    case 80: key('keyEscape'); break
    case 100: engine.setCell('scrollY', 3000); break
    case 120:
      engine.setCell('windowSizeX', 1024)
      engine.setCell('windowSizeY', 700)
      break
    case 140:
      engine.setCell('focusedIndex', count - 1)
      engine.setCell('focusedPresent', 1)
      break
    case 150: key('keyArrowRight'); break
    case 160: key('keyEscape'); break
    case 180: engine.setCell('reducedMotion', 1); break
    case 190: engine.setCell('reducedMotion', 0); break
  }
}

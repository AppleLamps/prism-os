// Prism OS opens its three windows in a gentle cascade: each app sits slightly down and
// to the right of the one before it, like stacked sheets under a desk lamp.
import {
  type ArrangementCells,
  type Rectangle,
  arrangeInitialWindows,
} from '../handwiredos/arrangement.ts'

const cascadeStep = 36

// Prism OS opens on a clear desk: the three windows start minimized, each in its place
// in the dock, and Spotlight greets the visitor, see startShell. A window that is
// minimized and not present lands on its place in the dock at once, at rest, see
// hiddenAndAbsent in buildWindowManager, so nothing moves before the visitor asks.
// Written before the first step, with the arrangement, so it commits with the mount;
// each window opens later at the rectangle the arrangement gave it.
export function startInDock(source: Float32Array, cells: ArrangementCells) {
  for (const window of cells.windows) {
    source[window.minimized] = 1
    source[window.present] = 0
  }
}

// HandwiredOS's arrangement, then each window moved cascadeStep px further down and to
// the right than the one before it. A window moves only as far as the workspace has
// room for, i.e. the part of the viewport between the system bar and the dock, so every
// window stays where HandwiredOS's arrangement guarantees it fits: inside the workspace,
// on whole pixels. A window as wide or as tall as the workspace stays put on that axis.
export function arrangePrismWindows(
  source: Float32Array,
  cells: ArrangementCells,
  viewportWidth: number,
  viewportHeight: number,
): Rectangle[] {
  const tiled = arrangeInitialWindows(source, cells, viewportWidth, viewportHeight)
  const dockTop = viewportHeight - Math.min(source[cells.dockHeight]!, viewportHeight)
  return tiled.map((rectangle, windowIndex) => {
    const shift = windowIndex * cascadeStep
    const left = rectangle.left + Math.max(0, Math.min(shift, viewportWidth - rectangle.left - rectangle.width))
    const top = rectangle.top + Math.max(0, Math.min(shift, dockTop - rectangle.top - rectangle.height))
    const window = cells.windows[windowIndex]!
    const springs = cells.springs[windowIndex]!
    source[window.left] = left
    source[window.top] = top
    source[springs.centerX.destination] = left + rectangle.width / 2
    source[springs.centerY.destination] = top + rectangle.height / 2
    return {left, top, width: rectangle.width, height: rectangle.height}
  })
}

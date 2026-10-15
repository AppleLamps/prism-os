// Prism OS opens its three windows in a gentle cascade: each app sits slightly down and
// to the right of the one before it, like stacked sheets under a desk lamp.
import {
  type ArrangementCells,
  arrangeInitialWindows,
} from '../handwiredos/arrangement.ts'

const cascadeStep = 36

export function arrangePrismWindows(
  source: Float32Array,
  cells: ArrangementCells,
  viewportWidth: number,
  viewportHeight: number,
) {
  const rectangles = arrangeInitialWindows(source, cells, viewportWidth, viewportHeight)
  rectangles.forEach((rectangle, windowIndex) => {
    const shift = windowIndex * cascadeStep
    const window = cells.windows[windowIndex]!
    const springs = cells.springs[windowIndex]!
    const left = rectangle.left + shift
    const top = rectangle.top + shift
    source[window.left] = left
    source[window.top] = top
    source[springs.centerX.destination] = left + rectangle.width / 2
    source[springs.centerY.destination] = top + rectangle.height / 2
  })
  const dockTop = viewportHeight - Math.min(source[cells.dockHeight]!, viewportHeight)
  const workspaceTop = Math.min(source[cells.systemBarHeight]!, dockTop)
  const edge = source[cells.margin]!
  cells.windows.forEach((window, windowIndex) => {
    const maxLeft = viewportWidth - edge - source[window.width]!
    const maxTop = dockTop - edge - source[window.height]!
    source[window.left] = Math.min(maxLeft, Math.max(edge, source[window.left]!))
    source[window.top] = Math.min(maxTop, Math.max(workspaceTop + edge, source[window.top]!))
    const springs = cells.springs[windowIndex]!
    source[springs.centerX.destination] = source[window.left]! + source[window.width]! / 2
    source[springs.centerY.destination] = source[window.top]! + source[window.height]! / 2
  })
  return rectangles
}

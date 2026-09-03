import type {PhotoItem, Scene} from './data.ts'
import {prepareCaption, wrapCaption, type PreparedCaption, type TextMeasure} from './text.ts'

export const padding = 16
export const gap = 16
export const minimumWidth = 128
export const maximumWidth = 416
export const widthChoices = [128, 160, 192, 224, 256, 288, 320, 352, 384, 416]
export type PreparedItem = PhotoItem & {text: PreparedCaption}
export type PreparedScene = {width: number, items: PreparedItem[]}
export type PlacedItem = {
  item: PreparedItem
  left: number
  top: number
  width: number
  imageHeight: number
  height: number
  lines: string[]
  lineWidths: number[]
}
export type Layout = {items: PlacedItem[], height: number, rowCount: number, unusedRowFraction: number}

export function prepareScene(scene: Scene, measure: TextMeasure): PreparedScene {
  if (scene.width < minimumWidth + 2 * padding) throw new Error('viewport is too narrow for the caption corpus')
  return {
    width: scene.width,
    items: [...scene.items].sort((a, b) => a.readingOrder - b.readingOrder)
      .map(item => ({...item, text: prepareCaption(item.caption, measure)})),
  }
}

export function wrapLayout(scene: PreparedScene, preferences: readonly number[]): Layout {
  if (preferences.length !== scene.items.length) throw new Error('every item needs one width preference')
  const innerWidth = scene.width - 2 * padding
  const items: PlacedItem[] = []
  let left = padding
  let top = padding
  let rowHeight = 0
  let rowCount = 1
  let unused = 0
  for (let index = 0; index < scene.items.length; index++) {
    const item = scene.items[index]!
    const width = Math.min(innerWidth, maximumWidth, Math.max(minimumWidth, preferences[index]!))
    if (!Number.isFinite(width)) throw new Error('width preference must be finite')
    if (left > padding && left + width > scene.width - padding) {
      unused += (scene.width - padding - (left - gap)) / innerWidth
      top += rowHeight + gap
      left = padding
      rowHeight = 0
      rowCount++
    }
    const text = wrapCaption(item.text, width)
    const imageHeight = width / item.aspectRatio
    const height = imageHeight + 8 + text.height
    items.push({item, left, top, width, imageHeight, height, lines: text.lines, lineWidths: text.widths})
    left += width + gap
    rowHeight = Math.max(rowHeight, height)
  }
  unused += (scene.width - padding - (left - gap)) / innerWidth
  return {items, height: top + rowHeight + padding, rowCount, unusedRowFraction: unused / rowCount}
}

// This is an authored preference, not a model of human taste. Important
// photos get more area; very long captions should not become narrow columns.
export function preferenceLoss(layout: Layout): number {
  let total = 0
  for (const placed of layout.items) {
    const targetArea = 22000 * (0.7 + 1.5 * placed.item.importance)
    const areaError = (placed.width * placed.imageHeight - targetArea) / targetArea
    const excessLines = Math.max(0, placed.lines.length - 3)
    total += areaError * areaError + 0.035 * excessLines * excessLines
  }
  return total / layout.items.length + 0.08 * layout.unusedRowFraction
}

export function ordinaryPreferences(scene: PreparedScene): number[] {
  return scene.items.map(() => 224)
}

export function optimizeInstance(scene: PreparedScene) {
  const preferences = ordinaryPreferences(scene)
  let layout = wrapLayout(scene, preferences)
  let loss = preferenceLoss(layout)
  let evaluations = 1
  for (let pass = 0; pass < 2; pass++) {
    for (let index = 0; index < preferences.length; index++) {
      let bestWidth = preferences[index]!
      for (const width of widthChoices) {
        preferences[index] = width
        const candidate = wrapLayout(scene, preferences)
        const candidateLoss = preferenceLoss(candidate)
        evaluations++
        if (candidateLoss < loss) {
          loss = candidateLoss
          bestWidth = width
          layout = candidate
        }
      }
      preferences[index] = bestWidth
    }
  }
  for (const step of [16, 8, 4, 2, 1]) {
    for (let index = 0; index < preferences.length; index++) {
      const current = preferences[index]!
      let bestWidth = current
      for (const direction of [-1, 1]) {
        const width = Math.max(minimumWidth, Math.min(maximumWidth, current + direction * step))
        preferences[index] = width
        const candidate = wrapLayout(scene, preferences)
        const candidateLoss = preferenceLoss(candidate)
        evaluations++
        if (candidateLoss < loss) {
          loss = candidateLoss
          bestWidth = width
          layout = candidate
        }
      }
      preferences[index] = bestWidth
    }
  }
  return {preferences, layout, loss, evaluations}
}

export function measureLayout(scene: PreparedScene, layout: Layout) {
  const missingContent = scene.items.filter(item => !layout.items.some(placed => placed.item.id === item.id)).length
  let textOverflow = 0
  let horizontalOverflow = 0
  let overlaps = 0
  for (let index = 0; index < layout.items.length; index++) {
    const item = layout.items[index]!
    horizontalOverflow = Math.max(horizontalOverflow, padding - item.left, item.left + item.width - (scene.width - padding))
    for (const lineWidth of item.lineWidths) textOverflow = Math.max(textOverflow, lineWidth - item.width)
    for (let earlier = 0; earlier < index; earlier++) {
      const other = layout.items[earlier]!
      if (Math.min(item.left + item.width, other.left + other.width) > Math.max(item.left, other.left)
        && Math.min(item.top + item.height, other.top + other.height) > Math.max(item.top, other.top)) overlaps++
    }
  }
  return {missingContent, textOverflow, horizontalOverflow, overlaps, preferenceLoss: preferenceLoss(layout), height: layout.height}
}

export function meanMovement(before: Layout, after: Layout): number {
  let total = 0
  for (const item of before.items) {
    const next = after.items.find(candidate => candidate.item.id === item.item.id)!
    total += Math.hypot(item.left - next.left, item.top - next.top)
  }
  return total / before.items.length
}

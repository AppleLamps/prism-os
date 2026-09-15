// Seeded random widget trees and inputs for differential tests.
import {createRandom} from './circuit-tools.ts'
import {
  box,
  column,
  fit,
  fixed,
  grid,
  grow,
  input,
  padding,
  percent,
  row,
  text,
  wrap,
  type Align,
  type LayoutNode,
  type Sizing,
  type TextTable,
} from './tree.ts'

export type RandomScene = {
  root: LayoutNode
  tables: Map<string, TextTable>
  inputBounds: Map<string, readonly [number, number]>
}

export type RandomSceneOptions = {
  maxDepth: number
  maxChildren: number
  // Snap text thresholds to a 1/4 px grid, the way canvas widths usually land, to provoke ties.
  gridAlignedText: boolean
}

export function randomScene(seed: number, options: RandomSceneOptions = {maxDepth: 4, maxChildren: 4, gridAlignedText: false}): RandomScene {
  const random = createRandom(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const integer = (minimum: number, maximum: number) => minimum + Math.floor(random() * (maximum - minimum + 1))
  const snap = (value: number) => options.gridAlignedText ? Math.round(value * 4) / 4 : value
  let counter = 0
  const tables = new Map<string, TextTable>()
  const inputBounds = new Map<string, readonly [number, number]>([['viewportWidth', [0, 4096]], ['viewportHeight', [0, 4096]]])
  const sizing = (): Sizing => {
    const choice = random()
    if (choice < 0.2) return fixed(integer(0, 120))
    if (choice < 0.3) return percent(0.05 + random() * 0.45)
    if (choice < 0.35) {
      inputBounds.set('extraSize', [0, 400])
      return input('extraSize')
    }
    const minimum = random() < 0.5 ? 0 : integer(0, 50)
    const maximum = random() < 0.5 ? Number.POSITIVE_INFINITY : minimum + integer(10, 300)
    return choice < 0.65 ? fit(minimum, maximum) : grow(minimum, maximum)
  }
  const makeText = (): LayoutNode => {
    const textId = `text${counter}`
    const naturalWidth = snap(20 + random() * 280)
    const minWidth = snap(naturalWidth * (0.1 + random() * 0.5))
    const thresholdCount = integer(0, 8)
    const thresholds = Array.from({length: thresholdCount}, () => snap(minWidth + random() * (naturalWidth - minWidth)))
    tables.set(textId, {naturalWidth, minWidth, baseLines: 1, thresholds})
    return text(`node${counter++}`, textId, {width: sizing(), lineHeight: pick([14, 16, 20, 24]), capacity: thresholdCount + integer(0, 2)})
  }
  // Sticky flags on nodes where the sticky rule does not apply, e.g. a direct child of a scroll
  // column or a child of a row, come from a second stream, so the trees keep the same shapes.
  const otherStickyRandom = createRandom(seed * 7919 + 13)
  // The sticky rule applies when the node's parent is a column and a strict ancestor of that parent scrolls.
  const makeNode = (depth: number, parentIsColumn: boolean, scrollAboveParent: boolean, parentScrolls: boolean): LayoutNode => {
    const sticky = parentIsColumn && scrollAboveParent ? random() < 0.4 : otherStickyRandom() < 0.15
    if (depth > 0 && (depth >= options.maxDepth || random() < 0.3)) {
      return random() < 0.5 ? box(`node${counter++}`, sizing(), sizing(), sticky) : makeText()
    }
    const layout = pick(['row', 'row', 'column', 'column', 'wrap', 'grid'] as const)
    const name = `node${counter++}`
    const scrollY = layout === 'column' && depth > 0 && random() < 0.35 ? `scroll${counter}` : undefined
    if (scrollY !== undefined) inputBounds.set(scrollY, [0, 4000])
    const childCount = integer(0, options.maxChildren)
    const children = Array.from({length: childCount}, () =>
      makeNode(depth + 1, layout === 'column', scrollAboveParent || parentScrolls, scrollY !== undefined))
    const containerOptions = {
      name,
      width: depth === 0 ? grow() : sizing(),
      height: depth === 0 ? grow() : sizing(),
      padding: padding(integer(0, 12), integer(0, 12), integer(0, 12), integer(0, 12)),
      gap: integer(0, 12),
      alignX: pick<Align>(['start', 'center', 'end']),
      alignY: pick<Align>(['start', 'center', 'end']),
      sticky,
      ...(scrollY === undefined ? {} : {scrollY}),
    }
    if (layout === 'grid') return grid({...containerOptions, minCellWidth: integer(40, 200), maxColumns: integer(1, 5)}, children)
    if (layout === 'row') return row(containerOptions, children)
    if (layout === 'wrap') return wrap(containerOptions, children)
    return column(containerOptions, children)
  }
  return {root: makeNode(0, false, false, false), tables, inputBounds}
}

export function randomInputs(scene: RandomScene, random: () => number): Record<string, number> {
  const inputs: Record<string, number> = {}
  for (const [name, [minimum, maximum]] of scene.inputBounds) {
    const cap = name === 'viewportWidth' ? 1600 : name === 'viewportHeight' ? 1200 : maximum
    inputs[name] = Math.floor(Math.max(minimum, 60) + random() * (cap - Math.max(minimum, 60)))
  }
  return inputs
}

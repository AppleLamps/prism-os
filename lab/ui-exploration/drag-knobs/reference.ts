// Plain float64 JavaScript layout, written independently of the circuit builder.
// Copied from lab/ui-exploration/layout-tree and extended with knob values: every Amount in
// the tree reads its knob's value, and a text with a font scale measures its prepared table
// times that scale. It follows the semantics documented at the top of tree.ts with ordinary
// loops: grow and shrink sort breakpoints and solve for the level on the interval that
// contains it, wrap walks children once, grids loop over rows. It shares only the node types,
// amountValue and the fitEpsilon constant with tree.ts.
import {
  amountValue,
  fitEpsilon,
  walk,
  type Align,
  type Amount,
  type ContainerNode,
  type KnobValues,
  type LayoutNode,
  type LayoutResult,
  type Sizing,
  type TextNode,
  type TextTable,
} from './tree.ts'

export type LayoutInputs = Readonly<Record<string, number>>

export function lineCount(table: TextTable, width: number): number {
  let lines = table.baseLines
  for (const threshold of table.thresholds) if (width < threshold) lines++
  return lines
}

export function scaleTable(table: TextTable, scale: number): TextTable {
  if (scale === 1) return table
  return {
    naturalWidth: table.naturalWidth * scale,
    minWidth: table.minWidth * scale,
    baseLines: table.baseLines,
    thresholds: table.thresholds.map(threshold => threshold * scale),
  }
}

// Sizes clamp(level, lows[i], highs[i]) whose sum is `total`, assuming lows[i] <= highs[i].
// Below the smallest possible sum every size is its low; above the largest, its high.
export function solveWaterLevel(lows: readonly number[], highs: readonly number[], total: number): number[] {
  const count = lows.length
  if (count === 0) return []
  let sumLow = 0
  let sumHigh = 0
  for (let index = 0; index < count; index++) {
    sumLow += lows[index]!
    sumHigh += highs[index]!
  }
  if (total <= sumLow) return [...lows]
  if (total >= sumHigh) return [...highs]
  const sumAt = (level: number) => {
    let sum = 0
    for (let index = 0; index < count; index++) sum += Math.min(Math.max(level, lows[index]!), highs[index]!)
    return sum
  }
  const points = [...new Set([...lows, ...highs.filter(Number.isFinite)])].sort((left, right) => left - right)
  let previous = points[0]!
  let previousSum = sumAt(previous)
  let level: number | null = null
  for (let index = 1; index < points.length; index++) {
    const point = points[index]!
    const pointSum = sumAt(point)
    if (pointSum >= total) {
      level = previous + (total - previousSum) * (point - previous) / (pointSum - previousSum)
      break
    }
    previous = point
    previousSum = pointSum
  }
  if (level === null) {
    // Past every finite breakpoint, only the children without a max still rise.
    const rising = highs.filter(high => high === Number.POSITIVE_INFINITY).length
    level = previous + (total - previousSum) / rising
  }
  const finalLevel = level
  return lows.map((low, index) => Math.min(Math.max(finalLevel, low), highs[index]!))
}

type Axis = {fit: number, min: number}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)
const alignmentFactor = (align: Align) => align === 'start' ? 0 : align === 'center' ? 0.5 : 1
// When content overflows, a row may shrink its fit and grow children along x, and a column
// along y. Texts count along y too, but a text's min height equals its fit height, so it never moves.
const canShrink = (child: LayoutNode, axis: 'x' | 'y') => {
  if (axis === 'y' && child.kind === 'text') return true
  const sizing = axis === 'x' ? child.width : child.height
  return sizing.kind === 'fit' || sizing.kind === 'grow'
}

export function layoutReference(root: LayoutNode, inputs: LayoutInputs, tables: ReadonlyMap<string, TextTable>, knobs: KnobValues = {}): LayoutResult {
  const inputValue = (name: string) => {
    const value = inputs[name]
    if (value === undefined) throw new Error(`missing input ${name}`)
    return value
  }
  const value = (amount: Amount) => amountValue(amount, knobs)
  const tableOf = (node: TextNode) => {
    const table = tables.get(node.textId)
    if (table === undefined) throw new Error(`missing text table ${node.textId}`)
    return scaleTable(table, value(node.fontScale))
  }
  const sized = (sizing: Sizing, content: number, contentMin: number): Axis => {
    switch (sizing.kind) {
      case 'fixed': return {fit: sizing.size, min: sizing.size}
      case 'input': {
        const size = inputValue(sizing.input)
        return {fit: size, min: size}
      }
      case 'percent': return {fit: 0, min: 0}
      case 'fit':
      case 'grow': return {fit: clamp(content, sizing.min, sizing.max), min: clamp(contentMin, sizing.min, sizing.max)}
    }
  }
  const crossSize = (sizing: Sizing, axis: Axis, inner: number) => {
    switch (sizing.kind) {
      case 'percent': return inner * sizing.fraction
      case 'fixed':
      case 'input': return axis.fit
      case 'grow': return Math.max(axis.min, Math.min(inner, sizing.max))
      case 'fit': return Math.max(axis.min, Math.min(axis.fit, inner))
    }
  }

  const widthAxis = new Map<LayoutNode, Axis>()
  const heightAxis = new Map<LayoutNode, Axis>()
  const width = new Map<LayoutNode, number>()
  const height = new Map<LayoutNode, number>()
  const x = new Map<LayoutNode, number>()
  const y = new Map<LayoutNode, number>()
  const result: LayoutResult = {rects: new Map(), lines: new Map(), scroll: new Map(), wrapLines: new Map(), gridColumns: new Map()}
  type WrapInfo = {lineOf: number[], offsets: number[], lineUsed: number[], lineHeights: number[], lineTops: number[]}
  const wrapInfo = new Map<ContainerNode, WrapInfo>()
  type GridInfo = {columns: number, cellWidth: number, rowHeights: number[], rowTops: number[]}
  const gridInfo = new Map<ContainerNode, GridInfo>()
  const get = <T>(map: Map<LayoutNode, T>, node: LayoutNode) => {
    const found = map.get(node)
    if (found === undefined) throw new Error(`${node.name}: value used before its pass`)
    return found
  }

  // Pass 1: fit widths, children first.
  const measureWidths = (node: LayoutNode) => {
    let content = 0
    let contentMin = 0
    if (node.kind === 'text') {
      content = tableOf(node).naturalWidth
      contentMin = tableOf(node).minWidth
    } else if (node.kind === 'container') {
      for (const child of node.children) measureWidths(child)
      const count = node.children.length
      const paddingX = value(node.padding.left) + value(node.padding.right)
      const gap = value(node.gap)
      const gaps = gap * Math.max(0, count - 1)
      const fits = node.children.map(child => child.width.kind === 'percent' ? 0 : get(widthAxis, child).fit)
      const mins = node.children.map(child => get(widthAxis, child).min)
      if (node.layout === 'row') {
        content = paddingX + fits.reduce((sum, item) => sum + item, 0) + gaps
        contentMin = paddingX + mins.reduce((sum, item) => sum + item, 0) + gaps
      } else if (node.layout === 'column') {
        content = paddingX + Math.max(0, ...fits)
        contentMin = paddingX + Math.max(0, ...mins)
      } else if (node.layout === 'wrap') {
        content = paddingX + fits.reduce((sum, item) => sum + item, 0) + gaps
        contentMin = paddingX + Math.max(0, ...mins)
      } else {
        const columns = Math.min(count, node.maxColumns)
        const minCellWidth = value(node.minCellWidth)
        content = paddingX + columns * minCellWidth + Math.max(0, columns - 1) * gap
        contentMin = paddingX + (count > 0 ? minCellWidth : 0)
      }
    }
    widthAxis.set(node, sized(node.width, content, contentMin))
  }

  // Pass 2: widths, parents first. Text line counts follow each text's final width.
  const resolveWidths = (node: LayoutNode) => {
    if (node.kind === 'text') {
      result.lines.set(node.name, lineCount(tableOf(node), get(width, node)))
      return
    }
    if (node.kind !== 'container') return
    const inner = get(width, node) - value(node.padding.left) - value(node.padding.right)
    const count = node.children.length
    const gap = value(node.gap)
    const gaps = gap * Math.max(0, count - 1)
    const sizes = node.children.map(child => get(widthAxis, child).fit)
    if (node.layout === 'row') {
      node.children.forEach((child, index) => {
        if (child.width.kind === 'percent') sizes[index] = (inner - gaps) * child.width.fraction
      })
      const free = inner - (sizes.reduce((sum, item) => sum + item, 0) + gaps)
      if (free > 0) {
        const growing = node.children.flatMap((child, index) => child.width.kind === 'grow' ? [index] : [])
        const lows = growing.map(index => sizes[index]!)
        const highs = growing.map(index => (node.children[index]!.width as {max: number}).max)
        const solved = solveWaterLevel(lows, highs, lows.reduce((sum, item) => sum + item, 0) + free)
        growing.forEach((index, position) => { sizes[index] = solved[position]! })
      } else if (free < 0) {
        const shrinking = node.children.flatMap((child, index) => canShrink(child, 'x') ? [index] : [])
        const lows = shrinking.map(index => get(widthAxis, node.children[index]!).min)
        const highs = shrinking.map(index => sizes[index]!)
        const solved = solveWaterLevel(lows, highs, highs.reduce((sum, item) => sum + item, 0) + free)
        shrinking.forEach((index, position) => { sizes[index] = solved[position]! })
      }
    } else if (node.layout === 'column') {
      node.children.forEach((child, index) => { sizes[index] = crossSize(child.width, get(widthAxis, child), inner) })
    } else if (node.layout === 'wrap') {
      node.children.forEach((child, index) => {
        const axis = get(widthAxis, child)
        if (child.width.kind === 'percent') sizes[index] = inner * child.width.fraction
        else if (child.width.kind === 'fit' || child.width.kind === 'grow') sizes[index] = Math.max(axis.min, Math.min(axis.fit, inner))
      })
      const info: WrapInfo = {lineOf: [], offsets: [], lineUsed: [], lineHeights: [], lineTops: []}
      let used = 0
      sizes.forEach((size, index) => {
        if (index > 0 && used + gap + size <= inner + fitEpsilon) {
          info.lineOf.push(info.lineOf.at(-1)!)
          info.offsets.push(used + gap)
          used += gap + size
          info.lineUsed[info.lineUsed.length - 1] = used
        } else {
          info.lineOf.push(index === 0 ? 0 : info.lineOf.at(-1)! + 1)
          info.offsets.push(0)
          used = size
          info.lineUsed.push(used)
        }
      })
      wrapInfo.set(node, info)
      result.wrapLines.set(node.name, info.lineOf)
    } else {
      const minCellWidth = value(node.minCellWidth)
      let columns = 1
      for (let candidate = 2; candidate <= node.maxColumns; candidate++) {
        if (inner + fitEpsilon >= candidate * minCellWidth + (candidate - 1) * gap) columns++
      }
      const cellWidth = (inner - (columns - 1) * gap) / columns
      sizes.fill(cellWidth)
      gridInfo.set(node, {columns, cellWidth, rowHeights: [], rowTops: []})
      result.gridColumns.set(node.name, columns)
    }
    node.children.forEach((child, index) => {
      width.set(child, sizes[index]!)
      resolveWidths(child)
    })
  }

  // Pass 3: fit heights, children first.
  const measureHeights = (node: LayoutNode) => {
    if (node.kind === 'text') {
      const textHeight = result.lines.get(node.name)! * node.lineHeight * value(node.fontScale)
      heightAxis.set(node, {fit: textHeight, min: textHeight})
      return
    }
    let content = 0
    let contentMin = 0
    if (node.kind === 'container') {
      for (const child of node.children) measureHeights(child)
      const count = node.children.length
      const paddingY = value(node.padding.top) + value(node.padding.bottom)
      const gap = value(node.gap)
      const gaps = gap * Math.max(0, count - 1)
      const fits = node.children.map(child => child.height.kind === 'percent' ? 0 : get(heightAxis, child).fit)
      const mins = node.children.map(child => get(heightAxis, child).min)
      if (node.layout === 'column') {
        content = paddingY + fits.reduce((sum, item) => sum + item, 0) + gaps
        contentMin = node.scrollY !== null ? paddingY : paddingY + mins.reduce((sum, item) => sum + item, 0) + gaps
      } else if (node.layout === 'row') {
        content = paddingY + Math.max(0, ...fits)
        contentMin = paddingY + Math.max(0, ...mins)
      } else if (node.layout === 'wrap') {
        const info = wrapInfo.get(node)!
        fits.forEach((fitHeight, index) => {
          const line = info.lineOf[index]!
          info.lineHeights[line] = Math.max(info.lineHeights[line] ?? 0, fitHeight)
        })
        let top = 0
        info.lineHeights.forEach((lineHeight, line) => {
          info.lineTops[line] = top
          top += lineHeight + gap
        })
        content = paddingY + (info.lineHeights.length === 0 ? 0 : top - gap)
        contentMin = content
      } else {
        const info = gridInfo.get(node)!
        const rows = Math.ceil(count / info.columns)
        let top = 0
        for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
          let rowHeight = 0
          for (let index = rowIndex * info.columns; index < Math.min(count, (rowIndex + 1) * info.columns); index++) {
            rowHeight = Math.max(rowHeight, fits[index]!)
          }
          info.rowHeights.push(rowHeight)
          info.rowTops.push(top)
          top += rowHeight + gap
        }
        content = paddingY + (rows === 0 ? 0 : top - gap)
        contentMin = content
      }
    }
    heightAxis.set(node, sized(node.height, content, contentMin))
  }

  // Pass 4: heights, parents first.
  const resolveHeights = (node: LayoutNode) => {
    if (node.kind !== 'container') return
    const inner = get(height, node) - value(node.padding.top) - value(node.padding.bottom)
    const count = node.children.length
    const gaps = value(node.gap) * Math.max(0, count - 1)
    const sizes = node.children.map(child => get(heightAxis, child).fit)
    if (node.layout === 'column') {
      node.children.forEach((child, index) => {
        if (child.height.kind === 'percent') sizes[index] = (inner - gaps) * child.height.fraction
      })
      const free = inner - (sizes.reduce((sum, item) => sum + item, 0) + gaps)
      if (free > 0) {
        const growing = node.children.flatMap((child, index) => child.kind !== 'text' && child.height.kind === 'grow' ? [index] : [])
        const lows = growing.map(index => sizes[index]!)
        const highs = growing.map(index => (node.children[index]!.height as {max: number}).max)
        const solved = solveWaterLevel(lows, highs, lows.reduce((sum, item) => sum + item, 0) + free)
        growing.forEach((index, position) => { sizes[index] = solved[position]! })
      } else if (free < 0 && node.scrollY === null) {
        const shrinking = node.children.flatMap((child, index) => canShrink(child, 'y') ? [index] : [])
        const lows = shrinking.map(index => get(heightAxis, node.children[index]!).min)
        const highs = shrinking.map(index => sizes[index]!)
        const solved = solveWaterLevel(lows, highs, highs.reduce((sum, item) => sum + item, 0) + free)
        shrinking.forEach((index, position) => { sizes[index] = solved[position]! })
      }
    } else if (node.layout === 'row') {
      node.children.forEach((child, index) => { sizes[index] = crossSize(child.height, get(heightAxis, child), inner) })
    } else if (node.layout === 'grid') {
      const info = gridInfo.get(node)!
      node.children.forEach((_, index) => { sizes[index] = info.rowHeights[Math.floor(index / info.columns)]! })
    }
    node.children.forEach((child, index) => {
      height.set(child, sizes[index]!)
      resolveHeights(child)
    })
  }

  // Pass 5: positions, parents first.
  // scrollAbove is the nearest scroll container among the node's strict ancestors.
  const place = (node: LayoutNode, scrollAbove: ContainerNode | null) => {
    result.rects.set(node.name, {x: get(x, node), y: get(y, node), width: get(width, node), height: get(height, node)})
    if (node.kind !== 'container') return
    const left = get(x, node)
    const top = get(y, node)
    const paddingLeft = value(node.padding.left)
    const paddingTop = value(node.padding.top)
    const innerWidth = get(width, node) - paddingLeft - value(node.padding.right)
    const innerHeight = get(height, node) - paddingTop - value(node.padding.bottom)
    const count = node.children.length
    const gap = value(node.gap)
    const gaps = gap * Math.max(0, count - 1)
    const widths = node.children.map(child => get(width, child))
    const heights = node.children.map(child => get(height, child))
    if (node.layout === 'row') {
      const used = widths.reduce((sum, item) => sum + item, 0) + gaps
      let offset = paddingLeft + alignmentFactor(node.alignX) * Math.max(0, innerWidth - used)
      node.children.forEach((child, index) => {
        x.set(child, left + offset)
        y.set(child, top + paddingTop + alignmentFactor(node.alignY) * (innerHeight - heights[index]!))
        offset += widths[index]! + gap
      })
    } else if (node.layout === 'column') {
      const used = heights.reduce((sum, item) => sum + item, 0) + gaps
      let scrollOffset = 0
      if (node.scrollY !== null) {
        const contentHeight = paddingTop + value(node.padding.bottom) + used
        scrollOffset = clamp(inputValue(node.scrollY), 0, Math.max(0, contentHeight - get(height, node)))
        result.scroll.set(node.name, scrollOffset)
      }
      let offset = paddingTop + alignmentFactor(node.alignY) * Math.max(0, innerHeight - used)
      node.children.forEach((child, index) => {
        x.set(child, left + paddingLeft + alignmentFactor(node.alignX) * (innerWidth - widths[index]!))
        let childTop = top + offset - scrollOffset
        // The sticky rule applies only when this column sits strictly inside a scroll container.
        if (child.sticky && scrollAbove !== null) {
          childTop = Math.max(childTop, Math.min(get(y, scrollAbove), top + get(height, node) - value(node.padding.bottom) - heights[index]!))
        }
        y.set(child, childTop)
        offset += heights[index]! + gap
      })
    } else if (node.layout === 'wrap') {
      const info = wrapInfo.get(node)!
      node.children.forEach((child, index) => {
        const line = info.lineOf[index]!
        const lineStart = paddingLeft + alignmentFactor(node.alignX) * Math.max(0, innerWidth - info.lineUsed[line]!)
        x.set(child, left + lineStart + info.offsets[index]!)
        y.set(child, top + paddingTop + info.lineTops[line]! + alignmentFactor(node.alignY) * (info.lineHeights[line]! - heights[index]!))
      })
    } else {
      const info = gridInfo.get(node)!
      node.children.forEach((child, index) => {
        x.set(child, left + paddingLeft + (index % info.columns) * (info.cellWidth + gap))
        y.set(child, top + paddingTop + info.rowTops[Math.floor(index / info.columns)]!)
      })
    }
    const scrollAboveChildren = node.layout === 'column' && node.scrollY !== null ? node : scrollAbove
    for (const child of node.children) place(child, scrollAboveChildren)
  }

  const rootSize = (sizing: Sizing, viewport: number) => {
    switch (sizing.kind) {
      case 'fixed': return sizing.size
      case 'input': return inputValue(sizing.input)
      case 'percent': return viewport * sizing.fraction
      case 'fit':
      case 'grow': return clamp(viewport, sizing.min, sizing.max)
    }
  }
  measureWidths(root)
  width.set(root, rootSize(root.width, inputValue('viewportWidth')))
  resolveWidths(root)
  measureHeights(root)
  height.set(root, rootSize(root.height, inputValue('viewportHeight')))
  resolveHeights(root)
  x.set(root, 0)
  y.set(root, 0)
  place(root, null)
  return result
}

// How many rows, columns and wraps overflow horizontally in a finished layout, by the rule at
// the top of tree.ts, computed from rectangles alone.
export function overflowCountReference(root: LayoutNode, layout: LayoutResult, knobs: KnobValues = {}): number {
  let count = 0
  for (const {node} of walk(root)) {
    if (node.kind !== 'container' || node.layout === 'grid' || node.children.length === 0) continue
    const rect = layout.rects.get(node.name)!
    const inner = rect.width - amountValue(node.padding.left, knobs) - amountValue(node.padding.right, knobs)
    const widths = node.children.map(child => layout.rects.get(child.name)!.width)
    if (node.layout === 'row') {
      const used = widths.reduce((sum, item) => sum + item, 0) + amountValue(node.gap, knobs) * (node.children.length - 1)
      if (used > inner + fitEpsilon) count++
    } else {
      for (const childWidth of widths) if (childWidth > inner + fitEpsilon) count++
    }
  }
  return count
}

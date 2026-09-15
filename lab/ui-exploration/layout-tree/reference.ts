// Plain float64 JavaScript layout, written independently of the circuit builder.
// It follows the semantics documented at the top of tree.ts with ordinary
// loops: grow and shrink sort breakpoints and solve for the level on the
// interval that contains it, wrap walks children once, grids loop over rows.
// It shares only the node types and the fitEpsilon constant with tree.ts. Which children
// may shrink, the alignment factors, and which sticky flags apply are written again here,
// so a mistake in the builder's versions of those rules shows up as a mismatch.
import {
  fitEpsilon,
  type Align,
  type ContainerNode,
  type LayoutNode,
  type LayoutResult,
  type Sizing,
  type TextTable,
} from './tree.ts'

export type LayoutInputs = Readonly<Record<string, number>>

export function lineCount(table: TextTable, width: number): number {
  let lines = table.baseLines
  for (const threshold of table.thresholds) if (width < threshold) lines++
  return lines
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

// Clay's own GROW loop (clay.h, Clay__SizeContainersAlongAxis), kept for comparison in
// report.ts: repeatedly raise the smallest children toward the second smallest, but by at
// most the remaining space divided by all growing children, until 0.01 px remain. Like clay.h
// it computes in float32, and Clay__FloatEqual treats sizes within CLAY__EPSILON = 0.01 as equal.
export function clayGrowLoop(sizes: readonly number[], maximums: readonly number[], space: number) {
  const float32 = Math.fround
  const epsilon = float32(0.01)
  const floatEqual = (left: number, right: number) => {
    const subtracted = float32(left - right)
    return subtracted < epsilon && subtracted > -epsilon
  }
  const maxFloat = float32(3.4028234663852886e38)
  const result = sizes.map(float32)
  const growing = result.map((_, index) => index)
  let remaining = float32(space)
  let rounds = 0
  while (remaining > epsilon && growing.length > 0) {
    rounds++
    let smallest = maxFloat
    let secondSmallest = maxFloat
    let widthToAdd = remaining
    for (const index of growing) {
      const size = result[index]!
      if (floatEqual(size, smallest)) continue
      if (size < smallest) {
        secondSmallest = smallest
        smallest = size
      }
      if (size > smallest) {
        secondSmallest = Math.min(secondSmallest, size)
        widthToAdd = float32(secondSmallest - smallest)
      }
    }
    widthToAdd = Math.min(widthToAdd, float32(remaining / growing.length))
    for (let position = 0; position < growing.length; position++) {
      const index = growing[position]!
      const previous = result[index]!
      if (floatEqual(previous, smallest)) {
        result[index] = float32(previous + widthToAdd)
        if (result[index]! >= maximums[index]!) {
          result[index] = float32(maximums[index]!)
          // Clay__int32_tArray_RemoveSwapback, then visit the swapped-in child at this position.
          growing[position] = growing[growing.length - 1]!
          growing.pop()
          position--
        }
        remaining = float32(remaining - float32(result[index]! - previous))
      }
    }
  }
  return {sizes: result, rounds}
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

export function layoutReference(root: LayoutNode, inputs: LayoutInputs, tables: ReadonlyMap<string, TextTable>): LayoutResult {
  const inputValue = (name: string) => {
    const value = inputs[name]
    if (value === undefined) throw new Error(`missing input ${name}`)
    return value
  }
  const tableOf = (textId: string) => {
    const table = tables.get(textId)
    if (table === undefined) throw new Error(`missing text table ${textId}`)
    return table
  }
  const sized = (sizing: Sizing, content: number, contentMin: number): Axis => {
    switch (sizing.kind) {
      case 'fixed': return {fit: sizing.size, min: sizing.size}
      case 'input': {
        const value = inputValue(sizing.input)
        return {fit: value, min: value}
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
    const value = map.get(node)
    if (value === undefined) throw new Error(`${node.name}: value used before its pass`)
    return value
  }

  // Pass 1: fit widths, children first.
  const measureWidths = (node: LayoutNode) => {
    let content = 0
    let contentMin = 0
    if (node.kind === 'text') {
      content = tableOf(node.textId).naturalWidth
      contentMin = tableOf(node.textId).minWidth
    } else if (node.kind === 'container') {
      for (const child of node.children) measureWidths(child)
      const count = node.children.length
      const paddingX = node.padding.left + node.padding.right
      const gaps = node.gap * Math.max(0, count - 1)
      const fits = node.children.map(child => child.width.kind === 'percent' ? 0 : get(widthAxis, child).fit)
      const mins = node.children.map(child => get(widthAxis, child).min)
      if (node.layout === 'row') {
        content = paddingX + fits.reduce((sum, value) => sum + value, 0) + gaps
        contentMin = paddingX + mins.reduce((sum, value) => sum + value, 0) + gaps
      } else if (node.layout === 'column') {
        content = paddingX + Math.max(0, ...fits)
        contentMin = paddingX + Math.max(0, ...mins)
      } else if (node.layout === 'wrap') {
        content = paddingX + fits.reduce((sum, value) => sum + value, 0) + gaps
        contentMin = paddingX + Math.max(0, ...mins)
      } else {
        const columns = Math.min(count, node.maxColumns)
        content = paddingX + columns * node.minCellWidth + Math.max(0, columns - 1) * node.gap
        contentMin = paddingX + (count > 0 ? node.minCellWidth : 0)
      }
    }
    widthAxis.set(node, sized(node.width, content, contentMin))
  }

  // Pass 2: widths, parents first. Text line counts follow each text's final width.
  const resolveWidths = (node: LayoutNode) => {
    if (node.kind === 'text') {
      result.lines.set(node.name, lineCount(tableOf(node.textId), get(width, node)))
      return
    }
    if (node.kind !== 'container') return
    const inner = get(width, node) - node.padding.left - node.padding.right
    const count = node.children.length
    const gaps = node.gap * Math.max(0, count - 1)
    const sizes = node.children.map(child => get(widthAxis, child).fit)
    if (node.layout === 'row') {
      node.children.forEach((child, index) => {
        if (child.width.kind === 'percent') sizes[index] = (inner - gaps) * child.width.fraction
      })
      const free = inner - (sizes.reduce((sum, value) => sum + value, 0) + gaps)
      if (free > 0) {
        const growing = node.children.flatMap((child, index) => child.width.kind === 'grow' ? [index] : [])
        const lows = growing.map(index => sizes[index]!)
        const highs = growing.map(index => (node.children[index]!.width as {max: number}).max)
        const solved = solveWaterLevel(lows, highs, lows.reduce((sum, value) => sum + value, 0) + free)
        growing.forEach((index, position) => { sizes[index] = solved[position]! })
      } else if (free < 0) {
        const shrinking = node.children.flatMap((child, index) => canShrink(child,'x') ? [index] : [])
        const lows = shrinking.map(index => get(widthAxis, node.children[index]!).min)
        const highs = shrinking.map(index => sizes[index]!)
        const solved = solveWaterLevel(lows, highs, highs.reduce((sum, value) => sum + value, 0) + free)
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
        if (index > 0 && used + node.gap + size <= inner + fitEpsilon) {
          info.lineOf.push(info.lineOf.at(-1)!)
          info.offsets.push(used + node.gap)
          used += node.gap + size
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
      let columns = 1
      for (let candidate = 2; candidate <= node.maxColumns; candidate++) {
        if (inner + fitEpsilon >= candidate * node.minCellWidth + (candidate - 1) * node.gap) columns++
      }
      const cellWidth = (inner - (columns - 1) * node.gap) / columns
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
      const textHeight = result.lines.get(node.name)! * node.lineHeight
      heightAxis.set(node, {fit: textHeight, min: textHeight})
      return
    }
    let content = 0
    let contentMin = 0
    if (node.kind === 'container') {
      for (const child of node.children) measureHeights(child)
      const count = node.children.length
      const paddingY = node.padding.top + node.padding.bottom
      const gaps = node.gap * Math.max(0, count - 1)
      const fits = node.children.map(child => child.height.kind === 'percent' ? 0 : get(heightAxis, child).fit)
      const mins = node.children.map(child => get(heightAxis, child).min)
      if (node.layout === 'column') {
        content = paddingY + fits.reduce((sum, value) => sum + value, 0) + gaps
        contentMin = node.scrollY !== null ? paddingY : paddingY + mins.reduce((sum, value) => sum + value, 0) + gaps
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
          top += lineHeight + node.gap
        })
        content = paddingY + (info.lineHeights.length === 0 ? 0 : top - node.gap)
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
          top += rowHeight + node.gap
        }
        content = paddingY + (rows === 0 ? 0 : top - node.gap)
        contentMin = content
      }
    }
    heightAxis.set(node, sized(node.height, content, contentMin))
  }

  // Pass 4: heights, parents first.
  const resolveHeights = (node: LayoutNode) => {
    if (node.kind !== 'container') return
    const inner = get(height, node) - node.padding.top - node.padding.bottom
    const count = node.children.length
    const gaps = node.gap * Math.max(0, count - 1)
    const sizes = node.children.map(child => get(heightAxis, child).fit)
    if (node.layout === 'column') {
      node.children.forEach((child, index) => {
        if (child.height.kind === 'percent') sizes[index] = (inner - gaps) * child.height.fraction
      })
      const free = inner - (sizes.reduce((sum, value) => sum + value, 0) + gaps)
      if (free > 0) {
        const growing = node.children.flatMap((child, index) => child.kind !== 'text' && child.height.kind === 'grow' ? [index] : [])
        const lows = growing.map(index => sizes[index]!)
        const highs = growing.map(index => (node.children[index]!.height as {max: number}).max)
        const solved = solveWaterLevel(lows, highs, lows.reduce((sum, value) => sum + value, 0) + free)
        growing.forEach((index, position) => { sizes[index] = solved[position]! })
      } else if (free < 0 && node.scrollY === null) {
        const shrinking = node.children.flatMap((child, index) => canShrink(child,'y') ? [index] : [])
        const lows = shrinking.map(index => get(heightAxis, node.children[index]!).min)
        const highs = shrinking.map(index => sizes[index]!)
        const solved = solveWaterLevel(lows, highs, highs.reduce((sum, value) => sum + value, 0) + free)
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
    const innerWidth = get(width, node) - node.padding.left - node.padding.right
    const innerHeight = get(height, node) - node.padding.top - node.padding.bottom
    const count = node.children.length
    const gaps = node.gap * Math.max(0, count - 1)
    const widths = node.children.map(child => get(width, child))
    const heights = node.children.map(child => get(height, child))
    if (node.layout === 'row') {
      const used = widths.reduce((sum, value) => sum + value, 0) + gaps
      let offset = node.padding.left + alignmentFactor(node.alignX) * Math.max(0, innerWidth - used)
      node.children.forEach((child, index) => {
        x.set(child, left + offset)
        y.set(child, top + node.padding.top + alignmentFactor(node.alignY) * (innerHeight - heights[index]!))
        offset += widths[index]! + node.gap
      })
    } else if (node.layout === 'column') {
      const used = heights.reduce((sum, value) => sum + value, 0) + gaps
      let scrollOffset = 0
      if (node.scrollY !== null) {
        const contentHeight = node.padding.top + node.padding.bottom + used
        scrollOffset = clamp(inputValue(node.scrollY), 0, Math.max(0, contentHeight - get(height, node)))
        result.scroll.set(node.name, scrollOffset)
      }
      let offset = node.padding.top + alignmentFactor(node.alignY) * Math.max(0, innerHeight - used)
      node.children.forEach((child, index) => {
        x.set(child, left + node.padding.left + alignmentFactor(node.alignX) * (innerWidth - widths[index]!))
        let childTop = top + offset - scrollOffset
        // The sticky rule applies only when this column sits strictly inside a scroll container.
        if (child.sticky && scrollAbove !== null) {
          childTop = Math.max(childTop, Math.min(get(y, scrollAbove), top + get(height, node) - node.padding.bottom - heights[index]!))
        }
        y.set(child, childTop)
        offset += heights[index]! + node.gap
      })
    } else if (node.layout === 'wrap') {
      const info = wrapInfo.get(node)!
      node.children.forEach((child, index) => {
        const line = info.lineOf[index]!
        const lineStart = node.padding.left + alignmentFactor(node.alignX) * Math.max(0, innerWidth - info.lineUsed[line]!)
        x.set(child, left + lineStart + info.offsets[index]!)
        y.set(child, top + node.padding.top + info.lineTops[line]! + alignmentFactor(node.alignY) * (info.lineHeights[line]! - heights[index]!))
      })
    } else {
      const info = gridInfo.get(node)!
      node.children.forEach((child, index) => {
        x.set(child, left + node.padding.left + (index % info.columns) * (info.cellWidth + node.gap))
        y.set(child, top + node.padding.top + info.rowTops[Math.floor(index / info.columns)]!)
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

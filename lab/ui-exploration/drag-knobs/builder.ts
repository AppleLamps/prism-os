// Compiles a static widget tree into circuit operations, one Clay-style pass after
// another over the whole tree: fit widths, widths, text lines, fit heights, heights,
// positions. Copied from lab/ui-exploration/layout-tree. Changes:
// - Padding, gap, a grid's minimum cell width and a text's font scale are Amounts. A number
//   folds into biases exactly as before. A knob becomes a term on a source cell, so every
//   place that used the number as a bias now adds one weight on the knob's cell instead.
//   A font scale knob multiplies the text's width and threshold cells (one ReGLU each) and
//   its line height (one ReGLU on the line count).
// - Every exact decision records its difference wire (see DecisionRecord).
// - An optional overflow count: how many rows, columns and wraps overflow horizontally.
// Every operation is tagged "pass:level" (the level of the node whose children the
// operation sizes or places).
import type {Terms, Wire} from '../../../src/runtime/numeric-ui-core.ts'
import type {SourceTable, TaggedCircuit} from './circuit-tools.ts'
import {
  atLeastZero,
  clampConstant,
  constantValue,
  constantWire,
  maxOfList,
  maxWire,
  minWire,
  relu,
  waterFill,
  type FillItem,
} from './ops.ts'
import {
  alignFactor,
  fitEpsilon,
  isResizable,
  stickyScrollAncestor,
  treeInputs,
  treeKnobs,
  walk,
  type Amount,
  type ContainerNode,
  type LayoutNode,
  type LayoutResult,
  type Sizing,
  type TextNode,
  type TextTable,
} from './tree.ts'

export const passNames = ['1 fit widths', '2 widths', '3 text lines', '4 fit heights', '5 heights', '6 positions'] as const

export type TextCells = {naturalWidth: Wire, minWidth: Wire, baseLines: Wire, thresholds: Wire[], unusedThreshold: number}

export type LayoutSources = {
  inputs: Map<string, Wire>
  texts: Map<string, TextCells>
  knobs: Map<string, Wire>
}

export type KnobBound = {initial: number, minimum: number, maximum: number}

export const sizeBound = 8192

// Allocates source cells for every input the tree reads (except external ones, which the
// caller computes inside the circuit and adds to `inputs`), for every knob, and for every
// text table.
export function allocateLayoutSources(
  table: SourceTable,
  root: LayoutNode,
  options: {
    inputBounds?: ReadonlyMap<string, readonly [number, number]>
    externalInputs?: ReadonlySet<string>
    knobBounds?: ReadonlyMap<string, KnobBound>
  } = {},
): LayoutSources {
  const inputs = new Map<string, Wire>()
  for (const name of treeInputs(root)) {
    if (options.externalInputs?.has(name)) continue
    const [minimum, maximum] = options.inputBounds?.get(name) ?? [0, sizeBound]
    inputs.set(name, table.cell(`input.${name}`, 0, minimum, maximum))
  }
  const knobs = new Map<string, Wire>()
  for (const name of treeKnobs(root)) {
    const bound = options.knobBounds?.get(name)
    if (bound === undefined) throw new Error(`knob ${name} has no declared bounds`)
    knobs.set(name, table.cell(`knob.${name}`, bound.initial, bound.minimum, bound.maximum))
  }
  const capacities = new Map<string, number>()
  const scaledTexts = new Set<string>()
  for (const {node} of walk(root)) {
    if (node.kind !== 'text') continue
    capacities.set(node.textId, Math.max(capacities.get(node.textId) ?? 0, node.capacity))
    if (typeof node.fontScale !== 'number') scaledTexts.add(node.textId)
  }
  const texts = new Map<string, TextCells>()
  for (const [textId, capacity] of capacities) {
    // Unused threshold cells hold a large negative width, so [width < threshold] never counts
    // them, even for the negative widths a container gets when its padding exceeds its size.
    // A text with a font scale knob uses half the bound, so the scaled sentinel still keeps
    // the compared difference within comparisonMagnitude for scales up to 1.5.
    const unusedThreshold = scaledTexts.has(textId) ? -sizeBound / 2 : -sizeBound
    texts.set(textId, {
      naturalWidth: table.cell(`text.${textId}.naturalWidth`, 0, 0, sizeBound),
      minWidth: table.cell(`text.${textId}.minWidth`, 0, 0, sizeBound),
      baseLines: table.cell(`text.${textId}.baseLines`, 0, 0, 1024),
      thresholds: Array.from({length: capacity}, (_, index) => table.cell(`text.${textId}.threshold${index}`, unusedThreshold, unusedThreshold, -unusedThreshold)),
      unusedThreshold,
    })
  }
  return {inputs, texts, knobs}
}

export function writeLayoutSources(
  values: Float32Array,
  sources: LayoutSources,
  inputs: Readonly<Record<string, number>>,
  tables: ReadonlyMap<string, TextTable>,
) {
  for (const [name, wire] of sources.inputs) {
    // Inputs the caller computes inside the circuit (like a spring's output) are not cells.
    if (wire >= values.length) continue
    const value = inputs[name]
    if (value === undefined) throw new Error(`missing input ${name}`)
    values[wire] = value
  }
  for (const [textId, cells] of sources.texts) {
    const table = tables.get(textId)
    if (table === undefined) throw new Error(`missing text table ${textId}`)
    if (table.thresholds.length > cells.thresholds.length) {
      throw new Error(`text ${textId} has ${table.thresholds.length} thresholds but capacity ${cells.thresholds.length}`)
    }
    values[cells.naturalWidth] = table.naturalWidth
    values[cells.minWidth] = table.minWidth
    values[cells.baseLines] = table.baseLines
    cells.thresholds.forEach((cell, index) => { values[cell] = table.thresholds[index] ?? cells.unusedThreshold })
  }
}

export type RectWires = {x: Wire, y: Wire, width: Wire, height: Wire}

export type LayoutWires = {
  rects: Map<string, RectWires>
  lines: Map<string, Wire>
  scroll: Map<string, Wire>
  wrapLines: Map<string, Wire[]>
  gridColumns: Map<string, Wire>
  // How many containers (or container children) overflow horizontally, when requested.
  overflowCount: Wire | null
}

type AxisWires = {fit: Wire, min: Wire}

type WrapWires = {
  fits: (Wire | null)[]
  offsets: Wire[]
  used: Wire[]
  lineFinal: Wire[]
  lineTop: Wire[]
}

type GridWires = {
  // Column count of each variant; members is the one-hot over variants (empty when only one).
  variantColumns: number[]
  members: Wire[]
  cellWidth: Wire
  columnIndex: Wire[]
  rowHeights: Wire[][]
  rowTops: Wire[][]
}

// An affine expression over knob cells: the weighted knob terms plus a constant.
type Linear = {terms: [Wire, number][], bias: number}

export function buildLayout(circuit: TaggedCircuit, root: LayoutNode, sources: LayoutSources, options: {overflow?: boolean} = {}): LayoutWires {
  const inputWire = (name: string) => {
    const wire = sources.inputs.get(name)
    if (wire === undefined) throw new Error(`missing input wire ${name}`)
    return wire
  }
  const knobWire = (name: string) => {
    const wire = sources.knobs.get(name)
    if (wire === undefined) throw new Error(`missing knob wire ${name}`)
    return wire
  }
  // coefficient * amount. For a number the product is computed in the same order the
  // original builder wrote it (coefficient first), so folded biases stay bit-identical.
  const amount = (value: Amount, coefficient = 1): Linear => typeof value === 'number'
    ? {terms: [], bias: coefficient * value}
    : {terms: [[knobWire(value.name), coefficient]], bias: 0}
  const sum = (...parts: Linear[]): Linear => {
    const terms: [Wire, number][] = []
    let bias = 0
    for (const part of parts) {
      terms.push(...part.terms)
      bias += part.bias
    }
    return {terms, bias}
  }
  const negate = (part: Linear): Linear => ({terms: part.terms.map(([wire, coefficient]) => [wire, -coefficient]), bias: -part.bias})
  const affineWith = (terms: Terms, linear: Linear, extraBias = 0) => circuit.affine([...terms, ...linear.terms], extraBias + linear.bias)
  const paddingX = (node: ContainerNode) => sum(amount(node.padding.left), amount(node.padding.right))
  const paddingY = (node: ContainerNode) => sum(amount(node.padding.top), amount(node.padding.bottom))
  const gapsOf = (node: ContainerNode) => amount(node.gap, Math.max(0, node.children.length - 1))

  const zero = constantWire(circuit, 0)
  const widthAxis = new Map<LayoutNode, AxisWires>()
  const heightAxis = new Map<LayoutNode, AxisWires>()
  const width = new Map<LayoutNode, Wire>()
  const height = new Map<LayoutNode, Wire>()
  const x = new Map<LayoutNode, Wire>()
  const y = new Map<LayoutNode, Wire>()
  const lines = new Map<LayoutNode, Wire>()
  const wraps = new Map<ContainerNode, WrapWires>()
  const grids = new Map<ContainerNode, GridWires>()
  const output: LayoutWires = {rects: new Map(), lines: new Map(), scroll: new Map(), wrapLines: new Map(), gridColumns: new Map(), overflowCount: null}
  const get = (map: Map<LayoutNode, Wire>, node: LayoutNode) => {
    const wire = map.get(node)
    if (wire === undefined) throw new Error(`${node.name}: wire used before its pass`)
    return wire
  }
  const axisOf = (map: Map<LayoutNode, AxisWires>, node: LayoutNode) => map.get(node)!
  const tagged = <T>(pass: string, level: number, run: () => T) => circuit.withTag(`${pass}:${level}`, run)

  // A text's prepared widths at its font scale.
  const scaledTextCells = new Map<TextNode, {naturalWidth: Wire, minWidth: Wire, thresholds: Wire[]}>()
  const textCells = (node: TextNode) => {
    const cached = scaledTextCells.get(node)
    if (cached !== undefined) return cached
    const cells = sources.texts.get(node.textId)!
    const scale = node.fontScale
    const scaled = (cell: Wire) => typeof scale === 'number'
      ? (scale === 1 ? cell : circuit.affine([[cell, scale]]))
      : circuit.multiply(cell, knobWire(scale.name))
    const result = {naturalWidth: scaled(cells.naturalWidth), minWidth: scaled(cells.minWidth), thresholds: cells.thresholds.map(scaled)}
    scaledTextCells.set(node, result)
    return result
  }

  const sizedAxis = (sizing: Sizing, content: Wire, contentMin: Wire): AxisWires => {
    switch (sizing.kind) {
      case 'fixed': {
        const size = constantWire(circuit, sizing.size)
        return {fit: size, min: size}
      }
      case 'input': {
        const size = inputWire(sizing.input)
        return {fit: size, min: size}
      }
      case 'percent': return {fit: zero, min: zero}
      case 'fit':
      case 'grow': return {
        fit: clampConstant(circuit, content, sizing.min, sizing.max),
        min: clampConstant(circuit, contentMin, sizing.min, sizing.max),
      }
    }
  }
  const sumTerms = (wires: readonly Wire[], coefficient = 1): [Wire, number][] => wires.map(wire => [wire, coefficient])
  const crossSize = (sizing: Sizing, axis: AxisWires, inner: Wire): Wire => {
    switch (sizing.kind) {
      case 'percent': return circuit.affine([[inner, sizing.fraction]])
      case 'fixed':
      case 'input': return axis.fit
      case 'grow': {
        const capped = sizing.max < Number.POSITIVE_INFINITY ? minWire(circuit, inner, constantWire(circuit, sizing.max)) : inner
        return maxWire(circuit, capped, axis.min)
      }
      case 'fit': return axis.fit === axis.min ? axis.fit : maxWire(circuit, minWire(circuit, axis.fit, inner), axis.min)
    }
  }
  // The masked sum over a grid's column-count one-hot; the compiler lowers it to one gather read.
  const maskedRead = (members: readonly Wire[], values: readonly Wire[]): Wire => {
    if (values.every(value => value === values[0])) return values[0]!
    return circuit.roundAffine(members.map((member, index) => [circuit.multiply(values[index]!, member), 1]))
  }
  // Main-axis sizing along a row (x) or a column (y): percent children, then grow and shrink.
  const mainAxisSizes = (node: ContainerNode, axis: 'x' | 'y', inner: Wire, allowShrink: boolean): Wire[] => {
    const axes = node.children.map(child => axisOf(axis === 'x' ? widthAxis : heightAxis, child))
    const sizingOf = (child: LayoutNode) => axis === 'x' ? child.width : child.height
    const gaps = gapsOf(node)
    const sizes = node.children.map((child, index) => {
      const sizing = sizingOf(child)
      if (sizing.kind !== 'percent') return axes[index]!.fit
      const scaledGaps = typeof node.gap === 'number' ? {terms: [], bias: -gaps.bias * sizing.fraction} : negate({terms: gaps.terms.map(([wire, coefficient]): [Wire, number] => [wire, coefficient * sizing.fraction]), bias: 0})
      return affineWith([[inner, sizing.fraction]], scaledGaps)
    })
    const freeTerms: [Wire, number][] = [[inner, 1], ...sumTerms(sizes, -1), ...negate(gaps).terms]
    const freeBias = -gaps.bias
    // Text heights always use fit sizing, so only widths of text can grow.
    const growing = node.children.flatMap((child, index) => sizingOf(child).kind === 'grow' ? [index] : [])
    const grown = waterFill(circuit, growing.map((index): FillItem => {
      const sizing = sizingOf(node.children[index]!) as {max: number}
      return {low: sizes[index]!, high: sizing.max < Number.POSITIVE_INFINITY ? constantWire(circuit, sizing.max) : null}
    }), freeTerms, freeBias, `${node.name}.grow`)
    const result = [...sizes]
    growing.forEach((index, position) => { result[index] = grown[position]! })
    if (!allowShrink) return result
    // Children whose min equals their fit cannot move, so they only enter the excess.
    const shrinking = node.children.flatMap((child, index) => isResizable(child, axis) && axes[index]!.min !== axes[index]!.fit ? [index] : [])
    if (shrinking.length === 0) return result
    const shrinkTerms: [Wire, number][] = [...freeTerms]
    for (const index of shrinking) shrinkTerms.push([sizes[index]!, 1], [axes[index]!.min, -1])
    const shrunk = waterFill(circuit, shrinking.map((index): FillItem => ({low: axes[index]!.min, high: sizes[index]!})), shrinkTerms, freeBias, `${node.name}.shrink`)
    shrinking.forEach((index, position) => {
      // Grow and shrink each return the fit size outside their own regime.
      result[index] = result[index] === sizes[index]
        ? shrunk[position]!
        : circuit.affine([[result[index]!, 1], [shrunk[position]!, 1], [sizes[index]!, -1]])
    })
    return result
  }

  // Pass 1: fit widths, children first.
  const measureWidths = (node: LayoutNode, level: number) => {
    if (node.kind === 'container') for (const child of node.children) measureWidths(child, level + 1)
    tagged(passNames[0], level, () => {
      let content = zero
      let contentMin = zero
      if (node.kind === 'text') {
        content = textCells(node).naturalWidth
        contentMin = textCells(node).minWidth
      } else if (node.kind === 'container') {
        const count = node.children.length
        const fits = node.children.flatMap(child => child.width.kind === 'percent' ? [] : [axisOf(widthAxis, child).fit])
        const mins = node.children.map(child => axisOf(widthAxis, child).min)
        if (node.layout === 'row' || node.layout === 'wrap') {
          content = affineWith(sumTerms(fits), sum(paddingX(node), gapsOf(node)))
          contentMin = node.layout === 'row'
            ? affineWith(sumTerms(mins), sum(paddingX(node), gapsOf(node)))
            : affineWith([[maxOfList(circuit, mins), 1]], paddingX(node))
        } else if (node.layout === 'column') {
          content = affineWith([[maxOfList(circuit, fits), 1]], paddingX(node))
          contentMin = affineWith([[maxOfList(circuit, mins), 1]], paddingX(node))
        } else {
          const columns = Math.min(count, node.maxColumns)
          content = affineWith([], sum(paddingX(node), amount(node.minCellWidth, columns), amount(node.gap, Math.max(0, columns - 1))))
          contentMin = affineWith([], sum(paddingX(node), count > 0 ? amount(node.minCellWidth) : {terms: [], bias: 0}))
        }
      }
      widthAxis.set(node, sizedAxis(node.width, content, contentMin))
    })
  }

  // Pass 2: widths, parents first.
  const resolveWidths = (node: LayoutNode, level: number) => {
    if (node.kind !== 'container') return
    const sizes = tagged(passNames[1], level, (): Wire[] => {
      const inner = affineWith([[get(width, node), 1]], negate(paddingX(node)))
      if (node.layout === 'row') return mainAxisSizes(node, 'x', inner, true)
      if (node.layout === 'column') return node.children.map(child => crossSize(child.width, axisOf(widthAxis, child), inner))
      if (node.layout === 'wrap') {
        const childSizes = node.children.map(child => {
          const axis = axisOf(widthAxis, child)
          if (child.width.kind === 'percent') return circuit.affine([[inner, child.width.fraction]])
          if (child.width.kind === 'fit' || child.width.kind === 'grow') {
            return axis.fit === axis.min ? axis.fit : maxWire(circuit, minWire(circuit, axis.fit, inner), axis.min)
          }
          return axis.fit
        })
        const info: WrapWires = {fits: [], offsets: [], used: [], lineFinal: [], lineTop: []}
        const lineIndex: Wire[] = []
        childSizes.forEach((size, index) => {
          if (index === 0) {
            info.fits.push(null)
            info.offsets.push(zero)
            info.used.push(size)
            lineIndex.push(zero)
            return
          }
          const previousUsed = info.used[index - 1]!
          const gap = negate(amount(node.gap))
          const fits = atLeastZero(circuit, [[inner, 1], [previousUsed, -1], [size, -1], ...gap.terms], fitEpsilon + gap.bias, {kind: 'wrap', node: node.name, detail: index})
          const offset = circuit.multiply(affineWith([[previousUsed, 1]], amount(node.gap)), fits)
          info.fits.push(fits)
          info.offsets.push(offset)
          info.used.push(circuit.affine([[size, 1], [offset, 1]]))
          lineIndex.push(circuit.affine([[lineIndex[index - 1]!, 1], [fits, -1]], 1))
        })
        wraps.set(node, info)
        output.wrapLines.set(node.name, lineIndex)
        return childSizes
      }
      // Grid: exact bits for each column count, a declared one-hot over counts 1..maxColumns.
      // A grid whose inner width is a compile-time constant knows its column count.
      const atLeastColumns = [constantWire(circuit, 1)]
      for (let columns = 2; columns <= node.maxColumns; columns++) {
        const needed = negate(sum(amount(node.minCellWidth, columns), amount(node.gap, columns - 1)))
        atLeastColumns.push(atLeastZero(circuit, [[inner, 1], ...needed.terms], fitEpsilon + needed.bias, {kind: 'grid', node: node.name, detail: columns}))
      }
      output.gridColumns.set(node.name, circuit.affine(sumTerms(atLeastColumns)))
      const knownColumns = atLeastColumns.every(bit => constantValue(circuit, bit) !== undefined)
        ? atLeastColumns.reduce((total, bit) => total + constantValue(circuit, bit)!, 0)
        : null
      let info: GridWires
      if (knownColumns !== null) {
        const offset: Linear = typeof node.gap === 'number'
          ? {terms: [], bias: -(knownColumns - 1) * node.gap / knownColumns}
          : amount(node.gap, -(knownColumns - 1) / knownColumns)
        info = {
          variantColumns: [knownColumns],
          members: [],
          cellWidth: affineWith([[inner, 1 / knownColumns]], offset),
          columnIndex: node.children.map((_, childIndex) => constantWire(circuit, childIndex % knownColumns)),
          rowHeights: [],
          rowTops: [],
        }
      } else {
        const members = atLeastColumns.map((bit, index) => {
          const next = atLeastColumns[index + 1]
          const member = next === undefined ? circuit.roundAffine([[bit, 1]]) : circuit.roundAffine([[bit, 1], [next, -1]])
          circuit.assumeRange(member, 0, 1)
          return member
        })
        circuit.assumeOneHot(members)
        const reciprocal = circuit.affine(members.map((member, index) => [member, 1 / (index + 1)]))
        info = {
          variantColumns: members.map((_, index) => index + 1),
          members,
          cellWidth: affineWith([[circuit.multiply(affineWith([[inner, 1]], amount(node.gap)), reciprocal), 1]], negate(amount(node.gap))),
          columnIndex: node.children.map((_, childIndex) => circuit.affine(members.map((member, index) => [member, childIndex % (index + 1)]))),
          rowHeights: [],
          rowTops: [],
        }
      }
      grids.set(node, info)
      return node.children.map(() => info.cellWidth)
    })
    node.children.forEach((child, index) => {
      width.set(child, sizes[index]!)
      resolveWidths(child, level + 1)
    })
  }

  // Pass 3: text line counts from each text's final width.
  const countLines = () => {
    for (const {node, level} of walk(root)) {
      if (node.kind !== 'text') continue
      tagged(passNames[2], level, () => {
        const cells = sources.texts.get(node.textId)!
        const thresholds = textCells(node).thresholds
        const terms: [Wire, number][] = [[cells.baseLines, 1]]
        thresholds.forEach((threshold, index) => {
          terms.push([atLeastZero(circuit, [[get(width, node), 1], [threshold, -1]], 0, {kind: 'lines', node: node.name, detail: index}), -1])
        })
        const count = circuit.affine(terms, thresholds.length)
        lines.set(node, count)
        output.lines.set(node.name, count)
      })
    }
  }

  // Pass 4: fit heights, children first.
  const measureHeights = (node: LayoutNode, level: number) => {
    if (node.kind === 'container') for (const child of node.children) measureHeights(child, level + 1)
    tagged(passNames[3], level, () => {
      if (node.kind === 'text') {
        const count = get(lines, node)
        const scale = node.fontScale
        const textHeight = typeof scale === 'number'
          ? circuit.affine([[count, scale === 1 ? node.lineHeight : node.lineHeight * scale]])
          : circuit.affine([[circuit.multiply(count, knobWire(scale.name)), node.lineHeight]])
        heightAxis.set(node, {fit: textHeight, min: textHeight})
        return
      }
      let content = zero
      let contentMin = zero
      if (node.kind === 'container') {
        const count = node.children.length
        const fits = node.children.map(child => child.height.kind === 'percent' ? zero : axisOf(heightAxis, child).fit)
        const mins = node.children.map(child => axisOf(heightAxis, child).min)
        if (node.layout === 'column') {
          content = affineWith(sumTerms(fits), sum(paddingY(node), gapsOf(node)))
          contentMin = node.scrollY !== null ? affineWith([], paddingY(node)) : affineWith(sumTerms(mins), sum(paddingY(node), gapsOf(node)))
        } else if (node.layout === 'row') {
          content = affineWith([[maxOfList(circuit, fits), 1]], paddingY(node))
          contentMin = affineWith([[maxOfList(circuit, mins), 1]], paddingY(node))
        } else if (node.layout === 'wrap') {
          const info = wraps.get(node)!
          const lineMax: Wire[] = []
          fits.forEach((fitHeight, index) => {
            lineMax.push(index === 0 ? fitHeight : maxWire(circuit, circuit.multiply(lineMax[index - 1]!, info.fits[index]!), fitHeight))
          })
          info.lineFinal = [...lineMax]
          for (let index = count - 2; index >= 0; index--) {
            const share = circuit.reglu([[info.fits[index + 1]!, 1]], 0, [[info.lineFinal[index + 1]!, 1], [lineMax[index]!, -1]], 0)
            info.lineFinal[index] = circuit.affine([[lineMax[index]!, 1], [share, 1]])
          }
          info.lineTop = []
          for (let index = 0; index < count; index++) {
            if (index === 0) {
              info.lineTop.push(zero)
              continue
            }
            const newLine = circuit.affine([[info.fits[index]!, -1]], 1)
            circuit.assumeRange(newLine, 0, 1)
            const advance = circuit.multiply(affineWith([[info.lineFinal[index - 1]!, 1]], amount(node.gap)), newLine)
            info.lineTop.push(circuit.affine([[info.lineTop[index - 1]!, 1], [advance, 1]]))
          }
          content = count === 0 ? affineWith([], paddingY(node)) : affineWith([[info.lineTop[count - 1]!, 1], [info.lineFinal[count - 1]!, 1]], paddingY(node))
          contentMin = content
        } else {
          const info = grids.get(node)!
          const totals: Wire[] = []
          for (const columns of info.variantColumns) {
            const rows = Math.ceil(count / columns)
            const rowHeights: Wire[] = []
            const rowTops: Wire[] = []
            for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
              rowTops.push(affineWith(sumTerms(rowHeights), amount(node.gap, rowIndex)))
              rowHeights.push(maxOfList(circuit, fits.slice(rowIndex * columns, (rowIndex + 1) * columns)))
            }
            info.rowHeights.push(rowHeights)
            info.rowTops.push(rowTops)
            totals.push(affineWith(sumTerms(rowHeights), amount(node.gap, Math.max(0, rows - 1))))
          }
          const total = info.members.length === 0 ? totals[0]! : maskedRead(info.members, totals)
          content = affineWith([[total, 1]], paddingY(node))
          contentMin = content
        }
      }
      heightAxis.set(node, sizedAxis(node.height, content, contentMin))
    })
  }

  const rowOfChild = (info: GridWires, childIndex: number, variant: number) =>
    Math.floor(childIndex / info.variantColumns[variant]!)
  const gridRead = (info: GridWires, childIndex: number, table: Wire[][]) => {
    if (info.members.length === 0) return table[0]![rowOfChild(info, childIndex, 0)]!
    return maskedRead(info.members, table.map((rows, variant) => rows[rowOfChild(info, childIndex, variant)]!))
  }

  // Pass 5: heights, parents first.
  const resolveHeights = (node: LayoutNode, level: number) => {
    if (node.kind !== 'container') return
    const sizes = tagged(passNames[4], level, (): Wire[] => {
      const inner = affineWith([[get(height, node), 1]], negate(paddingY(node)))
      if (node.layout === 'column') return mainAxisSizes(node, 'y', inner, node.scrollY === null)
      if (node.layout === 'row') return node.children.map(child => crossSize(child.height, axisOf(heightAxis, child), inner))
      if (node.layout === 'wrap') return node.children.map(child => axisOf(heightAxis, child).fit)
      const info = grids.get(node)!
      return node.children.map((_, childIndex) => gridRead(info, childIndex, info.rowHeights))
    })
    node.children.forEach((child, index) => {
      height.set(child, sizes[index]!)
      resolveHeights(child, level + 1)
    })
  }

  // Pass 6: positions, parents first.
  const place = (node: LayoutNode, level: number) => {
    output.rects.set(node.name, {x: get(x, node), y: get(y, node), width: get(width, node), height: get(height, node)})
    if (node.kind !== 'container') return
    tagged(passNames[5], level, () => {
      const left = get(x, node)
      const top = get(y, node)
      const innerWidth = affineWith([[get(width, node), 1]], negate(paddingX(node)))
      const innerHeight = affineWith([[get(height, node), 1]], negate(paddingY(node)))
      const count = node.children.length
      const gaps = gapsOf(node)
      const widths = node.children.map(child => get(width, child))
      const heights = node.children.map(child => get(height, child))
      const factorX = alignFactor(node.alignX)
      const factorY = alignFactor(node.alignY)
      const leftover = (inner: Wire, sizes: readonly Wire[], factor: number): Terms => {
        if (factor === 0) return []
        return [[relu(circuit, [[inner, 1], ...sumTerms(sizes, -1), ...negate(gaps).terms], -gaps.bias), factor]]
      }
      if (node.layout === 'row') {
        const start = leftover(innerWidth, widths, factorX)
        node.children.forEach((child, index) => {
          x.set(child, affineWith([[left, 1], ...start, ...sumTerms(widths.slice(0, index))], sum(amount(node.padding.left), amount(node.gap, index))))
          y.set(child, affineWith([[top, 1], [innerHeight, factorY], [heights[index]!, -factorY]], amount(node.padding.top)))
        })
      } else if (node.layout === 'column') {
        const start = leftover(innerHeight, heights, factorY)
        const scrollTerms: [Wire, number][] = []
        if (node.scrollY !== null) {
          const contentHeight = affineWith(sumTerms(heights), sum(amount(node.padding.top), amount(node.padding.bottom), gaps))
          const maxScroll = relu(circuit, [[contentHeight, 1], [get(height, node), -1]])
          const scrollOffset = minWire(circuit, clampConstant(circuit, inputWire(node.scrollY), 0, Number.POSITIVE_INFINITY), maxScroll)
          output.scroll.set(node.name, scrollOffset)
          scrollTerms.push([scrollOffset, -1])
        }
        node.children.forEach((child, index) => {
          x.set(child, affineWith([[left, 1], [innerWidth, factorX], [widths[index]!, -factorX]], amount(node.padding.left)))
          let childTop = affineWith([[top, 1], ...start, ...sumTerms(heights.slice(0, index)), ...scrollTerms], sum(amount(node.padding.top), amount(node.gap, index)))
          if (child.sticky) {
            const scroller = stickyScrollAncestor(root, child)
            if (scroller !== null) {
              const parentBound = affineWith([[top, 1], [get(height, node), 1], [heights[index]!, -1]], negate(amount(node.padding.bottom)))
              childTop = maxWire(circuit, childTop, minWire(circuit, get(y, scroller), parentBound))
            }
          }
          y.set(child, childTop)
        })
      } else if (node.layout === 'wrap') {
        const info = wraps.get(node)!
        const usedFinal = [...info.used]
        for (let index = count - 2; index >= 0; index--) {
          const share = circuit.reglu([[info.fits[index + 1]!, 1]], 0, [[usedFinal[index + 1]!, 1], [info.used[index]!, -1]], 0)
          usedFinal[index] = circuit.affine([[info.used[index]!, 1], [share, 1]])
        }
        node.children.forEach((child, index) => {
          const lineStart: Terms = factorX === 0 ? [] : [[relu(circuit, [[innerWidth, 1], [usedFinal[index]!, -1]]), factorX]]
          x.set(child, affineWith([[left, 1], [info.offsets[index]!, 1], ...lineStart], amount(node.padding.left)))
          y.set(child, affineWith([[top, 1], [info.lineTop[index]!, 1], [info.lineFinal[index]!, factorY], [heights[index]!, -factorY]], amount(node.padding.top)))
        })
      } else {
        const info = grids.get(node)!
        const pitch = affineWith([[info.cellWidth, 1]], amount(node.gap))
        node.children.forEach((child, index) => {
          const column = info.columnIndex[index]!
          const knownColumn = constantValue(circuit, column)
          const columnTerms: Terms = knownColumn !== undefined ? [[pitch, knownColumn]] : [[circuit.multiply(pitch, column), 1]]
          x.set(child, affineWith([[left, 1], ...columnTerms], amount(node.padding.left)))
          y.set(child, affineWith([[top, 1], [gridRead(info, index, info.rowTops), 1]], amount(node.padding.top)))
        })
      }
    })
    for (const child of node.children) place(child, level + 1)
  }

  // Horizontal overflow bits for every row, column and wrap (see the comment in tree.ts).
  const measureOverflow = () => circuit.withTag('overflow', () => {
    const fitsBits: Wire[] = []
    for (const {node} of walk(root)) {
      if (node.kind !== 'container' || node.layout === 'grid' || node.children.length === 0) continue
      const innerWidth = affineWith([[get(width, node), 1]], negate(paddingX(node)))
      const widths = node.children.map(child => get(width, child))
      if (node.layout === 'row') {
        const gaps = negate(gapsOf(node))
        fitsBits.push(atLeastZero(circuit, [[innerWidth, 1], ...sumTerms(widths, -1), ...gaps.terms], fitEpsilon + gaps.bias, {kind: 'overflow', node: node.name, detail: -1}))
      } else {
        widths.forEach((childWidth, index) => {
          fitsBits.push(atLeastZero(circuit, [[innerWidth, 1], [childWidth, -1]], fitEpsilon, {kind: 'overflow', node: node.name, detail: index}))
        })
      }
    }
    const countWire = circuit.affine(sumTerms(fitsBits, -1), fitsBits.length)
    circuit.assumeRange(countWire, 0, fitsBits.length)
    return countWire
  })

  const rootSize = (sizing: Sizing, viewport: Wire) => {
    switch (sizing.kind) {
      case 'fixed': return constantWire(circuit, sizing.size)
      case 'input': return inputWire(sizing.input)
      case 'percent': return circuit.affine([[viewport, sizing.fraction]])
      case 'fit':
      case 'grow': return clampConstant(circuit, viewport, sizing.min, sizing.max)
    }
  }
  measureWidths(root, 0)
  width.set(root, tagged(passNames[1], 0, () => rootSize(root.width, inputWire('viewportWidth'))))
  resolveWidths(root, 0)
  countLines()
  measureHeights(root, 0)
  height.set(root, tagged(passNames[4], 0, () => rootSize(root.height, inputWire('viewportHeight'))))
  resolveHeights(root, 0)
  x.set(root, zero)
  y.set(root, zero)
  place(root, 0)
  if (options.overflow) output.overflowCount = measureOverflow()
  return output
}

// Flat list of every output wire, and a reader that turns evaluated roots back into a LayoutResult.
export function createLayoutReader(wires: LayoutWires) {
  const roots: Wire[] = []
  const push = (wire: Wire) => roots.push(wire) - 1
  const rects = [...wires.rects].map(([name, rect]) => [name, push(rect.x), push(rect.y), push(rect.width), push(rect.height)] as const)
  const lines = [...wires.lines].map(([name, wire]) => [name, push(wire)] as const)
  const scroll = [...wires.scroll].map(([name, wire]) => [name, push(wire)] as const)
  const wrapLines = [...wires.wrapLines].map(([name, list]) => [name, list.map(push)] as const)
  const gridColumns = [...wires.gridColumns].map(([name, wire]) => [name, push(wire)] as const)
  const read = (outputs: ArrayLike<number>): LayoutResult => ({
    rects: new Map(rects.map(([name, px, py, pw, ph]) => [name, {x: outputs[px]!, y: outputs[py]!, width: outputs[pw]!, height: outputs[ph]!}])),
    lines: new Map(lines.map(([name, position]) => [name, outputs[position]!])),
    scroll: new Map(scroll.map(([name, position]) => [name, outputs[position]!])),
    wrapLines: new Map(wrapLines.map(([name, positions]) => [name, positions.map(position => outputs[position]!)])),
    gridColumns: new Map(gridColumns.map(([name, position]) => [name, outputs[position]!])),
  })
  // The same reader over a Float32Array indexed by wire, e.g. evaluateReference's output.
  const readWires = (values: ArrayLike<number>): LayoutResult => read(roots.map(wire => values[wire]!))
  return {roots, read, readWires}
}

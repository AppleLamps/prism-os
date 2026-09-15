// A static widget tree for Clay-style layout. The tree's shape and constants are
// fixed at compile time; only named inputs (viewport size, scroll positions, a
// sidebar width driven by a spring) and prepared text tables change at runtime.
//
// The layout semantics shared by the JS reference (reference.ts) and the circuit
// builder (builder.ts), in Clay's pass order:
//
// 1. Fit widths, children before parents. A node's fit width is what it wants
//    and its min width is how far a parent may shrink it.
//    - fixed or input: both equal the size. percent: both 0 (resolved top-down).
//    - fit or grow (min, max): content clamped to [min, max]. A box has no
//      content, so it starts at min. Text content is its natural single-line
//      width, and its min content is its widest unbreakable word.
//    - row content: padding + sum of non-percent children + gaps; min content
//      sums children's min widths. column content: padding + widest child.
//      wrap content: like row for fit, widest child's min for min.
//      grid content: min(n, maxColumns) cells for fit, one cell for min.
// 2. Widths, parents before children. The root takes the viewport width.
//    - row: percent children take (inner - gaps) * fraction. When space is
//      left, grow children rise from their fit widths toward a common level,
//      each capped at its max (water filling). When content overflows, every
//      resizable child (fit, grow, text) comes down from its fit width toward a
//      common level, each floored at its min width.
//    - column (cross axis): percent takes inner * fraction; grow takes
//      max(minWidth, min(inner, max)); fit and text take
//      max(minWidth, min(fitWidth, inner)); fixed keeps its size.
//    - wrap: children take their clamped fit widths, then break into lines
//      greedily: a child joins the current line when the line's used width plus
//      the gap plus the child is at most the inner width plus fitEpsilon.
//    - grid: columns = 1 + count of c in 2..maxColumns with
//      inner + fitEpsilon >= c * minCellWidth + (c - 1) * gap; every child takes
//      (inner - (columns - 1) * gap) / columns.
// 3. Text lines: lines = baseLines + count of thresholds greater than the
//    text's width (a staircase tabulated at prepare time).
// 4. Fit heights, children before parents: as widths, with column as the main
//    axis. Text height is lines * lineHeight. A wrap container stacks its
//    lines, each as tall as its tallest child. A grid stacks rows of
//    ceil(n / columns), each as tall as its tallest cell. A scroll container's
//    min height ignores its children.
// 5. Heights, parents before children: column grows and shrinks like row did
//    along x, except that scroll containers never shrink their children.
//    Row children follow the cross-axis rule. Wrap children keep their fit
//    heights. Grid cells stretch to their row's height.
// 6. Positions, parents before children. Main-axis alignment moves the whole
//    run of children by factor * max(0, leftover space) with factor 0, 0.5, 1
//    for start, center, end; cross-axis alignment moves each child by
//    factor * (inner - child size). Wrap lines align along x per line, and
//    children align along y within their line. A scroll container moves its
//    children up by its input clamped to [0, max(0, content height - height)].
//    A sticky node whose parent is a column strictly inside a scroll container
//    moves down to max(naturalTop, min(scrollContainerTop, parentInnerBottom - height)),
//    together with its descendants. A sticky flag anywhere else, including on a
//    direct child of the scroll container, has no effect.

// "Does it fit" decisions for wrap lines and grid column counts allow this much overflow,
// like pretext's lineFitEpsilon. A fit-width wrap container is exactly as wide as its
// content on one line, so its last child always sits on a tie between two sums that FP32
// rounds in different orders; the epsilon makes that tie resolve as "fits" in both.
export const fitEpsilon = 1 / 64

export type Align = 'start' | 'center' | 'end'

export type Sizing =
  | {readonly kind: 'fixed', readonly size: number}
  | {readonly kind: 'input', readonly input: string}
  | {readonly kind: 'percent', readonly fraction: number}
  | {readonly kind: 'fit', readonly min: number, readonly max: number}
  | {readonly kind: 'grow', readonly min: number, readonly max: number}

export type Padding = {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

type NodeBase = {
  readonly name: string
  readonly width: Sizing
  readonly height: Sizing
  readonly sticky: boolean
}

export type BoxNode = NodeBase & {readonly kind: 'box'}

// Height sizing is ignored for text: its height always follows its line count.
export type TextNode = NodeBase & {
  readonly kind: 'text'
  readonly textId: string
  readonly lineHeight: number
  // How many threshold cells the source table reserves for this text.
  readonly capacity: number
}

export type ContainerLayout = 'row' | 'column' | 'wrap' | 'grid'

export type ContainerNode = NodeBase & {
  readonly kind: 'container'
  readonly layout: ContainerLayout
  readonly padding: Padding
  readonly gap: number
  readonly alignX: Align
  readonly alignY: Align
  // Name of the input holding this column's requested scroll position.
  readonly scrollY: string | null
  readonly minCellWidth: number
  readonly maxColumns: number
  readonly children: readonly LayoutNode[]
}

export type LayoutNode = BoxNode | TextNode | ContainerNode

export type TextTable = {
  readonly naturalWidth: number
  readonly minWidth: number
  readonly baseLines: number
  // Widths at which the line count drops by one, in any order.
  readonly thresholds: readonly number[]
}

export type Rect = {x: number, y: number, width: number, height: number}

// Both implementations produce this shape, keyed by node name.
export type LayoutResult = {
  rects: Map<string, Rect>
  lines: Map<string, number>
  scroll: Map<string, number>
  wrapLines: Map<string, number[]>
  gridColumns: Map<string, number>
}

export const fixed = (size: number): Sizing => ({kind: 'fixed', size})
export const input = (name: string): Sizing => ({kind: 'input', input: name})
export const percent = (fraction: number): Sizing => ({kind: 'percent', fraction})
export const fit = (min = 0, max = Number.POSITIVE_INFINITY): Sizing => ({kind: 'fit', min, max})
export const grow = (min = 0, max = Number.POSITIVE_INFINITY): Sizing => ({kind: 'grow', min, max})

export function padding(top: number, right = top, bottom = top, left = right): Padding {
  return {top, right, bottom, left}
}

type ContainerOptions = {
  name: string
  width?: Sizing
  height?: Sizing
  padding?: Padding
  gap?: number
  alignX?: Align
  alignY?: Align
  scrollY?: string
  sticky?: boolean
  minCellWidth?: number
  maxColumns?: number
}

function container(layout: ContainerLayout, options: ContainerOptions, children: readonly LayoutNode[]): ContainerNode {
  return {
    kind: 'container',
    layout,
    name: options.name,
    width: options.width ?? fit(),
    height: options.height ?? fit(),
    padding: options.padding ?? padding(0),
    gap: options.gap ?? 0,
    alignX: options.alignX ?? 'start',
    alignY: options.alignY ?? 'start',
    scrollY: options.scrollY ?? null,
    sticky: options.sticky ?? false,
    minCellWidth: options.minCellWidth ?? 0,
    maxColumns: options.maxColumns ?? 1,
    children,
  }
}

export const row = (options: ContainerOptions, children: readonly LayoutNode[]) => container('row', options, children)
export const column = (options: ContainerOptions, children: readonly LayoutNode[]) => container('column', options, children)
export const wrap = (options: ContainerOptions, children: readonly LayoutNode[]) => container('wrap', options, children)
export const grid = (options: ContainerOptions & {minCellWidth: number, maxColumns: number}, children: readonly LayoutNode[]) =>
  container('grid', options, children)

export function box(name: string, width: Sizing, height: Sizing, sticky = false): BoxNode {
  return {kind: 'box', name, width, height, sticky}
}

export function text(name: string, textId: string, options: {width?: Sizing, lineHeight: number, capacity: number}): TextNode {
  return {
    kind: 'text',
    name,
    textId,
    width: options.width ?? fit(),
    height: fit(),
    sticky: false,
    lineHeight: options.lineHeight,
    capacity: options.capacity,
  }
}

export function alignFactor(align: Align): number {
  return align === 'start' ? 0 : align === 'center' ? 0.5 : 1
}

export function isResizable(node: LayoutNode, axis: 'x' | 'y'): boolean {
  const sizing = axis === 'x' ? node.width : node.height
  if (node.kind === 'text' && axis === 'y') return true
  return sizing.kind === 'fit' || sizing.kind === 'grow'
}

export type NodeVisit = {node: LayoutNode, parent: ContainerNode | null, level: number}

// Pre-order walk with parents and levels (the root is level 0).
export function walk(root: LayoutNode): NodeVisit[] {
  const visits: NodeVisit[] = []
  const visit = (node: LayoutNode, parent: ContainerNode | null, level: number) => {
    visits.push({node, parent, level})
    if (node.kind === 'container') for (const child of node.children) visit(child, node, level + 1)
  }
  visit(root, null, 0)
  return visits
}

// Every input name the tree reads, including scroll inputs.
export function treeInputs(root: LayoutNode): string[] {
  const names = new Set<string>(['viewportWidth', 'viewportHeight'])
  for (const {node} of walk(root)) {
    if (node.width.kind === 'input') names.add(node.width.input)
    if (node.height.kind === 'input') names.add(node.height.input)
    if (node.kind === 'container' && node.scrollY !== null) names.add(node.scrollY)
  }
  return [...names]
}

// The nearest scroll container above a sticky node, if the sticky rule applies:
// the node's parent is a column and some strict ancestor of the parent scrolls.
export function stickyScrollAncestor(root: LayoutNode, target: LayoutNode): ContainerNode | null {
  const path: ContainerNode[] = []
  const search = (node: LayoutNode): boolean => {
    if (node === target) return true
    if (node.kind !== 'container') return false
    path.push(node)
    for (const child of node.children) if (search(child)) return true
    path.pop()
    return false
  }
  if (!search(root)) return null
  const parent = path.at(-1)
  if (parent === undefined || parent.layout !== 'column') return null
  for (let index = path.length - 2; index >= 0; index--) {
    const ancestor = path[index]!
    if (ancestor.scrollY !== null && ancestor.layout === 'column') return ancestor
  }
  return null
}

export function validateTree(root: LayoutNode) {
  const names = new Set<string>()
  for (const {node} of walk(root)) {
    if (names.has(node.name)) throw new Error(`duplicate node name ${node.name}`)
    names.add(node.name)
    for (const sizing of [node.width, node.height]) {
      if ((sizing.kind === 'fit' || sizing.kind === 'grow') && !(sizing.min <= sizing.max)) {
        throw new Error(`${node.name}: min is above max`)
      }
    }
    if (node.kind === 'container') {
      if (node.scrollY !== null && node.layout !== 'column') throw new Error(`${node.name}: only columns scroll`)
      if (node.layout === 'grid' && (node.maxColumns < 1 || node.minCellWidth <= 0)) {
        throw new Error(`${node.name}: grid needs maxColumns >= 1 and a positive minCellWidth`)
      }
    }
  }
}

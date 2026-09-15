// An app shell built from the layout tree: a header with a title and buttons, a
// collapsible sidebar whose width springs, a scroll container with sticky section headers
// over wrapping card grids with text, a wrapping row of tags, and a footer. One circuit
// handles the menu button's toggle, the spring, and the whole layout every frame.
import {emitSpring, type Wire} from '../../../numeric-ui-core.ts'
import {allocateLayoutSources, buildLayout, createLayoutReader, writeLayoutSources, type LayoutSources, type LayoutWires} from './builder.ts'
import {SourceTable, type TaggedCircuit} from './circuit-tools.ts'
import {atLeastZero, relu} from './ops.ts'
import {
  box,
  column,
  fit,
  fixed,
  grid,
  grow,
  input,
  padding,
  row,
  text,
  wrap,
  type LayoutNode,
  type LayoutResult,
  type TextTable,
} from './tree.ts'

export type TextStyle = {fontSize: number, fontWeight: number, lineHeight: number}

export const textStyles = {
  title: {fontSize: 18, fontWeight: 650, lineHeight: 24},
  button: {fontSize: 14, fontWeight: 550, lineHeight: 20},
  nav: {fontSize: 15, fontWeight: 450, lineHeight: 22},
  section: {fontSize: 16, fontWeight: 650, lineHeight: 22},
  cardTitle: {fontSize: 15, fontWeight: 600, lineHeight: 20},
  caption: {fontSize: 14, fontWeight: 400, lineHeight: 20},
  meta: {fontSize: 12, fontWeight: 500, lineHeight: 16},
  chip: {fontSize: 13, fontWeight: 500, lineHeight: 18},
} satisfies Record<string, TextStyle>

export type TextStyleName = keyof typeof textStyles

export type AppText = {text: string, style: TextStyleName}

const cardData = [
  ['Harbor at dawn', 'Fishing boats idle in a quiet harbor while the fog lifts over the breakwater.', 'Photo', 'Mar 2'],
  ['Quarterly notes', 'Revenue grew in every region, and the support backlog finally dropped under a week.', 'Doc', 'Feb 27'],
  ['Kitchen remodel', 'Oak cabinets, a long counter, and a window over the sink.', 'Board', 'Feb 20'],
  ['Trail map', 'Nine kilometers along the ridge, with two water stops and one steep descent near the end.', 'Map', 'Feb 18'],
  ['Onboarding', 'Accounts, laptops, and a first small bug to fix.', 'Checklist', 'Feb 11'],
  ['Font pairing', 'A humanist sans for the interface and a warm serif for long reading.', 'Design', 'Feb 9'],
  ['Budget draft', 'Travel is flat, hardware is up, and the offsite moves to spring.', 'Sheet', 'Feb 3'],
  ['Garden plan', 'Tomatoes against the south wall, herbs in the raised beds, and a trellis for beans.', 'Plan', 'Jan 30'],
  ['Release notes', 'Faster startup, a new sidebar, and fixes for scrolling on small screens.', 'Doc', 'Jan 24'],
  ['Studio visit', 'Clay, glaze tests, and a kiln that runs overnight.', 'Photo', 'Jan 19'],
  ['Reading list', 'Six books on cities, two on typography, and one novel set on a train that never stops.', 'List', 'Jan 12'],
  ['Team offsite', 'Two days by the lake with a planning session each morning.', 'Event', 'Jan 5'],
  ['Color study', 'Muted greens next to a single bright orange accent.', 'Design', 'Dec 28'],
  ['Moving boxes', 'Books first, then the kitchen, and the plants ride in the front seat.', 'Checklist', 'Dec 21'],
] as const

const navItems = ['Home', 'Recent', 'Shared with me', 'Starred', 'Archive', 'Settings'] as const
const tagItems = ['design', 'writing', 'photos', 'planning', 'travel', 'home', 'research notes', 'budget', 'long-term ideas', 'q1'] as const

export type AppShellOptions = {
  // 'this frame': the layout reads the spring's new position (the default, no lag).
  // 'previous frame': the layout reads the spring position from the source table, one frame
  // behind, which takes the spring off the layout's longest chain.
  springFeedsLayout: 'this frame' | 'previous frame'
  // The wrapping row of tags, whose greedy line scan is the deepest part of the layout.
  tags: boolean
}

const defaultOptions: AppShellOptions = {springFeedsLayout: 'this frame', tags: true}

export function createAppShellTree(options: AppShellOptions = defaultOptions): {root: LayoutNode, texts: Map<string, AppText>} {
  const texts = new Map<string, AppText>()
  const addText = (name: string, content: string, style: TextStyleName, width = fit()) => {
    texts.set(name, {text: content, style})
    const words = content.split(' ').length
    return text(name, name, {width, lineHeight: textStyles[style].lineHeight, capacity: Math.max(1, words)})
  }
  const button = (name: string, label: string) =>
    row({name, padding: padding(6, 12), alignY: 'center'}, [addText(`${name}.label`, label, 'button')])
  const card = (index: number) => {
    const [title, caption, kind, date] = cardData[index % cardData.length]!
    return column({name: `card${index}`, width: grow(), padding: padding(12), gap: 8}, [
      box(`card${index}.thumb`, grow(), fixed(96)),
      addText(`card${index}.title`, title, 'cardTitle', grow()),
      addText(`card${index}.caption`, caption, 'caption', grow()),
      box(`card${index}.spacer`, fixed(0), grow()),
      row({name: `card${index}.meta`, width: grow(), gap: 8, alignY: 'center'}, [
        addText(`card${index}.kind`, kind, 'meta'),
        box(`card${index}.metaSpacer`, grow(), fixed(0)),
        addText(`card${index}.date`, date, 'meta'),
      ]),
    ])
  }
  const section = (name: string, title: string, firstCard: number, cardCount: number) =>
    column({name, width: grow(), gap: 12}, [
      row({name: `${name}.header`, width: grow(), height: fixed(44), padding: padding(0, 12), alignY: 'center', sticky: true}, [
        addText(`${name}.title`, title, 'section'),
      ]),
      grid({name: `${name}.grid`, width: grow(), gap: 12, minCellWidth: 220, maxColumns: 5},
        Array.from({length: cardCount}, (_, index) => card(firstCard + index))),
    ])
  const root = column({name: 'root', width: grow(), height: grow()}, [
    row({name: 'header', width: grow(), height: fixed(56), padding: padding(8, 16), gap: 12, alignY: 'center'}, [
      box('menuButton', fixed(40), fixed(40)),
      addText('title', 'Indirect layout tree', 'title'),
      box('headerSpacer', grow(), fixed(1)),
      row({name: 'actions', gap: 8, alignY: 'center'}, [
        button('shareButton', 'Share'),
        button('exportButton', 'Export'),
        button('newButton', 'New document'),
      ]),
    ]),
    row({name: 'body', width: grow(), height: grow()}, [
      column({name: 'sidebar', width: input('sidebarWidth'), height: grow(), padding: padding(12, 0, 12, 12), gap: 4},
        navItems.map((label, index) => row({name: `nav${index}`, width: fixed(196), height: fixed(36), padding: padding(0, 12), alignY: 'center'}, [
          addText(`nav${index}.label`, label, 'nav'),
        ]))),
      column({name: 'main', width: grow(), height: grow(), padding: padding(16), gap: 24, scrollY: 'mainScroll'}, [
        ...(options.tags
          ? [wrap({name: 'tags', width: grow(), gap: 8}, tagItems.map((label, index) =>
              row({name: `tag${index}`, padding: padding(4, 10)}, [addText(`tag${index}.label`, label, 'chip')])))]
          : []),
        section('recent', 'Recently edited', 0, 8),
        section('shared', 'Shared with you', 8, 6),
      ]),
    ]),
    row({name: 'footer', width: grow(), height: fixed(32), padding: padding(0, 16), gap: 12, alignY: 'center'}, [
      addText('footer.status', 'All changes saved', 'meta'),
      box('footerSpacer', grow(), fixed(0)),
      addText('footer.version', 'one circuit per frame', 'meta'),
    ]),
  ])
  return {root, texts}
}

export const sidebarOpenWidth = 220
export const sidebarBreakpoint = 640

export type AppShell = {
  root: LayoutNode
  texts: Map<string, AppText>
  table: SourceTable
  circuit: TaggedCircuit
  sources: LayoutSources
  layout: LayoutWires
  sidebarWidth: Wire
  animating: Wire
  nextSource: [cell: Wire, wire: Wire][]
  roots: Wire[]
  read: (outputs: ArrayLike<number>) => LayoutResult
}

export function createAppShell(overrides: Partial<AppShellOptions> = {}): AppShell {
  const options = {...defaultOptions, ...overrides}
  const {root, texts} = createAppShellTree(options)
  const table = new SourceTable()
  const cells = {
    unit: table.cell('unit', 1, 1, 1),
    downActive: table.cell('pointer.downActive', 0, 0, 1),
    downX: table.cell('pointer.downX', 0, -sizeLimit, sizeLimit),
    downY: table.cell('pointer.downY', 0, -sizeLimit, sizeLimit),
    open: table.cell('sidebar.open', 1, 0, 1),
    position: table.cell('sidebar.position', sidebarOpenWidth, -400, 800),
    velocity: table.cell('sidebar.velocity', 0, -50_000, 50_000),
    stiffness: table.cell('spring.stiffness', 650, 0, 2000),
    damping: table.cell('spring.damping', 45, 0, 200),
    // The machine clamps a frame to 32 ms and writes a quarter of it, so the largest timestep is 0.008. The Float32Array
    // stores 0.008 as 0.0080000004, so the declared maximum is that stored value. A maximum of exactly 0.008 made the
    // source range check throw for any frame of 32 ms or longer.
    timestep: table.cell('spring.timestep', 0, 0, Math.fround(0.008)),
    settleDistance: table.cell('spring.settleDistance', 0.05, 0, 10),
    settleSpeed: table.cell('spring.settleSpeed', 0.5, 0, 100),
    settleScale: table.cell('spring.settleScale', 1000, 0, 100_000),
    // The menu button's rectangle as the user saw it on the previous frame.
    menuX: table.cell('menu.x', 16, -sizeLimit, sizeLimit),
    menuY: table.cell('menu.y', 8, -sizeLimit, sizeLimit),
    menuWidth: table.cell('menu.width', 40, 0, sizeLimit),
    menuHeight: table.cell('menu.height', 40, 0, sizeLimit),
  }
  const sources = allocateLayoutSources(table, root, {
    externalInputs: new Set(['sidebarWidth']),
    inputBounds: new Map([['viewportWidth', [0, 4096]], ['viewportHeight', [0, 4096]], ['mainScroll', [0, 8192]]]),
  })
  const circuit = table.createCircuit()
  const app = circuit.withTag('app', () => {
    const edges = [
      atLeastZero(circuit, [[cells.downX, 1], [cells.menuX, -1]], 0),
      atLeastZero(circuit, [[cells.menuX, 1], [cells.menuWidth, 1], [cells.downX, -1]], 0),
      atLeastZero(circuit, [[cells.downY, 1], [cells.menuY, -1]], 0),
      atLeastZero(circuit, [[cells.menuY, 1], [cells.menuHeight, 1], [cells.downY, -1]], 0),
    ]
    // AND of exact bits: relu(sum - (count - 1)).
    const press = relu(circuit, [[cells.downActive, 1], ...edges.map((edge): [Wire, number] => [edge, 1])], -4)
    circuit.assumeRange(press, 0, 1)
    const toggled = circuit.multiply(press, cells.open)
    const open = circuit.affine([[cells.open, 1], [press, 1], [toggled, -2]])
    circuit.assumeRange(open, 0, 1)
    const wide = atLeastZero(circuit, [[sources.inputs.get('viewportWidth')!, 1]], -sidebarBreakpoint)
    const shown = relu(circuit, [[open, 1], [wide, 1]], -1)
    const destination = circuit.affine([[shown, sidebarOpenWidth]])
    const spring = emitSpring(circuit, cells.position, destination, cells.velocity, cells.stiffness, cells.damping,
      cells.timestep, cells.settleDistance, cells.settleSpeed, cells.settleScale, cells.settleScale, cells.unit)
    const sidebarWidth = relu(circuit, [[options.springFeedsLayout === 'this frame' ? spring.position : cells.position, 1]])
    return {open, spring, sidebarWidth}
  })
  sources.inputs.set('sidebarWidth', app.sidebarWidth)
  const layout = buildLayout(circuit, root, sources)
  const menu = layout.rects.get('menuButton')!
  const nextSource: [Wire, Wire][] = [
    [cells.open, app.open],
    [cells.position, app.spring.position],
    [cells.velocity, app.spring.velocity],
    [cells.menuX, menu.x],
    [cells.menuY, menu.y],
    [cells.menuWidth, menu.width],
    [cells.menuHeight, menu.height],
    [sources.inputs.get('mainScroll')!, layout.scroll.get('main')!],
  ]
  const reader = createLayoutReader(layout)
  const roots = [...reader.roots, app.sidebarWidth, app.spring.active, ...nextSource.map(([, wire]) => wire)]
  return {root, texts, table, circuit, sources, layout, sidebarWidth: app.sidebarWidth, animating: app.spring.active, nextSource, roots, read: reader.read}
}

const sizeLimit = 8192

export type AppFrame = {
  viewportWidth: number
  viewportHeight: number
  // Seconds since the previous frame.
  frameDuration: number
  pointerDown: {x: number, y: number} | null
  scrollDelta: number
}

export type AppFrameResult = {
  layout: LayoutResult
  sidebarWidth: number
  animating: boolean
  // The inputs this frame's layout used, for checking against the JS reference.
  inputs: Record<string, number>
}

export function createAppMachine(shell: AppShell, tables: ReadonlyMap<string, TextTable>) {
  const values = shell.table.createValues()
  writeLayoutSources(values, shell.sources, {viewportWidth: 1280, viewportHeight: 800, mainScroll: 0}, tables)
  const evaluate = shell.circuit.createTensorEvaluator(shell.roots)
  const layoutRootCount = shell.roots.length - 2 - shell.nextSource.length
  const cell = (name: string) => shell.table.wire(name)
  const step = (frame: AppFrame): AppFrameResult => {
    const scrollCell = shell.sources.inputs.get('mainScroll')!
    values[cell('input.viewportWidth')] = frame.viewportWidth
    values[cell('input.viewportHeight')] = frame.viewportHeight
    values[scrollCell] = Math.min(8192, Math.max(0, values[scrollCell]! + frame.scrollDelta))
    values[cell('spring.timestep')] = Math.min(0.032, Math.max(0, frame.frameDuration)) / 4
    values[cell('pointer.downActive')] = frame.pointerDown === null ? 0 : 1
    if (frame.pointerDown !== null) {
      values[cell('pointer.downX')] = Math.min(8192, Math.max(-8192, frame.pointerDown.x))
      values[cell('pointer.downY')] = Math.min(8192, Math.max(-8192, frame.pointerDown.y))
    }
    const inputs = {viewportWidth: values[cell('input.viewportWidth')]!, viewportHeight: values[cell('input.viewportHeight')]!, mainScroll: values[scrollCell]!}
    const outputs = evaluate(values)
    const sidebarWidth = outputs[layoutRootCount]!
    const animating = outputs[layoutRootCount + 1]! > 0
    const layout = shell.read(outputs)
    shell.nextSource.forEach(([target], index) => { values[target] = outputs[layoutRootCount + 2 + index]! })
    values[cell('pointer.downActive')] = 0
    return {layout, sidebarWidth, animating, inputs: {...inputs, sidebarWidth}}
  }
  return {values, step}
}

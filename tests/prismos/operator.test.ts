import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createWindowManagerMachine} from '../../src/handwiredos/window-manager.ts'
import {arrangePrismWindows} from '../../src/prismos/arrangement.ts'
import {appWindowIndex, toolDeclarations, validateCall, type Command} from '../../src/prismos/commands.ts'
import {createOperator, type MachineDriver, type PageEffects, type PanelControls, type PanelState, type Rectangle} from '../../src/prismos/operator.ts'
import {defaultSettings, type Settings} from '../../src/prismos/settings.ts'
import {framingFor} from '../../src/prismos/web-address.ts'
import type {PanelAppName} from '../../src/prismos/commands.ts'

// A machine on a clock of its own: each frame is 16 ms after the last, and an event
// queued between frames is 8 ms before the next one, like the window manager's tests.
function createTestDriver(width = 1280, height = 800): MachineDriver {
  const machine = createWindowManagerMachine()
  arrangePrismWindows(machine.source, machine.cells, width, height)
  let frameTime = 16
  machine.step(width, height, frameTime)
  return {
    machine,
    viewport: () => ({width, height}),
    now: () => frameTime + 8,
    frame: async () => {
      frameTime += 16
      machine.step(width, height, frameTime)
    },
  }
}

function createPage(driver: MachineDriver) {
  let settings: Settings = {...defaultSettings}
  let note = 'first line'
  let slideshow = false
  const {width, height} = driver.viewport()
  const home = (() => {
    const scratch = createWindowManagerMachine()
    return arrangePrismWindows(scratch.source, scratch.cells, width, height)
  })()
  // Prism's panels as the shell keeps them: a state, a zoom, a place.
  const panelStates = new Map<PanelAppName, {state: PanelState, zoomed: boolean, position: string | null}>()
  const panel = (id: PanelAppName) => {
    const entry = panelStates.get(id) ?? {state: 'closed' as PanelState, zoomed: false, position: null}
    panelStates.set(id, entry)
    return entry
  }
  let behind = 0
  const browsed: string[] = []
  const navigated: string[] = []
  const timers: string[] = []
  let front: PanelAppName | null = null
  const panels: PanelControls = {
    state: id => panel(id).state,
    zoomed: id => panel(id).zoomed,
    resizable: id => id !== 'calculator',
    open: id => { panel(id).state = 'open' },
    close: id => { panel(id).state = 'closed' },
    minimize: id => { if (panel(id).state === 'open') panel(id).state = 'minimized' },
    zoom: id => { panel(id).zoomed = !panel(id).zoomed },
    move: (id, position) => { panel(id).position = position },
    sendBehind: () => { behind++ },
    stopwatch: action => `stopwatch ${action}`,
    browse: url => {
      browsed.push(url)
      panel('browser').state = 'open'
      return framingFor(url)
    },
    browserNavigate: action => {
      navigated.push(action)
      return `browser ${action}`
    },
    timer: request => {
      timers.push(request.kind === 'start' ? `start ${request.seconds}` : request.kind)
      return `timer ${request.kind}`
    },
    front: () => front,
  }
  const page: PageEffects = {
    settings: {get: () => settings, update: change => { settings = {...settings, ...change} }},
    panels,
    note: {read: () => note, write: text => { note = text }},
    slideshow: {start: () => { slideshow = true }, stop: () => { slideshow = false }, running: () => slideshow},
    homeRectangles: () => home,
  }
  return {page, settings: () => settings, note: () => note, slideshow: () => slideshow, home, panel, behind: () => behind, browsed, navigated, timers, setFront: (app: PanelAppName | null) => { front = app }}
}

function command(name: string, args: Record<string, unknown> = {}): Command {
  const result = validateCall(name, args)
  assert.ok(result.ok, result.ok ? '' : result.reason)
  return result.command
}

function setup(width?: number, height?: number) {
  const driver = createTestDriver(width, height)
  const fake = createPage(driver)
  const operator = createOperator(driver, fake.page)
  return {driver, fake, operator}
}

const insideWorkspace = (rectangle: Rectangle, width = 1280, height = 800) =>
  rectangle.left >= 0 && rectangle.top >= 36 && rectangle.left + rectangle.width <= width && rectangle.top + rectangle.height <= height - 76

test('every declared tool validates with arguments from its own enums', () => {
  for (const declaration of toolDeclarations) {
    const args: Record<string, unknown> = {}
    for (const [key, parameter] of Object.entries(declaration.function.parameters.properties)) {
      args[key] = parameter.enum?.[0] ?? ({photo: '3', expression: '2 + 2', city: 'tokyo', address: 'wikipedia.org', duration: '5 minutes'} as Record<string, string>)[key] ?? 'hello'
    }
    if (declaration.function.name === 'side_by_side') args['right'] = 'chroma'
    const result = validateCall(declaration.function.name, args)
    assert.ok(result.ok, `${declaration.function.name}: ${result.ok ? '' : result.reason}`)
  }
})

test('minimize, then open from the dock, through the program\'s own buttons', async () => {
  const {operator} = setup()
  const inkwell = appWindowIndex.inkwell
  assert.equal(operator.windowState(inkwell).minimized, false)
  assert.equal(await operator.run(command('minimize_app', {app: 'notes'})), 'Minimized Inkwell.')
  assert.equal(operator.windowState(inkwell).minimized, true)
  assert.equal(await operator.run(command('minimize_app', {app: 'inkwell'})), 'Inkwell is already in the dock.')
  await operator.run(command('open_app', {app: 'inkwell'}))
  const state = operator.windowState(inkwell)
  assert.equal(state.minimized, false)
  assert.equal(state.focused, true)
})

test('maximize fills the workspace and restore brings the window back', async () => {
  const {operator} = setup()
  const chroma = appWindowIndex.chroma
  const before = operator.windowState(chroma).rectangle
  await operator.run(command('maximize_app', {app: 'chroma'}))
  const maximized = operator.windowState(chroma)
  assert.equal(maximized.maximized, true)
  assert.ok(maximized.rectangle.width > before.width)
  await operator.run(command('restore_app', {app: 'chroma'}))
  assert.equal(operator.windowState(chroma).maximized, false)
  assert.deepEqual(operator.windowState(chroma).rectangle, before)
})

test('close, then the dock opens the window again', async () => {
  const {operator} = setup()
  await operator.run(command('close_app', {app: 'scope'}))
  assert.equal(operator.windowState(appWindowIndex.scope).open, false)
  assert.equal(await operator.run(command('close_app', {app: 'scope'})), 'Scope is already closed.')
  await operator.run(command('open_app', {app: 'monitor'}))
  assert.equal(operator.windowState(appWindowIndex.scope).open, true)
})

test('move puts a window at the workspace\'s edge, and the program keeps it inside', async () => {
  const {operator} = setup()
  for (const position of ['left', 'right', 'top_left', 'bottom_right', 'center'] as const) {
    await operator.run(command('move_app', {app: 'inkwell', position}))
    const rectangle = operator.windowState(appWindowIndex.inkwell).rectangle
    assert.ok(insideWorkspace(rectangle), `${position}: ${JSON.stringify(rectangle)}`)
    if (position === 'left' || position === 'top_left') assert.equal(rectangle.left, 12)
    if (position === 'right' || position === 'bottom_right') assert.equal(rectangle.left + rectangle.width, 1280 - 12)
    if (position === 'top_left') assert.equal(rectangle.top, 36 + 12)
  }
})

test('a maximized window is restored before it moves', async () => {
  const {operator} = setup()
  await operator.run(command('maximize_app', {app: 'chroma'}))
  await operator.run(command('move_app', {app: 'chroma', position: 'top_left'}))
  const state = operator.windowState(appWindowIndex.chroma)
  assert.equal(state.maximized, false)
  assert.equal(state.rectangle.left, 12)
})

test('resize grows and shrinks around the center, never past the workspace', async () => {
  const {operator} = setup()
  const index = appWindowIndex.scope
  const before = operator.windowState(index).rectangle
  await operator.run(command('resize_app', {app: 'scope', size: 'bigger'}))
  const bigger = operator.windowState(index).rectangle
  assert.ok(bigger.width > before.width && bigger.height > before.height, JSON.stringify({before, bigger}))
  await operator.run(command('resize_app', {app: 'scope', size: 'large'}))
  const large = operator.windowState(index).rectangle
  assert.ok(insideWorkspace(large), JSON.stringify(large))
  await operator.run(command('resize_app', {app: 'scope', size: 'small'}))
  const small = operator.windowState(index).rectangle
  assert.ok(small.width >= 280 && small.height >= 190, JSON.stringify(small))
  assert.ok(small.width < large.width)
})

test('side by side splits the workspace between two windows', async () => {
  const {operator} = setup()
  await operator.run(command('side_by_side', {left: 'scope', right: 'chroma'}))
  const left = operator.windowState(appWindowIndex.scope).rectangle
  const right = operator.windowState(appWindowIndex.chroma).rectangle
  assert.deepEqual(left, {left: 0, top: 36, width: 640, height: 800 - 36 - 76})
  assert.deepEqual(right, {left: 640, top: 36, width: 640, height: 800 - 36 - 76})
})

test('show desktop minimizes every window, and reset layout puts them back', async () => {
  const {operator, fake} = setup()
  await operator.run(command('move_app', {app: 'chroma', position: 'top_left'}))
  await operator.run(command('show_desktop'))
  for (const index of [0, 1, 2]) assert.equal(operator.windowState(index).minimized, true)
  await operator.run(command('reset_layout'))
  for (const index of [0, 1, 2]) {
    const state = operator.windowState(index)
    assert.equal(state.minimized, false)
    assert.deepEqual(state.rectangle, fake.home[index])
  }
})

test('photos open by name and by number, step with wraparound, and close', async () => {
  const {operator} = setup()
  assert.equal(await operator.run(command('open_photo', {photo: 'Blue Lagoon'})), 'Opened Blue Lagoon.')
  assert.equal(operator.openPhoto(), 10)
  await operator.run(command('next_photo'))
  assert.equal(operator.openPhoto(), 11)
  await operator.run(command('next_photo'))
  assert.equal(operator.openPhoto(), 0)
  await operator.run(command('previous_photo'))
  assert.equal(operator.openPhoto(), 11)
  // With a photo open, another opens from the thumbnail strip.
  await operator.run(command('open_photo', {photo: 'three'}))
  assert.equal(operator.openPhoto(), 2)
  await operator.run(command('close_photo'))
  assert.equal(operator.openPhoto(), -1)
  assert.equal(await operator.run(command('close_photo')), 'No photo is open.')
})

test('a photo opens even when Chroma was minimized behind other windows', async () => {
  const {operator} = setup()
  await operator.run(command('minimize_app', {app: 'chroma'}))
  await operator.run(command('open_photo', {photo: 5}))
  assert.equal(operator.openPhoto(), 4)
})

test('Scope switches its list by a click on the sidebar', async () => {
  const {operator, driver} = setup()
  const location = driver.machine.cells.valueList.location
  for (const [view, index] of [['state', 0], ['outputs', 2], ['operations', 1]] as const) {
    await operator.run(command('scope_show', {view}))
    assert.deepEqual(location.map(cell => driver.machine.source[cell]), [0, 1, 2].map(i => Number(i === index)), view)
  }
})

test('page commands change settings, the note and links, never the program', async () => {
  const {operator, fake} = setup()
  await operator.run(command('set_theme', {theme: 'dark'}))
  await operator.run(command('set_accent', {color: 'teal'}))
  await operator.run(command('set_wallpaper', {scene: 'lagoon'}))
  await operator.run(command('set_motion', {motion: 'off'}))
  await operator.run(command('set_arcs', {visibility: 'hidden'}))
  assert.deepEqual(fake.settings(), {appearance: 'dark', accent: 'teal', scene: 'lagoon', motion: false, arcs: false})
  await operator.run(command('set_theme', {theme: 'system'}))
  assert.equal(fake.settings().appearance, 'auto')
  await operator.run(command('write_note', {text: 'buy milk', mode: 'append'}))
  assert.equal(fake.note(), 'first line\nbuy milk')
  assert.equal(await operator.run(command('read_note')), 'first line\nbuy milk')
  await operator.run(command('clear_note'))
  assert.equal(fake.note(), '')
  assert.match(await operator.run(command('get_stats')), /source cells/u)
})

test('Prism\'s own apps open, zoom, move, minimize and close through the shell', async () => {
  const {operator, fake} = setup()
  assert.equal(await operator.run(command('open_app', {app: 'calculator'})), 'Calculator is in front.')
  assert.equal(fake.panel('calculator').state, 'open')
  assert.equal(await operator.run(command('maximize_app', {app: 'calc'})), 'Calculator keeps its size.')
  await operator.run(command('maximize_app', {app: 'clock'}))
  assert.equal(fake.panel('clock').zoomed, true)
  await operator.run(command('restore_app', {app: 'clock'}))
  assert.equal(fake.panel('clock').zoomed, false)
  await operator.run(command('move_app', {app: 'terminal', position: 'top_right'}))
  assert.deepEqual(fake.panel('terminal'), {state: 'open', zoomed: false, position: 'top_right'})
  await operator.run(command('minimize_app', {app: 'terminal'}))
  assert.equal(fake.panel('terminal').state, 'minimized')
  assert.equal(await operator.run(command('close_app', {app: 'settings'})), 'Settings is already closed.')
  await operator.run(command('close_app', {app: 'calculator'}))
  assert.equal(fake.panel('calculator').state, 'closed')
})

test('acting on a program window puts it in front of Prism\'s panels', async () => {
  const {operator, fake} = setup()
  const before = fake.behind()
  await operator.run(command('open_app', {app: 'chroma'}))
  assert.ok(fake.behind() > before)
})

test('show desktop minimizes Prism\'s open panels too', async () => {
  const {operator, fake} = setup()
  await operator.run(command('open_app', {app: 'clock'}))
  await operator.run(command('show_desktop'))
  assert.equal(fake.panel('clock').state, 'minimized')
  for (const index of [0, 1, 2]) assert.equal(operator.windowState(index).minimized, true)
})

test('arithmetic, the stopwatch and world times answer in words', async () => {
  const {operator} = setup()
  assert.equal(await operator.run(command('calculate', {expression: 'what is 17 times 23'})), '17 × 23 = 391')
  assert.equal(await operator.run(command('calculate', {expression: '(2 + 3) * 4'})), '( 2 + 3 ) × 4 = 20'.replace('( ', '(').replace(' )', ')'))
  assert.equal(await operator.run(command('stopwatch', {action: 'lap'})), 'stopwatch lap')
  assert.match(await operator.run(command('world_time', {city: 'Tokyo'})), /^It's \d{1,2}:\d{2} [AP]M in Tokyo, \w+day\.$/u)
  assert.match(await operator.run(command('world_time', {city: 'here'})), /^It's .+ here, /u)
})

test('web commands open Browser at the page, or say the site refuses to be shown', async () => {
  const {operator, fake} = setup()
  assert.equal(await operator.run(command('open_website', {address: 'en.wikipedia.org/wiki/Prism'})), 'Opened en.wikipedia.org in Browser.')
  assert.equal(fake.panel('browser').state, 'open')
  assert.match(await operator.run(command('open_website', {address: 'github.com/AppleLamps'})), /^GitHub doesn't let other sites show its pages/u)
  assert.equal(await operator.run(command('search_web', {query: 'glass prisms'})), 'Searching Bing for "glass prisms".')
  assert.deepEqual(fake.browsed, ['https://en.wikipedia.org/wiki/Prism', 'https://github.com/AppleLamps', 'https://www.bing.com/search?q=glass%20prisms'])
  assert.match(await operator.run(command('explain', {topic: 'browser'})), /sandboxed frame/u)
})

test('the timer and Browser\'s buttons go through the shell, and a bare "back" acts on the front app', async () => {
  const {operator, fake} = setup()
  assert.equal(await operator.run(command('start_timer', {duration: 'an hour and a half'})), 'timer start')
  await operator.run(command('timer', {action: 'stop'}))
  assert.deepEqual(fake.timers, ['start 5400', 'cancel'])
  await operator.run(command('browser_navigate', {action: 'refresh'}))
  fake.setFront('browser')
  assert.equal(await operator.run(command('previous_photo', {bare: true})), 'browser back')
  assert.equal(await operator.run(command('next_photo', {bare: true})), 'browser forward')
  assert.deepEqual(fake.navigated, ['reload', 'back', 'forward'])
  // Naming the photos still steps Chroma, whatever is in front.
  assert.match(await operator.run(command('next_photo')), /^Showing /u)
  fake.setFront(null)
  assert.match(await operator.run(command('previous_photo', {bare: true})), /^Showing /u)
})

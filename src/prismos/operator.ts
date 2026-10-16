import {isFileCommand, runFileCommand} from './file-commands.ts'
import type {Cabinet} from './cabinet.ts'
import type {CabinetGallery} from './cabinet-gallery.ts'
// The operator: runs a validated command against Prism OS. Window, photo and Scope
// commands become the same timestamped pointer and key events a person's hand would
// produce, aimed at points the program itself computes, so every rule of the handwired
// program applies to the operator exactly as to a person: a press tests the same hit
// rectangles, a drag stores through the same fit into the workspace, a window can't be
// pushed off-screen. Prism's own apps run in the shell beside the program (shell.ts), so
// their commands go through the shell's own functions. Settings and the note are the
// page's own state, which the program never sees.
import type {ValueListKey} from '../handwiredos/value-list.ts'
import {monitorLayout} from '../handwiredos/value-list.ts'
import {itemCount as photoCount, photoField, photoNames, thumbnailField} from '../handwiredos/photo-gallery.ts'
import {measureProgram} from '../handwiredos/monitor-footer.ts'
import {
  createWindowManagerMachine,
  photoFocusSourceField,
  sourceField,
  windowOutputField,
  windowSourceField,
  windowStateField,
  dockOutputField,
} from '../handwiredos/window-manager.ts'
import {type Command, type PanelAppName, type ProgramApp, appTitle, appWindowIndex, cities, isProgramApp, panelApps, programApps, scopeViews} from './commands.ts'
import {evaluateExpression, formatResult, prettyExpression} from './expression.ts'
import type {BrowserAction, TimerRequest} from './apps.ts'
import {type Settings, accents, scenes} from './settings.ts'
import {type Framing, pageName, searchEngine} from './web-address.ts'

export type Machine = ReturnType<typeof createWindowManagerMachine>
export type Point = {x: number, y: number}
export type Rectangle = {left: number, top: number, width: number, height: number}

// How the operator reaches the running machine. The page drives the machine from its
// requestAnimationFrame loop, and the tests step it with a clock of their own.
export type MachineDriver = {
  machine: Machine
  // The viewport the machine lays out, in px.
  viewport(): {width: number, height: number}
  // The timestamp for an event queued now, on the clock of the machine's frames.
  now(): number
  // Runs one frame, which applies the queued events, and resolves after it.
  frame(): Promise<void>
}

// The page's own state that commands change, outside the program.
export type PanelState = 'closed' | 'open' | 'minimized'

// What the shell offers for Prism's own apps, see startShell.
export type PanelControls = {
  state(id: PanelAppName): PanelState
  zoomed(id: PanelAppName): boolean
  resizable(id: PanelAppName): boolean
  open(id: PanelAppName): void
  close(id: PanelAppName): void
  minimize(id: PanelAppName): void
  zoom(id: PanelAppName): void
  move(id: PanelAppName, position: Extract<Command, {name: 'move_app'}>['position']): void
  // Puts the program's windows in front of the panels, as a press on one of them does.
  sendBehind(): void
  // The stopwatch in Clock, which the shell opens first. Resolves to the reply.
  stopwatch(action: Extract<Command, {name: 'stopwatch'}>['action']): string
  // Browser, which the shell opens first, at a URL: whether the page shows or its site
  // refuses to be framed.
  browse(url: string): Framing
  // Browser's back, forward, reload and Favorites, which the shell opens first.
  browserNavigate(action: BrowserAction): string
  // Clock's timer. Resolves to the reply.
  timer(request: TimerRequest): string
  // The app of the panel in front of everything, or null when a program window is.
  front(): PanelAppName | null
}

export type PageEffects = {
  cabinet?: Cabinet | undefined
  gallery?: CabinetGallery | undefined
  settings: {get(): Settings, update(change: Partial<Settings>): void}
  panels: PanelControls
  note: {read(): string, write(text: string): void}
  slideshow: {start(): void, stop(): void, running(): boolean}
  // Where the windows opened, for the viewport as it is now, see arrangement.ts.
  homeRectangles(): readonly Rectangle[]
}

const restFrameLimit = 600
const dragSteps = 6

export type WindowState = {
  open: boolean
  minimized: boolean
  maximized: boolean
  focused: boolean
  rectangle: Rectangle
}

export function createOperator(driver: MachineDriver, page: PageEffects) {
  const {machine} = driver
  const values = () => machine.values
  const source = (field: number) => machine.source[field]!
  const titleHeight = () => source(sourceField.titleHeight)
  const buttonSize = () => source(sourceField.buttonSize)
  const buttonGap = () => source(sourceField.buttonGap)
  const resizeGrip = () => source(sourceField.resizeGrip)

  async function rest() {
    for (let frames = 0; frames < restFrameLimit; frames++) {
      await driver.frame()
      if (machine.clock.animatedUntilMs === null && values()[machine.output.animationActive] === 0) return
    }
  }

  function windowState(windowIndex: number): WindowState {
    const read = (field: number) => values()[machine.output.windows[windowIndex * windowOutputField.size + field]!]!
    const bit = (field: number) => source(windowSourceField(windowIndex, field)) === 1
    return {
      open: bit(windowStateField.open),
      minimized: bit(windowStateField.minimized),
      maximized: bit(windowStateField.maximized),
      focused: read(windowOutputField.focused) === 1,
      rectangle: {
        left: read(windowOutputField.translateX),
        top: read(windowOutputField.translateY),
        width: read(windowOutputField.width),
        height: read(windowOutputField.height),
      },
    }
  }

  // The part of the viewport between the system bar and the dock, where windows live.
  function workspace(): Rectangle {
    const {width, height} = driver.viewport()
    const dockTop = height - Math.min(source(sourceField.dockHeight), height)
    const top = Math.min(source(sourceField.systemBarHeight), dockTop)
    return {left: 0, top, width, height: dockTop - top}
  }

  // The center of a title bar button, where window-manager.ts places it: close at the
  // right edge, then maximize and minimize to its left, each buttonGap apart.
  function controlPoint(windowIndex: number, control: 'close' | 'maximize' | 'minimize'): Point {
    const {left, top, width} = windowState(windowIndex).rectangle
    const closeX = left + width - buttonGap() - buttonSize() / 2
    const step = buttonGap() + buttonSize()
    const x = control === 'close' ? closeX : control === 'maximize' ? closeX - step : closeX - 2 * step
    return {x, y: top + titleHeight() / 2}
  }

  // A point on the draggable part of the title bar, left of the buttons.
  function titleBarPoint(windowIndex: number): Point {
    const {left, top} = windowState(windowIndex).rectangle
    return {x: left + Math.min(24, Math.max(4, (controlPoint(windowIndex, 'minimize').x - left) / 2)), y: top + titleHeight() / 2}
  }

  function gripPoint(windowIndex: number): Point {
    const {left, top, width, height} = windowState(windowIndex).rectangle
    return {x: left + width - resizeGrip() / 3, y: top + height - resizeGrip() / 3}
  }

  function dockPoint(windowIndex: number): Point {
    const read = (field: number) => values()[machine.output.dockItems[windowIndex * dockOutputField.size + field]!]!
    return {
      x: read(dockOutputField.left) + read(dockOutputField.width) / 2,
      y: read(dockOutputField.top) + read(dockOutputField.height) / 2,
    }
  }

  // Chroma's open photo, or -1 while the grid shows.
  function openPhoto() {
    for (let item = 0; item < photoCount; item++) {
      if (source(photoFocusSourceField(item)) === 1) return item
    }
    return -1
  }

  // Where to click to open a photo: its cell in the grid, or its thumbnail in the strip
  // while another photo is open. Coordinates inside Photos' content box, which sits
  // inside a 1 px border below the title bar.
  function photoPoint(item: number): Point {
    const chroma = windowState(appWindowIndex.chroma).rectangle
    const originX = chroma.left + 1
    const originY = chroma.top + titleHeight() + 1
    const photos = machine.output.photos
    const showingGrid = openPhoto() === -1
    const wires = showingGrid ? photos.photos : photos.thumbnails
    const size = showingGrid ? photoField.size : thumbnailField.size
    const read = (field: number) => values()[wires[item * size + field]!]!
    const left = read(showingGrid ? photoField.left : thumbnailField.left)
    const top = read(showingGrid ? photoField.top : thumbnailField.top)
    const width = read(showingGrid ? photoField.width : thumbnailField.width)
    const height = read(showingGrid ? photoField.height : thumbnailField.height)
    return {x: originX + left + width / 2, y: originY + top + height / 2}
  }

  // The center of a sidebar location in Scope, see monitorLayout.
  function scopeLocationPoint(location: number): Point {
    const scope = windowState(appWindowIndex.scope).rectangle
    return {
      x: scope.left + 1 + monitorLayout.sidebarWidth / 2,
      y: scope.top + titleHeight() + 1 + monitorLayout.locationTop + (location + 0.5) * monitorLayout.locationHeight,
    }
  }

  async function click(point: Point) {
    const time = driver.now()
    machine.pointerDown(point.x, point.y, time)
    machine.pointerUp(point.x, point.y, time)
    await rest()
  }

  async function drag(from: Point, to: Point) {
    machine.pointerDown(from.x, from.y, driver.now())
    for (let step = 1; step <= dragSteps; step++) {
      const t = step / dragSteps
      machine.pointerMove(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, driver.now())
      await driver.frame()
    }
    machine.pointerUp(to.x, to.y, driver.now())
    await rest()
  }

  // Brings a window to the front, opening a closed one and restoring a minimized one,
  // with a click on its dock item, as a person would.
  async function bringToFront(app: ProgramApp) {
    page.panels.sendBehind()
    const index = appWindowIndex[app]
    const state = windowState(index)
    if (state.open && !state.minimized && state.focused) return
    await click(dockPoint(index))
  }

  async function unmaximize(app: ProgramApp) {
    const index = appWindowIndex[app]
    if (windowState(index).maximized) await click(controlPoint(index, 'maximize'))
  }

  // Moves and resizes a window to a rectangle inside the workspace: a drag of the title
  // bar, then a drag of the corner grip, then the title bar again when the size the
  // program allowed differs from the size asked for.
  async function place(app: ProgramApp, target: Rectangle) {
    const index = appWindowIndex[app]
    await bringToFront(app)
    await unmaximize(app)
    const minimumWidth = source(sourceField.minWidth)
    const minimumHeight = source(sourceField.minHeight)
    const area = workspace()
    const width = Math.max(Math.min(target.width, area.width), Math.min(minimumWidth, area.width))
    const height = Math.max(Math.min(target.height, area.height), Math.min(minimumHeight, area.height))
    const left = Math.min(Math.max(target.left, area.left), area.left + area.width - width)
    const top = Math.min(Math.max(target.top, area.top), area.top + area.height - height)
    for (let pass = 0; pass < 2; pass++) {
      let current = windowState(index).rectangle
      if (current.left !== left || current.top !== top) {
        const from = titleBarPoint(index)
        await drag(from, {x: from.x + left - current.left, y: from.y + top - current.top})
      }
      current = windowState(index).rectangle
      if (current.width !== width || current.height !== height) {
        const from = gripPoint(index)
        await drag(from, {x: from.x + width - current.width, y: from.y + height - current.height})
      }
      current = windowState(index).rectangle
      if (current.left === left && current.top === top) return
    }
  }

  function positionRectangle(app: ProgramApp, position: Extract<Command, {name: 'move_app'}>['position']): Rectangle {
    const {width, height} = windowState(appWindowIndex[app]).rectangle
    const area = workspace()
    const margin = source(sourceField.margin)
    const leftEdge = area.left + margin
    const rightEdge = area.left + area.width - margin - width
    const topEdge = area.top + margin
    const bottomEdge = area.top + area.height - margin - height
    const centerX = area.left + (area.width - width) / 2
    const centerY = area.top + (area.height - height) / 2
    const at = (left: number, top: number) => ({left: Math.round(left), top: Math.round(top), width, height})
    switch (position) {
      case 'left': return at(leftEdge, centerY)
      case 'right': return at(rightEdge, centerY)
      case 'center': return at(centerX, centerY)
      case 'top_left': return at(leftEdge, topEdge)
      case 'top_right': return at(rightEdge, topEdge)
      case 'bottom_left': return at(leftEdge, bottomEdge)
      case 'bottom_right': return at(rightEdge, bottomEdge)
    }
  }

  function sizeRectangle(app: ProgramApp, size: Extract<Command, {name: 'resize_app'}>['size']): Rectangle {
    const current = windowState(appWindowIndex[app]).rectangle
    const area = workspace()
    const scale = {small: 0.4, medium: 0.6, large: 0.85}
    const width = Math.round(size === 'bigger' ? current.width * 1.25 : size === 'smaller' ? current.width * 0.8 : area.width * scale[size])
    const height = Math.round(size === 'bigger' ? current.height * 1.25 : size === 'smaller' ? current.height * 0.8 : area.height * scale[size])
    // Grows and shrinks around the window's center.
    return {
      left: Math.round(current.left + (current.width - width) / 2),
      top: Math.round(current.top + (current.height - height) / 2),
      width,
      height,
    }
  }

  async function photoKey(key: 'next' | 'previous' | 'close') {
    await bringToFront('chroma')
    const time = driver.now()
    if (key === 'next') machine.photoNext(time)
    else if (key === 'previous') machine.photoPrevious(time)
    else machine.photoClose(time)
    await rest()
  }

  async function listKey(key: ValueListKey) {
    await bringToFront('scope')
    machine.valueListKey(key, driver.now())
    await rest()
  }

  function stats() {
    const program = machine.tensorProgram
    const {weights, bytes} = measureProgram(program)
    return {
      sourceCells: program.sourceSize,
      operations: program.valueCount - program.sourceSize,
      layers: program.layers.length,
      weights,
      // Scope's footer counts 1 KB as 1,000 bytes, and so does this.
      kilobytes: Math.round(bytes / 1000),
    }
  }

  const format = (value: number) => value.toLocaleString('en-US')

  // Runs one command and resolves to the reply the command center shows.
  async function run(command: Command): Promise<string> {
    if (isFileCommand(command)) {
      if (!page.cabinet) return 'Cabinet is unavailable.'
      return runFileCommand(page.cabinet, command)
    }
    switch (command.name) {
      case 'open_app': {
        if (isProgramApp(command.app)) await bringToFront(command.app)
        else page.panels.open(command.app)
        return `${appTitle[command.app]} is in front.`
      }
      case 'minimize_app': {
        const title = appTitle[command.app]
        if (!isProgramApp(command.app)) {
          const state = page.panels.state(command.app)
          if (state === 'closed') return `${title} isn't open.`
          if (state === 'minimized') return `${title} is already minimized.`
          page.panels.minimize(command.app)
          return `Minimized ${title}.`
        }
        const state = windowState(appWindowIndex[command.app])
        if (!state.open) return `${title} is closed.`
        if (state.minimized) return `${title} is already in the dock.`
        await bringToFront(command.app)
        await click(controlPoint(appWindowIndex[command.app], 'minimize'))
        return `Minimized ${title}.`
      }
      case 'maximize_app': {
        const title = appTitle[command.app]
        if (!isProgramApp(command.app)) {
          if (!page.panels.resizable(command.app)) return `${title} keeps its size.`
          page.panels.open(command.app)
          if (!page.panels.zoomed(command.app)) page.panels.zoom(command.app)
          return `${title} fills the screen.`
        }
        await bringToFront(command.app)
        if (!windowState(appWindowIndex[command.app]).maximized) await click(controlPoint(appWindowIndex[command.app], 'maximize'))
        return `${title} fills the screen.`
      }
      case 'restore_app': {
        const title = appTitle[command.app]
        if (!isProgramApp(command.app)) {
          page.panels.open(command.app)
          if (page.panels.zoomed(command.app)) page.panels.zoom(command.app)
          return `${title} is back to its normal size.`
        }
        await bringToFront(command.app)
        await unmaximize(command.app)
        return `${title} is back to its normal size.`
      }
      case 'close_app': {
        if (command.app === 'inkwell' && page.cabinet && !await page.cabinet.resolveDraft()) return 'Kept Inkwell open with your draft.'
        const title = appTitle[command.app]
        if (!isProgramApp(command.app)) {
          if (page.panels.state(command.app) === 'closed') return `${title} is already closed.`
          page.panels.close(command.app)
          return `Closed ${title}.`
        }
        const index = appWindowIndex[command.app]
        if (!windowState(index).open) return `${title} is already closed.`
        await bringToFront(command.app)
        await click(controlPoint(index, 'close'))
        return `Closed ${title}. Its dock icon opens it again.`
      }
      case 'move_app': {
        const where = command.position.replace('_', ' ')
        if (!isProgramApp(command.app)) {
          page.panels.open(command.app)
          page.panels.move(command.app, command.position)
          return `Moved ${appTitle[command.app]} to the ${where}.`
        }
        await bringToFront(command.app)
        await unmaximize(command.app)
        await place(command.app, positionRectangle(command.app, command.position))
        return `Moved ${appTitle[command.app]} to the ${where}.`
      }
      case 'resize_app': {
        await bringToFront(command.app)
        await unmaximize(command.app)
        await place(command.app, sizeRectangle(command.app, command.size))
        const {width, height} = windowState(appWindowIndex[command.app]).rectangle
        return `${appTitle[command.app]} is ${Math.round(width)} × ${Math.round(height)} px.`
      }
      case 'side_by_side': {
        const area = workspace()
        const half = Math.floor(area.width / 2)
        await place(command.left, {left: area.left, top: area.top, width: half, height: area.height})
        await place(command.right, {left: area.left + half, top: area.top, width: area.width - half, height: area.height})
        return `${appTitle[command.left]} on the left, ${appTitle[command.right]} on the right.`
      }
      case 'show_desktop': {
        let count = 0
        for (const app of programApps) {
          const state = windowState(appWindowIndex[app])
          if (!state.open || state.minimized) continue
          await bringToFront(app)
          await click(controlPoint(appWindowIndex[app], 'minimize'))
          count++
        }
        for (const app of panelApps) {
          if (page.panels.state(app) !== 'open') continue
          page.panels.minimize(app)
          count++
        }
        return count === 0 ? 'The desktop is already clear.' : 'Every window is in the dock.'
      }
      case 'reset_layout': {
        const rectangles = page.homeRectangles()
        for (const app of programApps) {
          const index = appWindowIndex[app]
          if (!windowState(index).open) continue
          await place(app, rectangles[index]!)
        }
        return 'Every window is back where it opened.'
      }
      case 'open_photo': {
        page.slideshow.stop()
        if (command.bundled === true && page.gallery?.active()) await page.gallery.bundled()
        if (page.gallery?.active()) { await bringToFront('chroma'); return page.gallery.show(command.photo) }
        if (command.photo >= photoCount) return 'The bundled gallery has 12 photos. Open a Cabinet image folder to browse more.'
        await bringToFront('chroma')
        if (openPhoto() !== command.photo) await click(photoPoint(command.photo))
        return openPhoto() === command.photo ? `Opened ${photoNames[command.photo]}.` : `I couldn't reach ${photoNames[command.photo]}; Chroma may be too small to show it.`
      }
      case 'next_photo':
      case 'previous_photo': {
        // "next" and "back" alone act on the front app, as on any desktop.
        if (command.bare === true && page.panels.front() === 'browser') return page.panels.browserNavigate(command.name === 'next_photo' ? 'forward' : 'back')
        if (page.gallery?.active()) { await bringToFront('chroma'); return page.gallery.step(command.name === 'next_photo' ? 1 : -1) }
        if (openPhoto() === -1) {
          await bringToFront('chroma')
          await click(photoPoint(command.name === 'next_photo' ? 0 : photoCount - 1))
        } else {
          await photoKey(command.name === 'next_photo' ? 'next' : 'previous')
        }
        const open = openPhoto()
        return open === -1 ? 'Chroma has no photo open.' : `Showing ${photoNames[open]}.`
      }
      case 'close_photo': {
        page.slideshow.stop()
        if (page.gallery?.active()) return page.gallery.close()
        if (openPhoto() === -1) return 'No photo is open.'
        await photoKey('close')
        return 'Back to the grid.'
      }
      case 'slideshow': {
        if (command.action === 'stop') {
          page.slideshow.stop()
          return 'Slideshow stopped.'
        }
        await bringToFront('chroma')
        if (page.gallery?.active()) await page.gallery.step(1)
        else if (openPhoto() === -1) await click(photoPoint(0))
        page.slideshow.start()
        return 'Slideshow started. Say "stop the slideshow" or press Escape to end it.'
      }
      case 'scope_show': {
        await bringToFront('scope')
        await unmaximize('scope')
        await click(scopeLocationPoint(scopeViews.indexOf(command.view)))
        return `Scope shows the ${command.view === 'state' ? 'source cells' : command.view}.`
      }
      case 'scope_list': {
        const keys = {up: 'up', down: 'down', page_up: 'pageUp', page_down: 'pageDown', top: 'home', bottom: 'end'} as const
        await listKey(keys[command.action])
        return 'Done.'
      }
      case 'write_note': {
        await bringToFront('inkwell')
        const current = page.note.read()
        const text = command.mode === 'replace' || current.trim() === '' ? command.text : `${current.replace(/\s+$/u, '')}\n${command.text}`
        page.note.write(text)
        await page.cabinet?.flush()
        return command.mode === 'replace' ? 'Replaced the note.' : 'Added to the note.'
      }
      case 'clear_note': {
        page.note.write('')
        await page.cabinet?.flush()
        return 'The note is empty.'
      }
      case 'read_note': {
        const text = page.note.read().trim()
        return text === '' ? 'The note is empty.' : text
      }
      case 'set_theme':
        page.settings.update({appearance: command.theme})
        return command.theme === 'auto' ? 'The appearance follows your device.' : `${command.theme === 'dark' ? 'Dark' : 'Light'} appearance is on.`
      case 'set_accent':
        page.settings.update({accent: command.color})
        return `The accent is ${accents[command.color].label.toLowerCase()}.`
      case 'set_wallpaper':
        page.settings.update({scene: command.scene})
        return `The wallpaper is ${scenes[command.scene].label}.`
      case 'set_motion':
        page.settings.update({motion: command.motion === 'on'})
        return command.motion === 'on' ? 'The wallpaper drifts again.' : 'The wallpaper holds still.'
      case 'set_arcs':
        page.settings.update({arcs: command.visibility === 'shown'})
        return command.visibility === 'hidden' ? 'The weight arcs are hidden.' : 'The weight arcs are back.'
      case 'calculate': {
        const result = evaluateExpression(command.expression)
        return result.ok ? `${prettyExpression(result.expression)} = ${formatResult(result.value)}` : result.reason
      }
      case 'stopwatch':
        return page.panels.stopwatch(command.action)
      case 'start_timer':
        return page.panels.timer({kind: 'start', seconds: command.seconds})
      case 'timer':
        return page.panels.timer({kind: command.action})
      case 'browser_navigate':
        return page.panels.browserNavigate(command.action)
      case 'world_time': {
        const zone = cities[command.city] ?? ''
        const now = new Date()
        const time = new Intl.DateTimeFormat('en-US', {hour: 'numeric', minute: '2-digit', ...(zone === '' ? {} : {timeZone: zone})}).format(now)
        const day = new Intl.DateTimeFormat('en-US', {weekday: 'long', ...(zone === '' ? {} : {timeZone: zone})}).format(now)
        const place = command.city === 'here' ? 'here' : `in ${command.city.replace(/\b\w/gu, letter => letter.toUpperCase())}`
        return `It's ${time} ${place}, ${day}.`
      }
      case 'open_website': {
        const framing = page.panels.browse(command.url)
        const name = pageName(command.url)
        if (framing.kind === 'frame') return `Opened ${name} in Browser.`
        if (framing.kind === 'self') return 'That\'s Prism OS itself, which Browser doesn\'t show inside itself.'
        return `${framing.site} doesn't let other sites show its pages, so ${name} can't open inside Prism OS. Browser's Open in New Tab button can open it.`
      }
      case 'search_web':
        page.panels.browse(searchEngine.url(command.query))
        return `Searching ${searchEngine.name} for "${command.query}".`
      case 'get_stats': {
        const s = stats()
        return `The program behind Prism OS has ${format(s.sourceCells)} source cells, ${format(s.operations)} live operations in ${format(s.layers)} layers, and ${format(s.weights)} stored weights (${format(s.kilobytes)} KB). None of them were trained: every weight was written by hand.`
      }
      case 'explain':
        return explanations[command.topic]
    }
  }

  // One command at a time: a slideshow step that arrived during a drag waits for it.
  let chain: Promise<unknown> = Promise.resolve()
  function exclusive<Result>(task: () => Promise<Result>): Promise<Result> {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }

  return {
    // Cabinet calls this both from its UI and from inside the command queue.
    // Keep this effect unqueued so opening a document cannot wait on its own command.
    focusProgram: bringToFront,
    run: (command: Command) => exclusive(() => run(command)),
    // The slideshow's step: the next photo, through the same queue as the commands.
    nextPhoto: () => exclusive(async () => { if (page.gallery?.active()) await page.gallery.step(1); else await photoKey('next') }),
    windowState,
    openPhoto,
    stats,
  }
}

export type Operator = ReturnType<typeof createOperator>

export const explanations: Record<Extract<Command, {name: 'explain'}>['topic'], string> = {
  prism_os: 'Prism OS is a small desktop in your browser. Scope, Inkwell and Chroma are windows of a handwired numeric program: a fixed neural network whose weights were written by hand instead of trained, which computes every move, click and spring. Cabinet, Browser, Calculator, Clock, Terminal and Settings run beside it in plain JavaScript.',
  scope: 'Scope is the inspector. It lists the program that runs Prism OS: its source cells, its live operations and its outputs, each with the value from the latest frame. Its footer counts the layers and weights and charts how long each frame takes.',
  inkwell: 'Inkwell is the note: a plain text field the browser edits. The program decides where the window is and whether it has focus, and the text itself stays out of the program. Your note is saved in this browser.',
  chroma: `Chroma is the photo gallery: ${photoCount} photos in a grid. Click one, or ask me to open one by name or number, and it zooms open on a spring. Arrows step through them and Escape goes back to the grid.`,
  browser: `Browser shows web pages right on the desktop, in a sandboxed frame that can never navigate Prism OS away. Type an address or words to search ${searchEngine.name}, or ask me, e.g. "go to wikipedia.org". Some sites, like Google, YouTube and GitHub, refuse to be shown inside another site; Browser offers to open those in a new tab.`,
  calculator: 'Calculator is a pocket calculator with keyboard input and repeated equals. You can also ask me for arithmetic directly, e.g. "what is 17 times 23".',
  clock: 'Clock shows world clocks with analog faces, a stopwatch with laps, and a timer that chimes when it ends. Ask me "what time is it in Tokyo", "start the stopwatch" or "set a timer for 5 minutes".',
  terminal: 'Terminal takes typed commands: open and close apps, set the theme, accent and wallpaper, print the program\'s stats, and a few classics like neofetch. Type help in it for the list.',
  handwired: 'Handwired turns ordinary code into a neural network: every if, comparison and spring becomes additions, multiplications and ReLU gates over floats, collected into matrix multiplications. Nothing is trained, the result is exact, and it stays differentiable.',
  command_center: 'Spotlight runs what you type. Common commands work at once, and a small language model, FunctionGemma, can run in your browser for everything else. Every command clicks and drags through the same program you use, so the program\'s rules apply to me too.',
}

// Keeps the slideshow's interval: every 3 s it shows the next photo, until a command
// or the person stops it.
export const slideshowIntervalMs = 3000

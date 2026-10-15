// The operator: runs a validated command against Prism OS. Window, photo and Scope
// commands become the same timestamped pointer and key events a person's hand would
// produce, aimed at points the program itself computes, so every rule of the handwired
// program applies to the operator exactly as to a person: a press tests the same hit
// rectangles, a drag stores through the same fit into the workspace, a window can't be
// pushed off-screen. Settings, the note and links are the page's own state, which the
// program never sees.
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
import {type App, type Command, apps, appTitle, appWindowIndex, scopeViews} from './commands.ts'
import type {Settings} from './settings.ts'

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
export type PageEffects = {
  settings: {get(): Settings, set(patch: Partial<Settings>): void}
  note: {read(): string, write(text: string): void}
  navigate(link: 'demos' | 'source'): void
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
  async function bringToFront(app: App) {
    const index = appWindowIndex[app]
    const state = windowState(index)
    if (state.open && !state.minimized && state.focused) return
    await click(dockPoint(index))
  }

  async function unmaximize(app: App) {
    const index = appWindowIndex[app]
    if (windowState(index).maximized) await click(controlPoint(index, 'maximize'))
  }

  // Moves and resizes a window to a rectangle inside the workspace: a drag of the title
  // bar, then a drag of the corner grip, then the title bar again when the size the
  // program allowed differs from the size asked for.
  async function place(app: App, target: Rectangle) {
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

  function positionRectangle(app: App, position: Extract<Command, {name: 'move_app'}>['position']): Rectangle {
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

  function sizeRectangle(app: App, size: Extract<Command, {name: 'resize_app'}>['size']): Rectangle {
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
    switch (command.name) {
      case 'open_app': {
        await bringToFront(command.app)
        return `${appTitle[command.app]} is in front.`
      }
      case 'minimize_app': {
        const state = windowState(appWindowIndex[command.app])
        if (!state.open) return `${appTitle[command.app]} is closed.`
        if (state.minimized) return `${appTitle[command.app]} is already in the dock.`
        await bringToFront(command.app)
        await click(controlPoint(appWindowIndex[command.app], 'minimize'))
        return `Minimized ${appTitle[command.app]}.`
      }
      case 'maximize_app': {
        await bringToFront(command.app)
        if (!windowState(appWindowIndex[command.app]).maximized) await click(controlPoint(appWindowIndex[command.app], 'maximize'))
        return `${appTitle[command.app]} fills the screen.`
      }
      case 'restore_app': {
        await bringToFront(command.app)
        await unmaximize(command.app)
        return `${appTitle[command.app]} is back to its normal size.`
      }
      case 'close_app': {
        const index = appWindowIndex[command.app]
        if (!windowState(index).open) return `${appTitle[command.app]} is already closed.`
        await bringToFront(command.app)
        await click(controlPoint(index, 'close'))
        return `Closed ${appTitle[command.app]}. Its dock icon opens it again.`
      }
      case 'move_app': {
        await bringToFront(command.app)
        await unmaximize(command.app)
        await place(command.app, positionRectangle(command.app, command.position))
        return `Moved ${appTitle[command.app]} ${command.position.replace('_', ' ')}.`
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
        for (const app of apps) {
          const state = windowState(appWindowIndex[app])
          if (!state.open || state.minimized) continue
          await bringToFront(app)
          await click(controlPoint(appWindowIndex[app], 'minimize'))
          count++
        }
        return count === 0 ? 'The desktop is already clear.' : 'Every window is in the dock.'
      }
      case 'reset_layout': {
        const rectangles = page.homeRectangles()
        for (const app of apps) {
          const index = appWindowIndex[app]
          if (!windowState(index).open) continue
          await place(app, rectangles[index]!)
        }
        return 'Every window is back where it opened.'
      }
      case 'open_photo': {
        page.slideshow.stop()
        await bringToFront('chroma')
        if (openPhoto() !== command.photo) await click(photoPoint(command.photo))
        return openPhoto() === command.photo ? `Opened ${photoNames[command.photo]}.` : `I couldn't reach ${photoNames[command.photo]}; Chroma may be too small to show it.`
      }
      case 'next_photo':
      case 'previous_photo': {
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
        if (openPhoto() === -1) await click(photoPoint(0))
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
        return command.mode === 'replace' ? 'Replaced the note.' : 'Added to the note.'
      }
      case 'clear_note': {
        page.note.write('')
        return 'The note is empty.'
      }
      case 'read_note': {
        const text = page.note.read().trim()
        return text === '' ? 'The note is empty.' : text
      }
      case 'set_theme':
        page.settings.set({theme: command.theme})
        return command.theme === 'system' ? 'The theme follows your device.' : `${command.theme === 'dark' ? 'Dark' : 'Light'} mode is on.`
      case 'set_accent':
        page.settings.set({accent: command.color})
        return `The accent is ${command.color}.`
      case 'set_wallpaper':
        page.settings.set({wallpaper: command.motion})
        return command.motion === 'still' ? 'The dunes hold still.' : 'The dunes drift again.'
      case 'set_transparency':
        page.settings.set({transparency: command.level})
        return command.level === 'reduced' ? 'The glass is solid now.' : 'The glass is clear again.'
      case 'set_arcs':
        page.settings.set({arcs: command.visibility})
        return command.visibility === 'hidden' ? 'The weight arcs are hidden.' : 'The weight arcs are back.'
      case 'open_link':
        page.navigate(command.link)
        return 'Opening…'
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
    run: (command: Command) => exclusive(() => run(command)),
    // The slideshow's step: the next photo, through the same queue as the commands.
    nextPhoto: () => exclusive(() => photoKey('next')),
    windowState,
    openPhoto,
    stats,
  }
}

export type Operator = ReturnType<typeof createOperator>

export const explanations: Record<Extract<Command, {name: 'explain'}>['topic'], string> = {
  prism_os: 'Prism OS is a small desktop in your browser with three apps: Scope, Inkwell and Chroma. Every window move, click and spring animation is computed by a handwired numeric program: a fixed neural network whose weights were written by hand instead of trained.',
  scope: 'Scope is the inspector. It lists the program that runs Prism OS: its source cells, its live operations and its outputs, each with the value from the latest frame. Its footer counts the layers and weights and charts how long each frame takes.',
  inkwell: 'Inkwell is the note: a plain text field the browser edits. The program decides where the window is and whether it has focus, and the text itself stays out of the program. Your note is saved in this browser.',
  chroma: `Chroma is the photo gallery: ${photoCount} photos in a grid. Click one, or ask me to open one by name or number, and it zooms open on a spring. Arrows step through them and Escape goes back to the grid.`,
  handwired: 'Handwired turns ordinary code into a neural network: every if, comparison and spring becomes additions, multiplications and ReLU gates over floats, collected into matrix multiplications. Nothing is trained, the result is exact, and it stays differentiable.',
  command_center: 'The command center runs a small language model, FunctionGemma, entirely in your browser. It turns what you type into commands, and every command clicks and drags through the same program you use, so the program\'s rules apply to me too.',
}

// Keeps the slideshow's interval: every 3 s it shows the next photo, until a command
// or the person stops it.
export const slideshowIntervalMs = 3000

// Prism OS's shell: the parts of the desktop that run beside the handwired program. That
// is the menu bar's extras (Spotlight, Control Center and a clock), Prism's own apps in
// glass panels, their dock tiles, and the keyboard shortcuts.
//
// The program reads every press, move and key on the page from listeners on window, see
// mountWindowManager. Everything the shell draws carries data-prism-layer, and the shell
// listens on window too, in the bubble phase, registered before the program mounts. So
// for an event that starts on the shell's elements, the shell's own handlers run first,
// and then the shell's listener on window stops the event before the program's listeners
// see it. A drag in a panel never moves a window under it, and a key typed into Terminal
// never turns a page of Chroma.
//
// The program stacks its windows at z-index 10 and up. A panel in front is at 20 and up,
// under the dock, which prism-os.css lifts to 29. A press on a program window or its dock
// tile sends every panel behind the windows, to 1 and up, and a press on a panel brings
// them back in front.
import type {Cabinet} from './cabinet.ts'
import {type AppContext, type AppInstance, type PanelApp, panelApps} from './apps.ts'
import {type CommandCenter, modelEnabled, previewSentence} from './command-center.ts'
import type {PanelAppName} from './commands.ts'
import type {PanelControls} from './operator.ts'
import {accentControl, appearanceControl, sceneControl, toggleControl} from './controls.ts'
import {button, el, icon, icons} from './dom.ts'
import {type SettingsStore, accents, appearances, scenes} from './settings.ts'
import {createVoice, recognitionClass, voiceLanguage, voiceQuestions, type VoiceView} from './voice.ts'
import type {AppInfo} from './terminal.ts'

// The program's windows, in the order of their dock tiles.
const programApps = [
  {id: 'scope', name: 'Scope', glyph: icons.scope, windowIndex: 0},
  {id: 'inkwell', name: 'Inkwell', glyph: icons.inkwell, windowIndex: 1},
  {id: 'chroma', name: 'Chroma', glyph: icons.chroma, windowIndex: 2},
] as const

// Prism's tiles on each side of the program's three, so the dock stays centered.
const dockLeft = ['cabinet', 'calculator', 'clock'] as const
const dockRight = ['browser', 'terminal', 'settings'] as const

// The program's geometry, see windowManagerCells in window-manager.ts.
const systemBarHeight = 36
const dockHeight = 76
const titleHeight = 44

type PanelState = 'closed' | 'open' | 'minimized'

type Panel = {
  app: PanelApp
  element: HTMLElement
  instance: AppInstance
  state: PanelState
  x: number
  y: number
  width: number
  height: number
  // The rectangle to go back to when a zoomed panel zooms out.
  restore: {x: number, y: number, width: number, height: number} | null
  tile: HTMLElement | null
  // The rectangle last written to the element's style, so that place() writes only what
  // changed, e.g. a drag moves the panel and never sets its size.
  placed: {x: number, y: number, width: number, height: number}
}

function viewport() {
  return {width: document.documentElement.clientWidth, height: document.documentElement.clientHeight}
}

function isShellTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-prism-layer]') !== null
}

// Spotlight runs sentences with `commands`, see command-center.ts. The returned controls
// let the operator (operator.ts) open, close, move and zoom Prism's own apps.
// programFocused takes the program's focused window from mountWindowManager's
// onFocusChange, for the menu bar's app name.
export function startShell(store: SettingsStore, commands: CommandCenter | null = null, cabinet?: Cabinet): (PanelControls & {programFocused(windowIndex: number): void}) | null {
  const desktop = document.querySelector<HTMLElement>('#desktop')
  const systemBar = document.querySelector<HTMLElement>('#system-bar')
  const dock = document.querySelector<HTMLElement>('#dock')
  if (desktop === null || systemBar === null || dock === null) return null
  const startedAt = new Date()

  // Input. See the comment at the top of the file.
  let pressOnShell = false
  const guardPress = (event: PointerEvent) => {
    if (!event.isPrimary) return
    pressOnShell = isShellTarget(event.target)
    if (pressOnShell) {
      event.stopImmediatePropagation()
      return
    }
    // A press that the program takes on one of its windows or dock tiles puts the program's
    // windows in front of the panels.
    if (event.target instanceof Element && event.target.closest('.window, .dock-item') !== null) sendPanelsBehind()
  }
  const guardDrag = (event: PointerEvent) => {
    if (event.isPrimary && pressOnShell) event.stopImmediatePropagation()
  }
  const guardRelease = (event: PointerEvent) => {
    if (!event.isPrimary || !pressOnShell) return
    pressOnShell = false
    event.stopImmediatePropagation()
  }
  window.addEventListener('pointerdown', guardPress)
  window.addEventListener('pointermove', guardDrag)
  window.addEventListener('pointerup', guardRelease)
  window.addEventListener('pointercancel', guardRelease)
  window.addEventListener('contextmenu', event => {
    if (isShellTarget(event.target)) event.stopImmediatePropagation()
  })
  // A press inside a frame, e.g. Browser's page, never reaches this page: the page only
  // loses the keyboard to the frame. So the panel that holds the frame comes to the front
  // then, as a press on it would bring it.
  window.addEventListener('blur', () => {
    window.setTimeout(() => {
      const active = document.activeElement
      if (!(active instanceof HTMLIFrameElement)) return
      const panel = [...panels.values()].find(candidate => candidate.element.contains(active))
      if (panel !== undefined && (!panelsInFront || order.at(-1) !== panel)) focusPanel(panel)
    })
  })
  window.addEventListener('keydown', event => {
    const command = event.metaKey || event.ctrlKey
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      event.stopImmediatePropagation()
      toggleSpotlight()
      return
    }
    if (event.key === 'Escape' && (spotlight.open || controlCenter.open)) {
      event.stopImmediatePropagation()
      closeOverlays()
      return
    }
    if (isShellTarget(event.target)) event.stopImmediatePropagation()
  })

  // The layer that holds the panels. It has no z-index of its own, so the panels stack
  // among the program's windows.
  const layer = el('div', 'prism-layer')
  desktop.append(layer)

  const panels = new Map<string, Panel>()
  // The open panels, back to front.
  let order: Panel[] = []
  let panelsInFront = true

  // The menu bar names the app in front, in bold beside the logo, as a Mac's does: the
  // front panel while the panels are in front, else the program's focused window, else
  // the front panel behind the program's closed windows. With nothing open, Prism OS.
  const frontApp = systemBar.querySelector<HTMLElement>('.prism-front-app')
  let programFocus = -1
  const renderFrontApp = () => {
    if (frontApp === null) return
    const panel = panelsInFront ? order.at(-1) : undefined
    const app = panel?.app ?? programApps[programFocus] ?? order.at(-1)?.app
    const name = app === undefined || app.id === 'about' ? 'Prism OS' : app.name
    if (frontApp.textContent !== name) frontApp.textContent = name
  }

  const restack = () => {
    // Keep the shell as one stacking group when resizing glass-backed panels.
    // Otherwise compositor hit testing can leave a front panel below program windows.
    layer.style.zIndex = panelsInFront ? '20' : '1'
    order.forEach((panel, index) => {
      panel.element.style.zIndex = `${(panelsInFront ? 20 : 1) + index}`
      panel.element.style.setProperty('--focused', panelsInFront && index === order.length - 1 ? '1' : '0')
    })
    for (const panel of panels.values()) {
      panel.tile?.style.setProperty('--open', panel.state === 'closed' ? '0' : '1')
    }
    renderFrontApp()
  }

  function sendPanelsBehind() {
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('.prism-panel') !== null) active.blur()
    if (!panelsInFront) return
    panelsInFront = false
    restack()
  }

  const place = (panel: Panel) => {
    const {placed, element} = panel
    if (panel.x !== placed.x || panel.y !== placed.y) element.style.transform = `translate(${panel.x}px, ${panel.y}px)`
    if (panel.width !== placed.width) element.style.width = `${panel.width}px`
    if (panel.height !== placed.height) element.style.height = `${panel.height}px`
    panel.placed = {x: panel.x, y: panel.y, width: panel.width, height: panel.height}
  }

  // Keeps a panel's title bar reachable: inside the workspace vertically, and at least
  // 96 px of it inside the viewport horizontally.
  const clampPanel = (panel: Panel) => {
    const {width, height} = viewport()
    panel.width = Math.min(panel.width, Math.max(240, width - 16))
    panel.height = Math.min(panel.height, Math.max(titleHeight + 120, height - systemBarHeight - dockHeight - 16))
    panel.x = Math.min(width - 96, Math.max(96 - panel.width, panel.x))
    panel.y = Math.min(height - dockHeight - titleHeight, Math.max(systemBarHeight + 8, panel.y))
    if (panel.app.id === 'cabinet') {
      panel.x = Math.max(8, Math.min(width - panel.width - 8, panel.x))
      panel.y = Math.max(systemBarHeight + 8, Math.min(height - dockHeight - panel.height - 8, panel.y))
    }
  }

  const focusPanel = (panel: Panel) => {
    order = [...order.filter(other => other !== panel), panel]
    panelsInFront = true
    restack()
  }

  // A command from Spotlight opens a panel and leaves Spotlight open, with its reply.
  const openPanel = (id: string, keepOverlays = false) => {
    const panel = panels.get(id) ?? createPanel(id)
    if (panel === undefined) return
    if (!keepOverlays) closeOverlays()
    if (panel.state === 'closed') {
      // A new window opens near the middle of the workspace, a little lower and to the right
      // of the last one, like a cascade.
      const {width, height} = viewport()
      const step = (order.length % 5) * 28
      panel.width = panel.app.width
      panel.height = panel.app.height
      panel.x = Math.round((width - panel.width) / 2) + step - 56
      panel.y = Math.round(systemBarHeight + (height - systemBarHeight - dockHeight - panel.height) / 3) + step
      panel.restore = null
    }
    clampPanel(panel)
    place(panel)
    const wasClosed = panel.state === 'closed'
    const wasHidden = panel.state !== 'open'
    panel.state = 'open'
    panel.element.dataset['state'] = 'open'
    focusPanel(panel)
    if (!keepOverlays) panel.element.focus({preventScroll: true})
    if (wasClosed) panel.instance.opened?.()
    if (wasHidden) panel.instance.visible?.(true)
  }

  const hidePanel = (panel: Panel, state: 'closed' | 'minimized') => {
    if (panel.state === 'closed') return
    const wasOpen = panel.state === 'open'
    panel.state = state
    panel.element.dataset['state'] = state
    order = order.filter(other => other !== panel)
    if (wasOpen) panel.instance.visible?.(false)
    if (state === 'closed') panel.instance.closed?.()
    restack()
    if (wasOpen) order.at(-1)?.element.focus({preventScroll: true})
  }

  const closePanel = (id: string) => {
    const panel = panels.get(id)
    if (panel === undefined || panel.state === 'closed') return false
    hidePanel(panel, 'closed')
    return true
  }

  const toggleZoom = (panel: Panel) => {
    if (!panel.app.resizable) return
    if (panel.restore !== null) {
      Object.assign(panel, panel.restore)
      panel.restore = null
    } else {
      const {width, height} = viewport()
      panel.restore = {x: panel.x, y: panel.y, width: panel.width, height: panel.height}
      panel.x = 12
      panel.y = systemBarHeight + 12
      panel.width = width - 24
      panel.height = height - systemBarHeight - dockHeight - 24
    }
    panel.element.dataset['zoomed'] = `${panel.restore !== null}`
    place(panel)
  }

  function createPanel(id: string): Panel | undefined {
    const app = panelApps.find(candidate => candidate.id === id)
    if (app === undefined) return undefined
    const element = el('section', `prism-panel prism-panel-${app.id}`)
    element.dataset['prismLayer'] = ''
    element.dataset['state'] = 'closed'
    element.tabIndex = -1
    element.setAttribute('role', 'dialog')
    element.setAttribute('aria-label', app.name)

    const bar = el('div', 'titlebar prism-panel-bar')
    const title = el('div', 'window-title')
    const dot = el('span', `app-dot prism-app-dot prism-app-${app.id}`)
    dot.append(icon(app.glyph))
    title.append(dot, el('span', '', app.name))
    const controls = el('div', 'window-controls')
    const minimize = button('window-button minimize', `Minimize ${app.name}`)
    const zoom = button('window-button maximize', `Zoom ${app.name}`)
    const close = button('window-button close', `Close ${app.name}`)
    zoom.disabled = !app.resizable
    controls.append(minimize, zoom, close)
    bar.append(title, controls)
    const body = el('div', `prism-panel-body ${app.id}-body`)
    element.append(bar, body)
    layer.append(element)

    const panel: Panel = {app, element, instance: {}, state: 'closed', x: 0, y: 0, width: app.width, height: app.height, restore: null, tile: null, placed: {x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN}}
    panels.set(id, panel)
    panel.instance = app.build(element, body, context)

    minimize.addEventListener('click', () => hidePanel(panel, 'minimized'))
    close.addEventListener('click', () => hidePanel(panel, 'closed'))
    zoom.addEventListener('click', () => toggleZoom(panel))
    bar.addEventListener('dblclick', event => {
      if (!(event.target instanceof Element && event.target.closest('.window-controls') !== null)) toggleZoom(panel)
    })

    // A press anywhere on the panel brings it to the front, and gives it the keyboard
    // unless the press lands on a control of its own.
    element.addEventListener('pointerdown', event => {
      focusPanel(panel)
      if (!(event.target instanceof Element && event.target.closest('button, input, textarea, select, a') !== null)) {
        element.focus({preventScroll: true})
      }
    })

    // Dragging by the title bar. A move only records where the pointer is, and one
    // update per displayed frame moves the panel there: the browser can send several
    // moves between two frames. The release moves the panel to its last move at once.
    let drag: {pointerId: number, dx: number, dy: number, clientX: number, clientY: number} | null = null
    let dragFrame = 0
    const moveToPointer = () => {
      dragFrame = 0
      if (drag === null) return
      panel.x = Math.round(drag.clientX - drag.dx)
      panel.y = Math.round(drag.clientY - drag.dy)
      clampPanel(panel)
      place(panel)
    }
    bar.addEventListener('pointerdown', event => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.window-controls') !== null)) return
      if (panel.restore !== null) return
      drag = {pointerId: event.pointerId, dx: event.clientX - panel.x, dy: event.clientY - panel.y, clientX: event.clientX, clientY: event.clientY}
      bar.setPointerCapture(event.pointerId)
      element.classList.add('prism-dragging')
    })
    bar.addEventListener('pointermove', event => {
      if (drag?.pointerId !== event.pointerId) return
      drag.clientX = event.clientX
      drag.clientY = event.clientY
      if (dragFrame === 0) dragFrame = requestAnimationFrame(moveToPointer)
    })
    const endDrag = (event: PointerEvent) => {
      if (drag?.pointerId !== event.pointerId) return
      if (dragFrame !== 0) {
        cancelAnimationFrame(dragFrame)
        moveToPointer()
      }
      drag = null
      element.classList.remove('prism-dragging')
    }
    bar.addEventListener('pointerup', endDrag)
    bar.addEventListener('pointercancel', endDrag)
    return panel
  }

  // The program's windows open by a click on their dock tiles, through the program's own
  // input: a press and a release at the tile's middle, where the program tests them.
  const openProgramApp = (windowIndex: number) => {
    const tile = document.querySelectorAll<HTMLElement>('.dock-item')[windowIndex]
    if (tile === undefined) return
    closeOverlays()
    const x = Number.parseFloat(tile.style.left) + Number.parseFloat(tile.style.width) / 2
    const y = Number.parseFloat(tile.style.top) + Number.parseFloat(tile.style.height) / 2
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const init: PointerEventInit = {bubbles: true, cancelable: true, composed: true, isPrimary: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y}
    tile.dispatchEvent(new PointerEvent('pointerdown', init))
    tile.dispatchEvent(new PointerEvent('pointerup', {...init, buttons: 0}))
  }

  const apps: AppInfo[] = [
    ...programApps.map(app => ({id: app.id, name: app.name, kind: 'program' as const})),
    ...panelApps.filter(app => app.id !== 'about').map(app => ({id: app.id, name: app.name, kind: 'panel' as const})),
  ]

  const programFacts = () => [...document.querySelectorAll('.monitor-counts li')]
    .map(item => item.textContent.trim().replace(/\s+/g, ' '))
    .filter(text => text !== '')

  const open = (id: string) => {
    const program = programApps.find(app => app.id === id)
    if (program !== undefined) openProgramApp(program.windowIndex)
    else openPanel(id)
  }

  const context: AppContext = {cabinet, settings: store, apps, open, close: closePanel, programFacts, startedAt}

  // The dock's extra tiles. They sit beside the program's tiles, whose places the program
  // computes; see .prism-tile in prism-os.css for theirs.
  const addTile = (id: string, side: 'left' | 'right', index: number) => {
    const app = panelApps.find(candidate => candidate.id === id)
    if (app === undefined) return
    const tile = button(`prism-tile prism-app-${id}`, app.name)
    tile.dataset['prismLayer'] = ''
    tile.title = app.name
    // The program's three 50 px tiles span 87 px each side of the middle, 12 px apart, so
    // the k-th tile out on the left starts 87 + 62 k px left of the middle, and the k-th
    // on the right 99 + 62 (k - 1) px right of it.
    const k = index + 1
    tile.style.setProperty('--offset', `${side === 'left' ? -87 - 62 * k : 37 + 62 * k}px`)
    tile.append(icon(app.glyph), el('i'))
    tile.addEventListener('click', () => openPanel(id))
    dock.append(tile)
    const panel = panels.get(id) ?? createPanel(id)
    if (panel !== undefined) panel.tile = tile
  }
  dockLeft.forEach((id, index) => addTile(id, 'left', dockLeft.length - 1 - index))
  dockRight.forEach((id, index) => addTile(id, 'right', index))
  dock.classList.add('prism-dock-extended')
  // The dock's glass shelf, under every tile. Its span is the tiles', and its middle sits
  // 31 px toward the side with more tiles for each tile more, see .prism-dock-glass.
  const dockGlass = el('div', 'prism-dock-glass')
  dockGlass.dataset['prismLayer'] = ''
  dockGlass.dataset['glassLight'] = ''
  dockGlass.style.setProperty('--tiles-span', `${174 + 62 * (dockLeft.length + dockRight.length)}px`)
  dockGlass.style.setProperty('--tiles-shift', `${31 * (dockRight.length - dockLeft.length)}px`)
  dock.prepend(dockGlass)
  restack()

  // The menu bar: the logo opens About, the front app's name follows it, and Spotlight,
  // Control Center and the clock sit at the right.
  const brand = systemBar.querySelector<HTMLElement>('.prism-brand')
  if (brand !== null) {
    brand.dataset['prismLayer'] = ''
    brand.addEventListener('click', () => openPanel('about'))
  }
  const status = el('div', 'prism-status')
  status.dataset['prismLayer'] = ''
  const searchButton = button('prism-status-button', 'Spotlight search (⌘K)')
  searchButton.append(icon(icons.search))
  const controlButton = button('prism-status-button', 'Control Center')
  controlButton.append(icon(icons.controls))
  const clockText = el('time', 'prism-clock')
  status.append(searchButton, controlButton, clockText)
  systemBar.append(status)
  const clockFormat = new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})
  const renderClock = () => {
    const now = new Date()
    // "Thu Oct 15 6:57 PM", as a Mac's menu bar writes it.
    clockText.textContent = clockFormat.format(now).replace(/,/g, '')
    clockText.dateTime = now.toISOString()
  }
  renderClock()
  window.setInterval(renderClock, 1000)

  // Overlays: Spotlight and Control Center. A scrim under each takes the presses outside it,
  // which close it.
  const makeOverlay = (className: string, label: string) => {
    const scrim = el('div', `prism-scrim ${className}-scrim`)
    scrim.dataset['prismLayer'] = ''
    scrim.hidden = true
    const sheet = el('div', `prism-overlay ${className}`)
    sheet.setAttribute('role', 'dialog')
    sheet.setAttribute('aria-label', label)
    scrim.append(sheet)
    desktop.append(scrim)
    scrim.addEventListener('pointerdown', event => {
      if (event.target === scrim) closeOverlays()
    })
    return {scrim, sheet, open: false}
  }

  // Spotlight: apps and commands, found as you type.
  // A result runs and closes Spotlight, or with keepOpen runs a sentence and stays.
  type Result = {title: string, subtitle: string, glyph: string, tile: string, run(): void, keepOpen?: boolean, kind?: 'command'}
  const spotlight = makeOverlay('prism-spotlight', 'Spotlight')
  const searchRow = el('div', 'spotlight-row')
  const searchInput = el('input', 'spotlight-input')
  searchInput.type = 'search'
  searchInput.placeholder = 'Spotlight Search'
  searchInput.setAttribute('aria-label', 'Spotlight Search')
  searchInput.autocomplete = 'off'
  searchInput.spellcheck = false
  searchRow.append(icon(icons.search), searchInput)
  searchRow.dataset['glassLight'] = ''
  // Voice, see voice.ts: what's said becomes the search, as if typed. A browser that
  // can't recognize speech shows no microphone.
  const voiceBox = el('div', 'spotlight-confirm spotlight-voice')
  voiceBox.hidden = true
  const voiceText = el('p', 'spotlight-confirm-text')
  const voiceDecline = button('prism-button', 'Cancel', 'Cancel')
  const voiceAccept = button('prism-button spotlight-accept', 'Use it', 'Use it')
  const voiceActions = el('div', 'spotlight-confirm-actions')
  voiceActions.append(voiceDecline, voiceAccept)
  voiceBox.append(voiceText, voiceActions)
  const Recognition = recognitionClass(window)
  const micButton = button('spotlight-mic', 'Speak')
  micButton.append(icon(icons.microphone))
  micButton.setAttribute('aria-pressed', 'false')
  const placeholder = () => commands === null ? 'Spotlight Search' : 'Search, or tell Prism OS what to do'
  const showVoice = ({state, message}: VoiceView) => {
    const listening = state.kind === 'listening'
    micButton.setAttribute('aria-pressed', `${listening}`)
    micButton.setAttribute('aria-label', listening ? 'Stop listening' : 'Speak')
    micButton.classList.toggle('is-listening', listening)
    micButton.classList.toggle('is-busy', state.kind === 'checking' || state.kind === 'installing')
    searchInput.placeholder = listening ? 'Listening…' : state.kind === 'installing' ? 'Downloading speech recognition…' : placeholder()
    const question = state.kind === 'question' ? voiceQuestions[state.question] : null
    voiceText.textContent = question?.text ?? message ?? ''
    voiceActions.hidden = question === null
    if (question !== null) {
      voiceAccept.textContent = question.accept
      voiceDecline.textContent = question.decline
    }
    voiceBox.hidden = question === null && message === null
  }
  const storage = (() => {
    try {
      return window.localStorage
    } catch {
      return null
    }
  })()
  const voice = Recognition === null ? null : createVoice({
    Recognition,
    storage,
    language: voiceLanguage(navigator.language),
    onText: (text, final) => {
      searchInput.value = text
      selected = 0
      renderResults()
      if (final) searchInput.focus({preventScroll: true})
    },
    onChange: showVoice,
  })
  if (voice !== null) {
    searchRow.append(micButton)
    micButton.addEventListener('click', () => voice.toggle())
    voiceAccept.addEventListener('click', () => voice.answer(true))
    voiceDecline.addEventListener('click', () => voice.answer(false))
  }
  const resultList = el('ul', 'spotlight-results')
  resultList.setAttribute('role', 'listbox')
  // The search floats as a capsule, and the results and replies sit in a sheet under it,
  // which the stylesheet hides while it holds nothing.
  const resultSheet = el('div', 'spotlight-sheet')
  resultSheet.append(voiceBox, resultList)
  spotlight.sheet.append(searchRow, resultSheet)
  if (commands !== null) {
    resultSheet.append(commands.element)
    searchInput.placeholder = placeholder()
    searchInput.setAttribute('aria-label', 'Search or command')
  }

  // A sentence that Spotlight can run, as a result: the calls it will make, or a note
  // that the model will read it.
  const commandResult = (query: string): Result | null => {
    if (commands === null) return null
    const preview = previewSentence(query)
    if (preview === null) return null
    const subtitle = preview.kind === 'commands' ? preview.calls : preview.kind === 'help' ? 'What Spotlight can do' : 'The model in your browser decides'
    return {title: query.trim(), subtitle, glyph: icons.command, tile: 'prism-command', keepOpen: true, kind: 'command', run: () => runSentence(query)}
  }

  const runSentence = (query: string) => {
    if (commands === null) return
    searchInput.value = ''
    selected = 0
    renderResults()
    void commands.run(query).finally(() => {
      if (spotlight.open && !commands.hasPendingQuestion()) searchInput.focus({preventScroll: true})
    })
  }

  const catalog = (): Result[] => [
    ...programApps.map(app => ({title: app.name, subtitle: 'Handwired program window', glyph: app.glyph, tile: `prism-app-${app.id}`, run: () => open(app.id)})),
    ...panelApps.map(app => ({title: app.name, subtitle: app.id === 'about' ? 'System' : 'Prism app', glyph: app.glyph, tile: `prism-app-${app.id}`, run: () => openPanel(app.id)})),
    ...appearances.map(appearance => ({title: `${appearance[0]?.toUpperCase() ?? ''}${appearance.slice(1)} appearance`, subtitle: 'Appearance', glyph: appearance === 'dark' ? icons.moon : appearance === 'light' ? icons.sun : icons.auto, tile: 'prism-command', run: () => store.update({appearance})})),
    ...(Object.keys(accents) as (keyof typeof accents)[]).map(accent => ({title: `${accents[accent].label} accent`, subtitle: 'Accent color', glyph: icons.app, tile: 'prism-command', run: () => store.update({accent})})),
    ...(Object.keys(scenes) as (keyof typeof scenes)[]).map(scene => ({title: `${scenes[scene].label} wallpaper`, subtitle: 'Wallpaper', glyph: icons.waves, tile: 'prism-command', run: () => store.update({scene})})),
    {title: store.get().motion ? 'Turn wallpaper motion off' : 'Turn wallpaper motion on', subtitle: 'Desktop', glyph: icons.waves, tile: 'prism-command', run: () => store.update({motion: !store.get().motion})},
    {title: store.get().arcs ? 'Hide the weight arcs' : 'Show the weight arcs', subtitle: 'Desktop', glyph: icons.arcs, tile: 'prism-command', run: () => store.update({arcs: !store.get().arcs})},
  ]

  let results: Result[] = []
  let selected = 0
  const renderResults = () => {
    const query = searchInput.value.trim().toLowerCase()
    const all = catalog()
    const score = (result: Result) => {
      const title = result.title.toLowerCase()
      if (query === '') return result.subtitle.includes('program') || result.subtitle === 'Prism app' ? 1 : 0
      if (title.startsWith(query)) return 3
      if (title.split(/\s+/).some(word => word.startsWith(query))) return 2
      if (title.includes(query) || result.subtitle.toLowerCase().includes(query)) return 1
      return 0
    }
    const ranked = all.map((result, index) => ({result, index, score: score(result)}))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
    const command = query === '' ? null : commandResult(searchInput.value)
    // One word is a search: "dark" finds "Dark appearance" first and the command second.
    // A sentence is a command: "lagoon wallpaper" runs first, and Spotlight stays open.
    const strongMatch = ranked.length > 0 && ranked[0]!.score === 3 && !/\s/u.test(query)
    results = [
      ...(command !== null && !strongMatch ? [command] : []),
      ...ranked.slice(0, command === null ? 8 : 7).map(entry => entry.result),
      ...(command !== null && strongMatch ? [command] : []),
    ]
    selected = Math.min(selected, Math.max(0, results.length - 1))
    resultList.replaceChildren(...results.map((result, index) => {
      const item = el('li', 'spotlight-result')
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', `${index === selected}`)
      const glyph = el('span', `spotlight-glyph ${result.tile}`)
      glyph.append(icon(result.glyph))
      const text = el('span', 'spotlight-text')
      text.append(el('span', 'spotlight-title', result.title), el('span', 'spotlight-subtitle', result.subtitle))
      item.append(glyph, text)
      item.addEventListener('pointermove', () => {
        if (selected === index) return
        selected = index
        renderResults()
      })
      item.addEventListener('click', () => runResult(result))
      if (result.kind === 'command') item.classList.add('spotlight-command')
      return item
    }))
    if (results.length === 0 && query !== '') {
      resultList.append(el('li', 'spotlight-empty', commands !== null && !modelEnabled ? 'No app or command matches. Try "help" for what I can do.' : 'No results'))
    }
    // After a command ran, an empty query shows the replies instead of the default list.
    resultList.hidden = query === '' && hasReplies()
  }
  searchInput.addEventListener('input', () => {
    // Typing clears what Voice last said about itself.
    const spoken = voice?.view()
    if (spoken?.state.kind === 'idle' && spoken.message !== null) voice?.stop()
    selected = 0
    renderResults()
  })
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length > 0) selected = (selected + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length
      renderResults()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const result = results[selected]
      if (result !== undefined) runResult(result)
    }
  })

  function runResult(result: Result) {
    if (result.keepOpen === true) {
      result.run()
      return
    }
    closeOverlays()
    result.run()
  }
  function hasReplies() {
    return commands !== null && commands.element.querySelector('.spotlight-entry') !== null
  }
  commands?.onRender(() => {
    if (spotlight.open) resultList.hidden = searchInput.value.trim() === '' && hasReplies()
  })

  // Control Center: the quick preferences, and a way into Settings.
  const controlCenter = makeOverlay('prism-control-center', 'Control Center')
  const card = (title: string, ...content: HTMLElement[]) => {
    const element = el('div', 'cc-card')
    element.dataset['glassLight'] = ''
    element.append(el('div', 'cc-title', title), ...content)
    return element
  }
  const settingsLink = button('cc-link', 'Settings…', 'Settings…')
  settingsLink.prepend(icon(icons.settings))
  settingsLink.dataset['glassLight'] = ''
  settingsLink.addEventListener('click', () => openPanel('settings'))
  controlCenter.sheet.append(
    card('Appearance', appearanceControl(store)),
    card('Desktop', toggleControl(store, 'motion', 'Wallpaper motion', icons.waves), toggleControl(store, 'arcs', 'Weight arcs', icons.arcs)),
    card('Accent', accentControl(store)),
    card('Wallpaper', sceneControl(store, 'small')),
    settingsLink,
  )

  function closeOverlays() {
    voice?.stop()
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('.prism-scrim') !== null) active.blur()
    for (const overlay of [spotlight, controlCenter]) {
      overlay.open = false
      overlay.scrim.hidden = true
    }
    searchButton.setAttribute('aria-expanded', 'false')
    controlButton.setAttribute('aria-expanded', 'false')
  }

  function toggleSpotlight() {
    const opening = !spotlight.open
    closeOverlays()
    if (!opening) return
    spotlight.open = true
    spotlight.scrim.hidden = false
    searchButton.setAttribute('aria-expanded', 'true')
    searchInput.value = ''
    selected = 0
    renderResults()
    commands?.opened()
    searchInput.focus({preventScroll: true})
  }

  const toggleControlCenter = () => {
    const opening = !controlCenter.open
    closeOverlays()
    if (!opening) return
    controlCenter.open = true
    controlCenter.scrim.hidden = false
    controlButton.setAttribute('aria-expanded', 'true')
  }

  searchButton.addEventListener('click', toggleSpotlight)
  controlButton.addEventListener('click', toggleControlCenter)

  window.addEventListener('resize', () => {
    for (const panel of panels.values()) {
      if (panel.state === 'closed') continue
      if (panel.restore !== null) {
        panel.restore = null
        toggleZoom(panel)
      }
      clampPanel(panel)
      place(panel)
    }
  })

  // What the operator may do to Prism's apps, the same things their buttons do.
  const panelFor = (id: PanelAppName) => panels.get(id) ?? createPanel(id)
  return {
    state: id => panels.get(id)?.state ?? 'closed',
    zoomed: id => (panels.get(id)?.restore ?? null) !== null,
    resizable: id => panelApps.find(app => app.id === id)?.resizable ?? false,
    open: id => openPanel(id, true),
    close: id => void closePanel(id),
    minimize: id => {
      const panel = panels.get(id)
      if (panel !== undefined) hidePanel(panel, 'minimized')
    },
    zoom: id => {
      const panel = panelFor(id)
      if (panel !== undefined) toggleZoom(panel)
    },
    move: (id, position) => {
      const panel = panelFor(id)
      if (panel === undefined) return
      if (panel.restore !== null) toggleZoom(panel)
      const {width, height} = viewport()
      const margin = 12
      const top = systemBarHeight + margin
      const bottom = height - dockHeight - margin - panel.height
      const left = margin
      const right = width - margin - panel.width
      const centerX = Math.round((width - panel.width) / 2)
      const centerY = Math.round(systemBarHeight + (height - systemBarHeight - dockHeight - panel.height) / 2)
      const places = {
        left: [left, centerY], right: [right, centerY], center: [centerX, centerY],
        top_left: [left, top], top_right: [right, top], bottom_left: [left, bottom], bottom_right: [right, bottom],
      } as const
      ;[panel.x, panel.y] = places[position]
      clampPanel(panel)
      place(panel)
      focusPanel(panel)
    },
    sendBehind: sendPanelsBehind,
    programFocused: windowIndex => {
      programFocus = windowIndex
      renderFrontApp()
    },
    stopwatch: action => {
      openPanel('clock', true)
      return panels.get('clock')?.instance.stopwatch?.(action) ?? 'Clock isn\'t available.'
    },
    browse: url => {
      openPanel('browser', true)
      return panels.get('browser')?.instance.browse?.(url) ?? {kind: 'refused', site: 'Browser'}
    },
    browserNavigate: action => {
      openPanel('browser', true)
      return panels.get('browser')?.instance.navigate?.(action) ?? 'Browser isn\'t available.'
    },
    // A new timer shows its countdown; pausing or canceling one leaves Clock as it is.
    timer: request => {
      if (request.kind === 'start') openPanel('clock', true)
      return panelFor('clock')?.instance.timer?.(request) ?? 'Clock isn\'t available.'
    },
    front: () => {
      const id = panelsInFront ? order.at(-1)?.app.id : undefined
      return panelApps.some(app => app.id === id) ? id as PanelAppName : null
    },
  }
}

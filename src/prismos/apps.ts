// Prism OS's own apps. Each one builds its view into a panel's body, see shell.ts. They run
// in plain JavaScript beside the handwired program, which keeps running Scope, Inkwell and
// Chroma.
import {type CalculatorKey, type CalculatorState, initialCalculator, keyFromKeyboard, pressKey} from './calculator.ts'
import {accentControl, appearanceControl, sceneControl, toggleControl} from './controls.ts'
import {button, el, icon, icons} from './dom.ts'
import type {SettingsStore} from './settings.ts'
import {type AppInfo, runCommand} from './terminal.ts'

export type AppContext = {
  settings: SettingsStore
  apps: readonly AppInfo[]
  open(id: string): void
  close(id: string): boolean
  // The program's sizes as Scope's footer shows them, e.g. ["130 layers", "9,909 weights", "114 KB"].
  programFacts(): string[]
  startedAt: Date
}

export type StopwatchAction = 'start' | 'stop' | 'lap' | 'reset'

export type AppInstance = {
  opened?(): void
  closed?(): void
  // Clock's stopwatch, for Spotlight's commands: shows the stopwatch and acts like its
  // buttons, then returns what happened.
  stopwatch?(action: StopwatchAction): string
}

export type PanelApp = {
  id: string
  name: string
  glyph: string
  width: number
  height: number
  resizable: boolean
  build(root: HTMLElement, body: HTMLElement, context: AppContext): AppInstance
}

// Calculator: the pocket calculator of calculator.ts, with round keys and keyboard input.
const calculator: PanelApp = {
  id: 'calculator',
  name: 'Calculator',
  glyph: icons.calculator,
  width: 252,
  height: 432,
  resizable: false,
  build(root, body) {
    let state: CalculatorState = initialCalculator
    const display = el('output', 'calc-display', '0')
    display.setAttribute('aria-live', 'polite')
    const keys = el('div', 'calc-keys')
    const layout: {key: CalculatorKey, label: string, kind: 'function' | 'operator' | 'digit', wide?: boolean}[] = [
      {key: 'clear', label: 'AC', kind: 'function'}, {key: 'sign', label: '±', kind: 'function'}, {key: 'percent', label: '%', kind: 'function'}, {key: '÷', label: '÷', kind: 'operator'},
      {key: '7', label: '7', kind: 'digit'}, {key: '8', label: '8', kind: 'digit'}, {key: '9', label: '9', kind: 'digit'}, {key: '×', label: '×', kind: 'operator'},
      {key: '4', label: '4', kind: 'digit'}, {key: '5', label: '5', kind: 'digit'}, {key: '6', label: '6', kind: 'digit'}, {key: '-', label: '−', kind: 'operator'},
      {key: '1', label: '1', kind: 'digit'}, {key: '2', label: '2', kind: 'digit'}, {key: '3', label: '3', kind: 'digit'}, {key: '+', label: '+', kind: 'operator'},
      {key: '0', label: '0', kind: 'digit', wide: true}, {key: '.', label: '.', kind: 'digit'}, {key: '=', label: '=', kind: 'operator'},
    ]
    const names: Partial<Record<CalculatorKey, string>> = {'clear': 'All clear', 'sign': 'Change sign', 'percent': 'Percent', '÷': 'Divide', '×': 'Multiply', '-': 'Subtract', '+': 'Add', '=': 'Equals', '.': 'Decimal point'}
    const keyButtons = new Map<CalculatorKey, HTMLButtonElement>()
    for (const entry of layout) {
      const key = button(`calc-key calc-${entry.kind}${entry.wide === true ? ' calc-wide' : ''}`, names[entry.key] ?? entry.label, entry.label)
      key.addEventListener('click', () => press(entry.key))
      keys.append(key)
      keyButtons.set(entry.key, key)
    }
    const render = () => {
      display.textContent = state.display
      // Long numbers shrink to stay on one line.
      display.style.setProperty('--digits', `${Math.max(7, state.display.length)}`)
      for (const operator of ['+', '-', '×', '÷'] as const) {
        keyButtons.get(operator)?.setAttribute('aria-pressed', `${state.fresh && state.operator === operator}`)
      }
    }
    const press = (key: CalculatorKey) => {
      state = pressKey(state, key)
      render()
    }
    root.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = keyFromKeyboard(event.key)
      if (key === null) return
      event.preventDefault()
      press(key)
      const pressed = keyButtons.get(key)
      pressed?.classList.add('calc-flash')
      window.setTimeout(() => pressed?.classList.remove('calc-flash'), 120)
    })
    body.append(display, keys)
    render()
    return {}
  },
}

// Clock: world clocks with small analog faces, and a stopwatch with laps.
type City = {name: string, zone: string}

function zoneParts(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: zone, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'}).formatToParts(date)
  const read = (type: string) => Number(parts.find(part => part.type === type)?.value ?? '0')
  return {year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24, minute: read('minute'), second: read('second')}
}

function formatStopwatch(milliseconds: number): string {
  const centiseconds = Math.floor(milliseconds / 10)
  const minutes = Math.floor(centiseconds / 6000)
  const seconds = Math.floor((centiseconds % 6000) / 100)
  const hundredths = centiseconds % 100
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}

const clock: PanelApp = {
  id: 'clock',
  name: 'Clock',
  glyph: icons.clock,
  width: 360,
  height: 476,
  resizable: true,
  build(_root, body) {
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const cities: City[] = [
      {name: localZone.split('/').pop()?.replaceAll('_', ' ') ?? 'Local', zone: localZone},
      {name: 'Cupertino', zone: 'America/Los_Angeles'},
      {name: 'New York', zone: 'America/New_York'},
      {name: 'London', zone: 'Europe/London'},
      {name: 'Tokyo', zone: 'Asia/Tokyo'},
      {name: 'Sydney', zone: 'Australia/Sydney'},
    ]
    const tabs = el('div', 'prism-segmented clock-tabs')
    tabs.setAttribute('role', 'tablist')
    const worldTab = button('prism-segment', 'World Clock', 'World Clock')
    const stopwatchTab = button('prism-segment', 'Stopwatch', 'Stopwatch')
    for (const tab of [worldTab, stopwatchTab]) tab.setAttribute('role', 'tab')
    tabs.append(worldTab, stopwatchTab)

    const world = el('ul', 'clock-world')
    const rows = cities.map(city => {
      const row = el('li', 'clock-city')
      const face = el('span', 'clock-face')
      face.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18.5" class="clock-rim"/>'
        + Array.from({length: 12}, (_, index) => `<line x1="20" y1="3.5" x2="20" y2="6" transform="rotate(${index * 30} 20 20)" class="clock-tick"/>`).join('')
        + '<line class="clock-hour" x1="20" y1="20" x2="20" y2="11"/><line class="clock-minute" x1="20" y1="20" x2="20" y2="6.5"/><line class="clock-second" x1="20" y1="23" x2="20" y2="5"/><circle cx="20" cy="20" r="1.4" class="clock-pin"/></svg>'
      const text = el('span', 'clock-city-text')
      const name = el('span', 'clock-city-name', city.name)
      const offset = el('span', 'clock-city-offset')
      text.append(name, offset)
      const time = el('span', 'clock-city-time')
      row.append(face, text, time)
      world.append(row)
      const hands = ['.clock-hour', '.clock-minute', '.clock-second'].map(selector => face.querySelector<SVGLineElement>(selector))
      return {city, offset, time, face, hands}
    })

    const stopwatch = el('div', 'clock-stopwatch')
    const readout = el('div', 'clock-readout', '00:00.00')
    const controls = el('div', 'clock-controls')
    const lapButton = button('clock-round clock-secondary', 'Lap', 'Lap')
    const startButton = button('clock-round clock-start', 'Start', 'Start')
    controls.append(lapButton, startButton)
    const laps = el('ol', 'clock-laps')
    stopwatch.append(readout, controls, laps)

    let running = false
    let startedAt = 0
    let carried = 0
    let lapStart = 0
    let lapTimes: number[] = []
    let frame = 0
    let tick = 0
    const elapsed = () => carried + (running ? performance.now() - startedAt : 0)

    const renderStopwatch = () => {
      readout.textContent = formatStopwatch(elapsed())
      startButton.textContent = running ? 'Stop' : 'Start'
      startButton.setAttribute('aria-label', running ? 'Stop' : 'Start')
      startButton.classList.toggle('clock-stop', running)
      lapButton.textContent = running || elapsed() === 0 ? 'Lap' : 'Reset'
      lapButton.setAttribute('aria-label', lapButton.textContent)
      lapButton.disabled = !running && elapsed() === 0
      const current = elapsed() - lapStart
      const all = [...lapTimes, ...(elapsed() > 0 ? [current] : [])]
      laps.replaceChildren(...all.map((time, index) => {
        const item = el('li', 'clock-lap')
        item.append(el('span', '', `Lap ${index + 1}`), el('span', 'clock-lap-time', formatStopwatch(time)))
        return item
      }).reverse())
    }

    const animate = () => {
      frame = 0
      renderStopwatch()
      if (running) frame = requestAnimationFrame(animate)
    }

    const startOrStop = () => {
      if (running) {
        carried = elapsed()
        running = false
      } else {
        startedAt = performance.now()
        running = true
        if (frame === 0) frame = requestAnimationFrame(animate)
      }
      renderStopwatch()
    }
    startButton.addEventListener('click', startOrStop)
    const lapOrReset = () => {
      if (running) {
        lapTimes.push(elapsed() - lapStart)
        lapStart = elapsed()
      } else {
        carried = 0
        lapStart = 0
        lapTimes = []
      }
      renderStopwatch()
    }
    lapButton.addEventListener('click', lapOrReset)

    const renderWorld = () => {
      const now = new Date()
      const local = zoneParts(now, localZone)
      const localStamp = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
      for (const row of rows) {
        const parts = zoneParts(now, row.city.zone)
        const stamp = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
        const hours = Math.round((stamp - localStamp) / 360_000) / 10
        const dayDifference = Date.UTC(parts.year, parts.month - 1, parts.day) - Date.UTC(local.year, local.month - 1, local.day)
        const day = dayDifference > 0 ? 'Tomorrow' : dayDifference < 0 ? 'Yesterday' : 'Today'
        row.offset.textContent = hours === 0 ? `${day}, local time` : `${day}, ${hours > 0 ? '+' : ''}${hours} hrs`
        row.time.textContent = new Intl.DateTimeFormat(undefined, {timeZone: row.city.zone, hour: 'numeric', minute: '2-digit'}).format(now)
        const angles = [(parts.hour % 12) * 30 + parts.minute * 0.5, parts.minute * 6 + parts.second * 0.1, parts.second * 6]
        row.hands.forEach((hand, index) => hand?.setAttribute('transform', `rotate(${angles[index] ?? 0} 20 20)`))
        row.face.classList.toggle('clock-night', parts.hour < 6 || parts.hour >= 18)
      }
    }

    const show = (tab: 'world' | 'stopwatch') => {
      worldTab.setAttribute('aria-selected', `${tab === 'world'}`)
      stopwatchTab.setAttribute('aria-selected', `${tab === 'stopwatch'}`)
      world.hidden = tab !== 'world'
      stopwatch.hidden = tab !== 'stopwatch'
    }
    worldTab.addEventListener('click', () => show('world'))
    stopwatchTab.addEventListener('click', () => show('stopwatch'))
    body.append(tabs, world, stopwatch)
    show('world')
    renderStopwatch()

    return {
      opened() {
        renderWorld()
        if (tick === 0) tick = window.setInterval(renderWorld, 1000)
      },
      closed() {
        window.clearInterval(tick)
        tick = 0
      },
      stopwatch(action) {
        show('stopwatch')
        const time = () => formatStopwatch(elapsed())
        switch (action) {
          case 'start':
            if (running) return `The stopwatch is already running: ${time()}.`
            startOrStop()
            return 'The stopwatch is running.'
          case 'stop':
            if (!running) return elapsed() === 0 ? 'The stopwatch isn\'t running.' : `The stopwatch is stopped at ${time()}.`
            startOrStop()
            return `Stopped at ${time()}.`
          case 'lap':
            if (!running) return 'The stopwatch isn\'t running. Start it first.'
            lapOrReset()
            return `Lap ${lapTimes.length}: ${formatStopwatch(lapTimes.at(-1) ?? 0)}.`
          case 'reset':
            if (running) startOrStop()
            if (elapsed() > 0) lapOrReset()
            return 'The stopwatch is back at zero.'
        }
      },
    }
  },
}

// Terminal: a small shell over terminal.ts's commands, with a history on the arrow keys.
const terminal: PanelApp = {
  id: 'terminal',
  name: 'Terminal',
  glyph: icons.terminal,
  width: 560,
  height: 340,
  resizable: true,
  build(root, body, context) {
    const output = el('div', 'term-output')
    output.setAttribute('role', 'log')
    output.setAttribute('aria-live', 'polite')
    const form = el('form', 'term-line')
    const prompt = el('span', 'term-prompt', 'guest@prism ~ %')
    const input = el('input', 'term-input')
    input.type = 'text'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('aria-label', 'Command')
    input.setAttribute('autocapitalize', 'off')
    form.append(prompt, input)
    body.append(output, form)

    const history: string[] = []
    let historyIndex = 0
    const print = (lines: readonly string[], className = '') => {
      for (const line of lines) output.append(el('div', `term-text ${className}`.trim(), line === '' ? ' ' : line))
      output.scrollTop = output.scrollHeight
    }
    print(['Prism OS Terminal. One handwired program runs the windows; this shell runs beside it.', 'Type "help" for the commands.', ''], 'term-dim')

    form.addEventListener('submit', event => {
      event.preventDefault()
      const line = input.value
      input.value = ''
      print([`guest@prism ~ % ${line}`], 'term-echo')
      if (line.trim() !== '') history.push(line)
      historyIndex = history.length
      const result = runCommand(line, {
        apps: context.apps,
        open: id => context.open(id),
        close: id => context.close(id),
        setAppearance: appearance => context.settings.update({appearance}),
        setAccent: accent => context.settings.update({accent}),
        setScene: scene => context.settings.update({scene}),
        setMotion: motion => context.settings.update({motion}),
        setArcs: arcs => context.settings.update({arcs}),
        programFacts: () => context.programFacts(),
        now: () => new Date(),
        startedAt: context.startedAt,
      })
      if (result.clear === true) output.replaceChildren()
      print(result.lines)
    })
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        historyIndex = Math.min(history.length, Math.max(0, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)))
        input.value = history[historyIndex] ?? ''
      } else if (event.key === 'l' && event.ctrlKey) {
        event.preventDefault()
        output.replaceChildren()
      }
    })
    // A press anywhere in the terminal types at the prompt, unless it selects text.
    root.addEventListener('pointerup', () => {
      if (window.getSelection()?.isCollapsed !== false) input.focus({preventScroll: true})
    })
    return {opened: () => input.focus({preventScroll: true})}
  },
}

function factsList(context: AppContext) {
  const list = el('dl', 'prism-facts')
  const fill = () => {
    const facts = context.programFacts()
    const entries = [...facts, '0 training'].map(fact => {
      const [value = '', ...words] = fact.split(' ')
      return {value, label: words.join(' ')}
    })
    list.replaceChildren(...entries.map(entry => {
      const item = el('div', 'prism-fact')
      item.append(el('dt', '', entry.label), el('dd', '', entry.value))
      return item
    }))
  }
  return {list, fill}
}

// Settings: every preference, in sections.
const settingsApp: PanelApp = {
  id: 'settings',
  name: 'Settings',
  glyph: icons.settings,
  width: 440,
  height: 520,
  resizable: true,
  build(_root, body, context) {
    const section = (title: string, ...content: HTMLElement[]) => {
      const element = el('section', 'settings-section')
      element.append(el('h3', 'settings-heading', title), ...content)
      return element
    }
    const facts = factsList(context)
    const scroller = el('div', 'settings-scroller')
    scroller.append(
      section('Appearance', appearanceControl(context.settings)),
      section('Accent color', accentControl(context.settings)),
      section('Wallpaper', sceneControl(context.settings, 'large')),
      section('Desktop', toggleControl(context.settings, 'motion', 'Wallpaper motion', icons.waves), toggleControl(context.settings, 'arcs', 'Weight arcs on the desk', icons.arcs)),
      section('The handwired program', facts.list, el('p', 'settings-note', 'Scope, Inkwell and Chroma run in one fixed numeric program, built by hand and never trained. Prism\'s own apps run beside it in plain JavaScript.')),
    )
    body.append(scroller)
    return {opened: () => facts.fill()}
  },
}

// About: what this machine is.
const about: PanelApp = {
  id: 'about',
  name: 'About Prism OS',
  glyph: icons.info,
  width: 360,
  height: 420,
  resizable: false,
  build(_root, body, context) {
    const mark = icon(icons.prism, 'about-mark')
    const facts = factsList(context)
    body.append(
      mark,
      el('h2', 'about-title', 'Prism OS'),
      el('p', 'about-subtitle', 'Liquid glass edition'),
      facts.list,
      el('p', 'about-note', 'Built on Handwired: a JavaScript program turned into matrix multiplications and ReGLUs, exact and fully differentiable.'),
    )
    return {opened: () => facts.fill()}
  },
}

export const panelApps: readonly PanelApp[] = [calculator, clock, terminal, settingsApp, about]

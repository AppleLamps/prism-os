import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {type CalculatorKey, type CalculatorState, formatNumber, initialCalculator, keyFromKeyboard, pressKey} from '../../src/prismos/calculator.ts'
import {accents, createSettingsStore, defaultSettings, parseSettings, resolveScheme, scenes, type SceneName} from '../../src/prismos/settings.ts'
import {type TerminalActions, formatDuration, runCommand} from '../../src/prismos/terminal.ts'
import {wallpaperPalette} from '../../src/prismos/wallpaper.ts'

function type(keys: readonly CalculatorKey[], from: CalculatorState = initialCalculator) {
  return keys.reduce(pressKey, from)
}

test('the calculator works left to right, as a pocket calculator does', () => {
  assert.equal(type(['2', '+', '3', '×', '4', '=']).display, '20')
  assert.equal(type(['1', '2', '+', '3', '0', '×', '2', '=']).display, '84')
  assert.equal(type(['9', '-', '1', '2', '=']).display, '-3')
})

test('a second operator replaces the first, and = repeats the last operation', () => {
  assert.equal(type(['8', '+', '×', '3', '=']).display, '24')
  assert.equal(type(['2', '+', '3', '=', '=']).display, '8')
  assert.equal(type(['2', '+', '3', '=', '=', '=']).display, '11')
})

test('the calculator hides floating point noise and caps the digits it takes', () => {
  assert.equal(type(['.', '1', '+', '.', '2', '=']).display, '0.3')
  assert.equal(type(['1', '÷', '3', '=']).display, '0.333333333333')
  assert.equal(type(Array.from({length: 20}, () => '9' as const)).display, '999999999999')
  assert.equal(formatNumber(1e15), '1e15')
  assert.equal(formatNumber(2.5e-12), '2.5e-12')
})

test('the calculator\'s editing keys: sign, percent, point, backspace and clear', () => {
  assert.equal(type(['5', 'sign']).display, '-5')
  assert.equal(type(['5', 'sign', 'sign']).display, '5')
  assert.equal(type(['5', '0', 'percent']).display, '0.5')
  assert.equal(type(['1', '.', '.', '5']).display, '1.5')
  assert.equal(type(['1', '2', '3', 'backspace']).display, '12')
  assert.equal(type(['7', 'backspace']).display, '0')
  assert.deepEqual(type(['7', '+', '2', 'clear']), initialCalculator)
})

test('dividing by zero shows Error, and the next key starts over', () => {
  const error = type(['4', '÷', '0', '='])
  assert.equal(error.display, 'Error')
  assert.equal(pressKey(error, '6').display, '6')
})

test('the keyboard maps onto the calculator\'s keys', () => {
  assert.equal(keyFromKeyboard('7'), '7')
  assert.equal(keyFromKeyboard('*'), '×')
  assert.equal(keyFromKeyboard('/'), '÷')
  assert.equal(keyFromKeyboard('Enter'), '=')
  assert.equal(keyFromKeyboard('Escape'), 'clear')
  assert.equal(keyFromKeyboard('q'), null)
})

test('stored settings load whole, and each damaged value falls back to its default', () => {
  assert.deepEqual(parseSettings(null), defaultSettings)
  assert.deepEqual(parseSettings('not json'), defaultSettings)
  assert.deepEqual(parseSettings('[1, 2]').accent, defaultSettings.accent)
  assert.deepEqual(
    parseSettings(JSON.stringify({appearance: 'dark', accent: 'teal', scene: 'ember', motion: false, arcs: false})),
    {appearance: 'dark', accent: 'teal', scene: 'ember', motion: false, arcs: false},
  )
  assert.deepEqual(
    parseSettings(JSON.stringify({appearance: 'sepia', accent: 'purple', scene: 'nebula', motion: 'yes', arcs: 1})),
    defaultSettings,
  )
})

test('the settings store saves each change and tells its listeners', () => {
  const saved = new Map<string, string>()
  const storage = {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value)} as unknown as Storage
  const store = createSettingsStore(storage)
  const seen: string[] = []
  store.subscribe(settings => seen.push(settings.scene))
  store.update({scene: 'lagoon'})
  assert.deepEqual(seen, ['lagoon'])
  assert.equal(createSettingsStore(storage).get().scene, 'lagoon')
  // A storage that throws, e.g. in a private window, leaves the defaults and the session's changes.
  const broken = {getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }} as unknown as Storage
  const fallback = createSettingsStore(broken)
  fallback.update({accent: 'green'})
  assert.equal(fallback.get().accent, 'green')
})

test('Auto follows the system\'s scheme, and Light and Dark ignore it', () => {
  assert.equal(resolveScheme('auto', true), 'dark')
  assert.equal(resolveScheme('auto', false), 'light')
  assert.equal(resolveScheme('light', true), 'light')
  assert.equal(resolveScheme('dark', false), 'dark')
})

// Purple and violet are the hues from about 255 to 330 degrees.
function isPurple(hue: number) {
  const normalized = ((hue % 360) + 360) % 360
  return normalized >= 255 && normalized <= 330
}

function hexHue(hex: string) {
  const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return null
  const delta = max - min
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return hue * 60
}

test('no wallpaper and no accent is purple', () => {
  for (const scene of Object.keys(scenes) as SceneName[]) {
    for (const scheme of ['light', 'dark'] as const) {
      const palette = wallpaperPalette(scene, scheme)
      const colors = [...palette.sky, palette.sun, ...palette.dunes.flatMap(dune => [dune.top, dune.bottom, dune.rim])]
      for (const color of colors) {
        const hue = Number(/^hsl\((-?[\d.]+)/.exec(color)?.[1])
        assert.ok(Number.isFinite(hue) && !isPurple(hue), `${scene} ${scheme}: ${color}`)
      }
    }
  }
  for (const [name, accent] of Object.entries(accents)) {
    const hue = hexHue(accent.color)
    assert.ok(hue === null || !isPurple(hue), `${name}: ${accent.color}`)
  }
})

function actions(log: string[]): TerminalActions {
  return {
    apps: [{id: 'scope', name: 'Scope', kind: 'program'}, {id: 'clock', name: 'Clock', kind: 'panel'}],
    open: id => log.push(`open ${id}`),
    close: id => {
      log.push(`close ${id}`)
      return true
    },
    setAppearance: value => log.push(`appearance ${value}`),
    setAccent: value => log.push(`accent ${value}`),
    setScene: value => log.push(`scene ${value}`),
    setMotion: value => log.push(`motion ${value}`),
    setArcs: value => log.push(`arcs ${value}`),
    programFacts: () => ['130 layers', '9,909 weights'],
    now: () => new Date(Date.UTC(2026, 9, 15, 12, 1, 5)),
    startedAt: new Date(Date.UTC(2026, 9, 15, 12, 0, 0)),
  }
}

test('Terminal runs its commands through the shell\'s actions', () => {
  const log: string[] = []
  const shell = actions(log)
  assert.deepEqual(runCommand('open SCOPE', shell).lines, ['Opened Scope.'])
  assert.deepEqual(runCommand('close clock', shell).lines, ['Closed Clock.'])
  assert.match(runCommand('close scope', shell).lines[0] ?? '', /program window/)
  runCommand('theme dark', shell)
  runCommand('accent teal', shell)
  runCommand('wallpaper ember', shell)
  runCommand('motion off', shell)
  runCommand('arcs on', shell)
  assert.deepEqual(log, ['open scope', 'close clock', 'appearance dark', 'accent teal', 'scene ember', 'motion false', 'arcs true'])
})

test('Terminal rejects what it doesn\'t know, and reports the program and the uptime', () => {
  const shell = actions([])
  assert.deepEqual(runCommand('accent purple', shell).lines, [`usage: accent ${Object.keys(accents).join('|')}`])
  assert.deepEqual(runCommand('frobnicate', shell).lines, ['frobnicate: command not found. Try: help'])
  assert.deepEqual(runCommand('   ', shell).lines, [])
  assert.equal(runCommand('clear', shell).clear, true)
  assert.deepEqual(runCommand('stats', shell).lines, ['One handwired program runs the windows:', '  130 layers', '  9,909 weights', '  0 training'])
  assert.deepEqual(runCommand('uptime', shell).lines, ['up 1m 5s'])
  assert.equal(formatDuration(3_725_000), '1h 2m 5s')
})

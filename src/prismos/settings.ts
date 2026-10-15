// Prism OS's preferences: the appearance, the accent, the wallpaper's scene, and two
// switches for the desk. They live in localStorage, which can be missing or throw, e.g.
// in a private window, so every read and write is guarded and a missing or damaged entry
// falls back to the defaults.

export type Appearance = 'auto' | 'light' | 'dark'
export type AccentName = 'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'graphite'
export type SceneName = 'dunes' | 'lagoon' | 'ember' | 'graphite'

export type Settings = {
  appearance: Appearance
  accent: AccentName
  scene: SceneName
  // Whether the wallpaper drifts, and whether the program's weight arcs show on the desk.
  motion: boolean
  arcs: boolean
}

export const appearances: readonly Appearance[] = ['auto', 'light', 'dark']

// The system accents, without purple: the macOS colors from blue to graphite.
export const accents: Readonly<Record<AccentName, {label: string, color: string}>> = {
  blue: {label: 'Blue', color: '#007aff'},
  teal: {label: 'Teal', color: '#0fa5b8'},
  green: {label: 'Green', color: '#28a745'},
  yellow: {label: 'Yellow', color: '#e0a100'},
  orange: {label: 'Orange', color: '#f57c00'},
  red: {label: 'Red', color: '#e5383b'},
  graphite: {label: 'Graphite', color: '#7d7d85'},
}

export const scenes: Readonly<Record<SceneName, {label: string}>> = {
  dunes: {label: 'Dunes'},
  lagoon: {label: 'Lagoon'},
  ember: {label: 'Ember'},
  graphite: {label: 'Graphite'},
}

export const defaultSettings: Settings = {
  appearance: 'auto',
  accent: 'blue',
  scene: 'dunes',
  motion: true,
  arcs: true,
}

const storageKey = 'prism-os.settings'

function isKeyOf<T extends object>(record: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.hasOwn(record, key)
}

// The settings in a stored entry, each one checked: a value that isn't one of its kind's
// keeps the default, so an entry from an older or a newer page still loads.
export function parseSettings(text: string | null): Settings {
  if (text === null) return {...defaultSettings}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {...defaultSettings}
  }
  if (typeof value !== 'object' || value === null) return {...defaultSettings}
  const entry = value as Record<string, unknown>
  const appearance = entry['appearance']
  const accent = entry['accent']
  const scene = entry['scene']
  const motion = entry['motion']
  const arcs = entry['arcs']
  return {
    appearance: typeof appearance === 'string' && (appearances as readonly string[]).includes(appearance) ? appearance as Appearance : defaultSettings.appearance,
    accent: isKeyOf(accents, accent) ? accent : defaultSettings.accent,
    scene: isKeyOf(scenes, scene) ? scene : defaultSettings.scene,
    motion: typeof motion === 'boolean' ? motion : defaultSettings.motion,
    arcs: typeof arcs === 'boolean' ? arcs : defaultSettings.arcs,
  }
}

export type SettingsStore = {
  get(): Settings
  update(change: Partial<Settings>): void
  subscribe(listener: (settings: Settings) => void): void
}

export function createSettingsStore(storage: Storage | null): SettingsStore {
  let stored: string | null = null
  try {
    stored = storage?.getItem(storageKey) ?? null
  } catch {
    stored = null
  }
  let settings = parseSettings(stored)
  const listeners: ((settings: Settings) => void)[] = []
  return {
    get: () => settings,
    update(change) {
      settings = {...settings, ...change}
      try {
        storage?.setItem(storageKey, JSON.stringify(settings))
      } catch {
        // The preferences then last until the page closes.
      }
      for (const listener of listeners) listener(settings)
    },
    subscribe(listener) {
      listeners.push(listener)
    },
  }
}

// The scheme that an appearance shows, given whether the system prefers dark.
export function resolveScheme(appearance: Appearance, systemPrefersDark: boolean): 'light' | 'dark' {
  if (appearance === 'auto') return systemPrefersDark ? 'dark' : 'light'
  return appearance
}

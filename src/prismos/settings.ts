// Prism OS's settings: the theme, the accent color, the wallpaper's motion, the glass's
// transparency and the weight arcs behind the windows. They are the page's own state,
// outside the handwired program: each one is a data attribute on <html> that
// prism-os.css reads, and the wallpaper reads the theme and the motion. They persist in
// localStorage, which can be missing or throw, e.g. in a private window, so every read and
// write is guarded and the defaults apply without it.
import type {accents, arcVisibilities, themes, transparencyLevels, wallpaperModes} from './commands.ts'

export type Settings = {
  theme: (typeof themes)[number]
  accent: (typeof accents)[number]
  wallpaper: (typeof wallpaperModes)[number]
  transparency: (typeof transparencyLevels)[number]
  arcs: (typeof arcVisibilities)[number]
}

export const defaultSettings: Settings = {
  theme: 'system',
  accent: 'blue',
  wallpaper: 'animated',
  transparency: 'normal',
  arcs: 'shown',
}

const storageKey = 'prism-os.settings'

export function loadSettings(storage: Pick<Storage, 'getItem'> | null): Settings {
  try {
    const stored = storage?.getItem(storageKey)
    if (stored == null) return {...defaultSettings}
    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null) return {...defaultSettings}
    const record = parsed as Record<string, unknown>
    const pick = <Key extends keyof Settings>(key: Key, allowed: readonly Settings[Key][]): Settings[Key] =>
      allowed.includes(record[key] as Settings[Key]) ? record[key] as Settings[Key] : defaultSettings[key]
    return {
      theme: pick('theme', ['light', 'dark', 'system']),
      accent: pick('accent', ['blue', 'teal', 'green', 'sand', 'graphite']),
      wallpaper: pick('wallpaper', ['animated', 'still']),
      transparency: pick('transparency', ['normal', 'reduced']),
      arcs: pick('arcs', ['shown', 'hidden']),
    }
  } catch {
    return {...defaultSettings}
  }
}

export function saveSettings(storage: Pick<Storage, 'setItem'> | null, settings: Settings) {
  try {
    storage?.setItem(storageKey, JSON.stringify(settings))
  } catch {
    // Nothing to do: the setting still applies for this visit.
  }
}

// Writes the settings as data attributes, which prism-os.css reads. "system" removes the
// theme attribute, so the stylesheet's prefers-color-scheme rules decide.
export function applySettings(root: HTMLElement, settings: Settings) {
  if (settings.theme === 'system') delete root.dataset['theme']
  else root.dataset['theme'] = settings.theme
  root.dataset['accent'] = settings.accent
  root.dataset['wallpaper'] = settings.wallpaper
  root.dataset['transparency'] = settings.transparency
  root.dataset['arcs'] = settings.arcs
}

export type SettingsStore = {
  get(): Settings
  set(patch: Partial<Settings>): Settings
  // Whether the page draws in its dark scheme now, from the theme setting or, under
  // "system", from the device.
  isDark(): boolean
  subscribe(listener: (settings: Settings) => void): () => void
}

export function createSettingsStore(window: Window, root: HTMLElement): SettingsStore {
  const storage = (() => {
    try {
      return window.localStorage
    } catch {
      return null
    }
  })()
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
  let settings = loadSettings(storage)
  const listeners = new Set<(settings: Settings) => void>()
  applySettings(root, settings)
  const notify = () => {
    for (const listener of listeners) listener(settings)
  }
  darkScheme.addEventListener('change', () => {
    if (settings.theme === 'system') notify()
  })
  return {
    get: () => settings,
    set(patch) {
      settings = {...settings, ...patch}
      applySettings(root, settings)
      saveSettings(storage, settings)
      notify()
      return settings
    },
    isDark: () => settings.theme === 'dark' || (settings.theme === 'system' && darkScheme.matches),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

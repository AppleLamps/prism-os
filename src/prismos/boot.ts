import {mountWindowManager} from '../handwiredos/window-manager.ts'
import {arrangePrismWindows} from './arrangement.ts'
import {type Settings, accents, createSettingsStore, resolveScheme} from './settings.ts'
import {startShell} from './shell.ts'
import {startWallpaper} from './wallpaper.ts'

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const root = document.documentElement
  const store = createSettingsStore(localStorageOrNull())
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
  const scheme = () => resolveScheme(store.get().appearance, systemDark.matches)

  // The preferences that CSS reads from the root element: the scheme, the accent (blue is
  // the stylesheet's own, a brighter blue in the dark scheme), and whether the arcs show.
  const applyToPage = (settings: Settings) => {
    root.dataset['theme'] = scheme()
    if (settings.accent === 'blue') root.style.removeProperty('--accent')
    else root.style.setProperty('--accent', accents[settings.accent].color)
    root.dataset['arcs'] = settings.arcs ? 'on' : 'off'
  }
  applyToPage(store.get())

  const canvas = document.querySelector<HTMLCanvasElement>('.desk-wallpaper')
  const wallpaper = canvas === null ? null : startWallpaper(canvas, {scene: store.get().scene, scheme: scheme(), motion: store.get().motion})
  store.subscribe(settings => {
    applyToPage(settings)
    wallpaper?.set({scene: settings.scene, scheme: scheme(), motion: settings.motion})
  })
  // A change of the system's scheme reaches the page while the appearance is Auto. An
  // empty update tells every control to redraw, e.g. the wallpaper previews.
  systemDark.addEventListener('change', () => store.update({}))

  // The shell listens for input before the program does, see shell.ts.
  startShell(store)
  mountWindowManager(document, window, {arrange: arrangePrismWindows})
}

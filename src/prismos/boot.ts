import {mountWindowManager, quantizeViewport} from '../handwiredos/window-manager.ts'
import {arrangePrismWindows} from './arrangement.ts'
import {createSlideshow, mountCommandCenter} from './command-center.ts'
import {createOperator, slideshowIntervalMs} from './operator.ts'
import {createSettingsStore} from './settings.ts'
import {startWallpaper} from './wallpaper.ts'

const noteKey = 'prism-os.note'

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const root = document.documentElement
  const settings = createSettingsStore(window, root)

  const wallpaperCanvas = document.querySelector<HTMLCanvasElement>('.desk-wallpaper')
  const wallpaper = wallpaperCanvas === null ? null : startWallpaper(wallpaperCanvas, {
    isDark: () => settings.isDark(),
    isStill: () => settings.get().wallpaper === 'still',
  })
  settings.subscribe(() => wallpaper?.refresh())

  // Inkwell's note is saved in this browser as it's typed, and comes back on the next
  // visit. Before the mount, so the window manager starts with the saved text.
  const note = document.querySelector<HTMLTextAreaElement>('.notes-text')
  const storage = (() => {
    try {
      return window.localStorage
    } catch {
      return null
    }
  })()
  const saveNote = () => {
    try {
      if (note !== null) storage?.setItem(noteKey, note.value)
    } catch {
      // The note still works for this visit.
    }
  }
  try {
    const saved = storage?.getItem(noteKey)
    if (note !== null && saved != null) note.value = saved
  } catch {
    // The starting note stays.
  }
  note?.addEventListener('input', saveNote)

  const manager = mountWindowManager(document, window, {arrange: arrangePrismWindows})
  const viewport = () => ({
    width: quantizeViewport(document.documentElement.clientWidth),
    height: quantizeViewport(document.documentElement.clientHeight),
  })

  let operator: ReturnType<typeof createOperator> | null = null
  const slideshow = createSlideshow(window, () => operator?.nextPhoto() ?? Promise.resolve(), slideshowIntervalMs)
  // A person's own press or Escape ends the slideshow.
  window.addEventListener('pointerdown', () => slideshow.stop())
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') slideshow.stop()
  })

  operator = createOperator(
    {machine: manager.machine, viewport, now: () => window.performance.now(), frame: () => manager.nextFrame()},
    {
      settings: {get: () => settings.get(), set: patch => settings.set(patch)},
      note: {
        read: () => note?.value ?? '',
        write: text => {
          if (note === null) return
          note.value = text
          saveNote()
        },
      },
      navigate: link => {
        window.location.href = link === 'demos' ? '../' : 'https://github.com/AppleLamps/prism-os'
      },
      slideshow,
      homeRectangles: () => {
        const {width, height} = viewport()
        return arrangePrismWindows(manager.machine.source.slice(), manager.machine.cells, width, height)
      },
    },
  )

  mountCommandCenter(document, window, operator, new URL('./model-worker.js', document.baseURI).href)
}

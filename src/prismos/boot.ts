import {Cabinet, message} from './cabinet.ts'
import {CabinetGallery} from './cabinet-gallery.ts'
import {button, el} from './dom.ts'
import {mountWindowManager, quantizeViewport} from '../handwiredos/window-manager.ts'
import {arrangePrismWindows} from './arrangement.ts'
import {createCommandCenter, createSlideshow} from './command-center.ts'
import {createOperator, slideshowIntervalMs} from './operator.ts'
import {type Settings, accents, createSettingsStore, resolveScheme} from './settings.ts'
import {startShell} from './shell.ts'
import {startWallpaper} from './wallpaper.ts'

const noteKey = 'prism-os.note'

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const root = document.documentElement
  const storage = localStorageOrNull()
  const store = createSettingsStore(storage)
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

  // Inkwell's note is saved in this browser as it's typed, and comes back on the next
  // visit. Before the mount, so the window manager starts with the saved text.
  const note = document.querySelector<HTMLTextAreaElement>('.notes-text')
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
  const cabinet = note === null ? undefined : new Cabinet(note)
  note?.addEventListener('input', () => {
    cabinet?.edit(note.value)
    if (!cabinet?.documents) saveNote()
  })
  if (cabinet && note) {
    const bar = el('div', 'inkwell-files'); bar.dataset['prismLayer'] = ''
    const name = el('span'), status = el('span')
    status.setAttribute('role', 'status')
    const saveAs = button('', 'Save As', 'Save As')
    saveAs.addEventListener('click', () => { void cabinet.saveAs().catch(error => { status.textContent = message(error) }) })
    bar.append(name, status, saveAs); note.parentElement?.append(bar)
    cabinet.subscribe(() => {
      name.textContent = cabinet.documents?.entry?.name ?? 'Notes'
      status.textContent = cabinet.documents?.status ?? cabinet.error
      saveAs.disabled = cabinet.documents === null
    })
    window.addEventListener('beforeunload', event => {
      if (cabinet.documents?.dirty === true) { void cabinet.flush().catch(() => {}); event.preventDefault(); event.returnValue = '' }
    })
  }

  // The shell listens for input before the program does, see shell.ts. Spotlight runs
  // sentences through the command center, see command-center.ts.
  const commands = createCommandCenter(window, new URL('./model-worker.js', document.baseURI).href)
  const panels = startShell(store, commands, cabinet)
  const manager = mountWindowManager(document, window, {arrange: arrangePrismWindows})

  const gallery = new CabinetGallery(manager, text => console.warn(text))
  if (panels !== null) {
    const viewport = () => ({
      width: quantizeViewport(document.documentElement.clientWidth),
      height: quantizeViewport(document.documentElement.clientHeight),
    })
    let nextPhoto: () => Promise<unknown> = () => Promise.resolve()
    const slideshow = createSlideshow(window, () => nextPhoto(), slideshowIntervalMs)
    // A person's own press or Escape ends the slideshow.
    window.addEventListener('pointerdown', () => slideshow.stop(), true)
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') slideshow.stop()
    }, true)
    const operator = createOperator(
      {machine: manager.machine, viewport, now: () => window.performance.now(), frame: () => manager.nextFrame()},
      {
        cabinet,
        gallery,
        settings: store,
        panels,
        note: {
          read: () => note?.value ?? '',
          write: text => {
            if (note === null) return
            note.value = text
            if (cabinet?.documents) cabinet.edit(text)
            else saveNote()
          },
        },
        slideshow,
        homeRectangles: () => {
          const {width, height} = viewport()
          return arrangePrismWindows(manager.machine.source.slice(), manager.machine.cells, width, height)
        },
      },
    )
    cabinet?.connect(async app => { if (app === 'cabinet') panels.open('cabinet'); else await operator.focusProgram(app) }, gallery)
    let blockedClose = false
    window.addEventListener('pointerdown', event => {
      if (cabinet?.documents?.dirty !== true || !(event.target instanceof Element)) return
      const close = event.target.closest('.window-button.close')
      if (!close?.closest('.window')?.querySelector('.notes-text')) return
      event.preventDefault(); event.stopImmediatePropagation(); blockedClose = true
      void cabinet.resolveDraft().then(ok => { if (ok) void operator.run({name: 'close_app', app: 'inkwell'}) })
    }, true)
    window.addEventListener('pointerup', event => { if (blockedClose) { blockedClose = false; event.preventDefault(); event.stopImmediatePropagation() } }, true)
    nextPhoto = () => operator.nextPhoto()
    commands.setOperator(operator)
  }
}

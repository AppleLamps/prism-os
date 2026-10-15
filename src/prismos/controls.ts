// The controls for Prism OS's preferences, which Control Center and the Settings app
// both show: each one reads the store and redraws itself when the store changes.
import {button, el, icon, icons} from './dom.ts'
import {type AccentName, type SceneName, type Settings, type SettingsStore, accents, scenes} from './settings.ts'
import {wallpaperPalette} from './wallpaper.ts'

// The scheme the page shows now, which boot.ts writes on the root element.
export function currentScheme(): 'light' | 'dark' {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light'
}

// A scene in small: the sky's stops, then a band for each dune's top, back to front.
export function sceneGradient(scene: SceneName, scheme: 'light' | 'dark'): string {
  const palette = wallpaperPalette(scene, scheme)
  const [back, middle, sand, front] = palette.dunes
  return `linear-gradient(180deg, ${palette.sky[0]} 0%, ${palette.sky[1]} 32%, ${palette.sky[2]} 48%, `
    + `${back?.top ?? palette.sky[2]} 48% 60%, ${middle?.top ?? palette.sky[2]} 60% 72%, `
    + `${sand?.top ?? palette.sky[2]} 72% 84%, ${front?.top ?? palette.sky[2]} 84% 100%)`
}

function watch(store: SettingsStore, update: (settings: Settings) => void) {
  update(store.get())
  store.subscribe(update)
}

export function appearanceControl(store: SettingsStore): HTMLElement {
  const group = el('div', 'prism-segmented')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', 'Appearance')
  const options = [
    {value: 'auto', label: 'Auto', glyph: icons.auto},
    {value: 'light', label: 'Light', glyph: icons.sun},
    {value: 'dark', label: 'Dark', glyph: icons.moon},
  ] as const
  const buttons = options.map(option => {
    const choice = button('prism-segment', option.label, option.label)
    choice.setAttribute('role', 'radio')
    choice.prepend(icon(option.glyph))
    choice.dataset['glassLight'] = ''
    choice.addEventListener('click', () => store.update({appearance: option.value}))
    group.append(choice)
    return choice
  })
  watch(store, settings => {
    options.forEach((option, index) => buttons[index]?.setAttribute('aria-checked', `${settings.appearance === option.value}`))
  })
  return group
}

export function accentControl(store: SettingsStore): HTMLElement {
  const group = el('div', 'prism-swatches')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', 'Accent color')
  const names = Object.keys(accents) as AccentName[]
  const swatches = names.map(name => {
    const swatch = button('prism-swatch', accents[name].label)
    swatch.setAttribute('role', 'radio')
    swatch.title = accents[name].label
    swatch.style.setProperty('--swatch', accents[name].color)
    swatch.addEventListener('click', () => store.update({accent: name}))
    group.append(swatch)
    return swatch
  })
  watch(store, settings => {
    names.forEach((name, index) => swatches[index]?.setAttribute('aria-checked', `${settings.accent === name}`))
  })
  return group
}

export function sceneControl(store: SettingsStore, size: 'small' | 'large'): HTMLElement {
  const group = el('div', `prism-scenes prism-scenes-${size}`)
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', 'Wallpaper')
  const names = Object.keys(scenes) as SceneName[]
  const choices = names.map(name => {
    const choice = button('prism-scene', scenes[name].label)
    choice.setAttribute('role', 'radio')
    choice.title = scenes[name].label
    const preview = el('span', 'prism-scene-preview')
    choice.append(preview)
    if (size === 'large') choice.append(el('span', 'prism-scene-label', scenes[name].label))
    choice.addEventListener('click', () => store.update({scene: name}))
    group.append(choice)
    return {choice, preview}
  })
  watch(store, settings => {
    const scheme = currentScheme()
    names.forEach((name, index) => {
      const entry = choices[index]
      if (entry === undefined) return
      entry.choice.setAttribute('aria-checked', `${settings.scene === name}`)
      entry.preview.style.background = sceneGradient(name, scheme)
    })
  })
  return group
}

export function toggleControl(store: SettingsStore, key: 'motion' | 'arcs', label: string, glyph: string): HTMLElement {
  const row = button('prism-toggle', label)
  row.setAttribute('role', 'switch')
  row.append(icon(glyph), el('span', 'prism-toggle-label', label), el('span', 'prism-switch'))
  row.addEventListener('click', () => store.update({[key]: !store.get()[key]}))
  watch(store, settings => row.setAttribute('aria-checked', `${settings[key]}`))
  return row
}

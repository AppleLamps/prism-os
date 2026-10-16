// Browser: web pages in a sandboxed iframe, with an address bar, back, forward and reload,
// and a page of favorites. See web-address.ts for what the address bar does with what's
// typed, and for the sites that refuse to be shown inside another site.
//
// The frame's pages come from other sites, so the page can't read their addresses or
// their history. Back and forward step through the pages Browser opened, from the address
// bar, a favorite or Spotlight, and the address bar shows the last of those. A link
// followed inside the page moves the page and not the address bar.
//
// The sandbox lets a page run its scripts, keep its own cookies and open links in new
// tabs, and never lets it navigate Prism OS itself: without allow-top-navigation, nothing
// in the frame can leave the desktop.
import type {PanelApp} from './apps.ts'
import {button, el, icon, icons} from './dom.ts'
import {addressFor, type Framing, framingFor, pageName, searchEngine} from './web-address.ts'

const sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const permissions = 'fullscreen; picture-in-picture; autoplay; encrypted-media; clipboard-write'

// Sites that let Browser show them, each checked in a frame.
const favorites = [
  {name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page', mark: 'W', tone: 'graphite'},
  {name: 'Wiktionary', url: 'https://en.wiktionary.org/wiki/Wiktionary:Main_Page', mark: 'Wt', tone: 'teal'},
  {name: 'Internet Archive', url: 'https://archive.org/', mark: 'IA', tone: 'sand'},
  {name: 'Project Gutenberg', url: 'https://www.gutenberg.org/', mark: 'PG', tone: 'orange'},
  {name: 'xkcd', url: 'https://xkcd.com/', mark: 'x', tone: 'blue'},
  {name: searchEngine.name, url: 'https://www.bing.com/', mark: 'b', tone: 'green'},
] as const

export const browserApp: PanelApp = {
  id: 'browser',
  name: 'Browser',
  glyph: icons.browser,
  width: 960,
  height: 640,
  resizable: true,
  build(_root, body) {
    const toolbar = el('div', 'browser-toolbar')
    const backButton = button('browser-tool', 'Back')
    backButton.append(icon(icons.back))
    const forwardButton = button('browser-tool', 'Forward')
    forwardButton.append(icon(icons.forward))
    const reloadButton = button('browser-tool', 'Reload')
    reloadButton.append(icon(icons.reload))
    const form = el('form', 'browser-address')
    form.setAttribute('role', 'search')
    const address = el('input', 'browser-input')
    address.type = 'text'
    address.inputMode = 'url'
    address.enterKeyHint = 'go'
    address.autocomplete = 'off'
    address.spellcheck = false
    address.placeholder = `Search ${searchEngine.name} or enter a website`
    address.setAttribute('aria-label', 'Address')
    address.setAttribute('autocapitalize', 'off')
    form.append(icon(icons.search), address)
    const newTabButton = button('browser-tool', 'Open in New Tab')
    newTabButton.append(icon(icons.external))
    for (const tool of [backButton, forwardButton, reloadButton, newTabButton]) tool.dataset['glassLight'] = ''
    toolbar.append(backButton, forwardButton, reloadButton, form, newTabButton)

    const view = el('div', 'browser-view')
    const progress = el('div', 'browser-progress')
    progress.hidden = true
    // The frame is made the first time a page shows, so a desktop that never browses never
    // has one.
    let frame: HTMLIFrameElement | null = null
    const makeFrame = () => {
      const made = el('iframe', 'browser-frame')
      made.title = 'Web page'
      made.setAttribute('sandbox', sandbox)
      made.allow = permissions
      made.referrerPolicy = 'strict-origin-when-cross-origin'
      made.addEventListener('load', () => {
        if (loading) setLoading(false)
      })
      progress.after(made)
      return made
    }

    const start = el('div', 'browser-start')
    const grid = el('ul', 'browser-favorites')
    for (const favorite of favorites) {
      const item = el('li')
      const tile = button('browser-favorite', favorite.name)
      tile.append(el('span', `browser-mark browser-tone-${favorite.tone}`, favorite.mark), el('span', 'browser-favorite-name', favorite.name))
      tile.addEventListener('click', () => go(favorite.url))
      item.append(tile)
      grid.append(item)
    }
    start.append(
      el('h2', 'browser-heading', 'Favorites'),
      grid,
      el('p', 'browser-note', 'Pages open right here, on the desktop. Some sites, like Google, YouTube and GitHub, don\'t let other sites show them; Browser opens those in a new tab instead.'),
    )

    const refused = el('div', 'browser-refused')
    refused.hidden = true
    const refusedTitle = el('h2', 'browser-heading')
    const refusedText = el('p', 'browser-note')
    const refusedOpen = button('prism-button browser-open', 'Open in New Tab', 'Open in New Tab')
    refused.append(icon(icons.browser, 'browser-refused-mark'), refusedTitle, refusedText, refusedOpen)

    view.append(progress, start, refused)
    body.append(toolbar, view)

    // The pages Browser opened, oldest first, and the one it shows. null is Favorites.
    let entries: (string | null)[] = [null]
    let index = 0
    const current = () => entries[index] ?? null

    // The frame never adds to the desktop's own history: Browser moves it with
    // location.replace, which the page allows from outside for any origin.
    const load = (target: HTMLIFrameElement, url: string) => {
      try {
        if (target.contentWindow === null) throw new Error('no window')
        target.contentWindow.location.replace(url)
      } catch {
        target.src = url
      }
    }
    let loading = false
    const setLoading = (next: boolean) => {
      loading = next
      progress.hidden = !next
    }
    const unload = () => {
      setLoading(false)
      if (frame === null || frame.hidden === true) return
      load(frame, 'about:blank')
      frame.hidden = true
    }

    const show = (): Framing | null => {
      const url = current()
      backButton.disabled = index === 0
      forwardButton.disabled = index === entries.length - 1
      reloadButton.disabled = url === null
      newTabButton.disabled = url === null
      address.value = url ?? ''
      start.hidden = url !== null
      if (url === null) {
        refused.hidden = true
        unload()
        return null
      }
      const framing = framingFor(url, location.origin)
      refused.hidden = framing.kind === 'frame'
      if (framing.kind === 'refused') {
        refusedTitle.textContent = `${framing.site} can't open here`
        refusedText.textContent = `${framing.site} doesn't let other sites show its pages, so ${pageName(url)} can't appear inside Prism OS. It can open in a new tab.`
      } else if (framing.kind === 'self') {
        refusedTitle.textContent = 'Prism OS is already open'
        refusedText.textContent = 'Browser doesn\'t show Prism OS inside itself. It can open in a new tab.'
      }
      if (framing.kind !== 'frame') {
        unload()
        return framing
      }
      frame ??= makeFrame()
      frame.hidden = false
      setLoading(true)
      load(frame, framing.url)
      return framing
    }

    const go = (url: string): Framing => {
      if (url !== current()) {
        entries = [...entries.slice(0, index + 1), url]
        index = entries.length - 1
      }
      return show() ?? framingFor(url, location.origin)
    }

    const openInNewTab = () => {
      const url = current()
      if (url !== null) window.open(url, '_blank', 'noopener,noreferrer')
    }

    form.addEventListener('submit', event => {
      event.preventDefault()
      const url = addressFor(address.value)
      if (url === null) return
      address.blur()
      go(url)
    })
    address.addEventListener('focus', () => address.select())
    address.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      address.value = current() ?? ''
      address.select()
    })
    backButton.addEventListener('click', () => {
      if (index === 0) return
      index--
      show()
    })
    forwardButton.addEventListener('click', () => {
      if (index === entries.length - 1) return
      index++
      show()
    })
    reloadButton.addEventListener('click', () => void show())
    newTabButton.addEventListener('click', openInNewTab)
    refusedOpen.addEventListener('click', openInNewTab)

    // While a press is held anywhere on the desktop, the frame takes no pointer events, so
    // a drag that passes over it, of a panel or of the program's windows, keeps reaching
    // the page: a frame swallows the moves and the release over it. The capture phase
    // runs before the shell and the program stop or take the press.
    const hold = (held: boolean) => (event: PointerEvent) => {
      if (event.isPrimary) view.classList.toggle('browser-held', held)
    }
    window.addEventListener('pointerdown', hold(true), true)
    window.addEventListener('pointerup', hold(false), true)
    window.addEventListener('pointercancel', hold(false), true)

    show()
    return {
      opened() {
        if (current() === null) address.focus({preventScroll: true})
      },
      // A minimized Browser keeps its page, which the browser stops painting while the
      // panel is hidden. A closed Browser forgets its pages and unloads the frame.
      closed() {
        entries = [null]
        index = 0
        show()
      },
      browse: go,
    }
  },
}

// Small helpers for the elements that Prism OS's own apps build.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className !== '') element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

export function button(className: string, label: string, text?: string): HTMLButtonElement {
  const element = el('button', className, text)
  element.type = 'button'
  if (text === undefined || text !== label) element.setAttribute('aria-label', label)
  return element
}

// An icon from constant SVG markup, drawn in currentColor on a 24 px grid.
export function icon(paths: string, className = 'prism-icon'): HTMLSpanElement {
  const element = el('span', className)
  element.setAttribute('aria-hidden', 'true')
  element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  return element
}

export const icons = {
  cabinet: '<path d="M3 7h7l2 2h9v10H3zM3 7V5h7l2 2h9v2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  controls: '<rect x="3" y="4" width="18" height="7" rx="3.5"/><circle cx="16.5" cy="7.5" r="1.75" fill="currentColor" stroke="none"/><rect x="3" y="13" width="18" height="7" rx="3.5"/><circle cx="7.5" cy="16.5" r="1.75" fill="currentColor" stroke="none"/>',
  calculator: '<rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="M8.5 7.5h7M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01" stroke-width="2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M7.5 10l2.5 2-2.5 2M12.5 15h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01" stroke-width="2"/>',
  prism: '<g stroke-width="1.9"><path d="M9.81 6.06l4.38-2.81 7.19 13.13L17 20.75z" fill="currentColor" opacity="0.5"/><path d="M2.63 20.75L9.81 6.06 17 20.75z" fill="currentColor"/></g>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  waves: '<path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0"/>',
  arcs: '<path d="M4 18a8 8 0 0 1 16 0M8 18a4 4 0 0 1 8 0"/>',
  app: '<rect x="4" y="4" width="16" height="16" rx="4"/>',
  scope: '<rect x="3.5" y="5" width="17" height="12" rx="2.5"/><path d="M6.5 11h2.5l1.5-3 3 6 1.5-3h2.5M9.5 20.5h5"/>',
  inkwell: '<path d="M6.5 8.5h11M6.5 12.5h11M6.5 16.5h7"/>',
  chroma: '<circle cx="16" cy="8" r="2.2"/><path d="M3.5 18.5l5.5-6 4 4 3-3 4.5 5"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
} as const

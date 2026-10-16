// Web addresses for Browser, see browser.ts: what an address bar does with what's typed
// into it, and what a page needs to be shown inside Prism OS.
//
// Browser shows pages in an iframe, so a page shows only if its site lets other sites
// frame it. Many big sites send X-Frame-Options or a CSP frame-ancestors rule that says
// no, and the visitor's browser enforces it: the frame stays empty. Nothing on this side
// can read that answer from a cross-origin frame, so the sites known to refuse are listed
// below and Browser says so instead of showing an empty frame. A few refusing sites have
// an address made for framing, e.g. YouTube's embed player, and those addresses are used.

// What Browser searches with when the address bar holds words. Bing lets other sites
// frame its results.
export const searchEngine = {name: 'Bing', url: (query: string) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`}

// The longest search Browser sends, so a runaway generation can't fill the address.
export const maximumSearchText = 200

// File endings that look like a top-level domain in "notes.txt" or "beach.png". A word
// that ends in one is a file's name, not a site's.
const fileEndings = new Set(['txt', 'md', 'json', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'html', 'htm', 'js', 'ts', 'css', 'mp3', 'mp4', 'mov', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'log'])

const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24})$/u
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

// The https (or local http) URL for a web address as people type it, e.g. "wikipedia.org",
// "en.wikipedia.org/wiki/Prism" or "https://example.com", or null for anything else: words
// to search for, a file's name, or a scheme other than http and https.
export function webAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim().replace(/[.,;!?]+$/u, '')
  if (text === '' || /\s/u.test(text)) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(text) && !/^[^:/]+:\d+(?:[/?#]|$)/u.test(text)
  if (hasScheme && !/^https?:\/\//iu.test(text)) return null
  let url: URL
  try {
    url = new URL(hasScheme ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  const local = localHosts.has(host)
  if (!local) {
    const match = hostPattern.exec(host)
    if (match === null || fileEndings.has(match[1]!)) return null
  }
  if (url.username !== '' || url.password !== '') return null
  // A page on https can only frame https pages, so http addresses are asked for over
  // https. Only the visitor's own machine is framed over http.
  if (url.protocol === 'http:' && !local) url.protocol = 'https:'
  return url.href
}

// What the address bar loads for what's typed into it: the address, or a search.
export function addressFor(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  return webAddress(text) ?? searchEngine.url(text.slice(0, maximumSearchText))
}

// Sites that refuse to be framed, by their domain: each also covers its subdomains. Each
// was checked for X-Frame-Options or frame-ancestors.
const refusingSites: Readonly<Record<string, string>> = {
  'apple.com': 'Apple',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'bsky.app': 'Bluesky',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'cnn.com': 'CNN',
  'discord.com': 'Discord',
  'duckduckgo.com': 'DuckDuckGo',
  'developer.mozilla.org': 'MDN',
  'facebook.com': 'Facebook',
  'github.com': 'GitHub',
  'google.com': 'Google',
  'instagram.com': 'Instagram',
  'linkedin.com': 'LinkedIn',
  'medium.com': 'Medium',
  'nasa.gov': 'NASA',
  'netflix.com': 'Netflix',
  'news.ycombinator.com': 'Hacker News',
  'nytimes.com': 'The New York Times',
  'openstreetmap.org': 'OpenStreetMap',
  'paypal.com': 'PayPal',
  'pinterest.com': 'Pinterest',
  'reddit.com': 'Reddit',
  'spotify.com': 'Spotify',
  'stackoverflow.com': 'Stack Overflow',
  'startpage.com': 'Startpage',
  'threads.net': 'Threads',
  'tiktok.com': 'TikTok',
  'twitch.tv': 'Twitch',
  'twitter.com': 'X',
  'whatsapp.com': 'WhatsApp',
  'x.com': 'X',
  'yahoo.com': 'Yahoo',
  'youtube.com': 'YouTube',
}

function refusingSite(host: string): string | null {
  for (let domain = host; domain.includes('.'); domain = domain.slice(domain.indexOf('.') + 1)) {
    const name = refusingSites[domain]
    if (name !== undefined) return name
  }
  return null
}

const youtubeId = /^[\w-]{6,20}$/u

// The address of a refusing site's page that is made for framing, or null.
function framingAddress(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./u, '')
  const embed = (id: string | null | undefined) => id !== null && id !== undefined && youtubeId.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
  if (host === 'youtu.be') return embed(url.pathname.split('/')[1])
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const [, kind, id] = url.pathname.split('/')
    if (kind === 'watch') return embed(url.searchParams.get('v'))
    if (kind === 'shorts' || kind === 'live' || kind === 'embed') return embed(id)
    return null
  }
  if (host === 'youtube-nocookie.com') return url.pathname.startsWith('/embed/') ? url.href : null
  // Google's search frames with igu=1.
  if (host === 'google.com' && ['/', '/search', '/webhp'].includes(url.pathname)) {
    const framed = new URL(url.href)
    if (framed.pathname === '/') framed.pathname = '/webhp'
    framed.searchParams.set('igu', '1')
    return framed.href
  }
  if (host === 'openstreetmap.org' && url.pathname === '/export/embed.html') return url.href
  return null
}

// "self" is Prism OS's own origin. A page of it in the frame would share the desktop's
// origin and could lift the frame's sandbox, so Browser never shows one.
export type Framing = {kind: 'frame', url: string} | {kind: 'refused', site: string} | {kind: 'self'}

// How Browser shows a URL: in its frame, at the URL or at the site's address made for
// framing, or not at all, for a site that refuses and for Prism OS itself at `home`.
export function framingFor(address: string, home = ''): Framing {
  const url = new URL(address)
  if (url.origin === home) return {kind: 'self'}
  const framed = framingAddress(url)
  if (framed !== null) return {kind: 'frame', url: framed}
  const site = refusingSite(url.hostname.toLowerCase())
  return site === null ? {kind: 'frame', url: url.href} : {kind: 'refused', site}
}

// How Browser names a page in its replies: its host, without "www.".
export function pageName(address: string): string {
  try {
    return new URL(address).hostname.replace(/^www\./u, '')
  } catch {
    return address
  }
}

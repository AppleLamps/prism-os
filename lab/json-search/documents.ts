// Many small JSON documents for the batch measurements and a demo page: package manifests, user records, log events,
// editor settings, orders, map features and sensor readings, each at most 512 code points, the highlighter's capacity.
// A known fraction is broken on purpose, in one of 16 ways, e.g. a missing quote, a trailing comma, a bad escape, nesting
// past depth 16, or a text longer than 512 code points.
//
// documentAt(seed, index) is a pure function: every choice is a hash of the seed, the document's index and a counter,
// with lowbias32 from chenguini's ui.md ("Pseudo-Random"), and never Math.random. So a page can make document 73,512 without
// making the ones before it, and two runs time the same texts.
import {capacity, maximumDepth} from '../../src/json-highlighter/kinds.ts'

function lowbias32(n: number) {
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0xd35a2d97)
  return (n >>> 15) ^ n
}
// ui.md's hashN([a, b, c]) written out: a number in [0, 1).
function hash3(a: number, b: number, c: number) {
  return (lowbias32(lowbias32(lowbias32(a) ^ b) ^ c) >>> 0) / 0x100000000
}

export const defaultSeed = 20261013
export const defaultInvalidFraction = 0.1

export const shapes = ['packageManifest', 'userRecord', 'logEvent', 'settings', 'order', 'mapFeature', 'sensorReadings'] as const
export type Shape = typeof shapes[number]

// The ways a document is broken. JSON.parse rejects every one except tooDeep and tooLong, which are valid JSON that the
// highlighter doesn't hold: it reports tooDeep at the 17th nested opener and tooLong at code point 512.
export const defects = [
  // A string loses one of its quotes, e.g. {"name: "ada"}.
  'missingQuote',
  // A comma before a closing bracket, e.g. [1, 2,].
  'trailingComma',
  // A backslash before a character that JSON doesn't escape, e.g. "\qada", or a \u with too few hex digits.
  'badEscape',
  // The document sits inside 16 to 19 more containers, e.g. [[[[…{"id": 1}…]]]].
  'tooDeep',
  // Several records in one array, more than 512 code points.
  'tooLong',
  // A key loses its colon, e.g. {"id" 1}.
  'missingColon',
  // A key without quotes, e.g. {id: 1}.
  'unquotedKey',
  // The text stops early, e.g. {"id": 1, "na.
  'truncatedText',
  // A string in single quotes, e.g. {'id': 1}.
  'singleQuotes',
  // A literal from another language, e.g. True, None or undefined.
  'badLiteral',
  // A number JSON doesn't allow, e.g. +1 or 012.
  'badNumber',
  // Two values without a comma between them, e.g. ["a" "b"].
  'missingComma',
  // A closing bracket of the other kind, e.g. {"id": 1].
  'mismatchedBracket',
  // A raw line feed or tab inside a string.
  'controlCharacter',
  // A comment, e.g. // generated.
  'comment',
  // More text after the document's value, e.g. {"id": 1}}.
  'extraText',
] as const
export type Defect = typeof defects[number]

export type GeneratedDocument = {text: string, shape: Shape, defect: Defect | 'none'}

type Json = string | number | boolean | null | Json[] | {[key: string]: Json}
type Random = {
  // A number in [0, 1).
  next: () => number
  integer: (minimum: number, maximum: number) => number
  chance: (probability: number) => boolean
  pick: <Item>(items: readonly Item[]) => Item
}

function createRandom(seed: number, index: number): Random {
  let counter = 0
  const next = () => hash3(seed, index, counter++)
  const integer = (minimum: number, maximum: number) => minimum + Math.floor(next() * (maximum - minimum + 1))
  return {next, integer, chance: probability => next() < probability, pick: items => items[Math.floor(next() * items.length)]!}
}

const firstNames = ['Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Zoë', 'José', 'Søren', 'Chloé', 'Yuki', 'Amara', 'Tomás', '美咲']
const lastNames = ['Lovelace', 'Hopper', 'Hamilton', 'Ritchie', 'Liskov', 'Perlman', 'Okafor', 'Souza', 'Nakamura', 'García', 'Müller', 'Kowalski', 'O\'Brien', '李']
const cities = ['Lisbon', 'Osaka', 'Tromsø', 'Quito', 'Hobart', 'Accra', 'Tallinn', 'Muscat', 'São Paulo', 'Kraków', 'Reykjavík', '東京']
const countries = ['PT', 'JP', 'NO', 'EC', 'AU', 'GH', 'EE', 'OM', 'BR', 'PL', 'IS']
const streets = ['Rua das Flores', 'Harbor Rd', 'Elm Street', 'Nørregade', 'Calle 8', 'Station Lane', 'Av. Paulista']
const words = 'the harbor is quiet and an old ferry waits at the pier while gulls argue over something that washed up overnight a few early walkers pass the shuttered stalls on the way to an office or a train some stop to watch the tide'.split(' ')
const packageWords = ['fast', 'tiny', 'json', 'parse', 'stream', 'query', 'cache', 'router', 'logger', 'schema', 'lint', 'fetch', 'queue', 'state', 'config', 'glob']
const scopes = ['acme', 'northwind', 'harbor', 'types', 'tools']
const licenses = ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', 'MPL-2.0']
const scripts: [string, string][] = [['build', 'tsc -p .'], ['test', 'bun test'], ['lint', 'oxlint --type-aware src'], ['start', 'node dist/index.js'], ['dev', 'bun --watch src/main.ts'], ['clean', 'del-cli dist'], ['format', 'prettier --write "src/**/*.ts"']]
const roles = ['admin', 'editor', 'viewer', 'billing', 'support', 'owner']
const levels = ['debug', 'info', 'warn', 'error', 'fatal']
const services = ['checkout', 'auth', 'search', 'inventory', 'mailer', 'gateway', 'thumbnailer']
const messages = ['request completed', 'retrying after timeout', 'cache miss for key "user:42"', 'upstream returned 502', 'payment declined: insufficient funds', 'connection reset by peer', 'slow query on table orders', 'token expired, refreshing', 'wrote 3 files to C:\\temp\\out', 'line 1\nline 2']
const tags = ['urgent', 'draft', 'billing', 'ops', 'mobile', 'web', 'beta', 'internal', 'archived', 'eu-west', 'canary']
const themes = ['Solarized Dark', 'Solarized Light', 'Monokai', 'GitHub Light', 'Nord', 'Gruvbox']
const settingEntries: [string, (random: Random) => Json][] = [
  ['editor.fontSize', random => random.integer(11, 18)],
  ['editor.tabSize', random => random.pick([2, 4, 8])],
  ['editor.wordWrap', random => random.pick(['on', 'off', 'bounded'])],
  ['editor.formatOnSave', random => random.chance(0.5)],
  ['editor.rulers', random => random.pick<Json>([[80], [100, 120], []])],
  ['editor.lineHeight', random => random.pick([1.4, 1.5, 1.6, 0])],
  ['workbench.colorTheme', random => random.pick(themes)],
  ['window.zoomLevel', random => random.integer(-2, 2)],
  ['files.exclude', random => ({'**/.git': true, '**/node_modules': random.chance(0.7), '**/*.log': random.chance(0.5)})],
  ['files.autoSave', random => random.pick(['afterDelay', 'onFocusChange', 'off'])],
  ['terminal.shell', random => random.pick(['/bin/zsh', '/usr/bin/fish', 'C:\\Windows\\System32\\cmd.exe'])],
  ['telemetry.enabled', () => false],
  ['search.followSymlinks', random => random.chance(0.5)],
  ['git.autofetchPeriod', random => random.pick([180, 300, null])],
  ['http.proxy', random => random.pick<Json>([null, 'http://proxy.example:8080'])],
]
const products = ['Ceramic mug', 'Linen apron', 'Desk lamp', 'Notebook, ruled', 'Olive oil 500 ml', 'USB-C cable', 'Tea "Earl Grey"', 'Café filter']
const currencies = ['EUR', 'USD', 'JPY', 'BRL', 'NOK']
const sensors = ['th-04', 'co2-kitchen', 'door-north', 'pm25-roof', 'soil-07']
const units = ['°C', 'ppm', 'open', 'µg/m³', '%']

const sentence = (random: Random, wordCount: number) => Array.from({length: wordCount}, () => random.pick(words)).join(' ')
const time = (random: Random) => `2026-${String(random.integer(1, 12)).padStart(2, '0')}-${String(random.integer(1, 28)).padStart(2, '0')}T${String(random.integer(0, 23)).padStart(2, '0')}:${String(random.integer(0, 59)).padStart(2, '0')}:${String(random.integer(0, 59)).padStart(2, '0')}Z`
const hexId = (random: Random, digits: number) => Array.from({length: digits}, () => '0123456789abcdef'[random.integer(0, 15)]).join('')
const person = (random: Random) => `${random.pick(firstNames)} ${random.pick(lastNames)}`
// Removes some keys after the first `keep`, so documents of one shape don't all have the same keys.
function someKeys(random: Random, record: {[key: string]: Json}, keep: number, size: number) {
  const result: {[key: string]: Json} = {}
  Object.entries(record).forEach(([key, value], index) => {
    if (index < keep || random.chance(0.35 + 0.65 * size)) result[key] = value
  })
  return result
}

// `size` in 0..1 scales how many fields and items a document has.
const builders: Record<Shape, (random: Random, size: number) => Json> = {
  packageManifest(random, size) {
    const name = `${random.pick(packageWords)}-${random.pick(packageWords)}`
    const dependencies = (count: number) => Object.fromEntries(Array.from({length: count}, (): [string, Json] =>
      [random.chance(0.3) ? `@${random.pick(scopes)}/${random.pick(packageWords)}` : `${random.pick(packageWords)}-${random.pick(packageWords)}`, `${random.pick(['^', '~', ''])}${random.integer(0, 9)}.${random.integer(0, 30)}.${random.integer(0, 9)}`]))
    return someKeys(random, {
      name: random.chance(0.4) ? `@${random.pick(scopes)}/${name}` : name,
      version: `${random.integer(0, 9)}.${random.integer(0, 30)}.${random.integer(0, 99)}`,
      description: sentence(random, 2 + Math.round(size * 6)),
      type: 'module',
      main: 'dist/index.js',
      scripts: Object.fromEntries(scripts.filter(() => random.chance(0.25 + 0.5 * size))),
      dependencies: dependencies(Math.round(size * 5)),
      devDependencies: dependencies(Math.round(size * 3)),
      keywords: Array.from({length: Math.round(size * 4)}, () => random.pick(packageWords)),
      license: random.pick(licenses),
      private: random.chance(0.4),
    }, 2, size)
  },
  userRecord(random, size) {
    const name = person(random)
    return someKeys(random, {
      id: random.integer(1, 99_999),
      name,
      email: `${name.split(' ')[0]!.toLowerCase()}.${random.integer(1, 99)}@example.com`,
      age: random.integer(18, 90),
      active: random.chance(0.8),
      roles: Array.from({length: random.integer(0, 1 + Math.round(size * 3))}, () => random.pick(roles)),
      address: {street: `${random.integer(1, 400)} ${random.pick(streets)}`, city: random.pick(cities), zip: String(random.integer(10_000, 99_999)), country: random.pick(countries)},
      lastLogin: random.chance(0.85) ? time(random) : null,
      balance: Math.round((random.next() * 4000 - 1000) * 100) / 100,
      manager: random.chance(0.3) ? null : random.integer(1, 99_999),
      bio: sentence(random, 3 + Math.round(size * 14)),
    }, 3, size)
  },
  logEvent(random, size) {
    const level = random.pick(levels)
    return someKeys(random, {
      ts: time(random),
      level,
      service: random.pick(services),
      msg: random.pick(messages),
      durationMs: Math.round(random.next() * 250_000) / 100,
      status: random.pick([200, 201, 204, 301, 400, 404, 429, 500, 502]),
      requestId: hexId(random, 16),
      host: `${random.pick(services)}-${random.integer(1, 12)}.internal`,
      tags: Array.from({length: Math.round(size * 4)}, () => random.pick(tags)),
      error: level === 'error' || level === 'fatal' ? {code: random.pick(['ETIMEDOUT', 'ECONNRESET', 'E_VALIDATION']), retryable: random.chance(0.5), attempts: random.integer(1, 5)} : null,
      sampleRate: random.pick([1, 0.5, 0.01, 1e-4, 2.5e-7]),
      context: {region: random.pick(tags), build: hexId(random, 7), detail: sentence(random, Math.round(size * 10))},
    }, 4, size)
  },
  settings(random, size) {
    const count = 2 + Math.round(size * (settingEntries.length - 2))
    const first = random.integer(0, settingEntries.length - 1)
    return Object.fromEntries(Array.from({length: count}, (_, offset): [string, Json] => {
      const [key, make] = settingEntries[(first + offset) % settingEntries.length]!
      return [key, make(random)]
    }))
  },
  order(random, size) {
    const items = Array.from({length: 1 + Math.round(size * 4)}, (): Json => ({
      sku: `${random.pick(['MG', 'AP', 'LM', 'NB', 'OO'])}-${random.integer(100, 999)}`, title: random.pick(products), qty: random.integer(1, 6), price: Math.round(random.next() * 9000 + 100) / 100,
    }))
    return someKeys(random, {
      orderId: `A-${random.integer(10_000, 99_999)}`,
      items,
      total: Math.round(random.next() * 50_000) / 100,
      currency: random.pick(currencies),
      paid: random.chance(0.9),
      customer: {name: person(random), city: random.pick(cities)},
      shippedAt: random.chance(0.6) ? time(random) : null,
      notes: random.pick(['', 'leave at the door', 'gift wrap, please', 'call "Ana" on arrival', 'fragile\thandle with care']),
      discount: random.chance(0.3) ? -Math.round(random.next() * 2000) / 100 : 0,
    }, 3, size)
  },
  mapFeature(random, size) {
    const coordinate = (): Json => [Math.round((random.next() * 360 - 180) * 1e5) / 1e5, Math.round((random.next() * 170 - 85) * 1e5) / 1e5]
    const line = random.chance(0.4)
    return {
      type: 'Feature',
      geometry: line ? {type: 'LineString', coordinates: Array.from({length: 2 + Math.round(size * 6)}, coordinate)} : {type: 'Point', coordinates: coordinate()},
      properties: someKeys(random, {
        name: random.pick(cities),
        population: random.integer(900, 14_000_000),
        elevation: Math.round(random.next() * 30_000 - 400) / 10,
        area: random.pick([1.5e3, 8.25e2, 6.02e23, 3e-9]),
        capital: random.chance(0.2),
        tags: Array.from({length: Math.round(size * 3)}, () => random.pick(tags)),
        note: sentence(random, 2 + Math.round(size * 8)),
      }, 1, size),
    }
  },
  sensorReadings(random, size) {
    const sensor = random.integer(0, sensors.length - 1)
    const start = 1_790_000_000 + random.integer(0, 9_000_000)
    return Array.from({length: 1 + Math.round(size * 7)}, (_, reading): Json => ({
      sensor: sensors[sensor]!, t: start + reading * 60, v: sensors[sensor] === 'door-north' ? random.chance(0.5) : Math.round(random.next() * 5000 - 500) / 100, unit: units[sensor]!,
      ...(random.chance(0.15) ? {gap: null} : {}),
    }))
  },
}

const styles = ['compact', 'spaced', 'indented', 'tabbed'] as const
type Style = typeof styles[number]

// 'spaced' writes ", " and ": " on one line, as Python's json.dumps does.
function spaced(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(spaced).join(', ')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${spaced(item)}`).join(', ')}}`
  return JSON.stringify(value)
}
function serialize(value: Json, style: Style, escapeNonAscii: boolean) {
  const text = style === 'compact' ? JSON.stringify(value) : style === 'spaced' ? spaced(value) : JSON.stringify(value, null, style === 'indented' ? 2 : '\t')
  // Characters past U+007F only occur inside strings, so escaping them in the whole text escapes them in the strings.
  return escapeNonAscii ? text.replace(/[\u0080-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) : text
}

export function codePointLength(text: string) {
  let length = text.length
  for (let index = 0; index < text.length - 1; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) length--
    }
  }
  return length
}

// A valid document of at most `maximumLength` code points. A document that comes out longer is built again with fewer
// fields, and on one line after two tries.
function validDocument(random: Random, shape: Shape, maximumLength: number) {
  let size = random.next()
  let style = random.pick(styles)
  const escapeNonAscii = random.chance(0.15)
  for (let attempt = 0; ; attempt++) {
    const value = builders[shape](random, size)
    const text = serialize(value, style, escapeNonAscii)
    if (codePointLength(text) <= maximumLength) return {value, text}
    size = attempt >= 6 ? 0 : size * 0.6
    if (attempt >= 1) style = 'compact'
    if (attempt > 40) throw new Error(`no ${shape} document fits in ${maximumLength} code points`)
  }
}

// Where a valid JSON text's tokens are, as indices into the text.
function scanTokens(text: string) {
  // Every string's opening quote and closing quote.
  const strings: {open: number, close: number, isKey: boolean}[] = []
  const colons: number[] = []
  const commas: number[] = []
  const closers: number[] = []
  const literals: {start: number, word: string}[] = []
  const numbers: number[] = []
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (character === '"') {
      const open = index
      for (index++; text[index] !== '"'; index++) if (text[index] === '\\') index++
      strings.push({open, close: index, isKey: false})
    } else if (character === ':') {
      colons.push(index)
      strings.at(-1)!.isKey = true
    } else if (character === ',') {
      commas.push(index)
    } else if (character === '}' || character === ']') {
      closers.push(index)
    } else if (character === 't' || character === 'f' || character === 'n') {
      const word = character === 't' ? 'true' : character === 'f' ? 'false' : 'null'
      literals.push({start: index, word})
      index += word.length - 1
    } else if (character === '-' || (character >= '0' && character <= '9')) {
      numbers.push(index)
      while (index + 1 < text.length && /[-+.eE0-9]/.test(text[index + 1]!)) index++
    }
  }
  return {strings, colons, commas, closers, literals, numbers}
}

const cut = (text: string, from: number, to: number, insert = '') => text.slice(0, from) + insert + text.slice(to)
const previousNonSpace = (text: string, index: number) => {
  let previous = index - 1
  while (previous >= 0 && /\s/.test(text[previous]!)) previous--
  return previous
}
const nextNonSpace = (text: string, index: number) => {
  let next = index + 1
  while (next < text.length && /\s/.test(text[next]!)) next++
  return next
}

// The most code points a defect adds to a text, e.g. the 13 of a comment line.
const defectMargin = 16

// Applies one defect to a valid text, or returns undefined when the text has no place for it, e.g. no literal to
// misspell. tooDeep and tooLong are built in documentAt, since they need other texts.
function applyDefect(random: Random, defect: Defect, text: string): string | undefined {
  const tokens = scanTokens(text)
  switch (defect) {
    case 'missingQuote': {
      if (tokens.strings.length === 0) return undefined
      const string = random.pick(tokens.strings)
      const quote = random.chance(0.5) ? string.open : string.close
      return cut(text, quote, quote + 1)
    }
    case 'trailingComma': {
      // Only before the closer of a container that has an item, e.g. not inside [].
      const places = tokens.closers.map(closer => previousNonSpace(text, closer)).filter(previous => previous >= 0 && text[previous] !== '{' && text[previous] !== '[')
      if (places.length === 0) return undefined
      const place = random.pick(places)
      return cut(text, place + 1, place + 1, ',')
    }
    case 'badEscape': {
      if (tokens.strings.length === 0) return undefined
      const {open} = random.pick(tokens.strings)
      return cut(text, open + 1, open + 1, random.pick(['\\q', '\\x41', '\\\'', '\\a', '\\u12G4', '\\U0041']))
    }
    case 'missingColon': {
      if (tokens.colons.length === 0) return undefined
      const colon = random.pick(tokens.colons)
      return cut(text, colon, colon + 1, random.chance(0.5) ? ' ' : '')
    }
    case 'unquotedKey': {
      const keys = tokens.strings.filter(string => string.isKey)
      if (keys.length === 0) return undefined
      const key = random.pick(keys)
      return cut(cut(text, key.close, key.close + 1), key.open, key.open + 1)
    }
    case 'truncatedText':
      return text.slice(0, random.integer(1, text.length - 1))
    case 'singleQuotes': {
      if (tokens.strings.length === 0) return undefined
      const string = random.pick(tokens.strings)
      return cut(cut(text, string.close, string.close + 1, '\''), string.open, string.open + 1, '\'')
    }
    case 'badLiteral': {
      if (tokens.literals.length === 0) return undefined
      const {start, word} = random.pick(tokens.literals)
      const replacements: Record<string, string[]> = {true: ['True', 'TRUE', 'tru', 'yes'], false: ['False', 'FALSE', 'fals', 'no'], null: ['None', 'nil', 'NULL', 'undefined', 'NaN']}
      return cut(text, start, start + word.length, random.pick(replacements[word]!))
    }
    case 'badNumber': {
      if (tokens.numbers.length === 0) return undefined
      const start = random.pick(tokens.numbers)
      if (random.chance(0.5)) return cut(text, start, start, '+')
      const digit = text[start] === '-' ? start + 1 : start
      return cut(text, digit, digit, '0')
    }
    case 'missingComma': {
      // Only before a string or a container: without the comma, [1,2] would be the valid [12].
      const places = tokens.commas.filter(comma => '"{['.includes(text[nextNonSpace(text, comma)] ?? ' '))
      if (places.length === 0) return undefined
      const comma = random.pick(places)
      return cut(text, comma, comma + 1)
    }
    case 'mismatchedBracket': {
      const closer = random.pick(tokens.closers)
      return cut(text, closer, closer + 1, text[closer] === '}' ? ']' : '}')
    }
    case 'controlCharacter': {
      if (tokens.strings.length === 0) return undefined
      const {open} = random.pick(tokens.strings)
      return cut(text, open + 1, open + 1, random.pick(['\n', '\t', '\u0000', '\u001b']))
    }
    case 'comment':
      return random.chance(0.5) ? `// generated\n${text}` : cut(text, 1, 1, '/* v2 */')
    case 'extraText':
      return text + random.pick(['}', ']', ',', ' {}', '\n[]', ' null', ';'])
    case 'tooDeep':
    case 'tooLong':
      return undefined
  }
}

export function documentAt(seed: number, index: number, invalidFraction = defaultInvalidFraction): GeneratedDocument {
  const random = createRandom(seed, index)
  const shape = random.pick(shapes)
  if (!random.chance(invalidFraction)) return {text: validDocument(random, shape, capacity).text, shape, defect: 'none'}
  const first = random.integer(0, defects.length - 1)
  for (let offset = 0; ; offset++) {
    const defect = defects[(first + offset) % defects.length]!
    if (defect === 'tooDeep') {
      // 16 to 19 containers around a document that has at least one of its own, so the depth passes 16.
      const levels = random.integer(maximumDepth, maximumDepth + 3)
      const objects = Array.from({length: levels}, () => random.chance(0.3))
      const opening = objects.map(isObject => isObject ? '{"a":' : '[').join('')
      const closing = objects.map(isObject => isObject ? '}' : ']').reverse().join('')
      const inner = validDocument(random, shape, capacity - opening.length - closing.length).text
      return {text: opening + inner + closing, shape, defect}
    }
    if (defect === 'tooLong') {
      // Records of the same shape in one array, until the text is longer than the capacity.
      const records: Json[] = []
      let text = ''
      while (codePointLength(text) <= capacity) {
        records.push(validDocument(random, shape, capacity).value)
        text = serialize(records, records.length % 2 === 0 ? 'spaced' : 'indented', false)
      }
      return {text, shape, defect}
    }
    const text = applyDefect(random, defect, validDocument(random, shape, capacity - defectMargin).text)
    if (text !== undefined) return {text, shape, defect}
  }
}

export function generateDocuments(count: number, seed = defaultSeed, invalidFraction = defaultInvalidFraction): GeneratedDocument[] {
  return Array.from({length: count}, (_, index) => documentAt(seed, index, invalidFraction))
}

// Counts per shape and per defect, and the lengths in code points: the smallest, the quartiles, the mean, the largest,
// and a histogram in steps of 64 code points, whose last bucket holds every text longer than the capacity.
export function describeDocuments(documents: readonly GeneratedDocument[]) {
  const lengths = documents.map(document => codePointLength(document.text)).sort((left, right) => left - right)
  const at = (fraction: number) => lengths[Math.min(lengths.length - 1, Math.floor(fraction * lengths.length))]!
  const histogram = Array.from({length: capacity / 64 + 1}, () => 0)
  for (const length of lengths) histogram[length > capacity ? capacity / 64 : Math.min(capacity / 64 - 1, Math.floor(length / 64))]!++
  const countBy = <Key extends string>(keys: readonly Key[], keyOf: (document: GeneratedDocument) => Key) =>
    Object.fromEntries(keys.map(key => [key, documents.filter(document => keyOf(document) === key).length])) as Record<Key, number>
  return {
    count: documents.length,
    invalid: documents.filter(document => document.defect !== 'none').length,
    nonAscii: documents.filter(document => /[\u0080-\uffff]/.test(document.text)).length,
    lengths: {minimum: lengths[0]!, quartile1: at(0.25), median: at(0.5), quartile3: at(0.75), maximum: lengths.at(-1)!, mean: Math.round(lengths.reduce((total, length) => total + length, 0) / lengths.length * 10) / 10},
    histogram,
    shapes: countBy(shapes, document => document.shape),
    defects: countBy(['none', ...defects], document => document.defect),
  }
}

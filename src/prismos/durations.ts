// Durations for Clock's timer, as people type or say them: "5 minutes", "90 seconds",
// "1 hour 30 minutes", "an hour and a half", "half an hour", "2.5 min", "1:30", or a bare
// number of minutes.

// The longest timer Clock runs.
export const maximumTimerSeconds = 24 * 60 * 60

const numberWords: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
}

const unitSeconds: readonly [RegExp, number][] = [
  [/^(?:h|hr|hrs|hour|hours)$/u, 3600],
  [/^(?:m|min|mins|minute|minutes)$/u, 60],
  [/^(?:s|sec|secs|second|seconds)$/u, 1],
]

function unit(word: string): number | null {
  for (const [pattern, seconds] of unitSeconds) {
    if (pattern.test(word)) return seconds
  }
  return null
}

// The duration in whole seconds, or null for anything that isn't one, or is longer than a day.
export function parseDuration(input: unknown): number | null {
  if (typeof input !== 'string') return null
  let text = input.trim().toLowerCase().replace(/[.!?]+$/u, '').replace(/-/gu, ' ').replace(/\s+/gu, ' ')
    .replace(/^(?:for|in) /u, '').replace(/ (?:timer|countdown)$/u, '')
  if (text === '') return null
  // "1:30" is a minute and a half, "1:02:03" an hour, two minutes and three seconds.
  const clock = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/u.exec(text)
  if (clock !== null) {
    const [first, second, third] = [Number(clock[1]), Number(clock[2]), clock[3] === undefined ? null : Number(clock[3])]
    return bounded(third === null ? first * 60 + second : first * 3600 + second * 60 + third)
  }
  if (/^\d+(?:\.\d+)?$/u.test(text)) return bounded(Math.round(Number(text) * 60))
  text = text
    .replace(/\bhalf an? (hour|minute)\b/gu, '0.5 $1')
    .replace(/\b(an?|one) (hour|minute) and a half\b/gu, '1.5 $2')
    .replace(/(\d)(?=[a-z])/gu, '$1 ')
    .replace(/([a-z])(?=\d)/gu, '$1 ')
  const words = text.split(/ |,/u).filter(word => word !== '' && word !== 'and')
  let total = 0
  let pending: number | null = null
  let any = false
  for (const word of words) {
    const value = /^\d+(?:\.\d+)?$/u.test(word) ? Number(word) : numberWords[word]
    if (value !== undefined) {
      // "twenty five": a ten and then a unit.
      if (pending !== null && !(pending >= 20 && pending % 10 === 0 && value < 10)) return null
      pending = (pending ?? 0) + value
      continue
    }
    const seconds = unit(word)
    if (seconds === null || pending === null) return null
    total += pending * seconds
    pending = null
    any = true
  }
  return any && pending === null ? bounded(Math.round(total)) : null
}

function bounded(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= maximumTimerSeconds ? seconds : null
}

// A timer's readout: "4:59", "1:00:00".
export function formatTimer(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const two = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`
}

// A duration in words, for replies: "5 minutes", "1 hour 30 minutes", "45 seconds".
export function describeDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  const parts: [number, string][] = [[Math.floor(whole / 3600), 'hour'], [Math.floor((whole % 3600) / 60), 'minute'], [whole % 60, 'second']]
  const named = parts.filter(([value]) => value > 0).map(([value, name]) => `${value} ${name}${value === 1 ? '' : 's'}`)
  return named.length === 0 ? '0 seconds' : named.join(' ')
}

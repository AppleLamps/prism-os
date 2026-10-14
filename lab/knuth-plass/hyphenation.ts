// Soft hyphens inserted like pretext's justification demo, from the demo's own tables: exceptions, then prefixes, then
// suffixes. A copy of hyphenateParagraphText and hyphenateWord in pretext-demo/justification-comparison.model.ts, which
// doesn't export them. pretext-demo/ holds the demo's files from pretext's repository, see the README.
import {HYPHEN_EXCEPTIONS, PREFIXES, SUFFIXES} from './pretext-demo/justification-comparison.data.ts'
import {softHyphen} from './paragraph.ts'

export function hyphenateParagraphText(paragraph: string): string {
  return paragraph.split(/(\s+)/).map(token => {
    if (/^\s+$/.test(token)) return token
    const parts = hyphenateWord(token)
    return parts.length <= 1 ? token : parts.join(softHyphen)
  }).join('')
}

function hyphenateWord(word: string): string[] {
  const lower = word.toLowerCase().replace(/[.,;:!?"'—–-]/g, '')
  if (lower.length < 5) return [word]
  const exactMatch = HYPHEN_EXCEPTIONS[lower]
  if (exactMatch !== undefined) {
    const parts: string[] = []
    let position = 0
    for (const part of exactMatch) {
      parts.push(word.slice(position, position + part.length))
      position += part.length
    }
    if (position < word.length) parts[parts.length - 1] += word.slice(position)
    return parts
  }
  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix) && lower.length - prefix.length >= 3) return [word.slice(0, prefix.length), word.slice(prefix.length)]
  }
  for (const suffix of SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length - suffix.length >= 3) {
      const cut = word.length - suffix.length
      return [word.slice(0, cut), word.slice(cut)]
    }
  }
  return [word]
}

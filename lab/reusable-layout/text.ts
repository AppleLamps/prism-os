export const captionFont = '14px Arial'
export const lineHeight = 20
export type TextMeasure = (text: string) => number
export type PreparedCaption = {words: {text: string, width: number}[], spaceWidth: number, totalWidth: number}

export function prepareCaption(text: string, measure: TextMeasure): PreparedCaption {
  const words = text.split(' ').map(word => ({text: word, width: measure(word)}))
  const spaceWidth = measure(' ')
  return {words, spaceWidth, totalWidth: words.reduce((sum, word) => sum + word.width, 0) + (words.length - 1) * spaceWidth}
}

// The fixed caption corpus uses ordinary words that fit the minimum width.
// Lines are rendered explicitly, so browser wrapping cannot change the result.
export function wrapCaption(caption: PreparedCaption, width: number) {
  const lines: string[] = []
  const widths: number[] = []
  let line = ''
  let lineWidth = 0
  for (const word of caption.words) {
    const nextWidth = lineWidth + (line === '' ? 0 : caption.spaceWidth) + word.width
    if (line !== '' && nextWidth > width) {
      lines.push(line)
      widths.push(lineWidth)
      line = word.text
      lineWidth = word.width
    } else {
      line += (line === '' ? '' : ' ') + word.text
      lineWidth = nextWidth
    }
  }
  if (line !== '') {
    lines.push(line)
    widths.push(lineWidth)
  }
  return {lines, widths, height: lines.length * lineHeight}
}

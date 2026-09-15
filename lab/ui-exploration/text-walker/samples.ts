// Texts for the feature ladder, each checked against pretext over its width range.
import {makeParagraph} from './fake-canvas.ts'

type PrepareOptions = Parameters<typeof import('./pretext-src/layout.ts').prepareWithSegments>[2]

export type LadderSample = {
  step: string
  text: string
  options?: PrepareOptions
  minWidth: number
  maxWidth: number
}

export const ladderSamples: LadderSample[] = [
  {step: 'fast path', text: makeParagraph(32, 7), minWidth: 160, maxWidth: 320},
  {
    step: 'hard-break chunks',
    text: 'First line here\nSecond one is a little longer than the first\n\nFourth, after an empty line, with more words to wrap\n',
    options: {whiteSpace: 'pre-wrap'},
    minWidth: 100,
    maxWidth: 400,
  },
  {
    step: 'breakable long words',
    text: 'Mina replied: labels at https://example.com/reports/q3-final-draft?lang=ar are still weird, antidisestablishmentarianism.',
    minWidth: 30,
    maxWidth: 400,
  },
  {
    step: 'soft hyphens',
    text: 'Mina replied: trans­atlantic in­cred­ible hyphen­ation, and more trans­port words for the con­tainer.',
    minWidth: 90,
    maxWidth: 300,
  },
  {
    step: 'letter spacing',
    text: 'Letter spaced words wrap here and there, with a longer tail of words.',
    options: {letterSpacing: 1.5},
    minWidth: 110,
    maxWidth: 300,
  },
  {
    step: 'tabs in pre-wrap',
    text: 'name\tvalue\nwidth\t320px\n\nheight\t20px and a longer tail\twith tabs\tand  spaces',
    options: {whiteSpace: 'pre-wrap'},
    minWidth: 60,
    maxWidth: 300,
  },
  {
    step: 'all features together',
    text: 'Tabs\there, trans­atlantic https://example.com/a-very-long-path-name\nnext line\t\twith  gaps and in­cred­ible words',
    options: {whiteSpace: 'pre-wrap', letterSpacing: 0.75},
    minWidth: 40,
    maxWidth: 300,
  },
]

export const testFont = '16px Test Sans'

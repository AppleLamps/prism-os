// Content for the Notes window: a balanced heading, a few paragraphs, and a short chat.

export type NotesMessage = {text: string, mine: boolean}

export type NotesContent = {
  heading: string
  paragraphs: string[]
  messages: NotesMessage[]
}

export const notesFonts = {
  heading: '600 26px "Helvetica Neue", Helvetica, Arial, sans-serif',
  body: '15px "Helvetica Neue", Helvetica, Arial, sans-serif',
  bubble: '15px "Helvetica Neue", Helvetica, Arial, sans-serif',
}

export const notesLineHeights = {heading: 32, body: 22, bubble: 20}

export const notesContent: NotesContent = {
  heading: 'Line breaks that come out of one numeric circuit',
  paragraphs: [
    'Every block of text in this window was measured once, when the page loaded. pretext walked each paragraph at every width where its line breaks change, and wrote those widths into a table.',
    "While you drag the window's edge, nothing measures text. One compiled circuit compares the springing width against those thresholds, and the comparison bits add up to line counts, block heights, and the first and last character of every painted line.",
    "JavaScript only turns those numbers back into strings: when a line's start or end cursor changes, it slices the paragraph again. Long links such as https://github.com/chenglou/pretext/blob/main/src/line-break.ts still break inside the word where pretext would break them.",
    'The chat below reuses the idea. A bubble is as narrow as it can be without adding a line, and that width only changes when the line count does.',
  ],
  messages: [
    {text: 'Did the window just reflow without calling layout()?', mine: false},
    {text: 'Yes. Every line break you see is a sum of comparison bits.', mine: true},
    {text: 'And the bubbles hug their text?', mine: false},
    {text: 'Each one looks up its tight width from the same bits, then springs to it.', mine: true},
    {text: '👍', mine: false},
  ],
}

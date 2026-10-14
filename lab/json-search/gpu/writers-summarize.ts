// Prints the tables of writers-run.ts's result files as markdown.
//   bun lab/json-search/gpu/writers-summarize.ts lab/json-search/results/writers-1.json,lab/json-search/results/writers-2.json
// A cell is the median of the medians of every turn of every run, with the smallest and the largest sample in parentheses.
import {readFileSync} from 'node:fs'
import type {Summary} from './measure.ts'
import type {WritersPageConfig} from './writers-page.ts'

type Timed = {backToBack?: Summary, passMs?: Summary, afterPause?: Summary}
type Program = {name: string, statements: number, compileMs: number}
type Result = {
  driver: {browser?: string, machine?: string, loadSamples: {load: string}[]}
  page: {
    config: WritersPageConfig
    created?: {name: string, createMs: number, programs: Program[]}[]
    highlighterValues?: {values: number, different: number, validDocuments: number}
    validate?: (Timed & {writer: string})[]
    searches?: (Timed & {pattern: string, scope: string, states: number, patternStates: number, documentsWithMatches: number, writer: string})[]
    searchValues?: {searches: number, values: number, different: number}
    stopAtLength?: (Timed & {states: number, stopAtLength?: boolean, statements?: number, compileMs?: number, matchesWithEveryPosition?: number[], matchesWithStopping?: number[]})[]
  }
}

const files = (process.argv[2] ?? '').split(',').filter(file => file !== '')
if (files.length === 0) throw new Error('give the result files, separated by commas')
const runs = files.map(file => JSON.parse(readFileSync(file, 'utf8')) as Result)

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const digits = (value: number) => value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
const whole = (value: number) => value.toLocaleString('en-US')
// The median of the turns' medians, and the range of every sample.
function cell(summaries: readonly (Summary | undefined)[]) {
  const present = summaries.filter(summary => summary !== undefined)
  if (present.length === 0) return ''
  return `${digits(median(present.map(summary => summary.median)))} (${digits(Math.min(...present.map(summary => summary.min)))} to ${digits(Math.max(...present.map(summary => summary.max)))})`
}
const table = (header: string[], rows: string[][]) => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
const tick = (text: string) => `\`${text.replaceAll('|', '\\|')}\``
const scopeWords: Record<string, string> = {everything: 'everything', strings: 'string values', keys: 'keys'}

for (const [index, run] of runs.entries()) {
  const loads = run.driver.loadSamples.map(sample => Number(sample.load.replace(/[{}]/g, '').trim().split(/\s+/)[0]))
  const config = run.page.config
  console.log(`Run ${index + 1}, ${files[index]}: ${run.driver.browser}, ${run.driver.machine}, ${whole(config.count)} documents, ${config.rounds} turns per writer, 1-minute load average ${Math.min(...loads)} to ${Math.max(...loads)}.`)
}
console.log('')

const created = runs.flatMap(run => run.page.created ?? [])
if (created.length > 0) {
  console.log('### Creating the searcher, with every shader compiled without a cache, ms\n')
  const names = [...new Set(created.map(entry => entry.name))]
  const programNames = [...new Set(created.flatMap(entry => entry.programs.map(program => program.name)))]
  const spread = (values: number[]) => values.length === 1 ? digits(values[0]!) : `${digits(median(values))} (${digits(Math.min(...values))} to ${digits(Math.max(...values))})`
  console.log(table(['The searcher with', 'Created in', ...programNames.map(name => `${name}: statements, compile`)], names.map(name => {
    const mine = created.filter(entry => entry.name === name)
    return [name, spread(mine.map(entry => entry.createMs)), ...programNames.map(programName => {
      const programs = mine.flatMap(entry => entry.programs.filter(program => program.name === programName))
      return `${whole(programs[0]!.statements)}, ${spread(programs.map(program => program.compileMs))}`
    })]
  })))
  console.log('\nThe cells of every document are written before the searcher is created, so its 44 ms aren\'t in these times.\n')
}

const searches = runs.flatMap(run => run.page.searches ?? [])
if (searches.length > 0) {
  const patterns = [...new Map(searches.map(search => [`${search.pattern}\n${search.scope}`, search])).values()].sort((left, right) => left.states - right.states)
  const of = (writer: string, select: (search: typeof searches[number]) => boolean) => searches.filter(search => search.writer === writer && select(search))
  const row = (label: string[], select: (search: typeof searches[number]) => boolean) => [
    ...label,
    cell(of('loop-emit', select).map(search => search.backToBack)), cell(of('bit-emit', select).map(search => search.backToBack)),
    cell(of('loop-emit', select).map(search => search.afterPause)), cell(of('bit-emit', select).map(search => search.afterPause)),
  ]
  const columns = ['loop-emit.ts\'s shader, back to back', 'bit-emit.ts\'s shader, back to back', `loop-emit.ts's shader, after a pause of ${runs[0]!.page.config.pauseMs} ms`, 'bit-emit.ts\'s shader, after the same pause']
  console.log(`### One search of ${whole(runs[0]!.page.config.count)} documents through the searcher, by the program that the pattern runs on, ms\n`)
  console.log(table(['The program of', 'Patterns', ...columns], [8, 16, 32].filter(states => patterns.some(pattern => pattern.states === states)).map(states => row([`${states} states`, String(patterns.filter(pattern => pattern.states === states).length)], search => search.states === states))))
  console.log('\n### The same, by pattern, ms\n')
  console.log(table(['Pattern', 'The search reads', 'States, and the program', 'Documents with a match', ...columns], patterns.map(pattern => row([tick(pattern.pattern), scopeWords[pattern.scope] ?? pattern.scope, `${pattern.patternStates}, ${pattern.states}`, whole(pattern.documentsWithMatches)], search => search.pattern === pattern.pattern && search.scope === pattern.scope))))
  const values = runs.map(run => run.page.searchValues).filter(entry => entry !== undefined)
  console.log(`\nEvery document's match count and the marks of 64 documents, from either writer's shaders: ${whole(values.reduce((total, entry) => total + entry.values, 0))} values in ${values.reduce((total, entry) => total + entry.searches, 0)} searches, ${values.reduce((total, entry) => total + entry.different, 0)} differ.\n`)
}

const validate = runs.flatMap(run => run.page.validate ?? [])
if (validate.length > 0) {
  console.log('### The highlighter\'s pass over every document, ms\n')
  console.log(table(['The highlighter\'s shader, written by', 'Back to back', 'The compute pass alone, timestamps', 'After a pause'], ['loop-emit', 'bit-emit'].map(writer => {
    const mine = validate.filter(entry => entry.writer === writer)
    return [`${writer}.ts`, cell(mine.map(entry => entry.backToBack)), cell(mine.map(entry => entry.passMs)), cell(mine.map(entry => entry.afterPause))]
  })))
  const values = runs.map(run => run.page.highlighterValues).filter(entry => entry !== undefined)
  console.log(`\nThe validation and every display kind, from either writer's shader: ${whole(values.reduce((total, entry) => total + entry.values, 0))} values, ${values.reduce((total, entry) => total + entry.different, 0)} differ.\n`)
}

const stop = runs.flatMap(run => run.page.stopAtLength ?? [])
if (stop.length > 0) {
  console.log('### bit-emit.ts\'s search shader with loops that run every position, and with loops that stop at the text\'s end, ms\n')
  console.log(table(['States', 'The loops', 'Statements', 'Compile', 'Back to back', 'After a pause'], [8, 16, 32].flatMap(states => [false, true].map(stopAtLength => {
    const mine = stop.filter(entry => entry.states === states && entry.stopAtLength === stopAtLength)
    const compiles = [...new Set(mine.map(entry => entry.compileMs!))]
    return [String(states), stopAtLength ? 'stop at the text\'s end' : 'run every position', String(mine[0]?.statements ?? ''), compiles.length === 1 ? digits(compiles[0]!) : `${digits(Math.min(...compiles))} to ${digits(Math.max(...compiles))}`, cell(mine.map(entry => entry.backToBack)), cell(mine.map(entry => entry.afterPause))]
  }))))
  // Every evaluation of either shader counted the same matches, in every run.
  const counted = (states: number, pick: (entry: typeof stop[number]) => number[] | undefined) => [...new Set(stop.filter(entry => entry.states === states).flatMap(entry => pick(entry) ?? []))]
  const totals = [8, 16, 32].map(states => ({everyPosition: counted(states, entry => entry.matchesWithEveryPosition), stopping: counted(states, entry => entry.matchesWithStopping)}))
  const same = totals.every(entry => entry.everyPosition.length === 1 && String(entry.everyPosition) === String(entry.stopping))
  console.log(`\nThe matches that every evaluation of the two shaders counted, at 8, 16 and 32 states: ${totals.map(entry => `${entry.everyPosition.map(whole).join(', ')} and ${entry.stopping.map(whole).join(', ')}`).join('; ')}${same ? ', the same' : ', NOT the same'}.\n`)
}

// Runs the million-document check's runs one after the other, each in its own Chrome, and writes one JSON file per run
// into --out. A run whose file already says that it finished is skipped, so the command can be given again after a
// run that was stopped. summarize.ts prints the report's tables from the folder.
//
//   bun lab/json-search/million/all.ts --out <folder> [--only compact-1000000,js-1000000] [--group compact|program|load|js|warm|rested]
//
// The groups, and the table that each one fills:
//   compact   the hand-written kernels at 100,000 to 1,000,000 documents, the map, and at 100,000 documents the program's
//             own step next to the two rewrites of it
//   program   searcher.ts with loop-emit.ts's search shaders, which the demo page ran when this check was made, at
//             each count, as far as it fits
//   load      the load of a page and its memory, per layout and count
//   js        regular JavaScript on one thread and in 8 workers
//   warm      a search after a pause in which the GPU was kept busy
//   rested    the kernels at a million documents with a rest before each series
import {existsSync, mkdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {argument, required} from '../gpu/chrome.ts'

const out = required('--out')
const only = argument('--only')?.split(',')
const group = argument('--group')
mkdirSync(join(out, 'profiles'), {recursive: true})

const counts = [100_000, 250_000, 500_000, 1_000_000]
const kernels = 'f32-kernel,bytes-boundaries,bytes,bytes-scope,packed,packed-scope,bytes-bits,bytes-has,bytes-scope-has,packed-scope-has'
type Run = {name: string, group: string, args: string[]}
const runs: Run[] = [
  {name: 'compact-1000000', group: 'compact', args: ['--mode', 'compact', '--count', '1000000', '--engines', `${kernels},bytes-split`]},
  {name: 'compact-100000', group: 'compact', args: ['--mode', 'compact', '--count', '100000', '--engines', `${kernels},rewrite-1,rewrite-2,program-step`]},
  {name: 'js-1000000', group: 'js', args: ['--mode', 'js', '--count', '1000000']},
  {name: 'program-1000000', group: 'program', args: ['--mode', 'program', '--count', '1000000', '--search-writer', 'loop-emit']},
  {name: 'program-500000', group: 'program', args: ['--mode', 'program', '--count', '500000', '--search-writer', 'loop-emit']},
  ...counts.toReversed().flatMap(count => [
    {name: `load-fixed-${count}`, group: 'load', args: ['--mode', 'load', '--count', String(count), '--layout', 'fixed', '--keep-texts']},
    {name: `load-packed-${count}`, group: 'load', args: ['--mode', 'load', '--count', String(count), '--layout', 'packed', '--keep-texts']},
  ]),
  // The same load without the texts in the page, and with the device that every browser gives without being asked.
  {name: 'load-fixed-1000000-no-texts', group: 'load', args: ['--mode', 'load', '--count', '1000000', '--layout', 'fixed']},
  {name: 'load-fixed-1000000-default-limits', group: 'load', args: ['--mode', 'load', '--count', '1000000', '--layout', 'fixed', '--limits', 'default']},
  {name: 'compact-500000', group: 'compact', args: ['--mode', 'compact', '--count', '500000', '--engines', kernels]},
  {name: 'compact-250000', group: 'compact', args: ['--mode', 'compact', '--count', '250000', '--engines', kernels]},
  {name: 'program-250000', group: 'program', args: ['--mode', 'program', '--count', '250000', '--search-writer', 'loop-emit']},
  {name: 'program-100000', group: 'program', args: ['--mode', 'program', '--count', '100000', '--search-writer', 'loop-emit']},
  {name: 'js-100000', group: 'js', args: ['--mode', 'js', '--count', '100000']},
  // The whole-text search again, with each search also after a pause of 200 ms, as a keystroke would find the CPU.
  {name: 'js-pause-1000000', group: 'js', args: ['--mode', 'js', '--count', '1000000', '--js-parts', 'wholeText,workers', '--js-pause', '200']},
  // The same twice more with only the five ordinary patterns, since the first of these runs differed from the others.
  ...['js-pause-1000000-ordinary', 'js-pause-1000000-ordinary-2'].map(name => ({name, group: 'js', args: ['--mode', 'js', '--count', '1000000', '--js-parts', 'wholeText,workers', '--js-pause', '200', '--patterns', ['error', '[a-z]+Id', '[a-z0-9.]+@[a-z.]+', '\\d\\d\\d\\d-\\d\\d-\\d\\d', 'connection reset'].join('\n')]})),
  // The whole-text search written in other plain ways: with the u flag, which the first runs of this check gave every
  // RegExp, as a loop that counts, and with text.includes for a plain word.
  {name: 'js-forms-1000000', group: 'js', args: ['--mode', 'js', '--count', '1000000', '--js-parts', 'forms']},
  // The kernels at a million documents again, with a rest of 2 s before each series of searches: in the first run the
  // searches of a back to back series got slower one after the other once the GPU had been busy for two minutes.
  {name: 'compact-1000000-rested', group: 'rested', args: ['--mode', 'compact', '--count', '1000000', '--engines', `${kernels},bytes-split`, '--rest', '2000']},
  // The main kernels once more, with a rest of 3 s and series of 15 searches, so that a series ends before the GPU slows.
  {name: 'compact-1000000-short', group: 'rested', args: ['--mode', 'compact', '--count', '1000000', '--engines', 'f32-kernel,bytes,bytes-scope,bytes-has,bytes-scope-has', '--rest', '3000', '--sample-ms', '0', '--samples', '15']},
  // A search after a pause in which the GPU was kept busy with a small search every 16 or 50 ms, for two patterns.
  {name: 'warm-1000000', group: 'warm', args: ['--mode', 'compact', '--count', '1000000', '--engines', 'bytes,bytes-scope-has', '--capacities', '8', '--patterns', 'error\n[a-z]+Id', '--no-f32', '--long-pause-engines', 'bytes,bytes-scope-has', '--warm-pauses', '200:16,1000:16,1000:50']},
  {name: 'scopes-1000000', group: 'load', args: ['--mode', 'scopes', '--count', '1000000']},
  {name: 'scopes-100000', group: 'load', args: ['--mode', 'scopes', '--count', '100000']},
]

for (const run of runs) {
  if (only !== undefined && !only.includes(run.name)) continue
  if (group !== undefined && run.group !== group) continue
  const file = join(out, `${run.name}.json`)
  if (existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as {page?: {finishedAt?: string}}).page?.finishedAt !== undefined) {
    console.log(`${run.name}: already finished`)
    continue
  }
  // A profile folder that no earlier Chrome used.
  const profile = join(out, 'profiles', `${run.name}-${Date.now()}`)
  console.log(`${new Date().toISOString()} ${run.name}`)
  const child = Bun.spawn(['bun', join(import.meta.dir, 'run.ts'), ...run.args, '--profile', profile, '--out', file, ...process.argv.slice(2).filter((_, index, all) => all[index] === '--port' || all[index - 1] === '--port' || all[index] === '--devtools-port' || all[index - 1] === '--devtools-port')], {stdout: 'inherit', stderr: 'inherit'})
  const code = await child.exited
  console.log(`${new Date().toISOString()} ${run.name}: exit ${code}`)
  // The next Chrome starts once the last one's memory is back.
  await Bun.sleep(3000)
}

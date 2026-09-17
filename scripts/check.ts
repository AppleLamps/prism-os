import {existsSync, readdirSync} from 'node:fs'
import {basename, dirname, resolve} from 'node:path'

const root = resolve(import.meta.dir, '..')
const labs = readdirSync(resolve(root, 'lab'), {withFileTypes: true})
  .filter(entry => entry.isDirectory() && existsSync(resolve(root, 'lab', entry.name, 'tsconfig.json')))
  .map(entry => `lab/${entry.name}`)
  .sort()
// lab/ui-exploration has one tsconfig per prototype. The prototypes are type-checked but not
// linted, since some report scripts have any-typed values that oxlint's type-aware rules reject,
// e.g. learned-bits/report.ts.
const prototypes = readdirSync(resolve(root, 'lab/ui-exploration'), {recursive: true, encoding: 'utf8'})
  .filter(path => basename(path) === 'tsconfig.json' && !path.split('/').includes('node_modules'))
  .map(path => `lab/ui-exploration/${dirname(path)}`)
  .sort()
const rootSources = readdirSync(root).filter(name => name.endsWith('.ts'))
const commands = [
  ['bunx', 'tsgo', '-p', '.'],
  ...[...labs, ...prototypes].map(lab => ['bunx', 'tsgo', '-p', lab]),
  ['bunx', 'oxlint', '--type-aware', ...rootSources, 'src', 'tests', 'scripts', 'template', ...labs],
]

// Most of these commands are small tsgo processes, so the check runs 8 at a time: about 2.6 s
// instead of 11 s one at a time on an 18-core machine, with about 2.2 GB of memory at peak, where
// all 48 at once take about 12 GB. Every command runs even when another one fails, so one run
// reports every failure. Each command's output is printed after all of them finish, in the order
// of the list above.
const maxConcurrentCommands = 8
const results: {stdout: string, stderr: string, exitCode: number}[] = []
let nextIndex = 0
async function runNextCommands() {
  while (nextIndex < commands.length) {
    const index = nextIndex++
    const child = Bun.spawn(commands[index]!, {cwd: root, stdout: 'pipe', stderr: 'pipe'})
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    results[index] = {stdout, stderr, exitCode}
  }
}
await Promise.all(Array.from({length: maxConcurrentCommands}, runNextCommands))

let firstFailedExitCode = 0
for (const [index, command] of commands.entries()) {
  const {stdout, stderr, exitCode} = results[index]!
  console.log(command.join(' '))
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  if (exitCode !== 0 && firstFailedExitCode === 0) firstFailedExitCode = exitCode
}
process.exit(firstFailedExitCode)

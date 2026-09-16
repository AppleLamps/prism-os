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

function run(command: string[]) {
  console.log(command.join(' '))
  const result = Bun.spawnSync(command, {cwd: root, stdout: 'inherit', stderr: 'inherit'})
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

run(['bunx', 'tsgo', '-p', '.'])
for (const lab of [...labs, ...prototypes]) run(['bunx', 'tsgo', '-p', lab])
const rootSources = readdirSync(root).filter(name => name.endsWith('.ts'))
run(['bunx', 'oxlint', '--type-aware', ...rootSources, 'scripts', 'template', ...labs])

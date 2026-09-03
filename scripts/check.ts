import {existsSync, readdirSync} from 'node:fs'
import {resolve} from 'node:path'

const root = resolve(import.meta.dir, '..')
const labs = readdirSync(resolve(root, 'lab'), {withFileTypes: true})
  .filter(entry => entry.isDirectory() && existsSync(resolve(root, 'lab', entry.name, 'tsconfig.json')))
  .map(entry => `lab/${entry.name}`)
  .sort()

function run(command: string[]) {
  console.log(command.join(' '))
  const result = Bun.spawnSync(command, {cwd: root, stdout: 'inherit', stderr: 'inherit'})
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

run(['bunx', 'tsgo', '-p', '.'])
for (const lab of labs) run(['bunx', 'tsgo', '-p', lab])
const rootSources = readdirSync(root).filter(name => name.endsWith('.ts'))
const labSources = readdirSync(resolve(root, 'lab')).filter(name => name.endsWith('.ts')).map(name => `lab/${name}`)
run(['bunx', 'oxlint', '--type-aware', ...rootSources, ...labSources, 'scripts', ...labs])

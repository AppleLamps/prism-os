// The Terminal app's commands, apart from its window: each line runs against a small
// set of actions that the shell provides, and returns the lines to print.
import {type AccentName, type Appearance, type SceneName, accents, appearances, scenes} from './settings.ts'

export type AppInfo = {id: string, name: string, kind: 'program' | 'panel'}

export type TerminalActions = {
  apps: readonly AppInfo[]
  open(id: string): void
  close(id: string): boolean
  setAppearance(appearance: Appearance): void
  setAccent(accent: AccentName): void
  setScene(scene: SceneName): void
  setMotion(on: boolean): void
  setArcs(on: boolean): void
  // The program's sizes as Scope's footer shows them, e.g. ["130 layers", "9,909 weights"].
  programFacts(): readonly string[]
  now(): Date
  startedAt: Date
}

export type TerminalResult = {lines: string[], clear?: boolean}

const help = [
  'Commands:',
  '  apps                 list the apps',
  '  open <app>           open an app, e.g. open scope',
  '  close <app>          close a Prism app, e.g. close clock',
  '  theme <mode>         auto, light or dark',
  '  accent <color>       ' + Object.keys(accents).join(', '),
  '  wallpaper <scene>    ' + Object.keys(scenes).join(', '),
  '  motion on|off        the wallpaper\'s drift',
  '  arcs on|off          the program\'s weight arcs on the desk',
  '  stats                the handwired program\'s sizes',
  '  neofetch             this system at a glance',
  '  date, uptime, whoami, echo <text>, clear, help',
]

function findApp(apps: readonly AppInfo[], name: string | undefined) {
  if (name === undefined) return undefined
  const wanted = name.toLowerCase()
  return apps.find(app => app.id === wanted || app.name.toLowerCase() === wanted)
}

function onOff(word: string | undefined): boolean | null {
  if (word === 'on' || word === 'true' || word === '1') return true
  if (word === 'off' || word === 'false' || word === '0') return false
  return null
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`
  if (minutes > 0) return `${minutes}m ${rest}s`
  return `${rest}s`
}

export function runCommand(line: string, actions: TerminalActions): TerminalResult {
  const words = line.trim().split(/\s+/).filter(word => word !== '')
  const [command, ...rest] = words
  if (command === undefined) return {lines: []}
  const argument = rest[0]?.toLowerCase()
  switch (command.toLowerCase()) {
    case 'help':
      return {lines: help}
    case 'clear':
      return {lines: [], clear: true}
    case 'apps':
    case 'ls':
      return {lines: actions.apps.map(app => `${app.name.padEnd(12)}${app.kind === 'program' ? 'handwired program window' : 'Prism app'}`)}
    case 'open': {
      const app = findApp(actions.apps, argument)
      if (app === undefined) return {lines: [`open: no app named "${rest.join(' ')}". Try: apps`]}
      actions.open(app.id)
      return {lines: [`Opened ${app.name}.`]}
    }
    case 'close': {
      const app = findApp(actions.apps, argument)
      if (app === undefined) return {lines: [`close: no app named "${rest.join(' ')}". Try: apps`]}
      if (app.kind === 'program') return {lines: [`close: ${app.name} is a program window; use its red button.`]}
      return {lines: [actions.close(app.id) ? `Closed ${app.name}.` : `${app.name} isn't open.`]}
    }
    case 'theme':
    case 'appearance':
      if (argument !== undefined && (appearances as readonly string[]).includes(argument)) {
        actions.setAppearance(argument as Appearance)
        return {lines: [`Appearance: ${argument}.`]}
      }
      return {lines: [`usage: theme ${appearances.join('|')}`]}
    case 'accent':
      if (argument !== undefined && Object.hasOwn(accents, argument)) {
        actions.setAccent(argument as AccentName)
        return {lines: [`Accent: ${accents[argument as AccentName].label}.`]}
      }
      return {lines: [`usage: accent ${Object.keys(accents).join('|')}`]}
    case 'wallpaper':
      if (argument !== undefined && Object.hasOwn(scenes, argument)) {
        actions.setScene(argument as SceneName)
        return {lines: [`Wallpaper: ${scenes[argument as SceneName].label}.`]}
      }
      return {lines: [`usage: wallpaper ${Object.keys(scenes).join('|')}`]}
    case 'motion':
    case 'arcs': {
      const on = onOff(argument)
      if (on === null) return {lines: [`usage: ${command.toLowerCase()} on|off`]}
      if (command.toLowerCase() === 'motion') actions.setMotion(on)
      else actions.setArcs(on)
      return {lines: [`${command.toLowerCase() === 'motion' ? 'Wallpaper motion' : 'Weight arcs'} ${on ? 'on' : 'off'}.`]}
    }
    case 'stats': {
      const facts = actions.programFacts()
      return {lines: facts.length === 0 ? ['The program is still loading.'] : ['One handwired program runs the windows:', ...facts.map(fact => `  ${fact}`), '  0 training']}
    }
    case 'date':
      return {lines: [actions.now().toString()]}
    case 'uptime':
      return {lines: [`up ${formatDuration(actions.now().getTime() - actions.startedAt.getTime())}`]}
    case 'whoami':
      return {lines: ['guest']}
    case 'echo':
      return {lines: [rest.join(' ')]}
    case 'neofetch': {
      const facts = actions.programFacts()
      const art = ['     /\\     ', '    /  \\    ', '   / /\\ \\   ', '  / /  \\ \\  ', ' /_/____\\_\\ ']
      const info = [
        'guest@prism',
        '-----------',
        'OS: Prism OS (liquid glass)',
        'Kernel: Handwired, 0 training',
        `Program: ${facts.length > 0 ? facts.join(', ') : 'loading'}`,
        `Uptime: ${formatDuration(actions.now().getTime() - actions.startedAt.getTime())}`,
        `Apps: ${actions.apps.length}`,
      ]
      return {lines: info.map((text, index) => `${art[index] ?? ' '.repeat(12)}  ${text}`)}
    }
    default:
      return {lines: [`${command}: command not found. Try: help`]}
  }
}

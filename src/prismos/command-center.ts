// The command center: a glass panel under the system bar, opened with ⌘K or Ctrl+K or
// the "Ask" button. A sentence goes to the quick parser first (quick-commands.ts), then
// to the model in model-worker.ts, and every call passes the validator in commands.ts
// before the operator (operator.ts) runs it. Under each reply the panel shows the calls
// that ran, so what the model decided is never hidden.
//
// The panel keeps its pointer and key events to itself: the window manager listens on
// the window, and a press in the panel must not reach a window under it, nor an arrow
// key typed in the input turn a page of Chroma.
import {photoNames} from '../handwiredos/photo-gallery.ts'
import {type Command, needsConfirmation, toolDeclarations, validateCall} from './commands.ts'
import {parseModelAnswer} from './function-calls.ts'
import type {Operator} from './operator.ts'
import {quickCommands} from './quick-commands.ts'
import type {WorkerAnswer, WorkerRequest} from './model-worker.ts'

// The fine-tuned model on the Hugging Face Hub, see src/prismos/training. Off until the
// model is trained on the final command list and published as a public repo: until
// then the panel runs quick commands only, with no download offered. ?model=on turns it
// on for one visit, to try a published model; to turn it on for everyone, set this to
// true.
export const modelEnabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('model') === 'on'
export const modelId = 'AppleLampsX/prism-os-functiongemma'
const developerPrompt = 'You are a model that can do function calling with the following functions'
const consentKey = 'prism-os.model-consent'
const transcriptLength = 5

type Entry = {user: string, reply: string, calls: string[], tone: 'normal' | 'error'}
type ModelState =
  | {kind: 'idle'}
  | {kind: 'loading', loaded: number, total: number}
  | {kind: 'ready'}
  | {kind: 'unsupported'}
  | {kind: 'failed', message: string}

const modelSuggestions = [
  'Put Scope and Chroma side by side',
  'Open Blue Lagoon',
  'Write "call the dentist" in my note',
  'Dark mode and a teal accent',
  'How big is the program?',
]
// Each of these is a quick command, see quickSuggestions in tests/prismos/commands.test.ts.
export const quickSuggestions = [
  'Open photo Blue Lagoon',
  'Minimize Inkwell',
  'Dark mode',
  'Make it teal',
  'How big is the program?',
]
const suggestions = modelEnabled ? modelSuggestions : quickSuggestions

function describeCall(command: Command) {
  if (command.name === 'open_photo') return `open_photo(${photoNames[command.photo]})`
  const {name, ...args} = command
  const values = Object.values(args).map(value => (typeof value === 'string' ? value : String(value)))
  return `${name}(${values.join(', ')})`
}

function megabytes(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`
}

export function mountCommandCenter(document: Document, window: Window, operator: Operator, workerUrl: string) {
  const root = document.createElement('div')
  root.className = 'command-center'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Command center')
  root.innerHTML = `
    <form class="command-form">
      <svg class="command-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.75L14.5 13.5h-13z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 1.75v11.75" stroke="currentColor" stroke-width="1.1" opacity="0.6"/></svg>
      <input class="command-input" type="text" autocomplete="off" spellcheck="false" placeholder="Tell Prism OS what to do" aria-label="Command">
    </form>
    <div class="command-body">
      <ol class="command-transcript" aria-live="polite"></ol>
      <div class="command-confirm" hidden>
        <p class="command-confirm-text"></p>
        <div class="command-confirm-actions">
          <button type="button" class="command-button command-cancel">Cancel</button>
          <button type="button" class="command-button command-accept"></button>
        </div>
      </div>
      <ul class="command-suggestions"></ul>
    </div>
    <footer class="command-status">
      <span class="command-status-text"></span>
      <button type="button" class="command-button command-load" hidden>Load model</button>
      <span class="command-progress" hidden><span></span></span>
    </footer>`
  const desktop = document.querySelector<HTMLElement>('#desktop') ?? document.body
  desktop.appendChild(root)

  const query = <Element extends HTMLElement>(selector: string) => {
    const element = root.querySelector<Element>(selector)
    if (element === null) throw new Error(`${selector} is missing`)
    return element
  }
  const form = query<HTMLFormElement>('.command-form')
  const input = query<HTMLInputElement>('.command-input')
  const transcript = query<HTMLOListElement>('.command-transcript')
  const confirmBox = query<HTMLDivElement>('.command-confirm')
  const confirmText = query<HTMLParagraphElement>('.command-confirm-text')
  const acceptButton = query<HTMLButtonElement>('.command-accept')
  const cancelButton = query<HTMLButtonElement>('.command-cancel')
  const suggestionList = query<HTMLUListElement>('.command-suggestions')
  const body = query<HTMLDivElement>('.command-body')
  const statusText = query<HTMLSpanElement>('.command-status-text')
  const loadButton = query<HTMLButtonElement>('.command-load')
  const progress = query<HTMLSpanElement>('.command-progress')

  // The "Ask" button in the system bar.
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'command-trigger'
  const isMac = /Mac|iPhone|iPad/u.test(window.navigator.platform)
  trigger.innerHTML = `Ask Prism <kbd>${isMac ? '⌘' : 'Ctrl+'}K</kbd>`
  trigger.setAttribute('aria-label', 'Open the command center')
  document.querySelector('#system-bar .system-links')?.prepend(trigger)

  for (const element of [root, trigger]) {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'contextmenu', 'keydown']) {
      element.addEventListener(type, event => event.stopPropagation())
    }
  }

  const entries: Entry[] = []
  let modelState: ModelState = {kind: 'idle'}
  let busy = false
  let pendingConfirmation: {command: Command, user: string, rest: Command[]} | null = null

  // --- The model --------------------------------------------------------------------

  let worker: Worker | null = null
  let nextRequest = 1
  const waiting = new Map<number, (answer: WorkerAnswer) => void>()

  function storedConsent() {
    try {
      return window.localStorage.getItem(consentKey) === 'yes'
    } catch {
      return false
    }
  }

  function loadModel() {
    if (worker !== null) return
    try {
      window.localStorage.setItem(consentKey, 'yes')
    } catch {
      // The consent lasts for this visit.
    }
    modelState = {kind: 'loading', loaded: 0, total: 0}
    render()
    worker = new Worker(workerUrl)
    worker.onmessage = (event: MessageEvent<WorkerAnswer>) => {
      const answer = event.data
      if (answer.kind === 'progress') modelState = {kind: 'loading', loaded: answer.loaded, total: answer.total}
      else if (answer.kind === 'ready') modelState = {kind: 'ready'}
      else if (answer.kind === 'error' && answer.id === null) {
        modelState = answer.message === 'no-webgpu' || answer.message === 'no-f16' ? {kind: 'unsupported'} : {kind: 'failed', message: answer.message}
      }
      if ((answer.kind === 'answer' || answer.kind === 'error') && answer.id !== null) {
        waiting.get(answer.id)?.(answer)
        waiting.delete(answer.id)
      }
      render()
    }
    worker.onerror = () => {
      modelState = {kind: 'failed', message: 'the model\'s script didn\'t load'}
      render()
    }
    // ?model-device=wasm runs the model on the CPU instead, slowly: a way to test the
    // command center in a browser whose GPU can't run it.
    const device = new URL(window.location.href).searchParams.get('model-device') === 'wasm' ? 'wasm' : 'webgpu'
    const request: WorkerRequest = {kind: 'load', modelId, tools: [...toolDeclarations], developerPrompt, device}
    worker.postMessage(request)
  }

  function ask(text: string) {
    return new Promise<WorkerAnswer>(resolve => {
      const id = nextRequest++
      waiting.set(id, resolve)
      const request: WorkerRequest = {kind: 'ask', id, text}
      worker?.postMessage(request)
    })
  }

  // --- Running sentences ------------------------------------------------------------

  async function runCommands(user: string, commands: Command[], entry: Entry) {
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index]!
      const question = needsConfirmation(command)
      if (question !== null) {
        pendingConfirmation = {command, user, rest: commands.slice(index + 1)}
        confirmText.textContent = question
        acceptButton.textContent = command.name === 'clear_note' ? 'Erase note' : command.name === 'open_link' ? 'Leave page' : 'Replace note'
        render()
        return
      }
      entry.calls.push(describeCall(command))
      const reply = await operator.run(command)
      entry.reply = entry.reply === '' ? reply : `${entry.reply} ${reply}`
      render()
    }
  }

  async function submit(text: string) {
    const user = text.trim()
    if (user === '' || busy) return
    busy = true
    pendingConfirmation = null
    const entry: Entry = {user, reply: '', calls: [], tone: 'normal'}
    entries.push(entry)
    if (entries.length > transcriptLength) entries.shift()
    input.value = ''
    render()
    try {
      const quick = quickCommands(user)
      if (quick !== null) {
        await runCommands(user, quick, entry)
        return
      }
      if (!modelEnabled) {
        entry.reply = 'I don\'t know that one yet. Try "open chroma", "minimize scope", "dark mode", "make it teal", "open photo 3" or "show desktop".'
        entry.tone = 'error'
        return
      }
      if (modelState.kind !== 'ready') {
        entry.reply = modelState.kind === 'loading'
          ? 'The model is still downloading. Try again in a moment, or use a short command like "dark mode".'
          : modelState.kind === 'unsupported'
            ? 'That needs the model, which this browser or GPU can\'t run. Short commands like "minimize scope" still work.'
            : 'That needs the model. Load it below; it downloads once and runs on this device.'
        entry.tone = 'error'
        return
      }
      entry.reply = 'Thinking…'
      render()
      const answer = await ask(user)
      entry.reply = ''
      if (answer.kind === 'error') {
        entry.reply = `The model failed: ${answer.message}`
        entry.tone = 'error'
        return
      }
      if (answer.kind !== 'answer') return
      const parsed = parseModelAnswer(answer.raw)
      const commands: Command[] = []
      const problems: string[] = []
      for (const call of parsed.calls) {
        const result = validateCall(call.name, call.arguments)
        if (result.ok) commands.push(result.command)
        else problems.push(result.reason)
      }
      if (commands.length > 0) await runCommands(user, commands, entry)
      if (problems.length > 0) {
        entry.reply = [entry.reply, ...problems].filter(part => part !== '').join(' ')
        if (commands.length === 0) entry.tone = 'error'
      }
      if (commands.length === 0 && problems.length === 0) {
        entry.reply = parsed.text === '' ? 'I didn\'t catch that. Try "open chroma" or "dark mode".' : parsed.text
      }
    } finally {
      busy = false
      render()
      input.focus()
    }
  }

  async function confirmPending(accepted: boolean) {
    const pending = pendingConfirmation
    pendingConfirmation = null
    const entry = entries.at(-1)
    if (pending === null || entry === undefined) return
    if (!accepted) {
      entry.reply = entry.reply === '' ? 'Left as it was.' : `${entry.reply} The rest was left as it was.`
      render()
      return
    }
    busy = true
    render()
    entry.calls.push(describeCall(pending.command))
    const reply = await operator.run(pending.command)
    entry.reply = entry.reply === '' ? reply : `${entry.reply} ${reply}`
    await runCommands(pending.user, pending.rest, entry)
    busy = false
    render()
    input.focus()
  }

  // --- Drawing ----------------------------------------------------------------------

  function render() {
    transcript.replaceChildren(...entries.map(entry => {
      const item = document.createElement('li')
      item.className = 'command-entry'
      const user = document.createElement('p')
      user.className = 'command-user'
      user.textContent = entry.user
      const reply = document.createElement('p')
      reply.className = `command-reply${entry.tone === 'error' ? ' is-error' : ''}`
      reply.textContent = entry.reply
      item.append(user, reply)
      if (entry.calls.length > 0) {
        const calls = document.createElement('p')
        calls.className = 'command-calls'
        calls.textContent = entry.calls.join('  ')
        item.append(calls)
      }
      return item
    }))
    transcript.hidden = entries.length === 0
    suggestionList.hidden = entries.length > 0
    if (suggestionList.childElementCount === 0) {
      suggestionList.append(...suggestions.map(text => {
        const item = document.createElement('li')
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'command-suggestion'
        button.textContent = text
        button.addEventListener('click', () => void submit(text))
        item.append(button)
        return item
      }))
    }
    confirmBox.hidden = pendingConfirmation === null
    // The newest exchange, and a question that waits for an answer, stay in view.
    body.scrollTop = body.scrollHeight
    input.disabled = busy && pendingConfirmation === null
    root.classList.toggle('is-busy', busy)

    loadButton.hidden = !modelEnabled || (modelState.kind !== 'idle' && modelState.kind !== 'failed')
    loadButton.textContent = modelState.kind === 'failed' ? 'Try again' : 'Load model'
    progress.hidden = modelState.kind !== 'loading'
    switch (modelState.kind) {
      case 'idle':
        statusText.textContent = modelEnabled
          ? 'Short commands work now. Load the model for everything else: about 425 MB, downloaded once.'
          : 'Short commands for windows, photos, the note and settings. Everything runs in your browser.'
        break
      case 'loading': {
        const {loaded, total} = modelState
        const share = total > 0 ? loaded / total : 0
        progress.style.setProperty('--progress', `${share}`)
        statusText.textContent = total > 0 ? `Downloading the model: ${megabytes(loaded)} of ${megabytes(total)}` : 'Starting the model…'
        break
      }
      case 'ready':
        statusText.textContent = 'The model runs on this device. Nothing you type leaves your browser.'
        break
      case 'unsupported':
        statusText.textContent = 'This browser or GPU can\'t run the model (it needs WebGPU with 16-bit floats), so only short commands work. Chrome or Edge on most Macs and recent PCs can.'
        break
      case 'failed':
        statusText.textContent = `The model didn't load: ${modelState.message}`
        break
    }
  }

  // --- Opening and closing ----------------------------------------------------------

  const isClosed = () => root.hidden === true

  function open() {
    root.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    if (modelEnabled && storedConsent()) loadModel()
    render()
    input.focus()
  }

  function close() {
    root.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    trigger.focus({preventScroll: true})
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    void submit(input.value)
  })
  acceptButton.addEventListener('click', () => void confirmPending(true))
  cancelButton.addEventListener('click', () => void confirmPending(false))
  loadButton.addEventListener('click', () => {
    worker?.terminate()
    worker = null
    loadModel()
  })
  trigger.addEventListener('click', () => (isClosed() ? open() : close()))
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  // ⌘K or Ctrl+K anywhere, also from the note, toggles the panel.
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (isClosed()) open()
      else close()
    }
  }, true)
  // A press outside the panel closes it and goes on to the desktop as usual.
  window.addEventListener('pointerdown', event => {
    if (!isClosed() && event.target instanceof Node && !root.contains(event.target) && !trigger.contains(event.target)) close()
  }, true)

  render()
  return {open, close, submit}
}

// The slideshow: the next photo every few seconds until a command, a key or a press stops
// it. Each step goes through the operator, so it waits for the zoom of the last one.
export function createSlideshow(window: Window, step: () => Promise<unknown>, intervalMs: number) {
  let timer: number | null = null
  let stepping = false
  const stop = () => {
    if (timer !== null) window.clearInterval(timer)
    timer = null
  }
  return {
    start() {
      stop()
      timer = window.setInterval(() => {
        if (stepping) return
        stepping = true
        void step().finally(() => {
          stepping = false
        })
      }, intervalMs)
    },
    stop,
    running: () => timer !== null,
  }
}

// Spotlight's commands: what makes Prism OS's Spotlight (shell.ts) run sentences as well
// as find apps. As you type, a sentence that the quick parser (quick-commands.ts) reads
// shows as the first result, with the calls it will run; Enter runs them and Spotlight
// stays open with the reply. Later, the model in model-worker.ts takes the sentences the
// patterns don't cover. Every call passes the validator in commands.ts before the operator
// (operator.ts) runs it, and the reply lists the calls that ran, so what was decided is
// never hidden.
import {photoNames} from '../handwiredos/photo-gallery.ts'
import {type Command, needsConfirmation, toolDeclarations, validateCall} from './commands.ts'
import {el, button} from './dom.ts'
import {parseModelAnswer} from './function-calls.ts'
import type {WorkerAnswer, WorkerRequest} from './model-worker.ts'
import type {Operator} from './operator.ts'
import {isHelpQuestion, quickCommands} from './quick-commands.ts'

// The fine-tuned model on the Hugging Face Hub, see src/prismos/training. Off until the
// model is trained on the final command list and published as a public repo: until
// then Spotlight runs quick commands only, with no download offered. ?model=on turns it
// on for one visit, to try a published model; to turn it on for everyone, set this to
// true.
export const modelEnabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('model') === 'on'
export const modelId = 'AppleLampsX/prism-os-functiongemma'
const developerPrompt = 'You are a model that can do function calling with the following functions'
const consentKey = 'prism-os.model-consent'
const transcriptLength = 3

export const helpReply = 'Type what you want, e.g. "open cabinet", "list files in /Documents", "create document /Documents/Plan.txt", "search files for Plan", "open calculator", "put Scope and Chroma side by side", "move Inkwell to the top right", "open Blue Lagoon", "note: buy milk", "dark mode and a teal accent", "lagoon wallpaper", "what time is it in Tokyo", "start the stopwatch", "what is 17 times 23" or "how big is the program".'

// What Spotlight shows for a query before it runs: the commands the quick parser read, a
// question about what Spotlight can do, a sentence for the model, or nothing.
export type Preview =
  | {kind: 'commands', commands: Command[], calls: string}
  | {kind: 'help'}
  | {kind: 'model'}
  | null

export function describeCall(command: Command) {
  if (command.name === 'open_photo') return `open_photo(${photoNames[command.photo]})`
  const {name, ...args} = command
  const values = Object.values(args).map(value => (typeof value === 'string' ? value : String(value)))
  return `${name}(${values.join(', ')})`
}

export function previewSentence(query: string): Preview {
  const text = query.trim()
  if (text === '') return null
  if (isHelpQuestion(text)) return {kind: 'help'}
  const commands = quickCommands(text)
  if (commands !== null) return {kind: 'commands', commands, calls: commands.map(describeCall).join('  ')}
  // A sentence of two words or more may be for the model; one word is a search.
  return modelEnabled && /\s/u.test(text) ? {kind: 'model'} : null
}

type Entry = {user: string, reply: string, calls: string[], tone: 'normal' | 'error'}
type ModelState =
  | {kind: 'idle'}
  | {kind: 'loading', loaded: number, total: number}
  | {kind: 'ready'}
  | {kind: 'unsupported'}
  | {kind: 'failed', message: string}

function megabytes(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`
}

// The part of Spotlight's sheet under the results: the last exchanges, a question that
// waits for an answer, and, with the model on, its status.
export function createCommandCenter(window: Window, workerUrl: string) {
  const root = el('div', 'spotlight-commands')
  const transcript = el('ol', 'spotlight-transcript')
  transcript.setAttribute('aria-live', 'polite')
  const confirmBox = el('div', 'spotlight-confirm')
  const confirmText = el('p', 'spotlight-confirm-text')
  const cancelButton = button('prism-button', 'Cancel', 'Cancel')
  const acceptButton = button('prism-button spotlight-accept', 'Confirm', 'Confirm')
  const confirmActions = el('div', 'spotlight-confirm-actions')
  confirmActions.append(cancelButton, acceptButton)
  confirmBox.append(confirmText, confirmActions)
  const status = el('footer', 'spotlight-status')
  const statusText = el('span', 'spotlight-status-text')
  const loadButton = button('prism-button', 'Load model', 'Load model')
  const progress = el('span', 'spotlight-progress')
  progress.append(el('span'))
  status.append(statusText, loadButton, progress)
  root.append(transcript, confirmBox, status)

  let operator: Operator | null = null
  const entries: Entry[] = []
  let busy = false
  let pending: {command: Command, rest: Command[], entry: Entry} | null = null
  let modelState: ModelState = {kind: 'idle'}
  let afterRender: () => void = () => {}

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
    if (!modelEnabled || worker !== null) return
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
    // ?model-device=wasm runs the model on the CPU instead, slowly: a way to test on a
    // machine whose GPU can't run it.
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

  // --- Running ----------------------------------------------------------------------

  async function runCommands(commands: Command[], entry: Entry) {
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index]!
      const question = needsConfirmation(command)
      if (question !== null) {
        pending = {command, rest: commands.slice(index + 1), entry}
        confirmText.textContent = question
        acceptButton.textContent = command.name === 'clear_note' ? 'Erase note' : 'Replace note'
        render()
        acceptButton.focus({preventScroll: true})
        return
      }
      if (operator === null) {
        entry.reply = 'Prism OS is still starting. Try again in a moment.'
        entry.tone = 'error'
        return
      }
      entry.calls.push(describeCall(command))
      const reply = await operator.run(command)
      entry.reply = entry.reply === '' ? reply : `${entry.reply} ${reply}`
      render()
    }
  }

  async function run(query: string) {
    const user = query.trim()
    if (user === '' || busy) return
    busy = true
    pending = null
    const entry: Entry = {user, reply: '', calls: [], tone: 'normal'}
    entries.push(entry)
    if (entries.length > transcriptLength) entries.shift()
    render()
    try {
      const preview = previewSentence(user)
      if (preview?.kind === 'help') {
        entry.reply = helpReply
        return
      }
      if (preview?.kind === 'commands') {
        await runCommands(preview.commands, entry)
        return
      }
      if (!modelEnabled) {
        entry.reply = `I don't know that one yet. ${helpReply}`
        entry.tone = 'error'
        return
      }
      if (modelState.kind !== 'ready') {
        entry.reply = modelState.kind === 'loading'
          ? 'The model is still downloading. Try again in a moment.'
          : modelState.kind === 'unsupported'
            ? 'That needs the model, which this browser or GPU can\'t run.'
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
      if (commands.length > 0) await runCommands(commands, entry)
      if (problems.length > 0) {
        entry.reply = [entry.reply, ...problems].filter(part => part !== '').join(' ')
        if (commands.length === 0) entry.tone = 'error'
      }
      if (commands.length === 0 && problems.length === 0) {
        entry.reply = parsed.text === '' ? `I didn't catch that. ${helpReply}` : parsed.text
      }
    } finally {
      busy = false
      render()
    }
  }

  async function answerPending(accepted: boolean) {
    const question = pending
    pending = null
    if (question === null) return
    const {entry} = question
    if (!accepted) {
      entry.reply = entry.reply === '' ? 'Left as it was.' : `${entry.reply} The rest was left as it was.`
      render()
      return
    }
    busy = true
    render()
    try {
      if (operator !== null) {
        entry.calls.push(describeCall(question.command))
        const reply = await operator.run(question.command)
        entry.reply = entry.reply === '' ? reply : `${entry.reply} ${reply}`
      }
      await runCommands(question.rest, entry)
    } finally {
      busy = false
      render()
    }
  }

  acceptButton.addEventListener('click', () => void answerPending(true))
  cancelButton.addEventListener('click', () => void answerPending(false))
  loadButton.addEventListener('click', () => {
    worker?.terminate()
    worker = null
    loadModel()
  })

  // --- Drawing ----------------------------------------------------------------------

  function render() {
    transcript.replaceChildren(...entries.map(entry => {
      const item = el('li', 'spotlight-entry')
      item.append(el('p', 'spotlight-user', entry.user), el('p', `spotlight-reply${entry.tone === 'error' ? ' is-error' : ''}`, entry.reply))
      if (entry.calls.length > 0) item.append(el('p', 'spotlight-calls', entry.calls.join('  ')))
      return item
    }))
    transcript.hidden = entries.length === 0
    confirmBox.hidden = pending === null
    root.classList.toggle('is-busy', busy)
    status.hidden = !modelEnabled
    loadButton.hidden = modelState.kind !== 'idle' && modelState.kind !== 'failed'
    loadButton.textContent = modelState.kind === 'failed' ? 'Try again' : 'Load model'
    progress.hidden = modelState.kind !== 'loading'
    switch (modelState.kind) {
      case 'idle':
        statusText.textContent = 'Short commands work now. Load the model for everything else: about 425 MB, downloaded once.'
        break
      case 'loading': {
        const {loaded, total} = modelState
        progress.style.setProperty('--progress', `${total > 0 ? loaded / total : 0}`)
        statusText.textContent = total > 0 ? `Downloading the model: ${megabytes(loaded)} of ${megabytes(total)}` : 'Starting the model…'
        break
      }
      case 'ready':
        statusText.textContent = 'The model runs on this device. Nothing you type leaves your browser.'
        break
      case 'unsupported':
        statusText.textContent = 'This browser or GPU can\'t run the model (it needs WebGPU with 16-bit floats), so only short commands work.'
        break
      case 'failed':
        statusText.textContent = `The model didn't load: ${modelState.message}`
        break
    }
    afterRender()
  }

  render()
  return {
    element: root,
    run,
    // Spotlight opened: with the visitor's earlier consent, the model starts loading.
    opened() {
      if (modelEnabled && storedConsent()) loadModel()
      render()
    },
    busy: () => busy,
    hasPendingQuestion: () => pending !== null,
    setOperator(next: Operator) {
      operator = next
    },
    onRender(callback: () => void) {
      afterRender = callback
    },
  }
}

export type CommandCenter = ReturnType<typeof createCommandCenter>

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

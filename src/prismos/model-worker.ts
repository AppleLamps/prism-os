// The command center's model, in a worker so that tokenizing and running the network
// never stall the page's frames. It loads Transformers.js from a CDN and the fine-tuned
// FunctionGemma from the Hugging Face Hub, runs on WebGPU, and answers one sentence at a
// time with the model's raw text, which the page parses (function-calls.ts) and
// validates (commands.ts). The browser caches the files after the first download.
//
// The demo site builds this file on its own, as one script that imports nothing, see
// siteWorkers in scripts/demo-site-pages.ts. So the tools arrive in the load message
// instead of an import.

export type WorkerRequest =
  | {kind: 'load', modelId: string, tools: unknown[], developerPrompt: string, device: 'webgpu' | 'wasm'}
  | {kind: 'ask', id: number, text: string}

export type WorkerAnswer =
  | {kind: 'progress', loaded: number, total: number}
  | {kind: 'ready', device: string}
  | {kind: 'answer', id: number, raw: string, milliseconds: number}
  | {kind: 'error', id: number | null, message: string}

// Pinned, so a new release can't change how the model runs under the page.
const transformersUrl = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm'
// FunctionGemma's ends: <eos>, <start_function_response> and <end_of_turn>.
const stopTokens = [1, 50, 106]
// Three calls with an address or a search fit in about 90 tokens; a YouTube link's id
// takes a token for nearly every letter.
const maximumNewTokens = 160

type Tokenizer = {
  apply_chat_template(messages: unknown[], options: Record<string, unknown>): {input_ids: {dims: number[]}}
  decode(ids: unknown, options: Record<string, unknown>): string
}
type Model = {generate(options: Record<string, unknown>): Promise<{slice(...ranges: unknown[]): unknown}>}

const scope = globalThis as unknown as {
  postMessage(message: WorkerAnswer): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}
const send = (message: WorkerAnswer) => scope.postMessage(message)

let tokenizer: Tokenizer | null = null
let model: Model | null = null
let tools: unknown[] = []
let developerPrompt = ''
// One request at a time: a second sentence waits for the first.
let queue: Promise<void> = Promise.resolve()

async function load(request: Extract<WorkerRequest, {kind: 'load'}>) {
  const {device} = request
  // The model's activations are fp16, which a WebGPU device runs only with the
  // shader-f16 feature, e.g. most Macs and recent Windows GPUs have it.
  const navigator = globalThis.navigator as unknown as {gpu?: {requestAdapter(): Promise<{features: Set<string>} | null>}}
  if (device === 'webgpu') {
    const adapter = navigator.gpu === undefined ? null : await navigator.gpu.requestAdapter()
    if (adapter === null || !adapter.features.has('shader-f16')) {
      send({kind: 'error', id: null, message: adapter === null ? 'no-webgpu' : 'no-f16'})
      return
    }
  }
  // A variable, so the bundler leaves the CDN import to the browser.
  const url = transformersUrl
  const library = await import(url) as {
    AutoTokenizer: {from_pretrained(id: string, options?: Record<string, unknown>): Promise<Tokenizer>}
    AutoModelForCausalLM: {from_pretrained(id: string, options: Record<string, unknown>): Promise<Model>}
  }
  tools = request.tools
  developerPrompt = request.developerPrompt
  // Each file reports its own bytes. The sum over the files seen so far is the progress.
  const files = new Map<string, {loaded: number, total: number}>()
  const progress = (event: {status?: string, file?: string, loaded?: number, total?: number}) => {
    if (event.status !== 'progress' || event.file === undefined) return
    files.set(event.file, {loaded: event.loaded ?? 0, total: event.total ?? 0})
    let loaded = 0
    let total = 0
    for (const file of files.values()) {
      loaded += file.loaded
      total += file.total
    }
    send({kind: 'progress', loaded, total})
  }
  tokenizer = await library.AutoTokenizer.from_pretrained(request.modelId, {progress_callback: progress})
  model = await library.AutoModelForCausalLM.from_pretrained(request.modelId, {dtype: 'q4f16', device, progress_callback: progress})
  // A first run compiles the GPU's shaders, so the visitor's first sentence doesn't pay for it.
  await generate('hi')
  send({kind: 'ready', device})
}

async function generate(text: string) {
  if (tokenizer === null || model === null) throw new Error('the model is not loaded')
  const messages = [{role: 'developer', content: developerPrompt}, {role: 'user', content: text}]
  const inputs = tokenizer.apply_chat_template(messages, {tools, tokenize: true, add_generation_prompt: true, return_dict: true})
  const output = await model.generate({...inputs, max_new_tokens: maximumNewTokens, do_sample: false, eos_token_id: stopTokens})
  const promptLength = inputs.input_ids.dims[1]!
  return tokenizer.decode(output.slice(0, [promptLength, null]), {skip_special_tokens: false})
}

scope.onmessage = event => {
  const request = event.data
  queue = queue.then(async () => {
    if (request.kind === 'load') {
      try {
        await load(request)
      } catch (error) {
        send({kind: 'error', id: null, message: error instanceof Error ? error.message : String(error)})
      }
      return
    }
    const started = performance.now()
    try {
      const raw = await generate(request.text)
      send({kind: 'answer', id: request.id, raw, milliseconds: performance.now() - started})
    } catch (error) {
      send({kind: 'error', id: request.id, message: error instanceof Error ? error.message : String(error)})
    }
  })
}

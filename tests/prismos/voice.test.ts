import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {createVoice, onlineConsentKey, transcriptOf, voiceErrorMessage, voiceLanguage, type Recognition, type RecognitionClass, type RecognitionErrorEvent, type RecognitionResultEvent, type VoiceView} from '../../src/prismos/voice.ts'

// A recognizer that records how it was set up and lets the test speak into it.
function fakeRecognition(availability?: string, installs = true) {
  const made: FakeRecognition[] = []
  class FakeRecognition implements Recognition {
    lang = ''
    interimResults = false
    continuous = true
    maxAlternatives = 0
    processLocally?: boolean
    started = false
    stopped = false
    onresult: ((event: RecognitionResultEvent) => void) | null = null
    onerror: ((event: RecognitionErrorEvent) => void) | null = null
    onend: (() => void) | null = null
    constructor() { made.push(this) }
    start() { this.started = true }
    stop() { this.stopped = true; this.onend?.() }
    abort() { this.stopped = true }
    say(words: string[], final: boolean) {
      this.onresult?.({results: words.map(transcript => Object.assign([{transcript}], {isFinal: final}))})
    }
  }
  const Class = FakeRecognition as unknown as RecognitionClass
  if (availability !== undefined) {
    Class.available = async () => availability
    Class.install = async () => installs
  }
  return {Class, made}
}

function memoryStorage() {
  const saved = new Map<string, string>()
  return {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), saved} as unknown as Storage & {saved: Map<string, string>}
}

function setup(availability?: string, installs?: boolean) {
  const fake = fakeRecognition(availability, installs)
  const storage = memoryStorage()
  const heard: [string, boolean][] = []
  const views: VoiceView[] = []
  const voice = createVoice({Recognition: fake.Class, storage, language: 'en-US', onText: (text, final) => heard.push([text, final]), onChange: view => views.push(view)})
  return {voice, fake, storage, heard, views}
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('with an on-device pack, Voice listens locally and writes what it hears', async () => {
  const {voice, fake, heard} = setup('available')
  voice.toggle()
  await settle()
  const [recognition] = fake.made
  assert.ok(recognition?.started)
  assert.equal(recognition.processLocally, true)
  assert.equal(recognition.interimResults, true)
  assert.deepEqual(voice.view().state, {kind: 'listening', local: true})
  recognition.say(['close inkwell', ' open safari'], false)
  recognition.say(['close inkwell', ' open safari and search for youtube'], true)
  assert.deepEqual(heard, [['close inkwell open safari', false], ['close inkwell open safari and search for youtube', true]])
  voice.toggle()
  assert.ok(recognition.stopped)
  assert.deepEqual(voice.view(), {state: {kind: 'idle'}, message: null})
})

test('a pack to download is asked for first, then used', async () => {
  const {voice, fake} = setup('downloadable')
  voice.toggle()
  await settle()
  assert.deepEqual(voice.view().state, {kind: 'question', question: 'install'})
  assert.equal(fake.made.length, 0)
  voice.answer(true)
  await settle()
  assert.equal(fake.made[0]?.processLocally, true)
  assert.equal(voice.view().state.kind, 'listening')
})

test('the online service is used only after consent, which is remembered', async () => {
  const {voice, fake, storage} = setup('unavailable')
  voice.toggle()
  await settle()
  assert.deepEqual(voice.view().state, {kind: 'question', question: 'online'})
  voice.answer(false)
  assert.equal(fake.made.length, 0)
  voice.toggle()
  await settle()
  voice.answer(true)
  assert.equal(storage.saved.get(onlineConsentKey), 'yes')
  assert.equal(fake.made[0]?.processLocally, undefined)
  fake.made[0]?.stop()
  voice.toggle()
  await settle()
  assert.equal(voice.view().state.kind, 'listening')
  assert.equal(fake.made.length, 2)
})

test('a browser without on-device recognition asks before going online', async () => {
  const {voice} = setup()
  voice.toggle()
  assert.deepEqual(voice.view().state, {kind: 'question', question: 'online'})
})

test('errors become short messages, and closing Spotlight stops listening', async () => {
  const {voice, fake} = setup('available')
  voice.toggle()
  await settle()
  fake.made[0]?.onerror?.({error: 'not-allowed'})
  assert.match(voice.view().message ?? '', /microphone is blocked/u)
  assert.equal(voice.view().state.kind, 'idle')
  voice.toggle()
  await settle()
  voice.stop()
  assert.ok(fake.made[1]?.stopped)
  assert.deepEqual(voice.view(), {state: {kind: 'idle'}, message: null})
  assert.equal(voiceErrorMessage('aborted'), null)
})

test('helpers: the language, and a transcript of several results', () => {
  assert.equal(voiceLanguage('en-GB'), 'en-GB')
  assert.equal(voiceLanguage('fr-FR'), 'en-US')
  assert.equal(voiceLanguage(undefined), 'en-US')
  assert.equal(voiceLanguage('en-US@posix'), 'en-US')
  assert.equal(voiceLanguage('english'), 'en-US')
  assert.deepEqual(transcriptOf({results: []}), {text: '', final: false})
})

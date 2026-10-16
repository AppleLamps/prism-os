// Voice: what's said into Spotlight, as text in its search field. The shell draws the
// microphone and the questions, see startShell; this file decides how to listen.
//
// Browsers recognize speech in one of two places. Chrome and Edge (139 and later) can
// recognize it on the device, once they have downloaded a language pack, and then the
// audio never leaves the computer, as the model never does. Otherwise the browser sends
// the audio to its maker's online service (Google's for Chrome, Apple's for Safari). So
// Voice listens on the device whenever it can, asks before the browser downloads the
// pack, and asks before the first use of the online service, which it remembers. A
// browser with neither (Firefox) shows no microphone.

// The parts of the Web Speech API that Voice uses. The DOM library's types don't have
// on-device recognition yet.
type RecognitionAlternative = {transcript: string}
type RecognitionResult = ArrayLike<RecognitionAlternative> & {isFinal: boolean}
export type RecognitionResultEvent = {results: ArrayLike<RecognitionResult>}
export type RecognitionErrorEvent = {error: string}
export type Recognition = {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  processLocally?: boolean
  onresult: ((event: RecognitionResultEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type LanguageOptions = {langs: string[], processLocally: boolean}
export type RecognitionClass = (new () => Recognition) & {
  available?(options: LanguageOptions): Promise<string>
  install?(options: LanguageOptions): Promise<boolean>
}

export function recognitionClass(window: Window): RecognitionClass | null {
  const scope = window as unknown as {SpeechRecognition?: RecognitionClass, webkitSpeechRecognition?: RecognitionClass}
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

// Spotlight's commands are English, so Voice listens for the visitor's English, or for
// American English. Some systems report a locale, e.g. "en-US@posix", which isn't a
// language tag.
export function voiceLanguage(language: string | undefined): string {
  const tag = language?.split(/[@.]/u)[0] ?? ''
  return /^en(?:-[a-z0-9]{2,8})*$/iu.test(tag) ? tag : 'en-US'
}

// Where the online service's consent is kept.
export const onlineConsentKey = 'prism-os.voice-online'

export type VoiceState =
  | {kind: 'idle'}
  | {kind: 'checking'}
  | {kind: 'listening', local: boolean}
  | {kind: 'question', question: 'install' | 'online'}
  | {kind: 'installing'}

export type VoiceView = {state: VoiceState, message: string | null}

export const voiceQuestions = {
  install: {text: 'Your browser can recognize speech on this device, so nothing you say leaves it. It needs a one-time speech download first.', accept: 'Download', decline: 'Not now'},
  online: {text: 'This browser recognizes speech with its maker\'s online service, so what you say is sent there to become text.', accept: 'Use it', decline: 'Cancel'},
} as const

// What each recognition error means to the visitor, or null for one that needs no word.
export function voiceErrorMessage(error: string): string | null {
  switch (error) {
    case 'aborted': return null
    case 'no-speech': return 'I didn\'t hear anything. Try again a little closer to the microphone.'
    case 'not-allowed':
    case 'service-not-allowed': return 'The microphone is blocked for this site. Allow it in the browser\'s site settings, then try again.'
    case 'audio-capture': return 'No microphone was found.'
    case 'network': return 'Speech recognition needs an internet connection in this browser.'
    case 'language-not-supported': return 'This browser can\'t recognize English speech.'
    default: return 'Speech recognition stopped. Try again.'
  }
}

// The text so far of a recognition's results, and whether it's final.
export function transcriptOf(event: RecognitionResultEvent): {text: string, final: boolean} {
  const results = Array.from(event.results)
  const text = results.map(result => result[0]?.transcript ?? '').join('').replace(/\s+/gu, ' ').trim()
  return {text, final: results.length > 0 && results.every(result => result.isFinal)}
}

type VoiceOptions = {
  Recognition: RecognitionClass
  storage: Storage | null
  language: string
  // The words heard so far; `final` once the speaker stopped.
  onText: (text: string, final: boolean) => void
  onChange: (view: VoiceView) => void
}

export function createVoice({Recognition, storage, language, onText, onChange}: VoiceOptions) {
  let view: VoiceView = {state: {kind: 'idle'}, message: null}
  let recognition: Recognition | null = null
  // Consent given in this visit, for a storage that can't keep it.
  let consentedNow = false
  const options = (): LanguageOptions => ({langs: [language], processLocally: true})

  const set = (state: VoiceState, message: string | null = null) => {
    view = {state, message}
    onChange(view)
  }

  const consented = () => {
    if (consentedNow) return true
    try {
      return storage?.getItem(onlineConsentKey) === 'yes'
    } catch {
      return false
    }
  }

  function listen(local: boolean) {
    const heard = new Recognition()
    recognition = heard
    heard.lang = language
    heard.interimResults = true
    heard.continuous = false
    heard.maxAlternatives = 1
    if (local) heard.processLocally = true
    let failed = false
    heard.onresult = event => {
      if (recognition !== heard) return
      const {text, final} = transcriptOf(event)
      onText(text, final)
    }
    heard.onerror = event => {
      if (recognition !== heard) return
      failed = true
      recognition = null
      // A pack the browser reported and then can't use: the online service instead.
      if (local && event.error === 'language-not-supported') {
        online()
        return
      }
      set({kind: 'idle'}, voiceErrorMessage(event.error))
    }
    heard.onend = () => {
      if (recognition !== heard) return
      recognition = null
      if (!failed) set({kind: 'idle'})
    }
    try {
      heard.start()
      set({kind: 'listening', local})
    } catch {
      recognition = null
      set({kind: 'idle'}, voiceErrorMessage('start'))
    }
  }

  function online() {
    if (consented()) listen(false)
    else set({kind: 'question', question: 'online'})
  }

  async function begin() {
    if (Recognition.available === undefined) {
      online()
      return
    }
    set({kind: 'checking'})
    let availability = 'unavailable'
    try {
      availability = await Recognition.available(options())
    } catch {
      // A browser that can't tell, e.g. under a permissions policy, listens online.
    }
    if (view.state.kind !== 'checking') return
    if (availability === 'available') listen(true)
    else if (availability === 'downloadable' || availability === 'downloading') set({kind: 'question', question: 'install'})
    else online()
  }

  async function install() {
    set({kind: 'installing'})
    let installed = false
    try {
      installed = await (Recognition.install?.(options()) ?? Promise.resolve(false))
    } catch {
      // Reported below.
    }
    if (view.state.kind !== 'installing') return
    if (installed) listen(true)
    else set({kind: 'idle'}, 'The speech download didn\'t finish. Try again later.')
  }

  return {
    view: () => view,
    // The microphone's button: starts listening, or stops and keeps what was heard.
    toggle() {
      switch (view.state.kind) {
        case 'listening':
          recognition?.stop()
          return
        case 'idle':
          void begin()
          return
        default:
          return
      }
    },
    // The answer to the question on screen.
    answer(accepted: boolean) {
      if (view.state.kind !== 'question') return
      const {question} = view.state
      if (!accepted) {
        set({kind: 'idle'})
      } else if (question === 'install') {
        void install()
      } else {
        consentedNow = true
        try {
          storage?.setItem(onlineConsentKey, 'yes')
        } catch {
          // The consent lasts for this visit.
        }
        listen(false)
      }
    },
    // Spotlight closed: stop listening and forget any question or message. A download
    // already started keeps going in the browser.
    stop() {
      const heard = recognition
      recognition = null
      heard?.abort()
      if (view.state.kind !== 'idle' || view.message !== null) set({kind: 'idle'})
    },
  }
}


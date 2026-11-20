/**
 * Voice input from the watch: streamed 16 kHz mono PCM, transcribed by the
 * Host's speech service, then delivered as a normal user message.
 *
 * The speech service is optional. Without it the watch still records and shows
 * an explanation; nothing else in the bridge changes.
 */

const MAX_BYTES = 60 * 32000 // 60 s of 16 kHz / 16-bit mono
const MAX_AGE_MS = 120000

export class VoiceBridge {
  /**
   * @param {{ctx: any, send: (message: object) => boolean, logger?: any, language?: string}} options - wiring.
   */
  constructor({ ctx, send, logger, language = 'zh' }) {
    this.ctx = ctx
    this.send = send
    this.logger = logger
    this.language = language
    /** @type {Map<string, {chunks: Buffer[], bytes: number, startedAt: number}>} */
    this.recordings = new Map()
    /** @type {string | null} */
    this.lastSessionId = null
    /** @type {{id: string, text: string} | null} */
    this.lastTranscript = null
    this.disposed = false
  }

  /**
   * Start the one-time model preparation when the plugin loads, so the first
   * press of the right button does not have to wait for a 300 MB download.
   */
  warmup() {
    const speech = this.speech()
    if (speech === null) return
    try {
      const snapshot = speech.snapshot()
      const selected = snapshot.providers.find((provider) => provider.id === snapshot.selection.providerId)
      if (selected === undefined) return
      if (selected.preparation.phase === 'unprepared') {
        this.logger?.info?.(
          'stopwatch-bridge: preparing the local speech model (first run downloads ~300 MB)',
        )
        speech.prepare(selected.id)
      }
    } catch (error) {
      this.logger?.warn?.(`stopwatch-bridge: speech warmup failed: ${error.message}`)
    }
  }

  /**
   * Observe session traffic so `voice_send` knows the active conversation.
   * @param {any} session - session that produced the event.
   * @param {any} event - session event.
   */
  trackSession(session, event) {
    const type = event?.type
    if (type === 'user/message' || type === 'turn/end') {
      if (session?.id !== undefined) this.lastSessionId = String(session.id)
    }
  }

  /**
   * Handle one device message.
   * @param {any} message - protocol message.
   * @returns {boolean} whether the message belonged to voice input.
   */
  handle(message) {
    switch (message.t) {
      case 'voice_start':
        this.start(message)
        return true
      case 'voice_chunk':
        this.chunk(message)
        return true
      case 'voice_end':
        void this.end(message)
        return true
      case 'voice_send':
        this.sendToSession(message)
        return true
      case 'voice_clear':
        this.recordings.delete(String(message.id ?? ''))
        this.lastTranscript = null
        this.status(String(message.id ?? ''), 'cleared', '已清空')
        return true
      default:
        return false
    }
  }

  /** @param {any} message - `voice_start`. */
  start(message) {
    const id = String(message.id ?? '')
    if (id === '') return
    this.recordings.set(id, { chunks: [], bytes: 0, startedAt: Date.now() })
    this.lastTranscript = null
  }

  /** @param {any} message - `voice_chunk`. */
  chunk(message) {
    const id = String(message.id ?? '')
    const entry = this.recordings.get(id)
    if (entry === undefined) return
    if (Date.now() - entry.startedAt > MAX_AGE_MS) {
      this.recordings.delete(id)
      this.status(id, 'error', '录音超时')
      return
    }
    const data = String(message.data ?? '')
    if (data === '') return
    let buffer
    try {
      buffer = Buffer.from(data, 'base64')
    } catch {
      return
    }
    entry.chunks.push(buffer)
    entry.bytes += buffer.length
    if (entry.bytes > MAX_BYTES) {
      this.recordings.delete(id)
      this.status(id, 'error', '录音太长')
    }
  }

  /**
   * Finish a recording and transcribe it.
   * @param {any} message - `voice_end`.
   */
  async end(message) {
    const id = String(message.id ?? '')
    const entry = this.recordings.get(id)
    if (entry === undefined) {
      this.status(id, 'error', '没有录音')
      return
    }
    this.recordings.delete(id)
    const pcm = Buffer.concat(entry.chunks)
    if (pcm.length < 3200) {
      this.status(id, 'error', '太短了')
      return
    }

    const speech = this.speech()
    if (speech === null) {
      this.status(id, 'error', '语音识别未启用')
      return
    }

    const view = this.preparedView(speech)
    if (view === null) {
      this.status(id, 'error', '识别模型未就绪，请先在设置里启用语音输入')
      return
    }

    this.status(id, 'transcribing', '识别中…')
    const started = Date.now()
    try {
      const wav = wrapWav(pcm, 16000, 1, 16)
      const spec = speech.resolve({ audio: new Uint8Array(wav), language: this.language })
      const controller = new AbortController()
      const result = await speech.transcribe(spec, controller.signal)
      const text = String(result?.text ?? '').trim()
      this.lastTranscript = { id, text }
      if (text === '') {
        this.status(id, 'error', '没听清，再说一次')
        return
      }
      this.send({
        t: 'voice_text',
        id,
        text,
        audioMs: Math.round((pcm.length / 2 / 16000) * 1000),
        inferMs: Date.now() - started,
      })
    } catch (error) {
      this.logger?.warn?.(`stopwatch-bridge: transcription failed: ${error.message}`)
      this.status(id, 'error', '识别失败')
    }
  }

  /**
   * Deliver the last transcript into the active conversation.
   * @param {any} message - `voice_send`.
   */
  sendToSession(message) {
    const id = String(message.id ?? '')
    const transcript = this.lastTranscript
    if (transcript === null || transcript.text === '') {
      this.status(id, 'error', '没有可发送的文字')
      return
    }
    const agent = this.targetAgent()
    if (agent === null) {
      this.status(id, 'error', '找不到会话')
      return
    }
    try {
      agent.followup({
        id: `voice-${Date.now().toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text: transcript.text }],
        source: { kind: 'user' },
      })
      this.lastTranscript = null
      this.status(id, 'sent', '已发送')
    } catch (error) {
      this.logger?.warn?.(`stopwatch-bridge: voice send failed: ${error.message}`)
      this.status(id, 'error', '发送失败')
    }
  }

  /** @returns {any | null} the speech service when the Host composes one. */
  speech() {
    // optional service: read it through ctx.get(), never as a property, so the
    // plugin does not need to declare an inject for it
    try {
      return this.ctx?.get?.('speechToText') ?? null
    } catch {
      return null
    }
  }

  /**
   * Check that a provider is registered and past the download phase.
   * @param {any} speech - speech service.
   * @returns {any | null} the ready provider view.
   */
  preparedView(speech) {
    try {
      const snapshot = speech.snapshot()
      const selected = snapshot.providers.find((provider) => provider.id === snapshot.selection.providerId)
      if (selected === undefined) return null
      if (selected.preparation.phase === 'ready' || selected.preparation.phase === 'standby') return selected
      if (selected.preparation.phase === 'unprepared') {
        try {
          speech.prepare(selected.id)
        } catch {
          /* preparation is best effort here */
        }
      }
      return null
    } catch {
      return null
    }
  }

  /** @returns {any | null} the agent that most recently received a user message. */
  targetAgent() {
    const agents = this.ctx?.agents
    if (agents === undefined) return null
    if (this.lastSessionId !== null) {
      const agent = agents.get?.(this.lastSessionId)
      if (agent !== undefined && agent !== null) return agent
    }
    const list = agents.list?.() ?? []
    return list.length > 0 ? list[0] : null
  }

  /**
   * Send a status frame back to the watch.
   * @param {string} id - recording identity.
   * @param {string} state - `transcribing` | `sent` | `cleared` | `error`.
   * @param {string} message - short text for the screen.
   */
  status(id, state, message) {
    this.send({ t: 'voice_status', id, state, message })
  }

  /** Drop buffers and stop accepting input. */
  dispose() {
    this.disposed = true
    this.recordings.clear()
  }
}

/**
 * Wrap raw PCM in a canonical 44-byte WAV header.
 * @param {Buffer} pcm - little-endian samples.
 * @param {number} rate - samples per second.
 * @param {number} channels - channel count.
 * @param {number} bits - bits per sample.
 * @returns {Buffer} complete WAV file.
 */
export function wrapWav(pcm, rate, channels, bits) {
  const blockAlign = (channels * bits) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

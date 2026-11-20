import test from 'node:test'
import assert from 'node:assert/strict'
import { VoiceBridge, wrapWav } from '../src/voice.js'

/**
 * Build a voice bridge with a fake Host wiring.
 * @param {object} [options] - overrides.
 * @returns {any} harness.
 */
function setup(options = {}) {
  const sent = []
  const followed = []
  const ctx = {
    speechToText: options.speech ?? {
      snapshot: () => ({ providers: [{ id: 'sense', preparation: { phase: 'ready' } }], selection: { providerId: 'sense', language: 'zh' } }),
      resolve: (request) => ({ ...request, provider: { info: { id: 'sense' } } }),
      transcribe: async () => ({ text: '把刚才那个改一下', audioSeconds: 1, inferenceSeconds: 0.2 }),
      prepare: () => {},
    },
    agents: {
      get: (id) => (id === 'session-1' ? { id, followup: (message) => followed.push(message) } : undefined),
      list: () => [{ id: 'session-1', followup: (message) => followed.push(message) }],
    },
  }
  const bridge = new VoiceBridge({ ctx, send: (message) => sent.push(message), logger: { warn() {} } })
  return { bridge, sent, followed, ctx }
}

test('chunks concatenate and become one WAV before transcription', async () => {
  let received = null
  const { bridge, sent } = setup({
    speech: {
      snapshot: () => ({ providers: [{ id: 'sense', preparation: { phase: 'ready' } }], selection: { providerId: 'sense', language: 'zh' } }),
      resolve: (request) => ({ ...request, provider: {} }),
      transcribe: async (spec) => {
        received = spec.audio
        return { text: '你好', audioSeconds: 0.1, inferenceSeconds: 0.1 }
      },
      prepare: () => {},
    },
  })

  bridge.handle({ t: 'voice_start', id: 'v1' })
  bridge.handle({ t: 'voice_chunk', id: 'v1', seq: 0, data: Buffer.alloc(1600, 1).toString('base64') })
  bridge.handle({ t: 'voice_chunk', id: 'v1', seq: 1, data: Buffer.alloc(1600, 2).toString('base64') })
  bridge.handle({ t: 'voice_end', id: 'v1' })
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(received.length, 44 + 3200)
  assert.equal(Buffer.from(received.subarray(0, 4)).toString(), 'RIFF')
  assert.equal(Buffer.from(received.subarray(44, 48))[0], 1)
  assert.equal(Buffer.from(received.subarray(44 + 1600, 44 + 1601))[0], 2)
  const text = sent.find((message) => message.t === 'voice_text')
  assert.equal(text.text, '你好')
})

test('a transcript can be delivered to the active conversation', async () => {
  const { bridge, sent, followed } = setup()
  bridge.trackSession({ id: 'session-1' }, { type: 'user/message' })
  bridge.handle({ t: 'voice_start', id: 'v1' })
  bridge.handle({ t: 'voice_chunk', id: 'v1', seq: 0, data: Buffer.alloc(3200, 1).toString('base64') })
  bridge.handle({ t: 'voice_end', id: 'v1' })
  await new Promise((resolve) => setTimeout(resolve, 30))

  bridge.handle({ t: 'voice_send', id: 'v1' })
  assert.equal(followed.length, 1)
  assert.equal(followed[0].role, 'user')
  assert.equal(followed[0].content[0].text, '把刚才那个改一下')
  assert.equal(sent.at(-1).state, 'sent')
})

test('clear drops the buffer and the transcript', async () => {
  const { bridge, sent, followed } = setup()
  bridge.handle({ t: 'voice_start', id: 'v1' })
  bridge.handle({ t: 'voice_chunk', id: 'v1', seq: 0, data: Buffer.alloc(3200, 1).toString('base64') })
  bridge.handle({ t: 'voice_clear', id: 'v1' })
  assert.equal(sent.at(-1).state, 'cleared')
  bridge.handle({ t: 'voice_send', id: 'v1' })
  assert.equal(followed.length, 0)
})

test('without a speech service the watch gets an explanation', async () => {
  const sent = []
  const bridge = new VoiceBridge({ ctx: {}, send: (message) => sent.push(message), logger: { warn() {} } })
  bridge.handle({ t: 'voice_start', id: 'v1' })
  bridge.handle({ t: 'voice_chunk', id: 'v1', seq: 0, data: Buffer.alloc(3200, 1).toString('base64') })
  bridge.handle({ t: 'voice_end', id: 'v1' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sent.at(-1).state, 'error')
  assert.match(sent.at(-1).message, /未启用/)
})

test('an unprepared provider explains the download instead of failing silently', async () => {
  const sent = []
  const bridge = new VoiceBridge({
    ctx: {
      speechToText: {
        snapshot: () => ({ providers: [{ id: 'sense', preparation: { phase: 'unprepared' } }], selection: { providerId: 'sense', language: 'zh' } }),
        prepare: () => {},
      },
    },
    send: (message) => sent.push(message),
    logger: { warn() {} },
  })
  bridge.handle({ t: 'voice_start', id: 'v1' })
  bridge.handle({ t: 'voice_chunk', id: 'v1', seq: 0, data: Buffer.alloc(3200, 1).toString('base64') })
  bridge.handle({ t: 'voice_end', id: 'v1' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sent.at(-1).state, 'error')
  assert.match(sent.at(-1).message, /模型/)
})

test('WAV header carries the sample parameters', () => {
  const wav = wrapWav(Buffer.alloc(100), 16000, 1, 16)
  assert.equal(wav.length, 144)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(40), 100)
})

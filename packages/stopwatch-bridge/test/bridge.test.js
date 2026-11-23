import test from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../src/bridge.js'
import { normalizeConfig } from '../src/config.js'
import { FakeWatch, mockContext, waitFor } from './helpers.js'

/**
 * Start a bridge on ephemeral ports.
 * @param {object} [overrides] - config overrides.
 * @returns {Promise<{bridge: Bridge, ctx: any, watch: () => FakeWatch}>} harness.
 */
async function setup(overrides = {}) {
  const ctx = mockContext()
  const config = {
    ...normalizeConfig({}),
    port: 0,
    discoveryPort: 0,
    host: '127.0.0.1',
    timeoutMs: 400,
    transport: 'listen', // tests drive a fake watch over TCP, not a real cable
    ...overrides,
  }
  const bridge = new Bridge(ctx, config)
  bridge.start()
  await waitFor(() => bridge.server.port !== 0)
  return {
    bridge,
    ctx,
    config,
    port: bridge.server.port,
    /** @returns {Promise<FakeWatch>} a paired watch. */
    async pair(options = {}) {
      const watch = new FakeWatch(bridge.server.port, options)
      await watch.handshake()
      return watch
    },
  }
}

/**
 * Build an approval request shaped like the harness one.
 * @param {object} [overrides] - field overrides.
 * @returns {any} request.
 */
function approval(overrides = {}) {
  const controller = new AbortController()
  return {
    agent: { id: 'session-1' },
    toolName: 'bash',
    callId: 'call-1',
    reason: '需要写入工作区以外的文件',
    signal: controller.signal,
    controller,
    ...overrides,
  }
}

test('watch answers allow and the request returns allowed-once', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  const request = approval()
  const pending = harness.bridge.onApproval(request, async () => 'fallback')
  const prompt = await watch.next('prompt')
  assert.equal(prompt.title, '需要确认')
  assert.equal(prompt.total, 1)
  assert.ok(prompt.lines.length > 0)

  watch.send({ t: 'decision', id: prompt.id, value: 'allow' })
  assert.equal(await pending, 'allowed-once')
  const close = await watch.next('close')
  assert.equal(close.outcome, 'allowed-once')
})

test('watch answers deny and the request returns rejected', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  const pending = harness.bridge.onApproval(approval(), async () => 'fallback')
  const prompt = await watch.next('prompt')
  watch.send({ t: 'decision', id: prompt.id, value: 'deny' })
  assert.equal(await pending, 'rejected')
})

test('delegate hands the request back to the Web UI', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  let fellBack = false
  const pending = harness.bridge.onApproval(approval(), async () => {
    fellBack = true
    return 'fallback'
  })
  const prompt = await watch.next('prompt')
  watch.send({ t: 'decision', id: prompt.id, value: 'delegate' })
  assert.equal(await pending, 'fallback')
  assert.equal(fellBack, true)
})

test('silence on the watch times out into the Web UI', async (t) => {
  const harness = await setup({ timeoutMs: 120 })
  t.after(() => harness.bridge.stop())
  await harness.pair()

  const pending = harness.bridge.onApproval(approval(), async () => 'fallback')
  await waitFor(() => true)
  assert.equal(await pending, 'fallback')
})

test('an aborted request settles as cancelled', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  const request = approval()
  const pending = harness.bridge.onApproval(request, async () => 'fallback')
  await watch.next('prompt')
  request.controller.abort()
  assert.equal(await pending, 'cancelled')
})

test('losing the device hands every pending request back', async (t) => {
  const harness = await setup({ timeoutMs: 5000 })
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  const pending = harness.bridge.onApproval(approval(), async () => 'fallback')
  await watch.next('prompt')
  watch.close()
  assert.equal(await pending, 'fallback')
})

test('a request that does not fit only posts a notice', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  const request = approval({ reason: '很长的说明'.repeat(60) })
  let fellBack = false
  const result = await harness.bridge.onApproval(request, async () => {
    fellBack = true
    return 'fallback'
  })
  assert.equal(result, 'fallback')
  assert.equal(fellBack, true)
  const notice = await watch.next('notice')
  assert.equal(notice.kind, 'delegate')
  assert.deepEqual(watch.messages.filter((message) => message.t === 'prompt'), [])
})

test('notify mode mirrors the request without claiming it', async (t) => {
  const harness = await setup({ mode: 'notify' })
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  let fellBack = false
  const result = await harness.bridge.onApproval(approval(), async () => {
    fellBack = true
    return 'fallback'
  })
  assert.equal(result, 'fallback')
  assert.equal(fellBack, true)
  const notice = await watch.next('notice')
  assert.equal(notice.kind, 'pending')
  assert.ok(notice.lines.length > 0)
})

test('without a watch the request never waits', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  let fellBack = false
  const result = await harness.bridge.onApproval(approval(), async () => {
    fellBack = true
    return 'fallback'
  })
  assert.equal(result, 'fallback')
  assert.equal(fellBack, true)
})

test('concurrent requests queue behind each other', async (t) => {
  const harness = await setup({ timeoutMs: 5000 })
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  const first = harness.bridge.onApproval(approval({ callId: 'a' }), async () => 'fallback')
  const second = harness.bridge.onApproval(approval({ callId: 'b' }), async () => 'fallback')

  const one = await watch.next('prompt')
  assert.equal(one.total, 1)
  assert.equal((await watch.next('queue')).pending, 1)
  watch.send({ t: 'decision', id: one.id, value: 'allow' })
  assert.equal(await first, 'allowed-once')

  const two = await watch.next('prompt')
  assert.equal(two.total, 1)
  watch.send({ t: 'decision', id: two.id, value: 'allow' })
  assert.equal(await second, 'allowed-once')
})

test('a wrong token is rejected during the handshake', async (t) => {
  const harness = await setup({ token: 's3cret' })
  t.after(() => harness.bridge.stop())
  const watch = new FakeWatch(harness.port, { token: 'wrong' })
  await watch.connected
  watch.send({ t: 'hello', proto: 1, id: 'x', token: 'wrong' })
  const error = await watch.next('error')
  assert.equal(error.code, 'bad-token')
  watch.close()
})

test('a matching token is accepted', async (t) => {
  const harness = await setup({ token: 's3cret' })
  t.after(() => harness.bridge.stop())
  const watch = new FakeWatch(harness.port, { token: 's3cret' })
  const welcome = await watch.handshake()
  assert.equal(welcome.t, 'welcome')
  watch.close()
})

test('tool policy keeps excluded tools on the Web UI', async (t) => {
  const harness = await setup({ deniedTools: ['bash'] })
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()

  let fellBack = false
  const result = await harness.bridge.onApproval(approval(), async () => {
    fellBack = true
    return 'fallback'
  })
  assert.equal(result, 'fallback')
  assert.equal(fellBack, true)
  assert.deepEqual(watch.messages.filter((message) => message.t === 'prompt'), [])
})

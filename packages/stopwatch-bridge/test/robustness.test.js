import test from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../src/bridge.js'
import { normalizeConfig } from '../src/config.js'
import { FakeWatch, mockContext, waitFor } from './helpers.js'

/**
 * Start a bridge on ephemeral ports.
 * @param {object} [overrides] - config overrides.
 * @returns {Promise<any>} harness.
 */
async function setup(overrides = {}) {
  const ctx = mockContext()
  const config = { ...normalizeConfig({}), port: 0, discoveryPort: 0, host: '127.0.0.1', timeoutMs: 400, ...overrides }
  const bridge = new Bridge(ctx, config)
  bridge.start()
  await waitFor(() => bridge.server.port !== 0)
  return {
    bridge,
    ctx,
    port: bridge.server.port,
    /** @returns {Promise<FakeWatch>} a paired watch. */
    async pair(options = {}) {
      const watch = new FakeWatch(bridge.server.port, options)
      await watch.handshake()
      return watch
    },
  }
}

test('garbage on the wire does not kill the server', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = new FakeWatch(harness.port)
  await watch.connected
  watch.sendRaw('not json at all\n')
  const error = await watch.next('error')
  assert.equal(error.code, 'bad-json')
  // the server must still accept a well-formed handshake afterwards
  const second = new FakeWatch(harness.port)
  await second.handshake()
  second.close()
})

test('an oversized frame is rejected and the server recovers for the next connection', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = new FakeWatch(harness.port)
  await watch.connected
  watch.sendRaw(`${'x'.repeat(9000)}\n`)
  const error = await watch.next('error')
  assert.equal(error.code, 'too-long')
  // a protocol violation closes that socket; the server itself stays healthy
  assert.equal(await watch.closed(2000), true)

  const next = new FakeWatch(harness.port)
  await next.handshake()
  next.close()
})

test('an unknown message type after pairing is answered, not fatal', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()
  watch.send({ t: 'mystery', payload: 1 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(harness.bridge.server.device !== null, true)
  watch.close()
})

test('a second watch replaces the first and the old socket gets a bye', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const first = await harness.pair({ id: 'first' })
  const second = new FakeWatch(harness.port, { id: 'second' })
  await second.handshake()
  const bye = await first.next('bye')
  assert.equal(bye.reason, 'replaced')
  assert.equal(harness.bridge.server.device.id, 'second')
  first.close()
  second.close()
})

test('a connection that never says hello is dropped', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = new FakeWatch(harness.port)
  await watch.connected
  const closed = await watch.closed(6000)
  assert.equal(closed, true)
})

test('a decision for an unknown prompt is ignored', async (t) => {
  const harness = await setup()
  t.after(() => harness.bridge.stop())
  const watch = await harness.pair()
  watch.send({ t: 'decision', id: 'nope', value: 'allow' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(harness.bridge.server.device !== null, true)
  watch.close()
})

test('a replacement watch receives the prompt that is still pending', async (t) => {
  const harness = await setup({ timeoutMs: 5000 })
  t.after(() => harness.bridge.stop())
  await harness.pair({ id: 'a' })
  const request = {
    agent: { id: 'session-1' },
    toolName: 'bash',
    callId: 'c1',
    reason: '需要写入',
    signal: new AbortController().signal,
  }
  const pending = harness.bridge.onApproval(request, async () => 'fallback')
  const prompt = await harness.bridge.server.device ? null : null
  void prompt

  const second = new FakeWatch(harness.port, { id: 'b' })
  await second.handshake()
  const resent = await second.next('prompt', 3000)
  assert.ok(resent.id.length > 0)
  second.send({ t: 'decision', id: resent.id, value: 'deny' })
  assert.equal(await pending, 'rejected')
  second.close()
})

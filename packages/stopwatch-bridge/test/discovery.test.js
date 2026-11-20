import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { Discovery } from '../src/discovery.js'

/**
 * Pick a free UDP port by binding and releasing one.
 * @returns {Promise<number>} a port that was free a moment ago.
 */
async function freePort() {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  await new Promise((resolve) => socket.close(resolve))
  return port
}

/**
 * Send one datagram and collect any reply for a while.
 * @param {number} port - destination port.
 * @param {string} payload - datagram body.
 * @param {number} [waitMs] - how long to wait for a reply.
 * @returns {Promise<string | null>} the reply text, or null.
 */
async function probe(port, payload, waitMs = 600) {
  const socket = dgram.createSocket('udp4')
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), waitMs)
    socket.once('message', (buffer) => {
      clearTimeout(timer)
      resolve(buffer.toString('utf8'))
    })
    socket.bind(0, '127.0.0.1', () => {
      socket.send(payload, port, '127.0.0.1')
    })
  })
  await new Promise((resolve) => socket.close(resolve))
  return reply
}

test('a discover probe gets the host address and port', async (t) => {
  const port = await freePort()
  const discovery = new Discovery({ port, tcpPort: 47777, name: 'mac-mini', token: 's3cret', logger: { info() {}, warn() {} } })
  discovery.start()
  t.after(() => discovery.stop())
  await new Promise((resolve) => setTimeout(resolve, 100))

  const reply = await probe(port, JSON.stringify({ t: 'discover', proto: 1 }))
  assert.notEqual(reply, null)
  const parsed = JSON.parse(reply)
  assert.equal(parsed.t, 'host')
  assert.equal(parsed.proto, 1)
  assert.equal(parsed.port, 47777)
  assert.equal(parsed.name, 'mac-mini')
  assert.equal(parsed.token, 's3cret')
})

test('unrelated datagrams are ignored', async (t) => {
  const port = await freePort()
  const discovery = new Discovery({ port, tcpPort: 47777, name: 'mac-mini', token: '', logger: { info() {}, warn() {} } })
  discovery.start()
  t.after(() => discovery.stop())
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(await probe(port, 'hello?'), null)
  assert.equal(await probe(port, JSON.stringify({ t: 'discover', proto: 2 })), null)
})

test('a discovery beacon can be answered twice (idempotent replies)', async (t) => {
  const port = await freePort()
  const discovery = new Discovery({ port, tcpPort: 1234, name: 'x', token: '', logger: { info() {}, warn() {} } })
  discovery.start()
  t.after(() => discovery.stop())
  await new Promise((resolve) => setTimeout(resolve, 100))

  const first = await probe(port, JSON.stringify({ t: 'discover' }))
  const second = await probe(port, JSON.stringify({ t: 'discover' }))
  assert.equal(JSON.parse(first).port, 1234)
  assert.equal(JSON.parse(second).port, 1234)
})

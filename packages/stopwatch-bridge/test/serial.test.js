import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoTransport, SerialConnector, listPorts } from '../src/serial.js'

/**
 * Build a serial connector with a capturing writer.
 * @returns {any} connector plus the frames it wrote.
 */
function setup() {
  const written = []
  const link = new SerialConnector({ port: '/dev/null-test', token: '', logger: { info() {}, warn() {} } })
  link.writer = { write: (data) => written.push(data), destroyed: false, end() {} }
  return { link, written }
}

const hello = JSON.stringify({ t: 'hello', proto: 1, id: 'stopwatch-01', name: 'M5StopWatch', fw: '0.2.0', token: '', battery: 90 })

test('a hello frame pairs the watch over serial', () => {
  const { link, written } = setup()
  const devices = []
  link.on('device', (device) => devices.push(device))

  link.receive(hello)
  assert.equal(devices.length, 1)
  assert.equal(devices[0].id, 'stopwatch-01')
  assert.equal(devices[0].battery, 90)
  assert.match(written[0], /"t":"welcome"/)
})

test('debug lines sharing the port are ignored', () => {
  const { link } = setup()
  const devices = []
  link.on('device', (device) => devices.push(device))
  link.receive('[dsh] alive wifi=0 tcp=0')
  assert.equal(devices.length, 0)
  link.receive(hello)
  assert.equal(devices.length, 1)
})

test('a token mismatch is not paired', () => {
  const strict = new SerialConnector({ port: '/dev/x', token: 'secret', logger: { info() {}, warn() {} } })
  strict.writer = { write() {}, destroyed: false, end() {} }
  const devices = []
  strict.on('device', (device) => devices.push(device))
  strict.receive(hello)
  assert.equal(devices.length, 0)
})

test('messages after pairing reach the bridge', () => {
  const { link } = setup()
  const messages = []
  link.on('message', (message) => messages.push(message))
  link.receive(hello)
  link.receive(JSON.stringify({ t: 'decision', id: 'p1', value: 'allow' }))
  assert.equal(messages[0].t, 'decision')
})

test('a silent device is dropped by the heartbeat', () => {
  const { link } = setup()
  const devices = []
  link.on('device', (device) => devices.push(device))
  link.receive(hello)
  link.current.lastSeen = Date.now() - 60000
  link.tick()
  assert.equal(devices.at(-1), null)
})

test('a watch that re-offers the link is welcomed again after a restart', () => {
  const { link, written } = setup()
  const devices = []
  link.on('device', (device) => devices.push(device))

  link.receive(hello)
  link.pairedAt = Date.now() - 60000 // the welcome landed a while ago
  link.receive(hello) // the watch rebooted and forgot it

  const welcomes = written.filter((frame) => frame.includes('"t":"welcome"'))
  assert.equal(welcomes.length, 2)
  assert.deepEqual(devices.map((device) => device?.id ?? null), ['stopwatch-01', null, 'stopwatch-01'])
})

test('a second watch takes over the link without waiting for the retry window', () => {
  const { link, written } = setup()
  link.receive(hello)
  link.receive(JSON.stringify({ t: 'hello', proto: 1, id: 'stopwatch-02', fw: '0.2.0', token: '', battery: 41 }))

  const welcomes = written.filter((frame) => frame.includes('"t":"welcome"'))
  assert.equal(welcomes.length, 2)
  assert.equal(link.device.id, 'stopwatch-02')
})

test('a repeated hello from the paired watch does not re-pair every frame', () => {
  const { link, written } = setup()
  link.receive(hello)
  link.receive(hello)
  assert.equal(written.filter((frame) => frame.includes('"t":"welcome"')).length, 1)
})

test('pulling the cable with a deviceHost configured falls back to the network', async () => {
  const transport = new AutoTransport(
    { token: '', serialPort: '', deviceHost: '127.0.0.1', port: 47777 },
    { info() {}, warn() {} },
  )
  transport.listPorts = async () => []
  // This used to throw ReferenceError: DeviceConnector is not defined, and the
  // unhandled rejection from the supervisor took the whole host down.
  await transport.tick()
  assert.equal(transport.kind, 'tcp')
  assert.notEqual(transport.active, null)
  transport.close()
})

test('a flashing sentinel makes the transport step aside, then reconnect', async () => {
  const sentinel = join(mkdtempSync(join(tmpdir(), 'stopwatch-')), 'flash.lock')
  const transport = new AutoTransport(
    { token: '', serialPort: '', deviceHost: '', port: 47777, releaseFile: sentinel },
    { info() {}, warn() {} },
  )
  transport.listPorts = async () => []

  writeFileSync(sentinel, 'by flash.mjs\n')
  await transport.tick()
  assert.equal(transport.kind, 'released')
  assert.equal(transport.device, null)
  assert.equal(transport.send({ t: 'ping' }), false)

  rmSync(sentinel, { force: true })
  await transport.tick()
  assert.equal(transport.kind, 'tcp')
  transport.close()
})

test('port scanning returns only serial-looking paths', async () => {
  const ports = await listPorts()
  for (const port of ports) {
    assert.match(port, /usbmodem|usbserial|wchusbserial|ttyACM|ttyUSB|^COM\d+$/)
  }
})

test('the auto transport reports no device before it is started', () => {
  const transport = new AutoTransport({ token: '', serialPort: '', deviceHost: '' }, { info() {}, warn() {} })
  assert.equal(transport.device, null)
  transport.close()
})

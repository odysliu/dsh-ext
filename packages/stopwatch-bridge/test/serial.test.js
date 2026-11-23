import test from 'node:test'
import assert from 'node:assert/strict'
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

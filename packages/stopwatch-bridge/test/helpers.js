/**
 * Shared test doubles: a fake watch that speaks the device protocol, and a
 * minimal Cordis-like context so `Bridge` can run outside the harness.
 */

import net from 'node:net'
import { LineDecoder, encodeMessage } from '../src/protocol.js'

/** A watch connected to a DeviceServer, driven by the test. */
export class FakeWatch {
  /**
   * @param {number} port - TCP port of the device server.
   * @param {{token?: string, proto?: number, name?: string}} [options] - handshake overrides.
   */
  constructor(port, options = {}) {
    this.port = port
    this.options = options
    /** @type {any[]} */
    this.messages = []
    /** @type {Array<(message: any) => void>} */
    this.waiters = []
    this.socket = net.connect({ port, host: '127.0.0.1' })
    this.socket.setEncoding('utf8')
    this.decoder = new LineDecoder((line) => this.receive(line))
    this.socket.on('data', (chunk) => this.decoder.push(String(chunk)))
    this.socket.on('error', () => {})
    this.connected = new Promise((resolve) => this.socket.once('connect', resolve))
  }

  /** Send the hello frame and wait for the welcome. */
  async handshake() {
    await this.connected
    this.send({
      t: 'hello',
      proto: this.options.proto ?? 1,
      id: this.options.id ?? 'fake-1',
      name: this.options.name ?? 'stopwatch',
      fw: '0.1.0-test',
      token: this.options.token ?? '',
      battery: 88,
    })
    return this.next('welcome')
  }

  /**
   * Send one raw message.
   * @param {any} message - protocol message.
   */
  send(message) {
    this.socket.write(encodeMessage(message))
  }

  /**
   * Wait for the next message of one type.
   * @param {string} type - `t` value.
   * @param {number} [timeoutMs] - rejection deadline.
   * @returns {Promise<any>} the awaited message.
   */
  next(type, timeoutMs = 2000) {
    const existing = this.messages.find((message) => message.t === type)
    if (existing !== undefined) {
      this.messages.splice(this.messages.indexOf(existing), 1)
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error(`timed out waiting for "${type}"; got ${JSON.stringify(this.messages)}`))
      }, timeoutMs)
      const waiter = (message) => {
        if (message.t !== type) return false
        clearTimeout(timer)
        resolve(message)
        return true
      }
      this.waiters.push(waiter)
    })
  }

  /**
   * Record one inbound frame.
   * @param {string} line - one protocol line.
   */
  receive(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    for (const waiter of [...this.waiters]) {
      if (waiter(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        return
      }
    }
    this.messages.push(message)
  }

  /** Close the socket. */
  close() {
    this.socket.destroy()
  }
}

/**
 * Minimal replacement for the Cordis context used by `Bridge`.
 * @returns {any} a context with `on`, `logger`, and handler access.
 */
export function mockContext() {
  const handlers = new Map()
  return {
    handlers,
    logger: { info() {}, warn() {}, debug() {} },
    on(name, listener) {
      handlers.set(name, listener)
      return () => handlers.delete(name)
    },
  }
}

/**
 * Poll until a condition holds.
 * @param {() => boolean} predicate - condition.
 * @param {number} [timeoutMs] - deadline.
 */
export async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not met in time')
}

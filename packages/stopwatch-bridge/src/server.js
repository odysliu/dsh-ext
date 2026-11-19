/**
 * TCP endpoint the watch connects to. Owns exactly one paired device at a
 * time, the framing, the handshake, and the heartbeat that decides when the
 * device counts as offline.
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { LineDecoder, PROTOCOL_VERSION, encodeMessage, parseMessage } from './protocol.js'

const HANDSHAKE_TIMEOUT_MS = 5000
const HEARTBEAT_INTERVAL_MS = 8000
const DEVICE_TIMEOUT_MS = 30000

export class DeviceServer extends EventEmitter {
  /**
   * @param {{port: number, host: string, token: string, logger?: any}} options - listener settings.
   */
  constructor({ port, host, token, logger }) {
    super()
    this.port = port
    this.host = host
    this.token = token
    this.logger = logger
    /** @type {net.Server | null} */
    this.server = null
    /** @type {any | null} */
    this.current = null
    /** @type {Set<net.Socket>} */
    this.sockets = new Set()
    /** @type {NodeJS.Timeout | null} */
    this.heartbeat = null
    this.closed = false
  }

  /** @returns {any | null} the paired device, when one is connected. */
  get device() {
    return this.current
  }

  /**
   * Start listening.
   * @returns {Promise<number>} the bound port.
   */
  async listen() {
    const server = net.createServer((socket) => this.accept(socket))
    this.server = server
    server.on('error', (error) => {
      this.logger?.warn?.(`stopwatch-bridge: device server error: ${error.message}`)
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error)
      server.once('error', onError)
      server.listen(this.port, this.host, () => {
        server.off('error', onError)
        resolve(undefined)
      })
    })
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref?.()
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : this.port
    this.port = port
    this.logger?.info?.(`stopwatch-bridge: listening for the watch on ${this.host}:${port}`)
    return port
  }

  /**
   * Send one message to the paired device.
   * @param {object} message - protocol message.
   * @returns {boolean} whether it was written.
   */
  send(message) {
    const device = this.current
    if (device === null) return false
    try {
      device.socket.write(encodeMessage(message))
      return true
    } catch (error) {
      this.logger?.warn?.(`stopwatch-bridge: write failed: ${error.message}`)
      return false
    }
  }

  /** Stop listening and drop the device. */
  close() {
    this.closed = true
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
    this.current = null
  }

  /**
   * Adopt one inbound connection.
   * @param {net.Socket} socket - accepted socket.
   */
  accept(socket) {
    this.sockets.add(socket)
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 5000)
    socket.setEncoding('utf8')

    /** @type {string | undefined} */
    let deviceId
    const handshake = setTimeout(() => {
      if (deviceId === undefined) this.reject(socket, 'bad-proto', 'handshake timeout')
    }, HANDSHAKE_TIMEOUT_MS)

    const decoder = new LineDecoder(
      (line) => this.receive(socket, line, (id) => { deviceId = id; clearTimeout(handshake) }),
      (error) => this.reject(socket, error, 'frame rejected'),
    )

    socket.on('data', (chunk) => decoder.push(String(chunk)))
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(handshake)
      this.sockets.delete(socket)
      if (this.current?.socket === socket) {
        this.logger?.info?.('stopwatch-bridge: watch disconnected')
        this.current = null
        this.emit('device', null)
      }
    })
  }

  /**
   * Handle one frame from one socket.
   * @param {net.Socket} socket - source socket.
   * @param {string} line - one frame.
   * @param {(id: string) => void} onHello - marks the handshake complete.
   */
  receive(socket, line, onHello) {
    const parsed = parseMessage(line)
    if (!parsed.ok) {
      this.reject(socket, parsed.error, 'unparseable frame')
      return
    }
    const message = parsed.value
    const device = this.current

    if (device === null || device.socket !== socket) {
      if (message.t !== 'hello') {
        this.reject(socket, 'unknown-type', 'expected hello')
        return
      }
      if (message.proto !== PROTOCOL_VERSION) {
        this.reject(socket, 'bad-proto', `proto ${String(message.proto)}`)
        return
      }
      if (this.token !== '' && message.token !== this.token) {
        this.reject(socket, 'bad-token', 'token mismatch')
        return
      }
      onHello(String(message.id ?? ''))
      this.pair(socket, message)
      return
    }

    device.lastSeen = Date.now()
    if (message.t === 'pong') return
    if (message.t === 'status') {
      device.battery = numberOr(message.battery, device.battery)
      device.rssi = numberOr(message.rssi, device.rssi)
      return
    }
    if (message.t === 'error') {
      this.logger?.warn?.(`stopwatch-bridge: device error ${String(message.code)} ${String(message.message ?? '')}`)
      return
    }
    this.emit('message', message, device)
  }

  /**
   * Make one socket the paired device.
   * @param {net.Socket} socket - socket that completed the handshake.
   * @param {any} hello - its hello message.
   */
  pair(socket, hello) {
    if (this.current !== null && this.current.socket !== socket) {
      try {
        this.current.socket.end(encodeMessage({ t: 'bye', reason: 'replaced' }))
      } catch {
        this.current.socket.destroy()
      }
    }
    const device = {
      id: String(hello.id ?? 'unknown'),
      name: String(hello.name ?? 'stopwatch'),
      firmware: String(hello.fw ?? '0.0.0'),
      battery: numberOr(hello.battery, -1),
      rssi: -127,
      socket,
      remoteAddress: socket.remoteAddress ?? '',
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    }
    this.current = device
    socket.write(encodeMessage({ t: 'welcome', proto: PROTOCOL_VERSION, server: 'dsh-stopwatch' }))
    this.logger?.info?.(
      `stopwatch-bridge: watch connected from ${device.remoteAddress} (fw ${device.firmware}, battery ${device.battery}%)`,
    )
    this.emit('device', device)
  }

  /**
   * Answer a protocol violation and close.
   * @param {net.Socket} socket - offending socket.
   * @param {string} code - error code.
   * @param {string} detail - human-readable detail for the log.
   */
  reject(socket, code, detail) {
    this.logger?.warn?.(`stopwatch-bridge: rejected watch connection (${code}: ${detail})`)
    try {
      socket.end(encodeMessage({ t: 'error', code, message: detail }))
    } catch {
      socket.destroy()
    }
  }

  /** Heartbeat: ping, or drop a silent device. */
  tick() {
    const device = this.current
    if (device === null) return
    if (Date.now() - device.lastSeen > DEVICE_TIMEOUT_MS) {
      this.logger?.warn?.('stopwatch-bridge: watch heartbeat lost; dropping it')
      device.socket.destroy()
      return
    }
    this.send({ t: 'ping', ts: Date.now() })
  }
}

/**
 * Coerce a number field, keeping the previous value when invalid.
 * @param {unknown} value - candidate.
 * @param {number} fallback - value used when the candidate is not a finite number.
 * @returns {number} the chosen number.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

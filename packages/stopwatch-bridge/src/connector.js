/**
 * Outbound connection to a watch that listens for us.
 *
 * Some access points (phone hotspots, band-steering routers) complete a TCP
 * handshake from the watch but never forward its payload. Dialing the other way
 * works, so the bridge can own the connection instead of waiting for one.
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { LineDecoder, PROTOCOL_VERSION, encodeMessage, parseMessage } from './protocol.js'

const HEARTBEAT_INTERVAL_MS = 8000
const DEVICE_TIMEOUT_MS = 30000
const RETRY_MS = 3000

export class DeviceConnector extends EventEmitter {
  /**
   * @param {{host: string, port: number, token: string, logger?: any}} options - dial target.
   */
  constructor({ host, port, token, logger }) {
    super()
    this.host = host
    this.port = port
    this.token = token
    this.logger = logger
    /** @type {any | null} */
    this.current = null
    /** @type {NodeJS.Timeout | null} */
    this.retry = null
    /** @type {NodeJS.Timeout | null} */
    this.heartbeat = null
    /** @type {net.Socket | null} */
    this.socket = null
    this.closed = false
  }

  /** @returns {any | null} the paired device, when one is connected. */
  get device() {
    return this.current
  }

  /** Start dialing; resolves once the first attempt is scheduled. */
  async listen() {
    this.dial()
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

  /** Stop dialing and drop the device. */
  close() {
    this.closed = true
    if (this.retry !== null) clearTimeout(this.retry)
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.retry = null
    this.heartbeat = null
    this.socket?.destroy()
    this.socket = null
    this.current = null
  }

  /** Open one connection attempt. */
  dial() {
    if (this.closed) return
    const socket = net.connect({ host: this.host, port: this.port })
    this.socket = socket
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 5000)
    socket.setEncoding('utf8')

    const decoder = new LineDecoder(
      (line) => this.receive(socket, line),
      () => this.drop(socket, 'frame rejected'),
    )

    socket.on('connect', () => {
      this.logger?.info?.(`stopwatch-bridge: dialing the watch at ${this.host}:${this.port}`)
      this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS)
      this.heartbeat.unref?.()
    })
    socket.on('data', (chunk) => decoder.push(String(chunk)))
    socket.on('error', () => {})
    socket.on('close', () => this.drop(socket, 'connection closed'))
  }

  /**
   * Handle one frame from the watch.
   * @param {net.Socket} socket - source socket.
   * @param {string} line - one frame.
   */
  receive(socket, line) {
    const parsed = parseMessage(line)
    if (!parsed.ok) {
      this.drop(socket, parsed.error)
      return
    }
    const message = parsed.value
    const device = this.current

    if (device === null || device.socket !== socket) {
      if (message.t !== 'hello') return
      if (message.proto !== PROTOCOL_VERSION) {
        this.drop(socket, 'bad-proto')
        return
      }
      if (this.token !== '' && message.token !== this.token) {
        this.drop(socket, 'bad-token')
        return
      }
      const paired = {
        id: String(message.id ?? 'unknown'),
        name: String(message.name ?? 'stopwatch'),
        firmware: String(message.fw ?? '0.0.0'),
        battery: typeof message.battery === 'number' ? message.battery : -1,
        rssi: -127,
        socket,
        remoteAddress: socket.remoteAddress ?? this.host,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
      }
      this.current = paired
      socket.write(encodeMessage({ t: 'welcome', proto: PROTOCOL_VERSION, server: 'dsh-stopwatch' }))
      this.logger?.info?.(`stopwatch-bridge: watch dialed in (fw ${paired.firmware}, battery ${paired.battery}%)`)
      this.emit('device', paired)
      return
    }

    device.lastSeen = Date.now()
    if (message.t === 'pong') return
    if (message.t === 'status') {
      if (typeof message.battery === 'number') device.battery = message.battery
      return
    }
    if (message.t === 'error') {
      this.logger?.warn?.(`stopwatch-bridge: device error ${String(message.code)}`)
      return
    }
    this.emit('message', message, device)
  }

  /**
   * Tear one socket down and schedule a retry.
   * @param {net.Socket} socket - socket that ended.
   * @param {string} reason - diagnostic.
   */
  drop(socket, reason) {
    socket.destroy()
    if (this.current?.socket === socket) {
      this.current = null
      this.logger?.info?.(`stopwatch-bridge: watch connection lost (${reason})`)
      this.emit('device', null)
    }
    if (this.socket === socket) this.socket = null
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    if (this.closed) return
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = setTimeout(() => this.dial(), RETRY_MS)
    this.retry.unref?.()
  }

  /** Heartbeat: ping, or drop a silent device. */
  tick() {
    const device = this.current
    if (device === null) return
    if (Date.now() - device.lastSeen > DEVICE_TIMEOUT_MS) {
      this.logger?.warn?.('stopwatch-bridge: watch heartbeat lost; redialing')
      this.drop(device.socket, 'heartbeat timeout')
      return
    }
    this.send({ t: 'ping', ts: Date.now() })
  }
}

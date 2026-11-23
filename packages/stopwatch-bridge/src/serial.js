/**
 * USB serial transport.
 *
 * Corporate Wi-Fi usually refuses an ESP32 (5 GHz only, WPA2-Enterprise, or
 * client isolation), but the watch is tethered to the laptop anyway. Speaking
 * the same NDJSON protocol over USB CDC needs no network at all.
 *
 * Reading is delegated to `cat` so the blocked read lives in its own process
 * instead of holding a libuv thread-pool thread for the plugin's lifetime.
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { LineDecoder, PROTOCOL_VERSION, encodeMessage, parseMessage } from './protocol.js'

const HEARTBEAT_INTERVAL_MS = 8000
const DEVICE_TIMEOUT_MS = 30000
const RETRY_MS = 3000

/** Ports that look like an ESP32 running the stopwatch firmware. */
const CANDIDATES = {
  darwin: [/^\/dev\/cu\.usbmodem/, /^\/dev\/cu\.usbserial/, /^\/dev\/cu\.wchusbserial/],
  linux: [/^\/dev\/ttyACM/, /^\/dev\/ttyUSB/],
  win32: [/^COM\d+$/],
}

/**
 * List serial ports without a native dependency.
 * @returns {Promise<string[]>} absolute device paths, best first.
 */
export async function listPorts() {
  const patterns = CANDIDATES[process.platform] ?? CANDIDATES.linux
  let names = []
  if (process.platform === 'win32') {
    names = await new Promise((resolve) => {
      execFile('cmd', ['/c', 'wmic', 'path', 'Win32_SerialPort', 'get', 'DeviceID'], (error, stdout) => {
        resolve(error ? [] : String(stdout).split(/\s+/).filter(Boolean))
      })
    })
  } else {
    const { readdir } = await import('node:fs/promises')
    const directory = process.platform === 'darwin' ? '/dev' : '/dev'
    names = await readdir(directory).then(
      (entries) => entries.map((entry) => `${directory}/${entry}`),
      () => [],
    )
  }
  return names.filter((name) => patterns.some((pattern) => pattern.test(name))).sort()
}

/**
 * Put the port in raw mode so bytes pass through untouched.
 * @param {string} port - device path.
 * @returns {Promise<void>} resolves once configured.
 */
async function configurePort(port) {
  if (process.platform === 'win32') return // Windows needs a driver-level setup; defaults are used
  const flag = process.platform === 'darwin' ? '-f' : '-F'
  await new Promise((resolve) => {
    execFile('stty', [flag, port, '115200', 'raw', '-echo', '-hupcl'], () => resolve())
  })
}

export class SerialConnector extends EventEmitter {
  /**
   * @param {{port?: string, token: string, logger?: any}} options - serial settings.
   */
  constructor({ port = '', token, logger }) {
    super()
    this.port = port
    this.token = token
    this.logger = logger
    /** @type {any | null} */
    this.current = null
    /** @type {import('node:child_process').ChildProcess | null} */
    this.reader = null
    /** @type {import('node:fs').WriteStream | null} */
    this.writer = null
    /** @type {NodeJS.Timeout | null} */
    this.retry = null
    /** @type {NodeJS.Timeout | null} */
    this.heartbeat = null
    this.closed = false
    this.opening = false
  }

  /** @returns {any | null} the paired device, when one is connected. */
  get device() {
    return this.current
  }

  /** Start watching for the watch on USB. */
  async listen() {
    this.open()
  }

  /**
   * Send one message to the paired device.
   * @param {object} message - protocol message.
   * @returns {boolean} whether it was written.
   */
  send(message) {
    if (this.writer === null || this.writer.destroyed) return false
    try {
      this.writer.write(encodeMessage(message))
      return true
    } catch (error) {
      this.logger?.warn?.(`stopwatch-bridge: serial write failed: ${error.message}`)
      return false
    }
  }

  /** Stop watching and release the port. */
  close() {
    this.closed = true
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    this.stopHeartbeat()
    this.reader?.kill()
    this.reader = null
    this.writer?.end()
    this.writer = null
    this.current = null
  }

  /** Open the port and start reading frames. */
  async open() {
    if (this.closed || this.opening) return
    this.opening = true
    try {
      const port = this.port !== '' ? this.port : (await listPorts())[0]
      if (port === undefined || port === '') {
        this.opening = false
        this.scheduleRetry()
        return
      }
      this.port = port
      await configurePort(port)

      const reader = spawn('cat', [port], { stdio: ['ignore', 'pipe', 'ignore'] })
      const decoder = new LineDecoder(
        (line) => this.receive(line),
        () => this.drop('frame rejected'),
      )
      reader.stdout.setEncoding('utf8')
      reader.stdout.on('data', (chunk) => decoder.push(String(chunk)))
      reader.on('error', () => {})
      reader.on('close', () => this.drop('port closed'))
      this.reader = reader

      const writer = createWriteStream(port, { flags: 'w' })
      writer.on('error', (error) => this.drop(`write error: ${error.message}`))
      this.writer = writer

      this.logger?.info?.(`stopwatch-bridge: watching ${port} for the watch`)
      this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS)
      this.heartbeat.unref?.()
    } catch (error) {
      this.logger?.warn?.(`stopwatch-bridge: serial open failed: ${error.message}`)
      this.scheduleRetry()
    } finally {
      this.opening = false
    }
  }

  /** Queue another open attempt. */
  scheduleRetry() {
    if (this.closed || this.retry !== null) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.open()
    }, RETRY_MS)
    this.retry.unref?.()
  }

  /** Stop the heartbeat timer. */
  stopHeartbeat() {
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /**
   * Handle one frame from the watch.
   * @param {string} line - one frame.
   */
  receive(line) {
    const parsed = parseMessage(line)
    if (!parsed.ok) return // debug lines share the port; ignore them
    const message = parsed.value
    const device = this.current

    if (device === null) {
      if (message.t !== 'hello') return
      if (message.proto !== PROTOCOL_VERSION) return
      if (this.token !== '' && message.token !== this.token) return
      this.current = {
        id: String(message.id ?? 'unknown'),
        name: String(message.name ?? 'stopwatch'),
        firmware: String(message.fw ?? '0.0.0'),
        battery: typeof message.battery === 'number' ? message.battery : -1,
        rssi: -127,
        socket: null,
        remoteAddress: this.port,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
      }
      this.send({ t: 'welcome', proto: PROTOCOL_VERSION, server: 'dsh-stopwatch' })
      this.logger?.info?.(
        `stopwatch-bridge: watch paired over USB (fw ${this.current.firmware}, battery ${this.current.battery}%)`,
      )
      this.emit('device', this.current)
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
   * Tear the connection down and try again.
   * @param {string} reason - diagnostic.
   */
  drop(reason) {
    const hadDevice = this.current !== null
    this.current = null
    this.stopHeartbeat()
    this.reader?.kill()
    this.reader = null
    this.writer?.end()
    this.writer = null
    if (hadDevice) {
      this.logger?.info?.(`stopwatch-bridge: serial link lost (${reason})`)
      this.emit('device', null)
    }
    this.scheduleRetry()
  }

  /** Heartbeat: ping, or drop a silent device. */
  tick() {
    const device = this.current
    if (device === null) return
    if (Date.now() - device.lastSeen > DEVICE_TIMEOUT_MS) {
      this.drop('heartbeat timeout')
      return
    }
    this.send({ t: 'ping', ts: Date.now() })
  }
}

/**
 * Prefer USB when the watch is docked, otherwise fall back to the TCP dial.
 *
 * The cable is the reliable path on locked-down networks; the network path is
 * what lets the watch roam away from the desk.
 */
export class AutoTransport extends EventEmitter {
  /**
   * @param {any} config - resolved config.
   * @param {any} logger - plugin logger.
   */
  constructor(config, logger) {
    super()
    this.config = config
    this.logger = logger
    /** @type {SerialConnector | DeviceConnector | null} */
    this.active = null
    /** @type {string} */
    this.kind = ''
    /** @type {NodeJS.Timeout | null} */
    this.supervisor = null
    this.closed = false
  }

  /** @returns {any | null} the paired device. */
  get device() {
    return this.active?.device ?? null
  }

  /** Start supervising which transport should be live. */
  async listen() {
    await this.tick()
    this.supervisor = setInterval(() => this.tick(), 5000)
    this.supervisor.unref?.()
  }

  /** Re-evaluate: cable present wins, otherwise use the network. */
  async tick() {
    if (this.closed) return
    const ports = await listPorts().catch(() => [])
    const desired = this.config.serialPort !== '' || ports.length > 0 ? 'serial' : 'tcp'
    if (desired === this.kind) return

    this.active?.close()
    this.active = null
    this.kind = desired

    if (desired === 'serial') {
      const port = this.config.serialPort !== '' ? this.config.serialPort : ports[0]
      this.use(new SerialConnector({ port, token: this.config.token, logger: this.logger }))
      return
    }
    if (this.config.deviceHost === '') {
      this.logger?.info?.(
        'stopwatch-bridge: no USB cable and no deviceHost; waiting for the watch to be plugged in',
      )
      return
    }
    this.use(
      new DeviceConnector({
        host: this.config.deviceHost,
        port: this.config.port,
        token: this.config.token,
        logger: this.logger,
      }),
    )
  }

  /**
   * Adopt a transport and forward its events.
   * @param {any} next - connector to activate.
   */
  use(next) {
    this.active = next
    next.on('device', (device) => {
      if (this.active === next) this.emit('device', device)
    })
    next.on('message', (message, device) => {
      if (this.active === next) this.emit('message', message, device)
    })
    next.listen().catch((error) => this.logger?.warn?.(`stopwatch-bridge: transport failed: ${error.message}`))
  }

  /**
   * Send one message to the paired device.
   * @param {object} message - protocol message.
   * @returns {boolean} whether it was written.
   */
  send(message) {
    return this.active?.send(message) ?? false
  }

  /** Release the active transport. */
  close() {
    this.closed = true
    if (this.supervisor !== null) clearInterval(this.supervisor)
    this.supervisor = null
    this.active?.close()
    this.active = null
  }
}

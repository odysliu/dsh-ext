/**
 * Plugin configuration: defaults plus validation with actionable messages.
 * The bundle is plain JavaScript and deliberately does not import Harness
 * packages, so the row config is normalized here instead of by a Schemastery
 * `Config` export.
 */

import { fileURLToPath } from 'node:url'

/** `<repo>/.tools/flash.lock`, the sentinel `tools/flash.mjs` writes. */
const DEFAULT_RELEASE_FILE = fileURLToPath(new URL('../../../.tools/flash.lock', import.meta.url))

export const DEFAULT_CONFIG = Object.freeze({
  /** TCP port the watch connects to. */
  port: 47777,
  /** UDP port the watch broadcasts discovery on. */
  discoveryPort: 47778,
  /** Interface to bind; `0.0.0.0` accepts the watch from the LAN. */
  host: '0.0.0.0',
  /**
   * `auto` uses USB when the watch is plugged in, otherwise TCP;
   * `listen` waits for the watch over TCP; `dial` connects out to it;
   * `serial` only uses the USB cable.
   */
  transport: 'auto',
  /** Serial device for `serial`/`auto`; empty means "find the first matching port". */
  serialPort: '',
  /** Watch address for `dial`; the watch listens on `port`. */
  deviceHost: '',
  /** Shared secret; empty disables the check (trusted LAN). */
  token: '',
  /** `remote` lets the watch decide; `notify` only mirrors the prompt. */
  mode: 'remote',
  /** How long the watch may hold a decision before the Web UI takes over. */
  timeoutMs: 45000,
  /** Widest prompt line the watch can draw, in pixels (466-wide panel, 23px margins). */
  maxWidthPx: 420,
  /** Longest prompt body accepted for the watch, in lines. */
  maxLines: 6,
  /** Tools never routed to the watch; they go straight to the Web UI. */
  deniedTools: [],
  /** When non-empty, only these tools are routed to the watch. */
  allowedTools: [],
  /** Play the alert sound on the watch. */
  sound: true,
  /** Vibrate the watch while a decision is pending. */
  vibration: true,
  /** Name advertised in discovery replies. */
  deviceName: 'dsh-stopwatch',
  /** Append NDJSON diagnostics here; empty disables logging. */
  logFile: '',
  /** Announce finished turns on the watch with a green ring. */
  completion: true,
  /** Accept voice recordings from the watch and transcribe them. */
  voice: true,
  /** Language hint passed to the speech service. */
  language: 'zh',
  /**
   * Sentinel file that means "a flashing tool owns the serial port". While it
   * exists the bridge closes its USB transport so `esptool` can upload, then
   * reconnects once the file is gone. `tools/flash.mjs` writes this path.
   */
  releaseFile: DEFAULT_RELEASE_FILE,
})

const MODES = new Set(['remote', 'notify'])
const TRANSPORTS = new Set(['auto', 'listen', 'dial', 'serial'])

/**
 * Merge and validate a Loader row config.
 * @param {unknown} raw - config from `cordis.patch.yml` (may be undefined).
 * @returns {typeof DEFAULT_CONFIG} a frozen, complete config.
 * @throws {Error} when a value is outside its accepted range.
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('stopwatch-bridge: config must be a mapping')
  }

  const cfg = { ...DEFAULT_CONFIG, deniedTools: [], allowedTools: [] }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) {
      throw new Error(`stopwatch-bridge: unknown config field "${key}"`)
    }
    cfg[key] = value
  }

  cfg.port = integer('port', cfg.port, 1, 65535)
  cfg.discoveryPort = integer('discoveryPort', cfg.discoveryPort, 1, 65535)
  if (cfg.port === cfg.discoveryPort) {
    throw new Error('stopwatch-bridge: port and discoveryPort must differ')
  }
  cfg.host = text('host', cfg.host)
  cfg.token = text('token', cfg.token)
  cfg.deviceName = text('deviceName', cfg.deviceName)
  cfg.mode = text('mode', cfg.mode)
  if (!MODES.has(cfg.mode)) {
    throw new Error(`stopwatch-bridge: mode must be one of ${[...MODES].join(', ')}`)
  }
  cfg.transport = text('transport', cfg.transport)
  if (!TRANSPORTS.has(cfg.transport)) {
    throw new Error(`stopwatch-bridge: transport must be one of ${[...TRANSPORTS].join(', ')}`)
  }
  cfg.serialPort = text('serialPort', cfg.serialPort)
  cfg.deviceHost = text('deviceHost', cfg.deviceHost)
  if (cfg.transport === 'dial' && cfg.deviceHost === '') {
    throw new Error('stopwatch-bridge: transport "dial" needs deviceHost')
  }
  cfg.timeoutMs = integer('timeoutMs', cfg.timeoutMs, 5000, 600000)
  cfg.maxWidthPx = integer('maxWidthPx', cfg.maxWidthPx, 120, 460)
  cfg.maxLines = integer('maxLines', cfg.maxLines, 1, 12)
  cfg.deniedTools = stringList('deniedTools', cfg.deniedTools)
  cfg.allowedTools = stringList('allowedTools', cfg.allowedTools)
  cfg.sound = boolean('sound', cfg.sound)
  cfg.vibration = boolean('vibration', cfg.vibration)
  cfg.logFile = text('logFile', cfg.logFile)
  cfg.completion = boolean('completion', cfg.completion)
  cfg.voice = boolean('voice', cfg.voice)
  cfg.language = text('language', cfg.language)
  cfg.releaseFile = text('releaseFile', cfg.releaseFile)
  return Object.freeze(cfg)
}

function integer(key, value, min, max) {
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`stopwatch-bridge: ${key} must be an integer in [${min}, ${max}]`)
  }
  return n
}

function text(key, value) {
  if (typeof value !== 'string') throw new Error(`stopwatch-bridge: ${key} must be a string`)
  return value.trim()
}

function boolean(key, value) {
  if (typeof value !== 'boolean') throw new Error(`stopwatch-bridge: ${key} must be true or false`)
  return value
}

function stringList(key, value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`stopwatch-bridge: ${key} must be a list of tool names`)
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

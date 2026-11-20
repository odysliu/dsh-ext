/**
 * Plugin configuration: defaults plus validation with actionable messages.
 * The bundle is plain JavaScript and deliberately does not import Harness
 * packages, so the row config is normalized here instead of by a Schemastery
 * `Config` export.
 */

export const DEFAULT_CONFIG = Object.freeze({
  /** TCP port the watch connects to. */
  port: 47777,
  /** UDP port the watch broadcasts discovery on. */
  discoveryPort: 47778,
  /** Interface to bind; `0.0.0.0` accepts the watch from the LAN. */
  host: '0.0.0.0',
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
  /** Accept voice recordings from the watch and transcribe them. */
  voice: true,
  /** Language hint passed to the speech service. */
  language: 'zh',
})

const MODES = new Set(['remote', 'notify'])

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
  cfg.timeoutMs = integer('timeoutMs', cfg.timeoutMs, 5000, 600000)
  cfg.maxWidthPx = integer('maxWidthPx', cfg.maxWidthPx, 120, 460)
  cfg.maxLines = integer('maxLines', cfg.maxLines, 1, 12)
  cfg.deniedTools = stringList('deniedTools', cfg.deniedTools)
  cfg.allowedTools = stringList('allowedTools', cfg.allowedTools)
  cfg.sound = boolean('sound', cfg.sound)
  cfg.vibration = boolean('vibration', cfg.vibration)
  cfg.voice = boolean('voice', cfg.voice)
  cfg.language = text('language', cfg.language)
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

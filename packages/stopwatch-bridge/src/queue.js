/**
 * One-at-a-time bridge between pending DSH approvals and the watch screen.
 *
 * The queue owns the promise a request waits on. Every settlement — tap,
 * timeout, abort, disconnect — resolves it exactly once, so the approval
 * answerer can always return a decision or fall back to `next()`.
 */

/** Buttons rendered on the watch; the firmware maps them to these ids. */
export const BUTTONS = Object.freeze([
  Object.freeze({ id: 'deny', label: '拒绝' }),
  Object.freeze({ id: 'allow', label: '同意' }),
  Object.freeze({ id: 'delegate', label: '电脑' }),
])

/** Watch-facing outcome for each internal settlement. */
const CLOSE_OUTCOME = Object.freeze({
  allow: 'allowed-once',
  deny: 'rejected',
  delegate: 'delegated',
  timeout: 'timeout',
  offline: 'offline',
  abort: 'cancelled',
})

/** Short confirmation drawn for 1.5 s after a settlement. */
const CLOSE_TEXT = Object.freeze({
  allow: '已同意',
  deny: '已拒绝',
  delegate: '交给电脑',
  timeout: '超时，转回电脑',
  offline: '设备已断开',
  abort: '已取消',
})

const DECISION_VALUES = new Set(['allow', 'deny', 'delegate'])

export class ApprovalQueue {
  /**
   * @param {{send: (message: object) => boolean, timeoutMs: number, logger?: {warn: Function}, alert?: {sound: boolean, vibration: boolean}}} options - queue wiring.
   */
  constructor({ send, timeoutMs, logger, alert }) {
    this.send = send
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.alert = alert ?? { sound: true, vibration: true }
    /** @type {Array<any>} */
    this.pending = []
    /** @type {any | null} */
    this.active = null
    this.stopped = false
    this.counter = 0
  }

  /**
   * Hold one request until the watch (or a fallback) settles it.
   * @param {{req: object, view: {title: string, lines: string[], tool: string}}} item - request and its rendered view.
   * @returns {Promise<'allow'|'deny'|'delegate'|'timeout'|'offline'|'abort'>} the settlement.
   */
  wait({ req, view }) {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve('offline')
        return
      }
      const entry = {
        id: this.nextId(),
        req,
        view,
        resolve,
        settled: false,
        timer: undefined,
        onAbort: undefined,
      }
      this.pending.push(entry)
      this.pump()
      if (this.active !== null && this.pending.length > 0) {
        this.send({ t: 'queue', pending: this.pending.length })
      }
    })
  }

  /** Show the next prompt when the watch is free. */
  pump() {
    if (this.stopped || this.active !== null) return
    const entry = this.pending.shift()
    if (entry === undefined) return
    this.active = entry
    const total = 1 + this.pending.length
    this.send({
      t: 'prompt',
      id: entry.id,
      seq: 1,
      total,
      tool: entry.view.tool,
      title: entry.view.title,
      lines: entry.view.lines,
      timeoutMs: this.timeoutMs,
      buttons: BUTTONS,
      sound: this.alert.sound !== false,
      vibration: this.alert.vibration !== false,
    })
    entry.timer = setTimeout(() => this.settle(entry, 'timeout'), this.timeoutMs)
    entry.timer.unref?.()
    this.watchAbort(entry)
  }

  /** Re-send the active prompt after a reconnect. */
  refresh() {
    const entry = this.active
    if (entry === null || entry.settled) return
    this.send({
      t: 'prompt',
      id: entry.id,
      seq: 1,
      total: 1 + this.pending.length,
      tool: entry.view.tool,
      title: entry.view.title,
      lines: entry.view.lines,
      timeoutMs: this.timeoutMs,
      buttons: BUTTONS,
      sound: this.alert.sound !== false,
      vibration: this.alert.vibration !== false,
    })
  }

  /**
   * A decision arrived from the device.
   * @param {string} id - prompt id echoed by the device.
   * @param {string} value - `allow`, `deny`, or `delegate`.
   * @returns {boolean} whether the decision matched the active prompt.
   */
  decide(id, value) {
    const entry = this.active
    if (entry === null || entry.id !== id) return false
    if (!DECISION_VALUES.has(value)) return false
    this.settle(entry, /** @type {'allow'|'deny'|'delegate'} */ (value))
    return true
  }

  /**
   * Resolve everything because the device went away.
   * @param {'offline'} outcome - settlement used for every waiting request.
   */
  failAll(outcome = 'offline') {
    const entries = [...this.pending, ...(this.active === null ? [] : [this.active])]
    this.pending = []
    for (const entry of entries) this.settle(entry, outcome)
  }

  /** Release every waiter when the plugin unloads. */
  stop() {
    this.stopped = true
    const entries = [...this.pending, ...(this.active === null ? [] : [this.active])]
    this.pending = []
    for (const entry of entries) {
      entry.settled = true
      clearTimeout(entry.timer)
      this.detachAbort(entry)
      entry.resolve('offline')
    }
    this.active = null
  }

  /**
   * Settle one entry exactly once and let the next prompt through.
   * @param {any} entry - queue entry.
   * @param {string} outcome - settlement name.
   */
  settle(entry, outcome) {
    if (entry.settled) return
    entry.settled = true
    clearTimeout(entry.timer)
    this.detachAbort(entry)

    if (this.active === entry) {
      this.active = null
      this.send({
        t: 'close',
        id: entry.id,
        outcome: CLOSE_OUTCOME[outcome] ?? outcome,
        text: CLOSE_TEXT[outcome] ?? '',
      })
    } else {
      const index = this.pending.indexOf(entry)
      if (index >= 0) this.pending.splice(index, 1)
    }

    entry.resolve(outcome)
    this.pump()
  }

  /** @param {any} entry - queue entry. */
  watchAbort(entry) {
    const signal = entry.req?.signal
    if (!(signal instanceof AbortSignal)) return
    if (signal.aborted) {
      this.settle(entry, 'abort')
      return
    }
    entry.onAbort = () => this.settle(entry, 'abort')
    signal.addEventListener('abort', entry.onAbort, { once: true })
  }

  /** @param {any} entry - queue entry. */
  detachAbort(entry) {
    const signal = entry.req?.signal
    if (entry.onAbort !== undefined && signal instanceof AbortSignal) {
      signal.removeEventListener('abort', entry.onAbort)
    }
    entry.onAbort = undefined
  }

  /** @returns {string} a fresh, log-friendly prompt id. */
  nextId() {
    this.counter += 1
    return `p_${this.counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }
}

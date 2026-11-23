/**
 * Glue between DSH and the watch: the approval answerer, the tool-call preview
 * cache, the device server, the queue, and the discovery beacon.
 */

import { DeviceServer } from './server.js'
import { DeviceConnector } from './connector.js'
import { AutoTransport, SerialConnector } from './serial.js'
import { record } from './diagnostics.js'
import { Discovery } from './discovery.js'
import { ApprovalQueue } from './queue.js'
import { PreviewCache, summarizeToolCall } from './preview.js'
import { buildPromptView } from './view.js'
import { VoiceBridge } from './voice.js'

export class Bridge {
  /**
   * @param {any} ctx - Cordis plugin context.
   * @param {any} config - normalized config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.logger = ctx?.logger
    this.previews = new PreviewCache()
    this.queue = new ApprovalQueue({
      send: (message) => this.server.send(message),
      timeoutMs: config.timeoutMs,
      logger: this.logger,
      alert: { sound: config.sound, vibration: config.vibration },
    })
    this.server = this.createTransport(config)
    this.discovery = new Discovery({
      port: config.discoveryPort,
      tcpPort: config.port,
      name: config.deviceName,
      token: config.token,
      logger: this.logger,
    })
    this.voice = new VoiceBridge({
      ctx,
      send: (message) => this.server.send(message),
      logger: this.logger,
      language: config.language,
    })
    /** @type {Array<() => void>} */
    this.disposers = []
    this.started = false
  }

  /** Register listeners and start both sockets. */
  /**
   * Write one diagnostic record when a log file is configured.
   * @param {string} event - short event name.
   * @param {Record<string, unknown>} [fields] - extra structured fields.
   */
  trace(event, fields = {}) {
    record(this.config.logFile, event, fields)
  }

  /**
   * Tell the watch when a top-level session finished its turn.
   * @param {any} session - session that produced the event.
   * @param {any} event - the session event.
   */
  onSessionEvent(session, event) {
    if (!this.config.completion) return
    if (event?.type !== 'turn/end') return
    if (event.data?.reason?.kind !== 'completed') return
    // subagent turns would flood the watch; only the sessions a human opened
    if (session?.header?.parentSession !== undefined) return
    const title = this.sessionLabel(session)
    this.trace('done', { session: String(session.id), title, device: this.server.device !== null })
    this.server.send({ t: 'done', id: String(session.id), title, at: Date.now() })
  }

  /**
   * Best human-readable name for a session.
   * @param {any} session - live session.
   * @returns {string} the title, a folder name, or a generic label.
   */
  sessionLabel(session) {
    try {
      const titles = this.ctx?.get?.('sessionTitle')
      const snapshot = titles?.get?.(session)
      if (typeof snapshot?.title === 'string' && snapshot.title !== '') return snapshot.title
    } catch {
      /* title service is optional */
    }
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') {
      const parts = cwd.split(/[\\/]/).filter((part) => part !== '')
      if (parts.length > 0) return parts[parts.length - 1]
    }
    return '会话'
  }

  /**
   * Pick the transport described by the config.
   * @param {any} config - resolved config.
   * @returns {any} connector or server exposing listen/send/close plus device events.
   */
  createTransport(config) {
    if (config.transport === 'serial') {
      return new SerialConnector({ port: config.serialPort, token: config.token, logger: this.logger })
    }
    if (config.transport === 'dial') {
      return new DeviceConnector({ host: config.deviceHost, port: config.port, token: config.token, logger: this.logger })
    }
    if (config.transport === 'auto') {
      // the cable works on any network; the network lets the watch leave the desk
      return new AutoTransport(config, this.logger)
    }
    return new DeviceServer({ port: config.port, host: config.host, token: config.token, logger: this.logger })
  }

  start() {
    if (this.started) return
    this.started = true

    this.onDevice = (device) => {
      this.trace(device === null ? 'device-lost' : 'device-connected', {
        id: device?.id ?? '',
        firmware: device?.firmware ?? '',
        battery: device?.battery ?? -1,
      })
      if (device !== null) {
        this.queue.refresh()
        return
      }
      this.queue.failAll('offline')
    }
    this.onMessage = (message) => this.handleDeviceMessage(message)
    this.server.on('device', this.onDevice)
    this.server.on('message', this.onMessage)

    this.server.listen().catch((error) => {
      this.logger?.warn?.(`stopwatch-bridge: cannot listen on tcp/${this.config.port}: ${error.message}`)
    })
    if (this.config.transport === 'listen') this.discovery.start()

    this.disposers.push(
      this.ctx.on('approval/request', (request, next) => this.onApproval(request, next), { prepend: true }),
    )
    this.disposers.push(
      this.ctx.on('tools/pre-execute', (execution, next) => this.onPreExecute(execution, next)),
    )
    this.disposers.push(
      this.ctx.on('session/event', (session, event) => {
        this.voice.trackSession(session, event)
        this.onSessionEvent(session, event)
      }),
    )

    if (this.config.voice) this.voice.warmup()

    this.logger?.info?.(
      `stopwatch-bridge: ${this.config.transport === 'dial' ? `dialing ${this.config.deviceHost}` : `listening on ${this.config.port}`}; ` +
        `${this.config.mode === 'remote' ? 'watch-first' : 'notify-only'} mode, ` +
        `timeout ${Math.round(this.config.timeoutMs / 1000)}s`,
    )
  }

  /** Tear everything down. */
  stop() {
    this.started = false
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
    this.voice.dispose()
    this.queue.stop()
    this.discovery.stop()
    this.server.off?.('device', this.onDevice)
    this.server.off?.('message', this.onMessage)
    this.server.close()
  }

  /**
   * Approval answerer. Claims the request only when the watch is connected and
   * the prompt fits; every other path returns `next()` so the Web UI asks.
   * @param {any} request - approval request.
   * @param {() => Promise<string>} next - the rest of the answerer chain.
   * @returns {Promise<string>} the approval outcome.
   */
  async onApproval(request, next) {
    this.trace('approval', {
      tool: request.toolName,
      callId: String(request.callId ?? ''),
      session: String(request.session?.id ?? ''),
      mode: this.config.mode,
      device: this.server.device !== null,
    })
    if (this.config.mode !== 'remote') {
      this.notifyOnly(request)
      return next()
    }
    if (this.server.device === null) {
      this.trace('approval-skipped', { reason: 'no-device' })
      return next()
    }
    if (!this.toolAllowed(request.toolName)) {
      this.trace('approval-skipped', { reason: 'tool-filtered', tool: request.toolName })
      return next()
    }

    let view
    try {
      const preview = this.previews.take(request.callId)
      view = buildPromptView(request, preview, this.config)
    } catch (error) {
      this.logger?.warn?.(`stopwatch-bridge: cannot render approval: ${error.message}`)
      return next()
    }

    if (view.mode === 'delegate') {
      this.trace('approval-skipped', { reason: 'delegate' })
      this.server.send({
        t: 'notice',
        kind: 'delegate',
        text: '这个确认有点复杂',
        lines: view.lines,
        ttlMs: 4000,
      })
      return next()
    }

    this.trace('approval-shown', { tool: request.toolName })
    const outcome = await this.queue.wait({ req: request, view })
    this.trace('approval-outcome', { outcome })
    if (outcome === 'allow') return 'allowed-once'
    if (outcome === 'deny') return 'rejected'
    if (outcome === 'abort') return 'cancelled'
    if (outcome !== 'delegate') {
      this.logger?.info?.(`stopwatch-bridge: ${outcome}; asking in the Web UI instead`)
    }
    return next()
  }

  /**
   * Notify-only mode: mirror the request on the watch without claiming it.
   * @param {any} request - approval request.
   */
  notifyOnly(request) {
    if (this.server.device === null) return
    if (!this.toolAllowed(request.toolName)) return
    let view
    try {
      view = buildPromptView(request, this.previews.take(request.callId), this.config)
    } catch {
      return
    }
    this.server.send({
      t: 'notice',
      kind: 'pending',
      text: '有确认请求',
      lines: view.lines,
      ttlMs: 6000,
    })
  }

  /**
   * Remember what a tool call actually does, so the prompt can show it.
   * @param {any} execution - tool execution.
   * @param {() => Promise<any>} next - pipeline continuation.
   * @returns {Promise<any>} the next decision.
   */
  onPreExecute(execution, next) {
    try {
      if (typeof execution?.callId === 'string') {
        this.previews.set(execution.callId, summarizeToolCall(execution.name, execution.arguments))
      }
    } catch {
      /* preview is best effort */
    }
    return next()
  }

  /**
   * Handle one frame from the watch.
   * @param {any} message - protocol message.
   */
  handleDeviceMessage(message) {
    if (this.config.voice && this.voice.handle(message)) return
    if (message.t === 'decision') {
      const accepted = this.queue.decide(String(message.id ?? ''), String(message.value ?? ''))
      if (!accepted) {
        this.logger?.warn?.(`stopwatch-bridge: ignored decision for "${String(message.id)}"`)
      }
      return
    }
    if (message.t === 'hello') return
    this.logger?.info?.(`stopwatch-bridge: unhandled device message "${String(message.t)}"`)
  }

  /**
   * Tool routing policy from config.
   * @param {string} toolName - tool identifier.
   * @returns {boolean} whether this tool may be routed to the watch.
   */
  toolAllowed(toolName) {
    if (this.config.deniedTools.includes(toolName)) return false
    if (this.config.allowedTools.length > 0 && !this.config.allowedTools.includes(toolName)) return false
    return true
  }
}

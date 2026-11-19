/**
 * Glue between DSH and the watch: the approval answerer, the tool-call preview
 * cache, the device server, the queue, and the discovery beacon.
 */

import { DeviceServer } from './server.js'
import { Discovery } from './discovery.js'
import { ApprovalQueue } from './queue.js'
import { PreviewCache, summarizeToolCall } from './preview.js'
import { buildPromptView } from './view.js'

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
    this.server = new DeviceServer({
      port: config.port,
      host: config.host,
      token: config.token,
      logger: this.logger,
    })
    this.discovery = new Discovery({
      port: config.discoveryPort,
      tcpPort: config.port,
      name: config.deviceName,
      token: config.token,
      logger: this.logger,
    })
    /** @type {Array<() => void>} */
    this.disposers = []
    this.started = false
  }

  /** Register listeners and start both sockets. */
  start() {
    if (this.started) return
    this.started = true

    this.onDevice = (device) => {
      if (device !== null) return
      this.queue.failAll('offline')
    }
    this.onMessage = (message) => this.handleDeviceMessage(message)
    this.server.on('device', this.onDevice)
    this.server.on('message', this.onMessage)

    this.server.listen().catch((error) => {
      this.logger?.warn?.(`stopwatch-bridge: cannot listen on tcp/${this.config.port}: ${error.message}`)
    })
    this.discovery.start()

    this.disposers.push(
      this.ctx.on('approval/request', (request, next) => this.onApproval(request, next), { prepend: true }),
    )
    this.disposers.push(
      this.ctx.on('tools/pre-execute', (execution, next) => this.onPreExecute(execution, next)),
    )

    this.logger?.info?.(
      `stopwatch-bridge: ${this.config.mode === 'remote' ? 'watch-first' : 'notify-only'} mode, ` +
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
    if (this.config.mode !== 'remote') return next()
    if (this.server.device === null) return next()
    if (!this.toolAllowed(request.toolName)) return next()

    let view
    try {
      const preview = this.previews.take(request.callId)
      view = buildPromptView(request, preview, this.config)
    } catch (error) {
      this.logger?.warn?.(`stopwatch-bridge: cannot render approval: ${error.message}`)
      return next()
    }

    if (view.mode === 'delegate') {
      this.server.send({
        t: 'notice',
        kind: 'delegate',
        text: '这个确认有点复杂',
        lines: view.lines,
        ttlMs: 4000,
      })
      return next()
    }

    const outcome = await this.queue.wait({ req: request, view })
    if (outcome === 'allow') return 'allowed-once'
    if (outcome === 'deny') return 'rejected'
    if (outcome === 'abort') return 'cancelled'
    if (outcome !== 'delegate') {
      this.logger?.info?.(`stopwatch-bridge: ${outcome}; asking in the Web UI instead`)
    }
    return next()
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

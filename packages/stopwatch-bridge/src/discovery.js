/**
 * LAN discovery: the watch broadcasts `{"t":"discover"}`, each host running
 * this plugin answers with its TCP port so the watch never needs a typed IP.
 */

import dgram from 'node:dgram'
import { PROTOCOL_VERSION, parseMessage } from './protocol.js'

export class Discovery {
  /**
   * @param {{port: number, tcpPort: number, name: string, token: string, logger?: any}} options - beacon settings.
   */
  constructor({ port, tcpPort, name, token, logger }) {
    this.port = port
    this.tcpPort = tcpPort
    this.name = name
    this.token = token
    this.logger = logger
    /** @type {dgram.Socket | null} */
    this.socket = null
  }

  /** Start answering discovery broadcasts; failures are logged, never thrown. */
  start() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('message', (buffer, remote) => this.answer(socket, buffer, remote))
    socket.on('error', (error) => {
      this.logger?.warn?.(`stopwatch-bridge: discovery socket error: ${error.message}`)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      this.socket = null
    })
    socket.bind(this.port, '0.0.0.0', () => {
      try {
        socket.setBroadcast(true)
      } catch {
        /* not fatal */
      }
      this.logger?.info?.(`stopwatch-bridge: discovery beacon on udp/${this.port}`)
    })
  }

  /**
   * Reply to one discovery probe.
   * @param {dgram.Socket} socket - bound socket.
   * @param {Buffer} buffer - received datagram.
   * @param {dgram.RemoteInfo} remote - sender address.
   */
  answer(socket, buffer, remote) {
    const parsed = parseMessage(buffer.toString('utf8').trim())
    if (!parsed.ok || parsed.value.t !== 'discover') return
    if (parsed.value.proto !== undefined && parsed.value.proto !== PROTOCOL_VERSION) return
    const reply = JSON.stringify({
      t: 'host',
      proto: PROTOCOL_VERSION,
      name: this.name,
      port: this.tcpPort,
      token: this.token,
    })
    socket.send(reply, remote.port, remote.address, () => {})
  }

  /** Stop answering. */
  stop() {
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    try {
      socket.close()
    } catch {
      /* already closed */
    }
  }
}

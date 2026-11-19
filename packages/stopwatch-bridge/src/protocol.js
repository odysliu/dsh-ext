/**
 * Device wire protocol: one JSON object per line, UTF-8, `\n` terminated.
 * See docs/protocol.md for the message catalogue.
 */

export const PROTOCOL_VERSION = 1

/** Hard ceiling for one encoded line; a longer line drops the connection. */
export const MAX_LINE_BYTES = 8192

/**
 * Encode one protocol message.
 * @param {object} message - message to send.
 * @returns {string} a newline-terminated frame.
 */
export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`
}

/**
 * Parse one received line.
 * @param {string} line - a single frame without its newline.
 * @returns {{ok: true, value: any} | {ok: false, error: string}} the parsed object or a protocol error code.
 */
export function parseMessage(line) {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return { ok: false, error: 'too-long' }
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, error: 'bad-json' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.t !== 'string') {
    return { ok: false, error: 'bad-json' }
  }
  return { ok: true, value }
}

/**
 * Incremental newline splitter for a socket in string mode.
 */
export class LineDecoder {
  /**
   * @param {(line: string) => void} onLine - receives each complete line.
   * @param {(error: string) => void} [onError] - receives framing failures such as `too-long`.
   */
  constructor(onLine, onError = () => {}) {
    this.onLine = onLine
    this.onError = onError
    this.buffer = ''
  }

  /**
   * Feed one decoded chunk.
   * @param {string} chunk - text received from the socket.
   */
  push(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        this.onError('too-long')
        continue
      }
      if (line.trim() !== '') this.onLine(line)
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = ''
      this.onError('too-long')
    }
  }
}

/**
 * Turn a tool call into one short, human-readable line for the watch.
 * Arguments are cached by call id in `tools/pre-execute` and looked up again
 * when the approval for that call arrives.
 */

/** Tool names rendered with a Chinese verb instead of the raw identifier. */
const VERBS = new Map([
  ['bash', '命令'],
  ['pwsh', '命令'],
  ['shell', '命令'],
  ['terminal', '命令'],
  ['write', '写文件'],
  ['edit', '改文件'],
  ['str_replace_editor', '改文件'],
  ['read', '读文件'],
  ['glob', '找文件'],
  ['grep', '搜内容'],
  ['web_fetch', '联网'],
  ['web_search', '联网'],
  ['present', '交付'],
  ['bash_local', '命令'],
  ['bash_sandbox', '命令'],
])

/** Arguments that usually carry the interesting payload, in priority order. */
const DETAIL_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'title', 'name']

/**
 * Summarize one tool call.
 * @param {string} toolName - tool identifier.
 * @param {unknown} args - parsed tool arguments.
 * @returns {string} a single line, possibly empty.
 */
export function summarizeToolCall(toolName, args) {
  const verb = VERBS.get(toolName) ?? toolName
  const detail = firstDetail(args)
  if (detail === '') return verb
  return `${verb} ${detail}`
}

/**
 * Pick the most informative argument value.
 * @param {unknown} args - parsed tool arguments.
 * @returns {string} a flattened, length-limited detail string.
 */
function firstDetail(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    if (typeof args === 'string') return flatten(args, 90)
    return ''
  }
  for (const key of DETAIL_KEYS) {
    const value = /** @type {Record<string, unknown>} */ (args)[key]
    if (typeof value === 'string' && value.trim() !== '') return flatten(value, 90)
  }
  const entry = Object.entries(/** @type {Record<string, unknown>} */ (args))
    .find(([, value]) => typeof value === 'string' && value.trim() !== '')
  return entry ? flatten(entry[1], 60) : ''
}

/**
 * Collapse whitespace and clamp a value.
 * @param {string} value - raw text.
 * @param {number} limit - maximum characters kept.
 * @returns {string} flattened text.
 */
export function flatten(value, limit = 90) {
  const flat = value.replace(/\s+/gu, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1)}…`
}

/**
 * Bounded call-id → summary cache.
 */
export class PreviewCache {
  /** @param {number} [limit] - maximum retained entries. */
  constructor(limit = 200) {
    this.limit = limit
    /** @type {Map<string, string>} */
    this.entries = new Map()
  }

  /**
   * Remember the summary for one call.
   * @param {string | undefined} callId - tool call identity.
   * @param {string} summary - text from {@link summarizeToolCall}.
   */
  set(callId, summary) {
    if (callId === undefined || callId === '') return
    this.entries.set(callId, summary)
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  /**
   * Read and forget the summary for one call.
   * @param {string | undefined} callId - tool call identity.
   * @returns {string} the summary, or an empty string.
   */
  take(callId) {
    if (callId === undefined || callId === '') return ''
    const summary = this.entries.get(callId) ?? ''
    this.entries.delete(callId)
    return summary
  }
}

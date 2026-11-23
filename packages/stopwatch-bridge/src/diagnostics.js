/**
 * Tiny NDJSON diagnostics sink.
 *
 * The plugin talks to a wrist device that is not always attached, so "the watch
 * did not buzz" is ambiguous: the approval may never have reached this plugin,
 * or it may have arrived while no device was paired. A log file answers that.
 */

import { appendFile } from 'node:fs'

/**
 * Append one diagnostic record.
 * @param {string} path - log file, empty disables writing.
 * @param {string} event - short event name.
 * @param {Record<string, unknown>} [fields] - extra structured fields.
 */
export function record(path, event, fields = {}) {
  if (path === '') return
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`
  appendFile(path, line, () => {})
}

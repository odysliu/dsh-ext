/**
 * Build the on-watch view for one approval request: a title, pre-wrapped
 * lines that fit the round 466×466 panel, or a "handled on the computer"
 * decision when the request carries too much text to judge on a wrist.
 */

import { flatten } from './preview.js'

/** Characters drawn at the full 28px cell (CJK, kana, hangul, fullwidth forms). */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u

/** Advance widths of the on-device font, in pixels (keep in sync with firmware/src/text.cpp). */
export const WIDE_PX = 28
export const ASCII_PX = 18
export const NARROW_PX = 14

/** Title shown for a permission question. */
const TITLE = '需要确认'

/** Text shown when the request is handed back to the Web UI. */
const DELEGATE_HINT = '请在电脑上确认'

/** Above this many pixels of text the content is a wall: ask on the computer. */
const MAX_TOTAL_PX = 5600

/** Boilerplate prefix the sandbox tools put in front of their reason. */
const ESCALATION_PREFIX = /^escalate sandbox to ([a-z-]+)\s*:\s*/i

/** Short label per escalation target. */
const ESCALATION_LABEL = new Map([
  ['danger-full-access', '需要完全权限'],
  ['workspace-write', '需要写权限'],
  ['read-only', '需要读取权限'],
])

/**
 * Advance width of one character on the watch.
 * @param {string} char - a single code point.
 * @returns {number} pixels.
 */
export function charWidth(char) {
  if (WIDE.test(char)) return WIDE_PX
  return char.codePointAt(0) < 0x80 ? ASCII_PX : NARROW_PX
}

/**
 * Width of a string on the watch.
 * @param {string} text - any text.
 * @returns {number} pixels.
 */
export function measure(text) {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/**
 * Rewrite the tools' English escalation boilerplate into something a wrist
 * can read, keeping the actual explanation that follows.
 * @param {string} text - raw reason.
 * @returns {string} shortened reason.
 */
export function cleanReason(text) {
  const match = ESCALATION_PREFIX.exec(text)
  if (match === null) return text
  const tail = text.slice(match[0].length).trim()
  const label = ESCALATION_LABEL.get(match[1].toLowerCase()) ?? '需要更高权限'
  return tail === '' ? label : `${label}：${tail}`
}

/**
 * Wrap text into lines of at most `maxCells` cells, preferring spaces.
 * @param {string} text - flattened single-line text.
 * @param {number} maxCells - line budget in half-width cells.
 * @returns {string[]} wrapped lines.
 */
export function wrapLine(text, maxWidthPx) {
  const lines = []
  let line = ''
  let width = 0
  const push = () => {
    if (line.trim() !== '') lines.push(line.trimEnd())
    line = ''
    width = 0
  }
  for (const char of text) {
    if (line === '' && char === ' ') continue
    const advance = charWidth(char)
    if (width + advance > maxWidthPx && line !== '') {
      const cut = lastSpace(line)
      if (cut > 0 && measure(line.slice(0, cut)) >= maxWidthPx / 2) {
        lines.push(line.slice(0, cut).trimEnd())
        line = `${line.slice(cut + 1)}${char}`
        width = measure(line)
        continue
      }
      push()
      if (char === ' ') continue
    }
    line += char
    width += advance
  }
  push()
  return lines
}

/**
 * Index of the last space that is worth breaking at.
 * @param {string} line - current line.
 * @returns {number} index, or -1.
 */
function lastSpace(line) {
  const index = line.lastIndexOf(' ')
  return index <= 0 ? -1 : index
}

/**
 * Choose the human-readable reason of a request.
 * @param {object} req - approval request.
 * @returns {string} localized reason text, or an empty string.
 */
export function reasonOf(req) {
  const display = /** @type {{displayReason?: Record<string, string>}} */ (req).displayReason
  if (display !== null && typeof display === 'object') {
    for (const key of ['zh', 'zh-CN', 'en']) {
      const value = display[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  const reason = /** @type {{reason?: string}} */ (req).reason
  return typeof reason === 'string' ? reason.trim() : ''
}

/**
 * Build the watch view for one request.
 * @param {object} req - approval request (`toolName`, `reason`, `displayReason`).
 * @param {string} preview - one-line tool call summary, or an empty string.
 * @param {{maxWidthPx: number, maxLines: number}} config - layout budget.
 * @returns {{mode: 'prompt' | 'delegate', title: string, tool: string, lines: string[], truncated: boolean}} the view.
 */
export function buildPromptView(req, preview, config) {
  const tool = typeof req.toolName === 'string' ? req.toolName : 'tool'
  const detail = flatten(preview, 200)
  const reason = cleanReason(flatten(reasonOf(req), 400))

  const paragraphs = []
  if (detail !== '') paragraphs.push(detail)
  if (reason !== '' && reason !== detail) paragraphs.push(reason)

  if (paragraphs.length === 0) {
    return { mode: 'delegate', title: TITLE, tool, lines: [DELEGATE_HINT], truncated: false }
  }
  if (measure(paragraphs.join('')) > MAX_TOTAL_PX) {
    return { mode: 'delegate', title: TITLE, tool, lines: [DELEGATE_HINT], truncated: false }
  }

  const lines = []
  let truncated = false
  for (const paragraph of paragraphs) {
    for (const line of wrapLine(paragraph, config.maxWidthPx)) {
      if (lines.length >= config.maxLines) {
        truncated = true
        break
      }
      lines.push(line)
    }
    if (truncated) break
  }

  if (truncated) {
    const last = lines[lines.length - 1] ?? ''
    if (measure(last) + ASCII_PX > config.maxWidthPx) {
      lines[lines.length - 1] = `${clip(last, config.maxWidthPx - ASCII_PX)}…`
    } else {
      lines[lines.length - 1] = `${last}…`
    }
  }
  return { mode: 'prompt', title: TITLE, tool, lines, truncated }
}

/**
 * Keep at most `budgetPx` pixels of a string.
 * @param {string} text - source text.
 * @param {number} budgetPx - width budget in pixels.
 * @returns {string} clipped text.
 */
function clip(text, budgetPx) {
  let used = 0
  let out = ''
  for (const char of text) {
    const advance = charWidth(char)
    if (used + advance > budgetPx) break
    out += char
    used += advance
  }
  return out
}

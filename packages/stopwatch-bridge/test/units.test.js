import test from 'node:test'
import assert from 'node:assert/strict'
import { LineDecoder, encodeMessage, parseMessage } from '../src/protocol.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js'
import { buildPromptView, cleanReason, measure, wrapLine } from '../src/view.js'
import { PreviewCache, summarizeToolCall } from '../src/preview.js'

test('protocol frames one JSON object per line', () => {
  assert.equal(encodeMessage({ t: 'ping' }), '{"t":"ping"}\n')
  assert.deepEqual(parseMessage('{"t":"ping"}'), { ok: true, value: { t: 'ping' } })
  assert.equal(parseMessage('nope').ok, false)
  assert.equal(parseMessage('[1,2]').ok, false)
  assert.equal(parseMessage(JSON.stringify({ t: 'x', padding: 'a'.repeat(9000) })).error, 'too-long')
})

test('line decoder splits chunks and tolerates split multibyte text', () => {
  const lines = []
  const decoder = new LineDecoder((line) => lines.push(line))
  decoder.push('{"t":"a"}\n{"t":')
  decoder.push('"b"}\n')
  assert.deepEqual(lines, ['{"t":"a"}', '{"t":"b"}'])
})

test('config applies defaults and rejects bad values', () => {
  const cfg = normalizeConfig(undefined)
  assert.equal(cfg.port, DEFAULT_CONFIG.port)
  assert.equal(cfg.mode, 'remote')
  assert.equal(normalizeConfig({ timeoutMs: 5000 }).timeoutMs, 5000)
  assert.equal(normalizeConfig(undefined).transport, 'auto')
  assert.match(normalizeConfig(undefined).releaseFile, /\.tools[\\/]flash\.lock$/)
  assert.equal(normalizeConfig({ releaseFile: '/tmp/other.lock' }).releaseFile, '/tmp/other.lock')
  assert.throws(() => normalizeConfig({ transport: 'carrier-pigeon' }), /transport/)
  assert.throws(() => normalizeConfig({ port: 0 }), /port/)
  assert.throws(() => normalizeConfig({ mode: 'auto' }), /mode/)
  assert.throws(() => normalizeConfig({ nope: 1 }), /unknown config field/)
  assert.throws(() => normalizeConfig({ deniedTools: 'bash' }), /deniedTools/)
  assert.deepEqual(normalizeConfig({ deniedTools: ['bash', ' '] }).deniedTools, ['bash'])
})

test('wrapping follows the on-device glyph widths', () => {
  assert.equal(measure('ab'), 36)
  assert.equal(measure('确认'), 56)
  assert.deepEqual(wrapLine('abcdefgh', 72), ['abcd', 'efgh'])
  assert.deepEqual(wrapLine('确认一下这个操作', 56), ['确认', '一下', '这个', '操作'])
  assert.deepEqual(wrapLine('npm run build', 126), ['npm run', 'build'])
})

test('prompt view fits short requests and delegates oversized ones', () => {
  const config = { maxWidthPx: 300, maxLines: 5 }
  const short = buildPromptView({ toolName: 'bash', reason: '需要写入工作区外的文件' }, '命令 npm run build', config)
  assert.equal(short.mode, 'prompt')
  assert.equal(short.lines[0], '命令 npm run')
  assert.equal(short.lines[1], 'build')
  assert.ok(short.lines.every((line) => measure(line) <= 300))

  const long = buildPromptView({ toolName: 'bash', reason: '很长的原因'.repeat(60) }, '', config)
  assert.equal(long.mode, 'delegate')
  assert.deepEqual(long.lines, ['请在电脑上确认'])

  const empty = buildPromptView({ toolName: 'bash' }, '', config)
  assert.equal(empty.mode, 'delegate')
})

test('sandbox boilerplate is rewritten for the wrist', () => {
  assert.equal(
    cleanReason('escalate sandbox to danger-full-access: 写工作区外的文件'),
    '需要完全权限：写工作区外的文件',
  )
  assert.equal(cleanReason('escalate sandbox to workspace-write: npm i'), '需要写权限：npm i')
  assert.equal(cleanReason('普通原因'), '普通原因')
})

test('a real bash escalation still fits on the watch', () => {
  const reason =
    'escalate sandbox to danger-full-access: 端到端验证：故意写工作区外的临时文件以触发 DSH 权限确认，验证手表批准链路。'
  const view = buildPromptView({ toolName: 'bash', reason }, '命令 echo stopwatch-e2e > /Users/odys/x.txt', {
    maxWidthPx: 420,
    maxLines: 6,
  })
  assert.equal(view.mode, 'prompt')
  assert.equal(view.lines[0], '命令 echo stopwatch-e2e')
  assert.ok(view.lines.length <= 6)
})

test('a wall of text is handed back to the computer', () => {
  const reason =
    'escalate sandbox to danger-full-access: plugin_manager {"action":"install_bundle","target":"/Users/odys/x/packages/stopwatch-bridge",' +
    '"justification":"安装刚写好的插件到当前 profile，验证 approval 抢占与设备服务能真实激活。","sandbox_permissions":"danger-full-access"}.' +
    ' Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.'
  const view = buildPromptView({ toolName: 'plugin_manager', reason }, '', { maxWidthPx: 420, maxLines: 6 })
  assert.equal(view.mode, 'delegate')
})

test('content longer than the screen is truncated, not delegated', () => {
  const view = buildPromptView({ toolName: 'bash', reason: '需要确认写入' }, '命令 ' + 'a'.repeat(200), {
    maxWidthPx: 216,
    maxLines: 3,
  })
  assert.equal(view.mode, 'prompt')
  assert.equal(view.truncated, true)
  assert.equal(view.lines.length, 3)
  assert.ok(view.lines[2].endsWith('…'))
})

test('prompt view prefers a localized display reason', () => {
  const view = buildPromptView(
    { toolName: 'bash', reason: 'raw', displayReason: { en: 'Needs approval', zh: '需要确认写入' } },
    '',
    { maxWidthPx: 300, maxLines: 5 },
  )
  assert.deepEqual(view.lines, ['需要确认写入'])
})

test('tool call summaries describe the action', () => {
  assert.equal(summarizeToolCall('bash', { command: 'npm run build' }), '命令 npm run build')
  assert.equal(summarizeToolCall('write', { file_path: '/tmp/a.txt', content: 'x' }), '写文件 /tmp/a.txt')
  assert.equal(summarizeToolCall('mystery', {}), 'mystery')
  assert.match(summarizeToolCall('bash', { command: 'x'.repeat(300) }), /…$/)
})

test('preview cache is bounded and single use', () => {
  const cache = new PreviewCache(2)
  cache.set('a', 'one')
  cache.set('b', 'two')
  cache.set('c', 'three')
  assert.equal(cache.take('a'), '')
  assert.equal(cache.take('c'), 'three')
  assert.equal(cache.take('c'), '')
})

test('voice config is validated like the rest', () => {
  assert.equal(normalizeConfig({}).voice, true)
  assert.equal(normalizeConfig({}).language, 'zh')
  assert.equal(normalizeConfig({ voice: false }).voice, false)
  assert.throws(() => normalizeConfig({ voice: 'yes' }), /voice/)
  assert.throws(() => normalizeConfig({ language: 3 }), /language/)
})

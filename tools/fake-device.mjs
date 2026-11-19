#!/usr/bin/env node
/**
 * Fake M5Stack StopWatch for developing without hardware.
 *
 * It speaks the device protocol from docs/protocol.md: discover the host over
 * UDP (or connect directly), hand shake, answer heartbeats, print prompts, and
 * send a decision. Interactive by default; `--auto` answers by itself.
 *
 *   node tools/fake-device.mjs
 *   node tools/fake-device.mjs --auto allow --delay 800
 *   node tools/fake-device.mjs --host 192.168.1.10 --port 47777
 */

import net from 'node:net'
import dgram from 'node:dgram'
import readline from 'node:readline'
import process from 'node:process'

const args = parseArgs(process.argv.slice(2))
const DISCOVERY_PORT = Number(args.discoveryPort ?? 47778)
const AUTO = args.auto
const DELAY = Number(args.delay ?? 1500)
const TOKEN = String(args.token ?? '')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const answers = []
rl.on('line', (line) => {
  const value = line.trim().toLowerCase()
  if (value === 'y' || value === 'a' || value === '') answers.shift()?.('allow')
  else if (value === 'n' || value === 'd') answers.shift()?.('deny')
  else if (value === 'c') answers.shift()?.('delegate')
})

/**
 * Tiny `--key value` / `--flag` parser.
 * @param {string[]} argv - process arguments.
 * @returns {Record<string, string | boolean>} parsed options.
 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else {
      out[name] = next
      i += 1
    }
  }
  return out
}

/**
 * Ask the user (or the auto mode) for a decision.
 * @param {any} prompt - prompt message.
 * @returns {Promise<string>} decision value.
 */
async function decide(prompt) {
  console.log(`\n┌─ 确认 ${prompt.seq}/${prompt.total} · ${prompt.tool} ─────────────`)
  for (const line of prompt.lines) console.log(`│ ${line}`)
  console.log('└─────────────────────────────')
  if (AUTO !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, DELAY))
    console.log(`   (auto) ${AUTO}`)
    return String(AUTO)
  }
  process.stdout.write('   同意 [y] / 拒绝 [n] / 去电脑 [c] > ')
  return new Promise((resolve) => answers.push(resolve))
}

/**
 * Find a host that answers the discovery broadcast.
 * @returns {Promise<{host: string, port: number, token: string} | null>} discovered host.
 */
async function discover() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.close()
      resolve(null)
    }, 2500)
    socket.on('message', (buffer, remote) => {
      try {
        const reply = JSON.parse(buffer.toString('utf8'))
        if (reply.t !== 'host') return
        clearTimeout(timer)
        socket.close()
        resolve({ host: remote.address, name: reply.name, port: reply.port, token: reply.token ?? '' })
      } catch {
        /* ignore malformed replies */
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      socket.close()
      resolve(null)
    })
    socket.bind(() => {
      socket.setBroadcast(true)
      socket.send(JSON.stringify({ t: 'discover', proto: 1 }), DISCOVERY_PORT, '255.255.255.255')
    })
  })
}

/**
 * Connect and serve one session.
 * @param {string} host - host address.
 * @param {number} port - host TCP port.
 * @param {string} token - pairing token.
 */
function connect(host, port, token) {
  console.log(`→ 连接 ${host}:${port}${args.host === undefined ? ' (发现)' : ''}`)
  const socket = net.connect({ host, port })
  socket.setEncoding('utf8')
  let buffer = ''

  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify({ t: 'hello', proto: 1, id: 'fake-device', name: 'fake-stopwatch', fw: '0.1.0', token, battery: 88 })}\n`,
    )
  })

  socket.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') handle(line)
    }
  })

  socket.on('error', (error) => {
    console.error(`✖ 连接失败: ${error.message}`)
    process.exit(1)
  })

  socket.on('close', () => {
    console.log('← 连接关闭')
    process.exit(0)
  })

  /**
   * Handle one host frame.
   * @param {string} line - one JSON line.
   */
  function handle(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    switch (message.t) {
      case 'welcome':
        console.log('✔ 已配对，等待确认请求')
        break
      case 'ping':
        socket.write(`${JSON.stringify({ t: 'pong', ts: message.ts })}\n`)
        break
      case 'queue':
        console.log(`  (还有 ${message.pending} 个在排队)`)
        break
      case 'notice':
        console.log(`\n[通知] ${message.text} ${(message.lines ?? []).join(' ')}`)
        break
      case 'prompt':
        decide(message).then((value) => {
          socket.write(`${JSON.stringify({ t: 'decision', id: message.id, value, latencyMs: DELAY })}\n`)
        })
        break
      case 'close':
        console.log(`  结果: ${message.outcome} ${message.text ?? ''}`)
        break
      case 'bye':
        console.log(`  主机断开: ${message.reason}`)
        socket.end()
        break
      case 'error':
        console.error(`  协议错误: ${message.code} ${message.message ?? ''}`)
        break
      default:
        console.log(`  ${line}`)
    }
  }
}

const discovered = args.host === undefined ? await discover() : null
const host = String(args.host ?? discovered?.host ?? '')
const port = Number(args.port ?? (discovered?.port ?? 47777))
const token = String(args.token ?? discovered?.token ?? TOKEN)
if (host === '') {
  console.error('没有找到运行插件的电脑。请确认 DSH 已加载 stopwatch-bridge，或用 --host 指定地址。')
  process.exit(1)
}
connect(host, port, token)

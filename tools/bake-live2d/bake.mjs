#!/usr/bin/env node
/**
 * Bake Live2D expressions into PNG stills.
 *
 * Drives headless Chrome over the DevTools protocol: loads bake.html with the
 * model + expression, waits until the page reports a rendered frame, then
 * captures the viewport. No dependencies — Node's fetch and WebSocket.
 *
 *   node tools/bake-live2d/bake.mjs --out /tmp/frames
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const MODEL = '/tools/dsh-pet-live2d-main/dsh-live2d-pet/pets/ds-whale-girl/c_0120.model3.json'
const PAGE = 'http://127.0.0.1:8765/tools/bake-live2d/bake.html'

const args = parseArgs(process.argv.slice(2))
const size = Number(args.size ?? 1024)
const outDir = resolve(args.out ?? join(ROOT, 'tools', '.cache', 'live2d'))
const states = (args.states ?? 'idle|问号|开心兴奋|悲伤').split('|')
const frames = Number(args.frames ?? 1)
const interval = Number(args.interval ?? 250)
const zoom = String(args.zoom ?? '0.92')
const offsetY = String(args.oy ?? '0')

mkdirSync(outDir, { recursive: true })
if (!existsSync(CHROME)) {
  console.error('Chrome not found at', CHROME)
  process.exit(1)
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/dsh-bake-chrome',
    `--window-size=${size},${size}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--disable-lcd-text',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** Wait until the DevTools endpoint answers. */
async function waitForDevtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('Chrome DevTools did not come up')
}

/**
 * Open one tab and return its CDP socket.
 * @param {string} url - page to open.
 * @returns {Promise<{ws: WebSocket, id: string}>} socket and target id.
 */
async function openTab(url) {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  const target = await response.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    ws.addEventListener('open', done, { once: true })
    ws.addEventListener('error', fail, { once: true })
  })
  return { ws, id: target.id }
}

/**
 * Minimal CDP request/response wrapper.
 * @param {WebSocket} ws - open socket.
 * @returns {(method: string, params?: object) => Promise<any>} caller.
 */
function cdp(ws) {
  let next = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve: done, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else done(message.result)
    }
  })
  return (method, params = {}) =>
    new Promise((done, reject) => {
      const id = ++next
      pending.set(id, { resolve: done, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

/**
 * Evaluate an expression in the page.
 * @param {(method: string, params?: object) => Promise<any>} send - CDP caller.
 * @param {string} expression - JS source.
 * @returns {Promise<any>} the value.
 */
async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'page exception')
  return result.result?.value
}

async function bakeState(state) {
  const expr = state === 'idle' ? '' : state
  const url = `${PAGE}?model=${encodeURIComponent(MODEL)}&expr=${encodeURIComponent(expr)}&size=${size}&zoom=${zoom}&oy=${offsetY}`
  const { ws, id } = await openTab(url)
  const send = cdp(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false })
  // without this Chrome composites the page onto white and drops the alpha channel
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })

  let status = ''
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await evaluate(send, 'window.__state + "|" + (window.__error || "")')
    status = String(value ?? '')
    if (status.startsWith('ready')) break
    if (status.startsWith('failed')) break
    await sleep(250)
  }
  if (!status.startsWith('ready')) {
    console.warn(`  ! ${state}: ${status}`)
    ws.close()
    return false
  }

  // One page session yields a short frame strip: the Live2D idle motion keeps
  // running between captures, so the frames differ by breath/blink phase.
  for (let index = 0; index < frames; index += 1) {
    if (index > 0) await sleep(interval)
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      omitBackground: true,
    })
    const name = frames === 1 ? `${state}.png` : `${state}-${index}.png`
    const path = join(outDir, name)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    console.log(`  ✓ ${name}`)
  }
  ws.close()
  await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`)
  return true
}

await waitForDevtools()
let ok = 0
for (const state of states) {
  if (await bakeState(state)) ok += 1
}
chrome.kill()
console.log(`baked ${ok}/${states.length} frames into ${outDir}`)

/**
 * Tiny `--key value` parser.
 * @param {string[]} argv - arguments.
 * @returns {Record<string, string>} options.
 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    out[value.slice(2)] = argv[index + 1]
    index += 1
  }
  return out
}

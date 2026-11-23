#!/usr/bin/env node
/**
 * Compile and flash the StopWatch firmware.
 *
 *   node tools/flash.mjs                       # pick the only connected board
 *   node tools/flash.mjs --port /dev/cu.usbmodem1101
 *   node tools/flash.mjs --port COM5
 *   node tools/flash.mjs --compile-only
 *
 * Uses the checkout-local arduino-cli installed by tools/setup-toolchain.mjs.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = join(ROOT, '.tools')
const SKETCH = join(ROOT, 'firmware', 'stopwatch')
// Sentinel the stopwatch-bridge watches: while it exists the plugin closes its
// USB transport, so esptool gets the port without restarting dsh.
const LOCK = join(TOOLS, 'flash.lock')
// Keep arduino-cli's object cache inside the checkout instead of ~/Library.
const BUILD = join(TOOLS, 'build', 'cache')
const CLI = existsSync(join(TOOLS, 'bin', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'))
  ? join(TOOLS, 'bin', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli')
  : process.platform === 'win32'
    ? 'arduino-cli.exe'
    : 'arduino-cli'

// M5Stack StopWatch: ESP32-S3, 16 MB flash, 8 MB octal PSRAM, 3 MB app slot.
const FQBN =
  'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=huge_app,PSRAM=opi,CDCOnBoot=cdc,CPUFreq=240'

const args = parseArgs(process.argv.slice(2))
const env = {
  ...process.env,
  ARDUINO_DIRECTORIES_DATA: join(TOOLS, 'data'),
  ARDUINO_DIRECTORIES_USER: join(TOOLS, 'user'),
  ARDUINO_DIRECTORIES_DOWNLOADS: join(TOOLS, 'dl'),
}

if (!existsSync(join(SKETCH, 'src', 'secrets.h'))) {
  console.warn('! firmware/stopwatch/src/secrets.h is missing — the watch will boot without WiFi.')
  console.warn('  Run: node tools/configure.mjs --ssid <name> --password <pass>\n')
}

/**
 * Run arduino-cli, streaming its output.
 * @param {string[]} argv - arguments.
 */
function cli(argv) {
  const result = spawnSync(CLI, argv, { stdio: 'inherit', env })
  if (result.error !== undefined) {
    console.error(`flash: cannot run ${CLI}: ${result.error.message}`)
    console.error('Run `node tools/setup-toolchain.mjs` first.')
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/**
 * Ask arduino-cli which serial boards are attached.
 * @returns {string[]} port addresses.
 */
function listPorts() {
  const result = spawnSync(CLI, ['board', 'list', '--format', 'json'], { env, encoding: 'utf8' })
  if (result.status !== 0) return []
  try {
    const parsed = JSON.parse(result.stdout)
    return (parsed.detected_ports ?? [])
      .filter((entry) => entry.port?.address !== undefined && entry.matching_boards?.length > 0)
      .map((entry) => String(entry.port.address))
  } catch {
    return []
  }
}

/**
 * Ask the running bridge to let go of the serial port, and make sure the file
 * disappears however this process ends.
 */
function claimRelease() {
  writeFileSync(LOCK, `flash.mjs pid ${process.pid} at ${new Date().toISOString()}\n`)
  const clean = () => rmSync(LOCK, { force: true })
  process.on('exit', clean)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      clean()
      process.exit(130)
    })
  }
  console.log(`✓ asked the bridge to release the port (${LOCK})`)
}

/**
 * Block until nothing else holds the port, so esptool does not fight the plugin.
 * @param {string} port - serial device path.
 * @param {number} timeoutMs - how long to wait.
 * @returns {boolean} whether the port came free.
 */
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = spawnSync('lsof', ['-t', port], { encoding: 'utf8' })
    if (String(result.stdout ?? '').trim() === '') return true
    spawnSync('sleep', ['0.5'])
  }
  return false
}

claimRelease()

console.log(`compile ${SKETCH}`)
console.log(`  fqbn ${FQBN}`)
cli(['compile', '--build-path', BUILD, '--fqbn', FQBN, '--warnings', 'default', '--output-dir', join(TOOLS, 'build'), SKETCH])
console.log('✓ compiled')

if (args['compile-only'] !== undefined) process.exit(0)

let port = args.port === undefined ? '' : String(args.port)
if (port === '') {
  const ports = listPorts()
  if (ports.length === 0) {
    console.error('flash: no board detected. Plug the StopWatch in with a data-capable USB-C cable,')
    console.error('       then pass --port (node tools/flash.mjs --port /dev/cu.usbmodem1101).')
    process.exit(1)
  }
  port = ports[0]
}

console.log(`upload to ${port}`)
if (!waitForPort(port, 15000)) {
  console.warn(`! ${port} is still held by another process; upload may retry on its own`)
}
cli(['upload', '--fqbn', FQBN, '--port', port, '--input-dir', join(TOOLS, 'build'), SKETCH])
console.log('✓ flashed')

if (args.monitor !== undefined) {
  cli(['monitor', '--fqbn', FQBN, '--port', port, '--config', 'baudrate=115200'])
}

/**
 * Tiny `--key value` / `--flag` parser.
 * @param {string[]} argv - arguments.
 * @returns {Record<string, string>} options.
 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[value.slice(2)] = ''
    } else {
      out[value.slice(2)] = next
      index += 1
    }
  }
  return out
}

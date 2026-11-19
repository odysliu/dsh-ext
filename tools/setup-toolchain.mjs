#!/usr/bin/env node
/**
 * One-shot toolchain bootstrap for the StopWatch firmware.
 *
 * Downloads arduino-cli into .tools/, installs the ESP32 core and the three
 * libraries the sketch needs, and keeps every download inside the checkout so
 * macOS and Windows behave the same and nothing lands in a global prefix.
 *
 *   node tools/setup-toolchain.mjs
 *   node tools/setup-toolchain.mjs --core 3.3.4
 */

import { createWriteStream } from 'node:fs'
import { chmodSync, mkdirSync, existsSync, rmSync, accessSync, constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = join(ROOT, '.tools')
const BIN = join(TOOLS, 'bin')
const CLI = join(BIN, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli')

const ESP32_INDEX = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'
const CLI_VERSION = '1.6.0'
const LIBRARIES = ['M5Unified', 'M5GFX', 'ArduinoJson']

const args = parseArgs(process.argv.slice(2))

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

/**
 * Map this host to an arduino-cli release asset.
 * @returns {{url: string, archive: string}} download description.
 */
function releaseForHost() {
  const base = `https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}`
  const [os, arch] = [process.platform, process.arch]
  if (os === 'darwin' && arch === 'arm64') return { url: `${base}/arduino-cli_${CLI_VERSION}_macOS_ARM64.tar.gz`, archive: 'tar.gz' }
  if (os === 'darwin') return { url: `${base}/arduino-cli_${CLI_VERSION}_macOS_64bit.tar.gz`, archive: 'tar.gz' }
  if (os === 'win32' && arch === 'arm64') return { url: `${base}/arduino-cli_${CLI_VERSION}_Windows_ARM64.zip`, archive: 'zip' }
  if (os === 'win32') return { url: `${base}/arduino-cli_${CLI_VERSION}_Windows_64bit.zip`, archive: 'zip' }
  if (os === 'linux' && arch === 'arm64') return { url: `${base}/arduino-cli_${CLI_VERSION}_Linux_ARM64.tar.gz`, archive: 'tar.gz' }
  if (os === 'linux') return { url: `${base}/arduino-cli_${CLI_VERSION}_Linux_64bit.tar.gz`, archive: 'tar.gz' }
  throw new Error(`unsupported platform ${os}/${arch}`)
}

/**
 * Run a command and inherit stdio so the download progress is visible.
 * @param {string} command - executable.
 * @param {string[]} argv - arguments.
 * @param {Record<string, string>} [env] - extra environment.
 */
function run(command, argv, env = {}) {
  const result = spawnSync(command, argv, {
    stdio: 'inherit',
    env: { ...process.env, ...cliEnv(), ...env },
  })
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed with ${result.status}`)
}

/**
 * Environment that points arduino-cli at the checkout-local directories.
 * @returns {Record<string, string>} environment overrides.
 */
function cliEnv() {
  return {
    ARDUINO_DIRECTORIES_DATA: join(TOOLS, 'data'),
    ARDUINO_DIRECTORIES_USER: join(TOOLS, 'user'),
    ARDUINO_DIRECTORIES_DOWNLOADS: join(TOOLS, 'dl'),
  }
}

/** Download arduino-cli when it is not present yet. */
async function ensureCli() {
  if (existsSync(CLI)) {
    console.log(`✓ arduino-cli already at ${CLI}`)
    return
  }
  const { url } = releaseForHost()
  const archive = join(TOOLS, url.split('/').pop())
  mkdirSync(BIN, { recursive: true })
  mkdirSync(join(TOOLS, 'dl'), { recursive: true })
  console.log(`↓ ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`)
  await pipeline(response.body, createWriteStream(archive))

  console.log('… extracting')
  const result = spawnSync('tar', ['-xf', archive, '-C', BIN], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('could not extract arduino-cli (tar is required)')
  rmSync(archive, { force: true })
  try {
    accessSync(CLI, constants.X_OK)
  } catch {
    chmodSync(CLI, 0o755)
  }
  console.log(`✓ arduino-cli ${CLI_VERSION}`)
}

/** Install the ESP32 core and the sketch libraries. */
function installPackages() {
  run(CLI, ['core', 'update-index', '--additional-urls', ESP32_INDEX])
  const core = args.core ? `esp32:esp32@${args.core}` : 'esp32:esp32'
  run(CLI, ['core', 'install', core, '--additional-urls', ESP32_INDEX])
  run(CLI, ['lib', 'install', ...LIBRARIES])
  run(CLI, ['core', 'list'])
  run(CLI, ['lib', 'list'])
}

await ensureCli()
installPackages()
console.log('\n✓ toolchain ready. Next: node tools/configure.mjs --ssid ... --password ...')

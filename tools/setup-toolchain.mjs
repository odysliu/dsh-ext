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

import { createWriteStream, statSync } from 'node:fs'
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

// M5Unified CI covers arduino-esp32 2.0–3.x; 4.0.0 splits per-chip packages and
// is not covered yet, so pin the newest 3.x unless the caller overrides it.
const DEFAULT_CORE = '3.3.4'
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

/**
 * Pick the archive for this host from a tool's system list.
 * @param {any[]} systems - index entries for one tool version.
 * @returns {any | undefined} the matching system entry.
 */
function pickSystem(systems) {
  const os = process.platform
  const arch = process.arch
  const wanted =
    os === 'darwin'
      ? [arch === 'arm64' ? 'arm64-apple-darwin' : 'x86_64-apple-darwin', 'apple-darwin']
      : os === 'win32'
        ? [arch === 'arm64' ? 'aarch64-mingw32' : 'x86_64-mingw32', 'mingw32']
        : [arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-pc-linux-gnu', 'linux']
  for (const needle of wanted) {
    const hit = systems.find((entry) => entry.host.includes(needle))
    if (hit !== undefined) return hit
  }
  return systems[0]
}

/**
 * Pre-download every archive with curl so a flaky link resumes instead of
 * failing the whole `core install` (arduino-cli itself cannot resume).
 * @returns {Promise<boolean>} whether the cache is complete.
 */
async function prefetchArchives(coreVersion) {
  const curl = spawnSync('curl', ['--version'], { encoding: 'utf8' })
  if (curl.status !== 0) {
    console.log('… curl not available, letting arduino-cli download directly')
    return false
  }

  console.log(`… reading ${ESP32_INDEX}`)
  const index = await fetchJson(ESP32_INDEX)
  const pkg = index.packages.find((entry) => entry.name === 'esp32')
  const platform = pkg?.platforms.find((entry) => entry.version === coreVersion)
  if (platform === undefined) {
    console.log(`… esp32 ${coreVersion} not in the index yet, skipping prefetch`)
    return false
  }

  const targets = [{ url: platform.url, file: platform.archiveFileName, size: platform.size }]
  for (const dep of platform.toolsDependencies) {
    const tool = pkg.tools.find((entry) => entry.name === dep.name && entry.version === dep.version)
    if (tool === undefined) continue
    const system = pickSystem(tool.systems)
    if (system === undefined) continue
    targets.push({ url: system.url, file: system.archiveFileName, size: system.size })
  }

  const dir = join(TOOLS, 'dl', 'packages')
  mkdirSync(dir, { recursive: true })
  let ok = true
  for (const target of targets) {
    const path = join(dir, target.file)
    if (existsSync(path) && statSize(path) === target.size) {
      console.log(`✓ cached ${target.file}`)
      continue
    }
    console.log(`↓ ${target.file} (${(target.size / 1e6).toFixed(0)} MB, resumable)`)
    const result = spawnSync(
      'curl',
      ['-fL', '--retry', '20', '--retry-delay', '5', '--retry-all-errors', '-C', '-', '-o', path, target.url],
      { stdio: 'inherit' },
    )
    if (result.status !== 0 || statSize(path) !== target.size) {
      console.log(`! ${target.file} still incomplete — re-run the setup to resume`)
      ok = false
    }
  }
  return ok
}

/**
 * @param {string} path - file to measure.
 * @returns {number} size in bytes, or -1.
 */
function statSize(path) {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/**
 * Fetch and parse a JSON document with retries.
 * @param {string} url - document URL.
 * @returns {Promise<any>} parsed body.
 */
async function fetchJson(url) {
  let last
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      last = error
      console.log(`… index fetch failed (${error.message}), retry ${attempt}/5`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
  throw last
}

/** Install the ESP32 core and the sketch libraries. */
async function installPackages() {
  const coreVersion = args.core ?? DEFAULT_CORE
  run(CLI, ['core', 'update-index', '--additional-urls', ESP32_INDEX])
  await prefetchArchives(coreVersion)
  run(CLI, ['core', 'install', `esp32:esp32@${coreVersion}`, '--additional-urls', ESP32_INDEX])
  for (const library of LIBRARIES) {
    const result = spawnSync(CLI, ['lib', 'install', library], { stdio: 'inherit', env: { ...process.env, ...cliEnv() } })
    if (result.status !== 0) {
      console.log(`! ${library} failed via the library index, retrying with git`)
      run(CLI, ['lib', 'install', '--git-url', `https://github.com/${gitPath(library)}.git`])
    }
  }
  run(CLI, ['core', 'list'])
  run(CLI, ['lib', 'list'])
}

/**
 * Repository that hosts one of the sketch libraries.
 * @param {string} library - library name.
 * @returns {string} `owner/name`.
 */
function gitPath(library) {
  if (library === 'M5Unified') return 'm5stack/M5Unified'
  if (library === 'M5GFX') return 'm5stack/M5GFX'
  return 'bblanchon/ArduinoJson'
}

await ensureCli()
await installPackages()
console.log('\n✓ toolchain ready. Next: node tools/configure.mjs --ssid ... --password ...')

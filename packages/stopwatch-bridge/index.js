/**
 * Host half of the stopwatch-bridge bundle.
 *
 * The plugin claims `approval/request` before the Web UI answerer (prepend),
 * pushes the pending decision to a paired M5Stack StopWatch, and turns the
 * watch tap into `allowed-once` / `rejected`. Every path that cannot be
 * answered on the watch falls back to `next()` so the session never stalls.
 */

import { Bridge } from './src/bridge.js'
import { normalizeConfig } from './src/config.js'

export const name = 'stopwatch-bridge'

/**
 * Activate the bridge for this profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - the Loader row's config.
 */
export function apply(ctx, config) {
  ctx.effect(() => {
    const options = normalizeConfig(config)
    const bridge = new Bridge(ctx, options)
    bridge.start()
    return () => bridge.stop()
  })
}

import {isBotRelevantUpdate} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import {describeUpdate} from '@telegram/update-log.js'
import type {Middleware} from 'grammy'
import type {Update} from 'grammy/types'
import {getRuntime} from '../../runtime.js'

/**
 * Per-update logging: binds the update's identity onto `ctx.log` and writes exactly one
 * outcome line for each update this bot actually handles.
 *
 * `POST /bot` on its own says nothing — the HTTP layer keeps that at debug and this middleware
 * is the record of what the request *was* (which action, which user, how long, did it fail).
 * Updates the bot ignores (group chatter, other bots' commands) never reach info level.
 */
export const logger: Middleware<BotContext & {update: Update & {reqId: string}}> = async (
  ctx,
  next,
) => {
  ctx.log = getRuntime().log.child({reqId: ctx.update.reqId, ...describeUpdate(ctx)})

  if (!isBotRelevantUpdate(ctx)) {
    ctx.log.debug('Update ignored')
    return next()
  }

  const startedAt = Date.now()
  let failed = false
  try {
    return await next()
  } catch (error) {
    // Details are logged by the error boundary; this line only records the outcome + timing.
    failed = true
    throw error
  } finally {
    const ms = Date.now() - startedAt
    if (failed) ctx.log.warn({ms}, 'Update failed')
    else ctx.log.info({ms}, 'Update handled')
  }
}

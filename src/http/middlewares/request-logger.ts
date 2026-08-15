import type {AppLogger} from '@infra/logger.js'
import {Elysia} from 'elysia'

type LoggerWithChild = AppLogger & {
  child: (bindings: Record<string, unknown>) => AppLogger
}

/**
 * Request correlation for the HTTP edge: every request gets a `reqId` and a child logger, and the
 * Telegram router copies that id onto the update body so the bot's per-update log line shares it.
 *
 * The transport line itself stays at debug on purpose. `POST /bot - 4ms` repeated for every
 * Telegram update carries no information; what happened is logged by the update logger
 * (`src/telegram/middlewares/logger.ts`) and by the webhook handlers themselves.
 */
/** Elysia codes that mean "the caller sent something we cannot accept". */
const CLIENT_ERROR_CODES = new Set(['PARSE', 'VALIDATION', 'INVALID_COOKIE_SIGNATURE'])

export function createRequestLogger(log: LoggerWithChild) {
  return new Elysia({name: 'request-logger'})
    .derive({as: 'global'}, () => {
      const reqId = Math.random().toString(36).substring(2, 10)
      return {
        reqId,
        log: log.child({reqId}),
        startedAt: Date.now(),
      }
    })
    .onAfterHandle({as: 'global'}, ({request, log: reqLog, startedAt}) => {
      const path = new URL(request.url).pathname
      reqLog.debug({method: request.method, path, ms: Date.now() - startedAt}, 'HTTP request')
    })
    .onError({as: 'global'}, ({code, error, log: reqLog}) => {
      // Unrouted probes and scanner traffic are not our failures — keep them out of error level.
      if (String(code) === 'NOT_FOUND' || !reqLog) return
      // Malformed bodies are the caller's bug: worth seeing, not worth paging on.
      if (CLIENT_ERROR_CODES.has(String(code))) {
        reqLog.warn({error, code}, 'HTTP request rejected')
        return
      }
      reqLog.error({error, code}, 'HTTP request failed')
    })
}

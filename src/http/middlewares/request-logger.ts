import type {AppLogger} from '@infra/logger.js'
import {Elysia} from 'elysia'

type LoggerWithChild = AppLogger & {
  child: (bindings: Record<string, unknown>) => AppLogger
}

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
      reqLog.info(`${request.method} ${path} - ${Date.now() - startedAt}ms`)
    })
    .onError({as: 'global'}, ({code, error, log: reqLog}) => {
      if (code === 'NOT_FOUND' || !reqLog) return
      reqLog.error({error}, 'request error')
    })
}

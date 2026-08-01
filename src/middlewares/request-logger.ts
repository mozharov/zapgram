import {Elysia} from 'elysia'
import {logger} from '../lib/logger.js'

export const requestLogger = new Elysia({name: 'request-logger'})
  .derive({as: 'global'}, () => {
    const reqId = Math.random().toString(36).substring(2, 10)
    return {
      reqId,
      log: logger.child({reqId}),
      startedAt: Date.now(),
    }
  })
  .onAfterHandle({as: 'global'}, ({request, log, startedAt}) => {
    const path = new URL(request.url).pathname
    log.info(`${request.method} ${path} - ${Date.now() - startedAt}ms`)
  })
  .onError({as: 'global'}, ({code, error, log}) => {
    if (code === 'NOT_FOUND' || !log) return
    log.error({error}, 'request error')
  })

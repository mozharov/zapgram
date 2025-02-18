import {logger} from '../lib/logger.js'
import type {Middleware} from 'koa'

export const requestLogger: Middleware = async (ctx, next) => {
  ctx.log = logger.child({reqId: ctx.req.id})

  const startRequestTime = Date.now()
  await next().catch((error: unknown) => {
    ctx.log.error({error}, 'request error')
    throw error
  })
  const responseTime = Date.now() - startRequestTime
  ctx.log.info(`${ctx.method} ${ctx.url} - ${responseTime}ms`)
}

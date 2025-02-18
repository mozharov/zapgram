import type {Middleware} from 'grammy'
import type {Update} from 'grammy/types'
import type {BotContext} from '../context.js'
import {logger as appLogger} from '../../lib/logger.js'

export const logger: Middleware<BotContext & {update: Update & {reqId: string}}> = (ctx, next) => {
  ctx.log = appLogger.child({reqId: ctx.update.reqId})
  return next()
}
